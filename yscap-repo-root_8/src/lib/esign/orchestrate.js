/**
 * esign/orchestrate.js — the send orchestration layer.
 *
 * Turns a staff "send for signature" action into a fully-formed DocuSign envelope
 * and drives it through the send-EXACTLY-once engine (send.js). Everything the
 * envelope needs is assembled HERE so send.js stays a generic durable queue:
 *
 *   1. Re-check the appraisal send-gate SERVER-SIDE (never trust the client).
 *   2. Create/claim the one in-flight esign_envelopes row for (application,purpose)
 *      — the partial unique index uq_esign_inflight is the DB backstop.
 *   3. Bind each package document to the condition it clears (esign_envelope_docs).
 *   4. Seed one esign_recipients row per signer (borrower (+ co-borrower) at
 *      routingOrder 1; the admin counter-signer at routingOrder 2 for the
 *      term-sheet package) so the cockpit shows the roster immediately.
 *   5. buildDefinition() (the send.js callback) assembles the document bytes +
 *      anchored signer tabs + custom fields + per-envelope Connect + reminders.
 *
 * Document sourcing (docs/DOCUSIGN-DOCUMENT-BUILD-SPEC §4/§A.2): the package PDFs
 * are the LATEST current stored `documents` rows for each doc_kind (the term
 * sheet is browser-jsPDF; the application export + business-purpose disclosure +
 * Heter Iska come from their own generators / DocuSign DocGen templates). We read
 * the bytes we have on file — if a required document is missing, the send fails
 * loudly (non-retryable) telling staff exactly which document to produce first.
 *
 * Dependency-injected (db / docusign / storage / send) so the whole flow is
 * unit-testable without a live DocuSign account or real PDF bytes.
 */
const dbDefault = require('../../db');
const docusignDefault = require('../integrations/docusign');
const storageDefault = require('../storage');
const sendEngine = require('./send');
const gate = require('./gate');
const docgen = require('./docgen');
const onDeadLetter = require('./dead-letter');
const { parseAddress } = require('../address');
const cfg = require('../../config');

// ---- package definitions ----------------------------------------------------
// Each package is an ORDERED list of documents (order fixes the numeric
// documentId 1..N and the anchor scoping) + the condition each signed copy
// clears + whether the admin counter-signature is required.
const PACKAGES = {
  term_sheet_package: {
    label: 'Term-sheet package',
    countersignRequired: true,
    subject: (loan) => `Your loan documents are ready to sign${loan ? ` — Loan #${loan}` : ''}`,
    blurb: 'Please review and sign your term sheet, application, and business-purpose disclosure.',
    // doc_kind (unsigned source) -> anchor prefix + signed doc_kind + condition it clears.
    // `generate:true` docs are BUILT on our server from a stored Word template
    // (docgen.js) at send time — no paid DocuSign DocGen add-on, no pre-stored PDF.
    docs: [
      { kind: 'term_sheet',         prefix: 'ts',  signedKind: 'term_sheet_signed',    condition: 'rtl_cond_signedts',  name: 'Term Sheet', freshnessCheck: true },
      { kind: 'application_export', prefix: 'app', signedKind: 'application_signed',    condition: 'rtl_cond_signed_app', name: 'Loan Application' },
      { kind: 'bp_disclosure',      prefix: 'bpd', signedKind: 'bp_disclosure_signed',  condition: 'rtl_cond_signed_app', name: 'Business-Purpose Disclosure', generate: true },
    ],
  },
  heter_iska: {
    label: 'Heter Iska',
    countersignRequired: false,
    subject: (loan) => `Heter Iska ready to sign${loan ? ` — Loan #${loan}` : ''}`,
    blurb: 'Please review and sign the Heter Iska.',
    docs: [
      { kind: 'heter_iska', prefix: 'iska', signedKind: 'heter_iska_signed', condition: 'rtl_cond_iska', name: 'Heter Iska', generate: true },
    ],
  },
};

function packageSpec(purpose) {
  const spec = PACKAGES[purpose];
  if (!spec) { const e = new Error(`Unknown e-sign package "${purpose}"`); e.retryable = false; throw e; }
  return spec;
}

// ---- data loads -------------------------------------------------------------
async function loadApplication(db, applicationId) {
  const r = await db.query(
    `SELECT a.id, a.ys_loan_number,
            b.id AS b_id, b.first_name AS b_first, b.last_name AS b_last, b.email AS b_email,
            cb.id AS cb_id, cb.first_name AS cb_first, cb.last_name AS cb_last, cb.email AS cb_email,
            a.co_borrower_id
       FROM applications a
       JOIN borrowers b  ON b.id  = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [applicationId]);
  if (!r.rows.length) { const e = new Error('Application not found'); e.retryable = false; throw e; }
  return r.rows[0];
}

/** Resolve the checklist_item id for a template code on this application (or null). */
async function resolveConditionItem(db, applicationId, code) {
  const r = await db.query(
    `SELECT ci.id FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id = $1 AND t.code = $2
      ORDER BY ci.created_at DESC LIMIT 1`, [applicationId, code]);
  return r.rows.length ? r.rows[0].id : null;
}

/**
 * Load the field values docgen.js needs to fill the business-purpose disclosure
 * and Heter Iska from the loan file: loan number, application date, loan amount,
 * subject-property parts (flattened out of the property_address jsonb), and the
 * borrower (+ co-borrower) names. Everything comes straight from the file record —
 * no free-typing, so the generated documents always agree with the file.
 */
async function loadDocGenData(db, applicationId) {
  const r = await db.query(
    `SELECT a.ys_loan_number,
            COALESCE(a.submitted_at, a.created_at)              AS application_date,
            a.loan_amount, a.purchase_price,
            a.property_address->>'line1'  AS addr_line1,
            a.property_address->>'street' AS addr_street,
            a.property_address->>'unit'   AS addr_unit,
            a.property_address->>'city'   AS addr_city,
            a.property_address->>'state'  AS addr_state,
            a.property_address->>'zip'    AS addr_zip,
            a.property_address->>'oneLine'           AS addr_oneline,
            a.property_address->>'formatted_address' AS addr_formatted,
            CASE WHEN jsonb_typeof(a.property_address) = 'string'
                 THEN a.property_address #>> '{}' END        AS addr_scalar,
            b.first_name AS b_first, b.last_name AS b_last,
            cb.first_name AS cb_first, cb.last_name AS cb_last,
            a.co_borrower_id
       FROM applications a
       JOIN borrowers b  ON b.id  = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [applicationId]);
  if (!r.rows.length) { const e = new Error('Application not found for document generation'); e.retryable = false; throw e; }
  const a = r.rows[0];

  // Subject property — the disclosure needs street/city/state/zip SEPARATELY. Many
  // files (ClickUp-synced especially) store only a `oneLine`/`formatted_address`
  // string and no structured keys, which would render the whole property block
  // blank on a legal disclosure. Prefer the structured keys; when they're missing,
  // parse the one-line form into parts so the property is never blank.
  let street = [a.addr_line1 || a.addr_street, a.addr_unit].filter(Boolean).join(' ').trim();
  let city = a.addr_city || '', state = a.addr_state || '', zip = a.addr_zip || '';
  // Fill ANY missing part from the one-line form (structured values always win).
  // Covers a fully-unstructured file (ClickUp oneLine-only) AND a partially
  // structured one (e.g. city present but no street line) — the disclosure's
  // property block must never be blank in a field we can derive.
  // addr_scalar covers a property_address stored as a bare JSON string (not an
  // object) — every ->>'key' returns null for it, so without this the whole block
  // would render blank on the disclosure.
  const oneLine = a.addr_oneline || a.addr_formatted || a.addr_scalar || '';
  if (oneLine && (!street || !city || !state || !zip)) {
    const p = parseAddress(oneLine);
    if (!street) street = [p.line1, p.unit].filter(Boolean).join(' ').trim() || oneLine;
    if (!city) city = p.city || '';
    if (!state) state = p.state || '';
    if (!zip) zip = p.zip || '';
  }
  return {
    loanNumber: a.ys_loan_number || '',
    applicationDate: a.application_date,
    executionDate: new Date(),                          // "as of the date below" — prepared today
    // The LOAN amount only — never fall back to purchase_price (a different figure):
    // the disclosure certifies "applied for a loan in the amount of $X" and the Iska
    // states the principal, so a missing loan amount must BLOCK the send
    // (validateGenerated), not silently print the acquisition price on a legal doc.
    loanAmount: a.loan_amount,
    propStreet: street,
    propCity: city,
    propState: state,
    propZip: zip,
    bFirst: a.b_first || '', bLast: a.b_last || '',
    hasCoBorrower: !!a.co_borrower_id,
    cbFirst: a.cb_first || '', cbLast: a.cb_last || '',
  };
}

/**
 * Guard the generated-document data BEFORE a legal document is assembled: a real
 * send must never render a blank loan number / property, a $0.00 amount, or a
 * nameless signer. Throws non-retryable (a human must complete the file) — checked
 * only against the fields the package's GENERATED docs actually print.
 */
function validateGenerated(spec, data) {
  const genKinds = spec.docs.filter((d) => d.generate).map((d) => d.kind);
  if (!genKinds.length) return;
  const missing = [];
  // Both generated docs (disclosure + Heter Iska) print the loan amount + borrower name.
  if (data.loanAmount == null || !isFinite(Number(data.loanAmount)) || Number(data.loanAmount) <= 0) missing.push('loan amount');
  if (!`${data.bFirst || ''} ${data.bLast || ''}`.trim()) missing.push('borrower name');
  if (data.hasCoBorrower && !`${data.cbFirst || ''} ${data.cbLast || ''}`.trim()) missing.push('co-borrower name');
  // The disclosure additionally prints the loan number + the subject property.
  if (genKinds.includes('bp_disclosure')) {
    if (!data.loanNumber) missing.push('loan number');
    if (!(data.propStreet || data.propCity || data.propState || data.propZip)) missing.push('property address');
  }
  if (missing.length) {
    const e = new Error(`Cannot prepare the signing documents — the file is missing: ${missing.join(', ')}. Complete the file, then send.`);
    e.retryable = false;
    throw e;
  }
}

/** The latest current, non-rejected stored PDF for a doc_kind on this application. */
async function latestDocument(db, applicationId, docKind) {
  const r = await db.query(
    `SELECT id, filename, content_type, storage_ref, storage_provider, created_at
       FROM documents
      WHERE application_id = $1 AND doc_kind = $2
        AND COALESCE(review_status,'') <> 'rejected'
      ORDER BY is_current DESC NULLS LAST, created_at DESC
      LIMIT 1`, [applicationId, docKind]);
  return r.rows.length ? r.rows[0] : null;
}

// ---- recipient roster -------------------------------------------------------
// Deterministic clientUserId per recipient so the embedded (in-portal) signing
// view can be re-minted with a matching value. Never a secret — it's just a
// stable per-envelope-per-recipient handle.
const clientUserIdFor = (envelopeRowId, role) => `${envelopeRowId}:${role}`;

/**
 * The signer roster for a package: borrower (+ co-borrower when present) at
 * routingOrder 1, then the admin counter-signer at routingOrder 2 for the
 * term-sheet package. recipientId is the DocuSign per-envelope id ("1","2","3").
 */
function buildRoster(app, spec, envelopeRowId) {
  const roster = [];
  roster.push({
    role: 'borrower', routingOrder: 1, recipientId: '1', isCountersigner: false,
    borrowerId: app.b_id, name: `${app.b_first} ${app.b_last}`.trim(), email: app.b_email,
    clientUserId: clientUserIdFor(envelopeRowId, 'borrower'),
  });
  if (app.co_borrower_id) {
    roster.push({
      role: 'co_borrower', routingOrder: 1, recipientId: '2', isCountersigner: false,
      borrowerId: app.cb_id, name: `${app.cb_first} ${app.cb_last}`.trim(), email: app.cb_email,
      clientUserId: clientUserIdFor(envelopeRowId, 'co_borrower'),
    });
  }
  if (spec.countersignRequired) {
    roster.push({
      role: 'admin', routingOrder: 2, recipientId: String(roster.length + 1), isCountersigner: true,
      borrowerId: null, name: cfg.docusign.countersignName, email: cfg.docusign.countersignEmail,
      clientUserId: clientUserIdFor(envelopeRowId, 'admin'),
    });
  }
  return roster;
}

// Anchor tabs for a recipient over the package documents. Borrower/co-borrower
// sign every document (role suffix b1/b2); the admin counter-signer signs the
// TERM SHEET ONLY (/ts_admin_sig/). documentIdByKind maps a doc_kind to the
// numeric documentId assigned at assembly time.
function tabsFor(role, spec, documentIdByKind) {
  const suffix = role === 'borrower' ? 'b1' : role === 'co_borrower' ? 'b2' : 'admin';
  const tabsByDoc = {};
  for (const d of spec.docs) {
    const documentId = documentIdByKind[d.kind];
    if (!documentId) continue;   // that document isn't in this envelope
    if (role === 'admin' && d.prefix !== 'ts') continue;   // admin counter-signs the term sheet only
    tabsByDoc[documentId] = {
      sign: [`/${d.prefix}_${suffix}_sig/`],
      date: [`/${d.prefix}_${suffix}_dt/`],
    };
  }
  return tabsByDoc;
}

// ---- envelope row lifecycle -------------------------------------------------
/**
 * Create (or return the existing) in-flight envelope row for (application,purpose),
 * seed its document→condition map and its recipient roster. Idempotent: a second
 * call while a row is in flight returns the SAME row (the partial unique index is
 * the backstop). Returns { row, created }.
 */
async function createOrClaimEnvelope(db, app, purpose, spec, actorId, opts = {}) {
  const inflightSql =
    `SELECT * FROM esign_envelopes
      WHERE application_id = $1 AND purpose = $2 AND status IN ('not_sent','sent','delivered')
      ORDER BY created_at DESC LIMIT 1`;
  const existing = await db.query(inflightSql, [app.id, purpose]);
  if (existing.rows.length) return { row: existing.rows[0], created: false };

  // No in-flight envelope. If a PRIOR envelope for this (file, purpose) exists in a
  // TERMINAL state (completed / declined / voided / error), a PLAIN send must NOT
  // silently mint a duplicate — that was the "click Send again and again → a pile of
  // envelopes" bug (a dead-lettered send isn't in-flight, so every re-click minted a
  // fresh row). Return the terminal row so the caller can steer the user to the
  // explicit Re-issue action. A deliberate re-issue (opts.reissue) DOES mint a fresh
  // envelope (new product_version → new idempotency key).
  if (!opts.reissue) {
    const prior = await db.query(
      `SELECT * FROM esign_envelopes WHERE application_id = $1 AND purpose = $2
        ORDER BY created_at DESC LIMIT 1`, [app.id, purpose]);
    if (prior.rows.length) return { row: prior.rows[0], created: false, terminal: true };
  }

  // product_version = a per-issue sequence (count of prior envelopes for this
  // app+purpose). It feeds the deterministic idempotency key so a legitimate
  // RE-ISSUE (after a prior envelope voided/completed and freed uq_esign_inflight)
  // gets a DISTINCT key — otherwise DocuSign would replay the original envelope
  // within its idempotency-key TTL and the re-issue would dead-letter (M2).
  const seq = (await db.query(
    `SELECT count(*)::int AS n FROM esign_envelopes WHERE application_id=$1 AND purpose=$2`,
    [app.id, purpose])).rows[0].n;

  let row;
  try {
    const ins = await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required, created_by, product_version)
       VALUES ($1, $2, 'not_sent', $3, $4, $5)
       RETURNING *`, [app.id, purpose, spec.countersignRequired, actorId || null, seq]);
    row = ins.rows[0];
  } catch (e) {
    // Lost a concurrent create race (double-click) — the partial unique index
    // uq_esign_inflight rejected the second INSERT. Return the winner's row so
    // the caller is idempotent instead of 500ing (M1).
    if (e && e.code === '23505') {
      const again = await db.query(inflightSql, [app.id, purpose]);
      if (again.rows.length) return { row: again.rows[0], created: false };
    }
    throw e;
  }

  // Bind each package document to the condition it clears (documentId 1..N in
  // package order). The webhook uses THIS map on completion — no name-matching.
  for (let i = 0; i < spec.docs.length; i++) {
    const d = spec.docs[i];
    const conditionItemId = await resolveConditionItem(db, app.id, d.condition);
    await db.query(
      `INSERT INTO esign_envelope_docs (envelope_row_id, document_id, doc_kind, checklist_item_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (envelope_row_id, document_id) DO NOTHING`,
      [row.id, i + 1, d.signedKind, conditionItemId]);
  }

  // Seed the recipient roster (all embedded + email hybrid).
  const roster = buildRoster(app, spec, row.id);
  for (const r of roster) {
    await db.query(
      `INSERT INTO esign_recipients
         (envelope_row_id, role, routing_order, is_countersigner, recipient_id_ds,
          borrower_id, name, email, embedded, client_user_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,'created')`,
      [row.id, r.role, r.routingOrder, r.isCountersigner, r.recipientId,
       r.borrowerId, r.name, r.email, r.clientUserId]);
  }
  return { row, created: true };
}

// ---- the send.js buildDefinition callback -----------------------------------
/**
 * Assemble the envelope-definition inputs for one esign_envelopes row: read the
 * package document bytes, attach anchored signer tabs from the seeded recipient
 * roster, add correlation custom fields, per-envelope Connect, and reminders.
 * Throws non-retryable if a required document is missing (staff must generate it).
 */
async function buildDefinition(row, { db = dbDefault, storage = storageDefault } = {}) {
  const spec = packageSpec(row.purpose);
  const app = await loadApplication(db, row.application_id);

  // Assemble the documents in package order → numeric documentId 1..N.
  const documents = [];
  const documentIdByKind = {};
  const missing = [];
  // Load the generated-document field values ONCE up front (if this package has any
  // generated doc) and VALIDATE before assembling — a missing loan number, amount,
  // property, or signer name must fail with a clear reason, never render blank/$0.00
  // on a legal document.
  const hasGenerated = spec.docs.some((d) => d.generate);
  const docGenData = hasGenerated ? await loadDocGenData(db, row.application_id) : null;
  if (hasGenerated) validateGenerated(spec, docGenData);
  // The TERM SHEET must have been produced AT/AFTER the appraisal came back —
  // otherwise it can carry a pre-appraisal loan figure while the disclosure
  // regenerates on the CURRENT (post-appraisal) amount, and the borrower gets one
  // binding envelope showing two different loan amounts. Same "refresh on the
  // appraised value" contract the gate enforces for P&P, and staff re-save the term
  // sheet from the Term Sheet Studio. ONLY the term sheet is freshness-checked
  // (`freshnessCheck`): the application_export is a borrower-submitted document with
  // NO post-appraisal regeneration flow, so checking it would false-block every send.
  const needsFreshness = spec.docs.some((d) => d.freshnessCheck);
  const apprBackAt = needsFreshness ? await gate.appraisalBackAt(row.application_id, { db }) : null;
  for (let i = 0; i < spec.docs.length; i++) {
    const d = spec.docs[i];
    const documentId = i + 1;

    if (d.generate) {
      // Built on our server from the stored Word template + this file's data.
      // DocuSign converts the .docx → PDF for free, so we upload it as .docx.
      let buf;
      // A docgen/template failure is a code/data problem, not a transient outage —
      // fail PERMANENT (dead-letter, visible) instead of retrying for ~6.7h.
      try { buf = docgen.generate(d.kind, docGenData); }
      catch (e) { const err = new Error(`Could not generate ${d.kind}: ${e.message}`); err.retryable = (e.retryable === true); throw err; }
      documentIdByKind[d.kind] = documentId;
      documents.push({ base64: Buffer.from(buf).toString('base64'), name: d.name, documentId, fileExtension: 'docx' });
      continue;
    }

    const doc = await latestDocument(db, row.application_id, d.kind);
    if (!doc) { missing.push(d.kind); continue; }
    // Stale-document guard (see apprBackAt above): the term sheet (freshnessCheck),
    // if created before the appraisal came back, may show a pre-appraisal loan
    // amount. Block (permanent) so staff regenerate it on the appraised value —
    // never mail a contradictory package.
    if (apprBackAt && d.freshnessCheck && doc.created_at && new Date(doc.created_at) < apprBackAt) {
      const err = new Error(`Cannot send ${spec.label}: the ${d.name} on file was produced before the appraisal came back, so it may show a loan amount that no longer matches. Regenerate the ${d.name} on the appraised value, then send.`);
      err.retryable = false;
      throw err;
    }
    let buf;
    try { buf = await storage.read(doc.storage_ref); }
    catch (e) { const err = new Error(`Could not read ${d.kind} bytes: ${e.message}`); err.retryable = true; throw err; }
    documentIdByKind[d.kind] = documentId;
    documents.push({ base64: Buffer.from(buf).toString('base64'), name: d.name, documentId, fileExtension: 'pdf' });
  }
  if (missing.length) {
    const err = new Error(`Cannot send ${spec.label}: missing document(s) — ${missing.join(', ')}. Generate them on the file first.`);
    err.retryable = false;
    throw err;
  }

  // Build signers from the SEEDED roster so recipientId/clientUserId/routingOrder
  // stay consistent with what the cockpit already shows.
  const recips = (await db.query(
    `SELECT role, routing_order, recipient_id_ds, name, email, client_user_id, is_countersigner
       FROM esign_recipients WHERE envelope_row_id = $1 ORDER BY routing_order, role`, [row.id])).rows;
  // Re-resolve the borrower / co-borrower identity from the CURRENT file record (a
  // corrected email/name since row-creation must reach the ACTUAL send — with test
  // mode off there is no allow-list backstop for a stale off-file address), and PRUNE
  // a co-borrower who was REMOVED from the deal since seeding (else the removed person
  // would still be emailed a binding envelope and block completion). Admin keeps config.
  const roster = [];
  for (const r of recips) {
    if (r.role === 'co_borrower' && !app.co_borrower_id) {
      await db.query(`DELETE FROM esign_recipients WHERE envelope_row_id=$1 AND recipient_id_ds=$2`, [row.id, r.recipient_id_ds]);
      continue;   // removed co-borrower → drop from the send AND the roster
    }
    let email, name;
    if (r.role === 'borrower') { email = app.b_email; name = `${app.b_first || ''} ${app.b_last || ''}`.trim(); }
    else if (r.role === 'co_borrower') { email = app.cb_email; name = `${app.cb_first || ''} ${app.cb_last || ''}`.trim(); }
    if ((email && email !== r.email) || (name && name !== r.name)) {
      r.email = email || r.email; r.name = name || r.name;
      await db.query(`UPDATE esign_recipients SET email=$2, name=$3, updated_at=now() WHERE envelope_row_id=$1 AND recipient_id_ds=$4`,
        [row.id, r.email, r.name, r.recipient_id_ds]);
    }
    roster.push(r);
  }
  const signers = roster.map((r) => ({
    recipientId: r.recipient_id_ds,
    name: r.name,
    email: r.email,
    routingOrder: r.routing_order,
    clientUserId: r.client_user_id,                      // embedded (in-portal) signing
    embeddedRecipientStartURL: 'SIGN_AT_DOCUSIGN',       // hybrid: ALSO send the DocuSign email
    tabsByDoc: tabsFor(r.role, spec, documentIdByKind),
  }));
  // The roster must be COMPLETE before sending. A concurrent claim (or the poller)
  // landing between the envelope INSERT and the recipient-seeding loop could read a
  // PARTIAL roster and otherwise send an incomplete envelope — e.g. a term sheet
  // WITHOUT the lender's routing-order-2 counter-signer, or missing the co-borrower.
  // Require borrower + co-borrower(iff the file has one) + admin(iff the package
  // counter-signs); otherwise treat as transient so the real send re-drives once
  // seeding has committed (a persistently-incomplete roster then dead-letters visibly).
  const have = new Set(roster.map((r) => r.role));
  const need = ['borrower',
    ...(app.co_borrower_id ? ['co_borrower'] : []),
    ...(spec.countersignRequired ? ['admin'] : [])];
  if (!need.every((role) => have.has(role))) {
    const e = new Error('Recipient roster not fully seeded yet — will retry.'); e.retryable = true; throw e;
  }

  const webhookUrl = `${cfg.appUrl}/api/esign/webhook`;
  return {
    documents,
    signers,
    subject: spec.subject(app.ys_loan_number),
    emailBlurb: spec.blurb,
    brandId: cfg.docusign.brandId || undefined,
    customFields: {
      textCustomFields: [
        { name: 'ys_file_id', value: String(row.application_id), show: 'false', required: 'false' },
        { name: 'ys_purpose', value: row.purpose, show: 'false' },
        { name: 'ys_envelope_row', value: String(row.id), show: 'false' },
      ],
    },
    eventNotification: docusignDefault.eventNotification(webhookUrl),
    notification: docusignDefault.notificationSettings(),
  };
}

// ---- the public entry point -------------------------------------------------
/**
 * Send a package for an application. Re-checks the gate, creates/claims the
 * envelope row (+ docs map + recipient roster), then hands off to the send-once
 * engine. Returns { ok, envelopeRowId, result } or throws with a clear reason.
 *
 * Gated: refuses unless cfg.docusign.sendEnabled (master switch) is on — enforced
 * here AND in the send engine (sendClaimedEnvelope), so a paused switch stops queued
 * retries too. In TEST mode the engine also blocks any non-allow-listed recipient;
 * once LIVE (test mode off) that backstop is intentionally gone, and real borrowers
 * are protected by the appraisal gate + validateGenerated + the roster completeness
 * check + the stale-document guard instead.
 */
async function sendPackage(applicationId, purpose, actor, opts = {}) {
  const db = opts.db || dbDefault;
  const docusign = opts.docusign || docusignDefault;
  const storage = opts.storage || storageDefault;
  const send = opts.send || sendEngine;

  const spec = packageSpec(purpose);
  if (!cfg.docusign.sendEnabled) {
    const e = new Error('DocuSign sending is disabled (DOCUSIGN_SEND_ENABLED is off).');
    e.code = 'DOCUSIGN_SEND_DISABLED'; e.retryable = false; throw e;
  }

  // Gate re-check — server-side, always. The client's "ready" is never trusted.
  const g = await gate.esignSendGate(applicationId, { db });
  if (!g.ready) {
    const e = new Error(`Not ready to send: ${g.outstanding.map((o) => o.label).join('; ')}`);
    e.code = 'DOCUSIGN_GATE_NOT_READY'; e.retryable = false; e.outstanding = g.outstanding; throw e;
  }

  const app = await loadApplication(db, applicationId);
  const { row, terminal } = await createOrClaimEnvelope(db, app, purpose, spec, actor && actor.id, { reissue: !!opts.reissue });
  // A plain send that found only a TERMINAL prior envelope did NOT mint a new one —
  // report that (never a false "Sent"), so the UI tells staff to use Re-issue rather
  // than piling up duplicate envelopes.
  if (terminal) return { ok: false, terminal: true, envelopeRowId: row.id, latestStatus: row.status };

  const result = await send.sendClaimedEnvelope(row.id, {
    db, docusign,
    buildDefinition: (r) => buildDefinition(r, { db, storage }),
    onDeadLetter,   // a failed send notifies the file's team (in-app + email)
  });
  // ok ONLY for a genuine send or an already-sent envelope — a merely queued /
  // backing-off row is NOT delivered and must not report success (the false "Sent").
  return { ok: !!(result && (result.sent || result.alreadySent)), envelopeRowId: row.id, result };
}

module.exports = {
  PACKAGES, packageSpec, buildDefinition, sendPackage,
  createOrClaimEnvelope, buildRoster, tabsFor, resolveConditionItem, latestDocument, loadApplication,
  loadDocGenData, validateGenerated,
};

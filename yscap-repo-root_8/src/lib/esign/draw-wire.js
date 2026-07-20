'use strict';
/**
 * esign/draw-wire.js — capture the borrower-typed WIRE INSTRUCTIONS off a completed
 * Draw Request envelope, save them to the file, and enforce the fatal name rule.
 *
 * The owner's rule (2026-07-20): the wire ACCOUNT NAME must be either the borrower's
 * personal name OR the property's subject/vesting LLC. If it is a NEW entity (neither),
 * the money is going somewhere else — raise a FATAL condition for the draw manager to
 * collect that entity's operating agreement before any wire goes out.
 *
 * Bias toward SAFETY: on ANY ambiguity we classify as a new entity (fatal). It is safe
 * to over-collect an operating agreement; it is dangerous to wire funds to an
 * unverified third-party account. So an account name that carries ANY company
 * designation ("… LLC", "… Construction", "… Holdings") is treated as an entity — it
 * only clears if it matches the subject LLC exactly; a bare personal name clears as the
 * borrower.
 *
 * The bank ACCOUNT NUMBER is sensitive → encrypted at rest (crypto.encryptSSN, the
 * shared AES-256-GCM cipher); only its last-4 is kept in clear. ABA ROUTING numbers are
 * public → clear. Everything is idempotent so a re-drive of completion re-produces the
 * same row + the same condition state.
 */
const cryptoLib = require('../crypto');
const { WIRE_KEYS } = require('./wire-tabs');

// ---- name classification (pure — unit-tested) -------------------------------

// Company designators that mark a name as an ENTITY (not a natural person). A name
// containing any of these is never classified 'borrower_personal'.
const ENTITY_DESIGNATORS = /\b(l\.?\s?l\.?\s?c|llc|pllc|inc|incorporated|corp|corporation|company|co|ltd|limited|lp|llp|lllp|plc|trust|partnership|holdings|holding|group|properties|property|capital|ventures|venture|enterprises|enterprise|construction|realty|management|mgmt|investments|investment|associates|partners|development|homes|builders|building|contracting|services|solutions|acquisitions|equities|estates|rentals|funding|financial)\b/i;

// Legal designators stripped when comparing two ENTITY names (so "Maple Ridge LLC"
// matches "Maple Ridge, L.L.C." and bare "Maple Ridge"). We strip ONLY legal-suffix
// words here, never the descriptive part of the name (Holdings/Group/etc stay).
const LEGAL_SUFFIX = /\b(l\.?\s?l\.?\s?c|llc|pllc|inc|incorporated|corp|corporation|company|co|ltd|limited|lp|llp|lllp|plc|trust|partnership)\b/gi;

/** Canonical form for comparing two ENTITY names: lowercase, & → and, strip legal
 *  suffixes, then strip everything non-alphanumeric. */
function normEntity(s) {
  let t = String(s == null ? '' : s).toLowerCase().replace(/&/g, ' and ').replace(/[.,]/g, ' ');
  t = t.replace(LEGAL_SUFFIX, ' ');
  return t.replace(/[^a-z0-9]/g, '');
}

/** Alphabetic tokens of a name (lowercased), preserving single-letter initials. */
function nameTokens(s) {
  return String(s == null ? '' : s).toLowerCase().match(/[a-z]+/g) || [];
}

function hasEntityDesignator(s) { return ENTITY_DESIGNATORS.test(String(s || '')); }

/**
 * Does `accountName` essentially equal the natural person `borrowerName`? True only
 * when it contains BOTH the borrower's first and last name AND every other word is
 * one of the borrower's own name tokens (a middle name / initial is fine) — so "Jane
 * Q Borrower", "Borrower, Jane", "Jane Borrower" match, but "Jane Borrower Homes"
 * does NOT (the extra business word "homes" makes it an entity).
 */
function personalMatch(accountName, borrowerName) {
  const a = nameTokens(accountName);
  const b = nameTokens(borrowerName);
  if (b.length < 2 || a.length < 2) return false;
  const bFirst = b[0], bLast = b[b.length - 1];
  const bSet = new Set(b);
  if (!a.includes(bFirst) || !a.includes(bLast)) return false;
  // Every account token must be a borrower name token OR a single-letter initial.
  const extra = a.filter((t) => t.length > 1 && !bSet.has(t));
  return extra.length === 0;
}

/**
 * Classify the wire account name. Returns { kind, matches }.
 *   kind: 'unknown' (blank) | 'subject_llc' | 'borrower_personal' | 'new_entity'
 *   matches: true when no operating agreement is needed (borrower or subject LLC).
 */
function classifyAccountName(accountName, { borrowerName, llcName } = {}) {
  const raw = String(accountName == null ? '' : accountName).trim();
  if (!raw) return { kind: 'unknown', matches: null };
  // Subject/vesting LLC — exact (suffix-tolerant) match wins first.
  if (llcName && String(llcName).trim() && normEntity(raw) && normEntity(raw) === normEntity(llcName)) {
    return { kind: 'subject_llc', matches: true };
  }
  // Personal name — only when it does NOT look like a company.
  if (!hasEntityDesignator(raw) && borrowerName && personalMatch(raw, borrowerName)) {
    return { kind: 'borrower_personal', matches: true };
  }
  return { kind: 'new_entity', matches: false };
}

// ---- conditions -------------------------------------------------------------

/**
 * Ensure the "Signed draw request & wire instructions form" condition exists on the
 * file (created when the coordinator SENDS the form). Idempotent per file. Returns the
 * checklist_item id — esign binds the signed PDF to it on completion.
 */
async function ensureDrawRequestCondition(db, appId, actorId) {
  const marker = `draw:request:${appId}`;
  const existing = (await db.query(
    `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`, [appId, marker])).rows[0];
  if (existing) return existing.id;
  const ins = await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, application_id, label, borrower_label, hint, borrower_hint,
        audience, item_kind, role_scope, is_required, category, field_key, status,
        created_by_kind, created_by_id, origin_kind, sort_order)
     SELECT t.id, 'application', $1, t.label, t.borrower_label, t.hint, t.borrower_hint,
            'both', 'document', COALESCE(t.role_scope,'processor'), true, 'draw', $2, 'outstanding',
            'staff', $3, 'manual_custom', 900
       FROM checklist_templates t WHERE t.code='draw_cond_signed_request'
     RETURNING id`, [appId, marker, actorId || null]);
  return ins.rows[0] ? ins.rows[0].id : null;
}

/**
 * Raise the FATAL operating-agreement condition for a NEW wire-recipient entity.
 * Idempotent per file (field_key marker). Returns the checklist_item id. A [auto]
 * FATAL note names the entity so the draw manager knows exactly what to collect.
 */
async function raiseOperatingAgreementCondition(db, appId, entityName) {
  const marker = `draw:wire_oa:${appId}`;
  const name = String(entityName || '').trim().slice(0, 120);
  const note = `[auto] FATAL — the draw wire account name${name ? ` ("${name}")` : ''} is a new entity (not the borrower and not the subject LLC). Collect this entity's operating agreement and confirm its authority to receive funds before releasing any wire.`;
  const existing = (await db.query(
    `SELECT id, status FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`, [appId, marker])).rows[0];
  if (existing) {
    // Update the note (the entity may have changed) and reopen if a prior clear no longer
    // applies — but NEVER downgrade a human-satisfied one (the OA was collected).
    await db.query(
      `UPDATE checklist_items
          SET notes=$2, issue_reason=$2, updated_at=now(),
              status=CASE WHEN status='satisfied' THEN status ELSE 'outstanding' END
        WHERE id=$1`, [existing.id, note]);
    return existing.id;
  }
  const ins = await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, application_id, label, borrower_label, hint, borrower_hint,
        audience, item_kind, role_scope, is_required, is_gate, category, field_key, status,
        created_by_kind, origin_kind, notes, issue_reason, sort_order)
     SELECT t.id, 'application', $1, t.label, t.borrower_label, t.hint, t.borrower_hint,
            'both', 'document', COALESCE(t.role_scope,'processor'), true, true, 'draw', $2, 'outstanding',
            'staff', 'manual_custom', $3, $3, 901
       FROM checklist_templates t WHERE t.code='draw_cond_operating_agreement'
     RETURNING id`, [appId, marker, note]);
  return ins.rows[0] ? ins.rows[0].id : null;
}

/**
 * Retract the auto-raised operating-agreement condition when the wire name now matches
 * the borrower / subject LLC. UNTOUCHED-only: the auto condition is DELETED (the clean
 * retract — it simply no longer applies) ONLY while it is still outstanding, auto-origin,
 * and carries NO uploaded/attached document. A human who has already collected a doc /
 * moved it forward keeps their condition (it is left exactly as-is). The wire row's FK is
 * ON DELETE SET NULL, so its operating_agreement_item_id clears automatically.
 */
async function retractOperatingAgreementCondition(db, appId) {
  const marker = `draw:wire_oa:${appId}`;
  const r = await db.query(
    `DELETE FROM checklist_items ci
      WHERE ci.application_id=$1 AND ci.field_key=$2 AND ci.status='outstanding'
        AND ci.origin_kind='manual_custom'
        AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id)
      RETURNING ci.id`, [appId, marker]);
  return r.rows[0] ? r.rows[0].id : null;
}

// ---- capture ----------------------------------------------------------------

/** Last 4 of an account number's digits (for masked display). */
function last4(v) { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-4) : null; }

/** Merge the wire text values across the envelope's signers (only the borrower has them). */
function wireValuesFromEnvelope(docusign, envelope) {
  const recips = docusign.parseRecipients(envelope) || [];
  const out = {};
  for (const r of recips) {
    const tv = r.textValues || {};
    for (const k of WIRE_KEYS) { if (tv[k] != null && tv[k] !== '' && out[k] == null) out[k] = tv[k]; }
  }
  return out;
}

/**
 * Capture wire instructions off a COMPLETED draw_request envelope: read the typed
 * values, classify the account name, persist (account # encrypted), and raise/retract
 * the operating-agreement condition. Idempotent. Best-effort notify of the file's team.
 *
 * db      — the pg pool/client
 * docusign — the DocuSign client (for the tabs re-fetch + parseRecipients)
 * envelopeRow — the esign_envelopes row (id, application_id, envelope_id)
 * opts.notify — the notify module (injectable for tests); defaults to require('../notify')
 * Returns { captured, name_kind } or null when there's nothing to capture.
 */
async function captureWireFromEnvelope(db, docusign, envelopeRow, opts = {}) {
  const appId = envelopeRow && envelopeRow.application_id;
  if (!appId) return null;   // app-less test envelope — nothing to file
  // Re-fetch WITH tabs so the typed values are present (the normal reconcile fetch
  // omits tabs). This is the only place we pull tab data.
  const envelope = await docusign.getEnvelope(envelopeRow.envelope_id, { include: 'recipients,tabs' });
  const wire = wireValuesFromEnvelope(docusign, envelope);
  const hasAny = WIRE_KEYS.some((k) => wire[k] != null && String(wire[k]).trim() !== '');
  if (!hasAny) return null;   // no wire fields on this envelope (not a draw_request, or blank)

  const file = (await db.query(
    `SELECT b.first_name, b.last_name,
            TRIM(COALESCE(b.first_name,'')||' '||COALESCE(b.last_name,'')) AS bname,
            l.llc_name
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
      WHERE a.id = $1`, [appId])).rows[0] || {};
  const accountName = (wire.account_name || '').trim();
  const cls = classifyAccountName(accountName, { borrowerName: file.bname, llcName: file.llc_name });

  const acctNum = (wire.account_number || '').trim();
  const acctEnc = acctNum ? cryptoLib.encryptSSN(acctNum) : null;   // AES-256-GCM (generic string cipher)
  const acctLast4 = last4(acctNum);
  // The raw label→value map we store for audit — with the account number REDACTED.
  const rawSafe = {};
  for (const k of WIRE_KEYS) rawSafe[k] = (k === 'account_number') ? (acctLast4 ? `****${acctLast4}` : '') : (wire[k] || '');

  // Raise/retract the operating-agreement condition BEFORE the upsert, so we can store
  // its id on the row. new_entity → fatal condition; otherwise retract any auto one.
  let oaItemId = null;
  if (cls.kind === 'new_entity') {
    oaItemId = await raiseOperatingAgreementCondition(db, appId, accountName);
  } else if (cls.matches) {
    await retractOperatingAgreementCondition(db, appId);
    oaItemId = null;
  }

  await db.query(
    `INSERT INTO draw_wire_instructions
       (application_id, envelope_row_id, account_name, bank_name, account_number_enc,
        account_last4, routing_number, bank_address, account_address, name_kind,
        name_matches, operating_agreement_item_id, captured_at, raw, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), $13::jsonb, now())
     ON CONFLICT (application_id) DO UPDATE SET
        envelope_row_id = EXCLUDED.envelope_row_id,
        account_name = EXCLUDED.account_name,
        bank_name = EXCLUDED.bank_name,
        account_number_enc = EXCLUDED.account_number_enc,
        account_last4 = EXCLUDED.account_last4,
        routing_number = EXCLUDED.routing_number,
        bank_address = EXCLUDED.bank_address,
        account_address = EXCLUDED.account_address,
        name_kind = EXCLUDED.name_kind,
        name_matches = EXCLUDED.name_matches,
        operating_agreement_item_id = EXCLUDED.operating_agreement_item_id,
        captured_at = now(), raw = EXCLUDED.raw, updated_at = now()`,
    [appId, envelopeRow.id, accountName || null, wire.bank_name || null, acctEnc,
     acctLast4, wire.routing_number || null, wire.bank_address || null, wire.account_address || null,
     cls.kind, cls.matches, oaItemId, JSON.stringify(rawSafe)]);

  // Tell the team a new-entity wire needs an operating agreement (action-needed → email).
  if (cls.kind === 'new_entity') {
    try {
      const notify = opts.notify || require('../notify');
      const ctx = await notify.fileContext(appId).catch(() => null);
      await notify.notifyAppStaff(appId, {
        type: 'condition_added',
        inAppOnly: false,   // action needed — do email the team
        title: 'Draw wire goes to a NEW entity — operating agreement required',
        badge: { text: 'Action needed', tone: 'action' },
        body: `The borrower's draw request lists a wire account in the name "${accountName}", which is neither the borrower nor the subject LLC. `
            + `A fatal condition was opened to collect that entity's operating agreement before any wire is released${ctx ? ` (${ctx.label})` : ''}.`,
        applicationId: appId,
        link: `/internal/app/${appId}`,
      });
    } catch (_) { /* best-effort */ }
  }

  return { captured: true, name_kind: cls.kind, name_matches: cls.matches, operating_agreement_item_id: oaItemId };
}

module.exports = {
  // pure classifiers (tests)
  normEntity, nameTokens, hasEntityDesignator, personalMatch, classifyAccountName, last4,
  // conditions
  ensureDrawRequestCondition, raiseOperatingAgreementCondition, retractOperatingAgreementCondition,
  // capture
  wireValuesFromEnvelope, captureWireFromEnvelope,
};

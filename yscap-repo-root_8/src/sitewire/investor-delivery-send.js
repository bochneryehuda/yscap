'use strict';
/**
 * INVESTOR DELIVERY — the IO half (owner-directed 2026-08-03).
 *
 * ./investor-delivery.js decides the money, the wording and who may receive it, with no database
 * in reach. This module is everything that touches the world: the investor's contacts, the four
 * documents that ride along, the send itself, and the durable record of what went out.
 *
 * WHAT THE INVESTOR RECEIVES, and why each one:
 *   1. the INSPECTOR's own report      — the third party's word, not ours (Sitewire's per-draw PDF,
 *                                        or the physical inspector's paperwork on a Trinity /
 *                                        TrustPoint file — whichever inspected this draw)
 *   2. OUR branded draw report (PDF)   — photos + per-line approvals + the release breakdown
 *   3. the draw packet (Excel)         — the whole schedule of values with this draw on every line
 *   4. the signed wire instructions     — the borrower's own DocuSign form, so the investor can pay
 *
 * NOTHING IS EVER SILENTLY DROPPED: anything that cannot be attached comes back in `skipped` WITH
 * A REASON, is shown on the desk before the send, is printed in the email itself, and is stored on
 * the delivery record. An investor quietly one document short is the failure this exists to avoid.
 */

const db = require('../db');
const cfg = require('../config');
const storage = require('../lib/storage');
const email = require('../lib/email');
const template = require('../lib/email/template');
const F = require('../lib/fields');
const rollupMod = require('./rollup');
const drawReport = require('./draw-report');
const { buildDrawPacket } = require('./draw-packet');
const { buildXlsx } = require('../lib/xlsx');
const recipients = require('../lib/draw-recipients');
const drawLabel = require('../lib/draw-label');   // "Draw 2" — the ONE way a draw is named
const fieldRegistry = require('../lib/conditions/field-registry');
const ACCEPT = require('../lib/document-acceptance');
const ID = require('./investor-delivery');
const drawAttachments = require('./draw-attachments');   // invoices/receipts/photos filed on a draw

const N = (x) => Number(x || 0) || 0;

// The address the investor sees and replies to. Deliberately the shared draw desk, not a person:
// the owner's rule is that this comes from our general draw email and is signed by the coordinator.
// Resend sends as any address on our verified domain; a Graph mailbox ignores `from` and sends as
// itself, so the Reply-To carries the desk either way.
const DESK = recipients.DRAW_DESK_INBOX;
function deskFrom() { return `"YS Capital — Draw Desk" <${DESK}>`; }

// Per-provider attachment budget. Graph rejects inline attachments past ~3 MB, so it gets a much
// smaller ceiling — the same split closing-prep.js uses.
function budgetBytes() {
  const graph = String(cfg.emailProvider || '').toLowerCase() === 'graph';
  const mb = Number(process.env.INVESTOR_ATTACH_BUDGET_MB) || (graph ? 2.5 : 20);
  return Math.max(1, mb) * 1024 * 1024;
}

/**
 * The note-buyer KEY a contact list is stored under.
 *
 * `normNoteBuyer` is deliberately EXACT across this codebase (loosening it would let a look-alike
 * name export another buyer's data tape — tapes/buyer-rule.js), so the owner's real label
 * "Fidelis Investors LLC" normalizes to `fidelisinvestorsllc`, not `fidelis`. Rather than loosen
 * the shared normalizer, we reuse the shared PREFIX helper the repo already blessed for exactly
 * this buyer (`isFidelisNoteBuyer`, db/337) to fold every Fidelis spelling onto one canonical key.
 * A future buyer that needs the same treatment gets a helper in field-registry — never a fuzzy
 * match invented here.
 */
function investorKeyFor(lender) {
  const raw = String(lender == null ? '' : lender).trim();
  if (!raw) return null;
  try { if (fieldRegistry.isFidelisNoteBuyer(raw)) return 'fidelis'; } catch (_) { /* fall through */ }
  const key = fieldRegistry.normNoteBuyer(raw);
  return key || null;
}

/** The saved contacts for a note buyer (active only), in a stable order. Never throws. */
async function contactsForNoteBuyer(lender) {
  const key = investorKeyFor(lender);
  if (!key) return [];
  try {
    const r = await db.query(
      `SELECT id, label, email, name, role FROM investor_delivery_contacts
        WHERE label_norm = $1 AND active = true ORDER BY lower(email)`, [key]);
    return r.rows;
  } catch (_) { return []; }
}

/** Every buyer that has contacts saved — for the settings screen. */
async function allContacts() {
  const r = await db.query(
    `SELECT id, label_norm, label, email, name, role, active, created_at
       FROM investor_delivery_contacts ORDER BY label_norm, lower(email)`);
  return r.rows;
}

// ---------------------------------------------------------------------------
// ATTACHMENTS
// ---------------------------------------------------------------------------

/** Read a stored document's bytes. Returns null (never throws) when it can't be read. */
async function readDoc(row) {
  if (!row || !row.storage_ref) return null;
  try {
    // storage.read takes the ref alone — the provider composite handles the s3→local fallback.
    const buf = await storage.read(row.storage_ref);
    return buf && buf.length ? buf : null;
  } catch (_) { return null; }
}

/**
 * Gather the four attachments IN PRIORITY ORDER. Each entry is
 * `{ what, filename, contentType, buf }`; anything missing lands in `skipped` with a plain reason.
 *
 * The inspector's report is looked up two ways because a draw is inspected EITHER through Sitewire
 * (a virtual inspection — its per-draw PDF is archived into `draw_media`) OR by a physical
 * inspector whose paperwork arrives as TrustPoint documents. A file can carry both; both are sent.
 */
async function gatherAttachments(appId, drawId, mode) {
  const items = [];
  const skipped = [];

  // --- 1. the inspector's own report -------------------------------------------------
  let inspectorFound = false;
  try {
    // Only the NEWEST Sitewire report (owner-directed 2026-08-11): a refresh runs
    // before this send, so after a dispute a NEW draw_media 'draw_pdf' row exists
    // alongside the old one — we deliver the most recent version, never the stale
    // pre-dispute PDF. (An unchanged draw dedups by content hash, so there is only
    // one row anyway.)
    const pdfs = (await db.query(
      `SELECT id, storage_ref, storage_provider, content_type FROM draw_media
        WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='draw_pdf'
        ORDER BY archived_at DESC LIMIT 1`, [appId, drawId])).rows;
    for (const m of pdfs) {
      const buf = await readDoc(m);
      if (!buf) { skipped.push({ what: 'Inspection report', reason: 'the stored copy could not be read' }); continue; }
      inspectorFound = true;
      items.push({ what: 'Inspection report', filename: `inspection-report-draw-${drawId}.pdf`, contentType: 'application/pdf', buf });
    }
  } catch (_) { /* fall through to the physical-inspection lookup */ }

  // The physical inspector's paperwork (Trinity / TrustPoint), keyed on ITS OWN draw number —
  // the two systems number draws independently, so this must never be resolved from the Sitewire
  // number (the same trap borrowerFindingAttachments documents in routes/sitewire.js).
  try {
    const tp = (await db.query(
      `SELECT number FROM trustpoint_draws WHERE sitewire_draw_id=$1::bigint AND application_id=$2`,
      [String(drawId), appId])).rows[0];
    if (tp && tp.number != null) {
      const rows = (await db.query(
        `SELECT id, filename, storage_ref, storage_provider FROM documents
          WHERE application_id=$1 AND is_current AND doc_kind='draw_inspection_report'
            AND filename LIKE 'trustpoint-draw-' || $2 || '-%'
          ORDER BY created_at DESC LIMIT 4`, [appId, String(tp.number)])).rows;
      for (const d of rows) {
        const buf = await readDoc(d);
        if (!buf) { skipped.push({ what: `Inspection paperwork (${d.filename})`, reason: 'the stored copy could not be read' }); continue; }
        inspectorFound = true;
        items.push({ what: 'Inspection paperwork', filename: d.filename, contentType: 'application/pdf', buf });
      }
    }
  } catch (_) { /* trustpoint_draws may not exist on an older database — not fatal */ }

  if (!inspectorFound) skipped.push({ what: 'Inspection report', reason: "the inspector's report has not been archived for this draw yet" });

  // --- 2. our own branded report ------------------------------------------------------
  try {
    const r = await drawReport.buildOrGetReportDoc(appId, { sitewireDrawId: drawId, scope: 'draw', mode: 'staff' });
    const buf = r && r.doc ? await readDoc(r.doc) : null;
    if (buf) items.push({ what: 'PILOT draw report', filename: r.doc.filename, contentType: 'application/pdf', buf });
    else skipped.push({ what: 'PILOT draw report', reason: 'the report could not be built for this draw' });
  } catch (_) { skipped.push({ what: 'PILOT draw report', reason: 'the report could not be built for this draw' }); }

  // --- 3. the draw packet (Excel) -----------------------------------------------------
  try {
    const buf = buildXlsx(await buildDrawPacket(appId, drawId), `Draw ${drawId}`);
    if (buf && buf.length) items.push({ what: 'Draw packet', filename: `draw-packet-${drawId}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf });
    else skipped.push({ what: 'Draw packet', reason: 'the packet came back empty' });
  } catch (_) { skipped.push({ what: 'Draw packet', reason: 'the packet could not be built' }); }

  // --- 4. the borrower's signed wire instructions --------------------------------------
  // The signed wire form tells the investor WHERE to send the borrower's money, so it
  // belongs ONLY on an INVESTOR_DIRECT delivery — the investor is releasing straight to
  // the borrower and needs it. On a REIMBURSEMENT delivery WE have already wired the
  // borrower and the investor is only paying US back, so the borrower's wire form must
  // NOT be sent to the investor (owner-directed 2026-08-05: "if we are requesting
  // reimbursement for us, you should not attach the borrower's wire draw form … If we
  // are asking for the investor to release it directly to the borrower, then that
  // form's signed, executed version should be sent to the investor").
  if (mode === 'investor_direct') {
    try {
      // Deliver the ACCEPTED wire form — a DocuSign copy OR a manually-uploaded one (both are
      // draw_request_signed; the manual one is told apart only by source_type). Selecting the
      // newest ACCEPTED current copy (not just the newest current) keeps what is DELIVERED in
      // lock-step with what the money gate (wireFormStatus) approved: if two current copies ever
      // coexist, the investor never receives an unaccepted one.
      const w = (await db.query(
        `SELECT id, filename, storage_ref, storage_provider FROM documents
          WHERE application_id=$1 AND is_current AND doc_kind='draw_request_signed' AND ${ACCEPT.ACCEPTED_SQL('')}
          ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
      const buf = w ? await readDoc(w) : null;
      if (buf) items.push({ what: 'Signed wire instructions', filename: w.filename || 'wire-instructions-signed.pdf', contentType: 'application/pdf', buf });
      else skipped.push({ what: 'Signed wire instructions', reason: w ? 'the stored copy could not be read' : 'the accepted wire instructions form is not on file yet' });
    } catch (_) { skipped.push({ what: 'Signed wire instructions', reason: 'the stored copy could not be read' }); }

    // --- 5. the wire-recipient entity's operating agreement, when the wire goes to a NEW entity
    // (Task 5, owner-directed 2026-08-05: "attach the OA to the investor email when the investor
    // receives it"). Only present when the wire named an entity that is neither the borrower nor
    // the subject LLC — the investor uses it to confirm the entity before releasing directly to it.
    // Only an ACCEPTED agreement is sent; an unaccepted one has not been vetted.
    try {
      const drawOa = require('../lib/esign/draw-oa');
      const oa = await drawOa.acceptedOaForInvestor(db, appId);
      if (oa) {
        const buf = await readDoc(oa);
        if (buf) items.push({ what: 'Operating agreement (wire recipient)', filename: oa.filename || 'operating-agreement.pdf', contentType: 'application/pdf', buf });
        else skipped.push({ what: 'Operating agreement (wire recipient)', reason: 'the stored copy could not be read' });
      }
      // No OA condition / no accepted agreement → the wire is to the borrower or the subject LLC;
      // nothing to attach, and nothing to report as missing.
    } catch (_) { /* the OA is an extra only on a new-entity wire — never block the delivery */ }
  }

  // --- 6. the supporting documents attached to this draw --------------------------------
  // Invoices, receipts and extra photos a coordinator (or the borrower) filed on the draw —
  // typically the proof behind an override (owner-directed 2026-08-09: "when we override
  // something, we should be able to add invoices, receipts, or additional photos, and that should
  // also be delivered to the investor on investor delivery"). They sit AFTER the reports in
  // priority order deliberately: the inspector's report and ours are what the investor funds
  // against; these are the backup. Only an ACCEPTED document travels — a borrower's upload nobody
  // has reviewed is not something we vouch for to an investor (db/424).
  try {
    const rows = (await db.query(
      `SELECT da.category, da.note, d.id, d.filename, d.content_type, d.storage_ref, d.storage_provider, d.review_status
         FROM draw_attachments da JOIN documents d ON d.id = da.document_id
        WHERE da.application_id=$1 AND da.sitewire_draw_id=$2 AND d.is_current
        ORDER BY da.created_at ASC, da.id ASC`, [appId, drawId])).rows;
    for (const a of rows) {
      const label = `${drawAttachments.CATEGORY_LABEL[a.category] || 'Supporting document'} — ${a.filename}`;
      if (a.review_status !== 'accepted') {
        skipped.push({ what: label, reason: 'it has not been accepted yet — review it first and re-send' });
        continue;
      }
      const buf = await readDoc(a);
      if (!buf) { skipped.push({ what: label, reason: 'the stored copy could not be read' }); continue; }
      items.push({ what: label, filename: a.filename, contentType: a.content_type || 'application/octet-stream', buf });
    }
  } catch (_) { /* an older database has no draw_attachments — never block the delivery */ }

  // Fit the budget IN PRIORITY ORDER — the inspector's report and ours matter most.
  const budget = budgetBytes();
  const fit = [];
  let total = 0;
  for (const it of items) {
    if (total + it.buf.length > budget) {
      skipped.push({ what: it.what, reason: 'too large to attach to one email — send it separately' });
      continue;
    }
    total += it.buf.length;
    fit.push(it);
  }
  return { items: fit, skipped };
}

// ---------------------------------------------------------------------------
// WIRE FORM GATE
// ---------------------------------------------------------------------------

/**
 * The signed WIRE FORM's review state on the FILE (the wire instructions are the same across
 * every draw, so this is a file-level check — once accepted, every later draw is cleared).
 *
 * The borrower's DocuSign wire form files onto the draw_cond_signed_request condition
 * (doc_kind draw_request_signed); a coordinator may also upload a corrected version onto that
 * same condition. Either way, the money can only move once ONE correct version has been
 * ACCEPTED — the owner's "accept one version, reject the rest, before the first draw goes to
 * the investor". Acceptance uses the ONE shared definition (document-acceptance), so this gate
 * and the sign-off gate can never disagree about what "accepted" means.
 *
 * FAILS OPEN on a read error: a database blip must never make a delivery permanently
 * impossible — the finding-agreed and note-buyer checks are the primary money gates, and the
 * coordinator is in the loop clicking send.
 *
 * Returns { present, accepted, rejectedOnly }.
 */
async function wireFormStatus(appId) {
  try {
    const item = (await db.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`,
      [appId, `draw:request:${appId}`])).rows[0];
    const wireItemId = item ? item.id : null;
    const r = (await db.query(
      `SELECT
         count(*) FILTER (WHERE ${ACCEPT.ACCEPTED_SQL('d')}) AS accepted,
         count(*) FILTER (WHERE COALESCE(d.review_status,'pending') = 'rejected') AS rejected,
         count(*) AS total
       FROM documents d
      WHERE d.application_id=$1 AND d.is_current
        AND (d.doc_kind='draw_request_signed' OR ($2::uuid IS NOT NULL AND d.checklist_item_id=$2))`,
      [appId, wireItemId])).rows[0] || {};
    const total = Number(r.total) || 0;
    const rejected = Number(r.rejected) || 0;
    const accepted = Number(r.accepted) > 0;
    return { present: total > 0, accepted, rejectedOnly: total > 0 && !accepted && rejected === total };
  } catch (_) {
    return { present: false, accepted: true, rejectedOnly: false };   // fail OPEN
  }
}

// ---------------------------------------------------------------------------
// PREVIEW + SEND
// ---------------------------------------------------------------------------

/** Everything the desk needs to show BEFORE anyone clicks send. Never throws. */
async function deliveryPreview(appId, drawId) {
  const app = (await db.query(
    `SELECT a.ys_loan_number AS loan_no, a.lender AS note_buyer, a.property_address->>'oneLine' AS address,
            NULLIF(btrim(b.full_name),'') AS borrower_name, b.email AS borrower_email,
            cb.email AS co_borrower_email
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
      WHERE a.id = $1`, [appId])).rows[0] || {};

  const finding = (await db.query(
    `SELECT id, status, funding_mode, accepted_at, accepted_via, resolved_at
       FROM draw_findings WHERE application_id=$1 AND sitewire_draw_id=$2`, [appId, drawId])).rows[0] || null;

  const link = (await db.query(
    `SELECT investor_funding_mode FROM sitewire_property_links
      WHERE application_id=$1 AND matched_by='created' LIMIT 1`, [appId])).rows[0] || {};

  const mode = ID.resolveFundingMode({
    drawMode: finding && finding.funding_mode,
    fileMode: link.investor_funding_mode,
  });

  // The SAME money the report and the packet were built from — never re-derived here.
  let money = ID.investorMoney({}, mode);
  let drawNumber = null;
  try {
    const rl = await rollupMod.loadRollup(db, appId);
    const d = (rl.draws || []).find((x) => Number(x.sitewire_draw_id) === Number(drawId));
    if (d) { money = ID.investorMoney(d, mode); drawNumber = d.number; }
  } catch (_) { /* the preview still renders; the blockers below say what is missing */ }
  // The rollup is the fast path; when it could not be read (or carries no number for this draw)
  // fall back to the ONE number resolver, so the investor's subject stops silently degrading to
  // the anonymous "Draw request". Still never guesses — null stays null.
  if (drawNumber == null) {
    drawNumber = await drawLabel.drawNumberFor(db, appId, { sitewireDrawId: drawId });
  }

  const contacts = await contactsForNoteBuyer(app.note_buyer);
  const wireForm = await wireFormStatus(appId);
  const [coordinators, officerEmails] = await Promise.all([
    recipients.coordinatorsOrDesk(appId).catch(() => []),
    recipients.fileLoanOfficerEmails(appId).catch(() => []),
  ]);
  const rcpt = ID.composeRecipients({
    investorEmails: contacts.map((c) => c.email),
    coordinatorEmails: coordinators.map((c) => c.email),
    officerEmails,
    deskEmail: DESK,
    borrowerEmails: [app.borrower_email, app.co_borrower_email],
  });

  const blockers = ID.deliveryBlockers({ finding, investorContacts: contacts, noteBuyer: app.note_buyer, mode, wireForm });

  // HAS THIS LOAN ACTUALLY BEEN SOLD? A WARNING, NEVER A BLOCKER — this is the exact moment the
  // owner named (2026-08-09: "default should be like it was sold already, but it should give you a
  // warning that it doesn't have a PA date if you're sure you want to do investor delivery"). It is
  // deliberately kept OUT of `blockers`, so `can_send` is untouched and the send is never refused
  // over it; the screen shows it beside the button and the coordinator decides.
  //
  // A table-funded loan was sold at the closing table and produces NO warning at all, which is the
  // whole point — otherwise every Fidelis delivery would carry a nag about a date that is never
  // coming. Best-effort: an unreadable state simply shows nothing rather than blocking a send or
  // inventing a doubt.
  let soldState = null;
  try { soldState = await require('./release-party').releaseStateFor(db, appId, { sitewireDrawId: drawId }); }
  catch (_) { soldState = null; }

  const history = (await db.query(
    `SELECT id, funding_mode, investor_total_cents, to_borrower_cents, to_us_cents, to_emails,
            status, error, sent_at, sent_by
       FROM draw_investor_deliveries WHERE application_id=$1 AND sitewire_draw_id=$2
      ORDER BY sent_at DESC LIMIT 10`, [appId, drawId])).rows;

  return {
    draw_id: Number(drawId), draw_number: drawNumber,
    note_buyer: app.note_buyer || null,
    note_buyer_key: investorKeyFor(app.note_buyer),
    address: app.address || null, loan_no: app.loan_no || null,
    borrower_name: app.borrower_name || null,
    finding_status: finding ? finding.status : null,
    accepted_via: finding ? finding.accepted_via : null,
    funding_mode: mode,
    funding_mode_source: (finding && ID.MODES.includes(String(finding.funding_mode || ''))) ? 'draw'
      : (ID.MODES.includes(String(link.investor_funding_mode || '')) ? 'file' : 'default'),
    money,
    contacts,
    wire_form: wireForm,
    to: rcpt.to, cc: rcpt.cc,
    blockers,
    // `can_send` reads ONLY the blockers. The sold warning below is advisory by the owner's own
    // rule and must never creep into this — if it ever needs to stop a send, that is a new
    // owner decision, not a line moved.
    can_send: blockers.length === 0,
    sold: soldState ? soldState.sold : null,
    sold_label: soldState ? soldState.soldLabel : null,
    sold_via: soldState ? soldState.soldVia : null,
    sold_warning: soldState ? soldState.warning : null,
    history,
  };
}

/**
 * SEND the delivery. The caller has already confirmed (the route requires an explicit
 * `confirm:true` naming the investor) and has file access + manage_draws.
 *
 * The blockers are re-checked HERE, not trusted from the preview the screen fetched earlier: the
 * borrower could have been un-accepted, or the contacts edited, between the two calls.
 */
async function sendInvestorDelivery(appId, drawId, { staffId = null, staffName = null, mode = null, note = null } = {}) {
  // REFRESH FROM SITEWIRE FIRST (owner-directed 2026-08-11: "when we click Deliver
  // to Investor, that button — before actually delivering — should run a refresh
  // from Sitewire: refresh our figures, pull the new Sitewire PDF, and THAT PDF is
  // what's delivered"). A dispute may have changed the approved figures, which
  // regenerates Sitewire's report; without this the investor got the stale
  // pre-dispute copy. Best-effort: if Sitewire is unreachable we deliver the
  // freshest we already hold rather than block the delivery.
  try { await drawReport.refreshDrawFromSitewire(appId, drawId); }
  catch (e) { console.warn(`[sitewire] pre-delivery refresh failed (draw=${drawId}): ${e && e.message}`); }

  const pre = await deliveryPreview(appId, drawId);

  // An explicit mode on the request wins for THIS send (the desk offers the switch right beside
  // the button); otherwise the resolved per-draw/per-file/default mode stands.
  const useMode = ID.MODES.includes(String(mode || '')) ? String(mode) : pre.funding_mode;

  // Re-check the blockers AGAINST THE MODE THIS SEND WILL USE — never trust the preview's list,
  // which was computed for the resolved mode and may need different things (a manual delivery needs
  // no investor contacts; an emailed one does).
  const blockers = ID.deliveryBlockers({
    finding: pre.finding_status ? { status: pre.finding_status } : null,
    investorContacts: pre.contacts, noteBuyer: pre.note_buyer, mode: useMode, wireForm: pre.wire_form,
  });
  if (blockers.length) { const e = new Error(blockers[0]); e.status = 422; e.blockers = blockers; throw e; }

  const money = ID.investorMoney(pre.money, useMode);
  const noteText = String(note == null ? '' : note).trim().slice(0, 2000) || null;

  // MANUAL — the coordinator delivered to the investor outside PILOT. Record it (so the "deliver to
  // the investor" reminders stop and the history shows it) and stop here: no email is composed or
  // sent, and no documents are gathered. The money figures are still stored for the record.
  if (useMode === 'manual') {
    const rec = (await db.query(
      `INSERT INTO draw_investor_deliveries
         (application_id, sitewire_draw_id, funding_mode, note_buyer_label, note_buyer_key,
          requested_cents, approved_cents, fee_cents, retainage_held_cents,
          to_borrower_cents, to_us_cents, investor_total_cents,
          to_emails, cc_emails, attachments, skipped, status, note, sent_by)
       VALUES ($1,$2,'manual',$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'sent',$12,$13)
       RETURNING id, sent_at`,
      [appId, drawId, pre.note_buyer, pre.note_buyer_key,
        money.requested_cents, money.approved_cents, money.fee_cents, money.retainage_held_cents,
        money.to_borrower_cents, money.to_us_cents, money.investor_total_cents,
        noteText, staffId])).rows[0];
    return {
      id: rec.id, sent_at: rec.sent_at, funding_mode: 'manual', money,
      to: [], cc: [], attachments: [], skipped: [], manual: true, note: noteText,
    };
  }

  const { items, skipped } = await gatherAttachments(appId, drawId, useMode);

  let inspectionBy = null;
  try {
    const tp = (await db.query(`SELECT 1 FROM trustpoint_draws WHERE sitewire_draw_id=$1::bigint AND application_id=$2`, [String(drawId), appId])).rows[0];
    inspectionBy = tp ? 'Physical inspection' : 'Third-party inspection';
  } catch (_) { /* optional detail */ }

  const wording = ID.deliveryEmail({
    loanNo: pre.loan_no, address: pre.address, drawNumber: pre.draw_number,
    borrowerName: pre.borrower_name, coordinatorName: staffName, inspectionBy,
  }, money);

  const meta = [...wording.rows, ...wording.detail];
  const lines = [wording.intro];
  // WHAT WE SENT, NOT WHAT WE COULDN'T (owner-directed 2026-08-13: "even if it's not attached, it
  // shouldn't say 'Hey, this was not attached' — it makes it unprofessional").
  //
  // This used to append "Not attached: PILOT draw report (too large to attach to one email — send
  // it separately). Let us know and we will send it over." — an apology for our own plumbing, in a
  // letter to a capital partner, ending by asking THEM to chase US. It now names what IS enclosed
  // and stops there.
  //
  // NOTHING IS LOST INTERNALLY, which is what makes this safe rather than a cover-up: every skipped
  // item and its reason is still returned to the caller, still shown on the delivery card BEFORE
  // anyone presses send, and still written to `draw_investor_deliveries.skipped` — the permanent
  // record of what this email did and did not carry. The team simply no longer says it out loud to
  // the investor.
  if (items.length) {
    lines.push('Enclosed: ' + items.map((it) => it.what).join(', ') + '.');
  }

  // template.render returns { subject, html, text } — take BOTH bodies from it so the HTML and the
  // plain-text alternative are generated from one set of inputs and can never say different things.
  // Our own subject wins (render's is built from `title`).
  const rendered = template.render({
    title: 'Draw request for funding',
    kicker: 'Draw delivery',
    intro: lines.join(' '),
    meta,
    callout: { title: 'What we are asking for', body: wording.ask, tone: 'action' },
    note: `Attached: ${items.map((i) => i.what).join(', ') || 'no documents could be attached'}.`
      + `\n\n${wording.signOff}`,
    replyable: true,
  });
  const html = rendered.html;
  const text = rendered.text;

  let status = 'sent';
  let errText = null;
  try {
    await email.sendMail({
      to: pre.to,
      cc: pre.cc,
      from: deskFrom(),
      replyTo: DESK,
      subject: wording.subject,
      text,
      html,
      attachments: items.map((i) => ({ filename: i.filename, content: i.buf.toString('base64'), contentType: i.contentType })),
      _ctx: { applicationId: appId, type: 'draw_investor_delivery', audience: 'staff' },
    });
  } catch (e) {
    status = 'error';
    errText = String((e && e.message) || 'send failed').slice(0, 500);
  }

  const rec = (await db.query(
    `INSERT INTO draw_investor_deliveries
       (application_id, sitewire_draw_id, funding_mode, note_buyer_label, note_buyer_key,
        requested_cents, approved_cents, fee_cents, retainage_held_cents,
        to_borrower_cents, to_us_cents, investor_total_cents,
        to_emails, cc_emails, attachments, skipped, status, error, note, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id, sent_at`,
    [appId, drawId, useMode, pre.note_buyer, pre.note_buyer_key,
      money.requested_cents, money.approved_cents, money.fee_cents, money.retainage_held_cents,
      money.to_borrower_cents, money.to_us_cents, money.investor_total_cents,
      F.jsonbText(pre.to), F.jsonbText(pre.cc),
      F.jsonbText(items.map((i) => ({ filename: i.filename, what: i.what, bytes: i.buf.length }))),
      F.jsonbText(skipped), status, errText, noteText, staffId])).rows[0];

  if (status === 'error') { const e = new Error(errText || 'the delivery email could not be sent'); e.status = 502; throw e; }

  return {
    id: rec.id, sent_at: rec.sent_at, funding_mode: useMode, money,
    to: pre.to, cc: pre.cc,
    attachments: items.map((i) => ({ filename: i.filename, what: i.what, bytes: i.buf.length })),
    skipped,
  };
}

module.exports = {
  investorKeyFor, contactsForNoteBuyer, allContacts,
  gatherAttachments, deliveryPreview, sendInvestorDelivery, wireFormStatus,
  DESK, deskFrom, budgetBytes,
};

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
const fieldRegistry = require('../lib/conditions/field-registry');
const ID = require('./investor-delivery');

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
async function gatherAttachments(appId, drawId) {
  const items = [];
  const skipped = [];

  // --- 1. the inspector's own report -------------------------------------------------
  let inspectorFound = false;
  try {
    const pdfs = (await db.query(
      `SELECT id, storage_ref, storage_provider, content_type FROM draw_media
        WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='draw_pdf'
        ORDER BY archived_at DESC LIMIT 2`, [appId, drawId])).rows;
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
  try {
    const w = (await db.query(
      `SELECT id, filename, storage_ref, storage_provider FROM documents
        WHERE application_id=$1 AND is_current AND doc_kind='draw_request_signed'
        ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
    const buf = w ? await readDoc(w) : null;
    if (buf) items.push({ what: 'Signed wire instructions', filename: w.filename || 'wire-instructions-signed.pdf', contentType: 'application/pdf', buf });
    else skipped.push({ what: 'Signed wire instructions', reason: w ? 'the stored copy could not be read' : 'the borrower has not signed the wire instructions form yet' });
  } catch (_) { skipped.push({ what: 'Signed wire instructions', reason: 'the stored copy could not be read' }); }

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

  const contacts = await contactsForNoteBuyer(app.note_buyer);
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

  const blockers = ID.deliveryBlockers({ finding, investorContacts: contacts, noteBuyer: app.note_buyer, mode });

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
    to: rcpt.to, cc: rcpt.cc,
    blockers,
    can_send: blockers.length === 0,
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
  const pre = await deliveryPreview(appId, drawId);

  // An explicit mode on the request wins for THIS send (the desk offers the switch right beside
  // the button); otherwise the resolved per-draw/per-file/default mode stands.
  const useMode = ID.MODES.includes(String(mode || '')) ? String(mode) : pre.funding_mode;

  // Re-check the blockers AGAINST THE MODE THIS SEND WILL USE — never trust the preview's list,
  // which was computed for the resolved mode and may need different things (a manual delivery needs
  // no investor contacts; an emailed one does).
  const blockers = ID.deliveryBlockers({
    finding: pre.finding_status ? { status: pre.finding_status } : null,
    investorContacts: pre.contacts, noteBuyer: pre.note_buyer, mode: useMode,
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

  const { items, skipped } = await gatherAttachments(appId, drawId);

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
  if (skipped.length) {
    lines.push('Not attached: ' + skipped.map((s) => `${s.what} (${s.reason})`).join('; ') + '. Let us know and we will send it over.');
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
  gatherAttachments, deliveryPreview, sendInvestorDelivery,
  DESK, deskFrom, budgetBytes,
};

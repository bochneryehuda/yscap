'use strict';
/**
 * THE DRAW PACKET (Excel) — the coordinator's one-sheet answer for a single draw: the whole schedule
 * of values with this draw on every line, what is released vs still available, the release breakdown
 * (what is netted out and why), our fee income on the project, the inspection findings and the lien
 * waivers.
 *
 * Lifted out of routes/sitewire.js so the numbers can be tested directly against a database —
 * two of them were wrong for months and no test could reach them (owner-reported 2026-08-03):
 *   • the TOTAL row's "approved" read Sitewire's FINAL-approval field, so it said $0 under a column
 *     of real per-line approvals (see ./approval for the ladder);
 *   • "Remaining" was budget − RELEASED, so a $25,000 roof draw the inspector had fully approved
 *     still showed the whole $25,000 as remaining on that line and the whole budget on the project.
 * Read-only: assembled from persisted data, no live Sitewire call.
 */
const db = require('../db');
const rollupMod = require('./rollup');
const APPROVAL = require('./approval');

// Assemble a per-draw PACKET (Built/Rabbet "draw packaging"): cover + schedule of values with
// % complete + this draw's per-line requested/approved + inspection findings + lien waivers, as
// one Excel workbook. Read-only, assembled from persisted data (no live Sitewire call needed).
async function buildDrawPacket(appId, drawId) {
  const c = (x) => Math.round(Number(x || 0)) / 100;
  const a = (await db.query(`SELECT ys_loan_number, property_address->>'oneLine' AS address FROM applications WHERE id=$1`, [appId])).rows[0] || {};
  const draw = (await db.query(`SELECT number, status, submitted_at, approved_at, total_requested_cents, total_approved_cents FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId])).rows[0] || {};
  const rollup = await rollupMod.loadRollup(db, appId);
  // this draw's requests keyed to their SOW line (via the crosswalk)
  const reqRows = (await db.query(
    `SELECT r.requested_cents, r.approved_cents, r.inspection_count, ji.sow_line_key, ji.name
       FROM sitewire_draw_requests r LEFT JOIN sitewire_job_item_links ji ON ji.sitewire_job_item_id=r.sitewire_job_item_id AND ji.application_id=$2
      WHERE r.sitewire_draw_id=$1`, [drawId, appId])).rows;
  const reqByLine = {};
  for (const r of reqRows) { const k = r.sow_line_key || r.name; const x = reqByLine[k] || { req: 0, appr: 0 }; x.req += Number(r.requested_cents) || 0; x.appr += Number(r.approved_cents) || 0; reqByLine[k] = x; }
  const findings = (await db.query(
    `SELECT fl.name, fl.sitewire_request_id, fl.sow_line_key, fl.requested_cents, fl.approved_cents, fl.not_approved_cents, fl.photo_count, fl.video_count, fl.inspector_comments
       FROM draw_finding_lines fl JOIN draw_findings f ON f.id=fl.finding_id
      WHERE f.sitewire_draw_id=$1 AND f.application_id=$2 AND fl.retired_at IS NULL ORDER BY fl.id`, [drawId, appId])).rows;
  const findingRow = (await db.query(`SELECT status FROM draw_findings WHERE sitewire_draw_id=$1 AND application_id=$2 ORDER BY delivered_at DESC NULLS LAST LIMIT 1`, [drawId, appId])).rows[0] || null;
  const ledgerRow = (await db.query(
    `SELECT fee_cents, retainage_held_cents, net_release_cents, funded_status FROM draw_disbursements
      WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='draw' ORDER BY created_at DESC LIMIT 1`, [appId, drawId])).rows[0] || null;
  // The file's standard per-draw fee, resolved the same way the Start-draw screen resolves it, so
  // the packet quotes the fee that will actually be charged even before the release is recorded.
  const feeInfo = await rollupMod.projectedFee(db, appId).catch(() => null);
  const waivers = (await db.query(`SELECT tier, party_name, kind, scope, amount_cents, status FROM draw_lien_waivers WHERE sitewire_draw_id=$1 ORDER BY id`, [drawId])).rows;

  // THE APPROVAL LADDER + the committed-money view (owner-directed 2026-08-03). Two things were
  // wrong in this workbook and both came from reading a single field:
  //   • "This draw approved" on the TOTAL row read `sitewire_draws.total_approved_cents`, which
  //     Sitewire only fills on FINAL approval — so the total said $0 under a column of real
  //     per-line approvals.
  //   • "Remaining" was budget − RELEASED, so a $25,000 roof draw the inspector had fully approved
  //     still showed $25,000 remaining on the roof line and the whole $220,000 on the project. The
  //     owner's rule: treat a draw that is not yet fully approved as if it were — it can still be
  //     declined or amended, and then it all goes back to available.
  const money = APPROVAL.drawMoney({
    draw,
    requests: reqRows,
    findingLines: findings,
    feeCents: ledgerRow ? Number(ledgerRow.fee_cents) : (feeInfo ? feeInfo.fee_cents : 0),
    feeRecorded: !!ledgerRow,
    retainageHeldCents: ledgerRow ? Number(ledgerRow.retainage_held_cents) : 0,
    netReleaseCents: ledgerRow ? Number(ledgerRow.net_release_cents) : null,
    released: !!(ledgerRow && ledgerRow.funded_status === 'released'),
    finding: findingRow,
  });
  const avail = (l) => (l.available != null ? l.available : l.remaining);
  const usedPct = (l) => (l.pct_committed != null ? l.pct_committed : l.pct_complete);

  const rows = [];
  rows.push(['DRAW PACKET']);
  rows.push(['Loan', a.ys_loan_number || '', 'Property', a.address || '']);
  rows.push(['Draw #', draw.number ?? '', 'Stage', money.approval_label || draw.status || '', 'Submitted', draw.submitted_at ? String(draw.submitted_at).slice(0, 10) : '', 'Final approved', draw.approved_at ? String(draw.approved_at).slice(0, 10) : 'not yet']);
  rows.push([]);
  rows.push(['SCHEDULE OF VALUES']);
  rows.push(['Line item', 'Budget', 'Released to date', 'This draw requested', 'This draw approved', 'Still available', '% used']);
  for (const l of rollup.lines.filter((x) => x.kind === 'line' || x.kind === 'contingency' || x.kind === 'gc')) {
    const q = reqByLine[l.sow_line_key] || { req: 0, appr: 0 };
    rows.push([l.label, c(l.budgeted), c(l.drawn), c(q.req), c(q.appr), c(avail(l)), usedPct(l)]);
  }
  rows.push(['TOTAL', c(rollup.project.budget), c(rollup.project.drawn), c(money.requested_cents), c(money.approved_cents), c(avail(rollup.project)), usedPct(rollup.project)]);
  rows.push([]);
  rows.push(['\u201CStill available\u201D counts this draw as spent from the moment it is REQUESTED \u2014 the requested amount until the inspector answers, their figure afterwards. If the draw is amended or declined, that money goes straight back to available.']);
  rows.push([]);
  rows.push(['THIS DRAW \u2014 WHAT IS RELEASED, AND WHAT IS NETTED OUT']);
  rows.push(['Requested by the borrower', c(money.requested_cents)]);
  rows.push(['Approved by the inspector', c(money.inspector_approved_cents)]);
  rows.push(['Not approved (stays in the budget)', c(money.not_approved_cents)]);
  rows.push(['Final approved by us', money.final_approved_cents > 0 ? c(money.final_approved_cents) : 'not yet']);
  rows.push([money.fee_projected ? 'Less: draw processing fee (standard for this file)' : 'Less: draw processing fee', -c(money.fee_cents)]);
  if (money.retainage_held_cents > 0) rows.push(['Less: retainage held', -c(money.retainage_held_cents)]);
  rows.push(['NET RELEASE to the borrower', c(money.net_release_cents)]);
  if (rollup.fees) {
    rows.push([]);
    rows.push(['OUR FEES ON THIS PROJECT']);
    rows.push(['Fee per draw', rollup.fees.per_draw_cents != null ? c(rollup.fees.per_draw_cents) : '', rollup.fees.fee_kind ? rollup.fees.fee_kind + ' inspection' : '', rollup.fees.overridden ? 'custom fee for this file' : '']);
    rows.push(['Charged so far (recorded releases)', c(rollup.fees.charged_cents)]);
    rows.push(['Expected on draws not yet released', c(rollup.fees.projected_cents)]);
    rows.push(['Total for this project', c(rollup.fees.total_cents)]);
  }
  if (findings.length) {
    rows.push([]); rows.push(['INSPECTION FINDINGS']);
    rows.push(['Line item', 'Requested', 'Approved by inspector', 'Not approved', 'Photos', 'Videos', 'Inspector note']);
    // A NULL approved amount is "the inspector has not answered this line" (db/518) — the cell is
    // left BLANK, never 0.00, which an accountant reads as a denied line.
    for (const f of findings) rows.push([f.name || '', c(f.requested_cents), f.approved_cents == null ? '' : c(f.approved_cents), f.not_approved_cents == null ? '' : c(f.not_approved_cents), Number(f.photo_count) || 0, Number(f.video_count) || 0, f.inspector_comments || '']);
  }
  if (waivers.length) {
    rows.push([]); rows.push(['LIEN WAIVERS']);
    rows.push(['Tier', 'Party', 'Type', 'Scope', 'Amount', 'Status']);
    for (const w of waivers) rows.push([w.tier, w.party_name || '', w.kind, w.scope, c(w.amount_cents), w.status]);
  }

  // SUPPORTING DOCUMENTS ON THIS DRAW — the invoices, receipts and photos a human filed, usually
  // as the proof behind an override (owner-directed 2026-08-09). Listed, not embedded: the packet
  // is a spreadsheet and the bytes travel with the investor email and the branded report. Every
  // one is named with what it backs up, so the row explains itself. Guarded so an older database
  // without the table simply produces no section.
  try {
    const atts = (await db.query(
      `SELECT da.category, da.note, da.supports, da.uploaded_by_kind, da.created_at,
              d.filename, d.review_status
         FROM draw_attachments da JOIN documents d ON d.id = da.document_id
        WHERE da.application_id=$1 AND da.sitewire_draw_id=$2 AND d.is_current
        ORDER BY da.created_at ASC, da.id ASC`, [appId, drawId])).rows;
    if (atts.length) {
      const CAT = require('./draw-attachments').CATEGORY_LABEL;
      rows.push([]); rows.push(['SUPPORTING DOCUMENTS']);
      rows.push(['Type', 'File', 'Supports', 'Note', 'Added by', 'Added', 'Review']);
      for (const a of atts) {
        rows.push([CAT[a.category] || 'Supporting document', a.filename || '', a.supports || '', a.note || '',
          a.uploaded_by_kind === 'borrower' ? 'Borrower' : 'Our team',
          a.created_at ? String(new Date(a.created_at).toISOString()).slice(0, 10) : '',
          a.review_status === 'accepted' ? 'Accepted' : 'Awaiting review']);
      }
    }
  } catch (_) { /* the packet is still complete without this section */
  }
  return rows;
}

// ---------------------------------------------------------------------------
// FILE THE PACKET EXCEL AS A MIRRORED DOCUMENT (owner-directed 2026-08-06).
// The packet was only ever streamed on download (routes/sitewire.js), never
// persisted — so it never reached SharePoint. The owner wants every draw's
// documents in per-draw folders "beside the Excel sheets of the draw packet",
// so the packet is now filed as a `documents` row. It categorizes to
// Draws/Draw N (the anchor) via sharepoint-backup.drawFolderPathFor, and the
// SharePoint mirror carries it there like any other staff document.
//
// Born ACCEPTED + staff_only + system (same treatment as the branded draw
// reports — a PILOT-generated artifact from data we already hold, not a human
// upload awaiting review; see draw-report.storeDrawReport + document-acceptance).
// Idempotent by a content-hashed filename with the 23505 backstop, and it
// supersedes the prior current packet of the SAME draw (identity prefix) so a
// refreshed packet never churns Version-N folders (draw_packet is a regen kind).
const crypto = require('crypto');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function storeDrawPacketDoc(appId, sitewireDrawId) {
  const { buildXlsx } = require('../lib/xlsx');
  const storage = require('../lib/storage');
  const meta = (await db.query(
    `SELECT d.number, a.ys_loan_number, a.borrower_id
       FROM sitewire_draws d JOIN applications a ON a.id = d.application_id
      WHERE d.sitewire_draw_id = $1 AND d.application_id = $2`, [sitewireDrawId, appId])).rows[0];
  if (!meta) return null;
  const num = meta.number != null ? meta.number : String(sitewireDrawId).slice(0, 8);
  const rows = await buildDrawPacket(appId, sitewireDrawId);
  const bytes = Buffer.from(buildXlsx(rows, `Draw ${num}`));
  const version = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 12);
  const loanSlug = String(meta.ys_loan_number || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'file';
  const filename = `pilot-draw-${num}-packet-${loanSlug}-${version}.xlsx`;

  const existing = await db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND doc_kind='draw_packet' AND filename=$2 LIMIT 1`, [appId, filename]);
  if (existing.rows.length) return existing.rows[0].id;
  const saved = await storage.save(bytes, { filename, contentType: XLSX_MIME });
  try {
    const ins = await db.query(
      `INSERT INTO documents
         (application_id, borrower_id, filename, content_type, size_bytes,
          storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind,
          source_type, visibility, is_current, review_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'staff',NULL,'draw_packet','system','staff_only',true,'accepted')
       RETURNING id`,
      [appId, meta.borrower_id || null, filename, XLSX_MIME, bytes.length, saved.provider, saved.ref]);
    // Supersede only the prior current packet of THIS draw (identity prefix = the
    // filename minus the -<12hex>.xlsx version), never another draw's packet.
    const identityPrefix = filename.replace(/-[0-9a-f]{12}\.xlsx$/i, '-');
    await db.query(
      `UPDATE documents SET is_current=false,
          review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE application_id=$1 AND doc_kind='draw_packet' AND filename LIKE $2 || '%' AND id<>$3 AND is_current=true`,
      [appId, identityPrefix, ins.rows[0].id]);
    return ins.rows[0].id;
  } catch (e) {
    if (e && e.code === '23505') {
      const again = await db.query(
        `SELECT id FROM documents WHERE application_id=$1 AND doc_kind='draw_packet' AND filename=$2 LIMIT 1`, [appId, filename]);
      if (again.rows.length) return again.rows[0].id;
    }
    throw e;
  }
}

// Boot backfill: file a packet for every draw that doesn't already carry one, so
// PREVIOUS draws get their packet in SharePoint (and any new draw is picked up on
// the next boot). Bounded + best-effort — a single draw's failure never stops the
// pass, and it never throws to the caller. Off-switch: DRAW_PACKET_BACKFILL_DISABLED=1.
async function backfillDrawPacketsOnce(limit = 50) {
  if (process.env.DRAW_PACKET_BACKFILL_DISABLED === '1') return { filed: 0, skipped: 0 };
  let filed = 0, skipped = 0;
  try {
    const due = (await db.query(
      `SELECT d.application_id, d.sitewire_draw_id
         FROM sitewire_draws d
        WHERE NOT EXISTS (
          SELECT 1 FROM documents doc
           WHERE doc.application_id = d.application_id AND doc.doc_kind = 'draw_packet'
             AND doc.is_current = true
             AND doc.filename LIKE 'pilot-draw-' || COALESCE(d.number::text, substr(d.sitewire_draw_id::text, 1, 8)) || '-packet-%')
        ORDER BY d.sitewire_draw_id
        LIMIT $1`, [limit])).rows;
    for (const r of due) {
      try { if (await storeDrawPacketDoc(r.application_id, r.sitewire_draw_id)) filed++; else skipped++; }
      catch (e) { skipped++; console.warn(`[draw-packet] backfill failed (draw=${r.sitewire_draw_id}): ${e && e.message}`); }
    }
  } catch (e) { console.warn(`[draw-packet] backfill query failed: ${e && e.message}`); }
  return { filed, skipped };
}

module.exports = { buildDrawPacket, storeDrawPacketDoc, backfillDrawPacketsOnce };

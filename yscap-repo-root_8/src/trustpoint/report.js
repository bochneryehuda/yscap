'use strict';
/**
 * PILOT-branded report for a TrustPoint-administered draw (phase 3 — blueprint §6).
 * Built with pdf-lib (already a dependency) from the MIRRORED aggregates + the per-line
 * amounts when they exist (derived/manual). Two modes:
 *   staff    — everything: per-line table, fees, retainage, contingency, rates, net.
 *   borrower — borrower-safe: requested vs approved (+ per-line when known) and the NET
 *              figure only; no fee breakdown, no platform/partner names anywhere
 *              (belt-and-suspenders: every string runs through borrower-safe.scrubText).
 * Stored as a documents row (doc_kind 'draw_report', source 'system'), idempotent per
 * draw+mode+content-version; an unchanged draw reuses the stored row.
 */

const crypto = require('crypto');
const db = require('../db');
const borrowerSafe = require('../lib/borrower-safe');

const usd = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function buildPdf({ mode, addr, loanNumber, draw, lines, photos }) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const scrub = (s) => (mode === 'borrower' ? borrowerSafe.scrubText(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const doc = await PDFDocument.create();
  let page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.078, 0.106, 0.133), gold = rgb(0.682, 0.529, 0.275), muted = rgb(0.294, 0.345, 0.361);
  let y = 742;
  const line = (txt, { f = font, size = 10, color = ink, x = 48 } = {}) => {
    if (y < 60) { page = doc.addPage([612, 792]); y = 742; }
    page.drawText(String(txt).slice(0, 110), { x, y, size, font: f, color });
    y -= size + 7;
  };
  // header — PILOT identity (text lockup; the email PNG isn't embeddable offline)
  line('PILOT', { f: bold, size: 20, color: gold });
  line('by YS Capital — Construction draw report', { size: 10, color: muted });
  y -= 6;
  line(scrub(addr || 'Property'), { f: bold, size: 13 });
  const meta = [
    loanNumber ? `Loan ${loanNumber}` : null,
    `Draw #${draw.number == null ? '—' : draw.number}`,
    draw.submitted_at ? `Submitted ${String(draw.submitted_at).slice(0, 10)}` : null,
    draw.approved_at ? `Approved ${String(draw.approved_at).slice(0, 10)}` : null,
  ].filter(Boolean).join('  ·  ');
  line(meta, { size: 9, color: muted });
  y -= 8;

  line('Amounts', { f: bold, size: 11, color: gold });
  line(`Requested: ${usd(draw.requested_cents)}    Approved: ${usd(draw.approved_cents)}${draw.to_disburse_cents != null ? `    Net to release: ${usd(draw.to_disburse_cents)}` : ''}`, { size: 10 });
  if (mode === 'staff') {
    const fees = Array.isArray(draw.fees) ? draw.fees : [];
    if (fees.length) line(`Fees: ${fees.map((f) => `${f.name || 'fee'} ${usd(Math.round(Number(f.amount || 0) * 100))}`).join(' · ')}`, { size: 9, color: muted });
    const ret = draw.retainage || {};
    if (ret.approved_amount_holdback != null || ret.requested_amount_holdback != null) {
      line(`Retainage holdback: requested ${ret.requested_amount_holdback != null ? usd(Math.round(Number(ret.requested_amount_holdback) * 100)) : '—'} · approved ${ret.approved_amount_holdback != null ? usd(Math.round(Number(ret.approved_amount_holdback) * 100)) : '—'}`, { size: 9, color: muted });
    }
    const con = draw.contingency || {};
    if (con.total != null) line(`Contingency: ${con.used != null ? usd(Math.round(Number(con.used) * 100)) : '—'} used of ${usd(Math.round(Number(con.total) * 100))}`, { size: 9, color: muted });
    if (draw.inspector_allowance_rate != null) line(`Inspection progress: ${Math.round(Number(draw.inspector_allowance_rate) <= 1 ? Number(draw.inspector_allowance_rate) * 100 : Number(draw.inspector_allowance_rate))}% overall`, { size: 9, color: muted });
  }
  y -= 8;

  if (lines && lines.length) {
    line('Line-by-line approved amounts', { f: bold, size: 11, color: gold });
    for (const l of lines) line(`${scrub(l.name || l.sow_line_key || 'Budget line')}  —  ${usd(l.approved_cents)}${mode === 'staff' && l.source ? `  (${l.source})` : ''}`, { size: 9.5 });
  } else {
    line('Line-by-line breakdown', { f: bold, size: 11, color: gold });
    line('The line-by-line split for this draw is not on file yet — the amounts above are the draw totals.', { size: 9, color: muted });
  }
  y -= 10;

  // ---- THE INSPECTOR'S PHOTOS (owner-directed 2026-07-27: "all the pictures should also be put
  // into our designed PDF report"). This builder embedded NO images at all, so the photos archived
  // for TrustPoint draws were stored correctly and shown nowhere — the audit's finding. They are
  // all JPEG by construction (documents.extractJpegs copies only DCTDecode streams), which is
  // exactly what pdf-lib's embedJpg takes. A photo that will not decode is SKIPPED, never thrown:
  // this runs inside a report a human is waiting on.
  if (Array.isArray(photos) && photos.length) {
    y -= 4;
    line(`Inspection photos (${photos.length})`, { f: bold, size: 11, color: gold });
    const CW = 158, CH = 118, GAP = 10, X0 = 48, PER_ROW = 3;
    let col = 0, embedded = 0;
    for (const p of photos) {
      if (!p || !p.bytes || !p.bytes.length) continue;
      let img = null;
      try { img = await doc.embedJpg(p.bytes); } catch (_) { continue; }
      if (col === 0) {
        if (y - CH < 56) { page = doc.addPage([612, 792]); y = 742; }
        y -= CH;
      }
      try {
        page.drawImage(img, { x: X0 + col * (CW + GAP), y, width: CW, height: CH });
        embedded++;
      } catch (_) { /* a page-geometry failure must not lose the whole report */ }
      col = (col + 1) % PER_ROW;
      if (col === 0) y -= GAP;
    }
    if (col !== 0) y -= GAP;
    y -= 6;
    if (embedded < photos.length) {
      line(`${photos.length - embedded} further photo(s) are on file in PILOT but could not be embedded here.`, { size: 8, color: muted });
    }
  }

  line(mode === 'borrower'
    ? 'Questions? Reply to any email from your loan team — it reaches everyone working on your file.'
    : 'Administered draw (TrustPoint) — figures mirrored from the administrator; PILOT is the record of delivery.', { size: 8.5, color: muted });
  return Buffer.from(await doc.save());
}

/** Build (or reuse) the stored report document for a draw+mode. Returns { documentId, filename, bytes? }. */
/* ONE BUILD PER REPORT, NEVER N — the same rule as the Sitewire report
   (src/sitewire/draw-report.js), for the same reason: the render is synchronous and
   CPU-bound, so two of them in flight is a web service that has stopped answering.
   Keyed on the loan + draw + mode, which is what decides the output. */
const { singleFlight } = require('../lib/single-flight');
const _tpBuildsInFlight = new Map();

async function buildOrGetReport(appId, tpDrawId, mode = 'staff') {
  const key = `${appId}:${tpDrawId}:${mode === 'borrower' ? 'borrower' : 'staff'}`;
  return singleFlight(_tpBuildsInFlight, key, () => _buildOrGetReport(appId, tpDrawId, mode));
}

async function _buildOrGetReport(appId, tpDrawId, mode = 'staff') {
  if (mode !== 'staff' && mode !== 'borrower') mode = 'staff';
  const draw = (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1 AND application_id=$2`, [tpDrawId, appId])).rows[0];
  if (!draw) { const e = new Error('draw not found'); e.status = 404; throw e; }
  const app = (await db.query(
    `SELECT ys_loan_number, borrower_id, property_address->>'oneLine' AS addr FROM applications WHERE id=$1`, [appId])).rows[0];
  const lines = (await db.query(`SELECT * FROM trustpoint_draw_lines WHERE tp_draw_id=$1 ORDER BY id`, [tpDrawId])).rows;
  // The archived inspector photos for THIS draw, read from PILOT's own storage so the report can
  // never break on one of TrustPoint's expiring links. Best-effort: a storage failure costs the
  // photos, never the report.
  const photos = [];
  try {
    const storage0 = require('../lib/storage');
    const rows = await require('./documents').photosFor(tpDrawId, 60);
    for (const r of rows) {
      try {
        const b = await storage0.read(r.storage_ref);
        if (b && b.length) photos.push({ bytes: b });
      } catch (_) { /* one unreadable photo never costs the rest */ }
    }
  } catch (_) { /* no photos archived yet */ }
  const version = crypto.createHash('sha256').update(JSON.stringify({
    m: mode, a: draw.approved_cents, r: draw.requested_cents, n: draw.to_disburse_cents,
    s: draw.status, l: lines.map((l) => [l.sitewire_job_item_id, l.approved_cents]),
    // a newly archived photo must mint a FRESH report, not reuse the photo-less one
    p: photos.length,
  })).digest('hex').slice(0, 12);
  // The tp_draw_id slice scopes the name (and the supersede LIKE below) to THIS draw —
  // two number-less draws on one file must never supersede each other's reports.
  const drawTag = String(tpDrawId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'x';
  const filename = `draw-${(draw.number != null ? draw.number : 'x')}-${drawTag}-report-${mode}-${version}.pdf`;
  const existing = (await db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND filename=$2 AND is_current`, [appId, filename])).rows[0];
  if (existing) return { documentId: existing.id, filename };

  const bytes = await buildPdf({ mode, addr: app && app.addr, loanNumber: app && app.ys_loan_number, draw: {
    ...draw,
    fees: typeof draw.fees === 'string' ? JSON.parse(draw.fees) : draw.fees,
    retainage: typeof draw.retainage === 'string' ? JSON.parse(draw.retainage) : draw.retainage,
    contingency: typeof draw.contingency === 'string' ? JSON.parse(draw.contingency) : draw.contingency,
  }, lines, photos });
  const storage = require('../lib/storage');
  const saved = await storage.save(bytes, { filename });
  const doc = (await db.query(
    `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
        storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, source_type, visibility, is_current, review_status)
     VALUES ($1,$2,$3,'application/pdf',$4,$5,$6,'staff',NULL,'draw_inspection_report','system',$7,true,'accepted')
     RETURNING id`,
    [appId, app ? app.borrower_id : null, filename, bytes.length, saved.provider, saved.ref,
     mode === 'borrower' ? 'borrower' : 'staff_only'])).rows[0];
  // supersede prior versions of the SAME mode's report for this draw (never the other mode's)
  await db.query(
    `UPDATE documents SET is_current=false
      WHERE application_id=$1 AND id<>$2 AND is_current
        AND filename LIKE $3 AND filename <> $4`,
    [appId, doc.id, `draw-%-${drawTag}-report-${mode}-%`, filename]).catch(() => {});
  return { documentId: doc.id, filename, bytes };
}

module.exports = { buildOrGetReport, _buildPdf: buildPdf };

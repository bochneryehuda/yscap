'use strict';
/**
 * The PILOT report for a Trinity physical inspection.
 *
 * Owner-directed: *"our system needs to be able to convert the Trinity report into our
 * pilot report and bring in the results of the inspection into our system."* So the
 * borrower and the desk read the SAME branded document they already know from a virtual
 * draw — the only difference is that the inspection was physical and Trinity did it.
 *
 * It REUSES the existing branded builder rather than growing a second one:
 * `draw-report.buildDrawReport` and `attachPhotoBytes` are pure, data-driven functions
 * (they take plain objects and return a PDF), so feeding them Trinity's numbers costs
 * nothing and guarantees a Trinity draw and a Sitewire draw can never render as two
 * different-looking documents. Nothing in the Sitewire draw pipeline is modified,
 * called for its side effects, or relied on for state — only those two pure functions
 * are used, exactly as a library.
 *
 * The Trinity PDF itself is archived and filed staff-only (it carries the inspector's
 * own branding); this is the document the borrower sees, once a human delivers it.
 */

const db = require('../db');
const drawReport = require('../sitewire/draw-report');
const storage = require('../lib/storage');

/**
 * Build the report sections from what Trinity told us.
 *
 * `mode` is 'staff' or 'borrower' — the builder itself scrubs capital-partner names out
 * of the borrower copy, which is why the same section data is safe to pass to both.
 */
async function loadSections(appId, orderRowId, mode = 'staff') {
  const o = (await db.query(
    `SELECT * FROM trinity_inspection_orders WHERE id=$1 AND application_id=$2`, [orderRowId, appId])).rows[0];
  if (!o) return null;

  const lineRows = (await db.query(
    `SELECT * FROM trinity_order_lines WHERE trinity_inspection_order_id=$1 ORDER BY id`, [orderRowId])).rows;
  const photos = (await db.query(
    `SELECT id, storage_ref, storage_provider, content_type, file_name, labels
       FROM trinity_order_media
      WHERE trinity_inspection_order_id=$1 AND kind='photo' AND storage_ref IS NOT NULL
      ORDER BY id`, [orderRowId])).rows;

  // Trinity's photos are per ORDER, not per line — their API gives each a label
  // ("Context around file") but no line binding. So they ride on the first line rather
  // than being invented onto lines they may not belong to: a photo attributed to the
  // wrong line is worse than one shown against the draw as a whole.
  const photoObjs = photos.map((p) => ({
    storage_ref: p.storage_ref,
    storage_provider: p.storage_provider,
    display_ref: null,
    compact_ref: null,
    content_type: p.content_type,
    caption: Array.isArray(p.labels) && p.labels.length ? String(p.labels.join(' · ')).slice(0, 120) : '',
  }));

  const lines = lineRows
    // A line with nothing requested and nothing approved is budget context, not part of
    // the draw's story — the full budget picture is the file's own rollup.
    .filter((l) => Number(l.requested_cents || 0) > 0 || Number(l.approved_cents || 0) > 0)
    .map((l, i) => {
      const req = Number(l.requested_cents || 0);
      const app = l.approved_cents == null ? null : Number(l.approved_cents);
      return {
        name: l.name,
        sow_line_key: l.sow_line_key || null,
        unit_index: null,
        inspector_comments: l.inspector_remarks || null,
        requested_cents: req,
        approved_cents: app == null ? 0 : app,
        not_approved_cents: app == null ? 0 : Math.max(0, req - app),
        photos: i === 0 ? photoObjs : [],
      };
    });

  const requested = lines.reduce((s, l) => s + l.requested_cents, 0);
  const approved = o.approved_cents != null ? Number(o.approved_cents) : lines.reduce((s, l) => s + l.approved_cents, 0);

  return {
    order: o,
    sections: [{
      number: null,
      status: o.status,
      requested_cents: requested,
      // The INSPECTOR's figure — what the borrower is being asked to accept. It is
      // deliberately NOT presented as a release: on this program a human still has to
      // deliver it and the borrower still has to accept.
      approved_cents: approved,
      final_approved_cents: 0,
      not_approved_cents: Math.max(0, requested - approved),
      approval_stage: 'inspector_approved',
      approval_label: 'Approved by the Trinity inspector',
      fee_cents: null,
      fee_projected: false,
      retainage_held_cents: 0,
      net_release_cents: null,
      released: false,
      release_date: null,
      lines,
      attachments: [],
    }],
  };
}

/** The file header the branded report prints. */
async function loadApp(appId) {
  const a = (await db.query(
    `SELECT a.ys_loan_number, a.property_address, a.rehab_budget,
            b.first_name, b.last_name
       FROM applications a LEFT JOIN borrowers b ON b.id=a.borrower_id
      WHERE a.id=$1`, [appId])).rows[0] || {};
  const addr = a.property_address || {};
  return {
    loanNo: a.ys_loan_number || '',
    address: addr.oneLine || [addr.street, addr.city, addr.state].filter(Boolean).join(', '),
    borrower: [a.first_name, a.last_name].filter(Boolean).join(' '),
  };
}

/**
 * Build the PILOT report PDF for a Trinity order. Returns a Buffer, or null when the
 * order has nothing to report yet.
 */
async function buildBytes(appId, orderRowId, { mode = 'staff' } = {}) {
  const loaded = await loadSections(appId, orderRowId, mode);
  if (!loaded || !loaded.sections[0].lines.length) return null;
  const app = await loadApp(appId);
  const sections = loaded.sections;
  let omitted = 0;
  try {
    const r = await drawReport.attachPhotoBytes(sections, { rendition: 'display' });
    omitted = (r && r.omitted) || 0;
  } catch (_) { /* a report without photos is still a report */ }
  return drawReport.buildDrawReport({ app, rollup: null, sections, scope: 'draw', mode, photosOmitted: omitted });
}

/**
 * Build the report and file it on the loan. The staff copy and the borrower copy are
 * separate documents with separate visibility, exactly as the Sitewire draw reports are.
 */
async function buildAndStore(appId, orderRowId, { mode = 'staff' } = {}) {
  const bytes = await buildBytes(appId, orderRowId, { mode });
  if (!bytes) return { skipped: 'nothing_to_report' };
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const kind = mode === 'borrower' ? 'trinity_pilot_report_borrower' : 'trinity_pilot_report';

  const existing = (await db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND doc_kind=$2 AND sha256=$3 LIMIT 1`,
    [appId, kind, hash])).rows[0];
  if (existing) return { ok: true, documentId: existing.id, reused: true };

  const saved = await storage.save(bytes, { filename: `pilot-inspection-report-${orderRowId}-${mode}.pdf` });
  // A fresh build supersedes the previous copy OF THE SAME VISIBILITY only — the
  // borrower copy must never supersede the staff one.
  await db.query(
    `UPDATE documents SET is_current=false
      WHERE application_id=$1 AND doc_kind=$2 AND COALESCE(is_current,true)=true`, [appId, kind]).catch(() => {});
  const ins = await db.query(
    `INSERT INTO documents (application_id, filename, content_type, storage_ref, storage_provider,
        doc_kind, source_type, visibility, review_status, sha256, size_bytes, is_current)
     VALUES ($1,$2,'application/pdf',$3,$4,$5,'system',$6,'accepted',$7,$8,true)
     RETURNING id`,
    [appId, `PILOT inspection report.pdf`, saved.ref, saved.provider, kind,
     mode === 'borrower' ? 'borrower' : 'staff_only', hash, bytes.length]);
  return { ok: true, documentId: ins.rows[0].id };
}

module.exports = { buildBytes, buildAndStore, loadSections, loadApp };

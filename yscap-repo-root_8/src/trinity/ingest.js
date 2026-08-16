'use strict';
/**
 * Trinity INGEST — following an order and reading its result.
 *
 * The owner's ask, in order: *"follow up on the status of the inspection, schedule the
 * inspection, complete the inspection, and then get back the PDF Trinity report. Our
 * system needs to understand automatically what the inspector approved. Our system
 * needs to read the notes of the inspector … and get all the photos into our system."*
 *
 * THE ONE THING THIS MODULE DELIBERATELY DOES NOT DO IS DELIVER ANYTHING TO A BORROWER.
 * It reads Trinity, fills in our figures, archives the report and the photos, and stops.
 * A human then presses Deliver on the desk. The Sitewire VIRTUAL autopilot is untouched
 * and stays exactly as it is — it is for virtual inspections only (owner-directed
 * 2026-08-14).
 *
 * Trinity's file URLs are PRE-SIGNED and EXPIRE (~50 minutes, verified), so every byte
 * we are shown is pulled into PILOT's own storage the moment we see it. Nothing here
 * ever stores a Trinity URL and expects it to work later.
 */

const db = require('../db');
const storage = require('../lib/storage');
const client = require('./client');
const mapper = require('./mapper');
// Read-only reuse of the draw stack's hardened downloader: https-only, re-validated on
// every redirect hop, private-IP refused, size-capped, streamed. Duplicating that would
// mean a second SSRF surface to keep correct.
const { fetchBinary } = require('../sitewire/media-archive');

const crypto = require('crypto');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const usd = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A stable identity for a Trinity file, independent of its rotating signed URL. */
function sourceKeyFor(kind, item) {
  if (item && item.id != null) return `${kind}:${item.id}`;
  const u = String((item && item.url) || '');
  const path = u.split('?')[0];
  return `${kind}:${crypto.createHash('sha1').update(path).digest('hex').slice(0, 24)}`;
}

const extFor = (contentType, url) => {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('spreadsheet') || ct.includes('excel')) return 'xlsx';
  const m = String(url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : 'bin';
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
/**
 * Read the order's status from Trinity and move OUR record forward.
 *
 * Never moves backwards (mapper.nextState) — a revision re-opening an order must not
 * un-inspect a file — and a status that says nothing about progress ("Change Date to
 * Inspect") moves nothing.
 */
async function syncStatus(orderRow) {
  const remote = await client.getOrder(orderRow.trinity_order_id);
  if (!remote) return { skipped: 'not_found' };

  const statusId = remote.status && remote.status.id != null ? Number(remote.status.id) : null;
  const read = mapper.readStatus(statusId);
  const next = mapper.nextState(orderRow.status, read.state);
  const changed = next !== orderRow.status
    || String(remote.status && remote.status.name || '') !== String(orderRow.trinity_status || '');

  await db.query(
    `UPDATE trinity_inspection_orders
        SET status = $2,
            trinity_status_id = $3,
            trinity_status = $4,
            trinity_substatus = $5,
            status_changed_at = CASE WHEN $6 THEN now() ELSE status_changed_at END,
            scheduled_at = CASE WHEN $2 = 'scheduled' AND scheduled_at IS NULL THEN now() ELSE scheduled_at END,
            completed_at = COALESCE($7::timestamptz, completed_at),
            polled_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [orderRow.id, next, statusId,
     remote.status && remote.status.name ? String(remote.status.name).slice(0, 120) : null,
     remote.subStatus && remote.subStatus.name ? String(remote.subStatus.name).slice(0, 120) : null,
     changed, remote.completedAt ? new Date(remote.completedAt) : null]);

  // THE TIMELINE. Trinity has no history endpoint — verified 2026-08-16, /history,
  // /events, /statuses and /status all answer 404 — so the sequence the desk shows
  // ("ordered → scheduled → inspected → report back") exists only because we write each
  // transition down as we see it. The unique index drops a repeat, so the poller
  // re-reading the same order every few minutes cannot fill it with copies of one
  // moment; it is appended on EVERY sync rather than only when our own five-state
  // ladder moves, because Trinity's own wording changes far more often than our state
  // does ("Searching for Inspector" → "Accepted by Inspector" → "In Review" are three
  // distinct things a coordinator wants to see, and two of them are the same state).
  await require('./order').recordEvent(orderRow.application_id, orderRow.id, {
    kind: 'status',
    state: next,
    statusId,
    status: remote.status && remote.status.name,
    substatus: remote.subStatus && remote.subStatus.name,
    percentComplete: Number.isFinite(Number(remote.percentComplete)) ? Number(remote.percentComplete) : null,
    source: 'poller',
  }).catch(() => {});

  return {
    ok: true, changed, state: next,
    trinityStatus: remote.status && remote.status.name,
    completed: read.completed, attention: read.attention, cancelled: read.cancelled,
  };
}

// ---------------------------------------------------------------------------
// results — what the inspector approved, per line
// ---------------------------------------------------------------------------
/**
 * Read the completed budget and convert it into per-line approved CENTS.
 *
 * The conversion (percent-complete → cents) is reconciled to Trinity's own total and
 * REFUSES rather than guesses when it cannot be (mapper.readResults). A refusal is
 * recorded as a plain-language blocked_reason for the desk — it never silently writes a
 * number that would change what a borrower is paid.
 */
async function readResults(orderRow) {
  const budget = await client.getBudget(orderRow.trinity_order_id);
  const sent = (await db.query(
    `SELECT customer_key, sitewire_job_item_id, sow_line_key FROM trinity_order_lines
      WHERE trinity_inspection_order_id = $1`, [orderRow.id])).rows;

  const res = mapper.readResults(budget, sent);
  if (!res.ok) {
    await db.query(
      `UPDATE trinity_inspection_orders SET blocked_reason=$2, polled_at=now(), updated_at=now() WHERE id=$1`,
      [orderRow.id, String(res.reason).slice(0, 500)]);
    return res;
  }

  for (const l of res.lines) {
    await db.query(
      `UPDATE trinity_order_lines
          SET completed_pct=$3, approved_cents=$4, inspector_remarks=$5,
              trinity_line_id=COALESCE(trinity_line_id,$6), updated_at=now()
        WHERE trinity_inspection_order_id=$1 AND customer_key=$2`,
      [orderRow.id, l.customer_key, l.completed_pct, l.approved_cents,
       l.inspector_remarks ? String(l.inspector_remarks).slice(0, 2000) : null, l.trinity_line_id]);
    // A line Trinity added on their side (no customerKey of ours) is still recorded, so
    // the desk shows the WHOLE of what the inspector reported, not only our own lines.
    //
    // It must UPSERT, not "do nothing". Trinity re-completes an order for a revision
    // (statuses 72 "Revised" / 83 "Budget Changed" / 223 "Revision Requested"), and the
    // whole point of re-reading is to pick up what changed — a DO NOTHING here meant a
    // revised amount or a corrected remark on one of THEIR lines was silently discarded
    // on every poll after the first.
    if (l.customer_key) continue;
    const synthKey = l.trinity_line_id != null ? `trinity-${l.trinity_line_id}` : null;
    if (!synthKey) continue;   // no stable identity — never guess which row to overwrite
    await db.query(
      `INSERT INTO trinity_order_lines
         (trinity_inspection_order_id, application_id, name, trinity_line_id, budgeted_cents,
          requested_cents, completed_pct, approved_cents, inspector_remarks, customer_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (trinity_inspection_order_id, customer_key) WHERE customer_key IS NOT NULL DO UPDATE
         SET name=EXCLUDED.name, budgeted_cents=EXCLUDED.budgeted_cents,
             requested_cents=EXCLUDED.requested_cents, completed_pct=EXCLUDED.completed_pct,
             approved_cents=EXCLUDED.approved_cents, inspector_remarks=EXCLUDED.inspector_remarks,
             updated_at=now()`,
      [orderRow.id, orderRow.application_id, l.name, l.trinity_line_id, l.budgeted_cents,
       l.requested_cents, l.completed_pct, l.approved_cents,
       l.inspector_remarks ? String(l.inspector_remarks).slice(0, 2000) : null,
       synthKey]).catch(() => {});
  }

  await db.query(
    `UPDATE trinity_inspection_orders
        SET approved_cents=$2, results_read_at=now(), blocked_reason=NULL, polled_at=now(), updated_at=now()
      WHERE id=$1`, [orderRow.id, res.approvedCents]);

  return res;
}

// ---------------------------------------------------------------------------
// the report PDF + the photos — archived into OUR storage
// ---------------------------------------------------------------------------
async function archiveOne(orderRow, kind, item, { filenameHint } = {}) {
  const source_key = sourceKeyFor(kind, item);
  const already = (await db.query(
    `SELECT id, storage_ref FROM trinity_order_media
      WHERE trinity_inspection_order_id=$1 AND source_key=$2`, [orderRow.id, source_key])).rows[0];
  if (already && already.storage_ref) return { skipped: 'already', id: already.id };
  if (!item || !item.url) return { skipped: 'no_url' };

  let buf, contentType;
  try { ({ buf, contentType } = await fetchBinary(item.url)); }
  catch (e) {
    await db.query(
      `INSERT INTO trinity_order_media (trinity_inspection_order_id, application_id, kind, trinity_id, source_key, file_name, skip_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (trinity_inspection_order_id, source_key) DO UPDATE SET skip_reason=EXCLUDED.skip_reason`,
      [orderRow.id, orderRow.application_id, kind, item.id != null ? Number(item.id) : null, source_key,
       item.fileName || null, String(e && e.message).slice(0, 200)]).catch(() => {});
    return { failed: true, message: String(e && e.message).slice(0, 200) };
  }

  const hash = sha256(buf);
  const dup = (await db.query(
    `SELECT id FROM trinity_order_media WHERE trinity_inspection_order_id=$1 AND sha256=$2 AND storage_ref IS NOT NULL`,
    [orderRow.id, hash])).rows[0];
  if (dup) return { skipped: 'duplicate_bytes', id: dup.id };

  const filename = `${filenameHint || `trinity-${kind}`}-${source_key.split(':')[1].slice(0, 12)}.${extFor(contentType, item.url)}`;
  const saved = await storage.save(buf, { filename });
  const ins = await db.query(
    `INSERT INTO trinity_order_media
       (trinity_inspection_order_id, application_id, kind, trinity_id, source_key, file_name,
        content_type, bytes, labels, storage_ref, storage_provider, sha256, archived_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (trinity_inspection_order_id, source_key) DO UPDATE
       SET storage_ref=EXCLUDED.storage_ref, storage_provider=EXCLUDED.storage_provider,
           sha256=EXCLUDED.sha256, bytes=EXCLUDED.bytes, archived_at=now(), skip_reason=NULL
     RETURNING id`,
    [orderRow.id, orderRow.application_id, kind, item.id != null ? Number(item.id) : null, source_key,
     item.fileName || filename, contentType, buf.length,
     Array.isArray(item.labels) ? item.labels.map((x) => String(x).slice(0, 120)) : null,
     saved.ref, saved.provider, hash]);
  return { ok: true, id: ins.rows[0].id, bytes: buf.length };
}

/** The Trinity report PDF — archived and filed on the file as a staff document. */
async function pullReport(orderRow) {
  let doc;
  try { doc = await client.getReport(orderRow.trinity_order_id); }
  catch (e) {
    // 404 with "The report for this order is not ready." is a clean NOT-YET, verified —
    // never an error, never a reason to flag anything.
    if (e && e.status === 404) return { skipped: 'not_ready' };
    throw e;
  }
  if (!doc || !doc.url) return { skipped: 'not_ready' };

  const archived = await archiveOne(orderRow, 'report', doc, { filenameHint: 'trinity-inspection-report' });
  if (!archived.ok && !archived.skipped) return archived;

  const media = (await db.query(
    `SELECT * FROM trinity_order_media WHERE trinity_inspection_order_id=$1 AND kind='report' AND storage_ref IS NOT NULL
      ORDER BY archived_at DESC NULLS LAST LIMIT 1`, [orderRow.id])).rows[0];
  if (!media) return { skipped: 'not_stored' };

  // File it on the loan as a STAFF document. It is the inspector's own paperwork and
  // may carry their branding, so it is never borrower-facing by default — the borrower
  // receives our own report, once a human delivers it.
  const existing = (await db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND doc_kind='trinity_inspection_report' AND sha256=$2 LIMIT 1`,
    [orderRow.application_id, media.sha256])).rows[0];
  let documentId = existing ? existing.id : null;
  if (!documentId) {
    const ins = await db.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, storage_provider,
          doc_kind, source_type, visibility, review_status, sha256, size_bytes, is_current)
       VALUES ($1,$2,$3,$4,$5,'trinity_inspection_report','system','staff_only','accepted',$6,$7,true)
       RETURNING id`,
      [orderRow.application_id, media.file_name || 'trinity-inspection-report.pdf',
       media.content_type || 'application/pdf', media.storage_ref, media.storage_provider,
       media.sha256, media.bytes]);
    documentId = ins.rows[0].id;
  }
  await db.query(
    `UPDATE trinity_inspection_orders SET report_document_id=COALESCE(report_document_id,$2::uuid), updated_at=now() WHERE id=$1`,
    [orderRow.id, documentId]).catch(() => {});
  return { ok: true, documentId };
}

/**
 * The INVOICE for a completed order — what this inspection cost us.
 *
 * docs/TRINITY-INSPECTION-API-RESEARCH.md §9.2 recorded as an open question that
 * "nothing in the API returns our cost, so the draw fee stays PILOT's own figure". That
 * is answered: `GET /orders/{id}/documents/invoice` returns it once the order completes,
 * and answers a clean 404 ("The invoice for this order is not ready.") before then —
 * the same unambiguous not-yet as the report, so it is never treated as a failure.
 *
 * Filed STAFF-ONLY, always. What we pay an inspector is our own cost of doing business:
 * it is not part of the borrower's draw and must never ride along to them.
 */
async function pullInvoice(orderRow) {
  let doc;
  try { doc = await client.getInvoice(orderRow.trinity_order_id); }
  catch (e) {
    if (e && e.status === 404) return { skipped: 'not_ready' };
    throw e;
  }
  if (!doc || !doc.url) return { skipped: 'not_ready' };

  const archived = await archiveOne(orderRow, 'invoice', doc, { filenameHint: 'trinity-invoice' });
  if (!archived.ok && !archived.skipped) return archived;

  const media = (await db.query(
    `SELECT * FROM trinity_order_media WHERE trinity_inspection_order_id=$1 AND kind='invoice' AND storage_ref IS NOT NULL
      ORDER BY archived_at DESC NULLS LAST LIMIT 1`, [orderRow.id])).rows[0];
  if (!media) return { skipped: 'not_stored' };

  const existing = (await db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND doc_kind='trinity_inspection_invoice' AND sha256=$2 LIMIT 1`,
    [orderRow.application_id, media.sha256])).rows[0];
  let documentId = existing ? existing.id : null;
  if (!documentId) {
    const ins = await db.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, storage_provider,
          doc_kind, source_type, visibility, review_status, sha256, size_bytes, is_current)
       VALUES ($1,$2,$3,$4,$5,'trinity_inspection_invoice','system','staff_only','accepted',$6,$7,true)
       RETURNING id`,
      [orderRow.application_id, media.file_name || 'trinity-inspection-invoice.pdf',
       media.content_type || 'application/pdf', media.storage_ref, media.storage_provider,
       media.sha256, media.bytes]);
    documentId = ins.rows[0].id;
  }
  await db.query(
    `UPDATE trinity_inspection_orders
        SET invoice_document_id=COALESCE(invoice_document_id,$2::uuid), invoice_read_at=now(), updated_at=now()
      WHERE id=$1`, [orderRow.id, documentId]).catch(() => {});
  return { ok: true, documentId };
}

/** Every inspection photo, archived. */
async function pullPhotos(orderRow) {
  const photos = await client.getPhotos(orderRow.trinity_order_id);
  if (!Array.isArray(photos) || !photos.length) return { archived: 0 };
  let archived = 0, failed = 0, skipped = 0;
  for (const p of photos) {
    const r = await archiveOne(orderRow, 'photo', p, { filenameHint: 'trinity-photo' }).catch(() => ({ failed: true }));
    if (r.ok) archived++; else if (r.failed) failed++; else skipped++;
  }
  return { archived, failed, skipped, total: photos.length };
}

// ---------------------------------------------------------------------------
// inbound messages
// ---------------------------------------------------------------------------
/** Mirror Trinity's comments into our thread so the desk sees both sides. */
async function pullComments(orderRow) {
  const rows = await client.getComments(orderRow.trinity_order_id);
  if (!Array.isArray(rows) || !rows.length) return { added: 0 };
  const mine = new Set((await db.query(
    `SELECT trinity_comment_id FROM trinity_order_comments
      WHERE trinity_inspection_order_id=$1 AND trinity_comment_id IS NOT NULL`, [orderRow.id]))
    .rows.map((r) => Number(r.trinity_comment_id)));
  let added = 0;
  for (const c of rows) {
    const id = c && c.id != null ? Number(c.id) : null;
    if (!id || mine.has(id)) continue;
    const who = c.commenter || {};
    const ins = await db.query(
      `INSERT INTO trinity_order_comments
         (trinity_inspection_order_id, application_id, trinity_comment_id, direction, content,
          important, visible_to_vendor, author_name, trinity_created_at)
       VALUES ($1,$2,$3,'in',$4,$5,$6,$7,$8)
       ON CONFLICT (trinity_comment_id) WHERE trinity_comment_id IS NOT NULL DO NOTHING RETURNING id`,
      [orderRow.id, orderRow.application_id, id, String(c.content || '').slice(0, 4000),
       !!c.important, c.visibleToVendor !== false,
       [who.firstName, who.lastName].filter(Boolean).join(' ') || 'Trinity',
       c.createdAt ? new Date(c.createdAt) : null]).catch(() => ({ rows: [] }));
    if (ins.rows && ins.rows.length) added++;
  }
  return { added };
}

// ---------------------------------------------------------------------------
// the one entry point
// ---------------------------------------------------------------------------
/**
 * Bring one order fully up to date: status, then — once the report exists — the PDF,
 * the per-line numbers, the photos, and the messages. Every step is independently
 * caught so one failure never stops the others, and NOTHING here notifies a borrower.
 */
async function syncOrder(appId, orderRowId) {
  const o = (await db.query(
    `SELECT * FROM trinity_inspection_orders WHERE id=$1${appId ? ' AND application_id=$2' : ''}`,
    appId ? [orderRowId, appId] : [orderRowId])).rows[0];
  if (!o) return { skipped: 'not_found' };
  if (!o.trinity_order_id) return { skipped: 'not_ordered' };
  if (!client.available() || !client.enabled()) return { skipped: 'off' };

  const out = { orderId: orderRowId, trinityOrderId: Number(o.trinity_order_id) };
  try { out.status = await syncStatus(o); }
  catch (e) { out.status = { error: String(e && e.message).slice(0, 200) }; }

  try { out.comments = await pullComments(o); }
  catch (e) { out.comments = { error: String(e && e.message).slice(0, 200) }; }

  const fresh = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [orderRowId])).rows[0];
  const completed = out.status && out.status.completed;

  if (completed) {
    try { out.report = await pullReport(fresh); }
    catch (e) { out.report = { error: String(e && e.message).slice(0, 200) }; }
    try { out.results = await readResults(fresh); }
    catch (e) { out.results = { error: String(e && e.message).slice(0, 200) }; }
    try { out.photos = await pullPhotos(fresh); }
    catch (e) { out.photos = { error: String(e && e.message).slice(0, 200) }; }
    // What the inspection cost us. Staff-only, and never a reason to fail the sync —
    // a missing invoice must not hold up the numbers the desk is waiting for.
    if (!fresh.invoice_read_at) {
      try { out.invoice = await pullInvoice(fresh); }
      catch (e) { out.invoice = { error: String(e && e.message).slice(0, 200) }; }
    }

    // Tell the DESK, not the borrower. This is the hand-off the owner described: the
    // figures are in, and a human decides what goes out.
    if (out.results && out.results.ok && !fresh.notified_ready_at) await notifyDeskReady(fresh, out.results).catch(() => {});
  }
  return out;
}

/** The coordinator's cue that a Trinity report has landed and is ready to review. */
async function notifyDeskReady(orderRow, results) {
  const notify = require('../lib/notify');
  const claimed = (await db.query(
    `UPDATE trinity_inspection_orders SET notified_ready_at=now(), updated_at=now()
      WHERE id=$1 AND notified_ready_at IS NULL RETURNING id`, [orderRow.id])).rows[0];
  if (!claimed) return { skipped: 'already' };
  const addr = (await db.query(
    `SELECT property_address->>'oneLine' AS addr FROM applications WHERE id=$1`, [orderRow.application_id])).rows[0] || {};
  await notify.notifyAppStaff(orderRow.application_id, {
    type: 'draw',
    title: 'The Trinity inspection report is in — review and deliver',
    badge: { text: 'Review the findings', tone: 'gold' },
    body: `Trinity completed the physical inspection on ${addr.addr || 'this property'} and approved ${usd(results.approvedCents)}. `
      + 'The report, the photos and the line-by-line numbers are on the draw desk. '
      + 'Check them, then deliver the findings to the borrower when you are ready — nothing has been sent to them yet.',
    applicationId: orderRow.application_id,
    link: `/internal/app/${orderRow.application_id}/draws`,
    ctaLabel: 'Open the draw desk',
    inAppOnly: false,
  });
  return { ok: true };
}

module.exports = {
  syncOrder, syncStatus, readResults, pullReport, pullInvoice, pullPhotos, pullComments,
  archiveOne, notifyDeskReady, _internals: { sourceKeyFor, extFor },
};

'use strict';
/**
 * Richer Value — THE SCOPE OF WORK: attached to every order, and re-sent when ours
 * changes.
 *
 * TWO OWNER RULES, one module:
 *
 *   1. *"Auto-attach the scope of work"* (2026-08-14). Every Hybrid order carries
 *      the file's scope of work as a real attachment. This is not a nicety —
 *      MEASURED against their training tenant on 2026-08-14, an order placed WITH
 *      a scope-of-work file came back **"Ordered"** while the identical order
 *      without one came back **"On Hold"**. Attaching it is the difference between
 *      an appraiser starting work today and a file sitting in their queue.
 *
 *   2. *"We also need to set up a workflow where updated scopes of work can be sent
 *      for revisions. Also, during the order, we should be able to update the scope
 *      of work in their system if the scope of work updates in our system."*
 *      (2026-08-14). So when OUR scope of work changes on a file with a live order,
 *      the new one goes over to them — and, when the appraiser has already worked
 *      from the old one, the order is REOPENED with the new budget so the ARV is
 *      re-done against what is actually being built.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH DOCUMENT IS "THE SCOPE OF WORK", AND WHY IT IS NOT A GUESS
 * ─────────────────────────────────────────────────────────────────────────────
 * The SOW tool writes its branded PDF + Excel as `doc_kind='rehab_budget_export'`
 * on the scope-of-work condition, and a re-submit SUPERSEDES the prior set — so
 * `is_current = true` is what "the scope of work as it stands today" means, and it
 * is the same definition the investor TPR package uses (`tpr-export.selectSowExports`).
 * Reading it any other way would let PILOT send an investor one scope of work and
 * an appraiser another.
 *
 * The PDF is preferred over the Excel deliberately: an appraiser opens it on a
 * phone at a property. The HTML snapshot is never sent (it is a tool artifact, and
 * the TPR package leaves it out for the same reason). A file with no export yet
 * falls back to whatever a human attached to the scope-of-work condition — a
 * borrower's own contractor bid is still a scope of work, and sending it is far
 * better than an order going On Hold for want of one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REVISION IS DECIDED BY THE ORDER'S OWN STATE, NEVER BY A CLOCK
 * ─────────────────────────────────────────────────────────────────────────────
 * `revisionPlanFor` reads what the order is DOING and picks the gentlest action
 * that actually reaches the appraiser:
 *
 *   • not started yet (intake / ordered / on hold)  → UPDATE the order's budget +
 *     re-upload the file. Nothing has been valued off the old scope, so there is
 *     nothing to redo.
 *   • in progress (inspected / in review)           → UPLOAD the new file and note
 *     the change, so the appraiser working on it right now sees it.
 *   • finished (completed / delivered)              → REOPEN with the new budget.
 *     Their `reopen` takes a `new-budget` reason precisely for this. A finished
 *     report valued against a scope of work nobody is building any more is worse
 *     than no report.
 *   • cancelled / rejected / dryrun                 → nothing. There is no order.
 *
 * NOTHING HERE EVER RE-ORDERS. A reopen is their own revision of an order already
 * paid for; minting a second order because a line item moved would spend money
 * nobody authorised.
 */

const client = require('./client');
const storage = require('../lib/storage');

/** The kinds their upload endpoint takes for a scope of work, best first. */
const PREFERRED = [/\.pdf$/i, /\.xlsx?$/i];

/** How big a file we will read into memory to send. Their intake takes multipart;
 *  a scope of work is a handful of pages, so anything enormous is a wrong file. */
const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Find the file's CURRENT scope of work, without reading its bytes.
 *
 * Returns `{present, documentId, filename, contentType, sha256, source, why}` —
 * `source` is `'tool_export'` (the SOW tool's own PDF/Excel) or `'condition'` (a
 * document a human put on the scope-of-work condition). Never throws.
 */
async function findScopeOfWork(db, appId) {
  const none = (why) => ({ present: false, why });
  try {
    // 1. the tool's own current export — the same definition the TPR package uses.
    const exports_ = await db.query(
      `SELECT d.id, d.filename, d.content_type, d.sha256, d.size_bytes, d.storage_ref, d.storage_provider
         FROM documents d
        WHERE d.application_id=$1 AND d.doc_kind='rehab_budget_export' AND d.is_current=true
          AND COALESCE(d.review_status,'') <> 'rejected'
          AND COALESCE(d.source_type,'') <> 'chat_attachment'
        ORDER BY d.created_at DESC`, [appId]);
    const pick = choose(exports_.rows);
    if (pick) return { present: true, source: 'tool_export', ...describe(pick) };

    // 2. anything a human filed on the scope-of-work condition itself.
    const onCondition = await db.query(
      `SELECT d.id, d.filename, d.content_type, d.sha256, d.size_bytes, d.storage_ref, d.storage_provider
         FROM documents d
         JOIN checklist_items ci ON ci.id = d.checklist_item_id
        WHERE d.application_id=$1 AND d.is_current=true
          AND COALESCE(ci.tool_key,'') = 'rehab_budget'
          AND COALESCE(d.review_status,'') <> 'rejected'
          AND COALESCE(d.source_type,'') <> 'chat_attachment'
        ORDER BY d.created_at DESC`, [appId]);
    const human = choose(onCondition.rows);
    if (human) return { present: true, source: 'condition', ...describe(human) };

    return none('There is no scope of work on this file yet. Richer Value usually puts an order with no scope of work On Hold, so it is worth adding one first.');
  } catch (e) {
    return none(`PILOT could not look up the scope of work (${e.message}).`);
  }
}

/** PDF first, then a spreadsheet, then whatever there is — never the HTML snapshot. */
function choose(rows) {
  const usable = (rows || []).filter((r) => r && r.storage_ref
    && !/\.html?$/i.test(r.filename || '')
    && !String(r.content_type || '').toLowerCase().includes('html')
    && !(r.size_bytes > MAX_BYTES));
  for (const re of PREFERRED) {
    const hit = usable.find((r) => re.test(r.filename || ''));
    if (hit) return hit;
  }
  return usable[0] || null;
}

function describe(row) {
  return {
    documentId: row.id,
    filename: row.filename || 'scope-of-work.pdf',
    contentType: row.content_type || 'application/pdf',
    sha256: row.sha256 || null,
    sizeBytes: row.size_bytes || null,
  };
}

/**
 * Read the bytes so the order can carry them. Split from `findScopeOfWork` on
 * purpose: the PREVIEW wants to SAY there is a scope of work without paying to
 * read it, and only the order itself needs the file.
 *
 * Returns `{ok, file:{filename, contentType, bytes}}` or `{ok:false, error}`.
 */
async function readScopeOfWork(db, appId, found = null) {
  const sow = found || await findScopeOfWork(db, appId);
  if (!sow.present) return { ok: false, error: sow.why };
  try {
    const r = await db.query(
      `SELECT storage_ref, storage_provider FROM documents WHERE id=$1`, [sow.documentId]);
    const row = r.rows[0];
    if (!row || !row.storage_ref) return { ok: false, error: 'The scope of work is on the file but its copy could not be found.' };
    // Read through the document's OWN provider — the one definition of which
    // store holds a given document, so a not-yet-migrated local copy is read off
    // disk instead of missing in S3.
    const bytes = await storage.forRow(row).read(row.storage_ref);
    if (!bytes || !bytes.length) return { ok: false, error: 'The scope of work read back empty.' };
    if (bytes.length > MAX_BYTES) return { ok: false, error: 'The scope of work is too big to send with an order.' };
    return { ok: true, file: { filename: sow.filename, contentType: sow.contentType, bytes }, sow };
  } catch (e) {
    return { ok: false, error: `The scope of work could not be read (${e.message}).` };
  }
}

// ---------------------------------------------------------------------------
// THE REVISION.
// ---------------------------------------------------------------------------

/** Their statuses, grouped by what a revision has to DO about them. */
const NOT_STARTED = new Set(['intake', 'placing', 'ordered', 'on_hold', 'assigned', 'scheduled']);
const IN_PROGRESS = new Set(['inspected', 'in_review', 'in_progress', 'quality_review']);
const FINISHED = new Set(['completed', 'delivered', 'report_ready']);
const DEAD = new Set(['cancelled', 'rejected', 'dryrun', 'error', 'draft']);

/**
 * What to do with ONE order when our scope of work has changed. PURE — it reads a
 * row, decides, and touches nothing, so the screen can say what will happen before
 * anybody presses a button.
 *
 * @returns {{action:'update'|'upload'|'reopen'|'none', why:string, reopenReason?:string}}
 */
function revisionPlanFor(order) {
  const status = String((order && order.status) || '').toLowerCase();
  if (!order || !order.intake_token || order.dryrun || DEAD.has(status)) {
    return { action: 'none', why: 'There is no live Richer Value order on this file to update.' };
  }
  if (FINISHED.has(status)) {
    return {
      action: 'reopen',
      reopenReason: 'new-budget',
      why: 'The report is already finished, so Richer Value is asked to REOPEN it with the new scope of work — '
        + 'the after-repair value was worked out against the old one.',
    };
  }
  if (IN_PROGRESS.has(status)) {
    return {
      action: 'upload',
      why: 'The appraiser is working on this right now, so the new scope of work is sent straight over with a note.',
    };
  }
  if (NOT_STARTED.has(status)) {
    return {
      action: 'update',
      why: 'Nothing has been valued off the old scope of work yet, so the order itself is updated with the new budget and file.',
    };
  }
  // A status we have never seen. Sending the file is the safe move: it can never
  // undo work, and it always reaches the appraiser.
  return { action: 'upload', why: `Richer Value has this order at “${order.status}”, so the new scope of work is sent over with a note.` };
}

/**
 * Send the revised scope of work to Richer Value for ONE order, following the plan
 * above. Every vendor call is journalled by the caller-supplied `journal`.
 *
 * @returns {Promise<{ok:boolean, action:string, why:string, error?:string, dryrun?:boolean}>}
 */
async function sendRevision(db, order, { budget = null, note = null, journal = null, plan = null } = {}) {
  const p = plan || revisionPlanFor(order);
  if (p.action === 'none') return { ok: false, action: 'none', why: p.why, error: p.why };

  const read = await readScopeOfWork(db, order.application_id);
  if (!read.ok) return { ok: false, action: p.action, why: p.why, error: read.error };

  const comment = note
    || 'The scope of work on this loan has been updated. The new one is attached; please value the property against it.';

  try {
    if (p.action === 'update') {
      const form = { intake_token: order.intake_token, budget_files: [read.file] };
      if (budget != null && Number(budget) > 0) {
        form.borrower_budget = String(Math.round(Number(budget)));
        form.borrower_sow = 'YES';
      }
      const res = await client.updateOrder(order.intake_token, form);
      if (journal) await journal({ action: 'sow_update', ok: true, response: res, request: { filename: read.file.filename, budget } });
      return { ok: true, action: 'update', why: p.why, dryrun: !!(res && res.__dryrun) };
    }

    if (p.action === 'reopen') {
      // Their reopen carries the reason; the file goes over on its own call so the
      // appraiser has the document AND the order is genuinely reopened. The upload
      // runs FIRST: a reopened order with no new scope of work attached is exactly
      // the state that puts an order On Hold.
      const up = await client.uploadDocuments({
        intake_token: order.intake_token,
        order_token: order.order_token || undefined,
        document_type: 'borrower_sow',
        comment,
        files: [read.file],
      });
      if (journal) await journal({ action: 'sow_upload', ok: true, response: up, request: { filename: read.file.filename } });
      const res = await client.reopenOrder({
        intake_token: order.intake_token,
        order_token: order.order_token || undefined,
        reason: p.reopenReason || 'new-budget',
        comment,
      });
      if (journal) await journal({ action: 'sow_reopen', ok: true, response: res, request: { reason: p.reopenReason } });
      return { ok: true, action: 'reopen', why: p.why, dryrun: !!(res && res.__dryrun) };
    }

    const up = await client.uploadDocuments({
      intake_token: order.intake_token,
      order_token: order.order_token || undefined,
      document_type: 'borrower_sow',
      comment,
      files: [read.file],
    });
    if (journal) await journal({ action: 'sow_upload', ok: true, response: up, request: { filename: read.file.filename } });
    return { ok: true, action: 'upload', why: p.why, dryrun: !!(up && up.__dryrun) };
  } catch (e) {
    if (journal) await journal({ action: `sow_${p.action}`, ok: false, error: e.message, response: e.body || null });
    return { ok: false, action: p.action, why: p.why, error: e.message };
  }
}

module.exports = {
  findScopeOfWork, readScopeOfWork, revisionPlanFor, sendRevision,
  _internals: { choose, MAX_BYTES, NOT_STARTED, IN_PROGRESS, FINISHED, DEAD },
};

'use strict';
/**
 * Sitewire DOCUMENT push — gather the 3 property documents from PILOT and place them in the Sitewire
 * property's Documents tab, using the website "browser robot" (web-client.js) because the API has no
 * upload endpoint. This is the guarded orchestration layer: it decides WHAT to push, gathers the RIGHT
 * bytes (never the wrong slot), and applies the same discipline as every other Sitewire write —
 * managed-only, circuit-broken, journaled, read-after-write VERIFIED against the trusted API, and
 * parked (never silently dropped) on any failure.
 *
 * The three documents (owner-directed 2026-07-21):
 *   1. appraisal_pdf  — the appraisal PDF (doc_kind='appraisal_pdf', the PDF — NEVER the appraisal XML)
 *   2. sow_xlsx       — the Scope of Work Excel (doc_kind='rehab_budget_export', .xlsx/spreadsheet);
 *                        regenerated from the saved SOW if no stored Excel exists
 *   3. sow_pdf        — the Scope of Work PDF (doc_kind='rehab_budget_export', .pdf)
 *
 * Staged like every write: OFF unless SITEWIRE_DOCS_ENABLED, and still honors SITEWIRE_OUTBOUND_ENABLED
 * (write gate) + SITEWIRE_DRYRUN (log, send nothing). GO-FORWARD ONLY: a file must be PILOT-managed
 * (matched_by='created' + a live property) — a pre-existing hand-entered Sitewire property is never touched.
 */
const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
const switches = require('../lib/integrations/switches');
const storage = require('../lib/storage');
const web = require('./web-client');
const orch = require('./orchestrator');
const sow = require('./sow-line-edit');

const SLOTS = ['appraisal_pdf', 'sow_xlsx', 'sow_pdf'];
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- gather the RIGHT bytes for each slot (never the wrong slot) ----
async function readDoc(row) {
  if (!row || !row.storage_ref) return null;
  try { const buf = await storage.read(row.storage_ref); return buf && buf.length ? buf : null; } catch (_) { return null; }
}

// The appraisal PDF lives in EITHER of two legitimate shapes (never the XML):
//   (1) doc_kind='appraisal_pdf' — created by the MISMO importer when a PDF is embedded/uploaded in the import; OR
//   (2) a plain PDF uploaded to the appraisal-documents condition's PDF slot (template code
//       'rtl_cond_appraisaldocs', slot_label like "PDF", doc_kind NULL) — the common case when an officer
//       just uploads the appraisal PDF to the condition. Matching only (1) wrongly reported "not available"
//       for a file whose appraisal PDF sits on the condition slot. Prefer (1); exclude the XML slot + rejected.
const APPRAISAL_PDF_WHERE = `d.application_id=$1 AND d.is_current=true AND COALESCE(d.review_status,'') <> 'rejected'
    AND ( d.doc_kind='appraisal_pdf'
       OR ( (d.content_type='application/pdf' OR lower(d.filename) LIKE '%.pdf')
            AND lower(COALESCE(d.slot_label,'')) NOT LIKE '%xml%'
            AND d.checklist_item_id IN (
              SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
               WHERE ci.application_id=$1 AND t.code='rtl_cond_appraisaldocs') ) )`;

async function gatherAppraisalPdf(appId) {
  const row = (await db.query(
    `SELECT d.id, d.filename, d.content_type, d.storage_ref FROM documents d
       WHERE ${APPRAISAL_PDF_WHERE}
       ORDER BY (d.doc_kind='appraisal_pdf') DESC, d.created_at DESC LIMIT 1`, [appId])).rows[0];
  if (!row) return { which: 'appraisal_pdf', missing: 'no_appraisal_pdf' };
  const bytes = await readDoc(row);
  if (!bytes) return { which: 'appraisal_pdf', missing: 'appraisal_pdf_bytes_unreadable' };
  return { which: 'appraisal_pdf', filename: 'Appraisal.pdf', contentType: 'application/pdf', bytes, sourceDocId: row.id };
}

// The Scope of Work Excel — doc_kind='rehab_budget_export', the spreadsheet sibling (.xlsx). If none is
// stored, regenerate it from the saved SOW (the same builder the SOW line-edit uses) so we never miss it.
async function gatherSowExcel(appId) {
  const row = (await db.query(
    `SELECT id, filename, content_type, storage_ref FROM documents
       WHERE application_id=$1 AND is_current=true AND doc_kind='rehab_budget_export'
         AND (content_type LIKE '%spreadsheet%' OR lower(filename) LIKE '%.xlsx')
       ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
  if (row) {
    const bytes = await readDoc(row);
    if (bytes) return { which: 'sow_xlsx', filename: 'Scope of Work.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes, sourceDocId: row.id };
  }
  // Fallback: build the Excel from the saved SOW state.
  try {
    const s = await sow.loadSow(appId);
    if (s && s.state) {
      const totalCents = Number.isFinite(Number(s.total)) ? Number(s.total) : undefined;
      const buf = sow.buildSowExcel(s.state, totalCents);
      if (buf && buf.length) return { which: 'sow_xlsx', filename: 'Scope of Work.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: buf, sourceDocId: null, generated: true };
    }
  } catch (_) { /* fall through to missing */ }
  return { which: 'sow_xlsx', missing: 'no_sow_excel' };
}

// The Scope of Work PDF — doc_kind='rehab_budget_export', the PDF sibling.
async function gatherSowPdf(appId) {
  const row = (await db.query(
    `SELECT id, filename, content_type, storage_ref FROM documents
       WHERE application_id=$1 AND is_current=true AND doc_kind='rehab_budget_export'
         AND (content_type='application/pdf' OR lower(filename) LIKE '%.pdf')
       ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
  if (!row) return { which: 'sow_pdf', missing: 'no_sow_pdf' };
  const bytes = await readDoc(row);
  if (!bytes) return { which: 'sow_pdf', missing: 'sow_pdf_bytes_unreadable' };
  return { which: 'sow_pdf', filename: 'Scope of Work.pdf', contentType: 'application/pdf', bytes, sourceDocId: row.id };
}

async function gatherAll(appId) {
  const [a, x, p] = await Promise.all([gatherAppraisalPdf(appId), gatherSowExcel(appId), gatherSowPdf(appId)]);
  return { appraisal_pdf: a, sow_xlsx: x, sow_pdf: p };
}

// METADATA-ONLY availability (no storage bytes read) for the status endpoint / panel render, which can run
// often — never load a big appraisal PDF into memory just to answer "is it available?". A slot is available
// if the source documents row exists (or, for the SOW Excel, a saved SOW state exists for the fallback).
async function slotAvailability(appId) {
  const rows = (await db.query(
    `SELECT doc_kind, content_type, lower(filename) AS fn FROM documents
       WHERE application_id=$1 AND is_current=true
         AND doc_kind='rehab_budget_export'`, [appId])).rows;
  // Appraisal PDF uses the SAME two-shape detection as gatherAppraisalPdf (importer kind OR the appraisal-docs
  // condition PDF slot) so the panel's availability agrees with what actually gets pushed.
  const appraisal = (await db.query(
    `SELECT 1 FROM documents d WHERE ${APPRAISAL_PDF_WHERE} LIMIT 1`, [appId])).rowCount > 0;
  const xlsx = rows.some((r) => /spreadsheet/.test(r.content_type || '') || /\.xlsx$/.test(r.fn || ''));
  const pdf = rows.some((r) => (r.content_type === 'application/pdf') || /\.pdf$/.test(r.fn || ''));
  let xlsxFallback = false;
  if (!xlsx) { try { const s = await sow.loadSow(appId); xlsxFallback = !!(s && s.state); } catch (_) { xlsxFallback = false; } }
  return { appraisal_pdf: appraisal, sow_xlsx: xlsx || xlsxFallback, sow_pdf: pdf, sow_xlsx_generated: !xlsx && xlsxFallback };
}

// A quick read-only status for the UI: which of the 3 documents are available to push + their push state.
async function status(appId) {
  const link = await orch.getLink(appId);
  const managed = !!(link && link.sitewire_property_id && link.matched_by === 'created');
  const avail = await slotAvailability(appId);
  const links = (await db.query(
    `SELECT which, status, filename, sitewire_document_name, sha256, pushed_at, last_error
       FROM sitewire_document_links WHERE application_id=$1`, [appId])).rows;
  const byWhich = Object.fromEntries(links.map((r) => [r.which, r]));
  const slots = SLOTS.map((w) => {
    const isAvail = !!avail[w];
    const rec = byWhich[w] || null;
    return {
      which: w,
      label: w === 'appraisal_pdf' ? 'Appraisal PDF' : w === 'sow_xlsx' ? 'Scope of Work (Excel)' : 'Scope of Work (PDF)',
      available: isAvail,
      missing: isAvail ? null : (w === 'appraisal_pdf' ? 'no_appraisal_pdf' : w === 'sow_xlsx' ? 'no_sow_excel' : 'no_sow_pdf'),
      generated: w === 'sow_xlsx' ? !!avail.sow_xlsx_generated : false,
      pushed: !!(rec && (rec.status === 'pushed' || rec.status === 'verified')),
      verified: !!(rec && rec.status === 'verified'),
      status: rec ? rec.status : 'not_pushed',
      sitewire_name: rec ? rec.sitewire_document_name : null,
      pushed_at: rec ? rec.pushed_at : null,
      last_error: rec ? rec.last_error : null,
    };
  });
  return { managed, enabled: !!cfg.sitewireDocsEnabled, web_configured: web.webConfigured(), slots };
}

async function upsertLink(appId, propertyId, g, patch) {
  await db.query(
    `INSERT INTO sitewire_document_links (application_id, sitewire_property_id, which, source_document_id, filename, sha256, signed_id, status, sitewire_document_name, last_error, pushed_by, pushed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (application_id, which) DO UPDATE SET
       sitewire_property_id=EXCLUDED.sitewire_property_id, source_document_id=EXCLUDED.source_document_id,
       filename=EXCLUDED.filename, sha256=EXCLUDED.sha256, signed_id=EXCLUDED.signed_id, status=EXCLUDED.status,
       sitewire_document_name=EXCLUDED.sitewire_document_name, last_error=EXCLUDED.last_error,
       pushed_by=EXCLUDED.pushed_by, pushed_at=EXCLUDED.pushed_at, updated_at=now()`,
    [appId, propertyId == null ? null : String(propertyId), g.which, g.sourceDocId || null, g.filename,
     patch.sha256 || null, patch.signed_id || null, patch.status, patch.sitewire_document_name || null,
     patch.last_error || null, patch.pushed_by || null, patch.pushed_at || null]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const VERIFY_DELAY_MS = parseInt(process.env.SITEWIRE_DOC_VERIFY_DELAY_MS || '1500', 10);
// Widened from 3 to a configurable count (audit finding C-2, 2026-07-21). Sitewire's document read
// can lag several seconds behind an upload — the old ~4.5s window (3 × 1.5s) parked a lot of
// legitimately-uploaded docs as `sitewire_doc_unverified`. 6 × 1.5s = ~9s covers the realistic lag.
const VERIFY_TRIES_DEFAULT = parseInt(process.env.SITEWIRE_DOC_VERIFY_TRIES || '6', 10);

// Read-after-write: confirm (via the TRUSTED API) that a document with our filename now exists on the
// property. The API can lag a moment behind the upload, so retry a few times. Returns the confirmed
// Sitewire document name, or null if it never shows up.
// Uses listSitewireDocumentsForVerify (URL-AGNOSTIC) so a doc whose URL fails the host allowlist is
// still recognized as PRESENT — the coordinator-facing getSitewireDocuments correctly hides those URLs,
// but a name-match verify must still succeed (audit C-2).
async function verifyPresent(appId, filename, tries = VERIFY_TRIES_DEFAULT) {
  const want = String(filename || '').toLowerCase();
  const stem = want.replace(/\.[a-z0-9]+$/, '');
  for (let i = 0; i < tries; i++) {
    try {
      const res = await orch.listSitewireDocumentsForVerify(appId);
      if (res && res.available && Array.isArray(res.documents)) {
        const hit = res.documents.find((d) => String(d.name || '').toLowerCase() === want)
          || res.documents.find((d) => String(d.name || '').toLowerCase().includes(stem));
        if (hit) return hit.name || filename;
      }
    } catch (_) { /* ignore + retry */ }
    if (i < tries - 1) await sleep(VERIFY_DELAY_MS);
  }
  return null;
}

/**
 * SELF-HEAL every `pushed` doc slot: re-verify against the trusted API and, when Sitewire now
 * shows the doc, upgrade the DB row from 'pushed' → 'verified' AND auto-close the parked
 * `sitewire_doc_unverified:<slot>` review row (owner-directed 2026-07-22 root-cause fix).
 *
 * Sitewire's document read can lag by minutes after an upload. The old code parked the review
 * once, and the sha256 dedup then permanently skipped the re-upload — so the review stayed open
 * for weeks even though the doc IS on the property. This runs on EVERY pushDocuments call AND
 * on EVERY reconcile pass (see reconcile.reconcileOne), so the "stuck in unverified" class
 * silently resolves the moment Sitewire's read catches up. Never uploads, never modifies
 * Sitewire — read-only self-heal + housekeeping.
 *
 * @param whichSlots  optional list of slots to check (default: all 'pushed' slots for the file)
 * @param cachedExisting  optional {which: row} map from a caller that already read the DB
 * @returns { healed: [{which, name}], checked: n }
 */
async function verifyPushedDocsOnce(appId, propertyId, whichSlots = null, { existing: cachedExisting, escalate = false } = {}) {
  if (!appId) return { healed: [], checked: 0, escalated: [] };
  // Also read pushed_at so escalation (below) can decide when to force-retry a stuck upload.
  const existing = cachedExisting || Object.fromEntries((await db.query(
    `SELECT which, sha256, status, filename, sitewire_document_name, pushed_at FROM sitewire_document_links WHERE application_id=$1 AND status='pushed'`, [appId])).rows.map((r) => [r.which, r]));
  const slots = Array.isArray(whichSlots) && whichSlots.length ? whichSlots : Object.keys(existing);
  const healed = [];
  const escalated = [];
  let checked = 0;
  // Escalation threshold — a `pushed` row still un-verified after this long is treated as a genuine
  // upload failure (Sitewire never confirmed), not just a read-lag. Auto-force-retry the upload so
  // the coordinator doesn't have to click "Retry push" for every stuck row. 30 minutes gives Sitewire
  // plenty of time to catch up on a normal upload before we assume the doc really isn't there.
  const ESCALATE_AFTER_MS = 30 * 60 * 1000;
  const now = Date.now();
  for (const which of slots) {
    const prev = existing[which];
    if (!prev || prev.status !== 'pushed') continue;
    // Prefer the stored filename over any live gather (gather is heavy: builds SOW xlsx / pdf).
    const filename = prev.filename || null;
    if (!filename) continue;
    checked++;
    let confirmedName = null;
    try { confirmedName = await verifyPresent(appId, filename, 2); } catch (_) { confirmedName = null; }
    if (confirmedName) {
      try {
        await db.query(
          `UPDATE sitewire_document_links SET status='verified',
              sitewire_document_name = COALESCE(sitewire_document_name, $2), updated_at=now()
            WHERE application_id=$1 AND which=$3`,
          [appId, confirmedName, which]);
        await db.query(
          `UPDATE sync_review_queue
              SET status='resolved', auto_resolved=true, resolved_at=now(),
                  resolution_note=$2
            WHERE status='open' AND application_id=$1 AND field_key='sitewire'
              AND task_id = $3`,
          [appId,
           `auto-closed — Sitewire now shows the document as "${String(confirmedName).slice(0, 120)}"; verified on a later pass after the initial read lag.`,
           `sitewire:${appId}:sitewire_doc_unverified:${which}`]);
        try { await orch.journal({ appId, propertyId: propertyId || null, entity: 'document', field: which,
          newValue: { verified: true, self_heal: true, name: confirmedName }, source: 'self_heal_verify' }); } catch (_) {}
        if (cachedExisting && cachedExisting[which]) {
          cachedExisting[which].status = 'verified';
          cachedExisting[which].sitewire_document_name = cachedExisting[which].sitewire_document_name || confirmedName;
        }
        healed.push({ which, name: confirmedName });
      } catch (_) { /* best-effort — the plan below still runs regardless */ }
      continue;
    }
    // Verify still fails. If the row has been in `pushed` for longer than the escalation threshold,
    // assume the original upload was genuinely lost (not a read-lag) and force-retry the upload —
    // route through the standard docPush flow with force:true so sha256 dedup is bypassed and a
    // fresh upload runs. Only when the caller asked to escalate (reconcile pass) — the intra-push
    // callers (_pushDocumentsLocked) explicitly don't ask, so we don't recurse into pushDocuments
    // from inside pushDocuments.
    if (!escalate) continue;
    const pushedAt = prev.pushed_at ? Date.parse(prev.pushed_at) : NaN;
    if (!Number.isFinite(pushedAt) || (now - pushedAt) < ESCALATE_AFTER_MS) continue;
    escalated.push({ which, pushed_at: prev.pushed_at });
    // Fire-and-forget: the escalated push runs its own per-file lock + journals its own result.
    // Any failure re-parks the same review row (still stuck) so no state is lost.
    Promise.resolve()
      .then(() => pushDocuments(appId, { which, force: true, source: 'auto_escalate_stuck_pushed' }))
      .catch((e) => console.warn(`[sitewire] doc auto-escalate failed for ${appId}/${which}:`, e && e.message));
  }
  return { healed, checked, escalated };
}

/**
 * Push the property documents to Sitewire.
 * @param appId
 * @param opts { which?: 'appraisal_pdf'|'sow_xlsx'|'sow_pdf' (default all), staffId?, force?, source? }
 * @returns { ok, managed, results:[{which, pushed, verified, skipped, reason, sitewire_name}], error? }
 */
async function pushDocuments(appId, opts = {}) {
  const source = opts.source || 'doc_push';
  const which = opts.which && SLOTS.includes(opts.which) ? [opts.which] : SLOTS;

  if (!cfg.sitewireDocsEnabled) return { ok: false, error: 'docs_disabled', message: 'Document push to Sitewire is turned off (SITEWIRE_DOCS_ENABLED).' };
  if (!switches.on('SITEWIRE_ENABLED')) return { ok: false, error: 'sitewire_disabled' };
  if (!switches.on('SITEWIRE_OUTBOUND_ENABLED')) return { ok: false, error: 'outbound_disabled' };

  const link = await orch.getLink(appId);
  if (!link || !link.sitewire_property_id || link.matched_by !== 'created') return { ok: false, error: 'not_managed' };
  const propertyId = link.sitewire_property_id;

  // Audit finding C-4 (2026-07-21): serialize doc-push per file so two concurrent operators (or a
  // manual click + a worker retry) can't both open a website session, both dedup-fail against the
  // same stale sha256, and both upload — creating a duplicate in Sitewire that verifyPresent then
  // matches to the FIRST hit (possibly the old copy). Session-level advisory lock keyed on the app
  // id; released in `finally`. If we can't acquire the lock (>30s wait), fail cleanly rather than
  // sit; the caller/queue retries.
  const lockKey = `sw-docpush:${appId}`;
  const lockConn = await db.getClient();
  let lockHeld = false;
  try {
    // A quick pg_try_advisory_lock with a short poll so we don't hang forever on a stuck operator.
    for (let attempt = 0; attempt < 30 && !lockHeld; attempt++) {
      const r = await lockConn.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [lockKey]);
      if (r.rows[0].ok) { lockHeld = true; break; }
      await sleep(1000);
    }
    if (!lockHeld) return { ok: false, error: 'busy', message: 'Another Sitewire document push for this file is in flight — please try again in a moment.' };
    return await _pushDocumentsLocked(appId, opts, which, source, link, propertyId);
  } finally {
    if (lockHeld) { try { await lockConn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); } catch (_) {} }
    lockConn.release();
  }
}

async function _pushDocumentsLocked(appId, opts, which, source, link, propertyId) {
  const gathered = await gatherAll(appId);
  const toPush = which.map((w) => gathered[w]).filter(Boolean);
  const results = [];

  // Existing push records (for sha256 dedup — never re-upload identical bytes unless forced).
  const existing = Object.fromEntries((await db.query(
    `SELECT which, sha256, status, sitewire_document_name FROM sitewire_document_links WHERE application_id=$1`, [appId])).rows.map((r) => [r.which, r]));

  // Self-heal every 'pushed' slot BEFORE the plan step so a now-verified slot flips to
  // `verified:true` in the response and never re-triggers the park. See verifyPushedDocsOnce below.
  await verifyPushedDocsOnce(appId, propertyId, toPush.map((g) => g.which), { existing });

  // Decide what actually needs uploading BEFORE opening a website session — so an unchanged re-push (all 3
  // already pushed with the same bytes) never triggers a needless Sitewire LOGIN (which could look like
  // repeated logins / trip a rate limit). Each item's dedup verdict is computed from its content hash here.
  const plan = toPush.map((g) => {
    if (g.missing) return { g, skip: g.missing };
    const digest = sha256(g.bytes);
    const prev = existing[g.which];
    if (!opts.force && prev && prev.sha256 === digest && (prev.status === 'pushed' || prev.status === 'verified')) {
      return { g, digest, skip: 'already_pushed', verified: prev.status === 'verified' };
    }
    return { g, digest, upload: true };
  });

  // Obtain ONE website session for the whole batch — only if something genuinely needs uploading.
  let session = null;
  const needsSession = plan.some((p) => p.upload);
  if (needsSession && !cfg.sitewireDryrun) {
    session = await web.getSession();
    if (session.error) {
      await orch.park({ appId, reason: `sitewire_doc_web_session:${session.error}`, dedupe: 'web_session', current: session.message || session.error });
      return { ok: false, error: session.error, message: session.message || 'Could not open a Sitewire website session.' };
    }
    // Get the CSRF security token from THIS property's page (always server-rendered with it) — this also
    // confirms the session is genuinely authenticated for this property. Reliable regardless of how the
    // sign-in screen is built.
    const primed = await web.primeCsrf(session, propertyId);
    if (primed.error) {
      await orch.park({ appId, reason: `sitewire_doc_web_session:${primed.error}`, dedupe: 'web_session', current: primed.message || primed.error });
      return { ok: false, error: primed.error, message: primed.message || 'Could not confirm the Sitewire session for this property.' };
    }
  }

  for (const p of plan) {
    const g = p.g;
    if (p.skip === 'already_pushed') { results.push({ which: g.which, skipped: true, reason: 'already_pushed', verified: !!p.verified }); continue; }
    if (p.skip) { results.push({ which: g.which, skipped: true, reason: p.skip }); continue; }
    const digest = p.digest;

    // DRY-RUN: record the intent, send nothing.
    if (cfg.sitewireDryrun) {
      await orch.journal({ appId, propertyId, entity: 'document', field: g.which, newValue: { filename: g.filename, bytes: g.bytes.length, dryrun: true }, source, changed: false });
      results.push({ which: g.which, dryrun: true, filename: g.filename });
      continue;
    }

    try {
      await orch.circuitCheck(1); // count each upload toward the runaway breaker
      const blob = await web.uploadBlob(session, { filename: g.filename, contentType: g.contentType, bytes: g.bytes });
      // Attach. The website's Turbo form can return a non-2xx (e.g. a 406 content-negotiation quirk) even when
      // Sitewire SAVED the document — so a NON-retryable attach error is NOT treated as a failure yet: the
      // TRUSTED API (property.documents[]) is the source of truth. A retryable error (network/5xx/auth) still
      // rethrows/parks. This is exactly the "document is in Sitewire but PILOT still errored" case.
      let attachErr = null;
      try { await web.attachDocument(session, propertyId, blob.signed_id, { filename: g.filename }); }
      catch (e) {
        if (e.retryable) throw e; // real transient failure — let the outer catch retry/park
        attachErr = e;            // non-retryable (e.g. 406): defer the verdict to the API check below
      }
      // Read-after-write via the TRUSTED API — the real proof the document landed.
      const confirmedName = await verifyPresent(appId, g.filename);
      if (confirmedName) {
        // It's actually in Sitewire → SUCCESS, regardless of any website-response quirk.
        await upsertLink(appId, propertyId, g, { sha256: digest, signed_id: blob.signed_id, status: 'verified', sitewire_document_name: confirmedName, pushed_by: opts.staffId || null, pushed_at: new Date() });
        // NB: signed_id is an opaque ActiveStorage STRING, not a bigint — it goes in newValue, never entityId.
        await orch.journal({ appId, propertyId, entity: 'document', field: g.which, newValue: { filename: g.filename, bytes: g.bytes.length, signed_id: blob.signed_id, verified: true, attach_status: attachErr ? attachErr.status : 'ok' }, source });
        results.push({ which: g.which, pushed: true, verified: true, filename: g.filename, sitewire_name: confirmedName });
      } else if (attachErr) {
        // The website rejected the attach AND the document is not in Sitewire → a real failure. Park it.
        await upsertLink(appId, propertyId, g, { sha256: digest, status: 'failed', last_error: String(attachErr.message || attachErr).slice(0, 300), pushed_by: opts.staffId || null, pushed_at: new Date() });
        await orch.park({ appId, reason: `sitewire_doc_push_failed:${g.which}`, dedupe: g.which, current: g.filename, proposed: String(attachErr.message || attachErr).slice(0, 200) });
        results.push({ which: g.which, error: String(attachErr.message || attachErr) });
      } else {
        // Attach returned OK but the API doesn't list it yet — sent, not yet confirmed. Soft state (not failed).
        await upsertLink(appId, propertyId, g, { sha256: digest, signed_id: blob.signed_id, status: 'pushed', sitewire_document_name: null, pushed_by: opts.staffId || null, pushed_at: new Date() });
        await orch.journal({ appId, propertyId, entity: 'document', field: g.which, newValue: { filename: g.filename, bytes: g.bytes.length, signed_id: blob.signed_id, verified: false }, source });
        await orch.park({ appId, reason: 'sitewire_doc_unverified', dedupe: g.which, current: g.filename, proposed: `slot=${g.which}` });
        results.push({ which: g.which, pushed: true, verified: false, filename: g.filename });
      }
    } catch (e) {
      await upsertLink(appId, propertyId, g, { sha256: digest, status: 'failed', last_error: String(e.message || e).slice(0, 300), pushed_by: opts.staffId || null, pushed_at: new Date() });
      if (e.retryable) {
        // Transient (network / 5xx / auth) — rethrow so a durable caller retries; a direct button press surfaces it.
        results.push({ which: g.which, error: String(e.message || e), retryable: true });
        if (opts.rethrow) throw e;
      } else {
        await orch.park({ appId, reason: `sitewire_doc_push_failed:${g.which}`, dedupe: g.which, current: g.filename, proposed: String(e.message || e).slice(0, 200) });
        results.push({ which: g.which, error: String(e.message || e) });
      }
    }
  }
  const anyPushed = results.some((r) => r.pushed);
  return { ok: true, managed: true, dryrun: !!cfg.sitewireDryrun, results, anyPushed };
}

module.exports = { pushDocuments, status, gatherAll, SLOTS, verifyPushedDocsOnce, _internal: { gatherAppraisalPdf, gatherSowExcel, gatherSowPdf, verifyPresent } };

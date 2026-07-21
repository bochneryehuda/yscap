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

// The appraisal PDF — doc_kind='appraisal_pdf', the current one, and it must actually be a PDF (never the XML).
async function gatherAppraisalPdf(appId) {
  const row = (await db.query(
    `SELECT id, filename, content_type, storage_ref FROM documents
       WHERE application_id=$1 AND is_current=true AND doc_kind='appraisal_pdf'
       ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
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
         AND doc_kind IN ('appraisal_pdf','rehab_budget_export')`, [appId])).rows;
  const appraisal = rows.some((r) => r.doc_kind === 'appraisal_pdf');
  const xlsx = rows.some((r) => r.doc_kind === 'rehab_budget_export' && (/spreadsheet/.test(r.content_type || '') || /\.xlsx$/.test(r.fn || '')));
  const pdf = rows.some((r) => r.doc_kind === 'rehab_budget_export' && ((r.content_type === 'application/pdf') || /\.pdf$/.test(r.fn || '')));
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

// Read-after-write: confirm (via the TRUSTED API) that a document with our filename now exists on the
// property. Returns the confirmed Sitewire document name, or null if it isn't visible yet.
async function verifyPresent(appId, filename) {
  try {
    const res = await orch.getSitewireDocuments(appId);
    if (!res || !res.available || !Array.isArray(res.documents)) return null;
    const want = String(filename || '').toLowerCase();
    const hit = res.documents.find((d) => String(d.name || '').toLowerCase() === want)
      || res.documents.find((d) => String(d.name || '').toLowerCase().includes(want.replace(/\.[a-z0-9]+$/, '')));
    return hit ? (hit.name || filename) : null;
  } catch (_) { return null; }
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

  const gathered = await gatherAll(appId);
  const toPush = which.map((w) => gathered[w]).filter(Boolean);
  const results = [];

  // Existing push records (for sha256 dedup — never re-upload identical bytes unless forced).
  const existing = Object.fromEntries((await db.query(
    `SELECT which, sha256, status FROM sitewire_document_links WHERE application_id=$1`, [appId])).rows.map((r) => [r.which, r]));

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
      await web.attachDocument(session, propertyId, blob.signed_id, { filename: g.filename });
      // Read-after-write via the TRUSTED API — do not trust the website flow's own response.
      const confirmedName = await verifyPresent(appId, g.filename);
      const st = confirmedName ? 'verified' : 'pushed'; // 'pushed' = sent but not yet visible in the API list
      await upsertLink(appId, propertyId, g, { sha256: digest, signed_id: blob.signed_id, status: st, sitewire_document_name: confirmedName, pushed_by: opts.staffId || null, pushed_at: new Date() });
      // NB: signed_id is an opaque ActiveStorage STRING, not a bigint — it goes in newValue, never entityId.
      await orch.journal({ appId, propertyId, entity: 'document', field: g.which, newValue: { filename: g.filename, bytes: g.bytes.length, signed_id: blob.signed_id, verified: !!confirmedName }, source });
      if (!confirmedName) {
        // Uploaded but not verifiable in the API list — park so a human confirms rather than assuming success.
        await orch.park({ appId, reason: 'sitewire_doc_unverified', dedupe: g.which, current: g.filename, proposed: `slot=${g.which}` });
      }
      results.push({ which: g.which, pushed: true, verified: !!confirmedName, filename: g.filename, sitewire_name: confirmedName });
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

module.exports = { pushDocuments, status, gatherAll, SLOTS, _internal: { gatherAppraisalPdf, gatherSowExcel, gatherSowPdf, verifyPresent } };

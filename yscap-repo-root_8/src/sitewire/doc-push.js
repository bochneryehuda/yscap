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
 *   4. plans_permits  — the plans & permits filed on this loan (owner-directed 2026-08-21: "any time
 *                        plans and permits are uploaded … it should be sent over to Sitewire as well …
 *                        the same way the appraisal is being sent over to Sitewire"). Unlike the other
 *                        three this is a FAMILY, not one document: a builder files a site plan, a
 *                        building permit and approved drawings separately, and the inspector standing on
 *                        the site needs all of them. So it expands to `plans_permits`, `plans_permits:2`
 *                        … one Sitewire document each, up to PLANS_MAX — and anything past the cap is
 *                        REPORTED rather than dropped in silence.
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

const SLOTS = ['appraisal_pdf', 'sow_xlsx', 'sow_pdf', 'plans_permits'];
// The plans family expands past its base key; every other slot is exactly itself.
const PLANS_BASE = 'plans_permits';
const isPlansSlot = (w) => w === PLANS_BASE || String(w || '').startsWith(PLANS_BASE + ':');
// A cap, because this reads bytes into memory and opens one upload per document. It is a REPORTED cap:
// `slotAvailability` returns the true count and `status` says how many were left behind.
const PLANS_MAX = Math.max(1, parseInt(process.env.SITEWIRE_PLANS_MAX || '6', 10) || 6);
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
// Arm (2) matches ANY current PDF on the appraisal-documents condition regardless of doc_kind, so a
// document that merely got FILED there rides out to Sitewire — where the borrower submits draws and the
// capital partner reads the file — labelled "Appraisal.pdf". Two exclusions, both applied to the WHOLE
// predicate (not just arm 2) so no future arm can reopen the hole:
//   - the file's DESIGNATED PURCHASE ADVICE. It names the note buyer and the price the loan sold for, and
//     the standing rule is that a capital-partner name never reaches a borrower-facing surface. Excluded by
//     the advice POINTER, not by doc_kind or visibility: the appraisal PDF is itself normally staff_only
//     (so visibility cannot tell the two apart) and designation deliberately never rewrites doc_kind.
//   - anything marked 'internal', which tpr-export defines as never shippable to a buyer.
const APPRAISAL_PDF_WHERE = `d.application_id=$1 AND d.is_current=true AND COALESCE(d.review_status,'') <> 'rejected'
    AND COALESCE(d.visibility,'') <> 'internal'
    AND d.id IS DISTINCT FROM (SELECT a.document_id FROM purchasing_advice a WHERE a.application_id=$1)
    AND ( COALESCE(d.doc_kind,'')='appraisal_pdf'
       OR ( (d.content_type='application/pdf' OR lower(d.filename) LIKE '%.pdf')
            AND lower(COALESCE(d.slot_label,'')) NOT LIKE '%xml%'
            AND d.checklist_item_id IN (
              SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
               WHERE ci.application_id=$1 AND t.code='rtl_cond_appraisaldocs') ) )`;

// The ORDER BY is what expresses "prefer arm (1)", and it must COALESCE rather than compare a bare
// doc_kind. doc_kind is NULL on every condition-slot upload (arm 2), a NULL comparison yields NULL, and
// Postgres sorts NULLs FIRST under DESC — so the preference was INVERTED whenever both shapes sat on one
// file. That is the common case (the MISMO importer writes the explicit appraisal_pdf while the officer
// also drops a PDF on the condition), and it meant Sitewire received whichever unlabelled PDF happened to
// be filed on the appraisal condition, uploaded as "Appraisal.pdf".
async function gatherAppraisalPdf(appId) {
  const row = (await db.query(
    `SELECT d.id, d.filename, d.content_type, d.storage_ref FROM documents d
       WHERE ${APPRAISAL_PDF_WHERE}
       ORDER BY (COALESCE(d.doc_kind,'')='appraisal_pdf') DESC, d.created_at DESC LIMIT 1`, [appId])).rows[0];
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

/* PLANS & PERMITS (owner-directed 2026-08-21). Both places the owner named count — "If there is Plans
   and Permits on File and Plans and Permits condition" — which are the two live templates:
   `rtl_p1_plans` ("Plans & permits (ground-up) — if applicable") and `draw_cond_plans_permits`
   ("Plans & permits — confirmed before the first draw"). Matching the CODES rather than a label means a
   relabelling cannot quietly stop the push.

   THE SAME PREDICATE THE APPRAISAL SLOT USES, DELIBERATELY — the owner's own words are "the same way the
   appraisal is being sent over to Sitewire", and the two sit on one Documents tab. So: current, not
   rejected, never an 'internal' document, and never the designated purchase advice (it names the note
   buyer, and Sitewire is where the borrower submits draws). It is NOT accepted-only: db/424 governs what
   goes out to an INVESTOR or an attorney, while this is the servicing inspector working from whatever the
   builder actually filed — and holding a permit back until somebody reviews it would leave an inspector
   standing on a site without it. Tightening that is an owner call, and it would have to move the
   appraisal slot beside it too. */
const PLANS_WHERE = `d.application_id=$1 AND d.is_current=true AND COALESCE(d.review_status,'') <> 'rejected'
    AND COALESCE(d.visibility,'') <> 'internal'
    AND d.id IS DISTINCT FROM (SELECT a.document_id FROM purchasing_advice a WHERE a.application_id=$1)
    AND d.checklist_item_id IN (
          SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
           WHERE ci.application_id=$1 AND t.code IN ('rtl_p1_plans','draw_cond_plans_permits'))`;

/* The Sitewire name is DERIVED FROM THE DOCUMENT, not numbered — an inspector needs to tell a site plan
   from a building permit, and "Plans and Permits (2).pdf" tells them nothing. It is deterministic (the
   same document always produces the same name) because verifyPresent matches on the name, so a re-push
   has to land on the copy it already made. */
function plansDocName(row) {
  const raw = String(row.filename || 'Plans and Permits');
  const dot = raw.lastIndexOf('.');
  const base = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Document';
  const ext = dot > 0 ? raw.slice(dot).toLowerCase() : '';
  return `Plans and Permits - ${base.slice(0, 60)}${ext}`;
}

async function gatherPlansPermits(appId) {
  const rows = (await db.query(
    `SELECT d.id, d.filename, d.content_type, d.storage_ref FROM documents d
      WHERE ${PLANS_WHERE}
      ORDER BY d.created_at ASC, d.id ASC`, [appId])).rows;
  if (!rows.length) return [{ which: PLANS_BASE, missing: 'no_plans_permits' }];
  const out = [];
  // OLDEST FIRST, so the key a document gets is STABLE: keying newest-first would re-letter every
  // existing document the moment one more is filed, and every re-push would then look like a change.
  for (let i = 0; i < rows.length && i < PLANS_MAX; i++) {
    const row = rows[i];
    const which = i === 0 ? PLANS_BASE : `${PLANS_BASE}:${i + 1}`;
    const bytes = await readDoc(row);
    if (!bytes) { out.push({ which, missing: 'plans_permits_bytes_unreadable' }); continue; }
    out.push({ which, filename: plansDocName(row), contentType: row.content_type || 'application/octet-stream',
      bytes, sourceDocId: row.id });
  }
  if (rows.length > PLANS_MAX) out.overflow = rows.length - PLANS_MAX;   // NEVER a silent cap
  return out;
}

async function gatherAll(appId) {
  const [a, x, p, pp] = await Promise.all([gatherAppraisalPdf(appId), gatherSowExcel(appId), gatherSowPdf(appId), gatherPlansPermits(appId)]);
  const out = { appraisal_pdf: a, sow_xlsx: x, sow_pdf: p };
  for (const g of pp) out[g.which] = g;
  if (pp.overflow) out._plansOverflow = pp.overflow;
  return out;
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
  // The TRUE count, not the capped one — `status` needs to be able to say what was left behind.
  const plansCount = Number((await db.query(
    `SELECT count(*)::int AS n FROM documents d WHERE ${PLANS_WHERE}`, [appId])).rows[0].n) || 0;
  return { appraisal_pdf: appraisal, sow_xlsx: xlsx || xlsxFallback, sow_pdf: pdf,
    sow_xlsx_generated: !xlsx && xlsxFallback, plans_count: plansCount };
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
  // The plans family is as long as the file's own plans are — the fixed list carries only its BASE key,
  // so the extra ones come from what is on the file (capped) unioned with what has already been pushed
  // (so a document since removed still shows its push record rather than vanishing from the panel).
  const plansShown = Math.min(Math.max(avail.plans_count || 0, 1), PLANS_MAX);
  const plansKeys = Array.from(new Set([
    ...Array.from({ length: plansShown }, (_, i) => (i === 0 ? PLANS_BASE : `${PLANS_BASE}:${i + 1}`)),
    ...links.map((r) => r.which).filter(isPlansSlot),
  ]));
  const allKeys = [...SLOTS.filter((w) => w !== PLANS_BASE), ...plansKeys];
  const slots = allKeys.map((w) => {
    const plansIdx = isPlansSlot(w) ? (w === PLANS_BASE ? 1 : Number(w.slice(PLANS_BASE.length + 1)) || 1) : 0;
    const isAvail = isPlansSlot(w) ? (avail.plans_count || 0) >= plansIdx : !!avail[w];
    const rec = byWhich[w] || null;
    return {
      which: w,
      label: w === 'appraisal_pdf' ? 'Appraisal PDF' : w === 'sow_xlsx' ? 'Scope of Work (Excel)'
        : w === 'sow_pdf' ? 'Scope of Work (PDF)'
        : (rec && rec.filename) ? rec.filename
        : (plansIdx > 1 ? `Plans & permits (${plansIdx})` : 'Plans & permits'),
      available: isAvail,
      missing: isAvail ? null : (w === 'appraisal_pdf' ? 'no_appraisal_pdf' : w === 'sow_xlsx' ? 'no_sow_excel'
        : w === 'sow_pdf' ? 'no_sow_pdf' : 'no_plans_permits'),
      generated: w === 'sow_xlsx' ? !!avail.sow_xlsx_generated : false,
      pushed: !!(rec && (rec.status === 'pushed' || rec.status === 'verified')),
      verified: !!(rec && rec.status === 'verified'),
      status: rec ? rec.status : 'not_pushed',
      sitewire_name: rec ? rec.sitewire_document_name : null,
      pushed_at: rec ? rec.pushed_at : null,
      last_error: rec ? rec.last_error : null,
    };
  });
  // NO SILENT CAPS: if the file carries more plans documents than one push will take, the panel says how
  // many are not going, rather than showing a tidy list that quietly omits them.
  const plansOverflow = Math.max(0, (avail.plans_count || 0) - PLANS_MAX);
  return { managed, enabled: !!cfg.sitewireDocsEnabled, web_configured: web.webConfigured(), slots,
    plans_count: avail.plans_count || 0, plans_max: PLANS_MAX, plans_overflow: plansOverflow };
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
  // A named slot, or EVERYTHING — and "everything" is decided after the gather, because how many plans
  // documents a file carries is a fact about the file, not a constant (see _pushDocumentsLocked).
  const which = opts.which && (SLOTS.includes(opts.which) || isPlansSlot(opts.which)) ? [opts.which] : null;

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
  // `which === null` means "everything this file has": the three fixed slots plus however many plans &
  // permits documents were actually found. `_plansOverflow` is bookkeeping, never a slot.
  const wanted = which || Object.keys(gathered).filter((k) => k !== '_plansOverflow');
  const toPush = wanted.map((w) => gathered[w]).filter(Boolean);
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
  // NO SILENT CAPS: a file carrying more plans documents than one push takes says so in its own result,
  // so a caller (and the coordinator's panel) can tell "everything went" from "most of it went".
  const plansOverflow = gathered._plansOverflow || 0;
  return { ok: true, managed: true, dryrun: !!cfg.sitewireDryrun, results, anyPushed,
    ...(plansOverflow ? { plansOverflow } : {}) };
}

/* PLANS & PERMITS REACH SITEWIRE WHENEVER THEY ARRIVE — a SWEEP, not a hook on every upload door
   (owner-directed 2026-08-21: "any time plans and permits are uploaded … it should be sent over to
   Sitewire as well").

   WHY A SWEEP. A document can land on a plans condition from at least four doors — the staff upload, the
   borrower's, the broker's, and a vendor's returned email — and there is no single place they all pass
   through (the SharePoint mirror is kicked separately at each one, which is exactly the hand-kept list
   this repo warns about). A door added next year would silently not push. One query, run on the worker's
   own cadence, covers every door there is and every door there will be.

   IT IS CHEAP WHEN THERE IS NOTHING TO DO, and that is what makes a sweep affordable: `pushDocuments`
   dedupes on the content hash and does not even open a Sitewire website session unless something
   genuinely needs uploading. So a file whose plans are already up there costs one query.

   IT PICKS FILES BY EVIDENCE, NOT BY A CLOCK: a managed file that holds a plans document which is newer
   than the newest plans push it has (or which has never had one). Bounded per tick, and it can never
   throw into the worker. */
async function autoPushPlansOnce(limit = 5, opts = {}) {
  // Returns { scanned, sent } — `scanned` is the ids the query selected, so a test can measure WHICH
  // files the sweep picks up without re-typing the predicate (a second copy would pass while the real
  // one drifted) and without a monkey-patch that a local function binding would ignore anyway.
  const none = { scanned: [], sent: 0 };
  if (!cfg.sitewireDocsEnabled) return none;
  if (!switches.on('SITEWIRE_ENABLED')) return none;
  if (!(switches.on('SITEWIRE_OUTBOUND_ENABLED') || cfg.sitewireDryrun)) return none;
  let rows = [];
  try {
    rows = (await db.query(
      `SELECT l.application_id AS id
         FROM sitewire_property_links l
        WHERE l.matched_by='created' AND l.sitewire_property_id IS NOT NULL
          AND COALESCE(l.lifecycle_state,'active')='active'
          AND EXISTS (
            SELECT 1 FROM documents d
             WHERE d.application_id = l.application_id
               AND d.is_current=true AND COALESCE(d.review_status,'') <> 'rejected'
               AND COALESCE(d.visibility,'') <> 'internal'
               AND d.checklist_item_id IN (
                     SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
                      WHERE ci.application_id = l.application_id
                        AND t.code IN ('rtl_p1_plans','draw_cond_plans_permits'))
               AND d.created_at > COALESCE((
                     SELECT max(sd.pushed_at) FROM sitewire_document_links sd
                      WHERE sd.application_id = l.application_id
                        AND (sd.which = 'plans_permits' OR sd.which LIKE 'plans\\_permits:%')), 'epoch'::timestamptz))
        ORDER BY l.pushed_at ASC NULLS FIRST
        LIMIT $1`, [Math.max(1, limit)])).rows;
  } catch (e) {
    console.warn('[sitewire] plans auto-push scan failed (non-fatal):', e && e.message);
    return none;
  }
  const scanned = rows.map((r) => r.id);
  let sent = 0;
  if (!opts.scanOnly) {
    for (const r of rows) {
      try {
        const out = await pushDocuments(r.id, { source: 'plans_auto' });
        if (out && out.ok) sent += 1;
      } catch (e) { console.warn(`[sitewire] plans auto-push failed (app=${r.id}, non-fatal):`, e && e.message); }
    }
  }
  return { scanned, sent };
}

module.exports = { pushDocuments, status, gatherAll, SLOTS, PLANS_BASE, PLANS_MAX, isPlansSlot, verifyPushedDocsOnce, autoPushPlansOnce,
  _internal: { gatherAppraisalPdf, gatherSowExcel, gatherSowPdf, gatherPlansPermits, plansDocName, verifyPresent, PLANS_WHERE } };

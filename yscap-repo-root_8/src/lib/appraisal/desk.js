'use strict';
/**
 * Appraisal-desk shared flow — the ONE place that turns an appraisal XML string into a stored
 * appraisal + PILOT findings + the two internal conditions + the advisory OCR note. Both the
 * staff appraisal route (POST /api/appraisal/:id/import) AND the appraisal-documents condition
 * (an XML dropped on its "Appraisal data file (XML)" slot auto-imports) call this, so the import
 * behaves identically no matter where the file comes from.
 *
 * Never overwrites the loan file (the blank-only shield lives in importAppraisal); the advisory
 * OCR only ever writes the verify-As-Is condition note. Materializing the two conditions uses the
 * canonical template_id insert (mirrors src/lib/vesting.js) — the templates are auto_apply='manual'
 * so they only attach here, on demand.
 */
const db = require('../../db');
const cfg = require('../../config');
const storage = require('../storage');
const { importAppraisal } = require('./import');
const { extract } = require('./extract');
const { ocrAsIsCandidate, buildOcrNote } = require('./ocr');
const { extractPhotos } = require('./photos');
const { crossCheckFlood } = require('./flood');
const X = require('./xml');

// Today as a 'YYYY-MM-DD' string from the DB (NY) — never new Date() in a date path.
async function todayNY() {
  try { return (await db.query(`SELECT to_char(now() AT TIME ZONE 'America/New_York','YYYY-MM-DD') d`)).rows[0].d; }
  catch (_) { return null; }
}

// Materialize an internal appraisal condition from its (auto_apply='manual') template. Idempotent
// — dedups on (application_id, template_id), exactly like src/lib/vesting.js ensureLlcCondition.
async function ensureAppraisalCondition(appId, code) {
  await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
        phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
        clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
     SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
            COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
            COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
            COALESCE(t.sort_order,455), t.tool_key, t.clickup_field_id,
            COALESCE(t.tpr_exclude,false), 'system', COALESCE(t.is_required,true), $1
       FROM checklist_templates t
      WHERE t.code=$2 AND t.is_active=true
        AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id=$1 AND ci.template_id=t.id)`,
    [appId, code]);
}

// Fire-and-forget advisory OCR: read a candidate As-Is off the PDF and attach it to the
// verify-As-Is condition as an [auto]-guarded note. Never writes the loan file, never throws.
function fireOcrAdvisory(appId, pdfB64, importedBy) {
  if (!pdfB64) return;
  ocrAsIsCandidate({ pdfBase64: pdfB64 })
    .then(async (adv) => {
      await db.query(
        `UPDATE checklist_items ci
            SET notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%' THEN $2 ELSE ci.notes END
           FROM checklist_templates t
          WHERE ci.template_id = t.id AND t.code = 'appraisal_as_is_verify' AND ci.application_id = $1`,
        [appId, buildOcrNote(adv)]);
      if (importedBy) {
        try {
          await db.query(
            `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
             VALUES ('staff',$1,'appraisal_ocr_advisory','application',$2,$3)`,
            [importedBy, appId, JSON.stringify({ attempted: !!adv.attempted, candidate: adv.candidate != null ? adv.candidate : null, confidence: adv.confidence || null })]);
        } catch (_) { /* audit best-effort */ }
      }
    })
    .catch((e) => console.error('[appraisal] OCR advisory failed (non-fatal):', e && e.message));
}

// Extract the subject + comp photos from the PDF, store each as a borrower-visible image
// document, and record it on appraisal_photos. Supersedes any earlier appraisal's extracted
// photos so a re-import doesn't pile up stale images. Returns the number stored. Awaitable so it
// can be tested; the caller (firePhotoExtraction) runs it fire-and-forget after the import.
async function extractAndStorePhotos(appraisalId, appId, pdfB64, importedBy) {
  if (!appraisalId || !pdfB64) return 0;
  const res = await extractPhotos(pdfB64);
  if (!res.attempted || !res.photos.length) return 0;
  const app = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0];
  const borrowerId = app ? app.borrower_id : null;
  // Retire images from any earlier appraisal on this file (keep only the current one's set).
  try {
    await db.query(
      `UPDATE documents SET is_current=false
        WHERE doc_kind='appraisal_photo' AND application_id=$1
          AND id IN (SELECT document_id FROM appraisal_photos ap JOIN appraisals a ON a.id=ap.appraisal_id
                      WHERE a.application_id=$1 AND a.id<>$2)`, [appId, appraisalId]);
  } catch (_) { /* best-effort */ }
  let stored = 0;
  for (const ph of res.photos) {
    try {
      const s = await storage.save(ph.png, { filename: `appraisal-photo-${ph.seq + 1}.png` });
      const doc = await db.query(
        `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,visibility)
         VALUES ($1,$2,$3,'image/png',$4,$5,$6,'staff',$7,'appraisal_photo','borrower') RETURNING id`,
        [appId, borrowerId, `appraisal-photo-${ph.seq + 1}.png`, ph.png.length, s.provider, s.ref, importedBy || null]);
      await db.query(
        `INSERT INTO appraisal_photos (appraisal_id, document_id, sequence, width, height) VALUES ($1,$2,$3,$4,$5)`,
        [appraisalId, doc.rows[0].id, ph.seq, ph.width, ph.height]);
      stored++;
    } catch (_) { /* per-photo best-effort */ }
  }
  return stored;
}

// Fire-and-forget wrapper: runs AFTER the import returns so it never slows the officer down.
// FEMA flood cross-check (fire-and-forget, gated by APPRAISAL_FLOOD_CHECK_ENABLED). Geocodes the
// subject address, reads the official FEMA zone, stores the comparison on the appraisals row, and
// raises a WARNING finding when the appraisal disagrees with FEMA on special-flood-hazard status.
// Best-effort and never-guess: unreachable services store nothing and raise nothing.
function fireFloodCheck(appraisalId, appId) {
  if (!cfg.appraisalFloodCheckEnabled || !appraisalId) return;
  (async () => {
    const row = (await db.query(
      `SELECT subject_address, subject_city, subject_state, subject_zip, flood_zone FROM appraisals WHERE id=$1`, [appraisalId])).rows[0];
    if (!row) return;
    const address = [row.subject_address, row.subject_city, row.subject_state, row.subject_zip].filter(Boolean).join(', ');
    if (!address) return;
    const r = await crossCheckFlood({ address, appraisalZone: row.flood_zone });
    if (!r.checked) return;                    // never store a guessed zone
    const cmp = r.comparison || {};
    await db.query(
      `UPDATE appraisals SET fema_flood_zone=$2, fema_flood_sfha=$3, fema_flood_agrees=$4, fema_flood_note=$5, fema_flood_checked_at=now()
         WHERE id=$1 AND superseded=false`,
      [appraisalId, r.femaZone, r.sfha, cmp.agrees, cmp.note]);
    if (cmp.kind === 'sfha_mismatch') {
      await db.query(
        `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, field, appraisal_value, file_value, title, how_to, blocks_ctc)
         SELECT $1,$2,'appraisal','flood_zone_mismatch','warning','flood_zone',$3,$4,$5,$6,false
          WHERE NOT EXISTS (SELECT 1 FROM appraisal_findings WHERE appraisal_id=$1 AND code='flood_zone_mismatch' AND status='open')
            AND EXISTS (SELECT 1 FROM appraisals WHERE id=$1 AND superseded=false)`,
        [appraisalId, appId, `FEMA zone ${r.femaZone}`, row.flood_zone ? `Appraisal zone ${row.flood_zone}` : null,
         'Flood zone disagrees with the FEMA flood map', cmp.note]);
    }
  })().catch(() => { /* best-effort advisory — never breaks the import */ });
}

function firePhotoExtraction(appraisalId, appId, pdfB64, importedBy) {
  if (!appraisalId || !pdfB64) return;
  extractAndStorePhotos(appraisalId, appId, pdfB64, importedBy)
    .catch((e) => console.error('[appraisal] photo extraction failed (non-fatal):', e && e.message));
}

/**
 * Run the full desk import from an XML string. Returns importAppraisal's result
 * ({ ok, appraisalId, summary, needsAsIsCondition, warnings, ... } or { ok:false, error }).
 * @param {{appId:string, xml:string, importedBy?:string, xmlDocumentId?:string,
 *          pdfDocumentId?:string, pdfBase64?:string, today?:string}} args
 */
async function runAppraisalImport(args) {
  const { appId, xml, importedBy, xmlDocumentId, pdfDocumentId, pdfBase64 } = args;
  const out = await importAppraisal(db, {
    applicationId: appId, xml, importedBy: importedBy || null,
    sourceXmlDocumentId: xmlDocumentId || null, pdfDocumentId: pdfDocumentId || null,
    today: args.today || (await todayNY()),
  });
  if (!out.ok) return out;
  await ensureAppraisalCondition(appId, 'appraisal_review_cleared');
  let embedded = null; try { embedded = X.embeddedPdfBase64(xml); } catch (_) { embedded = null; }
  let pdfB64 = pdfBase64 || embedded;
  // If no PDF was passed inline and none is embedded in the XML, but a PDF document was
  // uploaded to the appraisal condition's PDF slot (pdfDocumentId), load its bytes from storage
  // so the SEPARATELY-uploaded PDF still feeds photo extraction + the As-Is OCR. Best-effort —
  // a storage miss never breaks the import (the report is already built from the XML).
  if (!pdfB64 && pdfDocumentId) {
    try {
      const d = (await db.query('SELECT storage_ref FROM documents WHERE id=$1', [pdfDocumentId])).rows[0];
      if (d && d.storage_ref) { const buf = await storage.read(d.storage_ref); if (buf && buf.length) pdfB64 = buf.toString('base64'); }
    } catch (_) { /* best-effort: no PDF bytes → no photos, never a hard fail */ }
  }
  if (out.needsAsIsCondition) {
    await ensureAppraisalCondition(appId, 'appraisal_as_is_verify');
    fireOcrAdvisory(appId, pdfB64, importedBy);
  }
  firePhotoExtraction(out.appraisalId, appId, pdfB64, importedBy);
  fireFloodCheck(out.appraisalId, appId);
  return out;
}

// Recover the appraisal's PDF bytes from what we stored at import: the dedicated PDF document if
// one was uploaded, else the PDF embedded inside the stored source XML. Returns base64 or null.
async function pdfBytesForAppraisal(appr) {
  const loadDoc = async (id) => {
    if (!id) return null;
    try {
      const d = (await db.query('SELECT storage_ref FROM documents WHERE id=$1', [id])).rows[0];
      if (!d || !d.storage_ref) return null;
      const b = await storage.read(d.storage_ref);
      return b && b.length ? b : null;
    } catch (_) { return null; }
  };
  const pdf = await loadDoc(appr.pdf_document_id);
  if (pdf) return pdf.toString('base64');
  const xmlBuf = await loadDoc(appr.source_xml_document_id);
  if (xmlBuf) { try { const e = X.embeddedPdfBase64(xmlBuf.toString('utf8')); if (e) return e; } catch (_) { /* no embedded pdf */ } }
  return null;
}

// Re-pull the photos for a file's CURRENT appraisal on demand (staff "Pull photos" button, and
// the boot backfill below). Idempotent-ish: extractAndStorePhotos retires an older set and
// re-inserts; a file with no recoverable PDF simply yields 0. Returns the count stored.
async function repullAppraisalPhotos(appId) {
  const appr = (await db.query(
    `SELECT id, application_id, pdf_document_id, source_xml_document_id
       FROM appraisals WHERE application_id=$1 AND superseded=false ORDER BY imported_at DESC NULLS LAST LIMIT 1`, [appId])).rows[0];
  if (!appr) return 0;
  const pdfB64 = await pdfBytesForAppraisal(appr);
  if (!pdfB64) return 0;
  return extractAndStorePhotos(appr.id, appr.application_id, pdfB64, null);
}

// Boot backfill (previous AND future rule): every CURRENT appraisal that has a recoverable PDF but
// NO extracted photos gets its gallery filled. Bounded per boot (photo decode is CPU-heavy); it
// naturally drains because a filled appraisal drops out of the query. Best-effort, never throws.
async function backfillAppraisalPhotosOnce(limit = 25) {
  let scanned = 0, filled = 0, photos = 0;
  try {
    const rows = (await db.query(
      `SELECT a.id, a.application_id, a.pdf_document_id, a.source_xml_document_id
         FROM appraisals a
        WHERE a.superseded=false
          AND (a.pdf_document_id IS NOT NULL OR a.source_xml_document_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM appraisal_photos ap WHERE ap.appraisal_id=a.id AND ap.document_id IS NOT NULL)
          -- and not already attempted-with-no-result (so we don't re-decode a no-photo PDF each boot)
          AND NOT EXISTS (SELECT 1 FROM appraisal_photos ap WHERE ap.appraisal_id=a.id AND ap.category='backfill_none')
        ORDER BY a.imported_at DESC
        LIMIT $1`, [limit])).rows;
    for (const r of rows) {
      scanned++;
      try {
        const pdfB64 = await pdfBytesForAppraisal(r);
        if (!pdfB64) continue;                             // no decodable PDF (cheap check, no re-decode)
        const n = await extractAndStorePhotos(r.id, r.application_id, pdfB64, null);
        if (n > 0) { filled++; photos += n; }
        else {
          // Had a PDF but nothing extractable — drop a sentinel so the (CPU-heavy) decode isn't
          // retried on every boot. A real re-import creates a new appraisal row and re-attempts.
          try { await db.query(`INSERT INTO appraisal_photos (appraisal_id, category, caption) VALUES ($1,'backfill_none','no extractable photos found')`, [r.id]); } catch (_) { /* best-effort */ }
        }
      } catch (_) { /* per-appraisal best-effort */ }
    }
  } catch (_) { /* best-effort */ }
  return { scanned, filled, photos };
}

// Recover the appraisal's SOURCE XML bytes (the raw MISMO) from what we stored at import. Returns
// the XML string or null. Used by the comp-split backfill to re-run the extractor on old files.
async function xmlForAppraisal(appr) {
  if (!appr.source_xml_document_id) return null;
  try {
    const d = (await db.query('SELECT storage_ref FROM documents WHERE id=$1', [appr.source_xml_document_id])).rows[0];
    if (!d || !d.storage_ref) return null;
    const b = await storage.read(d.storage_ref);
    return b && b.length ? b.toString('utf8') : null;
  } catch (_) { return null; }
}

// Boot backfill (previous AND future rule): appraisals imported BEFORE the As-Is/ARV comp-grid split
// (or before a split fix) have every comp stored as comp_set='unknown' and comp_split_confidence
// NULL, so the report renders ONE mixed grid instead of the separate As-Is and ARV grids. Re-run the
// current extractor on each such appraisal's stored source XML and write back the per-comp comp_set
// (matched by seq) + the appraisal's split metadata. `comp_split_confidence IS NULL` reliably marks a
// pre-split row (a fresh import always sets it), and setting it here drains the row out of the query,
// so this self-terminates. Bounded per boot; per-appraisal transactional; best-effort, never throws.
async function backfillAppraisalCompSplitOnce(limit = 200) {
  let scanned = 0, split = 0;
  try {
    const rows = (await db.query(
      `SELECT a.id, a.source_xml_document_id
         FROM appraisals a
        WHERE a.superseded = false
          AND a.source_xml_document_id IS NOT NULL
          AND a.comp_split_confidence IS NULL
          AND EXISTS (SELECT 1 FROM appraisal_comparables c WHERE c.appraisal_id = a.id AND c.is_subject = false)
        ORDER BY a.imported_at DESC NULLS LAST
        LIMIT $1`, [limit])).rows;
    for (const r of rows) {
      scanned++;
      // If the source XML can't be recovered (bytes missing) or won't re-extract, we do NOT stamp
      // the confidence — the row stays NULL and is retried on a later boot, so a TRANSIENT storage
      // hiccup self-heals (a genuinely-broken appraisal is remedied by a re-import, which mints a
      // fresh row). Each such re-scan is cheap (one documents lookup + one storage read); the 200/boot
      // bound keeps it in check. A permanently-broken row re-scans indefinitely by design.
      const xml = await xmlForAppraisal(r);
      if (!xml) continue;
      let A;
      try { A = extract(xml); } catch (_) { continue; }
      if (!A || !A.ok || !Array.isArray(A.comparables)) continue;
      const bySeq = new Map();
      for (const c of A.comparables) { if (c.seq != null) bySeq.set(String(c.seq), c.comp_set || 'unknown'); }
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        for (const [seq, cs] of bySeq) {
          await client.query(
            `UPDATE appraisal_comparables SET comp_set = $3 WHERE appraisal_id = $1 AND seq = $2 AND is_subject = false`,
            [r.id, seq, cs]);
        }
        // Always stamp the split metadata (even 'single_grid'/'undetermined') so the row drains.
        await client.query(
          `UPDATE appraisals SET comp_split_confidence = $2, comp_split_needs_review = $3 WHERE id = $1`,
          [r.id, (A.compSplit && A.compSplit.confidence) || 'undetermined', A.compSplit ? !!A.compSplit.needsReview : false]);
        await client.query('COMMIT');
        if ([...bySeq.values()].some((v) => v === 'as_is') && [...bySeq.values()].some((v) => v === 'arv')) split++;
      } catch (_) { await client.query('ROLLBACK').catch(() => {}); }
      finally { client.release(); }
    }
  } catch (_) { /* best-effort */ }
  return { scanned, split };
}

// Undo the current appraisal import (owner-directed 2026-07-20): a WRONG appraisal
// was uploaded and must be removed before a replacement exists. Clears the findings
// + the imported appraisal data, restores the file fields the import changed, and
// resets the two internal appraisal conditions + the source documents so the
// appraisal-documents condition is ready for a fresh upload. Transactional.
async function undoAppraisalImport(appId, { actor = null } = {}) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const cur = (await client.query(
      `SELECT id, as_is_value, arv_value, appraiser_name FROM appraisals
        WHERE application_id=$1 AND superseded=false ORDER BY imported_at DESC NULLS LAST LIMIT 1`, [appId])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); return { ok: false, error: 'no active appraisal to remove' }; }

    // 1. Reverse any finding-resolution writes to the file (audited from/to). Newest
    //    first so each field lands on its pre-appraisal value. Whitelisted columns
    //    only (the field name comes from our own audit detail, gated here regardless).
    const REV = new Set(['arv', 'as_is_value', 'purchase_price', 'units', 'property_type']);
    const applies = (await client.query(
      `SELECT detail FROM audit_log WHERE action='appraisal_finding_apply' AND entity_id=$1 ORDER BY created_at DESC`, [appId])).rows;
    for (const row of applies) {
      const d = row.detail || {};
      if (d.field && REV.has(d.field)) {
        await client.query(`UPDATE applications SET ${d.field} = $2, updated_at=now() WHERE id=$1`, [appId, d.from == null ? null : d.from]);
      }
    }
    // 2. Undo the import's blank-fills (as_is_value / arv / appraiser_name) — back to
    //    NULL only where the file still shows exactly what THIS appraisal imported
    //    (nothing else changed it since; the import only ever fills a blank, so the
    //    previous value was NULL).
    if (cur.as_is_value != null) await client.query(`UPDATE applications SET as_is_value=NULL, updated_at=now() WHERE id=$1 AND as_is_value=$2`, [appId, cur.as_is_value]);
    if (cur.arv_value != null) await client.query(`UPDATE applications SET arv=NULL, updated_at=now() WHERE id=$1 AND arv=$2`, [appId, cur.arv_value]);
    if (cur.appraiser_name) await client.query(`UPDATE applications SET appraiser_name=NULL, updated_at=now() WHERE id=$1 AND appraiser_name=$2`, [appId, cur.appraiser_name]);

    // 3. Delete findings first (the db/154 guard blocks satisfying the review condition
    //    while an open fatal finding exists), then the appraisal row (cascade removes
    //    comparables / units / photos / any remaining findings).
    await client.query(`DELETE FROM appraisal_findings WHERE application_id=$1`, [appId]);
    await client.query(`DELETE FROM appraisals WHERE id=$1`, [cur.id]);

    // 4. Remove the two internal appraisal conditions (re-created on the next import).
    await client.query(
      `DELETE FROM checklist_items ci USING checklist_templates t
        WHERE ci.template_id=t.id AND ci.application_id=$1
          AND t.code IN ('appraisal_review_cleared','appraisal_as_is_verify')`, [appId]);

    // 5. Soft-remove the appraisal source documents so the appraisal-documents
    //    condition is clean for a fresh upload (kept in history; never hard-deleted).
    await client.query(
      `UPDATE documents SET is_current=false
        WHERE application_id=$1 AND is_current AND doc_kind IN ('appraisal_xml','appraisal_pdf','appraisal_photo')`, [appId]);

    // 6. Reopen the appraisal-documents condition — its evidence was just removed,
    //    so a prior sign-off no longer corresponds to any current document and the
    //    file must not clear-to-close on it. (Same class as the reject/supersede
    //    reopen in the document routes.)
    await client.query(
      `UPDATE checklist_items ci
          SET status='outstanding', signed_off_at=NULL, signed_off_by=NULL,
              reviewed_at=NULL, reviewed_by=NULL, updated_at=now()
         FROM checklist_templates t
        WHERE ci.template_id=t.id AND ci.application_id=$1
          AND t.code='rtl_cond_appraisaldocs'`, [appId]);

    await client.query('COMMIT');
    return { ok: true, removedAppraisalId: cur.id };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { ensureAppraisalCondition, runAppraisalImport, undoAppraisalImport, extractAndStorePhotos, repullAppraisalPhotos, backfillAppraisalPhotosOnce, backfillAppraisalCompSplitOnce, todayNY };

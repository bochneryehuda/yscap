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
const switches = require('../integrations/switches'); // runtime on/off (env default unless flipped)
const storage = require('../storage');
const { importAppraisal } = require('./import');
const { extract } = require('./extract');
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

/**
 * THE As-Is READ (owner-directed 2026-07-28) — replaces the old advisory-note-only OCR pass.
 *
 * The reader ladder (./as-is-reader.js) resolves the As-Is from the data file first, then the report
 * PDF with the strongest OCR + AI. When it is CONFIDENT it writes that value onto the file — lower or
 * higher — and this condition becomes the human's re-review; when it is not confident, nothing is
 * filled in and the condition asks an officer to read it off the report and enter it.
 * ./as-is-desk.js owns both halves.
 *
 * The condition is materialized HERE (this module is the reviewed appraisal-desk condition writer)
 * BEFORE the settle runs, so the settle always has an instance whose note/hint it can refresh — and
 * only ever after an appraisal actually exists on the file, which is the owner's "this condition
 * should only be relevant after the appraisal has been uploaded".
 *
 * Fire-and-forget: the officer's import never waits on it, and a failure can never break the import.
 */
function fireAsIsRead(appId, pdfB64, importedBy) {
  runAsIsRead(appId, { pdfBase64: pdfB64 || null, actorId: importedBy || null })
    .catch((e) => console.error('[appraisal] as-is read failed (non-fatal):', e && e.message));
}

// Awaitable form (used by fireAsIsRead, the route's "re-read" action and the boot sweep). The
// condition CREATOR is handed to the settle as a callback so the INSERT stays in this module — the
// reviewed appraisal-desk condition writer — while the decision about whether one is needed stays
// with the settle that made it.
function runAsIsRead(appId, opts = {}) {
  return require('./as-is-desk').settleAsIs(appId, {
    ...opts,
    ensureCondition: (id) => ensureAppraisalCondition(id, 'appraisal_as_is_verify'),
  });
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
  // Retire EVERY existing appraisal_photo on this file before inserting the fresh set — including
  // this appraisal's OWN prior photos. The old query excluded the current appraisal (a.id<>$2), so a
  // same-appraisal "Pull photos" refresh left the old set live and the gallery doubled (shown twice
  // to staff AND the borrower). Runs BEFORE the insert loop below, so the fresh rows are unaffected.
  try {
    await db.query(
      `UPDATE documents SET is_current=false
        WHERE doc_kind='appraisal_photo' AND application_id=$1
          AND id IN (SELECT document_id FROM appraisal_photos ap JOIN appraisals a ON a.id=ap.appraisal_id
                      WHERE a.application_id=$1)`, [appId]);
  } catch (_) { /* best-effort */ }
  let stored = 0;
  for (const ph of res.photos) {
    try {
      const s = await storage.save(ph.png, { filename: `appraisal-photo-${ph.seq + 1}.png` });
      // These are photos the SYSTEM extracted from the appraisal PDF — not human uploads, so they
      // must never sit in the document-review queue waiting to be accepted one by one. Store them
      // pre-ACCEPTED (review_status='accepted') and marked source_type='system' (which also hides the
      // "Replace" action). Without this they default to review_status='pending' (db/013) and every
      // extracted image shows an Accept button on the file's Documents list.
      const doc = await db.query(
        `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,visibility,source_type,review_status,reviewed_at)
         VALUES ($1,$2,$3,'image/png',$4,$5,$6,'staff',$7,'appraisal_photo','borrower','system','accepted',now()) RETURNING id`,
        [appId, borrowerId, `appraisal-photo-${ph.seq + 1}.png`, ph.png.length, s.provider, s.ref, importedBy || null]);
      // `category` records WHAT the image is (owner-reported 2026-08-02: the appraiser's signature
      // was coming up as the property's main picture). extractPhotos already ordered real
      // photographs ahead of the form's own artwork, so sequence 0 is a photograph; storing the
      // classification as well means the gallery can label a map/sketch/signature honestly and the
      // hero can insist on a photograph rather than trusting position alone.
      await db.query(
        `INSERT INTO appraisal_photos (appraisal_id, document_id, sequence, width, height, category) VALUES ($1,$2,$3,$4,$5,$6)`,
        [appraisalId, doc.rows[0].id, ph.seq, ph.width, ph.height, ph.kind === 'graphic' ? 'graphic' : 'photo']);
      stored++;
    } catch (e) { console.error('[appraisal] photo store failed (non-fatal, continuing):', e && e.message); }
  }
  return stored;
}

// Fidelis flood-zone advisory (owner-directed 2026-07-27). On a Fidelis file the flood cert is
// absent until a flood zone is proven, at which point it is REQUIRED (db/335) — the engine
// re-evaluated just above normally attaches it. This is the BACKSTOP for the two states the engine
// cannot fix itself: a flood zone known with no condition on the file, and a flood zone known while
// the existing condition is still marked optional by db/335 §3 (duplicate suppression means the
// engine neither re-issues it nor rewrites is_required). It records an ADVISORY on the file's AI
// Findings panel and WITHDRAWS itself when it stops being true, which is why it is safe (and
// correct) to call on every import — a re-imported appraisal that no longer shows a flood zone
// closes the old advisory.
// Best-effort and never throws: it uses the pool directly (no transaction of its own) and a
// failure must never affect the appraisal import that triggered it.
async function fireFidelisFloodAdvisory(appId) {
  if (!appId) return;
  try {
    await require('../underwriting/fidelis-flood-advisory').syncFidelisFloodAdvisory(db, appId);
  } catch (e) { console.error('[appraisal] fidelis flood advisory (non-fatal):', e && e.message); }
}

// Fire-and-forget wrapper: runs AFTER the import returns so it never slows the officer down.
// FEMA flood cross-check (fire-and-forget, gated by APPRAISAL_FLOOD_CHECK_ENABLED). Geocodes the
// subject address, reads the official FEMA zone, stores the comparison on the appraisals row, and
// raises a WARNING finding when the appraisal disagrees with FEMA on special-flood-hazard status.
// Best-effort and never-guess: unreachable services store nothing and raise nothing.
function fireFloodCheck(appraisalId, appId) {
  if (!switches.on('APPRAISAL_FLOOD_CHECK_ENABLED') || !appraisalId) return;
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
    // A newly-known flood zone (SFHA) makes the flood-certificate condition
    // required on EVERY program — re-run the Condition Center so it attaches now
    // rather than waiting for the next file edit (db/207 + engine.in_flood_zone).
    try { await require('../conditions/engine').evaluateApplication(appId, { reason: 'appraisal_flood_check', notify: false }); } catch (_) {}
    // On a FIDELIS file the evaluate above is what FORCES the cert on (db/335: a proven
    // flood zone requires it regardless of the capital partner). This lays the advisory
    // for the two cases it can't fix — no condition on the file, or an existing one still
    // marked optional — right now rather than on the next staff file view (owner 2026-07-27).
    await fireFidelisFloodAdvisory(appId);
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
  // Note-buyer appraisal checks (EMCAP — owner-directed 2026-07-30): evaluated off the STORED
  // rows the import just wrote, so the same sync re-runs identically when the note buyer changes
  // later. AWAITED so the buyer's findings exist before the route answers (they count toward the
  // enforced appraisal-review gate); its own try/catch inside — a failure never breaks the import.
  await require('./note-buyer-checks').syncNoteBuyerFindings(db, appId);
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
  // THE As-Is READ runs on EVERY import, not only when the data file was silent (owner-directed
  // 2026-07-28) — a definite XML As-Is still has to be compared with what the file currently says.
  fireAsIsRead(appId, pdfB64, importedBy);
  firePhotoExtraction(out.appraisalId, appId, pdfB64, importedBy);
  fireFloodCheck(out.appraisalId, appId);
  // The appraiser's OWN stated flood zone is on the row the moment the XML is parsed, with no
  // FEMA call involved — so the Fidelis advisory must also run here, not only inside
  // fireFloodCheck. fireFloodCheck is gated on APPRAISAL_FLOOD_CHECK_ENABLED and returns early
  // when the geocode/FEMA lookup is unreachable, which would otherwise leave an appraisal that
  // plainly states zone AE raising nothing at all. Fire-and-forget for the same reason as the
  // others: the officer's import never waits on an advisory.
  fireFidelisFloodAdvisory(appId).catch(() => { /* best-effort */ });
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

// PREVIOUS FILES: re-classify a gallery that was extracted before photographs were told apart from
// the form's own artwork (owner-reported 2026-08-02 — the appraiser's signature was showing as the
// property's main picture). Those rows were stored in raw PAGE order with no `category`, so the
// signature on the certification page still outranks the subject photo page and no amount of
// front-end logic can fix a set that was ordered wrong on the way in. Re-pull the PDF and re-store:
// extractAndStorePhotos retires the old set and writes the fresh, classified, photographs-first one.
//
// SELF-DRAINING by construction — an appraisal drops out of the query the moment ANY of its photo
// rows carries a category, which the re-pull always writes. Bounded per boot (a PDF decode is
// CPU-heavy) and best-effort: a file whose PDF can no longer be recovered is stamped so it is not
// re-decoded on every boot, and nothing here can throw.
async function backfillAppraisalPhotoKindsOnce(limit = 25) {
  let scanned = 0, refreshed = 0, photos = 0;
  try {
    const rows = (await db.query(
      `SELECT a.id, a.application_id, a.pdf_document_id, a.source_xml_document_id
         FROM appraisals a
        WHERE a.superseded=false
          AND (a.pdf_document_id IS NOT NULL OR a.source_xml_document_id IS NOT NULL)
          -- has a real stored gallery …
          AND EXISTS (SELECT 1 FROM appraisal_photos ap WHERE ap.appraisal_id=a.id AND ap.document_id IS NOT NULL)
          -- … and NOT ONE row of it has been classified (i.e. it predates this change)
          AND NOT EXISTS (SELECT 1 FROM appraisal_photos ap WHERE ap.appraisal_id=a.id AND ap.category IS NOT NULL)
        ORDER BY a.imported_at DESC
        LIMIT $1`, [limit])).rows;
    for (const r of rows) {
      scanned++;
      try {
        const pdfB64 = await pdfBytesForAppraisal(r);
        if (!pdfB64) {
          // The PDF is gone, so the gallery can never be re-classified. Stamp the EXISTING rows
          // rather than leave them uncategorized, or this appraisal is re-scanned every boot
          // forever. 'unclassified' is honest: kept, position unchanged, kind unknown.
          try { await db.query(`UPDATE appraisal_photos SET category='unclassified' WHERE appraisal_id=$1 AND category IS NULL`, [r.id]); } catch (_) { /* best-effort */ }
          continue;
        }
        const n = await extractAndStorePhotos(r.id, r.application_id, pdfB64, null);
        if (n > 0) { refreshed++; photos += n; }
        else { try { await db.query(`UPDATE appraisal_photos SET category='unclassified' WHERE appraisal_id=$1 AND category IS NULL`, [r.id]); } catch (_) { /* best-effort */ } }
      } catch (_) { /* per-appraisal best-effort */ }
    }
  } catch (_) { /* best-effort */ }
  return { scanned, refreshed, photos };
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

// Previous files (owner-directed 2026-07-30): run the note-buyer appraisal checks (EMCAP)
// for open EMCAP files that already carry a current appraisal but have never had the
// note-buyer findings evaluated (no source='note_buyer' rows at all, any status). One sync per
// file; the sync itself diffs by code and honors human decisions, so this is idempotent and a
// second boot is a fast no-op (the file then HAS rows — even if all were later resolved).
// Bounded per boot; never throws.
async function backfillNoteBuyerFindingsOnce(limit = 100) {
  let scanned = 0, synced = 0;
  try {
    // The candidate query PRE-FILTERS to plausible EMCAP labels in SQL. Without it the window
    // fills with files that will never gain a row (every other note buyer), which both starves
    // a genuinely older EMCAP file out of the LIMIT forever and re-scans the same non-EMCAP
    // files on every boot (pre-merge audit F5). The SQL filter is deliberately LOOSE — the
    // authoritative test stays `isEmcapNoteBuyer` in JS below, so a label the prefix match
    // would accept can never be excluded here by a normalization difference (the SQL strips
    // the same non-alphanumerics normNoteBuyer does before comparing).
    const rows = (await db.query(
      `SELECT a.id
         FROM applications a
        WHERE a.deleted_at IS NULL
          AND a.status NOT IN ('clear_to_close', 'funded', 'declined', 'withdrawn', 'cancelled')
          AND a.lender IS NOT NULL
          AND lower(regexp_replace(a.lender, '[^a-zA-Z0-9]', '', 'g')) LIKE 'emcap%'
          AND EXISTS (SELECT 1 FROM appraisals ap WHERE ap.application_id = a.id AND ap.superseded = false)
          AND NOT EXISTS (SELECT 1 FROM appraisal_findings af
                           WHERE af.application_id = a.id AND af.source = 'note_buyer')
        ORDER BY a.updated_at DESC NULLS LAST
        LIMIT $1`, [limit])).rows;
    const nbChecks = require('./note-buyer-checks');
    const registry = require('../conditions/field-registry');
    for (const r of rows) {
      scanned++;
      // The authoritative EMCAP test runs in JS (isEmcapNoteBuyer is a prefix match on the
      // shared normalizer — the SQL above only narrows the candidate window).
      const app = (await db.query(`SELECT lender FROM applications WHERE id = $1`, [r.id])).rows[0];
      if (!app || !registry.isEmcapNoteBuyer(app.lender)) continue;
      const res = await nbChecks.syncNoteBuyerFindings(db, r.id);
      if (res && (res.added || res.carried)) synced++;
    }
  } catch (_) { /* best-effort */ }
  return { scanned, synced };
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
      `SELECT id, as_is_value, arv_value, appraiser_name, as_is_applied, as_is_applied_value, as_is_file_value_before,
              arv_applied, arv_applied_value, arv_file_value_before
         FROM appraisals
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
    //     …EXCEPT where the appraisal desk RECORDED what it wrote (db/353 + db/354). Since 2026-07-28 the
    //     As-Is and the ARV are not blank-filled but REWRITTEN, so `as_is_applied_value` /
    //     `arv_applied_value` carry the truth: what PILOT put there, and what the file showed before.
    //     That record wins — blanking the field instead would throw away the value it replaced. Each
    //     restore is pinned to the exact value PILOT wrote, so a human's later correction is kept.
    //     A VALUE PILOT DID NOT WRITE IS NOT PILOT'S TO REMOVE. The old rule — "blank it when the file
    //     equals the appraisal, because the import only ever filled a blank" — stopped being true the
    //     day the desk started making the file AGREE with the appraisal: equal became the normal
    //     state, so that rule deleted As-Is and ARV values officers had typed by hand, including on
    //     the very condition that asked them to. Both the desk's writes and the import's blank-fill
    //     now record themselves in these columns, so there is exactly one thing to reverse.
    //     Appraisals imported BEFORE that recording existed carry no record, so db/356 writes the
    //     one they never got — ONCE, and only where the old rule would have fired (the file still
    //     shows exactly what the appraisal imported and the desk has never touched the row), which
    //     keeps the undo behaving identically on the back book.
    if (cur.as_is_applied && cur.as_is_applied_value != null) {
      await client.query(
        `UPDATE applications SET as_is_value=$3, updated_at=now() WHERE id=$1 AND as_is_value=$2`,
        [appId, cur.as_is_applied_value, cur.as_is_file_value_before]);
    }
    if (cur.arv_applied && cur.arv_applied_value != null) {
      await client.query(
        `UPDATE applications SET arv=$3, updated_at=now() WHERE id=$1 AND arv=$2`,
        [appId, cur.arv_applied_value, cur.arv_file_value_before]);
    }
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

// GOING FORWARD ONLY (owner-directed 2026-07-28: *"Only make this going forward"*) — a DELIBERATE,
// owner-granted exception to the standing "previous AND future" rule, for one reason: this sweep
// WRITES loan values, and re-reading the whole back book would rewrite numbers on files people have
// already worked, all at once, with nobody watching. New imports get read; old appraisals are left
// alone unless someone asks. It is therefore OFF by default (`APPRAISAL_ASIS_SWEEP_FILES=0`) and is
// no longer called at boot; set that env var and call it to run a bounded pass by hand.
//
// Two tiers, cheapest first:
//   1. FREE — the appraisal's data file already states a definite As-Is. No OCR, no AI, no storage
//      read: just measure it against the purchase price and apply the owner's rule. Unbounded-ish.
//   2. PAID — the data file was silent, so the report PDF has to be read with OCR (and possibly AI).
//      Bounded hard per boot (APPRAISAL_ASIS_BACKFILL_FILES, default 5) because reading a 30 MB
//      appraisal costs real money; the queue drains a little on every deploy.
// Both stamp `as_is_read_at`, which is what drains each row out of the query, so this self-terminates
// and is safe to run on every boot. Terminal / deleted files are skipped (their As-Is is settled, and
// the file freeze would refuse the write anyway). Best-effort, never throws.
// Deliberately EARLY-STAGE ONLY. `approved` and `clear_to_close` are excluded because on those files
// the write would be refused by the freeze anyway, but the CONDITION would still attach — a fresh,
// required, uncleared item lands in `advancementBlockers` and would block clear-to-close and funding
// on files that were ready to fund, for a reading nobody asked for. `on_hold` is paused by
// definition. A file that comes back to life gets read on its next import or on demand.
const ASIS_SWEEP_STATUSES = ['file_intake', 'new', 'in_review', 'processing', 'underwriting'];

async function backfillAsIsReadsOnce({ freeLimit = null, pdfLimit = null } = {}) {
  const free = freeLimit == null ? cfg.appraisalAsIsSweepFiles : freeLimit;
  const paid = pdfLimit == null ? cfg.appraisalAsIsBackfillFiles : pdfLimit;
  const out = { free: 0, paid: 0, applied: 0 };
  const sweep = async (definite, limit) => {
    if (!limit) return;
    let rows = [];
    try {
      rows = (await db.query(
        `SELECT a.application_id
           FROM appraisals a
           JOIN applications app ON app.id = a.application_id
          WHERE a.superseded = false
            AND a.as_is_read_at IS NULL
            AND app.deleted_at IS NULL
            AND app.status = ANY($2::text[])
            -- COALESCE: with as_is_value set but as_is_confidence NULL the bare expression is SQL
            -- NULL, which equals neither true nor false, so the row would fall out of BOTH tiers and
            -- never be swept. The exact three-valued-logic trap CLAUDE.md documents for doc_kind.
            AND COALESCE(a.as_is_value IS NOT NULL AND a.as_is_confidence = 'definite', false) = $3
          ORDER BY a.imported_at DESC NULLS LAST
          LIMIT $1`, [limit, ASIS_SWEEP_STATUSES, definite])).rows;
    } catch (_) { return; }                       // pre-migration boot: the columns aren't there yet
    for (const r of rows) {
      try {
        const res = await runAsIsRead(r.application_id, {});
        if (definite) out.free++; else out.paid++;
        if (res && res.applied) out.applied++;
      } catch (_) { /* per-file best-effort */ }
    }
  };
  await sweep(true, free);
  await sweep(false, paid);
  return out;
}

module.exports = { ensureAppraisalCondition, runAppraisalImport, undoAppraisalImport, extractAndStorePhotos, repullAppraisalPhotos, backfillAppraisalPhotosOnce, backfillAppraisalPhotoKindsOnce, backfillAppraisalCompSplitOnce, backfillNoteBuyerFindingsOnce, backfillAsIsReadsOnce, runAsIsRead, pdfBytesForAppraisal, xmlForAppraisal, todayNY };

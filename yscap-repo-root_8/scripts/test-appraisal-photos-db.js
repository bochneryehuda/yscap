/**
 * DB test for the photo-extraction INTEGRATION (src/lib/appraisal/desk.extractAndStorePhotos):
 * a real appraisal PDF's photos are stored as borrower-visible image documents + appraisal_photos
 * rows, and the GET join surfaces them. Needs DATABASE_URL + an appraisal XML that still carries
 * its embedded PDF (the stripped corpus has none — this SKIPS cleanly when no such file exists).
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-photos-db (no DATABASE_URL)'); process.exit(0); }
const fs = require('fs');
const { execSync } = require('child_process');
const { Pool } = require('pg');
const { embeddedPdfBase64 } = require('../src/lib/appraisal/xml');
const { importAppraisal } = require('../src/lib/appraisal/import');
const { extractAndStorePhotos } = require('../src/lib/appraisal/desk');

// Find an appraisal XML that still embeds a PDF (search the corpus; skip if none).
function findEmbeddedXml() {
  const roots = [
    '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals',
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let files = [];
    try { files = execSync(`find "${root}" -iname "*.xml"`, { maxBuffer: 8 << 20 }).toString().trim().split('\n').filter(Boolean); } catch (_) { continue; }
    for (const f of files) {
      try { if (embeddedPdfBase64(fs.readFileSync(f, 'utf8'))) return f; } catch (_) { /* skip */ }
    }
  }
  return null;
}

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  const xmlPath = findEmbeddedXml();
  if (!xmlPath) { console.log('SKIP test-appraisal-photos-db (no embedded-PDF appraisal in corpus)'); process.exit(0); }
  const xml = fs.readFileSync(xmlPath, 'utf8');
  const pdfB64 = embeddedPdfBase64(xml);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const bid = (await pool.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Photo','Test',$1) RETURNING id`, [`photo-${process.pid}@example.test`])).rows[0].id;
    const appId = (await pool.query(
      `INSERT INTO applications (borrower_id, property_address, property_type, loan_type)
       VALUES ($1,$2,'SFR','rtl') RETURNING id`, [bid, JSON.stringify({ line1: '1 Test St', city: 'New Haven', state: 'CT' })])).rows[0].id;

    const out = await importAppraisal({ query: (t, p) => pool.query(t, p) }, { applicationId: appId, xml, today: '2026-07-19' });
    assert(out.ok, 'appraisal imported');

    const stored = await extractAndStorePhotos(out.appraisalId, appId, pdfB64, bid);
    assert(stored > 0, `photos extracted + stored (${stored})`);

    const rows = (await pool.query(
      `SELECT ap.document_id, ap.width, ap.height, d.doc_kind, d.content_type, d.visibility, d.size_bytes
         FROM appraisal_photos ap JOIN documents d ON d.id=ap.document_id
        WHERE ap.appraisal_id=$1 ORDER BY ap.sequence`, [out.appraisalId])).rows;
    assert(rows.length === stored, 'appraisal_photos rows match stored count');
    assert(rows.every((r) => r.doc_kind === 'appraisal_photo'), 'every photo doc has doc_kind=appraisal_photo');
    assert(rows.every((r) => r.content_type === 'image/png'), 'every photo doc is image/png');
    assert(rows.every((r) => r.visibility === 'borrower'), 'every photo doc is borrower-visible');
    assert(rows.every((r) => r.width > 0 && r.height > 0 && r.size_bytes > 0), 'every photo has real dimensions + bytes');

    // The GET join (what the report reads) surfaces them.
    const getRows = (await pool.query(
      `SELECT ap.id, ap.document_id, ap.width, ap.height FROM appraisal_photos ap JOIN documents d ON d.id=ap.document_id
        WHERE ap.appraisal_id=$1 AND d.is_current AND ap.document_id IS NOT NULL ORDER BY ap.sequence`, [out.appraisalId])).rows;
    assert(getRows.length === stored, 'GET join returns all current photos');

    // Re-import supersedes prior photos (they drop out of the current set).
    const out2 = await importAppraisal({ query: (t, p) => pool.query(t, p) }, { applicationId: appId, xml, today: '2026-07-19' });
    await extractAndStorePhotos(out2.appraisalId, appId, pdfB64, bid);
    const oldCurrent = (await pool.query(
      `SELECT count(*)::int n FROM appraisal_photos ap JOIN documents d ON d.id=ap.document_id
        WHERE ap.appraisal_id=$1 AND d.is_current`, [out.appraisalId])).rows[0].n;
    assert(oldCurrent === 0, 'a re-import retires the prior appraisal\'s photos (no stale current images)');

    await pool.query(`DELETE FROM applications WHERE borrower_id=$1`, [bid]);
    await pool.query(`DELETE FROM borrowers WHERE id=$1`, [bid]);
  } catch (e) { console.log('FAIL threw:', e.message); failures++; }
  finally { await pool.end(); }
  console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL photos-DB assertions passed'}`);
  process.exit(failures ? 1 : 0);
})();

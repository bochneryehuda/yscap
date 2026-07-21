/**
 * TPR export — EVERYTHING-on-the-file selection (owner-directed 2026-07-16).
 * Every current document ships regardless of review state or source: internal
 * conditions (fraud report), borrower conditions, loose attachments, vesting +
 * LAYERED entity docs, borrower/co-borrower profile docs. Deliberate
 * exclusions hold: rejected, superseded, chat attachments, tpr_exclude items
 * (ISKA / investor structure), prior export artifacts.
 * Run: node scripts/test-tpr-export.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-tpr';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

async function main() {
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const storage = require(REPO + '/src/lib/storage');
  const { unzip } = require(REPO + '/src/lib/zip');
  const tpr = require(REPO + '/src/lib/tpr-export');

  // --- pure-function unit checks (no DB) — the category map + integrity guard.
  const cat = tpr.categoryFor;
  ok(cat({ doc_kind: 'photo_id' }) === 'ID', 'categoryFor: photo_id → ID');
  ok(cat({ doc_kind: 'term_sheet_signed' }) === 'Term Sheet', 'categoryFor: signed term sheet → Term Sheet');
  ok(cat({ doc_kind: 'appraisal_pdf' }) === 'Appraisal', 'categoryFor: appraisal_pdf → Appraisal');
  ok(cat({ template_code: 'rtl_cond_fraud', slot_label: 'criminal' }) === 'Criminal Check', 'categoryFor: fraud criminal slot → Criminal Check');
  ok(cat({ template_code: 'rtl_cond_fraud', slot_label: 'background' }) === 'Background Check', 'categoryFor: fraud background slot → Background Check');
  ok(cat({ template_code: 'rtl_cond_title' }) === 'TITLE', 'categoryFor: title condition → TITLE');
  ok(cat({ template_code: 'rtl_cond_insurance' }) === 'Insurance', 'categoryFor: insurance → Insurance');
  ok(cat({ template_code: 'rtl_cond_flood' }) === 'Flood Cert', 'categoryFor: flood → Flood Cert');
  ok(cat({ template_code: 'rtl_cond_credit' }) === 'Credit Report', 'categoryFor: credit → Credit Report');
  ok(cat({ template_code: 'rtl_p3_assets' }) === 'Bank Statements', 'categoryFor: assets → Bank Statements');
  ok(cat({ template_code: 'rtl_p1_contract' }) === 'Contract & Assignment', 'categoryFor: contract → Contract & Assignment');
  ok(cat({ template_code: 'cond_emd_corrfirst' }) === 'Contract & Assignment', 'categoryFor: EMD → Contract & Assignment');
  ok(cat({ template_code: 'rtl_p3_sow1' }) === 'Scope of Work', 'categoryFor: SOW → Scope of Work');
  ok(cat({ template_code: 'rtl_p1_llc' }) === 'LLC', 'categoryFor: LLC condition → LLC');
  ok(cat({ llc_id: 'x' }) === 'LLC', 'categoryFor: any entity doc → LLC');
  ok(cat({ template_code: 'rtl_cond_signed_app' }) === 'Application', 'categoryFor: signed app → Application');
  ok(cat({ filename: 'Title Insurance Policy.pdf' }) === 'TITLE', 'categoryFor: loose "title insurance" → TITLE (not Insurance)');
  ok(cat({ filename: 'Hazard Insurance.pdf' }) === 'Insurance', 'categoryFor: loose hazard insurance → Insurance');
  ok(cat({ filename: 'mystery-doc.pdf' }) === 'Other Documents', 'categoryFor: unknown → Other Documents');
  ok(/PDF/.test(tpr.integrityIssue({ filename: 'x.pdf' }, Buffer.from('<html>nope')) || ''), 'integrity: HTML masquerading as .pdf is flagged');
  ok(tpr.integrityIssue({ filename: 'x.pdf' }, Buffer.from('%PDF-1.7 ok')) === null, 'integrity: real %PDF header passes');
  ok(/size mismatch/.test(tpr.integrityIssue({ filename: 'x.bin', size_bytes: 999 }, Buffer.from('abc')) || ''), 'integrity: recorded-vs-packed size mismatch flagged');

  const B = uuid(), CB = uuid(), APP = uuid(), LLC = uuid(), OWNER_LLC = uuid(), TR = uuid();
  const ids = [];
  async function doc(name, fields) {
    const { ref, provider } = await storage.save(Buffer.from('doc:' + name), { filename: name });
    const id = uuid(); ids.push(id);
    const cols = { id, filename: name, storage_provider: provider, storage_ref: ref, uploaded_by_kind: 'staff', ...fields };
    const keys = Object.keys(cols);
    await db.query(`INSERT INTO documents (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
      keys.map(k => cols[k]));
    return id;
  }

  try {
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Tpr','Main',$2),($3,'Tpr','Co',$4)`,
      [B, `tpr_${B.slice(0, 8)}@x.test`, CB, `tprco_${CB.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO llcs (id,borrower_id,llc_name) VALUES ($1,$2,'TPR Vesting LLC'),($3,$2,'TPR Owner LLC')`, [LLC, B, OWNER_LLC]);
    // layered entity: OWNER_LLC owns the vesting LLC (db/094)
    await db.query(`INSERT INTO llc_members (id,llc_id,full_name,ownership_pct,owner_llc_id) VALUES ($1,$2,'TPR Owner LLC',100,$3)`, [uuid(), LLC, OWNER_LLC]);
    await db.query(`INSERT INTO applications (id,borrower_id,co_borrower_id,llc_id,property_address) VALUES ($1,$2,$3,$4,$5)`,
      [APP, B, CB, LLC, JSON.stringify({ line1: '12 Test Ln', city: 'Testville', state: 'NJ', zip: '07000' })]);
    await db.query(`INSERT INTO track_records (id,borrower_id,property_address,deal_type) VALUES ($1,$2,$3,'flip')`,
      [TR, B, JSON.stringify({ line1: '9 Prior Rd', city: 'Testville', state: 'NJ' })]);

    // A FRAUD internal condition item on the file (from the real template so db/120's flip applies).
    const ft = (await db.query(`SELECT id, tpr_exclude FROM checklist_templates WHERE code='rtl_cond_fraud' LIMIT 1`)).rows[0];
    ok(ft && ft.tpr_exclude === false, 'db/120: rtl_cond_fraud template is tpr_exclude=false');
    const FRAUD_CI = uuid();
    await db.query(`INSERT INTO checklist_items (id,application_id,template_id,label,item_kind,audience,status,tpr_exclude,scope)                    VALUES ($1,$2,$3,'Fraud Report','document','staff','received',false,'application')`, [FRAUD_CI, APP, ft ? ft.id : null]);
    // An ISKA-style item that stays deliberately excluded.
    const ISKA_CI = uuid();
    await db.query(`INSERT INTO checklist_items (id,application_id,label,item_kind,audience,status,tpr_exclude,scope)
                    VALUES ($1,$2,'ISKA','document','staff','received',true,'application')`, [ISKA_CI, APP]);

    const dFraud = await doc('fraud-report.pdf', { application_id: APP, borrower_id: B, checklist_item_id: FRAUD_CI, review_status: 'pending', is_current: true, source_type: 'staff_upload', visibility: 'internal' });
    const dAccepted = await doc('accepted-borrower.pdf', { application_id: APP, borrower_id: B, review_status: 'accepted', is_current: true, source_type: 'staff_upload', visibility: 'borrower' });
    const dLoose = await doc('loose-pending.pdf', { application_id: APP, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload', visibility: 'staff_only' });
    const dRejected = await doc('rejected.pdf', { application_id: APP, borrower_id: B, review_status: 'rejected', is_current: true, source_type: 'staff_upload' });
    const dSuperseded = await doc('superseded.pdf', { application_id: APP, borrower_id: B, review_status: 'accepted', is_current: false, source_type: 'staff_upload' });
    const dChat = await doc('chat.pdf', { application_id: APP, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'chat_attachment' });
    const dIska = await doc('iska.pdf', { application_id: APP, borrower_id: B, checklist_item_id: ISKA_CI, review_status: 'pending', is_current: true, source_type: 'staff_upload' });
    const dVesting = await doc('vesting-llc.pdf', { llc_id: LLC, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload' });
    const dOwnerLlc = await doc('owner-llc.pdf', { llc_id: OWNER_LLC, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload' });
    const dProfile = await doc('photo-id.pdf', { borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload' });
    const dCoProfile = await doc('co-photo-id.pdf', { borrower_id: CB, review_status: 'pending', is_current: true, source_type: 'staff_upload' });
    const dPriorZip = await doc('TPR_old.zip', { application_id: APP, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'system', doc_kind: 'tpr_export', visibility: 'internal' });
    const dTrSnap = await doc('tr-snapshot.html', { borrower_id: B, review_status: 'pending', is_current: true, source_type: 'system', doc_kind: 'track_record_html' });
    const dTrDoc = await doc('hud-closing.pdf', { borrower_id: B, track_record_id: TR, review_status: 'pending', is_current: true, source_type: 'staff_upload', visibility: 'internal' });

    // ISKA HARD FREEZE — three independent guards. None of these may ship.
    const dIskaSigned = await doc('signed-document.pdf', { application_id: APP, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload', doc_kind: 'heter_iska_signed' });
    const dIskaGen = await doc('Heter Iska.pdf', { application_id: APP, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload', doc_kind: 'heter_iska' });
    const dEsignCert = await doc('completion-certificate.pdf', { application_id: APP, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload', doc_kind: 'esign_certificate' });
    const dLooseIska = await doc('iska copy.pdf', { application_id: APP, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload' });
    // Word-boundary guard must NOT over-exclude: "Mariska" contains "iska" mid-word.
    const dMariska = await doc('Mariska Bank Statement.pdf', { application_id: APP, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload' });

    // A >30-day-old loose doc and profile doc must STILL ship — the CoGS
    // 30-day exclusion has a NULL template_id (audit finding: it dropped every
    // old loose/profile doc). Age these two rows past the window.
    const dOldLoose = await doc('old-loose.pdf', { application_id: APP, borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload' });
    const dOldProfile = await doc('old-photo-id.pdf', { borrower_id: B, review_status: 'pending', is_current: true, source_type: 'staff_upload' });
    await db.query(`UPDATE documents SET created_at = now() - interval '45 days' WHERE id=ANY($1::uuid[])`, [[dOldLoose, dOldProfile]]);

    const got = new Set((await tpr.selectTprDocuments(APP)).map(d => d.id));
    ok(got.has(dOldLoose), 'INCLUDED: 45-day-old loose doc (CoGS window must not drop NULL-template docs)');
    ok(got.has(dOldProfile), 'INCLUDED: 45-day-old profile doc (photo ID)');
    ok(got.has(dFraud), 'INCLUDED: fraud report (internal condition, pending review)');
    ok(got.has(dAccepted), 'INCLUDED: accepted borrower-condition doc');
    ok(got.has(dLoose), 'INCLUDED: loose staff attachment (no condition, pending)');
    ok(got.has(dVesting), 'INCLUDED: vesting LLC doc');
    ok(got.has(dOwnerLlc), 'INCLUDED: LAYERED owning-entity LLC doc');
    ok(got.has(dProfile), 'INCLUDED: borrower profile doc (photo ID)');
    ok(got.has(dCoProfile), 'INCLUDED: co-borrower profile doc');
    ok(!got.has(dRejected), 'excluded: rejected doc');
    ok(!got.has(dSuperseded), 'excluded: superseded (is_current=false) version');
    ok(!got.has(dChat), 'excluded: chat attachment');
    ok(!got.has(dIska), 'excluded: tpr_exclude item doc (ISKA stays out)');
    ok(!got.has(dPriorZip), 'excluded: prior TPR export zip (no recursion)');
    ok(!got.has(dTrSnap), 'excluded: autosaved track-record snapshot artifact');
    ok(!got.has(dTrDoc), 'excluded from subject set: track-record doc (ships via track section)');
    ok(!got.has(dIskaSigned), 'FREEZE: signed Heter Iska excluded (doc_kind heter_iska_signed)');
    ok(!got.has(dIskaGen), 'FREEZE: generated Heter Iska excluded (doc_kind + filename)');
    ok(!got.has(dEsignCert), 'FREEZE: DocuSign completion certificate excluded (may be the Iska envelope)');
    ok(!got.has(dLooseIska), 'FREEZE: loose file named "iska" excluded (filename word-boundary guard)');
    ok(got.has(dMariska), 'NOT over-excluded: "Mariska…" contains "iska" mid-word but ships');

    const trGot = (await tpr.selectTrackRecordDocs([TR])).map(d => d.id);
    ok(trGot.includes(dTrDoc), 'track section INCLUDES the line-item doc (even internal visibility)');

    // The full zip builds and the manifest counts match the selection.
    const { zip, includedCount } = await tpr.buildTprExport(APP);
    ok(Buffer.isBuffer(zip) && zip.length > 500, 'zip builds');
    // manifest = subject-set docs + track-record verification docs (got already
    // includes the two aged docs, so this stays consistent).
    ok(includedCount === got.size + trGot.length, `manifest count (${includedCount}) === subject (${got.size}) + track (${trGot.length})`);

    // The package is ONE clean folder, foldered by category, no NN_ prefixes.
    const names = unzip(zip).map(e => e.name);
    const roots = new Set(names.map(n => n.split('/')[0]));
    ok(roots.size === 1, `exactly ONE top folder in the ZIP (got: ${[...roots].join(' | ')})`);
    ok(names.some(n => /\/REO\/Track Record\.xlsx$/.test(n)), 'REO/Track Record.xlsx is present');
    ok(names.some(n => /\/REO\/9 Prior Rd[^/]*\/hud-closing\.pdf$/.test(n)), 'REO has a per-property folder with the line-item doc');
    ok(!names.some(n => /\/\d\d?_/.test(n.split('/').pop())), 'no NN_ numbered prefixes on file names');
    ok(names.some(n => /\/(Background Check|Criminal Check)\//.test(n)), 'fraud report filed under Background/Criminal Check');
    ok(names.some(n => n.endsWith('/_Manifest.json')) && names.some(n => n.endsWith('/_Package Index.txt')), 'manifest + index filed inside the folder');
    ok(names.every(n => !/\b(iska|heter)\b/i.test(n)), 'no Iska/Heter file anywhere in the package');
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM documents WHERE id=ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM track_records WHERE id=$1`, [TR]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM llc_members WHERE llc_id=$1`, [LLC]).catch(() => {});
    await db.query(`DELETE FROM llcs WHERE id=ANY($1::uuid[])`, [[LLC, OWNER_LLC]]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=ANY($1::uuid[])`, [[B, CB]]).catch(() => {});
  }
  console.log(`\ntpr-export: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();

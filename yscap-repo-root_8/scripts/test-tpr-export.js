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
  const tpr = require(REPO + '/src/lib/tpr-export');

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

    const got = new Set((await tpr.selectTprDocuments(APP)).map(d => d.id));
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

    const trGot = (await tpr.selectTrackRecordDocs([TR])).map(d => d.id);
    ok(trGot.includes(dTrDoc), 'track section INCLUDES the line-item doc (even internal visibility)');

    // The full zip builds and the manifest counts match the selection.
    const { zip, includedCount } = await tpr.buildTprExport(APP);
    ok(Buffer.isBuffer(zip) && zip.length > 500, 'zip builds');
    // manifest = subject-set docs + track-record verification docs
    ok(includedCount === got.size + trGot.length, `manifest count (${includedCount}) === subject (${got.size}) + track (${trGot.length})`);
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

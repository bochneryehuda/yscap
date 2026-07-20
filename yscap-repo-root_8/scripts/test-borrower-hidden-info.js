/**
 * Group B (owner-directed 2026-07-20): the borrower must NEVER see internal
 * underwriting / pricing / vendor detail. Boots the real app and drives the real
 * borrower endpoints, asserting the internal columns/fields are stripped:
 *   • GET /applications/:id      — internal `applications` columns gone (markup,
 *                                  clickup/sync internals, card fields, staff ids,
 *                                  structural-unlock bookkeeping, internal valuations).
 *   • GET /applications/:id/appraisal — appraiser DIRECT CONTACT + supervisor + vendor
 *                                  stripped; the "who prepared it" firm/license kept.
 *   • GET /applications/:id/checklist — track_record.perBorrower + a personal
 *                                  info-field's raw payload value are not leaked to a
 *                                  co-borrower.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-borrower-hidden-info (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
// A borrower needs a borrower_auth row for the JWT tv check.
async function mkBorrower(sfx, who) {
  const bid = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'Test',$2) RETURNING id`, [who, `${who}-${sfx}@test.local`])).rows[0].id;
  await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [bid]);
  const tok = C.signJwt({ sub: bid, kind: 'borrower', tv: 0 });
  return { bid, tok };
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let primaryId, coId, staffId, appId;
  try {
    staffId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'LO','loan_officer',true,false,'x',0) RETURNING id`, [`bhi-lo-${sfx}@test.local`])).rows[0].id;
    const primary = await mkBorrower(sfx, 'primary'); primaryId = primary.bid;
    const co = await mkBorrower(sfx, 'coborrower'); coId = co.bid;

    // A file with a full spread of internal columns populated + a co-borrower.
    appId = (await db.query(
      `INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, status, purchase_price, loan_amount,
         lender, internal_status, file_markup_std_pct, file_markup_gold_pct, actual_appraised_value, approx_appraised_value,
         underwriter_id, processor_id, first_lien, second_lien, encompass_status, sync_state,
         structural_unlocked_at, structural_unlock_reason)
       VALUES ($1,$2,$3,'processing',500000,375000,
         'BlueLake Capital','closed (6-email funded)',2.5,3.0,610000,600000,
         $3,$3,250000,50000,'Approved','linked',
         now(),'correcting a typo')
       RETURNING id`, [primaryId, coId, staffId])).rows[0].id;

    // ---- 1) GET /applications/:id strips internal columns ----
    const r1 = await call(server, 'GET', `/api/borrower/applications/${appId}`, primary.tok);
    assert(r1.status === 200, 'borrower can read own file');
    const a = r1.body || {};
    const LEAKY = ['lender', 'internal_status', 'file_markup_std_pct', 'file_markup_gold_pct',
      'actual_appraised_value', 'approx_appraised_value', 'underwriter_id', 'processor_id',
      'first_lien', 'second_lien', 'encompass_status', 'sync_state',
      'structural_unlocked_at', 'structural_unlock_reason', 'card_number_encrypted'];
    for (const k of LEAKY) assert(!(k in a), `internal column not sent to borrower: ${k}`);
    // sanity: a borrower-safe column IS present
    assert('loan_amount' in a || 'status' in a, 'borrower still gets their real loan fields');
    // the capital-partner name must not appear ANYWHERE in the JSON
    assert(!JSON.stringify(a).includes('BlueLake'), 'capital-partner name absent from the whole payload');

    // ---- 2) Appraisal: appraiser contact stripped, firm/license kept ----
    await db.query(
      `INSERT INTO appraisals (application_id, superseded, imported_at, appraiser_name, appraiser_company,
         appraiser_email, appraiser_phone, appraiser_company_address, license_id, license_state,
         supervisor_name, supervisor_license_id, software_vendor, lender_name, amc_name, warnings)
       VALUES ($1,false,now(),'Jane Appraiser','Acme Appraisal LLC',
         'jane@acme.example','555-123-4567','9 Vendor Rd, Town','LIC-999','NY',
         'Bob Super','SUP-111','SomeVendor','BlueLake Capital','Acme AMC', $2::jsonb)`,
      [appId, JSON.stringify([{ code: 'nbhd_declining', severity: 'warning' }])]);
    const r2 = await call(server, 'GET', `/api/borrower/applications/${appId}/appraisal`, primary.tok);
    assert(r2.status === 200, 'borrower can read appraisal summary');
    const ap = (r2.body && r2.body.appraisal) || {};
    // kept — legitimate "who prepared your appraisal"
    assert(ap.appraiser_name === 'Jane Appraiser', 'appraiser NAME kept (standard disclosure)');
    assert(ap.appraiser_company === 'Acme Appraisal LLC', 'appraiser FIRM kept');
    assert(ap.license_id === 'LIC-999', 'appraiser license kept');
    // stripped — direct contact + internal personnel/vendor
    for (const k of ['appraiser_email', 'appraiser_phone', 'appraiser_company_address',
      'supervisor_name', 'supervisor_license_id', 'software_vendor',
      'lender_name', 'amc_name', 'warnings']) {
      assert(!(k in ap), `appraisal internal field stripped: ${k}`);
    }
    assert(!JSON.stringify(r2.body).includes('BlueLake'), 'capital-partner name absent from appraisal payload');

    // ---- 3) Checklist: co-borrower does not see the primary's personal payload ----
    // track_record item carrying perBorrower detail + a personal FICO info_field.
    const tplTr = (await db.query(`SELECT id,label,item_kind FROM checklist_templates WHERE code='rtl_track_record' LIMIT 1`)).rows[0]
      || { id: null, label: 'Track record', item_kind: 'tool' };
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, borrower_label, status, item_kind, audience, tool_key, tool_payload)
       VALUES ($1,'application',$2,'Track record','Track record','received','task','both','track_record',$3::jsonb)`,
      [tplTr.id, appId, JSON.stringify({ counts: { flips: 3 }, perBorrower: [{ name: 'primary', reo: 'secret 123 Main St', fico: 812 }] })]);
    await db.query(
      `INSERT INTO checklist_items (scope, application_id, label, borrower_label, status, item_kind, audience, tool_key, field_key, tool_payload)
       VALUES ('application',$1,'Credit score','Credit score','received','task','both','info_field','fico',$2::jsonb)`,
      [appId, JSON.stringify({ value: 812 })]);
    // Give the co-borrower their own (different) fico so field_value reflects THEM.
    await db.query(`UPDATE borrowers SET fico=690 WHERE id=$1`, [coId]);

    const r3 = await call(server, 'GET', `/api/borrower/applications/${appId}/checklist`, co.tok);
    assert(r3.status === 200, 'co-borrower can read the checklist');
    const items = r3.body || [];
    const tr = items.find(i => i.tool_key === 'track_record');
    const fico = items.find(i => i.tool_key === 'info_field' && i.field_key === 'fico');
    assert(tr && tr.tool_payload && !('perBorrower' in tr.tool_payload), 'track_record perBorrower NOT sent to co-borrower');
    assert(tr && tr.tool_payload && tr.tool_payload.counts, 'track_record aggregate counts still sent');
    assert(!JSON.stringify(items).includes('secret 123 Main St'), 'primary REO detail absent from co-borrower payload');
    // co-borrower must see THEIR own fico (690), never the primary's 812
    assert(!fico || !fico.tool_payload || fico.tool_payload.value !== 812, 'primary FICO (812) not leaked via tool_payload to co-borrower');
    assert(fico && fico.field_value === 690, 'co-borrower sees their OWN fico via field_value');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL borrower-hidden-info assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]); } catch (_) {}
    try { if (primaryId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [primaryId]); } catch (_) {}
    try { if (coId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [coId]); } catch (_) {}
    try { if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();

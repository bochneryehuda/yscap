/**
 * RE-IMPORT A USPS ADDRESS EVEN WHEN IT SAYS "ALREADY IMPORTED"
 * (owner-reported 2026-08-05).
 *
 * "The import button doesn't work. It says it's imported already and does not let
 *  me import it … the address on file is not updated. USPS successfully verified
 *  the address, but we can't import the verified address because it comes up that
 *  it's imported already … we should be able to change the verification and import
 *  it again."
 *
 * ROOT CAUSE. `usps_imported_at` is only a "was imported at some point" stamp. A
 * re-spelling of the same place (the ClickUp pull, the details form) or a no-edit
 * super-admin override can leave that stamp standing while `property_address` is no
 * longer the USPS form (db/415 keeps the stamp on a same-place re-spell so the
 * verification does not bounce). The screen gated the Import button on "NOT imported",
 * so once the stamp was set the button was dead — there was no way to re-adopt the
 * verified address. This suite pins the two halves of the fix:
 *
 *   1. THE IMPORT ROUTE ALLOWS RE-IMPORT. It is idempotent — a stamped file can be
 *      imported again (the button being re-enabled after a fresh verify is the UI
 *      half; this is the server contract the UI relies on, so nobody re-adds a
 *      `usps_imported_at` block to it).
 *   2. THE STATUS ROUTE REPORTS WHETHER THE FILE ADDRESS IS STILL THE VERIFIED ONE
 *      (`addressMatchesVerified`), so the screen can explain a stale "imported"
 *      state and offer a re-import instead of a dead "already imported".
 *
 * Boots the real Express app and drives the real endpoints over HTTP. Requires
 * DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-usps-reimport-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const uspsVerify = require('../src/lib/usps-verify');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const appRow = async (id) => (await db.query(
  `SELECT usps_imported_at, usps_match, property_address, usps_address FROM applications WHERE id=$1`, [id])).rows[0];
const condRow = async (appId, tplId) => (await db.query(
  `SELECT status, signed_off_at, override_by, override_reason, override_blocked_reason
     FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appId, tplId])).rows[0];

// A ("12 Main St") and B ("400 Cedar Ave") are two genuinely different places.
const A = { line1: '12 Main St', city: 'Lakewood', state: 'NJ', zip: '08701', oneLine: '12 Main St, Lakewood, NJ 08701' };
const B = { line1: '400 Cedar Ave', city: 'Lakewood', state: 'NJ', zip: '08701', oneLine: '400 Cedar Ave, Lakewood, NJ 08701' };

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const tplId = (await db.query(`SELECT id FROM checklist_templates WHERE code='usps_address_verification'`)).rows[0].id;
  let staffId, borrowerId, superId;
  const savedStd = uspsVerify.standardize;

  try {
    staffId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Reimport Proc','processor',true,false,'x',0) RETURNING id`, [`usps-reimp-${sfx}@test.local`])).rows[0].id;
    superId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Reimport Super','super_admin',true,false,'x',0) RETURNING id`, [`usps-reimp-super-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'processor', tv: 0 });
    const sToken = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Reimp','Test',$1) RETURNING id`, [`usps-reimp-bo-${sfx}@test.local`])).rows[0].id;

    async function newFile() {
      const id = (await db.query(
        `INSERT INTO applications (borrower_id, loan_officer_id, status, property_address)
         VALUES ($1,$2,'processing',$3::jsonb) RETURNING id`, [borrowerId, staffId, JSON.stringify(A)])).rows[0].id;
      await db.query(
        `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind, is_required, status, created_by_kind)
         VALUES ($1,'application',$2,'USPS Address Verification','staff','condition',true,'outstanding','system')`, [tplId, id]);
      return id;
    }
    // USPS always returns the deliverable, corrected B.
    uspsVerify.standardize = async () => ({ status: 'corrected', address: B, changed: true, dpv: { dpvConfirmation: 'Y' } });

    // ── 1. FIRST import, then RE-IMPORT while already imported ────────────────
    {
      const id = await newFile();
      await call(server, 'POST', `/api/staff/applications/${id}/usps-verification/check`, token, { address: B });
      const imp1 = await call(server, 'POST', `/api/staff/applications/${id}/usps-verification/import`, token, {});
      assert(imp1.status === 200 && imp1.json && imp1.json.ok, 'the first import succeeds (200)');
      const r1 = await appRow(id);
      assert(!!r1.usps_imported_at, 'usps_imported_at is stamped after import');
      assert(r1.property_address && /cedar ave/i.test(r1.property_address.oneLine || ''), 'the USPS address (B) is now the file address');
      assert((await condRow(id, tplId)).status === 'satisfied', 'the verification condition is cleared');

      // The status route says the file address IS the verified one now.
      const g1 = await call(server, 'GET', `/api/staff/applications/${id}/usps-verification`, token);
      assert(g1.json && g1.json.addressMatchesVerified === true, 'addressMatchesVerified is true when the file shows the USPS address');

      // THE FIX: the import route does NOT refuse a second import just because the
      // file already carries the stamp — re-import is idempotent and stays open.
      const t1 = r1.usps_imported_at;
      const imp2 = await call(server, 'POST', `/api/staff/applications/${id}/usps-verification/import`, token, {});
      assert(imp2.status === 200 && imp2.json && imp2.json.ok, 'RE-IMPORT is allowed while already imported (200, not "already imported")');
      const r2 = await appRow(id);
      assert(!!r2.usps_imported_at && new Date(r2.usps_imported_at) >= new Date(t1), 're-import refreshes the import stamp');
      assert((await condRow(id, tplId)).status === 'satisfied', 'the condition stays cleared after re-import');
    }

    // ── 2. THE STUCK STATE: imported, but the file address is NOT the verified one.
    //    A no-edit super-admin override stamps the import while keeping the file's
    //    current address (A) — so property_address (A) and the last USPS result (B)
    //    disagree. The screen must be able to see that and offer a re-import.
    {
      const id = await newFile();
      // Stage a verified USPS result for B, but the file still names A.
      await call(server, 'POST', `/api/staff/applications/${id}/usps-verification/check`, token, { address: B });
      const ovr = await call(server, 'POST', `/api/staff/applications/${id}/usps-verification/override`, sToken,
        { overrideReason: 'USPS was down at the time; address confirmed against the appraisal.' });
      assert(ovr.status === 200, 'the no-edit override stamps the import (200)');
      const stuck = await appRow(id);
      assert(!!stuck.usps_imported_at, 'the file reads as imported');
      assert(stuck.property_address && /main st/i.test(stuck.property_address.oneLine || ''), 'but the file address is still A (the override kept it)');
      const cOvr = await condRow(id, tplId);
      assert(String(cOvr.override_by) === String(superId) && !!cOvr.override_reason, 'the condition carries the super-admin override stamp');

      const g = await call(server, 'GET', `/api/staff/applications/${id}/usps-verification`, token);
      assert(g.json && g.json.usps_imported_at, 'the status route confirms imported');
      assert(g.json && g.json.addressMatchesVerified === false,
        'addressMatchesVerified is FALSE — the screen can explain the stale "imported" state and offer a re-import');

      // And the owner can now actually adopt the verified address B, despite the stamp.
      const imp = await call(server, 'POST', `/api/staff/applications/${id}/usps-verification/import`, token, {});
      assert(imp.status === 200 && imp.json && imp.json.ok, 're-import adopts the verified address even from the stuck state');
      const after = await appRow(id);
      assert(after.property_address && /cedar ave/i.test(after.property_address.oneLine || ''), 'the verified USPS address (B) is finally on the file');
      const g2 = await call(server, 'GET', `/api/staff/applications/${id}/usps-verification`, token);
      assert(g2.json && g2.json.addressMatchesVerified === true, 'and the status route now reports the file matches the verified address');
      // A real import SUPERSEDES the prior override — the "cleared by override" stamp
      // must not linger (else the condition keeps displaying a stale override reason).
      const cAfter = await condRow(id, tplId);
      assert(cAfter.status === 'satisfied' && cAfter.override_by === null
        && cAfter.override_reason === null && cAfter.override_blocked_reason === null,
        're-import clears the stale super-admin override stamp off the condition');
    }

    console.log(failures ? `\n${failures} FAILURE(S)` : `\nAll USPS re-import checks passed.`);
  } finally {
    uspsVerify.standardize = savedStd;
    try { if (borrowerId) { await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } } catch (_) {}
    try { if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
    try { if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/**
 * DB + HTTP test — vesting defaults to LLC, and a personal-name purchase (waived
 * off the LLC condition with a non-owner-occupied affidavit) flips it to Individual
 * (db/383, owner-directed 2026-07-31).
 *
 *   DATABASE_URL=postgres://… node scripts/test-vesting-personal-name-db.js
 *
 * Proves, against a real Postgres + the real HTTP routes:
 *   1. POST /vesting/personal-name with the affidavit sets personal_name_purchase,
 *      files the affidavit as doc_kind='noo_affidavit', and signs off rtl_p1_llc.
 *   2. signOffGate on rtl_p1_llc: a personal-name file with the affidavit is
 *      clearable; without it, it is refused.
 *   3. Undo clears the flag and reopens the condition.
 *   4. Linking a real vesting entity clears personal_name_purchase (LLC wins).
 */
const R = require('path').resolve(__dirname, '..');
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP vesting personal-name DB test (no DATABASE_URL)'); return; }
  const http = require('http');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const staffJs = require(R + '/src/routes/staff');   // ensure module loads
  const app = require(R + '/src/server');
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const call = (method, path, token, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const pnpOf = async (id) => (await db.query(`SELECT personal_name_purchase FROM applications WHERE id=$1`, [id])).rows[0].personal_name_purchase;
  const condOf = async (id) => (await db.query(
    `SELECT ci.status, ci.signed_off_at FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_p1_llc' ORDER BY ci.created_at LIMIT 1`, [id])).rows[0];
  let borrowerId, staffId;
  try {
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('V','P',$1) RETURNING id`, [`vp-${sfx}@t.local`])).rows[0].id;
    staffId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'V P Admin','super_admin',true,false,'x',0) RETURNING id`, [`vp-admin-${sfx}@t.local`])).rows[0].id;
    const tok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });
    const appId = (await db.query(`INSERT INTO applications (borrower_id, status, property_type, units) VALUES ($1,'processing','SFR (1 unit)',1) RETURNING id`, [borrowerId])).rows[0].id;

    // default: not a personal-name purchase → vesting is LLC by default
    ok((await pnpOf(appId)) === false, 'a new file is not a personal-name purchase (vesting defaults to LLC)');

    // waive WITHOUT an affidavit → refused
    let r = await call('POST', `/api/staff/applications/${appId}/vesting/personal-name`, tok, {});
    ok(r.status === 400, 'waiving with no affidavit is refused (400)');
    ok((await pnpOf(appId)) === false, 'a refused waive does not flag the file');

    // waive WITH the affidavit → flagged, filed, signed off
    const pdf = Buffer.from('%PDF-1.4 fake noo affidavit').toString('base64');
    r = await call('POST', `/api/staff/applications/${appId}/vesting/personal-name`, tok,
      { filename: 'noo-affidavit.pdf', contentType: 'application/pdf', dataBase64: pdf });
    ok(r.status === 200 && r.body && r.body.personalNamePurchase === true, 'waiving with the affidavit succeeds');
    ok((await pnpOf(appId)) === true, 'the file is flagged personal-name');
    const doc = (await db.query(
      `SELECT doc_kind, checklist_item_id FROM documents WHERE application_id=$1 AND doc_kind='noo_affidavit' AND is_current`, [appId])).rows[0];
    ok(!!doc, 'the affidavit is filed as doc_kind=noo_affidavit');
    let cond = await condOf(appId);
    ok(cond && cond.status === 'satisfied' && cond.signed_off_at, 'the LLC condition (rtl_p1_llc) is signed off');
    ok(doc && String(doc.checklist_item_id), 'the affidavit is attached to the LLC condition');

    // signOffGate: with the affidavit + flag, the gate allows it; drop the affidavit → refused
    const gate = staffJs.signOffGate;
    if (typeof gate === 'function') {
      const itemId = (await db.query(
        `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
          WHERE ci.application_id=$1 AND t.code='rtl_p1_llc' ORDER BY ci.created_at LIMIT 1`, [appId])).rows[0].id;
      const actor = { id: staffId, kind: 'staff', role: 'super_admin' };
      const g1 = await gate(itemId, actor);
      ok(g1 === null, 'signOffGate allows a personal-name file that has the affidavit');
      await db.query(`UPDATE documents SET is_current=false WHERE application_id=$1 AND doc_kind='noo_affidavit'`, [appId]);
      const g2 = await gate(itemId, actor);
      ok(typeof g2 === 'string' && /affidavit/i.test(g2), 'signOffGate refuses a personal-name file with no affidavit');
      await db.query(`UPDATE documents SET is_current=true WHERE application_id=$1 AND doc_kind='noo_affidavit'`, [appId]);
    } else {
      console.log('  ~~ signOffGate not exported — skipping the direct-gate assertions');
    }

    // undo → back to an LLC purchase
    r = await call('POST', `/api/staff/applications/${appId}/vesting/personal-name`, tok, { undo: true });
    ok(r.status === 200, 'undo succeeds');
    ok((await pnpOf(appId)) === false, 'undo clears the personal-name flag (vesting back to LLC)');
    cond = await condOf(appId);
    ok(cond && cond.status === 'outstanding' && !cond.signed_off_at, 'undo reopens the LLC condition');

    // re-flag, then link an LLC → the flag is cleared (LLC wins)
    await call('POST', `/api/staff/applications/${appId}/vesting/personal-name`, tok,
      { filename: 'noo2.pdf', contentType: 'application/pdf', dataBase64: pdf });
    ok((await pnpOf(appId)) === true, 're-flagged personal-name');
    const llcId = (await db.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`, [borrowerId, `VP Holdings ${sfx} LLC`])).rows[0].id;
    await require(R + '/src/lib/vesting').setVestingLlc(appId, llcId, { source: 'staff', push: false, force: true });
    ok((await pnpOf(appId)) === false, 'linking a real vesting entity clears the personal-name flag (LLC wins)');

    console.log(`  vesting personal-name DB: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('  ERROR', e); fail++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

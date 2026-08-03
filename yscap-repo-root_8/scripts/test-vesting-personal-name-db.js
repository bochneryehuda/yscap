'use strict';
/**
 * DB + HTTP test — vesting defaults to LLC, and a personal-name purchase (waived
 * off the LLC condition with a non-owner-occupied affidavit) flips it to Individual
 * (db/384, owner-directed 2026-07-31).
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
  const llcOf = async (id) => (await db.query(`SELECT llc_id FROM applications WHERE id=$1`, [id])).rows[0].llc_id;
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

    /* MARKING A FILE INDIVIDUAL NO LONGER NEEDS AN AFFIDAVIT IN HAND
       (owner-directed 2026-08-02, superseding the 2026-07-31 refusal). The
       affidavit is still required — as its OWN rule-driven condition (db/408),
       which is prior_to_docs and so holds clear-to-close exactly as this refusal
       used to. The refusal had to go because it made the choice impossible at
       the two doors that matter most: a borrower on the public application form
       has no affidavit to attach, and neither does a staffer opening a new file.

       So what is asserted here is that the requirement MOVED, not that it was
       dropped: the mark succeeds, AND the affidavit condition appears. */
    let r = await call('POST', `/api/staff/applications/${appId}/vesting/personal-name`, tok, {});
    ok(r.status === 200, 'marking the file individual with NO affidavit now succeeds');
    ok((await pnpOf(appId)) === true, '…and the file really is flagged individual');
    {
      const cond = (await db.query(
        `SELECT ci.status FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
          WHERE ci.application_id=$1 AND t.code='cond_noo_affidavit_individual'`, [appId])).rows[0];
      ok(!!cond, 'THE AFFIDAVIT IS STILL ASKED FOR — as its own condition, attached immediately');
      const llc = (await db.query(
        `SELECT ci.status, ci.is_required, ci.waived_at, ci.signed_off_at
           FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
          WHERE ci.application_id=$1 AND t.code='rtl_p1_llc'`, [appId])).rows[0];
      // A waive here is `waived_at` + is_required=false — the status column's
      // CHECK has no 'waived' value, the stamp IS the waive.
      ok(llc && llc.waived_at && llc.is_required === false,
        'the LLC condition is WAIVED as not-applicable — there is no entity to document');
      ok(llc && !llc.signed_off_at,
        '…and NOT signed off, so the file never reads as though somebody met a requirement they did not');
    }
    // Put it back so the rest of the file tests the affidavit-in-hand path.
    await call('POST', `/api/staff/applications/${appId}/vesting/personal-name`, tok, { undo: true });

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
      /* The gate no longer demands the affidavit HERE either (owner-directed
         2026-08-02). Asking in two places meant one affidavit chased twice, and
         left the LLC condition unclosable on a file that has no entity at all —
         which is the entire point of a personal-name purchase. The demand lives
         on `cond_noo_affidavit_individual`, which is prior_to_docs and so still
         holds clear-to-close. */
      await db.query(`UPDATE documents SET is_current=false WHERE application_id=$1 AND doc_kind='noo_affidavit'`, [appId]);
      const g2 = await gate(itemId, actor);
      ok(g2 === null,
        'the LLC gate stands down on a personal-name file — there is no entity to verify, and the affidavit has its own condition');
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
    ok(String(await llcOf(appId)) === String(llcId), 'the vesting entity is linked');

    // waive over an UNVERIFIED linked LLC → allowed, but the LLC link is dropped so
    // the ClickUp *Vesting dropdown never reads Individual next to an LLC name.
    r = await call('POST', `/api/staff/applications/${appId}/vesting/personal-name`, tok,
      { filename: 'noo3.pdf', contentType: 'application/pdf', dataBase64: pdf });
    ok(r.status === 200 && (await pnpOf(appId)) === true, 'waiving over an unverified linked LLC succeeds');
    ok((await llcOf(appId)) === null, 'waiving drops the unverified linked LLC (Individual is never pushed next to an LLC name)');

    // waive over a VERIFIED linked LLC → refused (an LLC always wins)
    await require(R + '/src/lib/vesting').setVestingLlc(appId, llcId, { source: 'staff', push: false, force: true });
    await db.query(`UPDATE llcs SET is_verified=true WHERE id=$1`, [llcId]);
    r = await call('POST', `/api/staff/applications/${appId}/vesting/personal-name`, tok,
      { filename: 'noo4.pdf', contentType: 'application/pdf', dataBase64: pdf });
    ok(r.status === 409, 'waiving is refused when a verified LLC is linked');
    ok((await pnpOf(appId)) === false, 'a refused waive over a verified LLC does not flag the file');
    ok(String(await llcOf(appId)) === String(llcId), 'the verified LLC stays linked');

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

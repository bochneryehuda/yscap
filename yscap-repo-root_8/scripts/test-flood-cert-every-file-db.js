'use strict';
/**
 * FLOOD CERTIFICATE ON EVERY FILE (owner-directed 2026-07-30) — replaces the
 * retired test-fidelis-flood-advisory-db.js, whose whole subject (the Fidelis
 * waiver of db/335/db/337) the owner reversed: "I want the flood certification
 * condition to populate on every single file whatsoever no matter who the
 * capital provider is."
 *
 * Proves, against a REAL database + the REAL sign-off endpoint:
 *  (0) the LIVE template row is auto_apply='always', no rule tree, required;
 *  (1) the engine attaches the condition to EVERY file — Fidelis, EMCAP
 *      Financial, Blue Lake, and a file with NO note buyer at all — in every
 *      program state, and never retracts it;
 *  (2) the db/374 back-date restores is_required=true and strips the old
 *      "optional on this file" / "required — flood zone" marker notes, and
 *      re-adds a deleted cert, idempotently across a second boot;
 *  (3) the LIVE sign-off gate refuses an EMPTY flood cert on a Fidelis file
 *      exactly like any other file (the bypass is gone), and a super-admin
 *      override with a reason still goes through (the recorded way out).
 * DB-gated: skips without DATABASE_URL.
 */
const assert = require('assert');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-flood-cert-every-file-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const { ensureSchema } = require('../src/migrate-boot');
const engine = require('../src/lib/conditions/engine');

const FLOOD = 'rtl_cond_flood';
const OPT_NOTE = '[auto] Optional on this file — this capital partner does not require a flood certificate as a standing condition, so it can be signed off with nothing attached. If the property turns out to be in a flood zone, this condition becomes required again.';
const REQ_NOTE = '[auto] Required on this file — the property is in a flood zone, so the flood determination certificate is required here even though this capital partner does not ask for one as a standing condition.';

const floodCount = async (appId) => (await db.query(
  `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code=$2`, [appId, FLOOD])).rows[0].n;
const floodItem = async (appId) => (await db.query(
  `SELECT ci.* FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code=$2 LIMIT 1`, [appId, FLOOD])).rows[0];

async function setProgram(appId, program) {
  await db.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1`, [appId]);
  await db.query(
    `INSERT INTO product_registrations (application_id, program, status, total_loan, inputs, quote, is_current)
     VALUES ($1,$2,'ELIGIBLE',175000,'{}'::jsonb,'{}'::jsonb,true)`, [appId, program]);
}
async function attachFlood(appId, over = {}) {
  const r = await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, application_id, label, audience, item_kind, role_scope, phase,
        status, is_required, origin_kind, notes)
     SELECT t.id, t.scope, $1, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'processor'),
            t.phase, $2, COALESCE($3, true), $4, $5
       FROM checklist_templates t WHERE t.code=$6 RETURNING id`,
    [appId, over.status || 'outstanding', over.is_required === undefined ? null : over.is_required,
     over.origin_kind || 'auto', over.notes || null, FLOOD]);
  return r.rows[0].id;
}
function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  await ensureSchema();
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId, server;
  const mkApp = async (lender, status = 'processing') => (await db.query(
    `INSERT INTO applications (borrower_id, status, loan_type, lender) VALUES ($1,$2,'Fix & Flip',$3) RETURNING id`,
    [borrowerId, status, lender])).rows[0].id;

  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Every','Flood',$1) RETURNING id`,
      [`ef-${sfx}@test.local`])).rows[0].id;

    // (0) The LIVE template row — not a mirror. If db/374 is ever reverted, this catches it.
    const tpl = (await db.query(
      `SELECT auto_apply, rule_logic, is_active, is_required FROM checklist_templates WHERE code=$1`, [FLOOD])).rows[0];
    ok(!!tpl && tpl.auto_apply === 'always', 'template auto_apply is ALWAYS (every file, no rule tree)');
    ok(tpl.rule_logic == null, 'template rule_logic is cleared (no program/buyer/flood scoping)');
    ok(tpl.is_active === true && tpl.is_required === true, 'template is active and required');

    // (1) The engine attaches it to EVERY file, whatever the capital provider or program.
    const cases = [
      ['Fidelis Investors LLC', 'a Fidelis file'],
      ['Fidelis', 'a plain-spelled Fidelis file'],
      ['EMCAP Financial', 'an EMCAP Financial (Silver) file'],
      ['Blue Lake', 'a Blue Lake file'],
      [null, 'a file with NO note buyer at all'],
    ];
    for (const [lender, what] of cases) {
      const a = await mkApp(lender);
      await engine.evaluateApplication(a, { reason: 'test', notify: false });
      ok((await floodCount(a)) === 1, `${what} gets the flood-certificate condition`);
      const row = await floodItem(a);
      ok(row.audience === 'staff', `${what}: the condition stays INTERNAL (staff-only)`);
      // …and it NEVER retracts, whatever the program becomes.
      await setProgram(a, 'standard');
      await engine.evaluateApplication(a, { reason: 'test', notify: false });
      ok((await floodCount(a)) === 1, `${what}: the condition never retracts (program changes included)`);
    }

    // (2) The db/374 back-date. Seed the pre-reversal states by hand, re-run the
    //     migrations (a boot), and prove the final state converges.
    const bdOpt = await mkApp('Fidelis Investors LLC');           // downgraded-optional with the db/335 note
    const bdOptItem = await attachFlood(bdOpt, { is_required: false, notes: `processor note to keep\n\n${OPT_NOTE}` });
    const bdReq = await mkApp('Fidelis Investors LLC');           // flood-forced with the db/335 §4 note
    const bdReqItem = await attachFlood(bdReq, { is_required: true, notes: REQ_NOTE });
    const bdGone = await mkApp('Fidelis Investors LLC');          // cert deleted entirely (db/335 §2 shape)
    await attachFlood(bdGone); await db.query(
      `DELETE FROM checklist_items ci USING checklist_templates t
        WHERE ci.template_id=t.id AND t.code=$1 AND ci.application_id=$2`, [FLOOD, bdGone]);
    ok((await floodCount(bdGone)) === 0, 'fixture: the deleted-cert file starts with none');

    await ensureSchema();   // the next boot

    let it = await floodItem(bdOpt);
    ok(it && it.is_required === true, 'back-date: a downgraded-optional cert is REQUIRED again');
    ok(!/(Optional on this file|does not require a flood certificate)/.test(it.notes || ''),
      'back-date: the "optional" marker note is stripped');
    ok(/processor note to keep/.test(it.notes || ''), 'back-date: the human note survives');
    it = await floodItem(bdReq);
    ok(it && it.is_required === true && !/even though this capital partner does not ask/.test(it.notes || ''),
      'back-date: the flood-zone-forced marker is stripped too (it would now mislead)');
    ok((await floodCount(bdGone)) === 1, 'back-date: a deleted cert is re-added to the file');
    await ensureSchema();   // and the boot after that — idempotent
    it = await floodItem(bdOpt);
    ok(it.is_required === true && !/Optional on this file/.test(it.notes || ''),
      'back-date is idempotent across a second boot');
    ok((await floodCount(bdGone)) === 1, 'the re-added cert stays exactly one across boots');

    // (3) The LIVE gate: the Fidelis bypass is GONE — an empty flood cert refuses to
    //     sign off on every file; the super-admin override (with a reason) still works.
    const adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Flood Admin','super_admin',true,false,'x',0) RETURNING id`,
      [`ef-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    server = require('../src/server').listen(0);
    await new Promise((res) => server.once('listening', res));
    const signOff = (id, extra) => call(server, 'PATCH', `/api/staff/checklist/${id}`, token, { signedOff: true, ...(extra || {}) });

    const gateCases = [
      ['Fidelis Investors LLC', 'a Fidelis file (the old waiver) is REFUSED empty'],
      ['Fidelis Investor LLC', 'a near-spelling Fidelis file is REFUSED empty'],
      ['EMCAP Financial', 'an EMCAP Financial file is REFUSED empty'],
      ['Blue Lake', 'a Blue Lake file is REFUSED empty'],
      [null, 'a no-note-buyer file is REFUSED empty'],
    ];
    for (const [lender, what] of gateCases) {
      const a = await mkApp(lender);
      const id = await attachFlood(a);
      ok((await signOff(id)).status === 422, `live gate: ${what}`);
    }
    // The recorded way through still exists: super-admin override with a reason.
    const aOvr = await mkApp('Fidelis Investors LLC');
    const ovrItem = await attachFlood(aOvr);
    const ovr = await signOff(ovrItem, { adminOverride: true, overrideReason: 'certificate unobtainable — vendor outage; cleared per policy' });
    ok(ovr.status === 200, 'live gate: a super-admin override with a reason still clears it (recorded)');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\ntest-flood-cert-every-file-db: ALL PASS');
    process.exitCode = failures ? 1 : 0;
  } catch (e) {
    console.error('FATAL', e);
    process.exitCode = 1;
  } finally {
    try { if (server) server.close(); } catch (_) { }
    try { await db.pool.end(); } catch (_) { }
  }
})();

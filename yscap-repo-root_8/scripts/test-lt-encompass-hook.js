'use strict';
/**
 * LONG-TERM — the Encompass webhook receiver (#42): nudge-only, secret-gated,
 * fails closed with no secret configured.
 *
 * What this proves:
 *   A. identityFrom — the loan is found by PATTERN anywhere in the payload
 *      (the tenant's rule owns the body shape, not us)
 *   B. secretOk — unset secret refuses EVERYTHING (fail closed); wrong secret
 *      refuses; right secret passes
 *   C. (DB) the route end to end on a real express app: 503 unconfigured,
 *      403 wrong secret, a real nudge CLEARS the sync stamp (and touches
 *      nothing else), an unknown loan answers "discovery will pick it up",
 *      an unidentifiable body answers without a retry-storm error
 *   D. the server mounts it PUBLIC at the sanctioned seam (source check)
 *
 * Mutation-proven:
 *   1. secretOk returning true with no secret configured → B fails
 *   2. the nudge applying body values instead of clearing the stamp → C fails
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };

async function main() {
  const hook = require('../src/longterm/routes/encompass-hook');
  const I = hook._internals;

  console.log('A. identityFrom — pattern, not shape');
  let id = I.identityFrom({ body: { anything: 'x', nested: { LoanGuid: 'E23A6F43-0E0B-4080-BB65-51A9B55D35DD' } }, query: {}, headers: {} });
  eq(id.guid, 'e23a6f43-0e0b-4080-bb65-51a9b55d35dd', 'a GUID is found anywhere in the body, case-folded');
  id = I.identityFrom({ body: 'MS.STATUS changed on YSCAP258134741 just now', query: {}, headers: {} });
  eq(id.loanNumber, 'YSCAP258134741', 'a YSCAP loan number is found in free text');
  id = I.identityFrom({ body: {}, query: { loanNumber: 'yscap258134700' }, headers: {} });
  eq(id.loanNumber, 'YSCAP258134700', 'the query string works too');
  id = I.identityFrom({ body: { hello: 'world' }, query: {}, headers: {} });
  ok(!id.guid && !id.loanNumber, 'nothing loan-shaped → nothing claimed');

  console.log('B. secretOk — fails closed');
  delete process.env.LT_ENCOMPASS_WEBHOOK_SECRET;
  eq(I.secretOk({ headers: { 'x-encompass-secret': 'anything' } }), false,
    'NO configured secret refuses everything — fail closed');
  process.env.LT_ENCOMPASS_WEBHOOK_SECRET = 'test-secret-123';
  eq(I.secretOk({ headers: { 'x-encompass-secret': 'wrong' } }), false, 'a wrong secret refuses');
  eq(I.secretOk({ headers: {} }), false, 'a missing header refuses');
  eq(I.secretOk({ headers: { 'x-encompass-secret': 'test-secret-123' } }), true, 'the right secret passes');

  console.log('D. the server mounts it PUBLIC at the sanctioned seam');
  const serverSrc = fs.readFileSync(path.resolve(__dirname, '../src/server.js'), 'utf8');
  const mountLine = serverSrc.split('\n').find((l) => l.includes("'/api/lt/encompass-hook'"));
  ok(mountLine, 'server.js mounts /api/lt/encompass-hook');
  ok(!/requireAuth|requireStaff/.test(mountLine), '…with NO session middleware (Encompass holds no PILOT session)');
  const authedMount = serverSrc.indexOf("app.use('/api/lt', requireAuth");
  ok(serverSrc.indexOf("'/api/lt/encompass-hook'") < authedMount, '…mounted BEFORE the staff-gated /api/lt');

  if (!process.env.DATABASE_URL) {
    console.log(`\nNo DATABASE_URL — pure half passed (${checks} checks); DB half skipped.`);
    return;
  }

  console.log('C. the route end to end');
  const express = require('express');
  const db = require('../src/longterm/db');
  const app = express();
  app.use(express.json());
  app.use('/api/lt/encompass-hook', hook);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/lt/encompass-hook`;
  const post = (headers, body) => fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

  const { rows: made } = await db.query(
    `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, encompass_synced_at, encompass_last_modified)
     VALUES (gen_random_uuid(), 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001', 'TESTHOOK1', now(), now() - interval '1 day')
     RETURNING id`);
  const loanId = made[0].id;
  try {
    delete process.env.LT_ENCOMPASS_WEBHOOK_SECRET;
    let r = await post({}, { loanNumber: 'TESTHOOK1' });
    eq(r.status, 503, 'unconfigured → 503, nothing accepted');

    process.env.LT_ENCOMPASS_WEBHOOK_SECRET = 'test-secret-123';
    r = await post({ 'x-encompass-secret': 'wrong' }, { loanNumber: 'TESTHOOK1' });
    eq(r.status, 403, 'a wrong secret → 403');
    let { rows } = await db.query('SELECT encompass_synced_at FROM lt_loans WHERE id = $1::uuid', [loanId]);
    ok(rows[0].encompass_synced_at, '…and the loan was NOT touched');

    r = await post({ 'x-encompass-secret': 'test-secret-123' },
      { event: 'milestone', loanGuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0001', msStatus: 'Funded', loanAmount: 999999999 });
    eq(r.status, 200, 'a real nudge answers 200');
    eq(r.json.nudged, true, '…nudged');
    ({ rows } = await db.query('SELECT encompass_synced_at, loan_amount, ms_status FROM lt_loans WHERE id = $1::uuid', [loanId]));
    eq(rows[0].encompass_synced_at, null, 'the sync stamp is CLEARED — the next pass re-reads from Encompass');
    eq(rows[0].loan_amount, null, 'NOTHING from the body was applied (the 999999999 never landed)…');
    eq(rows[0].ms_status, null, '…nudge-only: even the msStatus in the payload is ignored');

    r = await post({ 'x-encompass-secret': 'test-secret-123' }, { loanNumber: 'YSCAP999999999' });
    eq(r.status, 200, 'an unknown loan answers 200 (never a retry storm)');
    eq(r.json.nudged, false, '…not nudged — discovery will pick it up');

    r = await post({ 'x-encompass-secret': 'test-secret-123' }, { hello: 'world' });
    eq(r.json.nudged, false, 'an unidentifiable body answers honestly');
  } finally {
    server.close();
    await db.query('DELETE FROM lt_loans WHERE id = $1::uuid', [loanId]).catch(() => {});
    delete process.env.LT_ENCOMPASS_WEBHOOK_SECRET;
  }

  console.log(`\nAll ${checks} checks passed.`);
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e && (e.stack || e.message)); process.exit(1); });

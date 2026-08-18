#!/usr/bin/env node
'use strict';
/* PROPERTY IS FREE AND CLEAR + THE PAYOFF GOOD-THROUGH DATE (db/575, owner-directed
 * 2026-08-18), against a real database and the real HTTP routes. What is pinned:
 *
 *   A. the widened template rules are LIVE (both payoff conditions carry
 *      property_free_and_clear is_false) and the engine attaches both on an
 *      ordinary refinance — the control that proves C/E actually bite.
 *   B. payoffState: free-and-clear ⇒ nothing missing; the good-through date is a
 *      field, asked for, never required. The browser mirror agrees (payoffMissingKeys).
 *   C. the route: confirm required; a purchase refused; ON zeroes the payoff of
 *      record and takes BOTH conditions off the file — a WORKED one is WAIVED with
 *      the [auto] note (never silently deleted), an untouched one is retracted.
 *   D. OFF reopens exactly what the feature waived, clears the $0, and the engine
 *      re-attaches the retracted one.
 *   E. the attorney closing-prep email: the deal block states the refi kind, states
 *      free-and-clear, and lays the payoff details out (incl. good through) on an
 *      ordinary refinance; the payoff document group is skipped as inapplicable on
 *      a free-and-clear file.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-payoff-free-and-clear-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const payoffLib = require('../src/lib/payoff');
const app = require('../src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

const PAYOFF_CODES = ['cond_payoff_external', 'cond_payoff_internal'];
async function payoffItems(appId) {
  return (await db.query(
    `SELECT ci.id, ci.status, ci.waived_at, ci.notes, t.code
       FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code = ANY($2::text[]) ORDER BY t.code`, [appId, PAYOFF_CODES])).rows;
}

(async () => {
  // ---- A. the live rules -----------------------------------------------------------------
  const tpls = (await db.query(
    `SELECT code, rule_logic FROM checklist_templates WHERE code = ANY($1::text[]) ORDER BY code`, [PAYOFF_CODES])).rows;
  ok('A1 both templates exist', tpls.length === 2);
  ok('A2 both rules carry the free-and-clear exclusion',
    tpls.every((t) => JSON.stringify(t.rule_logic || {}).includes('property_free_and_clear')));

  // ---- B. the model ----------------------------------------------------------------------
  const st1 = payoffLib.payoffState({ loan_type: 'Refinance - Rate & Term', payoff_amount: null }, null);
  ok('B1 an ordinary refi is missing its payoff', st1.missing.some((m) => m.key === 'payoffAmount') && st1.freeAndClear === false);
  const st2 = payoffLib.payoffState({ loan_type: 'Refinance - Rate & Term', property_free_and_clear: true, payoff_amount: 0 }, null);
  ok('B2 free and clear ⇒ nothing missing, ready', st2.freeAndClear === true && st2.missing.length === 0 && st2.ready === true);
  const st3 = payoffLib.payoffState({ loan_type: 'Refinance - Cash-Out', payoff_amount: 100000, payoff_good_through: '2026-09-15' }, null);
  ok('B3 the good-through date rides entered, never required', st3.entered.payoffGoodThrough === '2026-09-15'
    && !st3.missing.some((m) => m.key === 'payoffGoodThrough'));

  // ---- fixtures --------------------------------------------------------------------------
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  let superId, borId, appId, purchaseId;
  try {
    superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`fnc-super-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Free','Clear',$1) RETURNING id`, [`fnc-bo-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id,loan_officer_id,status,loan_type,property_address,payoff_amount,payoff_lender)
       VALUES ($1,$2,'underwriting','Refinance - Rate & Term','{"oneLine":"9 Clear Ct"}',185000,'Old Lender LLC') RETURNING id`,
      [borId, superId])).rows[0].id;
    purchaseId = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type,property_address) VALUES ($1,'underwriting','Purchase','{"oneLine":"1 Buy St"}') RETURNING id`,
      [borId])).rows[0].id;

    // the engine attaches both payoff conditions on the refinance
    await require('../src/lib/conditions/engine').evaluateApplication(appId);
    let items = await payoffItems(appId);
    ok('A3 the engine attaches both payoff conditions on a refinance', items.length === 2);

    // Work ONE of them (a note = touched), so the toggle must WAIVE it, not delete it.
    await db.query(`UPDATE checklist_items ci SET status='received'
       FROM checklist_templates t WHERE t.id=ci.template_id AND ci.application_id=$1 AND t.code='cond_payoff_external'`, [appId]);

    // ---- C. turning it ON ----------------------------------------------------------------
    const noConfirm = await call(server, 'POST', `/api/staff/applications/${appId}/payoff/free-and-clear`, tok, { on: true });
    ok('C1 confirm is required', noConfirm.status === 400);
    const onPurchase = await call(server, 'POST', `/api/staff/applications/${purchaseId}/payoff/free-and-clear`, tok, { on: true, confirm: true });
    ok('C2 a purchase is refused', onPurchase.status === 422);
    const r1 = await call(server, 'POST', `/api/staff/applications/${appId}/payoff/free-and-clear`, tok, { on: true, confirm: true });
    ok('C3 the toggle lands', r1.status === 200 && r1.body.payoff && r1.body.payoff.freeAndClear === true);
    const a1 = (await db.query(`SELECT property_free_and_clear, payoff_amount, payoff_lender FROM applications WHERE id=$1`, [appId])).rows[0];
    ok('C4 the payoff of record is $0, the lender cleared', a1.property_free_and_clear === true && Number(a1.payoff_amount) === 0 && a1.payoff_lender == null);
    items = await payoffItems(appId);
    ok('C5 no payoff condition is left open', items.every((i) => i.status === 'satisfied'));
    const worked = items.find((i) => i.code === 'cond_payoff_external');
    ok('C6 the WORKED condition was waived with the [auto] note, never deleted',
      !!worked && !!worked.waived_at && /FREE AND CLEAR/.test(worked.notes || ''));

    // ---- D. turning it OFF ---------------------------------------------------------------
    const r2 = await call(server, 'POST', `/api/staff/applications/${appId}/payoff/free-and-clear`, tok, { on: false, confirm: true });
    ok('D1 the toggle reverses', r2.status === 200 && r2.body.payoff.freeAndClear === false);
    const a2 = (await db.query(`SELECT property_free_and_clear, payoff_amount FROM applications WHERE id=$1`, [appId])).rows[0];
    ok('D2 the $0 is cleared so the missing-payoff nag returns', a2.property_free_and_clear === false && a2.payoff_amount == null);
    items = await payoffItems(appId);
    ok('D3 both conditions are back and open', items.length === 2 && items.every((i) => i.status !== 'satisfied' && !i.waived_at));

    // ---- E. the attorney email -----------------------------------------------------------
    await call(server, 'PATCH', `/api/staff/applications/${appId}/details`, tok,
      { payoffAmount: '185000', payoffLender: 'Old Lender LLC', payoffLoanNumber: 'OL-778', payoffGoodThrough: '2026-09-15' });
    const cp = require('../src/lib/closing-prep');
    const data1 = await cp.getClosingPrepData(appId);
    ok('E1 the data carries the refi kind + the payoff block', data1.isRefinance === true
      && /rate/i.test(data1.refiKindLabel || '') && Number(data1.payoff.amount) === 185000
      && data1.payoff.lender === 'Old Lender LLC' && !!data1.payoff.goodThrough);
    const meta1 = cp.dealMeta(data1).map((r) => `${r.label}: ${r.value}`).join('\n');
    ok('E2 the deal block states the kind and lays the payoff out', /rate/i.test(meta1)
      && /Existing loan payoff: \$185,000/.test(meta1) && /Payoff to: Old Lender LLC/.test(meta1)
      && /Their loan number: OL-778/.test(meta1) && /Payoff good through/.test(meta1));

    await call(server, 'POST', `/api/staff/applications/${appId}/payoff/free-and-clear`, tok, { on: true, confirm: true });
    const data2 = await cp.getClosingPrepData(appId);
    const meta2 = cp.dealMeta(data2).map((r) => `${r.label}: ${r.value}`).join('\n');
    ok('E3 free and clear is STATED to counsel and the payoff rows are gone',
      /FREE AND CLEAR/.test(meta2) && !/Existing loan payoff:/.test(meta2));
    const missing = cp.applicableMissing([{ key: 'payoff', label: 'Existing loan payoff statement' }], data2);
    ok('E4 the payoff document group is skipped as inapplicable', missing.length === 0);
    const missingOnRefi = cp.applicableMissing([{ key: 'payoff', label: 'Existing loan payoff statement' }], data1);
    ok('E5 …but awaited on an ordinary refinance', missingOnRefi.length === 1);
  } finally {
    try {
      if (appId) await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[appId, purchaseId].filter(Boolean)]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-payoff-free-and-clear-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

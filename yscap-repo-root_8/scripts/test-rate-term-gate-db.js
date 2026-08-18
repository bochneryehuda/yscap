#!/usr/bin/env node
'use strict';
/* THE RATE-AND-TERM $2,000 CASH LIMIT + "Validate closing costs" (db/577,
 * owner-directed 2026-08-18), against a real database and the real HTTP routes:
 *
 *   A. the math: cash to borrower = initial advance − payoff − (quote closing
 *      costs + itemized fees); over only on a DEFINITE rate-&-term with a
 *      registered structure; free-and-clear reads a $0 payoff.
 *   B. scope: cash-out / purchase / unregistered files never fire.
 *   C. the closing-cost editor: add/remove over HTTP recomputes live; junk is
 *      refused with a plain reason (never a silent drop, never a 22003).
 *   D. the term-sheet SEND gate carries the 'rate_term_cash' blocker exactly
 *      while over-with-no-exception: validated fees lift it, an APPROVED
 *      super-admin exception lifts it, the Heter Iska purpose is exempt.
 *   E. the exception request route: reason+note required, refused when nothing
 *      is over, lands as a real register row a super-admin decides.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-rate-term-gate-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const RTG = require('../src/lib/rate-term-gate');
const gate = require('../src/lib/esign/gate');
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

const QUOTE = { sizing: { initialAdvance: 300000, totalLoan: 360000 }, closingCosts: { dueAtClosing: 8000 }, noteRate: 10 };
async function register(appId, staffId) {
  await db.query(
    `INSERT INTO product_registrations (application_id, is_current, program, product_label, quote, inputs, total_loan, note_rate, registered_by, stale)
     VALUES ($1,true,'standard','Standard Program',$2,'{}',360000,10,$3,false)`,
    [appId, JSON.stringify(QUOTE), staffId]);
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  let superId, borId, rtId, coId, purId, unregId;
  try {
    superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`rtg-super-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Rate','Term',$1) RETURNING id`, [`rtg-bo-${sfx}@test.local`])).rows[0].id;
    const mk = async (loanType, payoff) => (await db.query(
      `INSERT INTO applications (borrower_id,loan_officer_id,status,loan_type,property_address,payoff_amount)
       VALUES ($1,$2,'underwriting',$3,'{"oneLine":"2 Gate Way"}',$4) RETURNING id`, [borId, superId, loanType, payoff])).rows[0].id;
    rtId = await mk('Refinance - Rate & Term', 250000);
    coId = await mk('Refinance - Cash-Out', 250000);
    purId = await mk('Purchase', null);
    unregId = await mk('Refinance - Rate & Term', 250000);
    await register(rtId, superId);
    await register(coId, superId);
    await register(purId, superId);

    // ---- A. the math ---------------------------------------------------------------------
    let c = await RTG.check(rtId);
    ok('A1 over: 300k initial − 250k payoff − 8k costs = 42k > $2,000',
      c.applies && c.registered && c.cashToBorrower === 42000 && c.over === true && c.blocked === true);
    await db.query(`UPDATE applications SET payoff_amount=291000 WHERE id=$1`, [rtId]);
    c = await RTG.check(rtId);
    ok('A2 under: 300k − 291k − 8k = 1k ≤ $2,000 — not over', c.cashToBorrower === 1000 && c.over === false);
    await db.query(`UPDATE applications SET payoff_amount=NULL, property_free_and_clear=true WHERE id=$1`, [rtId]);
    c = await RTG.check(rtId);
    ok('A3 free and clear reads a $0 payoff — the whole initial advance is cash',
      c.freeAndClear === true && c.payoff === 0 && c.cashToBorrower === 292000 && c.over === true);
    await db.query(`UPDATE applications SET property_free_and_clear=false, payoff_amount=250000 WHERE id=$1`, [rtId]);

    // ---- B. scope ------------------------------------------------------------------------
    ok('B1 a cash-out never fires', (await RTG.check(coId)).applies === false);
    ok('B2 a purchase never fires', (await RTG.check(purId)).applies === false);
    const un = await RTG.check(unregId);
    ok('B3 an unregistered rate-&-term cannot be judged — never over', un.registered === false && un.over === false && un.blocked === false);

    // ---- C. the closing-cost editor ------------------------------------------------------
    const bad1 = await call(server, 'POST', `/api/staff/applications/${rtId}/closing-costs`, tok, { kind: 'nope', label: 'x', amount: 5 });
    ok('C1 an unknown fee type is refused', bad1.status === 400);
    const bad2 = await call(server, 'POST', `/api/staff/applications/${rtId}/closing-costs`, tok, { kind: 'custom', label: '', amount: 5 });
    ok('C2 a nameless fee is refused', bad2.status === 400);
    const bad3 = await call(server, 'POST', `/api/staff/applications/${rtId}/closing-costs`, tok, { kind: 'title_fee', label: 'Title', amount: -5 });
    ok('C3 a negative amount is refused', bad3.status === 400);
    const bad4 = await call(server, 'POST', `/api/staff/applications/${rtId}/closing-costs`, tok, { kind: 'title_fee', label: 'Title', amount: 9999999999999 });
    ok('C4 an unstorable amount is refused with the column\'s own limit, never truncated',
      bad4.status === 400 && /largest amount/.test((bad4.body && bad4.body.error) || ''));
    const add1 = await call(server, 'POST', `/api/staff/applications/${rtId}/closing-costs`, tok, { kind: 'mortgage_tax', label: 'NY mortgage tax', amount: 30000 });
    ok('C5 a real fee lands and the check recomputes live',
      add1.status === 200 && add1.body.check.itemizedClosingCosts === 30000 && add1.body.check.cashToBorrower === 12000 && add1.body.check.over === true);
    const add2 = await call(server, 'POST', `/api/staff/applications/${rtId}/closing-costs`, tok, { kind: 'attorney_fee', label: 'Attorney fee', amount: 10500 });
    ok('C6 enough validated fees bring the deal back under — it can STAY a rate-&-term',
      add2.status === 200 && add2.body.check.cashToBorrower === 1500 && add2.body.check.over === false);
    const del1 = await call(server, 'DELETE', `/api/staff/applications/${rtId}/closing-costs/${add2.body.id}`, tok);
    ok('C7 removing a fee recomputes back over', del1.status === 200 && del1.body.check.over === true);

    // ---- D. the SEND gate ----------------------------------------------------------------
    let g = await gate.esignSendGate(rtId, { purpose: 'term_sheet_package' });
    ok('D1 the send gate carries the rate_term_cash blocker while over',
      (g.outstanding || []).some((o) => o.code === 'rate_term_cash' && /more than the \$2,000/.test(o.reason)));
    g = await gate.esignSendGate(rtId, { purpose: 'heter_iska' });
    ok('D2 the Heter Iska package is exempt', !(g.outstanding || []).some((o) => o.code === 'rate_term_cash'));
    const add3 = await call(server, 'POST', `/api/staff/applications/${rtId}/closing-costs`, tok, { kind: 'attorney_fee', label: 'Attorney fee', amount: 10500 });
    g = await gate.esignSendGate(rtId, { purpose: 'term_sheet_package' });
    ok('D3 validating the real fees lifts the blocker', add3.status === 200 && !(g.outstanding || []).some((o) => o.code === 'rate_term_cash'));
    await call(server, 'DELETE', `/api/staff/applications/${rtId}/closing-costs/${add3.body.id}`, tok);

    // ---- E. the exception ----------------------------------------------------------------
    const e1 = await call(server, 'POST', `/api/staff/applications/${rtId}/rate-term-gate/request-exception`, tok, { reason: 'other' });
    ok('E1 a note is required', e1.status === 400);
    const e2 = await call(server, 'POST', `/api/staff/applications/${rtId}/rate-term-gate/request-exception`, tok, { reason: 'other', note: 'Investor confirmed the structure — send as-is.' });
    ok('E2 the request lands as a real register row', e2.status === 200 && e2.body.exception && e2.body.exception.status === 'requested');
    // a super-admin approval lifts the gate (approve directly — the decide route's own
    // machinery is covered by the exception-register suites)
    await db.query(`UPDATE loan_exceptions SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1`, [e2.body.exception.id, superId]);
    const c2 = await RTG.check(rtId);
    ok('E3 the approved exception is read by the check', !!c2.exception && c2.blocked === false && c2.over === true);
    g = await gate.esignSendGate(rtId, { purpose: 'term_sheet_package' });
    ok('E4 …and the send gate stands down', !(g.outstanding || []).some((o) => o.code === 'rate_term_cash'));
    const e3 = await call(server, 'POST', `/api/staff/applications/${rtId}/rate-term-gate/request-exception`, tok, { reason: 'other', note: 'again' });
    ok('E5 a second request on an already-approved file is refused', e3.status === 409);
    const notOver = await call(server, 'POST', `/api/staff/applications/${coId}/rate-term-gate/request-exception`, tok, { reason: 'other', note: 'x' });
    ok('E6 a file that is not over needs no exception', notOver.status === 409);
    ok('E7 the registry names the type with super-admin decide authority',
      require('../src/lib/loan-exceptions').typeConfig('rate_term_cash').decideRole === 'super_admin');
  } finally {
    try {
      await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[rtId, coId, purId, unregId].filter(Boolean)]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-rate-term-gate-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

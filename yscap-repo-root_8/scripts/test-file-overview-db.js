#!/usr/bin/env node
'use strict';
/* THE FILE-OVERVIEW SLIDE-OVER (owner-directed 2026-08-18) — one builder,
 * three doors, against a real database + the real HTTP routes:
 *
 *   A. the internal payload carries every figure the owner listed: who, the
 *      entity, the address, purchase price, underlying + assignment fee, total
 *      loan, holdbacks, initial loan, origination points, rate, transaction
 *      type — and unknowns are OMITTED, never printed as $0.
 *   B. the borrower audience is scrubbed, and the NOTE BUYER appears in NO
 *      audience's payload at all (the owner's list does not name it).
 *   C. the doors: staff 200; the borrower sees their own file and a stranger's
 *      borrower token answers 404.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-file-overview-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const FO = require('../src/lib/file-overview');
const app = require('../src/server');

function call(server, method, path, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); r.end();
  });
}
const rowsOf = (card) => (card.sections || []).flatMap((s) => s.rows);
const valOf = (card, label) => { const r = rowsOf(card).find((x) => x.label === label); return r ? r.value : undefined; };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  let staffId, borId, coId, strangerId, llcId, appId, bareId;
  try {
    staffId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Overview Officer','super_admin',true,false,'x',0) RETURNING id`, [`fov-staff-${sfx}@test.local`])).rows[0].id;
    const sTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });
    const mkB = async (fn, ln) => {
      const id = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,$2,$3) RETURNING id`, [fn, ln, `fov-${fn.toLowerCase()}-${sfx}@test.local`])).rows[0].id;
      await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [id]);
      return id;
    };
    borId = await mkB('Frank', 'Overview');
    coId = await mkB('Cora', 'Overview');
    strangerId = await mkB('Sally', 'Stranger');
    llcId = (await db.query(`INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'Overview Holdings LLC') RETURNING id`, [borId])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id, co_borrower_id, llc_id, loan_officer_id, status, ys_loan_number, lender,
              property_address, loan_type, rehab_type, is_assignment, underlying_contract_price, assignment_fee,
              purchase_price, as_is_value, arv, rehab_budget)
       VALUES ($1,$2,$3,$4,'underwriting','YSCAP-FOV-1','Blue Lake',
              '{"oneLine":"9 Overview Ave, Newark, NJ 07104"}','Purchase','Light Rehab',true,280000,20000,
              300000,310000,450000,80000) RETURNING id`, [borId, coId, llcId, staffId])).rows[0].id;
    await db.query(
      `INSERT INTO product_registrations (application_id, program, product_label, inputs, quote, is_current)
       VALUES ($1,'gold','Gold Standard Program','{}'::jsonb,$2,true)`,
      [appId, JSON.stringify({ noteRate: 10.5, origPct: 2, origination: 7200,
        sizing: { totalLoan: 360000, initialAdvance: 248000, rehabHoldback: 80000, financedReserve: 32000, acqLtvPct: 0.8, arvPct: 0.8 } })]);
    // A bare, unregistered file for the omit-don't-guess check.
    bareId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, property_address, loan_type)
       VALUES ($1,$2,'file_intake','{"oneLine":"1 Bare St"}','Purchase') RETURNING id`, [borId, staffId])).rows[0].id;

    // ---- A. the internal payload -----------------------------------------------------------
    const card = await FO.buildFileOverview(appId, { audience: 'internal' });
    ok('A1 who: borrower + co-borrower + entity', valOf(card, 'Borrower') === 'Frank Overview'
      && valOf(card, 'Co-borrower') === 'Cora Overview' && valOf(card, 'Vesting entity') === 'Overview Holdings LLC');
    ok('A2 address + transaction type', valOf(card, 'Address') === '9 Overview Ave, Newark, NJ 07104'
      && /Purchase/.test(valOf(card, 'Transaction type') || ''));
    ok('A3 the assignment splits into underlying + fee', valOf(card, 'Purchase price') === '$300,000'
      && valOf(card, 'Underlying contract price') === '$280,000' && valOf(card, 'Assignment fee') === '$20,000');
    ok('A4 the loan structure', valOf(card, 'Total loan') === '$360,000' && valOf(card, 'Initial loan (advance)') === '$248,000'
      && valOf(card, 'Construction holdback') === '$80,000' && valOf(card, 'Interest reserve (financed)') === '$32,000');
    ok('A5 origination points + rate', valOf(card, 'Origination points') === '2% · $7,200' && valOf(card, 'Interest rate') === '10.5%');
    ok('A6 leverage', valOf(card, 'Initial LTV') === '80%' && valOf(card, 'ARV LTV') === '80%');
    ok('A7 the header names the file', card.header.loanNumber === 'YSCAP-FOV-1' && /Overview Ave/.test(card.header.address || ''));

    const bare = await FO.buildFileOverview(bareId, { audience: 'internal' });
    ok('A8 an unregistered file OMITS the loan figures rather than guessing $0',
      valOf(bare, 'Total loan') === undefined && valOf(bare, 'Interest rate') === undefined
      && valOf(bare, 'Borrower') === 'Frank Overview');

    // ---- B. borrower-safe + the note buyer never rides -------------------------------------
    const bCard = await FO.buildFileOverview(appId, { audience: 'borrower' });
    ok('B1 the borrower audience carries the same deal facts', valOf(bCard, 'Total loan') === '$360,000'
      && valOf(bCard, 'Purchase price') === '$300,000');
    ok('B2 the NOTE BUYER appears in NO audience\'s payload',
      !/blue\s*lake/i.test(JSON.stringify(card)) && !/blue\s*lake/i.test(JSON.stringify(bCard)));
    ok('B3 an unknown file answers null, never throws', (await FO.buildFileOverview(crypto.randomUUID(), {})) === null
      && (await FO.buildFileOverview('garbage', {})) === null);

    // ---- C. the doors ----------------------------------------------------------------------
    const sr = await call(server, 'GET', `/api/staff/applications/${appId}/overview-card`, sTok);
    ok('C1 the staff door answers the internal card', sr.status === 200 && sr.body && sr.body.header.loanNumber === 'YSCAP-FOV-1');
    const bTok = C.signJwt({ sub: borId, kind: 'borrower', tv: 0 });
    const br = await call(server, 'GET', `/api/borrower/applications/${appId}/overview-card`, bTok);
    ok('C2 the borrower sees their own file', br.status === 200 && br.body && !/blue\s*lake/i.test(JSON.stringify(br.body)));
    const strTok = C.signJwt({ sub: strangerId, kind: 'borrower', tv: 0 });
    const str = await call(server, 'GET', `/api/borrower/applications/${appId}/overview-card`, strTok);
    ok('C3 a stranger\'s borrower token answers 404', str.status === 404);
  } finally {
    try {
      await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[appId, bareId].filter(Boolean)]);
      if (llcId) await db.query(`DELETE FROM llcs WHERE id=$1`, [llcId]);
      await db.query(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [[borId, coId, strangerId].filter(Boolean)]);
      if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-file-overview-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

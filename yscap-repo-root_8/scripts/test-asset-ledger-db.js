#!/usr/bin/env node
'use strict';
/* THE VERIFIED-ASSETS LEDGER + MAX CASH TO CLOSE (db/574, owner-directed 2026-08-18),
 * against a real database and the real HTTP routes. What is pinned:
 *
 *   A. the pure merge: an empty ledger is the IDENTITY over the document read (no
 *      behaviour change for the whole back book); an override's amount/include wins;
 *      a manual row adds; a stale override (its account left the read set) never counts;
 *      maxCashToCloseOf is verified − reserve − buffer, and NULL with nothing countable
 *      (never a confident $0); the entryProblem refusals.
 *   B. the algebraic-inverse guarantee: an actual cash-to-close AT the max passes
 *      closing.decideCashToClose, one $2 over it fails — the two can never disagree.
 *   C. the routes over real HTTP: read the ledger, correct an account's amount,
 *      exclude it, add a manual account, delete back to the document read — and the
 *      closing money check (runCashToCloseCheck) follows the LEDGER total.
 *   D. the condition stamp: tool_payload.assetLedger + an [auto]-guarded note on
 *      rtl_p3_assets; a note a human typed is never overwritten.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-asset-ledger-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const ledger = require('../src/lib/underwriting/asset-ledger');
const closing = require('../src/lib/closing');
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

(async () => {
  // ---- A. the pure merge -----------------------------------------------------------------
  const acct = (over) => Object.assign({ holder: 'Asset Ledger', bankName: 'Chase', accountNumber: '••1234',
    tied: true, ending: 50000, holderIsBusiness: false, statementCount: 2, countedPeriod: 'July 2026', document_id: null }, over);
  const A1 = acct({}), A2 = acct({ holder: 'Other LLC', accountNumber: '••9999', tied: false, ending: 30000 });
  const assessment = { accounts: [A1, A2], qualifyingTotal: 50000 };

  const empty = ledger.mergeLedger(assessment, []);
  ok('A1 empty ledger is the identity (total)', empty.verifiedTotal === 50000 && empty.readTotal === 50000 && empty.adjusted === false);
  ok('A2 untied account excluded by default', empty.rows.find((r) => r.holder === 'Other LLC').included === false);

  const key1 = ledger.accountKeyOf(A1);
  ok('A3 the account key is stable across re-reads', key1 === ledger.accountKeyOf(acct({ ending: 60000, statementCount: 3 })));

  const withOverride = ledger.mergeLedger(assessment, [{ kind: 'override', account_key: key1, amount: '42000', include: null }]);
  ok('A4 an override amount wins over the read balance', withOverride.verifiedTotal === 42000 && withOverride.adjusted === true);

  const included = ledger.mergeLedger(assessment, [{ kind: 'override', account_key: ledger.accountKeyOf(A2), amount: null, include: true }]);
  ok('A5 an include flag counts an excluded account at its read balance', included.verifiedTotal === 80000);

  const excluded = ledger.mergeLedger(assessment, [{ kind: 'override', account_key: key1, amount: null, include: false }]);
  ok('A6 an exclude flag removes a counted account', excluded.verifiedTotal === 0 && excluded.haveCountable === false);

  const manual = ledger.mergeLedger(assessment, [{ kind: 'manual', id: 'm1', holder: 'New Bank Acct', institution: 'TD', amount: '10000', include: true }]);
  ok('A7 a manual account adds', manual.verifiedTotal === 60000);

  const stale = ledger.mergeLedger(assessment, [{ kind: 'override', id: 'o1', account_key: 'a|gone|gone|gone', amount: '99999', include: true }]);
  ok('A8 a stale override (account no longer read) never counts', stale.verifiedTotal === 50000
    && stale.rows.some((r) => r.source === 'stale_override' && r.included === false));

  ok('A9 max cash to close = verified − reserve − buffer', ledger.maxCashToCloseOf({ verifiedTotal: 100000, reserveRequirement: 20000, closingBuffer: 5000, haveCountable: true }) === 75000);
  ok('A10 never negative', ledger.maxCashToCloseOf({ verifiedTotal: 10000, reserveRequirement: 20000, closingBuffer: 0, haveCountable: true }) === 0);
  ok('A11 NULL with nothing countable — never a confident $0', ledger.maxCashToCloseOf({ verifiedTotal: 0, reserveRequirement: 20000, closingBuffer: 0, haveCountable: false }) === null);

  ok('A12 entryProblem: bad kind refused', !!ledger.entryProblem({ kind: 'x' }));
  ok('A13 entryProblem: override needs its account', !!ledger.entryProblem({ kind: 'override' }));
  ok('A14 entryProblem: negative amount refused', !!ledger.entryProblem({ kind: 'manual', holder: 'x', amount: '-5' }));
  ok('A15 entryProblem: unstorable amount refused, never truncated', !!ledger.entryProblem({ kind: 'manual', holder: 'x', amount: '9999999999999' }));
  ok('A16 entryProblem: a clean manual row passes', ledger.entryProblem({ kind: 'manual', holder: 'x', amount: '100' }) === null);

  // ---- B. the algebraic inverse ----------------------------------------------------------
  const max = ledger.maxCashToCloseOf({ verifiedTotal: 100000, reserveRequirement: 20000, closingBuffer: 1000, haveCountable: true });
  const atMax = closing.decideCashToClose({ verified: 100000, reserve: 20000, closingBuffer: 1000, actualCashToClose: max, haveCountable: true });
  const overMax = closing.decideCashToClose({ verified: 100000, reserve: 20000, closingBuffer: 1000, actualCashToClose: max + 2, haveCountable: true });
  ok('B1 an actual AT the max passes the money gate', atMax.ok === true);
  ok('B2 an actual $2 over the max fails it', overMax.ok === false);

  // ---- fixtures --------------------------------------------------------------------------
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  let superId, borId, appId;
  try {
    superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`al-super-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Asset','Ledger',$1) RETURNING id`, [`al-bo-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(`INSERT INTO applications (borrower_id,loan_officer_id,status,property_address) VALUES ($1,$2,'underwriting','{"oneLine":"77 Ledger Ln"}') RETURNING id`, [borId, superId])).rows[0].id;

    // The assets condition carrying the frozen breakdown the registration writes.
    const tplId = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_p3_assets' LIMIT 1`)).rows[0].id;
    const liq = { required: 60000, cashToClose: 35000, reserveRequirement: 20000, reserveBasis: '4 months of payments', closingBuffer: 5000, closingBufferWaived: false, computedAt: new Date().toISOString() };
    const itemId = (await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind, status, tool_payload)
       VALUES ($1,'application',$2,'Assets & bank statements verified','both','document','outstanding',$3) RETURNING id`,
      [tplId, appId, JSON.stringify({ liquidity: liq })])).rows[0].id;

    // One analyzed bank statement whose holder is the borrower — a tied $50,000 account.
    await db.query(
      `INSERT INTO document_extractions (application_id, doc_type, status, is_current, superseded, fields)
       VALUES ($1,'bank_statement','analyzed',true,false,$2)`,
      [appId, JSON.stringify({ readable: true, accountHolderName: 'Asset Ledger', bankName: 'Chase',
        accountNumber: 'XXXX1234', closingBalance: 50000, statementPeriod: 'July 2026' })]);

    // ---- C. the routes -------------------------------------------------------------------
    const g1 = await call(server, 'GET', `/api/staff/applications/${appId}/asset-ledger`, tok);
    ok('C1 the ledger reads', g1.status === 200 && Array.isArray(g1.body.rows) && g1.body.rows.length === 1);
    ok('C2 the read account counts at its document balance', g1.body.verifiedTotal === 50000 && g1.body.readTotal === 50000);
    ok('C3 max cash to close off the stored breakdown', g1.body.maxCashToClose === 25000); // 50000 − 20000 − 5000
    const rowKey = g1.body.rows[0].key;

    const p1 = await call(server, 'POST', `/api/staff/applications/${appId}/asset-ledger/entries`, tok,
      { kind: 'override', accountKey: rowKey, holder: 'Asset Ledger', institution: 'Chase', accountNumber: '••1234', amount: '45000', include: true, note: 'Statement misread — corrected off the PDF' });
    ok('C4 an override saves and recomputes', p1.status === 200 && p1.body.ledger.verifiedTotal === 45000 && p1.body.ledger.maxCashToClose === 20000);

    const p2 = await call(server, 'POST', `/api/staff/applications/${appId}/asset-ledger/entries`, tok,
      { kind: 'manual', holder: 'Asset Ledger', institution: 'TD Bank', accountNumber: '••5678', amount: '15000', include: true });
    ok('C5 a manual account adds', p2.status === 200 && p2.body.ledger.verifiedTotal === 60000);

    const p3 = await call(server, 'POST', `/api/staff/applications/${appId}/asset-ledger/entries`, tok, { kind: 'manual' });
    ok('C6 a nameless manual row is refused with a reason', p3.status === 400 && /holder|institution/i.test(p3.body.error || ''));

    // The closing money check follows the LEDGER, not the raw read.
    const chk = await closing.runCashToCloseCheck(appId, 30000);
    ok('C7 runCashToCloseCheck reads the ledger total', chk.verified === 60000 && chk.ledgerAdjusted === true);
    ok('C8 and carries maxCashToClose', chk.maxCashToClose === 35000); // 60000 − 20000 − 5000

    // A second override on the SAME account replaces the first (the partial-unique upsert).
    const p4 = await call(server, 'POST', `/api/staff/applications/${appId}/asset-ledger/entries`, tok,
      { kind: 'override', accountKey: rowKey, amount: '48000', include: true });
    ok('C9 a second correction replaces, never duplicates', p4.status === 200 && p4.body.ledger.verifiedTotal === 63000
      && (await db.query(`SELECT count(*)::int n FROM asset_ledger_entries WHERE application_id=$1 AND kind='override'`, [appId])).rows[0].n === 1);

    // ---- D. the condition stamp ----------------------------------------------------------
    const item1 = (await db.query(`SELECT tool_payload, notes FROM checklist_items WHERE id=$1`, [itemId])).rows[0];
    ok('D1 tool_payload.assetLedger stamped, liquidity untouched', item1.tool_payload.assetLedger
      && item1.tool_payload.assetLedger.maxCashToClose === 38000 // 63000 − 20000 − 5000
      && item1.tool_payload.liquidity.required === 60000);
    ok('D2 the [auto] note states the max', /^\[auto\] Max cash to close: \$38,000\.00/.test(item1.notes || ''));

    // A note a human typed is never overwritten.
    await db.query(`UPDATE checklist_items SET notes='Reviewer: waiting on the August statement' WHERE id=$1`, [itemId]);
    await call(server, 'POST', `/api/staff/applications/${appId}/asset-ledger/entries`, tok,
      { kind: 'manual', holder: 'Asset Ledger', institution: 'Citi', amount: '1000' });
    const item2 = (await db.query(`SELECT notes, tool_payload FROM checklist_items WHERE id=$1`, [itemId])).rows[0];
    ok('D3 a human note survives; the payload stamp still updates', item2.notes === 'Reviewer: waiting on the August statement'
      && item2.tool_payload.assetLedger.maxCashToClose === 39000);

    // Delete back to the document read.
    const ovId = (await db.query(`SELECT id FROM asset_ledger_entries WHERE application_id=$1 AND kind='override'`, [appId])).rows[0].id;
    const d1 = await call(server, 'DELETE', `/api/staff/applications/${appId}/asset-ledger/entries/${ovId}`, tok);
    ok('D4 removing the override returns the account to what the documents say', d1.status === 200
      && d1.body.ledger.rows.find((r) => r.key === rowKey).amount === 50000);

    // The audit trail says who touched the money.
    const aud = (await db.query(`SELECT count(*)::int n FROM audit_log WHERE entity_id=$1 AND action LIKE 'asset_ledger%'`, [appId])).rows[0].n;
    ok('D5 every write is audited', aud >= 4);
  } finally {
    try {
      if (appId) {
        await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
        await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
        await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]);
      }
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-asset-ledger-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

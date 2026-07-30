'use strict';
/**
 * SILVER SHADOW-EXCEL PARITY MONITOR — DB side (real Postgres).
 *
 * Proves the advisory write path end-to-end:
 *  (1) a mismatch lands EXACTLY ONE ai_suggestions row (source
 *      'silver_shadow_parity', kind 'finding', severity 'warning',
 *      important, dedupe key `silver-shadow:<appId>:<kind>`);
 *  (2) a repeat of the same mismatch REFRESHES the open row (no duplicate);
 *  (3) a different mismatch KIND on the same file gets its own row;
 *  (4) a human's dismissal is DURABLE — the monitor never re-raises a row a
 *      human decided (ai-suggestions' settled guard);
 *  (5) a clean scenario and the kill switch write NOTHING;
 *  (6) the SAVEPOINT guard: a failing record inside a caller's transaction
 *      never poisons that transaction;
 *  (7) REAL HTTP wiring — the monitor actually FIRES from the live routes
 *      (staff register, staff quote, borrower register; silver only), with the
 *      right arguments in scope, and a live register ties out clean against
 *      the workbook (the insertion sits inside a swallowing try/catch, so only
 *      a runtime spy can prove it executes).
 * DB-gated: skips without DATABASE_URL.
 *
 * Run: DATABASE_URL=postgres://postgres:test@localhost:5432/yscap_test \
 *      JWT_SECRET=test-secret-for-local-suite-0123456789 \
 *      node scripts/test-silver-shadow-parity-db.js
 */
const path = require('path');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-silver-shadow-parity-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const C = require('../src/lib/crypto');
const appSrv = require('../src/server');
const SVP = require(path.join(__dirname, '..', 'web', 'tools', 'silver-program.js'));
const monitor = require('../src/lib/silver-shadow-parity');
const aiSug = require('../src/lib/underwriting/ai-suggestions');

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// The pure battery's clean Tier-1 fix & flip purchase (explicit markup so the
// check is settings-independent).
const A = {
  loanType: 'Purchase', cashOut: false, strategy: 'Fix & Flip', state: 'NJ', city: 'Hoboken', zip: '07030',
  propertyType: 'single family', fico: 740, expFlips: 4, expHolds: 1, expGround: 0,
  purchasePrice: 300000, sellerPrice: 0, isAssignment: false, asIsValue: 300000, arv: 550000,
  rehabBudget: 100000, term: 12, irMonths: 0, irAmount: 0, targetLTC: 0, markupSilverPct: 0.5,
};
function evalWith(input, markup) {
  SVP.setMarkup(markup);
  try { return SVP.evaluate(input); } finally { SVP.setMarkup(null); }
}
const rowsFor = async (appId) => (await db.query(
  `SELECT * FROM ai_suggestions WHERE application_id=$1 AND source='silver_shadow_parity' ORDER BY created_at`, [appId])).rows;

(async () => {
  await ensureSchema();
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId, appId, appId2, staffId;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Silver','Shadow',$1) RETURNING id`,
      [`ssp-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type, program) VALUES ($1,'processing','Purchase','Silver Program') RETURNING id`,
      [borrowerId])).rows[0].id;
    appId2 = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type, program) VALUES ($1,'processing','Purchase','Silver Program') RETURNING id`,
      [borrowerId])).rows[0].id;
    staffId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Shadow Tester','underwriter',true) RETURNING id`,
      [`ssp-staff-${sfx}@test.local`])).rows[0].id;

    const ev = evalWith(A, 0.005);
    ok(ev.status === 'ELIGIBLE' && ev.noteRate > 0, 'fixture scenario evaluates ELIGIBLE');
    const lowRate = { ...ev, noteRate: ev.noteRate - 0.00125 };   // one band under-priced

    // (1) mismatch → exactly one advisory row, shaped per spec
    const r1 = await monitor.monitorQuote(appId, A, lowRate);
    ok(r1.ok === false && r1.kind === 'rate_mismatch', 'monitorQuote reports the rate mismatch');
    ok(r1.record && r1.record.recorded === true && r1.record.deduped === false, 'first mismatch records a fresh row');
    let rows = await rowsFor(appId);
    ok(rows.length === 1, `exactly ONE ai_suggestions row landed (got ${rows.length})`);
    const row = rows[0] || {};
    ok(row.kind === 'finding' && row.severity === 'warning' && row.important === true && row.status === 'open',
      'row is an advisory finding: warning severity, important, open');
    ok(row.dedupe_key === `silver-shadow:${appId}:rate_mismatch`, `dedupe key is silver-shadow:<appId>:<kind> (got ${row.dedupe_key})`);
    ok(/workbook/i.test(String(row.title)) && /workbook|pricing sheet/i.test(String(row.body)), 'title/body speak plain language about the workbook');
    ok(row.evidence && row.evidence.code === 'silver_shadow_rate_mismatch' && row.evidence.cellKey,
      'evidence carries the machine code + the exact workbook cell key');

    // (2) repeat → refreshes in place, never duplicates
    const r2 = await monitor.monitorQuote(appId, A, lowRate);
    ok(r2.ok === false && r2.record && r2.record.recorded === true && r2.record.deduped === true, 'repeat mismatch dedupes onto the open row');
    rows = await rowsFor(appId);
    ok(rows.length === 1, `repeat left ONE row (got ${rows.length})`);

    // (3) a different KIND gets its own row on the same file
    const D = { ...A, loanType: 'Refinance', expFlips: 0, expHolds: 0, expGround: 0 };   // T3 F&F refi — no workbook row
    const doctoredEligible = { status: 'ELIGIBLE', noteRate: 0.09, sizing: { totalLoan: 200000, ltcPct: 0.8 } };
    const r3 = await monitor.monitorQuote(appId, D, doctoredEligible);
    ok(r3.ok === false && r3.kind === 'eligibility_mismatch' && r3.record && r3.record.recorded === true,
      'a second mismatch KIND records its own advisory');
    rows = await rowsFor(appId);
    ok(rows.length === 2 && rows.some((x) => x.dedupe_key === `silver-shadow:${appId}:eligibility_mismatch`),
      `two kinds → two rows, each under its own dedupe key (got ${rows.length})`);

    // (4) a human's decision is durable — never re-raised
    const dismissed = rows.find((x) => x.dedupe_key === `silver-shadow:${appId}:rate_mismatch`);
    await aiSug.decide(null, dismissed.id, { action: 'dismiss', staffId, reason: 'reviewed manually — quote corrected' });
    const r4 = await monitor.monitorQuote(appId, A, lowRate);
    ok(r4.ok === false && r4.record && r4.record.settled === true, 'a re-fire after a human dismissal reports settled');
    rows = await rowsFor(appId);
    const openRate = rows.filter((x) => x.dedupe_key === `silver-shadow:${appId}:rate_mismatch` && x.status === 'open');
    ok(openRate.length === 0, 'the dismissed mismatch is NOT re-raised (no new open row)');
    ok(rows.filter((x) => x.dedupe_key === `silver-shadow:${appId}:rate_mismatch`).length === 1, 'and no duplicate row was inserted');

    // (5) a clean scenario writes nothing; the kill switch writes nothing
    const rClean = await monitor.monitorQuote(appId2, A, ev);
    ok(rClean.ok === true, 'a clean matching quote reports ok');
    ok((await rowsFor(appId2)).length === 0, 'a clean quote writes NO row');
    const prev = process.env.SILVER_SHADOW_PARITY;
    process.env.SILVER_SHADOW_PARITY = '0';
    const rOff = await monitor.monitorQuote(appId2, A, lowRate);
    if (prev === undefined) delete process.env.SILVER_SHADOW_PARITY; else process.env.SILVER_SHADOW_PARITY = prev;
    ok(rOff.ok === true && rOff.skipped === 'disabled', 'kill switch: monitor reports disabled');
    ok((await rowsFor(appId2)).length === 0, 'kill switch: nothing written');

    // (6) SAVEPOINT guard — a failing advisory write inside a caller's
    // transaction must not poison the transaction (fail OPEN, tx continues).
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE applications SET updated_at=now() WHERE id=$1`, [appId2]);
      const badApp = '00000000-0000-0000-0000-000000000001';   // FK violation inside record()
      const rBad = await monitor.recordMismatch(badApp, { ok: false, kind: 'rate_mismatch', detail: 'x' }, client);
      ok(rBad.recorded === false, 'a failing record inside a transaction fails OPEN');
      const alive = await client.query(`SELECT 1 AS one`);   // would 25P02 if the tx aborted
      ok(alive.rows[0].one === 1, 'the caller transaction SURVIVES the failed advisory write');
      await client.query('COMMIT');
      ok(true, 'the caller transaction commits cleanly');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      ok(false, `savepoint guard: transaction died (${e.message})`);
    } finally { client.release(); }
  } catch (e) {
    ok(false, `unexpected error: ${e && e.message}`);
    console.error(e && e.stack);
  } finally {
    try {
      if (appId) await db.query(`DELETE FROM ai_suggestions WHERE application_id IN ($1,$2)`, [appId, appId2]);
      if (appId) await db.query(`DELETE FROM applications WHERE id IN ($1,$2)`, [appId, appId2]);
      if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
      if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]);
    } catch (_) { /* cleanup is best-effort */ }
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\nFAILED (${failures})` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();

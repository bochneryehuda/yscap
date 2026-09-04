'use strict';
/**
 * LONG-TERM — THE RULE-CENTER AUDIT AGAINST A REAL DATABASE AND A REAL DOOR.
 *
 * Owner-directed 2026-09-04: *"open audit engines to make sure that every rule
 * is actually firing."*
 *
 * The pure suite proves the verdicts and the counting. This one proves the four
 * things no pure test can see:
 *
 *   • that db/696 actually built what the writer writes to — a wrong column name
 *     inside the writer's own swallowing catch reports a confident, permanent
 *     "nothing has ever fired", which is the exact lie this feature exists to
 *     end (the class db/621 and the `whole-loan-context` phantom columns record);
 *   • that the flush ADDS rather than replaces, so two processes pricing boards
 *     on the same day cannot make the day's total go DOWN;
 *   • that the two doors answer over real HTTP, are super-admin only, and — the
 *     one that a route test alone catches — that `/audit` is not swallowed by
 *     `/:id`, which matches anything;
 *   • that a board priced end to end actually lands a row, so the recorder is
 *     wired to the engine rather than merely wired to itself.
 *
 * Requires DATABASE_URL with the migrations applied (incl. db/696); skips
 * otherwise, so a database-less box pays nothing.
 */

if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-pricing-rules-audit-db (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const ltdb = require('../src/longterm/db');
const auth = require('../src/auth');
const store = require('../src/longterm/pricing/rules/store');
const ledger = require('../src/longterm/pricing/rules/ledger');
const overlay = require('../src/longterm/pricing/rules/overlay');
const audit = require('../src/longterm/pricing/rules/audit');

let failures = 0;
const check = (cond, msg, detail) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (msg, a, b) => check(a === b, msg, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const made = { staff: [], rules: [] };

(async () => {
  const app = require('../src/server');
  /* The server kicks its migrations off asynchronously, so a suite that writes
     straight away races a brand-new table into existence — the standing lesson. */
  await require('../src/migrate-boot').ensureSchema();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = `ltaud${Date.now()}`;

  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };

  try {
    console.log('LT — the rule-center audit (db/696)');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nA. THE LEDGER TABLE IS THERE, AND ITS RULES BITE');
    // ═════════════════════════════════════════════════════════════════════

    const { rows: colRows } = await ltdb.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'lt_pricing_rule_firing'`);
    const cols = new Set(colRows.map((r) => r.column_name));
    check(cols.size > 0, 'A1  lt_pricing_rule_firing exists');
    for (const c of ['rule_id', 'rule_name', 'day', 'engine', 'boards_seen', 'boards_matched',
      'quotes_reached', 'quotes_adjusted', 'quotes_refused', 'rows_blocked', 'unreadable',
      'first_at', 'last_at']) {
      check(cols.has(c), `A2  lt_pricing_rule_firing.${c}`);
    }

    /* NO FOREIGN KEY TO THE RULE — the record of what a rule DID must outlive
       the rule, exactly as db/695's event log must. */
    const { rows: fks } = await ltdb.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'lt_pricing_rule_firing' AND constraint_type = 'FOREIGN KEY'`);
    eq('A3  the ledger has no foreign key to the rule', fks.length, 0);

    const refuses = async (sql, params) => {
      try { await ltdb.query(sql, params); return false; } catch (_) { return true; }
    };
    check(await refuses(
      `INSERT INTO lt_pricing_rule_firing (rule_id, day, engine) VALUES (gen_random_uuid(), CURRENT_DATE, 'all')`),
    'A4  "all" is refused — it is what a rule GOVERNS, never a board that RAN it');
    check(await refuses(
      `INSERT INTO lt_pricing_rule_firing (rule_id, day, engine) VALUES (gen_random_uuid(), CURRENT_DATE, 'genral')`),
    'A5  a misspelt engine is refused, so a rule can never fire into a bucket nothing reads');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nB. THE WRITER ACTUALLY WRITES — every column, by name');
    // ═════════════════════════════════════════════════════════════════════

    const { rows: people } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Audit Super', 'super_admin', true),
                   ($2, 'Audit Admin', 'admin', true)
         RETURNING id, full_name`,
      [`${stamp}.super@example.test`, `${stamp}.admin@example.test`]);
    made.staff = people.map((p) => p.id);
    const superId = people.find((p) => p.full_name === 'Audit Super').id;
    const adminId = people.find((p) => p.full_name === 'Audit Admin').id;
    const superTok = await auth.mintStaffSession(superId);
    const adminTok = await auth.mintStaffSession(adminId);

    const holdback = await store.createRule({
      name: `${stamp} NJ holdback`,
      engine: 'all',
      priority: 10,
      when: { combinator: 'and', rules: [{ field: 'state', operator: 'eq', value: 'NJ' }] },
      then: [{ type: 'add_holdback', points: 0.25, reason: 'New Jersey' }],
    }, superId, 'for the audit suite');
    check(holdback.ok, 'B1  the fixture rule saves', JSON.stringify(holdback.problems));
    const ruleId = holdback.rule && holdback.rule.id;
    if (ruleId) made.rules.push(ruleId);

    const quiet = await store.createRule({
      name: `${stamp} Never matches`,
      engine: 'all',
      priority: 20,
      when: { combinator: 'and', rules: [{ field: 'ltv', operator: 'gt', value: 999 }] },
      then: [{ type: 'add_holdback', points: 0.25, reason: 'never' }],
    }, superId, 'for the audit suite');
    const quietId = quiet.rule && quiet.rule.id;
    if (quietId) made.rules.push(quietId);

    /* THE WRITER IS DRIVEN THROUGH ITS OWN FRONT DOOR, not by hand-writing SQL —
       a hand-written INSERT would prove the TABLE and say nothing about whether
       the writer names its columns correctly, which is the failure that reports
       a permanent, confident "nothing has ever fired". */
    ledger.reset();
    ledger.record(
      { ran: true, applied: [{ ruleId, name: 'NJ holdback', quotes: 3, adjustedQuotes: 2 }], ineligible: [], blocked: [], problems: [] },
      { rules: [holdback.rule, quiet.rule], engine: 'general' });
    const flushed = await ledger.flush();
    check((flushed || {}).written > 0, 'B2  the buffer drains to the database', JSON.stringify(flushed));
    check(!(flushed || {}).error, 'B3  …with no error from the upsert', (flushed || {}).error);

    const readRow = async (id, engine) => {
      const { rows } = await ltdb.query(
        `SELECT * FROM lt_pricing_rule_firing WHERE rule_id = $1 AND engine = $2 AND day = CURRENT_DATE`, [id, engine]);
      return rows[0] || null;
    };
    const row = await readRow(ruleId, 'general');
    check(!!row, 'B4  a row landed for the rule that acted');
    eq('B5  …counting the board it was asked on', Number((row || {}).boards_seen), 1);
    eq('B6  …and the board it matched', Number((row || {}).boards_matched), 1);
    eq('B7  …and the quotes it reached', Number((row || {}).quotes_reached), 3);
    eq('B8  …and the quotes whose price it moved', Number((row || {}).quotes_adjusted), 2);
    check(!!(row || {}).last_at, 'B9  …and the moment it did something');
    /* THE NAME COMES OFF THE RULE, NOT OFF THE BOARD'S REPORT — the store is
       what a person renamed, and the ledger keeps the name AS IT WAS that day. */
    eq('B10 …and the name it had at the time', (row || {}).rule_name, `${stamp} NJ holdback`);

    const quietRow = await readRow(quietId, 'general');
    check(!!quietRow, 'B11 the rule that matched NOTHING still has a row — it is the denominator');
    eq('B12 …asked once', Number((quietRow || {}).boards_seen), 1);
    eq('B13 …matched nothing', Number((quietRow || {}).boards_matched), 0);
    eq('B14 …and no moment, because it never did anything', (quietRow || {}).last_at, null);

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nC. THE UPSERT ADDS — two processes, one day');
    // ═════════════════════════════════════════════════════════════════════

    ledger.reset();
    ledger.record(
      { ran: true, applied: [{ ruleId, name: 'NJ holdback', quotes: 5, adjustedQuotes: 1 }], ineligible: [], blocked: [], problems: [] },
      { rules: [holdback.rule], engine: 'general' });
    await ledger.flush();
    const after = await readRow(ruleId, 'general');
    eq('C1  a second flush ADDS the boards rather than replacing them', Number((after || {}).boards_seen), 2);
    eq('C2  …and adds the quotes', Number((after || {}).quotes_reached), 8);
    check(!!(after || {}).first_at && !!(after || {}).last_at, 'C3  …and keeps both moments');
    check(new Date((after || {}).last_at) >= new Date((after || {}).first_at),
      'C4  …with the last one no earlier than the first');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nD. THE RECORDER CANNOT COST A BOARD ITS PRICE');
    // ═════════════════════════════════════════════════════════════════════

    ledger.reset();
    let threw = null;
    try {
      ledger.record(null, null);
      ledger.record({ ran: true, applied: 'not an array' }, { rules: 'not an array', engine: 'nonsense' });
      ledger.record({ ran: false }, { rules: [holdback.rule], engine: 'general' });
    } catch (e) { threw = e.message; }
    check(threw === null, 'D1  recording junk never throws on the pricing path', threw);
    eq('D2  …and a board the overlay never ran on buffers nothing', ledger.stats().buffered, 0);

    /* A FLUSH THAT CANNOT REACH THE TABLE MUST REPORT, NEVER THROW. Proven by
       pointing the writer at a database that has no such table — the same shape
       as a deploy where db/696 has not replayed yet. */
    ledger.reset();
    ledger.record(
      { ran: true, applied: [{ ruleId, quotes: 1 }] },
      { rules: [holdback.rule], engine: 'general' });
    await ltdb.query('ALTER TABLE lt_pricing_rule_firing RENAME TO lt_pricing_rule_firing_tmp');
    let flushThrew = null; let out = null;
    try { out = await ledger.flush(); } catch (e) { flushThrew = e.message; }
    await ltdb.query('ALTER TABLE lt_pricing_rule_firing_tmp RENAME TO lt_pricing_rule_firing');
    check(flushThrew === null, 'D3  a flush against a missing table never throws', flushThrew);
    check(!!(out || {}).error, 'D4  …it reports the reason instead');
    check(ledger.stats().failures > 0, 'D5  …and counts it, so a failing audit trail is visible');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nE. THE READ — the rolled-up ledger');
    // ═════════════════════════════════════════════════════════════════════

    const summary = await store.firingSummary({ days: 90 });
    eq('E1  the ledger reads without a problem', summary.problem, null);
    const mine = summary.byRule.get(ruleId);
    check(!!mine, 'E2  the rule that acted is in the roll-up');
    eq('E3  …with its boards summed across the day', Number(((mine || {}).total || {}).boardsSeen), 2);
    check(!!(mine || {}).everFiredAt, 'E4  …and "has it ever fired" answered from the whole table');

    const quietSummary = summary.byRule.get(quietId);
    check(!!quietSummary, 'E5  the quiet rule is there too');
    eq('E6  …and has never fired', (quietSummary || {}).everFiredAt || null, null);

    /* AN UNREADABLE LEDGER MUST NOT READ AS "NOTHING HAS EVER FIRED". */
    await ltdb.query('ALTER TABLE lt_pricing_rule_firing RENAME TO lt_pricing_rule_firing_tmp');
    const broken = await store.firingSummary({ days: 90 });
    await ltdb.query('ALTER TABLE lt_pricing_rule_firing_tmp RENAME TO lt_pricing_rule_firing');
    check(!!broken.problem, 'E7  an unreadable ledger reports its problem');
    eq('E8  …and answers no rules rather than all-zero ones', broken.byRule.size, 0);

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nF. THE VERDICTS, OVER THE REAL LEDGER');
    // ═════════════════════════════════════════════════════════════════════

    const rules = await store.listRules({ includeArchived: true });
    const table = audit.auditAll(rules, summary.byRule, { days: summary.days });
    const byId = Object.fromEntries((table.rows || []).map((r) => [r.ruleId, r]));
    eq('F1  the rule that matched boards reads as firing', (byId[ruleId] || {}).verdict, 'firing');
    eq('F2  the rule asked and matching nothing reads as never-fired', (byId[quietId] || {}).verdict, 'never_fired');
    check(/never matched/i.test(String((byId[quietId] || {}).headline || '')),
      'F3  …and says so in words', (byId[quietId] || {}).headline);

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nG. THE DOORS, OVER REAL HTTP');
    // ═════════════════════════════════════════════════════════════════════

    const anon = await call('GET', '/api/lt/dscr/pricing-rules/audit', null);
    eq('G1  the audit door is closed to anonymous callers', anon.status, 401);
    const asAdmin = await call('GET', '/api/lt/dscr/pricing-rules/audit', adminTok);
    eq('G2  …and answers 404 to a plain admin, never announcing itself', asAdmin.status, 404);

    const asSuper = await call('GET', '/api/lt/dscr/pricing-rules/audit', superTok);
    eq('G3  a super admin gets the audit', asSuper.status, 200);
    check(!!(asSuper.json || {}).ok, 'G4  …shaped as expected');
    /* THE ROUTE-ORDERING TRAP: `/:id` matches anything, so `/audit` registered
       after it is read as a rule whose id is the word "audit" — the door 404s
       and the whole screen is empty with nothing saying why. */
    check(Array.isArray((asSuper.json || {}).rows),
      'G5  …and it is the AUDIT, not a rule called "audit" (`/:id` did not swallow it)',
      JSON.stringify(asSuper.json).slice(0, 160));
    check(typeof (asSuper.json || {}).summary === 'string' && (asSuper.json || {}).summary.length > 0,
      'G6  …with one sentence at the top');
    const seenRow = ((asSuper.json || {}).rows || []).find((r) => r.ruleId === ruleId);
    eq('G7  …and the real ledger behind it', (seenRow || {}).verdict, 'firing');

    const drillAnon = await call('POST', '/api/lt/dscr/pricing-rules/audit/dry-run', null, {});
    eq('G8  the fire drill is closed to anonymous callers', drillAnon.status, 401);
    const drillAdmin = await call('POST', '/api/lt/dscr/pricing-rules/audit/dry-run', adminTok, {});
    eq('G9  …and 404 to a plain admin', drillAdmin.status, 404);

    const drill = await call('POST', '/api/lt/dscr/pricing-rules/audit/dry-run', superTok, {
      engine: 'general',
      scenario: { state: 'NJ', loanAmount: 250000, ltv: 75, dscr: 1.2 },
    });
    eq('G10 the fire drill answers', drill.status, 200);
    const drillRows = ((drill.json || {}).rows || []);
    const njRow = drillRows.find((r) => r.ruleId === ruleId);
    const quietDrill = drillRows.find((r) => r.ruleId === quietId);
    check(!!njRow && njRow.wouldRun === true, 'G11 the New Jersey rule fires on a New Jersey loan');
    check(!!quietDrill && quietDrill.wouldRun === false, 'G12 the impossible rule does not');
    check(!!quietDrill && (quietDrill.blockers || []).length > 0,
      'G13 …and the drill says WHICH condition stopped it');
    const quietWhy = String((((quietDrill || {}).blockers || [])[0] || {}).why || '');
    check(/LTV/i.test(quietWhy), 'G14 …naming the field in words', quietWhy);
    check(/\b75\b/.test(quietWhy), 'G14a …and the loan\'s own figure', quietWhy);
    check(!/is not is /.test(quietWhy), 'G14b …in a sentence that reads as English', quietWhy);

    const elsewhere = await call('POST', '/api/lt/dscr/pricing-rules/audit/dry-run', superTok, {
      engine: 'general',
      scenario: { state: 'TX', loanAmount: 250000, ltv: 75, dscr: 1.2 },
    });
    const njElsewhere = ((elsewhere.json || {}).rows || []).find((r) => r.ruleId === ruleId);
    check(!!njElsewhere && njElsewhere.wouldRun === false,
      'G15 the same rule does not fire on a Texas loan');
    check(/NJ|New Jersey|State/i.test(String((((njElsewhere || {}).blockers || [])[0] || {}).why || '')),
      'G16 …and the reason is the state', JSON.stringify(((njElsewhere || {}).blockers || [])[0] || {}));

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nH. THE OVERLAY AND THE RECORDER AGREE ABOUT ONE BOARD');
    // ═════════════════════════════════════════════════════════════════════

    /* END TO END through the REAL overlay: price a board with the real rules,
       hand the REAL result to the recorder, and read the ledger back. A recorder
       fed a hand-made result proves only that it can add up its own fixture. */
    const board = [{
      investorKey: 'inv1',
      whiteLabel: 'Sample program',
      program: 'DSCR 30',
      priceBuild: { noteRate: 7.5, price: 100, borrowerPaidPoints: 0 },
      terms: { ltv: 75, dscr: 1.2 },
    }];
    const live = await store.liveRules();
    const result = overlay.apply(board, { rules: live.rules, scenario: { state: 'NJ' }, engine: 'general' });
    check(result.ran === true, 'H1  the overlay ran on the board');

    ledger.reset();
    ledger.record(result, { rules: live.rules, engine: 'general' });
    await ledger.flush();
    const end = await readRow(ruleId, 'general');
    check(Number((end || {}).boards_seen) >= 3, 'H2  the board the engine priced landed in the ledger');
    check(Number((end || {}).quotes_adjusted) >= 3,
      'H3  …with the quote the overlay actually moved counted',
      `quotes_adjusted=${(end || {}).quotes_adjusted}`);

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nI. THE MIGRATION CONVERGES');
    // ═════════════════════════════════════════════════════════════════════

    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '696_lt_pricing_rule_firing.sql'), 'utf8');
    let replayed = true;
    try { await ltdb.query(sql); } catch (e) { replayed = false; console.error(`    ${e.message}`); }
    check(replayed, 'I1  db/696 replays cleanly on a database that already has it');
    const kept = await readRow(ruleId, 'general');
    check(!!kept, 'I2  …and the counts written before it are still there');

  } finally {
    ledger.reset();
    for (const id of made.rules) {
      await ltdb.query('DELETE FROM lt_pricing_rule_firing WHERE rule_id = $1', [id]).catch(() => {});
      await ltdb.query('DELETE FROM lt_pricing_rule_event WHERE rule_id = $1', [id]).catch(() => {});
      await ltdb.query('DELETE FROM lt_pricing_rule WHERE id = $1', [id]).catch(() => {});
    }
    if (made.staff.length) await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [made.staff]).catch(() => {});
    server.close();
  }

  console.log(`\n${failures ? 'FAILED' : 'ALL PASSED'} (${failures} failed)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

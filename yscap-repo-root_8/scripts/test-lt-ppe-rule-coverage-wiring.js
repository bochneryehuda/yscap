#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE COVERAGE CHECK, WIRED TO THE RULE SET IT IS FOR (master plan Part 2 §2.6, last half).
 *
 * `rule-coverage.js` can read a rule set; until this, nothing ever handed it one. The P7/P8 loop is
 * exactly where that matters: a human accepts a suggestion mined from a Lender Price decline, which
 * writes a real rule into the set — rules arriving one at a time, from different people, months apart.
 *
 * WHAT THIS SUITE PINS, and each is a way the wiring could quietly say the wrong thing:
 *   A. AN ELIGIBILITY RULE IS NOT OVERLAP-CHECKED, AND SAYS SO. Nearly every mined suggestion is an
 *      eligibility rule, and only PRICING rules can double-charge. Returning `overlaps: []` for one
 *      would put a clean bill of health on the screen for a check that was never run — a bigger lie
 *      than saying nothing, and the exact shape `rule-coverage.js`'s own header warns about.
 *   B. A PRICING RULE'S OWN COLLISION IS REPORTED, naming both rules — that is the finding.
 *   C. A PRE-EXISTING OVERLAP BETWEEN TWO OTHER RULES IS COUNTED, NOT LISTED. It is real, it is not
 *      news about this accept, and re-announcing it every time is how a report becomes wallpaper.
 *   D. IT NEVER TURNS AN ACCEPT INTO A FAILURE. Coverage is advisory; a read that throws must come
 *      back as a stated "could not check", never as an exception on a rule already committed.
 *   E. THE SET IS THE PROGRAM'S, not the whole table — two rules collide only if they can both fire on
 *      ONE loan.
 *
 * OFFLINE + PURE: the `db` is a stub. No database, no network. Runs in `npm test` via `test-lt-ppe-*`.
 */
let pass = 0; const fails = [];
const ok = (c, m) => { if (c) { pass += 1; } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const fs = require('fs');
const path = require('path');
const ruleStore = require('../src/longterm/ppe/rule-store');

console.log('LT PPE — the coverage check, wired to the rule set it is for\n');

async function main() {

// A stored lt_ppe_rule row, as `rowToRule` expects to find it.
const row = (code, kind, when, extra = {}) => ({
  code, kind, source: 'overlay', priority: 0, description: null,
  predicate: when, decline_reason: 'ineligible', adjustment: null, ...extra,
});
const priced = (code, when, dimension = 'fico_cltv_dscr') =>
  row(code, 'pricing', when, { adjustment: { dimension, adjMilli: 250, unit: 'points' } });
const ficoBand = (lo, hi) => ({ fact: 'fico', op: 'between', value: [lo, hi] });

// A db stub that answers every query with the same rule set, and records what it was asked.
function stubDb(rows) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows }; } };
}

// ── A. AN ELIGIBILITY RULE IS NOT OVERLAP-CHECKED, AND SAYS SO ────────────────────────────────────
{
  const db = stubDb([row('lp_no_condotel', 'eligibility', { fact: 'property_type', op: 'eq', value: 'condotel' })]);
  const r = await ruleStore.coverageForAcceptedRule(db, 'company', null, null, 'lp_no_condotel', 'eligibility');
  ok(r.checked === false, 'an accepted ELIGIBILITY rule is reported as NOT overlap-checked');
  ok(!('overlaps' in r), '…and carries NO overlaps key, so an empty list can never read as "checked and clean"');
  ok(/collected/.test(r.why || '') && /PRICING/.test(r.why || ''),
    '…with a reason that says declines are collected on purpose and only pricing accumulates');
  ok(r.kind === 'eligibility', '…and names the kind it declined to check');

  const b = await ruleStore.coverageForAcceptedRule(db, 'company', null, null, 'x', 'bound');
  ok(b.checked === false && !('overlaps' in b), 'a BOUND rule is likewise not overlap-checked — bounds tighten by design');
  // It must not ASK the database at all for a shape it will not analyze: the answer is a property of
  // the rule kind, so a read there is pure cost, and a read that failed would look like a real verdict.
  ok(db.calls.length === 0, '…and neither reads the rule set, because the answer never depended on it');
}

// ── B. A PRICING RULE'S OWN COLLISION IS THE FINDING ──────────────────────────────────────────────
{
  const db = stubDb([
    priced('dhvn_fico_640', ficoBand(640, 680)),
    priced('lp_fico_660', ficoBand(660, 700)),
  ]);
  const r = await ruleStore.coverageForAcceptedRule(db, 'company', 'inv', 'prog', 'lp_fico_660', 'pricing');
  ok(r.checked === true, 'an accepted PRICING rule IS overlap-checked');
  ok(r.overlaps.length === 1, '…and its collision with the rule already in the set is reported');
  const o = r.overlaps[0] || {};
  ok((o.rules || []).includes('lp_fico_660') && (o.rules || []).includes('dhvn_fico_640'),
    '…naming BOTH rules, because fixing it means choosing between them');
  ok(o.band === 'fico [660, 680)', '…and the exact band a loan would be charged twice in');
  ok(r.otherOverlaps === 0, '…with nothing else in the set colliding');
}
{
  // A pricing rule that collides with nothing is a real, positive answer — and must be told apart from
  // the eligibility case above, where nothing was checked at all.
  const db = stubDb([
    priced('dhvn_fico_640', ficoBand(640, 660)),
    priced('lp_fico_660', ficoBand(660, 680)),
  ]);
  const r = await ruleStore.coverageForAcceptedRule(db, 'company', null, null, 'lp_fico_660', 'pricing');
  ok(r.checked === true && r.overlaps.length === 0,
    'a pricing rule that collides with nothing reports CHECKED and clean — a different answer from "not checked"');
  ok(r.analyzed && r.analyzed.banded === 2,
    '…and reports how many rules were actually read, so a clean answer over 1 of 133 is never mistaken for coverage');
}

// ── C. SOMEBODY ELSE'S PRE-EXISTING OVERLAP IS COUNTED, NOT LISTED ────────────────────────────────
{
  const db = stubDb([
    priced('old_a', ficoBand(600, 700)),   // these two already overlapped each other
    priced('old_b', ficoBand(650, 750)),   // long before this accept
    priced('new_c', ficoBand(760, 800)),   // and the new rule touches neither
  ]);
  const r = await ruleStore.coverageForAcceptedRule(db, 'company', null, null, 'new_c', 'pricing');
  ok(r.overlaps.length === 0, 'a pre-existing overlap between two OTHER rules is not reported as this accept\'s doing');
  ok(r.otherOverlaps === 1, '…but it is COUNTED, so it is never hidden either');
}

// ── D. IT NEVER TURNS A COMMITTED ACCEPT INTO A FAILURE ───────────────────────────────────────────
{
  const broken = { query: async () => { throw new Error('connection terminated'); } };
  let threw = false; let r = null;
  try { r = await ruleStore.coverageAfterAcceptSafe(broken, 'company', null, null, 'c', 'pricing'); } catch (e) { threw = true; }
  ok(!threw, 'a coverage read that fails never throws out of the accept path');
  ok(r && r.checked === false && /could not run/.test(r.why || ''),
    '…and says plainly that it could not check, rather than returning an empty report that reads as clean');
  ok(/accepted either way/.test((r && r.why) || ''), '…and that the rule was accepted regardless');
}

// ── E. THE SET IS THE PROGRAM'S ───────────────────────────────────────────────────────────────────
{
  const db = stubDb([priced('a', ficoBand(600, 700))]);
  await ruleStore.coverageForProgram(db, 'company', 'inv-1', 'prog-1');
  ok(db.calls.length === 1, 'coverage reads the rule set exactly once');
  const { sql, params } = db.calls[0];
  ok(/investor_id IS NULL OR investor_id = \$2/.test(sql) && /program_id IS NULL OR program_id = \$3/.test(sql),
    '…through the SAME query the engine evaluates with — house rules plus this investor\'s plus this program\'s');
  ok(/effective_from <= now\(\)/.test(sql), '…effective-dated, so a retired rule is never blamed for a collision');
  ok(params[0] === 'company' && params[1] === 'inv-1' && params[2] === 'prog-1',
    '…scoped to the investor and program asked for, never the whole table');
}

// ── the wiring itself: the store attaches it, the route publishes it, neither gates on it ──────────
{
  const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  // Strip comments before every "must not appear" test: the code that avoids a trap necessarily NAMES
  // it while explaining why, and a guard that read comments would fail on its own explanation.
  const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  const store = codeOf(src('src/longterm/ppe/rule-store.js'));
  ok(/COMMIT'\);[\s\S]{0,400}coverageAfterAcceptSafe/.test(store),
    'the accept computes coverage AFTER the commit — a read error can never abort a write a human authorised');
  ok(/return \{ ok: true, ruleId, coverage/.test(store), '…and returns it on the accept result');

  const route = codeOf(src('src/longterm/routes/ppe.js'));
  ok(/coverage: out\.coverage/.test(route), 'the accept route publishes the coverage report');
  ok(/router\.get\('\/rules\/coverage'/.test(route), 'and the rule set can be asked for its own coverage read-only');
  // The refusal branch must still be exactly the pre-existing one: a coverage finding may never
  // become a reason the accept answers 4xx.
  ok(!/coverage[\s\S]{0,120}res\.status\(4/.test(route),
    'no branch turns a coverage finding into a refusal — the check is advisory, and blocking on it would be a dead end');
}

}

main().then(() => {
console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);
}).catch((e) => {
  // A THROW IS NOT A TEST RESULT. Report it as a failure in the suite's own words rather than letting
  // a stack trace exit non-zero and look exactly like a clean assertion failure.
  console.log(`  ✗ the suite itself threw: ${(e && e.stack) || e}`);
  process.exit(1);
});

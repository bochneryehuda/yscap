'use strict';
/**
 * R5.39 — pure tests for investor-fit reasoning.
 * Proves it (1) ranks a clean FIT above a non-fit, (2) orders non-fits by
 * blocker/severity distance, (3) computes "Investor A vs B" differentiators (the
 * rules that failed on one but not the other), (4) treats a high/fatal failure as a
 * blocker but an advisory note as non-blocking, (5) accepts varied field names, and
 * (6) never throws.
 */
const assert = require('assert');
const inv = require('../src/lib/underwriting/investor-fit');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- a clean fit ranks above a non-fit ---
let r = inv.rankInvestorFit([
  { investor: 'Beta', failures: [{ ruleId: 'ltv_cap', reason: 'LTV 82% over 80% max', severity: 'blocking' }] },
  { investor: 'Alpha', failures: [] },
]);
assert.strictEqual(r.ranked[0].investor, 'Alpha', 'the eligible investor ranks first');
assert.strictEqual(r.ranked[0].fit, 'fits');
assert.strictEqual(r.ranked[1].fit, 'fails');
assert.strictEqual(r.best, 'Alpha');
assert.strictEqual(r.anyFit, true);
ok('a clean fit ranks above a non-fit and is reported as best');

// --- non-fits ordered by blocker count, then severity ---
r = inv.rankInvestorFit([
  { investor: 'TwoBlockers', failures: [{ ruleId: 'a', severity: 'blocking' }, { ruleId: 'b', severity: 'blocking' }] },
  { investor: 'OneBlocking', failures: [{ ruleId: 'a', severity: 'blocking' }] },
  { investor: 'OneHigh', failures: [{ ruleId: 'c', severity: 'high' }] }, // 1 blocker, LESS severe than blocking
]);
assert.strictEqual(r.anyFit, false, 'none are a clean fit (high/blocking both block)');
assert.strictEqual(r.ranked[2].investor, 'TwoBlockers', 'two blockers is the worst fit');
// among the single-blocker investors, the less-severe (high) is closer to a fit than blocking
const iHigh = r.ranked.findIndex((x) => x.investor === 'OneHigh');
const iBlock = r.ranked.findIndex((x) => x.investor === 'OneBlocking');
assert.ok(iHigh < iBlock, 'a single less-severe (high) blocker ranks above a single blocking one');
assert.ok(iBlock < r.ranked.findIndex((x) => x.investor === 'TwoBlockers'), 'one blocker beats two');
assert.strictEqual(r.best, 'OneHigh', 'with no clean fit, the closest non-fit (fewest, least-severe blockers) is best');
ok('non-fits are ordered by how far they are from a fit (fewer, then less-severe, blockers first)');

// --- an advisory note is NOT a blocker ---
r = inv.rankInvestorFit([
  { investor: 'Clean', failures: [] },
  { investor: 'AdvisoryOnly', failures: [{ ruleId: 'reserve_note', reason: 'prefers 6mo reserves', severity: 'advisory' }] },
]);
assert.strictEqual(r.ranked[0].investor, 'Clean');
assert.strictEqual(r.ranked[1].fit, 'fits', 'an advisory-only failure still FITS (no blocker)');
assert.strictEqual(r.ranked[1].eligible, true);
assert.strictEqual(r.anyFit, true);
ok('an advisory-severity failure does not block a fit (only high/fatal/blocking do)');

// --- an explicit eligible flag wins over inferred ---
r = inv.rankInvestorFit([{ investor: 'X', eligible: false, failures: [] }]);
assert.strictEqual(r.ranked[0].fit, 'fails', 'an explicit eligible:false is honored even with no failures');
ok('an explicit eligible flag overrides the inferred (no-blockers) fit');

// --- "Investor A vs B" differentiators ---
r = inv.rankInvestorFit([
  { investor: 'Alpha', failures: [{ ruleId: 'dscr_min', reason: 'DSCR 1.05 under 1.10', severity: 'blocking' }] },
  { investor: 'Beta', failures: [{ ruleId: 'fico_min', reason: 'FICO 680 under 700', severity: 'blocking' }] },
]);
const pair = r.comparison[0];
assert.ok(pair, 'a pairwise comparison is produced');
const onAlpha = pair.differentiators.find((d) => d.ruleId === 'dscr_min');
const onBeta = pair.differentiators.find((d) => d.ruleId === 'fico_min');
assert.ok(onAlpha && onAlpha.onlyOn === 'Alpha', 'the DSCR rule failed only on Alpha');
assert.ok(onBeta && onBeta.onlyOn === 'Beta', 'the FICO rule failed only on Beta');
ok('the ranking explains "Investor A vs B" via the rules that failed on exactly one');

// --- compareInvestors gives a direct A-vs-B for two named investors ---
const c = inv.compareInvestors([
  { investor: 'Alpha', failures: [{ ruleId: 'ltv', severity: 'blocking' }, { ruleId: 'shared', severity: 'high' }] },
  { investor: 'Beta', failures: [{ ruleId: 'shared', severity: 'high' }] },
], 'Alpha', 'Beta');
assert.ok(c, 'a direct comparison is returned for two present investors');
assert.deepStrictEqual(c.differentiators.map((d) => d.ruleId), ['ltv'], 'only the LTV rule differs (shared failed on both)');
assert.strictEqual(inv.compareInvestors([{ investor: 'Alpha' }], 'Alpha', 'Ghost'), null, 'a missing investor yields null');
ok('compareInvestors returns the differentiators for two named investors (shared failures excluded)');

// --- varied field names (name/id, failedRules/violations, rule_id) resolve ---
r = inv.rankInvestorFit([
  { name: 'ByName', failedRules: [{ rule_id: 'x', message: 'nope', severity: 'blocking' }] },
  { id: 'ById', violations: [] },
]);
assert.ok(r.ranked.some((x) => x.investor === 'ByName') && r.ranked.some((x) => x.investor === 'ById'), 'name/id both resolve');
assert.strictEqual(r.ranked.find((x) => x.investor === 'ByName').blockers[0].ruleId, 'x', 'rule_id + message aliases read');
ok('varied field names (name/id, failedRules/violations, rule_id/message) are accepted');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => inv.rankInvestorFit(null));
assert.deepStrictEqual(inv.rankInvestorFit(null).ranked, []);
assert.strictEqual(inv.rankInvestorFit(null).best, null);
assert.strictEqual(inv.rankInvestorFit([]).anyFit, false);
assert.doesNotThrow(() => inv.rankInvestorFit([null, 'junk', {}, { investor: 'A', failures: 'notarray' }]));
assert.doesNotThrow(() => inv.compareInvestors(null, 'a', 'b'));
assert.strictEqual(inv.compareInvestors(null, 'a', 'b'), null);
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.39 investor-fit pure — ${passed} checks passed`);

#!/usr/bin/env node
'use strict';
/**
 * LT PPE margin & holdback resolver (Layer 1) — pure offline test.
 * Proves the owner's rule (2026-08-16): margin AND holdback set per investor, pre-filled 0.250,
 * changeable, with different margins/holdbacks per scenario via per-scenario rules.
 *
 *   node scripts/test-lt-ppe-margin-holdback.js
 */
const mh = require('../src/longterm/ppe/margin-holdback');
const s = require('../src/longterm/ppe/settings');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

console.log('LT PPE margin & holdback — offline\n');

// 0) The two new settings exist, are pre-filled 0.250, and each default passes its own validation.
ok(s.resolve('pricing.margin_milli').value === 250, 'margin default = 250 (0.250 pt)');
ok(s.resolve('pricing.holdback_milli').value === 250, 'holdback default = 250 (0.250 pt)');
ok(Array.isArray(s.resolve('pricing.margin_holdback_rules').value), 'margin_holdback_rules default is an array');
ok(s.resolve('pricing.margin_holdback_rules').value.length === 0, 'margin_holdback_rules default is empty (no per-scenario overrides)');
ok(s.validateValue('pricing.margin_milli', 250).ok && s.validateValue('pricing.holdback_milli', 250).ok, 'both defaults pass validation');
ok(!s.validateValue('pricing.holdback_milli', 9999).ok, 'holdback above-max rejected');
ok(!s.validateValue('pricing.margin_milli', 12.5).ok, 'non-integer margin rejected');

// 1) The pre-fill: no rules, no facts → the 0.250 default for both, sourced 'default'.
{
  const r = mh.resolveMarginHoldback({ marginMilli: 250, holdbackMilli: 250 });
  ok(r.marginMilli === 250 && r.holdbackMilli === 250, 'pre-fill 0.250 for both when no rules');
  ok(r.marginSource === 'default' && r.holdbackSource === 'default', 'both sourced default');
  ok(r.appliedRules.length === 0, 'no applied rules');
}

// 2) A different investor DEFAULT (the per-investor override the store resolves) is honored verbatim.
{
  const r = mh.resolveMarginHoldback({ marginMilli: 375, holdbackMilli: 500 });
  ok(r.marginMilli === 375 && r.holdbackMilli === 500, 'per-investor defaults carried through');
}

// 3) A per-scenario rule overrides ONLY the field it names, only when its predicate matches.
{
  const rules = [
    { code: 'ny_holdback', when: { all: [{ fact: 'state', op: 'eq', value: 'NY' }] }, holdbackMilli: 500 },
  ];
  const hit = mh.resolveMarginHoldback({ marginMilli: 250, holdbackMilli: 250, rules, facts: { state: 'NY' } });
  ok(hit.marginMilli === 250 && hit.marginSource === 'default', 'NY rule leaves margin at default');
  ok(hit.holdbackMilli === 500 && hit.holdbackSource === 'rule' && hit.holdbackRule === 'ny_holdback', 'NY rule overrides holdback');
  ok(hit.appliedRules.length === 1 && hit.appliedRules[0].sets.join() === 'holdback', 'applied-rule trace names holdback');

  const miss = mh.resolveMarginHoldback({ marginMilli: 250, holdbackMilli: 250, rules, facts: { state: 'FL' } });
  ok(miss.holdbackMilli === 250 && miss.holdbackSource === 'default', 'FL scenario: rule does not fire, default holdback');
}

// 4) A rule can set a different MARGIN and a different HOLDBACK for the same scenario.
{
  const rules = [
    { code: 'jumbo', when: { all: [{ fact: 'loanAmount', op: 'gte', value: 1000000 }] }, marginMilli: 400, holdbackMilli: 350 },
  ];
  const r = mh.resolveMarginHoldback({ marginMilli: 250, holdbackMilli: 250, rules, facts: { loanAmount: 1500000 } });
  ok(r.marginMilli === 400 && r.holdbackMilli === 350, 'one rule sets both margin and holdback for a scenario');
  ok(r.marginSource === 'rule' && r.holdbackSource === 'rule', 'both sourced rule');
}

// 5) FIRST matching row wins per field; margin and holdback resolve independently across rows.
{
  const rules = [
    { code: 'a', priority: 1, when: { all: [{ fact: 'purpose', op: 'eq', value: 'purchase' }] }, marginMilli: 300 },
    { code: 'b', priority: 2, when: { all: [{ fact: 'purpose', op: 'eq', value: 'purchase' }] }, marginMilli: 999, holdbackMilli: 350 },
  ];
  const r = mh.resolveMarginHoldback({ marginMilli: 250, holdbackMilli: 250, rules, facts: { purpose: 'purchase' } });
  ok(r.marginMilli === 300 && r.marginRule === 'a', 'first row (by priority) wins the margin');
  ok(r.holdbackMilli === 350 && r.holdbackRule === 'b', 'later row still sets the holdback the first left untouched');
}

// 6) Priority orders the pass (lower fires first), independent of input order.
{
  const rules = [
    { code: 'late', priority: 10, when: null, marginMilli: 900 },
    { code: 'early', priority: 1, when: null, marginMilli: 300 },
  ];
  const r = mh.resolveMarginHoldback({ marginMilli: 250, holdbackMilli: 250, rules, facts: {} });
  ok(r.marginMilli === 300 && r.marginRule === 'early', 'priority 1 wins over priority 10 regardless of order');
}

// 7) FAIL-SAFE: a rule over a MISSING fact never fires; the fact is surfaced in unknownFacts.
{
  const rules = [{ code: 'needs_dscr', when: { all: [{ fact: 'dscr', op: 'gte', value: 1.2 }] }, marginMilli: 400 }];
  const r = mh.resolveMarginHoldback({ marginMilli: 250, holdbackMilli: 250, rules, facts: {} });
  ok(r.marginMilli === 250 && r.marginSource === 'default', 'missing-fact rule does not fire → default margin');
  ok(r.unknownFacts.includes('dscr'), 'unknown fact surfaced (nothing silent)');
}

// 8) A garbage override VALUE in a rule row is ignored for that field (falls through to default).
{
  const rules = [{ code: 'bad', when: null, marginMilli: -50, holdbackMilli: 12.5 }];
  const r = mh.resolveMarginHoldback({ marginMilli: 250, holdbackMilli: 250, rules, facts: {} });
  ok(r.marginMilli === 250 && r.holdbackMilli === 250, 'garbage rule values (negative, non-integer) ignored → defaults');
  ok(r.appliedRules.length === 0, 'a rule that set nothing usable does not count as applied');
}

// 9) A garbage DEFAULT degrades to the product default 250 (never NaN / unpriceable).
{
  const r = mh.resolveMarginHoldback({ marginMilli: null, holdbackMilli: NaN });
  ok(r.marginMilli === 250 && r.holdbackMilli === 250, 'null/NaN defaults degrade to the 250 product default');
}

// 10) Bad rule rows (non-object) are skipped without throwing.
{
  const rules = [null, 42, 'x', { code: 'ok', when: null, marginMilli: 300 }];
  const r = mh.resolveMarginHoldback({ marginMilli: 250, holdbackMilli: 250, rules, facts: {} });
  ok(r.marginMilli === 300, 'non-object rule rows skipped; the real one still applies');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);

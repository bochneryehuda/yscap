#!/usr/bin/env node
'use strict';
/**
 * LT PPE rules evaluator — pure offline test (MEGA plan §6).
 * Proves the three rule shapes (eligibility / bound / pricing), half-open range
 * matching, most-restrictive bound tightening (overlays can only tighten),
 * structured declines with the failing value, accumulate-don't-decline pricing,
 * the fail-safe on a missing fact, and the full trace.
 *
 *   node scripts/test-lt-ppe-rules.js
 */
const { evalPredicate, evaluateRules } = require('../src/longterm/ppe/rules');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
function threw(fn) { try { fn(); return false; } catch { return true; } }

console.log('LT PPE rules — offline\n');

// 1) Predicate leaves + trees.
ok(evalPredicate({ fact: 'fico', op: 'gte', value: 740 }, { fico: 740 }).value, 'gte is inclusive');
ok(!evalPredicate({ fact: 'fico', op: 'gt', value: 740 }, { fico: 740 }).value, 'gt is exclusive');
ok(evalPredicate({ fact: 'occ', op: 'in', value: ['investment', 'second'] }, { occ: 'investment' }).value, 'in matches a member');
ok(evalPredicate({ all: [{ fact: 'fico', op: 'gte', value: 700 }, { fact: 'ltv', op: 'lt', value: 80000 }] }, { fico: 720, ltv: 70000 }).value, 'all requires every child');
ok(!evalPredicate({ all: [{ fact: 'fico', op: 'gte', value: 700 }, { fact: 'ltv', op: 'lt', value: 80000 }] }, { fico: 720, ltv: 80000 }).value, 'all fails if one child fails');
ok(evalPredicate({ any: [{ fact: 'x', op: 'eq', value: 1 }, { fact: 'y', op: 'eq', value: 2 }] }, { y: 2 }).value, 'any needs one child');
ok(evalPredicate({ not: { fact: 'x', op: 'eq', value: 1 } }, { x: 2 }).value, 'not inverts');
ok(evalPredicate(null, {}).value, 'an absent predicate matches everything (a base row)');

// 2) HALF-OPEN [min,max) — the 740-in-two-bands defense.
ok(evalPredicate({ fact: 'fico', op: 'between', value: [740, 760] }, { fico: 740 }).value, '740 is IN [740,760)');
ok(!evalPredicate({ fact: 'fico', op: 'between', value: [720, 740] }, { fico: 740 }).value, '740 is NOT in [720,740) — no double-count at the boundary');

// 3) The fail-safe on a missing fact: false, and surfaced (never a silent decline).
{
  const r = evalPredicate({ fact: 'dscr', op: 'lt', value: 1000 }, {});
  ok(r.value === false && r.unknown.has('dscr'), 'a missing fact evaluates false and is recorded as unknown');
}

// 4) Eligibility — a matched disqualifier declines WITH a reason; all reasons collected.
{
  const rules = [
    { code: 'no_ny', kind: 'eligibility', when: { fact: 'state', op: 'eq', value: 'NY' }, declineReason: 'New York not eligible' },
    { code: 'min_fico', kind: 'eligibility', when: { fact: 'fico', op: 'lt', value: 660 }, declineReason: 'FICO below 660' },
  ];
  const clean = evaluateRules(rules, { state: 'TX', fico: 720 });
  ok(clean.eligible && clean.declines.length === 0, 'a clean scenario is eligible with no declines');

  const bad = evaluateRules(rules, { state: 'NY', fico: 640 });
  ok(!bad.eligible && bad.declines.length === 2, 'both disqualifiers fire and are collected');
  ok(bad.declines.some((d) => /New York/.test(d.reason)) && bad.declines.some((d) => /660/.test(d.reason)), 'each decline carries its human reason');
}

// 5) Bounds — most restrictive per target; an overlay can only tighten.
{
  const rules = [
    { code: 'base_ltv', kind: 'bound', source: 'base', target: 'ltv', op: 'max', value: 80000 },
    { code: 'overlay_ltv', kind: 'bound', source: 'overlay', target: 'ltv', op: 'max', value: 75000 },
    { code: 'sub1_dscr', kind: 'bound', target: 'dscr', op: 'min', value: 1000, when: { fact: 'dscr', op: 'lt', value: 1250 } },
  ];
  const r = evaluateRules(rules, { ltv: 78000, dscr: 1100 });
  ok(r.bounds['ltv:max'].value === 75000 && r.bounds['ltv:max'].ruleRef === 'overlay_ltv', 'the tighter overlay LTV wins');
  ok(!r.eligible && r.declines.some((d) => /ltv max 75000 exceeded \(requested 78000\)/.test(d.reason)),
    'a requested LTV over the tightened bound declines with the exact numbers');
}
{
  // the same base, now within the tightened bound → eligible
  const rules = [
    { code: 'base_ltv', kind: 'bound', target: 'ltv', op: 'max', value: 80000 },
    { code: 'overlay_ltv', kind: 'bound', source: 'overlay', target: 'ltv', op: 'max', value: 75000 },
  ];
  const r = evaluateRules(rules, { ltv: 70000 });
  ok(r.eligible && r.bounds['ltv:max'].satisfied === true, 'inside the tightened bound is eligible and marked satisfied');
}

// 6) A 'min' bound: DSCR floor tightens to the largest floor.
{
  const rules = [
    { code: 'a', kind: 'bound', target: 'dscr', op: 'min', value: 1000 },
    { code: 'b', kind: 'bound', target: 'dscr', op: 'min', value: 1150 },
  ];
  const r = evaluateRules(rules, { dscr: 1100 });
  ok(r.bounds['dscr:min'].value === 1150, 'the higher DSCR floor is the binding one');
  ok(!r.eligible && r.declines.some((d) => /dscr min 1150 not met \(requested 1100\)/.test(d.reason)), 'a DSCR under the floor declines');
}

// 7) Pricing rules ACCUMULATE and never decline; they compose with pricing.js.
{
  const rules = [
    { code: 'cashout', kind: 'pricing', when: { fact: 'purpose', op: 'eq', value: 'cashout' }, adjustment: { code: 'cashout', category: 'purpose', adjMilli: 500 } },
    { code: 'io', kind: 'pricing', when: { fact: 'io', op: 'eq', value: true }, adjustment: { code: 'io', category: 'io', adjMilli: 375 } },
    { code: 'high_fico', kind: 'pricing', when: { fact: 'fico', op: 'between', value: [780, 850] }, adjustment: { code: 'fico_credit', category: 'fico_ltv', adjMilli: -125 } },
  ];
  const r = evaluateRules(rules, { purpose: 'cashout', io: false, fico: 800 });
  ok(r.eligible, 'pricing rules never make a scenario ineligible');
  ok(r.adjustments.length === 2, 'only the matching adjustments accumulate (IO did not fire)');
  const sum = r.adjustments.reduce((s, a) => s + a.adjMilli, 0);
  ok(sum === 375, 'the accumulated signed cost is +0.500 cashout − 0.125 fico credit = +0.375');
}

// 8) Trace + unknownFacts — every rule recorded, matched or not, nothing silent.
{
  const rules = [
    { code: 'r1', kind: 'eligibility', when: { fact: 'state', op: 'eq', value: 'NY' }, declineReason: 'NY' },
    { code: 'r2', kind: 'pricing', when: { fact: 'ltv', op: 'gte', value: 80000 }, adjustment: { code: 'hi_ltv', adjMilli: 250 } },
  ];
  const r = evaluateRules(rules, { state: 'TX' }); // ltv missing
  ok(r.trace.length === 2, 'every rule appears in the trace');
  ok(r.trace.find((t) => t.code === 'r1').matched === false, 'a non-matching rule is recorded as not matched');
  ok(r.unknownFacts.includes('ltv'), 'the missing ltv is surfaced, not hidden');
}

// 9) Custom severity: a soft advisory need not make the scenario ineligible.
{
  const rules = [{ code: 'advisory', kind: 'eligibility', when: { fact: 'units', op: 'gte', value: 5 }, declineReason: '5+ units — review' }];
  const r = evaluateRules(rules, { units: 6 }, { severityOf: (d) => (d.code === 'advisory' ? 'soft' : 'hard') });
  ok(r.eligible === true && r.declines.length === 1, 'a soft-severity finding is surfaced but does not decline');
}

// 10) Malformed rules are refused, not silently skipped.
ok(threw(() => evaluateRules([{ kind: 'bound', target: 'ltv' }], {})), 'a bound with no op is refused');
ok(threw(() => evaluateRules([{ kind: 'pricing' }], {})), 'a pricing rule with no adjustment is refused');
ok(threw(() => evaluateRules([{ code: 'x' }], {})), 'a rule with no kind is refused');
ok(threw(() => evalPredicate({ fact: 'x', op: 'bogus', value: 1 }, { x: 1 })), 'an unknown operator is refused');

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);

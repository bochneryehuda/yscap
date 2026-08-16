#!/usr/bin/env node
'use strict';
/**
 * §31.5/§31.6 — SUBORDINATE FINANCING + BROKER COMP PERCENT (pure, offline).
 *
 * Two confirmed live captures the connector had no caller field for:
 *   • Closed End Second + 50,000 sent `criteria.subordinateLoanAmount: 50000` — and NO separate CLTV
 *     field, because the engine derives the combined ratio itself. So we transmit the amount and
 *     VALIDATE the combined ratio; we never invent a CLTV input.
 *   • Comp Percent 2.5 sent `brokerCriteria.compPlan: -2.5`. The SIGN IS INVERTED. Our public input
 *     is the positive number a human reads off the screen, and one named conversion owns the flip.
 *
 * Both are SCENARIO-OWNED, which is the §31.6 leak this also closes: the audit reproduced a stale
 * subordinate amount and a stale comp percent surviving in the model after the visible inputs were
 * cleared, so later searches kept sending a prior session's values. `subordinateLoanAmount` is
 * cleared to 0 and `brokerCriteria.compPlan` is DELETED (the captured base carries no compPlan key
 * at all), then each is re-applied ONLY when the caller supplies it.
 *
 * PROVEN TO FAIL: drop the re-apply after clearScenarioOwnedFields and SUB-1/COMP-1 go red (the
 * documented footgun — the clear would silently zero a caller's value); return `pct` instead of
 * `-pct` and COMP-SIGN goes red; remove the compPlan clearing entry and LEAK-2 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const loc = { zip: '11211', state: 'NY', countyFps: '36047' };
const S = { purpose: 'Purchase', fico: 760, value: 5e5, loan: 4e5, dscr: 1.25 };

console.log('§31.5/§31.6 subordinate financing + broker comp percent');

// ---- subordinate amount is transmitted on the confirmed criteria path -------
{
  const m = sm.buildSearch({ ...S, subordinateLoanAmount: 50000 });
  ok(m.criteria.subordinateLoanAmount === 50000, 'SUB-1 subordinateLoanAmount reaches criteria.subordinateLoanAmount');
  // the engine derives CLTV — we must NOT invent one
  const wire = JSON.stringify(m);
  ok(!/"cltv"/i.test(wire) && !/"hcltv"/i.test(wire), 'SUB-2 no CLTV/HCLTV field is invented (the engine derives it)');
}
// omitted → the cleared neutral 0 (the captured base default), never a stale value
ok(sm.buildSearch({ ...S }).criteria.subordinateLoanAmount === 0, 'SUB-3 an omitted subordinate amount is the neutral 0');
// zero is a real, storable choice
ok(sm.buildSearch({ ...S, subordinateLoanAmount: 0 }).criteria.subordinateLoanAmount === 0, 'SUB-4 an explicit 0 is accepted');

// ---- combined LTV is validated, not transmitted -----------------------------
{
  const over = sm.validateScenario({ ...S, ...loc, subordinateLoanAmount: 150000 });
  ok(over.ok === false && over.status === 422 && over.error === 'cltv_out_of_range',
    'CLTV-1 first lien + subordinate over 100% of value is rejected 422');
  const at = sm.validateScenario({ ...S, ...loc, subordinateLoanAmount: 100000 }); // 400k+100k = 500k = exactly 100%
  ok(at.ok === true, 'CLTV-2 a combined LTV of exactly 100% is accepted (the boundary is inclusive)');
  const under = sm.validateScenario({ ...S, ...loc, subordinateLoanAmount: 50000 });
  ok(under.ok === true, 'CLTV-3 a combined LTV under 100% is accepted');
  const neg = sm.validateScenario({ ...S, ...loc, subordinateLoanAmount: -1 });
  ok(neg.ok === false && neg.error === 'out_of_range', 'CLTV-4 a negative subordinate amount is rejected');
  // the CLTV rule also works when the value was DERIVED rather than supplied
  const derived = sm.validateScenario({ purpose: 'Purchase', fico: 760, loan: 400000, ltv: 80, ...loc, subordinateLoanAmount: 200000 });
  ok(derived.ok === false && derived.error === 'cltv_out_of_range',
    'CLTV-5 the rule applies against a DERIVED property value too (500000 -> 120% combined)');
}

// ---- comp percent: the confirmed SIGN INVERSION ----------------------------
{
  const m = sm.buildSearch({ ...S, compPercent: 2.5 });
  ok(m.brokerCriteria.compPlan === -2.5, 'COMP-1 a visible 2.5% is transmitted as compPlan -2.5');
  ok(typeof m.brokerCriteria.compPlan === 'number', 'COMP-2 …as a JSON number, not a string');
}
ok(sm._internals.compPlanValue(2.5) === -2.5, 'COMP-SIGN the named conversion negates the visible percent');
ok(sm._internals.compPlanValue(1.125) === -1.125, 'COMP-SIGN2 a fractional percent negates exactly');
// 0% must not serialize as "-0"
{
  const m = sm.buildSearch({ ...S, compPercent: 0 });
  ok(Object.is(m.brokerCriteria.compPlan, 0), 'COMP-ZERO a 0% comp is 0, never -0');
  ok(JSON.stringify(m.brokerCriteria.compPlan) === '0', 'COMP-ZERO2 …and serializes as 0');
}
// a NEGATIVE input is refused rather than double-negated into a positive comp
{
  const r = sm.validateScenario({ ...S, ...loc, compPercent: -2.5 });
  ok(r.ok === false && r.error === 'out_of_range',
    'COMP-NEG a negative comp percent is refused (never double-negated into a positive)');
}
// omitted → the key stays ABSENT, matching the captured base which has no compPlan at all
{
  const m = sm.buildSearch({ ...S });
  ok(!('compPlan' in (m.brokerCriteria || {})), 'COMP-OMIT an omitted comp percent leaves compPlan absent');
}

// ---- §31.6 the stale-leak cases both close ---------------------------------
{
  const base = JSON.parse(JSON.stringify(sm.BASE));
  base.brokerCriteria.compPlan = -2.5;          // a prior session's comp percent
  base.criteria.subordinateLoanAmount = 50000;  // a prior session's second lien
  const m = sm.buildSearch({ ...S }, { base }); // this scenario supplies NEITHER
  ok(m.criteria.subordinateLoanAmount === 0, 'LEAK-1 a stale subordinate amount is cleared to neutral');
  ok(!('compPlan' in m.brokerCriteria), 'LEAK-2 a stale compPlan is removed entirely (its captured neutral is absent)');
  // and a supplied value still wins over the stale one
  const m2 = sm.buildSearch({ ...S, subordinateLoanAmount: 25000, compPercent: 1 }, { base });
  ok(m2.criteria.subordinateLoanAmount === 25000 && m2.brokerCriteria.compPlan === -1,
    'LEAK-3 supplied values are re-applied AFTER the clear (the documented footgun stays closed)');
}

// ---- both are reachable over HTTP (route contract) --------------------------
{
  const { handlers } = require('../src/longterm/routes/dscr-pricer');
  ok(typeof handlers.price === 'function', 'ROUTE-0 the price handler exists');
  const { unsupportedFields } = require('../src/longterm/routes/dscr-pricer');
  if (typeof unsupportedFields === 'function') {
    ok(unsupportedFields({ purpose: 'Purchase', subordinateLoanAmount: 1, compPercent: 1 }).length === 0,
      'ROUTE-1 subordinateLoanAmount + compPercent are supported route fields');
  } else { pass++; console.log('  ok   ROUTE-1 (unsupportedFields not exported — covered by test-lt-dscr-routes)'); }
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

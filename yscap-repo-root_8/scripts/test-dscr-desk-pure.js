'use strict';
/**
 * #204 — pure tests for the advisory DSCR desk (rent vs PITIA). Proves:
 *   • PITIA sums P&I + taxes + insurance + association (+ flood/other), normalizing
 *     annual figures to monthly; interest-only and amortized P&I both derive;
 *   • a rent roll sums per-unit rents; a single rent / annual rent normalize;
 *   • DSCR = rent ÷ PITIA, and an effective DSCR applies vacancy;
 *   • classification is advisory and ONLY against a supplied floor (pass/short/
 *     marginal/informational/unknown) — never a hard block (overridable always true);
 *   • the shortfall math is right, and nothing throws on hostile input.
 */
const assert = require('assert');
const d = require('../src/lib/underwriting/dscr-desk');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// 1. PITIA composition + annual→monthly normalization.
{
  const p = d.computePitia({ pi: 1000, taxes: 6000, taxesAnnual: true, insurance: 1200, insuranceAnnual: true, hoa: 150, flood: 600, floodAnnual: true });
  assert.strictEqual(p.breakdown.pi, 1000);
  assert.strictEqual(p.breakdown.taxes, 500);      // 6000/12
  assert.strictEqual(p.breakdown.insurance, 100);  // 1200/12
  assert.strictEqual(p.breakdown.association, 150);
  assert.strictEqual(p.breakdown.flood, 50);       // 600/12
  assert.strictEqual(p.monthly, 1800);             // 1000+500+100+150+50
  ok('PITIA sums P&I + T + I + A (+flood) and normalizes annual figures to monthly');
}

// 2. interest-only vs amortized P&I derivation.
{
  const io = d.monthlyPI({ loanAmount: 300000, rate: 0.10 });         // 300k × 10% ÷ 12
  assert.ok(near(io, 2500), `interest-only ${io}`);
  const ioPct = d.monthlyPI({ loanAmount: 300000, rate: 10 });        // percent form
  assert.strictEqual(io, ioPct, 'a percent rate (10) equals a decimal rate (0.10)');
  const amort = d.monthlyPI({ loanAmount: 300000, rate: 0.06, termMonths: 360, interestOnly: false });
  assert.ok(near(amort, 1798.65, 0.5), `30yr @6% amortized ${amort}`);
  const zero = d.monthlyPI({ loanAmount: 12000, rate: 0, termMonths: 12, interestOnly: false });
  assert.strictEqual(zero, 1000, '0% amortized = straight-line principal');
  ok('P&I derives interest-only (loan×rate÷12) and fully amortized over a term');
}

// 3. rent roll sums; single + annual rent normalize.
{
  const roll = d.grossRent([{ unit: 'A', monthlyRent: 1500 }, { unit: 'B', monthlyRent: 1600 }, { unit: 'C', annualRent: 18000 }]);
  assert.strictEqual(roll.monthly, 4600); // 1500+1600+1500
  assert.strictEqual(roll.units, 3);
  assert.strictEqual(d.grossRent(2000).monthly, 2000);
  assert.strictEqual(d.grossRent({ annual: 24000 }).monthly, 2000);
  ok('a rent roll sums per-unit rents; single + annual rents normalize to monthly');
}

// 4. DSCR = rent / PITIA; effective DSCR applies vacancy.
{
  const r = d.dscrDesk({ rent: 2400, pitia: { pi: 1500, taxes: 300, insurance: 100, hoa: 100 } }); // PITIA 2000
  assert.strictEqual(r.pitia.monthly, 2000);
  assert.strictEqual(r.dscr, 1.2);          // 2400/2000
  assert.strictEqual(r.shortfallMonthly, 0); // rent covers payment
  const v = d.dscrDesk({ rent: 2400, vacancy: 0.05, pitia: { monthly: 2000 } });
  assert.strictEqual(v.rent.effectiveMonthly, 2280); // 2400×0.95
  assert.strictEqual(v.effectiveDscr, 1.14);         // 2280/2000
  ok('DSCR = rent ÷ PITIA; effective DSCR applies the vacancy factor');
}

// 5. classification is advisory + floor-relative.
{
  const pass = d.dscrDesk({ rent: 2400, pitia: { monthly: 2000 }, floor: 1.10 });
  assert.strictEqual(pass.status, 'pass');
  assert.strictEqual(pass.meetsFloor, true);
  const short = d.dscrDesk({ rent: 1800, pitia: { monthly: 2000 }, floor: 1.10 });
  assert.strictEqual(short.status, 'short');
  assert.strictEqual(short.meetsFloor, false);
  assert.strictEqual(short.shortfallMonthly, 200); // 2000-1800
  const info = d.dscrDesk({ rent: 2400, pitia: { monthly: 2000 } }); // no floor
  assert.strictEqual(info.status, 'informational');
  assert.strictEqual(info.meetsFloor, null);
  const marg = d.dscrDesk({ rent: 2100, pitia: { monthly: 2000 }, floor: 1.10, marginalBand: 0.10 }); // dscr 1.05, floor 1.10, band .10
  assert.strictEqual(marg.status, 'marginal');
  const unknown = d.dscrDesk({ rent: 2400, pitia: { monthly: 0 }, floor: 1.10 });
  assert.strictEqual(unknown.status, 'unknown');
  assert.strictEqual(unknown.dscr, null);
  ok('classification is floor-relative: pass / short / marginal / informational / unknown');
}

// 6. break-even flag + never a hard block.
{
  const be = d.dscrDesk({ rent: 2000, pitia: { monthly: 2000 }, floor: 1.25 });
  assert.strictEqual(be.dscr, 1);
  assert.strictEqual(be.breakEven, true);
  assert.strictEqual(be.status, 'short', 'break-even is still below a 1.25 floor');
  assert.strictEqual(be.overridable, true, 'a super-admin can always override — never a hard block');
  assert.ok(!('block' in be) && !('blocks' in be));
  ok('break-even (1.00) flagged; still advisory — overridable always true, no block field');
}

// 7. hostile input never throws → safe default.
{
  for (const bad of [null, undefined, 42, 'x', [], {}, { rent: 'zz', pitia: 'qq' }, { rent: [null, { monthlyRent: -5 }] }, { pitia: { pi: {} } }]) {
    assert.doesNotThrow(() => d.dscrDesk(bad));
    assert.doesNotThrow(() => d.computePitia(bad));
    assert.doesNotThrow(() => d.grossRent(bad));
    assert.doesNotThrow(() => d.monthlyPI(bad));
  }
  const r = d.dscrDesk(null);
  assert.strictEqual(r.dscr, null);
  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(r.overridable, true);
  // a negative rent-roll line floors to 0, never a negative rent.
  assert.strictEqual(d.grossRent([{ monthlyRent: -100 }]).monthly, 0);
  ok('hostile input never throws; degrades to a safe advisory default');
}

console.log(`\ndscr-desk pure — ${passed} checks passed`);

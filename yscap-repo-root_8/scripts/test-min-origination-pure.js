'use strict';
/**
 * scripts/test-min-origination-pure.js — the minimum origination fee's own rules.
 *
 * PURE: no database, no network, no browser. Everything `src/lib/min-origination.js` decides is
 * decided here with real numbers, because the alternative — a regex over the caller — can only ever
 * pin the spelling of arithmetic (the 2026-09-02 cobrowse-zoom lesson).
 *
 * The owner's own example is section A1 and it is the first thing that runs.
 */
const assert = require('assert');
const M = require('../src/lib/min-origination');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e && e.message}`); }
}
const R = (o) => M.originationFor(o);

/* ── A. THE OWNER'S RULE ─────────────────────────────────────────────────────────────────────── */
t('A1 the owner\'s own example: a $100,000 loan at 1.25% is charged the $2,500 minimum', () => {
  const o = R({ totalLoan: 100000, origPct: 0.0125, minFee: 2500 });
  assert.strictEqual(o.pctAmount, 1250, 'the percentage figure');
  assert.strictEqual(o.amount, 2500, 'the fee charged');
  assert.strictEqual(o.applied, true);
  assert.strictEqual(o.shortfall, 1250);
  assert.strictEqual(o.effectivePct, 0.025, 'an effective 2.5%');
});

t('A2 the crossover is exactly $200,000 at 1.25%, and it is NOT "applied" there', () => {
  const at = R({ totalLoan: 200000, origPct: 0.0125, minFee: 2500 });
  assert.strictEqual(at.amount, 2500);
  assert.strictEqual(at.applied, false, 'the percentage reached it on its own — nothing to explain');
  assert.strictEqual(at.label, null);
  assert.strictEqual(at.note, null);
  const below = R({ totalLoan: 199999, origPct: 0.0125, minFee: 2500 });
  assert.strictEqual(below.applied, true);
});

t('A3 every loan above the crossover is byte-identical to no-minimum behaviour', () => {
  for (const loan of [200001, 250000, 400000, 1250000, 7500000]) {
    const withMin = R({ totalLoan: loan, origPct: 0.0125, minFee: 2500 });
    const without = R({ totalLoan: loan, origPct: 0.0125, minFee: 0 });
    assert.strictEqual(withMin.amount, without.amount, `loan ${loan}`);
    assert.strictEqual(withMin.applied, false);
    assert.strictEqual(withMin.label, null);
    assert.strictEqual(withMin.note, null);
    assert.strictEqual(withMin.effectivePct, 0.0125, 'the effective percentage IS the stated one');
  }
});

t('A4 the whole ladder the research measured', () => {
  const expect = [
    [50000, 625, 2500, true], [75000, 937.5, 2500, true], [100000, 1250, 2500, true],
    [150000, 1875, 2500, true], [180000, 2250, 2500, true],
    [200000, 2500, 2500, false], [400000, 5000, 5000, false],
  ];
  for (const [loan, pctAmt, charged, applied] of expect) {
    const o = R({ totalLoan: loan, origPct: 0.0125, minFee: 2500 });
    assert.strictEqual(o.pctAmount, pctAmt, `pct on ${loan}`);
    assert.strictEqual(o.amount, charged, `charged on ${loan}`);
    assert.strictEqual(o.applied, applied, `applied on ${loan}`);
  }
});

t('A5 it can only ever RAISE the fee — never reduce one, at any percentage', () => {
  for (const pct of [0, 0.005, 0.01, 0.0125, 0.02, 0.03, 0.05]) {
    for (const loan of [1, 25000, 99999, 200000, 1000000]) {
      const o = R({ totalLoan: loan, origPct: pct, minFee: 2500 });
      assert.ok(o.amount >= o.pctAmount - 1e-9, `reduced at ${pct} on ${loan}`);
      if (o.applied) assert.ok(o.amount > o.pctAmount, 'applied implies strictly higher');
    }
  }
});

/* ── B. THE CASES THAT WOULD COST MONEY OR NONSENSE ──────────────────────────────────────────── */
t('B1 an unsized loan carries NO fee — the minimum never puts $2,500 on a blank screen', () => {
  for (const loan of [0, -1, null, undefined, '', NaN]) {
    const o = R({ totalLoan: loan, origPct: 0.0125, minFee: 2500 });
    assert.strictEqual(o.amount, 0, `loan ${String(loan)}`);
    assert.strictEqual(o.applied, false);
    assert.strictEqual(o.note, null);
  }
});

t('B2 a minimum of 0 is an approved WAIVER and is honoured, never treated as unset', () => {
  const o = R({ totalLoan: 100000, origPct: 0.0125, minFee: 0 });
  assert.strictEqual(o.amount, 1250, 'the percentage alone');
  assert.strictEqual(o.applied, false);
  assert.strictEqual(o.note, null);
});

t('B3 the ROUNDING ORDER: a fee that PRINTS as the minimum is not "minimum applied"', () => {
  /* 199,999.68 * 1.25% = 2,499.996 → prints $2,500.00. Comparing the UNROUNDED product would label
     this "minimum applied" on a sheet showing the two figures as equal, and would leave the printed
     fees a cent short of the total beneath them. */
  const o = R({ totalLoan: 199999.68, origPct: 0.0125, minFee: 2500 });
  assert.strictEqual(o.pctAmount, 2500, 'the percentage figure rounds to the minimum');
  assert.strictEqual(o.amount, 2500);
  assert.strictEqual(o.applied, false, 'nothing to explain — the percentage got there');
});

t('B4 the amount is always a clean 2dp figure — no cent can drift into a total', () => {
  for (const loan of [33333.33, 87654.21, 123456.78, 999999.99]) {
    for (const pct of [0.0125, 0.01999, 0.03]) {
      const o = R({ totalLoan: loan, origPct: pct, minFee: 2500 });
      assert.strictEqual(o.amount, Math.round(o.amount * 100) / 100, `${loan} @ ${pct}`);
      assert.strictEqual(o.shortfall, Math.round(o.shortfall * 100) / 100);
      if (o.applied) assert.strictEqual(Math.round((o.pctAmount + o.shortfall) * 100) / 100, o.amount,
        'the parts reconcile to the charged figure');
    }
  }
});

t('B5 the effective percentage is what the tape and the derivation both read, and it reconciles', () => {
  for (const loan of [50000, 100000, 175000, 200000, 600000]) {
    const o = R({ totalLoan: loan, origPct: 0.0125, minFee: 2500 });
    assert.ok(Math.abs(o.effectivePct * o.totalLoan - o.amount) < 0.005,
      `effective pct does not reproduce the dollars on ${loan}`);
    if (!o.applied) assert.strictEqual(o.effectivePct, o.pct, 'byte-identical when it did not bind');
  }
});

t('B6 the loan amount is CARRIED, not re-derived — a 0% deal still states it', () => {
  const o = R({ totalLoan: 100000, origPct: 0, minFee: 2500 });
  assert.strictEqual(o.totalLoan, 100000);
  assert.ok(M.derivationLine(o).includes('$100,000.00'),
    'the derivation must name the real loan amount, never pctAmount/pct');
});

/* ── C. THE RESOLUTION CHAIN ─────────────────────────────────────────────────────────────────── */
t('C1 per-file wins, then company, then the system default', () => {
  assert.strictEqual(M.resolveMinFee(1500, 3000), 1500);
  assert.strictEqual(M.resolveMinFee(null, 3000), 3000);
  assert.strictEqual(M.resolveMinFee(null, null), M.MIN_ORIGINATION_FEE);
  assert.strictEqual(M.MIN_ORIGINATION_FEE, 2500, 'the owner\'s number');
});

t('C2 an explicit 0 at either step is a decision and is NOT skipped', () => {
  assert.strictEqual(M.resolveMinFee(0, 3000), 0, 'a per-file waiver must survive the chain');
  assert.strictEqual(M.resolveMinFee(null, 0), 0, 'a company-wide waiver likewise');
});

t('C3 junk, blanks and a decimal slip fall THROUGH rather than being applied', () => {
  for (const bad of ['', '  ', null, undefined, NaN, 'abc', -1, -2500, 250000, Infinity]) {
    assert.strictEqual(M.resolveMinFee(bad, 3000), 3000, `per-file ${String(bad)}`);
    assert.strictEqual(M.resolveMinFee(null, bad), M.MIN_ORIGINATION_FEE, `company ${String(bad)}`);
  }
  assert.strictEqual(M.resolveMinFee(M.MAX_MIN_ORIGINATION_FEE, null), M.MAX_MIN_ORIGINATION_FEE,
    'the cap itself is allowed — it is a ceiling, not an exclusion');
});

/* ── D. THE WORDING ──────────────────────────────────────────────────────────────────────────── */
t('D1 nothing prints when the minimum did not bind', () => {
  const o = R({ totalLoan: 400000, origPct: 0.0125, minFee: 2500 });
  assert.strictEqual(o.label, null);
  assert.strictEqual(o.note, null);
  assert.strictEqual(M.derivationLine(o), null);
  assert.strictEqual(M.emailLine(o), 'Origination fee — $5,000.00');
});

t('D2 the qualifier is a QUALIFIER on the existing row, never a second fee', () => {
  const o = R({ totalLoan: 100000, origPct: 0.0125, minFee: 2500 });
  assert.strictEqual(o.label, 'Origination fee (minimum applied)');
  assert.ok(o.label.startsWith(M.LABEL_PLAIN), 'it must still read as the origination fee row');
});

t('D3 the sub-line states both figures a reader needs to reconcile', () => {
  const o = R({ totalLoan: 100000, origPct: 0.0125, minFee: 2500 });
  assert.ok(o.note.includes('$2,500.00'), 'the minimum');
  assert.ok(o.note.includes('1.25%'), 'the rate it beat');
  assert.ok(o.note.includes('$1,250.00'), 'what that rate came to');
});

t('D4 no borrower-facing wording calls it a penalty, or names a percentage twice', () => {
  const o = R({ totalLoan: 100000, origPct: 0.0125, minFee: 2500 });
  for (const text of [o.label, o.note, M.emailLine(o)]) {
    assert.ok(!/penalt/i.test(text), `"penalty" wording in: ${text}`);
    assert.ok(!/2\.5%/.test(text),
      `the EFFECTIVE percentage must not appear on a borrower row — two rates on one line: ${text}`);
  }
});

t('D5 the derivation page DOES show the effective percentage — it exists to be reconciled', () => {
  const line = M.derivationLine(R({ totalLoan: 100000, origPct: 0.0125, minFee: 2500 }));
  assert.ok(line.includes('1.25%') && line.includes('$1,250.00'), 'the arithmetic');
  assert.ok(line.includes('$2,500.00'), 'the minimum and the charge');
  assert.ok(line.includes('2.5%'), 'the effective percentage');
});

t('D6 a percentage reads as a person writes it', () => {
  assert.strictEqual(M._internals.pctStr(0.025), '2.5%');
  assert.strictEqual(M._internals.pctStr(0.0125), '1.25%');
  assert.strictEqual(M._internals.pctStr(0.05), '5%');
});

/* ── E. PURITY ───────────────────────────────────────────────────────────────────────────────── */
t('E1 the module is pure — no database, no config, no requires', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/lib/min-origination.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ');
  assert.ok(!/\brequire\s*\(/.test(stripped), 'min-origination.js must require nothing');
});

t('E2 the result is frozen and the function never mutates its input', () => {
  const input = { totalLoan: 100000, origPct: 0.0125, minFee: 2500 };
  const copy = JSON.stringify(input);
  const o = R(input);
  assert.strictEqual(JSON.stringify(input), copy, 'input mutated');
  assert.ok(Object.isFrozen(o));
});

t('E3 it never throws, on anything', () => {
  const junk = [undefined, null, {}, { totalLoan: 'x', origPct: {}, minFee: [] },
    { totalLoan: Infinity, origPct: -1, minFee: NaN }, { totalLoan: 1e300, origPct: 1e300 }];
  for (const j of junk) assert.doesNotThrow(() => R(j), `threw on ${JSON.stringify(j)}`);
});

console.log(`\nmin-origination: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

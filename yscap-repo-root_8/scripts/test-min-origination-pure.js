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
  /* The derivation page shows "1.25% of $100,000.00 = …", and recovering that loan as
     `pctAmount / pct` is a division by zero at 0% and floating-point fragile everywhere else — a
     page that misstates the number it is deriving FROM is worse than none. */
  const o = R({ totalLoan: 100000, origPct: 0, minFee: 2500 });
  assert.strictEqual(o.totalLoan, 100000);
  assert.strictEqual(o.pctAmount, 0, 'and 0% of a real loan is a real $0, not a missing value');
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
  for (const text of [o.label, o.note]) {
    assert.ok(!/penalt/i.test(text), `"penalty" wording in: ${text}`);
    assert.ok(!/2\.5%/.test(text),
      `the EFFECTIVE percentage must not appear on a borrower row — two rates on one line: ${text}`);
  }
});

t('D5 the EFFECTIVE percentage is published, because two readers genuinely need it', () => {
  /* The Inputs & Loan Derivation page (which prints it as its own sub-row — J and the render proof
     cover the drawing) and Blue Lake's data tape, which sends origination as a percentage and must
     send the REAL one when the floor bound (owner-directed 2026-09-04). It is never on a borrower's
     fee ROW, though — two competing rates on one line is D4. */
  const o = R({ totalLoan: 100000, origPct: 0.0125, minFee: 2500 });
  assert.strictEqual(o.effectivePct, 0.025);
  assert.strictEqual(o.pctAmount, 1250, 'and the arithmetic behind it is on the result, not re-derived');
  assert.strictEqual(o.totalLoan, 100000, 'including the loan it was taken from');
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

/* ── F. THE SERVER WIRING — the claims other files rest on ───────────────────────────────────────
   These are SOURCE guards and they are TRIPWIRES, not proofs (the 2026-09-02 lesson): a regex over
   a caller can only ever pin a spelling. What they hold up are three claims made in comments
   elsewhere, each of which is invisible to any behavioural test and expensive if it quietly stops
   being true. */
const FS = require('fs'), PATH = require('path');
const read = (rel) => FS.readFileSync(PATH.join(__dirname, '..', rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ');

t('F1 the per-file minimum has exactly ONE writer — which is what lets db/695 leave the economics-reopen trigger alone', () => {
  let writers = 0;
  for (const f of ['src/routes/staff.js', 'src/routes/borrower.js', 'src/routes/tpo.js',
                   'src/lib/product-registration.js', 'src/lib/term-sheet-offer.js',
                   'src/lib/intake-auto-register.js', 'src/routes/admin-manual-programs.js']) {
    let src; try { src = stripComments(read(f)); } catch (_) { continue; }
    writers += (src.match(/file_min_orig_fee\s*=/g) || []).length;
  }
  assert.strictEqual(writers, 1,
    'db/695 declines to widen the economics-reopen trigger because this column can only be written '
    + 'as part of a REGISTRATION. A second writer means a change to it can go stale against the '
    + 'registration that priced the file — widen the trigger, or route the new door through register.');
});

t('F2 a BLANK box clears the sticky, which is what makes the owner\'s re-registration rule true', () => {
  const src = stripComments(read('src/routes/staff.js'));
  assert.ok(/hasOwnProperty\.call\(overrides,\s*'minOrigFee'\)/.test(src),
    'the write must be guarded on the key being SENT, not on it being truthy — a blank sends "" and '
    + 'must write NULL over any stale value, or a re-registered file stays locked in at yesterday\'s number');
  /* RE-POINTED 2026-09-04, not loosened. This pinned the literal `stickyMk(...)`, and the
     writer now goes through `stickyMinOrig`, which DELEGATES to it and additionally refuses a
     value the column's CHECK would reject (db/695: 0..25000). The subject is unchanged — a
     blank still writes NULL and a typed 0 still survives, because both come from `stickyMk`
     — so the guard asserts the DELEGATION rather than the helper's name, and gains the bound
     it did not know about. */
  const writer = /file_min_orig_fee=\$2[\s\S]{0,140}?(sticky[A-Za-z]*)\(overrides\.minOrigFee\)/.exec(src);
  assert.ok(writer, 'the write is fed by a sticky helper, not a raw request value');
  const helper = new RegExp('const ' + writer[1] + '\\s*=\\s*\\([\\s\\S]{0,400}?\\};').exec(src);
  assert.ok(helper, `the ${writer[1]} helper is defined in this file`);
  assert.ok(/stickyMk\(/.test(helper[0]),
    'it delegates to stickyMk, which is what maps "" to NULL and keeps a typed 0 (the waiver)');
  assert.ok(/applicationColumnProblem\(\s*'file_min_orig_fee'/.test(helper[0]),
    'and it asks the COLUMN before storing: db/695\'s CHECK is far narrower than numeric(12,2), '
    + 'so an unbounded value is refused by Postgres inside the registration transaction and '
    + 'surfaces as a 500 that names nothing');
});

t('F2b the register door REFUSES an out-of-range minimum in plain words, before any work', () => {
  const src = stripComments(read('src/routes/staff.js'));
  /* The sticky guard above makes a 500 impossible; this is what makes the officer TOLD.
     Silently dropping a typed number is the swallowed-refusal class — they would re-open the
     file and find the box empty with no explanation. */
  assert.ok(/overrides\.minOrigFee[\s\S]{0,400}?applicationColumnProblem\(\s*'file_min_orig_fee'[\s\S]{0,200}?res\.status\(400\)/.test(src),
    'the register route judges a typed minOrigFee against the column and answers 400 with the reason');
  assert.ok(/field:\s*'minOrigFee'/.test(src), 'and the refusal names the box, so the screen can point at it');
});

t('F3 a BORROWER and a TPO broker can never send it', () => {
  const ov = require('../src/lib/pricing-overrides');
  const out = ov.borrowerPricingOverrides({ minOrigFee: 0, targetLTC: 0.8 });
  assert.ok(!('minOrigFee' in out), 'the non-lender allowlist builds its output from scratch and must never carry this');
  assert.strictEqual(out.targetLTC, 0.8, 'and the control proves the allowlist still passes what it should');
});

t('F4 it routes to an admin as a DEFAULTED knob: a discount and a waiver ask, charging more does not', () => {
  const ov = require('../src/lib/pricing-overrides');
  const cd = { minOrigFee: 2500 };
  const keys = (raw) => ov.pricingOverridesEngaged(raw, cd).map((c) => c.key);
  assert.deepStrictEqual(keys({ minOrigFee: 2500 }), [], 'typing the company number back is not a change');
  assert.deepStrictEqual(keys({ minOrigFee: '' }), [], 'an explicitly blanked box is not a change');
  assert.deepStrictEqual(keys({ minOrigFee: 4000 }), [], 'RAISING the floor can only raise the fee — revenueUp, no approval');
  assert.deepStrictEqual(keys({ minOrigFee: 1000 }), ['minOrigFee'], 'LOWERING it is a discount and needs approval');
  assert.deepStrictEqual(keys({ minOrigFee: 0 }), ['minOrigFee'],
    'a typed 0 WAIVES the minimum outright — the decision an admin most wants to see');
});

t('F5 restating the company number normalizes to the studio\'s explicit-blank contract', () => {
  const ov = require('../src/lib/pricing-overrides');
  assert.strictEqual(ov.normalizeCompanyDefaultKnobs({ minOrigFee: 2500 }, { minOrigFee: 2500 }).minOrigFee, '',
    'the 2026-08-20 rule: a restated default must never freeze onto the file');
  assert.strictEqual(ov.normalizeCompanyDefaultKnobs({ minOrigFee: 1000 }, { minOrigFee: 2500 }).minOrigFee, 1000,
    'and a real exception is left completely alone');
});

t('F7 the studio sends an EXPLICIT BLANK, outside compact(), or the blank can never clear anything', () => {
  /* `compact()` drops `''`, so a key placed inside it never reaches the server when its box is
     empty — and the register's `hasOwnProperty` guard therefore never fires. That is why the
     markups sit outside it, and why this one has to. */
  const src = stripComments(read('app-v2/src/components/ProductStudioPanel.jsx'));
  assert.ok(/f\.tsMinOrigFee === ''\s*\?\s*\{ minOrigFee: '' \}/.test(src),
    'an empty box must send minOrigFee:"" explicitly');
  assert.ok(!/^\s*minOrigFee: f\.tsMinOrigFee,\s*$/m.test(src),
    'and it must NOT be a plain entry inside compact(), where a blank is silently dropped');
});

t('F6 the staff file OVERVIEW states the EFFECTIVE percentage, or its own row contradicts itself', () => {
  /* A TENTH SURFACE, outside the nine `scripts/lib/fee-roster.js` tracks, found by grepping for a
     second server-side origination derivation while wiring this. `file-overview.js` prints the
     percentage and the dollars TOGETHER — "1.25% · $2,500.00" on a $60,000 loan, where 1.25% is
     $750 — so on a minimum-bound file the row states two figures that cannot both be true. It is a
     TRIPWIRE (a source check cannot prove a render); the printed surfaces are proven by the render
     harness in the surfaces pass. */
  const src = stripComments(read('src/lib/file-overview.js'));
  assert.ok(/originationMinimum/.test(src),
    'the overview must read the quote\'s own explain block rather than deciding again');
  assert.ok(/effectivePct/.test(src) && /program minimum applied/.test(src),
    'and it must show the effective percentage AND say why, or the two figures on the row disagree');
});

/* ── G. ONE NUMBER, TWO PLACES ───────────────────────────────────────────────────────────────── */
t('G1 the cold-cache fallback in pricing-settings equals this module\'s own number', () => {
  const D = require('../src/lib/pricing-settings').SYSTEM_DEFAULTS;
  assert.strictEqual(D.minOrigFee, M.MIN_ORIGINATION_FEE,
    'SYSTEM_DEFAULTS restates the literal on purpose (it is the unwarmed-process fallback and must '
    + 'load with nothing else in reach) — so it is held equal HERE, or the two drift and an unwarmed '
    + 'process charges a different minimum than a warm one');
});

t('G2 a NULL company column reads as the system default, never as a stored copy of it', () => {
  assert.strictEqual(M.resolveMinFee(null, null), M.MIN_ORIGINATION_FEE);
  assert.strictEqual(M.resolveMinFee(null, undefined), M.MIN_ORIGINATION_FEE);
  assert.strictEqual(M.resolveMinFee(null, ''), M.MIN_ORIGINATION_FEE);
});

/* ── H. RUNTIME EQUIVALENCE, THROUGH THE REAL PRICING PATH ───────────────────────────────────────
   The frozen-pricing proof. The baseline is the module NEUTRALIZED — the system without a minimum —
   swapped into the require cache, deliberately NOT read out of git: a git baseline proves inertness
   only until the change is committed, after which it degenerates into "the engine equals itself"
   and passes forever while proving nothing. */
const pricing = require('../src/lib/pricing');
if (!pricing.enginesReady || !pricing.enginesReady()) {
  console.log('SKIP section H (runtime equivalence): engines not loadable', pricing.loadErr && pricing.loadErr());
} else {
  const exp = { flips: 5, holds: 2, ground: 3 };
  const quote = (app, ov) => pricing.quoteProgram(app.__program || 'standard', pricing.buildInputs(app, exp, ov || {}));

  /* The battery deliberately straddles the crossover ($200,000 at 1.25%): the small prices size
     loans the floor BINDS on, the large ones size loans it can never reach. Both halves have to be
     non-empty or the comparison is half a proof. */
  const APPS = [];
  for (const eng of ['standard', 'gold', 'silver', 'speed']) {
    for (const state of ['TX', 'NY', 'NJ', 'FL']) {
      for (const price of [60000, 90000, 140000, 300000, 700000]) {
        /* THREE DEAL SHAPES, because the fee reaches the borrower's pocket by two different routes
           (see the H2 loop). A cash-out refinance funds more than the payoff plus closing, so the
           fee comes out of the PROCEEDS and cash-to-close is legitimately 0; a heavy-payoff
           refinance and every purchase make the borrower BRING it. Both branches have to be in
           the battery or half the property is untested. */
        for (const [loanType, payoffPct] of [['Purchase', 0], ['Refinance — Cash-Out', 0.55], ['Refinance — Rate & Term', 1.45]]) {
          APPS.push({
            __program: eng,
            purchase_price: price, as_is_value: price, arv: Math.round(price * 1.6),
            rehab_budget: Math.round(price * 0.3), fico: 730, term: 12,
            program: 'Fix & Flip', rehab_type: 'Light rehab', loan_type: loanType,
            property_type: 'Single Family', units: 1, property_address: { state },
            requested_exp_flips: 5, requested_exp_holds: 2, requested_exp_ground: 3,
            /* A REFINANCE FIXTURE CARRIES A REAL PAYOFF. Without one `cashToClose` is
               `max(0, 0 + closing − initial advance)` = 0 on every row, so the whole refinance half
               of the battery would be testing a deal that does not exist (the 2026-08-26 `<select>`
               lesson: set a fixture to a REAL value, or you indict the product for the fixture's
               own mistake). */
            ...(payoffPct ? { payoff_amount: Math.round(price * payoffPct) } : {}),
          });
        }
      }
    }
  }

  /* NEUTRALIZED = "there is no minimum": the fee is the percentage figure, always. Everything else
     about the shape is kept, so the only thing the comparison can see is the floor itself.

     IT IS DONE BY REPLACING THE FUNCTION ON THE EXPORTS OBJECT, **NOT** BY SWAPPING
     `require.cache[...].exports` — and that is not a style choice. `pricing.js` requires this
     module at the TOP and captures the reference ONCE at load, so a cache swap is a complete
     no-op there and every "identical" would have been a tautology. MEASURED while writing this:
     the cache swap left the fee at $2,500 on a loan the floor binds on, exactly as the real
     module does; the property replacement gives $900. (The feasibility-fee suite's cache swap
     works only because `pricing.js` requires THAT module lazily, inside the function.) The
     standing rule this belongs to: prove the baseline genuinely differs — H1 below is what caught
     it, and it is the reason that assertion exists at all. */
  const realFn = M.originationFor;
  const neutralFn = (i) => realFn({ ...(i || {}), minFee: 0 });

  const run = (fn) => {
    M.originationFor = fn;
    const out = APPS.map((a) => { try { return quote(a); } catch (e) { return { __err: String(e && e.message) }; } });
    M.originationFor = realFn;
    return out;
  };
  const off = run(neutralFn), on = run(realFn);

  t('H1 the baseline genuinely differs somewhere, so the comparison is not vacuous', () => {
    const moved = on.filter((q, i) => JSON.stringify(q) !== JSON.stringify(off[i]));
    assert.ok(moved.length > 0, 'neutralizing the minimum changed nothing — this section would prove nothing');
  });

  let drift = 0, bound = 0, unbound = 0, brings = 0, fromProceeds = 0;
  for (let i = 0; i < APPS.length; i++) {
    const b = on[i], c = off[i];
    if (b.__err || c.__err) continue;
    const detail = b.closingCosts && b.closingCosts.originationMinimum;
    if (!detail) {
      unbound++;
      if (JSON.stringify(b) !== JSON.stringify(c)) {
        drift++;
        if (drift < 3) console.log('   …drift on a loan the minimum never reaches:', APPS[i].__program, APPS[i].purchase_price);
      }
      continue;
    }
    bound++;
    const want = detail.shortfall;
    const d = (f) => Math.round((f(b) - f(c)) * 100) / 100;
    /* WHAT THE BORROWER NETS OUT OF POCKET. `pricing.js` states the invariant itself: exactly one
       of {cash the borrower brings, cash the borrower receives} is above zero. So a fee reaches a
       real person's pocket by ONE of two routes — it is added to what they bring on a purchase or
       a heavy-payoff refinance, and it is taken out of the PROCEEDS on a cash-out refinance, where
       `cashToClose` is legitimately clamped at 0 and moves by nothing. Asserting only on
       cash-to-close reported 60 false failures on exactly the cash-out rows, and "fix" it by
       loosening the assertion would have stopped proving the fee reaches the borrower at all. */
    const pocket = (q) => Number(q.cashToClose || 0) - Number((q.refi && q.refi.cashOut) || 0);
    if (JSON.stringify(b.sizing) !== JSON.stringify(c.sizing)) { drift++; console.log('   …SIZING MOVED — the thing that must never happen:', APPS[i].__program); }
    if (b.noteRate !== c.noteRate) { drift++; console.log('   …the RATE moved:', APPS[i].__program); }
    if (d((q) => q.closingCosts.origination) !== want) { drift++; console.log('   …the fee did not rise by exactly the shortfall'); }
    if (d((q) => q.closingCosts.dueAtClosing) !== want) { drift++; console.log('   …closing costs did not rise by exactly the shortfall'); }
    if (d(pocket) !== want) { drift++; console.log('   …the borrower\'s own money did not move by exactly the shortfall:', APPS[i].loan_type, APPS[i].purchase_price); }
    /* The liquidity to show is `cashToClose + reserves + out-of-pocket rehab + the 1% buffer`, so
       it moves with the fee exactly when the borrower is the one bringing it. On a deal funding
       its own closing costs there is nothing extra to show, which is the honest answer, so the
       assertion is keyed on cash-to-close having moved rather than being dropped. */
    if (d((q) => q.cashToClose) !== 0 && d((q) => q.liquidityRequired) !== want) {
      drift++; console.log('   …the liquidity to show did not rise by exactly the shortfall');
    }
    if (d((q) => q.cashToClose) === 0 && d((q) => q.liquidityRequired) !== 0) {
      drift++; console.log('   …the liquidity to show moved on a deal that brings no cash to the table');
    }
    if (b.cashToClose > 0) brings++; else fromProceeds++;
  }
  t('H2 every loan the minimum never reaches is BYTE-IDENTICAL, and every loan it binds on moves ONLY the fee', () => {
    assert.strictEqual(drift, 0);
  });
  t('H3 the battery reached loans the minimum binds on', () => assert.ok(bound > 20, `only ${bound}`));
  t('H4 …and loans it never reaches, so the equivalence half is not empty', () => assert.ok(unbound > 20, `only ${unbound}`));
  t('H4b …and BOTH ways the fee reaches a borrower\'s pocket', () => {
    assert.ok(brings > 10, `only ${brings} deals where the borrower brings it`);
    assert.ok(fromProceeds > 10, `only ${fromProceeds} deals funding it out of the proceeds`);
  });

  t('H5 the explain block is present ONLY when the floor bound, and says what it did', () => {
    const small = APPS.find((a) => a.purchase_price === 60000 && a.__program === 'standard');
    const big = APPS.find((a) => a.purchase_price === 700000 && a.__program === 'standard');
    const qs = quote(small), qb = quote(big);
    const m = qs.closingCosts.originationMinimum;
    assert.ok(m, 'a small loan must carry it');
    assert.strictEqual(m.amount, qs.closingCosts.origination, 'and it must agree with the fee beside it');
    assert.ok(m.amount > m.pctAmount && m.shortfall > 0);
    assert.ok(/minimum/i.test(m.label) && /minimum/i.test(m.note));
    assert.ok(!/penalty/i.test(m.note), 'never a penalty');
    assert.ok(!qb.closingCosts.originationMinimum, 'a large loan must carry nothing at all');
  });

  t('H6 an approved per-file WAIVER (a typed 0) prices exactly as the system did before the minimum', () => {
    const small = APPS.find((a) => a.purchase_price === 60000 && a.__program === 'standard');
    const waived = quote(small, { minOrigFee: 0 });
    M.originationFor = neutralFn;
    const none = quote(small);
    M.originationFor = realFn;
    assert.strictEqual(JSON.stringify(waived), JSON.stringify(none),
      'an approved waiver must be byte-identical to there being no minimum at all');
  });

  t('H7 a per-file exception RAISES the floor, and only the fee moves', () => {
    const small = APPS.find((a) => a.purchase_price === 140000 && a.__program === 'standard');
    const plain = quote(small), raised = quote(small, { minOrigFee: 5000 });
    assert.strictEqual(raised.closingCosts.origination, 5000);
    assert.strictEqual(JSON.stringify(raised.sizing), JSON.stringify(plain.sizing), 'the loan is untouched');
    assert.strictEqual(raised.noteRate, plain.noteRate, 'the rate is untouched');
    assert.strictEqual(
      Math.round((raised.liquidityRequired - plain.liquidityRequired) * 100) / 100,
      Math.round((raised.closingCosts.origination - plain.closingCosts.origination) * 100) / 100,
      'and the liquidity to show rose by exactly the difference');
  });

  t('H7b an EXPLICIT BLANK clears a stale per-file exception — the owner\'s re-registration rule', () => {
    /* THIS IS TWO SEPARATE MECHANISMS AND BOTH WERE MISSING, found by the end-to-end suite rather
       than by reading: the studio's payload has to SEND `''` (a key inside `compact()` is dropped
       when blank and can never clear anything — F7 pins that), and `buildInputs` has to DELETE the
       key rather than merely skip it, because `fileInputs` has already handed the base object the
       sticky value. MEASURED before the fix: a file registered with an approved WAIVER (a typed 0)
       and re-registered with the box cleared went on being charged the waived fee. */
    const app = { ...APPS.find((a) => a.purchase_price === 60000 && a.__program === 'standard'), file_min_orig_fee: 0 };
    assert.strictEqual(pricing.buildInputs(app, exp, {}).minOrigFee, 0, 'the control: the sticky governs when nothing is sent');
    assert.ok(!('minOrigFee' in pricing.buildInputs(app, exp, { minOrigFee: '' })),
      'an explicit blank must DELETE the key, not merely fail to overwrite it');
  });

  t('H8 a re-registered file with a BLANK box follows today\'s company minimum, never yesterday\'s', () => {
    /* The owner's own rule, as a property of buildInputs: a NULL column contributes NO key, so the
       resolution falls through to the company default every single time it is priced. A file that
       was registered when the company minimum was $2,500 and is re-registered after it moves to
       $3,000 is charged $3,000 — it is not "locked in where the fee was already locked in". */
    const app = { ...APPS.find((a) => a.purchase_price === 60000 && a.__program === 'standard'), file_min_orig_fee: null };
    const inp = pricing.buildInputs(app, exp, {});
    assert.ok(!('minOrigFee' in inp), 'a NULL column must contribute no key at all');
    const locked = pricing.buildInputs({ ...app, file_min_orig_fee: 2500 }, exp, {});
    assert.strictEqual(locked.minOrigFee, 2500, 'and a real exception on the file IS carried');
    const waived = pricing.buildInputs({ ...app, file_min_orig_fee: 0 }, exp, {});
    assert.strictEqual(waived.minOrigFee, 0, 'and a stored 0 survives — dropping it would un-waive an approved waiver');
  });
}

/* ── I. THE STUDIO'S BROWSER MIRROR ─────────────────────────────────────────────────────────────
   The Term Sheet Studio cannot require server code, so `web/v2/tools/termsheet.js` carries its own
   copy of this rule — the `lib/payoff.js` arrangement. A studio that PRINTS one fee while the
   register BOOKS another is exactly the drift the one-definition rule exists to stop, so the two
   are run over the SAME battery here and any disagreement fails the build.

   AND THE MIRROR CHECK ALSO ASSERTS THE RULE (J below), because two copies of one mistake read as
   a pass — that is precisely how the bridge/feasibility defect survived two years of a green
   agreement test (2026-08-26). */
{
  const TS = read('web/v2/tools/termsheet.js');
  const grab = (name) => {
    const m = new RegExp(`  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(TS);
    return m ? m[0] : null;
  };
  const resolveSrc = grab('resolvedMinOrigFee');
  const feeSrc = grab('originationFee');
  const noteSrc = grab('origMinNote');
  t('I1 the studio\'s own copy of the rule was found', () => {
    assert.ok(resolveSrc && feeSrc && noteSrc, 'the mirror is missing from termsheet.js');
  });

  if (resolveSrc && feeSrc && noteSrc) {
    /* Rebuilt with the studio's DOM/format dependencies stubbed, so what is compared is the RULE
       and not the browser around it. The two number formatters are the studio's real ones. */
    // eslint-disable-next-line no-new-func
    const mirror = new Function('loan', 'pct', 'typed', 'CO', `
      var MIN_ORIG_FEE = 2500, MAX_MIN_ORIG_FEE = 25000;
      function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
      function origPctStr(frac) { var p = Math.round(frac * 100 * 1000) / 1000; return p + "%"; }
      var YS = { fmtUSD2: function (n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } };
      function adminNumRaw() { return typed; }
      ${resolveSrc}
      ${noteSrc}
      ${feeSrc}
      return originationFee(loan, pct);`);

    const CASES = [];
    for (const loan of [0, 1, 40000, 72000, 100000, 199999, 200000, 200001, 480000, 2500000]) {
      for (const pct of [0, 0.0075, 0.0125, 0.02, 0.025]) {
        for (const typed of [null, 0, 1000, 2500, 5000, 25000, 30000, -5, NaN]) {
          for (const co of [2500, 3000, null]) CASES.push({ loan, pct, typed, co });
        }
      }
    }
    let disagree = 0;
    for (const c of CASES) {
      const b = mirror(c.loan, c.pct, c.typed, { minOrigFee: c.co });
      const sv = M.originationFor({ loan: 0, totalLoan: c.loan, origPct: c.pct, minFee: M.resolveMinFee(c.typed, c.co) });
      const keys = ['amount', 'pctAmount', 'minimum', 'applied', 'shortfall', 'effectivePct'];
      for (const k of keys) {
        if (JSON.stringify(b[k]) !== JSON.stringify(sv[k])) {
          disagree++;
          if (disagree < 4) console.log(`   …disagree on ${k} for ${JSON.stringify(c)}: browser=${b[k]} server=${sv[k]}`);
          break;
        }
      }
      if (Boolean(b.note) !== Boolean(sv.note) || (b.note && b.note !== sv.note)) {
        disagree++;
        if (disagree < 4) console.log(`   …the WORDING disagrees for ${JSON.stringify(c)}:\n      browser=${b.note}\n      server =${sv.note}`);
      }
    }
    t('I2 the studio and the server charge the SAME fee, and say the same words, on every case', () => {
      assert.strictEqual(disagree, 0);
    });
    t('I3 …over a battery big enough to mean something', () => assert.ok(CASES.length >= 500, CASES.length));

    /* I4-I6: THE RULE ITSELF, asserted on the BROWSER copy — so a mutation applied to BOTH copies
       (which the agreement check above would wave through) still fails. */
    t('I4 the studio charges the owner\'s own example correctly', () => {
      const b = mirror(100000, 0.0125, null, { minOrigFee: 2500 });
      assert.strictEqual(b.amount, 2500);
      assert.strictEqual(b.applied, true);
    });
    t('I5 the studio never floors an unsized deal', () => {
      assert.strictEqual(mirror(0, 0.0125, null, { minOrigFee: 2500 }).amount, 0);
    });
    t('I6 a typed 0 waives it in the studio too, and junk in the box falls through to the company number', () => {
      assert.strictEqual(mirror(100000, 0.0125, 0, { minOrigFee: 2500 }).amount, 1250, 'the waiver');
      assert.strictEqual(mirror(100000, 0.0125, 30000, { minOrigFee: 2500 }).amount, 2500, 'a decimal slip is refused');
    });
  }
}

/* ── J. THE SURFACES ────────────────────────────────────────────────────────────────────────────
   Folding an amount into a total is HALF a fee (the standing rule). The floor is folded into
   `origFee`, so every surface that PRINTS the origination row has to say when the stated rate is
   not the rate charged — otherwise the row contradicts itself ("Origination (1.25%)" beside
   $2,500.00 on a $60,000 loan).

   EACH SPREADSHEET TOKEN IS KEYED ON THAT COLUMN'S OWN DATA VARIABLE (`d`/`gd`/`sd`/`pd`), which is
   the fee-roster's own rule: the four columns are near-identical text told apart only by that
   variable, and a search for the words finds the Standard column and stops. */
{
  const TS = read('web/v2/tools/termsheet.js');
  const region = (from, to, what) => {
    const i = TS.search(from); assert.ok(i > -1, `region start not found: ${what}`);
    const j = TS.slice(i).search(to); assert.ok(j > -1, `region end not found: ${what}`);
    return TS.slice(i, i + j);
  };
  const SURFACES = [
    ['the studio structure screen', () => region(/\n  function recompute\(\) \{/, /\n  function validateAssign\(/, 'panel'), /origRowLabel\(d\)/],
    ['the spreadsheet — Standard column', () => region(/\n    var std = \[/, /\n    var gold;/, 'std'), /origRowLabel\(d\)/],
    ['the spreadsheet — Gold column', () => region(/\n    var gold;/, /\n    var silver;/, 'gold'), /origRowLabel\(gd\)/],
    ['the spreadsheet — Silver column', () => region(/\n    var silver;/, /\n    var speed;/, 'silver'), /origRowLabel\(sd\)/],
    ['the spreadsheet — Speed column', () => region(/\n    var speed;/, /\n  function /, 'speed'), /origRowLabel\(pd\)/],
    ['the term sheet PDF', () => region(/async function exportPdf\(/, /\n  function pctp\(/, 'pdf'), /origRowLabel\(d, "Origination fee"\)/],
    ['the Inputs & Loan Derivation page', () => region(/\n  function drawDerivationPage\(/, /\n  \/\* ===================== wiring/, 'deriv'), /d\.origMin/],
  ];
  for (const [what, src, token] of SURFACES) {
    t(`J: ${what} names the minimum when it binds`, () => {
      assert.ok(token.test(src()), `${what} must carry ${token}`);
    });
  }
  t('J8 no spreadsheet column can be satisfied by a neighbour\'s source', () => {
    const gold = region(/\n    var gold;/, /\n    var silver;/, 'gold');
    assert.ok(!/origRowLabel\(d\)/.test(gold), 'the Gold column must key on gd, never d');
  });
  t('J9 the staff Products & Pricing panel and the borrower\'s terms email name it too', () => {
    const panel = stripComments(read('app-v2/src/components/ProductStudioPanel.jsx'));
    assert.ok(/originationMinimum/.test(panel) && /minimum applied/.test(panel),
      'the staff panel must read the quote\'s explain block and say so');
    const email = stripComments(read('src/lib/product-registration.js'));
    assert.ok(/originationMinimum/.test(email) && /LABEL_MINIMUM/.test(email),
      'the borrower email must use the ONE label rather than restating the wording');
  });
  t('J10 the per-file box exists, is PRE-FILLED not pre-set, and rides the whole chain', () => {
    const html = read('web/v2/tools/term-sheet.html');
    assert.ok(/id="tsMinOrigFee"/.test(html), 'the admin-zone box must exist');
    const seed = stripComments(TS);
    assert.ok(/s\("tsMinOrigFee", String\(CO\.minOrigFee\)\)/.test(seed),
      'seeded as a PLACEHOLDER through s(), never written into e.value — the 2026-08-20 rule');
    assert.ok(/setVal\("tsMinOrigFee", ""\)/.test(seed), 'and cleared when the admin zone re-locks');
    const studio = stripComments(read('app-v2/src/components/TermSheetStudio.jsx'));
    assert.ok(/tsMinOrigFee: moneyVal\('tsMinOrigFee'\)/.test(studio), 'harvested into the snapshot');
    assert.ok(/put\('tsMinOrigFee', inp\.minOrigFee\)/.test(studio), 'and restored when a file is reopened');
    const bridge = stripComments(read('app-v2/src/components/ProductStudioPanel.jsx'));
    assert.ok(/minOrigFee: f\.tsMinOrigFee/.test(bridge), 'and sent to the server as minOrigFee');
  });
}

console.log(`\nmin-origination: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

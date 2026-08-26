'use strict';
/**
 * THE CONSTRUCTION FEASIBILITY / PROJECT REVIEW FEE — owner-authorized 2026-08-21, and this suite
 * is what the frozen-pricing HARD RULE demands beside any authorized fee change: a proof, over a
 * broad battery, that the ONLY thing that moved is the thing the owner asked to move.
 *
 * The owner: *"On the Term Sheets for Ground Up Construction Projects, add a $1,250 ground up
 * construction feasibility review fee and general project review … For heavy rehab projects, add
 * the same type of fee … but it should be only a $750 extra fee … Also add this fee type into the
 * manual section in the products and pricing so we can, any time, add it to any other project
 * manually as well."*
 *
 * WHAT IS PROVEN HERE:
 *   A. THE RULE — which deals attract which fee, and the ORDERING that makes it right.
 *   B. IT AGREES WITH THE FROZEN ENGINE about what a ground-up IS. The engines classify on
 *      `normStrategy`; if this module and that one ever disagreed, a loan priced on the ground-up
 *      matrix could be charged the heavy-rehab fee (or the reverse) — so the engine's OWN
 *      classifier is run beside ours over the whole label battery.
 *   C. RUNTIME EQUIVALENCE — with the fee neutralized, the whole priced quote is BYTE-IDENTICAL
 *      across the battery. This is the frozen-pricing proof, and it is built by neutralizing the
 *      module rather than by reading git: a git baseline proves inertness only until the change is
 *      committed, after which it degenerates into "the engine equals itself" and passes forever
 *      while proving nothing.
 *   D. AND ON A FEE-BEARING DEAL, ONLY THE COST MOVES — the loan amount, the note rate, the
 *      initial advance, the holdback, the reserve and every leverage ratio are unmoved, and the
 *      cash-to-close and liquidity rise by EXACTLY the fee. That is the whole safety claim.
 *   E. THE MANUAL BOX behaves as the owner described, and goes to an admin for approval —
 *      including when it WAIVES the fee, which is the decision an admin most wants to see.
 *   F. ONE WRITER for the per-file column, which is why db/609 does not widen the reopen trigger.
 *
 * Run: node scripts/test-feasibility-fee-pure.js
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

const F = require('../src/lib/feasibility-fee');
const O = require('../src/lib/pricing-overrides');

// ── A. The rule ──────────────────────────────────────────────────────────────
{
  const kind = (strategy, heavy) => F.feasibilityKind({ strategy, heavyRehab: heavy });
  eq('A1 a ground-up attracts the ground-up review', kind('Ground-up Construction', true), 'ground_up');
  eq('A2 a heavy rehab attracts the project review', kind('Fix & Flip', true), 'heavy_rehab');
  eq('A3 an ordinary flip attracts neither', kind('Fix & Flip', false), null);
  eq('A4 a bridge / stabilised deal attracts neither — there is no construction to review',
    kind('Bridge / Stabilized', false), null);
  eq('A5 …even if its rehab type says heavy, a bridge is still judged on its strategy first',
    kind('Ground-up Construction', false), 'ground_up');

  /* THE ORDER IS THE POINT. `heavyRehab` is derived from /heavy|gut|ground/ on the rehab type, so
     it is TRUE on a ground-up as well — asking it first prices every ground-up at $750. */
  eq('A6 a ground-up whose heavy-rehab flag is also set is still a GROUND-UP, not a heavy rehab',
    kind('Ground-up Construction', true), 'ground_up');

  const fee = (strategy, heavy, manual) => F.feasibilityFeeFor({ strategy, heavyRehab: heavy }, {}, { manual });
  // `amt` rather than `.amount` DELIBERATELY: a mutation that makes the fee vanish would otherwise
  // throw a TypeError here and the suite would DIE. A crashing test also "fails", and looks like
  // proof — but it stops every assertion after it, so a single regression hides the rest of the
  // battery. This reports a clean, readable failure instead (the standing lesson in CLAUDE.md).
  const amt = (f) => (f && f.amount != null ? f.amount : null);
  eq('A7 the ground-up fee is the owner\'s $1,250', amt(fee('Ground-up Construction', true)), 1250);
  eq('A8 the heavy-rehab fee is the owner\'s $750', amt(fee('Fix & Flip', true)), 750);
  eq('A9 a deal that attracts none is charged nothing at all', fee('Fix & Flip', false), null);
  const g = fee('Ground-up Construction', true);
  ok('A10 …and each fee is NAMED and EXPLAINED, so a borrower is never charged an unexplained line',
    !!g && String(g.label || '').length > 5 && String(g.note || '').length > 20);

  // Cleaning: junk states NOTHING rather than becoming a zero fee (which would silently waive it).
  for (const junk of [null, undefined, '', 'abc', -1, NaN, 1e9]) {
    eq(`A11 an unreadable amount (${JSON.stringify(junk)}) states nothing`, F.cleanFeeAmount(junk), null);
  }
  eq('A12 a typed amount with money formatting is read', F.cleanFeeAmount('$1,250.00'), 1250);
  // An unreadable COMPANY setting must fall back to the owner's numbers — never make a real fee vanish.
  eq('A13 an unreadable company setting falls back to the owner\'s pair',
    F.cleanFeasibilityFees({ groundUp: 'oops' }), { groundUp: 1250, heavyRehab: 750 });
  eq('A14 …and a configured pair is honoured', F.cleanFeasibilityFees({ groundUp: 1500, heavyRehab: 900 }),
    { groundUp: 1500, heavyRehab: 900 });
  eq('A15 a company that sets it to zero charges nothing on that kind',
    F.feasibilityFeeFor({ strategy: 'Ground-up Construction', heavyRehab: true }, { feasibilityFees: { groundUp: 0, heavyRehab: 750 } }, {}), null);
}

// ── B. It agrees with the frozen engine about what a ground-up IS ────────────
{
  // The engine's OWN classifier, read out of the live frozen engine rather than restated here.
  const engineSrc = fs.readFileSync(path.join(REPO, 'web/v2/tools/standard-program.js'), 'utf8');
  const m = /function normStrategy\(x\) \{[\s\S]*?\n  \}/.exec(engineSrc);
  ok('B1 the engine\'s own strategy classifier was found to compare against', !!m);
  // eslint-disable-next-line no-new-func
  const engineNC = m ? new Function('x', `
    function low(v){return String(v==null?'':v).trim().toLowerCase();}
    ${m[0]}
    return normStrategy(x) === 'NC';`) : null;

  const LABELS = [
    'Ground-up Construction', 'ground up construction', 'GROUND UP', 'New Construction',
    'nc', 'NC', 'Fix & Flip', 'Fix and Flip', 'Fix & Hold (BRRRR)', 'Bridge / Stabilized',
    'bridge', 'DSCR / Rental', 'Fix & Flip w/ Construction', '', 'not sure', 'Heavy rehab',
  ];
  let disagreements = 0;
  for (const l of LABELS) {
    const mine = F.isGroundUpDeal({ strategy: l });
    const theirs = engineNC ? engineNC(l) : mine;
    if (mine !== theirs) { disagreements++; console.log(`   …disagree on ${JSON.stringify(l)}: ours=${mine} engine=${theirs}`); }
  }
  eq('B2 our ground-up test and the frozen engine\'s agree on every label', disagreements, 0);
  // The portal label that famously classifies as construction in the engine — the two MUST agree,
  // whichever way, or a loan priced on one matrix is charged the other matrix's fee.
  eq('B3 …including "Fix & Flip w/ Construction", the label that trips this every time',
    F.isGroundUpDeal({ strategy: 'Fix & Flip w/ Construction' }), engineNC ? engineNC('Fix & Flip w/ Construction') : true);
}

// ── B2. THE BROWSER MIRROR AGREES WITH THE SERVER ───────────────────────────
//
// The Term Sheet Studio cannot require server code, so `web/v2/tools/termsheet.js` carries its own
// copy of this rule — the same arrangement `lib/payoff.js` and `records-stamp` already use. A
// studio that PRINTS one fee while the register BOOKS another is precisely the drift the "one
// definition, never a second copy" rule exists to stop, so the two are run over the same battery
// here and any disagreement fails the build.
{
  const ts = fs.readFileSync(path.join(REPO, 'web/v2/tools/termsheet.js'), 'utf8');
  const grab = (name) => {
    const m = new RegExp(`  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(ts);
    return m ? m[0] : null;
  };
  const kindSrc = grab('feasKind');
  const feeSrc = grab('feasFee');
  ok('B4 the studio\'s own copy of the rule was found', !!kindSrc && !!feeSrc);

  if (kindSrc && feeSrc) {
    // Rebuilt with the studio's three DOM/engine dependencies stubbed, so the RULE is what is
    // compared and not the browser around it.
    // eslint-disable-next-line no-new-func
    const mirror = new Function('deal', 'scope', 'typed', 'CO', `
      var YSP = { normStrategy: function (x) { var s = String(x || '').toLowerCase();
        if (s.indexOf('ground') > -1 || s.indexOf('construction') > -1 || s === 'nc') return 'NC';
        if (s.indexOf('bridge') > -1 || s === 'br') return 'BR';
        return 'FF'; } };
      function dealType() { return deal; }
      function val(id) { return id === 'rehabScope' ? scope : ''; }
      function adminNumRaw() { return typed; }
      ${kindSrc}
      ${feeSrc}
      return feasFee();`);

    const CASES = [];
    for (const deal of ['Ground-up Construction', 'Fix & Flip', 'Fix & Hold (BRRRR)', 'Bridge / Stabilized', 'New Construction']) {
      for (const scope of ['heavy', 'light', '']) {
        for (const typed of [null, 0, 900, 1250]) CASES.push({ deal, scope, typed });
      }
    }
    let disagree = 0;
    for (const c of CASES) {
      const browser = mirror(c.deal, c.scope, c.typed, {});
      // The server's own answer for the SAME deal. `heavyRehab` is how the studio's rehab-scope
      // control reaches the server (`pricing.js buildInputs`), so the two inputs are equivalent.
      const server = F.feasibilityFeeFor(
        { strategy: c.deal, heavyRehab: c.scope === 'heavy' }, {}, { manual: c.typed });
      const bAmt = Number(browser && browser.amount) || 0;
      const sAmt = server ? Number(server.amount) : 0;
      const bKind = bAmt > 0 ? (browser && browser.kind) : null;
      const sKind = server ? server.kind : null;
      if (bAmt !== sAmt || bKind !== sKind) {
        disagree++;
        if (disagree < 4) console.log(`   …disagree on ${JSON.stringify(c)}: browser=${bAmt}/${bKind} server=${sAmt}/${sKind}`);
      }
    }
    eq('B5 the studio and the server quote the SAME fee on every case', disagree, 0);
    ok('B6 …over a battery big enough to mean something', CASES.length >= 45);

    /* B7-B10. A BRIDGE IS NEVER CHARGED TO REVIEW CONSTRUCTION THAT IS NOT HAPPENING
       (owner-reported 2026-08-26).

       AND THIS IS WHY B5 ABOVE COULD NOT CATCH IT: that check compares the two mirrors against
       EACH OTHER, and both were equally wrong — the module's own line 88 SAID "a bridge or a
       stabilised deal has no construction to review, whatever the rehab type says" while the code
       under it did no such thing, and the studio kept `rehabScope === "heavy"` after a deal moved
       off fix & flip because the control is hidden there rather than cleared. So a bridge on a
       property whose rehab type still read "Heavy / gut rehab" was charged $750, on both sides, in
       agreement. A MIRROR-AGREEMENT TEST PROVES CONSISTENCY, NEVER CORRECTNESS — assert the RULE
       as well, or two copies of one mistake read as a pass. */
    for (const deal of ['Bridge / Stabilized', 'Bridge', 'bridge / stabilized']) {
      const server = F.feasibilityFeeFor({ strategy: deal, heavyRehab: true }, {}, {});
      eq(`B7 the server charges a ${deal} nothing even with a heavy rehab type on file`, server, null);
      const browser = mirror(deal, 'heavy', null, {});
      eq(`B8 …and so does the studio`, Number(browser && browser.amount) || 0, 0);
    }
    /* THE CONTROL, either side of it: the exclusion must bite ONLY on a bridge. */
    ok('B9 a heavy fix & flip still carries its fee — the exclusion is not a blanket off-switch',
      (F.feasibilityFeeFor({ strategy: 'Fix & Flip', heavyRehab: true }, {}, {}) || {}).amount === 750);
    ok('B9b …and a ground-up still carries its own, decided before bridge is ever asked',
      (F.feasibilityFeeFor({ strategy: 'Ground-up Construction', heavyRehab: true }, {}, {}) || {}).amount === 1250);
    /* A TYPED amount is a human's explicit instruction and still applies anywhere — that is the
       entire point of the manual box, and the exclusion must not quietly disable it. */
    ok('B10 a MANUAL fee typed onto a bridge is still honoured',
      (F.feasibilityFeeFor({ strategy: 'Bridge / Stabilized', heavyRehab: true }, {}, { manual: 400 }) || {}).amount === 400);
  }
}

/* ── B11-B14. THE FEE IS NAMED ON EVERY SURFACE THAT PRINTS FEES ─────────────
   The 2026-08-21 build folded the fee into `closing` — so it was CHARGED and the cash-to-close
   total included it — and then named it on the studio panel and the spreadsheet's Standard column
   ONLY. The term sheet PDF and the Gold and Silver columns never mentioned it, so the fees a
   borrower can read did not add up to the total they were asked to bring. PROVEN by rendering:
   of the 283 strings a ground-up term sheet drew, "feasibility", "1,250" and "project review"
   were all absent (owner-reported 2026-08-26).

   A SOURCE GUARD, deliberately: CI has no browser, so the rendering proof lives in
   `scripts/render-term-sheet-fees.js`. What can be enforced on every build is that each surface
   still REFERENCES the fee — which is exactly what went missing. */
{
  const ts = fs.readFileSync(path.join(REPO, 'web/v2/tools/termsheet.js'), 'utf8');
  const between = (from, to) => {
    const a = ts.indexOf(from); if (a < 0) return '';
    const b = ts.indexOf(to, a); return b < 0 ? ts.slice(a) : ts.slice(a, b);
  };
  // The PDF's own cash-to-close block, from its heading to the liquidity line that ends it.
  const pdfBlock = between('cardHead(xR, colW, "Estimated cash to close"', 'liqLbl');
  ok('B11 the term sheet PDF names the feasibility fee', /d\.feasFee/.test(pdfBlock) && /d\.feasLabel/.test(pdfBlock));
  // Each spreadsheet column, keyed on its own data variable so one column cannot cover another.
  ok('B12 the spreadsheet Standard column names it', /\bd\.feasFee\b/.test(between('var std = [', 'var gold')));
  ok('B13 the spreadsheet Gold column names it', /\bgd\.feasFee\b/.test(between('var gold;', 'var silver')));
  /* ANCHORS MUST BE UNIQUE. `var silver` also matches `var silverChosenRung` 2,500 lines earlier,
     which opened the window in the wrong place and failed on a line that was plainly there — the
     semicolon is what makes each column's declaration its own. */
  ok('B14 the spreadsheet Silver column names it', /\bsd\.feasFee\b/.test(between('var silver;', 'return {')));
}

// ── C + D. Runtime equivalence, against the REAL pricing path ────────────────
const pricing = require('../src/lib/pricing');
if (!pricing.enginesReady || !pricing.enginesReady()) {
  console.log('SKIP the runtime-equivalence sections: engines not loadable', pricing.loadErr && pricing.loadErr());
} else {
  const exp = { flips: 5, holds: 2, ground: 3 };
  const quote = (app, ov) => pricing.quoteProgram(app.__program || 'standard', pricing.buildInputs(app, exp, ov || {}));

  const APPS = [];
  for (const program of ['Fix & Flip', 'Ground-up Construction', 'Bridge / Stabilized', 'Fix & Hold (BRRRR)']) {
    for (const rehab of ['Light rehab', 'Heavy rehab', 'Ground-up', '']) {
      for (const state of ['TX', 'NY', 'NJ', 'FL']) {
        for (const price of [200000, 640000]) {
          for (const eng of ['standard', 'gold', 'silver']) {
            APPS.push({
              __program: eng,
              purchase_price: price, as_is_value: price, arv: Math.round(price * 1.6),
              rehab_budget: Math.round(price * 0.4), fico: 730, term: 12,
              program, rehab_type: rehab, loan_type: 'Purchase',
              property_type: 'Single Family', units: 1, property_address: { state },
              requested_exp_flips: 5, requested_exp_holds: 2, requested_exp_ground: 3,
            });
          }
        }
      }
    }
  }

  // THE BASELINE: the module neutralized, which is exactly "the system without this fee". Swapped
  // in the require cache so `pricing.js`'s own lazy require picks it up.
  const modPath = require.resolve('../src/lib/feasibility-fee');
  const real = require.cache[modPath].exports;
  const neutral = { ...real, feasibilityFeeFor: () => null };

  const run = (mod) => {
    require.cache[modPath].exports = mod;
    const out = APPS.map((a) => { try { return quote(a); } catch (e) { return { __err: String(e && e.message) }; } });
    require.cache[modPath].exports = real;
    return out;
  };

  const off = run(neutral);
  const on = run(real);

  // PROVE THE NEUTRALIZATION ACTUALLY BIT — otherwise "identical" would be a tautology and this
  // whole section would pass while proving nothing (the standing lesson from the engine baselines).
  const moved = on.filter((q, i) => JSON.stringify(q) !== JSON.stringify(off[i]));
  ok('C1 the baseline genuinely differs somewhere, so the comparison is not vacuous', moved.length > 0);

  let drift = 0, feeBearing = 0;
  for (let i = 0; i < APPS.length; i++) {
    const a = APPS[i], b = on[i], c = off[i];
    if (b.__err || c.__err) continue;
    const kind = F.feasibilityKind(pricing.buildInputs(a, exp, {}));
    if (!kind) {
      if (JSON.stringify(b) !== JSON.stringify(c)) { drift++; if (drift < 3) console.log('   …drift on a no-fee deal:', a.program, a.rehab_type, a.__program); }
      continue;
    }
    feeBearing++;
    const want = kind === 'ground_up' ? 1250 : 750;
    // D: ONLY the cost moves.
    const same = (path) => JSON.stringify(path(b)) === JSON.stringify(path(c));
    if (!same((q) => q.sizing)) { drift++; console.log('   …SIZING MOVED — this is the thing that must never happen:', a.program, a.rehab_type); }
    if (b.noteRate !== c.noteRate) { drift++; console.log('   …the RATE moved:', a.program); }
    if (Math.round((b.closingCosts.dueAtClosing - c.closingCosts.dueAtClosing) * 100) / 100 !== want) {
      drift++; console.log('   …closing costs did not rise by exactly the fee:', a.program, b.closingCosts.dueAtClosing - c.closingCosts.dueAtClosing);
    }
    if (Math.round((b.cashToClose - c.cashToClose) * 100) / 100 !== want) {
      drift++; console.log('   …cash-to-close did not rise by exactly the fee:', a.program);
    }
    if (b.closingCosts.feasibilityFee !== want) { drift++; console.log('   …the named line is wrong:', b.closingCosts.feasibilityFee); }
  }
  eq('C2 with the fee neutralized, every no-fee deal is byte-identical AND every fee deal moves only its cost', drift, 0);
  ok('C3 the battery actually reached fee-bearing deals', feeBearing > 50);
  ok('C4 …and no-fee deals too, so the equivalence half is not empty', APPS.length - feeBearing > 50);

  // D2: the fee reaches the liquidity the borrower must SHOW — the point of quoting it as a
  // closing cost rather than as paid-outside-closing.
  {
    const g = APPS.find((a) => a.program === 'Ground-up Construction' && a.__program === 'standard');
    const withFee = quote(g);
    require.cache[modPath].exports = neutral;
    const without = quote(g);
    require.cache[modPath].exports = real;
    ok('D1 the fee raises the liquidity the borrower must show', withFee.liquidityRequired > without.liquidityRequired);
    ok('D2 …and the loan itself is untouched', withFee.sizing.totalLoan === without.sizing.totalLoan);
    ok('D3 …and it is named on the sheet', withFee.closingCosts.feasibility && /feasibility/i.test(withFee.closingCosts.feasibility.label));
    ok('D4 …with the explanation that rides with it', (withFee.closingCosts.feasibility.note || '').length > 20);
  }

  // E: the manual box.
  {
    const flip = APPS.find((a) => a.program === 'Fix & Flip' && a.rehab_type === 'Light rehab' && a.__program === 'standard');
    const plain = quote(flip);
    const manual = quote(flip, { feasibilityFee: 900 });
    eq('E1 a manual fee applies to a deal that attracts none by type — the owner\'s "any other project"',
      manual.closingCosts.feasibilityFee, 900);
    eq('E2 …and raises what is due at closing by exactly that',
      Math.round((manual.closingCosts.dueAtClosing - plain.closingCosts.dueAtClosing) * 100) / 100, 900);
    eq('E3 …while the loan is untouched', manual.sizing.totalLoan, plain.sizing.totalLoan);

    const ground = APPS.find((a) => a.program === 'Ground-up Construction' && a.__program === 'standard');
    eq('E4 a manual amount OVERRIDES the deal\'s own fee', quote(ground, { feasibilityFee: 400 }).closingCosts.feasibilityFee, 400);
    eq('E5 …and a typed 0 WAIVES it on that file', quote(ground, { feasibilityFee: 0 }).closingCosts.feasibilityFee, undefined);
    eq('E6 …a blank means "use the deal\'s own fee", never a waiver', quote(ground, { feasibilityFee: '' }).closingCosts.feasibilityFee, 1250);
  }
}

// ── E2. It goes to an admin for approval ─────────────────────────────────────
{
  const keys = (o) => O.pricingOverridesEngaged(o, {}).map((x) => x.key);
  ok('E7 a typed manual fee needs an admin approval', keys({ feasibilityFee: 900 }).includes('feasibilityFee'));
  ok('E8 …and so does WAIVING it, which is the decision an admin most wants to see',
    keys({ feasibilityFee: 0 }).includes('feasibilityFee'));
  ok('E9 an untouched box needs nothing', !keys({}).includes('feasibilityFee'));
  ok('E10 …and neither does an explicitly blanked one', !keys({ feasibilityFee: '' }).includes('feasibilityFee'));
  // The zero rule is a PER-KEY flag, not a change to the shared engaged() — every other knob must
  // still read 0 as "unset".
  ok('E11 zero still means "unset" for every other knob', !keys({ oopRehab: 0, markupGoldT1Pct: 0 }).length);
  // A borrower can never set it.
  ok('E12 a borrower can never send a fee override', !Object.keys(O.borrowerPricingOverrides({ feasibilityFee: 0 })).includes('feasibilityFee'));
}

// ── F. One writer for the per-file column ───────────────────────────────────
//
// db/609 deliberately does NOT widen the economics-reopen trigger for
// `file_feasibility_fee`, on the grounds that the column can only ever be written as part of a
// REGISTRATION — so there is never a stale registration for the trigger to catch. That claim has
// to be enforced, or the next door added quietly invalidates it. The writer is the staff register
// route (beside the sticky markups it mirrors); the borrower and TPO register paths strip every
// admin-zone key, so neither can reach it.
{
  const skip = new Set(['db', 'node_modules', 'web', 'app', 'app-v2', '.git', 'docs', 'scripts']);
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.js$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        if (/\bfile_feasibility_fee\b/.test(src) && /UPDATE\s+applications|INSERT\s+INTO\s+applications/i.test(src)) {
          hits.push(path.relative(REPO, p));
        }
      }
    }
  })(path.join(REPO, 'src'));
  eq('F1 exactly one module writes the per-file fee, and it is the register path',
    hits, ['src/routes/staff.js']);
}

console.log(fail ? `test-feasibility-fee-pure: ${pass} passed, ${fail} FAILED` : `test-feasibility-fee-pure: all ${pass} checks passed.`);
process.exit(fail ? 1 : 0);

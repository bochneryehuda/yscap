#!/usr/bin/env node
'use strict';
/**
 * LT PPE - A REASONED OVERRIDE MUST NOT BE SCORED AS A BUG.
 *
 * OFFLINE: pure. No database, no vendor call.
 *
 * THE MECHANISM, WHICH IS THE WHOLE RISK. `parity.normalizeOurQuote` returns `{eligible, rungs}` and
 * DROPS `declines[]`. `compareScenario` needs those declines to tell two very different things apart
 * when our engine says ineligible and Lender Price says eligible:
 *
 *   - we declined for a reason we CHOSE to hold (an overlay fact LP does not read) -> OVERLAY,
 *     an intentional override, correctly not counted against the sheet;
 *   - we declined for any other reason -> ELIGIBILITY, a real disagreement.
 *
 * So a caller that loses the declines turns every reasoned override into a **phantom defect**. That is
 * the §2.70 class again: a phantom disagreement is indistinguishable from a real one on the scoreboard,
 * so it does not read as "we measured this badly", it reads as "our sheet is off" — and it drags the
 * agreement rate the go-live gate reads. The failure is silent and one-directional.
 *
 * MEASURED 2026-08-18: both production callers do pass them, so nothing is broken. This suite exists so
 * that stays true, and because one avoidable way to get it wrong was removed in the same pass —
 * `compareScenario` now falls back to the declines on a RAW quote it was handed, which is exactly the
 * shape `shadow.js` passes.
 */
const path = require('path');
const fs = require('fs');

const PPE = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const parity = require(path.join(PPE, 'parity'));
const overlay = require(path.join(PPE, 'overlay'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// An overlay-only decline: a reason WE hold that Lender Price does not read.
//
// BUILT WITH THE REAL BUILDER, never hand-rolled. The first cut of this suite invented the shape
// (`{ overlayDecline: true }`) and three assertions failed against a contract that is actually
// `{ overlay: true, fact: <an overlay-only fact>, reason: <text> }`. A fixture that spells the shape
// itself is a second copy of the contract, and it drifts — using `overlay.overlayDecline` means this
// suite cannot pass on a record the classifier would reject.
const OVERLAY_DECLINE = [overlay.overlayDecline('short_term_rental', 'Short-Term Rental — Max LTV 75%', { code: 'dhvn_str_max_ltv' })];
const REAL_DECLINE = [{ code: 'dhvn_min_fico', reason: 'FICO below the program minimum' }];

const OURS_INELIGIBLE = { eligible: false, ladder: [] };
const THEIRS_ELIGIBLE = { eligible: true, rungs: [{ rate: 7.5, priceMilli: 101000 }] };

// ---------------------------------------------------------------------------
// A - the classification itself, both ways round.
// ---------------------------------------------------------------------------
{
  const withDeclines = parity.compareScenario(OURS_INELIGIBLE, THEIRS_ELIGIBLE, { ourDeclines: OVERLAY_DECLINE });
  eq(withDeclines.overlay, true, 'A1 an overlay-only decline against an eligible LP is scored as an OVERRIDE');
  ok(!withDeclines.agree, 'A2 …still a difference, just not a defect');

  const realOne = parity.compareScenario(OURS_INELIGIBLE, THEIRS_ELIGIBLE, { ourDeclines: REAL_DECLINE });
  ok(!realOne.overlay, 'A3 an ordinary decline is NOT an override — it is a real eligibility disagreement');

  // THE FAILURE THIS GUARDS: with the declines lost, the SAME override reads as a plain mismatch.
  const lost = parity.compareScenario({ eligible: false, rungs: [] }, THEIRS_ELIGIBLE, {});
  ok(!lost.overlay,
    'A4 with no declines anywhere the same divergence is a plain mismatch — which is exactly the phantom defect a caller creates by dropping them');
}

// ---------------------------------------------------------------------------
// B - THE FALLBACK: a RAW quote carries its own declines, so handing one over is enough.
// ---------------------------------------------------------------------------
{
  const rawWithDeclines = { eligible: false, ladder: [], declines: OVERLAY_DECLINE };
  const r = parity.compareScenario(rawWithDeclines, THEIRS_ELIGIBLE, {});
  eq(r.overlay, true,
    'B1 a raw quote\'s own declines are read when the caller did not separate them out — the option is no longer forgettable for a caller passing the quote');

  const rawReal = { eligible: false, ladder: [], declines: REAL_DECLINE };
  ok(!parity.compareScenario(rawReal, THEIRS_ELIGIBLE, {}).overlay,
    'B2 …and the fallback classifies, it does not just wave things through');

  // THE EXPLICIT OPTION STILL WINS. `facade.js` passes an already-NORMALIZED ladder, by which point the
  // declines are genuinely gone and only the caller has them — so the option can never become optional.
  const conflict = parity.compareScenario(
    { eligible: false, ladder: [], declines: REAL_DECLINE },   // the quote says: ordinary decline
    THEIRS_ELIGIBLE,
    { ourDeclines: OVERLAY_DECLINE },                          // the caller says: overlay
  );
  eq(conflict.overlay, true, 'B3 an explicitly-passed set WINS over the quote\'s own — the caller is the authority');

  // AN EMPTY ARRAY MEANS "NO DECLINES", NOT "GO LOOKING". Treating [] as absent would let the fallback
  // overrule a caller who deliberately said there were none.
  const emptyExplicit = parity.compareScenario(
    { eligible: false, ladder: [], declines: OVERLAY_DECLINE },
    THEIRS_ELIGIBLE,
    { ourDeclines: [] },
  );
  ok(!emptyExplicit.overlay, 'B4 an explicit empty list means there are none — the fallback does not overrule it');
}

// ---------------------------------------------------------------------------
// C - NOTHING ELSE MOVED. The fallback may only ever fire on the eligibility branch, and only when the
//     two sides disagree about eligibility at all.
// ---------------------------------------------------------------------------
{
  const bothEligible = parity.compareScenario(
    { eligible: true, ladder: [{ rate: 7.5, finalPriceMilli: 101000 }], declines: OVERLAY_DECLINE },
    THEIRS_ELIGIBLE, {},
  );
  ok(!bothEligible.overlay && bothEligible.agree,
    'C1 when both say eligible and the prices match, a stray declines[] changes nothing');

  const bothIneligible = parity.compareScenario(
    { eligible: false, ladder: [], declines: OVERLAY_DECLINE },
    { eligible: false, rungs: [] }, {},
  );
  ok(!bothIneligible.overlay && bothIneligible.agree,
    'C2 when BOTH say ineligible they agree — an override needs a disagreement to be an override');

  // Junk in declines must never throw: this sits on the comparison path of a paid battery.
  let threw = false;
  for (const junk of [{ declines: 'nope' }, { declines: [null] }, { declines: [{}] }, { declines: {} }]) {
    try { parity.compareScenario({ eligible: false, ladder: [], ...junk }, THEIRS_ELIGIBLE, {}); }
    catch (_) { threw = true; }
  }
  ok(!threw, 'C3 malformed declines never throw — this runs inside a paid battery');
}

// ---------------------------------------------------------------------------
// D - EVERY PRODUCTION CALLER SUPPLIES THEM, one way or the other. A source guard, because no unit test
//     of the comparator can see who calls it.
// ---------------------------------------------------------------------------
{
  const LT = path.join(__dirname, '..', 'src', 'longterm');
  const callers = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/\bcompareScenario\(/.test(src) && !p.endsWith(`${path.sep}parity.js`)) callers.push([p, src]);
    }
  };
  walk(LT);

  ok(callers.length > 0, 'D1 the comparator has production callers to check');

  // ⛔ THE CHECK IS ON THE CALL, NOT ON THE FILE. The first cut asked whether the word `ourDeclines`
  // appeared anywhere in the source, and TWO mutations survived it: blanking the value
  // (`const ourDeclines = undefined`) and renaming the binding both leave the word present elsewhere in
  // the file. "The file mentions it" is not "the call passes it" — the same over-loose matching this
  // repo has been bitten by before. So each call's own argument text is extracted and inspected.
  let calls = 0;
  for (const [p, src] of callers) {
    const rel = path.relative(LT, p);
    for (const m of src.matchAll(/compareScenario\(([\s\S]{0,400}?)\);/g)) {
      calls += 1;
      const args = m[1];
      ok(/ourDeclines/.test(args),
        `D2 ${rel} passes our declines IN THE CALL to compareScenario — without them a reasoned override is scored as a defect and drags the agreement rate`);

      // And the value must not be a constant nothing. `undefined` reads as "the caller has none",
      // which is exactly the silent loss this guards.
      ok(!/ourDeclines:\s*(undefined|null)\b/.test(args),
        `D2b ${rel} passes a real declines value, not a hard-coded undefined/null`);
    }
    // A blanked binding is the other half of the same mutation, and it is invisible at the call site
    // because the shorthand `{ ourDeclines }` still reads correctly.
    ok(!/const\s+ourDeclines\s*=\s*(undefined|null)\s*;/.test(src),
      `D2c ${rel} does not bind ourDeclines to a constant nothing before passing it`);
  }
  ok(calls > 0, 'D3 the call sites were actually found and inspected — a regex that matched nothing would pass every check above');
}

console.log(failures.length
  ? `FAIL - lt ppe overlay declines reach (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
  : `ok - lt ppe overlay declines reach (${pass} assertions)`);
process.exit(failures.length ? 1 : 0);

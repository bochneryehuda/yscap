/**
 * SILVER: the voluntary ARV de-leverage lever (`targetARLTV`) — owner-directed
 * 2026-08-06. PURE, no DB, no network.
 *
 * EMCAP prices on BOTH frontiers (every rate block is 3 AR x 3 FICO x 6 LTC), so a
 * borrower can earn a better cell by giving up ARV leverage exactly as they can by
 * giving up cost leverage. Until now only the cost side had a lever.
 *
 * This engine is FROZEN, so the bar is not "the new lever works" — it is:
 *
 *   A. INERT WHEN UNSET. With no targetARLTV the engine's output must be
 *      byte-identical to the pre-change engine, over a broad scenario matrix.
 *      The baseline is read from git (HEAD's committed copy), so this proof
 *      re-runs in CI forever, not just on the day it was written.
 *   B. IT CAN ONLY EVER REDUCE. A set lever may never produce a LARGER loan than
 *      the same scenario with no lever — it is a MIN on a ceiling, and that must
 *      hold across the matrix, not just in principle.
 *   C. IT ACTUALLY BITES. At a real AR band edge it lowers the loan and the
 *      achieved ARV ratio lands at or under the requested ceiling.
 *   D. IT PRICES ON BOTH BANDS. Cutting the ARV shrinks the loan, which moves the
 *      LTC ratio too — the owner's "calculate the pricing of both of them". So a
 *      cut must be able to change the LTC band as well, not only the ARV band.
 *   E. AN ADMIN OVERRIDE STILL WINS (ovrARLTV), exactly as it does for LTC.
 *   F. THE REHAB STAYS FINANCED — a cut takes from the INITIAL advance, which is
 *      the owner's stated concept ("if it's capping something, it should cap the
 *      initial").
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const LIVE = require('../web/v2/tools/silver-program.js');

/** HEAD's committed engine, loaded from git so the equivalence proof is permanent. */
function baselineEngine() {
  const src = execFileSync('git', ['show', 'HEAD:yscap-repo-root_8/web/v2/tools/silver-program.js'], {
    cwd: path.join(__dirname, '..', '..'), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
  });
  // Written BESIDE the live engine, not in a temp dir: it `require`s siblings
  // (./standard-program.js) by relative path, which only resolve from that folder.
  // Dot-prefixed so it is never mistaken for a real engine copy, and removed in a
  // finally so a failed run cannot leave one behind for test-engine-copies-match.
  const tmp = path.join(__dirname, '..', 'web/v2/tools', `.silver-baseline-${process.pid}.js`);
  fs.writeFileSync(tmp, src);
  try { return require(tmp); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

/** A broad, deterministic scenario matrix — the shape the engine actually takes. */
function scenarios() {
  const out = [];
  const states = ['NJ', 'PA', 'FL', 'TX', 'OH'];
  const strategies = ['Fix & Flip', 'Fix & Hold (BRRRR)', 'Ground-up Construction'];
  const ficos = [640, 660, 700, 740, 780];
  const terms = [12, 18, 24];
  for (const state of states) {
    for (const strategy of strategies) {
      for (const fico of ficos) {
        for (const term of terms) {
          for (const arv of [400000, 600000, 900000]) {
            for (const rehab of [0, 60000, 150000]) {
              for (const exp of [0, 2, 6, 12]) {
                out.push({
                  loanType: 'Purchase', strategy, state,
                  propertyType: 'SFR (1 unit)', units: 1,
                  purchasePrice: Math.round(arv * 0.62), asIsValue: Math.round(arv * 0.62),
                  arv, rehabBudget: rehab, fico, term, irMonths: 0,
                  expFlips: exp, expHolds: 0, expGround: exp,
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** Everything worth comparing — the priced result, not a summary. */
function shape(ev) {
  if (!ev) return null;
  const s = ev.sizing || {};
  return JSON.stringify({
    status: ev.status, noteRate: ev.noteRate,
    totalLoan: s.totalLoan, acquisition: s.acquisition, rehabLoan: s.rehabLoan,
    downPayment: s.downPayment, ltcPct: s.ltcPct, binding: s.binding,
    cashToClose: ev.cashToClose, liquidityRequired: ev.liquidityRequired,
    reserveRequirement: ev.reserveRequirement, origination: ev.origination,
    reasons: (ev.reasons || []).map((r) => `${r.level}:${r.msg}`),
  });
}

const BASE = baselineEngine();
const CASES = scenarios();
console.log(`scenario matrix: ${CASES.length} cases\n`);

// ---- A. INERT WHEN UNSET — byte-identical to the pre-change engine -------------
let drift = 0, firstDrift = null, priced = 0;
for (const c of CASES) {
  const a = shape(BASE.evaluate(c));
  const b = shape(LIVE.evaluate(c));
  if (a !== b) { drift++; if (!firstDrift) firstDrift = { c, a, b }; }
  const ev = LIVE.evaluate(c);
  if (ev && ev.sizing && ev.sizing.totalLoan > 0) priced++;
}
assert(drift === 0,
  `A1 with the lever UNSET the engine is byte-identical to HEAD over ${CASES.length} scenarios (drift: ${drift})`);
if (firstDrift) console.log('    first drift:', JSON.stringify(firstDrift.c), '\n    was:', firstDrift.a, '\n    now:', firstDrift.b);
assert(priced > CASES.length * 0.2,
  `A2 the matrix is meaningful — ${priced} of ${CASES.length} scenarios actually price (not a matrix of dead cases)`);

// An explicit 0 / null must read as "no lever", never as "cap at zero".
let zeroDrift = 0;
for (const c of CASES) {
  for (const v of [0, null, undefined, '']) {
    if (shape(LIVE.evaluate(Object.assign({}, c, { targetARLTV: v }))) !== shape(BASE.evaluate(c))) zeroDrift++;
  }
}
assert(zeroDrift === 0, `A3 a 0 / null / blank lever is "no lever", never a zero cap (drift: ${zeroDrift})`);

// ---- B/C/D/F — the lever's behaviour across the matrix -------------------------
const AR_RUNGS = [0.75, 0.70, 0.65];
let grew = 0, bit = 0, overCeiling = 0, rehabShrank = 0, ltcMoved = 0, checked = 0;
for (const c of CASES) {
  const full = LIVE.evaluate(c);
  const fs_ = full && full.sizing;
  if (!fs_ || !(fs_.totalLoan > 0) || !(c.arv > 0)) continue;
  for (const rung of AR_RUNGS) {
    const cut = LIVE.evaluate(Object.assign({}, c, { targetARLTV: rung }));
    const cs = cut && cut.sizing;
    if (!cs || !(cs.totalLoan > 0)) continue;
    checked++;
    if (cs.totalLoan > fs_.totalLoan + 1e-6) grew++;                       // B
    if (cs.totalLoan < fs_.totalLoan - 1) {
      bit++;                                                                // C
      if (cs.totalLoan / c.arv > rung + 1e-6) overCeiling++;                // C
      if (cs.rehabLoan < fs_.rehabLoan - 1) rehabShrank++;                  // F
      if (Math.abs((cs.ltcPct || 0) - (fs_.ltcPct || 0)) > 1e-6) ltcMoved++; // D
    }
  }
}
assert(checked > 0, `B0 the lever was exercised on ${checked} priced scenario/rung pairs`);
assert(grew === 0, `B1 a set lever NEVER produces a larger loan than no lever (violations: ${grew})`);
assert(bit > 0, `C1 the lever genuinely bites — ${bit} pairs sized smaller`);
assert(overCeiling === 0, `C2 …and the achieved ARV ratio never exceeds the requested ceiling (violations: ${overCeiling})`);
assert(rehabShrank === 0, `F1 a cut never shrinks the financed rehab — it comes off the INITIAL (violations: ${rehabShrank})`);
assert(ltcMoved > 0, `D1 an ARV cut moves the LTC ratio too, so both bands re-price (${ltcMoved} pairs)`);

// ---- E. An admin basis override still wins ------------------------------------
{
  const c = CASES.find((x) => { const e = LIVE.evaluate(x); return e && e.sizing && e.sizing.totalLoan > 0; });
  const withOvr = LIVE.evaluate(Object.assign({}, c, { targetARLTV: 0.65, ovrARLTV: 0.75 }));
  const ovrOnly = LIVE.evaluate(Object.assign({}, c, { ovrARLTV: 0.75 }));
  assert(shape(withOvr) === shape(ovrOnly),
    'E1 an ADMIN ovrARLTV still wins over the voluntary lever, exactly as it does for LTC');
}

// ---- The two engine copies stay identical (the frozen-copies rule) -------------
{
  const a = fs.readFileSync(path.join(__dirname, '..', 'web/v2/tools/silver-program.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'web/tools/silver-program.js'), 'utf8');
  assert(a === b, 'G1 both Silver engine copies carry the lever and remain byte-identical');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);

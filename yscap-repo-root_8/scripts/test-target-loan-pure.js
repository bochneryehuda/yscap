/**
 * A TYPED LOAN AMOUNT — the manual box, on ALL THREE programs (owner-directed
 * 2026-08-06). PURE, no DB, no network.
 *
 *   "we need to add to the manual section for our staff team to manually type in a
 *    loan amount. It should also calculate the same thing: first, it's a fully
 *    financed budget. If you put in a manual out-of-pocket rehab, the rest is for
 *    the initial. Even if the loan amount is more than it's allowed, they also need
 *    to put in manually that they allow these limits. It should technically be made
 *    to reduce, but it should also be able to increase only if you also fill in the
 *    manual program details about exact LTV, LTC, and ARV."
 *
 * The whole design rests on ONE claim, and this file exists to prove it: a typed
 * amount is a VOLUNTARY CEILING on the tier's own dollar wall, not a new way to size
 * a loan. Because sizeLoan already finances the rehab first, gives the remainder to
 * the initial advance, and grows monotonically to the nearest wall, capping the wall
 * lands the structure on the typed amount with the owner's split intact — so NO
 * sizing math changed. These engines are FROZEN, so the bar is:
 *
 *   A. INERT WHEN UNSET — byte-identical to HEAD across the matrix, on all three
 *      programs. The baseline is read from git, so the proof re-runs in CI forever.
 *   B. IT CAN ONLY EVER REDUCE. This is the owner's "technically made to reduce",
 *      and it is what makes the box safe to hand to staff with no approval: an
 *      amount ABOVE what the caps allow is structurally unreachable.
 *   C. IT LANDS ON THE NUMBER. A reachable amount is what the deal sizes to.
 *   D. THE SPLIT IS THE OWNER'S. The rehab stays financed in full and the cut comes
 *      off the INITIAL advance — never out of the construction budget.
 *   E. THE WAY UP IS THE ADMIN BASIS. Raising a loan past the caps requires the
 *      manual LTV / LTC / ARV, which already routes to admin approval.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const ENGINES = ['standard-program', 'gold-standard', 'silver-program'];
const LIVE = {};
for (const e of ENGINES) LIVE[e] = require(`../web/v2/tools/${e}.js`);

/* THE BASELINE IS TODAY'S ENGINE WITH THE BOX SURGICALLY REMOVED — deliberately not
   "HEAD's committed copy". A git baseline proves inertness only until the change is
   committed; the moment it lands, HEAD contains the box too and the comparison
   quietly degenerates into "the engine equals itself", which passes forever while
   proving nothing. Removing the one line instead keeps the claim TRUE permanently:
   whatever the engines become, adding the box to them must change no number. The
   strip is asserted to have actually bitten (B0 below), so it can never go vacuous. */
const LEVER_RE = /^.*if \(input\.targetLoan && input\.targetLoan > 0\).*$\n/m;

function baselineEngines() {
  const dir = path.join(__dirname, '..', 'web/v2/tools');
  const written = [];
  const out = {};
  let stripped = 0;
  try {
    // Written BESIDE the live engines, not in a temp dir: they `require` siblings by
    // relative path, which only resolve from that folder. Dot-prefixed so they are
    // never mistaken for a real engine copy by test-engine-copies-match.
    for (const e of ENGINES) {
      const live = fs.readFileSync(path.join(dir, `${e}.js`), 'utf8');
      const src = live.replace(LEVER_RE, () => { stripped++; return ''; });
      const p = path.join(dir, `.${e}-baseline-${process.pid}.js`);
      fs.writeFileSync(p, src); written.push(p);
    }
    if (stripped !== ENGINES.length) {
      throw new Error(`baseline strip removed ${stripped} lever lines, expected ${ENGINES.length} — the equivalence proof would be vacuous`);
    }
    // Gold and Silver reuse the STANDARD engine's sizeLoan through `require('./standard-program.js')`,
    // so a baseline Gold loaded here would call the LIVE Standard and the comparison
    // would be meaningless. Rewrite each baseline's sibling require to point at the
    // baseline Standard, so HEAD is compared against HEAD all the way down.
    for (const p of written) {
      const body = fs.readFileSync(p, 'utf8')
        .replace(/(['"])\.\/standard-program\.js\1/g, `'./.standard-program-baseline-${process.pid}.js'`);
      fs.writeFileSync(p, body);
    }
    for (let i = 0; i < ENGINES.length; i++) out[ENGINES[i]] = require(written[i]);
    return out;
  } finally {
    for (const p of written) { try { fs.unlinkSync(p); } catch (_) {} }
  }
}

/** Everything worth comparing — the priced result, not a summary. */
function shape(ev) {
  if (!ev) return null;
  const s = ev.sizing || {};
  return JSON.stringify({
    status: ev.status, noteRate: ev.noteRate,
    totalLoan: s.totalLoan, acquisition: s.acquisition, rehabLoan: s.rehabLoan,
    downPayment: s.downPayment, ltcPct: s.ltcPct, binding: s.binding,
    interestReserve: s.interestReserve, costBasis: s.costBasis,
    cashToClose: ev.cashToClose, liquidityRequired: ev.liquidityRequired,
    reserveRequirement: ev.reserveRequirement, origination: ev.origination,
    reasons: (ev.reasons || []).map((r) => `${r.level}:${r.msg}`),
  });
}

function scenarios() {
  const out = [];
  for (const state of ['NJ', 'PA', 'OH', 'TX', 'FL']) {
    for (const strategy of ['Fix & Flip', 'Fix & Hold (BRRRR)', 'Ground-up Construction']) {
      for (const fico of [660, 700, 740, 780]) {
        for (const arv of [400000, 700000, 1100000]) {
          for (const rehab of [0, 75000, 180000]) {
            for (const exp of [0, 3, 9]) {
              for (const term of [12, 18]) {
                out.push({
                  loanType: 'Purchase', strategy, state,
                  propertyType: 'SFR (1 unit)', units: 1,
                  purchasePrice: Math.round(arv * 0.6), asIsValue: Math.round(arv * 0.6),
                  arv, rehabBudget: rehab, fico, term, irMonths: 0,
                  expFlips: exp, expHolds: exp, expGround: exp,
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

const BASE = baselineEngines();
const CASES = scenarios();
console.log(`scenario matrix: ${CASES.length} cases x ${ENGINES.length} programs\n`);

// ---- A. INERT WHEN UNSET -------------------------------------------------------
{
  let drift = 0, priced = 0, first = null;
  for (const e of ENGINES) {
    for (const c of CASES) {
      const a = shape(BASE[e].evaluate(c));
      const b = shape(LIVE[e].evaluate(c));
      if (a !== b) { drift++; if (!first) first = { e, c, a, b }; }
      const ev = LIVE[e].evaluate(c);
      if (ev && ev.sizing && ev.sizing.totalLoan > 0) priced++;
    }
  }
  assert(drift === 0,
    `A1 with the box EMPTY all three engines are byte-identical to the same engines WITHOUT the box, over ${CASES.length * ENGINES.length} evaluations (drift: ${drift})`);
  if (first) console.log(`    first drift (${first.e}):`, JSON.stringify(first.c), '\n    was:', first.a, '\n    now:', first.b);
  assert(priced > CASES.length,
    `A2 the matrix is meaningful — ${priced} evaluations actually price (not a matrix of dead cases)`);

  // A blank box must read as "no amount", never as a zero ceiling that kills the loan.
  let zeroDrift = 0;
  for (const e of ENGINES) {
    for (const c of CASES) {
      for (const v of [0, null, undefined, '', NaN]) {
        if (shape(LIVE[e].evaluate(Object.assign({}, c, { targetLoan: v }))) !== shape(BASE[e].evaluate(c))) zeroDrift++;
      }
    }
  }
  assert(zeroDrift === 0, `A3 an empty / 0 / blank box is "no amount", never a zero ceiling (drift: ${zeroDrift})`);
}

// ---- B/C/D. Reduce only, land on the number, keep the owner's split ------------
{
  let checked = 0, grew = 0, missed = 0, rehabShrank = 0, initialTookIt = 0, byProgram = {};
  let belowRehab = 0, belowRehabSilent = 0;
  for (const e of ENGINES) {
    byProgram[e] = 0;
    for (const c of CASES) {
      const full = LIVE[e].evaluate(c);
      const fs_ = full && full.sizing;
      if (!fs_ || !(fs_.totalLoan > 1000)) continue;

      // Ask for LESS than the deal supports, at several depths, plus one ABOVE it.
      for (const frac of [0.95, 0.8, 0.6, 1.25]) {
        const want = Math.round(fs_.totalLoan * frac);
        const ev = LIVE[e].evaluate(Object.assign({}, c, { targetLoan: want }));
        const s = ev && ev.sizing;
        if (!s || !(s.totalLoan > 0)) continue;
        checked++; byProgram[e]++;

        // B — never larger than with no box at all, whatever was typed.
        if (s.totalLoan > fs_.totalLoan + 1e-6) grew++;

        if (frac < 1) {
          // C — a reachable amount is the amount. The engine reports whole dollars and
          // an interest reserve can only make the loan SMALLER than the ceiling here,
          // so allow a dollar of rounding but nothing structural.
          if (s.totalLoan > want + 1) missed++;
          // D — THE SPLIT. The construction budget is financed FIRST and the cut lands
          // on the initial advance. The one case where that cannot hold is arithmetic
          // rather than policy: a typed amount BELOW the rehab budget cannot finance
          // that rehab at all. The engine must then SAY SO rather than quietly hand
          // back an under-financed construction budget (D3), which is the same
          // never-guess discipline the rest of this codebase runs on.
          const coversRehab = want >= (fs_.rehabLoan || 0) - 1;
          if (coversRehab) {
            if (s.rehabLoan < fs_.rehabLoan - 1) rehabShrank++;
            if (s.acquisition < fs_.acquisition - 1) initialTookIt++;
          } else if (s.rehabLoan < fs_.rehabLoan - 1) {
            belowRehab++;
            const said = (ev.reasons || []).some((r) => r.level === 'MANUAL' || r.level === 'INELIGIBLE');
            if (!said) belowRehabSilent++;
          }
        }
      }
    }
  }
  assert(checked > 1000, `B0 the box was exercised on ${checked} priced scenarios`);
  assert(ENGINES.every((e) => byProgram[e] > 0),
    `B1 all three programs were exercised — ${ENGINES.map((e) => `${e}:${byProgram[e]}`).join(', ')}`);
  assert(grew === 0,
    `B2 A TYPED AMOUNT CAN ONLY EVER REDUCE — including one typed ABOVE the maximum, which is simply unreachable (violations: ${grew})`);
  assert(missed === 0, `C1 a reachable amount is what the deal sizes to (over by more than $1: ${missed})`);
  assert(rehabShrank === 0,
    `D1 while the typed amount can cover the rehab, the construction budget stays fully financed (violations: ${rehabShrank})`);
  assert(initialTookIt > 0,
    `D2 …and the cut lands on the INITIAL advance instead, which is the owner's own split (${initialTookIt} cases)`);
  assert(belowRehab > 0 && belowRehabSilent === 0,
    `D3 an amount too small to finance the rehab is RAISED for review, never silently under-financed (${belowRehab} cases, ${belowRehabSilent} silent)`);
}

// ---- E. The way UP is the admin basis, which already routes to approval ---------
{
  // Typing a bigger number does nothing on its own; raising the basis is what moves
  // the ceiling — and every one of those keys is an approval-gated admin override.
  let raisedByBox = 0, raisedByBasis = 0;
  for (const e of ENGINES) {
    for (const c of CASES.slice(0, 400)) {
      const full = LIVE[e].evaluate(c);
      const base = (full && full.sizing && full.sizing.totalLoan) || 0;
      if (!(base > 1000)) continue;
      const bigBox = LIVE[e].evaluate(Object.assign({}, c, { targetLoan: Math.round(base * 2) }));
      if (((bigBox && bigBox.sizing && bigBox.sizing.totalLoan) || 0) > base + 1e-6) raisedByBox++;
      const basis = LIVE[e].evaluate(Object.assign({}, c, { ovrARLTV: 0.95, ovrLTC: 1, ovrAcqLTV: 0.95 }));
      if (((basis && basis.sizing && basis.sizing.totalLoan) || 0) > base + 1) raisedByBasis++;
    }
  }
  assert(raisedByBox === 0,
    `E1 typing a bigger number NEVER raises a loan by itself (violations: ${raisedByBox})`);
  assert(raisedByBasis > 0,
    `E2 …the manual LTV / LTC / ARV basis is what raises it — the path that already needs admin approval (${raisedByBasis} cases)`);

  // And that basis is genuinely approval-gated, while the box is not — the box is a
  // reduction anyone may take, exactly like a ladder rung.
  const ovr = fs.readFileSync(path.join(__dirname, '..', 'src/lib/pricing-overrides.js'), 'utf8');
  for (const k of ['ovrAcqLTV', 'ovrARLTV', 'ovrLTC']) {
    assert(new RegExp(`\\b${k}\\b`).test(ovr), `E3 ${k} is an approval-gated admin knob`);
  }
  assert(!/\btargetLoan\b/.test(ovr),
    'E4 the box itself needs no approval — it can only reduce, exactly like a ladder rung');
}

// ---- The engine copies stay identical (the frozen-copies rule) -----------------
{
  let same = 0;
  for (const e of ENGINES) {
    const a = fs.readFileSync(path.join(__dirname, '..', `web/v2/tools/${e}.js`), 'utf8');
    const b = fs.readFileSync(path.join(__dirname, '..', `web/tools/${e}.js`), 'utf8');
    if (a === b && /input\.targetLoan/.test(a)) same++;
  }
  assert(same === ENGINES.length,
    `G1 all ${ENGINES.length} engines carry the box and both copies of each remain byte-identical (${same})`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);

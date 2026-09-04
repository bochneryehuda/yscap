/**
 * THE SPEED PROGRAM — the acceptance battery (owner-directed 2026-09-03; the rules
 * R1–R11 of docs/SPEED-PROGRAM-RESEARCH.md, in the owner's words: "always the lesser
 * loan amount between the two programs, the lesser max LTV, the lesser max initial,
 * the lesser max ARV, the more conservative geographic restrictions … the rate should
 * be the more expensive rate from the two programs … only going to allow a 10%
 * assignment fee … even though it's going to be less than both programs, you still
 * need to enforce the max LTV cap from both programs … something that we can sell to
 * either note buyer"), the two later overlay messages, and the 2026-09-03 correction
 * that a Speed overlay must never be printed as a parent's own figure.
 * PURE — no DB, no network. Runs web/tools/speed-program.js against the two frozen
 * engines it composes, over the same scenario cross product the engine batteries use.
 *
 *   S1  WORST STATUS WINS. Speed is INELIGIBLE whenever Standard OR Silver is
 *       INELIGIBLE on the Speed basis; MANUAL whenever either is MANUAL; never
 *       ELIGIBLE unless both are.
 *   S2  DUAL-SELLABILITY — the acceptance test of the whole idea. For every priced
 *       Speed quote, EACH parent alone — at ITS OWN 15% rule and ITS OWN caps, pinned
 *       only to the Speed loan amount — is not INELIGIBLE and lands AT that amount (or
 *       below it by no more than the interest reserve it would price at its own lower
 *       rate — never above); and every ratio of the Speed structure (acquisition LTV on
 *       the Speed basis, after-repair LTV, loan-to-cost) sits at or under THAT parent's
 *       own ceiling.
 *   S3  THE HIGHER PRICE. Speed's note rate ≥ each parent's rate at the Speed
 *       structure, and equals the higher of the two.
 *   S4  THE 10% SHARE. financeable = min(fee, 10% × seller), effective price =
 *       seller + financeable, excess = the rest; `assignment.maxPct` is 0.10.
 *   S5  THE OWNER'S TRAP, ASSERTED DIRECTLY. Speed's initial advance ≤ min over
 *       parents of (that parent's acquisition cap × the Speed acqDenom); its total ≤
 *       min over parents of (ARV cap × ARV, on a value-add product) and ≤ the maximum.
 *   S6  ATTRIBUTION IS TRUTHFUL, AND THE PANEL'S TWO SECTIONS STAY SEPARATE. The
 *       enforced ceiling is the minimum of the two parents' PRICED ceilings and the
 *       Speed overlay; the overlay is credited only when it binds; each parent's
 *       published GUIDELINE ROW (what the panel shows in its column) is never below
 *       what that parent priced, and a Speed overlay never appears in it.
 *   S7  THE MAXIMUM LOAN OVERLAY. No Speed loan exceeds it; a deal both parents would
 *       lend more on is held at exactly it; a typed loan amount above it is
 *       INELIGIBLE with the figure named.
 *   S8  PURITY. Same input → same output; the parents' markup state is untouched
 *       after a quote; the caller's input object is never mutated.
 *   S9  NEVER THROWS. Hostile input yields a status, not an exception.
 *   S10 THE LADDER only ever steps DOWN in loan and never UP in rate, and its top
 *       row is the full quote.
 *   S11 THE LESSER MAX INITIAL: Speed's initial advance never exceeds either parent's
 *       under the combined ceiling — a parent's own floor (Standard's judicial $20k down
 *       payment) counts — beyond the reserve the two price at different rates.
 *   R4  GEOGRAPHY: Indiana (Standard's ban) and Nevada (Silver's ban) are both refused,
 *       each carrying the parent's own sentence.
 *   S12 NO FINANCED INTEREST RESERVE (owner 2026-09-03, second message): no Speed loan
 *       finances a reserve whatever was requested; a request is remembered and explained
 *       on the quote (`speed_no_financed_reserve`), and only then.
 *   S13 NEVER MORE THAN 90% LOAN-TO-COST, even where both parents allow 92.5%; the wall
 *       binds on real scenarios and is credited to the Speed Program when it is the wall.
 *
 * Also runs in SOAK MODE (seeded random deals appended to the matrix — see below); the
 * soak is what found the two edge shapes now pinned into the matrix.
 *
 * MUTATION EVIDENCE (measured, recorded in the PR): share 0.10 → 0.15 fails S4; the rate
 * donor flipped to the LOWER rate fails S3; the combined ceiling taking the LARGER of the
 * two fails S2/S5/S6; the $1M wall removed fails S7; Silver's program maximum read instead
 * of its deal ceiling fails S2/S11; the own-basis gate pass removed fails S2a; the
 * lesser-initial alignment removed fails S11; the financed reserve allowed again fails
 * S12a (2,344 loans); the wall lifted to 92.5% fails S13b; the request left unexplained
 * fails S12b (6,552 requests) — the unmutated module green either side.
 */
'use strict';

const path = require('path');
const DIR = path.join(__dirname, '..', 'web/tools');
const YSP = require(path.join(DIR, 'standard-program.js'));
const SVP = require(path.join(DIR, 'silver-program.js'));
const SPP = require(path.join(DIR, 'speed-program.js'));

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const num = (v) => (isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round(n * 100) / 100;
const sized = (ev) => !!(ev && ev.sizing && num(ev.sizing.totalLoan) > 0);
const RANK = { ELIGIBLE: 0, MANUAL: 1, INELIGIBLE: 2, ERROR: 3 };
const WALL = SPP.constants.SPEED_MAX_LOAN;
const SHARE = SPP.constants.ASSIGNMENT_MAX_PCT;
const LTC_WALL = SPP.constants.SPEED_MAX_LTC;

assert(WALL === 800000, `R11 the Speed Program's own maximum loan is $800,000 (got ${WALL})`);
assert(SHARE === 0.10, `R7 the Speed Program's assignment share is 10% (got ${SHARE})`);
assert(LTC_WALL === 0.90, `R13 the Speed Program's loan-to-cost wall is 90% (got ${LTC_WALL})`);
assert(SPP.constants.FINANCED_RESERVE_ALLOWED === false, 'R12 the Speed Program finances no interest reserve');

function scenarios() {
  const out = [];
  const places = [
    { state: 'NJ', city: 'Newark', zip: '07102' }, { state: 'FL', city: 'Miami', zip: '33101' },
    { state: 'TX', city: 'Dallas', zip: '75201' }, { state: 'OH', city: 'Columbus', zip: '43215' },
    { state: 'CA', city: 'Los Angeles', zip: '90012' }, { state: 'IN', city: 'Indianapolis', zip: '46204' },
    { state: 'NV', city: 'Las Vegas', zip: '89101' }, { state: 'NY', city: 'Brooklyn', zip: '11201' },
  ];
  const strategies = ['Fix & Flip', 'Fix & Hold (BRRRR)', 'Ground-up Construction', 'Bridge'];
  for (const place of places) for (const strategy of strategies) for (const loanType of ['Purchase', 'Refinance'])
    for (const fico of [640, 700, 760]) for (const arv of [450000, 900000, 2200000]) for (const rehab of [0, 80000, 200000])
      for (const exp of [0, 2, 6]) for (const irMonths of [0, 6])
        for (const asg of (loanType === 'Purchase' ? ['none', 'small', 'large'] : ['none'])) {
          const seller = Math.round(arv * 0.62);
          const fee = asg === 'none' ? 0 : asg === 'small' ? Math.round(seller * 0.08) : Math.round(seller * 0.25);
          out.push({
            loanType, strategy, state: place.state, city: place.city, zip: place.zip,
            propertyType: 'SFR (1 unit)', units: 1,
            purchasePrice: seller + fee, sellerPrice: asg === 'none' ? 0 : seller, isAssignment: asg !== 'none',
            asIsValue: Math.round(arv * 0.66), arv, rehabBudget: rehab, fico, term: 12, irMonths,
            expFlips: exp, expHolds: 0, expGround: exp,
          });
        }
  /* EDGE SHAPES the cross product does not reach, each a defect the soak found first:
     (a) a large assignment fee with the after-repair value BETWEEN the 10% cost basis and
         the 15% cost basis — Silver's value-add gate passes on the Speed basis and fails
         on its own; (b) a judicial-state purchase under $100k — Standard's $20,000
         down-payment floor sets a smaller initial than Silver's cap does. */
  for (const seller of [400000, 1200000]) for (const rehab of [150000, 1000000]) {
    const arv = seller + Math.round(0.125 * seller) + rehab;
    out.push({ loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', city: 'Newark', zip: '07102', propertyType: 'SFR (1 unit)', units: 1,
      purchasePrice: seller + Math.round(seller * 0.25), sellerPrice: seller, isAssignment: true,
      asIsValue: Math.round(seller * 1.1), arv, rehabBudget: rehab, fico: 734, term: 12, irMonths: 0, expFlips: 8, expHolds: 0, expGround: 8 });
  }
  // [price, fico, comps, term]: the soak's own case, and a $60,000 first-timer where SILVER is
  // the rate donor — the shape in which the lesser-initial alignment actually has to act.
  for (const [price, fico, exp, term] of [[77772, 759, 2, 18], [60000, 700, 0, 12], [95000, 700, 0, 12]]) for (const strategy of ['Bridge', 'Fix & Flip']) {
    out.push({ loanType: 'Purchase', strategy, state: 'PA', city: 'Pittsburgh', zip: '15201', propertyType: 'Duplex (2 units)', units: 1,
      purchasePrice: price, sellerPrice: 0, isAssignment: false, asIsValue: Math.round(price * 1.14), arv: Math.round(price * 2.5),
      rehabBudget: strategy === 'Bridge' ? 0 : 53000, fico, term, irMonths: 0, expFlips: exp, expHolds: exp ? 1 : 0, expGround: exp });
  }
  return out;
}

/* SOAK MODE — the SAME invariants over seeded random deals, so there is one definition
   of what Speed must satisfy and not a second soak runner that drifts from it.
   `SPEED_SOAK_N=50000 SPEED_SOAK_SEED=7 node scripts/test-speed-program-pure.js`
   appends N random scenarios to the matrix; unset, the matrix alone runs (npm test). */
function soakScenarios(n, seed) {
  let s = (seed >>> 0) || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const places = [['NJ', 'Newark', '07102'], ['FL', 'Miami', '33101'], ['TX', 'Dallas', '75201'], ['OH', 'Columbus', '43215'], ['CA', 'Los Angeles', '90012'],
    ['NY', 'Brooklyn', '11201'], ['PA', 'Pittsburgh', '15201'], ['GA', 'Atlanta', '30303'], ['IN', 'Indianapolis', '46204'], ['NV', 'Las Vegas', '89101'], ['IL', 'Chicago', '60601'], ['MD', 'Baltimore', '21201']];
  const out = [];
  for (let i = 0; i < n; i++) {
    const [state, city, zip] = pick(places);
    const loanType = rnd() < 0.7 ? 'Purchase' : 'Refinance';
    const arv = Math.round((150000 + rnd() * 3000000) / 1000) * 1000;
    const seller = Math.round(arv * (0.35 + rnd() * 0.5));
    const asg = loanType === 'Purchase' && rnd() < 0.4;
    const fee = asg ? Math.round(seller * rnd() * 0.3) : 0;
    const exp = pick([0, 1, 2, 3, 5, 8]);
    out.push({
      loanType, strategy: pick(['Fix & Flip', 'Fix & Hold (BRRRR)', 'Ground-up Construction', 'Bridge']), state, city, zip,
      propertyType: pick(['SFR (1 unit)', 'Duplex (2 units)', 'Townhouse', 'Condo']), units: 1,
      purchasePrice: seller + fee, sellerPrice: asg ? seller : 0, isAssignment: asg,
      asIsValue: Math.round(seller * (0.9 + rnd() * 0.3)), arv, rehabBudget: Math.round(arv * rnd() * 0.45 / 1000) * 1000,
      fico: 600 + Math.floor(rnd() * 220), term: pick([12, 12, 18, 24]), irMonths: pick([0, 0, 3, 6, 12]),
      expFlips: exp, expHolds: rnd() < 0.3 ? 1 : 0, expGround: exp, cashOut: loanType === 'Refinance' && rnd() < 0.3,
    });
  }
  return out;
}
const SOAK_N = Math.max(0, parseInt(process.env.SPEED_SOAK_N || '0', 10) || 0);
const CASES = scenarios().concat(SOAK_N ? soakScenarios(SOAK_N, parseInt(process.env.SPEED_SOAK_SEED || '1', 10)) : []);
console.log(`scenario matrix: ${CASES.length} cases${SOAK_N ? ` (incl. ${SOAK_N} seeded random, seed ${process.env.SPEED_SOAK_SEED || 1})` : ''}\n`);

const ceilingOf = (name, ev) => SPP.ceilingOf(name, ev);
const speedBasis = (c) => SPP.speedInput(c);

// ---- The matrix, once -------------------------------------------------------------
let priced = 0, eligible = 0, manual = 0, inel = 0;
const s1 = { bad: 0 }, s2 = { checked: 0, refused: 0, offTotal: 0, overCap: 0 }, s3 = { bad: 0, notMax: 0 };
const s4 = { checked: 0, bad: 0, badTag: 0 }, s5 = { initOver: 0, arvOver: 0, wallOver: 0 }, s6 = { bad: 0, parentBelow: 0, overlayInParent: 0 };
const s7 = { held: 0 }, s8 = { nondet: 0, mutated: 0, leaked: 0 }, s11 = { bad: 0 };
const s12 = { requested: 0, financed: 0, noLine: 0, lineWithout: 0 }, s13 = { over: 0, held: 0, misattributed: 0 };
const first = {};
const note = (k, v) => { if (!first[k]) first[k] = v; };

for (const c of CASES) {
  const frozen = JSON.stringify(c);
  const ev = SPP.evaluate(c);
  const again = SPP.evaluate(c);
  if (JSON.stringify(ev) !== JSON.stringify(again)) { s8.nondet++; note('nondet', c); }
  if (JSON.stringify(c) !== frozen) { s8.mutated++; note('mutated', c); }
  // The parents' markup hooks must read as untouched afterwards: a probe with no
  // markup must equal a probe with markup explicitly cleared.
  const probeA = YSP.evaluate(c).noteRate; YSP.setMarkup(null); SVP.setMarkup(null); YSP.setMarkupTiers(null); SVP.setMarkupTiers(null);
  if (Math.abs(num(probeA) - num(YSP.evaluate(c).noteRate)) > 1e-12) { s8.leaked++; note('leaked', c); }

  if (ev.status === 'INELIGIBLE') inel++; else if (ev.status === 'MANUAL') manual++; else if (ev.status === 'ELIGIBLE') eligible++;

  // S1 — against the parents on the SPEED basis (10% share, $1M wall)
  const basis = speedBasis(c);
  const pS = YSP.evaluate(basis), pV = SVP.evaluate(basis);
  const worst = RANK[pS.status] >= RANK[pV.status] ? pS.status : pV.status;
  if (RANK[ev.status] < RANK[worst]) { s1.bad++; note('s1', { c, speed: ev.status, standard: pS.status, silver: pV.status }); }

  if (!sized(ev) || ev.status === 'INELIGIBLE') continue;
  priced++;
  const s = ev.sizing, T = s.totalLoan, sp = ev.speed;

  // S7 — the wall
  if (T > WALL + 0.5) { s5.wallOver++; note('wall', { c, T }); }
  if (Math.abs(T - WALL) < 1) s7.held++;

  // S12 — no financed interest reserve, whatever was requested (and the file says so)
  const asked = num(c.irMonths) > 0 || num(c.irAmount) > 0;
  const line = ev.reasons.some((r) => r.code === 'speed_no_financed_reserve');
  if (num(s.financedIR) > 0.5) { s12.financed++; note('s12f', { c, financedIR: s.financedIR }); }
  if (asked) { s12.requested++; if (!line || !sp.reserveRequested) { s12.noLine++; note('s12l', c); } }
  else if (line || sp.reserveRequested) { s12.lineWithout++; note('s12w', c); }

  // S13 — never more than 90% loan-to-cost, and the wall is credited to Speed when it is the wall
  if (num(s.ltcPct) > LTC_WALL + 1e-6) { s13.over++; note('s13', { c, ltc: s.ltcPct }); }
  if (Math.abs(num(s.ltcPct) - LTC_WALL) < 1e-6) s13.held++;
  if (sp.capDonor.maxLTC === 'speed' && Math.abs(ev.pricedCeiling.maxLTC - LTC_WALL) > 1e-9) { s13.misattributed++; note('s13a', { c, cap: ev.pricedCeiling.maxLTC }); }

  // S3 — the higher price, and exactly the higher
  const rS = num(sp.standard.noteRate), rV = num(sp.silver.noteRate);
  if (ev.noteRate < Math.max(rS, rV) - 1e-12) { s3.bad++; note('s3', { c, rate: ev.noteRate, rS, rV }); }
  if (Math.abs(ev.noteRate - Math.max(rS, rV)) > 1e-12) s3.notMax++;

  // S11 — THE LESSER MAX INITIAL: Speed's initial advance never exceeds either parent's
  // initial under the combined ceiling (a parent's own floor — Standard's judicial $20k
  // down payment — counts), beyond the reserve the two price at different rates.
  if (sp.standard.initialAdvance != null && sp.silver.initialAdvance != null) {
    const dRes = Math.abs(num(sp.standard.financedIR) - num(sp.silver.financedIR));
    const least = Math.min(sp.standard.initialAdvance, sp.silver.initialAdvance);
    if (s.acquisition > least + dRes + 1) { s11.bad++; note('s11', { c, speed: s.acquisition, std: sp.standard.initialAdvance, slv: sp.silver.initialAdvance, dRes }); }
  }

  // S4 — the 10% share
  if (c.isAssignment && ev.assignment) {
    s4.checked++;
    const fee = c.purchasePrice - c.sellerPrice, fin = r2(Math.min(fee, SHARE * c.sellerPrice));
    const a = ev.assignment;
    if (a.maxPct !== SHARE || a.financeableFee !== fin || a.recognizedPrice !== r2(c.sellerPrice + fin) || a.excessOOP !== r2(fee - fin)) { s4.bad++; note('s4', { c, a }); }
    /* THE 10% CAP IS THIS PROGRAM'S OVERLAY, NOT A RULE EITHER PARENT HAS (owner-reported
       2026-09-03: "it's saying that this is relevant for both. This is also an overlay
       only for this program"). Both engines raise the identical sentence because both were
       handed the Speed share, so the plain de-duplication used to tag it [Both] — reading
       as if Standard and Silver each capped assignment fees at 10%, which neither does. */
    if (a.overLimit && sized(ev)) {
      const line = ev.reasons.find((r) => /assignment fee is financed \(the /.test(r.msg));
      if (!line || line.program !== 'speed' || !/^\[Speed overlay\] /.test(line.msg)) { s4.badTag++; note('s4tag', { c, line: line && line.msg.slice(0, 90), prog: line && line.program }); }
    }
  }

  /* S6 — attribution, and the two meanings the composition panel prints side by side:
     `ceiling`    = what that parent PRICED this deal at (its own lattice / sqft rule may
                    have stepped it below its guideline row) — the figure the enforced
                    ceiling is the minimum of;
     `ownCeiling` = that parent's published GUIDELINE ROW for the profile, carrying no
                    lever of ours — the column the panel shows under "Standard"/"Silver",
                    and never below what it priced. */
  const caps = ev.pricedCeiling;
  const pricedCeil = { standard: sp.standard.ceiling, silver: sp.silver.ceiling };
  const own = { standard: sp.standard.ownCeiling, silver: sp.silver.ownCeiling };
  const adminBasis = num(c.ovrAcqLTV) > 0 || num(c.ovrARLTV) > 0 || num(c.ovrLTC) > 0;
  for (const k of ['maxLoan', 'maxAcqLTV', 'maxARLTV', 'maxLTC']) {
    const enforced = caps[k];
    const speedWall = k === 'maxLoan' ? WALL : k === 'maxLTC' ? LTC_WALL : Infinity;   // the Speed Program's own overlays
    const leastPriced = Math.min(pricedCeil.standard[k], pricedCeil.silver[k]);
    if (Math.abs(enforced - Math.min(leastPriced, speedWall)) > 1e-9) { s6.bad++; note('s6', { c, k, enforced, leastPriced, speedWall }); }
    // The overlay is credited only when it is genuinely the binding one.
    if (sp.capDonor[k] === 'speed' && !(speedWall <= leastPriced + 1e-9)) { s6.bad++; note('s6d', { c, k, leastPriced, speedWall }); }
    // The PANEL's two parent columns are guideline rows, never below what was priced,
    // and never a Speed overlay wearing a parent's name (the 2026-09-03 report).
    if (!adminBasis && (own.standard[k] < pricedCeil.standard[k] - 1e-9 || own.silver[k] < pricedCeil.silver[k] - 1e-9)) { s6.parentBelow++; note('s6b', { c, k, pricedCeil, own }); }
    if (sp.capDonor[k] === 'speed' && (Math.abs(own.standard[k] - speedWall) < 1e-9 && Math.abs(own.silver[k] - speedWall) < 1e-9 && speedWall < 1e9)) { s6.overlayInParent++; note('s6c', { c, k, own, speedWall }); }
  }

  // S5 — the trap: measured against EACH parent's own ceiling on the Speed basis
  const acqDenom = num(s.acqDenom);
  for (const p of ['standard', 'silver']) {
    const o = own[p];
    if (acqDenom > 0 && s.acquisition > o.maxAcqLTV * acqDenom + 1) { s5.initOver++; note('s5i', { c, p, init: s.acquisition, cap: o.maxAcqLTV * acqDenom }); }
    if (ev.strategyCode !== 'BR' && c.arv > 0 && T > o.maxARLTV * c.arv + 1) { s5.arvOver++; note('s5a', { c, p, T, cap: o.maxARLTV * c.arv }); }
  }

  // S2 — dual-sellability: each parent ALONE, its own 15% rule, its own caps, pinned only to the Speed total
  for (const [name, E] of [['standard', YSP], ['silver', SVP]]) {
    s2.checked++;
    const back = E.evaluate(Object.assign({}, c, { targetLoan: T }));
    if (back.status === 'INELIGIBLE') { s2.refused++; note('s2r', { c, name, reasons: back.reasons.map((r) => r.msg.slice(0, 90)) }); continue; }
    // Pinned to the Speed amount, the parent lands AT it — or BELOW it by no more than
    // the interest reserve priced at its own (lower) rate: the wall is a MIN, the parent
    // finances a smaller reserve than Speed does, and when the acquisition cap already
    // binds the initial there is nothing left to fill the gap with. Never ABOVE it.
    if (!sized(back)) { s2.offTotal++; note('s2t', { c, name, T, got: null }); continue; }
    const gap = T - back.sizing.totalLoan, reserveGap = num(s.financedIR) - num(back.sizing.financedIR);
    if (gap < -1 || gap > Math.max(0, reserveGap) + 1) { s2.offTotal++; note('s2t', { c, name, T, got: back.sizing.totalLoan, reserveGap }); continue; }
    const oc = ceilingOf(name, back);
    // Ratios of the SPEED structure against THIS parent's own ceiling (its 15% basis is
    // looser, so the Speed initial measured on it can only read lower).
    const bd = num(back.sizing.acqDenom);
    if (bd > 0 && s.acquisition > oc.maxAcqLTV * bd + 1) { s2.overCap++; note('s2c', { c, name, k: 'acq' }); }
    if (ev.strategyCode !== 'BR' && c.arv > 0 && T > oc.maxARLTV * c.arv + 1) { s2.overCap++; note('s2c', { c, name, k: 'arv' }); }
    if (num(back.sizing.ltcPct) > oc.maxLTC + 1e-6) { s2.overCap++; note('s2c', { c, name, k: 'ltc' }); }
    if (T > oc.maxLoan + 1) { s2.overCap++; note('s2c', { c, name, k: 'maxLoan' }); }
  }
}

console.log(`priced ${priced} · eligible ${eligible} · manual ${manual} · ineligible ${inel} · held at the $${WALL.toLocaleString('en-US')} maximum ${s7.held}\n`);
assert(priced > CASES.length * 0.15, `M0 the matrix is meaningful — ${priced} of ${CASES.length} scenarios price on Speed`);
assert(s1.bad === 0, `S1 worst status wins — Speed is never better than the worse parent (violations: ${s1.bad})`);
assert(s2.checked > 0 && s2.refused === 0, `S2a dual-sellability: each parent ALONE (its own 15% rule, own caps) accepts every Speed loan (${s2.checked} checks, refusals: ${s2.refused})`);
assert(s2.offTotal === 0, `S2b …and lands AT the Speed amount, or below it by no more than its own lower-rate reserve — never above (off: ${s2.offTotal})`);
assert(s2.overCap === 0, `S2c …and every ratio of the Speed structure sits at or under that parent's own ceiling (violations: ${s2.overCap})`);
assert(s3.bad === 0 && s3.notMax === 0, `S3 the rate is exactly the higher of the two parents' rates at the Speed structure (below: ${s3.bad}, not-the-max: ${s3.notMax})`);
assert(s4.badTag === 0, `S4d the assignment cap reads as a SPEED OVERLAY, never as a rule both parents raised (violations: ${s4.badTag})`);
assert(s4.checked > 0 && s4.bad === 0, `S4 the 10% share — financeable = min(fee, 10% × seller), effective = seller + financeable, excess = the rest, maxPct 0.10 (${s4.checked} checked, violations: ${s4.bad})`);
assert(s5.initOver === 0, `S5a the trap: the initial advance respects EACH parent's acquisition cap measured on the 10% basis (violations: ${s5.initOver})`);
assert(s5.arvOver === 0, `S5b …and the total respects EACH parent's after-repair cap (violations: ${s5.arvOver})`);
assert(s5.wallOver === 0, `S7a no Speed loan exceeds the $${WALL.toLocaleString('en-US')} maximum (violations: ${s5.wallOver})`);
assert(s7.held > 0, `S7b the maximum genuinely binds — ${s7.held} scenarios held at exactly $${WALL.toLocaleString('en-US')}`);
assert(s6.bad === 0, `S6a every enforced ceiling is the minimum of the two parents' PRICED ceilings and the Speed overlay, and the overlay is credited only when it binds (violations: ${s6.bad})`);
assert(s6.parentBelow === 0, `S6b each parent's published guideline row is never below what that parent priced (violations: ${s6.parentBelow})`);
assert(s6.overlayInParent === 0, `S6c a Speed overlay NEVER appears in a parent's own column — the 2026-09-03 report ("the maximum loan amount of the standard and the silver is $1 million … which is not true") (violations: ${s6.overlayInParent})`);
assert(s8.nondet === 0, `S8a deterministic — same input, same output (violations: ${s8.nondet})`);
assert(s8.mutated === 0, `S8b the caller's input is never mutated (violations: ${s8.mutated})`);
assert(s8.leaked === 0, `S8c the parents' markup state is untouched after a Speed quote (violations: ${s8.leaked})`);
assert(s11.bad === 0, `S11 the lesser max initial — Speed's initial advance never exceeds either parent's under the combined ceiling, a parent's own floor included (violations: ${s11.bad})`);
assert(s12.financed === 0, `S12a no Speed loan finances an interest reserve, whatever was requested (violations: ${s12.financed})`);
assert(s12.requested > 0 && s12.noLine === 0 && s12.lineWithout === 0, `S12b a requested reserve is remembered and explained on the quote, and only then (${s12.requested} requests; missing: ${s12.noLine}, spurious: ${s12.lineWithout})`);
assert(s13.over === 0, `S13a no Speed loan exceeds 90% loan-to-cost (violations: ${s13.over})`);
assert(s13.held > 0, `S13b the 90% wall genuinely binds — ${s13.held} scenarios sized at exactly 90% loan-to-cost`);
assert(s13.misattributed === 0, `S13c when the wall is credited to Speed, the enforced ceiling IS 90% (violations: ${s13.misattributed})`);
for (const k of Object.keys(first)) console.log(`    first ${k}:`, JSON.stringify(first[k]).slice(0, 400));

// ---- S7c — a typed loan amount above the wall is refused, naming the wall ---------
{
  const c = CASES.find((x) => x.arv === 2200000 && x.loanType === 'Purchase' && !x.isAssignment && sized(SPP.evaluate(x)));
  const wallText = '$' + WALL.toLocaleString('en-US') + ' maximum';
  const ev = SPP.evaluate(Object.assign({}, c, { loanAmount: WALL * 1.5 }));
  assert(ev.status === 'INELIGIBLE' && ev.reasons.some((r) => r.msg.includes(wallText)),
    `S7c a typed ${'$' + (WALL * 1.5).toLocaleString('en-US')} is INELIGIBLE on Speed and the reason names the ${wallText} (got ${ev.status})`);
  const ok = SPP.evaluate(Object.assign({}, c, { loanAmount: WALL - 100000 }));
  assert(ok.status !== 'INELIGIBLE' || !ok.reasons.some((r) => r.msg.includes(wallText)), 'S7d a typed amount under the maximum is not refused by it');
}

// ---- S9 — never throws --------------------------------------------------------------
{
  let threw = 0, statuses = new Set();
  for (const bad of [null, undefined, {}, { purchasePrice: 'abc' }, { loanType: 'Purchase', arv: -5, fico: 'x' }, { strategy: 42, state: {} }, 'string', 7, [],
    { loanType: 'Purchase', purchasePrice: NaN, arv: Infinity }, { loanType: 'Refinance', asIsValue: 1e18, arv: 1e18, fico: 800 }]) {
    try { statuses.add(SPP.evaluate(bad).status); } catch (e) { threw++; console.log('    threw on', JSON.stringify(bad), e.message); }
    try { SPP.priceLadder(bad); } catch (e) { threw++; console.log('    ladder threw on', JSON.stringify(bad), e.message); }
  }
  assert(threw === 0, `S9 hostile input never throws — a status comes back (${[...statuses].join('/')})`);
}

// ---- S10 — the ladder ---------------------------------------------------------------
{
  let checked = 0, up = 0, rateUp = 0, topBad = 0;
  for (const c of CASES.filter((x, i) => i % 7 === 0)) {
    const full = SPP.evaluate(c);
    if (!sized(full) || full.status === 'INELIGIBLE') continue;
    const L = SPP.priceLadder(c);
    if (!L.eligible || !L.rows.length) continue;
    checked++;
    if (!L.rows[0].isMax || Math.abs(L.rows[0].totalLoan - full.sizing.totalLoan) > 0.5) topBad++;
    for (let i = 1; i < L.rows.length; i++) {
      if (L.rows[i].totalLoan > L.rows[i - 1].totalLoan + 0.5) up++;
      if (L.rows[i].noteRate > L.rows[i - 1].noteRate + 1e-12) rateUp++;
    }
  }
  assert(checked > 0 && topBad === 0, `S10a the ladder's top row is the full Speed quote (${checked} ladders, violations: ${topBad})`);
  assert(up === 0 && rateUp === 0, `S10b down the ladder the loan never grows and the rate never rises (loan-up: ${up}, rate-up: ${rateUp})`);
}

// ---- Geography: both books apply (the two banned-state places in the matrix) ------
{
  const ind = CASES.filter((c) => c.state === 'IN'), nev = CASES.filter((c) => c.state === 'NV');
  const indBad = ind.filter((c) => SPP.evaluate(c).status !== 'INELIGIBLE').length;
  const nevBad = nev.filter((c) => SPP.evaluate(c).status !== 'INELIGIBLE').length;
  assert(ind.length > 0 && indBad === 0, `R4a Indiana (banned by Standard, allowed by Silver) is INELIGIBLE on Speed — every case (${ind.length}, violations: ${indBad})`);
  assert(nev.length > 0 && nevBad === 0, `R4b Nevada (banned by Silver, allowed by Standard) is INELIGIBLE on Speed — every case (${nev.length}, violations: ${nevBad})`);
  const tagged = SPP.evaluate(nev[0]).reasons.some((r) => /^\[Silver\] /.test(r.msg) && /Nevada/.test(r.msg));
  assert(tagged, 'R4c the refusal carries the parent\'s own sentence, prefixed with the program that raised it');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);

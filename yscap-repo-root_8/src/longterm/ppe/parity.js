'use strict';
/**
 * LT PPE — the parity comparator (MEGA plan §10). PURE: no DB, no network. Given OUR engine's result
 * and LENDER PRICE's result for the same scenario, it produces the agreement verdict + a list of
 * FINDINGS (disagreements). This is the core of the shadow-reliability model: both engines run, LP
 * WINS and is what the business sees, and every disagreement becomes a finding we fix before an
 * investor is ever trusted on our engine alone (§1.2, §9, §11).
 *
 * THREE COMPARISONS (§10.1), each per scenario:
 *   1. eligibility — do both engines agree the program is eligible vs ineligible?
 *   2. rate        — for a matched coupon, the note rate agrees within `rateToleranceMilli`.
 *   3. price       — for a matched coupon, the price agrees within `priceToleranceMilli`.
 *
 * UNITS: both ladders must already be in the SAME units — rate in the same integer scale, price in
 * milli-points (this module compares numbers; the caller normalizes each engine's raw output).
 * `normalizeOurQuote` maps quote.js output; the LP-side normalizer lives with the façade (it needs the
 * parsed searchRaw shape).
 *
 * TOLERANCES come from settings (validation.price_tolerance_milli default 1, rate_tolerance_milli
 * default 0) — passed in, never hardcoded.
 *
 * LT-only. No RTL imports.
 */

const overlay = require('./overlay');

// OVERLAY is a THIRD eligibility outcome (owner D29): our matrix declines a scenario Lender Price
// prices, but ONLY on an overlay-only fact LP cannot see (vacant, rural, STR…) and ONLY with a stated
// reason. That is an INTENTIONAL, reasoned override of LP — not a parity defect — so it is scored
// separately (never counted as agreement, never counted as a mismatch). See src/longterm/ppe/overlay.js.
const SEVERITY = { ELIGIBILITY: 'eligibility_mismatch', OVERLAY: overlay.FINDING_KIND, PRICE: 'price_mismatch', RATE: 'rate_mismatch', MISSING_OURS: 'rung_missing_ours', MISSING_THEIRS: 'rung_missing_theirs', INCOMPARABLE: 'incomparable' };

// A side is COMPARABLE only when the engine actually produced a result: a ladder array, or an object
// that STATES eligibility or carries a ladder. Anything else — null, undefined, a primitive, an empty
// object — is ABSENT: the engine gave no answer, so the scenario cannot be fully compared. §10.6: an
// incomparable scenario is recorded with its reason and is NEVER scored as agreement (a missing side
// would otherwise read as "ineligible" and could silently agree with the other side's ineligible).
function isComparable(x) {
  if (Array.isArray(x)) return true;
  if (x && typeof x === 'object') {
    if (typeof x.eligible === 'boolean') return true;
    if (Array.isArray(x.ladder) || Array.isArray(x.rungs)) return true;
  }
  return false;
}

// Map a quote.js result into the normalized ladder [{ rate, priceMilli }] the comparator uses.
// A quote that explicitly REFUSED to price (`priced === false` — a missing
// price-bearing fact, or a lock the sheet does not publish) produced NO ANSWER, so
// it returns null → `isComparable` is false → the scenario is recorded INCOMPARABLE
// with its reason (§10.6) instead of being read as "eligible with zero rungs",
// which would score against Lender Price as if we had priced it.
function normalizeOurQuote(q) {
  if (q && q.priced === false) return null;
  if (!q || !q.eligible || !Array.isArray(q.ladder)) return { eligible: !!(q && q.eligible), rungs: [] };
  return { eligible: true, rungs: q.ladder.map((r) => ({ rate: r.rate, priceMilli: r.finalPriceMilli })) };
}

// Normalize any { eligible, rungs:[{rate, priceMilli}] } (or a bare rungs array) into a canonical
// { eligible, rungs } sorted by rate. Tolerant so either engine's normalized output slots in.
function normalizeLadder(x) {
  if (!x) return { eligible: false, rungs: [] };
  if (Array.isArray(x)) return { eligible: true, rungs: x.slice().sort((a, b) => a.rate - b.rate) };
  const rungs = Array.isArray(x.rungs) ? x.rungs.slice().sort((a, b) => a.rate - b.rate) : [];
  return { eligible: !!x.eligible, rungs };
}

/**
 * Compare OUR result to LENDER PRICE's for one scenario. Returns:
 *   { agree, findings:[{ kind, rate?, ourPriceMilli?, theirPriceMilli?, deltaMilli?, detail }] }
 * `agree` is true iff there are no findings (LP is authoritative regardless — this only decides
 * whether we may eventually trust our own engine for this scenario/investor).
 *
 * `opts`: { priceToleranceMilli=1, rateToleranceMilli=0, scenario? } — scenario is echoed onto each
 * finding for the ledger.
 */
function compareScenario(ours, theirs, opts = {}) {
  const priceTol = opts.priceToleranceMilli == null ? 1 : opts.priceToleranceMilli;
  const rateTol = opts.rateToleranceMilli == null ? 0 : opts.rateToleranceMilli;
  const tag = (f) => (opts.scenario ? { ...f, scenario: opts.scenario } : f);

  // 0) §10.6 — a side that produced no result cannot be compared; never scored as agreement.
  const oursOk = isComparable(ours);
  const theirsOk = isComparable(theirs);
  if (!oursOk || !theirsOk) {
    const side = (!oursOk && !theirsOk) ? 'both' : (!oursOk ? 'ours' : 'theirs');
    const who = side === 'both' ? 'neither engine' : (side === 'ours' ? 'our engine' : 'Lender Price');
    const detail = `${who} produced no result to compare — scenario left incomparable`;
    return { agree: false, incomparable: true, reason: detail, findings: [tag({ kind: SEVERITY.INCOMPARABLE, side, detail })] };
  }

  const A = normalizeLadder(normalizeOurQuoteMaybe(ours));
  const B = normalizeLadder(normalizeOurQuoteMaybe(theirs));
  const findings = [];

  // 1) eligibility.
  if (A.eligible !== B.eligible) {
    // When the caller supplies OUR declines (opts.ourDeclines — the quote's declines[]), classify the
    // disagreement: an our-ineligible / LP-eligible divergence that rests ENTIRELY on reasoned
    // overlay-only facts is an intentional override, scored as OVERLAY, not a defect. Anything else —
    // and every case when no declines are supplied — is the plain ELIGIBILITY mismatch, byte-identical
    // to before. `overlay` is surfaced so the scoreboard can bucket a reasoned override apart from a bug.
    //
    // ⛔ AND IT READS THEM OFF THE QUOTE WHEN THE CALLER DID NOT SEPARATE THEM OUT. `normalizeOurQuote`
    // DROPS `declines[]`, so a caller that hands this function a raw quote and forgets `opts.ourDeclines`
    // loses them between the two lines — and the failure is silent and one-directional: a reasoned
    // override is typed as a DEFECT, which is a phantom disagreement on the scoreboard, and phantom
    // disagreements are indistinguishable from real ones (the §2.70 class). `shadow.js` already passes
    // the raw quote AND the option, so the declines were sitting right there in the argument.
    //
    // The explicit option still WINS and is still required by `facade.js`, which passes an
    // already-normalized ladder — by then the declines are genuinely gone and only the caller has them.
    // This is a fallback, never a replacement: `[]` from a caller means "no declines", not "go looking".
    const ourDeclines = Array.isArray(opts.ourDeclines) ? opts.ourDeclines
      : (Array.isArray(ours && ours.declines) ? ours.declines : null);
    if (Array.isArray(ourDeclines)) {
      const c = overlay.classifyEligibilityDivergence({ oursEligible: A.eligible, theirsEligible: B.eligible, ourDeclines });
      if (c.classification === overlay.CLASS.OVERLAY) {
        findings.push(tag({ kind: SEVERITY.OVERLAY, detail: c.detail, ourEligible: A.eligible, theirEligible: B.eligible, overlayReasons: c.overlayReasons }));
        return { agree: false, overlay: true, findings };
      }
    }
    findings.push(tag({ kind: SEVERITY.ELIGIBILITY, detail: `we say ${A.eligible ? 'eligible' : 'ineligible'}, Lender Price says ${B.eligible ? 'eligible' : 'ineligible'}`, ourEligible: A.eligible, theirEligible: B.eligible }));
    return { agree: false, findings }; // no point comparing rungs when eligibility itself disagrees
  }
  if (!A.eligible) return { agree: true, findings }; // both ineligible — agreement

  // 2/3) match coupons by rate (within rateTol), compare price (within priceTol).
  const theirsLeft = B.rungs.map((r) => ({ ...r, used: false }));
  for (const our of A.rungs) {
    let match = null;
    for (const t of theirsLeft) { if (!t.used && Math.abs(t.rate - our.rate) <= rateTol) { match = t; break; } }
    if (!match) {
      findings.push(tag({ kind: SEVERITY.MISSING_THEIRS, rate: our.rate, ourPriceMilli: our.priceMilli, detail: `we priced coupon ${our.rate} that Lender Price did not return` }));
      continue;
    }
    match.used = true;
    const delta = our.priceMilli - match.priceMilli;
    if (Math.abs(delta) > priceTol) {
      findings.push(tag({ kind: SEVERITY.PRICE, rate: our.rate, ourPriceMilli: our.priceMilli, theirPriceMilli: match.priceMilli, deltaMilli: delta, detail: `price disagrees by ${delta} milli-points on coupon ${our.rate} (tolerance ${priceTol})` }));
    } else if (rateTol > 0 && match.rate !== our.rate) {
      findings.push(tag({ kind: SEVERITY.RATE, rate: our.rate, theirRate: match.rate, detail: `matched within rate tolerance but the coupon differs (${our.rate} vs ${match.rate})` }));
    }
  }
  for (const t of theirsLeft) {
    if (!t.used) findings.push(tag({ kind: SEVERITY.MISSING_OURS, rate: t.rate, theirPriceMilli: t.priceMilli, detail: `Lender Price returned coupon ${t.rate} that we did not price` }));
  }

  return { agree: findings.length === 0, findings };
}

// Accept either a quote.js result (has .ladder) or an already-normalized ladder.
function normalizeOurQuoteMaybe(x) {
  if (x && Array.isArray(x.ladder)) return normalizeOurQuote(x);
  return x;
}

/**
 * HOW MUCH DID THIS RUN ACTUALLY COMPARE? — ONE definition (§2.77).
 *
 * `comparable` is agreed + disagreed, and an ENGINE ERROR lands in `disagreed` (a scenario where our
 * side or Lender Price THREW is not agreement, and shadow.summarize tallies them separately as
 * `errors`). So `comparable` counts scenarios where nothing was compared at all, and the number that
 * answers "how much proof is there" is `comparable` LESS those errors.
 *
 * ⛔ THE TWO READERS USED TO DISAGREE. `canary.verdictOf` subtracted the errors — its whole job is to
 * refuse to call a run proof — while `scoreboard.assemble` handed the go-live gate the raw `comparable`
 * as `canaryScenarioCount`, which §2.73 turned into a real coverage FLOOR. Measured: a ten-scenario run
 * with four engine errors reported `compared: 6` on the verdict and `coverage: 10` to the gate, and
 * `cutover.js` documented that field as "how much the latest canary actually COMPARED".
 *
 * IT IS BELT-AND-BRACES TODAY AND THAT IS WRITTEN DOWN RATHER THAN IMPLIED: an error also drags the
 * agreement rate below 1, and `requireCanaryPerfect` (which `settingsToGate` always sets) refuses on
 * that first — so no promotion could actually turn on the difference. What is fixed is that there is
 * one definition of the word, so the day somebody relaxes the rate the coverage floor still means what
 * its own name says.
 */
function comparedOf(summary) {
  const n = (k) => (summary && Number.isFinite(summary[k]) ? summary[k] : 0);
  return Math.max(0, n('comparable') - n('errors'));
}

/**
 * THE WHOLE SPLIT OF ONE RUN, so a total can be RECONCILED rather than taken on faith (§2.79).
 *
 * Every scenario a battery runs lands in exactly one of four buckets, and the go-live gate reads only
 * the first of them:
 *
 *   compared     agreed + disagreed, LESS the scenarios where an engine threw (`comparedOf`, §2.77)
 *   errors       our side or Lender Price threw — a verdict was reached about nothing
 *   overlay      a reasoned override on a fact Lender Price cannot see (D29) — deliberately not scored
 *   incomparable one side produced no ladder at all
 *
 * MEASURED 2026-08-18: a 300-scenario run with 100 reasoned overrides and 4 throws put `196` on the
 * board beside `incomparable: 0`, and the coverage refusal read *"only 196 compared canary scenario(s),
 * needs at least 200"*. Both numbers are correct and 104 scenarios are missing from the page, so the
 * only remedy the wording suggests — run a bigger battery — is the one that cannot help. This is the
 * repo's standing rule that a number a person cannot reconcile is a defect even when it is right, and
 * that when a total splits into buckets you show every bucket.
 *
 * `unaccounted` is the belt to that brace: normally 0, and anything else means the four buckets do NOT
 * partition the run — a broken summary, which is reported rather than absorbed into a bucket that
 * happens to be nearby.
 *
 * NULL IS NOT ZERO, throughout. A summary that never measured its coupling reports `null`, because
 * "nobody measured" and "measured nothing" send a reader to two different places and the coverage floor
 * fails closed on the first.
 */
function bucketsOf(summary) {
  const has = (k) => !!summary && Number.isFinite(summary[k]);
  const n = (k) => (has(k) ? summary[k] : 0);
  if (!summary || typeof summary !== 'object') {
    return { scenarios: null, compared: null, errors: null, overlay: null, incomparable: null, unaccounted: null };
  }
  const scenarios = has('scenarios') ? summary.scenarios : null;
  // `compared` keeps `comparedOf`'s own precondition: without a `comparable` figure nothing was coupled,
  // and answering 0 would read as a battery that compared nothing rather than one nobody measured.
  const compared = has('comparable') ? comparedOf(summary) : null;
  const errors = n('errors');
  const overlay = n('overlay');
  const incomparable = n('incomparable');
  const unaccounted = (scenarios == null || compared == null)
    ? null
    : scenarios - (compared + errors + overlay + incomparable);
  return { scenarios, compared, errors, overlay, incomparable, unaccounted };
}

// Roll a batch of per-scenario results into a scoreboard (§10.5): totals + per-kind finding counts.
// Is this per-scenario result a reasoned OVERLAY override rather than a comparison?
//
// It asks the FINDINGS as well as the flag. `compareScenario` returns `overlay:true`, and `shadow.runOne`
// carries it onward — but a result that has been through a JSON store, or through a caller that rebuilt
// it field by field, can arrive with the boolean gone and the finding intact. The finding is the durable
// statement; the flag is a convenience. An overlay verdict RETURNS IMMEDIATELY with exactly one finding,
// so a lone overlay finding is the whole result and cannot be masking a real disagreement beside it.
function isOverlayResult(r) {
  if (!r) return false;
  if (r.overlay === true) return true;
  const f = Array.isArray(r.findings) ? r.findings : [];
  return f.length === 1 && overlay.isOverlayFinding(f[0]);
}

function summarize(results) {
  const out = { scenarios: 0, agreed: 0, disagreed: 0, overlay: 0, incomparable: 0, comparable: 0, findings: 0, byKind: {} };
  for (const r of results || []) {
    out.scenarios += 1;
    if (r.incomparable) out.incomparable += 1;
    else if (isOverlayResult(r)) out.overlay += 1;
    else if (r.agree) out.agreed += 1;
    else out.disagreed += 1;
    for (const f of r.findings || []) { out.findings += 1; out.byKind[f.kind] = (out.byKind[f.kind] || 0) + 1; }
  }
  out.comparable = out.agreed + out.disagreed;
  // §10.6: the agreement rate is over what could actually be COMPARED — an incomparable scenario is
  // never counted as agreement AND never dilutes the rate as a disagreement.
  //
  // ⛔ AND NEITHER DOES A REASONED OVERRIDE, WHICH IS A THIRD BUCKET AND NOT A ROUNDING DETAIL. The
  // header above this file has said since D29 that an overlay divergence is "scored separately (never
  // counted as agreement, never counted as a mismatch)" — and until 2026-08-18 nothing enforced it: an
  // override landed in `disagreed` and dragged the rate (measured: nine agreeing scenarios plus ONE
  // override reported 0.9). `cutover.eligibleForLive` demands 100% with `requireCanaryPerfect`, so a
  // single override — which is our engine working exactly as the owner specified, and which nobody can
  // "fix" because there is nothing wrong — made the go-live gate permanently unreachable for that
  // investor. A gate whose only remedy is to break the correct behaviour is a dead end, not a gate.
  //
  // So the denominator is scenarios where BOTH engines were answering the same question. `overlay` is
  // reported beside it, never hidden: a battery that is all override measures nothing about the sheet,
  // and `agreementRate` is then null — the honest answer, not a perfect score over nothing.
  out.agreementRate = out.comparable ? out.agreed / out.comparable : null;
  return out;
}

module.exports = { SEVERITY, normalizeOurQuote, normalizeLadder, compareScenario, summarize, isOverlayResult, comparedOf, bucketsOf, _internals: { isComparable } };

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

const SEVERITY = { ELIGIBILITY: 'eligibility_mismatch', PRICE: 'price_mismatch', RATE: 'rate_mismatch', MISSING_OURS: 'rung_missing_ours', MISSING_THEIRS: 'rung_missing_theirs' };

// Map a quote.js result into the normalized ladder [{ rate, priceMilli }] the comparator uses.
function normalizeOurQuote(q) {
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
  const A = normalizeLadder(normalizeOurQuoteMaybe(ours));
  const B = normalizeLadder(normalizeOurQuoteMaybe(theirs));
  const findings = [];
  const tag = (f) => (opts.scenario ? { ...f, scenario: opts.scenario } : f);

  // 1) eligibility.
  if (A.eligible !== B.eligible) {
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

// Roll a batch of per-scenario results into a scoreboard (§10.5): totals + per-kind finding counts.
function summarize(results) {
  const out = { scenarios: 0, agreed: 0, disagreed: 0, findings: 0, byKind: {} };
  for (const r of results || []) {
    out.scenarios += 1;
    if (r.agree) out.agreed += 1; else out.disagreed += 1;
    for (const f of r.findings || []) { out.findings += 1; out.byKind[f.kind] = (out.byKind[f.kind] || 0) + 1; }
  }
  out.agreementRate = out.scenarios ? out.agreed / out.scenarios : null;
  return out;
}

module.exports = { SEVERITY, normalizeOurQuote, normalizeLadder, compareScenario, summarize };

'use strict';
/**
 * LONG-TERM — THE BENCHMARK SCENARIO, and the hash that keys a series
 * (owner-directed 2026-08-30; research
 * `docs/longterm/PRICING-RATE-MOVEMENT-REPORTS.md` §3).
 *
 * PURE apart from Node's own `crypto`. No database, no vendor, no config.
 *
 * ⛔ NOTHING IN A MOVEMENT REPORT IS MEASURABLE UNLESS THE SCENARIO IS HELD
 * CONSTANT. A price is a price FOR A SCENARIO; comparing today's 75% LTV / 760
 * FICO quote against yesterday's 80% / 720 quote measures our own inconsistency
 * and calls it the market. So a series is keyed on a HASH of the scenario, and
 * an edited benchmark starts a NEW series rather than silently comparing apples
 * to oranges — the first report after a change says so instead. That is the same
 * version-stamped-rebaseline discipline `ppe/ratesheet-diff.js` already uses.
 *
 * ⛔ AND EVERY REPORT STAMPS THE BENCHMARK IT MEASURED. A movement figure with
 * no scenario attached is a number nobody can check.
 */

const crypto = require('crypto');

/**
 * THE DEFAULT BENCHMARK — the pricing engine's own starting scenario, written
 * down (the owner: *"the report runs based on the details that we have already
 * in our system, which is always the default that populates"*).
 *
 * ⛔ IT IS A COPY OF `LtScenarioFields.START` AND THE DRIFT IS GUARDED, NOT
 * HOPED FOR. It cannot IMPORT that file — this is server code and that is a
 * browser component — and it must not be re-derived from it either, because an
 * officer may set a benchmark of their own and the default has to stay a stated
 * thing rather than whatever the form happens to open on this week. So
 * `test-lt-price-snapshot-pure.js` reads both and fails the moment they
 * disagree, wording the failure as a DECISION ("the pricer's starting scenario
 * moved; decide whether the benchmark moves with it") rather than as a bug: a
 * benchmark that no longer matches the deal shape the desk actually quotes is a
 * report nobody trusts, and one that silently follows a UI tweak restarts every
 * series without anybody choosing to.
 *
 * ⛔ ESCROWS ARE NOT WAIVED HERE, and the research's prose says they are. The
 * DEFAULT wins: the research's own rule is that the benchmark IS the pricer's
 * default scenario, and the pricer's default is `escrowWaive: false`. A false
 * boolean is omitted entirely, exactly as `toScenario` omits it, so the hash of
 * the benchmark and the hash of a scenario somebody built by hand in the form
 * agree — which is what lets one vendor call serve both.
 */
const DEFAULT_BENCHMARK = Object.freeze({
  purpose: 'Purchase',
  value: 500000,
  loan: 375000,
  fico: 760,
  dscr: 1.25,
  zip: '06001',
  propertyType: 'SingleFamily',
  units: 1,
  borrowerType: 'LLC',
  lockDays: 30,
  termYears: 30,
  prepayMonths: 60,
  prepayStructure: 'Standard',
});

/**
 * A NAME FOR THE BENCHMARK IN ONE LINE, for the footer of every report. It says
 * what was measured in the words an officer would use, so a figure can be
 * checked rather than taken on trust.
 */
function describeBenchmark(sc) {
  const s = sc || {};
  const dollars = (v) => (Number.isFinite(Number(v))
    ? `$${Math.round(Number(v)).toLocaleString('en-US')}` : '—');
  const ltv = (Number(s.value) > 0 && Number(s.loan) > 0)
    ? `${Math.round((Number(s.loan) / Number(s.value)) * 1000) / 10}% LTV` : null;
  return [
    s.purpose || null,
    s.propertyType || null,
    `${dollars(s.value)} value`,
    `${dollars(s.loan)} loan`,
    ltv,
    s.fico != null ? `${s.fico} FICO` : null,
    s.dscr != null ? `${s.dscr} DSCR` : null,
    s.termYears != null ? `${s.termYears}-year` : null,
    s.prepayMonths != null ? `${Math.round(Number(s.prepayMonths) / 12)}-year ${s.prepayStructure || ''}`.trim() : null,
    s.zip ? `ZIP ${s.zip}` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * THE CANONICAL FORM A HASH IS TAKEN OVER.
 *
 * Keys sorted, so two objects describing one scenario hash the same however
 * they were built. `null` / `''` / `undefined` are DROPPED rather than
 * serialised, because "not stated" and "stated as empty" are the same fact to
 * the vendor and hashing them differently would split one series in two the day
 * a caller started sending a blank field. A number is serialised as a number, so
 * `760` and `'760'` cannot key two series for one benchmark.
 */
function canonicalize(sc) {
  const out = {};
  for (const k of Object.keys(sc || {}).sort()) {
    const v = sc[k];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number') { if (Number.isFinite(v)) out[k] = v; continue; }
    if (typeof v === 'boolean') { if (v) out[k] = true; continue; }  // a false flag is not stated
    const n = Number(v);
    // A numeric STRING is stored as the number it is: the form sends "760" and a
    // stored benchmark holds 760, and those must not be two series.
    out[k] = (typeof v === 'string' && v.trim() !== '' && Number.isFinite(n)) ? n : String(v);
  }
  return out;
}

/** The series key. Stable across key order, across number-vs-string, and across
 *  a field that is present-but-empty on one side. */
function scenarioHash(sc) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(sc))).digest('hex').slice(0, 32);
}

module.exports = { DEFAULT_BENCHMARK, describeBenchmark, canonicalize, scenarioHash };

'use strict';
/**
 * LT PPE — WHAT AN AGREEMENT RUN ACTUALLY MEASURED (§2.121).
 *
 * WHY. `scripts/test-lt-lp-agreement-run.js --out report.json` persists `{ summary, results }`, and the
 * summary's headline is `total` and `agreementRate`. Neither of those says anything about the POPULATION
 * behind them, and by then four separate things may have narrowed it:
 *
 *   • `--scenarios <file>`  replaced the 305-scenario battery outright
 *   • `--priced-probe N`    cut it to the N our own sheet prices (§2.115)
 *   • `--replay-partial`    cut it to what a capture can answer for (§2.120)
 *   • `--filter-*`          decided what "Lender Price said" even MEANS (§2.100)
 *
 * Every one of those was announced on the CONSOLE and nowhere else, so the moment the terminal scrolls
 * the only durable artifact is a file reading `total: 12, agreementRate: 91%` — with nothing recording
 * that 293 scenarios were deliberately excluded, or that the run never called Lender Price at all.
 * That is this workstream's recurring class one layer out: **an artifact confident about a population it
 * never measured**, and it is the §2.110 / §2.135 defect in a new costume.
 *
 * ⛔ THE SCOPE IS THE MOST DANGEROUS FIELD, not the counts. §2.100 measured what an unscoped run does:
 * our one-investor sheet is compared against every lender in the market, and the answer is "a confident
 * 0.00% that means nothing". The runner already REFUSES to run unscoped — but two reports taken under
 * DIFFERENT scopes are not comparable either, and nothing in either file said which scope produced it.
 *
 * ⛔ AND IT RECORDS WHAT WAS DECIDED, NEVER WHAT WAS INTENDED. Each narrowing is stamped with the count
 * before and after, by the code that actually did the narrowing, so the chain from the battery to the
 * scenarios that ran reconciles arithmetically or the guard fails.
 *
 * PURE: no IO, no clock (the caller supplies `runAt` — a module that reads the clock cannot be tested
 * against a fixed expectation, and this one is asserted on). LT-only. No RTL imports.
 */

/** The four ways a run can be narrowed, and the plain-language name of each. */
/**
 * THE VERSION OF THE *OURS* LEG WIRING, and it exists because of §2.122.
 *
 * Until 2026-08-19 the canary handed our engine the RAW Lender Price scenario, so it read none of the
 * deal's derived facts and declined 305 of 305 — filing confident refusals that named a rule
 * (`dhvn_min_dscr`) which had nothing to do with them. Every agreement rate recorded by that leg is
 * meaningless, and NOTHING on the row said so: a reader, a scoreboard, or the go-live gate computing a
 * clean-day streak over that series would be averaging numbers that were never measurements.
 *
 * A stamp cannot go back in time, and that is exactly why the ABSENCE of one is the signal: a run
 * carrying no `legVersion` was recorded before the leg was fixed, and is reported as unreadable rather
 * than averaged. Same shape as §2.120's pre-widening capture — recognised, not rescued.
 *
 * Bump this ONLY when a change alters what the legs MEASURE. It is not a build number: a stamp that
 * moved for an unrelated edit would retire a shelf of valid runs and teach everyone to ignore it.
 *
 * BUMPED to 2.124 on 2026-08-19, and the cost is deliberate. §2.124 measured that our engine answers in
 * THREE states — priced, declined, and "I could not price this" — and that the leg was reading two: an
 * unpriced quote had a state-law prepayment decline appended to it (`lp-agreement-legs`), and the
 * comparison then filed a HIGH-severity disagreement saying "our engine priced it" about a quote our
 * engine had refused to price. Both are the leg's OUTPUT, so a run recorded between the §2.122 fix and
 * this one carries real facts read through a two-state lens, and its disagreements cannot be told from
 * real ones. Retiring that shelf is the honest answer; averaging it is not.
 */
const LEG_VERSION = '2026-08-19/2.124';

const NARROWERS = Object.freeze({
  scenarios_file: 'a scenario file replaced the battery',
  priced_probe: 'the priced probe (our own sheet prices these)',
  replay_partial: 'the capture could only answer for these',
  battery_cap: 'the run-route battery cap',
});

function num(n) { return Number.isFinite(n) ? n : null; }

/**
 * A scope value, made SAFE TO PERSIST.
 *
 * ⛔ CAUGHT BY WRITING THE FILE AND READING IT BACK, not by inspection. `--filter-program-like` is a
 * RegExp, and `JSON.stringify(/^dscr/i)` is `{}` — so the console printed the scope correctly (String
 * coerces a RegExp) while the persisted report, the thing anybody actually reads later, silently
 * recorded an EMPTY scope. A report claiming an agreement rate with no scope beside it is the whole
 * defect §2.121 is about, reappearing inside the fix for it. Everything is coerced to a string here,
 * once, so a value that survives the console survives the file.
 */
function scopeValue(v) {
  if (v == null) return null;
  if (v instanceof RegExp) return v.toString();
  if (typeof v === 'string') return v || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function scopeToRecord(scope) {
  if (!scope || typeof scope !== 'object') return null;
  const out = {};
  for (const k of Object.keys(scope)) {
    const v = scopeValue(scope[k]);
    if (v != null && v !== 'undefined' && v !== '{}') out[k] = v;
  }
  return out;
}

/**
 * begin(battery) — start a provenance record from the population the run was OFFERED.
 *   battery — { name, offered }
 */
function begin(battery = {}) {
  return {
    runAt: null,
    lpSource: 'live',
    replayDir: null,
    battery: { name: battery.name || 'unknown', offered: num(battery.offered) },
    narrowing: [],
    ran: num(battery.offered),
    scope: null,
    disqualify: 'asked',
    sheet: null,
    ppp: null,
  };
}

/**
 * narrowed(prov, by, from, to, note) — record a cut, BY THE CODE THAT MADE IT.
 * An unrecognised reason is still recorded (never dropped) but is named as unrecognised, because a
 * narrowing nobody can name is exactly the thing this file exists to surface.
 */
function narrowed(prov, by, from, to, note) {
  const row = {
    by,
    label: NARROWERS[by] || `unrecognised narrowing (${by})`,
    from: num(from),
    to: num(to),
    dropped: (Number.isFinite(from) && Number.isFinite(to)) ? Math.max(0, from - to) : null,
  };
  if (note) row.note = String(note);
  prov.narrowing.push(row);
  prov.ran = row.to;
  return prov;
}

/** Did this run measure the whole population it started from? */
function coversWholeBattery(prov) {
  if (!prov || !Number.isFinite(prov.battery.offered) || !Number.isFinite(prov.ran)) return false;
  return prov.ran === prov.battery.offered && prov.narrowing.every((n) => n.dropped === 0);
}

/**
 * The arithmetic must reconcile: the battery, minus every recorded drop, IS what ran. A narrowing that
 * forgot to record itself shows up here as a gap rather than as a smaller number nobody questions.
 */
function reconciles(prov) {
  if (!prov || !Number.isFinite(prov.battery.offered) || !Number.isFinite(prov.ran)) return false;
  let n = prov.battery.offered;
  for (const step of prov.narrowing) {
    // A scenario FILE replaces the population rather than subtracting from it; every other narrowing
    // must start where the previous one ended, or a step went unrecorded between them.
    if (step.by === 'scenarios_file') { n = step.to; continue; }
    if (step.from !== n) return false;
    n = step.to;
  }
  return n === prov.ran;
}

/** `finish(prov, {runAt, ...})` — stamp the facts known only once the run is set up. */
function finish(prov, facts = {}) {
  const out = { ...prov };
  if (facts.runAt) out.runAt = String(facts.runAt);
  if (facts.lpSource) out.lpSource = facts.lpSource === 'replay' ? 'replay' : 'live';
  if (facts.replayDir) out.replayDir = String(facts.replayDir);
  if (facts.scope) out.scope = scopeToRecord(facts.scope);
  if (facts.disqualify) out.disqualify = facts.disqualify === 'skipped' ? 'skipped' : 'asked';
  if (facts.sheet) out.sheet = facts.sheet;
  if (facts.ppp) out.ppp = facts.ppp;
  out.legVersion = LEG_VERSION;
  out.coversWholeBattery = coversWholeBattery(out);
  out.reconciles = reconciles(out);
  return out;
}

/**
 * The plain lines a reader needs BESIDE the agreement percentage — never composed by a caller, so the
 * console and the persisted report cannot describe one run two ways.
 */
function describeProvenance(prov) {
  if (!prov) return ['(no provenance recorded — this report cannot say what it measured)'];
  const lines = [];
  lines.push(`ran ${prov.ran == null ? '?' : prov.ran} of ${prov.battery.offered == null ? '?' : prov.battery.offered}`
    + ` from ${prov.battery.name}`
    + (prov.lpSource === 'replay' ? ` · REPLAYED from ${prov.replayDir} (no paid call)` : ' · live paid run'));
  for (const step of prov.narrowing) {
    if (!step.dropped) continue;
    lines.push(`narrowed by ${step.label}: ${step.from} → ${step.to} (${step.dropped} not measured)`);
  }
  if (prov.scope) {
    const s = prov.scope;
    const bits = ['investor', 'program', 'programLike', 'product', 'lender']
      .filter((k) => s[k]).map((k) => `${k}=${s[k]}`);
    lines.push(`scope ${bits.length ? bits.join(' · ') : 'UNSCOPED — the whole market, not one investor'}`);
  }
  if (prov.disqualify === 'skipped') {
    lines.push('the refusal tree was NOT asked for — this run cannot say anything about eligibility');
  }
  if (prov.ppp) {
    lines.push(`prepayment layer ${prov.ppp.asked ? 'ASKED' : 'NOT asked'}`
      + `${prov.ppp.reason ? ` (${prov.ppp.reason})` : ''}`);
  }
  return lines;
}

/**
 * What the numbers in this report do NOT cover, in the words a reader needs. Empty means the run
 * measured the whole battery under a real scope with the refusal feed on.
 */
function provenanceWarnings(prov) {
  if (!prov) return ['This report does not record what it measured.'];
  const out = [];
  if (!prov.coversWholeBattery) {
    const dropped = prov.narrowing.reduce((n, s) => n + (s.dropped || 0), 0);
    out.push(`These numbers are about ${prov.ran} scenario(s), NOT the battery`
      + `${dropped ? ` — ${dropped} were deliberately excluded` : ''}. Do not read the agreement rate as battery-wide.`);
  }
  if (!prov.reconciles) {
    out.push('The scenario counts do NOT reconcile — something narrowed this run without recording it.'
      + ' Treat every number here as unexplained until that is found.');
  }
  if (prov.scope && !['investor', 'program', 'programLike', 'product', 'lender'].some((k) => prov.scope[k])) {
    out.push('This run was UNSCOPED: our one-investor sheet was compared against every lender in the'
      + ' market, so the agreement rate is not a measurement of that sheet (§2.100).');
  }
  if (prov.disqualify === 'skipped') {
    out.push('The refusal tree was not asked for, so the eligibility side of every scenario is unmeasured.');
  }
  // ⛔ THE PREPAYMENT LAYER, ON THE RECORD. §2.116 measured what a run without the investor's own Layer 3
  // does: a scenario the battery flags INELIGIBLE for "NJ Individual PPP prohibited" comes back PRICED,
  // and the run reports agreement on a loan the investor will not buy. The run ROUTE says so in its
  // HTTP response — but the response is read once and the RECORD is what the publish gate reads weeks
  // later, so without this a run that never asked is indistinguishable from one that did.
  if (prov.ppp && prov.ppp.asked === false) {
    out.push('The investor\'s prepayment layer was NOT asked on this run'
      + `${prov.ppp.reason ? ` (${prov.ppp.reason})` : ''}, so a whole layer of their own rules went`
      + ' unmeasured and a scenario that layer would refuse can be counted here as agreement (§2.116).');
  }
  // §2.122 — a run whose leg predates the fix is not a weak measurement, it is not a measurement.
  if (!prov.legVersion) {
    out.push('This run was recorded BEFORE the leg that converts a Lender Price scenario into engine'
      + ' facts was fixed (§2.122): our engine read none of the deal\'s derived facts, declined every'
      + ' scenario, and named a rule that had nothing to do with them. Its agreement rate is not a'
      + ' measurement and must not be averaged into a series or counted toward a clean-day streak.');
  }
  if (prov.lpSource === 'replay') {
    out.push('This is a REPLAY of stored vendor answers, not a fresh measurement — it says what Lender'
      + ' Price answered when the capture was taken, which may no longer be what it would answer today.');
  }
  return out;
}

/**
 * Can this stored run's numbers be read at all? PURE, and the ONE definition — a scoreboard, a gate and
 * a screen must not each decide this differently.
 *
 * `null`/absent provenance means the row predates §2.121a's recording OR §2.122's fix; either way the
 * honest answer is that its agreement rate cannot be read, because nothing on the row says which leg
 * produced it.
 */
function runIsReadable(summary) {
  try {
    const p = summary && summary.provenance;
    return !!(p && typeof p === 'object' && p.legVersion === LEG_VERSION);
  } catch (_) { return false; }
}

module.exports = {
  begin, narrowed, finish, describeProvenance, provenanceWarnings, runIsReadable,
  coversWholeBattery, reconciles, NARROWERS, LEG_VERSION,
  _internals: { scopeValue, scopeToRecord },
};

'use strict';
/**
 * THE FROZEN-ENGINE EQUIVALENCE BASELINE — one definition, for every overlay.
 *
 * Every authorized change to a frozen pricing engine here has to prove the same
 * thing: with the new lever UNENGAGED, the engine is byte-identical to the same
 * engine WITHOUT the lever. `scripts/test-target-loan-pure.js` and
 * `scripts/test-silver-arv-lever-pure.js` each wrote that machinery by hand;
 * this is it, extracted, so a third and fourth overlay cannot re-derive it
 * slightly differently — which is the drift the "one definition, never two"
 * rule exists to stop.
 *
 * THE BASELINE IS TODAY'S ENGINE WITH THE LEVER LINE(S) SURGICALLY REMOVED —
 * deliberately NOT "HEAD's committed copy". A git baseline proves inertness only
 * until the change is COMMITTED; the moment it lands, HEAD carries the lever too
 * and the comparison quietly degenerates into "the engine equals itself", which
 * passes forever while proving nothing.
 *
 * THREE GUARDS ON THE STRIP, and every one of them exists because an
 * adversarial audit defeated the version without it (CLAUDE.md records the two
 * sabotages that reported ALL PASS):
 *   1. the regex is /g and MATCHES ARE COUNTED, not replacements — a non-global
 *      `String.replace` rewrites only the FIRST occurrence, so a decoy second
 *      line of the same shape would leave the real lever in the baseline;
 *   2. an EXACT expected match count per file, so a lever that grows a second
 *      line fails loudly instead of being half-stripped;
 *   3. NO residual reference to the lever survives the strip — a differently
 *      shaped second use is caught by this and not by (1) or (2).
 *
 * A lever may be DELETED (`with` omitted) or NEUTRALIZED (`with` supplied). Some
 * levers are a guarded BLOCK whose whole existence hangs off one named constant;
 * there, rewriting that constant to a value the guard can never satisfy is
 * literally "the engine without the lever", and it is a one-line, countable,
 * verifiable edit — whereas deleting a multi-line block by regex is neither.
 * When a lever is neutralized rather than deleted, guard 3 cannot be a text
 * search, so the CALLER must instead PROVE THE STRIP BIT: run a scenario the
 * lever is known to engage and assert the baseline and the live engine DISAGREE
 * on it. That is a stronger statement than the text search anyway, and
 * `assertStripBit` below is the one place it is expressed.
 *
 * And the last guard lives in the CALLER because only it knows the lever's
 * meaning: a size comparison cannot see a change that leaves the size alone, so
 * every caller must also assert that the lever set beyond anything that could
 * bind is a COMPLETE no-op, comparing the whole priced result including the RATE.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'web/v2/tools');
const ALL_ENGINES = ['standard-program', 'gold-standard', 'silver-program'];

/**
 * Build lever-stripped copies of the engines and require() them.
 *
 * @param {Array<{re:RegExp, expect:object, with?:string, residual?:RegExp}>} levers
 *        `re` must be /gm and match whole lines; `expect` maps an engine name to
 *        how many lines it must match there (absent = 0, i.e. the lever does not
 *        live in that engine); `with` replaces the match instead of deleting it
 *        (see the header — used to neutralize a guarded block's own constant);
 *        `residual`, when given, must not match the stripped source.
 * @param {string[]} engines  which engines to build (default: all three)
 * @returns {object} engine name -> the baseline module
 */
function baselineEngines(levers, engines = ALL_ENGINES) {
  const written = [];
  const out = {};
  try {
    for (const e of engines) {
      const live = fs.readFileSync(path.join(DIR, `${e}.js`), 'utf8');
      let src = live;
      for (const lever of levers) {
        const want = Object.prototype.hasOwnProperty.call(lever.expect, e) ? lever.expect[e] : 0;
        const hits = src.match(lever.re) || [];
        if (hits.length !== want) {
          throw new Error(`${e}: expected exactly ${want} line(s) matching ${lever.re}, found ${hits.length} — the baseline strip cannot be trusted, so the equivalence proof would be vacuous`);
        }
        if (!want) continue;
        src = src.replace(lever.re, lever.with == null ? '' : lever.with);
        if (lever.residual && lever.residual.test(src)) {
          throw new Error(`${e}: the baseline still references ${lever.residual} after the strip — the lever was not removed`);
        }
      }
      // Written BESIDE the live engines, not in a temp dir: they `require`
      // siblings by relative path, which only resolve from that folder.
      // Dot-prefixed so test-engine-copies-match never mistakes one for a copy.
      const p = path.join(DIR, `.${e}-baseline-${process.pid}.js`);
      fs.writeFileSync(p, src);
      written.push({ name: e, path: p });
    }
    /* Gold and Silver reuse the STANDARD engine's sizeLoan through
       `require('./standard-program.js')`, so a baseline Gold loaded here would
       call the LIVE Standard and the comparison would be meaningless. Re-point
       each baseline's sibling require at the baseline Standard, so HEAD is
       compared against HEAD all the way down. */
    if (written.some((w) => w.name === 'standard-program')) {
      for (const w of written) {
        const body = fs.readFileSync(w.path, 'utf8')
          .replace(/(['"])\.\/standard-program\.js\1/g, `'./.standard-program-baseline-${process.pid}.js'`);
        fs.writeFileSync(w.path, body);
      }
    }
    for (const w of written) out[w.name] = require(w.path);
    return out;
  } finally {
    for (const w of written) { try { fs.unlinkSync(w.path); } catch (_) { /* best effort */ } }
  }
}

/** The live engines, for the other side of every comparison. */
function liveEngines(engines = ALL_ENGINES) {
  const out = {};
  for (const e of engines) out[e] = require(path.join(DIR, `${e}.js`));
  return out;
}

/** Everything worth comparing — the priced RESULT, never a summary. A change
 *  that leaves the loan size alone but moves the rate, a fee or a reason is
 *  exactly the sabotage this has to catch, so the rate and the reasons are in. */
function shape(ev) {
  if (!ev) return null;
  const s = ev.sizing || {};
  return JSON.stringify({
    status: ev.status, noteRate: ev.noteRate,
    totalLoan: s.totalLoan, acquisition: s.acquisition, rehabLoan: s.rehabLoan,
    downPayment: s.downPayment, ltcPct: s.ltcPct, acqLtvPct: s.acqLtvPct,
    arvPct: s.arvPct, binding: s.binding, bindKey: s.bindKey,
    financedIR: s.financedIR, costBasis: s.costBasis, rehabOverCap: s.rehabOverCap,
    caps: ev.caps, tier: ev.tier, tierLabel: ev.tierLabel,
    reasons: (ev.reasons || []).map((r) => `${r.level}:${r.msg}`),
  });
}

/**
 * PROVE THE STRIP BIT. A baseline that is accidentally identical to the live
 * engine makes every equivalence assertion vacuous AND SILENT — it reports ALL
 * PASS while comparing the engine to itself. So each caller names a scenario its
 * lever is known to engage and asserts the two sides genuinely disagree there.
 *
 * @param {function} assert   the caller's `assert(cond, message)`
 * @param {object} base       baselineEngines() result
 * @param {object} live       liveEngines() result
 * @param {object} engaging   an input the lever is known to engage
 * @param {string[]} engines  which engines must disagree on it
 * @param {string} what       named in the assertion message
 */
function assertStripBit(assert, base, live, engaging, engines, what) {
  for (const e of engines) {
    const b = shape(base[e].evaluate(engaging));
    const l = shape(live[e].evaluate(engaging));
    assert(b !== l,
      `the ${what} strip actually BIT on ${e} — the baseline and the live engine disagree on a scenario that engages it (otherwise every equivalence check below is vacuous)`);
  }
}

module.exports = { baselineEngines, liveEngines, shape, assertStripBit, ALL_ENGINES, DIR };

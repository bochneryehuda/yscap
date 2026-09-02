'use strict';
/**
 * LONG-TERM — HOW THE EFFECTIVE ROSTER IS LOADED, in one place.
 *
 * `investor-roster.js` is pure and takes the custom map as an ARGUMENT. Somebody
 * has to fetch that map from the settings store, and if every route did it for
 * itself there would be five loaders with five ideas of what an unreadable store
 * means. This is the one loader. Every door that needs "which investors exist
 * right now" — the combined engine, the general engine's roster door, the saved
 * investor groups, the loan-investor mirror — calls this and hands the answer
 * down.
 *
 * NEVER THROWS. An unreadable store yields the REGISTRY ALONE and says so in
 * `problem`, which is exactly how the engine behaved before custom investors
 * existed: a broken setting can cost the hand-added investors, never the board.
 *
 * SEPARATION: LT-only. Reads only the LT settings store.
 */

const settingsStore = require('../settings/store');
const roster = require('./investor-roster');
const investorSettings = require('./investor-settings');

function reasonOf(e) {
  if (!e) return 'unknown_error';
  return String(e.message || e.code || e.name || 'error').slice(0, 300);
}

/**
 * The custom investors in force: `{ custom: Map, raw, problems, problem }`.
 * `problems` names what the tolerant read dropped; `problem` is the store
 * refusing to answer at all.
 */
async function loadCustom() {
  try {
    // `load` rather than `get`, because it is the one that SAYS whether the
    // stored values could be read. `get` answers the declared default on an
    // unreadable store, which is right for a value with a sensible default and
    // wrong here: "nobody has added an investor" and "we could not find out"
    // are different answers, and only one of them should make a screen say so.
    const s = await settingsStore.load('company');
    const stored = s.settings[roster.SETTING_KEY];
    const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const read = roster.readCustom(raw);
    return {
      custom: read.custom,
      raw,
      problems: read.problems,
      problem: s.degraded ? 'the settings store could not be read' : null,
      settingsAll: s,
    };
  } catch (e) {
    return { custom: roster.EMPTY, raw: {}, problems: [], problem: reasonOf(e) };
  }
}

/**
 * The custom map AND the per-investor settings, read against it — what a door
 * needs to say which investors exist and what each may be called. `settings`
 * is the READ map (`investor-settings.readSettings`), never the raw one.
 */
async function load() {
  const c = await loadCustom();
  let settings = {};
  let settingsProblems = [];
  let settingsProblem = null;
  try {
    // The same read the custom map came off, so the two halves of one roster can
    // never describe two different moments.
    const stored = c.settingsAll
      ? c.settingsAll.settings['pricing.combinedInvestors']
      : await settingsStore.get('pricing.combinedInvestors', 'company');
    const r = investorSettings.resolveRaw({ stored });
    const cfg = investorSettings.readSettings(r.raw, c.custom);
    settings = cfg.settings;
    settingsProblems = cfg.problems;
  } catch (e) {
    settingsProblem = reasonOf(e);
  }
  return {
    custom: c.custom,
    customProblems: c.problems,
    customProblem: c.problem,
    settings,
    settingsProblems,
    settingsProblem,
    // Said out loud rather than left to be inferred from an empty list: a
    // roster read while the store was down is the registry's idea of the
    // world, not the company's.
    degraded: !!(c.problem || settingsProblem),
  };
}

module.exports = { loadCustom, load };

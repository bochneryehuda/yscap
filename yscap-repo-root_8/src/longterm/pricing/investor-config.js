'use strict';
/**
 * THE INVESTOR CONFIGURATION, READ ONCE, FOR BOTH ENGINES.
 *
 * Which investors are on, what a client may call each one, which rate sheet each
 * is fetched from, and what margin is held back — four stored settings that the
 * Combined Pricing Engine has read since it was built, and that the General
 * Pricing Engine now reads too (owner-directed 2026-09-03: the side-by-side list
 * lives in the general engine's settings and governs both boards).
 *
 * ⛔ WHY THIS MODULE EXISTS RATHER THAN A SECOND COPY OF FOUR SMALL FUNCTIONS.
 * The settings are addressed by KEY STRINGS. Two engines each holding their own
 * copy of `'pricing.combinedInvestors'` is a rename away from one screen saving
 * to a key the other never reads — the officer turns an investor off, the board
 * keeps quoting it, and nothing anywhere fails. One definition, so the keys
 * cannot drift apart.
 *
 * EVERY READ IS NON-THROWING AND SAYS WHEN IT FAILED. A settings store that is
 * briefly unreachable must not cost a board: the caller gets the declared default
 * plus a `problem`, so it can price with the standing configuration and still
 * report that the saved one could not be read. Silently answering "no investors
 * are configured" would empty a board and look like a rate sheet outage.
 */

const settingsStore = require('../settings/store');
const routing = require('./investor-routing');
const investorLinks = require('./investor-links');
const rosterContext = require('./roster-context');
const sightings = require('./investor-sightings');

/** The stored keys, named once. */
const KEYS = {
  investors: 'pricing.combinedInvestors',
  marginHoldback: 'pricing.combinedMarginHoldback',
  links: investorLinks.SETTING_KEY,
  sightings: sightings.SETTING_KEY,
};

const reasonOf = (e) => String((e && e.message) || e || 'unknown').slice(0, 200);

/** Per-investor settings: on/off, white label, source, per-investor holdback. */
async function investorsRaw() {
  try {
    const stored = await settingsStore.get(KEYS.investors, 'company');
    return routing.resolveRaw({ stored });
  } catch (e) {
    return { ...routing.resolveRaw({ stored: null }), problem: reasonOf(e) };
  }
}

/** The standing margin holdback. `undefined` means "nobody has set one". */
async function holdbackRaw() {
  try {
    return await settingsStore.get(KEYS.marginHoldback, 'company');
  } catch (_) {
    return undefined;
  }
}

/** "This name and this name are the same investor" — recorded by a person. */
async function linksRaw() {
  try {
    const stored = await settingsStore.get(KEYS.links, 'company');
    return { raw: stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}, problem: null };
  } catch (e) {
    return { raw: {}, problem: reasonOf(e) };
  }
}

/** The investors somebody added by hand. */
async function customRaw() {
  return rosterContext.loadCustom();
}

/** Which rate sheet has produced which investor — the measured "available on" register. */
async function sightingsRaw() {
  try {
    const stored = await settingsStore.get(KEYS.sightings, 'company');
    return { ...sightings.read(stored), problem: null };
  } catch (e) {
    return { ...sightings.read(null), problem: reasonOf(e) };
  }
}

/**
 * RECORD WHAT A BOARD ACTUALLY RETURNED — the ONE writer of the sightings register.
 *
 * ⛔ THE ONLY WRITE IN A MODULE OF READS, AND IT IS DELIBERATE. The keys live here (see
 * the header), and a second module writing `pricing.investorSightings` would be a second
 * place that string can drift from the readers. So the write stays beside its key.
 *
 * ⛔ IT MAY NEVER COST A BOARD. A search has already happened by the time this runs; a
 * settings store that is briefly unwritable must cost the "available on" column and
 * nothing else, so every failure is swallowed and reported in the return value. It also
 * refuses a source that did not ANSWER — a vendor outage is no evidence about any
 * investor, and recording one would lock out every investor that sheet normally carries.
 */
async function recordSightings(observed, opts = {}) {
  const at = opts.at || new Date().toISOString();
  try {
    const stored = await settingsStore.get(KEYS.sightings, 'company');
    let next = stored;
    for (const source of sightings.SOURCES) {
      const o = observed && observed[source];
      if (!o || o.answered === false) continue;
      next = sightings.record(next, { source, keys: o.keys || [], at, answered: true });
    }
    if (next === stored) return { ok: true, wrote: false };
    await settingsStore.save({ [KEYS.sightings]: next }, {
      scope: 'company', staffId: opts.staffId || null,
    });
    return { ok: true, wrote: true };
  } catch (e) {
    return { ok: false, wrote: false, problem: reasonOf(e) };
  }
}

module.exports = {
  KEYS, investorsRaw, holdbackRaw, linksRaw, customRaw, sightingsRaw, recordSightings,
  _internals: { reasonOf },
};

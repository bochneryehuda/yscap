'use strict';
/**
 * LONG-TERM — THE INVESTOR SETTINGS: one row per investor, saying what we call
 * them, where their pricing is fetched, and whether they are on at all.
 *
 * ── THE OWNER'S ASK ────────────────────────────────────────────────────────
 * 2026-08-30: *"You should open a settings menu where you have every single
 * investor listed. Pre-fill a white label name for everybody, and if their
 * products are coming up, pre-fill where it's fetching their product: if it's
 * coming from Lender Price or from LoanNEX. For Button Finance, just pre-fill
 * that as off, and whenever we're ready for it, we're gonna turn it on over
 * there… For every investor, we can always switch it from where we want to take
 * the information."*
 *
 * ── EVERY INVESTOR, NOT EVERY INVESTOR WE HAPPEN TO HAVE SEEN ──────────────
 * The roster is DERIVED from the investor registry (`encompass/investors.js`,
 * the one identity sheet), so an investor added there appears here with no
 * second list to remember. A hand-kept roster is a roster that goes stale the
 * day somebody adds the forty-third investor.
 *
 * ── ONE INVESTOR, ONE SOURCE — that is what makes it read as one system ────
 * Owner-directed, same day: *"At our system, it shouldn't be a difference from
 * where it's taking the information… it should sound like one system. It
 * shouldn't sound like it's coming from different places."*
 *
 * So the DEFAULT is a single source, not both. Showing one investor from two
 * vendors puts two rows for one company on the board, from two places — which
 * is precisely the thing that must not happen. `both` remains a CHOICE, because
 * seeing them side by side is genuinely useful when deciding which to keep, but
 * nothing is on it unless somebody asks.
 *
 * The pre-filled source is `lenderprice` — that is where the system fetches
 * everything today, and the owner's own framing is *"not touch our own pricing
 * engine that we currently have"*. The three that move are named below.
 *
 * ── A WHITE LABEL IS NEVER INVENTED ────────────────────────────────────────
 * The pre-fill comes from the existing white-label sheet. Where an investor has
 * none, the row is present with the box EMPTY and `whiteLabelMissing: true` —
 * it is not filled with a guess and never with the real name. That is the
 * standing hard rule: the white label is the one name a client may see, so an
 * invented one goes in front of borrowers and brokers. The empty ones are
 * reported by `needsWhiteLabel()` so they can be named on purpose.
 *
 * PURE: no network, no database, no RTL import.
 */

const investors = require('../encompass/investors');
const whiteLabel = require('../lenderprice/investor-programs');

/**
 * Where an investor's pricing may be fetched.
 *
 * `both` means the two MULTI-INVESTOR aggregators side by side — it predates the
 * third entry and its meaning is unchanged.
 *
 * ⚠️ `ahl` IS NOT AN AGGREGATOR AND IS NOT INTERCHANGEABLE WITH THE OTHER TWO.
 * American Heritage Lending's Quick Pricer prices AHL's own sheet and nobody
 * else's, so it can only ever be the source for ONE investor. Setting it on any
 * other is accepted-and-reported rather than silently honoured, because an
 * investor pointed at a source that structurally cannot quote them would show an
 * empty row with a plausible-sounding reason. See `SINGLE_INVESTOR_SOURCES`.
 */
const SOURCES = ['lenderprice', 'loannex', 'both', 'ahl'];
/**
 * The most an investor's own extra may be, either way — the same decimal-slip
 * guard the global holdback carries, and deliberately the same number, because
 * two different ceilings for one kind of figure is how a screen ends up
 * accepting what the board then refuses. It is stated here rather than imported
 * so this module stays free of the pricing side; the pure test runs both.
 */
const MAX_INVESTOR_HOLDBACK = 10;
/** What everything is fetched from today. */
const DEFAULT_SOURCE = 'lenderprice';

/** A source that can only ever quote one named investor, and which one. */
const SINGLE_INVESTOR_SOURCES = { ahl: 'american_heritage' };

/**
 * THE THREE THE OWNER MOVED. *"There are three investors that are actually using
 * LoanNEX for their locking, and it's much more accurate: NQM, ACRA and eResi…
 * It shouldn't populate these three investors out of Lender Price, and these
 * three investors should be populated out of LoanNEX instead."*
 *
 * The reason is the part worth keeping: those three LOCK on LoanNEX, so that is
 * where their real execution lives and Lender Price's copy of it is second-hand.
 */
const OWNER_SOURCE = {
  nqm: 'loannex',
  acra: 'loannex',
  eresi: 'loannex',
  /**
   * AMERICAN HERITAGE LENDING — owner-directed 2026-08-30: *"This particular
   * integration is going to be for American Heritage Lending auto link. It and
   * the price should populate from here."* AHL publishes its own live Quick
   * Pricer, so this is their sheet first-hand rather than an aggregator's copy
   * of it — the same reason NQM, Acra and eResi were moved to LoanNEX.
   *
   * It is a PRE-FILL like every other row here: the settings screen can move it
   * back to Lender Price at any time, and `prefill` below is what offers the way
   * back.
   */
  american_heritage: 'ahl',
};

/**
 * OFF unless somebody turns them on. *"For Button Finance, just pre-fill that as
 * off, and whenever we're ready for it, we're gonna turn it on over there. We're
 * gonna put in the white label name for it, and we're gonna put it there so that
 * it should take it from LoanNEX."*
 *
 * Note this is now a SETTING and no longer a rule baked into the code — which is
 * exactly what makes "whenever we're ready" a switch rather than a deploy.
 */
const OWNER_DISABLED = {
  button_finance: 'Owner-directed 2026-08-30: pre-filled off. Turn it on with its white-label name and LoanNEX as its source when ready.',
};

const isSource = (v) => SOURCES.includes(String(v || '').toLowerCase());

/**
 * Read the saved overrides.
 *
 * TODAY: `LT_INVESTOR_SETTINGS`, a JSON object keyed by canonical investor key:
 *   {"acra":{"source":"loannex"},"button_finance":{"enabled":true,"whiteLabel":"Slate","source":"loannex"}}
 *
 * The shape is deliberately the shape one `lt_pricing_investor_settings` row
 * would have, so moving this into a table later is a reader change rather than a
 * redesign. Anything unreadable is REPORTED BY NAME and ignored — a typo'd
 * source silently read as "off" would hide a lender nobody meant to hide.
 */
function readSettings(raw) {
  const src = raw !== undefined ? raw : process.env.LT_INVESTOR_SETTINGS;
  const out = { settings: {}, problems: [] };
  if (src == null || src === '') return out;
  let obj = src;
  if (typeof src === 'string') {
    try { obj = JSON.parse(src); }
    catch (_) { out.problems.push({ error: 'unparsable', message: 'LT_INVESTOR_SETTINGS is not valid JSON, so no investor setting was applied.' }); return out; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    out.problems.push({ error: 'not_an_object', message: 'LT_INVESTOR_SETTINGS must be an object of investorKey -> {source, enabled, whiteLabel}.' });
    return out;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (!value || typeof value !== 'object') { out.problems.push({ investor: key, error: 'not_an_object', message: 'Each investor\'s setting must be an object.' }); continue; }
    const row = {};
    if (value.source !== undefined) {
      if (!isSource(value.source)) { out.problems.push({ investor: key, error: 'unknown_source', value: String(value.source), message: `Source must be one of ${SOURCES.join(', ')}.` }); }
      else {
        const src = String(value.source).toLowerCase();
        const only = SINGLE_INVESTOR_SOURCES[src];
        // KEPT AND REPORTED, never silently dropped. The setting is honoured so
        // nobody's saved choice disappears without a word, and the problem is
        // named so a screen can say WHY that investor's row will be empty rather
        // than leaving somebody to conclude the vendor is down.
        if (only && only !== key) {
          out.problems.push({
            investor: key, error: 'single_investor_source', value: src,
            message: `${src} prices only ${only} — it is that investor's own pricer, not an aggregator, so it can never quote ${key}. The setting is kept, but this investor will have no programs while it stands.`,
          });
        }
        row.source = src;
      }
    }
    if (value.enabled !== undefined) {
      if (value.enabled !== true && value.enabled !== false) out.problems.push({ investor: key, error: 'non_boolean_enabled', message: 'enabled must be true or false.' });
      else row.enabled = value.enabled;
    }
    if (value.whiteLabel !== undefined) {
      const wl = String(value.whiteLabel == null ? '' : value.whiteLabel).trim();
      if (wl) row.whiteLabel = wl;
    }
    /**
     * THIS INVESTOR'S OWN EXTRA MARGIN HOLDBACK (owner-directed 2026-08-30:
     * *"We can add extra company margin holdbacks on top of each and every
     * program. If it's a set on LoanNEX, we should be able to increase or
     * decrease the margin holdbacks accordingly."*).
     *
     * SIGNED, and a deliberate 0 is kept: positive adds on top of whatever the
     * source holds back, negative takes it back down, and zero is a person
     * saying "nothing extra here" — which must be distinguishable from nobody
     * having answered, or a screen could never show which rows were decided.
     *
     * ⛔ REFUSED VALUES ARE REPORTED BY NAME, never quietly dropped and never
     * quietly applied. This number moves the price of every quote from one
     * investor, so a typo that silently became a holdback would be a mis-priced
     * board nobody could account for. The BOUNDS are the same decimal-slip
     * guard the global figure carries; what the total may be is settled later,
     * in `vendor-margin`, which is where the base it is added to lives.
     */
    if (value.holdback !== undefined && value.holdback !== null && value.holdback !== '') {
      const n = Number(value.holdback);
      if (!Number.isFinite(n)) {
        out.problems.push({ investor: key, error: 'holdback_not_a_number', value: String(value.holdback), message: 'An investor\'s extra margin holdback must be a number.' });
      } else if (Math.abs(n) > MAX_INVESTOR_HOLDBACK) {
        out.problems.push({ investor: key, error: 'holdback_too_large', value: n, message: `${n} points looks like a slipped decimal — an investor's extra may be at most ${MAX_INVESTOR_HOLDBACK} points either way.` });
      } else {
        row.holdback = Math.round(n * 1000) / 1000;
      }
    }
    if (!investors.byKey || !investors.byKey(key)) out.problems.push({ investor: key, error: 'unknown_investor', message: 'No investor by that key — the setting is kept, but nothing will match it.' });
    if (Object.keys(row).length) out.settings[key] = row;
  }
  return out;
}

/**
 * WHICH SAVED COPY IS IN FORCE — there is exactly one, never a merge of two.
 *
 * The settings screen writes to the LT settings store (`pricing.combinedInvestors`);
 * `LT_INVESTOR_SETTINGS` was the pilot's environment fallback and is kept so a
 * deployment can still be steered without a screen. Merging the two would be a
 * second source of truth for one answer, and the half that drifted would be the
 * half somebody priced a loan on — so the STORE WINS as soon as it holds
 * anything, and the environment answers only while it holds nothing.
 *
 * Reports WHICH, so a screen can say where the answer came from rather than
 * leaving somebody to guess why their environment variable stopped mattering.
 */
function resolveRaw(input = {}) {
  const stored = input.stored;
  if (stored && typeof stored === 'object' && !Array.isArray(stored) && Object.keys(stored).length) {
    return { raw: stored, origin: 'settings' };
  }
  const env = input.env !== undefined ? input.env : process.env.LT_INVESTOR_SETTINGS;
  if (env != null && env !== '') return { raw: env, origin: 'environment' };
  return { raw: null, origin: 'none' };
}

/** One investor's effective row. */
function settingFor(key, settings = {}) {
  const saved = settings[key] || {};
  const label = (investors.byKey && investors.byKey(key) || {}).label || key;

  const wlSheet = whiteLabel.whiteLabelOf(key) || null;
  const wl = saved.whiteLabel || wlSheet || null;

  const source = isSource(saved.source) ? saved.source
    : (OWNER_SOURCE[key] || DEFAULT_SOURCE);
  const sourceOrigin = isSource(saved.source) ? 'setting'
    : (OWNER_SOURCE[key] ? 'owner_directed' : 'default');

  const disabledNote = OWNER_DISABLED[key] || null;
  const enabled = saved.enabled !== undefined ? saved.enabled : !disabledNote;
  const enabledOrigin = saved.enabled !== undefined ? 'setting'
    : (disabledNote ? 'owner_directed' : 'default');

  return {
    key, label,
    whiteLabel: wl,
    // Said out loud rather than left for a reader to notice a null: this
    // investor has NO name a client may be shown, so they cannot be put in front
    // of one until somebody names them.
    whiteLabelMissing: !wl,
    whiteLabelOrigin: saved.whiteLabel ? 'setting' : (wlSheet ? 'sheet' : 'unset'),
    source, sourceOrigin,
    enabled, enabledOrigin,
    // WHAT THIS INVESTOR ADDS TO (or takes off) THE HOLDBACK, and whether a
    // person chose it. Nobody having answered is 0 with origin `default`, and a
    // deliberate 0 is 0 with origin `setting` — the same distinction the source
    // and the on/off switch already make, for the same reason.
    holdback: saved.holdback !== undefined ? saved.holdback : 0,
    holdbackOrigin: saved.holdback !== undefined ? 'setting' : 'default',
    note: disabledNote,
    // WHAT THIS ROW WOULD ANSWER WITH NO SETTING OF ITS OWN — the standing
    // instruction where there is one, the plain default otherwise. A settings
    // screen needs it to offer the way BACK: without it "use the pre-fill" could
    // only be described, never shown, so nobody would press it without knowing
    // what the row is about to become.
    prefill: {
      source: OWNER_SOURCE[key] || DEFAULT_SOURCE,
      enabled: !OWNER_DISABLED[key],
      whiteLabel: wlSheet || null,
      // No investor carries an extra unless somebody puts one there — the
      // owner's rule is one standing holdback for the feed, and an extra is a
      // decision about ONE investor.
      holdback: 0,
    },
  };
}

/** Every investor, in one list, ready to be drawn as a settings screen. */
function roster(settings = {}) {
  return investors.list()
    .map((x) => settingFor(x.key || x, settings))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

/** The investors with no client-safe name yet — the ones to go and name. */
function needsWhiteLabel(settings = {}) {
  return roster(settings).filter((r) => r.whiteLabelMissing).map((r) => ({ key: r.key, investor: r.label }));
}

/** The whole picture a settings screen needs, in one call. */
function describe(raw, opts = {}) {
  const cfg = readSettings(raw);
  const rows = roster(cfg.settings);
  return {
    sources: SOURCES,
    defaultSource: DEFAULT_SOURCE,
    investors: rows,
    problems: cfg.problems,
    // Where the saved copy in force came from — a screen that could not say this
    // would leave somebody wondering why their environment variable stopped
    // mattering the moment the screen was first used.
    origin: opts.origin || null,
    summary: {
      total: rows.length,
      on: rows.filter((r) => r.enabled).length,
      off: rows.filter((r) => !r.enabled).length,
      fromLenderPrice: rows.filter((r) => r.enabled && r.source === 'lenderprice').length,
      fromLoanNex: rows.filter((r) => r.enabled && r.source === 'loannex').length,
      fromBoth: rows.filter((r) => r.enabled && r.source === 'both').length,
      fromAhl: rows.filter((r) => r.enabled && r.source === 'ahl').length,
      missingWhiteLabel: rows.filter((r) => r.whiteLabelMissing).length,
      // How many investors carry an extra of their own, so a screen can say at a
      // glance whether the board is priced on one number or several.
      withExtraHoldback: rows.filter((r) => r.holdbackOrigin === 'setting' && r.holdback !== 0).length,
    },
    note: 'One investor, one source — a row on the board comes from one place, so the board reads as one system. `both` is available for comparing, but nothing is on it unless it is set.',
  };
}

module.exports = {
  SOURCES, DEFAULT_SOURCE, OWNER_SOURCE, OWNER_DISABLED, SINGLE_INVESTOR_SOURCES, MAX_INVESTOR_HOLDBACK,
  readSettings, resolveRaw, settingFor, roster, needsWhiteLabel, describe,
  _internals: { isSource },
};

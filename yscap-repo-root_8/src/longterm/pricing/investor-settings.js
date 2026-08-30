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

/** Where an investor's pricing may be fetched. */
const SOURCES = ['lenderprice', 'loannex', 'both'];
/** What everything is fetched from today. */
const DEFAULT_SOURCE = 'lenderprice';

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
      else row.source = String(value.source).toLowerCase();
    }
    if (value.enabled !== undefined) {
      if (value.enabled !== true && value.enabled !== false) out.problems.push({ investor: key, error: 'non_boolean_enabled', message: 'enabled must be true or false.' });
      else row.enabled = value.enabled;
    }
    if (value.whiteLabel !== undefined) {
      const wl = String(value.whiteLabel == null ? '' : value.whiteLabel).trim();
      if (wl) row.whiteLabel = wl;
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
    note: disabledNote,
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
      missingWhiteLabel: rows.filter((r) => r.whiteLabelMissing).length,
    },
    note: 'One investor, one source — a row on the board comes from one place, so the board reads as one system. `both` is available for comparing, but nothing is on it unless it is set.',
  };
}

module.exports = {
  SOURCES, DEFAULT_SOURCE, OWNER_SOURCE, OWNER_DISABLED,
  readSettings, resolveRaw, settingFor, roster, needsWhiteLabel, describe,
  _internals: { isSource },
};

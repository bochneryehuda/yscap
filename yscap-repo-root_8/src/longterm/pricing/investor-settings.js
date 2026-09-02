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
 * ── THE INVESTORS ADDED BY HAND (2026-09-02) ────────────────────────────────
 * The roster is now the EFFECTIVE roster — the registry plus the investors a
 * super admin added on the settings screen (`pricing.customInvestors`, read
 * through `pricing/investor-roster.js`). Every reader here takes that map as an
 * OPTIONAL trailing argument and stays pure; the route loads it once and hands
 * it down. A hand-added investor gets a settings row exactly like a registry
 * one — on/off, source, holdback, white label — and its recorded white label
 * is the pre-fill where the sheet's would be (`whiteLabelOrigin: 'custom'`).
 *
 * PURE: no network, no database, no RTL import.
 */

const effective = require('./investor-roster');
const whiteLabel = require('../lenderprice/investor-programs');

/** Where an investor's pricing may be fetched. */
const SOURCES = ['lenderprice', 'loannex', 'both'];
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
 *
 * `custom` is the hand-added investors in force; a key is "known" when EITHER
 * the registry or that map carries it.
 */
function readSettings(raw, custom) {
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
      /**
       * ⛔ AND IT IS JUDGED, NOT JUST TRIMMED (audit N9). This setting's `whiteLabel` OUTRANKS the
       * hand-added roster's (`investor-programs.effectiveWhiteLabel` reads it first), and it was
       * the one investor map with no check on it at all. Reproduced: `oaktree` with the
       * client-safe name "Deephaven Group" stored with `problems: []`, and a borrower then read
       *
       *     Your our capital partner Group quote is ready to review.
       *
       * — the investor-name block doing its job on a name that was never safe to show, producing
       * nonsense on a client-facing quote. Not a name LEAK (the PDF chokepoint and the borrower
       * reads scrub every string), but the same defect class, and exactly the artefact the
       * hand-added investor work cites as the harm it set out to prevent.
       *
       * ⛔ THE SAME ROUTINE, NOT A SECOND COPY. `roster.whiteLabelProblem` is what the hand-added
       * door already uses: it checks the name against every registry spelling and every sheet
       * name, and then does the ROUND TRIP — would a client actually read this, or would the block
       * blank it out? Two routines for one question is how two doors come to disagree about the
       * same name.
       *
       * DROPPED AND NAMED, never stored: a refused name leaves the investor with whatever it had,
       * which is the sheet's name or none — the same direction every other refusal here takes.
       */
      const bad = wl ? require('./investor-roster')._internals
        .whiteLabelProblem(key, key, wl, require('./investor-roster')._internals.takenNames(), custom) : null;
      if (bad) out.problems.push({ investor: key, error: bad.problem, message: bad.message });
      else if (wl) row.whiteLabel = wl;
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
    if (!effective.effectiveByKey(key, custom)) out.problems.push({ investor: key, error: 'unknown_investor', message: 'No investor by that key — not in the registry and not one added by hand. The setting is kept, but nothing will match it.' });
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
function settingFor(key, settings = {}, custom) {
  const saved = settings[key] || {};
  const inv = effective.effectiveByKey(key, custom);
  const label = (inv && inv.label) || key;
  const isCustom = !!(inv && inv.custom);

  // The RECORDED name — the owner's sheet for a registry investor, the name a
  // person typed when adding one by hand — and then the one answer to "what may
  // a client call this investor", with the row's own setting laid over it.
  const wlSheet = whiteLabel.whiteLabelOf(key, custom) || null;
  const wl = whiteLabel.effectiveWhiteLabel(key, custom, settings) || null;

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
    // Said plainly on the row, so a screen can mark an investor somebody added
    // by hand without a second lookup — and so a client-facing surface can
    // never mistake one for a registry entry with a sheet name.
    custom: isCustom,
    whiteLabel: wl,
    // Said out loud rather than left for a reader to notice a null: this
    // investor has NO name a client may be shown, so they cannot be put in front
    // of one until somebody names them.
    whiteLabelMissing: !wl,
    whiteLabelOrigin: saved.whiteLabel ? 'setting' : (wlSheet ? (isCustom ? 'custom' : 'sheet') : 'unset'),
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

/** Every investor — registry and hand-added — in one list, ready to be drawn as a settings screen. */
function roster(settings = {}, custom) {
  return effective.effectiveList(custom)
    .map((x) => settingFor(x.key || x, settings, custom))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

/** The investors with no client-safe name yet — the ones to go and name. */
function needsWhiteLabel(settings = {}, custom) {
  return roster(settings, custom).filter((r) => r.whiteLabelMissing).map((r) => ({ key: r.key, investor: r.label }));
}

/** The whole picture a settings screen needs, in one call. `opts.custom` is the hand-added investors in force. */
function describe(raw, opts = {}) {
  const custom = opts.custom;
  const cfg = readSettings(raw, custom);
  const rows = roster(cfg.settings, custom);
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
      // How many of the rows are investors somebody added by hand, so a screen
      // can say "42 from the registry and 1 you added" rather than 43.
      custom: rows.filter((r) => r.custom).length,
      // How many investors carry an extra of their own, so a screen can say at a
      // glance whether the board is priced on one number or several.
      withExtraHoldback: rows.filter((r) => r.holdbackOrigin === 'setting' && r.holdback !== 0).length,
    },
    note: 'One investor, one source — a row on the board comes from one place, so the board reads as one system. `both` is available for comparing, but nothing is on it unless it is set.',
  };
}

module.exports = {
  SOURCES, DEFAULT_SOURCE, OWNER_SOURCE, OWNER_DISABLED, MAX_INVESTOR_HOLDBACK,
  readSettings, resolveRaw, settingFor, roster, needsWhiteLabel, describe,
  _internals: { isSource },
};

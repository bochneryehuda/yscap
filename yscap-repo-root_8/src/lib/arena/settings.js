'use strict';
/**
 * THE MASTER SWITCH -- the one definition of whether the Arena exists at all.
 *
 * THE OWNER'S RULE, IN THEIR WORDS: "we should be able to turn this on and off
 * from the admin side. When it's turned off, nobody should even see that
 * setting. It should only be seen once it's turned on ... make sure we can turn
 * it off and it disappears on everybody's windows, [and we] can turn back on
 * next time we want to play something like this."
 *
 * SO OFF MEANS GONE, NOT GREYED OUT. With the switch off:
 *   - no nav entry, no screen, no badge, nothing on anybody's window;
 *   - every /api/arena route answers 404 -- the same answer a route that was
 *     never built would give, so the feature is not merely hidden but
 *     unreachable;
 *   - the stored sessions, spins, draws and awards are untouched and come back
 *     exactly as they were when it is switched on again.
 *
 * THE ONE DELIBERATE EXCEPTION, and why it has to exist. A SUPER ADMIN can
 * always reach the switch itself (`GET`/`PUT /api/arena/settings`). A switch
 * that hides itself when off can never be turned back on, which would make
 * "turn it off" a one-way door and contradict the same sentence that asked for
 * it. Nobody else -- not an admin, not a loan officer -- sees anything.
 *
 * FAILS CLOSED. If the settings row cannot be read, `isEnabled()` answers
 * FALSE and says why in the log. A game that quietly turns itself on because a
 * query timed out is far worse than a game that stays off; the whole point of
 * the switch is that the owner decides, not a transient error.
 *
 * DEFAULTS LIVE HERE, NOT IN THE DATABASE. The stored row holds only what an
 * admin actually changed; everything else is resolved against DEFAULTS below.
 * That way adding a new setting needs no migration and no backfill, and an old
 * row can never mean "off" for a setting that did not exist when it was saved.
 */

function db() { return require('../../db'); }

/**
 * Company-wide defaults. The money caps are the owner's own numbers for
 * Elementix Day, pre-filled as SETTINGS an admin can change per spin -- never
 * hard-coded, because the owner asked for them as a starting point ("for
 * example ... up to five hundred ... up to a thousand dollars"), not as a law.
 */
const DEFAULTS = Object.freeze({
  // Money, in CENTS. Never floats.
  personalCapCents: 50000,      // "anything not related to business ... up to five hundred"
  businessCapCents: 100000,     // "everything that is related to business ... up to a thousand dollars"
  entriesPerPerson: 1,          // how many things one person may put forward per spin
  requireEntryApproval: true,   // "super admin accepts everything"

  // The deadline alarms, in minutes BEFORE the cutoff. The owner's example was
  // an alarm at eleven for an 11:38 deadline -- 38 minutes -- so the list is
  // theirs to set; these are simply sensible starting points.
  reminderOffsetsMinutes: [60, 30, 10],
  emailReminders: true,
  emailResults: true,

  // The live room.
  chatEnabled: true,
  chatSlowModeSeconds: 2,
  suggestionsEnabled: true,
  showOddsToEveryone: true,     // never hide the weights: undisclosed weighting
                                // is the number-one "was that rigged?" complaint
  showFairnessProof: true,

  // The wheel.
  soundEnabled: true,
  confettiEnabled: true,
  defaultDurationMs: 7000,
  defaultFullTurns: 6,

  // Housekeeping.
  tvModeEnabled: true,
  boardName: 'The Arena',
});

const SETTING_KEYS = Object.keys(DEFAULTS);

// A short cache, for the same reason lib/flags.js has one: the switch is
// checked on every single Arena request and on every nav render, and a
// round-trip per check would be silly. Five seconds is short enough that
// flipping the switch clears the room within one refresh, and every WRITE
// invalidates it immediately, so the only staleness is across processes.
const CACHE_MS = 5000;
let cache = null;
let cacheAt = 0;

function shape(row) {
  const stored = (row && row.settings && typeof row.settings === 'object') ? row.settings : {};
  const settings = { ...DEFAULTS };
  for (const k of SETTING_KEYS) if (stored[k] !== undefined) settings[k] = stored[k];
  return {
    enabled: !!(row && row.enabled),
    settings,
    updatedAt: row ? row.updated_at : null,
    updatedBy: row ? row.updated_by : null,
    // Truthful about where the answer came from. `readable:false` means the
    // switch was NOT read and the OFF above is a fail-closed default, not a
    // recorded choice -- the admin screen says so rather than implying the
    // owner turned it off.
    readable: !!row,
  };
}

/** Read the settings row, honouring the short cache. Never throws. */
async function load({ fresh = false } = {}) {
  if (!fresh && cache && (Date.now() - cacheAt) < CACHE_MS) return cache;
  try {
    const r = await db().query(
      `SELECT enabled, settings, updated_at, updated_by FROM arena_settings WHERE id = true`);
    cache = shape(r.rows[0] || null);
    if (!r.rows[0]) {
      // The seed row is created by db/585 and re-asserted on every boot, so a
      // missing row means the migration has not run here yet. Say so once
      // rather than silently behaving as if somebody chose "off".
      console.warn('[arena] no settings row found - the Arena stays off until db/585 has run');
    }
  } catch (e) {
    console.warn(`[arena] could not read the on/off switch, staying OFF: ${(e && e.message) || e}`);
    cache = shape(null);
  }
  cacheAt = Date.now();
  return cache;
}

/** Drop the cache. Called by every write so a flip is felt immediately. */
function invalidate() { cache = null; cacheAt = 0; }

/** Is the Arena on? Fails closed. */
async function isEnabled() {
  const s = await load();
  return s.enabled === true;
}

const isSuperAdmin = (actor) => !!actor && actor.kind === 'staff' && actor.role === 'super_admin';

/**
 * What this person may see. THE one place that answers it -- the nav, the API
 * guard and the tests all call this, so "hidden" can never mean three different
 * things in three places.
 *
 * An EXTERNAL user (a borrower, a broker) is never inside the Arena at all,
 * switch or no switch: this is an internal staff game and a broker holds a
 * staff_users row, so the check is explicit rather than implied by the role.
 */
function visibilityFor(actor, enabled) {
  // `kind` is what actually separates them: a broker's token carries
  // kind:'tpo' and a borrower's kind:'borrower', so neither can ever be
  // 'staff'. The `isExternal` half is a SECOND belt on the same trousers and,
  // said plainly, it does not bite today -- `req.actor` does not carry that
  // field -- so it is here to keep working if one is ever added, not because
  // it is catching anything now.
  const staff = !!actor && actor.kind === 'staff' && actor.isExternal !== true;
  if (!staff) return { seesArena: false, seesSwitch: false, reason: 'not internal staff' };
  if (enabled) return { seesArena: true, seesSwitch: isSuperAdmin(actor), reason: null };
  return {
    seesArena: false,
    // The one exception, so the switch is not a one-way door.
    seesSwitch: isSuperAdmin(actor),
    reason: 'the Arena is switched off',
  };
}

/**
 * Express guard for every /api/arena route except the switch itself.
 *
 * Answers 404, not 403. A 403 confirms the feature exists and is merely denied
 * to you -- which is exactly what "nobody should even see it" rules out. 404 is
 * the answer a route that was never built would give.
 */
function guard(req, res, next) {
  isEnabled().then((on) => {
    const v = visibilityFor(req.actor, on);
    if (v.seesArena) return next();
    return res.status(404).json({ error: 'not found' });
  }).catch(() => res.status(404).json({ error: 'not found' }));
}

/** Only a super admin may touch the switch or the company-wide settings. */
function requireSuperAdmin(req, res, next) {
  if (isSuperAdmin(req.actor)) return next();
  return res.status(404).json({ error: 'not found' });
}

/**
 * Save the switch and/or the settings. Unknown keys are DROPPED rather than
 * stored, so a typo in a client payload can never become a phantom setting
 * nobody can find. Returns the resolved settings.
 */
async function save({ enabled, settings }, staffId) {
  const clean = {};
  if (settings && typeof settings === 'object') {
    for (const k of SETTING_KEYS) if (settings[k] !== undefined) clean[k] = settings[k];
  }
  const sets = [];
  const args = [];
  if (enabled !== undefined) { args.push(!!enabled); sets.push(`enabled = $${args.length}`); }
  if (settings !== undefined) {
    // MERGE, never replace: a client that sends one field must not silently
    // wipe every other setting an admin configured.
    args.push(JSON.stringify(clean));
    sets.push(`settings = COALESCE(settings, '{}'::jsonb) || $${args.length}::jsonb`);
  }
  args.push(staffId || null);
  sets.push(`updated_by = $${args.length}`);
  sets.push('updated_at = now()');
  await db().query(`UPDATE arena_settings SET ${sets.join(', ')} WHERE id = true`, args);
  invalidate();
  return load({ fresh: true });
}

module.exports = {
  DEFAULTS, SETTING_KEYS,
  load, invalidate, isEnabled, save,
  visibilityFor, guard, requireSuperAdmin, isSuperAdmin,
};

'use strict';
/**
 * LONG-TERM — the settings STORE (db/553 `lt_settings`).
 *
 * `encompass-settings.js` has declared 44 settings in 10 groups, with OUR values
 * as their defaults and a `resolve(overrides)` that accepts overrides, since the
 * day it was written. It has never had anywhere to save an override. This is that
 * place, and nothing else: the DECLARATIONS stay there, the VALUES live here.
 *
 * THE RULE THIS EXISTS TO SERVE (owner-directed): "everything that I'm telling you
 * to build, which is customizable to us, should be in the settings pre-filled
 * customizable for us, but everything should be able to be changed so we can sell
 * the system eventually and customize it according to someone else's needs."
 *
 * FOUR PROPERTIES, each load-bearing:
 *
 *   1. AN UNKNOWN KEY IS REFUSED, never stored. The declaration list is the
 *      whitelist. Without this the table becomes a junk drawer and "what settings
 *      exist" stops having an answer.
 *
 *   2. READS START FROM THE DEFAULTS and overlay the row. A missing row, a missing
 *      key, a brand-new setting nobody has saved — all resolve to a concrete value.
 *
 *   3. IT FAILS TO *OUR* BEHAVIOUR, never to nothing. If the table is missing or
 *      the database is unreachable, `load()` returns the declared defaults and says
 *      so. A settings outage must not change how the system behaves; it must only
 *      stop somebody's customisation from applying.
 *
 *   4. IT IS CACHED, because settings are read on nearly every request and change
 *      perhaps monthly. The cache is busted on every write in this process; the TTL
 *      is what carries a write made by another instance.
 *
 * SEPARATION: reads and writes only `lt_settings`. No RTL table, no RTL import.
 */

const decl = require('./encompass-settings');
// The pool is required LAZILY. `isKnown`, `defaults` and `validate` are pure
// policy — the whitelist and the declared values — and must load without a database
// driver in reach, so the rules can be unit-tested and so a caller that only
// validates never opens a connection.
const lazyDb = () => require('../db');

const TTL_MS = Number(process.env.LT_SETTINGS_TTL_MS || 60000);
const DEFAULT_SCOPE = 'company';

/** @type {Map<string, {at:number, settings:object, degraded:boolean}>} */
const cache = new Map();

/** True when `key` is a declared setting. The whitelist, in one place. */
function isKnown(key) {
  return decl.definition(String(key)) !== null;
}

/**
 * Every declared setting with OUR value. Never throws — this is what the whole
 * module falls back to.
 */
function defaults() {
  return decl.defaults();
}

/**
 * The effective settings for a scope: the declared defaults with any saved
 * overrides laid over them.
 *
 * Returns `{settings, degraded, source}`. `degraded` is true when the stored
 * overrides could not be read — the caller still gets a complete, usable settings
 * object, and anything that wants to warn a human can see that it is not the full
 * picture.
 */
async function load(scope = DEFAULT_SCOPE, { fresh = false } = {}) {
  const key = String(scope || DEFAULT_SCOPE);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) {
    return { settings: hit.settings, degraded: hit.degraded, stored: hit.stored, source: 'cache' };
  }

  const base = defaults();
  // WHICH KEYS CAME FROM A ROW, as distinct from which values differ from ours.
  // Merging rows over the defaults loses that, and it is not the same question:
  // a value somebody DELIBERATELY set to the figure we happen to pre-fill is
  // stored, and is a decision. `isOverridden` answers "is this different from
  // ours" — right for a settings screen, and the wrong question to ask about a
  // choice. See `routes/me.js`, where asking the wrong one silently moved people
  // off the side they had chosen.
  const stored = new Set();
  let degraded = false;

  try {
    const { rows } = await lazyDb().query(
      'SELECT key, value FROM lt_settings WHERE scope = $1',
      [key],
    );
    for (const r of rows) {
      // An unknown key is IGNORED on read as well as refused on write. A setting
      // that is retired in code must not keep applying from a stale row.
      if (!isKnown(r.key)) continue;
      base[r.key] = r.value;
      stored.add(r.key);
    }
  } catch (_e) {
    // Fail to OUR behaviour, loudly enough to be visible and quietly enough not
    // to break the request. `stored` stays EMPTY on a failed read — claiming a
    // person chose something because the database was briefly unreachable is the
    // one answer worse than falling back to the default.
    degraded = true;
  }

  cache.set(key, { at: Date.now(), settings: base, degraded, stored });
  return { settings: base, degraded, stored, source: 'db' };
}

/**
 * Does this scope hold a row of its own for this setting?
 *
 * Deliberately NOT `isOverridden`: that asks whether the effective value differs
 * from our pre-filled default, which is what a settings screen wants and is a
 * different question from "did somebody choose this".
 */
async function isStored(settingKey, scope = DEFAULT_SCOPE) {
  const { stored } = await load(scope);
  return !!(stored && stored.has(String(settingKey)));
}

/** One effective value. */
async function get(settingKey, scope = DEFAULT_SCOPE) {
  const { settings } = await load(scope);
  return settings[String(settingKey)];
}

/**
 * Validate a patch WITHOUT touching the database.
 *
 * Returns `{ok, clean, rejected}`. `rejected` names every key that is not a
 * declared setting, so a caller can tell the user exactly what was wrong rather
 * than answering a flat "invalid".
 */
function validate(patch) {
  const clean = {};
  const rejected = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!isKnown(k)) { rejected.push(k); continue; }
    if (v === undefined) continue;
    clean[k] = v;
  }
  return { ok: rejected.length === 0, clean, rejected };
}

/**
 * Save a patch. Refuses the whole patch if ANY key is unknown — a partial save
 * on a form the user filled in once would leave them unable to tell what applied.
 *
 * A value equal to the declared default is DELETED rather than stored, so the
 * table only ever holds genuine deviations and "what has this lender changed?"
 * has an honest answer.
 *
 * `keepDefault: true` turns that off, and there is exactly one shape of caller that
 * needs it: a PER-USER scope layered over a company one. There, "this person chose
 * X" and "this person has never chosen" are different facts, and collapsing them
 * loses a real choice — a lender whose company default is the long-term side would
 * otherwise silently override the one person who deliberately chose RTL, because
 * RTL is also the DECLARED default and their row would have been deleted. The
 * company scope must never pass it: there, storing a value equal to the default is
 * exactly the junk this rule exists to keep out.
 */
async function save(patch, { scope = DEFAULT_SCOPE, staffId = null, keepDefault = false } = {}) {
  const { ok, clean, rejected } = validate(patch);
  if (!ok) {
    const err = new Error(`unknown setting key(s): ${rejected.join(', ')}`);
    err.status = 400;
    err.rejected = rejected;
    throw err;
  }

  const base = defaults();
  const written = [];
  const cleared = [];

  const client = await lazyDb().getClient();
  try {
    await client.query('BEGIN');
    for (const [k, v] of Object.entries(clean)) {
      const isDefault = !keepDefault && JSON.stringify(v) === JSON.stringify(base[k]);
      if (isDefault) {
        await client.query('DELETE FROM lt_settings WHERE scope = $1 AND key = $2', [scope, k]);
        cleared.push(k);
        continue;
      }
      await client.query(
        `INSERT INTO lt_settings (scope, key, value, updated_by, updated_at)
              VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (scope, key)
           DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [scope, k, JSON.stringify(v), staffId],
      );
      written.push(k);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    throw e;
  } finally {
    client.release();
  }

  cache.delete(scope);
  return { written, cleared };
}

/** Drop the cache. Exposed for tests and for an admin "reload settings" action. */
function bust(scope = null) {
  if (scope) cache.delete(String(scope));
  else cache.clear();
}

/**
 * Everything a settings SCREEN needs in one object: the groups, each setting's
 * declaration, its default, its effective value, and whether it has been changed
 * from ours. A generic renderer can draw the whole screen from this, so adding a
 * setting server-side makes it appear with no front-end change.
 */
async function describe(scope = DEFAULT_SCOPE) {
  const { settings, degraded } = await load(scope);
  const base = defaults();
  // decl.groups() returns an OBJECT keyed by group name -> array of declarations.
  const groups = Object.entries(decl.groups()).map(([name, list]) => ({
    group: name,
    settings: list.map((s) => ({
      ...s,
      value: settings[s.key],
      default: base[s.key],
      isOverridden: JSON.stringify(settings[s.key]) !== JSON.stringify(base[s.key]),
    })),
  }));
  return { scope, groups, degraded };
}

module.exports = {
  DEFAULT_SCOPE,
  isKnown,
  defaults,
  load,
  get,
  isStored,
  validate,
  save,
  bust,
  describe,
};

'use strict';
/**
 * Runtime feature flags — the live override layer behind the API Health "working switches".
 *
 * Every integration on/off switch is an env var read once at boot (frozen in src/config.js), so
 * changing it normally needs a redeploy. This module lets an admin OVERRIDE a switch at runtime:
 * an override row in `integration_flags` (db/217) wins; with no row, the env default is used — so
 * behavior is IDENTICAL to today until someone flips something.
 *
 * Reads are SYNCHRONOUS off an in-memory cache (so call-time gates stay cheap and non-async): the
 * cache is loaded at boot, refreshed every FLAGS_REFRESH_SEC, and updated immediately on a write.
 * The contract everywhere is `flags.enabled('ENV_NAME', <current env/cfg default>)` — the caller
 * passes the env default so this module never has to know each switch's default.
 */
const db = require('../db');

const REFRESH_MS = Math.max(5, parseInt(process.env.FLAGS_REFRESH_SEC || '20', 10) || 20) * 1000;

// key -> boolean override (only keys with an explicit override are present).
let overrides = new Map();
let loaded = false;

/** Effective value of a switch: the runtime override if one is set, else the env default. */
function enabled(key, envDefault) {
  return overrides.has(key) ? overrides.get(key) : !!envDefault;
}
/** Is there an explicit runtime override for this key (vs. falling back to env)? */
function hasOverride(key) { return overrides.has(key); }
/** The raw override map as a plain object (for the admin UI). */
function overridesObject() { const o = {}; for (const [k, v] of overrides) o[k] = v; return o; }

/** Reload all overrides from the DB into the cache. Best-effort — never throws. */
async function refresh() {
  try {
    const { rows } = await db.query('SELECT key, enabled FROM integration_flags');
    const next = new Map();
    for (const r of rows) next.set(r.key, r.enabled === true);
    overrides = next;
    loaded = true;
  } catch (e) {
    // Table may not exist yet on first boot (migrations run in parallel) — stay with env defaults.
    if (!loaded) console.warn('[flags] initial load deferred:', e && e.message);
  }
}

/** Set (or change) an override, update the cache immediately, and audit. Returns the new value. */
async function setFlag(key, on, staffId, note) {
  const val = !!on;
  await db.query(
    `INSERT INTO integration_flags (key, enabled, updated_by, updated_at, note)
          VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (key) DO UPDATE SET enabled = $2, updated_by = $3, updated_at = now(), note = $4`,
    [key, val, staffId || null, note || null]);
  overrides.set(key, val);
  return val;
}
/** Remove an override so the switch reverts to its env default. */
async function clearFlag(key) {
  await db.query('DELETE FROM integration_flags WHERE key = $1', [key]);
  overrides.delete(key);
}

let started = false;
function start() {
  if (started) return;
  started = true;
  refresh();
  setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS).unref();
}

module.exports = { enabled, hasOverride, overridesObject, refresh, setFlag, clearFlag, start };

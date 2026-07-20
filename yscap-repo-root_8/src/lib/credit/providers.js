'use strict';

/**
 * Credit-provider registry (DB-backed).
 *
 * The portal is multi-provider by design (Xactus seeded + default), so nothing
 * here hard-codes "xactus": callers ask for the default provider or a provider
 * by key and get its row + capabilities. The row lives in `credit_providers`
 * (db/177); this module is the read/normalize layer over it plus a tiny cache
 * so the hot order path doesn't re-query on every pull.
 *
 * Capabilities (jsonb) advertise what the provider's adapter supports —
 * { reissue, softPull, hardPull, joint, bureaus[] } — so the UI can gate
 * actions without embedding vendor knowledge.
 */
const db = require('../../db');

// Small TTL cache. The provider list changes at most a few times ever (adding a
// vendor), so a short TTL is plenty and keeps the order path from touching the
// DB for static config. Never cache credentials — those are per-user + secret.
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60 * 1000;

function _now() { return Date.now(); }

function _normalize(row) {
  if (!row) return null;
  let caps = row.capabilities;
  if (typeof caps === 'string') { try { caps = JSON.parse(caps); } catch { caps = {}; } }
  return {
    id: row.id,
    key: row.key,
    displayName: row.display_name,
    enabled: !!row.enabled,
    isDefault: !!row.is_default,
    capabilities: caps && typeof caps === 'object' ? caps : {},
  };
}

async function _load() {
  if (_cache && (_now() - _cacheAt) < CACHE_TTL_MS) return _cache;
  const { rows } = await db.query(
    `SELECT id, key, display_name, enabled, is_default, capabilities
       FROM credit_providers ORDER BY is_default DESC, display_name`);
  _cache = rows.map(_normalize);
  _cacheAt = _now();
  return _cache;
}

/** Drop the cache (call after an admin edits providers). */
function invalidate() { _cache = null; _cacheAt = 0; }

/** All providers (enabled + disabled), default first. */
async function list() { return (await _load()).slice(); }

/** Only providers a staffer can order through right now. */
async function listEnabled() { return (await _load()).filter((p) => p.enabled); }

/** The single default provider (or null if none is marked default). */
async function getDefault() {
  const all = await _load();
  return all.find((p) => p.isDefault && p.enabled) || all.find((p) => p.isDefault) || null;
}

/** Look up a provider by its stable key (e.g. 'xactus'). */
async function getByKey(key) {
  if (!key) return null;
  return (await _load()).find((p) => p.key === String(key)) || null;
}

/** Look up a provider by numeric id. */
async function getById(id) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  return (await _load()).find((p) => p.id === n) || null;
}

module.exports = { list, listEnabled, getDefault, getByKey, getById, invalidate, _normalize };

'use strict';
/**
 * LONG-TERM — LoanNEX `countyKey` resolution.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID. LoanNEX does not take a FIPS county
 * code. It takes its OWN `countyKey` (NJ Atlantic = 31001, CT Hartford = 7003).
 * Those numbers LOOK derivable — the low three digits are the FIPS county code
 * and the high digits are the state's position in an alphabetical list that
 * happens to include DC — and deriving them is exactly the cheap shape this
 * repo forbids. The arithmetic is an inference from two data points; the day
 * LoanNEX inserts a territory or renumbers a state, every price silently comes
 * back for the WRONG COUNTY, which is the worst failure a pricing engine has
 * because the answer still looks like an answer.
 *
 * SO THE KEY IS ALWAYS LOOKED UP, NEVER COMPUTED. `GET /lookups/counties?stateValue={ST}`
 * returns the state's counties with their keys; we match on the county NAME and
 * cache per state. Unresolvable is `null` plus a reason — never a guessed number.
 *
 * WHERE THE COUNTY NAME COMES FROM. `lenderprice/zip-county.js` — the generated
 * Census ZIP→county map already in this codebase. It is required rather than
 * copied on purpose: rule 1a says one definition, never two, and a second copy
 * of a 412KB generated dataset is the definition of the cheap shape. Both
 * modules are LT, so no product boundary is crossed; the only thing borrowed is
 * a ZIP→county-name fact that has nothing to do with either vendor.
 *
 * PURE apart from the fetcher it is handed. No database, no RTL import.
 */

const zipCounty = require('../lenderprice/zip-county');
const CAPTURED = require('./capture/counties.json');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // `${portal}:${ST}` -> { counties, expiresAt }

/** "Saint Mary's County" / "ST. MARYS" / "St Marys" all compare equal. */
function normalizeName(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/\bcounty\b|\bparish\b|\bborough\b|\bcensus area\b|\bcity and borough\b|\bmunicipality\b/g, ' ')
    .replace(/\bst\.?\b/g, 'saint')
    .replace(/[^a-z0-9]+/g, '');
}

function indexCounties(list) {
  const byName = new Map();
  for (const c of list || []) {
    if (!c || c.countyKey == null || !c.countyName) continue;
    byName.set(normalizeName(c.countyName), { countyKey: Number(c.countyKey), countyName: String(c.countyName), stateCode: c.stateCode || null });
  }
  return byName;
}

/**
 * The county list for one state. `fetchLive(st)` is an async () => counties[],
 * supplied by the client. Falls back to the capture (NJ and CT only) and stamps
 * which answered; a state the capture does not carry resolves to null rather
 * than to a plausible number.
 */
async function countiesFor(portal, st, fetchLive, opts = {}) {
  const state = String(st || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return { source: 'none', byName: new Map(), state: null };
  const key = `${portal || 'default'}:${state}`;
  const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.entry;

  let entry = { source: 'none', byName: new Map(), state };
  if (typeof fetchLive === 'function') {
    try {
      const list = await fetchLive(state);
      if (Array.isArray(list) && list.length) entry = { source: 'live', byName: indexCounties(list), state };
    } catch (_) { /* fall through */ }
  }
  if (entry.source === 'none') {
    const cap = (CAPTURED.byState || {})[state];
    if (Array.isArray(cap) && cap.length) entry = { source: 'captured', byName: indexCounties(cap), state };
  }
  cache.set(key, { entry, expiresAt: now + ttl });
  return entry;
}

/**
 * Resolve a scenario's location to a LoanNEX countyKey.
 *
 * Accepts an explicit `county` name, or a `zip` we turn into one through the
 * generated Census map. Returns `{ countyKey, countyName, source, via }` — or
 * `{ countyKey: null, reason }`. NEVER a computed key.
 */
async function resolveCountyKey({ portal, state, county, zip }, fetchLive, opts = {}) {
  let st = state ? String(state).trim().toUpperCase() : null;
  let name = county ? String(county) : null;
  let via = name ? 'county' : null;

  if (!name && zip) {
    const hit = zipCounty.lookupZip(zip);
    if (hit && hit.countyName) { name = hit.countyName; via = 'zip'; if (!st && hit.state) st = String(hit.state).toUpperCase(); }
  }
  if (!st) return { countyKey: null, countyName: null, source: 'none', via, reason: 'no_state' };
  if (!name) return { countyKey: null, countyName: null, source: 'none', via, reason: 'no_county_or_zip' };

  const entry = await countiesFor(portal, st, fetchLive, opts);
  if (!entry.byName.size) return { countyKey: null, countyName: name, source: entry.source, via, reason: `no_county_list_for_${st}` };
  const hit = entry.byName.get(normalizeName(name));
  if (!hit) return { countyKey: null, countyName: name, source: entry.source, via, reason: `county_not_found_in_${st}` };
  return { countyKey: hit.countyKey, countyName: hit.countyName, source: entry.source, via, reason: null };
}

function resetCache() { cache.clear(); }

module.exports = { resolveCountyKey, countiesFor, normalizeName, resetCache, DEFAULT_TTL_MS, _internals: { indexCounties, cache } };

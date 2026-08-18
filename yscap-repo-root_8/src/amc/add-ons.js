'use strict';
/**
 * WHAT CAN BE ADDED TO THIS FORM — the AppraisalScope add-ons for one job type.
 *
 * (Audit finding, 2026-08-16, owner-directed 2026-08-17 "a lookup that's probably
 * returning nothing … get it going".)
 *
 * WHAT WAS WRONG, AND WHY IT WAS INVISIBLE. `GetJobTypeAddOns` sat in `lookups.js`'s
 * LOOKUP_TYPES beside GetJobType and GetPropertyType, so it was fetched through the
 * generic `cdg.buildLookup` — which sends no `products` at all. Their own sample
 * request carries `products[0].productcode`: the FORM you are asking about. So the
 * account-wide refresh was asking an unanswerable question on every cycle, and
 * `refreshAll` is best-effort by design, so the failure went into a `failed[]` array
 * nobody reads. Nothing errored, nothing was logged, and no screen showed an add-on.
 *
 * THE CLASS: a per-parameter question fetched by a no-parameter refresh loop answers
 * nothing, forever, quietly — and caching that answer under an account-wide key is
 * worse than not caching it, because the empty result then looks authoritative.
 *
 * THE OTHER HALF WAS ALREADY BUILT. The ids this returns are the same ids an order
 * carries as `products[].subproducts[].identifier` — mapping workbook Request row 4,
 * "Additional Products", Optional on CreateAppraisal / AddForm / UpdateAppraisal —
 * which `form-select` reads off a form rule (`subproduct_codes`), `order-build`
 * threads as `subproductCodes`, `cdg.buildCreateAppraisal` emits, `order-service`
 * stores, and `GetAppraisalDetail` reads back (Response row 209). Everything except
 * a way to find out what the codes ARE. This is that way, so an add-on stops being a
 * number somebody had to already know and becomes a named thing a person can pick.
 *
 * IT IS A READ. `client.lookup` is the catalog endpoint, master-switch gated, never
 * the outbound WRITE gate — so asking what a form offers can never place, change or
 * charge an order, and it works on an account whose ordering is still switched off.
 *
 * THE CACHE KEY CARRIES THE FORM, IN THE `lookup_type` STRING — the `fees.js`
 * arrangement, for the reason recorded there: `amc_lookup_cache` is unique on
 * (lookup_type, subdomain) and db/480 re-creates that index on every boot, so
 * widening the key with a column would leave a two-column index behind to refuse the
 * second row. `GetJobTypeAddOns#1004` needs no migration and cannot fight an index
 * that is re-created underneath it. `lookups.js` only walks its fixed list, so these
 * rows sit harmlessly alongside and are never clobbered by it.
 *
 * NOTHING BLOCKS A PREVIEW. Read from the cache, refreshed in the BACKGROUND,
 * throttled per key. A cold cache answers an empty list and the NEXT preview carries
 * the names — never a preview held open on a vendor that will not answer.
 */

const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');

/** How long a form's add-on list is worth showing before a background refresh. */
const TTL_MS = Math.max(60, parseInt(process.env.AMC_ADDON_CACHE_MIN || '720', 10) || 720) * 60 * 1000;
/** At most one live refresh per form per this long, however many previews open. */
const REFRESH_THROTTLE_MS = 5 * 60 * 1000;

const _lastRefresh = new Map();   // cacheKey → ms
const _inflight = new Map();      // cacheKey → Promise

function addOnKey(productCode) {
  return `GetJobTypeAddOns#${String(productCode == null ? '' : productCode).trim()}`;
}

/**
 * The vendor's rows are `{id, name}` (List Response rows 84/85). PURE, so the
 * shaping is testable with no vendor and no database.
 *
 * A row with no id is DROPPED rather than kept with a blank one: the id is what an
 * order sends as a subproduct identifier, so a nameless code is still usable while
 * an idless name could only ever produce an order asking for `""`.
 */
function normalize(rows) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || typeof r !== 'object') continue;
    const id = r.id != null ? String(r.id).trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: r.name != null && String(r.name).trim() ? String(r.name).trim() : `Add-on ${id}` });
  }
  return out;
}

async function readCached(db, key, subdomain) {
  try {
    const r = await db.query(
      `SELECT payload, fetched_at FROM amc_lookup_cache WHERE lookup_type=$1 AND subdomain=$2`,
      [key, subdomain || '']);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function writeCached(db, key, subdomain, rows) {
  try {
    await db.query(
      `INSERT INTO amc_lookup_cache (lookup_type, subdomain, payload, fetched_at)
       VALUES ($1,$2,$3::jsonb, now())
       ON CONFLICT (lookup_type, subdomain)
       DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
      [key, subdomain || '', JSON.stringify(rows || [])]);
  } catch (_) { /* a cache we cannot write is a list we fetch again next time */ }
}

/**
 * Fetch ONE form's add-ons live and cache them. Single-flight per form, throttled,
 * and it NEVER throws — a vendor that will not answer leaves the previous list
 * standing rather than blanking a screen.
 */
async function refresh(db, productCode, subdomain) {
  const key = addOnKey(productCode);
  if (_inflight.has(key)) return _inflight.get(key);
  const last = _lastRefresh.get(key) || 0;
  if (Date.now() - last < REFRESH_THROTTLE_MS) return null;
  _lastRefresh.set(key, Date.now());

  const p = (async () => {
    try {
      let cfgd;
      try { cfgd = client.configured(); } catch (_) { cfgd = null; }
      // Never trigger a DoLogin from a preview on an account that cannot authenticate.
      if (!cfgd || !cfgd.enabled || !cfgd.ready) return null;
      const ctx = await session.authContext();
      const resp = await client.lookup(
        cdg.buildJobTypeAddOns({ apiKey: ctx.apiKey, subdomain: ctx.subdomain, productCode }),
        { label: 'GetJobTypeAddOns' });
      const err = cdg.parseError(resp);
      if (err) {
        if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
        return null;
      }
      const rows = normalize(cdg.parseLookup(resp));
      await writeCached(db, key, subdomain || ctx.subdomain, rows);
      return rows;
    } catch (_) {
      return null;   // the cached list, if any, still shows
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

/**
 * The add-ons available for a form, and which of them this order has selected.
 *
 * Returns `{ available, selected, unknownSelected, asOf, stale }`:
 *   available        [{id,name}] — what the vendor offers for THIS form
 *   selected         [{id,name}] — the codes on the order, NAMED where we can
 *   unknownSelected  [id]        — codes on the order the vendor does not list
 *
 * `unknownSelected` is reported rather than hidden, and that is the point of
 * splitting them: a form rule can carry a code that the account has since retired,
 * and an order that quietly asks for a subproduct nobody offers is exactly the kind
 * of thing that comes back as a vendor refusal nobody can explain. Naming it on the
 * preview is what makes it fixable BEFORE the order goes out.
 *
 * NEVER throws, and never waits on the vendor.
 */
async function addOnsFor(db, { productCode, selectedCodes, subdomain } = {}) {
  const selected = (Array.isArray(selectedCodes) ? selectedCodes : []).map((c) => String(c).trim()).filter(Boolean);
  const out = { available: [], selected: [], unknownSelected: [], asOf: null, stale: false };
  if (!db || !productCode) {
    // With no form there is nothing to ask about — but the codes ON the order are
    // still worth stating, unnamed, rather than silently dropped.
    out.unknownSelected = selected;
    return out;
  }
  const key = addOnKey(productCode);
  const sd = subdomain || '';
  const cached = await readCached(db, key, sd);
  if (cached) {
    out.available = normalize(cached.payload);
    out.asOf = cached.fetched_at;
    if (Date.now() - new Date(cached.fetched_at).getTime() > TTL_MS) {
      out.stale = true;
      refresh(db, productCode, sd);   // background
    }
  } else {
    // Nothing cached: kick the fetch and answer without it. The next preview
    // carries the names.
    refresh(db, productCode, sd);
  }

  const byId = new Map(out.available.map((a) => [a.id, a]));
  for (const id of selected) {
    const hit = byId.get(id);
    if (hit) out.selected.push(hit);
    else out.unknownSelected.push(id);
  }
  return out;
}

module.exports = {
  addOnsFor, normalize, addOnKey,
  _internals: { TTL_MS, REFRESH_THROTTLE_MS, refresh, readCached, writeCached },
};

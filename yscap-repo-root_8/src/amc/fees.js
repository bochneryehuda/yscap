'use strict';
/**
 * WHAT WILL THIS APPRAISAL COST — asked before the order goes out.
 *
 * (Audit finding, 2026-08-16: AppraisalScope has offered both of these lookups
 * since the integration was written and neither was ever called, so the price of
 * an appraisal was a surprise on the invoice.)
 *
 * TWO DIFFERENT QUESTIONS, AND BOTH ARE WORTH ANSWERING:
 *
 *   GetFee                      what the FORM costs on this account — the list
 *                               price for a 1004, a 1025, a 1073.
 *   GetAppraiserFeesByLocation  what appraisers actually charge WHERE the
 *                               property is. A 1004 is not one price nationally;
 *                               a rural county and a dense suburb are different
 *                               numbers for the same form.
 *
 * Showing only one would be misleading in a different way each time, so the
 * preview shows both and says which is which.
 *
 * EVERYTHING HERE IS A READ. Both go through `client.lookup` — the catalog
 * endpoint, master-switch-gated, never the outbound WRITE gate — so quoting a fee
 * can never place, change or charge an order. It is also why a quote works on an
 * account whose ordering is still switched off.
 *
 * THE CACHE KEY CARRIES THE PARAMETERS, AND IT DOES SO IN THE `lookup_type`
 * STRING ON PURPOSE. `amc_lookup_cache` is unique on (lookup_type, subdomain) and
 * db/480 RE-CREATES that index on every boot — so widening the key with a new
 * column would leave the two-column index behind to refuse the second row for one
 * lookup type, which is exactly the constraint-fights-a-later-migration trap this
 * repo has been bitten by before. Encoding the parameters into the type
 * (`GetFee#1004`, `GetAppraiserFeesByLocation#NJ:08701`) needs no migration and
 * cannot fight an index that is re-created underneath it. `lookups.js`'s own
 * refresh loop only walks its fixed LOOKUP_TYPES list, so these rows sit
 * harmlessly alongside and are never clobbered by it.
 *
 * NOTHING BLOCKS A PREVIEW. A quote is read from the cache and refreshed in the
 * BACKGROUND, throttled per key — the `ensureClientDisplayedCache` discipline in
 * order-service.js, and for the same reason: a preview is a GET, and a hung vendor
 * must never hold one open.
 */

const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');

/** How long a quote is worth showing before it is refreshed behind the scenes. */
const TTL_MS = Math.max(60, parseInt(process.env.AMC_FEE_CACHE_MIN || '720', 10) || 720) * 60 * 1000;
/** At most one live refresh per key per this long, however many previews open. */
const REFRESH_THROTTLE_MS = 5 * 60 * 1000;

const _lastRefresh = new Map();   // cacheKey → ms
const _inflight = new Map();      // cacheKey → Promise

// THE ZIP IS PART OF THE KEY, because it is now part of the REQUEST. A fee is
// quoted for a place, so a quote cached for one property must never be served as
// the quote for another — that is how a cache turns a correctness fix into a
// wrong number nobody can explain. A quote with no ZIP keeps its old key exactly,
// so nothing already cached is orphaned.
function feeKey(productCode, zip) {
  const z = String(zip == null ? '' : zip).trim();
  return `GetFee#${String(productCode || '').trim()}` + (z ? `@${z}` : '');
}
function locationKey(state, zip) {
  return `GetAppraiserFeesByLocation#${String(state || '').toUpperCase().trim()}:${String(zip || '').trim()}`;
}

/**
 * A money value out of a vendor row, whatever they called the column.
 *
 * `totalClientFee` LEADS, and that is the whole point of this order: it is
 * AppraisalScope's own headline figure — what the order costs us all in — and it
 * was unread, so the quote a person saw was `job_fee`, a COMPONENT. On the
 * vendor's own sample those two agree at $450 while a separate `clientRushFee` of
 * $50 sits beside them, so the base fee is exactly the number that goes wrong the
 * moment anything is added to an order. The old list is kept beneath it as the
 * fallback for a lookup that states no total (GetAppraiserFeesByLocation returns a
 * different shape), so nothing that quoted before stops quoting now.
 */
function feeAmount(row) {
  if (!row || typeof row !== 'object') return null;
  for (const k of ['totalClientFee', 'clientFee', 'fee', 'amount', 'fee_amount', 'job_fee', 'total_fee', 'price']) {
    if (row[k] == null || row[k] === '') continue;
    const n = Number(String(row[k]).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Summarise the rows a fee lookup returned. PURE — the whole shaping is testable
 * with no vendor and no database.
 *
 * `typical` is the MEDIAN rather than the mean: one $2,400 complex-property row
 * drags an average badly, and the useful number for somebody about to order is
 * what a normal one costs.
 */
function summarize(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
  const amounts = list.map(feeAmount).filter((n) => n != null).sort((a, b) => a - b);
  if (!amounts.length) return { count: list.length, low: null, high: null, typical: null };
  const mid = Math.floor(amounts.length / 2);
  const typical = amounts.length % 2 ? amounts[mid] : Math.round((amounts[mid - 1] + amounts[mid]) / 2);
  return { count: list.length, low: amounts[0], high: amounts[amounts.length - 1], typical };
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
  } catch (_) { /* a cache we cannot write is a quote we fetch again next time */ }
}

/**
 * Fetch ONE quote live and cache it. Single-flight per key, throttled, and it
 * never throws — a vendor that will not answer leaves the previous quote standing.
 */
async function refresh(db, key, buildMessage, subdomain) {
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
      const resp = await client.lookup(buildMessage({ apiKey: ctx.apiKey, subdomain: ctx.subdomain }), { label: key.split('#')[0] });
      const err = cdg.parseError(resp);
      if (err) {
        if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
        return null;
      }
      const rows = cdg.parseLookup(resp);
      await writeCached(db, key, subdomain || ctx.subdomain, rows);
      return rows;
    } catch (_) {
      return null;   // the cached quote, if any, still shows
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

/**
 * The quote for an order about to be placed.
 *
 * Returns `{ form, location, stale, asOf }` where each half is
 * `{ rows, count, low, high, typical, asOf }` or null when nothing has ever been
 * fetched. NEVER throws and never waits on the vendor: a cold cache answers null
 * and kicks off the fetch, so the NEXT preview carries the numbers.
 */
async function quoteFor(db, { productCode, state, zip, subdomain } = {}) {
  const out = { form: null, location: null, stale: false, asOf: null };
  if (!db) return out;
  const sd = subdomain || '';
  const now = Date.now();

  const halves = [
    productCode ? {
      slot: 'form', key: feeKey(productCode, zip),
      build: ({ apiKey, subdomain: s }) => cdg.buildGetFee({ apiKey, subdomain: s, productCode, postalCode: zip }),
    } : null,
    (state || zip) ? {
      slot: 'location', key: locationKey(state, zip),
      build: ({ apiKey, subdomain: s }) => cdg.buildAppraiserFeesByLocation({ apiKey, subdomain: s, stateCode: state, zip }),
    } : null,
  ].filter(Boolean);

  for (const h of halves) {
    const cached = await readCached(db, h.key, sd);
    if (cached) {
      const age = now - new Date(cached.fetched_at).getTime();
      const rows = Array.isArray(cached.payload) ? cached.payload : [];
      out[h.slot] = { rows, ...summarize(rows), asOf: cached.fetched_at };
      if (!out.asOf || new Date(cached.fetched_at) > new Date(out.asOf)) out.asOf = cached.fetched_at;
      if (age > TTL_MS) { out.stale = true; refresh(db, h.key, h.build, sd); }   // background
    } else {
      // Nothing cached: kick the fetch and answer without it. A preview must not
      // wait on the vendor, and the next one shows the number.
      refresh(db, h.key, h.build, sd);
    }
  }
  return out;
}

module.exports = {
  quoteFor, summarize, feeAmount, feeKey, locationKey,
  _internals: { TTL_MS, REFRESH_THROTTLE_MS, refresh },
};

'use strict';
/**
 * Richer Values — their catalogue, cached.
 *
 * WHAT THE CATALOGUE IS, AND WHY IT IS NOT A LIST IN THE CODE. Which reports a
 * client may order, which inspections go with each report, what each costs and
 * what the turnaround options are is an ENTITLEMENT served per company by their
 * API — not a fixed vocabulary. Our training tenant is entitled to four report
 * types today and could be entitled to a fifth tomorrow with no deploy. So the
 * order screen's pickers are fed from here, and a hand-kept list would be wrong
 * the first time they enable something.
 *
 * WHY IT IS CACHED. A preview must never block on a vendor call, and the order
 * screen has to render with the vendor unreachable — with a plain "this is what we
 * last saw and when", which is a usable screen. So every read goes to
 * `rv_reference_cache` first, refreshes in the background when it is older than
 * the TTL, and falls back to the stale copy on any failure. Best-effort by
 * construction: this module NEVER throws, and an empty cache produces an empty
 * list plus a reason, never an exception on a page load.
 *
 * THE PRICES RIDE ALONG. Their report-type and inspection-type payloads carry a
 * `price` block per entitlement, which is what lets the screen show "$419.99 +
 * $70" before anybody commits. It is a LIST price: the authoritative figure for a
 * specific property is their pricing endpoint (state and ZIP move it), which the
 * order service calls separately.
 */

const client = require('./client');

// Long enough that a screen almost never waits, short enough that an entitlement
// switched on at their end shows up the same morning.
const TTL_MS = 6 * 60 * 60 * 1000;

const key = (...parts) => parts.filter((p) => p != null && p !== '').join(':');

async function readCache(db, cacheKey) {
  try {
    const r = await db.query(`SELECT payload, fetched_at, last_error FROM rv_reference_cache WHERE cache_key=$1`, [cacheKey]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function writeCache(db, cacheKey, payload, lastError) {
  try {
    await db.query(
      `INSERT INTO rv_reference_cache (cache_key, payload, fetched_at, last_error)
       VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (cache_key) DO UPDATE SET payload=$2::jsonb, fetched_at=now(), last_error=$3`,
      [cacheKey, JSON.stringify(payload || {}), lastError || null]);
  } catch (_) { /* the cache is an optimization, never the thing that fails a page */ }
}

/** Record a failure WITHOUT destroying the last good payload — a stale catalogue is a usable screen. */
async function noteFailure(db, cacheKey, message) {
  try {
    await db.query(`UPDATE rv_reference_cache SET last_error=$2 WHERE cache_key=$1`, [cacheKey, String(message || '').slice(0, 500)]);
  } catch (_) { /* best-effort */ }
}

/**
 * The one read path: serve the cache, refresh when stale, fall back to stale on a
 * failure. `force` refreshes now (the desk's "check again" button).
 *
 * @returns {{items:*, fetchedAt:Date|null, stale:boolean, error:string|null}}
 */
async function cached(db, cacheKey, fetcher, { force = false } = {}) {
  const row = await readCache(db, cacheKey);
  const age = row && row.fetched_at ? Date.now() - new Date(row.fetched_at).getTime() : Infinity;
  const fresh = row && age < TTL_MS;
  if (fresh && !force) return { items: row.payload, fetchedAt: row.fetched_at, stale: false, error: row.last_error || null };

  try {
    const items = await fetcher();
    await writeCache(db, cacheKey, items, null);
    return { items, fetchedAt: new Date(), stale: false, error: null };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    await noteFailure(db, cacheKey, msg);
    if (row) return { items: row.payload, fetchedAt: row.fetched_at, stale: true, error: msg };
    return { items: null, fetchedAt: null, stale: true, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Normalizers. Their payloads carry strings where a boolean is meant ("1"/"0")
// and nest the price, so each list is flattened into ONE shape the screen and the
// builder both read — and an unrecognised extra field is simply carried through
// rather than dropped, so a new attribute is visible without a deploy.
// ---------------------------------------------------------------------------
const yes = (v) => v === true || v === 1 || v === '1';
const numOrNull = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function normReportType(t) {
  const price = (t && t.price) || {};
  return {
    slug: t.slug,
    name: t.nickname || t.formal_name || t.slug,
    formalName: t.formal_name || null,
    description: t.public_description || null,
    // Their own flags, which the ORDER BUILDER reads rather than guessing:
    // whether this report needs a renovation budget, and whether it asks for the
    // property's after-renovation figures.
    needsRenovationBudget: yes(t.renovation_budget_needed),
    asksCurrentStats: yes(t.ask_current_stats),
    asksProposedStats: yes(t.ask_proposed_stats),
    landEligible: yes(t.land_eligible),
    partialConstructionEligible: yes(t.partial_construction_eligible),
    baseFee: numOrNull(price.base_fee),
    reportTypeFee: numOrNull(price.report_type_fee),
  };
}

function normInspectionType(t) {
  const price = (t && t.price) || {};
  return {
    slug: t.slug,
    name: t.name || t.slug,
    description: t.public_description || null,
    // 'crowdsource' = an inspector they send; 'direct' = the borrower does it on
    // their phone. It is what decides whether a mobile number is mandatory.
    platform: t.pp_platform || null,
    glaApplicable: yes(t.gla_applicable),
    licensingApplicable: yes(t.licensing_applicable),
    contactInfoRequired: yes(t.contact_info_required),
    fee: numOrNull(price.inspection_fee != null ? price.inspection_fee : price.inspection_price),
    feeAdditionalUnits: numOrNull(price.inspection_price_additional_units),
  };
}

function normTat(t) {
  return {
    slug: t.slug,
    name: t.name || t.slug,
    days: numOrNull(t.turnaround_time),
    text: t.turnaround_time_text || null,
    fee: numOrNull(t.fee),
    dueDate: t.due_date || null,
  };
}

function normUser(u) {
  return {
    token: u.token,
    name: u.name || u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || null,
    email: u.email || null,
    phone: u.phone || null,
  };
}

// ---------------------------------------------------------------------------
// The four catalogues.
// ---------------------------------------------------------------------------
async function reportTypes(db, companyToken, opts = {}) {
  const out = await cached(db, key('report-types', companyToken), async () => {
    const r = await client.reportTypes(companyToken);
    const list = (r && r.data && r.data.reportTypes) || [];
    return list.filter((t) => t && t.slug).map(normReportType);
  }, opts);
  return { ...out, items: Array.isArray(out.items) ? out.items : [] };
}

async function inspectionTypes(db, companyToken, reportType, opts = {}) {
  const out = await cached(db, key('inspection-types', companyToken, reportType), async () => {
    const r = await client.inspectionTypes(companyToken, reportType);
    const list = (r && r.data && r.data.inspectionTypes) || [];
    return list.filter((t) => t && t.slug).map(normInspectionType);
  }, opts);
  return { ...out, items: Array.isArray(out.items) ? out.items : [] };
}

async function turnaroundTimes(db, companyToken, reportType, opts = {}) {
  const out = await cached(db, key('tat', companyToken, reportType), async () => {
    const r = await client.turnaroundTimes(companyToken, reportType);
    const list = (r && r.data && r.data.tat) || [];
    return list.filter((t) => t && t.slug).map(normTat);
  }, opts);
  return { ...out, items: Array.isArray(out.items) ? out.items : [] };
}

async function loanOfficers(db, companyToken, opts = {}) {
  const out = await cached(db, key('loan-officers', companyToken), async () => {
    const r = await client.loanOfficers(companyToken);
    const list = (r && r.data && r.data.loan_officers) || [];
    return list.filter((u) => u && u.token).map(normUser);
  }, opts);
  return { ...out, items: Array.isArray(out.items) ? out.items : [] };
}

/** Find one entry by slug in a catalogue result, or null. */
function pick(catalogue, slug) {
  if (!catalogue || !Array.isArray(catalogue.items)) return null;
  return catalogue.items.find((i) => i && i.slug === slug) || null;
}

module.exports = {
  reportTypes, inspectionTypes, turnaroundTimes, loanOfficers, pick,
  TTL_MS,
  _internals: { cached, normReportType, normInspectionType, normTat, normUser, readCache, writeCache },
};

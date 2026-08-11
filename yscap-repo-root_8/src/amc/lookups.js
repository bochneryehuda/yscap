'use strict';
/**
 * AMC lookups cache.
 *
 * AppraisalScope is "a highly customizable product with very few standard data sets"
 * (vendor guide) — so before you can build an order you fetch the client's own lists:
 * the forms (GetJobType / Get_JobTypes_By_LoanType), loan types, property types,
 * preferred AMCs, loan officers, processors, etc. These change rarely, so we cache them
 * in `amc_lookup_cache` (per environment) and refresh on a schedule / on demand. The
 * order-form dropdowns and the form-selection rules read the cache, so building an order
 * never waits on a live lookup call.
 *
 * Every function takes the db handle so it's callable from a route (which passes
 * require('../db')) and testable. Live refresh goes through the transport + session and
 * is gated by the same switches as everything else (AMC_ENABLED).
 */
const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');

// The lookups we cache. GetJobType + Get_JobTypes_By_LoanType are the FORM catalog that
// drives form selection; the rest populate the order-form dropdowns.
const LOOKUP_TYPES = [
  'GetJobType', 'Get_JobTypes_By_LoanType', 'GetJobTypeAddOns',
  'GetLoanType', 'GetPropertyType', 'GetPropertyViewType',
  'GetAMCPreference', 'GetLoanOfficer', 'GetProcessor',
  'GetIntendedUse', 'GetInvestorList', 'Get_Branch_List',
  'Get_Additional_Document_Types', 'GetUsers', 'GetClientDisplayOnReport',
];

async function getCached(db, lookupType, subdomain = '') {
  const r = await db.query(
    'SELECT payload, fetched_at FROM amc_lookup_cache WHERE lookup_type = $1 AND subdomain = $2',
    [lookupType, subdomain || '']);
  return r.rows[0] || null;
}

// The cached rows themselves (already-parsed jsonb), or [] when nothing is cached yet.
async function list(db, lookupType, subdomain = '') {
  const row = await getCached(db, lookupType, subdomain);
  return row && Array.isArray(row.payload) ? row.payload : [];
}

async function setCached(db, lookupType, subdomain, rows) {
  await db.query(
    `INSERT INTO amc_lookup_cache (lookup_type, subdomain, payload, fetched_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (lookup_type, subdomain)
       DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [lookupType, subdomain || '', JSON.stringify(rows)]);
}

// Fetch ONE lookup live and cache it. Throws on a NACK so the caller can report it.
async function refreshOne(db, lookupType) {
  const ctx = await session.authContext();
  // Catalog lookups are served at the "/direct/" endpoint (loginUrl), NOT "/order/" — see
  // client.lookup(). Posting these to "/order/" is what returned HTTP 500 from the gateway.
  const resp = await client.lookup(
    cdg.buildLookup({ actionType: lookupType, apiKey: ctx.apiKey, subdomain: ctx.subdomain }),
    { label: lookupType });
  const err = cdg.parseError(resp);
  if (err) {
    // A stale api key surfaces as an auth NACK — drop it so the next call re-logs in.
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    throw new Error(`AMC ${lookupType} failed: ${err.description || err.code}`);
  }
  const rows = cdg.parseLookup(resp);
  await setCached(db, lookupType, ctx.subdomain || '', rows);
  return rows;
}

// Refresh every lookup, best-effort — one failing lookup never stops the rest.
async function refreshAll(db) {
  const out = { ok: [], failed: [] };
  for (const t of LOOKUP_TYPES) {
    try { const rows = await refreshOne(db, t); out.ok.push({ type: t, count: rows.length }); }
    catch (e) { out.failed.push({ type: t, error: e.message }); }
  }
  return out;
}

// The form catalog for form-selection + the order-form dropdown: {id, name} rows.
async function forms(db, subdomain = '') {
  const byLoanType = await list(db, 'Get_JobTypes_By_LoanType', subdomain);
  if (byLoanType.length) return byLoanType;
  return list(db, 'GetJobType', subdomain);
}

// Is a cached lookup older than `maxHours`? (used to decide a scheduled refresh)
function isStale(row, maxHours) {
  if (!row || !row.fetched_at) return true;
  const ageMs = Date.now() - new Date(row.fetched_at).getTime();
  return ageMs > Math.max(1, maxHours) * 3600 * 1000;
}

module.exports = { LOOKUP_TYPES, getCached, list, setCached, refreshOne, refreshAll, forms, isStale };

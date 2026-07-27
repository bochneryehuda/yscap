'use strict';
/**
 * USPS address STANDARDIZER — the one place that turns any address into the
 * official USPS-correct form and says how sure USPS is about it.
 *
 * It wraps the raw USPS Addresses API client (lib/integrations/usps.js) and adds
 * the three things the rest of the app needs:
 *   1) CANONICAL SHAPE — USPS's { streetAddress, secondaryAddress, city, state,
 *      ZIPCode } is mapped to our { line1, unit, city, state, zip, oneLine } so a
 *      verified address drops straight into the same fields every screen uses.
 *   2) A STATUS — 'verified' (USPS confirms it, unchanged), 'corrected' (USPS
 *      confirms it but fixed the spelling/ZIP), or 'unverified' (USPS can't
 *      confirm a deliverable address). Callers key their UI/badge off this.
 *   3) A CACHE — every lookup is stored in usps_address_verifications, keyed by a
 *      hash of the normalized input. The free USPS tier allows only 60 lookups an
 *      hour, so re-checking an address we've already seen must cost nothing.
 *
 * Never throws. When USPS isn't configured, or a lookup fails, it returns the
 * input unchanged with a status that says so — the form always keeps working.
 */
const crypto = require('crypto');
const usps = require('./integrations/usps');
const ADDR = require('./address');
const cfg = require('../config');

// A cached verification older than this is re-checked on next use (USPS data and
// deliverability change over time). Cheap: a re-check is one API call, then cached again.
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function configured() { return usps.configured(); }

// ---- input normalization + hashing --------------------------------------
// Reduce any address shape to the five components USPS matches on, normalized so
// two spellings of the same address share ONE cache row.
function normInput(a = {}) {
  const n = ADDR.normalizeAddress({
    line1: a.line1 || a.street || '',
    unit: a.unit || a.secondary || '',
    city: a.city || '',
    state: a.state || '',
    zip: a.zip || a.zipcode || a.postal || '',
    country: 'US',
  });
  return { line1: n.line1 || '', unit: n.unit || '', city: n.city || '', state: n.state || '', zip: (n.zip || '').slice(0, 10) };
}
function hashInput(input) {
  const k = [input.line1, input.unit, input.city, input.state, String(input.zip || '').slice(0, 5)]
    .map((s) => String(s || '').trim().toLowerCase()).join('|');
  return crypto.createHash('sha256').update(k).digest('hex');
}

// ---- USPS output -> canonical address -----------------------------------
function toCanonical(std) {
  return ADDR.normalizeAddress({
    line1: std.street || '', unit: std.secondary || '',
    city: std.city || '', state: std.state || '',
    zip: std.zip || std.zip5 || '', country: 'US',
  });
}

// Pull the deliverability signals worth keeping out of the API's additionalInfo.
function pickDpv(additionalInfo) {
  const ai = additionalInfo || {};
  const out = {
    dpvConfirmation: ai.DPVConfirmation || null,   // Y=confirmed, D/S=confirmed w/ secondary issue, N=not confirmed
    vacant: ai.vacant || null,
    business: ai.business || null,
    carrierRoute: ai.carrierRoute || null,
    deliveryPoint: ai.deliveryPoint || null,
    dpvCMRA: ai.DPVCMRA || null,
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

/**
 * Decide the status from the USPS result + the input. PURE — no DB, no network,
 * so it's fully unit-testable. Returns { status, address, dpv, changed }.
 *   status: 'verified' | 'corrected' | 'unverified'
 */
function classify(input, result) {
  const std = (result && result.standardized) || {};
  const hasAddress = !!(std.street && std.state);
  if (!hasAddress) return { status: 'unverified', address: null, dpv: pickDpv(result && result.additionalInfo), changed: false };

  const dpv = pickDpv(result && result.additionalInfo);
  // DPVConfirmation 'N' = USPS did not confirm a deliverable point → not verified.
  // 'Y' fully confirmed; 'D'/'S' confirmed to the building but the secondary
  // (apt/suite) is missing or unrecognized — still a real, standardized address.
  if (dpv && dpv.dpvConfirmation === 'N') {
    return { status: 'unverified', address: toCanonical(std), dpv, changed: false };
  }

  const address = toCanonical(std);
  // "corrected" = USPS confirms the address but its mailing one-line differs from
  // what we sent — a fixed suffix, a re-spelled/re-ZIPped city, a filled-in ZIP.
  // Compared by the canonical mailing form so pure formatting (case, abbreviations)
  // doesn't read as a change; the ZIP is compared 5-digit only so merely ADDING the
  // ZIP+4 to an already-correct address stays 'verified', not 'corrected'.
  const cmp = (a) => ADDR.canonicalOneLine({ ...a, zip: String(a.zip || '').slice(0, 5) }).toLowerCase();
  const before = cmp(normInput(input));
  const after = cmp(address);
  const changed = !!before && !!after && before !== after;
  return { status: changed ? 'corrected' : 'verified', address, dpv, changed };
}

// ---- defensive rate guard for the free tier -----------------------------
// USPS free tier = 60 lookups/hour, shared across every USPS API. A burst of live
// traffic must never burn the whole hour's quota (and starve the backfill). When a
// hard cap is configured (cfg.usps.maxPerHour > 0) we short-circuit once it's hit,
// returning a 'rate_limited' result instead of calling USPS. Default 0 = no cap
// (a paid tier). In-process only — good enough as a burst brake, not a global quota.
const hits = [];
function underRateCap() {
  const cap = Number(cfg.usps.maxPerHour || 0);
  if (!cap) return true;
  const now = Date.now();
  while (hits.length && now - hits[0] > 3600 * 1000) hits.shift();
  return hits.length < cap;
}
function noteHit() { const cap = Number(cfg.usps.maxPerHour || 0); if (cap) hits.push(Date.now()); }

// ---- DB cache -----------------------------------------------------------
async function cacheGet(db, hash) {
  try {
    const r = await db.query('SELECT input, standardized, dpv, status, verified_at FROM usps_address_verifications WHERE address_hash=$1', [hash]);
    const row = r.rows[0];
    if (!row) return null;
    if (Date.now() - new Date(row.verified_at).getTime() > CACHE_TTL_MS) return null;   // stale → re-check
    return row;
  } catch (_) { return null; }
}
async function cachePut(db, hash, input, out) {
  try {
    await db.query(
      `INSERT INTO usps_address_verifications (address_hash, input, standardized, dpv, status, verified_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (address_hash) DO UPDATE SET
         input=EXCLUDED.input, standardized=EXCLUDED.standardized, dpv=EXCLUDED.dpv,
         status=EXCLUDED.status, verified_at=now()`,
      [hash, JSON.stringify(input), out.address ? JSON.stringify(out.address) : null,
        out.dpv ? JSON.stringify(out.dpv) : null, out.status]);
  } catch (_) { /* cache is best-effort; a write failure never blocks a verify */ }
}

/**
 * Standardize one address against USPS. Options:
 *   { db }        — a pg client/pool for the cache (defaults to the shared pool)
 *   { noCache }   — skip the cache read (always hit USPS); still writes the cache
 *   { force }     — verify even past the rate cap (backfill uses its own pacing)
 *
 * Returns (never throws):
 *   { configured, status, address, dpv, changed, cached, source }
 *   status ∈ 'verified' | 'corrected' | 'unverified' | 'not_configured' | 'rate_limited' | 'error'
 *   address = the USPS-standardized canonical address (or null when none)
 */
async function standardize(addressInput, opts = {}) {
  const input = normInput(addressInput || {});
  const base = { configured: configured(), status: 'unverified', address: null, dpv: null, changed: false, cached: false, source: 'usps', input };

  if (!base.configured) return { ...base, status: 'not_configured' };
  if (!input.line1 || !input.state) return { ...base, status: 'unverified' };   // not enough to match on

  const db = opts.db || require('../db');
  const hash = hashInput(input);

  if (!opts.noCache) {
    const hit = await cacheGet(db, hash);
    if (hit) return { ...base, status: hit.status, address: hit.standardized || null, dpv: hit.dpv || null, changed: hit.status === 'corrected', cached: true };
  }

  if (!opts.force && !underRateCap()) return { ...base, status: 'rate_limited' };

  let result;
  try {
    noteHit();
    result = await usps.verifyAddress({ street: input.line1, secondary: input.unit, city: input.city, state: input.state, zip: input.zip });
  } catch (e) {
    // A hard USPS failure is NOT cached (so it re-tries next time) and never breaks the caller.
    return { ...base, status: 'error', detail: String(e && e.message || e).slice(0, 200) };
  }
  const c = classify(input, result);
  const out = { ...base, status: c.status, address: c.address, dpv: c.dpv, changed: c.changed };
  await cachePut(db, hash, input, out);
  return out;
}

// Test hook: clear the in-process rate window (so a test can assert the cap fires).
function _resetRateWindow() { hits.length = 0; }

module.exports = { configured, standardize, classify, toCanonical, pickDpv, normInput, hashInput, _resetRateWindow };

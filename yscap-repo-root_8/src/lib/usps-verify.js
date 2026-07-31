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
// USPS returns its standardized address in ALL CAPS (Publication 28). We keep the
// authoritative parts but present them in the app's mixed-case mailing convention,
// while keeping EVERY component as its own field (street, unit, city, state, the
// 5-digit ZIP, the +4, and the full ZIP) so downstream code can use any part
// without re-parsing. The one-line stays for the surfaces that only want a label.
const KEEP_UPPER = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'PO', 'US', 'RR', 'HC']);
function properCaseWord(w) {
  const up = String(w || '').toUpperCase();
  if (KEEP_UPPER.has(up)) return up;                            // directionals, PO/US/RR/HC
  if (/^\d+(?:ST|ND|RD|TH)$/i.test(w)) return String(w).toLowerCase();   // 1st, 2nd, 10th
  if (/^\d+[A-Za-z]?$/.test(w)) return up;                      // house number, unit "4B"
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();  // Brooklyn, Main, Apt, Ste
}
function properCase(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).map(properCaseWord).join(' ');
}
function toCanonical(std) {
  const zip5 = String(std.zip5 || std.zip || '').replace(/\D/g, '').slice(0, 5);
  const zip4 = String(std.zipPlus4 || '').replace(/\D/g, '').slice(0, 4)
    || (String(std.zip || '').includes('-') ? String(std.zip).split('-')[1].replace(/\D/g, '').slice(0, 4) : '');
  const zip = zip5 ? (zip4 ? `${zip5}-${zip4}` : zip5) : '';
  const norm = ADDR.normalizeAddress({
    line1: properCase(std.street || ''), unit: properCase(std.secondary || ''),
    city: properCase(std.city || ''), state: std.state || '',
    zip, country: 'US',
  });
  // Explicit separate fields kept in the back end (the front end still shows oneLine).
  return { ...norm, street: norm.line1, zip, zip5, zip4, formatted_address: norm.oneLine, source: 'usps' };
}

// Pull the deliverability signals worth keeping out of the API's additionalInfo.
function pickDpv(additionalInfo) {
  const ai = additionalInfo || {};
  const out = {
    dpvConfirmation: ai.DPVConfirmation || null,   // Y=confirmed, D/S=confirmed w/ secondary issue, N=not confirmed
    vacant: ai.vacant || null,
    business: ai.business || null,
    centralDeliveryPoint: ai.centralDeliveryPoint || null,
    carrierRoute: ai.carrierRoute || null,
    deliveryPoint: ai.deliveryPoint || null,
    dpvCMRA: ai.DPVCMRA || null,
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

/**
 * Plain-language reading of the USPS Delivery Point Validation code, so the screen
 * (and the audit log) can explain WHY a result is what it is. PURE + unit-testable.
 * Y = primary + any unit confirmed; D = building confirmed, an apartment/suite is
 * MISSING (the unit is OPTIONAL — still deliverable and importable as-is); S =
 * building confirmed, the unit given is NOT recognized (also optional/importable);
 * N/blank = no confirmed delivery point. Returns null when there is no DPV signal.
 */
function deliverability(dpv) {
  const code = dpv && dpv.dpvConfirmation ? String(dpv.dpvConfirmation).toUpperCase() : null;
  if (!code) return dpv ? { code: null, label: 'USPS returned no delivery-point confirmation.', deliverable: false, unitIssue: false } : null;
  switch (code) {
    case 'Y': return { code, label: 'Confirmed deliverable by USPS.', deliverable: true, unitIssue: false };
    case 'D': return { code, label: 'USPS confirms delivery to this building. An apartment/suite number is optional — you can import this address as-is, or add the unit if you have it.', deliverable: true, unitIssue: true };
    case 'S': return { code, label: 'USPS confirms delivery to this building but did not recognize the apartment/suite entered. The unit is optional — you can import this address as-is, or correct it if you have it.', deliverable: true, unitIssue: true };
    case 'N': return { code, label: 'USPS could not confirm this as a deliverable address. Correct the address and re-verify.', deliverable: false, unitIssue: false };
    default:  return { code, label: `USPS delivery-point code ${code}.`, deliverable: false, unitIssue: false };
  }
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
  // An apartment/suite is NEVER required here: 'D'/'S' stay verified/corrected so a
  // building-confirmed address always imports, unit or no unit (owner-directed).
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

/**
 * Return the address that is safe to send to a financing counterparty.
 *
 * The USPS stamp is stored beside `property_address` so a backfill never mutates
 * a live loan. Capital-provider exports should use that official form once USPS
 * has confirmed it, but must never use an unverified stamp.
 */
function preferredFinancingAddress(app = {}) {
  const status = String(app.usps_match || '').toLowerCase();
  const official = app.usps_address;
  const hasOfficialAddress = official && typeof official === 'object' && !Array.isArray(official)
    && !!(official.line1 || official.street || official.oneLine);
  // A background check may stage a valid USPS proposal, but financing exports
  // must not silently adopt it. The staff import action is the human decision
  // that makes this the working/financing address and clears the condition.
  const verified = (status === 'verified' || status === 'corrected')
    && hasOfficialAddress && !!app.usps_imported_at;
  return verified ? official : (app.property_address || {});
}

module.exports = {
  configured, standardize, classify, toCanonical, pickDpv, deliverability, normInput, hashInput,
  preferredFinancingAddress, _resetRateWindow,
};

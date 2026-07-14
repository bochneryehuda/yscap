'use strict';

/**
 * Company-wide pricing defaults (owner-directed 2026-07-14) — the singleton the
 * Pricing Admin Center controls. Cached with a short TTL and bust()-able on
 * save, mirroring src/routes/roster.js. current() is SYNCHRONOUS: pricing.js
 * reads it inline while normalizing a quote, so it must never block and must
 * fall back to the exact hardcoded literals when the cache is cold (identical
 * to pre-feature behavior).
 */
const db = require('../db');

// The exact literals the system used before this feature — the cold-cache and
// missing-row fallback, so an unwarmed process prices identically to before.
const SYSTEM_DEFAULTS = Object.freeze({
  markupStdPct: 0.5, markupGoldPct: 0.5,
  origStdPct: 1.25, origGoldPct: 1.25,
  lenderFee: 2195, creditFee: 150, appraisalFee: 800,
  titleFee: null,   // null = auto-estimate per state
});

let _cache = { at: 0, val: SYSTEM_DEFAULTS };
const TTL_MS = 60 * 1000;

function shape(row) {
  if (!row) return SYSTEM_DEFAULTS;
  const n = (v, d) => (v == null || v === '' || isNaN(Number(v)) ? d : Number(v));
  return {
    markupStdPct:  n(row.markup_std_pct, SYSTEM_DEFAULTS.markupStdPct),
    markupGoldPct: n(row.markup_gold_pct, SYSTEM_DEFAULTS.markupGoldPct),
    origStdPct:    n(row.orig_std_pct, SYSTEM_DEFAULTS.origStdPct),
    origGoldPct:   n(row.orig_gold_pct, SYSTEM_DEFAULTS.origGoldPct),
    lenderFee:     n(row.lender_fee, SYSTEM_DEFAULTS.lenderFee),
    creditFee:     n(row.credit_fee, SYSTEM_DEFAULTS.creditFee),
    appraisalFee:  n(row.appraisal_fee, SYSTEM_DEFAULTS.appraisalFee),
    // title_fee NULL means auto-estimate — preserve null (don't coerce to 0).
    titleFee:      row.title_fee == null || row.title_fee === '' ? null : Number(row.title_fee),
  };
}

async function load() {
  try {
    const r = await db.query(
      `SELECT markup_std_pct, markup_gold_pct, orig_std_pct, orig_gold_pct,
              lender_fee, credit_fee, appraisal_fee, title_fee
         FROM company_pricing_settings WHERE is_current LIMIT 1`);
    _cache = { at: Date.now(), val: shape(r.rows[0]) };
  } catch (e) {
    // Never let a settings hiccup break pricing — keep the last good value.
    if (!_cache.val) _cache = { at: Date.now(), val: SYSTEM_DEFAULTS };
  }
  return _cache.val;
}

// Synchronous current defaults (from cache); refreshes in the background when
// stale so the hot pricing path never awaits.
function current() {
  if (Date.now() - _cache.at > TTL_MS) { load().catch(() => {}); }
  return _cache.val || SYSTEM_DEFAULTS;
}

function bust() { _cache = { at: 0, val: _cache.val || SYSTEM_DEFAULTS }; }

module.exports = { current, load, bust, SYSTEM_DEFAULTS };

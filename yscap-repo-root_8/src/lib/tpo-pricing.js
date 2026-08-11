'use strict';

/**
 * TPO (broker/wholesale) PRICING LAYER (owner-directed 2026-08-06) — a NEW layer
 * that sits ON TOP of the frozen pricing engines. It resolves the effective
 * pricing settings for a TPO file and changes NO retail number: a retail file
 * never calls this (pricing.js reads pricingSettings.current() whenever no
 * settings are passed), so retail is byte-identical.
 *
 * Precedence, per owner:
 *   frozen engine → retail company default → TPO channel default → that firm's
 *   override → broker fee (origination only, never the rate).
 * Every layer is PER FIELD: a TPO-channel or firm value overrides that one field;
 * a NULL field falls through to the layer above. So "default all the same" = leave
 * the TPO fields NULL; "cut Gold origination for TPO" = set only orig_gold_pct.
 *
 * current()-style resolution is SYNCHRONOUS and 60s-cached exactly like
 * pricing-settings.current(): pricing.js reads the resolved cd inline while
 * normalizing a quote, so it must never block. bust() on save.
 */
const db = require('../db');
const pricingSettings = require('./pricing-settings');

// The markup/origination columns, paired (cd-shaped key → DB column). markup_tiers
// and broker_orig_pct are handled separately below.
const PCT_FIELDS = [
  ['markupStdPct', 'markup_std_pct'], ['markupGoldPct', 'markup_gold_pct'], ['markupSilverPct', 'markup_silver_pct'],
  ['origStdPct', 'orig_std_pct'], ['origGoldPct', 'orig_gold_pct'], ['origSilverPct', 'orig_silver_pct'],
];

function numOrNull(v) { return (v == null || v === '' || isNaN(Number(v))) ? null : Number(v); }

// Sane technical ceilings — DEFENSE IN DEPTH (adversarial audit 2026-08-06). The
// write routes validate these, but mergeSettings clamps again so a hand-edited /
// hostile DB row can NEVER price a loan (a numeric(6,3) column holds up to 999.999,
// which as a fee would blow up closing costs). A markup/orig is a percent 0-100
// (same range the retail admin route enforces); a broker origination fee is capped
// at MAX_BROKER_FEE_PCT points. Clamping to these NEVER alters a legitimate value.
const MAX_MARKUP_ORIG_PCT = 100;
const MAX_BROKER_FEE_PCT = 5;   // origination points a broker firm may charge; owner-adjustable
function clampPct(v, hi) {
  if (v == null || isNaN(Number(v))) return null;
  const n = Number(v);
  return Math.min(hi, Math.max(0, n));
}

const TTL_MS = 60 * 1000;

// ── TPO channel settings (the one-row singleton) ────────────────────────────
let _chan = { at: 0, val: null };
async function loadChannel() {
  try {
    const r = await db.query(
      `SELECT markup_std_pct, markup_gold_pct, markup_silver_pct,
              orig_std_pct, orig_gold_pct, orig_silver_pct, markup_tiers
         FROM tpo_pricing_settings WHERE id = 1 LIMIT 1`);
    _chan = { at: Date.now(), val: r.rows[0] || {} };
  } catch (e) {
    // Never let a settings hiccup change how a TPO file prices — keep the last
    // good value (or an empty object, which resolves to pure retail).
    if (!_chan.val) _chan = { at: Date.now(), val: {} };
  }
  return _chan.val;
}
function channelCurrent() {
  if (Date.now() - _chan.at > TTL_MS) { loadChannel().catch(() => {}); }
  return _chan.val || {};
}

// ── Per-firm overrides (all firms cached in one map) ────────────────────────
let _firms = { at: 0, val: null };
async function loadFirms() {
  try {
    const r = await db.query(
      `SELECT tpo_firm_id, markup_std_pct, markup_gold_pct, markup_silver_pct,
              orig_std_pct, orig_gold_pct, orig_silver_pct, markup_tiers, broker_orig_pct
         FROM tpo_firm_pricing`);
    const map = {};
    for (const row of r.rows) map[String(row.tpo_firm_id)] = row;
    _firms = { at: Date.now(), val: map };
  } catch (e) {
    if (!_firms.val) _firms = { at: Date.now(), val: {} };
  }
  return _firms.val;
}
function firmsCurrent() {
  if (Date.now() - _firms.at > TTL_MS) { loadFirms().catch(() => {}); }
  return _firms.val || {};
}

function bust() {
  _chan = { at: 0, val: _chan.val };
  _firms = { at: 0, val: _firms.val };
}

/**
 * PURE: merge retail company defaults ← TPO channel row ← firm row into a
 * cd-shaped object (same shape pricingSettings.current() returns), plus
 * brokerFeePct. Each markup/orig field is retail's default unless the channel or
 * the firm set a non-null value for it; markup_tiers is overridden as a whole
 * object when set. The broker fee comes ONLY from the firm row (broker_orig_pct)
 * and is null unless it is a positive number.
 *
 * `retail` is a cd object; `channelRow`/`firmRow` are raw DB rows (or null/{}).
 * Never mutates `retail`.
 */
function mergeSettings(retail, channelRow, firmRow) {
  const out = Object.assign({}, retail);
  const overlay = (row) => {
    if (!row) return;
    for (const [key, col] of PCT_FIELDS) {
      const v = numOrNull(row[col]);
      if (v != null) out[key] = v;
    }
    const tiers = pricingSettings.cleanMarkupTiers(row.markup_tiers);
    if (tiers) out.markupTiers = tiers;
  };
  overlay(channelRow);
  overlay(firmRow);
  // DEFENSE IN DEPTH: clamp every resolved markup/orig to a sane percent so a bad
  // stored row can never price a loan even if a future write path forgets to
  // validate. Legitimate values (0-100, write-validated) are unchanged.
  for (const [key] of PCT_FIELDS) {
    if (out[key] != null) out[key] = clampPct(out[key], MAX_MARKUP_ORIG_PCT);
  }
  // The broker's own origination fee (points) — firm-set, origination only. Null
  // unless a positive number, so a 0/blank/absent value is inert (no fee line);
  // clamped to MAX_BROKER_FEE_PCT so it can never balloon closing costs.
  const bf = firmRow ? numOrNull(firmRow.broker_orig_pct) : null;
  out.brokerFeePct = (bf != null && bf > 0) ? clampPct(bf, MAX_BROKER_FEE_PCT) : null;
  return out;
}

/**
 * The effective pricing settings for a file. A retail file returns
 * pricingSettings.current() UNCHANGED (byte-identical). A TPO file returns the
 * merged cd + brokerFeePct. `app` needs is_tpo + tpo_firm_id (the pricing loaders
 * already select both).
 */
function effectiveSettingsFor(app) {
  const retail = pricingSettings.current();
  if (!app || !app.is_tpo) return retail;
  const firmId = app.tpo_firm_id ? String(app.tpo_firm_id) : null;
  const firmRow = firmId ? (firmsCurrent()[firmId] || null) : null;
  return mergeSettings(retail, channelCurrent(), firmRow);
}

module.exports = {
  effectiveSettingsFor,
  mergeSettings,
  channelCurrent,
  firmsCurrent,
  loadChannel,
  loadFirms,
  bust,
  MAX_MARKUP_ORIG_PCT,
  MAX_BROKER_FEE_PCT,
  _internals: { numOrNull, PCT_FIELDS, clampPct },
};

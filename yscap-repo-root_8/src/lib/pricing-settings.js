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
  markupStdPct: 0.5, markupGoldPct: 0.5, markupSilverPct: 0.5,
  origStdPct: 1.25, origGoldPct: 1.25, origSilverPct: 1.25,
  // OUR OWN FEE. `lenderFee` is the TOTAL and is now DERIVED from `lenderFees`
  // below (1,200 + 995 = 2,195, byte-for-byte the number it always was) — it is
  // kept as the literal every pre-split reader and the approval detector compare
  // against, and is never removed while something might still read it.
  lenderFee: 2195, creditFee: 150, appraisalFee: 800,
  // The two real parts plus the New York legal ladder and the optional New York
  // settlement agent fee (owner-directed 2026-08-26, db/632).
  // `src/lib/lender-fees.js` is the ONE definition of what each is, which deals
  // land on which rung and how a manual amount overrides it — this file only
  // stores and cleans them.
  lenderFees: {
    underwriting: 1200, legal: 995,
    legalGroundUp: 2000, legalNy: 2000, legalNyHigh: 2500,
    settlementNy: 750, cemaNy: 1000,
  },
  // The flat underwriting & processing number, restated here ONLY so the approval
  // detector has a scalar company default to compare a typed box against (typing
  // 1,200 back is not a change). Derived from `lenderFees.underwriting` in
  // `shape()`, so the two can never drift on a configured row.
  underwritingFee: 1200,
  titleFee: null,   // null = auto-estimate per state
  /* Admin-managed extra closing fees: [{ name, amount, state }]. state '' = all
     files; a 2-letter code = that state only.

     EMPTY BY DEFAULT SINCE 2026-08-26. It used to carry a MANDATORY $2,000 New
     York "Settlement agent fee", and the owner asked for that to be removed and
     folded into the higher New York LEGAL fee (*"remove the extra settlement fee
     that we have now listed for New York files and replace it with higher legal
     fees"*). Leaving it here as a cold-cache fallback would re-apply it on any
     unwarmed process and bill a New York borrower twice — the settled-in-db/632
     row is gone from the database and it has to be gone from here too. The
     OPTIONAL replacement lives in `lenderFees.settlementNy`. */
  extraFees: [],
  // Per-experience-tier markup control (owner-directed item 15). null = OFF —
  // every program/tier keeps its historic markup (Gold Tier 1 = 0, etc.). When
  // set, shaped { standard:{1?,2?,3?}, gold, silver } of PERCENTS. pricing.js
  // reads it in markupTiersFor(). Default null so behavior is byte-identical
  // until an admin fills a tier in the Pricing Center.
  markupTiers: null,
  // Program ON/OFF switches (owner-directed 2026-08-18, db/583). null = every
  // program offered — the pre-feature behavior. When set, shaped
  // { gold: { active:false, note:'…' } } — only switched-OFF programs are
  // stored. The rules live in src/lib/program-availability.js (one definition);
  // this file only stores/cleans the value.
  programAvailability: null,
  // The construction feasibility / project review fee (owner-directed 2026-08-21, db/609).
  // The owner's own numbers; `src/lib/feasibility-fee.js` is the ONE definition of what the fee
  // is, which deals attract it and what it is called — this file only stores and cleans it.
  feasibilityFees: { groundUp: 1250, heavyRehab: 750 },
});

// Normalize an extra-fees value (from a jsonb column or an API body) into a clean
// [{ name, amount, state }] array. Drops junk / unnamed / non-positive rows.
function cleanExtraFees(v) {
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.map((f) => ({
    name: String((f && f.name) || '').trim().slice(0, 60),
    amount: Number(f && f.amount),
    state: String((f && f.state) || '').trim().toUpperCase().slice(0, 2),
  })).filter((f) => f.name && isFinite(f.amount) && f.amount > 0);
}

let _cache = { at: 0, val: SYSTEM_DEFAULTS };
const TTL_MS = 60 * 1000;

function shape(row) {
  if (!row) return SYSTEM_DEFAULTS;
  const n = (v, d) => (v == null || v === '' || isNaN(Number(v)) ? d : Number(v));
  return {
    markupStdPct:  n(row.markup_std_pct, SYSTEM_DEFAULTS.markupStdPct),
    markupGoldPct: n(row.markup_gold_pct, SYSTEM_DEFAULTS.markupGoldPct),
    markupSilverPct: n(row.markup_silver_pct, SYSTEM_DEFAULTS.markupSilverPct),
    origStdPct:    n(row.orig_std_pct, SYSTEM_DEFAULTS.origStdPct),
    origGoldPct:   n(row.orig_gold_pct, SYSTEM_DEFAULTS.origGoldPct),
    origSilverPct: n(row.orig_silver_pct, SYSTEM_DEFAULTS.origSilverPct),
    // The TOTAL is DERIVED from the parts (see SYSTEM_DEFAULTS) so a company that
    // configures its parts can never show a total that disagrees with them. The
    // stored `lender_fee` column stays the fallback for a row with no parts yet.
    lenderFee:     n(row.lender_fee, SYSTEM_DEFAULTS.lenderFee),
    creditFee:     n(row.credit_fee, SYSTEM_DEFAULTS.creditFee),
    appraisalFee:  n(row.appraisal_fee, SYSTEM_DEFAULTS.appraisalFee),
    // title_fee NULL means auto-estimate — preserve null (don't coerce to 0).
    titleFee:      row.title_fee == null || row.title_fee === '' ? null : Number(row.title_fee),
    // Cleaned through feasibility-fee's own normalizer, so an unreadable stored value falls back
    // to the owner's number rather than silently making a real fee vanish from a term sheet.
    feasibilityFees: require('./feasibility-fee').cleanFeasibilityFees(row.feasibility_fees),
    extraFees:     cleanExtraFees(row.extra_fees),
    // Cleaned through lender-fees' own normalizer, so an unreadable stored value falls back to the
    // owner's numbers rather than silently changing what a real borrower is charged.
    lenderFees:    require('./lender-fees').cleanLenderFees(row.lender_fees),
    markupTiers:   cleanMarkupTiers(row.markup_tiers),
    // Cleaned by the ONE rule module — never a second copy of the shape here.
    programAvailability: require('./program-availability').cleanProgramAvailability(row.program_availability),
  };
}

/* THE TOTAL IS THE SUM OF THE PARTS — restated onto the shaped row so a caller that reads
   `cd.lenderFee` (the approval detector, a legacy surface) sees the same number `pricing.js`
   derives, and `cd.underwritingFee` gives that detector the scalar it needs to recognise a typed
   box as a restatement of the company default rather than an exception. A general file's total is
   1,200 + 995 = 2,195, which is byte-for-byte what the column held. */
function withDerivedTotals(shaped, row) {
  const p = shaped.lenderFees || SYSTEM_DEFAULTS.lenderFees;
  const out = { ...shaped, underwritingFee: Number(p.underwriting) };
  /* THE TOTAL IS DERIVED ONLY FROM PARTS THE ROW ACTUALLY CARRIED. `cleanLenderFees` falls back
     to the system numbers for a row that has none, which is right for PRICING (a blank column must
     never make a real fee vanish) and wrong for HISTORY: `asOf()` answers "what was the company
     default on the day this file registered?", and a settings row written before db/632 has no
     parts — answering with today's parts would report a total that company never had, and the
     approval detector would then read an honest restatement of their old total as a discount.
     db/632 seeds every row from its own `lender_fee`, so in practice the two agree; this makes
     that a property rather than a coincidence. */
  if (row && row.lender_fees != null) out.lenderFee = Number(p.underwriting) + Number(p.legal);
  return out;
}

// Normalize a per-tier markup map (jsonb column or an API body) into
// { standard:{1?,2?,3?}, gold, silver } of numeric PERCENTS (e.g. 0.75). A tier
// left blank/absent is simply omitted (that program/tier keeps its historic
// markup). Returns null when nothing valid remains, so an unconfigured company
// prices byte-for-byte as before. Keys are kept as strings ('1'/'2'/'3'); a
// numeric lookup (comp[1]) still resolves them since JS coerces the index.
function cleanMarkupTiers(v) {
  let obj = v;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (_) { return null; } }
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const prog of ['standard', 'gold', 'silver']) {
    const src = obj[prog];
    if (!src || typeof src !== 'object') continue;
    const tiers = {};
    for (const t of ['1', '2', '3']) {
      const raw = src[t] != null ? src[t] : src[Number(t)];
      if (raw == null || raw === '') continue;
      const num = Number(raw);
      if (isFinite(num) && num >= 0) tiers[t] = num;
    }
    if (Object.keys(tiers).length) out[prog] = tiers;
  }
  return Object.keys(out).length ? out : null;
}

// The subset of extra fees that apply to a file in `state` (empty state = all).
function extraFeesForState(fees, state) {
  const st = String(state || '').trim().toUpperCase();
  return (Array.isArray(fees) ? fees : []).filter((f) => !f.state || f.state === st);
}
function extraFeesTotalForState(fees, state) {
  return extraFeesForState(fees, state).reduce((s, f) => s + (Number(f.amount) || 0), 0);
}

async function load() {
  try {
    const r = await db.query(
      `SELECT markup_std_pct, markup_gold_pct, markup_silver_pct, orig_std_pct, orig_gold_pct, orig_silver_pct,
              lender_fee, credit_fee, appraisal_fee, title_fee, extra_fees, markup_tiers, program_availability,
              feasibility_fees, lender_fees
         FROM company_pricing_settings WHERE is_current LIMIT 1`);
    _cache = { at: Date.now(), val: withDerivedTotals(shape(r.rows[0]), r.rows[0]) };
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

/**
 * The company defaults that were IN FORCE at a moment in the past.
 *
 * This table is append-only (each save flips the prior current row and inserts a
 * new one), so "what was the default when this file was registered?" is a fact
 * that can be read rather than guessed — which is what lets a per-file value be
 * classified as a deliberate override or as a copy of that day's default
 * (owner-reported 2026-08-20; see db/600 and the studio's seedAdminDefaults).
 *
 * A moment older than every settings row falls back to SYSTEM_DEFAULTS — the
 * literals the studio's own `CO` constants carried before the Pricing Admin
 * Center existed. NEVER throws: an unreadable history returns null, and every
 * caller must read that as "cannot classify", never as "it was the default".
 */
async function asOf(when) {
  if (!when) return null;
  try {
    const r = await db.query(
      /* THE COMPARISON IS WIDENED BY ONE MILLISECOND, AND THAT IS NOT A FUDGE.
         Postgres stores `timestamptz` to the MICROSECOND; a JavaScript Date holds only
         MILLISECONDS, so a timestamp that has been through node-pg (which is how every caller gets
         one — a registration's `created_at`, a settings row's own) is the stored value TRUNCATED
         DOWN. Compared with a bare `<=`, a settings row written in the same millisecond as the
         moment being asked about is EXCLUDED, and the answer becomes the PREVIOUS default — so a
         knob that honestly restated the default in force would be classified as a deviation and
         file an exception nobody asked for. MEASURED: `asOf(row.created_at)` on a row stored at
         `…33.362795` returned the NEXT row's numbers, because the Date carried `…33.362`.
         Widening by 1ms cannot reach any other row: two settings rows written inside one
         millisecond of each other would need two saves in the same instant, and even then the
         later one is the one in force at that instant, which is what this returns. */
      `SELECT markup_std_pct, markup_gold_pct, markup_silver_pct, orig_std_pct, orig_gold_pct, orig_silver_pct,
              lender_fee, credit_fee, appraisal_fee, title_fee, extra_fees, markup_tiers, program_availability,
              feasibility_fees, lender_fees
         FROM company_pricing_settings
        WHERE created_at < $1::timestamptz + interval '1 millisecond'
        ORDER BY created_at DESC LIMIT 1`, [when]);
    return r.rows[0] ? withDerivedTotals(shape(r.rows[0]), r.rows[0]) : SYSTEM_DEFAULTS;
  } catch (_) { return null; }
}

module.exports = { current, load, asOf, bust, SYSTEM_DEFAULTS, cleanExtraFees, cleanMarkupTiers, extraFeesForState, extraFeesTotalForState };

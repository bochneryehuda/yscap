'use strict';

/* =====================================================================
   pricing-overrides.js — the ONE definition of the staff pricing-override
   policy: WHO may enter an override in the Products & Pricing (Term Sheet
   Studio) admin zone, and WHICH overrides must be APPROVED before the terms
   are confirmed.

   Owner-directed 2026-07-27 (evening) — "every single time somebody is
   changing the defaults and he's overriding something in the admin section
   this should be sent to the admin for approval, no matter if it's reducing
   the rate, reducing the fee, or manual programs":

     · EVERY staff member (loan officer, processor, underwriter, admin,
       super_admin) may OPEN the admin pricing zone and enter an override —
       the markup, the origination points, any closing-cost fee, the approved
       effective purchase price, or a full manual basis (LTV / ARV / LTC /
       rate / reserve). The loan officer builds the exception themselves and
       registers it; nothing is silently stripped and no role is refused at
       the door anymore (that was the 2026-07-16 rule this SUPERSEDES — a
       loan officer reported the admin section had simply disappeared).
     · ANY of those knobs moved AWAY FROM THE COMPANY DEFAULT makes the
       registration an EXCEPTION: it registers immediately but stays
       "pending approval" in the Escalations box, the borrower is NOT sent
       terms, and no DocuSign term-sheet package may issue, until an admin /
       super-admin approves it. Reducing the rate, reducing a fee and a
       manual program are all treated identically.
     · A registration that touches NOTHING in the admin zone (or types the
       company default back) is unchanged — it confirms immediately, exactly
       as before.

   What is NOT an override: the deal INPUTS (experience, ARV, as-is value,
   purchase price, rehab budget, term, interest reserve). Every staff role has
   had the same authority over those since 2026-07-27 morning, they are not in
   the admin zone, and they carry no company default to deviate from. Changing
   them still reopens the pricing / experience conditions (db/072) so the
   underwriter re-signs, and the Clear-to-Close / Funded / term-sheet-sent
   FREEZE (file-lock.js) still blocks everyone equally.

   A BORROWER never reaches any of this — borrower.js strips economics down to
   its own clamped knob set (there is no borrower admin-mode path). This module
   governs STAFF only, and is PURE (no DB) so it unit-tests without a server.
   ===================================================================== */

// ---------------------------------------------------------------------------
// The admin-zone knobs that HAVE a company default (the Pricing Admin Center
// singleton, src/lib/pricing-settings.js). Typing the default back is NOT an
// override — only a value that DIFFERS from it is.
// ---------------------------------------------------------------------------
const DEFAULTED_OVERRIDE_KEYS = Object.freeze({
  markupStdPct:  { label: 'Rate markup / YSP — Standard',              unit: 'pct'   },
  markupGoldPct: { label: 'Rate markup / YSP — Gold',                  unit: 'pct'   },
  markupSilverPct: { label: 'Rate markup / YSP — Silver',              unit: 'pct'   },
  origStdPct:    { label: 'Origination points — Standard',             unit: 'pct'   },
  origGoldPct:   { label: 'Origination points — Gold',                 unit: 'pct'   },
  origSilverPct: { label: 'Origination points — Silver',               unit: 'pct'   },
  // The Manual product prices on the Standard engine and has NO company default of
  // its own — a blank manual field means "use Standard" (owner-directed 2026-07-30,
  // mirrored in pricing.js `origKey`). So it is compared against the STANDARD
  // default via `defaultKey`: typing 1.25 back while the company default is 1.25 is
  // not a change, exactly like its three siblings. Without `defaultKey` the lookup
  // would find no `cd.origManualPct`, read as "no default", and demand an approval
  // for a value that IS the default.
  origManualPct: { label: 'Origination points — Manual', unit: 'pct', defaultKey: 'origStdPct' },
  lenderFee:     { label: 'Underwriting / processing / legal fee',     unit: 'money' },
  creditFee:     { label: 'Credit-report fee',                         unit: 'money' },
  appraisalFee:  { label: 'Appraisal fee (paid outside closing)',      unit: 'money' },
  // The company default for title is NULL = "auto-estimate per state", so any
  // typed number is a deviation.
  titleFee:      { label: 'Title / escrow fee',                        unit: 'money' },
});

// The admin-zone knobs with NO company default — they exist only to OVERRIDE
// the guideline engine, so any real value is an override by definition. Both the
// percent form the studio sends and the fraction form the engine takes are
// listed, because either may arrive (a re-register replays stored engine inputs,
// and accept-counter writes the fraction form).
const ENGAGED_OVERRIDE_KEYS = Object.freeze({
  ovrAcqLTVPct:  { label: 'Manual initial / as-is LTV',                unit: 'pct'   },
  ovrAcqLTV:     { label: 'Manual initial / as-is LTV',                unit: 'frac'  },
  ovrARLTVPct:   { label: 'Manual ARV LTV',                            unit: 'pct'   },
  ovrARLTV:      { label: 'Manual ARV LTV',                            unit: 'frac'  },
  ovrLTCPct:     { label: 'Manual loan-to-cost',                       unit: 'pct'   },
  ovrLTC:        { label: 'Manual loan-to-cost',                       unit: 'frac'  },
  ovrRatePct:    { label: 'Manual note rate',                          unit: 'pct'   },
  ovrRate:       { label: 'Manual note rate',                          unit: 'frac'  },
  ovrIrMonths:   { label: 'Manual interest-reserve months',            unit: 'num'   },
  ovrEffPrice:   { label: 'Approved effective purchase price',         unit: 'money' },
  // Manual GOLD top-tier (Tier 1) markup (owner-directed item 15) — the studio's
  // "manual section for the top tier". The top experience tier historically
  // carries NO markup, so ANY value here is a deliberate exception → routes to
  // an admin for approval, exactly like the other admin-zone knobs. A value of 0
  // is not engaged (it IS the historic default), so it never triggers approval.
  markupGoldT1Pct: { label: 'Gold top-tier (Tier 1) markup',           unit: 'pct'   },
  // Out-of-pocket rehab exception (owner-authorized 2026-07-31): a dollar amount of
  // rehab brought out of pocket so the initial advance rises toward the acquisition
  // cap. Off by default; any real amount (or the "raise initial to max" toggle) needs
  // the same admin approval as any other pricing override.
  oopRehab:      { label: 'Out-of-pocket rehab exception',             unit: 'money' },
  oopRehabMax:   { label: 'Out-of-pocket rehab — raise the initial to its max', unit: 'flag' },
  manualPricing: { label: 'Manual scenario (admin-set basis)',         unit: 'flag'  },
  forcePrice:    { label: 'Force-price past the guideline limits',     unit: 'flag'  },
});

// Every knob in the studio's admin zone, in one list.
const APPROVAL_OVERRIDE_KEYS = Object.freeze(
  Object.keys(DEFAULTED_OVERRIDE_KEYS).concat(Object.keys(ENGAGED_OVERRIDE_KEYS)));

// "Meaningfully engaged": a truthy flag, or a numeric override carrying a real
// NON-ZERO value — NOT a present-but-default key (manualPricing:false is sent on
// every staff register, and a blanked manual knob can arrive as 0, so mere
// presence must never count as an override). Deliberately IDENTICAL to
// manual-program.js `engaged` so "is this a manual product" and "does this need
// approval" can never disagree about the same key.
function engaged(v) {
  if (v === true) return true;
  if (v == null || v === '' || v === false) return false;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  const n = Number(v);
  return Number.isFinite(n) ? n !== 0 : String(v).trim() !== '';
}

function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

// A present, non-blank value. A key sent as '' means "clear it / use the company
// default" (the studio's explicit-blank contract) — never an override.
function hasValue(o, k) {
  return o && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null && o[k] !== '';
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Money/percent comparison with a cent-level tolerance, so 1.25 vs "1.250"
// (or a float round-trip through JSON) never reads as a change.
function sameNumber(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < 0.0001;
}

/**
 * Every admin-zone knob in `raw` that DEVIATES from the company default — i.e.
 * everything on this registration that needs an admin's approval.
 *
 * `defaults` is the company pricing singleton (pricing-settings.current()); when
 * it is missing, a defaulted knob carrying any real value counts as a change
 * (fail SAFE — we would rather ask for an approval than skip one).
 *
 * Returns [{ key, label, unit, value, defaultValue }], stable order, empty when
 * the registration prices on the company defaults.
 */
function pricingOverridesEngaged(raw, defaults) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const cd = (defaults && typeof defaults === 'object') ? defaults : null;
  const out = [];
  for (const key of Object.keys(DEFAULTED_OVERRIDE_KEYS)) {
    if (!hasValue(o, key)) continue;            // absent or explicitly blanked
    const meta = DEFAULTED_OVERRIDE_KEYS[key];
    const value = numOrNull(o[key]);
    if (value == null) continue;                // unreadable → not a change we can name
    // `defaultKey` lets a knob borrow another knob's company default (today only
    // the Manual origination, which falls back to Standard). Absent on every other
    // key, so the lookup is unchanged for all of them.
    const defaultValue = cd ? numOrNull(cd[meta.defaultKey || key]) : null;
    if (defaultValue != null && sameNumber(value, defaultValue)) continue;   // typed the default back
    out.push({ key, label: meta.label, unit: meta.unit, value, defaultValue });
  }
  for (const key of Object.keys(ENGAGED_OVERRIDE_KEYS)) {
    if (!engaged(o[key])) continue;
    const meta = ENGAGED_OVERRIDE_KEYS[key];
    out.push({
      key, label: meta.label, unit: meta.unit,
      value: meta.unit === 'flag' ? true : numOrNull(o[key]),
      defaultValue: null,
    });
  }
  return out;
}

/** Does this override set need an admin approval before the terms are confirmed? */
function needsPricingApproval(raw, defaults) {
  return pricingOverridesEngaged(raw, defaults).length > 0;
}

/** One plain-language line per changed knob — for the escalation card, the
 *  notification body and the audit trail. Never shows the internal key name. */
function describeOverrides(changes) {
  const fmt = (unit, v) => {
    if (v == null) return '—';
    if (unit === 'flag') return 'on';
    if (unit === 'pct') return `${Number(v)}%`;
    if (unit === 'frac') return `${(Number(v) * 100).toFixed(2)}%`;
    if (unit === 'money') return '$' + Math.round(Number(v)).toLocaleString('en-US');
    return String(v);
  };
  return (Array.isArray(changes) ? changes : []).map((c) => {
    const now = fmt(c.unit, c.value);
    return c.defaultValue != null
      ? `${c.label}: ${fmt(c.unit, c.defaultValue)} → ${now}`
      : `${c.label}: ${now}`;
  });
}

/**
 * Staff override sanitizer. Since 2026-07-27 (evening) NOTHING is stripped for a
 * staff role — every role may enter every admin-zone knob, and the deviation is
 * routed to an admin for approval instead of being silently dropped or refused
 * at the door. Kept as the single chokepoint (register / quote / details /
 * completeness all call it) so a future role rule lands in ONE place.
 *
 * `strippedAdminKeys` is retained in the shape and is always false — the loud
 * "your terms would differ from what the studio showed" refusal it drove can no
 * longer happen, because nothing diverges anymore.
 */
function sanitizeStaffOverrides(role, raw) {
  const overrides = (raw && typeof raw === 'object') ? { ...raw } : {};
  return { overrides, strippedAdminKeys: false, isAdmin: isAdminRole(role) };
}

// The override allowlist for a NON-LENDER surface — a borrower OR an external
// broker (TPO). They may only send the scenario knobs the Term Sheet Studio lets
// a non-lender choose (leverage, term, reserve, estimated FICO and requested
// experience); every staff-grade knob (markup / origination / fees / manual
// LTV·LTC·ARV·rate basis) is STRUCTURALLY ABSENT. Deal economics (price / values
// / budget / state) always come from the loan file itself, so a tampered client
// can't inject a fabricated basis. Every value is coerced + clamped to the
// studio's own input ranges. Single definition — routes/borrower.js AND
// routes/tpo.js both call it (moved out of routes/borrower.js unchanged), so the
// broker can never be handed a wider allowlist than the borrower by drift.
function borrowerPricingOverrides(raw) {
  const out = {};
  const clamp = (v, lo, hi) => { const n = Number(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  const targetLTC = Number(raw && raw.targetLTC);
  if (isFinite(targetLTC) && targetLTC > 0) out.targetLTC = targetLTC;
  // An explicit blank clears the reserve: pass '' through so buildInputs resolves
  // it to 0 (its blank-clears contract). Dropping the blank left the prior reserve
  // sticking, so a borrower couldn't zero it on re-register (final audit 2026-07-17).
  if (raw && raw.irMonths === '') { out.irMonths = ''; }
  else if (raw && raw.irMonths != null) { const v = clamp(raw.irMonths, 0, 24); if (v != null) out.irMonths = Math.round(v); }
  // Interest reserve may instead be an exact dollar amount (the engine caps it at
  // the loan term). 0 is allowed and clears any prior amount → months path.
  if (raw && raw.irAmount != null && raw.irAmount !== '') { const v = clamp(raw.irAmount, 0, 100000000); if (v != null) out.irAmount = Math.round(v); }
  if (raw && raw.term != null && raw.term !== '') { const v = clamp(raw.term, 1, 36); if (v != null) out.term = Math.round(v); }
  if (raw && raw.fico != null && raw.fico !== '') { const v = clamp(raw.fico, 300, 850); if (v != null) out.fico = Math.round(v); }
  for (const k of ['expFlips', 'expHolds', 'expGround']) {
    if (raw && raw[k] != null && raw[k] !== '') { const v = clamp(raw[k], 0, 999); if (v != null) out[k] = Math.round(v); }
  }
  return out;
}

module.exports = {
  DEFAULTED_OVERRIDE_KEYS, ENGAGED_OVERRIDE_KEYS, APPROVAL_OVERRIDE_KEYS,
  pricingOverridesEngaged, needsPricingApproval, describeOverrides,
  sanitizeStaffOverrides, borrowerPricingOverrides, isAdminRole, engaged,
};

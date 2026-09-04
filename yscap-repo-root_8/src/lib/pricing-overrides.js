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
// `revenueUp: true` marks a FEE / MARKUP / RATE knob where charging ABOVE the
// company default earns the company MORE. Owner-directed 2026-08-12: "anytime you
// charge more than the default you don't need an exception; you only need one if
// you charge LESS than the default." So a revenueUp knob set at-or-above its
// default is NOT an override (no approval); BELOW its default (a discount) still
// needs approval, exactly as before. Non-revenue knobs (title with no default; and
// every leverage/basis knob in ENGAGED_OVERRIDE_KEYS) keep the old "any change
// needs approval" behavior.
const DEFAULTED_OVERRIDE_KEYS = Object.freeze({
  markupStdPct:  { label: 'Rate markup / YSP — Standard',              unit: 'pct',   revenueUp: true },
  markupGoldPct: { label: 'Rate markup / YSP — Gold',                  unit: 'pct',   revenueUp: true },
  markupSilverPct: { label: 'Rate markup / YSP — Silver',              unit: 'pct',   revenueUp: true },
  markupSpeedPct:  { label: 'Rate markup / YSP — Speed',               unit: 'pct',   revenueUp: true },
  origStdPct:    { label: 'Origination points — Standard',             unit: 'pct',   revenueUp: true },
  origGoldPct:   { label: 'Origination points — Gold',                 unit: 'pct',   revenueUp: true },
  origSilverPct: { label: 'Origination points — Silver',               unit: 'pct',   revenueUp: true },
  origSpeedPct:  { label: 'Origination points — Speed',                unit: 'pct',   revenueUp: true },
  // The Manual product prices on the Standard engine and has NO company default of
  // its own — a blank manual field means "use Standard" (owner-directed 2026-07-30,
  // mirrored in pricing.js `origKey`). So it is compared against the STANDARD
  // default via `defaultKey`: typing 1.25 back while the company default is 1.25 is
  // not a change, exactly like its three siblings. Without `defaultKey` the lookup
  // would find no `cd.origManualPct`, read as "no default", and demand an approval
  // for a value that IS the default.
  origManualPct: { label: 'Origination points — Manual', unit: 'pct', defaultKey: 'origStdPct', revenueUp: true },
  lenderFee:     { label: 'Underwriting / processing / legal fee',     unit: 'money', revenueUp: true },
  /* THE UNDERWRITING & PROCESSING HALF of that fee (owner-directed 2026-08-26, db/632). It has one
     flat company default ($1,200), so it belongs among the DEFAULTED knobs beside its siblings:
     typing 1,200 back is not a change, and charging MORE than the default earns the company more
     and needs no approval — only a discount does. Its LEGAL sibling is not here, because that
     one's default is keyed on the deal (the New York ladder) rather than being one number to
     compare against; see `legalFee` in ENGAGED_OVERRIDE_KEYS. */
  underwritingFee: { label: 'Underwriting & processing fee',           unit: 'money', revenueUp: true },
  creditFee:     { label: 'Credit-report fee',                         unit: 'money', revenueUp: true },
  /* THE MINIMUM ORIGINATION FEE (owner-directed 2026-09-04, db/696) — the floor under our own
     origination, typed on ONE file as an approved exception ("You need to add to the general
     exception pad an exception for the minimum and all the exception routes should have an added
     option to make exceptions for the minimum fee").

     IT BELONGS HERE, AMONG THE DEFAULTED KNOBS, AND NOT IN `ENGAGED_OVERRIDE_KEYS` — which is
     where an earlier plan put it, and that would have reproduced the 2026-08-20 defect exactly.
     It HAS one flat company default (the Pricing Admin Center's `min_orig_fee`, falling back to
     the $2,500 system number), so an ENGAGED entry would read the studio's own pre-filled value
     as a deviation and demand an admin approval on EVERY registration, and
     `normalizeCompanyDefaultKnobs` — which only ever looks at this list — could not blank it back
     to the studio's explicit-blank contract.

     `revenueUp` IS ARITHMETICALLY EXACT HERE, not an analogy to its siblings: the fee charged is
     `max(pctAmount, minimum)`, so RAISING the minimum can only ever raise the fee and never lower
     it. Charging more needs no approval; LOWERING the floor is a discount and does. A typed 0 —
     the outright waiver — is below the default by that same test, so it routes to an admin
     without needing `zeroIsEngaged`, which is a property of the arithmetic rather than a flag
     somebody has to remember. */
  minOrigFee:    { label: 'Minimum origination fee',                   unit: 'money', revenueUp: true },
  appraisalFee:  { label: 'Appraisal fee (paid outside closing)',      unit: 'money', revenueUp: true },
  // The company default for title is NULL = "auto-estimate per state", so any
  // typed number is a deviation. NOT revenueUp — with no numeric baseline there is
  // no "above/below" to judge, so any typed title fee still needs approval.
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
  /* The construction feasibility / project review fee, typed by hand on ONE file
     (owner-directed 2026-08-21 — "add this fee type into the manual section in the
     products and pricing so we can, any time, add it to any other project manually
     as well"). It lives HERE rather than among the defaulted knobs because its
     company default is keyed on the DEAL KIND ($1,250 ground-up / $750 heavy rehab)
     rather than being one number to compare against — so any typed amount is a
     deliberate departure from what this deal would otherwise be charged.

     `zeroIsEngaged` because a typed 0 WAIVES the fee, and waiving $1,250 is exactly
     the decision an admin should see. That is the opposite of markupGoldT1Pct above,
     where 0 IS the historic default and therefore no exception at all — which is why
     it is a per-key flag and not a change to the shared `engaged()`, whose "0 means
     unset" reading is correct for every other knob here. */
  feasibilityFee: { label: 'Construction feasibility / project review fee', unit: 'money', zeroIsEngaged: true },
  /* THE BUYER'S SHARE OF A TRANSFER TAX (owner-directed 2026-08-23). The engine
     starts from LOCAL CUSTOM — Pennsylvania splits it 50/50, New York's is the
     seller's, Virginia's deed recordation is the buyer's — but custom is not law
     anywhere: the PURCHASE CONTRACT decides, and a contract that shifts the whole
     tax onto the buyer moves real cash to close. Typeable per file, and an
     exception because it changes what the borrower must bring. */
  buyerTransferShare: { label: 'Transfer tax — buyer’s share (per the contract)', unit: 'pct', zeroIsEngaged: true },
  /* THE LEGAL FEE, typed by hand on ONE file (owner-directed 2026-08-26 — *"everything of this
     should not be hardwired. It should just be pre-filled in the manual section. Everything can be
     changeable"*). It lives HERE rather than among the defaulted knobs for the same reason the
     feasibility fee does: its company default is keyed on the DEAL (general $995, ground-up
     $2,000, New York $2,000, New York City / $100k construction / heavy rehab $2,500) rather than
     being one number to compare against — so any typed amount is a deliberate departure from what
     this deal would otherwise be charged. `zeroIsEngaged` because a typed 0 WAIVES a real fee. */
  legalFee:      { label: 'Legal fee',                                 unit: 'money', zeroIsEngaged: true },
  /* THE OPTIONAL NEW YORK SETTLEMENT AGENT FEE. Deal-keyed like the legal fee ($750 pre-filled on
     a New York file, nothing elsewhere), so any typed amount is a departure and needs an approval.

     `zeroIsEngaged` is deliberately FALSE here, and it is the one place in this list where that is
     the right call: the fee is OPTIONAL by the owner's own description, so declining it is its
     ordinary state — routing every declined optional fee to an admin would fill the approval queue
     with the non-decisions and teach people to wave it through. Typing any real amount (the $500
     end of the owner's range, say) still asks. */
  settlementFee: { label: 'New York settlement agent fee (optional)',  unit: 'money' },
  /* THE NEW YORK CEMA FEE'S AMOUNT. Its company default IS one number ($1,000), so a typed
     amount is compared against it exactly like the defaulted knobs — but it lives HERE because it
     is only ever charged on a file somebody answered YES on, so there is no default to restate on
     the files where it is absent. `zeroIsEngaged` because a typed 0 waives a real fee.

     THE ANSWER ITSELF (`nyCema`) IS DELIBERATELY NOT AN OVERRIDE AT ALL. It is a FACT about the
     deal — is there an existing mortgage being consolidated — not a discount, and it can only ever
     ADD money. Routing a factual yes to an admin would put every CEMA refinance in the approval
     queue for saying what it is. */
  cemaFee:       { label: 'New York CEMA fee',                         unit: 'money', zeroIsEngaged: true },
  oopRehabMax:   { label: 'Out-of-pocket rehab — raise the initial to its max', unit: 'flag' },
  manualPricing: { label: 'Manual scenario (admin-set basis)',         unit: 'flag'  },
  forcePrice:    { label: 'Force-price past the guideline limits',     unit: 'flag'  },
});

/* THE GOVERNMENT-CHARGE OVERRIDES — one knob per charge the closing-cost engine
   can compute (owner-directed 2026-08-23: *"All those line items should also be
   able to be added to the manual section to be overwritten"*).

   GENERATED FROM THE ENGINE'S OWN KEY LIST, never hand-typed. A charge added to
   the engine appears here — and therefore on the manual screen, in the approval
   detector, and in the audit line — without anybody remembering to add it. A
   hand-kept parallel list is how the eighth charge ends up silently unoverridable.

   `zeroIsEngaged` on every one of them: typing 0 WAIVES a real tax on a real
   closing, and waiving a $11,550 mortgage recording tax is precisely the decision
   an admin should see. That is the same reasoning as the feasibility fee above,
   and the opposite of a leverage knob where 0 simply means "unset".

   They are ENGAGED overrides rather than defaulted ones because there is no single
   company default to compare against: the automatic figure depends on the state,
   the county, the unit count and the loan size, so any typed amount is by
   definition a departure from what this deal would otherwise be charged. */
const closingCosts = require('./closing-costs');
const TAX_OVERRIDE_KEYS = Object.freeze(Object.fromEntries(
  closingCosts.CHARGE_KEYS.map((k) => [`ovrTax_${k}`, {
    label: `${closingCosts.CHARGE_LABELS[k] || k} — typed on this file`,
    unit: 'money', zeroIsEngaged: true,
  }])));

// Every knob in the studio's admin zone, in one list.
const APPROVAL_OVERRIDE_KEYS = Object.freeze(
  Object.keys(DEFAULTED_OVERRIDE_KEYS)
    .concat(Object.keys(ENGAGED_OVERRIDE_KEYS))
    .concat(Object.keys(TAX_OVERRIDE_KEYS)));

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
    if (defaultValue != null) {
      if (sameNumber(value, defaultValue)) continue;                 // typed the default back
      // Owner-directed 2026-08-12: charging MORE than the default earns the company
      // more, so a revenue knob at-or-above its default needs no approval — only a
      // discount (BELOW default) does. A non-revenue knob (title) and any knob with
      // no readable default fall through and are still flagged.
      if (meta.revenueUp && value > defaultValue) continue;
    }
    out.push({ key, label: meta.label, unit: meta.unit, value, defaultValue });
  }
  const engagedKeys = { ...ENGAGED_OVERRIDE_KEYS, ...TAX_OVERRIDE_KEYS };
  for (const key of Object.keys(engagedKeys)) {
    const meta = engagedKeys[key];
    // `zeroIsEngaged` (today only the feasibility fee): a typed 0 is a real decision —
    // it WAIVES a fee the deal would otherwise be charged — rather than the "unset"
    // that 0 means for every other knob here. It still has to be a value somebody
    // actually sent: an absent or explicitly blanked key is never an override.
    const isEngaged = meta.zeroIsEngaged
      ? (hasValue(o, key) && numOrNull(o[key]) != null)
      : engaged(o[key]);
    if (!isEngaged) continue;
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
    // A money knob here is a FEE somebody typed — the underwriting/legal fee, the
    // credit-report fee, the appraisal fee, the title fee, the feasibility fee, an
    // approved effective price. Rounding it made the approval record disagree with
    // what was actually entered ("$1,995 → $2,000" for a typed $1,999.50), on the
    // card an admin approves from, in its notification and in the audit trail that
    // outlives both. Kept in step with `email/pricing-email.fmtOverrideValue` on
    // purpose — those three surfaces must never describe one change differently.
    if (unit === 'money') {
      return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
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
 * RESTATING THE COMPANY DEFAULT IS NOT AN OVERRIDE — normalize it to the studio's
 * own explicit-blank form (owner-reported 2026-08-20).
 *
 * THE BUG THIS CLOSES. `web/v2/tools/termsheet.js seedAdminDefaults()` used to
 * PAINT the company default into the admin markup / origination / fee inputs, so
 * every registration carried an explicit per-file value that merely restated the
 * default of that day — which the register path then FROZE onto the file
 * (`applications.file_markup_*_pct`). Change the company markup afterwards and
 * the file keeps pricing at the frozen number, and re-registering reads as a
 * DISCOUNT (0.4 against a 0.5 default) so every registration needs an approval.
 * The studio no longer paints those values; this is the same rule at the SERVER,
 * so a client that still sends the seeded number — an older cached bundle, a
 * restored registration, an officer typing the default back by hand — behaves
 * identically to a blank box.
 *
 * WHY `''` AND NOT "drop the key". `''` is the studio's documented "use the
 * company default" contract and it is the ONLY form that also CLEARS a stale
 * sticky: `buildInputs` deletes it, `hasValue()` reads it as not-an-override, and
 * the register path's `hasOwnProperty` check writes NULL over the frozen value.
 * Dropping the key instead would leave an old sticky in place forever.
 *
 * WHY EXACT EQUALITY, not `sameNumber()`'s tolerance. A value that is exactly the
 * default resolves, through the company default, to the byte-identical number the
 * engine would have used — so this is provably PRICE-NEUTRAL. `pricingOverridesEngaged`
 * keeps its cent-level tolerance, which is a superset, so a near-miss still raises
 * no approval either way; it simply keeps its (harmless, deliberate-looking) sticky.
 *
 * Only the knobs that HAVE a company default are considered, and only when that
 * default is readable — with no defaults nothing is normalized (fail SAFE: keep
 * the value and let the approval detector ask, never silently drop a real override).
 */
function normalizeCompanyDefaultKnobs(raw, defaults) {
  const o = (raw && typeof raw === 'object') ? { ...raw } : {};
  const cd = (defaults && typeof defaults === 'object') ? defaults : null;
  if (!cd) return o;
  for (const key of Object.keys(DEFAULTED_OVERRIDE_KEYS)) {
    if (!hasValue(o, key)) continue;                      // absent or already blank
    const value = numOrNull(o[key]);
    if (value == null) continue;                          // unreadable → leave it alone
    const meta = DEFAULTED_OVERRIDE_KEYS[key];
    const defaultValue = numOrNull(cd[meta.defaultKey || key]);
    if (defaultValue == null) continue;                   // no default to restate
    if (value === defaultValue) o[key] = '';              // exact restatement → the blank contract
  }
  return o;
}

/**
 * Staff override sanitizer. Since 2026-07-27 (evening) NOTHING is stripped for a
 * staff role — every role may enter every admin-zone knob, and the deviation is
 * routed to an admin for approval instead of being silently dropped or refused
 * at the door. Kept as the single chokepoint (register / quote / details /
 * completeness all call it) so a future role rule lands in ONE place.
 *
 * `defaults` (the company pricing singleton) is OPTIONAL and additive: when it is
 * supplied, a knob that merely RESTATES the company default is normalized to the
 * explicit-blank form (see normalizeCompanyDefaultKnobs). Omitting it leaves the
 * payload byte-identical to before, so a caller that has no defaults in hand is
 * unchanged.
 *
 * `strippedAdminKeys` is retained in the shape and is always false — the loud
 * "your terms would differ from what the studio showed" refusal it drove can no
 * longer happen, because nothing diverges anymore.
 */
function sanitizeStaffOverrides(role, raw, defaults) {
  const overrides = normalizeCompanyDefaultKnobs(raw, defaults);
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
  // The Silver ladder's value-side rung. Same class as targetLTC — a voluntary
  // REDUCTION the studio lets a borrower pick, and one the engine can only ever
  // apply as a MIN against the cap, so it can never enlarge a loan. It is clamped
  // to a real ratio: a tampered client sending 5 (i.e. 500%) would simply be
  // inert, but bounding it keeps a nonsense value out of the persisted inputs.
  const targetARLTV = Number(raw && raw.targetARLTV);
  if (isFinite(targetARLTV) && targetARLTV > 0 && targetARLTV <= 1) out.targetARLTV = targetARLTV;
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
  DEFAULTED_OVERRIDE_KEYS, ENGAGED_OVERRIDE_KEYS, TAX_OVERRIDE_KEYS, APPROVAL_OVERRIDE_KEYS,
  pricingOverridesEngaged, needsPricingApproval, describeOverrides,
  sanitizeStaffOverrides, normalizeCompanyDefaultKnobs, borrowerPricingOverrides, isAdminRole, engaged,
};

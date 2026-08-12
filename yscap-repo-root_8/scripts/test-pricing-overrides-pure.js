/**
 * Staff pricing-override policy (owner-directed 2026-07-27 — "give authority to
 * everybody as long as the file is not clear to close", then the same evening:
 * "every single time somebody is changing the defaults and he's overriding
 * something in the admin section this should be sent to the admin for approval,
 * no matter if it's reducing the rate, reducing the fee, or manual programs").
 *
 * The policy this pins:
 *   1. NOTHING is stripped from a staff registration anymore — every role (loan
 *      officer, processor, underwriter, admin, super_admin) may enter every knob
 *      in the studio's admin pricing zone. (A loan officer reported the section
 *      had disappeared; the old rule hid it because the server stripped it.)
 *   2. A knob moved OFF the company default is what needs an admin's approval —
 *      detected here, once, so the register / quote / gate paths can't drift.
 *   3. Typing the company default back is NOT a change, and a blank field is NOT
 *      a change (the studio's "use the default" contract).
 *
 * Pure — no DB / server needed.
 */
'use strict';

const {
  APPROVAL_OVERRIDE_KEYS, DEFAULTED_OVERRIDE_KEYS, ENGAGED_OVERRIDE_KEYS,
  pricingOverridesEngaged, needsPricingApproval, describeOverrides,
  sanitizeStaffOverrides, isAdminRole, engaged,
} = require('../src/lib/pricing-overrides');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const keysOf = (list) => list.map((c) => c.key).sort();

// The company pricing defaults (pricing-settings SYSTEM_DEFAULTS shape).
const CD = {
  markupStdPct: 0.5, markupGoldPct: 0.5, origStdPct: 1.25, origGoldPct: 1.25,
  lenderFee: 2195, creditFee: 150, appraisalFee: 800, titleFee: null,
};

// ---- the key lists cover the whole admin zone ----
const ZONE = ['markupStdPct', 'markupGoldPct', 'origStdPct', 'origGoldPct',
  'lenderFee', 'creditFee', 'appraisalFee', 'titleFee',
  'ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct', 'ovrRatePct', 'ovrIrMonths', 'ovrEffPrice',
  'oopRehab', 'oopRehabMax',
  'manualPricing', 'forcePrice'];
assert(ZONE.every((k) => APPROVAL_OVERRIDE_KEYS.includes(k)),
  'every studio admin-zone knob is in the approval set');
// Out-of-pocket rehab exception (owner-authorized 2026-07-31): any real amount, or
// the "raise initial to max" toggle, needs the same admin approval as any override.
assert(needsPricingApproval({ oopRehab: 55000 }, CD) === true, 'an OOP-rehab amount needs approval');
assert(needsPricingApproval({ oopRehabMax: true }, CD) === true, 'the OOP-rehab max toggle needs approval');
assert(needsPricingApproval({ oopRehab: 0, oopRehabMax: false }, CD) === false, 'a zero/off OOP-rehab is not an override');
const EXP_KEYS = ['expFlips', 'expHolds', 'expGround'];
assert(EXP_KEYS.every((k) => !APPROVAL_OVERRIDE_KEYS.includes(k)),
  'experience is a deal INPUT, never an approval-triggering override');
assert(['arv', 'asIsValue', 'purchasePrice', 'rehabBudget', 'term', 'irMonths', 'irAmount', 'fico']
  .every((k) => !APPROVAL_OVERRIDE_KEYS.includes(k)),
  'the deal economics are inputs, never approval-triggering overrides');
assert(Object.keys(DEFAULTED_OVERRIDE_KEYS).every((k) => !(k in ENGAGED_OVERRIDE_KEYS)),
  'a knob is either defaulted-compare or engaged-only, never both');

// ---- roles ----
assert(isAdminRole('admin') && isAdminRole('super_admin'), 'admin/super_admin are admin roles');
assert(!isAdminRole('loan_officer') && !isAdminRole('processor') && !isAdminRole('underwriter'),
  'loan_officer / processor / underwriter are NOT admin roles');

// ---- engaged() ----
assert(engaged(true) && engaged(90) && engaged('10.25'), 'engaged: truthy flag / real number / non-empty string');
assert(!engaged(false) && !engaged(null) && !engaged('') && !engaged(undefined) && !engaged(NaN),
  'engaged: default/blank/absent values are NOT engaged');

// ---- NOTHING is stripped for ANY staff role (the loan officer gets the zone) ----
{
  const raw = { expFlips: 3, arv: 550000, rehabBudget: 90000, ovrLTCPct: 90, ovrRatePct: 10.25, manualPricing: true };
  for (const role of ['loan_officer', 'processor', 'underwriter', 'admin', 'super_admin']) {
    const { overrides, strippedAdminKeys } = sanitizeStaffOverrides(role, raw);
    assert(overrides.ovrLTCPct === 90 && overrides.ovrRatePct === 10.25 && overrides.manualPricing === true,
      `${role}: manual leverage / rate / manual-scenario overrides are KEPT (never stripped)`);
    assert(overrides.expFlips === 3 && overrides.arv === 550000 && overrides.rehabBudget === 90000,
      `${role}: deal inputs are KEPT`);
    assert(strippedAdminKeys === false, `${role}: never loud-refuses (nothing diverges anymore)`);
  }
}

// ---- the input object is not mutated (shallow copy) ----
{
  const raw = { expFlips: 1, ovrLTCPct: 90 };
  const { overrides } = sanitizeStaffOverrides('loan_officer', raw);
  overrides.ovrLTCPct = 1;
  assert(raw.ovrLTCPct === 90, 'the caller-supplied overrides object is not mutated');
}

// ---- degenerate inputs ----
{
  const a = sanitizeStaffOverrides('loan_officer', null);
  const b = sanitizeStaffOverrides(undefined, undefined);
  assert(a.overrides && Object.keys(a.overrides).length === 0 && a.strippedAdminKeys === false, 'null raw → empty overrides');
  assert(b.overrides && b.strippedAdminKeys === false, 'undefined role + raw → safe empty result');
}

// =====================================================================
// WHICH registrations need an admin's approval
// =====================================================================

// ---- a plain register (what the studio sends on an untouched admin zone) ----
{
  const raw = { expFlips: 2, arv: 500000, rehabBudget: 80000, term: 12, irMonths: 6, manualPricing: false };
  assert(pricingOverridesEngaged(raw, CD).length === 0,
    'a registration that touches nothing in the admin zone needs NO approval');
  assert(needsPricingApproval(raw, CD) === false, 'needsPricingApproval: false on a clean register');
}

// ---- typing the company default back is not a change ----
{
  const raw = { markupStdPct: 0.5, origStdPct: 1.25, lenderFee: 2195, creditFee: '150', appraisalFee: 800 };
  assert(pricingOverridesEngaged(raw, CD).length === 0,
    'the company defaults typed back (numbers OR strings) are NOT a change');
}

// ---- a blank field means "use the default" ----
{
  const raw = { markupStdPct: '', markupGoldPct: '', titleFee: '', lenderFee: null };
  assert(pricingOverridesEngaged(raw, CD).length === 0,
    'explicitly blanked fields are NOT an override (they restore the company default)');
}

// ---- reducing the RATE markup ----
{
  const list = pricingOverridesEngaged({ markupStdPct: 0 }, CD);
  assert(list.length === 1 && list[0].key === 'markupStdPct' && list[0].value === 0 && list[0].defaultValue === 0.5,
    'waiving the rate markup (0 vs the 0.5 default) needs approval, with the before/after recorded');
  assert(describeOverrides(list)[0] === 'Rate markup / YSP — Standard: 0.5% → 0%',
    'the change reads in plain language, never a raw key name');
}

// ---- reducing the FEE ----
{
  const list = pricingOverridesEngaged({ origStdPct: 0.5, lenderFee: 1000 }, CD);
  assert(keysOf(list).join(',') === 'lenderFee,origStdPct',
    'reduced origination points AND a discounted underwriting fee both need approval');
  assert(describeOverrides(list).includes('Underwriting / processing / legal fee: $2,195 → $1,000'),
    'a money change reads as dollars');
}

// ---- RAISING a fee / markup / origination is NOT a change (owner-directed
//      2026-08-12: charging MORE than the default earns the company more; only a
//      DISCOUNT below the default needs an exception) ----
{
  assert(pricingOverridesEngaged({ origStdPct: 2 }, CD).length === 0,
    'raising origination ABOVE the 1.25 default needs NO approval — charging more earns more');
  assert(pricingOverridesEngaged({ markupStdPct: 1.0 }, CD).length === 0,
    'raising the rate markup above the 0.5 default needs no approval');
  assert(pricingOverridesEngaged({ lenderFee: 3000, creditFee: 250, appraisalFee: 1200 }, CD).length === 0,
    'raising the underwriting / credit / appraisal fees above their defaults needs no approval');
  // ...but DISCOUNTING below the default still needs approval.
  assert(pricingOverridesEngaged({ origStdPct: 1.0 }, CD).length === 1,
    'DISCOUNTING origination below the 1.25 default still needs approval');
  assert(pricingOverridesEngaged({ lenderFee: 1000 }, CD)[0].key === 'lenderFee',
    'a discounted underwriting fee still needs approval');
}

// ---- title fee: the default is "auto-estimate", so any typed number is a change ----
{
  assert(pricingOverridesEngaged({ titleFee: 3000 }, CD).length === 1,
    'a typed title fee overrides the auto-estimate default → approval');
}

// ---- a manual program / manual basis ----
{
  const list = pricingOverridesEngaged({ manualPricing: true, ovrLTCPct: 92, ovrRatePct: 10.25, ovrIrMonths: 3 }, CD);
  assert(keysOf(list).join(',') === 'manualPricing,ovrIrMonths,ovrLTCPct,ovrRatePct',
    'a manual scenario (LTC / rate / reserve basis) needs approval');
  assert(describeOverrides(list).includes('Manual loan-to-cost: 92%'), 'a manual knob reads as its own value');
}

// ---- the engine FRACTION form (a re-register replays stored engine inputs) ----
{
  const list = pricingOverridesEngaged({ ovrLTC: 0.92, ovrRate: 0.1025 }, CD);
  assert(keysOf(list).join(',') === 'ovrLTC,ovrRate', 'the fraction form of a manual knob is detected too');
  assert(describeOverrides(list).includes('Manual note rate: 10.25%'), 'a fraction renders as a percent');
}

// ---- the assignment effective-price exception + force-price ----
{
  assert(pricingOverridesEngaged({ ovrEffPrice: 115000 }, CD).length === 1,
    'an approved effective purchase price needs approval');
  assert(pricingOverridesEngaged({ forcePrice: true }, CD).length === 1,
    'force-pricing past the guideline limits needs approval');
}

// ---- the flags every register sends at their defaults ----
{
  assert(pricingOverridesEngaged({ manualPricing: false, forcePrice: false }, CD).length === 0,
    'manualPricing:false / forcePrice:false (sent on EVERY register) are not overrides');
  assert(pricingOverridesEngaged({ ovrAcqLTVPct: 0, ovrLTC: null, ovrEffPrice: '' }, CD).length === 0,
    'zero / null / blank manual knobs are not overrides');
}

// ---- no company defaults available (cold cache / unreadable) → fail SAFE ----
{
  assert(pricingOverridesEngaged({ markupStdPct: 0.5 }, null).length === 1,
    'with no defaults to compare, a real value counts as a change (ask, never skip)');
  assert(pricingOverridesEngaged({}, null).length === 0, 'no defaults + nothing sent → still no approval');
}

// ---- degenerate ----
{
  assert(pricingOverridesEngaged(null, CD).length === 0 && pricingOverridesEngaged(undefined, undefined).length === 0,
    'null / undefined override sets are safe');
  assert(describeOverrides(null).length === 0 && describeOverrides('nope').length === 0,
    'describeOverrides tolerates junk');
  assert(pricingOverridesEngaged({ lenderFee: 'abc' }, CD).length === 0,
    'an unreadable value is not reported as a named change');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);

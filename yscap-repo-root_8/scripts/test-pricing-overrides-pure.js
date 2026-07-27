/**
 * Staff pricing-override policy (owner-directed 2026-07-27 — "give authority to
 * everybody as long as the file is not clear to close").
 *
 * EVERY staff role (loan officer, processor, underwriter, admin, super_admin)
 * may tune the deal INPUTS — experience, ARV, as-is, price, rehab, term, reserve
 * — and re-register. Only the MANUAL leverage / rate / force-price overrides stay
 * admin-only (they create a Manual Program that bypasses the guideline engine and
 * needs super-admin approval); a non-admin sending one MEANINGFULLY engaged is
 * refused loudly rather than registered at different terms than the studio showed.
 *
 * A BORROWER is handled in borrower.js (economics stripped; they request changes)
 * — this pure module governs STAFF only. No DB / server needed.
 */
'use strict';

const {
  ADMIN_ONLY_OVERRIDE_KEYS, MANUAL_PRICING_KEYS, sanitizeStaffOverrides, isAdminRole, engaged,
} = require('../src/lib/pricing-overrides');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---- the key lists reflect the new policy ----
const EXP_KEYS = ['expFlips', 'expHolds', 'expGround'];
assert(EXP_KEYS.every((k) => !ADMIN_ONLY_OVERRIDE_KEYS.includes(k)),
  'experience keys are NOT admin-only (any staff may change experience)');
const MANUAL_KEYS = ['forcePrice', 'manualPricing', 'ovrAcqLTV', 'ovrARLTV', 'ovrLTC', 'ovrRate',
  'ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct', 'ovrRatePct', 'ovrIrMonths', 'ovrEffPrice'];
assert(MANUAL_KEYS.every((k) => ADMIN_ONLY_OVERRIDE_KEYS.includes(k)),
  'manual leverage / rate / force-price / effective-price overrides stay admin-only');
assert(MANUAL_PRICING_KEYS.length === ADMIN_ONLY_OVERRIDE_KEYS.length
  && MANUAL_PRICING_KEYS.every((k) => ADMIN_ONLY_OVERRIDE_KEYS.includes(k)),
  'every admin-only key is a manual-pricing knob (loud-refuse set matches)');
assert(EXP_KEYS.every((k) => !MANUAL_PRICING_KEYS.includes(k)),
  'experience keys never trip the loud manual-pricing refusal');

// ---- roles ----
assert(isAdminRole('admin') && isAdminRole('super_admin'), 'admin/super_admin are admin roles');
assert(!isAdminRole('loan_officer') && !isAdminRole('processor') && !isAdminRole('underwriter'),
  'loan_officer / processor / underwriter are NOT admin roles');

// ---- engaged() ----
assert(engaged(true) && engaged(90) && engaged('10.25'), 'engaged: truthy flag / real number / non-empty string');
assert(!engaged(false) && !engaged(null) && !engaged('') && !engaged(undefined) && !engaged(NaN),
  'engaged: default/blank/absent values are NOT engaged');

// ---- a loan officer sets experience + ARV + a real manual leverage knob ----
{
  const { overrides, strippedAdminKeys } = sanitizeStaffOverrides('loan_officer',
    { expFlips: 3, expHolds: 1, expGround: 0, arv: 550000, asIsValue: 400000, rehabBudget: 90000, ovrLTCPct: 90, manualPricing: false });
  assert(overrides.expFlips === 3 && overrides.expHolds === 1 && overrides.expGround === 0,
    'LO: experience overrides are KEPT');
  assert(overrides.arv === 550000 && overrides.asIsValue === 400000 && overrides.rehabBudget === 90000,
    'LO: deal inputs (ARV / as-is / rehab) are KEPT');
  assert(!('ovrLTCPct' in overrides), 'LO: manual leverage override is STRIPPED');
  assert(strippedAdminKeys === true, 'LO: an ENGAGED manual leverage knob triggers the loud refusal');
}

// ---- a processor with only the default manualPricing:false (every register sends it) ----
{
  const { overrides, strippedAdminKeys } = sanitizeStaffOverrides('processor', { expFlips: 2, manualPricing: false });
  assert(overrides.expFlips === 2, 'processor: experience KEPT');
  assert(strippedAdminKeys === false, 'processor: a default manualPricing:false does NOT loud-refuse');
}

// ---- an underwriter is still non-admin for the manual knobs (unchanged) ----
{
  const { overrides, strippedAdminKeys } = sanitizeStaffOverrides('underwriter', { expFlips: 5, ovrRatePct: 11 });
  assert(overrides.expFlips === 5, 'underwriter: experience KEPT');
  assert(!('ovrRatePct' in overrides) && strippedAdminKeys === true,
    'underwriter: manual rate override still admin-only (loud refuse) — unchanged');
}

// ---- an admin keeps everything, never loud-refuses ----
{
  const { overrides, strippedAdminKeys } = sanitizeStaffOverrides('admin',
    { ovrRatePct: 10.25, ovrLTCPct: 92, forcePrice: true, expFlips: 9 });
  assert(overrides.ovrRatePct === 10.25 && overrides.ovrLTCPct === 92 && overrides.forcePrice === true && overrides.expFlips === 9,
    'admin: every override KEPT');
  assert(strippedAdminKeys === false, 'admin: never loud-refuses');
}

// ---- the input object is not mutated (shallow copy) ----
{
  const raw = { expFlips: 1, ovrLTCPct: 90 };
  sanitizeStaffOverrides('loan_officer', raw);
  assert('ovrLTCPct' in raw, 'the caller-supplied overrides object is not mutated');
}

// ---- degenerate inputs ----
{
  const a = sanitizeStaffOverrides('loan_officer', null);
  const b = sanitizeStaffOverrides(undefined, undefined);
  assert(a.overrides && Object.keys(a.overrides).length === 0 && a.strippedAdminKeys === false, 'null raw → empty overrides');
  assert(b.overrides && b.strippedAdminKeys === false, 'undefined role + raw → safe empty result');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);

'use strict';

/* =====================================================================
   pricing-overrides.js — WHO may inject which pricing-studio overrides.

   ONE definition of the staff pricing-override policy so the register,
   quote, PATCH /details, and completeness paths can never drift apart.

   Owner-directed 2026-07-27 — "give authority to everybody as long as
   the file is not clear to close":
     · EVERY staff member (loan officer, processor, underwriter, admin,
       super_admin) has the SAME authority over the deal INPUTS — the
       experience counts, the ARV, the as-is value, the purchase price,
       the rehab budget, the term, the reserve. A loan officer may
       re-price and re-register with a higher ARV or a changed experience
       right up until the file is Clear to Close.
     · The change reopens the pricing / experience conditions (the
       db/072 trigger), so the underwriter re-signs the new structure —
       exactly the owner's "the conditions should reopen for the
       underwriter to sign off the condition again".
     · The Clear-to-Close / Funded / term-sheet-sent FREEZE still blocks
       EVERYONE equally (file-lock.js) — that is a separate, role-neutral
       guardrail and is unchanged.

   What used to be restricted and is now open to all staff: raising the
   ARV / as-is value on a priced file (was underwriter/admin only), and
   changing the experience in the studio (was admin only — the
   expFlips/expHolds/expGround keys were stripped for everyone else).

   What stays ADMIN-ONLY on purpose: the MANUAL leverage / rate /
   force-price overrides. Those don't just tune a deal input — they
   create a Manual Program that BYPASSES the frozen guideline engine and
   needs super-admin approval (its own owner-directed exception
   workflow). A non-admin who needs more leverage / a different rate than
   the guidelines allow uses the "Request an exception" action, which
   routes a tracked request to a super-admin — the sanctioned path.

   A BORROWER never injects economics from here at all — that is handled
   in borrower.js (economics stripped; they REQUEST a change and the team
   approves it via change-requests.js). This module governs STAFF only.
   ===================================================================== */

// The manual-PRICING knobs: force-price, and every explicit rate / leverage /
// admin-effective-price override (in both the fraction and the percent form the
// studio sends). Admin / super_admin only.
const ADMIN_ONLY_OVERRIDE_KEYS = [
  'forcePrice', 'manualPricing',
  'ovrAcqLTV', 'ovrARLTV', 'ovrLTC', 'ovrRate',
  'ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct', 'ovrRatePct', 'ovrIrMonths', 'ovrEffPrice',
];

// Every admin-only key above IS a manual-pricing knob, so a non-admin sending
// any of them MEANINGFULLY engaged means the studio displayed terms the server
// will not honor for that role — refuse loudly rather than silently register
// different numbers (root-caused 2026-07-16, Pinchus Wieder). Kept as its own
// named list so the two concepts can diverge if a future admin-only key is ever
// NOT a manual-pricing knob. NOTE: the experience keys are deliberately in
// NEITHER list now — any staff may set them (owner-directed 2026-07-27).
const MANUAL_PRICING_KEYS = ADMIN_ONLY_OVERRIDE_KEYS.slice();

// "Meaningfully engaged": a truthy flag, or a numeric override carrying a real
// value — NOT a present-but-default key (manualPricing:false is sent on every
// staff register, so mere presence must never count as an admin-only override).
function engaged(v) {
  return v === true || (v != null && v !== '' && v !== false && !(typeof v === 'number' && Number.isNaN(v)));
}

function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

// Strip the admin-only overrides for a non-admin staff role. Returns
// { overrides, strippedAdminKeys }:
//   overrides         — a shallow copy with the admin-only keys removed for a
//                       non-admin (untouched for an admin/super_admin).
//   strippedAdminKeys — true when a MEANINGFULLY-engaged manual-pricing knob was
//                       dropped, so the caller can refuse loudly instead of
//                       registering terms that differ from what the studio showed.
function sanitizeStaffOverrides(role, raw) {
  const overrides = (raw && typeof raw === 'object') ? { ...raw } : {};
  if (isAdminRole(role)) return { overrides, strippedAdminKeys: false };
  let stripped = false;
  for (const k of ADMIN_ONLY_OVERRIDE_KEYS) {
    if (k in overrides) {
      if (MANUAL_PRICING_KEYS.includes(k) && engaged(overrides[k])) stripped = true;
      delete overrides[k];
    }
  }
  return { overrides, strippedAdminKeys: stripped };
}

module.exports = {
  ADMIN_ONLY_OVERRIDE_KEYS, MANUAL_PRICING_KEYS,
  sanitizeStaffOverrides, isAdminRole, engaged,
};

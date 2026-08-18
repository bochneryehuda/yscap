'use strict';
/**
 * LT — THE ONE PLACE THE FOREIGN-NATIONAL FACT AND THE VENDOR'S CITIZENSHIP TOKEN MEET (§2.97).
 *
 * ⛔ THE DEFECT THIS EXISTS FOR, MEASURED LIVE 2026-08-18 against the real vendor. `foreign_national`
 * is an accepted field of the DSCR pricer — it is in the manifest, the Advanced section publishes it,
 * our matrix cuts on it — and it built a BYTE-IDENTICAL request to a scenario that never mentioned it.
 * The base body carries `Citizenship: 'US Citizen'`, so the mirror was not merely silent about a
 * foreign national: it AFFIRMATIVELY told Lender Price the borrower was a US citizen.
 *
 * What the truth is worth, same scenario (NY purchase, 500k/350k, FICO 760, DSCR 1.25, 60-mo PPP),
 * `citizenship: 'US Citizen'` vs `citizenship: 'Foreign National'`:
 *
 *   ELIGIBILITY — the answer is a different answer, not a shaded one.
 *     19 programs / 499 rungs  ->  12 programs / 267 rungs
 *     13 programs LOST: 6 Bluepoint DSCR tiers, Pennymac Non-QM, Acra Platinum Select,
 *        AD Mortgage DSCR, ARC Edge DSCR, ARC Access DSCR, AHL Invest Star, Champions Accelerator.
 *        Every one of those was on a quote we would have handed a foreign national.
 *     6 programs GAINED, and they are the products actually built for this borrower:
 *        AD Mortgage `Foreign National 30 Year Fixed`, ARC `30yr Fixed - Foreign National DSCR`,
 *        and four Champions `Ambassador` programs. We were hiding them.
 *     The two cheapest coupons on the whole ladder — 5.750 and 5.875 — do not exist for a foreign
 *     national. We were advertising a rate they cannot have.
 *
 *   PRICE — on the SIX programs that survive both, 78 of 182 rungs are priced differently, and the
 *     worst of them is our own sheet's investor. Deephaven `DSCR 1.00-1.24 - 30 Yr Fixed` @ 6.125%:
 *         US Citizen        price 100.475   `DSCR (All) - 760 - 779 / CLTV >65.01 % <= 70.0 %` = 0.125
 *         Foreign National  price  96.350   `DSCR (All) - Foreign National / CLTV >65.01 % <= 70.0 %` = 4.000
 *     A 4.125-point quote error, in the borrower's favour and against us, on every foreign-national
 *     scenario. Lender Price ITEMIZES the adjustment by name — this is not inference.
 *
 * ⛔ WHY THIS FILE, AND NOT A LINE IN EACH PLACE. The fact travels in BOTH directions and the two
 * halves must agree, or we have simply moved the defect (§2.94, which is exactly how a one-sided
 * prepay-term fix left our leg pricing zero of seven structure scenarios):
 *   • FORWARD  — a scenario carrying `foreign_national: true` must reach the wire as the vendor token.
 *   • REVERSE  — a scenario carrying `citizenship: 'Foreign National'` must make our OWN engine's
 *     `foreign_national` fact true, or our matrix quietly skips its Foreign National row (max loan
 *     $1.5M, LTV caps 70/60, DSCR >= 1.00) on the very scenarios that named the borrower plainly.
 * Both read the token set below, once.
 *
 * WHICH TOKENS COUNT. The vendor's citizenship vocabulary has seven values and only three of them
 * name this borrower class. `'ITIN'` is deliberately NOT one: an ITIN is a tax-filing status, and the
 * vendor lists it SEPARATELY from its two `ForeignNational…ITIN)` values — reading it as foreign
 * national would apply a 4-point LLPA to a borrower the vendor does not put in that bucket, which is
 * the same silent-mispricing class in the opposite direction. `'Non-Perm Resident'` is likewise a
 * resident, not a foreign national.
 *
 * WHY AN EXPLICIT `false` IS INERT. `foreign_national: false` is the Advanced section's DEFAULT value,
 * so a UI that posts every checkbox sends it on every request. Treating it as a contradiction of an
 * explicit `citizenship: 'Foreign National'` would 422 ordinary traffic. Only an explicit `true`
 * asserts anything, matching how `firstTimeInvestor` and `dscrAssetDepletion` already treat their off
 * state (field-registry: "an explicit false DOES NOT write a guessed token").
 *
 * PURE: no I/O, no DB, no network. LT-only.
 */

// The vendor token the flag asserts. This exact string is what was measured live above; the other two
// FN tokens are ACCEPTED as agreeing with the flag but are never SYNTHESIZED from it, because
// "with ITIN" / "no ITIN" is information the flag does not carry and must not invent.
const FOREIGN_NATIONAL_TOKEN = 'Foreign National';

// Every citizenship token that means "this borrower is a foreign national". Frozen so a caller cannot
// widen the class by mutating it.
const FOREIGN_NATIONAL_TOKENS = Object.freeze([
  'Foreign National', 'ForeignNationalwithITIN)', 'ForeignNationalnoITIN)',
]);

// True when a citizenship token names the foreign-national borrower class. Total: never throws, and a
// null / unknown / non-string value is simply not a foreign national.
function isForeignNationalToken(v) {
  return typeof v === 'string' && FOREIGN_NATIONAL_TOKENS.includes(v);
}

/**
 * Resolve the ONE citizenship a scenario describes, from either or both of its two expressions.
 * Returns `{ token, conflict }`:
 *   • `token`    — the vendor citizenship token to send, or null to leave the live default alone.
 *   • `conflict` — `{ flag, citizenship }` when the scenario asserts BOTH `foreign_national: true`
 *                  AND a citizenship that is not a foreign-national token. Two different borrowers;
 *                  the caller decides which, we do not.
 * An explicit citizenship always WINS over the flag when the two agree (it is the more specific
 * statement — it can say "with ITIN" where the flag cannot).
 */
function resolveCitizenship(sc) {
  const s = sc || {};
  const stated = (s.citizenship != null && s.citizenship !== '') ? s.citizenship : null;
  const flagged = s.foreign_national === true;
  if (!flagged) return { token: stated, conflict: null };
  if (stated == null) return { token: FOREIGN_NATIONAL_TOKEN, conflict: null };
  if (isForeignNationalToken(stated)) return { token: stated, conflict: null };
  return { token: stated, conflict: { flag: true, citizenship: stated } };
}

/**
 * The REVERSE direction: does this scenario describe a foreign national, however it said so? Read by
 * the fact converter so our own engine's matrix row fires on a scenario that used the vendor's
 * dropdown instead of our checkbox.
 */
function isForeignNationalScenario(sc) {
  const s = sc || {};
  return s.foreign_national === true || isForeignNationalToken(s.citizenship);
}

module.exports = {
  FOREIGN_NATIONAL_TOKEN, FOREIGN_NATIONAL_TOKENS,
  isForeignNationalToken, resolveCitizenship, isForeignNationalScenario,
};

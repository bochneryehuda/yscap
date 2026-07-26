'use strict';
/**
 * R6.11 / WO-A — Encompass field registry (READ-ONLY reconciliation map).
 *
 * The per-file Encompass sync must reconcile a PILOT file against its Encompass
 * loan copy WITHOUT letting the AI invent Encompass field IDs. This is the
 * APPROVED, explicit, live-verified registry: every material identity + loan
 * structure field → its canonical Encompass field ID / custom-field name, all
 * pull-only (`←ENC`). It is a DATA map + pure helpers (extract, flatten, value
 * maps, compare) — NO network calls, NO DB, NO write-to-Encompass helpers.
 *
 * HARD RULE (owner-directed, frozen): Encompass is one-way, READ-ONLY, forever.
 * Nothing in this file writes to Encompass. Every entry is built through `pull()`
 * so `direction:'pull'`, `authoritative:'pilot'`, `blocksCtc:false`,
 * `blocksFunding:false` are STRUCTURAL, not per-entry opinions. A mismatch is a
 * review finding, never a value PILOT auto-adopts and never a CTC/funding
 * blocker on its own. The only writes anywhere in the sync are (a) a
 * user-initiated pull of an Encompass value INTO our own column (WO-C) and
 * (b) borrower-profile enrichment (WO-F/G) — never a write back to Encompass.
 *
 * Verification note: field IDs and custom-field names here were confirmed by
 * read-only GET/pipeline pulls against the tenant instance (see
 * docs/ENCOMPASS-FIXFLIP-MASTER-MAPPING.md and docs/ENCOMPASS-SYNC-BUILD-SPEC.md).
 * `verified:false` entries still need live confirmation and callers may filter
 * on `verified`.
 *
 * PII governance: this registry deliberately EXCLUDES credit score
 * (`CX.MIDDLESCORE`) and capital-partner fields (`CX.CAPITALPROVIDER`, …). SSN
 * and DOB identity matching lives in IDENTITY_MAP and is handled via the
 * sanitize/hash chokepoints in the reconcile service — never pulled into the
 * generic economics extract.
 *
 * Pure: no DB, no AI, no network.
 */

// ── Small enumerations describing HOW a field is compared and gated ──────────
// GATE governs the term-sheet gate (WO-E) only — it never affects CTC/funding.
//   'block'     — an unresolved mismatch blocks term-sheet issuance.
//   'advisory'  — surfaced as a finding, but never blocks issuance (owner:
//                 accrual / actual-vs-cap percents / experience are advisory).
//   'reference' — surfaced read-only for staff context; NEVER compared, never a
//                 finding (owner: "reference this with no check with no matching").
const GATE = Object.freeze({ BLOCK: 'block', ADVISORY: 'advisory', REFERENCE: 'reference' });

// The read-only invariants FORCED onto EVERY registry entry. `direction:'pull'`,
// `authoritative:'pilot'`, `blocksCtc:false`, `blocksFunding:false` are spread
// LAST — AFTER the caller's `entry` — so no entry can override them: it is
// structurally impossible for a registry row to declare a write or a hard block
// (the guarantee behind the read-only doctrine + the `REGISTRY.every` test).
// `gate` and `verified` are overridable per-entry defaults (an entry may set an
// advisory/reference gate, e.g.).
function pull(entry) {
  return Object.freeze(Object.assign(
    { gate: GATE.BLOCK, verified: true },
    entry,
    { direction: 'pull', authoritative: 'pilot', blocksCtc: false, blocksFunding: false },
  ));
}

// Each entry: portal key ↔ Encompass canonical field id (+ optional full-loan
// `loanPath` for standard fields, `altFieldId` for a tenant cross-check field).
//   type    — coercion: money | rate | percent | int | date | enum | text
//   compare — comparison kind: money | percent | int | date | enum | text | reference
//   valueMap— name of the VALUE_MAPS table for enum comparisons
//   our     — human hint of where the PILOT value comes from (column:… / quote:… /
//             derive / none). Documentation for WO-B; this module never reads it.
const REGISTRY = Object.freeze([
  // ── Identity / program / vesting ──────────────────────────────────────────
  pull({ key: 'ys_loan_number', encompassFieldId: '364', loanPath: 'loanNumber', type: 'text', category: 'program', compare: 'text', gate: GATE.BLOCK, our: 'column:ys_loan_number', note: 'Loan number — the natural key; MATCHED (must equal Encompass Loan.LoanNumber, field 364)' }),
  pull({ key: 'property_type', encompassFieldId: '1041', loanPath: 'property.propertyType', altFieldId: 'CX.PROPERTYTYPE', type: 'enum', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'propertyType', our: 'column:property_type', note: 'Subject property type (std 1041; CX.PROPERTYTYPE is the tenant cross-check). Our range-category (SFR / Multi 2-4 / Multi 5+ / Condo / Townhouse / Mixed Use) vs Encompass wording is lossy — value-mapped' }),
  pull({ key: 'units', encompassFieldId: '16', loanPath: ['property.financedNumberOfUnits', 'property.numberOfUnits', 'property.financedUnits'], type: 'int', category: 'program', compare: 'int', verified: false, our: 'column:units', note: 'Number of units — EXACT match (owner-directed 2026-07-26). Encompass standard field 16 ("No. of Units"). loanPath candidates need live confirmation against the tenant loan JSON; if it reads blank the field shows "no data to compare" (staff must enter it in Encompass)' }),
  pull({ key: 'deal_type', encompassFieldId: 'CX.DEALPROJECTTYPE', type: 'enum', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'dealType', our: 'derive from applications.program + loan_type (no deal_type column)', note: 'Deal/project type — value-mapped (§6). Advisory: our side is derived heuristically from program/loan_type, so a disagreement surfaces but never hard-blocks' }),
  pull({ key: 'exit_plan', encompassFieldId: 'CX.EXITPLAN', type: 'enum', compare: 'reference', gate: GATE.REFERENCE, valueMap: 'exitPlan', our: 'none (no column; inferable from deal_type)', note: 'Exit plan — reference only (owner: advisory, no matching); value map kept for context' }),
  pull({ key: 'loan_to_be_vested', encompassFieldId: 'CX.LOANTOBEVESTED', type: 'enum', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'vesting', our: 'derive(applications.llc_id present → entity)', note: 'Entity vs individual vesting flag' }),
  pull({ key: 'vesting_llc', encompassFieldId: '1859', type: 'text', category: 'identity', compare: 'name', our: 'llcs.name via applications.llc_id', note: 'Subject LLC / vesting NAME — owner-confirmed standard field 1859 (matches our subject LLC vesting). Name-normalized compare (punctuation-insensitive); the authoritative match uses IDENTITY_MAP.nameEquals in WO-C' }),

  // ── Loan amount / initial advance / rehab (money) ─────────────────────────
  pull({ key: 'loan_amount', encompassFieldId: '1109', loanPath: 'baseLoanAmount', type: 'money', category: 'loan', compare: 'money', our: 'column:loan_amount', note: 'Total loan amount (Borrower Requested Loan Amount)' }),
  pull({ key: 'max_total_loan', encompassFieldId: 'CX.MAXTOTALLOAN', type: 'money', category: 'sizing', compare: 'money', our: 'column:loan_amount (Encompass second copy of the total)', note: 'Max/total loan — must equal our total loan amount' }),
  pull({ key: 'final_initial_loan', encompassFieldId: 'CX.FINALINITIALLOAN', type: 'money', category: 'sizing', compare: 'money', our: 'quote:initialAdvance = loan_amount − financed_rehab − financed_reserve', note: 'Final initial advance — compute-only on our side' }),
  pull({ key: 'rehab_budget', encompassFieldId: 'CX.REHABBUDGET', type: 'money', category: 'rehab', compare: 'money', our: 'column:rehab_budget (+ SOW total)', note: 'Rehab / construction budget' }),
  pull({ key: 'financed_rehab_budget', encompassFieldId: 'CX.FINANCEDREHABBUDGET', type: 'money', category: 'rehab', compare: 'money', our: 'derive(financed rehab = rehab_budget today; modelled distinct for future out-of-pocket rehab)', note: 'Financed portion of rehab' }),

  // ── Purchase / assignment / cost (money) ──────────────────────────────────
  pull({ key: 'purchase_price', encompassFieldId: '136', loanPath: 'purchasePriceAmount', type: 'money', category: 'loan', compare: 'money', our: 'column:purchase_price', note: 'Real final purchase price (build-spec §5). NOTE: the discovery doc read 136/purchasePriceAmount as the EFFECTIVE price on assignment deals — confirm which the tenant populates before relying on this on an assignment file' }),
  pull({ key: 'effective_purchase', encompassFieldId: 'CX.EFFECTIVEPURCHASE', type: 'money', category: 'cost', compare: 'money', our: 'quote:assignment.recognizedPrice (seller price + financeable fee)', note: 'Effective purchase (LTC basis) — compute-only' }),
  pull({ key: 'contract_price', encompassFieldId: 'CX.ORIGINALCONTRACTPURCHASEP', type: 'money', category: 'cost', compare: 'money', our: 'column:underlying_contract_price (falls back to purchase_price when no assignment)', note: 'Seller / underlying contract price (assignment basis)' }),
  pull({ key: 'assignment_fee', encompassFieldId: 'CX.ASSIGNMENTFEE', type: 'money', category: 'cost', compare: 'money', our: 'column:assignment_fee', note: 'Assignment fee (financeable per frozen engine: lesser of 15% of contract / $75k)' }),
  pull({ key: 'financed_interest_reserve', encompassFieldId: 'CX.FINANCEDINTERESTRESERVE', type: 'money', category: 'cost', compare: 'money', our: 'quote:financedReserve$ (from requested_ir_months / requested_ir_amount)', note: 'Financed interest reserve $ — compute-only; can be 0' }),
  pull({ key: 'total_cost', encompassFieldId: 'CX.TOTALCOST', type: 'money', category: 'cost', compare: 'money', our: 'derive(effective purchase + rehab + financed reserve + program extras)', note: 'Total cost (LTC basis) — no column, derive' }),

  // ── Valuation (money + percent) ───────────────────────────────────────────
  pull({ key: 'as_is_value', encompassFieldId: 'CX.ASISVALUE', type: 'money', category: 'valuation', compare: 'money', our: 'column:as_is_value', note: 'As-is value (NOT std 356 — 356 is ARV$ on this tenant)' }),
  pull({ key: 'arv', encompassFieldId: '356', loanPath: 'propertyAppraisedValueAmount', type: 'money', category: 'valuation', compare: 'money', our: 'column:arv', note: 'ARV in dollars (propertyAppraisedValueAmount)' }),
  pull({ key: 'actual_arv_ltv', encompassFieldId: 'CX.ACTAULARV', type: 'percent', category: 'valuation', compare: 'percent', gate: GATE.ADVISORY, our: 'quote:actual ARV-LTV', note: 'Actual ARV-LTV % (final loan ÷ ARV) — compute-only' }),

  // ── Sizing / leverage (percent) ───────────────────────────────────────────
  pull({ key: 'actual_ltc', encompassFieldId: 'CX.ACTAULLTC', type: 'percent', category: 'sizing', compare: 'percent', gate: GATE.ADVISORY, our: 'quote:actual LTC', note: 'Actual LTC % — compute-only' }),
  pull({ key: 'actual_initial_ltv', encompassFieldId: 'CX.ACTUALINITIALLTV', type: 'percent', category: 'sizing', compare: 'percent', gate: GATE.ADVISORY, our: 'column:ltv (stores actual acq/initial LTV)', note: 'Actual initial LTV % — advisory, like the other actual/cap percents' }),
  pull({ key: 'max_initial_ltv', encompassFieldId: 'CX.MAXINITIALLTV', type: 'percent', category: 'sizing', compare: 'percent', gate: GATE.ADVISORY, our: 'quote:guidelines.caps.initialLtv', note: 'Program MAX initial LTV — compute-only' }),
  pull({ key: 'max_arv_ltv', encompassFieldId: 'CX.MAXARV', type: 'percent', category: 'valuation', compare: 'percent', gate: GATE.ADVISORY, our: 'quote:guidelines.caps.arvLtv', note: 'Program MAX ARV-LTV — compute-only' }),
  pull({ key: 'max_ltc', encompassFieldId: 'CX.MAXLTC', type: 'percent', category: 'sizing', compare: 'percent', gate: GATE.ADVISORY, our: 'quote:guidelines.caps.ltc', note: 'Program MAX LTC — compute-only' }),

  // ── Rate / origination / term / maturity ──────────────────────────────────
  pull({ key: 'note_rate', encompassFieldId: '3', loanPath: 'requestedInterestRatePercent', type: 'rate', category: 'interest', compare: 'percent', our: 'column:rate_pct', note: 'Interest rate — PERCENT on both sides. WO-B MUST source applications.rate_pct (a percent, e.g. 10.99), NOT the fractional whole-loan-context note_rate (0.1099), or every loan false-mismatches' }),
  pull({ key: 'origination_pct', encompassFieldId: '388', type: 'percent', category: 'cost', compare: 'percent', our: 'quote:origination % (e.g. 1.25)', note: 'Origination fee % (field 388: 1.0 = 1%)' }),
  pull({ key: 'term_months', encompassFieldId: '4', loanPath: 'loanAmortizationTermMonths', type: 'int', category: 'loan', compare: 'int', our: 'column:term (text → int)', note: 'Term in months' }),
  pull({ key: 'maturity_date', encompassFieldId: '78', loanPath: 'maturityDate', type: 'date', category: 'loan', compare: 'date', our: 'column:maturity_date', note: 'Maturity date — read from full loan (maturityDate), not pipeline' }),

  // ── Experience / rehab-type / accrual (enum + int, advisory) ──────────────
  pull({ key: 'total_experience_deals', encompassFieldId: 'CX.TOTALEXPERIENCEDEALS', type: 'int', category: 'experience', compare: 'int', gate: GATE.ADVISORY, our: 'derive(requested_exp_flips/holds/ground + verified track record)', note: 'Verified experience count used to qualify' }),
  pull({ key: 'rehab_type', encompassFieldId: 'CX.REHABTYPE', type: 'enum', category: 'rehab', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'rehabType', our: 'column:rehab_type', note: 'Rehab type — value-mapped (§6): Light/Cosmetic → light, Heavy → heavy, Expansion → adding SF. Advisory: our 5 buckets (incl. Moderate) have no Encompass counterpart, so a bucket difference surfaces but never blocks' }),
  pull({ key: 'accrual_type', encompassFieldId: 'CX.ACCRUALTYPE', type: 'enum', category: 'interest', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'accrual', our: 'column:accrual_type', note: 'Accrual basis — advisory; Drawn/Non-Dutch → non_dutch, Note/Dutch → dutch' }),

  // ── Reference-only (owner: "reference this with no check with no matching") ─
  // PITIA removed (owner-directed 2026-07-26): the CX.PITIA field was the wrong
  // Encompass field for our purposes — do NOT reference it in the comparison.
  pull({ key: 'ref_cash_to_close', encompassFieldId: 'CX.RTLCASHTOCLOSEESTIMAT', type: 'money', category: 'cost', compare: 'reference', gate: GATE.REFERENCE, our: 'none', note: 'Estimated cash to close — reference only' }),
  pull({ key: 'ref_down_payment', encompassFieldId: 'CX.RTLDOWNPAYMENT', type: 'money', category: 'cost', compare: 'reference', gate: GATE.REFERENCE, our: 'none', note: 'Down payment — reference only' }),
  pull({ key: 'ref_table_funder', encompassFieldId: 'CX.TABLEFUNDER', type: 'text', category: 'program', compare: 'reference', gate: GATE.REFERENCE, our: 'none', note: 'Table funder flag — reference only (staff-internal)' }),
  pull({ key: 'ref_cross_collateralized', encompassFieldId: 'CX.CROSSCOLLATERALIZEDFLAG', type: 'text', category: 'program', compare: 'reference', gate: GATE.REFERENCE, our: 'none', note: 'Cross-collateralized flag — reference only' }),
  pull({ key: 'ref_multi_property', encompassFieldId: 'CX.MULTIPROPERTYFLAG', type: 'text', category: 'program', compare: 'reference', gate: GATE.REFERENCE, our: 'none', note: 'Multi-property flag — reference only' }),
]);

const BY_KEY = REGISTRY.reduce((m, e) => { m[e.key] = e; return m; }, {});
const BY_FIELD_ID = REGISTRY.reduce((m, e) => { m[e.encompassFieldId] = e; return m; }, {});

// Every Encompass id the registry knows (primary + alt). flattenLoan restricts
// custom-field passthrough to this set so an unmapped custom field (e.g. a credit
// score like CX.MIDDLESCORE) is NEVER surfaced — defense-in-depth for the PII
// governance above, on top of extractFields already being registry-filtered.
const KNOWN_FIELD_IDS = (() => {
  const s = new Set();
  for (const e of REGISTRY) { s.add(e.encompassFieldId); if (e.altFieldId) s.add(e.altFieldId); }
  return s;
})();

// ── Identity map (borrower + co-borrower) — data for the reconcile service ───
// These are matched with special methods (name-normalize, date-equals, SSN by
// HMAC/last-4 only, address canonicalization) and, for the sensitive ones, ride
// the sanitize + audited-reveal chokepoints. They are DELIBERATELY not part of
// REGISTRY / extractFields so no PII (SSN/DOB) is ever pulled into the generic
// economics extract. `sensitive:true` = never store/print plaintext.
const IDENTITY_MAP = Object.freeze([
  Object.freeze({ key: 'first_name', our: 'borrowers.first_name', enc: 'applications[].{party}.firstName', stdFieldId: { borrower: '4000', coBorrower: '4004' }, match: 'nameEquals' }),
  Object.freeze({ key: 'last_name', our: 'borrowers.last_name', enc: 'applications[].{party}.lastName', stdFieldId: { borrower: '4002', coBorrower: '4006' }, match: 'nameEquals' }),
  Object.freeze({ key: 'middle_suffix', our: '(no column)', enc: 'applications[].{party}.middleName / .suffixToName', match: 'findingOnly', note: 'No home in our schema — finding only (drop/append), never a block' }),
  Object.freeze({ key: 'date_of_birth', our: 'borrowers.date_of_birth', enc: 'applications[].{party}.birthDate', stdFieldId: { borrower: '1402', coBorrower: '1403' }, match: 'dateEquals', sensitive: true, note: 'Respect sanitizeDob + DOB-review rules' }),
  Object.freeze({ key: 'ssn', our: 'borrowers.ssn_hash / ssn_last4', enc: 'applications[].{party}.taxIdentificationIdentifier', stdFieldId: { borrower: '65', coBorrower: '97' }, match: 'ssnHash', sensitive: true, note: 'Compare by HMAC hash / last-4 ONLY; reveal stays behind the audited view_ssn gate; never fetch-print-store plaintext' }),
  Object.freeze({ key: 'current_address', our: 'borrowers.current_address (jsonb)', enc: 'applications[].{party}.residences[] (current) / mailing', match: 'addressCanon', note: 'Canonicalize with address-canon.samePlace' }),
  Object.freeze({ key: 'phone', our: 'borrowers.cell_phone', enc: 'applications[].{party}.mobilePhone / .homePhoneNumber', match: 'digitsEquals' }),
  Object.freeze({ key: 'email', our: 'borrowers.email', enc: 'applications[].{party}.emailAddressText', match: 'lowerEquals' }),
  Object.freeze({ key: 'vesting_llc', our: 'llcs.name via applications.llc_id', enc: 'field 1859 (subject LLC vesting name)', stdFieldId: { borrower: '1859' }, match: 'nameEquals', note: 'Owner-directed: match field 1859 with our subject LLC vesting' }),
]);

// ── Value maps — same meaning, different wording (owner-locked) ──────────────
// Each table normalizes BOTH the Encompass display value AND our canonical value
// to a shared token, so the comparison maps meanings, not strings. Self-mappings
// (our canonical tokens) are included so `mapValue` normalizes our side too.
const VALUE_MAPS = Object.freeze({
  // CX.DEALPROJECTTYPE ↔ applications.deal_type (flip/fix-and-hold/ground-up/rental) / program.
  // Tokens are our deal_type vocabulary; our own values self-map so normalizing our side resolves.
  dealType: {
    'fix and flip': 'flip', 'fix & flip': 'flip', 'flip': 'flip', 'rehab': 'flip',
    'fix and hold': 'fix-and-hold', 'fix & hold': 'fix-and-hold', 'fix-and-hold': 'fix-and-hold', 'brrr': 'fix-and-hold', 'hold': 'fix-and-hold',
    'new construction': 'ground-up', 'ground up': 'ground-up', 'ground-up': 'ground-up', 'construction': 'ground-up',
    'bridge': 'bridge',
    'rental': 'rental', 'dscr': 'rental', 'long-term rental': 'rental',
  },
  // CX.EXITPLAN (reference/advisory — kept for staff context)
  exitPlan: {
    'sale': 'sell', 'sell': 'sell', 'fix and flip': 'sell', 'flip': 'sell',
    'refinance: rental': 'hold', 'refinance': 'hold', 'refi': 'hold', 'rent': 'hold', 'rental': 'hold', 'hold': 'hold',
  },
  // CX.REHABTYPE ↔ applications.rehab_type (Cosmetic/Moderate/Heavy/Adding SF/Ground-up)
  rehabType: {
    'light rehab': 'light', 'light': 'light', 'cosmetic': 'light', 'cosmetic / light': 'light', 'cosmetic/light': 'light',
    'moderate': 'moderate', 'medium': 'moderate', 'moderate rehab': 'moderate',
    'heavy rehab': 'heavy', 'heavy': 'heavy',
    'expansion': 'expansion', 'adding sf': 'expansion', 'add sf': 'expansion', 'adding square footage': 'expansion',
    'ground-up': 'ground-up', 'ground up': 'ground-up', 'new construction': 'ground-up',
  },
  // CX.ACCRUALTYPE ↔ applications.accrual_type (non_dutch | dutch). NOTE: the
  // Encompass vocabulary differs from term-options.resolveAccrual — 'Note' means
  // full-boat/Dutch here, which resolveAccrual would mis-bucket, so this table is
  // Encompass-specific (owner-locked): Drawn/Non-Dutch → non_dutch; Note/Dutch → dutch.
  accrual: {
    'drawn': 'non_dutch', 'as-drawn': 'non_dutch', 'as drawn': 'non_dutch', 'non-dutch': 'non_dutch', 'non dutch': 'non_dutch', 'nondutch': 'non_dutch', 'non_dutch': 'non_dutch',
    'note': 'dutch', 'dutch': 'dutch', 'full-boat': 'dutch', 'full boat': 'dutch', 'fullboat': 'dutch',
  },
  // CX.LOANTOBEVESTED ↔ derive(applications.llc_id)
  vesting: {
    'entity': 'entity', 'llc': 'entity', 'corporation': 'entity', 'corp': 'entity', 'trust': 'entity',
    'individual': 'individual', 'person': 'individual', 'natural person': 'individual',
  },
  // std 1041 / CX.PROPERTYTYPE ↔ applications.property_type (range category:
  // SFR / Multi 2-4 / Multi 5+ / Condo / Townhouse / Mixed Use). Advisory-only —
  // our coarse category vs Encompass finer wording is lossy; unmapped values fall
  // through to "not comparable" (never a false block, never a false match).
  propertyType: {
    'sfr': 'sfr', 'single family': 'sfr', 'single family residence': 'sfr', 'singlefamily': 'sfr', 'sfr (1 unit)': 'sfr', '1 unit': 'sfr', 'detached': 'sfr',
    'multi 2-4': 'multi_2_4', '2-4 family': 'multi_2_4', '2-4 units': 'multi_2_4', '2-4 unit': 'multi_2_4', 'two to four family': 'multi_2_4', 'duplex': 'multi_2_4', 'triplex': 'multi_2_4', 'fourplex': 'multi_2_4',
    'multi 5+': 'multi_5plus', 'multi 5plus': 'multi_5plus', 'multifamily': 'multi_5plus', 'multi-family': 'multi_5plus', '5+ units': 'multi_5plus',
    'condo': 'condo', 'condominium': 'condo',
    'townhouse': 'townhouse', 'townhome': 'townhouse', 'town home': 'townhouse', 'town house': 'townhouse',
    'mixed use': 'mixed_use', 'mixed-use': 'mixed_use',
  },
});

// Normalize a raw display value to a shared token via a VALUE_MAPS table.
// Returns null when the value is blank or unmapped (→ "not comparable").
function mapValue(mapName, raw) {
  if (raw === undefined || raw === null) return null;
  const table = VALUE_MAPS[mapName];
  if (!table) return null;
  // Normalize dashes (en/em → hyphen) so 'Multi 2–4' and 'Multi 2-4' unify.
  const norm = String(raw).trim().toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  if (norm === '') return null;
  return Object.prototype.hasOwnProperty.call(table, norm) ? table[norm] : null;
}

// The material keys we reconcile Encompass on (verified fields first — the
// unverified ones are still mapped but a caller can filter on `verified`).
function reconcilableKeys({ verifiedOnly } = {}) {
  return REGISTRY.filter((e) => (verifiedOnly ? e.verified : true)).map((e) => e.key);
}

// Keys that are actually compared (compare !== 'reference') — convenience for
// the reconcile service (WO-B) which skips reference-only fields.
function comparableKeys() {
  return REGISTRY.filter((e) => e.compare !== 'reference').map((e) => e.key);
}

/**
 * flattenLoan(rawLoan) → { fields: { <fieldId|CX.NAME>: {value[, format]} } }.
 * Turns a full `GET /loans/{guid}` response into the flat field map extractFields
 * consumes. Reads custom-field values from `customFields[]` (key `value`/`format`,
 * NOT stringValue) and standard fields via each registry entry's `loanPath`.
 * Pure shape transform — surfaces ONLY registry-mapped fields (custom AND
 * standard are both filtered to KNOWN_FIELD_IDS, so an unmapped/PII custom field
 * never passes through), never walks the `applications[]` borrower subtree (no
 * SSN/DOB), never mutates the input, never stores anything. Also passes through
 * an already-flat `{ fields: {…} }` envelope (registry keys only) so it is
 * idempotent.
 */
function flattenLoan(rawLoan) {
  const out = {};
  if (!rawLoan || typeof rawLoan !== 'object') return { fields: out };

  // Custom fields — customFields[] = [{ fieldName, value, format }] — registry-only.
  const cfs = Array.isArray(rawLoan.customFields) ? rawLoan.customFields : [];
  for (const cf of cfs) {
    if (!cf || !cf.fieldName || !KNOWN_FIELD_IDS.has(cf.fieldName)) continue;
    out[cf.fieldName] = { value: cf.value, format: cf.format };
  }

  // Standard fields — resolve each registry entry's loanPath off the loan object.
  for (const e of REGISTRY) {
    if (!e.loanPath) continue;
    const paths = Array.isArray(e.loanPath) ? e.loanPath : [e.loanPath];
    for (const p of paths) {
      const v = getPath(rawLoan, p);
      if (v !== undefined && v !== null && v !== '') { out[e.encompassFieldId] = { value: v }; break; }
    }
  }

  // Pass through an already-flat envelope (registry keys only, no clobber).
  if (rawLoan.fields && typeof rawLoan.fields === 'object') {
    for (const k of Object.keys(rawLoan.fields)) if (KNOWN_FIELD_IDS.has(k) && !(k in out)) out[k] = rawLoan.fields[k];
  }
  return { fields: out };
}

// Read a simple dotted path (e.g. 'property.propertyType') off an object. No
// array-wildcard support — the registry only uses scalar / one-level paths.
function getPath(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * extractFields(encompassLoan, { verifiedOnly }) → { portalKey: value }.
 * Reads the registry's field IDs out of an Encompass loan/fields response into
 * the shape system-reconciliation.reconcileEncompass consumes. Tolerates a flat
 * `{ "1109": value }` map, a `{ fields: { "1109": {value} } }` envelope, and a
 * full loan (via flattenLoan). Missing fields are simply absent (never a
 * fabricated 0). Uses `altFieldId` as a fallback when the primary id is absent.
 */
function extractFields(encompassLoan, opts) {
  const o = opts || {};
  const src = encompassLoan || {};
  // A full loan (customFields[]) is flattened first; a flat/enveloped map is used as-is.
  const enveloped = Array.isArray(src.customFields) ? flattenLoan(src) : src;
  const flat = enveloped.fields && typeof enveloped.fields === 'object' ? enveloped.fields : enveloped;
  const out = {};
  for (const e of REGISTRY) {
    if (o.verifiedOnly && !e.verified) continue;
    let raw = readField(flat, e.encompassFieldId);
    if ((raw === undefined || raw === null || raw === '') && e.altFieldId) raw = readField(flat, e.altFieldId);
    if (raw === undefined || raw === null || raw === '') continue;
    out[e.key] = coerce(raw, e.type);
  }
  return out;
}

// Read a field id from a field map, unwrapping a { value } cell if present.
function readField(flat, id) {
  if (!flat || typeof flat !== 'object') return undefined;
  const cell = flat[id];
  if (cell && typeof cell === 'object' && 'value' in cell) return cell.value;
  return cell;
}

function coerce(v, type) {
  if (type === 'money' || type === 'rate' || type === 'percent' || type === 'int') {
    const n = Number(String(v).replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return String(v).trim();
}

// ── Pure comparison (WO-B consumes this) ─────────────────────────────────────
function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[$,%\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function normText(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' '); }
// Name/entity normalization: drop punctuation (commas, periods) so
// 'ABC Holdings, LLC' ≡ 'ABC Holdings LLC'. Deliberately does NOT strip entity
// suffixes (llc/inc/corp) — that would wrongly equate distinct entities.
function normName(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function normDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  // ISO date portion, UTC, no time component.
  return d.toISOString().slice(0, 10);
}
// Money is exact-to-the-penny (owner): a half-cent tolerance absorbs float noise
// while a full one-cent difference still mismatches. Percent tolerates a hundredth
// of a point — enough to absorb our 3dp columns vs Encompass 4dp without masking a
// real (≥0.1-point) disagreement. EPS makes the "exactly at tolerance" boundary
// inclusive despite IEEE-754 rounding (e.g. 92.11−92.10 = 0.01000000000000512).
const MONEY_TOL = 0.005;
const PERCENT_TOL = 0.01;
const EPS = 1e-9;

/**
 * compareField(entry, ourValue, encValue) → {
 *   key, encompassFieldId, label, category, compare, gate,
 *   ours, theirs, oursNorm, theirsNorm, status
 * }
 * status: 'match' | 'mismatch' | 'incomparable' | 'reference'.
 * Pure and deterministic — no side effects. `entry` may be a registry entry or
 * a key string. Reference fields are surfaced but never a finding. A value
 * absent on either side (or an unmapped enum) is 'incomparable' (skipped, never
 * a spurious finding). This is a read/compare helper ONLY — it writes nothing.
 */
function compareField(entryOrKey, ourValue, encValue) {
  const e = typeof entryOrKey === 'string' ? BY_KEY[entryOrKey] : entryOrKey;
  if (!e) throw new Error(`compareField: unknown field ${entryOrKey}`);
  const base = {
    key: e.key,
    encompassFieldId: e.encompassFieldId,
    label: e.note || e.key,
    category: e.category || null,
    compare: e.compare,
    gate: e.gate,
    ours: ourValue == null ? null : ourValue,
    theirs: encValue == null ? null : encValue,
    oursNorm: null,
    theirsNorm: null,
    status: 'incomparable',
  };

  if (e.compare === 'reference') { base.status = 'reference'; return base; }

  const kind = e.compare;
  if (kind === 'money' || kind === 'percent' || kind === 'int') {
    const a = num(ourValue); const b = num(encValue);
    base.oursNorm = a; base.theirsNorm = b;
    if (a === null || b === null) return base; // incomparable
    const tol = kind === 'money' ? MONEY_TOL : kind === 'percent' ? PERCENT_TOL : 0;
    base.status = Math.abs(a - b) <= tol + EPS ? 'match' : 'mismatch';
    return base;
  }
  if (kind === 'date') {
    const a = normDate(ourValue); const b = normDate(encValue);
    base.oursNorm = a; base.theirsNorm = b;
    if (a === null || b === null) return base;
    base.status = a === b ? 'match' : 'mismatch';
    return base;
  }
  if (kind === 'enum') {
    const a = mapValue(e.valueMap, ourValue); const b = mapValue(e.valueMap, encValue);
    base.oursNorm = a; base.theirsNorm = b;
    if (a === null || b === null) return base; // unmapped / blank → not comparable
    base.status = a === b ? 'match' : 'mismatch';
    return base;
  }
  if (kind === 'name') {
    const a = normName(ourValue); const b = normName(encValue);
    base.oursNorm = a; base.theirsNorm = b;
    if (a === '' || b === '') return base;
    base.status = a === b ? 'match' : 'mismatch';
    return base;
  }
  // text (default)
  const a = normText(ourValue); const b = normText(encValue);
  base.oursNorm = a; base.theirsNorm = b;
  if (a === '' || b === '') return base;
  base.status = a === b ? 'match' : 'mismatch';
  return base;
}

module.exports = {
  REGISTRY,
  BY_KEY,
  BY_FIELD_ID,
  IDENTITY_MAP,
  VALUE_MAPS,
  GATE,
  reconcilableKeys,
  comparableKeys,
  extractFields,
  flattenLoan,
  mapValue,
  compareField,
  _internals: { coerce, readField, getPath, num, normText, normName, normDate, KNOWN_FIELD_IDS, MONEY_TOL, PERCENT_TOL },
};

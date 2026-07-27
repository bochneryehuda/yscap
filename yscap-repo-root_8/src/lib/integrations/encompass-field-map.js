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
  // Exit plan is a REAL match (owner-directed 2026-07-26 — was reference-only): our
  // program/deal type IMPLIES the exit, so fix & flip ≡ Sale and fix & hold / rental
  // ≡ Rental/Refinance. buildOurValues derives it (exitPlanFor) — we have no column,
  // but the deal type is unambiguous, so it is compared rather than merely displayed.
  // `naWhenOursMissing`: a BRIDGE or GROUND-UP deal has no exit plan we can derive —
  // there is nothing for staff to "go enter", so an underivable OUR side means NOT
  // APPLICABLE, not missing data, and summarize() skips it instead of holding the
  // term sheet. (Without this the enum promotion would hard-block every Bridge /
  // Ground-Up file — the same trap funded_date was left as reference to avoid.)
  pull({ key: 'exit_plan', encompassFieldId: 'CX.EXITPLAN', type: 'enum', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'exitPlan', naWhenOursMissing: true, our: 'derived from program/loan_type (flip→sell, hold/rental→hold)', note: 'Exit plan — matched: fix & flip → Sale; fix & hold / DSCR rental → Rental/Refinance' }),
  // NOTE BUYER / capital provider (owner-directed 2026-07-26 — a deliberate,
  // documented exception to the 'no capital-partner fields in the registry' rule).
  // It is compared so a file's note buyer and Encompass's capital provider cannot
  // silently disagree. STAFF-ONLY by construction: the only surface that renders
  // these fields is the staff Encompass panel — this name must NEVER reach a
  // borrower. ADVISORY: our side is free text, so a difference surfaces for a human.
  pull({ key: 'capital_provider', encompassFieldId: 'CX.CAPITALPROVIDER', type: 'enum', category: 'program', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'capitalProvider', nameFallback: true, verified: true, our: 'column:lender (note buyer)', note: 'Note buyer / capital provider — STAFF-ONLY. Encompass dropdown read live 2026-07-26: Fidelis Investors / RCN / Roc Capital / Temple View Capital / CorrFirst / BlueLake / EMCAP / Other. nameFallback: an unmapped buyer still compares by name (corporate-form + spelling tolerant) when both sides carry one' }),
  pull({ key: 'loan_to_be_vested', encompassFieldId: 'CX.LOANTOBEVESTED', type: 'enum', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'vesting', our: 'derive(applications.llc_id present → entity)', note: 'Entity vs individual vesting flag' }),
  // ROOT-CAUSE FIX (owner-reported 2026-07-26: "1859 is fully set in Encompass but
  // our system says no data"). 1859 is a NUMBERED STANDARD field, not a custom
  // field — and it had NO loanPath, so flattenLoan (which reads customFields[] or a
  // loanPath, nothing else) could NEVER see it no matter what Encompass held. The
  // candidate paths below are tried in order; the first one present wins, and an
  // absent path still degrades to "no data" rather than a wrong value.
  pull({ key: 'vesting_llc', encompassFieldId: '1859', loanPath: ['closingDocument.finalVestingDescription', 'vesting.entityName', 'vesting.trustName', 'vestingEntityName', 'uldd.fannieTrustName', 'closingDocument.borrowerUnparsedName1'], type: 'text', category: 'identity', compare: 'entity', our: 'llcs.name via applications.llc_id', note: 'Subject LLC / vesting NAME — field 1859. AUTHORITATIVE source is the fieldReader (read by number). The loanPath list is a best-effort FALLBACK for when the fieldReader is unavailable, and the SAME field lives at a DIFFERENT path from loan to loan: finalVestingDescription reads like "LAYBACK LLC, A LIMITED LIABILITY COMPANY" on one loan; VERIFIED LIVE 2026-07-26 on loan YSCAP258134629 (117 Brook) the vesting name lives at closingDocument.borrowerUnparsedName1 / uldd.fannieTrustName ("MW TRADING LLC") — finalVestingDescription is absent there. compare:entity strips any trailing legal description so all forms equal our "MW Trading LLC". On an INDIVIDUAL-vested loan borrowerUnparsedName1 is a person name; that only matters when the fieldReader is down AND our side carries an llc — a rare degraded case that (correctly) surfaces a disagreement rather than a false match' }),

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
  pull({ key: 'assignment_fee', encompassFieldId: 'CX.ASSIGNMENTFEE', type: 'money', category: 'cost', compare: 'money', zeroMeansNone: true, our: 'column:assignment_fee', note: 'Assignment fee (financeable per frozen engine: lesser of 15% of contract / $75k)' }),
  pull({ key: 'financed_interest_reserve', encompassFieldId: 'CX.FINANCEDINTERESTRESERVE', type: 'money', category: 'cost', compare: 'money', zeroMeansNone: true, our: 'quote:financedReserve$ (from requested_ir_months / requested_ir_amount)', note: 'Financed interest reserve $ — compute-only; can be 0' }),
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
  // Origination fee % — field 388. AUTHORITATIVE source is the fieldReader (read by
  // number). Do NOT list closingCost.gfe2010.loanOriginationPercentage as a fallback:
  // VERIFIED LIVE 2026-07-26 on loan YSCAP258134629 that path holds a DIFFERENT figure
  // (2) than field 388 itself (1.000 = 1%) — it reflects the GFE adjusted-origination /
  // points math, not the entered origination rate — so reading it produced exactly the
  // owner-reported "Encompass says 2% but it's really 1%". Field 388 has NO stable JSON
  // path on this tenant, so with the fieldReader down it degrades to an HONEST "no data
  // to compare" rather than a confidently-wrong 2%. The two candidates kept below are
  // harmless (absent on this tenant) and never carry the wrong GFE number.
  pull({ key: 'origination_pct', encompassFieldId: '388', loanPath: ['originationFeePercent', 'closingCost.originationFeePercentage'], type: 'percent', category: 'cost', compare: 'percent', our: 'quote:origination % (e.g. 1.25)', note: 'Origination fee % — field 388. Read authoritatively BY FIELD NUMBER (fieldReader → 1.000 = 1%), the same scale as our origPct*100. The GFE loanOriginationPercentage path is deliberately NOT a fallback — it is a different fee (points/adjusted origination) and reads 2 where field 388 is 1' }),
  pull({ key: 'term_months', encompassFieldId: '4', loanPath: 'loanAmortizationTermMonths', type: 'int', category: 'loan', compare: 'int', our: 'column:term (text → int)', note: 'Term in months' }),
  pull({ key: 'maturity_date', encompassFieldId: '78', loanPath: 'maturityDate', type: 'date', category: 'loan', compare: 'date', our: 'column:maturity_date', note: 'Maturity date — read from full loan (maturityDate), not pipeline' }),
  // Funded date — the closing-workflow 3-system reconciliation reads this (field
  // 1401 Funded Date; docs/ENCOMPASS-DATA-MAPPING.md §3G). REFERENCE only for the
  // per-file term-sheet comparison: it is DISPLAYED (Encompass's funded date) but
  // NEVER gates term-sheet issuance. It must not, because a funded date only
  // exists AFTER the loan funds — long after the term sheet is issued — so under
  // the owner-directed match-all gate (2026-07-26: advisory + "no data" both hold
  // the term sheet) a naturally-empty funded_date would wrongly block every
  // pre-funding file. extractFields still returns the value (compare type does not
  // affect extraction), so closing.js `readEncompassFundedDate` + the closing
  // reconciliation gate (#773) keep working unchanged. loanPath is
  // closingDocument.fundingDate — verify the tenant populates it on a live funded
  // loan before the closing gate treats a present value as authoritative.
  pull({ key: 'funded_date', encompassFieldId: '1401', loanPath: 'closingDocument.fundingDate', type: 'date', category: 'loan', compare: 'reference', gate: GATE.REFERENCE, our: 'column:funded_date', note: 'Funded date — read-only reference; shown for info, never gates the term sheet (empty until funding); the closing reconciliation gate reads the value separately' }),

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
  // MIDDLE NAME + SUFFIX now have a real home (db/343, owner-directed 2026-07-27).
  // They used to be "finding only" because PILOT stored a person as first + last
  // and a one-line ClickUp name was cut with lastIndexOf(' ') — so Encompass's
  // correctly-split middleName had nowhere to land, and the borrower-name compare
  // (which joined first+last on both sides) read our merged "Issac Michael" +
  // "Grunzweig" as a MISMATCH against their "Issac" + "Grunzweig". That mismatch
  // is BLOCK-gated, so it held term sheets on files where nothing was wrong.
  //
  // `nameEqualsLoose`: the name comparison is middle-name TOLERANT — a side that
  // simply omits the middle name, or carries an initial where the other has the
  // full word, is the SAME person (see lib/person-name.compareNames). A genuinely
  // different middle name is still a mismatch. Compared, never written back:
  // Encompass stays read-only forever.
  Object.freeze({ key: 'middle_name', our: 'borrowers.middle_name', enc: 'applications[].{party}.middleName', stdFieldId: { borrower: '4001', coBorrower: '4005' }, match: 'nameEqualsLoose', note: 'Middle name — optional on our side; a blank on either side is not a disagreement' }),
  Object.freeze({ key: 'name_suffix', our: 'borrowers.name_suffix', enc: 'applications[].{party}.suffixToName', match: 'nameEqualsLoose', note: 'Generational/professional suffix (Jr., III). Kept OUT of last_name so the surname compares cleanly' }),
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
    'sale': 'sell', 'sell': 'sell', 'sell/sale': 'sell', 'sale/sell': 'sell', 'resale': 'sell',
    'fix and flip': 'sell', 'fix & flip': 'sell', 'flip': 'sell', 'sell property': 'sell', 'market sale': 'sell',
    'refinance: rental': 'hold', 'refinance: long term': 'hold', 'refinance - rental': 'hold',
    'refinance': 'hold', 'refi': 'hold', 'rent': 'hold', 'rental': 'hold', 'hold': 'hold',
    'rent/refinance': 'hold', 'refinance/rental': 'hold', 'long term rental': 'hold', 'buy and hold': 'hold',
  },
  // CX.CAPITALPROVIDER ↔ applications.lender (the NOTE BUYER — STAFF-ONLY, never
  // shown to a borrower). Encompass's dropdown was read LIVE 2026-07-26:
  //   Fidelis Investors | RCN | Roc Capital | Temple View Capital | CorrFirst |
  //   BlueLake | Other | EMCAP
  // Our names are shorter free text ("Fidelis", "Blue Lake"), so both sides
  // normalize onto one token. "Fidelis" vs "Fidelis Investors" was the real
  // mismatch; spacing ("Blue Lake" vs "BlueLake") already collapsed. A trailing
  // CORPORATE FORM (LLC / Inc / Corp / …) is stripped by mapValue before the lookup
  // (owner-reported 2026-07-27: "Fidelis Investors LLC" read "no data to compare"
  // against "Fidelis Investors"), and capital_provider ALSO carries `nameFallback`
  // so a note buyer NOT in this table still compares by name when both sides carry
  // one — "no data to compare" is then reserved for a genuinely empty side.
  capitalProvider: {
    'fidelis': 'fidelis', 'fidelis investors': 'fidelis', 'fidelis investments': 'fidelis', 'fidelis investments llc': 'fidelis', 'fidelis investors llc': 'fidelis',
    'blue lake': 'bluelake', 'bluelake': 'bluelake', 'blue lake capital': 'bluelake',
    'corrfirst': 'corrfirst', 'corr first': 'corrfirst',
    'emcap': 'emcap', 'em cap': 'emcap',
    'rcn': 'rcn', 'rcn capital': 'rcn',
    'roc capital': 'roccapital', 'roc': 'roccapital', 'roc360': 'roccapital',
    'temple view capital': 'templeview', 'temple view': 'templeview', 'templeview': 'templeview',
    'other': 'other',
  },
  // CX.REHABTYPE ↔ applications.rehab_type (Cosmetic/Moderate/Heavy/Adding SF/Ground-up)
  // Owner-directed 2026-07-26: Encompass only has Light / Heavy / Expansion, so our
  // finer buckets COLLAPSE onto that vocabulary — Cosmetic AND Moderate both mean
  // LIGHT rehab in Encompass (previously 'moderate' mapped to its own token that
  // Encompass could never produce, so a moderate file was permanently "no data").
  // A square-footage ADDITION is Expansion (see rehabTypeFor in reconcile.js, which
  // upgrades a file flagged for sqft addition to 'expansion').
  // Owner-directed 2026-07-27: COSMETIC and LIGHT are the SAME tier — "cosmetic and
  // light rehab is the same technically, they can call it however they want." So our
  // Cosmetic ≡ Encompass "Light Rehab" ≡ Encompass "Cosmetic Rehab" — all collapse to
  // ONE 'light' token so they MATCH (they were their own bucket under the 2026-07-26
  // mapping, which made a Cosmetic-vs-Light-Rehab file wrongly read "Doesn't match").
  // Encompass CX.REHABTYPE read LIVE: Cosmetic Rehab | Light Rehab | Heavy Rehab |
  // Expansion | New construction. Ours (the file-details dropdown): Cosmetic |
  // Moderate | Heavy / gut rehab | Adding square footage | Ground-up construction.
  //   our Cosmetic / Moderate   -> the ONE light tier (Cosmetic Rehab / Light Rehab)
  //   our Heavy / gut rehab     -> Heavy Rehab
  //   our Adding square footage -> Expansion   (also set by the sqft-grew signal)
  //   our Ground-up construction-> New construction
  rehabType: {
    'cosmetic': 'light', 'cosmetic rehab': 'light',
    'light rehab': 'light', 'light': 'light', 'moderate': 'light', 'moderate rehab': 'light', 'medium': 'light',
    'cosmetic / light': 'light', 'cosmetic/light': 'light',
    'heavy rehab': 'heavy', 'heavy': 'heavy', 'heavy / gut rehab': 'heavy', 'heavy/gut rehab': 'heavy', 'gut rehab': 'heavy', 'gut': 'heavy', 'heavy gut rehab': 'heavy',
    'expansion': 'expansion', 'adding sf': 'expansion', 'add sf': 'expansion', 'adding square footage': 'expansion',
    'adding square feet': 'expansion', 'sqft addition': 'expansion', 'square footage expansion': 'expansion',
    'new construction': 'ground-up', 'ground-up': 'ground-up', 'ground up': 'ground-up',
    'ground-up construction': 'ground-up', 'ground up construction': 'ground-up', 'groundup': 'ground-up',
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

// Trailing/embedded CORPORATE FORM (LLC / L.L.C. / LP / LLP / Inc / Corp / Corporation
// / Co / Company / Ltd), stripped when matching an ENTITY NAME so "Fidelis Investors LLC"
// resolves the same as "Fidelis Investors" (owner-reported 2026-07-27). Word-bounded so it
// never eats a real name token.
const CORP_FORM = /\b(l\.?\s*l\.?\s*c\.?|l\.?\s*l\.?\s*p\.?|l\.?\s*p\.?|inc\.?|incorporated|corp\.?|corporation|company|co\.?|ltd\.?)\b/g;
function stripCorpForm(s) {
  return String(s == null ? '' : s).replace(CORP_FORM, ' ').replace(/\s+/g, ' ').trim();
}
// Entity-name normalizer for the note-buyer NAME FALLBACK: lowercase, punctuation → space,
// strip the corporate form, collapse whitespace. So "Fidelis Investors, LLC" and
// "Fidelis Investors" both reduce to "fidelis investors".
function normPartnerName(v) {
  const s = String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return stripCorpForm(s);
}

// Normalize a raw display value to a shared token via a VALUE_MAPS table.
// Returns null when the value is blank or unmapped (→ "not comparable").
function mapValue(mapName, raw) {
  if (raw === undefined || raw === null) return null;
  const table = VALUE_MAPS[mapName];
  if (!table) return null;
  // Normalize dashes (en/em → hyphen) so 'Multi 2–4' and 'Multi 2-4' unify.
  const norm = String(raw).trim().toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  if (norm === '') return null;
  if (Object.prototype.hasOwnProperty.call(table, norm)) return table[norm];
  // Secondary: tolerate a corporate-form suffix + stray punctuation so an entity name
  // like "Fidelis Investors, LLC" resolves to the same token as "Fidelis Investors".
  // Safe for the non-entity maps — their keys carry no corporate form, so a stripped
  // value can only ever hit an entity-name key, never a false match elsewhere.
  const norm2 = stripCorpForm(norm.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim());
  if (norm2 && norm2 !== norm && Object.prototype.hasOwnProperty.call(table, norm2)) return table[norm2];
  return null;
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
// Every Encompass field id the registry needs — handed to the fieldReader so we can
// read them BY NUMBER instead of guessing where each one lives in the loan JSON.
function allFieldIds() { return REGISTRY.map((e) => e.encompassFieldId).filter(Boolean); }

// Normalize a raw Encompass fieldReader response into a flat { fieldId: value } map,
// regardless of which wire shape it arrived in. This exists because the shape is NOT
// stable across API versions / gateways (VERIFIED LIVE 2026-07-26 on the tenant):
//   - v3 POST /encompass/v3/loans/{guid}/fieldReader returns an OBJECT map:
//       { "1859": "MW TRADING LLC", "388": "1.000", ... }
//   - v1 POST /encompass/v1/loans/{guid}/fieldReader returns an ARRAY of pairs:
//       [ { "fieldId": "1859", "value": "MW TRADING LLC" }, { "fieldId": "388", "value": "1.000" } ]
//   (ICE's own SDK types the response as List<LoanFieldDataContract> — an array — so
//    the array form must be handled even though this tenant's v3 returns the map.)
// The OLD reader accepted only the object form and DISCARDED an array as `{}`, which is
// exactly the failure mode that left _fieldValues empty and the panel falling back to
// the wrong JSON paths. This helper accepts BOTH so a real response is never dropped.
// Pure — no network, no DB. Returns {} for anything unrecognizable (never throws).
function fieldReaderToMap(raw) {
  const out = {};
  if (raw == null) return out;
  const put = (id, val) => {
    if (id == null || id === '') return;
    // Unwrap a { value } cell if the value itself arrived nested.
    const v = (val && typeof val === 'object' && 'value' in val) ? val.value : val;
    if (v === undefined) return;
    out[String(id)] = v;
  };
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (row == null) continue;
      if (typeof row === 'object') {
        const id = row.fieldId != null ? row.fieldId : (row.id != null ? row.id : row.fieldName);
        put(id, 'value' in row ? row.value : row);
      }
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const [id, val] of Object.entries(raw)) put(id, val);
    return out;
  }
  return out;
}

function flattenLoan(rawLoan) {
  const out = {};
  // AUTHORITATIVE first (owner-directed 2026-07-26): values read straight from
  // Encompass BY FIELD NUMBER (the reader stashes them on `_fieldValues`). The same
  // field number lives at different JSON paths on different loans, so a number we
  // were GIVEN always beats a path we GUESSED. Everything below only fills gaps.
  const authoritative = (rawLoan && rawLoan._fieldValues && typeof rawLoan._fieldValues === 'object') ? rawLoan._fieldValues : null;
  if (authoritative) {
    for (const [id, v] of Object.entries(authoritative)) {
      if (v === undefined || v === null || v === '') continue;
      out[id] = { value: v };
    }
  }
  if (!rawLoan || typeof rawLoan !== 'object') return { fields: out };

  // Custom fields — customFields[] = [{ fieldName, value, format }] — registry-only.
  const cfs = Array.isArray(rawLoan.customFields) ? rawLoan.customFields : [];
  for (const cf of cfs) {
    if (!cf || !cf.fieldName || !KNOWN_FIELD_IDS.has(cf.fieldName)) continue;
    // Skip an EMPTY cell: recording it would occupy the id and shadow a perfectly
    // good standard-field loanPath below (which is exactly how 1859 / 388 read as
    // "no data"). A blank custom field carries no information — the loanPath wins.
    if (cf.value === undefined || cf.value === null || cf.value === '') continue;
    if (!(cf.fieldName in out)) out[cf.fieldName] = { value: cf.value, format: cf.format };
  }

  // Standard fields — resolve each registry entry's loanPath off the loan object.
  for (const e of REGISTRY) {
    if (!e.loanPath) continue;
    const paths = Array.isArray(e.loanPath) ? e.loanPath : [e.loanPath];
    for (const p of paths) {
      const v = getPath(rawLoan, p);
      // Do NOT clobber a value already read from customFields[] — a candidate
      // loanPath that happens to exist must never override the real custom field.
      if (v !== undefined && v !== null && v !== '') { if (!(e.encompassFieldId in out)) out[e.encompassFieldId] = { value: v }; break; }
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
  // A FULL loan is flattened first; a flat/enveloped id map is used as-is. Detect a
  // full loan by customFields[] OR by any of the top-level sections our loanPaths
  // read from — a tenant loan that carries no custom fields still has to have its
  // standard fields (vesting, origination, …) resolved, not treated as a flat map.
  const looksFullLoan = Array.isArray(src.customFields)
    // Authoritative field-reader values (read BY NUMBER) always route through
    // flattenLoan so they are honored no matter what else the loan object carries.
    || (src._fieldValues && typeof src._fieldValues === 'object')
    || (!src.fields && ['closingDocument', 'closingCost', 'property', 'applications', 'loanNumber', 'baseLoanAmount']
      .some((k) => Object.prototype.hasOwnProperty.call(src, k)));
  const enveloped = looksFullLoan ? flattenLoan(src) : src;
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
// Encompass stores the vesting as the entity name PLUS its legal description —
// VERIFIED LIVE: "LAYBACK LLC, A LIMITED LIABILITY COMPANY". Our llcs.llc_name is
// just "Layback LLC". Drop a trailing ", A <...> COMPANY/CORPORATION/PARTNERSHIP/
// TRUST" clause (and a bare "AN INDIVIDUAL") before the normal name compare, so the
// two forms of the SAME entity match. Only a clause that clearly describes an
// entity TYPE is removed — a real second name is never truncated.
const ENTITY_DESC = /,\s*(an?\s+[a-z .]*?(limited liability company|limited partnership|general partnership|corporation|company|partnership|trust|llc|lp|inc)|an individual|its successors[^,]*|a[n]? [a-z]+ (corporation|llc|company))\s*\.?\s*$/i;
function normEntityName(v) {
  let s = String(v == null ? '' : v).trim();
  for (let i = 0; i < 3 && ENTITY_DESC.test(s); i++) s = s.replace(ENTITY_DESC, '').trim();
  return normName(s);
}
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
    // Surfaced so summarize() can treat an underivable OUR side as "not
    // applicable" rather than "missing data" (see the exit_plan entry).
    naWhenOursMissing: !!e.naWhenOursMissing,
    ours: ourValue == null ? null : ourValue,
    theirs: encValue == null ? null : encValue,
    oursNorm: null,
    theirsNorm: null,
    status: 'incomparable',
  };

  if (e.compare === 'reference') { base.status = 'reference'; return base; }

  const kind = e.compare;
  if (kind === 'money' || kind === 'percent' || kind === 'int') {
    let a = num(ourValue); let b = num(encValue);
    // Owner-directed 2026-07-26: EMPTY and ZERO mean the same thing on a field where
    // zero legitimately means "there is none of this" — the assignment fee on a
    // non-assignment, a financed interest reserve of nil. Encompass writes 0 where
    // our column is simply blank, which used to read as "no data to compare" and
    // hold the term sheet forever. So a blank on ONE side is read as 0 when the
    // OTHER side is exactly 0 — but ONLY for entries explicitly flagged
    // `zeroMeansNone`. It is NOT applied to fields where 0 is nonsense (loan
    // amount, purchase price, as-is value, ARV, units, rehab budget): there a
    // placeholder 0 in Encompass against our blank must keep reading "no data — go
    // enter it", never a false match on a block-gated number.
    // Blank-vs-a-real-number and blank-vs-blank always stay incomparable.
    if (e.zeroMeansNone) {
      if (a === null && b === 0) a = 0;
      else if (b === null && a === 0) b = 0;
    }
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
    if (a !== null && b !== null) {
      base.oursNorm = a; base.theirsNorm = b;
      base.status = a === b ? 'match' : 'mismatch';
      return base;
    }
    // NAME FALLBACK (capital provider, owner-reported 2026-07-27): the value map
    // couldn't place at least one side, but if BOTH carry data compare the entity
    // NAMES directly (corporate-form + spelling tolerant) so a variant of the SAME
    // buyer MATCHES — and "no data to compare" is reserved for a genuinely empty side,
    // never a value that is plainly present. Only entries flagged `nameFallback` use
    // it, so the other enums keep their strict "unmapped → not comparable" behavior.
    if (e.nameFallback) {
      const na = normPartnerName(ourValue); const nb = normPartnerName(encValue);
      if (na && nb) {
        base.oursNorm = na; base.theirsNorm = nb;
        base.status = na === nb ? 'match' : 'mismatch';
        return base;
      }
    }
    base.oursNorm = a; base.theirsNorm = b;
    return base; // unmapped / blank → not comparable
  }
  if (kind === 'name' || kind === 'entity') {
    const nm = kind === 'entity' ? normEntityName : normName;
    const a = nm(ourValue); const b = nm(encValue);
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
  allFieldIds,
  fieldReaderToMap,
  mapValue,
  compareField,
  _internals: { coerce, readField, getPath, num, normText, normName, normDate, normEntityName, normPartnerName, stripCorpForm, fieldReaderToMap, KNOWN_FIELD_IDS, MONEY_TOL, PERCENT_TOL },
};

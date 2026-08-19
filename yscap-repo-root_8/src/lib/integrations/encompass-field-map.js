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

// The Purchase Advice (PA) date — how PILOT knows a loan has been sold (see the entry below).
// THE ID IS 2370, SUPPLIED BY THE OWNER (2026-08-09: "the PA date for these files is going to be
// this field id 2370 — this field is going to be empty until it's sold, and it's going to get a
// date for when it's sold"). The env var stays as an OVERRIDE rather than the only source: it was
// the placeholder while the id was unknown, and leaving it in place means a tenant that turns out
// to store this somewhere else is a configuration change, not a deploy. Setting it to a blank
// string deliberately switches the field OFF (the entry disappears and the sold status honestly
// reads "we cannot tell"), which is the fastest way to stop a wrong id 400-ing the read batch.
// Read straight from the environment rather than through src/config.js so this module keeps its
// "no requires" property — every registry invariant test enumerates REGISTRY, and a config import
// would drag the whole config graph into a pure data map.
const PA_DATE_FIELD_ID = (
  Object.prototype.hasOwnProperty.call(process.env, 'ENCOMPASS_PA_DATE_FIELD_ID')
    ? String(process.env.ENCOMPASS_PA_DATE_FIELD_ID || '').trim()
    : '2370'
) || null;

const REGISTRY = Object.freeze([
  // ── Identity / program / vesting ──────────────────────────────────────────
  pull({ key: 'ys_loan_number', encompassFieldId: '364', loanPath: 'loanNumber', type: 'text', category: 'program', compare: 'text', gate: GATE.BLOCK, our: 'column:ys_loan_number', note: 'Loan number — the natural key; MATCHED (must equal Encompass Loan.LoanNumber, field 364)' }),
  pull({ key: 'property_type', encompassFieldId: 'CX.PROPERTYTYPE', skipBatch: true, type: 'enum', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'propertyType', our: 'column:property_type', note: 'Subject property type — read ONLY from the tenant custom field CX.PROPERTYTYPE (owner-directed 2026-08-18: "use always CX.PROPERTYTYPE for this dont look on 1041"). Standard field 1041 and its JSON home property.propertyType are DELIBERATELY not read: the two can disagree on this tenant, CX.PROPERTYTYPE is the copy the team maintains, and the old primary-wins rule showed whichever happened to be filled under a fixed "1041" label. skipBatch per the custom-id doctrine (a fragile custom id in the by-number batch can blank the whole read — see funded_date); the value rides the customFields[] passthrough. Our range-category (SFR / Multi 2-4 / Multi 5+ / Condo / Townhouse / Mixed Use) vs the tenant wording is lossy — value-mapped; blank/unmapped reads "no data to compare", advisory only, never a term-sheet hold.' }),
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
  // THE FUNDING CHANNEL — how the loan funded, and therefore whether it was sold at
  // the closing table (owner-directed 2026-08-09). It was `ref_table_funder`, read on
  // every pull and compared against nothing; the owner's rule gives it a job, so it is
  // promoted to a real compared field here. PILOT's side is the closer's WAREHOUSE pick
  // (closing.tableFundedFor — funding on the "Table Funding" line means sold at
  // closing), so this row answers "does the closing desk agree with Encompass about how
  // this loan funded?".
  //
  // REFERENCE — displayed, never counted by summarize(), and that is DELIBERATE rather
  // than timid. It was built as a compared enum first, and that shipped a real hazard:
  // `summarize()` counts "no data to compare" as NOT PASSING, and this field's exact
  // tenant values are UNVERIFIED (`verified:false` — the registry has called it a "table
  // funder FLAG" since it was written, while the owner describes it as a channel). So on
  // any FUNDED file whose CX.TABLEFUNDER held a spelling the value map does not carry —
  // a table funder's NAME, say — our side would be present, theirs unmappable, the row
  // incomparable, and the term sheet AND the data-tape export blocked. The only fix
  // would have been enumerating the spelling in code, which nobody at the desk can do:
  // a gate whose own remedy the user cannot perform, which is the dead-end class this
  // repo warns about.
  //
  // Both real questions are asked instead by rows this codebase fully controls, in
  // reconcile.compareFundingChannel, and each fires ONLY on a positively-readable value:
  //   · `funding_channel_rule` (BLOCK) — the owner's hard rule, that Blue Lake / EMCAP /
  //     CorrFirst may never be table funded;
  //   · `funding_channel_agreement` (ADVISORY) — our closer's warehouse pick disagreeing
  //     with Encompass about how this loan funded.
  // An unreadable Encompass value produces neither, so it can never gate anything.
  pull({ key: 'funding_channel', encompassFieldId: 'CX.TABLEFUNDER', type: 'text', category: 'program', compare: 'reference', gate: GATE.REFERENCE, valueMap: 'fundingChannel', verified: false, our: 'derive(closing_workflow.warehouse → table_funded)', note: 'Funding channel — Table Funding (sold at the closing table) vs direct RTL delegated / with TPR (sold later, so a purchase advice date is expected). Shown for context; the two questions that matter are asked as their own rows (funding_channel_rule / funding_channel_agreement) so an unverified tenant value can never block a term sheet or a tape. valueMap is still declared because funding-channel.js reads it — ONE table for both' }),
  pull({ key: 'loan_to_be_vested', encompassFieldId: 'CX.LOANTOBEVESTED', type: 'enum', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'vesting', our: 'derive(applications.llc_id present → entity)', note: 'Entity vs individual vesting flag' }),
  // Field 4008 — the TITLE VESTING ROLE (owner-directed 2026-08-05): Encompass
  // must carry field 4008 = "Officer" when the subject is vested on an LLC/entity
  // (the borrower signs as an authorized officer/member of the entity) and
  // "Individual" when it is vested in the borrower's own name. We derive our side
  // from the SAME signal as loan_to_be_vested (llc_id present → Officer/entity;
  // otherwise → Individual) so the two vesting rows on the panel can never
  // disagree. ADVISORY + naWhenOursMissing (an undecided file reads "Doesn't
  // apply" rather than a false disagreement). Read by number via the fieldReader
  // — adding it to the registry auto-includes it in the read.
  pull({ key: 'vesting_title_role', encompassFieldId: '4008', type: 'enum', category: 'identity', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'vestingTitleRole', naWhenOursMissing: true, our: 'derive(applications.llc_id present → Officer; else Individual)', note: 'Title vesting role — field 4008. Officer when vested on an LLC; Individual when vested in the borrower\'s own name. When Individual there is no subject LLC name, so field 1859 becomes not-applicable (see vesting_llc naWhenOursMissing).' }),
  // ROOT-CAUSE FIX (owner-reported 2026-07-26: "1859 is fully set in Encompass but
  // our system says no data"). 1859 is a NUMBERED STANDARD field, not a custom
  // field — and it had NO loanPath, so flattenLoan (which reads customFields[] or a
  // loanPath, nothing else) could NEVER see it no matter what Encompass held. The
  // candidate paths below are tried in order; the first one present wins, and an
  // absent path still degrades to "no data" rather than a wrong value.
  pull({ key: 'vesting_llc', encompassFieldId: '1859', loanPath: ['closingDocument.finalVestingDescription', 'vesting.entityName', 'vesting.trustName', 'vestingEntityName', 'uldd.fannieTrustName', 'closingDocument.borrowerUnparsedName1'], type: 'text', category: 'identity', compare: 'entity', naWhenOursMissing: true, our: 'llcs.name via applications.llc_id', note: 'Subject LLC / vesting NAME — field 1859. naWhenOursMissing (owner-directed 2026-08-05): when the file has NO subject LLC (vested on an individual), our side is blank, so 1859 reads "Doesn\'t apply" instead of holding the term sheet — the vesting Officer/Individual disagreement, if any, surfaces on field 4008 (vesting_title_role) instead. AUTHORITATIVE source is the fieldReader (read by number). The loanPath list is a best-effort FALLBACK for when the fieldReader is unavailable, and the SAME field lives at a DIFFERENT path from loan to loan: finalVestingDescription reads like "LAYBACK LLC, A LIMITED LIABILITY COMPANY" on one loan; VERIFIED LIVE 2026-07-26 on loan YSCAP258134629 (117 Brook) the vesting name lives at closingDocument.borrowerUnparsedName1 / uldd.fannieTrustName ("MW TRADING LLC") — finalVestingDescription is absent there. compare:entity strips any trailing legal description so all forms equal our "MW Trading LLC". On an INDIVIDUAL-vested loan borrowerUnparsedName1 is a person name; that only matters when the fieldReader is down AND our side carries an llc — a rare degraded case that (correctly) surfaces a disagreement rather than a false match' }),

  // ── Loan amount / initial advance / rehab (money) ─────────────────────────
  pull({ key: 'loan_amount', encompassFieldId: '1109', loanPath: 'baseLoanAmount', type: 'money', category: 'loan', compare: 'money', wholeDollar: true, our: 'column:loan_amount', note: 'Total loan amount (Borrower Requested Loan Amount)' }),
  pull({ key: 'max_total_loan', encompassFieldId: 'CX.MAXTOTALLOAN', type: 'money', category: 'sizing', compare: 'money', wholeDollar: true, our: 'column:loan_amount (Encompass second copy of the total)', note: 'Max/total loan — must equal our total loan amount' }),
  pull({ key: 'final_initial_loan', encompassFieldId: 'CX.FINALINITIALLOAN', type: 'money', category: 'sizing', compare: 'money', wholeDollar: true, our: 'quote:initialAdvance = loan_amount − financed_rehab − financed_reserve', note: 'Final initial advance — compute-only on our side' }),
  pull({ key: 'rehab_budget', encompassFieldId: 'CX.REHABBUDGET', type: 'money', category: 'rehab', compare: 'money', our: 'column:rehab_budget (+ SOW total)', note: 'Rehab / construction budget' }),
  pull({ key: 'financed_rehab_budget', encompassFieldId: 'CX.FINANCEDREHABBUDGET', type: 'money', category: 'rehab', compare: 'money', wholeDollar: true, our: 'derive(financed rehab = quote:rehabHoldback; equals rehab_budget unless the OOP-rehab exception was approved)', note: 'Financed portion of rehab' }),
  // Out-of-pocket rehab (owner-authorized 2026-07-31): the rehab NOT financed
  // (rehab_budget − financed holdback). $0 on nearly every file, so zeroMeansNone so a
  // blank-our-side vs 0-Encompass never reads as "no data to compare". READ-ONLY like
  // every entry — PILOT never writes to Encompass.
  pull({ key: 'oop_rehab', encompassFieldId: 'CX.OUTOFPOCKETREHAB', type: 'money', category: 'rehab', compare: 'money', zeroMeansNone: true, our: 'derive(rehab_budget − quote:rehabHoldback)', note: 'Out-of-pocket rehab (borrower-funded; 0 unless the OOP-rehab exception was approved)' }),

  // ── Purchase / assignment / cost (money) ──────────────────────────────────
  pull({ key: 'purchase_price', encompassFieldId: '136', loanPath: 'purchasePriceAmount', type: 'money', category: 'loan', compare: 'money', our: 'column:purchase_price', note: 'Real final purchase price (build-spec §5). NOTE: the discovery doc read 136/purchasePriceAmount as the EFFECTIVE price on assignment deals — confirm which the tenant populates before relying on this on an assignment file' }),
  pull({ key: 'effective_purchase', encompassFieldId: 'CX.EFFECTIVEPURCHASE', type: 'money', category: 'cost', compare: 'money', wholeDollar: true, our: 'quote:assignment.recognizedPrice (seller price + financeable fee)', note: 'Effective purchase (LTC basis) — compute-only' }),
  pull({ key: 'contract_price', encompassFieldId: 'CX.ORIGINALCONTRACTPURCHASEP', type: 'money', category: 'cost', compare: 'money', our: 'column:underlying_contract_price (falls back to purchase_price when no assignment)', note: 'Seller / underlying contract price (assignment basis)' }),
  pull({ key: 'assignment_fee', encompassFieldId: 'CX.ASSIGNMENTFEE', type: 'money', category: 'cost', compare: 'money', zeroMeansNone: true, our: 'column:assignment_fee', note: 'Assignment fee (financeable per frozen engine: lesser of 15% of contract / $75k)' }),
  pull({ key: 'financed_interest_reserve', encompassFieldId: 'CX.FINANCEDINTERESTRESERVE', type: 'money', category: 'cost', compare: 'money', zeroMeansNone: true, wholeDollar: true, our: 'quote:financedReserve$ (from requested_ir_months / requested_ir_amount)', note: 'Financed interest reserve $ — compute-only; can be 0' }),
  pull({ key: 'total_cost', encompassFieldId: 'CX.TOTALCOST', type: 'money', category: 'cost', compare: 'money', wholeDollar: true, our: 'derive(min(effective purchase, as-is) + rehab + financed reserve + program extras)', note: 'Total cost (LTC basis) — no column, derive' }),

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
  // Funded date — the closing-workflow 3-system reconciliation reads this
  // (docs/ENCOMPASS-DATA-MAPPING.md §3G). REFERENCE only for the per-file
  // term-sheet comparison: it is DISPLAYED (Encompass's funded date) but NEVER
  // gates term-sheet issuance. It must not, because a funded date only exists
  // AFTER the loan funds — long after the term sheet is issued — so under the
  // owner-directed match-all gate (2026-07-26: advisory + "no data" both hold the
  // term sheet) a naturally-empty funded_date would wrongly block every pre-funding
  // file. extractFields still returns the value (compare type does not affect
  // extraction), so closing.js `readEncompassFundedDate` + the closing
  // reconciliation gate read it.
  //
  // FIELD 1401 IS THE ENCOMPASS "LOAN PROGRAM", NOT A DATE — the funded-date row was
  // showing the PROGRAM NAME (owner-reported 2026-08-11: "the funded date is populating
  // the program from Encompass … that field is the program name of Encompass … the field
  // ID for the actual funding date is cx.fundeddate"). Field 1401 returns the loan-program
  // name (e.g. "Fix & Flip Purchase + reno"); the tenant's real funded date lives in the
  // custom field CX.FUNDEDDATE (live catalog: "Funded Date"). extractFields reads
  // `encompassFieldId` FIRST and only falls back to `altFieldId` when the primary is EMPTY
  // — and 1401 is never empty (it always carries the program) — so the CX.FUNDEDDATE
  // fallback NEVER fired and the row showed the program. An earlier fix (#1135) had left
  // 1401 as the primary to keep the by-number batch stable, which re-armed exactly this
  // display bug. The real funded date only exists AFTER the loan funds (long after the
  // term sheet), which is why this stays REFERENCE — displayed, never a term-sheet gate.
  //
  // THE VALUE COMES FROM CX.FUNDEDDATE, AND CX.FUNDEDDATE STAYS OUT OF THE BATCH.
  // `encompassFieldId` is now 'CX.FUNDEDDATE', so extractFields reads the real funded date
  // as the PRIMARY and never touches field 1401. `skipBatch: true` keeps it OUT of
  // `allFieldIds()` — the batch the fieldReader is asked for BY NUMBER on every pull AND
  // the panel self-heal — which is the load-bearing regression guard (owner-reported
  // 2026-08-11, the #1131 fallout): if a single requested id is invalid/unpermitted the
  // fieldReader fails the WHOLE call (ICE 24.2); client.readFields only split-recovers a
  // clean invalid-field 400, so any other failure shape (a 500, an odd body) throws the
  // whole read and leaves `_fieldValues` UNSET — dropping every by-number field (1859, 388,
  // and the ~20 CX.* economics with no reliable JSON path) to guessed loanPaths = "no data
  // to compare". So CX.FUNDEDDATE is read via customFields[] passthrough (its canonical home
  // in the loan JSON; it stays in KNOWN_FIELD_IDS) + the loanPath fallback
  // closingDocument.fundingDate — location-independent of the fieldReader, and it can never
  // poison the 40 economics. Field 1401 is now referenced NOWHERE, so it drops out of the
  // batch entirely; a VALID standard id leaving the batch cannot cause the #1131 failure
  // (the batch stays all-valid, just one shorter). Dates arrive in the tenant display format
  // (MM/DD/YYYY) — readEncompassFundedDate normalizes with normDate (MM/DD/YYYY AND ISO).
  pull({ key: 'funded_date', encompassFieldId: 'CX.FUNDEDDATE', skipBatch: true, loanPath: 'closingDocument.fundingDate', type: 'date', category: 'loan', compare: 'reference', gate: GATE.REFERENCE, our: 'column:funded_date', note: 'Funded date — read from the custom field CX.FUNDEDDATE (the tenant\'s real funded date), with closingDocument.fundingDate as a JSON fallback. NEVER field 1401 (that is Encompass "Loan Program" — it returns the program name, which is what wrongly showed in this row). skipBatch keeps CX.FUNDEDDATE OUT of the by-number fieldReader batch (allFieldIds) so an unreadable custom id can never blank the whole read (the #1131 regression); it is read via customFields[] passthrough + the loanPath instead. Read-only reference; shown for info, never gates the term sheet (empty until funding); the closing reconciliation gate reads the value separately.' }),
  // THE PURCHASE ADVICE (PA) DATE — the SOLD signal (owner-directed 2026-08-09: "I'm going to
  // give you the exact field ID that you should use from Encompass, which is the PA date, and
  // that's going to tell you if it was sold or not. If a file doesn't have a PA date yet, it
  // means it was not sold yet"). Present = the loan has been sold to the investor.
  //
  // It is REFERENCE-gated, so it is read and shown and NEVER compared, never a finding and never
  // a term-sheet hold — it exists only to answer "has this been sold?" for the draw release
  // party (src/sitewire/release-party.js), which asks a question and never changes anything.
  //
  // THE FIELD ID IS SUPPLIED BY THE OWNER and arrives as configuration, not as a deploy:
  // ENCOMPASS_PA_DATE_FIELD_ID. Until it is set the id is null, so `allFieldIds()` (which
  // filters falsy) never sends a made-up id to the fieldReader — a wrong id would 400 the whole
  // batch — and the sold status honestly reads "we cannot tell", which shows the warning.
  ...(PA_DATE_FIELD_ID ? [pull({ key: 'purchase_advice_date', encompassFieldId: PA_DATE_FIELD_ID, type: 'date', category: 'loan', compare: 'reference', gate: GATE.REFERENCE, verified: false, our: 'column:purchase_advice_date', note: 'Purchase advice date — field 2370, supplied by the owner 2026-08-09. Read-only reference: present = the loan was sold to the investor. Blank does NOT mean "not sold" on its own — a TABLE FUNDED loan was sold at the closing table and never receives one (see src/lib/funding-channel.js), which is why release-party.soldStatus checks table funding FIRST. Drives a warning at investor delivery and the 30-day chase; gates nothing. ENCOMPASS_PA_DATE_FIELD_ID overrides the id, and setting it blank switches the field off entirely' })] : []),

  // ── Experience / rehab-type / accrual (enum + int, advisory) ──────────────
  // A FIRST-TIME BORROWER IS A ZERO, NOT A BLANK (owner-reported 2026-08-07:
  // "borrower with zero experience — our system is empty, it doesn't say zero, and
  // Encompass has a zero, so empty and zero should be a match and it shouldn't come
  // up as not matching"). ZERO IS A REAL, COMMON ANSWER on this field — the whole
  // point of the experience tier is that plenty of borrowers have none — and our
  // side derives it from `requested_exp_*`, which are NULL until somebody states a
  // count. So the ordinary state of a genuine first-timer is blank here and 0 in
  // Encompass, which read as a mismatch on every such file. `zeroMeansNone` is the
  // existing owner-directed rule for exactly this shape (assignment fee on a
  // non-assignment, a nil interest reserve), and it is safe here for the same
  // reason: a 0 against a 0-meaning blank matches, while a blank against a REAL
  // count (Encompass says 6, we hold nothing) still reads "no data to compare" and
  // still asks a human to go and enter it. Advisory either way — it never gated.
  pull({ key: 'total_experience_deals', encompassFieldId: 'CX.TOTALEXPERIENCEDEALS', type: 'int', category: 'experience', compare: 'int', gate: GATE.ADVISORY, zeroMeansNone: true, our: 'derive(requested_exp_flips/holds/ground + verified track record)', note: 'Verified experience count used to qualify — 0 and blank mean the same thing (a first-time borrower)' }),
  pull({ key: 'rehab_type', encompassFieldId: 'CX.REHABTYPE', type: 'enum', category: 'rehab', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'rehabType', our: 'column:rehab_type', note: 'Rehab type — value-mapped (§6): Light/Cosmetic → light, Heavy → heavy, Expansion → adding SF. Advisory: our 5 buckets (incl. Moderate) have no Encompass counterpart, so a bucket difference surfaces but never blocks' }),
  pull({ key: 'accrual_type', encompassFieldId: 'CX.ACCRUALTYPE', type: 'enum', category: 'interest', compare: 'enum', gate: GATE.ADVISORY, valueMap: 'accrual', our: 'column:accrual_type', note: 'Accrual basis — advisory; Drawn/Non-Dutch → non_dutch, Note/Dutch → dutch' }),

  // ── Reference-only (owner: "reference this with no check with no matching") ─
  // PITIA removed (owner-directed 2026-07-26): the CX.PITIA field was the wrong
  // Encompass field for our purposes — do NOT reference it in the comparison.
  pull({ key: 'ref_cash_to_close', encompassFieldId: 'CX.RTLCASHTOCLOSEESTIMAT', type: 'money', category: 'cost', compare: 'reference', gate: GATE.REFERENCE, our: 'none', note: 'Estimated cash to close — reference only' }),
  pull({ key: 'ref_down_payment', encompassFieldId: 'CX.RTLDOWNPAYMENT', type: 'money', category: 'cost', compare: 'reference', gate: GATE.REFERENCE, our: 'none', note: 'Down payment — reference only' }),
  // (CX.TABLEFUNDER moved UP into the program section — it is compared now, not reference-only.)
  pull({ key: 'ref_cross_collateralized', encompassFieldId: 'CX.CROSSCOLLATERALIZEDFLAG', type: 'text', category: 'program', compare: 'reference', gate: GATE.REFERENCE, our: 'none', note: 'Cross-collateralized flag — reference only' }),
  pull({ key: 'ref_multi_property', encompassFieldId: 'CX.MULTIPROPERTYFLAG', type: 'text', category: 'program', compare: 'reference', gate: GATE.REFERENCE, our: 'none', note: 'Multi-property flag — reference only' }),

  // ── A/B-piece split — the THREE owner-supplied field ids (2026-08-18: "CX.BPIECESTRUCTURE
  // if this field has an x, it means that the field is checked. That means that this kind of
  // BP structure exists. CX.APIECE this is the dollar amount for the A peice and CX.BPIECE
  // this is for the B peice"). These are the Encompass side of the manual-program
  // A-piece/B-piece split PILOT records on applications.ab_piece_enabled / a_piece_amount
  // (db/579, src/lib/ab-piece.js).
  // REFERENCE on purpose, never compared by summarize(): a split exists only on MANUAL
  // files, so comparing THESE raw rows would read "no data to compare" on nearly every
  // file and hold term sheets everywhere (the funding_channel lesson — these tenant
  // values are verified:false, never read live yet). The real matching (owner-directed
  // 2026-08-18: "it should be added to this section in the Encompass syncing. Encompass
  // and PILOT need to match") is COMPUTED — reconcile.compareAbPiece emits match/mismatch
  // rows into the compared section ONLY where a split is recorded on some side, and the
  // A/B-piece card shows the same verdict (both call lib/ab-piece.js shapeEncompass, ONE
  // definition, reading these ids out of applications.encompass_extra._fieldValues).
  // NOTE those computed rows follow the section's match-all gate: a mismatch on a
  // split file HOLDS the term-sheet send and tape export until the two systems agree
  // or a super admin excepts the field — exactly "Encompass and PILOT need to match".
  // READ-ONLY like every row here — PILOT never writes these fields; a PILOT→Encompass
  // sync of the split needs its own pad entry in docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md
  // with the owner's written authorization, and does not exist today.
  pull({ key: 'ref_ab_piece_structure', encompassFieldId: 'CX.BPIECESTRUCTURE', type: 'text', category: 'program', compare: 'reference', gate: GATE.REFERENCE, verified: false, our: 'column:ab_piece_enabled (compared on the A/B-piece card, not here)', note: 'A/B-piece structure flag — an "x" means the loan is sold as an A-piece/B-piece structure. Reference only' }),
  pull({ key: 'ref_a_piece_amount', encompassFieldId: 'CX.APIECE', type: 'money', category: 'cost', compare: 'reference', gate: GATE.REFERENCE, verified: false, our: 'column:a_piece_amount (compared on the A/B-piece card, not here)', note: 'A-piece dollar amount — reference only' }),
  pull({ key: 'ref_b_piece_amount', encompassFieldId: 'CX.BPIECE', type: 'money', category: 'cost', compare: 'reference', gate: GATE.REFERENCE, verified: false, our: 'derived: current registration total loan − A-piece (compared on the A/B-piece card, not here)', note: 'B-piece dollar amount — reference only' }),
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
  // MIDDLE NAME + SUFFIX now have a real home (db/345, owner-directed 2026-07-27).
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
  // PHONE — Encompass carries THREE numbers per party (home / cell / work); our
  // ONE cell_phone matches ANY of them (owner-directed 2026-08-02: "one is home,
  // one is cell, one is work — any of them is good"). Std field ids: borrower home
  // 66, cell 1490, work 4533; co-borrower home 98, cell 1480, work 4534. Read
  // per-pair off the applications[] subtree so a SECOND borrower pair resolves to
  // its OWN numbers, not pair 1's.
  Object.freeze({ key: 'phone', our: 'borrowers.cell_phone', enc: 'applications[].{party}.homePhoneNumber / mobilePhone / workPhoneNumber', stdFieldId: { borrower: ['66', '1490', '4533'], coBorrower: ['98', '1480', '4534'] }, match: 'digitsEqualsAny', note: 'Home / cell / work — our one number matches any of the three' }),
  // EMAIL — the party's personal email (owner-directed 2026-08-02: borrower field
  // 1240, co-borrower field 1268 = emailAddressText). workEmailAddress is a
  // tolerant fallback for display/compare.
  Object.freeze({ key: 'email', our: 'borrowers.email', enc: 'applications[].{party}.emailAddressText', stdFieldId: { borrower: '1240', coBorrower: '1268' }, match: 'lowerEquals' }),
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
    // Owner-reported 2026-08-06: our side reads "EMCAP Financial", Encompass reads
    // "EMCAP" — the same buyer. "Financial" is a descriptive word, not a corporate
    // form the name-fallback strips, so both spellings are enumerated onto one token
    // (same pattern as "Fidelis" ≡ "Fidelis Investors" above).
    'emcap': 'emcap', 'em cap': 'emcap', 'emcap financial': 'emcap', 'em cap financial': 'emcap',
    'emcap financial llc': 'emcap',
    'rcn': 'rcn', 'rcn capital': 'rcn',
    'roc capital': 'roccapital', 'roc': 'roccapital', 'roc360': 'roccapital',
    'temple view capital': 'templeview', 'temple view': 'templeview', 'templeview': 'templeview',
    'other': 'other',
  },
  // CX.TABLEFUNDER ↔ closing_workflow.warehouse (owner-directed 2026-08-09: "look on
  // the channel in Encompass cx.tablefunder — if that says table funding, then it is
  // not going to have a PA date").
  //
  // THE FIELD IS READ IN BOTH OF THE TWO SHAPES IT COULD PLAUSIBLY HOLD, and that is
  // deliberate rather than lazy. The registry has carried this field since it was
  // written, described as a "table funder FLAG" — a Y/N — while the owner describes it
  // as a CHANNEL whose value literally reads "table funding". Both readings mean the
  // same thing about the loan, and it cannot be checked from here (Encompass is
  // read-only and there is no live tenant in this process), so the table recognizes
  // both and the rule below only ever acts on a POSITIVE reading. A value in neither
  // list maps to null — "we do not recognize this", never a guess (`verified:false` on
  // the entry says the same thing to a human).
  //
  // THE TWO DIRECT VALUES SHARE ONE TOKEN, and that is a correctness requirement rather
  // than a shortcut. OUR side of this comparison is the closer's WAREHOUSE pick, which
  // says only whether the loan funded on the Table Funding line — it cannot tell
  // delegated from TPR, because PILOT never records which. Giving those two their own
  // tokens would therefore make every correctly-configured direct file read as a
  // MISMATCH (ours 'direct' vs theirs 'direct_delegate') for a distinction our side is
  // structurally incapable of holding. The question this row asks is binary — was this
  // loan sold at the table, or is it still to be sold — and that is exactly what both
  // sides can answer. Encompass's exact wording is never lost: the panel shows the RAW
  // value beside the normalized one, so a human still sees "Direct RTL / w TPR".
  fundingChannel: {
    'table funding': 'table_funding', 'table funded': 'table_funding', 'tablefunding': 'table_funding',
    'table fund': 'table_funding', 'table-funding': 'table_funding', 'table funder': 'table_funding',
    'y': 'table_funding', 'yes': 'table_funding', 'true': 'table_funding', '1': 'table_funding',
    'n': 'direct', 'no': 'direct', 'false': 'direct', '0': 'direct',
    'direct rtl': 'direct', 'direct': 'direct',
    'direct rtl / delegate': 'direct', 'direct rtl/delegate': 'direct',
    'direct rtl delegate': 'direct', 'direct rtl - delegate': 'direct',
    'direct / delegate': 'direct', 'direct delegate': 'direct',
    'delegate': 'direct', 'delegated': 'direct',
    'direct rtl / w tpr': 'direct', 'direct rtl/w tpr': 'direct',
    'direct rtl w tpr': 'direct', 'direct rtl - w tpr': 'direct',
    'direct rtl / with tpr': 'direct', 'direct rtl with tpr': 'direct',
    'direct / w tpr': 'direct', 'direct w tpr': 'direct',
    'w tpr': 'direct', 'with tpr': 'direct', 'tpr': 'direct',
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
  // field 4008 ↔ derive(applications.llc_id → Officer; else Individual). An
  // entity-vested loan closes with the borrower signing as an authorized
  // officer/member of the entity, so Encompass may phrase it as officer / member /
  // manager / authorized signer — all normalize to 'officer'.
  vestingTitleRole: {
    'officer': 'officer', 'authorized officer': 'officer', 'auth officer': 'officer', 'authorized signer': 'officer',
    'managing member': 'officer', 'member': 'officer', 'manager': 'officer', 'entity': 'officer', 'llc': 'officer',
    'individual': 'individual', 'individuals': 'individual', 'person': 'individual', 'natural person': 'individual', 'borrower': 'individual',
  },
  // CX.PROPERTYTYPE (only — 1041 deliberately unread, owner-directed 2026-08-18)
  // ↔ applications.property_type (range category:
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
// A field flagged `skipBatch` is DELIBERATELY excluded: its value is resolved via
// customFields[] passthrough + loanPath in flattenLoan, NOT by number, because a
// fragile custom id in this batch can fail the WHOLE fieldReader call and blank
// every by-number field (the #1131 regression — see the funded_date entry).
function allFieldIds() { return REGISTRY.filter((e) => !e.skipBatch).map((e) => e.encompassFieldId).filter(Boolean); }

// Every STANDARD Encompass field id in IDENTITY_MAP, for BOTH the borrower and the
// co-borrower (owner-directed 2026-08-02, file YSCAP258134762). Handed to the
// fieldReader so borrower/co-borrower name, DOB, email, phone AND SSN can be read BY
// NUMBER — the same by-number read economics uses for 1859/388, applied at PARTY
// granularity: reconcile.compareIdentity uses these to RECOVER A WHOLE PARTY the stored
// applications[] subtree left out (it does not per-field re-heal a party already present).
// A snapshot pulled BEFORE the co-borrower was added, or one whose co-borrower name is at
// a non-standard path (so the party reads as unnamed and drops out), would otherwise leave
// every co-borrower field reading "no data to compare" and BLOCK-holding the term sheet —
// the identity subtree, unlike economics, had no by-number read and no self-heal.
// Derived from IDENTITY_MAP.stdFieldId so it can never drift from the map. The SSN ids
// (65/97) ARE included, but the raw value is HASHED + stripped in the impure reader
// layer (reader.scrubFieldValuesSsn) before anything is stored — plaintext SSN is never
// kept in encompass_extra, exactly as _scrubForStorage guarantees for the loan subtree.
function identityFieldIds() {
  const ids = [];
  for (const e of IDENTITY_MAP) {
    const s = e.stdFieldId;
    if (!s) continue;
    for (const slot of ['borrower', 'coBorrower']) {
      const v = s[slot];
      if (Array.isArray(v)) { for (const x of v) if (x != null && x !== '') ids.push(String(x)); }
      else if (v != null && v !== '') ids.push(String(v));
    }
  }
  return [...new Set(ids)];
}

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
      // REGISTRY-mapped ids ONLY (economics). `_fieldValues` now ALSO carries borrower/
      // co-borrower identity read by number (name/DOB/email/phone + the keyed-HMAC SSN +
      // the `_idRead` marker) for the missing-co-borrower recovery in
      // reconcile.compareIdentity — which reads `_fieldValues` DIRECTLY. Those keys must
      // never leak into the economics extract or the super-admin raw diagnostic, so
      // flattenLoan stays registry-only exactly as its header documents.
      if (!KNOWN_FIELD_IDS.has(id)) continue;
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
// Encompass stores the computed loan/cost figures (total loan, initial advance,
// financed rehab + reserve, total cost, effective purchase) as WHOLE DOLLARS — it
// cannot hold cents — while PILOT computes them to the cent and floors the loan
// breakdown per the frozen rounding rule. Two roundings of the SAME true amount can
// sit up to a WHOLE DOLLAR apart (PILOT floors 2,598,093.72 → 2,598,093 while
// Encompass rounds it to 2,598,094), so the tolerance is $1 INCLUSIVE — that is the
// widest a cents-rounding gap can ever be, and a real disagreement is ≥ $2 (loan
// figures never differ by cents for a real reason). Owner-reported 2026-08-06:
// "$2,598,093.72 vs $2,598,094 should come up as a match … Encompass cannot handle
// cents … the loan amount is rounded down anyway." Only the flagged loan/cost entries
// use it; every other money field stays exact-to-the-penny (a $1 gap on a purchase
// price is still a real mismatch).
const WHOLE_DOLLAR_TOL = 1;
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
    // A whole-dollar figure Encompass rounds off matches on a gap of up to $1
    // INCLUSIVE (the widest a cents-rounding difference can be); a >$1 gap still flags.
    if (kind === 'money' && e.wholeDollar) {
      base.status = Math.abs(a - b) <= WHOLE_DOLLAR_TOL + EPS ? 'match' : 'mismatch';
      return base;
    }
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
  PA_DATE_FIELD_ID,
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
  identityFieldIds,
  fieldReaderToMap,
  mapValue,
  compareField,
  // The Encompass date normalizer — tolerant of the fieldReader's MM/DD/YYYY
  // display format AND ISO. closing.readEncompassFundedDate uses it so a funded
  // date read out of Encompass reduces to a 'YYYY-MM-DD' the reconciliation gate
  // can compare (the plain closing.dayStr is ISO-only and would drop MM/DD/YYYY).
  normDate,
  _internals: { coerce, readField, getPath, num, normText, normName, normDate, normEntityName, normPartnerName, stripCorpForm, fieldReaderToMap, KNOWN_FIELD_IDS, MONEY_TOL, WHOLE_DOLLAR_TOL, PERCENT_TOL },
};

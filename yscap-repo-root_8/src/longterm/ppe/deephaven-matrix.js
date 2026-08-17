'use strict';
/**
 * LT PPE — LAYER 2: the INDEPENDENT eligibility engine for the Deephaven DSCR program, encoded from the
 * OFFICIAL published product matrix (docs/longterm/ppe-research/matrices/deephaven-dscr-matrix.json,
 * Deephaven Correspondent Flow, effective 08/04/26).
 *
 * WHY THIS IS A SEPARATE MODULE FROM deephaven-dscr-sheet.js (owner HARD RULE 2026-08-17): the
 * eligibility ENVELOPE in deephaven-dscr-sheet.js was reverse-engineered from Lender Price's OWN
 * disqualify reasons — so it can NEVER catch a Lender Price mistake, because it always agrees with LP.
 * This module is sourced ONLY from the published matrix, so when LP and the matrix disagree the
 * disagreement is real signal (→ a probable LP bug to raise, or a probable encoding bug to fix). It MUST
 * NOT import deephaven-dscr-sheet.js's eligibility block — the whole point is independence.
 *
 * THE THREE DOTS (owner 2026-08-17): every program needs three connected layers keyed by the investor —
 * (1) the RATE SHEET (pricing: base + LLPAs, deephaven-dscr-sheet.js), (2) this ELIGIBILITY matrix, and
 * (3) the PPP state matrix (deephaven-ppp-matrix.js). This is dot #2.
 *
 * FACT VOCABULARY (the engine's, from lp-agreement-legs.lpScenarioToFacts) — the ONLY inputs:
 *   fico RAW · ltv MILLI-percent (80% → 80000) · dscr MILLI (1.00 → 1000) · loan_amount RAW dollars ·
 *   cashout_amount RAW dollars · purpose 'purchase'|'refinance'|'cashout' · property_type string ·
 *   units number · state 2-letter · interest_only boolean.
 * A fact that is missing yields an UNKNOWN result for the rule that needs it — an eligibility decline
 * never fires on an absent fact (fail-safe: we never disqualify a loan on data we do not have).
 *
 * evaluateEligibility(facts) → { eligible, reasons:[{code, dimension, declineReason, citation}],
 *   maxLtvMilli, cell, unverifiable:[{overlay, needs}] }.
 *
 * LT-only. Pure: no DB, no network, no clock. No RTL imports.
 */

const CITE = 'Deephaven Corr Flow DSCR matrix, eff 08/04/26';

// ---- Program parameters (matrix "Program Parameters / Limits") ----------------------------------
const MIN_LOAN_DSCR_GE1 = 75000;   // Minimum Loan Amount (DSCR >= 1.00x)
const MIN_LOAN_DSCR_LT1 = 200000;  // Minimum Loan Amount (DSCR < 1.00x)
const MAX_LOAN = 2500000;          // Maximum Loan Amount
const MAX_CASHOUT_LTV_LE65 = 1000000; // Maximum Cash Out | LTV <= 65%
const MAX_CASHOUT_LTV_GT65 = 500000;  // Maximum Cash Out | LTV > 65%
const MIN_DSCR = 750;              // DSCR < 1.00 → Minimum DSCR 0.75x (milli)
const SMALL_LOAN_THRESHOLD = 125000; // Loan < $125,000 → Max LTV 75%
const SMALL_LOAN_CAP_MILLI = 75000;

// ---- The Max-LTV GRID (matrix "Eligibility Matrix"): loan tier × FICO floor × purpose × DSCR band ---
// Caps are PERCENT (×1000 → milli at read time). null = N/A cell (ineligible at any LTV). FICO floors
// are DESCENDING — a score uses the highest floor it meets; below the lowest floor in a tier = ineligible.
// Tiers are half-open by dollar: T1 loan<=1.5M, T2 1.5M<loan<=2.0M, T3 2.0M<loan<=2.5M.
const GRID = [
  { maxLoan: 1500000, minLoanExclusive: null, minFico: 640, rows: [
    { fico: 720, P_RT_ge1: 80, CO_ge1: 80, P_RT_lt1: 75, CO_lt1: 70 },
    { fico: 700, P_RT_ge1: 80, CO_ge1: 75, P_RT_lt1: 75, CO_lt1: 65 },
    { fico: 680, P_RT_ge1: 75, CO_ge1: 75, P_RT_lt1: 70, CO_lt1: 65 },
    { fico: 640, P_RT_ge1: 70, CO_ge1: 70, P_RT_lt1: null, CO_lt1: null },
  ] },
  { maxLoan: 2000000, minLoanExclusive: 1500000, minFico: 660, rows: [
    { fico: 700, P_RT_ge1: 80, CO_ge1: 75, P_RT_lt1: 70, CO_lt1: 65 },
    { fico: 680, P_RT_ge1: 75, CO_ge1: 75, P_RT_lt1: 65, CO_lt1: 65 },
    { fico: 660, P_RT_ge1: 65, CO_ge1: 65, P_RT_lt1: null, CO_lt1: null },
  ] },
  { maxLoan: 2500000, minLoanExclusive: 2000000, minFico: 660, rows: [
    { fico: 700, P_RT_ge1: 70, CO_ge1: 70, P_RT_lt1: 60, CO_lt1: 60 },
    { fico: 660, P_RT_ge1: 65, CO_ge1: 65, P_RT_lt1: null, CO_lt1: null },
  ] },
];

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
const purposeClass = (purpose) => (String(purpose || '').toLowerCase() === 'cashout' ? 'CO' : 'P_RT');
const dscrBandKey = (dscrMilli) => (dscrMilli >= 1000 ? 'ge1' : 'lt1');

/**
 * Resolve the Max-LTV grid CELL for a scenario. Returns a status the caller turns into decline reasons:
 *   {status:'unknown'}            — a required fact (loan/fico/dscr) is missing; cannot judge.
 *   {status:'over_max_loan'}      — loan > $2.5MM.
 *   {status:'below_min_fico', minFico, tierMax} — FICO below the tier's lowest floor.
 *   {status:'na_cell', cell}      — the (tier,fico,purpose,band) cell is N/A (ineligible).
 *   {status:'priced', capMilli, cell} — a real max-LTV cap for this cell.
 */
function gridCell(facts) {
  const loan = facts.loan_amount, fico = facts.fico, dscr = facts.dscr;
  if (!isNum(loan) || !isNum(fico) || !isNum(dscr)) return { status: 'unknown' };
  if (loan > MAX_LOAN) return { status: 'over_max_loan' };
  const tier = GRID.find((t) => loan <= t.maxLoan && (t.minLoanExclusive == null || loan > t.minLoanExclusive));
  if (!tier) return { status: 'unknown' }; // below every tier's floor is impossible (min loan handled separately)
  const row = tier.rows.find((r) => fico >= r.fico); // rows descending → highest floor met
  if (!row) return { status: 'below_min_fico', minFico: tier.minFico, tierMax: tier.maxLoan };
  const pc = purposeClass(facts.purpose);
  const band = dscrBandKey(dscr);
  const cap = row[`${pc}_${band}`];
  const cell = { tierMax: tier.maxLoan, ficoFloor: row.fico, purposeClass: pc, dscrBand: band };
  if (cap == null) return { status: 'na_cell', cell };
  return { status: 'priced', capMilli: cap * 1000, cell };
}

/**
 * The full Layer-2 eligibility verdict for a scenario (engine facts). PURE.
 */
function evaluateEligibility(facts) {
  const f = facts || {};
  const reasons = [];
  const add = (code, dimension, declineReason, detail) => reasons.push({ code, dimension, declineReason, citation: `${CITE} — ${detail}` });
  const dscr = f.dscr, loan = f.loan_amount, ltv = f.ltv;

  // --- program envelope -------------------------------------------------------------------------
  if (isNum(loan) && loan > MAX_LOAN) add('dhvn_max_loan', 'loan_amount', 'Maximum Loan Amount $2.5MM', 'Program Parameters, maxLoan = $2,500,000');
  if (isNum(dscr) && isNum(loan)) {
    if (dscr >= 1000 && loan < MIN_LOAN_DSCR_GE1) add('dhvn_min_loan_ge1', 'loan_amount', 'Minimum Loan Amount $75,000 (DSCR >= 1.00x)', 'Program Parameters, minLoanDscrGe1 = $75,000');
    if (dscr < 1000 && loan < MIN_LOAN_DSCR_LT1) add('dhvn_min_loan_lt1', 'loan_amount', 'Minimum Loan Amount $200,000 (DSCR < 1.00x)', 'Program Parameters, minLoanDscrLt1 = $200,000');
  }
  if (isNum(dscr) && dscr < MIN_DSCR) add('dhvn_min_dscr', 'dscr', 'Minimum DSCR 0.75x', 'DSCR floor 0.75x');

  // --- the Max-LTV grid -------------------------------------------------------------------------
  const cell = gridCell(f);
  let maxLtvMilli = null;
  if (cell.status === 'below_min_fico') add('dhvn_min_fico_tier', 'fico', `Min FICO ${cell.minFico} (loan tier <= $${(cell.tierMax / 1e6)}MM)`, `Eligibility grid, tier <=$${cell.tierMax} minimum FICO ${cell.minFico}`);
  else if (cell.status === 'na_cell') add('dhvn_grid_na', 'fico_ltv_dscr', `Not eligible (tier <=$${(cell.cell.tierMax / 1e6)}MM, FICO ${cell.cell.ficoFloor}+, ${cell.cell.purposeClass === 'CO' ? 'Cash-Out' : 'Purchase/R&T'}, DSCR ${cell.cell.dscrBand === 'ge1' ? '>=1.00' : '<1.00'})`, 'Eligibility grid, N/A cell');
  else if (cell.status === 'priced') {
    maxLtvMilli = cell.capMilli;
    if (isNum(ltv) && ltv > cell.capMilli) add('dhvn_grid_ltv', 'ltv', `Max LTV ${cell.capMilli / 1000}% (tier <=$${(cell.cell.tierMax / 1e6)}MM, FICO ${cell.cell.ficoFloor}+, ${cell.cell.purposeClass === 'CO' ? 'Cash-Out' : 'Purchase/R&T'}, DSCR ${cell.cell.dscrBand === 'ge1' ? '>=1.00' : '<1.00'})`, `Eligibility grid cell cap ${cell.capMilli / 1000}%`);
  }

  // --- cash-out amount caps ---------------------------------------------------------------------
  if (purposeClass(f.purpose) === 'CO' && isNum(f.cashout_amount) && isNum(ltv)) {
    if (ltv <= 65000 && f.cashout_amount > MAX_CASHOUT_LTV_LE65) add('dhvn_cashout_le65', 'cashout_amount', 'Max Cash-Out $1,000,000 (LTV <= 65%)', 'Program Parameters, maxCashOut LTV<=65% = $1,000,000');
    if (ltv > 65000 && f.cashout_amount > MAX_CASHOUT_LTV_GT65) add('dhvn_cashout_gt65', 'cashout_amount', 'Max Cash-Out $500,000 (LTV > 65%)', 'Program Parameters, maxCashOut LTV>65% = $500,000');
  }

  // --- small-loan LTV reduction (<$125k → 75% max) ----------------------------------------------
  if (isNum(loan) && loan < SMALL_LOAN_THRESHOLD && isNum(ltv) && ltv > SMALL_LOAN_CAP_MILLI) {
    add('dhvn_small_loan_ltv', 'ltv', 'Loan < $125,000: Max LTV 75%', 'Overlay: small-loan LTV reduction');
    if (maxLtvMilli == null || SMALL_LOAN_CAP_MILLI < maxLtvMilli) maxLtvMilli = SMALL_LOAN_CAP_MILLI;
  }

  // --- interest-only overlay (Max LTV 80%, Min DSCR 1.00) ---------------------------------------
  if (f.interest_only === true) {
    if (isNum(ltv) && ltv > 80000) add('dhvn_io_max_ltv', 'ltv', 'Interest-Only: Max LTV 80%', 'Overlay: Interest Only');
    if (isNum(dscr) && dscr < 1000) add('dhvn_io_min_dscr', 'dscr', 'Interest-Only: Min DSCR 1.00x', 'Overlay: Interest Only');
  }

  // --- property-type eligibility ----------------------------------------------------------------
  // Row homes ineligible; Condos & Non-Warrantable Condos capped at 80% LTV (already <= global, kept
  // for fidelity). Matched on the LP property_type vocabulary; an unrecognized value no-ops (fail-safe).
  const pt = String(f.property_type || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/rowhome|rowhouse/.test(pt)) add('dhvn_row_home', 'property_type', 'Row Homes ineligible', 'Property Types: Row Homes Ineligible');
  if (/condo/.test(pt) && isNum(ltv) && ltv > 80000) add('dhvn_condo_max_ltv', 'property_type', 'Condos & Non-Warrantable Condos: Max 80% LTV', 'Property Types: Condo max 80% LTV');

  // --- overlays we CANNOT verify (facts not carried) — flagged, never guessed, never a decline ---
  const unverifiable = [];
  const flag = (overlay, needs) => unverifiable.push({ overlay, needs });
  flag('Declining market: Max LTV -5%', 'declining_market fact (appraisal-driven)');
  flag('Short-Term Rental: Min DSCR 1.15, Min FICO 720, -5% LTV (75% max)', 'short_term_rental fact');
  flag('First-Time Investor: Min DSCR 1.00, Min FICO 700, long-term rental only', 'first_time_investor fact');
  flag('Foreign National: max loan $1.5M, caps 70/60, DSCR >= 1.00 only', 'foreign_national fact');
  flag('Philadelphia, PA: Max LTV -10%', 'city fact (state alone is insufficient)');
  flag('Ineligible geos: HI lava zones 1&2; Baltimore City, MD', 'sub-state city / lava-zone fact');

  return { eligible: reasons.length === 0, reasons, maxLtvMilli, cell: cell.status === 'priced' ? cell.cell : null, gridStatus: cell.status, unverifiable };
}

// The matrix tables this engine encodes, exported so a test can prove they reproduce the decoded JSON.
const MATRIX = {
  MIN_LOAN_DSCR_GE1, MIN_LOAN_DSCR_LT1, MAX_LOAN, MAX_CASHOUT_LTV_LE65, MAX_CASHOUT_LTV_GT65,
  MIN_DSCR, SMALL_LOAN_THRESHOLD, GRID,
};

module.exports = { evaluateEligibility, gridCell, MATRIX, _internals: { purposeClass, dscrBandKey } };

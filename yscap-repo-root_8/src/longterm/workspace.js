'use strict';
/**
 * LONG-TERM — the loan workspace: one file, in three regions.
 *
 * The plan's §4.2, and the shape is copied deliberately from the reference portal
 * because it is the one structural pattern that survives contact with a real file:
 *
 *   · a MILESTONE STEPPER pinned above the content, each node carrying a completion
 *     date or a not-yet-reached mark, so a stalled file reads as stalled without a
 *     word of text;
 *   · a LEFT SECTION MENU that is RULES-DRIVEN, not hard-coded;
 *   · a persistent SUMMARY RAIL fed by ONE selector mounted once, so it does not
 *     re-render as somebody moves between sections.
 *
 * A SECTION THAT DOES NOT APPLY IS GREYED WITH A REASON — never hidden.
 *
 *   Employment is the case that proves it: `lt_loans.employment_applies` defaults
 *   false and is true on about 2% of the live book, because a DSCR loan qualifies on
 *   the property's rent rather than on a job. Hiding the section would leave a
 *   reader wondering whether the file is incomplete or the section does not exist;
 *   greying it with "a DSCR loan qualifies on the property's income" answers the
 *   question before it is asked. Every `available:false` section therefore carries a
 *   `why`, and a section with no reason is a bug — the test asserts it.
 *
 * WHAT THE RAIL WILL NEVER CARRY: the investor. The reference portal can show a
 * counterparty freely because their user IS the broker; ours cannot, and
 * AUDIENCE-RULES.md outranks any layout. `audience.js` is the ONE definition of that
 * rule — this module never re-implements it, it just never selects the column.
 *
 * PURE. Every function is handed its rows, so the whole layout decision is testable
 * with no database.
 */

const stages = require('./stages');

/**
 * The URLA-sectioned file, in the order a person reads it. `applies` decides
 * whether a section is live or greyed; it is a FUNCTION of the loan, never a
 * hard-coded list, so a section becomes available the moment the data says so.
 */
const SECTIONS = [
  { key: 'summary', label: 'Loan summary' },
  { key: 'borrowers', label: 'Borrowers' },
  { key: 'property', label: 'Property' },
  { key: 'terms', label: 'Loan terms' },
  {
    key: 'income',
    label: 'Income & DSCR',
    applies: (l) => l.product_kind !== 'dscr' || l.dscr_ratio != null || l.gross_rent != null,
    why: 'The rent and DSCR have not been read from Encompass yet.',
  },
  {
    key: 'employment',
    label: 'Employment',
    applies: (l) => l.employment_applies === true,
    why: 'A DSCR loan qualifies on the property’s income, not on a job, so this file has no employment section.',
  },
  { key: 'assets', label: 'Assets & liabilities' },
  { key: 'reo', label: 'REO schedule' },
  { key: 'declarations', label: 'Declarations' },
  { key: 'contacts', label: 'Who is on this file' },
  {
    key: 'conditions',
    label: 'Conditions',
    // Set aside by the owner on 2026-08-14. Greyed rather than hidden, for the same
    // reason as employment: somebody told about it must not think it vanished.
    applies: (l, opts) => opts.conditionsEnabled === true,
    why: 'The Condition Center is coming soon.',
  },
  {
    key: 'lock',
    label: 'Rate lock',
    applies: (l) => !!l.lock_status,
    why: 'This loan has no lock recorded in Encompass yet.',
  },
];

/** The left menu: every section, each either live or greyed WITH a reason. */
function sectionMenu(loan, opts = {}) {
  const l = loan || {};
  return SECTIONS.map((s) => {
    const available = s.applies ? !!s.applies(l, opts) : true;
    return {
      key: s.key,
      label: s.label,
      available,
      // A greyed section without a reason is a dead end. Never emit one.
      why: available ? null : (s.why || 'This section does not apply to this file.'),
    };
  });
}

/**
 * The stepper. Every milestone the tenant has, in order, each marked reached or not,
 * with the CURRENT one flagged.
 *
 * `reached` is positional, not a stored flag: Encompass tells us the milestone a loan
 * sits AT, and everything before it in the catalog has necessarily been passed. A
 * milestone the catalog does not carry (a tenant added one today) leaves `currentIndex`
 * at -1, and NOTHING is marked reached — inventing progress from an unknown position
 * is worse than showing none.
 */
function milestoneStepper(loan, catalog = []) {
  const current = stages.normalizeMilestone((loan || {}).milestone_name);
  const ordered = (catalog || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const currentIndex = ordered.findIndex((m) => stages.normalizeMilestone(m.name) === current);

  return {
    currentIndex,
    currentName: (loan || {}).milestone_name || null,
    // True only when the loan names a milestone the catalog does not carry — the
    // screen says "we do not recognise this milestone" rather than drawing nothing.
    unrecognised: !!current && currentIndex === -1,
    steps: ordered.map((m, i) => ({
      name: m.name,
      reached: currentIndex >= 0 && i <= currentIndex,
      current: i === currentIndex,
      completedAt: m.completed_at || null,
    })),
  };
}

/**
 * The Summary rail — the exact list the plan names, and nothing else.
 *
 * Assembled from the loan row ALONE (plus the borrower's name), which is what lets a
 * screen mount it once and not re-render it while somebody moves between sections.
 *
 * THE INVESTOR IS ABSENT BY CONSTRUCTION. There is no investor field selected here
 * and no branch that could add one; `audience.js` remains the one definition of that
 * rule for anything that formats free text.
 */
function summaryRail(loan, opts = {}) {
  const l = loan || {};
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const stage = stages.stageForMilestone(l.milestone_name, opts.stageConfig || {});

  return {
    loanNumber: l.loan_number || null,
    borrower: l.borrower_name || null,
    purpose: l.loan_purpose || null,
    occupancy: l.occupancy || null,
    loanAmount: num(l.loan_amount),
    propertyValue: num(l.appraised_value != null ? l.appraised_value : l.property_value),
    ltv: num(l.ltv_pct),
    dscr: num(l.dscr_ratio),
    grossRent: num(l.gross_rent),
    housingExpense: num(l.housing_expense_total),
    noteRate: num(l.note_rate_pct),
    termMonths: l.term_months == null ? null : Number(l.term_months),
    interestOnlyMonths: l.interest_only_months == null ? null : Number(l.interest_only_months),
    prepaymentPenaltyMonths: l.prepayment_penalty_months == null ? null : Number(l.prepayment_penalty_months),
    program: l.program_name || null,
    milestone: l.milestone_name || null,
    stage: { key: stage.key, label: stage.label, mapped: stage.mapped },
    lockStatus: l.lock_status || null,
    lockExpiration: l.lock_expiration_date || null,
    // How fresh this is. A rail that shows figures without saying when they were read
    // invites somebody to trust a month-old number.
    syncedAt: l.encompass_synced_at || null,
    syncError: l.encompass_sync_error || null,
  };
}

module.exports = {
  SECTIONS,
  sectionMenu,
  milestoneStepper,
  summaryRail,
};

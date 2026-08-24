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
const { num } = require('./num');

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
    // The rent lives on the PROPERTY and the DSCR on the loan, so this section is
    // the one whose availability cannot be read off the loan row alone. It is
    // decided from the SAME `income` block the rail renders (passed in by the
    // caller), so the menu and the figures can never disagree about whether this
    // loan has any. An earlier cut tested `l.gross_rent` — a column that does not
    // exist on lt_loans — which reads as undefined, greys the section on a DSCR
    // file whose rent we DO hold, and states a reason that is not true.
    label: 'Income & DSCR',
    applies: (l, o) => l.product_kind !== 'dscr' || l.dscr_ratio != null || hasIncomeFigures(o.income),
    why: 'No rent, housing expense or DSCR has been read from Encompass for this loan yet.',
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
    // Greyed rather than hidden, for the same reason as employment: somebody told
    // about it must not think it vanished. The reason names the SWITCH rather than
    // a date — the centre is built, so the answer is "turn it on", not "wait".
    applies: (l, opts) => opts.conditionsEnabled === true,
    why: 'The Condition Center is switched off for this company. It is built — turning it on is a settings change, not a new release.',
  },
  {
    key: 'investor',
    label: 'Who bought this loan',
    // Every Encompass condition in this tenant sits on a loan that is already
    // sold, so "who is this with?" is asked on almost every file. Greyed until
    // Encompass names somebody, because a heading over nothing reads as a loan
    // nobody has sold rather than as one we cannot see the buyer of.
    applies: (l, o) => !!(o.investor && o.investor.recorded),
    why: 'Encompass names no investor on this loan yet — either it has not been sold, or the investor has not been recorded on the file.',
  },
  {
    key: 'lock',
    label: 'Rate lock',
    applies: (l) => !!l.lock_status,
    why: 'This loan has no lock recorded in Encompass yet.',
  },
  {
    // ALWAYS available, even unlinked — an unlinked file is exactly where the
    // section's Create / Link controls live (owner-directed 2026-08-23: every
    // automatic sync feature gets its manual option on the file). The section's
    // data comes from /api/lt/clickup/loans/:id; this row only puts it on the
    // menu. Staff-only by construction — the workspace IS the staff screen.
    key: 'clickup',
    label: 'ClickUp syncing',
  },
];

/**
 * Does this loan hold ANY of the three figures the income section shows?
 *
 * Deliberately generous — a section is worth opening for one of them. `actual`
 * rent is knowingly never filled (application/unsourced.js) and is read anyway, so
 * this needs no edit on the day it gains a source.
 */
function hasIncomeFigures(income) {
  const i = income || {};
  return i.dscr != null || i.grossMonthlyRent != null
    || i.actualMonthlyRent != null || i.housingExpenseTotal != null;
}

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
 *
 * WITH ONE EXCEPTION, AND IT IS DELIBERATE. A step marked `pilot` is OURS rather than
 * Encompass's, and it is reached from a FACT the caller passes in, never from where
 * the loan stands. Today that is the PURCHASED step: a loan at Final Docs has
 * certainly passed Purchasing Conditions and has NOT certainly been bought, so
 * positional reachedness would state the one thing that step exists to state, wrongly,
 * on exactly the files that matter. See `milestone-purchased.js`.
 */
function milestoneStepper(loan, catalog = [], opts = {}) {
  const current = stages.normalizeMilestone((loan || {}).milestone_name);
  const ordered = (catalog || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  // A PILOT step is never the loan's CURRENT milestone — Encompass names that, and
  // Encompass has never heard of our step. Excluding it from the match also stops a
  // tenant that happens to name a milestone "Purchased" from resolving to ours.
  const currentIndex = ordered.findIndex((m) => !m.pilot && stages.normalizeMilestone(m.name) === current);

  return {
    currentIndex,
    currentName: (loan || {}).milestone_name || null,
    // True only when the loan names a milestone the catalog does not carry — the
    // screen says "we do not recognise this milestone" rather than drawing nothing.
    unrecognised: !!current && currentIndex === -1,
    // `reachedAt` is a date PILOT WATCHED this loan arrive at that milestone, from
    // `lt_milestone_events` (db/554) — passed in by the caller, never read off the
    // catalog row. This used to be `m.completed_at`, a column that does not exist:
    // the rows here come from `lt_encompass_milestones`, the tenant's GLOBAL catalog
    // of milestone names, which has no per-loan row and no completion date at all.
    // So the field was null on every step of every loan, silently, forever.
    //
    // Encompass's own completion dates are unreadable on this tenant (the milestone
    // log answers 403), so a step we did not witness has NO date — never a guess, and
    // never the day we first noticed the loan sitting there.
    // A PILOT STEP IS REACHED FROM A FACT, NEVER FROM A POSITION — and that
    // distinction is the whole reason it exists. Positional reachedness says "the
    // loan is standing past this, so it happened", which is sound for a workflow
    // step and FALSE for the purchase: a loan at Final Docs has certainly passed
    // Purchasing Conditions and has NOT certainly been bought. So `opts.pilotReached`
    // decides, and its THREE answers survive to the screen: true, false, and
    // `undefined` for "Encompass has not said" — which draws as not-yet with a
    // sentence, never as a no.
    steps: ordered.map((m, i) => {
      const pilot = !!m.pilot;
      const fact = pilot ? (opts.pilotReached || {})[m.milestoneId] : undefined;
      return {
        name: m.name,
        pilot,
        reached: pilot ? fact === true : (currentIndex >= 0 && i <= currentIndex),
        // Only when we asked and were told nothing. A `false` is an answer.
        unknown: pilot ? (fact !== true && fact !== false) : false,
        // Ours is a fact about the loan, not a place it stands, so it is never
        // "current" however far along the file is.
        current: !pilot && i === currentIndex,
        note: pilot ? ((opts.pilotNotes || {})[m.milestoneId] || null) : null,
        reachedAt: pilot
          ? ((opts.pilotReachedAt || {})[m.milestoneId] || null)
          : ((opts.reachedAt || {})[String(m.name || '').trim().toLowerCase()] || null),
      };
    }),
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
  const stage = stages.stageForMilestone(l.milestone_name, opts.stageConfig || {});

  // THE PROPERTY FIGURES COME FROM THE PROPERTY, NOT FROM THE LOAN ROW.
  //
  // `appraised_value`, `ltv_pct`, `occupancy` and the rent live on `lt_properties`
  // (db/549); `lt_loans` has none of them, so reading them off the loan row answered
  // null on EVERY loan, silently and forever — the rail said "Property value —" on a
  // file whose Property section was showing $400,000 two clicks away. Two answers to
  // one question on two screens is worse than one answer we did not derive, so the
  // caller passes the SAME sections the Property tab renders (`file.js`) and the two
  // cannot disagree. Absent, the rows are honestly empty rather than wrong.
  const p = opts.property || {};
  const inc = opts.income || {};

  return {
    loanNumber: l.loan_number || null,
    borrower: l.borrower_name || null,
    purpose: l.loan_purpose || null,
    occupancy: p.occupancy || null,
    loanAmount: num(l.loan_amount),
    propertyValue: num(p.appraisedValue != null ? p.appraisedValue : p.estimatedValue),
    ltv: num(p.ltvPct),
    dscr: num(l.dscr_ratio),
    grossRent: num(inc.grossMonthlyRent != null ? inc.grossMonthlyRent : inc.actualMonthlyRent),
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
  hasIncomeFigures,
  SECTIONS,
  sectionMenu,
  milestoneStepper,
  summaryRail,
};

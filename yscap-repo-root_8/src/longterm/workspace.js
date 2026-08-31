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
const readState = require('./read-state');
const { num } = require('./num');

/**
 * The URLA-sectioned file, in the order a person reads it. `applies` decides
 * whether a section is live or greyed; it is a FUNCTION of the loan, never a
 * hard-coded list, so a section becomes available the moment the data says so.
 */
const SECTIONS = [
  { key: 'summary', label: 'Loan summary' },
  {
    // EVERY milestone, with Encompass's own date and associate on each step
    // (owner-directed 2026-08-23: a Milestones section right after the
    // overview — "outside of the file overview, it needs to be only the most
    // important milestones", which is what the seven-stop header bar carries;
    // the FULL ladder lives here). Always available: an unread ladder is a
    // fact the section states, not a reason to grey it.
    key: 'milestones',
    label: 'Milestones',
  },
  {
    // HOW LONG EACH PART TOOK, on this one file (owner-directed 2026-08-30: "for
    // every file how long it took between which and which step and who the
    // processor was in that file"). It sits directly under Milestones because it
    // is the same ladder read a second way — the steps above, the time between
    // them here.
    //
    // ALWAYS AVAILABLE, and that is the point. A file PILOT has not witnessed a
    // step on is exactly the file somebody needs this section to explain: it says
    // WHY each span is unknown rather than leaving a blank the reader has to guess
    // at. Greying it out on such a file would be backwards.
    key: 'timing',
    label: 'How long it took',
  },
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
    // OUR OWN conditions — what this file needs to get submitted, cleared to
    // close, docked, funded and sold (owner-directed 2026-08-30). It sits ABOVE
    // the Encompass mirror below because it is the work an officer is doing
    // TODAY; the mirror is what an investor's underwriter raised after the loan
    // was already sold.
    //
    // ALWAYS AVAILABLE. A file with no conditions worked out yet is exactly the
    // one somebody opens this to fix — the section carries the button that runs
    // the rules against it, so greying it would hide the only way forward.
    key: 'file_conditions',
    label: 'Conditions',
  },
  {
    /* THE FILE'S CONTACTS — who is on this closing.
       Owner-directed 2026-08-31: *"we added a section, especially for file
       contacts where you can enter random file contacts and then the required
       file contact comes up as conditions."* It sits directly ABOVE Orders
       because it is what makes an order sendable: `orders/data.blockers`
       refuses an order whose vendor kind is not on the loan, so a file with an
       empty contacts desk is a file whose every order is blocked.

       ALWAYS AVAILABLE, for the same reason the two sections below it are: a
       loan with no contacts yet is precisely the one somebody opens this to
       fix. */
    key: 'file_contacts',
    label: 'File contacts',
  },
  {
    // THE ORDERS DESK — every vendor this file has to ask for something, with the
    // whole conversation on the card.
    //
    // ALWAYS AVAILABLE, for the condition centre's reason: a file with no vendor on
    // it yet is exactly the one somebody opens this to fix, and greying it would
    // hide the only way forward. What each order needs before it can go is said on
    // the order itself, in words, rather than by the section refusing to open.
    key: 'orders',
    label: 'Orders',
  },
  {
    /* THE VERIFICATION OF RENT. Its own section rather than a card inside Orders,
       for one reason: it is a FORM WE BUILD and a signature request, not a letter to
       a vendor — it has a form to edit, a document to look at, an envelope out for
       signature and a return to record, and folding all of that into an order card
       would bury the one thing a processor comes here to do.

       ALWAYS AVAILABLE, for the same reason as Orders: a file with no landlord on it
       is exactly the one somebody opens this to fix. What is missing is said on the
       form, in words. */
    key: 'vor',
    label: 'Verification of rent',
  },
  {
    key: 'conditions',
    label: 'Investor conditions (Encompass)',
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
  {
    // ALWAYS available, for the same reason its ClickUp twin is — and more so.
    // This section exists to explain why a file looks empty (owner-directed
    // 2026-08-25: "see what it read and what it didn't read"), so greying it out
    // on a file that has not been read is exactly backwards: that file is the one
    // somebody most needs it for. Its data comes from
    // /api/lt/encompass-file/loans/:id; this row only puts it on the menu.
    key: 'encompass',
    label: 'Encompass syncing',
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
  // Punctuation-blind (audit round 2, obs 4): a loan standing at "Cond Approval"
  // must land on the catalog's "Cond. Approval" row.
  const current = stages.milestoneKey((loan || {}).milestone_name);
  const ordered = (catalog || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  // A PILOT step is never the loan's CURRENT milestone — Encompass names that, and
  // Encompass has never heard of our step. Excluding it from the match also stops a
  // tenant that happens to name a milestone "Purchased" from resolving to ours.
  const currentIndex = ordered.findIndex((m) => !m.pilot && stages.milestoneKey(m.name) === current);
  const witnessedByKey = {};
  // FIRST WINS on a key collision: `reachedAtByMilestone` inserts newest-first,
  // so a plain assignment would let an older spelling of the same milestone
  // overwrite the NEWEST witnessed day with an older one.
  for (const [k, v] of Object.entries(opts.reachedAt || {})) {
    const kk = stages.milestoneKey(k);
    if (!(kk in witnessedByKey)) witnessedByKey[kk] = v;
  }

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
          : (witnessedByKey[stages.milestoneKey(m.name)] || null),
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
    // THE STATUS THE FILE WEARS (owner-directed 2026-08-24): the last COMPLETED
    // milestone in its completed wording — "Funded", never "Funding". The raw
    // Encompass name stays in `milestone` for anything that joins on it.
    milestoneLabel: stages.completedFormLabel(l.milestone_name),
    stage: { key: stage.key, label: stage.label, mapped: stage.mapped },
    lockStatus: l.lock_status || null,
    lockExpiration: l.lock_expiration_date || null,
    // How fresh this is. A rail that shows figures without saying when they were read
    // invites somebody to trust a month-old number.
    syncedAt: l.encompass_synced_at || null,
    syncError: l.encompass_sync_error || null,
    // WHICH OF THE TWO STEPS THIS LOAN IS AT. A discovered-but-unread loan is a
    // real row with only the pipeline search's fields on it, and the rail used to
    // render that as "Read from Encompass —" — a dash where a date belongs, which
    // reads as a formatting glitch rather than as the answer. ONE definition, so
    // the pipeline, this rail and the sync screen cannot disagree.
    readState: readState.readStateOf(l).state,
    readWhy: readState.readStateOf(l).why,
  };
}

/**
 * THE SEVEN STOPS (owner-directed 2026-08-23, the approved "meridian" design):
 * the file header's progress bar carries ONLY the most important milestones —
 * the owner's exact list, verbatim: *"Started, Assigned to processor,
 * Submitted to underwrting, Conditionally approved, Clear to close, Closed,
 * purchased. That's it."* Rejected by name: any "not funding" wording, and
 * Investor Delivery on the bar. The full ladder lives in the Milestones
 * section; this is the at-a-glance answer.
 *
 * KEYED ON THE LADDER'S DONE FLAGS (#33: a completed milestone means the work
 * up to that stop has happened) — never MS.STATUS prose, never position. Each
 * stop names the milestone spellings whose COMPLETION means the stop is
 * reached; the date shown is Encompass's own `start_date` for that step (the
 * worked date), falling back to the day PILOT watched it flip. PURCHASED is
 * the pilot FACT — describePurchase's answer — with its three states kept:
 * bought, not bought, and "Encompass has not said".
 */
const SEVEN_STOPS = [
  { key: 'started', label: 'Started', milestones: ['started'] },
  { key: 'processor', label: 'Assigned to processor', milestones: ['lo prep'] },
  { key: 'underwriting', label: 'Submitted to underwriting', milestones: ['submittal', 'submitted'] },
  { key: 'cond_approved', label: 'Conditionally approved', milestones: ['cond approval', 'conditional approval'] },
  { key: 'ctc', label: 'Clear to close', milestones: ['clear to close', 'ctc'] },
  { key: 'closed', label: 'Closed', milestones: ['funding', 'funded', 'closed'] },
  { key: 'purchased', label: 'Purchased', pilot: true },
];

function sevenStops(ladder, { reachedAt = {}, sale = null } = {}) {
  // done: punctuation-blind milestone key -> the best date we hold for it.
  // `milestoneKey` (not normalizeMilestone) on BOTH sides of every join here:
  // a ladder spelled "Cond Approval" against a stop/catalog "Cond. Approval"
  // used to miss (audit round 2, obs 4) and silently drop the date.
  const witnessedByKey = {};
  for (const [k, v] of Object.entries(reachedAt || {})) {
    // First wins — reachedAtByMilestone is newest-first (see milestoneStepper).
    const kk = stages.milestoneKey(k);
    if (!(kk in witnessedByKey)) witnessedByKey[kk] = v;
  }
  const done = new Map();
  for (const r of (Array.isArray(ladder) ? ladder : [])) {
    if (!r || !r.done || !r.milestone_name) continue;
    const k = stages.milestoneKey(r.milestone_name);
    const witnessed = witnessedByKey[k] || null;
    const at = r.start_date || witnessed || null;
    if (!done.has(k) || (at && !done.get(k).at)) done.set(k, { at });
  }
  const ladderRead = Array.isArray(ladder) && ladder.length > 0;

  const stops = SEVEN_STOPS.map((s) => {
    if (s.pilot) {
      const purchased = sale ? sale.purchased : null;
      return {
        key: s.key, label: s.label, pilot: true,
        reached: purchased === true,
        // Three states survive to the screen: true, false, and "not said".
        unknown: purchased == null,
        at: purchased === true ? (sale && sale.at) || null : null,
        note: sale ? sale.note : null,
      };
    }
    let hit = null;
    for (const name of s.milestones) { const k = stages.milestoneKey(name); if (done.has(k)) { hit = done.get(k); break; } }
    return { key: s.key, label: s.label, pilot: false, reached: !!hit, at: hit ? hit.at : null };
  });

  // WHERE THE FILE IS vs WHAT IS UP NEXT (owner-directed 2026-08-24: the file's
  // status is the last COMPLETED stop, worn in its attained wording — the stop
  // labels are already the attained forms). `atIndex` is the stop the file
  // STANDS at (the last reached non-pilot stop); `currentIndex` keeps its
  // meaning as the first unreached stop past it — the one being WAITED ON.
  // With no ladder read, neither is claimed — inventing progress from an
  // unread ladder is the stepper's own rule, kept here.
  let currentIndex = -1;
  let atIndex = -1;
  if (ladderRead) {
    stops.forEach((s, i) => { if (!s.pilot && s.reached) atIndex = i; });
    currentIndex = stops.findIndex((s, i) => i > atIndex && !s.pilot && !s.reached);
  }
  return { ladderRead, currentIndex, atIndex, stops };
}

/**
 * THE MILESTONE BOARD — the Milestones section's rows: EVERY step of the
 * spliced catalog (ours included), each carrying what the LADDER read for this
 * loan holds — done, Encompass's own date for the step (`start_date`: the
 * worked date on a done step, the PLANNED date on one not yet worked — the
 * board says which), the day PILOT watched it flip, and the ASSOCIATE Encompass
 * assigns to that step (#34's persona ground truth, straight off the row).
 *
 * A catalog step the ladder does not carry answers `inLadder:false` with done
 * NULL — "the ladder has not said", which is a different fact from "not done".
 */
function milestoneBoard(catalog = [], ladder = [], { reachedAt = {}, sale = null } = {}) {
  // Punctuation-blind joins on BOTH sides (audit round 2, obs 4) — a ladder
  // "Cond Approval" must land on the catalog's "Cond. Approval" row.
  const byName = new Map();
  for (const r of (Array.isArray(ladder) ? ladder : [])) {
    if (r && r.milestone_name) byName.set(stages.milestoneKey(r.milestone_name), r);
  }
  const witnessedByKey = {};
  for (const [k, v] of Object.entries(reachedAt || {})) {
    // First wins — reachedAtByMilestone is newest-first (see milestoneStepper).
    const kk = stages.milestoneKey(k);
    if (!(kk in witnessedByKey)) witnessedByKey[kk] = v;
  }
  const rows = (catalog || [])
    .slice()
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map((m) => {
      if (m.pilot) {
        return {
          name: m.name, label: m.name, pilot: true,
          done: sale ? sale.purchased === true : null,
          unknown: !sale || sale.purchased == null,
          date: sale && sale.purchased === true ? (sale.at || null) : null,
          dateKind: sale && sale.purchased === true ? 'worked' : null,
          witnessedAt: null,
          associate: null,
          roleRequired: null,
          expectedDays: m.expected_days == null ? null : Number(m.expected_days),
          note: sale ? sale.note : null,
        };
      }
      const r = byName.get(stages.milestoneKey(m.name)) || null;
      const isDone = r ? !!r.done : null;
      return {
        name: m.name, pilot: false,
        // A DONE step wears its COMPLETED wording (owner-directed 2026-08-24:
        // "every milestone has two wordings" — LO Prep done reads "Assigned to
        // Processor"); an open step keeps its active name. `name` stays the
        // raw Encompass spelling for anything that joins on it.
        label: isDone === true ? stages.completedFormLabel(m.name) : m.name,
        inLadder: !!r,
        done: isDone,
        date: r ? (r.start_date || null) : null,
        dateKind: r ? (r.done ? 'worked' : 'planned') : null,
        witnessedAt: witnessedByKey[stages.milestoneKey(m.name)] || null,
        associate: r && (r.associate_name || r.associate_role || r.associate_email) ? {
          name: r.associate_name || null,
          role: r.associate_role || null,
          email: r.associate_email || null,
        } : null,
        roleRequired: r ? (r.role_required || null) : null,
        expectedDays: m.expected_days == null ? null : Number(m.expected_days),
      };
    });
  return { ladderRead: byName.size > 0, rows };
}

module.exports = {
  hasIncomeFigures,
  SECTIONS,
  SEVEN_STOPS,
  sectionMenu,
  milestoneStepper,
  sevenStops,
  milestoneBoard,
  summaryRail,
};

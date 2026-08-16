'use strict';

// Freeze the loan STRUCTURE / economics through ONE chokepoint that every
// economics write path already calls (register, details edit, complete-fields,
// SOW/rehab-budget, appraisal reprice/undo, change-request approve, and the
// borrower equivalents). Two independent freezes share it:
//
//   1. STATUS freeze (#84) — once a file reaches Clear-to-Close / Funded (or a
//      terminal Declined / Withdrawn), its structural basis must not be
//      overwritten. A super_admin may deliberately UNLOCK the file
//      (structural_unlocked_at) to correct a mistake, then re-lock. Status
//      changes themselves are NOT gated here, so staff can always push a file
//      back to an earlier status.
//
//   2. TERM-SHEET-SENT freeze (owner-directed 2026-07-22) — the moment the Term
//      Sheet DocuSign package is SENT, the loan's figures + structure freeze so
//      the sent term sheet can never silently disagree with the file. The ONLY
//      way to change anything is to CLEAR the Term Sheet package (void it) —
//      that reopens the term-sheet + application conditions and lets you
//      re-register. The freeze lifts automatically the instant the package is
//      voided/declined.
//
//      ONE exception, owner-reported 2026-07-27: a file that has reached
//      Clear to Close / Funded (or a terminal Declined / Withdrawn) with an
//      ACTIVE super_admin unlock. See the note above `superUnlockActive` — on
//      those files "clear the package" is not a real instruction, and the
//      unlock is the escape hatch the product already advertises.
//
// The freeze applies to EVERYONE on every write path that CALLS this. A caller
// passing no actor (borrower paths) stays frozen. The ClickUp inbound sync
// writes economics directly and does NOT yet consult this (it has its own
// review/park machinery) — a separate, tracked follow-up, same as for #84.
//
// ---------------------------------------------------------------------------
// SCOPE-OF-WORK RE-ALLOCATION EXCLUSION (owner-directed 2026-07-26)
//
// The term-sheet freeze exists for exactly ONE reason, stated above: "so the
// sent term sheet can never silently disagree with the file." A Scope of Work
// save that leaves the CONSTRUCTION BUDGET AMOUNT exactly where it already was
// — $100 comes off one line item and goes onto another, the budget still totals
// $126,000 — cannot create that disagreement. The term sheet prints the budget,
// not the line items, and the Scope of Work has never been allowed to write
// applications.rehab_budget anyway (see rehab-budget.js). Refusing those saves
// forced the team to VOID a signed term sheet and re-issue an identical one just
// to move money between lines, which is worse for the borrower and worse for the
// audit trail than the edit itself.
//
// So `sowLockReason()` — the entry point the three Scope-of-Work save paths use
// instead of `structuralLockReason()` — carves out exactly that case, and
// nothing more:
//
//   · TERM-SHEET-SENT + the budget total is unchanged → ALLOWED.
//   · TERM-SHEET-SENT + the budget total moves        → still frozen (the sent
//     term sheet WOULD disagree; clear the package and re-register).
//   · CLEAR-TO-CLOSE / FUNDED → still frozen even when the total is unchanged.
//     Past Clear to Close the scope has already gone to the investor, so a
//     reallocation is no longer ours alone to make: it goes through the Scope of
//     Work change request on the draw desk (which records the before/after
//     budgets and routes a real move for capital-partner approval), or a
//     super-admin unlocks the file.
//   · DECLINED / WITHDRAWN → never editable (unchanged).
//
// "The budget total is unchanged" is NOT judged here — it is delegated to
// `rehab-budget.checkSowBudget`, the SAME gate that decides whether the
// rehab-budget condition may clear, so this exclusion can never drift away from
// the exact-match rule it leans on. Anything we cannot PROVE is budget-neutral
// fails CLOSED (stays frozen).

const db = require('../db');

const STRUCTURE_LOCKED = ['clear_to_close', 'funded', 'declined', 'withdrawn'];
const LABEL = { clear_to_close: 'Clear to Close', funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn' };

// The money statuses where a Scope-of-Work reallocation is a real workflow (it
// goes to the investor) rather than simply "this file is over". Declined /
// withdrawn files get the plain status message — there is nothing to reallocate.
const SOW_INVESTOR_STATUSES = ['clear_to_close', 'funded'];

// A Term Sheet package counts as "sent and not cleared" while it is in a live
// sent / delivered / completed state. A void (the Clear action), a decline, or a
// send error is terminal and frees the file — matching the esign in-flight model.
const TS_SENT_STATUSES = ['sent', 'delivered', 'completed'];

// Read both freeze inputs in ONE query. Returns the row, or null when the file
// can't be read (callers then decline to hard-block, exactly as before).
async function lockInputs(appId, client = db) {
  const r = await client.query(
    `SELECT a.status, a.structural_unlocked_at,
            EXISTS(SELECT 1 FROM esign_envelopes e
                    WHERE e.application_id = a.id
                      AND e.purpose = 'term_sheet_package'
                      AND e.status = ANY($2)) AS ts_sent
       FROM applications a WHERE a.id=$1`,
    [appId, TS_SENT_STATUSES]);
  return r.rows[0] || null;
}

// Is the deliberate super_admin UNLOCK live on this file, for THIS actor?
//
// The unlock exists for exactly one situation: a file whose STATUS froze it
// (clear-to-close / funded / declined / withdrawn) needs a genuine mistake
// corrected. It is a super_admin-only, audited action with a typed reason, and
// the portal only ever offers the 🔓 button on those statuses.
//
// It lifts BOTH freezes on those files (owner-reported 2026-07-27: unlocking a
// cleared-to-close file and editing the rehab type / assignment fee silently
// did nothing, because the file's term sheet had long since been SIGNED and the
// term-sheet freeze still refused the write). On a Clear-to-Close file the
// term-sheet freeze's own escape hatch — "clear the Term Sheet package" — is not
// an instruction anyone can follow: it would void a fully-signed term sheet,
// supersede the signed document and reopen the term-sheet + application
// conditions on a file that is already cleared to close. The unlock is at least
// as deliberate, and unlike the clear it is reversible and leaves the signed
// term sheet intact.
//
// BEFORE Clear to Close nothing changes — there is no unlock button there, the
// term sheet is genuinely still in flight, and clearing + re-sending it is the
// cheap, correct action (owner-directed 2026-07-22, untouched).
function superUnlockActive(row, opts = {}) {
  if (!row || !row.structural_unlocked_at) return null;
  if (!STRUCTURE_LOCKED.includes(row.status)) return null;
  const actor = opts.actor || null;
  return !!(actor && actor.kind === 'staff' && actor.role === 'super_admin');
}

// 1) STATUS freeze — super_admin-unlockable. Returns the reason, or null.
function statusFreezeReason(row, opts = {}) {
  const status = row && row.status;
  if (!status || !STRUCTURE_LOCKED.includes(status)) return null;
  const actor = opts.actor || null;
  const isSuper = !!(actor && actor.kind === 'staff' && actor.role === 'super_admin');
  if (superUnlockActive(row, opts)) return null;
  return `This file is ${LABEL[status] || status} — its loan structure is locked. `
    + (isSuper
        ? 'A super-admin can unlock it to make a correction, then re-lock.'
        : 'Move it back to an earlier status, or ask a super-admin to unlock it, before changing this.');
}

// 2) TERM-SHEET-SENT freeze — the unlock is clearing the package, except on a
//    status-locked file a super_admin has deliberately unlocked (see above).
//    Audience-aware: staff get the actionable "clear the package" copy; a
//    borrower (no staff actor — the borrower register/SOW paths pass none)
//    can't clear a package, so they're steered to their loan officer.
function termSheetFreezeReason(row, opts = {}) {
  if (!row || !row.ts_sent) return null;
  if (superUnlockActive(row, opts)) return null;
  const isStaff = !!(opts.actor && opts.actor.kind === 'staff');
  return isStaff
    ? 'The Term Sheet DocuSign package has been sent, so the loan’s figures and structure are frozen. '
      + 'Clear the Term Sheet package first to change anything (that removes the sent term sheet and reopens '
      + 'the term-sheet and application conditions), then re-register.'
    : 'This file’s details are locked because the term sheet has been sent for signature. '
      + 'Contact your loan officer if something needs to change.';
}

// Returns a human-readable reason string when the file's structure is locked, or
// null when it's still editable. Pass { actor: req.actor } to honor an active
// super_admin unlock of the STATUS freeze (the term-sheet freeze is never
// unlocked that way — clear the package instead).
async function structuralLockReason(appId, client = db, opts = {}) {
  try {
    const row = await lockInputs(appId, client);
    if (!row) return null;
    return statusFreezeReason(row, opts) || termSheetFreezeReason(row, opts) || null;
  } catch (_) { /* if we can't read status, don't hard-block */ }
  return null;
}

// Is THIS file frozen specifically because a Term Sheet package is live-sent?
// (Handy for the UI / the future Clear button — distinct from the status lock.)
async function termSheetSentLock(appId, client = db) {
  try {
    const r = await client.query(
      `SELECT EXISTS(SELECT 1 FROM esign_envelopes e
                      WHERE e.application_id=$1 AND e.purpose='term_sheet_package'
                        AND e.status = ANY($2)) AS ts_sent`,
      [appId, TS_SENT_STATUSES]);
    return !!(r.rows[0] && r.rows[0].ts_sent);
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Scope-of-Work saves
// ---------------------------------------------------------------------------

/**
 * Does this Scope-of-Work payload leave the CONSTRUCTION BUDGET AMOUNT exactly
 * where the file already has it? That is the entire test for a reallocation:
 * money moves BETWEEN line items; the budget itself does not move.
 *
 * Delegated to `rehab-budget.checkSowBudget` — the same gate that decides
 * whether the rehab-budget condition may clear — so "neutral" here can never
 * come to mean something different from "matches" there. `ok && !seed` means
 * BOTH the line-item grand total AND (when the SOW carries one) the first-page
 * construction budget equal the file's required rehab budget to the cent, and
 * the file actually HAS a required budget that was matched — a `seed` save would
 * be ESTABLISHING the number, not preserving it, which is not a reallocation.
 *
 * Returns { neutral, check } — `check` is checkSowBudget's own cent-precise
 * result so a caller can quote its message verbatim. Fails CLOSED.
 */
async function sowBudgetNeutral(appId, payload, client = db) {
  try {
    const check = await require('./rehab-budget').checkSowBudget(appId, payload, client);
    return { neutral: !!(check && check.ok && !check.seed), check: check || null };
  } catch (_) { return { neutral: false, check: null }; }
}

/**
 * The lock reason for a SCOPE-OF-WORK save specifically: `structuralLockReason`
 * plus the budget-neutral reallocation exclusion documented at the top of this
 * file. Returns null when the save may proceed, else the plain-language reason.
 *
 *   appId    the file
 *   payload  the Scope of Work payload about to be saved — this is what makes
 *            the SOW different from every other write path: we can SEE whether
 *            the construction budget actually moves
 *   opts     { actor } — same meaning as structuralLockReason
 *
 * Never throws. An unreadable file behaves exactly like `structuralLockReason`
 * (no hard block); anything we cannot prove is budget-neutral stays frozen.
 */
async function sowLockReason(appId, payload, client = db, opts = {}) {
  let row;
  try { row = await lockInputs(appId, client); }
  catch (_) { return null; }               // can't read the file → don't hard-block (parity with structuralLockReason)
  if (!row) return null;

  const statusReason = statusFreezeReason(row, opts);
  const tsReason = termSheetFreezeReason(row, opts);
  if (!statusReason && !tsReason) return null;    // nothing frozen at all — save away

  const isStaff = !!(opts.actor && opts.actor.kind === 'staff');

  // --- Past Clear to Close the scope has gone to the investor. The status
  //     freeze still stands even for a budget-neutral move; we only make the
  //     message say WHY, and where the real path is. (A super_admin unlock is
  //     already honored inside statusFreezeReason.)
  if (statusReason) {
    if (!SOW_INVESTOR_STATUSES.includes(row.status)) return statusReason;
    return isStaff
      ? statusReason
        + ' Moving money between Scope of Work line items without changing the construction budget total is'
        + ' allowed right up until Clear to Close — after it, the scope has already gone to the investor, so a'
        + ' reallocation goes through a Scope of Work change request (it records the before/after budgets and'
        + ' routes a real move for capital-partner approval).'
      : `This file’s Scope of Work is locked because the loan has reached ${LABEL[row.status] || row.status}. `
        + 'Contact your loan officer if something needs to change.';
  }

  // --- Term sheet sent, still before Clear to Close: a save that leaves the
  //     construction budget exactly where it is cannot make the sent term sheet
  //     disagree with the file, so it is allowed.
  const { neutral, check } = await sowBudgetNeutral(appId, payload, client);
  if (neutral) return null;

  if (!isStaff) return tsReason;
  // Staff: say WHY the exclusion did not apply, in the gate's OWN cent-precise
  // words, so "just put it back" is actionable instead of a mystery.
  const why = check && check.message
    ? ` This save changes it — ${check.message}`
    : (check && check.seed
        ? ' This file has no construction budget on record yet, so this save would be SETTING the budget rather than preserving it.'
        : ' This save does not carry a Scope of Work total that matches the file’s construction budget.');
  return 'The Term Sheet DocuSign package has been sent, so the loan’s figures and structure are frozen. '
    + 'You can still move money BETWEEN Scope of Work line items as long as the construction budget total stays '
    + 'exactly the same.' + why
    + ' Put the line items back to the file’s construction budget, or clear the Term Sheet package first '
    + '(that removes the sent term sheet and reopens the term-sheet and application conditions), then re-register.';
}

/**
 * The lock reason for a DETAILS save that touches NOTHING but the payoff's
 * who-and-which — `structuralLockReason` with one narrow exclusion, in the same
 * shape as the Scope-of-Work carve-out above (owner-directed 2026-07-31).
 *
 * WHY IT HAS TO EXIST. `payoff_lender` and `payoff_loan_number` are the two
 * things the closing attorney needs in order to ORDER the payoff letter — and
 * the payoff letter is ordered at closing prep, which is at or past Clear to
 * Close, long after the term sheet went out. Without this, the payoff section
 * would be frozen at precisely the moment it is needed: the officer learns who
 * the servicer really is, types it in, and is told to void a signed term sheet.
 *
 * WHY IT IS SAFE — the same test the SOW exclusion is held to. The term-sheet
 * freeze exists so a sent term sheet can never silently disagree with the file.
 * Neither of these fields carries money: neither is a pricing input (they are
 * absent from the db/071/072 reopen trigger, so they cannot even make a
 * registration stale), neither enters any engine, and neither can change a
 * single number on the sheet. They print as two informational lines naming the
 * servicer — and the SIGNED PDF is a stored document that this cannot alter.
 *
 * IT IS DELIBERATELY NARROW, in two directions. Any other field in the same
 * request — the payoff AMOUNT above all — falls straight through to
 * `structuralLockReason` unchanged; and the exclusion stops at Clear to Close.
 * A FUNDED, DECLINED or WITHDRAWN file stays frozen even for these two: the
 * payoff has already been wired by then, so this is no longer closing prep, it
 * is rewriting the record of a closed loan. Both limits are what stop it
 * becoming a general-purpose way past the freeze.
 *
 * Never throws; an unreadable file behaves exactly like `structuralLockReason`.
 */
async function payoffContactLockReason(appId, body, client = db, opts = {}) {
  const reason = await structuralLockReason(appId, client, opts);
  if (!reason) return null;                                        // nothing frozen — save away
  if (!require('./payoff').isPayoffContactOnlyEdit(body)) return reason;

  /* THE EXCLUSION IS THE CLOSING-PREP WINDOW, NOT "any frozen file" (narrowed
     after the pre-merge audit, 2026-07-31). The first cut returned null for a
     contact-only body whatever the file's status, which also lifted the freeze
     on a FUNDED, DECLINED or WITHDRAWN file. None of those is the case this
     exists for: after funding the payoff has already been wired, so rewriting
     the record of who was paid — on a closed loan, with no unlock and no change
     request — is a records-integrity regression, not a workflow need. The window
     is up to and including Clear to Close: the term-sheet-sent freeze, and the
     Clear-to-Close status freeze, which is exactly when the payoff letter is
     ordered. Past that, the ordinary freeze applies and a super_admin unlock is
     the recorded way through, like every other correction to a closed file. */
  let row;
  try { row = await lockInputs(appId, client); }
  catch (_) { return reason; }                                     // cannot read the file → stay frozen
  if (!row) return reason;
  const beyondClosingPrep = row.status && row.status !== 'clear_to_close'
    && STRUCTURE_LOCKED.includes(row.status);
  return beyondClosingPrep ? reason : null;
}

/**
 * THE TERMS-NEUTRAL RE-REGISTER CARVE-OUT (owner-directed 2026-08-12).
 *
 * WHY IT EXISTS. After a term sheet package is sent, re-registering a product is
 * frozen ("clear the Term Sheet package first"). But a super_admin often needs to
 * re-register with the borrower's terms UNCHANGED — switch the internal program
 * (e.g. Standard → Silver, if Silver is cheaper for us but we keep the quoted
 * rate) or adjust the internal markup / buy rate — where NOTHING the borrower's
 * terms move. Forcing a clear there voids a signed term sheet and reopens
 * conditions for no reason.
 *
 * THE RULE. This lifts ONLY the term-sheet-sent freeze, ONLY for a super_admin
 * (owner-directed 2026-08-12: "only a super admin should be able to do it"), and
 * ONLY when the borrower-visible terms are byte-identical to the current
 * registration's — the owner's five FINAL numbers (final loan amount, construction
 * (rehab) holdback, financed interest reserve, origination fee dollars, note rate)
 * PLUS the loan TERM (also borrower-visible, and — because Gold prices a flat rate
 * on a no-reserve deal — not always reflected in the five). PROGRAM, MARKUP and the
 * internal BUY RATE are deliberately EXCLUDED; they may change freely so long as no
 * borrower-visible number moves a nickel. Any move, or any non-super_admin, and the
 * old rule stands (clear the package, re-register, send a new term sheet).
 *
 * WHY IT IS SAFE — the same test the SOW/payoff carve-outs are held to. The
 * term-sheet freeze exists so a sent term sheet can never silently disagree with
 * the file. When every borrower-visible number is identical, the sent term sheet's
 * FIGURES still match the file exactly; the re-register supersedes the internal
 * registration row WITHOUT voiding the envelope or reopening a condition, so the
 * signed sheet stays intact and current — exactly the "silent re-register, no new
 * term sheet" the owner asked for. (The sheet does print a "Program" row, so a
 * cross-program switch leaves that ONE label historical — the owner directed this
 * explicitly: "if only the program changes but the rate stays the same … all the
 * details stay the same … we are good." The borrower's terms, which the freeze
 * protects, do not move.)
 *
 * DELIBERATELY NARROW: the STATUS freeze (Clear-to-Close / funded / declined /
 * withdrawn) still stands (a super_admin unlock remains the way through those),
 * so this is a PRE-CTC carve-out only, mirroring sowLockReason.
 *
 * `finalNumbersKey(q, term)` is the neutrality PRIMITIVE — the borrower-visible
 * figures, EXCLUDING program/markup. `term` is threaded in explicitly because it is
 * not on the quote object. `termsNeutralReregister` is the pure FREEZE decision: it
 * takes the file's already-read lock row (so it never re-reads — a second read that
 * failed could lift a freeze the caller already established) plus the caller's
 * neutrality verdict, and returns null (allow) or the freeze reason.
 */
function finalNumbersKey(q, term) {
  const s = (q && q.sizing) || {};
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const rate = q && q.noteRate != null ? Number(q.noteRate) : null;
  return JSON.stringify([
    Math.round(n(s.totalLoan)),
    Math.round(n(s.rehabHoldback)),
    Math.round(n(s.financedReserve)),
    Math.round(n(q && q.origination)),
    rate == null || !Number.isFinite(rate) ? null : rate.toFixed(5),
    // The loan TERM — borrower-visible, printed on the sheet, and NOT on the quote
    // object, so it is passed in. A program/markup switch never moves it; a real
    // term change (which on Gold's flat rate need not move any of the five) does,
    // and must re-freeze the file.
    term == null || term === '' ? null : String(term),
  ]);
}

function termsNeutralReregister(row, isNeutral, opts = {}) {
  if (!row) return null;                             // no row → caller decides (parity with structuralLockReason)
  // The STATUS freeze always stands (a super_admin unlock is honored inside it).
  const statusReason = statusFreezeReason(row, opts);
  if (statusReason) return statusReason;
  const tsReason = termSheetFreezeReason(row, opts);
  if (!tsReason) return null;                        // nothing frozen — register away
  // Term-sheet sent, pre-CTC: the carve-out is SUPER-ADMIN ONLY and terms must be
  // unchanged. Anyone else — or any term change — stays frozen (clear the package).
  const isSuper = !!(opts.actor && opts.actor.kind === 'staff' && opts.actor.role === 'super_admin');
  return (isSuper && isNeutral) ? null : tsReason;
}

/**
 * AS-IS / ARV super-admin OVERRIDE of the term-sheet-sent freeze (owner-directed
 * 2026-08 — "Save ARV, keep the loan"). A super_admin editing ONLY the as-is value +
 * ARV on a term-sheet-frozen file — behind a DOUBLE WARNING + a typed reason — may
 * RECORD the new figures whether or not re-pricing at them WOULD move the loan. The
 * loan itself never moves: apply() (asis-arv-override.js) writes only as_is_value/arv
 * and RE-ASSERTS the Products & Pricing item, the signed-term-sheet condition and the
 * registration's stale flag to their before-state, so loan_amount, the registration,
 * the sent term sheet and its conditions stay EXACTLY as they are — the owner keeps the
 * loan and only the recorded ARV/as-is changes. This is the pure freeze decision, a
 * sibling of termsNeutralReregister: returns null when the save is allowed, else the
 * freeze reason.
 *
 *   · The STATUS freeze (CTC / funded / declined / withdrawn) ALWAYS stands — a
 *     super-admin UNLOCK is the recorded way through those, never this override.
 *   · The override lifts ONLY the term-sheet freeze, ONLY for a super_admin, ONLY when
 *     it was explicitly requested (opts.overrideRequested). Neutrality no longer gates
 *     (owner-directed 2026-08): a change that would move the loan is still allowed, and
 *     the loan is held frozen by apply()'s re-assert rather than by refusing the save.
 *   · Anyone else, or no explicit request → the freeze stands (clear the package and
 *     re-register). The `isNeutral` argument is retained for signature stability and
 *     audit callers but no longer affects the decision.
 */
function asIsArvTermSheetOverride(row, isNeutral, opts = {}) {
  if (!row) return null;
  const statusReason = statusFreezeReason(row, opts);
  if (statusReason) return statusReason;
  const tsReason = termSheetFreezeReason(row, opts);
  if (!tsReason) return null;                        // not frozen — nothing to override
  const isSuper = !!(opts.actor && opts.actor.kind === 'staff' && opts.actor.role === 'super_admin');
  return (isSuper && opts.overrideRequested) ? null : tsReason;
}

/**
 * THE EXPERIENCE RE-ALLOCATION CARVE-OUT (owner-directed 2026-08-13).
 *
 * WHY IT EXISTS. A term sheet was signed and issued on an application claiming
 * THREE fix-and-flips; verification came back TWO fix-and-flips and ONE
 * fix-and-hold — the same three deals, the same experience level. The track-record
 * condition can only be signed off once the application MATCHES what was verified,
 * and the application could not be edited: "It doesn't let it, and it says that you
 * need to clear the term sheet, you need to delete, you need to change, and then you
 * need to reprice and reissue." The owner's rule: "between fix-and-flip and
 * fix-and-hold, as long as it keeps the same backend amount, it should not be
 * considered something that you need to clear the term sheet."
 *
 * WHY IT IS SAFE — the same test the SOW / payoff / terms-neutral carve-outs are
 * held to. The freeze exists so a sent term sheet can never silently disagree with
 * the file. All three frozen engines count fix-and-flip and fix-and-hold TOGETHER
 * and never separately (standard `projectCount` = flips + holds + ground, or ground
 * alone on a ground-up; gold `renoCount` = expFlips + expHolds), so with ground held
 * equal and flips + holds held equal EVERY engine's project count — hence the tier,
 * hence every number on the sheet — is byte-identical BY CONSTRUCTION. That is a
 * property of the engines, not a tolerance, which is why this needs no per-file
 * re-price and why it is granted to EVERYONE rather than only a super-admin: the
 * predicate is on the DATA, exactly like `sowLockReason`.
 *
 * DELIBERATELY NARROW: the STATUS freeze (Clear-to-Close / Funded / Declined /
 * Withdrawn) still stands, so this is PRE-CTC only; and the caller must have proved
 * the request touches NOTHING but the experience counts (experience-realloc.js
 * `changesOnlyExperience` + `isNeutralReallocation`). Anything else falls straight
 * through to the ordinary freeze.
 *
 * PURE, like `termsNeutralReregister`: it takes the file's already-read lock row (so
 * it never re-reads — a second read that failed could lift a freeze the caller
 * already established) plus the caller's neutrality verdict.
 */
function experienceReallocation(row, isNeutralRealloc, opts = {}) {
  if (!row) return null;                             // no row → caller decides (parity with structuralLockReason)
  const statusReason = statusFreezeReason(row, opts);
  if (statusReason) return statusReason;             // the STATUS freeze always stands
  const tsReason = termSheetFreezeReason(row, opts);
  if (!tsReason) return null;                        // nothing frozen — save away
  return isNeutralRealloc ? null : tsReason;
}

/**
 * THE SUPER-ADMIN DOUBLE-WARNING OVERRIDE of the term-sheet-sent freeze, for the
 * APPLICATION DETAILS editor (owner-directed 2026-08-13).
 *
 * THE OWNER'S WORDS: "superadmin with double warning should be able to overwrite and
 * change anything in the file without clearing the term sheet. Even if we have 10
 * fix-and-flips and we're switching it to 5 fix-and-flips and 5 REO, superadmin
 * should be able to do this with a double warning. Only superadmin, not regular
 * admins." Asked to choose how wide, the owner picked EVERY FIELD on the Application
 * Details screen.
 *
 * So this is the general sibling of `asIsArvTermSheetOverride`, and it is the same
 * shape and the same three conditions:
 *   · the STATUS freeze (CTC / funded / declined / withdrawn) ALWAYS stands — a
 *     super-admin UNLOCK is the recorded way through those, never this override;
 *   · it lifts ONLY the term-sheet freeze, ONLY for a `super_admin`, and ONLY when
 *     it was explicitly requested (`opts.overrideRequested`, which the editor sets
 *     behind a DOUBLE WARNING + a typed reason). Holding the role clears nothing;
 *   · anyone else, or no explicit request → the freeze stands.
 *
 * KEEPING THE SENT TERM SHEET INTACT IS THE CALLER'S JOB, not this function's — the
 * owner's ask is "without clearing the term sheet", so `details-freeze.js` captures
 * and re-asserts the conditions the db/486 trigger would reopen, exactly as
 * `asis-arv-override.apply()` does. Neutrality is NOT a gate here by design: this
 * override exists precisely for the changes that are NOT neutral (10 flips → 5 flips
 * + 5 REO genuinely lowers the qualified experience), and the double warning, the
 * typed reason and the permanent audit record are the control.
 */
function detailsAdminOverride(row, opts = {}) {
  if (!row) return null;
  const statusReason = statusFreezeReason(row, opts);
  if (statusReason) return statusReason;
  const tsReason = termSheetFreezeReason(row, opts);
  if (!tsReason) return null;                        // not frozen — nothing to override
  const isSuper = !!(opts.actor && opts.actor.kind === 'staff' && opts.actor.role === 'super_admin');
  return (isSuper && opts.overrideRequested) ? null : tsReason;
}

module.exports = {
  structuralLockReason, STRUCTURE_LOCKED, TS_SENT_STATUSES, termSheetSentLock,
  experienceReallocation, detailsAdminOverride,
  sowLockReason, sowBudgetNeutral, SOW_INVESTOR_STATUSES,
  payoffContactLockReason,
  termsNeutralReregister, asIsArvTermSheetOverride, finalNumbersKey,
  // The two halves, exported so tests (and any future caller that needs one
  // freeze without the other) never have to re-implement them.
  _internals: { lockInputs, statusFreezeReason, termSheetFreezeReason, superUnlockActive },
};

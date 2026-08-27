'use strict';
/**
 * WITHDRAWN 2026-08-27 — this suite guarded a rule that was WRONG and that
 * created SIX DUPLICATE CARDS on live historical loans. The original is in git
 * history (commit d6944b2); it is stubbed rather than deleted so the gap it
 * missed stays on the record.
 *
 * THE RULE IT GUARDED. "A loan with `lt_loans.clickup_task_id IS NULL` that has
 * finished LO Prep should get a card."
 *
 * WHY THAT IS WRONG. `clickup_task_id IS NULL` does NOT mean "this loan has no
 * card in ClickUp". It means "PILOT is not HOLDING A LINK to the card this loan
 * may well already have". Matching a loan to its existing card is a SEPARATE
 * pass (link.js / linkPass). So the create pass's own guard only ever protected
 * loans PILOT had already linked — never the unlinked ones, which are exactly
 * the ones at risk.
 *
 * WHAT THE DATE CUTOFF WAS REALLY DOING. `created_at >= LT_CLICKUP_CREATE_SINCE`
 * was documented as a go-live guard ("brand-new files, discovered after go-live
 * day"). It was silently doing a SECOND, unstated job: keeping the entire
 * UNLINKED HISTORICAL BOOK out of the create pass. Removing it for anything past
 * LO Prep — which is every closed deal ever — pointed the pass straight at
 * hundreds of 2025/2026 loans that already had cards, and it began minting
 * fresh duplicates.
 *
 * WHY THIS SUITE DID NOT CATCH IT. Its assertion E1, "never a second card",
 * staged a loan whose `clickup_task_id` was ALREADY SET — the one case that was
 * never at risk. It never staged the real shape: a card that exists IN CLICKUP
 * while PILOT holds no link to it. A test cannot see a duplicate it never
 * stages, and its passing gave false confidence in exactly the claim that was
 * untrue.
 *
 * BEFORE RE-ENABLING ANY VERSION OF THIS RULE it must prove the loan has been
 * through the LINK pass and NO card was found for it — never infer "no card"
 * from "no link" — and its test must stage an existing-but-unlinked card and
 * assert nothing is created.
 */
console.log('lt-clickup-handoff-create: WITHDRAWN — the rule it guarded created duplicate cards; see the header.');
process.exit(0);

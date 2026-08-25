'use strict';

/**
 * DOES THIS FILE CARRY THE ASSIGNMENT-OF-CONTRACT CONDITION? — one reading,
 * every surface (owner-reported 2026-08-25, YSCAP258134828 / 601 South 18th
 * Street, a "Refinance — Cash-Out" showing "Assignment letter (if the contract
 * is assigned)" on the borrower's own checklist).
 *
 * THE BUG WAS THREE RULES FOR ONE QUESTION, and they disagreed:
 *   · db/179's trigger asked TWO questions — is the file flagged as an
 *     assignment AND is it a purchase — and DELETED the condition otherwise.
 *   · `conditions/ensure.js` asked ONE — `is_assignment === true` — and
 *     re-created it on the very next ensure. ensureFileConditions runs on every
 *     create path, every re-sync and every key-field change, so on a refinance
 *     whose assignment box was ticked the two rules fought: the strict one took
 *     the condition off, the lax one put it straight back, and the borrower kept
 *     being asked for an assignment letter for a loan that buys nothing.
 *   · db/095's boot reconciler asks that same single question.
 *
 * So the rule lives HERE, once, and every JS door reads it. The db side is the
 * same rule twice more — the AFTER trigger that removes it (db/179) and the
 * BEFORE INSERT guard that refuses to create it at all (db/629) — because a
 * checklist row can be written by SQL that never runs through this file.
 *
 * `sizesOnAsIsValue` is DELIBERATELY the predicate: it is byte-for-byte
 * `pricing.js loanTypeOf`'s `/refi/` test, which is what the frozen engine uses
 * to decide the file is a refinance, and it is what db/179 spells as
 * `!~* 'refi'`. One question, one answer, on every layer.
 *
 * PURE — no database, no network, never throws.
 */
const { sizesOnAsIsValue } = require('../deal-basis');

/* `app` is an applications row (snake_case, what every caller here has) or the
   camelCase body shape the create doors speak. Both are accepted so no caller
   has to reshape a row just to ask the question — reshaping is where the
   original drift came from. */
function carriesAssignmentCondition(app) {
  const a = app || {};
  const flagged = a.is_assignment === true || a.isAssignment === true;
  if (!flagged) return false;
  const loanType = a.loan_type != null ? a.loan_type : a.loanType;
  return !sizesOnAsIsValue(loanType);
}

module.exports = { carriesAssignmentCondition };

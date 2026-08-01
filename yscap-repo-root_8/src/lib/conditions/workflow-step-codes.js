/* WORKFLOW-STEP CONDITION CODES — the SERVER's copy (CommonJS twin).
 *
 * These four rows live in the `conditions` checklist table (`item_kind='condition'`)
 * but are really internal workflow STEPS: a human reads the registered product
 * against the program and ticks a box. Nothing is uploaded against them and nobody
 * signs one off on the strength of a document. The owner asked to have them HIDDEN
 * from the file (owner-reported 2026-07-27), and the client hides them from the
 * conditions list via `app-v2/src/lib/condition-workflow-steps.js`.
 *
 * The bug this fixes: hiding them on the CLIENT left the SERVER's readiness/"Go fix"
 * aggregator (`advancementBlockers` in `src/routes/staff.js`) still counting them —
 * they are required, non-gate `condition` rows, so they satisfied every blocker
 * predicate. The result: they showed as outstanding "Go fix →" items that, when
 * clicked, landed on a conditions hub that had filtered them out — nowhere to go.
 *
 * So the two systems must share ONE list. This module is the server's authoritative
 * copy; it is kept BYTE-FOR-BYTE in sync with the client set by
 * `scripts/test-workflow-step-codes-parity.js` (in `npm test`), which parses both
 * files and fails on any drift. Add or remove a code in BOTH places (a decision,
 * never an inference — see the client file's header).
 *
 * DELIBERATELY NOT HERE: the three clear-to-close GATES (`rtl_p4_ts`,
 * `rtl_f_review`, `rtl_f_ctc`). The server ENFORCES those (`WHERE ci.is_gate=true`),
 * so excluding them would let files close with a workflow step un-done and no way
 * to sign it off. They are `is_gate=true` and would not be picked up by the
 * `checklistConds` query anyway, but keep them off this list regardless.
 */
'use strict';

const WORKFLOW_STEP_CODES = [
  'rtl_p4_ltc',   // LTC checked against program guidelines
  'rtl_p4_ltv',   // LTV checked against program guidelines
  'rtl_p4_arv',   // ARV checked against program guidelines
  'rtl_p4_ir',    // Interest reserves checked / added if numbers allow
];

module.exports = { WORKFLOW_STEP_CODES };

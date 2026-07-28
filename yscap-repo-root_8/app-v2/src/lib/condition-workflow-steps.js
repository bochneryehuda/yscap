/* CONDITIONS THAT ARE REALLY WORKFLOW STEPS.
 *
 * Owner-reported 2026-07-27, reading the conditions list on a live file: "LTC
 * checked against program guidelines… this is part of the checklist which I told
 * you to hide."
 *
 * They are right about what these are. `item_kind` says `condition`, so Phase 5a
 * correctly MOVED them out of the checklist into the conditions list rather than
 * hiding them with the tasks — but `item_kind` records how a row is STORED, not
 * what it means. Nothing is uploaded against "LTC checked against program
 * guidelines"; nobody signs it off on the strength of a document. It is an
 * internal step a human performs and ticks, which is the definition of the
 * checklist the owner asked to have taken off the file.
 *
 * So this is the short, NAMED list of rows that live in the condition table but
 * belong to the workflow. Named rather than derived on purpose: any rule broad
 * enough to catch these ("a staff condition with no document") would also catch
 * real conditions, and the cost of a wrong guess here is a condition nobody can
 * see. Adding a row to this list is a decision, not an inference.
 *
 * WHAT IS DELIBERATELY *NOT* HERE — the three clear-to-close GATES.
 * rtl_p4_ts (Term sheet generated), rtl_f_review (Final review requested) and
 * rtl_f_ctc (CTC received) are the same shape and the owner named them too, but
 * the system CHECKS them before it will let a file clear to close
 * (`advancementBlockers`, `WHERE ci.is_gate=true AND NOT signed off`). Hiding
 * them without moving what they enforce would block every file from closing with
 * no way left on screen to sign them off. They are being replaced by real
 * signals in the workflow — the executed DocuSign package, the investor review
 * step, the CTC confirmation on the closing order — and only come off this
 * screen when those land. Do not add them here before then.
 *
 * Nothing is deleted. The rows keep their history and still count everywhere the
 * server counts them; this is which list they render in.
 */

export const WORKFLOW_STEP_CODES = new Set([
  // The four internal number-checks. A human reads the registered product
  // against the program and ticks it — there is no document and no gate.
  'rtl_p4_ltc',   // LTC checked against program guidelines
  'rtl_p4_ltv',   // LTV checked against program guidelines
  'rtl_p4_arv',   // ARV checked against program guidelines
  'rtl_p4_ir',    // Interest reserves checked / added if numbers allow
]);

/* True when a row is a workflow step rather than a condition. Keyed on the
   template code only — a staff-typed condition can never accidentally match. */
export function isWorkflowStep(row) {
  if (!row) return false;
  return WORKFLOW_STEP_CODES.has(String(row.template_code || row.code || '').trim());
}

'use strict';

/**
 * THE file-conditions INVARIANT (root fix, owner-directed 2026-07-14).
 *
 * Root cause of the "missing conditions / missing internal checklist" breach:
 * checklist generation was a per-caller courtesy — every creation path called
 * generateChecklist with its OWN argument set (or not at all on failure), and
 * the ClickUp path skipped generation entirely whenever the file already had
 * ANY checklist item (a proxy that went false on 2026-07-09, when the vesting
 * rewrite began inserting the rtl_p1_llc condition BEFORE generation ran — so
 * every ClickUp file with an LLC or co-borrower got 1-2 items and silently
 * missed the other ~39, including the purchase contract, credit report, and
 * the entire internal checklist).
 *
 * The fix is one chokepoint: ensureFileConditions(appId). It derives EVERY
 * input from the DB row (never from caller args — the opts drift was the
 * class), runs the idempotent template instantiation (per-(owner, template)
 * dedup in insertFromTemplate — NEVER an "has any items" emptiness check),
 * and asserts the invariant afterward. Safe to call repeatedly from every
 * creation path, every re-sync, and every key-field change. Belt and
 * suspenders: db/095_reconcile_full_checklists.sql re-fills gaps on every
 * boot for previous AND future files.
 */
const db = require('../../db');

async function ensureFileConditions(appId, { reason = 'ensure' } = {}) {
  const a = (await db.query(
    `SELECT id, borrower_id, program, loan_type, rehab_type, is_assignment, status, deleted_at
       FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!a || a.deleted_at) return { ok: false, skipped: 'missing-or-deleted' };
  if (['declined', 'withdrawn', 'cancelled'].includes(String(a.status || ''))) {
    return { ok: false, skipped: 'terminal-status' };
  }
  // Lazy require avoids a module cycle (routes/borrower requires condition libs).
  const { generateChecklist } = require('../../routes/borrower');
  await generateChecklist(a.id, a.borrower_id, a.program, a.loan_type, {
    isAssignment: a.is_assignment === true,
  });
  // Invariant: a live file must never sit at ZERO checklist items. This is the
  // loud tripwire the old silent try/catch swallowing never had.
  const n = (await db.query(
    `SELECT count(*)::int AS n FROM checklist_items WHERE application_id=$1`, [a.id])).rows[0].n;
  if (n === 0) {
    console.error(`[conditions] INVARIANT VIOLATION: file ${a.id} has ZERO checklist items after ensure (${reason})`);
    try {
      await db.query(
        `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
         VALUES ('system','conditions_invariant_violation','application',$1,$2::jsonb)`,
        [a.id, JSON.stringify({ reason })]);
    } catch (_) { /* audit is best-effort */ }
  }
  return { ok: true, items: n };
}

module.exports = { ensureFileConditions };

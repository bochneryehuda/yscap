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
const { carriesAssignmentCondition } = require('./assignment-purchase');

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
  /* THE ASSIGNMENT GATE IS THE SHARED RULE, NOT A SECOND OPINION (owner-reported
     2026-08-25, YSCAP258134828). This line used to read `a.is_assignment ===
     true` on its own — one question where db/179's trigger asks two (flagged AND
     a purchase). On a refinance whose assignment box was ticked the trigger
     deleted the borrower-facing "Assignment letter" condition and THIS call put
     it straight back on the next ensure — which is every create path, every
     re-sync and every key-field change. `carriesAssignmentCondition` is now the
     one definition; see src/lib/conditions/assignment-purchase.js. */
  await generateChecklist(a.id, a.borrower_id, a.program, a.loan_type, {
    isAssignment: carriesAssignmentCondition(a),
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
  // #16 — a credit report is saved to the BORROWER's profile, so a NEW file for
  // the same borrower within 120 days should ALREADY have the credit info with
  // NO one re-pulling or clicking "reuse". This is the automatic import: it fires
  // at most once per borrower per file (it skips a borrower already carrying a
  // report here), respects the freshness window, and is fully best-effort — a
  // credit hiccup must never break file/condition creation.
  try {
    const credit = require('../credit');
    await credit.autoReuseCreditForFile(a.id, { status: a.status });
  } catch (e) {
    console.warn(`[conditions] auto credit reuse skipped for ${a.id}: ${(e && e.message) || e}`);
  }
  // A track-record document request made when the borrower had NO open file
  // lives on their profile (blueprint §5.4 — an operating agreement is a fact
  // about the person, not about one loan). This is where it moves onto a file:
  // the SAME row migrates, so its documents, its history and its internal notes
  // travel with it and the borrower is never asked twice for something they
  // already sent. This chokepoint is why it reaches previous files too — every
  // creation path, every re-sync and every key-field change comes through here.
  // Best-effort: a migration hiccup must never break file/condition creation.
  try {
    const moved = await require('../track-record/doc-request').migrateProfileRequests(a.borrower_id, a.id);
    if (moved.moved) console.log(`[conditions] moved ${moved.moved} track-record document request(s) onto file ${a.id}`);
  } catch (e) {
    console.warn(`[conditions] track-record request migration skipped for ${a.id}: ${(e && e.message) || e}`);
  }
  return { ok: true, items: n };
}

module.exports = { ensureFileConditions };

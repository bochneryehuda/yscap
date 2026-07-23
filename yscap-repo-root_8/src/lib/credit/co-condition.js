'use strict';
/**
 * Co-borrower CREDIT condition (Wave 2, owner-directed 2026-07-23).
 *
 * Credit is required for BOTH borrowers on a file. By default one import pulls
 * both borrowers in a single action and the file-level "Credit report" condition
 * (rtl_cond_credit) holds both reports. When staff choose to pull only ONE
 * borrower right now, the OTHER borrower gets their OWN "Credit report" condition
 * so their credit is still required and can be pulled separately.
 *
 * A checklist_item is owned by EXACTLY ONE of application/borrower/llc
 * (chk_one_owner), so the credit condition is APPLICATION-scoped and cannot carry
 * a borrower_id. The co-borrower's condition is instead marked with
 * `field_key='cob_credit'` (the same idempotency-marker pattern co-borrower.js
 * uses for the co-borrower gov-ID), so it is found / renamed / removed the same
 * way no matter how often it runs. The report↔borrower link stays on
 * credit_reports.borrower_id (a plain borrower FK, not on the condition). One
 * co-borrower per file (applications.co_borrower_id is singular), so one marked
 * condition per file. Best-effort — a failure logs and returns null.
 */
const db = require('../../db');

// The field_key marker that identifies the co-borrower's credit condition. Shared
// with store.js (which routes the co-borrower's docs to it) and the staff.js
// sign-off gate (which requires the co-borrower's report on it).
const CO_CREDIT_MARKER = 'cob_credit';

function nameOf(row) { return row ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : ''; }

/**
 * Ensure the co-borrower's own Credit report condition exists on the file
 * (create it, or refresh its name). Returns { itemId, created|updated } or null.
 */
async function ensureCoBorrowerCreditCondition(appId, coBorrowerId, client = db) {
  try {
    if (!coBorrowerId) return null;
    const cb = (await client.query('SELECT first_name, last_name FROM borrowers WHERE id=$1', [coBorrowerId])).rows[0];
    const label = `Credit report — ${nameOf(cb) || 'co-borrower'} (co-borrower)`;

    const existing = (await client.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`,
      [appId, CO_CREDIT_MARKER])).rows[0];
    if (existing) {
      await client.query('UPDATE checklist_items SET label=$2, borrower_label=$2, updated_at=now() WHERE id=$1', [existing.id, label]);
      return { itemId: existing.id, updated: true };
    }
    // Mirror the rtl_cond_credit template (db/076) exactly, but APPLICATION-scoped
    // with the co-borrower marker + name. clickup_field_id / tool_key are left NULL
    // (the primary's condition owns the ClickUp dropdown field — two items sharing
    // one field id would collide in the sync).
    const ins = await client.query(
      `INSERT INTO checklist_items
         (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, hint, borrower_hint,
          is_gate, is_milestone, sort_order, tool_key, clickup_field_id, tpr_exclude, created_by_kind, is_required,
          application_id, field_key, status)
       SELECT t.id, t.scope, $2, $2, t.audience, t.item_kind, COALESCE(t.role_scope,'processor'), t.phase, t.hint, t.borrower_hint,
              COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false), COALESCE(t.sort_order,404)+1, NULL, NULL,
              COALESCE(t.tpr_exclude,false), 'system', COALESCE(t.is_required,true), $1, $3, 'outstanding'
         FROM checklist_templates t WHERE t.code='rtl_cond_credit'
       RETURNING id`,
      [appId, label, CO_CREDIT_MARKER]);
    return { itemId: ins.rows[0] ? ins.rows[0].id : null, created: true };
  } catch (e) {
    console.error('[credit] ensureCoBorrowerCreditCondition', appId, e && e.message);
    return null;
  }
}

/**
 * On co-borrower UNLINK: drop a split-out co-borrower credit condition so a
 * required condition for a borrower no longer on the file can never block file
 * sign-off. Keeps it if a completed report was already imported on it (a pulled
 * report is real history). Best-effort.
 */
async function removeCoBorrowerCreditCondition(appId, coBorrowerId, client = db) {
  try {
    await client.query(
      `DELETE FROM checklist_items ci
        WHERE ci.application_id=$1 AND ci.field_key=$2
          AND NOT EXISTS (SELECT 1 FROM credit_reports cr
                           WHERE cr.checklist_item_id=ci.id AND cr.status='completed')`,
      [appId, CO_CREDIT_MARKER]);
    return { removed: true };
  } catch (e) {
    console.error('[credit] removeCoBorrowerCreditCondition', appId, e && e.message);
    return null;
  }
}

module.exports = { ensureCoBorrowerCreditCondition, removeCoBorrowerCreditCondition, CO_CREDIT_MARKER };

'use strict';
/**
 * Heal PAST Heter Iska DocuSign envelopes whose executed document was stored but
 * never fed into the rtl_cond_iska condition (owner-reported 2026-08). ROOT CAUSE
 * (see esign/orchestrate.js + esign/webhook.js): the executed doc is bound to its
 * condition only through the SEND-TIME snapshot esign_envelope_docs.checklist_item_id.
 * When rtl_cond_iska was absent/stale at send time that snapshot captured NULL, and
 * handleCompletion attached the doc only via `if (d.checklist_item_id)` — so the
 * signed Iska stored (completed_document_id set, download works) but the condition
 * was never fed / never marked received.
 *
 * The going-forward fix (send-time ensure) + the webhook re-resolve heal every
 * in-flight completion. An ALREADY-COMPLETED envelope (completed_document_id set,
 * checklist_item_id NULL) never re-drives, so this ONE-SHOT boot pass reaches those
 * back-book files: resolve/ensure rtl_cond_iska, attach the stored executed document
 * to it, record the envelope-doc binding, and mark the condition 'received' (never
 * downgrading a human's satisfied/waived, never over-attaching a superseded copy).
 *
 * Self-draining (each healed row leaves the `checklist_item_id IS NULL` set), bounded
 * per boot, idempotent, never throws. Off with ISKA_FEED_HEAL_DISABLED=1.
 */
const db = require('../../db');

let enqueueChecklistStatusPush = () => {};
try { ({ enqueueChecklistStatusPush } = require('../../clickup/enqueue')); } catch (_) { /* optional */ }

async function backfillIskaFeedOnce(limit = 200) {
  if (process.env.ISKA_FEED_HEAL_DISABLED === '1') return { scanned: 0, fed: 0, disabled: true };
  const orch = require('./orchestrate');
  const rows = (await db.query(
    `SELECT ed.id AS ed_id, ed.completed_document_id, e.application_id
       FROM esign_envelope_docs ed
       JOIN esign_envelopes e ON e.id = ed.envelope_row_id
      WHERE ed.doc_kind = 'heter_iska_signed'
        AND ed.completed_document_id IS NOT NULL
        AND ed.checklist_item_id IS NULL
        AND e.application_id IS NOT NULL
      ORDER BY ed.id
      LIMIT $1`, [Math.max(1, Number(limit) || 200)])).rows;

  let fed = 0;
  for (const r of rows) {
    try {
      let itemId = await orch.resolveConditionItem(db, r.application_id, 'rtl_cond_iska');
      if (!itemId) itemId = await orch.ensureIskaCondition(db, r.application_id, null);
      if (!itemId) continue;  // template missing/inactive — leave the row for a human
      // Attach the stored executed doc to the condition, but only a CURRENT, not-yet-
      // attached copy — never re-home a superseded doc or steal one already on a slot.
      const placed = await db.query(
        `UPDATE documents SET checklist_item_id = $2
          WHERE id = $1 AND checklist_item_id IS NULL AND is_current
          RETURNING id`, [r.completed_document_id, itemId]);
      // Always record the envelope binding so this row drains (even if the stored doc
      // is gone/superseded and there is nothing to place).
      await db.query(
        `UPDATE esign_envelope_docs SET checklist_item_id = $2 WHERE id = $1 AND checklist_item_id IS NULL`,
        [r.ed_id, itemId]);
      if (placed.rows.length) {
        await db.query(
          `UPDATE checklist_items SET status = 'received', updated_at = now()
            WHERE id = $1 AND status NOT IN ('satisfied','waived')`, [itemId]);
        enqueueChecklistStatusPush(itemId);
        fed++;
      }
    } catch (e) {
      console.warn('[esign] iska feed heal row failed:', e.message);
    }
  }
  return { scanned: rows.length, fed };
}

module.exports = { backfillIskaFeedOnce };

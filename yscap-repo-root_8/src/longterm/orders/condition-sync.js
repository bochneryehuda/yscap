'use strict';
/**
 * LONG-TERM ORDERS — THE CONDITION DRIVES THE ORDER (owner-directed 2026-09-03).
 *
 * The owner, on both products: *"if the provider accidentally replies in a new
 * email chain, we currently can't see that response under the original Order
 * section. Once the condition is cleared and the docs are in, the Order section
 * should also be updated so we can easily track the status … If the documents
 * are being uploaded to the condition and the condition is being signed off,
 * then update the status of the order that it's done. Don't say 'hey, orders
 * past due'."*
 *
 * WHAT WAS WRONG. `orders/inbox.js` moves an order to 'documents_in' when the
 * vendor's reply lands ON THE ORDER'S OWN THREAD — matched by the per-order
 * reply address. A reply that comes back in a fresh chain matches nothing, so a
 * person files the documents onto the condition by hand, the back office signs
 * the condition off, and the order row still reads 'ordered' for the life of
 * the file. Nothing anywhere in the long-term product ever wrote 'completed'.
 *
 * THE RULE, IN ONE PLACE. An order belongs to two conditions (`orders/kinds.js
 * ORDER_KINDS`): the ORDER condition ("Title ordered", kind 'order') and the
 * DOCUMENTS condition ("Title docs"). Either one moving moves the order:
 *
 *   a document filed on either condition   → 'documents_in'   (from ordered / not_ordered)
 *   either condition signed off or waived   → 'completed'      (from ordered / documents_in)
 *   the condition reopened                  → back to 'documents_in' — ONLY an
 *                                             order the condition itself closed
 *                                             (`meta.completed_via = 'condition'`);
 *                                             one a person finished is theirs.
 *
 * `lt_file_orders.condition_id` (the row the desk pointed the order at when it
 * was placed) is honoured first; the kind→code map answers for an order placed
 * before that column was filled, or for documents that landed on the sibling
 * condition. 'not_ordered' → 'documents_in' is deliberate and mirrors the inbox:
 * a title commitment that arrived without PILOT placing the order is still a
 * title commitment in hand, and the desk should say so rather than "not ordered".
 *
 * `sweepOnce` is the same rule applied to the whole book — the "previous AND
 * future" rule: every order whose condition is already signed off, or already
 * holds a document, moves on the first tick after deploy, through THIS code and
 * not a second copy of it.
 *
 * SEPARATION: reads `lt_*` and the shared Condition Center (`checklist_items`
 * scoped by `lt_loan_id`, the rows db/652/653 made Long-Term's). No RTL import.
 * Best-effort by contract — nothing here may ever fail the sign-off, the upload
 * or the tick that called it.
 */

const db = require('../db');
const { ORDER_KINDS } = require('./kinds');

/** The order kinds a condition template code belongs to (usually one). */
function kindsForCode(code) {
  const c = String(code || '');
  if (!c) return [];
  return Object.entries(ORDER_KINDS)
    .filter(([, def]) => def && (def.condition === c || def.docCondition === c))
    .map(([kind]) => kind);
}

/** The condition's template code, read on the loan it belongs to (or null). */
async function codeOf(loanId, conditionId, client) {
  const { rows } = await client.query(
    `SELECT t.code
       FROM checklist_items ci
       LEFT JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.id = $2::uuid AND ci.lt_loan_id = $1::uuid`,
    [String(loanId), String(conditionId)],
  );
  return rows[0] ? (rows[0].code || null) : null;
}

/** WHERE clause + params for "the orders this condition speaks for". */
function ordersOf(loanId, conditionId, kinds, from) {
  return {
    sql: `loan_id = $1::uuid AND (condition_id = $2::uuid OR kind = ANY($3::text[])) AND status = ANY($4::text[])`,
    params: [String(loanId), String(conditionId), kinds, from],
  };
}

/**
 * A document was filed on a condition of this loan. Silent when the condition is
 * not an order's; never throws.
 * @returns {Promise<{moved:number, kinds:string[]}>}
 */
async function onDocumentFiled(loanId, conditionId, client = db) {
  try {
    const code = await codeOf(loanId, conditionId, client);
    const kinds = kindsForCode(code);
    if (!kinds.length) return { moved: 0, kinds };
    const w = ordersOf(loanId, conditionId, kinds, ['ordered', 'not_ordered']);
    const { rowCount } = await client.query(
      `UPDATE lt_file_orders SET status = 'documents_in', updated_at = now(),
              meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('documents_in_via', 'condition', 'documents_in_condition_id', $2::text)
        WHERE ${w.sql}`, w.params);
    return { moved: rowCount, kinds };
  } catch (e) {
    console.warn('[lt-orders] documents_in from condition skipped:', (e && e.message) || e);
    return { moved: 0, kinds: [], error: (e && e.message) || String(e) };
  }
}

/**
 * A condition of this loan was signed off or waived. The order it asked for is
 * finished. Never throws.
 * @returns {Promise<{moved:number, kinds:string[]}>}
 */
async function onConditionSatisfied(loanId, conditionId, client = db) {
  try {
    const code = await codeOf(loanId, conditionId, client);
    const kinds = kindsForCode(code);
    if (!kinds.length) return { moved: 0, kinds };
    const w = ordersOf(loanId, conditionId, kinds, ['ordered', 'documents_in']);
    const { rowCount } = await client.query(
      `UPDATE lt_file_orders
          SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now(),
              meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('completed_via', 'condition', 'completed_condition_id', $2::text)
        WHERE ${w.sql}`, w.params);
    return { moved: rowCount, kinds };
  } catch (e) {
    console.warn('[lt-orders] completed from condition skipped:', (e && e.message) || e);
    return { moved: 0, kinds: [], error: (e && e.message) || String(e) };
  }
}

/**
 * A condition was put back to outstanding. Only an order THE CONDITION closed
 * comes back (to 'documents_in' — the documents are still on the file); an
 * order a person marked finished stays finished. Never throws.
 */
async function onConditionReopened(loanId, conditionId, client = db) {
  try {
    const code = await codeOf(loanId, conditionId, client);
    const kinds = kindsForCode(code);
    if (!kinds.length) return { moved: 0, kinds };
    const w = ordersOf(loanId, conditionId, kinds, ['completed']);
    const { rowCount } = await client.query(
      `UPDATE lt_file_orders
          SET status = 'documents_in', completed_at = NULL, updated_at = now(),
              meta = (COALESCE(meta, '{}'::jsonb) - 'completed_via' - 'completed_condition_id')
                     || jsonb_build_object('reopened_via', 'condition')
        WHERE ${w.sql} AND COALESCE(meta, '{}'::jsonb) ->> 'completed_via' = 'condition'`, w.params);
    return { moved: rowCount, kinds };
  } catch (e) {
    console.warn('[lt-orders] reopen from condition skipped:', (e && e.message) || e);
    return { moved: 0, kinds: [], error: (e && e.message) || String(e) };
  }
}

/** code → kinds, flattened for SQL: [[code, kind], …] over every order kind. */
function codeKindPairs() {
  const out = [];
  for (const [kind, def] of Object.entries(ORDER_KINDS)) {
    if (def && def.condition) out.push([def.condition, kind]);
    if (def && def.docCondition) out.push([def.docCondition, kind]);
  }
  return out;
}

/**
 * THE WHOLE BOOK, ONCE — the same two rules over every long-term order still
 * open. Bounded; a caught-up book costs two SELECTs that find nothing.
 * @returns {Promise<{completed:number, documentsIn:number, ok:boolean, reason?:string}>}
 */
async function sweepOnce({ limit = 500, client = db } = {}) {
  const out = { ok: true, completed: 0, documentsIn: 0 };
  const pairs = codeKindPairs();
  const codes = pairs.map((p) => p[0]);
  const kinds = pairs.map((p) => p[1]);
  const cap = Math.max(1, Math.min(5000, Number(limit) || 500));
  try {
    // 1. Finished: an open order whose condition (either of its two) is signed off.
    const done = await client.query(
      `WITH map AS (SELECT unnest($1::text[]) AS code, unnest($2::text[]) AS kind)
       UPDATE lt_file_orders o
          SET status = 'completed', completed_at = COALESCE(o.completed_at, now()), updated_at = now(),
              meta = COALESCE(o.meta, '{}'::jsonb) || jsonb_build_object('completed_via', 'condition', 'completed_condition_id', s.condition_id::text)
         FROM (
           SELECT o2.id AS order_id, ci.id AS condition_id
             FROM lt_file_orders o2
             JOIN checklist_items ci ON ci.lt_loan_id = o2.loan_id
             JOIN checklist_templates t ON t.id = ci.template_id
             JOIN map m ON m.code = t.code AND m.kind = o2.kind
            WHERE o2.status IN ('ordered', 'documents_in')
              AND (ci.status = 'satisfied' OR ci.signed_off_at IS NOT NULL OR ci.waived_at IS NOT NULL)
            ORDER BY o2.ordered_at ASC NULLS LAST, o2.id
            LIMIT $3
         ) s
        WHERE o.id = s.order_id AND o.status IN ('ordered', 'documents_in')`,
      [codes, kinds, cap]);
    out.completed = done.rowCount;
    // 2. Documents in hand: an order still 'ordered' / 'not_ordered' whose condition
    //    holds a current, un-rejected document.
    const docs = await client.query(
      `WITH map AS (SELECT unnest($1::text[]) AS code, unnest($2::text[]) AS kind)
       UPDATE lt_file_orders o
          SET status = 'documents_in', updated_at = now(),
              meta = COALESCE(o.meta, '{}'::jsonb) || jsonb_build_object('documents_in_via', 'condition', 'documents_in_condition_id', s.condition_id::text)
         FROM (
           SELECT o2.id AS order_id, ci.id AS condition_id
             FROM lt_file_orders o2
             JOIN checklist_items ci ON ci.lt_loan_id = o2.loan_id
             JOIN checklist_templates t ON t.id = ci.template_id
             JOIN map m ON m.code = t.code AND m.kind = o2.kind
            WHERE o2.status IN ('ordered', 'not_ordered')
              AND EXISTS (SELECT 1 FROM documents d
                           WHERE d.checklist_item_id = ci.id AND d.is_current
                             AND COALESCE(d.review_status, '') <> 'rejected')
            ORDER BY o2.ordered_at ASC NULLS LAST, o2.id
            LIMIT $3
         ) s
        WHERE o.id = s.order_id AND o.status IN ('ordered', 'not_ordered')`,
      [codes, kinds, cap]);
    out.documentsIn = docs.rowCount;
  } catch (e) {
    out.ok = false; out.reason = (e && e.message) || String(e);
    console.warn('[lt-orders] condition sweep failed:', out.reason);
  }
  return out;
}

module.exports = {
  onDocumentFiled, onConditionSatisfied, onConditionReopened, sweepOnce,
  _internals: { kindsForCode, codeKindPairs },
};

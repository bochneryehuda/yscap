'use strict';
/**
 * Credit-condition completeness + auto-clear (IG-W2, owner-directed 2026-07-24).
 *
 * The owner's wiring instruction for the "Credit report" condition (cond 1015 /
 * rtl_cond_credit): clear it from PILOT's OWN data — but ONLY when it is genuinely
 * complete: EVERY borrower the condition covers has a report imported here AND the
 * report's PDF is filed. Never a false-clear.
 *
 * `creditCompleteness(client, appId, fieldKey)` answers "is this credit condition
 * fully satisfied by the data?" It replicates the sign-off gate's need[] logic
 * (staff.js: the co-borrower marker condition needs the co-borrower; the file-level
 * condition needs the primary plus any co-borrower without their OWN marked
 * condition) and adds a STRICTER document requirement than the gate: each covered
 * borrower must have a completed `credit_reports` row whose `pdf_document_id` points
 * at a CURRENT, non-rejected document — so we never auto-clear off a data-only pull
 * whose PDF failed to store.
 *
 * `maybeAutoSatisfyCredit(client, appId, itemId, fieldKey)` clears the condition
 * (system sign-off, `signed_off_by=NULL` — we never fake a human) ONLY when
 * complete AND the env kill-switch is ON (`CREDIT_AUTOCLEAR_ENABLED`, default OFF).
 * Best-effort: it NEVER throws, so a credit import can never fail because of it.
 *
 * The db/286 trigger reopens an auto-cleared credit condition if the co-borrower on
 * the file changes, so a swap can never leave the OLD borrower's report standing in
 * for the NEW one.
 */
const cfg = require('../../config');
const { enqueueChecklistStatusPush } = require('../../clickup/enqueue');
const { CO_CREDIT_MARKER } = require('./co-condition');

/**
 * Which borrowers a credit condition covers, and whether each has a complete
 * (report + filed PDF) import. Mirrors staff.js signOffGate's isCredit need[].
 *
 * `itemId` is optional but SHOULD be passed: it is what lets this read the
 * condition's credit-import WAIVER (owner-directed 2026-08-03 — a current report
 * obtained elsewhere, accepted on the condition, with an admin-approved
 * exception). The gate short-circuits on exactly the same predicate, so passing
 * the item is what keeps "may this be signed off?" and "does PILOT think it is
 * complete?" from disagreeing — a PILOT badge reading "not ready" on a condition
 * the gate will happily clear is the one thing this must never do. Without an
 * item there is no waiver to find and the strict import rule is reported, which
 * is the safe answer.
 *
 * @returns {Promise<{need:string[], unmetReport:string[], unmetPdf:string[], complete:boolean, waived:boolean}>}
 */
async function creditCompleteness(client, appId, fieldKey, itemId) {
  // An APPROVED waiver with an accepted report on the condition IS completeness
  // for this condition — there is no import to wait for, by an admin's decision.
  if (itemId && await require('./waiver').creditWaiverActive(itemId, client)) {
    return { need: [], unmetReport: [], unmetPdf: [], complete: true, waived: true };
  }
  const af = (await client.query(
    'SELECT borrower_id, co_borrower_id FROM applications WHERE id=$1', [appId])).rows[0] || {};

  const need = [];
  if (fieldKey === CO_CREDIT_MARKER) {
    if (af.co_borrower_id) need.push(af.co_borrower_id);
  } else {
    if (af.borrower_id) need.push(af.borrower_id);
    if (af.co_borrower_id) {
      // The co-borrower is covered HERE only if they don't have their own
      // (marked) credit condition — otherwise that condition covers them.
      const coOwn = await client.query(
        `SELECT 1 FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`,
        [appId, CO_CREDIT_MARKER]);
      if (!coOwn.rows[0]) need.push(af.co_borrower_id);
    }
  }

  const unmetReport = [];
  const unmetPdf = [];
  for (const bid of need) {
    // A completed report for this borrower whose PDF is a CURRENT, non-rejected
    // document. `documents.is_current` + `review_status` guard against clearing off
    // a report whose PDF was later superseded/rejected, and pdf_document_id NULL
    // means the PDF never stored (data-only pull) — not complete.
    const done = (await client.query(
      `SELECT 1
         FROM credit_reports cr
         JOIN documents d ON d.id = cr.pdf_document_id
        WHERE cr.application_id=$1 AND cr.borrower_id=$2 AND cr.status='completed'
          AND cr.pdf_document_id IS NOT NULL
          AND d.is_current = true
          AND COALESCE(d.review_status,'') <> 'rejected'
        LIMIT 1`, [appId, bid])).rows[0];
    if (done) continue;

    // Distinguish "no completed report at all" from "report but no filed PDF" so
    // the caller / tests can tell why it isn't complete.
    const anyReport = (await client.query(
      `SELECT 1 FROM credit_reports
        WHERE application_id=$1 AND borrower_id=$2 AND status='completed' LIMIT 1`,
      [appId, bid])).rows[0];
    if (anyReport) unmetPdf.push(String(bid)); else unmetReport.push(String(bid));
  }

  const complete = need.length > 0 && unmetReport.length === 0 && unmetPdf.length === 0;
  return { need: need.map(String), unmetReport, unmetPdf, complete, waived: false };
}

/**
 * Auto-clear a credit condition when it is provably complete. Gated on the env
 * kill-switch (default OFF). Never throws.
 *
 * @returns {Promise<{enabled:boolean, satisfied:boolean, complete:boolean, reason?:string}>}
 */
async function maybeAutoSatisfyCredit(client, appId, itemId, fieldKey) {
  const out = { enabled: !!cfg.creditAutoclearEnabled, satisfied: false, complete: false };
  try {
    if (!out.enabled) { out.reason = 'disabled'; return out; }
    if (!itemId) { out.reason = 'no_item'; return out; }

    // Only touch an actual, not-yet-cleared credit condition.
    const item = (await client.query(
      `SELECT ci.id, ci.status, ci.signed_off_at, ci.field_key
         FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.id=$1 AND ci.application_id=$2 AND t.code='rtl_cond_credit'
        LIMIT 1`, [itemId, appId])).rows[0];
    if (!item) { out.reason = 'not_credit_condition'; return out; }
    if (item.status === 'satisfied' && item.signed_off_at) { out.reason = 'already_satisfied'; return out; }

    const c = await creditCompleteness(client, appId, item.field_key || fieldKey, itemId);
    out.complete = c.complete;
    out.waived = !!c.waived;
    if (!c.complete) { out.reason = 'incomplete'; return out; }

    // Clear it as a SYSTEM sign-off: signed_off_by stays NULL (we never fake a
    // human's name on the file), status=satisfied, an [auto] note that a later
    // sync will not clobber a hand-typed note over. The note says WHICH of the two
    // ways it cleared — an import, or an approved waiver on a report obtained
    // elsewhere — because a file that never had a report pulled must never read
    // as though one was.
    const note = c.waived
      ? '[auto] Credit report accepted from another source with an APPROVED exception (no credit was imported here) — condition cleared.'
      : '[auto] Credit report imported for every borrower on the file (report + PDF on file) — condition cleared.';
    await client.query(
      `UPDATE checklist_items
          SET status='satisfied', signed_off_at=now(), signed_off_by=NULL,
              notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END,
              updated_at=now()
        WHERE id=$1`, [itemId, note]);
    out.satisfied = true;
    enqueueChecklistStatusPush(itemId).catch(() => {});
    return out;
  } catch (e) {
    console.error('[credit] maybeAutoSatisfyCredit', appId, itemId, e && e.message);
    out.reason = 'error';
    return out;
  }
}

module.exports = { creditCompleteness, maybeAutoSatisfyCredit };

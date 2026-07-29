'use strict';
/**
 * Signed-term-sheet condition ADVISORY signal (IG-W13, owner-directed 2026-07-24).
 *
 * The "Signed term sheet" condition (rtl_cond_signedts) asks for the borrower-signed term
 * sheet — filed automatically by the e-sign integration (a term_sheet_signed document on the
 * condition) or uploaded manually. PILOT NEVER signs this condition off itself — a human
 * always clears a Condition Center condition (the owner-directed reversal). Instead PILOT
 * lays an ADVISORY on top of the human layer (pilot-advice-engine), telling the loan officer
 * whether the signed term sheet is on file. Advisory only — this clears nothing and blocks
 * nothing.
 *
 * "PILOT has the signed term sheet" is the SAME strict, provable state the sign-off gate
 * uses. rtl_cond_signedts is an ordinary required document condition (no tool_key, not one of
 * the specially-handled codes), so its sign-off gate is the GENERIC required-document check
 * in staff.js signOffGate: at least ONE CURRENT, non-rejected document on the checklist item.
 * Reused here 1:1 so the advisory can never disagree with the gate.
 *
 * There is no document_findings source for a term sheet — so no "positive contradiction"
 * signal exists. A term sheet that no longer matches the deal (economics changed, verified
 * experience dropped) is REOPENED — the condition is un-signed by the economics/experience
 * triggers (db/288 + experience.js) — so a signed-off condition can never coexist with a
 * stale term sheet. That means the DISPUTE verdict (signed-off + positive contradiction) is
 * unreachable; contradicted is always false (ready/not_ready/agree only, never a false
 * dispute — wiring contradicted to the transient stale flag would risk a race-window false
 * dispute). Never throws.
 */

/**
 * Is a signed term sheet on file for THIS condition — a current, non-rejected document on
 * the checklist item (the exact predicate the generic required-document sign-off gate reads)?
 * @param {*} client
 * @param {string} itemId  the rtl_cond_signedts checklist_items id
 * @returns {Promise<{hasDoc:boolean, complete:boolean}>}
 */
async function signedTermSheetCompleteness(client, itemId) {
  const out = { hasDoc: false, complete: false };
  if (!itemId) return out;
  try {
    const r = await client.query(
      `SELECT 1 FROM documents
        WHERE checklist_item_id = $1 AND is_current = true
          AND COALESCE(review_status,'') <> 'rejected'
        LIMIT 1`, [itemId]);
    out.hasDoc = !!r.rows[0];
    out.complete = out.hasDoc;
  } catch (e) {
    console.error('[signed-term-sheet-advisory] signedTermSheetCompleteness', itemId, e && e.message);
  }
  return out;
}

module.exports = { signedTermSheetCompleteness };

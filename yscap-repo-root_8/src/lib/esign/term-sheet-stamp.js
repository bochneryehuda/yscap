'use strict';

/**
 * esign/term-sheet-stamp.js — is the term sheet about to be generated the FINAL
 * one? (owner-directed 2026-08-02.)
 *
 * THE REPORT: "the term sheet that is going out from the actual loan file from
 * the DocuSign section, after everything is ready and we're sending out the
 * official term sheet, still says NOT FINAL / initial only. That term sheet
 * should be the FINAL term sheet, because that is what goes to everybody
 * through DocuSign after you finished all the required steps."
 *
 * ROOT CAUSE — the INITIAL/FINAL wording is PRINTED INTO the PDF. The static
 * tool (web/v2/tools/termsheet.js) draws the provenance badge, the header title
 * ("Final Term Sheet" vs "Preliminary Term Sheet"), the "INITIAL TERM SHEET —
 * NOT FINAL" line and the per-page identity footer from ONE flag, `provFinal`,
 * which the portal host passes in at GENERATION time. The staff pricing route
 * computed that flag from `esignSendGate(...).ready`, and `ready` includes the
 * `rtl_p1_product` (Product & pricing) CONDITION SIGN-OFF. That sign-off is the
 * step that FOLLOWS the registration — and the term sheet PDF is captured
 * DURING the registration, before anybody has signed anything off. So the flag
 * was false essentially every time: every sheet on every file was stamped
 * "INITIAL TERM SHEET — NOT FINAL", the DocuSign package attaches the stored
 * `term_sheet` document exactly as it is, and the sheet the borrower signed
 * always said it was not final.
 *
 * THE RULE HERE — a term sheet is stamped FINAL when every send-gate
 * requirement is met EXCEPT the product & pricing sign-off, because registering
 * IS that step and requiring its sign-off would make a FINAL stamp unreachable.
 * An APPROVED send-before-CTC exception counts exactly as it does for the send
 * itself (a waived blocker is not a blocker), so a file cleared to send by
 * exception issues a FINAL sheet instead of being stuck on an initial one.
 *
 * NOTHING UNSAFE ISSUES BECAUSE OF THAT ONE OMISSION. The two halves meet:
 *   · the real SEND gate (gate.js) still enforces the P&P sign-off in full, and
 *   · orchestrate.js additionally REFUSES to mail a term sheet that is not
 *     recorded as FINAL-stamped (`documents.term_sheet_final`, db/403).
 * So only a final-stamped sheet can go out, and a sheet is stamped final only
 * when everything but the imminent sign-off is done.
 *
 * Fails CLOSED — anything unreadable stamps INITIAL, which is the honest
 * wording and blocks nothing that was not already blocked.
 */

// db + gate are required LAZILY (inside termSheetStamp) so the pure rule below —
// and the wording constants the panels and the send refusal share — load with no
// database anywhere in reach, the same discipline gate-disposition.js keeps.

/**
 * The one requirement deliberately NOT required at STAMP time (see the header).
 * It is still fully enforced by the send gate, so it can never let a package go
 * out early — it only stops the stamp from being permanently unreachable.
 */
const IGNORED_AT_STAMP = new Set(['rtl_p1_product']);

/**
 * PURE — the whole rule, over a send-gate disposition (gate-disposition.js
 * shape). Kept separate from the DB read below for the same reason gate.js and
 * gate-disposition.js are split: the rule that decides what a legal document
 * says about itself is worth unit-testing without a database.
 *
 * @returns {{final:boolean, blockers:Array}}
 */
function stampFromDisposition(dispo) {
  const blockers = ((dispo && dispo.outstanding) || [])
    .filter((o) => o && !o.waived && !IGNORED_AT_STAMP.has(o.code));
  return { final: blockers.length === 0, blockers };
}

/**
 * @returns {Promise<{final:boolean, blockers:Array, unreadable:boolean}>}
 *   final      — the sheet may print the FINAL stamp.
 *   blockers   — what still stands in the way (send-gate shape: code/label/reason).
 *   unreadable — the gate could not be read; stamped initial, never final.
 */
async function termSheetStamp(applicationId, { db } = {}) {
  let dispo;
  try {
    const client = db || require('../../db');
    dispo = await require('./gate').esignSendGate(applicationId, { db: client, purpose: 'term_sheet_package' });
  } catch (_) {
    return { final: false, blockers: [], unreadable: true };
  }
  return { ...stampFromDisposition(dispo), unreadable: false };
}

/** Plain-language "why is this sheet still stamped initial" for the staff UI. */
function stampReason(blockers) {
  const labels = (blockers || []).map((b) => b && (b.label || b.code)).filter(Boolean);
  if (!labels.length) return 'The term sheet on file was generated before this file was ready to issue.';
  return `Still outstanding: ${labels.join(', ')}.`;
}

/**
 * The message shown when a package cannot be sent because the term sheet on
 * file prints the initial wording. Actionable on purpose — re-registering in the
 * Term Sheet Studio regenerates and re-attaches the sheet, which is the same
 * "re-register on the appraised value" step the gate already asks for.
 */
const REGENERATE_MESSAGE =
  'The Term Sheet on file is stamped "INITIAL TERM SHEET — NOT FINAL", so it cannot go out for signature. '
  + 'Open Products & Pricing and re-register the product — that regenerates and re-attaches the term sheet as the FINAL one — then send.';

module.exports = { termSheetStamp, stampFromDisposition, stampReason, IGNORED_AT_STAMP, REGENERATE_MESSAGE };

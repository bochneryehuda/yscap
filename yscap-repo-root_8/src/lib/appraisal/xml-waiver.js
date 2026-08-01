'use strict';
/**
 * The "No appraisal XML" waiver — the ONE shared predicate both gates read to
 * decide whether a file's appraisal has been received-and-reviewed BY HAND.
 *
 * Owner-directed 2026-07-30: on a file with no appraisal XML we cannot run the
 * PILOT appraisal review, so the reviewer records "No XML available", types the
 * As-Is + ARV by hand (which re-prices the loan), and — for a transferred
 * appraisal, or once an admin approves the exception — that COUNTS AS receiving
 * and reviewing the appraisal. It lets the appraisal-documents condition clear
 * (the XML slot is waived; the PDF stays required) AND stands in for the internal
 * appraisal review so the term sheet can go out. "The same logic we have when we
 * sign off the actual XML documents slot."
 *
 * Two gates consult this: the condition sign-off gate (src/routes/staff.js) and
 * the term-sheet send gate (src/lib/esign/gate.js). Sharing ONE predicate is what
 * keeps them from ever drifting.
 *
 * It is deliberately the DOCUMENT-INDEPENDENT half of the rule: the PDF-slot
 * requirement stays on the appraisal-documents condition's own sign-off (a term
 * sheet can't require a specific upload slot, and the send gate already blocks on
 * that condition being satisfied). It FAILS CLOSED — an unreadable waiver is
 * treated as absent, never as a silent bypass.
 */
const dbDefault = require('../../db');

/**
 * Load the file's no-XML waiver plus the state the gates judge it on. Never throws.
 * Returns { present:false } when there is no waiver; otherwise:
 *   present:true, reason, requiresTransferLetter, exceptionId, exceptionApproved,
 *   asIs, arv (the values now ON THE FILE — the waiver mirrors them there),
 *   valuesOnFile (both file As-Is and ARV > 0),
 *   effective  — the waiver COUNTS: a transfer OR an approved exception, AND the
 *                hand-entered values are on the file.
 */
async function loadWaiver(appId, db = dbDefault) {
  if (!appId) return { present: false };
  try {
    const w = (await db.query(
      `SELECT reason, requires_transfer_letter, exception_id
         FROM appraisal_xml_waivers WHERE application_id=$1`, [appId])).rows[0];
    if (!w) return { present: false };
    const av = (await db.query(
      `SELECT as_is_value, arv FROM applications WHERE id=$1`, [appId])).rows[0] || {};
    const asIs = Number(av.as_is_value);
    const arv = Number(av.arv);
    const valuesOnFile = Number.isFinite(asIs) && asIs > 0 && Number.isFinite(arv) && arv > 0;
    let exceptionApproved = false;
    if (w.exception_id) {
      const ex = (await db.query(`SELECT status FROM loan_exceptions WHERE id=$1`, [w.exception_id])).rows[0];
      exceptionApproved = !!(ex && ex.status === 'approved');
    }
    // A transferred appraisal auto-waives (no exception). Every other reason needs
    // its policy exception APPROVED. Either way the hand-entered values must be on
    // the file — with no XML there is nothing to read them from.
    const cleared = !!w.requires_transfer_letter || exceptionApproved;
    return {
      present: true,
      reason: w.reason,
      requiresTransferLetter: !!w.requires_transfer_letter,
      exceptionId: w.exception_id || null,
      exceptionApproved,
      asIs: Number.isFinite(asIs) ? asIs : null,
      arv: Number.isFinite(arv) ? arv : null,
      valuesOnFile,
      effective: cleared && valuesOnFile,
    };
  } catch (_) {
    return { present: false };   // fail closed — an unreadable waiver is never a bypass
  }
}

/**
 * True when a VALID no-XML waiver stands in for the appraisal: the hand-entered
 * As-Is + ARV are on the file AND the waiver is cleared (a transfer, or an
 * approved exception). This is the "the appraisal has been received and reviewed
 * by hand" signal both gates use.
 */
async function noXmlWaiverActive(appId, db = dbDefault) {
  const w = await loadWaiver(appId, db);
  return !!w.effective;
}

module.exports = { loadWaiver, noXmlWaiverActive };

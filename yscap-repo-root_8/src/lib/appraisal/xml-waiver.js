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
 * THE REASONS THAT CLEAR THEMSELVES, and why there are now two of them.
 *
 * The original rule (2026-07-29) was that a TRANSFERRED appraisal auto-waives —
 * because there is a real appraisal, it simply arrived from another lender without
 * its data file, and a transfer letter proves it. Every other reason ("the
 * appraiser won't send it", "it was a desk appraisal") is a one-off that a human
 * has to justify, so it opens a policy exception for an admin to approve.
 *
 * `hybrid_appraisal` is the SECOND self-clearing reason, and it is the strongest
 * of the three: it is not a report that happens to be missing its data file, it is
 * a PRODUCT THAT HAS NO DATA FILE AT ALL. Richer Values's Hybrid Appraisal is an
 * evaluation — it returns a PDF and structured figures over their API, and there
 * has never been a MISMO XML to ask for. Sending that to an admin as an exception
 * would ask them to approve the same fact on every single order forever, which is
 * a queue nobody reads rather than a control.
 *
 * WHAT STILL BINDS, and this is the part that keeps it honest: the PDF is STILL
 * required on the condition, and the As-Is and the ARV must STILL be on the file
 * before it can be signed off. The waiver lifts the XML requirement and nothing
 * else. Ordering the product is what records this reason — a person cannot pick it
 * by hand (it is deliberately not in the manual reason list in routes/staff.js),
 * because the claim it makes is "an order for a no-XML product exists on this
 * file", and only the order desk can know that.
 */
const AUTO_CLEAR_REASONS = new Set(['transferred_appraisal', 'hybrid_appraisal']);
/** The one reason a vendor order records for itself. */
const PRODUCT_NO_XML_REASON = 'hybrid_appraisal';

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
    // A transferred appraisal and a no-XML PRODUCT both auto-waive (no exception);
    // see AUTO_CLEAR_REASONS. Every other reason needs its policy exception
    // APPROVED. Either way the values must be on the file — with no XML there is
    // nothing to read them from.
    //
    // `requires_transfer_letter` is still honoured on its own so a waiver recorded
    // before this list existed behaves exactly as it always did.
    const autoCleared = AUTO_CLEAR_REASONS.has(String(w.reason || ''));
    const cleared = !!w.requires_transfer_letter || exceptionApproved || autoCleared;
    return {
      present: true,
      reason: w.reason,
      requiresTransferLetter: !!w.requires_transfer_letter,
      // TRUE when the reason itself settles the waiver, so a screen can explain
      // why nothing is waiting on an admin instead of leaving a blank.
      autoCleared,
      // TRUE for the one reason that means "this product has no data file",
      // which is what lets a surface word it as a fact rather than a waiver.
      productHasNoXml: String(w.reason || '') === PRODUCT_NO_XML_REASON,
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

/**
 * RECORD THE WAIVER FOR A PRODUCT THAT HAS NO DATA FILE — the one door an ORDER
 * DESK uses. Called when a Hybrid Appraisal order is placed, so the file stops
 * asking for an XML that is never coming.
 *
 * FIVE THINGS IT REFUSES TO DO, each of them the reason this is a function rather
 * than an INSERT at the call site:
 *
 *   1. IT NEVER OVERWRITES A WAIVER A HUMAN RECORDED. A reviewer who already
 *      recorded "the appraiser won't send the XML", with a note and an exception
 *      an admin is looking at, has made a decision about this file; replacing it
 *      with an automatic one would silently withdraw the exception and erase why.
 *      An existing waiver of ANY reason is left exactly as it is.
 *   2. IT NEVER APPLIES TO A FILE THAT HAS AN IMPORTED APPRAISAL. A current
 *      appraisal means there IS XML on this file, so "no XML available" would be
 *      a false claim — the same refusal the manual route makes, for the same
 *      reason. (Ordering a cheaper evaluation alongside a real appraisal is a
 *      legitimate thing to do; it just does not waive anything.)
 *   3. IT WRITES NO VALUES. The As-Is and the ARV arrive with the finished report
 *      and go on the file through the shared As-Is desk, which validates them,
 *      respects the file freeze and audits. Until then the waiver is recorded but
 *      NOT effective, which is exactly right: the condition still cannot be signed
 *      off, and it says why.
 *   4. IT OPENS NO EXCEPTION. The reason is self-clearing (see AUTO_CLEAR_REASONS).
 *   5. IT NEVER THROWS. A waiver that could not be recorded must not fail the
 *      order — the order is the thing that costs money, and a missing waiver is
 *      visible and fixable on the condition.
 *
 * @returns {Promise<{applied:boolean, reason:string}>} `applied` is true only when
 *          THIS call created the row, which is what the caller stamps on the order
 *          so removing that order can only ever withdraw its own waiver.
 */
async function applyProductNoXmlWaiver(appId, { note = null, staffId = null, db = dbDefault } = {}) {
  if (!appId) return { applied: false, reason: 'no_application' };
  try {
    const existing = (await db.query(
      `SELECT reason FROM appraisal_xml_waivers WHERE application_id=$1`, [appId])).rows[0];
    if (existing) {
      return {
        applied: false,
        reason: existing.reason === PRODUCT_NO_XML_REASON ? 'already_applied' : 'human_waiver_present',
      };
    }
    const imported = (await db.query(
      `SELECT 1 FROM appraisals WHERE application_id=$1 AND superseded=false LIMIT 1`, [appId])).rows[0];
    if (imported) return { applied: false, reason: 'appraisal_imported' };

    await db.query(
      `INSERT INTO appraisal_xml_waivers
         (application_id, reason, note, requires_transfer_letter, exception_id, waived_by, updated_at)
       VALUES ($1, $2, $3, false, NULL, $4, now())
       ON CONFLICT (application_id) DO NOTHING`,
      [appId, PRODUCT_NO_XML_REASON, note ? String(note).slice(0, 2000) : null, staffId || null]);

    // Nudge the appraisal-documents condition so it reads "in progress" rather
    // than outstanding — the same nudge the manual waiver route makes, so the two
    // doors leave the condition in the same state.
    await db.query(
      `UPDATE checklist_items SET status=CASE WHEN status='outstanding' THEN 'received' ELSE status END, updated_at=now()
        WHERE application_id=$1 AND template_id IN (SELECT id FROM checklist_templates WHERE code='rtl_cond_appraisaldocs')`,
      [appId]);

    return { applied: true, reason: 'applied' };
  } catch (e) {
    console.error('[appraisal] product no-XML waiver failed (non-fatal):', e && e.message);
    return { applied: false, reason: 'error' };
  }
}

/**
 * WITHDRAW a waiver THIS system recorded — used when the order that justified it
 * is cancelled, so a file does not keep a waiver whose reason has gone away.
 *
 * It removes ONLY a row carrying the product reason. A waiver a human recorded is
 * theirs; cancelling an order is not a decision about it. Never throws.
 */
async function withdrawProductNoXmlWaiver(appId, { db = dbDefault } = {}) {
  if (!appId) return { removed: false };
  try {
    const r = await db.query(
      `DELETE FROM appraisal_xml_waivers WHERE application_id=$1 AND reason=$2`,
      [appId, PRODUCT_NO_XML_REASON]);
    return { removed: r.rowCount > 0 };
  } catch (e) {
    console.error('[appraisal] product no-XML waiver withdraw failed (non-fatal):', e && e.message);
    return { removed: false };
  }
}

module.exports = {
  loadWaiver, noXmlWaiverActive,
  applyProductNoXmlWaiver, withdrawProductNoXmlWaiver,
  AUTO_CLEAR_REASONS, PRODUCT_NO_XML_REASON,
};

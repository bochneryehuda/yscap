'use strict';
/**
 * The CREDIT "no import — the report came from elsewhere" waiver: the ONE shared
 * predicate every surface reads to decide whether a credit condition may clear
 * without a report imported here.
 *
 * Owner-directed 2026-08-03: "On the credit report condition we only have an
 * Import button. We should also have a button to upload a PDF, and after they
 * upload a PDF they can request an exception to waive — and the admin should sign
 * off the condition even if they didn't reissue the credit. Say they got a credit
 * report from somewhere else and they don't want to reissue."
 *
 * THE DEFAULT RULE IS UNCHANGED. The credit condition still requires a real
 * IMPORTED report for every borrower it covers — "a bare PDF upload is not
 * enough" (owner-directed 2026-07-23) — because only an import files the PDF AND
 * the data file AND reads the scores that price the deal. This module is the ONE
 * recorded way through that rule, and it takes BOTH halves of the owner's
 * sentence, never one:
 *
 *   1. AN ACCEPTED REPORT IS ON THE CONDITION. Not merely uploaded — ACCEPTED, by
 *      the standard in lib/document-acceptance.js. That is what the owner tied the
 *      TPR/SharePoint half of the instruction to ("the PDF if it's accepted"), and
 *      it is the same document that then ships in the investor package. Waiving the
 *      import on a PDF nobody has opened would clear the condition on nothing.
 *   2. AN ADMIN APPROVED THE EXCEPTION. Every reason needs approval — unlike the
 *      appraisal no-XML waiver (db/370), which auto-waives for a transferred
 *      appraisal, there is deliberately no self-approving reason here. The waiver
 *      ROW alone grants nothing; the decision does.
 *
 * The waiver is keyed on the CREDIT CONDITION, not the file, because a file can
 * carry two of them — the file-level condition and a co-borrower's own
 * (field_key 'cob_credit') — and waiving the import for one borrower must never
 * quietly waive it for the other.
 *
 * It FAILS CLOSED: an unreadable waiver, a missing table, a database hiccup — all
 * read as "no waiver", which is the strict rule, never a silent bypass.
 */
const dbDefault = require('../../db');
const docAccept = require('../document-acceptance');

/**
 * A credit report a HUMAN filed on the condition, as opposed to the two documents
 * the importer files itself (`credit_pdf` — the readable report — and `credit_xml`
 * — the machine-readable data file). A human upload comes through the ordinary
 * staff document door, which sets no doc_kind, so "not one of the importer's own
 * kinds" is the identity. Deliberately NOT keyed on the slot label: a label is
 * typed by a person and a report filed under any wording is still the report.
 *
 * `alias` is the documents table alias ('' for an unaliased FROM documents).
 */
const UPLOADED_REPORT_SQL = (alias) => {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(${a}doc_kind,'') NOT IN ('credit_xml','credit_pdf')`;
};

/**
 * Load a credit condition's waiver plus the state the gate judges it on. Never
 * throws.
 *
 * Returns { present:false } when the condition has no waiver; otherwise:
 *   present:true, reason, note, exceptionId, exceptionStatus, exceptionApproved,
 *   uploadedCount     — reports a human filed here, whatever their review state,
 *   acceptedCount     — how many of those a reviewer has ACCEPTED,
 *   hasAcceptedReport — acceptedCount > 0,
 *   effective         — the waiver COUNTS: approved AND an accepted report is on
 *                       the condition. This is the only field a gate should read.
 */
async function loadWaiver(itemId, db = dbDefault) {
  if (!itemId) return { present: false };
  try {
    const w = (await db.query(
      `SELECT application_id, reason, note, exception_id
         FROM credit_import_waivers WHERE checklist_item_id=$1`, [itemId])).rows[0];
    if (!w) return { present: false };

    const docs = (await db.query(
      `SELECT count(*)::int AS uploaded,
              count(*) FILTER (WHERE ${docAccept.ACCEPTED_SQL('')})::int AS accepted
         FROM documents
        WHERE checklist_item_id=$1 AND is_current=true AND ${UPLOADED_REPORT_SQL('')}`,
      [itemId])).rows[0] || { uploaded: 0, accepted: 0 };

    let exceptionStatus = null;
    if (w.exception_id) {
      const ex = (await db.query(
        `SELECT status FROM loan_exceptions WHERE id=$1`, [w.exception_id])).rows[0];
      exceptionStatus = (ex && ex.status) || null;
    }
    const exceptionApproved = exceptionStatus === 'approved';
    const hasAcceptedReport = (docs.accepted || 0) > 0;
    return {
      present: true,
      applicationId: w.application_id,
      reason: w.reason,
      note: w.note || null,
      exceptionId: w.exception_id || null,
      exceptionStatus,
      exceptionApproved,
      uploadedCount: docs.uploaded || 0,
      acceptedCount: docs.accepted || 0,
      hasAcceptedReport,
      effective: exceptionApproved && hasAcceptedReport,
    };
  } catch (_) {
    return { present: false };   // fail closed — an unreadable waiver is never a bypass
  }
}

/**
 * True when an APPROVED waiver stands in for the credit import on this condition:
 * the exception is approved AND an accepted credit report is filed here. The
 * sign-off gate and the completeness/advice reader both call this, so "may this
 * be signed off?" and "does PILOT think it is complete?" can never disagree.
 */
async function creditWaiverActive(itemId, db = dbDefault) {
  const w = await loadWaiver(itemId, db);
  return !!w.effective;
}

/**
 * Why a present-but-not-yet-effective waiver is not counting, in the words the
 * condition surface and the sign-off refusal both use. Returns null when the
 * waiver IS effective (or there is none — the caller's normal rule applies).
 */
function pendingReason(w) {
  if (!w || !w.present || w.effective) return null;
  if (!w.exceptionApproved) {
    if (w.exceptionStatus === 'denied') {
      return 'The exception to sign this off without importing credit was DENIED — import the credit report here, or request a new exception.';
    }
    if (w.exceptionStatus === 'withdrawn') {
      return 'The exception to sign this off without importing credit was withdrawn — import the credit report here, or request a new exception.';
    }
    return 'The exception to sign this off without importing credit is still waiting for an admin to approve it.';
  }
  return w.uploadedCount > 0
    ? 'The exception is approved, but the uploaded credit report has not been accepted yet — open it and accept it first.'
    : 'The exception is approved, but there is no credit report uploaded on this condition to stand in for the import.';
}

module.exports = { loadWaiver, creditWaiverActive, pendingReason, UPLOADED_REPORT_SQL };

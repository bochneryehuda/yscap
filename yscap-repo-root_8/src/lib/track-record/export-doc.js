'use strict';

/**
 * THE TRACK-RECORD EXPORT A STAFFER PRESSES — Excel or PDF, in one of three scopes
 * (owner-directed 2026-08-21, item 7).
 *
 * The owner: *"the regular export button (PDF or Excel) should only export the verified ones.
 * There should be an extra option to export the PDF or an Excel from the unverified ones, but
 * everything that is unverified should have a stamp that it's not verified yet."*
 *
 * WHAT WAS THERE BEFORE. The only place that built a track-record Excel + PDF was
 * `tpr-export`, buried inside the investor package — verified-only since 2026-08-12, and
 * reachable only by exporting the whole TPR zip on a loan file. There was no way to hand
 * somebody the borrower's track record on its own, in any scope.
 *
 * WHAT IS SHARED, AND WHY IT MATTERS. The rows, the sections, the columns, the review
 * statuses, the records stamp and both writers are the SAME ones the investor package uses —
 * only the WHERE clause and the stated scope differ. So a report an officer downloads and the
 * one the investor received cannot come to disagree about the same borrower's record, which is
 * exactly what a second copy of this would have produced the first time a column changed.
 *
 * READ-ONLY: it selects and renders. It writes nothing, files nothing, and mails nothing.
 */

// The pool is reached LAZILY: this module states the export rule, and a test (or any caller
// that passes its own client) must be able to load it with no database in reach.
const getDb = () => require('../../db');
const SCOPE = require('./export-scope');

/** What one export is called. The scope is in the NAME as well as on the page, so two
 *  downloads in a folder are told apart without opening them. */
function exportFilename(borrowerName, scope, format, day) {
  const who = String(borrowerName || 'Borrower').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Borrower';
  const tag = scope === 'verified' ? 'Verified' : scope === 'unverified' ? 'Unverified' : 'All';
  return `${who} — Track Record (${tag}) ${day}.${format === 'pdf' ? 'pdf' : 'xlsx'}`;
}

/**
 * Build one borrower's track-record export.
 *
 * @param {string[]} borrowerIds  the borrower, plus any co-borrower whose record belongs here
 * @param {object}   opts { scope, format, borrowerName, client }
 * @returns {Promise<{filename, contentType, data, rows, scope, format}>}
 */
async function buildBorrowerTrackRecordExport(borrowerIds, opts = {}) {
  const c = opts.client || getDb();
  const scope = SCOPE.normalizeScope(opts.scope);
  const format = String(opts.format || 'xlsx').toLowerCase() === 'pdf' ? 'pdf' : 'xlsx';
  const ids = (Array.isArray(borrowerIds) ? borrowerIds : [borrowerIds]).filter(Boolean);
  if (!ids.length) return null;

  const TPR = require('../tpr-export');
  const stamps = require('./records-stamp');
  // The SAME columns the investor package selects, and the SAME ordering.
  /* ONE QUERY, AND THE SCOPE IS A COLUMN RATHER THAN A FILTER (owner-directed 2026-08-27).
     The rows this export CARRIES are still chosen by the ONE predicate — it is simply asked as
     `in_scope` instead of as a WHERE, so the same statement also hands back the lines it does
     NOT carry. That is what lets the document name what it held back; filtering them away in
     SQL is exactly why an export could come out a line short and say nothing.
     Postgres evaluates the predicate, so there is no JS twin of it to drift. */
  const all = (await c.query(
    `SELECT id, borrower_id, property_address, deal_type, purchase_price, sale_price, rehab_amount,
            purchase_date, sale_date, rent_amount, rent_date, refi_amount, refi_date, current_value,
            is_verified, verified_at, verification_status, entered_by_kind, notes,
            (${SCOPE.scopePredicate(scope, 't')}) AS in_scope,
            ${stamps.stampSelect('t')}
       FROM track_records t
      WHERE borrower_id = ANY($1::uuid[])
      ORDER BY COALESCE(sale_date, refi_date, rent_date, purchase_date) DESC NULLS LAST, created_at DESC`,
    [ids])).rows;
  const { carried: records, heldBack, total: recordTotal } =
    SCOPE.partitionInScope(all, scope, (r) => TPR.addrText(r && r.property_address));

  // Which lines carry documentation — the same read the package does, so the "Docs" column and
  // the review status mean the same thing on both.
  const docsByTr = {};
  if (records.length) {
    for (const d of await TPR.selectTrackRecordDocs(records.map((r) => r.id))) {
      (docsByTr[d.track_record_id] = docsByTr[d.track_record_id] || []).push(d);
    }
  }

  const sections = require('./export-build').buildTrackRecordSections(records, docsByTr);
  const day = new Date().toISOString().slice(0, 10);
  const meta = { borrowerName: opts.borrowerName || '', generatedDate: day, scope, heldBack, recordTotal };
  const trExport = require('../track-record-export');

  const filename = exportFilename(opts.borrowerName, scope, format, day);
  if (format === 'pdf') {
    const data = await trExport.buildTrackRecordPdf(sections, meta);
    return { filename, contentType: 'application/pdf', data, rows: records.length, heldBack, recordTotal, scope, format };
  }
  const data = TPR.buildXlsx(trExport.trackRecordAoa(sections, meta), 'Track Record');
  return {
    filename,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    data, rows: records.length, heldBack, recordTotal, scope, format,
  };
}

module.exports = { buildBorrowerTrackRecordExport, exportFilename };

'use strict';
/**
 * LONG-TERM — THE BOOK. Every long-term file, with the four things the owner asked
 * for, and an honest account of everything this rule could not place.
 *
 * The owner (2026-08-16): *"Give me a breakdown of each and every file that is in
 * our system, only on the long-term side … Every file / Which folder it sits in /
 * Which status it sits in / Which milestone it sits in."*
 *
 * WHY THIS IS NOT JUST THE PIPELINE WITH A FILTER. It shares the pipeline's ONE
 * access rule (`access.pipelineScopeSql`, composed rather than re-written — a
 * second scope is how a list shows a file its own file screen then refuses), but
 * it answers a different question. The pipeline is a work queue: it pages, it
 * sorts, it narrows to what is live. This is a CENSUS — it must account for every
 * loan the long-term side has mirrored, including the ones the rule cannot place,
 * because a census that quietly drops what it could not classify is the thing the
 * owner would then have to discover for themselves.
 *
 * SO NOTHING IS SILENTLY DROPPED. Four buckets, and a loan is in exactly one:
 *   longTerm  — the answer to the question (term over 36 months)
 *   shortTerm — RTL, excluded on purpose, counted so the totals reconcile
 *   boundary  — EXACTLY 36 months: the owner's rule covers under and over and not
 *               36 itself, so these are listed for a decision rather than guessed
 *   unknown   — no program signal and no term: we cannot tell, and say so
 * `longTerm + shortTerm + boundary + unknown === total`, asserted by the test.
 *
 * THE RULE ITSELF IS NOT HERE — it is `product-term.js`, in ONE place, with a JS
 * half and a SQL twin proven to agree. This module only decides WHICH loans to
 * ask about and how to present the answer.
 *
 * THE FOUR COLUMNS, and where each really comes from:
 *   the file    — the Encompass loan number, plus the borrower's name when the
 *                 shared identity record has been linked (LEFT JOIN: a loan whose
 *                 borrower is not linked yet must still be counted, or the census
 *                 under-reports exactly the files that need the mapping work)
 *   the folder  — `loan_folder`, Encompass's own word, stored verbatim
 *   the status  — our stage (`stage_key`), the bucket the pipeline groups by
 *   the milestone — `milestone_name`, Encompass's own word, stored verbatim
 */

const access = require('./access');
const productTerm = require('./product-term');

const lazy = {
  get db() { return require('./db'); },
};

/**
 * The one FROM every read here shares.
 *
 * `lt_loans.borrower_id` and `.loan_officer_id` point at the SHARED identity
 * records (`borrowers`, `staff_users`) — the zone Long-Term is authorized to READ
 * and never write (ledger 2026-08-03). Every join is LEFT for the reason above:
 * an unlinked loan is precisely what this census exists to surface.
 */
const FROM = `
  FROM lt_loans l
  LEFT JOIN borrowers b ON b.id = l.borrower_id
  LEFT JOIN staff_users s ON s.id = l.loan_officer_id`;

const SELECT = `
  SELECT l.id,
         l.loan_number,
         l.encompass_loan_guid,
         l.loan_folder,
         l.stage_key,
         l.milestone_name,
         l.term_months,
         l.program_name,
         l.loan_amount,
         l.borrower_id,
         NULLIF(b.full_name, '')  AS borrower_name,
         l.loan_officer_id,
         NULLIF(s.full_name, '')  AS officer_name,
         l.encompass_synced_at`;

/** One row, shaped for a screen or a spreadsheet, with the verdict attached. */
function shape(row) {
  const verdict = productTerm.classifyProduct({
    programName: row.program_name,
    termMonths: row.term_months,
  });
  return {
    id: row.id,
    loanNumber: row.loan_number || null,
    encompassLoanGuid: row.encompass_loan_guid || null,
    // The owner's four columns.
    file: row.loan_number || row.encompass_loan_guid || '(no loan number)',
    borrowerName: row.borrower_name || null,
    folder: row.loan_folder || null,
    status: row.stage_key || null,
    milestone: row.milestone_name || null,
    // Why it is on this side of the line.
    product: verdict.product,
    reason: verdict.reason,
    why: verdict.why,
    disagrees: verdict.disagrees,
    termMonths: verdict.termMonths,
    programName: verdict.programName,
    // The mapping the owner asked to finalise, reported as it stands.
    loanAmount: row.loan_amount == null ? null : Number(row.loan_amount),
    borrowerLinked: !!row.borrower_id,
    officerLinked: !!row.loan_officer_id,
    officerName: row.officer_name || null,
    syncedAt: row.encompass_synced_at || null,
  };
}

/**
 * The whole book, split by product.
 *
 * Deliberately UNPAGED: it is a census, and the long-term book is ~700 loans
 * (`dictionary/program-taxonomy.json`, 772 across BOTH products). A `cap` guards
 * against a future book that has grown past what one answer should carry, and
 * when it bites it SAYS SO (`capped: true` + the real total) rather than quietly
 * returning a short list — a silent cap on a census is a wrong answer, not a
 * smaller one.
 */
async function longTermBook(viewer, opts = {}) {
  const db = opts.db || lazy.db;
  const cap = Math.min(Math.max(Number(opts.cap) || 2000, 1), 5000);

  const params = [];
  const scope = access.pipelineScopeSql(viewer && viewer.access, viewer && viewer.staffId, 1);
  params.push(...scope.params);
  const where = scope.where ? `WHERE ${scope.where}` : '';

  const totalRow = await db.query(`SELECT count(*)::int AS n ${FROM} ${where}`, params);
  const total = (totalRow.rows[0] && totalRow.rows[0].n) || 0;

  const { rows } = await db.query(
    `${SELECT} ${FROM} ${where}
      ORDER BY l.loan_folder NULLS LAST, l.stage_key NULLS LAST, l.loan_number NULLS LAST
      LIMIT ${cap}`,
    params,
  );

  const out = { longTerm: [], shortTerm: [], boundary: [], unknown: [], disagreements: [] };
  for (const r of rows) {
    const row = shape(r);
    if (row.disagrees) out.disagreements.push(row);
    if (row.product === productTerm.PRODUCT.LONG) out.longTerm.push(row);
    else if (row.product === productTerm.PRODUCT.SHORT) out.shortTerm.push(row);
    else if (row.product === productTerm.PRODUCT.BOUNDARY) out.boundary.push(row);
    else out.unknown.push(row);
  }

  return {
    ...out,
    counts: {
      total,
      read: rows.length,
      longTerm: out.longTerm.length,
      shortTerm: out.shortTerm.length,
      boundary: out.boundary.length,
      unknown: out.unknown.length,
      // The mapping work, counted on the long-term side only — that is the side
      // the owner asked to finalise.
      longTermBorrowerLinked: out.longTerm.filter((r) => r.borrowerLinked).length,
      longTermOfficerLinked: out.longTerm.filter((r) => r.officerLinked).length,
    },
    capped: rows.length >= cap && total > rows.length,
    rule: {
      boundaryMonths: productTerm.LONG_TERM_MIN_MONTHS,
      shortTermProgramWord: productTerm.SHORT_TERM_PROGRAM_WORD,
    },
  };
}

/**
 * The same census grouped the way the owner reads it — by folder, then by status.
 * Derived from the list rather than a second query, so the two can never disagree
 * about a count.
 */
function groupBook(list) {
  const byFolder = new Map();
  for (const row of list || []) {
    const folder = row.folder || '(no folder)';
    if (!byFolder.has(folder)) byFolder.set(folder, { folder, count: 0, statuses: new Map() });
    const f = byFolder.get(folder);
    f.count += 1;
    const status = row.status || '(no status)';
    f.statuses.set(status, (f.statuses.get(status) || 0) + 1);
  }
  return [...byFolder.values()]
    .sort((a, b) => b.count - a.count || String(a.folder).localeCompare(String(b.folder)))
    .map((f) => ({
      folder: f.folder,
      count: f.count,
      statuses: [...f.statuses.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .map(([status, count]) => ({ status, count })),
    }));
}

module.exports = { longTermBook, groupBook, _internals: { shape, FROM, SELECT } };

'use strict';
/**
 * LONG-TERM — the Condition Center, READ side.
 *
 * What the screen asks for: one loan's conditions grouped so the work is on top,
 * each carrying the documents that answer it, plus the eFolder needs-list that is
 * where the day-to-day work actually happens on a live file.
 *
 * WHY BOTH FEEDS ARE HERE, AND WHY THAT IS NOT A HEDGE. A read-only sweep of 400
 * loans on 2026-08-14 found every Encompass condition in this tenant sitting on a
 * loan that is already closed and sold — not one active long-term loan carries a
 * single condition — while a mature file carries about a hundred eFolder
 * documents in groups including "Needs List - Initial". So a centre built only on
 * conditions would be EMPTY on every file an officer is working and would light
 * up only after the loan is sold. One module, two feeds, and `face` says which
 * one this file actually has, so the screen never presents an empty condition
 * list as if it were the answer.
 *
 * THE DEFAULT SORT IS OPINIONATED, ON PURPOSE (plan §5.4): unapproved first. The
 * system should show you your work before it shows you everything.
 *
 * REMOVED ROWS ARE FILTERED HERE, NOT DELETED UPSTREAM. Everything in the eFolder
 * is soft-deleted, and the record of what was once asked for has to survive — so
 * the mirror keeps it and this is the one place it stops being shown.
 *
 * THE INVESTOR NAME NEVER REACHES A CLIENT. A condition's external description,
 * its title and a document's title are free text a human typed, and this tenant's
 * files are bought by investors whose names must never reach a borrower or a TPO
 * (CLAUDE.md rule 10). So every client-facing string goes through the ONE
 * definition, `audience.scrubInvestorNames` — never a second copy of that check.
 *
 * SEPARATION: reads `lt_*` only, and writes nothing at all.
 */

const audience = require('../audience');

const lazy = {
  get db() { return require('../db'); },
};

/**
 * How many files one document lists before the screen says "and N more".
 *
 * A slot normally holds a handful; a scanned closing package can hold dozens, and
 * a list that long buries every OTHER document on the page. Never a silent cut —
 * the honest total travels beside the list.
 */
const FILE_CAP = 12;

/**
 * The files on these documents, in ONE query.
 *
 * WHY THIS EXISTS AT ALL. The mirror has held every attachment since the eFolder
 * read shipped and NOTHING read it: the centre showed "3 files" and never their
 * names, so the owner's "with all the documents in there linked" was a number,
 * not a document list. This is the read that makes it true.
 *
 * THE COUNT COMES FROM THESE ROWS, NOT FROM `lt_documents.attachment_count` — that
 * column records what the payload LISTED, removed files included, so a slot whose
 * only file was deleted in Encompass read "1 file" beside an empty list. What a
 * person can actually open is the live, not-removed rows, and that is what is
 * counted here.
 *
 * ONE QUERY FOR EVERY DOCUMENT, capped per document by a window function rather
 * than in JavaScript — cutting the list after the fact would still have carried
 * every file of every document across the wire, on a page that opens for every
 * loan.
 *
 * THE URI IS NOT SENT. `encompass_uri` is a pointer into Encompass that nothing
 * in PILOT can open — there is no download route, and putting borrower paper
 * through a second system is a decision nobody has asked for. A link that cannot
 * be clicked is worse than none.
 */
async function attachmentsForDocuments(db, docIds, forClient) {
  const out = new Map();
  if (!docIds.length) return out;

  const { rows } = await db.query(
    `SELECT q.document_id, q.id, q.title, q.file_name, q.content_type,
            q.file_size, q.page_count, q.encompass_created_by, q.encompass_created_at,
            q.total
       FROM (
         SELECT a.document_id, a.id, a.title, a.file_name, a.content_type,
                a.file_size, a.page_count, a.encompass_created_by,
                a.encompass_created_at,
                row_number() OVER w AS rn,
                count(*)     OVER (PARTITION BY a.document_id) AS total
           FROM lt_document_attachments a
          WHERE a.document_id = ANY($1::uuid[])
            AND a.is_removed = false
         WINDOW w AS (PARTITION BY a.document_id
                      ORDER BY a.encompass_created_at ASC NULLS LAST, a.id ASC)
       ) q
      WHERE q.rn <= $2
      ORDER BY q.document_id, q.rn`,
    [docIds, FILE_CAP],
  );

  for (const r of rows) {
    if (!out.has(r.document_id)) out.set(r.document_id, { files: [], total: Number(r.total) || 0 });
    out.get(r.document_id).files.push({
      id: r.id,
      // A FILENAME IS FREE TEXT A HUMAN TYPED, so it is scrubbed for a client
      // exactly as a title is — "Deephaven approval.pdf" is the whole reason the
      // one definition exists.
      name: safeText(r.file_name || r.title, forClient),
      contentType: r.content_type,
      // bigint arrives as a string from pg; a screen wants a number it can format.
      size: r.file_size === null || r.file_size === undefined ? null : Number(r.file_size),
      pages: r.page_count,
      addedBy: safeText(r.encompass_created_by, forClient),
      addedAt: r.encompass_created_at,
    });
  }
  return out;
}

/** Attach the files to one document row, with the honest total either side of the cap. */
function withFiles(doc, found) {
  const files = found ? found.files : [];
  const total = found ? found.total : 0;
  return {
    ...doc,
    attachments: total,
    files,
    moreFiles: Math.max(0, total - files.length),
  };
}

/**
 * How a condition sorts. LOW number = higher up.
 *
 * Rank on `status_open` — Encompass's OWN answer — and never on the status word:
 * the words are tenant configuration (seven were observed here, and a buyer can
 * add more), so a list ordered by parsing them would silently mis-sort the first
 * time somebody adds one. A NULL is treated as OPEN: "they did not tell us" is
 * not evidence that the work is done, and burying an unknown at the bottom is
 * exactly how it gets missed.
 */
function conditionRank(row) {
  if (row.status_open === false) return 2;
  return 1;
}

/** The plain-language group a condition belongs to, for the collapsible sections
 *  the plan asks for. Encompass's own `prior_to` IS the grouping — it says which
 *  gate the condition blocks — and an unstated one gets its own honest bucket
 *  rather than being folded into a real gate it may not belong to. */
function groupOf(row) {
  const t = String(row.prior_to || '').trim();
  return t || 'Not stated';
}

/**
 * One loan's conditions, with the documents that answer each one.
 *
 * The document side is built by INVERTING `lt_document_conditions` (the link lives
 * on the document in Encompass and there is no condition->documents endpoint), so
 * this is the read that makes the owner's "with all the documents in there linked"
 * true.
 */
async function conditionsForLoan(loanId, opts = {}) {
  const forClient = audience.isClient(opts.audience || 'internal');
  const db = opts.db || lazy.db;

  const { rows } = await db.query(
    `SELECT c.id, c.encompass_condition_id, c.condition_type, c.title,
            c.internal_description, c.external_description, c.category,
            c.prior_to, c.status, c.status_open, c.status_date, c.source,
            c.owner_role, c.assigned_to, c.days_to_receive, c.comments_count,
            c.encompass_created_at, c.encompass_modified_at, c.encompass_synced_at
       FROM lt_conditions c
      WHERE c.loan_id = $1::uuid
        AND c.is_removed = false
      ORDER BY c.encompass_created_at ASC NULLS LAST, c.id ASC`,
    [loanId],
  );

  const byId = new Map();
  for (const r of rows) byId.set(r.id, r);

  // The inverted link, in ONE query rather than one per condition.
  const docs = rows.length
    ? (await db.query(
      `SELECT l.condition_id, d.id, d.title, d.title_with_index, d.status,
              d.milestone_name, d.encompass_created_at
         FROM lt_document_conditions l
         JOIN lt_documents d ON d.id = l.document_id
        WHERE l.condition_id = ANY($1::uuid[])
          AND d.is_removed = false
        ORDER BY d.encompass_created_at ASC NULLS LAST`,
      [rows.map((r) => r.id)],
    )).rows
    : [];

  // The same document can answer several conditions, so ask for its files ONCE.
  const filesByDoc = await attachmentsForDocuments(
    db, [...new Set(docs.map((d) => d.id))], forClient,
  );

  const docsByCondition = new Map();
  for (const d of docs) {
    if (!docsByCondition.has(d.condition_id)) docsByCondition.set(d.condition_id, []);
    docsByCondition.get(d.condition_id).push(withFiles({
      id: d.id,
      title: safeText(d.title_with_index || d.title, forClient),
      status: d.status,
      milestone: d.milestone_name,
    }, filesByDoc.get(d.id)));
  }

  // THE THREAD IS INTERNAL, FULL STOP — never fetched for a client.
  //
  // A condition comment is underwriter-to-underwriter text: our own reasoning,
  // our own references, and whoever we are talking to about the file. The text
  // written FOR a client is `external_description`, and that split is already the
  // model's. The investor-name scrub covers a name, not a paragraph of internal
  // thinking, so the safe answer here is not to send it rather than to clean it.
  const threads = (!forClient && rows.length)
    ? (await db.query(
      `SELECT m.condition_id, m.id, m.body, m.author_name, m.commented_at
         FROM lt_condition_comments m
        WHERE m.condition_id = ANY($1::uuid[])
        ORDER BY m.commented_at ASC NULLS LAST, m.created_at ASC`,
      [rows.map((r) => r.id)],
    )).rows
    : [];

  const threadByCondition = new Map();
  for (const m of threads) {
    if (!threadByCondition.has(m.condition_id)) threadByCondition.set(m.condition_id, []);
    threadByCondition.get(m.condition_id).push({
      id: m.id,
      body: m.body,
      author: m.author_name,
      at: m.commented_at,
    });
  }

  const items = rows.map((r) => describeCondition(
    r, docsByCondition.get(r.id) || [], forClient, threadByCondition.get(r.id) || [],
  ));

  // Unapproved first, then oldest first — a stable order, so the list does not
  // reshuffle under somebody's cursor between two reads.
  items.sort((a, b) => (a.rank - b.rank) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  return { items, open: items.filter((i) => i.open).length, total: items.length, byId };
}

/** One condition, described for a screen. */
function describeCondition(r, documents, forClient, thread = []) {
  // A client sees the EXTERNAL description — that is what it is for — and never
  // the internal one, which routinely carries our own references and reasoning.
  const body = forClient
    ? safeText(r.external_description, true)
    : (r.internal_description || r.external_description || null);

  return {
    id: r.id,
    encompassId: r.encompass_condition_id,
    title: safeText(r.title, forClient),
    body,
    type: r.condition_type,
    category: r.category,
    group: groupOf(r),

    // Encompass's own answer, mirrored. `null` is reported as null rather than
    // rendered as closed — see the module header.
    open: r.status_open === false ? false : true,
    statusStated: r.status_open,
    status: r.status,
    statusDate: r.status_date,

    owner: forClient ? null : r.owner_role,
    assignedTo: forClient ? null : r.assigned_to,
    daysToReceive: r.days_to_receive,

    // BOTH numbers, deliberately. `commentCount` is ENCOMPASS's own count and
    // `comments` is the thread we actually hold; they disagree when a read was
    // capped, a call failed, or a comment arrived in a shape we could not key.
    // Reporting one figure for both would turn any of those into a silent
    // "there is nothing more to see".
    // A client is told neither — "3 comments you may not read" is worse than
    // silence, and the count alone still says how much was discussed about them.
    commentCount: forClient ? null : r.comments_count,
    comments: forClient ? [] : thread,
    createdAt: r.encompass_created_at,
    updatedAt: r.encompass_modified_at,
    syncedAt: r.encompass_synced_at,
    documents,
    rank: conditionRank(r),
  };
}

/**
 * The eFolder needs list — what is actually outstanding on a LIVE file.
 *
 * `outstanding` is decided from the eFolder's own status vocabulary rather than
 * from a word we invent: `received` / `reviewed` / `ready for UW` / `ready to
 * ship` are done, everything else is still wanted. An UNRECOGNISED status counts
 * as OUTSTANDING — a status we have never seen is not evidence that a document
 * has arrived, and the safe direction here is to keep asking.
 */
const DONE_STATUSES = new Set(['received', 'reviewed', 'ready for uw', 'ready to ship']);

function documentOutstanding(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return true;
  return !DONE_STATUSES.has(s);
}

async function documentsForLoan(loanId, opts = {}) {
  const forClient = audience.isClient(opts.audience || 'internal');
  const db = opts.db || lazy.db;

  const { rows } = await db.query(
    `SELECT d.id, d.encompass_document_id, d.title, d.title_with_index, d.status,
            d.milestone_name, d.application_name,
            d.days_due, d.days_till_expire, d.web_center_allowed,
            d.encompass_created_at, d.encompass_synced_at
       FROM lt_documents d
      WHERE d.loan_id = $1::uuid
        AND d.is_removed = false
      ORDER BY d.encompass_created_at ASC NULLS LAST, d.id ASC`,
    [loanId],
  );

  const filesByDoc = await attachmentsForDocuments(db, rows.map((r) => r.id), forClient);

  const items = rows.map((r) => withFiles({
    id: r.id,
    encompassId: r.encompass_document_id,
    title: safeText(r.title_with_index || r.title, forClient),
    status: r.status,
    outstanding: documentOutstanding(r.status),
    milestone: r.milestone_name,
    forBorrower: r.application_name ? safeText(r.application_name, forClient) : null,
    daysDue: r.days_due,
    daysTillExpire: r.days_till_expire,
    createdAt: r.encompass_created_at,
    syncedAt: r.encompass_synced_at,
  }, filesByDoc.get(r.id)));

  items.sort((a, b) => (Number(b.outstanding) - Number(a.outstanding))
    || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  return { items, outstanding: items.filter((i) => i.outstanding).length, total: items.length };
}

/**
 * The whole centre for one loan.
 *
 * `face` is the honest answer to "which of these two is this file's work": a file
 * with conditions shows them, a file with only an eFolder shows the needs list,
 * and a file with NEITHER says so rather than rendering an empty list that reads
 * as "nothing is outstanding".
 */
async function centerForLoan(loanId, opts = {}) {
  const [conditions, documents, stamps] = await Promise.all([
    conditionsForLoan(loanId, opts),
    documentsForLoan(loanId, opts),
    syncStamps(loanId, opts),
  ]);

  let face = 'empty';
  if (conditions.total > 0) face = 'conditions';
  else if (documents.total > 0) face = 'documents';

  return {
    face,
    conditions: { items: conditions.items, open: conditions.open, total: conditions.total },
    documents: { items: documents.items, outstanding: documents.outstanding, total: documents.total },
    sync: stamps,
  };
}

/**
 * When this loan was last read, and why it failed if it did.
 *
 * Surfaced rather than kept in the logs: a condition list is only as trustworthy
 * as its freshness, and a screen that cannot say when it last heard from
 * Encompass is asking to be believed on nothing.
 */
async function syncStamps(loanId, opts = {}) {
  const db = opts.db || lazy.db;
  const { rows } = await db.query(
    `SELECT conditions_synced_at, conditions_sync_error, documents_synced_at, documents_sync_error
       FROM lt_loans WHERE id = $1::uuid`,
    [loanId],
  );
  const r = rows[0] || {};
  return {
    conditionsSyncedAt: r.conditions_synced_at || null,
    documentsSyncedAt: r.documents_synced_at || null,
    // Never shown to a client: our own failure wording is internal, and it can
    // quote an Encompass message.
    error: audience.isClient(opts.audience || 'internal')
      ? null
      : (r.conditions_sync_error || r.documents_sync_error || null),
  };
}

/** Free text on its way to a client goes through the ONE investor-name scrub. */
function safeText(v, forClient) {
  if (v === null || v === undefined) return null;
  return forClient ? audience.scrubInvestorNames(String(v)) : v;
}

module.exports = {
  centerForLoan,
  conditionsForLoan,
  documentsForLoan,
  syncStamps,
  _internals: { conditionRank, groupOf, documentOutstanding, describeCondition, safeText, attachmentsForDocuments, withFiles, FILE_CAP, DONE_STATUSES },
};

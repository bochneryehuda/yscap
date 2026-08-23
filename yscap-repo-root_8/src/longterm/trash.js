'use strict';
/**
 * LONG-TERM — the archive: Encompass's `(Trash)` folder, kept out of everything.
 *
 * Owner-directed 2026-08-23: *"The trash folder from Encompass is real trash …
 * Testing, training, whatever. It's a trash file that should be in your archive
 * folder. You shouldn't even bother with that file. It should not be part of the
 * pipeline at all — not by any filters. It should be totaled in the archive folder,
 * and you can click over there to delete it permanently."*
 *
 * WHAT `(Trash)` IS. Encompass's own recycle bin — the folder a DELETED loan sits
 * in. It is a SYSTEM folder with a fixed, parenthesised name, not a tenant-named
 * pipeline folder, which is why this rule is STRUCTURAL rather than another entry
 * in the configurable folder lists: a deleted loan is not a deal in any state, and
 * no administrator's settings edit should be able to put deleted files back into
 * somebody's book. (How they got here at all: discovery reads the pipeline with
 * `includeArchivedLoans` — needed so a WITHDRAWN file stays visible — and that
 * flag brings the trash along with the archives. Measured 2026-08-23: 49 of the
 * 486 mirrored loans were trash — every "test file" the owner could not find in
 * Encompass, plus six of the seven duplicated loan numbers.)
 *
 * THE RULE, in both languages, from ONE normalisation:
 *   · `isTrashFolder(name)`  — the JS half, `pipeline-book.folderKey` on both sides.
 *   · `trashSql(alias)` / `notTrashSql(alias)` — the SQL half, built on
 *     `pipeline-book.folderNormSql`, the SAME expression the book filters compare
 *     with. One normalisation, so the archive and the books can never disagree
 *     about which folder a loan is in.
 *
 * WHAT HAPPENS TO A TRASHED LOAN:
 *   · The mirror UPDATES a row we already hold (so a live loan somebody deletes in
 *     Encompass moves into the archive on the next sweep) and never INSERTS a new
 *     one — a loan that was already trash when we first saw it is not brought in,
 *     and a permanently deleted archive row stays deleted.
 *   · Every reader — the pipeline (all books, all filters), the borrower's own
 *     list, the borrower-match screen, the ClickUp link pass — excludes it through
 *     `notTrashSql`. Restoring the loan from Encompass's trash brings it straight
 *     back: the next sweep updates the folder and every screen shows it again,
 *     with nothing to undo.
 *   · The archive screen lists them, and a super-admin may delete one PERMANENTLY —
 *     from PILOT's mirror only. Encompass is read-only to PILOT, always; the
 *     Encompass copy is already in Encompass's own trash.
 *
 * THE DELETE RIDES THE CASCADES, PLUS THE TWO TABLES THAT HAVE NONE. Every
 * `lt_*` child keyed on `loan_id` cascades off `lt_loans` (measured against the
 * real schema) except `lt_milestone_events` and the link trail
 * `lt_clickup_link_log`, which are deleted explicitly here. Long-Term code may not
 * read the database catalog (the separation gate reads any non-`lt_*` FROM as a
 * crossing), so the list is enforced the other way round: the archive test suite
 * reads the catalog and FAILS the build if a table ever carries a loan id with
 * neither a cascade nor an entry in `NON_CASCADE_CHILD_TABLES` — a stale list
 * cannot ship silently.
 *
 * SEPARATION: `lt_*` tables only. No RTL table is read or written.
 */

const book = require('./pipeline-book');

const lazy = {
  get db() { return require('./db'); },
};

/** Encompass's recycle-bin folder, in `folderKey` form. */
const TRASH_KEY = '(trash)';

/** Is this folder name Encompass's trash? Compared exactly like the book filters. */
function isTrashFolder(name) {
  return book.folderKey(name) === TRASH_KEY;
}

/** SQL: "this row is in the trash". Constant, no placeholder — the name is fixed. */
function trashSql(alias) {
  return `${book.folderNormSql(alias)} = '${TRASH_KEY}'`;
}

/** SQL: "this row is NOT in the trash" — the guard every reader composes. */
function notTrashSql(alias) {
  return `${book.folderNormSql(alias)} <> '${TRASH_KEY}'`;
}

/** How many deleted-in-Encompass loans the archive holds. Never throws — a count
 *  that cannot be read reports null, and the screen says nothing rather than 0. */
async function archiveCount(dbc = null) {
  try {
    const { rows } = await (dbc || lazy.db).query(
      `SELECT count(*)::int AS n FROM lt_loans l WHERE ${trashSql('l')}`);
    return rows[0] ? Number(rows[0].n) : 0;
  } catch (_) {
    return null;
  }
}

/** The archive, listed. Match keys + the ClickUp link, so a person can recognise
 *  each file before deleting it — nothing decision-bearing beyond that. */
async function listArchive(dbc = null) {
  const { rows } = await (dbc || lazy.db).query(
    `SELECT l.id, l.loan_number, l.encompass_loan_guid, l.borrower_name,
            l.program_name, l.loan_amount, l.milestone_name, l.loan_folder,
            l.encompass_last_modified, l.updated_at,
            l.clickup_task_id, l.clickup_custom_id
       FROM lt_loans l
      WHERE ${trashSql('l')}
      ORDER BY l.encompass_last_modified DESC NULLS LAST, l.loan_number NULLS LAST`);
  return rows;
}

/**
 * The loan-keyed `lt_*` tables with NO cascade from `lt_loans` — deleted by hand
 * inside the same transaction. `lt_borrower_links` never appears anywhere in this
 * file on purpose: it is keyed on an email address, not a loan, and a borrower's
 * confirmed identity outlives any one loan.
 *
 * KEPT HONEST BY THE TEST, not by trust: `test-lt-trash-db.js` reads the real
 * schema and fails when any `lt_*` table carries `loan_id`/`lt_loan_id` with
 * neither an ON DELETE CASCADE to `lt_loans` nor a row here.
 */
const NON_CASCADE_CHILD_TABLES = [
  { table: 'lt_clickup_link_log', column: 'lt_loan_id' },
  { table: 'lt_milestone_events', column: 'loan_id' },
];

/**
 * Permanently delete ONE archived loan from PILOT's mirror.
 *
 * THE GUARD IS IN THE STATEMENT: the final DELETE matches only a row that is in
 * the trash, so this function is structurally incapable of deleting a live loan —
 * whatever id it is handed. Returns what was deleted, or null when the id named
 * no archived loan (already deleted, or not trash).
 *
 * One transaction: the children go first (belt-and-suspenders beside the CASCADE
 * FKs, and the only path for the trail tables that carry no FK), then the loan.
 */
async function deleteArchivedLoan(id, dbc = null) {
  const pool = dbc || lazy.db;
  const client = await pool.getClient();
  try {
    await client.query('BEGIN');
    // The row, proven trash FIRST — so the child deletes below can never run for a
    // live loan either.
    const { rows: found } = await client.query(
      `SELECT id, loan_number, borrower_name, clickup_task_id
         FROM lt_loans l WHERE l.id = $1::uuid AND ${trashSql('l')}
         FOR UPDATE`, [id]);
    if (!found.length) { await client.query('ROLLBACK'); return null; }

    for (const t of NON_CASCADE_CHILD_TABLES) {
      await client.query(`DELETE FROM ${t.table} WHERE ${t.column} = $1::uuid`, [id]);
    }
    await client.query(`DELETE FROM lt_loans l WHERE l.id = $1::uuid AND ${trashSql('l')}`, [id]);
    await client.query('COMMIT');
    return found[0];
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the first error matters */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Delete EVERY archived loan, one at a time so a single refusal costs one row. */
async function deleteAllArchived(dbc = null) {
  const rows = await listArchive(dbc);
  let deleted = 0;
  const failed = [];
  for (const r of rows) {
    try {
      /* eslint-disable no-await-in-loop */ // serial on purpose: small, ordered, reportable
      if (await deleteArchivedLoan(r.id, dbc)) deleted += 1;
    } catch (e) {
      failed.push({ loanNumber: r.loan_number || null, reason: (e && e.message) || String(e) });
    }
  }
  return { deleted, failed };
}

module.exports = {
  TRASH_KEY,
  isTrashFolder,
  trashSql,
  notTrashSql,
  archiveCount,
  listArchive,
  deleteArchivedLoan,
  deleteAllArchived,
  NON_CASCADE_CHILD_TABLES,
};

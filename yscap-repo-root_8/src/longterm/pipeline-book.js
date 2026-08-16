'use strict';
/**
 * LONG-TERM — the live book and the closed book.
 *
 * §4.1: *"One flat table. Inactive loans stay in it, distinguished by status — no
 * separate archive screen."* Today nothing distinguishes them. `discoverLoans` finds
 * every folder Encompass returns for a loan amount over zero, so a file somebody moved
 * to Adverse or Trash sits in an officer's live book looking exactly like a live one.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE RULE THIS MODULE EXISTS TO ENFORCE, and the reason it ships empty:
 *
 *   AN UNLISTED FOLDER IS ALWAYS LIVE. WE NEVER GUESS WHICH FOLDER MEANS "OVER".
 *
 * Loan folder names are the TENANT'S OWN, and this instance's list is one of the 68
 * endpoints that answer 403 (§11 item 6) — so we cannot read them, and treating a
 * folder called "Archive" as dead on a hunch would silently empty part of somebody's
 * pipeline. That is the expensive direction: a closed file shown among the live ones
 * is untidy, a live file hidden from the person working it is a loan nobody is on.
 *
 * So `pipeline.inactiveFolders` DEFAULTS TO EMPTY, and with it empty every book is the
 * same book — the SQL is byte-identical to what it was before this module existed, and
 * the control row is not drawn (three chips selecting the same rows is not a control,
 * the same rule the scope row already follows). The moment a human names the folders,
 * the split turns on with no code change. That is §11 item 13's "costs one setting".
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * MATCHING IS FORGIVING IN ONE DIRECTION ONLY. A folder name is typed by an
 * administrator into a settings box and read back off an Encompass loan, so case and
 * stray spacing must not decide whether somebody's file disappears — but nothing
 * fuzzier than that. A prefix or substring match would make a folder named "Adverse"
 * swallow "Adverse Action Withdrawn — Reinstated", and we cannot check the guess
 * against the tenant's real list.
 *
 * A loan carrying NO folder at all is LIVE, for the same fail-toward-showing reason:
 * a newly discovered loan has not been read in detail yet, which makes a blank folder
 * the normal state of the NEWEST files — exactly the ones somebody is looking for.
 *
 * PURE — no database, no settings store, nothing that can fail.
 */

/** The three books. `live` is the default because it is what a desk works out of. */
const BOOKS = ['live', 'closed', 'all'];
const DEFAULT_BOOK = 'live';

/** Read a book name off a request or a saved view. Anything unrecognised is the default. */
function normalizeBook(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return BOOKS.includes(s) ? s : DEFAULT_BOOK;
}

/**
 * One folder name, in the form both sides are compared in.
 *
 * Lower-cased and space-collapsed, and NOTHING else — see the header. Returns `''`
 * for anything that is not a usable name so the caller can drop it; a blank entry in
 * the setting must never become "the loans with no folder are closed".
 */
function folderKey(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The configured "this deal is over" folders, cleaned and deduped.
 *
 * Anything that is not a list reads as EMPTY rather than as an error: an administrator
 * who types a bare word into a list setting must not be answered by a pipeline that
 * hides files. Empty is the safe state — every loan is live.
 */
function normalizeFolders(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const k = folderKey(entry);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function inactiveFolders(settings) {
  return normalizeFolders(settings && settings['pipeline.inactiveFolders']);
}

/**
 * Is there anything to split? With no folder named, every book is the same book.
 *
 * Normalizes first rather than trusting its caller: a list of nothing but blanks has a
 * length, and answering "yes" for it would draw a control row whose three chips all
 * select the same rows.
 */
function bookSplitApplies(folders) {
  return normalizeFolders(folders).length > 0;
}

/**
 * The SQL that says "this loan is in a folder somebody marked as over".
 *
 * COALESCE to `''` first, so a loan with no folder can never be NULL-compared into
 * neither book — it has to land in one, and the fail-toward-showing rule says live.
 * The empty string is not a legal entry in the list (`folderKey` drops it), so a
 * folderless loan can never match.
 *
 * THIS EXPRESSION IS `folderKey` WRITTEN IN SQL, AND IT HAS TO BE EXACTLY THAT.
 * The list on the other side of the `=` has been through `folderKey`, so any rule the
 * two sides do not share is a rule that silently stops matching. `btrim` alone does
 * NOT collapse the spacing INSIDE a name — so a folder stored as `'  loan   WITHDRAWN '`
 * read as `'loan   withdrawn'` and never equalled the `'loan withdrawn'` an
 * administrator typed, which puts a finished file back in somebody's live book with
 * nothing anywhere saying why. Collapse first, then trim: a leading run of whitespace
 * becomes one space and `btrim` takes it, which is what `String.trim()` does too.
 */
function closedFolderSql(alias, ph) {
  return `lower(btrim(regexp_replace(COALESCE(${alias}.loan_folder, ''), '\\s+', ' ', 'g'))) = ANY(${ph}::text[])`;
}

/**
 * The WHERE fragment for one book, or NULL when there is nothing to add.
 *
 * NULL for `all`, and NULL whenever no folder is configured — which is what makes
 * this whole feature inert until somebody fills the setting in: the query built with
 * it off is the same string it was before.
 *
 * @param book    'live' | 'closed' | 'all'
 * @param folders the cleaned list from `inactiveFolders`
 * @param p       the caller's placeholder helper (see pipeline.js — never a literal `$1`)
 */
function bookWhereSql(book, folders, p, alias = 'l') {
  // NORMALIZED HERE, not trusted from the caller — and that is a correctness rule, not
  // tidiness. The SQL lower-cases only ITS side of the comparison, so a caller who
  // passed the raw setting through would produce a clause that matches nothing: the
  // closed book would read empty and the live book would quietly be the whole table.
  // Silent, and in the direction that looks like "we have no finished loans".
  const list = normalizeFolders(folders);
  if (!list.length) return null;
  const b = normalizeBook(book);
  if (b === 'all') return null;
  const sql = closedFolderSql(alias, p(list));
  return b === 'closed' ? sql : `NOT (${sql})`;
}

/**
 * Which book filter is meaningless for this tenant right now, in plain words.
 *
 * The stranding case is real and is the same shape as the shared-view scope bug this
 * codebase already fixed once: a saved view is SHARED, so somebody can save "Closed"
 * and hand it to a desk on a tenant where no folder is marked closed. The closed book
 * is then empty AND the control row is not drawn — an empty pipeline with nothing to
 * clear it with. It is dropped in `bookWhereSql` (no folders → no clause); this is
 * what tells them it was.
 *
 * `all` needs no notice: with nothing configured it is genuinely identical to `live`,
 * so obeying it literally shows exactly the book that was asked for.
 */
function ignoredBookFilter(book, folders) {
  if (bookSplitApplies(folders)) return null;
  if (normalizeBook(book) !== 'closed') return null;
  return {
    key: 'book',
    why: 'No loan folders have been marked as finished yet, so there is no closed book to show — '
      + 'the whole pipeline is listed. An administrator sets that list in Settings.',
  };
}

module.exports = {
  BOOKS,
  DEFAULT_BOOK,
  normalizeBook,
  folderKey,
  normalizeFolders,
  inactiveFolders,
  bookSplitApplies,
  closedFolderSql,
  bookWhereSql,
  ignoredBookFilter,
};

'use strict';

/**
 * WHAT THE BOOK ACTUALLY USES — the values a settings screen should offer instead
 * of an empty box.
 *
 * THIS EXISTS BECAUSE A RECORDED BLOCKER TURNED OUT TO BE FALSE. The master plan
 * and `pipeline.inactiveFolders` both say the tenant's loan folders "cannot be
 * read" because the folder-LIST endpoint answers 403. That is true of the endpoint
 * and NOT true of the fact: every mirrored loan carries the folder it sits in
 * (`lt_loans.loan_folder`, straight from `CX.LOAN.FOLDER.CURRENT`), so the names —
 * and how many files are in each — are already here, counted from the real book.
 *
 * WHAT THIS DOES AND DOES NOT DECIDE. It answers "which folders does this company
 * use, and how big is each one". It does NOT answer "which of them mean the deal is
 * over" — that is a business rule nobody here may guess, and guessing it would
 * silently empty part of an officer's pipeline. So this OFFERS the names and a
 * human picks. The distinction is the whole design: reading a fact is ours, judging
 * what it means is the owner's.
 *
 * NEVER THROWS, and an empty answer is a real answer. An unreadable list must leave
 * the setting exactly as usable as it was before — a free-text box — rather than
 * failing the screen that shows twenty other settings.
 */

const lazy = { get db() { return require('./db'); } };

/**
 * Every loan folder the mirrored book actually carries, biggest first.
 *
 * Rows with no folder are counted separately as `(no folder)` — a file with no
 * folder is a real state, and dropping it would make the counts fail to add up on
 * the one screen a person checks them against.
 */
async function loanFolders(dbc) {
  const db = dbc || lazy.db;
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(NULLIF(TRIM(loan_folder), ''), '(no folder)') AS value,
              count(*)::int AS count
         FROM lt_loans
        GROUP BY 1
        ORDER BY 2 DESC, 1 ASC`,
    );
    return rows.map((r) => ({ value: r.value, count: r.count }));
  } catch (e) {
    console.error('[lt] could not read the observed loan folders:', (e && e.message) || e);
    return [];
  }
}

/**
 * The resolvers a setting declaration may name in `suggestFrom`.
 *
 * A NAME, never a function on the declaration: the declarations are a plain data
 * table read by several things (the screen, the tests, the schema-drift check), and
 * a function in one of them would make it unserialisable.
 */
const SUGGESTERS = { loanFolders };

/**
 * Attach `suggestions` to every described setting whose declaration asks for them.
 *
 * Each resolver runs AT MOST ONCE per call however many settings name it, and one
 * failing resolver only costs its own suggestions.
 */
async function attachSuggestions(described, dbc) {
  const groups = (described && Array.isArray(described.groups)) ? described.groups : [];
  const wanted = new Set();
  for (const g of groups) {
    for (const s of (g.settings || [])) {
      if (s && s.suggestFrom && SUGGESTERS[s.suggestFrom]) wanted.add(s.suggestFrom);
    }
  }
  if (!wanted.size) return described;

  const resolved = {};
  for (const name of wanted) {
    try { resolved[name] = await SUGGESTERS[name](dbc); }
    catch (_) { resolved[name] = []; }
  }

  for (const g of groups) {
    for (const s of (g.settings || [])) {
      if (s && s.suggestFrom && resolved[s.suggestFrom]) s.suggestions = resolved[s.suggestFrom];
    }
  }
  return described;
}

module.exports = { loanFolders, attachSuggestions, SUGGESTERS };

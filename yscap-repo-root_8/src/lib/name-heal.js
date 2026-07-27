'use strict';

/**
 * PREVIOUS FILES REPAIR — split the names that were already stored merged.
 *
 * The owner's standing "previous AND future" rule: a change here must reach the
 * files that already exist, not only the next one. Going forward every door
 * (ClickUp inbound, Encompass enrichment, the apply/intake forms, the staff and
 * borrower edit screens) writes first / middle / last / suffix separately. This
 * pass fixes what the old `lastIndexOf(' ')` splitter already wrote:
 *
 *   first_name 'Issac Michael' / last_name 'Grunzweig'
 *        -> first 'Issac'  middle 'Michael'  last 'Grunzweig'
 *   first_name 'John Michael Smith' / last_name 'Jr'
 *        -> first 'John'   middle 'Michael'  last 'Smith'  suffix 'Jr.'
 *   first_name 'Ludwig van' / last_name 'Beethoven'
 *        -> first 'Ludwig' last 'van Beethoven'
 *
 * WHY IT IS JAVASCRIPT AND NOT A MIGRATION. The split has to understand
 * suffixes, courtesy titles, surname particles and middle initials. A PL/pgSQL
 * twin of that logic would inevitably drift from the one the live sync uses —
 * the exact class of bug `pilot_term_norm` / `pilot_property_type_norm` needed a
 * dedicated drift test to contain. There is ONE splitter, `lib/person-name`, and
 * this pass calls it.
 *
 * SAFETY, in order of importance:
 *   * It NEVER changes what the name says. `splitStoredName` only redistributes
 *     tokens already present, and the pass re-asserts that by rebuilding the
 *     full line and refusing any row where the before and after lines differ.
 *   * It never touches a row that already carries a middle name (a human or an
 *     integration has spoken), and never a placeholder/shadow row.
 *   * The UPDATE re-checks the stored values it read, so a human editing the
 *     name at the same moment is never clobbered.
 *   * Every row it looks at is stamped `name_split_checked_at`, so the pass is
 *     resumable, idempotent, and a fast no-op on every later boot.
 *   * It never throws — a repair must not stop the server coming up.
 */
const db = require('../db');
const N = require('./person-name');

// Rows per boot. The pass self-drains: whatever it does not reach this time is
// picked up on the next deploy, oldest profile first.
const DEFAULT_LIMIT = 5000;

/**
 * One bounded pass. Returns { looked, split, flagged, skipped }.
 *   looked  — rows examined (all of them get stamped)
 *   split   — rows whose name actually moved into the new columns
 *   flagged — rows where PILOT wants a human to confirm the split
 */
async function healBorrowerNamesOnce({ limit = DEFAULT_LIMIT } = {}) {
  const out = { looked: 0, split: 0, flagged: 0, skipped: 0 };
  let rows;
  try {
    rows = (await db.query(
      `SELECT id, first_name, last_name, middle_name, name_suffix
         FROM borrowers
        WHERE name_split_checked_at IS NULL
        ORDER BY created_at
        LIMIT $1`, [limit])).rows;
  } catch (e) {
    // A fresh database mid-migration (the columns do not exist yet) is not an
    // error — the next boot runs it after db/343 has applied.
    return out;
  }

  for (const r of rows) {
    out.looked += 1;
    let s = null;
    try {
      s = N.splitStoredName({ first: r.first_name, last: r.last_name, middle: r.middle_name, suffix: r.name_suffix });
    } catch (_) { s = null; }

    if (!s || !s.changed) {
      // Nothing to move. Stamp it so the pass never looks again.
      await stamp(r.id).catch(() => {});
      out.skipped += 1;
      continue;
    }

    // THE INVARIANT: a repair may only REARRANGE a name, never restate it.
    // Rebuild the full line from both sides and refuse anything that differs —
    // so a splitter bug can drop or invent a word in a test, never in the
    // borrower book.
    const before = N.joinFullName({ first: r.first_name, middle: r.middle_name, last: r.last_name, suffix: r.name_suffix });
    const after = N.joinFullName(s);
    if (words(before) !== words(after)) {
      await stamp(r.id).catch(() => {});
      out.skipped += 1;
      continue;
    }

    try {
      const w = await db.query(
        `UPDATE borrowers
            SET first_name = $2,
                middle_name = NULLIF($3,''),
                last_name = $4,
                name_suffix = NULLIF($5,''),
                name_review_needed = $6,
                name_review_reason = $7,
                name_split_checked_at = now(),
                updated_at = now()
          WHERE id = $1
            AND first_name IS NOT DISTINCT FROM $8
            AND last_name IS NOT DISTINCT FROM $9
            AND middle_name IS NULL`,
        [r.id, s.first, s.middle, s.last, s.suffix, !!s.needsReview, s.needsReview ? s.reason : null,
          r.first_name, r.last_name]);
      if (w.rowCount) {
        out.split += 1;
        if (s.needsReview) out.flagged += 1;
        await audit(r.id, r, s).catch(() => {});
      } else {
        // Someone edited the row between the read and the write — leave it to
        // them and stamp so we do not spin on it.
        await stamp(r.id).catch(() => {});
        out.skipped += 1;
      }
    } catch (_) {
      out.skipped += 1;
    }
  }
  return out;
}

// The same words, in the same order, ignoring punctuation and casing. This is
// what proves a repair only moved the boundary between the columns.
//
// A leading courtesy TITLE ("Rabbi Moshe" / "Klein") is stripped from BOTH sides
// first, because dropping it is the one word removal the splitter is allowed to
// make — a title is not part of a legal name and must never print on a closing
// document. Every OTHER word must survive.
const LEADING_TITLE = /^(mr|mrs|ms|mx|miss|dr|doctor|prof|professor|rabbi|rav|rebbetzin|rev|reverend|father|pastor|sir|dame|hon|honorable|judge|atty)\s+/;
function words(line) {
  const w = String(line || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return w.replace(LEADING_TITLE, '');
}

// Mark a row as looked-at WITHOUT touching the name or the review flag. Used for
// every row this pass decides not to change, so it is never re-walked.
function stamp(id) {
  return db.query(`UPDATE borrowers SET name_split_checked_at = now() WHERE id = $1`, [id]);
}

function audit(borrowerId, before, after) {
  return db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ('system', NULL, 'borrower_name_split', 'borrower', $1, $2)`,
    [borrowerId, JSON.stringify({
      from: { first_name: before.first_name, last_name: before.last_name },
      to: { first_name: after.first, middle_name: after.middle || null, last_name: after.last, name_suffix: after.suffix || null },
      confidence: after.confidence,
      reason: after.reason,
      review: !!after.needsReview,
      why: 'the stored name was split into first / middle / last so it lines up with Encompass and prints correctly on closing documents',
    })]);
}

module.exports = { healBorrowerNamesOnce, _internals: { words, DEFAULT_LIMIT } };

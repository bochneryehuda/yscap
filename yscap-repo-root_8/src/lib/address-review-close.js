'use strict';

/**
 * CLOSE THE ADDRESS REVIEWS THAT WERE NEVER A DISAGREEMENT.
 *
 * Owner-reported 2026-07-26 evening: the sync-review queue filled with "Borrower
 * home address" rows where the two sides were plainly the same home —
 *
 *   In Encompass: 5701 15 Ave 4D, Brooklyn, NY 11219
 *   In PILOT:     5701 15th Ave Apt 4d, Brooklyn, NY 11219, USA
 *
 * Every address comparison in the system used a letters-only key, so a trailing
 * country, a unit KEYWORD, an abbreviation or an ordinal read as a conflict and
 * queued a review with no decision to make. `lib/address.sameAddress` is the fix
 * at the source; this pass retires the rows that were already queued.
 *
 * DISCIPLINE: it closes a row ONLY when the two stored values are PROVABLY the
 * same place. A different house number, street, ZIP, state or unit stays open —
 * those are real, and several of them (a transposed ZIP, "641" vs "635") are
 * worth a human's attention. Bounded, idempotent, never throws: a closed row no
 * longer matches, so later boots are a fast no-op.
 */
const db = require('../db');
const ADDR = require('./address');

/**
 * One bounded pass over the OPEN address reviews.
 * Returns { checked, closed } — never throws.
 */
async function closeEquivalentAddressReviewsOnce({ limit = 500, dbc = null } = {}) {
  const q = dbc || db;
  const out = { checked: 0, closed: 0 };
  let rows = [];
  try {
    rows = (await q.query(
      `SELECT id, clickup_value, portal_value, current_value, proposed_value
         FROM sync_review_queue
        WHERE status = 'open' AND field_key = 'current_address'
        ORDER BY created_at
        LIMIT $1`, [limit])).rows;
  } catch (_) { return out; }
  out.checked = rows.length;

  const ids = [];
  for (const r of rows) {
    // Both sides as they were recorded. `clickup_value` carries the OTHER
    // system's value whatever that system is (ClickUp or Encompass — db/328's
    // `source` column names it); `portal_value` is ours.
    const theirs = r.clickup_value || r.proposed_value;
    const ours = r.portal_value || r.current_value;
    if (!theirs || !ours) continue;
    let same = false;
    try { same = ADDR.sameAddress(theirs, ours); } catch (_) { same = false; }
    if (same) ids.push(r.id);
  }
  if (!ids.length) return out;

  try {
    const w = await q.query(
      `UPDATE sync_review_queue
          SET status='resolved', auto_resolved=true, resolved_at=now(),
              resolution_note='auto-closed — both sides are the same address, written differently (country, unit wording, abbreviations, or the mailing city vs the municipality). Nothing was changed on either side.'
        WHERE id::text = ANY($1::text[]) AND status='open'`, [ids.map(String)]);
    // NOTE: compared as TEXT deliberately — `sync_review_queue.id` is a bigint
    // here, and a `::uuid[]` cast throws (silently, inside the catch) so the
    // pass reported "closed 0" while finding every row. Never assume the id type.
    out.closed = w.rowCount || 0;
  } catch (_) { /* best effort */ }
  return out;
}

/**
 * RETIRE THE ROWS THAT ASK A QUESTION ALREADY ANSWERED — the backlog half of the
 * 2026-07-28 producer fix (the go-forward half is `enrich.verifyPrimaryAddress`,
 * which now keys a conflict on the PERSON and the ADDRESS instead of on the
 * Encompass loan it arrived on).
 *
 * While that guard was keyed on the loan, one newly-mirrored loan re-raised a
 * conflict a human had already settled, and a re-rendered address string slipped
 * past the queue's own duplicate index — so the queue accumulated (a) open rows
 * a reviewer had ALREADY dismissed or decided, and (b) two or more open cards
 * asking the SAME question under different loan ids. Both are already-answered
 * or redundant by construction; a fix that only stops NEW ones would leave the
 * reviewer staring at the old ones forever.
 *
 * DISCIPLINE, deliberately narrow:
 *   • Encompass home-address rows only (a ClickUp row keys on a stable task id
 *     and never had this problem).
 *   • A row is closed ONLY when ANOTHER row for the SAME borrower asks about the
 *     SAME PLACE (`sameAddress`) and either was already decided by a person, or
 *     is an OLDER open row that stays behind to be answered. The question is
 *     never lost — exactly one card always survives.
 *   • Anything unreadable or unmatched is left alone.
 * Bounded, idempotent, never throws.
 */
async function closeSupersededAddressReviewsOnce({ limit = 500, dbc = null } = {}) {
  const q = dbc || db;
  const out = { checked: 0, closedDecided: 0, closedDuplicate: 0 };
  let open = [];
  try {
    open = (await q.query(
      `SELECT id, borrower_id, proposed_value, created_at
         FROM sync_review_queue
        WHERE status='open' AND field_key='current_address' AND source='encompass'
          AND borrower_id IS NOT NULL AND proposed_value IS NOT NULL
        ORDER BY created_at LIMIT $1`, [limit])).rows;
  } catch (_) { return out; }
  out.checked = open.length;
  if (!open.length) return out;

  let all = [];
  try {
    all = (await q.query(
      `SELECT id, borrower_id, status, auto_resolved, proposed_value, created_at
         FROM sync_review_queue
        WHERE field_key='current_address' AND source='encompass'
          AND borrower_id = ANY($1::uuid[]) AND proposed_value IS NOT NULL
        ORDER BY created_at`, [[...new Set(open.map((r) => String(r.borrower_id)))]])).rows;
  } catch (_) { return out; }

  const same = (a, b) => { try { return a === b || ADDR.sameAddress(a, b); } catch (_) { return false; } };
  const decided = [], duplicate = [];
  for (const row of open) {
    const siblings = all.filter((r) => String(r.borrower_id) === String(row.borrower_id)
      && String(r.id) !== String(row.id) && same(r.proposed_value, row.proposed_value));
    // A PERSON already answered this exact question. `auto_resolved` is excluded
    // deliberately: this pass's own closures are not decisions, and counting them
    // would make the SECOND run retire the very card the first run kept — the
    // survivor's now-closed duplicate reading as "someone answered it".
    if (siblings.some((r) => r.status !== 'open' && !r.auto_resolved)) { decided.push(row.id); continue; }
    // An OLDER open card asks it — that one stays, this one is a duplicate.
    // Compare by created_at, falling back to the id so ties are still decided
    // deterministically and two rows can never both consider the other older
    // (which would close both and lose the question entirely).
    const olderExists = siblings.some((r) => r.status === 'open'
      && (r.created_at < row.created_at
        || (String(r.created_at) === String(row.created_at) && String(r.id) < String(row.id))));
    if (olderExists) duplicate.push(row.id);
  }

  const closeThese = async (ids, note) => {
    if (!ids.length) return 0;
    try {
      // `sync_review_queue.id` is a BIGINT — compared as TEXT deliberately (a
      // `::uuid[]` cast throws inside the catch and reports "closed 0").
      const w = await q.query(
        `UPDATE sync_review_queue
            SET status='resolved', auto_resolved=true, resolved_at=now(), resolution_note=$2
          WHERE id::text = ANY($1::text[]) AND status='open'`, [ids.map(String), note]);
      return w.rowCount || 0;
    } catch (_) { return 0; }
  };
  out.closedDecided = await closeThese(decided,
    'auto-closed — someone already decided this same address for this borrower. It came back only because the question had been filed under a different Encompass loan; the earlier decision stands and nothing was changed on either side.');
  out.closedDuplicate = await closeThese(duplicate,
    'auto-closed — a second card for the same address on the same borrower. The original card is still open and is the one to answer; nothing was changed on either side.');
  return out;
}

module.exports = { closeEquivalentAddressReviewsOnce, closeSupersededAddressReviewsOnce };

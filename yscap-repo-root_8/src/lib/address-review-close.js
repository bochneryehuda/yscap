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

module.exports = { closeEquivalentAddressReviewsOnce };

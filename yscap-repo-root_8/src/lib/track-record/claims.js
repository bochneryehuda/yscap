'use strict';
/**
 * WHO IS WORKING THIS PROPERTY — the shared-queue hook for the bulk workbench.
 *
 * `track_record_candidates.claimed_by` / `claimed_at` have existed since db/496
 * and NOTHING has ever written them. That is the dead-schema class CLAUDE.md
 * names: a column every reader treats as "nobody is on it", forever, with no
 * error anywhere to say the feature was never finished.
 *
 * It matters now because the workbench made this queue genuinely shared. A
 * reviewer ticks eight properties and walks them one at a time against the
 * compare table; that run takes minutes. A second reviewer opening the same
 * borrower sees the same eight, and the two of them re-do each other's reading
 * — a per-property accuracy review done twice is not twice as accurate, it is
 * one wasted pass and two people who each believe the other checked it.
 *
 * ═══ A CLAIM IS ADVISORY. IT MUST NEVER BLOCK A DECISION. ══════════════════
 * This is the load-bearing rule of the whole module, so it is stated before
 * anything else: `decideCandidate` does not consult claims and must not learn
 * to. A claim says "somebody is looking at this", never "you may not act".
 *
 * The reason is concrete. A claim is taken when a review run starts and there
 * is no reliable moment to release it — a closed tab, a dropped connection, a
 * reviewer who goes to lunch mid-run. If a claim could refuse a decision, every
 * one of those leaves a property that nobody can promote until a timer expires,
 * and the queue acquires a way to get stuck that it did not have before. The
 * durable status guard (`decideCandidate`'s prior-status check plus db/496's
 * partial unique index) is what actually stops two people double-deciding one
 * property, and it works whether or not anybody claimed anything.
 *
 * So the worst a stale claim can cost is one line of stale text on a screen.
 * That is the right worst case for a convenience signal.
 *
 * ═══ CLAIMING IS ONE STATEMENT, NEVER READ-THEN-WRITE ══════════════════════
 * The obvious shape — SELECT the unclaimed rows, then UPDATE them — is the
 * exact race db/401 had to fix for the conditions engine: two reviewers reading
 * "unclaimed" in the same instant and both writing. Here the whole decision
 * lives in the UPDATE's WHERE clause and the rows it actually took come back
 * through RETURNING, so the database decides and there is no window between the
 * read and the write. Whoever loses simply sees the other person named.
 */

/* ═══ THE BORROWER IS PART OF THE KEY, NOT JUST PART OF THE URL ═════════════
 * Every function here takes `borrowerId` and every statement filters on it.
 * That is not belt-and-braces; without it these were a horizontal-access hole,
 * found by audit before release: the route authorises `req.params.id` (the
 * borrower whose queue you asked for) and then passed the request's `ids[]`
 * straight down. A candidate id is a `bigserial`, so ids are guessable by
 * counting — a loan officer could POST another borrower's candidate ids to
 * their OWN borrower's claim URL, pass the 403, and read back `heldByOthers`,
 * which names the PROPERTY ADDRESS and the REVIEWER working it. Two of the
 * three things this repo is most careful about, handed to somebody with no
 * relationship to that borrower.
 *
 * The lesson generalises past this module: a door that authorises a SUBJECT in
 * the path must re-assert that subject on every row the BODY names. Checking
 * the URL only proves you may look at that borrower — never that the ids you
 * sent belong to them. The sibling routes (`/compare`, `/decide`) resolve the
 * owner FROM the row for exactly this reason; this one took the owner from the
 * path and the rows from the body, and nothing tied the two together.
 */

/* ═══ THE ID IS A BIGINT — COMPARE IT AS TEXT ═══════════════════════════════
 * `track_record_candidates.id` is a bigint, and `id = ANY($1::uuid[])` raises
 * "operator does not exist: bigint = uuid". Inside the advisory catch below
 * that error is INVISIBLE: every claim reported zero rows taken while the rows
 * were sitting right there, which reads exactly like "nobody claimed anything"
 * rather than like a broken query. CLAUDE.md already records this trap on
 * `sync_review_queue.id` ("a ::uuid[] cast throws inside the catch and the pass
 * silently reports closed 0 while finding every row") — same shape, same table
 * family, and it cost a test run here before the catch was opened up.
 * `id::text = ANY($1::text[])` is the form to use. `claimed_by` IS a uuid
 * (staff_users.id), so only the candidate id needs the text comparison. */
const STALE_MINUTES = 30;

/* A claim is only interesting while the property is still waiting to be
   reviewed. Anything already decided has left the queue. */
const CLAIMABLE_STATUS = 'staged';

function ids(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

/**
 * Take the claim on everything in `list` that is free to take.
 *
 * "Free" is unclaimed, or claimed longer ago than STALE_MINUTES, or ALREADY
 * MINE — re-claiming my own rows refreshes the clock, which is what keeps a
 * long review run from expiring under the person actually doing it.
 *
 * Returns what was taken AND what was held by somebody else, because the
 * screen has to be able to say so. Never throws: a claim is a convenience, and
 * failing to take one must never stop a review from starting.
 */
async function claimForReview(list, staffId, borrowerId, client) {
  const db = client || require('../../db');
  const wanted = ids(list);
  const out = { claimed: [], heldByOthers: [] };
  if (!wanted.length || !staffId || !borrowerId) return out;

  try {
    const taken = (await db.query(
      `UPDATE track_record_candidates c
          SET claimed_by = $2, claimed_at = now()
        WHERE c.id::text = ANY($1::text[])
          AND c.borrower_id = $3::uuid
          AND c.status = '${CLAIMABLE_STATUS}'
          AND (c.claimed_by IS NULL
               OR c.claimed_by = $2
               OR c.claimed_at < now() - interval '${STALE_MINUTES} minutes')
        RETURNING c.id`,
      [wanted, staffId, borrowerId])).rows.map((r) => String(r.id));
    out.claimed = taken;

    /* Whatever was NOT taken is either decided already or genuinely held by a
       colleague. Only the second is worth saying out loud, and it is worth
       naming the person — "someone else is reviewing this" sends a reviewer
       hunting, "Miriam is reviewing this" ends the question. */
    const missed = wanted.filter((id) => !taken.includes(id));
    if (missed.length) {
      out.heldByOthers = (await db.query(
        `SELECT c.id, c.property_address, c.claimed_at,
                NULLIF(TRIM(COALESCE(u.full_name,'')),'') AS claimed_by_name
           FROM track_record_candidates c
           LEFT JOIN staff_users u ON u.id = c.claimed_by
          WHERE c.id::text = ANY($1::text[])
            AND c.borrower_id = $3::uuid
            AND c.status = '${CLAIMABLE_STATUS}'
            AND c.claimed_by IS NOT NULL
            AND c.claimed_by <> $2
            AND c.claimed_at >= now() - interval '${STALE_MINUTES} minutes'`,
        [missed, staffId, borrowerId])).rows.map((r) => ({
          id: String(r.id),
          address: r.property_address || null,
          by: r.claimed_by_name || 'another reviewer',
          at: r.claimed_at,
        }));
    }
  } catch (_) { /* advisory — a failed claim never stops the review */ }
  return out;
}

/**
 * Give back the claims I hold. Scoped to MY id on purpose: releasing is not a
 * way to take a property off somebody else.
 */
async function releaseClaims(list, staffId, borrowerId, client) {
  const db = client || require('../../db');
  const wanted = ids(list);
  if (!wanted.length || !staffId || !borrowerId) return 0;
  try {
    const r = await db.query(
      `UPDATE track_record_candidates
          SET claimed_by = NULL, claimed_at = NULL
        WHERE id::text = ANY($1::text[])
          AND borrower_id = $3::uuid
          AND claimed_by = $2`,
      [wanted, staffId, borrowerId]);
    return r.rowCount || 0;
  } catch (_) { return 0; }
}

/**
 * How a claim should READ on a row, for the person looking at it now.
 *
 * PURE — it takes the row and the viewer and returns words. A stale claim is
 * reported as no claim at all rather than as "held": the whole point of the
 * expiry is that an abandoned run stops speaking for a property, and showing
 * "held by Miriam (2 days ago)" would be worse than showing nothing, because
 * it reads as current.
 */
function claimStateOf(row, viewerStaffId, nowMs) {
  const by = row && row.claimed_by ? String(row.claimed_by) : null;
  const at = row && row.claimed_at ? new Date(row.claimed_at).getTime() : null;
  if (!by || !at || !Number.isFinite(at)) return { held: false, mine: false, by: null };

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (now - at > STALE_MINUTES * 60 * 1000) return { held: false, mine: false, by: null, expired: true };

  const mine = !!viewerStaffId && by === String(viewerStaffId);
  return {
    held: true,
    mine,
    by: mine ? null : (row.claimed_by_name || 'another reviewer'),
    at: row.claimed_at,
  };
}

module.exports = {
  claimForReview,
  releaseClaims,
  claimStateOf,
  STALE_MINUTES,
};

'use strict';
/**
 * THE BORROWER'S OWN RECORDS SEARCH — "find my past projects" from the portal
 * (owner-directed 2026-08-19: "also on the borrower side, they can click the
 * search button on themselves and import their entire track record").
 *
 * ═══ WHAT THE BORROWER'S CLICK RUNS ════════════════════════════════════════
 * The SAME engine the staff button runs — `importer.runSearch`, which does the
 * deep person-id pull when a human has linked their Elementix profile and the
 * per-company searches otherwise — through the same staging + import gates, so
 * a borrower's click can never import anything a staffer's click could not.
 * Two deliberate narrowings, both about who is holding the screen:
 *
 *   · `personalNameSearch: false` — a bare NAME search can hand a member of
 *     the public a list of a STRANGER's real estate (the same-name case the
 *     staging table exists for; docs/research/elementix/08-borrower-self-import.md
 *     §1). The linked person-id pull is unaffected — that identity was
 *     confirmed by a human — and so are the entity searches.
 *   · No state picker and no options: one button, zero input to validate.
 *
 * ═══ THE BUDGET — a borrower may spend the office's allowance ONLY THROUGH
 *     THIS DOOR, bounded three ways ═════════════════════════════════════════
 *   1. a per-minute in-memory throttle at the route (`keyedRateLimit`, keyed
 *      on the borrower — never the IP);
 *   2. a DURABLE cooldown: any search for this borrower (theirs or staff's)
 *      inside COOLDOWN_MINUTES answers from what already landed, spending
 *      nothing — the engine is idempotent, so a re-run minutes later can only
 *      re-spend calls to re-find the same records;
 *   3. a DURABLE monthly ceiling on borrower-run searches, counted from the
 *      search rows themselves (`query.requestedBy='borrower'`, written by
 *      runSearch) — never an in-memory counter that a restart resets.
 *
 * `src/lib/track-record/borrower-confirm.js` stays vendor-free (its own test
 * asserts it) — this module is the SEPARATE door that research doc §0 said the
 * borrower-initiated search must be.
 *
 * ═══ EVERY ANSWER IS BORROWER-SAFE ═════════════════════════════════════════
 * The staff response carries internal wording (skip reasons, switch names, the
 * vendor's name). The borrower gets counts + ONE plain sentence composed here,
 * about "the public records" — and "found nothing" is never worded as "you
 * have no history".
 */

const COOLDOWN_MINUTES = 15;
const MONTHLY_CAP = 10;

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The one plain sentence the borrower reads. Pure — tested directly. */
function borrowerSummary(kind, c = {}) {
  const s = (x, w) => `${x} ${w}${x === 1 ? '' : 's'}`;
  if (kind === 'cooldown') {
    return 'Your records were already searched in the last few minutes — anything found is on your record below. You can search again in a little while.';
  }
  if (kind === 'limit') {
    return 'You have reached this month’s limit for record searches. Your loan team can run one for you if something is missing.';
  }
  if (kind === 'unavailable') {
    return 'The public-records search is not available right now, so nothing was searched. Please try again in a little while — this says nothing about your record.';
  }
  if (kind === 'nothing_to_search') {
    return 'We do not have enough on your profile to search the records yet. Add the company you buy under, or ask your loan team to connect your records profile, then try again.';
  }
  if (kind === 'imported') {
    const parts = [];
    if (c.imported) parts.push(`${s(c.imported, 'project')} from the public records ${c.imported === 1 ? 'was' : 'were'} added to your track record`);
    if (c.merged) parts.push(`${s(c.merged, 'existing line')} ${c.merged === 1 ? 'was' : 'were'} filled in from the records`);
    if (c.entitiesAdded) parts.push(`${s(c.entitiesAdded, 'company')} ${c.entitiesAdded === 1 ? 'was' : 'were'} added to your profile`);
    return `Good news — ${parts.join(', ')}.`
      + (c.forReview ? ` ${c.forReview} possible match${c.forReview === 1 ? ' is' : 'es are'} waiting for you to confirm below.` : '')
      + ' Everything added still needs your loan team’s review before it counts toward experience.';
  }
  if (kind === 'for_review') {
    return `We found ${n(c.forReview)} propert${n(c.forReview) === 1 ? 'y' : 'ies'} in the public records that might be yours — please confirm ${n(c.forReview) === 1 ? 'it' : 'them'} below.`;
  }
  return 'We searched the public records and did not find new properties. Counties do not always publish online, so this does not mean there is nothing — you can still add projects yourself below.';
}

/**
 * Run the borrower's search, or answer why not. Returns the exact JSON the
 * route sends; `ran` says whether the engine actually ran (the audit line and
 * the live-refresh event key on it).
 */
async function selfSearch(borrowerId, client) {
  const db = client || require('../../db');

  // 2. THE DURABLE COOLDOWN — any search, any requester. The check reads; only
  //    a real run writes, so a cooldown answer can never extend the cooldown.
  const recent = (await db.query(
    `SELECT 1 FROM track_record_searches
      WHERE borrower_id=$1 AND run_at > now() - ($2 || ' minutes')::interval
      LIMIT 1`, [borrowerId, String(COOLDOWN_MINUTES)])).rows[0];
  if (recent) {
    return { ok: true, ran: false, cooldown: true, forReview: await stagedCount(db, borrowerId), summary: borrowerSummary('cooldown') };
  }

  // 3. THE MONTHLY CEILING — borrower-run rows only; a staff search never
  //    spends the borrower's allowance, and a cooldown answer never counts.
  const month = (await db.query(
    `SELECT count(*)::int AS c FROM track_record_searches
      WHERE borrower_id=$1 AND query->>'requestedBy'='borrower'
        AND run_at > now() - interval '30 days'`, [borrowerId])).rows[0];
  if (n(month && month.c) >= MONTHLY_CAP) {
    return { ok: true, ran: false, limit: true, forReview: await stagedCount(db, borrowerId), summary: borrowerSummary('limit') };
  }

  const out = await require('./importer').runSearch({
    borrowerId, staffId: null, requestedBy: 'borrower', personalNameSearch: false,
  }, db);

  const el = out.elementix || {};
  const counts = {
    found: n(out.found),
    imported: n(el.imported),
    merged: n(el.merged),
    entitiesAdded: n(el.entitiesAdded),
    forReview: await stagedCount(db, borrowerId),
  };

  let kind = 'nothing_found';
  if (out.vendorProblem) kind = 'unavailable';
  else if (!Array.isArray(out.searchedUnder) || out.searchedUnder.length === 0) kind = 'nothing_to_search';
  else if (counts.imported || counts.merged || counts.entitiesAdded) kind = 'imported';
  else if (counts.forReview) kind = 'for_review';

  return {
    ok: true,
    ran: true,
    unavailable: kind === 'unavailable' || undefined,
    nothingToSearch: kind === 'nothing_to_search' || undefined,
    ...counts,
    summary: borrowerSummary(kind, counts),
    /* For the audit line only — the route never echoes these to the screen. */
    _audit: { searchId: out.searchId, apiCalls: n(out.apiCalls), staged: n(out.staged), skipped: n(out.skipped) },
  };
}

/** How many found properties are waiting for the borrower's own yes/no — the
 *  queue `borrower-confirm.loadForBorrower` shows (staged, not snoozed-away). */
async function stagedCount(db, borrowerId) {
  try {
    const r = (await db.query(
      `SELECT count(*)::int AS c FROM track_record_candidates
        WHERE borrower_id=$1 AND status='staged'
          AND (snoozed_until IS NULL OR snoozed_until <= now())`, [borrowerId])).rows[0];
    return n(r && r.c);
  } catch (_) { return 0; }
}

module.exports = { selfSearch, COOLDOWN_MINUTES, MONTHLY_CAP, _internals: { borrowerSummary, stagedCount } };

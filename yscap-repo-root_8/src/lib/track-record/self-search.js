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
/* How many of the borrower's companies ONE self-search may look up. A borrower
   can add companies without limit, and every company is its own set of vendor
   round trips out of an allowance the whole office shares. Twelve is the same
   order as the importer's own STATE_CAP and covers every real portfolio seen
   here; past it, the search says what it did not reach. */
const BORROWER_ENTITY_CAP = 12;

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
  if (kind === 'running') {
    return 'A search of your records is already running — give it a moment, then refresh this page to see what it found.';
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

  /* ONE SEARCH PER BORROWER AT A TIME — the two guards below are read-then-act,
     and the write that arms them happens inside runSearch, so three clicks
     landing together all read "no recent search" and all run. Measured before
     this lock existed: 3 concurrent posts → 3 full searches, and a borrower one
     under the ceiling could push past it. The in-memory route throttle is not a
     bound here (it dies with the process and does not span instances).
     `pg_try_advisory_lock` rather than the blocking form the conditions engine
     uses: a search takes vendor round trips, and holding an HTTP request open
     behind one for half a minute is worse than telling the second click that a
     search is already running — which is true, and is what the cooldown would
     have said a second later anyway.
     It FAILS OPEN on a lock error (a database hiccup must not make the button
     dead), which is the same trade `evaluateApplication` documents: the worst
     case is one extra search, and the durable guards still bound the rest. */
  let lockConn = null;
  const lockKey = `tr-self-search:${borrowerId}`;
  if (!client) {
    try {
      lockConn = await db.getClient();
      const got = await lockConn.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [lockKey]);
      if (!got.rows[0] || got.rows[0].ok !== true) {
        try { lockConn.release(); } catch (_) { /* noop */ }
        return { ok: true, ran: false, running: true, forReview: await stagedCount(db, borrowerId), summary: borrowerSummary('running') };
      }
    } catch (_) {
      if (lockConn) { try { lockConn.release(); } catch (_e) { /* noop */ } }
      lockConn = null;                     // fail open — never a dead button
    }
  }
  try {
    return await selfSearchLocked(borrowerId, db);
  } finally {
    if (lockConn) {
      try { await lockConn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); } catch (_) { /* noop */ }
      try { lockConn.release(); } catch (_) { /* noop */ }
    }
  }
}

/* A RUN THAT REACHED THE VENDOR IS THE ONLY RUN THAT COUNTS, for both durable
   guards. The search row is written BEFORE the outcome is known (so an outage
   can never bypass the cooldown), which means a run that could not search at
   all — no company on the profile, no linked records profile, vendor switched
   off — was still burning one of ten monthly credits AND locking the borrower
   out for fifteen minutes. The screen tells them, in those words, to add a
   company and try again; the retry was then refused. That is the dead end this
   file exists to avoid, so both guards read `api_calls > 0`: we only charge
   somebody for a search that actually went out. */
const SPENT_SQL = 'COALESCE(api_calls, 0) > 0';

async function selfSearchLocked(borrowerId, db) {
  // 2. THE DURABLE COOLDOWN — any search that SPENT something, any requester.
  const recent = (await db.query(
    `SELECT 1 FROM track_record_searches
      WHERE borrower_id=$1 AND ${SPENT_SQL}
        AND run_at > now() - ($2 || ' minutes')::interval
      LIMIT 1`, [borrowerId, String(COOLDOWN_MINUTES)])).rows[0];
  if (recent) {
    return { ok: true, ran: false, cooldown: true, forReview: await stagedCount(db, borrowerId), summary: borrowerSummary('cooldown') };
  }

  // 3. THE MONTHLY CEILING — borrower-run rows that spent something; a staff
  //    search never spends the borrower's allowance, and neither does a run
  //    that had nothing to search.
  const month = (await db.query(
    `SELECT count(*)::int AS c FROM track_record_searches
      WHERE borrower_id=$1 AND query->>'requestedBy'='borrower' AND ${SPENT_SQL}
        AND run_at > now() - interval '30 days'`, [borrowerId])).rows[0];
  if (n(month && month.c) >= MONTHLY_CAP) {
    return { ok: true, ran: false, limit: true, forReview: await stagedCount(db, borrowerId), summary: borrowerSummary('limit') };
  }

  const out = await require('./importer').runSearch({
    borrowerId, staffId: null, requestedBy: 'borrower', personalNameSearch: false,
    /* THE BORROWER DOES NOT GET TO SET THE BILL. The search loops every company
       on the profile, and a borrower can add companies with no cap — measured:
       50 companies on one profile = 200 calls out of the office's SHARED
       hourly allowance, in a single click, which then answers `rate_limited`
       to the underwriting desk. Staff keep the uncapped fan-out (they are
       spending deliberately); the borrower's own door searches at most
       BORROWER_ENTITY_CAP, and what it did not reach is REPORTED as a skip
       rather than quietly left out. */
    entityCap: BORROWER_ENTITY_CAP,
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

module.exports = {
  selfSearch, COOLDOWN_MINUTES, MONTHLY_CAP, BORROWER_ENTITY_CAP,
  _internals: { borrowerSummary, stagedCount, SPENT_SQL },
};

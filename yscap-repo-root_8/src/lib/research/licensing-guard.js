'use strict';
/**
 * IS THE LICENSING CONSTRAINT ACTUALLY THERE?
 *
 * db/458 puts a CHECK constraint on `properties` that refuses a Google-sourced
 * coordinate, because Google Maps Platform caps a STORED latitude/longitude at 30
 * consecutive days unless the cache is isolated to one end user, and this
 * warehouse is permanent and shared. The full reasoning is in that migration and
 * in docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md.
 *
 * THE GAP THIS CLOSES. `migrate-boot.ensureSchema()` NEVER THROWS — it logs
 * `[migrate] <file> FAILED: … — continuing` and moves on, deliberately, so one bad
 * migration can never take the whole company offline. That is the right trade for
 * a schema change; it is the wrong trade for a CONTROL, because the app then runs
 * happily with the control absent and nothing anywhere says so. The constraint is
 * re-applied on every boot, so a transient failure heals itself — but a PERSISTENT
 * one (rows already violating it, a permission problem, a lock it can never take)
 * leaves a licensing rule switched off, silently, indefinitely.
 *
 * SO THIS ASKS THE DATABASE, out loud: at boot, and again whenever a health check
 * finds the last answer over a minute old — because the routes this exists to
 * catch (a psql session, an unreviewed import script) all happen while the
 * process is UP, and a boot-only snapshot would report the state at the last
 * deploy. It does not repair — re-running the same ALTER from here would fail
 * exactly the way the migration just did — it REPORTS, and when the constraint is
 * missing it counts the rows that would violate it, because that is almost always
 * the reason and it is the thing somebody has to act on.
 *
 * THE DETAIL IS FOR THE LOG AND FOR STAFF, NOT FOR THE WORLD. `why` can carry a
 * database error verbatim (host, port, role name) and a count of violating rows;
 * `/api/health` is PUBLIC, so it publishes only whether the control is confirmed.
 *
 * IT NEVER BLOCKS AND NEVER THROWS. Refusing to boot over this would be a worse
 * outcome than the breach it guards against, and an exception on the health path
 * would turn a licensing warning into an outage. What it will not do is report
 * "protected" when it does not know: a failed check reads as UNCONFIRMED, never
 * as fine.
 */

const CONSTRAINT = 'properties_no_google_geo_ck';
const TABLE = 'properties';

/* The code-level half of the same rule lives in geocode.js (`FORBIDDEN_SOURCE`),
   which refuses to write such a coordinate in the first place. This is about the
   database's own guarantee — the one that also covers a hand-run migration, a
   psql session, or an import script nobody reviewed. */

/** Is the constraint installed? `{ ok, checked, present, offenders, why }` — never throws. */
async function checkGeoLicensing(dbc) {
  const db = dbc || require('../../db');
  let present;
  try {
    /* KEYED ON THE TABLE THE APP ACTUALLY WRITES TO, AND ON A CONSTRAINT THAT
       ACTUALLY MEANS SOMETHING. `to_regclass` resolves `properties` through the
       SAME search_path the app's own INSERTs use, so a same-named table in
       another schema cannot let this report "protected" about a table nothing
       writes to. `convalidated` matters just as much: a constraint added NOT
       VALID is present, does not apply to a single existing row, and would read
       as fully installed. And the DEFINITION is compared, because a constraint
       wearing the right name over `CHECK (true)` is the most plausible way this
       ends up switched off without anyone noticing. */
    const r = await db.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = to_regclass($1)::oid
          AND c.conname = $2 AND c.contype = 'c' AND c.convalidated
        LIMIT 1`, [TABLE, CONSTRAINT]);
    /* THE PREDICATE ITSELF, NOT A SMELL TEST. Asking only whether the definition
       MENTIONS `geo_source` and `google` passes three constraints that protect
       nothing — proven against real Postgres:
         · `NOT LIKE` typed as `LIKE`      — the rule INVERTED: it would then
           refuse every non-Google source and admit every Google one
         · `NOT LIKE 'google'`             — wildcards dropped, so the value the
           app actually writes (`google_places`) sails straight through
         · `geo_source IS NOT NULL OR …`   — always true
       The middle one is the realistic accident: somebody "tidies" the pattern.
       So the WILDCARDED NEGATIVE MATCH is what is checked. Postgres deparses
       `NOT LIKE` as the operator `!~~`, which is why a `/not like/i` regex would
       find nothing — the real definition reads
       `CHECK (((geo_source IS NULL) OR (lower(geo_source) !~~ '%google%'::text)))`.
       Matching the operator rather than the whole string keeps this working if a
       future Postgres major deparses the surrounding parentheses differently. */
    const def = String((r.rows[0] || {}).def || '');
    /* CASE-SENSITIVE, AND PINNED TO `lower(...)`. The first attempt at this check
       carried an `/i` flag, which re-opened the very hole it was written to close:
       the constraint case-FOLDS the column, so a pattern written `'%GOOGLE%'` can
       never match anything and the rule is always true — and `/i` reported it as
       installed. Proven: with that constraint in place, `geo_source='google_places'`
       INSERTed successfully while the guard answered ok:true. Requiring the pattern
       to be lower-case AND to sit against `lower(geo_source)` ties the two halves
       together, so neither can be "tidied" independently.
       This is deliberately strict: a correct rule written some OTHER way (ILIKE,
       strpos, a regex operator) reads as NOT installed. That is a false alarm
       rather than a false all-clear, and db/458 re-applies this exact text on every
       boot — so the strictness costs nothing and the laxity cost everything. */
    present = r.rows.length > 0
      && /lower\(geo_source\)\s*!~~\s*'%google%'/.test(def);
  } catch (e) {
    // We could not ask. That is NOT the same as "it is fine".
    const why = (db.describeError ? db.describeError(e) : e.message);
    return { ok: false, checked: false, present: null, offenders: null,
      why: `could not confirm the Google-coordinate rule is installed: ${why}` };
  }
  if (present) return { ok: true, checked: true, present: true, offenders: 0, why: null };

  // Only now — the constraint is missing, so the scan is the rare path, not the
  // boot path. Rows already in violation are the overwhelmingly likely reason the
  // migration could not apply, and they are what somebody has to delete or re-source.
  let offenders = null;
  try {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM ${TABLE}
        WHERE geo_source IS NOT NULL AND lower(geo_source) LIKE '%google%'`);
    offenders = r.rows[0].n;
  } catch (_) { /* the count is a diagnosis, not the finding */ }

  /* THREE OUTCOMES, NOT TWO. `offenders` is null when the count itself FAILED —
     a role without SELECT on the table, a statement timeout — and reading that as
     a falsy zero told somebody "db/458 did not apply, check the migrate log" when
     the truth is "we could not look". Saying we do not know is the one thing this
     module promises never to get wrong. */
  const head = `the Google-coordinate rule (${CONSTRAINT}) is NOT installed`;
  const why = offenders == null
    ? `${head}, and the rows in violation could NOT be counted — so the reason it cannot apply is `
      + 'still unknown. Check the [migrate] log for its FAILED line.'
    : offenders
      ? `${head}, and ${offenders} propert${offenders === 1 ? 'y' : 'ies'} already `
        + `carr${offenders === 1 ? 'ies' : 'y'} a Google-sourced coordinate — that is why db/458 cannot `
        + 'apply. Re-source or clear those rows and redeploy.'
      : `${head} — db/458 did not apply, and nothing is in violation, so it is not the data. Check the `
        + '[migrate] log for its FAILED line; until it is on, nothing at the database level stops a '
        + 'Google coordinate being stored permanently in the property warehouse.';
  return { ok: false, checked: true, present: false, offenders, why };
}

/* The last answer. `null` until something has asked — reported as unconfirmed,
   never as ok.

   THIS USED TO BE THE WHOLE STORY, AND THAT MADE THE CONTROL BLIND TO ITS OWN
   THREAT MODEL. db/458 exists because the constraint can be removed by a route
   nobody reviews — "a hand-run migration, a psql session, an import script". All
   of those happen while the process is UP. A boot-time snapshot reports the state
   at the last deploy, so somebody dropping the constraint on Monday is invisible
   until Friday; and a database blip during boot pinned "unconfirmed" forever even
   after it recovered. So the snapshot now EXPIRES. */
let last = null;
const FRESH_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 10 * 1000;
let refreshing = null;
/* Bumped whenever the slot is cleared, so a refresh that was in flight at the
   time can tell it has been superseded and stay silent. */
let refreshEpoch = 0;

/**
 * The check, with POSTGRES enforcing the time limit so a hung query cannot hold a
 * pooled connection. Never throws — `checkGeoLicensing` shapes its own errors, and
 * a statement timeout arrives as one, so it reads as "could not confirm".
 */
async function probeBounded() {
  const db = require('../../db');
  let client = null;
  try {
    client = await db.getClient();
  } catch (e) {
    // Could not even take a connection — say we do not know, never that it is fine.
    return { ok: false, checked: false, present: null, offenders: null,
      why: `could not confirm the Google-coordinate rule is installed: ${e.message}` };
  }
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${PROBE_TIMEOUT_MS}`);
    return await checkGeoLicensing(client);
  } catch (e) {
    return { ok: false, checked: false, present: null, offenders: null,
      why: `could not confirm the Google-coordinate rule is installed: ${e.message}` };
  } finally {
    // Read-only, so ROLLBACK is the honest close and leaves nothing behind.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** Run the check and say so in the log. Returns the result; never throws. */
async function assertGeoLicensing(dbc) {
  let res;
  try { res = await checkGeoLicensing(dbc); }
  catch (e) { res = { ok: false, checked: false, present: null, offenders: null, why: e.message }; }
  /* Bump the epoch as we publish, so a `health()` probe that was already in flight
     cannot land afterwards and overwrite this answer with an older verdict wearing
     a newer timestamp — the same rule the refresh path already follows. */
  refreshEpoch++;
  last = { ...res, at: new Date().toISOString(), atMs: Date.now() };
  if (res.ok) console.log('[research] Google-coordinate rule installed');
  // Loud on purpose: this is a licensing control, and the whole failure mode it
  // guards against is one nobody notices.
  else console.error(`[research] LICENSING CONTROL NOT CONFIRMED — ${res.why}`);
  return res;
}

/**
 * The snapshot for a health check. NEVER THROWS, and never blocks the caller:
 * a stale snapshot is served immediately while ONE refresh runs behind it, so a
 * slow or unreachable database can never make the health endpoint slow. The
 * single in-flight promise means a burst of health checks is still one query.
 */
function health() {
  const stale = !last || (Date.now() - last.atMs) > FRESH_MS;
  if (stale && !refreshing) {
    /* A REFRESH THAT NEVER SETTLES WOULD FREEZE THE ANSWER FOREVER — but the
       timeout has to be the SERVER's, not a promise race.
       A `Promise.race` abandons the PROMISE and not the QUERY: `pool.query` keeps
       its client checked out until the query settles, which by definition never
       happens, while `.finally` frees the single-flight slot so the NEXT health
       check starts a fresh probe on a FRESH connection. Measured: ten timeouts
       check out all ten pooled connections permanently and every other query in
       the app then blocks — strictly worse than the frozen verdict it replaced,
       which cost nothing but one stale answer. /api/health is public and polled,
       so that is a real way to take the app down.
       `SET LOCAL` inside a transaction makes POSTGRES cancel the statement, so the
       query genuinely ends and the client goes back to the pool; and being LOCAL it
       cannot leak the setting onto a recycled connection. */
    const epoch = ++refreshEpoch;
    const mine = probeBounded()
      // A refresh whose slot was reset out from under it must NOT publish: it
      // would overwrite a newer verdict with a stale one wearing a fresh stamp.
      .then((res) => { if (epoch === refreshEpoch) last = { ...res, at: new Date().toISOString(), atMs: Date.now() }; })
      .catch(() => { /* keep the previous answer; never throw on a health path */ })
      .finally(() => { if (refreshing === mine) refreshing = null; });
    refreshing = mine;
  }
  if (!last) {
    return { ok: false, checked: false,
      why: 'the Google-coordinate rule has not been checked yet on this process' };
  }
  const { atMs, ...out } = last;
  return out;
}

module.exports = {
  checkGeoLicensing, assertGeoLicensing, health, CONSTRAINT, TABLE,
  _internals: {
    FRESH_MS,
    PROBE_TIMEOUT_MS,
    // TEST ONLY. Bumping the epoch is what makes it safe: an in-flight refresh
    // cannot be cancelled, so it is instead forbidden from publishing.
    reset: () => { last = null; refreshing = null; refreshEpoch++; },
  },
};

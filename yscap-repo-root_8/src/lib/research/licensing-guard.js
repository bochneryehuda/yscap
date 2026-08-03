'use strict';
/**
 * IS THE LICENSING CONSTRAINT ACTUALLY THERE?
 *
 * db/459 puts a CHECK constraint on `properties` that refuses a Google-sourced
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

/* THE EXACT PREDICATE db/459 INSTALLS, as Postgres deparses it. Compared WHOLE,
   because a substring test passes anything that merely CONTAINS the right clause
   and is defeated by what sits around it — `… OR true`, `… OR geo_source IS NOT
   NULL`, `NOT (… AND …)`, a `CASE` that never reaches it. All six were proven
   against real Postgres to report "installed" under a substring test while the
   database happily ACCEPTED `geo_source='google_places'`. `\(+`/`\)+` absorb the
   redundant parentheses Postgres adds; the whitespace is normalised first. */
const EXACT_DEF =
  /^CHECK \(+\(geo_source IS NULL\) OR \(lower\(geo_source\) !~~ '%google%'::text\)\)+$/;

/* What the app actually writes, plus the casing that the first version of this
   guard let through. A rule that refuses one and admits the other is not a rule. */
const PROBE_SOURCES = ['google_places', 'GOOGLE'];

/**
 * DOES THE DATABASE ACTUALLY REFUSE A GOOGLE COORDINATE?
 *
 * A NEGATIVE ORACLE ONLY, and that asymmetry is the whole design. One row the
 * database ACCEPTS proves the rule protects nothing. One row it REFUSES proves
 * nothing about every other row — so this may only ever DOWNGRADE the text check's
 * verdict, never promote it. Getting that backwards is not theoretical: the first
 * version of this probe overwrote the verdict in both directions, and three
 * constraints then reported "installed" while a real Google write SUCCEEDED —
 * `… OR (geo_latitude IS NOT NULL AND geo_longitude IS NOT NULL)`, `… OR city IS
 * NOT NULL`, `… OR geo_at IS NOT NULL`. The first is the dangerous one, because it
 * is the licensing-correct thought ("the rule is about a STORED COORDINATE")
 * written the wrong way round. All three were proven against real Postgres.
 *
 * SO THE PROBE ROW LOOKS LIKE A REAL WRITE. `geocode.js` sets geo_latitude,
 * geo_longitude, geo_source, geo_precision, geo_at and geo_attempted_at together,
 * onto a row that already has a city and a state. A probe carrying only
 * `geo_source` is refused by any exemption keyed on the other five while every
 * real row sails through — and it also FALSE-ALARMS on the legitimate narrowing
 * `… OR geo_latitude IS NULL` ("enforce the rule only when a coordinate is
 * actually stored"), which genuinely does refuse a real Google write.
 *
 * ATTRIBUTED, not just refused: Postgres names the constraint that rejected the
 * row, so "something else happened to stop it" can never read as "our rule works".
 *
 * REQUIRES A CHECKED-OUT CLIENT ALREADY INSIDE A TRANSACTION — never the pool.
 * `pool.query` hands out a different connection per call, so the INSERT would run
 * outside any transaction and COMMIT a junk row into the warehouse. Two things
 * stop that, and BOTH are load-bearing: the `release` test below rejects the db
 * module itself, and the leading SAVEPOINT fails with 25P01 outside a transaction
 * block. Do not make that SAVEPOINT conditional — it is the transaction guard, not
 * a tidiness measure.
 *
 * Returns `{ tested, refused, by }`. `tested:false` means we could not ask — a
 * read-only replica, a role without INSERT, a statement timeout, an unrelated
 * constraint the probe row happens to violate — and the caller must fall back to
 * the text check rather than read it either way.
 */
async function verifyRefusesGoogle(client) {
  // Not the pool, not the db module: a checked-out client has `release`.
  if (!client || typeof client.release !== 'function' || typeof client.query !== 'function') {
    return { tested: false, refused: null, by: null };
  }
  for (const value of PROBE_SOURCES) {
    // ALSO THE TRANSACTION GUARD — 25P01 outside a transaction block.
    try { await client.query('SAVEPOINT geo_licensing_probe'); }
    catch (_) { return { tested: false, refused: null, by: null }; }
    let err = null;
    try {
      await client.query(
        `INSERT INTO ${TABLE}
           (address_key, display_address, city, state,
            geo_source, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at)
         VALUES ($1, $2, 'Licensing Probe', 'NJ', $3, 40.1, -74.1, 'rooftop', now(), now())`,
        [`licensing-probe|${Date.now()}|${Math.random()}`, 'licensing probe', value]);
    } catch (e) { err = e; }
    // Undo it either way: on success the row must never survive, and on refusal
    // this is what lets the caller's transaction carry on.
    try { await client.query('ROLLBACK TO SAVEPOINT geo_licensing_probe'); }
    catch (_) { return { tested: false, refused: null, by: null }; }

    if (!err) return { tested: true, refused: false, by: null };      // stored it — definitive
    if (err.code !== '23514') return { tested: false, refused: null, by: null }; // could not ask
    if (err.constraint !== CONSTRAINT) {
      // Refused, but by something else. That is not evidence about OUR rule.
      return { tested: false, refused: null, by: err.constraint || null };
    }
  }
  return { tested: true, refused: true, by: CONSTRAINT };
}

/**
 * Is the constraint installed? `{ ok, checked, present, offenders, why }` — never throws.
 *
 * `opts.verifyWrite` promises that `dbc` is a client ALREADY INSIDE A TRANSACTION,
 * which unlocks the definitive behavioural probe above. It is opt-in precisely
 * because it is unsafe on the pool, and this function is also called with one.
 */
async function checkGeoLicensing(dbc, opts) {
  const db = dbc || require('../../db');
  let present;
  let neutered = false;
  let named = false;
  let probe = null;
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
       Postgres deparses `NOT LIKE` as the operator `!~~`, which is why a
       `/not like/i` regex would find nothing — the real definition reads
       `CHECK (((geo_source IS NULL) OR (lower(geo_source) !~~ '%google%'::text)))`.

       MATCHED WHOLE, not as a substring, and CASE-SENSITIVELY. Both laxities have
       already shipped and both re-opened the exact hole this closes: an `/i` flag
       made a `'%GOOGLE%'` pattern — which, against a case-FOLDED column, can never
       match anything — read as installed; and a substring test read `… OR true`
       and five other neutered variants as installed while the database accepted
       `geo_source='google_places'`. Pinning the pattern lower-case AND against
       `lower(geo_source)` ties the two halves together so neither can be "tidied"
       independently, and anchoring the whole string means nothing can be bolted on
       beside it.
       Deliberately strict: a correct rule written some OTHER way (ILIKE, strpos, a
       regex operator), or the same rule deparsed differently by a future Postgres,
       reads as NOT installed. That is a false alarm rather than a false all-clear,
       db/459 re-applies this exact text on every boot, and the behavioural probe
       below can only ever make this answer STRICTER, never laxer. */
    const def = String((r.rows[0] || {}).def || '').replace(/\s+/g, ' ').trim();
    named = r.rows.length > 0;   // a validated CHECK of that name IS on the table
    present = named && EXACT_DEF.test(def);

    /* AND WHERE WE CAN, WE ALSO ASK THE DATABASE — but ONLY to say NO.
       The probe DOWNGRADES and never promotes: a row the database accepts proves
       the rule protects nothing, while a row it refuses proves nothing about every
       other row. So the anchored text stays a NECESSARY condition and the probe
       adds a second one. Overwriting in both directions is what let three
       coordinate- and city-keyed exemptions read as installed while a real Google
       write succeeded. */
    if (present && opts && opts.verifyWrite) {
      probe = await verifyRefusesGoogle(db);
      if (probe.tested && !probe.refused) { present = false; neutered = true; }
    }
  } catch (e) {
    // We could not ask. That is NOT the same as "it is fine".
    const why = (db.describeError ? db.describeError(e) : e.message);
    return { ok: false, checked: false, present: null, offenders: null,
      why: `could not confirm the Google-coordinate rule is installed: ${why}` };
  }
  if (present) {
    /* A PROBE THAT COULD NOT RUN MUST NOT READ AS ONE THAT PASSED. It is refused
       by any unrelated CHECK its row happens to violate, and by the next NOT NULL
       column added to `properties` without a default — and `properties` is an
       actively growing table. Without this the authoritative half would quietly
       stop running and the answer would still be a confident `ok:true, why:null`,
       which is the shape of every failure this module exists to prevent. */
    const blocked = opts && opts.verifyWrite && probe && !probe.tested;
    return {
      ok: true, checked: true, present: true, offenders: 0,
      probeTested: probe ? probe.tested : null,
      probeBlockedBy: probe ? probe.by : null,
      why: blocked
        ? `the Google-coordinate rule (${CONSTRAINT}) reads as installed, but the write probe `
          + `could NOT run${probe.by ? ` (the probe row was refused by ${probe.by})` : ''} — so this `
          + 'is the constraint\'s TEXT, not the database\'s own answer. Check whether a new NOT NULL '
          + `column or an unrelated CHECK on ${TABLE} is blocking it.`
        : null,
    };
  }

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
     a falsy zero told somebody "db/459 did not apply, check the migrate log" when
     the truth is "we could not look". Saying we do not know is the one thing this
     module promises never to get wrong. */
  /* A CONSTRAINT WEARING THE RIGHT NAME OVER A PREDICATE THAT REFUSES NOTHING is a
     different problem from a missing one, and it needs its own words: db/459 DID
     apply at some point, so "check the [migrate] log for its FAILED line" would
     send somebody looking at a log that says the migration succeeded.

     KEYED ON THE CONSTRAINT EXISTING, not on the probe having caught it. `named`
     is true whenever a validated CHECK of that name is on the table, which is
     proof enough on its own that the migration ran. Keying this on `neutered`
     alone was a real regression: the `present &&` short-circuit means the probe
     never even runs once the text check has said no, so EVERY ordinary neutering
     (`… OR true`, wildcards dropped, `CHECK (true)`) fell through to exactly the
     advice the paragraph above says must never be given. Only the shadowed-lower
     case — where the text is canonical — still set `neutered`. */
  if (neutered || named) {
    return { ok: false, checked: true, present: false, offenders,
      why: `the Google-coordinate rule (${CONSTRAINT}) EXISTS but does not refuse a `
        + `Google-sourced coordinate${neutered ? ' — the database accepted one when asked' : ''}. `
        + 'The constraint has been altered since db/459 installed it. Restore it (re-run db/459) '
        + 'and check who changed it; until then nothing at the database level stops a Google '
        + 'coordinate being stored permanently in the property warehouse.' };
  }

  const head = `the Google-coordinate rule (${CONSTRAINT}) is NOT installed`;
  const why = offenders == null
    ? `${head}, and the rows in violation could NOT be counted — so the reason it cannot apply is `
      + 'still unknown. Check the [migrate] log for its FAILED line.'
    : offenders
      ? `${head}, and ${offenders} propert${offenders === 1 ? 'y' : 'ies'} already `
        + `carr${offenders === 1 ? 'ies' : 'y'} a Google-sourced coordinate — that is why db/459 cannot `
        + 'apply. Re-source or clear those rows and redeploy.'
      : `${head} — db/459 did not apply, and nothing is in violation, so it is not the data. Check the `
        + '[migrate] log for its FAILED line; until it is on, nothing at the database level stops a '
        + 'Google coordinate being stored permanently in the property warehouse.';
  return { ok: false, checked: true, present: false, offenders, why };
}

/* The last answer. `null` until something has asked — reported as unconfirmed,
   never as ok.

   THIS USED TO BE THE WHOLE STORY, AND THAT MADE THE CONTROL BLIND TO ITS OWN
   THREAT MODEL. db/459 exists because the constraint can be removed by a route
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
    // Inside a transaction on a dedicated client — so the behavioural probe is
    // safe here, and ONLY here.
    return await checkGeoLicensing(client, { verifyWrite: true });
  } catch (e) {
    return { ok: false, checked: false, present: null, offenders: null,
      why: `could not confirm the Google-coordinate rule is installed: ${e.message}` };
  } finally {
    // Read-only, so ROLLBACK is the honest close and leaves nothing behind.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * Run the check and say so in the log. Returns the result; never throws.
 *
 * WITH NO `dbc` THIS GOES THROUGH THE BOUNDED PROBE, and that is not a detail.
 * `app.listen` has already fired by the time this runs, so the process is serving
 * traffic while the boot chain continues behind it — and `pg_get_constraintdef`
 * DOES block on an `ACCESS EXCLUSIVE` lock on `properties` (measured: 3002ms under
 * a 3s timeout, where `to_regclass` alone returns in 1ms). A `VACUUM FULL`, an
 * `ALTER TABLE`, or a stuck migration holding that lock would hang this call
 * forever on the pool, and `bootstrapAdmin()` and every boot backfill queued
 * after it would never run. Postgres enforcing the limit is what bounds it.
 * Going through the same path also means boot gets the behavioural probe.
 */
async function assertGeoLicensing(dbc) {
  let res;
  try { res = dbc ? await checkGeoLicensing(dbc) : await probeBounded(); }
  catch (e) { res = { ok: false, checked: false, present: null, offenders: null, why: e.message }; }
  /* Bump the epoch as we publish, so a `health()` probe that was already in flight
     cannot land afterwards and overwrite this answer with an older verdict wearing
     a newer timestamp — the same rule the refresh path already follows. */
  refreshEpoch++;
  last = { ...res, at: new Date().toISOString(), atMs: Date.now() };
  /* AN `ok:true` THAT CARRIES A `why` IS A QUALIFIED YES, AND IT MUST NOT PRINT AS
     A PLAIN ONE. The only way that happens is the write probe being blocked, which
     drops the check back to reading the constraint's TEXT — and a shadowed
     `lower()` deparses byte-identically to db/459's while refusing nothing. The
     previous version logged the unqualified "installed" line and threw `why` away,
     so the one signal that the authoritative half had stopped running reached
     nobody. */
  if (res.ok && res.why) console.warn(`[research] Google-coordinate rule: ${res.why}`);
  else if (res.ok) console.log('[research] Google-coordinate rule installed');
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
       cannot leak the setting onto a recycled connection.

       WHAT THIS STILL DOES NOT COVER, stated plainly because the first version of
       this comment claimed the whole class was closed: `statement_timeout` is
       enforced by the SERVER, so it needs the server to have RECEIVED the query.
       On a half-open socket it never does, and with the query already written it
       is TCP retransmission that gives up — about 15 minutes on Linux defaults.
       (`keepAlive` would not shorten it; keepalives only probe an IDLE socket, and
       this one has data in flight.) For that window the single-flight slot stays
       taken and the verdict is frozen at whatever it last said. That is bounded
       and self-healing rather than the permanent connection leak it replaced, and
       it is confined to /api/health's own snapshot. The admin page does NOT read
       that snapshot — it answers from its own bounded probe and stamps its own
       `at` at response time — so a stuck refresh surfaces there as that card's
       ordinary "could not check", never as a frozen timestamp nobody notices. Do not "fix" it by clearing the slot
       on a timer — that lets probes stack on a dead server and re-creates the
       exhaustion this design exists to prevent. */
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
  checkGeoLicensing, assertGeoLicensing, probeBounded, health, CONSTRAINT, TABLE,
  _internals: {
    FRESH_MS,
    PROBE_TIMEOUT_MS,
    EXACT_DEF,
    verifyRefusesGoogle,
    // TEST ONLY. Bumping the epoch is what makes it safe: an in-flight refresh
    // cannot be cancelled, so it is instead forbidden from publishing.
    reset: () => { last = null; refreshing = null; refreshEpoch++; },
  },
};

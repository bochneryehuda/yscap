'use strict';
/**
 * IS THE LICENSING CONSTRAINT ACTUALLY THERE?
 *
 * db/455 puts a CHECK constraint on `properties` that refuses a Google-sourced
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
 * SO THIS ASKS THE DATABASE, out loud, on every boot and on every health check:
 * is the constraint there? It does not repair — re-running the same ALTER from
 * here would fail exactly the way the migration just did — it REPORTS, and when
 * the constraint is missing it counts the rows that would violate it, because
 * that is almost always the reason and it is the thing somebody has to act on.
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
    const r = await db.query(
      `SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.conname = $1 AND t.relname = $2 AND c.contype = 'c'
        LIMIT 1`, [CONSTRAINT, TABLE]);
    present = r.rows.length > 0;
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

  const why = offenders
    ? `the Google-coordinate rule (${CONSTRAINT}) is NOT installed, and ${offenders} propert`
      + `${offenders === 1 ? 'y' : 'ies'} already carr${offenders === 1 ? 'ies' : 'y'} a Google-sourced `
      + 'coordinate — that is why db/455 cannot apply. Re-source or clear those rows and redeploy.'
    : `the Google-coordinate rule (${CONSTRAINT}) is NOT installed — db/455 did not apply. Check the `
      + '[migrate] log for its FAILED line; until it is on, nothing at the database level stops a '
      + "Google coordinate being stored permanently in the property warehouse.";
  return { ok: false, checked: true, present: false, offenders, why };
}

/* The last answer, so /api/health can report it without a query on every hit.
   `null` until the boot check has run — reported as unconfirmed, never as ok. */
let last = null;

/** Run the check and say so in the log. Returns the result; never throws. */
async function assertGeoLicensing(dbc) {
  let res;
  try { res = await checkGeoLicensing(dbc); }
  catch (e) { res = { ok: false, checked: false, present: null, offenders: null, why: e.message }; }
  last = { ...res, at: new Date().toISOString() };
  if (res.ok) console.log('[research] Google-coordinate rule installed');
  // Loud on purpose: this is a licensing control, and the whole failure mode it
  // guards against is one nobody notices.
  else console.error(`[research] LICENSING CONTROL NOT CONFIRMED — ${res.why}`);
  return res;
}

/** The snapshot for /api/health. Cheap, no query, never throws. */
function health() {
  if (!last) {
    return { ok: false, checked: false,
      why: 'the Google-coordinate rule has not been checked yet on this process' };
  }
  return last;
}

module.exports = { checkGeoLicensing, assertGeoLicensing, health, CONSTRAINT, TABLE };

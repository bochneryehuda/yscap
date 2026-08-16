'use strict';

// =============================================================================
// IS THE SCHEMA MAP BEHIND THE MIGRATIONS? — and it needs NO database to answer
// =============================================================================
//
// `check-schema-snapshot.js` is the thorough guard: it rebuilds the inventory
// from a live database and reports every difference. But it needs a database,
// so it SELF-SKIPS everywhere one is not configured — which is most places most
// of the time. A guard that is skipped is a guard that is not guarding, and the
// one moment the map goes stale is the one moment nobody has a database handy:
// somebody adds `db/554_*.sql` and moves on.
//
// This closes that hole with the cheapest possible question, asked from two
// things that are always present:
//
//   • `docs/schema/beyond-prisma.json` records WHICH migrations built it
//     (`generatedFrom.migrations` — the watermark).
//   • `db/` says which migrations exist NOW.
//
// If those two disagree, the map is describing a database that no longer
// exists. No connection, no credentials, no waiting — a directory listing and a
// JSON file. So it runs in the pure test job, on every pull request, and in
// every agent's local `npm test`, and it is in ALWAYS_RUN_STEPS so a reduced
// plan cannot skip it either. Nobody can add a migration and not be told.
//
// WHAT IT CANNOT SEE, stated plainly so nothing rests on it alone: a hand-edited
// database, a map generated against a different database, or a migration that
// was EDITED rather than added. Only the live comparison catches those. This is
// the cheap net under the thorough one, not a replacement for it.
//
// ADVISORY, ALWAYS. It reports and exits 0 — never non-zero, on any path
// including its own failure. The owner's standing rule for this work is that
// nothing may start failing that passes today, and the enforcement decision
// (2026-08-16) was to warn rather than block. Making the map's freshness a
// build failure is a separate, deliberate flip.

const fs = require('fs');
const path = require('path');
const { migrationState } = require('./schema-inventory');

const SNAPSHOT = path.join(__dirname, '..', 'docs', 'schema', 'beyond-prisma.json');

/**
 * Compare what the map says it was built from with what is on disk.
 *
 * PURE — every input is passed in, so the whole truth table is testable without
 * a filesystem. Returns `{ state, message, landed }` where `state` is one of:
 *
 *   no_snapshot   nothing committed yet — there is no map to be stale
 *   unknown_db    db/ could not be read; UNKNOWN, never a confident answer
 *   no_watermark  the map predates the stamp, so the question cannot be asked
 *   current       they agree
 *   behind        migrations landed after the map was made — the ordinary case
 *   ahead         the map claims migrations db/ does not have; see below
 */
function compareWatermark(was, now) {
  if (was === undefined) return { state: 'no_snapshot' };
  if (!now) {
    return {
      state: 'unknown_db',
      message: 'the db/ directory could not be read, so whether the schema map is '
        + 'up to date cannot be determined — reporting that rather than guessing',
    };
  }
  if (!was || !Number.isFinite(was.count)) {
    return {
      state: 'no_watermark',
      message: 'the committed schema map carries no record of which migrations it '
        + 'was built from, so its freshness cannot be checked without a database. '
        + 'Regenerating it fixes that for next time.',
    };
  }

  const sameCount = was.count === now.count;
  const sameHighest = (was.highest ?? null) === (now.highest ?? null);
  if (sameCount && sameHighest) {
    return {
      state: 'current',
      message: `the schema map was built from all ${now.count} migration file(s) `
        + `currently in db/ (highest db/${now.highest})`,
    };
  }

  // WHICH ONES. A count is a fact; a list of filenames is something a person can
  // act on. Anything numbered above the watermark landed after the map was made;
  // when the highest is unknown on either side nothing can be named, and naming
  // nothing is better than naming the wrong files.
  const landed = (Number.isFinite(was.highest) && Array.isArray(now.files))
    ? now.files.filter((f) => (parseInt(f, 10) || 0) > was.highest)
    : [];

  // THE MAP CLAIMING MORE THAN db/ HOLDS IS A DIFFERENT PROBLEM ENTIRELY, and
  // reporting it as "behind" would send somebody to regenerate — which would
  // quietly overwrite the map with one built from FEWER migrations. It means the
  // map came from a different checkout, or a migration file was deleted.
  if (now.count < was.count || (Number.isFinite(was.highest) && Number.isFinite(now.highest)
      && now.highest < was.highest)) {
    return {
      state: 'ahead',
      landed: [],
      message: `the committed schema map says it was built from ${was.count} migration `
        + `file(s) (highest db/${was.highest}), but db/ holds ${now.count} `
        + `(highest db/${now.highest}) — FEWER than the map was built from. That is not a `
        + `stale map; it is a map made against a different checkout, or a migration file `
        + `that has been removed. Do NOT regenerate until you know which, or the map will `
        + `quietly be rebuilt from the smaller set.`,
    };
  }

  const named = landed.length
    ? ` The migration(s) that landed since: ${landed.map((f) => `db/${f}`).join(', ')}.`
    : '';
  return {
    state: 'behind',
    landed,
    message: `the committed schema map is BEHIND the migrations. It was built from `
      + `${was.count} migration file(s) (highest db/${was.highest}) and db/ now holds `
      + `${now.count} (highest db/${now.highest}), so it describes a database that no `
      + `longer exists.${named}`,
  };
}

function main() {
  let committed;
  try {
    committed = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  } catch (_) {
    console.log('check-schema-behind: no schema map committed yet — skipped');
    return;
  }

  const was = (committed.generatedFrom || {}).migrations;
  const verdict = compareWatermark(was === undefined ? null : was, migrationState());

  if (verdict.state === 'current') {
    console.log(`check-schema-behind: ${verdict.message}`);
    return;
  }

  console.log(`::warning::check-schema-behind: ${verdict.message}`);
  if (verdict.state === 'behind' || verdict.state === 'no_watermark') {
    console.log('');
    console.log('   Fix, from yscap-repo-root_8/ with DATABASE_URL pointing at a database');
    console.log('   built from these migrations (CI\'s test-db job builds one on every run,');
    console.log('   and publishes the refreshed files as a downloadable artifact):');
    console.log('     npm run schema:snapshot     # then commit docs/schema/');
    console.log('');
  }
  console.log('check-schema-behind: advisory only — not failing the build');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // A check that cannot run is not a failing check. It says so and stands
    // aside — the map is documentation, and a bad read must never be the reason
    // a correct change cannot merge.
    console.log(`check-schema-behind: could not run (${e.message}) — skipped`);
  }
}

module.exports = { compareWatermark, SNAPSHOT };

'use strict';

// =============================================================================
// SCHEMA DRIFT CHECK — does the committed snapshot still describe the database?
// =============================================================================
//
// A map nobody updates is worse than no map: it is a document people trust that
// has quietly stopped being true. This is the guard against that.
//
// It rebuilds the inventory from the database in memory and compares it to
// `docs/schema/beyond-prisma.json`. Any difference is reported precisely — which
// trigger appeared, which column changed — never as a bare "they differ".
//
// IT USES `pg`, WHICH IS ALREADY A DEPENDENCY, AND NOT PRISMA. A safety check
// that needs a large tool downloaded before it can answer is a safety check
// people turn off. This one runs in a second with what the app already has.
//
// ADVISORY BY DEFAULT, ON PURPOSE. It reports and exits 0 unless
// SCHEMA_SNAPSHOT_ENFORCE=1. The owner's standing rule for this work is that
// nothing may start failing that passes today — so this lands announcing itself,
// and enforcement is a separate, deliberate flip once the regenerate step is a
// habit. That is the staged-rollout principle, not indecision: the flip is one
// environment variable and needs no code change.
//
// SELF-SKIPS WITHOUT A DATABASE, exactly like every other *-db check here, so it
// is harmless in the pure test job.

const fs = require('fs');
const path = require('path');
const { buildInventory, migrationState } = require('./schema-inventory');

const SNAPSHOT = path.join(__dirname, '..', 'docs', 'schema', 'beyond-prisma.json');
const ENFORCE = process.env.SCHEMA_SNAPSHOT_ENFORCE === '1';

// WHICH snapshot to compare against. Almost always the committed one; the
// override exists so the drift check can be PROVEN TO FAIL without touching a
// database — `test-schema-drift-db.js` points it at a deliberately tampered
// copy and asserts this script exits 1. A guard nobody has watched go red is
// decoration, and proving this one by editing the real database instead would
// mean a test that can leave a scratch schema altered when it dies mid-run.
const snapshotPath = () => process.env.SCHEMA_SNAPSHOT_FILE || SNAPSHOT;

/** Compare two inventories and describe every difference in words. */
function diffInventories(committed, live) {
  const problems = [];

  const sections = ['triggers', 'functions', 'checkConstraints', 'generatedColumns', 'partialIndexes'];
  for (const section of sections) {
    const was = new Map((committed.beyondPrisma[section] || []).map((x) => [x.name, x]));
    const now = new Map((live.beyondPrisma[section] || []).map((x) => [x.name, x]));

    for (const name of now.keys()) {
      if (!was.has(name)) problems.push(`${section}: "${name}" exists in the database but not in the snapshot`);
    }
    for (const name of was.keys()) {
      if (!now.has(name)) problems.push(`${section}: "${name}" is in the snapshot but GONE from the database`);
    }
    for (const [name, a] of was) {
      const b = now.get(name);
      if (b && JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${section}: "${name}" changed`);
    }
  }

  const wasT = new Map((committed.tables || []).map((t) => [t.name, t.columns.join('|')]));
  const nowT = new Map((live.tables || []).map((t) => [t.name, t.columns.join('|')]));
  for (const name of nowT.keys()) if (!wasT.has(name)) problems.push(`table "${name}" is new`);
  for (const name of wasT.keys()) if (!nowT.has(name)) problems.push(`table "${name}" is GONE from the database`);
  for (const [name, cols] of wasT) {
    if (nowT.has(name) && nowT.get(name) !== cols) problems.push(`table "${name}": its columns changed`);
  }

  return problems;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('check-schema-snapshot: no DATABASE_URL — skipped');
    return;
  }
  const snapFile = snapshotPath();
  if (!fs.existsSync(snapFile)) {
    console.log('check-schema-snapshot: no snapshot committed yet — skipped');
    return;
  }

  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let live;
  try { live = await buildInventory(client); } finally { await client.end(); }

  const committed = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const problems = diffInventories(committed, live);

  if (!problems.length) {
    console.log(`check-schema-snapshot: the snapshot matches the database `
      + `(${live.counts.tables} tables, ${live.counts.triggers} triggers, ${live.counts.functions} functions)`);
    return;
  }

  // WHICH KIND OF DRIFT IS THIS? The two look identical in the list below and
  // could not matter more differently, so say it first, in words.
  //
  //   • migrations moved  → somebody added a migration and did not regenerate
  //     the map. Ordinary. One command fixes it.
  //   • migrations IDENTICAL → this database contains something no migration in
  //     this checkout explains: a hand-edited schema, or a map generated against
  //     a different database entirely. That one is worth stopping for.
  //
  // An unknown watermark (a snapshot written before this stamp existed, or an
  // unreadable db/ directory) says exactly that rather than guessing either way.
  const wasMig = (committed.generatedFrom || {}).migrations || null;
  const nowMig = migrationState();
  let verdict;
  if (!wasMig || !nowMig) {
    verdict = 'This snapshot carries no record of which migrations it was built from, '
      + 'so the cause cannot be narrowed down — regenerate it to fix that for next time.';
  } else if (wasMig.count !== nowMig.count || wasMig.highest !== nowMig.highest) {
    verdict = `EXPECTED KIND: migrations have landed since this map was made — it was `
      + `built from ${wasMig.count} migration file(s) (highest db/${wasMig.highest}) and this `
      + `checkout has ${nowMig.count} (highest db/${nowMig.highest}). Regenerate and commit.`;
  } else {
    verdict = `WORTH A LOOK: the migration files are UNCHANGED (${nowMig.count}, highest `
      + `db/${nowMig.highest}) and the schema still differs — so this database contains `
      + `something no migration here explains. Check it was built from these migrations `
      + `and that nobody altered it by hand before regenerating.`;
  }

  const head = ENFORCE ? '::error::' : '::warning::';
  console.log(`${head}The committed schema snapshot no longer matches the database `
    + `— ${problems.length} difference(s):`);
  console.log(`   ${verdict}`);
  console.log('');
  // Every difference is named. A truncated list is how somebody concludes the
  // only change is the one they happen to see first.
  problems.forEach((p) => console.log(`   • ${p}`));
  console.log('');
  console.log('   Fix, from yscap-repo-root_8/ with DATABASE_URL pointing at that database:');
  console.log('     npm run schema:snapshot     # then commit docs/schema/');
  console.log('');

  if (ENFORCE) {
    console.error('check-schema-snapshot: FAILED (SCHEMA_SNAPSHOT_ENFORCE=1)');
    process.exit(1);
  }
  console.log('check-schema-snapshot: advisory only — not failing the build '
    + '(set SCHEMA_SNAPSHOT_ENFORCE=1 to make this blocking)');
}

if (require.main === module) {
  main().catch((e) => {
    // A check that cannot run is not a failing check. It says so and stands
    // aside — the snapshot is documentation, and a database hiccup must never
    // be the reason a correct change cannot merge.
    console.log(`check-schema-snapshot: could not run (${e.message}) — skipped`);
  });
}

module.exports = { diffInventories, SNAPSHOT, snapshotPath };

'use strict';

// =============================================================================
// The schema snapshot and its drift check are themselves tested.
//
// This is documentation people will trust and a guard that is meant to catch a
// silent change, so both have to be shown working rather than assumed: the
// inventory must READ what is really there, and the check must go off when
// something moves. Every assertion below was mutation-proven.
//
// Needs a real Postgres — self-skips without DATABASE_URL, like every other
// *-db suite here. It creates its own throwaway objects inside a transaction
// that is ALWAYS rolled back, so it can run against any database without
// leaving a trace.
// =============================================================================

const assert = require('assert');
const { buildInventory, beyondPrismaCount, serialize } = require('./schema-inventory');
const { diffInventories } = require('./check-schema-snapshot');
const { assertDisposable } = require('./db-test-guard');

if (!process.env.DATABASE_URL) {
  console.log('test-schema-snapshot-db: no DATABASE_URL — skipped');
  process.exit(0);
}
// This suite CREATES AND ALTERS REAL OBJECTS (rolled back, always). It must
// never do that to a database somebody is using — see db-test-guard.js.
if (!assertDisposable('test-schema-snapshot-db')) process.exit(0);

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

(async () => {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    await db.query('BEGIN');

    const before = await buildInventory(db);

    // ---- A. It read something real ----------------------------------------
    ok(before.counts.tables > 100, `the inventory found the real tables (${before.counts.tables})`);
    ok(before.counts.columns > 1000, `and their columns (${before.counts.columns})`);
    ok(before.counts.triggers > 0, `and the triggers (${before.counts.triggers})`);
    ok(before.counts.functions > 0, `and the functions (${before.counts.functions})`);
    ok(beyondPrismaCount(before) > 0, 'and the objects Prisma cannot express');
    ok(before.tables.some((t) => t.name === 'borrowers'), 'the borrowers table is in the inventory');

    // ---- B. Deterministic — the file is committed and diffed ---------------
    const again = await buildInventory(db);
    eq(serialize(before), serialize(again), 'two reads of one database produce identical output');

    const names = before.tables.map((t) => t.name);
    eq(names.join(), [...names].sort().join(), 'tables come out in a stable order');

    // ---- C. Partial indexes are counted from the catalog, not from text ----
    // A definition-text match also catches an index merely NAMED "…where…".
    // This is the defect that first reported 736 objects as 737.
    const { rows: truth } = await db.query(
      `SELECT count(*)::int AS n FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND i.indpred IS NOT NULL`);
    eq(before.counts.partialIndexes, truth[0].n,
      'the partial-index count equals the catalog, not a string match');

    const { rows: loose } = await db.query(
      `SELECT count(*)::int AS n FROM pg_indexes
        WHERE schemaname = 'public' AND indexdef ILIKE '%WHERE%'`);
    ok(loose[0].n >= before.counts.partialIndexes,
      `the loose text match over-counts or ties, never under-counts `
      + `(text ${loose[0].n} vs catalog ${before.counts.partialIndexes})`);

    // ---- D. The drift check actually goes off ------------------------------
    eq(diffInventories(before, before).length, 0, 'no drift is reported when nothing moved');

    await db.query('CREATE TABLE _snap_probe (id int, note text)');
    const withTable = await buildInventory(db);
    const d1 = diffInventories(before, withTable);
    ok(d1.some((p) => p.includes('_snap_probe') && p.includes('new')),
      'a NEW TABLE is reported, by name');

    await db.query('ALTER TABLE _snap_probe ADD COLUMN extra int');
    const d2 = diffInventories(withTable, await buildInventory(db));
    ok(d2.some((p) => p.includes('_snap_probe') && p.includes('columns changed')),
      'a NEW COLUMN on an existing table is reported');

    await db.query(`CREATE FUNCTION _snap_probe_fn() RETURNS trigger AS
                    $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql`);
    const withFn = await buildInventory(db);
    ok(diffInventories(before, withFn).some((p) => p.includes('_snap_probe_fn')),
      'a NEW FUNCTION is reported — one of the things Prisma cannot see');

    await db.query(`CREATE TRIGGER _snap_probe_trg BEFORE INSERT ON _snap_probe
                    FOR EACH ROW EXECUTE FUNCTION _snap_probe_fn()`);
    const withTrg = await buildInventory(db);
    ok(diffInventories(withFn, withTrg).some((p) => p.includes('_snap_probe_trg')),
      'a NEW TRIGGER is reported — the most important thing it must never miss');

    await db.query(`ALTER TABLE _snap_probe ADD CONSTRAINT _snap_probe_chk CHECK (id > 0)`);
    ok(diffInventories(withTrg, await buildInventory(db)).some((p) => p.includes('_snap_probe_chk')),
      'a NEW CHECK CONSTRAINT is reported');

    await db.query(`CREATE INDEX _snap_probe_partial ON _snap_probe (id) WHERE id > 5`);
    ok(diffInventories(withTrg, await buildInventory(db)).some((p) => p.includes('_snap_probe_partial')),
      'a NEW PARTIAL INDEX is reported');

    // A REMOVAL is the dangerous direction — a rule quietly disappearing.
    const removal = diffInventories(withTrg, before);
    ok(removal.some((p) => p.includes('_snap_probe_trg') && p.includes('GONE')),
      'a trigger DISAPPEARING is reported as gone, not merely as "changed"');

    // ---- E. A changed function BODY is caught even though the name is same --
    await db.query(`CREATE OR REPLACE FUNCTION _snap_probe_fn() RETURNS trigger AS
                    $$ BEGIN RAISE NOTICE 'changed'; RETURN NEW; END $$ LANGUAGE plpgsql`);
    ok(diffInventories(withTrg, await buildInventory(db)).some(
      (p) => p.includes('_snap_probe_fn') && p.includes('changed')),
      'rewriting a function body is caught, though its name never moved');

    // ---- F. PILOT'S OWN MIGRATION LEDGER IS NEVER IN THE MAP ----------------
    //
    // `schema_migrations` is created by the SERVER'S BOOT PATH (migrate-boot.js)
    // and not by `npm run migrate`, so whether it exists says nothing about the
    // schema — only about how this particular database came to be. Left in, the
    // map reports it as a NEW TABLE the moment anything boots, and the drift
    // check reaches for its most alarming verdict ("this database contains
    // something no migration here explains") about a table PILOT created itself.
    // That fires on production, on every restored backup, and on any CI run
    // where a test boots before the check. Observed on 2026-08-16.
    //
    // The table is created HERE rather than assumed present, so this proves the
    // exclusion whether or not anything has booted against this database.
    // Taken IMMEDIATELY before the ledger is created, so the comparison below
    // isolates the ledger and nothing else. Using the inventory from the top of
    // this suite would drag in every probe object created since, and the
    // assertion would fail for reasons that have nothing to do with the ledger.
    const preLedger = await buildInventory(db);
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      last_seen timestamptz NOT NULL DEFAULT now())`);
    const withLedger = await buildInventory(db);
    ok(!withLedger.tables.some((t) => t.name === 'schema_migrations'),
      'the migration ledger is not a table in the map');
    ok(!JSON.stringify(withLedger).includes('schema_migrations'),
      'and it leaks into no other section either — not its primary key, not its index');

    // The whole point: a database that HAS the ledger must read as identical to
    // one that does not. Comparing the map to itself would prove nothing, so
    // this compares against the inventory taken at the top of this suite.
    ok(diffInventories(preLedger, withLedger).length === 0,
      'a database carrying the ledger reports NO drift against the same database without it');

    // AND THE EXCLUSION MUST BE EXACT. Two near-misses, because they fail
    // differently and one fixture cannot catch both: a name that STARTS with the
    // ledger's would be swallowed by a `startsWith` test, and one that merely
    // CONTAINS it would be swallowed by an `includes` test. Either mistake makes
    // a real table silently vanish from the map — strictly worse than the bug
    // this exclusion fixes, because nothing would ever report it.
    await db.query(`CREATE TABLE schema_migrations_probe_backup (id int)`);
    await db.query(`CREATE TABLE _snap_probe_schema_migrations_like (id int)`);
    const nearMiss = diffInventories(withLedger, await buildInventory(db));
    ok(nearMiss.some((p) => p.includes('schema_migrations_probe_backup')),
      'a real table whose name BEGINS with the ledger name is still reported');
    ok(nearMiss.some((p) => p.includes('_snap_probe_schema_migrations_like')),
      'a real table whose name CONTAINS the ledger name is still reported');

    console.log(`test-schema-snapshot-db: ${n} assertions passed`);
  } finally {
    // Always. The probe objects never survive this suite.
    try { await db.query('ROLLBACK'); } catch (_) { /* the connection is going anyway */ }
    await db.end();
  }
})().catch((e) => { console.error('test-schema-snapshot-db FAILED:', e.message); process.exit(1); });

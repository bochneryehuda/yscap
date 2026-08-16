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

if (!process.env.DATABASE_URL) {
  console.log('test-schema-snapshot-db: no DATABASE_URL — skipped');
  process.exit(0);
}

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

    console.log(`test-schema-snapshot-db: ${n} assertions passed`);
  } finally {
    // Always. The probe objects never survive this suite.
    try { await db.query('ROLLBACK'); } catch (_) { /* the connection is going anyway */ }
    await db.end();
  }
})().catch((e) => { console.error('test-schema-snapshot-db FAILED:', e.message); process.exit(1); });

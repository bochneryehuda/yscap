'use strict';

// =============================================================================
// THE DRIFT CHECK IS PROVEN TO GO RED — the acceptance evidence for Phase 3
// =============================================================================
//
// `check-schema-snapshot.js` is the whole value of making the schema the source
// of truth: it is the thing that stops `docs/schema/` quietly becoming a
// document people trust and nobody maintains. A guard nobody has watched fail
// is decoration, so this is the test that watches it fail — deliberately, in
// every way a schema can move, with an unmutated control green on either side.
//
// THREE LAYERS, because each proves something the others cannot:
//
//   A. The DATABASE READ really sees a schema change. A synthetic fixture can
//      never prove `buildInventory` is looking at the right catalog, so one
//      mutation is applied to the REAL database — inside a transaction that is
//      rolled back, so the scratch schema is byte-identical afterwards whether
//      this test passes, fails, or dies half way through.
//
//   B. The DIFF names every class of change. Applied to copies of the live
//      inventory rather than to the database, because ten real `ALTER`s would
//      be ten more chances to leave residue to prove something arithmetic.
//
//   C. The EXIT CODE. `SCHEMA_SNAPSHOT_ENFORCE=1` must genuinely exit 1 — the
//      flip the owner will one day make has to do what it says. Proven against
//      a TAMPERED COPY of the snapshot (`SCHEMA_SNAPSHOT_FILE`), so this layer
//      touches no database at all.
//
// IT NEVER ASSERTS THAT THE COMMITTED SNAPSHOT IS CURRENT. That is the drift
// check's own job and it runs as its own step; if this test depended on it too,
// an ordinary out-of-date map would fail the guard that proves the guard works,
// which is the most confusing failure available. The baseline here is whatever
// the live database says right now.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildInventory } = require('./schema-inventory');
const { diffInventories } = require('./check-schema-snapshot');

let passed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(detail ? `${label} — ${detail}` : label);
}

/** Assert the diff contains a problem whose text mentions all of `bits`. */
function saysSomethingAbout(problems, bits, label) {
  const hit = problems.find((p) => bits.every((b) => p.includes(b)));
  ok(label, !!hit, `no problem mentioned ${bits.map((b) => JSON.stringify(b)).join(' + ')}; `
    + `got: ${problems.slice(0, 4).join(' | ') || '(none)'}`);
  return hit;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('test-schema-drift-db: no DATABASE_URL — skipped');
    return;
  }

  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let live;
  try {
    // ---- control -----------------------------------------------------------
    // An inventory compared with itself must be silent. If this ever fails,
    // every "it caught the mutation" result below is meaningless, because the
    // check would be reporting differences that are not there.
    live = await buildInventory(client);
    ok('CONTROL: an inventory compared with itself reports nothing',
      diffInventories(live, live).length === 0,
      `got ${diffInventories(live, live).length} phantom problem(s)`);

    ok('CONTROL: the live database is non-trivial (the fixture is real)',
      live.tables.length > 100 && live.beyondPrisma.triggers.length > 0,
      `${live.tables.length} tables, ${live.beyondPrisma.triggers.length} triggers`);

    // ---- A. the database read sees a real ALTER ----------------------------
    // Inside a transaction, so the scratch schema is restored no matter how
    // this ends. `buildInventory` runs on the SAME client, so it reads the
    // uncommitted change — which is exactly the point: it proves the reader is
    // looking at this connection's live catalog and not at anything cached.
    const probeTable = live.tables.find((t) => t.name === 'borrowers') ? 'borrowers' : live.tables[0].name;
    await client.query('BEGIN');
    let mutatedLive;
    try {
      await client.query(`ALTER TABLE ${probeTable} ADD COLUMN pilot_drift_probe text`);
      mutatedLive = await buildInventory(client);
    } finally {
      await client.query('ROLLBACK');
    }

    const realProblems = diffInventories(live, mutatedLive);
    saysSomethingAbout(realProblems, [probeTable, 'columns changed'],
      'A: a column added in the DATABASE is caught by the real catalog read');

    // And the rollback truly restored it — otherwise this test would be the
    // thing that corrupts the scratch schema for every step after it.
    const after = await buildInventory(client);
    ok('A: the probe column is gone again — the test left no residue',
      diffInventories(live, after).length === 0,
      `${diffInventories(live, after).length} difference(s) survived the rollback`);

    // ---- B. every class of change is named ---------------------------------
    const cases = [
      {
        label: 'B: a NEW TABLE',
        mutate: (inv) => inv.tables.push({ name: 'zzz_probe_table', columns: ['id'] }),
        bits: ['zzz_probe_table', 'is new'],
      },
      {
        label: 'B: a table that DISAPPEARED',
        mutate: (inv) => { inv.tables = inv.tables.filter((t) => t.name !== probeTable); },
        bits: [probeTable, 'GONE'],
      },
      {
        label: 'B: a column REMOVED from a table',
        mutate: (inv) => {
          const t = inv.tables.find((x) => x.name === probeTable);
          t.columns = t.columns.slice(0, -1);
        },
        bits: [probeTable, 'columns changed'],
      },
      {
        label: 'B: a TRIGGER that vanished',
        section: 'triggers',
        mutate: (inv) => { inv.beyondPrisma.triggers = inv.beyondPrisma.triggers.slice(1); },
        bitsFrom: (inv) => ['triggers', inv.beyondPrisma.triggers[0].name, 'GONE'],
      },
      {
        label: 'B: a FUNCTION whose body changed',
        section: 'functions',
        mutate: (inv) => { inv.beyondPrisma.functions[0].definition = '-- tampered'; },
        bitsFrom: (inv) => ['functions', inv.beyondPrisma.functions[0].name, 'changed'],
      },
      {
        label: 'B: a CHECK CONSTRAINT that vanished',
        section: 'checkConstraints',
        mutate: (inv) => { inv.beyondPrisma.checkConstraints = inv.beyondPrisma.checkConstraints.slice(1); },
        bitsFrom: (inv) => ['checkConstraints', inv.beyondPrisma.checkConstraints[0].name, 'GONE'],
      },
      {
        label: 'B: a PARTIAL INDEX that appeared',
        section: 'partialIndexes',
        mutate: (inv) => inv.beyondPrisma.partialIndexes.push({ name: 'zzz_probe_ix', table: 'x', definition: 'y' }),
        bits: ['partialIndexes', 'zzz_probe_ix', 'but not in the snapshot'],
      },
      {
        label: 'B: a GENERATED COLUMN that vanished',
        section: 'generatedColumns',
        mutate: (inv) => { inv.beyondPrisma.generatedColumns = inv.beyondPrisma.generatedColumns.slice(1); },
        bitsFrom: (inv) => ['generatedColumns', inv.beyondPrisma.generatedColumns[0].name, 'GONE'],
      },
    ];

    for (const c of cases) {
      // A section this database happens not to use cannot be proven here, and
      // silently "passing" it would be a lie — say so instead.
      if (c.section && !(live.beyondPrisma[c.section] || []).length) {
        failures.push(`${c.label} — cannot be proven: the database has no ${c.section} at all`);
        continue;
      }
      const bits = c.bitsFrom ? c.bitsFrom(live) : c.bits;
      const mutated = clone(live);
      c.mutate(mutated);
      saysSomethingAbout(diffInventories(live, mutated), bits, c.label);
      // Each mutation must be caught in ONE direction of comparison and the
      // baseline must still be clean — a diff that reports everything always
      // would pass every assertion above while being useless.
      ok(`${c.label} — the untouched baseline stays silent`,
        diffInventories(live, live).length === 0);
    }
  } finally {
    await client.end();
  }

  // ---- C. the enforce flip really fails the build --------------------------
  // No database mutation: a tampered COPY of the snapshot, fed to the real
  // script through SCHEMA_SNAPSHOT_FILE.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-drift-'));
  const tampered = path.join(tmp, 'beyond-prisma.json');
  const forged = clone(live);
  forged.tables.push({ name: 'zzz_not_really_here', columns: ['id'] });
  fs.writeFileSync(tampered, JSON.stringify(forged, null, 2));

  const truthful = path.join(tmp, 'truthful.json');
  fs.writeFileSync(truthful, JSON.stringify(live, null, 2));

  const run = (snapFile, enforce) => spawnSync(process.execPath, [path.join(__dirname, 'check-schema-snapshot.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SCHEMA_SNAPSHOT_FILE: snapFile, SCHEMA_SNAPSHOT_ENFORCE: enforce ? '1' : '' },
    encoding: 'utf8',
    timeout: 120000,
  });

  const enforcedDrift = run(tampered, true);
  ok('C: with SCHEMA_SNAPSHOT_ENFORCE=1, drift FAILS the build (exit 1)',
    enforcedDrift.status === 1, `exit ${enforcedDrift.status}`);
  ok('C: the failure names the offending object, not just "they differ"',
    /zzz_not_really_here/.test(String(enforcedDrift.stdout)));

  const advisoryDrift = run(tampered, false);
  ok('C: advisory (the default today) REPORTS the same drift but exits 0',
    advisoryDrift.status === 0 && /zzz_not_really_here/.test(String(advisoryDrift.stdout)),
    `exit ${advisoryDrift.status}`);

  const enforcedClean = run(truthful, true);
  ok('C: CONTROL — an accurate snapshot passes even under enforcement',
    enforcedClean.status === 0 && /matches the database/.test(String(enforcedClean.stdout)),
    `exit ${enforcedClean.status}: ${String(enforcedClean.stdout).slice(0, 160)}`);

  // ---- D. the report says WHICH KIND of drift this is -----------------------
  // The list of differences looks the same either way, and the two causes could
  // not matter more differently: "regenerate the map" versus "somebody changed
  // this database by hand". Each verdict is proven, including the honest
  // I-cannot-tell case.
  const { migrationState } = require('./schema-inventory');
  const nowMig = migrationState();
  ok('D: the live checkout has a readable migration watermark', !!nowMig && nowMig.count > 0);

  const withStamp = (stamp) => {
    const f = path.join(tmp, `stamped-${Math.abs(JSON.stringify(stamp).length)}-${Date.now()}.json`);
    const o = clone(live);
    o.tables.push({ name: 'zzz_not_really_here', columns: ['id'] });
    if (stamp) o.generatedFrom = { migrations: stamp };
    fs.writeFileSync(f, JSON.stringify(o, null, 2));
    return f;
  };

  const sameMig = String(run(withStamp(nowMig), false).stdout);
  ok('D: migrations UNCHANGED + schema differs → flagged as the alarming kind',
    /WORTH A LOOK/.test(sameMig) && /no migration here explains/.test(sameMig),
    sameMig.split('\n').slice(0, 3).join(' / '));

  const olderMig = String(run(withStamp({ count: nowMig.count - 2, highest: nowMig.highest - 2 }), false).stdout);
  ok('D: migrations MOVED → flagged as the ordinary "regenerate" kind',
    /EXPECTED KIND/.test(olderMig) && /Regenerate and commit/.test(olderMig),
    olderMig.split('\n').slice(0, 3).join(' / '));

  const noMig = String(run(withStamp(null), false).stdout);
  ok('D: an unstamped snapshot says it CANNOT tell, rather than guessing',
    /carries no record/.test(noMig),
    noMig.split('\n').slice(0, 3).join(' / '));

  ok('D: every verdict still lists the offending object underneath',
    [sameMig, olderMig, noMig].every((s) => /zzz_not_really_here/.test(s)));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  if (failures.length) {
    console.error(`test-schema-drift-db: ${failures.length} FAILED`);
    failures.forEach((f) => console.error(`   ✗ ${f}`));
    process.exit(1);
  }
  console.log(`test-schema-drift-db: ${passed} assertions passed — `
    + `the drift check was proven to go red on every kind of schema change`);
}

if (require.main === module) {
  main().catch((e) => { console.error('test-schema-drift-db:', e.message); process.exit(1); });
}

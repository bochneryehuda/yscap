'use strict';

// =============================================================================
// PROOF that the schema map's header still describes the database it sits next to
// =============================================================================
//
// The header of `docs/schema/schema.prisma` quotes four numbers — how many
// objects Prisma cannot express, how many tables, how many columns, and how many
// migrations build this database. Every one of them lives in
// `beyond-prisma.json`, in the SAME folder, describing the SAME database.
//
// THEY CAN DRIFT, AND THEY DID. The inventory is regenerable on its own
// (`npm run schema:snapshot` — plain SQL, no Prisma), while the schema map needs
// Prisma AND a database. So the cheap file moves and the expensive one does not,
// and nothing noticed: the header carried a hand-typed "549" while `db/` was
// already on 550 — in the sentence whose entire job is to say NEVER REBUILD THIS
// DATABASE FROM THIS FILE, the migrations are the only thing that may.
//
// That is the worst possible number to be wrong. A reader who checks it, finds
// it stale, and concludes the warning is stale too is exactly the reader this
// document exists to stop.
//
// The guard is not a regex over the header. It REBUILDS the header from the
// committed inventory and asserts the committed file starts with those exact
// bytes — so it catches every number at once, plus any hand-edit of the warning
// text, and it cannot be fooled by a pattern that still matches while the figure
// underneath it is wrong.
//
// PURE: no database, no network, no Prisma.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  header, restamp, bodyOf, seedFrom, SEED, countsFromInventory, migrationClause, SCHEMA,
} = require('./schema-prisma');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

// ---------------------------------------------------------------------------
// A. The migration count is DERIVED, and an unknown one is never invented
// ---------------------------------------------------------------------------
{
  eq(migrationClause({ count: 550, highest: 553 }),
    'The 550 numbered migrations in db/ (highest db/553)',
    'the count and the highest file both come from the watermark');
  eq(migrationClause({ count: 550, highest: null }),
    'The 550 numbered migrations in db/',
    'no highest recorded → the count still stands on its own');

  // A SENTENCE WITHOUT A NUMBER IS STILL TRUE. Guessing one would not be.
  for (const bad of [null, undefined, {}, { count: null }, { count: 'lots' }, { count: NaN }]) {
    const s = migrationClause(bad);
    eq(s, 'The numbered migrations in db/', `unknown watermark (${JSON.stringify(bad)}) states no figure`);
    ok(!/\d/.test(s), 'and it contains no digit at all — nothing to mistake for a count');
  }
}
{
  // The header must MOVE when the count moves, or deriving it bought nothing.
  const base = { beyond: 749, tables: 321, columns: 5257, migrations: { count: 550, highest: 553 } };
  const moved = { ...base, migrations: { count: 551, highest: 554 } };
  ok(header(base).includes('The 550 numbered migrations in db/ (highest db/553)'),
    'the header states the derived count');
  ok(header(moved).includes('The 551 numbered migrations in db/ (highest db/554)'),
    'and a new migration changes it');
  ok(!header(moved).includes('550 numbered'), 'the old figure is gone, not merely joined');
  ok(!/\b549\b/.test(header(base)), 'THE HAND-TYPED 549 IS GONE — this is the defect that was found');
}

// ---------------------------------------------------------------------------
// B. `bodyOf` — one definition of where the generated header stops
// ---------------------------------------------------------------------------
{
  const file = '// generated header\n// second line\ndatasource db {\n}\n\nmodel a {\n  id String @id\n}\n';
  eq(bodyOf(file), 'datasource db {\n}\n\nmodel a {\n  id String @id\n}\n',
    'everything from the datasource block onward is the file; the rest is our header');

  // NULL, not a fallback — the two callers need opposite things from a file
  // that cannot be read (see the note on bodyOf).
  eq(bodyOf(''), null, 'empty text is not a schema');
  eq(bodyOf('   \n '), null, 'nor is whitespace');
  eq(bodyOf('// only a comment\n'), null, 'nor is a file with no datasource block');
  eq(bodyOf(null), null, 'nor is nothing at all');
  eq(bodyOf(42), null, 'nor is a non-string');

  // And the seed still behaves exactly as it did — this refactor must not have
  // changed what Prisma is handed.
  eq(seedFrom(file), bodyOf(file), 'the seed is the body when there is one');
  eq(seedFrom('// only a comment\n'), SEED, 'and a clean seed when there is not');
  eq(seedFrom(''), SEED, 'empty → clean seed');
  eq(seedFrom(null), SEED, 'nothing → clean seed');
}

// ---------------------------------------------------------------------------
// C. `restamp` — the header moves, the schema does not
// ---------------------------------------------------------------------------
const COUNTS = { beyond: 749, tables: 321, columns: 5257, migrations: { count: 550, highest: 553 } };
{
  const body = 'datasource db {\n  provider = "postgresql"\n}\n\n'
    + '/// One loan file — a human wrote this and it must survive.\n'
    + 'model applications {\n  id String @id\n}\n\n'
    + 'model borrowers {\n  id String @id @relation_placeholder\n}\n';
  const file = '// STALE HEADER\n// *** The 549 numbered migrations in db/ are the only\n' + body;

  const out = restamp(file, COUNTS);
  eq(bodyOf(out), body, 'THE SCHEMA IS PRESERVED BYTE FOR BYTE — this is the whole promise');
  ok(out.includes('/// One loan file — a human wrote this and it must survive.'),
    'including a hand-written doc comment, which is what Phase 1 depends on');
  ok(!out.includes('549'), 'the stale figure is gone');
  ok(out.includes('The 550 numbered migrations in db/ (highest db/553)'), 'and the live one is in');
  ok(!out.includes('// STALE HEADER'), 'the old header is REPLACED, never stacked on top of');

  eq(restamp(out, COUNTS), out, 'restamping twice changes nothing — idempotent by construction');
  eq(restamp(restamp(out, COUNTS), COUNTS), out, 'nor does a third pass');
  eq((out.match(/^\/\/ ={10,}$/gm) || []).length, 3,
    'exactly one header box, not two — a stacked header is how this would fail quietly');
}
{
  // IT REFUSES RATHER THAN GUESSES. Writing a bare seed over somebody's schema
  // is the most destructive thing this script could do, so a file it cannot read
  // is never rewritten.
  eq(restamp('// no datasource here\nmodel a {}\n', COUNTS), null, 'an unreadable file is refused');
  eq(restamp('', COUNTS), null, 'and so is an empty one');
  eq(restamp(null, COUNTS), null, 'and nothing at all');
}

// ---------------------------------------------------------------------------
// D. `countsFromInventory` — the numbers have ONE derivation
// ---------------------------------------------------------------------------
{
  const inv = {
    counts: {
      tables: 321, columns: 5257, generatedColumns: 12, checkConstraints: 323,
      triggers: 57, functions: 95, partialIndexes: 68,
    },
    generatedFrom: { migrations: { count: 550, highest: 553 } },
  };
  const c = countsFromInventory(inv);
  eq(c.beyond, 12 + 323 + 57 + 95 + 68, 'the "Prisma cannot see these" figure is the sum of the five kinds');
  eq(c.tables, 321, 'tables carried through');
  eq(c.columns, 5257, 'columns carried through');
  eq(c.migrations.count, 550, 'and the watermark');

  // A malformed inventory must not produce NaN in a document.
  const empty = countsFromInventory({});
  eq(empty.beyond, 0, 'a missing count contributes 0, never NaN');
  eq(empty.migrations, null, 'and an absent watermark is null, which states no figure');
  ok(!/NaN/.test(header(empty)), 'so the header can never print NaN');
}

// ---------------------------------------------------------------------------
// E. THE LIVE GUARD — the committed header agrees with the committed inventory
// ---------------------------------------------------------------------------
//
// This is the assertion that actually protects anything. Everything above tests
// the machinery; this tests the two files sitting in docs/schema/ right now.
{
  const invPath = path.join(__dirname, '..', 'docs', 'schema', 'beyond-prisma.json');
  if (fs.existsSync(SCHEMA) && fs.existsSync(invPath)) {
    const file = fs.readFileSync(SCHEMA, 'utf8');
    const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));
    const want = header(countsFromInventory(inv));

    ok(file.startsWith(want),
      'THE COMMITTED HEADER DOES NOT MATCH THE COMMITTED INVENTORY.\n'
      + '      The two files in docs/schema/ describe the same database and now disagree.\n'
      + '      Fix with:  node scripts/schema-prisma.js --restamp\n'
      + '      (no database needed — it rewrites the header only and touches no model)');

    // AND THE WARNINGS ARE STILL THERE. Phase 2 of the plan calls a picture that
    // looks whole and is not "the single biggest hazard this plan introduces",
    // so the header is required to say it is incomplete. A restamp regenerates
    // the header wholesale, so a deletion here would be silent otherwise.
    ok(/IT IS INCOMPLETE/.test(file), 'the header still says the picture is incomplete');
    ok(/NEVER REBUILD A DATABASE FROM THIS FILE/.test(file), 'and still says never to rebuild from it');
    ok(/BEYOND-PRISMA\.md/.test(file), 'and still points at where the missing objects are listed');

    // The body is intact — a truncated file would still "start with" the header.
    const models = (file.match(/^model /gm) || []).length;
    ok(models > 300, `the map still holds every table (${models} models), not just a header`);
  } else {
    console.log('test-schema-prisma-header-pure: docs/schema is absent — the live section was skipped');
  }
}

console.log(`test-schema-prisma-header-pure: ${checks} assertions passed — the header's numbers `
  + `are derived from the inventory beside it, and restamping moves the header without `
  + `touching a single model`);

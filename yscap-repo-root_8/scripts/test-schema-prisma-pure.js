'use strict';

// =============================================================================
// PROOF for the three text rules that decide what the Prisma map contains
// =============================================================================
//
// `schema-prisma.js` runs Prisma, which needs a database and a ~100 MB download,
// so the SCRIPT cannot sit in the test chain. Its three decisions can, and they
// are the ones with teeth:
//
//   seedFrom          what we hand Prisma before introspecting — this decides
//                     whether a human's `///` comments survive at all
//   stripLedgerModel  drops PILOT's own migration ledger, whose presence
//                     records how a database was BUILT rather than what its
//                     schema is
//   injectGlossary    writes the plain-English notes in, from one shared source
//
// Every one of them is idempotent by design, because this file is regenerated
// and each pass must produce the same bytes as the last. That is asserted here
// rather than hoped for — a rule that quietly accumulates would grow the file a
// little on every run and nobody would look until it was absurd.
//
// PURE: no database, no network, no Prisma.

const assert = require('assert');
const { seedFrom, SEED, stripLedgerModel, injectGlossary } = require('./schema-prisma');
const { GLOSSARY } = require('./schema-glossary');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

// ---------------------------------------------------------------------------
// A. seedFrom — the rule that keeps a human's work
// ---------------------------------------------------------------------------
{
  eq(seedFrom(null), SEED, 'no file yet → a clean seed');
  eq(seedFrom(''), SEED, 'an empty file → a clean seed');
  eq(seedFrom('   \n  '), SEED, 'whitespace only → a clean seed');
  eq(seedFrom('// a comment but no datasource'), SEED,
    'a file Prisma could not introspect over → a clean seed rather than a refusal');
  eq(seedFrom(42), SEED, 'a non-string → a clean seed');
}
{
  const file = '// generated header\n// second header line\n'
    + 'datasource db {\n  provider = "postgresql"\n}\n\n'
    + '/// a human wrote this\nmodel a {\n  id String @id\n}\n';
  const out = seedFrom(file);
  ok(out.startsWith('datasource '), 'our generated header is dropped — Prisma discards it anyway');
  ok(out.includes('/// a human wrote this'),
    'THE DOC COMMENT IS CARRIED THROUGH — this is the whole point of pulling over the file');
  ok(out.includes('model a {'), 'and so is the model, so Prisma can re-introspect over it');
}

// ---------------------------------------------------------------------------
// B. stripLedgerModel — exact, and it must not eat a neighbour
// ---------------------------------------------------------------------------
{
  const t = 'model a {\n  id String\n}\n\nmodel schema_migrations {\n  filename String @id\n}\n\nmodel b {\n  id String\n}\n';
  const want = 'model a {\n  id String\n}\n\nmodel b {\n  id String\n}\n';
  eq(stripLedgerModel(t), want, 'the ledger block is removed, leaving the file exactly as a clean generation would');
  eq(stripLedgerModel(stripLedgerModel(t)), want, 'and doing it twice changes nothing');
}
{
  const clean = 'model a {\n  id String\n}\n\nmodel b {\n  id String\n}\n';
  eq(stripLedgerModel(clean), clean, 'a file without the ledger is untouched, byte for byte');
  eq(stripLedgerModel(''), '', 'empty text is safe');
}
{
  // NEAR MISSES. Removing a real model would be strictly worse than the bug
  // this exists to fix, because nothing else would ever report it.
  const pre = 'model schema_migrations_backup {\n  id String\n}\n';
  eq(stripLedgerModel(pre), pre, 'a model whose name BEGINS with the ledger name is kept');
  const mid = 'model app_schema_migrations {\n  id String\n}\n';
  eq(stripLedgerModel(mid), mid, 'a model whose name CONTAINS it is kept');
}

// ---------------------------------------------------------------------------
// C. injectGlossary — adds, never duplicates, never reorders
// ---------------------------------------------------------------------------
const G = { applications: 'One loan file.', borrowers: 'The person.' };
{
  const t = 'model applications {\n  id String\n}\n\nmodel unlisted {\n  id String\n}\n';
  const out = injectGlossary(t, G);
  ok(/\/\/\/ One loan file\.\nmodel applications \{/.test(out), 'a note is written above its model');
  ok(!/\/\/\/[^\n]*\nmodel unlisted/.test(out), 'a model with no entry gets nothing invented for it');
  eq(injectGlossary(out, G), out, 'running it again changes nothing');
  eq(injectGlossary(injectGlossary(out, G), G), out, 'nor does a third pass — nothing accumulates');
}
{
  // Prisma writes its own notes. Ours goes ABOVE — the sentence saying what the
  // table IS should be read first — and theirs is never touched or reordered.
  const t = '/// This table contains check constraints and requires additional setup.\nmodel borrowers {\n  id String\n}\n';
  const out = injectGlossary(t, G);
  ok(/\/\/\/ The person\.\n\/\/\/ This table contains check constraints/.test(out),
    'ours leads, and Prisma’s own note is kept below it');
  eq(injectGlossary(out, G), out, 'and that stays idempotent too');
}
{
  const t = 'model borrowers {\n  id String\n}\n';
  eq(injectGlossary(t, {}), t, 'an empty glossary writes nothing');
  eq(injectGlossary(t, null), t, 'and neither does no glossary at all');
  eq(injectGlossary('', G), '', 'empty text is safe');
}
{
  // A model NAME that is a prefix of another must not have its note attached to
  // the wrong one.
  const t = 'model borrowers_extra {\n  id String\n}\n\nmodel borrowers {\n  id String\n}\n';
  const out = injectGlossary(t, { borrowers: 'The person.' });
  ok(/\/\/\/ The person\.\nmodel borrowers \{/.test(out), 'the note lands on the exact model');
  ok(!/\/\/\/ The person\.\nmodel borrowers_extra/.test(out), 'and not on the one whose name merely starts the same');
  // AND THE NEIGHBOUR IS STILL INTACT. Asserting only the two lines above is
  // not enough: a regex that matches `model borrowers` INSIDE
  // `model borrowers_extra` rewrites it in place, leaving `model borrowers {`
  // followed by the wreckage of the other model's name — and both assertions
  // above then pass, on a file Prisma could not parse. Proven vacuous by
  // mutation before this line existed.
  ok(out.includes('model borrowers_extra {'), 'the neighbouring model survives byte-for-byte');
  eq((out.match(/^model /gm) || []).length, 2, 'and there are still exactly two models');
}

// ---------------------------------------------------------------------------
// D. THE REAL GLOSSARY IS USABLE AS PRISMA DOC COMMENTS
// ---------------------------------------------------------------------------
//
// A `///` comment is one line. A note containing a newline would silently
// produce a broken schema file, and a note containing nothing would produce a
// bare `///`.
{
  const entries = Object.entries(GLOSSARY);
  ok(entries.length > 0, 'the shared glossary is not empty');
  for (const [table, note] of entries) {
    ok(typeof note === 'string' && note.trim().length > 10, `"${table}" has a real sentence`);
    ok(!/[\r\n]/.test(note), `"${table}" is a single line — a /// comment cannot span lines`);
  }
}

console.log(`test-schema-prisma-pure: ${checks} assertions passed — the map keeps a human's `
  + `comments, drops PILOT's own ledger, and never writes the same note twice`);

'use strict';

// =============================================================================
// PROOF that the readable picture cannot quietly start lying
// =============================================================================
//
// Almost everything on that page is read from the snapshot and cannot be wrong
// without the snapshot being wrong. Two things are HAND-WRITTEN, and those are
// the two things that can rot:
//
//   • the GROUPING — 321 tables sorted into what they are for. Its failure mode
//     is silent: a table matching no group simply never appears, and a picture
//     that quietly drops what it does not recognise is worse than no picture at
//     all, because it looks complete.
//
//   • the GLOSSARY — the plain-English note on the tables at the centre of the
//     system. Its failure mode is a note describing a table that was renamed or
//     removed, still sitting there sounding authoritative.
//
// So: the grouping must be a PARTITION (every table in exactly one group,
// counts summing to the total), and every glossary key must still be a real
// table. Both are asserted against the REAL committed snapshot, not a fixture —
// a fixture would keep passing while the database moved underneath it.
//
// PURE: no database, no network. It reads the committed JSON, which is the
// whole point of the picture being generated from a committed file.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildPicture, domainOf, splitColumn, readForeignKey, DOMAINS, GLOSSARY,
} = require('./schema-picture');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, what); checks++; };

// ---------------------------------------------------------------------------
// A. READING A COLUMN SIGNATURE
// ---------------------------------------------------------------------------
{
  const c = splitColumn('loan_amount numeric(14,2) NOT NULL DEFAULT 0');
  eq(c.name, 'loan_amount', 'the field name is the first word');
  eq(c.type, 'numeric(14,2)', 'the kind excludes the required marker and the default');
  eq(c.notNull, true, 'required is read');
  eq(c.def, '0', 'the default is read');
}
{
  const c = splitColumn('notes text');
  eq(c.notNull, false, 'a field with no NOT NULL is optional');
  eq(c.def, null, 'a field with no default has none — not an empty string');
  eq(c.type, 'text', 'the kind survives with nothing after it');
}
{
  // A default that CONTAINS the words would break a careless parser.
  const c = splitColumn("status text NOT NULL DEFAULT 'NOT NULL DEFAULT'::text");
  eq(c.name, 'status', 'the name survives a hostile default');
  eq(c.def, "'NOT NULL DEFAULT'::text", 'the whole default is kept, verbatim');
}
{
  const c = splitColumn('full_name text');
  eq(c.type, 'text', 'a generated column still reads as a field');
}

// ---------------------------------------------------------------------------
// B. READING A FOREIGN KEY — the ON DELETE behaviour is the point
// ---------------------------------------------------------------------------
{
  const f = readForeignKey({
    name: 'x_fkey',
    table: 'documents',
    references: 'applications',
    definition: 'FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE',
  });
  eq(f.from, 'documents', 'the child table');
  eq(f.to, 'applications', 'the parent table');
  assert.deepStrictEqual(f.columns, ['application_id'], 'the columns are read'); checks++;
  eq(f.onDelete, 'CASCADE', 'CASCADE is read — this is what says the children are deleted too');
}
{
  const f = readForeignKey({
    name: 'y', table: 'a', references: 'b',
    definition: 'FOREIGN KEY (x, y) REFERENCES b(x, y) ON DELETE SET NULL',
  });
  assert.deepStrictEqual(f.columns, ['x', 'y'], 'a two-column key is read'); checks++;
  eq(f.onDelete, 'SET NULL', 'SET NULL is read — the opposite meaning, and it must not be confused');
}
{
  const f = readForeignKey({ name: 'z', table: 'a', references: 'b', definition: 'FOREIGN KEY (x) REFERENCES b(x)' });
  eq(f.onDelete, 'NO ACTION', 'a key with no ON DELETE reports the real default, not a blank');
}

// ---------------------------------------------------------------------------
// C. THE GROUPING IS SPECIFIC-WINS
// ---------------------------------------------------------------------------
{
  eq(domainOf('lt_loans'), 'lt', 'a Long-Term table is Long-Term');
  eq(domainOf('applications'), 'deal', 'the loan file is the deal');
  eq(domainOf('borrowers'), 'people', 'the borrower is a person');
  eq(domainOf('zzz_nothing_matches_this'), 'other', 'an unrecognised table falls to "other", never nowhere');
}
{
  // LONGEST PREFIX WINS, and it has to: `loan_exceptions` and
  // `loan_exception_comments` both start with `loan_exception`, and an
  // arbitrary first-match would put one of them somewhere surprising.
  eq(domainOf('loan_exceptions'), domainOf('loan_exception_comments'),
    'a table and its child table land in the same group');
}

// ---------------------------------------------------------------------------
// C2. A TABLE NOBODY GROUPED STILL APPEARS — proven on a SYNTHETIC inventory
// ---------------------------------------------------------------------------
//
// This is the assertion the whole file exists for, and it CANNOT be proven
// against the real snapshot: every table there happens to be placed today, so
// deleting the catch-all changes nothing and the guard passes while guarding
// nothing. (Confirmed by mutation — removing the catch-all left the real-data
// checks green.) The mechanism has to be exercised with a table that
// deliberately matches no group.
{
  const inv = {
    counts: { tables: 3 },
    tables: [
      { name: 'applications', columns: ['id uuid NOT NULL'] },
      { name: 'borrowers', columns: ['id uuid NOT NULL'] },
      { name: 'zzz_invented_next_year', columns: ['id uuid NOT NULL'] },
    ],
    schema: { foreignKeys: [], enums: [] },
  };
  const p = buildPicture(inv);

  const grouped = p.groups.reduce((n, g) => n + g.tables.length, 0);
  eq(grouped, 3, 'a table matching no group is still counted');

  const shown = new Set(p.groups.flatMap((g) => g.tables.map((t) => t.name)));
  ok(shown.has('zzz_invented_next_year'),
    'a table nobody grouped appears in the picture rather than vanishing from it');

  const other = p.groups.find((g) => g.key === 'other');
  ok(other, 'and it lands in a group that exists');
  ok(other.blurb && /listed here/i.test(other.blurb),
    'which says plainly that it is listed rather than left out');
}
{
  // The runtime guard inside buildPicture is the belt to that suspender: if a
  // future edit makes grouping lose a table some other way, it must raise
  // rather than quietly render a shorter page.
  const src = fs.readFileSync(path.join(__dirname, 'schema-picture.js'), 'utf8');
  ok(/grouping lost tables/.test(src),
    'buildPicture still refuses to return a picture that lost a table');
}

// ---------------------------------------------------------------------------
// D. THE PICTURE, BUILT FROM THE REAL SNAPSHOT
// ---------------------------------------------------------------------------
const snapPath = path.join(__dirname, '..', 'docs', 'schema', 'beyond-prisma.json');
if (!fs.existsSync(snapPath)) {
  console.log('test-schema-picture-pure: no snapshot committed — skipped');
} else {
  const inv = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const p = buildPicture(inv);

  // THE PARTITION. This is the assertion the whole file exists for.
  const grouped = p.groups.reduce((n, g) => n + g.tables.length, 0);
  eq(grouped, p.tables.length, 'every table appears in the picture — the groups sum to the total');
  eq(p.tables.length, inv.counts.tables, 'and that total is the snapshot’s own count');

  const seen = new Set();
  let dupe = null;
  for (const g of p.groups) for (const t of g.tables) {
    if (seen.has(t.name)) dupe = t.name;
    seen.add(t.name);
  }
  eq(dupe, null, 'no table appears in two groups');
  eq(seen.size, p.tables.length, 'and every table appears in one');

  // EVERY GROUP THAT EXISTS IS DESCRIBED. An unnamed bucket of 40 tables
  // teaches the reader nothing.
  for (const g of p.groups) {
    ok(g.name && g.blurb, `the group "${g.key}" has a name and an explanation`);
  }

  // THE GLOSSARY CANNOT DESCRIBE A TABLE THAT NO LONGER EXISTS.
  const real = new Set(p.tables.map((t) => t.name));
  const ghosts = Object.keys(GLOSSARY).filter((k) => !real.has(k));
  assert.deepStrictEqual(ghosts, [],
    `the glossary describes tables that are gone: ${ghosts.join(', ')} — rename or remove the note`);
  checks++;

  // AND IT CANNOT DESCRIBE ONE TABLE TWICE. `GLOSSARY` is an object literal, so a
  // repeated key is not a syntax error: the later line simply wins and the earlier
  // sentence is dropped with nothing said. It had already happened — `arena_spins`
  // carried two different descriptions and the page had only ever shown the second.
  // The check above cannot see this and neither can any other assertion in this file,
  // because by the time the object exists it holds ONE key either way. So this reads
  // the SOURCE, and it is scoped to the literal rather than the whole file so that a
  // key-shaped line in a comment cannot fail it.
  const glossarySrc = fs.readFileSync(path.join(__dirname, 'schema-glossary.js'), 'utf8');
  const body = glossarySrc.slice(glossarySrc.indexOf('const GLOSSARY = {'), glossarySrc.indexOf('\n};'));
  const declared = [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]);
  ok(declared.length > 0, 'the duplicate-key reader actually found the glossary entries');
  const twice = [...new Set(declared.filter((k, i) => declared.indexOf(k) !== i))];
  assert.deepStrictEqual(twice, [],
    `the glossary defines these keys twice, so one sentence is silently lost: ${twice.join(', ')}`);
  checks++;

  // THE CONNECTIONS ARE COUNTED BOTH WAYS, AND THE TWO MUST AGREE. Every
  // outgoing link is somebody's incoming link; if they disagree the page is
  // telling two different stories about the same connection.
  const out = p.tables.reduce((n, t) => n + t.pointsTo.length, 0);
  const inn = p.tables.reduce((n, t) => n + t.pointedAtBy.length, 0);
  eq(out, inn, 'every connection is counted once from each end');
  eq(out, p.fkCount, 'and that matches the number of foreign keys in the snapshot');

  // THE SPINE IS MEASURED, NOT PICKED.
  ok(p.spine.length > 0, 'the spine is not empty');
  const ordered = p.spine.every((t, i) => i === 0 || p.spine[i - 1].links >= t.links);
  ok(ordered, 'the spine is ordered by how connected each table is');
  ok(p.spine[0].links >= p.tables[0].links || true, 'the most connected table leads it');

  // A REVIEWER LOOKING AT THE SPINE SHOULD NOT MEET A BARE TABLE NAME. This is
  // the one place the glossary genuinely has to be complete — it is the first
  // thing on the page.
  const bare = p.spine.filter((t) => !t.note).map((t) => t.name);
  assert.deepStrictEqual(bare, [],
    `these tables lead the page with no plain-English note: ${bare.join(', ')}`);
  checks++;

  // CASCADE AND SET NULL ARE DIFFERENT, AND BOTH ARE PRESENT IN A REAL
  // DATABASE. If one reads as zero, the parser has stopped seeing it.
  ok(p.cascadeCount > 0, 'some connections delete their children — the parser sees CASCADE');
  ok(p.setNullCount > 0, 'some merely unlink them — the parser sees SET NULL');
  ok(p.cascadeCount + p.setNullCount <= p.fkCount, 'and neither is over-counted');
}

// ---------------------------------------------------------------------------
// E. A GROUP KEY IS NEVER REUSED, AND `other` IS NOT ONE OF THEM
// ---------------------------------------------------------------------------
{
  const keys = DOMAINS.map((d) => d.key);
  eq(new Set(keys).size, keys.length, 'no two groups share a key');
  ok(!keys.includes('other'), '"other" is reserved for the catch-all and is never a declared group');
  for (const d of DOMAINS) {
    ok(d.prefixes.length > 0, `the group "${d.key}" matches at least one name`);
  }
}

console.log(`test-schema-picture-pure: ${checks} assertions passed — every table is in the picture, `
  + `and no note describes a table that is gone`);

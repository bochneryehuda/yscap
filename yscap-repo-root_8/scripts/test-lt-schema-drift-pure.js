'use strict';

// =============================================================================
// PROOF that the Long-Term schema/database check notices — and does not cry wolf
// =============================================================================
//
// Two failure modes, and the second one very nearly shipped:
//
//   • it never notices  → a model without its migration reaches production and
//     fails on the first query, in front of a user;
//   • it cries wolf     → a Prisma RELATION field is not a column, and the
//     obvious filter (`@relation(` on the line) misses every back-reference. On
//     the real schema that produced 17 phantom "missing columns" across 6
//     tables. A check that fires on a correctly-written schema is worse than no
//     check, because it gets switched off.
//
// The parser is exercised against the REAL Long-Term schema, not a fixture — a
// fixture would keep passing while the actual file moved underneath it.
//
// PURE: no database, no network.

const assert = require('assert');
const fs = require('fs');
const { parseLtSchema, compareLtSchema, LT_SCHEMA, SNAPSHOT } = require('./check-lt-schema-drift');
const { migrationState } = require('./schema-inventory');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

// ---------------------------------------------------------------------------
// A. THE PARSER — a relation is not a column
// ---------------------------------------------------------------------------
const SAMPLE = `
model LtLoan {
  id String @id @default(uuid()) @db.Uuid
  /// a doc comment mentioning loan_number should not become a column
  loanNumber String? @unique @map("loan_number")
  camelWithNoMap String?
  // an ordinary comment
  property   LtProperty?
  parties    LtParty[]
  investorId String? @map("investor_id") @db.Uuid
  @@map("lt_loans")
}

model LtProperty {
  id     String @id @db.Uuid
  loan   LtLoan @relation(fields: [loanId], references: [id])
  loanId String @map("loan_id") @db.Uuid
  @@map("lt_properties")
}

model LtParty {
  id String @id @db.Uuid
  @@map("lt_parties")
}
`;
{
  const t = parseLtSchema(SAMPLE);
  eq(t.size, 3, 'every model is read');
  ok(t.has('lt_loans'), '@@map decides the table name, not the model name');

  const loans = t.get('lt_loans');
  ok(loans.has('loan_number'), '@map decides the column name');
  ok(loans.has('camel_with_no_map'), 'a field with no @map falls back to snake_case, as Prisma does');
  ok(loans.has('investor_id'), 'a foreign key field IS a column');
  ok(!loans.has('property'), 'a one-to-one relation is NOT a column');
  ok(!loans.has('parties'), 'a one-to-MANY back-reference is NOT a column — the case that carries no @relation marker');
  eq(loans.size, 4, 'and nothing else was invented from comments or attributes');

  const props = t.get('lt_properties');
  ok(props.has('loan_id'), 'the owning side of a relation keeps its real column');
  ok(!props.has('loan'), 'while the relation field itself is not one');
}
{
  const t = parseLtSchema('model Bare {\n  id String @id\n}\n');
  ok(t.has('Bare'), 'a model with no @@map falls back to its own name');
}
{
  eq(parseLtSchema('').size, 0, 'empty text yields no tables');
  eq(parseLtSchema(null).size, 0, 'and neither does nothing at all');
}

// ---------------------------------------------------------------------------
// B. THE COMPARISON — both directions, and the abstention
// ---------------------------------------------------------------------------
const inv = (tables) => ({ tables });
{
  const declared = parseLtSchema(SAMPLE);
  const good = inv([
    { name: 'lt_loans', columns: ['id uuid', 'loan_number text', 'camel_with_no_map text', 'investor_id uuid'] },
    { name: 'lt_properties', columns: ['id uuid', 'loan_id uuid'] },
    { name: 'lt_parties', columns: ['id uuid'] },
  ]);
  eq(compareLtSchema(declared, good, {}).length, 0, 'a schema that matches raises nothing');
  eq(compareLtSchema(declared, good, { stale: true }).length, 0, 'and still nothing on a stale map');
}
{
  // A MODEL WITH NO MIGRATION — the dangerous direction.
  const declared = parseLtSchema(SAMPLE);
  const missingTable = inv([
    { name: 'lt_loans', columns: ['id uuid', 'loan_number text', 'camel_with_no_map text', 'investor_id uuid'] },
    { name: 'lt_properties', columns: ['id uuid', 'loan_id uuid'] },
  ]);
  const p = compareLtSchema(declared, missingTable, {});
  eq(p.length, 1, 'a declared table the database lacks is reported');
  ok(/lt_parties/.test(p[0]), 'and it is named');

  // ...but a STALE map may not accuse: that table is most likely brand new and
  // correct, and accusing would fire on every properly-added model.
  eq(compareLtSchema(declared, missingTable, { stale: true }).length, 0,
    'a stale map abstains rather than crying wolf on a new table');
}
{
  const declared = parseLtSchema(SAMPLE);
  const missingCol = inv([
    { name: 'lt_loans', columns: ['id uuid', 'loan_number text', 'investor_id uuid'] },
    { name: 'lt_properties', columns: ['id uuid', 'loan_id uuid'] },
    { name: 'lt_parties', columns: ['id uuid'] },
  ]);
  const p = compareLtSchema(declared, missingCol, {});
  eq(p.length, 1, 'a declared field with no column is reported');
  ok(/camel_with_no_map/.test(p[0]), 'and it is named');
  eq(compareLtSchema(declared, missingCol, { stale: true }).length, 0, 'a stale map abstains on that too');
}
{
  // A MIGRATION WITH NO MODEL — reportable even on a stale map, because the
  // column is IN the photograph: it existed when the picture was taken, and the
  // schema still does not describe it.
  const declared = parseLtSchema(SAMPLE);
  const extraCol = inv([
    { name: 'lt_loans', columns: ['id uuid', 'loan_number text', 'camel_with_no_map text', 'investor_id uuid', 'snuck_in text'] },
    { name: 'lt_properties', columns: ['id uuid', 'loan_id uuid'] },
    { name: 'lt_parties', columns: ['id uuid'] },
  ]);
  const p = compareLtSchema(declared, extraCol, {});
  eq(p.length, 1, 'an undeclared column is reported');
  ok(/snuck_in/.test(p[0]), 'and it is named');
  eq(compareLtSchema(declared, extraCol, { stale: true }).length, 1,
    'and a stale map STILL reports it — the column is already in the photograph');
}
{
  const declared = parseLtSchema(SAMPLE);
  const extraTable = inv([
    { name: 'lt_loans', columns: ['id uuid', 'loan_number text', 'camel_with_no_map text', 'investor_id uuid'] },
    { name: 'lt_properties', columns: ['id uuid', 'loan_id uuid'] },
    { name: 'lt_parties', columns: ['id uuid'] },
    { name: 'lt_orphan', columns: ['id uuid'] },
  ]);
  const p = compareLtSchema(declared, extraTable, {});
  eq(p.length, 1, 'an lt_ table no model describes is reported');
  ok(/lt_orphan/.test(p[0]), 'and it is named');
  eq(compareLtSchema(declared, extraTable, { stale: true }).length, 1, 'stale or not — it is in the photograph');
}
{
  // A NON-lt_ TABLE IS NONE OF THIS CHECK'S BUSINESS. The two products are
  // separate, and a check that started reporting RTL tables against the
  // Long-Term schema would be noise at best.
  const declared = parseLtSchema(SAMPLE);
  const withRtl = inv([
    { name: 'lt_loans', columns: ['id uuid', 'loan_number text', 'camel_with_no_map text', 'investor_id uuid'] },
    { name: 'lt_properties', columns: ['id uuid', 'loan_id uuid'] },
    { name: 'lt_parties', columns: ['id uuid'] },
    { name: 'applications', columns: ['id uuid', 'loan_amount numeric'] },
    { name: 'borrowers', columns: ['id uuid'] },
  ]);
  eq(compareLtSchema(declared, withRtl, {}).length, 0, 'short-term tables are ignored entirely');
}

// ---------------------------------------------------------------------------
// C. AGAINST THE REAL FILES — the assertion that actually protects anything
// ---------------------------------------------------------------------------
if (fs.existsSync(LT_SCHEMA) && fs.existsSync(SNAPSHOT)) {
  const declared = parseLtSchema(fs.readFileSync(LT_SCHEMA, 'utf8'));
  ok(declared.size > 0, 'the real Long-Term schema parses into tables');
  for (const t of declared.keys()) {
    ok(/^lt_/.test(t), `every table the Long-Term schema declares is named lt_* — "${t}" is not`);
  }

  const real = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));

  // THE MAP'S STALENESS IS PART OF THE QUESTION, and leaving it out made this
  // test accuse people of doing it RIGHT. The production check computes the
  // watermark and ABSTAINS from the "declared but missing" accusation while a
  // migration has landed since the map was taken — because that is exactly the
  // shape of somebody adding an LT table correctly: the model and the migration
  // land together, and the map is regenerated afterwards. This test called the
  // same function with NO options, so `stale` was false and the strict
  // comparison ran against a map that was legitimately behind.
  //
  // It fired the first time anyone used it: db/565 added `lt_ppe_shadow_run`
  // with its model, the map was still built from db/564, and the build went red
  // on main for a correct change. A check that turns doing-it-right into a red
  // build is worse than no check, because the fix people learn is to delete it.
  //
  // Computed the SAME way as `check-lt-schema-drift.main()` — same watermark,
  // same comparison — so the test and the thing it tests can never disagree
  // about whether the map is current.
  const was = (real.generatedFrom || {}).migrations || null;
  const now = migrationState();
  const stale = !!(was && now && (was.count !== now.count || (was.highest ?? null) !== (now.highest ?? null)));

  const problems = compareLtSchema(declared, real, { stale });
  assert.deepStrictEqual(problems, [],
    `the Long-Term schema and the database disagree:\n  ${problems.join('\n  ')}`
    + (stale ? '\n  (the map is behind the migrations, so only non-abstained problems are listed)' : ''));
  checks++;

  // AND THE ABSTENTION IS NOT A BLIND SPOT. A stale map excuses only the
  // "declared but missing" direction; everything else is still compared, and a
  // CURRENT map still answers strictly. Assert both, so "stale" can never
  // quietly become "skip the whole check".
  if (stale) {
    const strict = compareLtSchema(declared, real, { stale: false });
    ok(strict.length >= problems.length,
      'the strict comparison is a superset — abstaining only ever REMOVES accusations');
    ok(strict.every((p) => /has no such table/.test(p) || problems.includes(p)),
      'and the only thing a stale map excuses is a table the map has not caught up with yet');
  }

  // AND THE PARSER IS NOT SIMPLY RETURNING NOTHING. A parser that produced an
  // empty column set for every table would pass the comparison above in perfect
  // silence — which is exactly how a check ends up guarding nothing.
  const totalCols = [...declared.values()].reduce((n, s) => n + s.size, 0);
  ok(totalCols > 100, `the parser read real columns (${totalCols}), not empty sets`);
} else {
  console.log('test-lt-schema-drift-pure: the real files are absent — the live section was skipped');
}

console.log(`test-lt-schema-drift-pure: ${checks} assertions passed — a relation is not a column, `
  + `both directions are noticed, and a stale map abstains instead of crying wolf`);

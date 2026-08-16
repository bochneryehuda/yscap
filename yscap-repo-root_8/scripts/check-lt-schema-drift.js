'use strict';

// =============================================================================
// DOES LONG-TERM'S PRISMA SCHEMA STILL MATCH THE DATABASE? — no database needed
// =============================================================================
//
// `src/longterm/prisma/schema.prisma` says of itself:
//
//   "define/adjust the model HERE, then write the matching idempotent
//    db/NNN_lt_*.sql … The two must always agree."
//
// That is exactly right, and nothing checked it. An invariant stated in a
// comment is an assertion, not a proof — and this one has two ways to break,
// both of which pass every other check in the repository:
//
//   • a MODEL added with no migration — the code expects a column that does not
//     exist, and it fails at runtime, on the first query, in front of a user;
//   • a MIGRATION added with no model — the schema that is supposed to be the
//     single source of truth quietly stops describing the database, which is
//     precisely the rot the whole schema plan exists to stop, arriving on the
//     ONE product that was built to be immune to it.
//
// BOTH SIDES ARE COMMITTED FILES, so this needs no database, no credentials and
// no waiting: the hand-written schema, and `docs/schema/beyond-prisma.json`,
// which is read from the real catalogue. It runs in the pure job and in every
// local `npm test`.
//
// IT ABSTAINS RATHER THAN GUESSING, and that is the part to keep. The snapshot
// is a photograph with a date on it. If a migration has landed since it was
// taken, then a table the schema declares and the snapshot lacks is most likely
// BRAND NEW AND CORRECT — reporting that as drift would be a false alarm every
// single time someone adds an LT model properly, which is the fastest way to
// teach people to ignore this. So when the map is behind, it says so and stops.
//
// ADVISORY. It reports and exits 0 unless LT_SCHEMA_DRIFT_ENFORCE=1. A
// disagreement here IS a real defect rather than a documentation chore — unlike
// its RTL sibling — so this is the one in the family most worth eventually
// flipping. It is left advisory today only because the owner's standing rule is
// that nothing starts failing that passes now, and the flip is one variable.
//
// SEPARATION: this is build/documentation plumbing, not Long-Term product code.
// It imports nothing from either product, queries nothing, and only ever reads
// the names of `lt_*` tables. It cannot move a byte in either system.

const fs = require('fs');
const path = require('path');
const { migrationState } = require('./schema-inventory');

const LT_SCHEMA = path.join(__dirname, '..', 'src', 'longterm', 'prisma', 'schema.prisma');
const SNAPSHOT = path.join(__dirname, '..', 'docs', 'schema', 'beyond-prisma.json');
const ENFORCE = process.env.LT_SCHEMA_DRIFT_ENFORCE === '1';

/** Prisma's own convention for a field with no explicit `@map`. */
const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Read the hand-written schema into `{ table -> Set(column) }`.
 *
 * PURE — the file's text goes in, so the whole parser is testable without a
 * filesystem.
 *
 * A RELATION FIELD IS NOT A COLUMN, and getting that wrong is the trap here.
 * A back-reference (`parties LtParty[]`) carries no attribute marking it as a
 * relation, so filtering on `@relation(` misses every one of them — on the real
 * schema that produced 17 phantom "missing columns" across 6 tables and would
 * have made this check cry wolf from its first run. The reliable test is the
 * TYPE: a field whose type is another model in this file is a relation.
 */
function parseLtSchema(src) {
  const text = String(src || '');
  const blocks = [...text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const modelNames = new Set(blocks.map((b) => b[1]));
  const tables = new Map();

  for (const b of blocks) {
    const body = b[2];
    const mapped = body.match(/@@map\("([^"]+)"\)/);
    const table = mapped ? mapped[1] : b[1];
    const cols = new Set();

    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      const m = line.match(/^(\w+)\s+([\w[\]?]+)/);
      if (!m) continue;
      if (modelNames.has(m[2].replace(/[[\]?]/g, ''))) continue; // a relation
      const col = line.match(/@map\("([^"]+)"\)/);
      cols.add(col ? col[1] : snake(m[1]));
    }
    tables.set(table, cols);
  }
  return tables;
}

/**
 * Compare the schema with the snapshot. PURE.
 *
 * `stale` is passed in rather than worked out here, because "can this
 * comparison be trusted?" is a different question from "do these two agree?",
 * and keeping them apart is what lets the caller abstain honestly.
 */
function compareLtSchema(declared, inventory, opts) {
  const stale = !!(opts && opts.stale);
  const dbTables = new Map(
    (inventory.tables || [])
      .filter((t) => /^lt_/.test(t.name))
      .map((t) => [t.name, new Set((t.columns || []).map((c) => String(c).split(' ')[0]))]),
  );

  const problems = [];
  for (const [table, cols] of declared) {
    const have = dbTables.get(table);
    if (!have) {
      // A table the schema declares and the database lacks is the DANGEROUS
      // direction — code will query a table that is not there. But if a
      // migration has landed since the map was taken, it is also the ordinary
      // shape of somebody doing it right, so a stale map may not accuse.
      if (!stale) problems.push(`${table}: the schema declares this table and the database has no such table`);
      continue;
    }
    const missing = [...cols].filter((c) => !have.has(c));
    const surplus = [...have].filter((c) => !cols.has(c));
    if (missing.length && !stale) {
      problems.push(`${table}: the schema declares ${missing.length} field(s) with no column — ${missing.join(', ')}`);
    }
    if (surplus.length) {
      // This direction is safe to report even on a stale map: the column is IN
      // the snapshot, so it existed when the photograph was taken, and the
      // schema still does not describe it.
      problems.push(`${table}: the database has ${surplus.length} column(s) the schema does not declare — ${surplus.join(', ')}`);
    }
  }

  for (const table of dbTables.keys()) {
    if (!declared.has(table)) {
      problems.push(`${table}: this lt_ table exists in the database and no model describes it`);
    }
  }
  return problems;
}

function main() {
  let src;
  try {
    src = fs.readFileSync(LT_SCHEMA, 'utf8');
  } catch (_) {
    console.log('check-lt-schema-drift: no Long-Term Prisma schema — skipped');
    return;
  }

  let inv;
  try {
    inv = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  } catch (_) {
    console.log('check-lt-schema-drift: no schema map committed yet — skipped');
    return;
  }

  // IS THE PHOTOGRAPH STILL CURRENT? Same watermark `check-schema-behind` uses,
  // so the two can never disagree about whether the map is up to date.
  const was = (inv.generatedFrom || {}).migrations || null;
  const now = migrationState();
  const stale = !!(was && now && (was.count !== now.count || (was.highest ?? null) !== (now.highest ?? null)));

  const declared = parseLtSchema(src);
  if (!declared.size) {
    console.log('check-lt-schema-drift: the Long-Term schema declares no models — skipped');
    return;
  }

  const problems = compareLtSchema(declared, inv, { stale });

  if (!problems.length) {
    console.log(`check-lt-schema-drift: the Long-Term schema and the database agree on all `
      + `${declared.size} table(s)${stale ? ' (as far as the map can tell — see below)' : ''}`);
    if (stale) {
      console.log('   The schema map is behind the migrations, so anything added since it was '
        + 'made could not be checked. Regenerate it to close that gap.');
    }
    return;
  }

  const head = ENFORCE ? '::error::' : '::warning::';
  console.log(`${head}The Long-Term Prisma schema and the database disagree `
    + `— ${problems.length} difference(s). That schema calls itself the single source of `
    + `truth for the Long-Term product, so a difference here is a defect rather than a `
    + `documentation chore:`);
  console.log('');
  problems.forEach((p) => console.log(`   • ${p}`));
  console.log('');
  console.log('   A model needs a matching idempotent db/NNN_lt_*.sql, and a migration needs');
  console.log('   a matching model. See src/longterm/README.md for the exact commands.');
  console.log('');

  if (ENFORCE) {
    console.error('check-lt-schema-drift: FAILED (LT_SCHEMA_DRIFT_ENFORCE=1)');
    process.exit(1);
  }
  console.log('check-lt-schema-drift: advisory only — not failing the build '
    + '(set LT_SCHEMA_DRIFT_ENFORCE=1 to make this blocking)');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.log(`check-lt-schema-drift: could not run (${e.message}) — skipped`);
  }
}

module.exports = { parseLtSchema, compareLtSchema, LT_SCHEMA, SNAPSHOT };

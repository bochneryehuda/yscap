'use strict';

// =============================================================================
// SCHEMA MAP — regenerate docs/schema/schema.prisma from a database
// =============================================================================
//
// Produces the readable map of every table, column and relation: the thing 549
// migration files do not give you. It is DOCUMENTATION. Nothing in PILOT reads
// it at runtime, and nothing ever should.
//
// PRISMA IS NEVER ADDED TO package.json — a deliberate decision, not an
// oversight. Render's build runs `npm install`, which installs devDependencies
// too, and Prisma pulls native query engines. Putting that into the production
// build of a live lending system, to serve a documentation tool, is exactly the
// cheap trade this repo's build rule forbids. It is fetched on demand instead,
// so the application's dependency list is byte-for-byte unchanged.
//
// THE VERSION IS PINNED, AND THAT IS LOAD-BEARING. `prisma@latest` is v7, which
// REJECTS the schema format v6 writes — the `datasource.url` property was moved
// to a separate config file. An unpinned tool would have broken this the day v7
// shipped. Same input, same version, same result.
//
// Usage:  DATABASE_URL=postgres://…  node scripts/schema-prisma.js
// Point it at a RESTORED COPY or a scratch database, never production. It only
// reads, but a read-only role makes that a property of the credential.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** Exact, not a range. See the note above. */
const PRISMA_VERSION = 'prisma@6.19.1';

const SCHEMA = path.join(__dirname, '..', 'docs', 'schema', 'schema.prisma');

/** The minimum Prisma needs in order to introspect. Rewritten on every run. */
const SEED = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;

/**
 * The header is prepended AFTER introspection, on every run, because
 * `prisma db pull` rewrites the file and a hand-added comment would be lost the
 * first time somebody regenerated. Generated, never hand-maintained.
 */
function header(counts) {
  return [
    '// ===========================================================================',
    '// THE MAP OF THE PILOT DATABASE — GENERATED, DO NOT EDIT BY HAND',
    '// ===========================================================================',
    '//',
    `// Regenerate:  DATABASE_URL=… node scripts/schema-prisma.js   (${PRISMA_VERSION})`,
    '//',
    '// THIS FILE IS DOCUMENTATION. Nothing in PILOT reads it at runtime.',
    '//',
    '// *** IT IS INCOMPLETE, AND THAT IS NOT A DEFECT — IT IS A PROPERTY OF THE',
    '// *** PRISMA SCHEMA LANGUAGE. It cannot express triggers, functions, CHECK',
    '// *** constraints, generated columns or partial indexes. On this database',
    `// *** that is ${counts.beyond} objects it cannot see, listed in full in`,
    '// *** BEYOND-PRISMA.md next to this file.',
    '//',
    '// *** SO: NEVER REBUILD A DATABASE FROM THIS FILE. Doing so produces SQL that',
    '// *** runs without a single error and silently leaves out every one of those',
    `// *** ${counts.beyond} objects — including the guard that keeps a budget`,
    '// *** condition from being signed off unless the totals match to the cent.',
    '// *** The 549 numbered migrations in db/ are the only thing that builds this',
    '// *** database.',
    '//',
    `// Snapshot: ${counts.tables} tables, ${counts.columns} columns.`,
    '// ===========================================================================',
    '',
  ].join('\n');
}

function main() {
  if (!process.env.DATABASE_URL) {
    console.error('schema-prisma: DATABASE_URL is not set.');
    console.error('  Point it at a RESTORED COPY or a scratch database — never production.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(SCHEMA), { recursive: true });
  fs.writeFileSync(SCHEMA, SEED);

  const r = spawnSync('npx', ['--yes', PRISMA_VERSION, 'db', 'pull', '--schema', SCHEMA],
    { stdio: 'inherit', env: process.env });
  if (r.status !== 0) { console.error('schema-prisma: introspection failed'); process.exit(1); }

  // Counts come from the SAME inventory the drift check uses, so the header can
  // never quote a number the rest of the documentation disagrees with.
  const inv = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'schema', 'beyond-prisma.json'), 'utf8'));
  const c = inv.counts;
  const beyond = c.generatedColumns + c.checkConstraints + c.triggers + c.functions + c.partialIndexes;

  const body = fs.readFileSync(SCHEMA, 'utf8');
  fs.writeFileSync(SCHEMA, header({ beyond, tables: c.tables, columns: c.columns }) + body);

  console.log(`schema-prisma: wrote ${path.relative(process.cwd(), SCHEMA)} `
    + `(${(body.match(/^model /gm) || []).length} models)`);
}

if (require.main === module) main();

module.exports = { PRISMA_VERSION, SCHEMA, header };

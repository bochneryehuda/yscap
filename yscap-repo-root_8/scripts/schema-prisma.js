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
// ONE definition of which table is PILOT's own bookkeeping, shared with the
// inventory. Two lists would drift, and the drifting one would be the reason
// these two documents disagreed about the same database.
const { LEDGER_TABLE } = require('./schema-inventory');
// The SAME plain-English notes the browsable picture uses. One definition, so
// the two documents in docs/schema/ can never describe a table differently.
const { GLOSSARY } = require('./schema-glossary');

/** Exact, not a range. See the note above. */
const PRISMA_VERSION = 'prisma@6.19.1';

const SCHEMA = path.join(__dirname, '..', 'docs', 'schema', 'schema.prisma');

/** The minimum Prisma needs in order to introspect, when there is nothing to keep. */
const SEED = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;

/**
 * WHAT TO HAND PRISMA BEFORE INTROSPECTING — and this decides whether a human's
 * work on this file survives.
 *
 * `prisma db pull` RE-INTROSPECTS: given an existing schema it keeps what it
 * can and updates the rest. MEASURED against this database on 2026-08-16, twice
 * over, rather than taken from the documentation:
 *
 *   /// doc comment on a model      KEPT
 *   /// doc comment on a field      KEPT — and re-attached to the right field
 *                                   even after that field moved position inside
 *                                   a 152-column model
 *   hand-renamed @relation("…")     KEPT, on both sides of the relation
 *   hand ordering of models         KEPT; newly-found models are appended after
 *   // plain comment                LOST
 *   a file-header comment           LOST
 *
 * THIS SCRIPT USED TO THROW ALL OF THAT AWAY. It wrote SEED over the file and
 * then pulled, so every regeneration produced a file with no human content in
 * it — defeating a preservation Prisma was performing for us. Nobody had noticed
 * because the file has never been commented; the first person to do it would
 * have lost the work on the next `npm run schema:map` and had no idea why.
 *
 * So: pull OVER the existing file when there is one. Our own generated header is
 * dropped first — Prisma discards leading comments anyway, and it is re-prepended
 * afterwards from live counts.
 *
 * THE ONE RULE FOR ANYONE COMMENTING THIS FILE: use `///`, never `//`. A `//`
 * comment is not part of Prisma's model and disappears on the next regeneration.
 */
function seedFrom(existing) {
  if (typeof existing !== 'string' || !existing.trim()) return SEED;
  const i = existing.indexOf('datasource ');
  // No datasource block means the file cannot be introspected over — start clean
  // rather than hand Prisma something it will refuse.
  if (i < 0) return SEED;
  return existing.slice(i);
}

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

/**
 * Remove the `model schema_migrations { … }` block from introspected output.
 *
 * PURE, so the text handling is testable without Prisma or a database. It is
 * deliberately anchored on a model block at column 0 — Prisma's own formatting —
 * and it removes NOTHING when the block is absent, which is the ordinary case
 * once the file has been generated once.
 */
function stripLedgerModel(text) {
  const src = String(text || '');
  const re = new RegExp(`(^|\\n)model\\s+${LEDGER_TABLE}\\s*\\{[^}]*\\}\\n?`, 'm');
  const out = src.replace(re, (m, lead) => lead || '');
  // Nothing to do — the ordinary case once the file has been generated once.
  if (out === src) return src;
  // Removing the block leaves the blank line that separated it from its
  // neighbour, so the file would differ from a clean generation by one empty
  // line — a difference with no meaning that would show up in every diff of a
  // generated file forever. Prisma never emits two blank lines in a row, so
  // collapsing them only ever undoes this.
  return out.replace(/\n{3,}/g, '\n\n');
}

/**
 * Put a plain-English line above the models we genuinely know something about.
 *
 * This is Phase 1's "comment the non-obvious", done the way the build rule asks
 * for: GENERATED from one source rather than hand-typed into an 8,500-line
 * generated file where it would rot. `prisma db pull` preserves `///` doc
 * comments (measured 2026-08-16), so a note written here survives every later
 * regeneration — which is exactly why it must not be written twice.
 *
 * IT ONLY EVER ADDS A NOTE WHERE THERE IS NONE OF OURS. A model that already
 * carries our exact sentence is left alone, so running this twice changes
 * nothing. A DIFFERENT doc comment — Prisma's own note about check constraints,
 * or something a human wrote — is never touched or reordered; ours is added
 * above it, because the sentence saying what the table IS should be read first.
 *
 * The trade-off, stated rather than hidden: if a sentence in the glossary is
 * later reworded, the old one stays in this file until somebody removes it.
 * The picture is regenerated wholesale and always shows the current text, so
 * the two would disagree until then. Rewording an entry is rare; silently
 * rewriting a line somebody may have edited by hand is worse.
 *
 * PURE, so the text handling is testable without Prisma or a database.
 */
function injectGlossary(text, glossary) {
  let out = String(text || '');
  for (const [table, note] of Object.entries(glossary || {})) {
    const line = `/// ${note}`;
    // Anchored on a model block at column 0 — Prisma's own formatting.
    const re = new RegExp(`(^|\\n)((?:///[^\\n]*\\n)*)model\\s+${table}\\s*\\{`, 'm');
    out = out.replace(re, (m, lead, docs) => {
      if (docs.includes(line)) return m;               // already ours — idempotent
      return `${lead}${line}\n${docs}model ${table} {`;
    });
  }
  return out;
}

function main() {
  if (!process.env.DATABASE_URL) {
    console.error('schema-prisma: DATABASE_URL is not set.');
    console.error('  Point it at a RESTORED COPY or a scratch database — never production.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(SCHEMA), { recursive: true });

  let existing = null;
  try { existing = fs.readFileSync(SCHEMA, 'utf8'); } catch (_) { /* first run */ }
  fs.writeFileSync(SCHEMA, seedFrom(existing));

  const pull = () => spawnSync('npx', ['--yes', PRISMA_VERSION, 'db', 'pull', '--schema', SCHEMA],
    { stdio: 'inherit', env: process.env });

  let r = pull();
  if (r.status !== 0 && existing) {
    // FALL BACK RATHER THAN FAIL. Preserving a human's comments is worth a lot;
    // it is not worth being the reason the map cannot be regenerated at all. If
    // the committed file has become unusable, say so plainly — losing the
    // comments silently is what this whole change exists to stop — and rebuild
    // it clean.
    console.error('schema-prisma: could not introspect over the existing schema — '
      + 'rebuilding it from scratch. ANY HAND-WRITTEN /// COMMENTS AND RELATION '
      + 'NAMES IN IT ARE LOST; recover them from git if they mattered.');
    fs.writeFileSync(SCHEMA, SEED);
    r = pull();
  }
  if (r.status !== 0) { console.error('schema-prisma: introspection failed'); process.exit(1); }

  // Counts come from the SAME inventory the drift check uses, so the header can
  // never quote a number the rest of the documentation disagrees with.
  const inv = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'schema', 'beyond-prisma.json'), 'utf8'));
  const c = inv.counts;
  const beyond = c.generatedColumns + c.checkConstraints + c.triggers + c.functions + c.partialIndexes;

  // DROP PILOT'S OWN MIGRATION LEDGER, for exactly the reason the inventory
  // does (see the note above `LEDGER_TABLE` in schema-inventory.js): it is
  // created by the SERVER'S BOOT PATH and not by `npm run migrate`, so whether
  // Prisma finds it depends on how the database came to be. Left in, this file
  // and `beyond-prisma.json` — sitting in the same folder, describing the same
  // database — disagree about how many tables there are, and this file's own
  // header (which takes its counts from that inventory) contradicts its own
  // contents.
  let body = injectGlossary(stripLedgerModel(fs.readFileSync(SCHEMA, 'utf8')), GLOSSARY);
  fs.writeFileSync(SCHEMA, header({ beyond, tables: c.tables, columns: c.columns }) + body);

  console.log(`schema-prisma: wrote ${path.relative(process.cwd(), SCHEMA)} `
    + `(${(body.match(/^model /gm) || []).length} models)`);
}

if (require.main === module) main();

module.exports = { PRISMA_VERSION, SCHEMA, header, seedFrom, SEED, stripLedgerModel, injectGlossary };

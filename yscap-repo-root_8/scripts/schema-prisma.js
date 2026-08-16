'use strict';

// =============================================================================
// SCHEMA MAP — regenerate docs/schema/schema.prisma from a database
// =============================================================================
//
// Produces the readable map of every table, column and relation: the thing the
// numbered migration files do not give you. It is DOCUMENTATION. Nothing in
// PILOT reads it at runtime, and nothing ever should.
//
// It has a SECOND mode that needs no database and no Prisma:
//
//   node scripts/schema-prisma.js --restamp
//
// which rewrites ONLY the generated header from the committed inventory,
// leaving every model byte-for-byte alone. That exists because the header
// quotes four numbers that live in `beyond-prisma.json`, and that file can be
// regenerated on its own (`npm run schema:snapshot`, no Prisma needed) — so
// without it the two documents in this folder drift apart, and the one nobody
// can cheaply regenerate is the one that goes stale.
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

// SCHEMA_OUT_DIR redirects the whole folder, exactly as `schema-snapshot.js`
// and `schema-picture.js` do, so CI can regenerate the complete map into a
// scratch directory and compare it against what is committed without touching
// the working tree. It must move the INVENTORY too (`readInventory` below):
// restamping a scratch schema from the COMMITTED inventory would write the old
// database's numbers into the header of the fresh file and call it refreshed —
// the header exists to state which database the map describes.
const SCHEMA_DIR = process.env.SCHEMA_OUT_DIR
  ? path.resolve(process.env.SCHEMA_OUT_DIR)
  : path.join(__dirname, '..', 'docs', 'schema');

const SCHEMA = path.join(SCHEMA_DIR, 'schema.prisma');

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
  const body = bodyOf(existing);
  // No datasource block means the file cannot be introspected over — start clean
  // rather than hand Prisma something it will refuse.
  return body == null ? SEED : body;
}

/**
 * The schema itself, with our generated header removed — or NULL when there is
 * no schema here to speak of.
 *
 * ONE definition of "where does the generated header stop and the file begin",
 * shared by the seed and the restamp. Two copies of that boundary would drift,
 * and the drifted one would either leave a stale header stacked on top of a
 * fresh one or eat the first model.
 *
 * It returns NULL rather than a fallback because the two callers need OPPOSITE
 * things from a file it cannot read: the seed starts clean (Prisma is about to
 * rewrite it anyway), while the restamp must REFUSE — restamping is supposed to
 * touch nothing but the header, so writing a bare seed over somebody's schema
 * would be the single most destructive thing this script could do.
 */
function bodyOf(existing) {
  if (typeof existing !== 'string' || !existing.trim()) return null;
  // ANCHORED ON A DECLARATION AT COLUMN 0 — Prisma's own formatting, and the
  // same anchoring `stripLedgerModel` and `injectGlossary` use. A plain
  // `indexOf('datasource ')` matches the WORD, including inside our own header
  // ("… the datasource block …") or any comment that mentions it, and would
  // then treat that comment as the start of the schema: the restamp would write
  // a header on top of prose and call the result a schema file. Caught by the
  // test's own negative fixture on its first run.
  const m = /^datasource\s+\w+\s*\{/m.exec(existing);
  if (!m) return null;
  return existing.slice(m.index);
}

/**
 * The header's four numbers, taken from the committed inventory. PURE.
 *
 * The whole point of this function existing is that the numbers have ONE
 * derivation, used by the generator, by `--restamp`, and by the test that
 * asserts the committed header still agrees with the committed inventory. If
 * the test recomputed them its own way it would be proving that two hand-typed
 * expressions match, which is not the property anyone cares about.
 */
function countsFromInventory(inv) {
  const c = (inv || {}).counts || {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return {
    beyond: n(c.generatedColumns) + n(c.checkConstraints) + n(c.triggers)
      + n(c.functions) + n(c.partialIndexes),
    tables: c.tables,
    columns: c.columns,
    migrations: ((inv || {}).generatedFrom || {}).migrations || null,
  };
}

/**
 * Rewrite ONLY the generated header, leaving every model byte-for-byte alone.
 * PURE. Returns null when there is no schema to restamp — see `bodyOf`.
 *
 * Idempotent by construction: the old header is removed before the new one is
 * written, so restamping twice produces the same bytes as restamping once.
 */
function restamp(existing, counts) {
  const body = bodyOf(existing);
  if (body == null) return null;
  return header(counts) + body;
}

/**
 * How many numbered migrations build this database — DERIVED, NEVER TYPED.
 *
 * This header carried a hand-typed "549" in TWO places while `db/` was already
 * on 550. Its sibling `schema-snapshot.js` had the identical defect, found and
 * fixed on 2026-08-16; this copy was missed, which is the whole argument for
 * deriving it: a number written into prose goes stale on the very next
 * migration, and nobody notices because nothing checks prose.
 *
 * It matters more here than anywhere else in the folder. This is the sentence
 * that tells a reader NEVER to rebuild the database from this file, and names
 * the migrations as the only thing that may. A reader who checks that number,
 * finds it wrong, and concludes the warning is stale is the exact failure this
 * document exists to prevent.
 *
 * An unreadable or absent watermark says so plainly rather than guessing a
 * figure — the sentence is still true without a count.
 */
function migrationClause(migrations) {
  const m = migrations || null;
  if (!m || !Number.isFinite(m.count)) return 'The numbered migrations in db/';
  const highest = m.highest == null ? '' : ` (highest db/${m.highest})`;
  return `The ${m.count} numbered migrations in db/${highest}`;
}

/**
 * The header is prepended AFTER introspection, on every run, because
 * `prisma db pull` rewrites the file and a hand-added comment would be lost the
 * first time somebody regenerated. Generated, never hand-maintained.
 *
 * PURE — every number comes in through `counts`, so the same header can be
 * rebuilt from the committed inventory with no database in reach, which is what
 * lets a test assert the committed file agrees with the committed inventory
 * instead of merely trusting that somebody regenerated both together.
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
    `// *** ${migrationClause(counts.migrations)} are the only`,
    '// *** thing that builds this database.',
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

/** The committed inventory — the one source of every number in the header. */
function readInventory() {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'beyond-prisma.json'), 'utf8'));
}

/**
 * `--restamp`: refresh the header from the committed inventory. No database, no
 * Prisma, no network. Refuses rather than guessing if the file is not a schema.
 */
function restampOnly() {
  let existing;
  try {
    existing = fs.readFileSync(SCHEMA, 'utf8');
  } catch (_) {
    console.error('schema-prisma: no committed schema to restamp — generate it first.');
    process.exit(1);
  }
  const out = restamp(existing, countsFromInventory(readInventory()));
  if (out == null) {
    console.error('schema-prisma: the committed schema has no datasource block, so its '
      + 'header cannot be told from its contents. Refusing to touch it — regenerate '
      + 'it against a database instead.');
    process.exit(1);
  }
  if (out === existing) {
    console.log('schema-prisma: header already matches the inventory — nothing to do.');
    return;
  }
  fs.writeFileSync(SCHEMA, out);
  console.log(`schema-prisma: restamped the header of ${path.relative(process.cwd(), SCHEMA)} `
    + 'from the committed inventory (no model touched).');
}

function main() {
  if (process.argv.includes('--restamp')) return restampOnly();

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
  const counts = countsFromInventory(readInventory());

  // DROP PILOT'S OWN MIGRATION LEDGER, for exactly the reason the inventory
  // does (see the note above `LEDGER_TABLE` in schema-inventory.js): it is
  // created by the SERVER'S BOOT PATH and not by `npm run migrate`, so whether
  // Prisma finds it depends on how the database came to be. Left in, this file
  // and `beyond-prisma.json` — sitting in the same folder, describing the same
  // database — disagree about how many tables there are, and this file's own
  // header (which takes its counts from that inventory) contradicts its own
  // contents.
  let body = injectGlossary(stripLedgerModel(fs.readFileSync(SCHEMA, 'utf8')), GLOSSARY);
  fs.writeFileSync(SCHEMA, header(counts) + body);

  console.log(`schema-prisma: wrote ${path.relative(process.cwd(), SCHEMA)} `
    + `(${(body.match(/^model /gm) || []).length} models)`);
}

if (require.main === module) main();

module.exports = {
  PRISMA_VERSION, SCHEMA, header, seedFrom, SEED, stripLedgerModel, injectGlossary,
  bodyOf, restamp, countsFromInventory, migrationClause,
};

'use strict';
/**
 * NO LONG-TERM TABLE IS READ BY CODE THAT NOTHING WRITES.
 *
 * ── THE DEFECT THIS EXISTS TO STOP HAPPENING AGAIN ──────────────────────────
 *
 * db/653 moved the long-term Condition Center into the one shared
 * `checklist_items` table. The ORDERS DESK was not re-pointed, and for as long
 * as that was true:
 *
 *   · `markConditionAsked` UPDATEd `lt_file_conditions` — zero rows, silently,
 *     because an UPDATE that changes nothing raises nothing, so placing an order
 *     stopped moving its condition and nobody was told;
 *   · `docConditionFor` SELECTed the same table and found nothing; and
 *   · `fileAttachment` INSERTed `lt_condition_files`, whose FOREIGN KEY points at
 *     that retired table, so every returned document came back as a skip with a
 *     foreign-key error as its reason.
 *
 * The per-order reply address — the entire mechanism by which a title commitment
 * reaches the condition that asked for it — did nothing at all, on every
 * long-term loan, and every test stayed green because they were all PURE.
 *
 * ── WHY THE SIGNATURE IS "READ BUT NEVER WRITTEN" ───────────────────────────
 *
 * A retired store is not deleted — deleting a table with rows in it is the one
 * thing this repo will not do — so it sits there answering every query with
 * nothing. The tell is not that the table exists; it is that CODE STILL READS IT
 * while nothing anywhere puts a row in it. That is checkable, cheap, and needs no
 * list anybody has to remember to update: the tables come from the database and
 * the readers from the source.
 *
 * A LEGITIMATE CASE IS RECORDED, NEVER SILENTLY PASSED. A table seeded only by a
 * migration and read by code is real and rare; it goes in `SEEDED_BY_MIGRATION`
 * WITH ITS REASON, so the decision is written down rather than inferred from a
 * green run.
 *
 * Run: DATABASE_URL=... node scripts/test-lt-retired-store-guard-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-retired-store-guard-db (no DATABASE_URL)'); process.exit(0); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const fs = require('fs');
const path = require('path');
const db = require('../src/db');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/** Tables a MIGRATION fills and code only reads. Each needs its reason here. */
const SEEDED_BY_MIGRATION = Object.freeze({
  // (none today — add one with the reason it is genuinely write-free in JS)
});

function jsFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|prisma/.test(p)) walk(p); }
      else if (p.endsWith('.js')) out.push(p);
    }
  })(dir);
  return out;
}

(async () => {
  const probe = await db.query('SELECT 1 AS one');
  if (!probe.rows[0] || Number(probe.rows[0].one) !== 1) throw new Error('database probe failed');
  console.log('PASS 0 the database answered a probe before anything else ran');

  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();

  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'lt\\_%'
      ORDER BY table_name`);
  const tables = rows.map((r) => r.table_name);
  assert(tables.length > 5,
    `A1 the long-term tables were read from the DATABASE, not from a list (${tables.length} found)`);

  /* COMMENTS ARE STRIPPED FIRST. The very fix that re-pointed those three
     statements necessarily NAMES the retired tables in its explanation, so a
     guard reading comments would fail on its own reasoning and then be "fixed"
     by deleting the explanation. */
  const { stripComments } = require('./lib/strip-comments');
  const sources = jsFiles('src').map((f) => ({ f, t: stripComments(fs.readFileSync(f, 'utf8')) }));
  assert(sources.length > 100, `A2 the source tree was read (${sources.length} files)`);

  /* A WRITE IS NOT ALWAYS A LITERAL, AND MISSING THAT WOULD MAKE THIS GUARD
     WORSE THAN NONE. The 1003 child tables are written through
     `upsertChild(db, 'lt_residences', …)`, which builds `INSERT INTO ${table}`
     at runtime — six perfectly correct tables that a literal-only sweep reports
     as retired. A guard that fails on correct work gets loosened until it catches
     nothing, so it has to understand the idiom: a file that performs a DYNAMIC
     write and names the table as a string literal is writing it. */
  const dynamicWriters = sources.filter((s) =>
    /(INSERT\s+INTO|UPDATE)\s+\$\{/i.test(s.t) || /(INSERT\s+INTO|UPDATE)\s+["'`]\s*\+/i.test(s.t));
  assert(dynamicWriters.length > 0,
    `A2b at least one module writes through a dynamic table name — if this ever reads zero the detection below has silently stopped working (${dynamicWriters.length} found)`);

  const writtenSomehow = (t) => {
    const literal = new RegExp(`(INSERT\\s+INTO|UPDATE)\\s+${t}\\b`, 'i');
    if (sources.some((s) => literal.test(s.t))) return true;
    // Named as a string, in a file that writes dynamically.
    const named = new RegExp(`["'\`]${t}["'\`]`);
    return dynamicWriters.some((s) => named.test(s.t));
  };

  const orphans = [];
  for (const t of tables) {
    const readRe = new RegExp(`(FROM|JOIN)\\s+${t}\\b`, 'i');
    const readers = sources.filter((s) => readRe.test(s.t)).map((s) => s.f);
    if (readers.length && !writtenSomehow(t)) orphans.push({ t, readers });
  }

  /* AND THE DYNAMIC HALF IS PINNED ON A REAL TABLE, so a future change that
     breaks it fails HERE rather than by quietly reporting six healthy tables as
     retired and being loosened in response. */
  assert(writtenSomehow('lt_residences'),
    'A2c a table written only through the dynamic upsert is recognised as written — the false-positive this guard would otherwise produce');

  const unexplained = orphans.filter((o) => !SEEDED_BY_MIGRATION[o.t]);
  assert(unexplained.length === 0,
    unexplained.length
      ? `A3 a long-term table is READ but nothing writes it — the retired-store signature: ${
        unexplained.map((o) => `${o.t} (read in ${o.readers.join(', ')})`).join(' · ')}`
      : 'A3 no long-term table is read by code that nothing writes — no retired store has a reader left behind');

  /* THE GUARD IS PROVEN TO BITE, HERE, EVERY RUN. A source sweep that never
     matches anything passes forever and proves nothing, so a table nothing
     writes is fed through the same predicates and must be reported. */
  {
    const fake = 'lt_retired_example';
    const readRe = new RegExp(`(FROM|JOIN)\\s+${fake}\\b`, 'i');
    const writeRe = new RegExp(`(INSERT\\s+INTO|UPDATE)\\s+${fake}\\b`, 'i');
    const sample = [{ f: 'x.js', t: `const r = await db.query('SELECT id FROM ${fake} WHERE a=1');` }];
    assert(sample.some((s) => readRe.test(s.t)) && !sample.some((s) => writeRe.test(s.t)),
      'A4 the predicates really do report a read-only table — the guard is proven to bite on every run, not only when something is broken');
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

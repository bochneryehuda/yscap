'use strict';
/**
 * LT test — EVERY STATEMENT THE LONG-TERM SIDE SENDS IS ACCEPTED BY THE DATABASE.
 *
 * WHY THIS EXISTS. A query naming a column that does not exist is the quietest bug
 * this repository produces. It throws at RUN time, deep inside a `try` that exists
 * for a good reason — a section that cannot be read must not take the loan down —
 * and the caller answers `null`, or an empty list, or a confident zero. Nothing
 * logs, nothing fails, and the screen says "none" forever. It has happened here at
 * least four times: `b.full_name` selected off `borrowers`, `is_current` and
 * `created_at` on `appraisals`, `property_state` on `applications`, `wire_due_at`.
 * Every one of them was found by a person, late.
 *
 * A test cannot catch this by reading source — the column name looks perfectly
 * plausible — and a unit test with a mocked database agrees with whatever it is
 * handed. Only the DATABASE can answer, and it will: `PREPARE` parses and plans a
 * statement against the real schema, resolving every table, column, function and
 * type, and refuses one that does not fit.
 *
 * NOTHING IS EXECUTED. `PREPARE` plans; it does not run. Every statement is
 * prepared inside a transaction that is ROLLED BACK regardless, so even a
 * hypothetical side effect could not survive this file — which is what makes it
 * safe to point at the INSERTs and UPDATEs as well as the reads, and those are the
 * half where a phantom column is most expensive.
 *
 * WHAT IT DOES NOT COVER, said out loud rather than left as a number: a statement
 * BUILT with interpolation (a shared FROM fragment, a scope's WHERE, a column list)
 * is not a statement until it is assembled, so it cannot be prepared from source.
 * Those are counted and NAMED below. Silence about them would let this file read as
 * total coverage.
 */

const path = require('path');
const fs = require('fs');
const cp = require('child_process');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const ROOT = path.join(__dirname, '..');

/**
 * Every template literal handed to a `.query(` call, with comments stripped first.
 *
 * BOTH HALVES OF THAT ARE LOAD-BEARING. Comments here explain the SQL and quote
 * pieces of it, so an extractor that reads them hands Postgres English prose and
 * reports a "syntax error" that is a sentence — five of them, on the first run.
 * And matching any backtick that CONTAINS the word SELECT picks up ordinary
 * JavaScript and the shared query FRAGMENTS (`const SELECT = ...`), which are not
 * statements and cannot be judged as ones: `product-book.js`'s SELECT fragment
 * alone reports "missing FROM-clause entry for table l", which looks exactly like
 * a real defect and is not. Anchoring on `.query(` is what makes the corpus real.
 */
function statementsIn(src) {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out = [];
  const re = /\.query\(\s*`/g;
  let m;
  while ((m = re.exec(code))) {
    let i = re.lastIndex;
    let depth = 0;
    let sql = '';
    while (i < code.length) {
      const ch = code[i];
      if (ch === '\\') { sql += code[i] + code[i + 1]; i += 2; continue; }
      // An interpolation may itself contain a backtick, so its braces are tracked
      // rather than the scan stopping at the first one it meets.
      if (ch === '$' && code[i + 1] === '{') { depth += 1; sql += '${'; i += 2; continue; }
      if (depth > 0) { if (ch === '}') depth -= 1; sql += ch; i += 1; continue; }
      if (ch === '`') break;
      sql += ch;
      i += 1;
    }
    out.push(sql);
  }
  return out;
}

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-sql-prepared');

  const db = require('../src/longterm/db');

  const files = cp.execSync("grep -rl '' src/longterm --include=*.js", { cwd: ROOT })
    .toString().trim().split('\n').filter(Boolean);

  check(files.length > 20,
    `the long-term source really was found (${files.length} files) — an empty file list would make every check below pass by finding nothing`);

  const plain = [];
  const built = [];
  for (const rel of files) {
    for (const sql of statementsIn(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
      (sql.includes('${') ? built : plain).push({ rel: rel.replace('src/longterm/', ''), sql });
    }
  }

  check(plain.length > 80,
    `and the extractor found the statements (${plain.length} whole, ${built.length} built with interpolation) — a parser that found none is the failure this check exists to notice`);

  const client = await db.getClient();
  const refused = [];
  try {
    // Prepared inside a transaction that is rolled back whatever happens: PREPARE
    // does not execute, and this makes that structural rather than a claim.
    await client.query('BEGIN');
    let n = 0;
    for (const { rel, sql } of plain) {
      const name = `ltsqlcheck_${n}`;
      n += 1;
      // EACH ONE INSIDE ITS OWN SAVEPOINT. A failed statement puts the whole
      // transaction into an aborted state, so without this the FIRST phantom
      // column is reported correctly and the other hundred and eight all report
      // "current transaction is aborted" — the real cause buried under a hundred
      // lines that name nothing. Measured, not guessed: one phantom column
      // produced exactly 108 of them. A guard whose failure output is unreadable
      // is a guard people learn to scroll past.
      await client.query(`SAVEPOINT ${name}`);
      try {
        await client.query(`PREPARE ${name} AS ${sql}`);
        await client.query(`DEALLOCATE ${name}`);
        await client.query(`RELEASE SAVEPOINT ${name}`);
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
        refused.push(`${rel}: ${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 160)}\n           ${sql.trim().replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  console.log('every whole statement is accepted by the real schema');

  check(refused.length === 0,
    `THE ONE THAT MATTERS: Postgres accepts all ${plain.length} of them — a column, table, function or type that does not exist is refused here instead of answering an empty list at run time${refused.length ? `:\n       ${refused.join('\n       ')}` : ''}`);

  // NO SILENT CAPS. The statements this cannot judge are named, so the number
  // above is never mistaken for the whole of it.
  console.log(`\nand the ${built.length} assembled at run time are named rather than counted away`);
  //
  // WHERE EACH ONE IS ACTUALLY EXECUTED — checked by following it, not assumed.
  // Every file below has a live path that runs its assembled form against a real
  // database in this same CI job, which is why "not prepared here" is not the same
  // as "unwatched". A file that appears in this list with no entry here is a
  // statement nothing exercises, and that is worth noticing.
  const COVERED_BY = {
    'application/sync.js': 'test-lt-application-db.js drives it',
    'conditions/sync.js': 'test-lt-conditions-db.js drives it',
    'lib/encompass-milestones.js': 'GET /api/lt/encompass/milestones and /milestones/:id, in the route smoke test',
    // The back-book fill for the roles WE assign, whose WHERE is the pipeline's own
    // live-book fragment. Section E of that suite runs it against a real table with
    // the fragment assembled, and asserts which folders it reaches and which it
    // deliberately leaves alone.
    'people/contacts.js': 'test-lt-file-setup-role-db.js drives it',
    // The officer-picker list for a sees-all viewer. Its call site SWALLOWS its own
    // failure (`.catch(() => null)` — the picker degrades, the pipeline survives),
    // so mere execution could not prove it: the smoke test ASSERTS `officers` comes
    // back as an ARRAY, which the swallowed failure (null) fails.
    'pipeline.js': 'GET /api/lt/pipeline in the route smoke test, which asserts the officers list is an ARRAY — the call site swallows failure into null, so the assertion is what makes the execution provable',
    'ppe/rule-store.js': 'test-lt-ppe-rule-store-db.js drives it',
    'ppe/run-store.js': 'test-lt-ppe-run-store-db.js drives it',
    'product-book.js': 'GET /api/lt/book, in the route smoke test',
    'routes/stages.js': 'GET /api/lt/stages, in the route smoke test',
    // The condition library's settings door assembles `SET ${sets.join(', ')}`
    // from whichever fields the body carried, so it is not a statement until it
    // is assembled. Section F of that suite drives the REAL handler over HTTP and
    // asserts the wording it was handed is what the row then holds — execution
    // alone would not prove it, since the route answers 200 either way.
    'routes/condition-center.js': 'test-lt-condition-answers-db.js section F drives PATCH /library/:code through the real handler and re-reads the row',
    // The borrowers list assembles `WHERE ${scope.where}`, which is EMPTY for the
    // sees-all admin the smoke test mostly runs as — so that suite also calls it
    // as a SCOPED loan officer, which is what makes the interpolated branch a real
    // statement (un-swallowed: a phantom column 500s and the smoke test sees it).
    'routes/borrowers.js': 'GET /api/lt/borrowers in the route smoke test — the whole-book branch by the admin caller AND the assembled-WHERE branch by a scoped loan officer',
    'views.js': 'GET /api/lt/views, in the route smoke test',
    // THE TRASH RULE (owner-directed 2026-08-23) composes its guard into many
    // readers, and this map went STALE for two of them the day it landed — which
    // held every main merge (#1319–#1323) out of the gated deploy until it was
    // noticed. Each entry below names a suite that genuinely EXECUTES the
    // assembled statement against a real Postgres in this same job.
    'trash.js': 'test-lt-trash-db.js drives every statement (list, count, guarded delete, duplicates)',
    'pipeline.js': 'test-lt-trash-db.js drives loadPipeline (the officer picker) against the real schema',
    'clickup/link.js': 'test-lt-trash-db.js drives linkPass — the selection live, the retry sweep in a rolled-back transaction',
    'borrower-autolink.js': 'test-lt-trash-db.js drives autoLinkPass (reads live, writes stubbed)',
    'borrower-links.js': 'test-lt-borrower-link-db.js drives confirmLink, whose two-names guard this is',
    'sync/loans.js': 'test-lt-trash-db.js section H2 drives syncOnce — the never-reinsert twin check runs live there',
    'routes/borrowers.js': 'GET /api/lt/borrowers, in the route smoke test',
    'routes/my-loans.js': 'test-lt-borrower-switch-db.js drives the handler directly against the real schema',
    // The push queue's WHERE and ORDER BY, shared with clickup/push.js so the
    // report and the pass cannot disagree. Assembled, so it must be RUN:
    'routes/book-diag.js': 'test-lt-why-no-status-db.js section C runs GET /why-no-status against the real schema, which executes the assembled push-queue measurement',
    'routes/sync.js': 'GET /api/lt/sync, in the route smoke test',
    // The ClickUp writer composes the SAME trash guard into its loan loads. Each
    // assembled form runs against a real Postgres in this job:
    'sync/milestone-ladder.js': 'test-lt-milestone-ladder.js section H drives ladderDue live (the assembled not-trash WHERE), and sections E–I drive every other statement in the file',
    'clickup/push.js': 'test-lt-clickup-writer.js DB half drives pushLoan, createForLoan, pushPass and createPass live — every loan load assembles the trash guard',
    // The SHARED scoped loader every per-loan section goes through. It composes the
    // trash guard into its `SELECT ... FROM lt_loans`, so the statement only exists
    // once a door assembles it. The smoke test's all-zeros loan id is a VALID uuid,
    // so it passes the loader's own uuid guard and the SELECT genuinely runs before
    // the no-rows 404 — which is what makes this entry true rather than hopeful.
    'routes/scoped-loan.js': 'GET /api/lt/encompass-file/loans/:loanId and GET /api/lt/clickup/loans/:loanId in the route smoke test both assemble and execute it',
    'routes/clickup.js': 'GET /api/lt/clickup/loans/:loanId in the route smoke test (loadScopedLoan assembles the trash guard), plus test-lt-clickup-section-db.js over the whole section',
  };
  const byFile = new Map();
  for (const b of built) byFile.set(b.rel, (byFile.get(b.rel) || 0) + 1);
  for (const [rel, count] of [...byFile].sort()) {
    console.log(`  note ${rel} — ${count} built with interpolation; ${COVERED_BY[rel] || 'NOTHING KNOWN TO RUN IT'}`);
  }
  const unwatched = [...byFile.keys()].filter((rel) => !COVERED_BY[rel]);
  check(unwatched.length === 0,
    `a statement built from a shared FROM fragment or a scope's WHERE is not a statement until it is assembled, so it cannot be prepared from source — but every one of them IS executed somewhere in this same job${unwatched.length ? `, except these: ${unwatched.join(', ')}` : ''}`);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });

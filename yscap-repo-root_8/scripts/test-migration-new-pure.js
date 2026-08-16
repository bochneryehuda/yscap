'use strict';

// =============================================================================
// PROOF that the migration scaffolder hands out a number that is actually free,
// and a template the hygiene gate accepts.
// =============================================================================
//
// This tool's whole job is to be trusted. That makes its failure mode specific
// and nasty: a number handed out with a tool's authority is one NOBODY
// double-checks, so a wrong answer here is worse than no tool at all. Two of
// the assertions below exist because exactly that happened while it was being
// written, and both were CONFIDENT wrong answers rather than errors:
//
//   • the git pathspec was resolved relative to db/ rather than the repository
//     root, so the cross-branch scan matched nothing while cheerfully
//     reporting "2,791 commit(s) across every ref" — the scan appeared to run,
//     found zero numbers, and the tool would have handed out a number another
//     branch already held. That is the precise collision it exists to prevent.
//
//   • `--number`'s value was skipped by index, and with no `--number` present
//     that index was 0 — which silently ate the first word of every title.
//
// Neither produced an error. Both are pinned here.
//
// PURE: every input is passed in. The one place that touches the filesystem
// builds its own temporary directory, and the one place that runs the REAL
// hygiene gate copies it into a sandbox rather than writing into db/ — a
// crashed test must never be able to leave a stray file in db/, because every
// file in db/ is replayed on every boot.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  migrationNumber, usedNumbers, nextFree, pad, slugify, renderTemplate, scanGit, main,
} = require('./migration-new.js');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, what); checks++; };

// ── 1. reading a number off a filename ──────────────────────────────────────

eq(migrationNumber('553_lt_pipeline_foundation.sql'), 553, 'plain numbered migration');
eq(migrationNumber('002_backend.sql'), 2, 'zero-padded number is decimal, not octal');
eq(migrationNumber('yscap-repo-root_8/db/553_x.sql'), 553, 'a path is accepted, not just a basename');
eq(migrationNumber('1000_future.sql'), 1000, 'four digits');
eq(migrationNumber('schema.sql'), null, 'the unnumbered base schema is not a migration');
eq(migrationNumber('README.md'), null, 'not a .sql file');
eq(migrationNumber('553_x.sql.bak'), null, 'must END in .sql');
eq(migrationNumber('abc_x.sql'), null, 'non-numeric prefix');
eq(migrationNumber('553.sql'), null, 'a number with no underscore is not the convention');
eq(migrationNumber(''), null, 'empty');
eq(migrationNumber(null), null, 'null does not throw');
eq(migrationNumber(undefined), null, 'undefined does not throw');

// ── 2. the used set ─────────────────────────────────────────────────────────

{
  const u = usedNumbers(['001_a.sql', '002_b.sql', '002_c.sql', 'schema.sql', null]);
  eq(u.size, 2, 'duplicates collapse and junk is ignored');
  ok(u.has(1) && u.has(2), 'both real numbers present');
  eq(usedNumbers([]).size, 0, 'empty list');
  eq(usedNumbers(null).size, 0, 'null list does not throw');
}

// ── 3. the next number — and the property that matters most ─────────────────

eq(nextFree(new Set([1, 2, 3])), 4, 'one past the highest');
eq(nextFree(new Set()), 1, 'a repository with no migrations starts at 1');
eq(nextFree(new Set([553])), 554, 'single');

// NEVER FILL A GAP. A gap exists because a number was abandoned or renumbered,
// which usually means another branch still carries a file with it. A tool that
// filled gaps would aim itself directly at the collisions it exists to prevent.
// (Measured on this repo: 165 and 167 are exactly such numbers.)
eq(nextFree(new Set([1, 2, 5])), 6, 'the gap at 3 and 4 is NOT reused');
eq(nextFree(new Set([165, 167, 553])), 554, 'real-world gaps are skipped, not filled');

// Order of insertion must not matter.
eq(nextFree(new Set([553, 1, 200])), 554, 'unsorted input');

// ── 4. padding ──────────────────────────────────────────────────────────────

eq(pad(1), '001', 'pads to three');
eq(pad(42), '042', 'pads to three');
eq(pad(553), '553', 'already three');
eq(pad(1000), '1000', 'NOT truncated past three — db/1000 must stay 1000');
eq(pad(12345), '12345', 'no upper clamp');

// ── 5. slugs ────────────────────────────────────────────────────────────────

eq(slugify('add the credit waiver table'), 'add_the_credit_waiver_table', 'spaces to underscores');
eq(slugify('Add The Credit Waiver'), 'add_the_credit_waiver', 'lowercased');
eq(slugify("the borrower's name"), 'the_borrowers_name', 'apostrophe is dropped, not turned into a separator');
eq(slugify('the borrower’s name'), 'the_borrowers_name', 'curly apostrophe too');
eq(slugify('  padded  '), 'padded', 'no leading or trailing underscore');
eq(slugify('a---b'), 'a_b', 'runs of punctuation collapse to one underscore');
eq(slugify('lt_loans: add lock'), 'lt_loans_add_lock', 'punctuation inside');
eq(slugify(''), '', 'empty stays empty so the caller can refuse it');
eq(slugify('!!!'), '', 'nothing usable stays empty');
eq(slugify(null), '', 'null does not throw');
ok(slugify('x'.repeat(200)).length <= 60, 'long titles are capped');
ok(!slugify('x'.repeat(59) + ' tail').endsWith('_'), 'the cap never leaves a trailing underscore');

// ── 6. the template ─────────────────────────────────────────────────────────

{
  const t = renderTemplate({ number: 554, title: 'add the credit waiver table', slug: 'x' });

  // check-migrations warns when a file's header names a DIFFERENT number than
  // its filename ("stale self-label from a renumber"). A scaffold that shipped
  // that warning on every new file would train everyone to ignore it.
  ok(t.includes('db/554 —'), 'the header self-labels with its own number');
  ok(!/db\/55[0-3]\b/.test(t), 'and names no other migration number');
  eq((t.match(/db\/554/g) || []).length, 1, 'exactly once, so a renumber has one place to fix');

  // The header is the thing the next person reads; it must demand the reasoning.
  ok(/WHAT THIS CHANGES, AND WHY/.test(t), 'asks for the why');
  ok(/BACKFILL/.test(t), 'forces an explicit backfill decision');
  ok(/PRODUCT SEPARATION/.test(t), 'names the separation rule');

  // Following check-schema-behind's advice and stopping at schema:snapshot
  // fails the header test at step 12 of the chain — so the scaffold must name
  // BOTH commands, exactly as that check now does.
  ok(t.includes('npm run schema:snapshot'), 'names schema:snapshot');
  ok(t.includes('npm run schema:restamp'), 'names schema:restamp — the half people miss');

  // A title with regex-special characters must not corrupt the template.
  const weird = renderTemplate({ number: 7, title: 'a $1 \\ b `c`', slug: 'x' });
  ok(weird.includes('db/007 — a $1 \\ b `c`'), 'special characters survive verbatim');
}

// ── 7. the REAL hygiene gate, on the generated scaffold, in a sandbox ────────
//
// Asserting "the template has no bare CREATE TABLE" by re-writing the gate's
// own regexes here would be a tautology: it would pass even if the gate's rules
// changed underneath it. So the gate itself is copied into a temporary
// directory whose db/ holds ONLY the scaffold, and run for real. Nothing is
// ever written into the repository's db/.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mignew-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.mkdirSync(path.join(tmp, 'db'));
    fs.copyFileSync(path.join(__dirname, 'check-migrations.js'), path.join(tmp, 'scripts', 'check-migrations.js'));
    fs.writeFileSync(
      path.join(tmp, 'db', '554_scaffold.sql'),
      renderTemplate({ number: 554, title: 'scaffold', slug: 'scaffold' }),
      'utf8',
    );

    let out = '';
    let code = 0;
    try {
      out = execFileSync('node', [path.join(tmp, 'scripts', 'check-migrations.js'), '--strict'],
        { encoding: 'utf8', timeout: 60000 });
    } catch (e) {
      code = e.status == null ? 1 : e.status;
      out = String(e.stdout || '') + String(e.stderr || '');
    }

    eq(code, 0, `the scaffold passes the REAL hygiene gate in --strict mode\n${out}`);
    ok(/clean/.test(out), `--strict reports clean, not merely non-fatal\n${out}`);
    ok(!/warning/i.test(out), `and raises no warnings at all\n${out}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 8. the cross-branch scan — the bug that reported success on zero results ─

{
  // The pathspec MUST be anchored to the repository root. Resolved relative to
  // db/ (where this runs) it silently matches nothing.
  let seen = null;
  scanGit((args) => {
    if (args[0] === 'log') seen = args;
    return args[0] === 'rev-list' ? '5\n' : '';
  });
  ok(seen, 'the scan issues a git log');
  const spec = seen[seen.indexOf('--') + 1];
  ok(spec.startsWith(':(top)'), `the pathspec is anchored to the repo root, not the cwd (got ${spec})`);
  ok(seen.includes('--all'), 'every ref is searched, not just HEAD');
  ok(seen.includes('--diff-filter=A'), 'only ADDED files — a number is claimed when the file is created');

  // A git failure must be REPORTED, never silently degraded into "no numbers
  // are claimed elsewhere", which reads identically to a clean scan.
  const broken = scanGit(() => { throw new Error('not a git repository'); });
  eq(broken.ok, false, 'a git failure is reported as a failure');
  ok(/not a git repository/.test(broken.reason), 'and carries the reason');
  eq(broken.files.length, 0, 'with no files');

  // A working scan parses filenames out of the log.
  const good = scanGit((args) => (args[0] === 'rev-list' ? '9\n'
    : 'yscap-repo-root_8/db/165_a.sql\n\nyscap-repo-root_8/db/167_b.sql\n'));
  eq(good.ok, true, 'a working scan reports ok');
  eq(good.refs, 9, 'and the commit count it searched');
  eq(usedNumbers(good.files).size, 2, 'and yields the numbers those files claim');
}

// ── 9. the CLI — the title-parsing bug ──────────────────────────────────────

{
  const say = console.log; const cry = console.error; const warnFn = console.warn;
  const run = (argv) => {
    const lines = [];
    console.log = console.error = console.warn = (...a) => lines.push(a.join(' '));
    try { return { code: main(['node', 'migration-new.js', ...argv]), out: lines.join('\n') }; }
    finally { console.log = say; console.error = cry; console.warn = warnFn; }
  };

  // WITHOUT --number. This is the case that was broken: the first word was
  // eaten, and a one-word title became no title at all.
  let r = run(['add the credit waiver table', '--dry-run']);
  eq(r.code, 0, 'a plain title is accepted');
  ok(/add_the_credit_waiver_table\.sql/.test(r.out), `the WHOLE title reaches the filename\n${r.out}`);

  r = run(['borrowers', '--dry-run']);
  eq(r.code, 0, 'a single-word title is accepted — the exact case that failed');
  ok(/_borrowers\.sql/.test(r.out), `and survives\n${r.out}`);

  // WITH --number, the value must still be dropped from the title.
  r = run(['add locks', '--number', '900', '--dry-run']);
  eq(r.code, 0, 'explicit free number accepted');
  ok(/900_add_locks\.sql/.test(r.out), `the number is used and is not part of the title\n${r.out}`);
  ok(!/900_900/.test(r.out) && !/add_locks_900|900_add_locks_900/.test(r.out), 'the value is not duplicated into the slug');

  // Refusals.
  eq(run(['--dry-run']).code, 1, 'no title is refused');
  eq(run(['!!!', '--dry-run']).code, 1, 'a title with nothing usable is refused');
  r = run(['x', '--number', '553', '--dry-run']);
  eq(r.code, 1, 'a number already claimed in db/ is refused');
  ok(/already claimed/.test(r.out), 'and says so');

  // A dry run writes nothing.
  const before = fs.readdirSync(path.join(__dirname, '..', 'db')).length;
  run(['some new thing', '--dry-run']);
  eq(fs.readdirSync(path.join(__dirname, '..', 'db')).length, before, 'a dry run creates no file');

  // The blind spot must be stated on every successful run.
  r = run(['another thing', '--dry-run']);
  ok(/never been pushed|not fetched/.test(r.out),
    `the output admits what it cannot see\n${r.out}`);
}

console.log(`test-migration-new-pure: ${checks} assertions passed.`);

'use strict';

// =============================================================================
// PROOF that the schema-map auto-refresh can only ever do the one thing it is
// for — and that when it cannot, it says so instead of going quiet.
// =============================================================================
//
// This is the guard on a job that holds `contents: write`. Everything below is
// one of the five things `docs/SCHEMA-MAP-AUTO-REFRESH-RESEARCH.md` said had to
// be proven to FAIL before any of it shipped:
//
//   1. a commit touching anything outside docs/schema/ is REFUSED;
//   2. a losing race changes NOTHING and falls back to the artifact — no force,
//      ever, under any circumstance;
//   3. a broken refresh is distinguishable from having nothing to do;
//   4. the deploy job cannot fire for a map commit — asserted against the REAL
//      workflow file, not a description of it;
//   5. regenerating twice from the same input produces identical bytes.
//
// (5) is the assumption the entire design rests on: the refresh is only safe to
// automate, and last-writer-wins is only CORRECT rather than merely tolerable,
// because the map is a pure function of the migrations. It had never been
// asserted anywhere.
//
// PURE: the git calls, the filesystem and the console are all injected, so the
// whole commit path runs with no repository, no network and no side effects.
// The one place that touches disk builds its own temporary directory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  MAP_DIR, MAP_FILES, pathAllowed, decideCommit, classifyPushError, commitMessage,
  changedFiles, main,
} = require('./ci-schema-commit.js');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, what); checks++; };

// ── 1. it may only ever commit the generated schema map ─────────────────────

for (const f of MAP_FILES) {
  ok(pathAllowed(`${MAP_DIR}/${f}`), `the generated file ${f} is allowed`);
}

ok(!pathAllowed(`${MAP_DIR}/README.md`), 'README.md is HAND WRITTEN — never committed by the bot');
ok(!pathAllowed(`${MAP_DIR}/something-new.json`), 'a new file in that folder is refused until somebody decides it belongs');
ok(!pathAllowed('yscap-repo-root_8/db/554_x.sql'), 'a migration is refused');
ok(!pathAllowed('yscap-repo-root_8/src/server.js'), 'product code is refused');
ok(!pathAllowed('yscap-repo-root_8/package.json'), 'the build file is refused');
ok(!pathAllowed('.github/workflows/test.yml'), 'the workflow itself is refused');
ok(!pathAllowed(`${MAP_DIR}/../../src/server.js`), 'a traversal out of the folder is refused');
ok(!pathAllowed(`${MAP_DIR}/sub/beyond-prisma.json`), 'a nested copy of a real name is refused');
ok(!pathAllowed('docs/schema/beyond-prisma.json'), 'the path must be repo-root relative, not project relative');
ok(!pathAllowed(''), 'empty');
ok(!pathAllowed(null), 'null does not throw');

{
  const clean = MAP_FILES.map((f) => `${MAP_DIR}/${f}`);
  eq(decideCommit(clean).ok, true, 'the whole generated set is committable');

  // THE ONE THAT MATTERS: one stray path poisons the whole commit.
  const poisoned = clean.concat(['yscap-repo-root_8/src/server.js']);
  const v = decideCommit(poisoned);
  eq(v.ok, false, 'a single path outside the map dir refuses the ENTIRE commit');
  eq(v.reason, 'outside_map_dir', 'and says why');
  ok(v.offending.includes('yscap-repo-root_8/src/server.js'), 'naming the offender');

  const readme = decideCommit([`${MAP_DIR}/README.md`]);
  eq(readme.ok, false, 'a lone README edit is refused, not silently swept along');

  // An empty set is the ORDINARY case, not a refusal — the map already matching
  // the database is what most runs look like, and it must exit quietly.
  const empty = decideCommit([]);
  eq(empty.ok, false, 'nothing staged is not a commit');
  eq(empty.reason, 'nothing_to_do', 'and is reported as nothing to do, NOT as a refusal');
  eq(decideCommit(null).reason, 'nothing_to_do', 'null does not throw');
}

// ── 2/3. a lost race is advisory; anything else is loud ─────────────────────

eq(classifyPushError('! [rejected] main -> main (non-fast-forward)'), 'non_fast_forward', 'classic rejection');
eq(classifyPushError('Updates were rejected because the remote contains work'), 'non_fast_forward', 'the common wording');
eq(classifyPushError('hint: fetch first'), 'non_fast_forward', 'the hint');
eq(classifyPushError('stale info'), 'non_fast_forward', 'a lease-style rejection is still a lost race');
eq(classifyPushError('remote: Permission to x/y.git denied to github-actions[bot]'), 'auth', 'a missing grant is NOT a lost race');
eq(classifyPushError('remote: error: GH006: Protected branch update failed'), 'auth', 'a protected branch is not a lost race');
eq(classifyPushError('fatal: Authentication failed'), 'auth', 'bad credentials');
eq(classifyPushError('could not resolve host: github.com'), 'unknown', 'a network failure is not silently a race');
eq(classifyPushError(''), 'unknown', 'empty is not a race');
eq(classifyPushError(null), 'unknown', 'null does not throw');

// ── 4a. the commit message carries the loop-breaker ─────────────────────────

{
  const msg = commitMessage(['beyond-prisma.json']);
  ok(msg.includes('[skip ci]'), 'the message carries [skip ci] even though GITHUB_TOKEN makes it redundant TODAY — it is what stands between a future token swap and a deploy on every schema commit');
  ok(/^Refresh the schema map \[skip ci\]\n/.test(msg), 'on the SUBJECT line, where a CI skip is actually read');
  ok(msg.includes('beyond-prisma.json'), 'and names what changed');
  ok(msg.includes('schema:restamp'), 'and names BOTH regeneration commands, per the check that had to start advising them');
}

// ── the commit path, end to end, with git injected ──────────────────────────

function runMain(argv, { staged, pushError, files }) {
  const calls = [];
  const out = [];
  const io = {
    repoRoot: '/repo',
    log: (...a) => out.push(['log', a.join(' ')]),
    warn: (...a) => out.push(['warn', a.join(' ')]),
    error: (...a) => out.push(['err', a.join(' ')]),
    exists: (p) => (files ? Object.prototype.hasOwnProperty.call(files, p) : false),
    read: (p) => {
      if (!files || !(p in files)) throw new Error('ENOENT');
      return Buffer.from(files[p]);
    },
    copy: (src, dst) => calls.push(['copy', src, dst]),
    git: (args) => {
      calls.push(['git', ...args]);
      if (args[0] === 'diff') return (staged || []).join('\n');
      if (args[0] === 'push' && pushError) {
        const e = new Error('push failed');
        e.stderr = pushError;
        throw e;
      }
      return '';
    },
  };
  const code = main(['node', 'ci-schema-commit.js', ...argv], io);
  return { code, calls, out: out.map((x) => x[1]).join('\n'), kinds: out };
}

const SRC = '/tmp/refresh';
const DST = `/repo/${MAP_DIR}`;
const differing = {
  [`${SRC}/beyond-prisma.json`]: '{"new":true}',
  [`${DST}/beyond-prisma.json`]: '{"old":true}',
};
const identical = {
  [`${SRC}/beyond-prisma.json`]: '{"same":true}',
  [`${DST}/beyond-prisma.json`]: '{"same":true}',
};

{
  // NOTHING TO DO — the ordinary run. Quiet, and it never even stages.
  const r = runMain(['--from', SRC, '--branch', 'feature'], { staged: [], files: identical });
  eq(r.code, 0, 'an up-to-date map exits 0');
  ok(!r.calls.some((c) => c[0] === 'git'), 'and does not touch git at all');
  ok(!r.calls.some((c) => c[0] === 'copy'), 'and copies nothing');
  ok(/already matches/.test(r.out), 'and says so plainly');
}

{
  // THE HAPPY PATH.
  const r = runMain(['--from', SRC, '--branch', 'feature'], {
    staged: [`${MAP_DIR}/beyond-prisma.json`], files: differing,
  });
  eq(r.code, 0, 'a real refresh commits and pushes');
  const push = r.calls.find((c) => c[0] === 'git' && c[1] === 'push');
  ok(push, 'it pushes');
  eq(push[3], 'HEAD:feature', 'to the PR branch it was given');

  // NEVER FORCE — the property that makes writing to somebody else's branch safe.
  const flat = JSON.stringify(r.calls);
  ok(!/--force/.test(flat), 'NO --force anywhere');
  ok(!/force-with-lease/.test(flat), 'NO --force-with-lease either — a lease still overwrites');
  ok(!r.calls.some((c) => c[0] === 'git' && c.includes('-f')), 'no -f');

  const commit = r.calls.find((c) => c[0] === 'git' && c.includes('commit'));
  ok(commit && commit.join(' ').includes('[skip ci]'), 'the commit carries the marker');
}

{
  // (1) THE REFUSAL, through the real entry point.
  const r = runMain(['--from', SRC, '--branch', 'feature'], {
    staged: [`${MAP_DIR}/beyond-prisma.json`, 'yscap-repo-root_8/src/server.js'], files: differing,
  });
  eq(r.code, 1, 'a stray staged path FAILS the job');
  ok(!r.calls.some((c) => c[0] === 'git' && c.includes('commit')), 'and never commits');
  ok(!r.calls.some((c) => c[0] === 'git' && c[1] === 'push'), 'and never pushes');
  ok(/::error::/.test(r.out), 'and is loud');
  ok(/src\/server\.js/.test(r.out), 'and names the offending path');
  ok(r.calls.some((c) => c[0] === 'git' && c[1] === 'reset'), 'and unstages what it staged');
}

{
  // (2) THE LOST RACE — advisory, changes nothing, points at the artifact.
  const r = runMain(['--from', SRC, '--branch', 'feature'], {
    staged: [`${MAP_DIR}/beyond-prisma.json`],
    files: differing,
    pushError: '! [rejected] feature -> feature (non-fast-forward)',
  });
  eq(r.code, 0, 'losing a race does NOT fail the build');
  ok(/::warning::/.test(r.out), 'it warns');
  ok(!/::error::/.test(r.out), 'but does not error');
  ok(/artifact/.test(r.out), 'and points at the artifact, which is the fallback');
  ok(/next run will try again/.test(r.out), 'and says it self-heals');
  ok(!/--force/.test(JSON.stringify(r.calls)), 'and STILL does not force after losing');
}

{
  // (3) A BROKEN PUSH IS NOT A LOST RACE. This is the distinction the advisory
  // step this replaces got wrong once already.
  const r = runMain(['--from', SRC, '--branch', 'feature'], {
    staged: [`${MAP_DIR}/beyond-prisma.json`],
    files: differing,
    pushError: 'remote: Permission to bochneryehuda/yscap.git denied to github-actions[bot]',
  });
  eq(r.code, 1, 'a permission failure FAILS, loudly');
  ok(/::error::/.test(r.out), 'with an error annotation');
  ok(/will keep failing silently/.test(r.out), 'and names the failure mode it is protecting against');
}

{
  // A dry run proves the guard without writing anything.
  const r = runMain(['--from', SRC, '--branch', 'feature', '--dry-run'], {
    staged: [`${MAP_DIR}/beyond-prisma.json`], files: differing,
  });
  eq(r.code, 0, 'dry run succeeds');
  ok(!r.calls.some((c) => c[0] === 'git' && c.includes('commit')), 'and commits nothing');
  ok(!r.calls.some((c) => c[0] === 'git' && c[1] === 'push'), 'and pushes nothing');

  eq(runMain(['--from', SRC], { staged: [], files: identical }).code, 1, 'a missing --branch is refused');
  eq(runMain(['--branch', 'x'], { staged: [], files: identical }).code, 1, 'a missing --from is refused');
}

{
  // changedFiles only ever reports files that are actually different, and never
  // invents one that was not regenerated.
  const io = {
    exists: (p) => p.includes('beyond-prisma.json'),
    read: (p) => Buffer.from(p.startsWith(SRC) ? 'new' : 'old'),
  };
  const c = changedFiles(SRC, '/repo', io);
  eq(c.length, 1, 'only the file that exists in BOTH places and differs');
  eq(c[0], 'beyond-prisma.json', 'named');

  const same = changedFiles(SRC, '/repo', {
    exists: () => true, read: () => Buffer.from('identical'),
  });
  eq(same.length, 0, 'identical bytes are not a change');
}

// ── 4b. the REAL workflow, read off disk ────────────────────────────────────
//
// Asserting these against a description of the workflow would prove nothing —
// the file is what GitHub runs.
{
  const wf = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'test.yml'), 'utf8');
  // The block runs until the next job, the next banner comment, or the END OF
  // FILE — `deploy` is the last job, so without that third alternative it
  // matched nothing and every assertion about it silently had no subject.
  const jobBlock = (name) => {
    const m = new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^  # ---|(?![\\s\\S]))`, 'm',
    ).exec(wf);
    return m ? m[1] : '';
  };
  // Prove the extractor found real content before trusting anything it says —
  // an empty block would make every "must not contain" assertion below pass.
  for (const j of ['test', 'test-db', 'schema-push', 'deploy']) {
    ok(jobBlock(j).length > 50, `the ${j} job block was actually extracted (${jobBlock(j).length} chars)`);
  }

  // COMMENTS ARE STRIPPED BEFORE EVERY "MUST NOT APPEAR" TEST. The code that
  // removes a thing necessarily NAMES it in the comment explaining why — the
  // test-db block says in words that it holds no `permissions:` block — so a
  // guard that read comments would fail on the very fix it protects, and then
  // get "fixed" by deleting the explanation. Same rule as the public-screens
  // guard in `test-auth-screens-pure.js`.
  const code = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  const push = jobBlock('schema-push');
  ok(push, 'the schema-push job exists');
  ok(/permissions:\s*\n\s*contents: write/.test(push), 'it holds contents: write');
  ok(/github\.event_name == 'pull_request'/.test(push), 'it runs ONLY on a pull request — never on a push to main, so it can never commit to the branch deploy watches');
  ok(/head\.repo\.full_name == github\.repository/.test(push), 'and never on a fork, whose branch is not ours to write to');
  ok(/needs\.test-db\.outputs\.schema_stale == 'true'/.test(push), 'and only when the map is actually stale');
  ok(/ci-schema-commit\.js/.test(push), 'it runs the guarded script');
  ok(!/npm test|npm run test/.test(code(push)), 'and does NOT run the test suite — the write grant must not sit beside repository-controlled code');

  const deploy = jobBlock('deploy');
  ok(deploy, 'the deploy job exists');
  ok(/needs: \[test, test-db\]/.test(deploy), 'deploy still gates on both test jobs');
  ok(!/schema-push/.test(code(deploy)), 'deploy does not depend on the push job, so a refresh can never gate a release');
  ok(/github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/.test(deploy), 'deploy fires only for a push to main');

  const db = jobBlock('test-db');
  ok(/schema_stale: \$\{\{ steps\.schema_map\.outputs\.stale \}\}/.test(db), 'test-db publishes the staleness');
  ok(!/permissions:/.test(code(db)), 'and test-db STILL holds no write grant of any kind');
  ok(!/permissions:/.test(code(jobBlock('test'))), 'nor does the pure test job');

  // Workflow-level permissions would hand the grant to EVERY job, which is the
  // opposite of the whole arrangement.
  ok(!/^permissions:/m.test(code(wf)), 'no workflow-level permissions block');
  eq((code(wf).match(/contents: write/g) || []).length, 1, 'exactly ONE job in the whole workflow can write');

  // The refresh must regenerate the WHOLE map, or it commits a set that
  // disagrees with itself.
  ok(/SCHEMA_OUT_DIR=\/tmp\/schema-refresh node scripts\/schema-snapshot\.js/.test(wf), 'the inventory is regenerated');
  ok(/SCHEMA_OUT_DIR=\/tmp\/schema-refresh node scripts\/schema-picture\.js/.test(wf), 'the picture is regenerated');
  ok(/SCHEMA_OUT_DIR=\/tmp\/schema-refresh node scripts\/schema-prisma\.js --restamp/.test(wf), 'the header is restamped');
}

// ── 5. the purity the whole design rests on ─────────────────────────────────
//
// Last-writer-wins is only CORRECT — rather than merely tolerable — because the
// map is a pure function of its input. If two runs over the same input could
// differ, every one of these guards would be protecting a race that still
// corrupts the file. It had never been asserted.
//
// The DB-free half is proven here for real: same inventory in, twice, into two
// separate directories, byte-for-byte compared. The inventory step itself needs
// a live database and is proven in `test-schema-snapshot-db.js`.
{
  const src = path.join(__dirname, '..', 'docs', 'schema');
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `schema-pure-${i}-`));
    fs.copyFileSync(path.join(src, 'beyond-prisma.json'), path.join(dir, 'beyond-prisma.json'));
    fs.copyFileSync(path.join(src, 'schema.prisma'), path.join(dir, 'schema.prisma'));
    const env = { ...process.env, SCHEMA_OUT_DIR: dir };
    execFileSync('node', [path.join(__dirname, 'schema-picture.js')], { env, timeout: 120000, stdio: 'ignore' });
    execFileSync('node', [path.join(__dirname, 'schema-prisma.js'), '--restamp'], { env, timeout: 120000, stdio: 'ignore' });
    runs.push(dir);
  }
  try {
    for (const name of ['PICTURE.html', 'schema.prisma']) {
      const a = fs.readFileSync(path.join(runs[0], name));
      const b = fs.readFileSync(path.join(runs[1], name));
      ok(a.equals(b), `${name} is byte-identical across two runs over the same inventory`);
      ok(a.length > 0, `${name} is not empty (two empty files are also "identical")`);
    }
    // And the generators must not have written into the repository while doing it.
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'docs/schema'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
    eq(dirty, '', 'a SCHEMA_OUT_DIR run leaves the committed map untouched');
  } finally {
    for (const d of runs) fs.rmSync(d, { recursive: true, force: true });
  }
}

// ── 6. the instructions cannot name a command that does not exist ───────────
//
// CLAUDE.md and AGENTS.md now tell every agent which commands to run. A
// document naming a command that was renamed or removed is worse than no
// document: it is followed confidently and fails, and nothing anywhere would
// have noticed. So the docs' own claims are asserted against package.json.
{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const claude = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  const agents = fs.readFileSync(path.join(__dirname, '..', '..', 'AGENTS.md'), 'utf8');

  for (const key of ['migration:new', 'schema:snapshot', 'schema:restamp', 'schema:picture']) {
    ok(key in pkg.scripts, `the documented command "npm run ${key}" actually exists`);
  }

  for (const [name, doc] of [['CLAUDE.md', claude], ['AGENTS.md', agents]]) {
    ok(/npm run migration:new/.test(doc), `${name} tells agents to ask for a migration number`);
    // The one-command advice is the mistake that broke a build; both documents
    // must name the SECOND command too.
    ok(/npm run schema:restamp/.test(doc), `${name} names schema:restamp, not just schema:snapshot`);
    ok(/never force|never force-push|NEVER force/i.test(doc), `${name} states that the refresh never force-pushes`);
    ok(/contents: write/.test(doc), `${name} warns about where the write permission may live`);
  }

  // Every script the docs point at must be a real file.
  for (const f of ['ci-schema-commit.js', 'migration-new.js', 'check-migrations.js', 'check-schema-behind.js']) {
    ok(fs.existsSync(path.join(__dirname, f)), `the documented script ${f} exists`);
  }
}

console.log(`test-ci-schema-commit-pure: ${checks} assertions passed.`);

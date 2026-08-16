#!/usr/bin/env node
'use strict';

/**
 * Put the refreshed schema map back on the pull request that made it stale.
 *
 * WHY HERE AND NOT ON MAIN. The map is a pure function of `db/*.sql`, and every
 * migration reaches main through a pull request (measured: 98 of the last 100
 * commits are squash merges). So the change that invalidates the map is sitting
 * in a branch with CI attached to it BEFORE anything is on main — which is the
 * cheapest place to fix it, and it is upstream of every problem a trunk-writing
 * bot has to solve. Main is then never stale, so no bot needs to write to it.
 * The full reasoning, and what Kubernetes / Azure / SLSA actually do, is in
 * `docs/SCHEMA-MAP-AUTO-REFRESH-RESEARCH.md`.
 *
 * FOUR RULES, EACH OF WHICH IS THE WHOLE POINT OF SOMETHING:
 *
 *   1. IT MAY ONLY EVER COMMIT `docs/schema/`. Not "it is written so that it
 *      only touches those files" — it stages, then READS BACK what git actually
 *      staged, and refuses if a single path lies outside. The generated files
 *      are named individually, so a new file appearing in that folder is also
 *      refused rather than swept along.
 *
 *   2. IT NEVER FORCES. A push that loses a race changes NOTHING and degrades
 *      to exactly today's behaviour (the refreshed copy is already attached to
 *      the run as an artifact). This is what makes it safe to write to a branch
 *      an agent may be pushing to at the same moment — the objection that made
 *      the previous design refuse to commit back at all. A non-fast-forward is
 *      a normal outcome here, not an error.
 *
 *   3. A BROKEN PUSH IS LOUD. "The branch moved" and "the credential is wrong"
 *      are different events and must never look alike: the first is advisory,
 *      the second FAILS. A refresh that quietly stops working looks identical
 *      to one that had nothing to do, which is the exact defect this repo
 *      already found once in the advisory step this replaces.
 *
 *   4. `[skip ci]` IS IN THE MESSAGE EVEN THOUGH IT IS REDUNDANT TODAY. A push
 *      made with GITHUB_TOKEN creates no workflow run at all, so nothing can
 *      loop right now. But branch protection commonly refuses GITHUB_TOKEN, and
 *      the usual fix — a GitHub App token or a PAT — DOES re-trigger. The
 *      marker is what stands between that swap and a re-run of the whole suite
 *      on every schema commit.
 *
 * It is deliberately NOT run in the job that runs the test suite: that job
 * executes the most repository-controlled code in this build, and `contents:
 * write` is the permission you least want it to hold. It runs in its own job
 * whose only inputs are a checkout and an artifact.
 *
 *   node scripts/ci-schema-commit.js --from <dir> --branch <ref>
 *   node scripts/ci-schema-commit.js --from <dir> --branch <ref> --dry-run
 *
 * Exit codes: 0 = committed, or nothing to do, or the branch moved (advisory).
 *             1 = refused, or the push failed for a reason worth waking up for.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** The folder, relative to the git root. This runs from the project subfolder. */
const MAP_DIR = 'yscap-repo-root_8/docs/schema';

/**
 * The generated files, named one by one.
 *
 * NOT a directory wildcard: `README.md` lives in that folder and is HAND
 * WRITTEN, so a glob would commit somebody's edit to it under a message saying
 * the database changed. Naming them also means a file that appears there later
 * is refused by rule 1 until somebody decides it belongs.
 */
const MAP_FILES = ['beyond-prisma.json', 'BEYOND-PRISMA.md', 'PICTURE.html', 'schema.prisma'];

// ── pure core (exported; every branch asserted in the test) ─────────────────

/** Is this a path we are allowed to have staged? */
function pathAllowed(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return false;
  if (s.includes('..')) return false;                    // never a traversal
  const prefix = MAP_DIR + '/';
  if (!s.startsWith(prefix)) return false;
  const rest = s.slice(prefix.length);
  return MAP_FILES.includes(rest);                       // exact, never a glob
}

/**
 * The gate. Reads what git ACTUALLY staged and decides whether to commit.
 *
 * An EMPTY set is `nothing_to_do`, not a refusal — the map already matching the
 * database is the ordinary case and must exit quietly.
 */
function decideCommit(stagedPaths) {
  const paths = (stagedPaths || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!paths.length) return { ok: false, reason: 'nothing_to_do', offending: [] };
  const offending = paths.filter((p) => !pathAllowed(p));
  if (offending.length) return { ok: false, reason: 'outside_map_dir', offending };
  return { ok: true, reason: 'ready', offending: [] };
}

/**
 * Which kind of push failure is this?
 *
 * Only a genuinely lost race is advisory. Everything else — a missing
 * permission, a protected branch, an unreachable host — means the mechanism is
 * broken, and a broken refresh must not be mistaken for a clean one.
 */
function classifyPushError(stderr) {
  const s = String(stderr == null ? '' : stderr).toLowerCase();
  if (!s) return 'unknown';
  if (/non-fast-forward|fetch first|updates were rejected|behind its remote|stale info/.test(s)) {
    return 'non_fast_forward';
  }
  if (/permission|denied|403|401|authentication|could not read username|protected branch/.test(s)) {
    return 'auth';
  }
  return 'unknown';
}

/** The commit message. `[skip ci]` is load-bearing — see rule 4 in the header. */
function commitMessage(files) {
  const names = (files || []).slice().sort().join(', ');
  return [
    'Refresh the schema map [skip ci]',
    '',
    'The migrations on this branch changed the database this map describes, so',
    'CI regenerated it from the database those migrations build and put it back',
    'here — on the pull request that made it stale, not on main.',
    '',
    names ? `Files: ${names}` : '',
    '',
    'Generated. Do not hand-edit: `npm run schema:snapshot && npm run schema:restamp`.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n';
}

/** Which generated files actually differ between the refreshed set and the tree? */
function changedFiles(fromDir, repoRoot, io) {
  const read = (io && io.read) || ((p) => fs.readFileSync(p));
  const exists = (io && io.exists) || ((p) => fs.existsSync(p));
  const out = [];
  for (const name of MAP_FILES) {
    const src = path.join(fromDir, name);
    const dst = path.join(repoRoot, MAP_DIR, name);
    if (!exists(src)) continue;                          // not regenerated — leave it alone
    let a = null;
    let b = null;
    try { a = read(src); } catch (e) { continue; }
    try { b = exists(dst) ? read(dst) : null; } catch (e) { b = null; }
    if (b == null || !Buffer.from(a).equals(Buffer.from(b))) out.push(name);
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function main(argv, io) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fromDir = arg(args, '--from');
  const branch = arg(args, '--branch');

  const log = (io && io.log) || console.log;
  const warn = (io && io.warn) || console.warn;
  const err = (io && io.error) || console.error;
  const repoRoot = (io && io.repoRoot) || path.join(__dirname, '..', '..');
  const git = (io && io.git) || ((a, opts) => execFileSync('git', a, {
    encoding: 'utf8', cwd: repoRoot, timeout: 120000, ...(opts || {}),
  }));
  const copy = (io && io.copy) || ((src, dst) => fs.copyFileSync(src, dst));

  if (!fromDir || !branch) {
    err('ci-schema-commit: --from <dir> and --branch <ref> are both required.');
    return 1;
  }

  const changed = changedFiles(fromDir, repoRoot, io);
  if (!changed.length) {
    log('The committed schema map already matches the database these migrations build.');
    return 0;
  }

  for (const name of changed) {
    copy(path.join(fromDir, name), path.join(repoRoot, MAP_DIR, name));
  }

  // STAGE, THEN READ BACK. The decision is made on what git says is staged, not
  // on what this script believes it copied — a checkout carrying an unrelated
  // dirty file is exactly the case a "we only copied these" assumption misses.
  git(['add', '--', MAP_DIR]);
  const staged = git(['diff', '--cached', '--name-only'])
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const verdict = decideCommit(staged);
  if (!verdict.ok) {
    if (verdict.reason === 'nothing_to_do') {
      log('Nothing staged — the map is already current.');
      return 0;
    }
    err('::error::ci-schema-commit REFUSED: it may only ever commit the generated schema map, '
      + `and these paths are outside it: ${verdict.offending.join(', ')}`);
    try { git(['reset']); } catch (e) { /* leaving it staged is not worse than the refusal */ }
    return 1;
  }

  log(`Refreshed: ${changed.join(', ')}`);

  if (dryRun) {
    log('Dry run — nothing committed or pushed.');
    try { git(['reset']); } catch (e) { /* nothing to undo that matters */ }
    return 0;
  }

  git(['-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', commitMessage(changed)]);

  try {
    // NEVER --force, NEVER --force-with-lease. A lost race must change nothing.
    git(['push', 'origin', `HEAD:${branch}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderr = String((e && e.stderr) || (e && e.message) || '');
    const kind = classifyPushError(stderr);
    if (kind === 'non_fast_forward') {
      warn('::warning::The schema map was refreshed but the branch moved while this run was '
        + 'working, so it was not pushed. Nothing was changed. The refreshed copy is attached '
        + 'to this run as the "schema-map" artifact, and the next run will try again.');
      return 0;
    }
    err(`::error::The schema map refresh could not be pushed (${kind}). This is not a lost race — `
      + 'the refresh is broken and will keep failing silently until it is fixed.');
    err(stderr.trim().slice(0, 2000));
    return 1;
  }

  log(`Pushed the refreshed schema map to ${branch}.`);
  return 0;
}

module.exports = {
  MAP_DIR, MAP_FILES, pathAllowed, decideCommit, classifyPushError, commitMessage, changedFiles, main,
};

if (require.main === module) process.exit(main(process.argv));

'use strict';

// =============================================================================
// PROOF that the guarded-path notice names real files, and stays quiet
// =============================================================================
//
// Two failure modes, and the second is the one that would actually happen:
//
//   • it names a path that no longer exists — a control pointing at a file
//     somebody renamed, still printing confidently, guarding nothing;
//   • it fires too often — a notice on one change in three is wallpaper, and
//     the whole reason CODEOWNERS was rejected here was that it would have
//     covered ~30% of commits.
//
// Both are asserted. The first against the real repository, so a rename fails
// the build rather than silently disarming the notice.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { guardedHits, GUARDED } = require('./check-guarded-paths');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

// ---------------------------------------------------------------------------
// A. EVERY GUARDED PATH IS A REAL FILE
// ---------------------------------------------------------------------------
{
  const root = path.join(__dirname, '..', '..');
  const missing = GUARDED.filter((g) => !fs.existsSync(path.join(root, g.path))).map((g) => g.path);
  assert.deepStrictEqual(missing, [],
    `guarded paths that no longer exist: ${missing.join(', ')} — a notice pointing at a `
    + 'renamed file is a control that cannot act');
  checks++;
  ok(GUARDED.length > 0, 'there is something guarded at all');
}

// ---------------------------------------------------------------------------
// B. EVERY ENTRY SAYS WHY — a bare path tells a reader nothing to act on
// ---------------------------------------------------------------------------
{
  for (const g of GUARDED) {
    ok(g.why && g.why.length > 40, `"${g.path}" explains why it matters`);
  }
  const paths = GUARDED.map((g) => g.path);
  eq(new Set(paths).size, paths.length, 'no path is guarded twice');
}

// ---------------------------------------------------------------------------
// C. IT MATCHES EXACTLY, AND ONLY WHAT IT SHOULD
// ---------------------------------------------------------------------------
{
  eq(guardedHits([]).length, 0, 'an empty change list touches nothing');
  eq(guardedHits(null).length, 0, 'a missing change list is not a match');
  eq(guardedHits(['yscap-repo-root_8/src/routes/staff.js']).length, 0,
    'an ordinary file is not guarded');
  eq(guardedHits(['yscap-repo-root_8/src/lib/crypto.js']).length, 1,
    'the encryption module is guarded');
}
{
  // EXACT MATCH, NOT PREFIX. A prefix rule on `scripts/check-` would sweep in
  // every neighbouring script and put this straight back into wallpaper.
  eq(guardedHits(['yscap-repo-root_8/scripts/check-migrations.js']).length, 0,
    'a sibling script with a similar name is NOT guarded');
  eq(guardedHits(['yscap-repo-root_8/src/lib/crypto.js.bak']).length, 0,
    'a longer name that merely starts the same is not a match');
  eq(guardedHits(['yscap-repo-root_8/src/lib/crypto']).length, 0,
    'a shorter name is not a match either');
}
{
  const hits = guardedHits([
    'yscap-repo-root_8/src/routes/staff.js',
    '  yscap-repo-root_8/src/lib/crypto.js  ',
    '.github/workflows/test.yml',
  ]);
  eq(hits.length, 2, 'several guarded paths in one change are all reported');
  ok(hits.some((h) => h.path.endsWith('crypto.js')), 'whitespace around a path is trimmed');
}
{
  const twice = guardedHits(['yscap-repo-root_8/src/lib/crypto.js', 'yscap-repo-root_8/src/lib/crypto.js']);
  eq(twice.length, 1, 'a path listed twice is reported once');
}

// ---------------------------------------------------------------------------
// D. IT IS RARE — measured, not asserted
// ---------------------------------------------------------------------------
//
// The whole reason the plan's CODEOWNERS proposal was rejected is that the zone
// it named changes on ~30% of commits. If this set ever grows to that, it has
// become the thing it replaced. `src/auth/index.js` (38 of the last 200
// commits) and `src/lib/permissions.js` (18) are DELIBERATELY absent, and this
// asserts they stay absent — adding them is the obvious "improvement" that
// would quietly ruin it.
{
  const paths = new Set(GUARDED.map((g) => g.path));
  ok(!paths.has('yscap-repo-root_8/src/auth/index.js'),
    'the login module is deliberately NOT guarded — it changes on ~19% of commits');
  ok(!paths.has('yscap-repo-root_8/src/lib/permissions.js'),
    'the permissions module is deliberately NOT guarded — ~9% of commits');
  ok(!paths.has('yscap-repo-root_8/CLAUDE.md'),
    'CLAUDE.md is deliberately NOT guarded — it changes on essentially every commit');
  ok(GUARDED.length <= 14,
    'the guarded set stays small; a long list is how this becomes wallpaper');
}

console.log(`test-guarded-paths-pure: ${checks} assertions passed — every guarded path is a real `
  + `file, each says why, and the set is still small enough to mean something`);

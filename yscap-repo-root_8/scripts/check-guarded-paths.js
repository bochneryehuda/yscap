'use strict';

// =============================================================================
// GUARDED PATHS — say out loud when a change touches something load-bearing
// =============================================================================
//
// Plan §8.2 asked for CODEOWNERS on the identity zone: *"a named human on any
// change to `borrowers`, `staff_users`, the auth module and the shared editor.
// Cheap, and it is the two-person rule expressed in a tool the repo already
// has."* It was evaluated and it does not work here, for two measured reasons —
// both recorded rather than worked around:
//
//   1. CODEOWNERS NAMING THE OWNER CAN NEVER FIRE. Every pull request in this
//      repository is authored by the owner's own GitHub account, and GitHub
//      does not request a review from a pull request's author. The rule would
//      look like a control and be incapable of acting — the exact "assertion in
//      place of a proof" the build rule forbids.
//
//   2. THE ZONE THE PLAN NAMED IS NOT RARE. Measured over the last 200
//      commits: 60 of them — nearly a third — touch `src/auth/`,
//      `src/lib/permissions.js`, `src/lib/crypto.js` or the shared borrower
//      editor. A notice on one change in three is not a signal, it is
//      wallpaper, and it trains people to scroll past the one that mattered.
//
// So this does the job the plan wanted through the mechanism that actually
// functions with one account: it says, in the build output, when a change
// touches something whose failure is expensive AND which almost never changes.
// Every path below was measured at 8 or fewer of the last 200 commits.
//
// ADVISORY, ALWAYS. It exits 0 on every path including its own failure. It
// blocks nothing and approves nothing — it makes a quiet change loud.
//
// Usage:
//   node scripts/check-guarded-paths.js --changed-from <file>   # one path per line

const fs = require('fs');

// Paths are matched against the list `git diff --name-only` produces, which is
// relative to the GIT ROOT — so they carry the `yscap-repo-root_8/` prefix.
// Each entry says WHY, because "this file is guarded" tells a reader nothing
// they can act on.
const GUARDED = [
  {
    path: 'yscap-repo-root_8/src/lib/crypto.js',
    why: 'password hashing and the encryption every stored Social Security number '
      + 'depends on. A change here can make existing data permanently unreadable — '
      + 'not wrong, unreadable.',
  },
  {
    path: 'yscap-repo-root_8/docs/LONG-TERM-AUTHORIZED-COPIES.md',
    why: 'the ledger of what the owner authorized to cross between the two products. '
      + 'An entry here is the ONLY thing that makes a crossing legal, so adding one '
      + 'is a claim that the owner said so in writing.',
  },
  {
    path: 'yscap-repo-root_8/docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md',
    why: 'the pad that lists every authorized write into Encompass. Encompass is '
      + 'otherwise read-only, and an entry here is a claim of written authorization.',
  },
  {
    path: 'yscap-repo-root_8/scripts/check-product-separation.js',
    why: 'the gate that keeps the two loan products apart. Weakening it is invisible '
      + 'in every other way — the build simply goes on passing.',
  },
  {
    path: 'yscap-repo-root_8/scripts/test-product-separation-gate.js',
    why: 'the proof that the separation gate still bites. Without it the gate can '
      + 'quietly stop checking and nothing reports it.',
  },
  {
    path: 'yscap-repo-root_8/scripts/check-encompass-readonly.js',
    why: 'the gate that keeps PILOT from ever writing into Encompass.',
  },
  {
    path: 'yscap-repo-root_8/scripts/test-encompass-readonly-gate.js',
    why: 'the proof that the Encompass read-only gate still bites.',
  },
  {
    path: 'yscap-repo-root_8/src/lib/integrations/encompass.js',
    why: 'the read-only Encompass client. Its whole safety property is the list of '
      + 'requests it will make at all.',
  },
  {
    path: '.github/workflows/test.yml',
    why: 'how code reaches borrowers. This file decides what is tested before a '
      + 'change is published, and what publishes it.',
  },
  {
    path: 'yscap-repo-root_8/render.yaml',
    why: 'the production service, its database and its persistent disk.',
  },
];

/**
 * Which guarded paths a change list touches.
 *
 * PURE, so the whole rule is testable with no filesystem and no git. An exact
 * match, deliberately — a prefix match on `scripts/check-` would sweep in every
 * neighbouring file and put this straight back into wallpaper territory.
 */
function guardedHits(changed) {
  if (!Array.isArray(changed)) return [];
  const seen = new Set(changed.map((p) => String(p || '').trim()).filter(Boolean));
  return GUARDED.filter((g) => seen.has(g.path));
}

function readList(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return null;
  }
}

function main() {
  const i = process.argv.indexOf('--changed-from');
  const file = i >= 0 ? process.argv[i + 1] : null;
  const changed = file ? readList(file) : null;

  if (!changed) {
    // No list means this is not a pull request, or the diff could not be
    // computed. Neither is evidence that nothing sensitive changed, so it says
    // that rather than reporting an all-clear it has not earned.
    console.log('check-guarded-paths: no changed-file list — nothing to check');
    return;
  }

  const hits = guardedHits(changed);
  if (!hits.length) {
    console.log(`check-guarded-paths: none of the ${GUARDED.length} guarded paths `
      + `were touched by these ${changed.length} changed file(s)`);
    return;
  }

  console.log(`::warning::This change touches ${hits.length} guarded path(s) — `
    + `rarely-changed files whose failure is expensive. Worth a second pair of eyes.`);
  console.log('');
  for (const h of hits) {
    console.log(`   • ${h.path}`);
    console.log(`     ${h.why}`);
    console.log('');
  }
  console.log('check-guarded-paths: advisory only — not failing the build');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.log(`check-guarded-paths: could not run (${e.message}) — skipped`);
  }
}

module.exports = { guardedHits, GUARDED };

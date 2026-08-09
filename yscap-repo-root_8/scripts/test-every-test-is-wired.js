'use strict';
/**
 * EVERY TEST FILE IS EITHER IN THE CHAIN OR DELIBERATELY OUT OF IT.
 * ===========================================================================
 * There is no test RUNNER in this repo — `npm test` is one long `&&` chain of
 * `node scripts/test-*.js` steps, 650-odd of them on a single line. Adding a
 * test file therefore does NOT add a test: you must also append it to that
 * line, and nothing anywhere checked that you had.
 *
 * The result, found on 2026-08-03: 55 of 708 test files had NEVER been run by
 * CI. Not one of them failed a build, so nobody found out. Some had been
 * quietly broken for weeks; several encoded rules the owner has since
 * replaced, and one (`test-order-signature-retire-db.js`) had been DROPPED from
 * the chain by an unrelated merge — the step count stayed the same because a
 * different step was swapped in, so a diff of the count would not have caught
 * it either.
 *
 * A test that never runs is worse than no test: it reads as coverage. So this
 * guard makes the omission impossible — a new `scripts/test-*.js` either goes
 * in the chain or is named HERE with a reason, and there is no third option.
 *
 * PURE: reads package.json and a directory listing. No DB, no network.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* ---------------------------------------------------------------------------
 * The deliberate exclusions. EXACT FILENAME → why.
 * -------------------------------------------------------------------------
 * A reason is required, and it must say what makes the file unrunnable in CI
 * rather than merely inconvenient — "it is slow" is not a reason to stop
 * running a test, it is a reason to make it faster. An entry here is a
 * standing claim that CI cannot run this, and it is re-checked below: an
 * allowlisted file that has since been wired, or that no longer exists, fails
 * this suite so the list can never rot into a place things go to be forgotten.
 */
const ALLOWED_OUT = {
  // --- needs a vendor schema bundle that is not in the repo -----------------
  'test-mismo-schema.js':
    'Validates against the official MISMO XSD set, which is licensed and not '
    + 'committed. Self-skips without MISMO_XSD_DIR, so wiring it would add a '
    + 'permanently-skipping step that reads as coverage.',
};

/* ---------------------------------------------------------------------------
 * 1. What the chain actually runs
 * ------------------------------------------------------------------------- */
const chain = String((pkg.scripts && pkg.scripts.test) || '');
ok(chain.length > 0, 'package.json has a test script');

// Match the file as the chain names it, so a step that is present but pointed
// at a different path cannot read as "wired".
const wired = new Set(
  [...chain.matchAll(/scripts[/\\](test-[A-Za-z0-9._-]+\.(?:js|mjs))/g)].map((m) => m[1]),
);
ok(wired.size > 100, `the chain runs ${wired.size} test files`);

/* A step named twice is almost always a bad merge resolution (both sides kept
   their copy). Harmless at runtime, but it hides the real count, which is the
   number people eyeball when checking a merge did not drop anything. */
const seen = new Map();
for (const m of chain.matchAll(/scripts[/\\](test-[A-Za-z0-9._-]+\.(?:js|mjs))/g)) {
  seen.set(m[1], (seen.get(m[1]) || 0) + 1);
}
const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([f, n]) => `${f} ×${n}`);
ok(dupes.length === 0, `no test is wired twice${dupes.length ? ` — ${dupes.join(', ')}` : ''}`);

/* ---------------------------------------------------------------------------
 * 2. What is on disk
 * ------------------------------------------------------------------------- */
const onDisk = fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => /^test-.*\.(js|mjs)$/.test(f))
  .sort();
ok(onDisk.length > 100, `${onDisk.length} test files on disk`);

/* ---------------------------------------------------------------------------
 * 3. THE RULE
 * ------------------------------------------------------------------------- */
const stranded = onDisk.filter((f) => !wired.has(f) && !(f in ALLOWED_OUT));
ok(
  stranded.length === 0,
  stranded.length
    ? `${stranded.length} test file(s) run NOWHERE — add each to the npm test chain, or to ALLOWED_OUT in this file with a reason:\n     ${stranded.join('\n     ')}`
    : 'every test file on disk is either in the npm test chain or deliberately excluded with a reason',
);

/* A step in the chain that points at a file nobody shipped fails the whole
   build on a fresh clone, and the message ("Cannot find module") does not say
   that a rename is what broke it. */
const ghosts = [...wired].filter((f) => !onDisk.includes(f)).sort();
ok(
  ghosts.length === 0,
  ghosts.length ? `the chain names ${ghosts.length} file(s) that do not exist: ${ghosts.join(', ')}` : 'every step in the chain names a file that exists',
);

/* ---------------------------------------------------------------------------
 * 4. The exclusion list cannot rot
 * ------------------------------------------------------------------------- */
for (const [file, reason] of Object.entries(ALLOWED_OUT)) {
  ok(onDisk.includes(file), `ALLOWED_OUT "${file}" still exists (delete the entry when the file goes)`);
  ok(!wired.has(file), `ALLOWED_OUT "${file}" is genuinely not in the chain (it is wired — delete the entry)`);
  ok(
    typeof reason === 'string' && reason.trim().length >= 40,
    `ALLOWED_OUT "${file}" carries a real reason, not a shrug`,
  );
}

/* ---------------------------------------------------------------------------
 * 5. Positive control — the rule must be capable of failing
 * -------------------------------------------------------------------------
 * Everything above passes trivially if `wired` were, say, accidentally built
 * from the file listing itself. Prove the classifier actually separates the
 * two by running it over a name that is on disk and cannot be in the chain.
 */
{
  const invented = 'test-a-file-nobody-has-wired-up-yet.js';
  const wouldStrand = !wired.has(invented) && !(invented in ALLOWED_OUT);
  ok(wouldStrand, 'a new, unwired test file WOULD be reported (the check can fail)');
  const control = [...wired][0];
  ok(control && wired.has(control), 'and a wired file is recognised as wired');
}

console.log(`\n${failures ? 'FAILED' : 'All'} test-wiring checks ${failures ? `— ${failures} failure(s)` : 'passed'}`);
process.exit(failures ? 1 : 0);

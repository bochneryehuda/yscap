#!/usr/bin/env node
'use strict';
/**
 * LT — which of our test suites does CI actually run?
 *
 * THE DEFECT THIS EXISTS FOR, measured: 166 `scripts/test-lt-*.js` suites are on disk. `npm test` names
 * 59 of them BY HAND and runs `test-lt-ppe-all.js`, which globs the 100 `test-lt-ppe-*` ones. Set-
 * difference the two and **eleven suites are executed by nothing at all** — roughly 167 assertions that
 * pass, prove something real, and guard nothing, because no runner, npm script or CI job ever invokes
 * them. One of them covers `agreement-scenario-generator.js`, which was wired into a live route the day
 * before this was found.
 *
 * This is the workstream's most-repeated defect one level out. §2.36 fixed the RUNNER's summary so it
 * could no longer report a green run over suites that had proven nothing; the MEMBERSHIP list was still
 * kept by hand in two places, and it had already gone stale. A test nobody runs is indistinguishable
 * from a test that does not exist — except that it looks like coverage on the shelf.
 *
 * THE RULE: every LT suite must be executed by `npm test` — named in the chain, or covered by an
 * aggregate runner the chain invokes — or be recorded in `docs/longterm/LT-SUITES-UNRUN.md` with a
 * reason. It fails BOTH WAYS, exactly like `check-lt-reachability.js`:
 *   · a suite nothing runs and nothing documents — coverage that only looks like coverage;
 *   · a ledger row for a suite that IS run now — a ledger that overstates what is unguarded is one
 *     nobody trusts, so wiring a suite in means striking it off in the same commit.
 *
 * IT READS THE GLOB FROM THE RUNNER'S OWN MODULE (`lt-suite-scan`) rather than retyping it. A checker
 * carrying its own copy of "which files are suites" is the third copy of a rule whose two existing
 * copies are what broke.
 *
 *   node scripts/check-lt-suite-coverage.js
 *
 * PURE: filesystem reads only. LT-only.
 */
const fs = require('fs');
const path = require('path');
const scan = require('./lt-suite-scan');

const HERE = __dirname;
const ROOT = path.join(HERE, '..');
const LEDGER = path.join(ROOT, 'docs', 'longterm', 'LT-SUITES-UNRUN.md');

/** Every suite the `npm test` chain names outright. */
function namedInChain(chain) {
  return new Set(chain.match(/test-lt-[A-Za-z0-9._-]+\.(?:js|mjs)/g) || []);
}

/** The ledger's own list: every line of the form `| `name` | … |` in the markdown table. */
function readLedger() {
  if (!fs.existsSync(LEDGER)) return null;
  const out = new Set();
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line.trim());
    if (m) out.add(m[1].trim());
  }
  return out;
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const chain = String((pkg.scripts && pkg.scripts.test) || '');
  const named = namedInChain(chain);

  const suites = scan.discover(HERE);
  const executed = new Set(named);

  // An aggregate runner contributes its glob ONLY when the chain actually invokes it. Assuming it does
  // would be the same silent-green failure this file exists to catch: a runner nobody calls covers
  // nothing, however wide its glob.
  const aggregatesRun = [];
  const aggregatesIdle = [];
  for (const runner of scan.AGGREGATE_RUNNERS) {
    if (!named.has(runner)) { aggregatesIdle.push(runner); continue; }
    aggregatesRun.push(runner);
    if (runner === 'test-lt-ppe-all.js') for (const f of scan.ppeSuites(HERE)) executed.add(f);
  }

  const orphans = suites.filter((f) => !executed.has(f));
  const ledger = readLedger();

  console.log('check-lt-suite-coverage: which LT suites does `npm test` actually run?');
  console.log(`  · LT suites on disk: ${suites.length}`);
  console.log(`  · named in the npm test chain: ${[...named].filter((f) => suites.includes(f)).length}`);
  for (const r of aggregatesRun) console.log(`  · covered by ${r} (which the chain runs): ${scan.ppeSuites(HERE).length}`);
  for (const r of aggregatesIdle) console.log(`  ! ${r} exists but the chain does NOT run it — its glob covers nothing`);
  console.log(`  · executed by something: ${suites.length - orphans.length}`);
  console.log(`  · executed by NOTHING: ${orphans.length}`);

  if (!ledger) {
    console.log(`\n  ! no ledger at ${path.relative(ROOT, LEDGER)} — create it, or this check can say nothing.`);
    process.exit(1);
  }

  const undocumented = orphans.filter((f) => !ledger.has(f));
  const stale = [...ledger].filter((f) => !orphans.includes(f)).sort();

  let bad = false;
  if (undocumented.length) {
    bad = true;
    console.log(`\n  ✗ ${undocumented.length} suite(s) are executed by NOTHING and not recorded:`);
    for (const f of undocumented) console.log(`      ${f}`);
    console.log('    Add it to the `npm test` chain, or record it in LT-SUITES-UNRUN.md with the reason');
    console.log('    it cannot run there. A suite nobody runs is not coverage.');
  }
  if (stale.length) {
    bad = true;
    console.log(`\n  ✗ ${stale.length} ledger row(s) are STALE — these ARE executed now:`);
    for (const f of stale) console.log(`      ${f}`);
    console.log('    Strike them off. A ledger that overstates what is unguarded is one nobody trusts.');
  }
  if (bad) process.exit(1);

  console.log(`\n  ✓ every LT suite is either run by \`npm test\` or recorded with a reason (${orphans.length} recorded).`);
}

if (require.main === module) main();
module.exports = { namedInChain, readLedger, LEDGER };

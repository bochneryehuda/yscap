#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM (LT) PPE — run the investor-program self-audit.
 *
 *   node scripts/lt-ppe-program-audit.js            → the readable report
 *   node scripts/lt-ppe-program-audit.js --json     → the same answer as JSON
 *   node scripts/lt-ppe-program-audit.js --strict   → also exit 1 while a dead-rule question is open
 *
 * THIS FILE IS A LAUNCHER AND IMPORTS NOTHING — deliberately. Long-Term back-end code lives ONLY in
 * `src/longterm/**`, and `scripts/check-product-separation.js` enforces that by refusing any file
 * outside it (other than `src/server.js` mounting the router, and `scripts/test-lt-*.js`) that
 * `require()`s Long-Term. A command is neither of those, so the audit's whole body lives in
 * `src/longterm/ppe/program-audit-command.js` and this starts it as its own process: the operator-facing
 * name is where a person will look for it, and no RTL file gains a dependency on Long-Term.
 *
 * Do NOT "simplify" this into a `require()` of that module — that is exactly the crossing the gate
 * exists to catch, and it would need the owner's WRITTEN authorization recorded as an `rtl-import`
 * entry in `docs/LONG-TERM-AUTHORIZED-COPIES.md`. Do NOT hide one behind a computed path either; the
 * point is that there is no crossing, not that the gate cannot see one.
 *
 * The child's stdout, stderr and exit code are this command's own, so it behaves exactly as if the
 * audit ran here.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const TARGET = path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'program-audit-command.js');
const run = spawnSync(process.execPath, [TARGET, ...process.argv.slice(2)], { stdio: 'inherit' });

// A child killed by a signal has no exit code; report a failure rather than a silent success.
if (run.error) {
  console.error(`lt-ppe-program-audit: could not start the audit — ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status == null ? 1 : run.status);

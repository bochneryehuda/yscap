#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM (LT) PPE — the SCHEDULED daily Lender Price check (owner-directed 2026-08-18:
 * every day at 7am, 9am, 10am, 11am, 12pm and 4pm Eastern).
 *
 *   node scripts/lt-ppe-canary-cron.js              → run if this hour is one of the six
 *   node scripts/lt-ppe-canary-cron.js --dry-run    → say what it would do, touch nothing
 *   node scripts/lt-ppe-canary-cron.js --force      → run whatever the clock says (still lease-guarded)
 *
 * THIS FILE IS A LAUNCHER AND IMPORTS NOTHING — deliberately, and for the same reason
 * `scripts/lt-ppe-program-audit.js` is. Long-Term back-end code lives ONLY in `src/longterm/**` and
 * `scripts/check-product-separation.js` refuses any file outside it that `require()`s Long-Term
 * (other than `src/server.js` mounting the router, and `scripts/test-lt-*.js`). A scheduled command is
 * neither, so the whole body lives in `src/longterm/ppe/canary-cron-command.js` and this starts it as
 * its own process: the operator-facing name is where a person will look for it, and no RTL file gains
 * a dependency on Long-Term.
 *
 * Do NOT "simplify" this into a `require()` of that module — that is exactly the crossing the gate
 * exists to catch, and it would need the owner's WRITTEN authorization recorded as an `rtl-import`
 * entry in `docs/LONG-TERM-AUTHORIZED-COPIES.md`.
 *
 * The child's stdout, stderr and exit code are this command's own.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const TARGET = path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'canary-cron-command.js');
const run = spawnSync(process.execPath, [TARGET, ...process.argv.slice(2)], { stdio: 'inherit' });

if (run.error) {
  console.error(`lt-ppe-canary-cron: could not start the scheduled check — ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status == null ? 1 : run.status);

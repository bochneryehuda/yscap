'use strict';
/**
 * LT PPE — aggregate test runner. Runs every scripts/test-lt-ppe-*.js suite sequentially and fails on
 * the first failure. ONE command to verify the whole Product & Pricing Engine locally, and the single
 * entry point to wire into CI's test chain when this branch is prepped for merge (kept out of
 * package.json for now so the merge-conflict-prone `test` chain is not touched mid-flight).
 *
 * The `-db.js` suites self-manage DATABASE_URL (they run their pure sections without a DB and the DB
 * round-trip only when DATABASE_URL is set), so this runner is safe to run with or without a database.
 *
 *   node scripts/test-lt-ppe-all.js
 *
 * LT-only.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const self = path.basename(__filename);
const suites = fs.readdirSync(dir)
  .filter((f) => /^test-lt-ppe-.*\.(js|mjs)$/.test(f) && f !== self)
  .sort();

let failed = 0;
const results = [];
for (const f of suites) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  const okRun = r.status === 0;
  if (!okRun) failed += 1;
  results.push({ f, okRun, out: (r.stdout || '') + (r.stderr || '') });
  const tail = (r.stdout || '').trim().split('\n').pop() || '';
  console.log(`${okRun ? '  ok  ' : ' FAIL '} ${f}${okRun && tail ? `  — ${tail}` : ''}`);
  if (!okRun) console.log((r.stdout || '') + (r.stderr || ''));
}

console.log(`\n${suites.length - failed}/${suites.length} LT PPE suites passed`);
process.exit(failed ? 1 : 0);

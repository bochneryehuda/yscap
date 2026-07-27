/* Migration re-run safety — an EARLIER migration that re-adds a value-list
 * CHECK constraint which a LATER migration WIDENS must not log a boot error.
 *
 * Root cause it guards (owner-reported): every numbered migration re-runs on
 * every boot; db/153 re-adds chk_esign_purpose WITHOUT 'draw_request', which
 * db/206 later allows, so once real draw-request envelopes exist the db/153
 * re-add fails 23514 on every boot. The runner now recognizes that the failing
 * constraint is re-defined by a later migration and skips it quietly. Same
 * class: staff role check (006/039 vs 131/212) and loan-exception status
 * (270 vs 306).
 *
 * Pure — no DB. Run: node scripts/test-migration-supersede.js */
const fs = require('fs');
const path = require('path');
const boot = require('../src/migrate-boot');

let pass = 0, fail = 0;
const eq = (name, got, exp) => { if (got === exp) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ---- constraintsAddedBy: names a file ADDs (not DROPs, not comments) --------
eq('extracts a single ADD CONSTRAINT name',
  JSON.stringify(boot.constraintsAddedBy(
    `ALTER TABLE t DROP CONSTRAINT IF EXISTS chk_x;\nALTER TABLE t ADD CONSTRAINT chk_x CHECK (a IN ('p'));`)),
  JSON.stringify(['chk_x']));
eq('handles the "ADD  CONSTRAINT" double-space form (db/006/039)',
  JSON.stringify(boot.constraintsAddedBy(`ALTER TABLE staff_users ADD  CONSTRAINT staff_users_role_check CHECK (role IN ('a'));`)),
  JSON.stringify(['staff_users_role_check']));
ok('DROP CONSTRAINT alone is not an ADD', boot.constraintsAddedBy('ALTER TABLE t DROP CONSTRAINT IF EXISTS chk_x;').length === 0);
ok('a commented-out ADD CONSTRAINT is ignored', boot.constraintsAddedBy('-- ALTER TABLE t ADD CONSTRAINT chk_x CHECK (1);').length === 0);

// ---- constraintNameFromError: field first, message fallback ----------------
eq('uses the pg error.constraint field', boot.constraintNameFromError({ code: '23514', constraint: 'chk_esign_purpose' }), 'chk_esign_purpose');
eq('falls back to parsing the message', boot.constraintNameFromError({ code: '23514', message: 'check constraint "chk_esign_purpose" of relation "esign_envelopes" is violated by some row' }), 'chk_esign_purpose');
eq('no name → null', boot.constraintNameFromError({ code: '23514', message: 'something else' }), null);

// ---- isSupersededConstraintFailure -----------------------------------------
const dmax = new Map([['chk_x', 5]]);
ok('23514 on a constraint a LATER file redefines → superseded (benign)',
  boot.isSupersededConstraintFailure({ code: '23514', constraint: 'chk_x' }, 2, dmax) === true);
ok('same index (no later redefiner) → NOT superseded (real error)',
  boot.isSupersededConstraintFailure({ code: '23514', constraint: 'chk_x' }, 5, dmax) === false);
ok('later index than the max definer → NOT superseded',
  boot.isSupersededConstraintFailure({ code: '23514', constraint: 'chk_x' }, 6, dmax) === false);
ok('a non-check-violation error is never treated as superseded',
  boot.isSupersededConstraintFailure({ code: '23505', constraint: 'chk_x' }, 2, dmax) === false);
ok('unknown constraint → NOT superseded', boot.isSupersededConstraintFailure({ code: '23514', constraint: 'nope' }, 2, dmax) === false);
ok('missing error → false', boot.isSupersededConstraintFailure(null, 2, dmax) === false);

// ---- tie the fix to the ACTUAL migrations in db/ ---------------------------
// Rebuild the runner's file ordering (schema.sql first, then numeric ascending)
// and the constraint→max-index map, then assert the reported bug is recognized.
const dir = path.join(__dirname, '..', 'db');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort((a, b) => {
  if (a === 'schema.sql') return -1;
  if (b === 'schema.sql') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
});
const idxOf = (name) => files.indexOf(name);
const definerMax = new Map();
files.forEach((f, i) => {
  for (const n of boot.constraintsAddedBy(fs.readFileSync(path.join(dir, f), 'utf8'))) {
    const prev = definerMax.get(n);
    if (prev === undefined || i > prev) definerMax.set(n, i);
  }
});

// The three real widening chains: the earlier re-add is superseded by a later file.
const chains = [
  { name: 'chk_esign_purpose',            earlier: '153_esign_test_envelopes.sql',  later: '206_draw_request_wire.sql' },
  { name: 'staff_users_role_check',       earlier: '006_roles_tools.sql',           later: '212_workflow.sql' },
  { name: 'loan_exceptions_status_check', earlier: '270_exception_clear.sql',        later: '306_exception_workflow_redesign.sql' },
];
for (const c of chains) {
  const ie = idxOf(c.earlier), il = idxOf(c.later);
  ok(`${c.earlier} present in db/`, ie >= 0);
  ok(`${c.later} present in db/`, il >= 0);
  ok(`${c.name}: a later migration redefines it (index ${definerMax.get(c.name)} > ${ie})`,
    (definerMax.get(c.name) || -1) > ie);
  // Simulate the earlier migration failing 23514 on that constraint at boot.
  ok(`${c.earlier}: a boot-time 23514 on ${c.name} is recognized as benign`,
    boot.isSupersededConstraintFailure({ code: '23514', constraint: c.name }, ie, definerMax) === true);
}

// And the CURRENT widest migration for esign purpose must NOT be treated as
// benign if it ever failed — it is the last word on that constraint.
ok('the widest esign-purpose migration is not itself superseded',
  boot.isSupersededConstraintFailure({ code: '23514', constraint: 'chk_esign_purpose' },
    definerMax.get('chk_esign_purpose'), definerMax) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

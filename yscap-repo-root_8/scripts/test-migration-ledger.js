/* WO-13 (F-M19) — migration ledger checksum helpers.
 *
 * Every migration re-runs idempotently on every boot; the ledger adds
 * observability + a loud alarm when a migration FILE is edited after it was
 * applied (a real hazard — an edit to an already-applied file may not re-apply
 * on existing databases, so schema changes must be a NEW numbered file).
 *
 * Verifies the two pure helpers with no DB. Run: node scripts/test-migration-ledger.js */
const boot = require('../src/migrate-boot');

let pass = 0, fail = 0;
const eq = (name, got, exp) => { if (got === exp) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ---- migrationChecksum: deterministic content hash -------------------------
const a = boot.migrationChecksum('CREATE TABLE IF NOT EXISTS foo (id int);');
const aAgain = boot.migrationChecksum('CREATE TABLE IF NOT EXISTS foo (id int);');
const b = boot.migrationChecksum('CREATE TABLE IF NOT EXISTS foo (id int, x text);');
eq('same content → same checksum', a, aAgain);
ok('different content → different checksum', a !== b);
ok('checksum is a 64-hex sha256', /^[0-9a-f]{64}$/.test(a));
eq('handles non-string input without throwing', typeof boot.migrationChecksum(12345), 'string');

// ---- isChecksumDrift: only a CHANGED, previously-recorded file drifts ------
eq('new file (no prior) is not drift', boot.isChecksumDrift(null, a), false);
eq('unchanged file is not drift', boot.isChecksumDrift(a, a), false);
eq('edited-after-applied file IS drift', boot.isChecksumDrift(a, b), true);
eq('missing current hash is not drift', boot.isChecksumDrift(a, null), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

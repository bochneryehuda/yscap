'use strict';
/* DB-gated regression test for the atomic once-per-period claim (audit G4).
 * Proves the shared claimOncePerPeriod serializes concurrent claimants so a
 * digest / event email is sent AT MOST once per window even across instances —
 * the old plain INSERT…WHERE NOT EXISTS raced (both txns passed the check and
 * both sent). Needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-throttle-claim-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-throttle-claim-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const { claimOncePerPeriod } = require('../src/lib/throttle-claim');
const db = require('../src/db');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
// Unique action per run so repeat runs against the same DB don't collide.
const A = (s) => `ttc_${s}_${process.pid}_${Number(process.hrtime.bigint() % 1000000n)}`;
const uuid = (h) => `${h.repeat(8)}-${h.repeat(4)}-${h.repeat(4)}-${h.repeat(4)}-${h.repeat(12)}`;

(async () => {
  // 1) 25 concurrent per-file claims → EXACTLY ONE winner
  const a1 = A('file'); const eid = uuid('a');
  const wins = (await Promise.all(Array.from({ length: 25 }, () => claimOncePerPeriod({ action: a1, entityId: eid, interval: '1 hour' })))).filter(Boolean).length;
  assert.strictEqual(wins, 1, `25 concurrent per-file claims → exactly 1 winner (got ${wins})`);
  ok('concurrent per-file claims: exactly ONE winner (atomic across parallel txns)');

  // 2) 25 concurrent GLOBAL (null-entity) claims → EXACTLY ONE winner
  const a2 = A('glob');
  const gWins = (await Promise.all(Array.from({ length: 25 }, () => claimOncePerPeriod({ action: a2, interval: '1 hour' })))).filter(Boolean).length;
  assert.strictEqual(gWins, 1, `25 concurrent global claims → exactly 1 winner (got ${gWins})`);
  ok('concurrent global (non-file) claims: exactly ONE winner');

  // 3) a DIFFERENT entity is independent — its own single winner
  const other = (await Promise.all(Array.from({ length: 10 }, () => claimOncePerPeriod({ action: a1, entityId: uuid('b'), interval: '1 hour' })))).filter(Boolean).length;
  assert.strictEqual(other, 1, 'a different file claims independently (1 winner)');
  ok('claims are scoped per entity — a different file is not blocked by the first');

  // 4) re-claim the SAME file INSIDE the window → blocked (no second send)
  const again = await claimOncePerPeriod({ action: a1, entityId: eid, interval: '1 hour' });
  assert.ok(!again, 're-claim within the window is blocked');
  ok('re-claim within the window is blocked (no duplicate send)');

  // 5) re-claim after the window elapsed (0s) → wins again (a genuine later send)
  const elapsed = await claimOncePerPeriod({ action: a1, entityId: eid, interval: '0 seconds' });
  assert.ok(elapsed, 're-claim after the window elapses wins again');
  ok('a genuine later send (window elapsed) is allowed again');

  // 6) exactly one audit_log row exists per (action, entity) window claim
  const cnt = (await db.query(`SELECT count(*)::int AS c FROM audit_log WHERE action=$1 AND entity_id=$2::uuid`, [a1, eid])).rows[0].c;
  assert.strictEqual(cnt, 2, `only the 2 winning claims (initial + post-window) wrote a row (got ${cnt})`);
  ok('losers never wrote a throttle row — only the winners did');

  console.log(`\nAll ${n} throttle-claim checks passed — once-per-period sends are atomic across concurrent instances.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.message); process.exit(1); });

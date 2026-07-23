'use strict';
/**
 * Condition aging / SLA — pure tests.
 * Proves it (1) computes days-open to `now` for open conditions and freezes a
 * closed one at its close time, (2) buckets by age, (3) flags overdue past an
 * SLA (per-condition, per-severity, or default) but never a closed one, (4) rolls
 * up a file summary (open/overdue/oldest/histogram), (5) accepts ISO + epoch
 * timestamps, and (6) never throws.
 */
const assert = require('assert');
const ca = require('../src/lib/underwriting/condition-aging');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const DAY = 86400000;
const NOW = 1_700_000_000_000; // fixed epoch ms
const daysAgo = (d) => NOW - d * DAY;

// --- days-open + bucket + overdue for open conditions ---
let r = ca.ageConditions([
  { id: 'a', status: 'open', opened_at: daysAgo(2) },       // 2 days → 0-3, not overdue (sla 7)
  { id: 'b', status: 'received', opened_at: daysAgo(10) },  // 10 days → 8-14, overdue past sla 7
], { now: NOW });
const a = r.conditions.find((x) => x.id === 'a');
const b = r.conditions.find((x) => x.id === 'b');
assert.strictEqual(a.daysOpen, 2); assert.strictEqual(a.bucket, '0-3'); assert.strictEqual(a.overdue, false);
assert.strictEqual(b.daysOpen, 10); assert.strictEqual(b.bucket, '8-14'); assert.strictEqual(b.overdue, true);
assert.strictEqual(b.overdueBy, 3, 'overdue by 10 - 7 = 3 days');
ok('open conditions age to now, bucket by days, and flag overdue past the default SLA');

// --- a closed condition freezes at close time and is never overdue ---
r = ca.ageConditions([
  { id: 'c', status: 'satisfied', opened_at: daysAgo(30), satisfied_at: daysAgo(25) }, // took 5 days, closed
], { now: NOW });
const c = r.conditions[0];
assert.strictEqual(c.open, false);
assert.strictEqual(c.daysOpen, 5, 'age frozen at 30 - 25 = 5 days, not 30');
assert.strictEqual(c.overdue, false, 'a closed condition is never overdue');
ok('a closed condition freezes its age at close time and is never overdue');

// --- per-condition SLA and per-severity SLA override the default ---
r = ca.ageConditions([
  { id: 'd', status: 'open', opened_at: daysAgo(5), sla_days: 3 },  // explicit sla 3 → overdue
  { id: 'e', status: 'open', opened_at: daysAgo(5), severity: 'fatal' }, // severity map sla 2 → overdue
  { id: 'f', status: 'open', opened_at: daysAgo(5), severity: 'low' },   // severity map sla 14 → not overdue
], { now: NOW, slaBySeverity: { fatal: 2, low: 14 } });
assert.strictEqual(r.conditions.find((x) => x.id === 'd').overdue, true, 'explicit sla_days=3 → overdue at 5');
assert.strictEqual(r.conditions.find((x) => x.id === 'e').overdue, true, 'fatal severity sla=2 → overdue at 5');
assert.strictEqual(r.conditions.find((x) => x.id === 'f').overdue, false, 'low severity sla=14 → not overdue at 5');
ok('SLA precedence: explicit sla_days > severity map > default');

// --- summary rolls up open/closed/overdue/oldest + a bucket histogram ---
r = ca.ageConditions([
  { id: '1', status: 'open', opened_at: daysAgo(1) },
  { id: '2', status: 'open', opened_at: daysAgo(9) },   // overdue
  { id: '3', status: 'open', opened_at: daysAgo(20) },  // overdue, oldest
  { id: '4', status: 'cleared', opened_at: daysAgo(40), cleared_at: daysAgo(38) },
], { now: NOW });
assert.strictEqual(r.summary.total, 4);
assert.strictEqual(r.summary.open, 3);
assert.strictEqual(r.summary.closed, 1);
assert.strictEqual(r.summary.overdue, 2);
assert.strictEqual(r.summary.oldestDaysOpen, 20, 'oldest OPEN condition is 20 days');
assert.strictEqual(r.summary.buckets['0-3'], 1); // #1 open + ... let's just check the 15+ has the 20-day
assert.strictEqual(r.summary.buckets['15+'], 1, 'the 20-day open condition lands in 15+');
ok('the file summary rolls up open/closed/overdue/oldest and a bucket histogram');

// --- ISO-string timestamps parse the same as epoch ms ---
r = ca.ageConditions([{ id: 'x', status: 'open', opened_at: '2023-11-04T00:00:00Z' }], { now: Date.parse('2023-11-14T00:00:00Z') });
assert.strictEqual(r.conditions[0].daysOpen, 10, 'ISO timestamps compute a 10-day age');
assert.strictEqual(r.conditions[0].overdue, true);
ok('ISO-string timestamps parse and age the same as epoch ms');

// --- a condition with no opened_at has no age (not overdue, not bucketed) ---
r = ca.ageConditions([{ id: 'n', status: 'open' }], { now: NOW });
assert.strictEqual(r.conditions[0].daysOpen, null);
assert.strictEqual(r.conditions[0].overdue, false);
assert.strictEqual(r.conditions[0].bucket, null);
ok('a condition with no opened_at has no age and is not flagged overdue');

// --- empty / junk / hostile input is safe ---
assert.doesNotThrow(() => ca.ageConditions(null, { now: NOW }));
assert.strictEqual(ca.ageConditions(null, { now: NOW }).summary.total, 0);
assert.doesNotThrow(() => ca.ageConditions('notarray'));
assert.doesNotThrow(() => ca.ageConditions([null, 42, 'x', {}], { now: NOW }));
assert.doesNotThrow(() => ca.ageConditions([{ status: 'open', get opened_at() { throw new Error('boom'); } }], { now: NOW }));
assert.doesNotThrow(() => ca.ageConditions([{ status: 'open', opened_at: daysAgo(3) }], { now: 'garbage' }));
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\ncondition-aging pure — ${passed} checks passed`);

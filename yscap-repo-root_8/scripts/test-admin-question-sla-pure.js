'use strict';
/**
 * #200 — pure tests for the admin-question SLA clock. Proves: an answered question
 * is closed (no clock); a fraud-agent question uses the tight 8h SLA and goes
 * overdue past it; a routine question uses the 24h default; an explicit
 * decision_deadline overrides the agent SLA; the roll-up counts open/overdue/
 * due-soon correctly; and hostile input never throws.
 */
const assert = require('assert');
const sla = require('../src/lib/underwriting/admin-question-sla');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const NOW = new Date('2026-07-23T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

// 1. Answered question → closed, no clock.
{
  const r = sla.ageQuestion({ id: 'q1', agent: 'cure', asked_at: hoursAgo(50), answered_at: hoursAgo(1) }, { now: NOW });
  assert.strictEqual(r.open, false);
  assert.strictEqual(r.overdue, false);
  ok('an answered question is closed with no clock');
}

// 2. A fraud-agent question uses the 8h SLA; open 10h → overdue by ~2h.
{
  const r = sla.ageQuestion({ id: 'q2', agent: 'assignment_fraud', asked_at: hoursAgo(10) }, { now: NOW });
  assert.strictEqual(r.open, true);
  assert.strictEqual(r.slaHours, 8, 'fraud agent → 8h SLA');
  assert.strictEqual(r.overdue, true);
  assert.ok(Math.abs(r.overdueByHours - 2) < 0.5, 'overdue by ~2h');
  assert.ok(Math.abs(r.hoursOpen - 10) < 0.5);
  ok('a fraud question uses the tight 8h SLA and goes overdue past it');
}

// 3. A routine cure question at 10h open is NOT overdue (24h default).
{
  const r = sla.ageQuestion({ id: 'q3', agent: 'cure', asked_at: hoursAgo(10) }, { now: NOW });
  assert.strictEqual(r.slaHours, 24);
  assert.strictEqual(r.overdue, false, '10h < 24h SLA');
  ok('a routine cure question at 10h is within its 24h SLA');
}

// 4. An explicit decision_deadline overrides the agent SLA.
{
  // cure agent (24h SLA) but an explicit deadline 1h ago → overdue now.
  const r = sla.ageQuestion({ id: 'q4', agent: 'cure', asked_at: hoursAgo(2), decision_deadline: hoursAgo(1) }, { now: NOW });
  assert.strictEqual(r.overdue, true, 'explicit past deadline wins over the 24h SLA');
  ok('an explicit decision_deadline overrides the agent SLA');
}

// 5. Unknown agent falls back to the default SLA.
{
  const r = sla.ageQuestion({ id: 'q5', agent: 'mystery_agent', asked_at: hoursAgo(1) }, { now: NOW });
  assert.strictEqual(r.slaHours, sla.DEFAULT_SLA_HOURS);
  ok('an unknown agent falls back to the default SLA');
}

// 6. Roll-up: one overdue fraud, one due-soon, one answered.
{
  const rows = [
    { id: 'a', agent: 'assignment_fraud', asked_at: hoursAgo(10) },   // overdue (8h)
    { id: 'b', agent: 'cure', asked_at: hoursAgo(22) },               // due soon (due at 24h → in ~2h)
    { id: 'c', agent: 'cure', asked_at: hoursAgo(50), answered_at: hoursAgo(1) }, // closed
  ];
  const { summary } = sla.ageQuestions(rows, { now: NOW, dueSoonHours: 4 });
  assert.strictEqual(summary.total, 3);
  assert.strictEqual(summary.open, 2, 'two still open');
  assert.strictEqual(summary.overdue, 1, 'the fraud question is overdue');
  assert.strictEqual(summary.dueSoon, 1, 'the 22h-old cure question is due within 4h');
  ok('the roll-up counts open / overdue / due-soon correctly');
}

// 7. Hostile input never throws.
{
  for (const bad of [null, undefined, 42, 'x', {}, [1, 2]]) {
    assert.doesNotThrow(() => sla.ageQuestion(bad, {}));
    assert.doesNotThrow(() => sla.ageQuestions(bad, {}));
  }
  ok('hostile input degrades safely (never throws)');
}

console.log(`\nadmin-question-sla pure — ${passed} checks passed`);

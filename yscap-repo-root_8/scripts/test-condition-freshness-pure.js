'use strict';
/**
 * #191 activation 3 — pure tests for the freshness reopen PLANNER. The
 * windows come from condition-reopen (R5.31) — the single source; this
 * suite proves the planner's safety posture: waived never reopens, fresh
 * never reopens, unmapped codes (incl. the frozen SOW gates) are out of
 * scope, the cap holds, and the oldest clearance reopens first.
 */
const assert = require('assert');
const { planFreshnessReopens, autoNoteFor, KIND_BY_TEMPLATE_CODE } = require('../src/lib/underwriting/condition-freshness');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const NOW = new Date('2026-07-23T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

// 1. A bank-statement condition cleared 90 days ago (window 60) reopens.
{
  const plans = planFreshnessReopens([
    { id: 'a', application_id: 'app1', template_code: 'rtl_p3_assets', signed_off_at: daysAgo(90) },
  ], { now: NOW });
  assert.strictEqual(plans.length, 1);
  assert.strictEqual(plans[0].kind, 'bank_statement');
  assert.strictEqual(plans[0].trigger, 'evidence_expired');
  assert.strictEqual(plans[0].daysStale, 90);
  ok('stale bank statements (90d > 60d window) plan a reopen');
}

// 2. Fresh evidence never reopens; waived never reopens; unsigned never reopens.
{
  const plans = planFreshnessReopens([
    { id: 'fresh', template_code: 'rtl_p3_assets', signed_off_at: daysAgo(10) },
    { id: 'waived', template_code: 'rtl_p3_assets', signed_off_at: daysAgo(200), waived_at: daysAgo(100) },
    { id: 'open', template_code: 'rtl_p3_assets', signed_off_at: null },
  ], { now: NOW });
  assert.strictEqual(plans.length, 0);
  ok('fresh / waived / not-signed-off conditions never plan a reopen');
}

// 3. Unmapped codes are structurally out of scope — including the FROZEN SOW gate.
{
  assert.ok(!('rtl_p1_budget' in KIND_BY_TEMPLATE_CODE), 'the SOW/budget gate is NOT in the map');
  assert.ok(!Object.keys(KIND_BY_TEMPLATE_CODE).some((c) => /sow|budget/.test(c)), 'no SOW code mapped');
  const plans = planFreshnessReopens([
    { id: 'x', template_code: 'rtl_p1_budget', signed_off_at: daysAgo(500) },
    { id: 'y', template_code: 'rtl_p1_id', signed_off_at: daysAgo(500) },
  ], { now: NOW });
  assert.strictEqual(plans.length, 0);
  ok('unmapped codes (incl. the frozen SOW gate) are out of scope no matter how old');
}

// 4. Windows differ per kind: 90-day-old credit (120d window) stays; 90-day-old assets reopen.
{
  const plans = planFreshnessReopens([
    { id: 'credit', template_code: 'rtl_cond_credit', signed_off_at: daysAgo(90) },
    { id: 'assets', template_code: 'rtl_p3_assets', signed_off_at: daysAgo(90) },
  ], { now: NOW });
  assert.deepStrictEqual(plans.map((p) => p.id), ['assets']);
  ok('per-kind windows respected (credit 120d survives where assets 60d reopens)');
}

// 5. The cap holds and the OLDEST clearance reopens first.
{
  const rows = Array.from({ length: 40 }, (_, i) => (
    { id: `c${i}`, template_code: 'rtl_p3_assets', signed_off_at: daysAgo(61 + i) }));
  const plans = planFreshnessReopens(rows, { now: NOW, limit: 5 });
  assert.strictEqual(plans.length, 5);
  assert.strictEqual(plans[0].id, 'c39', 'oldest clearance first');
  ok('the per-run cap holds and the most-stale evidence reopens first');
}

// 6. The [auto] note is borrower-safe: no partner names, explains the why, keeps their work.
{
  const note = autoNoteFor({ daysStale: 75 });
  assert.ok(note.startsWith('[auto] '), 'auto-note convention');
  assert.ok(/75 days ago/.test(note) && /freshness window/.test(note) && /nothing is lost/i.test(note));
  const { hasPartnerName } = require('../src/lib/borrower-safe');
  assert.strictEqual(hasPartnerName(note), false, 'no partner name in the note');
  ok('the [auto] note is explanatory and borrower-safe');
}

console.log(`\ncondition-freshness pure — ${passed} checks passed`);

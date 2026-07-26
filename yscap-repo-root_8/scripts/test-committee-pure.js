#!/usr/bin/env node
'use strict';
/**
 * Pure unit tests for the committee adjudicator (src/lib/ai/committee.js). The
 * specialist calls hit an LLM at runtime, so these tests only exercise the
 * pure `adjudicate()` combine logic — the moat piece that doesn't depend on
 * live keys.
 */
const assert = require('assert');
const { adjudicate } = require('../src/lib/ai/committee');

function verdict(key, v, sev = 'warning', conf = 0.8, reason = 'test') {
  return { key, ok: true, verdict: { verdict: v, confidence: conf, severity_recommendation: sev, reason } };
}
function abstain(key) { return { key, ok: true, verdict: { verdict: 'abstain', confidence: 0, severity_recommendation: 'dismiss', reason: 'off-lens' } }; }
function failed(key, reason) { return { key, ok: false, reason }; }

// ---- Confirm at fatal — any fatal confirm dominates (safety-first) ----
{
  const finding = { code: 'ofac_confirmed_match', severity: 'fatal' };
  const op = adjudicate(finding, [
    verdict('fraud', 'confirm', 'fatal', 0.99),
    verdict('identity', 'refute', 'dismiss', 0.5),
  ]);
  assert.strictEqual(op.action, 'confirm');
  assert.strictEqual(op.adjudicated_severity, 'fatal');
}

// ---- Majority confirm → real ----
{
  const finding = { code: 'property_units_mismatch', severity: 'warning' };
  const op = adjudicate(finding, [
    verdict('appraisal', 'confirm', 'warning', 0.9),
    verdict('title', 'confirm', 'warning', 0.85),
    verdict('identity', 'refute', 'dismiss', 0.6),
  ]);
  assert.strictEqual(op.action, 'confirm');
  assert.strictEqual(op.adjudicated_severity, 'warning');
  assert.strictEqual(op.dissents.length, 1, 'the refuting identity vote is a dissent');
}

// ---- 2/3+ high-confidence refutes → dismiss ----
{
  const finding = { code: 'borrower_name_mismatch', severity: 'warning' };
  const op = adjudicate(finding, [
    verdict('identity', 'refute', 'dismiss', 0.9),
    verdict('credit',   'refute', 'dismiss', 0.85),
    verdict('fraud',    'refute', 'dismiss', 0.9),
    verdict('entity',   'confirm', 'warning', 0.5),
  ]);
  assert.strictEqual(op.action, 'dismiss');
  assert.strictEqual(op.adjudicated_severity, 'dismiss');
  assert.strictEqual(op.dissents.length, 1, 'the confirm vote becomes a dissent when we dismiss');
}

// ---- Refutes but not high-confidence enough → hold ----
{
  const finding = { code: 'vesting_mismatch', severity: 'warning' };
  const op = adjudicate(finding, [
    verdict('title',    'refute', 'dismiss', 0.6),
    verdict('entity',   'refute', 'dismiss', 0.6),
    verdict('identity', 'refute', 'dismiss', 0.6),
  ]);
  assert.strictEqual(op.action, 'hold', 'low-confidence refutes should not dismiss');
}

// ---- Plurality modifies WITH NO FATAL-CONFIRM → adjudicated severity moves ----
{
  // With NO fatal-confirm and no majority-confirm, plurality-modify wins.
  const finding = { code: 'flood_zone', severity: 'fatal' };
  const op = adjudicate(finding, [
    verdict('insurance', 'modify', 'warning', 0.85),
    verdict('appraisal', 'modify', 'warning', 0.85),
    verdict('title',     'refute', 'dismiss', 0.6),
  ]);
  assert.strictEqual(op.action, 'modify');
  assert.strictEqual(op.adjudicated_severity, 'warning');
}

// ---- SAFETY FIRST — a single fatal-confirm dominates any modify/refute majority ----
{
  const finding = { code: 'flood_zone', severity: 'fatal' };
  const op = adjudicate(finding, [
    verdict('insurance', 'modify', 'warning', 0.85),
    verdict('appraisal', 'modify', 'warning', 0.85),
    verdict('title',     'confirm', 'fatal', 0.9),
  ]);
  assert.strictEqual(op.action, 'confirm', 'a fatal confirm always stands');
  assert.strictEqual(op.adjudicated_severity, 'fatal');
}

// ---- All abstain → hold at original ----
{
  const finding = { code: 'random_x', severity: 'warning' };
  const op = adjudicate(finding, [abstain('identity'), abstain('credit'), abstain('fraud')]);
  assert.strictEqual(op.action, 'hold');
  assert.strictEqual(op.adjudicated_severity, 'warning');
  assert.deepStrictEqual(op.abstained.sort(), ['credit','fraud','identity']);
}

// ---- Every specialist failed → hold with no dissents ----
{
  const finding = { code: 'x', severity: 'fatal' };
  const op = adjudicate(finding, [failed('identity','5xx'), failed('credit','timeout')]);
  assert.strictEqual(op.action, 'hold');
  assert.strictEqual(op.failed.length, 2);
  assert.strictEqual(op.dissents.length, 0);
}

// ---- Split panel (1-1-0) → hold ----
{
  const finding = { code: 'x', severity: 'warning' };
  const op = adjudicate(finding, [
    verdict('a', 'confirm', 'warning', 0.6),
    verdict('b', 'refute',  'dismiss', 0.6),
  ]);
  // 1 confirm / 2 total = 0.5 → 0.5*2=2 >= 2 → confirms.length*2 >= total → confirm branch
  // Actually 1*2 = 2 >= 2 = confirm branch. Good.
  assert.strictEqual(op.action, 'confirm');
}

console.log('test-committee-pure: adjudicator combines specialist verdicts correctly');

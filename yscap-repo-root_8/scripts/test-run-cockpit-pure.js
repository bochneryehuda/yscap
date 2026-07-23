'use strict';
/**
 * #197 — pure tests for run-cockpit.composeCockpit(): folding two persisted
 * underwriting runs (+ conditions) into ONE staff panel (decision + run-diff +
 * next-actions + findings-digest). Proves: a never-run file returns a safe
 * hasRun:false payload; a single run yields the decision + digest + worklist with
 * NO diff; two runs produce a real run-diff; a blocking finding surfaces in the
 * next-actions worklist; and the composer NEVER throws on hostile input. Pure — no
 * DB, no engine, no frozen numbers touched.
 */
const assert = require('assert');
const cockpit = require('../src/lib/underwriting/run-cockpit');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const runRow = (over) => Object.assign({
  id: 'run-1', as_of: '2026-07-23T00:00:00Z', trigger: 'manual_run', program_key: 'standard',
  status: 'ELIGIBLE', term_sheet_eligible: true, ctc_eligible: false, funding_eligible: false,
  superseded_at: null, created_at: '2026-07-23T00:00:00Z',
}, over || {});

const finding = (over) => Object.assign({
  code: 'title_defect', severity: 'fatal', category: 'title', title: 'Open lien on title',
  explanation: 'A lien remains of record.', blocks_term_sheet: true, blocks_ctc: true, blocks_funding: true,
}, over || {});

// 1. A never-run file → a safe, valid, empty panel.
{
  const c = cockpit.composeCockpit({ current: { run: null, findings: [] }, previous: null, conditions: [] });
  assert.strictEqual(c.hasRun, false);
  assert.strictEqual(c.current, null);
  assert.strictEqual(c.diff, null);
  assert.strictEqual(c.decision, null);
  assert.ok(c.nextActions && Array.isArray(c.nextActions.actions), 'a valid empty worklist');
  assert.ok(c.findingsDigest && typeof c.findingsDigest === 'object', 'a valid empty digest');
  ok('a never-run file returns a safe hasRun:false panel');
}

// 2. A single run (no previous) → decision + digest, but NO diff.
{
  const c = cockpit.composeCockpit({
    current: { run: runRow(), findings: [finding()] },
    previous: { run: null, findings: [] },
    conditions: [],
  });
  assert.strictEqual(c.hasRun, true);
  assert.strictEqual(c.current.status, 'ELIGIBLE');
  assert.strictEqual(c.current.gates.termSheet, true);
  assert.strictEqual(c.decision.gates.ctc, false);
  assert.strictEqual(c.diff, null, 'no previous run → no diff');
  assert.strictEqual(c.findingCount, 1);
  // the fatal title finding rolls up into the digest under the title category
  assert.ok(c.findingsDigest.categories.some((g) => g.category === 'title'), 'title category present in digest');
  ok('a single run yields decision + digest with no diff');
}

// 3. A blocking finding surfaces in the next-actions worklist as a blocking item.
{
  const c = cockpit.composeCockpit({
    current: { run: runRow(), findings: [finding()] },
    previous: { run: null, findings: [] },
    conditions: [],
  });
  const acts = c.nextActions.actions;
  assert.ok(acts.some((a) => a.kind === 'finding' && a.blocking === true), 'a blocking finding action is present');
  assert.ok(c.nextActions.summary.blocking >= 1, 'summary counts the blocking item');
  ok('a blocking finding surfaces in the next-actions worklist');
}

// 4. Two runs → a real run-diff (a gate that moved and a finding that cleared).
{
  const prev = { run: runRow({ id: 'run-0', term_sheet_eligible: false }), findings: [finding()] };
  const curr = { run: runRow({ id: 'run-1', term_sheet_eligible: true }), findings: [] }; // finding cleared, gate gained
  const c = cockpit.composeCockpit({ current: curr, previous: prev, conditions: [] });
  assert.ok(c.diff, 'a diff exists with two runs');
  assert.strictEqual(c.diff.gates.term_sheet.direction, 'gained', 'term-sheet gate gained');
  assert.ok(c.diff.findings.removed.length >= 1, 'the fatal finding was cleared');
  assert.ok(c.previous && c.previous.id === 'run-0', 'previous run summarized');
  ok('two runs produce a real run-diff (gate gained + finding cleared)');
}

// 5. Hostile input never throws.
{
  for (const bad of [null, undefined, 42, 'x', { current: 'nope' }, { current: { run: 5 } }]) {
    const c = cockpit.composeCockpit(bad);
    assert.ok(c && typeof c === 'object' && c.hasRun === false, 'degrades to a safe panel');
  }
  ok('hostile input degrades to a safe empty panel (never throws)');
}

// 6. runToDecision maps the persisted snake_case shape to a decision the
//    presentational modules read (registry + both-cased gates).
{
  const d = cockpit._internals.runToDecision(runRow(), [finding()]);
  assert.strictEqual(d.status, 'ELIGIBLE');
  assert.strictEqual(d.termSheetEligible, true);
  assert.strictEqual(d.term_sheet_eligible, true);
  assert.strictEqual(d.registry.length, 1);
  assert.strictEqual(d.registry[0].blocks_ctc, true);
  ok('runToDecision reconstructs a decision-shaped object from a persisted run');
}

console.log(`\nrun-cockpit pure — ${passed} checks passed`);

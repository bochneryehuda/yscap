'use strict';
/**
 * R5.19 — pure tests for the evidence-invalidation cascade planner. Guarantees:
 * only the superseded document's spans are invalidated, a cleared condition
 * that relied on it reopens (source_superseded), and an unrelated condition is
 * left alone.
 */
const assert = require('assert');
const inval = require('../src/lib/underwriting/evidence-invalidation');
const depGraph = require('../src/lib/underwriting/dependency-graph');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// Build a small graph: doc D_old → obs → fact → finding → condition CD.
const graph = depGraph.build({
  documents: [{ id: 'D_old' }, { id: 'D_other' }],
  observations: [{ id: 'O1', documentId: 'D_old', factId: 'F1' }],
  facts: [{ id: 'F1' }],
  findings: [{ id: 'FN1', factId: 'F1' }],
  conditions: [{ id: 'CD1', findingIds: ['FN1'] }],
});

const ctx = {
  graph,
  spans: [
    { id: 's1', documentId: 'D_old' },
    { id: 's2', documentId: 'D_old' },
    { id: 's3', documentId: 'D_other' },   // different doc → untouched
  ],
  clearedConditions: [
    { id: 'CD1', kind: 'title', clearedAt: '2026-06-01', reliedOnDocumentIds: ['D_old'] },
    { id: 'CD2', kind: 'assets', clearedAt: '2026-06-01', reliedOnDocumentIds: ['D_unrelated'] },
  ],
};

const p = inval.plan('D_old', ctx);

// only the superseded doc's spans are invalidated.
assert.deepStrictEqual(p.spanIdsToInvalidate.sort(), ['s1', 's2'], 'only D_old spans invalidated');
assert.ok(!p.spanIdsToInvalidate.includes('s3'), 'another document\'s span is untouched');
ok('only the superseded document\'s spans are invalidated');

// the downstream finding + condition are surfaced.
assert.ok(p.downstreamFindingIds.includes('FN1'));
assert.ok(p.downstreamConditionIds.includes('CD1'));
ok('the downstream finding + condition are surfaced from the graph');

// the cleared condition that relied on D_old reopens (source_superseded).
const reopen = p.conditionsToReopen.find((c) => c.id === 'CD1');
assert.ok(reopen, 'CD1 reopens');
assert.strictEqual(reopen.trigger, 'source_superseded');
ok('a cleared condition that relied on the superseded doc reopens');

// the unrelated condition is left alone.
assert.ok(!p.conditionsToReopen.some((c) => c.id === 'CD2'), 'CD2 (unrelated) does not reopen');
ok('an unrelated cleared condition is left alone');

// a doc with no spans / no dependents → empty plan (no churn).
const empty = inval.plan('D_ghost', ctx);
assert.deepStrictEqual(empty.spanIdsToInvalidate, []);
assert.deepStrictEqual(empty.conditionsToReopen, []);
ok('a document with nothing downstream produces an empty plan');

// reachability alone (no explicit reliedOn) still reopens via the graph.
const ctx2 = {
  graph,
  spans: [],
  clearedConditions: [{ id: 'CD1', kind: 'title', clearedAt: '2026-06-01' }],  // no reliedOnDocumentIds
};
const p2 = inval.plan('D_old', ctx2);
assert.ok(p2.conditionsToReopen.some((c) => c.id === 'CD1'), 'graph-reachable condition reopens even without explicit reliedOn');
ok('a graph-reachable cleared condition reopens even without an explicit reliedOn list');

console.log(`\nR5.19 evidence-invalidation pure — ${passed} checks passed`);

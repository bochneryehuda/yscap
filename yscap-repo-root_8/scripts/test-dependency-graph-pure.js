'use strict';
/**
 * R5.22 — pure tests for the transaction dependency graph. Guarantees: edges
 * are only built between nodes the caller provided (never invented), and the
 * upstream/downstream walks correctly trace a symptom to its root document.
 */
const assert = require('assert');
const G = require('../src/lib/underwriting/dependency-graph');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// The owner's worked example: one amended OA (doc D_oa) drives an entity-name
// observation that supports the vesting fact, which conflicts with title +
// insurance, raising three findings that gate two conditions.
const input = {
  documents: [{ id: 'D_oa' }, { id: 'D_title' }, { id: 'D_ins' }],
  observations: [
    { id: 'O_oa_name', documentId: 'D_oa', factId: 'F_entity' },
    { id: 'O_title_name', documentId: 'D_title', factId: 'F_entity' },
    { id: 'O_ins_name', documentId: 'D_ins', factId: 'F_entity' },
    // signing authority is determined ONLY by the operating agreement — so the
    // OA uniquely reaches the authority finding, giving it the highest reach.
    { id: 'O_oa_auth', documentId: 'D_oa', factId: 'F_auth' },
  ],
  facts: [{ id: 'F_entity' }, { id: 'F_auth' }],
  conflicts: [{ id: 'C_name', observationIds: ['O_oa_name', 'O_title_name', 'O_ins_name'], factId: 'F_entity' }],
  findings: [
    { id: 'FN_title', conflictId: 'C_name' },
    { id: 'FN_ins', conflictId: 'C_name' },
    { id: 'FN_auth', factId: 'F_auth' },
  ],
  conditions: [
    { id: 'CD_entity', findingIds: ['FN_title', 'FN_ins'] },
    { id: 'CD_auth', findingIds: ['FN_auth'] },
  ],
};
const graph = G.build(input);

assert.strictEqual(graph.nodes.size, 3 + 4 + 2 + 1 + 3 + 2, 'all nodes created');
ok('every provided row becomes a node');

// downstream of the OA document reaches the findings + conditions.
const dn = G.downstream(graph, 'document:D_oa');
assert.ok(dn.includes('fact:F_entity'), 'OA doc reaches the entity fact');
assert.ok(dn.includes('finding:FN_title') && dn.includes('finding:FN_ins'), 'OA doc reaches title+insurance findings via the conflict');
assert.ok(dn.includes('condition:CD_entity'), 'OA doc reaches the entity condition');
ok('downstream walk traces a document to its findings + conditions');

// upstream of a condition reaches its root documents.
const up = G.upstream(graph, 'condition:CD_entity');
assert.ok(up.includes('document:D_oa') && up.includes('document:D_title') && up.includes('document:D_ins'));
ok('upstream walk traces a condition back to its source documents');

// rootDocuments ranks by downstream finding reach — the OA touches the most.
// walk from the AUTH condition (whose only root is the OA) + confirm ranking is
// descending by reach across the whole file's symptom set.
const rootsAuth = G.rootDocuments(graph, 'condition:CD_auth');
assert.strictEqual(rootsAuth[0].key, 'document:D_oa', 'the authority condition roots solely at the OA');
const rootsAll = G.rootDocuments(graph, 'finding:FN_title');
for (let i = 1; i < rootsAll.length; i++) {
  assert.ok(rootsAll[i - 1].reach >= rootsAll[i].reach, 'ranked descending by reach');
}
ok('rootDocuments ranks sources descending by downstream reach');

// the builder NEVER invents an edge to a missing node.
const g2 = G.build({ observations: [{ id: 'O1', documentId: 'GHOST', factId: 'F1' }], facts: [{ id: 'F1' }] });
// GHOST document was not provided → no document node, no produced edge.
assert.ok(!g2.nodes.has('document:GHOST'), 'a referenced-but-not-provided document is not created');
const producedEdges = g2.edges.filter((e) => e.kind === 'produced');
assert.strictEqual(producedEdges.length, 0, 'no edge to a non-existent node');
// the valid observation→fact supports edge IS built.
assert.strictEqual(g2.edges.filter((e) => e.kind === 'supports').length, 1);
ok('edges are only built between provided nodes (never invented)');

// empty input is safe.
const g3 = G.build({});
assert.strictEqual(g3.nodes.size, 0);
assert.deepStrictEqual(G.downstream(g3, 'x'), []);
ok('empty input yields an empty graph');

console.log(`\nR5.22 dependency-graph pure — ${passed} checks passed`);

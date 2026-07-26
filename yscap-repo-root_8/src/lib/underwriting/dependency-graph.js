'use strict';
/**
 * R5.22 — Transaction dependency graph (deterministic core).
 *
 * Root-cause reasoning needs the causal STRUCTURE of a file, not just a flat
 * list of findings. This module builds the directed graph the review specifies:
 *
 *   document → observation → fact → conflict → finding → condition
 *
 * so a root-cause search can walk UPSTREAM from a symptom to the earliest
 * invalid/stale source, and DOWNSTREAM from a source to everything it would
 * clear. It complements root-cause.js (which clusters findings by code): the
 * graph supplies the actual edges the clusters are asserted over.
 *
 * Pure: no DB, no AI. The caller collects the rows (twin observations, facts,
 * conflicts, findings, conditions, documents) and passes them in; this wires the
 * nodes + edges and exposes upstream/downstream walks. A node is only linked by
 * an id the caller actually provided — the builder NEVER invents an edge.
 *
 * Node kinds: document | observation | fact | conflict | finding | condition
 * Edge kinds: produced | supports | conflicts_with | raises | gates | superseded_by
 */

const NODE_KINDS = new Set(['document', 'observation', 'fact', 'conflict', 'finding', 'condition']);

function nid(kind, id) { return `${kind}:${id}`; }

/**
 * build(input) — input arrays (each item's shape in comments):
 *   documents:    [{id}]
 *   observations: [{id, documentId?, factId?, supersededByDocumentId?}]
 *   facts:        [{id}]
 *   conflicts:    [{id, observationIds?:[], factId?}]
 *   findings:     [{id, factId?, conflictId?, observationIds?:[]}]
 *   conditions:   [{id, findingIds?:[]}]
 * Returns { nodes: Map<string,node>, edges: [{from,to,kind}], adjacency, radjacency }.
 */
function build(input) {
  const nodes = new Map();
  const edges = [];
  const adjacency = new Map();   // from → [to]
  const radjacency = new Map();  // to → [from]

  const addNode = (kind, id, data) => {
    if (id == null) return null;
    const key = nid(kind, id);
    if (!nodes.has(key)) nodes.set(key, { key, kind, id, data: data || {} });
    return key;
  };
  const addEdge = (fromKey, toKey, kind) => {
    if (!fromKey || !toKey || !nodes.has(fromKey) || !nodes.has(toKey)) return;
    edges.push({ from: fromKey, to: toKey, kind });
    if (!adjacency.has(fromKey)) adjacency.set(fromKey, []);
    adjacency.get(fromKey).push(toKey);
    if (!radjacency.has(toKey)) radjacency.set(toKey, []);
    radjacency.get(toKey).push(fromKey);
  };

  const inp = input || {};
  for (const d of (inp.documents || [])) addNode('document', d.id, d);
  for (const f of (inp.facts || [])) addNode('fact', f.id, f);
  for (const o of (inp.observations || [])) addNode('observation', o.id, o);
  for (const c of (inp.conflicts || [])) addNode('conflict', c.id, c);
  for (const f of (inp.findings || [])) addNode('finding', f.id, f);
  for (const c of (inp.conditions || [])) addNode('condition', c.id, c);

  // document → observation (produced); observation → fact (supports).
  for (const o of (inp.observations || [])) {
    const oKey = nid('observation', o.id);
    if (o.documentId != null) addEdge(nid('document', o.documentId), oKey, 'produced');
    if (o.factId != null) addEdge(oKey, nid('fact', o.factId), 'supports');
    if (o.supersededByDocumentId != null) addEdge(nid('document', o.supersededByDocumentId), oKey, 'superseded_by');
  }
  // observations/fact → conflict (conflicts_with).
  for (const c of (inp.conflicts || [])) {
    const cKey = nid('conflict', c.id);
    for (const oid of (c.observationIds || [])) addEdge(nid('observation', oid), cKey, 'conflicts_with');
    if (c.factId != null) addEdge(nid('fact', c.factId), cKey, 'conflicts_with');
  }
  // fact/conflict/observation → finding (raises).
  for (const f of (inp.findings || [])) {
    const fKey = nid('finding', f.id);
    if (f.factId != null) addEdge(nid('fact', f.factId), fKey, 'raises');
    if (f.conflictId != null) addEdge(nid('conflict', f.conflictId), fKey, 'raises');
    for (const oid of (f.observationIds || [])) addEdge(nid('observation', oid), fKey, 'raises');
  }
  // finding → condition (gates).
  for (const c of (inp.conditions || [])) {
    const cKey = nid('condition', c.id);
    for (const fid of (c.findingIds || [])) addEdge(nid('finding', fid), cKey, 'gates');
  }

  return { nodes, edges, adjacency, radjacency };
}

// Walk forward from a node: everything it causally reaches (its blast radius).
function downstream(graph, nodeKey) {
  return _walk(graph.adjacency, nodeKey);
}
// Walk backward from a node: every upstream source it depends on.
function upstream(graph, nodeKey) {
  return _walk(graph.radjacency, nodeKey);
}
function _walk(adj, start) {
  const seen = new Set();
  const out = [];
  const stack = [...(adj.get(start) || [])];
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    for (const n of (adj.get(k) || [])) if (!seen.has(n)) stack.push(n);
  }
  return out;
}

// The document nodes at the root of a symptom (finding/condition) — the sources
// whose correction would propagate. Returns document keys, most-connected first.
function rootDocuments(graph, symptomKey) {
  const up = upstream(graph, symptomKey);
  const docs = up.filter((k) => k.startsWith('document:'));
  // rank by how many downstream findings each document touches.
  const scored = docs.map((d) => ({
    key: d,
    reach: downstream(graph, d).filter((k) => k.startsWith('finding:')).length,
  }));
  scored.sort((a, b) => b.reach - a.reach);
  return scored;
}

module.exports = { build, upstream, downstream, rootDocuments, NODE_KINDS, _internals: { nid } };

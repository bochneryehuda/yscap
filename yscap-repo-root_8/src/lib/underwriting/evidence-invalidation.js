'use strict';
/**
 * R5.19 — Evidence invalidation on source supersession (deterministic core).
 *
 * When a document is superseded (a newer version replaces it), everything
 * downstream that relied on it must be revisited: its evidence spans go
 * inactive, and any cleared condition it supported must reopen. This module
 * PLANS that cascade by composing the dependency graph (R5.22) with the
 * condition-reopen decision (R5.31) — it returns a plan; the caller applies it
 * through the normal audited paths (evidence-ledger.supersedeSpansForDocument +
 * the condition reopen).
 *
 * NON-DESTRUCTIVE: spans are marked 'superseded', never deleted (one-way
 * evidence, mirrors the no-delete policy). A condition only reopens if it was
 * actually cleared AND the superseded document is one it relied on.
 *
 * Pure: no DB, no AI. The caller supplies the graph + the file's spans +
 * cleared conditions; this decides what to touch.
 */

const depGraph = require('./dependency-graph');
const conditionReopen = require('./condition-reopen');

/**
 * plan(supersededDocumentId, ctx) →
 *   ctx: {
 *     graph,                 // a dependency-graph.build() result
 *     spans: [{id, documentId}],           // the file's evidence spans
 *     clearedConditions: [{id, kind, clearedAt, guidelineVersionId, reliedOnDocumentIds:[]}]
 *   }
 * Returns {
 *   spanIdsToInvalidate: [],
 *   downstreamFindingIds: [],
 *   downstreamConditionIds: [],
 *   conditionsToReopen: [{ id, trigger, reason }],
 * }
 */
function plan(supersededDocumentId, ctx) {
  const c = ctx || {};
  const docId = supersededDocumentId;

  // 1) spans sourced from the superseded document → invalidate.
  const spanIdsToInvalidate = (c.spans || [])
    .filter((s) => s && String(s.documentId) === String(docId))
    .map((s) => s.id);

  // 2) walk the dependency graph downstream from the document node to find the
  // findings + conditions it causally reaches (for surfacing / review).
  let downstreamFindingIds = [];
  let downstreamConditionIds = [];
  if (c.graph) {
    const dn = depGraph.downstream(c.graph, `document:${docId}`);
    downstreamFindingIds = dn.filter((k) => k.startsWith('finding:')).map((k) => k.slice('finding:'.length));
    downstreamConditionIds = dn.filter((k) => k.startsWith('condition:')).map((k) => k.slice('condition:'.length));
  }

  // 3) a cleared condition that RELIED ON this document reopens (source_superseded).
  const conditionsToReopen = [];
  for (const cond of (c.clearedConditions || [])) {
    const relied = Array.isArray(cond.reliedOnDocumentIds) && cond.reliedOnDocumentIds.map(String).includes(String(docId));
    // Also reopen if the graph shows the document reaches this condition.
    const reachable = downstreamConditionIds.map(String).includes(String(cond.id));
    if (!relied && !reachable) continue;
    const decision = conditionReopen.decide(
      { cleared: true, kind: cond.kind, clearedAt: cond.clearedAt, guidelineVersionId: cond.guidelineVersionId },
      { supersededSourceIds: [docId] });
    if (decision.reopen) conditionsToReopen.push({ id: cond.id, trigger: decision.trigger, reason: decision.reason });
  }

  return { spanIdsToInvalidate, downstreamFindingIds, downstreamConditionIds, conditionsToReopen };
}

module.exports = { plan };

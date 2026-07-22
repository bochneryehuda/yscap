'use strict';
/**
 * R5.44 — Golden evaluation dataset seed builder (deterministic core, ADVISORY).
 *
 * The offline replay runner (R5.45) and the release gates (R5.46) are only as good
 * as the cases they run against. A naive "last 100 files" sample under-weights the
 * failures that actually matter: a FALSE CLEAR (the AI would have cleared a loan a
 * human declined) is a hundred times more dangerous than a formatting nit, yet a
 * flat sample treats them equally. This module turns a pile of historical
 * underwriter CORRECTIONS into a weighted golden dataset that deliberately
 * over-samples the fatal / false-clear risk, so the eval battery spends its budget
 * where a regression would hurt.
 *
 * For each correction it:
 *   1. classifies the AI-vs-human DIRECTION (reusing shadow-decision.js — one
 *      source of truth for false-clear vs false-flag),
 *   2. assigns a RISK TIER (fatal › false_clear › material › minor) and a WEIGHT,
 *   3. de-duplicates by a stable case key,
 *   4. selects to a target size, STRATIFIED so every tier + component keeps
 *      representation (never drops all the minors, never all one component),
 *      filling the remaining budget by descending weight.
 *
 * Pure: no DB, no AI, no I/O. It seeds a dataset a human curates before it becomes
 * the frozen golden set; it trains nothing and decides nothing. Never throws.
 */

const shadow = require('./shadow-decision');

// Risk tiers, worst first, with the base weight each contributes to the eval.
const TIER = Object.freeze({ FATAL: 'fatal', FALSE_CLEAR: 'false_clear', MATERIAL: 'material', MINOR: 'minor' });
const TIER_WEIGHT = Object.freeze({ fatal: 5, false_clear: 4, material: 2, minor: 1 });
const TIER_RANK = Object.freeze({ fatal: 0, false_clear: 1, material: 2, minor: 3 });

// Words a correction's severity field may carry that mean "fatal".
const FATAL_WORDS = new Set(['fatal', 'critical', 'severe', 'blocker', 'material_defect']);

function normKey(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * classifyCorrection(correction) → { tier, weight, direction, component, key } | null.
 *   correction: { id?, component?, aiVerdict|ai_decision, correctVerdict|humanVerdict|correct,
 *                 severity?, weight?, input?, expected?, tags? }
 * Returns null when the AI AGREED with the human (nothing to learn) or a verdict is
 * unreadable (can't be scored). Otherwise:
 *   - a FALSE CLEAR is tier false_clear, escalated to fatal when severity says so;
 *   - a false flag / partial disagreement is material / minor.
 * An explicit numeric `correction.weight` multiplies the tier's base weight (so a
 * human can hand-boost a known-nasty case) but never below the tier floor.
 */
function classifyCorrection(correction) {
  const c = correction || {};
  const ai = c.aiVerdict != null ? c.aiVerdict : c.ai_decision;
  const human = c.correctVerdict != null ? c.correctVerdict
    : (c.humanVerdict != null ? c.humanVerdict : (c.correct != null ? c.correct : c.human));
  const cmp = shadow.compareToHuman({ component: c.component, verdict: ai }, { verdict: human });
  if (cmp.class === shadow.CLASS.AGREE || cmp.class === shadow.CLASS.UNKNOWN) return null;

  const severityFatal = FATAL_WORDS.has(String(c.severity == null ? '' : c.severity).toLowerCase());
  let tier;
  if (cmp.class === shadow.CLASS.FALSE_CLEAR) tier = severityFatal ? TIER.FATAL : TIER.FALSE_CLEAR;
  else if (cmp.class === shadow.CLASS.FALSE_FLAG) tier = severityFatal ? TIER.MATERIAL : TIER.MINOR;
  else tier = TIER.MINOR; // partial
  // a fatal severity on a non-clear disagreement still lifts it to at least material
  if (severityFatal && TIER_RANK[tier] > TIER_RANK[TIER.MATERIAL]) tier = TIER.MATERIAL;

  const base = TIER_WEIGHT[tier];
  const mult = num(c.weight);
  const weight = mult != null && mult > 0 ? Math.max(base, +(base * mult).toFixed(3)) : base;

  const component = c.component != null ? String(c.component) : 'unknown';
  // Stable de-dupe key: an explicit id wins; else component + the verdict pair +
  // a light input signature, so the same correction submitted twice collapses.
  const key = c.id != null ? `id:${String(c.id)}`
    : `${normKey(component)}|${cmp.aiVerdict}|${cmp.humanVerdict}|${normKey(typeof c.input === 'string' ? c.input : JSON.stringify(c.input || ''))}`;

  return { tier, weight, direction: cmp.class, component, key };
}

/**
 * buildDataset(corrections, opts?) → {
 *   cases: [{ id, key, component, tier, weight, direction, input, expected, tags }],
 *   total,               // corrections that were real disagreements (candidates)
 *   selected,            // cases in the dataset after cap
 *   weightedTotal,       // sum of selected weights
 *   tierDistribution,    // { fatal, false_clear, material, minor } counts (selected)
 *   componentCoverage,   // { [component]: count } (selected)
 *   droppedForCap,       // candidates not selected because of the target-size cap
 *   skipped,             // agrees / unreadable / junk (not candidates)
 * }
 *   opts.targetSize: max cases (default 100).
 *   opts.minPerComponent: reserve at least this many of each component before the
 *     weight-ranked fill (default 1) so no component is starved.
 * Selection: de-dupe → keep the highest-weight instance of each key → sort by
 * weight desc (tier rank, then weight, then key for determinism) → reserve
 * minPerComponent per component and at least one of each present tier → fill the
 * remaining budget by weight. Deterministic; never throws.
 */
function buildDataset(corrections, opts = {}) {
  const list = Array.isArray(corrections) ? corrections : [];
  const targetSize = Number.isInteger(opts.targetSize) && opts.targetSize > 0 ? opts.targetSize : 100;
  const minPerComponent = Number.isInteger(opts.minPerComponent) && opts.minPerComponent >= 0 ? opts.minPerComponent : 1;

  let skipped = 0;
  const byKey = new Map();
  for (const c of list) {
    const cls = classifyCorrection(c);
    if (!cls) { skipped++; continue; }
    const rec = {
      id: c && c.id != null ? String(c.id) : cls.key,
      key: cls.key,
      component: cls.component,
      tier: cls.tier,
      weight: cls.weight,
      direction: cls.direction,
      input: c && c.input !== undefined ? c.input : null,
      expected: c && c.expected !== undefined ? c.expected
        : (c && (c.correctVerdict != null ? c.correctVerdict : (c.humanVerdict != null ? c.humanVerdict : (c.correct != null ? c.correct : null)))),
      tags: Array.isArray(c && c.tags) ? c.tags : [],
    };
    // keep the highest-weight instance of a duplicated key
    const prev = byKey.get(cls.key);
    if (!prev || rec.weight > prev.weight) byKey.set(cls.key, rec);
  }

  const candidates = [...byKey.values()];
  const total = candidates.length;
  // deterministic ranking: worst tier first, then heaviest, then key.
  const ranked = candidates.slice().sort((a, b) =>
    (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.weight - a.weight) || a.key.localeCompare(b.key));

  const selected = [];
  const seen = new Set();
  const take = (rec) => { if (!seen.has(rec.key) && selected.length < targetSize) { seen.add(rec.key); selected.push(rec); } };

  // 1. reserve at least one of every present TIER (so a regression in any tier is caught).
  for (const tier of [TIER.FATAL, TIER.FALSE_CLEAR, TIER.MATERIAL, TIER.MINOR]) {
    const first = ranked.find((r) => r.tier === tier && !seen.has(r.key));
    if (first) take(first);
  }
  // 2. reserve minPerComponent of each component (highest-weight first).
  if (minPerComponent > 0) {
    const perComp = new Map();
    for (const r of ranked) {
      if (seen.has(r.key)) continue;
      const n = perComp.get(r.component) || 0;
      if (n < minPerComponent) { take(r); perComp.set(r.component, n + 1); }
    }
  }
  // 3. fill the remaining budget by weight.
  for (const r of ranked) take(r);

  const tierDistribution = { fatal: 0, false_clear: 0, material: 0, minor: 0 };
  const componentCoverage = {};
  let weightedTotal = 0;
  for (const r of selected) {
    tierDistribution[r.tier] = (tierDistribution[r.tier] || 0) + 1;
    componentCoverage[r.component] = (componentCoverage[r.component] || 0) + 1;
    weightedTotal += r.weight;
  }
  // keep the dataset itself in ranked order for a stable, review-friendly output.
  selected.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.weight - a.weight) || a.key.localeCompare(b.key));

  return {
    cases: selected,
    total,
    selected: selected.length,
    weightedTotal: +weightedTotal.toFixed(3),
    tierDistribution,
    componentCoverage,
    droppedForCap: Math.max(0, total - selected.length),
    skipped,
  };
}

module.exports = {
  buildDataset,
  classifyCorrection,
  TIER,
  TIER_WEIGHT,
  _internals: { normKey, num },
};

'use strict';
/**
 * R5.34 — Guideline semantic diff (deterministic core).
 *
 * Owner's explicit ask: "connect your knowledge directly linked to the program
 * guidelines — auto-link so you know when they get updated." When a new
 * guideline version is ingested, this compares it against the prior version's
 * rules and produces a HUMAN-REVIEWABLE semantic diff (added / removed /
 * changed rules), so a guideline change is surfaced for review and never
 * silently alters live decisions.
 *
 * Pure: no DB, no AI. The caller loads the two rule sets (from guideline_rules,
 * db/258) and passes them in; this diffs by rule_key and reports exactly what
 * changed in each rule's scope / expression / outcome / materiality.
 *
 * A diff is DESCRIPTIVE — it never applies anything. Applying a new version is a
 * separate, human-approved step (activateVersion in guideline-knowledge.js).
 */

// Deep-canonicalize for stable equality (recursively sort object keys; array
// order preserved). Mirrors guideline-precedence.canon.
function canon(v) {
  if (v == null || typeof v !== 'object') return v ?? null;
  if (Array.isArray(v)) return v.map(canon);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
  return out;
}
function eqJson(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

const COMPARED_FIELDS = ['scope', 'expression', 'outcome', 'materiality', 'exception_allowed', 'exception_authority'];

// Index a rule array by rule_key (last one wins on a dup, but rule_key is
// unique per version by the db/258 index).
function byKey(rules) {
  const m = new Map();
  for (const r of (rules || [])) {
    if (r && r.rule_key != null) m.set(String(r.rule_key), r);
  }
  return m;
}

/**
 * diff(prevRules, nextRules) → {
 *   added:   [{rule_key, rule}],
 *   removed: [{rule_key, rule}],
 *   changed: [{rule_key, fields:[{field, from, to}]}],
 *   unchanged: number,
 *   summary: {added, removed, changed, unchanged},
 *   materialityEscalations: [{rule_key, from, to}]   // stricter → flagged
 * }
 */
function diff(prevRules, nextRules) {
  const prev = byKey(prevRules);
  const next = byKey(nextRules);
  const added = [];
  const removed = [];
  const changed = [];
  const materialityEscalations = [];
  let unchanged = 0;

  const RANK = { info: 1, warning: 2, material: 3, hard_stop: 4 };

  for (const [key, r] of next) {
    if (!prev.has(key)) { added.push({ rule_key: key, rule: r }); continue; }
    const p = prev.get(key);
    const fields = [];
    for (const f of COMPARED_FIELDS) {
      if (!eqJson(p[f], r[f])) fields.push({ field: f, from: p[f] ?? null, to: r[f] ?? null });
    }
    if (fields.length) {
      changed.push({ rule_key: key, fields });
      // A materiality change toward stricter (e.g. warning → hard_stop) is
      // called out separately — it tightens eligibility and warrants attention.
      const from = RANK[p.materiality] || 0;
      const to = RANK[r.materiality] || 0;
      if (to !== from) materialityEscalations.push({ rule_key: key, from: p.materiality, to: r.materiality, stricter: to > from });
    } else {
      unchanged++;
    }
  }
  for (const [key, r] of prev) {
    if (!next.has(key)) removed.push({ rule_key: key, rule: r });
  }

  return {
    added, removed, changed, unchanged, materialityEscalations,
    summary: { added: added.length, removed: removed.length, changed: changed.length, unchanged },
    hasChanges: !!(added.length || removed.length || changed.length),
  };
}

// A short, plain-language line per change for a review email / UI.
function describe(d) {
  const lines = [];
  for (const a of d.added) lines.push(`+ NEW rule "${a.rule_key}"`);
  for (const r of d.removed) lines.push(`- REMOVED rule "${r.rule_key}"`);
  for (const c of d.changed) lines.push(`~ CHANGED "${c.rule_key}": ${c.fields.map((f) => f.field).join(', ')}`);
  return lines;
}

module.exports = { diff, describe, _internals: { canon, eqJson, byKey } };

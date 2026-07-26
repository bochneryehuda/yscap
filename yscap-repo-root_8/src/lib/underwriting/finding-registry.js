'use strict';
/**
 * R6.9 — Consolidated finding registry (deterministic core).
 *
 * A whole-loan run gathers findings from every desk — document, appraisal,
 * tie-out, program, structure, liquidity, experience, and system-reconciliation.
 * The review requires ONE deduplicated registry (not N separate UI islands), so
 * the same real-world issue raised by two desks appears once, at its highest
 * severity, carrying every source that raised it.
 *
 * Dedup key = (code, subject) — the same finding code about the same subject is
 * one finding. Severity is the MAX across the merged group (fatal > warning >
 * info); the blocks_* flags OR together (if any source says it blocks funding,
 * it blocks funding).
 *
 * Pure: no DB, no AI.
 */

const SEV_RANK = { fatal: 3, warning: 2, info: 1 };
function sevRank(s) { return SEV_RANK[String(s || '').toLowerCase()] || 0; }
function maxSev(a, b) { return sevRank(a) >= sevRank(b) ? a : b; }

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// A stable dedup key for a finding: its code + the subject it is about.
function keyOf(f) {
  return `${norm(f.code)}::${norm(f.subject || f.field || '')}`;
}

/**
 * consolidate(findings) → deduped [{code, subject, severity, category, title,
 *   explanation, governing_rule, expected_value, actual_value, permitted_actions,
 *   sources:[], blocks_term_sheet, blocks_ctc, blocks_funding, evidence:[] }],
 *   ordered fatal → warning → info then by title.
 */
function consolidate(findings) {
  const byKey = new Map();
  for (const f of (findings || [])) {
    if (!f || !f.code) continue;
    const k = keyOf(f);
    const src = f.source || f.desk || 'unknown';
    if (!byKey.has(k)) {
      byKey.set(k, {
        code: f.code,
        subject: f.subject || f.field || null,
        severity: f.severity || 'info',
        category: f.category || null,
        title: f.title || f.code,
        explanation: f.explanation || null,
        // Carry the evidentiary fields through so persistRun stores them in the
        // run_findings columns instead of NULL — every finding built with
        // expected/actual (structure caps, the AVM verification finding, …) keeps
        // its numbers on the immutable decision record, not only in the prose.
        governing_rule: f.governing_rule || null,
        expected_value: f.expected_value != null ? f.expected_value : null,
        actual_value: f.actual_value != null ? f.actual_value : null,
        permitted_actions: Array.isArray(f.permitted_actions) ? [...f.permitted_actions] : [],
        sources: [src],
        blocks_term_sheet: !!f.blocks_term_sheet,
        blocks_ctc: !!f.blocks_ctc,
        blocks_funding: !!f.blocks_funding,
        evidence: Array.isArray(f.evidence) ? [...f.evidence] : (f.evidence ? [f.evidence] : []),
      });
    } else {
      const cur = byKey.get(k);
      cur.severity = maxSev(cur.severity, f.severity || 'info');
      if (!cur.sources.includes(src)) cur.sources.push(src);
      cur.blocks_term_sheet = cur.blocks_term_sheet || !!f.blocks_term_sheet;
      cur.blocks_ctc = cur.blocks_ctc || !!f.blocks_ctc;
      cur.blocks_funding = cur.blocks_funding || !!f.blocks_funding;
      if (f.explanation && !cur.explanation) cur.explanation = f.explanation;
      // first non-null wins for the evidentiary fields (mirrors explanation).
      if (f.governing_rule && !cur.governing_rule) cur.governing_rule = f.governing_rule;
      if (f.expected_value != null && cur.expected_value == null) cur.expected_value = f.expected_value;
      if (f.actual_value != null && cur.actual_value == null) cur.actual_value = f.actual_value;
      if (Array.isArray(f.permitted_actions) && f.permitted_actions.length && (!cur.permitted_actions || !cur.permitted_actions.length)) cur.permitted_actions = [...f.permitted_actions];
      if (Array.isArray(f.evidence)) cur.evidence.push(...f.evidence);
      else if (f.evidence) cur.evidence.push(f.evidence);
    }
  }
  const out = Array.from(byKey.values());
  out.sort((a, b) => {
    const s = sevRank(b.severity) - sevRank(a.severity);
    if (s !== 0) return s;
    return String(a.title).localeCompare(String(b.title));
  });
  return out;
}

// Convenience summaries over a consolidated registry.
function summarize(registry) {
  const r = registry || [];
  return {
    total: r.length,
    fatal: r.filter((f) => norm(f.severity) === 'fatal').length,
    warning: r.filter((f) => norm(f.severity) === 'warning').length,
    info: r.filter((f) => norm(f.severity) === 'info').length,
    // A FATAL finding blocks the term sheet too — mirroring the CTC/funding
    // rows below AND issuance-gate.blockersFor, which already treats any fatal
    // as a term-sheet blocker (fix 2026-07-23: the asymmetry let a fatal
    // appraisal finding leave termSheetEligible true).
    blocksTermSheet: r.some((f) => f.blocks_term_sheet || norm(f.severity) === 'fatal'),
    blocksCtc: r.some((f) => f.blocks_ctc || norm(f.severity) === 'fatal'),
    blocksFunding: r.some((f) => f.blocks_funding || norm(f.severity) === 'fatal'),
    hasFatal: r.some((f) => norm(f.severity) === 'fatal'),
  };
}

module.exports = { consolidate, summarize, keyOf, sevRank, _internals: { maxSev, norm } };

'use strict';
/**
 * R6.10 + R6.11 — System reconciliation (deterministic core).
 *
 * The authoritative loan structure lives in the whole-loan context (registration
 * governs). The connected systems — ClickUp (workflow) and Encompass (the LOS
 * copy) — must MATCH that structure; they are NOT the authority for program
 * numbers. This module compares the context's governing values against a
 * connected system's mirrored values and produces reconciliation findings
 * ("ClickUp shows a different loan amount") for the ONE run registry.
 *
 * HARD RULE: this NEVER writes to a connected system and NEVER changes a loan
 * value. It reports disagreements. (Encompass is read-only by policy; ClickUp
 * writes have their own guarded path — this module is read/compare only.)
 *
 * Pure: no DB, no AI, no network. Consumes already-loaded values.
 */

function num(v) { return (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Number(v); }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// Two values agree if equal after light normalization (numbers within a cent;
// strings case/space-insensitive). Null on either side = "not comparable".
function agree(a, b) {
  if (a == null || b == null) return null;
  const na = num(a), nb = num(b);
  if (na != null && nb != null) return Math.abs(na - nb) < 0.005;
  return norm(a) === norm(b);
}

// The material structure fields each system is expected to mirror. `kind` drives
// the comparison tolerance; `label` is the human name for the finding.
const MATERIAL_FIELDS = Object.freeze([
  { key: 'loan_amount', label: 'loan amount', kind: 'money' },
  { key: 'program', label: 'program', kind: 'text' },
  { key: 'property_type', label: 'property type', kind: 'text' },
  { key: 'units', label: 'units', kind: 'int' },
  { key: 'purchase_price', label: 'purchase price', kind: 'money' },
  { key: 'as_is_value', label: 'as-is value', kind: 'money' },
  { key: 'arv', label: 'ARV', kind: 'money' },
  { key: 'rehab_budget', label: 'rehab budget', kind: 'money' },
  { key: 'note_rate', label: 'note rate', kind: 'rate' },
]);

/**
 * reconcileSystem({ system, context, systemValues, fields }) → { findings, compared, mismatches }.
 *   system:       'clickup' | 'encompass' | <label>
 *   context:      the whole-loan context (R6.3) — governing values authority.
 *   systemValues: { fieldKey: value } pulled from the connected system.
 *   fields:       optional subset of MATERIAL_FIELDS keys to compare.
 * A mismatch is a WARNING finding (a workflow/LOS copy disagreeing must be
 * reconciled, but it does not by itself make the loan ineligible). A field
 * absent on either side is skipped (not a finding — it just isn't mirrored yet).
 */
function reconcileSystem(inputs) {
  const i = inputs || {};
  const system = i.system || 'system';
  const ctxValues = (i.context && i.context.values) || {};
  const sys = i.systemValues || {};
  const want = i.fields && i.fields.length
    ? MATERIAL_FIELDS.filter((f) => i.fields.includes(f.key)) : MATERIAL_FIELDS;

  const findings = [];
  let compared = 0;
  const mismatches = [];
  for (const f of want) {
    const authoritative = ctxValues[f.key];
    const mirrored = sys[f.key];
    const verdict = agree(authoritative, mirrored);
    if (verdict === null) continue; // not comparable (one side absent) — not a finding
    compared += 1;
    if (verdict === false) {
      mismatches.push({ field: f.key, authoritative, mirrored });
      findings.push({
        code: `${system}_${f.key}_mismatch`,
        subject: f.key,
        severity: 'warning',
        category: 'system_reconciliation',
        title: `${cap(system)} ${f.label} differs from the registered structure`,
        explanation: `Registered ${f.label} ${fmt(authoritative)}; ${cap(system)} shows ${fmt(mirrored)}.`,
        source: system,
        governing_rule: `${cap(system)} must mirror the registered structure`,
        expected_value: authoritative,
        actual_value: mirrored,
        blocks_term_sheet: false,
        blocks_ctc: false,
        blocks_funding: false,
      });
    }
  }
  return { findings, compared, mismatches, matched: compared - mismatches.length };
}

function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
function fmt(v) { return v == null ? '(blank)' : String(v); }

/**
 * reconcileClickup(context, clickupValues) → findings + summary.
 * ClickUp mirrors the full structure (workflow system). Encompass mirrors the LOS
 * copy (read-only). Both use the same value-comparison; the only difference is the
 * declared field set + label.
 */
function reconcileClickup(context, clickupValues) {
  return reconcileSystem({ system: 'clickup', context, systemValues: clickupValues });
}
function reconcileEncompass(context, encompassValues) {
  // Encompass is the reconciled LOS copy — the same money/rate fields matter.
  return reconcileSystem({ system: 'encompass', context, systemValues: encompassValues,
    fields: ['loan_amount', 'note_rate', 'program', 'property_type', 'units', 'purchase_price', 'arv', 'rehab_budget'] });
}

module.exports = { reconcileSystem, reconcileClickup, reconcileEncompass, MATERIAL_FIELDS, _internals: { agree } };

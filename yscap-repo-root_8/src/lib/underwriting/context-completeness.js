'use strict';
/**
 * #203 — Whole-loan context DATA COMPLETENESS (advisory scorer).
 *
 * The canonical whole-loan context (whole-loan-context.js) resolves every
 * structure fact + its provenance and flags the REQUIRED keys that are missing.
 * This module turns that raw assembly into a plain "how complete is this file,
 * and what's missing, and where would it come from" report — so a run can say,
 * honestly, whether it had enough to stand on.
 *
 * It answers three things the raw context doesn't spell out:
 *   1. COVERAGE — what fraction of the governed facts are present, and which
 *      REQUIRED keys are still missing (the context is NOT_READY without them).
 *   2. PROVENANCE — where each present fact came from, and specifically whether
 *      the two facts that most often decide a loan — LIQUIDITY and FICO — are
 *      backed by a real source (a document/API/registration) vs absent.
 *   3. GAPS — for every missing critical fact, a plain remediation hint naming
 *      the source that would fill it (a document, the Encompass pull, a
 *      direct-source API) — so "incomplete" comes with a next step.
 *
 * ADVISORY ONLY. It gates NOTHING and blocks NOTHING — an incomplete context is
 * a HARD WARNING a human reads, never a stop (governing rule #217). PURE: reads
 * an already-assembled context object; no DB, no clock, no I/O. NEVER THROWS.
 */

// The facts that most decide a loan and where a missing one is typically sourced.
// Advisory guidance only — never authoritative over a value.
const CRITICAL_KEYS = Object.freeze([
  { key: 'program', label: 'program', source: 'register the product' },
  { key: 'loan_amount', label: 'loan amount', source: 'register the product' },
  { key: 'fico', label: 'credit score (FICO)', source: 'a credit report document or the credit pull' },
  { key: 'as_is_value', label: 'as-is value', source: 'the appraisal' },
  { key: 'arv', label: 'after-repair value', source: 'the appraisal' },
]);

function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function low(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/** fieldEntries(ctx) → [{key, value, source, confidence, present}] over ctx.fields. PURE. */
function fieldEntries(ctx) {
  const fields = ctx && ctx.fields && typeof ctx.fields === 'object' ? ctx.fields : {};
  return Object.keys(fields).map((key) => {
    const f = fields[key] || {};
    const present = f.value !== null && f.value !== undefined && f.value !== '';
    return { key, value: present ? f.value : null, source: f.governingSource || null, confidence: f.confidence || 'unknown', present };
  });
}

/**
 * completenessReport(ctx, opts?) → {
 *   ready, requiredMissing:[keys],
 *   coverage:{ present, total, rate, requiredPresent, requiredTotal },
 *   provenance:{ bySource:{source:count}, distinctSources, apiVerified, documentBacked, present },
 *   liquidity:{ supplied, required, verified, shortfall, satisfied },
 *   fico:{ present, source, confidence },
 *   discrepancyCount, byField:[...], gaps:[{key,label,source}], score, status
 * }   (PURE, NEVER THROWS)
 *   ctx = the output of whole-loan-context.assembleContext (or a compatible shape).
 */
function completenessReport(ctx, opts = {}) {
  try {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const entries = fieldEntries(c);
    const total = entries.length;
    const present = entries.filter((e) => e.present).length;

    // required coverage: prefer the context's own missingRequired list; fall back
    // to recomputing from a `required` flag if the caller supplied field metadata.
    const requiredMissing = Array.isArray(c.missingRequired) ? c.missingRequired.slice() : [];
    const requiredKeys = Array.isArray(opts.requiredKeys) && opts.requiredKeys.length
      ? opts.requiredKeys.slice()
      : requiredMissing.slice(); // at minimum, the missing ones are required
    const requiredTotal = requiredKeys.length ? new Set(requiredKeys).size : requiredMissing.length;
    const requiredPresent = Math.max(0, requiredTotal - requiredMissing.length);

    // provenance rollup over present facts.
    const bySource = {};
    for (const e of entries) {
      if (!e.present) continue;
      const s = low(e.source) || 'unknown';
      bySource[s] = (bySource[s] || 0) + 1;
    }
    const distinctSources = Object.keys(bySource).length;
    const apiVerified = bySource.api_verification || 0;
    const documentBacked = (bySource.document || 0) + (bySource.appraisal || 0);

    // liquidity provenance (supplied vs absent; shortfall known).
    const liq = c.liquidity && typeof c.liquidity === 'object' ? c.liquidity : null;
    const liquidity = {
      supplied: !!(liq && (liq.required != null || liq.verified != null)),
      required: liq ? toNum(liq.required) : null,
      verified: liq ? toNum(liq.verified) : null,
      shortfall: liq ? toNum(liq.shortfall) : null,
      satisfied: !!(liq && liq.shortfall != null && toNum(liq.shortfall) === 0),
    };

    // FICO provenance specifically (the single most-cited underwriting fact).
    const ficoField = (c.fields && c.fields.fico) || {};
    const ficoPresent = ficoField.value !== null && ficoField.value !== undefined && ficoField.value !== '';
    const fico = { present: ficoPresent, source: ficoField.governingSource || null, confidence: ficoField.confidence || 'unknown' };

    // gaps: every critical key that's absent, with a remediation hint.
    const presentSet = new Set(entries.filter((e) => e.present).map((e) => e.key));
    const gaps = CRITICAL_KEYS.filter((k) => !presentSet.has(k.key)).map((k) => ({ key: k.key, label: k.label, source: k.source }));
    // any required-missing key not already a named critical gets a generic gap too.
    for (const k of requiredMissing) {
      if (!gaps.some((g) => g.key === k)) gaps.push({ key: k, label: k, source: 'complete the file' });
    }

    const discrepancyCount = Array.isArray(c.discrepancies) ? c.discrepancies.length : 0;

    // score: present-fraction, but a missing REQUIRED key caps it hard (a file
    // that's missing its program or loan amount is not "80% complete").
    const rate = total > 0 ? +(present / total).toFixed(4) : 0;
    let score = rate;
    if (requiredMissing.length) score = Math.min(score, 0.5);
    score = +score.toFixed(4);

    const ready = c.ready === true || (requiredMissing.length === 0 && total > 0);
    let status;
    if (!total) status = 'insufficient';
    else if (requiredMissing.length) status = 'insufficient';
    else if (gaps.length) status = 'partial';
    else status = 'complete';

    return {
      ready,
      requiredMissing,
      coverage: { present, total, rate, requiredPresent, requiredTotal },
      provenance: { bySource, distinctSources, apiVerified, documentBacked, present },
      liquidity, fico,
      discrepancyCount,
      byField: entries,
      gaps, score, status,
    };
  } catch (_e) {
    return {
      ready: false, requiredMissing: [],
      coverage: { present: 0, total: 0, rate: 0, requiredPresent: 0, requiredTotal: 0 },
      provenance: { bySource: {}, distinctSources: 0, apiVerified: 0, documentBacked: 0, present: 0 },
      liquidity: { supplied: false, required: null, verified: null, shortfall: null, satisfied: false },
      fico: { present: false, source: null, confidence: 'unknown' },
      discrepancyCount: 0, byField: [], gaps: [], score: 0, status: 'insufficient',
    };
  }
}

module.exports = { completenessReport, fieldEntries, CRITICAL_KEYS };

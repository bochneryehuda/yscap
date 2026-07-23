'use strict';
/**
 * #192 — Guideline-intelligence ORCHESTRATOR (turns on the dormant stack).
 *
 * The R5.32–39 knowledge graph shipped every PIECE but nothing wired them
 * together against a live file: the deterministic evaluator (guideline-evaluator),
 * the precedence resolver (guideline-precedence), the DB rule loader
 * (guideline-knowledge.activeRules), the investor-fit ranker (investor-fit) and
 * the citation formatter (guideline-citation). This module is the missing
 * composition layer: given a file's flat rule CONTEXT (the SAME context the
 * conditions engine builds — conditions/engine.loadRuleContext) and the active
 * guideline rules, it produces one advisory report — per-rule verdict + plain
 * citation, precedence resolution per rule_key, and an investor-fit ranking.
 *
 * ADVISORY ONLY. It changes no decision, clears no condition, sizes no loan, and
 * touches NO frozen pricing/guideline number — it READS the frozen baselines that
 * db/260 recorded as knowledge-graph data and explains them against the file. The
 * pure core has no DB/AI/I-O and never throws on hostile input (mirrors the
 * sibling modules' contract); the thin DB loader at the bottom is best-effort.
 *
 * Rule shape (a guideline_rules / internal_overlays row):
 *   scope       flat applicability map — every key must match the context
 *               (e.g. {is_assignment:true}); {} = applies to every file.
 *   expression  the PASS/FAIL test, evaluated by guideline-evaluator against the
 *               context (e.g. {field:'fico',cmp:'>=',value:600}); {} = nothing to
 *               test, the rule just RECORDS a fact (its outcome).
 *   outcome     the recorded requirement/fact (display/data only, never a test).
 *
 * Per-rule verdict:
 *   not_applicable  scope did not match this file.
 *   noted           applies, but has no test — an informational recorded rule.
 *   met             applies and the file satisfies the test.
 *   violated        applies and the file FAILS the test on a KNOWN value.
 *   indeterminate   applies and fails, but only because the value is UNKNOWN
 *                   (missing from the context) — never reported as a real breach.
 */

const evaluator = require('./guideline-evaluator');
const precedence = require('./guideline-precedence');
const citation = require('./guideline-citation');
const investorFit = require('./investor-fit');

// materiality (guideline_rules.materiality) → a neutral severity the fit ranker +
// citation understand. hard_stop is the only fatal; info never blocks.
const SEVERITY_BY_MATERIALITY = Object.freeze({
  hard_stop: 'fatal',
  material: 'high',
  warning: 'medium',
  info: 'advisory',
});
function severityOf(materiality) {
  return SEVERITY_BY_MATERIALITY[String(materiality || '').toLowerCase()] || 'medium';
}
// A verdict of 'violated' at these severities stops a clean investor fit.
const BLOCKING_SEVERITIES = new Set(['fatal', 'high']);

function isEmptyExpr(expr) {
  return expr == null || (typeof expr === 'object' && !Array.isArray(expr) && Object.keys(expr).length === 0);
}

// Loose scalar equality for scope matching: case-insensitive strings, numeric
// numbers, strict booleans. Mirrors the evaluator's eq so a rule authored with
// either spelling of a value matches the normalized context.
function scalarEq(a, b) {
  if (a == null || b == null) return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a); const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * scopeMatches(scope, ctx) → boolean. Every key in `scope` must be present in the
 * context AND equal the scope value (an array scope value means "one of"). A scope
 * key the context does NOT know is treated as a NON-match (we never assume a rule
 * applies when we can't confirm its scope) — never throws.
 */
function scopeMatches(scope, ctx) {
  try {
    if (isEmptyExpr(scope)) return true;
    if (typeof scope !== 'object') return false;
    const c = ctx || {};
    for (const [k, v] of Object.entries(scope)) {
      const actual = c[k];
      if (actual === undefined || actual === null) return false; // scope field unknown → cannot confirm
      if (Array.isArray(v)) { if (!v.some((x) => scalarEq(actual, x))) return false; }
      else if (!scalarEq(actual, v)) return false;
    }
    return true;
  } catch (_e) { return false; }
}

// Shape a DB guideline_rules row into the { rule, verdict, ... } the citation
// formatter + precedence resolver want. `source` is the precedence-tier key
// (program_base / investor_hard / internal_overlay / state / …).
function shapeRuleForCitation(rule, source) {
  return {
    rule_id: rule.rule_id || rule.id || rule.rule_key || null,
    source: source || rule.source || 'program_base',
    materiality: rule.materiality || null,
    investor: rule.investor || rule.investor_name || null,
    guideline: rule.guideline || rule.guideline_title || null,
    version: rule.version || null,
    section: rule.section || (rule.meta && rule.meta.source) || null,
  };
}

/**
 * evaluateGuidelineSet({ rules, context, source, label, exceptedKeys, opts }) → {
 *   label, source,
 *   rules:   [{ ruleKey, ruleId, materiality, severity, applicable, verdict,
 *               matched, unmet, outcome, excepted, citation }],
 *   resolved: { rule_key: <precedence resolution> },   // over APPLICABLE rules
 *   citations: [ …citeAll ordered unmet-first ],
 *   summary:  { total, applicable, met, violated, indeterminate, noted, blockers, excepted },
 *   eligible, // no non-excepted blocking violation
 *   fitResult: { investor, eligible, failures, notes },  // feeds rankInvestorFit
 * }
 * PURE — no DB, no I/O. Never throws.
 */
function evaluateGuidelineSet(input = {}) {
  try {
    const rules = Array.isArray(input.rules) ? input.rules : [];
    const ctx = input.context || {};
    const source = input.source || 'program_base';
    const label = input.label || null;
    const excepted = input.exceptedKeys instanceof Set
      ? input.exceptedKeys
      : new Set((Array.isArray(input.exceptedKeys) ? input.exceptedKeys : []).map(String));
    const opts = input.opts || {};

    const evaluated = rules.map((rule) => {
      const applicable = scopeMatches(rule.scope, ctx);
      const isExcepted = excepted.has(String(rule.rule_key));
      let verdict; let ev = { matched: true, unmet: [] };
      if (!applicable) {
        verdict = 'not_applicable';
      } else if (isEmptyExpr(rule.expression)) {
        verdict = 'noted';               // applies, nothing to test — a recorded fact
      } else {
        ev = evaluator.evaluate(rule.expression, ctx);
        if (ev.matched) verdict = 'met';
        else {
          // fails: is it a real breach (a known value fails) or just unknown data?
          const anyKnownFailure = (ev.unmet || []).some((u) => u && u.actual !== null && u.actual !== undefined);
          verdict = anyKnownFailure ? 'violated' : 'indeterminate';
        }
      }
      const cit = citation.formatCitation(shapeRuleForCitation(rule, source), ev, opts);
      return {
        ruleKey: rule.rule_key || null,
        ruleId: rule.rule_id || rule.id || null,
        materiality: rule.materiality || null,
        severity: severityOf(rule.materiality),
        source,
        applicable,
        verdict,
        matched: ev.matched === true,
        unmet: Array.isArray(ev.unmet) ? ev.unmet : [],
        outcome: rule.outcome != null ? rule.outcome : null,
        excepted: isExcepted,
        citation: cit,
      };
    });

    const applicableRules = evaluated.filter((r) => r.applicable);
    // A blocking violation is a real breach at a blocking severity that is NOT
    // covered by an approved exception.
    const blockers = applicableRules.filter(
      (r) => r.verdict === 'violated' && BLOCKING_SEVERITIES.has(r.severity) && !r.excepted);

    // Precedence: group APPLICABLE rules by rule_key (only rules that actually
    // pertain to this file compete), then resolve the winner per key.
    const byKey = {};
    for (const r of evaluated) {
      if (!r.applicable || !r.ruleKey) continue;
      (byKey[r.ruleKey] = byKey[r.ruleKey] || []).push({
        source: r.source, rule_id: r.ruleId, materiality: r.materiality,
        outcome: r.outcome != null ? r.outcome : {}, advisory: false,
      });
    }
    const resolved = precedence.resolveAll(byKey);

    // Citations, unmet-first (the ones a human needs to see).
    const citations = citation.citeAll(
      evaluated.filter((r) => r.applicable).map((r) => ({
        rule: shapeRuleForCitation(r, source),
        eval: { matched: r.matched, unmet: r.unmet },
        opts,
      })), opts);

    const summary = {
      total: evaluated.length,
      applicable: applicableRules.length,
      met: applicableRules.filter((r) => r.verdict === 'met').length,
      violated: applicableRules.filter((r) => r.verdict === 'violated').length,
      indeterminate: applicableRules.filter((r) => r.verdict === 'indeterminate').length,
      noted: applicableRules.filter((r) => r.verdict === 'noted').length,
      blockers: blockers.length,
      excepted: applicableRules.filter((r) => r.excepted && r.verdict === 'violated').length,
    };
    const eligible = blockers.length === 0;

    // The shape investor-fit consumes: failures = blocking + non-blocking real
    // violations (so the ranker can weigh severity); notes = things a human should
    // know but that don't fail the fit (indeterminate data gaps, honored exceptions).
    const failures = applicableRules
      .filter((r) => r.verdict === 'violated' && !r.excepted)
      .map((r) => ({
        ruleId: r.ruleId, severity: r.severity,
        reason: (r.citation && r.citation.reasons && r.citation.reasons[0]) || r.ruleKey,
      }));
    const notes = applicableRules
      .filter((r) => r.verdict === 'indeterminate' || (r.excepted && r.verdict === 'violated'))
      .map((r) => (r.excepted
        ? `${r.ruleKey}: an approved exception applies`
        : `${r.ruleKey}: not enough information to evaluate yet`));
    const fitResult = { investor: label || source, eligible, failures, notes };

    return { label, source, rules: evaluated, resolved, citations, summary, eligible, fitResult };
  } catch (_e) {
    return {
      label: input && input.label || null, source: input && input.source || null,
      rules: [], resolved: {}, citations: [],
      summary: { total: 0, applicable: 0, met: 0, violated: 0, indeterminate: 0, noted: 0, blockers: 0, excepted: 0 },
      eligible: true, fitResult: { investor: (input && input.label) || 'unknown', eligible: true, failures: [], notes: [] },
    };
  }
}

/**
 * rankSets(sets) → the investor-fit ranking across one or more evaluated sets
 * (each set's `fitResult`). A single-program file yields a one-entry ranking; a
 * file with a program set + a note-buyer investor set gets a real "A vs B". Pure,
 * never throws. Delegates the ranking + differentiators to investor-fit.
 */
function rankSets(sets) {
  try {
    const results = (Array.isArray(sets) ? sets : []).map((s) => s && s.fitResult).filter(Boolean);
    return investorFit.rankInvestorFit(results);
  } catch (_e) {
    return { ranked: [], best: null, anyFit: false, comparison: [] };
  }
}

// ---------------------------------------------------------------------------
// DB loader (best-effort, advisory). Lazy-requires the DB + engine so the pure
// core above loads and unit-tests with no Postgres.
// ---------------------------------------------------------------------------

/**
 * evaluateApplicationGuidelines(appId, { client }?) → the composed advisory report
 * for one file, or null when the file/context can't be built. Best-effort: any
 * missing table / query error degrades to an empty-but-valid report, never throws
 * out to the caller. STAFF surface — citations keep investor/source names
 * (borrowerSafe is NOT set here).
 */
async function evaluateApplicationGuidelines(appId, { client } = {}) {
  let engine; let knowledge; let db;
  try {
    engine = require('../conditions/engine');
    knowledge = require('./guideline-knowledge');
    db = client || require('../db');
  } catch (_e) { return null; }

  let ctx; let app;
  try {
    const loaded = await engine.loadRuleContext(appId);
    if (!loaded) return null;
    ctx = loaded.ctx; app = loaded.app;
  } catch (_e) { return null; }

  const program = (app && app.pr_program) || null;
  const asOf = null;

  // Program rules (investor_id NULL, keyed on the registered program).
  let programRules = [];
  if (program) {
    try { programRules = await knowledge.activeRules(db, { program }); } catch (_e) { programRules = []; }
  }

  // Note-buyer investor + its rules (best-effort; usually absent until seeded).
  let investor = null; let investorRules = [];
  const lender = app && app.lender;
  if (lender) {
    try { investor = await knowledge.findInvestor(db, lender); } catch (_e) { investor = null; }
    if (investor && investor.id) {
      try { investorRules = await knowledge.activeRules(db, { investorId: investor.id, asOf }); } catch (_e) { investorRules = []; }
    }
  }

  // Approved, unexpired exceptions on this file downgrade a matching violation.
  let exceptedKeys = new Set();
  try {
    const exc = await knowledge.activeExceptions(db, appId);
    exceptedKeys = new Set((exc || []).map((e) => String(e.rule_key)));
  } catch (_e) { exceptedKeys = new Set(); }

  const sets = [];
  if (programRules.length) {
    sets.push(evaluateGuidelineSet({
      rules: programRules, context: ctx, source: 'program_base',
      label: program ? `${program.charAt(0).toUpperCase()}${program.slice(1)} program` : 'Program',
      exceptedKeys,
    }));
  }
  if (investorRules.length) {
    sets.push(evaluateGuidelineSet({
      rules: investorRules, context: ctx, source: 'investor_hard',
      label: (investor && investor.name) || 'Investor', exceptedKeys,
    }));
  }

  const fit = rankSets(sets);
  return {
    applicationId: appId,
    program,
    investor: (investor && investor.name) || null,
    generatedAt: null,          // stamped by the route (Date unavailable in some pure contexts)
    sets,
    fit,
    // a compact echo of the exact context values the rules read (for the "why" panel)
    context: pickDisplayContext(ctx),
    empty: sets.length === 0,
  };
}

// The context fields a guideline rule commonly reads — echoed so the advisory
// panel can show WHAT the evaluation saw. Never includes PII.
const DISPLAY_CONTEXT_KEYS = Object.freeze([
  'registered_program', 'program_strategy', 'loan_purpose', 'note_buyer', 'is_assignment',
  'loan_amount', 'ltv', 'loan_to_arv', 'loan_to_cost', 'fico', 'tier',
  'property_state', 'property_type', 'units', 'occupancy', 'in_flood_zone',
  'purchase_price', 'as_is_value', 'arv', 'rehab_budget', 'citizenship',
]);
function pickDisplayContext(ctx) {
  const out = {};
  const c = ctx || {};
  for (const k of DISPLAY_CONTEXT_KEYS) if (c[k] !== undefined) out[k] = c[k];
  return out;
}

module.exports = {
  evaluateGuidelineSet,
  rankSets,
  scopeMatches,
  evaluateApplicationGuidelines,
  _internals: { severityOf, isEmptyExpr, scalarEq, shapeRuleForCitation, pickDisplayContext, SEVERITY_BY_MATERIALITY },
};

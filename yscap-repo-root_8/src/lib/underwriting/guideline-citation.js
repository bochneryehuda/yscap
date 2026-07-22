'use strict';
/**
 * R5.39 — Guideline CITATION formatter (deterministic core, ADVISORY / display).
 *
 * The deterministic evaluator (guideline-evaluator.js) answers matched/unmet with
 * a list of unmet leaves ({ field, cmp, expected, actual }); the precedence engine
 * (guideline-precedence.js) says which rule WINS ({ source, outcome, materiality,
 * rule_id }). What the file-view "why did this rule apply?" panel needs — and what
 * this module produces — is the human-readable CITATION: a plain phrase for each
 * unmet condition ("LTV 82% exceeds the 80% maximum") plus a source line naming
 * the guideline, its version, and the section, so an underwriter can see exactly
 * which rule from which guideline drove the result.
 *
 * A `borrowerSafe` mode strips every investor / note-buyer / capital-partner name
 * and internal source label (never exposed on a borrower surface — CLAUDE.md hard
 * rule), leaving only the neutral requirement itself.
 *
 * PURE: no DB, no AI, no I/O. It FORMATS an already-computed evaluation; it runs
 * no guideline, changes no decision, cites no number it wasn't given. Advisory /
 * presentational. NEVER THROWS — hostile input degrades to a safe empty citation.
 */

// Comparator → a human phrase template. `{a}` = actual, `{e}` = expected, `{f}` = field label.
// Keyed on the guideline-evaluator's SYMBOLIC comparators ('<','<=','>','>=','==',
// '!=','in','not_in','between'), with the common named aliases (gte/lte/…) also
// mapped so a rule authored with either spelling reads correctly.
const CMP_PHRASE = Object.freeze({
  '>=': '{f} {a} is below the minimum {e}',
  gte: '{f} {a} is below the minimum {e}',
  '>': '{f} {a} is not above the required {e}',
  gt: '{f} {a} is not above the required {e}',
  '<=': '{f} {a} exceeds the maximum {e}',
  lte: '{f} {a} exceeds the maximum {e}',
  '<': '{f} {a} is not below the required {e}',
  lt: '{f} {a} is not below the required {e}',
  '==': '{f} {a} does not equal the required {e}',
  eq: '{f} {a} does not equal the required {e}',
  '!=': '{f} {a} must not be {e}',
  ne: '{f} {a} must not be {e}',
  in: '{f} {a} is not one of the allowed values ({e})',
  not_in: '{f} {a} is a disallowed value ({e})',
  nin: '{f} {a} is a disallowed value ({e})',
  between: '{f} {a} is outside the allowed range {e}',
});
// A generic fallback so an unknown comparator still yields a readable phrase.
const CMP_FALLBACK = '{f} {a} does not satisfy the requirement ({cmp} {e})';

// Precedence source → a display label (kept in sync with guideline-precedence TIERS).
const SOURCE_LABEL = Object.freeze({
  base_program: 'Program guideline',
  investor_hard: 'Investor guideline',
  investor_exception: 'Approved investor exception',
  state_overlay: 'State overlay',
  internal_overlay: 'Internal overlay',
  approved_exception: 'Approved exception',
});

// Defense-in-depth scrub of any known note-buyer / capital-partner name that
// might slip into borrower-facing text. Pure (string ops only); guarded so it can
// never throw. This is a SECOND line behind dropping the name-bearing fields
// outright in borrowerSafe mode — scrubText only catches KNOWN partner names, so
// the primary defense is not returning those fields at all.
let _scrubText = null;
try { _scrubText = require('../borrower-safe').scrubText; } catch (_e) { _scrubText = null; }
function scrub(s) {
  try { return _scrubText && typeof s === 'string' ? _scrubText(s) : s; } catch (_e) { return s; }
}

function str(v) {
  try {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return null;
  } catch (_e) { return null; }
}
// Humanize a snake_case / camelCase field into a Title-ish label ("ltv_max" → "LTV max").
const KNOWN_ACRONYMS = /\b(ltv|ltc|arv|dscr|fico|dti|ltarv|apr|piti|ssn|llc)\b/gi;
function fieldLabel(field) {
  const s = str(field);
  if (!s) return 'value';
  const spaced = s.replace(/[_\-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return spaced.replace(KNOWN_ACRONYMS, (m) => m.toUpperCase()) || 'value';
}
// Render an expected/actual value for display (arrays → "a, b, c").
function showVal(v) {
  try {
    if (v == null) return 'n/a';
    if (Array.isArray(v)) return v.map((x) => (x == null ? 'n/a' : String(x))).join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  } catch (_e) { return 'n/a'; }
}

/**
 * phraseForUnmet(u) → a plain-language sentence for one unmet leaf.
 *   u: { field, cmp, expected, actual }
 * NEVER THROWS.
 */
function phraseForUnmet(u) {
  try {
    const uu = u || {};
    const f = fieldLabel(uu.field);
    const tmpl = CMP_PHRASE[str(uu.cmp)] || CMP_FALLBACK;
    return tmpl
      .replace('{f}', cap(f))
      .replace('{a}', showVal(uu.actual))
      .replace('{e}', showVal(uu.expected))
      .replace('{cmp}', str(uu.cmp) || '?');
  } catch (_e) { return 'A requirement was not met.'; }
}
function cap(s) { const x = str(s); return x ? x.charAt(0).toUpperCase() + x.slice(1) : ''; }

/**
 * formatCitation(rule, evalResult, opts?) → {
 *   ruleId, sourceLabel, investor, guideline, version, section,
 *   verdict: 'met' | 'unmet' | 'advisory',
 *   reasons: [string],   // one plain phrase per unmet condition
 *   citation,            // the composed source line
 *   materiality,
 * }
 *   rule: { rule_id|ruleId, source|precedence_tier, investor?, guideline?|guideline_name,
 *           version?|guideline_version, section?|citation?, materiality?, advisory? }
 *   evalResult: { matched, unmet: [{ field, cmp, expected, actual }] }  (from guideline-evaluator)
 *   opts: { borrowerSafe? }  — omit investor/source names on a borrower surface.
 * NEVER THROWS.
 */
function formatCitation(rule, evalResult, opts = {}) {
  try {
    const r = rule && typeof rule === 'object' ? rule : {};
    const ev = evalResult && typeof evalResult === 'object' ? evalResult : {};
    const borrowerSafe = !!(opts && opts.borrowerSafe);

    const ruleId = str(r.rule_id) || str(r.ruleId) || null;
    const source = str(r.source) || str(r.precedence_tier) || null;
    const sourceLabel = source ? (SOURCE_LABEL[source] || cap(source.replace(/_/g, ' '))) : null;
    const investor = str(r.investor);
    const guideline = str(r.guideline) || str(r.guideline_name);
    const version = str(r.version) || str(r.guideline_version);
    const section = str(r.section) || str(r.citation);
    const materiality = str(r.materiality) || null;

    const unmet = Array.isArray(ev.unmet) ? ev.unmet : [];
    const matched = ev.matched === true;
    const advisory = r.advisory === true;
    const verdict = matched ? 'met' : (advisory ? 'advisory' : 'unmet');

    // Reasons only make sense when the rule did NOT pass. In borrowerSafe mode
    // scrub each reason as defense-in-depth (a known partner name should never
    // reach a borrower even if one somehow rode in on a field/value).
    const reasons = matched ? [] : unmet.map((u) => (borrowerSafe ? scrub(phraseForUnmet(u)) : phraseForUnmet(u)));

    return {
      // ruleId + section can BOTH embed a note-buyer/program name ("bluelake_ltv_max",
      // "RCN Guidelines 4.2") — they are NOT neutral, so they are dropped entirely on
      // a borrower surface (CLAUDE.md hard rule), like the other name-bearing fields.
      ruleId: borrowerSafe ? null : ruleId,
      sourceLabel: borrowerSafe ? null : sourceLabel,
      investor: borrowerSafe ? null : (investor || null),
      guideline: borrowerSafe ? null : (guideline || null),
      version: borrowerSafe ? null : (version || null),
      section: borrowerSafe ? null : (section || null),
      verdict,
      reasons,
      citation: composeCitation({ sourceLabel, investor, guideline, version, section, ruleId }, borrowerSafe),
      materiality,
    };
  } catch (_e) {
    return { ruleId: null, sourceLabel: null, investor: null, guideline: null, version: null, section: null, verdict: 'unmet', reasons: [], citation: null, materiality: null };
  }
}

// The single source line: "Investor guideline — Acme Bank v3, §4.2 (rule ltv_max)".
// borrowerSafe drops every investor/source name, keeping only the neutral section.
function composeCitation(parts, borrowerSafe) {
  try {
    const bits = [];
    if (!borrowerSafe) {
      if (parts.sourceLabel) bits.push(parts.sourceLabel);
      const named = [parts.investor, parts.guideline].filter(Boolean).join(' ');
      if (named) bits.push(named);
      if (parts.version) bits.push(`v${String(parts.version).replace(/^v/i, '')}`);
      // a section/citation reference can embed the source name ("RCN Guidelines
      // 4.2") — only emit it on the STAFF surface, never borrower-facing.
      if (parts.section) bits.push(`§${String(parts.section).replace(/^§/, '')}`);
      if (parts.ruleId) bits.push(`(rule ${parts.ruleId})`);
    }
    const line = bits.join(' — ').replace(' — §', ', §').replace(' — (rule', ' (rule');
    if (borrowerSafe) return 'Program requirement'; // no names, no section, no rule id
    return line || 'Guideline rule';
  } catch (_e) { return null; }
}

/**
 * citeAll(rules) → [formatCitation...] for a list of { rule, eval, opts? } pairs.
 * Sorts unmet before met (the ones a human needs to see first), stable otherwise.
 * NEVER THROWS.
 */
function citeAll(rules, opts = {}) {
  try {
    const list = Array.isArray(rules) ? rules : [];
    const out = list.map((x) => {
      // guard PER ITEM so one hostile entry (e.g. a throwing .rule getter) can't
      // drop every good sibling — it degrades to a safe empty citation instead.
      try {
        const rule = x && x.rule !== undefined ? x.rule : x;
        const ev = x && x.eval !== undefined ? x.eval : (x && x.evalResult);
        return formatCitation(rule, ev, (x && x.opts) || opts);
      } catch (_e) {
        return formatCitation(null, null, opts);
      }
    });
    // unmet (0) before advisory (1) before met (2), preserving input order within a group.
    const rank = (v) => (v === 'unmet' ? 0 : v === 'advisory' ? 1 : 2);
    return out.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.verdict) - rank(b.c.verdict) || a.i - b.i).map((x) => x.c);
  } catch (_e) { return []; }
}

module.exports = {
  formatCitation,
  phraseForUnmet,
  citeAll,
  SOURCE_LABEL,
  _internals: { fieldLabel, showVal, composeCitation, CMP_PHRASE },
};

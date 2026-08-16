'use strict';
/**
 * LT PPE — the shadow-run SCOREBOARD report (MEGA plan §10.5). PURE: no DB, no network, no clock.
 * Turns a shadow run ({ results, summary } from shadow.runShadow) into a legible report — a
 * structured object AND a plain-text rendering — so the owner (non-technical) can read at a glance
 * whether our engine agrees with Lender Price and, when it does not, exactly where.
 *
 * It ranks the disagreements that matter: the worst price gaps first (largest |deltaMilli|),
 * then the coupons each side is missing, then any engine errors. It NEVER hides a count — a
 * truncated "top N" list always says how many more there were.
 *
 * LT-only. No RTL imports.
 */

const parity = require('./parity');
const { describeScenario } = require('./scenario-matrix');

const KIND_LABEL = {
  [parity.SEVERITY.ELIGIBILITY]: 'Eligibility disagreements',
  [parity.SEVERITY.PRICE]: 'Price disagreements',
  [parity.SEVERITY.RATE]: 'Rate (coupon) disagreements',
  [parity.SEVERITY.MISSING_OURS]: 'Coupons Lender Price returned that we did not',
  [parity.SEVERITY.MISSING_THEIRS]: 'Coupons we returned that Lender Price did not',
  engine_error: 'Scenarios where an engine failed',
};

function fmtMilliPrice(m) {
  if (typeof m !== 'number' || !Number.isFinite(m)) return '(none)';
  return (m / 1000).toFixed(3); // milli-points -> points
}

// A finding's scenario tag is normally the harness's string label; render an object safely too.
function labelOf(scenario) {
  if (scenario == null) return '';
  if (typeof scenario === 'string') return scenario;
  return describeScenario(scenario);
}

// Flatten every finding across all results, keeping its scenario tag.
function allFindings(results) {
  const out = [];
  for (const r of results || []) for (const f of (r.findings || [])) out.push(f);
  return out;
}

/**
 * Build the structured report.
 *   run: { results, summary }
 *   opts: { topPriceGaps=10 }
 * Returns { summary, verdict, byKind:[{kind,label,count}], worstPriceGaps:[...],
 *           worstPriceGapsOmitted, errors:[...] }.
 */
function buildReport(run = {}, opts = {}) {
  const results = Array.isArray(run.results) ? run.results : [];
  const summary = run.summary || parity.summarize(results);
  const topN = opts.topPriceGaps == null ? 10 : opts.topPriceGaps;

  const findings = allFindings(results);

  const byKind = Object.keys(summary.byKind || {})
    .map((kind) => ({ kind, label: KIND_LABEL[kind] || kind, count: summary.byKind[kind] }))
    .sort((a, b) => b.count - a.count);

  const priceGaps = findings
    .filter((f) => f.kind === parity.SEVERITY.PRICE && typeof f.deltaMilli === 'number')
    .sort((a, b) => Math.abs(b.deltaMilli) - Math.abs(a.deltaMilli));
  const worstPriceGaps = priceGaps.slice(0, topN);
  const worstPriceGapsOmitted = Math.max(0, priceGaps.length - worstPriceGaps.length);

  const errors = findings.filter((f) => f.kind === 'engine_error');

  return {
    summary,
    verdict: verdictOf(summary),
    byKind,
    worstPriceGaps,
    worstPriceGapsOmitted,
    errors,
  };
}

// One-line plain-language verdict.
function verdictOf(summary) {
  const s = summary || {};
  if (!s.scenarios) return 'No scenarios were run.';
  if (s.errors) {
    // errors are also counted in disagreed; report them explicitly
  }
  if (s.disagreed === 0) {
    return `All ${s.scenarios} scenarios agree with Lender Price.`;
  }
  const pct = s.agreementRate == null ? 0 : Math.round(s.agreementRate * 1000) / 10;
  const errNote = s.errors ? ` (${s.errors} could not be priced by one side)` : '';
  return `${s.agreed} of ${s.scenarios} scenarios agree (${pct}%); ${s.disagreed} disagree${errNote}.`;
}

// Render the structured report as plain text for a log / email / ledger note.
function renderText(run = {}, opts = {}) {
  const rep = buildReport(run, opts);
  const lines = [];
  lines.push('Lender Price shadow comparison');
  lines.push('==============================');
  lines.push(rep.verdict);
  lines.push('');
  if (rep.byKind.length) {
    lines.push('Disagreements by type:');
    for (const k of rep.byKind) lines.push(`  - ${k.label}: ${k.count}`);
    lines.push('');
  }
  if (rep.worstPriceGaps.length) {
    lines.push('Biggest price gaps (points):');
    for (const g of rep.worstPriceGaps) {
      const sign = g.deltaMilli > 0 ? '+' : '';
      const tag = labelOf(g.scenario);
      lines.push(`  - coupon ${(g.rate / 1000).toFixed(3)}  ours ${fmtMilliPrice(g.ourPriceMilli)}  vs Lender Price ${fmtMilliPrice(g.theirPriceMilli)}  (${sign}${(g.deltaMilli / 1000).toFixed(3)})${tag ? `  [${tag}]` : ''}`);
    }
    if (rep.worstPriceGapsOmitted) lines.push(`  …and ${rep.worstPriceGapsOmitted} more price gaps.`);
    lines.push('');
  }
  if (rep.errors.length) {
    lines.push('Scenarios an engine could not price:');
    for (const e of rep.errors) { const tag = labelOf(e.scenario); lines.push(`  - ${e.side === 'ours' ? 'our engine' : 'Lender Price'}: ${e.detail}${tag ? `  [${tag}]` : ''}`); }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

module.exports = { buildReport, renderText, verdictOf, KIND_LABEL };

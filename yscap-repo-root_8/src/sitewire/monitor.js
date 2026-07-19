'use strict';
/**
 * PORTFOLIO MONITORING / early-warning engine (research doc §17; grounded in Built's loan-
 * monitoring — stale loans, overdrawn projects, low pacing, past-maturity — and construction
 * draw-servicing practice). ADVISORY only: it flags files that need a human's attention, it
 * never moves money or changes state. Every flag is computed from real data we hold (funding
 * date, drawn vs. budget, last draw activity, loan term) — nothing is guessed. When a signal's
 * input is missing (e.g. no parseable term), that signal is simply skipped, never estimated.
 *
 * Pure core (`assessPortfolioAlerts`) takes a `nowMs` so it is deterministic + unit-testable.
 */

const N = (x) => Number(x || 0) || 0;
const DAY = 86400000;
const fmt = (c) => '$' + Math.round(N(c) / 100).toLocaleString('en-US');

// Parse a loan-term string ("12 months", "18 mo", "12") into whole months, or null if unclear.
function parseTermMonths(term) {
  if (term == null) return null;
  const s = String(term).toLowerCase();
  const m = s.match(/(\d{1,3})\s*(month|mo|mos)?/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 && n <= 600 ? n : null;
}

const daysBetween = (aMs, bMs) => Math.floor((aMs - bMs) / DAY);
const parseDay = (d) => { if (!d) return null; const t = Date.parse(String(d).slice(0, 10) + 'T00:00:00Z'); return Number.isFinite(t) ? t : null; };

/**
 * @param files [{ application_id, ys_loan_number, address, status, budget_cents, drawn_cents,
 *                 draw_count, funded_on ('YYYY-MM-DD' actual_closing), term, last_activity_at }]
 * @param opts  { nowMs, staleDays=30, noDrawDays=45, pacingGapPct=25 }
 * @returns { files:[{...file, alerts:[{code,severity,message}]}], summary:{by_code, flagged} }
 */
function assessPortfolioAlerts(files, opts = {}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : 0;
  const staleDays = opts.staleDays != null ? Number(opts.staleDays) : 30;
  const noDrawDays = opts.noDrawDays != null ? Number(opts.noDrawDays) : 45;
  const pacingGapPct = opts.pacingGapPct != null ? Number(opts.pacingGapPct) : 25;

  const out = [];
  const byCode = {};
  const bump = (code) => { byCode[code] = (byCode[code] || 0) + 1; };

  for (const f of files || []) {
    const budget = N(f.budget_cents), drawn = N(f.drawn_cents);
    const remaining = budget - drawn;
    const drawCount = N(f.draw_count);
    const fundedMs = parseDay(f.funded_on);
    const lastMs = f.last_activity_at ? Date.parse(f.last_activity_at) : (fundedMs || null);
    const termMonths = parseTermMonths(f.term);
    const alerts = [];
    const add = (code, severity, message) => { alerts.push({ code, severity, message }); bump(code); };

    // OVERDRAWN — money out has passed the budget (guards should prevent it; flag if it slips).
    if (budget > 0 && drawn > budget) add('overdrawn', 'high', `Drawn ${fmt(drawn)} exceeds the ${fmt(budget)} construction budget by ${fmt(drawn - budget)}.`);

    // NO DRAW SINCE FUNDING — funded a while ago, borrower hasn't requested a draw yet.
    if (drawCount === 0 && fundedMs != null && nowMs > 0) {
      const d = daysBetween(nowMs, fundedMs);
      if (d >= noDrawDays) add('no_draw_since_funding', 'medium', `Funded ${d} days ago with no draw requested yet.`);
    }

    // STALE — has draws but no activity within the window and money still to draw.
    if (drawCount > 0 && remaining > 0 && lastMs != null && nowMs > 0) {
      const d = daysBetween(nowMs, lastMs);
      if (d >= staleDays) add('stale', 'medium', `No draw activity in ${d} days, with ${fmt(remaining)} still undrawn.`);
    }

    // PACING / PAST MATURITY — only when we can compute a maturity from a real term.
    if (termMonths != null && fundedMs != null && budget > 0 && nowMs > 0) {
      const maturityMs = fundedMs + Math.round(termMonths * 30.4375 * DAY);
      const elapsed = Math.max(0, Math.min(1, (nowMs - fundedMs) / (maturityMs - fundedMs)));
      const elapsedPct = Math.round(elapsed * 100);
      const drawnPct = Math.round((drawn / budget) * 100);
      if (nowMs > maturityMs && remaining > 0) {
        add('past_maturity', 'high', `Past loan maturity with ${fmt(remaining)} still undrawn (${drawnPct}% drawn).`);
      } else if (elapsedPct >= 20 && (elapsedPct - drawnPct) >= pacingGapPct) {
        add('behind_pace', 'medium', `${elapsedPct}% of the loan term has passed but only ${drawnPct}% is drawn — the project may be running behind.`);
      }
    }

    out.push({ ...f, remaining_cents: remaining, alerts });
  }
  const flagged = out.filter((f) => f.alerts.length > 0).length;
  return { files: out, summary: { by_code: byCode, flagged, total: out.length } };
}

module.exports = { assessPortfolioAlerts, parseTermMonths };

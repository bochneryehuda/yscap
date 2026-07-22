'use strict';
/**
 * DRAW RISK / RED-FLAG engine (research doc §15; grounded in construction-loan fraud
 * controls — front-loading, over-billing, over-budget lines, draws that outrun verifiable
 * progress). This is the "audit mode" of a draw-review agent: it ADVISES, it never moves or
 * blocks money on its own. A human draw coordinator always makes the call — the flags just
 * make sure nothing slips past unseen.
 *
 * PURE — no I/O. Takes a draw + its per-line requests + the unified rollup (already-drawn
 * per line, project totals) and returns typed flags with a severity, plus an overall level.
 * Money is integer cents. Nothing is guessed: a request whose job item has no crosswalk row
 * is flagged (unknown), never folded into a line.
 */

const N = (x) => Number(x || 0) || 0;
const fmt = (c) => '$' + (N(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const SEV_RANK = { high: 3, medium: 2, low: 1 };

/**
 * @param draw     { sitewire_draw_id, number, status, total_requested_cents, total_approved_cents }
 * @param requests [{ sitewire_job_item_id, requested_cents, approved_cents, inspection_count }]
 * @param links    crosswalk rows [{ sitewire_job_item_id, sow_line_key, name, budgeted_cents, is_media_item, unit_index }]
 * @param rollup   output of rollup.computeRollup (line.remaining/drawn/budgeted EXCLUDING this pending draw), project totals
 * @param opts     { frontLoadPct=40, firstDrawMaxPct=30 }
 * @returns        { flags:[{code,severity,message,key?}], level:'high'|'medium'|'low'|'clear', score }
 */
function assessDraw({ draw = {}, requests = [], links = [], rollup = null, opts = {} } = {}) {
  const frontLoadPct = Number.isFinite(Number(opts.frontLoadPct)) ? Number(opts.frontLoadPct) : 40;
  const firstDrawMaxPct = Number.isFinite(Number(opts.firstDrawMaxPct)) ? Number(opts.firstDrawMaxPct) : 30;
  const flags = [];
  const add = (code, severity, message, key) => flags.push({ code, severity, message, key: key || null });

  // Exclude removed crosswalk rows (matching rollup.js) so a draw request against a DELETED
  // job item is flagged unknown/never budget-checked, not silently mapped to the dead line
  // (pre-merge audit #2).
  const byJid = new Map();
  for (const l of links) if (l.sitewire_job_item_id != null && (l.state || 'live') !== 'deleted') byJid.set(N(l.sitewire_job_item_id), l);
  const lineByKey = new Map();
  if (rollup && rollup.lines) for (const ln of rollup.lines) lineByKey.set(ln.sow_line_key, ln);

  // ---- per-request checks + aggregate this draw's requested/approved per line ----
  const reqByLine = new Map(); // sow_line_key -> { requested, approved, label }
  for (const r of requests) {
    const req = N(r.requested_cents), appr = N(r.approved_cents);
    const l = byJid.get(N(r.sitewire_job_item_id));
    if (!l) {
      // Owner-directed 2026-07-22: a request with $0 requested AND $0 approved is a Sitewire
      // PHOTO/VIDEO GATE placeholder — an "inspection required" checkbox, not a money line the
      // coordinator needs to review. Sitewire seeds a whole template of these on every property
      // (Video Walkthrough, Exterior Photos, per-line photo requirements). Reconcile's
      // adoptSeededMediaItems binds them into the crosswalk on the next pass, but until it does
      // (first reconcile after deploy, or a brand-new item Sitewire just seeded), silently skip
      // the risk flag — a photo-gate placeholder cannot be over-drawn and has no money to review.
      // A request with ANY dollar amount still flags high (real money against an unknown line).
      if (req > 0 || appr > 0) add('unknown_line', 'high', `A draw line (Sitewire item ${r.sitewire_job_item_id}) has no Scope-of-Work match — it must be reviewed by hand, never auto-reconciled.`);
      continue;
    }
    const isMedia = !!l.is_media_item || String(l.sow_line_key).indexOf('__media__') === 0;
    if (isMedia) { if (req > 0) add('money_on_media_line', 'medium', `Money (${fmt(req)}) was requested against a photo/media line ("${l.name}"), which carries no budget.`, l.sow_line_key); continue; }
    if (appr > req) add('approved_exceeds_requested', 'high', `"${l.name}" was approved for ${fmt(appr)} but only ${fmt(req)} was requested.`, l.sow_line_key);
    if (req > 0 && N(r.inspection_count) === 0) add('no_inspection', 'high', `"${l.name}" is requesting ${fmt(req)} with no inspection photos attached — the work isn't verified.`, l.sow_line_key);
    const agg = reqByLine.get(l.sow_line_key) || { requested: 0, approved: 0, label: rollup && lineByKey.get(l.sow_line_key) ? lineByKey.get(l.sow_line_key).label : l.name };
    agg.requested += req; agg.approved += appr;
    reqByLine.set(l.sow_line_key, agg);
  }

  // ---- per-line budget checks vs the rollup (already-drawn excludes this pending draw) ----
  for (const [key, agg] of reqByLine) {
    const ln = lineByKey.get(key);
    if (!ln) continue;
    const remaining = N(ln.remaining);      // budget − already-drawn (this draw not yet in)
    const budget = N(ln.budgeted);
    if (agg.requested > remaining) {
      add('exceeds_remaining', 'high',
        `"${ln.label}" is requesting ${fmt(agg.requested)} but only ${fmt(remaining)} is left on that line (budget ${fmt(budget)}). This draw would put the line over budget.`, key);
    }
    if (remaining <= 0 && agg.requested > 0) {
      add('line_already_complete', 'medium', `"${ln.label}" is already fully drawn, yet this draw requests ${fmt(agg.requested)} more against it.`, key);
    }
    // combined-pending cross-check: even if THIS draw fits, all open draws + drawn together may
    // bust the line (requested_open already includes this draw). Catches concurrent draws that
    // each look fine alone but jointly exceed the budget (pre-merge audit #3).
    if (N(ln.drawn) + N(ln.requested_open) > budget && budget > 0 && agg.requested < N(ln.requested_open)) {
      add('line_oversubscribed', 'medium', `"${ln.label}" has multiple open draws — together they request more than the ${fmt(budget - N(ln.drawn))} left on the line.`, key);
    }
  }

  // ---- project-level checks ----
  if (rollup && rollup.project) {
    const p = rollup.project;
    const drawReq = N(draw.total_requested_cents) || Array.from(reqByLine.values()).reduce((s, a) => s + a.requested, 0);
    // total draws would exceed the whole construction budget
    if (p.budget > 0 && (N(p.drawn) + drawReq) > p.budget) {
      add('over_total_budget', 'high', `This draw (${fmt(drawReq)}) on top of ${fmt(p.drawn)} already drawn would exceed the ${fmt(p.budget)} construction budget.`);
    }
    // large first draw — classic front-loading signal
    if (Number(draw.number) === 1 && p.budget > 0) {
      const pct = Math.round((drawReq / p.budget) * 1000) / 10;
      if (pct > firstDrawMaxPct) add('large_first_draw', 'medium', `The first draw asks for ${pct}% of the whole budget (${fmt(drawReq)} of ${fmt(p.budget)}) — unusually front-loaded for work just beginning.`);
    }
    // front-loading: a line running far ahead of the project as a whole
    if (p.budget > 0) {
      const projPctAfter = (N(p.drawn) + drawReq) / p.budget * 100;
      for (const [key, agg] of reqByLine) {
        const ln = lineByKey.get(key);
        if (!ln || N(ln.budgeted) <= 0) continue;
        const linePctAfter = (N(ln.drawn) + agg.requested) / N(ln.budgeted) * 100;
        if (linePctAfter - projPctAfter > frontLoadPct && linePctAfter > 60) {
          add('front_loading', 'medium', `"${ln.label}" would be ${Math.round(linePctAfter)}% drawn while the project overall is ${Math.round(projPctAfter)}% — this line is running well ahead of the work.`, key);
        }
      }
    }
  }

  // ---- overall level ----
  let level = 'clear', score = 0;
  for (const f of flags) { score += SEV_RANK[f.severity] || 0; if ((SEV_RANK[f.severity] || 0) > (SEV_RANK[level] || 0)) level = f.severity; }
  return { flags, level, score };
}

module.exports = { assessDraw };

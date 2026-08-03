'use strict';
/**
 * Sitewire UNIFIED ROLLUP — the "one system" view: draws ↔ Scope of Work ↔ construction
 * budget, reconciled into a single per-line / per-unit picture (research doc §4.5, §12).
 *
 * Our SOW keeps ONE line with per-unit columns; Sitewire keeps ONE job item per unit and
 * a draw REQUEST per job item. This module rolls the pulled per-unit draw requests back up
 * through the crosswalk (sitewire_job_item_links) to the single SOW line and layers the
 * money story on top:
 *
 *   budgeted        — from the crosswalk (frozen, per line & per unit)
 *   drawn           — approved_cents on APPROVED draws only (money actually released;
 *                     mirrors Sitewire total_released_cents = gross approved of approved draws)
 *   approved_pending— approved_cents on draws NOT yet lender-approved (in the pipeline)
 *   requested_open  — requested_cents on open (non-approved) draws
 *   remaining       — budgeted − drawn (what is still available to draw)
 *   committed       — drawn + approved_pending: money that is SPOKEN FOR. Owner-directed
 *                     2026-08-03: "we should treat a draw that is not fully approved, even if it's
 *                     halfway approved, as if it is approved… we can still decline it, and
 *                     everything goes back to fully available." An inspector-approved amount is a
 *                     commitment against the line the moment it is proposed, so every surface a
 *                     human reads shows AVAILABLE, not the pre-draw remaining.
 *   available       — budgeted − committed (what is genuinely still free to draw)
 *   pct_complete    — drawn / budgeted (0 when budget is 0; media lines excluded)
 *   pct_committed   — committed / budgeted (the same line, with this draw counted)
 *
 * `remaining` / `pct_complete` deliberately KEEP their released-only meaning: the risk engine
 * measures a pending draw against the line as it stood BEFORE that draw, so folding the draw into
 * `remaining` would make every draw flag itself as busting its own line.
 *
 * The core is PURE (no I/O) so the whole round-trip is unit-testable; loadRollup() is the
 * thin DB wrapper. Money is integer cents throughout. pg returns bigint as a STRING, so
 * every amount is Number()-coerced before arithmetic (audit S2 class).
 *
 * Nothing is guessed: a pulled request whose job item has no crosswalk row is NOT folded
 * into any line — it is surfaced in `unknown` for a human (G-UNKNOWN). Contingency / GC /
 * media sentinel lines are separated out, never mixed into a real SOW line.
 */
const T = require('./transforms');
const { SENTINEL } = require('./mapper');
const APPROVAL = require('./approval');

const N = (x) => Number(x || 0) || 0;
const isApprovedStatus = (s) => String(s || '') === 'approved';

// Strip the deterministic per-unit / per-section prefix explodeSow() stamped on a name so
// the rollup can show the borrower's real SOW line label ("Painting", not "Unit 3 - Painting")
// even when the SOW state isn't handy. Never guesses — only removes the exact prefixes we add.
function baseLabelFromName(name) {
  let s = String(name || '');
  s = s.replace(/^Unit\s+\d+\s+-\s+/, '');
  s = s.replace(/^(Common Areas|Exterior|Project)\s+-\s+/, '');
  return s;
}

/**
 * Pure rollup core.
 *   links    : crosswalk rows [{ sow_line_key, section_token, unit_index, sitewire_job_item_id,
 *              name, budgeted_cents, is_media_item, state }]
 *   draws    : [{ sitewire_draw_id, number, status, total_requested_cents, total_approved_cents,
 *              submitted_at, approved_at }]
 *   requests : [{ sitewire_draw_id, sitewire_job_item_id, requested_cents, approved_cents }]
 *   findingLines: optional [{ sitewire_draw_id, sitewire_request_id, approved_cents }] — the
 *              delivered-findings snapshot, used as the fallback source for inspector-approved
 *   nameByKey: optional { sow_line_key: displayLabel } (from the live SOW taxonomy)
 *
 * Returns { lines:[…], project:{…}, draws:[…], unknown:[jobItemId…] }.
 */
function computeRollup({ links = [], draws = [], requests = [], findingLines = [], nameByKey = {} } = {}) {
  const liveLinks = links.filter((l) => (l.state || 'live') !== 'deleted');
  const byJid = new Map();
  for (const l of liveLinks) if (l.sitewire_job_item_id != null) byJid.set(N(l.sitewire_job_item_id), l);
  const drawApproved = new Map();
  for (const d of draws) drawApproved.set(N(d.sitewire_draw_id), isApprovedStatus(d.status));

  // ---- seed every line/unit from the crosswalk (so remaining is right with no draw yet) ----
  const lines = {}; // sow_line_key -> line acc
  const ensureLine = (l) => {
    const key = l.sow_line_key;
    if (!lines[key]) {
      const isSentinel = key === SENTINEL.CONTINGENCY || key === SENTINEL.GC;
      const isMedia = !!l.is_media_item || String(key).indexOf('__media__') === 0;
      lines[key] = {
        sow_line_key: key,
        kind: isMedia ? 'media' : (key === SENTINEL.CONTINGENCY ? 'contingency' : key === SENTINEL.GC ? 'gc' : 'line'),
        label: nameByKey[key] || (isMedia ? 'Media / photos' : baseLabelFromName(l.name)),
        budgeted: 0, drawn: 0, approved_pending: 0, requested_open: 0, remaining: 0, pct_complete: 0,
        committed: 0, available: 0, pct_committed: 0,
        job_item_ids: [], units: {},
      };
    }
    return lines[key];
  };
  for (const l of liveLinks) {
    const line = ensureLine(l);
    if (l.sitewire_job_item_id != null) line.job_item_ids.push(N(l.sitewire_job_item_id));
    if (line.kind === 'media') continue; // media anchors carry no budget
    line.budgeted += N(l.budgeted_cents);
    if (l.unit_index != null) {
      const u = (line.units[l.unit_index] = line.units[l.unit_index] || { unit_index: N(l.unit_index), budgeted: 0, drawn: 0, approved_pending: 0, requested_open: 0, remaining: 0, pct_complete: 0, committed: 0, available: 0, pct_committed: 0 });
      u.budgeted += N(l.budgeted_cents);
    }
  }

  // ---- fold in the draw requests ----
  const unknown = [];
  for (const r of requests) {
    const l = byJid.get(N(r.sitewire_job_item_id));
    if (!l) { if (r.sitewire_job_item_id != null) unknown.push(N(r.sitewire_job_item_id)); continue; }
    if (l.is_media_item || String(l.sow_line_key).indexOf('__media__') === 0) continue;
    const line = ensureLine(l);
    const appr = N(r.approved_cents);
    const req = N(r.requested_cents);
    const approvedDraw = drawApproved.get(N(r.sitewire_draw_id)) === true;
    if (approvedDraw) line.drawn += appr;
    else { line.approved_pending += appr; line.requested_open += req; }
    if (l.unit_index != null) {
      const u = (line.units[l.unit_index] = line.units[l.unit_index] || { unit_index: N(l.unit_index), budgeted: 0, drawn: 0, approved_pending: 0, requested_open: 0, remaining: 0, pct_complete: 0, committed: 0, available: 0, pct_committed: 0 });
      if (approvedDraw) u.drawn += appr;
      else { u.approved_pending += appr; u.requested_open += req; }
    }
  }

  // ---- finalize remaining + pct ----
  const pct = (drawn, budget) => (budget > 0 ? Math.round((drawn / budget) * 1000) / 10 : 0); // 1-decimal %
  const lineList = [];
  const project = { budget: 0, drawn: 0, approved_pending: 0, requested_open: 0, remaining: 0, pct_complete: 0,
    committed: 0, available: 0, pct_committed: 0,
    contingency: null, gc: null, line_count: 0, unit_count: 0 };
  const physicalUnits = new Set(); // distinct unit indices = physical unit count (not per-unit cells)
  for (const key of Object.keys(lines)) {
    const line = lines[key];
    line.remaining = line.budgeted - line.drawn;
    line.pct_complete = pct(line.drawn, line.budgeted);
    line.committed = line.drawn + line.approved_pending;
    line.available = line.budgeted - line.committed;
    line.pct_committed = pct(line.committed, line.budgeted);
    line.units = Object.values(line.units).sort((a, b) => a.unit_index - b.unit_index);
    for (const u of line.units) {
      u.remaining = u.budgeted - u.drawn; u.pct_complete = pct(u.drawn, u.budgeted);
      u.committed = u.drawn + u.approved_pending; u.available = u.budgeted - u.committed; u.pct_committed = pct(u.committed, u.budgeted);
    }
    if (line.kind !== 'media') {
      project.budget += line.budgeted; project.drawn += line.drawn;
      project.approved_pending += line.approved_pending; project.requested_open += line.requested_open;
      if (line.kind === 'contingency') project.contingency = { budgeted: line.budgeted, drawn: line.drawn, remaining: line.remaining };
      else if (line.kind === 'gc') project.gc = { budgeted: line.budgeted, drawn: line.drawn, remaining: line.remaining };
      else { project.line_count++; for (const u of line.units) physicalUnits.add(u.unit_index); }
    }
    lineList.push(line);
  }
  project.remaining = project.budget - project.drawn;
  project.pct_complete = pct(project.drawn, project.budget);
  project.committed = project.drawn + project.approved_pending;
  project.available = project.budget - project.committed;
  project.pct_committed = pct(project.committed, project.budget);
  project.unit_count = physicalUnits.size; // distinct physical units, not per-unit cells

  // stable order: real lines first (by budget desc), then contingency, gc, media
  const rank = { line: 0, contingency: 1, gc: 2, media: 3 };
  lineList.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.budgeted - a.budgeted) || String(a.label).localeCompare(String(b.label)));

  // Owner-directed 2026-07-20: a Scope-of-Work line carrying NO money — never budgeted and with nothing
  // drawn, approved-pending, or requested — is NOT a real draw line item, so it must not clutter the draw
  // desk, the borrower view, or the branded reports even if it exists in the SOW. Only real `line` items are
  // filtered (contingency / general-conditions / media are structural and always kept). This is DISPLAY-ONLY
  // and math-neutral: the project TOTALS above already summed every line (an empty one contributes 0), and a
  // later reallocation that funds such a line re-introduces it from the PROPOSED side (buildReallocationCells),
  // so nothing that touches money is affected. `empty_line_count` is reported for transparency.
  const isEmptyLine = (l) => l.kind === 'line' && N(l.budgeted) <= 0 && N(l.drawn) <= 0 && N(l.approved_pending) <= 0 && N(l.requested_open) <= 0;
  const emptyLineCount = lineList.filter(isEmptyLine).length;
  const visibleLines = lineList.filter((l) => !isEmptyLine(l));

  // ---- per-draw summary ----
  const reqByDraw = new Map();
  for (const r of requests) {
    const arr = reqByDraw.get(N(r.sitewire_draw_id)) || [];
    arr.push(r); reqByDraw.set(N(r.sitewire_draw_id), arr);
  }
  // The delivered-findings snapshot is the SECOND source the approval ladder reads for "what did the
  // inspector approve" — it is what the borrower was actually shown, so it answers correctly even
  // when the live request mirror has not caught up yet.
  const findingLinesByDraw = new Map();
  for (const l of (Array.isArray(findingLines) ? findingLines : [])) {
    const k = N(l && l.sitewire_draw_id);
    const arr = findingLinesByDraw.get(k) || [];
    arr.push(l); findingLinesByDraw.set(k, arr);
  }
  const drawList = draws.map((d) => {
    const reqs = reqByDraw.get(N(d.sitewire_draw_id)) || [];
    // THE APPROVAL LADDER decides what "approved" means here (see ./approval). `total_approved_cents`
    // is the FINAL (lender) approval and stays 0 through the whole inspector→borrower→investor
    // stretch, so reading it as "approved" printed $0 on a fully-inspected draw. The desk, the
    // reports and the packet all show the INSPECTOR-approved amount until final approval lands.
    const m = APPROVAL.drawMoney({ draw: d, requests: reqs, findingLines: findingLinesByDraw.get(N(d.sitewire_draw_id)) || [] });
    return {
      sitewire_draw_id: N(d.sitewire_draw_id), number: d.number, status: d.status,
      requested_cents: m.requested_cents,
      approved_cents: m.approved_cents,                                 // = inspector-approved (the proposal)
      inspector_approved_cents: m.inspector_approved_cents,
      final_approved_cents: m.final_approved_cents,
      has_inspector_amounts: m.has_inspector_amounts,
      not_approved_cents: m.not_approved_cents,
      approval_stage: m.approval_stage, approval_label: m.approval_label,
      line_count: reqs.length, submitted_at: d.submitted_at || null, approved_at: d.approved_at || null,
      is_funded: isApprovedStatus(d.status),
    };
  }).sort((a, b) => (b.number || 0) - (a.number || 0));

  return { lines: visibleLines, project, draws: drawList, unknown, empty_line_count: emptyLineCount };
}

// ---- DB loader: pull the crosswalk + draws + requests + ledger for a file and roll up ----
async function loadRollup(db, appId, { sowState = null } = {}) {
  const links = (await db.query(
    `SELECT sow_line_key, section_token, unit_index, sitewire_job_item_id, name, budgeted_cents, is_media_item, state
       FROM sitewire_job_item_links WHERE application_id=$1`, [appId])).rows;
  const draws = (await db.query(
    `SELECT sitewire_draw_id, number, name, status, total_requested_cents, total_approved_cents, submitted_at, approved_at
       FROM sitewire_draws WHERE application_id=$1 ORDER BY number NULLS LAST`, [appId])).rows;
  const requests = (await db.query(
    `SELECT r.sitewire_draw_id, r.sitewire_job_item_id, r.sitewire_request_id, r.job_item_name, r.requested_cents, r.approved_cents, r.inspection_count
       FROM sitewire_draw_requests r JOIN sitewire_draws d ON d.sitewire_draw_id=r.sitewire_draw_id
      WHERE d.application_id=$1`, [appId])).rows;
  const ledger = (await db.query(
    `SELECT sitewire_draw_id, approved_cents, fee_cents, net_release_cents, retainage_held_cents, fee_kind, release_date, funded_status
       FROM draw_disbursements WHERE application_id=$1 ORDER BY created_at`, [appId])).rows;
  // The delivered-findings snapshot — the second source the approval ladder reads for "what did the
  // inspector approve on this draw". Best-effort: a file with no delivered findings simply has none.
  let findingLines = [];
  try {
    findingLines = (await db.query(
      `SELECT f.sitewire_draw_id, fl.sitewire_request_id, fl.sow_line_key, fl.requested_cents, fl.approved_cents,
              fl.photo_count, fl.video_count
         FROM draw_finding_lines fl JOIN draw_findings f ON f.id = fl.finding_id
        WHERE f.application_id=$1 AND fl.retired_at IS NULL`, [appId])).rows;
  } catch (_) { /* best-effort — the rollup still answers from the live request mirror */ }

  // optional friendly labels from the live SOW taxonomy (never required)
  let nameByKey = {};
  if (sowState && sowState.items) {
    const M = require('./mapper');
    for (const key of Object.keys(sowState.items)) {
      try { nameByKey[key] = M.lineName(sowState, key); } catch (_) {}
    }
  }
  const rollup = computeRollup({ links, draws, requests, findingLines, nameByKey });

  // fold the ledger onto each draw (fee / net release / release date — Sitewire models none)
  const ledgerByDraw = new Map();
  for (const d of ledger) {
    const k = N(d.sitewire_draw_id);
    const cur = ledgerByDraw.get(k) || { fee_cents: 0, net_release_cents: 0, retainage_held_cents: 0, released: false, release_date: null, fee_kind: null };
    cur.fee_cents += N(d.fee_cents); cur.net_release_cents += N(d.net_release_cents);
    cur.retainage_held_cents += N(d.retainage_held_cents);
    if (d.funded_status === 'released') { cur.released = true; cur.release_date = d.release_date || cur.release_date; }
    cur.fee_kind = d.fee_kind || cur.fee_kind;
    ledgerByDraw.set(k, cur);
  }
  // OUR DRAW FEE IS KNOWN BEFORE THE RELEASE IS RECORDED (owner-reported 2026-08-03: "on the report,
  // after I clicked on final approved, I still don't see that it's deducting our fee… our release
  // amount shows the entire release amount"). The fee only reached the desk through
  // `draw_disbursements`, which is written when a human records the wire — so every report, packet
  // and desk card before that moment showed a $0 fee and a net release equal to the gross. The fee is
  // in fact settled at draw-setup time (the partner/method rule plus any per-file override), so we
  // PROJECT it here and mark it as a projection until the release makes it final.
  const projected = await projectedFee(db, appId);
  const findingByDraw = new Map();
  for (const f of (await db.query(
    `SELECT sitewire_draw_id, status FROM draw_findings WHERE application_id=$1 ORDER BY delivered_at DESC NULLS LAST`, [appId])).rows) {
    if (!findingByDraw.has(N(f.sitewire_draw_id))) findingByDraw.set(N(f.sitewire_draw_id), f);
  }
  const drawRowById = new Map(draws.map((d) => [N(d.sitewire_draw_id), d]));
  const reqRowsByDraw = new Map();
  for (const r of requests) { const k = N(r.sitewire_draw_id); const a = reqRowsByDraw.get(k) || []; a.push(r); reqRowsByDraw.set(k, a); }
  const flByDraw = new Map();
  for (const l of findingLines) { const k = N(l.sitewire_draw_id); const a = flByDraw.get(k) || []; a.push(l); flByDraw.set(k, a); }
  let feesCharged = 0, feesProjected = 0;
  for (const d of rollup.draws) {
    const l = ledgerByDraw.get(d.sitewire_draw_id);
    const m = APPROVAL.drawMoney({
      draw: drawRowById.get(d.sitewire_draw_id) || {},
      requests: reqRowsByDraw.get(d.sitewire_draw_id) || [],
      findingLines: flByDraw.get(d.sitewire_draw_id) || [],
      feeCents: l ? l.fee_cents : (projected ? projected.fee_cents : 0),
      feeRecorded: !!l,
      retainageHeldCents: l ? l.retainage_held_cents : 0,
      // For a draw with a RECORDED release, the stored net wins — it already carries the
      // out-of-pocket floor and the retainage. Until then the net is a PROJECTION (approved − fee).
      netReleaseCents: l ? l.net_release_cents : null,
      released: !!(l && l.released),
      finding: findingByDraw.get(d.sitewire_draw_id) || null,
    });
    d.fee_cents = m.fee_cents;
    d.fee_projected = m.fee_projected;
    d.net_release_cents = m.net_release_cents;
    d.retainage_held_cents = m.retainage_held_cents;
    d.released = !!(l && l.released);
    d.release_date = l ? l.release_date : null;
    d.fee_kind = (l && l.fee_kind) || (projected ? projected.fee_kind : null);
    d.approval_stage = m.approval_stage;
    d.approval_label = m.approval_label;
    d.net_explanation = APPROVAL.netExplanation(m);
    if (l) feesCharged += m.fee_cents; else feesProjected += m.fee_cents;
  }
  // OUR fees on this project, kept separately from the borrower's money (owner-directed 2026-08-03:
  // "it should keep track separately of our fees for this project").
  rollup.fees = {
    charged_cents: feesCharged,           // recorded on a release — actually earned
    projected_cents: feesProjected,       // the standard fee on draws not yet released
    total_cents: feesCharged + feesProjected,
    per_draw_cents: projected ? projected.fee_cents : null,
    fee_kind: projected ? projected.fee_kind : null,
    inspection_method: projected ? projected.method : null,
    overridden: projected ? projected.overridden : false,
  };
  return rollup;
}

/**
 * The file's standard per-draw processing fee, resolved the SAME way the coordinator's Start-draw
 * screen and the Sitewire push resolve it (partner/program rule + the per-file override), so the
 * report can never quote a fee different from the one that will actually be charged. Best-effort:
 * returns null if anything is unreadable, and the caller then simply shows no projection.
 */
async function projectedFee(db, appId) {
  try {
    const orch = require('./orchestrator');
    const link = (await db.query(
      `SELECT inspection_method, fee_cents_override FROM sitewire_property_links WHERE application_id=$1 AND matched_by='created'`, [appId])).rows[0];
    if (!link) return null;
    const a = (await db.query(
      `SELECT a.lender, pr.program FROM applications a
         LEFT JOIN product_registrations pr ON pr.application_id=a.id AND pr.is_current
        WHERE a.id=$1`, [appId])).rows[0] || {};
    const program = /gold/i.test(String(a.program || '')) ? 'gold' : 'standard';
    const rule = await orch.resolveRule(a.lender, null, program);
    const insp = orch.resolveInspection(link, rule);
    return { fee_cents: Number(insp.feeCents) || 0, fee_kind: insp.feeKind, method: insp.method, overridden: !!insp.overridden };
  } catch (_) { return null; }
}

/**
 * Build the reallocation cells for a SOW change request from the current rollup + a proposed
 * explosion. Cells are PER UNIT on multi-unit lines (key `sow_line_key:uN`) so the
 * "never cut a line below what's already drawn" rule is enforced per unit, not just per line
 * (pre-merge audit F3) — a move that cuts unit 1 below its drawn amount can no longer hide
 * behind a raise on unit 2. Single-unit / section / contingency / GC lines stay one cell.
 * Media lines are excluded (no budget).
 *   proposedItems: explodeSow(...).items  [{ sow_line_key, unit_index, budgeted_cents, is_media_item }]
 * Returns [{ key, label, budget_cents, drawn_cents, new_cents }].
 */
function buildReallocationCells(rollup, proposedItems) {
  const cellKey = (lineKey, unitIndex) => (unitIndex != null ? `${lineKey}:u${unitIndex}` : lineKey);
  // current cells from the rollup (per unit where the line has units)
  const cur = new Map();
  for (const l of rollup.lines) {
    if (l.kind === 'media') continue;
    if (l.units && l.units.length > 1) {
      for (const u of l.units) cur.set(cellKey(l.sow_line_key, u.unit_index), { label: `${l.label} — Unit ${u.unit_index}`, budget: N(u.budgeted), drawn: N(u.drawn) });
    } else {
      cur.set(l.sow_line_key, { label: l.label, budget: N(l.budgeted), drawn: N(l.drawn) });
    }
  }
  // proposed amounts aggregated to the same cell identity
  const multiLine = new Set(); // sow_line_keys that are multi-unit in EITHER current or proposed
  const unitCountByLine = {};
  for (const it of proposedItems) {
    if (it.is_media_item || String(it.sow_line_key).indexOf('__media__') === 0) continue;
    if (it.unit_index != null) { (unitCountByLine[it.sow_line_key] = unitCountByLine[it.sow_line_key] || new Set()).add(it.unit_index); }
  }
  for (const l of rollup.lines) if (l.units && l.units.length > 1) multiLine.add(l.sow_line_key);
  for (const k of Object.keys(unitCountByLine)) if (unitCountByLine[k].size > 1) multiLine.add(k);
  const prop = new Map();
  for (const it of proposedItems) {
    if (it.is_media_item || String(it.sow_line_key).indexOf('__media__') === 0) continue;
    const key = multiLine.has(it.sow_line_key) && it.unit_index != null ? cellKey(it.sow_line_key, it.unit_index) : it.sow_line_key;
    prop.set(key, (prop.get(key) || 0) + N(it.budgeted_cents));
  }
  const keys = new Set([...cur.keys(), ...prop.keys()]);
  const out = [];
  for (const k of keys) {
    const c = cur.get(k) || { label: baseLabelFromName(k.split(':')[0]), budget: 0, drawn: 0 };
    out.push({ key: k, label: c.label, budget_cents: c.budget, drawn_cents: c.drawn, new_cents: prop.has(k) ? prop.get(k) : 0 });
  }
  return out;
}

module.exports = { computeRollup, loadRollup, baseLabelFromName, buildReallocationCells, projectedFee };

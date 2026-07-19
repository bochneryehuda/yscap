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
 *   pct_complete    — drawn / budgeted (0 when budget is 0; media lines excluded)
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
 *   nameByKey: optional { sow_line_key: displayLabel } (from the live SOW taxonomy)
 *
 * Returns { lines:[…], project:{…}, draws:[…], unknown:[jobItemId…] }.
 */
function computeRollup({ links = [], draws = [], requests = [], nameByKey = {} } = {}) {
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
      const u = (line.units[l.unit_index] = line.units[l.unit_index] || { unit_index: N(l.unit_index), budgeted: 0, drawn: 0, approved_pending: 0, requested_open: 0, remaining: 0, pct_complete: 0 });
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
      const u = (line.units[l.unit_index] = line.units[l.unit_index] || { unit_index: N(l.unit_index), budgeted: 0, drawn: 0, approved_pending: 0, requested_open: 0, remaining: 0, pct_complete: 0 });
      if (approvedDraw) u.drawn += appr;
      else { u.approved_pending += appr; u.requested_open += req; }
    }
  }

  // ---- finalize remaining + pct ----
  const pct = (drawn, budget) => (budget > 0 ? Math.round((drawn / budget) * 1000) / 10 : 0); // 1-decimal %
  const lineList = [];
  const project = { budget: 0, drawn: 0, approved_pending: 0, requested_open: 0, remaining: 0, pct_complete: 0,
    contingency: null, gc: null, line_count: 0, unit_count: 0 };
  const physicalUnits = new Set(); // distinct unit indices = physical unit count (not per-unit cells)
  for (const key of Object.keys(lines)) {
    const line = lines[key];
    line.remaining = line.budgeted - line.drawn;
    line.pct_complete = pct(line.drawn, line.budgeted);
    line.units = Object.values(line.units).sort((a, b) => a.unit_index - b.unit_index);
    for (const u of line.units) { u.remaining = u.budgeted - u.drawn; u.pct_complete = pct(u.drawn, u.budgeted); }
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
  project.unit_count = physicalUnits.size; // distinct physical units, not per-unit cells

  // stable order: real lines first (by budget desc), then contingency, gc, media
  const rank = { line: 0, contingency: 1, gc: 2, media: 3 };
  lineList.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.budgeted - a.budgeted) || String(a.label).localeCompare(String(b.label)));

  // ---- per-draw summary ----
  const reqByDraw = new Map();
  for (const r of requests) {
    const arr = reqByDraw.get(N(r.sitewire_draw_id)) || [];
    arr.push(r); reqByDraw.set(N(r.sitewire_draw_id), arr);
  }
  const drawList = draws.map((d) => {
    const reqs = reqByDraw.get(N(d.sitewire_draw_id)) || [];
    // use the stored draw total when present (even if genuinely 0); fall back to summing the
    // request rows only when the total is absent (pre-merge audit #6).
    const requested = d.total_requested_cents != null ? N(d.total_requested_cents) : reqs.reduce((s, r) => s + N(r.requested_cents), 0);
    const approved = d.total_approved_cents != null ? N(d.total_approved_cents) : reqs.reduce((s, r) => s + N(r.approved_cents), 0);
    return {
      sitewire_draw_id: N(d.sitewire_draw_id), number: d.number, status: d.status,
      requested_cents: requested, approved_cents: approved,
      not_approved_cents: Math.max(0, requested - approved),
      line_count: reqs.length, submitted_at: d.submitted_at || null, approved_at: d.approved_at || null,
      is_funded: isApprovedStatus(d.status),
    };
  }).sort((a, b) => (b.number || 0) - (a.number || 0));

  return { lines: lineList, project, draws: drawList, unknown };
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
    `SELECT sitewire_draw_id, approved_cents, fee_cents, net_release_cents, fee_kind, release_date, funded_status
       FROM draw_disbursements WHERE application_id=$1 ORDER BY created_at`, [appId])).rows;

  // optional friendly labels from the live SOW taxonomy (never required)
  let nameByKey = {};
  if (sowState && sowState.items) {
    const M = require('./mapper');
    for (const key of Object.keys(sowState.items)) {
      try { nameByKey[key] = M.lineName(sowState, key); } catch (_) {}
    }
  }
  const rollup = computeRollup({ links, draws, requests, nameByKey });

  // fold the ledger onto each draw (fee / net release / release date — Sitewire models none)
  const ledgerByDraw = new Map();
  for (const d of ledger) {
    const k = N(d.sitewire_draw_id);
    const cur = ledgerByDraw.get(k) || { fee_cents: 0, net_release_cents: 0, released: false, release_date: null, fee_kind: null };
    cur.fee_cents += N(d.fee_cents); cur.net_release_cents += N(d.net_release_cents);
    if (d.funded_status === 'released') { cur.released = true; cur.release_date = d.release_date || cur.release_date; }
    cur.fee_kind = d.fee_kind || cur.fee_kind;
    ledgerByDraw.set(k, cur);
  }
  for (const d of rollup.draws) {
    const l = ledgerByDraw.get(d.sitewire_draw_id);
    d.fee_cents = l ? l.fee_cents : 0;
    d.net_release_cents = l ? l.net_release_cents : Math.max(0, d.approved_cents - d.fee_cents);
    d.released = l ? l.released : false;
    d.release_date = l ? l.release_date : null;
    d.fee_kind = l ? l.fee_kind : null;
  }
  return rollup;
}

module.exports = { computeRollup, loadRollup, baseLabelFromName };

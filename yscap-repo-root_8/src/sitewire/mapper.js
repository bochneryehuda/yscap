'use strict';
/**
 * Sitewire mapper — the per-unit budget crosswalk core (research doc §4).
 *
 * Our Scope of Work keeps ONE line with per-unit columns; Sitewire keeps ONE line
 * PER UNIT. explodeSow() fans our cells out into deterministic per-unit job items;
 * reverseReconcile() rolls the pulled per-unit draw requests back up to our single
 * SOW line. Pure functions — no I/O — so the round-trip is unit-testable.
 *
 * Names resolve from the SOW builder's frozen taxonomy (mirrored below) exactly as
 * web/tools/rehab-budget.js does: a line's display name = it.label || taxonomy name.
 */
const T = require('./transforms');

// ---- CATS taxonomy (mirror of web/tools/rehab-budget.js — index -> item name) ----
const CATS = {
  soft: ['Permits', 'Architectural / engineering', 'Survey', 'Inspections / testing', 'Interior design / drawings'],
  genconds: ['Supervision / project management', 'Temporary utilities', 'Temporary toilet', 'Dumpsters / debris', 'Equipment rental', "Builder's risk / liability insurance"],
  demo: ['Interior demolition', 'Exterior demolition', 'Dumpster / trash-out', 'Hazmat / mold remediation'],
  site: ['Grading / drainage', 'Driveway / walkway', 'Landscaping', 'Fencing', 'Tree removal', 'Retaining wall'],
  siteutil: ['Excavation / earthwork', 'Water service / tap', 'Sewer connection / septic', 'Electric service', 'Gas service', 'Storm drainage', 'Well'],
  foundation: ['Foundation repair', 'Structural framing', 'Beams / posts / supports', 'Waterproofing', 'Underpinning'],
  shell: ['Footings', 'Foundation walls', 'Slab', 'Framing package', 'Sheathing', 'Roof trusses', 'Structural steel'],
  exterior: ['Roof', 'Siding', 'Windows', 'Exterior doors', 'Gutters & downspouts', 'Exterior paint', 'Porch / deck', 'Garage door', 'Soffit / fascia'],
  interior: ['Framing / drywall', 'Insulation', 'Interior doors', 'Trim / millwork', 'Interior paint', 'Stairs / railings', 'Closets / shelving'],
  flooring: ['Hardwood', 'Luxury vinyl / laminate', 'Tile', 'Carpet', 'Subfloor repair'],
  mep: ['Electrical — rough', 'Electrical — finish', 'Panel / service upgrade', 'Plumbing — rough', 'Plumbing — finish', 'Water heater', 'HVAC system', 'Ductwork'],
  kitchen: ['Cabinets', 'Countertops', 'Backsplash', 'Sink & faucet', 'Kitchen flooring', 'Lighting'],
  baths: ['Full bath remodel', 'Tub / shower', 'Vanity & top', 'Toilet', 'Tile', 'Fixtures'],
  appliances: ['Refrigerator', 'Range / oven', 'Dishwasher', 'Microwave', 'Washer / dryer'],
  basement: ['Finish basement', 'Egress window', 'Sump pump', 'Basement waterproofing'],
  special: ['Pool / spa', 'ADU / addition', 'Solar', 'Other'],
  final: ['Final cleaning', 'Punch list', 'Staging'],
  other: [],
};

const SENTINEL = { CONTINGENCY: '__contingency__', GC: '__gc__' };

function unitCount(state) {
  if (!state) return 1;
  if (state.propType === 'single') return 1;
  return Math.max(1, parseInt(state.units, 10) || 1);
}
function isMulti(state) { return unitCount(state) > 1; }

// Resolve a line's base display name from the saved state (label override wins).
function lineName(state, key) {
  const it = (state.items && state.items[key]) || {};
  if (it.label && String(it.label).trim()) return String(it.label).trim();
  if (key.indexOf('x:') === 0) {
    const id = key.slice(2);
    const c = (state.custom || []).find((x) => String(x.id) === id);
    return (c && (c.name || c.label)) ? String(c.name || c.label) : 'Custom item';
  }
  const [cid, i] = key.split(':');
  const arr = CATS[cid];
  return (arr && arr[+i] != null) ? arr[+i] : key;
}

// The atomic budget cells of a saved SOW (mirrors lineTotal/lineSectionVal). Each cell:
//   { sow_line_key, section_token, unit_index, name, budgeted_cents }
// Contingency + GC are appended as their own project cells (so the Sitewire total ties
// to rehab_budget). Off lines and zero cells are still emitted for line items (so a $0
// line still has a Sitewire counterpart) — callers may drop zero cells if desired.
function sowCells(state) {
  const cells = [];
  if (!state || typeof state !== 'object') return cells;
  const items = state.items || {};
  const N = unitCount(state);
  const multi = isMulti(state);
  for (const key of Object.keys(items)) {
    const it = items[key] || {};
    if (!it.on) continue;
    const base = lineName(state, key);
    if (!multi) {
      cells.push({ sow_line_key: key, section_token: 'all', unit_index: null, name: base, budgeted_cents: T.dollarsToCents(it.each) });
      continue;
    }
    const applies = it.applies || 'each';
    if (applies === 'each') {
      const c = T.dollarsToCents(it.each);
      for (let u = 1; u <= N; u++) cells.push({ sow_line_key: key, section_token: 'u' + u, unit_index: u, name: T.unitLineName(base, u), budgeted_cents: c });
    } else if (applies === 'split') {
      for (let u = 1; u <= N; u++) cells.push({ sow_line_key: key, section_token: 'u' + u, unit_index: u, name: T.unitLineName(base, u), budgeted_cents: T.dollarsToCents((it.u || {})['u' + u]) });
    } else if (applies === 'common') {
      cells.push({ sow_line_key: key, section_token: 'common', unit_index: null, name: T.sectionLineName('common', base), budgeted_cents: T.dollarsToCents(it.common) });
    } else if (applies === 'exterior') {
      cells.push({ sow_line_key: key, section_token: 'exterior', unit_index: null, name: T.sectionLineName('exterior', base), budgeted_cents: T.dollarsToCents(it.exterior) });
    } else {
      cells.push({ sow_line_key: key, section_token: 'project', unit_index: null, name: T.sectionLineName('project', base), budgeted_cents: T.dollarsToCents(it.project) });
    }
  }
  return cells;
}

// Contingency + GC amounts from the saved state (mirror contingency()/gcFeeAmt()).
function subtotalCents(cells) { return cells.reduce((s, c) => s + (c.budgeted_cents || 0), 0); }
function contingencyCents(state, subCents) {
  const c = state.cont || {};
  if (c.mode === 'pct') return Math.round(subCents * (T.num(c.value) / 100));
  return T.dollarsToCents(c.value);
}
function gcCents(state, subCents) {
  const g = state.gcFee || {};
  if (g.mode === 'pct') return Math.round(subCents * (T.num(g.value) / 100));
  return T.dollarsToCents(g.value);
}

// Standard $0 mandatory media anchors (gate every draw). Per-unit video tour + one
// exterior photo set — matching what YS enters by hand in Sitewire today.
function mediaAnchors(state, defaults = {}) {
  const N = unitCount(state);
  const img = defaults.required_image_count != null ? defaults.required_image_count : 4;
  const vid = defaults.required_video_count != null ? defaults.required_video_count : 6;
  const anchors = [{ sow_line_key: '__media__:exterior', section_token: 'media', unit_index: null, name: 'Exterior of House Photos', budgeted_cents: 0, is_media_item: true, mandatory: true, required_image_count: img, required_video_count: 0 }];
  if (N > 1) {
    for (let u = 1; u <= N; u++) anchors.push({ sow_line_key: '__media__:video_u' + u, section_token: 'media', unit_index: u, name: `Unit ${u} Interior Video Tour`, budgeted_cents: 0, is_media_item: true, mandatory: true, required_image_count: 0, required_video_count: vid });
  } else {
    anchors.push({ sow_line_key: '__media__:video', section_token: 'media', unit_index: null, name: 'Interior Video Tour', budgeted_cents: 0, is_media_item: true, mandatory: true, required_image_count: 0, required_video_count: vid });
  }
  return anchors;
}

/**
 * Full explosion of a saved SOW into the DESIRED Sitewire job-item set, including the
 * contingency + GC lines and the $0 mandatory media anchors. Every budget cell carries
 * default per-line media requirements (research doc §2.4). Returns:
 *   { items:[{sow_line_key,section_token,unit_index,name,budgeted_cents,is_media_item,
 *             mandatory,required_image_count,required_video_count}],
 *     subtotal_cents, contingency_cents, gc_cents, total_cents }
 */
function explodeSow(state, opts = {}) {
  const perLineImg = opts.required_image_count != null ? opts.required_image_count : 5;
  const perLineVid = opts.required_video_count != null ? opts.required_video_count : 0;
  const budgetCells = sowCells(state).map((c) => ({
    ...c, is_media_item: false, mandatory: false,
    required_image_count: perLineImg, required_video_count: perLineVid,
  }));
  const sub = subtotalCents(budgetCells);
  const cont = contingencyCents(state, sub);
  const gc = gcCents(state, sub);
  const items = budgetCells.slice();
  if (cont > 0) items.push({ sow_line_key: SENTINEL.CONTINGENCY, section_token: 'project', unit_index: null, name: 'Contingency', budgeted_cents: cont, is_media_item: false, mandatory: false, required_image_count: 0, required_video_count: 0 });
  if (gc > 0) items.push({ sow_line_key: SENTINEL.GC, section_token: 'project', unit_index: null, name: 'GC Fee', budgeted_cents: gc, is_media_item: false, mandatory: false, required_image_count: 0, required_video_count: 0 });
  for (const a of mediaAnchors(state, opts.media || {})) items.push(a);
  const total = sub + cont + gc;
  return { items, subtotal_cents: sub, contingency_cents: cont, gc_cents: gc, total_cents: total };
}

/**
 * Diff the desired explosion against existing crosswalk rows (research doc §4.4).
 * Returns { creates, updates, deletes } keyed by the stable cell identity
 * (sow_line_key + section_token). A cell already bound to a Sitewire id becomes an
 * UPDATE (never a second create) — so a re-push can never duplicate.
 *   links: array of crosswalk rows { sow_line_key, section_token, sitewire_job_item_id,
 *          budgeted_cents, name, id }
 */
function diffBudget(desiredItems, links) {
  const keyOf = (x) => `${x.sow_line_key} ${x.section_token}`;
  const byKey = new Map();
  for (const l of links) byKey.set(keyOf(l), l);
  const creates = [], updates = [], deletes = [];
  const seen = new Set();
  for (const d of desiredItems) {
    const k = keyOf(d); seen.add(k);
    const link = byKey.get(k);
    if (!link || link.sitewire_job_item_id == null) {
      creates.push(d);
    } else if ((link.budgeted_cents || 0) !== (d.budgeted_cents || 0) || (link.name || '') !== (d.name || '')) {
      updates.push({ ...d, sitewire_job_item_id: link.sitewire_job_item_id, prev_name: link.name });
    }
  }
  for (const l of links) {
    if (l.sitewire_job_item_id == null) continue;
    if (!seen.has(keyOf(l))) deletes.push(l);
  }
  return { creates, updates, deletes };
}

/**
 * Reverse reconciliation (research doc §4.5): map pulled draw requests back through
 * the crosswalk to our SOW lines and compute drawn / remaining per line and per unit.
 *   requests: [{ job_item_id, requested_cents, approved_cents }]
 *   links: crosswalk rows [{ sitewire_job_item_id, sow_line_key, section_token, unit_index, budgeted_cents, is_media_item }]
 * Returns { byLine: {sow_line_key: {budget,drawn,requested,remaining,units:{u:{budget,drawn,remaining}}}},
 *           unknown: [job_item_id...] }  — unknown = a Sitewire line with no crosswalk (G-UNKNOWN).
 */
function reverseReconcile(requests, links) {
  const byJid = new Map();
  for (const l of links) if (l.sitewire_job_item_id != null) byJid.set(Number(l.sitewire_job_item_id), l);
  const byLine = {};
  const unknown = [];
  // seed budgets from the crosswalk so remaining is right even with no draw yet
  for (const l of links) {
    if (l.is_media_item) continue;
    const line = (byLine[l.sow_line_key] = byLine[l.sow_line_key] || { budget: 0, drawn: 0, requested: 0, remaining: 0, units: {} });
    line.budget += l.budgeted_cents || 0;
    if (l.unit_index != null) {
      const u = (line.units[l.unit_index] = line.units[l.unit_index] || { budget: 0, drawn: 0, remaining: 0 });
      u.budget += l.budgeted_cents || 0;
    }
  }
  for (const r of requests || []) {
    const l = byJid.get(Number(r.job_item_id));
    if (!l) { unknown.push(r.job_item_id); continue; }
    if (l.is_media_item) continue;
    const appr = r.approved_cents == null ? 0 : Number(r.approved_cents) || 0;
    const req = Number(r.requested_cents) || 0;
    const line = (byLine[l.sow_line_key] = byLine[l.sow_line_key] || { budget: 0, drawn: 0, requested: 0, remaining: 0, units: {} });
    line.drawn += appr; line.requested += req;
    if (l.unit_index != null) {
      const u = (line.units[l.unit_index] = line.units[l.unit_index] || { budget: 0, drawn: 0, remaining: 0 });
      u.drawn += appr;
    }
  }
  for (const key of Object.keys(byLine)) {
    const line = byLine[key];
    line.remaining = line.budget - line.drawn;
    for (const u of Object.keys(line.units)) line.units[u].remaining = line.units[u].budget - line.units[u].drawn;
  }
  return { byLine, unknown };
}

module.exports = {
  CATS, SENTINEL, unitCount, isMulti, lineName, sowCells,
  subtotalCents, contingencyCents, gcCents, mediaAnchors,
  explodeSow, diffBudget, reverseReconcile,
};

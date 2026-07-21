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

// Human-readable category labels (used to disambiguate a name that repeats across categories).
const CAT_LABELS = {
  soft: 'Soft Costs', genconds: 'General Conditions', demo: 'Demolition', site: 'Site Work',
  siteutil: 'Site & Utilities', foundation: 'Foundation', shell: 'Shell', exterior: 'Exterior',
  interior: 'Interior', flooring: 'Flooring', mep: 'MEP', kitchen: 'Kitchen', baths: 'Baths',
  appliances: 'Appliances', basement: 'Basement', special: 'Special', final: 'Final', other: 'Other',
};
// Taxonomy base names that appear in MORE THAN ONE category (e.g. "Tile" in flooring AND baths).
// These are ALWAYS qualified with their category so two default lines can never explode to the same
// Sitewire name — the "disambiguate" half of G-NAME (bind-by-name must be unambiguous). Static.
const DUP_TAX_NAMES = (() => {
  const count = {};
  for (const cid of Object.keys(CATS)) for (const nm of CATS[cid]) count[nm] = (count[nm] || 0) + 1;
  return new Set(Object.keys(count).filter((k) => count[k] > 1));
})();
// The category label for a cell's sow_line_key ("cid:idx" -> "Kitchen"); null for custom/sentinel/media.
function catLabelOf(sowLineKey) {
  const k = String(sowLineKey || '');
  if (k.indexOf('x:') === 0 || k.indexOf('__') === 0) return null;
  return CAT_LABELS[k.split(':')[0]] || null;
}

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
  const base = (arr && arr[+i] != null) ? arr[+i] : key;
  // A name that lives in more than one category (e.g. "Tile" in flooring AND baths) is ALWAYS
  // qualified with its category, so the default taxonomy can never produce two identical Sitewire
  // job-item names — which would make bind-by-name ambiguous and strand/duplicate lines (G-NAME).
  if (DUP_TAX_NAMES.has(base) && CAT_LABELS[cid]) return `${base} (${CAT_LABELS[cid]})`;
  return base;
}

// Guarantee EVERY job-item name in the pushed set is unique (bind-by-name can never be ambiguous).
// Cross-category taxonomy dups are already handled by lineName; this catches residual collisions from
// user LABEL OVERRIDES or two CUSTOM lines sharing a label. Deterministic + stable: media anchors and
// already-unique names keep their exact name; a collider is qualified by its category, then by a stable
// counter if still colliding. Mutates + returns the items array.
function uniquifyNames(items) {
  const counts = {};
  for (const it of items) counts[it.name] = (counts[it.name] || 0) + 1;
  const used = new Set();
  // reserve canonical names first: anything already unique, plus media anchors (structural, never renamed)
  for (const it of items) if (counts[it.name] === 1 || it.is_media_item) used.add(it.name);
  for (const it of items) {
    if (counts[it.name] === 1 || it.is_media_item) continue;
    const q = catLabelOf(it.sow_line_key);
    const base = q ? `${it.name} (${q})` : it.name;
    let name = base, k = 2;
    while (used.has(name)) name = `${base} #${k++}`;
    it.name = name; used.add(name);
  }
  return items;
}

// The atomic budget cells of a saved SOW (mirrors lineTotal/lineSectionVal). Each cell:
//   { sow_line_key, section_token, unit_index, name, budgeted_cents }
// Contingency + GC are appended as their own project cells (so the Sitewire total ties
// to rehab_budget). Lines toggled OFF are skipped; an ON line with a $0 cell is still
// emitted here (this is the raw cell set) — explodeSow() drops the $0 budget cells so
// no empty line item is ever pushed to Sitewire (the mandatory $0 media anchors are kept).
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
  // Drop $0 BUDGET lines: an ON Scope-of-Work line carrying no dollars is an EMPTY job item
  // that just clutters Sitewire (owner-reported 2026-07-21 — "when you push it to Sitewire it
  // still comes up all the empty fields as well"). Our own draw screen already hides these, so
  // Sitewire must match. Safe for G-RECON: a $0 cell adds nothing to the subtotal, so Σ items
  // still ties to the frozen budget to the cent. The mandatory $0 MEDIA anchors (Exterior Photos,
  // Interior Video Tour) are added SEPARATELY below and are NOT budget cells — they must stay
  // (they are the photo/video inspection gates, not empty money lines). A per-unit 'split' line
  // with some columns at $0 correctly pushes only the funded units.
  const budgetCells = sowCells(state)
    .filter((c) => Number(c.budgeted_cents || 0) > 0)
    .map((c) => ({
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
  uniquifyNames(items); // G-NAME: guarantee every Sitewire job-item name is unique (bindable)
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
      // pg returns bigint as a STRING — coerce before comparing, or every unchanged line
      // would look changed and re-push as an UPDATE (defeats no-op suppression).
    } else if (Number(link.budgeted_cents || 0) !== Number(d.budgeted_cents || 0) || (link.name || '') !== (d.name || '')) {
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
 * Read-before-write adoption (G-ADOPT). A desired line with no crosswalk row is normally a CREATE — but
 * if a job item of the SAME name already exists on the LIVE Sitewire budget, creating it makes a DUPLICATE,
 * which then makes bind-by-name ambiguous ("… appears twice — cannot bind id"). Such a pre-existing line
 * comes from either a Sitewire-seeded default (e.g. the standard "Exterior of House Photos" media anchor)
 * or a line stranded by a partially-persisted / in-call-retried earlier push. So instead of blindly
 * creating: ADOPT the existing line by its unique name; only a genuinely-absent name is created; a name
 * that already appears MORE THAN ONCE live is ambiguous (park, never create a third).
 *
 * Pure — no I/O. Inputs:
 *   creates       : the diffBudget().creates array (desired cells with no crosswalk id yet)
 *   liveJobItems  : the LIVE budget's job_items ([{id,name,budgeted_cents}]) — omit/empty → every create
 *                   stays a create (back-compat with a fresh, empty budget).
 * Returns { create:[...unchanged desired cells...], adopt:[{...cell, sitewire_job_item_id, live_budgeted_cents}],
 *           ambiguous:[name,...] }.
 */
function resolveCreatesAgainstLive(creates, liveJobItems, drawnIds) {
  const drawn = drawnIds instanceof Set ? drawnIds : new Set();
  // Group ALL live lines by name (not just first/null) so a doubled name can be inspected.
  const liveByName = new Map();
  for (const ji of (liveJobItems || [])) {
    if (!ji || ji.name == null) continue;
    if (!liveByName.has(ji.name)) liveByName.set(ji.name, []);
    liveByName.get(ji.name).push(ji);
  }
  const create = [], adopt = [], ambiguous = [];
  for (const c of (creates || [])) {
    const lives = liveByName.get(c.name);
    if (!lives || !lives.length) { create.push(c); continue; }
    if (lives.length === 1) { adopt.push({ ...c, sitewire_job_item_id: lives[0].id, live_budgeted_cents: lives[0].budgeted_cents }); continue; }
    // DOUBLED live name. A $0 MEDIA anchor (a photo/video requirement, not money) duplicated by a
    // Sitewire-seeded default or an old buggy push is HARMLESS — bind to ONE un-drawn copy instead of
    // parking (the owner-reported "Exterior of House Photos appears twice — cannot bind id"). We never
    // delete the extra: it's a $0 photo checklist item Sitewire re-seeds, and deleting live Sitewire
    // data is out of scope for a bind. A MONEY line, or a media line whose copies are ALL drawn, stays a
    // genuine ambiguity a human must resolve.
    const bindable = lives.find((ji) => !drawn.has(Number(ji.id)));
    const allZeroMedia = !!c.is_media_item && Number(c.budgeted_cents || 0) === 0
      && lives.every((ji) => Number(ji.budgeted_cents || 0) === 0);
    if (allZeroMedia && bindable) { adopt.push({ ...c, sitewire_job_item_id: bindable.id, live_budgeted_cents: bindable.budgeted_cents }); continue; }
    ambiguous.push(c.name);
  }
  return { create, adopt, ambiguous };
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
  // (pg bigint -> string, so Number() before summing).
  for (const l of links) {
    if (l.is_media_item) continue;
    const line = (byLine[l.sow_line_key] = byLine[l.sow_line_key] || { budget: 0, drawn: 0, requested: 0, remaining: 0, units: {} });
    line.budget += Number(l.budgeted_cents || 0);
    if (l.unit_index != null) {
      const u = (line.units[l.unit_index] = line.units[l.unit_index] || { budget: 0, drawn: 0, remaining: 0 });
      u.budget += Number(l.budgeted_cents || 0);
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

/**
 * Reconcile the exploded total to the authoritative frozen budget to the cent, absorbing
 * a SMALL rounding residual (research doc §11.3 / audit S4). The SOW builder computes the
 * grand total in the dollar domain and rounds once; our per-cell cents recompute of a
 * percentage contingency + GC can drift by a cent or two. When the drift is within
 * `tolCents`, we add it to the Contingency line (else GC, else a new Contingency line) so
 * Σ job items == budget EXACTLY and G-RECON passes. A drift beyond tolerance is a REAL
 * mismatch — left unchanged so G-RECON still blocks + parks. Returns the (maybe-adjusted)
 * explosion result.
 */
function reconcileToBudget(ex, budgetCents, tolCents = 100) {
  const drift = Math.round(Number(budgetCents) || 0) - (ex.total_cents || 0);
  if (drift === 0 || Math.abs(drift) > tolCents) return ex;
  const items = ex.items.slice();
  let target = items.find((i) => i.sow_line_key === SENTINEL.CONTINGENCY)
            || items.find((i) => i.sow_line_key === SENTINEL.GC);
  if (target) {
    const adjusted = (target.budgeted_cents || 0) + drift;
    // A negative residual larger than the absorber line would push it below zero —
    // never construct a negative budget line (Sitewire 422s it). Don't fudge; let
    // G-RECON see the true mismatch and block/park.
    if (adjusted < 0) return ex;
    target.budgeted_cents = adjusted;
  } else if (drift > 0) {
    // no contingency/GC line to absorb into — add a small Contingency line for the residual
    items.push({ sow_line_key: SENTINEL.CONTINGENCY, section_token: 'project', unit_index: null, name: 'Contingency', budgeted_cents: drift, is_media_item: false, mandatory: false, required_image_count: 0, required_video_count: 0 });
  } else {
    return ex; // negative drift with no absorber — don't fudge line items; let G-RECON block
  }
  return { ...ex, items, contingency_cents: ex.contingency_cents + (target && target.sow_line_key === SENTINEL.CONTINGENCY ? drift : 0), total_cents: (ex.total_cents || 0) + drift };
}

module.exports = {
  CATS, SENTINEL, CAT_LABELS, DUP_TAX_NAMES, catLabelOf, uniquifyNames,
  unitCount, isMulti, lineName, sowCells,
  subtotalCents, contingencyCents, gcCents, mediaAnchors,
  explodeSow, reconcileToBudget, diffBudget, resolveCreatesAgainstLive, reverseReconcile,
};

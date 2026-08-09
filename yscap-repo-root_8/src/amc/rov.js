'use strict';
/**
 * ROV (Reconsideration of Value) support — pull comparable sales from the Property
 * Research Center and turn a disputed value into a reconsideration request.
 *
 * The owner asked for the ROV to be "connected with the Property Research part" so
 * supporting comps come in automatically. suggestComps() reuses the SAME search
 * engine the research desk's /comps screen uses (src/lib/research/search.js) — same
 * banding, same recent-closed-sale rule — so the ROV and the research desk can never
 * disagree about what a comparable is. buildRovNarrative()/buildRovDetail() are PURE:
 * the narrative that rides the AMC AddRevision and the structured detail stored in
 * amc_order_revisions.rov_detail are unit-tested without a DB.
 *
 * The dispute itself is placed through src/amc/revisions.js (kind='rov'); this module
 * only assembles the evidence and the words.
 */
const S = require('../lib/research/search');

// The file's subject property in the research warehouse (the subject observation of
// its most recent appraisal). Null when no appraisal has been ingested yet.
async function subjectForApplication(dbh, appId) {
  const r = await dbh.query(
    `SELECT p.* FROM properties p
       JOIN property_observations o ON o.property_id = p.id
      WHERE o.application_id = $1 AND o.role = 'subject'
      ORDER BY o.observed_on DESC NULLS LAST LIMIT 1`, [appId]);
  return r.rows[0] || null;
}

// The owner's unit band: a 1-unit subject compares with 1-unit sales, a 2-4 with
// 2-4, a 5+ with 5+. An unknown count bands nothing (never guess).
function unitBand(units) {
  const u = parseInt(units, 10);
  if (!Number.isInteger(u) || u < 1) return null;
  if (u === 1) return { units_min: 1, units_max: 1, units_unknown_ok: '1' };
  if (u <= 4) return { units_min: 2, units_max: 4, units_unknown_ok: '1' };
  return { units_min: 5, units_unknown_ok: '1' };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Shape a research property row into an ROV comp.
function compRow(row) {
  return {
    propertyId: row.id,
    address: row.display_address || [row.street, row.city, row.state].filter(Boolean).join(', ') || null,
    city: row.city || null,
    state: row.state || null,
    salePrice: num(row.last_sale_price),
    saleDate: row.last_sale_date ? String(row.last_sale_date).slice(0, 10) : null,
    gla: num(row.gla),
    beds: num(row.beds),
    bathsFull: num(row.baths_full),
    bathsHalf: num(row.baths_half),
    units: num(row.units),
    yearBuilt: num(row.year_built),
    distanceMiles: num(row.distance_miles),
  };
}

/**
 * Comparable sales near the file's subject, ready to attach to an ROV. Reuses the
 * research search with the /comps defaults (same city, closed sales in the last
 * `soldWithinMonths`, within 0.6–1.6× the subject's size, unit-banded). Returns
 * { subject, comps } — { subject:null, comps:[] } when no appraisal is on file yet.
 */
async function suggestComps(dbh, appId, opts = {}) {
  const subject = await subjectForApplication(dbh, appId);
  if (!subject) return { subject: null, comps: [], reason: 'no_subject_on_file' };
  const filters = Object.assign({
    state: subject.state, city: subject.city,
    has_sale: '1', sale_status: 'closed',
    sold_within_months: opts.soldWithinMonths || 12,
    limit: opts.limit || 10,
  }, unitBand(subject.units) || {});
  if (subject.gla) { filters.sqft_min = Math.round(subject.gla * 0.6); filters.sqft_max = Math.round(subject.gla * 1.6); }
  let out;
  try { out = await S.searchProperties(dbh, filters); }
  catch (_) { return { subject: shapeSubject(subject), comps: [], reason: 'search_failed' }; }
  const comps = (out.rows || []).filter((r) => String(r.id) !== String(subject.id)).map(compRow);
  return { subject: shapeSubject(subject), comps, total: out.total || comps.length };
}

function shapeSubject(p) {
  return {
    propertyId: p.id, address: p.display_address || null, city: p.city || null, state: p.state || null,
    gla: num(p.gla), units: num(p.units), beds: num(p.beds), bathsFull: num(p.baths_full),
    yearBuilt: num(p.year_built),
  };
}

/**
 * FREE SEARCH over the Property Research Center for ROV comps. Reuses the SAME
 * search engine the research desk uses (src/lib/research/search.js) — so the ROV
 * builder and the research desk can never disagree about what a comparable sale is
 * — scoped to CLOSED sales (a value dispute is argued on sales, not listings) and
 * always excluding the file's own subject. Returns compRow-shaped rows plus paging,
 * so staff can pick exactly which comparables to attach to a dispute.
 *
 * When the caller names no place at all, the subject's own town seeds the first
 * search so it opens on the neighbourhood rather than the whole warehouse. Every
 * other filter is passed straight through. NEVER throws — a search failure returns
 * an empty page with a reason.
 */
async function searchComps(dbh, appId, query = {}) {
  const subject = await subjectForApplication(dbh, appId);
  const q = query || {};
  const filters = {
    q: q.q, state: q.state, city: q.city, zip: q.zip,
    beds_min: q.beds_min, beds_max: q.beds_max,
    baths_min: q.baths_min, baths_max: q.baths_max,
    sqft_min: q.sqft_min, sqft_max: q.sqft_max,
    price_min: q.price_min, price_max: q.price_max,
    year_min: q.year_min, year_max: q.year_max,
    units_min: q.units_min, units_max: q.units_max,
    sold_within_months: q.sold_within_months,
    // Default to closed sales, but let a caller widen to listings/pending on purpose.
    sale_status: q.sale_status || 'closed',
    has_sale: q.has_sale != null ? q.has_sale : '1',
    sort: q.sort || 'recent_sale',
    page: q.page,
    limit: Math.min(25, Math.max(1, parseInt(q.limit, 10) || 12)),
  };
  const hasPlace = ['q', 'state', 'city', 'zip'].some((k) => q[k] != null && String(q[k]).trim() !== '');
  if (!hasPlace && subject) { filters.state = subject.state; filters.city = subject.city; }
  if (subject) filters.exclude_property_id = subject.id;
  let out;
  try { out = await S.searchProperties(dbh, filters); }
  catch (_) {
    return { subject: subject ? shapeSubject(subject) : null, comps: [], total: 0, page: 1, pages: 1, reason: 'search_failed' };
  }
  return {
    subject: subject ? shapeSubject(subject) : null,
    comps: (out.rows || []).map(compRow),
    total: out.total || 0, page: out.page || 1, pages: out.pages || 1,
  };
}

// The structured ROV detail stored in amc_order_revisions.rov_detail (auditable +
// reproducible). PURE.
function buildRovDetail({ appraisedValue, opinionValue, comps, note } = {}) {
  return {
    appraisedValue: num(appraisedValue),
    opinionValue: num(opinionValue),
    note: note ? String(note).trim() : null,
    comps: Array.isArray(comps) ? comps.map((c) => ({
      propertyId: c.propertyId || null,
      address: c.address || null,
      salePrice: num(c.salePrice),
      saleDate: c.saleDate || null,
      gla: num(c.gla),
      beds: num(c.beds),
      bathsFull: num(c.bathsFull),
      bathsHalf: num(c.bathsHalf),
      distanceMiles: num(c.distanceMiles),
    })) : [],
  };
}

function money(n) { const v = num(n); return v == null ? null : '$' + Math.round(v).toLocaleString('en-US'); }

// The narrative that rides the AMC AddRevision for an ROV. PURE — built entirely from
// the detail, so what the AMC reads and what we store can never drift.
function buildRovNarrative(detail = {}) {
  const d = detail || {};
  const lines = ['Reconsideration of Value (ROV) request.'];
  if (d.appraisedValue != null) {
    lines.push(`We respectfully request reconsideration of the appraised value of ${money(d.appraisedValue)}.`);
  }
  const comps = Array.isArray(d.comps) ? d.comps.filter((c) => c && (c.address || c.salePrice != null)) : [];
  if (comps.length) {
    lines.push(d.opinionValue != null
      ? `Based on the comparable sales below, an opinion of value of ${money(d.opinionValue)} is better supported:`
      : 'We believe the following comparable sales better support the subject’s value:');
    comps.forEach((c, i) => {
      const bits = [];
      if (c.salePrice != null) bits.push(`sold ${money(c.salePrice)}`);
      if (c.saleDate) bits.push(`on ${c.saleDate}`);
      const specs = [];
      if (c.gla != null) specs.push(`${c.gla} sq ft`);
      if (c.beds != null) specs.push(`${c.beds} bd`);
      if (c.bathsFull != null) specs.push(`${c.bathsFull}${c.bathsHalf ? '.' + c.bathsHalf : ''} ba`);
      let line = `${i + 1}. ${c.address || 'Comparable sale'}`;
      if (bits.length) line += ` — ${bits.join(' ')}`;
      if (specs.length) line += ` (${specs.join(', ')})`;
      if (c.distanceMiles != null) line += `, ${c.distanceMiles} mi from the subject`;
      lines.push(line + '.');
    });
  } else if (d.opinionValue != null) {
    lines.push(`We respectfully request reconsideration to a value of ${money(d.opinionValue)}.`);
  }
  if (d.note) lines.push(d.note);
  return lines.join('\n');
}

module.exports = { subjectForApplication, unitBand, suggestComps, searchComps, compRow, buildRovDetail, buildRovNarrative, money };

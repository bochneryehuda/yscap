'use strict';
/**
 * THE PROPERTY SEARCH ENGINE — the query builder behind the research screen.
 *
 * Turns a filter object (straight off the screen's query string) into ONE
 * parameterized SQL statement over `properties`, plus the total count and the
 * facet counts the sidebar shows. Kept in its own module, separate from the
 * route, because the interesting part is the SQL and it deserves to be tested
 * without an HTTP server.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO, each for a concrete reason:
 *
 *  1. NO `($1 IS NULL OR col = $1)`. That pattern reads nicely and is a planner
 *     trap: the plan is built once for the parameterized statement, so Postgres
 *     cannot know which filters are actually live and falls back to a sequential
 *     scan even when a highly selective filter IS set. Every predicate here is
 *     APPENDED only when the caller supplied it, so the plan matches the query
 *     that was actually asked (the parameter-accumulator pattern below).
 *
 *  2. NO string interpolation of user input, ever. Values only ever reach SQL as
 *     `$n` placeholders through `pg`. The only thing built from strings is the
 *     ORDER BY, and that comes from a fixed whitelist — never from the caller's
 *     text.
 *
 *  3. NO unbounded page size. `limit` is clamped, because an accidental
 *     `?limit=100000` on a warehouse table is a self-inflicted outage.
 *
 * UAD CONDITION AND QUALITY ARE ORDINAL, NOT TEXT. C1 (new) → C6 (unsound) and
 * Q1 (highest) → Q6 (lowest) are a rank, so "condition C3 or better" has to mean
 * C1..C3, not a string comparison. The range is expanded into an explicit code
 * list in JS (`= ANY($n)`), which keeps the plain btree index usable — an
 * expression like `substring(condition_uad,2)::int <= 3` would not be.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 25;

// The ordinal scales, best → worst.
const CONDITION_SCALE = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
const QUALITY_SCALE = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'];

/** "C3" → 3 on the ordinal scale (1 is best), or null when it is not on the scale. */
function rankOf(scale, code) {
  if (code == null || code === '') return null;
  const i = scale.indexOf(String(code).toUpperCase());
  return i < 0 ? null : i + 1;
}

/** Expand an ordinal range ("C2".."C4") into the explicit code list, or null for "no filter". */
function ordinalRange(scale, min, max) {
  const lo = min ? scale.indexOf(String(min).toUpperCase()) : 0;
  const hi = max ? scale.indexOf(String(max).toUpperCase()) : scale.length - 1;
  if (lo < 0 && hi < 0) return null;
  const a = lo < 0 ? 0 : lo, b = hi < 0 ? scale.length - 1 : hi;
  if (a === 0 && b === scale.length - 1) return null;
  return scale.slice(Math.min(a, b), Math.max(a, b) + 1);
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const str = (v) => { const s = String(v == null ? '' : v).trim(); return s === '' ? null : s; };
const list = (v) => {
  if (v == null || v === '') return null;
  const arr = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);
  return arr.length ? arr : null;
};

/**
 * A typed phrase → a `to_tsquery` string of AND-ed prefix terms.
 *
 * Built by hand rather than with `plainto_tsquery` because that one gives no
 * prefix matching, and `websearch_to_tsquery` gives no prefix matching either.
 * SAFETY: every character that means something to the tsquery grammar
 * (`&|!():*<>'`) is stripped, not escaped — the remaining tokens are plain words,
 * so the string can never carry an operator through. It is still passed as a
 * BOUND PARAMETER; the sanitising is about a syntax error, not about injection.
 * Returns null when nothing usable is left.
 */
function tsPrefixQuery(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  return words.length ? words.map((w) => w + ':*').join(' & ') : null;
}

/**
 * ORDER BY whitelist. The key comes from the caller; the SQL never does.
 * Every sort ends with `p.id` so paging is stable — two properties with the same
 * sale date must not swap places between page 1 and page 2.
 */
const SORTS = Object.freeze({
  recent_sale: 'p.last_sale_date DESC NULLS LAST, p.id',
  oldest_sale: 'p.last_sale_date ASC NULLS LAST, p.id',
  price_desc: 'p.last_sale_price DESC NULLS LAST, p.id',
  price_asc: 'p.last_sale_price ASC NULLS LAST, p.id',
  sqft_desc: 'p.gla DESC NULLS LAST, p.id',
  sqft_asc: 'p.gla ASC NULLS LAST, p.id',
  ppsf_desc: '(p.last_sale_price / NULLIF(p.gla,0)) DESC NULLS LAST, p.id',
  ppsf_asc: '(p.last_sale_price / NULLIF(p.gla,0)) ASC NULLS LAST, p.id',
  year_desc: 'p.year_built DESC NULLS LAST, p.id',
  address: 'p.state, lower(p.city), p.display_address, p.id',
  recent: 'p.last_seen_at DESC NULLS LAST, p.id',
  distance: 'distance_miles ASC NULLS LAST, p.id',
});

/**
 * Build the WHERE fragment + parameters for a filter set.
 * @returns {{where:string, params:Array, distanceSelect:string, sort:string, limit:number, offset:number, filters:object}}
 */
function buildQuery(input = {}) {
  const f = input || {};
  const params = [];
  const where = [];
  const P = (v) => { params.push(v); return '$' + params.length; };

  // ---- text ---------------------------------------------------------------
  const q = str(f.q);
  if (q) {
    // FULL-TEXT, NOT `ILIKE '%…%'`. A leading wildcard cannot use any btree index,
    // so the obvious version degrades to a sequential scan on every keystroke.
    // tsvector + GIN is CORE Postgres (pg_trgm is contrib and cannot be assumed on
    // a managed database), the generated `address_tsv` column is already indexed,
    // and it gives something ILIKE never could: word-order independence, so
    // "piscataway 10th" finds "26 S 10th St, Piscataway".
    //
    // Each word becomes a PREFIX term, so "pisc" matches while you are still
    // typing. The 'simple' config is deliberate — an address must not be stemmed.
    const terms = tsPrefixQuery(q);
    if (terms) where.push(`p.address_tsv @@ to_tsquery('simple', ${P(terms)})`);
    else where.push(`p.display_address ILIKE ${P('%' + q + '%')}`);   // punctuation-only input
  }
  const state = str(f.state);
  if (state) where.push(`p.state = ${P(state.toUpperCase())}`);
  const cities = list(f.city);
  if (cities) where.push(`lower(p.city) = ANY(${P(cities.map((c) => c.toLowerCase()))})`);
  const zips = list(f.zip);
  if (zips) where.push(`p.zip = ANY(${P(zips)})`);
  const county = str(f.county);
  if (county) where.push(`lower(p.county) = ${P(county.toLowerCase())}`);

  // ---- what kind of property ---------------------------------------------
  const types = list(f.property_type);
  if (types) where.push(`p.property_type = ANY(${P(types)})`);
  const unitsMin = num(f.units_min), unitsMax = num(f.units_max);
  // A PROPERTY THAT NEVER STATED ITS UNIT COUNT IS NOT PROVED TO BE THE WRONG
  // KIND. `units_unknown_ok` keeps it in the answer instead of dropping it
  // silently — for the comparable search, which bands every result to the
  // subject's own kind of building, and where an empty answer caused by missing
  // data is indistinguishable from a town we have never lent in. It is worth
  // almost nothing and costs almost nothing: measured over the real corpus, ONE
  // of 767 subject-to-comparable pairs has an unknown unit count, because a house
  // that was only ever somebody's comparable usually turns up as a SUBJECT
  // elsewhere and the roll-up fills it in. The screens render an unknown count in
  // red as "units not stated", so nothing is passed off as known.
  const unitsUnknownOk = f.units_unknown_ok === '1' || f.units_unknown_ok === true;
  const unitClauses = [];
  if (unitsMin != null) unitClauses.push(`p.units >= ${P(unitsMin)}`);
  if (unitsMax != null) unitClauses.push(`p.units <= ${P(unitsMax)}`);
  if (unitClauses.length) {
    where.push(unitsUnknownOk
      ? `((${unitClauses.join(' AND ')}) OR p.units IS NULL)`
      : unitClauses.join(' AND '));
  }

  // ---- size / rooms / age -------------------------------------------------
  const ranges = [
    ['beds', 'p.beds', f.beds_min, f.beds_max],
    ['gla', 'p.gla', f.sqft_min, f.sqft_max],
    ['year_built', 'p.year_built', f.year_min, f.year_max],
    ['total_rooms', 'p.total_rooms', f.rooms_min, f.rooms_max],
    ['last_sale_price', 'p.last_sale_price', f.price_min, f.price_max],
    // db/422 — the annual property tax the appraisal stated. Indexed
    // (idx_properties_tax_amount, partial on NOT NULL) because it is the most
    // asked-for of the facts that used to stop at `appraisals`.
    ['property_tax_amount', 'p.property_tax_amount', f.tax_min, f.tax_max],
  ];
  for (const [, col, lo, hi] of ranges) {
    const a = num(lo), b = num(hi);
    if (a != null) where.push(`${col} >= ${P(a)}`);
    if (b != null) where.push(`${col} <= ${P(b)}`);
  }
  // Baths live in two columns; `baths_total` is the generated, indexed combination
  // where a half bath counts 0.5 (UAD "2.1" is two full and one half = 2.5).
  const bathsMin = num(f.baths_min), bathsMax = num(f.baths_max);
  if (bathsMin != null) where.push(`p.baths_total >= ${P(bathsMin)}`);
  if (bathsMax != null) where.push(`p.baths_total <= ${P(bathsMax)}`);
  // The condo PROJECT by name (db/422). Matched case-insensitively against the
  // same expression `idx_properties_condo_project` indexes, so it stays indexed.
  if (str(f.condo_project)) where.push(`lower(p.condo_project_name) = lower(${P(str(f.condo_project))})`);
  // "only ones we know the tax bill for" — a distinct question from a range.
  // ACCEPTS THE SAME THREE SPELLINGS as every sibling on this builder (`has_sale`,
  // `has_photos`, `has_unit_mix`, and the `yesNo()` helper below). It used to take
  // only `'1'` and boolean true, so `?has_tax=true` — the spelling every one of
  // its neighbours accepts — returned EVERY property, indistinguishable from a
  // filter that matched everything. A value we offer is a value we accept.
  if (f.has_tax === true || f.has_tax === 'true' || f.has_tax === '1') {
    where.push('p.property_tax_amount IS NOT NULL');
  }

  const lotMin = num(f.lot_sqft_min), lotMax = num(f.lot_sqft_max);
  if (lotMin != null) where.push(`p.lot_sqft >= ${P(lotMin)}`);
  if (lotMax != null) where.push(`p.lot_sqft <= ${P(lotMax)}`);

  // ---- condition & quality --------------------------------------------------
  // THE ONE THING TO GET RIGHT HERE: C1/Q1 is the BEST grade and C6/Q6 the worst,
  // so "condition C3 or better" means rank <= 3. A plain string comparison on the
  // text column would silently mean the opposite. `condition_rank` is the
  // generated numeric column, so this stays a simple indexed range.
  const condMin = rankOf(CONDITION_SCALE, f.condition_best), condMax = rankOf(CONDITION_SCALE, f.condition_worst);
  if (condMin != null) where.push(`p.condition_rank >= ${P(condMin)}`);
  if (condMax != null) where.push(`p.condition_rank <= ${P(condMax)}`);
  const qualMin = rankOf(QUALITY_SCALE, f.quality_best), qualMax = rankOf(QUALITY_SCALE, f.quality_worst);
  if (qualMin != null) where.push(`p.quality_rank >= ${P(qualMin)}`);
  if (qualMax != null) where.push(`p.quality_rank <= ${P(qualMax)}`);
  // The explicit-code form stays supported (the facet chips send codes, not ranges).
  const condCodes = list(f.condition);
  if (condCodes) where.push(`p.condition_uad = ANY(${P(condCodes.map((c) => c.toUpperCase()))})`);
  const qualCodes = list(f.quality);
  if (qualCodes) where.push(`p.quality_uad = ANY(${P(qualCodes.map((c) => c.toUpperCase()))})`);

  // ---- the transaction ----------------------------------------------------
  const from = day(f.sold_from), to = day(f.sold_to);
  if (from) where.push(`p.last_sale_date >= ${P(from)}`);
  if (to) where.push(`p.last_sale_date <= ${P(to)}`);
  if (f.sold_within_months) {
    const m = num(f.sold_within_months);
    if (m != null && m > 0) where.push(`p.last_sale_date >= (CURRENT_DATE - ${P(Math.round(m))}::int * INTERVAL '1 month')`);
  }
  const saleStatus = list(f.sale_status);
  if (saleStatus) where.push(`COALESCE(p.last_sale_status,'closed') = ANY(${P(saleStatus)})`);
  if (f.has_sale === true || f.has_sale === 'true' || f.has_sale === '1') where.push('p.last_sale_price IS NOT NULL AND p.last_sale_date IS NOT NULL');
  if (f.has_photos === true || f.has_photos === 'true' || f.has_photos === '1') where.push('p.photo_count > 0');

  // ---- the facts the reports have always stated (db/414) -------------------
  // Each is a plain equality on a rolled-up column with a partial index behind it.
  // They are all THREE-STATE, and that is the point: `sfha=1` means the reports say
  // it IS in a flood zone, `sfha=0` means they say it is NOT, and asking for neither
  // returns both plus every property no report has ever said either way. A missing
  // fact must never be answered as a "no" — the warehouse's whole discipline.
  const yesNo = (v) => (v === true || v === 'true' || v === '1' ? true
    : (v === false || v === 'false' || v === '0' ? false : null));
  const sfha = yesNo(f.sfha);
  if (sfha !== null) where.push(`p.sfha IS ${sfha ? 'TRUE' : 'FALSE'}`);
  const adu = yesNo(f.has_adu);
  if (adu !== null) where.push(`p.has_adu IS ${adu ? 'TRUE' : 'FALSE'}`);
  const attic = yesNo(f.attic);
  if (attic !== null) where.push(`p.attic IS ${attic ? 'TRUE' : 'FALSE'}`);
  const rights = list(f.property_rights);
  if (rights) where.push(`p.property_rights = ANY(${P(rights)})`);
  const occ = list(f.occupancy_status);
  if (occ) where.push(`p.occupancy_status = ANY(${P(occ)})`);
  // "It has a rent roll" — the fact that makes a 2-4 comparable actually usable.
  if (f.has_unit_mix === true || f.has_unit_mix === 'true' || f.has_unit_mix === '1') {
    where.push(`p.unit_mix IS NOT NULL AND jsonb_array_length(p.unit_mix) > 0`);
  }
  const rentMin = num(f.market_rent_min), rentMax = num(f.market_rent_max);
  if (rentMin != null) where.push(`p.market_rent >= ${P(rentMin)}`);
  if (rentMax != null) where.push(`p.market_rent <= ${P(rentMax)}`);

  // ---- how WE know it -----------------------------------------------------
  const role = str(f.role);
  if (role === 'subject') where.push('p.subject_count > 0');
  else if (role === 'comparable' || role === 'comp') where.push('p.comp_count > 0');
  // "Was this used on an ARV grid / an As-Is grid?" is a fact of the OBSERVATION,
  // not of the property — but it is also the filter the appraisal desk reaches for
  // most, so it is denormalized onto two counters with partial indexes. (A JOIN
  // here would be the real bug: it multiplies the property row once per
  // observation and corrupts every facet count and the LIMIT along with it.)
  const compSet = list(f.comp_set);
  if (compSet) {
    const parts = [];
    if (compSet.includes('arv')) parts.push('p.arv_comp_count > 0');
    if (compSet.includes('as_is')) parts.push('p.asis_comp_count > 0');
    if (compSet.includes('unknown')) {
      parts.push(`EXISTS (SELECT 1 FROM property_observations o WHERE o.property_id = p.id
                           AND o.role = 'comparable' AND COALESCE(o.comp_set,'unknown') = 'unknown')`);
    }
    if (parts.length) where.push('(' + parts.join(' OR ') + ')');
  }
  const appraiserId = str(f.appraiser_id);
  if (appraiserId) {
    where.push(`EXISTS (SELECT 1 FROM property_observations o WHERE o.property_id = p.id
                         AND o.appraiser_id = ${P(appraiserId)})`);
  }
  const applicationId = str(f.application_id);
  if (applicationId) {
    where.push(`EXISTS (SELECT 1 FROM property_observations o WHERE o.property_id = p.id
                         AND o.application_id = ${P(applicationId)})`);
  }
  const excludeId = str(f.exclude_property_id);
  if (excludeId) where.push(`p.id <> ${P(excludeId)}`);

  // ---- radius (no PostGIS) ------------------------------------------------
  // A bounding box on the indexed lat/lng columns does the cutting; the haversine
  // refine only ever runs on what the box already narrowed to. One degree of
  // latitude is 69.05 miles everywhere; a degree of LONGITUDE is 69.17 × cos(lat),
  // which at New Jersey's latitude is only about 52 — so the longitude box has to
  // be about a third WIDER in degrees than the latitude box to cover the same
  // miles. Using one delta for both (the usual version of this bug) silently
  // clips the east-west edges off every radius search.
  //
  // IT READS `eff_latitude` / `eff_longitude`, NEVER `latitude` (db/412). Those are
  // the appraiser's own figures, which only some comparables carry and no subject
  // ever does; `eff_*` is the looked-up coordinate falling back to the appraiser's,
  // and is a generated STORED column precisely so a query cannot forget which one
  // it meant to use.
  let distanceSelect = 'NULL::numeric AS distance_miles';
  const lat = num(f.lat), lng = num(f.lng), radius = num(f.radius_miles);
  let distanceExpr = null;
  if (lat != null && lng != null) {
    const pLat = P(lat), pLng = P(lng);
    distanceExpr =
      `(3958.7613 * 2 * asin(sqrt(
          power(sin(radians(p.eff_latitude - ${pLat}) / 2), 2) +
          cos(radians(${pLat})) * cos(radians(p.eff_latitude)) *
          power(sin(radians(p.eff_longitude - ${pLng}) / 2), 2)
        )))::numeric`;
    distanceSelect = `${distanceExpr} AS distance_miles`;
    if (radius != null && radius > 0) {
      const dLat = radius / 69.0546;
      const dLng = radius / Math.max(1, 69.1710 * Math.cos((lat * Math.PI) / 180));
      where.push(`p.eff_latitude BETWEEN ${P(lat - dLat)} AND ${P(lat + dLat)}`);
      where.push(`p.eff_longitude BETWEEN ${P(lng - dLng)} AND ${P(lng + dLng)}`);
      // THE EXACT CIRCLE IS CUT IN SQL, not in JS afterwards. Filtering the page
      // in JS looks equivalent and is not: the LIMIT and the `count(*) OVER ()`
      // total both run BEFORE it, so a corner-of-the-box row that gets dropped
      // leaves the page short and the total overstated — by up to 27%, which is
      // the box's area over the circle's. Doing it here makes the count, the page
      // size and the paging all agree.
      where.push(`${distanceExpr} <= ${P(radius)}`);
    } else {
      where.push('p.eff_latitude IS NOT NULL AND p.eff_longitude IS NOT NULL');
    }
  }

  const sortKey = SORTS[str(f.sort)] ? str(f.sort) : (lat != null && lng != null ? 'distance' : 'recent_sale');
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.round(num(f.limit) || DEFAULT_LIMIT)));
  // CLAMPED, because the offset is interpolated into the SQL rather than bound:
  // `?page=1e21` stringifies as "2.5e+22" and Postgres answers "bigint out of
  // range" (or a syntax error for a larger exponent) — a plain 500 from a URL.
  const page = Math.min(1e6, Math.max(1, Math.trunc(num(f.page) || 1)));
  return {
    where: where.length ? 'WHERE ' + where.join('\n  AND ') : '',
    params, distanceSelect, sort: SORTS[sortKey], sortKey, limit, offset: (page - 1) * limit, page,
  };
}

// The columns the result list renders. Explicit, so adding a column to
// `properties` never silently widens every search payload.
const LIST_COLUMNS = `p.id, p.display_address, p.street, p.unit, p.city, p.state, p.zip, p.county,
  p.latitude, p.longitude, p.eff_latitude, p.eff_longitude, p.geo_source, p.property_type, p.property_category, p.units, p.year_built, p.gla,
  p.beds, p.baths_full, p.baths_half, p.baths_text, p.baths_total, p.total_rooms,
  p.lot_area, p.lot_sqft,
  p.condition_uad, p.condition_text, p.condition_rank, p.quality_uad, p.quality_text, p.quality_rank,
  p.view_rating, p.location_rating,
  -- WHAT THE PROPERTY LOOKS OUT ON AND WHAT IS DOWNSTAIRS (db/437), by the same
  -- rule as the block below: these were read, rolled up and then reachable by
  -- nothing. view_type is the FACT ("Cem", "Comm", a park) beside view_rating,
  -- which is one appraiser's Beneficial/Neutral/Adverse verdict on it — the
  -- verdict cannot be re-judged later and the fact can. The below-grade counts are
  -- deliberately NOT folded into beds / baths_full: those are the ABOVE-grade
  -- figures the grid states, and the whole reason the form separates them is that
  -- a basement bedroom is not a bedroom.
  p.view_type, p.location_type, p.functional_utility, p.basement_exit, p.below_grade_beds,
  p.below_grade_baths_full, p.below_grade_baths_half,
  p.below_grade_rec_rooms, p.below_grade_other_rooms,
  p.below_grade_sqft, p.below_grade_finished_sqft,
  p.sfha, p.fema_flood_zone, p.flood_zone, p.property_rights, p.occupancy_status,
  p.has_adu, p.attic, p.basement_finished_pct, p.lot_shape, p.market_rent, p.unit_mix,
  -- A FILTER WITHOUT A COLUMN IS HALF A FEATURE: you could search on the tax bill
  -- and the condo project and get back rows that never said what either was. The
  -- attachment style rides here for the same reason — db/405 kept it out of
  -- property_type so it would survive, and a fact nothing can read has not.
  p.property_tax_amount, p.property_tax_year, p.condo_project_name, p.attachment_type,
  p.hoa_fee_amount, p.hoa_fee_period, p.heating_type, p.heating_fuel, p.cooling,
  p.garage_type, p.garage_spaces, p.stories, p.design_style, p.effective_age,
  p.last_sale_price, p.last_sale_date, p.last_sale_type, p.last_sale_status, p.last_list_price,
  p.sale_count, p.subject_count, p.comp_count, p.arv_comp_count, p.asis_comp_count,
  p.observation_count, p.photo_count, p.first_observed_on, p.last_observed_on,
  -- THE PICTURE, so a comp list can show the house rather than a grey box. A
  -- scalar subquery rather than a join: joining property_photos would multiply
  -- the property row per photo and corrupt both the LIMIT and every facet count
  -- (the same trap the arv/asis comp counts are denormalized to avoid). Indexed
  -- by idx_property_photos_property, and only runs for the rows on the page.
  (SELECT pp.document_id FROM property_photos pp
    WHERE pp.property_id = p.id
    ORDER BY pp.is_primary DESC, pp.sequence NULLS LAST
    LIMIT 1) AS primary_photo_document_id`;

/** Run a search. Returns { rows, total, page, limit, pages }. */
async function searchProperties(db, filters = {}) {
  const b = buildQuery(filters);
  const sql =
    `SELECT ${LIST_COLUMNS},
            ${b.distanceSelect},
            (p.last_sale_price / NULLIF(p.gla,0))::numeric(12,2) AS price_per_sqft,
            count(*) OVER () AS total_count
       FROM properties p
       ${b.where}
      ORDER BY ${b.sort}
      LIMIT ${b.limit} OFFSET ${b.offset}`;
  const r = await db.query(sql, b.params);
  // The exact circle is already cut in SQL (see buildQuery), so the page, the total
  // and the paging all describe the same set. Nothing is filtered out here.
  const rows = r.rows;
  const total = rows.length ? Number(rows[0].total_count) : 0;
  for (const x of rows) delete x.total_count;
  return { rows, total, page: b.page, limit: b.limit, pages: Math.max(1, Math.ceil(total / b.limit)), sort: b.sortKey };
}

/**
 * Facet counts for the current filter set — how many results fall in each city,
 * bed count, price band and condition grade. ONE round trip: the filtered set is
 * materialized once in a CTE and every facet aggregates over it.
 */
async function facets(db, filters = {}) {
  const b = buildQuery(Object.assign({}, filters, { page: 1, limit: 1 }));
  // EVERY BOUND PARAMETER MUST BE REFERENCED BY THE SQL, or Postgres refuses the
  // whole statement ("bind message supplies 3 parameters, but prepared statement
  // requires 1"). With a lat/lng but no positive radius, `buildQuery` binds the
  // two coordinates for the DISTANCE expression while the WHERE only gets an
  // `IS NOT NULL` pair — so a facets query built from `b.where` alone left two
  // placeholders dangling and threw. The route catches that and returns
  // `facets: null`, so the entire filter sidebar just vanished with no error
  // anywhere. Carrying the distance select into the CTE references them again.
  // (Same class as the `viewerScope()` bug CLAUDE.md records.)
  const dist = b.distanceSelect ? `, ${b.distanceSelect}` : '';
  const sql = `
    WITH hits AS (
      SELECT p.id, p.city, p.state, p.beds, p.condition_uad, p.property_type, p.last_sale_price${dist}
        FROM properties p
        ${b.where}
    )
    SELECT
      (SELECT count(*) FROM hits) AS total,
      (SELECT json_agg(x) FROM (SELECT city, state, count(*)::int AS n FROM hits
         WHERE city IS NOT NULL GROUP BY city, state ORDER BY n DESC, city LIMIT 40) x) AS cities,
      (SELECT json_agg(x) FROM (SELECT beds, count(*)::int AS n FROM hits
         WHERE beds IS NOT NULL GROUP BY beds ORDER BY beds LIMIT 12) x) AS beds,
      (SELECT json_agg(x) FROM (SELECT condition_uad, count(*)::int AS n FROM hits
         WHERE condition_uad IS NOT NULL GROUP BY condition_uad ORDER BY condition_uad) x) AS conditions,
      (SELECT json_agg(x) FROM (SELECT property_type, count(*)::int AS n FROM hits
         WHERE property_type IS NOT NULL GROUP BY property_type ORDER BY n DESC LIMIT 20) x) AS property_types,
      (SELECT json_build_object(
          'under_200k', count(*) FILTER (WHERE last_sale_price < 200000),
          'k200_350',   count(*) FILTER (WHERE last_sale_price >= 200000 AND last_sale_price < 350000),
          'k350_500',   count(*) FILTER (WHERE last_sale_price >= 350000 AND last_sale_price < 500000),
          'k500_750',   count(*) FILTER (WHERE last_sale_price >= 500000 AND last_sale_price < 750000),
          'k750_1m',    count(*) FILTER (WHERE last_sale_price >= 750000 AND last_sale_price < 1000000),
          'over_1m',    count(*) FILTER (WHERE last_sale_price >= 1000000)
        ) FROM hits) AS price_bands`;
  const r = await db.query(sql, b.params);
  const row = r.rows[0] || {};
  return {
    total: Number(row.total || 0),
    cities: row.cities || [], beds: row.beds || [],
    conditions: row.conditions || [], property_types: row.property_types || [],
    price_bands: row.price_bands || {},
  };
}

module.exports = {
  searchProperties, facets, buildQuery, ordinalRange, rankOf, tsPrefixQuery,
  CONDITION_SCALE, QUALITY_SCALE, SORTS, MAX_LIMIT, DEFAULT_LIMIT, LIST_COLUMNS,
};

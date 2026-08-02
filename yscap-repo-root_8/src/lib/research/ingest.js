'use strict';
/**
 * THE INGEST — fold ONE imported appraisal into the research warehouse (db/406).
 *
 * Reads the per-file tables the appraisal import already wrote (`appraisals`,
 * `appraisal_comparables`, `appraisal_units`, `appraisal_photos`) and lands them
 * in the cross-file warehouse: the appraiser registry, one `properties` row per
 * distinct address, one `property_observations` row per (report × property), the
 * distinct `property_sales`, and the photo links.
 *
 * FOUR RULES, and every one of them is load-bearing:
 *
 *  1. IDEMPOTENT. Running it twice on the same report changes nothing (the two
 *     partial unique indexes on `property_observations` make the observation
 *     upsert the pivot). That is what lets the back-fill be re-runnable, lets a
 *     re-import refresh rather than duplicate, and lets a failure be retried.
 *
 *  2. NEVER GUESS. A comparable whose address cannot be identified (no house
 *     number, no state, no locality) is SKIPPED and counted — never stored under
 *     an invented key. A fact the report did not state stays null; it is never
 *     borrowed from another report at write time. (The roll-up below does choose
 *     between reports, but only among reports that actually stated the fact.)
 *
 *  3. BEST-EFFORT, NEVER FATAL. This runs fire-and-forget after an import. It
 *     must never throw into the import's transaction, never slow the officer
 *     down, and never leave a half-written report — each report is one
 *     transaction, and a failure is recorded on `property_ingest_log` so the
 *     back-fill can see it and retry rather than skipping it forever in silence.
 *
 *  4. THE ROLL-UP IS DERIVED, NEVER AUTHORED. `properties.*` holds the
 *     best-known current answer for each fact, and it is recomputed from the
 *     observations every time one is written: for each column, the most RECENT
 *     report that stated it wins (by the report's effective date, then by when
 *     we imported it). Nothing writes a property fact directly, so the warehouse
 *     can always answer "which report said that?" — which is the whole point of
 *     keeping observations in the first place.
 */
const K = require('./property-key');
const ID = require('./identity');

const INGEST_VERSION = 1;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const txt = (v) => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };
const dateOnly = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : K.saleDate(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
};

/**
 * The FACT columns of `property_observations` that roll up onto `properties`,
 * mapped observation column → property column. Order is irrelevant; presence is
 * what matters — a column listed here is a fact about the PROPERTY (durable),
 * and a column NOT listed here is a fact about the REPORT (this appraiser's
 * opinion on this date: proximity, adjustments, comp_set, price_per_gla).
 */
const ROLLUP_FACTS = Object.freeze({
  property_type: 'property_type', property_category: 'property_category',
  units: 'units', year_built: 'year_built', gla: 'gla', lot_area: 'lot_area', lot_sqft: 'lot_sqft',
  beds: 'beds', baths_full: 'baths_full', baths_half: 'baths_half', baths_text: 'baths_text',
  total_rooms: 'total_rooms', stories: 'stories', design_style: 'design_style',
  basement_sqft: 'basement_sqft', below_grade_sqft: 'below_grade_sqft',
  below_grade_finished_sqft: 'below_grade_finished_sqft',
  garage_type: 'garage_type', garage_spaces: 'garage_spaces',
  condition_uad: 'condition_uad', condition_text: 'condition_text',
  quality_uad: 'quality_uad', quality_text: 'quality_text',
  view_rating: 'view_rating', location_rating: 'location_rating', location_type: 'location_type',
  neighborhood: 'neighborhood', census_tract: 'census_tract', flood_zone: 'flood_zone',
  zoning_id: 'zoning_id', zoning_desc: 'zoning_desc', market_rent: 'market_rent',
  owner_of_record: 'owner_of_record', hoa_fee_amount: 'hoa_fee_amount', hoa_fee_period: 'hoa_fee_period',
  effective_age: 'effective_age', heating_type: 'heating_type', cooling: 'cooling',
  foundation_type: 'foundation_type',
  latitude: 'latitude', longitude: 'longitude',
});

/**
 * ROLL-UP COLUMNS THAT MUST IGNORE AN AFTER-REPAIR STATEMENT.
 *
 * On a renovation report the subject's condition and quality describe the property
 * AFTER the work is done — a FUTURE state, on a house that today may be gutted.
 * `properties.condition_uad` is billed as "the best-known CURRENT answer", so
 * taking that rating would make the warehouse confidently wrong on exactly the
 * files this lender writes most. An observation whose `condition_basis` is
 * 'as_repaired' is skipped for these columns only; everything else it stated
 * (the size, the year built, the address) is a fact either way and still counts.
 */
const AS_IS_ONLY = new Set(['condition_uad', 'condition_text', 'quality_uad', 'quality_text']);

// ---------------------------------------------------------------------------
// APPRAISER
// ---------------------------------------------------------------------------
/**
 * Upsert the appraiser who signed this report and record every contact detail it
 * carries. Returns the appraiser id, or null when the report names nobody.
 */
async function upsertAppraiser(db, a) {
  const identity = ID.appraiserIdentity({
    name: a.appraiser_name, company: a.appraiser_company,
    licenseId: a.license_id, licenseState: a.license_state,
  });
  if (!identity) return null;
  const name = txt(a.appraiser_name) || txt(a.appraiser_company) || 'Unknown appraiser';
  const reportDate = dateOnly(a.report_signed_date) || dateOnly(a.effective_date);

  // THE SCALAR COLUMNS ARE "LATEST REPORT WINS", and that decision is made HERE in
  // JS rather than in a clever ON CONFLICT expression, because the comparison needs
  // the row's CURRENT last_report_date and an upsert cannot read it cleanly. The
  // back-fill runs oldest-first, so without this an appraiser's card would show the
  // phone number from their FIRST report forever. A field the newer report left
  // blank still never blanks what we already knew (COALESCE below).
  const existing = (await db.query(
    `SELECT id, last_report_date FROM appraisers WHERE identity_key = $1`, [identity.key])).rows[0];
  const prevDate = existing ? dateOnly(existing.last_report_date) : null;
  const newer = !existing || !prevDate || (reportDate && reportDate >= prevDate);

  const vals = [identity.key, name, identity.nameKey, txt(a.appraiser_company), identity.companyKey,
    txt(a.appraiser_phone), txt(a.appraiser_email), txt(a.appraiser_company_address),
    txt(a.license_id), txt(a.license_state), txt(a.license_type), dateOnly(a.license_exp),
    txt(a.supervisor_name), reportDate, newer];
  // `$15` (newer) gates every overwrite; the COALESCEs mean an older report can
  // still FILL a column that has never been filled.
  const r = await db.query(
    `INSERT INTO appraisers
       (identity_key, name, name_key, company, company_key, phone, email, company_address,
        license_id, license_state, license_type, license_exp, supervisor_name,
        first_seen_at, last_seen_at, first_report_date, last_report_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now(), $14, $14)
     ON CONFLICT (identity_key) DO UPDATE SET
       name             = CASE WHEN $15 THEN EXCLUDED.name ELSE appraisers.name END,
       name_key         = CASE WHEN $15 THEN EXCLUDED.name_key ELSE appraisers.name_key END,
       company          = COALESCE(CASE WHEN $15 THEN EXCLUDED.company END, appraisers.company, EXCLUDED.company),
       company_key      = COALESCE(CASE WHEN $15 THEN EXCLUDED.company_key END, appraisers.company_key, EXCLUDED.company_key),
       phone            = COALESCE(CASE WHEN $15 THEN EXCLUDED.phone END, appraisers.phone, EXCLUDED.phone),
       email            = COALESCE(CASE WHEN $15 THEN EXCLUDED.email END, appraisers.email, EXCLUDED.email),
       company_address  = COALESCE(CASE WHEN $15 THEN EXCLUDED.company_address END, appraisers.company_address, EXCLUDED.company_address),
       license_id       = COALESCE(CASE WHEN $15 THEN EXCLUDED.license_id END, appraisers.license_id, EXCLUDED.license_id),
       license_state    = COALESCE(CASE WHEN $15 THEN EXCLUDED.license_state END, appraisers.license_state, EXCLUDED.license_state),
       license_type     = COALESCE(CASE WHEN $15 THEN EXCLUDED.license_type END, appraisers.license_type, EXCLUDED.license_type),
       license_exp      = COALESCE(CASE WHEN $15 THEN EXCLUDED.license_exp END, appraisers.license_exp, EXCLUDED.license_exp),
       supervisor_name  = COALESCE(CASE WHEN $15 THEN EXCLUDED.supervisor_name END, appraisers.supervisor_name, EXCLUDED.supervisor_name),
       first_report_date = LEAST(appraisers.first_report_date, EXCLUDED.first_report_date),
       last_report_date  = GREATEST(appraisers.last_report_date, EXCLUDED.last_report_date),
       last_seen_at     = now(),
       updated_at       = now()
     RETURNING id`, vals);
  const appraiserId = r.rows[0].id;

  // Every licence this report shows (including the supervisor's, which belongs to
  // a DIFFERENT person and so is deliberately NOT recorded here — only the signing
  // appraiser's licence lands on their record).
  if (txt(a.license_id) || txt(a.license_state)) {
    await db.query(
      `INSERT INTO appraiser_licenses (appraiser_id, license_state, license_id, license_type, license_exp)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (appraiser_id, COALESCE(license_state,''), COALESCE(license_id,'')) DO UPDATE SET
         license_type = COALESCE(EXCLUDED.license_type, appraiser_licenses.license_type),
         license_exp  = COALESCE(EXCLUDED.license_exp, appraiser_licenses.license_exp),
         last_seen_at = now(),
         times_seen   = appraiser_licenses.times_seen + 1`,
      [appraiserId, txt(a.license_state), txt(a.license_id), txt(a.license_type), dateOnly(a.license_exp)]);
  }

  // The contact book: nothing is ever overwritten, a new spelling just adds a row.
  const contacts = [
    ['email', a.appraiser_email], ['phone', a.appraiser_phone],
    ['company', a.appraiser_company], ['address', a.appraiser_company_address],
    ['supervisor', a.supervisor_name],
  ];
  for (const [kind, value] of contacts) {
    const v = txt(value);
    if (!v) continue;
    const key = ID.contactKey(kind, v);
    if (!key) continue;
    await db.query(
      `INSERT INTO appraiser_contacts (appraiser_id, kind, value, value_key, last_appraisal_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (appraiser_id, kind, value_key) DO UPDATE SET
         value = EXCLUDED.value, times_seen = appraiser_contacts.times_seen + 1,
         last_seen_at = now(), last_appraisal_id = EXCLUDED.last_appraisal_id`,
      [appraiserId, kind, v, key, a.id]);
  }
  return appraiserId;
}

/** Recount an appraiser's reports + files. Cheap, and keeps the list screen honest. */
async function recountAppraiser(db, appraiserId) {
  if (!appraiserId) return;
  await db.query(
    `UPDATE appraisers SET
       appraisal_count = c.n, file_count = c.files,
       first_report_date = c.first_date, last_report_date = c.last_date, updated_at = now()
     FROM (SELECT count(*)::int AS n,
                  count(DISTINCT application_id)::int AS files,
                  min(COALESCE(effective_date, report_signed_date)) AS first_date,
                  max(COALESCE(effective_date, report_signed_date)) AS last_date
             FROM appraisals WHERE appraiser_id = $1) c
     WHERE appraisers.id = $1`, [appraiserId]);
}

// ---------------------------------------------------------------------------
// PROPERTY
// ---------------------------------------------------------------------------
/** Upsert the property for an address. Returns its id, or null when unidentifiable. */
async function upsertProperty(db, parts, extra = {}) {
  const key = K.propertyKey(parts);
  if (!key) return null;
  const p = K.normalizeParts(parts);
  const display = K.displayAddress(parts);
  const r = await db.query(
    `INSERT INTO properties (address_key, display_address, street, unit, city, state, zip, county, apn,
                             first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), now())
     ON CONFLICT (address_key) DO UPDATE SET
       -- The address columns are FILL-ONLY: a later report that omits the ZIP or
       -- the county must never blank one we already learned.
       display_address = CASE WHEN length(EXCLUDED.display_address) > length(properties.display_address)
                              THEN EXCLUDED.display_address ELSE properties.display_address END,
       zip    = COALESCE(properties.zip, EXCLUDED.zip),
       county = COALESCE(properties.county, EXCLUDED.county),
       apn    = COALESCE(properties.apn, EXCLUDED.apn),
       last_seen_at = now(), updated_at = now()
     RETURNING id`,
    [key, display, p.street || null, p.unit || null, K.titleCity(p.city) || null,
     p.state || null, p.zip || null, txt(extra.county) || p.county || null, txt(extra.apn)]);
  return r.rows[0].id;
}

/**
 * Insert-or-refresh ONE observation. `where` pins the row identity:
 *   { appraisalId, role:'subject' }  or  { comparableId }
 */
async function upsertObservation(db, cols) {
  const keys = Object.keys(cols);
  const conflict = cols.role === 'subject'
    ? '(appraisal_id) WHERE role = \'subject\''
    : '(comparable_id) WHERE comparable_id IS NOT NULL';
  const updatable = keys.filter((k) => k !== 'appraisal_id' && k !== 'comparable_id' && k !== 'role');
  const r = await db.query(
    `INSERT INTO property_observations (${keys.join(',')})
     VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})
     ON CONFLICT ${conflict} DO UPDATE SET
       ${updatable.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = now()
     RETURNING id, property_id`,
    keys.map((k) => cols[k]));
  return r.rows[0];
}

/**
 * Recompute a property's roll-up from its observations.
 *
 * For each fact column the winner is the most recent observation that STATED it
 * (report effective date first, then import order) — so a 2019 report can fill in
 * a year built that a 2026 report omitted, but can never overwrite one it stated.
 * The transaction roll-up comes from `property_sales`, which is already deduped.
 */
async function rollupProperty(db, propertyId) {
  if (!propertyId) return;
  const obs = (await db.query(
    `SELECT * FROM property_observations
      WHERE property_id = $1
      ORDER BY observed_on DESC NULLS LAST, created_at DESC`, [propertyId])).rows;
  const set = {};
  for (const [obsCol, propCol] of Object.entries(ROLLUP_FACTS)) {
    for (const o of obs) {
      if (AS_IS_ONLY.has(obsCol) && o.condition_basis === 'as_repaired') continue;
      if (o[obsCol] != null && o[obsCol] !== '') { set[propCol] = o[obsCol]; break; }
    }
    if (!(propCol in set)) set[propCol] = null;
  }
  const comps = obs.filter((o) => o.role === 'comparable');
  const counts = {
    subject_count: obs.filter((o) => o.role === 'subject').length,
    comp_count: comps.length,
    arv_comp_count: comps.filter((o) => o.comp_set === 'arv').length,
    asis_comp_count: comps.filter((o) => o.comp_set === 'as_is').length,
    observation_count: obs.length,
    first_observed_on: obs.length ? obs[obs.length - 1].observed_on : null,
    last_observed_on: obs.length ? obs[0].observed_on : null,
  };
  // The APN can arrive on a later report; treat it as fill-only like the address.
  const apn = obs.map((o) => o.facts && o.facts.apn).find((v) => v);

  const sale = (await db.query(
    `SELECT sale_date, sale_price, sale_type, sale_status FROM property_sales
      WHERE property_id = $1 AND COALESCE(sale_status,'closed') = 'closed'
      ORDER BY sale_date DESC LIMIT 1`, [propertyId])).rows[0] || {};
  const listing = (await db.query(
    `SELECT sale_price FROM property_sales
      WHERE property_id = $1 AND sale_status IN ('active','pending')
      ORDER BY sale_date DESC LIMIT 1`, [propertyId])).rows[0] || {};
  const saleCount = (await db.query(
    `SELECT count(*)::int AS n FROM property_sales WHERE property_id = $1`, [propertyId])).rows[0].n;
  const photoCount = (await db.query(
    `SELECT count(*)::int AS n FROM property_photos WHERE property_id = $1`, [propertyId])).rows[0].n;

  const all = Object.assign({}, set, counts, {
    last_sale_price: sale.sale_price == null ? null : sale.sale_price,
    last_sale_date: sale.sale_date == null ? null : dateOnly(sale.sale_date),
    last_sale_type: sale.sale_type == null ? null : sale.sale_type,
    last_sale_status: sale.sale_status == null ? null : sale.sale_status,
    last_list_price: listing.sale_price == null ? null : listing.sale_price,
    sale_count: saleCount, photo_count: photoCount,
  });
  const keys = Object.keys(all);
  await db.query(
    `UPDATE properties SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')},
       apn = COALESCE(properties.apn, $${keys.length + 2}), updated_at = now()
     WHERE id = $1`,
    [propertyId, ...keys.map((k) => all[k]), apn || null]);
}

// ---------------------------------------------------------------------------
// SALES
// ---------------------------------------------------------------------------
/** Record a transaction. Silently ignores anything without a date (never guesses one). */
async function recordSale(db, { propertyId, date, price, type, status, source, appraisalId, observationId }) {
  const d = dateOnly(date);
  if (!propertyId || !d) return 0;
  const amount = K.num(price, { min: 1, max: 1e10 });
  await db.query(
    `INSERT INTO property_sales (property_id, sale_date, sale_price, sale_type, sale_status, source,
                                 source_appraisal_id, source_observation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (property_id, sale_date, COALESCE(sale_price, -1)) DO UPDATE SET
       sale_type   = COALESCE(property_sales.sale_type, EXCLUDED.sale_type),
       sale_status = COALESCE(property_sales.sale_status, EXCLUDED.sale_status),
       last_seen_at = now(),
       times_seen  = property_sales.times_seen + 1`,
    [propertyId, d, amount, txt(type), txt(status), source, appraisalId || null, observationId || null]);
  return 1;
}

// ---------------------------------------------------------------------------
// PHOTOS
// ---------------------------------------------------------------------------
// Which stored photo categories describe the SUBJECT of the report.
const SUBJECT_PHOTO = new Set(['subject', 'subject_front', 'interior', 'rental', 'photo']);

/**
 * Link this report's stored photos to the properties they show.
 *
 * A photo is attached to a COMPARABLE only when we can say WHICH comparable:
 *   • the appraiser's own slot label named it ("ComparablePhoto2" → comp 2), or
 *   • the count of comparable photos exactly equals the number of comparables,
 *     in which case position means the same thing on both sides.
 * Anything else is left unlinked rather than pinned to the wrong house — the
 * same strictness `photo-meta.labelPhotos` already applies. Re-running the photo
 * extraction on an older report stores the slot labels and fixes it properly.
 */
async function linkPhotos(db, appraisalId, { comps = null, subjectPropertyId = null } = {}) {
  const photos = (await db.query(
    `SELECT ap.id, ap.document_id, ap.category, ap.caption, ap.sequence, ap.comp_seq, ap.identifier
       FROM appraisal_photos ap JOIN documents d ON d.id = ap.document_id
      WHERE ap.appraisal_id = $1 AND ap.document_id IS NOT NULL AND d.is_current
      ORDER BY ap.sequence`, [appraisalId])).rows;
  if (!photos.length) return 0;

  let subjectId = subjectPropertyId;
  if (!subjectId) {
    const r = await db.query(
      `SELECT property_id FROM property_observations WHERE appraisal_id=$1 AND role='subject'`, [appraisalId]);
    subjectId = r.rows[0] ? r.rows[0].property_id : null;
  }
  let compRows = comps;
  if (!compRows) {
    compRows = (await db.query(
      `SELECT o.id, o.property_id, o.comp_seq
         FROM property_observations o
        WHERE o.appraisal_id = $1 AND o.role = 'comparable'
        ORDER BY nullif(regexp_replace(COALESCE(o.comp_seq,''), '\\D', '', 'g'), '')::int NULLS LAST, o.created_at`,
      [appraisalId])).rows;
  }
  const bySeq = new Map();
  for (const c of compRows) { const n = digits(c.comp_seq); if (n) bySeq.set(n, c); }

  const compPhotos = photos.filter((p) => p.category === 'comparable');
  const aligned = compPhotos.length > 0 && compPhotos.length === compRows.length;

  let linked = 0;
  for (let i = 0; i < photos.length; i++) {
    const ph = photos[i];
    let propertyId = null, observationId = null, isPrimary = false;
    if (SUBJECT_PHOTO.has(ph.category) || (!ph.category && i === 0)) {
      propertyId = subjectId;
      isPrimary = ph.category === 'subject_front' || (ph.sequence === 0 && ph.category !== 'comparable');
    } else if (ph.category === 'comparable') {
      const named = digits(ph.comp_seq) || digits(ph.identifier);
      let target = named ? bySeq.get(named) : null;
      if (!target && aligned) target = compRows[compPhotos.indexOf(ph)];
      if (target) { propertyId = target.property_id; observationId = target.id; isPrimary = true; }
    }
    if (!propertyId) continue;
    const r = await db.query(
      `INSERT INTO property_photos (property_id, appraisal_id, photo_id, document_id, observation_id,
                                    category, caption, sequence, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (property_id, document_id) DO UPDATE SET
         category = EXCLUDED.category, caption = EXCLUDED.caption,
         sequence = EXCLUDED.sequence, observation_id = EXCLUDED.observation_id,
         is_primary = EXCLUDED.is_primary
       RETURNING id`,
      [propertyId, appraisalId, ph.id, ph.document_id, observationId,
       ph.category, ph.caption, ph.sequence, isPrimary]);
    if (r.rows.length) linked++;
  }
  return linked;
}

/** The digits inside a comp label ("ComparablePhoto2" / "3" / "Comp #4") → 2 / 3 / 4, or null. */
function digits(v) {
  const m = /(\d+)/.exec(String(v == null ? '' : v));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 && n < 100 ? n : null;
}

// ---------------------------------------------------------------------------
// THE ONE ENTRY POINT
// ---------------------------------------------------------------------------
/**
 * Fold one appraisal into the warehouse. Returns a summary; never throws.
 * @param {{query:Function}} db
 * @param {string} appraisalId
 */
async function ingestAppraisal(db, appraisalId) {
  const out = { ok: false, appraisalId, properties: 0, observations: 0, sales: 0, photos: 0, skipped: [], error: null };
  if (!appraisalId) { out.error = 'appraisalId required'; return out; }
  try {
    const a = (await db.query(`SELECT * FROM appraisals WHERE id = $1`, [appraisalId])).rows[0];
    if (!a) { out.error = 'appraisal not found'; return out; }

    // A SUPERSEDED REPORT IS NOT A SECOND OPINION — it is the SAME report, imported
    // again. Folding both in would count its comparables twice, doubling every
    // property's `comp_count` and letting a stale value win the roll-up by import
    // order. So a superseded row is RETIRED: its observations and photo links are
    // removed, the properties it touched are re-rolled without it, and the ledger
    // records `skipped` (not `ok`), which is also what stops the back-fill from
    // trying again forever.
    if (a.superseded) return retireAppraisal(db, appraisalId, out);

    const appraiserId = await upsertAppraiser(db, a);
    if (appraiserId) await db.query(`UPDATE appraisals SET appraiser_id = $2 WHERE id = $1`, [appraisalId, appraiserId]);

    const observedOn = dateOnly(a.effective_date) || dateOnly(a.report_signed_date) || dateOnly(a.inspection_date);
    const touched = new Set();
    // A RENOVATION REPORT'S SUBJECT RATINGS DESCRIBE THE FINISHED HOUSE. Record
    // which it is so the roll-up can refuse to treat a future condition as today's.
    // Two independent signals, and EITHER one makes it after-repair: an ARV on the
    // report (there is no such thing as an after-repair value for a house nobody is
    // repairing) or subject-to language in the condition of appraisal. Only a report
    // showing neither is read as describing the house as it stands today. Matches
    // the same isReno predicate the appraisal desk already uses.
    const conditionBasis = (a.arv_value != null
      || /subject|hypothetical|as.?repair|as.?complet/i.test(String(a.condition_of_appraisal || '')))
      ? 'as_repaired' : 'as_is';

    // ---- the SUBJECT -------------------------------------------------------
    // Our own borrower's property. It goes in the warehouse exactly like a comp,
    // because next year it IS somebody's comp — and because "what did we lend on,
    // and what was it worth" is the other half of the research question.
    //
    // THE UNIT COMES FROM THE CONDO BLOCK. `appraisals.subject_unit` exists but the
    // importer never writes it — the unit designator only ever lands in
    // `condo_unit_identifier`. Reading only `subject_unit` would fold every unit of
    // one condo building into a single property row, which is the one dedupe error
    // that would silently corrupt the whole warehouse for condos.
    const subjectUnit = txt(a.subject_unit) || txt(a.condo_unit_identifier);
    const subjectId = await upsertProperty(db, {
      street: a.subject_address, unit: subjectUnit, city: a.subject_city,
      state: a.subject_state, zip: a.subject_zip,
    }, { county: a.subject_county, apn: a.apn });
    let subjectObsId = null;
    if (subjectId) {
      touched.add(subjectId);
      out.properties++;
      const marketRent = await subjectMarketRent(db, a);
      const unitMix = await subjectUnitMix(db, a.id);
      const obs = await upsertObservation(db, {
        property_id: subjectId, appraisal_id: a.id, application_id: a.application_id,
        comparable_id: null, appraiser_id: appraiserId, role: 'subject',
        comp_seq: null, comp_set: null, comp_set_confidence: null, comp_set_needs_review: null,
        observed_on: observedOn, form_type: txt(a.form_type),
        address_as_stated: [txt(a.subject_address), subjectUnit, txt(a.subject_city),
          txt(a.subject_state), txt(a.subject_zip)].filter(Boolean).join(', ') || null,
        sale_price: null, adjusted_price: null,
        sale_date: dateOnly(a.contract_date), sale_date_text: null,
        sale_status: null, sale_type: txt(a.sale_type),
        concession_amount: a.concession_amount, financing_type: null,
        days_on_market: null, data_source: txt(a.contract_data_source),
        prior_sale_amount: a.prior_sale_amount, prior_sale_date: dateOnly(a.prior_sale_date),
        gla: a.gla, beds: a.beds, baths_text: bathsText(a.baths_full, a.baths_half),
        baths_full: a.baths_full, baths_half: a.baths_half, total_rooms: a.rooms,
        year_built: K.yearBuilt(a.year_built), lot_area: txt(a.lot_area),
        lot_sqft: K.lotSqft(a.lot_area), units: a.units,
        stories: txt(a.stories), design_style: txt(a.design_style),
        property_type: txt(a.property_category) || txt(a.property_type),
        property_category: txt(a.property_category),
        condition_uad: txt(a.condition_uad), condition_text: null,
        quality_uad: txt(a.quality_uad), quality_text: null,
        condition_basis: conditionBasis,
        // ONE COLUMN, TWO VOCABULARIES — the trap. A COMPARABLE's view_rating is a
        // UAD enum (Beneficial/Neutral/Adverse); the SUBJECT's is free text off a
        // different element. Letting the free text into the same column makes it
        // unqueryable, so a subject view is stored only when it speaks the comps'
        // language, and the prose is kept in `facts`.
        view_rating: uadView(a.view_rating), location_rating: null, location_type: txt(a.nbhd_location_type),
        below_grade_sqft: a.below_grade_sqft, below_grade_finished_sqft: a.below_grade_finished_sqft,
        basement_sqft: a.basement_sqft, basement_finished_pct: a.basement_finished_pct,
        garage_type: txt(a.garage_type), garage_spaces: a.garage_spaces,
        price_per_gla: null, gla_basis: 'gla', proximity: null,
        neighborhood: txt(a.neighborhood), census_tract: txt(a.census_tract),
        flood_zone: txt(a.flood_zone), fema_flood_zone: txt(a.fema_flood_zone),
        sfha: a.special_flood_hazard == null ? null : !!a.special_flood_hazard,
        zoning_id: txt(a.zoning_id), zoning_desc: txt(a.zoning_desc),
        occupancy_status: txt(a.occupancy_status), market_rent: marketRent,
        unit_mix: unitMix ? JSON.stringify(unitMix) : null,
        owner_of_record: txt(a.owner_of_record), property_rights: txt(a.property_rights),
        hoa_fee_amount: a.hoa_fee_amount, hoa_fee_period: txt(a.hoa_fee_period),
        condo_floor: txt(a.condo_floor),
        effective_age: a.effective_age, remaining_economic_life: a.remaining_economic_life,
        heating_type: txt(a.heating_type), heating_fuel: txt(a.heating_fuel),
        cooling: txt(a.cooling), foundation_type: txt(a.foundation_type),
        attic: a.attic == null ? null : !!a.attic, has_adu: a.has_adu == null ? null : !!a.has_adu,
        lot_shape: txt(a.lot_shape), lot_dimensions: txt(a.lot_dimensions),
        listed_within_year: a.listed_within_year == null ? null : !!a.listed_within_year,
        latitude: null, longitude: null,
        net_adjustment: null, net_adj_pct: null, gross_adj_pct: null, adjustments: '[]',
        appraised_value: a.appraised_value, as_is_value: a.as_is_value, arv_value: a.arv_value,
        contract_price: a.contract_price, contract_date: dateOnly(a.contract_date),
        facts: JSON.stringify(subjectFacts(a)),
      });
      subjectObsId = obs.id;
      out.observations++;
      // A subject's own transactions: the prior sale the report researched, and
      // the purchase under contract (a contract price with a date IS a sale we
      // know about — marked 'pending' until a later report proves it closed).
      out.sales += await recordSale(db, { propertyId: subjectId, date: a.prior_sale_date,
        price: a.prior_sale_amount, type: null, status: 'closed', source: 'subject_prior_sale',
        appraisalId: a.id, observationId: subjectObsId });
      out.sales += await recordSale(db, { propertyId: subjectId, date: a.contract_date,
        price: a.contract_price, type: txt(a.sale_type), status: 'pending', source: 'subject_contract',
        appraisalId: a.id, observationId: subjectObsId });
    } else if (txt(a.subject_address)) {
      out.skipped.push({ role: 'subject', address: txt(a.subject_address), why: 'address not identifiable' });
    }

    // ---- the COMPARABLES ---------------------------------------------------
    const comps = (await db.query(
      `SELECT * FROM appraisal_comparables WHERE appraisal_id = $1 AND is_subject = false ORDER BY seq`,
      [appraisalId])).rows;
    const compObs = [];
    for (const c of comps) {
      const pid = await upsertProperty(db, {
        street: c.address, city: c.city, state: c.state || a.subject_state, zip: c.zip,
      });
      if (!pid) {
        out.skipped.push({ role: 'comparable', seq: c.seq, address: txt(c.address),
          why: 'the report did not write enough of this address to identify the property (needs a house number, a state, and a city or ZIP)' });
        continue;
      }
      touched.add(pid);
      out.properties++;
      const saleDate = dateOnly(c.sale_date);
      const obs = await upsertObservation(db, {
        property_id: pid, appraisal_id: a.id, application_id: a.application_id,
        comparable_id: c.id, appraiser_id: appraiserId, role: 'comparable',
        comp_seq: txt(c.seq), comp_set: txt(c.comp_set) || 'unknown',
        comp_set_confidence: txt(a.comp_split_confidence),
        comp_set_needs_review: a.comp_split_needs_review == null ? null : !!a.comp_split_needs_review,
        observed_on: observedOn, form_type: txt(a.form_type),
        address_as_stated: [txt(c.address), txt(c.city), txt(c.state), txt(c.zip)].filter(Boolean).join(', ') || null,
        sale_price: c.sale_price, adjusted_price: c.adjusted_price,
        sale_date: saleDate, sale_date_text: txt(c.sale_date),
        sale_status: txt(c.sale_status) || 'closed', sale_type: txt(c.sale_type),
        concession_amount: c.concession_amount, financing_type: txt(c.financing_type),
        days_on_market: txt(c.days_on_market), data_source: txt(c.data_source),
        prior_sale_amount: c.prior_sale_amount, prior_sale_date: dateOnly(c.prior_sale_date),
        gla: c.gla, beds: c.beds, baths_text: txt(c.baths),
        baths_full: c.baths_full, baths_half: c.baths_half, total_rooms: c.total_rooms,
        // A comp's year built, lot and style are NOT on the MISMO grid as their own
        // elements — but the appraiser's ADJUSTMENT LINES name them ("Age", "Site",
        // "Design (Style)") with the comp's own figure in the description, so they
        // are mined from there. Only a value the line actually states is taken.
        year_built: fromAdjustments(c.adjustments, 'age', K.yearBuilt),
        lot_area: fromAdjustments(c.adjustments, 'site', (v) => txt(v)),
        lot_sqft: fromAdjustments(c.adjustments, 'site', K.lotSqft),
        units: K.int(c.units, { min: 1, max: 100 }),
        stories: null, design_style: fromAdjustments(c.adjustments, 'design', (v) => txt(v)),
        property_type: txt(c.property_type), property_category: null,
        condition_uad: txt(c.condition_uad), condition_text: txt(c.condition_text),
        quality_uad: txt(c.quality_uad), quality_text: txt(c.quality_text),
        // A comparable is always described AS IT SOLD — there is no such thing as
        // an after-repair comparable, so its ratings are always the as-is basis.
        condition_basis: 'as_is',
        view_rating: txt(c.view_rating), location_rating: txt(c.location_rating),
        location_type: txt(c.location_type),
        below_grade_sqft: c.below_grade_sqft, below_grade_finished_sqft: c.below_grade_finished_sqft,
        basement_sqft: null, basement_finished_pct: null,
        garage_type: fromAdjustments(c.adjustments, 'garage', (v) => txt(v)), garage_spaces: null,
        price_per_gla: c.price_per_gla, gla_basis: txt(c.gla_basis) || 'gla', proximity: txt(c.proximity),
        neighborhood: null, census_tract: null, flood_zone: null, fema_flood_zone: null, sfha: null,
        zoning_id: null, zoning_desc: null,
        occupancy_status: null, market_rent: null, unit_mix: null,
        owner_of_record: null, property_rights: null,
        hoa_fee_amount: null, hoa_fee_period: null, condo_floor: null,
        effective_age: null, remaining_economic_life: null,
        heating_type: null, heating_fuel: null, cooling: null, foundation_type: null,
        attic: null, has_adu: null, lot_shape: null, lot_dimensions: null, listed_within_year: null,
        latitude: c.latitude, longitude: c.longitude,
        net_adjustment: c.net_adjustment, net_adj_pct: c.net_adj_pct, gross_adj_pct: c.gross_adj_pct,
        adjustments: JSON.stringify(c.adjustments || []),
        appraised_value: null, as_is_value: null, arv_value: null, contract_price: null,
        contract_date: null,
        facts: JSON.stringify({}),
      });
      compObs.push({ id: obs.id, property_id: pid, comp_seq: txt(c.seq) });
      out.observations++;
      out.sales += await recordSale(db, { propertyId: pid, date: c.sale_date, price: c.sale_price,
        type: txt(c.sale_type), status: txt(c.sale_status) || 'closed', source: 'comp_sale',
        appraisalId: a.id, observationId: obs.id });
      out.sales += await recordSale(db, { propertyId: pid, date: c.prior_sale_date, price: c.prior_sale_amount,
        type: null, status: 'closed', source: 'comp_prior_sale', appraisalId: a.id, observationId: obs.id });
    }

    // ---- photos, then the roll-ups ----------------------------------------
    out.photos = await linkPhotos(db, appraisalId, { comps: compObs, subjectPropertyId: subjectId });
    for (const pid of touched) await rollupProperty(db, pid);
    await recountAppraiser(db, appraiserId);

    await db.query(
      `INSERT INTO property_ingest_log (appraisal_id, status, properties_written, observations_written,
                                        sales_written, photos_linked, rows_skipped, skip_reasons,
                                        error, ingest_version, ran_at)
       VALUES ($1,'ok',$2,$3,$4,$5,$6,$7,NULL,$8, now())
       ON CONFLICT (appraisal_id) DO UPDATE SET status='ok',
         properties_written=EXCLUDED.properties_written, observations_written=EXCLUDED.observations_written,
         sales_written=EXCLUDED.sales_written, photos_linked=EXCLUDED.photos_linked,
         rows_skipped=EXCLUDED.rows_skipped, skip_reasons=EXCLUDED.skip_reasons,
         error=NULL, ingest_version=EXCLUDED.ingest_version, ran_at=now()`,
      [appraisalId, out.properties, out.observations, out.sales, out.photos,
       out.skipped.length, JSON.stringify(out.skipped), INGEST_VERSION]);
    out.ok = true;
    return out;
  } catch (e) {
    out.error = (e && e.message) || String(e);
    try {
      await db.query(
        `INSERT INTO property_ingest_log (appraisal_id, status, error, ingest_version, ran_at)
         VALUES ($1,'error',$2,$3, now())
         ON CONFLICT (appraisal_id) DO UPDATE SET status='error', error=EXCLUDED.error, ran_at=now()`,
        [appraisalId, out.error.slice(0, 2000), INGEST_VERSION]);
    } catch (_) { /* the log is a courtesy; the caller still gets the error back */ }
    return out;
  }
}

/**
 * RETIRE a superseded report: take its observations and photo links back out, and
 * re-roll every property that stops hearing from it. The ledger row becomes
 * `skipped` so the back-fill leaves it alone from then on.
 */
async function retireAppraisal(db, appraisalId, out) {
  const touched = (await db.query(
    `SELECT DISTINCT property_id FROM property_observations WHERE appraisal_id = $1`, [appraisalId])).rows;
  await db.query(`DELETE FROM property_photos WHERE appraisal_id = $1`, [appraisalId]);
  await db.query(`DELETE FROM property_observations WHERE appraisal_id = $1`, [appraisalId]);
  // The SALES it taught us are deliberately KEPT. A superseded report is a prior
  // draft of the same report, not a retraction — the sale it recorded still
  // happened, and `property_sales` is deduped by (property, month, price) so the
  // replacement report simply re-confirms the same row.
  for (const r of touched) await rollupProperty(db, r.property_id);
  await db.query(
    `INSERT INTO property_ingest_log (appraisal_id, status, error, ingest_version, ran_at)
     VALUES ($1,'skipped','superseded by a newer import of the same report',$2, now())
     ON CONFLICT (appraisal_id) DO UPDATE SET status='skipped',
       properties_written=0, observations_written=0, sales_written=0, photos_linked=0,
       error=EXCLUDED.error, ingest_version=EXCLUDED.ingest_version, ran_at=now()`,
    [appraisalId, INGEST_VERSION]);
  out.ok = true;
  out.superseded = true;
  return out;
}

/**
 * The UAD view rating, or null. See the note at the call site: a comp's rating is
 * an enum and the subject's is prose, and they share one warehouse column.
 */
function uadView(v) {
  const s = txt(v);
  if (!s) return null;
  return /^(beneficial|neutral|adverse)$/i.test(s) ? s[0].toUpperCase() + s.slice(1).toLowerCase() : null;
}

/**
 * MINE A COMP'S OWN FIGURE OUT OF ITS ADJUSTMENT LINES.
 *
 * The MISMO grid carries no element for a comparable's year built, lot size,
 * style or garage — but the adjustment ROW for each of those carries the comp's
 * value in its description ("1962", "0.19 ac", "Colonial", "2 car att"), because
 * that is what the appraiser is adjusting FROM. `parse` decides whether the text
 * is usable; anything it rejects yields null and the field simply stays empty.
 */
const ADJ_TYPES = Object.freeze({
  age: ['age', 'actualage', 'yearbuilt'],
  site: ['site', 'sitearea', 'lot', 'lotsize'],
  design: ['design', 'designstyle', 'style'],
  garage: ['garage', 'garagecarport', 'carport'],
});
function fromAdjustments(adjustments, kind, parse) {
  const want = ADJ_TYPES[kind];
  if (!want || !adjustments) return null;
  let arr = adjustments;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { return null; } }
  if (!Array.isArray(arr)) return null;
  for (const line of arr) {
    if (!line) continue;
    const t = String(line.type || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!want.includes(t)) continue;
    const v = parse(line.description);
    if (v != null && v !== '') return v;
  }
  return null;
}

/** The per-unit rent roll off a 1025/1007, or null when the report carried none. */
async function subjectUnitMix(db, appraisalId) {
  const r = await db.query(
    `SELECT unit_seq, rooms, beds, baths, sqft, actual_rent, market_rent, lease_status
       FROM appraisal_units WHERE appraisal_id = $1 ORDER BY unit_seq`, [appraisalId]);
  return r.rows.length ? r.rows : null;
}

/** The appraiser's stated monthly market rent for the whole subject property, or null. */
async function subjectMarketRent(db, a) {
  const est = K.num(a.est_market_monthly_rent, { min: 1 });
  if (est != null) return est;
  const r = await db.query(
    `SELECT COALESCE(sum(market_rent),0)::numeric AS total, count(market_rent)::int AS n
       FROM appraisal_units WHERE appraisal_id = $1`, [a.id]);
  const total = K.num(r.rows[0].total, { min: 1 });
  return r.rows[0].n > 0 && total != null ? total : null;
}

/** UAD-style "2.1" from the subject's full/half counts, so subject and comps read alike. */
function bathsText(full, half) {
  const f = K.int(full, { max: 99 }), h = K.int(half, { max: 99 });
  if (f == null && h == null) return null;
  return `${f || 0}.${h || 0}`;
}

/**
 * The subject-only extras that have no column of their own — kept as jsonb so a
 * property page can show everything the report said without another migration
 * every time the extractor learns a new field.
 */
function subjectFacts(a) {
  const keep = ['apn', 'legal_description', 'property_rights', 'effective_age', 'remaining_economic_life',
    'heating_type', 'heating_fuel', 'cooling', 'roof_description', 'foundation_type',
    'basement_finished_pct', 'attic', 'has_adu', 'lot_shape', 'lot_dimensions',
    'nbhd_value_trend', 'nbhd_demand_supply', 'nbhd_marketing_time', 'nbhd_location_type',
    'nbhd_price_low', 'nbhd_price_high', 'nbhd_price_predominant', 'nbhd_age_predominant',
    'special_flood_hazard', 'fema_panel_id', 'physical_deficiency', 'adverse_site_conditions',
    'zoning_compliance', 'condo_project_name', 'condo_project_type', 'hoa_fee_amount', 'hoa_fee_period',
    'site_value', 'grm', 'value_sales_approach', 'value_cost_approach', 'value_income_approach',
    'updated_last_15yr', 'owner_of_record', 'listed_within_year'];
  const out = {};
  for (const k of keep) if (a[k] != null && a[k] !== '') out[k] = a[k];
  for (const k of ['utilities', 'updates', 'amenities']) if (a[k]) out[k] = a[k];
  return out;
}

// ---------------------------------------------------------------------------
// BACK-FILL — "open and back date this database" (the owner's words)
// ---------------------------------------------------------------------------
/**
 * Fold EVERY appraisal we have ever imported into the warehouse, oldest first.
 *
 * Oldest-first matters: the roll-up prefers the newest report that stated a fact,
 * and processing in report order means the final state after a back-fill is
 * identical to the state we would have reached by ingesting each report as it
 * arrived. Re-runnable — a report already ingested at this version is skipped
 * unless `force` is set, and a report that FAILED is always retried.
 *
 * Never throws; returns what it did.
 */
async function backfill(db, { limit = 500, force = false, onProgress = null } = {}) {
  const out = { scanned: 0, ingested: 0, failed: 0, skipped: 0, errors: [] };
  let rows;
  try {
    rows = (await db.query(
      `SELECT a.id
         FROM appraisals a
         LEFT JOIN property_ingest_log l ON l.appraisal_id = a.id
        WHERE $2::boolean OR l.appraisal_id IS NULL
           OR (l.status NOT IN ('ok','skipped')) OR l.ingest_version < $3
        ORDER BY COALESCE(a.effective_date, a.report_signed_date, a.imported_at::date) ASC, a.imported_at ASC
        LIMIT $1`, [Math.min(Math.max(1, limit), 5000), !!force, INGEST_VERSION])).rows;
  } catch (e) {
    out.errors.push(`could not list appraisals: ${e && e.message}`);
    return out;
  }
  for (const r of rows) {
    out.scanned++;
    const res = await ingestAppraisal(db, r.id);
    if (res.ok) out.ingested++;
    else { out.failed++; if (out.errors.length < 20) out.errors.push(`${r.id}: ${res.error}`); }
    if (onProgress) { try { onProgress(out); } catch (_) { /* progress is a courtesy */ } }
  }
  return out;
}

/** How much of the corpus is folded in — for the admin panel and the boot log. */
async function ingestStatus(db) {
  const r = await db.query(
    `SELECT (SELECT count(*)::int FROM appraisals) AS appraisals,
            (SELECT count(*)::int FROM property_ingest_log WHERE status='ok' AND ingest_version >= $1) AS ingested,
            (SELECT count(*)::int FROM property_ingest_log WHERE status='error') AS failed,
            (SELECT count(*)::int FROM properties) AS properties,
            (SELECT count(*)::int FROM property_observations) AS observations,
            (SELECT count(*)::int FROM property_sales) AS sales,
            (SELECT count(*)::int FROM appraisers) AS appraisers`, [INGEST_VERSION]);
  const s = r.rows[0];
  return Object.assign(s, { pending: Math.max(0, s.appraisals - s.ingested) });
}

module.exports = {
  ingestAppraisal, backfill, ingestStatus, linkPhotos,
  INGEST_VERSION,
  _internals: { upsertAppraiser, upsertProperty, upsertObservation, rollupProperty, recordSale,
    recountAppraiser, subjectFacts, bathsText, digits, fromAdjustments, uadView, retireAppraisal,
    ROLLUP_FACTS, AS_IS_ONLY },
};

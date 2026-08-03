'use strict';
/**
 * THE INGEST — fold ONE imported appraisal into the research warehouse (db/409).
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
const MARKET = require('./market');
const ID = require('./identity');

/**
 * WHAT THE INGEST CURRENTLY KNOWS HOW TO READ OFF A REPORT.
 *
 * The distinction from `ROLLUP_VERSION` below is the whole point, and getting it
 * wrong strands the back book silently:
 *
 *   * a new PROPERTY column (a new entry in `ROLLUP_FACTS`, or a change to the
 *     roll-up's RULES) is recomputed FROM the observations — bump ROLLUP_VERSION
 *     and the boot sweep re-rolls every property;
 *   * a new OBSERVATION column is read off the REPORT, and no amount of
 *     re-rolling can invent a value that was never written to an observation —
 *     the report has to be READ AGAIN. That is this number.
 *
 * db/424 hit exactly that: `attachment_type` was added to both sides, and after
 * a full re-roll 4 of the 5 appraisals carrying an attachment style still had
 * NULL on their property, because the value had never reached an observation.
 * The same was true of every db/422 fact — 3 of 125 observations carried a tax
 * amount. `backfill()` keys on `l.ingest_version < INGEST_VERSION`, is bounded
 * per boot, runs oldest-report-first and self-drains, and `ingestStatus()`
 * reports how much is left.
 *
 * BUMP THIS whenever the ingest starts reading a fact it did not read before.
 */
// 2 — db/422's 59 facts and db/424's `attachment_type` are read off the report,
//     so the reports have to be re-read for the corpus we already hold.
// 3 — db/426: a 2-4 unit comparable's rooms/beds/baths were read off the FIRST
//     `ROOM_ADJUSTMENT` row, which is UNIT 1, not the property. Every such comp
//     in the warehouse is holding a wrong number right now (measured: a grid
//     stating 14 rooms / 7 beds / 3 baths stored 5 / 3 / 1), and `beds` rolls up,
//     so the wrong number is on `properties` too. Only re-reading fixes it.
const INGEST_VERSION = 3;

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
  // db/414 — facts the reports have always stated and the search could not reach,
  // because `search.js` queries `properties` and these lived only on the
  // observation. No new parsing: these values were already read and validated.
  basement_finished_pct: 'basement_finished_pct',
  attic: 'attic', has_adu: 'has_adu',
  heating_fuel: 'heating_fuel', remaining_economic_life: 'remaining_economic_life',
  condo_floor: 'condo_floor',
  lot_shape: 'lot_shape', lot_dimensions: 'lot_dimensions',
  property_rights: 'property_rights', occupancy_status: 'occupancy_status',
  fema_flood_zone: 'fema_flood_zone', sfha: 'sfha',
  unit_mix: 'unit_mix',
  // db/422 — the facts the reports have always stated that reached NO warehouse
  // table at all. Property-side only: the tax bill, the cost approach and its
  // depreciation, the condo PROJECT, the FEMA panel date, the listing history and
  // the deficiency / zoning notes. The report-side facts added by the same
  // migration (who ordered it, which form, the narratives, this transaction's
  // concessions) are deliberately ABSENT from this map — rolling those onto the
  // property would let the newest appraisal overwrite a durable answer with
  // something that was only ever true of one report.
  // db/424 — the attachment STYLE, which db/405 evicted from `property_type`
  // specifically so the fact would not be lost, and which then reached no
  // warehouse table at all. Durable and searchable; it is simply not a category.
  attachment_type: 'attachment_type',
  property_tax_amount: 'property_tax_amount',
  property_tax_year: 'property_tax_year',
  site_improvements_value: 'site_improvements_value',
  dwelling_cost_new: 'dwelling_cost_new',
  dwelling_sqft: 'dwelling_sqft',
  dwelling_price_per_sqft: 'dwelling_price_per_sqft',
  cost_new_total: 'cost_new_total',
  depreciated_cost_improvements: 'depreciated_cost_improvements',
  depreciation_physical: 'depreciation_physical',
  depreciation_functional: 'depreciation_functional',
  depreciation_external: 'depreciation_external',
  depreciation_total: 'depreciation_total',
  // db/424 — `cost_data_source` and `listing_history` are DELIBERATELY absent.
  // The first names the cost SERVICE the appraiser consulted (report methodology,
  // the exact analogue of `contract_data_source`, which is already observation-
  // only); the second is a note whose date-qualifier `listed_within_year` is
  // observation-only, so on the property row it becomes a listing note nothing
  // can ever clear. `cost_quality_rating` grades the DWELLING and stays — under
  // AS_IS_ONLY, so an after-repair report cannot state it.
  cost_quality_rating: 'cost_quality_rating',
  building_status: 'building_status',
  off_site_improvements: 'off_site_improvements',
  rent_included_utilities: 'rent_included_utilities',
  physical_deficiency_note: 'physical_deficiency_note',
  zoning_compliance_note: 'zoning_compliance_note',
  fema_panel_date: 'fema_panel_date',
  condo_project_name: 'condo_project_name',
  condo_project_type: 'condo_project_type',
  // THE DURABLE project attributes only (db/424). What the project was DESIGNED
  // as does not move; how much of it has SOLD does, and those counts describe the
  // whole BUILDING as of one report's date — filing them here gave every unit a
  // private copy of the building's statistics, disagreeing with the unit next
  // door by whichever report happened to be newest. Proven on a real database.
  // The eight moving ones stay on `property_observations`, correctly dated by the
  // report that stated them, until the project gets its own table.
  condo_units_planned: 'condo_units_planned',
  condo_total_phases: 'condo_total_phases',
  condo_parking_spaces: 'condo_parking_spaces',
  condo_common_elements: 'condo_common_elements',
  condo_commercial_space: 'condo_commercial_space',
  condo_management_type: 'condo_management_type',
});

/**
 * WHAT THE ROLL-UP CURRENTLY KNOWS HOW TO WRITE.
 *
 * `properties` is derived, and `rollupProperty` only runs when a report touches a
 * property — so widening ROLLUP_FACTS does nothing for the properties already in
 * the database. Stamping the version on every roll-up turns "which rows are behind"
 * into an indexed query, and `rerollStaleProperties` drains it over the following
 * boots through the ONE definition of the roll-up that already exists.
 *
 * BUMP THIS whenever ROLLUP_FACTS (or the roll-up's rules) change. That is the
 * entire migration story for a future fact: add the column, add the mapping, bump.
 */
// 5 — db/422 widened the fact set by 36 property columns; db/424 corrected five
// of those placements, added the attachment style, and — the reason this bump
// MATTERS rather than merely tidying — put the cost approach and its depreciation
// under AS_IS_ONLY. A property already rolled at 3 is carrying after-repair
// depreciation figures right now, and only a re-roll takes them back off. 5 is
// the audit's correction to that set in BOTH directions: three more facts joined
// it (the years and the deficiency note, which were still reading the finished
// house) and two provably wrong entries left it (`building_status` and
// `site_improvements_value`), so a row rolled at 4 is carrying an after-repair
// effective age AND is missing a build status it is entitled to. The boot sweep
// (`rerollStaleProperties`) drains it through the one definition of the roll-up;
// db/421 made its index version-agnostic so this bump does not silently cost it
// that index (verified by EXPLAIN at both 4 and 5).
const ROLLUP_VERSION = 5;

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
 *
 * db/424 EXTENDED THIS SET, because db/422 added the numeric analogue of
 * `condition_uad` and left it unprotected. Proven on a real database: a 2019
 * as-is report said C5 with $72,000 of depreciation, a 2026 renovation report
 * (correctly stamped `as_repaired`) said C2 with ZERO physical depreciation and
 * replacement cost as-if-new — and the property row ended up reading
 *
 *     condition_uad             C5      <- correctly protected
 *     depreciation_physical     0.00    <- the AFTER-repair figure
 *     cost_new_total            520000
 *
 * at the same time. "Condition C5, zero physical depreciation" is not a
 * conservative answer or an optimistic one; it is a self-contradicting one, and
 * every number in it describes a house that does not exist yet. Depreciation IS
 * condition expressed in dollars, so it belongs under exactly the same rule.
 *
 * A SECOND audit then proved the set stopped ONE COLUMN SHORT in three places
 * and OVER-REACHED in two. Both directions are bugs, and the second is the
 * quieter one — a false refusal does not produce a wrong answer, it produces NO
 * answer, and a fact we hold and refuse to file is as lost as one we never read.
 *
 * STOPPED SHORT. Physical depreciation IS effective age over total economic
 * life, and `remaining_economic_life` is read off the SAME `COST_ANALYSIS` node
 * as the depreciation figures — protecting the dollars and not the years
 * reproduces the exact self-contradiction one column over. Measured on the same
 * two-report fixture: `depreciation_physical` correctly held 2019's $60,000
 * while `effective_age` read the renovation report's 3 years and
 * `remaining_economic_life` its 57. `dwelling_sqft` was the one member of the
 * cost triple left out, so the row said $250,000 of dwelling cost over 2,100
 * after-repair feet — $119/sqft — beside a `dwelling_price_per_sqft` of $156.25.
 * And `physical_deficiency_note` reading "None noted." next to condition C5 and
 * $60,000 of physical depreciation is a statement about a house that does not
 * exist yet.
 *
 * OVER-REACHED. `building_status` was WRONG to be here, and provably so: its
 * three non-'Existing' values (Proposed / UnderConstruction / SubstantiallyComplete)
 * are only ever stated on a subject-to-completion report — which is precisely the
 * set `conditionBasis` marks 'as_repaired'. The guard refused the value exactly on
 * the reports that carry it, so the column could only ever read 'Existing' or
 * nothing, and the desk's own warning ("not an existing structure; confirm the
 * improvements are complete") went dark. `site_improvements_value` likewise: its
 * source attribute is literally `SiteOtherImprovementsAsIsAmount` — the Fannie
 * cost line printed as "As-is" Value of Site Improvements — so it is an as-is
 * figure by name, on any report.
 */
const AS_IS_ONLY = new Set([
  'condition_uad', 'condition_text', 'quality_uad', 'quality_text',
  // The cost approach and its depreciation — the same claim as `condition_uad`,
  // in dollars (db/424).
  'depreciation_physical', 'depreciation_functional', 'depreciation_external',
  'depreciation_total', 'depreciated_cost_improvements',
  'cost_new_total', 'dwelling_cost_new', 'dwelling_price_per_sqft', 'dwelling_sqft',
  'cost_quality_rating',
  // …and the same claim in YEARS, off the same node.
  'effective_age', 'remaining_economic_life',
  // "What is wrong with this house" is about the house as it stands.
  'physical_deficiency_note',
]);

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
  // TWO COUNTERS, TWO MEANINGS. `appraisal_count` is the reports that came in on a
  // loan file and `file_count` the files they were on — the profile shows them side
  // by side, so neither may quietly start including something else. An UPLOADED
  // report (db/411) is a report this person wrote too, and gets its own counter.
  //
  // The upload count is taken from the OBSERVATIONS rather than from
  // `research_imports.status`, because this runs INSIDE the import's transaction —
  // the header is still 'pending' at this moment and always would be. Counting what
  // actually landed is both the truer statement and the only one available here.
  await db.query(
    `UPDATE appraisers SET
       appraisal_count = c.n, file_count = c.files, import_count = i.n,
       first_report_date = LEAST(c.first_date, i.first_date),
       last_report_date  = GREATEST(c.last_date, i.last_date),
       updated_at = now()
     FROM (SELECT count(*)::int AS n,
                  count(DISTINCT application_id)::int AS files,
                  min(COALESCE(effective_date, report_signed_date)) AS first_date,
                  max(COALESCE(effective_date, report_signed_date)) AS last_date
             FROM appraisals WHERE appraiser_id = $1) c,
          (SELECT count(DISTINCT import_id)::int AS n,
                  min(observed_on) AS first_date, max(observed_on) AS last_date
             FROM property_observations
            WHERE appraiser_id = $1 AND import_id IS NOT NULL) i
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

  // A MERGE MUST SURVIVE THE NEXT RE-INGEST. Merging deletes the losing row,
  // which frees its `address_key` — so the next report that mentions that
  // spelling re-created it here and `upsertObservation`'s ON CONFLICT moved the
  // observation off the survivor, quietly undoing a human's decision and leaving
  // the survivor's counts describing rows it no longer owns. `property_merges`
  // records `merged_key` for exactly this and was never read (only written).
  // Re-ingest is ordinary traffic — the comp-split back-fill, the second pass
  // after photo extraction, and any forced back-fill all reach it.
  //
  // Best-effort: if the lookup fails the ordinary upsert still runs, so a
  // database blip can never stop a report being filed.
  try {
    const m = (await db.query(
      `SELECT survivor_id FROM property_merges WHERE merged_key = $1
        ORDER BY created_at DESC LIMIT 1`, [key])).rows[0];
    if (m && m.survivor_id) {
      // The survivor may itself have been merged since; follow the chain.
      const M = require('./property-merge');
      const finalId = (await M.survivorOf(db, m.survivor_id)) || m.survivor_id;
      const still = (await db.query(`SELECT id FROM properties WHERE id = $1`, [finalId])).rows[0];
      if (still) {
        // Fill-only, exactly as the ON CONFLICT branch below does — a report that
        // omits the ZIP or the county must never blank one already learned.
        await db.query(
          `UPDATE properties SET
             zip = COALESCE(zip, $2), county = COALESCE(county, $3), apn = COALESCE(apn, $4),
             last_seen_at = now()
           WHERE id = $1`,
          [still.id, p.zip || null, txt(extra.county) || p.county || null, txt(extra.apn)]);
        return still.id;
      }
    }
  } catch (e) { /* fall through to the ordinary upsert */ }
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
  // WHICH DOOR THE REPORT CAME THROUGH DECIDES THE PIVOT. A loan-file report is
  // keyed on its `appraisals` row (subject) and on the `appraisal_comparables` row
  // (each comp). An UPLOADED report (db/411) has neither, so it is keyed on its
  // import row and — because one upload carries a whole grid — the comp's own
  // position within that grid. Picking the wrong pivot does not error; it inserts
  // a second copy, which is why the choice is made from the row itself rather than
  // from a flag the caller could forget to pass.
  const uploaded = cols.import_id != null;
  const conflict = cols.role === 'subject'
    ? (uploaded ? '(import_id) WHERE role = \'subject\' AND import_id IS NOT NULL'
      : '(appraisal_id) WHERE role = \'subject\'')
    : (uploaded ? '(import_id, comp_seq) WHERE role = \'comparable\' AND import_id IS NOT NULL'
      : '(comparable_id) WHERE comparable_id IS NOT NULL');
  const updatable = keys.filter((k) => k !== 'appraisal_id' && k !== 'import_id'
    && k !== 'comparable_id' && k !== 'comp_seq' && k !== 'role');
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
 * A VALUE THE DRIVER CAN BIND — and the reason this exists is a bug that took the
 * whole warehouse down.
 *
 * A `jsonb` column READS BACK as a JavaScript object or array. Bind that value
 * straight into the next statement and node-postgres does the natural thing for a
 * JS array — it serialises it as a POSTGRES ARRAY literal (`{...}`) — and Postgres
 * answers `invalid input syntax for type json`. jsonb wants a JSON STRING.
 *
 * Every write into these tables goes through `JSON.stringify` on the way IN, so
 * this was invisible until the roll-up started carrying a jsonb column (`unit_mix`,
 * db/414) — which reads a value OUT of one row and writes it into another. The
 * blast radius was total rather than partial, for two reasons worth remembering:
 *
 *   • `upsertProperty` writes ONLY the address columns. EVERY fact on `properties`
 *     comes from the roll-up, so a roll-up that throws leaves a property with an
 *     address and nothing else — which reads on screen as "we know nothing about
 *     this property", not as an error.
 *   • The roll-up runs in a loop over every property a report touched, and the
 *     subject is first. One throw abandoned the whole report, so a single
 *     multi-family subject with a rent roll took every comparable on that report
 *     down with it.
 *
 * Generic on purpose: the next jsonb column added to ROLLUP_FACTS is safe without
 * anyone remembering this. A string is passed through untouched — already-serialised
 * values must not be double-encoded — and so is a Date, which the driver handles.
 */
function bindable(v) {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return v;
  if (Buffer.isBuffer(v)) return v;
  return JSON.stringify(v);
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
      const repaired = o.condition_basis === 'as_repaired';
      if (AS_IS_ONLY.has(obsCol) && repaired) {
        // ONE NARROW EXCEPTION, and only for the condition CODE. A subject-to
        // report's grid states the finished house, so its rating is refused —
        // which left every renovation-only property with NO current condition at
        // all. When the appraiser wrote the as-is rating into the condition
        // narrative ("C4 for as-is value. C3 for As repaired value."), that IS a
        // statement about the house as it stands and may be used. Nothing else on
        // an after-repair report gets this: the money figures have no such
        // sentence, and letting them through is the db/424 bug.
        if (obsCol !== 'condition_uad' || !o.condition_uad_as_is) continue;
        set[propCol] = o.condition_uad_as_is;
        break;
      }
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
    // THE EARLIEST DATE WE ACTUALLY HAVE, not the last row in the list. `obs` is
    // ordered `observed_on DESC NULLS LAST`, so the final element is an UNDATED
    // observation whenever one exists — and one undated report made a property
    // that we have known about for years report "first seen: never".
    first_observed_on: obs.reduce((min, o) => (
      o.observed_on && (!min || o.observed_on < min) ? o.observed_on : min), null),
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
       apn = COALESCE(properties.apn, $${keys.length + 2}),
       rollup_version = $${keys.length + 3}, updated_at = now()
     WHERE id = $1`,
    [propertyId, ...keys.map((k) => bindable(all[k])), apn || null, ROLLUP_VERSION]);
}

// ---------------------------------------------------------------------------
// SALES
// ---------------------------------------------------------------------------
/** Record a transaction. Silently ignores anything without a date (never guesses one). */
async function recordSale(db, { propertyId, date, price, type, status, source, appraisalId, observationId,
  importId, out = null, what = null }) {
  const d = dateOnly(date);
  // A SALE WE CANNOT FILE IS COUNTED, NEVER DROPPED IN SILENCE. A comparable whose
  // date of sale reads "Unk" has a perfectly good PRICE, and this used to return 0
  // — so a $444,000 sale vanished from `property_sales`, the property's roll-up
  // showed no last sale at all, and the ingest ledger still said `ok` with zero
  // skips. "The numbers still look healthy" is the worst shape a data loss can
  // take, and it is exactly what the owner's "it saves every property" is about.
  const note = (why) => {
    if (out && Array.isArray(out.skipped)) out.skipped.push(Object.assign({ role: 'sale', why }, what || {}));
    return 0;
  };
  if (!propertyId) return 0;                      // no property = nothing to hang it on; already counted upstream
  // NOTHING STATED IS NOT A LOSS. Most reports simply do not carry a prior sale or
  // a contract, and counting those as skips would bury the real ones in noise and
  // make every clean import look damaged. A skip is only worth reporting when the
  // report DID state something we then failed to file.
  if (date == null && price == null) return 0;
  if (!d) {
    return note(price != null
      ? 'the report stated a sale price but no date we could read, so the sale could not be filed'
      : 'the report stated a sale date we could not read');
  }
  const amount = K.num(price, { min: 1, max: 1e10 });
  // AN UNSTORABLE PRICE MUST NOT BECOME A PRICELESS SALE. `K.num` returns null for
  // a figure outside the guard, and the unique key is
  // (property_id, sale_date, COALESCE(sale_price,-1)) — so two different
  // out-of-range transactions on one date collapsed into ONE row with no price at
  // all. Refuse and count it instead of silently inventing a merged, unpriced sale.
  if (price != null && amount == null) {
    return note('the sale price on this report is outside anything we can store, so the sale was not filed');
  }
  await db.query(
    // `source_import_id` was in the table and in every caller's arguments, and was
    // neither destructured above nor listed here — so an UPLOADED report's sales
    // carried no provenance at all. That matters because retiring a duplicate
    // upload deletes its observations, which SET-NULLs `source_observation_id`:
    // without the import id there is then nothing left saying where the sale came
    // from.
    `INSERT INTO property_sales (property_id, sale_date, sale_price, sale_type, sale_status, source,
                                 source_appraisal_id, source_observation_id, source_import_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (property_id, sale_date, COALESCE(sale_price, -1)) DO UPDATE SET
       sale_type   = COALESCE(property_sales.sale_type, EXCLUDED.sale_type),
       -- A CLOSED SALE WINS. The old COALESCE meant the FIRST status ever written
       -- stuck forever, so a subject's contract recorded as pending could never
       -- become closed even when a later report stated the settled sale outright —
       -- the price stayed filed as an asking price for good.
       sale_status = CASE WHEN EXCLUDED.sale_status = 'closed' THEN 'closed'
                          ELSE COALESCE(property_sales.sale_status, EXCLUDED.sale_status) END,
       last_seen_at = now(),
       times_seen  = property_sales.times_seen + 1`,
    [propertyId, d, amount, txt(type), txt(status), source, appraisalId || null, observationId || null,
      importId || null]);
  return 1;
}

// ---------------------------------------------------------------------------
// PHOTOS
// ---------------------------------------------------------------------------
// Which stored photo categories describe the SUBJECT of the report.
//
// `'photo'` IS DELIBERATELY NOT HERE. It is the generic category the desk stores
// when the XML carried no photo metadata to name the slots with — which is the
// majority of files — so treating it as "subject" handed the COMPARABLES'
// photographs to the subject property: the subject's gallery showed other
// people's houses, `photo_count` and the has-photos filter were inflated, and
// the comparables showed none. An unnamed photograph is matched by its CAPTION
// (which routinely carries the comp's address) and otherwise attached to the
// subject only when it is the FIRST picture in the report — the subject front
// shot is first on every residential form — rather than pinned to the wrong
// house, which is this module's own stated rule for the comparable side.
const SUBJECT_PHOTO = new Set(['subject', 'subject_front', 'interior', 'rental']);

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

  // ADDRESSES FOR THE CAPTION MATCH. A photo caption on a report with no photo
  // metadata is usually the comparable's own address, which identifies it far
  // more reliably than an ordinal two vendors number two different ways. The
  // matcher is `photo-meta.compSeqFromCaption` — the SAME one the appraisal desk
  // uses — so "the same address" means one thing across the whole system. It
  // wants `{seq, address, city, state, zip}`, and the observation rows carry only
  // ids, so the properties are joined in here. Best-effort: a failure just leaves
  // the caption unmatched.
  let capComps = [];
  try {
    const ids = compRows.map((c) => c.property_id).filter(Boolean);
    if (ids.length) {
      const addrs = (await db.query(
        `SELECT id, street, city, state, zip FROM properties WHERE id = ANY($1::uuid[])`, [ids])).rows;
      const byId = new Map(addrs.map((a) => [a.id, a]));
      capComps = compRows.filter((c) => c.comp_seq && byId.has(c.property_id)).map((c) => {
        const a = byId.get(c.property_id);
        return { seq: c.comp_seq, address: a.street, city: a.city, state: a.state, zip: a.zip };
      });
    }
  } catch (e) { capComps = []; }
  const captionSeq = (caption) => {
    if (!caption || !capComps.length) return null;
    try { return require('../appraisal/photo-meta').compSeqFromCaption(caption, capComps); } catch (_) { return null; }
  };

  const compPhotos = photos.filter((p) => p.category === 'comparable');
  const aligned = compPhotos.length > 0 && compPhotos.length === compRows.length;

  let linked = 0;
  for (let i = 0; i < photos.length; i++) {
    const ph = photos[i];
    let propertyId = null, observationId = null, isPrimary = false;
    // AN UNNAMED PHOTOGRAPH: try to read the comparable's address out of its own
    // caption before assuming anything. `desk.js` already writes that caption, and
    // on a report with no photo metadata it is the only thing distinguishing the
    // subject's pictures from the comparables'.
    const unnamed = !ph.category || ph.category === 'photo';
    let capTarget = null;
    if (unnamed) {
      const seq = digits(ph.comp_seq) || digits(ph.identifier) || digits(captionSeq(ph.caption));
      if (seq) capTarget = bySeq.get(seq) || null;
    }
    if (capTarget) {
      propertyId = capTarget.property_id; observationId = capTarget.id; isPrimary = true;
    } else if (SUBJECT_PHOTO.has(ph.category) || (unnamed && i === 0)) {
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

    const comps = (await db.query(
      `SELECT * FROM appraisal_comparables WHERE appraisal_id = $1 AND is_subject = false ORDER BY seq`,
      [appraisalId])).rows;

    await writeReport(db, { a, comps, link: { appraisalId }, out });

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
 * WRITE ONE REPORT INTO THE WAREHOUSE — the shared body, used by BOTH doors.
 *
 * A report reaches the warehouse two ways: it was imported onto a loan file (the
 * `appraisals` + `appraisal_comparables` rows the desk wrote), or it was uploaded
 * straight into the research database with no file behind it (db/411). Those two
 * doors MUST read one report identically — a fact that lands in a different column
 * depending on how the XML arrived is a fact the search cannot be trusted on — so
 * there is exactly ONE mapping, here, and the callers only differ in where the
 * rows came from and what they are linked to.
 *
 * @param {object}   a     an `appraisals` ROW SHAPE (a real row, or the same shape
 *                         built in memory from a parsed XML — `import.appraisalRowFrom`)
 * @param {object[]} comps `appraisal_comparables` ROW SHAPES, same deal
 * @param {{appraisalId?:string, importId?:string}} link which door this came through
 * @param {object}   out   the running summary, mutated in place
 */
async function writeReport(db, { a, comps, link, out }) {
  const appraisalId = link.appraisalId || null;
  const importId = link.importId || null;

  const appraiserId = await upsertAppraiser(db, a);
  out.appraiserId = appraiserId;
  if (appraiserId && appraisalId) {
    await db.query(`UPDATE appraisals SET appraiser_id = $2 WHERE id = $1`, [appraisalId, appraiserId]);
  }

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
    const unitMix = await subjectUnitMix(db, a);
    const obs = await upsertObservation(db, {
      property_id: subjectId, appraisal_id: appraisalId, import_id: importId,
      application_id: a.application_id || null,
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
      // The attachment STYLE, kept as its own fact rather than smuggled into the
      // category. db/405 evicted it from `property_type` precisely so it would
      // not be lost — "Detached" answers a different question from "Multi 2-4",
      // and neither substitutes for the other (db/424).
      attachment_type: txt(a.attachment_type),
      // THE GRID'S CODE, THE APPRAISER'S WORD, AND — ON A RENOVATION REPORT — THE
      // AS-IS CODE OUT OF THEIR OWN NARRATIVE.
      //
      // A subject-to report's grid condition describes the FINISHED house, so the
      // roll-up refuses it (AS_IS_ONLY) and those properties were left with no
      // current condition at all. When the appraiser wrote the as-is rating down
      // in the condition narrative — "C4 for as-is value. C3 for As repaired
      // value." — that IS a statement about the house as it stands, so it is
      // filed as an AS-IS observation and the roll-up may use it. Only a code a
      // strict clause-by-clause reader could PROVE gets here; anything ambiguous
      // arrives null and the property keeps no condition, which is the honest
      // answer (db/429).
      condition_uad: txt(a.condition_uad),
      condition_text: txt(a.condition_text),
      quality_uad: txt(a.quality_uad), quality_text: txt(a.quality_text),
      // THE AS-IS CODE OUT OF THE APPRAISER'S OWN NARRATIVE, in its own column.
      //
      // It must NOT be written into `condition_uad`, and the observation's
      // `condition_basis` must NOT be flipped to 'as_is' to let it through: that
      // flag gates the WHOLE of AS_IS_ONLY, so flipping it would let this report's
      // after-repair depreciation and cost figures roll up too — re-opening
      // exactly the db/424 defect ("condition C5" beside "zero physical
      // depreciation") one commit after fixing it. The roll-up consults this
      // column explicitly instead.
      condition_uad_as_is: txt(a.condition_uad_as_is),
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
      // THE FEMA DETERMINATION WINS over the appraiser's own typed indicator when
      // we have one — it is the authoritative answer, and the flood-certificate
      // condition already treats it as governing. Without this the warehouse could
      // only ever see what the appraiser ticked.
      sfha: a.fema_flood_sfha != null ? !!a.fema_flood_sfha
        : (a.special_flood_hazard == null ? null : !!a.special_flood_hazard),
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
      // ---- db/422: every fact the report stated that used to stop at `appraisals` ----
      // No new parsing — the same values, carried across the last hop. Types are
      // normalised the way every other column here is: text trimmed to null, a
      // boolean kept as a real tri-state (null means the report did not say), and
      // a jsonb value passed through `bindable` because a jsonb column reads back
      // as a JS object and node-postgres would otherwise serialise an array as a
      // Postgres array literal (the roll-up wipe of PR #974).
      cost_data_source: txt(a.cost_data_source),
      cost_quality_rating: txt(a.cost_quality_rating),
      listing_history: txt(a.listing_history),
      building_status: txt(a.building_status),
      physical_deficiency_note: txt(a.physical_deficiency_note),
      zoning_compliance_note: txt(a.zoning_compliance_note),
      condo_project_name: txt(a.condo_project_name),
      condo_project_type: txt(a.condo_project_type),
      condo_common_elements: txt(a.condo_common_elements),
      condo_management_type: txt(a.condo_management_type),
      // `form_version` and `software_vendor` were written here by db/422 and are
      // GONE (db/424): the parser never assigns either, `appraisalRowFrom`
      // hard-codes software_vendor null and omits form_version entirely, so both
      // source columns are always NULL and both observation columns were dead.
      // db/422's own test only passed because it INSERTed a value straight into
      // `appraisals`, which no real import path does. If a vendor's XML turns out
      // to carry them, they come back WITH a parser that reads them.
      appraisal_purpose: txt(a.appraisal_purpose),
      appraisal_purpose_other: txt(a.appraisal_purpose_other),
      uspap_report_type: txt(a.uspap_report_type),
      inspection_type: txt(a.inspection_type),
      lender_name: txt(a.lender_name),
      amc_name: txt(a.amc_name),
      lender_address: txt(a.lender_address),
      supervisor_license_id: txt(a.supervisor_license_id),
      supervisor_license_state: txt(a.supervisor_license_state),
      concession_description: txt(a.concession_description),
      contract_review_comment: txt(a.contract_review_comment),
      reconciliation_comment: txt(a.reconciliation_comment),
      conditions_comment: txt(a.conditions_comment),
      addendum_text: txt(a.addendum_text),
      sales_agreement_analysis: txt(a.sales_agreement_analysis),
      property_tax_amount: a.property_tax_amount,
      property_tax_year: a.property_tax_year,
      site_improvements_value: a.site_improvements_value,
      dwelling_cost_new: a.dwelling_cost_new,
      dwelling_sqft: a.dwelling_sqft,
      dwelling_price_per_sqft: a.dwelling_price_per_sqft,
      cost_new_total: a.cost_new_total,
      depreciated_cost_improvements: a.depreciated_cost_improvements,
      depreciation_physical: a.depreciation_physical,
      depreciation_functional: a.depreciation_functional,
      depreciation_external: a.depreciation_external,
      depreciation_total: a.depreciation_total,
      condo_units_planned: a.condo_units_planned,
      condo_units_completed: a.condo_units_completed,
      condo_units_sold: a.condo_units_sold,
      condo_units_rented: a.condo_units_rented,
      condo_units_for_sale: a.condo_units_for_sale,
      condo_owner_occupied: a.condo_owner_occupied,
      condo_total_phases: a.condo_total_phases,
      condo_parking_spaces: a.condo_parking_spaces,
      condo_commercial_space: a.condo_commercial_space == null ? null : !!a.condo_commercial_space,
      condo_developer_control: a.condo_developer_control == null ? null : !!a.condo_developer_control,
      condo_concentrated_ownership: a.condo_concentrated_ownership == null ? null : !!a.condo_concentrated_ownership,
      seller_is_owner: a.seller_is_owner == null ? null : !!a.seller_is_owner,
      concession_indicator: a.concession_indicator == null ? null : !!a.concession_indicator,
      contract_reviewed: a.contract_reviewed == null ? null : !!a.contract_reviewed,
      has_prior_sale: a.has_prior_sale == null ? null : !!a.has_prior_sale,
      comps_have_prior_sales: a.comps_have_prior_sales == null ? null : !!a.comps_have_prior_sales,
      fema_panel_date: dateOnly(a.fema_panel_date),
      supervisor_license_exp: dateOnly(a.supervisor_license_exp),
      off_site_improvements: bindable(a.off_site_improvements),
      rent_included_utilities: bindable(a.rent_included_utilities),
      facts: JSON.stringify(subjectFacts(a)),
    });
    subjectObsId = obs.id;
    out.observations++;
    // A subject's own transactions: the prior sale the report researched, and
    // the purchase under contract (a contract price with a date IS a sale we
    // know about — marked 'pending' until a later report proves it closed).
    out.sales += await recordSale(db, { propertyId: subjectId, date: a.prior_sale_date,
      price: a.prior_sale_amount, type: null, status: 'closed', source: 'subject_prior_sale',
      appraisalId, importId, observationId: subjectObsId,
      out, what: { address: txt(a.subject_address), of: 'the subject\'s previous sale' } });
    out.sales += await recordSale(db, { propertyId: subjectId, date: a.contract_date,
      price: a.contract_price, type: txt(a.sale_type), status: 'pending', source: 'subject_contract',
      appraisalId, importId, observationId: subjectObsId,
      out, what: { address: txt(a.subject_address), of: 'the subject\'s contract' } });
  } else {
    // A SUBJECT THAT NEVER LANDS IS ALWAYS COUNTED. This used to be gated on the
    // report having stated an address at all, so a report carrying NO subject
    // address was dropped in total silence and its ledger row still read
    // `status: ok, rows_skipped: 0` — measured on 64 rows. That is precisely what
    // the ledger exists to prevent (db/409 §6): "nothing is ever silently
    // dropped" has to include the case where there was nothing to drop it FROM.
    // The two reasons are different and a human needs to be told which: one is a
    // report we cannot read, the other is a report that did not say.
    out.skipped.push(txt(a.subject_address)
      ? { role: 'subject', address: txt(a.subject_address),
        why: 'the report states this address but we could not read a house number, a state and a '
          + 'town or ZIP out of it, so it cannot be told apart from any other property' }
      : { role: 'subject', address: null,
        why: 'this report states no subject address at all, so there is no property to file it '
          + 'against — everything else on it (its market read, its comparables) is still kept' });
  }

  // ---- what the report said about the MARKET (db/423) ---------------------
  // The 1004MC grid and the page-1 neighbourhood read describe an AREA over a
  // PERIOD, not this house, so they go to their own table rather than onto the
  // property — see db/423's header for why that distinction is load-bearing.
  // Deliberately OUTSIDE the `if (subjectId)` branch above: a report whose
  // address we could not key still told us about its market, and that is worth
  // keeping. Best-effort — a market read is never worth failing a whole report
  // over, and the failure is COUNTED rather than swallowed.
  try {
    // NO COORDINATES ARE PASSED, deliberately: `appraisals` carries no
    // subject_latitude/longitude (verified against information_schema — reading
    // them would be a phantom column that silently answers null forever). The
    // subject's position lives on the PROPERTY, which `property_id` points at
    // once the geocoder has placed it.
    const m = await MARKET.writeMarket(db, a, {
      appraisalId, importId, propertyId: subjectId || null, appraiserId,
    });
    if (m.written) { out.market = 1; out.marketPeriods = m.periods; }
  } catch (e) {
    out.skipped.push({ role: 'market', why: `the market grid could not be filed: ${e.message}` });
  }

  // ---- the COMPARABLES ---------------------------------------------------
  const compObs = [];
  for (const c of comps) {
    // A COMPARABLE THAT NAMED NO TOWN INHERITS THE SUBJECT'S — GATED ON THE ZIP.
    //
    // The key uses `z<zip>` as the locality when a report gave no city, so the SAME
    // house filed once with a town and once without keys two different ways and
    // becomes two properties. This is the single biggest cause of a split: the
    // parser's own note says about a third of files omit the separate city/state/ZIP
    // attributes and lean on a "City, ST ZIP" fallback that fails on anything less
    // tidy than that exact shape.
    //
    // The precedent is the line this replaces — the state was already inherited the
    // same way. It is safe for reasons worth stating, because "never inherit from the
    // subject" is a real rule in this repo (for property TYPE and UNIT COUNT, which
    // genuinely differ comp to comp):
    //   • it is PURE, OFFLINE and DETERMINISTIC — everything it reads is on this one
    //     report, so the key never depends on what has been ingested before it;
    //   • a ZIP is filed to one primary mailing city, and the report itself states
    //     that city for the subject;
    //   • it is MONOTONE — if the ZIPs differ nothing changes and we are exactly
    //     where we are today; if they match we produce the same locality the
    //     city-bearing reports already produce.
    // A comp outside the subject's ZIP that states no city still keys on its ZIP, and
    // goes to the duplicate detector (db/419) instead.
    // The inherited town is a FALLBACK, never the city itself. `normalizeParts`
    // re-parses a packed address line ("12 Oak St, Newark, NJ 07103") for the
    // pieces it does not already hold, and handing it an inherited town filled
    // that slot first — so a comparable that WROTE its own town inside its own
    // address line was filed under the subject's town instead, creating exactly
    // the split this inheritance exists to close. `fallbackCity` is applied last,
    // after both the explicit element and the packed-line parse.
    const inheritedCity = K._internals.zip5(c.zip)
      && K._internals.zip5(c.zip) === K._internals.zip5(a.subject_zip)
      ? txt(a.subject_city) : null;
    const pid = await upsertProperty(db, {
      street: c.address, city: txt(c.city), fallbackCity: inheritedCity,
      state: c.state || a.subject_state, zip: c.zip,
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
      property_id: pid, appraisal_id: appraisalId, import_id: importId,
      application_id: a.application_id || null,
      comparable_id: c.id || null, appraiser_id: appraiserId, role: 'comparable',
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
      occupancy_status: null, market_rent: null,
      // THE PER-UNIT ROOM LINE the 1025 grid stated (db/426). Through `bindable`
      // because a jsonb column reads back as a JS array and binding it raw makes
      // node-postgres send a Postgres array literal — the roll-up wipe of #974.
      unit_mix: bindable(c.unit_mix),
      owner_of_record: null, property_rights: null,
      hoa_fee_amount: null, hoa_fee_period: null, condo_floor: null,
      effective_age: null, remaining_economic_life: null,
      heating_type: null, heating_fuel: null, cooling: null, foundation_type: null,
      attic: null, has_adu: null, lot_shape: null, lot_dimensions: null, listed_within_year: null,
      latitude: c.latitude, longitude: c.longitude,
      net_adjustment: c.net_adjustment, net_adj_pct: c.net_adj_pct, gross_adj_pct: c.gross_adj_pct,
      adjustments: JSON.stringify(c.adjustments || []),
      appraised_value: null, as_is_value: null, arv_value: null, contract_price: null,
      // WHEN THE PRICE WAS AGREED (db/425). Distinct from the settled date above,
      // and NULL on anything imported before we started reading it — which means
      // 'unknown', never 'same as the settled date'.
      contract_date: dateOnly(c.contract_date),
      facts: JSON.stringify({}),
    });
    compObs.push({ id: obs.id, property_id: pid, comp_seq: txt(c.seq) });
    out.observations++;
    out.sales += await recordSale(db, { propertyId: pid, date: c.sale_date, price: c.sale_price,
      type: txt(c.sale_type), status: txt(c.sale_status) || 'closed', source: 'comp_sale',
      appraisalId, importId, observationId: obs.id,
      out, what: { address: txt(c.address), seq: txt(c.seq), of: 'a comparable sale' } });
    out.sales += await recordSale(db, { propertyId: pid, date: c.prior_sale_date, price: c.prior_sale_amount,
      type: null, status: 'closed', source: 'comp_prior_sale', appraisalId, importId, observationId: obs.id,
      out, what: { address: txt(c.address), seq: txt(c.seq), of: 'a comparable\'s previous sale' } });
  }

  // ---- photos, then the roll-ups ----------------------------------------
  // ONLY A LOAN-FILE REPORT HAS PICTURES TO LINK. The photographs live in
  // `appraisal_photos` as `documents` rows, which the appraisal desk creates by
  // mining the report PDF into stored bytes. An upload straight into the research
  // database stores no bytes, so there is nothing to attach — the facts land, the
  // gallery does not, and the screen says so rather than pretending otherwise.
  if (appraisalId) {
    out.photos = await linkPhotos(db, appraisalId, { comps: compObs, subjectPropertyId: subjectId });
  }

  // ONE REPORT IS ONE REPORT, WHICHEVER DOOR IT CAME THROUGH. The same appraisal
  // can arrive as an upload today and land on a loan file next month. Left alone
  // that would put the report's whole comp grid into the warehouse TWICE —
  // doubling every one of those properties' comp counts and letting one
  // appraiser's single opinion out-vote the rest of the market in the roll-up.
  // The loan-file copy always wins: it is the one with the photographs, the
  // findings and a file behind it. (db/411)
  if (appraisalId && subjectId) {
    await retireDuplicateImports(db, { appraisalId, subjectId, observedOn, appraiserId, touched });
  }

  // ONE PROPERTY MUST NEVER TAKE THE REST OF THE REPORT DOWN. The roll-up is the
  // only thing that puts facts on a property row, and it used to run bare in this
  // loop — so a single property it could not roll up abandoned the whole report,
  // leaving every property after it with an address and no facts at all. The
  // failure is COUNTED and named rather than swallowed: `rollup_version` stays
  // behind on the row, so the boot re-roll retries it, and the skip is reported.
  for (const pid of touched) {
    try {
      await rollupProperty(db, pid);
    } catch (e) {
      out.rollupFailed = (out.rollupFailed || 0) + 1;
      out.skipped.push({ role: 'rollup', property_id: pid, why: `the property's facts could not be recomputed: ${(e && e.message) || e}` });
    }
  }
  await recountAppraiser(db, appraiserId);
  return out;
}

/**
 * A REPORT'S FINGERPRINT: this property, on this effective date, by this appraiser.
 *
 * Retire every UPLOADED copy of the report just written from a loan file — take its
 * observations back out and mark its import row `skipped`, naming where the report
 * actually lives now. Properties it touched are added to `touched` so the caller's
 * roll-up pass sees them (a property the upload knew about and this report does not
 * would otherwise keep the retired observation's numbers in its roll-up forever).
 *
 * Best-effort: a failure here costs a duplicate row, and must never fail the ingest.
 */
async function retireDuplicateImports(db, { appraisalId, subjectId, observedOn, appraiserId, touched }) {
  try {
    // A report with no effective date and no named appraiser has no fingerprint —
    // matching on the address alone would retire a DIFFERENT report on the same
    // house, which is exactly the kind of guess this warehouse does not make.
    if (!observedOn && !appraiserId) return;
    const dupes = (await db.query(
      `SELECT DISTINCT import_id FROM property_observations
        WHERE role = 'subject' AND import_id IS NOT NULL
          AND property_id = $1
          AND observed_on IS NOT DISTINCT FROM $2
          AND appraiser_id IS NOT DISTINCT FROM $3`,
      [subjectId, observedOn, appraiserId])).rows.map((r) => r.import_id);
    for (const importId of dupes) {
      const hit = (await db.query(
        `SELECT DISTINCT property_id FROM property_observations WHERE import_id = $1`, [importId])).rows;
      for (const r of hit) touched.add(r.property_id);
      await db.query(`DELETE FROM property_observations WHERE import_id = $1`, [importId]);
      await db.query(
        `UPDATE research_imports
            SET status = 'skipped', appraisal_id = COALESCE(appraisal_id, $2),
                error = 'This same report was later imported onto a loan file, so the file''s copy is the one the database keeps.',
                observations_written = 0, properties_written = 0, sales_written = 0, ran_at = now()
          WHERE id = $1`,
        [importId, appraisalId]);
    }
  } catch (_) { /* a duplicate is a cosmetic cost; never fail the ingest over it */ }
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
  if (/^(beneficial|neutral|adverse)$/i.test(s)) return s[0].toUpperCase() + s.slice(1).toLowerCase();
  // THE SUBJECT'S VIEW IS A UAD CODE, NOT A WORD — and refusing it dropped the
  // subject's view on EVERY report. A comparable's rating comes off a structured
  // element that spells it out ("Neutral"); the SUBJECT's comes off the site
  // feature's free-text comment, which under UAD is the coded triple
  // "N;Res;" / "B;Wtr;Wds" / "A;Comm;" — overall rating, then up to two view
  // factors. The first token is the same rating, written as one letter.
  //
  // MATCHED STRICTLY, because the loose version is a real error: a report that
  // writes the prose "Average" starts with an A and would be recorded as ADVERSE —
  // the exact opposite of what it says. So the letter is only read as a code when
  // the string is a code: a single letter alone, or a single letter followed by the
  // semicolon the UAD triple always carries.
  const m = /^([BNA])(?:\s*;|$)/i.exec(s);
  if (!m) return null;
  return { b: 'Beneficial', n: 'Neutral', a: 'Adverse' }[m[1].toLowerCase()];
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
  // A COMPARABLE'S GARAGE WAS STRUCTURALLY ALWAYS NULL. These keys are matched
  // against the MISMO `SALE_PRICE_ADJUSTMENT/@_Type` enum, and 2.6 writes the
  // garage line as `Parking` or `CarStorage` — neither of which was here. The
  // three original spellings are what a human would guess the enum says; they
  // are kept because a vendor does emit them, but they matched nothing on a
  // standards-compliant file, so the fact never reached a single comparable.
  garage: ['garage', 'garagecarport', 'carport', 'parking', 'carstorage',
    'garageparking', 'parkingoncarstorage'],
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
/* ONE SHAPE FOR A RENT ROLL, WHICHEVER DOOR IT CAME THROUGH.
 *
 * node-postgres renders a `numeric` column as a STRING, so the loan-file door
 * (which reads `appraisal_units` rows) produced {"sqft":"1100.00"} where the
 * upload door (which carries the parsed numbers) produced {"sqft":1100}. Same
 * fact, two shapes, in a jsonb column — harmless while only existence checks and
 * display read it, and a real trap for the first thing that does arithmetic on a
 * rent roll. The warehouse's whole promise is that a fact is filed ONE way
 * whichever door it arrives through. */
function numericUnit(u) {
  const n = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  return {
    unit_seq: n(u.unit_seq), rooms: n(u.rooms), beds: n(u.beds), baths: n(u.baths),
    sqft: n(u.sqft), actual_rent: n(u.actual_rent), market_rent: n(u.market_rent),
    lease_status: u.lease_status == null ? null : String(u.lease_status),
  };
}

async function subjectUnitMix(db, a) {
  // An UPLOADED report (db/411) has no `appraisal_units` rows — it was never stored
  // per-file — so it hands its parsed rent schedule along on the row shape itself.
  // Without this a 1025 uploaded straight into the research database would lose its
  // whole unit mix, which is one of the facts the warehouse exists to hold.
  if (Array.isArray(a && a._units)) {
    const rows = a._units.map((u) => numericUnit({
      unit_seq: u.seq, rooms: u.rooms, beds: u.beds, baths: u.baths, sqft: u.sqft,
      actual_rent: u.actualRent, market_rent: u.marketRent, lease_status: u.leaseStatus,
    }));
    return rows.length ? rows : null;
  }
  const r = await db.query(
    `SELECT unit_seq, rooms, beds, baths, sqft, actual_rent, market_rent, lease_status
       FROM appraisal_units WHERE appraisal_id = $1 ORDER BY unit_seq`, [(a && a.id) || null]);
  return r.rows.length ? r.rows.map(numericUnit) : null;
}

/** The appraiser's stated monthly market rent for the whole subject property, or null. */
async function subjectMarketRent(db, a) {
  const est = K.num(a.est_market_monthly_rent, { min: 1 });
  if (est != null) return est;
  // Same reason as subjectUnitMix: an uploaded report carries its rent schedule in
  // memory rather than in `appraisal_units`.
  if (Array.isArray(a._units)) {
    let sum = 0, n = 0;
    for (const u of a._units) { const v = K.num(u.marketRent, { min: 1 }); if (v != null) { sum += v; n++; } }
    return n > 0 && sum > 0 ? sum : null;
  }
  const r = await db.query(
    `SELECT COALESCE(sum(market_rent),0)::numeric AS total, count(market_rent)::int AS n
       FROM appraisal_units WHERE appraisal_id = $1`, [a.id || null]);
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
    'updated_last_15yr', 'owner_of_record', 'listed_within_year',
    // The full UAD view string ("N;Res;Wds"). `view_rating` keeps only the overall
    // rating, because that is the one the search compares across subjects and
    // comparables; the FACTORS behind it ("Res" residential, "Wds" woods, "Wtr"
    // water) are real information and are kept here rather than thrown away.
    'view_rating'];
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
           -- A REPORT THAT HAS SINCE BEEN SUPERSEDED BUT IS STILL LOGGED ok is
           -- still IN the warehouse, counting its whole grid a second time beside
           -- the report that replaced it. The import now re-ingests what it
           -- retires, so this only has to catch the ones already stranded — but it
           -- is what heals the back book, and it costs nothing once they are done
           -- (retiring stamps the ledger skipped, so each is picked up once).
           OR (a.superseded AND l.status = 'ok')
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
/**
 * RE-ROLL THE PROPERTIES THAT PREDATE THE CURRENT ROLL-UP (db/414).
 *
 * `properties` is derived from the observations, but `rollupProperty` only runs
 * when a report TOUCHES a property — so widening what rolls up leaves every
 * property already in the database behind, with a NULL in each new column and a
 * search filter that quietly returns almost nothing.
 *
 * This drains that, through the ONE definition of the roll-up rather than a SQL
 * twin of it (the roll-up has to skip an after-repair condition rating, which is a
 * judgement, not a COALESCE). Bounded per boot, most-observed properties first so
 * the ones searches actually return are corrected first, and SELF-DRAINING: a
 * re-rolled row is stamped with the current version and drops out of the queue.
 * Never throws.
 */
async function rerollStaleProperties(db, { limit = 500 } = {}) {
  const out = { rerolled: 0, remaining: 0, version: ROLLUP_VERSION, errors: 0 };
  try {
    const rows = (await db.query(
      `SELECT id FROM properties
        WHERE rollup_version < $2
        ORDER BY observation_count DESC
        LIMIT $1`, [Math.min(5000, Math.max(1, limit)), ROLLUP_VERSION])).rows;
    for (const r of rows) {
      try { await rollupProperty(db, r.id); out.rerolled++; } catch (_) { out.errors++; }
    }
    out.remaining = (await db.query(
      `SELECT count(*)::int n FROM properties WHERE rollup_version < $1`, [ROLLUP_VERSION])).rows[0].n;
  } catch (e) {
    out.error = (e && e.message) || String(e);
  }
  return out;
}

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
  ingestAppraisal, backfill, ingestStatus, linkPhotos, rerollStaleProperties,
  // The shared report-writing body — the standalone XML upload (db/411) drives it
  // with the same row shapes, so both doors read one report identically.
  writeReport,
  INGEST_VERSION,
  _internals: { upsertAppraiser, upsertProperty, upsertObservation, rollupProperty, recordSale,
    recountAppraiser, subjectFacts, bathsText, digits, fromAdjustments, uadView, retireAppraisal, bindable,
    ROLLUP_FACTS, AS_IS_ONLY, ROLLUP_VERSION },
};

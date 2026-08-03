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
const CS = require('./condition-scale');
// The portal's own property-type vocabulary — a rental comparable's category is
// derived from its unit count exactly the way a sales comparable's is, so the
// two grids can never describe one building in two different words.
const PT = require('../property-type');
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
// 5 — db/435: the RENT schedule is read. Its comparables become observations in
//     their own role, carrying the rent the building actually earns, whether
//     that rent is controlled, and a per-unit breakdown that states SQUARE
//     FOOTAGE — the one per-unit fact the sales grid never carries.
// 4 — the observation now carries `identity_basis` (WHERE a comparable's unit
//     count came from), the 2-4 family transaction facts `price_per_unit` /
//     `monthly_rent` / `grm`, the parsed `year_built`, and the appraiser's own
//     `design_style`. Without this bump every stored observation keeps
//     `identity_basis` NULL, which scores 0 in `identityRank` and collapses the
//     new best-sourced roll-up back into plain recency on the whole back book.
const INGEST_VERSION = 5;

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
  units: 'units', year_built: 'year_built', gla: 'gla', gla_basis: 'gla_basis',
  lot_area: 'lot_area', lot_sqft: 'lot_sqft',
  beds: 'beds', baths_full: 'baths_full', baths_half: 'baths_half', baths_text: 'baths_text',
  total_rooms: 'total_rooms', stories: 'stories', design_style: 'design_style',
  basement_sqft: 'basement_sqft', below_grade_sqft: 'below_grade_sqft',
  below_grade_finished_sqft: 'below_grade_finished_sqft',
  // db/437 — WHAT IS DOWNSTAIRS, beside how much of it there is. `beds` above is
  // the ABOVE-grade count the grid states; these are never added to it, because
  // the whole reason the form separates them is that they are not the same thing.
  below_grade_beds: 'below_grade_beds',
  below_grade_baths_full: 'below_grade_baths_full',
  below_grade_baths_half: 'below_grade_baths_half',
  below_grade_rec_rooms: 'below_grade_rec_rooms',
  below_grade_other_rooms: 'below_grade_other_rooms',
  basement_exit: 'basement_exit',
  garage_type: 'garage_type', garage_spaces: 'garage_spaces',
  condition_uad: 'condition_uad', condition_text: 'condition_text',
  quality_uad: 'quality_uad', quality_text: 'quality_text',
  view_rating: 'view_rating', location_rating: 'location_rating', location_type: 'location_type',
  // The view RATING is one appraiser's verdict on the outlook; the view TYPE is
  // what is actually there. Both roll up, because a later reader can re-judge a
  // cemetery and cannot re-judge an "Adverse".
  view_type: 'view_type',
  // How well the layout works, in the appraiser's own words (db/439).
  functional_utility: 'functional_utility',
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
  // db/435 — what the building is ACTUALLY let for, and whether that rent can
  // move. Both are facts about the BUILDING, so they roll up; the per-unit
  // rent inside `unit_mix` travels with the mix.
  actual_monthly_rent: 'actual_monthly_rent', rent_controlled: 'rent_controlled',
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
// 7 — db/435 adds two rolled-up facts (the actual rent and rent control).
// 6 — the roll-up's rule for `units` / `property_type` changed: a MEASURED unit
//     count now outranks an INFERRED one whatever the dates say, so every
//     property has to be recomputed.
// 7 — db/436 added `gla_basis` and `rental_comp_count` to the roll-up and changed
//     how `gla` is chosen. The bump was MISSED, so `rerollStaleProperties` — the
//     sweep that exists to carry exactly this kind of change onto the back book —
//     reported "nothing to do" on a database where 848 properties had a `gla` and
//     no basis and 242 had counts that did not add up. Only reports going back
//     through the comparable re-parse were repaired, which excludes every report
//     that reached the warehouse through the upload door.
// 8 — db/437 added the view type, the basement exit and the below-grade room
//     breakdown, and corrected two roll-up rules the audit proved wrong: an
//     UNRECORDED area basis no longer outranks a stated building area, and
//     `gla_basis` no longer travels without the `gla` it describes (105 property
//     rows read "we do not know the area, but we know it is a building area").
// 9 — db/444: a worded condition or quality rating is read into a rank a filter
//     can use (`condition_rank_read` and its span). A quarter of the warehouse
//     carried words only and was invisible to every condition filter.
const ROLLUP_VERSION = 9;

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
  // A RENTAL comparable (db/435) has no `appraisal_comparables` row to key on —
  // it comes off the rent schedule, not the sales grid — so it keys on the
  // report plus its own sequence within that grid. Without this it would fall
  // through to the sales pivot, whose partial index does not cover a NULL
  // `comparable_id`, and every re-ingest would insert another copy.
  const rental = cols.role === 'rental_comparable';
  // COALESCE'd, matching db/436's indexes: NULLs are DISTINCT in a unique index,
  // so a rental row with no sequence matched no conflict target at all and every
  // re-ingest inserted another copy.
  const conflict = rental
    ? (uploaded ? '(import_id, COALESCE(comp_seq, \'\')) WHERE role = \'rental_comparable\' AND import_id IS NOT NULL'
      : '(appraisal_id, COALESCE(comp_seq, \'\')) WHERE role = \'rental_comparable\' AND appraisal_id IS NOT NULL')
    : cols.role === 'subject'
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
 * THE ADJUSTMENT LINES, AS ROWS (db/440).
 *
 * `property_observations.adjustments` holds every line the appraiser wrote on this
 * comparable, and as jsonb it can only be read one comparable at a time. Written
 * out as rows keyed by line code, the same data answers "what are appraisers
 * actually paying for a bathroom in Paterson?" in one GROUP BY — the corpus no
 * data vendor has, because these are adjustments from reports we paid for.
 *
 * REPLACE, NEVER APPEND. A report is re-ingested on every re-parse and on every
 * version bump, so adding rows would multiply the corpus by the number of deploys
 * and quietly corrupt every median computed from it. The jsonb column stays as the
 * record of what the report said; these rows are a derived index of it.
 *
 * A NULL amount is KEPT and is not zero: a line written with no figure means the
 * appraiser looked and adjusted nothing, which is different from a line the form
 * never asked for. Collapsing them would make every average wrong.
 *
 * Best-effort. This is a derived index; failing to build it must never fail an
 * ingest that has already stored the observation it derives from.
 */
/**
 * THE ADJUSTMENT AMOUNT, made storable.
 *
 * Two separate traps, both proven:
 *
 * · `Number('')`, `Number('   ')`, `Number(false)` and `Number([])` are all 0, so
 *   the old `Number.isFinite(Number(x))` test turned four kinds of NOTHING into a
 *   stated zero — violating this table's own first rule, that a NULL amount is not
 *   a zero. Only a real number or a numeric string is taken.
 *
 * · The column is `numeric(14,2)`. `extract.js` reads the grid amount with a bare
 *   `toNum()` and no ceiling, so ONE corrupt vendor figure raised a numeric
 *   overflow that took the WHOLE comparable's rows down with it — measured: five
 *   parsed lines, zero stored, and the recorded reason named neither the line nor
 *   the value. Worse, that observation then jammed the back-fill queue forever.
 *   An out-of-range figure is dropped to null so the other lines survive.
 */
const ADJ_MAX = 1e11;
function adjAmount(v) {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const t = typeof v === 'string' ? v.trim() : v;
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) < ADJ_MAX ? n : null;
}

/**
 * THE SIZE LINES, whose delta is unambiguous because both sides state ONE number
 * in ONE unit. A `RoomCount` adjustment on most grids covers rooms AND bedrooms
 * AND bathrooms together, so dividing it by a room difference would attribute the
 * bathrooms to the rooms; those need their own measurement before they get a rate.
 */
const SIZE_LINES = new Set(['GrossLivingArea', 'GrossBuildingArea']);
// Below this the arithmetic stops being a market signal: an ordinary adjustment
// over a 20-foot difference reads as several hundred dollars a foot.
const MIN_SQFT_DELTA = 25;

/**
 * The difference an adjustment was made FOR — SUBJECT minus COMPARABLE, because
 * the appraiser adjusts the comparable's price TOWARD the subject. Measured over
 * all 152 real reports: 468 of 473 usable, ZERO negative and ZERO implausible,
 * which is the evidence that the convention holds rather than an assumption.
 * Returns null the moment either side is silent — a rate we cannot ground is a
 * rate we do not state.
 *
 * THE TWO SIDES MUST BE MEASURING THE SAME THING, and on 36% of the rows they
 * were not. `appraisals.gla` is ALWAYS `GrossLivingAreaSquareFeetCount`, while a
 * comparable's `gla` may be gross BUILDING area — a 1025 grid states building
 * area under the same element, which is why db/427 added `gla_basis` to record
 * which one it is. Measured over the 557 delta-carrying rows: 358 were living
 * area on both sides, and **199 subtracted a comparable's BUILDING area from the
 * subject's LIVING area** and then labelled the result `'sqft'`, exactly as if
 * the two were the same measure. All 199 are 1025 forms — the owner's own 2-4
 * unit segment — and the two populations answer differently ($45/sq ft against
 * $28), so blending them under one label produced a median describing neither.
 * db/436's own header states the rule: "'$150 a foot of living area' and '$150 a
 * foot of building area' describe different properties."
 *
 * So the basis is RECORDED rather than assumed. The rows are not dropped — a
 * building-area adjustment is real information about how that grid was worked,
 * and discarding the entire 2-4 unit population would be worse than separating
 * it — and `unit_delta_basis` exists precisely so no consumer has to guess what
 * a rate is per. A NULL comparable basis is treated as living area, which is
 * what it is on a 1004 and what every row written before db/427 assumed.
 */
function unitDeltaFor(lineType, subjectGla, compGla, compGlaBasis) {
  if (!SIZE_LINES.has(lineType)) return null;
  const s = Number(subjectGla), c = Number(compGla);
  if (!Number.isFinite(s) || !Number.isFinite(c) || s <= 0 || c <= 0) return null;
  const d = s - c;
  if (Math.abs(d) < MIN_SQFT_DELTA) return null;
  const basis = String(compGlaBasis || '').toLowerCase() === 'gba' ? 'sqft_gba' : 'sqft';
  return { delta: d, basis };
}

/**
 * WHERE AND WHEN, resolved ONCE from the canonical row.
 *
 * The live writer and the back-fill each computed these for themselves and
 * disagreed on almost every row: 15,909 of 17,431 differed on the DATE (the
 * comparable's sale against the report's effective date, 165 days apart on
 * average and over a year apart on 606 rows) and 2,850 on the CITY — "City Of
 * Wilkes Barre" against "Wilkes Barre", which differ case-insensitively, so no
 * `lower(city)` predicate could reconcile them. Whichever writer ran last won,
 * and one GROUP BY was aggregating two different meanings of "when" and "where".
 *
 * The place is the PROPERTY's normalised row — the same value the benchmark
 * groups by — and the date is the comparable's own SALE date, because that is
 * the market the appraiser was pricing against. One definition, read here, so
 * the two callers cannot drift again.
 */
async function adjustmentPlaceAndDate(db, propertyId, saleDate, fallbackDate) {
  let place = { state: null, city: null, zip: null };
  if (propertyId) {
    try {
      const r = await db.query('SELECT state, city, zip FROM properties WHERE id = $1', [propertyId]);
      if (r.rows[0]) place = { state: r.rows[0].state, city: r.rows[0].city, zip: r.rows[0].zip };
    } catch (_) { /* the row is a nicety; the lines still file */ }
  }
  return { place, on: saleDate || fallbackDate || null };
}

async function writeAdjustments(db, { observationId, propertyId, adjustments, place, on, subjectGla, compGla, compGlaBasis }) {
  if (!observationId) return 0;
  const rows = (Array.isArray(adjustments) ? adjustments : []).filter((a) => a && a.type);
  // UPSERT BY POSITION, THEN TRIM — never delete-then-insert. Two ingests of one
  // report genuinely overlap (`fireResearchIngest` is called from the import, the
  // photo pass, the comparable re-parse and the boot backfill), and
  // delete-then-insert is not atomic against an identical concurrent operation:
  // both delete, both insert, and the corpus keeps BOTH copies. Measured before
  // this shape: one report seeded through two racing ingests stored 266 rows
  // where it holds 133, exactly double, and every median it fed would have
  // counted that report twice.
  if (rows.length) {
    const vals = [];
    const chunks = rows.map((a, i) => {
      const b = i * 12;
      const ud = unitDeltaFor(String(a.type), subjectGla, compGla, compGlaBasis);
      vals.push(observationId, i, propertyId || null, String(a.type),
        a.description == null ? null : String(a.description).slice(0, 500),
        // `amount` may legitimately be 0 or negative; only a non-finite value is dropped.
        adjAmount(a.amount),
        (place && place.state) || null, (place && place.city) || null, (place && place.zip) || null,
        ud ? ud.delta : null, ud ? ud.basis : null,
        // How many dwellings this line covers (db/442) — a 1025 room line is a
        // SUM across 2-4 units and is not comparable with a single-property one.
        Number.isFinite(Number(a.spansUnits)) && Number(a.spansUnits) > 0 ? Math.trunc(Number(a.spansUnits)) : null);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${rows.length * 12 + 1})`;
    });
    vals.push(on || null);
    await db.query(
      `INSERT INTO property_adjustments
         (observation_id, seq, property_id, line_type, description, amount, state, city, zip,
          unit_delta, unit_delta_basis, spans_units, observed_on)
       VALUES ${chunks.join(',')}
       ON CONFLICT (observation_id, seq) DO UPDATE SET
         property_id = EXCLUDED.property_id, line_type = EXCLUDED.line_type,
         description = EXCLUDED.description, amount = EXCLUDED.amount,
         state = EXCLUDED.state, city = EXCLUDED.city, zip = EXCLUDED.zip,
         unit_delta = EXCLUDED.unit_delta, unit_delta_basis = EXCLUDED.unit_delta_basis,
         spans_units = EXCLUDED.spans_units,
         observed_on = EXCLUDED.observed_on`, vals);
  }
  // A re-read that found FEWER lines must not leave the extra ones standing.
  await db.query('DELETE FROM property_adjustments WHERE observation_id = $1 AND seq >= $2',
    [observationId, rows.length]);
  return rows.length;
}

/**
 * WHAT APPRAISERS IN THIS MARKET ACTUALLY ADJUST FOR THIS LINE.
 *
 * Returns the count, the median and the quartiles of the NON-ZERO adjustments —
 * a peer benchmark, not a rate. It REFUSES below `minSample` rather than answer
 * from four numbers, for the same reason the valuation engine's derived rates
 * refuse: a figure on a screen gets believed, and a median of four is noise
 * wearing the clothes of an answer.
 *
 * THIS IS NOT A PER-UNIT RATE. A -$5,000 room-count adjustment says nothing per
 * room without knowing how many rooms apart the two properties were. The caller
 * is told so in `basis` so the wording on any screen cannot drift from the truth.
 *
 * Never throws.
 */
async function adjustmentBenchmark(db, { lineType, state, city, zip, months = 24, minSample, spanning } = {}) {
  if (!lineType) return { ok: false, reason: 'no line type' };
  // `= 8` only defaults `undefined`. A caller reading the floor from config where
  // the key is absent-as-null passed null, and `3 < null` is FALSE — so the guard
  // failed OPEN and returned a "benchmark" from three numbers with ok:true.
  const floor = Number.isFinite(Number(minSample)) && Number(minSample) > 0 ? Math.floor(Number(minSample)) : 8;
  try {
    const p = [String(lineType), String(months)];
    const where = ['line_type = $1', 'amount IS NOT NULL', 'amount <> 0',
      "observed_on > (now() - ($2 || ' months')::interval)::date"];
    // A WHOLE-BUILDING TOTAL IS NOT A PER-PROPERTY ADJUSTMENT (db/442). A 1025
    // room line is the SUM across 2-4 dwellings — 237 of 550 real ones — and
    // averaging those with single-property figures gives a median describing
    // neither. Excluded by default; `spanning: true` asks for exactly them, which
    // is a real question when comparing multi-family grids.
    if (spanning === true) where.push('spans_units > 1');
    else if (spanning !== 'all') where.push('(spans_units IS NULL OR spans_units = 1)');
    // THE STATE IS ALWAYS APPLIED WHEN GIVEN. A city-only scope spanned states —
    // Springfield NJ and Springfield OH answered together as one "market" with a
    // median describing neither — and a zip scope ignored a contradicting state
    // outright rather than refusing it. Every supplied part now narrows.
    if (zip) { p.push(String(zip)); where.push(`zip = $${p.length}`); }
    else if (city) { p.push(String(city).toLowerCase()); where.push(`lower(city) = $${p.length}`); }
    if (state) { p.push(String(state).toUpperCase()); where.push(`state = $${p.length}`); }
    const r = await db.query(
      `SELECT count(*)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) AS median,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY amount) AS q1,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY amount) AS q3
         FROM property_adjustments WHERE ${where.join(' AND ')}`, p);
    const row = r.rows[0] || { n: 0 };
    if (!row.n || row.n < floor) {
      return { ok: false, n: row.n || 0, minSample: floor,
        reason: `only ${row.n || 0} adjustment${row.n === 1 ? '' : 's'} on this line in this market — too few to state a benchmark` };
    }
    return {
      ok: true, n: row.n,
      median: row.median == null ? null : Number(row.median),
      q1: row.q1 == null ? null : Number(row.q1),
      q3: row.q3 == null ? null : Number(row.q3),
      months,
      spanning: spanning === true ? 'whole-building totals only'
        : spanning === 'all' ? 'single-property and whole-building lines together'
          : 'lines describing ONE property',
      // Said explicitly so no screen can present this as a rate per room / per foot.
      basis: 'the dollar adjustment appraisers wrote on this grid line, not a per-unit rate',
    };
  } catch (_) { return { ok: false, reason: 'could not read the adjustment corpus' }; }
}


/**
 * WHAT APPRAISERS IN THIS MARKET ACTUALLY PAY PER SQUARE FOOT.
 *
 * This is the one `adjustmentBenchmark` explicitly refuses to be. That function
 * returns the DOLLAR adjustments and says so; this divides each by the size
 * difference it was made for, which is the number a person actually wants and the
 * one the design document called the peer benchmark.
 *
 * Measured over the 152 real reports before it was built: 468 of 473 usable,
 * ZERO negative and ZERO above $500 — median $40/sq ft, quartiles $25 and $50.
 *
 * ONE MEASURE AT A TIME. That 468 blended two different feet: 290 where both
 * sides state LIVING area, and 178 where the comparable stated gross BUILDING
 * area on a 1025 grid ($45/sq ft against $28 — see db/443). The default `basis`
 * is `'sqft'`, so the published rate is living-area-only; `'sqft_gba'` asks for
 * the building-area population by name. They are never returned together,
 * because a median of the two describes neither.
 *
 * REFUSES rather than answers thinly, on the same rule as everything else here: a
 * rate is a number people will price a deal against, and a median of four
 * adjustments is noise wearing the clothes of an answer. Never throws.
 *
 * AND WHEN THE TOWN IS TOO THIN IT SAYS SO AND STEPS OUT — but only if asked
 * (`relax`), and never past the state line.
 *
 * Splitting the two feet (db/443) was correct and it left most towns holding
 * fewer than eight adjustments of the measure their own comparables are written
 * in. Measured over the real corpus: of the 29 markets that hold ANY
 * building-area adjustment, 9 clear the floor in their own town (New Haven 24,
 * Wilkes-Barre 22, Scranton 19, Trenton 18, Elizabeth 11, Pittston 10, Irvington
 * 8, Roselle 8, Jersey City 8) and 19 more clear it at the state (Newark 5 of
 * 73 in NJ, Bridgeport 3 of 27 in CT, Rochester 2 of 14 in NY). Refusing all 19
 * sends them to a national rule of thumb while we hold dozens of real local
 * adjustments one rung out — which is a worse answer, not a more careful one.
 *
 * THREE RULES, and none of them is decoration:
 *   · The ladder is walked NARROWEST FIRST and STOPS at the first rung that
 *     clears the floor, so a town that can answer for itself always does.
 *   · IT NEVER LEAVES THE STATE. A nationwide median of appraiser adjustments
 *     describes no market anyone is lending in — `ratesFor` already refuses to
 *     derive rates with no market named, and a ladder that widened to "every
 *     market we hold" would walk straight back into it.
 *   · EVERY RUNG TRIED IS RETURNED, and the answer SAYS WHERE IT CAME FROM
 *     (`where`), because "$28 a foot in Newark" and "$28 a foot across New
 *     Jersey" are different claims and only one of them is true. The caller
 *     prints `where`; it must never keep saying "in this market".
 *
 * Without `relax` the behaviour is exactly what it was: one scope, one answer.
 */
async function rateAtScope(db, { basis, months, rung }) {
  const p = [String(basis), String(months)];
  const where = ['unit_delta_basis = $1', 'amount IS NOT NULL', 'amount <> 0',
    'unit_delta IS NOT NULL', 'unit_delta <> 0',
    "observed_on > (now() - ($2 || ' months')::interval)::date"];
  // THE STATE IS ALWAYS APPLIED WHEN GIVEN. A city-only scope spanned states —
  // Springfield NJ and Springfield OH answered together as one "market" with a
  // median describing neither — and a zip scope ignored a contradicting state
  // outright rather than refusing it. Every supplied part now narrows.
  if (rung.zip) { p.push(String(rung.zip)); where.push(`zip = $${p.length}`); }
  else if (rung.city) { p.push(String(rung.city).toLowerCase()); where.push(`lower(city) = $${p.length}`); }
  if (rung.state) { p.push(String(rung.state).toUpperCase()); where.push(`state = $${p.length}`); }
  // A NEGATIVE RATE IS A MISREAD, NOT A MARKET. It means the adjustment pointed
  // the opposite way to the size difference — zero of 468 real ones do — so it
  // is excluded rather than averaged in, where two of them would drag a median
  // that people price against.
  const r = await db.query(
    `SELECT count(*)::int AS n,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY amount / unit_delta) AS median,
            percentile_cont(0.25) WITHIN GROUP (ORDER BY amount / unit_delta) AS q1,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY amount / unit_delta) AS q3
       FROM property_adjustments
      WHERE ${where.join(' AND ')} AND (amount / unit_delta) > 0 AND (amount / unit_delta) < 500`, p);
  return r.rows[0] || { n: 0 };
}

// The rungs, narrowest first, and the plain words for each. A rung is only built
// from a value the caller actually supplied, so nothing is ever invented.
function rateRungs({ state, city, zip }) {
  const st = state ? String(state).toUpperCase() : null;
  const rungs = [];
  if (zip) rungs.push({ scope: 'zip', zip, state: st, where: `in ZIP ${zip}${st ? `, ${st}` : ''}` });
  if (city) rungs.push({ scope: 'city', city, state: st, where: `in ${city}${st ? `, ${st}` : ''}` });
  if (st) rungs.push({ scope: 'state', state: st, where: `across ${st}` });
  if (!rungs.length) rungs.push({ scope: 'any', where: 'across every market we hold' });
  return rungs;
}

async function adjustmentRate(db, { basis = 'sqft', state, city, zip, months = 36, minSample, relax = false } = {}) {
  // Same guard as the benchmark: a null or NaN floor must not open the gate.
  const floor = Number.isFinite(Number(minSample)) && Number(minSample) > 0 ? Math.floor(Number(minSample)) : 8;
  try {
    const all = rateRungs({ state, city, zip });
    // WITHOUT `relax`, ONE RUNG — and it is the same one the single-scope query
    // has always used (the narrowest supplied, narrowed again by the state), so
    // every existing caller is byte-identical.
    const rungs = relax ? all : all.slice(0, 1);
    const tried = [];
    for (const rung of rungs) {
      const row = await rateAtScope(db, { basis, months, rung });
      tried.push({ scope: rung.scope, where: rung.where, n: row.n || 0 });
      if (!row.n || row.n < floor) continue;
      return { ok: true, n: row.n, basis, months,
        scope: rung.scope, where: rung.where, tried,
        // A widened answer is FLAGGED, not merely describable — a caller that
        // forgets to print `where` must still be able to tell.
        relaxed: rung.scope !== all[0].scope,
        median: Number(row.median), q1: Number(row.q1), q3: Number(row.q3),
        // The wording NAMES the measure, so a building-area rate can never be read
        // as a living-area one on the strength of the sentence beside it.
        of: basis === 'sqft_gba'
          ? `dollars per square foot of gross BUILDING area of difference, as appraisers ${rung.where} actually adjusted`
          : `dollars per square foot of living area of difference, as appraisers ${rung.where} actually adjusted` };
    }
    // The refusal names EVERY rung, so "why is there no rate?" is answered by the
    // refusal itself rather than by a second look at the data.
    const last = tried[tried.length - 1] || { n: 0, where: 'in this market' };
    const detail = tried.length > 1
      ? tried.map((t) => `${t.n} ${t.where}`).join(', ')
      : `${last.n} usable adjustment${last.n === 1 ? '' : 's'} ${last.where}`;
    return { ok: false, n: last.n, minSample: floor, basis, tried,
      scope: null, where: last.where,
      reason: `only ${detail} — too few to state a rate` };
  } catch (_) { return { ok: false, basis, reason: 'could not read the adjustment corpus' }; }
}

/**
 * PREVIOUS AND FUTURE — build the adjustment rows for observations already stored.
 *
 * Every observation already carries its lines in the `adjustments` jsonb, so this
 * needs no re-parse and no stored XML: it reads what is there and writes the rows.
 *
 * Bounded per boot and SELF-DRAINING — an observation is picked only while it has
 * lines in the jsonb and no rows in the table, so each pass permanently reduces
 * the queue. An observation whose array is genuinely EMPTY is skipped by the same
 * predicate rather than being re-examined forever.
 *
 * Deliberately NOT a SQL statement inside the migration. `jsonb_array_elements`
 * over the whole table would be one unbounded write of tens of millions of rows
 * inside the boot transaction, on a table the app is trying to serve from.
 *
 * Best-effort; never throws.
 */
async function backfillAdjustmentRowsOnce(db, { limit = 2000 } = {}) {
  let scanned = 0, written = 0, stuck = 0;
  try {
    const rows = (await db.query(
      `SELECT o.id, o.property_id, o.adjustments,
              -- THE COMPARABLE'S OWN SALE DATE, exactly as the live writer uses —
              -- the market the appraiser was pricing against, not the report's
              -- effective date.
              COALESCE(o.sale_date, o.observed_on) AS on_date,
              p.state, p.city, p.zip,
              o.gla AS comp_gla, o.gla_basis AS comp_gla_basis, a.gla AS subject_gla
         FROM property_observations o
         LEFT JOIN properties p ON p.id = o.property_id
         LEFT JOIN appraisals a ON a.id = o.appraisal_id
        WHERE jsonb_typeof(o.adjustments) = 'array'
          AND jsonb_array_length(o.adjustments) > 0
          AND (
            -- (a) the rows were never built at all — an observation stored before
            --     db/440.
            NOT EXISTS (SELECT 1 FROM property_adjustments x WHERE x.observation_id = o.id)
            -- (b) OR they were built before db/441 and carry no per-unit delta,
            --     while BOTH sizes needed to derive one are on hand. Without this
            --     arm every row db/440 wrote would keep a NULL rate forever: the
            --     first arm only picks observations with NO rows, so nulling a
            --     column can never bring one back into the queue. Bounded by the
            --     same self-draining rule — writing the delta removes the row from
            --     this arm, and an observation whose sizes are unknown is excluded
            --     by the NOT NULL tests rather than re-examined every boot.
            OR EXISTS (
              SELECT 1 FROM property_adjustments x
               WHERE x.observation_id = o.id
                 AND x.line_type IN ('GrossLivingArea', 'GrossBuildingArea')
                 AND x.unit_delta IS NULL
                 -- EVERY REFUSAL unitDeltaFor MAKES IS MIRRORED HERE, or the
                 -- observation is re-picked on every boot forever and never
                 -- changes. Greater-than-zero is not the same test as IS NOT
                 -- NULL: the function refuses a zero or negative size as well as
                 -- a missing one, and only the missing case was mirrored — so a
                 -- stored size of 0 armed this arm, wrote no delta, and re-armed
                 -- it on the next boot, permanently. Neither column carries a
                 -- CHECK, so nothing but this line prevents it.
                 -- (NO BACKTICKS IN HERE — this is a template literal, and one
                 --  inside a SQL comment terminates the whole string.)
                 AND o.gla > 0 AND a.gla > 0
                 -- AND THE SIZES MUST ACTUALLY DIFFER ENOUGH TO YIELD ONE: a delta
                 -- under the floor is a PERMANENT null, not a pending one.
                 -- Measured before this line: the queue stalled at 29 observations
                 -- that could never drain. The threshold is BOUND from the JS
                 -- constant rather than written into the SQL, so the two can never
                 -- drift the way a hand-copied twin does.
                 AND abs(a.gla - o.gla) >= $2)
          )
        ORDER BY o.observed_on DESC NULLS LAST
        LIMIT $1`, [limit, MIN_SQFT_DELTA])).rows;
    for (const r of rows) {
      scanned++;
      try {
        const wrote = await writeAdjustments(db, {
          observationId: r.id, propertyId: r.property_id,
          adjustments: Array.isArray(r.adjustments) ? r.adjustments : [],
          place: { state: r.state, city: r.city, zip: r.zip },
          on: r.on_date,
          subjectGla: r.subject_gla, compGla: r.comp_gla, compGlaBasis: r.comp_gla_basis,
        });
        // AND IT MUST LEAVE THE QUEUE EITHER WAY. An observation whose lines all
        // lack a `type`, or whose only figure is unstorable, writes nothing — and
        // the "no rows yet" arm below then re-selects it on every boot forever.
        // With a LIMIT window those stuck rows sit at the head (newest first) and
        // block every writable observation behind them: measured, three passes
        // scanned the same 2 and wrote 0, and the good observation was never
        // reached. A row that yields nothing is stamped so the queue moves on.
        if (!wrote) await markNothingToFile(db, r.id);
        written += wrote;
      } catch (_) {
        // A THROW IS THE SAME PROBLEM. An observation the writer cannot store is
        // stamped too, or it jams the window exactly as above.
        try { await markNothingToFile(db, r.id); } catch (__) { /* best-effort */ }
        stuck++;
      }
    }
  } catch (_) { /* best-effort */ }
  // `stuck` is REPORTED. An observation the writer could not file is a fact about
  // the corpus, and a silent skip reads as "nothing to do" — the no-silent-caps
  // rule this codebase has already learned once.
  return { scanned, written, stuck };
}

/**
 * MARK AN OBSERVATION AS HAVING NOTHING TO FILE, so the queue can move past it.
 *
 * A single row with a null `line_type` sentinel would violate the NOT NULL, and a
 * separate ledger table is a lot of machinery for a rare case — so the marker is
 * the observation's own jsonb, emptied to `[]`. That is TRUE by then: the writer
 * has just looked at those lines and found nothing it can file, and the ORIGINAL
 * report is untouched (the appraisal, its stored XML and `appraisal_comparables`
 * all still hold it, and a re-parse rebuilds the observation from them).
 */
async function markNothingToFile(db, observationId) {
  await db.query(
    `UPDATE property_observations SET adjustments = '[]'::jsonb WHERE id = $1`, [observationId]);
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
 * HOW WELL-SOURCED AN OBSERVATION'S UNIT COUNT IS. Mirrors `compIdentity`'s own
 * ordering (grid > style > price > form). A SUBJECT observation has no
 * `identity_basis` at all and ranks highest on purpose — the appraiser inspected
 * the building and counted the doors; nothing on a comparable grid beats that.
 */
function identityRank(o) {
  if (!o) return -1;
  // A SUBJECT OBSERVATION IS NOT AUTOMATICALLY A MEASUREMENT. The appraiser
  // usually did stand in the building and count the doors — but on a 1004 or a
  // 1073 with a blank `LivingUnitCount` the parser IMPLIES the count from the
  // form, and that inference used to rank above a grid-counted comparable. It
  // now says which it was (db/434), and a legacy row with nothing recorded is
  // read as measured, because before db/434 a subject count came only from
  // `LivingUnitCount`.
  if (o.role === 'subject') return o.identity_basis === 'form' ? 1 : 4;
  return { grid: 3, style: 2, price: 2, form: 1 }[o.identity_basis] || 0;
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
  // A MEASUREMENT OUTRANKS AN INFERENCE, WHATEVER THE DATES SAY.
  //
  // `units` and `property_type` are the two facts a comparable can now carry
  // WITHOUT anyone having measured them: on a 1004 the form alone proves one
  // dwelling, and that is recorded as `identity_basis = 'form'`. Recency alone
  // would then let the weakest reading win — a house that appeared as the
  // SUBJECT of a 1025 with `LivingUnitCount 3` (genuinely counted), and later as
  // a COMPARABLE on a newer 1004, would roll up to `1 / SFR (1 unit)` and the
  // triplex would vanish from the warehouse. So among the observations that
  // stated a unit count, the best-sourced one wins, and recency only breaks a
  // tie. A subject observation carries no `identity_basis` and is treated as
  // measured, because that is what it is: the appraiser stood in the building.
  // A GROSS LIVING AREA OUTRANKS A GROSS BUILDING AREA, whatever the dates say.
  // They are different measurements — a building area includes the stairwells,
  // the shared halls and the basement — and `gla` is read blind downstream: the
  // search screen labels it "Gross living area", sorts on it and divides the
  // sale price by it, and the valuation engine derives its per-foot adjustment
  // and its size bracket from it. Measured inside ONE report (766 Winchester
  // Ave): the sales grid says 2,247 living and the rent schedule says 2,747
  // building; on a tie the rental was written last and won. Nothing is
  // converted — the difference varies per building, so the honest answer is to
  // prefer the one that answers the question and record which it is.
  // AN UNRECORDED BASIS IS NOT A LIVING AREA. The first cut ranked by
  // `gla_basis === 'gba' ? 1 : 0`, which demotes only the value that SAYS it is a
  // building area — so NULL (an observation written before db/427 added the
  // column, which could equally have been either) scored level with a stated
  // 'gla' and won on recency. Proven: a 2020 observation with no basis beat a
  // 2026 one stating `gba`, and the property then recorded NULL for what its own
  // number means. Ranked explicitly instead — stated living, then unknown, then
  // stated building — so an unlabelled number can never impersonate a living area
  // and can never outrank one.
  const GLA_RANK = { gla: 2, gba: 0 };
  const bestGla = obs
    .filter((o) => o.gla != null && o.gla !== '')
    .sort((a, b) => (GLA_RANK[b.gla_basis] != null ? GLA_RANK[b.gla_basis] : 1)
      - (GLA_RANK[a.gla_basis] != null ? GLA_RANK[a.gla_basis] : 1))[0];
  // THE BASIS TRAVELS WITH THE NUMBER, AND ONLY WITH IT. `gla_basis` was also
  // left in the generic recency loop, which writes each fact independently — so a
  // rent schedule naming a building but stating no area produced an observation
  // with `gla_basis='gba', gla=NULL`, and the loop wrote the basis onto the
  // property on its own. Measured: 105 property rows reading "we do not know the
  // area, but we know it is a building area." The pair is set here together, and
  // cleared together when no observation states an area at all.
  if (bestGla) { set.gla = bestGla.gla; set.gla_basis = bestGla.gla_basis || null; }
  else { set.gla_basis = null; }

  const bestUnits = obs
    .filter((o) => o.units != null && o.units !== '')
    .sort((a, b) => identityRank(b) - identityRank(a))[0];
  // THE PAIR MOVES TOGETHER OR NOT AT ALL. Taking `units` from the best-sourced
  // observation while leaving `property_type` to the recency loop can land a
  // 3-unit count beside "SFR (1 unit)" — the self-contradicting row this whole
  // rule exists to prevent — whenever that observation states a count but no
  // type (a subject observation's type can be null).
  if (bestUnits && bestUnits.property_type != null && bestUnits.property_type !== '') {
    set.units = bestUnits.units;
    set.property_type = bestUnits.property_type;
    // AND HOW WE KNOW (db/444). The winner was chosen by `identityRank` and the
    // provenance was then discarded, so a consumer holding a DIFFERENT reading —
    // the appraisal tab, ranking this report's own statement against the
    // warehouse's — had no way to tell a measurement from a form inference. A
    // subject observation carries no `identity_basis` because it IS the
    // measurement, so it is recorded by name.
    set.units_basis = bestUnits.role === 'subject' ? 'subject' : (bestUnits.identity_basis || null);
  } else set.units_basis = null;
  // THE WORDED RATINGS ARE READ INTO SOMETHING A FILTER CAN USE (db/444).
  // `condition_rank` / `quality_rank` are GENERATED from the UAD code alone, so a
  // property whose only rating is the appraiser's own word — the whole 2-4 unit
  // book, because the 1025 was never brought into UAD — is invisible to every
  // condition filter, to the facets and to the valuation's per-grade rate.
  // Measured: 234 of 955 real properties.
  //
  // It reads the ROLLED-UP values, not the observations, so it inherits the
  // after-repair protection above for free: `AS_IS_ONLY` has already decided
  // which report's condition is allowed to describe this property TODAY, and
  // re-reading the words from the observations would walk straight around it.
  // A rating we cannot read leaves every column NULL, which is the same thing
  // the columns said before — never a guess, never a default.
  const condRead = CS.readCondition(set.condition_uad || set.condition_text);
  const qualRead = CS.readQuality(set.quality_uad || set.quality_text);
  set.condition_rank_read = condRead.rank;
  set.condition_rank_low = condRead.rankLow;
  set.condition_rank_high = condRead.rankHigh;
  set.condition_read_source = condRead.source;
  set.condition_read_confidence = condRead.confidence;
  set.quality_rank_read = qualRead.rank;
  set.quality_rank_low = qualRead.rankLow;
  set.quality_rank_high = qualRead.rankHigh;
  set.quality_read_source = qualRead.source;
  set.quality_read_confidence = qualRead.confidence;

  const comps = obs.filter((o) => o.role === 'comparable');
  const counts = {
    subject_count: obs.filter((o) => o.role === 'subject').length,
    comp_count: comps.length,
    // Counted apart from the sales comparables so subject + comp + rental adds
    // up to `observation_count` — adding a third role made those two disagree
    // by a number nothing on the screen explained.
    rental_comp_count: obs.filter((o) => o.role === 'rental_comparable').length,
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
/**
 * RUN A BEST-EFFORT BLOCK THAT CANNOT POISON THE CALLER'S TRANSACTION.
 *
 * `writeReport` is called BOTH ways: the upload door wraps it in a transaction of
 * its own, and the loan-file door (`ingestAppraisal`) hands it the pool directly.
 * That difference decides what "best-effort" has to mean, and getting it wrong
 * breaks one door or the other:
 *
 *   · INSIDE a transaction, a bare try/catch does not contain a SQL error at
 *     all. Postgres aborts the transaction on the first failed statement and
 *     everything after it answers "current transaction is aborted" — so a
 *     swallowed error takes the subject, the whole sales grid, the rent schedule
 *     and the roll-ups down with it, and the report is refused with a message
 *     about a transaction rather than about the thing that failed. Measured: 5
 *     of 152 real reports lost their entire warehouse write that way, invisibly.
 *
 *   · OUTSIDE one, `SAVEPOINT` is itself an error ("can only be used in
 *     transaction blocks") — so unconditionally opening one breaks the loan-file
 *     door, which needs no protection because each statement is its own
 *     transaction and a failure cannot reach the next one.
 *
 * So the savepoint is ATTEMPTED and its absence is fine. Nothing else in the
 * block changes behaviour between the two doors.
 */
async function bestEffort(db, name, run, onError) {
  let held = false;
  try { await db.query(`SAVEPOINT ${name}`); held = true; } catch (_) { /* not in a transaction */ }
  try {
    const r = await run();
    if (held) await db.query(`RELEASE SAVEPOINT ${name}`);
    return r;
  } catch (e) {
    // ROLLING BACK TO A SAVEPOINT DOES NOT RELEASE IT. The subtransaction stays
    // open, and a report whose rent schedule fails row after row therefore leaves
    // one per failure — past 64 open subtransactions Postgres overflows its
    // per-backend subxid cache and every other session's visibility checks start
    // hitting disk. Released explicitly, on the SUCCESS path above and here.
    if (held) {
      try { await db.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch (__) { /* tx already gone */ }
      try { await db.query(`RELEASE SAVEPOINT ${name}`); } catch (__) { /* ditto */ }
    }
    onError(e);
    return null;
  }
}

async function writeReport(db, { a, comps, rentals, link, out }) {
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
      // Whether the subject's unit count was counted or implied (db/434), so the
      // roll-up ranks it for what it is.
      identity_basis: txt(a.subject_units_basis),
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
  //
  // THROUGH `bestEffort`, because "best-effort" inside a transaction is not what
  // a bare catch does: this block's catch used to swallow a SQL error that had
  // already aborted the transaction, so the subject, the whole sales grid, the
  // rent schedule and the roll-ups went down with it and the report was refused
  // with a message about a transaction. Measured: 5 of 152 real reports lost
  // their entire warehouse write that way, invisibly.
  await bestEffort(db, 'market_grid', async () => {
    // NO COORDINATES ARE PASSED, deliberately: `appraisals` carries no
    // subject_latitude/longitude (verified against information_schema — reading
    // them would be a phantom column that silently answers null forever). The
    // subject's position lives on the PROPERTY, which `property_id` points at
    // once the geocoder has placed it.
    const m = await MARKET.writeMarket(db, a, {
      appraisalId, importId, propertyId: subjectId || null, appraiserId,
    });
    if (m.written) { out.market = 1; out.marketPeriods = m.periods; }
  }, (e) => out.skipped.push({ role: 'market', why: `the market grid could not be filed: ${e.message}` }));

  // ---- the COMPARABLES ---------------------------------------------------
  //
  // ITEM 2.4b — PER-UNIT SQUARE FOOTAGE FOR A SALES COMPARABLE, which its own
  // grid can never state. A sales comparable's unit mix is mined from
  // `ROOM_ADJUSTMENT`: rooms, beds and baths, and no area, ever. Measured across
  // the corpus, 353 sales comparables carry a mix and **not one** carries a
  // square footage, while 289 of 290 RENTAL comparables do.
  //
  // On 62 of them the appraiser described the SAME BUILDING in both grids of the
  // same report — so the area is already in the file, one grid over. Indexed by
  // the same property key the warehouse dedupes on, so "the same building" means
  // exactly what it means everywhere else.
  //
  // Keyed on the PROPERTY the address resolves to, not on a second key computed
  // here — the two grids agree about a building exactly when the warehouse says
  // they do, and re-deriving that would be a second definition free to drift.
  const rentalMixByPid = new Map();
  await bestEffort(db, 'rental_mix_index', async () => {
    const rr = Array.isArray(rentals) ? rentals : (appraisalId ? (await db.query(
      `SELECT address, city, state, zip, is_subject, units, unit_mix
         FROM appraisal_rental_comparables WHERE appraisal_id = $1`, [appraisalId])).rows : []);
    for (const rc of rr) {
      if (rc.is_subject) continue;
      let mix = rc.unit_mix;
      if (typeof mix === 'string') { try { mix = JSON.parse(mix); } catch (_) { mix = null; } }
      if (!Array.isArray(mix) || !mix.some((u) => u && u.sqft != null)) continue;
      const inh = K._internals.zip5(rc.zip)
        && K._internals.zip5(rc.zip) === K._internals.zip5(a.subject_zip) ? txt(a.subject_city) : null;
      const pid = await upsertProperty(db, {
        street: rc.address, city: txt(rc.city), fallbackCity: inh,
        state: txt(rc.state) || a.subject_state, zip: rc.zip,
      });
      // TOUCHED, so the property this resolved gets a roll-up. Without it the
      // index could leave a `properties` row with no observation and no
      // recomputation if the rental block later failed.
      if (pid) { touched.add(pid); if (!rentalMixByPid.has(pid)) rentalMixByPid.set(pid, mix); }
    }
  }, (e) => {
    // NAMED, not silent. Every other best-effort block in this file records why
    // it gave up; this one returned nothing at all, so a failure was invisible
    // in `out.skipped` and in `property_ingest_log` alike.
    out.skipped.push({ role: 'rental_area_index',
      why: `per-unit areas could not be carried from the rent schedule onto the sales grid: ${e.message}` });
  });

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
      // THE AGE LINE STATES AN AGE, NOT A YEAR — so mining it for a 4-digit year
      // returned NULL on every comparable in the 602-comp corpus ("106",
      // "114 yrs", "76"). The parser now derives the year from that age plus the
      // report's effective date (db/432) and stores it on the comparable itself;
      // the mine is kept behind it for the rare vendor that really does write a
      // year on that line.
      year_built: K.int(c.year_built, { min: 1700, max: 2100 })
        ?? fromAdjustments(c.adjustments, 'age', K.yearBuilt),
      lot_area: fromAdjustments(c.adjustments, 'site', (v) => txt(v)),
      lot_sqft: fromAdjustments(c.adjustments, 'site', K.lotSqft),
      units: K.int(c.units, { min: 1, max: 100 }),
      // WHERE THAT UNIT COUNT CAME FROM, carried into the warehouse so the
      // roll-up can prefer a measurement over an inference (db/431 added the
      // column; nothing wrote it, so every observation looked equally sure).
      identity_basis: txt(c.identity_basis),
      // The 2-4 family transaction facts (db/430): the price per door and the
      // rent multiplier are facts about THIS SALE, so they live on the
      // observation and are deliberately never rolled up onto the property.
      price_per_unit: c.price_per_unit, monthly_rent: c.monthly_rent, grm: c.grm,
      stories: null,
      design_style: txt(c.design_style) || fromAdjustments(c.adjustments, 'design', (v) => txt(v)),
      // Written at last (db/409 §7): the comparable's own type, proved from how
      // many unit rows its grid carried — never inherited from the subject.
      property_type: txt(c.property_type), property_category: null,
      condition_uad: txt(c.condition_uad), condition_text: txt(c.condition_text),
      quality_uad: txt(c.quality_uad), quality_text: txt(c.quality_text),
      // A comparable is always described AS IT SOLD — there is no such thing as
      // an after-repair comparable, so its ratings are always the as-is basis.
      condition_basis: 'as_is',
      view_rating: txt(c.view_rating), location_rating: txt(c.location_rating),
      location_type: txt(c.location_type), view_type: txt(c.view_type),
      functional_utility: txt(c.functional_utility),
      below_grade_sqft: c.below_grade_sqft, below_grade_finished_sqft: c.below_grade_finished_sqft,
      below_grade_beds: c.below_grade_beds,
      below_grade_baths_full: c.below_grade_baths_full,
      below_grade_baths_half: c.below_grade_baths_half,
      below_grade_rec_rooms: c.below_grade_rec_rooms,
      below_grade_other_rooms: c.below_grade_other_rooms,
      basement_exit: txt(c.basement_exit),
      basement_sqft: null, basement_finished_pct: null,
      garage_type: fromAdjustments(c.adjustments, 'garage', (v) => txt(v)), garage_spaces: null,
      price_per_gla: c.price_per_gla,
      // NOT `|| 'gla'`. A comparable row stored before db/427 added the column has
      // NO recorded basis, and defaulting it to 'gla' ASSERTS it is a living area
      // — which then outranks a correctly-labelled building area in the roll-up,
      // whatever the dates. That is the exact fact-dropping this pair exists to
      // stop. An unrecorded basis stays unrecorded and ranks between the two.
      gla_basis: txt(c.gla_basis), proximity: txt(c.proximity),
      neighborhood: null, census_tract: null, flood_zone: null, fema_flood_zone: null, sfha: null,
      zoning_id: null, zoning_desc: null,
      occupancy_status: null, market_rent: null,
      // THE PER-UNIT ROOM LINE the 1025 grid stated (db/426). Through `bindable`
      // because a jsonb column reads back as a JS array and binding it raw makes
      // node-postgres send a Postgres array literal — the roll-up wipe of #974.
      unit_mix: bindable(mergeUnitAreas(c.unit_mix, rentalMixByPid.get(pid))),
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
    // The adjustment lines as rows (db/440) — the market benchmark's raw material.
    // Its own savepoint: a derived index must never fail the ingest that feeds it.
    await bestEffort(db, 'adj_rows', async () => {
      // ONE definition of where and when, shared with the back-fill — see
      // `adjustmentPlaceAndDate`. Deriving them here independently is what made
      // the two writers disagree on 15,909 of 17,431 rows.
      const pd = await adjustmentPlaceAndDate(db, pid, saleDate, observedOn);
      return writeAdjustments(db, {
        observationId: obs.id, propertyId: pid, adjustments: c.adjustments || [],
        place: pd.place, on: pd.on,
        // The two sizes the size-line rate is derived from. `a.gla` is the
        // SUBJECT of this report; `c.gla` is this comparable's own.
        subjectGla: a.gla, compGla: c.gla, compGlaBasis: c.gla_basis,
      });
    }, (e) => { out.skipped.push({ what: 'adjustment rows', why: e && e.message }); });
    out.sales += await recordSale(db, { propertyId: pid, date: c.sale_date, price: c.sale_price,
      type: txt(c.sale_type), status: txt(c.sale_status) || 'closed', source: 'comp_sale',
      appraisalId, importId, observationId: obs.id,
      out, what: { address: txt(c.address), seq: txt(c.seq), of: 'a comparable sale' } });
    out.sales += await recordSale(db, { propertyId: pid, date: c.prior_sale_date, price: c.prior_sale_amount,
      type: null, status: 'closed', source: 'comp_prior_sale', appraisalId, importId, observationId: obs.id,
      out, what: { address: txt(c.address), seq: txt(c.seq), of: 'a comparable\'s previous sale' } });
  }

  // ---- the RENTAL comparables (db/435) -----------------------------------
  //
  // The rent schedule's own grid. These are REAL properties with an in-place
  // rent, filed as observations in their own role so nothing that means "a
  // sale" ever picks them up: they have no sale price, no sale date and no
  // adjustment grid, and `recordSale` is deliberately never called for them.
  //
  // What they bring that the sales grid cannot: PER-UNIT SQUARE FOOTAGE (289 of
  // 290 across the corpus — `ROOM_ADJUSTMENT` never states an area), the rent
  // somebody is actually paying, and whether that rent is controlled.
  //
  // Sequence 0 is the SUBJECT's own rental summary and is skipped here — the
  // subject already has its own observation, written above, and filing a second
  // one for the same report would double every count on that property.
  // Through `bestEffort` — see its header for why "best-effort" means two
  // different things depending on which door called us.
  //
  // COUNTED OUTSIDE THE BLOCK. `out.observations++` inside a savepoint survives
  // the rollback that un-writes its row, and that number is what
  // `property_ingest_log.observations_written` records.
  let rentalsFiled = 0;
  await bestEffort(db, 'rental_grid', async () => {
    // ONE REPORT IS READ THE SAME WAY WHICHEVER DOOR IT ARRIVED THROUGH. A
    // loan-file report has `appraisal_rental_comparables` rows to read; an
    // UPLOADED report (db/411) has no `appraisals` row to hang them on and hands
    // them straight over, exactly as it does for the sales comparables.
    const rentalRows = Array.isArray(rentals) ? rentals
      : (appraisalId ? (await db.query(
        `SELECT * FROM appraisal_rental_comparables
          WHERE appraisal_id = $1 AND is_subject = false ORDER BY seq`, [appraisalId])).rows : []);
    for (const rc of rentalRows) {
      if (rc.is_subject) continue;
      // ONE BAD ROW MUST NOT COST THE WHOLE SCHEDULE. With a single savepoint
      // around the loop, an unstorable figure on the first rental discarded a
      // perfectly good second one. Each row settles on its own, and a failure
      // NAMES the row rather than the schedule.
      const settled = await bestEffort(db, 'rental_row', async () => {
      // The SAME address shape the sales comparables use — `upsertProperty`
      // owns the key, and `fallbackCity` is the gated inheritance (a row that
      // named no town takes the subject's ONLY when the two ZIPs agree).
      const rentInheritedCity = K._internals.zip5(rc.zip)
        && K._internals.zip5(rc.zip) === K._internals.zip5(a.subject_zip)
        ? txt(a.subject_city) : null;
      const pid = await upsertProperty(db, {
        street: rc.address, city: txt(rc.city), fallbackCity: rentInheritedCity,
        state: txt(rc.state) || a.subject_state, zip: rc.zip,
      });
      if (!pid) {
        out.skipped.push({ role: 'rental_comparable', seq: txt(rc.seq), address: txt(rc.address),
          why: 'the rent schedule did not write enough of this address to identify the property (needs a house number, a state, and a city or ZIP)' });
        return false;
      }
      touched.add(pid);
      await upsertObservation(db, {
        property_id: pid, appraisal_id: appraisalId, import_id: importId,
        application_id: a.application_id || null,
        comparable_id: null, appraiser_id: appraiserId, role: 'rental_comparable',
        comp_seq: txt(rc.seq), comp_set: null, comp_set_confidence: null, comp_set_needs_review: null,
        observed_on: observedOn, form_type: txt(a.form_type),
        address_as_stated: [txt(rc.address), txt(rc.city), txt(rc.state), txt(rc.zip)].filter(Boolean).join(', ') || null,
        // A RENT IS NOT A SALE. Every transaction column stays null and no row is
        // written to `property_sales` — this property did not change hands.
        sale_price: null, adjusted_price: null, sale_date: null, sale_date_text: null,
        sale_status: null, sale_type: null, concession_amount: null, financing_type: null,
        days_on_market: null, data_source: txt(rc.data_source),
        prior_sale_amount: null, prior_sale_date: null,
        // The rent schedule states GROSS BUILDING area, never gross LIVING area,
        // so the basis travels with the number exactly as it does on a 1025 grid.
        gla: rc.gba_sqft, gla_basis: 'gba',
        actual_monthly_rent: rc.monthly_rent, rent_per_gba: rc.rent_per_gba,
        rent_controlled: rc.rent_controlled,
        beds: null, baths_text: null, baths_full: null, baths_half: null, total_rooms: null,
        year_built: K.int(rc.year_built, { min: 1700, max: 2100 }),
        lot_area: null, lot_sqft: null, units: K.int(rc.units, { min: 1, max: 100 }),
        // The rent schedule does not name a category, and a unit count of 2+ is
        // what makes it a small-income building — the same rule `compIdentity`
        // applies, with no form to lean on.
        identity_basis: rc.units != null ? 'grid' : null,
        price_per_unit: null, monthly_rent: null, grm: null,
        stories: null, design_style: null,
        property_type: rc.units != null && rc.units >= 2
          ? (rc.units >= 5 ? PT.LABEL_OF.multi_5_plus : PT.LABEL_OF.multi_2_4) : null,
        property_category: null,
        condition_uad: txt(rc.condition_uad), condition_text: txt(rc.condition_text),
        quality_uad: null, quality_text: null,
        // A rental comparable is described as it stands and is let today —
        // there is no such thing as an after-repair rent comparable.
        condition_basis: 'as_is',
        view_rating: null, location_rating: null, location_type: txt(rc.location_code),
        below_grade_sqft: null, below_grade_finished_sqft: null,
        basement_sqft: null, basement_finished_pct: null,
        garage_type: null, garage_spaces: null,
        price_per_gla: null, proximity: txt(rc.proximity),
        neighborhood: null, census_tract: null, flood_zone: null, fema_flood_zone: null, sfha: null,
        zoning_id: null, zoning_desc: null,
        occupancy_status: null, market_rent: null,
        // THE FACT THE SALES GRID CANNOT GIVE: per-unit rooms, beds, baths AND
        // SQUARE FOOTAGE, plus what each unit rents for.
        unit_mix: bindable(rc.unit_mix),
        owner_of_record: null, property_rights: null,
        hoa_fee_amount: null, hoa_fee_period: null, condo_floor: null,
        effective_age: null, remaining_economic_life: null,
        heating_type: null, heating_fuel: null, cooling: null, foundation_type: null,
        attic: null, has_adu: null, lot_shape: null, lot_dimensions: null, listed_within_year: null,
        latitude: null, longitude: null,
        net_adjustment: null, net_adj_pct: null, gross_adj_pct: null,
        // A rental comparable has no adjustment grid at all — the appraiser is
        // comparing RENTS, not reconciling a price. The column is NOT NULL, and
        // an empty list is the honest reading: there were no adjustment lines,
        // as opposed to "we did not look".
        adjustments: JSON.stringify([]),
        appraised_value: null, as_is_value: null, arv_value: null, contract_price: null,
        contract_date: null,
        facts: JSON.stringify({ lease_terms: txt(rc.lease_terms) || null,
          utilities_included: txt(rc.utilities_included) || null }),
        });
        return true;
      }, (e) => out.skipped.push({ role: 'rental_comparable', seq: txt(rc.seq), address: txt(rc.address),
        why: `this rent-schedule row could not be filed: ${e.message}` }));
      if (settled) rentalsFiled++;
    }
  }, (e) => out.skipped.push({ role: 'rental_comparable', why: `the rent schedule could not be filed: ${e.message}` }));
  // COUNTED AFTER THE BLOCK SETTLES, never inside it. `out.observations++` sat
  // within the savepoint, so a rollback un-wrote the rows and left the number —
  // and that number is what `property_ingest_log.observations_written` records.
  out.observations += rentalsFiled;

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
    // One property failing to recompute must not take every property after it —
    // and the report itself — down with it.
    await bestEffort(db, 'rollup_one', () => rollupProperty(db, pid), (e) => {
      out.rollupFailed = (out.rollupFailed || 0) + 1;
      out.skipped.push({ role: 'rollup', property_id: pid, why: `the property's facts could not be recomputed: ${(e && e.message) || e}` });
    });
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

/**
 * CARRY PER-UNIT SQUARE FOOTAGE FROM THE RENT SCHEDULE ONTO THE SALES GRID
 * (task-list item 2.4b), for the same building on the same report.
 *
 * The two grids describe one property and were both written by the same
 * appraiser, each numbering its dwellings explicitly. What the sales grid states
 * (rooms, beds, baths) and what the rent grid states (area, rent) are disjoint,
 * so this only ever FILLS a blank — a value already on the sales mix is never
 * touched.
 *
 * IT REFUSES ON ANY DISAGREEMENT. The two grids must describe the same number of
 * dwellings, and a unit number present on one side must be present on the other;
 * otherwise the pairing is a guess and putting unit 3's area on unit 2 is worse
 * than leaving it blank. Anything unreadable yields the sales mix unchanged.
 */
function mergeUnitAreas(salesMix, rentalMix) {
  let mix = salesMix;
  if (typeof mix === 'string') { try { mix = JSON.parse(mix); } catch (_) { return salesMix; } }
  if (!Array.isArray(mix) || !mix.length) return salesMix;
  if (!Array.isArray(rentalMix) || rentalMix.length !== mix.length) return salesMix;
  const byUnit = new Map();
  for (const u of rentalMix) { if (u && u.unit != null) byUnit.set(String(u.unit), u); }
  if (byUnit.size !== rentalMix.length) return salesMix;              // a repeated unit number on the rent side
  // AND ON THE SALES SIDE. A sales row with no stated sequence is labelled by
  // POSITION (`r.seq != null ? r.seq : i + 1`), so a seq-less first row and a
  // genuine `UnitSequenceIdentifier="1"` row both come out as "1" — and both
  // would then have been given unit 1's area while unit 2's was discarded.
  if (new Set(mix.map((u) => String(u.unit))).size !== mix.length) return salesMix;
  if (!mix.every((u) => u && u.unit != null && byUnit.has(String(u.unit)))) return salesMix;
  let filled = 0;
  const out = mix.map((u) => {
    const r = byUnit.get(String(u.unit));
    const add = {};
    if (u.sqft == null && r.sqft != null) { add.sqft = r.sqft; filled++; }
    if (u.monthly_rent == null && r.monthly_rent != null) { add.monthly_rent = r.monthly_rent; filled++; }
    return filled || Object.keys(add).length ? Object.assign({}, u, add) : u;
  });
  return filled ? out : salesMix;
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
  ingestAppraisal, backfill, ingestStatus, linkPhotos, rerollStaleProperties, adjustmentBenchmark, adjustmentRate,
  backfillAdjustmentRowsOnce,
  // The shared report-writing body — the standalone XML upload (db/411) drives it
  // with the same row shapes, so both doors read one report identically.
  writeReport,
  INGEST_VERSION,
  _internals: { upsertAppraiser, upsertProperty, upsertObservation, rollupProperty, recordSale,
    recountAppraiser, subjectFacts, bathsText, digits, fromAdjustments, uadView, retireAppraisal, bindable,
    rateRungs, rateAtScope,
    ROLLUP_FACTS, AS_IS_ONLY, ROLLUP_VERSION, mergeUnitAreas, identityRank, writeAdjustments, unitDeltaFor },
};

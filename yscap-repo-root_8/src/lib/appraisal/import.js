/**
 * Appraisal import service — parse an appraisal XML and land it in the database.
 *
 * The one chokepoint between the parser/findings and storage (db/131). It:
 *   1. parses the XML (extract) — routes by form, validates every field, never guesses;
 *   2. supersedes any prior appraisal on the file and inserts the new `appraisals` row
 *      + comparables + units + photo manifest;
 *   3. computes PILOT findings vs the loan file and inserts `appraisal_findings`;
 *   4. fills `applications.as_is_value`/`arv` from DEFINITE values ONLY, and ONLY when the
 *      file's value is empty — a differing human value is NEVER overwritten (it becomes a
 *      finding instead — the overwrite-shield);
 *   5. returns a summary the route uses to open/close the two internal conditions.
 *
 * `db` is a client exposing `query(text, params) -> {rows}` (the pg Pool/Client, or a tx).
 * Pure of any framework; all IO is through `db`. Dollar amounts/dates come pre-normalized
 * from extract(). Returns { ok, appraisalId, findings, summary, needsAsIsCondition, blocksCtc }.
 */
const { extract } = require('./extract');
const { computeFindings, summarize } = require('./findings');

// Public entry — runs the whole import ATOMICALLY. A single import touches many tables
// (supersede prior appraisal + its findings, insert the new appraisal + comps + units + photos +
// findings, fill the file). If any step threw mid-way we'd leave the file with the prior appraisal
// SUPERSEDED but no replacement row and half its comps/findings — a corrupt half-import. So when
// handed the pool (has getClient), grab ONE dedicated connection and wrap it in a transaction;
// a caller that passes its own tx client keeps ownership and we just run inline on it.
async function importAppraisal(db, args) {
  if (!args || !args.applicationId) throw new Error('applicationId required');
  if (db && typeof db.getClient === 'function') {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const out = await importAppraisalTx(client, args);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
      throw e;
    } finally {
      client.release();
    }
  }
  return importAppraisalTx(db, args);
}

async function importAppraisalTx(db, {
  applicationId, xml, importedBy = null,
  sourceXmlDocumentId = null, pdfDocumentId = null,
  file = null, today = null, thresholds = {},
}) {
  if (!applicationId) throw new Error('applicationId required');
  const A = extract(xml);
  if (!A.ok) return { ok: false, error: A.error || 'could not parse appraisal XML' };

  // Load the file row if not supplied (for findings + overwrite-shield).
  let f = file;
  if (!f) {
    const r = await db.query(
      `SELECT id, property_address, property_type, units, purchase_price, as_is_value, arv, rehab_budget
         FROM applications WHERE id = $1`, [applicationId]);
    f = r.rows[0] || {};
  }

  // 1. supersede prior appraisals AND their still-open findings on this file, so a
  //    re-import doesn't leave stale findings inflating the open-count / blocksCtc summary.
  // Serialize concurrent imports on the SAME file FIRST (a double-click, two officers, or the
  // /import route racing the condition-slot auto-import). Without this row lock each transaction runs
  // supersede-then-insert on its own MVCC snapshot, neither sees the other's uncommitted insert, and
  // BOTH survive as superseded=false → multiple "current" appraisals + doubled open findings. The
  // lock makes the second import WAIT here, then supersede the first's now-committed row correctly.
  await db.query(`SELECT id FROM applications WHERE id = $1 FOR UPDATE`, [applicationId]);
  // WHICH reports this import retires, by id. The research warehouse has to be
  // TOLD — `ingestAppraisal` retires a superseded report, but only when it is
  // called for that report's own id, and nothing was calling it: the import
  // fires the warehouse for the NEW appraisal only, and the corpus back-fill
  // skips any report whose ledger already reads `ok`. So a corrected re-import
  // left the old grid's observations standing beside the new one and every
  // property on it counted twice — comp counts, the ARV/as-is split, the
  // appraiser's totals and the photo count all doubled.
  const supersededIds = (await db.query(
    `UPDATE appraisals SET superseded = true
      WHERE application_id = $1 AND superseded = false
      RETURNING id`, [applicationId])).rows.map((r) => r.id);
  await db.query(`UPDATE appraisal_findings SET status = 'superseded' WHERE application_id = $1 AND status = 'open'`, [applicationId]);

  // 2. insert the appraisal row
  const cols = appraisalRowFrom(A, { applicationId, sourceXmlDocumentId, pdfDocumentId, importedBy });
  const keys = Object.keys(cols);
  const ins = await db.query(
    `INSERT INTO appraisals (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
    keys.map((k) => cols[k]));
  const appraisalId = ins.rows[0].id;

  return continueImportTx(db, { A, appraisalId, applicationId, f, today, thresholds, supersededIds });
}

/**
 * SHAPE THE `appraisals` ROW FROM A PARSED REPORT — the one mapping from what the
 * parser read to what the database stores.
 *
 * Factored out of the insert above so a report can be shaped WITHOUT being stored
 * on a loan file: the research warehouse's standalone XML upload (db/411) has no
 * application to hang an `appraisals` row on, and builds this exact object in
 * memory instead. One mapping means the two doors can never learn to disagree
 * about what a field means — a new column added here reaches both at once.
 *
 * PURE: no database, no IO.
 */
function appraisalRowFrom(A, { applicationId = null, sourceXmlDocumentId = null, pdfDocumentId = null, importedBy = null } = {}) {
  const s = A.subject, v = A.values, ap = A.appraiser, condo = A.condo || {};
  const fieldsJson = buildFieldsJson(A);
  const cols = {
    application_id: applicationId, source_xml_document_id: sourceXmlDocumentId, pdf_document_id: pdfDocumentId,
    form_type: A.formType, software_vendor: null,
    effective_date: v.effectiveDate, report_signed_date: ap.reportSignedDate, inspection_date: ap.inspectionDate,
    condition_of_appraisal: v.conditionOfAppraisal,
    appraised_value: v.appraisedValue,
    as_is_value: v.asIs, as_is_confidence: v.asIsConfidence,
    arv_value: v.arv, arv_confidence: v.arvConfidence,
    value_sales_approach: v.valueSalesApproach, value_cost_approach: v.valueCostApproach,
    value_income_approach: v.valueIncomeApproach, grm: v.grm, site_value: v.siteValue,
    contract_price: v.contractPrice, contract_date: v.contractDate,
    prior_sale_amount: s.priorSale ? s.priorSale.priorAmount : null,
    prior_sale_date: s.priorSale ? s.priorSale.priorDate : null,
    has_prior_sale: s.priorSale ? s.priorSale.hasPrior : null,
    subject_address: s.address, subject_city: s.city, subject_county: s.county, subject_state: s.state, subject_zip: s.zip,
    apn: s.apn, legal_description: s.legal, census_tract: s.censusTract, neighborhood: s.neighborhood,
    // `property_type` now holds the real CATEGORY in the portal's vocabulary ("Multi 2–4", "Condo",
    // "SFR (1 unit)"), derived by lib/appraisal/property-category.js. The MISMO attachment STYLE
    // that used to live in this column keeps its own home so the fact is not lost — it is simply
    // never again mistaken for a property type (owner-reported 2026-08-02). db/405.
    property_type: s.propertyType, property_category: s.propertyCategory, attachment_type: s.attachmentType,
    units: s.units, year_built: s.yearBuilt, gla: s.gla,
    rooms: s.rooms, beds: s.beds, baths_full: s.bathsFull, baths_half: s.bathsHalf,
    stories: s.stories, design_style: s.design, lot_area: s.lotArea,
    zoning_id: s.zoningId, zoning_desc: s.zoningDesc, zoning_compliance: s.zoningCompliance,
    condition_uad: s.conditionUad, quality_uad: s.qualityUad, flood_zone: s.floodZone,
    appraiser_name: ap.name, appraiser_company: ap.company, license_id: ap.licenseId,
    license_state: ap.licenseState, license_type: ap.licenseType, license_exp: ap.licenseExp,
    appraiser_phone: ap.phone, appraiser_email: ap.email, supervisor_name: ap.supervisor,
    lender_name: ap.lender, amc_name: ap.amc,
    borrower_name: A.borrower.name, borrower_is_entity: A.borrower.isLlc,
    condo_project_name: condo.projectName, condo_project_type: condo.projectType,
    condo_unit_identifier: condo.unitIdentifier, condo_floor: condo.floor,
    hoa_fee_amount: condo.hoaFeeAmount, hoa_fee_period: condo.hoaFeePeriod,
    // As-Is vs ARV comp-grid split provenance (db/156). as_is_value/arv_value above already carry
    // the two values; these say how the per-comp split was determined and whether it needs review.
    comp_split_confidence: (A.compSplit && A.compSplit.confidence) || null,
    comp_split_needs_review: A.compSplit ? !!A.compSplit.needsReview : null,
    // Which parser wrote the comparable rows below (db/427). A fresh import is
    // current by definition; the boot pass uses this to find the ones that are not.
    comp_parse_version: COMP_PARSE_VERSION,
    fields: JSON.stringify(fieldsJson), warnings: JSON.stringify(A.warnings || []),
    imported_by: importedBy,
  };
  // Merge the enrichment fields (db/158 + later rounds) — extract() keys them EXACTLY to the column
  // names. The jsonb columns in the loop below need stringifying; everything else is a scalar the
  // driver stores directly.
  Object.assign(cols, A.enrich || {});
  for (const jk of ['utilities', 'updates', 'amenities', 'rent_included_utilities', 'market_trends', 'present_land_use', 'off_site_improvements', 'comp_research']) {
    if (cols[jk] != null) cols[jk] = JSON.stringify(cols[jk]);
  }
  return cols;
}

/** The rest of the import, once the `appraisals` row exists. */
async function continueImportTx(db, { A, appraisalId, applicationId, f, today, thresholds, supersededIds = [] }) {
  const v = A.values, ap = A.appraiser;

  // 3. comparables (real comps; seq-0 subject is excluded by the parser). Store the full
  //    sales-grid line each comp carries — settled sale date, GLA, UAD condition/quality,
  //    days-on-market, $/GLA, and the itemized adjustments — so the review checks (and the
  //    report grid) have the data. Every field is null when the appraisal didn't carry it.
  for (const c of A.comparables || []) {
    const row = comparableRowFrom(c);
    const ck = Object.keys(row);
    await db.query(
      `INSERT INTO appraisal_comparables (appraisal_id, is_subject, ${ck.join(',')})
       VALUES ($1, false, ${ck.map((_, i) => '$' + (i + 2)).join(',')})`,
      [appraisalId, ...ck.map((k) => row[k])]);
  }

  // 4. 1025 per-unit rents + the per-unit mix (rooms/beds/baths/sqft) + lease status (db/158
  //    populates the appraisal_units columns that already existed but were never written).
  for (const u of A.units || []) {
    await db.query(
      `INSERT INTO appraisal_units (appraisal_id, unit_seq, actual_rent, market_rent, rooms, beds, baths, sqft, lease_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [appraisalId, u.seq, u.actualRent, u.marketRent, u.rooms, u.beds, u.baths, u.sqft, u.leaseStatus]);
  }

  // 5. photo manifest (pixels come later from the PDF)
  const pm = A.photos || {};
  if (pm.embeddedPdf) {
    await db.query(
      `INSERT INTO appraisal_photos (appraisal_id, category, caption) VALUES ($1,'exhibit',$2)`,
      [appraisalId, `Full appraisal PDF (${pm.imageMeta || 0} photo pages referenced)`]);
  }

  // 6. findings vs the file
  const findings = computeFindings(A, f, Object.assign({ today }, thresholds));
  // A HUMAN'S DECISION SURVIVES A RE-IMPORT (owner-reported 2026-07-27: "I dismiss
  // it and it keeps popping up again"). A re-import supersedes the old findings and
  // inserts a fresh OPEN row for each — with no memory of what a reviewer already
  // decided, so every dismissal / exception on this appraisal was silently undone.
  // The durable ledger (db/333) is keyed on the finding's identity, not on the row,
  // so the decision carries forward: the row is still written (audit trail + the
  // "already dealt with" view) but born resolved instead of re-opening settled work.
  // FAILS OPEN — an unreadable ledger just means everything lands open, as before.
  const fdec = require('../underwriting/finding-decisions');
  const settled = await fdec.suppressedKeys(db, applicationId);
  for (const fd of findings) {
    const carried = settled.size && fdec.isSuppressed(settled, {
      code: fd.code, field: fd.field,
      docValue: fd.appraisalValue == null ? null : String(fd.appraisalValue),
    });
    await db.query(
      `INSERT INTO appraisal_findings
         (appraisal_id, application_id, source, code, severity, field, appraisal_value, file_value, title, how_to, blocks_ctc, status, resolution, resolution_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [appraisalId, applicationId, fd.source, fd.code, fd.severity, fd.field,
       fd.appraisalValue == null ? null : String(fd.appraisalValue),
       fd.fileValue == null ? null : String(fd.fileValue),
       fd.title, fd.howTo, !!fd.blocksCtc,
       carried ? 'dismissed' : 'open',
       carried ? 'carried_forward' : null,
       carried ? 'A reviewer already decided this finding on this file — carried forward from their decision.' : null]);
    if (carried) fd.status = 'dismissed';
  }
  // summarize() counts only OPEN findings, so a carried-forward decision correctly
  // drops out of the badge + the blocksCtc roll-up instead of re-inflating them.
  const sum = summarize(findings);

  // 7. fill the file from DEFINITE values ONLY, ONLY when currently empty (overwrite-shield).
  //    A differing human value is never overwritten — it is one of the findings above.
  // A fill RECORDS ITSELF on the appraisal row, in the same columns the As-Is/ARV desk uses
  // (db/353, db/354). Before this, an undo had to GUESS that a file value equal to the appraisal's
  // must have been filled by the import — and since the desk's whole job is now to make the file
  // agree with the appraisal, "equal" is the normal state, so that guess deleted values humans had
  // typed. Recording the fill gives undo exactly one thing to reverse: what PILOT actually wrote.
  if (v.asIs != null && v.asIsConfidence === 'definite') {
    const r = await db.query(`UPDATE applications SET as_is_value = $2 WHERE id = $1 AND as_is_value IS NULL`, [applicationId, v.asIs]);
    if (r.rowCount > 0) {
      try {
        await db.query(
          `UPDATE appraisals SET as_is_applied = true, as_is_applied_value = $2, as_is_file_value_before = NULL WHERE id = $1`,
          [appraisalId, v.asIs]);
      } catch (_) { /* the fill itself already happened; the stamp is best-effort */ }
    }
  }
  if (v.arv != null && v.arvConfidence === 'definite') {
    const r = await db.query(`UPDATE applications SET arv = $2 WHERE id = $1 AND arv IS NULL`, [applicationId, v.arv]);
    if (r.rowCount > 0) {
      try {
        await db.query(
          `UPDATE appraisals SET arv_applied = true, arv_applied_value = $2, arv_file_value_before = NULL WHERE id = $1`,
          [appraisalId, v.arv]);
      } catch (_) { /* best-effort stamp */ }
    }
  }
  // Fill the file's appraiser name (blank-only) so the MISMO 3.4 loan export
  // (src/lib/mismo) carries the real appraiser — synergy, same overwrite-shield posture.
  if (ap.name) {
    await db.query(`UPDATE applications SET appraiser_name = $2 WHERE id = $1 AND (appraiser_name IS NULL OR appraiser_name = '')`, [applicationId, ap.name]);
  }
  // 8. THE FACTS THE APPRAISAL STATES, ONTO THE FILE (db/403, owner-directed 2026-08-02:
  //    "all these things that he's getting from the appraisal … please add this field in our file
  //    and that field should automatically be tabulated once you import the XML"). Before this the
  //    loan file had no column for the seller, the year built, the living area or the market rent,
  //    so every one of those rows in the data comparison read "· Nothing to compare".
  //    Same overwrite-shield as everything above: blank-only, so a value already on the file is
  //    never overwritten. NOT wrapped in a try/catch — the fills above aren't either, and a
  //    swallowed error inside the import's transaction would poison the COMMIT anyway; a failure
  //    here is a real fault and should roll the import back loudly.
  await fillFileFacts(db, applicationId, A);

  return {
    ok: true, appraisalId, findings, summary: sum,
    needsAsIsCondition: !(v.asIs != null && v.asIsConfidence === 'definite'),
    blocksCtc: sum.blocksCtc,
    warnings: A.warnings || [],
    // The reports this import retired. The caller re-ingests each one so the
    // research warehouse takes their observations back out — see the comment on
    // the supersede UPDATE above.
    supersededIds,
  };
}

/**
 * The appraiser's MONTHLY market rent for the whole property — the ONE resolution this repo uses
 * (mirrors src/lib/underwriting/run.js and db/403's backfill): the subject's estimated market
 * monthly rent when the report carries it, else the summed per-unit market rents off a 1025/1007
 * rent schedule. Returns null when the appraisal states neither (never 0 — a zero sum means the
 * schedule was empty, not that the property rents for nothing).
 */
function marketMonthlyRent(A) {
  const est = Number((A.enrich || {}).est_market_monthly_rent);
  if (Number.isFinite(est) && est > 0) return est;
  let sum = 0, seen = 0;
  for (const u of A.units || []) {
    const n = Number(u.marketRent);
    if (Number.isFinite(n) && n > 0) { sum += n; seen++; }
  }
  return seen > 0 && sum > 0 ? sum : null;
}

/**
 * COPY THE APPRAISAL'S PROPERTY FACTS ONTO THE LOAN FILE (db/403, owner-directed 2026-08-02).
 *
 * The seller, the year built, the living area and the market rent had no home on the file at all,
 * so the Appraisal page's data-comparison showed the appraiser's figure beside an empty "Loan file"
 * cell and the verdict "· Nothing to compare". Now the file carries them, which is also what gives
 * the SELLER a value of record for the purchase contract / title report / settlement statement to
 * tie out against (facts.js `seller_name`).
 *
 * BLANK-ONLY, one column at a time — the same overwrite-shield the As-Is / ARV / appraiser-name
 * fills use. A value already on the file is never overwritten by a re-import.
 *
 * OCCUPANCY IS DELIBERATELY ABSENT (owner-directed, same message): the appraisal's occupancy is the
 * SELLER's use of the property TODAY ("even if the appraisal is owner occupied it means that the
 * current owner is living in the property"), while `applications.occupancy` is the BORROWER's use
 * after closing — and we only lend non-owner-occupied. Two different facts about two different
 * people, so an "OwnerOccupied" appraisal must never write our file's occupancy. If you are ever
 * tempted to add it here: don't.
 */
async function fillFileFacts(db, applicationId, A) {
  const s = A.subject || {};
  // year() already validated the range (1700..current year) and returns a numeric string.
  const yearBuilt = s.yearBuilt == null ? null : Number(s.yearBuilt);
  // gla is bounded to 1e8 by the parser; round to whole square feet for the int4 column.
  const gla = Number(s.gla);
  // [column, value, "still blank" test]. seller_name is text, so an empty string counts as blank
  // (that is how the rest of the file treats a text column — see the appraiser_name fill above).
  const fills = [
    ['seller_name', (A.enrich || {}).owner_of_record || null, `(seller_name IS NULL OR seller_name = '')`],
    ['year_built', Number.isInteger(yearBuilt) ? yearBuilt : null, 'year_built IS NULL'],
    ['living_area_sqft', Number.isFinite(gla) && gla > 0 && gla < 1e9 ? Math.round(gla) : null, 'living_area_sqft IS NULL'],
    ['market_rent', marketMonthlyRent(A), 'market_rent IS NULL'],
  ];
  for (const [col, val, blank] of fills) {
    if (val == null || val === '') continue;
    await db.query(`UPDATE applications SET ${col} = $2 WHERE id = $1 AND ${blank}`, [applicationId, val]);
  }
}

/**
 * SHAPE ONE `appraisal_comparables` ROW from a parsed comparable — the sibling of
 * `appraisalRowFrom`, and the only mapping from a parsed grid line to storage.
 *
 * Same reason it exists: the research warehouse's standalone XML upload (db/411)
 * builds these in memory rather than storing them against a loan file, and the two
 * doors must read one report identically. PURE: no database, no IO.
 */
function comparableRowFrom(c) {
  return {
    seq: c.seq, address: c.address, city: c.city, state: c.state, zip: c.zip,
    proximity: c.proximity, sale_price: c.salePrice, adjusted_price: c.adjustedPrice,
    gla: c.gla, sale_date: c.saleDate, contract_date: c.contractDate,
    condition_uad: c.conditionUad, quality_uad: c.qualityUad,
    // days_on_market is a TEXT column ("21", "45+", "N/A") — the grid writes prose as often as a number.
    days_on_market: c.dom == null ? null : String(c.dom), price_per_gla: c.pricePerGla,
    net_adjustment: c.netAdjustment, net_adj_pct: c.netAdjPct, gross_adj_pct: c.grossAdjPct,
    adjustments: JSON.stringify(c.adjustments || []),
    comp_set: c.comp_set || 'unknown', sale_status: c.saleStatus || 'closed',
    beds: c.beds, baths: c.bathsText, baths_full: c.bathsFull, baths_half: c.bathsHalf,
    total_rooms: c.totalRooms, sale_type: c.saleType, concession_amount: c.compConcession,
    financing_type: c.financingType,
    prior_sale_amount: c.priorSaleAmount, prior_sale_date: c.priorSaleDate,
    latitude: c.latitude, longitude: c.longitude,
    view_rating: c.viewRating, location_rating: c.locationRating,
    below_grade_sqft: c.belowGradeSqft, below_grade_finished_sqft: c.belowGradeFinishedSqft,
    data_source: c.compDataSource, location_type: c.locationType,
    // The worded condition/quality rating a non-UAD vendor wrote, and which of
    // the two AREA measures this comp's `gla` actually is (db/409 §7).
    condition_text: c.conditionText, quality_text: c.qualityText, gla_basis: c.glaBasis,
    price_per_gla_basis: c.pricePerGlaBasis,
    // THE UNITS, as the 1025 grid stated them (db/426). `units` has existed since
    // db/409 §7 and was written by nothing — this key was simply never emitted.
    // Both are NULL on a single-unit grid: one room row is the property, not a
    // unit, and neither may ever be inherited from the subject.
    units: c.units, unit_mix: c.unitMix ? JSON.stringify(c.unitMix) : null,
  };
}

// Flatten the parsed appraisal into the {key:{value,source,confidence}} catch-all so nothing is lost.
function buildFieldsJson(A) {
  const out = {};
  const put = (k, value, confidence = 'definite', source = 'xml') => {
    if (value != null && value !== '') out[k] = { value, source, confidence };
  };
  const s = A.subject, v = A.values, ap = A.appraiser;
  Object.entries(s).forEach(([k, val]) => put('subject.' + k, val, k === 'conditionUad' || k === 'qualityUad' ? (val ? 'definite' : 'missing') : 'definite'));
  put('value.asIs', v.asIs, v.asIsConfidence);
  put('value.arv', v.arv, v.arvConfidence);
  ['appraisedValue', 'valueSalesApproach', 'valueCostApproach', 'valueIncomeApproach', 'grm', 'siteValue', 'contractPrice', 'contractDate', 'effectiveDate', 'conditionOfAppraisal'].forEach((k) => put('value.' + k, v[k]));
  Object.entries(ap).forEach(([k, val]) => put('appraiser.' + k, val));
  if (A.condo) Object.entries(A.condo).forEach(([k, val]) => put('condo.' + k, val));
  if (A.income) Object.entries(A.income).forEach(([k, val]) => put('income.' + k, val));
  // Report contents + photo metadata + rental-grid count (extract.js `report`) — persisted so the
  // note-buyer appraisal checks (EMCAP interior photos / 1007 evidence) can re-run off STORED data
  // when the note buyer changes after import, without re-parsing the XML.
  if (A.report) {
    if (Array.isArray(A.report.forms) && A.report.forms.length) put('report.forms', A.report.forms);
    if (Array.isArray(A.report.images) && A.report.images.length) put('report.images', A.report.images);
    if (A.report.rentalGrids != null) put('report.rentalGrids', A.report.rentalGrids);
  }
  return out;
}

/**
 * WHICH VERSION OF THE COMPARABLE-GRID PARSER WROTE A REPORT'S COMP ROWS.
 *
 * The distinction from `research/ingest.js`'s `INGEST_VERSION` is the one that
 * decides whether a fix reaches the back book, and db/426 got it wrong:
 *
 *   * `INGEST_VERSION` re-reads a REPORT into the warehouse — but
 *     `ingestAppraisal` reads the STORED `appraisals` and `appraisal_comparables`
 *     rows, so it faithfully re-reads whatever the parser wrote. It heals a
 *     WAREHOUSE bug and can do nothing at all about a PARSER bug.
 *   * this heals a PARSER bug: a current report behind this version has its
 *     source XML re-parsed at boot and its comparable rows rewritten.
 *
 * BUMP THIS whenever `compGrid` (or anything `comparableRowFrom` reads) starts
 * producing a different answer for the same XML.
 */
// 1 — the room counts on a 2-4 unit grid (db/426: unit 1's numbers were filed as
//     the property's), and the price per foot + its basis (db/427: a 1025 states
//     it under the gross-BUILDING-area attribute, which was never read).
const COMP_PARSE_VERSION = 1;

module.exports = {
  importAppraisal,
  // Shared with the research warehouse's standalone XML upload (db/411) so one
  // report is read the same way whichever door it arrives through.
  appraisalRowFrom, comparableRowFrom, COMP_PARSE_VERSION,
  _internals: { marketMonthlyRent, fillFileFacts },
};

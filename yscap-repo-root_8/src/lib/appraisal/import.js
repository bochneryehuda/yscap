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

async function importAppraisal(db, {
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
      `SELECT id, property_address, property_type, units, purchase_price, as_is_value, arv
         FROM applications WHERE id = $1`, [applicationId]);
    f = r.rows[0] || {};
  }

  // 1. supersede prior appraisals AND their still-open findings on this file, so a
  //    re-import doesn't leave stale findings inflating the open-count / blocksCtc summary.
  await db.query(`UPDATE appraisals SET superseded = true WHERE application_id = $1 AND superseded = false`, [applicationId]);
  await db.query(`UPDATE appraisal_findings SET status = 'superseded' WHERE application_id = $1 AND status = 'open'`, [applicationId]);

  // 2. insert the appraisal row
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
    subject_address: s.address, subject_city: s.city, subject_county: s.county, subject_state: s.state, subject_zip: s.zip,
    apn: s.apn, legal_description: s.legal, census_tract: s.censusTract, neighborhood: s.neighborhood,
    property_type: s.propertyType, units: s.units, year_built: s.yearBuilt, gla: s.gla,
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
    fields: JSON.stringify(fieldsJson), warnings: JSON.stringify(A.warnings || []),
    imported_by: importedBy,
  };
  const keys = Object.keys(cols);
  const ins = await db.query(
    `INSERT INTO appraisals (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
    keys.map((k) => cols[k]));
  const appraisalId = ins.rows[0].id;

  // 3. comparables (real comps; seq-0 subject is excluded by the parser)
  if (A.comparables && A.comparables.length) {
    for (const c of A.comparables) {
      await db.query(
        `INSERT INTO appraisal_comparables
           (appraisal_id, seq, is_subject, address, city, state, zip, proximity, sale_price, adjusted_price, net_adjustment, net_adj_pct, gross_adj_pct)
         VALUES ($1,$2,false,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [appraisalId, c.seq, c.address, c.city, c.state, c.zip, c.proximity, c.salePrice, c.adjustedPrice, c.netAdjustment, c.netAdjPct, c.grossAdjPct]);
    }
  }

  // 4. 1025 per-unit rents
  for (const u of A.units || []) {
    await db.query(
      `INSERT INTO appraisal_units (appraisal_id, unit_seq, actual_rent, market_rent) VALUES ($1,$2,$3,$4)`,
      [appraisalId, u.seq, u.actualRent, u.marketRent]);
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
  for (const fd of findings) {
    await db.query(
      `INSERT INTO appraisal_findings
         (appraisal_id, application_id, source, code, severity, field, appraisal_value, file_value, title, how_to, blocks_ctc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [appraisalId, applicationId, fd.source, fd.code, fd.severity, fd.field,
       fd.appraisalValue == null ? null : String(fd.appraisalValue),
       fd.fileValue == null ? null : String(fd.fileValue),
       fd.title, fd.howTo, !!fd.blocksCtc]);
  }
  const sum = summarize(findings);

  // 7. fill the file from DEFINITE values ONLY, ONLY when currently empty (overwrite-shield).
  //    A differing human value is never overwritten — it is one of the findings above.
  if (v.asIs != null && v.asIsConfidence === 'definite') {
    await db.query(`UPDATE applications SET as_is_value = $2 WHERE id = $1 AND as_is_value IS NULL`, [applicationId, v.asIs]);
  }
  if (v.arv != null && v.arvConfidence === 'definite') {
    await db.query(`UPDATE applications SET arv = $2 WHERE id = $1 AND arv IS NULL`, [applicationId, v.arv]);
  }
  // Fill the file's appraiser name (blank-only) so the MISMO 3.4 loan export
  // (src/lib/mismo) carries the real appraiser — synergy, same overwrite-shield posture.
  if (ap.name) {
    await db.query(`UPDATE applications SET appraiser_name = $2 WHERE id = $1 AND (appraiser_name IS NULL OR appraiser_name = '')`, [applicationId, ap.name]);
  }

  return {
    ok: true, appraisalId, findings, summary: sum,
    needsAsIsCondition: !(v.asIs != null && v.asIsConfidence === 'definite'),
    blocksCtc: sum.blocksCtc,
    warnings: A.warnings || [],
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
  return out;
}

module.exports = { importAppraisal };

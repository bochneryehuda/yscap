'use strict';
/**
 * File-level underwriting review helpers shared between the underwriting ROUTE and the checklist
 * SIGN-OFF GATE (src/routes/staff.js), so the clear-to-close gate the desk shows and the gate that
 * actually blocks signing off the `underwriting_review_cleared` condition are computed the SAME
 * way and can never disagree.
 *
 *   tieoutForFile   — the data-comparison over the file's current extractions + the appraisal.
 *   fileFatalCount  — how many blocking FATAL findings are open on the file: the stored
 *                     per-document fatals (document_findings) PLUS the derived tie-out fatals
 *                     (which have no stored row but still block). This is the gate.
 */
const fileView = require('./file-view');
const { buildTieout } = require('./tieout');

async function tieoutForFile(client, appId, preloadedCtx) {
  // Callers that already loaded the file context (the desk GET) pass it to avoid a second load;
  // the sign-off gate calls without it and loads its own. Same result either way.
  const ctx = preloadedCtx || await fileView.loadContext(client, appId);
  const { rows } = await client.query(
    `SELECT id, document_id, doc_type, fields FROM document_extractions WHERE application_id=$1 AND is_current`, [appId]);
  // Contract amendments deliberately carry no tie-out facts (their values are conditional overrides
  // resolved by amendments.js into the GOVERNING terms, not direct claims to compare) — exclude
  // them so the matrix doesn't show an all-blank amendment column.
  const sources = rows.filter((e) => e.doc_type !== 'contract_amendment')
    .map((e) => ({ id: e.id, docType: e.doc_type, fields: e.fields }));

  // Fold in the appraisal (its own table) so the WHOLE appraisal ties into the matrix — not just
  // address/price/value, but the collateral physicals the appraiser is the authority on (units,
  // property type, occupancy, year built, living area, 1007 market rent), so they cross-check the
  // application (owner-directed 2026-07-21: "pull every fact from every document into the comparison").
  // The physicals live on the appraisals row (units/property_type/occupancy_status/year_built/gla);
  // the 1007 market rent lives per-unit on the appraisal_units child, so we sum it for the property.
  // (occupancy is stored as occupancy_status — canonOccupancy maps its Vacant/TenantOccupied/
  // OwnerOccupied values; there is no `sqft`/`market_rent` column on appraisals — see db/137/158.)
  const appr = (await client.query(
    `SELECT a.subject_address, a.subject_city, a.subject_state, a.subject_zip, a.contract_price, a.as_is_value, a.arv_value,
            a.units, a.property_type, a.occupancy_status AS occupancy, a.year_built, a.gla,
            (SELECT sum(u.market_rent) FROM appraisal_units u WHERE u.appraisal_id = a.id) AS market_rent
       FROM appraisals a WHERE a.application_id=$1 AND a.superseded=false ORDER BY a.imported_at DESC LIMIT 1`, [appId])).rows[0];
  if (appr) {
    sources.push({
      id: 'appraisal', docType: 'appraisal',
      fields: {
        propertyAddress: appr.subject_address ? { line1: appr.subject_address, city: appr.subject_city, state: appr.subject_state, zip: appr.subject_zip } : null,
        contractPrice: appr.contract_price, asIsValue: appr.as_is_value, arvValue: appr.arv_value,
        units: appr.units, propertyType: appr.property_type, occupancy: appr.occupancy,
        yearBuilt: appr.year_built, gla: appr.gla, marketRent: appr.market_rent,
      },
    });
  }
  return buildTieout(ctx || {}, sources);
}

/**
 * Count the open, blocking FATAL findings on a file — stored (document_findings) + derived
 * (tie-out). Returns { stored, tieout, total }. `total > 0` blocks clear-to-close.
 * @param {import('pg').ClientBase} client  a pg client/pool (must expose .query)
 */
async function fileFatalCount(client, appId) {
  const stored = (await client.query(
    `SELECT count(*)::int AS n FROM document_findings
      WHERE application_id=$1 AND status='open' AND severity='fatal' AND blocks_ctc=true`, [appId])).rows[0].n;
  let tieout = 0;
  try {
    const to = await tieoutForFile(client, appId);
    tieout = to.discrepancies.filter((f) => f.severity === 'fatal' && f.blocksCtc).length;
  } catch (_) { /* tie-out is best-effort; stored fatals still gate */ }
  // Experience dealbreakers (a heavy/ground-up deal with no verified comparable anchor) block CTC
  // the SAME way — derived live, no stored row, so this covers previous AND future files. Best-effort:
  // a compute error must never silently OPEN the gate, so a failure just leaves it uncounted.
  let experience = 0;
  try {
    const { assessExperienceForFile } = require('./experience');
    const exp = await assessExperienceForFile(client, appId, { today: new Date().toISOString().slice(0, 10) });
    experience = exp ? exp.findings.filter((f) => f.severity === 'fatal' && f.blocksCtc).length : 0;
  } catch (_) { /* experience is best-effort; stored + tie-out fatals still gate */ }
  return { stored, tieout, experience, total: stored + tieout + experience };
}

/**
 * The DETAILS behind the fatal count — the actual finding titles + what disagrees, so a
 * surface (e.g. the clear-to-close "what's left" list) can tell staff WHAT the dealbreaker
 * is instead of just "N open dealbreaker finding". Same three sources as fileFatalCount
 * (stored document_findings + derived tie-out + derived experience), normalized to
 * { title, docValue, fileValue, howTo }. Best-effort per source; a compute error just
 * yields fewer detail rows (the count gate still holds independently).
 */
async function fileFatalDetails(client, appId) {
  const out = [];
  try {
    const stored = (await client.query(
      `SELECT title, doc_value, file_value, how_to FROM document_findings
        WHERE application_id=$1 AND status='open' AND severity='fatal' AND blocks_ctc=true
        ORDER BY created_at`, [appId])).rows;
    for (const f of stored) out.push({ title: f.title || 'Document finding', docValue: f.doc_value, fileValue: f.file_value, howTo: f.how_to });
  } catch (_) { /* stored is best-effort here (the count query already gates) */ }
  try {
    const to = await tieoutForFile(client, appId);
    for (const d of to.discrepancies.filter((f) => f.severity === 'fatal' && f.blocksCtc))
      out.push({ title: d.title, docValue: d.docValue, fileValue: d.fileValue, howTo: d.howTo });
  } catch (_) { /* tie-out is best-effort */ }
  try {
    const { assessExperienceForFile } = require('./experience');
    const exp = await assessExperienceForFile(client, appId, { today: new Date().toISOString().slice(0, 10) });
    for (const f of (exp ? exp.findings : []).filter((f) => f.severity === 'fatal' && f.blocksCtc))
      out.push({ title: f.title, howTo: f.howTo });
  } catch (_) { /* experience is best-effort */ }
  return out;
}

module.exports = { tieoutForFile, fileFatalCount, fileFatalDetails };

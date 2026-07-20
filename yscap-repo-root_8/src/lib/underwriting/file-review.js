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
  const sources = rows.map((e) => ({ id: e.id, docType: e.doc_type, fields: e.fields }));

  // Fold in the appraisal (its own table) so property/price/value tie into the matrix too.
  const appr = (await client.query(
    `SELECT subject_address, subject_city, subject_state, subject_zip, contract_price, as_is_value, arv_value
       FROM appraisals WHERE application_id=$1 AND superseded=false ORDER BY imported_at DESC LIMIT 1`, [appId])).rows[0];
  if (appr) {
    sources.push({
      id: 'appraisal', docType: 'appraisal',
      fields: {
        propertyAddress: appr.subject_address ? { line1: appr.subject_address, city: appr.subject_city, state: appr.subject_state, zip: appr.subject_zip } : null,
        contractPrice: appr.contract_price, asIsValue: appr.as_is_value, arvValue: appr.arv_value,
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
  return { stored, tieout, total: stored + tieout };
}

module.exports = { tieoutForFile, fileFatalCount };

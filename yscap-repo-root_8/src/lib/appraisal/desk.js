'use strict';
/**
 * Appraisal-desk shared flow — the ONE place that turns an appraisal XML string into a stored
 * appraisal + PILOT findings + the two internal conditions + the advisory OCR note. Both the
 * staff appraisal route (POST /api/appraisal/:id/import) AND the appraisal-documents condition
 * (an XML dropped on its "Appraisal data file (XML)" slot auto-imports) call this, so the import
 * behaves identically no matter where the file comes from.
 *
 * Never overwrites the loan file (the blank-only shield lives in importAppraisal); the advisory
 * OCR only ever writes the verify-As-Is condition note. Materializing the two conditions uses the
 * canonical template_id insert (mirrors src/lib/vesting.js) — the templates are auto_apply='manual'
 * so they only attach here, on demand.
 */
const db = require('../../db');
const { importAppraisal } = require('./import');
const { ocrAsIsCandidate, buildOcrNote } = require('./ocr');
const X = require('./xml');

// Today as a 'YYYY-MM-DD' string from the DB (NY) — never new Date() in a date path.
async function todayNY() {
  try { return (await db.query(`SELECT to_char(now() AT TIME ZONE 'America/New_York','YYYY-MM-DD') d`)).rows[0].d; }
  catch (_) { return null; }
}

// Materialize an internal appraisal condition from its (auto_apply='manual') template. Idempotent
// — dedups on (application_id, template_id), exactly like src/lib/vesting.js ensureLlcCondition.
async function ensureAppraisalCondition(appId, code) {
  await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
        phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
        clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
     SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
            COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
            COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
            COALESCE(t.sort_order,455), t.tool_key, t.clickup_field_id,
            COALESCE(t.tpr_exclude,false), 'system', COALESCE(t.is_required,true), $1
       FROM checklist_templates t
      WHERE t.code=$2 AND t.is_active=true
        AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id=$1 AND ci.template_id=t.id)`,
    [appId, code]);
}

// Fire-and-forget advisory OCR: read a candidate As-Is off the PDF and attach it to the
// verify-As-Is condition as an [auto]-guarded note. Never writes the loan file, never throws.
function fireOcrAdvisory(appId, pdfB64, importedBy) {
  if (!pdfB64) return;
  ocrAsIsCandidate({ pdfBase64: pdfB64 })
    .then(async (adv) => {
      await db.query(
        `UPDATE checklist_items ci
            SET notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%' THEN $2 ELSE ci.notes END
           FROM checklist_templates t
          WHERE ci.template_id = t.id AND t.code = 'appraisal_as_is_verify' AND ci.application_id = $1`,
        [appId, buildOcrNote(adv)]);
      if (importedBy) {
        try {
          await db.query(
            `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
             VALUES ('staff',$1,'appraisal_ocr_advisory','application',$2,$3)`,
            [importedBy, appId, JSON.stringify({ attempted: !!adv.attempted, candidate: adv.candidate != null ? adv.candidate : null, confidence: adv.confidence || null })]);
        } catch (_) { /* audit best-effort */ }
      }
    })
    .catch((e) => console.error('[appraisal] OCR advisory failed (non-fatal):', e && e.message));
}

/**
 * Run the full desk import from an XML string. Returns importAppraisal's result
 * ({ ok, appraisalId, summary, needsAsIsCondition, warnings, ... } or { ok:false, error }).
 * @param {{appId:string, xml:string, importedBy?:string, xmlDocumentId?:string,
 *          pdfDocumentId?:string, pdfBase64?:string, today?:string}} args
 */
async function runAppraisalImport(args) {
  const { appId, xml, importedBy, xmlDocumentId, pdfDocumentId, pdfBase64 } = args;
  const out = await importAppraisal(db, {
    applicationId: appId, xml, importedBy: importedBy || null,
    sourceXmlDocumentId: xmlDocumentId || null, pdfDocumentId: pdfDocumentId || null,
    today: args.today || (await todayNY()),
  });
  if (!out.ok) return out;
  await ensureAppraisalCondition(appId, 'appraisal_review_cleared');
  if (out.needsAsIsCondition) {
    await ensureAppraisalCondition(appId, 'appraisal_as_is_verify');
    let embedded = null; try { embedded = X.embeddedPdfBase64(xml); } catch (_) { embedded = null; }
    fireOcrAdvisory(appId, pdfBase64 || embedded, importedBy);
  }
  return out;
}

module.exports = { ensureAppraisalCondition, runAppraisalImport, todayNY };

'use strict';
/**
 * WHAT COUNTS AS AN "APPRAISAL FINDING" — one definition, used by every surface
 * (owner-directed 2026-08-02: "make sure that the appraisal findings page has ALL the appraisal
 * findings and not some of the appraisal findings is going over to the document findings section").
 *
 * The 2026-07-30 rule split the two desks BY TABLE — everything in `appraisal_findings` renders on
 * the Appraisal tab, nothing from `document_findings` does. That was necessary and not sufficient:
 * several desks that write to the DOCUMENT side are ALSO reading the appraisal, so findings whose
 * only evidence is the appraisal report kept landing on the document-review desk:
 *
 *   1. THE TIE-OUT DUPLICATED THE APPRAISAL DESK, FACT FOR FACT. `tieout.js` carries the appraisal
 *      as a comparison source, and `PERDOC_COVERS` (its "a dedicated per-document check already
 *      raises this one" suppression list) had no entry for it — while `lib/appraisal/findings.js`
 *      compares exactly those facts appraisal-vs-file and raises its own finding. So an appraisal
 *      whose ARV disagreed with the file produced TWO cards in two places: `arv_mismatch` on the
 *      Appraisal tab and `tieout_arv` ("After-repair value doesn't match the file — Appraisal") in
 *      Document review. Same fact, two desks, and resolving the appraisal one left the other
 *      standing. `APPRAISAL_DESK_FACTS` below is that missing suppression entry.
 *   2. THE AVM CONSENSUS ("AVM consensus disagrees with the appraisal ARV") is a judgement about
 *      the appraised value. It is stored in `document_findings`, so it rendered on the document
 *      desk — the one place an underwriter reviewing the appraisal would not look.
 *   3. ANY REMAINING TIE-OUT ROW WHOSE ONLY DISAGREEING DOCUMENT IS THE APPRAISAL (occupancy, and
 *      anything a future fact adds) is an appraisal-vs-file disagreement wearing a document-desk
 *      label.
 *
 * The rule this module encodes: a finding belongs on the Appraisal page when THE APPRAISAL IS THE
 * EVIDENCE. A conflict between the appraisal and ANOTHER DOCUMENT stays on the document desk —
 * that is a cross-document reconciliation, which is what that desk is for, and moving it would
 * hide half of the disagreement from the people working the other document.
 *
 * Pure, dependency-free, never throws — it is called inside display paths and a sign-off gate.
 */

/**
 * The facts `lib/appraisal/findings.js` already compares appraisal-vs-file and raises its OWN
 * finding for. Fed to `tieout.js` PERDOC_COVERS so the tie-out never raises the duplicate.
 * Keep this list in step with computeFindings(): every entry must name a real finding there.
 *   property_address → address_mismatch
 *   purchase_price   → price_mismatch
 *   as_is_value      → asis_mismatch (+ asis_below_price)
 *   arv              → arv_mismatch
 *   units            → units_mismatch
 *   property_type    → property_type_mismatch / property_style_note
 * NOT listed, on purpose: seller_name (the appraisal's owner-of-record vs the CONTRACT's seller is
 * a cross-document reconciliation — chain-of-title's job; db/402 gave the file its own seller, so
 * that reconciliation now runs against a value of record, but it is still cross-document and still
 * belongs on the document desk), and year_built / living_area / market_rent, which db/402 also put
 * on the file but marked `noFlag` in facts.js — they are shown in the comparison and never raise a
 * finding on either desk, so there is no duplicate to suppress.
 */
const APPRAISAL_DESK_FACTS = Object.freeze([
  'property_address', 'purchase_price', 'as_is_value', 'arv', 'units', 'property_type',
]);

/**
 * `document_findings.source` values whose evidence IS the appraisal report.
 * `appraisal` / `appraisal_revision` are the document-type sources (the staleness board keys its
 * findings on the doc type, and a future per-doc appraisal check would land here too);
 * `avm_consensus` is the AVM-vs-appraised-value panel.
 */
const APPRAISAL_SOURCES = Object.freeze(new Set(['appraisal', 'appraisal_revision', 'avm_consensus']));

// The tie-out's own source string.
const TIE_OUT = 'tie_out';

function str(v) { return v == null ? '' : String(v); }

/**
 * A tie-out discrepancy is an APPRAISAL finding only when the appraisal is the one and only
 * DOCUMENT on the disagreeing side. (`sources[]` also carries the loan file itself with
 * kind 'file' — that is the thing being disagreed WITH, not a disagreeing party.)
 *
 * Requires `docType` on the source entries; a legacy/derived row without it is treated as NOT
 * appraisal-only, so the finding stays where it already renders. Fails toward the document desk on
 * purpose: showing a finding in its old home is a cosmetic miss, dropping it from both is not.
 */
function tieOutIsAppraisalOnly(f) {
  const sources = Array.isArray(f && f.sources) ? f.sources : null;
  if (!sources || !sources.length) return false;
  const docs = sources.filter((s) => s && s.kind !== 'file');
  if (!docs.length) return false;
  return docs.every((s) => str(s.docType).toLowerCase() === 'appraisal');
}

/**
 * Does this finding belong on the Appraisal findings page?
 * Accepts a finding in ANY of the repo's shapes (a stored `document_findings` row, a derived desk
 * object, a decorated response row) — it only ever reads `source` and `sources`.
 */
function isAppraisalSubject(f) {
  if (!f) return false;
  const source = str(f.source).toLowerCase();
  if (!source) return false;
  if (APPRAISAL_SOURCES.has(source)) return true;
  if (source === TIE_OUT) return tieOutIsAppraisalOnly(f);
  return false;
}

/**
 * Split a mixed list into the two desks. Returns `{ appraisal, document }`, both in the input's
 * original order, and never mutates the input.
 */
function split(list) {
  const appraisal = [], document = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (isAppraisalSubject(f)) appraisal.push(f); else document.push(f);
  }
  return { appraisal, document };
}

/** SQL fragment for the appraisal-sourced `document_findings` rows (the stored half). */
const APPRAISAL_SOURCE_LIST = Object.freeze([...APPRAISAL_SOURCES]);

module.exports = {
  APPRAISAL_DESK_FACTS, APPRAISAL_SOURCES, APPRAISAL_SOURCE_LIST,
  isAppraisalSubject, split, _internals: { tieOutIsAppraisalOnly },
};

'use strict';
/**
 * Document ↔ CONDITION mapping — the bridge that ties the underwriting engine to the file's
 * actual condition checklist, so "every document ties out and is underwritten correctly to our
 * system" is concrete: each document type points at the checklist condition(s) it provides
 * evidence for, and the engine can tell the underwriter, per condition, whether the document is
 * in, was read, ties out, and is ready to clear — or is blocked by a finding.
 *
 * Codes are the real checklist_templates codes (both the RTL set and the legacy/DSCR set) so the
 * mapping connects on either track. A code that isn't present on a given file simply doesn't match
 * — the mapping is advisory and never invents a condition. Nothing here signs off a condition
 * automatically; clearing a condition stays an explicit human action (the engine only shows
 * readiness). Pure + dependency-free.
 */

// docType → { satisfies: [checklist codes it supports], purpose: what it proves }.
const DOC_CONDITIONS = {
  government_id: { satisfies: ['rtl_p1_id', 'gov_id'], purpose: 'Verifies the borrower’s identity — name, date of birth, and address.' },
  purchase_contract: { satisfies: ['rtl_p1_contract', 'purchase_contract'], purpose: 'The executed purchase & sale contract — price, parties, property, and (if any) the assignment.' },
  assignment: { satisfies: ['rtl_p5_assign'], purpose: 'The assignment of contract — makes the borrowing entity the buyer of record and shows the assignment fee.' },
  title: { satisfies: ['rtl_cond_title', 'title_commitment'], purpose: 'The title commitment — who owns the property, liens to clear, and the vesting entity.' },
  insurance: { satisfies: ['rtl_cond_insurance', 'insurance_binder'], purpose: 'Evidence of insurance — the lender’s mortgagee clause, coverage, and the named insured entity.' },
  flood: { satisfies: ['rtl_cond_insurance'], purpose: 'The flood determination (and flood policy if the property is in a flood zone).' },
  llc_formation: { satisfies: ['rtl_llc_formation', 'rtl_p1_llc', 'llc_docs'], purpose: 'The entity’s Articles of Organization — proves the borrowing entity legally exists.' },
  operating_agreement: { satisfies: ['rtl_llc_opagmt', 'rtl_p1_llc', 'operating_agmt'], purpose: 'The operating agreement — who controls the entity and is authorized to sign.' },
  ein_letter: { satisfies: ['rtl_llc_ein', 'rtl_p1_llc'], purpose: 'The IRS EIN letter — the entity’s federal tax ID and exact legal name.' },
  good_standing: { satisfies: ['rtl_llc_goodstanding', 'rtl_p1_llc'], purpose: 'The certificate of good standing — the entity is active and may legally close.' },
  bank_statement: { satisfies: ['rtl_p3_assets', 'bank_statements'], purpose: 'Bank statements — liquidity / proof of funds, and that the funds are the borrower’s.' },
  credit_report: { satisfies: ['rtl_cond_credit', 'rtl_p3_credit'], purpose: 'The credit report — FICO, derogatories, and undisclosed liabilities.' },
  background_report: { satisfies: ['rtl_cond_fraud'], purpose: 'The background / OFAC / fraud screen — sanctions and integrity check.' },
  appraisal: { satisfies: ['rtl_cond_appraisaldocs'], purpose: 'The appraisal — the property valuation the loan is sized on (handled by the appraisal desk).' },
  settlement: { satisfies: [], purpose: 'The closing settlement statement — the final sources & uses (reviewed at closing).' },
};

function conditionsForDoc(docType) { return (DOC_CONDITIONS[docType] && DOC_CONDITIONS[docType].satisfies) || []; }
function purposeForDoc(docType) { return (DOC_CONDITIONS[docType] && DOC_CONDITIONS[docType].purpose) || null; }

// Readiness of ONE analyzed document from its (open) findings:
//   'blocked' — an open fatal finding (must resolve before the condition can clear)
//   'issues'  — open warnings only (review, but not a hard block)
//   'clean'   — nothing open; the document ties out and the condition is ready to clear
function docReadiness(findings) {
  const open = (findings || []).filter((f) => (f.status || 'open') === 'open');
  if (open.some((f) => f.severity === 'fatal')) return 'blocked';
  if (open.some((f) => f.severity === 'warning')) return 'issues';
  return 'clean';
}

/**
 * File-level condition coverage — for each condition that a document can satisfy, report whether a
 * document is analyzed for it and its readiness. Pure; the caller supplies the file's conditions
 * (from checklist_items), the analyzed extractions, and the open findings.
 *
 * @param {object} args
 *   conditions  [{ code, label }]         — the file's checklist items
 *   extractions [{ doc_type, document_id }] — current analyzed documents
 *   findings    [{ source, severity, status, document_id }] — open findings
 * @returns {Array<{ code, label, docTypes, analyzed, readiness }>}
 */
function fileConditionCoverage({ conditions = [], extractions = [], findings = [] } = {}) {
  // condition code → doc types that satisfy it.
  const byCode = new Map();
  for (const [docType, m] of Object.entries(DOC_CONDITIONS)) {
    for (const code of m.satisfies) {
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(docType);
    }
  }
  const analyzedByType = new Map();
  for (const e of extractions) {
    if (!analyzedByType.has(e.doc_type)) analyzedByType.set(e.doc_type, []);
    analyzedByType.get(e.doc_type).push(e);
  }
  const out = [];
  for (const c of conditions) {
    const docTypes = byCode.get(c.code);
    if (!docTypes) continue; // this condition isn't one the engine reads a document for
    const analyzedTypes = docTypes.filter((t) => analyzedByType.has(t));
    let readiness = 'not_analyzed';
    if (analyzedTypes.length) {
      // Findings from any document of a satisfying type.
      const rel = findings.filter((f) => docTypes.indexOf(f.source) !== -1 && (f.status || 'open') === 'open');
      readiness = docReadiness(rel);
    }
    out.push({ code: c.code, label: c.label || c.code, docTypes, analyzed: analyzedTypes.length > 0, analyzedTypes, readiness });
  }
  return out;
}

module.exports = { DOC_CONDITIONS, conditionsForDoc, purposeForDoc, docReadiness, fileConditionCoverage };

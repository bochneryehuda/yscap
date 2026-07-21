'use strict';
/**
 * The underwriting DATA-COMPARISON engine — the "tie-out matrix" the owner asked for. It takes
 * the loan file plus every analyzed document and, for each canonical fact (facts.js), compares:
 *   - the loan file value  (source of truth for the registered deal), AND
 *   - every document that carries the fact  (against the file AND against each other),
 * producing (1) a MATRIX (facts down the side, documents across the top, each cell agree /
 * disagree / missing / n-a) and (2) DISCREPANCY findings for every disagreement — exactly the
 * stare-and-compare a human underwriter does, and the discrepancy view Ocrolus/Candor surface.
 *
 * Pure. Input:
 *   fileCtx  — from file-view.loadContext ({ app, borrower, vestingName, ein, entityNames })
 *   sources  — [{ id, docType, fields, label? }] built from the file's current extractions
 *              (+ the appraisal, normalized to docType 'appraisal')
 * Output: { columns, matrix, discrepancies, summary }
 */
const { FACTS, factMatch, display, present, claimsFor, carries } = require('./facts');

const LABEL = {
  government_id: 'ID', purchase_contract: 'Purchase contract', title: 'Title report', appraisal: 'Appraisal',
  bank_statement: 'Bank statement', assignment: 'Assignment of contract', insurance: 'Insurance', insurance_invoice: 'Insurance invoice',
  operating_agreement: 'Operating agreement', ein_letter: 'EIN letter', good_standing: 'Good standing',
  llc_formation: 'Formation docs', credit_report: 'Credit report', settlement: 'Settlement statement',
  flood: 'Flood cert', payoff_statement: 'Payoff statement', scope_of_work: 'Scope of work',
  signed_term_sheet: 'Signed term sheet', signed_application: 'Signed application', investor_structure: 'Investor structure',
};
const lbl = (t) => LABEL[t] || String(t || '').replace(/_/g, ' ');

function finding(f) {
  return Object.assign({
    source: 'tie_out', status: 'open',
    blocksCtc: f.severity === 'fatal',
    actions: ['post_condition', 'request_document', 'fix_file', 'grant_exception', 'dismiss', 'decline'],
    opensCondition: 'underwriting_review_cleared',
  }, f);
}

// Facts a dedicated per-document check already compares against the FILE and raises its own
// (stored) finding for — so the tie-out must NOT raise a second, duplicate discrepancy for the
// same document+fact. The tie-out still shows the disagreement in the MATRIX and still owns every
// doc-vs-doc conflict + every fact/document a per-doc check doesn't cover (e.g. the settlement's
// price, the appraisal's value). Keyed by docType → the fact keys that document's check covers.
const PERDOC_COVERS = {
  purchase_contract: ['property_address', 'purchase_price', 'entity_name'],
  government_id: ['borrower_name', 'borrower_dob', 'borrower_address'],
  title: ['property_address'],
  bank_statement: ['entity_name', 'borrower_name'],
  scope_of_work: ['rehab_budget'],   // the SOW per-doc check owns rehab_budget_mismatch
  payoff_statement: ['property_address'],   // the payoff per-doc check owns payoff_address_mismatch (vs file)
};
// The contract check compares assignment_fee / underlying_price ONLY when the file is flagged an
// assignment (purchase-contract-checks guards them behind is_assignment). So the tie-out may only
// suppress those two when the file IS an assignment — otherwise the tie-out must still catch a
// stale-value mismatch the contract check skipped.
const PERDOC_COVERS_ASSIGNMENT = { purchase_contract: ['assignment_fee', 'underlying_price'] };
function perDocCovers(docType, factKey, isAssignment) {
  if ((PERDOC_COVERS[docType] || []).indexOf(factKey) !== -1) return true;
  if (isAssignment && (PERDOC_COVERS_ASSIGNMENT[docType] || []).indexOf(factKey) !== -1) return true;
  return false;
}

// The agreed value among a set of present document claims for one fact: if every pair matches,
// the consensus (first) value; if any pair disagrees, null (a genuine cross-document conflict).
function consensus(kind, claims) {
  const vals = claims.filter((c) => present(c.value));
  if (!vals.length) return { value: null, conflict: false };
  for (let i = 0; i < vals.length; i++) {
    for (let j = i + 1; j < vals.length; j++) {
      if (factMatch(kind, vals[i].value, vals[j].value) === false) return { value: null, conflict: true };
    }
  }
  return { value: vals[0].value, conflict: false };
}

function buildTieout(fileCtx, sources = []) {
  const ctx = fileCtx || {};
  const isAssignment = !!(ctx.app && ctx.app.is_assignment);
  const srcs = (sources || []).filter((s) => s && s.docType).map((s, i) => ({
    id: s.id || `${s.docType}_${i}`, docType: s.docType, label: s.label || lbl(s.docType),
    claims: claimsFor(s.docType, s.fields),
  }));

  const columns = [{ id: 'file', label: 'Loan file', kind: 'file' }]
    .concat(srcs.map((s) => ({ id: s.id, label: s.label, docType: s.docType })));

  const matrix = [];
  const discrepancies = [];

  for (const fact of FACTS) {
    const fileVal = fact.file(ctx);
    const fileHas = present(fileVal);
    const claims = srcs.map((s) => ({ id: s.id, label: s.label, docType: s.docType, value: s.claims[fact.key] }));
    const withVal = claims.filter((c) => present(c.value));

    // Truth = the file value if the file stores this fact, else the documents' consensus.
    const cons = consensus(fact.kind, claims);
    const truth = fileHas ? fileVal : cons.value;
    // A meaningful comparison needs a reference OTHER than the value itself: the file value, or
    // more than one document. A lone document with no file value can't "agree" with anything.
    const hasRef = fileHas || withVal.length > 1;
    const conflictNoTruth = !fileHas && cons.conflict; // documents disagree and there's no file truth

    // Build the row cells (file + each document).
    const cells = [{ source: 'file', label: 'Loan file', status: fileHas ? 'source' : 'na', value: fileHas ? display(fact.kind, fileVal) : null }];
    for (const s of srcs) {
      const v = s.claims[fact.key];
      if (!carries(s.docType, fact.key)) { cells.push({ source: s.id, label: s.label, status: 'na', value: null }); continue; }
      if (!present(v)) { cells.push({ source: s.id, label: s.label, status: 'missing', value: null }); continue; }
      let status = 'noref';
      if (conflictNoTruth) { status = 'disagree'; }               // docs disagree, no file anchor → flag each
      else if (hasRef && present(truth)) { const m = factMatch(fact.kind, truth, v); status = m === true ? 'agree' : m === false ? 'disagree' : 'unknown'; }
      cells.push({ source: s.id, label: s.label, status, value: display(fact.kind, v) });
    }

    // Row status.
    const anyDisagree = cells.some((c) => c.status === 'disagree') || cons.conflict;
    const rowStatus = anyDisagree ? 'mismatch'
      : (withVal.length === 0 ? 'none'
        : (fileHas || withVal.length > 1 ? 'ok' : 'single'));
    matrix.push({ key: fact.key, label: fact.label, category: fact.category, severity: fact.severity, fileValue: cells[0].value, status: rowStatus, cells });

    // Discrepancy findings.
    if (fileHas) {
      // A source whose own per-document check already compares this fact to the file is EXCLUDED
      // here — that mismatch is raised once by the per-doc check; the tie-out avoids the duplicate
      // (the matrix cell still shows the disagreement). Sources with no dedicated check stay.
      const bad = withVal.filter((c) => factMatch(fact.kind, fileVal, c.value) === false && !perDocCovers(c.docType, fact.key, isAssignment));
      if (bad.length) {
        discrepancies.push(finding({
          code: `tieout_${fact.key}`, severity: fact.severity, field: fact.key,
          docValue: bad.map((c) => `${display(fact.kind, c.value)} (${c.label})`).join('; '),
          fileValue: display(fact.kind, fileVal),
          title: `${fact.label} doesn't match the file`,
          howTo: `The loan file shows ${display(fact.kind, fileVal)}, but the ${bad.map((c) => c.label).join(', ')} show${bad.length === 1 ? 's' : ''} a different value. Reconcile — a fact that appears on more than one document must agree everywhere.`,
        }));
      }
    } else if (cons.conflict) {
      // No file value (e.g. seller) — the documents themselves disagree.
      discrepancies.push(finding({
        code: `tieout_${fact.key}`, severity: fact.severity, field: fact.key,
        docValue: withVal.map((c) => `${display(fact.kind, c.value)} (${c.label})`).join('; '),
        fileValue: null,
        title: `${fact.label} differs between documents`,
        howTo: `The documents don't agree on the ${fact.label.toLowerCase()}: ${withVal.map((c) => `${c.label} = ${display(fact.kind, c.value)}`).join('; ')}. This must be reconciled — a mismatched ${fact.label.toLowerCase()} across documents is a top fraud/misrepresentation signal.`,
      }));
    }
  }

  // ---- Cross-fact rule: OWNER-OCCUPANCY signal (business-purpose lending) ----
  // The borrower's ID/home address should NOT be the subject property. If it matches, flag it —
  // a business-purpose loan cannot be on the borrower's primary residence.
  const idAddr = firstClaim(srcs, 'government_id', 'borrower_address');
  const propAddr = ctx.app ? ctx.app.property_address : null;
  if (idAddr && propAddr && factMatch('address', idAddr, propAddr) === true) {
    discrepancies.push(finding({
      code: 'occupancy_owner_occupied_flag', severity: 'warning', field: 'occupancy',
      docValue: display('address', idAddr), fileValue: display('address', propAddr),
      title: 'The borrower’s ID address is the subject property',
      howTo: 'The borrower’s ID/home address matches the property being financed. Business-purpose loans cannot be on the borrower’s primary residence — confirm occupancy and business purpose before clear-to-close.',
      actions: ['post_condition', 'request_document', 'grant_exception', 'dismiss', 'decline'],
    }));
  }

  const summary = {
    facts: matrix.length,
    matched: matrix.filter((m) => m.status === 'ok').length,
    mismatched: matrix.filter((m) => m.status === 'mismatch').length,
    fatal: discrepancies.filter((d) => d.severity === 'fatal').length,
    warning: discrepancies.filter((d) => d.severity === 'warning').length,
    info: discrepancies.filter((d) => d.severity === 'info').length,
    blocksCtc: discrepancies.some((d) => d.severity === 'fatal' && d.blocksCtc),
  };

  return { columns, matrix, discrepancies, summary };
}

function firstClaim(srcs, docType, factKey) {
  for (const s of srcs) if (s.docType === docType && present(s.claims[factKey])) return s.claims[factKey];
  return null;
}

module.exports = { buildTieout, _internals: { consensus } };

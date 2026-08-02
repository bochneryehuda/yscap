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
const { num } = require('./compare');
const { gateClaims } = require('./comparison-gate');
const { buildAssignmentChain } = require('./assignment-chain');

// On an ASSIGNMENT deal a document may legitimately report the seller's underlying price OR the
// fee-inclusive total the borrower pays — both tie out to the file. So for the purchase_price fact
// on an assignment file, a document value that matches EITHER the file total OR the seller's
// underlying price is AGREEMENT, not a mismatch (owner-directed 2026-07-24 — this is what fired a
// false tie-out fatal from the appraisal/settlement, which report the seller price). Returns the
// same true/false/null contract as factMatch. Only special-cases purchase_price on an assignment;
// every other fact and a straight purchase are unchanged.
function priceAwareMatch(ctx, kind, factKey, fileVal, docVal) {
  const base = factMatch(kind, fileVal, docVal);
  if (base === true) return true;
  const app = ctx && ctx.app;
  if (factKey === 'purchase_price' && app && app.is_assignment) {
    // The underlying seller price is on file → a document that reports it is AGREEMENT (both the
    // fee-inclusive total and the seller's original price legitimately tie out on an assignment).
    if (num(app.underlying_contract_price) != null) {
      const mUnder = factMatch('money', app.underlying_contract_price, docVal);
      if (mUnder === true) return true;
      // Agreement with neither KNOWN price → a real mismatch; uncomparable (missing) → null.
      if (base === false && mUnder === false) return false;
      return null;
    }
    // The seller's underlying price is NOT yet captured (owner 2026-07-27): the document
    // legitimately shows a price we don't have on file, so we CANNOT call it a mismatch. Never fire
    // the tie-out fatal — return null ("could not confirm"). reasonability.assignment_fields_missing
    // already nudges to capture the seller price + fee, so the price still gets reconciled without a
    // false "purchase price doesn't match" fatal blocking the file.
    return null;
  }
  // A document "assignment fee" that equals the WHOLE purchase price (or the seller's underlying
  // price) is the total MISLABELED as the fee (owner-reported 2026-07-27, a $325k "assignment fee").
  // facts.js already quarantines it when the DOC itself carries the total; this catches the other
  // shape — the doc gives only a fee that matches the FILE's total. Never a mismatch against the real
  // fee on file → null ("could not confirm"), never a false fatal. A plausible fee is unchanged.
  if (factKey === 'assignment_fee' && app) {
    const dv = num(docVal), total = num(app.purchase_price), under = num(app.underlying_contract_price);
    if (dv != null && ((total != null && (dv >= total || Math.abs(dv - total) <= 1)) || (under != null && Math.abs(dv - under) <= 1))) {
      return null;
    }
  }
  return base;
}

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

// The agreed value among a set of present document claims for one fact.
//
// ONLY THE ODD ONE OUT IS THE ODD ONE OUT (owner-reported 2026-08-02). This used to answer "any pair
// disagrees → null", and the caller turned a null truth into `conflictNoTruth`, which marked EVERY
// document in the row as disagreeing. On a file where eight documents name the same seller and ONE
// names a different party, saying all nine disagree is simply not true — it buried the one document
// worth opening under a row of red, and it is what made the Seller row read as nine mismatches.
//
// So the claims are grouped into buckets of mutually-matching values, and when one bucket is
// strictly bigger than every other it becomes the working truth: the documents in it read as
// agreeing and only the dissenters are flagged. A genuine tie (2 vs 2, or 1 vs 1) has no majority to
// stand on, so it still returns null and every claim is flagged — we never invent an answer.
function consensus(kind, claims) {
  const vals = claims.filter((c) => present(c.value));
  if (!vals.length) return { value: null, conflict: false };
  const buckets = [];
  for (const c of vals) {
    const b = buckets.find((x) => factMatch(kind, x.value, c.value) === true);
    if (b) b.members.push(c); else buckets.push({ value: c.value, members: [c] });
  }
  // No DEFINITE disagreement between any two buckets → not a conflict (values that merely can't be
  // compared, e.g. one side blank after normalization, must never read as a mismatch).
  let conflict = false;
  for (let i = 0; i < buckets.length && !conflict; i++) {
    for (let j = i + 1; j < buckets.length; j++) {
      if (factMatch(kind, buckets[i].value, buckets[j].value) === false) { conflict = true; break; }
    }
  }
  if (!conflict) return { value: vals[0].value, conflict: false };
  const sorted = buckets.slice().sort((a, b) => b.members.length - a.members.length);
  // A majority only counts when every OTHER value definitively disagrees with it. Otherwise the
  // minority claims would come back 'unknown' against it, the row would name nobody, and a real
  // conflict between two minority values would go unreported — the gate must never get quieter
  // than it was. A majority we can't judge the rest against falls back to flagging everything.
  const hasMajority = sorted.length > 1 && sorted[0].members.length > sorted[1].members.length
    && sorted.slice(1).every((b) => factMatch(kind, sorted[0].value, b.value) === false);
  return { value: hasMajority ? sorted[0].value : null, conflict: true };
}

function buildTieout(fileCtx, sources = []) {
  const ctx = fileCtx || {};
  const isAssignment = !!(ctx.app && ctx.app.is_assignment);
  const raw = (sources || []).filter((s) => s && s.docType);
  // THE WHOLESALE CHAIN, resolved BEFORE the matrix runs (owner-directed 2026-08-02). On an
  // assignment there is an ORIGINAL SELLER, a FLIPPER in the middle, and an END BUYER — so "the
  // seller" has more than one right answer and the documents legitimately name different parties.
  // The chain says which seller each document is talking about; without it the matrix compared the
  // flipper to the original seller and called a perfectly ordinary wholesale deal a mismatch.
  // Pure, and the chain is keyed on the SAME source ids the columns below use. Wrapped anyway: the
  // tie-out's fatals are what GATE clear-to-close, and a throw here would be swallowed upstream as
  // "no tie-out fatals" — i.e. it would OPEN the gate. A chain we couldn't build degrades to no
  // roles, which is exactly the behaviour this file had before the chain existed.
  let chain = null;
  try { chain = buildAssignmentChain(ctx, raw); } catch (_) { chain = null; }
  const chainRoles = (chain && chain.sellerRoleBySource) || {};
  const srcs = raw.map((s, i) => {
    let claims = claimsFor(s.docType, s.fields);
    // On an ASSIGNMENT / wholesale deal the purchase CONTRACT names the WHOLESALER as its buyer — the
    // entity we actually vest into appears on the ASSIGNMENT (assigneeName), not the underlying
    // contract. Comparing the wholesaler to our vesting LLC is a guaranteed-nonsense fatal "mismatch"
    // on a perfectly normal wholesale deal (owner-reported 2026-07-27, the contract-buyer class), so
    // drop the contract's buyer→entity_name claim here; the assignment's assignee still ties out to
    // the vesting entity, so a genuine wrong final buyer is still caught.
    if (isAssignment && s.docType === 'purchase_contract' && claims && claims.entity_name != null) {
      delete claims.entity_name;
    }
    // The comparison-gate (advisory, reasoning-driven): when a per-document REASONING pass understood
    // that this document names parties on the OPPOSITE side of the deal from a party fact — e.g. a
    // tax certificate filed under the title slot whose only named party is the CURRENT owner (the
    // seller, pre-close) — drop that fact's claim so it is never compared to the vesting entity. This
    // generalizes the assignment-specific delete above to ANY mis-classified document, keyed on the
    // document's actual nature rather than a hardcoded doc-type list. No reasoning / low confidence /
    // same-side → claims untouched, so a file with the reasoning layer OFF is byte-identical.
    if (s.reasoning) claims = gateClaims(claims, s.reasoning).claims;
    return {
      id: s.id || `${s.docType}_${i}`, documentId: s.documentId != null ? s.documentId : null,
      docType: s.docType, label: s.label || lbl(s.docType), claims,
    };
  });

  const columns = [{ id: 'file', label: 'Loan file', kind: 'file' }]
    .concat(srcs.map((s) => ({ id: s.id, label: s.label, docType: s.docType })));

  const matrix = [];
  const discrepancies = [];

  for (const fact of FACTS) {
    const fileVal = fact.file(ctx);
    const fileHas = present(fileVal);
    const claims = srcs.map((s) => ({ id: s.id, documentId: s.documentId, label: s.label, docType: s.docType, value: s.claims[fact.key] }));
    const withVal = claims.filter((c) => present(c.value));

    // ROLE-AWARE SELLER on a wholesale deal (owner-directed 2026-08-02). A flip contract's "seller"
    // IS the flipper — comparing it to the original seller is comparing two different bodies and can
    // only ever produce a nonsense mismatch. So each document is judged against the seller whose role
    // it actually speaks to, and the original-seller consensus is taken over the origin-role
    // documents ONLY. Requires a chain we could actually resolve; with nothing proven every document
    // stays 'origin' and the row behaves exactly as it did before.
    const roleAware = isAssignment && fact.key === 'seller_name'
      && !!chain && (chain.originalSellerNames.length > 0 || chain.flipperNames.length > 0);
    const roleOf = (id) => ((roleAware && chainRoles[id] === 'flipper') ? 'flipper' : 'origin');

    // Truth = the file value if the file stores this fact, else the documents' consensus.
    const cons = consensus(fact.kind, roleAware ? claims.filter((c) => roleOf(c.id) === 'origin') : claims);
    const truth = fileHas ? fileVal : cons.value;
    // A meaningful comparison needs a reference OTHER than the value itself: the file value, or
    // more than one document. A lone document with no file value can't "agree" with anything.
    const hasRef = fileHas || withVal.length > 1;
    // Documents disagree, no file truth AND no majority to stand on → every claim is flagged. With a
    // majority `cons.value` is the working truth, so only the dissenters get marked.
    const conflictNoTruth = !fileHas && cons.conflict && !present(cons.value);
    // A flipper-role document is measured against the flipper, never against the original seller.
    const truthFor = (id) => (roleOf(id) === 'flipper' && chain.flipperNames.length ? chain.flipperNames : truth);
    const hasRefFor = (id) => (roleOf(id) === 'flipper' ? chain.flipperNames.length > 0 : hasRef);

    // Build the row cells (file + each document).
    const cells = [{ source: 'file', label: 'Loan file', status: fileHas ? 'source' : 'na', value: fileHas ? display(fact.kind, fileVal) : null }];
    for (const s of srcs) {
      const v = s.claims[fact.key];
      if (!carries(s.docType, fact.key)) { cells.push({ source: s.id, label: s.label, status: 'na', value: null }); continue; }
      if (!present(v)) { cells.push({ source: s.id, label: s.label, status: 'missing', value: null }); continue; }
      let status = 'noref';
      const t = truthFor(s.id);
      // The origin-side conflict says nothing about a flipper-role document, so it never marks one.
      if (conflictNoTruth && roleOf(s.id) === 'origin') { status = 'disagree'; }
      else if (hasRefFor(s.id) && present(t)) { const m = priceAwareMatch(ctx, fact.kind, fact.key, t, v); status = m === true ? 'agree' : m === false ? 'disagree' : 'unknown'; }
      const cell = { source: s.id, label: s.label, status, value: display(fact.kind, v) };
      if (roleAware) cell.role = roleOf(s.id) === 'flipper' ? 'flipper' : 'original_seller';
      cells.push(cell);
    }

    // Row status. For the purchase_price fact on an assignment, documents legitimately differ
    // (seller's underlying price vs the fee-inclusive total) — the price-aware cell statuses above
    // already flag any GENUINE disagreement, so a raw doc-vs-doc consensus conflict here is not a
    // real mismatch and must not turn the row red.
    const asgPriceFact = fact.key === 'purchase_price' && isAssignment;
    const anyDisagree = cells.some((c) => c.status === 'disagree') || (cons.conflict && !asgPriceFact);
    const rowStatus = anyDisagree ? 'mismatch'
      : (withVal.length === 0 ? 'none'
        : (fileHas || withVal.length > 1 ? 'ok' : 'single'));
    matrix.push({ key: fact.key, label: fact.label, category: fact.category, severity: fact.severity, fileValue: cells[0].value, status: rowStatus, cells });

    // Discrepancy findings.
    if (fileHas) {
      // A source whose own per-document check already compares this fact to the file is EXCLUDED
      // here — that mismatch is raised once by the per-doc check; the tie-out avoids the duplicate
      // (the matrix cell still shows the disagreement). Sources with no dedicated check stay.
      const bad = withVal.filter((c) => priceAwareMatch(ctx, fact.kind, fact.key, fileVal, c.value) === false && !perDocCovers(c.docType, fact.key, isAssignment));
      if (bad.length) {
        discrepancies.push(finding({
          code: `tieout_${fact.key}`, severity: fact.severity, field: fact.key,
          docValue: bad.map((c) => `${display(fact.kind, c.value)} (${c.label})`).join('; '),
          fileValue: display(fact.kind, fileVal),
          title: `${fact.label} doesn't match the file`,
          howTo: `The loan file shows ${display(fact.kind, fileVal)}, but the ${bad.map((c) => c.label).join(', ')} show${bad.length === 1 ? 's' : ''} a different value. Reconcile — a fact that appears on more than one document must agree everywhere.`,
          // The specific sources that disagree — the loan file plus each conflicting
          // document, with its document id so the desk can open them side by side
          // ("this document vs. that document"). documentId is null for the loan
          // file (no PDF) and for the appraisal source (it's its own table).
          sources: [{ kind: 'file', label: 'Loan file', value: display(fact.kind, fileVal), documentId: null }]
            .concat(bad.map((c) => ({ kind: 'document', label: c.label, value: display(fact.kind, c.value), documentId: c.documentId || null }))),
        }));
      }
    } else if (cons.conflict) {
      // No file value (e.g. the seller) — the documents themselves disagree. ONLY THE DOCUMENTS THAT
      // ACTUALLY DISAGREE ARE NAMED (owner-reported 2026-08-02): when eight documents say one thing
      // and one says another, the finding is about the one, not about all nine. The cells already
      // hold that verdict — deriving the list from them is what keeps the matrix and the finding from
      // ever telling two different stories. A genuine tie has no majority, so every claim is named,
      // exactly as before. On a wholesale deal the flipper's documents are judged against the
      // flipper, so they are never dragged into the original seller's disagreement.
      const disagreeIds = new Set(cells.filter((c) => c.status === 'disagree').map((c) => c.source));
      const bad = withVal.filter((c) => disagreeIds.has(c.id));
      const agreed = withVal.filter((c) => !disagreeIds.has(c.id) && roleOf(c.id) === 'origin');
      if (bad.length) {
        const rest = agreed.length
          ? `the ${agreed.map((c) => c.label).join(', ')} show${agreed.length === 1 ? 's' : ''} ${display(fact.kind, cons.value)}`
          : `the other documents disagree`;
        const roleNote = roleAware
          ? ` On this wholesale deal the original seller is ${chain.originalSellerNames.join(', ') || 'not established'}${chain.flipperNames.length ? ` and the wholesaler in the middle is ${chain.flipperNames.join(', ')}` : ''} — this document names neither.`
          : '';
        discrepancies.push(finding({
          code: `tieout_${fact.key}`, severity: fact.severity, field: fact.key,
          docValue: bad.map((c) => `${display(fact.kind, c.value)} (${c.label})`).join('; '),
          fileValue: null,
          title: agreed.length ? `${fact.label} on one document doesn't match the rest` : `${fact.label} differs between documents`,
          howTo: `The ${bad.map((c) => c.label).join(', ')} show${bad.length === 1 ? 's' : ''} ${bad.map((c) => display(fact.kind, c.value)).join('; ')} while ${rest}.${roleNote} This must be reconciled — a mismatched ${fact.label.toLowerCase()} across documents is a top fraud/misrepresentation signal.`,
          // The documents that disagree with each other — "this document vs. that
          // document" — each with its id so the desk can open them side by side. The
          // agreeing side rides along so the reader sees both halves of the comparison.
          sources: bad.map((c) => ({ kind: 'document', label: c.label, value: display(fact.kind, c.value), documentId: c.documentId || null }))
            .concat(agreed.map((c) => ({ kind: 'document', label: c.label, value: display(fact.kind, c.value), documentId: c.documentId || null, agrees: true }))),
        }));
      }
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

  // The chain rides along so the desk shows the SAME resolution the matrix judged the seller by —
  // computed once, so the two can never tell different stories about who the flipper is.
  return { columns, matrix, discrepancies, summary, assignmentChain: chain };
}

function firstClaim(srcs, docType, factKey) {
  for (const s of srcs) if (s.docType === docType && present(s.claims[factKey])) return s.claims[factKey];
  return null;
}

module.exports = { buildTieout, _internals: { consensus } };

'use strict';
/**
 * The canonical FACT registry — the backbone of the underwriting "data comparison" (tie-out).
 *
 * Research finding (mortgage QC / Fannie-Freddie stare-and-compare, Ocrolus/Candor): an
 * underwriter treats the whole file as overlapping CLAIMS about a few real things — one
 * person, one entity, one property, one price, one loan — and flags any place those claims
 * disagree. So we model each underwritable fact ONCE, say how to read it off the loan file,
 * and say which documents can carry it and under which extracted field. The tie-out engine
 * (tieout.js) then compares the file value AND every document that carries the fact, both
 * against the file and against each other.
 *
 * Pure + dependency-light (only compare.js). Adding a new document type to the whole
 * data-comparison is a single entry in DOC_CLAIMS + DOC_CARRIES here — the engine, route,
 * and UI never change.
 */
const { namesMatchLoose, entityMatch, withinMoney, addrMatches, addrLine, toISODate, digitsOnly, num } = require('./compare');

function borrowerName(b) {
  if (!b) return null;
  const n = `${b.first_name || ''} ${b.last_name || ''}`.trim();
  return n || null;
}
const dateStr = (v) => (v == null ? null : String(v).slice(0, 10));

// The canonical facts. `kind` selects the match + display logic; `severity` is the finding
// severity when this fact disagrees; `file(ctx)` reads the loan-file value (null when the file
// doesn't store it — e.g. the seller, which only documents carry, so it's a doc-vs-doc fact).
const FACTS = [
  { key: 'borrower_name', label: 'Borrower name', category: 'identity', kind: 'name', severity: 'fatal', file: (c) => borrowerName(c.borrower) },
  { key: 'borrower_dob', label: 'Date of birth', category: 'identity', kind: 'date', severity: 'fatal', file: (c) => (c.borrower ? dateStr(c.borrower.date_of_birth) : null) },
  { key: 'borrower_address', label: 'Borrower home address', category: 'identity', kind: 'address', severity: 'info', file: (c) => (c.borrower ? c.borrower.current_address : null) },
  { key: 'entity_name', label: 'Vesting entity', category: 'entity', kind: 'entity', severity: 'fatal', file: (c) => c.vestingName || null },
  { key: 'ein', label: 'Entity EIN', category: 'entity', kind: 'digits', severity: 'warning', file: (c) => c.ein || null },
  { key: 'property_address', label: 'Property address', category: 'collateral', kind: 'address', severity: 'fatal', file: (c) => (c.app ? c.app.property_address : null) },
  { key: 'purchase_price', label: 'Purchase price', category: 'economics', kind: 'money', severity: 'fatal', file: (c) => (c.app ? c.app.purchase_price : null) },
  { key: 'seller_name', label: 'Seller', category: 'economics', kind: 'nameOrEntity', severity: 'fatal', file: () => null },
  { key: 'underlying_price', label: "Seller's original price", category: 'economics', kind: 'money', severity: 'fatal', file: (c) => (c.app ? c.app.underlying_contract_price : null) },
  { key: 'assignment_fee', label: 'Assignment fee', category: 'economics', kind: 'money', severity: 'fatal', file: (c) => (c.app ? c.app.assignment_fee : null) },
  { key: 'loan_amount', label: 'Loan amount', category: 'economics', kind: 'money', severity: 'warning', file: (c) => (c.app ? c.app.loan_amount : null) },
  { key: 'as_is_value', label: 'As-is value', category: 'valuation', kind: 'money', severity: 'warning', file: (c) => (c.app ? c.app.as_is_value : null) },
  { key: 'arv', label: 'After-repair value', category: 'valuation', kind: 'money', severity: 'warning', file: (c) => (c.app ? c.app.arv : null) },
  { key: 'rehab_budget', label: 'Rehab budget', category: 'rehab', kind: 'money', severity: 'warning', file: (c) => (c.app ? c.app.rehab_budget : null) },
];
const FACT_BY_KEY = Object.create(null);
for (const f of FACTS) FACT_BY_KEY[f.key] = f;

// Each document type's PURPOSE, expressed as the facts it speaks to and the extracted field
// each fact comes from. This is also the "know what every document is for" catalog. A fact
// value may be an array (seller names, vested owners) — the matcher handles any-to-any.
const DOC_CLAIMS = {
  government_id: (f) => ({ borrower_name: f.fullName || nm(f.firstName, f.lastName), borrower_dob: f.dateOfBirth, borrower_address: f.address }),
  purchase_contract: (f) => ({ property_address: f.propertyAddress, purchase_price: f.purchasePrice, seller_name: f.sellerNames, entity_name: f.buyerName, assignment_fee: f.assignmentFee, underlying_price: f.underlyingPrice }),
  title: (f) => ({ property_address: f.propertyAddress, seller_name: f.vestedOwners, entity_name: f.buyerNames }),
  appraisal: (f) => ({ property_address: f.propertyAddress, purchase_price: pick(f.contractPrice, f.salePrice), seller_name: f.sellerNames || arr(f.ownerOfRecord) || arr(f.sellerName), as_is_value: pick(f.asIsValue, f.as_is_value), arv: pick(f.arvValue, f.arv) }),
  bank_statement: (f) => (f.holderIsBusiness ? { entity_name: f.accountHolderName } : { borrower_name: f.accountHolderName }),
  // ---- expanded document types (Phase B) ----
  assignment: (f) => ({ entity_name: f.assigneeName, underlying_price: f.originalPurchasePrice, assignment_fee: f.assignmentFee, property_address: f.propertyAddress, seller_name: f.sellerName ? [f.sellerName] : null }),
  insurance: (f) => ({ entity_name: f.namedInsured, property_address: f.propertyAddress }),
  operating_agreement: (f) => ({ entity_name: f.entityLegalName, borrower_name: f.managingMember }),
  ein_letter: (f) => ({ entity_name: f.entityLegalName, ein: f.ein }),
  good_standing: (f) => ({ entity_name: f.entityLegalName }),
  llc_formation: (f) => ({ entity_name: f.entityLegalName }),
  credit_report: (f) => ({ borrower_name: f.subjectName, borrower_dob: f.dob }),
  settlement: (f) => ({ property_address: f.propertyAddress, purchase_price: f.contractSalesPrice, seller_name: f.sellerName ? [f.sellerName] : null, entity_name: f.buyerName, loan_amount: f.loanAmount, assignment_fee: f.assignmentFee }),
  flood: (f) => ({ property_address: f.propertyAddress }),
  payoff: (f) => ({ property_address: f.propertyAddress }),
};

// The facts each document type CAN carry (so the matrix can distinguish "this doc is silent
// on this fact" (na) from "this doc should state it but didn't" (missing)).
const DOC_CARRIES = {
  government_id: ['borrower_name', 'borrower_dob', 'borrower_address'],
  purchase_contract: ['property_address', 'purchase_price', 'seller_name', 'entity_name', 'assignment_fee', 'underlying_price'],
  title: ['property_address', 'seller_name', 'entity_name'],
  appraisal: ['property_address', 'purchase_price', 'seller_name', 'as_is_value', 'arv'],
  bank_statement: ['entity_name', 'borrower_name'],
  assignment: ['entity_name', 'underlying_price', 'assignment_fee', 'property_address', 'seller_name'],
  insurance: ['entity_name', 'property_address'],
  operating_agreement: ['entity_name', 'borrower_name'],
  ein_letter: ['entity_name', 'ein'],
  good_standing: ['entity_name'],
  llc_formation: ['entity_name'],
  credit_report: ['borrower_name', 'borrower_dob'],
  settlement: ['property_address', 'purchase_price', 'seller_name', 'entity_name', 'loan_amount', 'assignment_fee'],
  flood: ['property_address'],
  payoff: ['property_address'],
};

function nm(a, b) { const n = `${a || ''} ${b || ''}`.trim(); return n || null; }
function arr(v) { return v ? [v] : null; }
function pick(...vals) { for (const v of vals) if (v != null) return v; return null; }

// Is a claim value present (non-empty scalar, or a non-empty array)?
function present(v) {
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '').length > 0;
  return true;
}
function toList(v) { return v == null ? [] : (Array.isArray(v) ? v.filter((x) => x != null && x !== '') : [v]); }

// Compare two SCALAR values by fact kind. Returns true / false / null(uncomparable).
function matchScalar(kind, a, b) {
  switch (kind) {
    case 'money': return withinMoney(a, b, 1);
    case 'date': { const x = toISODate(dateStr(a)), y = toISODate(dateStr(b)); return x && y ? x === y : null; }
    case 'address': return addrMatches(a, b);
    case 'digits': { const x = digitsOnly(a), y = digitsOnly(b); return x && y ? x === y : null; }
    case 'name': return namesMatchLoose(a, b);
    case 'entity': return entityMatch(a, b);
    case 'nameOrEntity': {
      const p = namesMatchLoose(a, b), e = entityMatch(a, b);
      if (p === true || e === true) return true;
      if (p === false && e === false) return false;
      return null;
    }
    default: return null;
  }
}
// Compare two values (either may be an array for name/entity facts). Any pair matching → true;
// only when NO pair matches and at least one pair definitively differs → false; else null.
function factMatch(kind, a, b) {
  if (kind === 'name' || kind === 'entity' || kind === 'nameOrEntity') {
    const A = toList(a), B = toList(b);
    if (!A.length || !B.length) return null;
    let anyFalse = false;
    for (const x of A) for (const y of B) { const r = matchScalar(kind, x, y); if (r === true) return true; if (r === false) anyFalse = true; }
    return anyFalse ? false : null;
  }
  return matchScalar(kind, a, b);
}

// Human-readable value for the matrix cell.
function display(kind, v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '').map((x) => display(kind === 'nameOrEntity' ? 'name' : kind, x)).join(' / ') || null;
  if (kind === 'money') { const n = num(v); return n == null ? String(v) : `$${n.toLocaleString('en-US')}`; }
  if (kind === 'address') return addrLine(v) || (typeof v === 'string' ? v : null);
  if (kind === 'date') { const d = toISODate(dateStr(v)); return d || String(v); }
  return String(v);
}

// Extract the facts a document contributes, keyed by fact key (present values only).
function claimsFor(docType, fields) {
  const fn = DOC_CLAIMS[docType];
  if (!fn || !fields) return {};
  const raw = fn(fields) || {};
  const out = {};
  for (const k of Object.keys(raw)) { if (FACT_BY_KEY[k] && present(raw[k])) out[k] = raw[k]; }
  return out;
}
function carries(docType, factKey) {
  const c = DOC_CARRIES[docType];
  return !!c && c.indexOf(factKey) !== -1;
}

module.exports = {
  FACTS, FACT_BY_KEY, DOC_CLAIMS, DOC_CARRIES,
  factMatch, matchScalar, display, present, claimsFor, carries, borrowerName,
};

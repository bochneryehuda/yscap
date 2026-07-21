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
const { namesMatchLoose, entityMatch, withinMoney, addrMatches, addrLine, toISODate, digitsOnly, num, norm } = require('./compare');

// ---- Enum canonicalizers (collateral classifications) ----------------------------------------
// Property type + occupancy come off different documents in different words ("SFR" / "Single
// Family" / "1-unit"; "Tenant" / "Investment" / "Non-owner"). Canonicalize to a small code set so
// the appraisal and the application only flag a REAL disagreement (a 1-unit called a 2-4), never a
// wording difference. When a value doesn't map to a known bucket we return null (uncomparable) —
// never a guessed bucket — so an unrecognized string is shown but never raises a false mismatch.
function canonPropertyType(v) {
  const s = norm(String(v == null ? '' : v));
  if (!s) return null;
  if (/\b(5|five|six|seven|eight|nine|ten|\d{2,})\b.*unit|multi.*(5|five)\+?|5\+/.test(s) || /apartment|multifamily 5/.test(s)) return 'multi_5plus';
  if (/\b(2|3|4|two|three|four|duplex|triplex|fourplex|quad)\b.*unit|multi.*2.?4|2.?4 unit|two to four/.test(s) || /\bduplex\b|\btriplex\b|\bfourplex\b/.test(s)) return 'multi_2_4';
  if (/condo|condominium/.test(s)) return 'condo';
  if (/town\s?home|town\s?house|\bpud\b|planned unit/.test(s)) return 'townhouse';
  if (/mixed.?use/.test(s)) return 'mixed_use';
  if (/\bland\b|lot only|vacant land/.test(s)) return 'land';
  if (/manufactured|mobile/.test(s)) return 'manufactured';
  if (/sfr|single.?family|1.?unit|one unit|detached|\bsfd\b/.test(s)) return 'sfr';
  return null; // unrecognized → uncomparable, never a guessed bucket
}
function canonOccupancy(v) {
  const s = norm(String(v == null ? '' : v));
  if (!s) return null;
  if (/vacant|unoccupied/.test(s)) return 'vacant';
  if (/tenant|rented|lease|investment|non.?owner|investor|rental/.test(s)) return 'tenant';
  if (/owner.?occupied|owner\b|primary|occupant owner/.test(s)) return 'owner';
  return null;
}

function borrowerName(b) {
  if (!b) return null;
  const n = `${b.first_name || ''} ${b.last_name || ''}`.trim();
  return n || null;
}
const dateStr = (v) => (v == null ? null : String(v).slice(0, 10));
// Canonical form for an alphanumeric identifier (a policy number) — upper-case, strip separators —
// so "POL-123 A" and "pol123a" compare equal. Not PII, so it is shown in full (unlike an EIN/SSN).
const identKey = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');

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
  // Insurance policy number — a doc-vs-doc fact (the loan file doesn't store it): the paid invoice
  // must reference the SAME policy as the binder, so they tie out on this. A warning when they differ.
  { key: 'policy_number', label: 'Insurance policy number', category: 'collateral', kind: 'ident', severity: 'warning', file: () => null },
  { key: 'purchase_price', label: 'Purchase price', category: 'economics', kind: 'money', severity: 'fatal', file: (c) => (c.app ? c.app.purchase_price : null) },
  { key: 'seller_name', label: 'Seller', category: 'economics', kind: 'nameOrEntity', severity: 'fatal', file: () => null },
  { key: 'underlying_price', label: "Seller's original price", category: 'economics', kind: 'money', severity: 'fatal', file: (c) => (c.app ? c.app.underlying_contract_price : null) },
  { key: 'assignment_fee', label: 'Assignment fee', category: 'economics', kind: 'money', severity: 'fatal', file: (c) => (c.app ? c.app.assignment_fee : null) },
  { key: 'loan_amount', label: 'Loan amount', category: 'economics', kind: 'money', severity: 'warning', file: (c) => (c.app ? c.app.loan_amount : null) },
  { key: 'as_is_value', label: 'As-is value', category: 'valuation', kind: 'money', severity: 'warning', file: (c) => (c.app ? c.app.as_is_value : null) },
  { key: 'arv', label: 'After-repair value', category: 'valuation', kind: 'money', severity: 'warning', file: (c) => (c.app ? c.app.arv : null) },
  { key: 'rehab_budget', label: 'Rehab budget', category: 'rehab', kind: 'money', severity: 'warning', file: (c) => (c.app ? c.app.rehab_budget : null) },
  // ---- collateral physicals (owner-directed 2026-07-21 — pull EVERY appraisal fact into the
  // comparison). The appraisal is the authority; the application/file carries units/type/occupancy,
  // so these cross-check appraisal-vs-file. Year built / living area / market rent are appraisal-
  // carried facts we surface even when nothing else states them (single-source display).
  { key: 'units', label: 'Number of units', category: 'collateral', kind: 'count', severity: 'warning', file: (c) => (c.app ? c.app.units : null) },
  { key: 'property_type', label: 'Property type', category: 'collateral', kind: 'propertyType', severity: 'warning', file: (c) => (c.app ? c.app.property_type : null) },
  { key: 'occupancy', label: 'Occupancy', category: 'collateral', kind: 'occupancy', severity: 'info', file: (c) => (c.app ? c.app.occupancy : null) },
  { key: 'year_built', label: 'Year built', category: 'collateral', kind: 'count', severity: 'info', file: () => null },
  { key: 'living_area', label: 'Living area (sq ft)', category: 'collateral', kind: 'measure', severity: 'info', file: () => null },
  { key: 'market_rent', label: 'Market rent (1007)', category: 'valuation', kind: 'money', severity: 'info', file: () => null },
  // ---- closing economics (owner-directed 2026-07-21 — the settlement statement is the
  // reconciliation SINK; surface its figures in the comparison). Doc-carried facts (the loan file
  // doesn't store the earnest money or cash-to-close), so they show + tie out doc-vs-doc.
  { key: 'earnest_money', label: 'Earnest money (EMD)', category: 'economics', kind: 'money', severity: 'info', file: () => null },
  { key: 'cash_to_close', label: 'Cash to close', category: 'economics', kind: 'money', severity: 'info', file: () => null },
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
  appraisal: (f) => ({ property_address: f.propertyAddress, purchase_price: pick(f.contractPrice, f.salePrice), seller_name: f.sellerNames || arr(f.ownerOfRecord) || arr(f.sellerName), as_is_value: pick(f.asIsValue, f.as_is_value), arv: pick(f.arvValue, f.arv),
    // Collateral physicals off the appraisal (owner-directed 2026-07-21) — the appraisal is the
    // authority for what the property physically IS; these tie out against the application.
    units: pick(f.units, f.unitCount), property_type: pick(f.propertyType, f.property_type),
    occupancy: pick(f.occupancy), year_built: pick(f.yearBuilt, f.year_built),
    living_area: pick(f.gla, f.sqft, f.livingArea), market_rent: pick(f.marketRent, f.market_rent) }),
  bank_statement: (f) => (f.holderIsBusiness ? { entity_name: f.accountHolderName } : { borrower_name: f.accountHolderName }),
  // ---- expanded document types (Phase B) ----
  assignment: (f) => ({ entity_name: f.assigneeName, underlying_price: f.originalPurchasePrice, assignment_fee: f.assignmentFee, property_address: f.propertyAddress, seller_name: f.sellerName ? [f.sellerName] : null }),
  insurance: (f) => ({ entity_name: f.namedInsured, property_address: f.propertyAddress, policy_number: f.policyNumber }),
  insurance_invoice: (f) => ({ entity_name: f.namedInsured, property_address: f.propertyAddress, policy_number: f.policyNumber }),
  operating_agreement: (f) => ({ entity_name: f.entityLegalName, borrower_name: f.managingMember }),
  ein_letter: (f) => ({ entity_name: f.entityLegalName, ein: f.ein }),
  good_standing: (f) => ({ entity_name: f.entityLegalName }),
  llc_formation: (f) => ({ entity_name: f.entityLegalName }),
  credit_report: (f) => ({ borrower_name: f.subjectName, borrower_dob: f.dob }),
  settlement: (f) => ({ property_address: f.propertyAddress, purchase_price: f.contractSalesPrice, seller_name: f.sellerName ? [f.sellerName] : null, entity_name: f.buyerName, loan_amount: f.loanAmount, assignment_fee: f.assignmentFee, earnest_money: f.earnestMoney, cash_to_close: f.cashToClose }),
  flood: (f) => ({ property_address: f.propertyAddress }),
  scope_of_work: (f) => ({ property_address: f.propertyAddress, rehab_budget: f.totalBudget }),
  payoff_statement: (f) => ({ property_address: f.propertyAddress }),
  signed_term_sheet: (f) => ({ property_address: f.propertyAddress, loan_amount: f.loanAmount }),
  signed_application: (f) => ({ property_address: f.propertyAddress, entity_name: f.entityName }),
  investor_structure: (f) => ({ property_address: f.propertyAddress }),
};

// The facts each document type CAN carry (so the matrix can distinguish "this doc is silent
// on this fact" (na) from "this doc should state it but didn't" (missing)).
const DOC_CARRIES = {
  government_id: ['borrower_name', 'borrower_dob', 'borrower_address'],
  purchase_contract: ['property_address', 'purchase_price', 'seller_name', 'entity_name', 'assignment_fee', 'underlying_price'],
  title: ['property_address', 'seller_name', 'entity_name'],
  appraisal: ['property_address', 'purchase_price', 'seller_name', 'as_is_value', 'arv', 'units', 'property_type', 'occupancy', 'year_built', 'living_area', 'market_rent'],
  bank_statement: ['entity_name', 'borrower_name'],
  assignment: ['entity_name', 'underlying_price', 'assignment_fee', 'property_address', 'seller_name'],
  insurance: ['entity_name', 'property_address', 'policy_number'],
  insurance_invoice: ['entity_name', 'property_address', 'policy_number'],
  operating_agreement: ['entity_name', 'borrower_name'],
  ein_letter: ['entity_name', 'ein'],
  good_standing: ['entity_name'],
  llc_formation: ['entity_name'],
  credit_report: ['borrower_name', 'borrower_dob'],
  settlement: ['property_address', 'purchase_price', 'seller_name', 'entity_name', 'loan_amount', 'assignment_fee', 'earnest_money', 'cash_to_close'],
  flood: ['property_address'],
  scope_of_work: ['property_address', 'rehab_budget'],
  payoff_statement: ['property_address'],
  signed_term_sheet: ['property_address', 'loan_amount'],
  signed_application: ['property_address', 'entity_name'],
  investor_structure: ['property_address'],
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
    // Compare identifiers (EIN) on the last 4 digits — the stored document value is PII-masked
    // to ***last4, so only the last 4 are ever available to compare (and to display).
    case 'digits': { const x = digitsOnly(a).slice(-4), y = digitsOnly(b).slice(-4); return x.length === 4 && y.length === 4 ? x === y : null; }
    case 'ident': { const x = identKey(a), y = identKey(b); return x && y ? x === y : null; }
    // A whole-number count (units, year built): equal when the rounded integers match.
    case 'count': { const x = num(a), y = num(b); return x != null && y != null ? Math.round(x) === Math.round(y) : null; }
    // A measurement (square footage): agrees within a small percentage tolerance (appraisers and
    // tax records round differently), so a 1% GLA difference is not a "mismatch".
    case 'measure': { const x = num(a), y = num(b); if (x == null || y == null || x <= 0 || y <= 0) return null; return Math.abs(x - y) / Math.max(x, y) <= 0.03; }
    // Classification enums (property type, occupancy): compare on the canonical bucket. When either
    // value doesn't map to a known bucket, it's uncomparable (null) — never a guessed mismatch.
    case 'propertyType': { const x = canonPropertyType(a), y = canonPropertyType(b); return x && y ? x === y : null; }
    case 'occupancy': { const x = canonOccupancy(a), y = canonOccupancy(b); return x && y ? x === y : null; }
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
  if (kind === 'count') { const n = num(v); return n == null ? String(v) : String(Math.round(n)); }
  if (kind === 'measure') { const n = num(v); return n == null ? String(v) : `${Math.round(n).toLocaleString('en-US')} sq ft`; }
  if (kind === 'digits') { const d = digitsOnly(v); return d ? `***${d.slice(-4)}` : String(v); } // never show a full identifier
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

'use strict';
/**
 * LONG-TERM — reading the 1003 out of the loan we already hold.
 *
 * PURE. No requires, no database, no network — hand it the Encompass loan payload
 * and it hands back rows. That is what makes every rule below testable without a
 * tenant, and it is why this file can never accidentally reach Encompass.
 *
 * WHY IT COSTS NOTHING. `sync/loans.js` already fetches the whole loan for every
 * file that moved. The subject property rides on that same payload, so filling the
 * mirror adds no HTTP call, no fieldReader id and no pacing delay. This matters:
 * the tenant enforces a self-imposed gap between calls, so a second read per loan
 * is time the whole company shares.
 *
 * THREE RULES, ALL LEARNED HERE THE HARD WAY:
 *
 *   1. A VALUE READ BY NUMBER WINS. The same Encompass field sits at a different
 *      JSON path from loan to loan — that is what produced the live 1%-vs-2%
 *      origination bug on the RTL side. So where a caller has already read the
 *      field values by id (`loan._fieldValues`), those are authoritative and the
 *      path is only the fallback.
 *   2. A MISSING FIGURE IS NULL, NEVER ZERO. "No appraised value on file" and "an
 *      appraised value of nothing" are different loans, and `Number(null)` is 0 —
 *      the same trap that made a blank refresh age read as "re-read the whole
 *      book". Everything numeric here goes through `num`, which refuses a blank.
 *   3. NOTHING IS INVENTED. A field this tenant does not populate stays null
 *      rather than being derived from a neighbour: an LTV computed from a loan
 *      amount and a value we happen to hold would look identical to Encompass's
 *      own and disagree with it on the files that matter.
 */

/** A number, or null. Never 0 for "we do not know" — `Number('')` is 0 too. */
function num(v) {
  // Only a real number, or a number somebody typed. `Number(null)`, `Number('')`,
  // `Number(false)` and `Number([])` are ALL a finite, perfectly innocent 0 — so a
  // type test has to come before the conversion, or an absent figure becomes a $0
  // appraised value and a 0% LTV on a screen somebody makes a decision from.
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Trimmed text, or null. */
function text(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  return s || null;
}

/** An integer, or null — a unit count of 2.5 is a misread, not a half a flat. */
function int(v) {
  const n = num(v);
  return n === null ? null : (Number.isInteger(n) ? n : null);
}

/**
 * The field ids this reader knows, with the path each one is usually found at.
 *
 * Every id and every fill rate here was MEASURED across 772 loans and lives in
 * `encompass/loan-anatomy.js`; this is the same knowledge in the shape a mapper
 * needs. Keeping the id beside the path is what lets rule 1 be applied uniformly
 * instead of remembered per field.
 */
const SUBJECT_FIELDS = {
  street: { id: '11', paths: ['property.streetAddress', 'property.street', 'subjectPropertyStreetAddress'] },
  city: { id: '12', paths: ['property.city', 'subjectPropertyCity'] },
  county: { id: '13', paths: ['property.county', 'subjectPropertyCounty'] },
  state: { id: '14', paths: ['property.state', 'subjectPropertyState'] },
  zip: { id: '15', paths: ['property.postalCode', 'property.zip', 'subjectPropertyPostalCode'] },
  unitCount: { id: '16', paths: ['property.financedNumberOfUnits', 'financedNumberOfUnits'] },
  gsePropertyType: { id: '1041', paths: ['loanProductData.gsePropertyType', 'property.gsePropertyType'] },
  occupancyType: { id: '1811', paths: ['property.propertyUsageType', 'propertyUsageType'] },
  occupancyRatePct: { id: '1487', paths: ['property.occupancyPercent', 'occupancyPercent'] },
  appraisedValue: { id: '356', paths: ['property.propertyAppraisedValueAmount', 'propertyAppraisedValueAmount'] },
  estimatedValue: { id: '1821', paths: ['property.propertyEstimatedValueAmount', 'propertyEstimatedValueAmount'] },
  purchasePrice: { id: '136', paths: ['property.purchasePriceAmount', 'purchasePriceAmount'] },
  originalCost: { id: '25', paths: ['property.originalCostAmount', 'originalCostAmount'] },
  grossMonthlyRent: { id: '1005', paths: ['subjectPropertyGrossRentalIncomeAmount', 'property.grossRentalIncomeAmount'] },
  ltvPct: { id: '353', paths: ['ltv', 'ltvPropertyValue'] },
  cltvPct: { id: '976', paths: ['combinedLtv', 'cltv'] },
};

/** Follow a dotted path without throwing on a missing branch. */
function at(obj, path) {
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * One field, by NUMBER first and then by path.
 *
 * The id is looked up under both a string and a numeric key because a JSON map
 * keyed by field id arrives with string keys while a caller building one in code
 * naturally uses numbers — and a lookup miss here is silent, which is exactly how
 * the authoritative value gets quietly replaced by the guessed one.
 */
function fieldOf(loan, spec, values) {
  const fv = values || (loan && loan._fieldValues) || null;
  if (fv && spec.id) {
    const byNum = fv[spec.id] !== undefined ? fv[spec.id] : fv[Number(spec.id)];
    if (byNum !== undefined && byNum !== null && byNum !== '') return byNum;
  }
  for (const p of spec.paths) {
    const v = at(loan, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * The subject property, as one row for `lt_properties`.
 *
 * Returns null for a payload that is not a loan at all — the caller writes nothing
 * rather than an empty row, because an empty row is indistinguishable on a screen
 * from a property we read and found blank.
 *
 * `actualMonthlyRent`, `inFloodZone` and `floodZone` are DELIBERATELY absent:
 * db/549 carries the columns, this tenant has no measured field for them, and a
 * guessed source is worse than an honest blank on a figure a decision is made on.
 */
function readSubjectProperty(loan, values) {
  if (!loan || typeof loan !== 'object') return null;
  const f = (key) => fieldOf(loan, SUBJECT_FIELDS[key], values);

  const row = {
    street: text(f('street')),
    city: text(f('city')),
    county: text(f('county')),
    state: text(f('state')),
    zip: text(f('zip')),
    unitCount: int(f('unitCount')),
    gsePropertyType: text(f('gsePropertyType')),
    occupancyType: text(f('occupancyType')),
    occupancyRatePct: num(f('occupancyRatePct')),
    appraisedValue: num(f('appraisedValue')),
    estimatedValue: num(f('estimatedValue')),
    purchasePrice: num(f('purchasePrice')),
    originalCost: num(f('originalCost')),
    grossMonthlyRent: num(f('grossMonthlyRent')),
    ltvPct: num(f('ltvPct')),
    cltvPct: num(f('cltvPct')),
  };

  // How much of it we actually found. A mirror that fills two columns of sixteen
  // and says nothing looks exactly like a mirror that is working — this is the
  // number that makes "the Property tab is empty" answerable without a tenant.
  const found = Object.values(row).filter((v) => v !== null).length;
  return { ...row, _found: found, _fields: Object.keys(row).length };
}

module.exports = {
  readSubjectProperty,
  SUBJECT_FIELDS,
  _internals: { num, text, int, at, fieldOf },
};

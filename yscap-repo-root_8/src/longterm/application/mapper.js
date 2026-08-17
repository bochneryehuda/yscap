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
 * The field ids this reader knows, with the path each one is MEASURED at.
 *
 * Every path here is `encompass/dictionary/field-dictionary.json`'s own `jsonPath`
 * for that id, recorded across 772 loans — not a plausible-looking guess, because
 * a wrong path is a column that silently never fills and looks exactly like a
 * tenant that does not populate the field. `test-lt-application-pure.js` compares
 * every one of them against the dictionary and fails the build on a disagreement,
 * so this table can go stale but it cannot go stale QUIETLY.
 *
 * Three of them are counter-intuitive and were wrong on the first pass: the
 * occupancy is on the APPLICATION, the occupancy RATE and the appraised value are
 * at the loan ROOT rather than on the property, and the original cost is
 * `refinancePropertyOriginalCostAmount`.
 */
const SUBJECT_FIELDS = {
  street: { id: '11', paths: ['property.streetAddress'] },
  city: { id: '12', paths: ['property.city'] },
  county: { id: '13', paths: ['property.county'] },
  state: { id: '14', paths: ['property.state'] },
  zip: { id: '15', paths: ['property.postalCode'] },
  unitCount: { id: '16', paths: ['property.financedNumberOfUnits'] },
  gsePropertyType: { id: '1041', paths: ['loanProductData.gsePropertyType'] },
  // The occupancy lives on the APPLICATION, not on the property and not at the
  // root. Reading it off either of those answers null on every loan in the book —
  // it is filled on 100% of them, so a blank column here means the path is wrong.
  occupancyType: { id: '1811', paths: ['applications.0.propertyUsageType'] },
  occupancyRatePct: { id: '1487', paths: ['subjectPropertyOccupancyPercent'] },
  appraisedValue: { id: '356', paths: ['propertyAppraisedValueAmount'] },
  estimatedValue: { id: '1821', paths: ['propertyEstimatedValueAmount'] },
  purchasePrice: { id: '136', paths: ['purchasePriceAmount'] },
  originalCost: { id: '25', paths: ['property.refinancePropertyOriginalCostAmount'] },
  grossMonthlyRent: { id: '1005', paths: ['subjectPropertyGrossRentalIncomeAmount'] },
  ltvPct: { id: '353', paths: ['ltv'] },
  cltvPct: { id: '976', paths: ['combinedLtv'] },
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

// ── The borrower pairs (URLA §1a) ────────────────────────────────────────────

/**
 * THE LAST FOUR DIGITS, AND NOTHING ELSE.
 *
 * `taxIdentificationIdentifier` is the Social Security number. Only the last four
 * are ever returned from here — not the rest, not in a field the caller might
 * store "for later", not even trimmed — because the moment the whole number is in
 * a returned object it is one careless log line, one spread and one JSON response
 * away from leaving the building. `lt_parties.ssn_encrypted` stays UNWRITTEN: the
 * only encryption in this codebase is an RTL module, and reaching it from the
 * long-term side is a crossing that needs the owner's written authorization in
 * `docs/LONG-TERM-AUTHORIZED-COPIES.md`. `file.js` reads `ssn_last4` and never the
 * encrypted column, so nothing on a screen is waiting on that decision.
 *
 * A partial or masked number ("***-**-1234", "1234") yields the last four it can
 * see when there are exactly four digits, and NOTHING when there are fewer — a
 * two-digit "last four" on a screen somebody reads back on a phone call is worse
 * than a blank one.
 */
function ssnLast4(v) {
  const digits = String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/**
 * The party-level fields — BY PATH ONLY, and that is a correctness rule.
 *
 * Every field id the dictionary records for these sits at
 * `$.applications[0].borrower.X` — the FIRST application's PRIMARY borrower. So a
 * value read by number is not "this party's name", it is "the first borrower's
 * name", and applying it to a co-borrower or to a second pair would confidently
 * write one person's Social and date of birth onto another. The id is kept here
 * only to say where the path was measured; `readParty` never consults the
 * field-value map, and the test pins each path to the dictionary's own.
 *
 * `dependentCount` has NO id: field 54 is `dependentsAgesDescription`, which is a
 * different question with a different answer, and wiring it here would put a list
 * of ages in a count column.
 */
const PARTY_FIELDS = {
  firstName: { id: '4000', path: 'firstName' },
  middleName: { id: '4001', path: 'middleName' },
  lastName: { id: '4002', path: 'lastName' },
  nameSuffix: { id: null, path: 'suffixToName', alt: ['suffix'] },
  dateOfBirth: { id: '1402', path: 'birthDate' },
  ssn: { id: '65', path: 'taxIdentificationIdentifier' },
  email: { id: '1240', path: 'emailAddressText' },
  homePhone: { id: '66', path: 'homePhoneNumber' },
  mobilePhone: { id: '1490', path: 'mobilePhone' },
  maritalStatus: { id: '52', path: 'maritalStatusType' },
  dependentCount: { id: null, path: 'dependentCount' },
  citizenship: { id: null, path: 'urla2020CitizenshipResidencyType', alt: ['citizenshipResidencyType'] },
  ficoExperian: { id: null, path: 'experianCreditScore' },
  ficoTransunion: { id: null, path: 'transUnionScore' },
  ficoEquifax: { id: null, path: 'equifaxScore' },
  ficoRepresentative: { id: null, path: 'middleCreditScore', alt: ['middleFicoScore'] },
};

/** One party field, by path — never by number. See the table above. */
function partyValue(raw, spec) {
  for (const p of [spec.path, ...(spec.alt || [])]) {
    const v = at(raw, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * One borrower or co-borrower, or null when the slot is EMPTY.
 *
 * Encompass returns a `coborrower` object on files that have none — every field
 * null — so "the object is present" is not "there is a second person". A party is
 * real when it carries a name, an email or a Social; anything less would put a
 * nameless second borrower on the file's Borrowers section, which reads as a data
 * problem on a perfectly ordinary single-borrower DSCR loan.
 *
 * `partyType` is always `individual`. Whether a party is an ENTITY is not
 * something this tenant has been observed to state on the borrower record, and
 * guessing it would put an empty company block on a real person — the entity
 * columns stay null until there is a measured source for them.
 */
function readParty(raw, role) {
  if (!raw || typeof raw !== 'object') return null;
  const f = (key) => partyValue(raw, PARTY_FIELDS[key]);

  const party = {
    role,
    partyType: 'individual',
    firstName: text(f('firstName')),
    middleName: text(f('middleName')),
    lastName: text(f('lastName')),
    nameSuffix: text(f('nameSuffix')),
    dateOfBirth: text(f('dateOfBirth')),
    ssnLast4: ssnLast4(f('ssn')),
    citizenship: text(f('citizenship')),
    maritalStatus: text(f('maritalStatus')),
    dependentCount: int(f('dependentCount')),
    email: text(f('email')),
    homePhone: text(f('homePhone')),
    mobilePhone: text(f('mobilePhone')),
    // Declared STRING in the Encompass schema even though they hold integers
    // (loan-anatomy.js) — so these arrive as "756" and go through `int`.
    ficoExperian: int(f('ficoExperian')),
    ficoTransunion: int(f('ficoTransunion')),
    ficoEquifax: int(f('ficoEquifax')),
    ficoRepresentative: int(f('ficoRepresentative')),
  };

  const real = party.firstName || party.lastName || party.email || party.ssnLast4;
  return real ? party : null;
}

/**
 * The borrower pairs on a loan.
 *
 * A pair is one application in Encompass's own list — the primary borrower plus an
 * optional co-borrower — and the tenant is configured for SIX of them even though
 * three is the most ever used, so this returns a LIST and never a fixed
 * borrower/co-borrower shape.
 *
 * The pair NUMBER comes from Encompass's own `_borrowerN` label where there is
 * one, because that is the number its eFolder files documents under; the position
 * in the array is only the fallback. Getting that wrong would file a document
 * against the wrong person on a two-pair loan.
 */
function readBorrowerPairs(loan) {
  if (!loan || typeof loan !== 'object') return [];
  const apps = Array.isArray(loan.applications) ? loan.applications : [];

  const out = [];
  apps.forEach((app, i) => {
    if (!app || typeof app !== 'object') return;
    const labelled = int(String(app.legacyId || app.borrowerPairId || '').replace(/^\D*/, ''));
    const parties = [
      readParty(app.borrower, 'borrower'),
      readParty(app.coborrower, 'coborrower'),
    ].filter(Boolean);

    out.push({
      pairNumber: labelled && labelled > 0 ? labelled : i + 1,
      encompassApplicationId: text(app.id),
      propertyUsageType: text(app.propertyUsageType),
      parties,
    });
  });
  return out;
}

module.exports = {
  readSubjectProperty,
  readBorrowerPairs,
  readParty,
  SUBJECT_FIELDS,
  PARTY_FIELDS,
  _internals: { num, text, int, at, fieldOf, partyValue, ssnLast4 },
};

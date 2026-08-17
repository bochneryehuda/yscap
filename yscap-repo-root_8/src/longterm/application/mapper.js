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
    // Each person carries their OWN addresses, because a residence hangs off the
    // borrower object rather than off the application — and the application-level
    // lists carry a `role` instead, which is the only thing that says whose they
    // are. Keeping both shapes here means the writer never has to know either.
    const parties = [
      [app.borrower, 'borrower'],
      [app.coborrower, 'coborrower'],
    ].map(([raw, role]) => {
      const party = readParty(raw, role);
      return party ? {
        ...party,
        residences: readResidences(raw),
        employments: readEmployments(raw),
        declarations: readDeclarations(raw),
      } : null;
    }).filter(Boolean);

    out.push({
      pairNumber: labelled && labelled > 0 ? labelled : i + 1,
      encompassApplicationId: text(app.id),
      propertyUsageType: text(app.propertyUsageType),
      parties,
      incomes: readOtherIncomes(app),
      reo: readReoProperties(app),
      assets: readAssets(app),
      liabilities: readLiabilities(app),
    });
  });
  return out;
}

// ── The rest of the 1003 (URLA §1a addresses, §1b–e, §2, §3) ────────────────

/**
 * WHICH PERSON DOES THIS ROW BELONG TO?
 *
 * Every row on an application — an income, an asset, a liability, an REO
 * property — carries an `owner` of `Borrower` or `CoBorrower`, and it is the ONLY
 * thing that says whose it is. Getting it wrong puts one person's debts on
 * another's schedule, which is not a display bug: it is what a DSCR file is
 * underwritten on.
 *
 * An owner we cannot read is `borrower` — the primary — because that is what
 * Encompass's own default is on a single-borrower file, which is nearly all of
 * them here. `Both` / `Joint` likewise sits with the primary rather than being
 * duplicated onto two schedules, where it would be counted twice.
 */
function ownerRole(v) {
  const s = String(v === null || v === undefined ? '' : v).toLowerCase().replace(/[^a-z]/g, '');
  return s === 'coborrower' ? 'coborrower' : 'borrower';
}

/** The last four of an account number — the rest is not ours to keep. */
function acctLast4(v) {
  const s = String(v === null || v === undefined ? '' : v).replace(/\s/g, '');
  if (s.length < 4) return null;
  return s.slice(-4);
}

/** Years + months as one figure. Either may be absent; both absent is null. */
function durationMonths(years, months) {
  const y = int(years);
  const m = int(months);
  if (y === null && m === null) return null;
  return (y || 0) * 12 + (m || 0);
}

const RESIDENCY_TYPE = { current: 'current', prior: 'prior' };
const RESIDENCY_BASIS = {
  own: 'own', rent: 'rent', nopimaryhousingexpense: 'no_primary_housing_expense',
  noprimaryhousingexpense: 'no_primary_housing_expense',
};

/**
 * The addresses a person has lived at (§1a).
 *
 * A MAILING address is DROPPED, not guessed into a slot. The column is an enum of
 * exactly `current` and `prior`; Encompass's third value is `Mailing`, which is
 * where post goes rather than where somebody lives, and filing it as "current"
 * would put a PO box on the file as the borrower's home. Same for a basis we do
 * not recognise: the enum has three values and inventing a fourth reading of one
 * of them is how a "rents" becomes an "owns".
 */
function readResidences(borrower) {
  if (!borrower || typeof borrower !== 'object') return [];
  const list = Array.isArray(borrower.residences) ? borrower.residences : [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const type = RESIDENCY_TYPE[String(r.residencyType || '').toLowerCase()];
    const basis = RESIDENCY_BASIS[String(r.residencyBasisType || '').toLowerCase().replace(/[^a-z]/g, '')];
    if (!type || !basis) continue;
    out.push({
      encompassId: text(r.id),
      residencyType: type,
      residencyBasis: basis,
      street: text(r.urla2020StreetAddress) || text(r.addressStreetLine1),
      city: text(r.addressCity),
      state: text(r.addressState),
      zip: text(r.addressPostalCode),
      country: text(r.countryCode) || 'US',
      durationMonths: durationMonths(r.durationTermYears, r.durationTermMonths),
      monthlyRent: num(r.rent),
    });
  }
  return out;
}

/**
 * Income from other sources (§1e) — including the NET RENTAL INCOME that a DSCR
 * file is actually underwritten on.
 *
 * `income_type` and `monthly_amount` are both NOT NULL in db/549, so a row
 * missing either is DROPPED rather than filed under a made-up type or a zero: an
 * income row reading "$0" is a statement about the borrower, and one reading
 * "Other" is a statement about us.
 */
function readOtherIncomes(app) {
  if (!app || typeof app !== 'object') return [];
  const list = Array.isArray(app.income) ? app.income : [];
  const out = [];
  for (const i of list) {
    if (!i || typeof i !== 'object') continue;
    const type = text(i.incomeType);
    const amount = num(i.amount);
    if (!type || amount === null) continue;
    out.push({
      encompassId: text(i.id),
      role: ownerRole(i.owner),
      incomeType: type,
      monthlyAmount: amount,
      description: text(i.description),
    });
  }
  return out;
}

/**
 * The real-estate schedule (§3).
 *
 * The one field that is NOT taken: `subjectIndicator`. A row marked as the
 * subject is the property this loan is against, which db/549 keeps on
 * `lt_properties` — filing it here as well would show an investor's own subject
 * property twice on their schedule and double it in any total somebody adds up.
 */
function readReoProperties(app) {
  if (!app || typeof app !== 'object') return [];
  const list = Array.isArray(app.reoProperties) ? app.reoProperties : [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (r.subjectIndicator === true) continue;
    out.push({
      encompassId: text(r.id),
      role: ownerRole(r.owner),
      street: text(r.urla2020StreetAddress) || text(r.streetAddress),
      city: text(r.city),
      state: text(r.state),
      zip: text(r.postalCode),
      propertyType: null,
      occupancyType: text(r.propertyUsageType),
      dispositionStatus: text(r.dispositionStatusType),
      presentValue: num(r.marketValueAmount),
      mortgageBalance: num(r.lienUpbAmount),
      monthlyMortgagePayment: num(r.lienInstallmentAmount),
      monthlyExpenses: num(r.maintenanceExpenseAmount),
      grossMonthlyRent: num(r.rentalIncomeGrossAmount),
      netMonthlyRentalIncome: num(r.rentalIncomeNetAmount),
    });
  }
  return out;
}

/**
 * What the borrower has (§2a/§2b).
 *
 * TWO SECTIONS, AND THEY ARE DIFFERENT THINGS. `accounts` is money in an account
 * somebody can verify — `vods[]` is where this tenant actually keeps it, with the
 * modern `assets[]` empty on every loan sampled. `credits` is §2b: earnest money
 * already paid, proceeds from a sale, a gift. Folding the two together would
 * count a deposit that has already left the borrower's hands as money they still
 * have.
 */
function readAssets(app) {
  if (!app || typeof app !== 'object') return [];
  const out = [];

  const accounts = [
    ...(Array.isArray(app.vods) ? app.vods : []),
    ...(Array.isArray(app.assets) ? app.assets : []),
  ];
  for (const a of accounts) {
    if (!a || typeof a !== 'object') continue;
    const type = text(a.assetType);
    if (!type) continue;
    out.push({
      encompassId: text(a.id),
      role: ownerRole(a.owner),
      section: 'accounts',
      assetType: type,
      institutionName: text(a.holderName) || text(a.depositoryAccountName),
      accountLast4: acctLast4(a.accountIdentifier),
      value: num(a.cashOrMarketValueAmount) ?? num(a.urla2020CashOrMarketValueAmount),
    });
  }

  for (const a of (Array.isArray(app.otherAssets) ? app.otherAssets : [])) {
    if (!a || typeof a !== 'object') continue;
    const type = text(a.assetType);
    if (!type) continue;
    out.push({
      encompassId: text(a.id),
      role: ownerRole(a.owner),
      section: 'credits',
      assetType: type,
      institutionName: null,
      accountLast4: null,
      value: num(a.cashOrMarketValue),
    });
  }

  return out;
}

/**
 * What the borrower owes (§2c/§2d).
 *
 * `vols[]` IS THE ONE THAT MATTERS: it is where the credit-report tradelines
 * actually live on this tenant, 7–38 rows a loan, while the modern `liabilities[]`
 * array was empty on every loan sampled. Both are read, because a tenant that
 * starts populating the modern array must not silently halve somebody's debts.
 */
function readLiabilities(app) {
  if (!app || typeof app !== 'object') return [];
  const out = [];

  const debts = [
    ...(Array.isArray(app.vols) ? app.vols : []),
    ...(Array.isArray(app.liabilities) ? app.liabilities : []),
  ];
  for (const l of debts) {
    if (!l || typeof l !== 'object') continue;
    const type = text(l.liabilityType);
    if (!type) continue;
    out.push({
      encompassId: text(l.id),
      role: ownerRole(l.owner),
      section: 'debts',
      liabilityType: type,
      creditorName: text(l.holderName),
      accountLast4: acctLast4(l.accountIdentifier),
      unpaidBalance: num(l.unpaidBalanceAmount),
      monthlyPayment: num(l.monthlyPaymentAmount),
      monthsRemaining: int(l.remainingTermMonths),
      // Only an explicit TRUE is a payoff. An absent flag is not a plan.
      toBePaidOff: l.payoffIncludedIndicator === true || l.payoffStatusIndicator === true,
    });
  }

  for (const l of (Array.isArray(app.otherLiabilities) ? app.otherLiabilities : [])) {
    if (!l || typeof l !== 'object') continue;
    const type = text(l.liabilityType) || text(l.otherLiabilityType);
    if (!type) continue;
    out.push({
      encompassId: text(l.id),
      role: ownerRole(l.owner),
      section: 'obligations',
      liabilityType: type,
      creditorName: text(l.holderName),
      accountLast4: null,
      unpaidBalance: num(l.unpaidBalanceAmount),
      monthlyPayment: num(l.monthlyPaymentAmount),
      monthsRemaining: int(l.remainingTermMonths),
      toBePaidOff: false,
    });
  }

  return out;
}

/**
 * A yes/no that is allowed to be UNANSWERED.
 *
 * Every declaration column is a nullable boolean for a reason: "no" and "nobody
 * asked" are different answers, and on §5 the difference is whether a borrower
 * has DECLARED something. `Boolean(undefined)` is `false`, which would turn every
 * question this tenant does not populate into a borrower swearing they have no
 * judgments against them.
 */
function bool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'y' || s === 'yes') return true;
    if (s === 'false' || s === 'n' || s === 'no') return false;
  }
  return null;
}

/** Which bankruptcy chapters were declared, as the words the borrower's own file uses. */
const BANKRUPTCY_CHAPTERS = [
  ['bankruptcyIndicatorChapterSeven', 'Chapter 7'],
  ['bankruptcyIndicatorChapterEleven', 'Chapter 11'],
  ['bankruptcyIndicatorChapterTwelve', 'Chapter 12'],
  ['bankruptcyIndicatorChapterThirteen', 'Chapter 13'],
];

/**
 * The declarations (§5a/§5b).
 *
 * Encompass keeps forty of these on the borrower record and db/549 keeps the
 * sixteen the screen asks. Each is read from the field the probe recorded, with
 * the URLA-2020 spelling FIRST where the tenant carries both — the older field is
 * answered on legacy files and would otherwise be the only one ever read.
 *
 * NOTHING IS INFERRED FROM A NEIGHBOUR. A borrower who declared a foreclosure has
 * not thereby declared a deed in lieu, and a bankruptcy indicator says nothing
 * about which chapter — the chapter list is built ONLY from the four chapter
 * flags, and comes back null when none of them is set rather than guessing "7".
 */
function readDeclarations(borrower) {
  if (!borrower || typeof borrower !== 'object') return null;
  const b = borrower;

  const chapters = BANKRUPTCY_CHAPTERS
    .filter(([key]) => bool(b[key]) === true)
    .map(([, label]) => label);

  const row = {
    willOccupyAsPrimary: bool(b.intentToOccupyIndicator),
    // NOT inferred from `priorPropertyUsageType`. That field says what a prior
    // property was USED as; the §5a question is whether they held an ownership
    // interest in one at all, and answering the second from the first would put a
    // "yes" on the file that the borrower never gave.
    hadOwnershipLast3Years: bool(b.homeownerPastThreeYearsIndicator),
    familyRelationshipToSeller: bool(b.specialBorrowerSellerRelationshipIndicator),
    borrowingOtherMoney: bool(b.undisclosedBorrowedFundsIndicator),
    applyingOtherMortgage: bool(b.undisclosedMortgageApplicationIndicator),
    applyingNewCredit: bool(b.undisclosedCreditApplicationIndicator),
    propertySubjectToLien: bool(b.propertyProposedCleanEnergyLienIndicator),
    isCoSignerOrGuarantor: bool(b.coMakerEndorserOfNoteIndicator) ?? bool(b.undisclosedComakerOfNoteIndicator),
    hasOutstandingJudgments: bool(b.outstandingJudgementsIndicator),
    isDelinquentOnFederalDebt: bool(b.presentlyDelinquentIndicatorUrla) ?? bool(b.presentlyDelinquentIndicator),
    isPartyToLawsuit: bool(b.partyToLawsuitIndicatorUrla) ?? bool(b.partyToLawsuitIndicator),
    hadTitleConveyedInLieu: bool(b.priorPropertyDeedInLieuConveyedIndicator),
    hadPreForeclosureSale: bool(b.priorPropertyShortSaleCompletedIndicator),
    hadPropertyForeclosed: bool(b.priorPropertyForeclosureCompletedIndicator)
      ?? bool(b.propertyForeclosedPastSevenYearsIndicator),
    hasDeclaredBankruptcy: bool(b.bankruptcyIndicator),
    bankruptcyChapters: chapters.length ? chapters.join(', ') : null,
  };

  // A borrower who answered NOTHING has not made a declaration, and filing an
  // all-null row would put an "answered" tick on their §5 on every screen that
  // asks whether they have one.
  const answered = Object.values(row).filter((v) => v !== null).length;
  return answered ? row : null;
}

const EMPLOYMENT_FIELDS = {
  employerName: 'employerName',
  position: 'positionDescription',
  employerStreet: 'addressStreetLine1',
  employerCity: 'addressCity',
  employerState: 'addressState',
  employerZip: 'addressPostalCode',
  employerPhone: 'phoneNumber',
};

/**
 * Where a person works (§1b–§1d).
 *
 * Largely NOT APPLICABLE on this book — the tenant's own "employment does not
 * apply" flag is true on 98% of long-term files, because a DSCR loan qualifies on
 * the property's cash flow rather than on personal income. It is mirrored anyway
 * because the 2% is real, the screen has a section for it, and an empty section on
 * the files that DO have a job is the same failure as an empty Property tab.
 *
 * CURRENT versus PREVIOUS comes from Encompass's own indicator, and an employment
 * whose indicator is UNANSWERED is filed as `current` — the enum's default, and
 * the reading that keeps a job on the screen rather than hiding it in a history
 * nobody opens. `additional` is never assigned: the tenant marks a second current
 * job with the same indicator as the first, so choosing between them here would
 * be our guess rather than its answer.
 */
function readEmployments(borrower) {
  if (!borrower || typeof borrower !== 'object') return [];
  const list = Array.isArray(borrower.employment) ? borrower.employment : [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const name = text(e.employerName);
    if (!name) continue;
    const row = {
      encompassId: text(e.id),
      employmentType: bool(e.currentEmploymentIndicator) === false ? 'previous' : 'current',
      isSelfEmployed: bool(e.selfEmployedIndicator) === true,
      ownershipPct: num(e.businessOwnedPercent),
      startDate: text(e.employmentStartDate) || text(e.startDate),
      endDate: text(e.endDate),
      monthlyBaseIncome: num(e.basePayAmount),
      monthlyOvertimeIncome: num(e.overtimeAmount),
      monthlyBonusIncome: num(e.bonusAmount),
      monthlyCommissionIncome: num(e.commissionsAmount),
      monthlyOtherIncome: num(e.otherAmount),
    };
    for (const [key, path] of Object.entries(EMPLOYMENT_FIELDS)) row[key] = text(e[path]);
    out.push(row);
  }
  return out;
}

module.exports = {
  readSubjectProperty,
  readBorrowerPairs,
  readParty,
  readDeclarations,
  readEmployments,
  readResidences,
  readOtherIncomes,
  readReoProperties,
  readAssets,
  readLiabilities,
  SUBJECT_FIELDS,
  PARTY_FIELDS,
  _internals: { num, text, int, bool, at, fieldOf, partyValue, ssnLast4, ownerRole, acctLast4, durationMonths },
};

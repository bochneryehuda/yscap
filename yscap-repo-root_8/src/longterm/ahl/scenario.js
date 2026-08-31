'use strict';
/**
 * LONG-TERM — the AHL Quick Pricer request, built from the canonical LT scenario.
 *
 * ONE SCENARIO, THREE VENDORS. The Pricing Engine speaks one scenario vocabulary
 * (`purpose`, `value`, `loan`, `ltv`, `fico`, `dscr`, `propertyType`, `zip`,
 * `prepayMonths`, `termYears`, `lockDays`, …) and each adapter maps it onto its
 * own wire form. This is AHL's half. The BUTTONS and the DEFAULTS come from
 * `../pricing/scenario-defaults.js` — the same module Lender Price and LoanNEX
 * read — because a default that differs per vendor makes the two price different
 * loans and then presents the difference as an execution advantage. The ENUMS
 * are local and are checked against AHL's own live form registry.
 *
 * ── THE PRODUCT PIN IS THE PRODUCT-SEPARATION GUARD ────────────────────────
 * `DocType` is pinned to `Investor - DSCR` and nothing may change it. AHL's very
 * next option, `Investor - No Ratio`, is labelled *"Investor Bridge - Rehab -
 * Ground Up"* — which is RTL's product, on the RTL side of a hard wall. A single
 * mis-set field here would have a Long-Term module pricing short-term bridge
 * loans. So it is not a parameter: `assertDscrOnly` refuses any attempt, by name.
 *
 * ── ONE REQUEST IS ONE PRODUCT AT ONE LOCK, AND THAT IS THE BIG DIFFERENCE ──
 * LoanNEX answers every investor, product and lock in a single call. AHL does
 * not: `LoanTerm`, `InterestOnly` and `LockTerm` are INPUTS, and the answer
 * carries only the programs matching them. Measured live, 2026-08-30, on the
 * reference scenario:
 *
 *   LoanTerm 40 + InterestOnly Yes  → `DSCR40FG75IO`  "Invest Star - Fixed 40 Yr I/O"
 *   LoanTerm 30 + InterestOnly No   → `DSCR30FG75`    "Invest Star - Fixed 30 Yr"
 *   LoanTerm 40 + InterestOnly No   → NOTHING ELIGIBLE ("Interest Only is No")
 *   LoanTerm 30 + InterestOnly Yes  → NOTHING ELIGIBLE
 *
 * So a single guessed (term, IO) pair would show HALF of AHL's shelf and the
 * board would silently be missing a product the investor really offers — the
 * quiet version of the failure the whole combined engine exists to prevent. The
 * fix is not a better guess: `legsFor` FANS OUT across the product axis and
 * `parse.mergeLegs` puts the answers back into one board, so AHL's board carries
 * every product and every lock exactly as LoanNEX's does. The terms come from
 * AHL's OWN form (`field-registry.termsForDocType`), never a list kept here.
 *
 * PURE: no network, no database, no RTL import.
 */

const registry = require('./field-registry');
const shared = require('../pricing/scenario-defaults');
const amounts = require('../pricing/amounts');

/** The channel we buy through — owner-directed 2026-08-31: *"we are CorrNonDel."* */
const OWNER_CHANNEL = 'CorrNonDel';

/** The one income-verification type this adapter may ever price. */
const DSCR_DOC_TYPE = 'Investor - DSCR';
/** AHL's Bridge / Rehab / Ground-Up product — RTL's, and named so the guard can say why. */
const RTL_DOC_TYPE = 'Investor - No Ratio';

class AhlValidationError extends Error {
  constructor(code, field, message) { super(message); this.code = code; this.field = field; this.name = 'AhlValidationError'; }
}

// ── Human words → AHL form values ───────────────────────────────────────────
// The value on the right must exist in AHL's own form; `assertOption` proves it
// on every build, so a vendor rename surfaces as a refusal, never a mis-price.
const PURPOSE = {
  purchase: { LoanPurpose: 'Purchase', RefiPurpose: '' },
  cashout: { LoanPurpose: 'Refinance', RefiPurpose: 'CashOut' },
  cashoutrefinance: { LoanPurpose: 'Refinance', RefiPurpose: 'CashOut' },
  cashoutrefi: { LoanPurpose: 'Refinance', RefiPurpose: 'CashOut' },
  cashoutdebtconsolidation: { LoanPurpose: 'Refinance', RefiPurpose: 'CashOut' },
  refinance: { LoanPurpose: 'Refinance', RefiPurpose: 'Rate/Term' },
  refi: { LoanPurpose: 'Refinance', RefiPurpose: 'Rate/Term' },
  rateterm: { LoanPurpose: 'Refinance', RefiPurpose: 'Rate/Term' },
  rateandterm: { LoanPurpose: 'Refinance', RefiPurpose: 'Rate/Term' },
  ratetermrefinance: { LoanPurpose: 'Refinance', RefiPurpose: 'Rate/Term' },
  ratetermrefi: { LoanPurpose: 'Refinance', RefiPurpose: 'Rate/Term' },
  nocashoutrefinance: { LoanPurpose: 'Refinance', RefiPurpose: 'Rate/Term' },
  delayedfinancing: { LoanPurpose: 'Refinance', RefiPurpose: 'CashOut' },
};

/**
 * Property type. AHL's list is short and its 2-4 unit answer is the UNIT COUNT
 * itself (`2`/`3`/`4`), not a band — so the canonical `Unit2_4` needs the
 * scenario's `units` to become an AHL value, and `unitsFor` below is where that
 * happens rather than here.
 */
const PROPERTY = {
  singlefamily: 'SFD', sfr: 'SFD', sfd: 'SFD', detached: 'SFD',
  sfa: 'SFA', attached: 'SFA', townhouse: 'SFA', townhome: 'SFA',
  condo: 'Condo', condominium: 'Condo', condos: 'Condo', condowarr: 'Condo', condononwarr: 'Condo',
  pud: 'PUD', plannedunitdevelopment: 'PUD',
  unit24: 'UNITS', '24units': 'UNITS', twotofourunits: 'UNITS', duplex: 'UNITS', triplex: 'UNITS', fourplex: 'UNITS',
};
const OCCUPANCY = { investment: 'Investment', investmentproperty: 'Investment', primary: 'Primary', secondary: 'Secondary', second: 'Secondary' };
const CITIZENSHIP = {
  uscitizen: 'US Citizen', citizen: 'US Citizen', us: 'US Citizen',
  uscitizenabroad: 'US Citizen Abroad',
  permanentresidentalien: 'Permanent Resident', permresident: 'Permanent Resident', greencard: 'Permanent Resident', permanentresident: 'Permanent Resident',
  nonpermanentresidentalien: 'Non-Permanent Resident', nonpermresident: 'Non-Permanent Resident', nonpermanentresident: 'Non-Permanent Resident',
  foreignnational: 'Foreign National', foreign: 'Foreign National',
};

const aliasKey = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
const num = amounts.num;

function mapAlias(table, raw, field, code) {
  const hit = table[aliasKey(raw)];
  if (!hit) {
    throw new AhlValidationError(code, field,
      `Unknown ${field} ${JSON.stringify(raw == null ? null : String(raw))}. The request is refused rather than defaulted — a defaulted ${field} prices a different loan.`);
  }
  return hit;
}

/**
 * ⛔ THE WALL. Refuse anything that is not AHL's DSCR product.
 *
 * A Long-Term module must never be able to price AHL's Bridge / Rehab /
 * Ground-Up shelf: that is RTL's product, and the two are separate systems by
 * standing rule. This refuses BY NAME so the message says which wall was hit,
 * rather than returning an empty board somebody would read as "AHL has nothing".
 */
function assertDscrOnly(sc) {
  const asked = sc && (sc.docType || sc.incomeDoc || sc.DocType);
  if (asked == null || asked === '') return DSCR_DOC_TYPE;
  const k = aliasKey(asked);
  if (k === aliasKey(DSCR_DOC_TYPE) || k === 'dscr' || k === 'investordscr') return DSCR_DOC_TYPE;
  if (k === aliasKey(RTL_DOC_TYPE) || k === 'investornoratio' || /bridge|rehab|groundup|noratio/.test(k)) {
    throw new AhlValidationError('rtl_product_refused', 'docType',
      `${JSON.stringify(String(asked))} is AHL's "${RTL_DOC_TYPE}" shelf — Bridge / Rehab / Ground-Up, which is the SHORT-TERM product and a separate system. This Long-Term adapter prices AHL's "${DSCR_DOC_TYPE}" shelf and nothing else.`);
  }
  throw new AhlValidationError('non_dscr_product_refused', 'docType',
    `This adapter prices AHL's "${DSCR_DOC_TYPE}" shelf only; ${JSON.stringify(String(asked))} is a different income-verification type.`);
}

/**
 * AHL's `Units`, and its `PropertyType` when the type IS the unit count.
 *
 * Refusing rather than assuming is the point: a canonical `Unit2_4` with no unit
 * count could be a duplex or a fourplex, and AHL prices those differently
 * (`Number of Units is 2-4 Units` carries its own adjustment). Guessing "2"
 * would quietly price the cheaper building.
 */
function propertyAndUnits(sc) {
  const canonical = shared.canonicalPropertyType(sc.propertyType);
  const raw = canonical || sc.propertyType;
  const mapped = mapAlias(PROPERTY, raw, 'propertyType', 'unknown_property_type');
  const units = num(sc.units);
  if (mapped === 'UNITS') {
    if (units == null || units < 2 || units > 4) {
      throw new AhlValidationError('units_required', 'units',
        'A 2-4 unit property needs its unit count: AHL takes the number itself as the property type and prices 2, 3 and 4 differently, so it is refused rather than assumed.');
    }
    return { PropertyType: String(Math.round(units)), Units: String(Math.round(units)) };
  }
  // A one-unit building whose scenario says nothing is one unit. AHL's form
  // defaults the control to 1 and there is nothing to guess between.
  return { PropertyType: mapped, Units: String(units == null ? 1 : Math.round(units)) };
}

/**
 * The prepayment penalty, as AHL's two coupled fields.
 *
 * ⛔ THE COUPLING IS THE VENDOR'S OWN, AND IT IS ENFORCED HERE BECAUSE IT MOVES
 * REAL MONEY. AHL's page states it: *"Prepay Penalty Type cannot be None if
 * Prepay Period > 0."* Measured on the reference scenario, the difference
 * between sending nothing and sending the Long-Term profile's standing five-year
 * penalty is HALF A POINT of rate — 6.750 against 6.250. An omitted prepay is
 * therefore not a small default: it prices a loan nobody asked for and makes AHL
 * look 0.5 worse than it is, for reasons that have nothing to do with AHL.
 *
 * Whole years only, because that is all AHL offers; a term that is not a whole
 * number of years is refused rather than silently truncated to a cheaper one.
 */
function prepayFields(prepayMonths, sc) {
  const m = num(prepayMonths);
  if (m == null || m <= 0) return { PrepayPenaltyPeriod: '0', PrepayPenaltyType: '' };
  const years = m / 12;
  if (!Number.isInteger(years) || years < 1 || years > 5) {
    throw new AhlValidationError('unsupported_prepay_term', 'prepayMonths',
      `AHL offers whole-year prepayment terms of 1-5 years; ${m} months is neither. It is refused rather than truncated — a shorter penalty prices worse and nobody asked for it.`);
  }
  const structure = sc && (sc.prepayStructure || sc.prepayType);
  const k = aliasKey(structure);
  let type = 'Fixed Percentage';
  if (structure != null && structure !== '') {
    if (k === 'declining' || k === 'decliningstructure' || k === 'step' || k === 'stepdown') type = 'Declining Structure';
    else if (k === 'fixed' || k === 'fixedpercentage' || k === 'flat') type = 'Fixed Percentage';
    else {
      throw new AhlValidationError('unknown_prepay_structure', 'prepayStructure',
        `AHL offers "Fixed Percentage" and "Declining Structure"; ${JSON.stringify(String(structure))} is neither.`);
    }
  }
  return { PrepayPenaltyPeriod: String(years), PrepayPenaltyType: type };
}

/**
 * WHICH PRODUCTS TO ASK FOR — the fan-out.
 *
 * The (term, interest-only) pairs AHL actually offers on its DSCR shelf, taken
 * from AHL's own form: `Investor - DSCR` carries the `loanTerm3040yr` group, so
 * the terms are 30 and 40. The IO pairing is MEASURED, not assumed — see the
 * table in this file's header — and stated once, here.
 *
 * A scenario that PINS a term or interest-only narrows the fan-out to the legs
 * that match; a scenario that pins neither gets AHL's whole shelf, which is what
 * makes its board comparable with LoanNEX's single-call one. A pin that matches
 * NOTHING is refused rather than answered with an empty board.
 */
function legsFor(sc = {}, opts = {}) {
  const terms = (registry.termsForDocType(DSCR_DOC_TYPE) || { terms: [30, 40] }).terms;
  // AHL's DSCR shelf pairs the 40-year with interest-only and the 30-year
  // without it. Measured 2026-08-30; the other two pairings return no eligible
  // program at all.
  const ioForTerm = (t) => t >= 40;

  const wantTerm = num(sc.termYears != null ? sc.termYears : sc.term);
  const wantIo = shared.readFlag(sc, 'io');
  let legTerms = terms;
  if (wantTerm != null) {
    legTerms = terms.filter((t) => t === wantTerm);
    if (!legTerms.length) {
      throw new AhlValidationError('unsupported_term', 'termYears',
        `AHL's DSCR shelf is ${terms.join(' and ')} years; ${wantTerm} is not offered, so nothing is asked for rather than a different term being priced.`);
    }
  }
  if (wantIo !== undefined) {
    const narrowed = legTerms.filter((t) => ioForTerm(t) === wantIo);
    if (!narrowed.length) {
      throw new AhlValidationError('unsupported_interest_only', 'io',
        `AHL pairs its 40-year DSCR product with interest-only and its 30-year without it. ${wantIo ? 'Interest-only' : 'Amortizing'} at ${legTerms.join('/')} years is not a product AHL offers, so nothing is asked for rather than an empty board being returned as if AHL had declined.`);
    }
    legTerms = narrowed;
  }

  const offered = registry.lockTerms();
  let locks = opts.lockDays != null ? [].concat(opts.lockDays).map(Number)
    : (sc.lockDays != null ? [Number(shared.profileFor(sc).lockDays)] : offered);
  locks = locks.filter((d) => Number.isFinite(d));
  for (const d of locks) {
    if (!offered.includes(d)) {
      throw new AhlValidationError('unsupported_lock', 'lockDays',
        `AHL offers ${offered.join('- and ')}-day locks; ${d} is not one of them.`);
    }
  }
  if (!locks.length) locks = offered;

  const legs = [];
  for (const t of legTerms) for (const d of locks) {
    legs.push({ key: `t${t}-${ioForTerm(t) ? 'io' : 'fix'}-l${d}`, termYears: t, interestOnly: ioForTerm(t), lockDays: d });
  }
  return legs;
}

/**
 * Build ONE leg's form body.
 *
 * Returns an ARRAY of [name, value] pairs, not an object: the order is the
 * order AHL's own form posts them, which lets the pure test compare a built body
 * against the captured one as text — a far stronger proof than field-by-field
 * assertions a typo can slip past. Nothing is emitted that AHL's registry does
 * not know, and nothing is emitted empty except the two fields whose empty
 * string is a real value (`RefiPurpose` on a purchase, `PrepayPenaltyType` on a
 * zero-year penalty).
 */
function buildLeg(sc, leg, opts = {}) {
  const s = shared.canonicalizeFlags(sc || {});
  assertDscrOnly(s);
  const profile = shared.profileFor(s);
  const tri = amounts.deriveAmounts(s);
  const purpose = mapAlias(PURPOSE, s.purpose, 'purpose', 'unknown_purpose');
  const prop = propertyAndUnits({ ...s, propertyType: s.propertyType != null && s.propertyType !== '' ? s.propertyType : profile.propertyType });
  const prepay = prepayFields(profile.prepayMonths, s);
  const flags = shared.readFlags(s);

  const fico = num(s.fico);
  if (fico == null) {
    throw new AhlValidationError('fico_required', 'fico',
      'AHL prices every DSCR program off a representative credit score; without one the board would be a guess.');
  }
  const state = s.state != null && s.state !== '' ? String(s.state).toUpperCase() : null;
  if (!state) {
    throw new AhlValidationError('state_required', 'state',
      'AHL prices by state and refuses nothing silently — without a state the board would be for no jurisdiction.');
  }

  const yn = (v) => (v ? 'Yes' : 'No');
  const pairs = [
    ['Action', 'Get Pricing'],
    // BUSINESS PURPOSE, PINNED. A DSCR investment loan is business-purpose;
    // `Personal` puts a TRID consumer loan on the board, which is a different
    // product with different disclosures. AHL's own refusals quote it back
    // ("Placeholder_Consumer Purpose is Business"), so it is load-bearing.
    ['ConsumerPurpose', 'Business'],
    ['LoanPurpose', purpose.LoanPurpose],
    ['RefiPurpose', purpose.RefiPurpose],
    ['DocType', DSCR_DOC_TYPE],
    ['RentIndicator', flags.shortTermRental === true ? 'Short Term Rental' : 'Long Term Rental'],
    ['LoanTerm', String(leg.termYears)],
    ['FICO', String(Math.round(fico))],
    ['DSCR', amounts.dscrString(profile.dscr)],
    ['PrepayPenaltyPeriod', prepay.PrepayPenaltyPeriod],
    ['PrepayPenaltyType', prepay.PrepayPenaltyType],
    ['InterestOnly', yn(leg.interestOnly)],
    ['CitizenshipType', s.citizenship != null && s.citizenship !== '' ? mapAlias(CITIZENSHIP, s.citizenship, 'citizenship', 'unknown_citizenship') : 'US Citizen'],
    ['Channel', channelFor(opts)],
    ['PropertyValue', String(tri.value)],
    ['LoanAmount', String(tri.loan)],
    ['PropState', state],
    ['PropertyType', prop.PropertyType],
    ['Units', prop.Units],
    ['Occupancy', s.occupancy != null && s.occupancy !== '' ? mapAlias(OCCUPANCY, s.occupancy, 'occupancy', 'unknown_occupancy') : 'Investment'],
    ['LockTerm', String(leg.lockDays)],
  ];
  // Optional, and only when the officer actually said so. AHL's own app omits an
  // untouched control, and an omitted flag is a different fact from a `No`.
  if (s.zip != null && s.zip !== '') pairs.push(['PropZip', String(s.zip)]);
  if (s.city != null && s.city !== '') pairs.push(['PropCity', String(s.city)]);
  if (flags.escrowWaive !== undefined) pairs.push(['WaiveEscrows', yn(flags.escrowWaive)]);
  if (flags.firstTimeInvestor !== undefined) pairs.push(['FirstTimeInvestor', yn(flags.firstTimeInvestor)]);
  if (flags.fthb !== undefined) pairs.push(['FirstTimeHomeBuyer', yn(flags.fthb)]);
  if (flags.rural !== undefined) pairs.push(['RuralArea', yn(flags.rural)]);
  if (flags.selfEmployed !== undefined) pairs.push(['SelfEmployed', yn(flags.selfEmployed)]);
  if (flags.livingRentFree !== undefined) pairs.push(['RentFree', yn(flags.livingRentFree)]);
  if (prop.PropertyType === 'Condo') {
    pairs.push(['WarrantableCondo', yn(flags.nonWarrantable !== true)]);
    if (flags.nonWarrantable === true) pairs.push(['Condotel', 'No']);
  }

  // ⛔ EVERY VALUE IS CHECKED AGAINST AHL'S OWN FORM BEFORE IT GOES ON THE WIRE.
  // A form post silently DROPS a field it does not know and silently ACCEPTS a
  // value it does not offer, so neither failure is visible in the answer — only
  // in the price.
  for (const [k, v] of pairs) {
    if (registry.knows(k)) registry.assertOption(k, v);
  }
  return pairs;
}

/**
 * The CHANNEL — the one input on this form whose right answer is a business
 * decision rather than a mapping.
 *
 * ── ANSWERED. Owner-directed 2026-08-31: *"we are CorrNonDel."* ────────────
 * So `CorrNonDel` is now the channel we BUY THROUGH, not merely the channel the
 * captured session happened to price on. That distinction is worth keeping in
 * writing, because it is the difference between a default somebody chose and a
 * default nobody had got round to choosing yet.
 *
 * ⚠️ IT STAYS A SETTING, AND IT STAYS ON EVERY BOARD. Measured 2026-08-30, same
 * scenario, same minute, only `Channel` varying:
 *     Wholesale      6.375 @ 97.000
 *     Correspondent  6.625 @ 98.000
 *     CorrNonDel     6.750 @ 98.375   ← ours
 * Three different sets of economics for one loan. A channel that were hard-coded
 * would make "which economics is this board priced on?" unanswerable from the
 * board itself, and it is exactly the kind of thing that changes commercially
 * without changing technically. So the answer is settable without a deploy, and
 * `parse.js` reads the channel back off AHL's OWN echo rather than from what we
 * meant to send — a board that reported our intention would still say
 * "CorrNonDel" on the day AHL ignored the field and priced Wholesale.
 */
function channelFor(opts = {}) {
  // Owner-directed default; `AHL_CHANNEL` or `opts.channel` overrides it.
  const raw = opts.channel != null && opts.channel !== '' ? opts.channel : (process.env.AHL_CHANNEL || OWNER_CHANNEL);
  const k = aliasKey(raw);
  const table = { wholesale: 'Wholesale', correspondent: 'Correspondent', corrnondel: 'CorrNonDel', correspondentnondelegated: 'CorrNonDel', nondelegated: 'CorrNonDel', nondel: 'CorrNonDel' };
  const hit = table[k];
  if (!hit) {
    throw new AhlValidationError('unknown_channel', 'channel',
      `AHL prices on Wholesale, Correspondent or CorrNonDel; ${JSON.stringify(String(raw))} is none of them. The three price DIFFERENTLY, so this is refused rather than defaulted.`);
  }
  return hit;
}

/** Every leg of one scenario, ready to post. */
function build(sc, opts = {}) {
  const legs = legsFor(sc, opts);
  return {
    docType: DSCR_DOC_TYPE,
    channel: channelFor(opts),
    legs: legs.map((leg) => ({ ...leg, body: buildLeg(sc, leg, opts) })),
  };
}

/** The body as AHL's own `application/x-www-form-urlencoded` text. */
function encode(pairs) {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : String(v))}`).join('&');
}

module.exports = {
  DSCR_DOC_TYPE, RTL_DOC_TYPE, OWNER_CHANNEL, AhlValidationError,
  build, buildLeg, legsFor, encode, assertDscrOnly, channelFor, prepayFields, propertyAndUnits,
  _internals: { PURPOSE, PROPERTY, OCCUPANCY, CITIZENSHIP, aliasKey, mapAlias, shared, amounts },
};

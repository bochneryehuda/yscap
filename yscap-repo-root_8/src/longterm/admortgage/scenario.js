'use strict';
/**
 * LONG-TERM — the A&D MORTGAGE (AIM) pricing request, built from the canonical
 * LT scenario.
 *
 * ONE SCENARIO, THREE VENDORS. The Pricing Engine speaks one vocabulary
 * (`purpose`, `loan`, `ltv`, `fico`, `dscr`, `propertyType`, `prepayMonths`, …).
 * Each adapter maps it onto its own wire form. This is AIM's third of that, and
 * it deliberately shares no enum table with the other two: three vendors' words
 * that agree today are not one fact.
 *
 * WHAT IS SHARED is `../pricing/scenario-defaults.js` — the buttons and the
 * PROFILE. That module exists because before it each adapter read the scenario
 * with its own field names and a caller who set a button got it on one vendor
 * and not another, so the programs priced DIFFERENT LOANS and the difference
 * read as a pricing advantage. This adapter reads the same `readFlags` and the
 * same `DSCR_PROFILE` as the other two, so an omitted prepay is 60 months here
 * exactly as it is there.
 *
 * ── EVERY FIELD IS SENT, EVERY TIME ────────────────────────────────────────
 * AIM is not a partial-body API: FICO omitted is `422 "Required property is
 * missing"`. So a request is ALWAYS the group's own published defaults with the
 * scenario overlaid — never a hand-built subset. `defaults()` supplies the
 * baseline and this module overwrites only what the scenario states. That also
 * means a field AIM adds tomorrow arrives with AIM's own default rather than
 * being silently dropped.
 *
 * ── THE THREE THAT ARE OURS, NOT THE BORROWER'S ────────────────────────────
 * Channel, Compensation type and Lock Period are not facts about the loan; they
 * are facts about how WE trade with A&D. They are stated here as named business
 * defaults (`BUSINESS_DEFAULTS`) rather than left to AIM's, so that changing the
 * channel we price on is a visible edit to one line rather than a silent
 * inheritance. Every one is overridable by the scenario.
 *
 * ── FAIL CLOSED, ALWAYS ────────────────────────────────────────────────────
 * A canonical value AIM does not offer is REFUSED BY NAME and the caller gets a
 * 422 listing what AIM does offer. Four canonical property types have no AIM
 * equivalent at all (Townhouse, Cooperative, Modular, ManufacturedHousing,
 * MultiFamily) — they are refused rather than folded into the nearest box,
 * because "nearest" is how a 5-unit building gets quoted as a duplex.
 *
 * READ-ONLY. This builds a PRICING request. Nothing here locks, registers or books.
 *
 * PURE: no network, no database, no RTL import.
 */

const S = require('./schema');
const defaults = require('../pricing/scenario-defaults');

/* ── canonical value -> AIM's own option LABEL ───────────────────────────────
 * Keys are squashed canonical words; values are AIM labels verbatim. The label
 * is then looked up in the LIVE schema, so a label AIM renames fails loudly
 * here instead of pricing something else.                                     */

const OCCUPANCY = {
  investment: 'Investment', investor: 'Investment', nonowneroccupied: 'Investment',
  primary: 'Primary Residence', primaryresidence: 'Primary Residence', owneroccupied: 'Primary Residence',
  secondhome: '2nd Home', second: '2nd Home', vacation: '2nd Home',
};

// AIM offers SEVEN property types. Everything else the canonical vocabulary can
// say is deliberately absent — see the header.
const PROPERTY = {
  singlefamily: '1 Unit SFR',
  pud: 'PUD',
  condo: 'Condo',
  condotel: 'Condotel',
  unit24: '2-4 Units',
};
// Rural is not a separate canonical type — it is a FLAG that upgrades the type,
// because AIM models it as two distinct property types rather than a toggle.
const PROPERTY_RURAL = { singlefamily: 'SFR Rural', pud: 'PUD Rural' };

const PURPOSE = {
  purchase: 'Purchase',
  ratetermrefinance: 'Rate/Term Refinance', ratetermrefi: 'Rate/Term Refinance',
  rateterm: 'Rate/Term Refinance', refinance: 'Rate/Term Refinance', rt: 'Rate/Term Refinance',
  cashout: 'Cashout', cashoutrefinance: 'Cashout', cashoutrefi: 'Cashout',
};

const CITIZENSHIP = {
  uscitizen: 'US Citizen / Permanent Resident', citizen: 'US Citizen / Permanent Resident',
  permanentresident: 'US Citizen / Permanent Resident', pr: 'US Citizen / Permanent Resident',
  nonpermanentresident: 'Non-Permanent Resident', nonpermresident: 'Non-Permanent Resident',
  foreignnational: 'Foreign national', foreign: 'Foreign national',
  itin: 'ITIN',
};

const CHANNEL = { wholesale: 'Wholesale', correspondentplus: 'Correspondent Plus', correspondent: 'Correspondent' };
const COMP = { borrowerpaid: 'Borrower Paid', borrower: 'Borrower Paid', lenderpaid: 'Lender Paid', lender: 'Lender Paid' };
const MORTGAGE_HISTORY = { '0x30x24': '0x30x24', '0x30x12': '0x30x12', '0x60x12': '0x60x12' };
const CREDIT_EVENT = { '48': '48+ months', '48months': '48+ months', none: '48+ months', '3648': '36 - 48 months', '36': '< 36 months' };
const BUYDOWN = { none: 'None', '321': '3-2-1', '21': '2-1', '10': '1-0' };

/** Loan term -> AIM's Loan Term label. Months or years, and the two ARMs. */
const TERM = {
  30: '30 Year Fixed', 360: '30 Year Fixed',
  40: '40 Year Fixed', 480: '40 Year Fixed',
};
const ARM = { '56': '5/6 ARM SOFR', '5/6': '5/6 ARM SOFR', '76': '7/6 ARM SOFR', '7/6': '7/6 ARM SOFR' };

/** Lock days -> AIM's Lock Period label. AIM offers exactly four. */
const LOCK = { 15: '15 Days', 30: '30 Days', 45: '45 Days', 60: '60 Days' };

/**
 * Prepay MONTHS -> AIM's Prepayment Penalty label.
 *
 * 0 IS "No PPP" AND MUST SURVIVE. A caller who states a no-prepay deal states 0,
 * and `withDefault` is nullish-guarded precisely so that 0 does not silently
 * become the 60-month profile default. AIM's own ladder measures the difference
 * at nearly half a point of rate, so getting this wrong is not cosmetic.
 */
const PREPAY = { 0: 'No PPP', 6: '6m PPP', 12: '1Y PPP', 24: '2Y PPP', 36: '3Y PPP', 48: '4Y PPP', 60: '5Y PPP' };

/**
 * DSCR RATIO -> AIM's Income Type option.
 *
 * AIM TAKES NO NUMERIC DSCR. The ratio is bucketed into one of five income
 * types, and the bucket is the only thing the wire carries.
 *
 * ROUNDED TO 2dp FIRST, because the published bands are contiguous only after
 * rounding — AIM's labels leave a seam between 1.24 and 1.25, and between 0.99
 * and 1.00. ⚠️ THAT ROUNDING RULE IS OURS, NOT AIM'S: a deal landing exactly on
 * a seam (1.245, 0.995) is banded by a convention A&D has not confirmed. It is
 * recorded in the field map as an open question rather than presented as
 * measured, and `dscrBand` is the one place it would change.
 */
const DSCR_BANDS = [
  { min: 1.25, label: 'DSCR >= 1.25' },
  { min: 1.10, label: 'DSCR 1.10 - 1.24' },
  { min: 1.00, label: 'DSCR 1.00 - 1.09' },
  { min: 0.75, label: 'DSCR 0.75 - 0.99' },
  { min: -Infinity, label: 'DSCR < 0.75' },
];
function dscrBandLabel(ratio) {
  const n = Number(ratio);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 100) / 100;
  return (DSCR_BANDS.find((b) => r >= b.min) || DSCR_BANDS[DSCR_BANDS.length - 1]).label;
}

/** Non-DSCR income documentation -> AIM's Income Type. DSCR is handled by the bands. */
const INCOME_DOC = {
  fulldoc: '2Y Full Doc', fulldoc2y: '2Y Full Doc', '2yfulldoc': '2Y Full Doc',
  '1yfulldoc': '1Y Full Doc', fulldoc1y: '1Y Full Doc',
  bankstatement24: '24 Months Bank Statement', bankstatement: '24 Months Bank Statement',
  bankstatement12: '12 Months Bank Statement',
  pl2y: '2Y P&L Only', pl1y: '1Y P&L Only',
  assetutilization: 'Asset Utilization', assetdepletion: 'Asset Utilization',
  wvoe: 'WVOE', '1099': '1099', foreignincome: 'Foreign income',
};

/**
 * WHAT WE TRADE ON, not what the borrower is. Overridable per scenario.
 * `Wholesale` is the channel `auth-state` reports for this account.
 */
const BUSINESS_DEFAULTS = { channel: 'Wholesale', compType: 'Borrower Paid' };

const k = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9/]/g, '');
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/** AIM's booleans are options LABELLED "0" and "1" — not JSON booleans. */
const boolLabel = (v) => (v ? '1' : '0');

/**
 * Build the AIM query parameters for a scenario.
 *
 * Returns `{ params, problems, notes, effective }`. `problems` is never
 * swallowed: the route 422s on any entry, so a scenario is either priced as
 * asked or refused by name — it is never quietly priced as something else.
 */
function buildParams(scenario = {}, schemaFields, opts = {}) {
  const idx = S.indexSchema(schemaFields);
  const params = { ...S.defaults(schemaFields) };
  const problems = [];
  const notes = [];
  const effective = {};

  const sc = { ...scenario };
  const flags = defaults.readFlags(sc);
  const profile = defaults.DSCR_PROFILE;
  const want = (v, d) => (v == null || v === '' ? d : v);

  /** Set one option-valued field, recording a refusal rather than guessing. */
  const setOption = (fieldLabel, canonical, table, as) => {
    if (canonical == null || canonical === '') return;
    const r = S.optionId(idx, fieldLabel, k(canonical), table);
    if (r.error) { problems.push({ ...r, as: as || fieldLabel }); return; }
    params[r.paramId] = String(r.id);
    effective[as || fieldLabel] = r.label;
  };
  const setInterval = (fieldLabel, raw, as) => {
    if (raw == null || raw === '') return;
    const r = S.intervalValue(idx, fieldLabel, raw);
    if (r.error) { problems.push({ ...r, as: as || fieldLabel }); return; }
    params[r.paramId] = String(r.value);
    effective[as || fieldLabel] = r.value;
  };
  const setSentinel = (fieldLabel, as) => {
    const r = S.sentinelValue(idx, fieldLabel);
    if (r.error) { problems.push({ ...r, as: as || fieldLabel }); return; }
    params[r.paramId] = '0';
    effective[as || fieldLabel] = r.means;
  };
  const setBool = (fieldLabel, v, as) => {
    if (v == null) return;
    const r = S.optionId(idx, fieldLabel, boolLabel(v), null);
    if (r.error) { problems.push({ ...r, as: as || fieldLabel }); return; }
    params[r.paramId] = String(r.id);
    effective[as || fieldLabel] = !!v;
  };

  // ── PROPERTY ────────────────────────────────────────────────────────────
  setOption('Occupancy', want(sc.occupancy, profile.occupancy), OCCUPANCY, 'occupancy');

  const canonProp = defaults.canonicalPropertyType(want(sc.propertyType, profile.propertyType));
  if (canonProp === null) {
    problems.push({ error: 'value_not_mapped', field: 'Property Type', value: String(sc.propertyType), as: 'propertyType' });
  } else if (canonProp !== undefined) {
    const rural = flags.rural === true;
    const table = rural && PROPERTY_RURAL[k(canonProp)] ? { [k(canonProp)]: PROPERTY_RURAL[k(canonProp)] } : PROPERTY;
    if (rural && !PROPERTY_RURAL[k(canonProp)]) notes.push('rural_not_expressible_for_this_property_type');
    setOption('Property Type', canonProp, table, 'propertyType');
  }

  if (sc.units != null) setOption('Number of Units', `${num(sc.units)}unit${num(sc.units) === 1 ? '' : 's'}`,
    { '1unit': '1 Unit', '2units': '2 Units', '3units': '3 Units', '4units': '4 Units' }, 'units');

  if (sc.zip != null && sc.zip !== '') {
    const entry = idx.get(S._internals.key('ZIP'));
    if (entry) { params[entry.field.id] = String(sc.zip); effective.zip = String(sc.zip); }
  }
  if (sc.state) setOption('State', sc.state, opts.stateAliases || null, 'state');
  setBool('Short Term Rental', flags.shortTermRental, 'shortTermRental');
  setBool('New Construction', sc.newConstruction, 'newConstruction');

  // ── BORROWER ────────────────────────────────────────────────────────────
  setOption('Citizenship', want(sc.citizenship, 'uscitizen'), CITIZENSHIP, 'citizenship');
  setOption('Purpose', want(sc.purpose, 'purchase'), PURPOSE, 'purpose');
  setInterval('FICO', sc.fico, 'fico');
  setBool('FTHB', flags.fthb, 'fthb');
  if (sc.mortgageHistory) setOption('Mortgage History', sc.mortgageHistory, MORTGAGE_HISTORY, 'mortgageHistory');
  if (sc.creditEvent != null) setOption('Credit Event', sc.creditEvent, CREDIT_EVENT, 'creditEvent');

  // ── INCOME + DTI: the pair that must move together ──────────────────────
  const incomeDoc = want(sc.incomeDoc, profile.incomeDoc);
  const isDscr = k(incomeDoc) === 'dscr';
  if (isDscr) {
    const ratio = defaults.withDefault(sc.dscr, profile.dscr);
    const band = dscrBandLabel(ratio);
    if (band == null) {
      problems.push({ error: 'not_a_number', field: 'Income Type', value: String(sc.dscr), as: 'dscr' });
    } else {
      setOption('Income Type', band, { [k(band)]: band }, 'incomeDoc');
      effective.dscrRatio = Math.round(Number(ratio) * 100) / 100;
      effective.dscrBand = band;
    }
    // ⛔ THE PAIRING IS THE WHOLE POINT. A DSCR income type with ANY numeric DTI
    // is a 400 from AIM ("change: DSCR >= 1.25 or DTI 00.00% - 43.00%"). The
    // sentinel is not optional here and is never left to the caller.
    setSentinel('DTI', 'dti');
  } else {
    setOption('Income Type', incomeDoc, INCOME_DOC, 'incomeDoc');
    if (sc.dti != null && sc.dti !== '') setInterval('DTI', sc.dti, 'dti');
  }

  // ── LOAN ────────────────────────────────────────────────────────────────
  const armKey = sc.armType ? k(sc.armType) : null;
  if (armKey && ARM[armKey]) setOption('Loan Term', armKey, ARM, 'term');
  else {
    const years = num(defaults.withDefault(sc.termYears, profile.termYears));
    const label = TERM[years] || TERM[num(sc.termMonths)] || null;
    if (label == null) problems.push({ error: 'value_not_offered', field: 'Loan Term', value: String(years), offered: Object.values(TERM).concat(Object.values(ARM)), as: 'term' });
    else setOption('Loan Term', label, { [k(label)]: label }, 'term');
  }

  setInterval('Loan Amount', sc.loan, 'loan');
  setInterval('CLTV', want(sc.cltv, sc.ltv), 'cltv');

  const lockDays = num(defaults.withDefault(sc.lockDays, profile.lockDays));
  const lockLabel = LOCK[lockDays];
  if (lockLabel == null) problems.push({ error: 'value_not_offered', field: 'Lock Period', value: String(lockDays), offered: Object.values(LOCK), as: 'lockDays' });
  else setOption('Lock Period', lockLabel, { [k(lockLabel)]: lockLabel }, 'lockDays');

  const prepay = num(defaults.withDefault(sc.prepayMonths, profile.prepayMonths));
  const prepayLabel = PREPAY[prepay];
  if (prepayLabel == null) problems.push({ error: 'value_not_offered', field: 'Prepayment Penalty', value: String(prepay), offered: Object.values(PREPAY), as: 'prepayMonths' });
  else setOption('Prepayment Penalty', prepayLabel, { [k(prepayLabel)]: prepayLabel }, 'prepayMonths');

  setBool('Interest Only', flags.io, 'io');
  setBool('Escrow Waiver', flags.escrowWaive, 'escrowWaive');
  if (sc.adminFeeBuyout != null) setBool('Admin Fee Buyout', sc.adminFeeBuyout, 'adminFeeBuyout');
  if (sc.buydown != null) setOption('Temporary Buydown', sc.buydown, BUYDOWN, 'buydown');

  // ── OURS, NOT THE BORROWER'S ────────────────────────────────────────────
  setOption('Channel', want(sc.channel, BUSINESS_DEFAULTS.channel), CHANNEL, 'channel');
  setOption('Compensation type', want(sc.compType, BUSINESS_DEFAULTS.compType), COMP, 'compType');

  return { params, problems, notes, effective };
}

/** The query string AIM's `calculate` and `restrictions` both take. */
function toQuery(params) {
  const q = new URLSearchParams();
  for (const [id, v] of Object.entries(params)) q.set(String(id), String(v));
  return q.toString();
}

module.exports = {
  buildParams, toQuery, dscrBandLabel,
  BUSINESS_DEFAULTS, DSCR_BANDS,
  _internals: { OCCUPANCY, PROPERTY, PROPERTY_RURAL, PURPOSE, CITIZENSHIP, CHANNEL, COMP, TERM, ARM, LOCK, PREPAY, INCOME_DOC, k, boolLabel },
};

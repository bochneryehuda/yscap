'use strict';

/**
 * The Condition Center's field registry — the single source of truth for every
 * field a condition rule can reference and every field an "information"
 * condition can ask the borrower to fill in.
 *
 * Each field:
 *   key          stable identifier stored inside rule_logic / field_key
 *   label        staff-facing name in the rule builder
 *   group        picker grouping
 *   type         money | number | percent | text | enum | boolean | date
 *   options      enum only: [{ v, label }] — canonical values stored in rules
 *   writable     may be the target of an info-field condition (the borrower's
 *                answer is written into the real column, not a side channel)
 *   borrowerLabel/borrowerHint   default borrower-facing wording for info
 *                conditions built on this field
 *
 * Reading is centralized in engine.loadRuleContext(); writing in
 * engine.writeFieldValue(). Raw DB values are normalized to the canonical enum
 * values below so rules keep matching however the data was originally typed
 * ("Refi Cash-Out", "Refinance — Cash-Out" → refinance_cash_out).
 */

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

function normState(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (US_STATES.includes(up)) return up;
  return STATE_NAMES[s.toLowerCase()] || null;
}

function normStrategy(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (/ground|construction(?!\s*&)/.test(s) && /ground|new/.test(s)) return 'ground_up';
  if (/dscr|rental|stabilized|long[-\s]?term|30[-\s]?year/.test(s)) return 'rental_dscr';
  if (/hold|brrrr/.test(s)) return 'fix_hold';
  if (/bridge/.test(s)) return 'bridge';
  if (/flip/.test(s)) return 'fix_flip';
  return 'other';
}

function normLoanPurpose(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (/cash[-\s]?out/.test(s)) return 'refinance_cash_out';
  if (/refi|rate\s*(&|and)?\s*term/.test(s)) return 'refinance_rate_term';
  if (/purchase|acquisition/.test(s)) return 'purchase';
  return 'other';
}

function normPropertyType(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (/mixed/.test(s)) return 'mixed_use';
  if (/condo/.test(s)) return 'condo';
  if (/town/.test(s)) return 'townhouse';
  if (/pud/.test(s)) return 'pud';
  if (/5\+|5 ?unit|multifamily 5|multi 5/.test(s)) return 'multi_5_plus';
  if (/2.?4|2 ?- ?4|duplex|triplex|fourplex|quad/.test(s)) return 'multi_2_4';
  if (/sfr|single/.test(s)) return 'sfr';
  return 'other';
}

function normRehabType(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (/ground/.test(s)) return 'ground_up';
  if (/adding|sq/.test(s)) return 'adding_sf';
  if (/heavy|gut/.test(s)) return 'heavy';
  if (/moderate/.test(s)) return 'moderate';
  if (/cosmetic|light/.test(s)) return 'cosmetic';
  return 'other';
}

function normCitizenship(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (/perm/.test(s)) return 'permanent_resident';
  if (/foreign/.test(s)) return 'foreign_national';
  if (/citizen|us|u\.s/.test(s)) return 'us_citizen';
  return 'other';
}

function normOccupancy(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (/invest/.test(s)) return 'investment';
  if (/second/.test(s)) return 'secondary';
  if (/prim/.test(s)) return 'primary';
  return 'other';
}

const stateOptions = US_STATES.map((v) => ({ v, label: v }));

// ---------------------------------------------------------------------------
// The registry. Order inside a group = picker order.
// ---------------------------------------------------------------------------
const FIELDS = [
  // ---- Loan & program ----
  { key: 'registered_program', label: 'Program (registered product)', group: 'Loan & program', type: 'enum',
    options: [{ v: 'standard', label: 'Standard Program' }, { v: 'gold', label: 'Gold Standard Program' }, { v: 'none', label: 'Not registered yet' }],
    description: 'The product program registered in the Term Sheet Studio.' },
  { key: 'program_strategy', label: 'Loan strategy (program)', group: 'Loan & program', type: 'enum',
    options: [
      { v: 'fix_flip', label: 'Fix & Flip' }, { v: 'fix_hold', label: 'Fix & Hold (BRRRR)' },
      { v: 'bridge', label: 'Bridge' }, { v: 'ground_up', label: 'Ground-Up Construction' },
      { v: 'rental_dscr', label: 'Rental / DSCR' }, { v: 'other', label: 'Other' }],
    description: 'The deal strategy on the file (normalized from the program text).' },
  { key: 'loan_purpose', label: 'Loan purpose', group: 'Loan & program', type: 'enum',
    options: [
      { v: 'purchase', label: 'Purchase' }, { v: 'refinance_rate_term', label: 'Refinance — Rate & Term' },
      { v: 'refinance_cash_out', label: 'Refinance — Cash-Out' }, { v: 'other', label: 'Other' }],
    description: 'Purchase vs. refinance (rate & term / cash-out).' },
  { key: 'loan_amount', label: 'Loan amount', group: 'Loan & program', type: 'money', writable: true,
    borrowerLabel: 'Requested loan amount', borrowerHint: 'Enter the total loan amount you are requesting.' },
  { key: 'ltv', label: 'LTV %', group: 'Loan & program', type: 'percent',
    description: 'Loan-to-value as registered on the file (0–100).' },
  { key: 'loan_to_arv', label: 'Loan / ARV % (computed)', group: 'Loan & program', type: 'percent',
    description: 'Loan amount divided by after-repair value (0–100). Computed live.' },
  { key: 'loan_to_cost', label: 'Loan / total cost % (computed)', group: 'Loan & program', type: 'percent',
    description: 'Loan amount ÷ (purchase price + rehab budget) (0–100). Computed live.' },
  { key: 'rate_pct', label: 'Note rate %', group: 'Loan & program', type: 'percent' },
  { key: 'requested_ir_months', label: 'Interest reserve months', group: 'Loan & program', type: 'number', writable: true,
    borrowerLabel: 'Requested interest reserve (months)', borrowerHint: 'How many months of interest reserve are you requesting? (0–24)' },
  { key: 'requested_ir_amount', label: 'Interest reserve amount ($)', group: 'Loan & program', type: 'money', writable: true,
    borrowerLabel: 'Requested interest reserve (exact $ amount)', borrowerHint: 'Request an exact dollar interest reserve instead of months. Capped at the full loan term; leave blank to size from months.' },
  { key: 'is_assignment', label: 'Assignment purchase?', group: 'Loan & program', type: 'boolean' },
  { key: 'status', label: 'File status', group: 'Loan & program', type: 'enum',
    options: [
      { v: 'file_intake', label: 'File intake' },
      { v: 'new', label: 'Submitted' }, { v: 'in_review', label: 'In review' }, { v: 'processing', label: 'Processing' },
      { v: 'underwriting', label: 'Underwriting' }, { v: 'approved', label: 'Approved' },
      { v: 'clear_to_close', label: 'Clear to close' }, { v: 'funded', label: 'Funded' },
      { v: 'declined', label: 'Declined' }, { v: 'withdrawn', label: 'Withdrawn' }] },

  // ---- Property ----
  { key: 'property_state', label: 'Property state', group: 'Property', type: 'enum', options: stateOptions },
  { key: 'property_city', label: 'Property city', group: 'Property', type: 'text' },
  { key: 'property_zip', label: 'Property ZIP', group: 'Property', type: 'text' },
  { key: 'property_type', label: 'Property type', group: 'Property', type: 'enum',
    options: [
      { v: 'sfr', label: 'SFR (1 unit)' }, { v: 'multi_2_4', label: 'Multi 2–4' }, { v: 'multi_5_plus', label: 'Multi 5+' },
      { v: 'condo', label: 'Condo' }, { v: 'townhouse', label: 'Townhouse' }, { v: 'pud', label: 'PUD' },
      { v: 'mixed_use', label: 'Mixed use' }, { v: 'other', label: 'Other' }] },
  { key: 'units', label: 'Units', group: 'Property', type: 'number', writable: true,
    borrowerLabel: 'Number of units', borrowerHint: 'How many units does the property have?' },
  { key: 'occupancy', label: 'Occupancy', group: 'Property', type: 'enum',
    options: [
      { v: 'investment', label: 'Investment' }, { v: 'primary', label: 'Primary' },
      { v: 'secondary', label: 'Secondary' }, { v: 'other', label: 'Other' }] },

  // ---- Deal economics ----
  { key: 'purchase_price', label: 'Purchase price', group: 'Deal economics', type: 'money', writable: true,
    borrowerLabel: 'Purchase price', borrowerHint: 'Enter the contract purchase price.' },
  { key: 'as_is_value', label: 'As-is value', group: 'Deal economics', type: 'money', writable: true,
    borrowerLabel: 'As-is value', borrowerHint: 'Your estimate of the property’s current as-is value.' },
  { key: 'arv', label: 'After-repair value (ARV)', group: 'Deal economics', type: 'money', writable: true,
    borrowerLabel: 'After-repair value (ARV)', borrowerHint: 'Your estimated value after the renovation is complete.' },
  { key: 'rehab_budget', label: 'Rehab budget', group: 'Deal economics', type: 'money', writable: true,
    borrowerLabel: 'Rehab budget', borrowerHint: 'Total renovation budget for the project.' },
  { key: 'rehab_type', label: 'Rehab type', group: 'Deal economics', type: 'enum',
    options: [
      { v: 'cosmetic', label: 'Cosmetic' }, { v: 'moderate', label: 'Moderate' }, { v: 'heavy', label: 'Heavy / gut' },
      { v: 'adding_sf', label: 'Adding square footage' }, { v: 'ground_up', label: 'Ground-up' }, { v: 'other', label: 'Other' }] },
  { key: 'payoff_amount', label: 'Current payoff amount', group: 'Deal economics', type: 'money', writable: true,
    borrowerLabel: 'Current payoff amount', borrowerHint: 'The payoff amount on your current loan (refinances).' },
  { key: 'original_purchase_price', label: 'Original purchase price', group: 'Deal economics', type: 'money', writable: true,
    borrowerLabel: 'Original purchase price', borrowerHint: 'What you originally paid for the property (refinances).' },
  { key: 'acquisition_date', label: 'Acquisition date', group: 'Deal economics', type: 'date', writable: true,
    borrowerLabel: 'Acquisition date', borrowerHint: 'When you purchased the property (refinances).' },
  { key: 'underlying_contract_price', label: 'Underlying contract price', group: 'Deal economics', type: 'money', writable: true,
    borrowerLabel: 'Underlying contract price', borrowerHint: 'The price on the original (underlying) purchase contract.' },
  { key: 'assignment_fee', label: 'Assignment fee', group: 'Deal economics', type: 'money', writable: true,
    borrowerLabel: 'Assignment fee', borrowerHint: 'The assignment fee being paid on top of the underlying contract.' },
  { key: 'sqft_pre', label: 'Square footage (current)', group: 'Deal economics', type: 'number', writable: true,
    borrowerLabel: 'Current square footage', borrowerHint: 'The property’s square footage today.' },
  { key: 'sqft_post', label: 'Square footage (after)', group: 'Deal economics', type: 'number', writable: true,
    borrowerLabel: 'Square footage after renovation', borrowerHint: 'Expected square footage after the project.' },
  { key: 'liquidity_required', label: 'Liquidity requirement', group: 'Deal economics', type: 'money',
    description: 'Assets/liquidity the registered product requires (cash to close + reserves).' },

  // ---- Borrower & experience ----
  { key: 'fico', label: 'Credit score (FICO)', group: 'Borrower & experience', type: 'number', writable: true,
    borrowerLabel: 'Estimated credit score', borrowerHint: 'Your best estimate of your mid credit score (300–850).' },
  { key: 'citizenship', label: 'Citizenship', group: 'Borrower & experience', type: 'enum',
    options: [
      { v: 'us_citizen', label: 'US Citizen' }, { v: 'permanent_resident', label: 'Permanent Resident' },
      { v: 'foreign_national', label: 'Foreign National' }, { v: 'other', label: 'Other' }] },
  { key: 'borrower_state', label: 'Borrower home state', group: 'Borrower & experience', type: 'enum', options: stateOptions },
  { key: 'tier', label: 'Borrower tier (verified deals)', group: 'Borrower & experience', type: 'number',
    description: 'Count of verified track-record deals on the borrower profile.' },
  { key: 'verified_flips', label: 'Verified flips', group: 'Borrower & experience', type: 'number' },
  { key: 'verified_holds', label: 'Verified holds / rentals', group: 'Borrower & experience', type: 'number' },
  { key: 'verified_ground', label: 'Verified ground-up builds', group: 'Borrower & experience', type: 'number' },
  { key: 'requested_exp_flips', label: 'Claimed flips', group: 'Borrower & experience', type: 'number', writable: true,
    borrowerLabel: 'Completed flips', borrowerHint: 'How many flips have you completed in the last 3 years?' },
  { key: 'requested_exp_holds', label: 'Claimed holds / rentals', group: 'Borrower & experience', type: 'number', writable: true,
    borrowerLabel: 'Rental properties held', borrowerHint: 'How many rental properties have you owned/held?' },
  { key: 'requested_exp_ground', label: 'Claimed ground-up builds', group: 'Borrower & experience', type: 'number', writable: true,
    borrowerLabel: 'Ground-up builds completed', borrowerHint: 'How many ground-up construction projects have you completed?' },
  { key: 'has_co_borrower', label: 'Has co-borrower?', group: 'Borrower & experience', type: 'boolean' },

  // ---- Entity ----
  { key: 'has_llc', label: 'Vesting LLC linked?', group: 'Entity', type: 'boolean' },
  { key: 'llc_verified', label: 'Vesting LLC verified?', group: 'Entity', type: 'boolean' },
  { key: 'llc_state', label: 'LLC formation state', group: 'Entity', type: 'enum', options: stateOptions },
];

const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

// Writable info-field targets: where the borrower's answer is persisted.
// table 'applications' keys write the file; 'borrowers' keys write the profile.
const WRITE_TARGETS = {
  loan_amount: { table: 'applications', column: 'loan_amount' },
  requested_ir_months: { table: 'applications', column: 'requested_ir_months' },
  requested_ir_amount: { table: 'applications', column: 'requested_ir_amount' },
  units: { table: 'applications', column: 'units' },
  purchase_price: { table: 'applications', column: 'purchase_price' },
  as_is_value: { table: 'applications', column: 'as_is_value' },
  arv: { table: 'applications', column: 'arv' },
  rehab_budget: { table: 'applications', column: 'rehab_budget' },
  payoff_amount: { table: 'applications', column: 'payoff_amount' },
  original_purchase_price: { table: 'applications', column: 'original_purchase_price' },
  acquisition_date: { table: 'applications', column: 'acquisition_date' },
  underlying_contract_price: { table: 'applications', column: 'underlying_contract_price' },
  assignment_fee: { table: 'applications', column: 'assignment_fee' },
  sqft_pre: { table: 'applications', column: 'sqft_pre' },
  sqft_post: { table: 'applications', column: 'sqft_post' },
  requested_exp_flips: { table: 'applications', column: 'requested_exp_flips' },
  requested_exp_holds: { table: 'applications', column: 'requested_exp_holds' },
  requested_exp_ground: { table: 'applications', column: 'requested_exp_ground' },
  fico: { table: 'borrowers', column: 'fico' },
};

// ---------------------------------------------------------------------------
// Admin-defined custom fields (custom_fields table, 038) extend the registry
// at runtime: an information condition can ask for a brand-new field, whose
// per-application answer lives in application_field_values and which the rule
// engine can reference like any built-in field. Cached briefly; mutations
// call bustCustomFields().
// ---------------------------------------------------------------------------
let _customCache = null;
let _customCacheAt = 0;
const CUSTOM_TTL_MS = 15000;

function customFieldDef(row) {
  return {
    key: row.key, label: row.label, group: 'Custom fields', type: row.type,
    options: row.options || undefined, writable: true, custom: true,
    borrowerLabel: row.borrower_label || undefined, borrowerHint: row.borrower_hint || undefined,
    isActive: row.is_active !== false,
  };
}

async function loadCustomFields(db) {
  const now = Date.now();
  if (_customCache && now - _customCacheAt < CUSTOM_TTL_MS) return _customCache;
  try {
    const r = await db.query(`SELECT * FROM custom_fields ORDER BY created_at`);
    _customCache = r.rows.map(customFieldDef);
    _customCacheAt = now;
  } catch (_) {
    // Table missing (mid-migration) — behave as if there are no custom fields.
    _customCache = _customCache || [];
  }
  return _customCache;
}

function bustCustomFields() { _customCache = null; _customCacheAt = 0; }

/** All fields (built-in + ACTIVE custom), for pickers and rule authoring. */
async function allFields(db) {
  const custom = await loadCustomFields(db);
  return [...FIELDS, ...custom.filter((f) => f.isActive)];
}

/**
 * Field lookup map for rule EVALUATION — includes inactive custom fields so
 * existing rules/conditions referencing a retired field keep resolving
 * (they just stop being authorable).
 */
async function fieldMap(db) {
  const custom = await loadCustomFields(db);
  const map = { ...BY_KEY };
  for (const f of custom) map[f.key] = f;
  return map;
}

const isCustomKey = (key) => /^cf_/.test(String(key || ''));

// The public view sent to the portal (no SQL/source internals).
function toPublic(f) {
  return {
    key: f.key, label: f.label, group: f.group, type: f.type,
    options: f.options || undefined, writable: !!f.writable, custom: !!f.custom,
    borrowerLabel: f.borrowerLabel || undefined, borrowerHint: f.borrowerHint || undefined,
    description: f.description || undefined,
  };
}
function publicFields() {
  return FIELDS.map(toPublic);
}
async function publicFieldsAll(db) {
  return (await allFields(db)).map(toPublic);
}

module.exports = {
  FIELDS, BY_KEY, WRITE_TARGETS, US_STATES, publicFields, publicFieldsAll,
  allFields, fieldMap, loadCustomFields, bustCustomFields, isCustomKey, customFieldDef,
  normState, normStrategy, normLoanPurpose, normPropertyType, normRehabType,
  normCitizenship, normOccupancy,
};

/**
 * Enum crosswalks — portal value <-> ClickUp option LABEL, per
 * docs/CLICKUP-DATA-MAPPING.md Part 6. Labels only (stable); the option UUID is
 * resolved at runtime against the live option list via transforms, so option-id
 * churn never breaks the map and newly-added ClickUp options are picked up.
 *
 * Composite cases (Ground-Up program+loan-type, vesting-from-LLC, marital) are
 * handled by the orchestrator; this module is pure per-field label mapping.
 */
const T = require('./transforms');

// fieldId = ClickUp custom_field id; to = { portalValue: clickupLabel }.
// `NEW:` labels are options the owner is adding (Ground-Up, Condo, Townhouse).
const FIELDS = {
  program: {
    id: '50eb857a-d8b1-4c48-9ffe-20b15cdf1338',
    to: {
      'Fix & Flip w/ Construction': 'Fix & Flip With Construction',
      'Bridge': 'bridge Without Construction',
      'Ground-Up Construction': 'Ground-Up',        // NEW option (owner adding)
      'Not sure yet': null,                          // leave blank; officer sets
    },
    // inbound labels with no exact portal twin
    fromExtra: { 'Private hard money': 'Bridge' },
  },
  loan_type: {
    id: 'ee1b564f-13cb-4841-af4c-e0f762cbcf52',
    to: {
      'Purchase': 'Purchase',
      'Refinance — Rate & Term': 'Refi Rate & Term',
      'Refinance — Cash-Out': 'Refi Cash-Out',
    },
  },
  property_type: {
    id: '541524d9-255f-4484-ac6d-1011ac60e87b',
    to: {
      'SFR (1 unit)': 'SFR',
      'Multi 2–4': 'Multi 2-4',
      'Multi 5+': 'Multi 5+',
      'Mixed use': 'Mixed Use',
      'Condo': 'Condo',                              // NEW option (owner adding)
      'Townhouse': 'Townhouse',                      // NEW option (owner adding)
    },
    fromExtra: {
      'Warrantable condo': 'Condo', 'Non-warrantable condo': 'Condo',
      'Co-Op': 'Condo', 'New Construction': 'SFR (1 unit)',
    },
  },
  occupancy: {
    id: 'df9d81b5-0b5d-4e09-a44a-4bbfb3b0291c',
    to: { 'Primary': 'Primary', 'Investment': 'Investment', 'Secondary': 'Secondary' },
  },
  vesting: {
    id: '173dc79a-a12d-4233-a6a6-9f4101770ca9',
    to: { 'Individual': 'Individual', 'LLC / Corp': 'LLC / Corp', 'Trust': 'Trust' },
  },
  rehab_type: {
    id: null,                                        // NEW ClickUp "Rehab Type" field (owner adding)
    to: {
      'Cosmetic': 'Cosmetic', 'Moderate': 'Moderate', 'Heavy / gut rehab': 'Heavy',
      'Adding square footage': 'Adding SF', 'Ground-up construction': 'Ground-up',
    },
  },
  employment_type: {
    id: '33bf62d8-fa4f-45e5-9c91-a51ce78e5e32',
    to: {
      'W-2': 'W-2', '1099': '1099', 'K1': 'K1 - S CORP', 'K1 - S CORP': 'K1 - S CORP',
      'C CORP': 'C CORP', 'Self employed': 'Self employed',
    },
  },
  contact_type: {
    id: '44120431-132f-4509-a086-e2dea10c3a72',
    to: { 'INVESTOR': 'INVESTOR', 'PRIMARY': 'PRIMARY', 'FIRST TIME INVESTOR': 'FIRST TIME INVESTOR' },
  },
  term: {
    id: 'b67dd5fd-c753-47e9-b3dd-aa576d742abd',
    to: {
      '12 Months': '12 Months', '30 year': '30 year', '15 year': '15 year',
      'Interest only': 'Interest only', 'Other': 'Other',
    },
    defaultLabel: '12 Months',                       // RTL default when blank
  },
  housing_status: {
    id: '6ae80836-6835-4c91-a3ef-209923f89e30',
    to: {
      'Rent': 'Rent', 'Own with mortgage': 'Mortgage', 'Own free and clear': 'own free and clear',
      'Live with family': 'Rent Free', 'Other': null,
    },
  },
};

const _norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** Build (and cache) the inverse label map for a field: normalized CU label -> portal value. */
function inverseFor(key) {
  const f = FIELDS[key];
  if (!f) return {};
  if (f._inv) return f._inv;
  const inv = {};
  for (const [portal, cu] of Object.entries(f.to)) if (cu) inv[_norm(cu)] = portal;
  for (const [cu, portal] of Object.entries(f.fromExtra || {})) inv[_norm(cu)] = portal;
  f._inv = inv;
  return inv;
}

/** Portal value -> ClickUp option label (write side). null = leave field blank. */
function toClickUpLabel(key, portalValue) {
  const f = FIELDS[key];
  if (!f) return null;
  if (portalValue == null || portalValue === '') return f.defaultLabel || null;
  if (Object.prototype.hasOwnProperty.call(f.to, portalValue)) return f.to[portalValue];
  // tolerant match (case/space)
  const want = _norm(portalValue);
  const hit = Object.keys(f.to).find((k) => _norm(k) === want);
  return hit ? f.to[hit] : (f.defaultLabel || null);
}

/** ClickUp option label -> portal value (read side). */
function fromClickUpLabel(key, clickupLabel) {
  if (clickupLabel == null || clickupLabel === '') return null;
  return inverseFor(key)[_norm(clickupLabel)] || null;
}

/**
 * Resolve a portal value to the ClickUp option UUID to WRITE, using the live
 * option list [{id,orderindex,name}] for that field.
 */
function resolveWriteId(key, portalValue, optionList) {
  const label = toClickUpLabel(key, portalValue);
  if (!label) return null;
  return T.dropdownLabelToId(optionList, label);
}

/**
 * Resolve a ClickUp READ value (orderindex integer) to the portal value, using
 * the live option list for that field.
 */
function resolveReadValue(key, orderindex, optionList) {
  const label = T.dropdownIndexToLabel(optionList, orderindex);
  return label ? fromClickUpLabel(key, label) : null;
}

module.exports = { FIELDS, toClickUpLabel, fromClickUpLabel, resolveWriteId, resolveReadValue };

/**
 * labels.js — borrower-facing friendly labels for the internal enum codes stored on
 * an application (program / loan type / property type / occupancy) and the loan-officer
 * placeholder. Borrowers must never see raw database codes like "gold",
 * "purchase_rehab", or "single_family", nor the "Lead Capture" system pseudo-officer
 * (owner rule: plain, everyday language — no internal jargon). Import and use these at
 * every place a borrower sees one of these values.
 */
const titleCase = (s) => String(s || '')
  .replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\b\w/g, (c) => c.toUpperCase());

/** The program's borrower-facing name. A registered product label (if present) always
 *  wins; otherwise map the code, falling back to a title-cased version. */
export function programLabel(program, registeredLabel) {
  if (registeredLabel) return registeredLabel;
  const k = String(program || '').toLowerCase();
  if (!k) return '';
  if (k === 'gold') return 'Gold Standard';
  if (k === 'standard') return 'Standard';
  return titleCase(program);
}

const LOAN_TYPE = {
  bridge: 'Bridge',
  purchase: 'Purchase',
  purchase_rehab: 'Purchase + Rehab',
  fix_flip: 'Fix & Flip', fix_and_flip: 'Fix & Flip', flip: 'Fix & Flip',
  fix_hold: 'Fix & Hold', fix_and_hold: 'Fix & Hold',
  ground_up: 'Ground-Up', ground_up_construction: 'Ground-Up Construction', construction: 'Construction',
  refinance: 'Refinance', refi: 'Refinance', cash_out: 'Cash-Out Refinance', cash_out_refinance: 'Cash-Out Refinance',
  rental: 'Rental', dscr: 'DSCR',
};
export function loanTypeLabel(v) {
  const k = String(v || '').toLowerCase();
  return LOAN_TYPE[k] || (v ? titleCase(v) : '');
}

const PROPERTY_TYPE = {
  single_family: 'Single Family', sfr: 'Single Family', sf: 'Single Family',
  multi_family: 'Multi-Family', multifamily: 'Multi-Family',
  '2_4_unit': '2–4 Unit', '2-4': '2–4 Unit', 'multi_2_4': '2–4 Unit', 'multi 2-4': '2–4 Unit',
  'multi_5_plus': '5+ Unit', 'multi 5+': '5+ Unit',
  condo: 'Condo', condominium: 'Condo',
  townhouse: 'Townhouse', townhome: 'Townhouse',
  mixed_use: 'Mixed Use', mixeduse: 'Mixed Use',
  duplex: 'Duplex', triplex: 'Triplex', fourplex: 'Fourplex',
  land: 'Land',
};
export function propertyTypeLabel(v) {
  const k = String(v || '').toLowerCase();
  return PROPERTY_TYPE[k] || (v ? titleCase(v) : '');
}

const OCCUPANCY = {
  investment: 'Investment', non_owner: 'Investment', 'non-owner': 'Investment', investor: 'Investment',
  owner_occupied: 'Owner-Occupied', primary: 'Primary Residence', second_home: 'Second Home',
};
export function occupancyLabel(v) {
  const k = String(v || '').toLowerCase();
  return OCCUPANCY[k] || (v ? titleCase(v) : '');
}

/** "Lead Capture" is the system pseudo-officer on a not-yet-assigned file — never show
 *  it to a borrower as their loan officer. Returns the real officer name, or a friendly
 *  "to be assigned" phrase (pass a custom fallback if the surface wants a different one). */
export function officerLabel(name, fallback = 'To be assigned') {
  const n = String(name || '').trim();
  if (!n || /^lead\s*capture$/i.test(n)) return fallback;
  return n;
}

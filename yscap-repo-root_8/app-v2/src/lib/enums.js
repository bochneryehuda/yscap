// Canonical option lists for the fixed-choice borrower fields (owner-directed
// 2026-07-16: citizenship / marital status / contact type are DROPDOWNS
// everywhere — no free text). One source so the borrower application, the
// borrower profile, and the staff borrower-overview never drift apart.
// Research basis: URLA marital categories (Married / Separated / Unmarried
// bucket), Fannie/Freddie citizenship buckets, and standard CRM contact types.

export const CITIZENSHIP = ['US Citizen', 'Permanent Resident', 'Foreign National'];
export const MARITAL = ['Single', 'Married', 'Separated', 'Divorced', 'Widowed'];
export const HOUSING = ['Rent', 'Own with mortgage', 'Own free and clear', 'Live with family', 'Other'];
// Contact type = the CRM relationship/role of this person on the deal.
export const CONTACT_TYPE = ['Investor', 'Primary', 'Co-Borrower', 'Guarantor', 'Referral Partner', 'Other'];

// The deal STRATEGY / program on the application (owner-directed 2026-07-16:
// the "Program" field in Edit Application details must be a dropdown, not free
// text — an officer had typed "Fix & Hold"). These are the strategies the
// application collects; the registered PRICING program (Standard / Gold) is a
// separate concept set in Products & Pricing.
export const PROGRAMS = ['Fix & Flip', 'Fix & Hold', 'Bridge', 'Ground-Up Construction', 'DSCR / Rental', 'Not sure yet'];
export const PROPERTY_TYPES = ['SFR', 'Multi 2-4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed Use'];

// A <select> whose current value isn't EXACTLY an option (legacy free-text data,
// e.g. an uppercase "INVESTOR" from the old free-text field) must still render
// that value as the selected option so staff never silently lose it. Exact —
// not case-insensitive — match: a differently-cased legacy value is appended so
// the controlled <select value=…> finds it and shows it selected (picking the
// canonical option and saving then self-heals the casing).
export function withCurrent(options, value) {
  const v = (value == null ? '' : String(value)).trim();
  if (!v || options.includes(v)) return options;
  return [...options, v];
}

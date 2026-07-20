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

// Property type drives the unit-count control EVERYWHERE it's collected — the
// borrower application AND the staff new-file / edit-details forms — so the two
// sides never diverge (owner-reported: single-family on the staff side didn't
// auto-fill units and 2–4 wasn't a dropdown). One definition:
//   'single'   → single-unit type (SFR / Condo / Townhouse): units is always 1
//                and the field is locked.
//   'select24' → "Multi 2–4": units is a 2 / 3 / 4 dropdown.
//   'multi'    → "Multi 5+" / "Mixed use": units is a free number (5 or more).
//   'open'     → any OTHER type we don't recognize (e.g. "New Construction",
//                "Commercial", "Land" that can arrive from ClickUp sync and be
//                shown via withCurrent): a free, editable number — never locked
//                and never forced to 1. A ground-up multi-unit build must keep
//                its real unit count instead of being silently reset to "1 unit".
// The regex tolerates both label spellings in use: "Multi 2-4" (enums hyphen)
// and the en-dash "Multi 2–4" (application), "Mixed Use" and "Mixed use", and
// "SFR (1 unit)" (the application/new-file label) vs bare "SFR" (Edit details).
export function unitsMode(propType) {
  const p = propType || '';
  if (/2.?4/.test(p)) return 'select24';                 // Multi 2–4
  if (/5\s*\+|mixed/i.test(p)) return 'multi';           // Multi 5+ / Mixed use
  if (/sfr|single|condo|town/i.test(p)) return 'single'; // SFR / Condo / Townhouse
  return 'open'; // unknown/blank: free entry, not locked and not forced to 1
}

// Resolve the units value when the property type changes. Single-unit types are
// always exactly 1 (locked). Switching to a KNOWN multi type (2–4 / 5+) clears a
// carried-over "1" so a single-family default can't masquerade as a real count.
// Unknown ('open') types — New Construction and the like — are left completely
// untouched: neither forced to 1 nor cleared, so a legit unit count survives a
// save. Returns the next units string given the previous one.
export function unitsForType(propType, prevUnits) {
  const keep = prevUnits == null ? '' : String(prevUnits);
  if (!propType) return keep;                    // no type chosen yet — don't force a count
  const mode = unitsMode(propType);
  if (mode === 'single') return '1';
  if (mode === 'open') return keep;              // unknown type — never force or clear
  if (keep === '1') return '';                   // 2–4 / 5+: drop a carried-over single-family "1"
  return keep;
}

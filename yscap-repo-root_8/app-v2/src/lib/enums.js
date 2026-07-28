// Canonical option lists for the fixed-choice borrower fields (owner-directed
// 2026-07-16: citizenship / marital status / contact type are DROPDOWNS
// everywhere — no free text). One source so the borrower application, the
// borrower profile, and the staff borrower-overview never drift apart.
// Research basis: URLA marital categories (Married / Separated / Unmarried
// bucket), Fannie/Freddie citizenship buckets, and standard CRM contact types.

export const CITIZENSHIP = ['US Citizen', 'Permanent Resident', 'Foreign National'];
export const MARITAL = ['Single', 'Married', 'Separated', 'Divorced', 'Widowed'];
export const HOUSING = ['Rent', 'Own with mortgage', 'Own free and clear', 'Live with family', 'Other'];
// How the borrower earns. THE VALUES MUST BE THE SPELLINGS THE CLICKUP
// CROSSWALK KNOWS (`employment_type` in src/clickup/crosswalk.js) — this is a
// two-way mapped dropdown, so a value it can't translate is dropped from the
// push in silence and the next inbound pull reads ClickUp's old value straight
// back over the edit (the same trap the PROGRAMS list fell into, see below).
export const EMPLOYMENT = ['W-2', '1099', 'K1 - S CORP', 'C CORP', 'Self employed'];
// Contact type = the CRM relationship/role of this person on the deal.
export const CONTACT_TYPE = ['Investor', 'Primary', 'Co-Borrower', 'Guarantor', 'Referral Partner', 'Other'];

// The deal STRATEGY / program on the application (owner-directed 2026-07-16:
// the "Program" field in Edit Application details must be a dropdown, not free
// text — an officer had typed "Fix & Hold"). These are the strategies the
// application collects; the registered PRICING program (Standard / Gold) is a
// separate concept set in Products & Pricing.
//
// THE VALUES MUST BE THE SYSTEM'S CANONICAL SPELLINGS (owner-reported 2026-07-27:
// "changing Fix & Flip to Fix & Hold bounces back and doesn't save"). This list
// had drifted into its own private spellings — 'Fix & Flip' where the rest of
// the system writes 'Fix & Flip w/ Construction', 'SFR' where it writes
// 'SFR (1 unit)', a plain hyphen in 'Multi 2-4' where it writes an en-dash. The
// borrower application (Apply.jsx), the staff new-file form (StaffNewFile.jsx),
// ingest.js RTL_PROGRAMS and the ClickUp crosswalk all use the canonical
// spellings, so every value below that differed was a value the ClickUp push
// could not translate — it was dropped in silence and the next inbound pull
// overwrote the officer's edit with ClickUp's stale value. Hence "it bounces
// back". Labels stay friendly; only the stored VALUE has to be canonical.
//
// 'Fix & Hold' and 'DSCR / Rental' are real PILOT programs (pricing.js prices
// Fix & Hold, the EMCAP tape exports it, the Encompass map compares it) that
// ClickUp genuinely has no dropdown option for. They stay on the list — the
// owner asked for exactly this change — and are now PROTECTED from being
// reverted by the sync (src/lib/inbound-enum-guard.js), with the editor telling
// the officer the value is kept in PILOT but has no ClickUp twin yet.
export const PROGRAMS = [
  { value: 'Fix & Flip w/ Construction', label: 'Fix & Flip (with construction)' },
  { value: 'Fix & Hold', label: 'Fix & Hold (BRRRR)' },
  { value: 'Bridge', label: 'Bridge' },
  { value: 'Ground-Up Construction', label: 'Ground-Up Construction' },
  { value: 'DSCR / Rental', label: 'DSCR / Rental' },
  { value: 'Not sure yet', label: 'Not sure yet' },
];
export const PROPERTY_TYPES = [
  { value: 'SFR (1 unit)', label: 'SFR (1 unit)' },
  { value: 'Multi 2–4', label: 'Multi 2–4' },
  { value: 'Multi 5+', label: 'Multi 5+' },
  { value: 'Condo', label: 'Condo' },
  { value: 'Townhouse', label: 'Townhouse' },
  { value: 'Mixed use', label: 'Mixed use' },
];
// Loan type — canonical spellings the ClickUp crosswalk maps. A bare
// 'Refinance' has no ClickUp twin (only Rate & Term / Cash-Out do), so it is not
// offered: picking it used to save and then silently bounce back.
export const LOAN_TYPES = [
  { value: 'Purchase', label: 'Purchase' },
  { value: 'Refinance — Rate & Term', label: 'Refinance — Rate & Term' },
  { value: 'Refinance — Cash-Out', label: 'Refinance — Cash-Out' },
  // Spelled EXACTLY as ClickUp spells it (owner-directed 2026-07-27) so the
  // value round-trips with no translation.
  { value: 'Delayed Purchase Financing', label: 'Delayed Purchase Financing' },
];

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

/**
 * The same idea for the lists that carry a friendly LABEL alongside the
 * canonical stored VALUE (PROGRAMS / PROPERTY_TYPES / LOAN_TYPES). Always
 * returns [{value,label}] so a <select> can render a readable option while
 * saving the exact spelling the rest of the system — and the ClickUp crosswalk —
 * expects. Tolerates a plain string list too, so it is safe on any option array.
 *
 * A current value that is not one of the options is APPENDED rather than
 * dropped: files carry legacy spellings from years of ClickUp sync, and a
 * controlled <select> whose value is missing from its options renders as blank,
 * which silently loses the officer's real data the moment they save anything.
 */
export function selectOptions(options, current) {
  const list = (options || []).map((o) => (o && typeof o === 'object' ? { value: o.value, label: o.label || o.value } : { value: o, label: o }));
  const v = (current == null ? '' : String(current)).trim();
  if (!v || list.some((o) => o.value === v)) return list;
  return [...list, { value: v, label: `${v} (current value on this file)` }];
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

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
  // Delayed purchase financing is checked FIRST and deliberately lands on
  // 'purchase': the frozen engine (pricing.js loanTypeOf — substring 'refi') also
  // reads it as a purchase, and the Blue Lake guideline in PILOT says a delayed
  // purchase gets "purchase leverage". So a condition rule keyed on loan purpose
  // agrees with the leverage the loan is actually sized on. Explicit rather than
  // relying on the /purchase/ branch below, so a label like "Delayed Purchase
  // Financing (Cash-Out)" could never silently flip it to a cash-out refinance.
  if (/delayed\s+purchase/.test(s)) return 'purchase';
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

// The note buyer / capital partner (applications.lender) arrives from ClickUp as
// a FREE-TEXT dropdown label ("Blue Lake", "CorrFirst", "Corr First", "Fidelis").
// Normalize it to a stable key — lowercased with every non-alphanumeric stripped
// — so a rule ("note buyer is CorrFirst") matches regardless of spacing/casing.
// This is the SAME normalization the Sitewire partner-link map uses
// (sitewire_partner_links.label_norm), so the keys agree across systems
// (bluelake, corrfirst, fidelis, …). Returns null for a blank/absent value.
function normNoteBuyer(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return s || null;
}

// FIDELIS — the capital provider the STANDARD program is paired with
// (tapes/program-provider.js: standard ↔ fidelis).
//
// PREFIX match, not an alias list (owner-reported 2026-07-27: a Fidelis file still
// showed the flood certificate). This started as an enumerated list — fidelis,
// fidelisinvestors, fidelisinvestorsllc, … — and that was the wrong shape: the list
// can only ever cover the spellings someone thought of, and a real ClickUp label
// one character off ("Fidelis Investor LLC", singular) silently fell through and the
// file kept a condition it should not have had. There is no bound on how a human
// types a company name, so the rule is now "the note buyer's name begins with
// Fidelis", which is what the owner actually means by "a Fidelis file".
//
// Safe against the near-miss that matters: "Fidelity" (Fidelity National, the title
// insurer) does NOT match — it diverges at the 6th character (fidelit… vs fideli**s**).
//
// This does NOT loosen `normNoteBuyer`, which stays an EXACT normalizer — an
// over-match THERE would let "BlueLake Capital" export the Blue Lake data tape
// (tapes/buyer-rule.js exportGate; guarded by test-tape-access-gate-pure.js). The
// prefix rule lives only in this Fidelis-specific helper, whose blast radius is the
// flood-certificate condition and nothing else.
//
// Keep in lock-step with the `LIKE 'fidelis%'` test in db/337.
const FIDELIS_KEY_PREFIX = 'fidelis';

/** True when this note-buyer label (applications.lender) is Fidelis, however it is spelled. */
function isFidelisNoteBuyer(raw) {
  const key = normNoteBuyer(raw);
  return !!key && key.startsWith(FIDELIS_KEY_PREFIX);
}

// EMCAP — the capital provider the SILVER program is paired with
// (tapes/program-provider.js: silver ↔ emcap). Same PREFIX shape as
// isFidelisNoteBuyer above (the db/337 lesson): the owner's real ClickUp/Sitewire
// label is "EMCAP Financial" (→ 'emcapfinancial'), and an enumerated alias list
// always lags the next spelling someone types. No other note buyer's key starts
// with 'emcap', so the prefix cannot over-match a different partner.
// This does NOT loosen `normNoteBuyer` (which stays EXACT). The tape EXPORT gate
// deliberately does not use this helper — it keys on an ENUMERATED alias list on
// the tape definition (tapes/emcap.js), because the export direction is the one
// where an over-match ships a data tape for the wrong buyer. Blast radius here:
// bank-statement months (liquidity.js) and the investor-guideline review audience
// — the advisory/months direction, where matching a genuine EMCAP spelling is
// strictly safer than missing it.
const EMCAP_KEY_PREFIX = 'emcap';

/** True when this note-buyer label (applications.lender) is EMCAP, however it is spelled. */
function isEmcapNoteBuyer(raw) {
  const key = normNoteBuyer(raw);
  return !!key && key.startsWith(EMCAP_KEY_PREFIX);
}

// BLUE LAKE — the capital provider the GOLD program is paired with
// (tapes/program-provider.js: gold ↔ bluelake). Same PREFIX shape as the two
// helpers above, and for the same reason: the real ClickUp label is routinely
// "Blue Lake Capital" (→ 'bluelakecapital'), which an exact key never matches.
// No other note buyer's key starts with 'bluelake'.
// This does NOT loosen `normNoteBuyer` (which stays EXACT) and the tape EXPORT
// gate deliberately does not use it — the export direction is the one where an
// over-match ships a data tape to the wrong buyer. Blast radius here: the
// individual-vesting refusal (lib/vesting-program-rule.js) — the direction where
// matching a genuine Blue Lake spelling is strictly safer than missing it,
// because Blue Lake does not buy a loan taken in a personal name at all.
const BLUELAKE_KEY_PREFIX = 'bluelake';

/** True when this note-buyer label (applications.lender) is Blue Lake, however it is spelled.
 * Matches the normal spellings ("Blue Lake", "BlueLake", "Blue Lake Capital" → keys that
 * START WITH 'bluelake') AND a TRUNCATED typo of the name (owner-reported 2026-08-12: a
 * stray note buyer "Blue L" was showing as its own row and should combine into Blue Lake).
 * A key that is ITSELF a prefix of 'bluelake' of length >= 5 — 'bluel', 'bluela', 'bluelak'
 * — is an unambiguous truncation of Blue Lake: it can never grab a DIFFERENT "Blue *" buyer
 * ("Blue Ledger" → 'blueledger' is neither a prefix of 'bluelake' nor starts with it), and the
 * length>=5 floor keeps a bare "Blue" (which could begin any name) from being swept in. This
 * does NOT loosen the EXACT `normNoteBuyer` (the tape-export gate keys on enumerated aliases,
 * not this helper), so a truncated file still can't ship the wrong buyer's data tape. */
function isBlueLakeNoteBuyer(raw) {
  const key = normNoteBuyer(raw);
  if (!key) return false;
  return key.startsWith(BLUELAKE_KEY_PREFIX)
    || (key.length >= 5 && BLUELAKE_KEY_PREFIX.startsWith(key));
}

// RCN — RCN Capital, whose notes are serviced by Elite Commercial Servicing. Same
// PREFIX shape as the helpers above and for the same reason: the real ClickUp label
// is routinely "RCN Capital" / "RCN Capital, LLC" (→ 'rcncapital'…), which an exact
// key never matches. No other note buyer's key starts with 'rcn'. This does NOT
// loosen normNoteBuyer (which stays EXACT). Blast radius: the vendor-order mortgagee
// clause (lib/orders.js) and the insurance mortgagee-address check (underwriting/
// lender.js) — the direction where recognizing a genuine RCN spelling is strictly
// safer than missing it (a missed match sends the wrong servicer address / raises a
// spurious "unrecognized address" nudge, never a wrong data-tape export).
const RCN_KEY_PREFIX = 'rcn';

/** True when this note-buyer label (applications.lender) is RCN, however it is spelled. */
function isRcnNoteBuyer(raw) {
  const key = normNoteBuyer(raw);
  return !!key && key.startsWith(RCN_KEY_PREFIX);
}

// THE ONE NOTE BUYER, HOWEVER IT IS SPELLED — canonical identity (owner-directed
// 2026-08-11: "EMCAP Financial and EMCAP are the same note buyer — combine them,
// everything should understand them as the same, and the one we keep should be
// linked everywhere; the one available in ClickUp is canonical").
//
// A buyer with a short registry spelling ("EMCAP", "Fidelis", "Blue Lake") AND a
// long production/ClickUp label ("EMCAP Financial", "Fidelis Investors LLC", "Blue
// Lake Capital") normalizes to TWO different keys under the EXACT `normNoteBuyer`
// ('emcap' vs 'emcapfinancial'), so it showed up as TWO picker options and read as
// two different buyers to the ClickUp bounce-back guard. This is the SINGLE place a
// buyer's canonical identity lives, so the picker (listNoteBuyers), the Silver→EMCAP
// auto-link (note-buyer-for-program), and the inbound bounce-back guard all agree on
// "the one we keep" and treat every spelling as the same buyer.
//
// NOTE_BUYER_CANONICAL_LABEL = the production label the picker offers + stores. Keyed
// by the buyer's canonical key (the tape buyerKey / prefix). A note buyer NOT here
// (CorrFirst, and anything the picker has never seen) keeps its own normalized key +
// trimmed label — it already collapses under normNoteBuyer (no differently-normalizing
// long form), so it needs no entry.
const NOTE_BUYER_CANONICAL_LABEL = Object.freeze({
  emcap: 'EMCAP Financial',
  fidelis: 'Fidelis Investors LLC',
  bluelake: 'Blue Lake Capital',
  rcn: 'RCN Capital',
});

// Buyer matchers, reusing the existing prefix helpers so "same buyer" has ONE
// definition. Order does not matter — the four prefixes are disjoint.
const CANONICAL_NOTE_BUYER_MATCHERS = [
  { key: 'emcap', is: isEmcapNoteBuyer },
  { key: 'fidelis', is: isFidelisNoteBuyer },
  { key: 'bluelake', is: isBlueLakeNoteBuyer },
  { key: 'rcn', is: isRcnNoteBuyer },
];

/**
 * The canonical identity of a note buyer, however it is spelled → { key, label }.
 * For a KNOWN buyer (EMCAP / Fidelis / Blue Lake / RCN — matched by the prefix
 * helpers above) it returns that buyer's canonical key + production ClickUp label,
 * so "EMCAP" and "EMCAP Financial" collapse to ONE { key:'emcap', label:'EMCAP
 * Financial' }. For an UNRECOGNIZED buyer it keeps its own normalized key + trimmed
 * label (so a note buyer the picker has never seen is still offerable, just not
 * canonicalized). Returns null for a blank/absent value.
 *
 * This does NOT loosen `normNoteBuyer` (which stays EXACT for the tape-export gate,
 * where an over-match ships the wrong buyer's data tape) — it is a SEPARATE identity,
 * used by the picker / bounce-back guard, that deliberately collapses the known
 * two-spelling buyers. PURE. Never throws.
 */
function canonicalNoteBuyer(raw) {
  const key = normNoteBuyer(raw);
  if (!key) return null;
  for (const m of CANONICAL_NOTE_BUYER_MATCHERS) {
    if (m.is(raw)) return { key: m.key, label: NOTE_BUYER_CANONICAL_LABEL[m.key] };
  }
  return { key, label: String(raw).trim() };
}

/**
 * True when two note-buyer labels name the SAME buyer by canonical identity, so
 * "EMCAP" ≡ "EMCAP Financial" and "Blue Lake" ≡ "Blue Lake Capital". A null/blank on
 * either side is "same" (nothing to compare — the caller decides what a blank means).
 * Used by the ClickUp inbound bounce-back guard so a spelling difference is never read
 * as ClickUp trying to change the note buyer (which caused an endless keep+re-push
 * churn). PURE. Never throws.
 */
function sameNoteBuyer(a, b) {
  if (a == null || b == null) return true;
  const ca = canonicalNoteBuyer(a);
  const cb = canonicalNoteBuyer(b);
  if (!ca || !cb) return !ca && !cb;          // both blank → same; one blank → different
  return ca.key === cb.key;
}

const stateOptions = US_STATES.map((v) => ({ v, label: v }));

// ---------------------------------------------------------------------------
// The registry. Order inside a group = picker order.
// ---------------------------------------------------------------------------
const FIELDS = [
  // ---- Loan & program ----
  { key: 'registered_program', label: 'Program (registered product)', group: 'Loan & program', type: 'enum',
    options: [{ v: 'standard', label: 'Standard Program' }, { v: 'gold', label: 'Gold Standard Program' }, { v: 'silver', label: 'Silver Program' }, { v: 'speed', label: 'Speed Program' }, { v: 'manual', label: 'Manual Program' }, { v: 'none', label: 'Not registered yet' }],
    description: 'The product program registered in the Term Sheet Studio. "Manual Program" = a manual override of the deal structure (LTV/LTC/ARV).' },
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
    description: 'Loan amount ÷ (min(purchase price, as-is value) + rehab budget) (0–100). Computed live.' },
  { key: 'rate_pct', label: 'Note rate %', group: 'Loan & program', type: 'percent' },
  { key: 'requested_ir_months', label: 'Interest reserve months', group: 'Loan & program', type: 'number', writable: true,
    borrowerLabel: 'Requested interest reserve (months)', borrowerHint: 'How many months of interest reserve are you requesting? (0–24)' },
  { key: 'requested_ir_amount', label: 'Interest reserve amount ($)', group: 'Loan & program', type: 'money', writable: true,
    borrowerLabel: 'Requested interest reserve (exact $ amount)', borrowerHint: 'Request an exact dollar interest reserve instead of months. Capped at the full loan term; leave blank to size from months.' },
  { key: 'is_assignment', label: 'Assignment purchase?', group: 'Loan & program', type: 'boolean' },
  // Note buyer / capital partner (applications.lender, pulled from ClickUp).
  // STAFF-ONLY — this is never writable from a borrower info-condition and its
  // real name is never shown to a borrower. The stored values are normalized
  // keys (normNoteBuyer); the labels are the human-facing note-buyer names. The
  // option list is the known/confirmed note buyers — an admin can still author a
  // rule against any of them, and a value not in the list still EVALUATES fine
  // (the engine matches on the normalized ctx value, not on option membership).
  // Drives note-buyer conditions: CorrFirst opens the borrower EMD condition
  // (db/191), and Blue Lake / CorrFirst require the internal flood-certificate
  // condition (rtl_cond_flood, db/281) — which a FIDELIS file is excluded from
  // (db/335, via note_buyer_is_fidelis below).
  // note_buyer is STAFF-set from the completeness datalist (staff.js complete-fields
  // writes the picked LABEL straight to applications.lender) — it is deliberately not
  // writable from a Condition Center info-field. RCN's real ClickUp dropdown label is
  // "RCN Capital" (owner-directed 2026-08-05); listing { v:'rcncapital', label:'RCN
  // Capital' } makes it a first-class, pickable note buyer (listNoteBuyers reads these
  // labels) even on a cold ClickUp option cache, instead of a value staff had to type
  // by hand. `v` is the normalized label so it lines up with normNoteBuyer('RCN
  // Capital')='rcncapital'. RCN needs no rule/boolean companion — its only special
  // handling is the vendor-order mortgagee clause + the insurance address check, both
  // keyed on isRcnNoteBuyer (prefix), which already matches "RCN Capital" and every
  // other 'rcn…' spelling.
  { key: 'note_buyer', label: 'Note buyer (capital partner)', group: 'Loan & program', type: 'enum',
    options: [
      { v: 'bluelake', label: 'Blue Lake' }, { v: 'corrfirst', label: 'CorrFirst' },
      { v: 'emcap', label: 'EMCAP' }, { v: 'fidelis', label: 'Fidelis' },
      { v: 'rcncapital', label: 'RCN Capital' }],
    description: 'The note buyer / capital partner the file is sold to (from ClickUp; staff-only, never shown to the borrower).' },
  // Is the note buyer FIDELIS (any spelling — "Fidelis", "Fidelis Investors",
  // "Fidelis Investors LLC")? A BOOLEAN companion to note_buyer, deliberately not
  // an enum comparison, for two reasons (owner-directed 2026-07-27):
  //   1. It collapses every Fidelis label spelling into ONE rule row, without
  //      loosening the shared exact normNoteBuyer (see isFidelisNoteBuyer above).
  //   2. It is always CONCRETE (true/false, never blank), so an `is_false` rule row
  //      behaves correctly on a file with NO note buyer yet. An enum
  //      `note_buyer is not fidelis` row would evaluate FALSE on a blank note buyer
  //      (rules.evalRow short-circuits a blank actual before the enum compare), which
  //      would have silently stripped the flood cert off every un-assigned Gold file.
  // Drives the Fidelis flood-cert rule (db/335): `in_flood_zone OR (gold|manual AND
  // note_buyer_is_fidelis is_false) OR note_buyer in (bluelake,corrfirst)` — i.e. it
  // gates the PROGRAM branch only. A proven flood zone stands on its own and requires
  // the cert on every file, Fidelis included ("if it's a flood zone you should force
  // this condition on, but as long as you don't have evidence… ignore this condition").
  { key: 'note_buyer_is_fidelis', label: 'Note buyer is Fidelis?', group: 'Loan & program', type: 'boolean',
    description: 'True when the file\'s note buyer / capital partner is Fidelis Investors (any spelling). Staff-only, never shown to the borrower.' },
  // Same boolean companion for EMCAP (the Silver program's note buyer, live
  // 2026-07-29) — its real ClickUp/Sitewire dropdown label is "EMCAP Financial"
  // (→ 'emcapfinancial'), so an enum `note_buyer eq emcap` rule would silently
  // never fire on a correctly-labeled file. Always concrete (true/false, never
  // blank), so `is_false` rows behave on a file with no note buyer yet — the
  // exact two reasons the Fidelis boolean above exists.
  { key: 'note_buyer_is_emcap', label: 'Note buyer is EMCAP?', group: 'Loan & program', type: 'boolean',
    description: 'True when the file\'s note buyer / capital partner is EMCAP (any spelling, e.g. "EMCAP Financial"). Staff-only, never shown to the borrower.' },
  // YS loan number (applications.ys_loan_number). Referenced by the rule engine so
  // the "loan number missing" internal condition can attach while it is blank and
  // retract the moment it is filled. Not writable via an info-condition (staff set
  // it through the dedicated loan-number entry, which enforces the YSCAP format +
  // cross-file uniqueness); it is a rule/evaluation field only.
  { key: 'ys_loan_number', label: 'YS loan number', group: 'Loan & program', type: 'text',
    description: 'The YS loan number on the file (starts with YSCAP…). Blank triggers the "loan number missing" internal condition.' },
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
  // Known Special Flood Hazard Area — derived from the current appraisal (the
  // FEMA SFHA flag, the FEMA-mapped zone, or the appraiser's stated zone; an A*
  // or V* zone is an SFHA). Drives the flood-certificate condition (rtl_cond_flood):
  // the cert is ALWAYS required when a flood zone is known, on top of the
  // Gold/Manual program rule AND the Blue Lake / CorrFirst note-buyer rule (db/281).
  { key: 'in_flood_zone', label: 'In a flood zone (SFHA)?', group: 'Property', type: 'boolean',
    description: 'True when the current appraisal places the property in a FEMA Special Flood Hazard Area (zone A*/V*).' },

  /* VESTING IN AN INDIVIDUAL'S NAME (owner-directed 2026-08-02). Drives the
     non-owner-occupied affidavit condition: marking a file individual is allowed
     from any door with nothing attached, and THIS is what then asks for the
     affidavit — rather than the act of marking it being blocked until one is in
     hand, which is impossible on a public application form.
     Derived, never typed: `applications.personal_name_purchase` AND no entity
     linked. A linked LLC always wins, so the affidavit condition retracts itself
     the moment a real entity arrives. */
  { key: 'vesting_is_individual', label: 'Vests in an individual\'s name?', group: 'Property', type: 'boolean',
    description: 'True when the file is marked as a personal-name purchase and no vesting entity is linked.' },

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
  /* WHO holds the loan being paid off, and WHICH loan it is (db/386). Writable
     because the BORROWER is the one who knows — it is their existing loan — so an
     info condition can simply ask them, instead of an officer chasing it by phone.
     A payoff amount with no lender and no loan number is a payoff nobody can
     order a letter for. */
  { key: 'payoff_lender', label: 'Lender being paid off', group: 'Deal economics', type: 'text', writable: true,
    borrowerLabel: 'Who is your current lender?',
    borrowerHint: 'The bank, private lender or servicer that holds the loan we are paying off.' },
  { key: 'payoff_loan_number', label: 'Payoff loan number', group: 'Deal economics', type: 'text', writable: true,
    borrowerLabel: 'Your current loan number',
    borrowerHint: 'The loan or account number your current lender uses — it is on your monthly statement.' },
  { key: 'payoff_good_through', label: 'Payoff good-through date', group: 'Deal economics', type: 'date', writable: true,
    borrowerLabel: 'Payoff good-through date',
    borrowerHint: 'The date your payoff quote is valid through (it is on the payoff letter).' },
  /* Property owned FREE AND CLEAR — no existing lien to pay off (db/575,
     owner-directed 2026-08-18). Always CONCRETE (true/false, never blank), for
     the same reason note_buyer_is_fidelis is: an `is_false` rule row must be
     correct on every file that simply never answered. It gates BOTH payoff
     conditions (db/464 rules widened by db/575): flag on → the engine retracts
     them (untouched only; a worked one is waived by the free-and-clear route).
     Set ONLY by the staff free-and-clear door (confirm popup, audited) — never
     writable from an info-condition. */
  { key: 'property_free_and_clear', label: 'Property is free and clear?', group: 'Deal economics', type: 'boolean',
    description: 'True when the property has no existing loan to pay off (confirmed by staff). Retracts/waives both payoff conditions.' },
  { key: 'original_purchase_price', label: 'Original purchase price', group: 'Deal economics', type: 'money', writable: true,
    borrowerLabel: 'Original purchase price', borrowerHint: 'What you originally paid for the property (refinances).' },
  { key: 'acquisition_date', label: 'Acquisition date', group: 'Deal economics', type: 'date', writable: true,
    borrowerLabel: 'Acquisition date', borrowerHint: 'When you purchased the property (refinances).' },
  /* DERIVED, so `writable: false` — there is no column behind it and no
     WRITE_TARGETS entry. It is computed from `acquisition_date` in
     engine.loadRuleContext by lib/deal-basis.seasoningMonths, which is the ONE
     definition of ownership seasoning in the app. A rule may READ it (e.g. a note
     buyer that wants six months of ownership before a cash-out); to change it you
     change the acquisition date. Null on a file with no date, so a rule keyed on
     it evaluates as blank rather than firing on an assumed zero. */
  { key: 'ownership_seasoning_months', label: 'Ownership seasoning (months)', group: 'Deal economics',
    type: 'number', writable: false,
    borrowerLabel: 'Months owned', borrowerHint: 'How long you have owned the property, counted from the date you acquired it.' },
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
  payoff_lender: { table: 'applications', column: 'payoff_lender' },
  payoff_loan_number: { table: 'applications', column: 'payoff_loan_number' },
  payoff_good_through: { table: 'applications', column: 'payoff_good_through' },
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
  normCitizenship, normOccupancy, normNoteBuyer,
  FIDELIS_KEY_PREFIX, isFidelisNoteBuyer,
  EMCAP_KEY_PREFIX, isEmcapNoteBuyer,
  BLUELAKE_KEY_PREFIX, isBlueLakeNoteBuyer,
  RCN_KEY_PREFIX, isRcnNoteBuyer,
  NOTE_BUYER_CANONICAL_LABEL, canonicalNoteBuyer, sameNoteBuyer,
};

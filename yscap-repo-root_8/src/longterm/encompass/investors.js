'use strict';
/**
 * LONG-TERM (LT) — the INVESTOR / CAPITAL-PROVIDER registry and name resolver.
 *
 * THE PROBLEM, MEASURED. The investor on a long-term file is typed by hand, in more
 * than one place, and nobody types it the same way twice. Across the 772 loans read
 * on 2026-08-14 the two free-text investor fields hold **151 distinct spellings** for
 * roughly **30 real companies**:
 *
 *   VEND.X263  'File Contacts Investor Name'  — 68 spellings on 408 loans
 *   CX.WHICHINVESTOR  'WHICH INVESTOR'        — 83 spellings on 451 loans
 *
 * They disagree with each other, they disagree with themselves, and they include
 * plain typos ('Deepahven', 'Deephven', 'Deepheaven', 'Deephavan', 'deep heaven',
 * 'Fidellis', 'fedelis', 'emcep', 'Blulake'), case and spacing variants ('Oaktree' /
 * 'Oak Tree' / 'OAKTREE' / 'OakTree'), short codes ('AHL', 'AD', 'BPL', 'CF'), and
 * paste accidents where a reference number and a tab landed in the name field
 * ('814267\tConstructive Capital BPL (Constructive Capital BPL)').
 *
 * WHY IT MATTERS. Nothing can be matched, rolled up, priced or pushed to ClickUp on a
 * name that is spelled 151 ways. This module is the one place that turns any of those
 * strings into a single canonical investor identity, so Encompass, our system and
 * ClickUp can all mean the same company even when they say it differently.
 *
 * HOW TO USE IT. Never compare investor names as strings. Call `resolve(raw)` and
 * compare `.key`. `sameInvestor(a, b)` does that for you.
 *
 * MAINTENANCE. `aliases` are the spellings actually SEEN in the tenant, recorded so a
 * reader can see the evidence. `resolve()` does not depend on the list being complete —
 * it normalizes first and falls back to a token match — but a new investor should be
 * added here rather than left to the fallback.
 *
 * READ-ONLY: this classifies data we read. It never writes to Encompass.
 */

// ── Canonical investors, with every spelling observed in the tenant ──────────
// `seen` is the number of loans that spelling appeared on (VEND.X263 + CX.WHICHINVESTOR).
// `alsoOnRtl` records that the short-term side of the business uses the same company
// under the label shown — an OBSERVATION for humans mapping the two products to one
// ClickUp option, not a shared list. Nothing here imports or writes RTL data.
const INVESTORS = [
  { key: 'deephaven', label: 'Deephaven Mortgage LLC', seen: 231,
    aliases: ['Deephaven Mortgage LLC', 'Deephaven', 'deephaven', 'DEEPHAVEN', 'DeepHaven',
      'Deep Haven', 'Deepahven', 'Deephven', 'Deepheaven', 'Deephavan', 'deep heaven'],
    note: 'The largest long-term investor by file count. Six distinct misspellings.' },

  { key: 'fidelis', label: 'Fidelis Investors LLC', seen: 95, alsoOnRtl: 'Fidelis',
    aliases: ['Fidelis', 'fidelis', 'FIDELIS', 'Fidellis', 'fidellis', 'fedelis',
      'fidellis investors', 'fidellis INVESTORES'] },

  { key: 'oaktree', label: 'Oaktree Funding Corp', seen: 98,
    aliases: ['Oaktree Funding Corp', 'Oaktree Funding Corp (Oaktree)', 'Oaktree', 'oaktree',
      'OAKTREE', 'OakTree', 'Oak Tree', 'oak tree'],
    note: 'The space matters to a human and not to the company: Oaktree / Oak Tree / OakTree.' },

  { key: 'champions', label: 'Champions Funding, LLC', seen: 80,
    aliases: ['Champions Funding, LLC (CF)', 'Champions Funding', 'Champions', 'champions',
      'CHAMPIONS', 'Champions Funding, LLC (CF)Champions Funding, LLC (CF)'],
    note: 'One value is the label pasted into itself.' },

  { key: 'rcn', label: 'RCN Capital', seen: 66, alsoOnRtl: 'RCN Capital',
    aliases: ['RCN Capital (RCN)', 'rcn Capital (RCN)', 'RCN', 'rcn'] },

  { key: 'a_and_d', label: 'A&D Mortgage LLC', seen: 38,
    aliases: ['A&D Mortgage, LLC', 'A&D Mortgage LLC (AD)', 'A&D Mortgage', 'A&D Mortgages',
      'a&d mortgage', 'A&D', 'A & D', 'AD',
      // LoanNEX drops the ampersand entirely (recorded 2026-08-30). Without these
      // the company resolves to no key on that vendor and its pricing would be
      // reported as an unknown investor rather than merged with its own.
      'AD Mortgage LLC - Correspondent', 'AD Mortgage LLC', 'AD Mortgage'],
    note: "'AD' is a two-letter code — resolvable only because it is in this list." },

  { key: 'acra', label: 'Acra Lending', seen: 30,
    aliases: ['Acra Lending', 'Acra', 'acra', 'ACRA'] },

  { key: 'nqm', label: 'NQM Funding', seen: 27,
    aliases: ['NQM Funding', 'NQM FUNDING', 'NQM', 'nqm', 'NonQM Funding (NonQM)'] },

  { key: 'american_heritage', label: 'American Heritage Lending', seen: 24,
    aliases: ['American Heritage Lending', 'American Heritage Lending (AHL)', 'American Heritage',
      'American heritage', 'AHL', 'ahl'] },

  { key: 'onslow_bay', label: 'Onslow Bay Financial', seen: 20,
    aliases: ['Onslow Bay', 'onslow Bay', 'Onslow', 'onslow', 'ONSLOW',
      'Onslow Bay Financial LLC', 'Annaly', 'annaly', 'Annaly / Onslow Bay', 'Annaly / onslow bay'],
    note: 'Annaly Capital Management is Onslow Bay\'s parent; the owner treats '
      + '"Annaly / onslow bay" as ONE investor (white-label sheet 2026-08-27). Lender '
      + 'Price quotes lender "Onslow", investor "Onslow Bay Financial LLC".' },

  { key: 'corrfirst', label: 'CorrFirst', seen: 20, alsoOnRtl: 'CorrFirst',
    aliases: ['CorrFirst', 'Corrfirst', 'corrfirst', 'Corr first'] },

  { key: 'blue_lake', label: 'Blue Lake Capital', seen: 12, alsoOnRtl: 'Blue Lake',
    aliases: ['Blue Lake', 'blue lake', 'BlueLake', 'Bluelake', 'bluelake', 'Blulake'] },

  { key: 'emcap', label: 'EMCAP Financial', seen: 10, alsoOnRtl: 'EMCAP',
    aliases: ['EMCAP Financial', 'EmCap', 'Emcap', 'emcap', 'emcep'],
    note: 'The owner confirmed 2026-08-11 that EMCAP and EMCAP Financial are one buyer.' },

  { key: 'roc', label: 'ROC Capital', seen: 17,
    aliases: ['ROC Capital (Roc)', 'Roc Capital', 'ROC capital', 'Roc', 'roc'] },

  { key: 'dominion', label: 'Dominion Financial', seen: 10,
    aliases: ['Dominion Financial (Dominion Financial)', 'Dominion Financial', 'Dominion'] },

  { key: 'eresi', label: 'eResi Mortgage', seen: 8,
    aliases: ['eResi', 'eresi', 'Eresi'] },

  { key: 'constructive_capital', label: 'Constructive Capital', seen: 9,
    aliases: ['Constructive Capital BPL (Constructive Capital BPL)',
      'Constructive Capital BPL (Constructive Capital BPL', 'BPL', 'Bpl'],
    note: "One value carries a leading reference number and a tab before the name." },

  { key: 'temple_view', label: 'Temple View Capital', seen: 3,
    aliases: ['Temple View'],
    note: 'Also named inside the CX.TOTALCOST formula, so the tenant treats it specially.' },

  { key: 'foundation', label: 'Foundation Mortgage', seen: 5,
    aliases: ['Foundation Mortgage', 'Foundation'] },

  { key: 'pennymac', label: 'PennyMac TPO', seen: 3,
    aliases: ['PennyMac TPO (PMTPO)', 'pennymac', 'Pennymac'] },

  { key: 'phh', label: 'PHH Mortgage', seen: 3,
    aliases: ['PHH', 'Onity', 'onity', 'Onity Mortgage Corp', 'Onity Mortgage', 'Onity / phh'],
    note: 'Onity is the renamed PHH (2024 rebrand); the owner treats "Onity / phh" as ONE '
      + 'investor (white-label sheet 2026-08-27), and Lender Price quotes it as '
      + '"Onity Mortgage Corp". The key stays phh because lt_loan_investors.canonical_key '
      + 'already stores it.' },
  { key: 'cake', label: 'Cake Mortgage Corp', seen: 4,
    aliases: ['Cake Mortgage Corp (Cake Mortgage)'] },
  { key: 'amwest', label: 'Amwest Funding Corporation', seen: 2,
    aliases: ['Amwest Funding Corporation (Amwest)'] },
  { key: 'logan', label: 'Logan Finance', seen: 1, aliases: ['Logan Finance (Logan Finance)'] },
  { key: 'loan_store', label: 'The Loan Store, Inc.', seen: 4, aliases: ['The Loan Store, Inc.'] },
  { key: 'arc_home', label: 'Arc Home Loans', seen: 2, aliases: ['arc home loans', 'Arc'] },
  { key: 'amerihome', label: 'AmeriHome Mortgage', seen: 1, aliases: ['Amerihome'] },
  { key: 'broadview', label: 'Broadview Funding', seen: 1, aliases: ['Broadview funding'] },
  { key: 'cornerstone', label: 'Cornerstone Servicing', seen: 1, aliases: ['Cornerstone Servicing'] },
  { key: 'selene', label: 'Selene Finance LP', seen: 1, aliases: ['Selene Finance LP'] },
  { key: 'amb', label: 'A Mortgage Boutique', seen: 1, aliases: ['A Mortgage Boutique (AMB)'] },
  { key: 'npb', label: 'NPB', seen: 1, aliases: ['NPB – Operations Center', 'NPB - Operations Center'] },

  // ── Seen in LENDER PRICE (the DSCR pricing engine) and on the owner's white-label
  // sheet of 2026-08-27, not (yet) in the Encompass free-text fields — which is why
  // `seen` is 0. They are REAL investors the PPE quotes (or that the owner expects to
  // come online there), and every one of them is under the same never-reaches-a-client
  // rule as the rest of this registry: recording them HERE is what makes audience.js
  // scrub their names automatically. The live Lender Price spellings were captured by
  // running scenarios against the live system on 2026-08-27.
  { key: 'verus', label: 'Verus Mortgage Capital', seen: 0,
    aliases: ['Verus', 'verus', 'Verus Mortgage Capital'],
    note: 'Lender Price quotes lender "Verus", investor "Verus  Mortgage Capital" '
      + '(with a doubled space — normalize() absorbs it).' },
  { key: 'newrez', label: 'NewRez LLC', seen: 0,
    aliases: ['NewRez', 'newrez', 'NewRez, LLC Wholesale', 'New Rez'],
    note: 'Lender Price spelling: "NewRez, LLC Wholesale".' },
  { key: 'loanstream', label: 'LoanStream Mortgage', seen: 0,
    aliases: ['LoanStream', 'loanstream', 'Loan Stream', 'LoanStream Mortgage'] },
  { key: 'lakeview', label: 'Lakeview Loan Servicing', seen: 0,
    aliases: ['Lakeview', 'lakeview', 'Bayview', 'bayview', 'Lakeview / Bayview'],
    note: 'The owner treats "Lakeview / Bayview" as ONE investor (Bayview is Lakeview\'s '
      + 'parent). Not yet quoting in Lender Price on 2026-08-27 — expected.' },
  { key: 'ellington', label: 'Ellington Financial', seen: 0,
    aliases: ['Ellington', 'ellington', 'Ellington Financial'],
    note: 'Not yet quoting in Lender Price on 2026-08-27 — expected.' },
  { key: 'redwood_trust', label: 'Redwood Trust', seen: 0,
    aliases: ['Redwood Trust', 'redwood trust', 'Redwood', 'redwood'],
    note: 'A bare "Redwood" is an English word AND this investor\'s short name; the '
      + 'scrub doctrine (audience.js) is that a recorded spelling the scrubber cannot '
      + 'see is a leak, so it is caught in every case and the odd mangled street name '
      + 'is the accepted cheap direction. Not yet in Lender Price on 2026-08-27.' },
  { key: 'sgcg', label: 'SGCG', seen: 0,
    aliases: ['SGCG', 'sgcg'],
    note: 'Not yet quoting in Lender Price on 2026-08-27 — expected.' },
  { key: 'adams_nymt', label: 'Adams / NYMT', seen: 0,
    aliases: ['adams NYMT', 'Adams NYMT', 'NYMT', 'nymt', 'New York Mortgage Trust'],
    note: 'The owner\'s sheet writes it "adams NYMT" (NYMT = New York Mortgage Trust). '
      + 'A bare "Adams" is DELIBERATELY not an alias — it is an ordinary surname and '
      + 'scrubbing it would redact real borrowers\' names. Not yet in Lender Price on '
      + '2026-08-27.' },

  { key: 'icecap', label: 'IceCap / ICE Lender Holdings', seen: 3,
    aliases: ['icecap', 'Ice Cap', 'ice lender holdings'],
    unverified: true,
    note: 'Three spellings that look like one company but could be two (IceCap vs ICE Lender '
      + 'Holdings). Needs an owner answer before it is treated as a single identity.' },
];

// Values that are not an investor at all. Recorded so they are never quietly resolved
// into a real company, and so the data-quality report can point at them.
const NON_VALUES = [
  { raw: '---', why: 'placeholder' },
  { raw: '--', why: 'placeholder' },
  { raw: 't', why: 'stray keystroke' },
  { raw: 'The Lender', why: 'a form label typed into the value, not a company' },
  { raw: 'The lender', why: 'a form label typed into the value, not a company' },
];

// ── The identity chain, in the order a file fills it ─────────────────────────
// Owner-directed 2026-08-14: "investor name is usually CX.WHICHINVESTOR, and later
// on in the process there is usually added a more accurate version on another field
// which is VEND.X263. More important later on is going to be an investor loan
// number — the loan number that an investor has in their system — and those should
// survive like crazy."
//
// So an investor is established in THREE steps, each more durable than the last,
// and none of them supersedes the one before it — they answer different questions:
//   1. WHICH INVESTOR    (CX.WHICHINVESTOR) — staff shorthand, typed early
//   2. WHO EXACTLY       (VEND.X263)        — the fuller contact-record name, later
//   3. THEIR LOAN NUMBER (VEND.X276)        — how THEY refer to this loan, last
//
// ✅ SETTLED — the field id is VEND.X276, and both the data and the owner say so.
// It was first raised as a discrepancy: the owner originally named VEND.X267, the live
// tenant said otherwise, and this followed the data —
//   VEND.X267 = "File Contacts Investor Zip"    — 11 distinct values, all postcodes
//                                                 (19101, 80155, 75265, 10036 …)
//   VEND.X276 = "File Contacts Investor Ref #"  — 379 distinct values, the 8-11 digit
//                                                 investor loan numbers (25098221,
//                                                 5260318508, 12025062483 …)
// — because keying it on X267 would have stored a PO-Box postcode as the investor's
// loan number on every file. The owner CONFIRMED X276 on 2026-08-14 ("Investor loan
// number is vend.x276"), so measurement and the owner now agree and this is settled.
// If the tenant ever remaps these, change INVESTOR_LOAN_NUMBER_FIELD — nothing else
// reads the id directly.
const INVESTOR_LOAN_NUMBER_FIELD = 'VEND.X276';
const INVESTOR_LOAN_NUMBER_OWNER_CONFIRMED = '2026-08-14';

const IDENTITY_CHAIN = [
  { step: 1, fieldId: 'CX.WHICHINVESTOR', role: 'shorthand name',
    when: 'early — as soon as staff know who the file is going to',
    loans: 451, distinct: 83, durability: 'working value; expect it to be rough' },
  { step: 2, fieldId: 'VEND.X263', role: 'accurate name',
    when: 'later — when the investor contact record is filled in',
    loans: 408, distinct: 68,
    durability: 'more accurate than step 1, but still free text; also sometimes '
      + 'holds the SERVICER rather than the investor (see INVESTOR_FIELDS)' },
  { step: 3, fieldId: INVESTOR_LOAN_NUMBER_FIELD, role: 'the investor\'s own loan number',
    when: 'last — once the loan is bought / boarded on their system',
    loans: 379, distinct: 379,
    ownerConfirmed: INVESTOR_LOAN_NUMBER_OWNER_CONFIRMED,
    durability: 'MUST SURVIVE. It is the only shared key between our file and the '
      + 'investor\'s system, it is issued once, and nothing can regenerate it.' },
];

/**
 * The investor loan number as it should be kept on our side: the raw value, whether
 * it LOOKS like a real reference, and the reason when it does not.
 *
 * It is deliberately permissive about FORMAT — investors issue every shape (all
 * digits, letters, dashes) and refusing an unfamiliar one would lose a real number.
 * It only rejects what is provably not a reference: blank, a placeholder, or an
 * INVESTOR NAME typed into the box (seen live: "Broadview funding"), which would
 * otherwise be pushed to ClickUp as this loan's number on the investor's system.
 */
function investorLoanNumber(raw) {
  const out = { fieldId: INVESTOR_LOAN_NUMBER_FIELD, raw, value: null, usable: false, reason: null };
  if (raw == null || String(raw).trim() === '') return { ...out, reason: 'blank' };
  const v = String(raw).trim();
  if (NON_VALUE_SET.has(v.toLowerCase())) return { ...out, reason: 'placeholder' };
  // A value that resolves to a known investor is that investor's NAME, not a number.
  if (resolve(v).key && !/\d/.test(v)) return { ...out, reason: 'investor name typed into the loan-number box' };
  if (!/[A-Za-z0-9]/.test(v)) return { ...out, reason: 'no letters or digits' };
  return { ...out, value: v, usable: true };
}

// ── Where an investor name is entered ────────────────────────────────────────
const INVESTOR_FIELDS = [
  { fieldId: 'VEND.X263', label: 'File Contacts Investor Name', type: 'free text',
    loans: 408, distinct: 68, role: 'the contact-record investor name',
    note: 'Often carries the full legal name plus a parenthetical short code.' },
  { fieldId: 'CX.WHICHINVESTOR', label: 'WHICH INVESTOR', type: 'free text (custom)',
    loans: 451, distinct: 83, role: 'the staff shorthand for the investor',
    note: 'The messiest of the two — short codes, lowercase, and most of the typos.' },
  { fieldId: 'VEND.X276', label: 'File Contacts Investor Ref #', type: 'free text',
    loans: 379, distinct: 379, role: 'THE INVESTOR LOAN NUMBER — step 3 of the identity chain',
    mustSurvive: true,
    note: 'The investor\'s own loan number for this file, and the only key shared with '
      + 'their system. Issued once and unregenerable, so it must never be overwritten by '
      + 'a sync, a re-pull or a blank. Not always a number — some rows hold an investor '
      + 'NAME instead ("Broadview funding"), so run it through investorLoanNumber() '
      + 'rather than storing it raw.' },
  { fieldId: 'CX.TABLEFUNDER', label: 'TABLE FUNDER', type: 'DROPDOWNLIST',
    role: 'HOW the loan is funded, not WHO buys it — keep the two apart' },
  { fieldId: 'VEND.X271', label: 'File Contacts Investor Contact Name', type: 'free text' },
  { fieldId: 'VEND.X272', label: 'File Contacts Investor Phone', type: 'free text' },
  { fieldId: 'VEND.X273', label: 'File Contacts Investor Email', type: 'free text',
    note: 'The most reliable machine signal of all — the email DOMAIN identifies the '
      + 'investor unambiguously (deephavenmortgage.com, oaktreefunding.com…). '
      + 'Worth using as a cross-check when the typed name is ambiguous.' },
  { fieldId: 'VEND.X264', label: 'File Contacts Investor Addr', type: 'free text' },
  { fieldId: 'VEND.X265', label: 'File Contacts Investor City', type: 'free text' },
  { fieldId: 'VEND.X266', label: 'File Contacts Investor State', type: 'free text' },
  { fieldId: 'VEND.X267', label: 'File Contacts Investor Zip', type: 'free text',
    note: 'POSTCODE, not a loan number — 11 distinct values, all postcodes. Named in '
      + 'conversation as the investor loan number; the live data says otherwise, and the '
      + 'loan number is VEND.X276. See the note on INVESTOR_LOAN_NUMBER_FIELD.' },
  { fieldId: '2031', label: 'Rate Lock Sell Side Investor Status', type: 'enum',
    observedValues: ['Purchased', 'Shipped'] },
];

// The funding channel — a different question from "who is the investor".
const TABLE_FUNDER_VALUES = {
  Correspondent: 270, 'Table Funding': 147, 'Non Delegated Correspondent': 53,
  'Direct RTL / W TPR': 15, 'Direct RTL / Delegate': 10, 'Brokering out': 5,
  Wholesale: 4, 'Wholesale Out': 4, 'Delegate correspondent / Evolve': 3,
  'Delegate correspondent / In House': 1,
};

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Reduce a typed investor name to a comparison key: drop a leading reference number
 * and tab, drop a trailing parenthetical short code, drop legal suffixes and
 * punctuation, collapse whitespace, lowercase. 'Oak Tree' and 'OAKTREE' both become
 * 'oaktree'; 'A&D Mortgage, LLC' becomes 'ad'.
 */
function normalize(raw) {
  if (raw == null) return '';
  // Strip a pasted reference number BEFORE collapsing whitespace — the separator is a
  // tab, and collapsing first would turn it into an ordinary space and hide the seam.
  let s = String(raw).replace(/^\s*\d{4,}\s*[\t|,;-]\s*/, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*\([^)]*\)?\s*$/, '');             // trailing '(CF)', unclosed included
  s = s.toLowerCase();
  s = s.replace(/\b(llc|inc|incorporated|corp|corporation|company|co|lp|ltd|mortgages?|funding|financial|finance|capital|lending|holdings)\b/g, ' ');
  s = s.replace(/[^a-z0-9]+/g, '');
  return s;
}

// Pre-built lookup of every recorded spelling.
const BY_ALIAS = new Map();
const BY_KEY = new Map();
for (const inv of INVESTORS) {
  BY_KEY.set(inv.key, inv);
  for (const a of inv.aliases) {
    BY_ALIAS.set(String(a).toLowerCase().trim(), inv);
    const n = normalize(a);
    if (n && !BY_ALIAS.has('~' + n)) BY_ALIAS.set('~' + n, inv);
  }
  const n = normalize(inv.label);
  if (n && !BY_ALIAS.has('~' + n)) BY_ALIAS.set('~' + n, inv);
}
const NON_VALUE_SET = new Set(NON_VALUES.map((n) => n.raw.toLowerCase().trim()));

/**
 * Resolve any typed investor string to a canonical identity.
 * Returns { key, label, match, raw } where `match` is one of:
 *   'exact'    — the spelling is recorded verbatim in the registry
 *   'normal'   — it matched after normalization (case/space/suffix/typo-free variants)
 *   'prefix'   — it is a recognizable prefix or extension of a known investor
 *   'none'     — unrecognized; key is null and the caller must not guess
 *   'non-value'— a placeholder or stray keystroke, not a company
 */
function resolve(raw) {
  const out = { raw, key: null, label: null, match: 'none' };
  if (raw == null || String(raw).trim() === '') return out;
  const lower = String(raw).toLowerCase().trim();

  if (NON_VALUE_SET.has(lower)) return { ...out, match: 'non-value' };

  const exact = BY_ALIAS.get(lower);
  if (exact) return { ...out, key: exact.key, label: exact.label, match: 'exact' };

  const n = normalize(raw);
  if (!n) return { ...out, match: 'non-value' };
  const normal = BY_ALIAS.get('~' + n);
  if (normal) return { ...out, key: normal.key, label: normal.label, match: 'normal' };

  // Last resort: a recorded key that is a clean prefix/extension of this token. Only
  // when exactly ONE investor matches, so an ambiguous string stays unresolved.
  const hits = [];
  for (const inv of INVESTORS) {
    for (const a of [inv.label, ...inv.aliases]) {
      const an = normalize(a);
      if (an.length >= 4 && (n.startsWith(an) || an.startsWith(n))) { hits.push(inv); break; }
    }
  }
  const uniq = [...new Set(hits)];
  if (uniq.length === 1) return { ...out, key: uniq[0].key, label: uniq[0].label, match: 'prefix' };
  return out;
}

/** True when two typed investor names mean the same company. Unresolved never matches. */
function sameInvestor(a, b) {
  const ra = resolve(a);
  const rb = resolve(b);
  return !!(ra.key && rb.key && ra.key === rb.key);
}

/** One canonical investor by key. */
function byKey(key) { return BY_KEY.get(String(key)) || null; }

/** The canonical list, most-seen first — the option set to offer in a picker. */
function list() { return [...INVESTORS].sort((a, b) => (b.seen || 0) - (a.seen || 0)); }

function summary() {
  return {
    canonicalInvestors: INVESTORS.length,
    recordedSpellings: INVESTORS.reduce((n, i) => n + i.aliases.length, 0),
    nonValues: NON_VALUES.length,
    needingOwnerAnswer: INVESTORS.filter((i) => i.unverified).map((i) => i.key),
    sharedWithShortTerm: INVESTORS.filter((i) => i.alsoOnRtl).map((i) => i.key),
    investorFields: INVESTOR_FIELDS.length,
    identityChain: IDENTITY_CHAIN.map((s) => s.fieldId),
    investorLoanNumberField: INVESTOR_LOAN_NUMBER_FIELD,
    investorLoanNumberOwnerConfirmed: INVESTOR_LOAN_NUMBER_OWNER_CONFIRMED,
    source: '772 loans read from the live tenant, 2026-08-14',
  };
}

module.exports = {
  INVESTORS, NON_VALUES, INVESTOR_FIELDS, TABLE_FUNDER_VALUES,
  IDENTITY_CHAIN, INVESTOR_LOAN_NUMBER_FIELD, INVESTOR_LOAN_NUMBER_OWNER_CONFIRMED,
  investorLoanNumber,
  normalize, resolve, sameInvestor, byKey, list, summary,
};

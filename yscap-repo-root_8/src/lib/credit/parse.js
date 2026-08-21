'use strict';
/**
 * Credit-report XML → normalized structure (dependency-free).
 *
 * Xactus (like every mortgage credit vendor) returns a tri-merge credit report
 * as a MISMO CREDIT_RESPONSE document. This module turns that XML into ONE
 * stable, normalized object the rest of PILOT reads — the credit-details
 * section, the FICO write-back, and the underwriting engine — so nothing
 * downstream ever has to know the vendor's wire shape.
 *
 * It is deliberately TOLERANT across the two MISMO families a credit file can
 * arrive in, because the exact shape is confirmed against Xactus's onboarding
 * packet and we store the raw XML regardless:
 *   - MISMO 2.x  — data on UNDERSCORE-PREFIXED ATTRIBUTES
 *                  (`<CREDIT_SCORE _Value="712" CreditRepositorySourceType="Equifax"/>`)
 *   - MISMO 3.x  — data in CHILD ELEMENTS
 *                  (`<CREDIT_SCORE><CreditScoreValue>712</CreditScoreValue>…`)
 * Every field is pulled with a candidate list that tries BOTH, so a Xactus
 * "3.4" response and a legacy 2.x response both parse without a code change.
 *
 * Pure: no DB, no network, no `new Date()` (dates are normalized as calendar
 * strings per the repo's date rule). Never throws on a missing field — a short
 * or malformed file yields a partial object with `parseError` set, never a crash.
 */
const X = require('../mismo/xml');

// -------------------------------------------------------------- small helpers ---
const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[$,\s]/g, '').replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// Normalize a MISMO date to a 'YYYY-MM-DD' calendar string WITHOUT `new Date()`
// (tz-safe per the repo rule). Accepts YYYY-MM-DD, MM/DD/YYYY, YYYYMMDD, and
// the datetime forms MISMO sometimes carries (keeps only the date part).
function isoDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let y, mo, d, m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }        // ISO / datetime
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) { y = +m[3]; mo = +m[1]; d = +m[2]; }  // US MM/DD/YYYY
  else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }         // compact
  else return null;
  // Validate a REAL calendar date so a malformed value (e.g. 2026-25-12, day-first
  // 25/12/2026, Feb 30, 0000-00-00) never reaches the typed `date` column and
  // crashes the credit_reports INSERT after the documents were already stored.
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0));
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > dim[mo - 1]) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${y}-${p2(mo)}-${p2(d)}`;
}

/**
 * Pull one field from a node, trying attribute names (2.x) then child-element
 * local names (3.x), in order — first non-empty wins. Attribute names are the
 * literal MISMO names (usually underscore-prefixed, e.g. `_Value`).
 */
function field(node, attrs, els) {
  if (!node) return '';
  for (const a of (attrs || [])) {
    const v = X.attr(node, a);
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  for (const e of (els || [])) {
    const t = X.textAt(node, e);
    if (t && t.trim() !== '') return t.trim();
    // one level deeper (some 3.x wrap the value one container down)
    const deep = X.firstDeep(node, e);
    if (deep && deep.text && deep.text.trim() !== '') return deep.text.trim();
  }
  return '';
}

// Canonical bureau name from any of the many spellings vendors emit. Match the
// bureau-SPECIFIC tokens first (equifax/beacon, transunion/empirica,
// experian/xpn); never key off "fico"/"fairisaac" — every bureau sells a FICO
// model, so those are ambiguous. The authoritative source is the
// CreditRepositorySourceType field; the model name is only a fallback.
function bureau(v) {
  const s = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  if (s.includes('equifax') || s.includes('beacon')) return 'Equifax';
  if (s.includes('transunion') || s.includes('empirica')) return 'TransUnion';
  if (s.includes('experian') || s.includes('xpn')) return 'Experian';
  if (s === 'efx') return 'Equifax';
  if (s === 'tu') return 'TransUnion';
  return null;
}

// ------------------------------------------------------------------ sections ---
// One <CREDIT_SCORE> node → a score object, or null when it isn't a usable score.
function scoreFrom(s) {
  const value = num(field(s, ['_Value', 'CreditScoreValue'], ['CreditScoreValue']));
  // A real FICO/VantageScore is 300–850. Bureaus return REJECT / no-hit codes
  // (0, 9001–9004, etc.) for frozen/thin/no-record files — very common for this
  // RTL/fix-and-flip borrower population. Treat anything outside 300–850 as
  // "no score" so it never lands in the 300–850-CHECKed middle_score column
  // and never shows as a bogus bureau chip.
  if (value == null || value < 300 || value > 850) return null;
  const src = field(s, ['CreditRepositorySourceType', '_CreditRepositorySourceType'],
    ['CreditRepositorySourceType']);
  const model = field(s, ['_ModelNameType', 'CreditScoreModelNameType', '_Name'],
    ['CreditScoreModelNameType', 'CreditScoreModelName']);
  const factors = [];
  for (const f of X.allDeep(s, '_FACTOR').concat(X.allDeep(s, 'CREDIT_SCORE_FACTOR'))) {
    const code = field(f, ['_Code', 'FactorCode', 'CreditScoreFactorCode'], ['CreditScoreFactorCode']);
    const text = field(f, ['_Text', 'FactorText', 'CreditScoreFactorText'], ['CreditScoreFactorText']);
    if (code || text) factors.push({ code: code || null, text: text || null });
  }
  return { bureau: bureau(src) || bureau(model) || null, model: model || null, value, factors };
}

// De-dupe to at most one score per bureau (first wins), keep unknown-bureau ones too.
// Applied PER BORROWER — on a merged (joint) report each borrower has their own
// Equifax/Experian/TransUnion score, so a document-wide de-dupe would silently
// throw the second borrower's scores away.
function dedupeScores(list) {
  const seen = new Set();
  return list.filter((s) => {
    if (!s.bureau) return true;
    if (seen.has(s.bureau)) return false;
    seen.add(s.bureau); return true;
  });
}

/**
 * A parse has TWO scopes, never one — the bug that made every MISMO 3.4 JOINT report
 * hand both borrowers the same score (owner-reported 2026-08-21).
 *
 *   • the CONTENT scope — where the credit items live: every `CREDIT_RESPONSE` in the
 *     document (a vendor may return one per borrower; reading only the first silently
 *     dropped the second borrower's entire report), or the whole document when there
 *     is none.
 *   • the IDENTITY scope — the WHOLE document. MISMO 3.4 keeps the borrower PARTIES
 *     and the `RELATIONSHIP` arcs that bind a score to a person at DEAL level,
 *     OUTSIDE `<CREDIT_RESPONSE>`. Looking for them inside it found nobody, so the
 *     joint split never ran and the flat per-bureau de-dupe mixed two people's scores.
 *
 * A scope is an ARRAY of root nodes. `deep()` reads them as one, de-duplicating by
 * node identity so overlapping roots (a PARTY nested inside a CREDIT_RESPONSE) never
 * yield the same item twice.
 */
function deep(scope, local) {
  const roots = Array.isArray(scope) ? scope : [scope];
  const out = [];
  const seen = new Set();
  for (const r of roots) {
    if (!r) continue;
    for (const n of X.allDeep(r, local)) if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function parseScores(scope) {
  return dedupeScores(deep(scope, 'CREDIT_SCORE').map(scoreFrom).filter(Boolean));
}

// The single representative score for a borrower: middle of 3, lower of 2, or the one.
// Compute over ONE score per RECOGNIZED bureau (Equifax/Experian/TransUnion) so a
// supplementary/unclassifiable score (e.g. a VantageScore, or a repository the
// bureau() map doesn't know) can't pollute the median and push a wrong FICO into
// pricing. Fall back to all scores only when NONE classify (e.g. numeric-code
// repositories) so that case still yields a true middle.
function representative(scores) {
  const known = (scores || []).filter((s) => s.bureau);
  const pool = known.length ? known : (scores || []);
  const vals = pool.map((s) => s.value).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (vals.length === 0) return null;
  if (vals.length === 1) return vals[0];
  if (vals.length === 2) return vals[0]; // lower of two
  return vals[Math.floor((vals.length - 1) / 2)]; // middle of three+
}

function liabilityNodes(scope) {
  return deep(scope, 'CREDIT_LIABILITY').concat(
    deep(scope, 'LIABILITY').filter((n) => n.local === 'LIABILITY'));
}

// One <CREDIT_LIABILITY> / <LIABILITY> node → a tradeline object.
function liabilityFrom(l) {
  const creditorNode = X.firstDeep(l, '_CREDITOR') || X.firstDeep(l, 'CREDITOR') || X.firstDeep(l, 'CREDIT_LIABILITY_CREDITOR');
  const creditor = field(creditorNode, ['_Name', 'Name', '_FullName'], ['FullName', 'Name'])
    || field(l, ['_SubscriberName', 'CreditorName'], ['CreditorName']);
  const rating = X.firstDeep(l, '_CURRENT_RATING') || X.firstDeep(l, 'CURRENT_RATING');
  const late = X.firstDeep(l, '_LATE_COUNT') || X.firstDeep(l, 'LATE_COUNT');
  const type = field(l, ['CreditLiabilityAccountType', '_AccountType'], ['CreditLiabilityAccountType']);
  const status = field(l, ['_AccountStatusType', 'CreditLiabilityAccountStatusType'], ['CreditLiabilityAccountStatusType']);
  const repos = X.allDeep(l, 'CREDIT_REPOSITORY').concat(X.allDeep(l, 'CreditRepository'))
    .map((r) => bureau(field(r, ['_SourceType', 'CreditRepositorySourceType'], ['CreditRepositorySourceType'])))
    .filter(Boolean);
  return {
    creditor: creditor || null,
      accountType: type || null,
      accountNumberMasked: field(l, ['_AccountIdentifier', 'CreditLiabilityAccountIdentifier'], ['CreditLiabilityAccountIdentifier']) || null,
      ownership: field(l, ['_AccountOwnershipType', 'CreditLiabilityAccountOwnershipType'], ['CreditLiabilityAccountOwnershipType']) || null,
      status: status || null,
      open: /open/i.test(status) ? true : (/closed|paid/i.test(status) ? false : null),
      balance: num(field(l, ['_UnpaidBalanceAmount', 'CreditLiabilityUnpaidBalanceAmount'], ['CreditLiabilityUnpaidBalanceAmount'])),
      highCredit: num(field(l, ['_HighCreditAmount', 'CreditLiabilityHighCreditAmount'], ['CreditLiabilityHighCreditAmount'])),
      creditLimit: num(field(l, ['CreditLimitAmount', '_CreditLimitAmount', 'CreditLiabilityCreditLimitAmount'], ['CreditLiabilityCreditLimitAmount'])),
      monthlyPayment: num(field(l, ['_MonthlyPaymentAmount', 'CreditLiabilityMonthlyPaymentAmount'], ['CreditLiabilityMonthlyPaymentAmount'])),
      pastDue: num(field(l, ['_PastDueAmount', 'CreditLiabilityPastDueAmount'], ['CreditLiabilityPastDueAmount'])),
      dateOpened: isoDate(field(l, ['_AccountOpenedDate', 'CreditLiabilityAccountOpenedDate'], ['CreditLiabilityAccountOpenedDate'])),
      dateReported: isoDate(field(l, ['_AccountReportedDate', '_LastActivityDate', 'CreditLiabilityAccountReportedDate'], ['CreditLiabilityAccountReportedDate'])),
      currentRating: field(rating, ['_Type', '_Code', 'Type'], ['Type']) || null,
      late30: num(field(late, ['_30Days', 'CreditLiabilityLate30Days'], ['CreditLiabilityLate30Days'])) || 0,
      late60: num(field(late, ['_60Days', 'CreditLiabilityLate60Days'], ['CreditLiabilityLate60Days'])) || 0,
      late90: num(field(late, ['_90Days', 'CreditLiabilityLate90Days'], ['CreditLiabilityLate90Days'])) || 0,
    isCollection: /collection/i.test(type) || /collection/i.test(status),
    bureaus: Array.from(new Set(repos)),
  };
}

function parseLiabilities(scope) {
  return liabilityNodes(scope).map(liabilityFrom);
}

// A credit inquiry's HARD/SOFT nature. A HARD inquiry (a full pull to seek new
// credit) lands on the borrower's file and can move the score; a SOFT one (an
// account review, a pre-approval offer, the borrower's own check) does not. Every
// MISMO 2.x inquiry carries it as _PurposeType="HARD"/"SOFT"; some files spell it
// out. Anything we can't read stays null rather than guessing a HARD.
function inquiryPurpose(v) {
  const s = String(v || '').toLowerCase();
  if (!s) return null;
  if (s.includes('hard')) return 'hard';
  if (s.includes('soft')) return 'soft';
  return null;
}

// Space out MISMO's glued CamelCase enums so a row reads like words
// ("OilAndNationalCreditCards" → "Oil And National Credit Cards"); an
// already-spaced value ("National Credit Card Cos.") is left untouched.
function spaceCamel(s) {
  return String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

// One <CREDIT_INQUIRY> node → an inquiry object. A real MISMO 2.x inquiry carries
// far more than who/when/which-bureau — the HARD/SOFT purpose, the inquirer's line
// of business, and its mailing address are all right on the element; pulling only
// name/date/bureau silently dropped the underwriting-relevant half of each row.
function inquiryFrom(q) {
  const street = field(q, ['_StreetAddress', 'AddressLineText'], ['AddressLineText']);
  const city = field(q, ['_City', 'CityName'], ['CityName']);
  const state = field(q, ['_State', 'StateCode'], ['StateCode']);
  const zip = field(q, ['_PostalCode', 'PostalCode'], ['PostalCode']);
  const address = [street, [city, state].filter(Boolean).join(', '), zip]
    .filter(Boolean).join(' ').trim() || null;
  return {
    name: field(q, ['_Name', 'CreditInquiryName', '_SubscriberName'], ['CreditInquiryName', 'Name']) || null,
    date: isoDate(field(q, ['_Date', 'CreditInquiryDate'], ['CreditInquiryDate'])),
    bureau: bureau(field(X.firstDeep(q, 'CREDIT_REPOSITORY') || q,
      ['_SourceType', 'CreditRepositorySourceType'], ['CreditRepositorySourceType'])),
    // HARD vs SOFT — a HARD pull hints at new debt the borrower may not have
    // disclosed, so it is the half of an inquiry underwriting actually reads.
    purpose: inquiryPurpose(field(q, ['_PurposeType', 'CreditInquiryPurposeType'], ['CreditInquiryPurposeType'])),
    // What kind of business inquired (a bank, an auto lender, a card issuer) so the
    // row is more than an opaque subscriber code. CreditBusinessType is the MISMO
    // enum (both families); RawIndustryText is the vendor's readable fallback.
    business: (spaceCamel(field(q, ['CreditBusinessType', '_BusinessType'], ['CreditBusinessType']))
      || field(q, ['RawIndustryText'], [])) || null,
    // The inquirer's mailing address when the file carries it (MISMO 2.x puts it
    // right on the inquiry) — lets staff tell two same-named subscribers apart.
    address,
  };
}

function parseInquiries(scope) {
  return deep(scope, 'CREDIT_INQUIRY').map(inquiryFrom);
}

function publicRecordFrom(p) {
  return {
    type: field(p, ['_Type', 'CreditPublicRecordType', '_DerogatoryDataIndicator'], ['CreditPublicRecordType']) || null,
    date: isoDate(field(p, ['_FiledDate', '_Date', 'CreditPublicRecordFiledDate'], ['CreditPublicRecordFiledDate'])),
    amount: num(field(p, ['_Amount', 'CreditPublicRecordLiabilityAmount'], ['CreditPublicRecordLiabilityAmount'])),
    status: field(p, ['_DispositionType', '_Status', 'CreditPublicRecordDispositionType'], ['CreditPublicRecordDispositionType']) || null,
    court: field(p, ['_CourtName', 'CreditPublicRecordCourtName'], ['CreditPublicRecordCourtName']) || null,
  };
}

function parsePublicRecords(scope) {
  return deep(scope, 'CREDIT_PUBLIC_RECORD').map(publicRecordFrom);
}

// The identity block for ONE borrower. `b` is the BORROWER node (MISMO 2.x) or the
// PARTY that wraps the borrower role (MISMO 3.x — the name/SSN live on the party).
function identityFrom(b) {
  if (!b) return null;
  const ssn = field(b, ['_SSN', '_UnparsedName', 'SSN', 'TaxpayerIdentifierValue'], ['TaxpayerIdentifierValue']);
  return {
    firstName: field(b, ['_FirstName', 'FirstName'], ['FirstName']) || null,
    lastName: field(b, ['_LastName', 'LastName'], ['LastName']) || null,
    middleName: field(b, ['_MiddleName', 'MiddleName'], ['MiddleName']) || null,
    ssnLast4: ssn ? String(ssn).replace(/\D/g, '').slice(-4) || null : null,
    dob: isoDate(field(b, ['_BirthDate', 'BirthDate'], ['BirthDate'])),
    addresses: X.allDeep(b, '_RESIDENCE').concat(X.allDeep(b, 'RESIDENCE')).map((r) => ({
      street: field(r, ['_StreetAddress', 'AddressLineText'], ['AddressLineText']) || null,
      city: field(r, ['_City', 'CityName'], ['CityName']) || null,
      state: field(r, ['_State', 'StateCode'], ['StateCode']) || null,
      zip: field(r, ['_PostalCode', 'PostalCode'], ['PostalCode']) || null,
    })).filter((a) => a.street || a.city),
    employers: X.allDeep(b, '_EMPLOYER').concat(X.allDeep(b, 'EMPLOYER')).map((e) =>
      field(e, ['_Name', 'FullName', 'EmployerName'], ['FullName', 'EmployerName'])).filter(Boolean),
  };
}

// ------------------------------------------- merged (joint) report segmentation ---
/**
 * A MERGED (joint) credit report is ONE document covering BOTH borrowers: two sets
 * of bureau scores, and tradelines/inquiries/records belonging to one borrower or
 * the other (or jointly to both). Read flat, such a file is worse than useless —
 * the per-bureau de-dupe throws the second borrower's scores away and the "middle"
 * score becomes the median of six numbers from two different people.
 *
 * These helpers split one CREDIT_RESPONSE into one SEGMENT per borrower. Ownership
 * of each item is established three ways, in order of certainty — never guessed:
 *   1. STRUCTURE — the item sits inside that borrower's own subtree (MISMO 3.x
 *      nests scores under PARTY/ROLES/ROLE/BORROWER).
 *   2. EXPLICIT LINK — the item carries `_BorrowerID`/`BorrowerID` naming that
 *      borrower's `_ID` (MISMO 2.x, how Xactus labels a joint response).
 *   3. RELATIONSHIP ARC — MISMO 3.x `<RELATIONSHIP xlink:from="…" xlink:to="…">`
 *      ties a labelled element to a labelled party.
 * Anything that matches none of the three is SHARED (a joint account is genuinely
 * both borrowers'): shared tradelines/inquiries/records appear in each borrower's
 * slice flagged `sharedAcrossBorrowers`, while a shared SCORE is never attributed
 * to anyone — an unlabelled score could price the wrong borrower's deal.
 */
function parentMap(scope) {
  const parents = new Map();
  const roots = Array.isArray(scope) ? scope : [scope];
  const walk = (n) => { for (const c of n.children) { parents.set(c, n); walk(c); } };
  for (const r of roots) if (r) walk(r);
  return parents;
}

function ancestorsOf(node, parents) {
  const out = [];
  let p = parents.get(node);
  while (p) { out.push(p); p = parents.get(p); }
  return out;
}

function subtreeSet(node) {
  const s = new Set();
  (function walk(n) { s.add(n); for (const c of n.children) walk(c); })(node);
  return s;
}

const idTokens = (v) => String(v || '').split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);

// The id(s) a borrower/party is known by. `label` matches MISMO 3.x `xlink:label`
// (X.attr matches on the attribute's local name, so the prefix doesn't matter).
function identifiersOf(node) {
  const out = [];
  for (const a of ['_ID', 'BorrowerID', '_BorrowerID', 'label']) out.push(...idTokens(X.attr(node, a)));
  return out;
}

// The borrower id(s) an ITEM points at (MISMO 2.x explicit link; a joint tradeline
// may name both).
function ownerIdsOf(node) {
  const out = [];
  for (const a of ['_BorrowerID', 'BorrowerID', '_BorrowerId', 'BorrowerId']) out.push(...idTokens(X.attr(node, a)));
  return out;
}

// label → the labels it is related to, from MISMO 3.x RELATIONSHIP arcs (both ways).
function relationshipMap(scope) {
  const map = new Map();
  const add = (a, b) => { if (!map.has(a)) map.set(a, new Set()); map.get(a).add(b); };
  for (const rel of deep(scope, 'RELATIONSHIP')) {
    const from = X.attr(rel, 'from');
    const to = X.attr(rel, 'to');
    if (!from || !to) continue;
    add(from, to); add(to, from);
  }
  return map;
}

// True when an identity block actually names somebody.
function namedIdentity(id) {
  return !!(id && (id.firstName || id.lastName || id.ssnLast4));
}

// The letters of a name, order-insensitive — "PATRICK KAMARA" and the alias form
// "KAMARA PATRICK" are the same person written two ways.
function nameKey(identity) {
  const parts = [identity && identity.firstName, identity && identity.lastName]
    .map((s) => String(s || '').toLowerCase().replace(/[^a-z]/g, ''))
    .filter(Boolean);
  return parts.length ? parts.sort().join('|') : '';
}

/**
 * Are these two borrower records the SAME human?
 *
 * A real vendor report repeats the borrower once per bureau file (and again at the
 * deal level), sometimes with the name reversed — so "how many BORROWER elements
 * are there" is NOT "how many people are on this report". The SSN decides when both
 * sides carry one (two different last-4s are two different people, full stop);
 * otherwise the name does.
 */
function samePerson(a, b) {
  const sa = a.identity && a.identity.ssnLast4;
  const sb = b.identity && b.identity.ssnLast4;
  if (sa && sb) return String(sa) === String(sb);
  const na = nameKey(a.identity);
  const nb = nameKey(b.identity);
  return !!na && na === nb;
}

/**
 * The DISTINCT borrowers this document covers, as segment shells (root node, ids,
 * subtree). Repeated records of one person are folded into a single shell — its
 * `nodes`/`ids` are the union, so an item under ANY of that person's copies is
 * attributed to them.
 *
 * Returns fewer than two shells for an ordinary single-borrower report, and the
 * single-borrower path then stays byte-for-byte what it has always been.
 */
function borrowerShells(scope, parents) {
  const shells = [];
  const roots = new Set();
  for (const b of deep(scope, 'BORROWER').concat(deep(scope, 'CREDIT_BORROWER'))) {
    const anc = ancestorsOf(b, parents);
    // MISMO 3.x keeps the NAME/SSN on the PARTY that wraps the borrower role, so the
    // party (when there is one) is the segment root; 2.x uses the BORROWER itself.
    const root = anc.find((a) => a.local === 'PARTY') || b;
    if (roots.has(root)) continue;
    const identity = identityFrom(root) || identityFrom(b);
    // An empty placeholder is not a borrower — a phantom segment would split a
    // perfectly ordinary single-borrower report in two.
    if (!identity || (!identity.firstName && !identity.lastName && !identity.ssnLast4)) continue;
    roots.add(root);
    const ids = new Set([
      ...identifiersOf(b),
      ...(root !== b ? identifiersOf(root) : []),
      ...anc.filter((a) => a.local === 'ROLE' || a.local === 'PARTY').flatMap((a) => identifiersOf(a)),
    ]);
    const shell = {
      root, node: b, ids, nodes: subtreeSet(root), identity,
      // The DEAL-level party (…/PARTIES/PARTY) is the canonical record of the person;
      // the copies under CREDIT_FILES are each bureau's own version of them.
      deal: anc.some((a) => a.local === 'PARTIES'),
      printPosition: field(b, ['_PrintPositionType', 'BorrowerPrintPositionType'], ['BorrowerPrintPositionType']) || null,
    };

    const existing = shells.find((s) => samePerson(s, shell));
    if (existing) {
      shell.ids.forEach((id) => existing.ids.add(id));
      shell.nodes.forEach((n) => existing.nodes.add(n));
      // Keep the fullest record of the person: prefer the deal-level party, then the
      // one that actually carries a name.
      const better = (!existing.deal && shell.deal)
        || (!existing.identity.firstName && shell.identity.firstName);
      if (better) { existing.identity = shell.identity; existing.deal = existing.deal || shell.deal; }
      if (!existing.printPosition && shell.printPosition) existing.printPosition = shell.printPosition;
      continue;
    }
    shells.push(shell);
  }
  return shells;
}

/**
 * The deal-level `PARTIES` block is MISMO's authoritative statement of WHO the report
 * covers. A borrower record nested inside a `CREDIT_FILE` is one bureau's copy of one
 * of those people, carrying that bureau's spelling of the name — which is very often a
 * maiden or alias surname (the co-borrower filed with Equifax as "Michelle Katz" and
 * with the other two as "Michelle Bleier", owner-reported 2026-08-21). Read as its own
 * person, such a copy invents a borrower who owns nothing and pushes a phantom name
 * onto the screen.
 *
 * So when the document names deal-level parties, THEY are the roster. Every bureau
 * copy is folded into the party it resolves to — by SSN, then by name, then by a
 * RELATIONSHIP arc, and finally "there is only one person on this report". A copy that
 * resolves to nobody is dropped from the roster rather than promoted to a borrower;
 * anything sitting inside it is then owned by no segment, which is the module's
 * existing fail-closed rule (an unattributable score is never given to anyone).
 */
function foldBureauCopies(shells, rel) {
  const deal = shells.filter((s) => s.deal);
  if (!deal.length || deal.length === shells.length) return shells;
  const arcLinked = (from, to) => {
    for (const id of from.ids) {
      const linked = rel.get(id);
      if (linked && Array.from(to.ids).some((x) => linked.has(x))) return true;
    }
    return false;
  };
  const ssnOf = (sh) => (sh.identity && sh.identity.ssnLast4) || null;
  // Only an SSN contradicts. A different NAME is precisely the case this fold exists
  // for (the alias surname on one bureau's file), so it must never block a fold.
  const contradicts = (party, copy) => {
    const a = ssnOf(party); const b = ssnOf(copy);
    return !!(a && b && String(a) !== String(b));
  };
  const orphans = [];
  for (const copy of shells) {
    if (copy.deal) continue;
    const host = deal.find((d) => samePerson(d, copy))
      || deal.find((d) => arcLinked(copy, d))
      || (deal.length === 1 && !contradicts(deal[0], copy) ? deal[0] : null);
    if (!host) {
      // Kept as its own borrower ONLY when the copy carries an SSN that belongs to
      // none of the deal parties — that is proof of a different human. Without that
      // proof it is dropped from the roster rather than promoted to a phantom.
      const s4 = ssnOf(copy);
      if (s4 && !deal.some((d) => String(ssnOf(d)) === String(s4))) orphans.push(copy);
      continue;
    }
    copy.ids.forEach((id) => host.ids.add(id));
    copy.nodes.forEach((n) => host.nodes.add(n));
    if (!host.printPosition && copy.printPosition) host.printPosition = copy.printPosition;
  }
  return deal.concat(orphans);
}

// Which segments own this node — [] when nothing links it (shared/joint).
function ownersOf(node, shells, rel) {
  const inside = [];
  shells.forEach((s, i) => { if (s.nodes.has(node)) inside.push(i); });
  if (inside.length) return inside;

  const toks = ownerIdsOf(node);
  if (toks.length) {
    const hits = [];
    shells.forEach((s, i) => { if (toks.some((t) => s.ids.has(t))) hits.push(i); });
    if (hits.length) return hits;
  }

  const label = X.attr(node, 'label');
  if (label && rel.has(label)) {
    const linked = rel.get(label);
    const hits = [];
    shells.forEach((s, i) => { if (Array.from(s.ids).some((id) => linked.has(id))) hits.push(i); });
    if (hits.length) return hits;
  }
  return [];
}

// Split every section across the borrower shells. Items nobody claims are shared.
function splitSections(scope, shells, rel) {
  const per = shells.map(() => ({ scores: [], liabilities: [], inquiries: [], publicRecords: [] }));
  const shared = { scores: [], liabilities: [], inquiries: [], publicRecords: [] };
  const spread = (nodes, map, key) => {
    for (const n of nodes) {
      const item = map(n);
      if (!item) continue;
      const owners = ownersOf(n, shells, rel);
      if (!owners.length) { shared[key].push(item); continue; }
      for (const i of owners) per[i][key].push(item);
    }
  };
  spread(deep(scope, 'CREDIT_SCORE'), scoreFrom, 'scores');
  spread(liabilityNodes(scope), liabilityFrom, 'liabilities');
  spread(deep(scope, 'CREDIT_INQUIRY'), inquiryFrom, 'inquiries');
  spread(deep(scope, 'CREDIT_PUBLIC_RECORD'), publicRecordFrom, 'publicRecords');
  return { per, shared };
}

/**
 * Build the per-borrower segments of a merged document.
 * @returns {{segments: object[], unattributedScores: object[], splittable: boolean}}
 *   `segments` is empty when the document covers fewer than two distinct borrowers
 *   (the ordinary single-borrower path, untouched). `splittable` is false when it
 *   names several people but labels NOBODY's scores — see the caller.
 */
function borrowerSegments(content, doc) {
  // Identity (who the borrowers are) and the arcs that bind an item to a person are
  // read from the WHOLE document — MISMO 3.4 keeps both outside <CREDIT_RESPONSE>.
  // The items themselves are still read only from the credit content.
  const idScope = doc || content;
  const parents = parentMap(idScope);
  const rel = relationshipMap(idScope);
  const shells = foldBureauCopies(borrowerShells(idScope, parents), rel);
  // The canonical record of the (first) person on the report — the deal-level party
  // when there is one. MISMO 3.x keeps the name/SSN there rather than on the
  // BORROWER element, so this is the only place a 3.x identity can be read from.
  const primary = shells.find((s) => s.deal) || shells[0];
  const primaryIdentity = primary ? primary.identity : null;
  if (shells.length < 2) return { segments: [], unattributedScores: [], splittable: false, primaryIdentity };
  const { per, shared } = splitSections(content, shells, rel);
  const mark = (arr) => arr.map((x) => ({ ...x, sharedAcrossBorrowers: true }));

  const segments = shells.map((s, i) => {
    const scores = dedupeScores(per[i].scores);
    // Joint/unlabelled items read as BOTH borrowers' (that is what a joint account
    // is). An unlabelled SCORE is deliberately NOT adopted — see the header note.
    const liabilities = per[i].liabilities.concat(mark(shared.liabilities));
    const inquiries = per[i].inquiries.concat(mark(shared.inquiries));
    const publicRecords = per[i].publicRecords.concat(mark(shared.publicRecords));
    const identity = s.identity || {};
    return {
      key: `b${i + 1}`,
      ids: Array.from(s.ids),
      printPosition: s.printPosition,
      name: [identity.firstName, identity.lastName].filter(Boolean).join(' ') || null,
      firstName: identity.firstName || null,
      lastName: identity.lastName || null,
      ssnLast4: identity.ssnLast4 || null,
      dob: identity.dob || null,
      borrower: identity,
      scores,
      middleScore: representative(scores),
      bureausReturned: Array.from(new Set(
        scores.map((x) => x.bureau).filter(Boolean).concat(liabilities.flatMap((l) => l.bureaus || [])))),
      liabilities,
      inquiries,
      publicRecords,
      summary: summarize(liabilities, inquiries, publicRecords),
      ownCounts: {
        scores: per[i].scores.length, liabilities: per[i].liabilities.length,
        inquiries: per[i].inquiries.length, publicRecords: per[i].publicRecords.length,
      },
      sharedCounts: {
        liabilities: shared.liabilities.length, inquiries: shared.inquiries.length,
        publicRecords: shared.publicRecords.length, scores: shared.scores.length,
      },
    };
  });
  // Splitting is only real when the document actually says WHOSE scores are whose.
  // If it names several people but labels none of the scores, the per-borrower view
  // would hand everyone a blank score — worse than the plain whole-document read.
  const splittable = segments.some((s) => s.scores.length > 0);
  return { segments, unattributedScores: dedupeScores(shared.scores), splittable, primaryIdentity };
}

/**
 * Narrow a parsed merged report down to ONE borrower's segment, keeping the
 * document-level facts (version, report id/date, source). This is what gets stored
 * as that borrower's credit_reports row, so their score, tradelines and summary are
 * theirs alone — never the other borrower's numbers.
 */
function sliceForSegment(parsed, segment) {
  if (!parsed || !segment) return parsed;
  const others = (parsed.borrowers || []).filter((b) => b.key !== segment.key).map((b) => b.name).filter(Boolean);
  return {
    ...parsed,
    scores: segment.scores,
    middleScore: segment.middleScore,
    bureausReturned: segment.bureausReturned,
    borrower: segment.borrower,
    liabilities: segment.liabilities,
    inquiries: segment.inquiries,
    publicRecords: segment.publicRecords,
    summary: segment.summary,
    // The slice IS one borrower's report — drop the roster so nothing downstream
    // mistakes a stored slice for a whole merged document.
    borrowers: [],
    isMerged: false,
    mergedSource: {
      borrowerKey: segment.key,
      borrowerName: segment.name,
      borrowerCount: (parsed.borrowers || []).length,
      otherBorrowers: others,
      sharedItems: segment.sharedCounts || null,
      unattributedScores: (parsed.mergedUnattributedScores || []).length,
    },
  };
}

function summarize(liabilities, inquiries, publicRecords) {
  const open = liabilities.filter((l) => l.open !== false);
  const sum = (arr, k) => arr.reduce((a, l) => a + (Number(l[k]) || 0), 0);
  return {
    tradelineCount: liabilities.length,
    openCount: open.length,
    totalBalance: sum(liabilities, 'balance'),
    totalMonthlyPayments: sum(open, 'monthlyPayment'),
    totalPastDue: sum(liabilities, 'pastDue'),
    revolvingBalance: sum(liabilities.filter((l) => /revolv/i.test(l.accountType || '')), 'balance'),
    delinquentCount: liabilities.filter((l) => (l.late30 + l.late60 + l.late90) > 0 || (l.pastDue || 0) > 0).length,
    collectionCount: liabilities.filter((l) => l.isCollection).length,
    publicRecordCount: publicRecords.length,
    inquiryCount: inquiries.length,
    // How many of those inquiries are HARD pulls — the ones that move the score and
    // point at new-credit-seeking (soft account reviews are noise for underwriting).
    hardInquiryCount: inquiries.filter((q) => q && q.purpose === 'hard').length,
  };
}

/**
 * When a response carries NO credit data, say what the document actually was.
 *
 * A vendor error envelope or a gateway page comes back with HTTP 200 and parses
 * fine — it just contains no report. "No credit data recognized in the response" is
 * then true but useless; the document's own error text ("login not authorized",
 * "report not found for reissue") is what tells staff what to fix.
 *
 * Deliberately conservative: the top element plus ONE short message line, with any
 * SSN-shaped digits masked (an error can echo the borrower's data back).
 */
const MESSAGE_ELS = /^(ERROR|ERRORS|_ERROR|MESSAGE|STATUS|STATUS_DESCRIPTION|REASON|DESCRIPTION|TITLE|H1|P|FAULTSTRING|ERRORDESCRIPTION|ERRORMESSAGE|STATUSDESCRIPTION)$/i;
function documentHint(root) {
  if (!root) return null;
  const seen = [];
  (function walk(n, depth) {
    if (seen.length || depth > 8) return;
    // MISMO 2.x prefixes element names with an underscore (`_Description`).
    if (MESSAGE_ELS.test(String(n.local || '').replace(/^_+/, ''))) {
      const t = (n.text || '').trim()
        || (X.attr(n, '_Description') || X.attr(n, 'Description') || X.attr(n, '_Text') || '').trim();
      if (t) { seen.push(t); return; }
    }
    for (const c of n.children) walk(c, depth + 1);
  })(root, 0);
  if (!seen.length) return null;
  return seen[0]
    .replace(/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, '•••-••-••••')   // SSN-shaped
    .replace(/\b\d{9,}\b/g, '•••••')                             // any long digit run
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

/**
 * Parse a credit-report XML string into the normalized PILOT credit object.
 * @param {string} xml
 * @returns {object} normalized report (see module docstring); `parseError` set on failure.
 */
function parseCreditXml(xml) {
  const base = {
    version: null, bureausReturned: [], scores: [], middleScore: null,
    borrower: null, liabilities: [], inquiries: [], publicRecords: [],
    summary: null, reportDate: null, reportId: null, tradeReferenceType: null, parseError: null,
    // Merged (joint) reports only — one entry per borrower the document covers.
    borrowers: [], isMerged: false, mergedAmbiguous: false, mergedBorrowerNames: [],
    mergedUnattributedScores: [], rootTag: null,
    // Set only when the document carried no credit data: what it looked like instead.
    documentHint: null,
  };
  if (!xml || String(xml).trim() === '') { base.parseError = 'empty document'; return base; }
  let root;
  try { root = X.parse(xml); } catch (e) { base.parseError = `xml parse failed: ${(e && e.message) || e}`; return base; }

  // A document may carry SEVERAL <CREDIT_RESPONSE> blocks (a vendor returning one per
  // borrower); reading only the first silently dropped the second borrower's whole
  // report. The credit CONTENT is all of them; the IDENTITY scope is the whole
  // document, because MISMO 3.4 puts the borrower PARTIES and the RELATIONSHIP arcs
  // at DEAL level, outside the credit response — see the two-scope note above.
  const responses = X.allDeep(root, 'CREDIT_RESPONSE');
  const content = responses.length ? responses : [root];
  const cr = responses[0] || root;   // the response's own header fields (id, date, version)
  const { segments, unattributedScores, splittable, primaryIdentity } = borrowerSegments(content, root);
  // A document covering several people is only read PER BORROWER when their scores
  // are actually labelled. Unlabelled, it falls back to the whole-document read (the
  // headline score is never blanked by segmentation) and says so via `mergedAmbiguous`
  // so the importer can tell staff to import each borrower's report separately.
  const merged = segments.length > 1 && splittable;
  const ambiguous = segments.length > 1 && !splittable;
  const publicRecords = parsePublicRecords(content);
  const inquiries = parseInquiries(content);
  const liabilities = parseLiabilities(content);
  // On a MERGED document the per-bureau de-dupe runs INSIDE each borrower (a
  // document-wide de-dupe would drop the second borrower's three scores), and the
  // headline middle score is the FIRST borrower's — never a median across people.
  // The importer stores a per-borrower SLICE for each of them anyway.
  const scores = merged
    ? segments.flatMap((s) => s.scores).concat(unattributedScores)
    : parseScores(content);

  const bureausReturned = Array.from(new Set(
    scores.map((s) => s.bureau).filter(Boolean)
      .concat(liabilities.flatMap((l) => l.bureaus))));

  const noData = scores.length === 0 && liabilities.length === 0;
  const flatIdentity = identityFrom(X.firstDeep(root, 'BORROWER') || X.firstDeep(root, 'CREDIT_BORROWER'));

  return {
    ...base,
    rootTag: root.local || null,
    // Only worth reading when nothing came back — an error envelope's own words.
    documentHint: noData ? documentHint(root) : null,
    borrowers: merged ? segments : [],
    isMerged: merged,
    // Names several people but labels nobody's scores — read whole-document, and say so.
    mergedAmbiguous: ambiguous,
    mergedBorrowerNames: ambiguous ? segments.map((s) => s.name).filter(Boolean) : [],
    mergedUnattributedScores: merged ? unattributedScores : [],
    version: field(cr, ['MISMOVersionIdentifier', '_Version', 'CreditResponseVersionIdentifier'], ['MISMOVersionIdentifier']) || null,
    reportId: field(cr, ['CreditReportIdentifier', '_ReportID'], ['CreditReportIdentifier']) || null,
    reportDate: isoDate(field(cr, ['CreditReportFirstIssuedDate', '_Date', 'CreditReportDate'], ['CreditReportFirstIssuedDate'])),
    tradeReferenceType: field(cr, ['CreditRatingCodeType', '_CreditReportType', 'CreditReportMergeType'], ['CreditReportMergeType']) || null,
    bureausReturned,
    scores,
    middleScore: merged ? segments[0].middleScore : representative(scores),
    // The BORROWER element carries the identity in MISMO 2.x; in 3.x it is on the
    // PARTY, so fall back to the canonical party record rather than report nobody
    // (that identity is what verifies the FICO write-back against the file's SSN).
    borrower: merged ? segments[0].borrower : (namedIdentity(flatIdentity) ? flatIdentity : (primaryIdentity || flatIdentity)),
    liabilities,
    inquiries,
    publicRecords,
    summary: summarize(liabilities, inquiries, publicRecords),
  };
}

module.exports = {
  parseCreditXml,
  sliceForSegment,
  _internal: { isoDate, num, bureau, representative, borrowerSegments, identityFrom },
};

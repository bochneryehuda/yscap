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

function parseScores(cr) {
  return dedupeScores(X.allDeep(cr, 'CREDIT_SCORE').map(scoreFrom).filter(Boolean));
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

function liabilityNodes(cr) {
  return X.allDeep(cr, 'CREDIT_LIABILITY').concat(
    X.allDeep(cr, 'LIABILITY').filter((n) => n.local === 'LIABILITY'));
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

function parseLiabilities(cr) {
  return liabilityNodes(cr).map(liabilityFrom);
}

function inquiryFrom(q) {
  return {
    name: field(q, ['_Name', 'CreditInquiryName', '_SubscriberName'], ['CreditInquiryName', 'Name']) || null,
    date: isoDate(field(q, ['_Date', 'CreditInquiryDate'], ['CreditInquiryDate'])),
    bureau: bureau(field(X.firstDeep(q, 'CREDIT_REPOSITORY') || q,
      ['_SourceType', 'CreditRepositorySourceType'], ['CreditRepositorySourceType'])),
  };
}

function parseInquiries(cr) {
  return X.allDeep(cr, 'CREDIT_INQUIRY').map(inquiryFrom);
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

function parsePublicRecords(cr) {
  return X.allDeep(cr, 'CREDIT_PUBLIC_RECORD').map(publicRecordFrom);
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
function parentMap(root) {
  const parents = new Map();
  (function walk(n) { for (const c of n.children) { parents.set(c, n); walk(c); } })(root);
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
function relationshipMap(cr) {
  const map = new Map();
  const add = (a, b) => { if (!map.has(a)) map.set(a, new Set()); map.get(a).add(b); };
  for (const rel of X.allDeep(cr, 'RELATIONSHIP')) {
    const from = X.attr(rel, 'from');
    const to = X.attr(rel, 'to');
    if (!from || !to) continue;
    add(from, to); add(to, from);
  }
  return map;
}

/**
 * The borrowers this document covers, as segment shells (root node, ids, subtree).
 * Returns [] when the document names fewer than two identifiable borrowers — the
 * single-borrower path then stays byte-for-byte what it has always been.
 */
function borrowerShells(cr, parents) {
  const shells = [];
  const roots = new Set();
  for (const b of X.allDeep(cr, 'BORROWER').concat(X.allDeep(cr, 'CREDIT_BORROWER'))) {
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
    shells.push({
      root, node: b, ids, nodes: subtreeSet(root), identity,
      printPosition: field(b, ['_PrintPositionType', 'BorrowerPrintPositionType'], ['BorrowerPrintPositionType']) || null,
    });
  }
  return shells;
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
function splitSections(cr, shells, rel) {
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
  spread(X.allDeep(cr, 'CREDIT_SCORE'), scoreFrom, 'scores');
  spread(liabilityNodes(cr), liabilityFrom, 'liabilities');
  spread(X.allDeep(cr, 'CREDIT_INQUIRY'), inquiryFrom, 'inquiries');
  spread(X.allDeep(cr, 'CREDIT_PUBLIC_RECORD'), publicRecordFrom, 'publicRecords');
  return { per, shared };
}

/**
 * Build the per-borrower segments of a merged document.
 * @returns {{segments: object[], unattributedScores: object[]}} — `segments` is
 *   empty when the document covers fewer than two borrowers (the ordinary
 *   single-borrower path, untouched).
 */
function borrowerSegments(cr) {
  const parents = parentMap(cr);
  const shells = borrowerShells(cr, parents);
  if (shells.length < 2) return { segments: [], unattributedScores: [] };
  const { per, shared } = splitSections(cr, shells, relationshipMap(cr));
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
  return { segments, unattributedScores: dedupeScores(shared.scores) };
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
    borrowers: [], isMerged: false, mergedUnattributedScores: [], rootTag: null,
    // Set only when the document carried no credit data: what it looked like instead.
    documentHint: null,
  };
  if (!xml || String(xml).trim() === '') { base.parseError = 'empty document'; return base; }
  let root;
  try { root = X.parse(xml); } catch (e) { base.parseError = `xml parse failed: ${(e && e.message) || e}`; return base; }

  const cr = X.firstDeep(root, 'CREDIT_RESPONSE') || root;
  const { segments, unattributedScores } = borrowerSegments(cr);
  const merged = segments.length > 1;
  const publicRecords = parsePublicRecords(cr);
  const inquiries = parseInquiries(cr);
  const liabilities = parseLiabilities(cr);
  // On a MERGED document the per-bureau de-dupe runs INSIDE each borrower (a
  // document-wide de-dupe would drop the second borrower's three scores), and the
  // headline middle score is the FIRST borrower's — never a median across people.
  // The importer stores a per-borrower SLICE for each of them anyway.
  const scores = merged
    ? segments.flatMap((s) => s.scores).concat(unattributedScores)
    : parseScores(cr);

  const bureausReturned = Array.from(new Set(
    scores.map((s) => s.bureau).filter(Boolean)
      .concat(liabilities.flatMap((l) => l.bureaus))));

  const noData = scores.length === 0 && liabilities.length === 0;

  return {
    ...base,
    rootTag: root.local || null,
    // Only worth reading when nothing came back — an error envelope's own words.
    documentHint: noData ? documentHint(root) : null,
    borrowers: segments,
    isMerged: merged,
    mergedUnattributedScores: unattributedScores,
    version: field(cr, ['MISMOVersionIdentifier', '_Version', 'CreditResponseVersionIdentifier'], ['MISMOVersionIdentifier']) || null,
    reportId: field(cr, ['CreditReportIdentifier', '_ReportID'], ['CreditReportIdentifier']) || null,
    reportDate: isoDate(field(cr, ['CreditReportFirstIssuedDate', '_Date', 'CreditReportDate'], ['CreditReportFirstIssuedDate'])),
    tradeReferenceType: field(cr, ['CreditRatingCodeType', '_CreditReportType', 'CreditReportMergeType'], ['CreditReportMergeType']) || null,
    bureausReturned,
    scores,
    middleScore: merged ? segments[0].middleScore : representative(scores),
    borrower: merged ? segments[0].borrower : identityFrom(X.firstDeep(cr, 'BORROWER') || X.firstDeep(cr, 'CREDIT_BORROWER')),
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

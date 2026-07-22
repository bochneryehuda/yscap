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
function parseScores(cr) {
  const out = [];
  for (const s of X.allDeep(cr, 'CREDIT_SCORE')) {
    const value = num(field(s, ['_Value', 'CreditScoreValue'], ['CreditScoreValue']));
    // A real FICO/VantageScore is 300–850. Bureaus return REJECT / no-hit codes
    // (0, 9001–9004, etc.) for frozen/thin/no-record files — very common for this
    // RTL/fix-and-flip borrower population. Treat anything outside 300–850 as
    // "no score" so it never lands in the 300–850-CHECKed middle_score column
    // and never shows as a bogus bureau chip.
    if (value == null || value < 300 || value > 850) continue;
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
    out.push({ bureau: bureau(src) || bureau(model) || null, model: model || null, value, factors });
  }
  // De-dupe to at most one score per bureau (first wins), keep unknown-bureau ones too.
  const seen = new Set();
  return out.filter((s) => {
    if (!s.bureau) return true;
    if (seen.has(s.bureau)) return false;
    seen.add(s.bureau); return true;
  });
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

function parseLiabilities(cr) {
  const out = [];
  const nodes = X.allDeep(cr, 'CREDIT_LIABILITY').concat(
    X.allDeep(cr, 'LIABILITY').filter((n) => n.local === 'LIABILITY'));
  for (const l of nodes) {
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
    out.push({
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
    });
  }
  return out;
}

function parseInquiries(cr) {
  return X.allDeep(cr, 'CREDIT_INQUIRY').map((q) => ({
    name: field(q, ['_Name', 'CreditInquiryName', '_SubscriberName'], ['CreditInquiryName', 'Name']) || null,
    date: isoDate(field(q, ['_Date', 'CreditInquiryDate'], ['CreditInquiryDate'])),
    bureau: bureau(field(X.firstDeep(q, 'CREDIT_REPOSITORY') || q,
      ['_SourceType', 'CreditRepositorySourceType'], ['CreditRepositorySourceType'])),
  }));
}

function parsePublicRecords(cr) {
  return X.allDeep(cr, 'CREDIT_PUBLIC_RECORD').map((p) => ({
    type: field(p, ['_Type', 'CreditPublicRecordType', '_DerogatoryDataIndicator'], ['CreditPublicRecordType']) || null,
    date: isoDate(field(p, ['_FiledDate', '_Date', 'CreditPublicRecordFiledDate'], ['CreditPublicRecordFiledDate'])),
    amount: num(field(p, ['_Amount', 'CreditPublicRecordLiabilityAmount'], ['CreditPublicRecordLiabilityAmount'])),
    status: field(p, ['_DispositionType', '_Status', 'CreditPublicRecordDispositionType'], ['CreditPublicRecordDispositionType']) || null,
    court: field(p, ['_CourtName', 'CreditPublicRecordCourtName'], ['CreditPublicRecordCourtName']) || null,
  }));
}

function parseBorrower(cr) {
  const b = X.firstDeep(cr, 'BORROWER') || X.firstDeep(cr, 'CREDIT_BORROWER');
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
 * Parse a credit-report XML string into the normalized PILOT credit object.
 * @param {string} xml
 * @returns {object} normalized report (see module docstring); `parseError` set on failure.
 */
function parseCreditXml(xml) {
  const base = {
    version: null, bureausReturned: [], scores: [], middleScore: null,
    borrower: null, liabilities: [], inquiries: [], publicRecords: [],
    summary: null, reportDate: null, reportId: null, tradeReferenceType: null, parseError: null,
  };
  if (!xml || String(xml).trim() === '') { base.parseError = 'empty document'; return base; }
  let root;
  try { root = X.parse(xml); } catch (e) { base.parseError = `xml parse failed: ${(e && e.message) || e}`; return base; }

  const cr = X.firstDeep(root, 'CREDIT_RESPONSE') || root;
  const scores = parseScores(cr);
  const liabilities = parseLiabilities(cr);
  const inquiries = parseInquiries(cr);
  const publicRecords = parsePublicRecords(cr);

  const bureausReturned = Array.from(new Set(
    scores.map((s) => s.bureau).filter(Boolean)
      .concat(liabilities.flatMap((l) => l.bureaus))));

  return {
    ...base,
    version: field(cr, ['MISMOVersionIdentifier', '_Version', 'CreditResponseVersionIdentifier'], ['MISMOVersionIdentifier']) || null,
    reportId: field(cr, ['CreditReportIdentifier', '_ReportID'], ['CreditReportIdentifier']) || null,
    reportDate: isoDate(field(cr, ['CreditReportFirstIssuedDate', '_Date', 'CreditReportDate'], ['CreditReportFirstIssuedDate'])),
    tradeReferenceType: field(cr, ['CreditRatingCodeType', '_CreditReportType', 'CreditReportMergeType'], ['CreditReportMergeType']) || null,
    bureausReturned,
    scores,
    middleScore: representative(scores),
    borrower: parseBorrower(cr),
    liabilities,
    inquiries,
    publicRecords,
    summary: summarize(liabilities, inquiries, publicRecords),
  };
}

module.exports = { parseCreditXml, _internal: { isoDate, num, bureau, representative } };

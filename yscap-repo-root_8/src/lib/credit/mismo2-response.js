'use strict';

/**
 * MISMO 2.3.1 credit RESPONSE parser (Xactus Credit ReportX + Pre-QualificationX).
 *
 * Hardened per the bug-hunt: reject DOCTYPE (XXE / entity-expansion), disable
 * entity processing, keep everything a STRING (no numeric coercion that would
 * turn "030"→30 or a reject code into a score), force repeatable nodes to
 * arrays (kills the "array of one" bug), fail CLOSED on non-XML / truncated /
 * unparseable input, and check BOTH error layers (envelope STATUS and
 * per-bureau CREDIT_ERROR_MESSAGE). The extracted per-bureau scores are handed
 * to scoring.js in its input shape; the value is never trusted here — scoring.js
 * asserts the model + range.
 *
 * The PDF is decoded through the existing upload chokepoint (never a bare
 * Buffer.from) and verified (%PDF … %%EOF). Data comes from the XML; the PDF is
 * for viewing only.
 */

const { XMLParser } = require('fast-xml-parser');
const { decodeUploadBase64 } = require('../upload-bytes');
const { categorizeAlert } = require('./alerts');

// Repeatable nodes → always arrays (so one bureau / one error doesn't collapse
// to an object and get mis-read or dropped).
const ARRAY_NODES = new Set([
  'CREDIT_SCORE', 'CREDIT_ERROR_MESSAGE', 'BORROWER', 'CREDIT_FILE', 'KEY', '_Text', '_FACTOR',
  // Full-report "blocks" (E1) — repeatable, so force arrays or a one-item block
  // collapses to an object and is silently mis-read (the 2.3.1 array-of-one bug).
  'CREDIT_LIABILITY', 'CREDIT_INQUIRY', 'CREDIT_PUBLIC_RECORD', 'CREDIT_COLLECTION',
  'ALERT_MESSAGE', '_ALERT_MESSAGE', '_RESIDENCE', '_ALIAS', 'CREDIT_COMMENT',
  '_PERIODIC_LATE_COUNT', 'EMPLOYER', '_EMPLOYER',
]);

const PARSER_OPTS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,   // keep values as strings (no "030"→30 / bigint loss)
  parseTagValue: false,
  processEntities: false,       // no entity expansion (XXE / billion-laughs)
  cdataPropName: '__cdata',     // keep the PDF CDATA intact + separate
  trimValues: true,
  isArray: (name) => ARRAY_NODES.has(name),
};

function badResponse(msg, code) { const e = new Error(msg); e.status = 502; if (code) e.creditCode = code; return e; }

// We keep processEntities:false (XXE/entity-expansion backstop), so the parser
// leaves the 5 predefined XML entities literal in extracted strings. Decode ONLY
// those 5 on the strings we surface (names, error text) so a name like "A&B" or
// "O'Neil" reads correctly (a still-escaped name would fail a mixed-file
// name-match). Decode &amp; LAST so "&amp;lt;" → "&lt;", not "<".
function unescapeXml(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
const A = (node, name) => (node && node['@' + name] != null ? unescapeXml(String(node['@' + name])) : null);
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** Parse a MISMO 2.3.1 credit response. Throws (fail closed) on anything that
 * isn't a clean, complete credit XML. Returns a structured result:
 *   { ok, errors[], reportIdentifier, responseId, firstIssuedDate,
 *     lastUpdatedDate, reportType, repositoriesReturned, borrowers[], pdf } */
function parseCreditResponse(xml) {
  if (xml == null) throw badResponse('empty credit response');
  const raw = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml);
  const trimmed = raw.replace(/^﻿/, '').trim();               // strip BOM

  // ---- non-XML / injection guards (before parsing) ----
  if (trimmed === '') throw badResponse('empty credit response');
  if (/<!DOCTYPE/i.test(trimmed) || /<!ENTITY/i.test(trimmed)) throw badResponse('credit response contains a DOCTYPE/ENTITY (rejected)');
  if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) throw badResponse('credit response is HTML, not XML');
  if (!/^<(\?xml|RESPONSE_GROUP)/i.test(trimmed) && !trimmed.startsWith('<')) throw badResponse('credit response is not XML');
  // truncation guard: a complete response closes its root
  if (!/<\/RESPONSE_GROUP\s*>\s*$/i.test(trimmed)) throw badResponse('credit response is truncated (no closing RESPONSE_GROUP)');

  let doc;
  try { doc = new XMLParser(PARSER_OPTS).parse(trimmed); }
  catch (e) { throw badResponse(`credit response XML parse failed: ${e.message}`); }

  const group = doc && doc.RESPONSE_GROUP;
  const response = group && group.RESPONSE;
  if (!group || !response) throw badResponse('credit response missing RESPONSE_GROUP/RESPONSE');

  const creditResponse = response.RESPONSE_DATA && response.RESPONSE_DATA.CREDIT_RESPONSE;

  // ---- errors: envelope STATUS + per-bureau CREDIT_ERROR_MESSAGE (check both) ----
  const errors = [];
  for (const st of arr(response.STATUS)) {
    if ((A(st, '_Condition') || '').toLowerCase() === 'error') {
      errors.push({ layer: 'status', code: A(st, '_Code'), description: A(st, '_Description') });
    }
  }
  if (creditResponse) {
    for (const em of arr(creditResponse.CREDIT_ERROR_MESSAGE)) {
      errors.push({
        layer: 'credit', code: A(em, '_Code'), sourceType: A(em, '_SourceType'),
        texts: arr(em._Text).map((t) => unescapeXml(t && t.__cdata != null ? String(t.__cdata) : String(t))).filter(Boolean),
      });
    }
    // Per-bureau CREDIT_FILE status — a security FREEZE / no-file / no-hit / deceased
    // rides HERE (@_ResultStatusType) with its error message NESTED under the file,
    // not at the CREDIT_RESPONSE level. Surface both so the assessment routes a
    // frozen/blocked bureau to manual review (verified live against Xactus test:
    // _ResultStatusType="NoFileReturnedCreditFreeze"). "FileReturned" is the normal
    // success value and is ignored.
    for (const cf of arr(creditResponse.CREDIT_FILE)) {
      const bureau = A(cf, 'CreditRepositorySourceType');
      const rst = A(cf, '_ResultStatusType');
      if (rst && !/^filereturned$/i.test(rst) && /(freeze|frozen|nofile|no[_-]?file|nohit|no[_-]?hit|norecord|no[_-]?record|deceased|error|unavailable|blocked)/i.test(rst)) {
        errors.push({ layer: 'file', code: rst, sourceType: bureau,
          texts: [rst.replace(/([a-z])([A-Z])/g, '$1 $2')] });   // e.g. "No File Returned Credit Freeze" → conditionFromText → frozen
      }
      for (const em of arr(cf.CREDIT_ERROR_MESSAGE)) {
        errors.push({
          layer: 'credit', code: A(em, '_Code'), sourceType: A(em, '_SourceType') || bureau,
          texts: arr(em._Text).map((t) => unescapeXml(t && t.__cdata != null ? String(t.__cdata) : String(t))).filter(Boolean),
        });
      }
    }
  }
  if ((A(creditResponse, 'CreditReportType') || '') === 'Error') {
    if (!errors.length) errors.push({ layer: 'credit', code: null, description: 'CreditReportType=Error' });
  }

  const result = {
    ok: errors.length === 0 && !!creditResponse,
    errors,
    reportIdentifier: A(creditResponse, 'CreditReportIdentifier'),
    responseId: A(creditResponse, 'CreditResponseID'),
    firstIssuedDate: A(creditResponse, 'CreditReportFirstIssuedDate'),
    lastUpdatedDate: A(creditResponse, 'CreditReportLastUpdatedDate'),
    reportType: A(creditResponse, 'CreditReportType'),
    otherDescription: A(creditResponse, 'CreditReportTypeOtherDescription'),
    repositoriesReturned: null,
    borrowers: [],
    alerts: [],
    pdf: null,
  };

  if (!creditResponse) return result;   // pure-error response, nothing more to read

  // repositories that actually returned (may differ from requested — frozen bureau)
  const inc = creditResponse.CREDIT_REPOSITORY_INCLUDED;
  if (inc) result.repositoriesReturned = {
    equifax: A(inc, '_EquifaxIndicator') === 'Y',
    experian: A(inc, '_ExperianIndicator') === 'Y',
    transunion: A(inc, '_TransUnionIndicator') === 'Y',
  };

  // borrowers (identity for the mixed-file check) — BORROWER may be obj or array
  const borrowerNodes = arr(creditResponse.BORROWER);
  const byId = new Map();
  for (const b of borrowerNodes) {
    const id = A(b, 'BorrowerID') || 'B1';
    byId.set(id, {
      borrowerId: id,
      firstName: A(b, '_FirstName'), lastName: A(b, '_LastName'), middleName: A(b, '_MiddleName'),
      ssn: A(b, '_SSN'), unparsedName: A(b, '_UnparsedName'),
      scores: [],
    });
  }
  // scores → grouped by borrower, in scoring.js input shape
  for (const s of arr(creditResponse.CREDIT_SCORE)) {
    const id = A(s, 'BorrowerID') || 'B1';
    if (!byId.has(id)) byId.set(id, { borrowerId: id, firstName: null, lastName: null, ssn: null, scores: [] });
    byId.get(id).scores.push({
      bureau: A(s, 'CreditRepositorySourceType'),
      model: A(s, '_ModelNameType'),
      value: A(s, '_Value'),
      exclusionReason: A(s, '_ExclusionReasonType'),   // present on some feeds; scoring.js also catches reject-code values
      date: A(s, '_Date'),
      creditFileId: A(s, 'CreditFileID'),
      // Score reason codes (the "factors that most affected this score"). ~4 per
      // score, bureau-specific; codes may be zero-padded so keep them as strings.
      // These are the principal-reason source for an adverse-action notice and a
      // clear "why" for staff + borrower.
      factors: arr(s._FACTOR).map((f) => ({ code: A(f, '_Code'), text: A(f, '_Text') }))
        .filter((f) => f.code || f.text),
    });
  }
  // ---- Full-report "blocks" (E1): tradelines, inquiries, public records,
  // collections, reported identity, and alerts. Values stay STRINGS here (no
  // numeric coercion — cast at the DB boundary). Each borrower gets its own arrays.
  for (const b of byId.values()) {
    b.tradelines = b.tradelines || [];
    b.inquiries = b.inquiries || [];
    b.publicRecords = b.publicRecords || [];
    b.collections = b.collections || [];
    b.reportedIdentity = b.reportedIdentity || {};
  }
  const bfor = (id) => byId.get(id || 'B1') || byId.get('B1') || [...byId.values()][0] || null;
  const bureauOf = (node) => A(node, 'CreditRepositorySourceType')
    || (node && node.CREDIT_REPOSITORY ? A(arr(node.CREDIT_REPOSITORY)[0], '_SourceType') : null);
  const childName = (node, key) => (node && node[key] ? A(node[key], '_Name') : null);
  const childAddr = (node, key) => {
    const c = node && node[key]; if (!c) return null;
    return [A(c, '_StreetAddress') || A(c, '_Street'), A(c, '_City'), A(c, '_State'), A(c, '_PostalCode')].filter(Boolean).join(', ') || null;
  };

  // Tradelines (CREDIT_LIABILITY) — one row per account per bureau.
  for (const L of arr(creditResponse.CREDIT_LIABILITY)) {
    const b = bfor(A(L, 'BorrowerID')); if (!b) continue;
    const rating = L._CURRENT_RATING || L['_CURRENT_RATING'];
    const late = L._LATE_COUNT || L['_LATE_COUNT'];
    const acct = A(L, '_AccountIdentifier');
    const businessType = A(L, 'CreditBusinessType') || A(L, '_CreditBusinessType');
    const isColl = /collection/i.test(A(L, '_AccountType') || '') || /collection/i.test(businessType || '');
    const row = {
      bureau: bureauOf(L), creditFileId: A(L, 'CreditFileID'),
      creditorName: childName(L, '_CREDITOR'), creditorAddress: childAddr(L, '_CREDITOR'),
      accountType: A(L, '_AccountType'), accountOwnershipType: A(L, '_AccountOwnershipType'),
      accountStatusType: A(L, '_AccountStatusType'), accountIdentifier: acct,
      unpaidBalance: A(L, '_UnpaidBalanceAmount'), creditLimit: A(L, '_CreditLimitAmount'),
      highCredit: A(L, '_HighCreditAmount'), monthlyPayment: A(L, '_MonthlyPaymentAmount'),
      pastDueAmount: A(L, '_PastDueAmount'), chargeOffAmount: A(L, '_ChargeOffAmount'),
      dateOpened: A(L, '_AccountOpenedDate'), dateReported: A(L, '_AccountReportedDate'),
      dateClosed: A(L, '_AccountClosedDate'), lastActivityDate: A(L, '_LastActivityDate'),
      monthsReviewedCount: A(L, '_MonthsReviewedCount'),
      currentRatingCode: rating ? A(rating, '_Code') : null, currentRatingType: rating ? A(rating, '_Type') : null,
      late30Count: late ? A(late, '_30Days') || A(late, '_Count30Day') : null,
      late60Count: late ? A(late, '_60Days') || A(late, '_Count60Day') : null,
      late90Count: late ? A(late, '_90Days') || A(late, '_Count90Day') : null,
      paymentPattern: L._PAYMENT_PATTERN ? A(L._PAYMENT_PATTERN, '_Data') : null,
      derogatoryIndicator: /^y/i.test(A(L, '_DerogatoryDataIndicator') || ''),
      isCollection: isColl,
      isAuthorizedUser: /authorized/i.test(A(L, '_AccountOwnershipType') || ''),
    };
    b.tradelines.push(row);
    // A collection tradeline is ALSO surfaced as a collection block (2.3.1 has no
    // separate element) so the detail view's Collections section is populated.
    if (isColl) b.collections.push({
      bureau: row.bureau, collectionAgencyName: row.creditorName, originalCreditorName: null,
      amount: row.unpaidBalance, status: row.accountStatusType, dateReported: row.dateReported,
    });
  }

  // Inquiries (CREDIT_INQUIRY)
  for (const q of arr(creditResponse.CREDIT_INQUIRY)) {
    const b = bfor(A(q, 'BorrowerID')); if (!b) continue;
    b.inquiries.push({
      bureau: bureauOf(q), inquiryDate: A(q, '_Date'), inquiringPartyName: A(q, '_Name'),
      businessType: A(q, 'CreditBusinessType') || A(q, '_CreditBusinessType'),
      loanType: A(q, 'CreditLoanType') || A(q, '_CreditLoanType'),
    });
  }

  // Public records (2.3.1 has no rich element — surface any present CREDIT_PUBLIC_RECORD;
  // rich detail only fills on 3.4). Collections handled above via tradelines.
  for (const pr of arr(creditResponse.CREDIT_PUBLIC_RECORD)) {
    const b = bfor(A(pr, 'BorrowerID')); if (!b) continue;
    b.publicRecords.push({
      bureau: bureauOf(pr), recordType: A(pr, '_Type') || A(pr, 'CreditPublicRecordType'),
      filedDate: A(pr, '_FiledDate'), reportedDate: A(pr, '_ReportedDate'),
      dispositionType: A(pr, '_DispositionType'), dispositionDate: A(pr, '_DispositionDate'),
      amount: A(pr, '_Amount') || A(pr, '_LegalObligationAmount'), courtName: A(pr, '_CourtName'),
      docketIdentifier: A(pr, '_DocketIdentifier'), plaintiffName: A(pr, '_PlaintiffName'),
      derogatoryIndicator: true,
    });
  }

  // Reported identity per borrower (from the BORROWER node): DOB, addresses,
  // aliases, employer — for the reported-vs-file mismatch checks.
  for (const bn of borrowerNodes) {
    const b = bfor(A(bn, 'BorrowerID')); if (!b) continue;
    const residences = arr(bn._RESIDENCE);
    const addrStr = (r) => [A(r, '_StreetAddress') || A(r, '_Street'), A(r, '_City'), A(r, '_State'), A(r, '_PostalCode')].filter(Boolean).join(', ');
    b.reportedIdentity = {
      reportedName: A(bn, '_UnparsedName') || [A(bn, '_FirstName'), A(bn, '_MiddleName'), A(bn, '_LastName')].filter(Boolean).join(' '),
      dob: A(bn, '_BirthDate'),
      ssn: A(bn, '_SSN'),
      aliases: arr(bn._ALIAS).map((a) => A(a, '_UnparsedName') || [A(a, '_FirstName'), A(a, '_LastName')].filter(Boolean).join(' ')).filter(Boolean),
      currentAddress: residences.length ? addrStr(residences[0]) : null,
      formerAddresses: residences.slice(1).map(addrStr).filter(Boolean),
      employers: [A(bn, '_UnparsedEmployment')].filter(Boolean),
    };
  }

  // Report-level ALERTS (fraud / freeze / active-duty / deceased / OFAC / address /
  // SSN / high-risk). 2.3.1 carries them as ALERT_MESSAGE at the response level and
  // _ALERT_MESSAGE nested under CREDIT_FILE (per bureau).
  const alerts = [];
  const pushAlert = (node, bureau, borrowerId) => {
    const rawType = A(node, '_Type') || A(node, '_Code');
    const text = arr(node._Text || node.MessageText || node['@MessageText'])
      .map((t) => (t && t.__cdata != null ? String(t.__cdata) : (t == null ? '' : String(t)))).join(' ').trim()
      || A(node, 'MessageText') || A(node, '_Text');
    if (!rawType && !text) return;
    alerts.push({ category: categorizeAlert(rawType, text), rawType, text: text ? unescapeXml(text) : null, bureau, borrowerId });
  };
  for (const al of arr(creditResponse.ALERT_MESSAGE)) pushAlert(al, null, A(al, 'BorrowerID'));
  for (const cf of arr(creditResponse.CREDIT_FILE)) {
    const bureau = A(cf, 'CreditRepositorySourceType');
    for (const al of arr(cf._ALERT_MESSAGE)) pushAlert(al, bureau, A(cf, 'BorrowerID'));
    for (const al of arr(cf.ALERT_MESSAGE)) pushAlert(al, bureau, A(cf, 'BorrowerID'));
  }
  result.alerts = alerts;

  result.borrowers = [...byId.values()];

  // embedded PDF (base64) — EMBEDDED_FILE/DOCUMENT CDATA. Data is NOT read from here.
  const ef = creditResponse.EMBEDDED_FILE;
  if (ef && ef.DOCUMENT != null) {
    const d = ef.DOCUMENT;
    const b64 = typeof d === 'string' ? d : (d.__cdata != null ? d.__cdata : d['#text']);
    if (b64 != null && String(b64).trim() !== '') {
      result.pdf = {
        base64: String(b64),
        mimeType: A(ef, 'MIMEType') || 'application/pdf',
        encoding: A(ef, '_EncodingType') || 'base64',
        name: A(ef, '_Name'),
        description: A(ef, '_Description'),
      };
    }
  }

  return result;
}

/** Decode + verify the report PDF. Uses the upload chokepoint (never a bare
 * Buffer.from — that silently truncates), then checks the PDF magic bytes and
 * trailer. Throws (fail closed) on a corrupt/short decode. Returns {buf, sha256}. */
function decodeReportPdf(base64) {
  const { buf, sha256 } = decodeUploadBase64(base64);            // strips ws/data:, rejects junk, rejects empty
  const head = buf.slice(0, 5).toString('latin1');
  if (head !== '%PDF-') throw badResponse('credit PDF decode invalid: missing %PDF header');
  const tail = buf.slice(-1024).toString('latin1');
  if (!tail.includes('%%EOF')) throw badResponse('credit PDF decode invalid: missing %%EOF trailer');
  return { buf, sha256 };
}

module.exports = { parseCreditResponse, decodeReportPdf, PARSER_OPTS };

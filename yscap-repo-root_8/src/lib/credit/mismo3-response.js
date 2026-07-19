'use strict';

/**
 * MISMO 3.4 credit RESPONSE parser (Xactus). 3.4 is ELEMENT-centric and deeply
 * nested (MESSAGE/DEAL_SETS/.../DOCUMENT_SETS/.../CREDIT_RESPONSE), so this parser
 * navigates with recursive deep-find helpers and NORMALIZES to the exact same
 * output shape as mismo2-response.parseCreditResponse — so scoring.js, the
 * outcome catalog, and import.js consume both versions unchanged.
 *
 * Verified live against Xactus test (2026-07-19):
 *   - scores:  CREDIT_SCORES/CREDIT_SCORE/CREDIT_SCORE_DETAIL/{CreditRepositorySourceType,
 *              CreditScoreModelNameType, CreditScoreValue}
 *   - errors:  CREDIT_ERROR_MESSAGES/CREDIT_ERROR_MESSAGE/{CreditErrorMessageCode,
 *              CreditErrorMessageSourceType, CreditErrorMessageText} + STATUSES/STATUS
 *   - freeze:  CREDIT_FILE/.../CreditFileResultStatusType
 *   - PDF:     VIEW_FILE/.../EmbeddedContentXML (base64) + MIMETypeIdentifier
 *
 * Same hardening as the 2.3.1 parser (no DOCTYPE, no entity expansion, strings
 * only, fail-closed).
 */
const { XMLParser } = require('fast-xml-parser');
const { decodeUploadBase64 } = require('../upload-bytes');
const { categorizeAlert } = require('./alerts');

const PARSER_OPTS = {
  ignoreAttributes: false, attributeNamePrefix: '@',
  parseAttributeValue: false, parseTagValue: false, processEntities: false,
  cdataPropName: '__cdata', trimValues: true,
};

function badResponse(msg) { const e = new Error(msg); e.status = 502; return e; }
function unescapeXml(s) {
  if (s == null) return s;
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Leaf text: an element is either the string itself (no attrs) or { '#text', '@..' }.
function textOf(node) {
  if (node == null) return null;
  if (typeof node === 'string') return unescapeXml(node);
  if (typeof node === 'object') {
    if (node.__cdata != null) return unescapeXml(String(node.__cdata));
    if (node['#text'] != null) return unescapeXml(String(node['#text']));
  }
  return null;
}
const attr = (node, name) => (node && node['@' + name] != null ? unescapeXml(String(node['@' + name])) : null);
const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** Recursively collect every node stored under `key` (objects or leaves). */
function findAll(node, key, out = []) {
  if (node == null || typeof node !== 'object') return out;
  for (const k of Object.keys(node)) {
    if (k === key) { for (const v of asArray(node[k])) out.push(v); }
    const v = node[k];
    if (v && typeof v === 'object') { for (const c of asArray(v)) findAll(c, key, out); }
  }
  return out;
}
/** First text value found for `key` anywhere under node. */
function findFirstText(node, key) {
  const all = findAll(node, key);
  for (const v of all) { const t = textOf(v); if (t != null && t !== '') return t; }
  return null;
}

function parseCreditResponse(xml) {
  const raw = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml);
  if (!raw || !raw.trim()) throw badResponse('empty credit response');
  if (/<!DOCTYPE/i.test(raw) || /<!ENTITY/i.test(raw)) throw badResponse('credit response contains a DOCTYPE/ENTITY (rejected)');
  if (!/<MESSAGE[\s>]/.test(raw)) throw badResponse('not a MISMO 3.4 response (no MESSAGE root)');
  if (!/<\/MESSAGE>\s*$/.test(raw.trim())) throw badResponse('credit response appears truncated (no closing MESSAGE)');

  let doc;
  try { doc = new XMLParser(PARSER_OPTS).parse(raw); }
  catch (e) { throw badResponse(`credit response XML parse failed: ${e.message}`); }
  const message = doc && doc.MESSAGE;
  if (!message) throw badResponse('credit response missing MESSAGE');

  // ---- errors: STATUS (envelope) + CREDIT_ERROR_MESSAGE (per bureau) ----
  const errors = [];
  for (const st of findAll(message, 'STATUS')) {
    if ((findFirstText(st, 'StatusConditionDescription') || '').toLowerCase() === 'error') {
      errors.push({ layer: 'status', code: findFirstText(st, 'StatusCode'), description: findFirstText(st, 'StatusDescription') });
    }
  }
  for (const em of findAll(message, 'CREDIT_ERROR_MESSAGE')) {
    errors.push({
      layer: 'credit', code: findFirstText(em, 'CreditErrorMessageCode'),
      sourceType: findFirstText(em, 'CreditErrorMessageSourceType'),
      texts: [findFirstText(em, 'CreditErrorMessageText')].filter(Boolean),
    });
  }
  // ---- per-bureau file status (freeze / no-file / no-hit / deceased) ----
  for (const cf of findAll(message, 'CREDIT_FILE')) {
    const rst = findFirstText(cf, 'CreditFileResultStatusType');
    const bureau = findFirstText(cf, 'CreditRepositorySourceType');
    if (rst && !/^filereturned$/i.test(rst) && /(freeze|frozen|nofile|no[_-]?file|nohit|no[_-]?hit|norecord|no[_-]?record|deceased|error|unavailable|blocked)/i.test(rst)) {
      errors.push({ layer: 'file', code: rst, sourceType: bureau, texts: [rst.replace(/([a-z])([A-Z])/g, '$1 $2')] });
    }
  }

  const creditResponse = findAll(message, 'CREDIT_RESPONSE')[0] || null;
  const result = {
    ok: errors.length === 0 && !!creditResponse,
    errors,
    reportIdentifier: findFirstText(message, 'CreditReportIdentifier'),
    responseId: findFirstText(message, 'CreditResponseIdentifier') || null,
    firstIssuedDate: findFirstText(message, 'CreditReportFirstIssuedDate'),
    lastUpdatedDate: findFirstText(message, 'CreditReportLastUpdatedDate'),
    reportType: findFirstText(message, 'CreditReportType'),
    otherDescription: findFirstText(message, 'CreditReportTypeOtherDescription'),
    repositoriesReturned: null,
    borrowers: [],
    alerts: [],
    pdf: null,
    mismoVersion: '3.4',
  };
  if (!creditResponse && errors.length) return result;   // pure-error response

  // repositories returned (indicators are text 'true'/'false')
  const boolOf = (v) => String(v || '').toLowerCase() === 'true' || String(v || '').toLowerCase() === 'y';
  const inc = findAll(message, 'CREDIT_REPOSITORY_INCLUDED')[0];
  if (inc) result.repositoriesReturned = {
    equifax: boolOf(findFirstText(inc, 'CreditRepositoryIncludedEquifaxIndicator')),
    experian: boolOf(findFirstText(inc, 'CreditRepositoryIncludedExperianIndicator')),
    transunion: boolOf(findFirstText(inc, 'CreditRepositoryIncludedTransUnionIndicator')),
  };

  // ---- scores (element-centric) ----
  // Parse each CREDIT_SCORE *with its xlink:label*, so a JOINT tri-merge (all six
  // scores in ONE shared CREDIT_SCORES block) can be split back to the right
  // borrower via the RELATIONSHIP links below. Fall back to bare CREDIT_SCORE_DETAIL
  // only if a response somehow omits the CREDIT_SCORE wrappers.
  const parseScoreNode = (node, isDetail) => {
    const d = isDetail ? node : (findAll(node, 'CREDIT_SCORE_DETAIL')[0] || node);
    return {
      bureau: findFirstText(d, 'CreditRepositorySourceType'),
      model: findFirstText(d, 'CreditScoreModelNameType'),
      value: findFirstText(d, 'CreditScoreValue'),
      exclusionReason: findFirstText(d, 'CreditScoreExclusionReasonType'),
      date: findFirstText(d, 'CreditScoreDate') || result.firstIssuedDate,
      factors: findAll(d, 'CREDIT_SCORE_FACTOR').map((f) => ({
        code: findFirstText(f, 'CreditScoreFactorCode'), text: findFirstText(f, 'CreditScoreFactorText'),
      })).filter((f) => f.code || f.text),
      label: isDetail ? null : attr(node, 'xlink:label'),
    };
  };
  const scoreParents = findAll(message, 'CREDIT_SCORE');
  const scoreNodes = (scoreParents.length
    ? scoreParents.map((cs) => parseScoreNode(cs, false))
    : findAll(message, 'CREDIT_SCORE_DETAIL').map((d) => parseScoreNode(d, true))
  ).filter((s) => s.bureau || s.value);

  // ---- borrowers (identity) ----
  // Borrower parties carry PartyRoleType=Borrower with a NAME + TAXPAYER_IDENTIFIER.
  const borrowerParties = findAll(message, 'PARTY').filter((p) => {
    const roles = findAll(p, 'ROLE_DETAIL');
    return roles.some((r) => (findFirstText(r, 'PartyRoleType') || '') === 'Borrower') || findAll(p, 'BORROWER').length;
  });
  // The xlink:label(s) on a party's Borrower ROLE — the key the score RELATIONSHIPs
  // point *from* to tie each CREDIT_SCORE to THIS borrower. Only the request-echo
  // party carries these, so they uniquely identify each real borrower.
  const roleLabelsOf = (party) => {
    const out = [];
    for (const role of findAll(party, 'ROLE')) {
      const rt = findFirstText(role, 'PartyRoleType');
      if ((rt && rt === 'Borrower') || findAll(role, 'BORROWER').length) {
        const l = attr(role, 'xlink:label'); if (l) out.push(l);
      }
    }
    return out;
  };
  const seqOf = (party) => { const n = parseInt(attr(party, 'SequenceNumber'), 10); return Number.isFinite(n) ? n : 9999; };
  // The deep PARTY scan picks up nested/echoed borrower parties (per-bureau
  // BORROWER blocks, the request echo, the response borrower) — all the SAME
  // person repeated, and often WITHOUT an SSN. Collapse by NAME primarily (so a
  // no-SSN echo merges into the real borrower), using SSN only to keep two
  // genuinely different same-name people apart. A single borrower → one entry; a
  // real joint (distinct names, or same name + distinct SSNs) → two.
  const seen = new Map();
  const noteParty = (entry, p) => {
    if (!entry.roleLabels) entry.roleLabels = new Set();
    for (const l of roleLabelsOf(p)) entry.roleLabels.add(l);
    // Fallback ordering signal only (used when no score references a role label,
    // e.g. an all-frozen co-borrower). The PRIMARY ordering is by the score-
    // referenced role label below, which a per-bureau echo party cannot pollute.
    const s = seqOf(p);
    if (entry.anySeq == null || s < entry.anySeq) entry.anySeq = s;
  };
  for (const p of borrowerParties) {
    const nm = findAll(p, 'NAME')[0];
    const first = nm ? findFirstText(nm, 'FirstName') : null;
    const last = nm ? findFirstText(nm, 'LastName') : null;
    const ssn = (findFirstText(p, 'TaxpayerIdentifierValue') || '').replace(/\D/g, '') || null;
    const nameKey = `${(first || '').toUpperCase()}|${(last || '').toUpperCase()}`;
    if (nameKey === '|') continue;
    let entry = seen.get(nameKey);
    if (entry && ssn && entry.ssn && ssn !== entry.ssn) {
      // same name but a different SSN → a distinct person; key by name+ssn.
      const k2 = `${nameKey}#${ssn}`;
      entry = seen.get(k2);
      if (!entry) { entry = { firstName: first, lastName: last, middleName: nm ? findFirstText(nm, 'MiddleName') : null, ssn, scores: [] }; seen.set(k2, entry); }
    } else if (!entry) {
      entry = { firstName: first, lastName: last, middleName: nm ? findFirstText(nm, 'MiddleName') : null, ssn, scores: [] };
      seen.set(nameKey, entry);
    } else {
      if (!entry.ssn && ssn) entry.ssn = ssn;   // fill SSN from a richer copy of the same person
      if (!entry.firstName && first) entry.firstName = first;
      if (!entry.lastName && last) entry.lastName = last;
    }
    noteParty(entry, p);
  }
  const identities = [...seen.values()];
  if (!identities.length) identities.push({ firstName: findFirstText(message, 'FirstName'), lastName: findFirstText(message, 'LastName'), ssn: null, scores: [], roleLabels: new Set() });

  // ---- Score↔borrower linkage via MISMO RELATIONSHIP: each CREDIT_SCORE's
  // xlink:label is the `to` of a relationship whose `from` is the owning borrower
  // ROLE's xlink:label. Built once — it drives BOTH the per-borrower score split
  // and the primary/co ordering below. ----
  const fromsByScore = new Map();   // score xlink:label -> Set(from-labels)
  for (const rel of findAll(message, 'RELATIONSHIP')) {
    const from = attr(rel, 'xlink:from'), to = attr(rel, 'xlink:to');
    if (!from || !to) continue;
    if (!fromsByScore.has(to)) fromsByScore.set(to, new Set());
    fromsByScore.get(to).add(from);
  }
  const idByRoleLabel = new Map();
  for (const id of identities) for (const l of (id.roleLabels || [])) idByRoleLabel.set(l, id);

  // Order primary→co by the borrower ROLE label the SCORES reference (e.g.
  // Borrower01 < Borrower02). Echo-proof: a per-bureau CREDIT_FILE echo party can
  // carry a Borrower role label with a low SequenceNumber, but the scores only ever
  // link to the request-echo labels — so ordering by SequenceNumber alone could
  // flip B1/C1, ordering by the referenced label cannot. Fall back to the min
  // SequenceNumber only when no score references a label (all-frozen co-borrower).
  const scoreRefLabels = new Set();
  for (const s of scoreNodes) {
    const froms = s.label ? fromsByScore.get(s.label) : null;
    if (!froms) continue;
    for (const f of froms) if (idByRoleLabel.has(f)) scoreRefLabels.add(f);
  }
  const orderKey = (id) => {
    const auth = [...(id.roleLabels || [])].filter((l) => scoreRefLabels.has(l)).sort();
    return auth.length ? `0${auth[0]}` : `1${String(id.anySeq ?? 9999).padStart(6, '0')}`;
  };
  identities.sort((a, b) => { const ka = orderKey(a), kb = orderKey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
  identities.forEach((b, i) => { b.borrowerId = i === 0 ? 'B1' : `C${i}`; });

  // Score→borrower mapping. Single borrower → all scores. Multiple → split via the
  // RELATIONSHIP links above (the only reliable split for a joint tri-merge, where
  // all six scores share ONE CREDIT_SCORES block). Fallbacks: per-borrower
  // CREDIT_RESPONSE subtree (older shapes), else leave on the primary and flag for
  // review (never guess whose score is whose).
  if (identities.length === 1) {
    identities[0].scores = scoreNodes;
  } else {
    let assigned = 0;
    if (idByRoleLabel.size) {
      for (const s of scoreNodes) {
        if (!s.label) continue;
        const froms = fromsByScore.get(s.label); if (!froms) continue;
        let hit = null;
        for (const f of froms) if (idByRoleLabel.has(f)) { hit = idByRoleLabel.get(f); break; }
        if (hit) { hit.scores.push(s); assigned++; }
      }
    }
    // Trust the relationship split only when EVERY score found a home.
    let grouped = assigned > 0 && assigned === scoreNodes.length;
    if (!grouped) {
      for (const id of identities) id.scores = [];
      for (const cr of findAll(message, 'CREDIT_RESPONSE')) {
        const crScores = (findAll(cr, 'CREDIT_SCORE').length
          ? findAll(cr, 'CREDIT_SCORE').map((cs) => parseScoreNode(cs, false))
          : findAll(cr, 'CREDIT_SCORE_DETAIL').map((d) => parseScoreNode(d, true))
        ).filter((s) => s.bureau || s.value);
        if (!crScores.length) continue;
        const crSsn = (findFirstText(cr, 'TaxpayerIdentifierValue') || '').replace(/\D/g, '');
        const crFirst = findFirstText(cr, 'FirstName');
        const match = identities.find((b) => (crSsn && b.ssn && b.ssn === crSsn) || (crFirst && b.firstName && b.firstName.toUpperCase() === crFirst.toUpperCase()));
        if (match) match.scores.push(...crScores);
      }
      // Only trust the subtree split if it genuinely separated ≥2 borrowers.
      grouped = identities.filter((b) => b.scores.length).length >= 2;
      if (!grouped) {
        for (const id of identities) id.scores = [];
        identities[0].scores = scoreNodes;
        result.multiBorrowerUnsplit = true;
      }
    }
  }
  // Drop any lingering phantom: an identity with NO scores AND no SSN is an
  // echo, not a real borrower (a genuine no-score borrower still has an SSN).
  const real = identities.filter((b) => b.scores.length > 0 || b.ssn);
  const finalBorrowers = real.length ? real : identities;
  for (const b of finalBorrowers) {
    delete b.roleLabels; delete b.roleSeq; delete b.anySeq;
    b.tradelines = []; b.inquiries = []; b.publicRecords = []; b.collections = []; b.reportedIdentity = {};
  }
  result.borrowers = finalBorrowers;

  // ---- Full-report "blocks" (E1) ----
  // Bureau is always correct (CreditRepositorySourceType on each element). Per-
  // borrower attribution: a single borrower gets everything; a joint report attaches
  // tradelines/inquiries/records to the primary and flags it (precise joint split
  // via RELATIONSHIP is a later refinement). Identity is read per-PARTY so it is
  // always correctly per-borrower. Values stay strings (cast at the DB boundary).
  const primary = finalBorrowers[0] || null;
  const bureauOf3 = (node) => findFirstText(node, 'CreditRepositorySourceType');
  const moneyOf = (node, key) => findFirstText(node, key);
  if (primary) {
    for (const L of findAll(creditResponse || message, 'CREDIT_LIABILITY')) {
      const det = findAll(L, 'CREDIT_LIABILITY_DETAIL')[0] || L;
      const creditor = findAll(L, 'CREDIT_LIABILITY_CREDITOR')[0] || findAll(L, 'CREDITOR')[0];
      const rating = findAll(L, 'CREDIT_LIABILITY_CURRENT_RATING')[0];
      const late = findAll(L, 'CREDIT_LIABILITY_LATE_COUNT')[0];
      const pat = findAll(L, 'CREDIT_LIABILITY_PAYMENT_PATTERN')[0];
      const ownership = findFirstText(det, 'CreditLiabilityAccountOwnershipType');
      const acctType = findFirstText(det, 'CreditLiabilityAccountType');
      const isColl = /collection/i.test(acctType || '');
      const row = {
        bureau: bureauOf3(L), creditFileId: null,
        creditorName: creditor ? findFirstText(creditor, 'FullName') || findFirstText(creditor, 'Name') : null,
        creditorAddress: null,
        accountType: acctType, accountOwnershipType: ownership,
        accountStatusType: findFirstText(det, 'CreditLiabilityAccountStatusType'),
        accountIdentifier: findFirstText(det, 'CreditLiabilityAccountIdentifier'),
        unpaidBalance: moneyOf(det, 'CreditLiabilityUnpaidBalanceAmount'),
        creditLimit: moneyOf(det, 'CreditLiabilityCreditLimitAmount'),
        highCredit: moneyOf(det, 'CreditLiabilityHighBalanceAmount'),
        monthlyPayment: moneyOf(det, 'CreditLiabilityMonthlyPaymentAmount'),
        pastDueAmount: moneyOf(det, 'CreditLiabilityPastDueAmount'),
        chargeOffAmount: moneyOf(det, 'CreditLiabilityChargeOffAmount'),
        dateOpened: findFirstText(det, 'CreditLiabilityAccountOpenedDate'),
        dateReported: findFirstText(det, 'CreditLiabilityAccountReportedDate'),
        dateClosed: findFirstText(det, 'CreditLiabilityAccountClosedDate'),
        lastActivityDate: findFirstText(det, 'CreditLiabilityLastActivityDate'),
        monthsReviewedCount: findFirstText(det, 'CreditLiabilityMonthsReviewedCount'),
        currentRatingCode: rating ? findFirstText(rating, 'CreditLiabilityCurrentRatingCode') : null,
        currentRatingType: rating ? findFirstText(rating, 'CreditLiabilityCurrentRatingType') : null,
        late30Count: late ? findFirstText(late, 'CreditLiabilityLateCount30Day') || findFirstText(late, 'Count30Day') : null,
        late60Count: late ? findFirstText(late, 'CreditLiabilityLateCount60Day') || findFirstText(late, 'Count60Day') : null,
        late90Count: late ? findFirstText(late, 'CreditLiabilityLateCount90Day') || findFirstText(late, 'Count90Day') : null,
        paymentPattern: pat ? findFirstText(pat, 'CreditLiabilityPaymentPatternDataText') || findFirstText(pat, 'Data') : null,
        derogatoryIndicator: /^(true|y)/i.test(findFirstText(det, 'CreditLiabilityDerogatoryDataIndicator') || ''),
        isCollection: isColl,
        isAuthorizedUser: /authorized/i.test(ownership || ''),
      };
      primary.tradelines.push(row);
      if (isColl) primary.collections.push({ bureau: row.bureau, collectionAgencyName: row.creditorName, originalCreditorName: null, amount: row.unpaidBalance, status: row.accountStatusType, dateReported: row.dateReported });
    }
    for (const q of findAll(creditResponse || message, 'CREDIT_INQUIRY')) {
      const det = findAll(q, 'CREDIT_INQUIRY_DETAIL')[0] || q;
      primary.inquiries.push({
        bureau: bureauOf3(q), inquiryDate: findFirstText(det, 'CreditInquiryDate') || findFirstText(q, 'CreditInquiryDate'),
        inquiringPartyName: findFirstText(q, 'FullName') || findFirstText(q, 'Name'),
        businessType: findFirstText(q, 'CreditBusinessType'), loanType: findFirstText(q, 'CreditLoanType'),
      });
    }
    for (const pr of findAll(creditResponse || message, 'CREDIT_PUBLIC_RECORD')) {
      const det = findAll(pr, 'CREDIT_PUBLIC_RECORD_DETAIL')[0] || pr;
      primary.publicRecords.push({
        bureau: bureauOf3(pr), recordType: findFirstText(det, 'CreditPublicRecordType'),
        filedDate: findFirstText(det, 'CreditPublicRecordFiledDate'), reportedDate: findFirstText(det, 'CreditPublicRecordReportedDate'),
        dispositionType: findFirstText(det, 'CreditPublicRecordDispositionType'), dispositionDate: findFirstText(det, 'CreditPublicRecordDispositionDate'),
        amount: findFirstText(det, 'CreditPublicRecordLegalObligationAmount'), courtName: findFirstText(det, 'CreditPublicRecordCourtName'),
        docketIdentifier: findFirstText(det, 'CreditPublicRecordDocketIdentifier'), plaintiffName: findFirstText(det, 'CreditPublicRecordPlaintiffName'),
        derogatoryIndicator: true,
      });
    }
    if (finalBorrowers.length > 1 && (primary.tradelines.length || primary.inquiries.length)) result.multiBorrowerBlocksUnsplit = true;
  }

  // Reported identity per borrower (from each borrower PARTY's BORROWER node).
  for (const b of finalBorrowers) {
    const party = borrowerParties.find((p) => {
      const nm = findAll(p, 'NAME')[0];
      return nm && (findFirstText(nm, 'FirstName') || '').toUpperCase() === (b.firstName || '').toUpperCase()
        && (findFirstText(nm, 'LastName') || '').toUpperCase() === (b.lastName || '').toUpperCase();
    });
    if (!party) continue;
    const addrStr3 = (a) => [findFirstText(a, 'AddressLineText') || findFirstText(a, 'StreetAddress'), findFirstText(a, 'CityName'), findFirstText(a, 'StateCode'), findFirstText(a, 'PostalCode')].filter(Boolean).join(', ');
    const residences = findAll(party, 'RESIDENCE');
    b.reportedIdentity = {
      reportedName: [b.firstName, b.middleName, b.lastName].filter(Boolean).join(' '),
      dob: findFirstText(party, 'BirthDate'),
      ssn: (findFirstText(party, 'TaxpayerIdentifierValue') || '').replace(/\D/g, '') || null,
      aliases: findAll(party, 'ALIAS').map((a) => { const nm = findAll(a, 'NAME')[0]; return nm ? [findFirstText(nm, 'FirstName'), findFirstText(nm, 'LastName')].filter(Boolean).join(' ') : null; }).filter(Boolean),
      currentAddress: residences.length ? addrStr3(findAll(residences[0], 'ADDRESS')[0] || residences[0]) : null,
      formerAddresses: residences.slice(1).map((r) => addrStr3(findAll(r, 'ADDRESS')[0] || r)).filter(Boolean),
      employers: findAll(party, 'EMPLOYER').map((e) => findFirstText(e, 'FullName') || findFirstText(e, 'LegalEntityName') || findFirstText(e, 'Name')).filter(Boolean),
    };
  }

  // Report-level ALERTS (3.4 CREDIT_RESPONSE_ALERT_MESSAGE + CREDIT_FILE alerts).
  const alerts3 = [];
  for (const al of findAll(message, 'CREDIT_RESPONSE_ALERT_MESSAGE')) {
    const rawType = findFirstText(al, 'CreditResponseAlertMessageCategoryType');
    const text = findFirstText(al, 'CreditResponseAlertMessageText');
    if (!rawType && !text) continue;
    alerts3.push({ category: categorizeAlert(rawType, text), rawType, text: text || null, bureau: bureauOf3(al), borrowerId: null });
  }
  result.alerts = alerts3;

  // ---- PDF (embedded base64) ----
  const vf = findAll(message, 'VIEW_FILE')[0] || findAll(message, 'DOCUMENT')[0];
  const b64 = findFirstText(message, 'EmbeddedContentXML') || findFirstText(message, 'ForeignObject');
  if (b64 && b64.length > 40) {
    result.pdf = {
      base64: String(b64),
      mimeType: findFirstText(message, 'MIMETypeIdentifier') || 'application/pdf',
      encoding: 'base64',
      name: vf ? attr(vf, 'xlink:label') : null,
    };
  }
  return result;
}

/** Decode the embedded report PDF through the upload chokepoint; verify %PDF/%%EOF. */
function decodeReportPdf(base64) {
  if (!base64) throw badResponse('no PDF content');
  const { buf, sha256 } = decodeUploadBase64(String(base64));
  const head = buf.slice(0, 5).toString('latin1');
  if (head !== '%PDF-') throw badResponse('decoded content is not a PDF');
  // Also require the %%EOF trailer (parity with the 2.3.1 decoder): a truncated PDF
  // has a valid header but a cut body. Check the tail, not the whole buffer.
  const tail = buf.slice(-1024).toString('latin1');
  if (!tail.includes('%%EOF')) throw badResponse('decoded PDF is truncated (missing %%EOF trailer)');
  return { buf, sha256 };
}

module.exports = { parseCreditResponse, decodeReportPdf, PARSER_OPTS };

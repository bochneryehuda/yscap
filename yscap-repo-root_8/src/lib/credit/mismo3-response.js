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
  const scoreNodes = findAll(message, 'CREDIT_SCORE_DETAIL').map((d) => ({
    bureau: findFirstText(d, 'CreditRepositorySourceType'),
    model: findFirstText(d, 'CreditScoreModelNameType'),
    value: findFirstText(d, 'CreditScoreValue'),
    exclusionReason: findFirstText(d, 'CreditScoreExclusionReasonType'),
    date: findFirstText(d, 'CreditScoreDate') || result.firstIssuedDate,
    factors: findAll(d, 'CREDIT_SCORE_FACTOR').map((f) => ({
      code: findFirstText(f, 'CreditScoreFactorCode'), text: findFirstText(f, 'CreditScoreFactorText'),
    })).filter((f) => f.code || f.text),
  })).filter((s) => s.bureau || s.value);

  // ---- borrowers (identity) ----
  // Borrower parties carry PartyRoleType=Borrower with a NAME + TAXPAYER_IDENTIFIER.
  const borrowerParties = findAll(message, 'PARTY').filter((p) => {
    const roles = findAll(p, 'ROLE_DETAIL');
    return roles.some((r) => (findFirstText(r, 'PartyRoleType') || '') === 'Borrower') || findAll(p, 'BORROWER').length;
  });
  // The deep PARTY scan picks up nested/echoed borrower parties (per-bureau
  // BORROWER blocks, the request echo, the response borrower) — all the SAME
  // person repeated. Collapse to DISTINCT borrowers keyed by SSN (else name), so
  // a single borrower is one entry and a real joint stays two.
  const seen = new Map();
  for (const p of borrowerParties) {
    const nm = findAll(p, 'NAME')[0];
    const first = nm ? findFirstText(nm, 'FirstName') : null;
    const last = nm ? findFirstText(nm, 'LastName') : null;
    const ssn = findFirstText(p, 'TaxpayerIdentifierValue');
    const key = (ssn && String(ssn).replace(/\D/g, '')) || `${(first || '').toUpperCase()}|${(last || '').toUpperCase()}`;
    if (!key || key === '|') continue;
    if (!seen.has(key)) {
      seen.set(key, {
        borrowerId: attr(findAll(p, 'ROLE')[0], 'xlink:label') || (seen.size === 0 ? 'B1' : `C${seen.size}`),
        firstName: first, lastName: last, middleName: nm ? findFirstText(nm, 'MiddleName') : null, ssn, scores: [],
      });
    } else {
      const cur = seen.get(key);   // fill any identity gaps from a later, richer copy
      if (!cur.firstName && first) cur.firstName = first;
      if (!cur.lastName && last) cur.lastName = last;
    }
  }
  const identities = [...seen.values()];
  if (!identities.length) identities.push({ borrowerId: 'B1', firstName: findFirstText(message, 'FirstName'), lastName: findFirstText(message, 'LastName'), ssn: null, scores: [] });

  // Score→borrower mapping. Single borrower → all scores. Multiple → group by the
  // borrower whose CREDIT_RESPONSE subtree the scores live in; if the scores are
  // flat (one shared block), they cannot be safely split, so leave them on the
  // primary and flag (import routes an ambiguous multi-borrower 3.4 to review).
  if (identities.length === 1) {
    identities[0].scores = scoreNodes;
  } else {
    let grouped = false;
    for (const cr of findAll(message, 'CREDIT_RESPONSE')) {
      const crScores = findAll(cr, 'CREDIT_SCORE_DETAIL').map((d) => ({
        bureau: findFirstText(d, 'CreditRepositorySourceType'), model: findFirstText(d, 'CreditScoreModelNameType'),
        value: findFirstText(d, 'CreditScoreValue'), exclusionReason: findFirstText(d, 'CreditScoreExclusionReasonType'),
        date: findFirstText(d, 'CreditScoreDate') || result.firstIssuedDate, factors: [],
      })).filter((s) => s.bureau || s.value);
      if (!crScores.length) continue;
      // Associate this CREDIT_RESPONSE's scores to the borrower whose SSN/name it carries.
      const crSsn = findFirstText(cr, 'TaxpayerIdentifierValue');
      const crFirst = findFirstText(cr, 'FirstName');
      const match = identities.find((b) => (crSsn && b.ssn && b.ssn === crSsn) || (crFirst && b.firstName && b.firstName.toUpperCase() === crFirst.toUpperCase()));
      if (match) { match.scores.push(...crScores); grouped = true; }
    }
    if (!grouped) { identities[0].scores = scoreNodes; result.multiBorrowerUnsplit = true; }
  }
  result.borrowers = identities;

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
  return { buf, sha256 };
}

module.exports = { parseCreditResponse, decodeReportPdf, PARSER_OPTS };

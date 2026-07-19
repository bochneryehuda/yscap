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

// Repeatable nodes → always arrays (so one bureau / one error doesn't collapse
// to an object and get mis-read or dropped).
const ARRAY_NODES = new Set([
  'CREDIT_SCORE', 'CREDIT_ERROR_MESSAGE', 'BORROWER', 'CREDIT_FILE', 'KEY', '_Text', '_FACTOR',
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

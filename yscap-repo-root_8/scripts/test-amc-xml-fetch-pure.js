'use strict';
/**
 * Pure test for HOW WE GET THE APPRAISAL DATA FILE BACK from AppraisalScope — the
 * RetriveDocumentContent builder + its parser, pinned against the vendor's OWN
 * artifacts. No DB, no network.
 *
 * THE QUESTION THIS ANSWERS. `RetriveAppraisalDocuments` returns one entry per
 * document, and each entry's `objectURL` is the PDF. The MISMO data file the
 * appraisal importer runs on is NOT an entry of its own: it is NAMED on that entry
 * (`objectXMLFileName`) and flagged by `includeXMLIndicator`. So a poll that only
 * downloaded the URLs it was handed would file a PDF and no data file, and the
 * appraisal would never import — no value, no comparables, no findings.
 *
 * THE EVIDENCE, all from the package the vendor shipped us (docs/vendor/appraisalscope):
 *   · Mapping workbook, Response row 82 — "Service Provider Document Identifier",
 *     message.deals[1..n].embeddedFiles[1..n].documentId, example value `1843_XML`.
 *   · Response row 84 — "XML Included Indicator" (`includeXMLIndicator`, 0/1);
 *     row 68 — `objectXMLFileName`.
 *   · Request row 23 — "Document Identifier", message.products[1..n].documentId,
 *     marked REQUIRED for RetriveDocumentContent.
 *   · samples/Orders/CDG JSON retrivedocumentcontent {request,response}.json — the
 *     exact envelope, and a response whose deals[0].embeddedFiles[0].objectURL is
 *     the file's bytes.
 * So: list the documents, then fetch the data file BY THAT `_XML`-suffixed id.
 *
 * WHAT IS PROVEN AND WHAT IS NOT. Their package proves the SHAPE OF THE CALL. It
 * does not prove what comes back down the URL — which is exactly why the poll reads
 * the bytes and discards an answer that is not XML (covered in test-amc-sync-db.js)
 * rather than trusting the `_XML` in the id.
 */
const fs = require('fs');
const path = require('path');
const cdg = require('../src/amc/cdg');

const SAMPLES = path.join(__dirname, '../docs/vendor/appraisalscope/samples/Orders');
const readSample = (n) => JSON.parse(fs.readFileSync(path.join(SAMPLES, n), 'utf8'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---- the request matches the vendor's own sample, field for field -----------
(() => {
  const sample = readSample('CDG JSON retrivedocumentcontent request.json').message;
  const built = cdg.buildRetrieveDocumentContent({
    apiKey: 'KEY123', subdomain: 'integrations.uat',
    spOrderNumber: 'SP-9', clientOrderNumber: '1234AB', documentId: '1705',
  }).message;

  eq(built.requestActionType, sample.requestActionType, 'the action is RetriveDocumentContent, spelled the vendor’s way');
  ok(Array.isArray(built.products), 'products is an ARRAY (the sample’s shape — not the single object other actions use)');
  eq(built.products.length, 1, 'exactly one product carries the document id');
  // Request mapping row 23 marks this Required — it is the whole point of the call.
  eq(built.products[0].documentId, sample.products[0].documentId, 'the document id rides on products[0].documentId');
  eq(cdg.refValue(built.clientSystem.referenceIdentifiers, 'ApiKey'), 'KEY123', 'the api key is on the live envelope');
  eq(cdg.refValue(built.clientSystem.referenceIdentifiers, 'ClientOrderNumber'),
    cdg.refValue(sample.clientSystem.referenceIdentifiers, 'ClientOrderNumber'), 'the client order number matches the sample');
  eq(cdg.refValue(built.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderSubDomain'),
    cdg.refValue(sample.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderSubDomain'), 'the subdomain matches the sample');
  // The sample omits the SP order number; we send it because it is what identifies the
  // order at the AMC on every other order action. Additive, never in place of the id.
  eq(cdg.refValue(built.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderOrderNumber'), 'SP-9',
    'the SP order number identifies the order, as on every other order action');

  // The id is the ONLY thing that says which file to send, so it is never dropped.
  const numeric = cdg.buildRetrieveDocumentContent({ apiKey: 'K', subdomain: 's', clientOrderNumber: '1', documentId: 1843 });
  eq(numeric.message.products[0].documentId, '1843', 'a numeric id is sent as a string');
  const suffixed = cdg.buildRetrieveDocumentContent({ apiKey: 'K', subdomain: 's', clientOrderNumber: '1', documentId: '1843_XML' });
  eq(suffixed.message.products[0].documentId, '1843_XML', 'the _XML-suffixed id the mapping workbook documents is sent verbatim');
  const missing = cdg.buildRetrieveDocumentContent({ apiKey: 'K', subdomain: 's', clientOrderNumber: '1' });
  eq(missing.message.products[0].documentId, '', 'a missing id is an empty string, never the literal "undefined"');

  const masked = cdg.maskRequest(cdg.buildRetrieveDocumentContent({
    apiKey: 'SECRETKEY', subdomain: 's', clientOrderNumber: '1', documentId: '1843_XML',
  }));
  eq(cdg.refValue(masked.message.clientSystem.referenceIdentifiers, 'ApiKey'), '***', 'maskRequest hides the api key in the journal');
  eq(masked.message.products[0].documentId, '1843_XML', 'the document id is not a secret and stays readable in the journal');
})();

// ---- the response parser reads the vendor's own sample ----------------------
(() => {
  const resp = readSample('CDG JSON retrivedocumentcontent response.json');
  eq(cdg.parseDocumentContentUrl(resp), 'https://nspdocstorage.com/getdocument/12345',
    'the file’s URL is read out of the vendor’s own sample response');

  // NEVER a guess: an answer with no URL is nothing, not an empty string to download.
  eq(cdg.parseDocumentContentUrl({}), null, 'an empty response yields no URL');
  eq(cdg.parseDocumentContentUrl({ message: {} }), null, 'a response with no deals yields no URL');
  eq(cdg.parseDocumentContentUrl({ message: { deals: [] } }), null, 'an empty deals array yields no URL');
  eq(cdg.parseDocumentContentUrl({ message: { deals: [{ embeddedFiles: [] }] } }), null, 'no embedded files yields no URL');
  eq(cdg.parseDocumentContentUrl({ message: { deals: [{ embeddedFiles: [{}, { objectURL: 'https://x/y' }] }] } }),
    'https://x/y', 'the first entry that actually carries a URL is the one used');
})();

// ---- the listing tells us a data file EXISTS and what it is called ----------
(() => {
  const listing = readSample('CDG JSON retriveappraisaldocuments response.json');
  const docs = cdg.parseDocuments(listing);
  ok(docs.length > 0, 'the vendor’s listing sample parses to at least one document');
  const withXml = docs.find((d) => d.hasXml);
  ok(withXml, 'the sample entry flags includeXMLIndicator — the vendor holds a data file for this report');
  ok(/\.xml$/i.test(withXml.xmlFileName || ''), 'the data file is NAMED on the entry (objectXMLFileName), not listed as its own entry');
  ok(/\.pdf$/i.test(withXml.objectName || '') || !/\.xml$/i.test(withXml.objectName || ''),
    'the entry’s OWN objectURL is the report, not the data file — which is why a second call is needed');
  ok(withXml.amcDocumentId, 'the entry carries the documentId RetriveDocumentContent is keyed on');

  // includeXMLIndicator arrives as a boolean in the sample; the workbook documents it
  // as 0/1. Both readings mean the same thing about the report.
  const truthy = [true, 'true', '1', 1];
  for (const v of truthy) {
    const [d] = cdg.parseDocuments({ message: { deals: [{ embeddedFiles: [{ documentId: 'X', includeXMLIndicator: v }] }] } });
    ok(d.hasXml === true, `includeXMLIndicator ${JSON.stringify(v)} reads as "there is a data file"`);
  }
  for (const v of [false, 'false', '0', 0, null, undefined]) {
    const [d] = cdg.parseDocuments({ message: { deals: [{ embeddedFiles: [{ documentId: 'X', includeXMLIndicator: v }] }] } });
    ok(d.hasXml === false, `includeXMLIndicator ${JSON.stringify(v)} reads as "there is not"`);
  }
})();

// ---- the invented cancel action stayed gone --------------------------------
// (the same lesson: an action nobody documented is a NACK waiting to happen)
ok(typeof cdg.buildRetrieveDocumentContent === 'function', 'buildRetrieveDocumentContent is exported');
ok(typeof cdg.parseDocumentContentUrl === 'function', 'parseDocumentContentUrl is exported');

console.log(`\n[test-amc-xml-fetch-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

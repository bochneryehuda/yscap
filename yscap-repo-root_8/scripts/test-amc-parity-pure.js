'use strict';
/**
 * OUR CDG IMPLEMENTATION AGAINST THE VENDOR'S OWN PACKAGE.
 *
 * A sweep of `docs/vendor/appraisalscope/` beside `src/amc/` turned up six places
 * where what we send or read disagreed with what AppraisalScope's own artifacts
 * say — every one of them silent, which is why they had survived. This suite pins
 * each against the vendor's file rather than against a hand-typed fixture, so a
 * regression is caught by their package and not by somebody's memory of it.
 *
 * The six, and what each one cost:
 *
 *   1. `propertyViewTypeIdentifier` — a key we invented. It appears NOWHERE in the
 *      vendor package; theirs is `propertyViewType` (30 occurrences). An
 *      unrecognised key is dropped in silence, so every order ever placed threw
 *      the property view away.
 *   2. The error reader dropped AppraisalScope's OWN error code (`E003`), which is
 *      the only thing their support can look up, and it did not recognise a
 *      PER-FILE upload rejection at all — so a send of three documents where two
 *      were refused could report success.
 *   3. The fee quote read `job_fee`, a COMPONENT, while `totalClientFee` — the
 *      vendor's own headline figure — sat unread.
 *   4. The GetFee request carried no ZIP, though their sample does and appraisal
 *      fees plainly vary by location.
 *   5. An inbound revision filed the literal text "(revision seen at the AMC)"
 *      while the vendor's payload carried the actual request, its author and its
 *      date.
 *   6. The returned-documents reader dropped `objectXMLFileName` /
 *      `includeXMLIndicator` — the MISMO data file the appraisal importer runs on.
 *
 * PURE — no database, no network. Runs anywhere.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cdg = require(path.join(ROOT, 'src/amc/cdg'));
const fees = require(path.join(ROOT, 'src/amc/fees'));
const VENDOR = path.join(ROOT, 'docs/vendor/appraisalscope');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.error('FAIL ' + m); } };

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(VENDOR, p), 'utf8'));
// Every file in the vendor package as one string, for "does this key exist anywhere"
// questions — the check that would have caught the invented key on day one.
const ALL = (function collect(dir, acc) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) collect(full, acc);
    else if (/\.(json|txt|md)$/i.test(name)) acc.push(fs.readFileSync(full, 'utf8'));
  }
  return acc;
}(VENDOR, [])).join('\n');
const countIn = (needle) => ALL.split(needle).length - 1;

/* ── 1. every key we invent must exist in the vendor's package ─────────────── */
ok(countIn('"propertyViewType"') > 0, '1a the vendor really does use propertyViewType');
ok(countIn('propertyViewTypeIdentifier') === 0, '1b and never propertyViewTypeIdentifier — the name we had invented');
const built = cdg.buildCreateAppraisal({
  apiKey: 'K', subdomain: 'integrations.uat', clientOrderNumber: 'YS-1',
  property: { addressLine: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', viewTypeIds: ['3', '7'] },
  borrowers: [{ firstName: 'A', lastName: 'B' }],
  products: [{ productCode: '1004' }],
});
const view = JSON.stringify(built).match(/propertyViewType[A-Za-z]*/g) || [];
ok(view.length > 0 && view.every((k) => k === 'propertyViewType'),
  '1c and the order we build now uses the vendor’s spelling, only');
ok(/"propertyViewType":"3"/.test(JSON.stringify(built)) || /"propertyViewType": ?"3"/.test(JSON.stringify(built)),
  '1d with the chosen view id actually in it');

/* ── 2. the error reader ───────────────────────────────────────────────────── */
const nack = JSON.parse(fs.readFileSync(path.join(VENDOR, 'samples/NACK Response/CDG JSON NACK Response.txt'), 'utf8'));
const nackAlt = JSON.parse(fs.readFileSync(path.join(VENDOR, 'samples/NACK Response/CDG JSON NACK Response (alternative).txt'), 'utf8'));
const e1 = cdg.parseError(nack);
ok(e1 && e1.code === '-1008', '2a the gateway NACK is still read exactly as before');
ok(e1.vendorCode === 'E003', '2b AppraisalScope’s OWN code is read — the only one their support can look up');
ok(/E003/.test(e1.description), '2c and reaches the sentence a person reads, with no call-site sweep');
ok(e1.vendorDescription === 'Service Provider Processing Error: Authentication Failed',
  '2d while the vendor’s own words are kept unmixed for anything that needs them raw');

const e2 = cdg.parseError(nackAlt);
ok(e2 && Array.isArray(e2.files) && e2.files.length === 2, '2e both rejected files are named');
ok(/happy\.abc/.test(e2.description) && /Invalid file extension/.test(e2.description),
  '2f and the refusal says WHICH file and why');

// The dangerous shape: files rejected while the envelope says ACK.
const ackButFileFailed = {
  message: {
    digitalGatewaySystem: { statusResponses: [{ statusCode: '0', statusCondition: 'Success', statusName: 'ACK' }] },
    products: [{ statusResponses: [{ objectName: 'x.abc', statusCondition: 'fail', statusDescription: 'Invalid file extension' }] }],
  },
};
ok(cdg.parseError(ackButFileFailed) !== null,
  '2g an upload that lost a file can NEVER report success, whatever the envelope said');

// THE HAZARD THIS INTRODUCES, and the guard against it: `products[].statusResponses[]`
// is the SAME array an ORDER STATUS arrives in. A status is not a rejected file.
const statusSample = readJson('samples/Orders/CDG JSON getappraisalstatus response.json');
ok(cdg.parseError(statusSample) === null, '2h an ordinary order status is not an error');
const hostileStatus = { message: { products: [{ statusResponses: [{ statusCode: 1099, statusName: 'Vendor-Rejected', statusCondition: 'Error', statusDescription: 'rejected' }] }] } };
ok(cdg.parseError(hostileStatus) === null,
  '2i and an order status whose CONDITION is "Error" is still not a rejected file — it names no file');
ok(cdg.parseStatus(statusSample) && cdg.parseStatus(statusSample).statusCode === '1001',
  '2j while the status reader is untouched');
ok(cdg.parseFileErrors(statusSample).length === 0 && cdg.parseFileErrors(nackAlt).length === 2,
  '2k the per-file reader tells the two apart on the vendor’s own files');
// An ACK with nothing wrong is still null — the whole point of not crying wolf.
ok(cdg.parseError({ message: { digitalGatewaySystem: { statusResponses: [{ statusCode: '0', statusCondition: 'Success' }] } } }) === null,
  '2l a clean ACK is still no error at all');

/* ── 3. the fee that gets quoted ───────────────────────────────────────────── */
const feeRows = cdg.parseLookup(readJson('samples/Lookups/CDG JSON getfee response.json'));
ok(feeRows.length === 1 && feeRows[0].totalClientFee === '450.00' && feeRows[0].clientRushFee === '50.00',
  '3a the vendor states a headline total AND a separate rush fee');
const quoted = fees.feeAmount(feeRows[0]);
ok(quoted === 450, '3b the quote takes the vendor’s own total');
// Prove it PREFERS the total rather than merely agreeing with job_fee by accident:
// a row where the two differ is the only case that can tell them apart.
ok(fees.feeAmount({ totalClientFee: '500.00', job_fee: '450.00' }) === 500,
  '3c and where the two differ, the TOTAL wins — not the base fee');
ok(fees.feeAmount({ job_fee: '450.00' }) === 450,
  '3d a lookup that states no total still quotes, exactly as before');

/* ── 4. a fee is quoted for a place ────────────────────────────────────────── */
const feeReq = readJson('samples/Lookups/CDG JSON getfee request.json');
ok(!!feeReq.message.deals[0].properties[0].address.postalCode,
  '4a the vendor’s own GetFee request carries a ZIP');
const ourFee = cdg.buildGetFee({ apiKey: 'K', subdomain: 's', productCode: '1004', postalCode: '08701' });
ok(ourFee.message.deals[0].properties[0].address.postalCode === '08701', '4b and so does ours now');
const ourFeeNoZip = cdg.buildGetFee({ apiKey: 'K', subdomain: 's', productCode: '1004' });
ok(!ourFeeNoZip.message.deals,
  '4c while a quote with no address is byte-for-byte what it always was');
// The cache has to move with the request, or one property is quoted another's price.
ok(fees.feeKey('1004', '08701') !== fees.feeKey('1004', '11219'),
  '4d two ZIPs are two cache keys — a quote is never served for the wrong property');
ok(fees.feeKey('1004') === 'GetFee#1004',
  '4e and a quote with no ZIP keeps its old key, so nothing cached is orphaned');

/* ── 5. an inbound revision says what was asked for ────────────────────────── */
const revs = cdg.parseRevisions(readJson('samples/Orders/CDG JSON getrevisions response.json'));
ok(revs.length >= 1 && revs[0].amcRevisionId === '33', '5a the revision id is read as before');
ok(revs[0].body === 'test', '5b and the vendor’s actual request text');
ok(revs[0].author === 'API Testing(Manager)' && !!revs[0].createdAt, '5c with who asked, and when');
ok(cdg.parseRevisions({ message: { products: [{ revisionId: '9' }] } })[0].body === null,
  '5d a revision the vendor sent no text with reads as no text — never invented');

/* ── 6. the data file the appraisal importer runs on ───────────────────────── */
const docs = cdg.parseDocuments(readJson('samples/Orders/CDG JSON retriveappraisaldocuments response.json'));
ok(docs.length === 2, '6a both returned documents are read');
ok(docs[0].xmlFileName === 'integrations_Testborrower(1070)-V1.xml',
  '6b the MISMO data file the vendor names is no longer discarded');
ok(docs[0].hasXml === true, '6c and their flag for whether one exists at all');
ok(cdg.parseDocuments({ message: { deals: [{ embeddedFiles: [{ documentId: '1' }] }] } })[0].hasXml === false,
  '6d absent reads as no XML, never as yes');
// The dedupe hazard this response reveals: both entries carry the SAME documentId.
ok(docs[0].amcDocumentId === docs[1].amcDocumentId,
  '6e the vendor’s own response returns two documents under ONE document id');
const sync = fs.readFileSync(path.join(ROOT, 'src/amc/sync.js'), 'utf8');
ok(/amc_document_id=\$2[\s\S]{0,200}object_name/.test(sync),
  '6f so the ingest tells two documents apart by id AND name, or the second is lost');

console.log(`\ntest-amc-parity-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

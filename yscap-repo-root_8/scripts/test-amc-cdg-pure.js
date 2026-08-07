'use strict';
/**
 * Pure test for the CDG (AppraisalScope / CoreLogic Digital Gateway) message
 * builders + response parsers (src/amc/cdg.js). No DB, no network — asserts the
 * request/response contract against the shapes in the vendor iPackage samples.
 *
 * Locks in: the auth (DoLogin) round-trip; lookup flattening; CreateAppraisal's
 * REQUIRED fields + envelope identifiers; the ACK / comments / revision / status /
 * documents parsers against real sample shapes; the status→lifecycle map; and that
 * the api key is masked out of the write journal.
 */
const cdg = require('../src/amc/cdg');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
function get(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[/^\d+$/.test(k) ? Number(k) : k]), obj); }

// ---- DoLogin round-trip ----
(() => {
  const req = cdg.buildDoLogin({ loginAccount: 'apitesting', loginPassword: 'AScope123$', subdomain: 'integrations.uat' });
  ok(req.message.requestActionType === 'DoLogin', 'DoLogin action');
  ok(get(req, 'message.clientSystem.credentials.0.loginAccountIdentifier') === 'apitesting', 'DoLogin account');
  ok(cdg.refValue(req.message.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderSubDomain') === 'integrations.uat', 'DoLogin subdomain');
  const apiKey = cdg.parseDoLogin({ message: { clientSystem: { referenceIdentifiers: [{ referenceIdentifierType: 'ApiKey', referenceIdentifierValue: 'KEY123' }] } } });
  ok(apiKey === 'KEY123', 'parseDoLogin returns the api key');
})();

// ---- lookups (GetJobType shape) ----
(() => {
  const req = cdg.buildLookup({ actionType: 'GetJobType', apiKey: 'K', subdomain: 'integrations.uat' });
  ok(req.message.requestActionType === 'GetJobType', 'lookup action');
  ok(cdg.refValue(req.message.clientSystem.referenceIdentifiers, 'ApiKey') === 'K', 'lookup carries api key');
  const rows = cdg.parseLookup({ responseData: { responseType: 'Products', count: 2, responseFields: [
    { num: 1, fieldlist: [{ fieldName: 'id', fieldValue: '5' }, { fieldName: 'name', fieldValue: 'Single-family Appraisal (1004)' }] },
    { num: 2, fieldlist: [{ fieldName: 'id', fieldValue: '6' }, { fieldName: 'name', fieldValue: '1004 & 1007' }] },
  ] } });
  ok(rows.length === 2 && rows[0].id === '5' && rows[0].name === 'Single-family Appraisal (1004)', 'parseLookup flattens rows');
})();

// ---- CreateAppraisal: required fields + envelope ----
(() => {
  const spec = {
    productCode: '76', subproductCodes: ['5', '6'], amcIdentifier: '426',
    clientOrderNumber: '1234AB', clientReferenceNumber: 'ABD-1', rush: true, needByDate: '2026-09-01',
    jobFee: 25, managementFee: 50, requestComment: 'hello', notifyEmails: ['a@b.com'],
    loan: { loanNumber: '2020092901', mortgageType: 'Conventional', loanPurpose: 'Purchase', baseLoanAmount: 180000, estimatedClosingDate: '2026-09-15', lienPriority: '1st Lien Position' },
    property: { titleCategory: 'Single Family', addressLine: '501 NE 122nd St', addressLine2: 'Suite D', city: 'Oklahoma City', state: 'OK', postalCode: '73114', county: 'Oklahoma', occupancy: 'Investment', salesContractAmount: 200000 },
    borrowers: [{ classification: 'Primary', firstName: 'Peter', lastName: 'Parker', fullName: 'Peter Parker', contacts: [{ type: 'Home', email: 'p@x.com', phone: '123' }], residence: { addressLine: '1 A St', city: 'DC', state: 'DC', postalCode: '20013' } }],
    parties: { loanOfficerId: '429', loanProcessorId: '484', investorId: '447', bestContact: 'Borrower' },
    embeddedFiles: [{ objectURL: 'https://g/getdocument/1', objectName: 'c.pdf', documentType: 'Sales Contract', documentEffectiveDate: '2026-03-14' }],
  };
  const req = cdg.buildCreateAppraisal(spec, { apiKey: 'K', subdomain: 'integrations.uat', lenderIdentifier: 'GG000146', sourceClientId: '267' });
  const m = req.message;
  ok(m.requestActionType === 'CreateAppraisal', 'create action');
  ok(cdg.refValue(m.clientSystem.referenceIdentifiers, 'ApiKey') === 'K', 'create api key');
  ok(cdg.refValue(m.clientSystem.referenceIdentifiers, 'ClientOrderNumber') === '1234AB', 'create client order number');
  ok(m.clientSystem.sourceInformation.sourceClientIdentifier === '267', 'create sourceClientIdentifier');
  ok(cdg.refValue(m.digitalGatewaySystem.referenceIdentifiers, 'DigitalGatewayLenderIdentifier') === 'GG000146', 'create lender identifier');
  ok(cdg.refValue(m.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderSubDomain') === 'integrations.uat', 'create subdomain');
  ok(m.products[0].productCode === '76', 'create product code (form)');
  ok(m.products[0].subproducts.length === 2 && m.products[0].subproducts[0].identifier === '5', 'create subproducts');
  ok(m.products[0].serviceExpediteType === '1', 'create rush → 1');
  ok(m.products[0].jobFee === '25.00' && m.products[0].managementFee === '50.00', 'create fees formatted');
  ok(m.products[0].embeddedFiles[0].objectURL === 'https://g/getdocument/1', 'create embedded file url');
  const deal = m.deals[0];
  ok(deal.appraisers[0].partyRoleType === 'AMC' && deal.appraisers[0].identifier === '426', 'create AMC preference');
  ok(deal.loans[0].loanIdentifiers.lenderLoanIdentifier === '2020092901', 'create loan number');
  ok(deal.loans[0].mortgageType === 'Conventional', 'create mortgage type');
  ok(deal.loans[0].baseLoanAmount === '180000.00', 'create base loan amount');
  ok(deal.properties[0].titleCategoryType === 'Single Family', 'create property title category');
  ok(deal.properties[0].address.addressLine === '501 NE 122nd St' && deal.properties[0].address.stateCode === 'OK' && deal.properties[0].address.postalCode === '73114', 'create property address');
  ok(deal.properties[0].salesContractAmount === '200000.00', 'create sales contract amount');
  ok(deal.borrowers[0].firstName === 'Peter' && deal.borrowers[0].lastName === 'Parker', 'create borrower name');
  ok(deal.borrowers[0].contacts[0].contactEmail === 'p@x.com', 'create borrower contact');
  ok(deal.borrowers[0].residences[0].address.cityName === 'DC', 'create borrower residence');
  const bestContact = deal.parties.find((x) => x.partyRoleType === 'BestContact');
  ok(bestContact && bestContact.partyRoleTypeIdentifier === 'Borrower', 'create best contact (required)');
  ok(deal.parties.find((x) => x.partyRoleType === 'LoanOfficer').partyRoleTypeIdentifier === '429', 'create loan officer');
})();

// ---- AddForm carries the parent SP order number ----
(() => {
  const req = cdg.buildCreateAppraisal(
    { requestAction: 'AddForm', parentSpOrderNumber: 'SP345', productCode: '76', loan: { loanNumber: '1' }, borrowers: [], property: {} },
    { apiKey: 'K', subdomain: 's' });
  ok(req.message.requestActionType === 'AddForm', 'addform action');
  ok(cdg.refValue(req.message.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderOrderNumber') === 'SP345', 'addform parent order number');
})();

// ---- parseAck against the createappraisal response sample ----
(() => {
  const ack = cdg.parseAck({ message: {
    digitalGatewaySystem: { referenceIdentifiers: [{ referenceIdentifierType: 'DigitalGatewayOrderNumber', referenceIdentifierValue: 'CLGGL100417' }], statusResponses: [{ statusCode: '0', statusName: 'ACK', statusCondition: 'Success', statusDescription: 'Acknowledgement' }] },
    deals: [{ loans: [{ loanIdentifiers: { lenderLoanIdentifier: '2020092901' } }], properties: [{ appraisalIdentifier: 'UAT2021' }] }],
    products: [{ productDescription: 'Single-family Appraisal (1004)' }],
    serviceProviderSystem: { referenceIdentifiers: [{ referenceIdentifierType: 'ServiceProviderOrderNumber', referenceIdentifierValue: 'SP345' }] },
  } });
  ok(ack.cdgOrderNumber === 'CLGGL100417', 'ack CDG order number');
  ok(ack.spOrderNumber === 'SP345', 'ack SP order number (appraisal_id)');
  ok(ack.appraisalFileNumber === 'UAT2021', 'ack appraisal file number');
  ok(ack.productDescription === 'Single-family Appraisal (1004)', 'ack product description');
  ok(ack.statusName === 'ACK', 'ack status');
})();

// ---- comments (AddComment / GetComments) ----
(() => {
  const req = cdg.buildAddComment({ apiKey: 'K', subdomain: 's', spOrderNumber: 'SP123', text: 'Special instructions' });
  ok(req.message.requestActionType === 'AddComment' && req.message.products.requestCommentText === 'Special instructions', 'AddComment shape');
  ok(cdg.refValue(req.message.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderOrderNumber') === 'SP123', 'AddComment SP order');
  const comments = cdg.parseComments({ message: { products: [
    { commentId: '15007', requestCommentText: 'hi', requestCommentContactFullName: 'API Testing(Manager)', requestCommentTextDatetime: '2021-05-17 13:57:06' },
    { commentId: '15006', requestCommentText: 'yo', requestCommentContactFullName: 'X', requestCommentTextDatetime: '2021-05-17 13:57:00' },
  ] } });
  ok(comments.length === 2 && comments[0].amcCommentId === '15007' && comments[0].authorName === 'API Testing(Manager)', 'parseComments');
})();

// ---- revisions ----
(() => {
  const req = cdg.buildAddRevision({ apiKey: 'K', subdomain: 's', spOrderNumber: 'SP123', text: 'reconsider the value' });
  ok(req.message.requestActionType === 'AddRevision' && req.message.products.revisedRequestCommentText === 'reconsider the value', 'AddRevision shape');
  ok(cdg.parseRevisionAck({ message: { products: [{ revisionId: '33' }] } }).amcRevisionId === '33', 'parseRevisionAck');
})();

// ---- documents (upload + retrieve/parse) ----
(() => {
  const up = cdg.buildUploadDocuments({ action: 'UploadDocumentMulti', apiKey: 'K', subdomain: 's', spOrderNumber: '1183', documents: [
    { objectURL: 'https://g/getdocument/1', objectName: 'a.pdf', documentType: 'Appraisal Document', objectDescription: 'Appraisal' },
  ] });
  ok(up.message.requestActionType === 'UploadDocumentMulti', 'UploadDocumentMulti action');
  ok(up.message.products[0].embeddedFiles[0].objectURL === 'https://g/getdocument/1', 'upload embedded url');
  const ret = cdg.buildRetrieveDocuments({ apiKey: 'K', subdomain: 's', spOrderNumber: '1070', includeAdditional: true });
  ok(ret.message.searchCriteria[0].fieldName === 'retrieveAdditionalDocuments' && ret.message.searchCriteria[0].fieldValue === '1', 'retrieve additional flag');
  const docs = cdg.parseDocuments({ message: { deals: [{ embeddedFiles: [
    { documentId: '1004_XML', documentType: 'Sales Contract', objectName: 'x.pdf', objectURL: 'https://g/getappraisalscopedocument/x.pdf', objectSize: '2629260', isAdditionalDocument: '0', createdDatetime: '2021-03-29 13:54:07' },
    { documentId: 'ADD1', objectName: 'y.pdf', objectURL: 'https://g/y.pdf', isAdditionalDocument: '1' },
  ] }] } });
  ok(docs.length === 2 && docs[0].amcDocumentId === '1004_XML' && docs[0].objectUrl === 'https://g/getappraisalscopedocument/x.pdf', 'parseDocuments url');
  ok(docs[0].isAdditional === false && docs[1].isAdditional === true, 'parseDocuments additional flag');
})();

// ---- status ----
(() => {
  const st = cdg.parseStatus({ message: { products: [{ statusResponses: [{ statusCode: 1001, statusCondition: 'Status', statusDescription: 'On Hold', statusName: 'Vendor-SetHold' }] }] } });
  ok(st.statusName === 'Vendor-SetHold' && st.statusCode === '1001', 'parseStatus reads product status');
  ok(cdg.mapStatusToLifecycle('1990', 'Vendor-ProductAvailable') === 'product_available', 'map ProductAvailable');
  ok(cdg.mapStatusToLifecycle('1200', 'Vendor-OrderAssignedToAppraiser') === 'assigned', 'map assigned');
  ok(cdg.mapStatusToLifecycle('1001', 'Vendor-SetHold') === 'on_hold', 'map hold');
  ok(cdg.mapStatusToLifecycle('1999', 'Vendor-Complete') === 'completed', 'map complete');
  ok(cdg.mapStatusToLifecycle('-1007', 'Vendor-OrderRejected') === 'rejected', 'map rejected');
  ok(cdg.mapStatusToLifecycle('9999', 'Something-Unknown') === null, 'map unknown → null (leave unchanged)');
})();

// ---- errors + masking ----
(() => {
  const err = cdg.parseError({ message: { digitalGatewaySystem: { statusResponses: [{ statusCode: '-100', statusCondition: 'Failure', statusName: 'NACK', statusDescription: 'NOT_AUTHENTICATED' }] } } });
  ok(err && err.code === '-100' && err.description === 'NOT_AUTHENTICATED', 'parseError reads a NACK');
  ok(cdg.parseError({ message: { digitalGatewaySystem: { statusResponses: [{ statusCode: '0', statusCondition: 'Success' }] } } }) === null, 'parseError null on ACK');
  const masked = cdg.maskRequest({ message: { clientSystem: { referenceIdentifiers: [{ referenceIdentifierType: 'ApiKey', referenceIdentifierValue: 'SECRET' }], credentials: [{ loginAccountPassword: 'pw' }] } } });
  ok(cdg.refValue(masked.message.clientSystem.referenceIdentifiers, 'ApiKey') === '***', 'maskRequest hides api key');
  ok(masked.message.clientSystem.credentials[0].loginAccountPassword === '***', 'maskRequest hides login password');
})();

console.log(`\n[test-amc-cdg-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

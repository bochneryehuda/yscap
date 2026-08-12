'use strict';
/**
 * CDG (CoreLogic Digital Gateway) message builders + response parsers for the
 * AppraisalScope appraisal-ordering integration.
 *
 * PURE + dependency-free (no db, no network, no config) so the whole request/response
 * contract is unit-tested with `node scripts/test-amc-cdg-pure.js`. The transport
 * (OAuth, DoLogin, retries, dry-run gate) lives in src/amc/client.js; this module only
 * shapes the JSON that goes over the wire and reads the JSON that comes back.
 *
 * The wire format is "CDG Standard JSON": a `message` envelope carrying
 * clientSystem / digitalGatewaySystem / serviceProviderSystem reference-identifier
 * arrays, a requestActionType, and products[] / deals[] payloads. See
 * docs/AMC-APPRAISALSCOPE-INTEGRATION.md and the vendor iPackage for the full spec.
 *
 * A few OPTIONAL leaf field names (best-contact, some site-analysis fields) could not
 * be pinned exactly from the vendor mapping and are marked "verify against UAT" — the
 * REQUIRED fields below all come from the vendor's own sample payloads.
 */

// ---- reference-identifier helpers -----------------------------------------
function ref(type, value) { return { referenceIdentifierType: type, referenceIdentifierValue: value }; }

// Read a referenceIdentifierValue of a given type out of a reference-identifier array.
function refValue(refs, type) {
  if (!Array.isArray(refs)) return null;
  const hit = refs.find((r) => r && r.referenceIdentifierType === type);
  return hit ? hit.referenceIdentifierValue : null;
}

// The clientSystem block carried on every authenticated call (api key + our order refs).
function clientSystem({ apiKey, clientOrderNumber, clientReferenceNumber, sourceClientId } = {}) {
  const refs = [];
  if (apiKey != null) refs.push(ref('ApiKey', apiKey));
  if (clientOrderNumber != null) refs.push(ref('ClientOrderNumber', String(clientOrderNumber)));
  if (clientReferenceNumber != null) refs.push(ref('ClientReferenceNumber', String(clientReferenceNumber)));
  const cs = { referenceIdentifiers: refs };
  if (sourceClientId != null) cs.sourceInformation = { sourceClientIdentifier: String(sourceClientId) };
  return cs;
}

function serviceProviderSystem({ subdomain, spOrderNumber } = {}) {
  const refs = [];
  if (subdomain != null) refs.push(ref('ServiceProviderSubDomain', subdomain));
  if (spOrderNumber != null) refs.push(ref('ServiceProviderOrderNumber', String(spOrderNumber)));
  return { referenceIdentifiers: refs };
}

function digitalGatewaySystem({ lenderIdentifier } = {}) {
  const refs = [];
  if (lenderIdentifier != null) refs.push(ref('DigitalGatewayLenderIdentifier', lenderIdentifier));
  return { referenceIdentifiers: refs };
}

// ---- auth ------------------------------------------------------------------
function buildDoLogin({ loginAccount, loginPassword, subdomain }) {
  return {
    message: {
      clientSystem: { credentials: [{ loginAccountIdentifier: loginAccount, loginAccountPassword: loginPassword }] },
      serviceProviderSystem: { referenceIdentifiers: [ref('ServiceProviderSubDomain', subdomain)] },
      requestActionType: 'DoLogin',
    },
  };
}
function parseDoLogin(resp) {
  const m = resp && resp.message;
  return m && refValue(m.clientSystem && m.clientSystem.referenceIdentifiers, 'ApiKey');
}

// ---- lookups ---------------------------------------------------------------
// GetJobType / Get_JobTypes_By_LoanType / GetLoanType / GetPropertyType / GetAMCPreference / …
function buildLookup({ actionType, apiKey, subdomain, searchCriteria }) {
  const message = {
    clientSystem: clientSystem({ apiKey }),
    serviceProviderSystem: serviceProviderSystem({ subdomain }),
    requestActionType: actionType,
  };
  if (Array.isArray(searchCriteria) && searchCriteria.length) message.searchCriteria = searchCriteria;
  return { message };
}
// Lookups come back as responseData.responseFields[].fieldlist[]{fieldName,fieldValue}.
// Flatten each row to a plain object, e.g. {id:'5', name:'Single-family Appraisal (1004)'}.
function parseLookup(resp) {
  const rows = resp && resp.responseData && resp.responseData.responseFields;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const out = {};
    const list = row && row.fieldlist;
    if (Array.isArray(list)) for (const f of list) if (f && f.fieldName != null) out[f.fieldName] = f.fieldValue;
    return out;
  });
}

// ---- CreateAppraisal / AddForm --------------------------------------------
// `spec` is a normalized, PILOT-side order object (auto-filled from the loan file +
// Property Research). This shapes it into the CDG deals[]/products[] structure.
function buildCreateAppraisal(spec, ctx) {
  const {
    apiKey, subdomain, lenderIdentifier, sourceClientId,
  } = ctx || {};
  const isAddForm = spec.requestAction === 'AddForm';

  const product = {
    productCode: String(spec.productCode),
  };
  if (Array.isArray(spec.subproductCodes) && spec.subproductCodes.length) {
    product.subproducts = spec.subproductCodes.map((id) => ({ identifier: String(id) }));
  }
  if (spec.rush != null) product.serviceExpediteType = spec.rush ? '1' : '0';
  if (spec.needByDate) product.serviceNeedByDate = spec.needByDate;
  if (spec.requestComment) product.requestCommentText = spec.requestComment;
  if (spec.jobFee != null) product.jobFee = money(spec.jobFee);
  if (spec.managementFee != null) product.managementFee = money(spec.managementFee);
  if (Array.isArray(spec.notifyEmails) && spec.notifyEmails.length) {
    product.notifications = spec.notifyEmails.filter(Boolean).map((e) => ({ contactEmail: e }));
  }
  if (Array.isArray(spec.embeddedFiles) && spec.embeddedFiles.length) {
    product.embeddedFiles = spec.embeddedFiles.map(embeddedFile);
  }

  const deal = {};
  if (spec.amcIdentifier != null) deal.appraisers = [{ partyRoleType: 'AMC', identifier: String(spec.amcIdentifier) }];
  deal.borrowers = (spec.borrowers || []).map(borrower);

  const loan = { loanIdentifiers: { lenderLoanIdentifier: String(spec.loan && spec.loan.loanNumber || '') } };
  if (spec.loan) {
    if (spec.loan.lienPriority) loan.lienPriorityType = spec.loan.lienPriority;
    if (spec.loan.loanPurpose) loan.loanPurposeType = spec.loan.loanPurpose;
    if (spec.loan.mortgageType) loan.mortgageType = spec.loan.mortgageType;
    if (spec.loan.baseLoanAmount != null) loan.baseLoanAmount = money(spec.loan.baseLoanAmount);
    if (spec.loan.estimatedClosingDate) loan.estimatedClosingDate = spec.loan.estimatedClosingDate;
  }
  deal.loans = [loan];
  deal.properties = [property(spec.property || {})];

  const parties = [];
  const p = spec.parties || {};
  if (p.loanOfficerId != null) parties.push({ partyRoleType: 'LoanOfficer', partyRoleTypeIdentifier: String(p.loanOfficerId) });
  if (p.loanProcessorId != null) parties.push({ partyRoleType: 'LoanProcessor', partyRoleTypeIdentifier: String(p.loanProcessorId) });
  if (p.investorId != null) parties.push({ partyRoleType: 'Investor', partyRoleTypeIdentifier: String(p.investorId) });
  // AppraisalScope's REQUIRED `client_displayed_id` is the "Client Displayed on Report"
  // (the client/lender alias AppraisalScope prints ON the appraisal). The vendor mapping
  // carries it as a deal party partyRoleType="Lender" — the "Lender Alias (dba) Identifier"
  // in **partyRoleIdentifier** (NOT partyRoleTypeIdentifier, which the other parties use).
  // The gateway derives its snake_case client_displayed_id from this party, so with no
  // Lender party the order was rejected for a missing client_displayed_id. The id is the
  // tenant's own GetClientDisplayOnReport id, resolved in order-service (config override or
  // the account's single client-on-report profile).
  if (spec.clientDisplayedId != null && spec.clientDisplayedId !== '') {
    parties.push({ partyRoleType: 'Lender', partyRoleIdentifier: String(spec.clientDisplayedId) });
  }
  // Best-person-to-contact is REQUIRED, and AppraisalScope derives its own required
  // `primary_contact` from it. The vendor's mapping is exact: the selection goes in
  // parties[].partyRoleType="BestContact" → **partyRoleTypeOtherDescription** (an
  // enumeration: Borrower | Co-Borrower | Owner | Other | Realtor | Assistant | …), NOT
  // partyRoleTypeIdentifier. Emitting the wrong leaf left partyRoleTypeOtherDescription
  // empty, so the gateway couldn't tell WHO the best contact was and reported
  // primary_contact missing. The actual phone/email is NOT carried on this party — the
  // gateway reads it from the referenced party (for a borrower, the borrowers[] contacts
  // emitted above), exactly as the vendor's own CreateAppraisal sample does.
  if (p.bestContact) {
    parties.push({
      partyRoleType: 'BestContact',
      partyRoleTypeOtherDescription: bestContactDescription(p.bestContact, spec.primaryContact),
    });
  }
  if (parties.length) deal.parties = parties;

  const message = {
    clientSystem: clientSystem({
      apiKey,
      clientOrderNumber: spec.clientOrderNumber,
      clientReferenceNumber: spec.clientReferenceNumber,
      sourceClientId,
    }),
    digitalGatewaySystem: digitalGatewaySystem({ lenderIdentifier }),
    serviceProviderSystem: serviceProviderSystem({
      subdomain,
      // AddForm attaches to a parent order → carry its ServiceProviderOrderNumber.
      spOrderNumber: isAddForm ? spec.parentSpOrderNumber : undefined,
    }),
    requestActionType: isAddForm ? 'AddForm' : 'CreateAppraisal',
    products: [product],
    deals: [deal],
  };
  return { message };
}

// The BestContact selection → the vendor's enumeration for partyRoleTypeOtherDescription
// (Borrower | Co-Borrower | Owner | Other | Realtor | Assistant | Listing Agent | Selling
// Agent | See Additional Comments). The gateway reads primary_contact from whichever party
// this names, so it must name the borrower we actually resolved a reachable contact for:
// if order-build's reachable-fallback switched from the primary to the co-borrower, name
// 'Co-Borrower' so the gateway reads THAT borrower's contact. We only ever carry the
// borrowers' contacts, so a non-borrower selection still resolves to a borrower.
const BEST_CONTACT_ENUM = {
  borrower: 'Borrower', coborrower: 'Co-Borrower', owner: 'Owner', other: 'Other',
  realtor: 'Realtor', assistant: 'Assistant',
  listingagent: 'Listing Agent', sellingagent: 'Selling Agent', sellersagent: 'Selling Agent',
};
function bestContactDescription(bestContact, primaryContact) {
  const pc = primaryContact || {};
  if (pc.classification === 'Secondary') return 'Co-Borrower';
  if (pc.classification === 'Primary') return 'Borrower';
  const k = String(bestContact || '').toLowerCase().replace(/[^a-z]/g, '');
  return BEST_CONTACT_ENUM[k] || 'Borrower';
}

function borrower(b) {
  const out = { borrowerClassificationType: b.classification || 'Primary' };
  if (b.legalEntityName) out.legalEntityName = b.legalEntityName;
  if (b.firstName) out.firstName = b.firstName;
  if (b.middleName) out.middleName = b.middleName;
  if (b.lastName) out.lastName = b.lastName;
  if (b.fullName) out.fullName = b.fullName;
  if (Array.isArray(b.contacts) && b.contacts.length) {
    out.contacts = b.contacts.map((c) => {
      const cc = { contactType: c.type || 'Home' };
      if (c.email) cc.contactEmail = c.email;
      if (c.phone) cc.contactPhone = c.phone;
      return cc;
    });
  }
  if (b.residence) {
    out.residences = [{ borrowerResidencyType: 'Current', address: address(b.residence) }];
  }
  return out;
}

function property(pr) {
  const out = {};
  if (pr.titleCategory) out.titleCategoryType = pr.titleCategory;
  out.address = address(pr);
  if (pr.legalDescription) out.address.propertyLocationDescription = pr.legalDescription;
  if (pr.occupancy) out.propertyCurrentOccupancyType = pr.occupancy;
  // AppraisalScope's REQUIRED `purchase_amount` is derived from purchasePriceAmount (its
  // own mapping: "Required when Intended Use is Purchase"), NOT from salesContractAmount —
  // emitting only the latter is why the gateway rejected the order for a missing
  // purchase_amount. Emit both (the vendor's own sample carries both).
  if (pr.purchasePriceAmount != null) out.purchasePriceAmount = money(pr.purchasePriceAmount);
  if (pr.salesContractAmount != null) out.salesContractAmount = money(pr.salesContractAmount);
  if (pr.salesConcessionAmount != null) out.salesConcessionAmount = money(pr.salesConcessionAmount);
  if (pr.salesConcessionType) out.salesConcessionType = pr.salesConcessionType;
  if (Array.isArray(pr.viewTypeIds) && pr.viewTypeIds.length) {
    out.siteAnalysis = { propertyView: pr.viewTypeIds.map((id) => ({ propertyViewTypeIdentifier: String(id) })) };
  }
  return out;
}

function address(a) {
  const out = {};
  if (a.addressLine) out.addressLine = a.addressLine;
  if (a.addressLine2) out.addressLine2 = a.addressLine2;
  if (a.city) out.cityName = a.city;
  if (a.postalCode) out.postalCode = String(a.postalCode);
  if (a.state) out.stateCode = a.state;
  if (a.county) out.countyName = a.county;
  return out;
}

function embeddedFile(f) {
  const out = { objectURL: f.objectURL, objectName: f.objectName };
  if (f.documentType) out.documentType = f.documentType;
  if (f.objectDescription) out.objectDescription = f.objectDescription;
  if (f.documentEffectiveDate) out.documentEffectiveDate = f.documentEffectiveDate;
  return out;
}

// The ACK from CreateAppraisal / AddForm.
function parseAck(resp) {
  const m = (resp && resp.message) || {};
  const status = firstStatus(m.digitalGatewaySystem && m.digitalGatewaySystem.statusResponses);
  const deal = Array.isArray(m.deals) && m.deals[0];
  const prop = deal && Array.isArray(deal.properties) && deal.properties[0];
  const prod = Array.isArray(m.products) && m.products[0];
  return {
    cdgOrderNumber: refValue(m.digitalGatewaySystem && m.digitalGatewaySystem.referenceIdentifiers, 'DigitalGatewayOrderNumber'),
    spOrderNumber: refValue(m.serviceProviderSystem && m.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderOrderNumber'),
    appraisalFileNumber: prop && prop.appraisalIdentifier,
    productDescription: prod && prod.productDescription,
    statusCode: status && status.statusCode,
    statusName: status && status.statusName,
    statusCondition: status && status.statusCondition,
    statusDescription: status && status.statusDescription,
  };
}

// ---- comments (two-way thread) --------------------------------------------
function buildAddComment({ apiKey, subdomain, spOrderNumber, clientOrderNumber, text }) {
  return {
    message: {
      clientSystem: clientSystem({ apiKey, clientOrderNumber }),
      products: { requestCommentText: text },
      serviceProviderSystem: serviceProviderSystem({ subdomain, spOrderNumber }),
      requestActionType: 'AddComment',
    },
  };
}
// ---- cancel an order -------------------------------------------------------
// AppraisalScope initiates a cancellation with a requestActionType action carrying the
// reason as a comment (the AddComment shape). The EXACT action name is NOT confirmed
// from the repo/docs, so it is env-overridable (AMC_CANCEL_ACTION, default 'CancelOrder')
// and MUST be verified against the live tenant before enabling outbound — the same
// dry-run-first posture the flood-order contract carries. Asking is not agreeing: the
// order only moves to 'cancelled' when the vendor's own status callback returns
// Cancellation (1051), which mapStatusToLifecycle already handles.
function buildCancelOrder({ apiKey, subdomain, spOrderNumber, clientOrderNumber, text, action }) {
  return {
    message: {
      clientSystem: clientSystem({ apiKey, clientOrderNumber }),
      products: { requestCommentText: text },
      serviceProviderSystem: serviceProviderSystem({ subdomain, spOrderNumber }),
      requestActionType: action || process.env.AMC_CANCEL_ACTION || 'CancelOrder',
    },
  };
}
function buildGetComments(ctx) { return orderLookup('GetComments', ctx); }
function parseComments(resp) {
  const products = resp && resp.message && resp.message.products;
  if (!Array.isArray(products)) return [];
  return products
    .filter((c) => c && (c.commentId != null || c.requestCommentText != null))
    .map((c) => ({
      amcCommentId: c.commentId != null ? String(c.commentId) : null,
      body: c.requestCommentText || '',
      authorName: c.requestCommentContactFullName || null,
      amcDatetime: c.requestCommentTextDatetime || null,
    }));
}

// ---- revisions (general / ROV / SOW-change) --------------------------------
function buildAddRevision({ apiKey, subdomain, spOrderNumber, clientOrderNumber, text }) {
  return {
    message: {
      clientSystem: clientSystem({ apiKey, clientOrderNumber }),
      products: { revisedRequestCommentText: text },
      serviceProviderSystem: serviceProviderSystem({ subdomain, spOrderNumber }),
      requestActionType: 'AddRevision',
    },
  };
}
function parseRevisionAck(resp) {
  const products = resp && resp.message && resp.message.products;
  const first = Array.isArray(products) ? products[0] : products;
  return { amcRevisionId: first && first.revisionId != null ? String(first.revisionId) : null };
}
function buildGetRevisions(ctx) { return orderLookup('GetRevisions', ctx); }
function parseRevisions(resp) {
  const products = resp && resp.message && resp.message.products;
  if (!Array.isArray(products)) return [];
  return products.map((r) => ({ amcRevisionId: r && r.revisionId != null ? String(r.revisionId) : null, raw: r }));
}

// ---- documents -------------------------------------------------------------
// UploadDocument / UploadDocumentMulti / UploadContract — the embedded files carry
// getdocument URLs already obtained from /postdocuments.
function buildUploadDocuments({ action, apiKey, subdomain, spOrderNumber, clientOrderNumber, documents }) {
  return {
    message: {
      clientSystem: clientSystem({ apiKey, clientOrderNumber }),
      products: [{ embeddedFiles: (documents || []).map(embeddedFile) }],
      serviceProviderSystem: serviceProviderSystem({ subdomain, spOrderNumber }),
      requestActionType: action || 'UploadDocument',
    },
  };
}
// RetriveAppraisalDocuments — retrieveAdditionalDocuments=1 includes additional docs.
function buildRetrieveDocuments({ apiKey, subdomain, spOrderNumber, clientOrderNumber, includeAdditional }) {
  const message = {
    clientSystem: clientSystem({ apiKey, clientOrderNumber }),
    serviceProviderSystem: serviceProviderSystem({ subdomain, spOrderNumber }),
    requestActionType: 'RetriveAppraisalDocuments',
  };
  message.searchCriteria = [{ fieldName: 'retrieveAdditionalDocuments', fieldValue: includeAdditional ? '1' : '0' }];
  return { message };
}
function parseDocuments(resp) {
  const deals = resp && resp.message && resp.message.deals;
  const files = Array.isArray(deals) && deals[0] && deals[0].embeddedFiles;
  if (!Array.isArray(files)) return [];
  return files.filter(Boolean).map((f) => ({
    amcDocumentId: f.documentId != null ? String(f.documentId) : null,
    documentType: f.documentType || null,
    objectName: f.objectName || null,
    objectDescription: f.objectDescription || null,
    objectUrl: f.objectURL || null,
    objectSize: f.objectSize != null ? String(f.objectSize) : null,
    createdDatetime: f.createdDatetime || null,
    isAdditional: String(f.isAdditionalDocument) === '1',
    raw: f,
  }));
}

// ---- status ----------------------------------------------------------------
function buildGetStatus(ctx) { return orderLookup('GetAppraisalStatus', ctx); }
function buildGetDetail(ctx) { return orderLookup('GetAppraisalDetail', ctx); }
// The product-level status is the true order status; the top-level one is just the ACK.
function parseStatus(resp) {
  const m = (resp && resp.message) || {};
  const prod = Array.isArray(m.products) && m.products[0];
  const st = prod && firstStatus(prod.statusResponses);
  const ack = firstStatus(m.digitalGatewaySystem && m.digitalGatewaySystem.statusResponses);
  const chosen = st || ack || null;
  return chosen && {
    statusCode: chosen.statusCode != null ? String(chosen.statusCode) : null,
    statusName: chosen.statusName || null,
    statusCondition: chosen.statusCondition || null,
    statusDescription: chosen.statusDescription || null,
  };
}

// A generic order-specific lookup envelope (Get*/Retrive*): api key + subdomain + SP order #.
function orderLookup(actionType, { apiKey, subdomain, spOrderNumber, clientOrderNumber } = {}) {
  return {
    message: {
      clientSystem: clientSystem({ apiKey, clientOrderNumber }),
      serviceProviderSystem: serviceProviderSystem({ subdomain, spOrderNumber }),
      requestActionType: actionType,
    },
  };
}

// ---- shared helpers --------------------------------------------------------
function firstStatus(arr) { return Array.isArray(arr) && arr.length ? arr[0] : null; }
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}

// A NACK / error carried in either the top-level or product status responses.
// statusCondition 'Nack'/'Failure'/'ERROR' (or a negative code) means the call failed.
function parseError(resp) {
  const m = (resp && resp.message) || {};
  const st = firstStatus(m.digitalGatewaySystem && m.digitalGatewaySystem.statusResponses)
          || firstStatus(m.statusResponses);
  if (!st) return null;
  const cond = String(st.statusCondition || '').toLowerCase();
  const code = Number(st.statusCode);
  const isError = cond === 'nack' || cond === 'failure' || cond === 'error' || (Number.isFinite(code) && code < 0);
  if (!isError) return null;
  return {
    code: st.statusCode != null ? String(st.statusCode) : null,
    name: st.statusName || null,
    description: st.statusDescription || null,
  };
}

// Map a CDG/AppraisalScope status (code + name) to PILOT's amc_orders.status lifecycle.
// Codes/names are from the vendor status-code mapping (docs/AMC-APPRAISALSCOPE-INTEGRATION.md).
function mapStatusToLifecycle(statusCode, statusName) {
  const name = String(statusName || '').toLowerCase();
  const code = String(statusCode == null ? '' : statusCode);
  if (/productavailable/.test(name) || code === '1990') return 'product_available';
  if (/complete/.test(name) || code === '1999') return 'completed';
  if (/cancel/.test(name) || code === '1051') return 'cancelled';
  if (/reject|declined/.test(name) || code === '-1007' || code === '1201') return 'rejected';
  if (/sethold/.test(name) || code === '1001') return 'on_hold';
  if (/setoffhold/.test(name) || code === '1002') return 'in_process';
  if (/inreview|withreview/.test(name) || code === '1105') return 'in_review';
  if (/submittedtoamc|inspected/.test(name) || code === '1056' || code === '1054') return 'inspected';
  if (/assignedtoappraiser/.test(name) || code === '1200') return 'assigned';
  if (/orderreceived|orderinprocess|activated/.test(name) || code === '1010' || code === '1102') return 'in_process';
  return null; // unknown → leave the current status unchanged
}

// Mask a request message for the write journal — never persist the api key.
function maskRequest(message) {
  try {
    const clone = JSON.parse(JSON.stringify(message));
    const refs = clone && clone.message && clone.message.clientSystem && clone.message.clientSystem.referenceIdentifiers;
    if (Array.isArray(refs)) for (const r of refs) if (r && r.referenceIdentifierType === 'ApiKey') r.referenceIdentifierValue = '***';
    const creds = clone && clone.message && clone.message.clientSystem && clone.message.clientSystem.credentials;
    if (Array.isArray(creds)) for (const c of creds) { if (c) c.loginAccountPassword = '***'; }
    return clone;
  } catch { return { masked: true }; }
}

module.exports = {
  ref, refValue,
  buildDoLogin, parseDoLogin,
  buildLookup, parseLookup,
  buildCreateAppraisal, parseAck,
  buildAddComment, buildCancelOrder, buildGetComments, parseComments,
  buildAddRevision, parseRevisionAck, buildGetRevisions, parseRevisions,
  buildUploadDocuments, buildRetrieveDocuments, parseDocuments,
  buildGetStatus, buildGetDetail, parseStatus,
  parseError, mapStatusToLifecycle, maskRequest,
  // exported for tests
  _internals: { clientSystem, serviceProviderSystem, digitalGatewaySystem, borrower, property, address, orderLookup },
};

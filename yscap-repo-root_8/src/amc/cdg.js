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
// sourceInformation.sourceClientIdentifier is AppraisalScope's REQUIRED `client_displayed_id`
// (the "Client Displayed on Report" id from GetClientDisplayOnReport); sourceClientName is the
// matching name (the vendor's ClientDisplayedGetJobType sample carries both).
function clientSystem({ apiKey, clientOrderNumber, clientReferenceNumber, sourceClientId, sourceClientName } = {}) {
  const refs = [];
  if (apiKey != null) refs.push(ref('ApiKey', apiKey));
  if (clientOrderNumber != null) refs.push(ref('ClientOrderNumber', String(clientOrderNumber)));
  if (clientReferenceNumber != null) refs.push(ref('ClientReferenceNumber', String(clientReferenceNumber)));
  const cs = { referenceIdentifiers: refs };
  const hasId = sourceClientId != null && sourceClientId !== '';
  const hasName = sourceClientName != null && sourceClientName !== '';
  if (hasId || hasName) {
    cs.sourceInformation = {};
    if (hasId) cs.sourceInformation.sourceClientIdentifier = String(sourceClientId);
    if (hasName) cs.sourceInformation.sourceClientName = String(sourceClientName);
  }
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
/* ---- WHAT WILL THIS APPRAISAL COST? ---------------------------------------
 *
 * Two lookups answer it, and they answer DIFFERENT questions — which is why both
 * are built here rather than one being treated as the fee:
 *
 *   GetFee                      what the FORM costs on this account
 *   GetAppraiserFeesByLocation  what appraisers charge WHERE the property is
 *
 * A 1004 is not one price nationally, so the account's list price and the local
 * market rate are both worth showing to somebody about to place the order — and
 * neither was being asked for, so the price was a surprise on the invoice.
 *
 * BOTH ARE READS. They are catalog lookups (the `/direct/` endpoint, `client.lookup`),
 * never the write gate, so quoting a fee can never place or change an order.
 *
 * THE PRODUCT-CODE FIELD NAME IS SENT TWO WAYS, DELIBERATELY. The vendor's own
 * guide writes `products[].productcode` (lower-case 'c') for the two sibling
 * actions that take a job type — GetJobTypeAddOns and CheckFHA — while every
 * other product field in this file is `productCode`. Which one GetFee wants is
 * NOT confirmed against a live tenant, and an unknown field is ignored by this
 * gateway while a MISSING one produces an empty answer nobody can interpret. So
 * both spellings carry the same value: whichever they read, they get the right
 * one. Drop the other once a live call proves which it is.
 */
function buildGetFee({ apiKey, subdomain, productCode }) {
  const p = {};
  if (productCode != null && productCode !== '') { p.productCode = String(productCode); p.productcode = String(productCode); }
  return {
    message: {
      clientSystem: clientSystem({ apiKey }),
      serviceProviderSystem: serviceProviderSystem({ subdomain }),
      products: [p],
      requestActionType: 'GetFee',
    },
  };
}

/** Appraiser fees where the property is. The vendor's shape, verbatim:
 *  `deals[].properties[].address.{stateCode, zip}`. Rows come back as
 *  `{job_type, user_type, fee, user}`. */
function buildAppraiserFeesByLocation({ apiKey, subdomain, stateCode, zip }) {
  const address = {};
  if (stateCode) address.stateCode = String(stateCode).toUpperCase().slice(0, 2);
  if (zip) address.zip = String(zip).replace(/[^0-9-]/g, '').slice(0, 10);
  return {
    message: {
      clientSystem: clientSystem({ apiKey }),
      serviceProviderSystem: serviceProviderSystem({ subdomain }),
      deals: [{ properties: [{ address }] }],
      requestActionType: 'GetAppraiserFeesByLocation',
    },
  };
}

/** What payment methods this account is allowed to use. A pure READ — it charges
 *  nothing and authorises nothing; it is how the desk can say which of the
 *  vendor's payment routes are even open to us before anybody decides to use one.
 *  Response carries `paymentFormAvailable` plus a list of `{id,name}`. */
function buildGetPaymentOptions({ apiKey, subdomain }) {
  return {
    message: {
      clientSystem: clientSystem({ apiKey }),
      serviceProviderSystem: serviceProviderSystem({ subdomain }),
      requestActionType: 'GetPaymentOptions',
    },
  };
}

// ---- payment ---------------------------------------------------------------
/**
 * THE CARD BLOCK — one shape, built once, used by every request that carries a card.
 *
 * EVERY FIELD NAME BELOW IS COPIED FROM THE VENDOR'S OWN SAMPLES, which are in this
 * repository at `docs/vendor/appraisalscope/samples/Orders/`. Nothing here is
 * inferred from a field's name or from how another gateway does it: a wrong guess
 * at a money endpoint is the most expensive kind of wrong in this codebase, and
 * "the field is probably called X" is exactly how a charge silently posts against
 * the wrong card or the wrong order.
 *
 * `PaymentAuthCapture`, `PaymentToCaptureLeter` and `PartialPayment` all carry this
 * identical block; they differ only in `requestActionType` and, for PartialPayment,
 * an added `paymentTotalAmount`. That is why it is one function.
 *
 * THREE THINGS THE SAMPLES SAY THAT THE FIELD NAMES DO NOT:
 *   1. `paymentReferenceIdentifier` is OURS to generate. It is not something the
 *      vendor hands back first — it is the handle we and they use for this payment,
 *      and it is what a later `PaymentCapture` is addressed to.
 *   2. There is NO AMOUNT on an auth-capture. The vendor's own guide says it
 *      "authorizes and charges a credit card for the full payment amount" — the fee
 *      already agreed on the order. Sending a number would be us choosing the price.
 *      `PartialPayment` is the request that takes an amount, and it is a different
 *      action for a different purpose.
 *   3. The security code IS required on an auth-capture. The later `PaymentCapture`
 *      — against a card their PCI vault already holds — takes only the reference and
 *      the cardholder's email, and needs neither the number nor the code.
 *
 * The vendor's samples spell the country two ways ("US" in one, "United States" in
 * another) and the expiry year two ways ("2022" and "22"). We send the four-digit
 * year, which is unambiguous and appears in the auth-capture sample itself, and
 * whatever country the caller passes, defaulting to the sample's "United States".
 */
function paymentAccount(p = {}) {
  const out = {};
  const put = (k, v) => { if (v != null && String(v) !== '') out[k] = String(v); };
  put('paymentReferenceIdentifier', p.referenceId);
  put('paymentAccountCardHolderFirstName', p.firstName);
  put('paymentAccountCardHolderLastName', p.lastName);
  put('paymentAccountCardHolderAddress1', p.address1);
  put('paymentAccountCardHolderAddress2', p.address2);
  put('paymentAccountCardHolderCity', p.city);
  put('paymentAccountCardHolderState', p.state ? String(p.state).toUpperCase().slice(0, 2) : null);
  put('paymentAccountCardHolderPostalCode', p.postalCode);
  put('paymentAccountCardHolderCountry', p.country || 'United States');
  put('paymentAccountCardHolderPhone', p.phone);
  put('paymentAccountCardHolderEmail', p.email);
  // The card itself. Digits only — a number typed with spaces or dashes is the
  // same card, and sending the punctuation is a needless way to be refused.
  if (p.cardNumber) out.paymentAccountIdentifier = String(p.cardNumber).replace(/\D/g, '');
  if (p.securityCode) out.paymentAccountCardSecurityCode = String(p.securityCode).replace(/\D/g, '');
  if (p.expMonth != null && p.expMonth !== '') {
    out.paymentAccountCardExpirationMonth = String(parseInt(p.expMonth, 10)).padStart(2, '0');
  }
  if (p.expYear != null && p.expYear !== '') {
    const y = parseInt(p.expYear, 10);
    out.paymentAccountCardExpirationYear = String(y < 100 ? 2000 + y : y);
  }
  return out;
}

/**
 * CHARGE THE CARD, IN FULL, NOW. The vendor's own words for this action:
 * *"Authorizes and charges a credit card for the full payment amount."*
 *
 * A successful response carries the receipt at
 * `message.products[0].payments[0].paymentTransactionId` — read it with
 * `parsePaymentTransactionId`, and record it, because it is the only handle
 * anybody has afterwards for the money that moved.
 */
function buildPaymentAuthCapture({ apiKey, subdomain, clientOrderNumber, spOrderNumber, payment }) {
  return {
    message: {
      clientSystem: clientSystem({ apiKey, clientOrderNumber }),
      products: [{ payments: [paymentAccount(payment)] }],
      serviceProviderSystem: serviceProviderSystem({ subdomain, spOrderNumber }),
      requestActionType: 'PaymentAuthCapture',
    },
  };
}

/**
 * VAULT THE CARD WITHOUT CHARGING IT. Their words: *"Saves payment details on the
 * authorize.net PCI compliance server, but does not apply the charge until the
 * PaymentCapture request is made."* Same block as the charge; only the action
 * differs. The response carries no transaction id, because nothing was charged.
 */
function buildPaymentToCaptureLater({ apiKey, subdomain, clientOrderNumber, spOrderNumber, payment }) {
  return {
    message: {
      clientSystem: clientSystem({ apiKey, clientOrderNumber }),
      products: [{ payments: [paymentAccount(payment)] }],
      serviceProviderSystem: serviceProviderSystem({ subdomain, spOrderNumber }),
      // The vendor spells it "Leter". That is their spelling, on the wire, and
      // correcting it here would simply make the request unrecognised.
      requestActionType: 'PaymentToCaptureLeter',
    },
  };
}

/**
 * CHARGE A CARD THEY ALREADY HOLD. Addressed by the SAME
 * `paymentReferenceIdentifier` the vault call used, plus the cardholder's email —
 * and NOTHING ELSE. No card number, no security code: that is the entire point of
 * having vaulted it, and sending them again would defeat it.
 */
function buildPaymentCapture({ apiKey, subdomain, clientOrderNumber, spOrderNumber, referenceId, email }) {
  const pay = {};
  if (referenceId != null) pay.paymentReferenceIdentifier = String(referenceId);
  if (email) pay.paymentAccountCardHolderEmail = String(email);
  return {
    message: {
      clientSystem: clientSystem({ apiKey, clientOrderNumber }),
      products: [{ payments: [pay] }],
      serviceProviderSystem: serviceProviderSystem({ subdomain, spOrderNumber }),
      requestActionType: 'PaymentCapture',
    },
  };
}

/**
 * EMAIL SOMEBODY THE INVOICE FOR THIS ORDER — the vendor's own payment page, sent
 * to an address we name. Their words: *"Sends an appraisal order invoice to a
 * specified email address."*
 *
 * ONE ADDRESS PER CALL, DELIBERATELY. The sample carries a `notifications` ARRAY
 * with a single `{contactEmail}` in it, and the plural reads as though several
 * entries would each be mailed — but that is an inference, and a vendor that only
 * ever reads `notifications[0]` would leave the second person silently un-invoiced
 * with a success answer in our hand. So a caller that wants two people invoiced
 * sends two calls, which is correct under either reading. `src/amc/payment.js`
 * does exactly that for the borrower and the loan officer.
 */
function buildSendInvoice({ apiKey, subdomain, clientOrderNumber, spOrderNumber, email }) {
  return {
    message: {
      clientSystem: clientSystem({ apiKey, clientOrderNumber }),
      serviceProviderSystem: serviceProviderSystem({ subdomain, spOrderNumber }),
      products: [{ notifications: [{ contactEmail: String(email || '') }] }],
      requestActionType: 'SendInvoice',
    },
  };
}

/**
 * The receipt for money that moved, or null. Both `PaymentAuthCapture` and
 * `PaymentCapture` answer with it in the same place.
 *
 * Returns null rather than throwing on any shape it does not recognise — the
 * CALLER decides what an unreadable answer means, and for a payment that decision
 * is "we do not know whether it went through", never "it failed".
 */
function parsePaymentTransactionId(resp) {
  const products = resp && resp.message && resp.message.products;
  if (!Array.isArray(products)) return null;
  for (const p of products) {
    const payments = p && p.payments;
    if (!Array.isArray(payments)) continue;
    for (const pay of payments) {
      if (pay && pay.paymentTransactionId != null && String(pay.paymentTransactionId) !== '') {
        return String(pay.paymentTransactionId);
      }
    }
  }
  return null;
}

// ---- GetAppraisalDetail ----------------------------------------------------
/**
 * WHO IS DOING IT, WHEN THEY ARE GOING OUT, AND WHAT IT COSTS.
 *
 * `GetAppraisalStatus` answers only "what stage is it at" — a code and a name.
 * Everything a person actually asks while an appraisal is pending lives in
 * `GetAppraisalDetail` and was being thrown away: `buildGetDetail` has been
 * exported since this integration shipped with ZERO callers, so the appraiser's
 * name, the inspection date and the vendor's own due date were never once read.
 *
 * THE SENTINELS ARE THE WHOLE DIFFICULTY, and they are visible in the vendor's own
 * sample (docs/vendor/appraisalscope/samples/Orders/): an unset value comes back as
 * the STRING `"N/A"`, or the STRING `"null"` (not JSON null), or `""`. A naive read
 * stores the literal text "N/A" as an inspection date and the screen then tells
 * somebody the inspection is booked. So every field goes through `detailText`,
 * which answers null for all of them.
 *
 * MONEY IS THE EXCEPTION AND MUST NOT BE SWEPT UP WITH THEM: `"0.00"` is a real
 * figure. `paidAmount: "0.00"` beside `dueAmount: "450.00"` means nothing has been
 * paid yet, which is a fact worth showing, not an absence.
 *
 * THE DATETIMES ARE KEPT VERBATIM, ON PURPOSE. The vendor sends
 * `"2021-05-07 16:58:19"` with no timezone anywhere in the payload or the guide,
 * and their `lastUpdateDatetime` is a third format again
 * (`"05/07/2021 04:58:19 pm"`). Reading a zone into them would be a guess printed
 * as a fact — the class of bug this repository has been bitten by more than once —
 * so they are stored as text and shown as the vendor stated them. Only the
 * DATE-ONLY fields (`YYYY-MM-DD`, unambiguous in any zone) become real dates.
 */
const DETAIL_SENTINELS = new Set(['', 'n/a', 'na', 'null', 'undefined', 'none', '-']);
function detailText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || DETAIL_SENTINELS.has(s.toLowerCase())) return null;
  return s;
}
/** A date-only value we can trust in any timezone, or null. */
function detailDate(v) {
  const s = detailText(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
/** A money figure. `"0.00"` is REAL and must survive; a sentinel is null. */
function detailMoney(v) {
  const s = detailText(v);
  if (s == null) return null;
  const n = Number(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Everything the detail call tells us about ONE order, flattened.
 *
 * Returns null when the response carries no product block at all — the caller
 * treats that as "the vendor said nothing", never as "there is no appraiser".
 * NEVER throws: this runs inside a poll, and a malformed answer must cost one
 * order's detail, not the whole sweep.
 */
function parseDetail(resp) {
  try {
    const m = (resp && resp.message) || {};
    const p = Array.isArray(m.products) && m.products[0] ? m.products[0] : null;
    const deal = Array.isArray(m.deals) && m.deals[0] ? m.deals[0] : null;
    if (!p && !deal) return null;

    // THE APPRAISER, not the AMC. Both ride in the same array under different
    // `partyRoleType`s, and the AMC is the management company — telling a loan
    // officer that "Appraisal Management Company Name" is inspecting their
    // property would be worse than telling them nothing.
    const parties = (deal && Array.isArray(deal.appraisers)) ? deal.appraisers : [];
    const role = (t) => parties.find((a) => a && String(a.partyRoleType || '').toLowerCase() === t) || null;
    const appraiser = role('appraiser');
    const amc = role('amc');

    const out = {
      appraiser: {
        name: appraiser ? detailText(appraiser.fullName) : null,
        company: appraiser ? detailText(appraiser.companyName) : null,
        email: appraiser ? detailText(appraiser.contactEmail) : null,
        phone: appraiser ? detailText(appraiser.contactPhone) : null,
        city: appraiser ? detailText(appraiser.companyAddressCity) : null,
        state: appraiser ? detailText(appraiser.companyAddressState) : null,
        license: appraiser ? detailText(appraiser.appraiserlicenseIdentifier) : null,
      },
      amc: {
        company: amc ? detailText(amc.companyName) : null,
        license: amc ? detailText(amc.appraiserlicenseIdentifier) : null,
        fileNumber: amc ? detailText(amc.assignedAMCFileNumber) : null,
      },
      // WHEN. `serviceNeedByDate` is the vendor's own due date — the ETA a person
      // is really asking for — and the inspection trio is the rest of the answer.
      dueDate: p ? detailDate(p.serviceNeedByDate) : null,
      completedDate: p ? detailDate(p.completedDate) : null,
      inspectionDate: p ? detailDate(p.inspectionDate) : null,
      assignedAt: p ? detailText(p.assignedDatetime) : null,
      acceptedAt: p ? detailText(p.acceptedDatetime) : null,
      inspectionScheduledAt: p ? detailText(p.inspectionScheduledDatetime) : null,
      inspectionCompletedAt: p ? detailText(p.inspectionCompleteDatetime) : null,
      reportUploadedAt: p ? detailText(p.appraisalUploadDatetime) : null,
      lastUpdateAt: p ? detailText(p.lastUpdateDatetime) : null,
      // WHAT IT COSTS, and what is still owed. The order row has carried no fee
      // since this integration shipped, so the desk answered "no per-order fee"
      // for AppraisalScope while the vendor was stating four of them.
      clientFee: p ? detailMoney(p.clientFee) : null,
      formFee: p ? detailMoney(p.formFee) : null,
      jobFee: p ? detailMoney(p.jobFee) : null,
      managementFee: p ? detailMoney(p.managementFee) : null,
      dueAmount: p ? detailMoney(p.dueAmount) : null,
      paidAmount: p ? detailMoney(p.paidAmount) : null,
      invoicedAmount: p ? detailMoney(p.invoicedAmount) : null,
      productDescription: p ? detailText(p.productDescription) : null,
    };
    return out;
  } catch (_) { return null; }
}

/** Search the account's OWN orders, so an appraisal somebody placed on the
 *  vendor's website can be found and reconciled. `criteria` is their
 *  `searchCriteria[]` of `{fieldName, fieldValue}` (create_date_start,
 *  create_date_end, status); `loanNumber` narrows to one loan. READ ONLY. */
function buildGetAppraisals({ apiKey, subdomain, loanNumber, criteria }) {
  const message = {
    clientSystem: clientSystem({ apiKey }),
    serviceProviderSystem: serviceProviderSystem({ subdomain }),
    requestActionType: 'GetAppraisals',
  };
  if (loanNumber) {
    message.deals = [{ loans: [{ loanIdentifiers: { lenderLoanIdentifier: String(loanNumber) } }] }];
  }
  const list = (Array.isArray(criteria) ? criteria : [])
    .filter((c) => c && c.fieldName && c.fieldValue != null)
    .map((c) => ({ fieldName: String(c.fieldName), fieldValue: String(c.fieldValue) }));
  if (list.length) message.searchCriteria = list;
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

  // The resolved "Client Displayed on Report" id/name (AppraisalScope's REQUIRED
  // client_displayed_id). The spec's resolved id wins; the config AMC_SOURCE_CLIENT_ID is a
  // fallback. The SAME value is sent BOTH ways below so the order is satisfied whichever the
  // gateway reads it from.
  const cdId = (spec.clientDisplayedId != null && spec.clientDisplayedId !== '')
    ? String(spec.clientDisplayedId)
    : (sourceClientId != null && sourceClientId !== '' ? String(sourceClientId) : null);
  const cdName = (spec.clientDisplayedName != null && spec.clientDisplayedName !== '')
    ? String(spec.clientDisplayedName) : null;

  const parties = [];
  const p = spec.parties || {};
  if (p.loanOfficerId != null) parties.push({ partyRoleType: 'LoanOfficer', partyRoleTypeIdentifier: String(p.loanOfficerId) });
  if (p.loanProcessorId != null) parties.push({ partyRoleType: 'LoanProcessor', partyRoleTypeIdentifier: String(p.loanProcessorId) });
  if (p.investorId != null) parties.push({ partyRoleType: 'Investor', partyRoleTypeIdentifier: String(p.investorId) });
  // AppraisalScope's REQUIRED `client_displayed_id` (the "Client Displayed on Report") is sent
  // TWO ways with the SAME value: (1) on message.clientSystem.sourceInformation.sourceClientIdentifier
  // (the id from the account's GetClientDisplayOnReport list, e.g. 199384), emitted in the
  // clientSystem() call below; AND (2) here, on a partyRoleType="Lender" party whose
  // partyRoleIdentifier the gateway maps to client_displayed_id (fullNameAddress = the client
  // name). Belt-and-suspenders — the gateway reads it from either, and the value matches. A
  // numeric id is REQUIRED (a name alone cannot satisfy the gateway), so a Lender party is
  // emitted only when an id resolved. order-service resolves WHICH id (config AMC_CLIENT_DISPLAYED_ID,
  // else the account's profile matched to the default name "YS Capital Group").
  if (cdId) {
    const lender = { partyRoleType: 'Lender', partyRoleIdentifier: cdId };
    if (cdName) lender.fullNameAddress = cdName;
    parties.push(lender);
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
      // AppraisalScope's REQUIRED client_displayed_id ← sourceClientIdentifier — the SAME
      // resolved id also sent on the Lender party above (cdId/cdName). The name rides along as
      // sourceClientName (the vendor's ClientDisplayedGetJobType sample sends both).
      sourceClientId: cdId,
      sourceClientName: cdName,
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

/**
 * Mask a request message for the write journal — never persist the api key, and
 * NEVER a card.
 *
 * THE CARD HALF IS A CORRECTNESS REQUIREMENT, NOT TIDINESS. Everything built here
 * is journaled (`amc_write_log` via `order-service.js`) and logged on a dry run, so
 * the moment a payment request existed, the card number and the security code
 * became things this function is the only thing standing between and permanent
 * storage in our own database. The security code is dropped ENTIRELY rather than
 * partially shown: there is no such thing as a safe fragment of a three-digit
 * number, and the last four digits of a card are already recorded elsewhere in
 * plain sight, so the number keeps its last four and nothing else.
 *
 * It is a DENYLIST of the two fields that carry a secret rather than an allowlist
 * of everything else, because the journal's whole value is being able to read back
 * what we sent — an allowlist would quietly hollow out every future request shape.
 * A field added later that carries a secret must be added here in the same commit;
 * `scripts/test-amc-payment-pure.js` asserts no built payment request survives
 * masking with its number or code intact.
 */
function maskRequest(message) {
  try {
    const clone = JSON.parse(JSON.stringify(message));
    const refs = clone && clone.message && clone.message.clientSystem && clone.message.clientSystem.referenceIdentifiers;
    if (Array.isArray(refs)) for (const r of refs) if (r && r.referenceIdentifierType === 'ApiKey') r.referenceIdentifierValue = '***';
    const creds = clone && clone.message && clone.message.clientSystem && clone.message.clientSystem.credentials;
    if (Array.isArray(creds)) for (const c of creds) { if (c) c.loginAccountPassword = '***'; }
    const products = clone && clone.message && clone.message.products;
    if (Array.isArray(products)) {
      for (const p of products) {
        const payments = p && p.payments;
        if (!Array.isArray(payments)) continue;
        for (const pay of payments) {
          if (!pay) continue;
          if (pay.paymentAccountIdentifier != null) {
            const digits = String(pay.paymentAccountIdentifier).replace(/\D/g, '');
            pay.paymentAccountIdentifier = digits ? `****${digits.slice(-4)}` : '***';
          }
          if (pay.paymentAccountCardSecurityCode != null) pay.paymentAccountCardSecurityCode = '***';
        }
      }
    }
    return clone;
  } catch { return { masked: true }; }
}

module.exports = {
  ref, refValue,
  buildDoLogin, parseDoLogin,
  buildLookup, parseLookup,
  buildGetFee, buildAppraiserFeesByLocation, buildGetPaymentOptions, buildGetAppraisals,
  buildPaymentAuthCapture, buildPaymentToCaptureLater, buildPaymentCapture, buildSendInvoice,
  parsePaymentTransactionId,
  buildCreateAppraisal, parseAck,
  buildAddComment, buildCancelOrder, buildGetComments, parseComments,
  buildAddRevision, parseRevisionAck, buildGetRevisions, parseRevisions,
  buildUploadDocuments, buildRetrieveDocuments, parseDocuments,
  buildGetStatus, buildGetDetail, parseStatus, parseDetail,
  parseError, mapStatusToLifecycle, maskRequest,
  // exported for tests
  _internals: { clientSystem, serviceProviderSystem, digitalGatewaySystem, borrower, property, address, orderLookup, paymentAccount, detailText, detailDate, detailMoney },
};

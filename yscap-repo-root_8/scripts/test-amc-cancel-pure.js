'use strict';
/**
 * Pure test for the NAN (AMC / AppraisalScope) cancel envelope + the auto-filled
 * assumptions — no DB, no network.
 *
 * Locks in: cdg.buildCancelOrder's envelope (the AddComment shape, the reason carried
 * as requestCommentText, the SP order number + client order number identifiers, the
 * env-overridable action name, and the api key masked out of the journal); and
 * order-build.orderAssumptions (the defaults / rule-picked form / derived mapping it
 * reports, and that a staff override or a real file value suppresses the assumption).
 */
const cdg = require('../src/amc/cdg');
const orderBuild = require('../src/amc/order-build');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---- buildCancelOrder envelope --------------------------------------------
(() => {
  const m = cdg.buildCancelOrder({ apiKey: 'KEY123', subdomain: 'integrations.uat', spOrderNumber: 'SP-9', clientOrderNumber: 'YSCAP1', text: 'borrower withdrew' });
  eq(m.message.requestActionType, 'CancelOrder', 'default cancel action is CancelOrder');
  eq(m.message.products.requestCommentText, 'borrower withdrew', 'the reason rides as requestCommentText (AddComment shape)');
  eq(cdg.refValue(m.message.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderOrderNumber'), 'SP-9', 'the SP order number is on the envelope');
  eq(cdg.refValue(m.message.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderSubDomain'), 'integrations.uat', 'the subdomain is on the envelope');
  eq(cdg.refValue(m.message.clientSystem.referenceIdentifiers, 'ClientOrderNumber'), 'YSCAP1', 'the client order number is on the envelope');
  eq(cdg.refValue(m.message.clientSystem.referenceIdentifiers, 'ApiKey'), 'KEY123', 'the api key is on the LIVE envelope');
})();

// ---- the action name is env-overridable AND param-overridable --------------
(() => {
  process.env.AMC_CANCEL_ACTION = 'WithdrawOrder';
  const m = cdg.buildCancelOrder({ apiKey: 'K', subdomain: 's', spOrderNumber: '1', clientOrderNumber: '1', text: 'x' });
  eq(m.message.requestActionType, 'WithdrawOrder', 'AMC_CANCEL_ACTION overrides the action name (dial the exact CDG action live)');
  delete process.env.AMC_CANCEL_ACTION;
  const m2 = cdg.buildCancelOrder({ apiKey: 'K', subdomain: 's', spOrderNumber: '1', clientOrderNumber: '1', text: 'x', action: 'CancelAppraisal' });
  eq(m2.message.requestActionType, 'CancelAppraisal', 'an explicit action param wins');
})();

// ---- the api key is masked out of the journal ------------------------------
(() => {
  const m = cdg.buildCancelOrder({ apiKey: 'SECRETKEY', subdomain: 's', spOrderNumber: '1', clientOrderNumber: '1', text: 'reason' });
  const masked = cdg.maskRequest(m);
  eq(cdg.refValue(masked.message.clientSystem.referenceIdentifiers, 'ApiKey'), '***', 'maskRequest hides the api key in the cancel envelope');
  eq(masked.message.products.requestCommentText, 'reason', 'the reason is NOT masked (it is not a secret)');
})();

// ---- orderAssumptions ------------------------------------------------------
const CTX = { property: { category: 'sfr', occupancy: 'investment' }, loanNumber: 'L1', loanPurpose: 'Purchase', parties: {} };
// The real shape chooseForm returns: the human name rides `productName` (not `name`).
const FORM = { productCode: '1004', productName: '1004 URAR' };
const bySource = (list) => Object.fromEntries(list.map((a) => [a.field, a]));

(() => {
  const spec = orderBuild.buildOrderSpec(CTX, FORM, {});
  const a = bySource(orderBuild.orderAssumptions(CTX, FORM, {}, spec));
  ok(a.productCode && a.productCode.source === 'rule', 'the auto-picked form is a rule assumption');
  eq(a.productCode.value, '1004 URAR', 'and reports the form NAME');
  ok(a.mortgageType && a.mortgageType.source === 'default', 'mortgage type is a defaulted assumption');
  eq(a.mortgageType.value, 'Conventional', 'defaulted to Conventional');
  ok(a.bestContact && a.bestContact.source === 'default', 'best contact is a defaulted assumption');
  eq(a.bestContact.value, 'Borrower', 'defaulted to the borrower');
  ok(a.titleCategory && a.titleCategory.source === 'derived', 'property type is a derived assumption');
})();

// A staff override suppresses the corresponding assumption (it is no longer PILOT's guess).
(() => {
  const opts = { productCode: '1073', mortgageType: 'Other', bestContact: 'Agent', titleCategory: 'Condominium' };
  const spec = orderBuild.buildOrderSpec(CTX, FORM, opts);
  const a = bySource(orderBuild.orderAssumptions(CTX, FORM, opts, spec));
  eq(Object.keys(a).length, 0, 'a fully-overridden order reports NO assumptions');
})();

// A real value ON THE FILE suppresses the default (it is not an assumption then).
(() => {
  const ctx = { ...CTX, mortgageType: 'FHA', parties: { bestContact: 'Owner' } };
  const spec = orderBuild.buildOrderSpec(ctx, FORM, {});
  const a = bySource(orderBuild.orderAssumptions(ctx, FORM, {}, spec));
  ok(!a.mortgageType, 'a mortgage type on the file is not reported as a default assumption');
  ok(!a.bestContact, 'a best-contact on the file is not reported as a default assumption');
  ok(a.productCode && a.titleCategory, 'the rule/derived assumptions still show');
})();

console.log(`\n[test-amc-cancel-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

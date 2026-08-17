'use strict';
/**
 * Pure test for the NAN (AMC / AppraisalScope) cancellation + the auto-filled order
 * assumptions — no DB, no network.
 *
 * THE RULE THIS PINS (owner-directed 2026-08-17): "Canceling should send a message in
 * the chat message that goes directly to them: 'Hey, please cancel the order.'" So a
 * cancellation is a MESSAGE on the order's own thread, sent through the documented
 * AddComment action — not an API action of its own. There is no cancel action anywhere
 * in the vendor package (guide, mapping workbook, Postman collection, 25 samples), and
 * the previous implementation INVENTED one (`CancelOrder`, behind an AMC_CANCEL_ACTION
 * env override). This test asserts that invented builder is GONE and cannot come back.
 *
 * Locks in: the wording (one definition, so the thread / the test / any future screen
 * cannot drift); that requestCancel routes the ask through comments.postComment with
 * exactly that wording; that a refused send records NOTHING as requested; that the api
 * key is masked out of the journal while the ask itself stays readable; and
 * order-build.orderAssumptions (the defaults / rule-picked form / derived mapping it
 * reports, and that a staff override or a real file value suppresses the assumption).
 */
// PURE: nothing here reaches a database. Two arrangements keep it that way, and keep
// a green suite free of a FATAL-looking line that trains people to ignore real ones.
// (1) cancel.js → comments.js → db.js prints a loud "DATABASE_URL is not set" at load
//     — correct in production, noise here — so a placeholder silences it; no pool is
//     ever asked for a connection, because every db handle below is the fake one.
// (2) the Orders-desk projection is stubbed to a no-op: requestCancel fires it after a
//     successful cancellation, and it is the ONE thing in the path that would reach for
//     the real pool.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pure-test/never-connected';
require.cache[require.resolve('../src/lib/appraisal-order-mirror')] = {
  id: require.resolve('../src/lib/appraisal-order-mirror'),
  filename: require.resolve('../src/lib/appraisal-order-mirror'),
  loaded: true,
  exports: { fire: () => {} },
};

const cdg = require('../src/amc/cdg');
const comments = require('../src/amc/comments');
const cancel = require('../src/amc/cancel');
const orderBuild = require('../src/amc/order-build');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---- the wording: ONE definition ------------------------------------------
(() => {
  const m = cancel.cancelMessage('borrower withdrew');
  ok(/^Please cancel this order\./.test(m), 'the message LEADS with the ask (their coordinator may be skimming a list)');
  ok(m.includes('borrower withdrew'), 'the reason rides with it, so they can action it without a second round trip');
  eq(cancel.cancelMessage(''), 'Please cancel this order.', 'with no reason it is the bare ask — never a dangling "Reason:"');
  eq(cancel.cancelMessage('   '), 'Please cancel this order.', 'a whitespace-only reason is not a reason');
  eq(cancel.cancelMessage(null), 'Please cancel this order.', 'a missing reason never renders "null"');
})();

// ---- the INVENTED cancel action is gone and must not come back -------------
(() => {
  ok(typeof cdg.buildCancelOrder === 'undefined', 'cdg.buildCancelOrder no longer exists (no cancel action is documented anywhere in the vendor package)');
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/amc/cdg.js'), 'utf8');
  // The word appears in the comment block that RECORDS the removal — what must never
  // come back is a builder emitting it as a requestActionType.
  ok(!/requestActionType:\s*(process\.env\.AMC_CANCEL_ACTION|['"]CancelOrder['"])/.test(src),
    'no builder emits a CancelOrder action (a button that NACKs the first time anybody presses it in anger)');
})();

// ---- the ask travels as the documented AddComment envelope -----------------
(() => {
  const m = cdg.buildAddComment({
    apiKey: 'KEY123', subdomain: 'integrations.uat', spOrderNumber: 'SP-9',
    clientOrderNumber: 'YSCAP1', text: cancel.cancelMessage('borrower withdrew'),
  });
  eq(m.message.requestActionType, 'AddComment', 'the cancellation rides the DOCUMENTED AddComment action');
  ok(String(m.message.products.requestCommentText).startsWith('Please cancel this order.'),
    'the ask is the comment text');
  eq(cdg.refValue(m.message.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderOrderNumber'), 'SP-9', 'the SP order number is on the envelope');
  eq(cdg.refValue(m.message.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderSubDomain'), 'integrations.uat', 'the subdomain is on the envelope');
  eq(cdg.refValue(m.message.clientSystem.referenceIdentifiers, 'ClientOrderNumber'), 'YSCAP1', 'the client order number is on the envelope');
  eq(cdg.refValue(m.message.clientSystem.referenceIdentifiers, 'ApiKey'), 'KEY123', 'the api key is on the LIVE envelope');

  const masked = cdg.maskRequest(m);
  eq(cdg.refValue(masked.message.clientSystem.referenceIdentifiers, 'ApiKey'), '***', 'maskRequest hides the api key');
  ok(String(masked.message.products.requestCommentText).includes('borrower withdrew'),
    'the ask is NOT masked (it is not a secret — and the journal is the record of what we asked for)');
})();

// ---- requestCancel routes the ask through the order's own message thread ---
// comments.postComment is read at CALL time, so stubbing the cached export is what
// cancel.js sees. The db handle only has to record what it was asked to write.
const ORDER = {
  id: 1, application_id: 'app-1', client_order_number: 'YSCAP1',
  cdg_order_number: 'CLG500', sp_order_number: 'SP-500', status: 'ordered',
};
const fakeDb = () => {
  const queries = [];
  return { queries, query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ id: 1, status: 'cancel_requested' }], rowCount: 1 }; } };
};
const realPost = comments.postComment;

(async () => {
  // (a) the happy path: the message IS the request.
  {
    let sent = null;
    comments.postComment = async (_db, order, msg) => { sent = { order, msg }; return { ok: true, comment: { id: 77 } }; };
    const db = fakeDb();
    const res = await cancel.requestCancel(db, ORDER, { reason: 'Deal fell through', staffId: 's1', staffName: 'Cara' });
    ok(res.ok, 'an accepted cancellation returns ok');
    ok(sent && sent.order === ORDER, 'the message is posted on THIS order');
    eq(sent && sent.msg.body, cancel.cancelMessage('Deal fell through'), 'the body is exactly the one definition of the wording');
    eq(sent && sent.msg.staffId, 's1', 'the message is attributed to the staffer who asked');
    ok(db.queries.some((q) => /UPDATE amc_orders/.test(q.sql) && /cancel_requested/.test(q.sql)),
      'the order is recorded as cancel_requested');
    ok(db.queries.some((q) => /INSERT INTO amc_write_log/.test(q.sql) && q.params.includes('CancelRequest')),
      'the ask is journaled as CancelRequest');
  }

  // (b) THE GUARD: a refused send records NOTHING as requested. A cancel_requested
  //     order whose message never left leaves the desk waiting forever for a
  //     confirmation of something the AMC's team never received.
  for (const refusal of [
    { ok: false, error: 'send_failed', message: 'AMC AddComment -> 500' },
    { ok: false, error: 'outbound_disabled', message: 'outbound disabled' },
    { ok: false, error: 'amc_nack', message: 'Order not found.' },
  ]) {
    comments.postComment = async () => refusal;
    const db = fakeDb();
    const res = await cancel.requestCancel(db, ORDER, { reason: 'try to cancel', staffId: 's1' });
    ok(!res.ok && res.error === refusal.error, `a ${refusal.error} send is reported as ${refusal.error}`);
    ok(!db.queries.some((q) => /cancel_requested/.test(q.sql)),
      `${refusal.error}: the order is NEVER flipped to cancel_requested`);
    ok(!db.queries.some((q) => /INSERT INTO amc_write_log/.test(q.sql) && q.params.includes('CancelRequest')),
      `${refusal.error}: nothing is journaled as an asked-for cancellation`);
  }
  // Only a genuine send failure records the reason on the order for the desk to read.
  {
    comments.postComment = async () => ({ ok: false, error: 'send_failed', message: 'gateway boom' });
    const db = fakeDb();
    await cancel.requestCancel(db, ORDER, { reason: 'x', staffId: 's1' });
    ok(db.queries.some((q) => /SET last_error/.test(q.sql) && q.params.some((p) => String(p).includes('gateway boom'))),
      'send failure: the gateway reason is recorded on the order');
  }

  // (c) the guards, in order — none of them may reach the transport.
  {
    let posted = false;
    comments.postComment = async () => { posted = true; return { ok: true, comment: {} }; };
    const cases = [
      [{ ...ORDER }, {}, 'reason_required', 'a cancellation with no reason is refused'],
      [{ ...ORDER }, { reason: '   ' }, 'reason_required', 'a whitespace-only reason is refused'],
      [{ ...ORDER, sp_order_number: null }, { reason: 'x' }, 'not_placed', 'an order that never reached the AMC has nothing to cancel there'],
      [{ ...ORDER, status: 'cancelled' }, { reason: 'x' }, 'not_cancellable', 'an already-cancelled order is not cancellable'],
      [{ ...ORDER, status: 'completed' }, { reason: 'x' }, 'not_cancellable', 'a completed order is not cancellable'],
      [{ ...ORDER, status: 'cancel_requested' }, { reason: 'x' }, 'not_cancellable', 'a cancellation already in flight is not re-sent'],
    ];
    for (const [order, opts, code, msg] of cases) {
      const res = await cancel.requestCancel(fakeDb(), order, { staffId: 's1', ...opts });
      ok(!res.ok && res.error === code, msg);
    }
    ok(posted === false, 'no refused cancellation ever reaches the message thread');
  }

  // (d) dry-run: the transport short-circuited, so the desk reads the same state a
  //     live send produces — and says plainly that nothing left the building.
  {
    comments.postComment = async () => ({ ok: true, dryrun: true, comment: { id: 5 } });
    const db = fakeDb();
    const res = await cancel.requestCancel(db, ORDER, { reason: 'test mode', staffId: 's1' });
    ok(res.ok && res.dryrun === true, 'a dry-run cancellation returns ok + dryrun');
    const upd = db.queries.find((q) => /UPDATE amc_orders/.test(q.sql) && /cancel_requested/.test(q.sql));
    ok(upd && /TEST MODE/i.test(upd.sql), 'dry-run: last_error explains it was recorded here, not sent');
  }

  comments.postComment = realPost;

  // ---- orderAssumptions ----------------------------------------------------
  const CTX = { property: { category: 'sfr', occupancy: 'investment' }, loanNumber: 'L1', loanPurpose: 'Purchase', parties: {} };
  // The real shape chooseForm returns: the human name rides `productName` (not `name`).
  const FORM = { productCode: '1004', productName: '1004 URAR' };
  const bySource = (list) => Object.fromEntries(list.map((a) => [a.field, a]));

  {
    const spec = orderBuild.buildOrderSpec(CTX, FORM, {});
    const a = bySource(orderBuild.orderAssumptions(CTX, FORM, {}, spec));
    ok(a.productCode && a.productCode.source === 'rule', 'the auto-picked form is a rule assumption');
    eq(a.productCode.value, '1004 URAR', 'and reports the form NAME');
    ok(a.mortgageType && a.mortgageType.source === 'default', 'mortgage type is a defaulted assumption');
    eq(a.mortgageType.value, 'Conventional', 'defaulted to Conventional');
    ok(a.bestContact && a.bestContact.source === 'default', 'best contact is a defaulted assumption');
    eq(a.bestContact.value, 'Borrower', 'defaulted to the borrower');
    ok(a.titleCategory && a.titleCategory.source === 'derived', 'property type is a derived assumption');
  }

  // A staff override suppresses the corresponding assumption (it is no longer PILOT's guess).
  {
    const opts = { productCode: '1073', mortgageType: 'Other', bestContact: 'Agent', titleCategory: 'Condominium' };
    const spec = orderBuild.buildOrderSpec(CTX, FORM, opts);
    const a = bySource(orderBuild.orderAssumptions(CTX, FORM, opts, spec));
    eq(Object.keys(a).length, 0, 'a fully-overridden order reports NO assumptions');
  }

  // A real value ON THE FILE suppresses the default (it is not an assumption then).
  {
    const ctx = { ...CTX, mortgageType: 'FHA', parties: { bestContact: 'Owner' } };
    const spec = orderBuild.buildOrderSpec(ctx, FORM, {});
    const a = bySource(orderBuild.orderAssumptions(ctx, FORM, {}, spec));
    ok(!a.mortgageType, 'a mortgage type on the file is not reported as a default assumption');
    ok(!a.bestContact, 'a best-contact on the file is not reported as a default assumption');
    ok(a.productCode && a.titleCategory, 'the rule/derived assumptions still show');
  }

  console.log(`\n[test-amc-cancel-pure] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

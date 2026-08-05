'use strict';
/*
 * #13 — the insurance "triple notification". An insurance+/title+ order reply that
 * files documents already emails the team "documents came back" (order_docs_in),
 * so ALSO forwarding it as a generic "New reply on a loan file" was the redundant
 * second of three emails the owner reported. `orderReturnHandledForward` is the
 * decision that suppresses that forward. This pins its whole truth table (no DB).
 */
const assert = require('assert');
const { orderReturnHandledForward } = require('../src/lib/file-inbox');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// 1) A pure order return that filed documents → suppress the generic forward.
assert.equal(orderReturnHandledForward({ orderFiledDocs: true, isFileThreadReply: false }), true,
  'an insurance/title reply that filed documents does NOT also get the generic forward');
ok('#13: order return that filed docs suppresses the redundant "New reply" forward');

// 2) A TEXT-ONLY order reply (no docs → order_docs_in never fired) still forwards —
//    it is the only signal the team gets, so it must not be swallowed.
assert.equal(orderReturnHandledForward({ orderFiledDocs: false, isFileThreadReply: false }), false,
  'a text-only order reply still forwards (no order_docs_in fired for it)');
ok('a text-only order reply is still forwarded');

// 3) A message that is ALSO a genuine file+ thread reply forwards even if it filed
//    order documents — someone on the team wrote in, and that is a real conversation.
assert.equal(orderReturnHandledForward({ orderFiledDocs: true, isFileThreadReply: true }), false,
  'a real file+ thread reply still forwards even when it also filed order documents');
ok('a genuine file-thread reply is never suppressed by the order path');

// 4) IDEMPOTENT across webhook redeliveries. On a redelivery the order block is
//    skipped by its own persisted "saved" marker, so orderFiledDocs is false — but
//    the prior delivery's 'order_handled' decision must still hold, or the forward
//    would fire on the retry (re-introducing the very bombardment).
assert.equal(orderReturnHandledForward({ persisted: 'order_handled', orderFiledDocs: false, isFileThreadReply: false }), true,
  'a redelivery of an already-order-handled reply stays quiet');
assert.equal(orderReturnHandledForward({ persisted: 'order_handled', orderFiledDocs: false, isFileThreadReply: true }), true,
  'the persisted decision wins regardless of the recomputed inputs');
ok('the order-handled decision is idempotent across webhook redeliveries');

// 5) An ordinary already-forwarded / fresh reply is unaffected — the forward loop
//    keeps its own 'forwarded' short-circuit; this helper only ever ADDS suppression.
assert.equal(orderReturnHandledForward({ persisted: 'forwarded', orderFiledDocs: false, isFileThreadReply: true }), false,
  'a plain forwarded/fresh file reply is not suppressed by this helper');
assert.equal(orderReturnHandledForward({}), false, 'no signals at all → forward (never suppress by default)');
ok('a plain file reply is never suppressed');

console.log(`\nAll inbound order-dedup checks passed (${n}).`);
process.exit(0);

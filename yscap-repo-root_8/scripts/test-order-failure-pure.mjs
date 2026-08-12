/**
 * The pure half of the appraisal-order failure display (app-v2/src/lib/orderError.js):
 * parseOrderFailure() and vendorSummary(). This is what turns a failed Class / AMC
 * order into the plain reason + code + vendor detail the owner sees, so it must
 * normalise the two desks' DIFFERENT body shapes without ever leaking a bare code
 * or — the reason this test exists — a literal "[object Object]".
 *
 * Run: node scripts/test-order-failure-pure.mjs
 */
import { parseOrderFailure, vendorSummary } from '../app-v2/src/lib/orderError.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('PASS ' + msg); } else { fail++; console.log('FAIL ' + msg); } }

// Helper mirroring api.js req(): a non-2xx throws an Error carrying the parsed body
// on .data and the HTTP status on .status; friendlyError() sets .message to
// data.error when that's all it has.
const thrown = (status, data) => Object.assign(new Error(data.error || `HTTP ${status}`), { status, data });

console.log('--- Class 502: the live occupancy rejection ---');
{
  const e = thrown(502, {
    error: 'order_failed',
    detail: 'Class createOrder failed: HTTP 400',
    vendor: { success: false, code: '400', error: 'The JSON value could not be converted to CV.OrdersExternal.Common.Orders.OccupancyTypeEnum. Path: $.occupancy | LineNumber: 0 | BytePositionInLine: 987.' },
  });
  const r = parseOrderFailure(e, null);
  ok(r.code === 'order_failed', 'code is the server error code');
  ok(r.httpStatus === 502, 'httpStatus is the response status (Class carries no httpStatus field)');
  ok(r.reason === 'Class createOrder failed: HTTP 400', 'reason is the detail string, never the bare code');
  ok(r.vendor && r.vendor.error && /OccupancyTypeEnum/.test(r.vendor.error), 'the raw vendor body rides through');
  ok(/OccupancyTypeEnum/.test(vendorSummary(r.vendor)) && /\$\.occupancy/.test(vendorSummary(r.vendor)),
     'vendorSummary surfaces the enum + path from the envelope');
  ok(r.missing === null, 'no "still needed" on a vendor rejection');
}

console.log('\n--- Class 422 incomplete: missing is {field,why} OBJECTS (must NOT be [object Object]) ---');
{
  const e = thrown(422, {
    error: 'incomplete',
    message: 'Some details Class requires are still missing.',
    missing: [
      { field: 'occupancy', why: 'UAD 2.6 has no occupancy value matching "weird" — pick one on the order screen' },
      { field: 'purpose', why: 'no Class purpose matches the loan type "xyz"' },
    ],
  });
  const r = parseOrderFailure(e, null);
  ok(r.code === 'incomplete', 'code is "incomplete"');
  ok(r.reason === 'Some details Class requires are still missing.', 'reason is the message');
  ok(Array.isArray(r.missing) && r.missing.length === 2, 'missing normalised to an array of 2');
  ok(r.missing.every((m) => typeof m === 'string'), 'every missing entry is a STRING');
  ok(r.missing.join(', ').indexOf('[object Object]') === -1, 'NEVER renders "[object Object]" (the whole point)');
  ok(/no occupancy value|occupancy value matching/.test(r.missing[0]), 'it is the human "why", not the bare field key');
}

console.log('\n--- Class 422: an object with only a field (no why) falls back to the field name ---');
{
  const r = parseOrderFailure(thrown(422, { error: 'incomplete', missing: [{ field: 'occupancy' }] }), null);
  ok(r.missing && r.missing[0] === 'occupancy', 'why||field -> field when why is absent');
  const empty = parseOrderFailure(thrown(422, { error: 'incomplete', missing: [{}, {}] }), null);
  ok(empty.missing === null, 'all-empty missing objects collapse to null, not [""]');
}

console.log('\n--- AMC 400 send_failed: reason on `message`, vendor on `detail` (an object), httpStatus present ---');
{
  const e = thrown(400, { error: 'send_failed', message: 'The AMC gateway rejected the order.', httpStatus: 502, detail: { httpStatus: 502, gateway: 'CoreLogic: form not enabled' } });
  const r = parseOrderFailure(e, null);
  ok(r.code === 'send_failed', 'code is send_failed');
  ok(r.httpStatus === 502, 'httpStatus prefers the body field over the response status');
  ok(r.reason === 'The AMC gateway rejected the order.', 'reason is the message');
  ok(r.vendor && r.vendor.gateway === 'CoreLogic: form not enabled', 'the detail object rides through as vendor');
}

console.log('\n--- AMC validation: missing is plain STRINGS ---');
{
  const r = parseOrderFailure(thrown(400, { error: 'validation', missing: ['Subject address', 'Loan amount'] }), null);
  ok(Array.isArray(r.missing) && r.missing[0] === 'Subject address' && r.missing[1] === 'Loan amount',
     'string missing pass through unchanged');
}

console.log('\n--- reason NEVER degrades to the bare code ---');
{
  // A body with only an error code (no detail/message) and e.message === code.
  const r = parseOrderFailure(thrown(400, { error: 'order_failed' }), null);
  ok(r.code === 'order_failed' && r.reason === null, 'reason stays null rather than repeating the code');
}

console.log('\n--- network drop: no data, e.message is the friendly text ---');
{
  const e = Object.assign(new Error('Can’t reach the server — check your connection and try again.'), { status: 0 });
  const r = parseOrderFailure(e, null);
  ok(r.reason === 'Can’t reach the server — check your connection and try again.', 'the network message is shown as the reason');
  ok(r.httpStatus === null, 'status 0 is not shown as an HTTP status');
  ok(r.code === null, 'no code on a network drop');
}

console.log('\n--- 2xx body that still says {ok:false} (defensive path) ---');
{
  const r = parseOrderFailure(null, { ok: false, error: 'nope', message: 'soft failure', missing: ['a'] });
  ok(r.code === 'nope' && r.reason === 'soft failure' && r.missing[0] === 'a', 'reads straight off the out body');
}

console.log('\n--- Class 502: a MESSAGE / revision send failure (same shape as an order) ---');
{
  // src/class/messages.js sendFailure(): a failed note/revision/cancel is handed back
  // as { ok:false, error, id, detail, vendor, message } and answered as a 502 — so the
  // screen shows the reason + code + what Class reported EXACTLY like a failed order,
  // never a bare "request_failed" (owner-directed: "not in the dark").
  const e = thrown(502, {
    ok: false, error: 'request_failed', id: 42,
    detail: 'Class updateOrder failed: HTTP 400',
    vendor: { errors: { '$.reasons': ['At least one valid reason is required.'] } },
    message: 'Class updateOrder failed: HTTP 400',
  });
  const r = parseOrderFailure(e, null);
  ok(r.code === 'request_failed', 'the message-failure code rides through, not a bare fallback');
  ok(r.httpStatus === 502, 'the route status is shown');
  ok(r.reason === 'Class updateOrder failed: HTTP 400', 'the plain reason reads off detail/message, never the code');
  ok(r.vendor && r.vendor.errors, 'the vendor body rides through so the raw expander has it');
  ok(/reason is required/i.test(vendorSummary(r.vendor)), "and Class's own words are recovered from it");
}

console.log('\n--- vendorSummary: every shape ---');
ok(vendorSummary({ error: 'boom' }) === 'boom', 'envelope error');
ok(vendorSummary({ message: 'nope' }) === 'nope', 'envelope message');
ok(vendorSummary({ title: 'One or more validation errors occurred.', errors: { '$.occupancy': ['bad enum'] } }) === '$.occupancy: bad enum',
   'errors{} wins over the generic title');
ok(vendorSummary({ errors: { '$.x': ['a', 'b'] } }) === '$.x: a; b', 'multiple messages joined');
ok(vendorSummary({ detail: 'the specifics' }) === 'the specifics', 'ProblemDetails detail');
ok(vendorSummary({ title: 'just a title' }) === 'just a title', 'title when nothing better');
ok(vendorSummary({ raw: 'Bad Gateway (nginx)' }) === 'Bad Gateway (nginx)', 'a non-JSON body kept under raw');
ok(vendorSummary('a plain string') === 'a plain string', 'a plain string body');
ok(vendorSummary(null) === '' && vendorSummary(undefined) === '', 'null/undefined -> empty');
ok(vendorSummary({ unrelated: true }) === '', 'an object with no known keys -> empty (the expander shows the raw JSON)');

console.log(`\ntest-order-failure-pure: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

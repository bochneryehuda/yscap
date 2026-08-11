'use strict';
/**
 * Pure guard for the CreateAppraisal send-failure diagnosis (src/amc/order-service.js).
 *
 * A live NAN order failed with a bare "send_failed" because the catch kept only e.message
 * and discarded the gateway's real reason (err.status + err.body). describeSendFailure()
 * turns a thrown transport error into a legible message (the vendor's own words when it has
 * them) AND a structured detail object persisted to amc_orders.last_status_response — so a
 * staffer's next "Test now" shows exactly WHY it failed. No DB, no network.
 */
const svc = require('../src/amc/order-service');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// A CDG NACK-shaped body returned WITH a non-2xx status: the vendor's statusDescription surfaces.
const nackBody = { message: { digitalGatewaySystem: { statusResponses: [
  { statusCode: '-1008', statusCondition: 'ERROR', statusName: 'NACK', statusDescription: 'Service Provider Processing Error: Authentication Failed' },
] } } };
{
  const e = Object.assign(new Error('AMC CreateAppraisal -> 500'), { status: 500, body: nackBody });
  const r = svc.describeSendFailure(e);
  ok(/HTTP 500/.test(r.text), 'HTTP 500 named in the message');
  ok(/Authentication Failed/.test(r.text), 'the gateway statusDescription reaches the message');
  ok(r.detail.httpStatus === 500, 'detail.httpStatus captured');
  ok(r.detail.kind === 'http_error', 'detail.kind is http_error');
  ok(r.detail.gateway === nackBody, 'the raw gateway body is carried in detail for hand-off');
}

// A 403 gets the entitlement/allow-list hint (the likeliest live cause after DoLogin works).
{
  const e = Object.assign(new Error('AMC CreateAppraisal -> 403'), { status: 403, body: { raw: 'Forbidden' } });
  const r = svc.describeSendFailure(e);
  ok(/HTTP 403/.test(r.text), '403 named');
  ok(/entitled|allow-list/i.test(r.text), '403 carries the entitlement/allow-list hint');
  ok(/Forbidden/.test(r.text), 'a non-JSON {raw} body still surfaces its text');
}

// A 404 points at a wrong endpoint URL.
{
  const e = Object.assign(new Error('AMC CreateAppraisal -> 404'), { status: 404, body: {} });
  const r = svc.describeSendFailure(e);
  ok(/HTTP 404/.test(r.text) && /URL/i.test(r.text), '404 points at a wrong endpoint URL');
}

// A plain-object gateway body ({message:...}) surfaces its message.
{
  const e = Object.assign(new Error('AMC CreateAppraisal -> 400'), { status: 400, body: { message: 'productCode is required' } });
  const r = svc.describeSendFailure(e);
  ok(/productCode is required/.test(r.text), 'a {message} body surfaces its message text');
}

// A network error (no status) reads as a connection problem, not a rejection.
{
  const e = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const r = svc.describeSendFailure(e);
  ok(r.detail.httpStatus === null, 'network error has no httpStatus');
  ok(r.detail.kind === 'network_error', 'kind is network_error');
  ok(/connection problem/i.test(r.text), 'network error reads as a connection problem');
  ok(/ECONNREFUSED/.test(r.text), 'the underlying cause code is shown');
  ok(/not a rejection/i.test(r.text), 'a network failure is explicitly framed as NOT a rejection of the order');
}

// A deliberate switch (outbound off) is NOT framed as a connection problem.
{
  const e = Object.assign(new Error('AMC_OUTBOUND_DISABLED: refusing CreateAppraisal — writes are gated off'), { code: 'AMC_OUTBOUND_DISABLED' });
  const r = svc.describeSendFailure(e);
  ok(r.detail.kind === 'gated', 'outbound-off classified as gated');
  ok(/turned off/i.test(r.text), 'outbound-off reads as turned off');
  ok(!/connection problem/i.test(r.text), 'outbound-off is NOT called a connection problem');
  ok(r.detail.httpStatus === null && r.detail.gateway === null, 'gated detail carries no status/body');
}

// A timeout/abort reads as a timeout.
{
  const e = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const r = svc.describeSendFailure(e);
  ok(r.detail.kind === 'timeout', 'abort classified as timeout');
  ok(/timed out/i.test(r.text), 'abort reads as timed out');
}

// readGatewayBody direct: strings, raw, NACK, arbitrary object, and null.
ok(svc.readGatewayBody('plain text') === 'plain text', 'readGatewayBody passes a string through');
ok(svc.readGatewayBody({ raw: 'proxy denied' }) === 'proxy denied', 'readGatewayBody surfaces {raw}');
ok(/Authentication Failed/.test(svc.readGatewayBody(nackBody)), 'readGatewayBody extracts a NACK description');
ok(svc.readGatewayBody(null) === null, 'readGatewayBody null-safe');
ok(typeof svc.readGatewayBody({ weird: 1 }) === 'string', 'readGatewayBody stringifies an unknown shape');

console.log(`\n[test-amc-send-error-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

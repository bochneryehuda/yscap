'use strict';
/**
 * test-encompass-flood-order-pure.js — the guarded flood-order client.
 *
 * Proves the ONE owner-authorized Encompass write is structurally FLOOD ONLY:
 *  - the fetch guard's allowlist passes only the token + flood-order calls and
 *    refuses everything else (loan reads/writes, milestones, pipeline, fieldReader,
 *    eFolder, arbitrary paths);
 *  - dry-run returns without sending; the outbound gate fails closed when off;
 *  - the response reader extracts the order id + SFHA / zone / file URL from the
 *    shapes ICE is likely to return, and never invents a flood zone.
 */
const assert = require('assert');

// Force the gate state before requiring the module. The shipped default is ON
// (owner-directed "turn everything on"), so to exercise the FAIL-CLOSED path we
// pin the write gate OFF here — a bad value in prod can never silently send.
delete process.env.ENCOMPASS_FLOOD_DRYRUN;
process.env.ENCOMPASS_FLOOD_OUTBOUND_ENABLED = '0';
const flood = require('../src/encompass/flood-order');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// ── 1. The guard allowlist is FLOOD ONLY ─────────────────────────────────────
// Allowed:
ok(flood.pathAllowed('POST', '/oauth2/v1/token'), 'token POST allowed');
ok(flood.pathAllowed('POST', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890/serviceOrders'), 'serviceOrders place allowed');
ok(flood.pathAllowed('GET', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890/serviceOrders/ORD-123'), 'serviceOrders status GET allowed');
ok(flood.pathAllowed('GET', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890/serviceOrders/ORD-123/response/resources'), 'serviceOrders resources GET allowed');
ok(flood.pathAllowed('POST', '/services/v1/partners/12345/transactions?view=id'), 'partner transactions place allowed');
ok(flood.pathAllowed('GET', '/services/v1/partners/12345/transactions/TX-9?generateFileUrls=true'), 'partner transactions status allowed');

// REFUSED — every non-flood Encompass operation the read stack can do, and then some:
const refuse = [
  ['GET', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890'],                 // read a loan
  ['PATCH', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890'],               // WRITE a loan
  ['PUT', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890'],
  ['DELETE', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890'],
  ['POST', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890/fieldReader'],    // read fields
  ['POST', '/encompass/v3/loanPipeline'],                                              // pipeline search
  ['GET', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890/milestones'],      // milestones
  ['POST', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890/attachmentUploadUrl'], // eFolder upload
  ['PATCH', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890/milestones'],    // advance milestone
  ['POST', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890/serviceOrders/ORD-1/cancel'], // cancel an order
  ['GET', '/encompass/v3/settings/loan/customFields'],                                 // settings read
  ['POST', '/scim2/Users'],                                                            // user mgmt
  ['POST', '/encompassdocs/v1/documentOrders/opening'],                                // send disclosures
  ['GET', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890/serviceOrders'],   // list orders (not place)
];
for (const [m, p] of refuse) ok(!flood.pathAllowed(m, p), `REFUSED ${m} ${p}`);

// ── 2. The order body ─────────────────────────────────────────────────────────
const body = flood.buildOrderBody('abcdef12-3456-7890-abcd-ef1234567890');
ok(body && typeof body === 'object', 'buildOrderBody returns an object');
ok(/flood/i.test(JSON.stringify(body)) || body.type === 'Flood' || body.options, 'order body describes a flood order');

// ── 3. extractOrderId ─────────────────────────────────────────────────────────
ok(flood.extractOrderId({ id: 'ORD-1' }) === 'ORD-1', 'order id from body.id');
ok(flood.extractOrderId({ transactionId: 'TX-2' }) === 'TX-2', 'order id from transactionId');
ok(flood.extractOrderId({}, 'https://api.elliemae.com/encompass/v3/loans/g/serviceOrders/ORD-3') === 'ORD-3', 'order id from Location header');
ok(flood.extractOrderId({}) == null, 'no order id when none present');
// A dots-only / traversal order id is rejected (it would normalize to a non-flood path).
ok(flood.sanitizeOrderId('..') === null, 'dots-only order id rejected');
ok(flood.sanitizeOrderId('a/b') === null, 'order id with a slash rejected');
ok(flood.sanitizeOrderId('..%2f') === null, 'order id with junk rejected');
ok(flood.sanitizeOrderId('ORD-123') === 'ORD-123', 'a normal order id is accepted');
ok(!flood.pathAllowed('GET', '/encompass/v3/loans/abcdef12-3456-7890-abcd-ef1234567890/serviceOrders/..'), 'dots-only order id refused by the guard');

// ── 6. The result-download bearer only ever goes to an ICE host ──────────────
ok(flood.isIceHost('api.elliemae.com'), 'api.elliemae.com is an ICE host (bearer allowed)');
ok(flood.isIceHost('services.icemortgagetechnology.com'), 'ICE mortgage tech host allowed');
ok(!flood.isIceHost('evil.example.com'), 'a random vendor host is NOT an ICE host (no bearer)');
ok(!flood.isIceHost('169.254.169.254'), 'the metadata IP is not an ICE host');
ok(!flood.isIceHost('notelliemae.com.evil.com'), 'a look-alike host is not an ICE host');

// ── 4. extractStatus: completion + SFHA/zone + file url ──────────────────────
let s = flood.extractStatus({ status: 'Completed', determination: { sfha: true, floodZone: 'AE' }, files: [{ name: 'cert.pdf', url: 'https://x/cert.pdf' }] });
ok(s.status === 'completed', 'Completed → completed');
ok(s.sfha === true, 'explicit sfha true');
ok(s.floodZone === 'AE', 'zone read');
ok(s.fileUrl === 'https://x/cert.pdf', 'pdf file url read');

s = flood.extractStatus({ orderStatus: 'in progress' });
ok(s.status === 'ordered', 'unknown status stays pending (never guessed complete)');

s = flood.extractStatus({ status: 'error' });
ok(s.status === 'error', 'error status detected');

// SFHA inferred from an A/V zone when no explicit flag; a plain X zone is NOT a flood zone.
s = flood.extractStatus({ status: 'Complete', floodZone: 'A' });
ok(s.sfha === true, 'A zone ⇒ in a flood zone');
s = flood.extractStatus({ status: 'Complete', floodZone: 'X' });
ok(s.sfha === false, 'X zone ⇒ not in a flood zone');
// No determination at all → sfha null (never fabricated).
s = flood.extractStatus({ status: 'Complete' });
ok(s.sfha === null, 'no determination ⇒ sfha null (never fabricated)');

// ── 5. Gates: dry-run returns without sending; outbound-off fails closed ──────
(async () => {
  // Dry-run: no network, returns a dryrun marker.
  process.env.ENCOMPASS_FLOOD_DRYRUN = '1';
  const dr = await flood.placeOrder('abcdef12-3456-7890-abcd-ef1234567890');
  ok(dr && dr.dryrun === true && dr.orderId === null, 'dry-run returns a marker, sends nothing');

  // Outbound OFF (default): a real place is refused BEFORE any network call.
  delete process.env.ENCOMPASS_FLOOD_DRYRUN;
  let threw = null;
  try { await flood.placeOrder('abcdef12-3456-7890-abcd-ef1234567890'); }
  catch (e) { threw = e; }
  ok(threw && threw.code === 'FLOOD_OUTBOUND_DISABLED', 'outbound-off fails closed (no order placed)');

  console.log(`test-encompass-flood-order-pure: ${n} assertions passed`);
})().catch((e) => { console.error('FAIL:', e && e.message); process.exit(1); });

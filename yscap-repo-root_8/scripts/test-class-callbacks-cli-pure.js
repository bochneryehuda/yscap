'use strict';
// The UTC-default proof below only bites when the server's clock is NOT UTC — under
// UTC an offset-less created parses to the same instant either way. CI sets no TZ,
// so pin one here before the first Date is ever built.
// Pinned by MEASURED offset, not by spelling: any zone that reads zero in January or
// July (UTC, Etc/GMT, Europe/London in winter, Africa/Abidjan …) is replaced. Node
// honours a runtime change to process.env.TZ on Linux.
if (new Date(2026, 0, 15).getTimezoneOffset() === 0 || new Date(2026, 6, 15).getTimezoneOffset() === 0) process.env.TZ = 'America/New_York';
/**
 * Class Valuation callback tool — the pure half (no database, no network).
 *
 * The tool runs inside the deployed service against Class's live API, so what can be
 * proven here is the judgement it makes: which password is a placeholder, which URL is
 * the canonical one, what "fully registered" means against their list reply, and that
 * a report carries no secret. The receiver's own dedupe rule is proven here too, off
 * the router's exported internals.
 */
const cli = require('./class-callbacks');
const hook = require('../src/routes/class-webhook')._internals;
const { EVENTS } = require('../src/class/callbacks');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`}`);

console.log('--- the password: a placeholder or a weak value never reaches Class ---');
ok(cli.strength('<STRONG_GENERATED_SECRET>').placeholder, "the guide's own placeholder is a placeholder");
ok(cli.strength('class_webhook').placeholder, "the guide's example username used as a password is a placeholder");
ok(cli.strength('').placeholder, 'an empty password is a placeholder');
eq(cli.strength('correct-horse-battery-staple-9').length, 30, 'length is measured');
ok(cli.strength('correct-horse-battery-staple-9').ok, 'a long passphrase with digits and hyphens passes');
ok(cli.strength('Ab3' + 'x'.repeat(21)).ok, '24 characters from two classes passes');
ok(!cli.strength('abcdefghijklmnopqrstuvwxyz').ok, '26 lowercase letters alone is one class and fails');
ok(!cli.strength('Ab3xyz').ok, 'six characters fails however mixed');
ok(cli.strength('bK7pQ2mN9rT4wX8vZ1cH5jL3fD6gS0aE').ok, 'a 32-byte-looking random string passes');

console.log('\n--- the URL: https, public, ONE canonical form ---');
eq(cli.canonicalUrl('https://yscapgroup.com/api/class/callbacks/'), 'https://yscapgroup.com/api/class/callbacks', 'a trailing slash is stripped for comparison');
eq(cli.canonicalUrl('  https://yscapgroup.com/api/class/callbacks  '), 'https://yscapgroup.com/api/class/callbacks', 'whitespace is trimmed');
ok(cli.urlProblem('https://yscapgroup.com/api/class/callbacks') === null, 'the canonical URL has no problem');
ok(/trailing slash/.test(cli.urlProblem('https://yscapgroup.com/api/class/callbacks/')), 'a configured trailing slash is refused, not silently fixed — they match exactly');
ok(/https/.test(cli.urlProblem('http://yscapgroup.com/api/class/callbacks')), 'http is refused');
ok(/not set/.test(cli.urlProblem('')), 'an empty URL is refused');
ok(cli.urlProblem('https://localhost/api/class/callbacks') != null, 'a non-public hostname is refused');

console.log('\n--- preflight: everything that must be true before a registration ---');
const good = { enabled: true, callbackReady: true, callbackUrl: 'https://yscapgroup.com/api/class/callbacks', callbackUser: 'pilot-class', callbackPassword: 'bK7pQ2mN9rT4wX8vZ1cH5jL3fD6gS0aE' };
ok(cli.preflight(good).ok, 'a complete, strong configuration passes');
ok(!cli.preflight({ ...good, enabled: false }).ok, 'the master switch off refuses');
ok(!cli.preflight({ ...good, callbackReady: false }).ok, 'an unconfigured receiver refuses');
ok(!cli.preflight({ ...good, callbackPassword: '<STRONG_GENERATED_SECRET>' }).ok, 'the placeholder password refuses');
ok(!cli.preflight({ ...good, callbackUser: 'pilot:class' }).ok, 'a colon in the username refuses (Basic auth splits on the first colon)');
ok(!cli.preflight({ ...good, callbackUrl: good.callbackUrl + '/' }).ok, 'a trailing slash refuses');
ok(cli.preflight({ ...good, enabled: false, callbackPassword: 'weak' }).problems.length === 2, 'every problem is listed, not only the first');

console.log('\n--- their list reply: every envelope shape, and the judgement over it ---');
const row = (eventName, callbackUrl, extra) => ({ id: `id-${eventName}`, eventName, callbackUrl, authMode: 'BasicAuth', userName: 'pilot-class', password: good.callbackPassword, ...extra });
const full = EVENTS.map((e) => row(e, good.callbackUrl));
eq(cli.parseList(full).length, EVENTS.length, 'a bare array is read');
eq(cli.parseList({ data: full }).length, EVENTS.length, 'a {data:[]} envelope is read');
eq(cli.parseList({ success: true, callbacks: full }).length, EVENTS.length, 'a {callbacks:[]} envelope is read');
eq(cli.parseList(null).length, 0, 'nothing is nothing');
const intent = { url: good.callbackUrl, user: good.callbackUser, password: good.callbackPassword, events: EVENTS };
const a1 = cli.analyzeRegistrations(full, intent);
ok(a1.complete && a1.registered === EVENTS.length && a1.missing.length === 0, 'all 15 events on our URL with our credentials is complete');
eq(EVENTS.length, cli.EVENT_COUNT_EXPECTED, 'the event list is the 15 their guide names');
const a2 = cli.analyzeRegistrations(full.slice(1), intent);
ok(!a2.complete && a2.missing.length === 1 && a2.missing[0] === EVENTS[0], 'one missing event is named and the set is incomplete');
const a3 = cli.analyzeRegistrations(full.concat([row('StatusChanged', good.callbackUrl + '/')]), intent);
ok(!a3.complete && a3.twins.length === 1 && a3.twins[0].callbackUrl.endsWith('/'), 'a trailing-slash twin is flagged — duplicate deliveries — and blocks completeness');
const a4 = cli.analyzeRegistrations(full.map((r) => ({ ...r, password: 'an-older-password' })), intent);
ok(!a4.complete && a4.stalePassword.length === EVENTS.length, 'a registration carrying an older password is stale');
const a5 = cli.analyzeRegistrations(full.map((r) => ({ ...r, authMode: 'ApiToken' })), intent);
ok(!a5.complete && a5.authModeWrong.length === EVENTS.length, 'a non-Basic registration is flagged');
const a6 = cli.analyzeRegistrations(full.concat([row('StatusChanged', 'https://other.example/cb')]), intent);
ok(a6.complete && a6.others.length === 1, "somebody else's URL in the organisation is reported and does not block ours");
const a7 = cli.analyzeRegistrations(full.map((r) => ({ ...r, userName: 'somebody-else' })), intent);
ok(!a7.complete && a7.staleUser.length === EVENTS.length, 'a registration under another username is stale');
const a8 = cli.analyzeRegistrations([], intent);
ok(!a8.complete && a8.registered === 0, 'nothing registered is not complete');

console.log('\n--- nothing secret in a report ---');
const masked = cli.maskRow(full[0], intent);
ok(!('password' in masked) && !('userName' in masked) && masked.passwordMatches === true && masked.userMatches === true, 'a masked row carries booleans, never the values');
const dump = JSON.stringify([a1, a2, a3, a4, a5, a6, a7, a8, masked]);
ok(!dump.includes(good.callbackPassword) && !dump.includes('an-older-password'), 'no analysis output ever contains a password');
ok(!dump.includes('"pilot-class"'), 'no analysis output carries the username as a value');

console.log("\n--- the receiver's dedupe: their identity when present, bytes-per-day otherwise ---");
const env = { eventName: 'StatusChanged', classOrderId: '12345', referenceNumber: null };
const k1 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z' }, '{"a":1}', '2026-09-03');
const k2 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00.000Z', sent: 'later' }, '{"a":2}', '2026-09-04');
ok(k1.keyed && k2.keyed && k1.material === k2.material, 'same orderId + eventName + created is ONE delivery whatever else moved (bytes, sent, the day)');
const k3 = hook.deliveryKey(env, { created: '2026-09-03T10:00:01Z' }, '{"a":1}', '2026-09-03');
ok(k3.material !== k1.material, 'a different created is a different delivery');
const k4 = hook.deliveryKey({ ...env, eventName: 'NewNotes' }, { created: '2026-09-03T10:00:00Z' }, '{"a":1}', '2026-09-03');
ok(k4.material !== k1.material, 'a different event on the same order at the same instant is a different delivery');
const k5 = hook.deliveryKey({ ...env, classOrderId: null }, { created: '2026-09-03T10:00:00Z' }, '{"a":1}', '2026-09-03');
ok(!k5.keyed, 'no order id → the payload-bytes fallback');
const k6 = hook.deliveryKey(env, { created: 'not a date' }, '{"a":1}', '2026-09-03');
ok(!k6.keyed, 'an unreadable created → the payload-bytes fallback');
const k7 = hook.deliveryKey(env, {}, '{"a":1}', '2026-09-03');
const k8 = hook.deliveryKey(env, {}, '{"a":1}', '2026-09-03');
ok(!k7.keyed && k7.material === k8.material, 'the fallback still collapses a verbatim retry');
const k9 = hook.deliveryKey(env, { Created: '2026-09-03T10:00:00Z' }, '{"a":1}', '2026-09-03');
ok(k9.keyed && k9.material === k1.material, 'their Pascal-case spelling reads the same');

console.log("\n--- the content discriminator: same three fields, different content, is two events ---");
const d1 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: { note: 'first' } }, 'x', '2026-09-03');
const d2 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: { note: 'second' } }, 'x', '2026-09-03');
ok(d1.keyed && d2.keyed && d1.material !== d2.material, 'two different notes on one order in the same second are two deliveries');
const d3 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: { note: 'first' }, sent: '2026-09-03T10:05:00Z' }, 'y', '2026-09-03');
ok(d3.material === d1.material, 'a retry of the first — same content, moved sent — is still ONE delivery');
const d4 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00.000Z', data: { b: 1, a: [1, { z: 2, y: 3 }] } }, 'x', '2026-09-03');
const d5 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: { a: [1, { y: 3, z: 2 }], b: 1 } }, 'x', '2026-09-04');
ok(d4.material === d5.material, 'key order and the created spelling never change the identity — the digest is canonical');
ok(!d1.material.endsWith('|'), 'the digest is part of the material, not an empty tail');
const mkDeep = (n) => { const d = {}; let cur = d; for (let i = 0; i < n; i++) { cur.n = {}; cur = cur.n; } return d; };
const d6 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: mkDeep(200), sent: 'A' }, 'x', '2026-09-03');
const d7 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: mkDeep(200), sent: 'B' }, 'y', '2026-09-03');
ok(d6.keyed && d6.material === d7.material, 'a 200-deep body is canonicalised like any other — a retry with a moved sent still collapses');
// Deeper than JSON.stringify's own recursion survives (~4-5k on a fresh stack), which is
// where the STORED body becomes a marker. The digest is iterative, so the identity of
// a retry never depends on how the body happened to be stored.
const d8 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: mkDeep(20000), sent: 'A' }, 'MARKER-A', '2026-09-03');
const d9 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: mkDeep(20000), sent: 'B' }, 'MARKER-B', '2026-09-03');
ok(d8.keyed && d8.material === d9.material, 'a body too deep to store verbatim still digests by content — a retry with a moved sent collapses even when stored as a marker');
const d10 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: mkDeep(20000) }, 'x', '2026-09-03');
const d11 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: { ...mkDeep(20000), other: 1 } }, 'x', '2026-09-03');
ok(d10.material !== d11.material, 'and two different very deep bodies are still two events');
const arrDeep = (n) => { const a = []; let cur = a; for (let i = 0; i < n; i++) { const nx = []; cur.push(nx); cur = nx; } return a; };
const d8a = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: arrDeep(20000), sent: 'A' }, 'x', '2026-09-03');
const d9a = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: arrDeep(20000), sent: 'B' }, 'y', '2026-09-03');
ok(d8a.material === d9a.material, 'the same holds for deep arrays');
ok(hook.canonical({ b: [1, { z: null, y: 'ü' }], a: 'x' }) === JSON.stringify({ a: 'x', b: [1, { y: 'ü', z: null }] }), 'canonical output IS JSON with keys sorted at every level');
ok(hook.canonical({ a: [], b: {}, c: [[], {}] }) === '{"a":[],"b":{},"c":[[],{}]}', 'empty containers print as themselves');
Array.prototype.toJSON = () => 'POLLUTED';
try { ok(hook.canonical([1, 'a', null]) === '[1,"a",null]', 'a toJSON planted on Array.prototype never speaks for a leaf array'); }
finally { delete Array.prototype.toJSON; }
const d12 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: { big: 1n } }, 'MARKER-A', '2026-09-03');
const d13 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', data: { big: 1n } }, 'MARKER-B', '2026-09-03');
ok(d12.keyed && d13.keyed && d12.material !== d13.material, 'a body nothing can serialise falls back to the stored marker for its digest, never a throw');
const d14 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', ...JSON.parse('{"__proto__": {"x": 1}}') }, 'x', '2026-09-03');
const d15 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z', ...JSON.parse('{"__proto__": {"x": 2}}') }, 'x', '2026-09-03');
const d16 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z' }, 'x', '2026-09-03');
ok(d14.material !== d15.material && d14.material !== d16.material, 'a top-level "__proto__" key is content, never an assignment to the prototype');

console.log("\n--- created without a timezone is UTC, never the server's local clock ---");
ok(new Date(2026, 0, 15).getTimezoneOffset() !== 0 && new Date(2026, 6, 15).getTimezoneOffset() !== 0,
   'the TZ pin bit — this process is NOT on a zero-offset clock, so the checks below can fail');
const u1 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00' }, 'x', '2026-09-03');
const u2 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00Z' }, 'x', '2026-09-03');
ok(u1.keyed && u1.material === u2.material, 'an offset-less ISO created is read as UTC (same key as the Z form)');
const u3 = hook.deliveryKey(env, { created: '2026-09-03T10:00:00+02:00' }, 'x', '2026-09-03');
ok(u3.keyed && u3.material !== u2.material, 'an explicit offset is honoured, not overwritten');
const u4 = hook.deliveryKey(env, { created: '2026-09-03t10:00:00' }, 'x', '2026-09-03');
const u5 = hook.deliveryKey(env, { created: '2026-09-03 10:00:00' }, 'x', '2026-09-03');
ok(u4.material === u2.material && u5.material === u2.material, 'a lowercase t or a space separator without an offset is UTC too');

console.log(`\ntest-class-callbacks-cli-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

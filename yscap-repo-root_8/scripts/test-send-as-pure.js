'use strict';
/**
 * WHO AN ORDER COMES FROM — and the one thing that must never happen.
 *
 * The owner asked for orders to come from the person who placed them, "from his email,
 * from his name". `src/lib/send-as.js` is the rule, and this is what holds it.
 *
 * THE ASSERTION THAT MATTERS MOST is not that the right person's address appears — it
 * is that an address on a domain we CANNOT SIGN FOR never reaches a From line. That
 * message fails DMARC alignment at the receiving server and lands in spam, so the
 * failure is silent from our side: the order looks sent, the desk shows it placed, and
 * the title company never sees it. Every other check here is about not making the
 * opposite mistake — falling back to the company address more often than we need to.
 *
 * PURE: no config, no network, no database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const ok = (m) => { n++; console.log('  ok -', m); };

const sendAs = require('../src/lib/send-as');

const NOTIFY = 'PILOT by YS Capital <notifications@yscapgroup.com>';
const DOMAINS = sendAs.sendingDomains({ notifyFrom: NOTIFY });

/* ── A. THE DOMAIN LIST DERIVES ITSELF ───────────────────────────────────────
   Unset, it is the domain we already send from — the one the provider has verified.
   That is what makes send-as-user work on the configuration that is live today, with
   nothing new to set up, which was the owner's actual question. */
assert.deepStrictEqual(DOMAINS, ['yscapgroup.com'], 'with nothing configured, the sending domain is derived from NOTIFY_FROM');
assert.deepStrictEqual(sendAs.sendingDomains({ notifyFrom: 'a@x.example', configured: 'One.Example, two.example' }),
  ['one.example', 'two.example'], 'a configured list replaces it, normalised');
assert.deepStrictEqual(sendAs.sendingDomains({ notifyFrom: 'a@x.example', configured: '  @Y.EXAMPLE  ' }),
  ['y.example'], 'a leading @ and stray padding are tolerated');
assert.deepStrictEqual(sendAs.sendingDomains({}), [], 'nothing to derive from yields nothing — and nothing may then be sent as');
assert.deepStrictEqual(sendAs.sendingDomains({ notifyFrom: 'not an address' }), [], 'an unreadable NOTIFY_FROM yields nothing');
assert.deepStrictEqual(sendAs.sendingDomains({ notifyFrom: 'a@x.example', configured: 'bad, ok.example, also bad' }),
  ['ok.example'], 'a junk entry in the list is dropped, not stored');
ok('the sending-domain list derives itself from the address we already send from');

/* ── B. THE ONE THING THAT MUST NEVER HAPPEN ─────────────────────────────────
   An address we cannot sign for, in a From line. Asserted over a battery of the
   shapes a real staff record produces. */
const OFF_DOMAIN = [
  'chaya@gmail.com', 'c@outlook.com', 'x@yahoo.co.uk', 'a@yscapgroup.com.evil.example',
  'b@sub.yscapgroup.com', 'd@YSCAPGROUP.CO', 'e@notyscapgroup.com',
];
for (const email of OFF_DOMAIN) {
  const r = sendAs.senderFor({ name: 'Chaya Gruber', email }, { notifyFrom: NOTIFY, domains: DOMAINS });
  assert.strictEqual(r.mode, 'on_behalf', `${email} is sent FOR, never AS`);
  const bare = sendAs.addressOf(email);
  assert.ok(!r.from.toLowerCase().includes(bare), `${email} never appears in the From line`);
  assert.ok(r.from.includes('notifications@yscapgroup.com'), `${email} sends from our own verified address`);
  assert.ok(r.from.includes('Chaya Gruber'), 'and still carries their name');
  // Normalised on the way in — a header must carry one canonical form of an address.
  assert.strictEqual(r.replyTo, bare, 'with replies going to them when no order address is set');
}
ok(`an address on a domain we cannot sign for never reaches a From line (${OFF_DOMAIN.length} shapes)`);

// A SUBDOMAIN IS A DIFFERENT DOMAIN for DKIM, and the check is exact rather than a
// suffix test — `yscapgroup.com.evil.example` above is the reason.
assert.strictEqual(sendAs.senderFor({ name: 'A', email: 'a@sub.yscapgroup.com' }, { notifyFrom: NOTIFY, domains: DOMAINS }).mode,
  'on_behalf', 'a subdomain is not the parent domain');
ok('the domain test is exact — a subdomain and a look-alike are both refused');

/* ── C. AND THE OPPOSITE MISTAKE: falling back more than we need to ────────── */
for (const email of ['chaya@yscapgroup.com', 'Chaya@YSCAPGROUP.com', '  chaya@yscapgroup.com  ']) {
  const r = sendAs.senderFor({ name: 'Chaya Gruber', email }, { notifyFrom: NOTIFY, domains: DOMAINS });
  assert.strictEqual(r.mode, 'as_user', `${JSON.stringify(email)} is sent AS`);
  assert.strictEqual(r.from, '"Chaya Gruber" <chaya@yscapgroup.com>', 'their name and their own address, normalised');
}
ok('somebody on the company domain sends as themselves, whatever the casing or padding');

/* ── D. THE ORDER'S OWN REPLY ADDRESS ALWAYS WINS ────────────────────────────
   That address is what files a vendor's returned documents onto the right condition.
   Redirecting replies to a person's inbox would take the documents off the file — so
   this is a correctness rule, not a preference. */
const ORDER_ADDR = 'ltorder+title.11111111-2222-3333-4444-555555555555@orders.yscapgroup.com';
for (const email of ['chaya@yscapgroup.com', 'chaya@gmail.com', null]) {
  const r = sendAs.senderFor({ name: 'Chaya Gruber', email }, { notifyFrom: NOTIFY, domains: DOMAINS, replyTo: ORDER_ADDR });
  assert.strictEqual(r.replyTo, ORDER_ADDR, `the order's own address is the Reply-To (${email})`);
}
ok('the order’s own reply address always wins, so returned documents stay on the file');

/* ── E. NOBODY USABLE, AND THE SWITCH ────────────────────────────────────────
   Every unreadable input falls to the mode that is always deliverable. Guessing in
   the other direction costs the message. */
const NO_ONE = [null, undefined, {}, { name: '' }, { email: '' }, { email: 'not-an-address' },
  { email: 'two@@at.example' }, { email: 'no-at-sign' }, { email: 'trailing@' }, { name: 'X', email: 'a b@c.example' }];
for (const p of NO_ONE) {
  const r = sendAs.senderFor(p, { notifyFrom: NOTIFY, domains: DOMAINS });
  assert.strictEqual(r.mode, 'company', `${JSON.stringify(p)} falls to the company address`);
  assert.ok(r.from && r.from.includes('notifications@yscapgroup.com'), 'and the From is still deliverable');
}
ok('an unreadable sender falls to the company address, which is always deliverable');

// A person with a name and no address still gets their NAME on it — a vendor reading
// "Chaya Gruber — PILOT by YS Capital" knows who to answer, which is most of the point.
const named = sendAs.senderFor({ name: 'Chaya Gruber' }, { notifyFrom: NOTIFY, domains: DOMAINS });
assert.ok(named.from.includes('Chaya Gruber') && named.from.includes('notifications@yscapgroup.com'),
  'a person with no address still puts their name on the company From');
ok('a person with no email on file still has their name on the letter');

const off = sendAs.senderFor({ name: 'Chaya Gruber', email: 'chaya@yscapgroup.com' },
  { notifyFrom: NOTIFY, domains: DOMAINS, enabled: false });
assert.strictEqual(off.mode, 'company', 'the switch returns every send to the company address');
assert.ok(!off.from.includes('chaya@yscapgroup.com'), 'and their address is not in the From');
ok('SEND_AS_USER=0 returns every send to the company address');

/* ── F. HEADER SAFETY ────────────────────────────────────────────────────────
   A display name goes into a mail header verbatim. A CRLF there is header injection —
   it does not corrupt one field, it lets somebody append their own headers to our
   message. Quotes and angle brackets break the address parse.  */
const NASTY = [
  'Chaya\r\nBcc: attacker@evil.example',
  'Chaya\nX-Injected: yes',
  'Chaya "Quote" <fake@evil.example>',
  '   Chaya    Gruber   ',
  'x'.repeat(300),
];
for (const name of NASTY) {
  const r = sendAs.senderFor({ name, email: 'chaya@yscapgroup.com' }, { notifyFrom: NOTIFY, domains: DOMAINS });
  assert.ok(!/[\r\n]/.test(r.from), 'no line break survives into a From line');
  assert.ok(!/[<>"]/.test(r.from.replace(/^"[^"]*"\s*<[^>]*>$/, '')), 'no stray bracket or quote survives');
  assert.ok(r.from.endsWith('<chaya@yscapgroup.com>'), 'and the address is still the real one');
  assert.ok(r.from.length < 400, 'and the name is bounded');
}
assert.strictEqual(sendAs.cleanName('  A   B  '), 'A B', 'runs of whitespace collapse');
ok('a display name can never inject a header, break the address, or run unbounded');

/* ── G. THE GRAPH HAZARD IS FLAGGED, AND ONLY THERE ──────────────────────────
   Under Graph the send is POST /users/{from}/sendMail, so a From that is on the right
   domain but is not a real mailbox makes the WHOLE SEND FAIL rather than degrade. The
   caller is told to retry once as the company. Under Resend the domain is what is
   verified, so there is nothing to fall back from. */
assert.strictEqual(sendAs.senderFor({ name: 'A', email: 'a@yscapgroup.com' },
  { notifyFrom: NOTIFY, domains: DOMAINS, provider: 'graph' }).fallbackOnFailure, true,
'under Graph a send-as-user attempt asks for a company fallback');
for (const provider of ['resend', 'none', undefined, null]) {
  assert.strictEqual(sendAs.senderFor({ name: 'A', email: 'a@yscapgroup.com' },
    { notifyFrom: NOTIFY, domains: DOMAINS, provider }).fallbackOnFailure, false,
  `under ${provider} there is nothing to fall back from`);
}
for (const provider of ['graph', 'resend']) {
  assert.strictEqual(sendAs.senderFor({ name: 'A', email: 'a@gmail.com' },
    { notifyFrom: NOTIFY, domains: DOMAINS, provider }).fallbackOnFailure, false,
  'an on-behalf send is already the company address — there is nothing to fall back to');
}
ok('the Graph mailbox hazard is flagged where it exists and nowhere else');

/* ── H. EVERY ANSWER SAYS WHY ────────────────────────────────────────────────
   A screen that shows "sent from the company address" with no reason invites the
   question this whole module exists to answer. */
for (const p of [{ name: 'A', email: 'a@yscapgroup.com' }, { name: 'A', email: 'a@gmail.com' }, {}]) {
  const r = sendAs.senderFor(p, { notifyFrom: NOTIFY, domains: DOMAINS });
  assert.ok(typeof r.why === 'string' && r.why.length > 20, 'every answer carries a plain-language reason');
}
ok('every answer says why, in words');

/* ── I. THE SHORT-TERM DESK IS DELIBERATELY UNTOUCHED ────────────────────────
   Its From is a live deliverability posture on a product with real traffic, and the
   standing rule is that a feature built for one side never automatically applies to
   the other. Switching it over is one line and it is the owner's call — this pins
   that it has NOT been done quietly. */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const rtlSrc = codeOnly(read('src/lib/orders.js'));
assert.ok(!/send-as/.test(rtlSrc), 'the short-term orders desk still sends as the company — switching it on is the owner’s call');
ok('the short-term desk is deliberately unchanged');

console.log(`\ntest-send-as-pure: ${n} checks passed`);

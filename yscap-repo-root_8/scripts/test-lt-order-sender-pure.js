'use strict';
/**
 * A LONG-TERM ORDER COMES FROM THE PERSON WHO PLACED IT — asserted ON THE WIRE.
 *
 * `scripts/test-send-as-pure.js` holds the RULE (`src/lib/send-as.js`): which
 * addresses may go in a From line, and why an address on a domain we cannot sign for
 * never can. This holds the WIRING — that the long-term orders desk actually uses that
 * answer for the message it sends.
 *
 * WHY IT IS A SEPARATE SUITE. Only `scripts/test-lt-*.js` may import Long-Term code
 * (the separation gate enforces it), and this has to import the desk to see what it
 * would put on the wire.
 *
 * WHY IT ASSERTS ON THE PAYLOAD RATHER THAN THE SOURCE. A grep cannot tell a call that
 * DECIDES the From from a call whose answer is thrown away — a mutation that
 * hard-coded the sender and left the function call further down the file passed a
 * source check happily. So the mail provider is STUBBED and the assertion is on the
 * message that would have gone out. This repo's own rule: a passing send against the
 * noop provider proves nothing about who it was addressed from.
 *
 * PURE: `sendLetter` touches no database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const ok = (m) => { n++; console.log('  ok -', m); };

const NOTIFY = 'PILOT by YS Capital <notifications@yscapgroup.com>';
const ORDER_ADDR = 'ltorder+title.11111111-2222-3333-4444-555555555555@orders.yscapgroup.com';
process.env.NOTIFY_FROM = NOTIFY;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub/stub';

/* THE MAIL PROVIDER IS STUBBED BEFORE THE DESK IS LOADED, so nothing can reach a
   network and the payload is captured exactly as the desk composed it.
   `fromWithName` THROWS on purpose: it is the old name-only From this replaced, and a
   desk that fell back to it would fail loudly rather than send under the wrong
   identity. */
const captured = [];
const emailPath = require.resolve('../src/lib/email');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, exports: {
    sendMail: async (payload) => { captured.push(payload); return { ok: true, id: 'stub' }; },
    fromWithName: () => { throw new Error('the desk must not use the old name-only From'); },
  },
};

const desk = require('../src/longterm/orders/desk');

const BUILT = { subject: 'Title Order Request', html: '<p>x</p>', text: 'x' };
const LOAN = '11111111-2222-3333-4444-555555555555';

async function wire(person, extra = {}) {
  captured.length = 0;
  const r = await desk.sendLetter({
    loanId: LOAN, kind: 'title', built: BUILT,
    to: ['vendor@example.com'], cc: ['lo@yscapgroup.com'],
    replyTo: ORDER_ADDR, from: person, threadState: null, ...extra,
  });
  assert.ok(r.ok, `the stubbed send succeeds (${JSON.stringify(person)})`);
  assert.strictEqual(captured.length, 1, 'exactly one message went out');
  return { payload: captured[0], result: r };
}

(async () => {
  const asUser = await wire({ name: 'Chaya Gruber', email: 'chaya@yscapgroup.com' });
  assert.strictEqual(asUser.payload.from, '"Chaya Gruber" <chaya@yscapgroup.com>',
    'the order really goes out FROM the person who placed it');
  assert.strictEqual(asUser.result.sentAs.mode, 'as_user', 'and the desk reports that it did');
  ok('an order goes out from the person who placed it, when we may sign for their address');

  /* THE ONE THING THAT MUST NEVER HAPPEN, on the wire: an address on a domain we
     cannot sign for. That message fails DMARC alignment at the receiving server and
     lands in spam, so the failure is SILENT from our side — the order looks sent, the
     desk shows it placed, and the title company never sees it. */
  const onBehalf = await wire({ name: 'Chaya Gruber', email: 'chaya@gmail.com' });
  assert.ok(!String(onBehalf.payload.from).includes('gmail.com'),
    'an address we cannot sign for never reaches the wire');
  assert.ok(String(onBehalf.payload.from).includes('Chaya Gruber'), 'their name rides instead');
  assert.ok(String(onBehalf.payload.from).includes('notifications@yscapgroup.com'), 'on our own verified address');
  assert.strictEqual(onBehalf.result.sentAs.mode, 'on_behalf', 'and the desk reports that it did');
  ok('an address on a domain we cannot sign for never reaches the wire');

  /* THE ORDER'S OWN REPLY ADDRESS IS WHAT GOES OUT, whoever sent it — that address is
     what files a vendor's returned documents onto the right condition, so a person's
     own inbox winning here would take the documents off the file. */
  for (const p of [{ name: 'A', email: 'a@yscapgroup.com' }, { name: 'A', email: 'a@gmail.com' }, null]) {
    const r = await wire(p);
    assert.strictEqual(r.payload.replyTo, ORDER_ADDR, 'the order’s own reply address is on the wire');
  }
  ok('the order’s own reply address is always what a vendor replies to');

  const nobody = await wire(null);
  assert.ok(String(nobody.payload.from || NOTIFY).includes('notifications@yscapgroup.com'),
    'with nobody named it is the company address, which is always deliverable');
  ok('with nobody named the order still goes out, from the company address');

  /* AND IT NEVER WRITES THE SHORT-TERM EMAIL CENTER. The long-term thread is
     `lt_order_events`; the short-term store is another product's table (rule 4). */
  assert.strictEqual(asUser.payload._skipCapture, true, 'every long-term send skips the short-term capture');
  ok('a long-term send never writes the short-term Email Center');

  /* THE SUBJECT AND THE THREADING HEADERS, because a chase that starts a new chain in
     the vendor's inbox reads as a cold email and is filtered like one. */
  const fu = await wire({ name: 'A', email: 'a@yscapgroup.com' },
    { threadState: { root: '<root@x>', last: '<last@x>', subject: 'Title Order Request' } });
  assert.strictEqual(fu.payload.subject, 'Re: Title Order Request', 'a follow-up reuses the order subject with one Re:');
  assert.strictEqual(fu.payload.headers['In-Reply-To'], '<last@x>', 'and points at the last message we sent');
  assert.strictEqual(fu.payload.headers.References, '<root@x> <last@x>', 'with the chain behind it');
  assert.ok(/^<ltorder\.title\./.test(fu.payload.headers['Message-ID']), 'and mints its own Message-ID on our domain');
  ok('a follow-up lands on the same conversation rather than starting a new one');

  console.log(`\ntest-lt-order-sender-pure: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });

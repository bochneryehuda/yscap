'use strict';
/**
 * ORDER EMAIL THREADING (owner-directed 2026-08-04).
 *
 * "Follow up on an order" (title / insurance) used to open a NEW email chain in
 * the vendor's inbox: the follow-up carried no RFC threading headers and even a
 * different subject ("… Order — Follow-up" vs "… Order Request"). This pins the
 * fix at the one chokepoint `orders.sendOrderMail`, with the mailer STUBBED so we
 * assert the exact wire payload:
 *   · a PLACE (no thread) is the ROOT — its own Message-ID, no In-Reply-To,
 *     subject unchanged;
 *   · a FOLLOW-UP (thread present) reuses the order subject with one "Re:" (the
 *     load-bearing part — a provider may rewrite our Message-ID) AND references the
 *     order's Message-ID (In-Reply-To / References);
 *   · every send mints a NEW Message-ID and returns it so the caller advances the
 *     thread.
 */
const emailMod = require('../src/lib/email');
const orders = require('../src/lib/orders');

let failed = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed++; }

// Stub the provider send: capture the exact payload, report a confirmed send.
let captured = null;
emailMod.sendMail = async (opts) => { captured = opts; return { ok: true, id: 'stub-id' }; };

const SUBJ = 'Title Order Request · YS123 · Doe · 5 Main St';
const built = { subject: SUBJ, html: '<p>body</p>', text: 'body' };
const base = { appId: 'app-1', kind: 'title', to: ['vendor@title.co'], cc: ['lo@ys.com'], replyTo: 'title+app-1@ys', built };

(async () => {
  // ---- helper unit checks
  ok(orders.replyOrderSubject(SUBJ) === 'Re: ' + SUBJ, 'replyOrderSubject adds one Re:');
  ok(orders.replyOrderSubject('Re: ' + SUBJ) === 'Re: ' + SUBJ, 'replyOrderSubject is idempotent (no double Re:)');
  ok(orders.replyOrderSubject('') === '', 'replyOrderSubject of blank is blank');
  const m1 = orders.newOrderMessageId('app-1', 'title'), m2 = orders.newOrderMessageId('app-1', 'title');
  ok(/^<order\.title\.app-1\.[0-9a-f]{16}@.+>$/.test(m1), 'newOrderMessageId is a well-formed angle-bracketed id');
  ok(m1 !== m2, 'newOrderMessageId is unique per call');

  // ---- PLACE: the root of the chain.
  captured = null;
  const placed = await orders.sendOrderMail({ ...base, type: 'title_order' });
  ok(placed.ok && placed.messageId, 'place: returns a messageId');
  ok(captured.subject === SUBJ, 'place: subject is the order subject (no Re:)');
  ok(captured.headers && captured.headers['Message-ID'] === placed.messageId, 'place: Message-ID header == returned id');
  ok(!captured.headers['In-Reply-To'] && !captured.headers.References, 'place: no In-Reply-To / References (it is the root)');
  ok(captured.headers['X-Pilot-Order-Thread'] === 'app-1:title', 'place: carries the X- order-thread marker (Graph-safe)');
  const rootId = placed.messageId;

  // ---- FOLLOW-UP: same conversation. Two messages already sent (root != last).
  captured = null;
  const lastId = '<order.title.app-1.1111111111111111@ys>';
  const fu = await orders.sendOrderMail({ ...base, type: 'title_followup',
    thread: { root: rootId, last: lastId, subject: SUBJ } });
  ok(fu.ok && fu.messageId && fu.messageId !== rootId && fu.messageId !== lastId, 'follow-up: mints a NEW messageId');
  ok(captured.subject === 'Re: ' + SUBJ, 'follow-up: subject is Re: + the original order subject (threads by subject)');
  ok(captured.headers['In-Reply-To'] === lastId, 'follow-up: In-Reply-To points at the last message');
  ok(captured.headers.References === rootId + ' ' + lastId, 'follow-up: References = root + last');

  // ---- FOLLOW-UP where only the order exists (root === last): no duplicate in References.
  captured = null;
  await orders.sendOrderMail({ ...base, type: 'title_followup',
    thread: { root: rootId, last: rootId, subject: SUBJ } });
  ok(captured.headers.References === rootId, 'follow-up (first): References is just the root, not doubled');
  ok(captured.headers['In-Reply-To'] === rootId, 'follow-up (first): In-Reply-To is the root');

  // ---- LEGACY order (placed before threading; no stored ids) still threads by subject.
  captured = null;
  await orders.sendOrderMail({ ...base, type: 'title_followup', thread: { root: null, last: null, subject: SUBJ } });
  ok(captured.subject === 'Re: ' + SUBJ, 'legacy follow-up: still reuses the order subject with Re:');
  ok(!captured.headers['In-Reply-To'], 'legacy follow-up: no In-Reply-To (nothing to reference) — subject threads it');

  // ---- Contact guard unchanged.
  const noTo = await orders.sendOrderMail({ ...base, to: [], type: 'title_order' });
  ok(!noTo.ok && noTo.reason === 'contact', 'no vendor address still refuses with reason=contact');

  console.log(failed ? `\n${failed} assertion(s) failed` : '\nALL order-threading assertions passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

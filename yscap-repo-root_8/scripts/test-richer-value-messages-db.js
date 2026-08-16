'use strict';
/**
 * DB-gated test — talking to the Richer Values team by email.
 *
 *   node scripts/test-richer-value-messages-db.js
 *
 * WHY THIS FEATURE IS EMAIL AT ALL is the first thing worth pinning: their API has
 * no messaging (31 messaging-shaped paths, both methods, all 404), so the address
 * IS the integration. That makes two things load-bearing, and both are asserted
 * here rather than assumed:
 *
 *   · the reply comes back ON THE ORDER — `rv+<file>@` must round-trip through
 *     mint → parse, and a reply carrying that address must be tagged `rv_message`
 *     so the order-scoped inbox picks it up. Without this, their answer lands in
 *     one person's personal inbox and the file never learns anything.
 *   · a capital-partner name NEVER reaches them. Richer Values is an outside
 *     company, and the body is a free-text box a staffer types into.
 *
 * The mailer is STUBBED and the wire payload is asserted, because a send against
 * the `none` provider proves nothing about what would actually have gone out —
 * the lesson this repo already recorded when a `render()` object was passed where
 * a string belonged and every test still passed.
 */
const assert = require('assert');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-richer-value-messages-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
// The address family is DORMANT without an inbound domain — that is the whole
// point of the guard on every parser here — so the suite sets one.
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.example.com';

const R = require('path').resolve(__dirname, '..');
const db = require(R + '/src/db');

(async () => {
  const addr = require(R + '/src/lib/file-address');
  const emailLog = require(R + '/src/lib/email-log');

  // ── A. the address round-trips, and refuses everything that is not ours ──────
  const appId = '11111111-2222-3333-4444-555555555555';
  const mint = addr.rvReplyTo(appId);
  ok(mint === `rv+${appId}@reply.example.com`, `A1 the address is minted: ${mint}`);
  ok(addr.rvRefFromRecipient(mint) === appId, 'A2 and parses back to the same file');
  ok(addr.rvRefFromRecipient(mint.toUpperCase()) === appId,
    'A3 case-insensitively — a mail server may rewrite the case');
  ok(addr.rvRefFromRecipient(`rv+${appId}@somewhere-else.com`) === null,
    'A4 an rv address on ANOTHER domain is refused (never trust a look-alike)');
  ok(addr.rvRefFromRecipient('rv+not-a-uuid@reply.example.com') === null,
    'A5 a malformed id is refused rather than half-resolved');
  ok(addr.rvRefFromRecipient(`title+${appId}@reply.example.com`) === null,
    'A6 a title order address is NOT read as an appraisal-vendor address');
  ok(addr.rvReplyTo('nonsense') === null, 'A7 a non-file id mints nothing');

  // ── B. the message type is registered everywhere it has to be ───────────────
  ok(emailLog.INBOUND_MSG_TYPES.has('rv_message'),
    'B1 an inbound reply may be tagged rv_message (else it degrades to a plain file reply)');

  // ── C. a real send: the wire payload, not just "it did not throw" ───────────
  const email = require(R + '/src/lib/email');
  const messages = require(R + '/src/richervalues/messages');
  const realSend = email.sendMail;
  let sent = null;
  email.sendMail = async (m) => { sent = m; return { id: 'stub' }; };

  try {
    // A file with no order refuses, and NAMES the fix.
    const none = await messages.sendMessage(appId, { body: 'hello' });
    ok(none.ok === false && none.reason === 'no_order',
      'C1 a file with nothing ordered refuses — their desk searches by order reference');
    ok(/place the richer values order first/i.test(none.message || ''),
      `C2 …and the refusal says what to do: "${none.message}"`);
    ok(sent === null, 'C3 nothing was emailed on a refusal');

    // An empty message is refused before any lookup.
    const blank = await messages.sendMessage(appId, { body: '   ' });
    ok(blank.ok === false && blank.reason === 'empty', 'C4 an empty message is refused');

    // Now with a real file + order.
    const bId = (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email)
       VALUES ('Rv','Msgtest','rv-msgtest-' || gen_random_uuid() || '@example.com')
       RETURNING id`)).rows[0].id;
    const aId = (await db.query(
      `INSERT INTO applications (borrower_id, status, property_address, ys_loan_number)
       VALUES ($1,'underwriting','{"oneLine":"9 Probe St, Brooklyn, NY 11219"}'::jsonb,'YSCAP-MSG-1')
       RETURNING id`, [bId])).rows[0].id;
    await db.query(
      `INSERT INTO rv_orders (application_id, intake_token, status, report_type)
       VALUES ($1,'INTAKE-TOK-9','ordered','reno-arv')`, [aId]);

    sent = null;
    const out = await messages.sendMessage(aId, {
      // A partner name typed into the free-text box, which is exactly how one leaves.
      body: 'Blue Lake wants the scope of work re-reviewed.\n\nPlease advise on timing.',
      staffName: 'Yehuda Bochner',
    });
    ok(out.ok === true, 'C5 a file with a live order sends');
    ok(sent && Array.isArray(sent.to) && sent.to[0] === 'orders@richervalues.com',
      `C6 it goes to their team: ${sent && sent.to}`);
    ok(typeof sent.html === 'string' && typeof sent.text === 'string',
      'C7 the body is a STRING on the wire (never a render() object)');
    ok(sent.replyTo === `rv+${aId}@reply.example.com`,
      `C8 the Reply-To routes their answer back to the ORDER: ${sent.replyTo}`);
    ok(out.routedBack === true, 'C9 …and the caller is told the reply will come back to the file');
    ok(/INTAKE-TOK-9/.test(sent.subject), `C10 the subject leads with THEIR reference: ${sent.subject}`);
    ok(/9 Probe St/.test(sent.subject), 'C11 …and names the property so two orders are tellable apart');
    ok(sent._ctx && sent._ctx.type === 'rv_message',
      'C12 tagged rv_message so the thread is one conversation');

    // THE SCRUB — the reason this is asserted on the WIRE and not on the input.
    const wire = `${sent.subject} ${sent.html} ${sent.text}`;
    ok(!/blue\s*lake/i.test(wire),
      'C13 the capital-partner name NEVER reaches the outside vendor');
    ok(/scope of work/i.test(wire), 'C14 …while the rest of the message survives intact');
    ok(/Please advise on timing/i.test(wire),
      'C15 …including the later paragraphs (not just the first)');

    // ── D. the thread reads back, ours and theirs together ────────────────────
    await emailLog.captureOutbound(
      { to: ['orders@richervalues.com'], subject: sent.subject, html: sent.html, text: sent.text },
      { applicationId: aId, type: 'rv_message' });
    await emailLog.captureInbound({
      applicationId: aId,
      msgType: 'rv_message',
      subject: `Re: ${sent.subject}`,
      from: 'desk@richervalues.com',
      text: 'We have the revised scope and will re-inspect Thursday.',
    });
    const thread = await messages.thread(aId);
    ok(thread.length >= 2, `D1 the thread carries both sides (${thread.length} messages)`);
    ok(thread.some((m) => m.direction === 'outbound'), 'D2 our message is in it');
    const reply = thread.find((m) => m.direction === 'inbound');
    ok(!!reply, 'D3 their reply is in it');
    ok(reply && reply.msg_type === 'rv_message',
      'D4 …tagged rv_message, so the order-scoped inbox picks it up');
    ok(thread.every((m) => m.msg_type === 'rv_message'),
      'D5 the thread is only this vendor — no other conversation bleeds in');

    // Another file's thread must not appear here.
    const otherThread = await messages.thread(appId);
    ok(otherThread.length === 0, 'D6 a different file has its own empty thread');

    await db.query('DELETE FROM email_messages WHERE application_id=$1', [aId]);
    await db.query('DELETE FROM rv_orders WHERE application_id=$1', [aId]);
    await db.query('DELETE FROM applications WHERE id=$1', [aId]);
    await db.query('DELETE FROM borrowers WHERE id=$1', [bId]);
  } finally {
    email.sendMail = realSend;
  }

  console.log(failures ? `\ntest-richer-value-messages-db: ${failures} FAILED`
    : '\ntest-richer-value-messages-db: all checks passed');
  await db.pool.end().catch(() => {});
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

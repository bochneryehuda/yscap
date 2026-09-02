#!/usr/bin/env node
/**
 * WHOEVER THE OTHER SIDE LOOPED IN STAYS LOOPED IN.
 *
 * Owner-directed 2026-08-07, marked extremely important: "When title or insurance is
 * looping a second party on the email thread it should save on Pilot and keep them
 * looped in when replying thru Pilot… or they're looping in their assistant. Our system
 * is looping them back out… it should always stay looped in on everybody that is any
 * other body looped."
 *
 * Pure section runs anywhere; the DB section SKIPS without DATABASE_URL, like the rest
 * of the suite. Runs in `npm test`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let fails = 0;
function ok(cond, what) {
  if (cond) { console.log(`  ✓ ${what}`); return; }
  fails++; console.error(`  ✗ ${what}`);
}

process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'orders.yscapgroup.com';
process.env.NOTIFY_FROM = process.env.NOTIFY_FROM || 'notifications@yscapgroup.com';
const TP = require('../src/lib/thread-participants');
const I = TP._internals;

console.log('\n1. OURSELVES are never a participant — this exclusion prevents a MAIL LOOP');
{
  // Every one of these is a PILOT inbound webhook: mailing it back re-enters the
  // system, gets forwarded, and the pair amplify each other.
  const ours = [
    'file+11111111-1111-1111-1111-111111111111@orders.yscapgroup.com',
    'title+abc@orders.yscapgroup.com',
    'insurance+abc@orders.yscapgroup.com',
    'closing+deadbeef@orders.yscapgroup.com',
    'chat+xyz@orders.yscapgroup.com',
    'notifications@yscapgroup.com',
  ];
  for (const a of ours) ok(I.isOurAddress(a), `dropped (ours): ${a}`);
  // A genuine outside party is NOT ours.
  for (const a of ['scott@cleinsurancebrokers.com', 'zissy@candorins.com', 'teamag@privatelenderlaw.com',
                   'assistant@privatelenderlaw.com', 'agent@titleco.com']) {
    ok(!I.isOurAddress(a), `kept (outside party): ${a}`);
  }
}

console.log('\n2. Automated senders are never a participant, but a ticketing box IS');
for (const a of ['mailer-daemon@x.com', 'postmaster@x.com', 'no-reply@titleco.com',
                 'noreply@titleco.com', 'do-not-reply@x.com', 'bounces+abc@x.com',
                 'autoreply@x.com']) {
  ok(I.isAutomated(a), `dropped (automated): ${a}`);
}
for (const a of ['support+ABC123@titleco.com', 'closings@privatelenderlaw.com',
                 'noreplacement@x.com', 'norelease@x.com']) {
  ok(!I.isAutomated(a), `kept (a real party, despite the shape): ${a}`);
}

console.log('\n3. Only mailable addresses, and the extras go to Cc — never To');
ok(I.looksMailable('a@b.co') && !I.looksMailable('not-an-email')
   && !I.looksMailable('a@b') && !I.looksMailable('a b@c.com'), 'mailability is checked');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/lib/thread-participants.js'), 'utf8');
  ok(/cc: baseCc\.concat\(added\)/.test(src),
    'the extras join Cc — promoting a CC\'d assistant to To would change who the reply is FOR');
  ok(/to: baseTo/.test(src), '…and the base To is never diluted');
  ok(/MAX_EXTRA = 25/.test(src), 'the added list is capped, so a list-serv cannot fan one reply out to a hundred');
  ok(/return \[\];/.test(src.slice(src.indexOf('} catch (_) {', src.indexOf('async function extraParticipants')))),
    'a lookup failure FAILS TOWARD THE BASE LIST — the reply still reaches everyone we knew');
}

console.log('\n4. Every reply/follow-up door uses it — a door that re-derives is the bug');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/staff.js'), 'utf8');
  const calls = (src.match(/threadParticipants\.replyRecipients\(/g) || []).length;
  ok(calls === 4, `all four doors go through it — the order reply, the order follow-up, the follow-up PREVIEW and the closing reply (found ${calls})`);
  // The follow-up PREVIEW consults it too (post-merge audit W6, 2026-08-27): the To/Cc
  // the editable-preview modal shows must be the follow-up send's OWN derivation,
  // vendor-thread participants included — a preview that re-derived (or skipped) them
  // showed a recipient list the send would not use.
  const previewRoute = src.slice(src.indexOf('orders/:kind/email-preview'));
  ok(/threadParticipants\.replyRecipients\(/.test(previewRoute.slice(0, 4000)),
    'the follow-up preview shows the same participants the follow-up send will use');
  // The PLACE door is the FIRST message on a thread; there is no inbound history yet,
  // so it deliberately does not consult this.
  const place = src.slice(src.indexOf('const built = orders.buildOrderEmail(kind, data, {});'));
  ok(!/replyRecipients/.test(place.slice(0, 600)),
    'the initial order does NOT — it is the first message, so there is nobody to have added anyone');
  // The closing reply must scope to its own chain, or two closings on one file cross.
  ok(/threadKey: thread\.thread_key/.test(src), 'the closing reply is scoped to THIS chain\'s thread_key');
  ok(/msgTypes: \['closing_message', 'attorney_message'\]/.test(src), '…and to the closing message kinds');
  ok(/msgTypes: \[`\$\{kind\}_message`\]/.test(src), 'an order reply is scoped to its own kind');
}

console.log('\n5. The carve-outs the desks require');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/staff.js'), 'utf8');
  /* The borrower is governed by the owner-directed ccBorrower setting alone — and
     since 2026-08-28 the borrower's HELPER is governed by ccHelper on exactly the
     same footing. Both must be in the `never` list on EVERY order door that replies
     on a vendor thread, or a vendor's one-off Cc of either turns into policy.

     Counted rather than matched once: there are three such doors (the Email Center
     reply, the follow-up send, the follow-up preview), and a guard that passes on
     one of them would let the other two drift. */
  // Since 2026-09-01 every order door ALSO keeps a RETIRED vendor off the thread (a replaced
  // insurance agent — lib/file-contacts), so the list is two lines; the borrower / co-borrower
  // / helper carve-out is unchanged and still counted three times.
  const orderNever = src.match(
    /never: \[data\.borrowerEmail, data\.coBorrowerEmail, \.\.\.orders\.helperEmails\(data\),\s*\.\.\.require\('\.\.\/lib\/file-contacts'\)\.retiredVendorEmails\(row && row\.meta\)\]\.filter\(Boolean\)/g) || [];
  ok(orderNever.length === 3,
    `an order never ADDS the borrower or their helper this way — the ccBorrower/ccHelper settings stay the only doors (found ${orderNever.length} of 3)`);
  ok(!/never: \[data\.borrowerEmail, data\.coBorrowerEmail\]\.filter\(Boolean\)/.test(src),
    '…and no order door still carves out the borrower while letting the helper be re-added');
  ok(/never: await closingPrep\.neverLoopIn\(appId\)/.test(src),
    'the closing chain carves out the borrower AND any insurance contact');
  const cp = fs.readFileSync(path.join(__dirname, '../src/lib/closing-prep.js'), 'utf8');
  const fn = cp.slice(cp.indexOf('async function neverLoopIn'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(/co_borrower_id/.test(body), 'neverLoopIn covers the co-borrower too');
  ok(/NEVER_SHARE_CONTACT_TYPES/.test(body), '…and reuses the insurance exclusion list, never a second copy');
  ok(/sc\.contact_type = ANY[\s\S]{0,120}l\.contact_type/.test(body),
    '…testing BOTH the directory type and the per-file link, exactly as the SQL exclusion does');
}

/* ------------------------------------------------------------------ DB ---- */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\nSKIP the DB section (no DATABASE_URL)');
    console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ thread participants: all pure assertions passed\n');
    process.exit(fails ? 1 : 0);
  }
  const db = require('../src/db');
  console.log('\n6. THE OWNER\'S STORY, against a real database');
  try {
    const bor = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Tp','Borrower','tp.borrower@example.com') RETURNING id`)).rows[0];
    const app = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, status)
       VALUES ($1, '{"oneLine":"9500 Parkview Ave"}'::jsonb, 'processing') RETURNING id`, [bor.id])).rows[0];

    // The insurance agent replies and CC's their own assistant + the borrower, and the
    // message also carries our own reply-to box and a bounce handler.
    await db.query(
      `INSERT INTO email_messages (application_id, direction, msg_type, category, from_email,
                                   to_emails, cc_emails, subject, occurred_at)
       VALUES ($1,'inbound','insurance_message','messages','scott@cleinsurancebrokers.com',
               $2::jsonb, $3::jsonb, 'Re: Insurance Order Request', now())`,
      [app.id,
       JSON.stringify([{ email: 'insurance+abc@orders.yscapgroup.com' }]),
       JSON.stringify([{ email: 'assistant@cleinsurancebrokers.com' },
                       { email: 'tp.borrower@example.com' },
                       { email: 'mailer-daemon@example.com' }])]);

    const r = await TP.replyRecipients({
      applicationId: app.id, msgTypes: ['insurance_message'],
      to: ['scott@cleinsurancebrokers.com'],
      cc: ['officer@yscapgroup.com'],
      never: ['tp.borrower@example.com'],
    });
    ok(r.cc.includes('assistant@cleinsurancebrokers.com'),
      'the assistant the agent CC\'d is KEPT on our reply — the reported bug');
    ok(r.to.length === 1 && r.to[0] === 'scott@cleinsurancebrokers.com',
      'the To is still the agent alone — an assistant is not promoted to To');
    ok(!r.cc.includes('tp.borrower@example.com'), 'the borrower is NOT added (the ccBorrower setting governs that)');
    ok(!r.cc.some((a) => a.includes('insurance+')), 'our OWN reply-to box is not mailed back (no loop)');
    ok(!r.cc.includes('mailer-daemon@example.com'), 'the bounce handler is not added');
    ok(r.cc.includes('officer@yscapgroup.com'), 'and everyone we already had is still there');

    // A SECOND reply adds one more person; both must survive.
    await db.query(
      `INSERT INTO email_messages (application_id, direction, msg_type, category, from_email,
                                   to_emails, cc_emails, subject, occurred_at)
       VALUES ($1,'inbound','insurance_message','messages','assistant@cleinsurancebrokers.com',
               $2::jsonb, $3::jsonb, 'Re: Insurance Order Request', now())`,
      [app.id, JSON.stringify([{ email: 'insurance+abc@orders.yscapgroup.com' }]),
       JSON.stringify([{ email: 'underwriter@carrier.example.com' }])]);
    const r2 = await TP.replyRecipients({
      applicationId: app.id, msgTypes: ['insurance_message'],
      to: ['scott@cleinsurancebrokers.com'], cc: [], never: ['tp.borrower@example.com'],
    });
    ok(r2.cc.includes('assistant@cleinsurancebrokers.com') && r2.cc.includes('underwriter@carrier.example.com'),
      'a party added on a LATER reply is kept too, alongside the first');

    // SCOPE: a TITLE reply on the same file must not pull in the insurance parties.
    const r3 = await TP.replyRecipients({
      applicationId: app.id, msgTypes: ['title_message'],
      to: ['agent@titleco.com'], cc: [], never: [],
    });
    ok(!r3.cc.includes('assistant@cleinsurancebrokers.com'),
      'the title thread does NOT inherit the insurance thread\'s participants');

    // An UNKNOWN file adds nobody and does not throw.
    const r4 = await TP.replyRecipients({ applicationId: app.id, msgTypes: ['closing_message'], to: ['x@y.com'] });
    ok(r4.cc.length === 0, 'a thread with no inbound history adds nobody');
    ok((await TP.extraParticipants({})).length === 0, 'no applicationId → nothing, never a throw');

    await db.query(`DELETE FROM email_messages WHERE application_id=$1`, [app.id]);
    await db.query(`DELETE FROM applications WHERE id=$1`, [app.id]);
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor.id]);
  } catch (e) {
    fails++; console.error('  ✗ DB section threw:', e.message);
  }
  console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ thread participants: all assertions passed\n');
  process.exit(fails ? 1 : 0);
})();

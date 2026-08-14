'use strict';
/**
 * THE DURABLE HALF: what an email could not carry is RECORDED, and a PILOT link behaves.
 *
 * DB-gated — skips cleanly without DATABASE_URL, like every other -db suite here.
 *
 * A pure test cannot prove any of this. The audit columns are written by a SQL statement with 24
 * bind parameters and an ON CONFLICT clause, and the share link is a real row with a real expiry
 * and a real storage read behind it; the failure modes that matter (a mis-numbered placeholder, a
 * phantom column inside a swallowing catch, an upsert that erases the audit on its second touch)
 * are all invisible to a mock. Every write here goes through the REAL public function.
 */
const assert = require('assert');

if (!process.env.DATABASE_URL) { console.log('SKIP test-attachment-audit-db (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const emailLog = require('../src/lib/email-log');
const share = require('../src/lib/attachments/share-link');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; console.log(`  ok  ${name}`); }

(async () => {
  console.log('\n== db/548 — the columns exist, on the real table ==');
  const cols = (await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='email_messages' AND column_name IN ('omitted','attach_summary')`)).rows;
  ok('omitted + attach_summary are on email_messages', cols.length === 2);
  ok('and both are jsonb', cols.every((c) => c.data_type === 'jsonb'));

  console.log('\n== an email records what it could NOT carry ==');
  const subject = `attach-audit-${Date.now()}`;
  await emailLog.captureOutbound(
    { to: 'investor@example.com', subject, html: '<p>hi</p>', text: 'hi',
      attachments: [{ filename: 'draw-packet.xlsx', contentType: 'application/vnd.ms-excel', content: Buffer.alloc(900).toString('base64') }] },
    { type: 'draw_investor_delivery', status: 'sent',
      omitted: [{ what: 'Inspection report', filename: 'inspection.pdf', code: 'too_large', bytes: 31457280,
        reason: 'it is 30 MB and this email can carry 20 MB in total', remedy: 'share_link' }],
      attachSummary: { attached_n: 1, omitted_n: 1, budget: 20971520, compressed_n: 2, saved_bytes: 4000,
        consent: { by: 'staff-uuid', note: 'investor asked us to send what we have' } } });

  const row = (await db.query(
    `SELECT omitted, attach_summary, attachments FROM email_messages WHERE subject=$1 ORDER BY occurred_at DESC LIMIT 1`,
    [subject])).rows[0];
  ok('the row was written', !!row);
  ok('the omission survived the round trip', row.omitted && row.omitted.length === 1);
  ok(`with its machine-readable code ("${row.omitted[0].code}")`, row.omitted[0].code === 'too_large');
  ok('its sentence', /30 MB/.test(row.omitted[0].reason));
  ok('its remedy', row.omitted[0].remedy === 'share_link');
  ok('its size', row.omitted[0].bytes === 31457280);
  ok('the summary records the consent that was given', row.attach_summary.consent.by === 'staff-uuid');
  ok('and what DID attach is still recorded beside it', row.attachments && row.attachments.length === 1);

  console.log('\n== the query the owner actually asks: "show me every email that went out short" ==');
  const short = (await db.query(
    `SELECT subject, omitted FROM email_messages
      WHERE omitted IS NOT NULL AND jsonb_array_length(omitted) > 0
      ORDER BY occurred_at DESC LIMIT 5`)).rows;
  ok('it answers, and our email is in it', short.some((r) => r.subject === subject));
  const byCode = (await db.query(
    `SELECT count(*)::int AS n FROM email_messages, jsonb_array_elements(omitted) o
      WHERE o->>'code' = 'too_large'`)).rows[0];
  ok(`and it is queryable BY CODE (${byCode.n} too_large)`, byCode.n >= 1);

  console.log('\n== an email with nothing missing writes NULL, not noise ==');
  const clean = `attach-clean-${Date.now()}`;
  await emailLog.captureOutbound({ to: 'a@b.com', subject: clean, text: 'x' }, { type: 'generic', status: 'sent' });
  const cleanRow = (await db.query(`SELECT omitted, attach_summary FROM email_messages WHERE subject=$1`, [clean])).rows[0];
  ok('a plain email records no omission', cleanRow && cleanRow.omitted === null);
  ok('and no attachment summary', cleanRow.attach_summary === null);

  console.log('\n== the notification upsert must never ERASE the audit on its second touch ==');
  // notify writes a lightweight row first and the real send updates it. Only ONE of those passes
  // knows about the attachments, so a plain assignment on conflict would wipe the trail.
  const notifId = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
  const s2 = `attach-upsert-${Date.now()}`;
  await emailLog.captureOutbound({ to: 'x@y.com', subject: s2, text: 'first' },
    { notificationId: notifId, status: 'sent', omitted: [{ what: 'Big PDF', code: 'too_large', reason: 'too big' }] });
  await emailLog.captureOutbound({ to: 'x@y.com', subject: s2, text: 'second' },
    { notificationId: notifId, status: 'sent' });   // a later touch that knows nothing about attachments
  const after = (await db.query(`SELECT omitted FROM email_messages WHERE notification_id=$1`, [notifId])).rows[0];
  ok('the omission is still there after a second, attachment-blind touch', after && after.omitted && after.omitted.length === 1);

  console.log('\n== db/549 — a PILOT link ==');
  const bytes = Buffer.from('%PDF-1.7\n' + 'x'.repeat(4000));
  const link = await share.createShareLink({
    buf: bytes, filename: 'inspection-report.pdf', contentType: 'application/pdf',
    purpose: 'investor_delivery', label: 'Inspection report', expiresDays: 30,
  });
  ok('a link is minted', !!link && !!link.token);
  ok(`the token is 128 bits of hex, not derived from an id (${link.token.slice(0, 8)}…)`, /^[0-9a-f]{32}$/.test(link.token));
  ok(`the url is short enough to survive an email (${link.url})`, link.url.endsWith(`/d/${link.token}`));
  ok('it has an expiry', !!link.expiresAt && new Date(link.expiresAt) > new Date());

  const found = await share.resolveShareToken(link.token);
  ok('it resolves', found.ok);
  const read = await share.readShareBytes(found.row);
  ok('and serves back the exact bytes', read && read.equals(bytes));

  await share.recordOpen(found.row.id, '203.0.113.9');
  const opened = (await db.query(`SELECT opened_count, first_opened_at, last_opened_ip FROM document_share_links WHERE id=$1`, [found.row.id])).rows[0];
  ok('an open is counted, timestamped and attributed — which is what answers "did they open it?"',
    opened.opened_count === 1 && !!opened.first_opened_at && opened.last_opened_ip === '203.0.113.9');

  console.log('\n== a link cannot be guessed, walked, or used past its life ==');
  ok('junk is refused before it reaches the database', (await share.resolveShareToken('not-a-token')).code === 'unknown');
  ok('a well-formed but unknown token is refused', (await share.resolveShareToken('0'.repeat(32))).code === 'unknown');
  ok('SQL in the token is refused by the shape check', (await share.resolveShareToken("' OR 1=1--")).code === 'unknown');

  await db.query(`UPDATE document_share_links SET expires_at = now() - interval '1 day' WHERE id=$1`, [found.row.id]);
  const exp = await share.resolveShareToken(link.token);
  ok('an expired link is refused — and says EXPIRED, which has a remedy the reader can act on', !exp.ok && exp.code === 'expired');

  const link2 = await share.createShareLink({ buf: bytes, filename: 'x.pdf', contentType: 'application/pdf' });
  ok('revoking a live link works', await share.revokeShareLink(link2.id, null) === true);
  ok('a revoked link is refused, and told apart from an expired one', (await share.resolveShareToken(link2.token)).code === 'revoked');
  ok('revoking twice reports honestly rather than pretending', await share.revokeShareLink(link2.id, null) === false);

  console.log('\n== the expiry is capped, so no caller can mint a permanent public link ==');
  const forever = await share.createShareLink({ buf: bytes, filename: 'y.pdf', contentType: 'application/pdf', expiresDays: 99999 });
  const days = (new Date(forever.expiresAt) - Date.now()) / 86400000;
  ok(`a huge expiry is clamped to the ceiling (${Math.round(days)} days)`, days <= share.MAX_EXPIRY_DAYS + 1);

  console.log('\n== the double warning is one definition, used everywhere ==');
  ok('there are TWO distinct warnings, not one worded twice',
    share.LINK_WARNINGS.length === 2 && share.LINK_WARNINGS[0] !== share.LINK_WARNINGS[1]);
  ok('the first is about the recipient not opening it', /spam|may never open/i.test(share.LINK_WARNINGS[0]));
  ok('the second says compression is the better answer', /compress/i.test(share.LINK_WARNINGS[1]));

  console.log(`\nAll ${passed} assertions passed.\n`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.message, '\n', e); process.exit(1); });

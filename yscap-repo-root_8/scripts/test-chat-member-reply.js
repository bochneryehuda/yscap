/**
 * #144 — ANY chat member's email reply lands back IN THE CHAT.
 *
 * Verifies the root-cause fix: every conversation_members row (staff + borrower)
 * carries an unguessable per-conversation reply_key (db/122), the digest email
 * reply-to uses it (chat.memberReplyToFor), and the inbound resolver
 * (chat.postInboundReply) posts a member's email reply back into the thread AS
 * that member — while still resolving external guest keys (#75).
 *
 * Run: node scripts/test-chat-member-reply.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-chat-member-reply';
process.env.SSN_ENCRYPTION_KEY = 'test-ssn-key-for-verification-only-32bytes!!';
process.env.EMAIL_PROVIDER = 'none';
process.env.CHAT_REPLY_DOMAIN = 'reply.test';    // switches on chat+ reply-to
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

async function memberKey(convId, kind, id) {
  const r = await db.query(
    `SELECT reply_key FROM conversation_members WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3`,
    [convId, kind, id]);
  return r.rows[0] ? r.rows[0].reply_key : null;
}
async function lastMessage(convId) {
  const r = await db.query(
    `SELECT sender_kind, sender_id, body FROM messages WHERE conversation_id=$1 ORDER BY seq DESC LIMIT 1`, [convId]);
  return r.rows[0] || null;
}
async function msgCount(convId) {
  const r = await db.query(`SELECT count(*)::int n FROM messages WHERE conversation_id=$1`, [convId]);
  return r.rows[0].n;
}

async function main() {
  require(REPO + '/src/server.js');
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const chat = require(REPO + '/src/lib/chat');

  const B = uuid(), LO = uuid(), APP = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'CMR Officer','loan_officer','x',true)`, [LO, `cmr_lo_${LO.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'CMR','Borrower',$2)`, [B, `cmr_b_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id) VALUES ($1,$2,$3)`, [APP, B, LO]);

    // Seed the default conversations + members straight from the assignments.
    await chat.ensureConversationsForApp(APP);
    const cr = await db.query(`SELECT id FROM conversations WHERE application_id=$1 AND kind='borrower'`, [APP]);
    const convId = cr.rows[0].id;
    const conv = await chat.getConversation(convId);

    // (1) every member got an unguessable reply_key.
    const bKey = await memberKey(convId, 'borrower', B);
    const loKey = await memberKey(convId, 'staff', LO);
    ok(bKey && bKey.length >= 24, `borrower member has a reply_key (${bKey && bKey.slice(0, 8)}…)`);
    ok(loKey && loKey.length >= 24, `LO member has a reply_key (${loKey && loKey.slice(0, 8)}…)`);
    ok(bKey !== loKey, 'each member key is distinct');

    // (2) memberReplyToFor builds the chat+ address for a member (the digest reply-to).
    const bReplyTo = await chat.memberReplyToFor(convId, 'borrower', B);
    ok(bReplyTo === `chat+${bKey}@reply.test`, `borrower digest reply-to is chat+<key>@ (got ${bReplyTo})`);
    const loReplyTo = await chat.memberReplyToFor(convId, 'staff', LO);
    ok(loReplyTo === `chat+${loKey}@reply.test`, `LO digest reply-to is chat+<key>@ (got ${loReplyTo})`);

    // (3) a BORROWER member's email reply posts back into the chat AS the borrower.
    const before = await msgCount(convId);
    const m1 = await chat.postInboundReply(bKey, 'Reply from the borrower by email');
    ok(!!m1, 'postInboundReply(borrowerKey) posted a message');
    const lm1 = await lastMessage(convId);
    ok(lm1 && lm1.sender_kind === 'borrower' && lm1.sender_id === B && /borrower by email/.test(lm1.body),
      'borrower email reply landed in the thread as the borrower');
    ok(await msgCount(convId) === before + 1, 'exactly one message added');

    // (4) a STAFF (LO) member's email reply posts back into the chat AS the LO.
    const m2 = await chat.postInboundReply(loKey, 'Reply from the loan officer by email');
    ok(!!m2, 'postInboundReply(loKey) posted a message');
    const lm2 = await lastMessage(convId);
    ok(lm2 && lm2.sender_kind === 'staff' && lm2.sender_id === LO && /loan officer by email/.test(lm2.body),
      'LO email reply landed in the thread as the LO');

    // (5) an EXTERNAL guest still resolves through the same combined resolver (#75 intact).
    const ep = await chat.addExternalParticipant(convId, { email: 'guest@partner.test', name: 'Guest' }, { kind: 'staff', id: LO });
    const m3 = await chat.postInboundReply(ep.reply_key, 'Reply from an external guest');
    ok(!!m3, 'postInboundReply(externalKey) still posts (guest path intact)');
    const lm3 = await lastMessage(convId);
    ok(lm3 && lm3.sender_kind === 'external' && /external guest/.test(lm3.body), 'external reply landed as the guest');

    // (5b) the PRIMARY Resend webhook's key extractor must preserve a CASE-
    // SENSITIVE key (base64url external keys contain A–Z) AND the hex member key.
    // Regression guard: a prior toLowerCase() mangled mixed-case guest keys so
    // #75 replies never resolved through inbound-file-email.js (found by #144 audit).
    const fileInbox = require(REPO + '/src/lib/file-inbox');
    const mixedKey = 'AbC0vQ_JkMiWa0XrmNY6fr3s';   // has uppercase, like a real base64url key
    ok(fileInbox.chatKeyFromRecipients([`chat+${mixedKey}@reply.test`]) === mixedKey,
      'chatKeyFromRecipients preserves a mixed-case external key (no lowercasing)');
    ok(fileInbox.chatKeyFromRecipients([`Chat+${bKey}@Reply.Test`]) === bKey,
      'chatKeyFromRecipients extracts the hex member key case-insensitively on the domain');
    ok(fileInbox.chatKeyFromRecipients([`chat+${mixedKey}@wrong.test`]) === null,
      'chatKeyFromRecipients rejects the wrong domain');

    // (6) a REMOVED member's key stops resolving (access can't outlive membership).
    await db.query(`UPDATE conversation_members SET removed_at=now() WHERE conversation_id=$1 AND member_kind='staff' AND member_id=$2`, [convId, LO]);
    const cntBefore = await msgCount(convId);
    const m4 = await chat.postInboundReply(loKey, 'Should NOT post — removed member');
    ok(m4 == null, 'removed member key no longer resolves (null)');
    ok(await msgCount(convId) === cntBefore, 'no message added for a removed member');

    // (7) an unknown key is a silent no-op.
    const m5 = await chat.postInboundReply('deadbeefdeadbeefdeadbeefdeadbeef', 'nope');
    ok(m5 == null, 'unknown key resolves to null');

    // (8) a borrower PII reply is TERMINAL (blocked, not posted, not thrown).
    const cnt8 = await msgCount(convId);
    let threw = false, m6;
    try { m6 = await chat.postInboundReply(bKey, 'my ssn is 123-45-6789'); } catch (_) { threw = true; }
    ok(!threw, 'borrower PII reply does not throw (terminal, swallowed)');
    ok(m6 == null, 'borrower PII reply is not posted (returns null)');
    ok(await msgCount(convId) === cnt8, 'no PII message added to the thread');
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM messages WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM conversation_external_participants WHERE conversation_id IN (SELECT id FROM conversations WHERE application_id=$1)`, [APP]).catch(() => {});
    await db.query(`DELETE FROM conversation_members WHERE conversation_id IN (SELECT id FROM conversations WHERE application_id=$1)`, [APP]).catch(() => {});
    await db.query(`DELETE FROM conversations WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [LO]).catch(() => {});
  }
  console.log(`\nchat-member-reply: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();

/**
 * CLOSING CHAIN — ROUND 6. The six items round 5 left open, each proven against a
 * real Postgres. Skips cleanly with no DATABASE_URL.
 *
 * Every assertion here was run against the PRE-FIX code first and observed to fail;
 * where the pre-fix behaviour is the interesting part it is named in the message.
 *
 *   A. a TRANSIENT storage failure no longer loses closing documents — the chain is
 *      left unmarked so a redelivery retries, and the content-hash dedupe stops the
 *      retry duplicating what already landed (which is what made withholding the
 *      marker unsafe before, and forced the always-write that lost the documents)
 *   B. a PERMANENT failure still marks the chain — retrying an undecodable
 *      attachment forever would block the marker for good
 *   C. inbound sender authentication is recorded, and 'unknown' is never a pass
 *   D. two closing-date changes racing: the stale one stands down
 *   E. one message carrying TWO closing tokens is recorded on BOTH files
 *   F. an attorney order on a finished deal leaves the Orders desk — as 'completed',
 *      never 'cancelled', so a human can still write to counsel afterwards
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-closing-chain-hardening (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';
process.env.ATTORNEY_GROUP_EMAIL = process.env.ATTORNEY_GROUP_EMAIL || 'teamag@privatelenderlaw.com';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

const db = require('../src/db');
const storage = require('../src/lib/storage');
const closingInbox = require('../src/lib/closing-inbox');
const closingPrep = require('../src/lib/closing-prep');
const closingThread = require('../src/lib/closing-thread');
const fileInbox = require('../src/lib/file-inbox');
const emailLog = require('../src/lib/email-log');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `cch-${process.pid}-${Date.now()}`;
const b64 = (s) => Buffer.from(s).toString('base64');

// The real 'none' provider answers {ok:false} on purpose, and sendOnThread honours
// res.ok — so without this stub every send here reads as a failure. Capturing the
// payload is also how "who was it actually addressed to" stays assertable.
const noop = require('../src/lib/email/noop');
const sends = [];
noop.sendMail = async (opts) => { sends.push(opts); return { ok: true, id: `stub-${sends.length}` }; };

(async () => {
  /* ─────────────────────────────── seed ──────────────────────────────────── */
  const officer = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Ophelia Officer','loan_officer',true) RETURNING id`,
    [`${uniq}-lo@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const mkApp = async (n) => (await db.query(
    `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status)
     VALUES ($1,$2,$3,$4,'processing') RETURNING id`,
    [borrower, officer, `YSCCH${n}${String(process.pid).slice(-4)}`,
     JSON.stringify({ oneLine: `${n} Chain St` })])).rows[0].id;
  const appA = await mkApp('1');
  const appB = await mkApp('2');

  /* ══════════════ A. a transient failure keeps the documents recoverable ════ */
  {
    const atts = [
      { filename: 'draft-hud.pdf', contentType: 'application/pdf', content: b64('%PDF-1.4 one') },
      { filename: 'deed.pdf', contentType: 'application/pdf', content: b64('%PDF-1.4 two') },
      { filename: 'title-commitment.pdf', contentType: 'application/pdf', content: b64('%PDF-1.4 three') },
    ];
    // Storage throws for everything AFTER the first — the shape of a real blip
    // (a disk that fills, a provider that starts refusing) rather than a clean
    // all-or-nothing failure.
    const realSave = storage.save;
    let n = 0;
    storage.save = async (buf, o) => { n += 1; if (n > 1) throw new Error('storage unavailable'); return realSave.call(storage, buf, o); };
    const res1 = await closingInbox.saveChainDocs({ applicationId: appA, attachments: atts, fromEmail: 'a@law.test', subject: 'closing' });
    storage.save = realSave;

    assert(res1.saved === 1 && res1.failed === 2, 'a storage blip mid-package files what it can and counts the rest');
    assert(res1.failedTransient === 2 && res1.failedPermanent === 0,
      'and reports them as RETRYABLE — collapsing them into one `failed` count is what made a blip indistinguishable from bad bytes');

    // The retry: same message, delivered again. Nothing is duplicated, and the two
    // that failed are recovered. Before the content-hash dedupe this could only be
    // done inside doc-dedup's 120-second window, which is why the caller had to
    // mark the chain handled and lose the documents instead.
    const res2 = await closingInbox.saveChainDocs({ applicationId: appA, attachments: atts, fromEmail: 'a@law.test', subject: 'closing' });
    assert(res2.saved === 2 && res2.deduped === 1 && res2.failed === 0,
      'the retry recovers exactly the two that failed and re-files none of the one that landed');

    const rows = (await db.query(
      `SELECT filename, count(*)::int AS n FROM documents
        WHERE application_id=$1 AND doc_kind=$2 GROUP BY filename ORDER BY filename`,
      [appA, closingInbox.DOC_KIND])).rows;
    assert(rows.length === 3 && rows.every((r) => r.n === 1),
      'all three documents are on the file exactly once — nothing lost, nothing duplicated');

    // THE WINDOW IS GONE, not merely widened. Backdate every row well past the old
    // 120-second dedupe window and re-deliver: a time-based guard would duplicate
    // the whole package here, which is the failure that forced the always-write marker.
    await db.query(`UPDATE documents SET created_at = now() - interval '3 days'
                     WHERE application_id=$1 AND doc_kind=$2`, [appA, closingInbox.DOC_KIND]);
    const res3 = await closingInbox.saveChainDocs({ applicationId: appA, attachments: atts, fromEmail: 'a@law.test', subject: 'closing' });
    assert(res3.saved === 0 && res3.deduped === 3,
      'a redelivery THREE DAYS later still duplicates nothing — the dedupe is on content, not on a clock');
    const total = (await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE application_id=$1 AND doc_kind=$2`,
      [appA, closingInbox.DOC_KIND])).rows[0].n;
    assert(total === 3, 'and the file still holds exactly three');

    // Different bytes under the same name IS a new document — a revised draft must
    // never be swallowed by the guard that stops redeliveries.
    const revised = await closingInbox.saveChainDocs({
      applicationId: appA, fromEmail: 'a@law.test', subject: 'closing',
      attachments: [{ filename: 'draft-hud.pdf', contentType: 'application/pdf', content: b64('%PDF-1.4 REVISED') }],
    });
    assert(revised.saved === 1 && revised.deduped === 0,
      'a REVISED draft under the same filename files normally — dedupe must not swallow a real new version');
  }

  /* ══════════════ B. a permanent failure is not retried forever ════════════ */
  {
    const res = await closingInbox.saveChainDocs({
      applicationId: appA, fromEmail: 'a@law.test', subject: 'closing',
      attachments: [{ filename: 'broken.pdf', contentType: 'application/pdf', content: '!!!not base64 at all!!!' }],
    });
    assert(res.failedPermanent === 1 && res.failedTransient === 0,
      'bytes that will not decode are PERMANENT — no redelivery can fix them, so they must not hold the chain open');
    const res2 = await closingInbox.saveChainDocs({
      applicationId: appA, fromEmail: 'a@law.test', subject: 'closing',
      attachments: [{ filename: 'empty.pdf', contentType: 'application/pdf', content: '' }],
    });
    assert(res2.failedTransient === 0, 'and so is an empty attachment');

    const gone = await closingInbox.saveChainDocs({
      applicationId: '00000000-0000-0000-0000-000000000000', fromEmail: 'a@law.test',
      attachments: [{ filename: 'x.pdf', content: b64('%PDF x') }],
    });
    assert(gone.failedPermanent === 1 && gone.failedTransient === 0,
      'a file that no longer exists is permanent too — holding the chain open for it would block the marker for good');
  }

  /* ══════════════ C. sender authentication is recorded, never assumed ══════ */
  {
    const auth = fileInbox._internals.senderAuth;
    const hdrs = (v) => ({ headers: { 'Authentication-Results': v } });
    assert(auth(hdrs('mx.test; spf=pass smtp.mailfrom=law.test; dkim=pass header.d=law.test; dmarc=pass')).verdict === 'pass',
      'a fully authenticated message reads as a pass');
    assert(auth(hdrs('mx.test; spf=fail smtp.mailfrom=law.test; dkim=none; dmarc=fail')).verdict === 'fail',
      'a spoofed sender reads as a fail');
    assert(auth(hdrs('mx.test; spf=softfail; dkim=none')).verdict === 'fail',
      'a softfail is not a pass');
    assert(auth(hdrs('mx.test; spf=pass smtp.mailfrom=list.test; dkim=fail; dmarc=pass')).verdict === 'pass',
      'DMARC is the aligned verdict and wins — a list rewrite failing DKIM is not a forgery');
    assert(auth({}).verdict === 'unknown' && auth({ headers: {} }).verdict === 'unknown',
      'NO headers is "unknown" — never silently a pass, which is the whole point of recording it');
    assert(auth({ headers: { 'Received-SPF': 'Pass (mx.test: domain of law.test designates ...)' } }).verdict === 'pass',
      'an older MTA that emits a standalone Received-SPF is still read');
    assert(auth({ headers: [{ name: 'Authentication-Results', value: 'mx; dkim=pass' }] }).verdict === 'pass',
      'and the array-shaped headers some providers return are read identically');

    // It reaches the database, which is what the card renders from.
    await emailLog.captureInbound({
      inboundId: 900000 + (process.pid % 1000), applicationId: appA, from: 'spoof@law.test',
      subject: 'Wire instructions', status: 'received',
      senderAuth: { spf: 'fail', dkim: null, dmarc: 'fail', verdict: 'fail' },
    });
    const row = (await db.query(
      `SELECT sender_auth FROM email_messages WHERE application_id=$1 AND direction='inbound'
        AND sender_auth->>'verdict'='fail' LIMIT 1`, [appA])).rows[0];
    assert(!!row && row.sender_auth.spf === 'fail',
      'an unauthenticated message is recorded on the file, so the card can warn before anyone opens the attachment');
  }

  /* ══════════════ D. a closing date that loses a race stands down ══════════ */
  {
    // Engage counsel on appB so announce() will actually consider a date.
    await db.query(
      `INSERT INTO file_orders (application_id, order_type, status, ordered_at)
       VALUES ($1,'attorney','ordered',now())
       ON CONFLICT (application_id, order_type) DO UPDATE SET status='ordered'`, [appB]);
    const thread = await closingThread.ensureThread(appB, { subject: 'Closing prep' });
    await db.query(
      `INSERT INTO closing_thread_messages (thread_id, application_id, event_kind, dedupe_key, status, to_emails, sent_at)
       VALUES ($1,$2,'order','order:1','sent','["teamag@privatelenderlaw.com"]'::jsonb, now())`,
      [thread.id, appB]);

    await db.query(`UPDATE applications SET expected_closing='2026-09-10' WHERE id=$1`, [appB]);
    // The LOSER of a race: it is announcing Sep 3 while the file already says Sep 10.
    const stale = await closingPrep.announce({
      applicationId: appB, eventKind: 'closing_date', dedupeKey: null, extra: { date: '2026-09-03' },
    });
    assert(stale && stale.skipped && stale.reason === 'superseded',
      'a date the file no longer holds is NOT announced — counsel must never be left holding the stale one');

    sends.length = 0;
    const winner = await closingPrep.announce({
      applicationId: appB, eventKind: 'closing_date', dedupeKey: null, extra: { date: '2026-09-10' },
    });
    assert(winner && winner.ok && !winner.skipped, 'and the date the file actually holds still goes out');
    assert(sends.length === 1 && /September 10, 2026/.test(sends[0].html || ''),
      'stating the date the file really has — the stand-down must not have cost counsel the real update');
  }

  /* ══════════════ E. one message, two closings, two records ═══════════════ */
  {
    const inboundId = 950000 + (process.pid % 1000);
    // The Email Center row is keyed on (message, FILE) — db/363. Before that a
    // reply-all carrying two closing addresses recorded on the first file only, and
    // the second file's team watched its counter tick up with nothing to read.
    for (const appId of [appA, appB]) {
      await emailLog.captureInbound({
        inboundId, applicationId: appId, from: 'attorney@law.test',
        subject: 'Both closings', status: 'received', msgType: 'closing_message',
        threadKey: `${appId}:closing#test`,
      });
    }
    const rows = (await db.query(
      `SELECT application_id, thread_key FROM email_messages WHERE inbound_id=$1 ORDER BY application_id`,
      [inboundId])).rows;
    assert(rows.length === 2, 'one inbound message carrying two closing addresses is recorded on BOTH files');
    assert(new Set(rows.map((r) => r.application_id)).size === 2,
      'on two different files, not twice on one');
    assert(rows.every((r) => r.thread_key === `${r.application_id}:closing#test`),
      'each copy pinned to its OWN chain — one file’s copy filed under the other’s chain would be worse than none');

    // Still exactly one row per (message, file): a redelivery updates, never inserts.
    for (const appId of [appA, appB]) {
      await emailLog.captureInbound({ inboundId, applicationId: appId, from: 'attorney@law.test',
        subject: 'Both closings', status: 'forwarded', msgType: 'closing_message' });
    }
    const again = (await db.query(`SELECT count(*)::int AS n FROM email_messages WHERE inbound_id=$1`, [inboundId])).rows[0].n;
    assert(again === 2, 'and a webhook redelivery still updates in place rather than inserting more');
  }

  /* ══════════════ F. a finished deal leaves the Orders desk ═══════════════ */
  {
    // appB has a live attorney order. Fund it: the closing has happened.
    await db.query(`UPDATE applications SET status='funded' WHERE id=$1`, [appB]);
    const before = (await db.query(
      `SELECT status FROM file_orders WHERE application_id=$1 AND order_type='attorney'`, [appB])).rows[0].status;
    assert(before === 'ordered', 'the order is still open before the sweep runs');

    const n = await closingPrep.retireClosedOrdersOnce();
    assert(n >= 1, 'the sweep retires it');
    const after = (await db.query(
      `SELECT status FROM file_orders WHERE application_id=$1 AND order_type='attorney'`, [appB])).rows[0].status;
    assert(after === 'completed', "as 'completed' — nothing ever wrote it, so every closed deal sat on the desk forever");

    // THE DISTINCTION THAT MATTERS. 'cancelled' would read as a stand-down and shut
    // the human doors — writing to closing counsel after funding (the recorded
    // mortgage, the final policy, a payoff letter) is the normal case, and killing
    // it was exactly the round-5 regression.
    assert(await closingPrep.orderIsLive(appB),
      'a human can STILL write to counsel on a funded file — completed is not a stand-down');
    assert(!(await closingPrep.mayAnnounce(appB)),
      'while the automatic updates correctly stop');

    // Idempotent, and it never revives a cancelled order.
    const n2 = await closingPrep.retireClosedOrdersOnce();
    const stillCompleted = (await db.query(
      `SELECT status FROM file_orders WHERE application_id=$1 AND order_type='attorney'`, [appB])).rows[0].status;
    assert(stillCompleted === 'completed', 're-running the sweep changes nothing');
    await db.query(`UPDATE file_orders SET status='cancelled' WHERE application_id=$1 AND order_type='attorney'`, [appB]);
    await closingPrep.retireClosedOrdersOnce();
    const cancelled = (await db.query(
      `SELECT status FROM file_orders WHERE application_id=$1 AND order_type='attorney'`, [appB])).rows[0].status;
    assert(cancelled === 'cancelled', 'and it never revives an order somebody deliberately cancelled');
    void n2;

    // A HUMAN'S REOPEN STICKS. There is still real work with counsel after funding
    // (a payoff letter, the recorded mortgage), so someone putting the order back on
    // the desk must not watch a sweep close it again half an hour later.
    await db.query(`UPDATE file_orders SET status='ordered' WHERE application_id=$1 AND order_type='attorney'`, [appB]);
    await closingPrep.retireClosedOrdersOnce();
    const reopened = (await db.query(
      `SELECT status FROM file_orders WHERE application_id=$1 AND order_type='attorney'`, [appB])).rows[0].status;
    assert(reopened === 'ordered',
      'an order a human deliberately reopened on a funded file is NOT re-retired — the sweep runs once per order, never in a loop against the user');

    // The one definition both the gate and the sweep read.
    assert(closingPrep.DEAD_DEAL_STATUSES.join(',') === 'funded,declined,withdrawn,cancelled'
      && closingPrep.DEAD_DEAL_SQL === "('funded','declined','withdrawn','cancelled')",
      'the dead-deal list is ONE definition shared by the live gate and the sweep SQL — drift re-arms the starvation');
  }

  /* ─────────────────────────────── cleanup ───────────────────────────────── */
  await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[appA, appB]]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrower]);
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [officer]);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll closing-chain hardening checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

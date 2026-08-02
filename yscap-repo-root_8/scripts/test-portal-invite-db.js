'use strict';
/**
 * WHERE EACH BORROWER STANDS WITH THE PORTAL — proven end to end, for the
 * borrower AND the co-borrower (owner-directed 2026-08-02).
 *
 * The complaint behind this: the two "Invite" buttons were WRITE-ONLY. You
 * pressed one, a green line appeared for a second, and nothing on the screen
 * ever said it had happened — so nobody could answer "has anyone invited this
 * person?" and the only safe move was to send it again.
 *
 * What is proven here, against a real Postgres and the real HTTP doors:
 *   A. the columns exist and the profile door reports the standing
 *   B. inviting RECORDS it — including the case that used to record NOTHING
 *      (a person who already has a login gets a sign-in link, which mints no
 *      invite token, so the old "read it out of invite_tokens" idea was blind)
 *   C. the CO-BORROWER gets the same treatment through the same door
 *   D. re-sending counts up, keeps the FIRST stamp, and records who sent it
 *   E. joined / last-signed-in come from the login itself
 *   F. an invitation to a since-corrected address reads as stale
 *   G. has_account is on the profile door at all — it never was (side bug)
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-portal-invite-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const { ensureSchema } = require('../src/migrate-boot');
const P = require('../src/lib/portal-invite');
const app = require('../src/server');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };
const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
const made = { borrowers: [], apps: [], staff: [] };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  await ensureSchema();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  try {
    // ---- A. the columns are there, and the profile door reports the standing --
    const cols = (await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='borrowers' AND column_name LIKE 'portal_%'`)).rows.map((r) => r.column_name);
    for (const c of ['portal_invited_at', 'portal_first_invited_at', 'portal_invite_count',
      'portal_invited_by', 'portal_invited_email']) {
      ok(cols.includes(c), `the borrowers table carries ${c}`);
    }

    const loId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Pia Invite','loan_officer',true,false,'x',0) RETURNING id`, [`pi-lo-${sfx}@test.local`])).rows[0].id;
    made.staff.push(loId);
    const loTok = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });

    const mk = (first, mail) => db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'Portal',$2) RETURNING id`,
      [first, mail]).then((r) => { made.borrowers.push(r.rows[0].id); return r.rows[0].id; });
    const primaryId = await mk('Perry', `pi-p-${sfx}@test.local`);
    const coId = await mk('Cora', `pi-c-${sfx}@test.local`);
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, status, loan_type,
                                 property_address)
       VALUES ($1,$2,$3,'file_intake','Purchase - Fix & Flip',$4) RETURNING id`,
      [primaryId, coId, loId, JSON.stringify({ oneLine: '9 Hooper St, Brooklyn, NY 11211' })])).rows[0].id;
    made.apps.push(appId);

    const profile = (id) => call(server, 'GET', `/api/staff/borrowers/${id}`, loTok);
    const invite = (id) => call(server, 'POST', `/api/staff/borrowers/${id}/portal-invite`, loTok);

    {
      const r = await profile(primaryId);
      ok(r.status === 200 && r.body && r.body.portal, 'the profile door reports a portal block');
      ok(r.body.portal.state === 'not_invited',
        'a borrower nobody has invited reads NOT INVITED — not a blank');
      ok(r.body.portal.canInvite === true, '…and can be invited, because they have an email');
      // G. the side bug: has_account was returned by the LIST door and not by the
      // one screen that shows a single person.
      ok(r.body.has_account === false,
        'has_account is on the profile door (it never was — the pill could not be right)');
    }

    // ---- B. inviting RECORDS it ------------------------------------------------
    {
      const r = await invite(primaryId);
      ok(r.status === 200, 'the invite door answers 200');
      const p = (await profile(primaryId)).body.portal;
      ok(p.state === 'invited', 'and the profile now says INVITED');
      ok(p.inviteCount === 1, '…once');
      ok(!!p.invitedAt && !!p.firstInvitedAt, '…with a timestamp on both the first and the last');
      ok(p.invitedByName === 'Pia Invite', '…and it names who sent it');
      ok(/invited/i.test(p.headline) && /have not joined yet/i.test(p.headline),
        '…worded for a human, not a raw date');
    }

    // ---- C. the CO-BORROWER, through the same door ----------------------------
    {
      const r = await invite(coId);
      ok(r.status === 200, 'the CO-borrower can be invited through the same door');
      const p = (await profile(coId)).body.portal;
      ok(p.state === 'invited' && p.inviteCount === 1,
        'and their OWN standing is recorded — the whole point of the request');
      const pp = (await profile(primaryId)).body.portal;
      ok(pp.inviteCount === 1,
        "…without touching the primary's count (two people, two records)");
    }

    // ---- D. sending again counts up and keeps the FIRST stamp ------------------
    {
      const before = (await profile(primaryId)).body.portal;
      await new Promise((r) => setTimeout(r, 25));
      await invite(primaryId);
      await invite(primaryId);
      const p = (await profile(primaryId)).body.portal;
      ok(p.inviteCount === 3, 'a third send reads as a third send');
      ok(String(p.firstInvitedAt) === String(before.firstInvitedAt),
        'the FIRST invitation stamp never moves — it is what "sitting on it for weeks" is measured from');
      ok(new Date(p.invitedAt).getTime() >= new Date(before.invitedAt).getTime(),
        '…while the LAST one does');
      ok(/sent 3 times/.test(p.headline), '…and the sentence says so');
    }

    // ---- E. joined / last signed in come from the login itself ----------------
    {
      await db.query(
        `INSERT INTO borrower_auth (borrower_id, password_hash, created_at, last_login_at)
         VALUES ($1,'x', now() - interval '30 days', now() - interval '1 day')
         ON CONFLICT (borrower_id) DO UPDATE SET last_login_at = EXCLUDED.last_login_at`, [primaryId]);
      const p = (await profile(primaryId)).body.portal;
      ok(p.state === 'joined', 'once they have a login the standing flips to JOINED');
      ok(p.hasAccount === true && !!p.joinedAt, '…carrying when they joined');
      ok(/yesterday/.test(p.detail || ''), '…and when they last signed in');

      // THE CASE THAT USED TO RECORD NOTHING: a person who already has a login is
      // sent a SIGN-IN link, which mints no invite token — so reading the history
      // out of invite_tokens would have shown this send as never having happened.
      const before = p.inviteCount;
      const r = await invite(primaryId);
      ok(r.status === 200 && r.body.hasAccount === true, 'they are emailed a sign-in link');
      const after = (await profile(primaryId)).body.portal;
      ok(after.inviteCount === before + 1,
        'and THAT send is recorded too — the case an invite-token history would have missed');
    }

    // ---- F. an invitation sent to a since-corrected address is stale -----------
    {
      const p0 = (await profile(coId)).body.portal;
      ok(p0.invitedEmailStale === false, 'while the address still matches, nothing is flagged');
      await db.query(`UPDATE borrowers SET email=$2 WHERE id=$1`,
        [coId, `pi-c-moved-${sfx}@test.local`]);
      const p = (await profile(coId)).body.portal;
      ok(p.invitedEmailStale === true,
        'after the email is corrected, the old invitation reads as stale');
      ok(/not the address on the profile/i.test(p.detail || ''),
        '…and the screen says to send it again rather than counting it as "we told them"');
    }

    // ---- the recorder itself can never break an invitation --------------------
    {
      const bad = await P.recordInviteSent('not-a-uuid', { email: 'x@y.z' });
      ok(bad === false, 'a broken call returns false — it never throws at the invite door');
      const none = await P.recordInviteSent(null, {});
      ok(none === false, '…and a missing id is simply refused');
    }

    // ---- PREVIOUS FILES: the backfill recovers invitations already sent -------
    // Every invitation that DID mint a token is recovered on the first deploy, so
    // the panel is populated for the back book rather than only going forward.
    // It is deliberately scoped to an UNAMBIGUOUS mailbox — db/318 lets two
    // profiles share one address, and a token names an email, not a person.
    {
      const fs = require('fs');
      const path = require('path');
      const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '409_portal_invite_state.sql'), 'utf8');

      const oldId = await mk('Olden', `pi-old-${sfx}@test.local`);
      await db.query(
        `INSERT INTO invite_tokens (token_hash,kind,email,created_by,expires_at,created_at)
         VALUES ($1,'borrower',$2,$3, now() + interval '14 days', now() - interval '30 days'),
                ($4,'borrower',$2,$3, now() + interval '14 days', now() - interval '5 days')`,
        [`h1-${sfx}`, `pi-old-${sfx}@test.local`, loId, `h2-${sfx}`]);

      // Two people on ONE mailbox — the case the email key genuinely cannot tell
      // apart, and the reason the backfill leaves them alone.
      const shareMail = `pi-share-${sfx}@test.local`;
      const shareA = (await db.query(
        `INSERT INTO borrowers (first_name,last_name,email,shares_email) VALUES ('Shara','Portal',$1,false) RETURNING id`,
        [shareMail])).rows[0].id;
      const shareB = (await db.query(
        `INSERT INTO borrowers (first_name,last_name,email,shares_email) VALUES ('Sherb','Portal',$1,true) RETURNING id`,
        [shareMail])).rows[0].id;
      made.borrowers.push(shareA, shareB);
      await db.query(
        `INSERT INTO invite_tokens (token_hash,kind,email,created_by,expires_at)
         VALUES ($1,'borrower',$2,$3, now() + interval '14 days')`, [`h3-${sfx}`, shareMail, loId]);

      await db.query(sql);

      const back = (await db.query(
        `SELECT portal_invited_at, portal_first_invited_at, portal_invite_count, portal_invited_by
           FROM borrowers WHERE id=$1`, [oldId])).rows[0];
      ok(Number(back.portal_invite_count) === 2,
        'the backfill recovers BOTH invitations already sent to this person');
      ok(back.portal_first_invited_at && back.portal_invited_at
        && new Date(back.portal_first_invited_at) < new Date(back.portal_invited_at),
        '…as a first and a last, in the right order');
      ok(String(back.portal_invited_by) === String(loId), '…crediting whoever sent the last one');

      const shared = (await db.query(
        `SELECT portal_invite_count FROM borrowers WHERE id = ANY($1::uuid[])`, [[shareA, shareB]])).rows;
      ok(shared.every((r) => Number(r.portal_invite_count) === 0),
        'two people on ONE mailbox are LEFT ALONE — one spouse’s invitation is never credited to the other');

      // Idempotent, and it can never overwrite a live stamp.
      const liveBefore = (await db.query(
        `SELECT portal_invite_count FROM borrowers WHERE id=$1`, [primaryId])).rows[0].portal_invite_count;
      await db.query(sql);
      const twice = (await db.query(
        `SELECT portal_invite_count FROM borrowers WHERE id=$1`, [oldId])).rows[0].portal_invite_count;
      ok(Number(twice) === 2, 're-running it on the next boot changes nothing');
      const liveAfter = (await db.query(
        `SELECT portal_invite_count FROM borrowers WHERE id=$1`, [primaryId])).rows[0].portal_invite_count;
      ok(String(liveAfter) === String(liveBefore),
        '…and it never overwrites a count the live code already wrote');

      await db.query(`DELETE FROM invite_tokens WHERE token_hash = ANY($1::text[])`,
        [[`h1-${sfx}`, `h2-${sfx}`, `h3-${sfx}`]]).catch(() => {});
    }

    // ---- the reader shapes many borrowers at once ------------------------------
    {
      const m = await P.portalStateFor([primaryId, coId]);
      ok(m.size === 2, 'portalStateFor reads several people at once');
      ok(m.get(String(primaryId)).hasAccount === true
        && m.get(String(coId)).hasAccount === false,
        '…keeping each person’s answer to themselves');
      const empty = await P.portalStateFor([]);
      ok(empty.size === 0, 'an empty ask is an empty answer, not a query');
    }
  } finally {
    for (const a of made.apps) await db.query('DELETE FROM applications WHERE id=$1', [a]).catch(() => {});
    for (const b of made.borrowers) {
      await db.query('DELETE FROM borrower_auth WHERE borrower_id=$1', [b]).catch(() => {});
      await db.query('DELETE FROM borrowers WHERE id=$1', [b]).catch(() => {});
    }
    for (const s of made.staff) await db.query('DELETE FROM staff_users WHERE id=$1', [s]).catch(() => {});
    await new Promise((r) => server.close(r));
  }

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  portal-invite-db: the file says where BOTH borrowers stand with the portal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

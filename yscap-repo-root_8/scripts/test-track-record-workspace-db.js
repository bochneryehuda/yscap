'use strict';
/**
 * THE WORKSPACE — real HTTP, real Postgres.
 *
 * The one that matters most is §5: THE SERVER refuses a bulk confirm on a line
 * carrying a contradicted or unproved check. The blueprint says so explicitly,
 * and it is right — a screen can be bypassed, a screen can be stale, and this is
 * the single action that credits a borrower without anyone reading anything. So
 * this test calls the route DIRECTLY, with no screen involved at all.
 *
 * §3 is the other half of the same doctrine: confirming a check needs sign-off
 * because it can only ADD credit; rejecting and asking for a document can only
 * withhold it, so anyone on the file may do those the moment they notice
 * something.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP track-record workspace (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const tag = `trws_${process.pid}`;

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const C = require('../src/lib/crypto');

  const mkStaff = async (role, email) => {
    const r = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'WS Tester',$2,true) RETURNING id, token_version`,
      [email, role])).rows[0];
    return { id: r.id, role, token: C.signJwt({ sub: r.id, kind: 'staff', role, tv: r.token_version || 0 }) };
  };
  const call = (path, opts, who) => fetch(`${base}${path}`, {
    ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}`, ...(opts && opts.headers) },
  });

  const signer = await mkStaff('underwriter', `${tag}_u@example.com`);
  const clerk = await mkStaff('loan_officer', `${tag}_lo@example.com`);

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('WS','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;
  // The officer is given real access, so the refusals below are the ones this
  // work adds rather than the scope check answering first.
  await db.query(`UPDATE borrowers SET primary_officer_id=$2 WHERE id=$1`, [borrowerId, clerk.id]);

  const mkLine = async (n, over = {}) => {
    const id = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_date, sale_date)
       VALUES ($1,$2::jsonb,'flip','2024-02-01','2025-06-15') RETURNING id`,
      [borrowerId, JSON.stringify({ line1: `${n} Workspace Way`, city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;
    for (const [p, v] of Object.entries(over)) {
      await db.query(
        `UPDATE track_record_pillars SET auto_verdict=$3, auto_source='elementix', auto_confidence='certain',
                auto_grade='strong', auto_evidence=$4::jsonb
          WHERE track_record_id=$1 AND pillar=$2`,
        [id, p, v, JSON.stringify({ snippet: `a quotable line about ${p}`, recordingDate: '2025-06-20' })]);
    }
    return id;
  };

  const clean = await mkLine(1, { recency: 'proved', ownership: 'proved', exit: 'proved' });
  const disputed = await mkLine(2, { recency: 'proved', ownership: 'contradicted', exit: 'proved' });
  const thin = await mkLine(3, { recency: 'proved', ownership: 'no_data', exit: 'no_data' });

  const pillarOf = async (trId, name) => (await db.query(
    `SELECT id FROM track_record_pillars WHERE track_record_id=$1 AND pillar=$2`, [trId, name])).rows[0].id;

  console.log('\n1. The queue is grouped by person and ordered by what is most urgent');
  {
    const r = await call('/api/staff/track-record-workspace', {}, signer);
    ok(r.status === 200, 'the queue answers');
    const q = await r.json();
    const g = q.groups.find((x) => String(x.borrowerId) === String(borrowerId));
    ok(!!g && g.lines.length === 3, 'this borrower\'s three projects are ONE group, not three rows in a flat list');
    ok(g.lines[0].id === disputed,
      'the project the records DISAGREE with is first — it is the state most likely to change a loan');
    ok(g.contradicted === 1, '…and the group says how many disagree, so the list can be triaged without opening anything');
    ok(g.lines.every((l) => l.readiness && typeof l.readiness.message === 'string'),
      'every line carries its readiness sentence, computed on the server');
    ok(g.lines.every((l) => l.bulk && typeof l.bulk.ok === 'boolean'),
      '…and whether a bulk confirm would be allowed, so the button can never promise what the server refuses');
  }

  console.log('\n2. One project\'s whole story, with the evidence quoted');
  {
    const d = await (await call(`/api/staff/track-records/${clean}/workspace`, {}, signer)).json();
    ok(d.cards.length === 3, 'three evidence cards');
    ok(d.cards.every((c) => c.snippet && c.claim && c.next && c.next.hint),
      'each with a claim, a VERBATIM snippet and a next step that explains itself');
    ok(d.cards.every((c) => c.pillarId), '…and the row id a decision gets posted to');
    ok(d.cards[0].next.key === 'confirm' && d.cards[0].next.tone === 'primary',
      'a machine-proved check leads with Confirm');
    const t = await (await call(`/api/staff/track-records/${thin}/workspace`, {}, signer)).json();
    const own = t.cards.find((c) => c.pillar === 'ownership');
    ok(own.next.key === 'ask_doc' && own.next.tone === 'primary',
      'while a check with nothing behind it leads with "Ask for a document"');
    ok(own.neutral === true && /not a problem with the borrower/.test(own.meaning),
      '…painted NEUTRAL, saying plainly that a records gap is not the borrower\'s fault');
  }

  console.log('\n3. Confirming needs sign-off; rejecting and asking do not');
  {
    const pid = await pillarOf(clean, 'recency');
    const no = await call(`/api/staff/track-record-pillars/${pid}/decide`, {
      method: 'POST', body: JSON.stringify({ verdict: 'confirmed' }) }, clerk);
    ok(no.status === 403, `an officer cannot confirm a check (${no.status})`);
    ok(/needs sign-off/.test((await no.json()).error), '…and the refusal says why and what they CAN do');

    const yes = await call(`/api/staff/track-record-pillars/${pid}/decide`, {
      method: 'POST', body: JSON.stringify({ verdict: 'confirmed' }) }, signer);
    ok(yes.status === 200, 'somebody with sign-off can');
    const body = await yes.json();
    ok(/Still waiting on ownership, exit/.test(body.readiness.message),
      '…and the answer says what is still outstanding, naming only those');

    const row = (await db.query('SELECT human_verdict, human_by, auto_verdict FROM track_record_pillars WHERE id=$1', [pid])).rows[0];
    ok(row.human_verdict === 'confirmed' && String(row.human_by) === String(signer.id), 'the human answer is recorded, with who');
    ok(row.auto_verdict === 'proved',
      'and the MACHINE\'s answer is untouched — a person agreeing does not overwrite the observation');

    const other = await pillarOf(thin, 'exit');
    const noReason = await call(`/api/staff/track-record-pillars/${other}/decide`, {
      method: 'POST', body: JSON.stringify({ verdict: 'rejected' }) }, clerk);
    ok(noReason.status === 400 && /Say why/.test((await noReason.json()).error),
      'a rejection with no reason is refused — somebody months from now has to be able to read it');
    const rej = await call(`/api/staff/track-record-pillars/${other}/decide`, {
      method: 'POST', body: JSON.stringify({ verdict: 'rejected', note: 'the lease is for a different unit' }) }, clerk);
    ok(rej.status === 200, 'an officer CAN reject — withholding credit never needs authority');
    const notes = await (await call(`/api/staff/track-record-notes?subjectKind=pillar&subjectId=${other}`, {}, signer)).json();
    ok(notes.notes.length === 1 && /different unit/.test(notes.notes[0].body),
      '…and their reason is filed as an internal note on that check');
  }

  console.log('\n4. Undo puts it back');
  {
    const pid = await pillarOf(clean, 'recency');
    const r = await call(`/api/staff/track-record-pillars/${pid}/decide`, {
      method: 'POST', body: JSON.stringify({ verdict: '' }) }, signer);
    ok(r.status === 200, 'a decision can be taken back');
    const row = (await db.query('SELECT human_verdict, human_by, human_at FROM track_record_pillars WHERE id=$1', [pid])).rows[0];
    ok(row.human_verdict === null && row.human_by === null && row.human_at === null,
      '…clearing the answer, who and when together — a half-cleared row would read as answered by nobody');
  }

  console.log('\n5. THE SERVER refuses a bulk confirm — with no screen involved');
  {
    const bad = await call(`/api/staff/track-records/${disputed}/pillars/bulk-confirm`, { method: 'POST', body: '{}' }, signer);
    ok(bad.status === 422, `a line the records DISAGREE with is refused (${bad.status})`);
    const b = await bad.json();
    ok(/disagree/.test(b.error) && b.code === 'bulk_refused', '…with a reason a reviewer can act on');
    ok((await db.query(
      `SELECT count(*)::int n FROM track_record_pillars WHERE track_record_id=$1 AND human_verdict IS NOT NULL`,
      [disputed])).rows[0].n === 0, '…and NOTHING was confirmed');

    const thinR = await call(`/api/staff/track-records/${thin}/pillars/bulk-confirm`, { method: 'POST', body: '{}' }, signer);
    ok(thinR.status === 422 && /nothing proving them/.test((await thinR.json()).error),
      'a line with unproved checks is refused too — bulk only covers what the records proved');

    const noAuth = await call(`/api/staff/track-records/${clean}/pillars/bulk-confirm`, { method: 'POST', body: '{}' }, clerk);
    ok(noAuth.status === 403, 'and an officer cannot bulk-confirm at all');

    const good = await call(`/api/staff/track-records/${clean}/pillars/bulk-confirm`, { method: 'POST', body: '{}' }, signer);
    ok(good.status === 200, 'a line the records proved end to end is allowed');
    const g = await good.json();
    ok(g.confirmed === 3 && g.readiness.ready === true, `…confirming all three at once (${g.confirmed})`);
    ok((await db.query(
      `SELECT count(*)::int n FROM track_record_pillars WHERE track_record_id=$1 AND human_verdict='confirmed'`,
      [clean])).rows[0].n === 3, 'and the database agrees');

    const again = await call(`/api/staff/track-records/${clean}/pillars/bulk-confirm`, { method: 'POST', body: '{}' }, signer);
    ok(again.status === 422, 'running it again is refused rather than silently re-stamping somebody\'s decision');
  }

  console.log('\n6. Everything the screen renders comes from the shared pure module');
  {
    const PA = require('../src/lib/track-record/pillar-actions');
    const d = await (await call(`/api/staff/track-records/${disputed}/workspace`, {}, signer)).json();
    const rows = (await db.query('SELECT * FROM track_record_pillars WHERE track_record_id=$1 ORDER BY pillar', [disputed])).rows;
    ok(JSON.stringify(d.bulk) === JSON.stringify(PA.bulkConfirmRefusal(rows)),
      'the refusal the detail returns is byte-for-byte the one the pure rule computes');
    ok(JSON.stringify(d.readiness) === JSON.stringify(PA.lineReadiness(rows)),
      '…and so is the readiness sentence — the route and the screen can never disagree');

    const fs = require('fs'); const path = require('path');
    /* STRIP THE COMMENTS FIRST — for the THIRD time in this rebuild. The screen's
       own header explains the `var(--ink)` trap, so a naive grep matches the
       WARNING and fails on correct code. The rule generalises: a source guard
       must read code, never prose, or the clearest-documented file in the repo
       is the one that fails it. */
    const screen = fs.readFileSync(path.join(__dirname, '../app-v2/src/screens/StaffTrackRecordWorkspace.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/bulkConfirmRefusal|lineReadiness/.test(screen),
      'and the screen never re-computes either — it renders what came back');
    ok(!/var\(--ink/.test(screen),
      'no text colour reads from an --ink token — every one of them is a LIGHT paper colour in this palette');
  }

  console.log('\n7. The old screen is gone, not left alongside');
  {
    const fs = require('fs'); const path = require('path');
    ok(!fs.existsSync(path.join(__dirname, '../app-v2/src/screens/StaffTrackRecordReviews.jsx')),
      'the previous track-record screen is retired — two of them on one screen is the complaint this rebuild started from');
    /* COMMENTS STRIPPED — for the FOURTH time in this rebuild, and this one was
       caught by its own mutation test rather than by review. The note in the hub
       explaining WHY the tab went necessarily spells the route out, so a naive
       grep matches the prose and the assertion passes with the link deleted.
       Read code, never prose. */
    const approvals = fs.readFileSync(path.join(__dirname, '../app-v2/src/screens/StaffApprovals.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/StaffTrackRecordReviews/.test(approvals),
      'and the retired screen is not mounted in the Approvals hub either');
    /* THE WORKSPACE LEFT THE HUB, AND THE REQUIREMENT DID NOT — re-pointed, not
       relaxed, the same way its twin in test-track-record-pending-review-pure
       was. The owner took the tab out on 2026-08-26 ("I don't know why the
       admin has a section for track record verification"), so asserting the
       hub MOUNTS it now pins a decision they reversed. This section's subject
       is "the old screen is gone, not left alongside" — that is the line
       above, and it is untouched. What the mount was additionally proving is
       that the workspace is REACHABLE, so that is asserted where it now lives:
       its own full-screen route, plus the hub still naming it and offering the
       way through (it keeps counting these in its badge, so it must). */
    const appjsx = fs.readFileSync(path.join(__dirname, '../app-v2/src/App.jsx'), 'utf8');
    ok(/path="\/internal\/track-record"/.test(appjsx) && /StaffTrackRecordWorkspace/.test(appjsx),
      '…and the workspace is reachable on its own full-screen route');
    // The ANCHOR — the route also appears in the old-bookmark redirect, so a
    // bare substring test passes with the link deleted (proven by mutation).
    ok(/href="#\/internal\/track-record"/.test(approvals),
      '…with the Approvals hub, which still counts these, linking through to it');
  }

  console.log('\n8. The scope check still holds');
  {
    const stranger = await mkStaff('loan_officer', `${tag}_x@example.com`);
    const r = await call(`/api/staff/track-records/${clean}/workspace`, {}, stranger);
    ok(r.status === 403, 'an officer with no connection to this borrower cannot open their project');
    const q = await (await call('/api/staff/track-record-workspace', {}, stranger)).json();
    ok(!q.groups.some((g) => String(g.borrowerId) === String(borrowerId)),
      '…and the borrower is not in their queue at all');
    await db.query('DELETE FROM staff_users WHERE id=$1', [stranger.id]).catch(() => {});
  }

  for (const id of [clean, disputed, thin]) {
    await db.query('DELETE FROM track_record_notes WHERE subject_id IN (SELECT id FROM track_record_pillars WHERE track_record_id=$1)', [id]).catch(() => {});
  }
  await db.query('DELETE FROM track_record_notes WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM checklist_items WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${tag}%`]).catch(() => {});
  server.close();

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  one screen, one queue, and the SERVER is what refuses a bulk confirm');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

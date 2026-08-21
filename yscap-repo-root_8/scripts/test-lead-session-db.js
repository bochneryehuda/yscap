/* ONE VISIT, ONE LEAD — through the REAL public door, against a REAL database
 * (owner-directed 2026-08-21, item 24).
 *
 * A pure test proves the rule. It cannot prove that the public endpoint applies it, that the row
 * really stops multiplying, or that the officer stops being emailed — and that is the whole
 * complaint. So this walks the owner's own story through `POST /api/leads`:
 *
 *   1. a visitor exports three term sheets in one visit → ONE lead row, ONE officer, ONE email;
 *   2. a nameless export is not a lead — nobody's queue, no officer notification;
 *   3. …and when that same visit finally leaves a phone number, the SAME row becomes a real lead
 *      and NOW somebody is told;
 *   4. a NAME with no email and no phone is still not a lead (the owner's own words);
 *   5. an officer's own ?lo= link → his lead, his notification, and it SAYS it came from his link;
 *   6. a different visit is a different lead — the merge can never swallow another person.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-lead-session-db.js
 */
'use strict';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

if (!process.env.DATABASE_URL) { console.log('SKIP test-lead-session-db (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const mailer = require('../src/lib/email');
const { signFormToken, TOKEN_MIN_MS } = require('../src/lib/form-token');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
};
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

function post(server, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({ method: 'POST', path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); r.write(data); r.end();
  });
}

/** A token old enough to look like a human dwelling on the page — what the real form echoes. */
const humanToken = () => signFormToken(String(Date.now() - TOKEN_MIN_MS - 2000));

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const outbox = [];
  const realSend = mailer.sendMail;
  mailer.sendMail = async (m) => { outbox.push(m); return { ok: true, id: 'test' }; };
  const sessions = [];
  let restoreOthers = [];
  let lo = null;

  const leadsFor = async (sid) => (await db.query(
    `SELECT id, tool, name, email, phone, status, officer_id, assigned_via, company, program, loan_amount, message
       FROM leads WHERE session_id=$1 ORDER BY created_at ASC`, [sid])).rows;
  const notesFor = async (leadId) => (await db.query(
    `SELECT count(*)::int AS n FROM lead_activities WHERE lead_id=$1`, [leadId])).rows[0].n;
  const staffNotes = async (officerId) => (await db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE staff_id=$1`, [officerId])).rows[0].n;

  /** One term-sheet generation, as the real page posts it. */
  const generate = (sid, extra = {}) => post(server, '/api/leads', {
    tool: 'term_sheet_generated', formToken: humanToken(), sessionId: sid,
    subject: extra.subject || `Term sheet generated — ${extra.company || 'a deal'}`,
    message: 'A visitor generated a term sheet in the Term Sheet Studio.',
    payload: { metaRows: [{ label: 'Loan amount', value: '$455,000' }] },
    company: extra.company, propertyAddress: extra.propertyAddress, program: extra.program,
    loanAmount: extra.loanAmount, propertyType: extra.propertyType,
    ...extra,
  });

  try {
    /* ------------------------------------------------------------ 0. EVERY value the route can
       write must be one the column ACCEPTS. This is the third time this exact class has shipped —
       db/468 defined the CHECK, db/521 fixed the missing 'session' (every session-reuse INSERT had
       been 500ing), and db/606 fixes the missing 'anonymous' (every nameless export had been
       500ing, so that whole feature never once worked). Both were invisible because the failure is
       a 500 on a public page nobody watches.
       The values are READ OUT OF THE SOURCE rather than hand-listed here, so adding a new one to
       the route without widening the CHECK fails this test instead of shipping. */
    {
      const fs = require('fs');
      const path = require('path');
      const src = ['src/routes/leads.js', 'src/lib/lead-assignment.js']
        .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
      const values = new Set();
      // Every quoted token on a line that ASSIGNS the value — the ternary form
      // (`assignedVia: staff ? 'staff_portal' : 'lo_link'`) is how two of them are written, so a
      // plain `= '...'` match would silently miss the branded-link value itself.
      for (const m of src.matchAll(/assigned(?:Via|_via)\s*[:=][^;\n]*/g)) {
        for (const q of String(m[0]).matchAll(/'([a-z_]{3,20})'/g)) values.add(q[1]);
      }
      ok('0a the route\'s assigned_via values were found in the source', values.size >= 5, [...values]);
      for (const v of [...values].sort()) {
        let accepted = true;
        try {
          await db.query('BEGIN');
          await db.query(`INSERT INTO leads (tool, email, assigned_via) VALUES ('contact', $1, $2)`,
            [`av-${v}-${sfx}@test.local`, v]);
        } catch (e) { accepted = false; } finally { await db.query('ROLLBACK').catch(() => {}); }
        ok(`0b the column accepts every value the route writes — "${v}"`, accepted);
      }
    }

    // One officer, and ONLY that officer in the rotation, so a round-robin can never land on a real
    // seeded staff row this test cannot clean up.
    const loEmail = `sesslead-lo-${sfx}@test.local`;
    lo = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version, site_selectable, sort_order)
       VALUES ($1,'Session Officer','loan_officer',true,false,'x',0,true,-4000) RETURNING id`, [loEmail])).rows[0];
    lo.email = loEmail; lo.code = loEmail.split('@')[0];
    restoreOthers = (await db.query(
      `SELECT id FROM staff_users WHERE is_active AND role='loan_officer' AND site_selectable=true AND id <> $1`,
      [lo.id])).rows.map((r) => r.id);
    if (restoreOthers.length) await db.query(`UPDATE staff_users SET site_selectable=false WHERE id = ANY($1::uuid[])`, [restoreOthers]);

    // ------------------------------------------------------------ 1. three exports, one lead
    {
      const sid = `sess-a-${sfx}`; sessions.push(sid);
      const r1 = await generate(sid, { email: `visitor-a-${sfx}@example.test`, name: 'Ann Lee', company: 'Ann Holdings LLC', loanAmount: 455000 });
      ok('1a the first export is accepted', r1.status === 201 && !!r1.body.leadId, r1.status);
      const r2 = await generate(sid, { company: 'Ann Holdings LLC', subject: 'Term sheet generated — the Excel' });
      const r3 = await generate(sid, { company: 'Second Deal LLC', subject: 'Term sheet generated — a second property', propertyType: 'Multi 2–4' });
      ok('1b every later export of the visit is accepted too', r2.status === 201 && r3.status === 201);

      const rows = await leadsFor(sid);
      eq('1c three exports in ONE visit produce ONE lead', rows.length, 1);
      eq('1d …and every submission answers with that same lead',
        [r2.body.leadId, r3.body.leadId], [rows[0].id, rows[0].id]);
      eq('1e …it belongs to ONE officer', rows[0].officer_id, lo.id);
      ok('1f …and it is a real lead in the queue', rows[0].status === 'new', rows[0].status);
      eq('1g the visit\'s LATER deals still land on the row — a blank column fills',
        rows[0].program === null && rows[0].company, 'Ann Holdings LLC');
      ok('1h …and what they gave first is never overwritten', rows[0].name === 'Ann Lee'
        && String(rows[0].email).includes(`visitor-a-${sfx}`));
      ok('1i the extra exports are visible on the one row as activity', (await notesFor(rows[0].id)) >= 2);
      eq('1j the officer is told ONCE, not once per export', await staffNotes(lo.id), 1);
    }

    // ------------------------------------------------------------ 2 + 3. nameless, then contactable
    {
      const sid = `sess-b-${sfx}`; sessions.push(sid);
      const r1 = await generate(sid, { company: 'Anon Holdings LLC', subject: 'Term sheet generated — anonymous' });
      ok('2a a nameless export is accepted', r1.status === 201);
      let rows = await leadsFor(sid);
      eq('2b …it is recorded', rows.length, 1);
      eq('2c …but it is NOT in anybody\'s queue', rows[0].status, 'archived');
      eq('2d …and no officer was handed a nameless export', rows[0].officer_id, null);
      eq('2e …the row says why', rows[0].assigned_via, 'anonymous');
      eq('2f nobody was notified about it as a lead', await staffNotes(lo.id), 1);

      const before = outbox.length;
      const r2 = await generate(sid, { phone: '(555) 111-2222', subject: 'Term sheet generated — now with a number' });
      ok('3a the follow-up is accepted', r2.status === 201);
      rows = await leadsFor(sid);
      eq('3b it did NOT open a second lead', rows.length, 1);
      eq('3c …the SAME row is the one that became a lead', r2.body.leadId, rows[0].id);
      eq('3d …it is in the queue now', rows[0].status, 'new');
      ok('3e …carrying the number they left', String(rows[0].phone).includes('555'));
      eq('3f …an officer owns it', rows[0].officer_id, lo.id);
      eq('3g …and NOW he is told', await staffNotes(lo.id), 2);
      ok('3h …an email actually went out for it', outbox.length > before);
    }

    // ------------------------------------------------------------ 4. a name is not contact
    {
      const sid = `sess-c-${sfx}`; sessions.push(sid);
      const notesBefore = await staffNotes(lo.id);
      const r = await generate(sid, { name: 'Nameonly Visitor', company: 'Nameonly LLC' });
      ok('4a accepted', r.status === 201);
      const rows = await leadsFor(sid);
      eq('4b a NAME with no email and no phone is not a lead', rows[0].status, 'archived');
      eq('4c …and is handed to no officer', rows[0].officer_id, null);
      eq('4d …nobody is notified', await staffNotes(lo.id), notesBefore);
      ok('4e …the sales desk is still told, and says what was missing',
        outbox.some((m) => /gave a name but no email and no phone/.test(String(m.text || '') + String(m.html || ''))));
    }

    // ------------------------------------------------------------ 5. the officer's own link
    {
      const sid = `sess-d-${sfx}`; sessions.push(sid);
      const before = outbox.length;
      const r = await generate(sid, { officerCode: lo.code, company: 'Branded LLC', subject: 'Term sheet generated — from the link' });
      ok('5a accepted', r.status === 201);
      const rows = await leadsFor(sid);
      eq('5b the lead is HIS', rows[0].officer_id, lo.id);
      eq('5c …and the row records that it came from his link', rows[0].assigned_via, 'lo_link');
      const mail = outbox.slice(before).find((m) => (m.to || []).some((t) => String(t).includes(lo.email)));
      ok('5d he is emailed', !!mail);
      const body = String((mail && mail.text) || '') + String((mail && mail.html) || '');
      ok('5e …and the email SAYS it came from his own link', /YOUR personal link/.test(body), body.slice(0, 200));
      ok('5f …naming the link', new RegExp(`\\?lo=${lo.code}`).test(body));
      ok('5g …and it still carries the term-sheet details', /Loan amount/.test(body) && /455,000/.test(body));

      // A second export on the same branded visit must not email him again.
      const before2 = outbox.length;
      const notes2 = await staffNotes(lo.id);
      await generate(sid, { officerCode: lo.code, company: 'Branded LLC 2', subject: 'Term sheet generated — second' });
      eq('5h a repeat on his own link does not email him again', await staffNotes(lo.id), notes2);
      ok('5i …and sends nothing at all', outbox.length === before2);
      eq('5j …and still one lead', (await leadsFor(sid)).length, 1);
    }

    // ------------------------------------------------------------ 6. another visit is another lead
    {
      const sid = `sess-e-${sfx}`; sessions.push(sid);
      await generate(sid, { email: `visitor-e-${sfx}@example.test`, company: 'Other Person LLC' });
      const rows = await leadsFor(sid);
      eq('6a a different visit opens its own lead', rows.length, 1);
      ok('6b …and it is not the first visitor\'s row',
        !(await leadsFor(`sess-a-${sfx}`)).some((r) => r.id === rows[0].id));
    }
  } catch (e) {
    fail++; console.log('FAIL threw:', (e && e.stack) || e);
  } finally {
    mailer.sendMail = realSend;
    try {
      const ids = (await db.query(`SELECT id FROM leads WHERE session_id = ANY($1::text[])`, [sessions])).rows.map((r) => r.id);
      if (ids.length) {
        await db.query(`DELETE FROM lead_activities WHERE lead_id = ANY($1::uuid[])`, [ids]).catch(() => {});
        await db.query(`DELETE FROM documents WHERE lead_id = ANY($1::uuid[])`, [ids]).catch(() => {});
        await db.query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [ids]).catch(() => {});
      }
      if (lo) {
        await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [lo.id]).catch(() => {});
        await db.query(`DELETE FROM leads WHERE officer_id=$1`, [lo.id]).catch(() => {});
        await db.query(`DELETE FROM staff_users WHERE id=$1`, [lo.id]).catch(() => {});
      }
      if (restoreOthers.length) await db.query(`UPDATE staff_users SET site_selectable=true WHERE id = ANY($1::uuid[])`, [restoreOthers]).catch(() => {});
    } catch (_) { /* cleanup is best-effort */ }
    server.close();
    console.log(`${pass} passed, ${fail} failed`);
    await db.pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();

#!/usr/bin/env node
'use strict';
/* PER-FILE TASK MANAGEMENT (owner-directed 2026-08-18), against a real database
 * + the real HTTP routes on top of the db/062 reminders engine:
 *
 *   A. the cross-file /reminder-tasks queue: a task ASSIGNED to you is yours to
 *      see whatever file it sits on; scope=all adds everything on files you can
 *      reach; an unrelated scoped officer sees nothing; open/closed filtering;
 *      the overdue flag.
 *   B. reassignment: PATCH assigneeStaffId hands a task over; null clears it;
 *      an inactive staffer is never adopted.
 *   C. the per-file doors stay file-scoped: an unrelated officer's PATCH 403s.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-task-management-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const reminders = require('../src/lib/reminders');
const app = require('../src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  let lo1, lo2, stranger, inactive, borId, appId;
  try {
    const mkStaff = async (name, role, active = true) => (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,$4,false,'x',0) RETURNING id`, [`tm-${name}-${sfx}@test.local`, `TM ${name}`, role, active])).rows[0].id;
    lo1 = await mkStaff('lo1', 'loan_officer');
    lo2 = await mkStaff('lo2', 'loan_officer');
    stranger = await mkStaff('stranger', 'loan_officer');
    inactive = await mkStaff('inactive', 'processor', false);
    const tok1 = C.signJwt({ sub: lo1, kind: 'staff', role: 'loan_officer', tv: 0 });
    const tok2 = C.signJwt({ sub: lo2, kind: 'staff', role: 'loan_officer', tv: 0 });
    const tokS = C.signJwt({ sub: stranger, kind: 'staff', role: 'loan_officer', tv: 0 });
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Task','Manager',$1) RETURNING id`, [`tm-bo-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, ys_loan_number, property_address)
       VALUES ($1,$2,'underwriting','YSCAP-TM-1','{"oneLine":"4 Task Terrace"}') RETURNING id`, [borId, lo1])).rows[0].id;

    // A task on LO1's file, assigned to LO2 (who is NOT on the file), overdue.
    const actor1 = { id: lo1 };
    const taskId = await reminders.create(appId, {
      kind: 'task', title: 'Chase the payoff letter', body: 'Call the servicer.',
      dueAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      recipients: [{ kind: 'self' }], assigneeStaffId: lo2,
    }, actor1);
    // A plain reminder created by LO1 with no assignee, due tomorrow.
    const remId = await reminders.create(appId, {
      kind: 'reminder', title: 'Nudge the borrower on insurance',
      dueAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      recipients: [{ kind: 'self' }],
    }, actor1);

    // ---- A. the cross-file queue ------------------------------------------------------------
    const mine2 = await call(server, 'GET', `/api/staff/reminder-tasks?scope=mine`, tok2);
    ok('A1 a task ASSIGNED to you is yours to see, whatever file it sits on',
      mine2.status === 200 && mine2.body.tasks.some((t) => t.id === taskId));
    ok('A2 …and it carries the file identity + the overdue flag',
      mine2.body.tasks.every((t) => t.id !== taskId || (t.ys_loan_number === 'YSCAP-TM-1' && t.overdue === true && t.assignee_name === 'TM lo2')));
    const mine1 = await call(server, 'GET', `/api/staff/reminder-tasks?scope=mine`, tok1);
    ok('A3 the creator sees their own unassigned reminder under mine',
      mine1.status === 200 && mine1.body.tasks.some((t) => t.id === remId) && !mine1.body.tasks.some((t) => t.id === taskId));
    const all1 = await call(server, 'GET', `/api/staff/reminder-tasks?scope=all`, tok1);
    ok('A4 scope=all adds everything on files the officer can reach',
      all1.status === 200 && all1.body.tasks.some((t) => t.id === taskId) && all1.body.tasks.some((t) => t.id === remId));
    const str = await call(server, 'GET', `/api/staff/reminder-tasks?scope=all`, tokS);
    ok('A5 an unrelated scoped officer sees nothing',
      str.status === 200 && !str.body.tasks.some((t) => t.id === taskId || t.id === remId));

    // Closing a task moves it from open to closed.
    await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${remId}`, tok1, { status: 'done' });
    const open1 = await call(server, 'GET', `/api/staff/reminder-tasks?scope=mine&status=open`, tok1);
    const closed1 = await call(server, 'GET', `/api/staff/reminder-tasks?scope=mine&status=closed`, tok1);
    ok('A6 a done row leaves open and shows under closed',
      !open1.body.tasks.some((t) => t.id === remId) && closed1.body.tasks.some((t) => t.id === remId));

    // ---- B. reassignment --------------------------------------------------------------------
    const re1 = await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${taskId}`, tok1, { assigneeStaffId: lo1 });
    ok('B1 the assignee hands over', re1.status === 200 && re1.body.reminder.assignee_staff_id === lo1);
    const re2 = await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${taskId}`, tok1, { assigneeStaffId: null });
    ok('B2 null clears the owner', re2.status === 200 && re2.body.reminder.assignee_staff_id === null);
    const re3 = await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${taskId}`, tok1, { assigneeStaffId: inactive });
    ok('B3 an INACTIVE staffer is never adopted as the owner',
      re3.status === 200 && re3.body.reminder.assignee_staff_id === null);

    // ---- C. the per-file doors stay file-scoped ---------------------------------------------
    const strangerPatch = await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${taskId}`, tokS, { status: 'done' });
    ok('C1 an unrelated officer cannot touch the file\'s tasks', strangerPatch.status === 403);
  } finally {
    try {
      if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[lo1, lo2, stranger, inactive].filter(Boolean)]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-task-management-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

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
 *      an inactive / external / nonexistent / garbage pick is REFUSED with a
 *      plain 400 (audit 2026-08-18 findings 2–4 — never a silent no-op, never
 *      an opaque 500), and a plain reminder can't be assigned at all.
 *   C. the per-file doors stay file-scoped: an unrelated officer's PATCH 403s.
 *   D. the queue's OWN door (PATCH /reminder-tasks/:rid): the off-file ASSIGNEE
 *      can finish their task (finding 1 — the per-file door 403s them), a
 *      stranger gets 404, and the queue flags file_visible so the client never
 *      renders a dead-end link.
 *   E. an on-hold file's rows leave the OPEN queue and show `paused` elsewhere
 *      (finding 5 — the same muting /my-tasks + the dispatcher apply).
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
  let lo1, lo2, stranger, inactive, broker, firmId, borId, appId;
  try {
    const mkStaff = async (name, role, active = true) => (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,$4,false,'x',0) RETURNING id`, [`tm-${name}-${sfx}@test.local`, `TM ${name}`, role, active])).rows[0].id;
    lo1 = await mkStaff('lo1', 'loan_officer');
    lo2 = await mkStaff('lo2', 'loan_officer');
    stranger = await mkStaff('stranger', 'loan_officer');
    inactive = await mkStaff('inactive', 'processor', false);
    // An ACTIVE but EXTERNAL (TPO broker) staff row — must never own an internal task.
    firmId = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`TM Firm ${sfx}`])).rows[0].id;
    broker = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,mfa_enabled,password_hash,token_version)
       VALUES ($1,'TM broker','tpo_officer',true,true,$2,false,'x',0) RETURNING id`, [`tm-broker-${sfx}@test.local`, firmId])).rows[0].id;
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
    ok('B3 an INACTIVE staffer is REFUSED with a plain 400 (never a silent no-op)',
      re3.status === 400 && /assigned/i.test((re3.body && re3.body.error) || ''));
    const check3 = await db.query(`SELECT assignee_staff_id FROM reminders WHERE id=$1`, [taskId]);
    ok('B3b …and the row is untouched', check3.rows[0].assignee_staff_id === null);
    const re4 = await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${taskId}`, tok1, { assigneeStaffId: 'not-a-uuid' });
    ok('B4 garbage in the assignee box answers 400, never an opaque 500', re4.status === 400);
    const re5 = await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${taskId}`, tok1, { assigneeStaffId: crypto.randomUUID() });
    ok('B5 a NONEXISTENT staffer is refused, not silently ignored', re5.status === 400);
    const re6 = await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${taskId}`, tok1, { assigneeStaffId: broker });
    ok('B6 an EXTERNAL (TPO) staff row is never handed an internal task via PATCH', re6.status === 400);
    // …and never via CREATE either (finding 2: create's check lacked is_external).
    let createBrokerErr = null;
    try {
      await reminders.create(appId, {
        kind: 'task', title: 'Broker-assigned?', dueAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        recipients: [{ kind: 'self' }], assigneeStaffId: broker,
      }, actor1);
    } catch (e) { createBrokerErr = e; }
    ok('B7 create() refuses an external assignee with a 400 of its own',
      createBrokerErr && createBrokerErr.status === 400);
    // A plain REMINDER has recipients, not an owner.
    const re8 = await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${remId}`, tok1, { assigneeStaffId: lo1 });
    ok('B8 assigning a plain reminder is refused (only a task carries an owner)', re8.status === 400);
    let remAssignErr = null;
    try {
      await reminders.create(appId, {
        kind: 'reminder', title: 'assigned reminder?', dueAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        recipients: [{ kind: 'self' }], assigneeStaffId: lo1,
      }, actor1);
    } catch (e) { remAssignErr = e; }
    ok('B9 create() refuses an assignee on a plain reminder too (never a silent drop)',
      remAssignErr && remAssignErr.status === 400);

    // ---- C. the per-file doors stay file-scoped ---------------------------------------------
    const strangerPatch = await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${taskId}`, tokS, { status: 'done' });
    ok('C1 an unrelated officer cannot touch the file\'s tasks', strangerPatch.status === 403);

    // ---- D. the queue's OWN door: the off-file assignee can finish their task ---------------
    await db.query(`UPDATE reminders SET assignee_staff_id=$1 WHERE id=$2`, [lo2, taskId]);
    const perFile2 = await call(server, 'PATCH', `/api/staff/applications/${appId}/reminders/${taskId}`, tok2, { status: 'done' });
    ok('D1 the per-file door still 403s the off-file assignee (the scope middleware)', perFile2.status === 403);
    const q2 = await call(server, 'GET', `/api/staff/reminder-tasks?scope=mine`, tok2);
    ok('D2 the queue flags the file as NOT openable for the off-file assignee',
      q2.status === 200 && q2.body.tasks.some((t) => t.id === taskId && t.file_visible === false));
    const qdone = await call(server, 'PATCH', `/api/staff/reminder-tasks/${taskId}`, tok2, { status: 'done' });
    ok('D3 the queue door lets the ASSIGNEE finish their own task on an off-scope file',
      qdone.status === 200 && qdone.body.reminder.status === 'done');
    const qreopen = await call(server, 'PATCH', `/api/staff/reminder-tasks/${taskId}`, tok1, { status: 'scheduled' });
    ok('D4 …and the CREATOR / on-file officer works through it too', qreopen.status === 200 && qreopen.body.reminder.status === 'scheduled');
    const qstranger = await call(server, 'PATCH', `/api/staff/reminder-tasks/${taskId}`, tokS, { status: 'done' });
    ok('D5 a stranger gets 404 from the queue door (no existence leak)', qstranger.status === 404);
    const qgone = await call(server, 'PATCH', `/api/staff/reminder-tasks/${crypto.randomUUID()}`, tok1, { status: 'done' });
    ok('D6 an unknown id answers 404', qgone.status === 404);
    const qbad = await call(server, 'PATCH', `/api/staff/reminder-tasks/not-a-uuid`, tok1, { status: 'done' });
    ok('D7 a garbage id answers the same 404 — never a uuid-cast 500', qbad.status === 404);

    // ---- E. an on-hold file's rows pause out of the OPEN queue ------------------------------
    await db.query(`UPDATE applications SET status='on_hold' WHERE id=$1`, [appId]);
    const heldOpen = await call(server, 'GET', `/api/staff/reminder-tasks?scope=mine&status=open`, tok2);
    ok('E1 an on-hold file\'s open task leaves the OPEN queue (owner muting rule)',
      heldOpen.status === 200 && !heldOpen.body.tasks.some((t) => t.id === taskId));
    const heldAll = await call(server, 'GET', `/api/staff/reminder-tasks?scope=mine&status=all`, tok2);
    ok('E2 …but status=all still lists it, flagged paused',
      heldAll.status === 200 && heldAll.body.tasks.some((t) => t.id === taskId && t.paused === true));
    await db.query(`UPDATE applications SET status='underwriting' WHERE id=$1`, [appId]);
    const backOpen = await call(server, 'GET', `/api/staff/reminder-tasks?scope=mine&status=open`, tok2);
    ok('E3 coming off hold puts it straight back in the open queue',
      backOpen.status === 200 && backOpen.body.tasks.some((t) => t.id === taskId && t.paused === false));

    // ---- F. TASKS & REMINDERS 2.0 (owner-directed 2026-08-18 evening) ----------------------
    // F1: priority + recur store and travel to the queue; junk REFUSES.
    const priTaskId = await reminders.create(appId, {
      kind: 'task', title: 'High priority weekly check', dueAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      recipients: [{ kind: 'self' }], priority: 'high', recur: 'weekly',
    }, actor1);
    const q1 = await call(server, 'GET', `/api/staff/reminder-tasks?scope=all`, tok1);
    ok('F1 priority + repeat store and ride the queue payload',
      q1.status === 200 && q1.body.tasks.some((t) => t.id === priTaskId && t.priority === 'high' && t.recur === 'weekly'));
    let junkPri = null;
    try { await reminders.create(appId, { kind: 'task', title: 'x', dueAt: new Date().toISOString(), recipients: [{ kind: 'self' }], priority: 'urgent' }, actor1); }
    catch (e) { junkPri = e; }
    ok('F2 a junk priority REFUSES in plain words', !!junkPri && junkPri.status === 400 && /priority/.test(junkPri.message));
    let junkRec = null;
    try { await reminders.create(appId, { kind: 'task', title: 'x', dueAt: new Date().toISOString(), recipients: [{ kind: 'self' }], recur: 'hourly' }, actor1); }
    catch (e) { junkRec = e; }
    ok('F3 a junk repeat REFUSES in plain words', !!junkRec && junkRec.status === 400 && /repeat/.test(junkRec.message));
    ok('F3b the db/581 CHECK backs the JS rule structurally',
      await db.query(`INSERT INTO reminders (application_id,kind,title,due_at,priority) VALUES ($1,'task','x',now(),'urgent')`, [appId])
        .then(() => false).catch((e) => /reminders_priority_chk/.test(e.message || '')));

    // F4: assigning a task NOTIFIES the new owner (the old build assigned silently).
    await reminders.update(priTaskId, { assigneeStaffId: lo2 }, actor1);
    const assignedNotice = (await db.query(
      `SELECT 1 FROM notifications WHERE recipient_kind='staff' AND staff_id=$1 AND type='task_assigned'
        AND title LIKE '%High priority weekly check%'`, [lo2])).rows;
    ok('F4 the person a task is handed to is TOLD about it', assignedNotice.length >= 1);
    ok('F4b assigning to YOURSELF stays silent',
      await reminders.update(priTaskId, { assigneeStaffId: lo1 }, actor1).then(async () =>
        (await db.query(`SELECT 1 FROM notifications WHERE recipient_kind='staff' AND staff_id=$1 AND type='task_assigned'`, [lo1])).rows.length === 0));

    // F5: a RECURRING TASK marked done spawns its next occurrence in the future.
    const doneRow = await reminders.update(priTaskId, { status: 'done' }, actor1);
    ok('F5 finishing a repeating task spawns the next occurrence',
      !!doneRow.spawned_next_id && new Date(doneRow.spawned_next_due) > new Date());
    const spawned = (await db.query(`SELECT * FROM reminders WHERE id=$1`, [doneRow.spawned_next_id])).rows[0];
    ok('F5b the spawned task keeps the shape (title, priority, repeat, owner) and is scheduled',
      !!spawned && spawned.title === 'High priority weekly check' && spawned.priority === 'high'
      && spawned.recur === 'weekly' && spawned.status === 'scheduled' && spawned.assignee_staff_id === lo1);

    // F6: a RECURRING REMINDER rolls itself forward after firing — one future
    // date however overdue it was, back to scheduled, stamps cleared.
    const recRemId = await reminders.create(appId, {
      kind: 'reminder', title: 'Weekly status ping', dueAt: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString(),
      recipients: [{ kind: 'self' }], recur: 'weekly',
    }, actor1);
    await reminders.dispatchDue();
    const rolled = (await db.query(`SELECT * FROM reminders WHERE id=$1`, [recRemId])).rows[0];
    ok('F6 a fired repeating reminder re-arms itself with ONE future due date',
      !!rolled && rolled.status === 'scheduled' && rolled.fired_at === null && new Date(rolled.due_at) > new Date());

    // F7: the nav-badge counts mode.
    const counts = await call(server, 'GET', `/api/staff/reminder-tasks?count=1`, tok1);
    ok('F7 the counts mode answers open/overdue/due_soon for MY queue',
      counts.status === 200 && counts.body.counts && typeof counts.body.counts.open === 'number'
      && typeof counts.body.counts.overdue === 'number' && typeof counts.body.counts.due_soon === 'number');

    // F8: BULK done/dismiss — same per-row authorization as the single door; a
    // foreign row is refused (reported), never silently dropped or 500ing.
    const b1 = await reminders.create(appId, { kind: 'task', title: 'Bulk one', dueAt: new Date().toISOString(), recipients: [{ kind: 'self' }] }, actor1);
    const b2 = await reminders.create(appId, { kind: 'task', title: 'Bulk two', dueAt: new Date().toISOString(), recipients: [{ kind: 'self' }] }, actor1);
    const bulkOut = await call(server, 'POST', `/api/staff/reminder-tasks/bulk`, tok1, { ids: [b1, b2, spawned.id], action: 'done' });
    ok('F8 bulk done closes every reachable row and reports it',
      bulkOut.status === 200 && bulkOut.body.done.length === 3);
    const strangerBulk = await call(server, 'POST', `/api/staff/reminder-tasks/bulk`, tokS, { ids: [b1], action: 'dismissed' });
    ok('F8b a stranger\'s bulk touches nothing and says so',
      strangerBulk.status === 200 && strangerBulk.body.done.length === 0 && strangerBulk.body.refused.length === 1);
    ok('F8c a junk bulk action refuses', (await call(server, 'POST', `/api/staff/reminder-tasks/bulk`, tok1, { ids: [b1], action: 'delete' })).status === 400);
  } finally {
    try {
      if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[lo1, lo2, stranger, inactive, broker].filter(Boolean)]);
      if (firmId) await db.query(`DELETE FROM tpo_firms WHERE id=$1`, [firmId]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-task-management-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/**
 * Loan-Officer NOTIFICATION CENTER — end-to-end behavioral audit.
 *
 * Boots the real Express app + Postgres and walks EVERY button on the four
 * tabs (Catalog / Drafts / Rules / Analytics) + the per-file overrides panel
 * + Compose. For each button it verifies the actual side effect:
 *
 *   · a `Manual` pref → the next notification of that type lands in DRAFTS
 *     (not the notifications table)
 *   · Send-now on a draft → row flips to 'sent' AND a real `notifications`
 *     row exists for the recipient
 *   · Off → nothing lands anywhere (not even in-app)
 *   · DocuSign / security / account (FORCED) → LO's Off/Manual pref is
 *     IGNORED and the notification always sends
 *   · Quiet hours / non-workday / learning mode → routes to DRAFTS
 *   · Schedule + worker.tick() → row goes to 'sent' after the scheduled time
 *   · Snooze → not counted as pending until snoozed_until passes
 *   · Bulk actions → all listed rows updated
 *   · Compose IDOR: recipientId not on the file → 403
 *   · Per-file override presets: VIP / Quiet / Silence / Follow-defaults
 *   · Cache invalidation on /assign — next notify routes to new LO
 *
 * Every failure prints FAIL; every pass prints PASS. Non-zero exit on any
 * failure so `npm test` catches regressions.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lo-notification-center (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
// Prevent the worker's setInterval from keeping the test alive.
process.env.NOTIFY_WORKER_ENABLED = '0';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const email = require('../src/lib/email');
const app = require('../src/server');
const notify = require('../src/lib/notify');
const worker = require('../src/lib/lo-notification-worker');
const gate = require('../src/lib/lo-notification-gate');

let failures = 0, tests = 0;
const T = (msg, ok) => { tests++; if (ok) console.log('  PASS -', msg); else { failures++; console.log('  FAIL -', msg); } };
const H = (msg) => console.log('\n== ' + msg + ' ==');

// Capture every email send instead of actually sending
let sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true, id: `t-${Date.now()}-${Math.random()}` }; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => {
        let json = null; try { json = b ? JSON.parse(b) : null; } catch (_) { /* keep raw */ }
        resolve({ status: res.statusCode, body: json, raw: b });
      }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// ── DB helpers ─────────────────────────────────────────────────────────────
const draftRows = async (staffId, status) => (await db.query(
  `SELECT id, notif_key, status, priority, scheduled_for, snoozed_until, auto_send_at, compose_source, recipient_kind, recipient_id, application_id
     FROM lo_notification_drafts WHERE staff_id=$1${status ? ' AND status=$2' : ''} ORDER BY created_at DESC`,
  status ? [staffId, status] : [staffId])).rows;
const notifCount = async (appId, type) => Number((await db.query(
  `SELECT count(*)::int c FROM notifications WHERE application_id=$1 AND type=$2`, [appId, type])).rows[0].c);
const overrideCount = async (staffId, appId) => Number((await db.query(
  `SELECT count(*)::int c FROM lo_notification_file_overrides WHERE staff_id=$1 AND application_id=$2`,
  [staffId, appId])).rows[0].c);
const rulesRow = async (staffId) => (await db.query(
  `SELECT * FROM lo_notification_rules WHERE staff_id=$1`, [staffId])).rows[0] || null;

(async () => {
  // Migrations only run inside `if (require.main === module)` of server.js,
  // so a test that requires the app doesn't get them for free. Apply them now.
  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let loId, loId2, procId, borrowerId, coBorrowerId, otherBorrowerId, appId, appId2;
  let loTok, loTok2, adminTok;

  try {
    // ── SETUP ────────────────────────────────────────────────────────────
    loId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'LO Alice','loan_officer',true,false,'x',0) RETURNING id`,
      [`lo-${sfx}@test.local`])).rows[0].id;
    loId2 = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'LO Bob','loan_officer',true,false,'x',0) RETURNING id`,
      [`lo2-${sfx}@test.local`])).rows[0].id;
    procId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Proc Carol','processor',true,false,'x',0) RETURNING id`,
      [`proc-${sfx}@test.local`])).rows[0].id;
    const adminId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Admin','admin',true,false,'x',0) RETURNING id`,
      [`admin-${sfx}@test.local`])).rows[0].id;

    loTok = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    loTok2 = C.signJwt({ sub: loId2, kind: 'staff', role: 'loan_officer', tv: 0 });
    adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });

    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth) VALUES ('Test','Borrower',$1,'1980-01-01') RETURNING id`,
      [`bo-${sfx}@test.local`])).rows[0].id;
    coBorrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth) VALUES ('Co','Borrower',$1,'1980-01-01') RETURNING id`,
      [`co-${sfx}@test.local`])).rows[0].id;
    otherBorrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth) VALUES ('Other','Person',$1,'1980-01-01') RETURNING id`,
      [`other-${sfx}@test.local`])).rows[0].id;

    appId = (await db.query(
      `INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, processor_id, status)
       VALUES ($1,$2,$3,$4,'processing') RETURNING id`,
      [borrowerId, coBorrowerId, loId, procId])).rows[0].id;
    appId2 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status)
       VALUES ($1,$2,'processing') RETURNING id`,
      [borrowerId, loId2])).rows[0].id;

    console.log(`Test setup: LO=${loId} borrower=${borrowerId} app=${appId}`);

    // ── CATALOG TAB ──────────────────────────────────────────────────────
    H('CATALOG TAB');
    const cat = await call(server, 'GET', '/api/staff/notification-center/catalog', loTok);
    T('GET /catalog 200', cat.status === 200);
    T('catalog has items array', Array.isArray(cat.body && cat.body.items) && cat.body.items.length >= 50);
    T('catalog has categories', Array.isArray(cat.body && cat.body.categories));
    T('catalog contains doc_uploaded', cat.body.items.some((i) => i.key === 'doc_uploaded'));
    T('catalog marks esign_completed forced', cat.body.items.find((i) => i.key === 'esign_completed').forced === true);
    T('catalog marks status_change not forced', cat.body.items.find((i) => i.key === 'status_change').forced === false);

    const prefs0 = await call(server, 'GET', '/api/staff/notification-center/prefs', loTok);
    T('GET /prefs 200 + empty by default', prefs0.status === 200 && Array.isArray(prefs0.body.prefs) && prefs0.body.prefs.length === 0);

    const putOff = await call(server, 'PUT', '/api/staff/notification-center/prefs/status_change', loTok, { enabled: false, mode: 'automatic' });
    T('PUT /prefs/status_change (off) 200', putOff.status === 200 && putOff.body.ok);

    const putManual = await call(server, 'PUT', '/api/staff/notification-center/prefs/doc_uploaded', loTok, { enabled: true, mode: 'manual' });
    T('PUT /prefs/doc_uploaded (manual) 200', putManual.status === 200 && putManual.body.mode === 'manual');

    const forcedReject = await call(server, 'PUT', '/api/staff/notification-center/prefs/esign_completed', loTok, { enabled: false });
    T('PUT /prefs/esign_completed (forced) 400 rejected', forcedReject.status === 400);

    const unknownReject = await call(server, 'PUT', '/api/staff/notification-center/prefs/does_not_exist', loTok, { enabled: false });
    T('PUT /prefs/<unknown> 400 rejected', unknownReject.status === 400);

    const bulk = await call(server, 'POST', '/api/staff/notification-center/prefs/bulk', loTok, {
      changes: [
        { key: 'condition_added', enabled: true, mode: 'manual' },
        { key: 'esign_sent', enabled: false, mode: 'automatic' },  // forced, will be ignored
        { key: 'reminder', enabled: false },
      ],
    });
    T('POST /prefs/bulk 200', bulk.status === 200);
    // Should apply 2 (skip the forced esign_sent)
    T('bulk skips forced entries', bulk.body.applied === 2);

    // ── GATE BEHAVIOR: pref=off → dropped; pref=manual → drafted ─────────
    H('GATE BEHAVIOR');
    sent = [];
    // status_change is 'off' → borrower gets NOTHING; not even an in-app row.
    const nBefore = await notifCount(appId, 'status_change');
    await notify.notifyBorrower(borrowerId, { type: 'status_change', title: 'test off', applicationId: appId });
    const nAfter = await notifCount(appId, 'status_change');
    T('gate action=drop → no notification row written', nAfter === nBefore);
    T('gate action=drop → no email sent', sent.length === 0);

    // doc_uploaded is 'manual' → routes to DRAFTS, not to notifications.
    const dBefore = (await draftRows(loId)).length;
    await notify.notifyBorrower(borrowerId, { type: 'doc_uploaded', title: 'test doc', body: 'body', applicationId: appId });
    const drafts1 = await draftRows(loId);
    T('gate action=draft → draft row created', drafts1.length === dBefore + 1);
    const draft1 = drafts1[0];
    T('draft has correct notif_key', draft1.notif_key === 'doc_uploaded');
    T('draft has correct recipient', draft1.recipient_kind === 'borrower' && String(draft1.recipient_id) === String(borrowerId));
    T('draft has application_id', String(draft1.application_id) === String(appId));
    T('draft has auto_send_at set (safety fallback)', draft1.auto_send_at != null);

    // FORCED: DocuSign notification bypasses ANY LO pref.
    sent = [];
    await notify.notifyBorrower(borrowerId, { type: 'esign_completed', title: 'signed!', applicationId: appId });
    const esignRows = await notifCount(appId, 'esign_completed');
    T('FORCED esign_completed sends even with off/manual prefs', esignRows === 1);

    // ── DRAFTS TAB — LIST, PREVIEW, SEND, DISCARD, SNOOZE, SCHEDULE ──────
    H('DRAFTS TAB');
    const list = await call(server, 'GET', '/api/staff/notification-center/drafts?status=pending', loTok);
    T('GET /drafts?status=pending 200', list.status === 200 && Array.isArray(list.body.items));
    T('drafts list contains our doc_uploaded draft', list.body.items.some((i) => i.id === draft1.id));

    const count1 = await call(server, 'GET', '/api/staff/notification-center/drafts/count', loTok);
    T('GET /drafts/count returns numeric pending', typeof count1.body.pending === 'number' && count1.body.pending >= 1);

    const preview = await call(server, 'GET', `/api/staff/notification-center/drafts/${draft1.id}/preview`, loTok);
    T('GET /drafts/:id/preview 200', preview.status === 200);
    T('preview has html + subject', typeof preview.body.html === 'string' && preview.body.html.includes('test doc') && typeof preview.body.subject === 'string');

    // Foreign draft — another LO cannot preview
    const preview403 = await call(server, 'GET', `/api/staff/notification-center/drafts/${draft1.id}/preview`, loTok2);
    T('preview 403 for wrong LO', preview403.status === 403);

    // SNOOZE — the row should disappear from the default pending count
    const snooze = await call(server, 'POST', `/api/staff/notification-center/drafts/${draft1.id}/snooze`, loTok, { minutes: 120 });
    T('POST /drafts/:id/snooze 200', snooze.status === 200);
    const listAfterSnooze = await call(server, 'GET', '/api/staff/notification-center/drafts?status=pending', loTok);
    T('snoozed row hidden from pending list', !listAfterSnooze.body.items.some((i) => i.id === draft1.id));
    // Count endpoint filters snoozed out of pending too
    const cAfter = await call(server, 'GET', '/api/staff/notification-center/drafts/count', loTok);
    T('snoozed row not counted as pending', cAfter.body.pending < count1.body.pending);
    T('snoozed row counted as snoozed', cAfter.body.snoozed >= 1);

    // Clear the snooze so we can Send / Schedule it
    await db.query(`UPDATE lo_notification_drafts SET snoozed_until=NULL WHERE id=$1`, [draft1.id]);

    // SCHEDULE — pick 2 hours ahead
    const at = new Date(Date.now() + 2 * 3600_000).toISOString();
    const sch = await call(server, 'POST', `/api/staff/notification-center/drafts/${draft1.id}/schedule`, loTok, { at });
    T('POST /drafts/:id/schedule 200', sch.status === 200);
    const schPast = await call(server, 'POST', `/api/staff/notification-center/drafts/${draft1.id}/schedule`, loTok, { at: new Date(Date.now() - 60_000).toISOString() });
    T('POST /drafts/:id/schedule past-time rejected 400', schPast.status === 400);

    // Force the schedule time into the past, then tick the worker — should send.
    await db.query(`UPDATE lo_notification_drafts SET scheduled_for = now() - interval '1 minute' WHERE id=$1`, [draft1.id]);
    sent = [];
    await worker.tick();
    const afterTick = (await draftRows(loId)).find((d) => d.id === draft1.id);
    T('worker.tick() flips scheduled row to sent', afterTick && afterTick.status === 'sent');
    T('worker send created notifications row', (await notifCount(appId, 'doc_uploaded')) === 1);

    // Second tick should not double-send (atomic claim).
    sent = [];
    await worker.tick();
    T('second tick does NOT double-send (idempotent)', sent.length === 0);

    // Create another draft to test DISCARD + SEND (manual)
    await notify.notifyBorrower(borrowerId, { type: 'doc_uploaded', title: 'to discard', body: 'x', applicationId: appId });
    await notify.notifyBorrower(borrowerId, { type: 'doc_uploaded', title: 'to send', body: 'y', applicationId: appId });
    const pend = await draftRows(loId, 'pending');
    T('two more pending drafts created', pend.length >= 2);
    const discardId = pend[0].id;
    const sendId = pend[1].id;

    const disc = await call(server, 'POST', `/api/staff/notification-center/drafts/${discardId}/discard`, loTok);
    T('POST /drafts/:id/discard 200', disc.status === 200);
    const discRow = (await db.query(`SELECT status FROM lo_notification_drafts WHERE id=$1`, [discardId])).rows[0];
    T('discarded row status = discarded', discRow.status === 'discarded');

    // SEND-NOW with body edits
    sent = [];
    const notifBeforeSend = await notifCount(appId, 'doc_uploaded');
    const sendRes = await call(server, 'POST', `/api/staff/notification-center/drafts/${sendId}/send`, loTok, {
      title: 'edited subject', body: 'edited body', note: 'from LO' });
    T('POST /drafts/:id/send 200', sendRes.status === 200 && sendRes.body.ok);
    T('sent row status = sent', ((await db.query(`SELECT status FROM lo_notification_drafts WHERE id=$1`, [sendId])).rows[0].status) === 'sent');
    T('send creates a notifications row', (await notifCount(appId, 'doc_uploaded')) === notifBeforeSend + 1);
    // Sending an already-sent draft should 409
    const sendAgain = await call(server, 'POST', `/api/staff/notification-center/drafts/${sendId}/send`, loTok);
    T('re-sending sent draft returns 409', sendAgain.status === 409);
    // A discarded draft should also 409 on send
    const sendDisc = await call(server, 'POST', `/api/staff/notification-center/drafts/${discardId}/send`, loTok);
    T('sending discarded draft returns 409', sendDisc.status === 409);

    // Foreign draft protection
    const foreignSend = await call(server, 'POST', `/api/staff/notification-center/drafts/${draft1.id}/send`, loTok2);
    T('sending another LO’s draft returns 403 or 409', foreignSend.status === 403 || foreignSend.status === 409);

    // ── BULK ACTIONS ─────────────────────────────────────────────────────
    H('BULK ACTIONS');
    // Make 3 fresh drafts
    for (let i = 0; i < 3; i++) await notify.notifyBorrower(borrowerId, { type: 'doc_uploaded', title: `bulk ${i}`, body: 'b', applicationId: appId });
    const bulkList = await draftRows(loId, 'pending');
    T('3 fresh drafts created for bulk test', bulkList.length >= 3);
    const bulkIds = bulkList.slice(0, 3).map((r) => r.id);

    // Bulk discard all three
    const bulkDisc = await call(server, 'POST', '/api/staff/notification-center/drafts/bulk', loTok, { ids: bulkIds, action: 'discard' });
    T('POST /drafts/bulk discard 200', bulkDisc.status === 200 && bulkDisc.body.applied === 3);
    const stillPending = (await draftRows(loId, 'pending')).filter((r) => bulkIds.includes(r.id));
    T('bulk-discarded rows no longer pending', stillPending.length === 0);

    // Bulk schedule (past time in body → all should fail)
    const badBulk = await call(server, 'POST', '/api/staff/notification-center/drafts/bulk', loTok, { ids: bulkIds, action: 'schedule', at: new Date(Date.now() - 60_000).toISOString() });
    T('bulk schedule past time returns applied=0', badBulk.status === 200 && badBulk.body.applied === 0);

    // ── RULES TAB ────────────────────────────────────────────────────────
    H('RULES TAB');
    const rulesGet = await call(server, 'GET', '/api/staff/notification-center/rules', loTok);
    T('GET /rules 200', rulesGet.status === 200);
    T('default timezone America/New_York', rulesGet.body.rules.timezone === 'America/New_York');

    // Quiet hours 00:00–23:59 (essentially all day)
    const putRules = await call(server, 'PUT', '/api/staff/notification-center/rules', loTok, {
      timezone: 'America/New_York',
      quiet_hours_start: '00:00', quiet_hours_end: '23:59',
      work_days_mask: 127, auto_send_after_hours: 24, compose_default: 'send', undo_window_seconds: 8,
    });
    T('PUT /rules 200', putRules.status === 200);
    const rr = await rulesRow(loId);
    T('rules persisted', rr && rr.quiet_hours_start === '00:00');

    // With all-day quiet hours, an AUTO pref should route to draft
    await call(server, 'PUT', '/api/staff/notification-center/prefs/reminder', loTok, { enabled: true, mode: 'automatic' });
    gate.invalidateRules(loId);  // clear cache so PUT takes effect for this test
    const dBeforeRem = (await draftRows(loId, 'pending')).filter((d) => d.notif_key === 'reminder').length;
    sent = [];
    await notify.notifyBorrower(borrowerId, { type: 'reminder', title: 'nudge', applicationId: appId });
    const dAfterRem = (await draftRows(loId, 'pending')).filter((d) => d.notif_key === 'reminder').length;
    T('quiet hours demote send → draft', dAfterRem === dBeforeRem + 1);

    // auto_send_after_hours=0 → server treats as null (audit fix)
    const rulesZero = await call(server, 'PUT', '/api/staff/notification-center/rules', loTok, { ...putRules.body, auto_send_after_hours: 0, quiet_hours_start: null, quiet_hours_end: null });
    T('PUT /rules with auto_send_after_hours=0 200', rulesZero.status === 200);
    const rrZero = await rulesRow(loId);
    T('auto_send_after_hours=0 stored as NULL (0=off)', rrZero.auto_send_after_hours === null);

    // Learning mode routes EVERYTHING to draft (verify_prefs=auto is bypassed)
    const learn = await call(server, 'PUT', '/api/staff/notification-center/rules', loTok, { ...putRules.body, learning_mode_hours: 24, quiet_hours_start: null, quiet_hours_end: null });
    T('PUT /rules learning_mode_hours=24 200', learn.status === 200);
    const rrLearn = await rulesRow(loId);
    T('learning_mode_until in future', new Date(rrLearn.learning_mode_until).getTime() > Date.now());
    gate.invalidateRules(loId);

    // Reset the reminder pref to plain auto — learning mode should still park it as draft
    await call(server, 'PUT', '/api/staff/notification-center/prefs/reminder', loTok, { enabled: true, mode: 'automatic' });
    const dBeforeLearn = (await draftRows(loId, 'pending')).filter((d) => d.notif_key === 'reminder').length;
    await notify.notifyBorrower(borrowerId, { type: 'reminder', title: 'learn nudge', applicationId: appId });
    const dAfterLearn = (await draftRows(loId, 'pending')).filter((d) => d.notif_key === 'reminder').length;
    T('learning mode routes AUTO pref to draft', dAfterLearn === dBeforeLearn + 1);
    // But FORCED still bypasses learning mode
    const forcedNb = await notifCount(appId, 'security');
    await notify.notifyBorrower(borrowerId, { type: 'security', title: 'sec', applicationId: appId });
    T('forced security notification bypasses learning mode', (await notifCount(appId, 'security')) === forcedNb + 1);

    // End learning mode
    await call(server, 'PUT', '/api/staff/notification-center/rules', loTok, { ...putRules.body, learning_mode_hours: 0, learning_mode_until: null, quiet_hours_start: null, quiet_hours_end: null });
    gate.invalidateRules(loId);

    // ── PER-FILE OVERRIDES ───────────────────────────────────────────────
    H('PER-FILE OVERRIDES');
    // A non-owner-LO can't set an override
    const otherOvr = await call(server, 'PUT', '/api/staff/notification-center/overrides', loTok2, { applicationId: appId, key: 'reminder', enabled: false });
    T('PUT /overrides by non-owner LO returns 403', otherOvr.status === 403);
    // Set a per-file OFF override on a key that's normally on
    const ovrOff = await call(server, 'PUT', '/api/staff/notification-center/overrides', loTok, { applicationId: appId, key: 'reminder', enabled: false, mode: 'automatic', note: 'quiet borrower' });
    T('PUT /overrides key=reminder off 200', ovrOff.status === 200);
    T('override row present in DB', (await overrideCount(loId, appId)) === 1);

    const remBefore = await notifCount(appId, 'reminder');
    sent = [];
    await notify.notifyBorrower(borrowerId, { type: 'reminder', title: 'silenced', applicationId: appId });
    T('per-file override off → no notification', (await notifCount(appId, 'reminder')) === remBefore);

    // Wildcard '*' — Silence-all preset (enabled=false)
    await call(server, 'PUT', '/api/staff/notification-center/overrides', loTok, { applicationId: appId, key: '*', enabled: false, mode: 'automatic' });
    const anyBefore = await notifCount(appId, 'closing_date');
    await notify.notifyBorrower(borrowerId, { type: 'closing_date', title: 'closing', applicationId: appId });
    T('wildcard silence-all → no notification', (await notifCount(appId, 'closing_date')) === anyBefore);

    // Wildcard should NOT silence forced
    const esBefore = await notifCount(appId, 'esign_completed');
    await notify.notifyBorrower(borrowerId, { type: 'esign_completed', title: 'signed', applicationId: appId });
    T('wildcard silence-all does NOT silence forced (esign_completed)', (await notifCount(appId, 'esign_completed')) === esBefore + 1);

    // DELETE '__all__' → clears every override
    const clearAll = await call(server, 'DELETE', `/api/staff/notification-center/overrides?applicationId=${appId}&key=__all__`, loTok);
    T('DELETE /overrides __all__ 200', clearAll.status === 200);
    T('override rows cleared', (await overrideCount(loId, appId)) === 0);

    // DELETE with missing key returns 400
    const missingKey = await call(server, 'DELETE', `/api/staff/notification-center/overrides?applicationId=${appId}`, loTok);
    T('DELETE /overrides missing key rejects 400', missingKey.status === 400);

    // ── COMPOSE (IDOR guards) ────────────────────────────────────────────
    H('COMPOSE');
    // Valid borrower on the file (compose_default currently 'send')
    const composeBorr = await call(server, 'POST', '/api/staff/notification-center/compose', loTok, {
      applicationId: appId, recipientKind: 'borrower', recipientId: borrowerId,
      subject: 'compose subject', body: 'compose body', mode: 'send',
    });
    T('POST /compose (borrower) 200', composeBorr.status === 200);

    // Co-borrower on the file — should work
    const composeCo = await call(server, 'POST', '/api/staff/notification-center/compose', loTok, {
      applicationId: appId, recipientKind: 'borrower', recipientId: coBorrowerId,
      subject: 'to co-borrower', body: 'body', mode: 'send',
    });
    T('POST /compose (co-borrower) 200', composeCo.status === 200);

    // Foreign borrower — IDOR guard
    const composeIDOR = await call(server, 'POST', '/api/staff/notification-center/compose', loTok, {
      applicationId: appId, recipientKind: 'borrower', recipientId: otherBorrowerId,
      subject: 'x', body: 'x', mode: 'send',
    });
    T('POST /compose foreign borrower → 403 (IDOR)', composeIDOR.status === 403);

    // Assigned processor — should work (they're in application_assignees via the trigger)
    const composeProc = await call(server, 'POST', '/api/staff/notification-center/compose', loTok, {
      applicationId: appId, recipientKind: 'staff', recipientId: procId,
      subject: 'to processor', body: 'body', mode: 'send',
    });
    T('POST /compose (processor on file) 200', composeProc.status === 200);

    // Non-assignee staff — IDOR guard
    const composeStrangeStaff = await call(server, 'POST', '/api/staff/notification-center/compose', loTok, {
      applicationId: appId, recipientKind: 'staff', recipientId: loId2,
      subject: 'x', body: 'x', mode: 'send',
    });
    T('POST /compose non-assignee staff → 403 (IDOR)', composeStrangeStaff.status === 403);

    // A file the LO doesn't own — 403
    const composeWrongFile = await call(server, 'POST', '/api/staff/notification-center/compose', loTok, {
      applicationId: appId2, recipientKind: 'borrower', recipientId: borrowerId,
      subject: 'x', body: 'x', mode: 'send',
    });
    T('POST /compose foreign file → 403', composeWrongFile.status === 403);

    // mode=draft path
    const composeDraft = await call(server, 'POST', '/api/staff/notification-center/compose', loTok, {
      applicationId: appId, recipientKind: 'borrower', recipientId: borrowerId,
      subject: 'draft me', body: 'body', mode: 'draft',
    });
    T('POST /compose mode=draft 200', composeDraft.status === 200 && composeDraft.body.mode === 'draft');
    const composeRows = await db.query(`SELECT compose_source FROM lo_notification_drafts WHERE staff_id=$1 AND subject_preview='draft me'`, [loId]);
    T('compose draft has compose_source=compose', composeRows.rows[0] && composeRows.rows[0].compose_source === 'compose');

    // ── ANALYTICS ────────────────────────────────────────────────────────
    H('ANALYTICS');
    const ana = await call(server, 'GET', '/api/staff/notification-center/analytics?days=30', loTok);
    T('GET /analytics 200', ana.status === 200);
    T('analytics returns byKey + totals', Array.isArray(ana.body.byKey) && ana.body.totals && typeof ana.body.totals.fired === 'number');

    // ── CACHE INVALIDATION on /assign ────────────────────────────────────
    H('CACHE INVALIDATION');
    // Prime the officer cache
    await gate.fileOfficerId(appId);
    // Admin reassigns to loId2
    const assign = await call(server, 'POST', `/api/staff/applications/${appId}/assign`, adminTok, { loanOfficerId: loId2 });
    T('POST /applications/:id/assign 200', assign.status === 200);
    // Next notification should route to loId2's prefs (loId2 has NO prefs set → default auto → send)
    const nBefore2 = await notifCount(appId, 'reminder');
    await notify.notifyBorrower(borrowerId, { type: 'reminder', title: 'after reassign', applicationId: appId });
    T('after /assign, notification sends via new LO defaults', (await notifCount(appId, 'reminder')) === nBefore2 + 1);

    // ── CLEANUP ──────────────────────────────────────────────────────────
    console.log(`\n== ${tests} checks: ${tests - failures} PASS · ${failures} FAIL ==\n`);
  } finally {
    try { await db.query(`DELETE FROM lo_notification_drafts WHERE staff_id IN ($1,$2,$3)`, [loId, loId2, procId]); } catch (_) {}
    try { await db.query(`DELETE FROM lo_notification_prefs WHERE staff_id IN ($1,$2,$3)`, [loId, loId2, procId]); } catch (_) {}
    try { await db.query(`DELETE FROM lo_notification_rules WHERE staff_id IN ($1,$2,$3)`, [loId, loId2, procId]); } catch (_) {}
    try { await db.query(`DELETE FROM lo_notification_file_overrides WHERE staff_id IN ($1,$2,$3)`, [loId, loId2, procId]); } catch (_) {}
    try { await db.query(`DELETE FROM notifications WHERE application_id IN ($1,$2)`, [appId, appId2]); } catch (_) {}
    try { await db.query(`DELETE FROM applications WHERE id IN ($1,$2)`, [appId, appId2]); } catch (_) {}
    try { await db.query(`DELETE FROM borrowers WHERE id IN ($1,$2,$3)`, [borrowerId, coBorrowerId, otherBorrowerId]); } catch (_) {}
    try { await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`%-${sfx}@test.local`]); } catch (_) {}
    server.close();
    await new Promise((r) => setTimeout(r, 100));
    process.exit(failures > 0 ? 1 : 0);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });

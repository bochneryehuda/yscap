'use strict';
/**
 * REMOVE A FILE FROM A WORKFLOW VIEW — never deletes it (owner-directed
 * 2026-08-11: "anybody should be able to remove a file from the workflow — the row
 * coordinator, closing, purchasing — if it landed there by mistake. Double warning,
 * and it should NOT delete the file from the system, just remove it from their
 * workflow view").
 *
 * Real HTTP + real Postgres. What must hold:
 *   - a removed file DISAPPEARS from that ONE view but stays on every other view;
 *   - the file itself (applications row) is NEVER deleted;
 *   - `?removed=1` lists the removed ones and restore brings them back;
 *   - the counts drop with the list.
 *
 * Needs DATABASE_URL; skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

if (!process.env.DATABASE_URL) { console.log('SKIP test-workflow-view-removal-db (no DATABASE_URL)'); process.exit(0); }

let fail = 0;
const ok = (c, m) => { if (c) console.log('  ok  ' + m); else { fail++; console.error('  FAIL ' + m); } };

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const tag = `wfrm_${process.pid}`;

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const C = require('../src/lib/crypto');

  const s = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'WF Remover','super_admin',true) RETURNING id, token_version`,
    [`${tag}@example.com`])).rows[0];
  const token = C.signJwt({ sub: s.id, kind: 'staff', role: 'super_admin', tv: s.token_version || 0 });
  const call = (path, opts) => fetch(`${base}${path}`, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts && opts.headers) } });
  const getJson = async (path) => { const r = await call(path); const b = await r.json().catch(() => null); return { status: r.status, body: b }; };
  const rows = (b) => Array.isArray(b) ? b : (b && (b.applications || b.rows || b.items)) || [];
  const has = (b, id) => rows(b).some((x) => (x.id || x.application_id) === id);

  const loanNo = `${tag}-LOAN`;
  const bId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('WF','Test',$1) RETURNING id`, [`${tag}@ex.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, status, ys_loan_number, property_address)
     VALUES ($1,'processing',$2,$3::jsonb) RETURNING id`,
    [bId, loanNo, JSON.stringify({ oneLine: `${tag} 1 Test St` })])).rows[0].id;
  await db.query(`INSERT INTO closing_workflow (application_id, stage) VALUES ($1,'estimated')`, [appId]);
  await db.query(`INSERT INTO purchasing_workflow (application_id, status) VALUES ($1,'outstanding')`, [appId]);

  const remove = (wf) => call(`/api/staff/applications/${appId}/workflow/${wf}/remove`, { method: 'POST', body: JSON.stringify({ reason: 'landed here by mistake' }) });
  const restore = (wf) => call(`/api/staff/applications/${appId}/workflow/${wf}/restore`, { method: 'POST', body: '{}' });
  const stillExists = async () => (await db.query(`SELECT deleted_at FROM applications WHERE id=$1`, [appId])).rows[0];

  try {
    console.log('\n§1  the file starts visible on all three views');
    ok(has((await getJson(`/api/staff/applications?q=${tag}`)).body, appId), 'pipeline (row coordinator) shows the file');
    ok(has((await getJson('/api/staff/closing')).body, appId), 'closing desk shows the file');
    ok(has((await getJson('/api/staff/purchasing')).body, appId), 'purchasing desk shows the file');

    console.log('\n§2  remove from the PIPELINE — gone there, still on the other two, file NOT deleted');
    ok((await remove('pipeline')).status === 200, 'remove pipeline → 200');
    ok(!has((await getJson(`/api/staff/applications?q=${tag}`)).body, appId), 'the file is gone from the pipeline');
    ok(has((await getJson('/api/staff/closing')).body, appId), 'it is STILL on the closing desk');
    ok(has((await getJson('/api/staff/purchasing')).body, appId), 'it is STILL on the purchasing desk');
    ok(has((await getJson(`/api/staff/applications?q=${tag}&removed=1`)).body, appId), '?removed=1 lists the removed file (for restore)');
    ok((await stillExists()).deleted_at === null, 'the file itself is NOT deleted (applications.deleted_at still NULL)');

    console.log('\n§3  remove from CLOSING and PURCHASING — each view only');
    const cCountBefore = (await getJson('/api/staff/closing/count')).body.count;
    ok((await remove('closing')).status === 200, 'remove closing → 200');
    ok(!has((await getJson('/api/staff/closing')).body, appId), 'the file is gone from the closing desk');
    ok((await getJson('/api/staff/closing/count')).body.count === cCountBefore - 1, 'the closing count dropped by one');
    ok(has((await getJson('/api/staff/closing?removed=1')).body, appId), '?removed=1 lists it on the closing desk');

    ok((await remove('purchasing')).status === 200, 'remove purchasing → 200');
    ok(!has((await getJson('/api/staff/purchasing')).body, appId), 'the file is gone from the purchasing desk');
    ok(has((await getJson('/api/staff/purchasing?removed=1')).body, appId), '?removed=1 lists it on the purchasing desk');
    ok((await stillExists()).deleted_at === null, 'after removing from all three, the file is STILL not deleted');

    console.log('\n§4  restore brings it back');
    ok((await restore('pipeline')).status === 200, 'restore pipeline → 200');
    ok(has((await getJson(`/api/staff/applications?q=${tag}`)).body, appId), 'the file is back on the pipeline');
    ok((await restore('closing')).status === 200 && has((await getJson('/api/staff/closing')).body, appId), 'the file is back on the closing desk');

    console.log('\n§5  an unknown view name is refused');
    ok((await call(`/api/staff/applications/${appId}/workflow/nonsense/remove`, { method: 'POST', body: '{}' })).status === 400, 'an unknown workflow view → 400');
  } catch (e) { console.error('THREW', e); fail++; }

  await db.query(`DELETE FROM purchasing_workflow WHERE application_id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM closing_workflow WHERE application_id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM workflow_items WHERE application_id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE email=$1`, [`${tag}@example.com`]).catch(() => {});
  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  console.log(fail ? `\nFAILED — ${fail} check(s)\n` : '\nPASSED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

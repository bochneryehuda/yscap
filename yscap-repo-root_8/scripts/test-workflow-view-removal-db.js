'use strict';
/**
 * REMOVE/RESTORE LIVES ON THE WORKFLOWS, NEVER ON THE PIPELINE (owner-directed
 * 2026-08-18, correcting the 2026-08-11 build: "The intent when saying remove
 * and put back was on the WORKFLOW, not on the pipeline. Everybody has their
 * workflow: Closing Workflow, Purchasing Workflow, Reconciliation Workflow,
 * Processing Workflow, Underwriting Workflow, Exception Workflow. … For files
 * in the pipeline, the only button that should work is the Archive button and
 * Restore From Archive").
 *
 * Real HTTP + real Postgres. What must hold:
 *   - the PIPELINE is not a removable view: remove/restore answer 400, the
 *     list never hides on ?removed=1, and db/582's back-date SURFACES any file
 *     the retired feature had hidden (with an audit row);
 *   - the CLOSING and PURCHASING desk removes still work exactly as before
 *     (reconciliation is a stage of the closing desk, covered by its marker);
 *   - a WORKFLOW ITEM (Processing / Underwriting / Exception… — workflow_items)
 *     can be removed from the queue and restored: it leaves the live queue,
 *     shows in the Removed view with who/when/why, restore puts it back, and a
 *     restore is refused while the same (file, hand-off kind) already has
 *     another live item;
 *   - the file row itself is NEVER deleted by any of it.
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
    ok(has((await getJson(`/api/staff/applications?q=${tag}`)).body, appId), 'pipeline shows the file');
    ok(has((await getJson('/api/staff/closing')).body, appId), 'closing desk shows the file');
    ok(has((await getJson('/api/staff/purchasing')).body, appId), 'purchasing desk shows the file');

    console.log('\n§2  the PIPELINE is not a removable view any more');
    ok((await remove('pipeline')).status === 400, 'remove pipeline → 400 (the pipeline uses Archive, not Remove)');
    ok((await restore('pipeline')).status === 400, 'restore pipeline → 400');
    ok(has((await getJson(`/api/staff/applications?q=${tag}`)).body, appId), 'the file is still on the pipeline');
    ok(has((await getJson(`/api/staff/applications?q=${tag}&removed=1`)).body, appId), '?removed=1 is ignored — the file still lists (no hidden pipeline view)');

    console.log('\n§2b db/582 SURFACES a file the retired pipeline remove had hidden, with an audit row');
    await db.query(`UPDATE applications SET pipeline_removed_at=now(), pipeline_removed_by=$2, pipeline_removed_reason='old removal' WHERE id=$1`, [appId, s.id]);
    await ensureSchema(); // every migration replays on boot — db/582 clears the marker
    const marker = (await db.query(`SELECT pipeline_removed_at, pipeline_removed_reason FROM applications WHERE id=$1`, [appId])).rows[0];
    ok(marker.pipeline_removed_at === null && marker.pipeline_removed_reason === null, 'the pipeline_removed_* marker is cleared on the next boot');
    const aud = (await db.query(`SELECT detail FROM audit_log WHERE action='pipeline_remove_retired' AND entity_id=$1`, [appId])).rows;
    ok(aud.length === 1 && aud[0].detail && aud[0].detail.reason === 'old removal', 'the clearance is audit-logged with who/why preserved');
    await ensureSchema();
    ok((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='pipeline_remove_retired' AND entity_id=$1`, [appId])).rows[0].n === 1, 'the back-date is idempotent — a second boot audits nothing new');

    console.log('\n§3  the CLOSING and PURCHASING desk removes are unchanged');
    const cCountBefore = (await getJson('/api/staff/closing/count')).body.count;
    ok((await remove('closing')).status === 200, 'remove closing → 200');
    ok(!has((await getJson('/api/staff/closing')).body, appId), 'the file is gone from the closing desk');
    ok((await getJson('/api/staff/closing/count')).body.count === cCountBefore - 1, 'the closing count dropped by one');
    ok(has((await getJson('/api/staff/closing?removed=1')).body, appId), '?removed=1 lists it on the closing desk');
    ok((await remove('purchasing')).status === 200, 'remove purchasing → 200');
    ok(!has((await getJson('/api/staff/purchasing')).body, appId), 'the file is gone from the purchasing desk');
    ok((await restore('closing')).status === 200 && has((await getJson('/api/staff/closing')).body, appId), 'restore brings it back to the closing desk');
    ok((await restore('purchasing')).status === 200 && has((await getJson('/api/staff/purchasing')).body, appId), 'restore brings it back to the purchasing desk');
    ok((await stillExists()).deleted_at === null, 'the file itself is NEVER deleted (applications.deleted_at still NULL)');

    console.log('\n§4  a WORKFLOW ITEM is removable + restorable (the owner\'s intended home)');
    const itemId = (await db.query(
      `INSERT INTO workflow_items (application_id, submission_type, to_staff_id, to_role, status)
       VALUES ($1,'processing',$2,'super_admin','open') RETURNING id`, [appId, s.id])).rows[0].id;
    const inQueue = async (tab) => {
      const r = await getJson(`/api/staff/workflow${tab ? `?tab=${tab}` : ''}`);
      return (Array.isArray(r.body) ? r.body : []).some((x) => x.id === itemId);
    };
    ok(await inQueue(), 'the hand-off shows in the live workflow queue');
    const rm = await call(`/api/staff/workflow/${itemId}/remove`, { method: 'POST', body: JSON.stringify({ reason: 'sent here by mistake' }) });
    ok(rm.status === 200, 'remove the item → 200');
    ok(!(await inQueue()), 'it leaves the live queue');
    const removedList = (await getJson('/api/staff/workflow?tab=removed')).body;
    const removedRow = (Array.isArray(removedList) ? removedList : []).find((x) => x.id === itemId);
    ok(!!removedRow, 'it shows in the Removed view');
    ok(removedRow && removedRow.removed_reason === 'sent here by mistake' && removedRow.removed_by_name === 'WF Remover', 'the Removed view says who removed it and why');
    ok((await db.query(`SELECT count(*)::int AS n FROM workflow_events WHERE workflow_item_id=$1 AND event_type='removed'`, [itemId])).rows[0].n === 1, 'a workflow_events "removed" row is written');
    // restore refuses while the same (file, kind) has ANOTHER live item — the
    // same duplicate the submit door suppresses.
    const dupId = (await db.query(
      `INSERT INTO workflow_items (application_id, submission_type, to_staff_id, to_role, status)
       VALUES ($1,'processing',$2,'super_admin','open') RETURNING id`, [appId, s.id])).rows[0].id;
    ok((await call(`/api/staff/workflow/${itemId}/restore`, { method: 'POST', body: '{}' })).status === 409, 'restore is refused while a duplicate live hand-off exists (409)');
    await db.query(`DELETE FROM workflow_items WHERE id=$1`, [dupId]);
    const rs = await call(`/api/staff/workflow/${itemId}/restore`, { method: 'POST', body: '{}' });
    ok(rs.status === 200, 'restore → 200 once the duplicate is gone');
    ok(await inQueue(), 'the hand-off is back in the live queue');
    const back = (await db.query(`SELECT status, removed_at, removed_by, removed_reason FROM workflow_items WHERE id=$1`, [itemId])).rows[0];
    ok(back.status === 'open' && back.removed_at === null && back.removed_by === null && back.removed_reason === null, 'the removal stamps are cleared on restore');
    ok((await db.query(`SELECT count(*)::int AS n FROM workflow_events WHERE workflow_item_id=$1 AND event_type='restored'`, [itemId])).rows[0].n === 1, 'a workflow_events "restored" row is written');
    // guards on the wrong state
    await db.query(`UPDATE workflow_items SET status='returned' WHERE id=$1`, [itemId]);
    ok((await call(`/api/staff/workflow/${itemId}/remove`, { method: 'POST', body: '{}' })).status === 409, 'removing a finished item → 409');
    ok((await call(`/api/staff/workflow/${itemId}/restore`, { method: 'POST', body: '{}' })).status === 409, 'restoring a never-removed item → 409');

    console.log('\n§5  an unknown view name is refused');
    ok((await call(`/api/staff/applications/${appId}/workflow/nonsense/remove`, { method: 'POST', body: '{}' })).status === 400, 'an unknown workflow view → 400');
  } catch (e) { console.error('THREW', e); fail++; }

  await db.query(`DELETE FROM purchasing_workflow WHERE application_id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM closing_workflow WHERE application_id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM workflow_items WHERE application_id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM audit_log WHERE entity_id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE email=$1`, [`${tag}@example.com`]).catch(() => {});
  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  console.log(fail ? `\nFAILED — ${fail} check(s)\n` : '\nPASSED\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

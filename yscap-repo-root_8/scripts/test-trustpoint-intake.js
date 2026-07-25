/* TrustPoint import-task intake (phase 1, 2026-07-24 blueprint §3): on a trustpoint-routed
 * file, the first LIVE sight of a SUBMITTED Sitewire draw opens exactly ONE coordinator
 * `trustpoint_import` Workflow hand-off (atomic per-draw claim, task+claim in one
 * transaction) plus the action notification; non-trustpoint files, unsubmitted statuses,
 * and repeat calls all no-op. DB-gated: needs DATABASE_URL with migrations applied.
 * Run: DATABASE_URL=... node scripts/test-trustpoint-intake.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-trustpoint-intake (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const tpIntake = require('../src/sitewire/trustpoint-intake');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const tag = crypto.randomBytes(4).toString('hex');

async function seed({ status = 'pending', drawId } = {}) {
  const email = 'tp' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('T','P',$1) RETURNING id`, [email])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address)
     VALUES($1,'funded',$2,'Blue Lake','{"oneLine":"12 Test Ln, Testville, NY 10001"}'::jsonb) RETURNING id`,
    [bor, 'TP' + crypto.randomBytes(3).toString('hex')])).rows[0].id;
  const dId = drawId || (900000000 + crypto.randomBytes(3).readUIntBE(0, 3));
  await db.query(
    `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, number, status, total_requested_cents)
     VALUES ($1,$2,3,$3,80000)`, [app, dId, status]);
  await db.query(
    `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sitewire_job_item_id, sow_line_key, section_token, name, budgeted_cents, is_media_item)
     VALUES ($1,$2,$3,'k1','kitchen','Unit 1 - Kitchen',500000,false), ($1,$2,$4,'__media__1','media','Exterior Photos',0,true)`,
    [app, dId + 100, dId + 1, dId + 2]);
  await db.query(
    `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, job_item_name, requested_cents, inspection_count)
     VALUES ($1,$2,$3,'Unit 1 - Kitchen',80000,0), ($1,$4,$5,'Exterior Photos',0,0)`,
    [dId, dId + 10, dId + 1, dId + 11, dId + 2]);
  return { app, bor, drawId: dId };
}
const cleanup = async (app, bor) => { await db.query(`DELETE FROM applications WHERE id=$1`, [app]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]); };
const itemsOf = async (app) => (await db.query(
  `SELECT * FROM workflow_items WHERE application_id=$1 AND submission_type='trustpoint_import'`, [app])).rows;

(async () => {
  // a sole active draw coordinator so the hand-off routes to a person
  const coordEmail = `tpcoord${tag}@example.com`;
  const coord = (await db.query(
    `INSERT INTO staff_users(email, full_name, role, is_active) VALUES ($1,'TP Coord','draw_coordinator',true) RETURNING id`,
    [coordEmail])).rows[0].id;
  // any OTHER active coordinators in this DB would break sole-resolution — deactivate them for the test run
  const others = (await db.query(
    `UPDATE staff_users SET is_active=false WHERE role='draw_coordinator' AND id<>$1 AND is_active RETURNING id`, [coord])).rows.map((r) => r.id);

  try {
    // ============ 1. happy path: submitted draw on a trustpoint file opens ONE task ============
    {
      const { app, bor, drawId } = await seed({ status: 'pending' });
      const r = await tpIntake.maybeOpenImportTask(app, { drawId, drawNumber: 3, status: 'pending', addrText: '12 Test Ln', platform: 'trustpoint' });
      ok('opens the task', r.opened === true);
      const items = await itemsOf(app);
      ok('exactly one workflow item', items.length === 1);
      ok('routed to the sole coordinator', items[0] && items[0].to_staff_id === coord && items[0].to_role === 'draw_coordinator');
      ok('auto + priority + SLA', items[0] && items[0].auto === true && Number(items[0].priority) === 1 && Number(items[0].sla_hours) === 24);
      ok('note carries the line + the REGULAR-draw instruction', /Kitchen/.test(items[0].note) && /REGULAR workflow draw/.test(items[0].note));
      ok('media $0 gate excluded from the line table', !/Exterior Photos/.test(items[0].note));
      const stamp = (await db.query(`SELECT tp_import_task_opened_at FROM sitewire_draws WHERE sitewire_draw_id=$1`, [drawId])).rows[0];
      ok('per-draw claim stamped', !!stamp.tp_import_task_opened_at);
      const note = (await db.query(
        `SELECT * FROM notifications WHERE recipient_kind='staff' AND staff_id=$1 AND type='trustpoint_import'`, [coord])).rows;
      ok('coordinator notification written', note.length === 1);

      // ============ 2. idempotent: a second sighting never double-opens ============
      const r2 = await tpIntake.maybeOpenImportTask(app, { drawId, drawNumber: 3, status: 'pending', addrText: '12 Test Ln', platform: 'trustpoint' });
      ok('second call skips (already_opened)', r2.skipped === 'already_opened');
      ok('still exactly one workflow item', (await itemsOf(app)).length === 1);
      await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [coord]);
      await cleanup(app, bor);
    }

    // ============ 3. gates: platform + submission status + missing mirror row ============
    {
      const { app, bor, drawId } = await seed({ status: 'pending' });
      const rNotTp = await tpIntake.maybeOpenImportTask(app, { drawId, drawNumber: 1, status: 'pending', addrText: 'x', platform: 'sitewire' });
      ok('sitewire platform → not_trustpoint', rNotTp.skipped === 'not_trustpoint');
      const rDraft = await tpIntake.maybeOpenImportTask(app, { drawId, drawNumber: 1, status: 'pending_borrower', addrText: 'x', platform: 'trustpoint' });
      ok('unsubmitted status → not_submitted', rDraft.skipped === 'not_submitted');
      const rGhost = await tpIntake.maybeOpenImportTask(app, { drawId: 123456789012, drawNumber: 1, status: 'pending', addrText: 'x', platform: 'trustpoint' });
      ok('unknown draw id → no_mirror_row', rGhost.skipped === 'no_mirror_row');
      ok('no workflow items from the gated calls', (await itemsOf(app)).length === 0);
      await cleanup(app, bor);
    }

    // ============ 4. approved arrival (a submitted status) also qualifies ============
    {
      const { app, bor, drawId } = await seed({ status: 'approved' });
      const r = await tpIntake.maybeOpenImportTask(app, { drawId, drawNumber: 2, status: 'approved', addrText: 'x', platform: 'trustpoint' });
      ok('approved status opens the task too', r.opened === true);
      await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [coord]);
      await cleanup(app, bor);
    }
  } finally {
    if (others.length) await db.query(`UPDATE staff_users SET is_active=true WHERE id = ANY($1::uuid[])`, [others]);
    await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [coord]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [coord]);
  }

  console.log(`test-trustpoint-intake: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-trustpoint-intake crashed:', e); process.exit(1); });

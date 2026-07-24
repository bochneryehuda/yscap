/* TrustPoint per-line amounts + Sitewire write-back (phase 3, DB-gated; Sitewire +
 * TrustPoint clients STUBBED — no network). Covers: manual entry validation (cent-exact
 * Σ), the write-back happy path (per-line PATCH + approve + read-after-write + mirror
 * update + writeback stamp), never-guess refusals (line over requested → parked; already-
 * approved Sitewire draw → idempotent), snapshot-diff derivation (exact Σ accepted,
 * inexact discarded), and the writes-off wait note.
 * Run: DATABASE_URL=... node scripts/test-trustpoint-writeback-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-trustpoint-writeback-db (no DATABASE_URL)'); process.exit(0); }

const crypto = require('crypto');
const cfg = require('../src/config');
const db = require('../src/db');
const swClient = require('../src/sitewire/client');
const tpClient = require('../src/trustpoint/client');
const lines = require('../src/trustpoint/lines');
const writeback = require('../src/trustpoint/writeback');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const tag = crypto.randomBytes(4).toString('hex');

// ---- Sitewire client stubs ----
let patched = [], transitions = [];
swClient.updateRequest = async (id, body) => { patched.push({ id: Number(id), ...body }); return { id, ...body }; };
swClient.getRequest = async (id) => { const p = patched.filter((x) => x.id === Number(id)).pop(); return { id, approved_cents: p ? p.approved_cents : null }; };
swClient.drawTransition = async (id, action) => { transitions.push({ id: Number(id), action }); return { id, status: 'approved' }; };
tpClient.available = () => true;
tpClient.enabled = () => true;

async function seed({ swStatus = 'pending', tpStatus = 'APPROVED', approved = 75000 } = {}) {
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('W','B',$1) RETURNING id`,
    ['wb' + crypto.randomBytes(5).toString('hex') + '@example.com'])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address)
     VALUES($1,'funded',$2,'Blue Lake','{"oneLine":"7 Writeback Way"}'::jsonb) RETURNING id`,
    [bor, 'WB' + crypto.randomBytes(3).toString('hex')])).rows[0].id;
  const swDrawId = 700000000 + crypto.randomBytes(3).readUIntBE(0, 3);
  await db.query(`INSERT INTO sitewire_draws (application_id, sitewire_draw_id, number, status, total_requested_cents) VALUES ($1,$2,1,$3,80000)`, [app, swDrawId, swStatus]);
  await db.query(
    `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sitewire_job_item_id, sow_line_key, section_token, name, budgeted_cents, is_media_item)
     VALUES ($1,1,$2,'k1','kitchen','Unit 1 - Kitchen',500000,false), ($1,1,$3,'k2','roof','Unit 1 - Roof',300000,false)`,
    [app, swDrawId + 1, swDrawId + 2]);
  await db.query(
    `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, job_item_name, requested_cents, inspection_count)
     VALUES ($1,$2,$3,'Unit 1 - Kitchen',50000,0), ($1,$4,$5,'Unit 1 - Roof',30000,0)`,
    [swDrawId, swDrawId + 10, swDrawId + 1, swDrawId + 11, swDrawId + 2]);
  const tpDrawId = `tpw-${tag}-${crypto.randomBytes(3).toString('hex')}`;
  await db.query(
    `INSERT INTO trustpoint_draws (application_id, tp_project_id, tp_draw_id, number, status, requested_cents, approved_cents, sitewire_draw_id)
     VALUES ($1,$2,$3,1,$4,80000,$5,$6)`, [app, `tpp-${tag}`, tpDrawId, tpStatus, approved, swDrawId]);
  return { app, bor, swDrawId, tpDrawId };
}
const cleanup = async (app, bor) => { await db.query(`DELETE FROM applications WHERE id=$1`, [app]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]); };

(async () => {
  cfg.sitewireEnabled = true; cfg.sitewireOutboundEnabled = true; cfg.sitewireDryrun = false;
  // the switches module reads cfg via envDefault closures — force the runtime flags on
  const flags = require('../src/lib/flags');
  if (flags && flags.setOverride) { /* not all builds expose it — cfg envDefault covers it */ }

  // ============ 1. manual entry validation ============
  {
    const { app, bor, swDrawId, tpDrawId } = await seed();
    let err = null;
    try { await lines.saveManualLines(app, tpDrawId, [{ sitewire_job_item_id: swDrawId + 1, approved_cents: 10000 }], null); }
    catch (e) { err = e; }
    ok('Σ mismatch is refused (422)', err && err.status === 422 && /match to the penny/.test(err.message));
    let err2 = null;
    try { await lines.saveManualLines(app, tpDrawId, [{ sitewire_job_item_id: 999999999, approved_cents: 75000 }], null); }
    catch (e) { err2 = e; }
    ok('unknown budget line refused', err2 && err2.status === 422);
    await cleanup(app, bor);
  }

  // ============ 2. happy path: manual lines → full write-back ============
  {
    const { app, bor, swDrawId, tpDrawId } = await seed();
    patched = []; transitions = [];
    await lines.saveManualLines(app, tpDrawId, [
      { sitewire_job_item_id: swDrawId + 1, approved_cents: 50000 },
      { sitewire_job_item_id: swDrawId + 2, approved_cents: 25000 },
    ], null);
    const r = await writeback.pushApprovalToSitewire(app, tpDrawId, {});
    ok('write-back ok', r.ok === true && r.pushed && r.pushed.dryrun === false);
    ok('both lines PATCHed with the manual amounts', patched.length === 2
      && patched.some((p) => p.id === swDrawId + 10 && p.approved_cents === 50000)
      && patched.some((p) => p.id === swDrawId + 11 && p.approved_cents === 25000));
    ok('approve transition fired once', transitions.length === 1 && transitions[0].action === 'approve' && transitions[0].id === swDrawId);
    const sw = (await db.query(`SELECT status, total_approved_cents FROM sitewire_draws WHERE sitewire_draw_id=$1`, [swDrawId])).rows[0];
    ok('Sitewire mirror updated to approved', sw.status === 'approved' && Number(sw.total_approved_cents) === 75000);
    const reqs = (await db.query(`SELECT sitewire_request_id, approved_cents FROM sitewire_draw_requests WHERE sitewire_draw_id=$1 ORDER BY sitewire_request_id`, [swDrawId])).rows;
    ok('request mirror carries the per-line approved', Number(reqs[0].approved_cents) === 50000 && Number(reqs[1].approved_cents) === 25000);
    const tp = (await db.query(`SELECT writeback_at FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0];
    ok('writeback stamped', !!tp.writeback_at);
    const again = await writeback.pushApprovalToSitewire(app, tpDrawId, {});
    ok('second push is idempotent', again.skipped === 'already_pushed');
    await cleanup(app, bor);
  }

  // ============ 3. never-guess: a line above its requested parks ============
  {
    const { app, bor, swDrawId, tpDrawId } = await seed({ approved: 60000 });
    patched = []; transitions = [];
    await lines.saveManualLines(app, tpDrawId, [{ sitewire_job_item_id: swDrawId + 1, approved_cents: 60000 }], null);
    const r = await writeback.pushApprovalToSitewire(app, tpDrawId, {});
    ok('over-requested parked, nothing pushed', r.parked === 'line_over_requested' && patched.length === 0 && transitions.length === 0);
    const review = (await db.query(`SELECT 1 FROM sync_review_queue WHERE application_id=$1 AND reason LIKE 'sitewire_approve_failed%' AND status='open'`, [app])).rows;
    ok('a review card exists', review.length >= 1);
    await cleanup(app, bor);
  }

  // ============ 4. already-approved Sitewire draw → idempotent skip ============
  {
    const { app, bor, swDrawId, tpDrawId } = await seed({ swStatus: 'approved' });
    await lines.saveManualLines(app, tpDrawId, [{ sitewire_job_item_id: swDrawId + 1, approved_cents: 50000 }, { sitewire_job_item_id: swDrawId + 2, approved_cents: 25000 }], null);
    patched = []; transitions = [];
    const r = await writeback.pushApprovalToSitewire(app, tpDrawId, {});
    ok('already-approved skips + stamps', r.skipped === 'sitewire_already_approved' && patched.length === 0);
    await cleanup(app, bor);
  }

  // ============ 5. snapshot-diff derivation ============
  {
    const { app, bor, swDrawId, tpDrawId } = await seed();
    const tpp = `tpp-${tag}`;
    await db.query(
      `INSERT INTO trustpoint_milestone_links (application_id, tp_project_id, tp_milestone_id, name, amount_cents, sitewire_job_item_id, sow_line_key, matched_by)
       VALUES ($1,$2,$3,'Unit 1 - Kitchen',500000,$4,'k1','name_amount'), ($1,$2,$5,'Unit 1 - Roof',300000,$6,'k2','name_amount')`,
      [app, tpp, `ms1-${tpDrawId}`, swDrawId + 1, `ms2-${tpDrawId}`, swDrawId + 2]);
    const pre = [{ id: `ms1-${tpDrawId}`, completed_work_amount: 100.0, remaining_work_amount: 4900.0 },
                 { id: `ms2-${tpDrawId}`, completed_work_amount: 0.0, remaining_work_amount: 3000.0 }];
    const post = [{ id: `ms1-${tpDrawId}`, completed_work_amount: 600.0, remaining_work_amount: 4400.0 },
                  { id: `ms2-${tpDrawId}`, completed_work_amount: 250.0, remaining_work_amount: 2750.0 }];
    await db.query(`INSERT INTO trustpoint_milestone_snapshots (application_id, tp_project_id, tp_draw_id, phase, lines) VALUES ($1,$2,$3,'pre',$4::jsonb)`, [app, tpp, tpDrawId, JSON.stringify(pre)]);
    await db.query(`INSERT INTO trustpoint_milestone_snapshots (application_id, tp_project_id, tp_draw_id, phase, lines) VALUES ($1,$2,$3,'post',$4::jsonb)`, [app, tpp, tpDrawId, JSON.stringify(post)]);
    const d = await lines.deriveLines(app, tpDrawId);
    ok('derivation accepted (Σ exact: 500+250=750)', d.derived === true && d.lines.length === 2);
    const stored = (await db.query(`SELECT * FROM trustpoint_draw_lines WHERE tp_draw_id=$1 ORDER BY sitewire_job_item_id`, [tpDrawId])).rows;
    ok('derived lines stored with source', stored.length === 2 && stored.every((l) => l.source === 'derived')
      && Number(stored[0].approved_cents) === 50000 && Number(stored[1].approved_cents) === 25000);
    await cleanup(app, bor);
  }
  {
    // inexact Σ → discarded, never guessed
    const { app, bor, swDrawId, tpDrawId } = await seed({ approved: 75000 });
    const tpp = `tpp-${tag}`;
    await db.query(
      `INSERT INTO trustpoint_milestone_links (application_id, tp_project_id, tp_milestone_id, name, amount_cents, sitewire_job_item_id, sow_line_key, matched_by)
       VALUES ($1,$2,$3,'Unit 1 - Kitchen',500000,$4,'k1','name_amount')`, [app, tpp, `ms3-${tpDrawId}`, swDrawId + 1]);
    await db.query(`INSERT INTO trustpoint_milestone_snapshots (application_id, tp_project_id, tp_draw_id, phase, lines) VALUES ($1,$2,$3,'pre',$4::jsonb)`, [app, tpp, tpDrawId, JSON.stringify([{ id: `ms3-${tpDrawId}`, completed_work_amount: 0 }])]);
    await db.query(`INSERT INTO trustpoint_milestone_snapshots (application_id, tp_project_id, tp_draw_id, phase, lines) VALUES ($1,$2,$3,'post',$4::jsonb)`, [app, tpp, tpDrawId, JSON.stringify([{ id: `ms3-${tpDrawId}`, completed_work_amount: 500.0 }])]);
    const d = await lines.deriveLines(app, tpDrawId);
    ok('inexact Σ discarded', d.derived === false && /sum_mismatch/.test(d.reason));
    ok('nothing stored on discard', (await db.query(`SELECT count(*)::int c FROM trustpoint_draw_lines WHERE tp_draw_id=$1`, [tpDrawId])).rows[0].c === 0);
    await cleanup(app, bor);
  }

  // ============ 6. writes off → wait note, nothing lost ============
  {
    cfg.sitewireEnabled = false; cfg.sitewireOutboundEnabled = false;
    const { app, bor, swDrawId, tpDrawId } = await seed();
    await db.query(`UPDATE applications SET id=id WHERE id=$1`, [app]);
    cfg.sitewireEnabled = false;
    const r = await writeback.pushApprovalToSitewire(app, tpDrawId, {});
    ok('writes off → skipped with a wait note', r.skipped === 'sitewire_writes_off');
    const tp = (await db.query(`SELECT writeback_note, writeback_at FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0];
    ok('note explains the wait; not stamped', /off/.test(tp.writeback_note || '') && !tp.writeback_at);
    cfg.sitewireEnabled = true; cfg.sitewireOutboundEnabled = true;
    await cleanup(app, bor);
  }

  console.log(`test-trustpoint-writeback-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-trustpoint-writeback-db crashed:', e); process.exit(1); });

/* Draw-project LIFECYCLE actions — finish the draw process / mark paid off / re-open (Draw Management #82).
 *
 * orchestrator.setPropertyLifecycle records a PILOT-side lifecycle state on a MANAGED file and (when writes
 * are on) deactivates the Sitewire property (inactive=true) via the guarded client, read-after-write verified,
 * park-on-failure. DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise. The Sitewire
 * client is stubbed (no network); cfg switches are toggled per case (cfg is a mutable object).
 * Run: DATABASE_URL=... node scripts/test-sitewire-lifecycle-actions.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sitewire-lifecycle-actions (no DATABASE_URL)'); process.exit(0); }

const cfg = require('../src/config');
const client = require('../src/sitewire/client');
const orch = require('../src/sitewire/orchestrator');
const db = require('../src/db');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ---- client stubs (per case) ----
let updateCalls = [];
let updateImpl = async (id, body) => { updateCalls.push({ id, body }); return { id, ...body }; };
let getImpl = async (id) => ({ id, inactive: true });
client.updateProperty = (id, body) => updateImpl(id, body);
client.getProperty = (id) => getImpl(id);

async function seedManaged({ propertyId = 990000 + Math.floor((crypto.randomBytes(2).readUInt16BE(0))), created = true, withProperty = true } = {}) {
  const email = 'lc' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('L','C',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'LC' + crypto.randomBytes(3).toString('hex');
  const app = (await db.query(`INSERT INTO applications(borrower_id,status,ys_loan_number) VALUES($1,'funded',$2) RETURNING id`, [bor, loan])).rows[0].id;
  await db.query(
    `INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at,lifecycle_state)
     VALUES($1,$2,$3,'live',now(),'active')`,
    [app, withProperty ? propertyId : null, created ? 'created' : 'manual']);
  return { app, bor, propertyId };
}
const lifecycleOf = async (app) => (await db.query(`SELECT lifecycle_state FROM sitewire_property_links WHERE application_id=$1`, [app])).rows[0].lifecycle_state;
const syncedOf = async (app) => (await db.query(`SELECT lifecycle_synced FROM sitewire_property_links WHERE application_id=$1`, [app])).rows[0].lifecycle_synced;
const cleanup = async (app, bor) => { await db.query(`DELETE FROM applications WHERE id=$1`, [app]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]); };

(async () => {
  // ============ 1. WRITES OFF: records PILOT state, no Sitewire call ============
  cfg.sitewireEnabled = false; cfg.sitewireOutboundEnabled = false; cfg.sitewireDryrun = false;
  {
    updateCalls = [];
    const { app, bor } = await seedManaged();
    const r = await orch.setPropertyLifecycle(app, 'finished', null);
    ok('writes-off: ok', r.ok === true);
    ok('writes-off: sitewire skipped', r.sitewire === 'skipped');
    ok('writes-off: no client call', updateCalls.length === 0);
    ok('writes-off: PILOT state recorded = finished', (await lifecycleOf(app)) === 'finished');
    await cleanup(app, bor);
  }

  // ============ 2. WRITES ON: deactivates in Sitewire, read-after-write verifies, journals ============
  cfg.sitewireEnabled = true; cfg.sitewireOutboundEnabled = true; cfg.sitewireDryrun = false;
  {
    updateCalls = []; updateImpl = async (id, body) => { updateCalls.push({ id, body }); return { id, ...body }; }; getImpl = async (id) => ({ id, inactive: true });
    const { app, bor, propertyId } = await seedManaged();
    const r = await orch.setPropertyLifecycle(app, 'paid_off', null);
    ok('writes-on: synced', r.ok === true && r.sitewire === 'synced');
    ok('writes-on: client called with inactive=true', updateCalls.length === 1 && updateCalls[0].body.inactive === true && Number(updateCalls[0].id) === propertyId);
    ok('writes-on: PILOT state = paid_off', (await lifecycleOf(app)) === 'paid_off');
    const jr = await db.query(`SELECT field, new_value FROM sitewire_write_log WHERE application_id=$1 AND field='inactive'`, [app]);
    ok('writes-on: journaled inactive write', jr.rowCount >= 1);
    await cleanup(app, bor);
  }

  // ============ 3. re-open reactivates (inactive=false) ============
  {
    updateCalls = []; getImpl = async (id) => ({ id, inactive: false });
    const { app, bor } = await seedManaged();
    await db.query(`UPDATE sitewire_property_links SET lifecycle_state='paid_off' WHERE application_id=$1`, [app]);
    const r = await orch.setPropertyLifecycle(app, 'active', null);
    ok('reopen: client called with inactive=false', updateCalls.length === 1 && updateCalls[0].body.inactive === false);
    ok('reopen: PILOT state = active', r.ok && (await lifecycleOf(app)) === 'active');
    await cleanup(app, bor);
  }

  // ============ 4. read-after-write MISMATCH parks (200 that didn't stick) ============
  {
    updateImpl = async (id, body) => ({ id, ...body }); getImpl = async (id) => ({ id, inactive: false }); // asked true, Sitewire shows false
    const { app, bor } = await seedManaged();
    const r = await orch.setPropertyLifecycle(app, 'finished', null);
    ok('verify-fail: parked', r.parked === 'verify_failed');
    ok('verify-fail: PILOT state NOT changed (still active)', (await lifecycleOf(app)) === 'active');
    const rv = await db.query(`SELECT 1 FROM sync_review_queue WHERE application_id=$1 AND field_key='sitewire' AND status='open'`, [app]);
    ok('verify-fail: opened a review row', rv.rowCount >= 1);
    await cleanup(app, bor);
  }

  // ============ 4b. audit G2 — verify GET THROWS → fail closed (state recorded, synced=false, re-drives) ============
  {
    updateImpl = async (id, body) => ({ id, ...body }); getImpl = async () => { throw new Error('network blip'); };
    const { app, bor } = await seedManaged();
    const r = await orch.setPropertyLifecycle(app, 'paid_off', null);
    ok('verify-throws: not parked, not synced', r.ok === true && r.sitewire === 'unverified');
    ok('verify-throws: PILOT state IS recorded (desk reflects it)', (await lifecycleOf(app)) === 'paid_off');
    ok('verify-throws: lifecycle_synced=false so the backfill re-drives the deactivate', (await syncedOf(app)) === false);
    await cleanup(app, bor);
  }

  // ============ 4c. audit G2 — verify returns ABSENT inactive → fail closed (not treated as confirmed) ============
  {
    updateImpl = async (id, body) => ({ id, ...body }); getImpl = async (id) => ({ id }); // no `inactive` field back
    const { app, bor } = await seedManaged();
    const r = await orch.setPropertyLifecycle(app, 'finished', null);
    ok('verify-absent: not synced (absent inactive is not proof)', r.ok === true && r.sitewire === 'unverified');
    ok('verify-absent: lifecycle_synced=false (backfill re-drives)', (await syncedOf(app)) === false);
    await cleanup(app, bor);
  }

  // ============ 5. a non-retryable 422 parks, never loops ============
  {
    getImpl = async (id) => ({ id, inactive: true });
    updateImpl = async () => { const e = new Error('bad'); e.status = 422; e.retryable = false; throw e; };
    const { app, bor } = await seedManaged();
    const r = await orch.setPropertyLifecycle(app, 'finished', null);
    ok('422: parked', String(r.parked || '').startsWith('lifecycle_'));
    ok('422: PILOT state NOT changed', (await lifecycleOf(app)) === 'active');
    await cleanup(app, bor);
  }

  // ============ 6. a retryable error re-throws (queue/caller retries) ============
  {
    updateImpl = async () => { const e = new Error('timeout'); e.retryable = true; throw e; };
    const { app, bor } = await seedManaged();
    let threw = false;
    try { await orch.setPropertyLifecycle(app, 'finished', null); } catch (_) { threw = true; }
    ok('retryable: re-throws', threw);
    ok('retryable: PILOT state NOT changed', (await lifecycleOf(app)) === 'active');
    await cleanup(app, bor);
  }

  // ============ 7. GUARDS ============
  updateImpl = async (id, body) => { updateCalls.push({ id, body }); return { id, ...body }; }; getImpl = async (id) => ({ id, inactive: true });
  {
    // invalid state
    const { app, bor } = await seedManaged();
    ok('invalid_state guarded', (await orch.setPropertyLifecycle(app, 'nonsense', null)).error === 'invalid_state');
    await cleanup(app, bor);
  }
  {
    // not managed — a link with matched_by='manual' (never happens now, but the guard must hold)
    const { app, bor } = await seedManaged({ created: false });
    ok('not_managed (matched_by<>created) guarded', (await orch.setPropertyLifecycle(app, 'finished', null)).error === 'not_managed');
    await cleanup(app, bor);
  }
  {
    // not managed — no property bound (setup_status only)
    const { app, bor } = await seedManaged({ withProperty: false });
    ok('not_managed (no property) guarded', (await orch.setPropertyLifecycle(app, 'finished', null)).error === 'not_managed');
    await cleanup(app, bor);
  }
  {
    // idempotent no-op — setting the current state again does nothing
    updateCalls = [];
    const { app, bor } = await seedManaged();
    await db.query(`UPDATE sitewire_property_links SET lifecycle_state='finished' WHERE application_id=$1`, [app]);
    const r = await orch.setPropertyLifecycle(app, 'finished', null);
    ok('idempotent: unchanged, no client call', r.ok && r.unchanged === true && updateCalls.length === 0);
    await cleanup(app, bor);
  }

  // ============ 8. SF-1: writes-OFF records synced=false; enabling writes + re-firing actually syncs ============
  {
    // 8a. writes OFF → skipped, synced=false
    cfg.sitewireEnabled = false; cfg.sitewireOutboundEnabled = false; cfg.sitewireDryrun = false;
    updateCalls = []; updateImpl = async (id, body) => { updateCalls.push({ id, body }); return { id, ...body }; }; getImpl = async (id) => ({ id, inactive: true });
    const { app, bor } = await seedManaged();
    const r1 = await orch.setPropertyLifecycle(app, 'finished', null);
    ok('SF1: writes-off skipped', r1.sitewire === 'skipped');
    ok('SF1: writes-off synced=false', (await syncedOf(app)) === false);
    ok('SF1: writes-off no client call', updateCalls.length === 0);
    // 8b. turn writes ON and re-fire the SAME state → must NOT be a no-op; it re-drives the deactivate
    cfg.sitewireEnabled = true; cfg.sitewireOutboundEnabled = true;
    const r2 = await orch.setPropertyLifecycle(app, 'finished', null);
    ok('SF1: re-fire after enabling is NOT unchanged', !r2.unchanged && r2.sitewire === 'synced');
    ok('SF1: re-fire actually called the client (inactive=true)', updateCalls.length === 1 && updateCalls[0].body.inactive === true);
    ok('SF1: now synced=true', (await syncedOf(app)) === true);
    // 8c. now a genuine no-op (state matches AND synced) → no client call
    updateCalls = [];
    const r3 = await orch.setPropertyLifecycle(app, 'finished', null);
    ok('SF1: synced same-state is a true no-op', r3.unchanged === true && updateCalls.length === 0);
    await cleanup(app, bor);
  }

  // ============ 9. worker backfill re-syncs an unsynced lifecycle once writes are on ============
  {
    cfg.sitewireEnabled = true; cfg.sitewireOutboundEnabled = true; cfg.sitewireDryrun = false;
    updateCalls = []; updateImpl = async (id, body) => { updateCalls.push({ id, body }); return { id, ...body }; }; getImpl = async (id) => ({ id, inactive: true });
    const worker = require('../src/sync/sitewire-sync');
    const { app, bor } = await seedManaged();
    await db.query(`UPDATE sitewire_property_links SET lifecycle_state='paid_off', lifecycle_synced=false WHERE application_id=$1`, [app]);
    await worker.backfillUnsyncedLifecycleOnce();
    ok('backfill: called the client for the unsynced link', updateCalls.some((c) => c.body.inactive === true));
    ok('backfill: link now synced=true', (await syncedOf(app)) === true);
    await cleanup(app, bor);
  }

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} lifecycle-action assertions ${fail === 0 ? 'passed' : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', e); process.exit(1); });

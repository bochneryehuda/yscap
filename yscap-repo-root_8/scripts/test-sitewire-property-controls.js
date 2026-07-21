/* Sitewire PROPERTY CONTROLS from the PILOT desk (owner-directed 2026-07-21 — control the process from PILOT).
 *
 * orchestrator.updatePropertyControls flips the two CONFIRMED live Sitewire property fields on a MANAGED file:
 *   • inactive (Active ↔ Inactive)   • inspection_method (mobile/virtual ↔ traditional/on-site)
 * through the guarded client — circuit breaker, updateProperty, read-after-write verify (fail closed, park on
 * mismatch), journal, persist PILOT-side. getPropertyLive reads the live property (managed-only, never throws).
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise. The Sitewire client is stubbed.
 * Run: DATABASE_URL=... node scripts/test-sitewire-property-controls.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sitewire-property-controls (no DATABASE_URL)'); process.exit(0); }

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
let getImpl = async (id) => ({ id, inactive: false, inspection_method: 'mobile' });
client.updateProperty = (id, body) => updateImpl(id, body);
client.getProperty = (id) => getImpl(id);

async function seedManaged({ propertyId = 970000 + crypto.randomBytes(2).readUInt16BE(0), created = true, withProperty = true, method = null } = {}) {
  const email = 'pc' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('P','C',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'PC' + crypto.randomBytes(3).toString('hex');
  const app = (await db.query(`INSERT INTO applications(borrower_id,status,ys_loan_number) VALUES($1,'funded',$2) RETURNING id`, [bor, loan])).rows[0].id;
  await db.query(
    `INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at,lifecycle_state,inspection_method)
     VALUES($1,$2,$3,'live',now(),'active',$4)`,
    [app, withProperty ? propertyId : null, created ? 'created' : 'manual', method]);
  return { app, bor, propertyId };
}
const methodOf = async (app) => (await db.query(`SELECT inspection_method FROM sitewire_property_links WHERE application_id=$1`, [app])).rows[0].inspection_method;
const cleanup = async (app, bor) => { await db.query(`DELETE FROM applications WHERE id=$1`, [app]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]); };

(async () => {
  // ============ 1. WRITES OFF: no client call, tells the caller the connection is off ============
  cfg.sitewireEnabled = false; cfg.sitewireOutboundEnabled = false; cfg.sitewireDryrun = false;
  {
    updateCalls = [];
    const { app, bor } = await seedManaged();
    const r = await orch.updatePropertyControls(app, { inactive: true }, null);
    ok('writes-off: writes_off error', r.error === 'writes_off');
    ok('writes-off: no client call', updateCalls.length === 0);
    await cleanup(app, bor);
  }

  // ============ 2. WRITES ON: mark INACTIVE → client called, read-after-write verifies, journaled ============
  cfg.sitewireEnabled = true; cfg.sitewireOutboundEnabled = true; cfg.sitewireDryrun = false;
  {
    updateCalls = []; updateImpl = async (id, body) => { updateCalls.push({ id, body }); return { id, ...body }; };
    getImpl = async (id) => ({ id, inactive: true, inspection_method: 'mobile' });
    const { app, bor, propertyId } = await seedManaged();
    const r = await orch.updatePropertyControls(app, { inactive: true }, null);
    ok('inactive: synced', r.ok === true && r.sitewire === 'synced' && r.inactive === true);
    ok('inactive: client called with inactive=true on the right property', updateCalls.length === 1 && updateCalls[0].body.inactive === true && Number(updateCalls[0].id) === propertyId);
    ok('inactive: patch carried ONLY the inactive field', !('inspection_method' in updateCalls[0].body));
    const jr = await db.query(`SELECT 1 FROM sitewire_write_log WHERE application_id=$1 AND field='inactive'`, [app]);
    ok('inactive: journaled', jr.rowCount >= 1);
    await cleanup(app, bor);
  }

  // ============ 3. WRITES ON: reactivate (inactive=false) ============
  {
    updateCalls = []; getImpl = async (id) => ({ id, inactive: false, inspection_method: 'mobile' });
    const { app, bor } = await seedManaged();
    const r = await orch.updatePropertyControls(app, { inactive: false }, null);
    ok('reactivate: client called with inactive=false', r.ok && updateCalls.length === 1 && updateCalls[0].body.inactive === false);
    await cleanup(app, bor);
  }

  // ============ 4. change INSPECTION METHOD virtual→onsite: validated, pushed, verified, persisted PILOT-side ============
  {
    updateCalls = []; updateImpl = async (id, body) => { updateCalls.push({ id, body }); return { id, ...body }; };
    getImpl = async (id) => ({ id, inactive: false, inspection_method: 'traditional' });
    const { app, bor } = await seedManaged({ method: 'mobile' });
    const r = await orch.updatePropertyControls(app, { inspection_method: 'traditional' }, null);
    ok('method: synced', r.ok === true && r.sitewire === 'synced' && r.inspection_method === 'traditional');
    ok('method: client called with inspection_method=traditional', updateCalls.length === 1 && updateCalls[0].body.inspection_method === 'traditional');
    ok('method: persisted PILOT-side (link.inspection_method)', (await methodOf(app)) === 'traditional');
    const jr = await db.query(`SELECT 1 FROM sitewire_write_log WHERE application_id=$1 AND field='inspection_method'`, [app]);
    ok('method: journaled', jr.rowCount >= 1);
    await cleanup(app, bor);
  }

  // ============ 5. BOTH fields at once → single patch carries both ============
  {
    updateCalls = []; getImpl = async (id) => ({ id, inactive: true, inspection_method: 'mobile' });
    const { app, bor } = await seedManaged({ method: 'traditional' });
    const r = await orch.updatePropertyControls(app, { inactive: true, inspection_method: 'mobile' }, null);
    ok('both: one client call with both fields', updateCalls.length === 1 && updateCalls[0].body.inactive === true && updateCalls[0].body.inspection_method === 'mobile');
    ok('both: ok', r.ok === true);
    await cleanup(app, bor);
  }

  // ============ 5b. accepting_draws (Block Draws) — confirmed field, verified + journaled ============
  {
    updateCalls = []; updateImpl = async (id, body) => { updateCalls.push({ id, body }); return { id, ...body }; };
    getImpl = async (id) => ({ id, inactive: false, accepting_draws: false });
    const { app, bor } = await seedManaged();
    const r = await orch.updatePropertyControls(app, { accepting_draws: false }, null);
    ok('draws: client called with accepting_draws=false', updateCalls.length === 1 && updateCalls[0].body.accepting_draws === false);
    ok('draws: synced + returned', r.ok === true && r.sitewire === 'synced' && r.accepting_draws === false);
    const jr = await db.query(`SELECT 1 FROM sitewire_write_log WHERE application_id=$1 AND field='accepting_draws'`, [app]);
    ok('draws: journaled', jr.rowCount >= 1);
    await cleanup(app, bor);
  }

  // ============ 5c. sitewire_review (GC ↔ in-house) — confirmed field ============
  {
    updateCalls = []; getImpl = async (id) => ({ id, inactive: false, sitewire_review: false });
    const { app, bor } = await seedManaged();
    const r = await orch.updatePropertyControls(app, { sitewire_review: false }, null);
    ok('review: client called with sitewire_review=false', updateCalls.length === 1 && updateCalls[0].body.sitewire_review === false);
    ok('review: synced', r.ok === true && r.sitewire === 'synced' && r.sitewire_review === false);
    await cleanup(app, bor);
  }

  // ============ 5d. accepting_draws verify MISMATCH parks (200 that didn't stick) ============
  {
    updateImpl = async (id, body) => ({ id, ...body }); getImpl = async (id) => ({ id, accepting_draws: true }); // asked false, still true
    const { app, bor } = await seedManaged();
    const r = await orch.updatePropertyControls(app, { accepting_draws: false }, null);
    ok('draws verify-fail: parked', r.parked === 'verify_failed');
    await cleanup(app, bor);
  }

  // ============ 6. read-after-write MISMATCH parks (200 that didn't stick) — never persists ============
  {
    updateImpl = async (id, body) => ({ id, ...body }); getImpl = async (id) => ({ id, inactive: false, inspection_method: 'mobile' }); // asked inactive=true, Sitewire shows false
    const { app, bor } = await seedManaged();
    const r = await orch.updatePropertyControls(app, { inactive: true }, null);
    ok('verify-fail: parked', r.parked === 'verify_failed');
    const rv = await db.query(`SELECT 1 FROM sync_review_queue WHERE application_id=$1 AND field_key='sitewire' AND status='open'`, [app]);
    ok('verify-fail: opened a review row', rv.rowCount >= 1);
    await cleanup(app, bor);
  }

  // ============ 6b. verify GET absent field → unverified (not proof), still ok, method still persisted ============
  {
    updateImpl = async (id, body) => ({ id, ...body }); getImpl = async (id) => ({ id }); // no fields back
    const { app, bor } = await seedManaged({ method: 'mobile' });
    const r = await orch.updatePropertyControls(app, { inspection_method: 'traditional' }, null);
    ok('verify-absent: unverified, not parked', r.ok === true && r.sitewire === 'unverified');
    ok('verify-absent: still persisted PILOT-side', (await methodOf(app)) === 'traditional');
    await cleanup(app, bor);
  }

  // ============ 7. a non-retryable 422 parks; a retryable error re-throws ============
  {
    getImpl = async (id) => ({ id, inactive: true, inspection_method: 'mobile' });
    updateImpl = async () => { const e = new Error('bad'); e.status = 422; e.retryable = false; throw e; };
    const { app, bor } = await seedManaged();
    const r = await orch.updatePropertyControls(app, { inactive: true }, null);
    ok('422: parked (settings_422)', String(r.parked || '').startsWith('settings_'));
    await cleanup(app, bor);
  }
  {
    updateImpl = async () => { const e = new Error('timeout'); e.retryable = true; throw e; };
    const { app, bor } = await seedManaged();
    let threw = false;
    try { await orch.updatePropertyControls(app, { inactive: true }, null); } catch (_) { threw = true; }
    ok('retryable: re-throws', threw);
    await cleanup(app, bor);
  }

  // ============ 8. GUARDS ============
  updateImpl = async (id, body) => { updateCalls.push({ id, body }); return { id, ...body }; }; getImpl = async (id) => ({ id, inactive: false, inspection_method: 'mobile' });
  {
    const { app, bor } = await seedManaged();
    ok('invalid_method guarded', (await orch.updatePropertyControls(app, { inspection_method: 'nonsense' }, null)).error === 'invalid_method');
    ok('nothing_to_change guarded', (await orch.updatePropertyControls(app, {}, null)).error === 'nothing_to_change');
    await cleanup(app, bor);
  }
  {
    const { app, bor } = await seedManaged({ created: false });
    ok('not_managed (matched_by<>created) guarded', (await orch.updatePropertyControls(app, { inactive: true }, null)).error === 'not_managed');
    await cleanup(app, bor);
  }
  {
    const { app, bor } = await seedManaged({ withProperty: false });
    ok('not_managed (no property) guarded', (await orch.updatePropertyControls(app, { inactive: true }, null)).error === 'not_managed');
    await cleanup(app, bor);
  }

  // ============ 9. getPropertyLive — managed live read; off + unmanaged degrade gracefully ============
  {
    cfg.sitewireEnabled = true;
    getImpl = async (id) => ({ id, inactive: true, inspection_method: 'traditional', some_unknown_field: 'x' });
    const { app, bor } = await seedManaged();
    const live = await orch.getPropertyLive(app);
    ok('live: available with the raw property (reveals real field names)', live.available === true && live.property && live.property.inactive === true && 'some_unknown_field' in live.property);
    await cleanup(app, bor);
  }
  {
    cfg.sitewireEnabled = false;
    const { app, bor } = await seedManaged();
    const live = await orch.getPropertyLive(app);
    ok('live: off → available:false reason off', live.available === false && live.reason === 'off');
    await cleanup(app, bor);
    cfg.sitewireEnabled = true;
  }
  {
    const { app, bor } = await seedManaged({ created: false });
    const live = await orch.getPropertyLive(app);
    ok('live: unmanaged → available:false reason not_managed', live.available === false && live.reason === 'not_managed');
    await cleanup(app, bor);
  }
  {
    getImpl = async () => { throw new Error('network blip'); };
    const { app, bor } = await seedManaged();
    const live = await orch.getPropertyLive(app);
    ok('live: unreachable → available:false reason error (never throws)', live.available === false && live.reason === 'error');
    await cleanup(app, bor);
  }

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} property-control assertions ${fail === 0 ? 'passed' : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', e); process.exit(1); });

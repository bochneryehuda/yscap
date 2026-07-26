'use strict';
/* Draw reset / re-push (owner-directed testing control, 2026-07-20).
 *
 * orchestrator.resetDrawSetup deactivates the Sitewire property, unlinks it in PILOT, tombstones its id
 * (raw.reset_property_ids) so a re-push skips ONLY that copy, clears the mirrored draw rows, and KEEPS the
 * money ledger. Also proves the pushFile collision check excludes a tombstoned id but still parks a genuine
 * pre-existing property. DB-gated; Sitewire client stubbed (no network). Run: DATABASE_URL=... node scripts/test-sitewire-reset-draw.js */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sitewire-reset-draw (no DATABASE_URL)'); process.exit(0); }

const cfg = require('../src/config');
const client = require('../src/sitewire/client');
const orch = require('../src/sitewire/orchestrator');
const db = require('../src/db');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok -', name); } else { fail++; console.log('  FAIL -', name); } };
const rnd = () => crypto.randomBytes(4).toString('hex');

let updateCalls = [];
client.updateProperty = async (id, body) => { updateCalls.push({ id, body }); return { id, ...body }; };
client.getProperty = async (id) => ({ id, inactive: true });

async function seedManaged(propId) {
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('R','S',$1) RETURNING id`, [`rs-${rnd()}@x.com`])).rows[0].id;
  const app = (await db.query(`INSERT INTO applications(borrower_id,status,ys_loan_number) VALUES($1,'funded',$2) RETURNING id`, [bor, 'RS' + rnd()])).rows[0].id;
  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,sitewire_budget_id,matched_by,state,pushed_at,lifecycle_state) VALUES($1,$2,$3,'created','live',now(),'active')`, [app, propId, propId + 1]);
  const drawId = 880000 + Math.floor(Math.random() * 9000);
  await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status) VALUES($1,$2,1,'approved')`, [app, drawId]);
  await db.query(`INSERT INTO sitewire_draw_requests(sitewire_draw_id,sitewire_request_id,sitewire_job_item_id,requested_cents,approved_cents) VALUES($1,$2,$3,100000,100000)`, [drawId, 700000 + Math.floor(Math.random() * 9000), 1]);
  await db.query(`INSERT INTO sitewire_job_item_links(application_id,sitewire_budget_id,sow_line_key,section_token,sitewire_job_item_id,name,budgeted_cents,state) VALUES($1,$2,'paint:0','p',$3,'Painting',500000,'live')`, [app, propId + 1, 1]);
  const f = (await db.query(`INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at) VALUES($1,$2,'delivered',100000,100000,now()) RETURNING id`, [app, drawId])).rows[0].id;
  await db.query(`INSERT INTO draw_finding_lines(finding_id,name,requested_cents,approved_cents) VALUES($1,'Painting',100000,100000)`, [f]);
  await db.query(`INSERT INTO draw_media(application_id,sitewire_draw_id,kind,source_url,source_key) VALUES($1,$2,'image','https://x/p.jpg',$3)`, [app, drawId, 'k' + rnd()]);
  // money ledger — MUST survive a reset
  await db.query(`INSERT INTO draw_disbursements(application_id,sitewire_draw_id,approved_cents,fee_cents,net_release_cents,funded_status,kind,created_by) VALUES($1,$2,100000,0,100000,'released','draw',NULL)`, [app, drawId]);
  return { app, bor, drawId };
}
const cleanup = async (app, bor) => { await db.query(`DELETE FROM applications WHERE id=$1`, [app]).catch(() => {}); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]).catch(() => {}); };
const count = async (sql, p) => Number((await db.query(sql, p)).rows[0].c) || 0;

(async () => {
  cfg.sitewireEnabled = true; cfg.sitewireOutboundEnabled = true; cfg.sitewireDryrun = false;

  // ---- 1. reset a managed file: deactivate + clear mirror + tombstone + KEEP ledger ----
  updateCalls = [];
  const PROP = 940000 + Math.floor(Math.random() * 9000);
  const { app, bor, drawId } = await seedManaged(PROP);
  const r = await orch.resetDrawSetup(app, null);
  ok('reset returns ok + was_managed', r.ok === true && r.was_managed === true);
  ok('reset deactivated the property in Sitewire (inactive=true)', updateCalls.length === 1 && String(updateCalls[0].id) === String(PROP) && updateCalls[0].body.inactive === true && r.sitewire === 'synced');
  const link = (await db.query(`SELECT sitewire_property_id, state, raw FROM sitewire_property_links WHERE application_id=$1`, [app])).rows[0];
  ok('property is unlinked (sitewire_property_id NULL)', link.sitewire_property_id === null);
  ok('old property id is tombstoned in raw.reset_property_ids', Array.isArray(link.raw.reset_property_ids) && link.raw.reset_property_ids.map(String).includes(String(PROP)));
  ok('mirrored draws cleared', (await count(`SELECT count(*) c FROM sitewire_draws WHERE application_id=$1`, [app])) === 0);
  ok('mirrored requests cleared', (await count(`SELECT count(*) c FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [drawId])) === 0);
  ok('mirrored findings + lines cleared', (await count(`SELECT count(*) c FROM draw_findings WHERE application_id=$1`, [app])) === 0 && (await count(`SELECT count(*) c FROM draw_finding_lines WHERE finding_id IN (SELECT id FROM draw_findings WHERE application_id=$1)`, [app])) === 0);
  ok('mirrored media cleared', (await count(`SELECT count(*) c FROM draw_media WHERE application_id=$1`, [app])) === 0);
  ok('crosswalk cleared', (await count(`SELECT count(*) c FROM sitewire_job_item_links WHERE application_id=$1`, [app])) === 0);
  ok('MONEY LEDGER is KEPT (draw_disbursements survive the reset)', (await count(`SELECT count(*) c FROM draw_disbursements WHERE application_id=$1`, [app])) === 1);
  ok('after reset, the file is no longer managed (Start-draw reappears)', (await orch.isManaged(app)) === false);
  await cleanup(app, bor);

  // ---- 2. the loan-number collision decision (pure): a tombstoned id is SKIPPED, a genuine one is RETURNED ----
  const CP = orch.collisionProperty;
  const props = [{ id: 111, loan_number: 'L1' }, { id: 222, loan_number: 'L2' }];
  ok('collision: a matching property with no reset-tombstone is returned (→ park, never adopt)', (CP(props, 'L1', []) || {}).id === 111);
  ok('collision: a matching property that WE reset (tombstoned) is skipped (→ clean re-push)', CP(props, 'L1', ['111']) === null);
  ok('collision: tombstoning one id does NOT skip a DIFFERENT genuine property on the same loan', (CP([{ id: 111, loan_number: 'L1' }, { id: 333, loan_number: 'L1' }], 'L1', ['111']) || {}).id === 333);
  ok('collision: numeric vs string ids compare correctly', CP([{ id: 111, loan_number: 'L1' }], 'L1', [111]) === null);
  ok('collision: no loan number → null (nothing to collide)', CP(props, '', ['111']) === null && CP(props, null, []) === null);
  ok('collision: no match → null', CP(props, 'NOPE', []) === null);

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} reset-draw assertions ${fail === 0 ? 'passed' : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

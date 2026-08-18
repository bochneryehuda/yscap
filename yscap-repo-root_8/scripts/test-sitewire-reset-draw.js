'use strict';
/* Draw reset / re-push (owner-directed testing control, 2026-07-20).
 *
 * orchestrator.resetDrawSetup deactivates the Sitewire property, unlinks it in PILOT, tombstones its id
 * (raw.reset_property_ids) so a re-push skips ONLY that copy, clears the mirrored draw rows, and KEEPS the
 * money ledger. Also proves the pushFile collision check excludes a tombstoned id but still parks a genuine
 * pre-existing property. DB-gated; Sitewire client stubbed (no network). Run: DATABASE_URL=... node scripts/test-sitewire-reset-draw.js */
/* ---- 0. THE BUTTON AND THE ROUTE AGREE ON THE CONFIRMATION CONTRACT (source
   guard — runs with or without a database, so CI's no-DB job holds it too).
   The route has required a typed `confirm_loan_number` since audit B-3
   (2026-07-21, wrong-file protection) — and the panel's button shipped posting
   an EMPTY body, so every click 400'd with the refusal in small grey print
   naming a field the screen never offered: "the button doesn't work"
   (owner-reported 2026-08-18). These pin BOTH sides to the same field so the
   contract can never drift apart silently again, and pin the owner's
   reset-ONLY semantics (nothing re-pushes until the coordinator starts it). */
{
  const fs0 = require('fs'); const path0 = require('path');
  const read0 = (p) => fs0.readFileSync(path0.join(__dirname, '..', p), 'utf8');
  let f0 = 0;
  const ok0 = (name, cond) => { console.log(`  ${cond ? 'ok ' : 'FAIL'} - ${name}`); if (!cond) f0++; };
  const route0 = read0('src/routes/sitewire.js');
  const panel0 = read0('app-v2/src/components/DrawsPanel.jsx');
  ok0('the route still requires the typed confirm_loan_number (audit B-3 stands)',
    /reset-draw'/.test(route0) && /confirm_loan_number/.test(route0));
  ok0('the panel SENDS confirm_loan_number on the reset call',
    /reset-draw`,\s*\{\s*confirm_loan_number:/.test(panel0));
  ok0('the loan number comes from a real prompt (await askPrompt)',
    /await askPrompt\([^)]*loan number/i.test(panel0));
  ok0('a cancelled prompt aborts with no request (null → return)',
    /typed == null\) return/.test(panel0));
  ok0('a refusal surfaces in the dialog, never only the small print',
    /await showMessage\(why/.test(panel0));
  ok0('the button is RESET-ONLY — "Reset draw setup", never "Reset & re-push" (owner-directed 2026-08-18)',
    /'Reset draw setup'/.test(panel0) && !/Reset & re-push/.test(panel0));
  if (f0) { console.log(`\n${f0} FAILED source-contract assertion(s)`); process.exit(1); }
}

if (!process.env.DATABASE_URL) { console.log('SKIP test-sitewire-reset-draw DB half (no DATABASE_URL) — source contract held above'); process.exit(0); }

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

  // ---- 3. THE REAL ROUTE, over real HTTP (the half that was never tested — which is
  // exactly how the empty-body 400 shipped: the suite exercised the FUNCTION while the
  // route grew a gate the client never learned). ----
  process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
  const C = require('../src/lib/crypto');
  const appSrv = require('../src/server');
  const server = appSrv.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sfx = rnd();
  const mkStaff = async (role) => (await db.query(
    `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
     VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`,
    [`rsdw-${role}-${sfx}@test.local`, `Reset ${role}`, role])).rows[0].id;
  const adminId = await mkStaff('admin');
  const superId = await mkStaff('super_admin');
  const adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
  const superTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
  const post = async (tok, appId2, body) => {
    const res = await fetch(`${base}/api/sitewire/files/${appId2}/reset-draw`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  updateCalls = [];
  const PROP3 = 950000 + Math.floor(Math.random() * 9000);
  const seeded = await seedManaged(PROP3);
  const loanNo = (await db.query(`SELECT ys_loan_number FROM applications WHERE id=$1`, [seeded.app])).rows[0].ys_loan_number;
  let h = await post(adminTok, seeded.app, { confirm_loan_number: loanNo });
  ok('route: a plain ADMIN is refused — super admin only', h.status === 403 && /super admin/i.test(h.body.error || ''));
  h = await post(superTok, seeded.app, {});
  ok('route: an EMPTY body is a 400 that NAMES confirm_loan_number (the shipped dead-click)',
    h.status === 400 && /confirm_loan_number/.test(h.body.error || ''));
  h = await post(superTok, seeded.app, { confirm_loan_number: 'WRONG-123' });
  ok('route: a wrong loan number is refused, nothing reset', h.status === 400 && /match/i.test(h.body.error || '')
    && (await count(`SELECT count(*) c FROM sitewire_property_links WHERE application_id=$1 AND sitewire_property_id IS NOT NULL`, [seeded.app])) === 1);
  h = await post(superTok, seeded.app, { confirm_loan_number: loanNo });
  ok('route: the right loan number RESETS — ok:true over real HTTP', h.status === 200 && h.body.ok === true && h.body.was_managed === true);
  ok('route: after the reset the file is back at the start (not managed → Start-draw card returns)',
    (await orch.isManaged(seeded.app)) === false);
  ok('route: the money ledger survived the HTTP reset too',
    (await count(`SELECT count(*) c FROM draw_disbursements WHERE application_id=$1`, [seeded.app])) === 1);
  // The owner's exact sequence: the Sitewire property was already deleted BY HAND before the
  // click — the deactivate fails, and the reset must STILL complete (unlink + start over).
  updateCalls = [];
  const failUpdate = client.updateProperty;
  client.updateProperty = async () => { const e = new Error('404 property not found'); e.status = 404; throw e; };
  const PROP4 = 960000 + Math.floor(Math.random() * 9000);
  const seeded2 = await seedManaged(PROP4);
  const loanNo2 = (await db.query(`SELECT ys_loan_number FROM applications WHERE id=$1`, [seeded2.app])).rows[0].ys_loan_number;
  h = await post(superTok, seeded2.app, { confirm_loan_number: loanNo2 });
  ok('route: a property already deleted in Sitewire still resets (deactivate failure never blocks)',
    h.status === 200 && h.body.ok === true && h.body.sitewire === 'failed'
    && (await orch.isManaged(seeded2.app)) === false);
  client.updateProperty = failUpdate;
  await cleanup(seeded.app, seeded.bor);
  await cleanup(seeded2.app, seeded2.bor);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[adminId, superId]]).catch(() => {});
  server.close();

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} reset-draw assertions ${fail === 0 ? 'passed' : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/**
 * QA seed — a realistic draw-management scenario for hands-on (browser) testing.
 * Creates a staff admin (for a token), a capital partner + rules + settings, an UNLINKED
 * funded file (exercises the "Start the draw process" card), and a FULLY-LINKED funded file
 * with a budget crosswalk + two draws + requests + a disbursement (exercises the whole desk).
 * Prints the ids the browser driver needs. Run:
 *   DATABASE_URL=... node scripts/qa-seed-draws.js
 */
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto.js');
const M = require('../src/sitewire/mapper');
const uuid = () => crypto.randomUUID();

const SOW = {
  propType: 'multi', units: 4,
  items: {
    'exterior:0': { on: true, applies: 'each', each: '6000', label: 'Roof' },
    'mep:6': { on: true, applies: 'split', u: { u1: '4000', u2: '4000', u3: '5000', u4: '5000' }, label: 'HVAC system' },
    'kitchen:0': { on: true, applies: 'common', common: '12000', label: 'Cabinets' },
    'flooring:2': { on: true, applies: 'each', each: '2000' }, // Tile (Flooring) — exercises disambiguation
    'baths:4': { on: true, applies: 'each', each: '1500' },    // Tile (Baths)
  },
  cont: { mode: 'pct', value: '10' }, gcFee: { mode: 'pct', value: '5' },
};

async function main() {
  const staffId = uuid();
  await db.query(`INSERT INTO staff_users (id,email,full_name,role,is_active,password_hash,token_version)
    VALUES ($1,'qa-admin@yscapgroup.com','QA Admin','super_admin',true,'x',0)
    ON CONFLICT (email) DO UPDATE SET role='super_admin',is_active=true RETURNING id`, [staffId]);
  const sid = (await db.query(`SELECT id,token_version FROM staff_users WHERE email='qa-admin@yscapgroup.com'`)).rows[0];
  const token = C.signJwt({ sub: sid.id, kind: 'staff', role: 'super_admin', tv: sid.token_version });

  const borrowerId = uuid();
  await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Jordan','Bloom','jordan.bloom@example.com')
    ON CONFLICT (email) DO NOTHING`, [borrowerId]);
  const bid = (await db.query(`SELECT id FROM borrowers WHERE email='jordan.bloom@example.com'`)).rows[0].id;

  // capital partner + rules + settings
  await db.query(`INSERT INTO sitewire_capital_partners (sitewire_id,name,on_our_lender,synced_at) VALUES (19,'Fidelis',true,now())
    ON CONFLICT (sitewire_id) DO UPDATE SET name='Fidelis',on_our_lender=true`);
  const RULE_CONFLICT = `(regexp_replace(lower(COALESCE(partner_label,'')), '[^a-z0-9]+', '', 'g'), COALESCE(program,''))`;
  await db.query(`INSERT INTO sitewire_inspection_rules (capital_partner_id,partner_label,program,inspection_method,require_sitewire_inspector,require_capital_partner_approval,allow_reallocation,fee_cents_virtual,fee_cents_physical,allow_virtual,allow_physical,handled_externally)
    VALUES (19,'Fidelis',NULL,'mobile',true,false,true,29900,49900,true,true,false)
    ON CONFLICT ${RULE_CONFLICT} DO UPDATE SET capital_partner_id=19,allow_virtual=true,allow_physical=true,fee_cents_physical=49900,handled_externally=false`);
  // a "handled externally" note buyer (NOT in the Sitewire directory) — files with this lender are never pushed
  await db.query(`INSERT INTO sitewire_inspection_rules (capital_partner_id,partner_label,program,inspection_method,require_sitewire_inspector,fee_cents_virtual,handled_externally)
    VALUES (NULL,'Churchill',NULL,'mobile',true,29900,true)
    ON CONFLICT ${RULE_CONFLICT} DO UPDATE SET handled_externally=true`);
  for (const [k, v] of [['variance_pct', '10'], ['stale_days', '30'], ['no_draw_days', '45'], ['wire_turnaround_hours', '48']]) {
    await db.query(`INSERT INTO sitewire_settings (key,value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=$2::jsonb`, [k, JSON.stringify(v)]);
  }

  // ---- File A: funded, UNLINKED (Start-draw card) ----
  const appA = uuid();
  await db.query(`INSERT INTO applications (id,borrower_id,status,ys_loan_number,lender,property_address,rehab_budget,property_type,loan_type,rehab_type,units)
    VALUES ($1,$2,'funded','YSCAP-QA-A','Fidelis',$3,78200,'Multi-family 2-4','RTL','Heavy Reno',4)`,
    [appA, bid, JSON.stringify({ line1: '18 Maple Ave', city: 'Newark', state: 'NJ', zip: '07104' })]);
  await db.query(`INSERT INTO checklist_items (id,scope,application_id,label,tool_key,tool_payload,status)
    VALUES ($1,'application',$2,'Scope of Work','rehab_budget',$3,'received')`,
    [uuid(), appA, JSON.stringify({ state: SOW, total: 78200 })]);

  // ---- File C: funded, note buyer HANDLED EXTERNALLY (Churchill) — Start card shows "handled externally" ----
  const appC = uuid();
  await db.query(`INSERT INTO applications (id,borrower_id,status,ys_loan_number,lender,property_address,rehab_budget,property_type,loan_type,rehab_type,units)
    VALUES ($1,$2,'funded','YSCAP-QA-C','Churchill',$3,78200,'Multi-family 2-4','RTL','Heavy Reno',4)`,
    [appC, bid, JSON.stringify({ line1: '5 Cedar Ln', city: 'Newark', state: 'NJ', zip: '07104' })]);
  await db.query(`INSERT INTO checklist_items (id,scope,application_id,label,tool_key,tool_payload,status)
    VALUES ($1,'application',$2,'Scope of Work','rehab_budget',$3,'received')`,
    [uuid(), appC, JSON.stringify({ state: SOW, total: 78200 })]);

  // ---- File B: funded, LINKED with crosswalk + draws ----
  const appB = uuid();
  await db.query(`INSERT INTO applications (id,borrower_id,status,ys_loan_number,lender,property_address,rehab_budget,property_type,loan_type,rehab_type,units)
    VALUES ($1,$2,'funded','YSCAP-QA-B','Fidelis',$3,78200,'Multi-family 2-4','RTL','Heavy Reno',4)`,
    [appB, bid, JSON.stringify({ line1: '92 Oak Street', city: 'Newark', state: 'NJ', zip: '07104' })]);
  await db.query(`INSERT INTO checklist_items (id,scope,application_id,label,tool_key,tool_payload,status)
    VALUES ($1,'application',$2,'Scope of Work','rehab_budget',$3,'received')`,
    [uuid(), appB, JSON.stringify({ state: SOW, total: 78200 })]);

  const propId = 5000, budgetId = 6000;
  await db.query(`INSERT INTO sitewire_property_links (application_id,sitewire_property_id,sitewire_budget_id,capital_partner_id,matched_by,state,inspection_method,pushed_at,updated_at)
    VALUES ($1,$2,$3,19,'created','live','mobile',now(),now())
    ON CONFLICT (application_id) DO UPDATE SET sitewire_property_id=$2,sitewire_budget_id=$3,state='live'`, [appB, propId, budgetId]);

  // crosswalk from a real explosion
  const ex = M.reconcileToBudget(M.explodeSow(SOW, {}), 7820000);
  M.uniquifyNames(ex.items);
  let jid = 7000;
  const byName = {};
  for (const it of ex.items) {
    const thisJid = jid++;
    byName[it.name] = thisJid;
    await db.query(`INSERT INTO sitewire_job_item_links (application_id,sitewire_budget_id,sow_line_key,section_token,unit_index,sitewire_job_item_id,name,budgeted_cents,is_media_item,state,last_pushed_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'live',now(),now())
      ON CONFLICT (application_id,sow_line_key,section_token) DO UPDATE SET sitewire_job_item_id=$6,name=$7,budgeted_cents=$8`,
      [appB, budgetId, it.sow_line_key, it.section_token, it.unit_index, thisJid, it.name, it.budgeted_cents, !!it.is_media_item]);
  }

  // Draw #1 — APPROVED (has a disbursement); Draw #2 — PENDING (awaiting approval on the desk)
  const draw1 = 8001, draw2 = 8002;
  const ev1 = [{ event: 'created', occurred_at: '2026-06-10T14:00:00Z' }, { event: 'lender_approve', occurred_at: '2026-06-14T16:00:00Z' }];
  const ev2 = [{ event: 'created', occurred_at: '2026-07-05T14:00:00Z' }];
  await db.query(`INSERT INTO sitewire_draws (application_id,sitewire_draw_id,sitewire_property_id,number,status,historical,total_requested_cents,total_approved_cents,submitted_at,approved_at,events,updated_at)
    VALUES ($1,$2,$3,1,'approved',false,1200000,1100000,'2026-06-10T14:00:00Z','2026-06-14T16:00:00Z',$4,now())
    ON CONFLICT (sitewire_draw_id) DO UPDATE SET status='approved',total_approved_cents=1100000`, [appB, draw1, propId, JSON.stringify(ev1)]);
  await db.query(`INSERT INTO sitewire_draws (application_id,sitewire_draw_id,sitewire_property_id,number,status,historical,total_requested_cents,total_approved_cents,submitted_at,events,updated_at)
    VALUES ($1,$2,$3,2,'pending',false,900000,0,'2026-07-05T14:00:00Z',$4,now())
    ON CONFLICT (sitewire_draw_id) DO UPDATE SET status='pending'`, [appB, draw2, propId, JSON.stringify(ev2)]);

  // requests (per-line) — draw 1 on Roof units 1&2; draw 2 on HVAC units 1&2 (pending, approvable)
  const reqs = [
    [draw1, 9001, byName['Unit 1 - Roof'], 'Unit 1 - Roof', 600000, 600000],
    [draw1, 9002, byName['Unit 2 - Roof'], 'Unit 2 - Roof', 600000, 500000],
    [draw2, 9003, byName['Unit 1 - HVAC system'], 'Unit 1 - HVAC system', 400000, null],
    [draw2, 9004, byName['Unit 2 - HVAC system'], 'Unit 2 - HVAC system', 500000, null],
  ];
  for (const [d, rid, ji, nm, req, appr] of reqs) {
    await db.query(`INSERT INTO sitewire_draw_requests (sitewire_draw_id,sitewire_request_id,sitewire_job_item_id,job_item_name,requested_cents,approved_cents,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (sitewire_request_id) DO UPDATE SET approved_cents=$6`, [d, rid, ji, nm, req, appr]);
  }

  // a disbursement for the approved draw 1 (net = approved - fee - retainage)
  await db.query(`INSERT INTO draw_disbursements (application_id,sitewire_draw_id,approved_cents,fee_cents,fee_kind,retainage_held_cents,net_release_cents,release_date,funded_status,created_by,created_at)
    VALUES ($1,$2,1100000,29900,'virtual',0,1070100,'2026-06-15','released',$3,now())`, [appB, draw1, sid.id]);

  console.log(JSON.stringify({ token, staffId: sid.id, appA, appB, appC, budgetId, names: Object.keys(byName) }, null, 2));
  await db.pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

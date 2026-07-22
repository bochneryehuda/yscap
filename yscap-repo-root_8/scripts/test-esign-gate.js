/**
 * DB-backed test for the appraisal send-gate (src/lib/esign/gate.js).
 * DATABASE_URL=postgres://... node scripts/test-esign-gate.js
 * Verifies: all three conditions required; P&P must be signed off AT/AFTER the
 * appraisal-back time (a pre-appraisal P&P sign-off does NOT unlock sending).
 */
const R = require('path').resolve(__dirname, '..');
const db = require(R + '/src/db');
const { esignSendGate } = require(R + '/src/lib/esign/gate');
let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++;} else {fail++; console.log('  FAIL:',m);} };

async function mkApp(withClosing=true){
  const b = await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('T','B',$1) RETURNING id`,[`g${Math.random()}@e.com`]);
  // Default apps carry an estimated closing date so the closing-date gate
  // (owner-directed 2026-07-22) is satisfied and the appraisal-gate assertions
  // below stay about the appraisal/P&P; a scenario that tests the closing
  // requirement itself passes withClosing=false.
  const a = await db.query(
    `INSERT INTO applications(borrower_id${withClosing?',expected_closing':''}) VALUES($1${withClosing?",'2026-09-01'":''}) RETURNING id`,[b.rows[0].id]);
  return a.rows[0].id;
}
async function tmpl(code){ return (await db.query(`SELECT id FROM checklist_templates WHERE code=$1`,[code])).rows[0].id; }
async function cond(appId, code, status, signedOffAt){
  const tid = await tmpl(code);
  await db.query(`INSERT INTO checklist_items(application_id,template_id,scope,label,status,signed_off_at)
                  VALUES($1,$2,'application',$3,$4,$5)`,[appId,tid,code,status,signedOffAt||null]);
}
const T0='2026-07-01T00:00:00Z', T1='2026-07-10T00:00:00Z', T2='2026-07-15T00:00:00Z';

(async()=>{
  // DB-gated like every other *-db suite in the `npm test` chain: CI runs with
  // no database, so skip cleanly there (a DB-enabled run exercises it fully).
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP esign send-gate DB test (no DATABASE_URL)'); return; }
  // 1. nothing satisfied -> not ready, all 3 outstanding
  let app = await mkApp();
  await cond(app,'rtl_cond_appraisaldocs','outstanding');
  await cond(app,'rtl_p3_apprreview','outstanding');
  await cond(app,'rtl_p1_product','outstanding');
  let g = await esignSendGate(app,{db});
  ok(g.ready===false, 'nothing satisfied -> not ready');
  ok(g.outstanding.length===3, 'nothing satisfied -> 3 outstanding');

  // 2. appraisal(T1)+review satisfied, P&P satisfied but signed BEFORE appraisal (T0) -> not ready
  app = await mkApp();
  await cond(app,'rtl_cond_appraisaldocs','satisfied',T1);
  await cond(app,'rtl_p3_apprreview','satisfied',T1);
  await cond(app,'rtl_p1_product','satisfied',T0);   // signed BEFORE appraisal
  g = await esignSendGate(app,{db});
  ok(g.ready===false, 'P&P signed before appraisal -> not ready');
  ok(g.outstanding.some(o=>o.code==='rtl_p1_product'), 'P&P flagged as re-register-after-appraisal');
  ok(g.outstanding.length===1, 'only P&P outstanding (appraisal+review ok)');

  // 3. all satisfied, P&P signed AFTER appraisal (T2 > T1) -> READY
  app = await mkApp();
  await cond(app,'rtl_cond_appraisaldocs','satisfied',T1);
  await cond(app,'rtl_p3_apprreview','satisfied',T1);
  await cond(app,'rtl_p1_product','satisfied',T2);   // signed AFTER appraisal
  g = await esignSendGate(app,{db});
  ok(g.ready===true, 'all satisfied + P&P after appraisal -> READY');
  ok(g.outstanding.length===0, 'ready -> nothing outstanding');

  // 4. appraisal NOT satisfied but review+P&P are -> not ready (appraisal + P&P-after both flagged)
  app = await mkApp();
  await cond(app,'rtl_cond_appraisaldocs','received');   // not satisfied
  await cond(app,'rtl_p3_apprreview','satisfied',T1);
  await cond(app,'rtl_p1_product','satisfied',T2);
  g = await esignSendGate(app,{db});
  ok(g.ready===false, 'appraisal not back -> not ready');
  ok(g.outstanding.some(o=>o.code==='rtl_cond_appraisaldocs'), 'appraisal flagged');

  // 5. P&P signed EXACTLY at appraisal time (>=) -> ready
  app = await mkApp();
  await cond(app,'rtl_cond_appraisaldocs','satisfied',T1);
  await cond(app,'rtl_p3_apprreview','satisfied',T1);
  await cond(app,'rtl_p1_product','satisfied',T1);   // equal
  g = await esignSendGate(app,{db});
  ok(g.ready===true, 'P&P signed exactly at appraisal time (>=) -> ready');

  // 6. Estimated closing date required for the TERM SHEET package (owner-directed
  //    2026-07-22): all appraisal/P&P conditions satisfied but NO closing date -> not ready.
  app = await mkApp(false);   // no closing date
  await cond(app,'rtl_cond_appraisaldocs','satisfied',T1);
  await cond(app,'rtl_p3_apprreview','satisfied',T1);
  await cond(app,'rtl_p1_product','satisfied',T2);
  g = await esignSendGate(app,{db});
  ok(g.ready===false, 'no estimated closing date -> term-sheet package NOT ready');
  ok(g.outstanding.length===1 && g.outstanding[0].code==='expected_closing', 'only the closing date is outstanding');
  // Heter Iska package is exempt from the closing-date requirement.
  g = await esignSendGate(app,{db,purpose:'heter_iska'});
  ok(g.ready===true, 'heter_iska is exempt from the closing-date requirement');
  // expected_closing set -> ready.
  await db.query(`UPDATE applications SET expected_closing='2026-09-01' WHERE id=$1`,[app]);
  g = await esignSendGate(app,{db});
  ok(g.ready===true, 'expected_closing set -> term-sheet package ready');
  ok(g.outstanding.length===0, 'closing date set -> nothing outstanding');

  // 7. The term-sheet mirror column est_closing_date alone also satisfies the gate.
  app = await mkApp(false);
  await cond(app,'rtl_cond_appraisaldocs','satisfied',T1);
  await cond(app,'rtl_p3_apprreview','satisfied',T1);
  await cond(app,'rtl_p1_product','satisfied',T2);
  await db.query(`UPDATE applications SET est_closing_date='2026-09-01' WHERE id=$1`,[app]);
  g = await esignSendGate(app,{db});
  ok(g.ready===true, 'est_closing_date alone also satisfies the closing gate');

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool?.end?.();
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});

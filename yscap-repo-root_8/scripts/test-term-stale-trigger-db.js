'use strict';
/**
 * DB test — the semantic term comparison in the reopen trigger (db/288) and the
 * per-requirement waiver round-trip through the send-gate (db/289), the fixes
 * for the owner-reported 2026-07-24 "Term: 12 → 12 Months" re-register loop.
 *
 *   DATABASE_URL=postgres://… node scripts/test-term-stale-trigger-db.js
 *
 * Proves, against a real Postgres:
 *   1. A cosmetic term re-spelling ("12" → "12 Months", any door) NEVER flags
 *      the current registration stale; a REAL term change still does, with the
 *      itemized reason.
 *   2. The registration write-back preserves the file's existing term spelling
 *      (registering the same months over "12 Months" leaves "12 Months").
 *   3. An approved exception with explicit waived_codes + decided_gate (jsonb
 *      round-trip) lets the gate send while un-waived blockers still block, and
 *      a reason drift after approval fails closed.
 */
const R = require('path').resolve(__dirname, '..');

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP term-stale trigger DB test (no DATABASE_URL)'); return; }
  const db = require(R + '/src/db');
  const LE = require(R + '/src/lib/loan-exceptions');
  const { esignSendGate } = require(R + '/src/lib/esign/gate');
  const { termWritebackText } = require(R + '/src/lib/term-text');
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
  const rnd = () => 'termtrig' + Math.random() + '@e.com';

  async function mkApp(term) {
    const b = await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('T','T',$1) RETURNING id`, [rnd()]);
    const a = await db.query(`INSERT INTO applications(borrower_id,term,expected_closing) VALUES($1,$2,'2026-09-01') RETURNING id`, [b.rows[0].id, term]);
    return a.rows[0].id;
  }
  async function mkReg(appId) {
    const r = await db.query(
      `INSERT INTO product_registrations(application_id, program, status, total_loan, inputs, quote, is_current)
       VALUES ($1,'standard','ELIGIBLE',500000,'{"term":12}','{}',true) RETURNING id`, [appId]);
    return r.rows[0].id;
  }
  const regState = async (id) => (await db.query(`SELECT stale, stale_reason FROM product_registrations WHERE id=$1`, [id])).rows[0];

  // ---- 1. trigger: cosmetic echo vs real change ----
  let app = await mkApp('12');
  let reg = await mkReg(app);
  await db.query(`UPDATE applications SET term='12 Months' WHERE id=$1`, [app]);   // ClickUp echo of the SAME term
  let st = await regState(reg);
  ok(st.stale === false, 'cosmetic "12" → "12 Months" does NOT stale the registration (the reported bug)');
  await db.query(`UPDATE applications SET term='12 months' WHERE id=$1`, [app]);   // case-only echo
  st = await regState(reg);
  ok(st.stale === false, 'case-only re-spelling does not stale');
  await db.query(`UPDATE applications SET term='18 Months' WHERE id=$1`, [app]);   // REAL change
  st = await regState(reg);
  ok(st.stale === true, 'a REAL term change still stales the registration');
  ok(/Term: 12 months → 18 Months/.test(st.stale_reason || ''), 'the reason itemizes the real old → new term');

  // ---- 2. write-back preserves spelling (unit, same helper the register path uses) ----
  ok(termWritebackText('12 Months', 12) === '12 Months', 'write-back keeps "12 Months" when registering the same months');
  ok(termWritebackText('12 Months', 18) === '18 Months', 'write-back writes the new label on a real change');

  // ---- 3. per-requirement waiver round-trip through jsonb + the gate ----
  // File with only the appraisal-review AND the stale-registration blockers
  // outstanding (appraisal back, P&P re-signed after, closing date set).
  app = await mkApp('12 Months');
  reg = await mkReg(app);
  const T1 = '2026-07-10T00:00:00Z', T2 = '2026-07-15T00:00:00Z';
  const tmpl = async (code) => (await db.query(`SELECT id FROM checklist_templates WHERE code=$1`, [code])).rows[0].id;
  const cond = async (code, status, at) => db.query(
    `INSERT INTO checklist_items(application_id,template_id,scope,label,status,signed_off_at) VALUES($1,$2,'application',$3,$4,$5)`,
    [app, await tmpl(code), code, status, at || null]);
  await cond('rtl_cond_appraisaldocs', 'satisfied', T1);
  await cond('rtl_p3_apprreview', 'outstanding');
  await cond('rtl_p1_product', 'satisfied', T2);
  await db.query(`UPDATE product_registrations SET stale=true, stale_reason='Pricing inputs changed — Term: 12 → 12 Months. Re-register the product and issue a new term sheet.' WHERE id=$1`, [reg]);

  let g = await esignSendGate(app, { db });
  ok(g.ready === false && g.sendAllowed === false, 'review + stale outstanding → not sendable');
  ok(g.outstanding.length === 2, 'exactly the two blockers outstanding');
  ok(Array.isArray(g.checks) && g.checks.length >= 5, 'the clear view lists every requirement (checks)');
  ok(g.checks.filter((c) => c.ok).length === 3, 'checks mark the three DONE requirements ✓');
  ok(g.canRequestException === true, 'exception can be requested even though a FLOOR blocker (stale) is outstanding');

  // Request (with snapshot) then approve waiving BOTH blockers, decided_gate pinned.
  const c = await db.getClient(); await c.query('BEGIN');
  const req = await LE.requestEsignBeforeCtc(c, {
    appId: app, reasonCode: 'system_issue', reasonNote: 'false stale flag', requestedBy: null,
    gateSnapshot: { at: new Date().toISOString(), checks: g.checks, outstanding: g.outstanding },
  });
  await c.query('COMMIT'); c.release();
  ok(req.gate_snapshot && Array.isArray(req.gate_snapshot.outstanding), 'the request stores the gate snapshot (jsonb round-trip)');

  const decidedGate = { at: new Date().toISOString(), outstanding: g.outstanding.map((o) => ({ code: o.code, label: o.label, reason: o.reason, tier: o.tier })) };
  // Waive ONLY the stale flag → the review must still block.
  await LE.decideException(req.id, 'approved', null, 'formatting echo confirmed', db, { waivedCodes: ['registration_stale'], decidedGate });
  g = await esignSendGate(app, { db });
  ok(g.sendAllowed === false, 'waiving only the stale flag leaves the review still blocking');
  ok(g.outstanding.find((o) => o.code === 'registration_stale').waived === true, 'the stale blocker reads waived');
  ok(g.unwaivedOutstanding.length === 1 && g.unwaivedOutstanding[0].code === 'rtl_p3_apprreview', 'the review is the one un-waived blocker');

  // Second exception waiving BOTH → sendable.
  const c2 = await db.getClient(); await c2.query('BEGIN');
  const req2 = await LE.requestEsignBeforeCtc(c2, { appId: app, reasonCode: 'system_issue', reasonNote: 'waive both', requestedBy: null, gateSnapshot: null });
  await c2.query('COMMIT'); c2.release();
  await LE.decideException(req2.id, 'approved', null, 'both waived', db, { waivedCodes: ['registration_stale', 'rtl_p3_apprreview'], decidedGate });
  g = await esignSendGate(app, { db });
  ok(g.sendAllowed === true && g.waivedByException === true, 'waiving every outstanding blocker → sendable by exception');

  // Reason drift after approval fails CLOSED: the registration re-stales for a REAL reason.
  await db.query(`UPDATE product_registrations SET stale_reason='Pricing inputs changed — Loan amount: $500,000 → $600,000. Re-register the product and issue a new term sheet.' WHERE id=$1`, [reg]);
  g = await esignSendGate(app, { db });
  ok(g.sendAllowed === false, 'a waived blocker firing for a DIFFERENT reason than approved blocks again (fail closed)');
  ok(g.outstanding.find((o) => o.code === 'registration_stale').waived === false, 'the drifted blocker is no longer waived');
  ok(g.canRequestException === true, 'the changed picture may be re-requested');

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool?.end?.();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

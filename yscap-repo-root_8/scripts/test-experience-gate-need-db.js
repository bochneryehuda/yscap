'use strict';
/**
 * THE EXPERIENCE GATE ASKS THE REGISTRATION FIRST — a claim lowered to zero
 * cannot sign off a condition the CURRENT registration still prices on.
 *
 * The 2026-08-09 end-to-end audit proved the bypass on the live door: with a
 * current registration whose inputs said {expFlips:3} and zero deals verified,
 * lowering `requested_exp_flips` to 0 made signOffGate return null — the
 * PATCH stamped the sign-off. The gate's old order was `claimed === 0 → pass`
 * BEFORE consulting `registeredExperienceNeed`. The fix asks `need` first, so
 * a lowered claim only relaxes the gate once the product is RE-REGISTERED.
 *
 * Driven over the REAL HTTP door (the audit's own path) — the gate lives in a
 * route closure, and the earlier findings-gate defect survived precisely
 * because a test bypassed the route.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
if (!process.env.DATABASE_URL) { console.log('SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const C = require('../src/lib/crypto');
const tag = `expgate_${process.pid}`;

let pass = 0; let fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.error(`  FAIL ${what}`); } };

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Gate Tester','super_admin')
     RETURNING id, token_version`, [`gate+${tag}@x.test`])).rows[0];
  const token = C.signJwt({ sub: staff.id, kind: 'staff', role: 'super_admin', tv: staff.token_version || 0 });
  const patch = (itemId, body) => fetch(`${base}/api/staff/checklist/${itemId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Gate','Case',$1) RETURNING id`,
    [`gatecase+${tag}@x.test`])).rows[0].id;
  const mkApp = async (flips) => (await db.query(
    `INSERT INTO applications (borrower_id, property_address, requested_exp_flips)
     VALUES ($1, $2::jsonb, $3) RETURNING id`,
    [borrowerId, JSON.stringify({ oneLine: `1 Gate St ${Math.random().toString(36).slice(2, 7)}, Lakewood, NJ 08701` }), flips])).rows[0].id;
  const mkItem = async (appId) => (await db.query(
    `INSERT INTO checklist_items (application_id, scope, label, audience, tool_key, status)
     VALUES ($1, 'application', 'Experience — verify the track record', 'staff', 'track_record', 'received') RETURNING id`,
    [appId])).rows[0].id;

  console.log('\n1. THE AUDITED BYPASS: claim lowered to 0, registration still needs 3');
  {
    const appId = await mkApp(0);   // the claim somebody lowered
    await db.query(
      `INSERT INTO product_registrations (application_id, program, inputs, quote, is_current)
       VALUES ($1, 'standard', $2::jsonb, '{}'::jsonb, true)`,
      [appId, JSON.stringify({ expFlips: 3, expHolds: 0, expGround: 0 })]);
    const itemId = await mkItem(appId);
    const r = await patch(itemId, { signedOff: true });
    const body = await r.json().catch(() => ({}));
    ok(r.status === 422, `sign-off is REFUSED (got HTTP ${r.status})`);
    ok(/experience/i.test(String(body.error || '')) && /3/.test(String(body.error || '')),
      `…and the refusal names the registered need (got: ${String(body.error || '').slice(0, 90)}…)`);
    const st = (await db.query(`SELECT signed_off_at FROM checklist_items WHERE id=$1`, [itemId])).rows[0];
    ok(!st.signed_off_at, '…and nothing was stamped');
  }

  console.log('\n2. CONTROL: no registration + no claim → signs off freely (unchanged)');
  {
    const appId = await mkApp(0);
    const itemId = await mkItem(appId);
    const r = await patch(itemId, { signedOff: true });
    ok(r.status === 200, `a genuinely no-experience file still signs off (got HTTP ${r.status})`);
  }

  console.log('\n3. CONTROL: no registration, claim of 2 → still refused (the claim governs)');
  {
    const appId = await mkApp(2);
    const itemId = await mkItem(appId);
    const r = await patch(itemId, { signedOff: true });
    ok(r.status === 422, `an unregistered file with a live claim still refuses (got HTTP ${r.status})`);
  }

  console.log('\n4. THE HONEST RELAXATION: re-register at zero → signs off');
  {
    const appId = await mkApp(0);
    await db.query(
      `INSERT INTO product_registrations (application_id, program, inputs, quote, is_current)
       VALUES ($1, 'standard', $2::jsonb, '{}'::jsonb, true)`,
      [appId, JSON.stringify({ expFlips: 0, expHolds: 0, expGround: 0 })]);
    const itemId = await mkItem(appId);
    const r = await patch(itemId, { signedOff: true });
    ok(r.status === 200, `a registration genuinely priced on zero experience signs off (got HTTP ${r.status})`);
  }

  console.log('\n5. THE TO-DO PAYLOAD AGREES WITH THE GATE (2026-08-09 pre-merge audit)');
  {
    const TODO = require('../src/lib/track-record-todo');
    // (a) the audited bypass shape: claim zeroed UNDER a live registration
    // needing 3 — the to-do must surface the registered need, never "nothing
    // required" on the exact file section 1 proved the gate refuses.
    const appId = await mkApp(0);
    await db.query(
      `INSERT INTO product_registrations (application_id, program, inputs, quote, is_current)
       VALUES ($1, 'standard', $2::jsonb, '{}'::jsonb, true)`,
      [appId, JSON.stringify({ expFlips: 3, expHolds: 0, expGround: 0 })]);
    const t = await TODO.trackRecordTodo(appId, { client: db });
    ok(!!t.experience, 'the experience block is present on a zeroed claim under a live registration');
    ok(!!t.experience && t.experience.need.flips === 3,
      `…carrying the REGISTERED need (got ${t.experience && JSON.stringify(t.experience.need)})`);
    ok(!!t.experience && t.experience.shortfall.some((x) => /3 more flips/.test(x.text)),
      '…and the shortfall says what the gate refuses with');
    ok(t.ok === false, '…so the to-do never reads "all done" on a file the gate refuses');

    // (b) UNREGISTERED IS INFORMATIONAL, NOT BLOCKING (the 2026-08-06 gate
    // rule): a fully-verified claim with no registration reads all-done —
    // `ok` turns on the shortfall alone, never on `registered`.
    const appId2 = await mkApp(1);
    const lineId = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_date, sale_date, entered_by_kind)
       VALUES ($1, $2::jsonb, 'flip', '2025-01-05', '2025-11-20', 'staff') RETURNING id`,
      [borrowerId, JSON.stringify({ oneLine: `9 Todo Agree Way ${tag}, Lakewood, NJ 08701` })])).rows[0].id;
    // verify through a non-material UPDATE (db/485 downgrades a raw verified INSERT)
    await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now() WHERE id=$1`, [lineId]);
    const t2 = await TODO.trackRecordTodo(appId2, { client: db });
    ok(!!t2.experience && t2.experience.registered === false && t2.experience.shortfall.length === 0,
      'a verified claim with no registration carries no shortfall');
    ok(t2.ok === (t2.summary.items === 0 && t2.findings.length === 0),
      `…and \`ok\` is decided WITHOUT the registered flag (ok=${t2.ok}, items=${t2.summary.items}, findings=${t2.findings.length})`);
  }

  server.close();
  console.log(`\n${fail ? 'FAILED' : 'OK'}  the gate asks the registration before it asks the claim — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE FAILED:', e); process.exit(1); });

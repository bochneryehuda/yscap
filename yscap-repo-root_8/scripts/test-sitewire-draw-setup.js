'use strict';
/**
 * End-to-end HTTP test of the Draw-Coordinator "Start draw process" flow + the
 * inspection-rules policy (allow_virtual / allow_physical, auto method, fee).
 * Boots the real server against a throwaway DB, seeds a funded file, and drives:
 *   POST /api/sitewire/rules           (admin sets an auto=virtual, both-allowed rule w/ fees)
 *   GET  /api/sitewire/rules           (allow_virtual/allow_physical round-trip)
 *   GET  /api/sitewire/files/:id/draw-setup   (prereqs, resolved method/fee, capital partner)
 *   POST /api/sitewire/files/:id/start-draw   (coordinator picks on-site; Sitewire off => queued)
 * Run: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/yscap_drawtest node scripts/test-sitewire-draw-setup.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:55432/yscap_drawtest';
process.env.JWT_SECRET = 'test-secret-draw-setup';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';
// Sitewire master switch OFF for this test — start-draw should record intent + queue the push.
delete process.env.SITEWIRE_ENABLED;
delete process.env.SITEWIRE_OUTBOUND_ENABLED;

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5731;
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function main() {
  const app = require(REPO + '/src/server.js');
  // migrate-boot runs on require; migrations are pre-applied so this settles fast — wait for the DB.
  for (let i = 0; i < 40; i++) {
    try { await db.query('SELECT 1 FROM staff_users LIMIT 1'); break; } catch (_) { await new Promise((r) => setTimeout(r, 250)); }
  }
  const server = app.listen(PORT);
  await new Promise((r) => server.on('listening', r));

  // ---- seed ----
  const staffId = uuid();
  await db.query(
    `INSERT INTO staff_users (id, email, full_name, role, is_active, password_hash, token_version)
     VALUES ($1,$2,$3,'super_admin',true,'x',0)`,
    [staffId, 'coordinator@yscapgroup.com', 'Lisa Katz']);
  const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

  const borrowerId = uuid();
  await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Test','Borrower',$2)`,
    [borrowerId, 'borrower+draw@example.com']);

  const appId = uuid();
  await db.query(
    `INSERT INTO applications (id, borrower_id, status, ys_loan_number, lender, property_address, rehab_budget)
     VALUES ($1,$2,'funded',$3,'Fidelis',$4,100000)`,
    [appId, borrowerId, 'YSCAP-DRAW-TEST-1',
      JSON.stringify({ street: '123 Test St', city: 'Newark', state: 'NJ', zip: '07104' })]);

  // capital partner directory row so the lender label "Fidelis" resolves exactly
  await db.query(
    `INSERT INTO sitewire_capital_partners (sitewire_id, name, on_our_lender, synced_at)
     VALUES (19,'Fidelis',true,now()) ON CONFLICT (sitewire_id) DO NOTHING`);

  // a Scope of Work saved on the file (state.target + total tie to the frozen budget)
  await db.query(
    `INSERT INTO checklist_items (id, scope, application_id, label, tool_key, tool_payload, status)
     VALUES ($1,'application',$2,'Scope of Work','rehab_budget',$3,'received')`,
    [uuid(), appId, JSON.stringify({ state: { target: 100000 }, total: 100000 })]);

  // ---- 1) admin sets a rule: auto=virtual, BOTH methods allowed, distinct fees ----
  let r = await api('POST', '/api/sitewire/rules', {
    capital_partner_id: 19, program: null, inspection_method: 'mobile',
    allow_virtual: true, allow_physical: true,
    require_sitewire_inspector: true, require_capital_partner_approval: false,
    fee_cents_virtual: 29900, fee_cents_physical: 49900,
  }, token);
  ok(r.status === 200 && r.body.ok, 'POST /rules saves a rule (200)');
  ok(r.body.rule && r.body.rule.allow_virtual === true && r.body.rule.allow_physical === true,
    'rule persists allow_virtual + allow_physical');

  // a rule whose default method is forbidden by its own allow flags is force-corrected
  r = await api('POST', '/api/sitewire/rules', {
    capital_partner_id: 19, program: 'edgecase', inspection_method: 'mobile',
    allow_virtual: false, allow_physical: true, fee_cents_virtual: 29900, fee_cents_physical: 49900,
  }, token);
  ok(r.status === 200 && r.body.rule.allow_virtual === true,
    'POST /rules never lets a rule forbid its own default method (auto-allows virtual)');

  // ---- 2) GET /rules returns the flags ----
  r = await api('GET', '/api/sitewire/rules', null, token);
  const fidelisRule = (r.body.rules || []).find((x) => Number(x.capital_partner_id) === 19 && !x.program);
  ok(r.status === 200 && fidelisRule && fidelisRule.allow_virtual === true && fidelisRule.allow_physical === true,
    'GET /rules returns allow_virtual/allow_physical');

  // ---- 3) GET /files/:id/draw-setup ----
  r = await api('GET', `/api/sitewire/files/${appId}/draw-setup`, null, token);
  ok(r.status === 200, 'GET /draw-setup 200');
  const d = r.body || {};
  ok(d.started === false, 'not started yet');
  ok(d.capital_partner && d.capital_partner.id === 19 && d.capital_partner.name === 'Fidelis',
    'capital partner resolved exactly (Fidelis #19)');
  ok(d.inspection && d.inspection.method === 'mobile' && d.inspection.fee_cents === 29900,
    'default method virtual @ $299 (fee from the rule)');
  ok(d.inspection.can_switch === true && d.inspection.allow_virtual && d.inspection.allow_physical,
    'coordinator may switch (both methods allowed)');
  ok(d.inspection.fee_physical_cents === 49900, 'on-site fee surfaced for the switch preview');
  ok(d.prereqs && d.prereqs.funded && d.prereqs.loan_number && d.prereqs.budget && d.prereqs.scope_of_work && d.prereqs.address && d.prereqs.capital_partner,
    'every prerequisite is met');
  ok(d.can_start === true, 'can_start is true when all prereqs pass');
  ok(d.switches && d.switches.enabled === false, 'reports Sitewire is off');

  // ---- 4) POST /start-draw — coordinator picks ON-SITE (allowed) ----
  r = await api('POST', `/api/sitewire/files/${appId}/start-draw`, { inspection_method: 'traditional' }, token);
  ok(r.status === 200 && r.body.ok && r.body.started === true && r.body.pushed === false,
    'start-draw records setup + queues the push (Sitewire off) => pushed:false');

  const link = (await db.query(`SELECT * FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0];
  ok(link && link.inspection_method === 'traditional', 'coordinator on-site choice stored on the link');
  ok(link && link.draw_setup_started_by === staffId && link.draw_setup_started_at,
    'who + when started is recorded');

  // Sitewire is OFF, so nothing is enqueued yet (the enqueue self-gates). The durable birth record
  // is the link row above; the worker's stranded-birth backfill re-enqueues it the moment the switch
  // flips. Prove that backfill SELECT would catch this coordinator-started file.
  const stranded = (await db.query(
    `SELECT a.id FROM applications a
      WHERE a.status='funded' AND a.deleted_at IS NULL
        AND (a.draw_setup_requested_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM sitewire_property_links s WHERE s.application_id=a.id AND s.draw_setup_started_at IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM sitewire_property_links l WHERE l.application_id=a.id AND l.sitewire_property_id IS NOT NULL)`)).rows;
  ok(stranded.some((x) => x.id === appId), 'the worker will catch this coordinator-started file when Sitewire turns on (stranded-birth backfill)');

  // ---- 5) draw-setup now reflects the coordinator's stored choice + on-site fee ----
  r = await api('GET', `/api/sitewire/files/${appId}/draw-setup`, null, token);
  ok(r.body.inspection.chosen_override === 'traditional' && r.body.inspection.method === 'traditional' && r.body.inspection.fee_cents === 49900,
    'draw-setup reflects the stored on-site choice + $499 fee');
  ok(r.body.started_at != null, 'draw-setup shows setup was started');

  // ---- 6) a DISALLOWED method is refused (never guessed) ----
  // set a virtual-only rule on a fresh program and try to force on-site
  const appId2 = uuid();
  await db.query(
    `INSERT INTO applications (id, borrower_id, status, ys_loan_number, lender, property_address, rehab_budget)
     VALUES ($1,$2,'funded',$3,'Fidelis',$4,50000)`,
    [appId2, borrowerId, 'YSCAP-DRAW-TEST-2', JSON.stringify({ street: '9 Elm St', city: 'Newark', state: 'NJ', zip: '07104' })]);
  await db.query(`UPDATE sitewire_inspection_rules SET allow_physical=false WHERE capital_partner_id=19 AND program IS NULL`);
  r = await api('POST', `/api/sitewire/files/${appId2}/start-draw`, { inspection_method: 'traditional' }, token);
  ok(r.status === 422, 'start-draw rejects a method the rule forbids (422, never guessed)');

  await new Promise((res) => server.close(res));
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end?.();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

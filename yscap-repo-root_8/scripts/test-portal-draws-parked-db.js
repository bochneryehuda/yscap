/* THE PORTAL DRAW COMPOSER IS PARKED (owner-directed 2026-08-26, compliance):
 * "According to our compliance, we are parking the option for portal draw requests …
 * We're not deleting it, we're parking it. … we shouldn't be able to order it on our
 * portal, and the borrower shouldn't be able to submit it on their portal. The only
 * way that draw requests can come in should be through Sitewire for now."
 *
 * What this suite proves, in order:
 *   A. the pure park module (default PARKED, the exact un-park spellings, the wording);
 *   B. SOURCE guards — the park is consulted where it must be (createRequest FIRST,
 *      composerState's eligible, the borrower eligibility payload, both screens) and
 *      NOWHERE it must not be (the Sitewire intake reconcile, the borrower Dashboard
 *      request-draw SETUP button — those keep flowing while parked);
 *   C. default-parked refusals on a REAL file: the lib doors (borrower + staff source)
 *      and the borrower's real HTTP doors both refuse 409 with the ONE wording, while
 *      funded/physical/set_up prove the park is the ONLY thing refusing;
 *   D. the un-park env restores composing (the machinery is parked, not deleted);
 *   E. an IN-FLIGHT request keeps flowing while parked: it stays visible on the state
 *      and the desk lever (cancel) still works — "Requests already in progress
 *      continue as normal."
 * Mutation-proven: stashing src/lib/portal-draws.js (reverting the park wiring) fails
 * the C/D assertions; deleting the reconcile guard is caught by B.
 * Run: DATABASE_URL=... node scripts/test-portal-draws-parked-db.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-parked';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';
delete process.env.PORTAL_DRAW_COMPOSER_PARKED; // start from the DEFAULT state

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
// A guard over "X is not consulted" must read the COMMENT-STRIPPED source: the code
// that parks the composer necessarily NAMES the park in comments elsewhere, and a
// guard that reads comments fails on its own explanation.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

// ============ A. the pure module ============
const parked = require('../src/sitewire/portal-draws-parked');
ok(parked.isParked({}) === true, 'A1 unset → PARKED (the default is the park)');
for (const v of ['0', 'false', 'no', 'off', 'OFF', ' 0 ']) {
  ok(parked.isParked({ PORTAL_DRAW_COMPOSER_PARKED: v }) === false, `A2 ${JSON.stringify(v)} un-parks`);
}
for (const v of ['1', 'true', 'yes', 'on', '', 'junk']) {
  ok(parked.isParked({ PORTAL_DRAW_COMPOSER_PARKED: v }) === true, `A3 ${JSON.stringify(v)} stays PARKED (unrecognised never un-parks)`);
}
ok(parked.isParked() === true, 'A4 the live environment (env deleted above) reads PARKED');
ok(/Sitewire construction portal/.test(parked.PARKED_REASON) && /parked/.test(parked.PARKED_REASON)
  && /already in progress/i.test(parked.PARKED_REASON),
  'A5 the ONE wording names the Sitewire portal, says "parked", and reassures about in-flight requests');

// ============ B. source guards — consulted where it must be, nowhere it must not ============
{
  const lib = read('src/lib/portal-draws.js');
  const createBody = lib.slice(lib.indexOf('async function createRequest'), lib.indexOf('async function historicalCloseOut'));
  const firstGate = createBody.indexOf("require('../sitewire/portal-draws-parked')");
  const stateCall = createBody.indexOf('composerState(appId)');
  ok(firstGate > -1 && stateCall > -1 && firstGate < stateCall && /throw err\(409, parked\.PARKED_REASON\)/.test(createBody),
    'B1 createRequest refuses PARKED FIRST — before any other gate, whoever is asking');
  const stateBody = lib.slice(lib.indexOf('async function composerState'), lib.indexOf('async function createRequest'));
  ok(/!composerParked/.test(stateBody) && /parked: composerParked/.test(stateBody) && /parked_reason/.test(stateBody),
    'B2 composerState folds the park into eligible AND reports parked + parked_reason (what every screen keys on)');

  const bd = read('src/routes/borrower-draws.js');
  ok(/parked: !!st\.parked/.test(bd) && /construction portal/.test(bd),
    'B3 the borrower eligibility payload carries composer.parked + the construction-portal next step');

  // The Sitewire INTAKE is the whole point of the park and must never consult it:
  // a draw submitted in Sitewire's own app still mirrors in while parked.
  ok(!stripComments(read('src/sitewire/reconcile.js')).includes('portal-draws-parked'),
    'B4 the Sitewire intake (reconcile.js) never consults the park');
  // The borrower Dashboard "Request a draw" SETUP button creates no draw request — it
  // opens the Sitewire integration, i.e. it IS the door into the only intake left.
  ok(!stripComments(read('src/routes/borrower.js')).includes('portal-draws-parked'),
    'B5 the borrower request-draw SETUP button (borrower.js) never consults the park');
  // The desk levers (cancel / close-out / approve-trinity) act on IN-FLIGHT requests
  // and must stay live while parked — none of them re-checks eligibility.
  const sw = stripComments(read('src/routes/sitewire.js'));
  ok(!sw.includes('portal-draws-parked'),
    'B6 the staff desk routes never consult the park directly (the one chokepoint is createRequest)');

  // A back end is not a feature: both screens render the parked note off st.parked.
  const dp = read('app-v2/src/components/DrawsPanel.jsx');
  ok(/st\.parked/.test(dp) && /parked_reason/.test(dp), 'B7 the staff PortalDrawsCard renders the parked note off the server state');
  const lo = read('app-v2/src/components/LoDrawView.jsx');
  ok(/st\.parked/.test(lo), 'B8 the LO view renders the parked note instead of the Request button');
}

if (!process.env.DATABASE_URL) {
  console.log(`\n(source + pure only — no DATABASE_URL) portal-draws-parked: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ============ C–E. the real file ============
const db = require('../src/db');
const C = require('../src/lib/crypto.js');
const http = require('http');
const portalDraws = require('../src/lib/portal-draws');

function api(server, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

(async () => {
  const tag = crypto.randomBytes(4).toString('hex');
  const LABEL = `ParkTrin${tag}`;
  // a physical-inspection (non-external, non-trustpoint) rule so the composer applies
  await db.query(
    `INSERT INTO sitewire_inspection_rules (partner_label, inspection_method, fee_cents_virtual, fee_cents_physical, allow_virtual, allow_physical, draw_platform)
     VALUES ($1,'traditional',29900,49900,false,true,'sitewire')
     ON CONFLICT (regexp_replace(lower(COALESCE(partner_label,'')), '[^a-z0-9]+', '', 'g'), COALESCE(program,'')) DO NOTHING`, [LABEL]);
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Park','Draw',$1) RETURNING id`,
    ['pk' + tag + '@example.com'])).rows[0].id;
  await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash, token_version) VALUES ($1,'x',0)`, [bor]);
  const lo = (await db.query(
    `INSERT INTO staff_users(email, full_name, role, is_active) VALUES ($1,'Park Officer','loan_officer',true) RETURNING id`,
    ['pklo' + tag + '@example.com'])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,rehab_budget,property_address,loan_officer_id)
     VALUES($1,'funded',$2,$3,1000,'{"oneLine":"8 Parked Pl, Testville, NY 10001","zip":"10001"}'::jsonb,$4) RETURNING id`,
    [bor, 'PK' + tag.toUpperCase(), LABEL, lo])).rows[0].id;
  const jid = 910000000 + crypto.randomBytes(3).readUIntBE(0, 3);
  await db.query(
    `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sitewire_job_item_id, sow_line_key, section_token, name, budgeted_cents, is_media_item, state)
     VALUES ($1,1,$2,'k1','kitchen','Unit 1 - Kitchen',60000,false,'live')`, [app, jid]);

  // ---- C. default-parked refusals, both doors ----
  {
    const st = await portalDraws.composerState(app);
    ok(st.funded && st.physical && st.set_up, 'C1 the file is funded, physical and set up — everything BUT the park says yes');
    ok(st.parked === true && st.parked_reason === parked.PARKED_REASON, 'C2 composerState reports parked + the one wording');
    ok(st.eligible === false, 'C3 …and eligible is false — the park alone refuses');
    let e1 = null;
    try { await portalDraws.createRequest(app, [{ sitewire_job_item_id: jid, requested_cents: 5000 }], { source: 'borrower', borrowerId: bor }); }
    catch (e) { e1 = e; }
    ok(e1 && e1.status === 409 && e1.message === parked.PARKED_REASON, 'C4 the BORROWER door refuses 409 with the one wording');
    let e2 = null;
    try { await portalDraws.createRequest(app, [{ sitewire_job_item_id: jid, requested_cents: 5000 }], { source: 'staff', staffId: lo }); }
    catch (e) { e2 = e; }
    ok(e2 && e2.status === 409 && e2.message === parked.PARKED_REASON, 'C5 the STAFF door refuses identically (no staff bypass)');
    const rows = (await db.query(`SELECT count(*)::int c FROM portal_draw_requests WHERE application_id=$1`, [app])).rows[0].c;
    ok(rows === 0, 'C6 nothing was created by the refusals');
  }

  // ---- C7–C9: the borrower's real HTTP doors ----
  const expressApp = require('../src/server.js');
  const server = expressApp.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const bTok = C.signJwt({ sub: bor, kind: 'borrower', tv: 0 });
    const el = await api(server, 'GET', `/api/borrower/draws/${app}/eligibility`, null, bTok);
    const comp = el.body && el.body.composer;
    ok(el.status === 200 && comp && comp.parked === true && comp.can_compose === false && Array.isArray(comp.lines) && comp.lines.length === 0,
      'C7 eligibility: composer parked, can_compose false, NO lines offered');
    ok((el.body.next_steps || []).some((s) => /construction portal/i.test(s)),
      'C8 the next step points the borrower at the construction portal');
    const r = await api(server, 'POST', `/api/borrower/draws/${app}/request`,
      { entries: [{ sitewire_job_item_id: jid, requested_cents: 5000 }] }, bTok);
    ok(r.status === 409 && /Sitewire construction portal/.test((r.body && r.body.error) || ''),
      'C9 the borrower HTTP door refuses 409 with the wording (not a silent dead end)');

    // ---- D. the un-park env restores composing (parked, not deleted) ----
    process.env.PORTAL_DRAW_COMPOSER_PARKED = '0';
    const st2 = await portalDraws.composerState(app);
    ok(st2.parked === false && st2.parked_reason === null && st2.eligible === true,
      'D1 un-parked: composerState eligible again, no parked flag (read at CALL time — no restart)');
    const row = await portalDraws.createRequest(app, [{ sitewire_job_item_id: jid, requested_cents: 5000 }],
      { source: 'borrower', borrowerId: bor });
    ok(row && row.id && row.status === 'submitted', 'D2 un-parked: the same request now creates normally');

    // ---- E. re-parked with a request IN FLIGHT: it keeps flowing ----
    delete process.env.PORTAL_DRAW_COMPOSER_PARKED;
    const st3 = await portalDraws.composerState(app);
    ok(st3.parked === true && st3.open_portal_request && st3.open_portal_request.id === row.id,
      'E1 parked again: the in-flight request is still visible on the state');
    const el2 = await api(server, 'GET', `/api/borrower/draws/${app}/eligibility`, null, bTok);
    const comp2 = el2.body && el2.body.composer;
    ok(comp2 && comp2.open_request && comp2.open_request.id === row.id,
      'E2 the borrower still sees their in-flight request while parked');
    ok(el2.status === 200 && (el2.body.next_steps || []).some((s) => /draw request is in/i.test(s)),
      'E3 while parked the borrower is told their request is IN — the in-flight narration still runs');
    const cancelled = await portalDraws.cancelRequest(app, row.id, { staffId: lo, reason: 'test cleanup' });
    ok(cancelled && cancelled.status === 'cancelled', 'E4 the desk lever (cancel) still works while parked — in-flight requests continue as normal');
  } finally {
    server.close();
  }

  // cleanup
  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]).catch(() => {});
  await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [lo]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [lo]).catch(() => {});
  await db.query(`DELETE FROM sitewire_inspection_rules WHERE partner_label=$1`, [LABEL]).catch(() => {});

  console.log(`\nportal-draws-parked: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

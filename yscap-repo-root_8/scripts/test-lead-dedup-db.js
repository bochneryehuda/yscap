/**
 * LEAD OVER-ASSIGNMENT GUARD (owner-reported 2026-08-11: "everyone who clicks
 * Generate Term Sheet gets a lead again and goes to someone — a few loan officers
 * get the same thing if he exports a few times").
 *
 * Two protections, proven here against a REAL server + Postgres:
 *   1) a repeat export from the SAME prospect (matched by email / session) STICKS
 *      to the officer they already have instead of round-robining onto a second
 *      one, and does NOT re-notify that officer;
 *   2) a near-simultaneous BURST of exports (the PDF + Excel + proof-of-funds each
 *      POST at once) all land on ONE officer — the per-prospect advisory lock
 *      closes the first-in-session race;
 * while genuinely DIFFERENT prospects still rotate to different officers.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

if (!process.env.DATABASE_URL) { console.log('SKIP test-lead-dedup-db (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const leadAssign = require('../src/lib/lead-assignment');

let failures = 0, n = 0;
const assert = (c, m, extra) => { n++; if (c) console.log('  ok -', m); else { failures++; console.log(`  FAIL - ${m}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); } };

function post(server, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({ method: 'POST', path: '/api/leads', port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); r.write(data); r.end();
  });
}

(async () => {
  // Pure key checks first (no DB).
  assert(leadAssign.assignmentKey({ email: 'A@B.com' }) === 'lead:e:a@b.com', 'assignmentKey prefers email (normalized)');
  assert(leadAssign.assignmentKey({ phone: '(555) 111-2222', sessionId: 's' }) === 'lead:p:5551112222', 'assignmentKey uses phone digits over session');
  assert(leadAssign.assignmentKey({ sessionId: 'sess1' }) === 'lead:s:sess1', 'assignmentKey falls back to session');
  assert(leadAssign.assignmentKey({ ip: '1.2.3.4', name: 'Acme LLC' }) === 'lead:i:1.2.3.4|acme llc', 'assignmentKey uses IP+name last');
  assert(leadAssign.assignmentKey({ ip: '1.2.3.4' }) === null, 'IP alone is NEVER a key (shared NAT)');

  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const ids = [];
  let restoreOthers = [];

  const mkLo = async (label, ord) => {
    const r = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version, site_selectable, sort_order)
       VALUES ($1,$2,'loan_officer',true,false,'x',0,true,$3) RETURNING id`,
      [`dd-${label}-${sfx}@test.local`, `DD ${label}`, ord]);
    ids.push(r.rows[0].id);
    return r.rows[0].id;
  };
  const officerOf = async (leadId) => (await db.query('SELECT officer_id, assigned_via FROM leads WHERE id=$1', [leadId])).rows[0];
  const notifCount = async (officerId) => (await db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE staff_id=$1 AND type='new_lead'`, [officerId])).rows[0].n;

  try {
    await mkLo('lo1', -5000); await mkLo('lo2', -4999); await mkLo('lo3', -4998);
    // Isolate the rotation pool to these 3 so assertions are deterministic.
    restoreOthers = (await db.query(
      `SELECT id FROM staff_users WHERE is_active AND role='loan_officer' AND site_selectable=true AND id <> ALL($1::uuid[])`,
      [ids])).rows.map((r) => r.id);
    if (restoreOthers.length) await db.query(`UPDATE staff_users SET site_selectable=false WHERE id = ANY($1::uuid[])`, [restoreOthers]);

    console.log('\n§1  a repeat export from the same prospect STICKS to one officer + does not re-notify');
    const E1 = `dd-p1-${sfx}@example.test`;
    const r1 = await post(server, { tool: 'term_sheet', email: E1, name: 'Prospect One', message: 'ts', subject: 'TS 1' });
    assert(r1.status === 201 && r1.body.leadId, 'first term-sheet export accepted');
    const a1 = await officerOf(r1.body.leadId);
    assert(a1.assigned_via === 'round_robin' && ids.includes(a1.officer_id), 'first export round-robins to an eligible officer', a1);
    const officer = a1.officer_id;
    const notifAfterFirst = await notifCount(officer);

    const r2 = await post(server, { tool: 'term_sheet', email: E1, name: 'Prospect One', message: 'ts again', subject: 'TS 1b' });
    const a2 = await officerOf(r2.body.leadId);
    assert(a2.officer_id === officer && a2.assigned_via === 'session',
      'the SECOND export sticks to the SAME officer (assigned_via=session, no new round-robin)', a2);
    assert((await notifCount(officer)) === notifAfterFirst,
      'the officer is NOT re-notified on the repeat export (no bombardment)');

    console.log('\n§2  a near-simultaneous BURST all lands on ONE officer (advisory lock closes the race)');
    const E2 = `dd-burst-${sfx}@example.test`;
    const burst = await Promise.all([0, 1, 2, 3].map((i) =>
      post(server, { tool: 'term_sheet', email: E2, name: 'Burst LLC', message: 'export', subject: `TS burst ${i}` })));
    const burstOfficers = new Set();
    for (const b of burst) { const a = await officerOf(b.body.leadId); burstOfficers.add(a.officer_id); }
    assert(burstOfficers.size === 1, 'all 4 simultaneous exports were assigned to exactly ONE officer', [...burstOfficers]);

    console.log('\n§3  a genuinely DIFFERENT prospect still rotates (dedup did not over-collapse)');
    const E3 = `dd-p3-${sfx}@example.test`;
    const r3 = await post(server, { tool: 'term_sheet', email: E3, name: 'Prospect Three', message: 'ts', subject: 'TS 3' });
    const a3 = await officerOf(r3.body.leadId);
    assert(a3.assigned_via === 'round_robin' && ids.includes(a3.officer_id),
      'a new prospect (different email) gets its own round-robin assignment', a3);

    console.log(`\n${failures ? 'FAILURES: ' + failures : 'All ' + n + ' lead-dedup checks passed.'}`);
  } catch (e) {
    console.error('FAIL (threw):', e && e.message, e && e.stack); failures++;
  } finally {
    if (restoreOthers.length) await db.query(`UPDATE staff_users SET site_selectable=true WHERE id = ANY($1::uuid[])`, [restoreOthers]).catch(() => {});
    await db.query(`DELETE FROM leads WHERE email LIKE $1 OR officer_id = ANY($2::uuid[])`, [`dd-%-${sfx}%`, ids]).catch(() => {});
    await db.query(`DELETE FROM notifications WHERE staff_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`dd-%-${sfx}@test.local`]).catch(() => {});
    server.close();
    await db.pool.end();
    process.exit(failures ? 1 : 0);
  }
})();

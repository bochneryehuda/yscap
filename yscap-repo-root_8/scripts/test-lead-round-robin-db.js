/**
 * Lead-assignment queue — ROUND-ROBIN (#29, owner-directed message-3).
 *
 * An inbound lead with no ?lo= branded officer is assigned to the next loan officer in fair rotation
 * (src/lib/lead-assignment.js), wired into the public lead door (src/routes/leads.js). This proves:
 *   - the rotation is FAIR (each eligible officer gets one before any gets two) and never picks an
 *     ineligible officer (inactive / not a loan_officer / not site-selectable);
 *   - the REAL route assigns an un-attributed lead + stores assigned_via='round_robin' (this is the
 *     phantom-column + wiring guard — a pure test could never catch the new INSERT column);
 *   - a ?lo= lead keeps its officer and is stamped 'lo_link';
 *   - an empty pool falls back cleanly (officer NULL, assigned_via NULL) so a lead is never lost;
 *   - the off-switch works.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise. Boots the real server on an
 * ephemeral port like scripts/test-lead-convert-db.js.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

if (!process.env.DATABASE_URL) { console.log('SKIP test-lead-round-robin-db (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const leadAssign = require('../src/lib/lead-assignment');

let failures = 0, n = 0;
const assert = (c, m, extra) => { n++; if (c) { console.log('  ok -', m); } else { failures++; console.log(`  FAIL - ${m}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); } };

function post(server, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({ method: 'POST', path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); r.write(data); r.end();
  });
}

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mine = [];   // my test loan officers (eligible)
  let ineligible = null;
  let restoreOthers = [];

  const mkLo = async (label, ord, opts = {}) => {
    const email = `rr-${label}-${sfx}@test.local`;
    const r = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version, site_selectable, sort_order)
       VALUES ($1, $2, $3, $4, false, 'x', 0, $5, $6) RETURNING id`,
      [email, `RR ${label}`, opts.role || 'loan_officer', opts.active !== false, opts.selectable !== false, ord]);
    return { id: r.rows[0].id, email, code: email.split('@')[0] };
  };

  try {
    // ── fixtures ──
    mine.push(await mkLo('lo1', -3000));
    mine.push(await mkLo('lo2', -2999));
    mine.push(await mkLo('lo3', -2998));
    ineligible = await mkLo('inel', -2997, { selectable: false });        // not site-selectable → never eligible
    const inactive = await mkLo('gone', -2996, { active: false });         // inactive → never eligible
    const coord = await mkLo('coord', -2995, { role: 'loan_coordinator' }); // not a loan_officer → never eligible
    const neverPick = new Set([ineligible.id, inactive.id, coord.id]);

    /* ── 1) rotation is fair + eligibility filters — ISOLATED so the assertion is deterministic
       regardless of any seeded/real staff. Unflag every OTHER eligible officer for the duration,
       restored in the finally below. ── */
    restoreOthers = (await db.query(
      `SELECT id FROM staff_users WHERE is_active AND role='loan_officer' AND site_selectable=true
         AND id <> ALL($1::uuid[])`, [mine.map((m) => m.id)])).rows.map((r) => r.id);
    if (restoreOthers.length) await db.query(`UPDATE staff_users SET site_selectable=false WHERE id = ANY($1::uuid[])`, [restoreOthers]);

    const counts = {};
    for (let i = 0; i < 6; i++) {
      const lo = await leadAssign.pickRoundRobinOfficer();
      assert(lo && mine.some((m) => m.id === lo.id), `pick ${i + 1} returns one of my eligible officers`, lo && lo.id);
      assert(!lo || !neverPick.has(lo.id), `pick ${i + 1} is never an ineligible officer`);
      if (lo) {
        counts[lo.id] = (counts[lo.id] || 0) + 1;
        // record the assignment exactly as the route does, so the NEXT pick rotates off this officer
        await db.query(`INSERT INTO leads (tool, email, officer_id, assigned_via) VALUES ('contact', $1, $2, 'round_robin')`,
          [`rr-seq-${i}-${sfx}@test.local`, lo.id]);
      }
    }
    assert(mine.every((m) => counts[m.id] === 2), 'over 6 picks each of the 3 officers is chosen exactly twice (fair rotation)', counts);

    // restore the others now — the route tests below want a real, non-empty pool
    if (restoreOthers.length) await db.query(`UPDATE staff_users SET site_selectable=true WHERE id = ANY($1::uuid[])`, [restoreOthers]);
    restoreOthers = [];

    /* ── 2) the REAL route assigns an un-attributed lead + stamps 'round_robin' ── */
    const rEmail = `rr-route-${sfx}@example.test`;
    const res1 = await post(server, '/api/leads', { tool: 'contact', email: rEmail, message: 'hi' });
    assert(res1.status === 201 && res1.body && res1.body.leadId, 'un-attributed lead accepted (201)', res1.status);
    const lead1 = (await db.query(`SELECT officer_id, assigned_via FROM leads WHERE id=$1`, [res1.body.leadId])).rows[0];
    assert(lead1 && lead1.officer_id && lead1.assigned_via === 'round_robin',
      'the route assigned an owner and stamped assigned_via=round_robin', lead1);
    const eligibleNow = (await db.query(
      `SELECT id FROM staff_users WHERE is_active AND role='loan_officer' AND site_selectable=true`)).rows.map((r) => r.id);
    assert(lead1 && eligibleNow.includes(lead1.officer_id), 'the assigned owner is a currently-eligible loan officer');

    /* ── 3) a ?lo= branded lead keeps ITS officer and is stamped 'lo_link' ── */
    const res2 = await post(server, '/api/leads', { tool: 'contact', email: `rr-lo-${sfx}@example.test`, officerCode: mine[0].code, message: 'branded' });
    assert(res2.status === 201, 'branded lead accepted', res2.status);
    const lead2 = (await db.query(`SELECT officer_id, assigned_via FROM leads WHERE id=$1`, [res2.body.leadId])).rows[0];
    assert(lead2 && lead2.officer_id === mine[0].id && lead2.assigned_via === 'lo_link',
      'a ?lo= lead keeps its branded officer and is stamped lo_link', lead2);

    /* ── 4) empty pool → clean fallback (no owner, no stamp) — a lead is never lost ── */
    const allElig = (await db.query(
      `SELECT id FROM staff_users WHERE is_active AND role='loan_officer' AND site_selectable=true`)).rows.map((r) => r.id);
    await db.query(`UPDATE staff_users SET site_selectable=false WHERE id = ANY($1::uuid[])`, [allElig]);
    try {
      assert((await leadAssign.pickRoundRobinOfficer()) === null, 'empty pool → pickRoundRobinOfficer returns null');
      const res3 = await post(server, '/api/leads', { tool: 'contact', email: `rr-empty-${sfx}@example.test`, message: 'no pool' });
      assert(res3.status === 201, 'lead still accepted with an empty pool', res3.status);
      const lead3 = (await db.query(`SELECT officer_id, assigned_via FROM leads WHERE id=$1`, [res3.body.leadId])).rows[0];
      assert(lead3 && lead3.officer_id === null && lead3.assigned_via === null,
        'empty pool → lead stored with no owner and no round_robin stamp (falls back)', lead3);
    } finally {
      await db.query(`UPDATE staff_users SET site_selectable=true WHERE id = ANY($1::uuid[])`, [allElig]).catch(() => {});
    }

    /* ── 5) the off-switch ── */
    process.env.LEADS_ROUND_ROBIN_DISABLED = '1';
    assert((await leadAssign.pickRoundRobinOfficer()) === null, 'LEADS_ROUND_ROBIN_DISABLED=1 → no assignment');
    delete process.env.LEADS_ROUND_ROBIN_DISABLED;

    console.log(`\n${failures ? 'FAILURES: ' + failures : 'All ' + n + ' lead round-robin checks passed.'}`);
  } catch (e) {
    console.error('FAIL (threw):', e && e.message, e && e.stack);
    failures++;
  } finally {
    if (restoreOthers.length) await db.query(`UPDATE staff_users SET site_selectable=true WHERE id = ANY($1::uuid[])`, [restoreOthers]).catch(() => {});
    const ids = [...mine.map((m) => m.id), ineligible && ineligible.id].filter(Boolean);
    await db.query(`DELETE FROM leads WHERE email LIKE $1 OR officer_id = ANY($2::uuid[])`, [`rr-%-${sfx}%`, ids]).catch(() => {});
    await db.query(`DELETE FROM notifications WHERE staff_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`rr-%-${sfx}@test.local`]).catch(() => {});
    server.close();
    await db.pool.end();
    process.exit(failures ? 1 : 0);
  }
})();

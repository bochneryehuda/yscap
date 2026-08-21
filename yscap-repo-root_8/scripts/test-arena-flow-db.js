/**
 * THE ARENA, end to end -- real Postgres, real HTTP, the whole Elementix Day.
 *
 * This drives the owner's own sequence through the real API, in order:
 *   the switch is OFF and the whole feature is invisible and unreachable
 *   -> a super admin turns it on -> a session ("Elementix Day") goes live with
 *   a picked roster -> spin one is created, and every wheel commits its seed
 *   BEFORE anybody can enter anything -> people check in, one of them too late
 *   -> the late one is refused at the door -> people say what they want to win,
 *   over the cap is refused -> the super admin approves -> the door is locked
 *   and the list frozen and published -> wheel one picks the person, wheel two
 *   picks the prize -> the award is recorded -> anybody can verify the draw
 *   -> a tampered record fails verification -> the switch goes off again and
 *   everything disappears, then comes back exactly as it was.
 *
 * WHAT MAKES THIS WORTH ANYTHING. Each assertion below was proven to FAIL by
 * breaking the production rule on purpose and watching this suite go red --
 * the specific mutations are listed in docs/ARENA-GAME-ENGINE-RESEARCH.md.
 * A test nobody has seen fail is decoration.
 *
 * Needs a real Postgres; self-skips without DATABASE_URL like every other
 * *-db suite here. It creates its own rows under a unique suffix and deletes
 * them in a finally, and it restores the master switch to whatever it found.
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
    };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = b ? JSON.parse(b) : null; } catch (_) { parsed = { raw: b }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP Arena flow DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const arenaSettings = require(R + '/src/lib/arena/settings');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `arena-${t}-${sfx}@test.local`;
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });

  let sessionId = null;
  const madeStaff = [];
  let switchWas = null;

  try {
    switchWas = (await db.query(`SELECT enabled FROM arena_settings WHERE id = true`)).rows[0];
    ok(!!switchWas, 'the settings row exists (db/585 has run)');

    const mk = async (name, role) => {
      const r = await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active, token_version)
         VALUES ($1,$2,$3,true,0) RETURNING id`, [mail(name), name, role]);
      madeStaff.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const bossId = await mk('Boss', 'super_admin');
    const aliceId = await mk('Alice', 'loan_officer');
    const bobId = await mk('Bob', 'loan_officer');
    const lateId = await mk('Late Larry', 'loan_officer');
    const plainAdminId = await mk('Plain Admin', 'admin');
    const boss = tok(bossId, 'super_admin');
    const alice = tok(aliceId, 'loan_officer');
    const bob = tok(bobId, 'loan_officer');
    const larry = tok(lateId, 'loan_officer');
    const plainAdmin = tok(plainAdminId, 'admin');

    // ---- A. OFF MEANS GONE ------------------------------------------------
    await db.query(`UPDATE arena_settings SET enabled = false WHERE id = true`);
    arenaSettings.invalidate();

    const offBoard = await call(server, 'GET', '/api/arena/board', alice);
    eq(offBoard.status, 404, 'with the switch off a loan officer gets 404, not 403 (the feature must look absent)');
    const offCatalog = await call(server, 'GET', '/api/arena/catalog', boss);
    eq(offCatalog.status, 404, 'with the switch off even a super admin cannot reach the game itself');
    const offVis = await call(server, 'GET', '/api/arena/visibility', alice);
    eq(offVis.status, 200, 'the visibility probe still answers when the game is off');
    eq(offVis.body.seesArena, false, 'and it tells a loan officer they see nothing');
    eq(offVis.body.seesSwitch, false, 'and that they cannot see the switch either');
    const offVisBoss = await call(server, 'GET', '/api/arena/visibility', boss);
    eq(offVisBoss.body.seesSwitch, true, 'a super admin CAN still see the switch, or it could never be turned back on');
    const offSettingsLo = await call(server, 'GET', '/api/arena/settings', alice);
    eq(offSettingsLo.status, 404, 'a loan officer cannot reach the switch');
    const offSettingsAdmin = await call(server, 'GET', '/api/arena/settings', plainAdmin);
    eq(offSettingsAdmin.status, 404, 'and neither can a plain admin - super admin only');

    // ---- B. TURN IT ON ----------------------------------------------------
    const on = await call(server, 'PUT', '/api/arena/settings', boss, { enabled: true });
    eq(on.status, 200, 'a super admin turns the Arena on');
    eq(on.body.enabled, true, 'and it reports on');
    arenaSettings.invalidate();
    eq((await call(server, 'GET', '/api/arena/board', alice)).status, 200, 'now a loan officer can see the board');

    const cat = await call(server, 'GET', '/api/arena/catalog', alice);
    ok(cat.body.games.length >= 40, `the game catalog is real (${cat.body.games.length} games)`);
    ok(cat.body.games.some((g) => g.key === 'elementix_double'), 'including the Elementix double spin');
    const claimGame = cat.body.games.find((g) => (g.needs || []).includes('claims'));
    ok(claimGame && /does not record call logs/.test(claimGame.dataNote || ''),
      'a game that needs a call log SAYS so instead of implying it has one');

    // ---- C. THE SESSION ---------------------------------------------------
    const made = await call(server, 'POST', '/api/arena/sessions', boss, {
      name: `Elementix Day ${sfx}`, subtitle: 'Dial day', staffIds: [aliceId, bobId, lateId],
    });
    eq(made.status, 201, 'the super admin creates the session');
    sessionId = made.body.session.id;
    const notMine = await call(server, 'POST', '/api/arena/sessions', alice, { name: 'nope' });
    eq(notMine.status, 403, 'a loan officer cannot create a session');

    eq((await call(server, 'POST', `/api/arena/sessions/${sessionId}/state`, boss, { state: 'live' })).status, 200,
      'the session goes live');

    // The people picker carries every colleague's EMAIL, so it is super-admin
    // only (2026-08-19 audit); an ordinary officer reads the room through
    // /room, which carries names and no addresses.
    eq((await call(server, 'GET', `/api/arena/sessions/${sessionId}/people`, alice)).status, 403,
      'an ordinary officer cannot read the email-bearing people picker');
    const people = await call(server, 'GET', `/api/arena/sessions/${sessionId}/people`, boss);
    eq(people.body.limitedToPicked, true, 'the session is limited to the picked roster');
    eq(people.body.people.length, 3, 'and the roster is the three people who were picked');

    // ---- D. SPIN ONE, AND THE COMMITMENT ----------------------------------
    const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const spinRes = await call(server, 'POST', `/api/arena/sessions/${sessionId}/spins`, boss, {
      title: 'Spin one', kind: 'elementix_double', entryDeadlineAt: deadline,
      config: { durationMs: 1500, autoApproveCheckins: false },
    });
    eq(spinRes.status, 201, 'spin one is created');
    const spinId = spinRes.body.spin.id;
    eq(spinRes.body.spin.seq, 1, 'and it is numbered spin one');

    const committed = await db.query(`SELECT seq, commit_hash, server_seed, roster FROM arena_draws WHERE spin_id = $1 ORDER BY seq`, [spinId]);
    eq(committed.rows.length, 2, 'both wheels exist the moment the spin is created');
    ok(committed.rows.every((d) => d.commit_hash && d.commit_hash.length === 64),
      'every wheel published a seed fingerprint at creation - BEFORE anybody could enter anything');
    ok(committed.rows.every((d) => d.roster === null),
      'and NO wheel has a candidate list yet, so no seed could have been chosen to suit one');

    eq((await call(server, 'POST', `/api/arena/spins/${spinId}/open`, boss)).status, 200, 'the spin opens');

    // ---- E. CHECK-IN, AND THE CUTOFF --------------------------------------
    eq((await call(server, 'POST', `/api/arena/spins/${spinId}/checkin`, alice)).status, 201, 'Alice checks in');
    eq((await call(server, 'POST', `/api/arena/spins/${spinId}/checkin`, bob)).status, 201, 'Bob checks in');
    const twice = await call(server, 'POST', `/api/arena/spins/${spinId}/checkin`, alice);
    eq(twice.status, 400, 'checking in twice is refused');
    eq(twice.body.code, 'already', 'and it says why');

    // Move the cutoff into the past: Larry is now late.
    await db.query(`UPDATE arena_spins SET entry_deadline_at = now() - interval '3 minutes' WHERE id = $1`, [spinId]);
    const late = await call(server, 'POST', `/api/arena/spins/${spinId}/checkin`, larry);
    eq(late.status, 400, 'a late check-in is REFUSED at the door, not silently dropped from the wheel later');
    eq(late.body.code, 'too_late', 'and the person is told they missed it');
    ok(/missed it by/.test(late.body.error || ''), 'and by how much');
    await db.query(`UPDATE arena_spins SET entry_deadline_at = $2 WHERE id = $1`, [spinId, deadline]);

    // ---- F. ENTRIES AND THE CAPS ------------------------------------------
    const overCap = await call(server, 'POST', `/api/arena/spins/${spinId}/entries`, alice,
      { kind: 'personal', label: 'A very nice watch', value: '750' });
    eq(overCap.status, 400, '$750 personal is over the $500 cap and is refused');
    eq(overCap.body.code, 'over_cap', 'and it says it is over the cap');

    const businessOk = await call(server, 'POST', `/api/arena/spins/${spinId}/entries`, alice,
      { kind: 'business', label: 'Marketing budget', value: '750' });
    eq(businessOk.status, 201, 'the same $750 as a BUSINESS entry is fine - the caps really are per kind');
    eq(businessOk.body.entry.status, 'pending', 'and it waits for the super admin, as the owner asked');
    eq(businessOk.body.entry.value_cents, 75000, 'money is stored in whole cents');

    const overBusiness = await call(server, 'POST', `/api/arena/spins/${spinId}/entries`, bob,
      { kind: 'business', label: 'Too much', value: '1200' });
    eq(overBusiness.status, 400, '$1,200 business is over the $1,000 cap');

    const bobEntry = await call(server, 'POST', `/api/arena/spins/${spinId}/entries`, bob,
      { kind: 'personal', label: 'Leave early Friday', value: '0' });
    eq(bobEntry.status, 201, 'Bob asks for something worth nothing at all, which is allowed');

    const notCheckedIn = await call(server, 'POST', `/api/arena/spins/${spinId}/entries`, larry,
      { kind: 'personal', label: 'Sneaking in', value: '10' });
    eq(notCheckedIn.status, 400, 'somebody who never checked in cannot put a prize forward');
    eq(notCheckedIn.body.code, 'not_checked_in', 'and is told to check in first');

    // ---- G. APPROVALS ------------------------------------------------------
    const notSuper = await call(server, 'POST', `/api/arena/entries/${businessOk.body.entry.id}/decide`, alice, { status: 'approved' });
    eq(notSuper.status, 403, 'a loan officer cannot approve their own entry');

    for (const e of [businessOk.body.entry.id, bobEntry.body.entry.id]) {
      eq((await call(server, 'POST', `/api/arena/entries/${e}/decide`, boss, { status: 'approved' })).status, 200,
        'the super admin approves an entry');
    }
    const cin = (await db.query(`SELECT id FROM arena_checkins WHERE spin_id = $1`, [spinId])).rows;
    for (const c of cin) {
      eq((await call(server, 'POST', `/api/arena/checkins/${c.id}/decide`, boss, { status: 'approved' })).status, 200,
        'the super admin approves a check-in');
    }

    // ---- H. LOCK AND FREEZE ------------------------------------------------
    eq((await call(server, 'POST', `/api/arena/spins/${spinId}/lock`, boss)).status, 200, 'the door is locked');
    const frozen = (await db.query(`SELECT seq, roster, roster_hash FROM arena_draws WHERE spin_id = $1 ORDER BY seq`, [spinId])).rows;
    eq(frozen[0].roster.length, 2, 'wheel one froze exactly the two approved check-ins');
    ok(frozen[0].roster_hash && frozen[0].roster_hash.length === 64, 'and published the fingerprint of that list');
    ok(frozen[1].roster === null, 'wheel two is NOT frozen yet - its list depends on nothing, but it is frozen in its own turn');

    // The frozen list is public; the SECRET is not.
    const boardLocked = await call(server, 'GET', `/api/arena/board?session=${sessionId}`, alice);
    const spinOnBoard = boardLocked.body.spins.find((s) => s.id === spinId);
    ok(spinOnBoard.draws[0].roster.length === 2, 'everybody can see who is on the wheel before it turns');
    eq(spinOnBoard.draws[0].server_seed, null, 'but NOBODY can see the secret seed before the wheel lands');
    ok(spinOnBoard.draws[0].commit_hash, 'while the fingerprint of it is right there to check against later');

    // ---- I. SPIN -----------------------------------------------------------
    const notYours = await call(server, 'POST', `/api/arena/spins/${spinId}/spin`, alice, { seq: 1 });
    eq(notYours.status, 403, 'only a super admin turns the wheel');

    const w1 = await call(server, 'POST', `/api/arena/spins/${spinId}/spin`, boss, { seq: 1, clientSeed: 'room-said-42' });
    eq(w1.status, 200, 'wheel one turns');
    ok(w1.body.targetRotationDeg > 360, 'the server sent a stop angle with whole turns in it');
    ok(w1.body.winner === undefined && w1.body.winnerLabel === undefined,
      'and the admin who pressed the button is NOT told the winner - they watch the same wheel as everyone');

    await wait(2200);   // the wheel is 1500ms; the reveal timer fires just after
    const afterW1 = (await db.query(`SELECT * FROM arena_draws WHERE spin_id = $1 AND seq = 1`, [spinId])).rows[0];
    eq(afterW1.state, 'revealed', 'the wheel reveals itself when the animation ends');
    ok(afterW1.winner_staff_id, 'and a real person won');
    ok([String(aliceId), String(bobId)].includes(String(afterW1.winner_staff_id)),
      'and the winner is one of the two people who actually checked in');

    const w2 = await call(server, 'POST', `/api/arena/spins/${spinId}/spin`, boss, { seq: 2, clientSeed: 'room-said-7' });
    eq(w2.status, 200, 'wheel two turns for the prize');
    await wait(2200);
    const afterW2 = (await db.query(`SELECT * FROM arena_draws WHERE spin_id = $1 AND seq = 2`, [spinId])).rows[0];
    eq(afterW2.state, 'revealed', 'wheel two reveals');
    // THE PRIZE WHEEL LANDS ON SOMETHING THAT WAS ON IT. The pool is the two
    // approved entries PLUS whatever booby prizes were frozen onto the wheel
    // before it was hashed (see `src/lib/arena/joke-prizes.js`), so the honest
    // test is against the frozen roster itself rather than a hand-typed list —
    // a joke IS a legitimate outcome of a prize wheel, and pinning only the two
    // real entries would fail on a wheel that is behaving exactly as designed.
    const w2Roster = (afterW2.roster || []).map((c) => c.label);
    ok(w2Roster.includes(afterW2.winner_label),
      `the prize is one of the slices frozen on wheel two (got "${afterW2.winner_label}")`);
    const w2Won = (afterW2.roster || [])[afterW2.winner_index] || {};
    const w2Joke = !!(w2Won.meta && w2Won.meta.joke === true);
    if (!w2Joke) {
      ok(['Marketing budget', 'Leave early Friday'].includes(afterW2.winner_label),
        `a real prize is one of the two approved entries (got "${afterW2.winner_label}")`);
    }

    // ---- J. THE RECORD -----------------------------------------------------
    const decided = (await db.query(`SELECT state, outcome_note FROM arena_spins WHERE id = $1`, [spinId])).rows[0];
    eq(decided.state, 'decided', 'the spin is decided once every wheel has landed');
    ok(/Who wins/.test(decided.outcome_note || ''), 'and it records WHY, in words, not just an id');

    const awards = await call(server, 'GET', `/api/arena/sessions/${sessionId}/awards`, alice);
    eq(awards.body.awards.length, 1, 'exactly one award was written');
    eq(String(awards.body.awards[0].staff_id), String(afterW1.winner_staff_id), 'to the person wheel one picked');
    eq(awards.body.awards[0].prize_label, afterW2.winner_label, 'of the prize wheel two picked');
    // A BOOBY PRIZE IS RECORDED AS ONE, AND IT IS WORTH NOTHING. If a joke ever
    // settled as an ordinary prize it would reach the payroll export as taxable
    // wages, so the kind and the zero are asserted the moment one lands.
    if (w2Joke) {
      eq(awards.body.awards[0].prize_kind, 'joke', 'a booby prize is recorded as a joke, not as a prize');
      eq(Number(awards.body.awards[0].value_cents), 0, 'and it is worth nothing on the payroll export');
    }

    const csv = await call(server, 'GET', `/api/arena/sessions/${sessionId}/awards.csv`, boss);
    eq(csv.status, 200, 'the payroll export works (prizes at these values are taxable wages)');
    ok(/Value \(USD\)/.test(String(csv.body && csv.body.raw)), 'and carries the money column payroll needs');

    // ---- K. ANYBODY CAN CHECK IT ------------------------------------------
    const v = await call(server, 'GET', `/api/arena/draws/${afterW1.id}/verify`, alice);
    eq(v.status, 200, 'an ordinary loan officer can ask for the proof');
    eq(v.body.ok, true, 'and the draw checks out');
    eq(v.body.commitmentOk, true, 'the revealed seed matches the fingerprint published beforehand');
    eq(v.body.rosterOk, true, 'the frozen list is unchanged');
    eq(v.body.winnerOk, true, 'and working it out again lands on the same person');
    ok(v.body.serverSeed, 'the secret is now disclosed so it can be recomputed by hand');

    // ---- L. TAMPERING IS CAUGHT -------------------------------------------
    const realRoster = afterW1.roster;
    const tampered = JSON.parse(JSON.stringify(realRoster));
    tampered[0].weight = 999;                     // stack the odds after the fact
    await db.query(`UPDATE arena_draws SET roster = $2::jsonb WHERE id = $1`, [afterW1.id, JSON.stringify(tampered)]);
    const vBad = await call(server, 'GET', `/api/arena/draws/${afterW1.id}/verify`, alice);
    eq(vBad.body.ok, false, 'editing the frozen list after the draw FAILS verification');
    eq(vBad.body.rosterOk, false, 'and it is the list check that catches it');
    await db.query(`UPDATE arena_draws SET roster = $2::jsonb WHERE id = $1`, [afterW1.id, JSON.stringify(realRoster)]);

    const realSeed = afterW1.server_seed;
    await db.query(`UPDATE arena_draws SET server_seed = $2 WHERE id = $1`, [afterW1.id, 'a'.repeat(64)]);
    const vSeed = await call(server, 'GET', `/api/arena/draws/${afterW1.id}/verify`, alice);
    eq(vSeed.body.ok, false, 'swapping the secret seed for another FAILS verification');
    eq(vSeed.body.commitmentOk, false, 'and it is the fingerprint that catches it');
    await db.query(`UPDATE arena_draws SET server_seed = $2 WHERE id = $1`, [afterW1.id, realSeed]);

    // ---- M. TURN IT OFF AGAIN ---------------------------------------------
    eq((await call(server, 'PUT', '/api/arena/settings', boss, { enabled: false })).status, 200, 'the super admin turns it off');
    arenaSettings.invalidate();
    eq((await call(server, 'GET', '/api/arena/board', alice)).status, 404, 'and the whole thing vanishes again');
    const stillThere = (await db.query(`SELECT count(*)::int AS n FROM arena_awards WHERE session_id = $1`, [sessionId])).rows[0].n;
    eq(stillThere, 1, 'while every record is still exactly where it was');
    eq((await call(server, 'PUT', '/api/arena/settings', boss, { enabled: true })).status, 200, 'and it turns back on');
    arenaSettings.invalidate();
    const back = await call(server, 'GET', `/api/arena/board?session=${sessionId}`, alice);
    eq(back.status, 200, 'the board comes back');
    eq(back.body.awards.length, 1, 'with the same award still on it');

    // ---- N. AUDIT ----------------------------------------------------------
    const trail = await db.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 OR detail->>'by' = $2 ORDER BY id`, [spinId, String(bossId)]);
    const actions = trail.rows.map((r) => r.action);
    ok(actions.includes('arena_wheel_spun'), 'turning the wheel is in the audit log');
    ok(actions.includes('arena_spin_created'), 'and so is creating the spin');
  } catch (e) {
    fail++;
    console.log('  FAIL: threw -', e && e.stack ? e.stack : e);
  } finally {
    try {
      if (sessionId) await db.query(`DELETE FROM arena_sessions WHERE id = $1`, [sessionId]);
      if (madeStaff.length) {
        await db.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [madeStaff]);
        await db.query(`DELETE FROM notifications WHERE staff_id = ANY($1::uuid[])`, [madeStaff]);
        await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [madeStaff]);
      }
      if (switchWas) await db.query(`UPDATE arena_settings SET enabled = $1 WHERE id = true`, [switchWas.enabled]);
      require(R + '/src/lib/arena/sweep').stop();
    } catch (e) { console.log('  (cleanup warning:', e.message, ')'); }
    server.close();
  }

  console.log(`arena flow (db): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

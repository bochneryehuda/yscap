/**
 * THE ARENA, PART THREE, end to end — real Postgres, real HTTP.
 *
 * What this drives, in the order a day does it:
 *   a person does three challenges and the STREAK pays a bonus chance -> the
 *   super admin declines one of the three afterwards and the bonus GOES BACK,
 *   including the ones a later run depended on -> the ROOM BAR says who is
 *   checked in and who is actually here, and keeps the two apart -> the last
 *   two are put HEAD TO HEAD on one wheel with the challenger on the stop
 *   button -> everybody's RECAP CARD adds up their own day, and nobody can read
 *   anybody else's.
 *
 * PROVEN TO FAIL — each applied on its own, with a clean green run either side,
 * and the assertion it broke is named:
 *   - make the streak sync an INCREMENT instead of a recomputation
 *                            -> RED at "declining one of the three takes the bonus back"
 *   - drop the streak sync from decide()
 *                            -> RED at "three in a row pays a bonus chance"
 *   - count somebody as "here" because they checked in
 *                            -> RED at "checked in is not the same as here now"
 *   - give the rematch's stop button to the first name
 *                            -> RED at "the challenger holds the stop button"
 *   - let the recap answer for the staff id in the query string
 *                            -> RED at "a player cannot read somebody else's day"
 *   - drop the played test from the recap's position
 *                            -> RED at "somebody who never played is not last — they were not playing"
 *
 * Self-skips without DATABASE_URL. Cleans up after itself.
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

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP Arena phase 3 DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const arenaSettings = require(R + '/src/lib/arena/settings');
  const challenges = require(R + '/src/lib/arena/challenges');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
  const made = [];
  let sessionId = null;
  let switchWas = null;

  const tickets = async (staffId) => Number((await db.query(
    `SELECT COALESCE(sum(count), 0)::int AS n FROM arena_tickets WHERE session_id = $1 AND staff_id = $2`,
    [sessionId, staffId])).rows[0].n);
  const bonusRows = async (staffId) => (await db.query(
    `SELECT count, reason FROM arena_tickets
      WHERE session_id = $1 AND staff_id = $2 AND source = 'bonus' ORDER BY id`, [sessionId, staffId])).rows;

  try {
    switchWas = (await db.query(`SELECT enabled FROM arena_settings WHERE id = true`)).rows[0];
    const mk = async (name, role) => {
      const r = await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active, token_version)
         VALUES ($1,$2,$3,true,0) RETURNING id`, [`p3-${name}-${sfx}@t.local`, name, role]);
      made.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const bossId = await mk('Boss', 'super_admin');
    const players = [];
    for (const n of ['Ada', 'Bo', 'Cy', 'Di']) players.push({ name: n, id: await mk(n, 'loan_officer') });
    const boss = tok(bossId, 'super_admin');
    for (const p of players) p.tok = tok(p.id, 'loan_officer');
    const ada = players[0];

    await db.query(`UPDATE arena_settings SET enabled = true WHERE id = true`);
    arenaSettings.invalidate();

    const s = await call(server, 'POST', '/api/arena/sessions', boss,
      { name: `Phase3 ${sfx}`, staffIds: players.map((p) => p.id) });
    sessionId = s.body.session.id;
    await call(server, 'POST', `/api/arena/sessions/${sessionId}/state`, boss, { state: 'live' });

    // A spin to hang the challenges and the check-ins off.
    const spin = await call(server, 'POST', `/api/arena/sessions/${sessionId}/spins`, boss,
      { title: 'The day', kind: 'checkin_raffle' });
    const spinId = spin.body.spin.id;
    await call(server, 'POST', `/api/arena/spins/${spinId}/open`, boss, {});

    // ---- A. THE STREAK PAYS ------------------------------------------------
    // Four challenges, all open, all worth one chance, everybody welcome.
    const chIds = [];
    for (let i = 1; i <= 4; i++) {
      const r = await db.query(
        `INSERT INTO arena_challenges (session_id, spin_id, seq, title, prompt, tier, proof_type,
                                       award_mode, slots, tickets_awarded, state, opens_at, closes_at)
         VALUES ($1,$2,$3,$4,'Do the thing.',1,'text','everyone',20,1,'live',
                 now() - interval '1 minute', now() + interval '2 hours') RETURNING id`,
        [sessionId, spinId, i, `Challenge ${i}`]);
      chIds.push(r.rows[0].id);
    }

    const sendIn = async (who, chId, note) =>
      call(server, 'POST', `/api/arena/challenges/${chId}/fulfil`, who.tok, { note });
    const entryOf = async (chId, staffId) => (await db.query(
      `SELECT id FROM arena_challenge_entries WHERE challenge_id = $1 AND staff_id = $2`,
      [chId, staffId])).rows[0].id;
    const decide = async (entryId, status, reason) =>
      call(server, 'POST', `/api/arena/challenge-entries/${entryId}/decide`, boss, { status, reason });

    for (let i = 0; i < 3; i++) eq((await sendIn(ada, chIds[i], `Ada did ${i + 1}`)).status, 201, `Ada sends in ${i + 1}`);
    const e0 = await entryOf(chIds[0], ada.id);
    const e1 = await entryOf(chIds[1], ada.id);
    const e2 = await entryOf(chIds[2], ada.id);

    await decide(e0, 'approved');
    eq(await tickets(ada.id), 1, 'one approved challenge pays its own chance');
    eq((await bonusRows(ada.id)).length, 0, 'and nothing extra — one is not a streak');
    await decide(e1, 'approved');
    eq(await tickets(ada.id), 2, 'two are two');
    eq((await bonusRows(ada.id)).length, 0, 'still no bonus at two');

    const third = await decide(e2, 'approved');
    eq(await tickets(ada.id), 4, 'three in a row pays a bonus chance — three of their own plus one');
    const bonus = await bonusRows(ada.id);
    eq(bonus.length, 1, 'written as ONE line on the ledger');
    eq(Number(bonus[0].count), 1, 'worth one chance');
    ok(/in a row/.test(bonus[0].reason || ''), 'that says in plain words what it was for');
    ok(third.body.streak && third.body.streak.delta === 1, 'and the decision itself reports the bonus it paid');

    // Approving a FOURTH must not pay again — that is the difference between a
    // streak and a bonus on every submission after the third.
    await sendIn(ada, chIds[3], 'Ada did 4');
    const e3 = await entryOf(chIds[3], ada.id);
    await decide(e3, 'approved');
    eq(await tickets(ada.id), 5, 'a fourth pays only its own chance');
    eq((await bonusRows(ada.id)).length, 1, 'the bonus does not repeat on every one after three');

    // ---- B. AND IT GOES BACK -----------------------------------------------
    // The whole reason the ledger is recomputed rather than incremented.
    const back = await decide(e1, 'rejected', 'Looked again — that was not it');
    eq(await tickets(ada.id), 3,
      'declining one of the three takes the bonus back AND that challenge’s own chance');
    const after = await bonusRows(ada.id);
    eq(after.length, 2, 'as a second line, never by editing the first — the ledger keeps its history');
    // Read through a blank on purpose: a suite that CRASHES here still goes red,
    // but it names a missing array element instead of the rule that was broken,
    // and a crash that looks like proof is the trap this repo has already been
    // caught by once.
    const takeBack = after[1] || { count: 0, reason: '' };
    eq(Number(takeBack.count), -1, 'the take-back is a negative row');
    ok(/taken back|broken/.test(takeBack.reason || ''), 'and says so');
    ok(back.body.streak && back.body.streak.delta === -1, 'and the decision reports it');

    // DECLINING THE SAME ONE TWICE MUST NOT TAKE IT BACK TWICE. A second press
    // of the same button — a double click, a refreshed page, two admins on the
    // same list — is the ordinary way this happens, and the old add-and-subtract
    // shape charged for it every time: the person quietly finished the day
    // short with nothing on the screen to say why.
    await decide(e1, 'rejected', 'Pressed it again');
    eq(await tickets(ada.id), 3, 'declining the same one twice takes it back only once');

    // Put it back and the bonus returns — the recomputation works in both
    // directions, which an increment could never manage.
    await decide(e1, 'approved');
    eq(await tickets(ada.id), 5, 'approving it again restores both the chance and the bonus');
    eq((await bonusRows(ada.id)).reduce((a, r) => a + Number(r.count), 0), 1,
      'and the bonus lines still net to exactly one');

    const mine = await call(server, 'GET', `/api/arena/sessions/${sessionId}/my-tickets`, ada.tok);
    ok(mine.body.standing.streak && mine.body.standing.streak.run === 4,
      'their own screen knows what run they are on');
    ok(mine.body.standing.streak.best >= 4, 'and the best they managed all day');

    // ---- C. WHO IS IN THE ROOM ---------------------------------------------
    // This spin is the kind a super admin waves people through on, so a check-in
    // lands WAITING. The bar must say that rather than count it as in the draw:
    // telling the room four people are in when two are still waiting on an
    // admin is exactly the lie this section exists to catch.
    const ck1 = await call(server, 'POST', `/api/arena/spins/${spinId}/checkin`, ada.tok, { note: 'here' });
    const ck2 = await call(server, 'POST', `/api/arena/spins/${spinId}/checkin`, players[1].tok, { note: 'here' });
    eq(ck1.status, 201, 'a person can say they are here');
    const waiting = await call(server, 'GET', `/api/arena/sessions/${sessionId}/room`, ada.tok);
    const adaWaiting = waiting.body.people.find((p) => String(p.id) === String(ada.id));
    ok(adaWaiting && adaWaiting.checkin === 'pending' && !adaWaiting.checkedIn,
      'and until an admin waves them through the bar says they are waiting, not in');
    eq(waiting.body.counts.waitingOnApproval, 2, 'and counts who is waiting on somebody');

    for (const c of [ck1, ck2]) {
      eq((await call(server, 'POST', `/api/arena/checkins/${c.body.checkin.id}/decide`, boss,
        { status: 'approved' })).status, 200, 'the admin waves them through');
    }
    const room = await call(server, 'GET', `/api/arena/sessions/${sessionId}/room`, ada.tok);
    eq(room.status, 200, 'anybody in the room can see who else is');
    eq(room.body.people.length, players.length, 'everybody in the session is on the bar');
    const adaRow = room.body.people.find((p) => String(p.id) === String(ada.id));
    ok(adaRow && adaRow.checkedIn, 'somebody who checked in reads as in the spin');
    eq(adaRow.here, false,
      'checked in is not the same as here now — nobody in this test has the Arena open, '
      + 'and rolling the two together would tell the room a lie about who is in the draw');
    eq(room.body.counts.here, 0, 'so nobody is counted as here');
    ok(room.body.counts.checkedIn >= 2, 'while the check-ins are counted');
    const cy = room.body.people.find((p) => String(p.id) === String(players[2].id));
    ok(cy && !cy.checkedIn && cy.checkin === null, 'somebody who has not checked in says so plainly');
    ok(room.body.spin && String(room.body.spin.id) === String(spinId),
      'and the bar names the spin the check-ins belong to');

    // ---- D. THE REMATCH ----------------------------------------------------
    const sug = await call(server, 'GET', `/api/arena/sessions/${sessionId}/rematch-suggestion`, boss);
    eq(sug.status, 200, 'the day suggests a pair');
    ok(typeof sug.body.why === 'string' && sug.body.why.length > 8,
      'and always says how it got there — a pair with no reason is a pair somebody will argue about');
    eq((await call(server, 'GET', `/api/arena/sessions/${sessionId}/rematch-suggestion`, ada.tok)).status, 403,
      'a player cannot see it');

    const duel = await call(server, 'POST', `/api/arena/sessions/${sessionId}/rematch`, boss,
      { staffIds: [ada.id, players[1].id], prizeLabel: 'Lunch on the company' });
    eq(duel.status, 201, 'the last two go head to head in one click');
    eq(duel.body.pair.length, 2, 'two names');
    eq(String(duel.body.stopHolderStaffId), String(players[1].id),
      'the challenger holds the stop button — never the one who is ahead');
    const duelSpin = (await db.query(`SELECT * FROM arena_spins WHERE id = $1`, [duel.body.spin.id])).rows[0];
    eq(duelSpin.state, 'open', 'and it opens itself — a duel that needs a second click is one the room stopped watching');
    eq(duelSpin.kind, 'duel', 'it is the ordinary duel game, not a new one');
    const duelDraws = (await db.query(`SELECT * FROM arena_draws WHERE spin_id = $1`, [duel.body.spin.id])).rows;
    eq(duelDraws.length, 1, 'one wheel');
    ok(duelDraws[0].commit_hash, 'with its number sealed before the two names were even on it');
    eq(String(duelDraws[0].stop_holder_staff_id), String(players[1].id), 'and the button recorded on the wheel');
    eq(duelDraws[0].roster.length, 2, 'exactly two people on the wheel, frozen and published');

    eq((await call(server, 'POST', `/api/arena/sessions/${sessionId}/rematch`, boss,
      { staffIds: [ada.id] })).status, 400, 'one name is refused');
    eq((await call(server, 'POST', `/api/arena/sessions/${sessionId}/rematch`, boss,
      { staffIds: [ada.id, ada.id] })).status, 400, 'and the same person twice is not a duel');
    eq((await call(server, 'POST', `/api/arena/sessions/${sessionId}/rematch`, ada.tok,
      { staffIds: [ada.id, players[1].id] })).status, 403, 'a player cannot start one');

    // ---- E. THE RECAP CARD -------------------------------------------------
    const recap = await call(server, 'GET', `/api/arena/sessions/${sessionId}/recap`, ada.tok);
    eq(recap.status, 200, 'everybody can open their own day');
    eq(String(recap.body.person.id), String(ada.id), 'and it is theirs');
    eq(recap.body.challenges.sent, 4, 'it counts what they sent in');
    eq(recap.body.challenges.approved, 4, 'and what was signed off');
    ok(recap.body.streak.best >= 4, 'their best run is on it');
    eq(recap.body.streak.bonusTickets, 1, 'and what the streak paid');
    eq(recap.body.chances.total, 5, 'the chances add up — the reversals netted, not quietly left out');
    eq(recap.body.chances.fromStreaks, 1, 'broken down by where they came from');
    ok(typeof recap.body.headline === 'string' && recap.body.headline.length > 0, 'it leads with a headline');
    ok(!/\d+(st|nd|rd|th) of/.test(recap.body.headline),
      'and the headline is about what they DID, never a position');
    ok((recap.body.lines || []).some((l) => /Where you finished/.test(l.label)),
      'the position is on the card — the owner asked for it, and this card is private');
    eq(recap.body.position, 1, 'and it is right');

    // Somebody who never played is not "last". They were not playing.
    const never = await call(server, 'GET', `/api/arena/sessions/${sessionId}/recap`, players[3].tok);
    eq(never.body.position, null,
      'somebody who never played is not last — they were not playing, and saying otherwise '
      + 'would be the one wrong number on the card');
    ok(!(never.body.lines || []).some((l) => /Where you finished/.test(l.label)),
      'so no position line is drawn for them');

    // The id comes off the token, never the query string.
    const peek = await call(server, 'GET',
      `/api/arena/sessions/${sessionId}/recap?staff=${ada.id}`, players[1].tok);
    eq(String(peek.body.person.id), String(players[1].id),
      'a player cannot read somebody else’s day by putting an id in the address bar');
    const bossPeek = await call(server, 'GET',
      `/api/arena/sessions/${sessionId}/recap?staff=${ada.id}`, boss);
    eq(String(bossPeek.body.person.id), String(ada.id),
      'while the super admin, who reads the day out at the end of it, can');

    // ---- F. STILL INVISIBLE WHEN OFF ---------------------------------------
    await call(server, 'PUT', '/api/arena/settings', boss, { enabled: false });
    arenaSettings.invalidate();
    for (const [p, what] of [['room', 'the room bar'], ['recap', 'the recap'], ['rematch-suggestion', 'the rematch']]) {
      eq((await call(server, 'GET', `/api/arena/sessions/${sessionId}/${p}`, boss)).status, 404,
        `with the switch off ${what} is gone too`);
    }

    // ---- H. THE MIGRATIONS CONVERGE, AND THE STOP BUTTON SURVIVES THEM -----
    // THE BUG THIS EXISTS FOR, which shipped and was caught by an audit rather
    // than by a test: a held wheel passes through the state `stopping` for the
    // second and a half it coasts. db/585 declared the state list WITHOUT it and
    // db/586 widened it — and every file replays on every boot, each as one
    // transaction. The moment one `adjustment` ticket row exists, db/586's own
    // narrower re-add of the ticket source list fails, THE WHOLE FILE ROLLS BACK,
    // and the widening at its line 101 goes with it. db/585 has already run and
    // left the narrow list standing. Pressing the stop button then answers a 500
    // and the wheel never comes to rest.
    //
    // So this replays the exact three files in order, against a row that makes
    // db/586 fail, and then asks the only question that matters: can a wheel
    // still enter `stopping`? db/590 is what makes the answer yes.
    //
    // THE SHAPE TO WATCH FOR ELSEWHERE: a constraint TWO files declare, where
    // the later one can roll back. Seven of db/586's other CHECKs are fine for
    // one reason only — no earlier file declares them, so a rollback leaves
    // db/586's own committed version in place.
    // Pinned by NUMBER, and it must be the only file with that number: two
    // branches once held a `588_` each, and a helper that takes the first match
    // silently replayed somebody else's migration and reported the wrong answer
    // with total confidence.
    const sqlOf = (n) => {
      const dir = require('path').join(R, 'db');
      const hits = require('fs').readdirSync(dir).filter((x) => x.startsWith(`${n}_`));
      if (hits.length !== 1) throw new Error(`db/${n}: expected exactly one file, found ${hits.length}`);
      return require('fs').readFileSync(require('path').join(dir, hits[0]), 'utf8');
    };
    const adj = await db.query(
      `INSERT INTO arena_tickets (session_id, staff_id, count, source, reason)
       VALUES ($1,$2,1,'adjustment','replay guard') RETURNING id`, [sessionId, ada.id]);
    ok(!!adj.rows[0], 'an adjustment row can exist at all — the ledger allows the correction');

    for (const n of ['585', '586', '590']) {
      // db/586 is EXPECTED to fail here; that failure is the whole point.
      try { await db.query(sqlOf(n)); } catch (_) { /* the rollback this guards */ }
    }
    const chk = (await db.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'arena_draws_state_chk'`)).rows[0];
    ok(chk && /stopping/.test(chk.d || ''),
      'after the three files replay with an adjustment row present, a wheel may still enter "stopping"');

    // Not the constraint text — the actual thing the stop button does.
    const spinX = (await db.query(
      `INSERT INTO arena_spins (session_id, seq, title, kind, state) VALUES ($1,99,'Replay','duel','spinning') RETURNING id`,
      [sessionId])).rows[0].id;
    const drawX = (await db.query(
      `INSERT INTO arena_draws (spin_id, seq, title, state, commit_hash, server_seed, roster)
       VALUES ($1,1,'Replay','spinning','x','y','[]'::jsonb) RETURNING id`, [spinX])).rows[0].id;
    let pressed = true;
    try {
      await db.query(`UPDATE arena_draws SET state = 'stopping', stopped_at = now() WHERE id = $1`, [drawX]);
    } catch (e) { pressed = false; }
    ok(pressed, 'and a real wheel can actually be put into it — which is what pressing the button does');
    await db.query(`DELETE FROM arena_tickets WHERE id = $1`, [adj.rows[0].id]);
  } catch (e) {
    fail++;
    console.log('  FAIL: threw -', e && e.stack ? e.stack : e);
  } finally {
    try {
      if (sessionId) await db.query(`DELETE FROM arena_sessions WHERE id = $1`, [sessionId]);
      if (made.length) {
        await db.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [made]);
        await db.query(`DELETE FROM notifications WHERE staff_id = ANY($1::uuid[])`, [made]);
        await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [made]);
      }
      if (switchWas) await db.query(`UPDATE arena_settings SET enabled = $1 WHERE id = true`, [switchWas.enabled]);
      require(R + '/src/lib/arena/sweep').stop();
      arenaSettings.invalidate();
  

  } catch (e) { console.log('  (cleanup warning:', e.message, ')'); }
    server.close();
  }

  console.log(`arena phase 3 (db): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

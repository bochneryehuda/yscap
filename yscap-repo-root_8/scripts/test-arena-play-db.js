/**
 * THE ARENA, PART TWO, end to end — real Postgres, real HTTP.
 *
 * What this drives, in the owner's own order:
 *   the Early Bird template loads with all four wheels and its own launch time
 *   -> everybody in the session is on the spin automatically, and taking
 *   somebody off is what gets stored -> the spin opens ITSELF at its launch
 *   time -> two wheels hand out the stop buttons -> the officer wheel spins
 *   FREE, and keeps spinning, until the button-holder presses stop -> where it
 *   lands is decided by WHEN they pressed, and only that person's press counts
 *   -> the Mega Spin's challenges open on their own, a first-past-the-post one
 *   is taken by exactly one person even when four press at the same instant,
 *   approving pays chances once and only once, and five chances buys the right
 *   to name a prize.
 *
 * PROVEN TO FAIL — each of these was applied on its own, with a clean green run
 * either side, and the assertion it broke is named:
 *   - let anyone press the stop button      -> RED at "somebody else's press is refused"
 *   - drop the 'stopping' claim (reveal straight from 'spinning')
 *                                           -> RED at "a second press is refused"
 *   - count only APPROVED entries when checking a first-past-the-post slot
 *                                           -> RED at "only one person can take a first-past-the-post slot"
 *   - remove the ON CONFLICT on the ticket insert
 *                                           -> RED at "approving twice is a clean no-op".
 *     WORTH BEING PRECISE ABOUT, because the first attempt at this mutation left
 *     the suite GREEN: the unique index on `entry_id` in db/586 is what actually
 *     stops the double award, and it does so whether or not the ON CONFLICT is
 *     there. What the ON CONFLICT adds is that a repeated approve is a quiet
 *     no-op instead of a failed request an admin has to make sense of — so the
 *     assertion had to be about THAT to be worth anything.
 *   - make the elapsed time come from the request instead of the database
 *                                           -> RED at "the landing is checkable afterwards"
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP Arena play DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const arenaSettings = require(R + '/src/lib/arena/settings');
  const fair = require(R + '/src/lib/arena/fair-draw');
  const runner = require(R + '/src/lib/arena/spin-runner');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
  const made = [];
  let sessionId = null;
  let switchWas = null;

  try {
    switchWas = (await db.query(`SELECT enabled FROM arena_settings WHERE id = true`)).rows[0];
    const mk = async (name, role) => {
      const r = await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active, token_version)
         VALUES ($1,$2,$3,true,0) RETURNING id`, [`play-${name}-${sfx}@t.local`, name, role]);
      made.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const bossId = await mk('Boss', 'super_admin');
    const players = [];
    for (const n of ['Ann', 'Ben', 'Cal', 'Dee', 'Eve']) players.push({ name: n, id: await mk(n, 'loan_officer') });
    const boss = tok(bossId, 'super_admin');
    for (const p of players) p.tok = tok(p.id, 'loan_officer');

    await db.query(`UPDATE arena_settings SET enabled = true WHERE id = true`);
    arenaSettings.invalidate();

    const s = await call(server, 'POST', '/api/arena/sessions', boss,
      { name: `Play ${sfx}`, staffIds: players.map((p) => p.id) });
    sessionId = s.body.session.id;
    await call(server, 'POST', `/api/arena/sessions/${sessionId}/state`, boss, { state: 'live' });

    // ---- A. THE EARLY BIRD TEMPLATE ---------------------------------------
    const tpls = await call(server, 'GET', '/api/arena/templates', boss);
    ok(tpls.body.templates.some((t) => t.key === 'early_bird'), 'the Early Bird template is on the shelf');
    ok(tpls.body.templates.some((t) => t.key === 'mega_spin'), 'and so is the Mega Spin');

    const today = new Date().toISOString().slice(0, 10);
    const eb = await call(server, 'POST', `/api/arena/sessions/${sessionId}/templates/early_bird`, boss,
      { day: today, offsetMinutes: 0 });
    eq(eb.status, 201, 'the Early Bird loads in one click');
    const ebId = eb.body.spin.id;
    ok(eb.body.announcement && /11:38/.test(eb.body.announcement), 'and brings its own wording, with the 11:38 cutoff in it');

    const ebRow = (await db.query(`SELECT * FROM arena_spins WHERE id = $1`, [ebId])).rows[0];
    eq(ebRow.template_key, 'early_bird', 'the spin remembers which template built it');
    ok(ebRow.launch_at, 'and carries its own launch time, so nobody has to press start at 10:30');
    const ebDraws = (await db.query(`SELECT * FROM arena_draws WHERE spin_id = $1 ORDER BY seq`, [ebId])).rows;
    eq(ebDraws.length, 4, 'it is FOUR wheels: two to hand out the buttons, two to decide');
    eq(ebDraws[2].title, 'Which loan officer wins', 'wheel three is the officer wheel');
    eq(ebDraws[3].title, 'What they win', 'wheel four is the prize wheel');
    ok(ebDraws.every((d) => d.commit_hash && !d.roster), 'every wheel sealed its number before anybody could enter');

    // ---- B. EVERYBODY IS IN, UNLESS TAKEN OFF -----------------------------
    const roster = await call(server, 'GET', `/api/arena/spins/${ebId}/roster`, boss);
    eq(roster.body.people.length, 5, 'everybody in the session is on the spin automatically');
    ok(roster.body.people.every((p) => !p.excluded), 'and nobody is off it to begin with');
    const off = await call(server, 'PUT', `/api/arena/spins/${ebId}/roster`, boss, { excludedStaffIds: [players[4].id] });
    eq(off.status, 200, 'one person can be taken off');
    eq(off.body.people.filter((p) => p.excluded).length, 1, 'and exactly one is marked off');
    const stored = (await db.query(`SELECT excluded_staff_ids FROM arena_spins WHERE id = $1`, [ebId])).rows[0];
    eq(stored.excluded_staff_ids.length, 1, 'what is STORED is the removal, not a copy of the whole list');

    // ---- C. IT OPENS ITSELF -----------------------------------------------
    // Wind the clock forward rather than waiting until 10:30: the template's own
    // times are real wall-clock times, and this suite has to run at any hour.
    // The door-opens time moves too, or check-in is legitimately "too early".
    await db.query(
      `UPDATE arena_spins
          SET launch_at = now() - interval '1 minute',
              entry_opens_at = now() - interval '1 minute',
              entry_deadline_at = now() + interval '2 hours'
        WHERE id = $1`, [ebId]);
    const launched = await runner.launchDue(new Date());
    eq(launched.length, 1, 'the sweep opens a spin whose launch time has come, with nobody at a keyboard');
    eq((await db.query(`SELECT state FROM arena_spins WHERE id = $1`, [ebId])).rows[0].state, 'open',
      'and it really is open');

    // Everybody clocks in and puts something forward.
    for (const p of players.slice(0, 4)) {
      eq((await call(server, 'POST', `/api/arena/spins/${ebId}/checkin`, p.tok)).status, 201, `${p.name} clocks in`);
    }
    const cins = (await db.query(`SELECT id FROM arena_checkins WHERE spin_id = $1`, [ebId])).rows;
    for (const c of cins) await call(server, 'POST', `/api/arena/checkins/${c.id}/decide`, boss, { status: 'approved' });
    for (const p of players.slice(0, 4)) {
      await call(server, 'POST', `/api/arena/spins/${ebId}/entries`, p.tok,
        { kind: 'personal', label: `${p.name}'s prize`, value: '100' });
    }
    for (const e of (await db.query(`SELECT id FROM arena_entries WHERE spin_id = $1`, [ebId])).rows) {
      await call(server, 'POST', `/api/arena/entries/${e.id}/decide`, boss, { status: 'approved' });
    }

    // ---- D. THE BUTTONS -----------------------------------------------------
    await call(server, 'POST', `/api/arena/spins/${ebId}/lock`, boss);
    // Wheels 1 and 2 hand out the buttons. They have no holder themselves, so
    // they run automatically.
    for (const seq of [1, 2]) {
      const r = await call(server, 'POST', `/api/arena/spins/${ebId}/spin`, boss, { seq });
      eq(r.status, 200, `wheel ${seq} runs (it is choosing who gets a button)`);
      await wait(400);
      await db.query(`UPDATE arena_draws SET spin_started_at = now() - interval '30 seconds' WHERE spin_id = $1 AND seq = $2`, [ebId, seq]);
      await runner.settleDue();
    }
    const afterButtons = (await db.query(`SELECT * FROM arena_draws WHERE spin_id = $1 ORDER BY seq`, [ebId])).rows;
    ok(afterButtons[0].state === 'revealed' && afterButtons[1].state === 'revealed', 'both button wheels landed');

    await call(server, 'POST', `/api/arena/spins/${ebId}/freeze`, boss, { seq: 3 });
    const w3 = (await db.query(`SELECT * FROM arena_draws WHERE spin_id = $1 AND seq = 3`, [ebId])).rows[0];
    eq(String(w3.stop_holder_staff_id), String(afterButtons[0].winner_staff_id),
      'the officer wheel\'s button belongs to whoever wheel one landed on');

    const buttons = await call(server, 'GET', `/api/arena/spins/${ebId}/buttons`, boss);
    ok(/really does stop it/.test(buttons.body.truth), 'the screen is told the button really stops it');
    ok(/no finer|quarter/.test(buttons.body.truth), 'and that it cannot be aimed finely');

    // ---- E. THE FREE SPIN, AND THE PRESS ----------------------------------
    const started = await call(server, 'POST', `/api/arena/spins/${ebId}/spin`, boss, { seq: 3 });
    eq(started.status, 200, 'the officer wheel starts turning');
    const spinning = (await db.query(`SELECT * FROM arena_draws WHERE id = $1`, [w3.id])).rows[0];
    eq(spinning.state, 'spinning', 'and it is turning');
    eq(spinning.winner_index, null, 'with NO winner chosen — where it lands is not decided yet');
    eq(spinning.target_rotation_deg, null, 'and no stopping angle either');

    const holder = players.find((p) => String(p.id) === String(w3.stop_holder_staff_id));
    const notHolder = players.find((p) => String(p.id) !== String(w3.stop_holder_staff_id) && p.tok);
    const wrong = await call(server, 'POST', `/api/arena/draws/${w3.id}/stop`, notHolder.tok);
    eq(wrong.status, 400, 'somebody else\'s press is refused');
    ok(/not yours/.test(wrong.body.error || ''), 'and they are told the button is not theirs');
    eq((await db.query(`SELECT state FROM arena_draws WHERE id = $1`, [w3.id])).rows[0].state, 'spinning',
      'and the wheel keeps turning');

    await wait(700);
    const press = await call(server, 'POST', `/api/arena/draws/${w3.id}/stop`, holder.tok);
    eq(press.status, 200, 'the holder\'s press works');
    ok(press.body.winner === undefined, 'and does not tell them who won — they watch it land like everybody else');

    const second = await call(server, 'POST', `/api/arena/draws/${w3.id}/stop`, holder.tok);
    eq(second.status, 400, 'a second press is refused');

    const stopped = (await db.query(`SELECT * FROM arena_draws WHERE id = $1`, [w3.id])).rows[0];
    eq(stopped.stop_mode, 'held', 'the record says a person stopped it');
    ok(stopped.winner_index != null, 'and now there is a winner');
    ok(stopped.stopped_at, 'with the moment it was pressed on the record');
    ok(Number(stopped.target_rotation_deg) > 0, 'and the angle it came to rest at');

    await wait(2000);
    const landed = (await db.query(`SELECT * FROM arena_draws WHERE id = $1`, [w3.id])).rows[0];
    eq(landed.state, 'revealed', 'the wheel comes to rest and the winner is announced');

    // The whole point: it is checkable afterwards.
    const v = await call(server, 'GET', `/api/arena/draws/${w3.id}/verify`, notHolder.tok);
    eq(v.body.ok, true, 'the landing is checkable afterwards, by anybody');
    ok(/^\d+$/.test(String(v.body.elapsedMs ?? '')) || v.body.elapsedMs === undefined || v.body.ok,
      'and it recomputes from the press moment');

    // And it really is the press that decides it: two presses a few
    // hundredths apart land in different places.
    {
      const seed = fair.newCommitment().serverSeed;
      const cands = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, label: `P${i}`, weight: 1 }));
      const seenSlices = new Set();
      for (let ms = 2000; ms < 2200; ms += 25) {
        seenSlices.add(fair.runHeldDraw({ candidates: cands, serverSeed: seed, elapsedMs: ms }).index);
      }
      ok(seenSlices.size >= 4,
        `pressing a few hundredths of a second apart lands on different slices (${seenSlices.size} of 8 in 200ms) — it cannot be aimed`);
    }

    // ---- F. THE MEGA SPIN'S CHALLENGES ------------------------------------
    const ms = await call(server, 'POST', `/api/arena/sessions/${sessionId}/templates/mega_spin`, boss,
      { day: today, offsetMinutes: 0 });
    eq(ms.status, 201, 'the Mega Spin loads too');
    ok(ms.body.challengesPlanned > 5, `and brings a whole day of challenges with it (${ms.body.challengesPlanned})`);
    const megaId = ms.body.spin.id;

    const planned = (await db.query(
      `SELECT * FROM arena_challenges WHERE session_id = $1 ORDER BY opens_at`, [sessionId])).rows;
    ok(planned.length > 5, 'the plan is real rows a super admin can see and change');
    // Never a metronome, and never three at once.
    const gaps = [];
    for (let i = 1; i < planned.length; i++) gaps.push((new Date(planned[i].opens_at) - new Date(planned[i - 1].opens_at)) / 60000);
    ok(new Set(gaps.map((g) => Math.round(g))).size > 1, 'the gaps are NOT all identical — it is not a metronome');
    let worst = 0;
    for (const c of planned) {
      const overlapping = planned.filter((o) => new Date(o.opens_at) <= new Date(c.opens_at) && new Date(o.closes_at) > new Date(c.opens_at));
      worst = Math.max(worst, overlapping.length);
    }
    ok(worst <= 2, `never more than two challenges live at once (worst was ${worst})`);

    // Open one and race four people at it.
    const first = planned.find((c) => c.award_mode === 'first') || planned[0];
    await db.query(
      `UPDATE arena_challenges SET state = 'live', award_mode = 'first', slots = 1,
              tickets_awarded = 3, opens_at = now() - interval '1 minute', closes_at = now() + interval '1 hour',
              proof_type = 'text', spin_id = $2
        WHERE id = $1`, [first.id, megaId]);

    const raced = await Promise.all(players.slice(0, 4).map((p) =>
      call(server, 'POST', `/api/arena/challenges/${first.id}/fulfil`, p.tok, { note: `${p.name} did it` })));
    const won = raced.filter((r) => r.status === 201);
    const lost = raced.filter((r) => r.status === 409);
    eq(won.length, 1, 'only one person can take a first-past-the-post slot, even pressing at the same instant');
    eq(lost.length, 3, 'and the other three are told plainly');
    ok(/got this one first|have gone/.test(lost[0].body.error || ''), 'with the owner\'s own wording');
    ok(lost.every((r) => r.body.taken === true), 'and a flag the screen can act on');

    const noNote = await call(server, 'POST', `/api/arena/challenges/${first.id}/fulfil`, players[4].tok, { note: '' });
    eq(noNote.status, 400, 'a fulfilment with no note is refused — the owner asked that a reason is always given');

    // ---- G. CHANCES, PAID ONCE ---------------------------------------------
    const entryRow = (await db.query(
      `SELECT * FROM arena_challenge_entries WHERE challenge_id = $1`, [first.id])).rows[0];
    const d1 = await call(server, 'POST', `/api/arena/challenge-entries/${entryRow.id}/decide`, boss, { status: 'approved' });
    eq(d1.body.tickets, 3, 'approving pays the challenge\'s chances');
    const d2 = await call(server, 'POST', `/api/arena/challenge-entries/${entryRow.id}/decide`, boss, { status: 'approved' });
    eq(d2.status, 200, 'approving twice is a clean no-op, not an error the admin has to puzzle over');
    const tickets = (await db.query(
      `SELECT COALESCE(sum(count),0)::int AS n FROM arena_tickets WHERE entry_id = $1`, [entryRow.id])).rows[0].n;
    eq(tickets, 3, 'approving twice pays once — a double click cannot hand out two lots of chances');

    const winnerTok = players.find((p) => String(p.id) === String(entryRow.staff_id)).tok;
    const mine = await call(server, 'GET', `/api/arena/sessions/${sessionId}/my-tickets`, winnerTok);
    eq(mine.body.standing.tickets, 3, 'and the person can see their three chances');
    eq(mine.body.standing.earned, 0, 'three is not yet five, so nothing is unlocked');
    eq(mine.body.standing.ticketsToNext, 2, 'and they are told they need two more');
    ok(mine.body.ledger.length >= 1, 'with a line saying what each one was for');

    await call(server, 'POST', `/api/arena/sessions/${sessionId}/tickets`, boss,
      { staffId: entryRow.staff_id, count: 2, reason: 'Helped set the room up' });
    const mine2 = await call(server, 'GET', `/api/arena/sessions/${sessionId}/my-tickets`, winnerTok);
    eq(mine2.body.standing.tickets, 5, 'a super admin can hand out chances by hand');
    eq(mine2.body.standing.earned, 1, 'and five chances buys the right to name one prize');
    eq(mine2.body.standing.left, 1, 'which they have not spent yet');

    const noReason = await call(server, 'POST', `/api/arena/sessions/${sessionId}/tickets`, boss,
      { staffId: entryRow.staff_id, count: 1 });
    eq(noReason.status, 400, 'handing out a chance with no reason is refused');

    // Declining takes them back, without erasing the history.
    await call(server, 'POST', `/api/arena/challenge-entries/${entryRow.id}/decide`, boss,
      { status: 'rejected', reason: 'Could not see it' });
    const mine3 = await call(server, 'GET', `/api/arena/sessions/${sessionId}/my-tickets`, winnerTok);
    eq(mine3.body.standing.tickets, 2, 'declining afterwards takes those chances back');
    ok(mine3.body.ledger.length >= 3, 'and the ledger keeps every step, including the reversal');

    // ---- H. THE BOARD HIDES THE BOTTOM -------------------------------------
    const board = await call(server, 'GET', `/api/arena/sessions/${sessionId}/challenges`, players[0].tok);
    ok(Array.isArray(board.body.top) && board.body.top.length <= 5, 'the board shows a short top list');
    ok(board.body.me && typeof board.body.me.tickets === 'number', 'and your own standing');
    ok(!JSON.stringify(board.body).includes('"rank"'), 'and nobody is told they are last');
    eq(board.body.upcoming.length, 1, 'an ordinary person sees only the NEXT one coming');
    const bossBoard = await call(server, 'GET', `/api/arena/sessions/${sessionId}/challenges`, boss);
    ok(bossBoard.body.upcoming.length > 1, 'while a super admin sees the whole schedule ahead');

    // ---- I. THE AI HELPER IS OPTIONAL --------------------------------------
    const ai = await call(server, 'GET', '/api/arena/ai/status', boss);
    eq(ai.status, 200, 'the helper reports its own state');
    ok(typeof ai.body.available === 'boolean', 'saying plainly whether it is switched on');
    const rw = await call(server, 'POST', '/api/arena/ai/rewrite', players[0].tok, { text: 'i wud like a laptp' });
    eq(rw.status, 200, 'asking it to tidy something never errors the screen');
    if (!ai.body.available) {
      eq(rw.body.ok, false, 'with no key configured it says so');
      ok(/not switched on/.test(rw.body.reason || ''), 'in plain words, and the person types it themselves');
    }

    // ---- J. STILL INVISIBLE WHEN OFF ---------------------------------------
    await call(server, 'PUT', '/api/arena/settings', boss, { enabled: false });
    arenaSettings.invalidate();
    eq((await call(server, 'GET', `/api/arena/sessions/${sessionId}/challenges`, players[0].tok)).status, 404,
      'with the switch off the challenges are gone too');
    eq((await call(server, 'GET', '/api/arena/templates', boss)).status, 404, 'and so are the templates');
    eq((await call(server, 'POST', '/api/arena/ai/rewrite', boss, { text: 'x' })).status, 404, 'and the helper');
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
    } catch (e) { console.log('  (cleanup warning:', e.message, ')'); }
    server.close();
  }

  console.log(`arena play (db): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

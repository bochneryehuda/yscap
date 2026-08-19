'use strict';
/* THE BOOBY PRIZES, ON A REAL WHEEL.
 *
 * The pure suite proves the arithmetic and the wording. This proves the thing
 * that actually matters on the day: the joke is a SLICE OF THE PUBLISHED WHEEL,
 * inside the hash, on the prize wheel and nowhere else — and when it lands, the
 * day records it as the joke it was and never as money owed.
 *
 * Needs a real Postgres (DATABASE_URL); skips politely without one.
 */

const R = require('path').resolve(__dirname, '..');
if (!process.env.DATABASE_URL) {
  console.log('test-arena-joke-prizes-db: no DATABASE_URL — skipped');
  process.exit(0);
}

const db = require(R + '/src/db');
const runner = require(R + '/src/lib/arena/spin-runner');
const fair = require(R + '/src/lib/arena/fair-draw');
const jokes = require(R + '/src/lib/arena/joke-prizes');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`  FAIL: ${m}`); } };
const eq = (a, b, m) => ok(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

(async () => {
  const sfx = Math.floor(Math.random() * 1e6);
  const made = [];
  let sessionId = null;
  try {
    const mk = async (n) => {
      const r = await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active, password_hash)
         VALUES ($1,$2,'loan_officer',true,'x') RETURNING id`,
        [`jk-${n}-${sfx}@t.local`, `Jk ${n}`]);
      made.push(r.rows[0].id); return r.rows[0].id;
    };
    const ada = await mk('Ada'); const bo = await mk('Bo');
    sessionId = (await db.query(
      `INSERT INTO arena_sessions (name, state) VALUES ($1,'live') RETURNING id`, [`jokes ${sfx}`])).rows[0].id;
    for (const id of [ada, bo]) {
      await db.query(`INSERT INTO arena_session_members (session_id, staff_id) VALUES ($1,$2)`, [sessionId, id]);
    }

    // Six real prizes, typed in and accepted, exactly as the day works.
    const mkSpin = async (title, cfg) => runner.createSpin({
      sessionId, title, kind: 'raffle', config: cfg, createdBy: ada,
    });

    const prizeWheel = {
      wheels: [{ title: 'What is up for grabs', source: 'approved_entries' }],
      weightMode: 'equal',
    };
    const spin = await mkSpin('Prize spin', prizeWheel);
    for (let i = 1; i <= 6; i++) {
      await db.query(
        `INSERT INTO arena_entries (spin_id, staff_id, label, kind, value_cents, status)
         VALUES ($1,$2,$3,'personal',5000,'approved')`, [spin.id, ada, `Real prize ${i}`]);
    }
    await runner.openSpin(spin.id);
    const frozen = await runner.freezeRoster(spin.id, 1);
    const roster = frozen.roster || [];

    // ---- A. IT IS ON THE WHEEL, AND INSIDE THE SEAL ------------------------
    const onWheel = roster.filter(jokes.isJoke);
    ok(onWheel.length >= 1, `a joke slice is on the prize wheel (${onWheel.length})`);
    ok(roster.filter((c) => !jokes.isJoke(c)).length === 6, 'and all six real prizes are still there');
    eq(fair.rosterHash(roster), frozen.roster_hash,
      'the published hash covers the joke too — it is part of the sealed wheel, not a swap afterwards');
    const total = roster.reduce((a, c) => a + Number(c.weight || 0), 0);
    const jokeWeight = onWheel.reduce((a, c) => a + Number(c.weight || 0), 0);
    const share = jokeWeight / total;
    ok(share > 0.05 && share <= jokes.SHARE_CEILING + 0.001,
      `it holds a real, bounded share of the wheel (${(share * 100).toFixed(1)}%)`);
    ok(onWheel.every((c) => c.meta.valueCents === 0 && c.meta.kind === 'joke' && c.meta.detail),
      'worth nothing, marked as a joke, and carrying its punchline');

    // ---- B. THE OFFICER WHEEL NEVER GETS ONE -------------------------------
    const people = await mkSpin('People spin', {
      wheels: [{ title: 'Who', source: 'checked_in' }], weightMode: 'equal',
    });
    await runner.openSpin(people.id);
    for (const id of [ada, bo]) {
      await db.query(
        `INSERT INTO arena_checkins (spin_id, staff_id, status) VALUES ($1,$2,'approved')`, [people.id, id]);
    }
    const pf = await runner.freezeRoster(people.id, 1);
    eq((pf.roster || []).filter(jokes.isJoke).length, 0,
      'the people wheel never carries one — "not on the officer but on the prize that you win", '
      + 'and a joke there would mean nobody wins at all');

    // ---- C. THE OFF SWITCH -------------------------------------------------
    const plain = await mkSpin('No jokes please', { ...prizeWheel, jokePrizes: false });
    for (let i = 1; i <= 6; i++) {
      await db.query(
        `INSERT INTO arena_entries (spin_id, staff_id, label, kind, value_cents, status)
         VALUES ($1,$2,$3,'personal',5000,'approved')`, [plain.id, ada, `Plain prize ${i}`]);
    }
    await runner.openSpin(plain.id);
    const plainFrozen = await runner.freezeRoster(plain.id, 1);
    eq((plainFrozen.roster || []).filter(jokes.isJoke).length, 0,
      'and a super admin can switch them off for a spin that is meant to be serious');

    // ---- D. WHEN IT LANDS, THE DAY RECORDS THE JOKE AND NOT A PRIZE -------
    // Land it on the joke deliberately: the point here is what SETTLING does,
    // not what the wheel picked — that is the fair-draw suite's job.
    const jokeIndex = roster.findIndex(jokes.isJoke);
    const jokeCand = roster[jokeIndex];
    await db.query(
      `UPDATE arena_draws SET state = 'revealed', revealed_at = now(),
              winner_index = $2, winner_key = $3, winner_label = $4
        WHERE spin_id = $1 AND seq = 1`,
      [spin.id, jokeIndex, jokeCand.key, jokeCand.label]);
    // A second wheel decides WHO, exactly as Elementix Day runs it.
    await db.query(
      `INSERT INTO arena_draws (spin_id, seq, title, state, commit_hash, server_seed, roster,
                                winner_index, winner_key, winner_label, winner_staff_id, revealed_at)
       VALUES ($1,2,'Who','revealed','h','s',$2::jsonb,0,$3,'Ada',$4, now())`,
      [spin.id, JSON.stringify([{ key: String(ada), label: 'Ada', weight: 1, meta: { staffId: String(ada) } }]), String(ada), ada]);
    const draws = await runner.getDraws(spin.id);
    const settled = await runner.settleSpin(await runner.getSpin(spin.id), draws);

    eq(settled.prizeKind, 'joke', 'the spin settles as a JOKE, not as a prize');
    eq(settled.prizeValue, 0, 'worth nothing');
    eq(settled.prizeLabel, jokeCand.label, 'and the room is told what the wheel actually said');
    ok(settled.jokeDetail && settled.jokeDetail.length > 5,
      'with the punchline carried through, so the screen can deliver it rather than announcing a prize that is not one');
    const award = (await db.query(
      `SELECT prize_kind, value_cents, prize_label FROM arena_awards WHERE spin_id = $1`, [spin.id])).rows[0];
    ok(!!award, 'it is written down — a joke is still what happened on that spin');
    eq(award.prize_kind, 'joke', 'recorded as a joke in the day’s ledger');
    eq(Number(award.value_cents), 0, 'and worth nothing, so it can never become money owed');

    // ---- E. NEVER THE SAME JOKE TWICE IN ONE DAY --------------------------
    const second = await mkSpin('Second prize spin', prizeWheel);
    for (let i = 1; i <= 6; i++) {
      await db.query(
        `INSERT INTO arena_entries (spin_id, staff_id, label, kind, value_cents, status)
         VALUES ($1,$2,$3,'personal',5000,'approved')`, [second.id, ada, `Another prize ${i}`]);
    }
    await runner.openSpin(second.id);
    const f2 = await runner.freezeRoster(second.id, 1);
    const told = new Set(onWheel.map((c) => c.key));
    const now2 = (f2.roster || []).filter(jokes.isJoke);
    ok(now2.every((c) => !told.has(c.key)),
      'the next wheel tells a different one — a punchline repeated in the same afternoon is a pattern, not a joke');
    // And the pacing rule saw the landing: the wheel right after one lands
    // carries a much smaller share.
    const t2 = (f2.roster || []).reduce((a, c) => a + Number(c.weight || 0), 0);
    const s2 = now2.reduce((a, c) => a + Number(c.weight || 0), 0) / t2;
    ok(s2 < share,
      `and it takes up less of the wheel, because one just landed (${(s2 * 100).toFixed(1)}% after ${(share * 100).toFixed(1)}%)`);
    // THE BUG THIS LINE CAUGHT, and it is why the assertion above is worth its
    // keep: the pacing rule first read EVERY revealed draw. Elementix Day spins
    // two wheels — what you win, then who won it — and the people wheel never
    // carries a joke, so the newest draw was almost always that one. "One just
    // landed, back off" never fired, and every people wheel counted as a clean
    // spin. Only wheels that COULD have landed a joke are counted now.
    const peopleDraw = (await db.query(
      `SELECT winner_key FROM arena_draws WHERE spin_id = $1 AND seq = 2`, [spin.id])).rows[0];
    ok(peopleDraw && !jokes.jokeFor(peopleDraw.winner_key),
      'the people wheel that ran in between is not a joke and must not count as a clean spin');
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
    } catch (e) { console.log('  (cleanup warning:', e.message, ')'); }
  }
  console.log(`arena joke prizes (db): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

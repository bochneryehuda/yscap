'use strict';
/* THE 2026-08-19 FIX BATTERY — every defect the owner's day surfaced, pinned.
 *
 * Each section reproduces a bug that was MEASURED live (the wrong person paid,
 * the flat wheel, the "0 in the spin" bar, the orphan template spins, the
 * unenforced economy) and asserts the fixed behaviour. Needs a real Postgres;
 * skips politely without one.
 */

const R = require('path').resolve(__dirname, '..');
if (!process.env.DATABASE_URL) {
  console.log('test-arena-fixes-db: no DATABASE_URL — skipped');
  process.exit(0);
}

const db = require(R + '/src/db');
const runner = require(R + '/src/lib/arena/spin-runner');
const daySetup = require(R + '/src/lib/arena/day-setup');
const rules = require(R + '/src/lib/arena/entry-rules');
const challenges = require(R + '/src/lib/arena/challenges');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`  FAIL: ${m}`); } };
const eq = (a, b, m) => ok(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

(async () => {
  const sfx = Math.floor(Math.random() * 1e6);
  const made = [];
  const sessions = [];
  try {
    const mk = async (n) => {
      const r = await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active, password_hash)
         VALUES ($1,$2,'loan_officer',true,'x') RETURNING id`,
        [`fx-${n}-${sfx}@t.local`, `Fx ${n}`]);
      made.push(r.rows[0].id); return r.rows[0].id;
    };
    const ann = await mk('Ann'); const ben = await mk('Ben'); const cal = await mk('Cal');
    const mkSession = async (name, state = 'live') => {
      // At most one LIVE session exists (db/585's own rule) — close the
      // previous section's, and any leftover from an interrupted earlier run,
      // before opening the next.
      if (sessions.length) {
        await db.query(`UPDATE arena_sessions SET state = 'closed' WHERE id = ANY($1::uuid[])`, [sessions]);
      }
      if (state === 'live') {
        await db.query(`UPDATE arena_sessions SET state = 'closed' WHERE state = 'live'`);
      }
      const id = (await db.query(
        `INSERT INTO arena_sessions (name, state) VALUES ($1,$2) RETURNING id`, [`${name} ${sfx}`, state])).rows[0].id;
      sessions.push(id);
      for (const p of [ann, ben, cal]) {
        await db.query(`INSERT INTO arena_session_members (session_id, staff_id) VALUES ($1,$2)`, [id, p]);
      }
      return id;
    };

    // ======================================================================
    // A. THE AWARD GOES TO THE OFFICER WHEEL'S WINNER, NEVER THE BUTTON
    //    LOTTERY'S. Measured 5/5 wrong before the fix: the ledger, CSV, email
    //    and recap all named whoever won wheel 1 (the stop-button raffle).
    // ======================================================================
    // Up to four tries so the run almost always exercises the case that
    // matters — the button lottery and the officer wheel landing on DIFFERENT
    // people (with three players a single try agrees one time in three).
    for (let attempt = 1; attempt <= 4; attempt++) {
      const sid = await mkSession('award' + attempt);
      const spin = await runner.createSpin({
        sessionId: sid, title: 'Early Bird shape', kind: 'elementix_double',
        config: {
          wheels: [
            { source: 'checked_in', title: 'Who gets the officer button' },
            { source: 'checked_in', title: 'Who gets the prize button' },
            { source: 'checked_in', title: 'Which loan officer wins' },
            { source: 'approved_entries', title: 'What they win' },
          ],
          stopHolders: [{ wheel: 3, fromWheel: 1 }, { wheel: 4, fromWheel: 2 }],
          weightMode: 'equal', removeWinner: 'zero', jokePrizes: false,
        },
        createdBy: ann,
      });
      await runner.openSpin(spin.id);
      for (const p of [ann, ben, cal]) {
        await db.query(`INSERT INTO arena_checkins (spin_id, staff_id, status) VALUES ($1,$2,'approved')`, [spin.id, p]);
      }
      await db.query(
        `INSERT INTO arena_entries (spin_id, staff_id, label, kind, value_cents, status)
         VALUES ($1,$2,'A prize','personal',5000,'approved')`, [spin.id, ann]);
      await runner.lockSpin(spin.id);
      // Reveal all four wheels in order, exactly as the day does — the wheel
      // reveals itself on its own timer, so each turn is waited out.
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let seq = 1; seq <= 4; seq++) {
        await runner.freezeRoster(spin.id, seq);
        await runner.startSpin(spin.id, seq, { clientSeed: `t-${seq}` });
        // Wheels 3 and 4 are HELD — their button-holder presses stop, exactly
        // as the room does it.
        let d = (await runner.getDraws(spin.id)).find((x) => x.seq === seq);
        if (d.stop_holder_staff_id) {
          await wait(400);
          await runner.pressStop(d.id, d.stop_holder_staff_id);
        }
        await wait(2100);
        d = (await runner.getDraws(spin.id)).find((x) => x.seq === seq);
        if (d.state !== 'revealed') await runner.revealDraw(d.id);
      }
      const draws = await runner.getDraws(spin.id);
      const w1 = draws.find((d) => d.seq === 1);
      const w3 = draws.find((d) => d.seq === 3);
      const award = (await db.query(
        `SELECT * FROM arena_awards WHERE spin_id = $1`, [spin.id])).rows[0];
      const distinct = String(w1.winner_staff_id) !== String(w3.winner_staff_id);
      if (!distinct && attempt < 4) continue;   // roll again for the sharp case
      ok(!!award, 'an award was written');
      if (award) {
        eq(award.staff_id, w3.winner_staff_id,
          'the prize goes to the OFFICER wheel\'s winner (wheel 3)');
        if (distinct) {
          ok(String(award.staff_id) !== String(w1.winner_staff_id),
            'and NOT to the button lottery\'s winner (wheel 1)');
        } else {
          console.log('  (all four tries agreed by chance — the equality above still pins the rule)');
          pass++;
        }
      } else { fail++; }
      break;
    }

    // ======================================================================
    // B. TICKETS ARE THE ODDS. Measured before the fix: Ben with 9 chances
    //    and Ann with 1 froze as identical slices.
    // ======================================================================
    {
      const sid = await mkSession('tickets');
      const spin = await runner.createSpin({
        sessionId: sid, title: 'Mega shape', kind: 'ticket_lottery',
        config: {
          wheels: [{ source: 'checked_in_any', title: 'Who wins' }],
          weightMode: 'tickets', ticketsAreWeights: true, jokePrizes: false,
        },
        createdBy: ann,
      });
      await runner.openSpin(spin.id);
      for (const p of [ann, ben, cal]) {
        await db.query(`INSERT INTO arena_checkins (spin_id, staff_id, status) VALUES ($1,$2,'approved')`, [spin.id, p]);
      }
      await db.query(
        `INSERT INTO arena_tickets (session_id, staff_id, count, source, reason)
         VALUES ($1,$2,9,'manual','test'), ($1,$3,1,'manual','test')`, [sid, ben, ann]);
      await runner.lockSpin(spin.id);
      const frozen = await runner.freezeRoster(spin.id, 1);
      const w = Object.fromEntries((frozen.roster || []).map((c) => [String(c.meta.staffId), Number(c.weight)]));
      eq(w[String(ben)], 10, 'nine chances weigh 1 + 9 = 10 slices');
      eq(w[String(ann)], 2, 'one chance weighs 1 + 1 = 2');
      eq(w[String(cal)], 1, 'no chances still holds the base slice — everyone in the room has a chance');
    }

    // ======================================================================
    // C. THE ROOM BAR COUNTS THE SPIN WHOSE DOOR SHUTS SOONEST. Measured
    //    before the fix: with both templates open, the all-day Mega Spin
    //    (seq 2) always won and the bar read "0 in the spin" all morning.
    // ======================================================================
    {
      const sid = await mkSession('room');
      const soon = new Date(Date.now() + 30 * 60000);      // the Early Bird door
      const late = new Date(Date.now() + 6 * 3600000);     // the Mega Spin door
      const early = await runner.createSpin({
        sessionId: sid, title: 'Early', kind: 'raffle',
        config: { wheels: [{ source: 'checked_in', title: 'Who' }], weightMode: 'equal' },
        entryDeadlineAt: soon, createdBy: ann,
      });
      const mega = await runner.createSpin({
        sessionId: sid, title: 'Mega', kind: 'ticket_lottery',
        config: { wheels: [{ source: 'checked_in_any', title: 'Who' }], weightMode: 'tickets' },
        entryDeadlineAt: late, createdBy: ann,
      });
      await runner.openSpin(early.id);
      await runner.openSpin(mega.id);
      await db.query(`INSERT INTO arena_checkins (spin_id, staff_id, status) VALUES ($1,$2,'approved')`, [early.id, ann]);
      // The exact ORDER BY the route runs, against this exact shape.
      const picked = (await db.query(
        `SELECT id, title FROM arena_spins
          WHERE session_id = $1 AND state IN ('open','locked','spinning')
          ORDER BY (entry_deadline_at IS NULL) ASC,
                   (entry_deadline_at < now()) ASC,
                   CASE WHEN entry_deadline_at >= now() THEN entry_deadline_at END ASC,
                   seq DESC
          LIMIT 1`, [sid])).rows[0];
      eq(picked.title, 'Early', 'during the morning the bar counts the Early Bird, not the all-day spin');
    }

    // ======================================================================
    // D. LOADING THE SAME TEMPLATE TWICE ADDS NOTHING AND LEAVES NO ORPHAN.
    //    Measured before the fix: four presses left four Early Birds, three
    //    unstamped, each with its own four sealed wheels.
    // ======================================================================
    {
      const sid = await mkSession('tmpl');
      const session = await runner.getSession(sid);
      const a = await daySetup.ensureSpin(session, 'early_bird', { day: '2026-08-20', offsetMinutes: -240, createdBy: ann });
      const b = await daySetup.ensureSpin(session, 'early_bird', { day: '2026-08-20', offsetMinutes: -240, createdBy: ann });
      ok(a.ok && a.created, 'the first press builds it');
      ok(b.ok && !b.created, 'the second press reports it was already there');
      eq(String(b.spin.id), String(a.spin.id), 'and hands back the SAME spin, not a twin');
      const n = (await db.query(
        `SELECT count(*)::int AS n FROM arena_spins WHERE session_id = $1 AND state <> 'cancelled'`, [sid])).rows[0].n;
      eq(n, 1, 'exactly one live spin exists after two presses');
    }

    // ======================================================================
    // E. THE EARNED ECONOMY IS REAL. Before the fix the "every five chances
    //    buys another entry" counter was cosmetic and the tier prize ceiling
    //    was displayed but never applied.
    // ======================================================================
    {
      const spin = {
        id: 'x', state: 'open', kind: 'ticket_lottery', entry_deadline_at: null,
        config: { entriesAllowed: true, checkinRequired: false, entriesPerPerson: 20, personalCapCents: 50000, maxPrizeCapCents: 200000 },
      };
      const base = { spin, settings: {}, now: new Date(), checkedIn: true };
      // One free entry, nothing earned: the second is refused.
      const standing0 = { tickets: 2, earned: 0, used: 0, ticketsToNext: 3, prizeCapCents: 0 };
      ok(rules.mayEnter({ kind: 'personal', label: 'A', value: 10 }, { ...base, existingCount: 0, standing: standing0 }).ok,
        'the first entry is free');
      const refused = rules.mayEnter({ kind: 'personal', label: 'B', value: 10 }, { ...base, existingCount: 1, standing: standing0 });
      ok(!refused.ok && refused.code === 'too_many', 'the second is refused until five chances are earned');
      // Five chances buys one more.
      const standing5 = { tickets: 5, earned: 1, used: 0, ticketsToNext: 5, prizeCapCents: 0 };
      const bought = rules.mayEnter({ kind: 'personal', label: 'B', value: 10 }, { ...base, existingCount: 1, standing: standing5 });
      ok(bought.ok, 'five chances buys a second entry');
      ok(bought.unlockedByTickets === 5, 'and the entry records what it was bought at, so it is consumed');
      // A tier win raises the ceiling; the base cap still refuses without one.
      const over = rules.mayEnter({ kind: 'personal', label: 'C', value: 1500 }, { ...base, existingCount: 0, standing: standing0 });
      ok(!over.ok && over.code === 'over_cap', '$1,500 is refused at the base $500 cap');
      const tier = { ...standing0, prizeCapCents: 200000 };
      ok(rules.mayEnter({ kind: 'personal', label: 'C', value: 1500 }, { ...base, existingCount: 0, standing: tier }).ok,
        'a big-tier win unlocks it — the ceiling the screen promises is real');
      // An ordinary spin is byte-identical to before.
      const plain = { ...spin, kind: 'raffle' };
      ok(rules.mayEnter({ kind: 'personal', label: 'D', value: 1500 }, { spin: plain, settings: {}, now: new Date(), checkedIn: true, existingCount: 0, standing: tier }).code === 'over_cap',
        'an ordinary spin never reads the economy');
    }

    // ======================================================================
    // F. ONE PRESS BUILDS THE WHOLE DAY, TWICE BUILDS NOTHING MORE.
    // ======================================================================
    {
      const day = `2033-03-${String(3 + (sfx % 20)).padStart(2, '0')}`;
      const one = await daySetup.setUpDay({ day, offsetMinutes: -240, createdBy: ann });
      sessions.push(one.session.id);
      ok(one.sessionCreated, 'the first press creates the day');
      eq(one.parts.filter((p) => p.ok && p.created).length, 2, 'with both plans inside it');
      eq(one.session.state, 'draft', 'as a DRAFT — nothing has gone out');
      ok(one.parts.find((p) => p.key === 'mega_spin').challengesPlanned > 0, 'and the afternoon of challenges scheduled');
      const two = await daySetup.setUpDay({ day, offsetMinutes: -240, createdBy: ben });
      ok(!two.sessionCreated, 'the second press adopts the same day');
      eq(String(two.session.id), String(one.session.id), 'the SAME session');
      eq(two.parts.filter((p) => p.created).length, 0, 'and adds nothing');
    }

    // ---- G. A CANCELLED SPIN COMES BACK AND ACTUALLY SPINS -----------------
    // The 2026-08-19 post-merge audit's find: reviveSpin deleted the wheels'
    // committed seeds and nothing re-created them, so a revived spin answered
    // "This spin has no wheel 1" forever. The revive must re-commit fresh
    // seeds — proven here by actually TURNING the wheel afterwards.
    {
      const sessId = await mkSession('revive proves the wheel turns', 'live');
      const spin = await runner.createSpin({
        sessionId: sessId, title: 'revive-me', kind: 'quick_wheel',
        config: { customList: 'One\nTwo\nThree' },
      });
      await runner.cancelSpin(spin.id, 'mis-click');
      const revived = await runner.reviveSpin(spin.id);
      eq(revived.state, 'draft', 'a cancelled spin comes back as a draft');
      const fresh = await db.query(
        `SELECT state, commit_hash FROM arena_draws WHERE spin_id = $1 ORDER BY seq`, [spin.id]);
      ok(fresh.rows.length >= 1 && fresh.rows.every((d) => d.state === 'committed' && d.commit_hash),
        'with a FRESH committed seed on every wheel');
      await runner.openSpin(spin.id);
      await runner.lockSpin(spin.id);
      const started = await runner.startSpin(spin.id, 1, 'revive-proof');
      eq(started.state, 'spinning', 'and the wheel actually turns');
      // Pin the guard directly: a cancelled spin with a REVEALED wheel is
      // history and must refuse to come back (no timing dependence — the
      // reveal is stamped in SQL rather than waited for).
      await db.query(`UPDATE arena_draws SET state = 'revealed', revealed_at = now() WHERE spin_id = $1`, [spin.id]);
      await db.query(`UPDATE arena_spins SET state = 'cancelled' WHERE id = $1`, [spin.id]);
      let refusedRevealed = false;
      try { await runner.reviveSpin(spin.id); } catch (e2) { refusedRevealed = /already ran/.test(e2.message); }
      ok(refusedRevealed, 'a spin whose wheel has REVEALED can never be brought back');
    }

    console.log(`arena fixes (db): ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('  FAIL: threw -', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    try {
      for (const sid of sessions) {
        await db.query(`DELETE FROM arena_sessions WHERE id = $1`, [sid]);
      }
      if (made.length) await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [made]);
    } catch (_) { /* cleanup only */ }
    await db.pool.end().catch(() => {});
  }
})();

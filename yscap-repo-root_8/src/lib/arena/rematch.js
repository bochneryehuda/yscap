'use strict';
/**
 * THE REMATCH — the last two, head to head, one wheel.
 *
 * The owner's words: "a rematch spin — the last two standing, head to head, one
 * wheel." It is the shape every tournament ends on, and it is the moment the
 * whole room stops what it is doing and watches, which is exactly what the last
 * half-hour of a sales day needs.
 *
 * ── IT BUILDS NOTHING NEW ──────────────────────────────────────────────────
 * A duel is already a game the Arena knows how to run (`duel`, one wheel, two
 * names, `selected_staff`). Everything that makes a spin trustworthy — the seed
 * committed before the roster exists, the frozen list, the published
 * fingerprint, the held stop button, the proof panel afterwards — comes from
 * the ordinary machinery. This file adds exactly two things a duel did not have:
 *
 *   1. WHO THE LAST TWO ARE, worked out from the day so far, WITH THE REASON.
 *      A pair with no reason on it is a pair somebody will argue about, and the
 *      argument is the one thing that spoils the moment.
 *   2. WHO HOLDS THE STOP BUTTON — the CHALLENGER, never the person who is
 *      ahead. Handing it to the leader would make the last spin of the day look
 *      like the house pressing its own button.
 *
 * ── THE SUGGESTION IS A SUGGESTION ─────────────────────────────────────────
 * It NEVER picks the pair by itself. `suggestPair` reads the day and proposes
 * two names and says how it got there; a super admin can accept it or type any
 * other two. The reason a suggestion exists at all is that at half past five
 * nobody wants to scroll a list — not that the computer knows better than the
 * person running the day who the room wants to see.
 */

const db = require('../../db');
const runner = require('./spin-runner');

/**
 * Who the day says the last two are, and why.
 *
 * Three readings, in the order they are worth trusting, and each says which one
 * it used so the screen can print it:
 *
 *   'elimination'  a knock-out spin was run (`removeWinner: 'remove'`) and two
 *                  people are still standing. That IS "the last two standing",
 *                  literally, so nothing else is looked at.
 *   'winners'      the two most recent people to win anything today.
 *   'chances'      the top two on the chances board — the fallback for a day
 *                  where nothing has been won yet but people have been working.
 *
 * Never throws; an unreadable day comes back with no pair and says so.
 */
async function suggestPair(sessionId, { client = db } = {}) {
  const empty = (why) => ({ pair: [], basis: null, why });
  if (!sessionId) return empty('No session.');
  try {
    // ---- 1. a knock-out that is down to two --------------------------------
    const elim = await client.query(
      `SELECT s.id, s.title, s.config FROM arena_spins s
        WHERE s.session_id = $1 AND s.config->>'removeWinner' = 'remove'
        ORDER BY s.seq DESC LIMIT 1`, [sessionId]);
    if (elim.rows[0]) {
      const spin = elim.rows[0];
      const out = await client.query(
        `SELECT DISTINCT d.winner_staff_id AS id FROM arena_draws d
          WHERE d.spin_id = $1 AND d.state = 'revealed' AND d.winner_staff_id IS NOT NULL`, [spin.id]);
      const knockedOut = new Set(out.rows.map((r) => String(r.id)));
      const pool = await client.query(
        `SELECT s.id, s.full_name FROM arena_session_members m
           JOIN staff_users s ON s.id = m.staff_id
          WHERE m.session_id = $1 AND m.removed_at IS NULL AND s.is_active = true
            AND s.is_external IS NOT TRUE
          ORDER BY s.full_name`, [sessionId]);
      const left = pool.rows.filter((p) => !knockedOut.has(String(p.id)));
      if (left.length === 2) {
        return {
          pair: left.map(shape),
          basis: 'elimination',
          why: `The two still standing in "${spin.title}".`,
        };
      }
    }

    // ---- 2. the last two people to win anything -----------------------------
    const won = await client.query(
      `SELECT DISTINCT ON (a.staff_id) a.staff_id AS id, s.full_name, a.awarded_at
         FROM arena_awards a JOIN staff_users s ON s.id = a.staff_id
        WHERE a.session_id = $1
        ORDER BY a.staff_id, a.awarded_at DESC`, [sessionId]);
    const recent = won.rows.sort((a, b) => new Date(b.awarded_at) - new Date(a.awarded_at)).slice(0, 2);
    if (recent.length === 2) {
      return {
        pair: recent.map(shape),
        basis: 'winners',
        why: 'The last two people to win something today.',
      };
    }

    // ---- 3. the top two on chances ------------------------------------------
    const top = await client.query(
      `SELECT s.id, s.full_name, COALESCE(sum(t.count), 0)::int AS tickets
         FROM arena_tickets t JOIN staff_users s ON s.id = t.staff_id
        WHERE t.session_id = $1
        GROUP BY s.id, s.full_name
        HAVING COALESCE(sum(t.count), 0) > 0
        ORDER BY tickets DESC, s.full_name LIMIT 2`, [sessionId]);
    if (top.rows.length === 2) {
      return {
        pair: top.rows.map(shape),
        basis: 'chances',
        why: 'The two with the most chances today — nothing has been won yet.',
      };
    }
    return empty('Not enough has happened today to work out a pair. Pick the two yourself.');
  } catch (e) {
    return empty(`The day could not be read (${e.message}). Pick the two yourself.`);
  }
}

const shape = (r) => ({ id: String(r.id), name: r.full_name });

/**
 * Build the duel.
 *
 * `staffIds` is exactly two, and they must be two DIFFERENT active internal
 * people — a wheel with the same name on both slices is not a duel, it is a
 * formality with a stop button.
 *
 * `stopHolderStaffId` defaults to the SECOND name, which the suggestion orders
 * as the challenger (the leader is first). It is written straight onto the
 * wheel because `freezeRoster` only ever COALESCEs onto a holder that is
 * already there — so setting it now survives the freeze, and a duel needs no
 * earlier wheel to inherit a holder from.
 */
async function create({ sessionId, staffIds, title, subtitle, prizeLabel, stopHolderStaffId, createdBy, durationMs }) {
  const ids = [...new Set((staffIds || []).map(String).filter(Boolean))];
  if (ids.length !== 2) {
    throw new Error('A rematch needs exactly two different people on it.');
  }
  const who = await db.query(
    `SELECT id, full_name FROM staff_users
      WHERE id = ANY($1::uuid[]) AND is_active = true AND is_external IS NOT TRUE`, [ids]);
  if (who.rows.length !== 2) {
    throw new Error('Both people have to be on the team and still active.');
  }
  const byId = new Map(who.rows.map((r) => [String(r.id), r.full_name]));
  const names = ids.map((i) => byId.get(i));

  const holder = stopHolderStaffId && ids.includes(String(stopHolderStaffId))
    ? String(stopHolderStaffId)
    : ids[1];

  const spin = await runner.createSpin({
    sessionId,
    title: title || `Rematch — ${names[0]} v ${names[1]}`,
    subtitle: subtitle || (prizeLabel ? `Head to head for ${prizeLabel}` : 'Head to head. One wheel.'),
    kind: 'duel',
    config: {
      staffIds: ids,
      // A duel is short on purpose: the drama is the stop button, not the wait.
      durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : 4500,
      wheels: [{ source: 'selected_staff', title: prizeLabel ? `For ${prizeLabel}` : 'The duel' }],
      rematch: true,
    },
    createdBy,
  });

  // The challenger holds the button. Written before the wheel is ever frozen,
  // so the room is told who has it at the same moment it learns who is on it.
  await db.query(
    `UPDATE arena_draws SET stop_holder_staff_id = $2 WHERE spin_id = $1 AND seq = 1`, [spin.id, holder]);

  return {
    spin,
    pair: ids.map((i) => ({ id: i, name: byId.get(i) })),
    stopHolderStaffId: holder,
    stopHolderName: byId.get(holder),
  };
}

module.exports = { suggestPair, create };

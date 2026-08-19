'use strict';
/**
 * THE CHALLENGE ENGINE — the Mega Spin's day, from the schedule to the tickets.
 *
 * WHAT IT DOES, in the order the day does it:
 *   1. PLAN.     An admin picks a window and the engine lays out the whole day
 *                as rows in `arena_challenges`, so the super admin can see
 *                every challenge that is coming, change it, skip it, or drop
 *                their own in — "I should be able to see the entire time which
 *                challenge is going to populate the next time and I can change
 *                the setting."
 *   2. OPEN.     The minute sweep opens each one when its moment arrives and
 *                closes it when its window ends.
 *   3. FULFIL.   A person says they did it, with a note (always) and a
 *                screenshot (when the challenge asks for one).
 *   4. DECIDE.   A super admin approves or declines. Approval awards TICKETS.
 *   5. SPEND.    Five tickets buys the right to name something for the prize
 *                wheel. Bigger challenges unlock a bigger cap.
 *
 * ── THE THING THIS FILE EXISTS TO GET RIGHT ────────────────────────────────
 * A FIRST-PAST-THE-POST CHALLENGE MUST HAVE EXACTLY ONE WINNER, even when four
 * people press the button in the same second. The naive shape — count the
 * approved rows, and if there is room, insert — is a race that hands out two
 * slots under load, and the day it happens is the day everybody stops believing
 * the game. So the slot is claimed INSIDE a transaction that takes a lock on
 * the challenge row first: whoever gets the lock counts and claims, and
 * everybody behind them counts again and is told the truth. Postgres decides,
 * not the order requests happened to arrive.
 *
 * TICKETS ARE A LEDGER, NEVER A COUNTER. Rows add up to the answer, a mistake
 * is reversed by adding a negative row rather than editing history, and
 * "why do I have seven chances?" always has an answer. A unique index on
 * `entry_id` means one fulfilment can never pay out twice, however many times
 * an approve request is repeated.
 *
 * NOTHING HERE DECIDES WHO MAY DO ANY OF IT — that is the route's job.
 */

const db = require('../../db');
const lib = require('./challenge-library');

let broadcast = () => {};
function setBroadcaster(fn) { if (typeof fn === 'function') broadcast = fn; }

/**
 * Lay out a day of challenges as real rows.
 *
 * `replace: true` clears anything still SCHEDULED first (never anything that
 * has opened — a challenge people have already seen is part of the day and is
 * not silently rewritten under them).
 */
async function planDay(sessionId, spinId, opts = {}) {
  const plan = lib.planDay({
    from: opts.from, to: opts.to,
    targetGapMinutes: opts.targetGapMinutes, jitterMinutes: opts.jitterMinutes,
    seed: opts.seed, keys: opts.keys, windowMinutes: opts.windowMinutes,
  });
  if (!plan.length) return { created: 0, cleared: 0, plan: [] };

  const client = await db.getClient();
  let cleared = 0;
  try {
    await client.query('BEGIN');
    if (opts.replace) {
      const del = await client.query(
        `DELETE FROM arena_challenges WHERE session_id = $1 AND state = 'scheduled'`, [sessionId]);
      cleared = del.rowCount || 0;
    }
    const startSeq = (await client.query(
      `SELECT COALESCE(max(seq), 0) AS n FROM arena_challenges WHERE session_id = $1`, [sessionId])).rows[0].n;
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      await client.query(
        `INSERT INTO arena_challenges
           (session_id, spin_id, library_key, seq, title, prompt, detail, tier, proof_type,
            award_mode, slots, tickets_awarded, prize_cap_cents, opens_at, closes_at, state, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'scheduled',$16)`,
        [sessionId, spinId || null, p.libraryKey, Number(startSeq) + i + 1, p.title, p.prompt, p.detail,
          p.tier, p.proofType, p.awardMode, p.slots, p.ticketsAwarded, p.prizeCapCents,
          p.opensAt, p.closesAt, opts.createdBy || null]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* gone already */ }
    throw e;
  } finally {
    client.release();
  }
  broadcast('arena:challenge-plan', { sessionId, count: plan.length });
  return { created: plan.length, cleared, plan };
}

/**
 * Open every challenge whose moment has come, and close every one whose window
 * has ended. Called by the minute sweep. Never throws.
 *
 * A challenge whose moment passed while the process was down is opened LATE
 * rather than skipped, but only if its window has not already ended — an
 * opportunity somebody could still take is worth having; one that is already
 * over is noise.
 */
async function tick(now = new Date()) {
  const out = { opened: [], closed: [], errors: [] };
  try {
    const open = await db.query(
      `UPDATE arena_challenges
          SET state = 'live', updated_at = now()
        WHERE state = 'scheduled' AND opens_at IS NOT NULL AND opens_at <= $1
          AND (closes_at IS NULL OR closes_at > $1)
        RETURNING *`, [now]);
    out.opened = open.rows;
    for (const c of open.rows) broadcast('arena:challenge-open', publicChallenge(c));
  } catch (e) { out.errors.push(`open: ${e.message}`); }

  try {
    const shut = await db.query(
      `UPDATE arena_challenges
          SET state = 'closed', updated_at = now()
        WHERE state = 'live' AND closes_at IS NOT NULL AND closes_at <= $1
        RETURNING id, session_id, title`, [now]);
    out.closed = shut.rows;
    for (const c of shut.rows) broadcast('arena:challenge-close', { challengeId: c.id, sessionId: c.session_id });
  } catch (e) { out.errors.push(`close: ${e.message}`); }
  return out;
}

/** A challenge as everybody may see it. */
function publicChallenge(c, extra = {}) {
  return {
    id: c.id, sessionId: c.session_id, spinId: c.spin_id, seq: c.seq,
    title: c.title, prompt: c.prompt, detail: c.detail,
    tier: c.tier, tierLabel: (lib.TIER_BY_N[c.tier] || {}).label || null,
    proofType: c.proof_type, awardMode: c.award_mode, slots: c.slots,
    ticketsAwarded: c.tickets_awarded, prizeCapCents: c.prize_cap_cents,
    opensAt: c.opens_at, closesAt: c.closes_at, state: c.state,
    // Said on every card, because a person deciding whether to bother should
    // know a human reads it and nothing is measured automatically.
    proofNote: 'A super admin reads what you send and decides. Nothing here is measured automatically.',
    ...extra,
  };
}

/**
 * FULFIL. The claim, and the race.
 *
 * Returns `{ ok, entry }`, or `{ ok:false, reason, taken }` where `taken` says
 * the slot has gone — which is exactly the message the owner asked for:
 * "somebody shows this already ... somebody won this one already."
 */
async function fulfil({ challengeId, staffId, note, evidence, countValue }) {
  const text = String(note || '').trim();
  if (!text) return { ok: false, reason: 'Say what you did — a note is required.' };
  if (text.length > 2000) return { ok: false, reason: 'Keep it under 2000 characters.' };

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // THE LOCK. Everything below reads a consistent picture because this row is
    // held for the length of the transaction, so two people pressing at once
    // are serialised by the database rather than by luck.
    const cr = await client.query(`SELECT * FROM arena_challenges WHERE id = $1 FOR UPDATE`, [challengeId]);
    const ch = cr.rows[0];
    if (!ch) { await client.query('ROLLBACK'); return { ok: false, reason: 'That challenge does not exist.' }; }
    if (ch.state !== 'live') {
      await client.query('ROLLBACK');
      return { ok: false, reason: ch.state === 'closed' ? 'That one has closed.' : 'That one is not open yet.' };
    }
    if (ch.proof_type === 'upload' && !evidence) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'This one needs a screenshot or a photo.' };
    }

    // How many slots are already gone. A PENDING claim holds a place: somebody
    // who got there first must not lose it because an admin has not looked yet.
    const cap = ch.award_mode === 'everyone' ? null : Math.max(1, ch.slots);
    if (cap !== null) {
      const taken = await client.query(
        `SELECT count(*)::int AS n FROM arena_challenge_entries
          WHERE challenge_id = $1 AND status <> 'rejected' AND staff_id <> $2`, [challengeId, staffId]);
      if (taken.rows[0].n >= cap) {
        await client.query('ROLLBACK');
        return {
          ok: false, taken: true,
          reason: cap === 1
            ? 'Somebody got this one first. It has gone.'
            : `All ${cap} places on this one have gone.`,
        };
      }
    }

    const place = cap === null ? null : (await client.query(
      `SELECT count(*)::int AS n FROM arena_challenge_entries
        WHERE challenge_id = $1 AND status <> 'rejected'`, [challengeId])).rows[0].n + 1;

    const ins = await client.query(
      `INSERT INTO arena_challenge_entries
         (challenge_id, staff_id, note, evidence_ref, evidence_name, evidence_mime, evidence_bytes, count_value, place)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (challenge_id, staff_id) DO NOTHING
       RETURNING *`,
      [challengeId, staffId, text,
        (evidence && evidence.ref) || null, (evidence && evidence.name) || null,
        (evidence && evidence.mime) || null, (evidence && evidence.bytes) || null,
        Number.isFinite(Number(countValue)) ? Math.floor(Number(countValue)) : null, place]);
    if (!ins.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'You have already sent this one in.' };
    }
    await client.query('COMMIT');
    broadcast('arena:challenge-entry', { challengeId, sessionId: ch.session_id, staffId: String(staffId), place });
    return { ok: true, entry: ins.rows[0], challenge: ch, place };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* gone already */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * DECIDE. Approving awards the tickets, once and only once.
 *
 * The ticket insert is guarded by a unique index on `entry_id`, so approving
 * the same fulfilment twice — a double click, a retried request, two admins —
 * writes one ticket row, not two.
 */
async function decide({ entryId, status, byStaffId, reason }) {
  if (!['approved', 'rejected'].includes(status)) return { ok: false, reason: 'Approved or rejected.' };
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const er = await client.query(
      `SELECT e.*, c.session_id, c.spin_id, c.tickets_awarded, c.title, c.tier
         FROM arena_challenge_entries e JOIN arena_challenges c ON c.id = e.challenge_id
        WHERE e.id = $1 FOR UPDATE OF e`, [entryId]);
    const e = er.rows[0];
    if (!e) { await client.query('ROLLBACK'); return { ok: false, reason: 'That does not exist.' }; }

    const tickets = status === 'approved' ? Math.max(0, Number(e.tickets_awarded) || 0) : 0;
    await client.query(
      `UPDATE arena_challenge_entries
          SET status = $2, decided_by = $3, decided_at = now(), decline_reason = $4, tickets_awarded = $5
        WHERE id = $1`,
      [entryId, status, byStaffId || null, status === 'rejected' ? (reason || null) : null, tickets]);

    if (status === 'approved' && tickets > 0) {
      await client.query(
        `INSERT INTO arena_tickets (session_id, spin_id, staff_id, challenge_id, entry_id, count, source, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'challenge',$7,$8)
         ON CONFLICT (entry_id) WHERE entry_id IS NOT NULL AND source = 'challenge' DO NOTHING`,
        [e.session_id, e.spin_id, e.staff_id, e.challenge_id, e.id, tickets, e.title, byStaffId || null]);
    } else if (status === 'rejected') {
      // Take back anything already given for this fulfilment, by adding the
      // opposite rather than deleting — the ledger keeps its history.
      const had = await client.query(
        `SELECT COALESCE(sum(count), 0)::int AS n FROM arena_tickets WHERE entry_id = $1`, [entryId]);
      const n = Number(had.rows[0].n) || 0;
      if (n !== 0) {
        await client.query(
          `INSERT INTO arena_tickets (session_id, spin_id, staff_id, challenge_id, count, source, reason, created_by)
           VALUES ($1,$2,$3,$4,$5,'reversal',$6,$7)`,
          [e.session_id, e.spin_id, e.staff_id, e.challenge_id, -n, `Reversed: ${e.title}`, byStaffId || null]);
      }
    }
    await client.query('COMMIT');
    broadcast('arena:challenge-decided', {
      challengeId: e.challenge_id, sessionId: e.session_id, staffId: String(e.staff_id), status, tickets,
    });
    return { ok: true, tickets, entry: { ...e, status } };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* gone already */ }
    throw err;
  } finally {
    client.release();
  }
}

/** How many chances somebody has, and what that has bought them. */
async function standingFor(sessionId, staffId) {
  const t = await db.query(
    `SELECT COALESCE(sum(count), 0)::int AS tickets FROM arena_tickets
      WHERE session_id = $1 AND staff_id = $2`, [sessionId, staffId]);
  const used = await db.query(
    `SELECT count(*)::int AS n FROM arena_entries e
       JOIN arena_spins s ON s.id = e.spin_id
      WHERE s.session_id = $1 AND e.staff_id = $2 AND e.unlocked_by_tickets IS NOT NULL
        AND e.status <> 'rejected'`, [sessionId, staffId]);
  const tiers = await db.query(
    `SELECT DISTINCT c.tier FROM arena_challenge_entries e
       JOIN arena_challenges c ON c.id = e.challenge_id
      WHERE c.session_id = $1 AND e.staff_id = $2 AND e.status = 'approved'`, [sessionId, staffId]);
  const n = lib.nominationsEarned(t.rows[0].tickets, used.rows[0].n);
  return { ...n, prizeCapCents: lib.prizeCapFor(tiers.rows.map((r) => r.tier)), tiersWon: tiers.rows.map((r) => r.tier) };
}

/**
 * THE BOARD, as everybody sees it: what is live, what is coming, and where
 * each person stands.
 *
 * WHAT IS DELIBERATELY NOT HERE: a full ranking with everybody's position. The
 * research on sales leaderboards is consistent that publishing the bottom of a
 * list makes the people on it stop trying, and this game's whole point is that
 * the middle of the team stays in it. So the board shows the TOP few and YOUR
 * OWN standing — never "you are 14th of 16".
 */
async function boardFor(sessionId, staffId, { isSuperAdmin = false, now = new Date() } = {}) {
  const live = await db.query(
    `SELECT * FROM arena_challenges WHERE session_id = $1 AND state = 'live' ORDER BY opens_at`, [sessionId]);
  const upcoming = await db.query(
    `SELECT * FROM arena_challenges WHERE session_id = $1 AND state = 'scheduled'
      ORDER BY opens_at LIMIT $2`, [sessionId, isSuperAdmin ? 60 : 1]);
  const ids = [...live.rows, ...upcoming.rows].map((c) => c.id);
  const entries = ids.length
    ? (await db.query(
      `SELECT e.*, s.full_name FROM arena_challenge_entries e JOIN staff_users s ON s.id = e.staff_id
        WHERE e.challenge_id = ANY($1::uuid[]) ORDER BY e.created_at`, [ids])).rows : [];

  const mine = String(staffId);
  const shape = (c) => {
    const es = entries.filter((e) => String(e.challenge_id) === String(c.id));
    const taken = es.filter((e) => e.status !== 'rejected').length;
    const cap = c.award_mode === 'everyone' ? null : Math.max(1, c.slots);
    return publicChallenge(c, {
      mine: es.find((e) => String(e.staff_id) === mine) || null,
      takenCount: taken,
      slotsLeft: cap === null ? null : Math.max(0, cap - taken),
      // The exact sentence the owner asked for.
      goneMessage: cap !== null && taken >= cap
        ? (cap === 1 ? 'Somebody got this one first.' : `All ${cap} places have gone.`) : null,
      // Everybody sees who is in; only a super admin sees what they wrote,
      // because a note can name a borrower and this is a game screen.
      entries: isSuperAdmin ? es : es.map((e) => ({
        id: e.id, staff_id: e.staff_id, full_name: e.full_name, status: e.status, place: e.place,
      })),
    });
  };

  // The top of the board only. See the note above.
  const top = await db.query(
    `SELECT s.id, s.full_name, COALESCE(sum(t.count), 0)::int AS tickets
       FROM arena_tickets t JOIN staff_users s ON s.id = t.staff_id
      WHERE t.session_id = $1
      GROUP BY s.id, s.full_name
      HAVING COALESCE(sum(t.count), 0) > 0
      ORDER BY tickets DESC, s.full_name LIMIT 5`, [sessionId]);

  return {
    live: live.rows.map(shape),
    upcoming: upcoming.rows.map(shape),
    nextAt: upcoming.rows[0] ? upcoming.rows[0].opens_at : null,
    top: top.rows,
    me: await standingFor(sessionId, staffId),
    serverNow: now.toISOString(),
    tiers: lib.TIERS,
    ticketsPerNomination: lib.TICKETS_PER_NOMINATION,
  };
}

/** Every ticket somebody has, and what each one was for. */
async function ledgerFor(sessionId, staffId) {
  const r = await db.query(
    `SELECT t.count, t.source, t.reason, t.created_at, c.title, c.tier
       FROM arena_tickets t LEFT JOIN arena_challenges c ON c.id = t.challenge_id
      WHERE t.session_id = $1 AND t.staff_id = $2 ORDER BY t.created_at DESC`, [sessionId, staffId]);
  return r.rows;
}

module.exports = {
  setBroadcaster, planDay, tick, fulfil, decide,
  standingFor, boardFor, ledgerFor, publicChallenge,
};

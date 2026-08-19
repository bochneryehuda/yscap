'use strict';
/**
 * TELLING PEOPLE WHAT HAPPENED — the results, by email and in the bell.
 *
 * WHY THIS FILE EXISTS. The owner asked for "notifications when the spin
 * happens, who won on each and every draw, and the final nice notifications for
 * everybody that is involved in the game by email". The first build broadcast
 * the result over the live stream and stopped there — which is fine for the
 * thirty people watching the wheel, and completely silent for the person who
 * was on a call and won.
 *
 * TWO DIFFERENT MESSAGES, deliberately, because two different things happened:
 *   - THE WINNER gets a message addressed to them. They won; they should be
 *     told so directly, not have to spot their own name in a round-up.
 *   - EVERYBODY ELSE gets the result. Short, no cheerleading — they were
 *     watching, or they will read it later.
 *
 * IT SENDS ONCE, EVER. A spin can be settled more than once — the reveal timer
 * and the sweep can both call it, and a restart can replay it. So the send is
 * CLAIMED first, in `arena_notices`, by the same unique index the deadline
 * alarms use: the insert either inserts or it does not, and only the caller who
 * actually inserted sends anything. Postgres decides, not a flag in memory.
 * Emailing the whole company their results twice is the kind of thing people
 * remember about a game.
 *
 * IT NEVER THROWS. A result that cannot be emailed is still a result: the award
 * is already written and the board already shows it. A failure here logs and is
 * dropped rather than being allowed to take down the draw that produced it.
 *
 * STAFF ONLY, like everything else in the Arena. `audienceFor` reads the
 * session roster and excludes external users; a borrower or a broker can never
 * be a recipient.
 */

const db = require('../../db');
const notify = require('../notify');
const settings = require('./settings');

/** Money, the way a person writes it. */
function money(cents) {
  const n = Number(cents) || 0;
  if (!n) return '';
  return n % 100 === 0
    ? `$${(n / 100).toLocaleString('en-US')}`
    : `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Everyone in a session: the picked roster, or the whole internal team when
 * nobody was picked. External users (brokers) are excluded in SQL, not by a
 * check somebody has to remember.
 */
async function audienceFor(sessionId) {
  const m = await db.query(
    `SELECT s.id FROM arena_session_members m JOIN staff_users s ON s.id = m.staff_id
      WHERE m.session_id = $1 AND m.removed_at IS NULL
        AND s.is_active = true AND s.is_external IS NOT TRUE`, [sessionId]);
  if (m.rows.length) return m.rows.map((r) => r.id);
  const all = await db.query(
    `SELECT id FROM staff_users WHERE is_active = true AND is_external IS NOT TRUE`);
  return all.rows.map((r) => r.id);
}

/**
 * Claim the right to send one thing, once.
 *
 * Returns true only for the caller whose insert actually inserted a row.
 * Everybody else — a retry, a second process, the sweep arriving late — gets
 * false and sends nothing.
 */
async function claim(spinId, kind) {
  try {
    const r = await db.query(
      `INSERT INTO arena_notices (spin_id, kind, offset_minutes) VALUES ($1,$2,0)
       ON CONFLICT (spin_id, kind, offset_minutes) DO NOTHING RETURNING id`,
      [spinId, kind]);
    return !!r.rows[0];
  } catch (e) {
    // Fail CLOSED: if the claim cannot be made, do not send. An unsent result
    // is a disappointment; a duplicate result to the whole company is a
    // problem, and this is the only thing standing between the two.
    console.warn(`[arena] could not claim the "${kind}" send for spin ${spinId}, so nothing was sent: ${e.message}`);
    return false;
  }
}

/**
 * A SPIN HAS BEEN DECIDED. Tell the winner, then tell everybody else.
 *
 * @param {object} spin     the arena_spins row
 * @param {object} outcome  { staffId, personLabel, prizeLabel, prizeValue, reason }
 * @returns {{sent:number, skipped:string|null}} what actually happened
 */
/**
 * IS THE GAME EVEN ON? Every announcement asks this first.
 *
 * The master switch promises the Arena is "indistinguishable from a feature
 * that was never built". A wheel that was already turning when somebody flips
 * it off is still SETTLED a minute later by the sweep — which is right, because
 * leaving a draw stuck mid-spin would be worse — but announcing it is not: the
 * company would be emailed about a game that, by that promise, does not exist.
 * And the moment somebody reaches for that switch is precisely the moment they
 * least want a company-wide message going out.
 *
 * Settling and announcing are two different things, and only the second one is
 * silenced. Reproduced against a real database before it was fixed: with the
 * Arena off, a decided spin still wrote everybody a "you won" / "the result is
 * in" notification.
 *
 * FAILS TOWARDS SILENCE. If the switch cannot be read we say nothing, because
 * an unsent result is a disappointment and a result nobody expected is a
 * problem — the same direction `claim()` fails in.
 */
async function announcementsAllowed() {
  try {
    const cfg = await settings.load();
    if (!cfg.enabled) return { ok: false, cfg: null, reason: 'the Arena is switched off' };
    return { ok: true, cfg, reason: null };
  } catch (e) {
    return { ok: false, cfg: null, reason: `settings unreadable: ${e.message}` };
  }
}

async function spinDecided(spin, outcome) {
  if (!spin || !outcome) return { sent: 0, skipped: 'nothing to announce' };
  const on = await announcementsAllowed();
  if (!on.ok) return { sent: 0, skipped: on.reason };
  const cfg = on.cfg;
  if (cfg.settings.emailResults === false) return { sent: 0, skipped: 'results notifications are switched off' };

  if (!(await claim(spin.id, 'result'))) return { sent: 0, skipped: 'already announced' };

  const prize = outcome.prizeLabel || spin.title;
  const worth = money(outcome.prizeValue);
  // A BOOBY PRIZE IS DELIVERED AS THE JOKE IT IS. The ordinary wording would
  // read "You won: A firm handshake. It is worth $0." — which lands as a system
  // error rather than a gag, and it is somebody's inbox. So the follow-through
  // line carries it, and nothing anywhere says what it is worth.
  const joke = outcome.joke === true;
  let sent = 0;

  // ── the winner ──────────────────────────────────────────────────────────
  if (outcome.staffId) {
    try {
      await notify.notifyStaff(outcome.staffId, {
        type: 'arena_you_won',
        title: joke ? `The wheel says: ${prize}` : `You won: ${prize}`,
        body: joke
          ? [
            `Spin ${spin.seq} — "${spin.title}" — landed on you, and it landed on ${prize}.`,
            outcome.jokeDetail || '',
            'The whole room saw it, and anybody can check the wheel for themselves.',
          ].filter(Boolean).join(' ')
          : [
            `Spin ${spin.seq} — "${spin.title}" — just landed on you.`,
            worth ? `It is worth ${worth}.` : '',
            'Open the Arena to see the wheel and check the draw for yourself.',
          ].filter(Boolean).join(' '),
        link: '/internal/arena',
        ctaLabel: 'See it',
      });
      sent++;
    } catch (e) {
      // The award is already written and on the board. Say so plainly rather
      // than pretending the message went.
      console.warn(`[arena] could not tell ${outcome.staffId} they won spin ${spin.id}: ${e.message}`);
    }
  }

  // ── everybody else ──────────────────────────────────────────────────────
  try {
    const people = await audienceFor(spin.session_id);
    const winner = outcome.personLabel || 'Nobody';
    for (const id of people) {
      if (outcome.staffId && String(id) === String(outcome.staffId)) continue;   // already told, personally
      await notify.notifyStaff(id, {
        type: 'arena_result',
        title: joke
          ? `Spin ${spin.seq}: the wheel gave ${winner} ${prize}`
          : `Spin ${spin.seq}: ${winner} won ${prize}`,
        body: outcome.reason
          ? `${outcome.reason}. Anybody can check the draw for themselves in the Arena.`
          : 'Anybody can check the draw for themselves in the Arena.',
        link: '/internal/arena',
        ctaLabel: 'See the board',
      }).catch(() => {});
      sent++;
    }
  } catch (e) {
    console.warn(`[arena] could not send the result of spin ${spin.id} to the room: ${e.message}`);
  }

  return { sent, skipped: null };
}

/**
 * A SESSION HAS CLOSED. One round-up: everything won, all day, in one message.
 *
 * The owner asked for "the final nice notifications for everybody that is
 * involved in the game by email" — this is that one.
 */
async function sessionClosed(session) {
  if (!session) return { sent: 0, skipped: 'nothing to announce' };
  const on = await announcementsAllowed();
  if (!on.ok) return { sent: 0, skipped: on.reason };
  const cfg = on.cfg;
  if (cfg.settings.emailResults === false) return { sent: 0, skipped: 'results notifications are switched off' };

  // Claimed on the session's own row rather than a spin's, using a synthetic
  // key so it cannot collide with a spin's claims.
  try {
    const r = await db.query(
      `INSERT INTO arena_notices (spin_id, kind, offset_minutes)
       SELECT id, 'session_wrap', 0 FROM arena_spins WHERE session_id = $1 ORDER BY seq LIMIT 1
       ON CONFLICT (spin_id, kind, offset_minutes) DO NOTHING RETURNING id`, [session.id]);
    if (!r.rows[0]) return { sent: 0, skipped: 'already wrapped up (or the session had no spins)' };
  } catch (e) {
    console.warn(`[arena] could not claim the wrap-up for session ${session.id}: ${e.message}`);
    return { sent: 0, skipped: 'claim failed' };
  }

  let lines = [];
  try {
    const r = await db.query(
      `SELECT s.full_name, a.prize_label, a.value_cents, p.seq
         FROM arena_awards a
         JOIN staff_users s ON s.id = a.staff_id
         JOIN arena_spins  p ON p.id = a.spin_id
        WHERE a.session_id = $1 ORDER BY p.seq`, [session.id]);
    lines = r.rows.map((x) => {
      const w = money(x.value_cents);
      return `Spin ${x.seq}: ${x.full_name} won ${x.prize_label}${w ? ` (${w})` : ''}`;
    });
  } catch (e) {
    console.warn(`[arena] could not read the results of session ${session.id}: ${e.message}`);
  }

  const body = lines.length
    ? `${lines.join('. ')}. Every draw is still on the board, and anybody can check any of them.`
    : 'Nothing was won this time. Every spin is still on the board.';

  let sent = 0;
  try {
    for (const id of await audienceFor(session.id)) {
      await notify.notifyStaff(id, {
        type: 'arena_session_wrap',
        title: `${session.name} — that is a wrap`,
        body,
        link: '/internal/arena',
        ctaLabel: 'See every spin',
      }).catch(() => {});
      sent++;
    }
  } catch (e) {
    console.warn(`[arena] could not send the wrap-up for session ${session.id}: ${e.message}`);
  }
  return { sent, skipped: null };
}

/**
 * A CHALLENGE HAS LANDED.
 *
 * IN-APP ONLY, AND ENFORCED WHERE THAT RULE LIVES. About twenty of these land
 * across an afternoon. Emailing every one would be the fastest possible way to
 * make the team filter the whole game into a folder, and the people this is for
 * are on the phone all day. So a challenge produces a bell notification — which
 * is what the owner asked for, "get a notification whenever there is new stuff
 * available for them to go in and fill it in" — and never an email. The rule is
 * stated ONCE, as `arena_challenge` in notify.js's STAFF_INAPP_TYPES, rather
 * than as a flag passed from here: a second sender of this type must inherit it,
 * and a comment is not a guard. The emails stay for the handful of moments that
 * are worth an interruption: a spin opening, a deadline running out, and a
 * result.
 *
 * It also skips anybody who has already sent that challenge in, because telling
 * somebody about a thing they have already done is exactly the noise that makes
 * people stop reading the useful ones.
 */
async function challengeLanded(challenge) {
  if (!challenge || !challenge.session_id) return { sent: 0, skipped: 'nothing to announce' };
  const on = await announcementsAllowed();
  if (!on.ok) return { sent: 0, skipped: on.reason };
  const cfg = on.cfg;
  if (cfg.settings.challengeAlerts === false) return { sent: 0, skipped: 'challenge alerts are switched off' };

  let sent = 0;
  try {
    const done = await db.query(
      `SELECT staff_id FROM arena_challenge_entries WHERE challenge_id = $1`, [challenge.id]);
    const already = new Set(done.rows.map((r) => String(r.staff_id)));
    for (const id of await audienceFor(challenge.session_id)) {
      if (already.has(String(id))) continue;
      await notify.notifyStaff(id, {
        type: 'arena_challenge',
        title: `New challenge: ${challenge.title}`,
        body: `${challenge.prompt} Worth ${challenge.tickets_awarded} `
          + `${Number(challenge.tickets_awarded) === 1 ? 'chance' : 'chances'} in the draw.`,
        link: '/internal/arena',
        ctaLabel: 'Take it on',
      }).catch(() => {});
      sent++;
    }
  } catch (e) {
    console.warn(`[arena] could not announce challenge ${challenge.id}: ${e.message}`);
  }
  return { sent, skipped: null };
}

module.exports = { spinDecided, sessionClosed, challengeLanded, audienceFor, money, claim };

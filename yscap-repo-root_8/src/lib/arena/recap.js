'use strict';
/**
 * THE RECAP CARD — what one person did all day, in a shape worth screenshotting.
 *
 * The owner's words: "an end-of-day recap card each person can screenshot: what
 * they did, what they won, where they finished." So it is deliberately about
 * ONE person and it is deliberately PRIVATE — everybody gets their own, nobody
 * gets anybody else's.
 *
 * ── ONE DECISION WORTH SAYING OUT LOUD: THE POSITION ───────────────────────
 * Everywhere else in the Arena, the standing rule is that the bottom of a
 * leaderboard is never published — the research on sales leaderboards is
 * consistent that showing somebody they are last is what makes them stop
 * trying, which is the opposite of what this game is for. So the live board
 * shows the top few and your own chances, and never "you are 14th of 16".
 *
 * The recap DOES tell a person their position, because the owner asked for it
 * and because this card is a different thing: it is PRIVATE (only they can open
 * their own), it is at the END of the day when there is nothing left to
 * discourage them out of, and a card that skips the number for exactly the
 * people who came last would be transparently doing so. What it never does is
 * publish anybody's position TO ANYBODY ELSE — `for()` answers only for the
 * person asking, and the super admin's monitor is the one screen that shows the
 * full list, to the one person who has to nudge people.
 *
 * The wording around the number does the work instead: it leads with what they
 * DID, which is the part they control.
 *
 * ── IT IS READ-ONLY AND IT NEVER THROWS ────────────────────────────────────
 * Every block is its own query and its own catch, so a card missing one line is
 * a card missing one line, not a screen that will not open on the afternoon of
 * the event.
 */

// Lazy, like streaks.js: the wording and the arithmetic below are the half most
// worth unit-testing, and requiring src/db at load time fails loudly with no
// DATABASE_URL in reach.
let _db = null;
const db = () => (_db || (_db = require('../../db')));
const streaks = require('./streaks');

const money = (cents) => {
  const n = Number(cents) || 0;
  if (!n) return null;
  return n % 100 === 0
    ? `$${(n / 100).toLocaleString('en-US')}`
    : `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Everyone's chances, biggest first — the list a position is read off. */
async function standings(sessionId, client = null) {
  const r = await (client || db()).query(
    `SELECT s.id, s.full_name, COALESCE(sum(t.count), 0)::int AS tickets
       FROM staff_users s
       LEFT JOIN arena_tickets t ON t.staff_id = s.id AND t.session_id = $1
      WHERE s.id IN (SELECT staff_id FROM arena_session_members WHERE session_id = $1 AND removed_at IS NULL)
         OR t.id IS NOT NULL
      GROUP BY s.id, s.full_name
      ORDER BY tickets DESC, s.full_name`, [sessionId]);
  return r.rows;
}

/**
 * One person's day.
 *
 * @param {string} sessionId
 * @param {string} staffId    whose card this is — ALWAYS the person asking
 */
async function forPerson(sessionId, staffId) {
  const out = {
    session: null,
    person: null,
    checkins: { total: 0, onTime: 0 },
    challenges: { sent: 0, approved: 0, declined: 0, waiting: 0, first: 0 },
    streak: { best: 0, completed: 0, bonusTickets: 0 },
    chances: { total: 0, fromChallenges: 0, fromStreaks: 0, byHand: 0 },
    prizes: [],
    prizeValue: null,
    position: null,
    outOf: 0,
    headline: null,
    lines: [],
    generatedAt: new Date().toISOString(),
  };
  if (!sessionId || !staffId) return out;

  try {
    const s = await db().query(
      `SELECT id, name, state, opened_at, closed_at FROM arena_sessions WHERE id = $1`, [sessionId]);
    out.session = s.rows[0] || null;
  } catch (_) { /* the card still opens */ }
  try {
    const p = await db().query(`SELECT id, full_name, title FROM staff_users WHERE id = $1`, [staffId]);
    out.person = p.rows[0] ? { id: String(p.rows[0].id), name: p.rows[0].full_name, title: p.rows[0].title } : null;
  } catch (_) { /* ditto */ }

  try {
    const c = await db().query(
      `SELECT c.status FROM arena_checkins c JOIN arena_spins p ON p.id = c.spin_id
        WHERE p.session_id = $1 AND c.staff_id = $2`, [sessionId, staffId]);
    out.checkins.total = c.rows.length;
    out.checkins.onTime = c.rows.filter((r) => r.status === 'approved').length;
  } catch (_) { /* ditto */ }

  try {
    const e = await db().query(
      `SELECT e.status, e.place FROM arena_challenge_entries e
         JOIN arena_challenges ch ON ch.id = e.challenge_id
        WHERE ch.session_id = $1 AND e.staff_id = $2`, [sessionId, staffId]);
    out.challenges.sent = e.rows.length;
    out.challenges.approved = e.rows.filter((r) => r.status === 'approved').length;
    out.challenges.declined = e.rows.filter((r) => r.status === 'rejected').length;
    out.challenges.waiting = e.rows.filter((r) => r.status === 'pending').length;
    // "First to it" is worth its own line — it is the thing people talk about
    // afterwards, and it is the one number on this card that is about SPEED.
    out.challenges.first = e.rows.filter((r) => Number(r.place) === 1 && r.status !== 'rejected').length;
  } catch (_) { /* ditto */ }

  try {
    const st = await streaks.standingFor(sessionId, staffId);
    out.streak = { best: st.best, completed: st.completed, bonusTickets: st.bonusTickets, length: st.length };
  } catch (_) { /* ditto */ }

  try {
    const t = await db().query(
      `SELECT source, COALESCE(sum(count), 0)::int AS n FROM arena_tickets
        WHERE session_id = $1 AND staff_id = $2 GROUP BY source`, [sessionId, staffId]);
    const by = Object.fromEntries(t.rows.map((r) => [r.source, Number(r.n) || 0]));
    // A reversal is a negative row, so summing every source IS the true total —
    // it is not the positives with the take-backs quietly left out.
    out.chances.total = t.rows.reduce((a, r) => a + (Number(r.n) || 0), 0);
    out.chances.fromChallenges = (by.challenge || 0) + (by.reversal || 0);
    out.chances.fromStreaks = by.bonus || 0;
    out.chances.byHand = by.manual || 0;
  } catch (_) { /* ditto */ }

  try {
    const a = await db().query(
      `SELECT a.prize_label, a.prize_kind, a.value_cents, a.awarded_at, p.seq, p.title AS spin_title
         FROM arena_awards a JOIN arena_spins p ON p.id = a.spin_id
        WHERE a.session_id = $1 AND a.staff_id = $2 ORDER BY a.awarded_at`, [sessionId, staffId]);
    out.prizes = a.rows.map((r) => ({
      label: r.prize_label, kind: r.prize_kind, value: money(r.value_cents),
      valueCents: Number(r.value_cents) || 0, spinSeq: r.seq, spinTitle: r.spin_title, at: r.awarded_at,
    }));
    const total = a.rows.reduce((x, r) => x + (Number(r.value_cents) || 0), 0);
    out.prizeValue = money(total);
  } catch (_) { /* ditto */ }

  try {
    const rows = await standings(sessionId);
    out.outOf = rows.length;
    const i = rows.findIndex((r) => String(r.id) === String(staffId));
    // Only somebody who actually took part gets a position. A person on the
    // roster who never checked in and never sent anything in is not "last" —
    // they were not playing, and saying otherwise would be the one wrong number
    // on the card.
    const played = out.checkins.total > 0 || out.challenges.sent > 0 || out.chances.total !== 0 || out.prizes.length > 0;
    out.position = i >= 0 && played ? i + 1 : null;
  } catch (_) { /* ditto */ }

  out.headline = headlineFor(out);
  out.lines = linesFor(out);
  return out;
}

/** The big line at the top. What they DID, never what they are not. */
function headlineFor(r) {
  if (r.prizes.length === 1) return `You won ${r.prizes[0].label}.`;
  if (r.prizes.length > 1) return `You won ${r.prizes.length} things today.`;
  if (r.streak.best >= (r.streak.length || 3)) return `You put ${r.streak.best} together in a row.`;
  if (r.challenges.approved > 0) {
    return r.challenges.approved === 1
      ? 'You took on a challenge today.'
      : `You took on ${r.challenges.approved} challenges today.`;
  }
  if (r.checkins.onTime > 0) return 'You were in on time.';
  return 'That was Elementix Day.';
}

/** The body of the card — only lines that are TRUE and worth reading. */
function linesFor(r) {
  const out = [];
  if (r.checkins.onTime > 0) {
    out.push({ label: 'In on time', value: `${r.checkins.onTime}${r.checkins.total > r.checkins.onTime ? ` of ${r.checkins.total}` : ''}` });
  }
  if (r.challenges.sent > 0) {
    out.push({ label: 'Challenges sent in', value: String(r.challenges.sent) });
    if (r.challenges.approved > 0) out.push({ label: 'Signed off', value: String(r.challenges.approved) });
    if (r.challenges.first > 0) {
      out.push({ label: 'First to it', value: r.challenges.first === 1 ? 'once' : `${r.challenges.first} times` });
    }
  }
  if (r.streak.best > 0) {
    out.push({ label: 'Best run', value: `${r.streak.best} in a row` });
  }
  if (r.streak.bonusTickets > 0) {
    out.push({ label: 'Bonus chances from streaks', value: `+${r.streak.bonusTickets}` });
  }
  if (r.chances.total !== 0) out.push({ label: 'Chances in the draw', value: String(r.chances.total) });
  if (r.prizeValue) out.push({ label: 'Worth', value: r.prizeValue });
  if (r.position) out.push({ label: 'Where you finished', value: `${ordinal(r.position)} of ${r.outOf}` });
  return out;
}

function ordinal(n) {
  const i = Math.floor(Number(n) || 0);
  const s = ['th', 'st', 'nd', 'rd'];
  const v = i % 100;
  return `${i}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

module.exports = { forPerson, standings, headlineFor, linesFor, ordinal, money };

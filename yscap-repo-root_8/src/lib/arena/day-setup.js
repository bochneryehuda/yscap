'use strict';
/**
 * SET THE WHOLE DAY UP IN ONE PRESS — the session and both ready-made plans,
 * as a DRAFT, so the morning is one button rather than a form.
 *
 * THE GAP THIS CLOSES, in the owner's own words: "under Sessions I don't see
 * anything. I need to type in something, then I can go back … pre-fill the
 * sessions with all the settings, I can just click Start even before, so I have
 * more control."
 *
 * They are describing a real chicken-and-egg, not a preference. Today the two
 * ready-made plans can only be loaded into a session that is already LIVE (the
 * control room renders that panel off the live board), so the day cannot be
 * prepared the night before at all: you go live first and assemble it in front
 * of everybody. This module inverts that — the day is built as a draft, sat
 * there to be read and adjusted, and STARTING it is the single act.
 *
 * ── WHY ONE SESSION HOLDS BOTH, AND WHY THAT IS NOT A CHOICE ───────────────
 * The owner calls them two sessions. In this engine a SESSION is the day and a
 * SPIN is an event inside it, and db/585 carries `arena_sessions_one_live_idx`
 * — AT MOST ONE LIVE SESSION AT A TIME. So two separate sessions could never
 * both be running, and the Mega Spin (11:38 → six) overlaps the Early Bird's
 * own morning entirely. Splitting them would also split the room, the chat, the
 * leaderboard, the recap and the ticket ledger in half, and a person would
 * clock in twice. So: one day, "Elementix Day", holding the two events the
 * owner named. Nothing about what either event DOES changes.
 *
 * ── IT IS SAFE TO PRESS TWICE, AND THAT IS THE DATABASE'S JOB ─────────────
 * A button gets pressed twice — an impatient hand, a double-submitting browser,
 * two admins at once. Reading "is this day already set up?" and then inserting
 * is the exact race db/401 had to close on the conditions engine: both readers
 * see nothing, both insert. So db/592 puts a UNIQUE index on the day and on
 * (session, template), and this module ASKS THE DATABASE by attempting the
 * write and adopting what is already there when it is refused (23505). Pressing
 * it a second time reports what already existed and changes nothing.
 *
 * That also makes it self-repairing: a day whose session exists but whose Mega
 * Spin failed to build gets the missing half added on the next press, rather
 * than needing somebody to work out which piece is absent.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * It never puts the day LIVE. Going live opens the doors, starts the clock and
 * begins mailing the team, and the owner asked for the opposite — to hold it,
 * read it, adjust it, and press Start themselves. It never mails anybody. It
 * never touches a borrower, a file or a loan; the Arena is a staff game and the
 * only identity it reads is the shared roster.
 */

const db = require('../../db');
const templates = require('./templates');
const runner = require('./spin-runner');
const challenges = require('./challenges');

/** The plans a day is made of, in the order they run. */
const DAY_TEMPLATES = ['early_bird', 'mega_spin'];

const DEFAULT_NAME = 'Elementix Day';
const DEFAULT_SUBTITLE = 'Dial day — clock in, take challenges, win things.';

/** A duplicate-key refusal from Postgres, whatever raised it. */
function isDuplicate(e) { return !!(e && String(e.code) === '23505'); }

/** 'YYYY-MM-DD', and a real one. */
function dayProblem(day) {
  const s = String(day || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'Which day is this for? Send it as YYYY-MM-DD.';
  const [Y, M, D] = s.split('-').map((x) => parseInt(x, 10));
  const probe = new Date(Date.UTC(Y, M - 1, D));
  if (probe.getUTCFullYear() !== Y || probe.getUTCMonth() !== M - 1 || probe.getUTCDate() !== D) {
    return 'That is not a real date.';
  }
  return null;
}

/**
 * The session for this day, made if it is not there yet.
 *
 * Returns `{ session, created }`. The insert is attempted FIRST and the refusal
 * is what tells us somebody else got there — never a read followed by a write.
 */
async function ensureSession(day, { name, subtitle, offsetMinutes, createdBy }) {
  // The day's own instants come from the plans themselves rather than being
  // restated here, so the session's window can never drift from the events it
  // holds. First plan's opening, last plan's closing.
  const first = templates.buildTemplate(DAY_TEMPLATES[0], { day, offsetMinutes });
  const last = templates.buildTemplate(DAY_TEMPLATES[DAY_TEMPLATES.length - 1], { day, offsetMinutes });
  const startsAt = first ? first.launchAt : null;
  const endsAt = last ? last.entryDeadlineAt : null;

  try {
    const r = await db.query(
      `INSERT INTO arena_sessions (name, subtitle, theme, starts_at, ends_at, setup_day, created_by)
       VALUES ($1,$2,'midnight',$3,$4,$5::date,$6) RETURNING *`,
      [String(name || DEFAULT_NAME).trim() || DEFAULT_NAME,
        subtitle == null ? DEFAULT_SUBTITLE : (String(subtitle).trim() || null),
        startsAt, endsAt, day, createdBy || null]);
    return { session: r.rows[0], created: true };
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    // Somebody already claimed this day — adopt theirs. It is the same day.
    const got = await db.query(
      `SELECT * FROM arena_sessions WHERE setup_day = $1::date AND state <> 'closed' LIMIT 1`, [day]);
    if (!got.rows[0]) throw e;   // refused for some other reason; do not guess
    return { session: got.rows[0], created: false };
  }
}

/**
 * One ready-made plan inside a session, made if it is not there yet.
 *
 * The spin and its stamp are written by two statements, so the stamp is applied
 * in the SAME breath and a failure to stamp removes the spin — an unstamped
 * copy would be invisible to the duplicate guard and the next press would build
 * a second one.
 */
async function ensureSpin(session, key, { day, offsetMinutes, createdBy }) {
  const built = templates.buildTemplate(key, { day, offsetMinutes });
  if (!built) return { key, ok: false, reason: 'There is no ready-made plan by that name.' };

  const existing = await db.query(
    `SELECT * FROM arena_spins WHERE session_id = $1 AND template_key = $2 LIMIT 1`, [session.id, key]);
  if (existing.rows[0]) {
    return { key, ok: true, created: false, spin: existing.rows[0], label: built.title };
  }

  let spin;
  try {
    spin = await runner.createSpin({
      sessionId: session.id,
      title: built.title, subtitle: built.subtitle, kind: built.kind, config: built.config,
      entryOpensAt: built.entryOpensAt, entryDeadlineAt: built.entryDeadlineAt, createdBy,
    });
  } catch (e) {
    return { key, ok: false, reason: e.message || 'That plan could not be built.' };
  }

  try {
    await db.query(
      `UPDATE arena_spins SET launch_at = $2, template_key = $3, updated_at = now() WHERE id = $1`,
      [spin.id, built.launchAt || null, key]);
  } catch (e) {
    // Two presses raced and the other one stamped first. Ours is an unstamped
    // duplicate that nothing would ever clean up, so it goes — and we adopt
    // theirs, which is identical by construction.
    await runner.cancelSpin(spin.id, 'Duplicate of the same ready-made plan; the first one stands.')
      .catch(() => {});
    if (!isDuplicate(e)) throw e;
    const theirs = await db.query(
      `SELECT * FROM arena_spins WHERE session_id = $1 AND template_key = $2 LIMIT 1`, [session.id, key]);
    if (!theirs.rows[0]) throw e;
    return { key, ok: true, created: false, spin: theirs.rows[0], label: built.title };
  }

  // The Mega Spin brings a whole afternoon of challenges with it. Best-effort
  // on purpose: a day with its two wheels and no challenges is a day somebody
  // can still run and top up by hand, while refusing the whole setup over the
  // challenge planner would leave them with nothing at all.
  let challengesPlanned = 0;
  if (built.config && built.config.challengePlan) {
    const p = built.config.challengePlan;
    try {
      const planned = await challenges.planDay(session.id, spin.id, {
        from: p.from, to: p.to, targetGapMinutes: p.targetGapMinutes, jitterMinutes: p.jitterMinutes,
        windowMinutes: p.windowMinutes, seed: p.seed, replace: true, createdBy,
      });
      challengesPlanned = (planned && planned.created) || 0;
    } catch (e) {
      return {
        key, ok: true, created: true, spin, label: built.title, challengesPlanned: 0,
        warning: `The wheels are ready, but the challenges could not be scheduled: ${e.message}`,
      };
    }
  }

  return {
    key, ok: true, created: true, spin, label: built.title, challengesPlanned,
    announcement: built.announcement, emailSubject: built.emailSubject,
  };
}

/**
 * Build the whole day. Idempotent: run it again and it reports what was already
 * there and adds only what is missing.
 */
async function setUpDay({ day, offsetMinutes = 0, name, subtitle, createdBy, keys } = {}) {
  const problem = dayProblem(day);
  if (problem) { const e = new Error(problem); e.badRequest = true; throw e; }

  const want = Array.isArray(keys) && keys.length
    ? keys.filter((k) => DAY_TEMPLATES.includes(k))
    : DAY_TEMPLATES.slice();
  if (!want.length) { const e = new Error('Pick at least one ready-made plan.'); e.badRequest = true; throw e; }

  const { session, created } = await ensureSession(day, { name, subtitle, offsetMinutes, createdBy });

  const parts = [];
  for (const key of want) {
    parts.push(await ensureSpin(session, key, { day, offsetMinutes, createdBy }));
  }

  const fresh = (await db.query(`SELECT * FROM arena_sessions WHERE id = $1`, [session.id])).rows[0] || session;
  return {
    session: fresh,
    sessionCreated: created,
    day,
    parts,
    // What a person needs to read back, in the words they would use.
    summary: describe({ session: fresh, sessionCreated: created, parts }),
  };
}

/** The plain sentence the screen shows after the press. */
function describe({ session, sessionCreated, parts }) {
  const made = parts.filter((p) => p.ok && p.created);
  const already = parts.filter((p) => p.ok && !p.created);
  const failed = parts.filter((p) => !p.ok);
  const bits = [];
  bits.push(sessionCreated ? `"${session.name}" is set up and waiting.` : `"${session.name}" was already set up.`);
  if (made.length) {
    const ch = made.reduce((a, p) => a + (p.challengesPlanned || 0), 0);
    bits.push(`Added ${made.map((p) => p.label).join(' and ')}${ch ? `, with ${ch} challenges scheduled` : ''}.`);
  }
  if (already.length) bits.push(`${already.map((p) => p.label).join(' and ')} ${already.length > 1 ? 'were' : 'was'} already there.`);
  for (const p of failed) bits.push(`${p.key} could not be built: ${p.reason}`);
  for (const p of parts) if (p.warning) bits.push(p.warning);
  bits.push('Nothing has gone out to the team — press Start when you are ready.');
  return bits.join(' ');
}

module.exports = {
  setUpDay, describe, dayProblem, ensureSession, ensureSpin,
  DAY_TEMPLATES, DEFAULT_NAME, DEFAULT_SUBTITLE,
};

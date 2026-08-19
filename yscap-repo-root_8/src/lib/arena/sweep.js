'use strict';
/**
 * THE SWEEP -- the deadline alarms, and the safety net under a spinning wheel.
 *
 * WHAT THE OWNER ASKED FOR: "there should be notifications when there is a
 * deadline for a spin -- let's say before 11:38 there should be an alarm by
 * eleven o'clock that you still have 38 minutes to join the spin."
 *
 * SENDING TWICE IS THE FAILURE THAT MATTERS. A timer that ticks every minute
 * against a rule like "fire when 30 minutes remain" fires on EVERY tick inside
 * that minute, and a process that restarts re-reads the same rule and fires
 * again. Emailing the whole company twice in ten seconds is the kind of thing
 * people remember. So the claim is made in the DATABASE first:
 * `arena_notices` has a UNIQUE index on (spin, kind, offset), the insert is
 * `ON CONFLICT DO NOTHING`, and the send only happens if that insert actually
 * inserted a row. Two processes racing the same alarm therefore produce exactly
 * one email, because Postgres decides which one wins, not a lock in memory.
 *
 * IT NEVER FIRES A STALE ALARM. If the sweep is down for two hours it must not
 * come back up and send every alarm it slept through at once. `dueReminders`
 * only returns an offset whose moment is within a grace window, and never one
 * for a deadline that has already passed. The one it skipped is skipped, and
 * that is the right answer -- a "30 minutes left" email arriving 90 minutes
 * late is worse than no email.
 *
 * IT ALSO SETTLES WHEELS. A wheel is revealed by a timer set when it starts,
 * which a deploy or a crash would lose. `settleDue()` here is the guarantee
 * that a restart cannot leave the room watching a wheel that never stops.
 *
 * NEVER THROWS. Every tick is wrapped. A failed sweep logs and comes back next
 * minute; it must never take the web process down with it.
 */

const db = require('../../db');
const notify = require('../notify');
const rules = require('./entry-rules');
const settings = require('./settings');
const runner = require('./spin-runner');

let timer = null;
const TICK_MS = 60000;

/** Everyone who should hear about a spin: the session's people, or the roster. */
async function audienceFor(sessionId) {
  const m = await db.query(
    `SELECT s.id FROM arena_session_members m JOIN staff_users s ON s.id = m.staff_id
      WHERE m.session_id = $1 AND m.removed_at IS NULL AND s.is_active = true AND s.is_external IS NOT TRUE`,
    [sessionId]);
  if (m.rows.length) return m.rows.map((r) => r.id);
  const all = await db.query(
    `SELECT id FROM staff_users WHERE is_active = true AND is_external IS NOT TRUE`);
  return all.rows.map((r) => r.id);
}

/**
 * One pass. Returns what it actually did, so the caller can log measurements
 * rather than intentions.
 */
async function tick(now = new Date()) {
  const out = { settled: 0, launched: 0, challengesOpened: 0, challengesClosed: 0, remindersSent: 0, spinsClosed: 0, errors: [] };

  // 1. Any wheel whose animation finished while nobody was watching.
  try { out.settled = await runner.settleDue(); }
  catch (e) { out.errors.push(`settle: ${e.message}`); }

  // Nothing else matters while the Arena is off.
  let cfg;
  try { cfg = await settings.load(); }
  catch (e) { out.errors.push(`settings: ${e.message}`); return out; }
  if (!cfg.enabled) return out;

  // 2. Spins that open themselves. The Early Bird "should automatically launch
  //    10:30 AM", so nobody has to be standing at a keyboard at half past ten.
  try {
    const launched = await runner.launchDue(now);
    out.launched = launched.length;
    for (const sp of launched) {
      await announceOpen(sp).catch(() => {});
    }
  } catch (e) { out.errors.push(`launch: ${e.message}`); }

  // 3. Challenges that open and close on their own through the day.
  try {
    const ch = await require('./challenges').tick(now);
    out.challengesOpened = ch.opened.length;
    out.challengesClosed = ch.closed.length;
    for (const c of ch.opened) await announceChallenge(c).catch(() => {});
    if (ch.errors.length) out.errors.push(...ch.errors);
  } catch (e) { out.errors.push(`challenges: ${e.message}`); }

  // 4. Deadline alarms.
  let open = [];
  try {
    const r = await db.query(
      `SELECT p.*, s.name AS session_name
         FROM arena_spins p JOIN arena_sessions s ON s.id = p.session_id
        WHERE p.state = 'open' AND p.entry_deadline_at IS NOT NULL AND s.state = 'live' AND s.paused_at IS NULL`);
    open = r.rows;
  } catch (e) { out.errors.push(`spins: ${e.message}`); return out; }

  for (const spin of open) {
    try {
      // The spin's own offsets, falling back to the company setting. Resolved
      // here rather than inside the pure rule so the rule stays testable
      // without settings.
      const config = spin.config || {};
      const withOffsets = {
        ...spin,
        config: {
          ...config,
          reminderOffsetsMinutes: Array.isArray(config.reminderOffsetsMinutes)
            ? config.reminderOffsetsMinutes : cfg.settings.reminderOffsetsMinutes,
        },
      };
      const sent = await db.query(
        `SELECT offset_minutes FROM arena_notices WHERE spin_id = $1 AND kind = 'deadline'`, [spin.id]);
      const due = rules.dueReminders(withOffsets, now, sent.rows.map((r) => r.offset_minutes));

      for (const d of due) {
        // CLAIM FIRST. If this insert does not insert, somebody else already
        // owns this alarm and we must send nothing.
        const claim = await db.query(
          `INSERT INTO arena_notices (spin_id, kind, offset_minutes) VALUES ($1,'deadline',$2)
           ON CONFLICT (spin_id, kind, offset_minutes) DO NOTHING RETURNING id`,
          [spin.id, d.offsetMinutes]);
        if (!claim.rows[0]) continue;

        const left = rules.humanMinutes(d.remainingMs);
        const people = await audienceFor(spin.session_id);
        // Only the ones who have NOT checked in -- telling somebody who is
        // already in that they have 38 minutes to get in is noise, and noise is
        // how a notification everybody needs starts getting ignored.
        const already = await db.query(
          `SELECT staff_id FROM arena_checkins WHERE spin_id = $1 AND status <> 'rejected'`, [spin.id]);
        const inAlready = new Set(already.rows.map((r) => String(r.staff_id)));
        const targets = people.filter((id) => !inAlready.has(String(id)));

        if (cfg.settings.emailReminders !== false) {
          for (const id of targets) {
            await notify.notifyStaff(id, {
              type: 'arena_deadline',
              title: `${left} left to join Spin ${spin.seq}`,
              body: `"${spin.title}" closes soon. Check in now if you want to be in it.`,
              link: '/internal/arena',
              ctaLabel: 'Check in',
            }).catch(() => {});
          }
        }
        await db.query(`UPDATE arena_notices SET recipients = $2 WHERE spin_id = $1 AND kind = 'deadline' AND offset_minutes = $3`,
          [spin.id, targets.length, d.offsetMinutes]).catch(() => {});
        try {
          require('../events').publishToStaff('arena:deadline', {
            spinId: spin.id, seq: spin.seq, remainingMs: d.remainingMs, offsetMinutes: d.offsetMinutes,
          });
        } catch (_) { /* the email already went */ }
        out.remindersSent += targets.length;
      }

      // 5. The door shuts by itself at the deadline. The owner's cutoff is a
      //    time, not a button somebody has to remember to press at 11:38.
      if (new Date(spin.entry_deadline_at) <= now) {
        const claim = await db.query(
          `INSERT INTO arena_notices (spin_id, kind, offset_minutes) VALUES ($1,'closed',0)
           ON CONFLICT (spin_id, kind, offset_minutes) DO NOTHING RETURNING id`, [spin.id]);
        if (claim.rows[0]) {
          await runner.lockSpin(spin.id).catch((e) => out.errors.push(`lock ${spin.id}: ${e.message}`));
          out.spinsClosed++;
        }
      }
    } catch (e) {
      out.errors.push(`spin ${spin.id}: ${e.message}`);
    }
  }
  return out;
}

/** Tell the team a spin has opened itself. */
async function announceOpen(spin) {
  const cfg = await settings.load();
  if (cfg.settings.emailReminders === false) return 0;
  const people = await audienceFor(spin.session_id);
  const when = spin.entry_deadline_at
    ? ` You have until ${new Date(spin.entry_deadline_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`
    : '';
  for (const id of people) {
    await notify.notifyStaff(id, {
      type: 'arena_spin_open',
      title: `${spin.title} is open`,
      body: `Clock in from your own screen to be part of it.${when}`,
      link: '/internal/arena', ctaLabel: 'Clock in',
    }).catch(() => {});
  }
  return people.length;
}

/**
 * A challenge just appeared.
 *
 * IN-APP ONLY, DELIBERATELY. Roughly twenty of these land across an afternoon,
 * and emailing all of them would be the fastest way to make the team filter the
 * whole game into a folder. The pop-up on the screen IS the notification; the
 * emails are saved for the handful of moments that matter (a spin opening, a
 * deadline, a result).
 */
async function announceChallenge(c) {
  try {
    require('../events').publishToStaff('arena:challenge-open', require('./challenges').publicChallenge(c));
  } catch (_) { /* the board picks it up on its next read */ }
  // AND a bell notification, so somebody who was on a call still finds out —
  // "get a notification whenever there is new stuff available for them to go in
  // and fill it in". In-app only, never an email: about twenty of these land in
  // an afternoon and emailing them all is how a game becomes a mail filter.
  try { return (await require('./announce').challengeLanded(c)).sent || 0; }
  catch (_) { return 0; }
}

/** Start the minute sweep. Idempotent; safe to call twice. */
function start() {
  if (timer) return timer;
  timer = setInterval(() => {
    tick().then((r) => {
      const did = r.settled || r.remindersSent || r.spinsClosed || r.launched
        || r.challengesOpened || r.challengesClosed || r.errors.length;
      if (did) {
        console.log(`[arena] sweep: settled ${r.settled}, launched ${r.launched || 0}, `
          + `challenges +${r.challengesOpened || 0}/-${r.challengesClosed || 0}, `
          + `reminders ${r.remindersSent}, closed ${r.spinsClosed}`
          + (r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''));
      }
    }).catch((e) => console.warn(`[arena] sweep failed: ${(e && e.message) || e}`));
  }, TICK_MS);
  // unref: the sweep must never be the reason a deploy cannot shut down.
  if (timer.unref) timer.unref();
  return timer;
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { tick, start, stop, audienceFor, TICK_MS };

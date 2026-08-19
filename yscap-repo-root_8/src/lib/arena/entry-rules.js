'use strict';
/**
 * THE TWO DOORS -- may this person get into the spin, and may this thing be put
 * forward as a prize. One definition of both, used by the API, the screens
 * (through the API) and the tests.
 *
 * WHY THE CAPS ARE NOT DATABASE CONSTRAINTS. The owner set the numbers as an
 * example -- "anything not related to business ... up to five hundred ...
 * everything that is related to business ... up to a thousand dollars, for
 * example" -- and asked for "a lot of ways in settings to set up the spinner in
 * different ways". A CHECK constraint would turn their example into a law that
 * needs a migration to change, which is the opposite of what was asked for. So
 * the cap is a SETTING with those numbers pre-filled, enforced here, at the one
 * door every write goes through.
 *
 * WHY THE CUTOFF REFUSES AT THE DOOR. The owner's rule is "everybody that
 * arrived before 11:38 goes into the spin". The tempting shape is to accept
 * every check-in and filter the late ones out when the wheel is built. That is
 * the cheap shape and it is cruel: somebody who checked in at 11:41 would sit
 * there believing they were in, watch the wheel, and never know why their name
 * was missing. A late check-in is REFUSED, immediately, with the time it closed
 * and by how much they missed it.
 *
 * MONEY IS IN CENTS, always, as integers. A prize cap compared in floating
 * point is a prize cap that lets $500.0000001 through.
 *
 * PURE: no database, no clock of its own (the caller passes `now`, so the tests
 * can stand at 11:37 and at 11:39 and see both answers), no IO. Every branch is
 * exercised by scripts/test-arena-entry-rules-pure.js.
 */

/** Parse a typed money value into whole cents. Returns null if it is not money. */
function toCents(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }
  const s = String(input).trim().replace(/[$,\s]/g, '');
  if (!s) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Cents to the way a person writes money, for messages people read. */
function money(cents) {
  const n = Number(cents) || 0;
  const whole = Math.floor(Math.abs(n) / 100);
  const part = Math.abs(n) % 100;
  const s = `$${whole.toLocaleString('en-US')}${part ? `.${String(part).padStart(2, '0')}` : ''}`;
  return n < 0 ? `-${s}` : s;
}

/** Plain-language minutes, for a countdown people read out loud. */
function humanMinutes(ms) {
  const mins = Math.round(Math.abs(ms) / 60000);
  if (mins < 1) return 'less than a minute';
  if (mins === 1) return '1 minute';
  if (mins < 60) return `${mins} minutes`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` and ${m} minute${m === 1 ? '' : 's'}` : ''}`;
}

/**
 * The cap that applies to one kind of prize, resolved settings-first.
 * `spinConfig` may override the company setting for a single spin.
 */
function capForKind(kind, settings, spinConfig) {
  const cfg = spinConfig || {};
  const s = settings || {};
  const pick = (a, b) => {
    const n = Number(a);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
    const m = Number(b);
    return Number.isFinite(m) && m >= 0 ? Math.round(m) : 0;
  };
  return kind === 'business'
    ? pick(cfg.businessCapCents, s.businessCapCents)
    : pick(cfg.personalCapCents, s.personalCapCents);
}

/**
 * MAY THIS PERSON CHECK IN?
 *
 * @param {object} spin      { state, entry_opens_at, entry_deadline_at }
 * @param {Date}   now       the moment being judged
 * @param {object} opts      { alreadyCheckedIn, isMember }
 * @returns {{ok:boolean, reason:string|null, code:string|null, closesInMs:number|null}}
 */
function mayCheckIn(spin, now, opts = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const no = (code, reason) => ({ ok: false, code, reason, closesInMs: null });
  if (!spin) return no('no_spin', 'That spin does not exist.');
  if (opts.isMember === false) {
    return no('not_in_session', 'You are not on the list for this session. Ask a super admin to add you.');
  }
  if (spin.state === 'draft') return no('not_open', 'This spin has not opened yet.');
  if (spin.state === 'cancelled') return no('cancelled', 'This spin was cancelled.');
  if (spin.state !== 'open') return no('closed', 'Check-in for this spin has closed.');
  const opens = spin.entry_opens_at ? new Date(spin.entry_opens_at) : null;
  if (opens && at < opens) {
    return no('too_early', `Check-in opens at ${opens.toISOString()}.`);
  }
  const deadline = spin.entry_deadline_at ? new Date(spin.entry_deadline_at) : null;
  if (deadline && at > deadline) {
    return no('too_late', `Check-in closed at ${deadline.toISOString()} - you missed it by ${humanMinutes(at - deadline)}.`);
  }
  if (opts.alreadyCheckedIn) return no('already', 'You are already checked in for this spin.');
  return { ok: true, code: null, reason: null, closesInMs: deadline ? (deadline - at) : null };
}

/**
 * MAY THIS THING BE PUT FORWARD AS A PRIZE?
 *
 * @param {object} entry     { kind, label, valueCents }
 * @param {object} ctx       { spin, settings, now, checkedIn, existingCount }
 */
function mayEnter(entry, ctx = {}) {
  const e = entry || {};
  const spin = ctx.spin || null;
  const settings = ctx.settings || {};
  const config = (spin && spin.config) || {};
  const at = ctx.now instanceof Date ? ctx.now : new Date(ctx.now || Date.now());
  const no = (code, reason) => ({ ok: false, code, reason });

  if (!spin) return no('no_spin', 'That spin does not exist.');
  if (config.entriesAllowed === false) return no('entries_off', 'This spin does not take suggestions - the prize is already set.');
  if (spin.state !== 'open') return no('closed', 'This spin is no longer taking entries.');

  const deadline = spin.entry_deadline_at ? new Date(spin.entry_deadline_at) : null;
  if (deadline && at > deadline) {
    return no('too_late', `Entries closed at ${deadline.toISOString()} - you missed it by ${humanMinutes(at - deadline)}.`);
  }
  // Checking in is what earns the right to name a prize -- the owner's order of
  // events: check in, get approved, THEN "can enter something to be in the spin".
  if (config.checkinRequired !== false && ctx.checkedIn !== true) {
    return no('not_checked_in', 'Check in to this spin first, then you can say what you would like to win.');
  }

  const kind = e.kind === 'business' ? 'business' : 'personal';
  const label = String(e.label == null ? '' : e.label).trim();
  if (!label) return no('no_label', 'Say what the prize is.');
  if (label.length > 140) return no('too_long', 'Keep the prize to 140 characters or fewer.');

  const cents = e.valueCents === undefined ? toCents(e.value) : Number(e.valueCents);
  if (cents === null || !Number.isFinite(cents)) return no('bad_value', 'That does not look like an amount of money.');
  if (!Number.isInteger(cents)) return no('bad_value', 'That does not look like an amount of money.');
  if (cents < 0) return no('negative', 'An amount cannot be negative.');

  // THE EARNED ECONOMY, where the spin runs on chances (the Mega Spin). Two
  // promises the screens make were measured broken on 2026-08-19 and are
  // enforced HERE so every door inherits them:
  //   · "every five chances lets you put another thing on the wheel" — the
  //     counter displayed but nothing ever consumed or checked a nomination;
  //   · "the bigger the challenge, the more you may ask for — up to $2,000" —
  //     the tier ceiling was displayed and never applied, so a tier-5 winner
  //     was still refused above the base cap.
  // ctx.standing is challenges.standingFor()'s answer (tickets, earned, used,
  // prizeCapCents from tiers won). Only a ticket-economy spin engages it; an
  // ordinary spin is byte-identical to before.
  const economy = spin.kind === 'ticket_lottery' && ctx.standing && typeof ctx.standing === 'object'
    ? ctx.standing : null;

  let cap = capForKind(kind, settings, config);
  if (economy) {
    // A tier win RAISES the ceiling for that person, bounded by the day's own
    // maximum. It never lowers the base cap — winning something must never make
    // a person able to ask for less.
    const dayMax = Number(config.maxPrizeCapCents) > 0 ? Math.floor(Number(config.maxPrizeCapCents)) : Infinity;
    const unlocked = Math.min(dayMax, Math.max(0, Math.floor(Number(economy.prizeCapCents) || 0)));
    cap = Math.max(cap, unlocked);
  }
  if (cap > 0 && cents > cap) {
    return no('over_cap', kind === 'business'
      ? `Anything for the business has to be ${money(cap)} or less. You asked for ${money(cents)}.`
      : `Anything personal has to be ${money(cap)} or less. You asked for ${money(cents)}.`);
  }

  const configAllowed = Number(config.entriesPerPerson) > 0
    ? Math.floor(Number(config.entriesPerPerson))
    : (Number(settings.entriesPerPerson) > 0 ? Math.floor(Number(settings.entriesPerPerson)) : 1);
  // On the earned economy: everyone gets ONE for being in, and every earned
  // nomination buys one more — capped by the config ceiling as a sanity bound.
  const allowed = economy
    ? Math.min(configAllowed, 1 + Math.max(0, Math.floor(Number(economy.earned) || 0)))
    : configAllowed;
  if (Number(ctx.existingCount) >= allowed) {
    if (economy) {
      const n = Math.max(0, Math.floor(Number(economy.ticketsToNext) || 0));
      return no('too_many',
        `You have used your ${allowed === 1 ? 'entry' : allowed + ' entries'} for this spin — `
        + `finish ${n === 1 ? 'one more challenge chance' : 'challenges worth ' + n + ' more chances'} to unlock another.`);
    }
    return no('too_many', allowed === 1
      ? 'You have already put something forward for this spin.'
      : `You can put forward ${allowed} things for this spin, and you have used them all.`);
  }

  return {
    ok: true, code: null, reason: null,
    kind,
    label,
    valueCents: cents,
    // Any entry past the free first one on the earned economy was BOUGHT with
    // chances; the route records the ticket count it was bought at so
    // standingFor's `used` genuinely goes down. NULL on the free one and on
    // every ordinary spin.
    unlockedByTickets: economy && Number(ctx.existingCount) >= 1
      ? Math.max(0, Math.floor(Number(economy.tickets) || 0)) : null,
    // Whether a super admin still has to say yes. The owner's rule is that they
    // do ("super admin accepts everything"), and it is the DEFAULT rather than
    // the only option.
    needsApproval: config.autoApproveEntries === true ? false
      : (settings.requireEntryApproval === false && config.autoApproveEntries !== false ? false : true),
  };
}

/**
 * The deadline alarms that are DUE for a spin right now.
 *
 * Returns the offsets whose moment has passed and which have not been sent (the
 * caller passes what it already sent). It NEVER returns an offset whose moment
 * is in the future, and it never returns one for a deadline already gone by
 * more than a grace window -- a sweep that was down for two hours must not come
 * back up and fire every alarm it slept through at once.
 */
function dueReminders(spin, now, alreadySent = [], { graceMs = 15 * 60 * 1000 } = {}) {
  if (!spin || spin.state !== 'open' || !spin.entry_deadline_at) return [];
  const at = now instanceof Date ? now : new Date(now);
  const deadline = new Date(spin.entry_deadline_at);
  const cfg = (spin.config || {});
  const raw = Array.isArray(cfg.reminderOffsetsMinutes) ? cfg.reminderOffsetsMinutes : null;
  const offsets = (raw || [])
    .map((m) => Math.floor(Number(m)))
    .filter((m) => Number.isFinite(m) && m > 0);
  const sent = new Set((alreadySent || []).map(Number));
  const out = [];
  for (const mins of offsets) {
    if (sent.has(mins)) continue;
    const fireAt = new Date(deadline.getTime() - mins * 60000);
    if (at < fireAt) continue;              // not yet
    if (at - fireAt > graceMs) continue;    // long gone; do not fire it late
    if (at > deadline) continue;            // the door already shut
    out.push({ offsetMinutes: mins, fireAt, remainingMs: deadline - at });
  }
  return out.sort((a, b) => b.offsetMinutes - a.offsetMinutes);
}

module.exports = {
  toCents, money, humanMinutes, capForKind,
  mayCheckIn, mayEnter, dueReminders,
};

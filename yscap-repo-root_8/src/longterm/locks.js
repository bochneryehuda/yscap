'use strict';
const { num, text } = require('./num');
/**
 * LONG-TERM — Phase 7: where a loan's rate lock stands right now.
 *
 * READ-ONLY, like everything else on this side. Requesting, confirming, extending,
 * re-locking and cancelling are all WRITES to Encompass and stay off until the owner
 * authorises a specific endpoint in writing (docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md).
 * Nothing in this module can write anywhere except our own `lt_*` tables.
 *
 * THE SURFACE IS NARROWER THAN THE DOCUMENTATION SUGGESTS, and the plan says so
 * honestly: every lock-SPECIFIC endpoint on this tenant answers 403 on the client
 * registration we have, so the lock REQUEST HISTORY is not readable today. What is
 * readable is the loan itself — the `rateLock` entity and the numbered fields — which
 * is enough for "where does this loan stand", and that is what this builds.
 * `lt_lock_events` therefore stays THIN until the 403s are lifted; it is filled from
 * what we can actually observe (a posture that CHANGED between two reads) rather than
 * left empty and pretending.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE HARD RULE, from the API research and repeated wherever this is touched:
 *
 *   TRUST `lockExpirationDate`. NEVER RECOMPUTE IT FROM THE LOCK DATE PLUS DAYS.
 *
 * An extension or a re-lock moves the expiration without moving the lock date, so a
 * recomputed date quietly disagrees with the investor's — and it disagrees by being
 * TOO EARLY, which is the direction that costs money: it would show a desk a lock as
 * expired while the investor still honours it, or expire a loan a week before anybody
 * needed to act. So a loan with a lock date and a day count but no stated expiration
 * reports NO expiration and says why. An unknown date is cheap; a wrong one is not.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const lazy = {
  get db() { return require('./db'); },
};

/** A calendar day, or null. Dates here are days, never instants — see `dayDiff`. */
function dayOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  // An ISO instant, an ISO date and a US date are all things Encompass has been seen
  // to return for a date field; anything else states nothing. Each is checked as a
  // real calendar day, not merely a shape: `0000-00-00` looks like a date and
  // Postgres refuses it, and a value that raises on the way into a date column would
  // take the whole loan's mirror down with it.
  const ok = (y, mo, d) => y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
  const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return ok(y, mo, d) ? iso(y, mo, d) : null;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/);
  if (m) {
    const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return ok(y, mo, d) ? iso(y, mo, d) : null;
  }
  return null;
}

/**
 * Whole days from `from` to `to`, both calendar days.
 *
 * Calendar arithmetic on UTC noon, never `new Date(a) - new Date(b)` on local time:
 * a lock that expires "in 3 days" must not read as 2 because the server is in a
 * different zone from the desk, and noon is far enough from either midnight that no
 * daylight-saving hour can move the answer.
 */
function dayDiff(from, to) {
  const a = dayOf(from);
  const b = dayOf(to);
  if (!a || !b) return null;
  const ms = Date.UTC(...b.split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)), 12)
           - Date.UTC(...a.split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)), 12);
  return Math.round(ms / 86400000);
}



/** The first path that carries a value. Encompass spells one fact several ways. */
function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    for (const seg of p.split('.')) {
      if (cur === null || cur === undefined) { cur = undefined; break; }
      cur = cur[seg];
    }
    if (cur !== null && cur !== undefined && cur !== '') return cur;
  }
  return null;
}

const RATE_LOCK_ROOTS = ['rateLock', 'rateLockDetails', 'currentRateLock'];

/**
 * Every place the loan JSON has been observed — or documented — to carry one fact.
 * Ordered most specific first. A path that is absent simply does not answer.
 */
const PATHS = {
  status: ['lockStatus', 'rateLockStatus', 'status', 'lockRequestStatus'],
  rate: ['lockedRate', 'noteRate', 'rate', 'lockedNoteRate'],
  price: ['lockedPrice', 'price', 'basePrice'],
  lockDate: ['lockDate', 'rateLockDate', 'lockedDate', 'lockRequestDate'],
  expiration: ['lockExpirationDate', 'rateLockExpirationDate', 'expirationDate', 'lockExpires'],
  days: ['lockDays', 'lockPeriodDays', 'rateLockPeriod', 'lockTerm'],
  product: ['productName', 'lockedProductName', 'loanProgramName', 'program'],
  commitment: ['commitmentType', 'lockCommitmentType', 'deliveryType'],
};

/**
 * NORMALIZED POSTURE — three answers, and `unknown` is a real one.
 *
 * `locked` is claimed only when the loan SAYS so. A loan whose lock section is empty
 * is `not_locked`; a loan whose status word we do not recognise is `unknown`, never
 * quietly rounded to either — a desk that is told a loan is unlocked when nobody
 * knows will go and lock it twice, and one told it is locked when nobody knows will
 * let a rate float. The words differ by lender, so both lists are SETTINGS.
 */
const DEFAULT_LOCKED_WORDS = ['locked', 'lock confirmed', 'confirmed', 'accepted', 'active'];
const DEFAULT_UNLOCKED_WORDS = ['not locked', 'unlocked', 'floating', 'float', 'cancelled', 'canceled', 'denied', 'expired', 'none'];

function postureFor(status, settings = {}) {
  const s = text(status);
  if (!s) return 'not_locked';
  const norm = s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  const locked = (settings['lock.lockedStatuses'] || DEFAULT_LOCKED_WORDS).map((w) => String(w).toLowerCase());
  const unlocked = (settings['lock.unlockedStatuses'] || DEFAULT_UNLOCKED_WORDS).map((w) => String(w).toLowerCase());
  if (locked.includes(norm)) return 'locked';
  if (unlocked.includes(norm)) return 'not_locked';
  return 'unknown';
}

/**
 * The two numbered fields, and the ONE inference this module permits itself.
 *
 * The probe found fields 761 and 762 populated and **2148 EMPTY** — 2148 is quoted as
 * the lock date in a great deal of general Encompass material and holds nothing here,
 * so do not reach for it. Which of 761/762 is the lock date and which the expiration
 * is tenant configuration and is a SETTING, not a constant in this file.
 *
 * Where both parse as dates, ORDER decides rather than the setting: an expiration can
 * never fall before the lock it expires, so the LATER day is the expiration. That is
 * arithmetic, not a guess about a business rule — and it is the guard that stops a
 * mis-set field id writing a lock date into the expiration column, which would make
 * every loan look expired the day it locked. With only one date, or with two equal
 * ones, the declared mapping stands and `fieldOrderAssumed` records that it did.
 */
function datesFromFields(fieldValues, settings = {}) {
  const fv = fieldValues || {};
  const lockId = String(settings['lock.lockDateFieldId'] || '761');
  const expId = String(settings['lock.expirationFieldId'] || '762');
  const a = dayOf(fv[lockId]);
  const b = dayOf(fv[expId]);
  if (a && b && a !== b) {
    const later = dayDiff(a, b) > 0 ? b : a;
    const earlier = later === b ? a : b;
    return { lockDate: earlier, expiration: later, fieldOrderAssumed: later === b };
  }
  return { lockDate: a, expiration: b, fieldOrderAssumed: !!(a || b) };
}

/**
 * The lock posture of one loan, from what we can actually read.
 *
 * PURE — no database, no Encompass. `loan` is the v3 loan JSON, `fieldValues` the
 * by-number read the loan sync already does, so this costs no extra call.
 *
 * Never throws: a malformed loan answers "nothing recorded" rather than breaking the
 * pass that is mirroring seven hundred of them.
 */
function lockFromLoan(loan, fieldValues, settings = {}, today = null) {
  const root = {};
  for (const r of RATE_LOCK_ROOTS) {
    const v = loan && loan[r];
    if (v && typeof v === 'object') Object.assign(root, v);
  }

  const fromFields = datesFromFields(fieldValues, settings);

  const status = text(pick(root, PATHS.status));
  const entityLock = dayOf(pick(root, PATHS.lockDate));
  const entityExp = dayOf(pick(root, PATHS.expiration));

  // The ENTITY wins wherever it answers: its keys are named, so there is nothing to
  // infer. The numbered fields are the fallback for a tenant that fills one and not
  // the other — which is exactly what the probe found here.
  let lockDate = entityLock || fromFields.lockDate;
  let expiration = entityExp || fromFields.expiration;

  // THE CROSS-SOURCE HOLE, closed. `datesFromFields` puts the two NUMBERED fields in
  // order, but the pair can also arrive one from each source — a named entity key and
  // an inferred field number — and then nothing had ordered them. An expiration
  // earlier than its own lock is impossible, so one of the two is wrong, and the
  // INFERRED one is the one we drop: a named key says what it is, a field number is
  // only a mapping somebody configured. Dropping it costs a date; keeping it would
  // report a loan as EXPIRED on the day it locked, which sends somebody to the lock
  // desk for nothing.
  let incoherentDates = false;
  if (lockDate && expiration && dayDiff(lockDate, expiration) < 0) {
    if (entityExp && !entityLock) lockDate = null;
    else if (entityLock && !entityExp) expiration = null;
    // Both from the SAME source is Encompass contradicting itself, and inventing a
    // correction there would be a guess about the tenant's own data. It is recorded
    // and shown, never quietly fixed.
    else incoherentDates = true;
  }

  const days = num(pick(root, PATHS.days));
  const now = dayOf(today) || new Date().toISOString().slice(0, 10);

  // THE HARD RULE. A day count is recorded because it is worth showing; it is NEVER
  // added to the lock date to manufacture an expiration.
  const expirationDerived = false;

  const daysRemaining = expiration ? dayDiff(now, expiration) : null;
  const posture = postureFor(status, settings);

  // `expired` is only ever said of a loan that HAS a stated expiration in the past.
  // Nothing is inferred from a missing date: "we cannot see when this expires" and
  // "this has expired" are different sentences and only one of them sends somebody
  // running to the lock desk.
  const expired = expiration && daysRemaining !== null ? daysRemaining < 0 : false;

  const warnDays = num(settings['lock.expiringSoonDays']);
  const expiringSoon = !expired && daysRemaining !== null
    && daysRemaining <= (warnDays === null ? 7 : warnDays);

  return {
    status,
    posture: expired && posture === 'locked' ? 'expired' : posture,
    noteRatePct: num(pick(root, PATHS.rate)),
    price: num(pick(root, PATHS.price)),
    lockDate,
    expirationDate: expiration,
    lockDays: days === null ? null : Math.round(days),
    productName: text(pick(root, PATHS.product)),
    commitmentType: text(pick(root, PATHS.commitment)),
    daysRemaining,
    expired,
    expiringSoon,
    expirationDerived,
    // Encompass's own two dates contradict each other. Recorded rather than corrected.
    incoherentDates,
    // Why a screen is showing nothing, in the screen's own words. A blank lock panel
    // with no explanation reads as a broken screen.
    why: expiration ? null : (
      lockDate
        ? 'Encompass has not stated an expiration date for this lock. It is never calculated from the lock date plus a day count — an extension moves it, and a calculated date would be wrong in the direction that costs money.'
        : 'No rate lock is recorded on this loan in Encompass.'
    ),
    fieldOrderAssumed: !entityExp && fromFields.fieldOrderAssumed,
    raw: Object.keys(root).length ? root : null,
  };
}

/** Do two postures differ in a way worth recording as an event? */
function changed(before, after) {
  if (!after) return false;
  if (!before) return !!(after.status || after.expirationDate || after.noteRatePct !== null);
  return String(before.lock_status || '') !== String(after.status || '')
    || String(before.expiration_date || '').slice(0, 10) !== String(after.expirationDate || '')
    || num(before.note_rate_pct) !== after.noteRatePct;
}

/**
 * What KIND of change we just watched. Deliberately coarse: we are observing two
 * snapshots, not reading a request history, so this may only claim what two dates
 * and a status word actually prove. `relocked` / `denied` / `requested` are left for
 * the day the lock endpoints answer, rather than guessed at from a status word.
 */
function eventTypeFor(before, after) {
  if (!before || (!before.lock_status && !before.expiration_date)) return 'observed_lock';
  const oldExp = String(before.expiration_date || '').slice(0, 10);
  const newExp = after.expirationDate || '';
  if (oldExp && newExp && oldExp !== newExp) {
    return dayDiff(oldExp, newExp) > 0 ? 'observed_extension' : 'observed_expiration_moved_in';
  }
  if (String(before.lock_status || '') !== String(after.status || '')) return 'observed_status_change';
  return 'observed_change';
}

/**
 * Mirror one loan's posture. Snapshot-REPLACED, with the history APPENDED — a lock
 * can be rolled back exactly as a milestone can, so the current row is overwritten
 * wholesale while `lt_lock_events` is only ever added to.
 *
 * Writes only `lt_*`. Never throws — a lock we could not mirror must not fail the
 * loan read that carried it.
 */
async function writeLock(loanId, posture, dbc = null) {
  const q = dbc || lazy.db;
  try {
    const { rows: before } = await q.query(
      'SELECT lock_status, expiration_date, note_rate_pct FROM lt_locks WHERE loan_id = $1::uuid', [loanId],
    );
    const prev = before[0] || null;

    await q.query(
      `INSERT INTO lt_locks (loan_id, lock_status, note_rate_pct, price, lock_date, expiration_date,
                             lock_days, product_name, commitment_type, raw, encompass_synced_at, updated_at)
            VALUES ($1::uuid, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10::jsonb, now(), now())
       ON CONFLICT (loan_id) DO UPDATE SET
            lock_status = EXCLUDED.lock_status,
            note_rate_pct = EXCLUDED.note_rate_pct,
            price = EXCLUDED.price,
            lock_date = EXCLUDED.lock_date,
            expiration_date = EXCLUDED.expiration_date,
            lock_days = EXCLUDED.lock_days,
            product_name = EXCLUDED.product_name,
            commitment_type = EXCLUDED.commitment_type,
            raw = EXCLUDED.raw,
            encompass_synced_at = now(),
            updated_at = now()`,
      [loanId, posture.status, posture.noteRatePct, posture.price, posture.lockDate,
        posture.expirationDate, posture.lockDays, posture.productName, posture.commitmentType,
        posture.raw ? JSON.stringify(posture.raw) : null],
    );

    if (changed(prev, posture)) {
      await q.query(
        `INSERT INTO lt_lock_events (id, loan_id, event_type, event_at, note_rate_pct, price,
                                     expiration_date, actor_name, raw, encompass_synced_at)
              VALUES (gen_random_uuid(), $1::uuid, $2, now(), $3, $4, $5::date, NULL, $6::jsonb, now())`,
        [loanId, eventTypeFor(prev, posture), posture.noteRatePct, posture.price,
          posture.expirationDate,
          JSON.stringify({ from: prev || null, to: { status: posture.status, expirationDate: posture.expirationDate, noteRatePct: posture.noteRatePct } })],
      );
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 300) };
  }
}

/** One loan's lock, for a screen: the posture plus what we watched change. */
async function loadLock(loanId) {
  const { rows } = await lazy.db.query(
    `SELECT lock_status, note_rate_pct, price, lock_date, expiration_date, lock_days,
            product_name, commitment_type, encompass_synced_at
       FROM lt_locks WHERE loan_id = $1::uuid`, [loanId],
  );
  if (!rows.length) {
    return { recorded: false, why: 'No rate lock has been mirrored for this loan yet.', events: [] };
  }
  const r = rows[0];
  const today = new Date().toISOString().slice(0, 10);
  const expiration = r.expiration_date ? String(r.expiration_date).slice(0, 10) : null;
  const daysRemaining = expiration ? dayDiff(today, expiration) : null;

  const { rows: events } = await lazy.db.query(
    `SELECT event_type, event_at, note_rate_pct, price, expiration_date
       FROM lt_lock_events WHERE loan_id = $1::uuid ORDER BY event_at DESC LIMIT 50`, [loanId],
  );

  return {
    recorded: true,
    status: r.lock_status,
    noteRatePct: num(r.note_rate_pct),
    price: num(r.price),
    lockDate: r.lock_date ? String(r.lock_date).slice(0, 10) : null,
    expirationDate: expiration,
    lockDays: r.lock_days === null ? null : Number(r.lock_days),
    productName: r.product_name,
    commitmentType: r.commitment_type,
    daysRemaining,
    expired: daysRemaining !== null ? daysRemaining < 0 : false,
    syncedAt: r.encompass_synced_at,
    // Said plainly on every lock screen, because somebody WILL ask why they cannot
    // see who extended it.
    historyNote: 'Encompass\'s lock request history is not readable on our current API '
      + 'permissions, so this list is what PILOT itself watched change between reads.',
    events: events.map((e) => ({
      type: e.event_type,
      at: e.event_at,
      noteRatePct: num(e.note_rate_pct),
      price: num(e.price),
      expirationDate: e.expiration_date ? String(e.expiration_date).slice(0, 10) : null,
    })),
  };
}

/**
 * The field ids this module needs, so the loan sync can ask for the team's and the
 * lock's in ONE fieldReader call rather than two.
 */
function fieldIdsFor(settings = {}) {
  const ids = [
    String(settings['lock.lockDateFieldId'] || '761'),
    String(settings['lock.expirationFieldId'] || '762'),
  ].filter(Boolean);
  return [...new Set(ids)];
}

module.exports = {
  fieldIdsFor,
  lockFromLoan,
  postureFor,
  writeLock,
  loadLock,
  DEFAULT_LOCKED_WORDS,
  DEFAULT_UNLOCKED_WORDS,
  _internals: { dayOf, dayDiff, pick, datesFromFields, changed, eventTypeFor },
};

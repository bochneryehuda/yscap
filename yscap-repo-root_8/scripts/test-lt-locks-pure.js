'use strict';
/**
 * LT test — the rate-lock reader.
 *
 * The one rule worth a whole suite: **an expiration date is what Encompass says it
 * is, and is NEVER calculated from the lock date plus a day count.** An extension or
 * a re-lock moves the expiration without moving the lock date, so a calculated date
 * disagrees with the investor's — and it disagrees by being TOO EARLY, which is the
 * direction that costs money: a desk would see a lock as expired while the investor
 * still honours it. The temptation to "helpfully" fill in the blank is exactly what
 * this suite exists to catch, because the code that does it looks correct.
 *
 * Pure — no database, no Encompass.
 */

const locks = require('../src/longterm/locks');
const decl = require('../src/longterm/settings/encompass-settings');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const S = decl.defaults();
const TODAY = '2026-08-16';

// ── The hard rule ───────────────────────────────────────────────────────────
console.log('an expiration is stated, never calculated');

const lockedNoExpiry = locks.lockFromLoan(
  { rateLock: { lockStatus: 'Locked', lockDate: '2026-08-01', lockDays: 30, lockedRate: 7.125 } },
  null, S, TODAY,
);
check(lockedNoExpiry.expirationDate === null,
  'a lock date plus a day count does NOT produce an expiration — 1 August + 30 days is not an answer we may give');
check(lockedNoExpiry.lockDays === 30 && lockedNoExpiry.lockDate === '2026-08-01',
  '…both figures are still recorded, because they are worth showing; they are simply never added together');
check(/never calculated/i.test(lockedNoExpiry.why || ''),
  '…and the screen is told WHY it is empty, so a blank panel does not read as a broken one');
check(lockedNoExpiry.expired === false && lockedNoExpiry.daysRemaining === null,
  'nothing is inferred from the missing date: "we cannot see when this expires" is not "this has expired"');

const stated = locks.lockFromLoan(
  { rateLock: { lockStatus: 'Locked', lockDate: '2026-08-01', lockDays: 30, lockExpirationDate: '2026-09-20' } },
  null, S, TODAY,
);
check(stated.expirationDate === '2026-09-20',
  'a STATED expiration is taken verbatim, even when it disagrees with the lock date plus the days');
check(stated.daysRemaining === 35, 'the countdown runs to the stated date (35 days)');
check(stated.expirationDerived === false, 'and nothing anywhere is marked as derived, because nothing is');

// ── The countdown ───────────────────────────────────────────────────────────
console.log('\nthe countdown, and what "expired" may be said of');

const soon = locks.lockFromLoan({ rateLock: { lockStatus: 'Locked', lockExpirationDate: '2026-08-20' } }, null, S, TODAY);
check(soon.daysRemaining === 4 && soon.expiringSoon === true && soon.expired === false,
  'four days out is expiring soon and NOT expired');
const past = locks.lockFromLoan({ rateLock: { lockStatus: 'Locked', lockExpirationDate: '2026-08-10' } }, null, S, TODAY);
check(past.expired === true && past.daysRemaining === -6, 'six days past its stated date is expired');
check(past.posture === 'expired', '…and the posture says so rather than still reading "locked"');
const todayExp = locks.lockFromLoan({ rateLock: { lockStatus: 'Locked', lockExpirationDate: TODAY } }, null, S, TODAY);
check(todayExp.expired === false && todayExp.daysRemaining === 0,
  'a lock expiring TODAY has not expired — it is good until the day is out');

// A day count must not drift with the server's timezone: 12 hours either way of
// midnight is the difference between "3 days left" and "2".
check(locks._internals.dayDiff('2026-03-07', '2026-03-10') === 3,
  'the countdown crosses a daylight-saving change without losing a day');
check(locks._internals.dayDiff('2026-12-31', '2027-01-02') === 2, '…and crosses a year end');

// ── Posture ─────────────────────────────────────────────────────────────────
console.log('\nan unrecognised status word is UNKNOWN, never a guess');

check(locks.postureFor('Locked', S) === 'locked' && locks.postureFor('LOCKED  ', S) === 'locked',
  'the words that mean locked are matched whatever the casing or spacing');
check(locks.postureFor('Lock_Confirmed', S) === 'locked',
  'underscores, dashes and spaces are treated alike — one lender writes it three ways');
check(locks.postureFor('Floating', S) === 'not_locked', 'and the words that mean not locked');
check(locks.postureFor('Pending Investor Review', S) === 'unknown',
  'THE ONE THAT MATTERS: a word on neither list is UNKNOWN — a desk told a loan is floating when nobody knows will lock it twice, and one told it is locked will let a rate float');
check(locks.postureFor('', S) === 'not_locked' && locks.postureFor(null, S) === 'not_locked',
  'nothing recorded at all is plainly "not locked" — that is an absence, not an ambiguity');
check(locks.postureFor('Pending Investor Review', { 'lock.lockedStatuses': ['pending investor review'] }) === 'locked',
  'the lists are SETTINGS, so the next lender\'s words are a configuration change and not a deploy');

// ── The two numbered fields ─────────────────────────────────────────────────
console.log('\nthe numbered fields, and the one inference this module permits');

const byFields = locks.lockFromLoan({}, { 761: '2026-08-01', 762: '2026-09-20' }, S, TODAY);
check(byFields.lockDate === '2026-08-01' && byFields.expirationDate === '2026-09-20',
  'with the entity silent, the declared field mapping is read');

const swapped = locks.lockFromLoan({}, { 761: '2026-09-20', 762: '2026-08-01' }, S, TODAY);
check(swapped.lockDate === '2026-08-01' && swapped.expirationDate === '2026-09-20',
  'THE GUARD: an expiration can never precede the lock it expires, so the LATER date is the expiration whatever the mapping says — a mis-set field id would otherwise make every loan look expired the day it locked');

const entityWins = locks.lockFromLoan(
  { rateLock: { lockExpirationDate: '2026-10-01' } }, { 761: '2026-08-01', 762: '2026-09-20' }, S, TODAY,
);
check(entityWins.expirationDate === '2026-10-01',
  'the named entity key wins over a numbered field — there is nothing to infer when the key says what it is');
check(entityWins.fieldOrderAssumed === false,
  '…and nothing is marked as assumed when nothing was assumed');

check(locks.lockFromLoan({}, { 2148: '2026-08-01' }, S, TODAY).lockDate === null,
  'field 2148 is not reached for: it is quoted as the lock date everywhere and is EMPTY on this tenant');

// ── Dates, and refusing to read one ─────────────────────────────────────────
console.log('\na date is a calendar day, or it is nothing');

check(locks._internals.dayOf('2026-08-16T04:00:00Z') === '2026-08-16', 'an ISO instant reads as its day');
check(locks._internals.dayOf('8/16/2026') === '2026-08-16', 'a US date reads as the same day');
check(locks._internals.dayOf('16/8/2026') === null, 'a day-first date is REFUSED rather than read as 16 August');
check(locks._internals.dayOf('') === null && locks._internals.dayOf(null) === null
   && locks._internals.dayOf('soon') === null && locks._internals.dayOf('0000-00-00') === null,
  'and anything unreadable states nothing');

// ── It cannot break a sync ──────────────────────────────────────────────────
console.log('\nit can never break the pass that carries it');

for (const junk of [null, undefined, {}, { rateLock: null }, { rateLock: 'locked' }, { rateLock: [] }]) {
  const out = locks.lockFromLoan(junk, null, S, TODAY);
  if (!out || out.expirationDate !== null || out.posture !== 'not_locked') {
    failures += 1; console.error(`  FAIL a malformed loan (${JSON.stringify(junk)}) answers "nothing recorded"`);
  }
}
check(true, 'a malformed or empty loan answers "nothing recorded" instead of throwing');

// ── What we may claim to have watched ───────────────────────────────────────
console.log('\nthe history claims only what two snapshots prove');

const ev = locks._internals.eventTypeFor;
check(ev(null, { status: 'Locked' }) === 'observed_lock', 'the first posture we ever see is recorded as observed');
check(ev({ lock_status: 'Locked', expiration_date: '2026-09-01' }, { status: 'Locked', expirationDate: '2026-09-20' })
  === 'observed_extension', 'an expiration that moved OUT is an observed extension');
check(ev({ lock_status: 'Locked', expiration_date: '2026-09-20' }, { status: 'Locked', expirationDate: '2026-09-01' })
  === 'observed_expiration_moved_in', '…and one that moved IN is named for what it is, not called an extension');
check(ev({ lock_status: 'Locked', expiration_date: '2026-09-01' }, { status: 'Cancelled', expirationDate: '2026-09-01' })
  === 'observed_status_change', 'a status word that moved is a status change');
check(['observed_lock', 'observed_extension', 'observed_expiration_moved_in', 'observed_status_change', 'observed_change']
  .every((t) => t.startsWith('observed_')),
  'EVERY event type says "observed": we are watching two snapshots, not reading a request history, and the names must not pretend otherwise');

const same = locks._internals.changed(
  { lock_status: 'Locked', expiration_date: '2026-09-20', note_rate_pct: '7.12500' },
  { status: 'Locked', expirationDate: '2026-09-20', noteRatePct: 7.125 },
);
check(same === false,
  'a re-read that changed nothing writes no event — a history that grows on every sync is not a history');

// ── The settings that drive it ──────────────────────────────────────────────
console.log('\nevery lender-specific value is a setting');

for (const k of ['lock.lockDateFieldId', 'lock.expirationFieldId', 'lock.lockedStatuses',
  'lock.unlockedStatuses', 'lock.expiringSoonDays']) {
  check(decl.definition(k) !== null, `"${k}" is declared`);
}
check(JSON.stringify(S['lock.lockedStatuses']) === JSON.stringify(locks.DEFAULT_LOCKED_WORDS)
   && JSON.stringify(S['lock.unlockedStatuses']) === JSON.stringify(locks.DEFAULT_UNLOCKED_WORDS),
  'the declared word lists match the module\'s own fallbacks exactly — two lists that disagree is one lender behaving two ways');
check(locks.fieldIdsFor(S).length === 2 && locks.fieldIdsFor({ 'lock.lockDateFieldId': '761', 'lock.expirationFieldId': '761' }).length === 1,
  'the field ids are deduped, because one duplicate id 400s a whole fieldReader batch');

// ── Read-only ───────────────────────────────────────────────────────────────
console.log('\nnothing here can write to Encompass');

const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/longterm/locks.js'), 'utf8');
check(!/apiPost|apiPut|apiPatch|apiDelete|fetch\(/.test(src),
  'the module makes no outbound call at all — it reads the loan the sync already fetched');
// `DO UPDATE SET` is the upsert's own clause and names no table — matching it would
// flag every ON CONFLICT in the repo, which is how a guard gets deleted for crying wolf.
const writes = [...src.matchAll(/\b(?:INSERT\s+INTO|UPDATE)\s+(?!SET\b)([a-zA-Z_][\w.]*)/gi)].map((m) => m[1]);
check(writes.length > 0 && writes.every((t) => /^lt_/.test(t)),
  `and every table it writes is an lt_ one (${[...new Set(writes)].join(', ')})`);

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

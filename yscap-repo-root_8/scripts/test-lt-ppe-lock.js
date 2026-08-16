'use strict';
/**
 * Pure offline test for the LT PPE lock lifecycle + frozen stack (src/longterm/ppe/lock.js).
 * Uses the REAL pricing.priceRung to produce the build that gets frozen.
 *   node scripts/test-lt-ppe-lock.js
 */

const assert = require('assert');
const L = require('../src/longterm/ppe/lock');
const { priceRung } = require('../src/longterm/ppe/pricing');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };
const threw = (fn) => { try { fn(); return false; } catch { return true; } };

const NOW = 1_700_000_000_000;
const DAY = L.DAY_MS;

// a real price build
const build = priceRung({ rate: 71250, basePriceMilli: 102850, marginMilli: 250, roundingMode: 'none', adjustments: [{ code: 'cashout', category: 'purpose', adjMilli: 500 }] });

// ---- state machine ----------------------------------------------------------
(() => {
  eq(L.transitionLock(L.STATES.FLOATING, 'request').state, L.STATES.LOCK_REQUESTED, 'floating -> lock_requested');
  eq(L.transitionLock(L.STATES.LOCK_REQUESTED, 'confirm').state, L.STATES.LOCKED, 'lock_requested -> locked');
  ok(!L.transitionLock(L.STATES.FLOATING, 'confirm').ok, 'cannot confirm from floating');
  eq(L.transitionLock(L.STATES.LOCKED, 'reprice').state, L.STATES.REPRICE_PENDING, 'locked -> reprice_pending');
  eq(L.transitionLock(L.STATES.REPRICE_PENDING, 'resolveReprice').state, L.STATES.LOCKED, 'reprice_pending -> locked');
  eq(L.transitionLock(L.STATES.LOCKED, 'expire').state, L.STATES.EXPIRED, 'locked -> expired');
  eq(L.transitionLock(L.STATES.EXPIRED, 'relock').state, L.STATES.LOCKED, 'expired -> relock');
  eq(L.transitionLock(L.STATES.LOCKED, 'purchase').state, L.STATES.PURCHASED, 'locked -> purchased');
  eq(L.transitionLock(L.STATES.LOCKED, 'cancel').state, L.STATES.CANCELLED, 'cancel from any non-terminal');
  eq(L.transitionLock(L.STATES.FLOATING, 'withdraw').state, L.STATES.WITHDRAWN, 'withdraw from any non-terminal');
  ok(!L.transitionLock(L.STATES.PURCHASED, 'cancel').ok, 'cannot cancel a terminal lock');
  ok(!L.transitionLock(L.STATES.LOCKED, 'bogus').ok, 'unknown action rejected');
})();

// ---- freezeSnapshot + hash --------------------------------------------------
(() => {
  const lock = L.freezeSnapshot(build, { lockId: 'L1', loanId: 'A1', lockedAtMs: NOW, lockPeriodDays: 30, channel: 'correspondent', commitmentType: 'BE', investor: 'DHVN', product: 'DSCR30', actor: 'desk' });
  eq(lock.state, L.STATES.LOCKED, 'a fresh snapshot is locked');
  eq(lock.netPriceMilli, build.finalPriceMilli, 'net price = the build final price');
  eq(lock.expiresAtMs, NOW + 30 * DAY, 'expiry = locked + period days');
  eq(lock.noteRate, 71250, 'note rate carried');
  ok(lock.snapshotHash && lock.snapshotHash.length === 64, 'snapshot hashed (sha256)');
  ok(L.snapshotIntact(lock), 'snapshot hash matches its build');
  ok(Object.isFrozen(lock.build), 'the frozen build is immutable');
  eq(lock.subRecords.length, 0, 'no sub-records yet');
  ok(threw(() => L.freezeSnapshot(null, {})), 'refuses without a price build');

  // tamper detection
  const tampered = { ...lock, build: { ...lock.build, finalPriceMilli: 999999 } };
  ok(!L.snapshotIntact(tampered), 'a changed build fails the hash check');
})();

// ---- append never mutates the original --------------------------------------
(() => {
  const lock = L.freezeSnapshot(build, { lockId: 'L1', lockedAtMs: NOW, lockPeriodDays: 30 });
  const next = L.appendSubRecord(lock, { kind: 'note', foo: 1 });
  eq(lock.subRecords.length, 0, 'original sub-records untouched');
  eq(next.subRecords.length, 1, 'new lock has the sub-record');
  eq(next.snapshotHash, lock.snapshotHash, 'the frozen hash is unchanged by an append');
})();

// ---- worst-case -------------------------------------------------------------
eq(L.worstCasePrice(102000, 101000), 101000, 'worst-case takes the lower price');
eq(L.worstCasePrice(101000, 102000), 101000, 'worst-case keeps the original when market is higher');

// ---- expiry + disbursement hard-block --------------------------------------
(() => {
  const lock = L.freezeSnapshot(build, { lockedAtMs: NOW, lockPeriodDays: 30 });
  ok(!L.isExpired(lock, NOW + 10 * DAY), 'not expired within the period');
  ok(L.isExpired(lock, NOW + 31 * DAY), 'expired past the period');
  ok(L.disbursementAllowed(lock, NOW + 10 * DAY), 'a live locked loan may disburse');
  ok(!L.disbursementAllowed(lock, NOW + 31 * DAY), 'an expired lock is hard-blocked from disbursing');
  const cancelled = { ...lock, state: L.STATES.CANCELLED };
  ok(!L.disbursementAllowed(cancelled, NOW), 'a cancelled lock cannot disburse');
})();

// ---- extend -----------------------------------------------------------------
(() => {
  const lock = L.freezeSnapshot(build, { lockedAtMs: NOW, lockPeriodDays: 30 });
  const ext = L.extend(lock, { days: 7, feeMilli: 175, nowMs: NOW + 5 * DAY, actor: 'desk' });
  eq(ext.expiresAtMs, lock.expiresAtMs + 7 * DAY, 'expiry pushed by the extension days');
  eq(ext.netPriceMilli, lock.netPriceMilli, 'the frozen net price is UNCHANGED by an extension');
  eq(ext.subRecords[0].kind, 'extension', 'extension sub-record appended');
  eq(ext.subRecords[0].feeMilli, 175, 'caller-supplied fee recorded');
  ok(threw(() => L.extend(lock, { days: 0 })), 'refuses a non-positive extension');
})();

// ---- relock under worst-case ------------------------------------------------
(() => {
  const lock = L.freezeSnapshot(build, { lockedAtMs: NOW, lockPeriodDays: 30 });
  const expired = { ...lock, state: L.STATES.EXPIRED };
  // market improved (higher price) -> worst-case keeps the original locked net
  const r1 = L.relock(expired, { currentMarketMilli: lock.netPriceMilli + 1000, feeMilli: 250, lockPeriodDays: 30, nowMs: NOW + 31 * DAY, actor: 'desk' });
  eq(r1.state, L.STATES.LOCKED, 'relock returns to locked');
  eq(r1.netPriceMilli, lock.netPriceMilli, 'worst-case: original kept when market is better');
  eq(r1.relocked, true, 'relocked flag set');
  eq(r1.noFurtherExtension, true, 'no further extension after a relock');
  eq(r1.subRecords[0].kind, 'relock', 'relock sub-record appended');
  eq(r1.expiresAtMs, NOW + 31 * DAY + 30 * DAY, 'new expiry from the relock instant');
  ok(threw(() => L.extend(r1, { days: 7 })), 'cannot extend after a relock');

  // market worsened (lower price) -> worst-case takes the current market
  const r2 = L.relock(expired, { currentMarketMilli: lock.netPriceMilli - 1000, feeMilli: 250, nowMs: NOW + 31 * DAY });
  eq(r2.netPriceMilli, lock.netPriceMilli - 1000, 'worst-case: worse market wins');
  ok(threw(() => L.relock(lock, {})), 'cannot relock a non-expired lock');
})();

// ---- reprice-on-change under worst-case ------------------------------------
(() => {
  const lock = L.freezeSnapshot(build, { lockedAtMs: NOW, lockPeriodDays: 30 });
  const up = L.repriceUnderWorstCase(lock, lock.netPriceMilli + 500, { reason: 'ltv_changed', nowMs: NOW });
  eq(up.netPriceMilli, lock.netPriceMilli, 'reprice never silently RAISES a locked price');
  const down = L.repriceUnderWorstCase(lock, lock.netPriceMilli - 500, { reason: 'fico_dropped', nowMs: NOW });
  eq(down.netPriceMilli, lock.netPriceMilli - 500, 'reprice applies a worse market');
  eq(down.subRecords[0].kind, 'reprice', 'reprice sub-record appended');
  eq(down.subRecords[0].reason, 'fico_dropped', 'reprice reason recorded');
})();

console.log(`ok - lt ppe lock (${n} assertions)`);

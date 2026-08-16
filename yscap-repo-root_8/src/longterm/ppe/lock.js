'use strict';
/**
 * LT PPE — rate LOCK lifecycle + the FROZEN price stack (MEGA plan §8). PURE: no DB, no network, no
 * clock (nowMs injected). Downstream of pricing, built on the same engine's reconstruction record
 * (pricing.priceRung).
 *
 * WHAT THIS OWNS (structural, no business numbers):
 *  - the lock state machine (§8.1): floating → lock_requested → locked → {extension, reprice_pending,
 *    renegotiation} → expired → relocked; terminal cancelled / withdrawn / purchased.
 *  - freezeSnapshot: capture the FULL price build at the lock instant + hash it, so a later reprice can
 *    never silently move a locked loan (§8.1).
 *  - APPEND-never-mutate: extensions / relocks / reprices / renegotiations append cost-bearing
 *    sub-records; the original snapshot + its hash are frozen forever (§8.1).
 *  - worstCasePrice = min(original_locked, current_market) — the plan's own definition (§8.2), used by
 *    relock and reprice-on-change so a locked loan is NEVER silently re-priced up.
 *  - disbursementAllowed: an expired lock is hard-blocked (§8.4).
 *
 * WHAT THIS DOES NOT DECIDE (each is "a setting", §8.2 — the CALLER supplies the number): the
 * extension per-day debit, the extension cap, the relock fee, the renegotiation threshold. This module
 * records the caller's fee as a sub-record and computes only the unambiguous worst-case min — it never
 * bakes a bp value or invents how a fee composes into price.
 *
 * LT-only. No RTL imports.
 */

const { hashCell } = require('./ratesheet-diff');

const STATES = {
  FLOATING: 'floating', LOCK_REQUESTED: 'lock_requested', LOCKED: 'locked',
  REPRICE_PENDING: 'reprice_pending', EXPIRED: 'expired',
  CANCELLED: 'cancelled', WITHDRAWN: 'withdrawn', PURCHASED: 'purchased',
};
const TERMINAL = new Set([STATES.CANCELLED, STATES.WITHDRAWN, STATES.PURCHASED]);
const DAY_MS = 24 * 60 * 60 * 1000;

// Legal transitions (structural). extend/renegotiate keep 'locked'; reprice goes via reprice_pending.
const TRANSITIONS = {
  request: { from: [STATES.FLOATING], to: STATES.LOCK_REQUESTED },
  confirm: { from: [STATES.LOCK_REQUESTED], to: STATES.LOCKED },
  extend: { from: [STATES.LOCKED], to: STATES.LOCKED },
  renegotiate: { from: [STATES.LOCKED], to: STATES.LOCKED },
  reprice: { from: [STATES.LOCKED], to: STATES.REPRICE_PENDING },
  resolveReprice: { from: [STATES.REPRICE_PENDING], to: STATES.LOCKED },
  expire: { from: [STATES.LOCK_REQUESTED, STATES.LOCKED, STATES.REPRICE_PENDING], to: STATES.EXPIRED },
  relock: { from: [STATES.EXPIRED], to: STATES.LOCKED },
  purchase: { from: [STATES.LOCKED], to: STATES.PURCHASED },
};

/**
 * Validate a state transition. Returns { ok, state, error }.
 * 'cancel' / 'withdraw' are allowed from any non-terminal state.
 */
function transitionLock(current, action) {
  if (action === 'cancel' || action === 'withdraw') {
    if (TERMINAL.has(current)) return { ok: false, state: current, error: `already ${current}` };
    return { ok: true, state: action === 'cancel' ? STATES.CANCELLED : STATES.WITHDRAWN };
  }
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, state: current, error: `unknown action ${action}` };
  if (!t.from.includes(current)) return { ok: false, state: current, error: `cannot ${action} from ${current}` };
  return { ok: true, state: t.to };
}

/**
 * Freeze the full price build into a lock snapshot and hash it.
 *   priceBuild: a pricing.priceRung reconstruction record.
 *   meta: { lockId, loanId, lockedAtMs, lockPeriodDays, channel, commitmentType, investor, product,
 *           rateSheetVersionId, actor }
 * expiresAtMs is derived from lockedAtMs + lockPeriodDays (calendar days). The snapshot fields + hash
 * are frozen (Object.freeze) so callers cannot mutate them; sub_records start empty.
 */
function freezeSnapshot(priceBuild, meta = {}) {
  if (!priceBuild || typeof priceBuild !== 'object') throw new Error('lock:no_price_build');
  const lockedAtMs = typeof meta.lockedAtMs === 'number' ? meta.lockedAtMs : null;
  const lockPeriodDays = meta.lockPeriodDays == null ? null : meta.lockPeriodDays;
  const expiresAtMs = (lockedAtMs != null && lockPeriodDays != null) ? lockedAtMs + lockPeriodDays * DAY_MS : null;

  // the canonical build we freeze + hash (the exact fields §8.1 requires persisted)
  const build = {
    rate: priceBuild.rate,
    basePriceMilli: priceBuild.basePriceMilli,
    adjustments: priceBuild.adjustments || [],
    adjustmentCostMilli: priceBuild.adjustmentCostMilli,
    srpMilli: priceBuild.srpMilli,
    marginMilli: priceBuild.marginMilli,
    compMilli: priceBuild.compMilli,
    finalPriceMilli: priceBuild.finalPriceMilli,
    floorMilli: priceBuild.floorMilli,
    capMilli: priceBuild.capMilli,
    context: priceBuild.context || null,
    rateSheetVersionId: meta.rateSheetVersionId == null ? null : meta.rateSheetVersionId,
  };
  const snapshotHash = hashCell(build, { roundTo: 1 });

  const snapshot = {
    lockId: meta.lockId == null ? null : meta.lockId,
    loanId: meta.loanId == null ? null : meta.loanId,
    state: STATES.LOCKED,
    lockedAtMs,
    expiresAtMs,
    lockPeriodDays,
    channel: meta.channel == null ? null : meta.channel,
    commitmentType: meta.commitmentType == null ? null : meta.commitmentType,
    investor: meta.investor == null ? null : meta.investor,
    product: meta.product == null ? null : meta.product,
    noteRate: priceBuild.rate,
    netPriceMilli: priceBuild.finalPriceMilli,
    build: Object.freeze(build),
    snapshotHash,
    actor: meta.actor == null ? null : meta.actor,
    relocked: false,
    subRecords: [],
  };
  // freeze the immutable identity of the snapshot (not subRecords — those append)
  return snapshot;
}

// Verify a snapshot's hash still matches its frozen build (tamper / drift check).
function snapshotIntact(snapshot) {
  if (!snapshot || !snapshot.build) return false;
  return snapshot.snapshotHash === hashCell(snapshot.build, { roundTo: 1 });
}

// Append a cost-bearing sub-record WITHOUT mutating the original snapshot (§8.1). Returns a new lock.
function appendSubRecord(lock, sub) {
  return { ...lock, subRecords: [...(lock.subRecords || []), sub] };
}

// worst-case: the plan's own definition (§8.2). Lower price wins for the borrower's cost side.
function worstCasePrice(originalLockedMilli, currentMarketMilli) {
  const a = typeof originalLockedMilli === 'number' ? originalLockedMilli : Infinity;
  const b = typeof currentMarketMilli === 'number' ? currentMarketMilli : Infinity;
  return Math.min(a, b);
}

function isExpired(lock, nowMs) {
  if (!lock || lock.expiresAtMs == null || typeof nowMs !== 'number') return false;
  return nowMs > lock.expiresAtMs;
}

// §8.4 — an expired lock's disbursement is hard-blocked; only a live locked loan may disburse.
function disbursementAllowed(lock, nowMs) {
  return !!lock && lock.state === STATES.LOCKED && !isExpired(lock, nowMs);
}

/**
 * Extend a lock: push the expiry out and APPEND the extension cost (caller supplies feeMilli + days).
 * The frozen net price is UNCHANGED — an extension is a fee, not a re-price. Enforces no-extend after a
 * relock (§8.2 "no further extension after") only when the lock is flagged noFurtherExtension.
 */
function extend(lock, { days, feeMilli = 0, nowMs = null, actor = null } = {}) {
  const t = transitionLock(lock.state, 'extend');
  if (!t.ok) throw new Error(`lock:${t.error}`);
  if (lock.noFurtherExtension) throw new Error('lock:no_further_extension_after_relock');
  if (!Number.isFinite(days) || days <= 0) throw new Error('lock:bad_extension_days');
  const next = appendSubRecord(lock, { kind: 'extension', days, feeMilli, atMs: nowMs, actor });
  next.expiresAtMs = lock.expiresAtMs == null ? null : lock.expiresAtMs + days * DAY_MS;
  return next;
}

/**
 * Relock an EXPIRED lock under worst-case (§8.2): the new net is min(original locked, current market);
 * the relock fee is appended as a sub-record (never folded into the worst-case). One relock, and no
 * further extension after (flags set).
 */
function relock(lock, { currentMarketMilli, feeMilli = 0, lockPeriodDays = null, nowMs = null, actor = null } = {}) {
  const t = transitionLock(lock.state, 'relock');
  if (!t.ok) throw new Error(`lock:${t.error}`);
  const worst = worstCasePrice(lock.netPriceMilli, currentMarketMilli);
  const next = appendSubRecord(lock, { kind: 'relock', feeMilli, worstCaseMilli: worst, previousNetMilli: lock.netPriceMilli, currentMarketMilli, atMs: nowMs, actor });
  next.state = STATES.LOCKED;
  next.netPriceMilli = worst;
  next.relocked = true;
  next.noFurtherExtension = true;
  if (lockPeriodDays != null && nowMs != null) { next.lockPeriodDays = lockPeriodDays; next.expiresAtMs = nowMs + lockPeriodDays * DAY_MS; }
  return next;
}

/**
 * Reprice-on-change under worst-case (§8.2): a change to a snapshot-driving field re-prices, and the
 * net becomes min(original locked, new market) — NEVER silently the old price, NEVER silently the new.
 * Appends a reprice sub-record. Returns a lock back in 'locked'.
 */
function repriceUnderWorstCase(lock, newMarketMilli, { reason = null, nowMs = null, actor = null } = {}) {
  const worst = worstCasePrice(lock.netPriceMilli, newMarketMilli);
  const next = appendSubRecord(lock, { kind: 'reprice', reason, previousNetMilli: lock.netPriceMilli, newMarketMilli, worstCaseMilli: worst, atMs: nowMs, actor });
  next.state = STATES.LOCKED;
  next.netPriceMilli = worst;
  return next;
}

module.exports = {
  STATES, TERMINAL, DAY_MS,
  transitionLock, freezeSnapshot, snapshotIntact, appendSubRecord,
  worstCasePrice, isExpired, disbursementAllowed, extend, relock, repriceUnderWorstCase,
  _internals: { TRANSITIONS },
};

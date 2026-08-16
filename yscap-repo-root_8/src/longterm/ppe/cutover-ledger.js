'use strict';
/**
 * LT PPE — the cutover DECISION LEDGER (§11): an append-only, replayable history of an investor's
 * lifecycle moves (draft → shadow → live → retired), each stamped with WHO decided, WHEN, from→to, the
 * REASON, and the agreement SCOREBOARD as it stood at that moment.
 *
 * `cutover.transition` decides whether ONE move is legal; this manages the SEQUENCE — it never
 * re-implements the legality rule, it delegates every step to `cutover.transition` (one definition), so
 * the ledger and the live gate can never disagree about what "promote" requires. Promotion to live is
 * HUMAN-GATED (§1.2/§11): a promote decision must carry `eligible:true` (which the caller gets from
 * `scoreboard.assemble(...).eligible.eligible`) or it is refused with the gate's own reason.
 *
 * Pure + clock-injected (the caller supplies `atMs`), so the whole promote/rollback lifecycle is
 * offline-testable and the persisted history is just an array of these entries. LT-only; no RTL import.
 */

const cutover = require('./cutover');

function isNonEmpty(s) { return typeof s === 'string' && s.trim() !== ''; }
function isFiniteNum(n) { return typeof n === 'number' && Number.isFinite(n); }

// The current mode is the `to` of the highest-seq entry; an empty history is DRAFT (the birth state).
function currentMode(history = []) {
  const list = Array.isArray(history) ? history.filter(Boolean) : [];
  if (!list.length) return cutover.MODES.DRAFT;
  const last = list.reduce((a, b) => ((b.seq || 0) >= (a.seq || 0) ? b : a), list[0]);
  return last.to;
}

function nextSeq(history = []) {
  const list = Array.isArray(history) ? history.filter(Boolean) : [];
  return list.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
}

/**
 * Append one lifecycle decision, delegating legality to cutover.transition.
 *   decision: { action, by, atMs, reason, eligible?, scoreboard? }
 *     action    — 'activate' | 'promote' | 'rollback' | 'retire' | 'reopen'
 *     by        — the human (or system actor) making the call (required — this is an audit trail)
 *     atMs      — the injected clock
 *     reason    — required (every governance move is explained)
 *     eligible  — REQUIRED true for 'promote' (from the scoreboard gate); ignored otherwise
 *     scoreboard— the scoreboard snapshot at decision time (optional, recorded verbatim)
 * Returns { ok, entry, history, error }. On refusal the history is returned UNCHANGED.
 */
function applyDecision(history = [], decision = {}) {
  const list = Array.isArray(history) ? history.filter(Boolean) : [];
  const { action } = decision;
  if (!isNonEmpty(action)) return { ok: false, history: list, error: 'an action is required' };
  if (!isNonEmpty(decision.by)) return { ok: false, history: list, error: 'a decision must record who made it' };
  if (!isNonEmpty(decision.reason)) return { ok: false, history: list, error: 'a decision must record a reason' };
  if (!isFiniteNum(decision.atMs)) return { ok: false, history: list, error: 'a decision must be stamped with a time' };

  const current = currentMode(list);
  const t = cutover.transition(current, action, { eligible: decision.eligible });
  if (!t.ok) return { ok: false, history: list, error: t.error };

  const entry = {
    seq: nextSeq(list),
    action,
    from: current,
    to: t.mode,
    by: decision.by,
    atMs: decision.atMs,
    reason: decision.reason,
    eligible: decision.eligible === true,
    scoreboard: decision.scoreboard == null ? null : decision.scoreboard,
  };
  return { ok: true, entry, history: [...list, entry] };
}

/**
 * Replay the whole history from DRAFT and confirm every step is legal and internally consistent
 * (each entry's `from` equals the running mode, and cutover.transition would have allowed it).
 * Returns { ok, mode, brokenAt, error }. `brokenAt` is the seq of the first bad entry (null if clean).
 */
function validateHistory(history = []) {
  const list = (Array.isArray(history) ? history.filter(Boolean) : []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  let mode = cutover.MODES.DRAFT;
  for (const e of list) {
    if (e.from !== mode) return { ok: false, mode, brokenAt: e.seq || null, error: `entry ${e.seq} says from=${e.from} but the mode was ${mode}` };
    const t = cutover.transition(mode, e.action, { eligible: e.eligible });
    if (!t.ok) return { ok: false, mode, brokenAt: e.seq || null, error: `entry ${e.seq}: ${t.error}` };
    if (t.mode !== e.to) return { ok: false, mode, brokenAt: e.seq || null, error: `entry ${e.seq} recorded to=${e.to} but the rule leads to ${t.mode}` };
    mode = e.to;
  }
  return { ok: true, mode, brokenAt: null, error: null };
}

// The newest entry that LANDED on `mode` (e.g. lastTransitionTo(h, 'live') → when it last went live).
function lastTransitionTo(history = [], mode) {
  const list = (Array.isArray(history) ? history.filter(Boolean) : []).filter((e) => e.to === mode);
  if (!list.length) return null;
  return list.reduce((a, b) => ((b.seq || 0) >= (a.seq || 0) ? b : a), list[0]);
}

// Whole-tenure days at the current mode (since the last decision). null when unknowable.
function daysInCurrentMode(history = [], nowMs) {
  const list = Array.isArray(history) ? history.filter(Boolean) : [];
  if (!list.length || !isFiniteNum(nowMs)) return null;
  const last = list.reduce((a, b) => ((b.seq || 0) >= (a.seq || 0) ? b : a), list[0]);
  if (!isFiniteNum(last.atMs)) return null;
  return Math.max(0, Math.floor((nowMs - last.atMs) / cutover.DAY_MS));
}

/** A one-glance summary for an admin surface. */
function summarize(history = [], opts = {}) {
  const list = Array.isArray(history) ? history.filter(Boolean) : [];
  const wentLive = lastTransitionTo(list, cutover.MODES.LIVE);
  return {
    mode: currentMode(list),
    decisions: list.length,
    lastDecision: list.length ? list.reduce((a, b) => ((b.seq || 0) >= (a.seq || 0) ? b : a), list[0]) : null,
    liveSince: wentLive ? wentLive.atMs : null,
    daysInMode: daysInCurrentMode(list, opts.nowMs),
    valid: validateHistory(list).ok,
  };
}

module.exports = {
  currentMode, applyDecision, validateHistory, lastTransitionTo, daysInCurrentMode, summarize,
  _internals: { nextSeq },
};

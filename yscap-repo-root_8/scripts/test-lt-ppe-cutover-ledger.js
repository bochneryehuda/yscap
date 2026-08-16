'use strict';
/**
 * Pure offline test for the LT PPE cutover decision ledger (src/longterm/ppe/cutover-ledger.js).
 *   node scripts/test-lt-ppe-cutover-ledger.js
 */

const assert = require('assert');
const L = require('../src/longterm/ppe/cutover-ledger');
const cutover = require('../src/longterm/ppe/cutover');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const M = cutover.MODES;
const DAY = cutover.DAY_MS;
const T0 = 1_700_000_000_000;

// append helper that fails loudly so a mis-step can't pass silently
function must(res, label) { ok(res.ok, `${label}${res.ok ? '' : ' — ' + res.error}`); return res.history; }

// ---- empty history is DRAFT ----
eq(L.currentMode([]), M.DRAFT, 'empty history -> draft');
eq(L.currentMode(), M.DRAFT, 'undefined history -> draft');

// ---- a full legal lifecycle: draft -> shadow -> live -> shadow -> live -> retired ----
let h = [];
h = must(L.applyDecision(h, { action: 'activate', by: 'ops', atMs: T0, reason: 'start shadowing DHVN' }), 'activate');
eq(L.currentMode(h), M.SHADOW, 'after activate -> shadow');

// promote WITHOUT eligibility is refused with the gate's own reason, history untouched
{
  const r = L.applyDecision(h, { action: 'promote', by: 'admin', atMs: T0 + DAY, reason: 'go live' });
  eq(r.ok, false, 'promote without eligible is refused');
  ok(/not eligible/i.test(r.error), 'refusal carries the gate reason');
  eq(r.history.length, h.length, 'a refused decision does not grow the history');
}

h = must(L.applyDecision(h, { action: 'promote', by: 'admin', atMs: T0 + 14 * DAY, reason: '14 clean days, canary 100%', eligible: true, scoreboard: { openFindings: 0, consecutiveCleanDays: 14 } }), 'promote');
eq(L.currentMode(h), M.LIVE, 'after promote -> live');

h = must(L.applyDecision(h, { action: 'rollback', by: 'admin', atMs: T0 + 20 * DAY, reason: 'a disagreement surfaced' }), 'rollback');
eq(L.currentMode(h), M.SHADOW, 'rollback -> shadow');

h = must(L.applyDecision(h, { action: 'promote', by: 'admin', atMs: T0 + 30 * DAY, reason: 're-promote after fix', eligible: true }), 're-promote');
h = must(L.applyDecision(h, { action: 'retire', by: 'ops', atMs: T0 + 40 * DAY, reason: 'investor paused business' }), 'retire');
eq(L.currentMode(h), M.RETIRED, 'retire -> retired');

// seqs are contiguous 1..N and the scoreboard snapshot was recorded
eq(h.length, 5, 'five recorded decisions');
eq(h[0].seq, 1, 'seq starts at 1');
eq(h[4].seq, 5, 'seq is contiguous');
eq(h[1].scoreboard.consecutiveCleanDays, 14, 'the promote entry kept its scoreboard snapshot');
eq(h[1].from, M.SHADOW, 'promote from-mode recorded');
eq(h[1].to, M.LIVE, 'promote to-mode recorded');

// ---- every governance field is required ----
{
  const base = { action: 'activate', by: 'x', atMs: T0, reason: 'r' };
  eq(L.applyDecision([], { ...base, by: '' }).ok, false, 'refuses a decision with no actor');
  eq(L.applyDecision([], { ...base, reason: '' }).ok, false, 'refuses a decision with no reason');
  eq(L.applyDecision([], { ...base, atMs: null }).ok, false, 'refuses a decision with no time');
  eq(L.applyDecision([], { ...base, action: 'nonsense' }).ok, false, 'refuses an unknown action');
  // an illegal-from-here action is refused (can't promote straight from draft)
  eq(L.applyDecision([], { action: 'promote', by: 'x', atMs: T0, reason: 'r', eligible: true }).ok, false, 'cannot promote from draft');
}

// ---- validateHistory replays and confirms the chain ----
{
  const v = L.validateHistory(h);
  eq(v.ok, true, 'the built history validates');
  eq(v.mode, M.RETIRED, 'replay lands on retired');
  eq(v.brokenAt, null, 'nothing broken');

  // a tampered entry (illegal jump) is caught at its seq
  const bad = h.map((e) => (e.seq === 3 ? { ...e, to: M.LIVE } : e)); // rollback that "stays" live
  const bv = L.validateHistory(bad);
  eq(bv.ok, false, 'a tampered to-mode is caught');
  eq(bv.brokenAt, 3, 'the break is located at the tampered seq');

  // out-of-order storage is tolerated (sorted by seq before replay)
  const shuffled = [...h].reverse();
  eq(L.validateHistory(shuffled).ok, true, 'validation sorts by seq, so storage order does not matter');
}

// ---- lastTransitionTo / liveSince / daysInMode ----
{
  const live = L.lastTransitionTo(h, M.LIVE);
  eq(live.seq, 4, 'lastTransitionTo(live) is the most recent live promotion, not the first');
  eq(L.lastTransitionTo(h, M.DRAFT), null, 'never returned to draft -> null');

  const s = L.summarize(h, { nowMs: T0 + 45 * DAY });
  eq(s.mode, M.RETIRED, 'summary mode');
  eq(s.decisions, 5, 'summary decision count');
  eq(s.liveSince, T0 + 30 * DAY, 'liveSince is the last promotion time');
  eq(s.daysInMode, 5, 'days in current mode since the last decision');
  eq(s.valid, true, 'summary validity');
  eq(s.lastDecision.action, 'retire', 'summary last decision');
}

// ---- a retired investor can reopen to draft ----
{
  const h2 = must(L.applyDecision(h, { action: 'reopen', by: 'ops', atMs: T0 + 60 * DAY, reason: 'investor came back' }), 'reopen');
  eq(L.currentMode(h2), M.DRAFT, 'reopen -> draft');
  eq(L.validateHistory(h2).ok, true, 'reopened history still valid');
}

console.log(`ok - lt ppe cutover ledger (${n} assertions)`);

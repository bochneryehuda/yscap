'use strict';
/**
 * R6.15 — pure tests for the debounced whole-loan run trigger.
 * Proves it (1) SKIPs when no material event occurred, (2) DEFERs while a burst
 * is still arriving and RUNs once it settles, (3) coalesces a burst into ONE run
 * bounded by a max-defer ceiling, (4) SKIPs an event the last run already saw and
 * SKIPs when the context hash is unchanged, (5) honors a forced run, and (6)
 * never throws on junk.
 */
const assert = require('assert');
const rt = require('../src/lib/underwriting/run-trigger');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const T0 = 1_000_000_000_000; // a fixed base epoch ms
const DEB = rt.DEFAULT_DEBOUNCE_MS;

// --- no material events → skip ---
let d = rt.decideTrigger({ events: [{ kind: 'note_viewed', at: T0 }], now: T0 + 1000, lastRunAt: null });
assert.strictEqual(d.action, 'skip', 'a non-material event does not trigger a run');
d = rt.decideTrigger({ events: [], now: T0, lastRunAt: null });
assert.strictEqual(d.action, 'skip');
ok('no material event since the last run → skip');

// --- a fresh material event within the debounce window → defer, with a dueAt ---
d = rt.decideTrigger({ events: [{ kind: 'document_uploaded', at: T0 }], now: T0 + 5000, lastRunAt: null, contextHash: 'h2', lastContextHash: 'h1' });
assert.strictEqual(d.action, 'defer', 'a just-arrived event waits for the burst to settle');
assert.strictEqual(d.dueAt, T0 + DEB, 'due one debounce window after the event');
assert.strictEqual(d.waitMs, (T0 + DEB) - (T0 + 5000));
assert.strictEqual(d.trigger, 'document_uploaded');
ok('a fresh material event defers until the debounce window elapses');

// --- once the window elapses → run ---
d = rt.decideTrigger({ events: [{ kind: 'document_uploaded', at: T0 }], now: T0 + DEB + 1, lastRunAt: null, contextHash: 'h2', lastContextHash: 'h1' });
assert.strictEqual(d.action, 'run');
assert.strictEqual(d.waitMs, 0);
ok('after the debounce window the run fires');

// --- a burst coalesces: the newest event pushes the dueAt out (ONE run) ---
d = rt.decideTrigger({
  events: [
    { kind: 'document_uploaded', at: T0 },
    { kind: 'document_uploaded', at: T0 + 10_000 },
    { kind: 'condition_changed', at: T0 + 20_000 }, // newest
  ],
  now: T0 + 25_000, lastRunAt: null, contextHash: 'h2', lastContextHash: 'h1',
});
assert.strictEqual(d.action, 'defer', 'still within the window measured from the NEWEST event');
assert.strictEqual(d.dueAt, T0 + 20_000 + DEB, 'debounce is measured from the latest event in the burst');
assert.strictEqual(d.trigger, 'condition_changed', 'the trigger label is the newest material kind');
assert.strictEqual(d.materialEvents.length, 3);
ok('a burst coalesces into one deferred run measured from the newest event');

// --- max-defer ceiling: continuous activity still runs ---
d = rt.decideTrigger({
  events: [
    { kind: 'document_uploaded', at: T0 },                 // earliest
    { kind: 'document_uploaded', at: T0 + rt.DEFAULT_MAX_DEFER_MS }, // newest, still "now-ish"
  ],
  now: T0 + rt.DEFAULT_MAX_DEFER_MS + 1, lastRunAt: null, contextHash: 'h2', lastContextHash: 'h1',
  maxDeferMs: rt.DEFAULT_MAX_DEFER_MS,
});
assert.strictEqual(d.action, 'run', 'past the max-defer ceiling it runs despite ongoing activity');
assert.strictEqual(d.dueAt, T0 + rt.DEFAULT_MAX_DEFER_MS, 'dueAt capped at earliest + maxDefer');
assert.ok(/max defer/i.test(d.reason));
ok('the max-defer ceiling forces a run even while events keep arriving');

// --- an event the last run already saw is ignored ---
d = rt.decideTrigger({ events: [{ kind: 'document_uploaded', at: T0 }], now: T0 + DEB + 1, lastRunAt: T0 + 100 });
assert.strictEqual(d.action, 'skip', 'an event at/before lastRunAt was already covered');
ok('an event the last run already covered does not re-trigger');

// --- unchanged context hash → skip even with a material event ---
d = rt.decideTrigger({ events: [{ kind: 'status_changed', at: T0 + 5000 }], now: T0 + DEB + 6000, lastRunAt: T0, contextHash: 'same', lastContextHash: 'same' });
assert.strictEqual(d.action, 'skip', 'nothing actually changed (same source hash)');
assert.ok(/context unchanged/i.test(d.reason));
ok('a material event that left the context hash unchanged is skipped (dedup)');

// --- forced run fires immediately ---
d = rt.decideTrigger({ events: [], now: T0, lastRunAt: T0 - 1, force: true });
assert.strictEqual(d.action, 'run');
assert.strictEqual(d.trigger, 'manual_run');
assert.strictEqual(d.waitMs, 0);
ok('a forced/manual run fires immediately regardless of events');

// --- material events with no timestamps run now (can't be debounced) ---
d = rt.decideTrigger({ events: [{ kind: 'finding_added' }], now: T0, lastRunAt: null, contextHash: 'h2', lastContextHash: 'h1' });
assert.strictEqual(d.action, 'run', 'an untimed material event runs now');
ok('material events without timestamps run immediately (cannot be debounced)');

// --- ISO string timestamps parse ---
d = rt.decideTrigger({ events: [{ kind: 'document_uploaded', at: '2026-07-22T00:00:00Z' }], now: Date.parse('2026-07-22T00:00:05Z'), lastRunAt: null, contextHash: 'h2', lastContextHash: 'h1' });
assert.strictEqual(d.action, 'defer', 'ISO timestamps parse and debounce like epoch ms');
ok('ISO-string timestamps are parsed and debounced correctly');

// --- empty / junk / hostile input is safe ---
assert.doesNotThrow(() => rt.decideTrigger(null));
assert.strictEqual(rt.decideTrigger(null).action, 'skip');
assert.doesNotThrow(() => rt.decideTrigger({ events: 'notarray', now: T0 }));
assert.doesNotThrow(() => rt.decideTrigger({ events: [null, 'x', 42, {}], now: T0, lastRunAt: null }));
assert.strictEqual(rt.decideTrigger({ events: [null, 'x', 42, {}], now: T0 }).action, 'skip', 'junk events yield no material events');
assert.doesNotThrow(() => rt.decideTrigger({ events: [{ get kind() { throw new Error('boom'); }, at: T0 }], now: T0 }));
assert.doesNotThrow(() => rt.decideTrigger({ events: [{ kind: 'document_uploaded', get at() { throw new Error('boom'); } }], now: T0, contextHash: 'h2', lastContextHash: 'h1' }));
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\nR6.15 run-trigger pure — ${passed} checks passed`);

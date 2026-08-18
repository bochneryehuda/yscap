'use strict';
/**
 * Offline end-to-end test for the LT PPE daily drift RUN (src/longterm/ppe/lp-daily-run.js), driven by
 * an injected LP client, a fixed clock, and an in-memory store — NO network, NO timers, NO DB.
 *   node scripts/test-lt-lp-daily-run-pure.js
 *
 * Proves the composition end to end: first-run baseline (never applies/reviews), base-rate auto-apply
 * + rule review on the next day, ESCALATE-DON'T-DROP when a capture throws (the day is NOT stamped so
 * the next tick retries), and the tick running only the due investors. Mutation-proven — see report.
 */

const assert = require('assert');
const RUN = require('../src/longterm/ppe/lp-daily-run');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };
const utc = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi);

function makeStore() {
  const snapshots = new Map();
  const lastRun = new Map();
  const reviewSink = [];
  const appliedSink = [];
  return {
    snapshots, lastRun, reviewSink, appliedSink,
    async loadSnapshot(inv) { return snapshots.get(inv.toLowerCase()) || null; },
    async saveSnapshot(inv, s) { snapshots.set(inv.toLowerCase(), s); },
    async loadLastRunByInvestor() { return Object.fromEntries(lastRun); },
    async saveLastRunDay(inv, day) { lastRun.set(inv.toLowerCase(), day); },
    async applyBaseRates(inv, applied) { for (const a of applied) appliedSink.push({ inv, ...a }); },
    async enqueueReview(inv, items) { for (const it of items) reviewSink.push(it); },
  };
}

function makeClient(script) {
  return {
    calls: [],
    async captureSnapshot(inv) {
      this.calls.push(inv);
      const s = script[inv];
      return typeof s === 'function' ? s() : s;
    },
  };
}

const clockAt = (ms) => ({ now: () => ms });

async function main() {
  // ---- 1. FIRST RUN just baselines — never applies, never reviews ---------------------------------
  {
    const store = makeStore();
    const client = makeClient({ AcmeCap: { baseRates: { 'base/7.0': 102850 }, fingerprint: { 'llpa/ca': 500 } } });
    const rep = await RUN.runDailyForInvestor('AcmeCap', { lpClient: client, clock: clockAt(utc(2025, 6, 15, 14, 0)), store, config: {} });
    eq(rep.ok, true, 'first run ok');
    eq(rep.firstRun, true, 'flagged as first run');
    eq(rep.applied.length, 0, 'first run applies nothing (nothing to diff)');
    eq(rep.review.length, 0, 'first run reviews nothing');
    eq(store.lastRun.get('acmecap'), '2025-07-15', 'the ET day is stamped');
    ok(store.snapshots.get('acmecap'), 'the baseline snapshot is saved');
  }

  // ---- 2. NEXT DAY: base-rate move auto-applies; eligibility flip goes to the review sink ----------
  {
    const store = makeStore();
    const day1 = { baseRates: { 'base/7.0': 102850 }, fingerprint: { 'elig/ny': { allowed: true } } };
    const day2 = { baseRates: { 'base/7.0': 102900 }, fingerprint: { 'elig/ny': { allowed: false } } };
    const client = makeClient({ AcmeCap: () => (client.calls.length <= 1 ? day1 : day2) });

    await RUN.runDailyForInvestor('AcmeCap', { lpClient: client, clock: clockAt(utc(2025, 6, 15, 14, 0)), store, config: { maxDeltaMilli: 250, maxPct: 0.05 } });
    const rep = await RUN.runDailyForInvestor('AcmeCap', { lpClient: client, clock: clockAt(utc(2025, 6, 16, 14, 0)), store, config: { maxDeltaMilli: 250, maxPct: 0.05 } });

    eq(rep.firstRun, false, 'second capture is not a first run');
    eq(rep.applied.length, 1, 'the base-rate move auto-applies');
    eq(store.appliedSink.length, 1, 'the applied refresh reached the apply sink');
    eq(store.appliedSink[0].key, 'base/7.0', 'the right base-rate cell was applied');
    eq(rep.review.length, 1, 'the eligibility flip goes to review');
    eq(store.reviewSink.length, 1, 'the review item reached the human review queue');
    eq(store.reviewSink[0].dimension, 'eligibility', 'labelled eligibility');
    eq(store.lastRun.get('acmecap'), '2025-07-16', 'the new ET day is stamped');
  }

  // ---- 3. ESCALATE-DON'T-DROP: a capture that THROWS is reported and the day is NOT stamped --------
  {
    const store = makeStore();
    await RUN.runDailyForInvestor('AcmeCap', { lpClient: makeClient({ AcmeCap: { baseRates: {}, fingerprint: {} } }), clock: clockAt(utc(2025, 6, 15, 14, 0)), store, config: {} });
    store.lastRun.delete('acmecap'); // simulate: not yet run today
    const boom = { async captureSnapshot() { throw new Error('vendor 503'); } };
    const rep = await RUN.runDailyForInvestor('AcmeCap', { lpClient: boom, clock: clockAt(utc(2025, 6, 16, 14, 0)), store, config: {} });
    eq(rep.ok, false, 'a failed capture is not a success');
    eq(rep.reason, 'capture_failed', 'reason names the failure');
    ok(!store.lastRun.has('acmecap'), 'the day is NOT stamped, so the next tick retries — never silently skipped');
    eq(store.reviewSink.length, 0, 'nothing bogus is queued on a failed capture');
  }

  // ---- 4. the TICK runs only the due investors, and each runs its own capture ----------------------
  {
    const store = makeStore();
    const client = makeClient({
      TenCap: { baseRates: { 'base/7.0': 100 }, fingerprint: {} },
      ElevenCap: { baseRates: { 'base/7.0': 100 }, fingerprint: {} },
      NoonCap: { baseRates: { 'base/7.0': 100 }, fingerprint: {} },
    });
    const entries = [
      { investor: 'TenCap', hourEt: 10 },
      { investor: 'ElevenCap', hourEt: 11 },
      { investor: 'NoonCap', hourEt: 12 },
    ];
    const res = await RUN.tickDaily({ lpClient: client, clock: clockAt(utc(2025, 6, 15, 15, 30)), store, entries, config: {} }); // 11:30 EDT
    const ran = res.ran.map((r) => r.investor).sort();
    assert.deepStrictEqual(ran, ['ElevenCap', 'TenCap'], 'only the two past-hour investors ran'); n += 1;
    eq(res.held.length, 1, 'the noon investor is held');
    ok(!client.calls.includes('NoonCap'), 'the held investor was never captured — no wasted vendor call');
  }

  // ---- 5. the TICK respects maxPerRun and reports the deferred (never hidden) ----------------------
  {
    const store = makeStore();
    const client = makeClient({ A: { baseRates: {}, fingerprint: {} }, B: { baseRates: {}, fingerprint: {} } });
    const entries = [{ investor: 'A', hourEt: 10 }, { investor: 'B', hourEt: 10 }];
    const res = await RUN.tickDaily({ lpClient: client, clock: clockAt(utc(2025, 6, 15, 15, 0)), store, entries, config: { maxPerRun: 1 } });
    eq(res.ran.length, 1, 'only one investor ran this tick');
    eq(res.deferred.length, 1, 'the other is reported as deferred, not silently skipped');
  }

  console.log(`ok - lt lp daily run (${n} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

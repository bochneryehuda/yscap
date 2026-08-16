'use strict';
/**
 * Pure offline test for the LT PPE canary runner (src/longterm/ppe/canary.js).
 * Stub engines only — no DB, no network.  node scripts/test-lt-ppe-canary.js
 */

const assert = require('assert');
const canary = require('../src/longterm/ppe/canary');
const scoreboard = require('../src/longterm/ppe/scoreboard');
const finding = require('../src/longterm/ppe/finding');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };
const near = (a, b, m) => { assert.ok(Math.abs(a - b) < 1e-9, `${m} (got ${a}, want ${b})`); n += 1; };

const NOW = 1_700_000_000_000;

// Two scenarios; 'agree' matches Lender Price, 'diff' is 500 milli-points off.
const SCEN = [{ _label: 'agree', ltv: 70 }, { _label: 'diff', ltv: 75 }];
const theirs = async () => ({ eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }] });
const oursFor = (bump) => async (s) => ({
  eligible: true,
  ladder: [{ rate: 7000, finalPriceMilli: 100000 + (s._label === 'diff' ? bump : 0) }],
});

(async function main() {
  // ---- a canary run packages summary + records + runRecord + report ----
  {
    const run = await canary.runCanary(SCEN, { ours: oursFor(500), theirs },
      { investor: 'DHVN', program: 'DSCR30', nowMs: NOW, priceToleranceMilli: 0 });

    eq(run.summary.scenarios, 2, 'canary: both scenarios priced');
    eq(run.summary.agreed, 1, 'canary: one scenario agrees');
    eq(run.summary.disagreed, 1, 'canary: one scenario disagrees');
    near(run.agreementRate, 0.5, 'canary: agreementRate is 1/2');

    eq(run.findingKeys.length, 1, 'canary: exactly one disagreeing finding key');
    ok(run.findingKeys[0].includes('diff') && run.findingKeys[0].includes('price_mismatch'),
      'canary: the key names the disagreeing scenario + kind');
    ok(!run.findingKeys[0].includes('agree'), 'canary: the agreeing scenario produces no key');

    // records are ready to hand straight to finding-store.persistRun
    eq(run.records.length, 1, 'canary: one ledger record for the one disagreement');
    const rec = run.records[0];
    eq(rec.investor, 'DHVN', 'canary: record carries the investor identity');
    eq(rec.program, 'DSCR30', 'canary: record carries the program identity');
    eq(rec.status, 'open', 'canary: a fresh record is open');
    eq(rec.firstSeenMs, NOW, 'canary: firstSeen stamped from the injected clock');
    ok(finding.OPEN_STATUSES.has(rec.status), 'canary: record status is a real open status');

    ok(run.report && typeof run.report.verdict === 'string', 'canary: a human report is produced');
  }

  // ---- runRecord plugs straight into the scoreboard (the whole loop composes) ----
  {
    const day = 24 * 60 * 60 * 1000;
    // day 1: 50% agreement, one finding; day 2: perfect, clean.
    const r1 = await canary.runCanary(SCEN, { ours: oursFor(500), theirs },
      { investor: 'DHVN', program: 'DSCR30', nowMs: NOW - day, dayMs: NOW - day, priceToleranceMilli: 0 });
    const r2 = await canary.runCanary(SCEN, { ours: oursFor(0), theirs },
      { investor: 'DHVN', program: 'DSCR30', nowMs: NOW, dayMs: NOW, priceToleranceMilli: 0 });

    const { days } = scoreboard.dailySeries([r1.runRecord, r2.runRecord]);
    eq(days.length, 2, 'loop: two canary days in the scoreboard series');
    eq(days[0].newFindings, 1, 'loop: the disagreement is a new finding on day 1');
    eq(days[1].newFindings, 0, 'loop: day 2 is clean');
    near(scoreboard.latestAgreementRate([r1.runRecord, r2.runRecord]), 1, 'loop: latest agreement is the clean day');
  }

  // ---- an engine that throws is recorded as an engine_error finding, never a crash ----
  {
    const boom = async () => { throw new Error('rate sheet missing'); };
    const run = await canary.runCanary([{ _label: 'x' }], { ours: boom, theirs },
      { investor: 'DHVN', program: 'DSCR30', nowMs: NOW });
    eq(run.summary.disagreed, 1, 'error: a throwing engine counts as a disagreement');
    eq(run.records.length, 1, 'error: an engine_error produces a ledger record');
    eq(run.records[0].kind, 'engine_error', 'error: the record kind is engine_error');
    ok(run.records[0].key.includes('engine_error'), 'error: the key names the engine_error kind');
  }

  // ---- an empty matrix is a clean no-op, not a crash ----
  {
    const run = await canary.runCanary([], { ours: oursFor(0), theirs }, { nowMs: NOW });
    eq(run.summary.scenarios, 0, 'empty: no scenarios');
    eq(run.agreementRate, null, 'empty: agreementRate is null with nothing to measure');
    eq(run.findingKeys.length, 0, 'empty: no finding keys');
  }

  console.log(`ok - lt ppe canary runner (${n} assertions)`);
})().catch((e) => { console.error(e); process.exit(1); });

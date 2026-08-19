'use strict';
/**
 * Pure offline test for the LT PPE findings ledger logic (src/longterm/ppe/finding.js).
 *   node scripts/test-lt-ppe-finding.js
 */

const assert = require('assert');
const F = require('../src/longterm/ppe/finding');
const parity = require('../src/longterm/ppe/parity');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const NOW = 1_700_000_000_000;

// ---- findingKey identity ----------------------------------------------------
(() => {
  const a = F.findingKey({ investor: 'Acme', program: 'DSCR', scenario: 'ltv=70', kind: 'price_mismatch', rate: 7000 });
  const b = F.findingKey({ investor: 'acme', program: 'dscr', scenario: 'ltv=70', kind: 'price_mismatch', rate: 7000 });
  eq(a, b, 'key is case-insensitive on investor/program');
  ok(a !== F.findingKey({ investor: 'Acme', program: 'DSCR', scenario: 'ltv=70', kind: 'price_mismatch', rate: 7250 }),
    'a different coupon is a different finding');
  const elig = F.findingKey({ investor: 'Acme', program: 'DSCR', scenario: 'ltv=70', kind: 'eligibility_mismatch', rate: 7000 });
  ok(!elig.includes('7000'), 'eligibility key ignores rate');
  const err = F.findingKey({ investor: 'Acme', program: 'DSCR', scenario: 'x', kind: 'engine_error', side: 'theirs' });
  ok(err.includes('theirs'), 'engine_error key includes the side');
})();

// ---- recordsFromComparison --------------------------------------------------
(() => {
  const agree = parity.compareScenario(
    { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }] },
    { eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }] }, { priceToleranceMilli: 0 });
  eq(F.recordsFromComparison(agree, { investor: 'Acme', program: 'DSCR', scenario: 'ltv=70', nowMs: NOW }).length, 0,
    'an agreeing scenario yields no findings');

  const cmp = parity.compareScenario(
    { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100050 }] },
    { eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }] }, { priceToleranceMilli: 0 });
  const recs = F.recordsFromComparison(cmp, { investor: 'Acme', program: 'DSCR', scenario: { _label: 'ltv=70', ltv: 70 }, ourPayload: { a: 1 }, theirPayload: { b: 2 }, nowMs: NOW });
  eq(recs.length, 1, 'one disagreement -> one record');
  eq(recs[0].status, 'open', 'born open');
  eq(recs[0].recurrence, 1, 'recurrence starts at 1');
  eq(recs[0].firstSeenMs, NOW, 'firstSeen set');
  eq(recs[0].lastSeenMs, NOW, 'lastSeen set');
  eq(recs[0].kind, parity.SEVERITY.PRICE, 'kind carried');
  eq(recs[0].diff.deltaMilli, 50, 'structured diff carried');
  ok(recs[0].scenarioFacts && recs[0].scenarioFacts.ltv === 70, 'scenario facts captured when an object');
  ok(recs[0].ourPayload && recs[0].theirPayload, 'payloads passed through');
})();

// ---- mergeOne ---------------------------------------------------------------
(() => {
  const inc = { key: 'k', legVersion: F.LEG_VERSION, status: 'open', firstSeenMs: NOW, lastSeenMs: NOW, recurrence: 1, diff: { deltaMilli: 60 } };

  eq(F.mergeOne(null, inc).action, 'new', 'no existing -> new');

  const openExisting = { key: 'k', legVersion: F.LEG_VERSION, status: 'triaged', firstSeenMs: NOW - 3 * 86400000, lastSeenMs: NOW - 86400000, recurrence: 2, diff: { deltaMilli: 50 } };
  const r1 = F.mergeOne(openExisting, inc);
  eq(r1.action, 'recurred', 'open existing -> recurred');
  eq(r1.record.status, 'triaged', 'human status preserved');
  eq(r1.record.recurrence, 3, 'recurrence bumped');
  eq(r1.record.lastSeenMs, NOW, 'lastSeen refreshed');
  eq(r1.record.diff.deltaMilli, 60, 'latest diff kept');

  const fixed = { key: 'k', legVersion: F.LEG_VERSION, status: 'fixed', firstSeenMs: NOW, lastSeenMs: NOW, recurrence: 1 };
  const r2 = F.mergeOne(fixed, inc);
  eq(r2.action, 'carried_settled', 'fixed existing -> carried, not reopened');
  eq(r2.record.status, 'fixed', 'stays fixed (never re-opens itself)');
  eq(r2.record.regressed, true, 'a fixed finding that reappears is flagged regressed');

  const wontfix = { key: 'k', legVersion: F.LEG_VERSION, status: 'wontfix', firstSeenMs: NOW, lastSeenMs: NOW, recurrence: 1 };
  const r3 = F.mergeOne(wontfix, inc);
  eq(r3.action, 'carried_wontfix', 'wontfix -> carried_wontfix');
  eq(r3.record.regressed, false, 'wontfix recurrence is expected, not a regression');
})();

// ---- reconcile a whole run --------------------------------------------------
(() => {
  const existing = [
    { key: 'a', legVersion: F.LEG_VERSION, status: 'open', firstSeenMs: NOW - 5 * 86400000, lastSeenMs: NOW - 86400000, recurrence: 2 },
    { key: 'b', legVersion: F.LEG_VERSION, status: 'fixed', firstSeenMs: NOW - 9 * 86400000, lastSeenMs: NOW - 9 * 86400000, recurrence: 1 },
    { key: 'c', legVersion: F.LEG_VERSION, status: 'open', firstSeenMs: NOW - 2 * 86400000, lastSeenMs: NOW - 86400000, recurrence: 1 }, // will disappear
    { key: 'd', legVersion: F.LEG_VERSION, status: 'wontfix', firstSeenMs: NOW - 20 * 86400000, lastSeenMs: NOW - 20 * 86400000, recurrence: 1 }, // settled + disappears -> untouched
  ];
  const incoming = [
    { key: 'a', legVersion: F.LEG_VERSION, status: 'open', firstSeenMs: NOW, lastSeenMs: NOW, recurrence: 1, diff: {} }, // recurs
    { key: 'b', legVersion: F.LEG_VERSION, status: 'open', firstSeenMs: NOW, lastSeenMs: NOW, recurrence: 1, diff: {} }, // regression of a fixed
    { key: 'e', legVersion: F.LEG_VERSION, status: 'open', firstSeenMs: NOW, lastSeenMs: NOW, recurrence: 1, diff: {} }, // new
  ];
  const { records, disappeared, summary } = F.reconcile(existing, incoming, { nowMs: NOW });
  eq(summary.new, 1, 'one new (e)');
  eq(summary.recurred, 1, 'one recurred (a)');
  eq(summary.carried, 1, 'one carried settled (b)');
  eq(summary.regressed, 1, 'b flagged regressed');
  eq(summary.disappeared, 1, 'only open c disappeared (wontfix d is left untouched, not counted)');
  eq(disappeared[0].key, 'c', 'c is the disappeared open finding');
  eq(records.length, 3, 'persist a, b, e');
  const b = records.find((r) => r.key === 'b');
  eq(b.status, 'fixed', 'regressed b keeps fixed status (no auto-reopen)');
  eq(b.regressed, true, 'b marked regressed');
})();

// ---- end-to-end from shadow-style findings ----------------------------------
(() => {
  const cmp = parity.compareScenario(
    { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }, { rate: 7250, finalPriceMilli: 101300 }] },
    { eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }, { rate: 7250, priceMilli: 101250 }] },
    { priceToleranceMilli: 0 });
  const recs = F.recordsFromComparison(cmp, { investor: 'Acme', program: 'DSCR', scenario: 'ltv=70 fico=740', nowMs: NOW });
  eq(recs.length, 1, 'only the 7250 coupon disagrees');
  eq(recs[0].scenario, 'ltv=70 fico=740', 'scenario label carried');
  const { summary } = F.reconcile([], recs, { nowMs: NOW });
  eq(summary.new, 1, 'first run -> all new');
})();

console.log(`ok - lt ppe finding ledger (${n} assertions)`);

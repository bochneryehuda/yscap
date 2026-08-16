'use strict';
/**
 * Pure offline test for the LT PPE findings review queue (src/longterm/ppe/review-queue.js).
 *   node scripts/test-lt-ppe-review-queue.js
 */

const assert = require('assert');
const Q = require('../src/longterm/ppe/review-queue');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const DAY = Q.DAY_MS;
const NOW = 1_700_000_000_000;

// a stored-ledger record shape (matches finding-store rowToRecord / finding.js records)
const rec = (over = {}) => ({
  key: over.key || 'k',
  investor: 'DHVN', program: 'dscr',
  scenario: 's1', kind: 'price_mismatch', status: 'open',
  recurrence: 1, firstSeenMs: NOW - DAY, lastSeenMs: NOW,
  regressed: false, diff: {}, ...over,
});

// ---- severity by kind ----
eq(Q.severityOf(rec({ kind: 'eligibility_mismatch' })), 'critical', 'eligibility -> critical');
eq(Q.severityOf(rec({ kind: 'engine_error' })), 'critical', 'engine_error -> critical');
eq(Q.severityOf(rec({ kind: 'rate_mismatch' })), 'high', 'rate_mismatch -> high');
eq(Q.severityOf(rec({ kind: 'rung_missing_ours' })), 'high', 'missing-ours -> high');
eq(Q.severityOf(rec({ kind: 'rung_missing_theirs' })), 'medium', 'missing-theirs -> medium');
eq(Q.severityOf(rec({ kind: 'incomparable' })), 'high', 'incomparable is a real item -> high (never hidden)');

// ---- an unknown kind is SURFACED, never silently low (§10.6) ----
eq(Q.severityOf(rec({ kind: 'something_new' })), 'high', 'unknown kind -> high');

// ---- price_mismatch severity scales with the gap; thresholds injectable ----
eq(Q.severityOf(rec({ diff: { deltaMilli: 750 } })), 'high', 'gap >= 500 milli -> high');
eq(Q.severityOf(rec({ diff: { deltaMilli: 200 } })), 'medium', 'gap in [100,500) -> medium');
eq(Q.severityOf(rec({ diff: { deltaMilli: 30 } })), 'low', 'gap < 100 milli -> low');
eq(Q.severityOf(rec({ diff: { deltaMilli: -750 } })), 'high', 'severity is on magnitude, sign-agnostic');
eq(Q.severityOf(rec({ diff: { ourPriceMilli: 100000, theirPriceMilli: 99000 } })), 'high', 'gap derived from the two prices');
eq(Q.severityOf(rec({ diff: {} })), 'high', 'a price gap we cannot measure -> high, never low');
eq(Q.severityOf(rec({ diff: { deltaMilli: 30 } }), { mediumMilli: 10, highMilli: 20 }), 'high', 'custom thresholds honored');

// ---- a regressed finding is bumped one level ----
eq(Q.severityOf(rec({ diff: { deltaMilli: 30 }, regressed: true })), 'medium', 'regressed low -> medium');
eq(Q.severityOf(rec({ kind: 'rate_mismatch', regressed: true })), 'critical', 'regressed high -> critical');

// ---- age ----
eq(Q.ageDays(rec({ firstSeenMs: NOW - 5 * DAY }), NOW), 5, 'age in whole days');
eq(Q.ageDays(rec({ firstSeenMs: null }), NOW), null, 'unknown first-seen -> null age');

// ---- the queue: settled findings are out of the active list; ordering is worst-first ----
{
  const records = [
    rec({ key: 'low-price', diff: { deltaMilli: 30 } }),               // low
    rec({ key: 'elig', kind: 'eligibility_mismatch' }),                // critical
    rec({ key: 'big-price', diff: { deltaMilli: 900 } }),              // high
    rec({ key: 'fixed', kind: 'rate_mismatch', status: 'fixed' }),     // settled -> excluded
    rec({ key: 'wont', kind: 'rate_mismatch', status: 'wontfix' }),    // settled -> excluded
  ];
  const q = Q.buildQueue(records, { nowMs: NOW });
  eq(q.items.length, 3, 'settled findings are not in the active queue');
  eq(q.items[0].key, 'elig', 'critical ranks first');
  eq(q.items[q.items.length - 1].key, 'low-price', 'low ranks last');
  eq(q.settled.length, 2, 'settled returned separately');
  ok(q.items.every((i) => i.severity && typeof i.score === 'number'), 'items are decorated with severity + score');
}

// ---- a regressed finding outranks a same-severity non-regressed one ----
{
  const records = [
    rec({ key: 'plain', kind: 'rate_mismatch' }),
    rec({ key: 'broke', kind: 'price_mismatch', diff: { deltaMilli: 200 }, regressed: true }), // medium bumped to high
  ];
  const q = Q.buildQueue(records, { nowMs: NOW });
  eq(q.items[0].key, 'broke', 'a broken fix (regressed) is pushed to the top of its severity');
}

// ---- recurrence and age break ties within a severity ----
{
  const records = [
    rec({ key: 'seen-once', kind: 'rate_mismatch', recurrence: 1, firstSeenMs: NOW - DAY }),
    rec({ key: 'seen-often', kind: 'rate_mismatch', recurrence: 40, firstSeenMs: NOW - DAY }),
  ];
  const q = Q.buildQueue(records, { nowMs: NOW });
  eq(q.items[0].key, 'seen-often', 'a finding that keeps recurring ranks higher');
}

// ---- the roll-up summary ----
{
  const records = [
    rec({ key: 'a', investor: 'DHVN', kind: 'eligibility_mismatch' }),
    rec({ key: 'b', investor: 'DHVN', kind: 'price_mismatch', diff: { deltaMilli: 900 } }),
    rec({ key: 'c', investor: 'RCN', kind: 'rate_mismatch', regressed: true, firstSeenMs: NOW - 10 * DAY }),
    rec({ key: 'd', investor: 'RCN', kind: 'price_mismatch', status: 'triaged', diff: { deltaMilli: 30 } }),
    rec({ key: 'e', investor: 'RCN', kind: 'rate_mismatch', status: 'verified' }), // settled
  ];
  const q = Q.buildQueue(records, { nowMs: NOW });
  const s = q.summary;
  eq(s.open, 4, 'four open/triaged findings');
  eq(s.settled, 1, 'one settled');
  eq(s.byStatus.open, 3, 'three open');
  eq(s.byStatus.triaged, 1, 'one triaged');
  eq(s.byInvestor.DHVN, 2, 'per-investor roll-up (DHVN)');
  eq(s.byInvestor.RCN, 2, 'per-investor roll-up (RCN)');
  eq(s.bySeverity.critical, 2, 'two critical (eligibility + the regressed rate_mismatch bumped up)');
  eq(s.byKind.price_mismatch, 2, 'per-kind roll-up');
  eq(s.regressed, 1, 'one regressed');
  eq(s.oldestOpenDays, 10, 'oldest open finding age');
  eq(s.top.key, 'c', 'the regressed critical outranks the plain critical');
}

// ---- deterministic + empty input ----
{
  const empty = Q.buildQueue([], { nowMs: NOW });
  eq(empty.items.length, 0, 'empty ledger -> empty queue');
  eq(empty.summary.open, 0, 'empty summary open=0');
  eq(empty.summary.top, null, 'empty summary top=null');
  eq(Q.buildQueue().items.length, 0, 'no args -> empty, never throws');
}

console.log(`ok - lt ppe review queue (${n} assertions)`);

#!/usr/bin/env node
'use strict';
/**
 * §2.126 — WHICH ENGINE WIRING MEASURED A FINDINGS-LEDGER ROW.
 *
 * The ledger makes three confident statements about a stored row on every later run — it recurred, it
 * is gone so close it `verified`, it came back so the fix did not hold — and each one is a claim that
 * this run and the stored row measured the SAME thing. Nothing on the row said what measured it, so
 * when the "ours" leg was corrected (§2.122, §2.124) the ledger carried, closed and accused rows the
 * old wiring produced exactly like rows the new one produced.
 *
 * MEASURED BEFORE BUILDING (a probe against a real Postgres, 2026-08-19):
 *   • a record from `recordsFromComparison` had 14 keys, none naming a leg, engine or version
 *   • `lt_ppe_finding` had 22 columns, likewise none
 *   • a pre-fix row that stopped reproducing was auto-closed `verified — auto-resolved: no longer
 *     reproduced`, which reads as "we looked and it is fixed" about a run that never looked for it
 *   • the same row reappearing was flagged `regressed = true` — the loudest reading in the ledger, and
 *     the one the go-live gate refuses promotion on — about a fix that was never made
 *
 * PURE: no DB, no clock. The DB half (the column, the not-closing, the decision re-stamp) is proven in
 * scripts/test-lt-ppe-finding-store-db.js against a real Postgres.
 */

const assert = require('assert');
const F = require('../src/longterm/ppe/finding');
const prov = require('../src/longterm/ppe/agreement-provenance');
const cutover = require('../src/longterm/ppe/cutover');

let n = 0;
function ok(c, m) { assert.ok(c, m); n += 1; }
function eq(a, b, m) { assert.strictEqual(a, b, m); n += 1; }

const NOW = 1755000000000;
const CMP = { agree: false, findings: [{ kind: 'price_mismatch', rate: 7.125, deltaMilli: 60 }] };
const CTX = { investor: 'Deephaven', program: 'DSCR', scenario: 'ltv=70', nowMs: NOW };

// ---- A. every new record is stamped, by the code, not by its caller ---------
{
  const [rec] = F.recordsFromComparison(CMP, CTX);
  eq(rec.legVersion, prov.LEG_VERSION, 'A1 a fresh finding carries the current engine-wiring stamp');
  ok(F.measuredByCurrentLeg(rec), 'A2 …so it reads as measured by today\'s engine');

  // ⛔ THE CALLER CANNOT SUPPLY IT. A stamp a caller may pass is a stamp a caller may FORGET, and a
  // forgotten stamp reads exactly like "recorded before the fix" — the ledger would quietly report
  // healthy rows as unreadable, and everyone would learn to ignore the signal. Worse, a caller passing
  // one could stamp a row today's engine never measured.
  const [forged] = F.recordsFromComparison(CMP, { ...CTX, legVersion: 'forged/9.99' });
  eq(forged.legVersion, prov.LEG_VERSION, 'A3 a legVersion in the ctx does NOT win — the constant does');
}

// ---- B. what "cannot be read" means, in one place --------------------------
{
  eq(F.measuredByCurrentLeg({ legVersion: prov.LEG_VERSION }), true, 'B1 current stamp -> readable');
  eq(F.measuredByCurrentLeg({}), false, 'B2 no stamp at all -> not readable');
  eq(F.measuredByCurrentLeg({ legVersion: null }), false, 'B3 an explicit null -> not readable');
  eq(F.measuredByCurrentLeg({ legVersion: '2026-08-19/2.122' }), false,
    'B4 a DIFFERENT stamp -> not readable (exact equality; a newer one fails closed too)');
  eq(F.measuredByCurrentLeg(null), false, 'B5 nothing at all -> not readable');

  eq(F.unreadableReason({ legVersion: prov.LEG_VERSION }), null, 'B6 a readable row has no reason');
  ok(/unknown/.test(F.unreadableReason({})),
    'B7 an unstamped row says what measured it is UNKNOWN — not that it is wrong');
  ok(F.unreadableReason({ legVersion: '2026-08-19/2.122' }).includes('2026-08-19/2.122'),
    'B8 a differently-stamped row names the wiring it was measured by');
}

// ---- C. mergeOne abstains instead of accusing ------------------------------
{
  const inc = F.recordsFromComparison(CMP, CTX)[0];

  // C1/C2 — the defect the probe measured: a settled row from an older wiring, reappearing.
  const settledOld = { key: inc.key, status: 'fixed', legVersion: '2026-08-19/2.122', recurrence: 1, lastSeenMs: NOW - 86400000 };
  const m1 = F.mergeOne(settledOld, inc);
  eq(m1.action, 'carried_unreadable', 'C1 a settled row from an older wiring is carried, not judged');
  eq(!!m1.record.regressed, false,
    'C2 …and is NOT accused of regressing — the fix it names was never measured by this engine');
  eq(m1.record.staleDecision, true, 'C3 …but it IS marked, because a silent suppression is its own defect');
  ok(/since changed/.test(m1.record.staleDecisionReason || ''), 'C4 …with the reason in plain words');
  eq(m1.record.status, 'fixed', 'C5 …and its status is untouched — a run never re-opens a settled row');
  eq(m1.record.legVersion, '2026-08-19/2.122',
    'C6 …and the stamp does NOT move: the DECISION is what cannot be read, and no run can re-make it');

  // C7 — the same row, settled under TODAY's wiring, still gets the regression flag it should.
  const settledNow = { ...settledOld, legVersion: prov.LEG_VERSION };
  const m2 = F.mergeOne(settledNow, inc);
  eq(m2.action, 'carried_settled', 'C7 a settled row from today\'s wiring is judged exactly as before');
  eq(m2.record.regressed, true, 'C8 …and a fix that came undone is still called out');

  // C9 — an OPEN row from an older wiring that reproduced HAS been re-measured.
  const openOld = { key: inc.key, status: 'triaged', legVersion: '2026-08-19/2.122', recurrence: 4, lastSeenMs: NOW - 86400000 };
  const m3 = F.mergeOne(openOld, inc);
  eq(m3.action, 'recurred', 'C9 an open row that reproduced under today\'s wiring simply recurred');
  eq(m3.record.legVersion, prov.LEG_VERSION,
    'C10 …and the stamp MOVES: today\'s engine just measured this disagreement itself');
  eq(m3.record.status, 'triaged', 'C11 …keeping the human\'s triage');
  eq(m3.record.recurrence, 5, 'C12 …and the permanent sighting count');
}

// ---- D. reconcile: absence is only evidence when the same thing looked ------
{
  const inc = F.recordsFromComparison(CMP, { ...CTX, scenario: 'still-here' });
  const goneReadable = { key: 'gone|readable', status: 'open', legVersion: prov.LEG_VERSION, recurrence: 3 };
  const goneOld = { key: 'gone|old', status: 'open', legVersion: '2026-08-19/2.122', recurrence: 3 };
  const goneUnstamped = { key: 'gone|unstamped', status: 'open', recurrence: 3 };
  const settledOldGone = { key: 'gone|settled', status: 'wontfix', legVersion: '2026-08-19/2.122', recurrence: 1 };

  const out = F.reconcile([goneReadable, goneOld, goneUnstamped, settledOldGone], inc, { nowMs: NOW });

  eq(out.disappeared.length, 1, 'D1 only the row today\'s engine actually looked for can be "gone"');
  eq(out.disappeared[0].key, 'gone|readable', 'D2 …and it is that row');
  eq(out.summary.disappeared, 1, 'D3 the summary agrees');

  const unreadableKeys = out.unreadable.map((u) => u.key).sort();
  assert.deepStrictEqual(unreadableKeys, ['gone|old', 'gone|unstamped'],
    'D4 the two open rows from older wirings are reported UNREADABLE, not closed');
  n += 1;
  eq(out.summary.unreadable, 2, 'D5 the summary counts them separately');
  ok(out.unreadable.every((u) => u.unreadableReason), 'D6 each carries the plain reason');

  // ⛔ THE POINT OF D4. `finding-store.persistRun` auto-closes everything in `disappeared` with the
  // status `verified` and the words "no longer reproduced". Those words claim a run went looking. A run
  // using a corrected leg did not look for the old leg's disagreement at all, so closing the row stamps
  // a clean verdict on a question nobody asked — and `verified` is one of the two statuses that later
  // earns a `regressed` accusation, so the false clean verdict grows a false alarm on top of it.
  ok(!out.disappeared.some((d) => d.key === 'gone|old'),
    'D7 an unreadable row is never handed to the auto-closer');
  ok(!out.records.some((r) => r.key === 'gone|settled'),
    'D8 a settled row that did not recur is still left completely untouched');
}

// ---- E. the go-live gate says it in words a reader can act on --------------
{
  const openReadable = { status: 'open', legVersion: prov.LEG_VERSION, firstSeenMs: NOW };
  const openOld = { status: 'open', legVersion: '2026-08-19/2.122', firstSeenMs: NOW };
  const staleSettled = { status: 'fixed', legVersion: '2026-08-19/2.122', staleDecision: true };

  const sb = cutover.buildScoreboard({ findings: [openReadable, openOld, staleSettled], nowMs: NOW });
  eq(sb.openFindings, 2, 'E1 an unreadable OPEN row still counts as open work — the gate must not loosen');
  eq(sb.unreadableOpenFindings, 1, 'E2 …and how many of those nobody can read is its own number');
  eq(sb.staleDecisions, 1, 'E3 a settled row decided under an older wiring is counted on its own');
  eq(sb.regressedFindings, 0, 'E4 …and is NOT counted as a fix that came undone');

  const reasons = cutover.eligibleForLive(sb, {}).reasons.join(' | ');
  ok(/1 of them was recorded by an engine wiring that has since changed/.test(reasons),
    'E5 the open-findings reason says how many are unreadable, in the same sentence');
  ok(/settled under an engine wiring that has since changed/.test(reasons),
    'E6 the stale decisions get a reason of their own — nothing else here can see them');
  ok(/look at them again and record the decision/.test(reasons),
    'E7 …and it names the remedy, so the block is never a dead end');

  // E8 — a clean ledger says none of this.
  const clean = cutover.buildScoreboard({ findings: [{ status: 'fixed', legVersion: prov.LEG_VERSION }], nowMs: NOW });
  eq(clean.unreadableOpenFindings, 0, 'E8 a ledger measured entirely by today\'s engine reports nothing unreadable');
  eq(clean.staleDecisions, 0, 'E9 …and no stale decisions');
  ok(!cutover.eligibleForLive(clean, {}).reasons.join(' ').includes('since changed'),
    'E10 …and the gate stops talking about engine wirings altogether');
}

console.log(`ok - lt ppe findings ledger engine-wiring stamp (${n} assertions)`);

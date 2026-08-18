'use strict';
/**
 * LT PPE — the DISQUALIFIER REVIEW QUEUE against a REAL POSTGRES (db/581, owner-instructed
 * 2026-08-18).
 *
 * WHY THIS CANNOT BE A PURE TEST. Every rule worth proving here lives in the ON CONFLICT clause: the
 * decision surviving a re-run, the changed situation reopening it, the old answer being kept, the
 * unique key holding, and the CHECK constraints refusing a decision with nobody named. A mocked `db`
 * would prove that the JavaScript passed the strings it meant to pass and nothing about what Postgres
 * does with them — and the strings are not the rule.
 *
 * Skips cleanly with no DATABASE_URL, like every other DB-backed suite here.
 */

const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.log('SKIP - lt ppe disqualifier review db (no DATABASE_URL)');
  process.exit(0);
}

const ltDb = require('../src/longterm/db');
const store = require('../src/longterm/ppe/disqualifier-review-store');
const review = require('../src/longterm/ppe/disqualifier-review');

let passed = 0;
const fails = [];
const ok = (cond, label) => {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); } else { fails.push(label); console.log(`  FAIL ${label}`); }
};
const section = (name) => console.log(`\n${name}\n`);

const SCOPE = 'company';
const stamp = `DQ${process.pid}${Date.now() % 100000}`;

// The situation the owner described: Lender Price refuses on DSCR, our sheet charges for it.
const SCENARIO = { fico: 700, ltv: 75000, dscr: 1050, loan_amount: 400000, state: 'NJ' };
const PROGRAM = {
  id: 'prog',
  rules: [{ code: 'dscr_low', kind: 'pricing', description: 'DSCR 1.00-1.10', adjustment: { dimension: 'dscr', costMilli: 750 } }],
};
const LP = { ready: true, declined: [{ reasons: [{ rule: 'DSCR below 1.10', adjType: 'DscrRateAdjustment' }] }] };
const PRICED = { eligible: true, ladder: [{ adjustments: [{ dimension: 'dscr', code: 'dscr_low', reason: 'DSCR 1.00-1.10', costMilli: 750 }] }] };
// The SAME scenario after somebody widened the sheet: the charge is now 0.375 instead of 0.750.
const PRICED_CHEAPER = { eligible: true, ladder: [{ adjustments: [{ dimension: 'dscr', code: 'dscr_low', reason: 'DSCR 1.00-1.10', costMilli: 375 }] }] };

(async () => {
  let investorId = null;
  let programId = null;

  const cleanup = async () => {
    if (programId) {
      await ltDb.query('DELETE FROM lt_ppe_disqualifier_review WHERE program_id = $1', [programId]).catch(() => {});
      await ltDb.query('DELETE FROM lt_ppe_program WHERE id = $1', [programId]).catch(() => {});
    }
    if (investorId) await ltDb.query('DELETE FROM lt_ppe_investor WHERE id = $1', [investorId]).catch(() => {});
  };

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '581_lt_ppe_disqualifier_review_queue.sql']) {
      await ltDb.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }

    const inv = await ltDb.query(
      `INSERT INTO lt_ppe_investor (scope, code, name) VALUES ($1,$2,$3) RETURNING id`,
      [SCOPE, `Z${stamp}`.slice(0, 20), `Review ${stamp}`]);
    investorId = inv.rows[0].id;
    const prg = await ltDb.query(
      `INSERT INTO lt_ppe_program (scope, investor_id, code, name) VALUES ($1,$2,$3,$4) RETURNING id`,
      [SCOPE, investorId, `p_${stamp}`.slice(0, 40), `Program ${stamp}`]);
    programId = prg.rows[0].id;

    // =====================================================================
    section('A. the owner\'s question reaches the queue, computed end to end');
    // =====================================================================
    const built = review.reviewScenario({ scenario: SCENARIO, lp: LP, ours: PRICED, program: PROGRAM });
    ok(built.ready && built.items.length === 1, 'A1 the review produced one question for this scenario');
    ok(built.items[0].classification === 'priced_not_declined',
      'A2 …and it is the owner\'s own case: Lender Price refuses it, our sheet charges for it');

    const w1 = await store.recordItems(ltDb, SCOPE, programId, built.items, { now: 1_000 });
    ok(w1.inserted === 1 && w1.refreshed === 0 && w1.reopened === 0, 'A3 the first run INSERTS it');

    const q1 = await store.listQueue(ltDb, SCOPE, { programId });
    ok(q1.length === 1 && q1[0].status === 'open', 'A4 THE RE-READ: it is in the queue, open');
    ok(q1[0].question === built.items[0].question,
      'A5 …carrying the question in the words a person reads, stored rather than re-derived by a screen');
    ok(q1[0].ourSheet && q1[0].ourSheet.adjustments && q1[0].ourSheet.adjustments[0].costMilli === 750,
      'A6 …and what our sheet does about it, with the money on it');
    const itemId = q1[0].id;

    // =====================================================================
    section('B. a re-run never re-asks — the identity holds and nothing duplicates');
    // =====================================================================
    const w2 = await store.recordItems(ltDb, SCOPE, programId, built.items, { now: 2_000 });
    ok(w2.inserted === 0 && w2.refreshed === 1, 'B1 the second run REFRESHES rather than inserting');
    const q2 = await store.listQueue(ltDb, SCOPE, { programId });
    ok(q2.length === 1, 'B2 THE ONE THAT MATTERS: still exactly ONE row — the same question is never asked twice');
    ok(q2[0].lastSeenAt === 2000 && q2[0].firstSeenAt === 1000,
      'B3 …with when it was first asked kept and when it was last seen moved');

    // =====================================================================
    section('C. a human answers it, and the answer SURVIVES the next run');
    // =====================================================================
    const bad = await store.decide(ltDb, SCOPE, itemId, { decision: 'whatever', decidedBy: 'A Person' });
    ok(!bad.ok && bad.code === 'unknown_decision', 'C1 an answer outside the list is refused');
    const anon = await store.decide(ltDb, SCOPE, itemId, { decision: 'price', decidedBy: '   ' });
    ok(!anon.ok && anon.code === 'decider_required',
      'C2 an answer with nobody named is refused — an underwriting decision has to carry a name');

    const dec = await store.decide(ltDb, SCOPE, itemId,
      { decision: 'price', note: 'We take these at a price.', decidedBy: 'Rule Super' }, { now: 3_000 });
    ok(dec.ok && dec.item.status === 'decided' && dec.item.decision === 'price', 'C3 a real answer is recorded');
    ok(/we take, at a price/i.test(dec.item.decisionMeans || ''),
      'C4 …and the answer reads back in plain words, so a screen never has to know the codes');

    const w3 = await store.recordItems(ltDb, SCOPE, programId, built.items, { now: 4_000 });
    ok(w3.refreshed === 1 && w3.reopened === 0, 'C5 the next run refreshes it and reopens nothing');
    const q3 = await store.listQueue(ltDb, SCOPE, { programId, status: 'all' });
    ok(q3[0].status === 'decided' && q3[0].decision === 'price',
      'C6 THE ONE THAT MATTERS: the decision SURVIVED the re-run — the queue does not re-ask what was settled');
    ok(q3[0].lastSeenAt === 4000, 'C7 …while still recording that the question came round again');
    const open3 = await store.listQueue(ltDb, SCOPE, { programId });
    ok(open3.length === 0, 'C8 …and it is out of the open queue, which is what a reviewer opens');

    // =====================================================================
    section('D. …but a CHANGED situation reopens it, and keeps the old answer');
    // =====================================================================
    const moved = review.reviewScenario({ scenario: SCENARIO, lp: LP, ours: PRICED_CHEAPER, program: PROGRAM });
    ok(moved.items[0].classification === 'priced_not_declined',
      'D1 control — the classification did NOT change; only what our sheet charges did');
    const w4 = await store.recordItems(ltDb, SCOPE, programId, moved.items, { now: 5_000 });
    ok(w4.reopened === 1 && w4.refreshed === 0,
      'D2 THE ONE THAT MATTERS: the sheet now charges 0.375 instead of 0.750, so the settled question REOPENS');
    const q4 = await store.listQueue(ltDb, SCOPE, { programId });
    ok(q4.length === 1 && q4[0].status === 'open', 'D3 …it is back in front of a person');
    ok(q4[0].decision === null, 'D4 …with the old answer no longer standing as the answer to a different question');
    ok(q4[0].priorDecision && q4[0].priorDecision.decision === 'price' && q4[0].priorDecision.by === 'Rule Super',
      'D5 …but the old answer is KEPT, so "was this ever looked at?" is always answerable');
    ok(q4[0].ourSheet.adjustments[0].costMilli === 375, 'D6 …and the row now describes the situation as it is NOW');

    // =====================================================================
    section('E. an item that stops appearing goes stale — it is never deleted');
    // =====================================================================
    const sKey = q4[0].scenarioKey;
    const st = await store.markStaleFor(ltDb, SCOPE, programId, [sKey], { now: 6_000 });
    ok(st.staled === 1, 'E1 a scenario the run covered whose question did not come back is retired');
    const q5 = await store.listQueue(ltDb, SCOPE, { programId, status: 'stale' });
    ok(q5.length === 1, 'E2 THE ONE THAT MATTERS: it is STALE, not deleted — the record of what was asked survives');

    const none = await store.markStaleFor(ltDb, SCOPE, programId, [], { now: 7_000 });
    ok(none.staled === 0,
      'E3 a run that covered NO scenarios retires nothing — a battery is a sample, never the world');

    const back = await store.recordItems(ltDb, SCOPE, programId, moved.items, { now: 8_000 });
    ok(back.refreshed === 1 || back.reopened === 1, 'E4 …and the question coming back reopens the stale row');
    const q6 = await store.listQueue(ltDb, SCOPE, { programId });
    ok(q6.length === 1 && q6[0].status === 'open', 'E5 …rather than minting a second copy of it');

    // A DECIDED row is never retired by silence: a settled answer is not made obsolete by the question
    // ceasing to come up, and reopening it later would ask a person to re-answer their own decision.
    await store.decide(ltDb, SCOPE, itemId, { decision: 'allow', decidedBy: 'Rule Super' }, { now: 9_000 });
    const st2 = await store.markStaleFor(ltDb, SCOPE, programId, [sKey], { now: 10_000 });
    ok(st2.staled === 0, 'E6 …and a DECIDED question is never retired by silence');

    // =====================================================================
    section('F. the database refuses what the module refuses');
    // =====================================================================
    let dup = null;
    try {
      await ltDb.query(
        `INSERT INTO lt_ppe_disqualifier_review
           (scope, program_id, scenario_key, scenario, item_key, classification, question, state_key,
            first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,'{}'::jsonb,$4,'silent','q','k',1,1)`,
        [SCOPE, programId, sKey, 'dim:dscr']);
    } catch (e) { dup = e; }
    ok(dup && /duplicate key|unique/i.test(dup.message),
      'F1 the database itself refuses a second row for the same question — the upsert cannot be bypassed');

    let anonRow = null;
    try {
      await ltDb.query(
        `INSERT INTO lt_ppe_disqualifier_review
           (scope, program_id, scenario_key, scenario, item_key, classification, question, state_key,
            status, decision, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,'{}'::jsonb,'dim:other','silent','q','k','decided','price',1,1)`,
        [SCOPE, programId, sKey]);
    } catch (e) { anonRow = e; }
    ok(anonRow && /decided_chk|check/i.test(anonRow.message),
      'F2 …and refuses a decided row with nobody named on it, exactly as the module does');

    let badDecision = null;
    try {
      await ltDb.query(
        `INSERT INTO lt_ppe_disqualifier_review
           (scope, program_id, scenario_key, scenario, item_key, classification, question, state_key,
            decision, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,'{}'::jsonb,'dim:other2','silent','q','k','whatever',1,1)`,
        [SCOPE, programId, sKey]);
    } catch (e) { badDecision = e; }
    ok(badDecision && /decision_chk|check/i.test(badDecision.message),
      'F3 …and refuses an answer outside the list');

    // =====================================================================
    section('G. the summary says what KIND of work is waiting, not only how much');
    // =====================================================================
    const otherScenario = { ...SCENARIO, state: 'NY' };
    const silent = review.reviewScenario({
      scenario: otherScenario,
      lp: { ready: true, declined: [{ reasons: [{ rule: 'NY not eligible', adjType: 'StatesRateAdjustment' }] }] },
      ours: { eligible: true, ladder: [{ adjustments: [] }] },
      program: PROGRAM,
    });
    await store.recordItems(ltDb, SCOPE, programId, silent.items, { now: 11_000 });
    const sum = await store.queueSummary(ltDb, SCOPE, programId);
    ok(sum.open >= 1 && sum.decided >= 1, 'G1 the summary counts both what is waiting and what is settled');
    ok(sum.byDimension.state === 1,
      'G2 THE ONE THAT MATTERS: it counts BY DIMENSION — a hundred DSCR questions is one rule to write, not a hundred');
    ok(sum.byClassification.silent === 1, 'G3 …and by kind, so "write a rule" and "widen a band" are told apart');
  } catch (e) {
    fails.push(`unexpected error: ${e.message}`);
    console.log(`  FAIL unexpected error: ${e.message}`);
    console.log(e.stack);
  } finally {
    await cleanup();
    await ltDb.pool.end().catch(() => {});
  }

  if (fails.length) {
    console.log(`\n${fails.length} FAILED of ${passed + fails.length}\n`);
    process.exit(1);
  }
  console.log(`\nall ${passed} passed\n`);
})();

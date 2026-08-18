#!/usr/bin/env node
'use strict';
/**
 * LT PPE - A FIX THAT CAME UNDONE MUST NOT PASS THE GO-LIVE GATE.
 *
 * Pure sections run always; the ledger section needs a real Postgres.
 *
 * WHAT WAS WRONG, MEASURED 2026-08-18. `finding.mergeOne` flags a settled finding that reappears as
 * `regressed` - "this was fixed and it is back, so the fix did not hold". The review queue reads it (it
 * bumps severity and ranks the row) and the console shows a **came back** pill. **No gate read it.**
 *
 * Reproduced end to end: a price disagreement fixed on day 1 and reproducing on day 30 gives
 *
 *   - `openFindings` **0** - the row keeps its settled status, so the "no open findings" term cannot
 *     see it;
 *   - a **30-day clean streak** - `dailySeries` counts a key as NEW only when it was never seen on an
 *     EARLIER day, and this one was seen on day 1, so the day it came back reads as clean;
 *   - `eligibleForLive` -> **eligible: true, no reasons.**
 *
 * So an investor whose fix had come apart could be promoted to live - our engine, not Lender Price,
 * answering a borrower. Both of the other terms are individually correct; the defect was that neither
 * of them is about this, and nothing else was.
 *
 * AND THE REMEDY IS HALF THE FIX. Blocking on a flag nothing can clear is the dead end this repo has
 * closed twice (§2.72's overrides, §2.73's re-register advice). So a human's decision on the finding
 * CLEARS the flag - which is why the two halves ship together and why the clearing is proven here
 * against a real database rather than asserted.
 */
const path = require('path');

const PPE = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const cutover = require(path.join(PPE, 'cutover'));
const finding = require(path.join(PPE, 'finding'));
const scoreboard = require(path.join(PPE, 'scoreboard'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const DAY = 86400000;
const GATE = cutover.settingsToGate({});
const cleanDays = (n) => { const out = []; for (let i = 0; i < n; i += 1) out.push({ dayMs: i * DAY, count: 0 }); return out; };
const board = (findings) => cutover.buildScoreboard({
  canaryAgreementRate: 1,
  findings,
  dailyNewFindings: cleanDays(GATE.minCleanDays),
  nowMs: GATE.minCleanDays * DAY,
  canaryScenarioCount: GATE.minCanaryScenarios,
  canaryIncomparable: 0,
});

// The REAL merge produces the regressed row - never a hand-written `{regressed:true}`, which would be a
// second copy of a contract that can drift.
const incoming = (ms) => finding.recordsFromComparison(
  { findings: [{ kind: 'price_mismatch', rate: 7.5, detail: 'off by 250 milli' }] },
  { investor: 'deephaven', program: 'dscr', scenario: 'CA 720 / 75 LTV', nowMs: ms },
)[0];
const FIXED = { ...incoming(0), status: 'fixed' };
const CAME_BACK = finding.mergeOne(FIXED, incoming(30 * DAY)).record;

// ---------------------------------------------------------------------------
// A - THE MERGE STILL SAYS WHAT IT ALWAYS SAID.
// ---------------------------------------------------------------------------
{
  eq(CAME_BACK.status, 'fixed', 'A1 a settled finding that reappears keeps its settled status - it is never silently reopened');
  eq(CAME_BACK.regressed, true, 'A2 ...and is flagged as a fix that did not hold');
  eq(CAME_BACK.recurrence, 2, 'A3 ...with the sighting count carried');

  // A `wontfix` row is deliberately NOT a regression - §2.72's reasoned overrides recur on every run
  // for ever, and flagging those would put every overriding investor permanently on the wrong side.
  const override = finding.mergeOne({ ...incoming(0), status: 'wontfix' }, incoming(30 * DAY)).record;
  eq(override.regressed, false, 'A4 a wontfix row that recurs is NOT a regression - a reasoned override recurring is expected');
}

// ---------------------------------------------------------------------------
// B - NEITHER OF THE OTHER TWO GATE TERMS CAN SEE IT. This is the measurement.
// ---------------------------------------------------------------------------
{
  const sb = board([CAME_BACK]);
  eq(sb.openFindings, 0, 'B1 the "no open findings" term cannot see it - the row is settled');

  const runs = [];
  for (let i = 0; i <= 30; i += 1) {
    runs.push({
      dayMs: i * DAY,
      agreementRate: 1,
      findingKeys: (i === 0 || i === 30) ? [CAME_BACK.key] : [],
      summary: { comparable: 300, agreed: 300, disagreed: 0, incomparable: 0, errors: 0, agreementRate: 1 },
    });
  }
  const days = scoreboard.dailyNewFindings(runs);
  eq(days[days.length - 1].count, 0,
    'B2 the clean-day streak cannot see it either - the key was seen on day 1, so the day it came BACK reads as clean');
  // Day 0 is dirty (the finding's FIRST sighting is genuinely new); every day after it is clean,
  // including day 30 when it came back. Thirty unbroken clean days straight across the regression.
  eq(cutover.buildScoreboard({ findings: [CAME_BACK], dailyNewFindings: days, nowMs: 30 * DAY }).consecutiveCleanDays, 30,
    'B3 ...leaving an unbroken streak running straight across the day the fix came apart');
}

// ---------------------------------------------------------------------------
// C - SO THE GATE HAS ITS OWN TERM, and it refuses.
// ---------------------------------------------------------------------------
{
  const sb = board([CAME_BACK]);
  eq(sb.regressedFindings, 1, 'C1 the scoreboard counts fixes that did not hold');
  const g = cutover.eligibleForLive(sb);
  ok(!g.eligible, 'C2 AN INVESTOR WHOSE FIX CAME APART IS NOT PROMOTED - which it was, with no reasons at all');
  ok(g.reasons.some((r) => /came back|did not hold/.test(r)), 'C3 ...and the refusal says what is wrong in words');

  // No setting turns it off, for the same reason the incomparable gate has none.
  const relaxed = cutover.eligibleForLive(sb, { minCleanDays: 0, requireCanaryPerfect: false, minCanaryScenarios: 0 });
  ok(!relaxed.eligible && relaxed.reasons.some((r) => /came back|did not hold/.test(r)),
    'C4 no setting relaxes it away - a fix that did not hold is not a matter of degree');

  // ONE ROW, ONE REASON. A human may triage a regressed row back to open; it must not then be counted
  // twice and produce two refusals for one thing.
  const triaged = board([{ ...CAME_BACK, status: 'open' }]);
  eq(triaged.openFindings, 1, 'C5 a regressed row a human reopened counts as open work');
  eq(triaged.regressedFindings, 0, 'C6 ...and is not ALSO counted as a regression - one row, one reason');

  // And a clean investor is unaffected: this term must be silent when nothing came back.
  const clean = board([{ ...FIXED, regressed: false }]);
  eq(clean.regressedFindings, 0, 'C7 an ordinary settled finding is not a regression');
  ok(cutover.eligibleForLive(clean).eligible, 'C8 ...and a clean investor still goes live');
}

// ---------------------------------------------------------------------------
// D - THE REMEDY EXISTS IN THE PURE LAYER: a decided row clears, and the gate opens.
// ---------------------------------------------------------------------------
{
  const decided = { ...CAME_BACK, status: 'verified', regressed: false };
  eq(board([decided]).regressedFindings, 0, 'D1 a finding looked at again is no longer a fix that did not hold');
  ok(cutover.eligibleForLive(board([decided])).eligible, 'D2 ...and the gate opens - the refusal has a way out');

  // ...and if it comes back AGAIN it is flagged again. A remedy that permanently silences the signal
  // would be worse than no signal.
  const secondTime = finding.mergeOne(decided, incoming(60 * DAY)).record;
  eq(secondTime.regressed, true, 'D3 coming back a second time is flagged again - clearing is per settlement, not for ever');
  eq(secondTime.recurrence, 3, 'D4 ...and the permanent sighting count is untouched by any of this');
}

function report() {
  console.log(failures.length
    ? `FAIL - lt ppe regression gate (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
    : `ok - lt ppe regression gate (${pass} assertions)`);
  process.exit(failures.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// E - THE LEDGER, against a real Postgres: the flag is set by a real reconcile and CLEARED by a real
//     decision. A pure test cannot prove the UPDATE writes the column.
// ---------------------------------------------------------------------------
if (!process.env.DATABASE_URL) {
  ok(true, 'E-skip no DATABASE_URL: the ledger half did not run');
  report();
} else {
  (async () => {
    const fs = require('fs');
    const ltDb = require(path.join(__dirname, '..', 'src', 'longterm', 'db'));
    const findingStore = require(path.join(PPE, 'finding-store'));
    const SCOPE = 'company';
    const stamp = `R${process.pid}${Date.now() % 100000}`;
    const INVESTOR = `ZZREG${stamp}`.slice(0, 40);
    const clean = async () => ltDb.query('DELETE FROM lt_ppe_finding WHERE scope = $1 AND investor = $2', [SCOPE, INVESTOR]).catch(() => {});

    try {
      await ltDb.query(fs.readFileSync(path.join(__dirname, '..', 'db', '561_lt_ppe_finding.sql'), 'utf8'));
      await clean();

      const rec = (ms) => finding.recordsFromComparison(
        { findings: [{ kind: 'price_mismatch', rate: 7.5, detail: 'off by 250 milli' }] },
        { investor: INVESTOR, program: 'dscr', scenario: 'CA 720 / 75 LTV', nowMs: ms },
      );

      // 1) the finding appears, 2) a human fixes it, 3) it reproduces.
      await findingStore.persistRun(SCOPE, rec(0), { db: ltDb, nowMs: 0 });
      const key = rec(0)[0].key;
      await findingStore.decideFinding(SCOPE, key, { status: 'fixed', decidedBy: null, reason: 'corrected the LLPA sign' }, ltDb);
      const back = await findingStore.persistRun(SCOPE, rec(30 * DAY), { db: ltDb, nowMs: 30 * DAY });
      eq(back.summary.regressed, 1, 'E1 a real reconcile against the stored ledger flags the returning finding');

      let row = await findingStore.getFinding(SCOPE, key, ltDb);
      eq(row.regressed, true, 'E2 ...and the column is actually written');
      eq(row.status, 'fixed', 'E3 ...without reopening it behind the human');

      const ledger = (await findingStore.listFindings(SCOPE, { investor: INVESTOR }, ltDb)).map(findingStore.rowToRecord);
      eq(cutover.buildScoreboard({ findings: ledger, nowMs: 30 * DAY }).regressedFindings, 1,
        'E4 the scoreboard built from the REAL ledger sees it - the read path carries the flag end to end');
      ok(!cutover.eligibleForLive(board(ledger)).eligible, 'E5 ...so the gate refuses this investor');

      // 4) a human looks at it again — the remedy.
      await findingStore.decideFinding(SCOPE, key, { status: 'verified', decidedBy: null, reason: 'refixed and re-measured' }, ltDb);
      row = await findingStore.getFinding(SCOPE, key, ltDb);
      eq(row.regressed, false, 'E6 A DECISION CLEARS THE FLAG in the database - the refusal has a real way out');
      eq(row.status, 'verified', 'E7 ...and records the decision');
      const after = (await findingStore.listFindings(SCOPE, { investor: INVESTOR }, ltDb)).map(findingStore.rowToRecord);
      ok(cutover.eligibleForLive(board(after)).eligible, 'E8 ...and the gate opens again');

      // 5) coming back a third time flags it again — the signal is not spent.
      const again = await findingStore.persistRun(SCOPE, rec(60 * DAY), { db: ltDb, nowMs: 60 * DAY });
      eq(again.summary.regressed, 1, 'E9 it is flagged again if it comes back again');
      row = await findingStore.getFinding(SCOPE, key, ltDb);
      eq(row.recurrence, 3, 'E10 ...and the permanent sighting count keeps climbing');
    } catch (e) {
      failures.push(`E threw: ${e && e.stack ? e.stack : e}`);
    } finally {
      await clean();
      try { await ltDb.pool.end(); } catch (_) { /* the pool may already be closed */ }
    }
    report();
  })();
}

#!/usr/bin/env node
'use strict';
/**
 * LT PPE - THE GO-LIVE COVERAGE FIGURE MUST RECONCILE, AND ITS REFUSAL MUST NAME THE REAL REMEDY (§2.79).
 *
 * OFFLINE: pure. No database, no vendor call. Section A drives the REAL runner.
 *
 * MEASURED 2026-08-18, before the fix. A 300-scenario canary with 100 reasoned overlay overrides and 4
 * scenarios where an engine threw put this on the board:
 *
 *   canaryScenarioCount: 196   canaryIncomparable: 0
 *   refusal: "only 196 compared canary scenario(s), needs at least 200"
 *
 * Every number is CORRECT and 104 scenarios are named NOWHERE. Read on a screen, "196, and none were
 * incomparable" says the battery is too small — so the obvious response is to add scenarios, which
 * cannot help, while the two real causes (a third of the battery is deliberately not scored against
 * Lender Price, and four scenarios threw) go unsaid. This is the repo's standing rule that **a number a
 * person cannot reconcile is a defect even when it is right**, and that when a total splits into
 * buckets you show every bucket rather than an "e.g.".
 *
 * THE PARTITION IS THE PROPERTY, and it is proven on a REAL run rather than asserted:
 *
 *   compared + errors + overlay + incomparable === scenarios
 *
 * `parity.bucketsOf` is the one definition of that split, and `unaccounted` is the belt to its brace —
 * buckets that do not add up mean the run's own tally is broken, which BLOCKS promotion rather than
 * being absorbed into whichever bucket sits nearest.
 */
const path = require('path');
const fs = require('fs');

const PPE = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const parity = require(path.join(PPE, 'parity'));
const shadow = require(path.join(PPE, 'shadow'));
const overlayLib = require(path.join(PPE, 'overlay'));
const scoreboard = require(path.join(PPE, 'scoreboard'));
const cutover = require(path.join(PPE, 'cutover'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const has = (arr, re, what) => ok((arr || []).some((r) => re.test(String(r))), `${what} (reasons: ${JSON.stringify(arr)})`);

const DAY = Date.parse('2026-08-18T00:00:00Z');
const NOW = Date.parse('2026-08-18T12:00:00Z');
const runOf = (summary) => [{ dayMs: DAY, agreementRate: summary.agreementRate == null ? null : summary.agreementRate, summary, newFindings: 0 }];

// ---------------------------------------------------------------------------
// A - THE PARTITION, PROVEN ON A REAL RUN. A hand-built summary would only prove the arithmetic I typed;
//     this proves it of the shape `shadow.summarize` actually produces, one scenario of every kind.
// ---------------------------------------------------------------------------
async function sectionA() {
  const OK_Q = { eligible: true, ladder: [{ rate: 7.5, finalPriceMilli: 101000 }] };
  const OFF_Q = { eligible: true, ladder: [{ rate: 7.5, finalPriceMilli: 100750 }] };
  const LP = { eligible: true, rungs: [{ rate: 7.5, priceMilli: 101000 }] };
  const OVL = { eligible: false, ladder: [], declines: [overlayLib.overlayDecline('short_term_rental', 'STR — max LTV 75%', { code: 'dhvn_str' })] };

  const kinds = ['agree', 'agree', 'dis', 'ovl', 'ovl', 'err', 'incmp'];
  const scenarios = kinds.map((k, i) => ({ _label: `S${i}`, k }));
  const run = await shadow.runShadow(scenarios, {
    ours: async (s) => { if (s.k === 'err') throw new Error('boom'); if (s.k === 'ovl') return OVL; if (s.k === 'dis') return OFF_Q; return OK_Q; },
    theirs: async (s) => (s.k === 'incmp' ? {} : LP),
  }, { priceToleranceMilli: 1 });

  const b = parity.bucketsOf(run.summary);
  eq(b.scenarios, 7, 'A1 the run priced seven scenarios');
  eq(b.compared, 3, 'A2 …three of which were genuinely compared (agreed + disagreed, less the throw)');
  eq(b.errors, 1, 'A3 …one hit an engine error');
  eq(b.overlay, 2, 'A4 …two were reasoned overrides');
  eq(b.incomparable, 1, 'A5 …one could not be compared at all');
  eq(b.compared + b.errors + b.overlay + b.incomparable, b.scenarios,
    'A6 THE PROPERTY: the four buckets partition the run exactly — this is what makes the board reconcilable');
  eq(b.unaccounted, 0, 'A7 …so nothing is unaccounted for');
  eq(b.compared, parity.comparedOf(run.summary),
    'A8 `compared` is the SAME definition §2.77 settled on — never a second copy');
}

// ---------------------------------------------------------------------------
// B - NULL IS NOT ZERO. "Nobody measured" and "measured nothing" send a reader to two different places.
// ---------------------------------------------------------------------------
{
  const none = parity.bucketsOf(null);
  eq(none.compared, null, 'B1 no summary at all reports null, never 0');
  eq(none.scenarios, null, 'B2 …and no total');
  eq(none.unaccounted, null, 'B3 …and refuses to claim the buckets add up');

  const noCoupling = parity.bucketsOf({ scenarios: 10 });
  eq(noCoupling.scenarios, 10, 'B4 a summary that recorded a total reports it');
  eq(noCoupling.compared, null, 'B5 …but with no `comparable` figure, nothing was coupled — null, not 0');
  eq(noCoupling.unaccounted, null, 'B6 …so the partition is unknowable rather than "wrong by 10"');

  const zero = parity.bucketsOf({ scenarios: 0, comparable: 0, errors: 0, overlay: 0, incomparable: 0 });
  eq(zero.compared, 0, 'B7 a battery that really did compare nothing reports 0 — a different fact');
  eq(zero.unaccounted, 0, 'B8 …and still adds up');
}

// ---------------------------------------------------------------------------
// C - THE BOARD. The measured case, end to end through the real assemble.
// ---------------------------------------------------------------------------
{
  const summary = { scenarios: 300, agreed: 190, disagreed: 10, overlay: 100, incomparable: 0, comparable: 200, errors: 4, findings: 10, agreementRate: 190 / 200 };
  const { scoreboard: sb, eligible } = scoreboard.assemble(runOf(summary), [], { nowMs: NOW });

  eq(sb.canaryScenarioCount, 196, 'C1 the gate still reads exactly what §2.77 settled — 196, unchanged');
  eq(sb.canaryScenarios, 300, 'C2 THE FIX: the board now carries the run TOTAL, so 196 can be placed');
  eq(sb.canaryOverlay, 100, 'C3 …the reasoned overrides that were subtracted in silence');
  eq(sb.canaryErrors, 4, 'C4 …and the scenarios where an engine threw');
  eq(sb.canaryIncomparable, 0, 'C5 …beside the count it already carried');
  eq(sb.canaryScenarioCount + sb.canaryErrors + sb.canaryOverlay + sb.canaryIncomparable, sb.canaryScenarios,
    'C6 the page ADDS UP — which is the whole point, and was the thing a reader could not do');
  eq(sb.canaryUnaccounted, 0, 'C7 …with nothing left over');

  has(eligible.reasons, /only 196 of 300 compared/,
    'C8 the refusal places the number against the battery it came from');
  has(eligible.reasons, /100 were reasoned overlay overrides/,
    'C9 …names the biggest subtraction');
  has(eligible.reasons, /4 hit an engine error/, 'C10 …and the other one');
  has(eligible.reasons, /a bigger battery is not the remedy/,
    'C11 …and says plainly that the obvious response would not help — the reason the old wording was harmful');
}

// ---------------------------------------------------------------------------
// D - IT ADDS NOTHING WHERE THERE IS NOTHING TO SAY. A clean run's refusal (or absence of one) must read
//     exactly as it did before, or every screen gains noise for the sake of the rare case.
// ---------------------------------------------------------------------------
{
  const clean = { scenarios: 250, agreed: 250, disagreed: 0, overlay: 0, incomparable: 0, comparable: 250, errors: 0, findings: 0, agreementRate: 1 };
  const { scoreboard: sb, eligible } = scoreboard.assemble(runOf(clean), [], { nowMs: NOW });
  eq(sb.canaryScenarioCount, 250, 'D1 a clean run compares everything');
  eq(sb.canaryUnaccounted, 0, 'D2 …and adds up');
  ok(!(eligible.reasons || []).some((r) => /compared canary scenario/.test(String(r))),
    'D3 …so the coverage floor says nothing at all — the wording only appears when it is short');

  const thin = { scenarios: 10, agreed: 10, disagreed: 0, overlay: 0, incomparable: 0, comparable: 10, errors: 0, findings: 0, agreementRate: 1 };
  const thinGate = scoreboard.assemble(runOf(thin), [], { nowMs: NOW }).eligible;
  has(thinGate.reasons, /only 10 of 10 compared canary scenario\(s\), needs at least 200$/,
    'D4 a genuinely THIN battery still reads as thin — and names no subtraction, because there was none');

  // A board assembled without the split (an older persisted run) must produce the OLD message verbatim.
  const legacy = cutover.eligibleForLive(
    { canaryAgreementRate: 1, openFindings: 0, regressedFindings: 0, consecutiveCleanDays: 999, canaryScenarioCount: 12 },
    { minCanaryScenarios: 200, minCleanDays: 0, requireCanaryPerfect: false },
  );
  has(legacy.reasons, /^only 12 compared canary scenario\(s\), needs at least 200$/,
    'D5 a scoreboard that never recorded a split produces exactly the message it produced before');
}

// ---------------------------------------------------------------------------
// E - BUCKETS THAT DO NOT ADD UP ARE NOT PROOF. Reported, and blocking — never absorbed.
// ---------------------------------------------------------------------------
{
  // 300 scenarios but only 196 + 4 + 0 + 0 = 200 accounted for: 100 vanished somewhere upstream.
  const broken = { scenarios: 300, agreed: 190, disagreed: 10, overlay: 0, incomparable: 0, comparable: 200, errors: 4, findings: 10, agreementRate: 1 };
  const { scoreboard: sb, eligible } = scoreboard.assemble(runOf(broken), [], { nowMs: NOW });
  eq(sb.canaryUnaccounted, 100, 'E1 a run whose tally does not partition reports the gap rather than hiding it');
  has(eligible.reasons, /does not add up — 100 scenario\(s\) are in no bucket/,
    'E2 …and the gate refuses, because a broken measurement is not proof of anything');

  // The gate must refuse EVEN when every other bar is met — that is what "not proof" means.
  const allGood = cutover.eligibleForLive(
    { canaryAgreementRate: 1, openFindings: 0, regressedFindings: 0, consecutiveCleanDays: 999, canaryScenarioCount: 300, canaryIncomparable: 0, canaryUnaccounted: 7 },
    { minCanaryScenarios: 200, minCleanDays: 0, requireCanaryPerfect: true },
  );
  eq(allGood.eligible, false, 'E3 an otherwise perfect investor is still refused while its tally is broken');
  eq(allGood.reasons.length, 1, 'E4 …on that one ground alone, so the cause is unmistakable');
}

// ---------------------------------------------------------------------------
// F - ONE DEFINITION, AND THE SCREEN ACTUALLY SHOWS IT. Source guards, because no unit test can see
//     either a second copy of the split or a board field nothing renders.
// ---------------------------------------------------------------------------
{
  const sbSrc = fs.readFileSync(path.join(PPE, 'scoreboard.js'), 'utf8');
  ok(/parity\.bucketsOf\(/.test(sbSrc),
    'F1 the scoreboard takes the split from the shared definition');
  ok(!/parity\.comparedOf\(/.test(sbSrc),
    'F2 …and no longer computes `compared` a second way beside it — bucketsOf already is comparedOf');

  const cutSrc = fs.readFileSync(path.join(PPE, 'cutover.js'), 'utf8');
  for (const k of ['canaryScenarios', 'canaryOverlay', 'canaryErrors', 'canaryUnaccounted']) {
    ok(new RegExp(`${k}:\\s*num\\(input\\.${k}\\)`).test(cutSrc),
      `F3 buildScoreboard carries ${k} through — a field the board drops is a field the screen can never show`);
  }

  const screen = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'longterm', 'LtPpe.jsx'), 'utf8');
  ok(/canaryScenarios/.test(screen), 'F4 the screen reads the run total');
  ok(/canaryOverlay/.test(screen) && /canaryErrors/.test(screen),
    'F5 …and both silent subtractions — a number carried to the board and rendered nowhere is the same defect one step later');
  ok(/canaryUnaccounted/.test(screen),
    'F6 …and says out loud when the tally does not add up');
}

async function main() {
  await sectionA();
  console.log(failures.length
    ? `FAIL - lt ppe coverage reconciles (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
    : `ok - lt ppe coverage reconciles (${pass} assertions)`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.log(`FAIL - lt ppe coverage reconciles (threw: ${e && e.stack})`); process.exit(1); });

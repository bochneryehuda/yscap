#!/usr/bin/env node
'use strict';
/**
 * LT PPE - the run-level refusal accumulator behind P2's auto-wiring (`ppe/disqualifier-mining.js`).
 *
 * OFFLINE: pure. No database, no network.
 *
 * WHAT IS WORTH TESTING HERE, and it is not "does it collect things". The accumulator sits in the JOIN
 * between two modules that each already work: the normalizer that scopes Lender Price's refusals, and
 * the analyser that turns them into suggestions. Every defect this workstream has found lived in
 * exactly such a join, so the assertions below are about the SEAM:
 *
 *   - the shape it emits is the shape `analyzeDisqualifications` actually reads (asserted by running
 *     the real analyser over it, never by eyeballing keys);
 *   - the investor keying matches `investorKeyOf`'s own rule (investor, else lender, else Unknown);
 *   - a not-ready feed contributes NOTHING, so a vendor hiccup can never be counted as "nothing was
 *     refused";
 *   - an empty run reports ready:false, so it cannot be read as a measured clean sheet;
 *   - `occurrences` and `programs` mean what the module says they mean - measured against the real
 *     analyser, because that is the only thing whose opinion counts.
 */
const path = require('path');
const mining = require(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'disqualifier-mining'));
const { analyzeDisqualifications } = require(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'disqualify-analysis'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const declined = (rows) => ({ ready: true, declined: rows });
const row = (investor, program, rule, adjType = null, lender = 'LenderCo') =>
  ({ lender, investor, program, reasons: [{ rule, adjType }] });

// ---------------------------------------------------------------------------
// A - the seam: what we emit is what the analyser reads.
// ---------------------------------------------------------------------------
{
  const acc = mining.createAccumulator();
  mining.add(acc, declined([row('Deephaven', 'DSCR 30yr Fixed', 'FICO below 680', 'FICO')]));
  const parsed = mining.toParsed(acc);

  ok(parsed.ready === true, 'A1 a run that gathered something is ready');
  ok(Array.isArray(parsed.lenders) && parsed.lenders.length === 1, 'A2 one investor group');
  const lg = parsed.lenders[0];
  ok(Array.isArray(lg.items) && lg.items.length === 1, 'A3 the group carries items[], the analyser shape');
  eq(lg.items[0].program, 'DSCR 30yr Fixed', 'A4 the program rides on the ITEM, not the group');

  // The only opinion that matters: run the REAL analyser over it.
  const a = analyzeDisqualifications(parsed);
  ok(a.ready === true, 'A5 the real analyser accepts the emitted shape');
  eq(a.investors.length, 1, 'A6 the analyser finds one investor');
  eq(a.summary.suggestionCount + a.summary.unmappedCount, 1, 'A7 and exactly one distinct refusal');
}

// ---------------------------------------------------------------------------
// B - investor keying mirrors disqualify-analysis.investorKeyOf: investor, else lender, else Unknown.
//     Getting this wrong splits one investor's suggestions across two keys, or merges two investors.
// ---------------------------------------------------------------------------
{
  const acc = mining.createAccumulator();
  mining.add(acc, declined([
    { lender: 'LenderCo', investor: 'Deephaven', program: 'P', reasons: [{ rule: 'r1', adjType: null }] },
    { lender: 'OnlyLender', investor: null, program: 'P', reasons: [{ rule: 'r2', adjType: null }] },
    { lender: null, investor: null, program: 'P', reasons: [{ rule: 'r3', adjType: null }] },
  ]));
  const a = analyzeDisqualifications(mining.toParsed(acc));
  const keys = a.investors.map((i) => i.investor).sort();
  ok(keys.length === 3, 'B1 three distinct investor keys');
  ok(keys.includes('Deephaven'), 'B2 the investor name wins when present');
  ok(keys.includes('OnlyLender'), 'B3 the lender is the fallback key');
  ok(keys.includes('Unknown'), 'B4 and Unknown is the last resort - never a crash, never a merge');
}

// ---------------------------------------------------------------------------
// C - FAIL CLOSED. A refusal list that never arrived contributes nothing.
//     This is the one that matters most: counting a missing feed as "nothing refused" would let a
//     vendor outage read as a sheet in perfect agreement.
// ---------------------------------------------------------------------------
{
  const acc = mining.createAccumulator();
  eq(mining.add(acc, { ready: false, declined: [] }), false, 'C1 a not-ready feed contributes nothing');
  eq(mining.add(acc, { ready: false, declined: [row('X', 'P', 'r')] }), false,
    'C2 not-ready wins even when rows are present - readiness is the vendor telling us the list is complete');
  eq(mining.add(acc, null), false, 'C3 a null payload contributes nothing');
  eq(mining.add(acc, {}), false, 'C4 an empty object contributes nothing');
  eq(mining.toParsed(acc).ready, false, 'C5 so the run is NOT ready - it did not measure');
  eq(mining.summarize(acc).scenariosWithRefusals, 0, 'C6 and nothing is counted');
  eq(mining.summarize(acc).scenarios, 4, 'C7 while the scenarios still count as looked-at');
}

// ---------------------------------------------------------------------------
// D - an EMPTY run is not a clean run. ready:false is what stops the caller mining a hollow payload
//     and reporting "no disqualifications to mine", which reads like an answer.
// ---------------------------------------------------------------------------
{
  eq(mining.toParsed(mining.createAccumulator()).ready, false, 'D1 a run with no scenarios is not ready');
  eq(mining.toParsed(null).ready, false, 'D2 and neither is a missing accumulator');
  eq(mining.toParsed(undefined).lenders.length, 0, 'D3 which still returns a usable empty shape');
}

// ---------------------------------------------------------------------------
// E - occurrences and programs, measured through the real analyser.
// ---------------------------------------------------------------------------
{
  const acc = mining.createAccumulator();
  // Scenario 1: LP repeats the SAME refusal on two rows of one program - that is one observation.
  mining.add(acc, declined([
    row('Deephaven', 'DSCR 30yr', 'FICO below 680', 'FICO'),
    row('Deephaven', 'DSCR 30yr', 'FICO below 680', 'FICO'),
  ]));
  const a1 = analyzeDisqualifications(mining.toParsed(acc));
  const s1 = [...a1.investors[0].suggestions, ...a1.investors[0].unmapped][0];
  eq(s1.occurrences, 1, 'E1 one refusal repeated on two rows of one program counts ONCE');

  // Scenario 2: the same reason, a different program - a second observation, and the program unions.
  mining.add(acc, declined([row('Deephaven', 'DSCR IO', 'FICO below 680', 'FICO')]));
  const a2 = analyzeDisqualifications(mining.toParsed(acc));
  const s2 = [...a2.investors[0].suggestions, ...a2.investors[0].unmapped][0];
  eq(s2.occurrences, 2, 'E2 the same reason on a second program is a second observation');
  ok(s2.programs.length === 2 && s2.programs.includes('DSCR IO'),
    'E3 and BOTH programs are recorded - the reason the program stays in the dedupe key');

  // Scenario 3: the same reason and the same program again - a third observation across the run.
  mining.add(acc, declined([row('Deephaven', 'DSCR 30yr', 'FICO below 680', 'FICO')]));
  const a3 = analyzeDisqualifications(mining.toParsed(acc));
  const s3 = [...a3.investors[0].suggestions, ...a3.investors[0].unmapped][0];
  eq(s3.occurrences, 3, 'E4 a later scenario hitting the same program counts again');
  eq(s3.programs.length, 2, 'E5 without inventing a third program');
}

// ---------------------------------------------------------------------------
// E2 - THE CASE THE PROGRAM-IN-THE-KEY ACTUALLY EXISTS FOR: ONE scenario refusing the SAME reason on
//      TWO programs. E3 above looked like it covered this and does not - the `seen` set is per
//      scenario, so two programs arriving in two SEPARATE calls both land whatever the key contains.
//      Only a single payload carrying both can tell the two designs apart, which is why dropping the
//      program from the dedupe key survived the first cut of this suite. Proven by mutation.
// ---------------------------------------------------------------------------
{
  const acc = mining.createAccumulator();
  mining.add(acc, declined([
    row('Deephaven', 'DSCR 30yr', 'FICO below 680', 'FICO'),
    row('Deephaven', 'DSCR IO', 'FICO below 680', 'FICO'),
    row('Deephaven', 'DSCR IO', 'FICO below 680', 'FICO'),   // a repeat row - still one observation
  ]));
  const a = analyzeDisqualifications(mining.toParsed(acc));
  const s = [...a.investors[0].suggestions, ...a.investors[0].unmapped][0];
  eq(s.programs.length, 2, 'E6 one scenario refusing two programs records BOTH');
  ok(s.programs.includes('DSCR 30yr') && s.programs.includes('DSCR IO'),
    'E7 …naming each of them - this is what the program in the dedupe key buys');
  eq(s.occurrences, 2, 'E8 …counted as two scenario-and-program observations, the repeat row deduped');
}

// ---------------------------------------------------------------------------
// F - junk is survived, never thrown. A malformed feed must cost one scenario, not the run.
// ---------------------------------------------------------------------------
{
  const acc = mining.createAccumulator();
  const junk = [
    { ready: true, declined: [{ reasons: 'not-an-array' }] },
    { ready: true, declined: [{ reasons: [{ rule: '   ' }] }] },      // blank rule - the analyser skips these
    { ready: true, declined: [{ reasons: [null, undefined] }] },
    { ready: true, declined: 'not-an-array' },
    { ready: true, declined: [null] },
  ];
  let threw = false;
  for (const j of junk) { try { mining.add(acc, j); } catch (_) { threw = true; } }
  ok(!threw, 'F1 no malformed payload throws');
  eq(mining.toParsed(acc).ready, false, 'F2 and none of it becomes a phantom refusal');

  // A real refusal still lands after the junk - one bad scenario must not poison the run.
  mining.add(acc, declined([row('Deephaven', 'P', 'a real reason')]));
  eq(mining.toParsed(acc).ready, true, 'F3 a real refusal after the junk still lands');
}

// ---------------------------------------------------------------------------
// G - the wiring itself: the route must feed mining BEFORE the review's readiness return, or every
//     scenario the review cannot use is silently dropped from the suggestions too. A source guard,
//     because no unit test of this module can see its caller.
// ---------------------------------------------------------------------------
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
  const hook = (src.match(/const collectReview = \([\s\S]*?\n  \};/) || [''])[0];
  ok(/disqualifierMining\.add\(mineAcc, lpDisq\)/.test(hook),
    'G1 the run feeds the accumulator from the SCOPED normalized list (never the raw legs.disqualified)');
  const addAt = hook.indexOf('disqualifierMining.add');
  const retAt = hook.indexOf('if (!rev.ready) return;');
  ok(addAt > 0 && retAt > 0 && addAt < retAt,
    'G2 and feeds it BEFORE the review bails on !rev.ready - the two questions must not share one gate');
  ok(/suggestionMiner\.mineFromParsed\(db, found\.scope, parsedForMining\)/.test(src),
    'G3 the run mines once, from the merged payload');
  ok(/mining\.skipped = 'no_refusals_read'/.test(src),
    'G4 and says so plainly when no scenario carried a refusal list, rather than reporting a clean zero');
}

console.log(failures.length
  ? `FAIL - lt ppe disqualifier mining (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
  : `ok - lt ppe disqualifier mining (${pass} assertions)`);
process.exit(failures.length ? 1 : 0);

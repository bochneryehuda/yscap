#!/usr/bin/env node
'use strict';
/**
 * LT PPE — A SCENARIO THAT VANISHED IS NOT A SCENARIO THAT AGREED (§2.90).
 *
 * ⛔ THE DEFECT, MEASURED ON THE LIVE 2026-08-18 RUN. The E3 publish gate is
 * `gateMet = errors === 0 && disagreed === 0 && comparable > 0`, and `comparable = agreed + disagreed`.
 * A scenario Lender Price gave no usable answer for is in NONE of those terms — it leaves the battery
 * silently. So a 299-scenario run with 295 agreed and 4 incomparable reported **agreement 100.00%,
 * GATE MET YES**, and `gateDecision` called the sheet `proven` with the message *"Agreed with Lender
 * Price on all 295 comparable scenarios"* — literally true, and silent about the four.
 *
 * The four that actually vanished on that run were `ltv 85`, `huge loan 3.5M`, and **both** of the
 * battery's only prepayment-penalty-prohibition probes. So the axis the owner has asked about twice
 * was the axis that disappeared, and the verdict said nothing.
 *
 * ⛔ AND THE RULE ALREADY EXISTED ONE FILE OVER. `cutover.eligibleForLive` blocks a promotion on ANY
 * incomparable canary scenario, no setting can turn it off, in its own words: *"100% 'agreement' over
 * scenarios that could not all be compared is not 100% agreement."* The same discipline was ENFORCED
 * on the canary path and merely COMMENTED on the publish path — this file's own note on
 * `MIN_COMPARABLE_SCENARIOS` names the danger ("a 200-scenario battery where 190 were incomparable
 * proves almost nothing") and then counts only the comparable ones. **Two definitions of one rule, and
 * the weaker one guarded the money.** That is the class this suite closes, so section E asserts the
 * two paths agree rather than merely that this one behaves.
 *
 * ⛔ THIS GATE IS NOW STRICTER. A run that previously proved a sheet with scenarios missing no longer
 * does. That is the intended direction and is asserted explicitly, not left as a side effect.
 *
 *   node scripts/test-lt-ppe-vanished-scenarios.js
 *
 * PURE — no DB, no network. LT-only.
 */
const path = require('path');
const fs = require('fs');
const store = require('../src/longterm/ppe/agreement-store');
const cutover = require('../src/longterm/ppe/cutover');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// A run record in the shape `rowToRecord` produces. Defaults are the live 2026-08-18 battery with the
// 41 disagreements repaired — i.e. exactly the run that WOULD have wrongly proven the sheet.
function run(o = {}) {
  const base = { kind: 'run', gateMet: true, scenarios: 299, comparable: 295, agreed: 295, disagreed: 0,
    errors: 0, summary: { incomparable: 4, incomparableByReason: { lp_no_signal: 4 } }, recordedAt: 1 };
  const r = { ...base, ...o };
  if (o.summary !== undefined) r.summary = o.summary;
  return r;
}
const decide = (r) => store.gateDecision([r]);

// ---- A: the counting helper ---------------------------------------------------------------------
console.log('-- A: how many vanished, and from where --');
{
  const a = store.incomparableOf(run());
  ok(a.count === 4 && a.source === 'summary', `the harness's own count is preferred (${a.count} via ${a.source})`);
  // total = comparable + incomparable + errors, so the columns imply it even with no summary blob.
  const b = store.incomparableOf(run({ summary: null }));
  ok(b.count === 4 && b.source === 'derived', `with no summary the COLUMNS still imply it (${b.count} via ${b.source})`);
  const c = store.incomparableOf(run({ scenarios: 299, comparable: 291, errors: 4, summary: null }));
  ok(c.count === 4, 'errors are their own term — they are counted and skipped, never inside comparable');
  const clean = store.incomparableOf(run({ scenarios: 299, comparable: 299, agreed: 299, summary: { incomparable: 0 } }));
  ok(clean.count === 0 && clean.source === 'summary', 'a genuinely complete run reports zero');
  // ⛔ A ROW THAT CONTRADICTS ITSELF IS REFUSED, NOT RESOLVED. Picking either number silently would be
  // choosing which of two disagreeing records to believe about the thing being gated on.
  const bad = store.incomparableOf(run({ summary: { incomparable: 0 } }));
  ok(bad.count === null && bad.source === 'contradiction' && bad.stated === 0 && bad.derived === 4,
    'summary and columns disagreeing yields a CONTRADICTION, not a guess');
  const un = store.incomparableOf({ kind: 'run', summary: null });
  ok(un.count === null && un.source === 'unreadable', 'a row with neither readable answers null, never 0');
  const neg = store.incomparableOf(run({ scenarios: 100, comparable: 200, errors: 0, summary: null }));
  ok(neg.count === null, 'a NEGATIVE derived count is not a count — the row does not add up, so it is refused');
}

// ---- B: the gate refuses -----------------------------------------------------------------------
console.log('\n-- B: the publish gate --');
{
  const d = decide(run());
  ok(d.proven === false, 'THE DEFECT: a run with 295 agreed and 4 vanished is NO LONGER proven');
  ok(d.reason === 'incomparable_scenarios', `…with its own named reason (${d.reason})`);
  ok(/4 of 299/.test(d.message), '…and the message names BOTH numbers, so the gap is visible');
  ok(/never compared at all/.test(d.message), '…and says plainly that they were never compared');
  // The reason must be distinct from every other refusal, or a reader cannot tell what to do next.
  const others = ['never_measured', 'disagrees', 'nothing_comparable', 'too_few_scenarios', 'unreadable'];
  ok(!others.includes(d.reason), `…and is distinct from ${others.join(' / ')}`);
}
{
  const d = decide(run({ scenarios: 299, comparable: 299, agreed: 299, summary: { incomparable: 0 } }));
  ok(d.proven === true, 'a run that compared EVERYTHING is still proven — the gate did not simply become impossible');
  ok(/299 of 299/.test(d.message) && /none left uncompared/.test(d.message),
    '…and its message now states COVERAGE, not only agreement');
}
{
  // The contradiction and the unreadable row each get their own refusal, because "the row does not add
  // up" and "the row does not say" send a reader to two different places.
  const c = decide(run({ summary: { incomparable: 0 } }));
  ok(c.proven === false && c.reason === 'coverage_contradiction', `a self-contradicting row is refused (${c.reason})`);
  ok(/0/.test(c.message) && /4/.test(c.message), '…naming both of the numbers that disagree');
  const u = decide({ kind: 'run', gateMet: true, summary: null, recordedAt: 1 });
  ok(u.proven === false && ['coverage_unknown', 'nothing_comparable'].includes(u.reason),
    `a row that cannot state its coverage is refused (${u.reason})`);
}
// The pre-existing refusals must still fire, and must still fire FIRST where they are more specific.
{
  ok(decide(run({ gateMet: false, disagreed: 41 })).reason === 'disagrees',
    'a run with disagreements still reports `disagrees`, not the new reason');
  ok(decide(run({ scenarios: 10, comparable: 10, agreed: 10, summary: { incomparable: 0 } })).reason === 'too_few_scenarios',
    'a complete but tiny run still reports `too_few_scenarios`');
  ok(decide([]).proven === false, 'no run at all is still not proven');
}
// ⛔ ORDERING IS LOAD-BEARING, so it is asserted. "We compared 295 of 299" and "we compared only 295"
// are different facts; a reader told the second would never go looking for the first.
{
  const both = decide(run({ scenarios: 299, comparable: 150, agreed: 150, summary: { incomparable: 149 } }));
  ok(both.reason === 'incomparable_scenarios',
    'when a run is BOTH incomparable-heavy and under the scale floor, the vanished scenarios are reported first');
}

// ---- C: this gate is now STRICTER, said out loud -------------------------------------------------
console.log('\n-- C: the change of behaviour, stated --');
{
  // The exact shape that used to pass. If this ever proves again, the fix has been undone.
  const wouldHavePassed = run();
  ok(wouldHavePassed.gateMet === true && wouldHavePassed.disagreed === 0 && wouldHavePassed.errors === 0,
    'the harness itself still says gateMet TRUE on this run — the harness is not what changed');
  ok(wouldHavePassed.comparable >= 200, '…and it clears the ≥200 scale floor, so nothing else was refusing it');
  ok(decide(wouldHavePassed).proven === false, '…and the TRUST decision now refuses it anyway. That is the whole fix.');
}

// ---- D: the two paths now agree -----------------------------------------------------------------
console.log('\n-- D: one rule, not two --');
{
  // The canary path has always blocked on this. The point of the fix is that the publish path now
  // reaches the same verdict on the same fact — asserted against the real function, not restated.
  const sb = { canaryAgreementRate: 1, canaryIncomparable: 4, consecutiveCleanDays: 999, canaryScenarioCount: 295, canaryUnaccounted: 0 };
  const live = cutover.eligibleForLive(sb, { minCleanDays: 1, requireCanaryPerfect: true });
  ok(live.eligible === false, 'the canary path refuses a scoreboard with 4 incomparable');
  ok((live.reasons || []).some((r) => /could not be compared/i.test(r)), `…naming them: ${(live.reasons || []).join(' | ')}`);
  ok(decide(run()).proven === false, 'and the publish path now refuses the same fact');
  const bothClean = cutover.eligibleForLive({ ...sb, canaryIncomparable: 0 }, { minCleanDays: 1, requireCanaryPerfect: true });
  ok(bothClean.eligible === true, 'both paths accept when nothing vanished — the rule is symmetric, not merely strict');
}

// ---- E: the claim in the source ------------------------------------------------------------------
console.log('\n-- E: the wiring --');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/longterm/ppe/agreement-store.js'), 'utf8');
  ok(typeof store.incomparableOf === 'function', 'incomparableOf is exported');
  ok(/incomparableOf\(latest\)/.test(src), 'gateDecision CALLS it — not merely defines it');
  // ⛔ THE GUARD READS CODE, NOT PROSE — third time today. This assertion failed on its first run
  // against the COMMENT that explains the fix, which necessarily names the canary function it is
  // matching. A guard that cannot tell an explanation from an import punishes documenting the fix.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok(/eligibleForLive/.test(src), 'the canary rule is NAMED in the prose, so the next reader finds its twin');
  ok(!/require\(['"]\.\/cutover['"]\)/.test(codeOnly) && !/eligibleForLive/.test(codeOnly),
    '…but the publish path does not IMPORT it — the two stay independent implementations of one rule, and section D is what keeps them honest');
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

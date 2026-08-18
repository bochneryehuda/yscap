#!/usr/bin/env node
'use strict';
/**
 * LT PPE - THE DAILY CHECK MUST RECORD *WHY* A PRICE DISAGREED, NOT ONLY *WHAT* (§2.78).
 *
 * OFFLINE: pure. No database, no vendor call. It drives the REAL runner.
 *
 * THE MECHANISM, WHICH IS THE WHOLE POINT. `divergence.diagnose` puts our own price build-up — base →
 * itemized LLPAs → margin → round → clamp — beside Lender Price's single number and names the ONE
 * component whose magnitude matches the gap. That evidence exists exactly once: at the moment we hold
 * both quotes. The findings ledger stores `our_payload` as NULL, so a screen re-deriving it later would
 * have to re-price against whatever the sheet says TODAY and would quietly answer a different question.
 *
 * MEASURED 2026-08-18, before the fix: the diagnosis was wired ONLY in `facade.js` — the LIVE shadow
 * path, which needs vendor credentials. The CANARY — the owner's daily check, six runs a day, the thing
 * that actually fills the review queue — goes through `shadow.runOne`, which compared the two quotes and
 * then DROPPED ours. On a scenario whose margin is exactly 250 and whose gap is exactly -250 the ledger
 * recorded `price_mismatch, deltaMilli -250` and NO explanation, while this module would have said
 * "strong: the margin exactly accounts for the gap".
 *
 * A SELF-INFLICTED INSTANCE OF THE SAME CLASS, worth recording. Moving the function into
 * `divergence.js` left its body calling `divergence.diagnose(...)` — a qualifier that resolves in the
 * facade and resolves to NOTHING inside the module itself. The ReferenceError was swallowed by the
 * function's own `catch (_)`, which exists so a diagnosis can never cost a verdict. So the wiring was
 * "done", nothing threw, every suite passed, and not one explanation was attached. Section C below is
 * the guard: it proves the catch still swallows AND proves an ordinary case still produces one, because
 * only the pair together can tell a working attach from a silently dead one.
 */
const path = require('path');
const fs = require('fs');

const PPE = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const shadow = require(path.join(PPE, 'shadow'));
const divergence = require(path.join(PPE, 'divergence'));
const facade = require(path.join(PPE, 'facade'));
const parity = require(path.join(PPE, 'parity'));
const finding = require(path.join(PPE, 'finding'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Source guards read CODE, never prose. A block comment that quotes a forbidden form is documentation.
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

// The measured scenario, exactly: a 250-milli margin and a 250-milli gap, so the diagnosis has ONE
// component that accounts for the whole difference and must say so with full confidence.
const OURS = {
  eligible: true,
  ladder: [
    { rate: 7.5, basePriceMilli: 101000, marginMilli: 250, llpaTotalMilli: 0, finalPriceMilli: 100750 },
    { rate: 7.25, basePriceMilli: 100500, marginMilli: 250, llpaTotalMilli: 0, finalPriceMilli: 100250 },
  ],
};
const THEIRS = {
  eligible: true,
  rungs: [{ rate: 7.5, priceMilli: 101000 }, { rate: 7.25, priceMilli: 100250 }],
};
const TOL = { priceToleranceMilli: 1 };

const oursEngine = async () => OURS;
const theirsEngine = async () => THEIRS;

async function main() {
  // -------------------------------------------------------------------------
  // A - THE CANARY PATH. `shadow.runOne` is what the owner's daily check runs.
  // -------------------------------------------------------------------------
  {
    const r = await shadow.runOne({ _label: 'S1', state: 'FL' }, oursEngine, theirsEngine, TOL);
    ok(!r.agree, 'A1 the runner still reaches the same verdict — a diagnosis never changes one');
    const f = (r.findings || []).find((x) => x.kind === 'price_mismatch' && x.rate === 7.5);
    ok(!!f, 'A2 the 7.5 coupon disagrees, as measured');
    ok(f && f.explanation, 'A3 THE FIX: the canary path now carries WHY, not only WHAT');
    eq(f && f.explanation && f.explanation.confidence, 'strong',
      'A4 …and the diagnosis is confident, because one component accounts for the whole gap');
    eq(f && f.explanation && f.explanation.topSuspect && f.explanation.topSuspect.component, 'margin',
      'A5 …naming the MARGIN, which is exactly the 250 the gap is');
    eq(f && f.deltaMilli, -250, 'A6 the measured gap is unchanged by the attach');
    ok(f && f.explanation && /margin/.test(String(f.explanation.summary || '')),
      'A7 the summary a human reads names the suspect in words');
  }

  // -------------------------------------------------------------------------
  // B - IT REACHES THE LEDGER RECORD, which is the only place anybody sees it. `recordsFromComparison`
  //     carries the finding through verbatim as `diff`, so the explanation rides with it.
  // -------------------------------------------------------------------------
  {
    const r = await shadow.runOne({ _label: 'S1', state: 'FL' }, oursEngine, theirsEngine, TOL);
    const recs = finding.recordsFromComparison(r, {
      scenario: r.scenario, investor: 'deephaven', program: 'dscr', nowMs: 1,
    });
    const rec = recs.find((x) => x.kind === 'price_mismatch' && x.diff && x.diff.rate === 7.5);
    ok(!!rec, 'B1 the disagreement becomes a ledger record');
    ok(rec && rec.diff && rec.diff.explanation, 'B2 …and the record carries the diagnosis in its diff');
    // Read defensively. A crash IS a failure, but it stops the suite where it stands and hides which of
    // the later guards would also have bitten — and this file's whole subject is a defect that hid.
    const sus = rec && rec.diff && rec.diff.explanation && rec.diff.explanation.topSuspect;
    eq(sus && sus.component, 'margin', 'B3 …the same suspect, unchanged on the way through');
    eq(rec && rec.ourPayload, null,
      'B4 …while `our_payload` is still NULL — which is exactly WHY the diagnosis had to be made at compare time');
  }

  // -------------------------------------------------------------------------
  // C - THE ATTACH MAY NEVER COST A VERDICT — and the swallow must not be able to hide a dead attach.
  //     A frozen finding makes the in-place write throw under 'use strict'. Both halves are asserted
  //     together on purpose: the swallow alone passes just as happily when NOTHING is ever attached.
  // -------------------------------------------------------------------------
  {
    const frozen = Object.freeze({ kind: 'price_mismatch', rate: 7.5, deltaMilli: -250 });
    const cmp = { agree: false, findings: [frozen] };
    let threw = false;
    try { divergence.attachDiagnosis(cmp, OURS, TOL); } catch (_) { threw = true; }
    ok(!threw, 'C1 a diagnosis that cannot be written never throws — the verdict is already reached');
    eq(cmp.agree, false, 'C2 …and the verdict stands exactly as it was');
    ok(!Object.prototype.hasOwnProperty.call(frozen, 'explanation'),
      'C3 …with nothing half-written onto the finding');

    // THE CONTROL: the identical call on a writable finding DOES attach. Without this, C1–C3 pass on a
    // build where the attach silently does nothing at all — which is the bug this suite exists for.
    const live = { kind: 'price_mismatch', rate: 7.5, deltaMilli: -250 };
    divergence.attachDiagnosis({ agree: false, findings: [live] }, OURS, TOL);
    ok(live.explanation && live.explanation.topSuspect,
      'C4 CONTROL: the same call on a writable finding really does attach — so C1-C3 are not passing on a dead attach');

    // Junk must never throw either: this sits on the comparison path of the owner's daily check.
    let junkThrew = false;
    for (const q of [null, undefined, {}, { ladder: 'nope' }, { ladder: [null] }]) {
      const c = { agree: false, findings: [{ kind: 'price_mismatch', rate: 7.5, deltaMilli: -250 }] };
      try { divergence.attachDiagnosis(c, q, TOL); } catch (_) { junkThrew = true; }
    }
    ok(!junkThrew, 'C5 a malformed or absent quote never throws — it simply cannot narrow the cause');

    // An AGREEING comparison is left completely alone.
    const agreed = { agree: true, findings: [] };
    divergence.attachDiagnosis(agreed, OURS, TOL);
    eq(agreed.findings.length, 0, 'C6 nothing is invented on a scenario that agreed');
  }

  // -------------------------------------------------------------------------
  // D - NO RUNG IS AN HONEST ABSTENTION, NEVER A NEAR MATCH. Diagnosing a 7.5 gap off the 7.25 rung
  //     would read every LLPA and the margin off the wrong coupon and then name a suspect confidently.
  // -------------------------------------------------------------------------
  {
    const f = { kind: 'price_mismatch', rate: 7.375, deltaMilli: -250 };
    divergence.attachDiagnosis({ agree: false, findings: [f] }, OURS, TOL);
    const ex = f.explanation;
    ok(!!ex, 'D1 a coupon we hold no rung for still gets an explanation object');
    eq(ex && ex.confidence, 'none', 'D2 …which abstains rather than guessing off a neighbouring rung');
    eq(ex ? ex.topSuspect : 'missing', null, 'D3 …naming nobody');
    ok(!!ex && /unavailable/i.test(String(ex.summary || '')),
      'D4 …and says plainly that the reconstruction is unavailable');
  }

  // -------------------------------------------------------------------------
  // E - THE WHOLE BATCH, and the SUMMARY is untouched. A diagnosis is laid on top of a verdict; the
  //     agreement rate the go-live gate reads must not move because we started explaining things.
  // -------------------------------------------------------------------------
  {
    const scenarios = [{ _label: 'A' }, { _label: 'B' }, { _label: 'C' }];
    const run = await shadow.runShadow(scenarios, { ours: oursEngine, theirs: theirsEngine }, TOL);
    eq(run.summary.scenarios, 3, 'E1 every scenario ran');
    eq(run.summary.disagreed, 3, 'E2 …and disagreed, as the fixtures say');
    eq(run.summary.errors, 0, 'E3 …with no engine throwing');
    const explained = run.results.filter((r) => (r.findings || []).some((f) => f.explanation));
    eq(explained.length, 3, 'E4 EVERY scenario in the batch carries its diagnosis — not just the first');
    eq(parity.comparedOf(run.summary), 3, 'E5 the one definition of "how much did we compare" is unmoved (§2.77)');
  }

  // -------------------------------------------------------------------------
  // F - ONE DEFINITION, TWO CALLERS. A source guard, because no unit test can see a second copy.
  // -------------------------------------------------------------------------
  {
    const files = fs.readdirSync(PPE).filter((f) => f.endsWith('.js'));
    let defs = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(PPE, f), 'utf8');
      for (const _m of src.matchAll(/function\s+attachDiagnosis\s*\(/g)) defs += 1;
    }
    eq(defs, 1, 'F1 there is exactly ONE definition of attachDiagnosis in the PPE tree — a second copy is how two paths drift');

    const divSrc = fs.readFileSync(path.join(PPE, 'divergence.js'), 'utf8');
    ok(/function\s+attachDiagnosis\s*\(/.test(divSrc),
      'F2 …and it lives in divergence.js, beside the diagnosis it calls');

    // ⛔ THE MUTATION THAT SHIPPED: the moved body kept the facade's `divergence.` qualifier, which
    // resolves to nothing inside divergence.js and threw a ReferenceError the catch ate in silence.
    //
    // COMMENTS ARE STRIPPED FIRST. This very comment names the broken form, and a guard that read its
    // own explanation would fail on the fix it protects — and would then be "fixed" by deleting the
    // explanation, which is the worse outcome.
    const divCode = stripComments(divSrc);
    ok(!/\bdivergence\.\w/.test(divCode),
      'F3 divergence.js never qualifies its OWN exports — inside this module there is no `divergence` binding, and the attach swallows the ReferenceError');

    const shadowSrc = fs.readFileSync(path.join(PPE, 'shadow.js'), 'utf8');
    ok(/divergence\.attachDiagnosis\s*\(/.test(shadowSrc),
      'F4 the runner the CANARY goes through calls it — this is the wiring the whole section exists for');
    ok(/require\(['"]\.\/divergence['"]\)/.test(shadowSrc),
      'F5 …through a real require, not an undeclared global the bundler would emit verbatim');

    const facadeSrc = fs.readFileSync(path.join(PPE, 'facade.js'), 'utf8');
    ok(/divergence\.attachDiagnosis\s*\(/.test(facadeSrc),
      'F6 the LIVE shadow path still calls the SAME function — the facade behaviour did not change');
    eq(facade._internals.attachDiagnosis, divergence.attachDiagnosis,
      'F7 …and the facade re-exports that very function, so a test of one is a test of both');
  }

  console.log(failures.length
    ? `FAIL - lt ppe diagnosis reaches the canary (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
    : `ok - lt ppe diagnosis reaches the canary (${pass} assertions)`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.log(`FAIL - lt ppe diagnosis reaches the canary (threw: ${e && e.stack})`); process.exit(1); });

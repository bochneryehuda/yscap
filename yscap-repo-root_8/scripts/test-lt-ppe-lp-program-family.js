#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE AGREEMENT RUN MUST BE SCOPED TO THE SHEET'S OWN PROGRAM FAMILY, AND MUST REFUSE TO
 * ANSWER WHEN IT IS NOT.
 *
 * WHAT THIS EXISTS TO PREVENT, measured live 2026-08-17 and reproduced here as fixtures:
 *
 *   The E3 gate was run over the canonical 299-scenario battery with NO --filter-*, and printed
 *   "agreement 0.00% — 299/299 disagreed — GATE MET NO", categories
 *   {disqualification_missing:276, coupon_missing_ours:810}. That reads exactly like a total engine
 *   regression. It was not one — the SAME battery scoped to `Deephaven Mortgage` agrees on 244/295.
 *   Unscoped, the Lender Price side is the WHOLE MARKET: 20 lenders contributed 9,146 declined items
 *   to the disqualify tree (so `lpDeclined` is true on every scenario, because somebody always
 *   declines), and normalizeLpFull merged ~30 DSCR programs into one ladder (so LP "offers" coupons no
 *   single sheet prices). A gate that answers CONFIDENTLY when it was asked the wrong question is
 *   worse than one that refuses.
 *
 *   Scoping by investor alone is NOT enough either, and that is the second half. Lender Price splits
 *   ONE Deephaven DSCR rate sheet into THREE PROGRAMS by DSCR band and prices whichever band it
 *   selects while DECLINING the other two ("DSCR >=1.25%  only eligible on this program"); the same
 *   investor also sells Expanded Prime / Non Prime / ITIN, which decline on every DSCR scenario. Live,
 *   `investor: 'Deephaven Mortgage'` still returned 535 declined items. Our sheet models the whole
 *   DSCR family as ONE program with the band as an additive adjustment, so the LP side has to be
 *   scoped to the FAMILY — which an exact program name cannot express.
 *
 * PURE: no network, no DB, no live Lender Price. The fixtures are the shapes measured live.
 */
const { normalizeLpFull, normalizeLpDisqualified } = require('../src/longterm/ppe/lp-normalize-full');
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
function ok(cond, label) { if (cond) { pass += 1; console.log(`  ok   ${label}`); } else { fails.push(label); console.log(` FAIL  ${label}`); } }

// ---------------------------------------------------------------------------------------------
// Fixtures — the live shapes, trimmed. Deephaven's three DSCR band programs plus two of its other
// product lines, and one unrelated lender, exactly as the live capture returns them.
// ---------------------------------------------------------------------------------------------
const DHVN = 'Deephaven Mortgage';
const opt = (rate, price) => ({ priceBuild: { noteRate: rate, price, basePoints: 0, adjustmentPoints: 0 }, adjustments: [] });

const FULL = {
  programs: [
    { lender: DHVN, investor: DHVN, program: 'DSCR  1.00-1.24   -  30 Yr Fixed', product: 'x', options: [opt(6.5, 101.5)] },
    { lender: DHVN, investor: DHVN, program: 'DSCR < 1.00  -  30 Yr Fixed', product: 'x', options: [opt(6.75, 101.0)] },
    { lender: 'Verus', investor: 'Verus  Mortgage Capital', program: 'DSCR 30 Yr', product: 'x', options: [opt(9.125, 99.0)] },
  ],
};

const DISQ = {
  ready: true,
  lenders: [
    {
      lender: DHVN, investor: DHVN, items: [
        // The DSCR band LP did NOT select — a real family member, and the one the disqualify
        // comparison genuinely has to see.
        { program: 'DSCR  >= 1.25  - 30 Yr Fixed', reasons: [{ rule: 'DSCR >=1.25%  only eligible on this program' }] },
        // The same investor's OTHER product lines. These decline on EVERY DSCR scenario and are not
        // our sheet's business at all.
        { program: 'Expanded Prime 30 Yr Fixed - Full Doc (24 Mo)', reasons: [{ rule: '**Full Doc Only**' }] },
        { program: 'Non Prime 30 Yr Fixed - Bank Stmt (12 Mo)', reasons: [{ rule: 'Ineligible Doc Type' }] },
        { program: 'ITIN 30 Yr Fixed', reasons: [{ rule: 'Ineligible Doc Type' }] },
      ],
    },
    { lender: 'Amwest', investor: 'Amwest Funding Corp', items: [{ program: '(FMFT30) 30 YEAR', reasons: [{ rule: 'Ineligible States: NY' }] }] },
  ],
};

const DSCR_FAMILY = '^dscr';

// ---------------------------------------------------------------------------------------------
// 1. UNSCOPED is the whole market — the state that produced the false 0.00%.
// ---------------------------------------------------------------------------------------------
const dqNone = normalizeLpDisqualified(DISQ, {});
ok(dqNone.declined.length === 5, `unscoped, the disqualify tree is the WHOLE market (${dqNone.declined.length} declined, incl. another lender)`);
ok(dqNone.declined.some((d) => d.investor === 'Amwest Funding Corp'),
  'unscoped, a DIFFERENT lender\'s decline counts as "LP declined our program" — the false disqualification_missing');
const fullNone = normalizeLpFull(FULL, {});
ok(fullNone.bestLadder.some((r) => r.rate === 9125),
  'unscoped, the ladder merges another lender\'s coupons — the false coupon_missing_ours');

// ---------------------------------------------------------------------------------------------
// 2. INVESTOR alone is not enough — the second half of the defect.
// ---------------------------------------------------------------------------------------------
const dqInv = normalizeLpDisqualified(DISQ, { investor: DHVN });
ok(dqInv.declined.length === 4, `investor alone still carries the investor's OTHER product lines (${dqInv.declined.length})`);
ok(dqInv.declined.some((d) => /Expanded Prime|Non Prime|ITIN/.test(d.program)),
  'investor alone leaves Expanded Prime / Non Prime / ITIN in — they decline on every DSCR scenario');

// ---------------------------------------------------------------------------------------------
// 3. THE FAMILY PATTERN is what scopes it correctly: the DSCR band LP declined is KEPT (that is a real
//    disagreement to adjudicate), everything that is not our sheet's family is dropped.
// ---------------------------------------------------------------------------------------------
const dqFam = normalizeLpDisqualified(DISQ, { investor: DHVN, programLike: DSCR_FAMILY });
ok(dqFam.declined.length === 1, `investor + family pattern → only the DSCR family remains (${dqFam.declined.length})`);
ok(dqFam.declined[0].program === 'DSCR  >= 1.25  - 30 Yr Fixed',
  'the DSCR band LP declined is KEPT — it is a real family member, not noise');
ok(dqFam.declined[0].reasons[0].rule === 'DSCR >=1.25%  only eligible on this program',
  'and its reason survives, so the disagreement can still be adjudicated');

const fullFam = normalizeLpFull(FULL, { investor: DHVN, programLike: DSCR_FAMILY });
ok(fullFam.programsMatched === 2, `the priced side scopes to the two DSCR band programs LP priced (${fullFam.programsMatched})`);
ok(!fullFam.bestLadder.some((r) => r.rate === 9125), 'and the other lender\'s coupons are gone from the ladder');

// ---------------------------------------------------------------------------------------------
// 4. AN EXACT PROGRAM NAME CANNOT DO THIS — the reason the pattern had to exist.
// ---------------------------------------------------------------------------------------------
const dqExact = normalizeLpDisqualified(DISQ, { investor: DHVN, program: 'DSCR  1.00-1.24   -  30 Yr Fixed' });
ok(dqExact.declined.length === 0,
  'an exact program name pins us to ONE band, so the band LP actually declined is invisible — the comparison silently passes');

// ---------------------------------------------------------------------------------------------
// 5. The pattern is a REGEXP or a string, case-insensitive, and a BROKEN one THROWS rather than
//    silently matching everything (a filter that quietly matches all is this whole defect again).
// ---------------------------------------------------------------------------------------------
ok(normalizeLpDisqualified(DISQ, { investor: DHVN, programLike: /^DSCR/ }).declined.length === 1, 'a RegExp is accepted');
ok(normalizeLpDisqualified(DISQ, { investor: DHVN, programLike: '^DsCr' }).declined.length === 1, 'a string pattern is case-insensitive');
let threw = false;
try { normalizeLpDisqualified(DISQ, { programLike: '([' }); } catch (e) { threw = true; }
ok(threw, 'an uncompilable pattern THROWS — never a filter that silently matches everything');

// A filter with no keys at all is still "no filter" (back-compat: every existing caller).
ok(normalizeLpFull(FULL, {}).programsMatched === 3, 'no filter keys → unchanged, every program (back-compat)');

// ---------------------------------------------------------------------------------------------
// 6. THE RUNNER REFUSES the unscoped built-in run. Asserted on the source, because the runner needs a
//    live Lender Price login and cannot be executed here — so what is provable is that the guard is
//    present, is keyed on the built-in sheet, and names the flag that fixes it.
// ---------------------------------------------------------------------------------------------
const runner = fs.readFileSync(path.join(__dirname, 'test-lt-lp-agreement-run.js'), 'utf8');
ok(/REFUSING to run the built-in Deephaven sheet UNSCOPED/.test(runner), 'the runner refuses an unscoped built-in run');
ok(/if \(builtin && !flag\('--unscoped'\) && !filter\.investor && !filter\.lender && !filter\.program && !filter\.programLike\)/.test(runner),
  'the refusal is keyed on the built-in sheet AND on every way of scoping it');
ok(/--filter-investor "Deephaven Mortgage"/.test(runner), 'the refusal names the exact flag that fixes it — never a dead end');
ok(/--filter-program-like/.test(runner) && /filter\.programLike = new RegExp/.test(runner), 'the runner accepts the family pattern');


// ---------------------------------------------------------------------------------------------
// 7. LP CONTRADICTING ITSELF ACROSS THE FAMILY IS ITS OWN CATEGORY — never "our engine is dangerous",
//    and never a rule the suggestion miner will propose we adopt.
//    Measured live: dscr = 1.25 → LP PRICES `DSCR 1.00-1.24` + `DSCR < 1.00` and DECLINES `DSCR >= 1.25`
//    ("DSCR >=1.25%  only eligible on this program"). Our sheet is ONE program, so it answers eligible.
// ---------------------------------------------------------------------------------------------
const { detectDifferences } = require('../src/longterm/ppe/parity-detectors');
const OURS = { eligible: true, ladder: [{ rate: 6500, basePriceMilli: 101500, finalPriceMilli: 101500 }], declines: [] };
const LP_PRICED = { eligible: true, rungs: [{ rate: 6500, priceMilli: 101500, basePointsMilli: -1500, adjustmentPointsMilli: 0, llpas: [] }] };
const LP_DECLINED_BAND = { declined: [{ program: 'DSCR  >= 1.25  - 30 Yr Fixed', reasons: [{ rule: 'DSCR >=1.25%  only eligible on this program' }] }] };

const split = detectDifferences({ ours: OURS, lp: LP_PRICED, lpDisqualified: LP_DECLINED_BAND }, {});
const splitCats = split.differences.map((d) => d.category);
ok(splitCats.includes('disqualification_split'), 'LP priced AND declined within the family → disqualification_split');
ok(!splitCats.includes('disqualification_missing'),
  'it is NOT reported as disqualification_missing — that reads as "we price a loan LP declines", and LP priced it');
ok(split.verdict === 'disagree', 'it still DISAGREES — which band governs is unresolved, so the gate must not pass');
ok(split.differences[0].severity === 'high', 'and it is still high severity');
ok(Array.isArray(split.differences[0].lpDeclinedPrograms) && split.differences[0].lpDeclinedPrograms[0] === 'DSCR  >= 1.25  - 30 Yr Fixed',
  'the declined band is NAMED so a human can see which one LP refused');

// The suggestion miner keys on `disqualification_missing`, so this category keeps it from proposing
// "DSCR >=1.25% only eligible on this program" as an eligibility rule — a rule that would make our
// engine decline loans Deephaven genuinely prices.
const { reviewScenario } = require('../src/longterm/ppe/parity-review');
const rev = reviewScenario({
  ours: OURS,
  lpFull: { programs: [{ lender: DHVN, investor: DHVN, program: 'DSCR  1.00-1.24   -  30 Yr Fixed', options: [opt(6.5, 101.5)] }] },
  lpDisq: { ready: true, lenders: [{ lender: DHVN, investor: DHVN, items: [{ program: 'DSCR  >= 1.25  - 30 Yr Fixed', reasons: [{ rule: 'DSCR >=1.25%  only eligible on this program' }] }] }] },
  filter: { investor: DHVN, programLike: DSCR_FAMILY },
});
ok((rev.suggestions || []).length === 0,
  'the suggestion miner proposes NO rule from a band split — adopting LP\'s own partitioning would decline good loans');

// The genuinely dangerous direction is UNCHANGED: LP declined everything in scope and we still priced.
const danger = detectDifferences({ ours: OURS, lp: { eligible: false, rungs: [] }, lpDisqualified: LP_DECLINED_BAND }, {});
ok(danger.differences.map((d) => d.category).includes('disqualification_missing'),
  'LP declined the WHOLE scope and we priced → still disqualification_missing (the dangerous direction is untouched)');

console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);

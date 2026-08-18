'use strict';
/**
 * LT PPE — the PER-SCENARIO DISQUALIFIER REVIEW (owner-instructed 2026-08-18). PURE: no DB, no
 * network. Proves the thing the owner actually asked for — *"look on the eligibility rule in Lender
 * Price, go into the disqualifier … then look at the rate to see if you can find where he's taking
 * this disqualifier … you need a human to review these findings for every single scenario"* — and,
 * far more importantly, proves the FOUR THINGS THE MODULE REFUSES TO SAY.
 *
 * ⛔ THE REFUSALS ARE THE TEST. A queue like this earns its keep by being trusted, and every way it
 * could quietly lie is a way somebody stops trusting it: an unpriced scenario reported as a silent
 * sheet, a loan refused for another reason reported as a silent sheet, an unnameable disqualifier
 * folded into agreement, or a missing feed reported as a clean bill of health. Each has its own
 * section and each was proven to FAIL by mutating the production code.
 */

const assert = require('assert');
const review = require('../src/longterm/ppe/disqualifier-review');

let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed += 1; };
const eq = (a, b, label) => { assert.strictEqual(a, b, label); passed += 1; };

// ---------------------------------------------------------------------------
// fixtures — one program, and LP verdicts in the shape lp-normalize-full produces
// ---------------------------------------------------------------------------

const SCENARIO = { fico: 700, ltv: 75000, dscr: 1050, loan_amount: 400000, state: 'NJ' };

// A sheet that PRICES dscr (two bands) and prices fico, and has nothing at all about state.
const PROGRAM = {
  id: 'prog-1',
  rules: [
    { code: 'dscr_low', kind: 'pricing', description: 'DSCR 1.00–1.10', adjustment: { dimension: 'dscr', costMilli: 750 } },
    { code: 'dscr_mid', kind: 'pricing', description: 'DSCR 1.10–1.20', adjustment: { dimension: 'dscr', costMilli: 375 } },
    { code: 'fico_low', kind: 'pricing', description: 'FICO 660–679', adjustment: { dimension: 'fico', costMilli: 500 } },
    { code: 'ltv_max', kind: 'eligibility', dimension: 'ltv', when: { fact: 'ltv', op: 'gt', value: 80000 } },
  ],
};

// LP refuses on DSCR only.
const LP_DSCR = { ready: true, declined: [{ reasons: [{ rule: 'DSCR below 1.10', adjType: 'DscrRateAdjustment' }] }] };
// LP refuses on a dimension our sheet says nothing about.
const LP_STATE = { ready: true, declined: [{ reasons: [{ rule: 'NJ not eligible', adjType: 'StatesRateAdjustment' }] }] };
// LP refuses for something the crosswalk cannot place.
const LP_MYSTERY = { ready: true, declined: [{ reasons: [{ rule: 'Program overlay 47', adjType: 'SomethingWeHaveNeverSeen' }] }] };

// OUR side: a priced quote whose DSCR band fired.
const PRICED_WITH_DSCR = {
  eligible: true,
  ladder: [{ rate: 7.5, adjustments: [
    { dimension: 'dscr', code: 'dscr_low', reason: 'DSCR 1.00–1.10', costMilli: 750 },
    { dimension: 'fico', code: 'fico_hi', reason: 'FICO 700–719', costMilli: 125 },
  ] }],
};
// OUR side: a priced quote where NOTHING on dscr fired.
const PRICED_NO_DSCR = {
  eligible: true,
  ladder: [{ rate: 7.5, adjustments: [{ dimension: 'fico', code: 'fico_hi', reason: 'FICO 700–719', costMilli: 125 }] }],
};

const say = (name) => console.log(`\n${name}\n`);

// ---------------------------------------------------------------------------
say('A. the owner\'s own case — LP refuses it, our sheet charges for it');
// ---------------------------------------------------------------------------
{
  const out = review.reviewScenario({ scenario: SCENARIO, lp: LP_DSCR, ours: PRICED_WITH_DSCR, program: PROGRAM });
  eq(out.ready, true, 'A1 the feed arrived, so there is a queue');
  eq(out.items.length, 1, 'A2 one disqualifier, one review item');
  const it = out.items[0];
  eq(it.dimension, 'dscr', 'A3 …placed on the dimension LP itself named, through the curated crosswalk');
  eq(it.classification, 'priced_not_declined',
    'A4 THE ONE THAT MATTERS: LP refuses it and our SHEET CHARGES for it — the owner\'s "where is he taking this disqualifier"');
  eq(it.needsHuman, true, 'A5 …and it is work, not a note');
  eq(it.ourSheet.state, 'prices', 'A6 …the sheet\'s answer is stated as a price, not as an absence');
  eq(it.ourSheet.adjustments.length, 1, 'A7 …carrying only the adjustments on THAT dimension, never the whole stack');
  eq(it.ourSheet.adjustments[0].costMilli, 750, 'A8 …with the money on it, so a reviewer can weigh the two');
  ok(/REFUSES/.test(it.question) && /0\.750 points/.test(it.question),
    'A9 …and the QUESTION states both sides in plain words, with the points a person recognises');
  ok(/is this a loan we turn down, or one we price/.test(it.question),
    'A10 …and ends by asking the actual decision, never by asserting one');
  eq(out.summary.needsHuman, 1, 'A11 the summary counts the work');
}

// ---------------------------------------------------------------------------
say('B. REFUSAL 1 — an unpriced scenario is never reported as a silent sheet');
// ---------------------------------------------------------------------------
{
  const incomplete = { eligible: true, incomplete: true, summary: 'The DSCR is missing, so this cannot be priced.' };
  const out = review.reviewScenario({ scenario: SCENARIO, lp: LP_DSCR, ours: incomplete, program: PROGRAM });
  const it = out.items[0];
  eq(it.classification, 'unknown_ours',
    'B1 THE ONE THAT MATTERS: a scenario we could not price reads as UNKNOWN — never as "our sheet charges nothing"');
  eq(it.ourSheet.state, 'unknown', 'B2 …and the sheet\'s state says so');
  eq(it.ourSheet.why, incomplete.summary,
    'B3 …naming why in the QUOTE\'S OWN words, never a paraphrase this module invented');
  ok(/could not work out our own answer/.test(it.question), 'B4 …and the question says there is nothing to compare yet');
  eq(it.needsHuman, true, 'B5 …and it is still work: an unanswerable scenario is a finding, not a pass');

  // The same shape with an unreadable price ceiling — a DIFFERENT way to have no priced answer.
  const capless = { eligible: false, declines: [{ code: 'price_limit_unreadable', reason: 'the sheet\'s ceiling could not be read' }] };
  const out2 = review.reviewScenario({ scenario: SCENARIO, lp: LP_DSCR, ours: capless, program: PROGRAM });
  ok(out2.items[0].classification !== 'silent', 'B6 …and an unreadable ceiling is likewise never read as a silent sheet');
}

// ---------------------------------------------------------------------------
say('C. REFUSAL 2 — a decline for ANOTHER reason is not a silent sheet either');
// ---------------------------------------------------------------------------
{
  const declinedOnLtv = { eligible: false, declines: [{ code: 'ltv_max', reason: 'LTV above 80%' }] };
  const out = review.reviewScenario({ scenario: SCENARIO, lp: LP_DSCR, ours: declinedOnLtv, program: PROGRAM });
  const it = out.items[0];
  eq(it.classification, 'moot_other_decline',
    'C1 THE ONE THAT MATTERS: we refuse the loan on LTV, so our sheet never priced DSCR — that is not "the sheet is silent"');
  eq(it.needsHuman, false, 'C2 …and it is deliberately NOT work: there is nothing to decide until the other reason is settled');
  eq(it.ourEligibility.otherDimension, 'ltv', 'C3 …and it names the reason we refused, so the sentence is about this loan');
  ok(/for the loan-to-value/.test(it.question), 'C4 …in words');
}

// ---------------------------------------------------------------------------
say('D. REFUSAL 3 — a dimension we cannot name is never folded into agreement');
// ---------------------------------------------------------------------------
{
  const out = review.reviewScenario({ scenario: SCENARIO, lp: LP_MYSTERY, ours: PRICED_WITH_DSCR, program: PROGRAM });
  eq(out.items.length, 1, 'D1 an unplaceable disqualifier still produces a review item — it is never dropped');
  eq(out.items[0].classification, 'unknown_dimension',
    'D2 THE ONE THAT MATTERS: an adjType outside the curated crosswalk is UNKNOWN, never matched to a dimension by guessing');
  eq(out.items[0].dimension, null, 'D3 …and it claims no dimension at all');
  eq(out.items[0].needsHuman, true, 'D4 …and it is work: somebody has to say what it is about');
}

// ---------------------------------------------------------------------------
say('E. REFUSAL 4 — a feed that never arrived is never a clean bill of health');
// ---------------------------------------------------------------------------
{
  const out = review.reviewScenario({ scenario: SCENARIO, lp: { ready: false, declined: [] }, ours: PRICED_WITH_DSCR, program: PROGRAM });
  eq(out.ready, false, 'E1 THE ONE THAT MATTERS: with no LP verdict the review is NOT ready');
  eq(out.items.length, 0, 'E2 …and produces no items rather than an empty pass');
  ok(/never arrived/.test(out.notReadyReason || ''), 'E3 …saying so in words a person can act on');
  eq(out.summary.needsHuman, 0, 'E4 …and claims no work it has not actually looked at');
}

// ---------------------------------------------------------------------------
say('F. the two remaining answers — covered-but-not-fired, and genuinely silent');
// ---------------------------------------------------------------------------
{
  const out = review.reviewScenario({ scenario: SCENARIO, lp: LP_DSCR, ours: PRICED_NO_DSCR, program: PROGRAM });
  const it = out.items[0];
  eq(it.classification, 'covered_but_not_fired',
    'F1 the sheet prices DSCR on other loans but no band reached this one — a DIFFERENT question from silence');
  eq(it.ourSheet.coveredElsewhere.length, 2, 'F2 …and it names the bands that exist, so the fix is "widen this one" not "write a rule"');
  ok(/does price the DSCR on other loans/.test(it.question), 'F3 …in words');

  const out2 = review.reviewScenario({ scenario: SCENARIO, lp: LP_STATE, ours: PRICED_NO_DSCR, program: PROGRAM });
  const it2 = out2.items[0];
  eq(it2.classification, 'silent',
    'F4 a dimension the sheet has NO rule about at all is SILENT — the fix there is a new rule, not a wider band');
  eq(it2.ourSheet.coveredElsewhere.length, 0, 'F5 …with nothing to point at');
  ok(/says nothing about the property state at all/.test(it2.question), 'F6 …in words');
}

// ---------------------------------------------------------------------------
say('G. agreement is listed too — an audit needs the passes as much as the failures');
// ---------------------------------------------------------------------------
{
  const declinedOnDscr = { eligible: false, declines: [{ code: 'dscr_min', reason: 'DSCR below 1.10', dimension: 'dscr' }] };
  const out = review.reviewScenario({ scenario: SCENARIO, lp: LP_DSCR, ours: declinedOnDscr, program: PROGRAM });
  const it = out.items[0];
  eq(it.classification, 'agreed_decline', 'G1 both sides refuse it on the same dimension');
  eq(it.needsHuman, false, 'G2 …and it is not work');
  ok(/Nothing to decide/.test(it.question), 'G3 …and says so rather than leaving a reviewer wondering');
  eq(out.summary.total, 1, 'G4 …but it IS listed: a queue that hid its agreements could not be audited');
}

// ---------------------------------------------------------------------------
say('H. the item is self-describing, and nothing here decides anything');
// ---------------------------------------------------------------------------
{
  const out = review.reviewScenario({ scenario: SCENARIO, lp: LP_DSCR, ours: PRICED_WITH_DSCR, program: PROGRAM });
  const it = out.items[0];
  eq(it.scenario, SCENARIO, 'H1 the scenario rides on the item — a queue row that cannot say which loan it is about is useless');
  ok(it.lpReason && /DSCR below 1\.10/.test(it.lpReason), 'H2 …carrying LP\'s own words, never a paraphrase');
  ok(Object.prototype.hasOwnProperty.call(it, 'question') && typeof it.question === 'string',
    'H3 …and the question a person answers');
  ok(!Object.prototype.hasOwnProperty.call(it, 'resolution') && !Object.prototype.hasOwnProperty.call(it, 'winner'),
    'H4 THE ONE THAT MATTERS: the item carries no verdict of its own — which rule governs is the owner\'s open question 2b');

  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'longterm', 'ppe', 'disqualifier-review.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/require\(['"]\.\.\/db|INSERT |UPDATE /i.test(stripped),
    'H5 …and the module is PURE: it reads no database and writes nothing');
}

console.log(`\nok - lt ppe disqualifier review (${passed} assertions)\n`);

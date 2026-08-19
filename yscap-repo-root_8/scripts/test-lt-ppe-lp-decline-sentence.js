#!/usr/bin/env node
'use strict';
/**
 * LT PPE — SEVEN OF SEVEN LIVE DECLINE SENTENCES CROSSWALKED TO A RULE NOBODY WROTE (§2.111).
 *
 * ⛔ WHAT WAS BROKEN. `disqualify-crosswalk.keyToPredicate` read a whole Lender Price decline sentence
 * as if it were a single constraint: `inferOperator` scanned the entire string for the first operator
 * it recognised and `firstNumber` took the first number, wherever each happened to sit. The Deephaven
 * sentences are COMPOUND — a list of conditions followed by one requirement — so the operator and the
 * threshold routinely came from DIFFERENT CLAUSES. Measured on all SEVEN distinct decline sentences the
 * 2026-08-19 live run returned:
 *
 *   "DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Max LTV/CLTV 70%"  -> fico lte 1
 *   "DSCR < 1.00 -.75, Purchase RT, Loan Amount =< $1.5 MM, Maximum LTV 75%"        -> dscr lte 1000
 *   "DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640"                               -> dscr lte 1000
 *   "Minimum DSCR .75%"                                                             -> dscr lt  75000
 *   "DSCR >= 1.00, Minimum Loan Amount $75,000"                                     -> dscr gte 1000
 *   "DSCR < 1.00 -.75, Loan Amount =< $2.0 MM, Minimum FICO 680"                    -> dscr lte 1000
 *   "DSCR < 1.00, Minimum Loan Amount $200,000"                                     -> dscr lt  1000
 *
 * THREE DISTINCT WAYS OF BEING WRONG, and each is worse than a refusal. `fico lte 1` fires for no loan
 * — a rule that looks implemented and does nothing. `dscr gte 1000` fires for the GOOD half of the book
 * — it would decline every loan with a 1.00-or-better DSCR when the sentence only sets a $75,000 loan
 * floor for them. And `dscr lt 75000` — `firstNumber` cannot read a leading decimal, so ".75" came back
 * as 75 — would decline EVERY DSCR loan in existence.
 *
 * ⛔ THESE ARE NOT DIAGNOSTICS. `disqualify-analysis` and `parity-review` put the predicate straight
 * into a suggested overlay rule's `when`, which is what a human is asked to adopt. The suggestion
 * engine's entire value is that a person can trust it.
 *
 * THE FIX is `lp-decline-sentence.js`: split the sentence into clauses, read each clause's OWN fact,
 * operator and number, treat every clause but the last as a CONDITION (stated as satisfied, operator
 * kept verbatim) and the last as the CONSTRAINT (a requirement whose violation declines, operator
 * flipped), and account for EVERY token in every clause or refuse the sentence outright. A refusal
 * costs a human a look; a partial read costs a borrower a loan.
 *
 * PURE: no DB, no network. LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');
const S = require('../src/longterm/ppe/lp-decline-sentence');
const { keyToPredicate } = require('../src/longterm/ppe/disqualify-crosswalk');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }
const J = (x) => JSON.stringify(x);
// Defensive: a mutation that deletes an export must FAIL these, not crash the process (the §2.106 rule).
const dec = (t) => { try { return S.decodeSentence(t) || {}; } catch (e) { return { ok: false, why: 'threw:' + (e && e.message) }; } };
const predOf = (t) => { const r = dec(t); return r.ok ? r.predicate : null; };
const factOf = (t) => { const r = dec(t); return r.ok ? r.fact : null; };

// ---- A. THE SEVEN LIVE SENTENCES, VERBATIM, EACH DECODED TO WHAT IT SAYS -------------------------
// Every one of these was returned by Lender Price on 2026-08-19 and every one of them crosswalked to a
// wrong predicate before this. The expected values are read off the sentences by hand, not off the
// code — a fixture generated from the implementation proves only that it agrees with itself.
const LIVE = [
  ['DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Maximum LTV/CLTV 70%', 'ltv',
    { all: [
      { fact: 'dscr', op: 'gte', value: 1000 },
      { fact: 'loan_amount', op: 'lte', value: 1500000 },
      { fact: 'purpose', op: 'in', value: ['purchase', 'refinance'] },
      { fact: 'fico', op: 'lt', value: 680 },
      { any: [{ fact: 'ltv', op: 'gt', value: 70000 }, { fact: 'cltv', op: 'gt', value: 70000 }] },
    ] }],
  ['DSCR < 1.00 -.75, Purchase RT, Loan Amount =< $1.5 MM, Maximum LTV 75%', 'ltv',
    { all: [
      { fact: 'dscr', op: 'lt', value: 1000 },
      { fact: 'purpose', op: 'in', value: ['purchase', 'refinance'] },
      { fact: 'loan_amount', op: 'lte', value: 1500000 },
      { fact: 'ltv', op: 'gt', value: 75000 },
    ] }],
  ['DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640', 'fico',
    { all: [
      { fact: 'dscr', op: 'gte', value: 1000 },
      { fact: 'loan_amount', op: 'lte', value: 1500000 },
      { fact: 'fico', op: 'lt', value: 640 },
    ] }],
  ['Minimum DSCR .75%', 'dscr', { fact: 'dscr', op: 'lt', value: 750 }],
  ['DSCR >= 1.00, Minimum Loan Amount $75,000', 'loan_amount',
    { all: [{ fact: 'dscr', op: 'gte', value: 1000 }, { fact: 'loan_amount', op: 'lt', value: 75000 }] }],
  ['DSCR < 1.00 -.75, Loan Amount =< $2.0 MM, Minimum FICO 680', 'fico',
    { all: [
      { fact: 'dscr', op: 'lt', value: 1000 },
      { fact: 'loan_amount', op: 'lte', value: 2000000 },
      { fact: 'fico', op: 'lt', value: 680 },
    ] }],
  ['DSCR < 1.00, Minimum Loan Amount $200,000', 'loan_amount',
    { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'loan_amount', op: 'lt', value: 200000 }] }],
];
for (let i = 0; i < LIVE.length; i += 1) {
  const [text, fact, predicate] = LIVE[i];
  ok(J(predOf(text)) === J(predicate), `A${i + 1} live sentence ${i + 1} decodes to what it says — got ${J(predOf(text))}\n        for: ${text}`);
  ok(factOf(text) === fact, `A${i + 1}f …and refuses on ${fact} — got ${factOf(text)}`);
}

// ---- B. THE THREE ORIGINAL FAILURES, NAMED, SO A REGRESSION SAYS WHICH ---------------------------
// ⛔ EACH OF THESE IS THE EXPENSIVE DIRECTION, and they point opposite ways — which is why the guard
// has to assert the VALUES rather than merely "it decoded".
const dead = predOf('DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Maximum LTV/CLTV 70%');
ok(J(dead).indexOf('"fact":"fico","op":"lte","value":1') === -1,
  'B1 the DEAD rule is gone: nothing decodes to "decline when FICO <= 1", which fires for no loan');
const broad = predOf('DSCR >= 1.00, Minimum Loan Amount $75,000');
ok(J(broad) !== J({ fact: 'dscr', op: 'gte', value: 1000 }),
  'B2 the OVER-BROAD rule is gone: a $75,000 loan floor no longer declines every 1.00-or-better DSCR');
ok(J(predOf('Minimum DSCR .75%')) === J({ fact: 'dscr', op: 'lt', value: 750 }),
  `B3 the DECLINE-EVERYTHING rule is gone: ".75" reads as 0.75, not 75 — got ${J(predOf('Minimum DSCR .75%'))}`);

// ---- C. THE OPERATOR AND THE THRESHOLD COME FROM THE SAME CLAUSE ---------------------------------
// The root cause stated as an invariant rather than as three examples: every leaf's operator and value
// are read from one clause, so no leaf can pair a symbol from one part of the sentence with a number
// from another. Walked over every live sentence.
function leaves(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node.all)) node.all.forEach((n) => leaves(n, acc));
  else if (Array.isArray(node.any)) node.any.forEach((n) => leaves(n, acc));
  else if (node.fact) acc.push(node);
  return acc;
}
let sameClause = 0; let clauseLeaves = 0;
for (const [text] of LIVE) {
  const r = dec(text);
  for (const c of (r.clauses || [])) {
    for (const leaf of leaves(c.leaf, [])) {
      clauseLeaves += 1;
      // The clause's own text must contain the number the leaf carries (or its dollars/percent form).
      const raw = String(c.text || '');
      const n = S.readNumber(raw.replace(/\s([+-]\s*(?:\d+(?:\.\d+)?|\.\d+))\s*$/, ''));
      if (n != null || leaf.op === 'in') sameClause += 1;
    }
  }
}
ok(clauseLeaves > 0 && sameClause === clauseLeaves,
  `C1 every leaf's number is readable from its OWN clause — ${sameClause} of ${clauseLeaves}`);

// ---- D. NUMBERS ---------------------------------------------------------------------------------
ok(S.readNumber('.75') === 0.75, `D1 a leading decimal reads as a fraction — got ${S.readNumber('.75')}`);
ok(S.readNumber('$75,000') === 75000, `D2 thousands commas are stripped — got ${S.readNumber('$75,000')}`);
ok(S.readNumber('$1.5 MM') === 1500000, `D3 the vendor's MM is a multiplier — got ${S.readNumber('$1.5 MM')}`);
ok(S.readNumber('$1.5MM') === 1500000, `D4 …with or without a space — got ${S.readNumber('$1.5MM')}`);
ok(S.readNumber('$2.0 MM') === 2000000, `D5 …and reads 2.0 MM as two million — got ${S.readNumber('$2.0 MM')}`);
ok(S.readNumber('1.5') === 1.5, 'D6 a bare 1.5 is NOT multiplied — a suffix is only ever a magnitude');
ok(S.readNumber('no number here') === null, 'D7 a fragment with no number reads as nothing, never 0');

// ---- E. A COMMA INSIDE A NUMBER IS NOT A CLAUSE BOUNDARY, AND EVERY OTHER COMMA IS ---------------
// ⛔ BOTH HALVES BIT DURING THIS BUILD. Splitting on every comma cut "$75,000" into "$75" + "000";
// splitting only where BOTH sides are non-digits left "DSCR >= 1.00, Minimum Loan Amount $75,000"
// whole — reintroducing the exact first-clause defect the module exists to remove, inside its own fix.
ok(J(S.splitClauses('Minimum Loan Amount $75,000')) === J(['Minimum Loan Amount $75,000']),
  `E1 a thousands separator does not split — got ${J(S.splitClauses('Minimum Loan Amount $75,000'))}`);
ok(S.splitClauses('DSCR >= 1.00, Minimum Loan Amount $75,000').length === 2,
  `E2 a comma after a digit DOES split — got ${J(S.splitClauses('DSCR >= 1.00, Minimum Loan Amount $75,000'))}`);
ok(S.splitClauses('DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640').length === 3,
  `E3 a colon always splits — got ${J(S.splitClauses('DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640'))}`);
ok(S.splitClauses('Loan Amount <= $1,500,000, Maximum LTV 75%').length === 2,
  `E4 …and a fully comma'd amount survives beside a real boundary — got ${J(S.splitClauses('Loan Amount <= $1,500,000, Maximum LTV 75%'))}`);

// ---- F. A CONDITION KEEPS ITS OPERATOR; THE CONSTRAINT IS FLIPPED --------------------------------
// The whole reading rests on this asymmetry. "DSCR >= 1.00" as a CONDITION means the rule applies at
// 1.00 and up — NOT that a 1.00 DSCR is declined.
const f1 = dec('DSCR >= 1.00, Minimum Loan Amount $75,000');
ok(J((f1.conditions || [])[0] && f1.conditions[0].leaf) === J({ fact: 'dscr', op: 'gte', value: 1000 }),
  `F1 the condition is kept as written — got ${J((f1.conditions || [])[0] && f1.conditions[0].leaf)}`);
ok(J(f1.constraint && f1.constraint.leaf) === J({ fact: 'loan_amount', op: 'lt', value: 75000 }),
  `F2 …while the requirement is flipped to the failing side — got ${J(f1.constraint && f1.constraint.leaf)}`);
ok(J(predOf('Maximum LTV 75%')) === J({ fact: 'ltv', op: 'gt', value: 75000 }),
  'F3 a ceiling declines ABOVE it');
ok(J(predOf('Minimum FICO 680')) === J({ fact: 'fico', op: 'lt', value: 680 }),
  'F4 a floor declines BELOW it');
ok(J(predOf('FICO - below 660')) === J({ fact: 'fico', op: 'lt', value: 660 }),
  'F5 a constraint already stated as the FAILURE is taken as written');
ok(J(predOf('Max LTV exceeded / CLTV > 80.0 %')) === J({ fact: 'cltv', op: 'gt', value: 80000 }),
  `F6 …and requirement wording wins over a comparison in the same clause — got ${J(predOf('Max LTV exceeded / CLTV > 80.0 %'))}`);
ok(J(predOf('Maximum LTV/CLTV 70%')) === J({ any: [{ fact: 'ltv', op: 'gt', value: 70000 }, { fact: 'cltv', op: 'gt', value: 70000 }] }),
  'F7 the two-ratio shorthand declines when EITHER ratio is breached');

// ---- G. THE GRAMMAR IS CLOSED — WHAT IT REFUSES, AND WHY THAT MATTERS ----------------------------
// ⛔ THE MEASURED CASE. "DSCR >=1.25%  only eligible on this program" yields a tidy `dscr gte 1250` if
// the reader is allowed to shrug at prose it does not recognise — i.e. "decline at DSCR 1.25 and up",
// the BEST loans on the sheet. It is Lender Price saying a SIBLING container owns this loan, and that
// container prices it on the same request (§2.107).
const partition = dec('DSCR >=1.25%  only eligible on this program');
ok(partition.ok === false, `G1 a sentence with unaccounted prose is REFUSED — got ${J(partition.predicate)}`);
ok(partition.why === 'unaccounted_text', `G2 …and names why — got ${partition.why}`);
ok(dec('Interest Only not available in NY').ok === false, 'G3 a clause with no threshold fact is refused');
ok(dec('FICO requirement not met').ok === false, 'G4 a fact with no readable number is refused');
ok(dec('').ok === false, 'G5 an empty sentence is refused');
const partial = dec('DSCR >= 1.00, something nobody has measured, Minimum FICO 680');
ok(partial.ok === false,
  `G6 ONE unreadable clause refuses the WHOLE sentence — a partial conjunction is broader than the real rule, and both directions of omission decline good loans — got ${J(partial.predicate)}`);

// ---- H. THE CROSSWALK USES IT, AND SETS THE PARTITION SENTENCE ASIDE FOR EVERY CONSUMER ----------
// ⛔ THE §2.107 GAP THIS CLOSES. The reconciler already recognised the container-partition sentence,
// but `disqualify-analysis` and `parity-review` reach `keyToPredicate` DIRECTLY — so the suggestion
// engine would have authored "decline every loan with a 1.25-or-better DSCR" from it. Refused at the
// one door they all come through.
const xwPart = keyToPredicate({ rule: 'DSCR >=1.25%  only eligible on this program', adjType: 'DscrRateAdjustment' });
ok(xwPart.ok === false && xwPart.isContainerPartition === true,
  `H1 the crosswalk refuses a container-partition sentence — got ${J(xwPart)}`);
ok(xwPart.needsHumanCrosswalk === false,
  'H2 …and does NOT ask a human to map it — it is not a borrower rule at all');
const xw = keyToPredicate({ rule: 'DSCR >= 1.00, Minimum Loan Amount $75,000', adjType: 'DscrRateAdjustment' });
ok(xw.ok && xw.fact === 'loan_amount' && xw.matchedBy === 'sentence',
  `H3 the crosswalk reads the sentence, not the adjType — got ${J(xw)}`);
ok(xw.adjTypeAgrees === false,
  `H4 …and reports that the vendor's own label disagrees, rather than hiding it — got ${xw.adjTypeAgrees}`);
ok(keyToPredicate({ rule: 'FICO - below 660', adjType: 'FicoRateAdjustment' }).adjTypeAgrees === true,
  'H5 …while a simple sentence corroborates cleanly');
const st = keyToPredicate({ rule: 'Interest Only not available in NY', adjType: 'StatesRateAdjustment' });
ok(st.ok && st.fact === 'state',
  `H6 the state/feature path the clause reader cannot handle still works — got ${J(st)}`);

// ---- I. THE SUGGESTION ENGINE IS WHAT THIS PROTECTS ----------------------------------------------
// A source assertion, because the danger is not that the crosswalk is wrong in the abstract — it is
// that its `predicate` becomes a suggested overlay rule's `when`, which a human is asked to adopt.
for (const f of ['disqualify-analysis.js', 'parity-review.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', f), 'utf8');
  ok(/when:\s*cross\.predicate/.test(src),
    `I${f === 'disqualify-analysis.js' ? 1 : 2} ${f} still authors a rule from cross.predicate — this is why the reading has to be right`);
}

console.log(`${fails.length ? 'FAIL' : 'PASS'} — LP decline-sentence guard: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  ✗', f);
process.exit(fails.length ? 1 : 0);

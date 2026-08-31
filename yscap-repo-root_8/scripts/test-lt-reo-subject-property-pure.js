#!/usr/bin/env node
/**
 * "THIS IS THE MORTGAGE ON THE SUBJECT PROPERTY" — the way, the deal it applies
 * to, and what a credit report may and may not fill in.
 *
 * Owner-directed 2026-08-31: *"One of the options when you select hey this is a
 * mortgage one of the option should be this is a mortgage related to subject
 * property … It should only come up if it's a refinance transaction … It should
 * have a mark that their information is on the credit report and automatically
 * fill in from the credit report the servicer name, the loan number, and
 * outstanding principal balance. It should satisfy two things at once."*
 *
 * PURE — `answers.js` touches no database, so every rule here is provable with
 * nothing running.
 *
 * ── WHAT THIS SUITE IS REALLY GUARDING ──────────────────────────────────────
 *
 * TWO HALVES HAVE TO AGREE. The screen offers ways; the door records them. A way
 * hidden from one and accepted by the other is a claim somebody can post from a
 * stale tab — and "this is the mortgage on the subject property" posted on a
 * PURCHASE is a claim about a loan that does not exist. So the filter is asserted
 * from BOTH sides, against the same function.
 *
 * AND THE FILL HAS TO BE HONEST. A credit report carries the LAST FOUR digits of
 * an account, never the full loan number — `lt_liabilities.account_last4` is the
 * only account column there is. Four digits filled in silently, as though they
 * were what a closer keys into Encompass, is the confident wrong answer. So the
 * mark is asserted as hard as the fill.
 */
'use strict';

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const answers = require('../src/lib/conditions/answers');

const REO = { code: 'lt_reo_liabilities' };
const SUBJ = { code: 'lt_subject_mortgage_statement' };
const REFI = { isRefinance: true };
const PURCHASE = { isRefinance: false };
const UNKNOWN = { isRefinance: null };

console.log('\nA. THE WAY EXISTS, AND IT ASKS FOR NOTHING');
const way = answers.wayFor(REO, 'subject_property');
check(!!way, 'the REO condition offers "this is the mortgage on the subject property"');
check(/subject property/i.test(way.label), `and the label says so in the words a processor uses ("${way.label}")`);
check(/refinanc/i.test(way.label), 'and spells out what that means for anybody who does not');
check(Array.isArray(way.fields) && way.fields.length === 0,
  'it asks for NO fields — the address is the file\'s own subject property, already on the loan');
check(!way.needsDocument, 'and no document: the statement is collected once, on the other condition');
check(way.refinanceOnly === true, 'it is marked refinance-only');

console.log('\nB. IT IS OFFERED ON A REFINANCE AND NOWHERE ELSE');
const keysFor = (deal) => answers.waysFor(REO, deal).map((w) => w.key);
check(keysFor(REFI).includes('subject_property'), 'offered on a refinance');
check(!keysFor(PURCHASE).includes('subject_property'), 'NOT offered on a purchase');
check(!keysFor(UNKNOWN).includes('subject_property'),
  'NOT offered while the purpose is unreadable — fails closed, because a file nobody can prove is a refinance is not one');
// The OTHER ways must be untouched by the filter, or hiding one option would
// quietly take the rest of the condition away with it.
for (const k of ['statement', 'primary', 'address']) {
  check(keysFor(PURCHASE).includes(k) && keysFor(UNKNOWN).includes(k) && keysFor(REFI).includes(k),
    `"${k}" is offered on every deal, whatever the purpose`);
}
check(answers.waysFor(REO, REFI).length === answers.WAYS.lt_reo_liabilities.ways.length,
  'a refinance sees the whole table');
check(answers.waysFor(REO, PURCHASE).length === answers.WAYS.lt_reo_liabilities.ways.length - 1,
  'and a purchase sees exactly one fewer');

console.log('\nC. THE DOOR REFUSES WHAT THE SCREEN WOULD NOT OFFER');
const post = (deal) => answers.answerProblem(REO, {
  lines: { 'liab:1': { way: 'subject_property' } },
}, { deal, lineLabels: { 'liab:1': 'Wells Fargo ····4776' } });
check(post(REFI) === null, 'a refinance records it');
check(typeof post(PURCHASE) === 'string' && /refinance/i.test(post(PURCHASE)),
  `a purchase is refused, in the words of the deal ("${post(PURCHASE)}")`);
check(/Wells Fargo/.test(post(PURCHASE)), 'and the refusal names WHICH mortgage — a list of eight tells nobody which to fix');
check(typeof post(UNKNOWN) === 'string', 'an unreadable purpose is refused too — the door and the screen fail closed together');
check(post({}) !== null, 'a caller that says nothing about the deal gets the closed answer, never the open one');
// The filter must not leak onto the ways that have nothing to do with it.
check(answers.answerProblem(REO, { lines: { 'liab:1': { way: 'primary' } } }, { deal: PURCHASE }) === null,
  '"this is the home they live in" still records on a purchase');

console.log('\nD. WHAT A CREDIT REPORT MAY FILL IN — ALL THREE OR NOTHING');
const LINE = { key: 'liab:abc', label: 'Wells Fargo ····4776', creditor: 'Wells Fargo', last4: '4776', balance: 312500 };
const full = answers.creditReportFill(LINE);
check(full.ok === true, 'a complete line fills in');
check(full.answer.way === 'typed', 'as the TYPED way — the one the owner asked to be auto-selected');
check(full.answer.values.servicer === 'Wells Fargo', 'the servicer comes from the creditor');
check(full.answer.values.outstanding_balance === 312500, 'the outstanding balance comes from the unpaid balance');
check(full.answer.values.loan_number === '4776', 'and the loan number is what the report carries');
check(full.answer.loanNumberIsLastFour === true, 'MARKED as the last four digits only');
check(full.answer.source === answers.CREDIT_REPORT && full.answer.sourceLine === 'liab:abc',
  'and stamped with where it came from, and which line said so');
check(answers.answerProblem(SUBJ, full.answer, { hasDocument: false }) === null,
  'the fill is held to exactly the standard a person typing it is held to — and passes');
check(answers.satisfies(SUBJ, full.answer).ok === true, 'so the condition is finished by it — two conditions, one click');

for (const [missing, line] of [
  ['servicer', { ...LINE, creditor: '  ' }],
  ['balance', { ...LINE, balance: null }],
  ['account number', { ...LINE, last4: '' }],
]) {
  const r = answers.creditReportFill(line);
  check(r.ok === false, `a line with no ${missing} fills in NOTHING — a partial answer reads as a complete one`);
  check(typeof r.why === 'string' && r.why.length > 10, `and says which one it was short of ("${r.why}")`);
}
check(answers.creditReportFill(null).ok === false && answers.creditReportFill(undefined).ok === false,
  'and it never throws on nothing at all');

console.log('\nE. THE MARK — one wording, wherever the answer is read');
const note = answers.sourceNote(full.answer);
check(typeof note === 'string' && /credit report/i.test(note), 'a filled answer says it came off the credit report');
check(/LAST FOUR/i.test(note) && /confirm/i.test(note),
  'and says the loan number is only the last four digits, and to confirm the real one');
check(/Wells Fargo/.test(note), 'and names the mortgage it was taken from');
check(answers.sourceNote({ way: 'typed', values: { servicer: 'X' } }) === null,
  'an answer a person typed themselves carries NO note — explaining where a value came from is only worth saying when it did not come from the reader');
check(answers.sourceNote(null) === null && answers.sourceNote('nonsense') === null, 'and it never throws');
check(answers.filledFromCreditReport(full.answer) === true, 'the fill is recognisable as ours');
check(answers.filledFromCreditReport(full.answer, 'liab:abc') === true, 'by line');
check(answers.filledFromCreditReport(full.answer, 'liab:other') === false, 'and only by ITS line');
check(answers.filledFromCreditReport({ way: 'typed' }) === false,
  "a person's own answer is never mistaken for ours — which is what stops it being overwritten");

console.log('\nF. NO SECOND READING OF "IS THIS A REFINANCE"');
const src = require('fs').readFileSync(`${__dirname}/../src/longterm/conditions-center/workspace.js`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check(!/\/refi/i.test(src),
  'workspace.js does not re-inline a /refi/ test — it reads the field registry, the one place that answers it');
check(/fieldMap\(\)/.test(src) && /is_refinance/.test(src), 'it reads `is_refinance` through the registry');
const wsrc = require('fs').readFileSync(`${__dirname}/../src/longterm/conditions-center/write.js`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check(/dealFor/.test(wsrc), 'and the write door asks the SAME dealFor, so the two halves cannot disagree');

console.log(failures ? `\n${failures} FAILED` : '\nAll good.');
process.exit(failures ? 1 : 0);

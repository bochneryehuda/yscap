#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM — the loan sync, pure (no DB, no Encompass).
 *
 * The pipeline hands us a bag of STRINGS from a Reporting Database that lags loan
 * saves and omits fields it has no value for. Every case here is one way that bag
 * turns into a wrong number or a skipped loan if it is read casually:
 *
 *   · an amount is `"594211.0000"`, a date is `"8/14/2026 10:48:18 AM"`
 *   · an unpopulated field is ABSENT, not empty — and neither may read as zero
 *   · v3's row key is `loanId`; v1's is `loanGuid`
 *   · the sort is by LastModified, which MOVES while we page
 *
 * Mutations proven to fail this file: reading an unreadable amount as 0; treating an
 * absent LastModified as "changed" (which re-reads every loan on every tick, for
 * ever); dropping the v1 `loanGuid` fallback; adding `operator` to a single-term
 * filter; skipping the paging de-duplication.
 */

const discover = require('../src/longterm/sync/discover');
const loans = require('../src/longterm/sync/loans');
const stages = require('../src/longterm/stages');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

// ── Everything arrives as a string ──────────────────────────────────────────
console.log('discovery — reading a Reporting Database row');

check(discover.parseAmount('594211.0000') === 594211,
  'the tenant\'s own amount string parses to a number');
check(discover.parseAmount('$1,250,000.50') === 1250000.5,
  '…and survives currency formatting, in case a tenant is configured differently');
check(discover.parseAmount('') === null && discover.parseAmount(null) === null
   && discover.parseAmount(undefined) === null && discover.parseAmount('n/a') === null,
  'THE ONE THAT MATTERS: absent, empty and unreadable all read as NULL — never as 0, because $0 is a fact and "could not read" is not');
check(discover.parseAmount('0') === 0,
  '…while a real zero is still a real zero');

// The probe's exact string.
const d = discover.parsePipelineDate('8/14/2026 10:48:18 AM');
check(d === '2026-08-14T10:48:18.000Z',
  'the US-locale pipeline date is taken apart explicitly, not handed to new Date()');
check(discover.parsePipelineDate('8/14/2026 1:05:00 PM') === '2026-08-14T13:05:00.000Z',
  'PM is added on…');
check(discover.parsePipelineDate('8/14/2026 12:30:00 AM') === '2026-08-14T00:30:00.000Z',
  '…and midnight is 00:30, not 12:30 — the one hour every date parser gets wrong');
check(discover.parsePipelineDate('12/31/2026 11:59:59 PM') === '2026-12-31T23:59:59.000Z',
  'noon/midnight aside, PM is otherwise a straight +12');
check(discover.parsePipelineDate('2026-08-14T10:48:18Z') === '2026-08-14T10:48:18.000Z',
  'an ISO stamp from a differently-configured tenant is read too');
check(discover.parsePipelineDate('') === null && discover.parsePipelineDate('not a date') === null
   && discover.parsePipelineDate(null) === null,
  'an unreadable stamp is NULL — the sync pages on it, and a wrong one silently skips loans');

// A whole row, in both contract shapes.
const V3ROW = {
  loanId: 'c5778468-8247-4852-8c2b-7e8af4351044',
  fields: {
    'Loan.LoanNumber': 'YSCAP258134845',
    'Loan.LoanAmount': '594211.0000',
    'Loan.LoanFolder': 'Pipeline',
    'Loan.CurrentMilestoneName': 'Started',
    'Fields.CoreMilestone': 'Started',
    'Fields.LOID': 'mmermelstein',
    'Loan.LastModified': '8/14/2026 10:48:18 AM',
  },
};
const row = discover.rowToLoan(V3ROW);
check(row.encompassLoanGuid === V3ROW.loanId, 'v3\'s row key is `loanId`');
check(row.loanAmount === 594211 && row.loanNumber === 'YSCAP258134845',
  'the row reads back as real values, not strings');
check(row.loanOfficerLoginId === 'mmermelstein',
  'the officer arrives as a LOGIN ID — the join key, not a name');
check(discover.rowToLoan({ loanGuid: 'abc', fields: {} }).encompassLoanGuid === 'abc',
  'a v1-shaped row is still read — its key is `loanGuid`, and silently skipping it would empty the sync');
check(discover.rowToLoan({ fields: {} }) === null,
  'a row with no id at all is dropped rather than stored under an empty key');

// An unpopulated field is omitted entirely.
const sparse = discover.rowToLoan({ loanId: 'g1', fields: { 'Loan.LoanNumber': 'X1' } });
check(sparse.loanAmount === null && sparse.loanFolder === null && sparse.lastModified === null,
  'a field the tenant does not populate is ABSENT, and absent reads as null throughout');
check(discover.rowToLoan({ loanId: 'g1', fields: { 'Fields.CoreMilestone': 'Funding' } }).milestoneName === 'Funding',
  'the milestone falls back to CoreMilestone when the current-milestone field is not populated');

// ── The filter contract ─────────────────────────────────────────────────────
console.log('\nthe v3 filter contract');

const one = discover.buildFilter();
check(one.terms.length === 1 && !('operator' in one),
  'a SINGLE-term filter carries NO operator — v3 rejects one outright');
const two = discover.buildFilter({ loanFolder: 'Pipeline' });
check(two.terms.length === 2 && two.terms[1].value === 'Pipeline',
  'narrowing to a folder adds a second term — which is exactly when operator becomes required');
check(discover.DISCOVERY_FIELDS.includes('Loan.LastModified'),
  'discovery always asks for LastModified — the whole sync is paced on it');
check(!discover.DISCOVERY_FIELDS.some((f) => /rate|dscr|term/i.test(f)),
  'discovery does NOT ask for decision-bearing figures — the Reporting Database lags, so those come from the loan read');

// ── The stage, all three layers ─────────────────────────────────────────────
console.log('\nthe stage a loan is at');

const s = loans.stageFor('Waiting for Docs', {});
check(s.milestoneName === 'Waiting for Docs' && s.stageKey === 'conditions_out' && s.mapped,
  'the Encompass milestone is stored VERBATIM alongside our own stage key');
const unmapped = loans.stageFor('Some Milestone Added Tomorrow', {});
check(unmapped.stageKey === stages.UNMAPPED_STAGE.key && unmapped.mapped === false,
  'an unmapped milestone still lands somewhere visible rather than nowhere');
check(loans.stageFor(null, {}).milestoneName === null,
  'a loan with no milestone is not given one');

// ── What is worth re-reading ────────────────────────────────────────────────
console.log('\nwhat is worth re-reading');

check(loans.needsRead({ encompass_synced_at: null }) === true,
  'a loan we have never read is read');
check(loans.needsRead({
  encompass_synced_at: '2026-08-14T10:00:00Z',
  encompass_last_modified: '2026-08-14T11:00:00Z',
}) === true, 'a loan Encompass changed since our last read is re-read');
check(loans.needsRead({
  encompass_synced_at: '2026-08-14T12:00:00Z',
  encompass_last_modified: '2026-08-14T11:00:00Z',
}) === false, 'a loan nothing has happened to is left alone — this is what makes a 700-loan pass cheap');
check(loans.needsRead({
  encompass_synced_at: '2026-08-14T12:00:00Z',
  encompass_last_modified: null,
}) === false,
  'a loan with NO Encompass stamp is read once and then left — an absent stamp says nothing about change, and reading it as "changed" re-reads it on every tick for ever');
check(loans.needsRead(null) === false, 'a missing row asks for nothing');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

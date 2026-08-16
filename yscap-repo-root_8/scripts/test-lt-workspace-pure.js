#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM — the loan workspace, pure (no DB).
 *
 * The workspace's job is to be honest about what a file HAS. Two ways it could
 * quietly lie, and both are what this pins:
 *
 *   · HIDING a section that does not apply. A reader cannot tell "this file has no
 *     employment" from "this screen forgot employment", so every unavailable section
 *     must be greyed WITH a reason — a greyed section with no reason is a dead end.
 *   · INVENTING PROGRESS. The stepper marks everything before the current milestone
 *     as reached, which is right only when we recognise where the loan is. On an
 *     unknown milestone it must mark NOTHING rather than draw a plausible bar.
 *
 * And one rule that outranks layout: the investor never reaches the rail.
 */

const ws = require('../src/longterm/workspace');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const DSCR = {
  loan_number: 'YSCAP1', borrower_name: 'A Borrower', product_kind: 'dscr',
  employment_applies: false, dscr_ratio: 1.28,
  housing_expense_total: 2025.31, loan_amount: 612000, note_rate_pct: 7.25,
  term_months: 360, milestone_name: 'Processing', lock_status: 'Locked',
};

// ── The section menu ────────────────────────────────────────────────────────
console.log('the section menu — greyed with a reason, never hidden');

const menu = ws.sectionMenu(DSCR, {});
const by = (k) => menu.find((s) => s.key === k);

check(menu.length === ws.SECTIONS.length,
  'EVERY section is listed — a section that does not apply is never dropped');
check(by('employment') && by('employment').available === false,
  'employment does not apply to a DSCR file');
check(/qualifies on the property/i.test(by('employment').why),
  '…and it SAYS why, in words a person can read');
check(menu.filter((s) => !s.available).every((s) => s.why && s.why.length > 10),
  'THE ONE THAT MATTERS: no section is ever greyed without a reason — that would be a dead end');
check(menu.filter((s) => s.available).every((s) => s.why === null),
  'a live section carries no reason, so a screen cannot render a stray tooltip');

check(by('borrowers').available && by('property').available && by('terms').available,
  'the sections every file has are always live');
check(by('income').available === true,
  'income applies to a DSCR file that has its rent and DSCR');
check(ws.sectionMenu({ product_kind: 'dscr' }, {}).find((s) => s.key === 'income').available === false,
  '…and is greyed on a DSCR file whose rent has not been read yet');

// The employment section becomes available the moment the DATA says so — it is a
// function of the loan, not a hard-coded list.
check(ws.sectionMenu({ ...DSCR, employment_applies: true }, {}).find((s) => s.key === 'employment').available === true,
  'employment turns on for the ~2% of the book where it applies — no code change');

// The Condition Center is set aside, and greyed for the same reason as employment.
check(by('conditions').available === false && /coming soon/i.test(by('conditions').why),
  'the Condition Center is greyed and says "coming soon" — somebody told about it must not think it vanished');
check(ws.sectionMenu(DSCR, { conditionsEnabled: true }).find((s) => s.key === 'conditions').available === true,
  '…and turns on from the SETTING, not from a code change');

check(by('lock').available === true
   && ws.sectionMenu({ ...DSCR, lock_status: null }, {}).find((s) => s.key === 'lock').available === false,
  'the lock section follows whether the loan actually has a lock');

// ── The stepper ─────────────────────────────────────────────────────────────
console.log('\nthe milestone stepper — never invent progress');

const CATALOG = [
  { name: 'Started', sort_order: 1 }, { name: 'Loan Setup', sort_order: 2 },
  { name: 'Processing', sort_order: 3 }, { name: 'Clear To Close', sort_order: 4 },
  { name: 'Funding', sort_order: 5 },
];

const step = ws.milestoneStepper(DSCR, CATALOG);
check(step.currentIndex === 2 && step.steps[2].current === true,
  'the loan sits at the milestone Encompass names');
check(step.steps[0].reached && step.steps[1].reached && step.steps[2].reached,
  'everything up to and including it is reached…');
check(!step.steps[3].reached && !step.steps[4].reached,
  '…and nothing after it is');
check(step.unrecognised === false, 'a recognised milestone is not flagged');

// THE ONE THAT MATTERS.
const unknown = ws.milestoneStepper({ milestone_name: 'Some New Milestone' }, CATALOG);
check(unknown.currentIndex === -1 && unknown.unrecognised === true,
  'a milestone the catalog does not carry is FLAGGED as unrecognised');
check(unknown.steps.every((s) => !s.reached && !s.current),
  '…and NOTHING is marked reached — a plausible progress bar drawn from an unknown position is worse than none');

const none = ws.milestoneStepper({}, CATALOG);
check(none.unrecognised === false && none.steps.every((s) => !s.reached),
  'a loan with no milestone at all shows no progress and is not called unrecognised');
check(ws.milestoneStepper(DSCR, []).steps.length === 0,
  'an empty catalog draws an empty stepper rather than throwing');

// The catalog is ordered by the tenant's own sort order, not by the array we were handed.
const shuffled = ws.milestoneStepper(DSCR, [CATALOG[4], CATALOG[0], CATALOG[2], CATALOG[1], CATALOG[3]]);
check(shuffled.steps.map((s) => s.name).join(',') === 'Started,Loan Setup,Processing,Clear To Close,Funding',
  'the stepper sorts by the tenant\'s own order, whatever order the rows arrive in');
check(shuffled.currentIndex === 2, '…so the current position is right regardless');

// ── The rail ────────────────────────────────────────────────────────────────
console.log('\nthe summary rail');

// The property figures are passed as the SAME sections the Property tab renders —
// they live on `lt_properties`, so the loan row cannot supply them and the rail must
// not pretend otherwise. `file.js` shapes them; this mirrors that shape.
const PROP = { appraisedValue: 875000, estimatedValue: 860000, ltvPct: 70, occupancy: 'Investment' };
const INC = { grossMonthlyRent: 2600, actualMonthlyRent: 2450 };

const rail = ws.summaryRail(DSCR, { property: PROP, income: INC });
check(rail.dscr === 1.28 && rail.grossRent === 2600 && rail.housingExpense === 2025.31,
  'the DSCR figures the plan names are all on the rail');
check(rail.propertyValue === 875000 && rail.ltv === 70 && rail.occupancy === 'Investment',
  'the property figures come from the property section, so the rail and the Property tab state one value');

// THE ONE THAT MATTERS: these columns are on `lt_properties`, and reading them off the
// loan row answered null on every loan while the Property tab showed the real number.
const railNoProp = ws.summaryRail({ ...DSCR, appraised_value: 875000, ltv_pct: 70, gross_rent: 2600, occupancy: 'Investment' });
check(railNoProp.propertyValue === null && railNoProp.ltv === null
  && railNoProp.grossRent === null && railNoProp.occupancy === null,
  'THE ONE THAT MATTERS: the rail does not read property figures off the LOAN row — those columns are not on it, and a row that happens to carry them is not where the answer comes from');
check(ws.summaryRail(DSCR, { property: {}, income: {} }).propertyValue === null,
  'a property nobody has read leaves the row honestly empty rather than wrong');
check(ws.summaryRail(DSCR, { property: { estimatedValue: 500000 } }).propertyValue === 500000,
  'with no appraisal yet it falls back to the estimated value rather than showing nothing');
check(rail.loanAmount === 612000 && rail.noteRate === 7.25 && rail.termMonths === 360,
  'the money and the terms are numbers, not strings');
check(rail.stage.key === 'underwriting' && rail.milestone === 'Processing',
  'the rail carries BOTH the Encompass milestone and our own stage');
check(rail.syncedAt === null && 'syncError' in rail,
  'it says how fresh it is — a rail that shows figures without saying when they were read invites trusting a stale one');

// THE RULE THAT OUTRANKS LAYOUT.
const withInvestor = ws.summaryRail({ ...DSCR, investor_name: 'Some Investor', lender: 'Some Investor' });
const railText = JSON.stringify(withInvestor).toLowerCase();
check(!railText.includes('some investor') && !('investorName' in withInvestor) && !('lender' in withInvestor),
  'THE HARD RULE: the investor never reaches the rail, even when the row carries one');

check(ws.summaryRail({}).loanAmount === null && ws.summaryRail({}).dscr === null,
  'a missing figure is NULL, never 0 — "we have not read it" is not "it is zero"');
check(ws.summaryRail(null).loanNumber === null, 'no loan at all does not throw');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

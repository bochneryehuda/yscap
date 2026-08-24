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
  '…and is greyed on a DSCR file with none of the three figures on it');
check(ws.sectionMenu({ product_kind: 'dscr' }, { income: { grossMonthlyRent: 3200 } })
  .find((s) => s.key === 'income').available === true,
  'THE ONE THAT MATTERS: a DSCR file whose RENT is mirrored but whose DSCR has not been computed keeps its income section — the rent lives on the property, and greying the section that would show it states a reason that is not true');
check(ws.sectionMenu({ product_kind: 'dscr' }, { income: { housingExpenseTotal: 2025.31 } })
  .find((s) => s.key === 'income').available === true,
  '…and so does one that holds only the housing expense — one of the three figures is worth opening the section for');
check(ws.hasIncomeFigures(null) === false && ws.hasIncomeFigures({}) === false
  && ws.hasIncomeFigures({ dscr: 0 }) === true && ws.hasIncomeFigures({ grossMonthlyRent: 0 }) === true,
  'and a ZERO is a figure — "$0 of rent" is an answer, while a missing one is not');

// The employment section becomes available the moment the DATA says so — it is a
// function of the loan, not a hard-coded list.
check(ws.sectionMenu({ ...DSCR, employment_applies: true }, {}).find((s) => s.key === 'employment').available === true,
  'employment turns on for the ~2% of the book where it applies — no code change');

// The Condition Center is set aside, and greyed for the same reason as employment.
check(by('conditions').available === false && /switched off/i.test(by('conditions').why),
  'the Condition Center is greyed and names the SWITCH — it is built, so the answer is "turn it on" rather than "wait for it"');
check(!/coming soon/i.test(by('conditions').why),
  '…and no longer says "coming soon" about something that shipped');
check(ws.sectionMenu(DSCR, { conditionsEnabled: true }).find((s) => s.key === 'conditions').available === true,
  '…and turns on from the SETTING, not from a code change');

// Who bought the loan: shown when Encompass names somebody, greyed when it does not.
check(by('investor').available === false && /has not been sold/i.test(by('investor').why),
  'the investor section is greyed until Encompass names one — a heading over nothing reads as a loan nobody sold rather than as one whose buyer we cannot see');
check(ws.sectionMenu(DSCR, { investor: { recorded: true } }).find((s) => s.key === 'investor').available === true,
  '…and turns on the moment a buyer is on the file');

check(by('lock').available === true
   && ws.sectionMenu({ ...DSCR, lock_status: null }, {}).find((s) => s.key === 'lock').available === false,
  'the lock section follows whether the loan actually has a lock');

// ── NO SECTION RULE MAY READ A COLUMN THAT DOES NOT EXIST ───────────────────
//
// The class this catches is silent by construction: `l.gross_rent` on a row that
// has no such column reads as `undefined`, the rule quietly answers "no", the
// section is greyed with a reason that is not true, and nothing anywhere fails. It
// shipped exactly that way. So every `l.<name>` any rule touches is checked
// against the hand-written schema — the same file the drift check compares to the
// real database — plus whatever the ROUTE aliases onto the row it passes in.
console.log('\nevery section rule reads a column the loan actually has');

const path = require('path');
const fs = require('fs');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const prisma = read('src/longterm/prisma/schema.prisma');
const ltLoans = (prisma.match(/^model LtLoan \{([\s\S]*?)^\}/m) || [])[1] || '';
const columns = new Set();
for (const line of ltLoans.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
  const f = t.match(/^(\w+)\s+\w+/);
  if (!f) continue;
  const mapped = (t.match(/@map\("([^"]+)"\)/) || [])[1];
  columns.add(mapped || f[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
}
check(columns.has('dscr_ratio') && columns.has('product_kind') && columns.size > 20,
  'the schema parser found the loan table — a parser that found nothing would make the check below pass on anything');

// What the workspace route SELECTs onto the row beyond `l.*`, read from the route
// itself rather than retyped: a rule may legitimately read one of those.
const routeSrc = read('src/longterm/routes/pipeline.js');
const selectList = (routeSrc.match(/SELECT l\.\*,([\s\S]*?)FROM lt_loans/) || [])[1] || '';
for (const m of selectList.matchAll(/AS\s+(\w+)/gi)) columns.add(m[1].toLowerCase());
for (const m of selectList.matchAll(/\b\w+\.(\w+)/g)) columns.add(m[1].toLowerCase());
check(columns.has('borrower_name') && columns.has('lock_status'),
  '…and the columns the route aliases onto the row are read off the route, never retyped here');

// COMMENTS ARE STRIPPED FIRST. The comment that explains this very bug NAMES the
// phantom column, so a guard that read comments would fail on its own fix — and
// the fix somebody would reach for is deleting the explanation.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const wsSrc = read('src/longterm/workspace.js');
const rulesOnly = strip(wsSrc.slice(wsSrc.indexOf('const SECTIONS'), wsSrc.indexOf('function hasIncomeFigures')));
const phantom = [...new Set([...rulesOnly.matchAll(/\bl\.(\w+)/g)].map((m) => m[1]))]
  .filter((c) => !columns.has(c.toLowerCase()));
// The rule can only be right if the caller actually hands it the figures.
const menuCall = strip(routeSrc).slice(strip(routeSrc).indexOf('workspace.sectionMenu('));
check(/income: file && file\.income,/.test(menuCall.slice(0, 400)),
  'and the ROUTE hands the section menu the same income block it hands the rail — the rule reads figures the loan row does not carry, so a caller that stops passing them silently greys the section again');

check(phantom.length === 0,
  `THE ONE THAT MATTERS: no section rule reads a column the loan does not have${phantom.length ? ` — phantom: ${phantom.join(', ')}` : ''}`);

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

// ── THE SEVEN STOPS + THE MILESTONE BOARD (#37, owner-directed 2026-08-23) ──
console.log('\nthe seven stops — the owner\'s exact list, keyed on done flags');
{
  const labels = ws.SEVEN_STOPS.map((s) => s.label);
  check(JSON.stringify(labels) === JSON.stringify([
    'Started', 'Assigned to processor', 'Submitted to underwriting',
    'Conditionally approved', 'Clear to close', 'Closed', 'Purchased',
  ]), 'EXACTLY the owner\'s seven stops, in the owner\'s order and words');
  check(!labels.some((l) => /investor delivery/i.test(l)), 'Investor Delivery is NOT on the bar (rejected by name)');
  check(!JSON.stringify(ws.SEVEN_STOPS).toLowerCase().includes('not funding'),
    'no "not funding" wording anywhere (rejected by name)');

  const ladder = [
    { milestone_name: 'Started', position: 1, done: true, start_date: '2026-06-01' },
    { milestone_name: 'LO Prep', position: 2, done: true, start_date: '2026-06-03' },
    { milestone_name: 'Loan Setup', position: 3, done: true, start_date: '2026-06-04' },
    { milestone_name: 'Submittal', position: 4, done: false, start_date: '2026-07-01' },
    { milestone_name: 'Cond. Approval', position: 5, done: false },
  ];
  const out = ws.sevenStops(ladder, { sale: { purchased: null, note: 'Encompass has not said.' } });
  check(out.ladderRead === true, 'a read ladder is said to be read');
  check(out.stops[0].reached && out.stops[0].at === '2026-06-01',
    'Started done → the stop is reached with Encompass\'s OWN date');
  check(out.stops[1].reached && out.stops[1].at === '2026-06-03',
    'LO Prep done → Assigned to processor reached (completion semantics, #33)');
  check(!out.stops[2].reached && out.currentIndex === 2,
    'Submittal not done → Submitted to underwriting is the CURRENT stop — its planned date is never shown as reached');
  check(out.stops[6].pilot && out.stops[6].unknown && !out.stops[6].reached,
    'Purchased with no answer stays UNKNOWN — never a no, never a yes');

  const funded = ws.sevenStops(
    [{ milestone_name: 'Funding', position: 14, done: true, start_date: '2026-08-01' }],
    { sale: { purchased: true, at: '2026-08-20', note: 'The investor bought this loan on 2026-08-20.' } });
  check(funded.stops[5].reached && funded.stops[5].label === 'Closed' && funded.stops[5].at === '2026-08-01',
    'Funding done → the CLOSED stop (the owner\'s word — never "funded/not funding")');
  check(funded.stops[6].reached && funded.stops[6].at === '2026-08-20',
    'a bought loan reaches Purchased with the purchase date');

  const empty = ws.sevenStops([], { sale: null });
  check(empty.ladderRead === false && empty.currentIndex === -1
    && empty.stops.every((s) => !s.reached),
    'an UNREAD ladder claims nothing — no stop reached, none current');

  // The witnessed-day fallback: a done step with no Encompass date still shows
  // the day PILOT watched it flip.
  const witnessed = ws.sevenStops(
    [{ milestone_name: 'Started', position: 1, done: true }],
    { reachedAt: { started: '2026-06-09' } });
  check(witnessed.stops[0].reached && witnessed.stops[0].at === '2026-06-09',
    'a done step with no Encompass date falls back to the day PILOT watched it');
}

console.log('the milestone board — every step, date kind, associate');
{
  const catalog = [
    { name: 'Started', sort_order: 1, expected_days: 1 },
    { name: 'LO Prep', sort_order: 2, expected_days: 3 },
    { name: 'Purchased', sort_order: 99, expected_days: null, pilot: true, milestoneId: 'pilot_purchased' },
  ];
  const ladder = [
    { milestone_name: 'Started', position: 1, done: true, start_date: '2026-06-01',
      associate_name: 'Rivka Processor', associate_role: 'Loan Processor', associate_email: 'rp@x.test' },
    { milestone_name: 'LO Prep', position: 2, done: false, start_date: '2026-07-15', role_required: 'Loan Officer' },
  ];
  const board = ws.milestoneBoard(catalog, ladder, {
    reachedAt: { started: '2026-06-02' },
    sale: { purchased: false, note: 'Not bought yet — Encompass has this loan as "Shipped".' },
  });
  check(board.ladderRead === true && board.rows.length === 3, 'every catalog step gets a row');
  const started = board.rows[0];
  check(started.done === true && started.date === '2026-06-01' && started.dateKind === 'worked',
    'a DONE step carries Encompass\'s date as the WORKED date');
  check(started.associate && started.associate.name === 'Rivka Processor'
    && started.associate.role === 'Loan Processor',
    'the associate on the step rides straight off the ladder row (#34\'s ground truth)');
  check(started.witnessedAt === '2026-06-02', 'the day PILOT watched it rides beside it');
  const prep = board.rows[1];
  check(prep.done === false && prep.dateKind === 'planned',
    'an UNWORKED step\'s date is said to be PLANNED — never shown as an arrival');
  check(!prep.associate && prep.roleRequired === 'Loan Officer',
    'a step with nobody assigned says which role it needs instead');
  const bought = board.rows[2];
  check(bought.pilot && bought.done === false && bought.unknown === false && /Shipped/.test(bought.note),
    'the Purchased row keeps the pilot fact\'s own sentence — a NO is an answer, not an unknown');
  const noLadder = ws.milestoneBoard(catalog, [], {});
  check(noLadder.ladderRead === false && noLadder.rows[0].done === null && noLadder.rows[0].inLadder === false,
    'an unread ladder answers done NULL ("the ladder has not said"), never false');
}

// The menu carries the two new sections, always available.
{
  const menu2 = ws.sectionMenu({}, {});
  const ms = menu2.find((x) => x.key === 'milestones');
  const cu = menu2.find((x) => x.key === 'clickup');
  check(ms && ms.available === true && menu2[1] && menu2[1].key === 'milestones',
    'Milestones is on the menu RIGHT AFTER the summary, always available');
  check(cu && cu.available === true, 'the ClickUp syncing section is on the menu, always available');
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

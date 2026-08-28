#!/usr/bin/env node
'use strict';
/**
 * LT test — THE WHITE-LABEL PROGRAM NAMES (owner-directed 2026-08-27).
 *
 * The owner handed a sheet: every Lender Price investor gets a consumer-friendly
 * program name ("Eresi → Platinum … adams NYMT → Empire"), the investor's own
 * name never reaches a client, and a multi-program investor is shown to a
 * consumer as "-1 / -2" with the back office able to see which real program each
 * one is. This suite holds all of that:
 *
 *   A. the owner's sheet, VERBATIM — every line resolves and maps to its name
 *   B. every spelling the LIVE Lender Price system used on 2026-08-27 resolves
 *   C. an investor with NO name is reported, never guessed (Amwest)
 *   D. decoration: annotations, consumer -N labels, roster, purity
 *   E. the ineligible side gets the same identity
 *   F. every white-label name is CONSUMER-SAFE BY CONSTRUCTION — the audience
 *      scrub leaves it untouched, and no name collides with a recorded investor
 *      spelling (a colliding name would be redacted off the very surface it
 *      exists to serve)
 *
 * Pure — no database, no network. Runs in CI.
 *
 *   node scripts/test-lt-investor-programs-pure.js
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const IP = require(path.join(ROOT, 'src/longterm/lenderprice/investor-programs'));
const investors = require(path.join(ROOT, 'src/longterm/encompass/investors'));
const A = require(path.join(ROOT, 'src/longterm/audience'));

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

console.log('LT — the Pricing Engine white-label sheet (owner-directed 2026-08-27)');

// ── A. The owner's sheet, verbatim ───────────────────────────────────────────
// Each line exactly as the owner wrote it, so the sheet can be audited against
// the message word for word. The test is two-sided: the spelling RESOLVES, and
// the resolved key MAPS to exactly this name.
const OWNER_SHEET = [
  ['Eresi', 'Platinum'],
  ['A&D mortgage', 'Emerald'],
  ['Champions', 'Crown'],
  ['The Loan Store', 'Topaz'],
  ['NewRez', 'Onyx'],
  ['Deephaven', 'Diamond'],
  ['Verus', 'Pearl'],
  ['Onity / phh', 'Opal'],
  ['American Heritage lending', 'Liberty'],
  ['Oak Tree Funding', 'Sapphire'],
  ['NQM Funding', 'Ruby'],
  ['CorrFirst', 'Prime'],
  ['Acra Lending', 'Amber'],
  ['Lakeview / Bayview', 'Bluewater'],
  ['Annaly / onslow bay', 'Harbor'],
  ['AmeriHome', 'Granite'],
  ['LoanStream', 'Silver'],
  ['Foundation Mortgage', 'Stone'],
  ['Arc Home LLC', 'Quartz'],
  ['Pennymac', 'Gold'],
  ['Ellington', 'Eclipse'],
  ['Redwood Trust', 'Sequoia'],
  ['SGCG', 'Sterling'],
  ['adams NYMT', 'Empire'],
];
for (const [ownerName, programName] of OWNER_SHEET) {
  const r = investors.resolve(ownerName);
  check(!!r.key, `A: "${ownerName}" resolves to a canonical investor (${r.key || 'NOT RESOLVED'})`);
  check(r.key && IP.whiteLabelOf(r.key) === programName,
    `A: …and that investor's white-label is "${programName}" (got ${r.key ? IP.whiteLabelOf(r.key) : '—'})`);
}
check(Object.keys(IP.PROGRAM_NAMES).length === OWNER_SHEET.length,
  `A: the sheet holds exactly the owner's ${OWNER_SHEET.length} names — nothing invented, nothing dropped`);
const dupNames = Object.values(IP.PROGRAM_NAMES);
check(new Set(dupNames.map((n) => n.toLowerCase())).size === dupNames.length,
  'A: no two investors share a white-label name — a shared name cannot identify anybody');

// ── B. Every LIVE Lender Price spelling resolves to a MAPPED investor ────────
// Captured by running scenarios against the live system on 2026-08-27 (CT
// purchase, NY 2–4, FL cash-out, TX rate&term, plus the ineligible side). The
// one deliberate exception is Amwest — see section C.
const LIVE_LP = [
  ['eResi', 'eresi'], ['AD Mortgage LLC', 'a_and_d'], ['Champions Funding', 'champions'],
  ['The Loan Store', 'loan_store'], ['NewRez, LLC Wholesale', 'newrez'],
  ['Deephaven Mortgage', 'deephaven'], ['Verus', 'verus'], ['Verus  Mortgage Capital', 'verus'],
  ['Onity Mortgage Corp', 'phh'], ['American Heritage Lending - AHL', 'american_heritage'],
  ['Oaktree Funding Corp.', 'oaktree'], ['NQM Funding LLC', 'nqm'], ['Acra Lending', 'acra'],
  ['Onslow', 'onslow_bay'], ['Onslow Bay Financial LLC', 'onslow_bay'],
  ['AmeriHome Mortgage Company, LLC', 'amerihome'], ['LoanStream', 'loanstream'],
  ['Pennymac', 'pennymac'], ['ARC Home Loans', 'arc_home'],
];
for (const [spelling, wantKey] of LIVE_LP) {
  const r = investors.resolve(spelling);
  check(r.key === wantKey && IP.whiteLabelOf(r.key) !== null,
    `B: live spelling "${spelling}" → ${wantKey} → "${IP.whiteLabelOf(wantKey)}"`);
}

// ── C. An investor with no name is REPORTED, never guessed ───────────────────
// Amwest quotes in Lender Price (seen on the ineligible side 2026-08-27) and is
// NOT on the owner's sheet: it must resolve (the registry knows it), carry NO
// white-label, and be named in `unmapped` so the owner can christen it.
{
  const r = investors.resolve('Amwest Funding Corp');
  check(r.key === 'amwest', 'C: Amwest resolves in the registry');
  check(IP.whiteLabelOf('amwest') === null, 'C: …and has NO white-label name — nothing is invented for it');
  const d = IP.decorate([{ lender: 'Amwest', investor: 'Amwest Funding Corp', program: 'X' }]);
  check(d.programs[0].investorKey === 'amwest' && d.programs[0].whiteLabel === null
    && d.programs[0].consumerLabel === null,
  'C: a decorated Amwest row carries its key and NO labels — a consumer surface has nothing it may print');
  check(d.unmapped.length === 1 && d.unmapped[0].investor === 'Amwest Funding Corp',
    'C: …and it is NAMED in unmapped, so the gap is visible instead of silent');
  const rz = investors.resolve('Some Brand New Lender Nobody Knows');
  check(rz.key === null, 'C: a wholly unknown lender resolves to NOTHING — the caller must not guess');
}

// ── D. Decoration — annotations, consumer -N labels, roster, purity ──────────
{
  const programs = [
    { lender: 'Verus', investor: 'Verus  Mortgage Capital', program: 'DSCR Investor Solutions 30 Year Fixed' },
    { lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', program: 'DSCR < 1.00  -  30 Yr Fixed' },
    { lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', program: 'DSCR  1.00-1.24   -  30 Yr Fixed' },
    { lender: 'Mystery Lender', investor: null, program: 'Z' },
  ];
  const before = JSON.stringify(programs);
  const d = IP.decorate(programs);
  check(JSON.stringify(programs) === before, 'D: decorate never mutates the parse — it returns a new copy');
  check(d.programs.length === 4, 'D: every program survives — decoration never drops a row');

  const verus = d.programs[0];
  check(verus.investorKey === 'verus' && verus.whiteLabel === 'Pearl' && verus.consumerLabel === 'Pearl',
    'D: a single-program investor is the BARE name — "Pearl", no suffix');

  const dh = d.programs.filter((p) => p.investorKey === 'deephaven');
  const labels = dh.map((p) => `${p.program} => ${p.consumerLabel}`).sort();
  // Sorted by the vendor's own program name: "DSCR  1.00-1.24…" < "DSCR < 1.00…".
  check(dh.every((p) => /^Diamond-[12]$/.test(p.consumerLabel))
    && new Set(dh.map((p) => p.consumerLabel)).size === 2,
  `D: a two-program investor is "-1" and "-2" (${labels.join(' | ')})`);
  const sortedNames = dh.map((p) => p.program).sort((a, b) => a.localeCompare(b));
  const one = dh.find((p) => p.consumerLabel === 'Diamond-1');
  check(one && one.program === sortedNames[0],
    'D: …numbered by the sorted program name, so the mapping is deterministic within an answer');

  const mystery = d.programs[3];
  check(mystery.investorKey === null && mystery.whiteLabel === null && mystery.consumerLabel === null,
    'D: an unresolved lender is annotated null-null-null, never guessed into somebody\'s name');

  check(d.roster.length === 2 && d.roster[0].whiteLabel === 'Diamond' && d.roster[1].whiteLabel === 'Pearl',
    'D: the roster lists the MAPPED investors present, sorted by white-label');
  const dhRoster = d.roster[0];
  check(dhRoster.programCount === 2
    && dhRoster.programs.every((p) => /^Diamond-[12]$/.test(p.consumerLabel) && p.program),
  'D: …and carries the back-office mapping — which real program each consumer label is');
  check(d.unmapped.length === 1 && d.unmapped[0].lender === 'Mystery Lender',
    'D: the mystery lender is reported in unmapped');

  check(IP.decorate(null).programs.length === 0 && IP.decorate(undefined).roster.length === 0,
    'D: a non-array yields empty everything rather than throwing');
}

// ── E. The ineligible side gets the same identity ────────────────────────────
{
  const out = IP.decorateDisqualifiedLenders([
    { lender: 'NewRez, LLC Wholesale', investor: 'NewRez, LLC Wholesale', items: [] },
    { lender: 'Amwest', investor: 'Amwest Funding Corp', items: [] },
  ]);
  check(out[0].investorKey === 'newrez' && out[0].whiteLabel === 'Onyx',
    'E: a declined lender group carries its key + white-label');
  check(out[1].investorKey === 'amwest' && out[1].whiteLabel === null,
    'E: …and an unmapped one carries its key and NO label');
  check(IP.decorateDisqualifiedLenders(null).length === 0, 'E: a non-array yields [] rather than throwing');
}

// ── F. Consumer-safe BY CONSTRUCTION ─────────────────────────────────────────
// The whole point of a white-label name is that a client may read it. So the
// borrower/TPO scrub must leave every one untouched — a name the scrubber
// would redact is a broken name — and no name may equal a recorded investor
// spelling, which is HOW it would come to be redacted.
{
  const aliasSet = new Set();
  for (const inv of investors.INVESTORS) {
    for (const a of [inv.label].concat(inv.aliases || [])) aliasSet.add(String(a).toLowerCase().trim());
  }
  for (const [key, name] of Object.entries(IP.PROGRAM_NAMES)) {
    const sentence = `Your ${name} quote is ready to review.`;
    check(A.scrubInvestorNames(sentence, 'borrower') === sentence
      && A.scrubInvestorNames(sentence, 'tpo') === sentence,
    `F: "${name}" survives the borrower AND TPO scrub untouched`);
    check(!aliasSet.has(name.toLowerCase()),
      `F: …and "${name}" is not a recorded investor spelling (${key})`);
  }
}

// ── G. The full roster — what the pre-search dropdown offers ─────────────────
{
  const roster = IP.fullRoster();
  check(roster.length === OWNER_SHEET.length,
    `G: the full roster is the whole sheet — ${OWNER_SHEET.length} investors, live in Lender Price or not`);
  const sorted = roster.map((r) => r.whiteLabel);
  check(JSON.stringify(sorted) === JSON.stringify([...sorted].sort((a, b) => a.localeCompare(b))),
    'G: …sorted by white-label name, the identity the dropdown leads with');
  check(roster.every((r) => r.investorLabel && r.investorLabel !== r.whiteLabel),
    'G: …and every entry carries the investor\'s REAL name beside it — this is a staff list');
  const corr = roster.find((r) => r.key === 'corrfirst');
  const lake = roster.find((r) => r.key === 'lakeview');
  check(!!corr && !!lake,
    'G: CorrFirst and Lakeview are ON the list although not yet live — "when they come up, they should be there"');
}

console.log(`\n${failures === 0 ? 'OK — the white-label sheet holds' : `FAILURES: ${failures}`}`);
process.exit(failures ? 1 : 0);

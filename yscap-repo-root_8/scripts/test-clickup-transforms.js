/* Ad-hoc unit tests for src/clickup/transforms.js and status.js.
 * Run: node scripts/test-clickup-transforms.js   (no DB / network needed) */
const t = require('../src/clickup/transforms');
const status = require('../src/clickup/status');
const x = require('../src/clickup/crosswalk');
const id = require('../src/clickup/identity');
const routing = require('../src/clickup/routing');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};

// names
eq('splitName simple', t.splitName('Dov Steiner'), { first: 'Dov', last: 'Steiner' });
eq('splitName 3-part', t.splitName('Issac Michael Grunzweig'), { first: 'Issac Michael', last: 'Grunzweig' });
eq('joinName', t.joinName('Dov', 'Steiner'), 'Dov Steiner');

// dates (round-trip + known live value)
eq('date round-trip', t.fromEpochMs(t.toEpochMs('2026-07-07')), '2026-07-07');
eq('epoch->date', t.fromEpochMs('901872000000'), '1998-07-31');

// money / numbers
eq('parseMoney $', t.parseMoney('$468,750'), 468750);
eq('parseMoney plain', t.parseMoney('90'), 90);
eq('numToString', t.numToString(468750), '468750');

// phone
eq('phone 10-digit', t.normalizePhone('9175381594'), '+19175381594');
eq('phone intl-spaced', t.normalizePhone('+1 929 722 3362'), '+19297223362');

// marital
eq('marital married', t.normalizeMarried('Married'), true);
eq('marital unmarried', t.normalizeMarried('unmarried'), false);
eq('marital single', t.normalizeMarried('single'), false);
eq('marital divorced', t.normalizeMarried('Divorced'), false);
eq('marital freeform yes', t.normalizeMarried('we are married'), true);
eq('marital unknown', t.normalizeMarried("it's complicated"), null);
eq('marriedToPortal true', t.marriedToPortalMarital(true), 'Married');
eq('marriedToPortal false keeps', t.marriedToPortalMarital(false, 'Widowed'), 'Widowed');

// card line (the live example)
eq('parseCardLine', t.parseCardLine('4266843539945489    05/31   789'),
   { number: '4266843539945489', exp: '05/31', cvv: '789', last4: '5489' });
eq('joinCardLine', t.joinCardLine({ number: '4266843539945489', exp: '05/31', cvv: '789' }),
   '4266843539945489  05/31  789');

// dropdown translation (Program option list, live)
const PROGRAM = [
  { id: '31e3b89d-34a4-40a9-9bb9-cbcbd1130060', orderindex: 0, name: 'Fix & Flip With Construction' },
  { id: 'e8ff7301-6a64-4d5c-b4d4-48c8dd707eaa', orderindex: 1, name: 'bridge Without Construction' },
  { id: 'be62fcc8-df9f-4a4f-b2b5-b22b87570e0e', orderindex: 2, name: 'Non-QM - DSCR Ratio' },
];
eq('idx->id (read 0)', t.dropdownIndexToId(PROGRAM, 0), '31e3b89d-34a4-40a9-9bb9-cbcbd1130060');
eq('idx->label (read 1)', t.dropdownIndexToLabel(PROGRAM, 1), 'bridge Without Construction');
eq('label->id (write, case-insensitive)', t.dropdownLabelToId(PROGRAM, 'fix & flip with construction'),
   '31e3b89d-34a4-40a9-9bb9-cbcbd1130060');
eq('id->label', t.dropdownIdToLabel(PROGRAM, 'e8ff7301-6a64-4d5c-b4d4-48c8dd707eaa'), 'bridge Without Construction');

// masking
eq('maskSSN', t.maskSSN('066889965'), '✱✱✱-✱✱-9965');
eq('maskCard', t.maskCard('4266843539945489'), '✱✱✱✱ ✱✱✱✱ ✱✱✱✱ 5489');

// status translation spot-checks
eq('status funded', status.externalFor('closed (6-email funded)'), 'funded');
eq('status on_hold', status.externalFor('inactive / on hold'), 'on_hold');
eq('status processing', status.externalFor('self procesing'), 'processing');

// crosswalk (portal value <-> ClickUp option label)
eq('cw program flip', x.toClickUpLabel('program', 'Fix & Flip w/ Construction'), 'Fix & Flip With Construction');
eq('cw program bridge', x.toClickUpLabel('program', 'Bridge'), 'bridge Without Construction');
eq('cw program groundup', x.toClickUpLabel('program', 'Ground-Up Construction'), 'Ground-Up');
eq('cw program notsure->blank', x.toClickUpLabel('program', 'Not sure yet'), null);
eq('cw program <- bridge', x.fromClickUpLabel('program', 'bridge Without Construction'), 'Bridge');
eq('cw program <- privatehm', x.fromClickUpLabel('program', 'Private hard money'), 'Bridge');
eq('cw proptype sfr', x.toClickUpLabel('property_type', 'SFR (1 unit)'), 'SFR');
eq('cw proptype multi24', x.toClickUpLabel('property_type', 'Multi 2–4'), 'Multi 2-4');
eq('cw proptype <- warrantable', x.fromClickUpLabel('property_type', 'Warrantable condo'), 'Condo');
eq('cw loantype cashout', x.toClickUpLabel('loan_type', 'Refinance — Cash-Out'), 'Refi Cash-Out');
eq('cw rehab heavy', x.toClickUpLabel('rehab_type', 'Heavy / gut rehab'), 'Heavy');
eq('cw housing family', x.toClickUpLabel('housing_status', 'Live with family'), 'Rent Free');
eq('cw housing other->blank', x.toClickUpLabel('housing_status', 'Other'), null);
eq('cw term default', x.toClickUpLabel('term', ''), '12 Months');

// resolveWriteId / resolveReadValue against a live option list
const PROG_LIST = [
  { id: '31e3b89d-34a4-40a9-9bb9-cbcbd1130060', orderindex: 0, name: 'Fix & Flip With Construction' },
  { id: 'e8ff7301-6a64-4d5c-b4d4-48c8dd707eaa', orderindex: 1, name: 'bridge Without Construction' },
  { id: 'be62fcc8-df9f-4a4f-b2b5-b22b87570e0e', orderindex: 2, name: 'Non-QM - DSCR Ratio' },
];
eq('cw resolveWriteId Bridge', x.resolveWriteId('program', 'Bridge', PROG_LIST), 'e8ff7301-6a64-4d5c-b4d4-48c8dd707eaa');
eq('cw resolveReadValue idx1', x.resolveReadValue('program', 1, PROG_LIST), 'Bridge');

// placeholder YS loan number (not a real match key)
eq('placeholder TBD', t.isPlaceholderLoanNumber('TBD'), true);
eq('placeholder tbd spaced', t.isPlaceholderLoanNumber('  tbd '), true);
eq('placeholder zero', t.isPlaceholderLoanNumber('0'), true);
eq('placeholder zeros', t.isPlaceholderLoanNumber('0000'), true);
eq('placeholder empty', t.isPlaceholderLoanNumber(''), true);
eq('placeholder null', t.isPlaceholderLoanNumber(null), true);
eq('placeholder na', t.isPlaceholderLoanNumber('N/A'), true);
eq('placeholder pending', t.isPlaceholderLoanNumber('pending'), true);
eq('placeholder xxxx', t.isPlaceholderLoanNumber('xxxx'), true);
eq('placeholder dashes', t.isPlaceholderLoanNumber('---'), true);
eq('real loan number', t.isPlaceholderLoanNumber('YS2026-0142'), false);
eq('real numeric loan', t.isPlaceholderLoanNumber('1000456'), false);
eq('real not sentinel substring', t.isPlaceholderLoanNumber('NA-2026-001'), false);

// identity (>=2 field match)
const recA = { address: '123 Main St, Newark, NJ 07103', borrowerName: 'Dov Steiner', email: 'dov@x.com',
  ssn: '066-88-9965', phone: '(917) 538-1594', loanNumber: 'YSCAP258134754', dob: '1998-07-31', purchasePrice: '$405,000' };
eq('identity populated 8', id.populatedCount(recA), 8);
eq('identity 2-match', id.countMatches(recA, { borrowerName: 'DOV STEINER', email: 'dov@x.com' }), 2);
eq('identity isMatch', id.isMatch(recA, { borrowerName: 'DOV STEINER', email: 'dov@x.com' }), true);
eq('identity 1-nomatch', id.isMatch(recA, { email: 'dov@x.com' }), false);
eq('identity phone last10', id.normalizeIdentity({ phone: '+1 (917) 538-1594' }).phone, '9175381594');
eq('identity canMaterialize', id.canMaterialize({ borrowerName: 'X', email: 'a@b.com' }), true);
eq('identity cantMaterialize', id.canMaterialize({ email: 'a@b.com' }), false);
const best = id.bestMatch(recA, [{ id: 'app1', identity: { borrowerName: 'DOV STEINER', email: 'dov@x.com' } },
                                  { id: 'app2', identity: { email: 'dov@x.com' } }]);
eq('identity bestMatch', best && best.record.id, 'app1');
eq('ssnHash same value diff format', id.ssnHash('066-88-9965', 'k'), id.ssnHash('066889965', 'k'));
eq('ssnHash diff key differs', id.ssnHash('066889965', 'k1') === id.ssnHash('066889965', 'k2'), false);
eq('ssnHash short -> null', id.ssnHash('123', 'k'), null);

// case-insensitivity of matching keys (same value in any case must match)
eq('identity name case-insensitive',
  id.normalizeIdentity({ borrowerName: 'John SMITH' }).borrowerName,
  id.normalizeIdentity({ borrowerName: 'john smith' }).borrowerName);
eq('identity email case-insensitive',
  id.normalizeIdentity({ email: 'A@B.Com' }).email, id.normalizeIdentity({ email: 'a@b.com' }).email);
eq('identity loan# case-insensitive',
  id.normalizeIdentity({ loanNumber: 'YS-123a' }).loanNumber, id.normalizeIdentity({ loanNumber: 'ys-123A' }).loanNumber);
eq('identity address case-insensitive',
  id.normalizeIdentity({ address: '123 MAIN St' }).address, id.normalizeIdentity({ address: '123 main st' }).address);
eq('identity 2-match across mixed case',
  id.isMatch({ borrowerName: 'John Smith', email: 'A@B.com' },
             { borrowerName: 'JOHN SMITH', email: 'a@b.COM' }), true);
eq('corroborate FULL name mixed case',
  id.emailMatchCorroborated({ firstName: 'Noach', lastName: 'MENDLOVIC' }, { firstName: 'noach', lastName: 'mendlovic' }), true);

// case-insensitive officer routing (a case difference must not drop to Lead Capture)
eq('routing case-insensitive folder',
  routing.resolveRouting('Yehuda Bochner').pipelineFolderId,
  routing.resolveRouting('yehuda bochner').pipelineFolderId);
eq('routing all-caps still an officer', routing.resolveRouting('YEHUDA BOCHNER').role, 'loan_officer');
eq('routing unknown -> unassigned', routing.resolveRouting('Nobody Here').role, 'unassigned');

// email-match corroboration gate (§3.4 — email alone is never enough to merge)
// LAST NAME ALONE NEVER CORROBORATES (owner incident 2026-07-15 night): family
// members share the email AND the surname — an officer's lead and a different
// real borrower were merged into one profile exactly this way. The wrong-officer
// merge shape MUST stay false forever:
eq('corrob last name ALONE is NOT enough (the wrong-officer merge incident)',
  id.emailMatchCorroborated({ lastName: 'Steiner', phone: null, dob: null }, { lastName: 'STEINER', phone: null, dob: null }), false);
eq('corrob family email + family surname, different first names -> two people, never merged',
  id.emailMatchCorroborated({ firstName: 'Noach', lastName: 'Mendelovits' }, { firstName: 'Chaim', lastName: 'Mendelovits' }), false);
eq('corrob FULL name (first + last agree)',
  id.emailMatchCorroborated({ firstName: 'Yosef', lastName: 'Steiner' }, { firstName: 'yosef', lastName: 'STEINER' }), true);
eq('corrob placeholder first names never corroborate',
  id.emailMatchCorroborated({ firstName: 'Unknown', lastName: 'Steiner' }, { firstName: 'unknown', lastName: 'Steiner' }), false);
eq('corrob phone last10',
  id.emailMatchCorroborated({ phone: '+1 (917) 538-1594' }, { phone: '9175381594' }), true);
eq('corrob dob (Date vs string)',
  id.emailMatchCorroborated({ dob: new Date('1998-07-31T00:00:00Z') }, { dob: '1998-07-31' }), true);
// pg `date` -> LOCAL-midnight Date: compares by calendar date on ANY server TZ
eq('corrob dob (local-midnight pg Date)',
  id.emailMatchCorroborated({ dob: new Date(1998, 6, 31) }, { dob: '1998-07-31' }), true);
// shared email, DIFFERENT people (nothing else agrees) -> NOT corroborated -> no merge
eq('corrob two different people',
  id.emailMatchCorroborated({ lastName: 'Cohen', phone: '2125551111', dob: '1980-01-01' },
                            { lastName: 'Weiss', phone: '9175552222', dob: '1975-05-05' }), false);
// a field present on only ONE side never corroborates
eq('corrob one-sided last name', id.emailMatchCorroborated({ lastName: 'Katz' }, { lastName: null }), false);
eq('corrob both empty', id.emailMatchCorroborated({}, {}), false);
eq('corrob blank strings', id.emailMatchCorroborated({ lastName: '  ' }, { lastName: '' }), false);

// nameConflict — the same-email-different-person guard on every borrower
// adoption path (staff file create, portal invite, lead convert, public intake)
eq('nameConflict: different first names -> conflict',
  id.nameConflict('Noach', 'Mendelovits', 'Chaim', 'Mendelovits'), true);
eq('nameConflict: different last names -> conflict',
  id.nameConflict('Moshe', 'Cohen', 'Moshe', 'Weiss'), true);
eq('nameConflict: same person, case/middle-name noise -> no conflict',
  id.nameConflict('Moshe Dov', 'COHEN', 'moshe', 'Cohen'), false);
eq('nameConflict: initial matches its full name -> no conflict',
  id.nameConflict('M', 'Cohen', 'Moshe', 'Cohen'), false);
eq('nameConflict: placeholder never conflicts',
  id.nameConflict('Unknown', 'Unknown', 'Moshe', 'Cohen'), false);
eq('nameConflict: blanks never conflict', id.nameConflict('', '', 'Moshe', 'Cohen'), false);

// RTL descope gate (I-A) — ONLY positively non-RTL labels may descope a live file
eq('nonRtl dscr label', x.isNonRtlProgramLabel('Non-QM - DSCR Ratio'), true);
eq('nonRtl heloc keyword', x.isNonRtlProgramLabel('HELOC Line of Credit'), true);
eq('nonRtl rental keyword', x.isNonRtlProgramLabel('Rental Portfolio 30 year'), true);
eq('rtl fix&flip not nonRtl', x.isNonRtlProgramLabel('Fix & Flip With Construction'), false);
eq('rtl bridge not nonRtl', x.isNonRtlProgramLabel('bridge Without Construction'), false);
eq('rtl groundup not nonRtl', x.isNonRtlProgramLabel('Ground-Up'), false);
// the catastrophe guard: a RENAMED / new RTL-ish option must NOT read as non-RTL
eq('renamed rtl label not nonRtl', x.isNonRtlProgramLabel('Fix & Flip - Heavy Reno'), false);
eq('blank not nonRtl', x.isNonRtlProgramLabel(''), false);
eq('null not nonRtl', x.isNonRtlProgramLabel(null), false);
eq('unset not nonRtl', x.isNonRtlProgramLabel('Not sure yet'), false);

// ---- date-only ClickUp WRITE convention (2026-07-15 DOB incident) ----------
// ClickUp pins a no-time date to 4 AM in the setter's timezone and renders the
// day in each viewer's timezone. We write 4 AM America/New_York — verified live:
// a native ClickUp entry of 1967-11-12 by this NY team stores -67446000000.
eq('dateOnly EDT (summer)', t.dateOnlyToClickUpEpoch('2026-07-18'), Date.UTC(2026, 6, 18, 8));
eq('dateOnly EST (winter)', t.dateOnlyToClickUpEpoch('2026-01-05'), Date.UTC(2026, 0, 5, 9));
eq('dateOnly matches live native ClickUp value', t.dateOnlyToClickUpEpoch('1967-11-12'), -67446000000);
eq('dateOnly round-trips through pull', t.fromEpochMs(t.dateOnlyToClickUpEpoch('1999-01-15')), '1999-01-15');
eq('dateOnly never UTC midnight (displays -1 day in NY)', t.dateOnlyToClickUpEpoch('1999-01-15') % 86400000 === 0, false);
// instants (timestamptz) collapse to their NEW YORK calendar day
eq('instant late-evening NY stays on its NY day',
  t.fromEpochMs(t.dateOnlyToClickUpEpoch(new Date('2026-07-11T03:15:00Z'))), '2026-07-10');
// mid-typing artifacts and garbage never reach ClickUp
eq('garbage year 0026 refused', t.dateOnlyToClickUpEpoch('0026-07-18'), null);
eq('garbage year 9999 refused', t.dateOnlyToClickUpEpoch('9999-01-01'), null);
eq('blank refused', t.dateOnlyToClickUpEpoch(''), null);
eq('null refused', t.dateOnlyToClickUpEpoch(null), null);
// legacy + foreign epochs still pull back on the intended day (nearest-day snap)
eq('pull legacy portal 00:00Z', t.fromEpochMs(Date.UTC(1999, 0, 15)), '1999-01-15');
eq('pull native NY 4am (EDT)', t.fromEpochMs(Date.UTC(1999, 0, 15, 9)), '1999-01-15');
eq('pull Israel-midnight prev evening', t.fromEpochMs(Date.UTC(1999, 0, 14, 22)), '1999-01-15');

// ---- 2-digit / out-of-range year pivot (review-queue proposals) -------------
eq('pivot dob 26 -> 1926 (never future)', t.pivotSuspectYear('0026-07-18', 'dob'), '1926-07-18');
eq('pivot dob 99 -> 1999', t.pivotSuspectYear('0099-01-15', 'dob'), '1999-01-15');
eq('pivot dob 05 -> 2005 (adult in 20xx, keeps 20xx)', t.pivotSuspectYear('0005-03-12', 'dob'), '2005-03-12');
eq('pivot dob 15 -> 1915 (2015 would be a minor)', t.pivotSuspectYear('0015-03-12', 'dob'), '1915-03-12');
eq('pivot closing 26 -> 2026', t.pivotSuspectYear('0026-07-18', 'closing'), '2026-07-18');
eq('pivot in-range year untouched', t.pivotSuspectYear('1999-01-15', 'dob'), null);
eq('pivot 3-digit year no guess', t.pivotSuspectYear('0203-01-15', 'closing'), null);
eq('pivot garbage null', t.pivotSuspectYear('nonsense', 'dob'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/* Ad-hoc unit tests for src/clickup/transforms.js and status.js.
 * Run: node scripts/test-clickup-transforms.js   (no DB / network needed) */
const t = require('../src/clickup/transforms');
const status = require('../src/clickup/status');
const x = require('../src/clickup/crosswalk');
const id = require('../src/clickup/identity');
const echo = require('../src/clickup/echo');

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

// email-match corroboration gate (§3.4 — email alone is never enough to merge)
eq('corrob last name',
  id.emailMatchCorroborated({ lastName: 'Steiner', phone: null, dob: null }, { lastName: 'STEINER', phone: null, dob: null }), true);
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

// echo suppression
echo._clear();
echo.markPushed('task1', 'fieldX', 'hello');
eq('echo window hit', echo.isEcho('task1', 'fieldX', 'hello'), true);
eq('echo window miss', echo.isEcho('task1', 'fieldX', 'world'), false);
eq('echo shadow equality', echo.isEcho('task1', 'fieldY', 'abc', 'abc'), true);
eq('echo shadow diff', echo.isEcho('task1', 'fieldY', 'abc', 'xyz'), false);
eq('echo hash stable', echo.valueHash({ a: 1, b: 2 }), echo.valueHash({ b: 2, a: 1 }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

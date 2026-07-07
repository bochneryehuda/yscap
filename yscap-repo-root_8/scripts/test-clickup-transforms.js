/* Ad-hoc unit tests for src/clickup/transforms.js and status.js.
 * Run: node scripts/test-clickup-transforms.js   (no DB / network needed) */
const t = require('../src/clickup/transforms');
const status = require('../src/clickup/status');
const x = require('../src/clickup/crosswalk');

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

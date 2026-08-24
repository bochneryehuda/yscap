'use strict';
/**
 * LONG-TERM — the ClickUp FIELD WRITER (db/625): every inherited guard proven,
 * the field map proven against the two LIVE-probed loans, and the push/create
 * pipeline proven end to end through a stubbed wire.
 *
 * Fixtures are REAL: the `ex` bags below are the exact fieldReader answers the
 * 2026-08-24 two-loan probe returned (SSNs replaced with a test value — the
 * real ones were never stored anywhere).
 *
 * What this proves (letters = sections):
 *   A. writer-client guards — delete refused (v2 AND v3, NO carve-out), clear
 *      refused (incl. the nested-null JSON class), rename refused, retry truth
 *      table
 *   B. transforms — the 4AM date rule round-trips, '//' and garbage years
 *      refuse, US dates parse
 *   C. the label mappers — the owner's channel map, vesting, program (a
 *      short-term program is never defaulted), lender certain-spellings,
 *      PPP, property type, term, housing
 *   D. writeValue / addressField / isBlankClickupValue
 *   E. buildTaskFields against BOTH live-probed loans — the dynamic
 *      purchase/estimate rule, refi-only fields, Individual-never-writes-the-
 *      entity-name, SSN pass-through formatting, processor both-or-neither
 *   F. fieldValueEquivalent per type + the DOB change detector
 *   G. resolveOnly / PII shield shape / providerTextSafe
 *   (DB, skipped without DATABASE_URL)
 *   H. pushLoan end to end through a stubbed wire — writes land, journal rows
 *      land, no-op suppression
 *   I. the PII overwrite shield blocks + queues review (and the queue dedupes)
 *   J. the DOB gate blocks a change, allows a fill
 *   K. locations are fill-only; fillOnly mode fills blanks only
 *   L. pre-read failure fails CLOSED; a scoped push never creates; a
 *      short-term card refuses; the breaker opens; a lossy push is never
 *      marked done
 *   M. createForLoan — the card is born in the officer's folder with the
 *      stamps, linked race-safe, journaled source='create'
 *   N. the passes — createPass honors the go-live date; pushPass drains and
 *      stamps; both stand down with the switch off
 *
 * Mutation-proven (each run by hand, suite red, control green):
 *   1. guardNoTaskDeletion given RTL's carve-out        → A fails
 *   2. writeValue dates via toEpochMs (UTC midnight)    → B/E fail
 *   3. the PII shield check removed from push.js        → I fails
 *   4. the pre-read made warn-only                      → L fails
 *   5. the breaker check removed                        → L fails
 */

const assert = require('assert');
const path = require('path');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };
const throwsCode = (fn, code, w) => {
  try { fn(); } catch (e) { assert.strictEqual(e.code, code, `${w} (code ${e.code})`); console.log('  ok  ', w); checks++; return; }
  assert.fail(`${w} — did not throw`);
};

// The live probe answers (2026-08-24) — SSN AND the borrower emails replaced
// with test values (audit round 2, obs 9: no real person's contact pair in the repo).
const EX_BIRCH = { // cash-out refi, Individual vesting
  3: '7.375', 11: '363 BIRCH DR', 12: 'CRESCO', 14: 'PA', 15: '18326-7761', 16: '1',
  19: 'Cash-Out Refinance', 24: '2022', 25: '365,000.00', 52: 'Married', 65: '123456789',
  136: '', 353: '35.000', 356: '450,000', 745: '07/01/2026', 763: '08/14/2026',
  1005: '15,286.60', 1177: '', 1240: 'lt.writer.one@example.com', 1268: '', 1402: '05/14/1985',
  1811: 'Investor', 1821: '300,000',
  'CX.TABLEFUNDER': 'Non Delegated Correspondent', 'CX.COMPANYLEAD': '',
  'CX.FILENOTESTASKPAGE': 'owned under individual name not under entity',
  'CX.PROPERTYTYPE': 'Single Family Residence', 'CX.PPPTERM': 'No PPP', 'CX.PPPTYPE': 'No PPP',
  'CX.DATEACQUIRED': '11/29/2022', 'CORRESPONDENT.X141': '', 'CX.FREECLEAR': 'X',
  'CX.TITLECONTACT': '', 'CX.INSURANCECONTACT': '', 'CX.FUNDEDDATE': '08/23/2026',
  'CX.SUBMITEDTOINVESTOR': 'X', 'VEND.X276': '2000001166', 'VEND.X263': 'Deephaven Mortgage',
  FR0115: 'Own', FR0116: '', FR0112: '17', FR0124: '0', 'VASUMM.X23': '787',
};
const EX_BIRCHWOOD = { // purchase, Officer vesting
  3: '7.250', 16: '1', 19: 'Purchase', 24: '', 25: '', 52: 'Married', 65: '987654321',
  136: '580,000.00', 353: '80.000', 356: '600,000', 745: '06/08/2026', 763: '07/28/2026',
  1005: '4,000.00', 1240: 'lt.writer.two@example.com', 1268: '', 1402: '03/02/1990',
  1811: 'Investor', 1821: '600,000',
  'CX.TABLEFUNDER': 'Correspondent', 'CX.PPPTERM': '1 Year', 'CX.PPPTYPE': '5% Fixed',
  'CX.PROPERTYTYPE': 'Single Family Residence', 'CX.DATEACQUIRED': '//',
  'CX.SUBMITEDTOINVESTOR': 'X', 'VEND.X276': '3505001548', 'VEND.X263': 'Champions Funding, LLC (CF)',
  FR0115: 'Rent', FR0116: '1,900.00', FR0112: '3', FR0124: '6', 'VASUMM.X23': '782',
};

function optionsFor(mapper) {
  // Live labels off the 2026-08-24 catalog (incl. the real trailing spaces).
  const CU = mapper.CU;
  const mk = (labels) => labels.map((name, i) => ({ id: `opt-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, orderindex: i }));
  return {
    [CU.channel]: mk(['Non Del Correspondent ', 'Wholesale ', 'Delegate Correspondent', 'Table funding ', 'Evolve Underwriting']),
    [CU.primaryHousing]: mk(['Rent', 'Mortgage', 'Free', 'own free and clear', 'Rent Free']),
    [CU.vesting]: mk(['Individual', 'LLC / Corp', 'Trust', 'Need Transfer At Closing']),
    [CU.maritalStatus]: mk(['YES', 'NO']),
    [CU.coBorrowerFlag]: mk(['YES', 'NO']),
    [CU.lender]: mk(['Deephaven', 'Champions', 'EMCAP Financial', 'Fidelis Investors LLC', 'Oak Tree', 'Roc Capital', 'RCN Capital', 'A&D Mortgage', 'Blue Lake Capital', 'CorrFirst', 'Acra Lending']),
    [CU.occupancy]: mk(['Primary', 'Investment', 'Secondary']),
    [CU.loanType]: mk(['Purchase', 'Refi Rate & Term', 'Refi Cash-Out', 'Delayed Purchase Financing', 'HELOC', 'Second Closed end Mortgage']),
    [CU.program]: mk(['Fix & Flip With Construction', 'Ground-Up', 'Non-QM - DSCR Ratio', 'Conventional', 'HELOC']),
    [CU.propertyType]: mk(['SFR', 'Multi 2-4', 'Multi 5+', 'Condo', 'Mixed Use']),
    [CU.term]: mk(['30 year', '15 year', 'Other', 'Interest only', '12 Months', '40 year IO - 10 YEAR IO AND 30 Y FIXED', '30 year IO - 10 YEAR IO AND 20 Y FIXED']),
    [CU.appSubmitted]: mk(['YES', 'NO', 'NOT YET']),
    [CU.pppDropdown]: mk(['5 Years', '4 Years', '3 Years', '2 Years', '1 Years', '6 Months', 'Non']),
  };
}

async function pureHalf() {
  const writer = require('../src/longterm/clickup/writer-client');
  const T = require('../src/longterm/clickup/transforms');
  const mapper = require('../src/longterm/clickup/mapper');
  const I = mapper._internals;
  const CU = mapper.CU;

  console.log('A. writer-client guards');
  throwsCode(() => writer.guardNoTaskDeletion('DELETE', '/task/abc123'), 'CLICKUP_DELETE_FORBIDDEN',
    'DELETE /task/{id} is refused');
  throwsCode(() => writer.guardNoTaskDeletion('DELETE', '/list/9/task/abc123'), 'CLICKUP_DELETE_FORBIDDEN',
    'DELETE /list/{id}/task/{id} (list removal) is refused');
  // THE LT DIFFERENCE: RTL carves out two assignment money fields; LT has NO
  // carve-out — the exact path RTL permits is refused here.
  throwsCode(() => writer.guardNoTaskDeletion('DELETE', '/task/abc/field/273c41d1-10ee-4b02-aa74-7007f8023574'), 'CLICKUP_DELETE_FORBIDDEN',
    'the RTL assignment-clear path is REFUSED here — LT clears nothing, ever');
  writer.guardNoTaskDeletion('DELETE', '/webhook/123');
  ok(true, 'webhook DELETE (not a task path) passes the deletion guard');
  throwsCode(() => writer.guardV3TaskPath('PUT', '/workspaces/9/tasks/abc/home_list/1'), 'CLICKUP_V3_FORBIDDEN',
    'even the v3 home-list move RTL allows is refused — the LT allowlist is EMPTY');
  throwsCode(() => writer.guardV3TaskPath('GET', '/workspaces/9/tasks/abc'), 'CLICKUP_V3_FORBIDDEN',
    'any v3 task path is refused whatever the verb');
  throwsCode(() => writer.guardNoFieldClearing('f1', null), 'CLICKUP_EMPTY_WRITE_FORBIDDEN', 'null value refused');
  throwsCode(() => writer.guardNoFieldClearing('f1', '   '), 'CLICKUP_EMPTY_WRITE_FORBIDDEN', 'blank string refused');
  throwsCode(() => writer.guardNoFieldClearing('f1', []), 'CLICKUP_EMPTY_WRITE_FORBIDDEN', 'empty array refused');
  throwsCode(() => writer.guardNoFieldClearing('f1', { add: [] }), 'CLICKUP_EMPTY_WRITE_FORBIDDEN', 'empty users add-list refused');
  throwsCode(() => writer.guardNoFieldClearing('f1', { location: { lat: null, lng: -74 } }), 'CLICKUP_EMPTY_WRITE_FORBIDDEN',
    'a nested null (JSON → clear) is refused');
  throwsCode(() => writer.guardNoFieldClearing('f1', { location: { lat: NaN, lng: -74 } }), 'CLICKUP_EMPTY_WRITE_FORBIDDEN',
    'a nested NaN (JSON → null → clear) is refused');
  writer.guardNoFieldClearing('f1', { location: { lat: 40.1, lng: -74.2 }, formatted_address: 'x' });
  ok(true, 'a real location value passes');
  throwsCode(() => writer.guardTaskUpdatePayload({ name: 'renamed!' }), 'CLICKUP_RENAME_FORBIDDEN',
    'a task rename is refused — updates are status-only');
  throwsCode(() => writer.guardTaskUpdatePayload({ status: '  ' }), 'CLICKUP_EMPTY_WRITE_FORBIDDEN', 'an empty status is refused');
  eq(writer.inCallRetryAllowed(false, null), false, 'a non-idempotent POST is never re-sent after a timeout (duplicate-card guard)');
  eq(writer.inCallRetryAllowed(false, 429), true, 'a 429 is always safe to retry (rejected before processing)');
  eq(writer.inCallRetryAllowed(false, 500), false, 'a 5xx create is not re-sent in-call');
  eq(writer.inCallRetryAllowed(true, 500), true, 'an idempotent write retries a 5xx');
  eq(writer.httpError('POST', '/task/x/field/y', 429, 3).retryable, true, 'httpError tags 429 retryable');
  ok(!/token|value/i.test(writer.httpError('POST', '/task/x/field/y', 400).message.replace('/task/x/field/y', '')),
    'the error message is value-free');

  console.log('B. the date rule');
  const epoch = T.dateOnlyToClickUpEpoch('2026-08-14');
  eq(T.fromEpochMs(epoch), '2026-08-14', 'a written date round-trips to the same calendar day');
  const hourUtc = new Date(epoch).getUTCHours();
  ok(hourUtc >= 8 && hourUtc <= 10, `the epoch sits at 4AM New York ([08:00Z,10:00Z] — got ${hourUtc}:00Z)`);
  eq(T.dateOnlyToClickUpEpoch('//'), null, "Encompass's '//' unreached-date is null, never an epoch");
  eq(T.dateOnlyToClickUpEpoch('08/14/2026'), epoch, 'the US MM/DD/YYYY form writes the same day');
  eq(T.dateOnlyToClickUpEpoch('0026-08-14'), null, 'a mid-typing year-0026 artifact refuses');
  eq(T.isPlaceholderLoanNumber('TBD'), true, 'a TBD loan number is a placeholder');
  eq(T.isPlaceholderLoanNumber('YSCAP258134741'), false, 'a real loan number is not');
  eq(T.maskSSN('123456789'), '✱✱✱-✱✱-6789', 'maskSSN keeps last-4 only');

  console.log('C. the label mappers');
  eq(I.channelLabel('Non Delegated Correspondent'), 'Non Del Correspondent', 'Non Delegated Correspondent → non-del');
  eq(I.channelLabel('Correspondent'), 'Non Del Correspondent', 'Correspondent → non-del (owner map)');
  eq(I.channelLabel(''), 'Non Del Correspondent', 'blank → the default channel (owner: unmatched defaults non-del)');
  eq(I.channelLabel('Table Funding'), 'Table funding', 'Table Funding → Table funding');
  eq(I.channelLabel('Delegate correspondent / Evolve'), 'Evolve Underwriting', 'Delegate/Evolve → Evolve Underwriting');
  eq(I.channelLabel('Delegate correspondent / In House'), 'Delegate Correspondent', 'Delegate/In-House → Delegate Correspondent');
  eq(I.channelLabel('Brokering out'), 'Wholesale', 'Brokering out → Wholesale');
  eq(I.channelLabel('Wholesale Out'), 'Wholesale', 'Wholesale Out → Wholesale');
  eq(I.vestingLabel('Individual'), 'Individual', '4008 Individual → Individual');
  eq(I.vestingLabel('Officer'), 'LLC / Corp', '4008 Officer → LLC / Corp');
  eq(I.vestingLabel('Trustee'), 'Trust', '4008 Trustee → Trust');
  eq(I.vestingLabel('Something New'), null, 'an unmeasured vesting word is never guessed');
  eq(I.programLabel('Investor DSCR 30 YEAR FRM'), 'Non-QM - DSCR Ratio', 'the DSCR family maps');
  // Audit round 2, obs 2: the owner's default rule is PRESENT-but-unmapped →
  // DSCR ("the bottom line"). A BLANK mirror value states nothing and writes
  // nothing — defaulting a blank rewrote hand-set card labels during read gaps.
  eq(I.programLabel(''), null, 'a BLANK program writes NOTHING — never a defaulted rewrite (obs 2)');
  eq(I.programLabel('Some Brand New LT Program'), 'Non-QM - DSCR Ratio',
    'a PRESENT-but-unmapped long-term program still defaults DSCR (the owner\'s bottom line)');
  eq(I.programLabel('Fix & Flip Purchase'), null, 'a SHORT-TERM program is skipped, never defaulted to DSCR');
  eq(I.loanTypeLabel('Cash-Out Refinance'), 'Refi Cash-Out', 'field 19 cash-out maps');
  eq(I.loanTypeLabel('NoCash-Out Refinance'), 'Refi Rate & Term', 'field 19 no-cash-out maps');
  eq(I.propertyTypeLabel('Single Family Residence'), 'SFR', 'SFR maps');
  eq(I.propertyTypeLabel('2-4 Family'), 'Multi 2-4', '2-4 Family maps');
  eq(I.propertyTypeLabel('Multifamily (5+ Units)'), 'Multi 5+', '5+ maps');
  eq(I.occupancyLabel('Investor'), 'Investment', '1811 Investor → Investment');
  eq(I.termLabel(360, 0), '30 year', '360 months → 30 year');
  eq(I.termLabel(360, 120), '30 year IO - 10 YEAR IO AND 20 Y FIXED', '360 + IO → the 30-year IO option');
  eq(I.termLabel(480, 120), '40 year IO - 10 YEAR IO AND 30 Y FIXED', '480 + IO → the 40-year IO option');
  eq(I.termLabel(240, 0), null, 'an unmapped term is never guessed');
  eq(I.pppLabel('No PPP', null), 'Non', 'No PPP → Non');
  eq(I.pppLabel('5 Year', null), '5 Years', '5 Year → 5 Years');
  eq(I.pppLabel(null, 36), '3 Years', '36 months → 3 Years');
  eq(I.pppLabel(null, null), null, 'no PPP data claims nothing');
  eq(I.pppText('No PPP', 'No PPP'), 'No PPP', 'equal PPP term/type say it once');
  eq(I.pppText('1 Year', '5% Fixed'), '1 Year — 5% Fixed', 'term + type join');
  eq(I.lenderLabel('Deepahven'), 'Deephaven', 'the measured misspelling Deepahven maps');
  eq(I.lenderLabel('Champions Funding, LLC (CF)'), 'Champions', 'the full Champions spelling maps');
  eq(I.lenderLabel('rcn Capital (RCN)'), 'RCN Capital', 'RCN maps as a whole word');
  eq(I.lenderLabel('--'), null, 'junk is skipped');
  eq(I.lenderLabel('Some Brand New Shop'), null, 'an unmeasured lender is SKIPPED for the owner (#41), never guessed');
  eq(I.lenderLabel('Fidelis Investors LLC'), 'Fidelis Investors LLC', 'Fidelis maps to its own option');
  eq(I.housingLabel('Rent', ''), 'Rent', 'FR0115 Rent → Rent');
  eq(I.housingLabel('Own', '1,200'), 'Mortgage', 'Own + a payment → Mortgage');
  eq(I.housingLabel('Own', ''), 'own free and clear', 'Own + no payment → own free and clear');
  eq(I.housingLabel('LiveRentFree', ''), 'Rent Free', 'LiveRentFree → Rent Free');
  eq(I.ltvText('35.000'), '35', 'LTV 35.000 reads 35');
  eq(I.ltvText('67.500'), '67.5', 'LTV 67.500 reads 67.5');
  eq(I.yearsAtResidenceText('17', '0', null), '17 years', 'FR0112/FR0124 17y 0m');
  eq(I.yearsAtResidenceText('3', '6', null), '3 years 6 months', '3y 6m');
  eq(I.appSubmittedLabel('X'), 'YES', 'CX.SUBMITEDTOINVESTOR X → YES');
  eq(I.appSubmittedLabel(''), null, 'blank claims nothing');
  eq(I.emailIn('Jane Doe - jane@title.com - 555-1234'), 'jane@title.com', 'an email is extracted from contact text');
  eq(I.emailIn('call the office'), null, 'no email in the text → nothing');

  console.log('D. writeValue / addressField / isBlankClickupValue');
  const options = optionsFor(mapper);
  const chanRow = mapper.FIELD_MAP.find((f) => f.key === 'channel');
  eq(mapper.writeValue(chanRow, 'Non Del Correspondent', options), 'opt-non-del-correspondent',
    'a dropdown label resolves to the LIVE option UUID (trailing-space label tolerated)');
  eq(mapper.writeValue(chanRow, 'An Option Nobody Made', options), undefined,
    'an unmatched label no-ops — never invent an option');
  const dobRow = mapper.FIELD_MAP.find((f) => f.key === 'date_of_birth');
  const dobEpoch = mapper.writeValue(dobRow, '05/14/1985', options);
  eq(T.fromEpochMs(dobEpoch), '1985-05-14',
    'a date field writes the right calendar day');
  const dobHour = new Date(Number(dobEpoch)).getUTCHours();
  ok(dobHour >= 8 && dobHour <= 10,
    `writeValue writes the 4AM-New-York epoch, NEVER UTC midnight (got ${dobHour}:00Z — a midnight epoch renders as the previous day to the whole US team)`);
  const usersRow = mapper.FIELD_MAP.find((f) => f.key === 'loan_officer');
  assert.deepStrictEqual(mapper.writeValue(usersRow, 120151948, options), { add: [120151948] });
  ok(true, 'a users field writes {add:[id]} — never a bare id');
  eq(mapper.addressField('f', { lat: null, lng: -74 }), null, 'a location without both coordinates refuses (null)');
  eq(mapper.addressField('f', { lat: NaN, lng: -74 }), null, 'NaN coordinates refuse');
  ok(mapper.addressField('f', { lat: 40.1, lng: -74.2, formatted_address: '1 Main St' }), 'real coordinates emit');
  eq(mapper.isBlankClickupValue({ location: { lat: null, lng: null }, formatted_address: '' }), true,
    'a coordinate-less location reads BLANK (fillable), not occupied');
  eq(mapper.isBlankClickupValue({ location: { lat: 40, lng: -74 }, formatted_address: '1 Main St' }), false,
    'a real location reads occupied');

  console.log('E. buildTaskFields on the two live-probed loans');
  const birchBag = {
    loan: { loan_number: 'YSCAP258134741', borrower_name: 'Joseph Parnes', loan_amount: '157500',
      note_rate_pct: '7.375', term_months: 360, interest_only_months: 0, prepayment_penalty_months: null,
      dscr_ratio: '1.25', loan_purpose: 'Cash-Out Refinance', program_name: 'Investor DSCR 30 YEAR FRM',
      vesting_type: 'Individual', vesting_entity_name: '400 Birchwood LLC' /* STALE — must never write */,
      borrower_email: null, expense_hazard_insurance: '120', expense_real_estate_taxes: '300', expense_association_dues: null },
    prop: { street: '363 BIRCH DR', city: 'CRESCO', state: 'PA', zip: '18326', unit_count: 1,
      estimated_value: '300000', appraised_value: '450000', purchase_price: null, ltv_pct: '35' },
    borrower: { first_name: 'Joseph', last_name: 'Parnes', mobile_phone: '3479070483', fico_representative: 780 },
    coborrower: null,   // KNOWN none
    residence: null, priorResidence: null,
    ex: EX_BIRCH, officer: { name: 'Yehuda Bochner', email: 'yehuda@yscapgroup.com', clickupUserId: 120151948 },
    processor: { name: 'Sarah', email: 'sarah@yscapgroup.com', clickupUserId: null }, // no id → BOTH dropped
    investorLoanNumber: null, investorName: null,
    portalFileId: 'lt-loan-uuid-1', portalFileLink: 'https://x/portal/#/long-term/file/lt-loan-uuid-1',
    subjectGeo: { lat: 41.09, lng: -75.26, formatted_address: '363 Birch Dr, Cresco, PA 18326' },
    borrowerGeo: null, priorGeo: null,
  };
  const bf = mapper.buildTaskFields(birchBag, options);
  const by = (key) => bf.find((f) => f.key === key);
  eq(by('channel').value, 'opt-non-del-correspondent', 'Birch: Non Delegated Correspondent → the non-del option');
  eq(by('purchase_or_estimate').value, '450000',
    'THE DYNAMIC PRICE RULE: refi with 356 set → the ACTUAL appraised 450,000 (not 1821, not blank 136)');
  eq(by('vesting').value, 'opt-individual', 'Individual vesting → the Individual option');
  eq(by('llc_name'), undefined,
    'THE 4008 RULE: an Individual vesting NEVER writes the (stale) entity name');
  eq(by('ssn').value, '123-45-6789', 'the live SSN passes through, dashed');
  eq(by('year_purchased').value, '2022', 'refi-only Year Purchased writes on a refi');
  eq(by('free_and_clear').value, 'true', 'CX.FREECLEAR X → checked');
  eq(by('marital_status').value, 'opt-yes', 'Married → YES');
  eq(by('ppp').value, 'opt-non', 'No PPP → the Non option');
  eq(by('ppp_type_term').value, 'No PPP', 'the PPP text says it once');
  eq(by('co_borrower_flag').value, 'opt-no', 'a KNOWN-none co-borrower writes NO');
  eq(by('fico').value, '787', 'FICO comes from the LIVE VASUMM.X23, not the mirror');
  eq(by('ys_loan_number').value, 'YSCAP258134741', 'the YS loan number writes');
  eq(by('portal_file_id').value, 'lt-loan-uuid-1', 'the portal stamp rides the field set');
  eq(by('term').value, 'opt-30-year', '360 months → 30 year');
  eq(by('lender').value, 'opt-deephaven', 'VEND.X263 Deephaven Mortgage → the Deephaven option');
  eq(by('processor'), undefined, 'processor with no ClickUp id → users field omitted…');
  eq(by('processor_email'), undefined, '…AND the email dropped with it (BOTH-or-NEITHER)');
  eq(by('date_submitted') && T.fromEpochMs(by('date_submitted').value), '2026-07-01', 'field 745 writes as its day');
  eq(by('actual_closing') && T.fromEpochMs(by('actual_closing').value), '2026-08-23', 'CX.FUNDEDDATE writes as its day');
  eq(by('subject_rental').value, '15286.6', 'the rental income parses the comma money');

  const bwBag = { ...birchBag,
    loan: { ...birchBag.loan, loan_number: 'YSCAP258134742', borrower_name: 'C Polatsek',
      loan_purpose: 'Purchase', vesting_type: 'Officer', vesting_entity_name: '400 Birchwood LLC', prepayment_penalty_months: 12 },
    prop: { ...birchBag.prop, purchase_price: '580000' },
    ex: EX_BIRCHWOOD,
    processor: { name: 'Sarah', email: 'sarah@yscapgroup.com', clickupUserId: 87335667 },
  };
  const bw = mapper.buildTaskFields(bwBag, options);
  const by2 = (key) => bw.find((f) => f.key === key);
  eq(by2('purchase_or_estimate').value, '580000', 'purchase → field 136 (the contract price), always');
  eq(by2('llc_name').value, '400 Birchwood LLC', 'an Officer vesting writes the entity name');
  eq(by2('vesting').value, 'opt-llc-corp', 'Officer → LLC / Corp');
  eq(by2('year_purchased'), undefined, 'Year Purchased (refi only) is silent on a purchase');
  eq(by2('date_acquired'), undefined, "CX.DATEACQUIRED '//' (unreached) writes nothing");
  eq(by2('ppp').value, 'opt-1-years', '1 Year → 1 Years');
  eq(by2('ppp_type_term').value, '1 Year — 5% Fixed', 'the PPP text joins term + type');
  ok(by2('processor') && by2('processor_email'), 'a fully-resolved processor writes BOTH fields');

  console.log('F. fieldValueEquivalent + the DOB detector');
  eq(mapper.fieldValueEquivalent(CU.expectedClosing, String(epoch - 3600000), T.dateOnlyToClickUpEpoch('2026-08-14'), options), true,
    'dates compare by CALENDAR DAY, not epoch');
  eq(mapper.fieldValueEquivalent(CU.loanAmount, '157500.00', '157500', options), true, 'numbers compare numerically');
  eq(mapper.fieldValueEquivalent(CU.channel, 0, 'opt-non-del-correspondent', options), true,
    'a dropdown READ (orderindex 0) equals the UUID we would write');
  eq(mapper.fieldValueEquivalent(CU.channel, 1, 'opt-non-del-correspondent', options), false,
    'a different orderindex is a real change');
  eq(mapper.fieldValueEquivalent(CU.loanOfficer, [{ id: 120151948 }], { add: [120151948] }, options), true,
    'a users add of an already-assigned id is a no-op');
  eq(mapper.fieldValueEquivalent(CU.borrowerEmail, 'Joe@Gmail.com', 'joe@gmail.com', options), true,
    'emails compare case-insensitively');
  eq(mapper.fieldValueEquivalent(CU.borrowerSSN, '123-45-6789', '123456789'.replace(/(\d{3})(\d{2})(\d{4})/, '$1-$2-$3'), options), true,
    'SSNs compare digits-only');
  eq(mapper.fieldValueEquivalent(CU.borrowerCell, '(347) 907-0483', '+13479070483', options), true,
    'phones compare by last 10 digits');
  eq(mapper.fieldValueEquivalent(CU.borrowerName, 'Issac Grunzweig', 'Issac Michael Grunzweig', options), true,
    'a middle name ADDED is the same person, not an overwrite');
  eq(mapper.fieldValueEquivalent(CU.borrowerName, 'Issac Grunzweig', 'Moshe Klein', options), false,
    'a different person is never equivalent');
  eq(mapper.fieldValueEquivalent(CU.borrowerName, 'Issac Grunzweig', 'Issac Michael Grunzweig', options, { approvedReview: true }), false,
    'an approved review compares STRICTLY so the human-approved value writes');
  eq(mapper.fieldValueEquivalent(CU.loanAmount, undefined, '100', options), false, 'unknown before → write');
  eq(mapper.isDobChange(CU.borrowerDOB, String(T.dateOnlyToClickUpEpoch('1985-05-14')), T.dateOnlyToClickUpEpoch('1985-05-15')), true,
    'a DOB day change is detected');
  eq(mapper.isDobChange(CU.borrowerDOB, null, T.dateOnlyToClickUpEpoch('1985-05-15')), false,
    'filling a BLANK DOB is not a change');

  console.log('G. resolveOnly / shield shape / providerTextSafe');
  const ids = mapper.resolveOnly(['portal_stamp']);
  ok(ids.has(CU.portalFileId) && ids.has(CU.portalFileLink) && ids.size === 2,
    "'portal_stamp' resolves to exactly the two stamp fields");
  ok(mapper.resolveOnly(['processor']).has(CU.processorEmail), "'processor' carries BOTH processor fields");
  ok(mapper.PII_OVERWRITE_SHIELD[CU.borrowerSSN] && mapper.PII_OVERWRITE_SHIELD[CU.borrowerName],
    'the shield covers the identity fields');
  ok(!mapper.PII_OVERWRITE_SHIELD[CU.borrowerDOB], 'DOB is NOT in the shield — it has its own stricter gate');
  eq(mapper.PII_REVIEW_KEY[CU.borrowerSSN], 'ssn', 'the SSN review key re-pushes scoped');
  eq(mapper.reviewPreview(CU.borrowerSSN, '123-45-6789'), '✱✱✱-✱✱-6789', 'a review preview masks the SSN');
  const push = require('../src/longterm/clickup/push');
  const PI = push._internals;
  eq(PI.providerTextSafe('363 Birch Dr, Cresco, PA 18326', '363 Birch Dr, Cresco, PA 18326-7761'), true,
    'a provider restyle keeping house number + ZIP is safe');
  eq(PI.providerTextSafe('1727 S 2nd St, Piscataway, NJ 08854', '2nd St, Piscataway, NJ 07063'), false,
    'the Piscataway corruption (house number dropped) is refused');
  eq(PI.providerTextSafe('1727 S 2nd St, Piscataway, NJ 08854', '1727 S 2nd St, Plainfield, NJ 07063'), false,
    'a contradicted ZIP is refused (the Plainfield case)');

  console.log('G2. the status engine (pure)');
  const SE = require('../src/longterm/clickup/status-engine');
  // The REAL tenant ladder (live read, 2026-08-24) as a fixture.
  const LADDER_NAMES = ['Started', 'LO Prep', 'Loan Setup', 'Submittal', 'Cond. Approval', 'Waiting for Docs',
    'Processing', 'Resubmittal', 'Clear To Close', 'Schedule Closing', 'Ready for Docs', 'Docs Out',
    'Wire Order', 'Funding', 'Investor Delivery', 'Purchasing Conditions', 'Final Docs', 'Completion'];
  const ladderDoneThrough = (name) => {
    const at = LADDER_NAMES.indexOf(name);
    return LADDER_NAMES.map((n, i) => ({ milestone_name: n, position: i + 1, done: i <= at }));
  };
  const st = (args) => SE.desiredStatus(args).status;
  eq(st({ ladder: ladderDoneThrough('Started') }), 'starting', 'Started done → starting');
  eq(st({ ladder: ladderDoneThrough('LO Prep') }), 'assigned to processor', 'LO Prep done → assigned to processor');
  eq(st({ ladder: ladderDoneThrough('Loan Setup') }), 'assigned to processor',
    'Loan Setup (unmapped) inherits the last mapped milestone');
  eq(st({ ladder: ladderDoneThrough('Submittal'), channelLabel: 'Non Del Correspondent' }), 'non del imported ba(2-em)',
    'Submittal done on a NON-DEL file → non del imported ba');
  eq(st({ ladder: ladderDoneThrough('Submittal'), channelLabel: 'Table funding' }), 'non del imported ba(2-em)',
    'Submittal done on a TABLE-FUNDED file → non del imported ba (owner rule)');
  eq(st({ ladder: ladderDoneThrough('Submittal'), channelLabel: 'Wholesale' }), 'non del imported ba(2-em)',
    'Submittal done on a BROKERED file → non del imported ba');
  eq(st({ ladder: ladderDoneThrough('Submittal'), channelLabel: 'Delegate Correspondent' }), 'delegated initial',
    'Submittal done on a DELEGATE file → delegated initial');
  eq(st({ ladder: ladderDoneThrough('Submittal'), channelLabel: 'Evolve Underwriting' }), 'delegated initial',
    'Submittal done on an EVOLVE file → delegated initial');
  eq(st({ ladder: ladderDoneThrough('Cond. Approval') }), 'workflow', 'Cond. Approval done → workflow');
  eq(st({ ladder: ladderDoneThrough('Clear To Close') }), 'ctc (4-email)', 'Clear To Close done → ctc');
  eq(st({ ladder: ladderDoneThrough('Schedule Closing') }), 'scheduling closing', 'Schedule Closing done → scheduling closing');
  eq(st({ ladder: ladderDoneThrough('Ready for Docs') }), 'active closing', 'Ready for Docs done → active closing');
  eq(st({ ladder: ladderDoneThrough('Funding') }), 'closed (6-email funded)', 'Funding done → closed');
  eq(st({ ladder: ladderDoneThrough('Investor Delivery') }), 'in purchase review', 'Investor Delivery done → in purchase review');
  eq(st({ ladder: ladderDoneThrough('Purchasing Conditions') }), 'pa issued-post closing.',
    'Purchased done → PA issued post closing (the trailing period is real)');
  eq(st({ ladder: ladderDoneThrough('Final Docs') }), 'closed reconciled', 'Final Docs done → closed reconciled');
  eq(st({ ladder: ladderDoneThrough('Completion') }), 'closed reconciled', 'Completion adds nothing past Final Docs');
  eq(st({ ladder: ladderDoneThrough('Funding'), f1393: 'Application withdrawn' }), 'cancelled',
    '1393 withdrawn outranks the ladder → cancelled');
  eq(st({ ladder: ladderDoneThrough('Funding'), f1393: 'Application denied' }), 'cancelled', '1393 denied → cancelled');
  eq(st({ ladder: ladderDoneThrough('Cond. Approval'), folder: 'Withdrawn files' }), 'cancelled',
    'the Withdrawn files folder → cancelled');
  eq(st({ ladder: ladderDoneThrough('Cond. Approval'), folder: 'On Hold' }), 'inactive / on hold',
    'the On Hold folder → inactive / on hold');
  eq(st({ ladder: ladderDoneThrough('Cond. Approval'), folder: 'Pipeline' }), 'workflow',
    'back OUT of the hold folder → the ladder answer again (workflow — Encompass wins)');
  eq(st({ ladder: [] }), null, 'no ladder read yet → the engine claims NOTHING');
  eq(st({ ladder: ladderDoneThrough('Funding'), f1393: 'Loan Originated' }), 'closed (6-email funded)',
    "1393 'Loan Originated' is not a cancellation");

  console.log('Q. audit 2026-08-24 — ANSWERED beats UNREAD (the channel default, both sides)');
  const chan = mapper.FIELD_MAP.find((f) => f.key === 'channel');
  eq(chan.src({ ex: { 'CX.TABLEFUNDER': 'Table Funding' } }), 'Table funding', 'an ANSWERED channel maps');
  eq(chan.src({ ex: { 'CX.TABLEFUNDER': '' } }), 'Non Del Correspondent',
    "an ANSWERED BLANK takes the owner's default (the key is present)");
  eq(chan.src({ ex: {} }), null, 'an UNREAD channel (an outage collapses to {} — no key) claims NOTHING');
  eq(chan.src({}), null, '…and with no ex at all, still nothing');
  eq(chan.src({ ex: {}, investorChannel: 'Table Funding' }), 'Table funding',
    '…unless the MIRROR holds a channel, which maps normally');
  eq(st({ ladder: ladderDoneThrough('Submittal'), channelLabel: null }), null,
    'Submittal done + an UNREADABLE channel → the engine asserts NO status (never the non-del default)');
  eq(st({ ladder: ladderDoneThrough('Submittal'), channelLabel: 'Non Del Correspondent' }), 'non del imported ba(2-em)',
    '…while an answered-blank default forks normally');
  eq(st({ ladder: ladderDoneThrough('Submittal'), channelLabel: 'Delegate Correspondent' }), 'delegated initial',
    '…and a delegate channel forks the other way');
}

// ── the DB half ──────────────────────────────────────────────────────────────
async function dbHalf() {
  process.env.LT_CLICKUP_WRITE_ENABLED = '1';
  delete process.env.LT_CLICKUP_WRITE_DRYRUN;
  process.env.LT_CLICKUP_CREATE_SINCE = '2026-01-01';

  // Stub the WIRE and the GEOCODER wholesale before push.js loads.
  const writerPath = path.resolve(__dirname, '../src/longterm/clickup/writer-client.js');
  const canonPath = path.resolve(__dirname, '../src/lib/address-canon.js');
  const encPath = path.resolve(__dirname, '../src/longterm/encompass/client.js');

  const realWriter = require(writerPath);   // keep the REAL guards on the stub's writes
  const wire = { setField: [], createTask: [], getTask: 0, updateTask: [] };
  let createSeq = 8;   // the suite's first real create stays 'newtask9'
  let LIST_STATUSES = ['starting', 'assigned to processor', 'workflow', 'delegated initial',
    'non del imported ba(2-em)', 'ctc (4-email)', 'scheduling closing', 'active closing',
    'closed (6-email funded)', 'in purchase review', 'pa issued-post closing.', 'closed reconciled',
    'cancelled', 'inactive / on hold'];
  let fakeTask;
  let fakeTasksById = null;          // per-task cards for the multi-loan pass tests
  let taskFailNext = false;
  let failFieldIds = new Set();
  const writerStub = {
    configured: () => true,
    teamId: () => '9011888435',
    getTask: async (taskId) => {
      wire.getTask++;
      if (taskFailNext) { const e = new Error('ClickUp GET /task -> 502'); e.status = 502; e.retryable = true; throw e; }
      if (fakeTasksById && fakeTasksById[String(taskId)]) return fakeTasksById[String(taskId)];
      return fakeTask;
    },
    setField: async (taskId, fieldId, value) => {
      realWriter.guardNoFieldClearing(fieldId, value);          // the real chokepoint still bites
      if (failFieldIds.has(fieldId)) { const e = new Error(`ClickUp POST /task/${taskId}/field/x -> 500`); e.status = 500; e.retryable = true; throw e; }
      wire.setField.push({ taskId, fieldId, value });
      return {};
    },
    createTask: async (listId, payload) => {
      wire.createTask.push({ listId, payload });
      // Unique per create — two loans can never share one card (the DB's own
      // one-card-one-loan index would refuse the second link).
      const id = `newtask${++createSeq}`;
      return { id, url: `https://app.clickup.com/t/${id}`, custom_id: 'FILLE-9999' };
    },
    getFolderLists: async () => ({ lists: [{ id: 'list-77', name: 'Loan Pipeline' }] }),
    getList: async () => ({ statuses: LIST_STATUSES.map((s) => ({ status: s })) }),
    updateTask: async (taskId, payload) => {
      realWriter.guardTaskUpdatePayload(payload);              // the real status-only allowlist still bites
      wire.updateTask.push({ taskId, payload });
      return {};
    },
    getTeams: async () => ({ teams: [] }),
    getListFields: async () => ({ fields: [] }),
    guardNoFieldClearing: realWriter.guardNoFieldClearing,
  };
  require.cache[writerPath] = { id: writerPath, filename: writerPath, loaded: true, exports: writerStub };
  require.cache[canonPath] = { id: canonPath, filename: canonPath, loaded: true, exports: {
    geocode: async (t) => ({ lat: 41.09, lng: -75.26, formatted: t }),
  } };
  let exLive = {};
  let encFail = false;               // simulate an Encompass outage (defect 1)
  require.cache[encPath] = { id: encPath, filename: encPath, loaded: true, exports: {
    configured: () => true,
    fieldReaderSplit: async () => { if (encFail) throw new Error('Encompass unreachable (test outage)'); return { ...exLive }; },
    fieldReader: async () => { if (encFail) throw new Error('Encompass unreachable (test outage)'); return { ...exLive }; },
  } };

  const mapper = require('../src/longterm/clickup/mapper');
  const T = require('../src/longterm/clickup/transforms');
  const CU = mapper.CU;
  // Section G loaded push.js (and its registry) against the REAL clients —
  // evict both so this require binds the stubs above.
  delete require.cache[path.resolve(__dirname, '../src/longterm/clickup/push.js')];
  delete require.cache[path.resolve(__dirname, '../src/longterm/clickup/registry.js')];
  const push = require('../src/longterm/clickup/push');
  const db = require('../src/longterm/db');
  push._internals._resetBreaker();

  const options = optionsFor(mapper);
  const mkCustomFields = (values = {}) => {
    // Every mapped field present (as a live card would have), with options on
    // the dropdowns; `values` overlays field values by CU key name.
    return Object.entries(CU).map(([k, id]) => ({
      id,
      value: Object.prototype.hasOwnProperty.call(values, k) ? values[k] : null,
      type_config: options[id] ? { options: options[id] } : {},
    }));
  };

  // Seed a loan + property + contacts.
  const { rows: made } = await db.query(
    `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_name, loan_amount, loan_purpose,
                           program_name, vesting_type, term_months, encompass_synced_at, created_at)
     VALUES (gen_random_uuid(), 'test-writer-' || gen_random_uuid(), 'TESTWR1', 'Joseph Parnes', 157500,
             'cash_out_refinance', 'Investor DSCR 30 YEAR FRM', 'Individual', 360, now(), '2026-08-20')
     RETURNING id`);
  const loanId = made[0].id;
  await db.query(`INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, estimated_value, appraised_value)
                  VALUES ($1::uuid, '363 BIRCH DR', 'CRESCO', 'PA', '18326', 1, 300000, 450000)`, [loanId]);
  await db.query(`INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, encompass_email)
                  VALUES (gen_random_uuid(), $1::uuid, 'loan_officer', 'Yehuda Bochner', 'yehuda@yscapgroup.com')`, [loanId]);

  try {
    console.log('H. pushLoan end to end (stubbed wire)');
    await db.query(`UPDATE lt_loans SET clickup_task_id = 'task1', clickup_linked_at = now(),
                    clickup_link_source = 'reconciliation', clickup_link_confidence = 'confirmed' WHERE id = $1::uuid`, [loanId]);
    exLive = { ...EX_BIRCH };
    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 2 /* Non-QM - DSCR Ratio */ }) };
    let out = await push.pushLoan(loanId, { source: 'full_repush' });
    eq(out.ok, true, 'the push completes');
    ok(out.wrote >= 15, `a first push lands the mapped fields (${out.wrote} written)`);
    const ssnWrite = wire.setField.find((w) => w.fieldId === CU.borrowerSSN);
    eq(ssnWrite && ssnWrite.value, '123-45-6789', 'the REAL Social reached the card (pass-through, dashed)');
    const { rows: jrows } = await db.query(
      `SELECT * FROM lt_clickup_write_log WHERE lt_loan_id = $1::uuid AND field_id = $2`, [loanId, CU.borrowerSSN]);
    eq(jrows.length, 1, 'the SSN write is journaled…');
    eq(JSON.parse(JSON.stringify(jrows[0].new_value)), '✱✱✱-✱✱-6789', '…MASKED — a readable Social never lands in the journal');
    const { rows: stamped } = await db.query('SELECT clickup_pushed_at FROM lt_loans WHERE id = $1::uuid', [loanId]);
    ok(stamped[0].clickup_pushed_at, 'a clean push stamps clickup_pushed_at');

    // No-op suppression: run again with the card now HOLDING what we wrote.
    const wroteByField = new Map(wire.setField.map((w) => [w.fieldId, w.value]));
    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 2 }).map((cf) => {
      if (!wroteByField.has(cf.id)) return cf;
      let v = wroteByField.get(cf.id);
      if (options[cf.id]) v = options[cf.id].findIndex((o) => o.id === v);      // dropdowns read back as orderindex
      else if (v && typeof v === 'object' && Array.isArray(v.add)) v = v.add.map((id) => ({ id }));
      return { ...cf, value: v };
    }) };
    wire.setField.length = 0;
    out = await push.pushLoan(loanId, { source: 'full_repush' });
    eq(wire.setField.length, 0, 'a second push of the SAME values writes NOTHING (no-op suppression)');
    ok(out.suppressed >= 15, `…every field suppressed as equivalent (${out.suppressed})`);

    push._internals._resetBreaker();
    console.log('I. the PII overwrite shield');
    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 2, borrowerName: 'A Different Human' }) };
    wire.setField.length = 0;
    out = await push.pushLoan(loanId, { source: 'full_repush' });
    ok(!wire.setField.some((w) => w.fieldId === CU.borrowerName),
      'a DIFFERING borrower name is NOT rewritten (fill-only shield)');
    const { rows: rev } = await db.query(
      `SELECT * FROM lt_clickup_review_queue WHERE lt_loan_id = $1::uuid AND field_key = 'borrower_name' AND status = 'open'`, [loanId]);
    eq(rev.length, 1, 'the blocked overwrite queued ONE review row');
    eq(rev[0].reason, 'pii_overwrite_blocked', '…with the pii_overwrite_blocked reason');
    await push.pushLoan(loanId, { source: 'full_repush' });
    const { rows: rev2 } = await db.query(
      `SELECT count(*)::int AS n FROM lt_clickup_review_queue WHERE lt_loan_id = $1::uuid AND field_key = 'borrower_name' AND status = 'open'`, [loanId]);
    eq(rev2[0].n, 1, 'a retried pass DEDUPES — still one open row');
    const { rows: blockedJ } = await db.query(
      `SELECT count(*)::int AS n FROM lt_clickup_write_log WHERE lt_loan_id = $1::uuid AND field_id = $2 AND blocked = true`, [loanId, CU.borrowerName]);
    ok(blockedJ[0].n >= 1, 'the blocked write is journaled blocked=true');

    push._internals._resetBreaker();
    console.log('J. the DOB gate');
    exLive = { ...EX_BIRCH, 1402: '05/15/1985' };   // Encompass moved the DOB a day
    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 2, borrowerDOB: String(T.dateOnlyToClickUpEpoch('1985-05-14')) }) };
    wire.setField.length = 0;
    await push.pushLoan(loanId, { source: 'full_repush' });
    ok(!wire.setField.some((w) => w.fieldId === CU.borrowerDOB), 'a DOB CHANGE is blocked — a human decision');
    const { rows: dobRev } = await db.query(
      `SELECT count(*)::int AS n FROM lt_clickup_review_queue WHERE lt_loan_id = $1::uuid AND field_key = 'date_of_birth' AND status = 'open'`, [loanId]);
    eq(dobRev[0].n, 1, '…and queued for review');
    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 2 }) };   // DOB blank on the card
    wire.setField.length = 0;
    await push.pushLoan(loanId, { source: 'full_repush' });
    ok(wire.setField.some((w) => w.fieldId === CU.borrowerDOB), 'filling a BLANK DOB is allowed');

    push._internals._resetBreaker();
    console.log('K. locations fill-only + fillOnly mode');
    exLive = { ...EX_BIRCH };
    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 2,
      subjectAddress: { location: { lat: 1, lng: 2 }, formatted_address: 'Somewhere the officer typed' } }) };
    wire.setField.length = 0;
    await push.pushLoan(loanId, { source: 'full_repush' });
    ok(!wire.setField.some((w) => w.fieldId === CU.subjectAddress),
      'an OCCUPIED location is never rewritten (fill-only posture)');
    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 2 }) };
    wire.setField.length = 0;
    await push.pushLoan(loanId, { source: 'full_repush' });
    const locWrite = wire.setField.find((w) => w.fieldId === CU.subjectAddress);
    ok(locWrite && locWrite.value && locWrite.value.location, 'a BLANK location is filled, with real coordinates');
    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 2, loanAmount: '1' }) };
    wire.setField.length = 0;
    await push.pushLoan(loanId, { source: 'full_repush', fillOnly: true });
    ok(!wire.setField.some((w) => w.fieldId === CU.loanAmount),
      'fillOnly: an occupied ordinary field is left alone');

    push._internals._resetBreaker();
    console.log('L. fail-closed / never-create / short-term / breaker / lossy');
    taskFailNext = true;
    let threw = null;
    try { await push.pushLoan(loanId, { source: 'scoped_push', only: ['loan_amount'] }); } catch (e) { threw = e; }
    taskFailNext = false;
    eq(threw && threw.code, 'CLICKUP_PREREAD_FAILED', 'a failed pre-read FAILS CLOSED (retryable, nothing written)');
    eq(threw && threw.retryable, true, '…and is retryable for the next pass');

    const { rows: made2 } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_name, encompass_synced_at)
       VALUES (gen_random_uuid(), 'test-writer2-' || gen_random_uuid(), 'TESTWR2', 'Nobody Linked', now()) RETURNING id`);
    const unlinkedId = made2[0].id;
    wire.createTask.length = 0;
    const scoped = await push.pushLoan(unlinkedId, { only: ['loan_amount'], source: 'scoped_push' });
    eq(scoped.skipped, 'unlinked', 'an UNLINKED loan skips…');
    eq(wire.createTask.length, 0, '…and a scoped push NEVER creates a card (G16)');

    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 0 /* Fix & Flip With Construction */ }) };
    const st = await push.pushLoan(loanId, { source: 'full_repush' });
    eq(st.skipped, 'short_term_card', 'a card whose *Program reads short-term REFUSES the whole push');

    push._internals._seedWrites(new Array(300).fill(Date.now()));
    threw = null;
    try { await push.pushLoan(loanId, { source: 'full_repush' }); } catch (e) { threw = e; }
    eq(threw && threw.code, 'CLICKUP_CIRCUIT_OPEN', 'the breaker opens at the cap — every push refuses');
    push._internals._unseed();
    await push._internals.seedBreakerFromDb();
    ok(push._internals._windowSize() > 0,
      'the BOOT SEED primes the window from the journal — a restart mid-storm cannot reset the budget');
    push._internals._resetBreaker();

    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 2 }) };
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    failFieldIds = new Set([CU.loanAmount]);
    threw = null;
    try { await push.pushLoan(loanId, { source: 'full_repush' }); } catch (e) { threw = e; }
    failFieldIds = new Set();
    eq(threw && threw.code, 'CLICKUP_FIELD_WRITES_FAILED', 'a push with a failed write THROWS…');
    const { rows: notDone } = await db.query('SELECT clickup_pushed_at FROM lt_loans WHERE id = $1::uuid', [loanId]);
    eq(notDone[0].clickup_pushed_at, null, '…and is NEVER marked done (G23)');

    push._internals._resetBreaker();
    console.log('M. createForLoan — the card is born linked + stamped');
    const { rows: made3 } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_name, loan_purpose, program_name,
                             vesting_type, term_months, encompass_synced_at, created_at)
       VALUES (gen_random_uuid(), 'test-writer3-' || gen_random_uuid(), 'TESTWR3', 'Chana Newfile',
               'purchase', 'Investor DSCR 30 YEAR FRM', 'Officer', 360, now(), now()) RETURNING id`);
    const newId = made3[0].id;
    await db.query(`INSERT INTO lt_properties (loan_id, street, city, state, zip, purchase_price)
                    VALUES ($1::uuid, '400 BIRCHWOOD RD', 'LINDEN', 'NJ', '07036', 580000)`, [newId]);
    await db.query(`INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, encompass_email)
                    VALUES (gen_random_uuid(), $1::uuid, 'loan_officer', 'Yehuda Bochner', 'yehuda@yscapgroup.com')`, [newId]);
    exLive = { ...EX_BIRCHWOOD };
    wire.createTask.length = 0;
    const created = await push.createForLoan(newId);
    eq(created.created, true, 'the card is created');
    eq(created.linked, true, '…and linked race-safe');
    eq(wire.createTask[0].listId, 'list-77', "…in the officer folder's first list");
    const payload = wire.createTask[0].payload;
    eq(payload.name, 'Chana Newfile - 400 BIRCHWOOD RD, LINDEN', 'the card name is "<borrower> - <address>"');
    ok(payload.status === undefined, 'no status is passed — the list opens the card at its first status (starting)');
    const stampCf = payload.custom_fields.find((f) => f.id === CU.portalFileId);
    eq(stampCf && stampCf.value, newId, 'the ysportal stamp rides the CREATE payload — the card is born bound');
    ok(payload.custom_fields.some((f) => f.id === CU.llcName && f.value === undefined) === false, 'no undefined values in the payload');
    const { rows: linkRow } = await db.query('SELECT * FROM lt_loans WHERE id = $1::uuid', [newId]);
    eq(linkRow[0].clickup_task_id, 'newtask9', 'the loan row holds the new card');
    eq(linkRow[0].clickup_link_source, 'created', "link_source 'created'");
    eq(linkRow[0].clickup_link_confidence, 'confirmed', 'a created link is confirmed');
    ok(linkRow[0].clickup_stamped_at, 'the stamp time is recorded (stamps rode the create)');
    const { rows: trail } = await db.query(
      `SELECT * FROM lt_clickup_link_log WHERE lt_loan_id = $1::uuid AND action = 'created'`, [newId]);
    eq(trail.length, 1, "the trail records action='created'");
    const { rows: createJ } = await db.query(
      `SELECT count(*)::int AS n FROM lt_clickup_write_log WHERE lt_loan_id = $1::uuid AND source = 'create'`, [newId]);
    ok(createJ[0].n >= 10, `every created field is journaled source='create' (${createJ[0].n})`);

    // A loan whose officer nobody can place is REPORTED, never guessed into a folder.
    const { rows: made4 } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_name, encompass_synced_at, created_at)
       VALUES (gen_random_uuid(), 'test-writer4-' || gen_random_uuid(), 'TESTWR4', 'No Officer', now(), now()) RETURNING id`);
    const nofolder = await push.createForLoan(made4[0].id);
    eq(nofolder.skipped, 'no_officer_folder', 'no officer folder ⇒ DO NOT CREATE, reported');

    push._internals._resetBreaker();
    console.log('N. the passes + the switch');
    const { rows: made5 } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_name, encompass_synced_at, created_at)
       VALUES (gen_random_uuid(), 'test-writer5-' || gen_random_uuid(), 'TESTWR5', 'Old Backbook', now(), '2025-01-01') RETURNING id`);
    process.env.LT_CLICKUP_CREATE_SINCE = '2026-01-01';
    const cp = await push.createPass({ limit: 50 });
    ok(!(cp.skipped === 'off'), 'createPass runs with the switch on');
    const { rows: oldRow } = await db.query('SELECT clickup_task_id FROM lt_loans WHERE id = $1::uuid', [made5[0].id]);
    eq(oldRow[0].clickup_task_id, null,
      'a BACK-BOOK loan (discovered before the go-live day) never gains a card from the create pass');

    delete process.env.LT_CLICKUP_WRITE_ENABLED;
    const offPush = await push.pushLoan(loanId, {});
    eq(offPush.skipped, 'off', 'with the switch blank the push stands down (blank = OFF)');
    const offPass = await push.pushPass({});
    eq(offPass.skipped, 'off', '…and the pass stands down');
    process.env.LT_CLICKUP_WRITE_ENABLED = '1';

    process.env.LT_CLICKUP_WRITE_DRYRUN = '1';
    fakeTask = { id: 'task1', custom_fields: mkCustomFields({ program: 2 }) };
    wire.setField.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    const dry = await push.pushLoan(loanId, { source: 'full_repush' });
    eq(wire.setField.length, 0, 'DRYRUN sends NOTHING — even with the write switch on');
    ok(dry.plan.length > 0, '…but reports the exact plan');
    const { rows: dryStamp } = await db.query('SELECT clickup_pushed_at FROM lt_loans WHERE id = $1::uuid', [loanId]);
    eq(dryStamp[0].clickup_pushed_at, null, 'a dry run never stamps — the drain keeps offering the loan');
    delete process.env.LT_CLICKUP_WRITE_DRYRUN;

    push._internals._resetBreaker();
    console.log('O. the status engine ENFORCES — Encompass always wins');
    // Give the loan a ladder: everything done through Cond. Approval.
    const L18 = ['Started', 'LO Prep', 'Loan Setup', 'Submittal', 'Cond. Approval', 'Waiting for Docs',
      'Processing', 'Resubmittal', 'Clear To Close', 'Schedule Closing', 'Ready for Docs', 'Docs Out',
      'Wire Order', 'Funding', 'Investor Delivery', 'Purchasing Conditions', 'Final Docs', 'Completion'];
    for (let i = 0; i < L18.length; i++) {
      await db.query(
        `INSERT INTO lt_loan_milestones (loan_id, milestone_name, position, done)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT (loan_id, milestone_name) DO UPDATE SET position = EXCLUDED.position, done = EXCLUDED.done`,
        [loanId, L18[i], i + 1, i <= 4]);
    }
    // The card was MANUALLY dragged to 'active closing' in ClickUp; the ladder
    // says Cond. Approval → workflow. Encompass wins.
    fakeTask = { id: 'task1', status: { status: 'active closing' }, list: { id: 'list-77' },
      custom_fields: mkCustomFields({ program: 2 }) };
    wire.updateTask.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    let so = await push.pushLoan(loanId, { source: 'full_repush' });
    eq(wire.updateTask.length, 1, 'the manual status change is corrected on the next push');
    eq(wire.updateTask[0].payload.status, 'workflow', "…to the ladder's answer: workflow (Encompass always wins)");
    const { rows: stJ } = await db.query(
      `SELECT * FROM lt_clickup_write_log WHERE lt_loan_id = $1::uuid AND field_key = '__status' AND changed = true ORDER BY id DESC LIMIT 1`, [loanId]);
    eq(JSON.parse(JSON.stringify(stJ[0].old_value)), 'active closing', 'the status change is journaled with the before value');

    // Already right → no write at all.
    fakeTask = { id: 'task1', status: { status: 'workflow' }, list: { id: 'list-77' },
      custom_fields: mkCustomFields({ program: 2 }) };
    wire.updateTask.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    await push.pushLoan(loanId, { source: 'full_repush' });
    eq(wire.updateTask.length, 0, 'a card already at the right status is not touched');

    // A scoped push never moves status.
    fakeTask = { id: 'task1', status: { status: 'active closing' }, list: { id: 'list-77' },
      custom_fields: mkCustomFields({ program: 2 }) };
    wire.updateTask.length = 0;
    await push.pushLoan(loanId, { source: 'scoped_push', only: ['loan_amount'] });
    eq(wire.updateTask.length, 0, 'a SCOPED push (one field) never touches the status');

    // The Submittal fork follows the funding channel.
    for (let i = 0; i < L18.length; i++) {
      await db.query(`UPDATE lt_loan_milestones SET done = $3 WHERE loan_id = $1::uuid AND milestone_name = $2`,
        [loanId, L18[i], i <= 3]);   // done through Submittal
    }
    exLive = { ...EX_BIRCH, 'CX.TABLEFUNDER': 'Delegate correspondent / Evolve' };
    fakeTask = { id: 'task1', status: { status: 'assigned to processor' }, list: { id: 'list-77' },
      custom_fields: mkCustomFields({ program: 2 }) };
    wire.updateTask.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    await push.pushLoan(loanId, { source: 'full_repush' });
    eq(wire.updateTask[0] && wire.updateTask[0].payload.status, 'delegated initial',
      'Submittal on an EVOLVE file lands delegated initial');
    exLive = { ...EX_BIRCH };

    // A status the destination list does not carry is SKIPPED, never invented.
    LIST_STATUSES = ['starting', 'workflow'];
    fakeTask = { id: 'task1', status: { status: 'starting' }, list: { id: 'list-77' },
      custom_fields: mkCustomFields({ program: 2 }) };
    wire.updateTask.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    so = await push.pushLoan(loanId, { source: 'full_repush' });
    eq(wire.updateTask.length, 0, 'a status the list does not carry writes NOTHING…');
    eq(so.statusSkipped && so.statusSkipped.reason, 'status_not_on_list', '…and reports status_not_on_list');
    LIST_STATUSES = ['starting', 'assigned to processor', 'workflow', 'delegated initial',
      'non del imported ba(2-em)', 'ctc (4-email)', 'scheduling closing', 'active closing',
      'closed (6-email funded)', 'in purchase review', 'pa issued-post closing.', 'closed reconciled',
      'cancelled', 'inactive / on hold'];

    // The terminal rules reach the card: a withdrawn 1393 cancels it.
    exLive = { ...EX_BIRCH, 1393: 'Application withdrawn' };
    fakeTask = { id: 'task1', status: { status: 'workflow' }, list: { id: 'list-77' },
      custom_fields: mkCustomFields({ program: 2 }) };
    wire.updateTask.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    await push.pushLoan(loanId, { source: 'full_repush' });
    eq(wire.updateTask[0] && wire.updateTask[0].payload.status, 'cancelled', 'a withdrawn 1393 cancels the card');
    exLive = { ...EX_BIRCH };
    delete process.env.LT_CLICKUP_WRITE_DRYRUN;

    push._internals._resetBreaker();
    console.log('P. the co-borrower SUBTASK');
    const { rows: pairMade } = await db.query(
      `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES (gen_random_uuid(), $1::uuid, 1) RETURNING id`, [loanId]);
    await db.query(
      `INSERT INTO lt_parties (id, pair_id, role, first_name, last_name)
       VALUES (gen_random_uuid(), $1::uuid, 'borrower', 'Joseph', 'Parnes')`, [pairMade[0].id]);
    await db.query(
      `INSERT INTO lt_parties (id, pair_id, role, first_name, last_name, email, mobile_phone, date_of_birth)
       VALUES (gen_random_uuid(), $1::uuid, 'coborrower', 'Rivka', 'Parnes', 'rivka@example.com', '9175551234', '1987-03-02')`,
      [pairMade[0].id]);
    exLive = { ...EX_BIRCH, 97: '456789123', 1268: '' };
    fakeTask = { id: 'task1', status: { status: 'workflow' }, list: { id: 'list-77' },
      subtasks: [], custom_fields: mkCustomFields({ program: 2 }) };
    wire.createTask.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    let co = await push.pushLoan(loanId, { source: 'full_repush' });
    const sub = wire.createTask.find((c) => c.payload && c.payload.parent === 'task1');
    ok(sub, 'a co-borrower with no subtask gets one CREATED under the loan card');
    eq(sub.payload.name, 'Rivka Parnes', '…named for the co-borrower');
    const subSsn = sub.payload.custom_fields.find((f) => f.id === CU.borrowerSSN);
    eq(subSsn && subSsn.value, '456-78-9123', "…carrying the CO-borrower's Social (live field 97), dashed");
    const subEmail = sub.payload.custom_fields.find((f) => f.id === CU.borrowerEmail);
    eq(subEmail && subEmail.value, 'rivka@example.com', '…and her own email from the mirror');
    const parentFlag = wire.setField.find((w) => w.taskId === 'task1' && w.fieldId === CU.coBorrowerFlag);
    ok(parentFlag, 'the PARENT card writes the co-borrower flag…');
    const parentName = wire.setField.find((w) => w.taskId === 'task1' && w.fieldId === CU.coBorrowerName);
    eq(parentName && parentName.value, 'Rivka Parnes', '…and the co-borrower name in the parent (owner rule)');

    // Second push: the subtask exists by name — no duplicate, fields update it.
    fakeTask = { id: 'task1', status: { status: 'workflow' }, list: { id: 'list-77' },
      subtasks: [{ id: 'subtask1', name: 'Rivka Parnes' }], custom_fields: mkCustomFields({ program: 2 }) };
    const realGetTask = writerStub.getTask;
    writerStub.getTask = async (id) => {
      wire.getTask++;
      if (String(id) === 'subtask1') return { id: 'subtask1', custom_fields: mkCustomFields({}) };
      return fakeTask;
    };
    wire.createTask.length = 0; wire.setField.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    co = await push.pushLoan(loanId, { source: 'full_repush' });
    eq(wire.createTask.length, 0, 'a second push never duplicates the subtask (found by name)');
    ok(wire.setField.some((w) => w.taskId === 'subtask1' && w.fieldId === CU.borrowerSSN),
      "…and pushes the co fields onto the EXISTING subtask");
    // The shield holds on the subtask too: a differing co name is never rewritten.
    writerStub.getTask = async (id) => {
      wire.getTask++;
      if (String(id) === 'subtask1') return { id: 'subtask1', custom_fields: mkCustomFields({ borrowerName: 'Somebody Else' }) };
      return fakeTask;
    };
    wire.setField.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    await push.pushLoan(loanId, { source: 'full_repush' });
    ok(!wire.setField.some((w) => w.taskId === 'subtask1' && w.fieldId === CU.borrowerName),
      'the PII shield holds on the subtask — a differing co name is not rewritten');
    writerStub.getTask = realGetTask;
    exLive = { ...EX_BIRCH };

    push._internals._resetBreaker();
    console.log('Q2. audit defect 1 end to end — an Encompass outage never rewrites the channel');
    // The card HOLDS 'Table funding '; Encompass is unreachable (the client
    // throws), so readExtras collapses to {} — the push proceeds mirror-only
    // and the occupied dropdown must be left exactly as it stands.
    encFail = true;
    fakeTasksById = null;
    fakeTask = { id: 'task1', status: { status: 'workflow' }, list: { id: 'list-77' },
      subtasks: [{ id: 'subtask1', name: 'Rivka Parnes' }],
      custom_fields: mkCustomFields({ program: 2, channel: 3 /* Table funding */ }) };
    wire.setField.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    out = await push.pushLoan(loanId, { source: 'full_repush' });
    eq(out.ok, true, 'the outage push still completes (mirror-only)');
    ok(!wire.setField.some((w) => w.fieldId === CU.channel),
      "the occupied '*Wholesale / correspondent' dropdown is NOT rewritten to the default");
    encFail = false;
    // …and the same push against a HEALTHY read (which answers non-del) rewrites
    // it, proving the guard keys on readability, not on the field being skipped.
    wire.setField.length = 0;
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    out = await push.pushLoan(loanId, { source: 'full_repush' });
    ok(wire.setField.some((w) => w.fieldId === CU.channel),
      '…while an ANSWERED channel that differs still writes normally');

    push._internals._resetBreaker();
    console.log('R. audit defects 2+3 — no head-of-line starvation in either pass');
    // Quiet any stray drain rows other suites may have left in this database.
    await db.query(`UPDATE lt_loans SET clickup_pushed_at = now()
                     WHERE loan_number NOT LIKE 'TESTWR%' AND clickup_task_id IS NOT NULL
                       AND (clickup_pushed_at IS NULL OR encompass_synced_at > clickup_pushed_at)`);
    const mkLoan = async (num, name, officer, email, createdAt) => {
      const { rows } = await db.query(
        `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_name, encompass_synced_at, created_at)
         VALUES (gen_random_uuid(), 'test-writer-' || gen_random_uuid(), $1, $2, now(), $3) RETURNING id`,
        [num, name, createdAt]);
      await db.query(`INSERT INTO lt_properties (loan_id, street, city, state, zip) VALUES ($1::uuid, '1 Test St', 'Cresco', 'PA', '18326')`, [rows[0].id]);
      await db.query(`INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, encompass_email)
                      VALUES (gen_random_uuid(), $1::uuid, 'loan_officer', $2, $3)`, [rows[0].id, officer, email]);
      return rows[0].id;
    };
    const oldA = await mkLoan('TESTWR2', 'Old Head One', 'Nobody Nofolder', 'nobody1@nowhere.test', '2026-08-01');
    await mkLoan('TESTWR3', 'Old Head Two', 'Nobody Nofolder', 'nobody2@nowhere.test', '2026-08-02');
    const fresh = await mkLoan('TESTWR4', 'Fresh Creatable', 'Yehuda Bochner', 'yehuda@yscapgroup.com', '2026-08-21');
    process.env.LT_CLICKUP_CREATE_PER_PASS = '1';
    const cp2 = await push.createPass({});
    eq(cp2.created, 1, 'a ONE-create budget still lands a card with two dead heads in front (the scan window)');
    const { rows: freshRow } = await db.query('SELECT clickup_task_id FROM lt_loans WHERE id = $1::uuid', [fresh]);
    ok(freshRow[0].clickup_task_id, '…and it is the FRESH loan that got it, not a wedged head');
    const { rows: headRow } = await db.query('SELECT clickup_push_error FROM lt_loans WHERE id = $1::uuid', [oldA]);
    ok(/no_officer_folder/.test(headRow[0].clickup_push_error || ''),
      'the dead head is STAMPED with its skip reason (it sorts last from now on)');
    delete process.env.LT_CLICKUP_CREATE_PER_PASS;

    // Defect 3: a wedged short-term-linked loan must not starve a healthy refresh.
    const wedged = await mkLoan('TESTWR5', 'Wedged Shortterm', 'Yehuda Bochner', 'yehuda@yscapgroup.com', '2026-08-05');
    await db.query(`UPDATE lt_loans SET clickup_task_id = 'stshort', clickup_link_confidence = 'confirmed',
                    clickup_linked_at = now() WHERE id = $1::uuid`, [wedged]);
    await db.query(`UPDATE lt_loans SET encompass_synced_at = now(), clickup_pushed_at = now() - interval '1 day',
                    clickup_push_error = NULL WHERE id = $1::uuid`, [loanId]);
    fakeTasksById = {
      stshort: { id: 'stshort', custom_fields: mkCustomFields({ program: 0 /* Fix & Flip … — SHORT */ }) },
      task1: { id: 'task1', status: { status: 'workflow' }, list: { id: 'list-77' },
        subtasks: [{ id: 'subtask1', name: 'Rivka Parnes' }], custom_fields: mkCustomFields({ program: 2 }) },
    };
    process.env.LT_CLICKUP_PUSH_PER_PASS = '2';
    let pp2 = await push.pushPass({});
    ok(pp2.problems.some((x) => x.skipped === 'short_term_card'), 'pass 1: the wedged loan is refused (short-term card)…');
    const { rows: wedgeRow } = await db.query('SELECT clickup_push_error FROM lt_loans WHERE id = $1::uuid', [wedged]);
    ok(/short_term_card/.test(wedgeRow[0].clickup_push_error || ''), '…and STAMPED with the refusal');
    const { rows: h1 } = await db.query('SELECT clickup_pushed_at FROM lt_loans WHERE id = $1::uuid', [loanId]);
    ok(h1[0].clickup_pushed_at && (Date.now() - new Date(h1[0].clickup_pushed_at).getTime()) < 60000,
      '…while the healthy loan was refreshed in the SAME pass');
    // The healthy loan needs a refresh again; a ONE-loan budget must now pick
    // IT, not the wedged head (the starvation the audit reproduced).
    await db.query(`UPDATE lt_loans SET encompass_synced_at = now() + interval '1 second' WHERE id = $1::uuid`, [loanId]);
    push._internals._resetBreaker();
    process.env.LT_CLICKUP_PUSH_PER_PASS = '1';
    pp2 = await push.pushPass({});
    const { rows: h2 } = await db.query('SELECT clickup_pushed_at FROM lt_loans WHERE id = $1::uuid', [loanId]);
    ok(new Date(h2[0].clickup_pushed_at) > new Date(h1[0].clickup_pushed_at),
      'pass 2 (budget 1): the HEALTHY loan outranks the stamped head — no starvation');
    delete process.env.LT_CLICKUP_PUSH_PER_PASS;

    push._internals._resetBreaker();
    console.log('S. scoped pushes never stamp; a dry run writes NOTHING; a subtask approve is narrow');
    fakeTasksById = null;
    fakeTask = { id: 'task1', status: { status: 'workflow' }, list: { id: 'list-77' },
      subtasks: [{ id: 'subtask1', name: 'Rivka Parnes' }], custom_fields: mkCustomFields({ program: 2 }) };
    await db.query('UPDATE lt_loans SET clickup_pushed_at = NULL WHERE id = $1::uuid', [loanId]);
    out = await push.pushLoan(loanId, { only: ['ys_loan_number'], source: 'manual' });
    eq(out.ok, true, 'a scoped one-field push completes');
    let { rows: sc } = await db.query('SELECT clickup_pushed_at FROM lt_loans WHERE id = $1::uuid', [loanId]);
    eq(sc[0].clickup_pushed_at, null,
      'a SCOPED push never stamps clickup_pushed_at — the drain still owes the card its full sync (obs 3)');

    // A REHEARSAL writes nothing durable: no journal rows, no review rows.
    await db.query(`DELETE FROM lt_clickup_review_queue WHERE task_id = 'task1'`);
    process.env.LT_CLICKUP_WRITE_DRYRUN = '1';
    fakeTask = { id: 'task1', status: { status: 'workflow' }, list: { id: 'list-77' },
      subtasks: [], custom_fields: mkCustomFields({ program: 2, borrowerName: 'Someone Quitedifferent' }) };
    const { rows: jb } = await db.query(`SELECT count(*)::int AS n FROM lt_clickup_write_log WHERE task_id = 'task1'`);
    out = await push.pushLoan(loanId, { source: 'full_repush' });
    ok(out.plan.some((p) => p.wouldBlock === 'pii_overwrite_blocked'),
      'the dry-run PLAN reports the shielded overwrite it would hold');
    const { rows: rv } = await db.query(`SELECT count(*)::int AS n FROM lt_clickup_review_queue WHERE task_id = 'task1'`);
    eq(rv[0].n, 0, 'a REHEARSAL queues NO real review rows (obs 4)');
    const { rows: ja } = await db.query(`SELECT count(*)::int AS n FROM lt_clickup_write_log WHERE task_id = 'task1'`);
    eq(ja[0].n, jb[0].n, '…and journals nothing');
    delete process.env.LT_CLICKUP_WRITE_DRYRUN;

    // The subtask-scoped approve: EXACTLY the approved key, on the SUBTASK,
    // parent untouched, no stamp, and never a create.
    push._internals._resetBreaker();
    fakeTasksById = {
      task1: { id: 'task1', status: { status: 'workflow' }, list: { id: 'list-77' },
        subtasks: [{ id: 'subtask1', name: 'Rivka Parnes' }], custom_fields: mkCustomFields({ program: 2 }) },
      subtask1: { id: 'subtask1', custom_fields: mkCustomFields({ borrowerName: 'Somebody Else' }) },
    };
    wire.setField.length = 0;
    out = await push.pushLoan(loanId, { subtaskOnly: ['co_name'], approvedReview: true, source: 'review_approval' });
    eq(out.ok, true, 'the subtask-scoped approve completes');
    ok(wire.setField.some((w) => w.taskId === 'subtask1' && w.fieldId === CU.borrowerName),
      'the approved co-borrower name landed on the SUBTASK (the shield stepped aside for exactly it)');
    ok(!wire.setField.some((w) => w.taskId === 'task1'),
      '…and the PARENT card was not touched at all');
    ({ rows: sc } = await db.query('SELECT clickup_pushed_at FROM lt_loans WHERE id = $1::uuid', [loanId]));
    eq(sc[0].clickup_pushed_at, null, '…and no pushed_at stamp landed');
    // Subtask gone → the approve stands down; it NEVER creates one.
    fakeTasksById = null;
    fakeTask = { id: 'task1', status: { status: 'workflow' }, list: { id: 'list-77' },
      subtasks: [], custom_fields: mkCustomFields({ program: 2 }) };
    wire.createTask.length = 0;
    out = await push.pushLoan(loanId, { subtaskOnly: ['co_name'], approvedReview: true, source: 'review_approval' });
    eq(out.subtaskSkipped, 'subtask_missing', 'with the subtask gone the approve reports subtask_missing…');
    eq(wire.createTask.length, 0, '…and a scoped approve NEVER creates a subtask');
  } finally {
    await db.query(`DELETE FROM lt_loans WHERE loan_number LIKE 'TESTWR%'`).catch(() => {});
    await db.query(`DELETE FROM lt_clickup_write_log WHERE task_id IN ('task1','subtask1','stshort') OR task_id LIKE 'newtask%' OR task_id = 'co-subtask'`).catch(() => {});
    await db.query(`DELETE FROM lt_clickup_review_queue WHERE task_id IN ('task1','subtask1','stshort')`).catch(() => {});
  }
}

async function main() {
  await pureHalf();
  if (!process.env.DATABASE_URL) {
    console.log(`\nNo DATABASE_URL — pure half passed (${checks} checks); DB half skipped.`);
    return;
  }
  await dbHalf();
  console.log(`\nAll ${checks} checks passed.`);
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e && (e.stack || e.message)); process.exit(1); });

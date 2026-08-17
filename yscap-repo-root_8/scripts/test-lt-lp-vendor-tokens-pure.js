#!/usr/bin/env node
'use strict';
/**
 * §37.16 — NO INVENTED VENDOR TOKEN CAN REACH THE WIRE (pure, offline, in `npm test`).
 *
 * WHY AN OFFLINE COPY OF THIS CHECK EXISTS. `docs/longterm/ppe-research/token-registry-check.js`
 * compares our tables to Lender Price's live published registry, and it is the authority — but it
 * needs live credentials and a network, so it runs when somebody remembers to run it. Nothing
 * stopped an invented token being added the next day by somebody who never runs it. This suite is
 * that stop: it checks the same thing against the COMMITTED snapshot of the registry
 * (`vendor-token-registry.json`, 75 fields, refreshed with `--snapshot`), on every build, with no
 * credentials.
 *
 * WHAT IT IS PROTECTING AGAINST, measured live rather than assumed (§37.14/§37.15):
 *
 *   A token the vendor does not publish is NOT REFUSED. It answers HTTP 200 and prices as though
 *   the field had never been set.
 *
 *   GLOBAL_RESERVES      real "Reserves_24" -> 394 options / 11 programs
 *                        made-up token      -> 371 / 10          (a lender program silently gone)
 *   MORT30LATESLAST12M   real "4"           ->  14 options /  1 program
 *                        our old "4+"       -> 394 / 11          (worst credit priced as spotless)
 *
 * So a typo here is not a crash and not an error — it is a wrong price, delivered confidently.
 *
 * WHAT THIS SUITE DOES NOT CLAIM. The snapshot is a POINT IN TIME. A green run means "nothing we
 * emit was invented as of the day the snapshot was taken"; it can never notice the vendor adding or
 * retiring a value. Only the live check can, which is why the snapshot header carries its read date
 * and the live tool remains the authority. Both are needed and neither replaces the other.
 *
 * PROVEN TO FAIL: add any value to any of the checked tables that is not in the snapshot and
 * EMIT-* goes red; empty or corrupt the snapshot and SNAPSHOT-* goes red before anything else is
 * reported (a missing snapshot must never read as "everything passed").
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const path = require('path');
const sm = require('../src/longterm/lenderprice/search-model');
const reg = require('../src/longterm/lenderprice/field-registry');
const SNAPSHOT_FILE = path.join(__dirname, '../docs/longterm/ppe-research/vendor-token-registry.json');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

console.log('§37.16 every token we can emit is one the vendor publishes');

// ---- the snapshot must be real before anything is judged against it --------
let snap = null;
try { snap = require(SNAPSHOT_FILE); } catch (e) { snap = null; }
ok(!!(snap && snap.values && typeof snap.values === 'object'),
  'SNAPSHOT-1 the committed vendor registry loads');
if (!snap || !snap.values) {
  console.log('\nFAILURES: the snapshot is missing or unreadable — refresh it with\n' +
    '  node docs/longterm/ppe-research/token-registry-check.js --snapshot');
  process.exit(1);
}
const fields = Object.keys(snap.values).length;
ok(fields >= 70, `SNAPSHOT-2 it carries the vendor's fields (${fields}) — a truncated snapshot must not read as a pass`);
ok(/^\d{4}-\d{2}-\d{2}$/.test(String(snap._readAt || '')),
  `SNAPSHOT-3 it records WHEN it was read (${snap._readAt}) — a point-in-time answer must say its date`);

const published = (p) => new Set(snap.values[p] || []);

// ---- what each table can put ON THE WIRE ----------------------------------
// The VALUES of an alias map ship; the keys are spellings a caller may type. Comparing keys reports
// every deliberate alias as a mismatch — it did, for 8 of 9 families at once, before it was caught.
const strings = (xs) => [...new Set(xs.filter((v) => typeof v === 'string' && v !== ''))];
const emittedBy = (m) => strings(Object.values(m || {}));
const membersOf = (s) => strings([...(s || [])]);

const TABLES = [
  { name: 'reserves',           path: 'GLOBAL_RESERVES',           emit: () => emittedBy(sm._internals.RESERVES_TOKENS) },
  { name: 'late counts',        path: 'MORT30LATESLAST12M',        emit: () => emittedBy(reg._tokens.LATE_COUNT) },
  { name: 'income doc type',    path: 'IncomeDocType',             emit: () => emittedBy(reg.INCOME_DOC_TYPES) },
  { name: 'prepay structure',   path: 'PrePayment_Plan_Type',      emit: () => emittedBy(reg.PREPAY_STRUCTURES) },
  { name: 'borrower type',      path: 'GLOBAL_BorrowerType',       emit: () => membersOf(reg.BORROWER_TYPES) },
  { name: 'citizenship',        path: 'Citizenship',               emit: () => membersOf(reg._tokens.CITIZENSHIP) },
  { name: 'tradelines',         path: 'Tradelines',                emit: () => membersOf(reg._tokens.TRADELINES) },
  { name: 'bankruptcy chapter', path: 'BankruptcyChapter',         emit: () => membersOf(reg._tokens.BK_CHAPTER) },
  { name: 'bankruptcy status',  path: 'BankruptcyStatus',          emit: () => membersOf(reg._tokens.BK_STATUS) },
  { name: 'bankruptcy season',  path: 'BankruptcySeasoning',       emit: () => membersOf(reg._tokens.BK_SEASONING) },
  { name: 'foreclosure',        path: 'Global_FORECLOSURES',       emit: () => membersOf(reg._tokens.FORECLOSURE) },
  { name: 'short sale',         path: 'Global_SHORTSALES',         emit: () => membersOf(reg._tokens.SHORTSALE) },
  { name: 'deed in lieu',       path: 'Global_DEEDINLIEU',         emit: () => membersOf(reg._tokens.DEEDINLIEU) },
  { name: 'forbearance',        path: 'GLOBAL_Forbearances',       emit: () => membersOf(reg._tokens.FORBEARANCE) },
  { name: 'compensation type',  path: 'criteria.compensationType', emit: () => emittedBy(reg._tokens.COMP_TYPE) },
  { name: 'property type',      path: 'property.propertyType',     emit: () => strings(Object.values(reg.PROPERTY_TYPES || {}).map((p) => (p && p.propertyType) || p)) },
  { name: 'attachment type',    path: 'property.attachmentType',   emit: () => strings(sm._internals.ATTACHMENT_TYPES || []) },
  { name: 'loan purpose',       path: 'criteria.loanPurpose',      emit: () => emittedBy(sm._internals.PURPOSE_ALIASES) },
  { name: 'lock days',          path: 'dayLocksCriteria',          emit: () => strings((sm._internals.ALLOWED_LOCKS || []).map(String)) },
];

for (const t of TABLES) {
  const theirs = published(t.path);
  let ours = [];
  try { ours = t.emit(); } catch (e) { ok(false, `EMIT-0 ${t.name}: the table could not be read (${e.message})`); continue; }
  // A table whose path vanished from the snapshot is a REFUSAL to judge, never a silent pass:
  // reporting "0 unpublished values" out of an empty set is the shape that makes a broken check
  // look like a clean one.
  if (!theirs.size) { ok(false, `EMIT-0 ${t.name}: the snapshot publishes nothing for "${t.path}" — cannot judge`); continue; }
  const invented = ours.filter((v) => !theirs.has(v));
  ok(invented.length === 0,
    `EMIT-1 ${t.name}: all ${ours.length} emitted values are published${invented.length ? ` — INVENTED: ${invented.join(' | ')}` : ''}`);
}

// ---- the two tokens tonight's live measurement settled ---------------------
// Named on their own so a regression says WHICH real-world mispricing came back, rather than only
// "some table has an unpublished value".
ok(!emittedBy(reg._tokens.LATE_COUNT).includes('4+'),
  'REGRESS-1 "4+" can no longer ship as a mortgage-late count (it priced as a spotless history)');
ok(emittedBy(reg._tokens.LATE_COUNT).includes('4'),
  'REGRESS-2 the vendor\'s "4" is reachable, so "four or more lates" can still be stated');
for (const t of ['Reserves_9', 'Reserves_36']) {
  ok(emittedBy(sm._internals.RESERVES_TOKENS).includes(t),
    `REGRESS-3 ${t} is reachable (published by the vendor, and missing here until §37.14)`);
}

// ---- the whole request, not only the tables somebody remembered ------------
// The table list above is hand-kept. This walks what buildSearch ACTUALLY emits, so a field nobody
// added to that list is still judged. A path the snapshot does not publish is skipped, not failed —
// free numbers and company-specific fields legitimately have no enum.
const SC = { purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, state: 'NJ', countyFps: '34039', fico: 760,
  reservesMonths: 12, propertyType: 'SingleFamily', borrowerType: 'LLC', citizenship: 'US Citizen',
  incomeDocType: 'DSCR', prepayStructure: 'Standard', prepayMonths: 60, io: true, escrowWaive: true,
  rentalTerm: 'Long Term', attachmentType: 'Detached', tradelines: 'Limited', crossCollateral: true,
  dscrAssetDepletion: true, firstTimeInvestor: true, livingRentFree: true, lateInLast12Months: true,
  mortgageLates: { last12: { 30: '1', 60: '2', 90: '3', 120: '4+' }, months13To24: { 30: '1' } } };
// A boolean is compared as String(v): the registry publishes criteria.interestOnly as "true"/"false"
// while the real frontend capture sends a JSON boolean there and we match it. Judging only strings
// would leave that whole class unchecked.
const scalar = (v) => (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number');
const NOT_AN_ENUM = /(^|\.)(@class|country|county|censustract|city|countyName|street|streetCont|zip|zipExt|name)$/;
const model = sm.buildSearch(SC);
const seen = [];
for (const [k, v] of Object.entries(model.dynamicPropertiesMap || {})) {
  const val = v && typeof v === 'object' ? v.value : v;
  if (scalar(val) && String(val) !== '') seen.push([k, String(val)]);
}
(function walk(node, prefix) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (NOT_AN_ENUM.test(p)) continue;
    if (scalar(v) && String(v) !== '') seen.push([p, String(v)]);
    else if (Array.isArray(v) && v.length && v.every(scalar)) for (const x of v) seen.push([p, String(x)]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
  }
})({ criteria: model.criteria, property: model.property, brokerCriteria: model.brokerCriteria,
     accessCriteria: model.accessCriteria, loanTypeCriteria: model.loanTypeCriteria }, '');

const judged = seen.filter(([p]) => published(p).size);
const wrong = judged.filter(([p, v]) => !published(p).has(v));
ok(judged.length >= 30,
  `SWEEP-1 a real request resolved ${judged.length} fields against the snapshot (a sweep that resolves nothing proves nothing)`);
ok(wrong.length === 0,
  `SWEEP-2 every value that real request emits is published${wrong.length ? ` — INVENTED: ${wrong.map(([p, v]) => `${p}=${v}`).join(', ')}` : ''}`);

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

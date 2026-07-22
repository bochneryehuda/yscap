'use strict';
/**
 * P4 — pure tests for the independent-verification RECONCILER.
 * Proves it compares a DOCUMENT-claimed value against an INDEPENDENT source's
 * value and returns confirmed / conflict / unverifiable per verification type,
 * raising an advisory finding ONLY on a real conflict — and that an unavailable
 * or empty source is UNVERIFIABLE, never a conflict (absence of an outside
 * answer is not a disagreement). Advisory: nothing here changes a decision.
 */
const assert = require('assert');
const rc = require('../src/lib/verification/reconciler');
const { STATUS } = rc;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- NAME / ownership: entity-suffix tolerant equality ---
let r = rc.reconcile({ type: 'name', value: 'ABC LLC', field: 'account_owner' }, { value: 'ABC, L.L.C.', provider: 'plaid' });
assert.strictEqual(r.status, STATUS.CONFIRMED, 'ABC LLC == ABC, L.L.C. after suffix normalization');
assert.ok(!r.finding, 'a confirmation carries no finding');
ok('name match is entity-suffix tolerant (ABC LLC == ABC, L.L.C.)');

r = rc.reconcile({ type: 'name', value: 'ABC Holdings LLC', field: 'account_owner' }, { value: 'XYZ Capital LLC', provider: 'plaid' });
assert.strictEqual(r.status, STATUS.CONFLICT, 'genuinely different owners conflict');
assert.strictEqual(r.finding.code, 'verify_ownership_mismatch');
assert.strictEqual(r.finding.severity, 'fatal');
assert.strictEqual(r.finding.docValue, 'ABC Holdings LLC');
assert.strictEqual(r.finding.sourceValue, 'XYZ Capital LLC');
assert.strictEqual(r.finding.provider, 'plaid');
assert.strictEqual(r.finding.status, 'open');
ok('a different owner name is a FATAL ownership-mismatch finding');

// "Limited Liability Company" spelled out matches "LLC"
r = rc.reconcile({ type: 'name', value: 'Maple Grove Limited Liability Company' }, { value: 'Maple Grove LLC', provider: 'middesk' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '"Limited Liability Company" == "LLC"');
ok('spelled-out "Limited Liability Company" matches "LLC"');

// accents/diacritics fold: the document and the source often spell the same name differently
assert.strictEqual(rc.reconcile({ type: 'name', value: 'Café Holdings LLC' }, { value: 'Cafe Holdings LLC', provider: 'plaid' }).status, STATUS.CONFIRMED, 'Café == Cafe after diacritic fold');
assert.strictEqual(rc.reconcile({ type: 'name', value: 'Peña Capital LLC' }, { value: 'Pena Capital LLC', provider: 'middesk' }).status, STATUS.CONFIRMED, 'Peña == Pena after diacritic fold');
// but genuinely different names still conflict after folding
assert.strictEqual(rc.reconcile({ type: 'name', value: 'Peña Capital LLC' }, { value: 'Perez Capital LLC', provider: 'middesk' }).status, STATUS.CONFLICT, 'accents fold, but a real different name still conflicts');
ok('accented and unaccented spellings of the same name match; real different names still conflict');

// --- AMOUNT: tolerance (a slightly different "as of" day should not false-conflict) ---
r = rc.reconcile({ type: 'amount', value: '42318.55', field: 'ending_balance' }, { value: '42318.90', provider: 'plaid' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '$0.35 apart is within the 1% / $1 tolerance');
ok('amount within tolerance confirms (a small balance drift is not a conflict)');

r = rc.reconcile({ type: 'amount', value: '42318.55', field: 'ending_balance' }, { value: '12000.00', provider: 'plaid' });
assert.strictEqual(r.status, STATUS.CONFLICT, 'a materially different balance conflicts');
assert.strictEqual(r.finding.code, 'verify_amount_mismatch');
assert.strictEqual(r.finding.severity, 'warning');
ok('a materially different amount is a WARNING amount-mismatch finding');

// custom tolerances are honored
r = rc.reconcile({ type: 'amount', value: '100000' }, { value: '104000', provider: 'plaid' }, { pctTolerance: 0.05 });
assert.strictEqual(r.status, STATUS.CONFIRMED, '$4k on $100k is within a 5% custom tolerance');
ok('a custom percent tolerance is honored');

// a non-numeric amount is unverifiable, never a conflict
r = rc.reconcile({ type: 'amount', value: 'n/a' }, { value: '5000', provider: 'plaid' });
assert.strictEqual(r.status, STATUS.UNVERIFIABLE, 'a non-numeric claimed amount cannot be reconciled');
assert.ok(!r.finding);
ok('a non-numeric amount is unverifiable (never a false conflict)');

// --- ENTITY STATUS: source registry must be a good-standing value ---
r = rc.reconcile({ type: 'entity_status', value: 'ABC LLC' }, { value: 'Active', provider: 'middesk' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '"Active" is good standing');
ok('an ACTIVE registry status confirms the entity');

r = rc.reconcile({ type: 'entity_status', value: 'ABC LLC' }, { value: 'Administratively Dissolved', provider: 'middesk' });
assert.strictEqual(r.status, STATUS.CONFLICT, 'a dissolved entity is not in good standing');
assert.strictEqual(r.finding.code, 'verify_entity_not_active');
assert.strictEqual(r.finding.severity, 'fatal');
ok('a dissolved entity is a FATAL not-in-good-standing finding');

r = rc.reconcile({ type: 'entity_status', value: 'ABC LLC' }, { value: 'In Good Standing', provider: 'middesk' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '"In Good Standing" (spaced) normalizes to good standing');
ok('"In Good Standing" normalizes to a good-standing value');

// --- PROPERTY VALUE: AVM within a variance band of the claimed appraisal ---
r = rc.reconcile({ type: 'property_value', value: '500000', field: 'appraised_value' }, { value: '520000', provider: 'attom' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '4% AVM variance is inside the ±10% band');
ok('an AVM within the variance band supports the appraised value');

r = rc.reconcile({ type: 'property_value', value: '500000', field: 'appraised_value' }, { value: '380000', provider: 'attom' });
assert.strictEqual(r.status, STATUS.CONFLICT, '24% under is outside the band');
assert.strictEqual(r.finding.code, 'verify_value_unsupported');
assert.strictEqual(r.finding.severity, 'warning');
ok('an AVM far below the claimed value is a value-unsupported finding');

r = rc.reconcile({ type: 'property_value', value: '500000' }, { value: '470000', provider: 'housecanary' }, { varianceBand: 0.05 });
assert.strictEqual(r.status, STATUS.CONFLICT, '6% variance breaches a tightened 5% band');
ok('a tightened variance band is honored');

// --- EXISTS / boolean ---
r = rc.reconcile({ type: 'exists', value: 'lien' }, { value: true, provider: 'attom' });
assert.strictEqual(r.status, STATUS.CONFIRMED, 'source confirms existence (true)');
r = rc.reconcile({ type: 'exists', value: 'lien' }, { value: 'found', provider: 'attom' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '"found" also confirms existence');
r = rc.reconcile({ type: 'exists', value: 'lien' }, { value: false, provider: 'attom' });
assert.strictEqual(r.status, STATUS.CONFLICT, 'source cannot confirm → conflict');
assert.strictEqual(r.finding.code, 'verify_not_found');
ok('exists/boolean confirms on true/"found" and conflicts on false');

// --- UNVERIFIABLE: no source, unavailable source, empty value ---
assert.strictEqual(rc.reconcile({ type: 'name', value: 'ABC LLC' }, null).status, STATUS.UNVERIFIABLE, 'no source at all');
assert.strictEqual(rc.reconcile({ type: 'name', value: 'ABC LLC' }, { available: false, value: 'ABC LLC', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'source not available/configured');
assert.strictEqual(rc.reconcile({ type: 'name', value: 'ABC LLC' }, { value: '', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'source has no value');
let u = rc.reconcile({ type: 'name', value: 'ABC LLC' }, null);
assert.ok(!u.finding, 'unverifiable never carries a finding');
ok('an unavailable / empty / missing source is UNVERIFIABLE, never a conflict');

// an unknown verification type is unverifiable, not a crash
assert.strictEqual(rc.reconcile({ type: 'mystery', value: 'x' }, { value: 'y', provider: 'p' }).status, STATUS.UNVERIFIABLE);
ok('an unknown verification type is unverifiable (never throws)');

// --- a MISSING / blank CLAIM (document) value is unverifiable, never a (false) conflict ---
assert.strictEqual(rc.reconcile({ type: 'name', value: null }, { value: 'ABC LLC', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'a null claimed name is not a fatal mismatch');
assert.strictEqual(rc.reconcile({ type: 'name', value: '   ' }, { value: 'ABC LLC', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'a blank claimed name is unverifiable');
assert.strictEqual(rc.reconcile({ type: 'amount', value: '' }, { value: '5000', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'an empty claimed amount is not a $0 conflict');
assert.ok(!rc.reconcile({ type: 'name', value: null }, { value: 'ABC LLC', provider: 'plaid' }).finding, 'no finding on a missing claim');
// a legitimate ZERO claimed amount is still a real value (not treated as missing)
assert.strictEqual(rc.reconcile({ type: 'amount', value: 0 }, { value: '0', provider: 'plaid' }).status, STATUS.CONFIRMED, 'a real $0 claim vs $0 source confirms');
ok('a missing / blank CLAIM value is unverifiable (a real $0 is still reconciled)');

// --- a blank-ish SOURCE value (whitespace) is unverifiable, never a false conflict ---
assert.strictEqual(rc.reconcile({ type: 'amount', value: '5000' }, { value: '   ', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'a whitespace source amount is not a conflict');
assert.strictEqual(rc.reconcile({ type: 'entity_status', value: 'ABC LLC' }, { value: '  ', provider: 'middesk' }).status, STATUS.UNVERIFIABLE, 'a blank registry status is unverifiable, not a fatal not-active');
assert.strictEqual(rc.reconcile({ type: 'property_value', value: '500000' }, { value: '  ', provider: 'attom' }).status, STATUS.UNVERIFIABLE, 'a blank AVM is unverifiable');
ok('a blank-ish SOURCE value (whitespace amount / status / AVM) is unverifiable, never a false conflict');

// --- a blank / normalize-to-empty NAME on either side is unverifiable, never a FATAL false mismatch ---
assert.strictEqual(rc.reconcile({ type: 'name', value: 'ABC LLC' }, { value: '   ', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'a whitespace source name is not a fatal ownership mismatch');
assert.strictEqual(rc.reconcile({ type: 'name', value: 'ABC LLC' }, { value: '\t\n', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'a tab/newline source name is unverifiable');
assert.strictEqual(rc.reconcile({ type: 'name', value: '.,' }, { value: 'ABC LLC', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'a claim that normalizes to empty (punctuation only) is unverifiable, not a mismatch');
assert.ok(!rc.reconcile({ type: 'name', value: 'ABC LLC' }, { value: '   ', provider: 'plaid' }).finding, 'no finding on a blank source name');
// a bare entity SUFFIX ("LLC"/"Inc") carries no identifying core → unverifiable, not a fatal mismatch
assert.strictEqual(rc.reconcile({ type: 'name', value: 'ABC LLC' }, { value: 'LLC', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'a bare "LLC" source owner has no identifying core');
assert.strictEqual(rc.reconcile({ type: 'name', value: 'Inc.' }, { value: 'ABC LLC', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'a bare "Inc." claim has no identifying core');
// but a real name that merely CONTAINS a suffix still compares normally
assert.strictEqual(rc.reconcile({ type: 'name', value: 'ABC LLC' }, { value: 'XYZ LLC', provider: 'plaid' }).status, STATUS.CONFLICT, 'two real different names still conflict');
ok('a blank / punctuation-only / bare-suffix NAME is unverifiable; two real different names still conflict');

// --- exists with a whitespace source is unverifiable (not a false not-found); a real false still conflicts ---
assert.strictEqual(rc.reconcile({ type: 'exists', value: 'lien' }, { value: '   ', provider: 'attom' }).status, STATUS.UNVERIFIABLE, 'a whitespace exists source is unverifiable');
assert.strictEqual(rc.reconcile({ type: 'exists', value: 'lien' }, { value: false, provider: 'attom' }).status, STATUS.CONFLICT, 'a real boolean false still conflicts');
ok('exists with a whitespace source is unverifiable; a genuine false still conflicts');

// --- property_value with a non-positive claimed base is unverifiable (no self-conflict on $0) ---
assert.strictEqual(rc.reconcile({ type: 'property_value', value: 0 }, { value: 0, provider: 'attom' }).status, STATUS.UNVERIFIABLE, 'a $0 claimed value has no base to compute variance');
assert.strictEqual(rc.reconcile({ type: 'property_value', value: '0' }, { value: '500000', provider: 'attom' }).status, STATUS.UNVERIFIABLE, 'a $0 claim never conflicts against any AVM');
ok('property_value with a non-positive claimed base is unverifiable (no degenerate $0 self-conflict)');

// --- reconcileAll: rollup, findings, coverage ---
const batch = rc.reconcileAll([
  { claim: { type: 'name', value: 'ABC LLC', field: 'owner' }, source: { value: 'ABC LLC', provider: 'plaid' } },          // confirmed
  { claim: { type: 'amount', value: '42318.55', field: 'bal' }, source: { value: '9000', provider: 'plaid' } },              // conflict
  { claim: { type: 'entity_status', value: 'ABC LLC' }, source: { value: 'Active', provider: 'middesk' } },                  // confirmed
  { claim: { type: 'property_value', value: '500000' }, source: { available: false, provider: 'attom' } },                   // unverifiable
]);
assert.strictEqual(batch.summary.total, 4);
assert.strictEqual(batch.summary.confirmed, 2);
assert.strictEqual(batch.summary.conflict, 1);
assert.strictEqual(batch.summary.unverifiable, 1);
assert.strictEqual(batch.findings.length, 1, 'exactly one conflict finding surfaced');
assert.strictEqual(batch.findings[0].code, 'verify_amount_mismatch');
// coverage = share an outside source actually spoke to = (confirmed + conflict) / total = 3/4
assert.strictEqual(batch.summary.coverage, 0.75, 'independent coverage is 3 of 4 claims');
ok('reconcileAll rolls up counts, collects conflict findings, and reports independent coverage');

// empty / junk input is safe
assert.doesNotThrow(() => rc.reconcile(null, null));
assert.strictEqual(rc.reconcile(null, null).status, STATUS.UNVERIFIABLE);
assert.strictEqual(rc.reconcileAll(null).summary.total, 0);
assert.strictEqual(rc.reconcileAll([]).summary.coverage, 0);
ok('empty / null input is safe (never throws)');

console.log(`\nP4 verification-reconciler pure — ${passed} checks passed`);

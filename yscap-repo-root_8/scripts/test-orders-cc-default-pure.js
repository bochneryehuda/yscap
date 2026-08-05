/**
 * Orders — the borrower is NOT CC'd by default, on ANY order kind (owner-directed
 * 2026-08-05): "the default across the board should be that it's not CC'ing the
 * borrower … By default they should not be CC'd." Before this, TITLE already
 * defaulted OFF but INSURANCE was hard-coded ON — so an insurance order always
 * looped the borrower in. This pins the whole truth table so the insurance
 * default can never silently flip back on, and proves the per-officer opt-in
 * exists for BOTH kinds (so an officer can set a default different from the
 * company's).
 *
 * PURE — no DB, no network. In `npm test`.
 */
'use strict';
const assert = require('assert');
const orders = require('../src/lib/orders');
const loSettings = require('../src/lib/lo-settings');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// 1) The company default is OFF for EVERY kind — the borrower is only CC'd when
//    the officer's own setting is exactly true.
for (const kind of ['title', 'insurance']) {
  ok(orders.ccBorrowerDefault(kind, undefined) === false, `${kind}: default (no officer setting) → NOT CC'd`);
  ok(orders.ccBorrowerDefault(kind, false) === false, `${kind}: officer setting off → NOT CC'd`);
  ok(orders.ccBorrowerDefault(kind, true) === true, `${kind}: officer opted in → CC'd`);
  ok(orders.ccBorrowerDefault(kind, 'true') === false, `${kind}: only a real boolean true opts in (no truthy coercion)`);
}

// 2) Each kind maps to its OWN per-officer setting key, so an officer can default
//    title and insurance independently — and set a default different from the company.
ok(orders.ccBorrowerSettingKey('title') === 'ccBorrowerOnTitleOrder', 'title → ccBorrowerOnTitleOrder key');
ok(orders.ccBorrowerSettingKey('insurance') === 'ccBorrowerOnInsuranceOrder', 'insurance → ccBorrowerOnInsuranceOrder key');
ok(orders.ccBorrowerSettingKey('nonsense') === null, 'an unknown kind has no key (company default stands: off)');

// 3) Both officer keys exist and DEFAULT OFF (this is what the company default rests on).
ok(loSettings.SETTINGS_KEYS.ccBorrowerOnTitleOrder && loSettings.SETTINGS_KEYS.ccBorrowerOnTitleOrder.default === false,
  'lo-settings ccBorrowerOnTitleOrder defaults false');
ok(loSettings.SETTINGS_KEYS.ccBorrowerOnInsuranceOrder && loSettings.SETTINGS_KEYS.ccBorrowerOnInsuranceOrder.default === false,
  'lo-settings ccBorrowerOnInsuranceOrder defaults false');
ok(loSettings.validate({ ccBorrowerOnInsuranceOrder: true }).ok === true, 'the new insurance key validates as a real setting');

// 4) recipientsFor puts the borrower in Cc only when told to — proven for insurance,
//    the kind that used to always CC.
const data = {
  appId: 'app-1',
  vendors: { insurance: { email: 'agent@ins.example' }, title: { email: 'agent@title.example' } },
  borrowerEmail: 'borrower@example.com',
  coBorrowerEmail: 'co@example.com',
  officer: { email: 'lo@yscap.example' },
  processor: { email: 'proc@yscap.example' },
};
const hasBorrower = (r) => r.cc.includes('borrower@example.com') || r.cc.includes('co@example.com');

// no opt-in anywhere → borrower absent
ok(!hasBorrower(orders.recipientsFor('insurance', data, {})), 'insurance: no setting → borrower NOT in Cc');
ok(!hasBorrower(orders.recipientsFor('title', data, {})), 'title: no setting → borrower NOT in Cc');
// officer default on → borrower present
ok(hasBorrower(orders.recipientsFor('insurance', data, { loCcSetting: true })), 'insurance: officer opted in → borrower in Cc');
// per-order explicit choice always wins, either way
ok(hasBorrower(orders.recipientsFor('insurance', data, { ccBorrower: true, loCcSetting: false })), 'explicit ccBorrower=true beats an off setting');
ok(!hasBorrower(orders.recipientsFor('insurance', data, { ccBorrower: false, loCcSetting: true })), 'explicit ccBorrower=false beats an on setting');
// the officer + processor are always on Cc regardless
ok(orders.recipientsFor('insurance', data, {}).cc.includes('lo@yscap.example'), 'officer is always Cc');

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll orders CC-default checks passed.');

'use strict';
/**
 * LONG-TERM — APPRAISAL ORDERING: shipped off, turned on in SETTINGS, and the form
 * follows the property.
 *
 * ── THE DEFECT THIS SUITE WAS WRITTEN AROUND ────────────────────────────────
 *
 * The condition `lt_order_appraisal` shipped switched off in the LIBRARY, where an
 * administrator can turn it on, and its own disabled reason promised "turning it on
 * is a settings change, not a new release". The ORDER KIND meanwhile carried
 * `enabled: false` as a CODE CONSTANT — so switching the template on left the order
 * still refused by something nobody at the desk can reach. One question, two
 * answers, and the one a person could change was not the one that decided.
 *
 * So these assertions are mostly about ONE property: the template is the switch,
 * the code constant is only what we ship with, and an unreadable template falls back
 * to the shipped default rather than to "on".
 */
const assert = require('assert');

let checks = 0;
const ok = (name, fn) => { fn(); checks += 1; console.log(`  ok - ${name}`); };
const okAsync = async (name, fn) => { await fn(); checks += 1; console.log(`  ok - ${name}`); };

const kinds = require('../src/longterm/orders/kinds');
const switches = require('../src/longterm/orders/switches');
const forms = require('../src/longterm/orders/appraisal-forms');
const data = require('../src/longterm/orders/data');
const letter = require('../src/longterm/orders/letter');

const clientThat = (rows) => ({ async query() { return { rows }; } });
const brokenClient = { async query() { throw new Error('the database is unreachable'); } };

console.log('\nLong-Term — appraisal ordering\n');

(async () => {
  // ── A. what we ship with ─────────────────────────────────────────────────
  ok('appraisal ships SWITCHED OFF, with a reason, and locked to one vendor', () => {
    const def = kinds.orderKind('appraisal');
    assert.strictEqual(def.enabled, false, 'the owner asked for it grayed out');
    assert.ok(def.disabledReason && def.disabledReason.length > 20, 'and a reason a person can read');
    assert.strictEqual(def.vendorLock, 'nan', 'NAN only');
    assert.strictEqual(def.condition, 'lt_order_appraisal', 'and it answers the condition the switch lives on');
  });

  ok('it is greyed rather than hidden — a feature that vanishes reads as one that broke', () => {
    assert.ok(kinds.ORDER_KIND_KEYS.includes('appraisal'), 'still on the desk');
    assert.strictEqual(kinds.isEnabled('appraisal'), false, 'and off by default');
  });

  // ── B. the template is the switch ────────────────────────────────────────
  await okAsync('switching the TEMPLATE on switches the order on', async () => {
    const map = await switches.resolve(clientThat([{ code: 'lt_order_appraisal', is_enabled: true, is_active: true, config: {} }]));
    assert.strictEqual(map.appraisal.enabled, true, 'a settings change, not a new release');
    assert.strictEqual(map.appraisal.source, 'settings', 'and it says which answered');
    assert.strictEqual(map.appraisal.reason, null);
  });

  await okAsync('switching a RUNNING order off in settings switches it off, in its own words', async () => {
    const map = await switches.resolve(clientThat([
      { code: 'lt_order_title', is_enabled: false, is_active: true, disabled_reason: 'We are between title companies.', config: {} },
    ]));
    assert.strictEqual(map.title.enabled, false);
    assert.strictEqual(map.title.reason, 'We are between title companies.', 'the buyer’s own sentence, not ours');
  });

  await okAsync('a RETIRED template is off for a DIFFERENT reason, and says so', async () => {
    const map = await switches.resolve(clientThat([{ code: 'lt_order_title', is_enabled: true, is_active: false, config: {} }]));
    assert.strictEqual(map.title.enabled, false);
    assert.ok(/retired/i.test(map.title.reason), 'retired and switched off send a person to two different screens');
  });

  await okAsync('an UNREADABLE library falls back to what we ship with — never to "on"', async () => {
    const map = await switches.resolve(brokenClient);
    assert.strictEqual(map.appraisal.enabled, false, 'an outage can never turn on an order the owner shipped off');
    assert.strictEqual(map.appraisal.source, 'shipped');
    assert.strictEqual(map.title.enabled, true, 'and can never turn off one that is running');
  });

  ok('a caller holding no map behaves exactly as it did before the switch existed', () => {
    assert.strictEqual(switches.stateFor(null, 'appraisal').enabled, false);
    assert.strictEqual(switches.stateFor(undefined, 'title').enabled, true);
    assert.strictEqual(switches.stateFor({}, 'appraisal').source, 'shipped');
  });

  ok('the blocker reads the LIVE switch, not the constant', () => {
    const file = {
      hasLoanNumber: true, propertyLine: '12 Oak St, Lakewood, NJ', borrowerName: 'Leib Lichtman',
      vendors: { appraisal: { id: 'v1', company_name: 'NAN', email: 'orders@nan.example' } },
      unreadable: [],
    };
    assert.ok(data.blockers('appraisal', file).includes('disabled'), 'off with no map');
    const on = { ...file, enabled: { appraisal: { enabled: true, reason: null, source: 'settings', config: {} } } };
    assert.ok(!data.blockers('appraisal', on).includes('disabled'), 'and on once settings say so');
    assert.deepStrictEqual(data.blockers('appraisal', on), [], 'with nothing else in the way');
  });

  // ── C. which form the property takes ─────────────────────────────────────
  ok('the owner’s four cases, read off the property', () => {
    assert.strictEqual(forms.propertyKind({ unitCount: 1 }), 'sfr');
    assert.strictEqual(forms.propertyKind({ unitCount: 4 }), 'multi_2_4');
    assert.strictEqual(forms.propertyKind({ unitCount: 12 }), 'multi_5_plus');
    assert.strictEqual(forms.propertyKind({ propertyType: 'Condominium' }), 'condo');
    assert.strictEqual(forms.propertyKind({ propertyType: 'SFR' }), 'sfr');
  });

  ok('the UNIT COUNT is asked first — a condo unit in a big building is still a condo', () => {
    // A condo is a single unit in a building; the count on the file is the count we
    // are lending on, which is the number that decides the form.
    assert.strictEqual(forms.propertyKind({ propertyType: 'Condominium', unitCount: 4 }), 'multi_2_4');
    assert.strictEqual(forms.propertyKind({ propertyType: 'Condominium', unitCount: 1 }), 'condo');
  });

  ok('a CO-OP is not a condo, and is never given a 1073', () => {
    assert.strictEqual(forms.propertyKind({ propertyType: 'Co-op' }), 'default');
    assert.strictEqual(forms.propertyKind({ propertyType: 'Cooperative' }), 'default');
    /* THE CASE THE GUARD ACTUALLY DECIDES. A bare "Co-op" falls to `default` anyway,
       because the condo pattern does not match it — so asserting only that proves
       nothing about the rule (the mutation was run, and it survived). The COMBINED
       categories the trade really writes DO match the condo pattern, and without the
       co-op test they would be ordered a 1073 on a share in a corporation. */
    assert.strictEqual(forms.propertyKind({ propertyType: 'Condo/Co-op' }), 'default');
    assert.strictEqual(forms.propertyKind({ propertyType: 'Condominium / Cooperative' }), 'default');
    assert.notStrictEqual(forms.formFor({ propertyType: 'Condo/Co-op' }, {}).form, forms.DEFAULT_FORMS.condo);
  });

  ok('a property we cannot read takes the standard form rather than a guess', () => {
    assert.strictEqual(forms.propertyKind({}), 'default');
    assert.strictEqual(forms.formFor({}, {}).form, '1004');
    assert.strictEqual(forms.formFor({ propertyType: 'something nobody wrote down' }, {}).kind, 'default');
  });

  ok('a configured form overrides ours, and a missing one falls back rather than to nothing', () => {
    const cfg = { forms: { sfr: '2055', default: '1004' } };
    assert.strictEqual(forms.formFor({ unitCount: 1 }, cfg).form, '2055', 'the buyer’s own form wins');
    assert.strictEqual(forms.formFor({ unitCount: 3 }, cfg).form, '1004', 'a kind they did not set falls to their default');
    assert.strictEqual(forms.formFor({ unitCount: 3 }, { forms: {} }).form, '1004', 'and an empty map to ours');
  });

  ok('the rent schedule rides only on a rental exit, and only where one is set', () => {
    assert.strictEqual(forms.formFor({ unitCount: 1 }, {}, { rentalExit: true }).rentSchedule, '1007');
    assert.strictEqual(forms.formFor({ unitCount: 3 }, {}, { rentalExit: true }).rentSchedule, '216');
    assert.strictEqual(forms.formFor({ unitCount: 1 }, {}, { rentalExit: false }).rentSchedule, null);
    assert.strictEqual(forms.formFor({ unitCount: 1 }, {}, {}).rentSchedule, null, 'unknown reads as no');
    assert.strictEqual(forms.formFor({ unitCount: 9 }, {}, { rentalExit: true }).rentSchedule, null,
      'a narrative appraisal already carries the rent roll');
  });

  ok('a settings screen cannot store a property kind nothing recognises', () => {
    const cleaned = forms.cleanConfig({ forms: { sfr: '2055', nonsense: '9999' }, rentSchedule: { sfr: '1007' } });
    assert.strictEqual(cleaned.forms.sfr, '2055');
    assert.ok(!('nonsense' in cleaned.forms), 'a typo would show as saved and never apply');
    assert.strictEqual(cleaned.forms.default, '1004', 'default always resolves — an unreadable property still has an order');
    assert.strictEqual(cleaned.rentSchedule.sfr, '1007');
  });

  ok('clearing a box puts that kind back to our prefill', () => {
    const cleaned = forms.cleanConfig({ forms: { sfr: '   ' } });
    assert.ok(!('sfr' in cleaned.forms), 'blank removes the override');
    assert.strictEqual(forms.formFor({ unitCount: 1 }, cleaned).form, '1004');
  });

  // ── D. the letter says which form ────────────────────────────────────────
  ok('the appraisal order NAMES the form — "please appraise this" is not an order', () => {
    const d = {
      loanNumber: 'YSCAP1', propertyLine: '12 Oak St, Lakewood, NJ 08701', borrowerName: 'Leib Lichtman',
      unitCount: 3, propertyType: 'Multi', rentalExit: true, transactionType: 'Refinance',
      vendors: { appraisal: { company_name: 'NAN', contact_name: 'Orders', email: 'orders@nan.example' } },
      officer: { name: 'Chaya Gruber', title: 'Loan Officer' },
      enabled: { appraisal: { enabled: true, config: {}, source: 'settings', reason: null } },
    };
    const built = letter.buildLetter('appraisal', d);
    assert.ok(/Form 1025/.test(built.text), 'the form the property takes');
    assert.ok(/Rent schedule: form 216/.test(built.text), 'and the schedule beside it on a rental');
  });

  ok('a property we could not read says so on the letter, before it goes', () => {
    const d = {
      loanNumber: 'YSCAP1', propertyLine: '12 Oak St', borrowerName: 'X',
      vendors: { appraisal: { company_name: 'NAN', email: 'orders@nan.example' } },
      enabled: { appraisal: { enabled: true, config: {}, source: 'settings', reason: null } },
    };
    const built = letter.buildLetter('appraisal', d);
    assert.ok(/Form 1004/.test(built.text));
    assert.ok(/could not read the property type/i.test(built.text),
      'a person can correct it before it goes, rather than after the fee is spent');
  });

  ok('a buyer’s configured form reaches the letter', () => {
    const d = {
      loanNumber: 'YSCAP1', propertyLine: '12 Oak St', borrowerName: 'X', unitCount: 1,
      vendors: { appraisal: { company_name: 'NAN', email: 'orders@nan.example' } },
      enabled: { appraisal: { enabled: true, source: 'settings', reason: null, config: { forms: { sfr: '2055' } } } },
    };
    assert.ok(/Form 2055/.test(letter.buildLetter('appraisal', d).text));
  });

  ok('no other order kind grew a form line', () => {
    const d = {
      loanNumber: 'YSCAP1', propertyLine: '12 Oak St', borrowerName: 'X', unitCount: 1,
      vendors: { payoff: { company_name: 'Servicer', email: 'p@s.example' } },
      enabled: {},
    };
    assert.ok(!/Form 100/.test(letter.buildLetter('payoff', d).text));
  });

  // ── E. structural ────────────────────────────────────────────────────────
  const fs = require('fs');
  const path = require('path');
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const read = (p) => strip(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));

  ok('nothing decides "is this order on" off the code constant any more', () => {
    for (const p of ['src/longterm/orders/data.js', 'src/longterm/orders/desk.js']) {
      assert.ok(!/def\.enabled === false/.test(read(p)),
        `${p} still reads the shipped constant instead of the live switch`);
      assert.ok(/switches\.stateFor/.test(read(p)), `${p} should ask the switch`);
    }
  });

  ok('the form resolver is PURE — it can never be the reason an order fails to build', () => {
    const src = read('src/longterm/orders/appraisal-forms.js');
    assert.ok(!/require\(/.test(src), 'no requires at all');
  });

  console.log(`\ntest-lt-appraisal-order-pure: ${checks} checks passed\n`);
})().catch((e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});

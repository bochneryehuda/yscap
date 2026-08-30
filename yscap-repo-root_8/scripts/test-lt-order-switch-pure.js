'use strict';
/**
 * LONG-TERM — WHICH ORDERS ARE SWITCHED ON IS A SETTING, NOT A RELEASE.
 *
 * The owner's rule over this whole build: *"everything should be setup with not
 * setting it on a hard level; everything should be able to be configured differently
 * in settings. The system is only prefilled with the rules of the system."*
 *
 * The defect this guards is the one it was written for: an order kind's `enabled`
 * lived in code while the condition it answers carries its own switch in the
 * library, so one question had two answers and the one a person could reach was not
 * the one that decided. These assertions are about that ONE property — the template
 * decides, the constant is only what we ship with, and an unreadable library falls
 * back to the shipped default rather than to "on".
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
const ok = (name, fn) => { fn(); checks += 1; console.log(`  ok - ${name}`); };
const okAsync = async (name, fn) => { await fn(); checks += 1; console.log(`  ok - ${name}`); };

const kinds = require('../src/longterm/orders/kinds');
const switches = require('../src/longterm/orders/switches');
const data = require('../src/longterm/orders/data');

/* THE ROW SHAPE THESE FIXTURES STAND IN FOR MOVED, and the fixtures moved with it.
   When the Long-Term conditions became rows in the SHARED checklist_templates
   (db/652, db/653), the two facts that are Long-Term's alone — whether an order is
   switched on, and the buyer's own sentence for why not — lost their columns:
   `is_enabled` and `disabled_reason` do not exist on the shared table. They now
   ride inside `config`, which is the one place the seed writes them, and
   switches.resolve reads them from there (src/longterm/orders/switches.js:67-79
   selects code, is_active, config — nothing else).

   So a fixture handing back `is_enabled` was feeding a column the query no longer
   asks for: the value was simply ignored and every switch read as ON. The code is
   right; the stand-in was stale. */
const clientThat = (rows) => ({ async query() { return { rows }; } });
const brokenClient = { async query() { throw new Error('the database is unreachable'); } };

console.log('\nLong-Term — the order switch\n');

(async () => {
  await okAsync('switching a template OFF switches its order off, in the buyer’s own words', async () => {
    const map = await switches.resolve(clientThat([
      { code: 'lt_order_title', is_active: true, config: { enabled: false, disabledReason: 'We are between title companies.' } },
    ]));
    assert.strictEqual(map.title.enabled, false);
    assert.strictEqual(map.title.reason, 'We are between title companies.', 'their sentence, not one we invented');
    assert.strictEqual(map.title.source, 'settings', 'and it says which answered');
  });

  await okAsync('switching it back ON switches the order on, with the reason gone', async () => {
    const map = await switches.resolve(clientThat([
      { code: 'lt_order_title', is_active: true, config: { enabled: true, disabledReason: 'stale' } },
    ]));
    assert.strictEqual(map.title.enabled, true);
    assert.strictEqual(map.title.reason, null, 'a live order must never carry a reason it is off');
  });

  await okAsync('a RETIRED template is off for a DIFFERENT reason, and says so', async () => {
    const map = await switches.resolve(clientThat([{ code: 'lt_order_title', is_active: false, config: { enabled: true } }]));
    assert.strictEqual(map.title.enabled, false);
    assert.ok(/retired/i.test(map.title.reason),
      'retired and switched off send a person to two different screens');
  });

  await okAsync('an UNREADABLE library falls back to what we ship with — never to "on"', async () => {
    const map = await switches.resolve(brokenClient);
    for (const k of kinds.ORDER_KIND_KEYS) {
      assert.strictEqual(map[k].enabled, kinds.isEnabled(k), `${k} keeps its shipped default`);
      assert.strictEqual(map[k].source, 'shipped');
    }
  });

  await okAsync('a template for a kind nothing offers is ignored rather than inventing one', async () => {
    const map = await switches.resolve(clientThat([{ code: 'lt_something_else', is_active: true, config: { enabled: false } }]));
    assert.deepStrictEqual(Object.keys(map).sort(), [...kinds.ORDER_KIND_KEYS].sort());
  });

  ok('a caller holding no map behaves exactly as it did before the switch existed', () => {
    for (const k of kinds.ORDER_KIND_KEYS) {
      assert.strictEqual(switches.stateFor(null, k).enabled, kinds.isEnabled(k));
      assert.strictEqual(switches.stateFor({}, k).source, 'shipped');
    }
    assert.strictEqual(switches.stateFor(null, 'no_such_order').enabled, false,
      'and an unknown kind is off, never a default one');
  });

  ok('the blocker reads the LIVE switch, not the constant', () => {
    const file = {
      hasLoanNumber: true, propertyLine: '12 Oak St, Lakewood, NJ', borrowerName: 'Leib Lichtman',
      vendors: { title: { id: 'v1', company_name: 'Acme Title', email: 'orders@acme.example' } },
      unreadable: [],
    };
    assert.deepStrictEqual(data.blockers('title', file), [], 'on by default');
    const off = { ...file, enabled: { title: { enabled: false, reason: 'off', source: 'settings', config: {} } } };
    assert.ok(data.blockers('title', off).includes('disabled'), 'and off the moment settings say so');
  });

  ok('the template’s own settings ride with the switch', () => {
    // One read answers both "is it on" and "what did the buyer configure", so the
    // desk and the letter can never be looking at two different versions of it.
    const s = switches.stateFor({ title: { enabled: true, reason: null, source: 'settings', config: { letter: { title: 'Ours' } } } }, 'title');
    assert.strictEqual(s.config.letter.title, 'Ours');
    assert.deepStrictEqual(switches.stateFor(null, 'title').config, {}, 'and it is never absent');
  });

  ok('nothing decides "is this order on" off the code constant any more', () => {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const p of ['src/longterm/orders/data.js', 'src/longterm/orders/desk.js']) {
      const src = strip(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
      assert.ok(!/def\.enabled === false/.test(src), `${p} still reads the shipped constant`);
      assert.ok(/switches\.stateFor/.test(src), `${p} should ask the switch`);
    }
  });

  console.log(`\ntest-lt-order-switch-pure: ${checks} checks passed\n`);
})().catch((e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});

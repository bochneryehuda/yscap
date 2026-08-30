'use strict';
/**
 * LONG-TERM — APPRAISAL ORDERING against a REAL Postgres.
 *
 * The pure suite proves the RULE with an injected client; this proves the query it
 * runs actually reads the schema. `switches.resolve` swallows a read failure and
 * falls back to the shipped default — which is right (an outage must never turn an
 * order on) and is also exactly the shape that hides a mistyped column forever: the
 * switch would silently stop working and every order would read as "off as shipped",
 * so an administrator turning appraisal ordering on would see nothing happen and
 * nothing anywhere would say why.
 *
 * Skips cleanly with no DATABASE_URL.
 */
const assert = require('assert');

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-appraisal-order-db (no DATABASE_URL)');
  process.exit(0);
}

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok - ${name}`); };

const db = require('../src/longterm/db');
const switches = require('../src/longterm/orders/switches');
const library = require('../src/longterm/conditions-center/library');

(async () => {
  console.log('\nLong-Term — appraisal ordering, against a real database\n');

  // The library has to be seeded for the switch to have anything to read.
  await library.seed(db).catch(() => {});

  const map = await switches.resolve(db);
  assert.ok(map && map.appraisal, 'the appraisal kind is in the map');
  assert.strictEqual(map.appraisal.source, 'settings',
    'the SWITCH read the template — "shipped" here means the query failed and the fallback answered');
  ok('the switch really reads the condition library — no phantom column');

  assert.strictEqual(map.appraisal.enabled, false, 'and appraisal ships switched off, as the owner asked');
  assert.ok(map.appraisal.reason && /settings change/i.test(map.appraisal.reason),
    'with the template’s own reason, which promises it comes back on in settings');
  ok('appraisal ships off, with the reason a person reads');

  assert.strictEqual(map.title.enabled, true, 'and the orders that run, run');
  ok('the orders that are meant to be running are running');

  assert.ok(map.appraisal.config && map.appraisal.config.forms,
    'the forms come back with the switch, so the letter can name one');
  assert.strictEqual(map.appraisal.config.forms.multi_2_4, '1025');
  ok('the shipped forms are on the template, where a person can change them');

  // ── turning it on IS a settings change ──────────────────────────────────
  const before = (await db.query(
    `SELECT is_enabled, config FROM lt_condition_templates WHERE code = 'lt_order_appraisal'`)).rows[0];
  try {
    await db.query(
      `UPDATE lt_condition_templates
          SET is_enabled = true, config = jsonb_set(config, '{forms,sfr}', '"2055"')
        WHERE code = 'lt_order_appraisal'`);
    const after = await switches.resolve(db);
    assert.strictEqual(after.appraisal.enabled, true,
      'turning the template on turns the order on — a settings change, not a new release');
    assert.strictEqual(after.appraisal.reason, null, 'and the disabled reason goes with it');
    assert.strictEqual(after.appraisal.config.forms.sfr, '2055', 'and a changed form reaches the order');
    ok('switching the template on switches the order on, and a changed form travels with it');
  } finally {
    await db.query(
      `UPDATE lt_condition_templates SET is_enabled = $1, config = $2::jsonb WHERE code = 'lt_order_appraisal'`,
      [before.is_enabled, JSON.stringify(before.config)]);
  }

  const restored = await switches.resolve(db);
  assert.strictEqual(restored.appraisal.enabled, false, 'and back off again');
  ok('the switch answers the library on every read — nothing is cached into a deploy');

  console.log(`\ntest-lt-appraisal-order-db: ${checks} checks passed\n`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});

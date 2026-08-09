'use strict';
/**
 * Tests for the API Health WORKING switches — the runtime flag override layer.
 *   src/lib/flags.js               (the override cache: enabled/hasOverride/setFlag/clearFlag)
 *   src/lib/integrations/switches.js  (the admin-flippable allowlist: effective/list/on)
 *
 * The allowlist + effective-value logic is PURE (no DB); an end-to-end override pass is DB-gated.
 * A switch with NO override must behave byte-identically to the env/cfg default (so the platform
 * runs exactly as today until an admin flips something).
 */
const assert = require('assert');
const flags = require('../src/lib/flags');
const switches = require('../src/lib/integrations/switches');
const health = require('../src/lib/integrations/health-registry');

/* PLATFORM-level switches: the deliberate exceptions to "every switch belongs to a card",
   ENUMERATED so a typo in an `integration` key cannot quietly promote a broken switch into
   one. A switch listed here belongs to no integration because it governs all of them; the
   API Health page renders it in its own banner. Adding one is a decision, not an accident —
   which is why it goes in this list by hand. */
const PLATFORM_SWITCHES = new Set(['INTEGRATIONS_MONITOR_ENABLED']);

// ---- PURE: the allowlist is well-formed and every switch maps to a real integration ----
{
  const regKeys = new Set(health.INTEGRATIONS.map((e) => e.key));
  const seen = new Set();
  for (const s of switches.SWITCHES) {
    assert.ok(s.key && !seen.has(s.key), `switch key present + unique: ${s.key}`);
    seen.add(s.key);
    assert.ok(s.label, `${s.key} has a label`);
    if (s.integration === null) {
      assert.ok(PLATFORM_SWITCHES.has(s.key),
        `${s.key} has no integration — add it to PLATFORM_SWITCHES if that is deliberate, or fix the key`);
    } else {
      assert.ok(regKeys.has(s.integration), `${s.key} points at a real integration (${s.integration})`);
    }
    assert.strictEqual(typeof s.envDefault, 'function', `${s.key} has an envDefault()`);
    assert.strictEqual(switches.BY_KEY[s.key], s, `${s.key} is in BY_KEY`);
  }
  /* A platform switch must never be rendered on a card: the health registry attaches a switch
     with `s.integration === entry.key`, and `entry.key` is never null — assert that directly
     rather than trusting the filter to stay that way. */
  for (const k of PLATFORM_SWITCHES) {
    assert.strictEqual(switches.BY_KEY[k].integration, null, `${k} is platform-level (integration: null)`);
    const onACard = health.INTEGRATIONS.some((e) => (e.switches || []).some((x) => x.name === k));
    assert.ok(!onACard, `${k} is not declared on an integration card either`);
  }
  // The dangerous (write/creation) switches are flagged so the UI forces a typed confirm.
  const danger = new Set(switches.SWITCHES.filter((s) => s.dangerous).map((s) => s.key));
  for (const k of ['SITEWIRE_OUTBOUND_ENABLED', 'CLICKUP_OUTBOUND_ENABLED', 'CLICKUP_INBOUND_CREATE_FILES', 'DOCUSIGN_SEND_ENABLED']) {
    assert.ok(danger.has(k), `${k} is marked dangerous (write switch)`);
  }
  console.log('  ok - switch allowlist well-formed + every switch maps to a real integration');
}

// ---- PURE: with no override, effective/on fall back to the env default exactly ----
{
  for (const s of switches.SWITCHES) {
    const eff = switches.effective(s.key);
    assert.ok(eff && eff.key === s.key, `effective(${s.key}) resolves`);
    assert.strictEqual(eff.overridden, false, `${s.key} is not overridden with no flag row`);
    assert.strictEqual(eff.on, !!s.envDefault(), `${s.key} effective.on == env default with no override`);
    assert.strictEqual(switches.on(s.key), !!s.envDefault(), `${s.key} on() == env default with no override`);
    assert.strictEqual(eff.envDefault, !!s.envDefault(), `${s.key} reports its env default`);
  }
  assert.strictEqual(switches.effective('NOPE_NOT_A_SWITCH'), null, 'effective() returns null for an unknown key');
  assert.strictEqual(switches.on('NOPE_NOT_A_SWITCH'), false, 'on() is false (safe) for an unknown key');
  // flags.enabled honors the caller-supplied default when there is no override.
  assert.strictEqual(flags.enabled('SOME_UNSET_KEY', true), true, 'enabled() returns the passed default (true) with no override');
  assert.strictEqual(flags.enabled('SOME_UNSET_KEY', false), false, 'enabled() returns the passed default (false) with no override');
  assert.strictEqual(flags.hasOverride('SOME_UNSET_KEY'), false, 'hasOverride() false with no override');
  console.log('  ok - no override → effective == env default (identical to today)');
}

// ---- PURE: list() returns one effective row per switch, shaped for the page ----
{
  const rows = switches.list();
  assert.strictEqual(rows.length, switches.SWITCHES.length, 'list() has one row per switch');
  for (const r of rows) {
    for (const f of ['key', 'label', 'integration', 'dangerous', 'resume', 'on', 'overridden', 'envDefault']) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, f), `list row has ${f}`);
    }
  }
  console.log('  ok - list() shape is complete for the UI');
}

// ---- DB end-to-end: setFlag overrides the effective value; clearFlag reverts to the env default ----
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP test-integrations-switches DB half (no DATABASE_URL)');
    console.log('test-integrations-switches: allowlist + no-override-equals-default + list shape pass');
    return;
  }
  const db = require('../src/db');
  await require('../src/migrate-boot').ensureSchema();

  const KEY = 'SITEWIRE_OUTBOUND_ENABLED';
  const s = switches.BY_KEY[KEY];
  const envDefault = !!s.envDefault();
  await db.query('DELETE FROM integration_flags WHERE key = $1', [KEY]);
  await flags.refresh();
  try {
    assert.strictEqual(switches.on(KEY), envDefault, 'starts at env default');
    assert.strictEqual(flags.hasOverride(KEY), false, 'no override at start');

    // Override to the OPPOSITE of the env default → effective flips immediately (cache updated on write).
    await flags.setFlag(KEY, !envDefault, null, 'test');
    assert.strictEqual(switches.on(KEY), !envDefault, 'override flips the effective value');
    assert.strictEqual(flags.hasOverride(KEY), true, 'hasOverride true after setFlag');
    assert.strictEqual(switches.effective(KEY).overridden, true, 'effective marks it overridden');

    // A fresh refresh from the DB keeps the override (it was persisted, not just cached).
    await flags.refresh();
    assert.strictEqual(switches.on(KEY), !envDefault, 'override survives a DB refresh');
    const row = (await db.query('SELECT enabled FROM integration_flags WHERE key = $1', [KEY])).rows[0];
    assert.ok(row && row.enabled === !envDefault, 'override row persisted with the flipped value');

    // Clear → reverts to the env default and the row is gone.
    await flags.clearFlag(KEY);
    assert.strictEqual(switches.on(KEY), envDefault, 'clearFlag reverts to env default');
    assert.strictEqual(flags.hasOverride(KEY), false, 'no override after clearFlag');
    assert.strictEqual((await db.query('SELECT 1 FROM integration_flags WHERE key = $1', [KEY])).rows.length, 0, 'override row removed');
  } finally {
    // Never leave a stray override behind if an assertion above throws (it would perturb the next run).
    await db.query('DELETE FROM integration_flags WHERE key = $1', [KEY]).catch(() => {});
  }

  console.log('test-integrations-switches: allowlist + no-override-default + list shape + DB override/refresh/clear pass');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

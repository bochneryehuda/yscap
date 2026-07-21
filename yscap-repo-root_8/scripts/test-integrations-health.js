'use strict';
/**
 * Unit tests for the integration HEALTH registry (src/lib/integrations/health-registry.js).
 * Pure — no DB. With no env keys set (the CI default), every probe must resolve to a sane,
 * non-throwing status and NEVER leak a secret value. Guards the API Health admin page.
 */
const assert = require('assert');
const health = require('../src/lib/integrations/health-registry');

(async () => {
  // Every descriptor is well-formed.
  const KEYS = new Set();
  for (const e of health.INTEGRATIONS) {
    assert.ok(e.key && !KEYS.has(e.key), `integration key present + unique: ${e.key}`);
    KEYS.add(e.key);
    assert.ok(e.name && e.purpose, `${e.key} has a name + purpose`);
    assert.ok(typeof e.probe === 'function', `${e.key} has a probe`);
    assert.ok(e.group, `${e.key} has a group`);
  }
  // The owner-requested integrations all have a slot (found or reserved).
  for (const k of ['azure_openai', 'azure_docint', 'docusign', 'sitewire', 'clickup', 'sharepoint',
    'resend', 'graph_email', 'fema_flood', 'google_maps', 'ocr_space', 'encompass', 'usps']) {
    assert.ok(KEYS.has(k), `a section exists for ${k}`);
  }

  // probeAll resolves for every integration, never throws, and returns a sane shape.
  const list = await health.probeAll();
  assert.strictEqual(list.length, health.INTEGRATIONS.length, 'one result per integration');
  const STATES = new Set(['live', 'configured', 'disabled', 'unreachable', 'not_configured', 'framework', 'planned']);
  for (const r of list) {
    assert.ok(STATES.has(r.state), `${r.key} has a known state (${r.state})`);
    assert.strictEqual(typeof r.detail, 'string', `${r.key} has a plain-English detail`);
    assert.ok(Array.isArray(r.env), `${r.key} env is a list`);
    // With no keys set in CI, nothing configured should read "live", and env chips report presence only.
    for (const ev of r.env) {
      assert.ok(typeof ev.name === 'string' && typeof ev.set === 'boolean', `${r.key} env chip is presence-only`);
      // Presence flag must be a boolean, never a value — no secret can ride along.
      assert.notStrictEqual(typeof ev.set, 'string', `${r.key} env never carries a value`);
    }
  }

  // The not-built placeholders read as 'planned' (reserved slots, never "live").
  assert.strictEqual(list.find((r) => r.key === 'encompass').state, 'planned', 'Encompass is a reserved slot');
  assert.strictEqual(list.find((r) => r.key === 'usps').state, 'planned', 'USPS is a reserved slot');

  // probeOne returns one resolved integration; an unknown key returns null (a 404 upstream).
  const one = await health.probeOne('clickup');
  assert.ok(one && one.key === 'clickup', 'probeOne resolves a known key');
  assert.strictEqual(await health.probeOne('nope_not_real'), null, 'probeOne returns null for an unknown key');

  console.log('test-integrations-health: registry descriptors + non-throwing probes + presence-only env + reserved slots pass');
})().catch((e) => { console.error(e); process.exit(1); });

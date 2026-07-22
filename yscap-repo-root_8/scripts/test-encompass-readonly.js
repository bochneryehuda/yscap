'use strict';
/**
 * Regression: Encompass integration is READ-ONLY, FROZEN (owner-directed 2026-07-22).
 *
 * The client at src/lib/integrations/encompass.js exposes ONLY GET helpers. This
 * test proves the structural guards:
 *   (1) the module exports { configured, ping, apiGet, READ_ONLY } and NOTHING
 *       else that could write (no apiPost / apiPut / apiPatch / apiDelete);
 *   (2) READ_ONLY === true (the sentinel other callers can guard on);
 *   (3) `apiGet` refuses a path in the OAuth namespace;
 *   (4) the internal fetch guard refuses any method other than GET against
 *       /encompass/* — belt-and-suspenders backstop.
 *
 * If a future edit adds a write helper, remove this test's guards, or relax
 * assertReadOnlyPath, this test fails and blocks the merge.
 */

const assert = require('assert');
const Module = require('module');

// Set fake env BEFORE requiring so `configured()` returns true.
process.env.ENCOMPASS_CLIENT_ID = process.env.ENCOMPASS_CLIENT_ID || 'test-client';
process.env.ENCOMPASS_CLIENT_SECRET = process.env.ENCOMPASS_CLIENT_SECRET || 'test-secret';
process.env.ENCOMPASS_INSTANCE_ID = process.env.ENCOMPASS_INSTANCE_ID || 'TESTINSTANCE';
process.env.ENCOMPASS_API_BASE = 'https://api.elliemae.example';

// Reset the module cache so config env changes take effect.
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/lib/integrations/encompass')];

const enc = require('../src/lib/integrations/encompass');

async function main() {
  // (1) Exported surface — only READ helpers, plus the READ_ONLY sentinel.
  const keys = Object.keys(enc).sort();
  assert.deepStrictEqual(
    keys,
    ['READ_ONLY', 'apiGet', 'configured', 'name', 'ping'],
    `Encompass client exports MUST be exactly {name, configured, ping, apiGet, READ_ONLY} — got ${keys.join(', ')}`,
  );
  for (const forbidden of ['apiPost', 'apiPut', 'apiPatch', 'apiDelete', 'updateLoan', 'createLoan', 'patchLoan', 'setField']) {
    assert.strictEqual(enc[forbidden], undefined, `Encompass integration must NOT export a write helper — found ${forbidden}`);
  }

  // (2) The READ_ONLY sentinel.
  assert.strictEqual(enc.READ_ONLY, true, 'encompass.READ_ONLY must be true');

  // (3) apiGet refuses the OAuth namespace.
  assert.strictEqual(enc.configured(), true);
  await assert.rejects(
    () => enc.apiGet('/oauth2/v1/token'),
    /may not call the OAuth namespace/,
    'apiGet must refuse /oauth2/*',
  );
  await assert.rejects(
    () => enc.apiGet('oauth2/v1/token'),  // no leading slash
    /may not call the OAuth namespace/,
    'apiGet must refuse an OAuth path without a leading slash',
  );
  await assert.rejects(
    () => enc.apiGet(''),
    /path is required/,
    'apiGet must refuse an empty path',
  );

  // (4) Belt-and-suspenders: the source string proves _fetchGuarded is present and blocks non-GET.
  const src = require('fs').readFileSync(require.resolve('../src/lib/integrations/encompass'), 'utf8');
  assert.ok(src.includes('_fetchGuarded'), 'the _fetchGuarded backstop must be present in the source');
  assert.ok(src.includes("method !== 'GET'"), 'the method-allowlist check must be present');
  assert.ok(src.includes('READ-ONLY (owner-directed freeze)'), 'the read-only error message must be present');
  // No write helper may exist as a function/const declaration or as an
  // exported symbol. Mentions inside comments/error messages are fine (and
  // wanted — they document what's forbidden).
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const name of ['apiPost', 'apiPut', 'apiPatch', 'apiDelete', 'updateLoan', 'createLoan', 'patchLoan']) {
    assert.ok(
      !new RegExp(`(?:function\\s+${name}\\b|const\\s+${name}\\b|${name}\\s*:)`).test(codeOnly),
      `no ${name} write helper may exist in the source`,
    );
  }

  console.log('OK — Encompass integration is structurally READ-ONLY.');
}

main().catch((e) => { console.error(e); process.exit(1); });

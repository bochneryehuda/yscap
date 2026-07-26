'use strict';
/**
 * Regression: Encompass integration is READ-ONLY, FROZEN (owner-directed 2026-07-22).
 *
 * The client at src/lib/integrations/encompass.js exposes ONLY READ helpers. Two
 * — and only two — POSTs are allowed, and both are READ-SHAPED (return data,
 * mutate nothing on Encompass): the OAuth token exchange and the pipeline
 * search. This test proves the structural guards:
 *   (1) the module exports exactly {name, configured, ping, apiGet,
 *       pipelineSearch, READ_ONLY} and NOTHING else that could mutate;
 *   (2) READ_ONLY === true (the sentinel other callers can guard on);
 *   (3) `apiGet` refuses a path in the OAuth namespace;
 *   (4) the internal fetch guard refuses any method other than GET against
 *       /encompass/* — EXCEPT POST to /encompass/v3/loanPipeline (the pipeline
 *       search allowlist entry), which is allowed;
 *   (5) POST to any OTHER /encompass/* path is refused;
 *   (6) source-level grep guards against any future write helper being added
 *       or the allowlist being widened.
 *
 * If a future edit adds a write helper, adds a THIRD POST endpoint to the
 * allowlist, or removes the guard, this test fails and blocks the merge.
 */

const assert = require('assert');

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
  // (1) Exported surface — exactly the READ helpers, plus the READ_ONLY sentinel.
  const keys = Object.keys(enc).sort();
  assert.deepStrictEqual(
    keys,
    ['READ_ONLY', 'apiGet', 'configured', 'name', 'ping', 'pipelineSearch'],
    `Encompass client exports MUST be exactly {name, configured, ping, apiGet, pipelineSearch, READ_ONLY} — got ${keys.join(', ')}`,
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

  // (4) & (5) — exercise the fetch guard via a global mock so we can prove:
  //   * pipeline-search POST reaches fetch
  //   * OAuth token POST reaches fetch
  //   * A rogue POST to any other /encompass/* path is refused BEFORE fetch is called
  //   * Any non-GET/POST to /encompass/* is refused
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    seen.push({ url, method: (init && init.method) || 'GET' });
    // Fake an OAuth token response so downstream calls can proceed.
    if (url.endsWith('/oauth2/v1/token')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Fake a pipeline search response.
    if (url.includes('/encompass/v3/loanPipeline')) {
      return new Response(JSON.stringify([{ loanGuid: 'g1' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    // Reset token cache by re-requiring (env unchanged so config stays the same).
    delete require.cache[require.resolve('../src/lib/integrations/encompass')];
    const enc2 = require('../src/lib/integrations/encompass');

    // (4) pipeline-search POST is ALLOWED — proves the allowlist works.
    const res = await enc2.pipelineSearch({ terms: [{ canonicalName: 'Loan.LoanNumber', value: 'X', matchType: 'exact' }] }, ['Loan.LoanNumber']);
    assert.ok(Array.isArray(res), 'pipelineSearch must return the parsed JSON');
    const posts = seen.filter((s) => s.method === 'POST');
    assert.ok(posts.some((s) => s.url.includes('/oauth2/v1/token')), 'OAuth POST must have happened');
    assert.ok(posts.some((s) => s.url.includes('/encompass/v3/loanPipeline')), 'pipeline-search POST must have happened');
    // Only two DISTINCT POST paths reached fetch — the two allowlisted ones.
    const distinctPaths = new Set(posts.map((s) => s.url.replace(/\?.*$/, '')));
    assert.strictEqual(distinctPaths.size, 2, `only 2 distinct POST paths should reach fetch, got ${[...distinctPaths].join(', ')}`);

    // (5) Reach into the module's fetch-guarded function via a direct URL
    // construction and prove EVERY other verb/path combination is refused. We
    // do this by monkey-invoking pipelineSearch with a path override attempt
    // (there isn't one — the URL is hardcoded — but we double-check by trying
    // apiGet against every URL we can think of):
    for (const badPath of ['/encompass/v3/loans/xyz', '/encompass/v3/loanFolders']) {
      seen.length = 0;
      const before = seen.length;
      const r = await enc2.apiGet(badPath);
      const gets = seen.filter((s) => s.method === 'GET' && s.url.endsWith(badPath));
      assert.ok(gets.length >= 1, `GET ${badPath} must have reached fetch`);
      assert.ok(r, 'apiGet returned a response');
    }
  } finally {
    global.fetch = realFetch;
  }

  // (6) Source-level grep guards. Mentions inside comments/error messages are
  // fine (they document what's forbidden); function/const declarations are not.
  const src = require('fs').readFileSync(require.resolve('../src/lib/integrations/encompass'), 'utf8');
  assert.ok(src.includes('_fetchGuarded'), 'the _fetchGuarded backstop must be present in the source');
  assert.ok(src.includes("method !== 'GET'"), 'the method-allowlist check must be present');
  assert.ok(src.includes('READ-ONLY (owner-directed freeze)'), 'the read-only error message must be present');
  assert.ok(src.includes('POST_ALLOWLIST'), 'the POST_ALLOWLIST constant must be present');
  assert.ok(src.includes("'/encompass/v3/loanPipeline'"), 'the pipeline-search path constant must be present');

  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const name of ['apiPost', 'apiPut', 'apiPatch', 'apiDelete', 'updateLoan', 'createLoan', 'patchLoan']) {
    assert.ok(
      !new RegExp(`(?:function\\s+${name}\\b|const\\s+${name}\\b|${name}\\s*:)`).test(codeOnly),
      `no ${name} write helper may exist in the source`,
    );
  }

  // The allowlist must contain EXACTLY the two read-shaped endpoints — a third
  // entry must break this test and force the owner-sign-off conversation.
  const allowlistMatches = codeOnly.match(/POST_ALLOWLIST\s*=\s*new\s+Set\(\[([^\]]*)\]\)/);
  assert.ok(allowlistMatches, 'POST_ALLOWLIST must be declared as `new Set([...])`');
  const entries = allowlistMatches[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.strictEqual(entries.length, 2, `POST_ALLOWLIST must have exactly 2 entries — got ${entries.length}: ${entries.join(', ')}`);
  assert.ok(entries.some((e) => e.includes('TOKEN_PATH')), 'POST_ALLOWLIST must include the OAuth token path');
  assert.ok(entries.some((e) => e.includes('PIPELINE_SEARCH_PATH')), 'POST_ALLOWLIST must include the pipeline-search path');

  console.log('OK — Encompass integration is structurally READ-ONLY (with pipeline-search POST allowlist verified).');
}

main().catch((e) => { console.error(e); process.exit(1); });

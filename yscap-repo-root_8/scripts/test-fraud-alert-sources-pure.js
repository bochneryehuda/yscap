'use strict';
/**
 * Fraud-alert source-coverage tests (R3.14 fix, 2026-07-23).
 * Proves — via an injected fake client, no DB — that openMajorSignals:
 * (1) queries ALL fraud-relevant fatal sources (assignment_fraud, authenticity,
 *     entity_chain for identity fatals, independent_verification) instead of the
 *     old two-source list whose authenticity branch was dead code,
 * (2) keeps the cure_analysis bank_account_other_entity clause,
 * (3) passes rows through and fileBanner composes critical level + headline,
 * (4) never throws on a failing client.
 */
const assert = require('assert');
const fa = require('../src/lib/underwriting/fraud-alert');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- the query covers every fraud-relevant fatal source ---
let capturedSql = null, capturedParams = null;
const fakeClient = {
  query: async (sql, params) => {
    capturedSql = sql; capturedParams = params;
    return { rows: [{ id: 's1', source: 'entity_chain', title: 'SSN mismatch across documents', severity: 'fatal', confidence: null, created_at: new Date().toISOString() }] };
  },
};
(async () => {
  const rows = await fa.openMajorSignals('app-1', fakeClient);
  assert.strictEqual(rows.length, 1, 'rows pass through');
  assert.ok(/source = ANY\(\$2\)/.test(capturedSql), 'sources are parameterized via ANY($2)');
  const sources = capturedParams[1];
  for (const s of ['assignment_fraud', 'authenticity', 'entity_chain', 'independent_verification']) {
    assert.ok(sources.includes(s), `fatal source list includes ${s}`);
  }
  assert.ok(/cure_analysis/.test(capturedSql) && /bank_account_other_entity/.test(capturedSql), 'the cure_analysis bank-account clause is kept');
  assert.ok(/severity = 'fatal'/.test(capturedSql), 'only FATAL rows raise the banner');
  ok('openMajorSignals covers assignment_fraud + authenticity + entity_chain + independent_verification fatals + the cure clause');

  // --- HIGH_CONF_SOURCES exported set matches ---
  for (const s of ['assignment_fraud', 'authenticity', 'entity_chain', 'independent_verification']) {
    assert.ok(fa.HIGH_CONF_SOURCES.has(s), `HIGH_CONF_SOURCES has ${s}`);
  }
  ok('HIGH_CONF_SOURCES matches the query source set');

  // --- fileBanner composes critical level from a fatal signal (no snooze row) ---
  const bannerClient = {
    query: async (sql) => {
      if (/FROM ai_suggestions/.test(sql)) {
        return { rows: [
          { id: 'a', source: 'authenticity', title: 'A key document shows strong signs of tampering', severity: 'fatal', confidence: null, created_at: 'x' },
          { id: 'b', source: 'independent_verification', title: 'Recorded owner does not match the contract seller', severity: 'fatal', confidence: 0.9, created_at: 'y' },
        ] };
      }
      return { rows: [] }; // no snooze stamp
    },
  };
  const banner = await fa.fileBanner('app-1', bannerClient);
  assert.ok(banner, 'a banner is produced');
  assert.strictEqual(banner.level, 'critical');
  assert.strictEqual(banner.signals.length, 2);
  assert.ok(/2 major fraud/.test(banner.headline));
  ok('fileBanner composes a critical banner from authenticity + verification fatals');

  // --- a failing client is silent (never throws) ---
  const boomClient = { query: async () => { throw new Error('boom'); } };
  assert.deepStrictEqual(await fa.openMajorSignals('app-1', boomClient), []);
  assert.strictEqual(await fa.fileBanner('app-1', boomClient), null);
  ok('a failing client degrades silently (never throws)');

  console.log(`\nfraud-alert sources pure — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });

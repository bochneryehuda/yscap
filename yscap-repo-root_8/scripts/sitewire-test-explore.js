#!/usr/bin/env node
'use strict';
/**
 * CLI: read-only Sitewire TEST-environment capability explorer.
 * Requires the TEST creds in the environment (never pasted in chat):
 *   SITEWIRE_TEST_ACCESS_TOKEN, SITEWIRE_TEST_CLIENT, SITEWIRE_TEST_UID, [SITEWIRE_TEST_BASE_URL], [SITEWIRE_TEST_LENDER_ID]
 * Prints the discovered field catalog (values redacted). GET-only; it cannot write to Sitewire.
 *
 *   node scripts/sitewire-test-explore.js [sampleProperties] [sampleDraws]
 */
const explorer = require('../src/sitewire/test-explorer');

(async () => {
  if (!explorer.testConfigured()) {
    console.error('SITEWIRE_TEST_ACCESS_TOKEN / _CLIENT / _UID are not all set. Put the TEST key in the environment (Render), never in chat.');
    process.exit(2);
  }
  const sampleProperties = Math.min(20, Math.max(1, parseInt(process.argv[2], 10) || 5));
  const sampleDraws = Math.min(20, Math.max(1, parseInt(process.argv[3], 10) || 5));
  const r = await explorer.explore({ sampleProperties, sampleDraws });
  console.log(`\nSitewire TEST explore — base=${r.base_url} lender=${r.lender_id}`);
  console.log('counts:', JSON.stringify(r.counts || {}));
  if (r.errors && r.errors.length) console.log('errors:', r.errors.join(' | '));
  for (const [type, fields] of Object.entries(r.catalog || {})) {
    console.log(`\n### ${type}`);
    for (const f of fields) {
      const mark = f.integrated ? '  [have]' : '* [NEW ]';
      const enums = f.enum_values ? `  values=${JSON.stringify(f.enum_values)}` : '';
      console.log(`${mark} ${f.name} : ${f.type}${enums}`);
    }
  }
  console.log(`\n${(r.new_fields || []).length} not-yet-integrated fields discovered (the build backlog).`);
  process.exit(0);
})().catch((e) => { console.error('THREW', e && e.message); process.exit(1); });

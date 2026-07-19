/**
 * Unit tests for the admin "send myself a test envelope" tool
 * (src/lib/esign/test-send.js). No DB, no DocuSign — a stub db + fake docusign.
 * Confirms the safety guards: refuses when sending is off, blocks any recipient
 * not on the test allow-list, refuses when the staff account has no email, and
 * sends to an allow-listed address.
 *
 * Run: node scripts/test-esign-test-send.js
 */
const assert = require('assert');
const path = require('path');
const R = path.resolve(__dirname, '..');
const cfg = require(R + '/src/config').docusign;
const ts = require(R + '/src/lib/esign/test-send');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const fakeDs = (demo = false) => ({
  isDemoHost: () => demo,
  buildEnvelopeDefinition: (x) => ({ __def: x }),
  createEnvelope: async () => ({ envelopeId: 'ENV-TEST-1' }),
});
const stubDb = (email) => ({ query: async () => ({ rows: email ? [{ email, full_name: 'Test Admin' }] : [] }) });

(async () => {
  const savedEnabled = cfg.sendEnabled, savedTest = cfg.testMode, savedAllow = cfg.testEmailAllowlist;

  // 1. sending master switch OFF → refuse (no envelope built)
  cfg.sendEnabled = false;
  await assert.rejects(
    () => ts.sendTestEnvelope({ actorId: 'x', db: stubDb('a@b.com'), docusign: fakeDs() }),
    (e) => /DOCUSIGN_SEND_ENABLED/.test(e.message) && e.retryable === false, 'refuses when sending off'); n++;

  // 2. sending ON + test mode + email NOT on the allow-list → blocked backstop
  cfg.sendEnabled = true; cfg.testMode = true; cfg.testEmailAllowlist = ['yehuda@yscapgroup.com'];
  await assert.rejects(
    () => ts.sendTestEnvelope({ actorId: 'x', db: stubDb('stranger@example.com'), docusign: fakeDs() }),
    (e) => /allow-?list/i.test(e.message), 'blocks a non-allow-listed recipient'); n++;

  // 3. sending ON + allow-listed email → succeeds, to that email
  const r = await ts.sendTestEnvelope({ actorId: 'x', db: stubDb('yehuda@yscapgroup.com'), docusign: fakeDs() });
  ok(r.to === 'yehuda@yscapgroup.com' && /^ENV-/.test(r.envelopeId), 'sends to the allow-listed address');

  // 4. staff account has no email → refuse
  await assert.rejects(
    () => ts.sendTestEnvelope({ actorId: 'x', db: stubDb(null), docusign: fakeDs() }),
    (e) => /no email/i.test(e.message), 'refuses when the staff account has no email'); n++;

  // 5. the sample loan is obviously fake (never mistaken for a real file)
  const s = ts.sampleData();
  ok(s.loanNumber === 'YS-TEST-0000' && s.bLast === 'Borrower' && !s.hasCoBorrower, 'sample loan is clearly a test');

  cfg.sendEnabled = savedEnabled; cfg.testMode = savedTest; cfg.testEmailAllowlist = savedAllow;
  console.log(`\n✓ esign test-send: ${n} assertions passed`);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });

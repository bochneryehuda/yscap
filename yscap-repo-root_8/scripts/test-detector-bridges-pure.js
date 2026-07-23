'use strict';
/**
 * Fix 2026-07-23 (#211) — detector-bridge wiring regressions:
 *   1. the bank suggestion bridge accepts a NULL documentId (file-level roll-up
 *      findings) — the old caller passed app.id, violating the
 *      ai_suggestions.document_id FK and aborting the whole file-view sync tx;
 *   2. no route calls a non-existent .analyzeAndRecord on entity-chain /
 *      bank-statement-checks (the dead "Re-run AI checks" arms);
 *   3. the file-view sync + rerun bridges run under per-step SAVEPOINTs so one
 *      failure can't poison the shared transaction.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- 1. bank bridge with a null documentId records app-level suggestions -----
const bridge = require('../src/lib/underwriting/bank-statement-suggestions');
function fakeClient(state) {
  return {
    async query(sql, params) {
      const s = String(sql);
      if (/FROM ai_silenced_codes/.test(s)) return { rows: [], rowCount: 0 };
      if (/SELECT id FROM ai_suggestions/.test(s)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO ai_suggestions/.test(s)) {
        // params: [appId, documentId, checklistItemId, source, kind, title, body,
        //          evidence, action, severity, confidence, traceUrl, dedupe, important]
        state.inserts.push({ appId: params[0], documentId: params[1], dedupe: params[12] });
        return { rows: [{ id: `sug-${state.inserts.length}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}
(async () => {
  const state = { inserts: [] };
  const r = await bridge.syncBankFindingsToSuggestions(fakeClient(state), 'app-1', null, [
    { code: 'bank_liquidity_short', severity: 'warning', title: 'Short of required liquidity' },
    { code: 'bank_no_ending_balance', severity: 'warning', title: 'No ending balance' },
  ]);
  assert.strictEqual(r.recorded, 2, 'both file-level findings record');
  assert.ok(state.inserts.every((i) => i.documentId === null),
    'documentId is NULL — never a fake doc id that violates the FK');
  assert.ok(state.inserts.every((i) => /^bank:file:/.test(i.dedupe)),
    `dedupe is file-scoped (got ${state.inserts.map((i) => i.dedupe).join(', ')})`);
  ok('bank bridge: null documentId records app-level suggestions with a file-scoped dedupe');

  // A real per-document call still scopes to the document.
  const state2 = { inserts: [] };
  await bridge.syncBankFindingsToSuggestions(fakeClient(state2), 'app-1', 'doc-9', [
    { code: 'bank_missing_page', severity: 'fatal', title: 'Missing page' },
  ]);
  assert.strictEqual(state2.inserts[0].documentId, 'doc-9');
  assert.strictEqual(state2.inserts[0].dedupe, 'bank:doc-9:bank_missing_page');
  ok('bank bridge: a per-document call still scopes the dedupe to the document');

  // --- 2. no caller reaches for the never-exported analyzeAndRecord ---------
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'underwriting.js'), 'utf8');
  assert.ok(!/\/entity-chain'\)\.analyzeAndRecord/.test(src),
    'entity-chain has no analyzeAndRecord — the rerun arm must use buildChain + syncChainsToSuggestions');
  assert.ok(!/\/bank-statement-checks'\)\.analyzeAndRecord/.test(src),
    'bank-statement-checks has no analyzeAndRecord — the rerun arm must use the liquidity + bridge path');
  const ec = require('../src/lib/underwriting/entity-chain');
  const bs = require('../src/lib/underwriting/bank-statement-checks');
  assert.strictEqual(typeof ec.analyzeAndRecord, 'undefined');
  assert.strictEqual(typeof bs.analyzeAndRecord, 'undefined');
  ok('no route calls the never-exported analyzeAndRecord on entity-chain / bank checks');

  // --- 3. the shared-tx passes are savepoint-guarded ------------------------
  assert.ok(/SAVEPOINT view_sync/.test(src) && /ROLLBACK TO SAVEPOINT view_sync/.test(src),
    'file-view sync steps run under per-step savepoints');
  assert.ok(/SAVEPOINT rerun_bridge/.test(src) && /ROLLBACK TO SAVEPOINT rerun_bridge/.test(src),
    'rerun-checks bridges run under per-bridge savepoints');
  ok('both shared-transaction detector passes are savepoint-guarded (no poisoned tx)');

  console.log(`\ndetector-bridges pure — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });

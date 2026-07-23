'use strict';
/**
 * Audit fix 2026-07-23 (found by the CI Postgres soak) — the three learning
 * captures run on the CALLER's client, usually inside the caller's
 * BEGIN/COMMIT. A bare catch swallowed the JS error but left the Postgres
 * transaction ABORTED: every later statement failed 25P02 and COMMIT silently
 * acted as ROLLBACK — a staff resolve reported ok:true and never persisted.
 * These tests prove (with a scripted fake pg client) that each capture now
 * runs under a SAVEPOINT: a failing INSERT rolls back TO THE SAVEPOINT and
 * the caller's transaction stays usable.
 */
const assert = require('assert');
const learning = require('../src/lib/underwriting/learning');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

function fakeClient({ failInserts = false, inTx = true } = {}) {
  const state = { calls: [], aborted: false };
  state.client = {
    async query(sql, params) {
      const s = String(sql);
      state.calls.push(s.split(/\s+/).slice(0, 3).join(' '));
      if (/^SAVEPOINT/.test(s)) {
        if (!inTx) { const e = new Error('SAVEPOINT can only be used in transaction blocks'); e.code = '25P01'; throw e; }
        return { rows: [] };
      }
      if (/^RELEASE SAVEPOINT/.test(s)) return { rows: [] };
      if (/^ROLLBACK TO SAVEPOINT/.test(s)) { state.aborted = false; return { rows: [] }; }
      if (state.aborted) { const e = new Error('current transaction is aborted'); e.code = '25P02'; throw e; }
      if (/^INSERT/.test(s) && failInserts) {
        if (inTx) state.aborted = true;   // a failed statement aborts a real tx
        const e = new Error('violates foreign key constraint'); e.code = '23503'; throw e;
      }
      if (/^INSERT/.test(s)) return { rows: [{ id: 'row-1' }], rowCount: 1 };
      if (/^SELECT/.test(s)) return { rows: [], rowCount: 0 };
      if (/^UPDATE/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
  return state;
}

const FINDING = { id: 'f1', application_id: 'app-1', code: 'x', severity: 'warning' };

(async () => {
  // 1. Happy path unchanged: the capture records and returns the id.
  {
    const st = fakeClient();
    const id = await learning.captureFindingDecision(st.client, { finding: FINDING, action: 'dismiss', actorId: 's1' });
    assert.strictEqual(id, 'row-1');
    assert.ok(st.calls.some((c) => c.startsWith('SAVEPOINT')), 'runs under a savepoint');
    assert.ok(st.calls.some((c) => c.startsWith('RELEASE')), 'releases on success');
    ok('captureFindingDecision: happy path records under a savepoint');
  }

  // 2. THE BUG: a failing INSERT inside the caller's tx must NOT leave it aborted.
  {
    const st = fakeClient({ failInserts: true });
    const id = await learning.captureFindingDecision(st.client, { finding: FINDING, action: 'dismiss', actorId: 'not-a-staff-id' });
    assert.strictEqual(id, null, 'best-effort still returns null');
    assert.strictEqual(st.aborted, false, 'ROLLBACK TO SAVEPOINT un-poisoned the tx');
    // The caller's NEXT statement must succeed (this is what failed with 25P02 before).
    const next = await st.client.query('SELECT 1 FROM document_findings');
    assert.ok(next, 'the caller transaction is still usable after a capture failure');
    ok('captureFindingDecision: a failed capture cannot poison the caller transaction');
  }

  // 3. Same guarantee for the other two captures.
  {
    const st = fakeClient({ failInserts: true });
    const id = await learning.captureFactCorrection(st.client, { appId: 'app-1', factKey: 'k', actorId: 'bad' });
    assert.strictEqual(id, null);
    assert.strictEqual(st.aborted, false);
    ok('captureFactCorrection: savepoint-guarded');
  }
  {
    const st = fakeClient({ failInserts: true });
    const id = await learning.captureAdminAnswer(st.client, { applicationId: 'app-1', agent: 'cure', question: 'q?', answer: 'a' });
    assert.strictEqual(id, null);
    assert.strictEqual(st.aborted, false);
    ok('captureAdminAnswer: savepoint-guarded');
  }

  // 4. Outside a transaction the SAVEPOINT itself fails — the capture still
  // works bare (autocommit can't be poisoned).
  {
    const st = fakeClient({ inTx: false });
    const id = await learning.captureFindingDecision(st.client, { finding: FINDING, action: 'dismiss', actorId: 's1' });
    assert.strictEqual(id, 'row-1', 'no-tx callers still record');
    ok('outside a transaction the capture runs bare and still records');
  }

  console.log(`\nlearning tx-safe pure — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });

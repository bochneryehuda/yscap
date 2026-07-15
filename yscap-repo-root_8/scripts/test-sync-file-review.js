'use strict';
/**
 * File-level sync-review actions — validation-surface tests (no DB needed).
 * Covers: the REASON_ACTIONS contract, the synthetic dedup key, every
 * pre-database validation rejection in applyFileReviewAction, and a
 * drift check that the UI (SyncReviews.jsx) carries copy + buttons for every
 * reason/action the server offers.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SFR = require('../src/lib/sync-file-review');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}
async function ta(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}
async function expectHttp(status, fn) {
  try { await fn(); throw new Error('expected a thrown httpError, got success'); }
  catch (e) {
    if (e.status !== status) throw new Error(`expected status ${status}, got ${e.status || 'none'} (${e.message})`);
  }
}

(async () => {
  // ---- contract shape ------------------------------------------------------
  t('REASON_ACTIONS lists the five stuck states', () => {
    const keys = Object.keys(SFR.REASON_ACTIONS).sort();
    assert.deepStrictEqual(keys, [
      'file_not_materialized_ambiguous', 'file_not_materialized_duplicate_pending',
      'file_unlinked_no_task', 'push_dead_lettered', 'task_deleted_needs_decision'].sort());
    for (const k of keys) assert.ok(SFR.REASON_ACTIONS[k].length >= 1, `${k} has at least one action`);
  });
  t('isActionAllowed enforces the per-reason list', () => {
    assert.strictEqual(SFR.isActionAllowed('file_not_materialized_ambiguous', 'create_file'), true);
    assert.strictEqual(SFR.isActionAllowed('file_not_materialized_ambiguous', 'link_existing'), true);
    assert.strictEqual(SFR.isActionAllowed('file_not_materialized_ambiguous', 'retry_push'), false);
    assert.strictEqual(SFR.isActionAllowed('push_dead_lettered', 'retry_push'), true);
    assert.strictEqual(SFR.isActionAllowed('push_dead_lettered', 'archive_file'), false);
    assert.strictEqual(SFR.isActionAllowed('task_deleted_needs_decision', 'archive_file'), true);
    assert.strictEqual(SFR.isActionAllowed('task_deleted_needs_decision', 'keep_file'), true);
    assert.strictEqual(SFR.isActionAllowed('file_unlinked_no_task', 'create_task'), true);
    assert.strictEqual(SFR.isActionAllowed('nonsense_reason', 'create_file'), false);
    assert.strictEqual(SFR.isActionAllowed('dob_change_blocked_pending_review', 'create_file'), false, 'field-value reasons offer no file actions');
  });
  t('syntheticTaskKey namespaces and never collides with a ClickUp id', () => {
    assert.strictEqual(SFR.syntheticTaskKey('abc-123'), 'app:abc-123');
    assert.ok(SFR.syntheticTaskKey('x').startsWith('app:'));
  });

  // ---- terminal-status classification (the successor-deal exception) -------
  // Root-caused 2026-07-15 (Shulom Eisenberg / 521 Bayway): a funded successor
  // task sat 'duplicate_pending' forever behind its CANCELLED predecessor —
  // the defer must only wait on siblings whose deal is still ACTIVE.
  t('isTerminal: finished deals free their address for a successor', () => {
    const S = require('../src/clickup/status');
    assert.strictEqual(S.isTerminal('closed (6-email funded)'), true, 'funded is terminal');
    assert.strictEqual(S.isTerminal('cancelled & reconciled'), true, 'cancelled & reconciled is terminal');
    assert.strictEqual(S.isTerminal('cancelled'), true);
    assert.strictEqual(S.isTerminal('Declined'), true, 'case-insensitive');
    assert.strictEqual(S.isTerminal('trash'), true);
    assert.strictEqual(S.isTerminal('refinanced'), true);
    assert.strictEqual(S.isTerminal('non del closed reconciled'), true);
    assert.strictEqual(S.isTerminal('file being worked'), false, 'active deal is NOT terminal');
    assert.strictEqual(S.isTerminal('starting'), false);
    assert.strictEqual(S.isTerminal('inactive / on hold'), false, 'on-hold still owns its address');
    assert.strictEqual(S.isTerminal('scheduling closing'), false);
    assert.strictEqual(S.isTerminal('in underwriting'), false);
    assert.strictEqual(S.isTerminal(''), false, 'blank status is not terminal');
    assert.strictEqual(S.isTerminal(null), false);
  });

  // ---- validation rejections (all fire BEFORE any DB/API work) -------------
  await ta('unknown action → 400', () =>
    expectHttp(400, () => SFR.applyFileReviewAction({ row: { reason: 'push_dead_lettered' }, action: 'create_file' })));
  await ta('create_file on a row with no real task → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'file_not_materialized_ambiguous', task_id: 'app:some-file' }, action: 'create_file' })));
  await ta('link_existing without a target → 400', () =>
    expectHttp(400, () => SFR.applyFileReviewAction({
      row: { reason: 'file_not_materialized_ambiguous', task_id: '868xyz' }, action: 'link_existing' })));
  await ta('link_existing on a taskless row → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'file_not_materialized_ambiguous', task_id: null }, action: 'link_existing', targetApplicationId: 'a' })));
  await ta('archive_file without a file → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'task_deleted_needs_decision', application_id: null }, action: 'archive_file' })));
  await ta('keep_file without a file → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'task_deleted_needs_decision', application_id: null }, action: 'keep_file' })));
  await ta('retry_push without a job reference → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'push_dead_lettered', raw_value: 'not-json' }, action: 'retry_push' })));
  await ta('create_task without a file → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'file_unlinked_no_task', application_id: null }, action: 'create_task' })));

  // ---- UI drift check: every server reason/action has screen copy ----------
  t('SyncReviews.jsx carries copy + buttons for every reason and action', () => {
    const jsx = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'screens', 'SyncReviews.jsx'), 'utf8');
    for (const reason of Object.keys(SFR.REASON_ACTIONS)) {
      assert.ok(jsx.includes(reason), `REASON_COPY/ACTIONS missing '${reason}' in SyncReviews.jsx`);
      for (const action of SFR.REASON_ACTIONS[reason]) {
        assert.ok(jsx.includes(`'${action}'`), `action '${action}' not rendered in SyncReviews.jsx`);
      }
    }
  });
  t('the built V2 bundle carries the file-level reasons (rebuilt after edits)', () => {
    const assets = path.join(__dirname, '..', 'web', 'v2', 'portal', 'assets');
    const bundle = fs.readdirSync(assets).find((f) => /^index-.*\.js$/.test(f));
    assert.ok(bundle, 'no built bundle found');
    const js = fs.readFileSync(path.join(assets, bundle), 'utf8');
    for (const marker of ['push_dead_lettered', 'task_deleted_needs_decision', 'file_unlinked_no_task', 'resolve-file']) {
      assert.ok(js.includes(marker), `built bundle missing '${marker}' — run: cd app-v2 && npm run build`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

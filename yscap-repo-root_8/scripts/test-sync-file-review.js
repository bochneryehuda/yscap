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
  t('REASON_ACTIONS lists the ten stuck states', () => {
    const keys = Object.keys(SFR.REASON_ACTIONS).sort();
    assert.deepStrictEqual(keys, [
      'file_not_materialized_ambiguous', 'file_not_materialized_duplicate_pending',
      'file_unlinked_no_task', 'file_dead_unlinked', 'push_dead_lettered', 'task_deleted_needs_decision',
      'sharepoint_match_uncertain', 'sharepoint_mirror_failed', 'borrower_identity_conflict',
      'shared_email_needs_reassignment'].sort());
    for (const k of keys) assert.ok(SFR.REASON_ACTIONS[k].length >= 1, `${k} has at least one action`);
  });
  await ta('allow_shared_email without the pair reference → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'shared_email_needs_reassignment', raw_value: 'not-json' }, action: 'allow_shared_email' })));
  // ---- split_borrower (the wrong-officer merge repair) ----------------------
  t('borrower_identity_conflict offers ONLY split_borrower', () => {
    assert.strictEqual(SFR.isActionAllowed('borrower_identity_conflict', 'split_borrower'), true);
    assert.strictEqual(SFR.isActionAllowed('borrower_identity_conflict', 'create_file'), false);
    assert.strictEqual(SFR.isActionAllowed('push_dead_lettered', 'split_borrower'), false, 'split never leaks onto other reasons');
  });
  await ta('split_borrower without a file → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'borrower_identity_conflict', application_id: null, borrower_id: 'b1' }, action: 'split_borrower' })));
  await ta('split_borrower without a person → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'borrower_identity_conflict', application_id: 'a1', borrower_id: null }, action: 'split_borrower' })));
  await ta('sp_rematch without any scope reference → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'sharepoint_match_uncertain', raw_value: 'not-json' }, action: 'sp_rematch' })));
  await ta('sp_retry_doc without a document reference → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'sharepoint_mirror_failed', raw_value: 'not-json' }, action: 'sp_retry_doc' })));

  // ---- address canonicalization: the pure geocode parser -------------------
  t('parseGeocodeResult: full street result → place row', () => {
    const CANON = require('../src/lib/address-canon');
    const out = CANON.parseGeocodeResult({ results: [{
      place_id: 'ChIJabc', formatted_address: '97 S Madison Ave #114, Spring Valley, NY 10977, USA',
      types: ['street_address'],
      geometry: { location: { lat: 41.11, lng: -74.04 } },
      address_components: [{ types: ['postal_code'], long_name: '10977' }],
    }] });
    assert.strictEqual(out.place_id, 'ChIJabc');
    assert.strictEqual(out.zip, '10977');
    assert.strictEqual(out.lat, 41.11);
  });
  t('parseGeocodeResult: locality-level (imprecise) result → null', () => {
    const CANON = require('../src/lib/address-canon');
    assert.strictEqual(CANON.parseGeocodeResult({ results: [{ place_id: 'x', types: ['locality'] }] }), null);
  });
  t('parseGeocodeResult: empty/missing results → null', () => {
    const CANON = require('../src/lib/address-canon');
    assert.strictEqual(CANON.parseGeocodeResult({ results: [] }), null);
    assert.strictEqual(CANON.parseGeocodeResult(null), null);
  });
  t('inputKey collapses whitespace + case (cache identity)', () => {
    const CANON = require('../src/lib/address-canon');
    assert.strictEqual(CANON.inputKey('  97 S  Madison AVE '), CANON.inputKey('97 s madison ave'));
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
    assert.strictEqual(SFR.isActionAllowed('file_unlinked_no_task', 'relink_task'), true);
    assert.strictEqual(SFR.isActionAllowed('file_dead_unlinked', 'relink_task'), true);
    assert.strictEqual(SFR.isActionAllowed('file_dead_unlinked', 'archive_file'), true);
    assert.strictEqual(SFR.isActionAllowed('file_dead_unlinked', 'keep_file'), true);
    assert.strictEqual(SFR.isActionAllowed('file_dead_unlinked', 'link_existing'), false, 'relink is via relink_task, not link_existing');
    assert.strictEqual(SFR.isActionAllowed('nonsense_reason', 'create_file'), false);
    assert.strictEqual(SFR.isActionAllowed('dob_change_blocked_pending_review', 'create_file'), false, 'field-value reasons offer no file actions');
  });
  t('syntheticTaskKey namespaces and never collides with a ClickUp id', () => {
    assert.strictEqual(SFR.syntheticTaskKey('abc-123'), 'app:abc-123');
    assert.ok(SFR.syntheticTaskKey('x').startsWith('app:'));
  });

  // ---- admin relink: the task-id/URL parser (pure; no DB) ------------------
  t('relink.parseTaskId pulls the id out of a pasted ClickUp URL or bare id', () => {
    const { parseTaskId } = require('../src/clickup/relink');
    assert.strictEqual(parseTaskId('868abc123'), '868abc123', 'bare id passes through');
    assert.strictEqual(parseTaskId('  868abc123  '), '868abc123', 'trims whitespace');
    assert.strictEqual(parseTaskId('https://app.clickup.com/t/868abc123'), '868abc123', 'plain /t/ URL');
    assert.strictEqual(parseTaskId('https://app.clickup.com/9006/v/li/x/t/868abc123?foo=1'), '868abc123', 'deep URL + query');
    assert.strictEqual(parseTaskId('868abc123?comment=42'), '868abc123', 'strips trailing query on a bare id');
    assert.strictEqual(parseTaskId(''), '', 'empty → empty');
    assert.strictEqual(parseTaskId(null), '', 'null → empty (no invented id)');
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
    // UNKNOWN statuses are never terminal — the keyword fallback is for
    // borrower-facing display only, not the materialization gate (a future
    // "funding scheduled" status must keep the duplicate-defer working).
    assert.strictEqual(S.isTerminal('funding scheduled'), false, 'unknown status → not terminal even if it keyword-matches funded');
    assert.strictEqual(S.isTerminal('recall pending review'), false, 'unknown status → not terminal even if it keyword-matches withdrawn');
  });

  await ta('review-action errors are marked expose (upstream ClickUp statuses are not relayed)', async () => {
    // The route relays a status verbatim ONLY when expose=true — a ClickUp
    // client error also carries .status and must map to 502, or an upstream
    // 401 would read as session-expiry and log the staff user out.
    try {
      await SFR.applyFileReviewAction({ row: { reason: 'push_dead_lettered' }, action: 'nope' });
      throw new Error('expected a throw');
    } catch (e) { assert.strictEqual(e.status, 400); assert.strictEqual(e.expose, true); }
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
  await ta('relink_task without a file → 409', () =>
    expectHttp(409, () => SFR.applyFileReviewAction({
      row: { reason: 'file_dead_unlinked', application_id: null }, action: 'relink_task', targetTaskId: '868xyz' })));
  await ta('relink_task without a target card → 400', () =>
    expectHttp(400, () => SFR.applyFileReviewAction({
      row: { reason: 'file_dead_unlinked', application_id: 'a1' }, action: 'relink_task', targetTaskId: null })));

  // ---- custom-value resolution: validation fires BEFORE any write ----------
  const AR = require('../src/lib/sync-autoresolve');
  await ta('custom resolve: empty value → 400', () =>
    expectHttp(400, () => AR.applyReviewWinner({ field_key: 'date_of_birth', borrower_id: 'b1' }, 'custom', '   ')));
  await ta('custom resolve: garbage DOB → 422', () =>
    expectHttp(422, () => AR.applyReviewWinner({ field_key: 'date_of_birth', borrower_id: 'b1' }, 'custom', 'not-a-date')));
  await ta('custom resolve: toddler DOB → 422 (adult plausibility holds)', () =>
    expectHttp(422, () => AR.applyReviewWinner({ field_key: 'date_of_birth', borrower_id: 'b1' }, 'custom', '2022-12-11')));
  await ta('custom resolve: partial SSN → 422', () =>
    expectHttp(422, () => AR.applyReviewWinner({ field_key: 'ssn', borrower_id: 'b1' }, 'custom', '123-45')));

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
    for (const marker of ['push_dead_lettered', 'task_deleted_needs_decision', 'file_unlinked_no_task',
      'file_dead_unlinked', 'relink_task', 'clickup/unlink', 'resolve-file']) {
      assert.ok(js.includes(marker), `built bundle missing '${marker}' — run: cd app-v2 && npm run build`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

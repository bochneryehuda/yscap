'use strict';
/**
 * Unit tests for the exception / override authority (exceptions.js). Pure — a fake `can`.
 * Tiered authority: granting an EXCEPTION on a fatal, CTC-blocking finding needs waive_conditions;
 * everything else (and exceptions on warnings) clears under the base sign_off_conditions gate.
 */
const assert = require('assert');
const { elevatedPermissionFor, canApply } = require('../src/lib/underwriting/exceptions');

// A `can` that grants only the listed permissions.
const canWith = (perms) => (actor, perm) => perms.includes(perm);

const fatalBlocking = { severity: 'fatal', blocks_ctc: true };
const fatalNonBlocking = { severity: 'fatal', blocks_ctc: false };
const warn = { severity: 'warning', blocks_ctc: false };

// ---- elevatedPermissionFor: only grant_exception on a fatal-blocking finding is elevated ----
{
  assert.strictEqual(elevatedPermissionFor('grant_exception', fatalBlocking), 'waive_conditions');
  assert.strictEqual(elevatedPermissionFor('grant_exception', warn), null, 'exception on a warning is routine');
  assert.strictEqual(elevatedPermissionFor('grant_exception', fatalNonBlocking), null, 'non-blocking fatal exception is routine');
  assert.strictEqual(elevatedPermissionFor('clear', fatalBlocking), null, 'clearing (asserting OK) is not an override');
  assert.strictEqual(elevatedPermissionFor('dismiss', fatalBlocking), null, 'dismiss is not an override');
  assert.strictEqual(elevatedPermissionFor('post_condition', fatalBlocking), null, 'posting a condition is not an override');
}

// ---- canApply: a processor (no waive) is blocked from a fatal exception; an underwriter passes -
{
  const processor = canWith(['sign_off_conditions']);
  const underwriter = canWith(['sign_off_conditions', 'waive_conditions']);

  const blocked = canApply({}, 'grant_exception', fatalBlocking, processor);
  assert.strictEqual(blocked.ok, false, 'processor cannot override a fatal blocking finding');
  assert.strictEqual(blocked.requiredPermission, 'waive_conditions');

  const allowed = canApply({}, 'grant_exception', fatalBlocking, underwriter);
  assert.strictEqual(allowed.ok, true, 'an underwriter (waive_conditions) can');
  assert.strictEqual(allowed.elevated, 'waive_conditions', 'the elevated authority is recorded');

  // The processor CAN still do everything else on the same fatal finding.
  for (const act of ['post_condition', 'request_document', 'fix_file', 'clear', 'dismiss']) {
    assert.strictEqual(canApply({}, act, fatalBlocking, processor).ok, true, `${act} needs only the base gate`);
  }
  // And an exception on a mere warning needs only the base gate.
  assert.strictEqual(canApply({}, 'grant_exception', warn, processor).ok, true);
}

// ---- the aliased verb (open_condition→post_condition etc.) is canonicalized before deciding ----
{
  const processor = canWith(['sign_off_conditions']);
  assert.strictEqual(canApply({}, 'open_condition', fatalBlocking, processor).ok, true, 'alias resolves to a base action');
}

console.log('test-underwriting-exceptions: tiered exception authority pass');

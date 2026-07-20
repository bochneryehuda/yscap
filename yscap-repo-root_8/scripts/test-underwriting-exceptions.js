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

// ---- elevatedPermissionFor: ANY verb that CLOSES a fatal-blocking dealbreaker is elevated ----
// (deep-audit 2026-07-20: the gate-clear effect, not the verb label, is what needs senior authority)
{
  for (const act of ['grant_exception', 'clear', 'fix_file', 'dismiss']) {
    assert.strictEqual(elevatedPermissionFor(act, fatalBlocking), 'waive_conditions', `${act} closes a fatal dealbreaker → elevated`);
  }
  // Verbs that DON'T unblock CTC stay at the base gate: keeping it open, or declining the loan.
  assert.strictEqual(elevatedPermissionFor('post_condition', fatalBlocking), null, 'posting a condition keeps it open → base');
  assert.strictEqual(elevatedPermissionFor('request_document', fatalBlocking), null, 'requesting a doc keeps it open → base');
  assert.strictEqual(elevatedPermissionFor('decline', fatalBlocking), null, 'declining the loan is not leniency → base');
  // On a warning / non-blocking fatal, nothing is elevated.
  assert.strictEqual(elevatedPermissionFor('grant_exception', warn), null, 'exception on a warning is routine');
  assert.strictEqual(elevatedPermissionFor('clear', warn), null, 'clearing a warning is routine');
  assert.strictEqual(elevatedPermissionFor('dismiss', fatalNonBlocking), null, 'a non-blocking fatal is routine');
}

// ---- canApply: a processor (no waive) can't wave off a dealbreaker; an underwriter can ----
{
  const processor = canWith(['sign_off_conditions']);
  const underwriter = canWith(['sign_off_conditions', 'waive_conditions']);

  // Every gate-clearing verb is blocked for a processor on a fatal blocking finding.
  for (const act of ['grant_exception', 'clear', 'fix_file', 'dismiss']) {
    const blocked = canApply({}, act, fatalBlocking, processor);
    assert.strictEqual(blocked.ok, false, `processor cannot ${act} a fatal blocking dealbreaker`);
    assert.strictEqual(blocked.requiredPermission, 'waive_conditions');
    const allowed = canApply({}, act, fatalBlocking, underwriter);
    assert.strictEqual(allowed.ok, true, `an underwriter (waive_conditions) can ${act}`);
    assert.strictEqual(allowed.elevated, 'waive_conditions', 'the elevated authority is recorded');
  }
  // The processor CAN still remediate (keep it open) or decline on the same fatal finding.
  for (const act of ['post_condition', 'request_document', 'decline']) {
    assert.strictEqual(canApply({}, act, fatalBlocking, processor).ok, true, `${act} needs only the base gate`);
  }
  // And clearing a mere warning needs only the base gate.
  assert.strictEqual(canApply({}, 'clear', warn, processor).ok, true);
  assert.strictEqual(canApply({}, 'grant_exception', warn, processor).ok, true);
}

// ---- the aliased verb (open_condition→post_condition etc.) is canonicalized before deciding ----
{
  const processor = canWith(['sign_off_conditions']);
  assert.strictEqual(canApply({}, 'open_condition', fatalBlocking, processor).ok, true, 'alias resolves to a base action');
}

console.log('test-underwriting-exceptions: tiered exception authority pass');

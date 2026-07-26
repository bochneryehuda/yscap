'use strict';
/**
 * #202 (R6.18) — pure tests for the route-facing issuance backstop. Proves the
 * governing-rule invariants:
 *   • clear / advisory tiers always proceed, no hard warning;
 *   • a fatal tier is a super-admin-overridable HARD WARNING — a super-admin
 *     ALWAYS proceeds (recorded as an override with a reason); anyone else is
 *     asked to escalate (needsSuperAdminOverride), NEVER an un-overridable block;
 *   • the CARDINAL INVARIANT: for ANY input, a super-admin proceeds;
 *   • actionForStatus maps funded→funding, clear_to_close→ctc, else null;
 *   • hostile input fails OPEN to a non-blocking advisory and never throws.
 */
const assert = require('assert');
const bs = require('../src/lib/underwriting/issuance-backstop');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const fatal = { tier: 'fatal', action: 'funding', status: 'ineligible', reason: 'confirmed fatal', fatals: [{ code: 'x', severity: 'fatal' }], advisories: [] };
const advisory = { tier: 'advisory', action: 'ctc', status: 'manual', reason: 'manual pending', fatals: [], advisories: [{ code: 'm' }] };
const clear = { tier: 'clear', action: 'term_sheet', status: 'eligible', fatals: [], advisories: [] };

// 1. clear / advisory always proceed, no hard warning.
{
  const c = bs.decideBackstop(clear, { actorRole: 'loan_officer' });
  assert.strictEqual(c.proceed, true);
  assert.strictEqual(c.hardWarning, false);
  assert.strictEqual(c.needsSuperAdminOverride, false);
  const a = bs.decideBackstop(advisory, { actorRole: 'processor' });
  assert.strictEqual(a.proceed, true, 'an advisory never gates any staff');
  assert.strictEqual(a.hardWarning, false);
  assert.deepStrictEqual(a.advisories, [{ code: 'm' }]);
  ok('clear + advisory tiers always proceed for any staff, no hard warning');
}

// 2. fatal + non-super-admin → hard warning, escalate, but NEVER an un-overridable block.
{
  const r = bs.decideBackstop(fatal, { actorRole: 'underwriter' });
  assert.strictEqual(r.hardWarning, true);
  assert.strictEqual(r.proceed, false, 'a non-super-admin does not proceed past a confirmed fatal');
  assert.strictEqual(r.needsSuperAdminOverride, true, 'they are asked to escalate');
  assert.strictEqual(r.override.applied, false);
  assert.deepStrictEqual(r.fatals, [{ code: 'x', severity: 'fatal' }]);
  ok('fatal + non-super-admin → hard warning + escalate (never an un-overridable block)');
}

// 3. fatal + super-admin → ALWAYS proceeds; the override is recorded with a reason.
{
  const r = bs.decideBackstop(fatal, { actorRole: 'super_admin', overrideReason: 'verified with the seller directly' });
  assert.strictEqual(r.hardWarning, true, 'it is still a hard warning');
  assert.strictEqual(r.proceed, true, 'a super-admin ALWAYS proceeds');
  assert.strictEqual(r.needsSuperAdminOverride, false);
  assert.strictEqual(r.override.applied, true);
  assert.strictEqual(r.override.byRole, 'super_admin');
  assert.strictEqual(r.override.reason, 'verified with the seller directly');
  ok('fatal + super-admin → always proceeds; the override is recorded with a reason');
}

// 4. CARDINAL INVARIANT — a super-admin proceeds for ANY input.
{
  for (const input of [fatal, advisory, clear, null, undefined, 42, 'x', [], {}, { tier: 'nonsense' }, { tier: 'fatal' }]) {
    const r = bs.decideBackstop(input, { actorRole: 'super_admin' });
    assert.strictEqual(r.proceed, true, `a super-admin must proceed for ${JSON.stringify(input)}`);
  }
  ok('CARDINAL INVARIANT: a super-admin can proceed for every possible input');
}

// 5. actionForStatus mapping.
{
  assert.strictEqual(bs.actionForStatus('funded'), 'funding');
  assert.strictEqual(bs.actionForStatus('clear_to_close'), 'ctc');
  assert.strictEqual(bs.actionForStatus('CLEAR_TO_CLOSE'), 'ctc');
  assert.strictEqual(bs.actionForStatus('underwriting'), null);
  assert.strictEqual(bs.actionForStatus(null), null);
  ok('actionForStatus maps funded→funding, clear_to_close→ctc, else null');
}

// 6. hostile input fails OPEN to a non-blocking advisory; never throws.
{
  for (const bad of [null, undefined, 42, 'x', [], { tier: 7 }, { fatals: 'z' }]) {
    assert.doesNotThrow(() => bs.decideBackstop(bad, bad));
    const r = bs.decideBackstop(bad, {});
    assert.strictEqual(r.proceed, true, 'fail OPEN — never a hard block on bad input');
    assert.strictEqual(r.hardWarning, false);
    assert.ok(!('block' in r) && !('blocks' in r));
  }
  // override is only "applied" for a super-admin proceeding past a real fatal —
  // a requested override on an advisory does nothing.
  const noop = bs.decideBackstop(advisory, { actorRole: 'super_admin', override: true, overrideReason: 'x' });
  assert.strictEqual(noop.override.applied, false, 'no override is recorded when there is no fatal to override');
  ok('hostile input fails OPEN to a non-blocking advisory; never throws');
}

console.log(`\nissuance-backstop pure — ${passed} checks passed`);

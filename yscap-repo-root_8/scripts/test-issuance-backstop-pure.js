'use strict';
/**
 * #202 (R6.18) — pure tests for the route-facing issuance backstop.
 *
 * TWO POSTURES are covered, because the owner asked for advisory-only "till we
 * don't feel more comfortable with it" and the enforcing half has to still work
 * when it is switched back on:
 *
 *  ADVISORY ONLY — the DEFAULT since 2026-07-27. Even a CONFIRMED FATAL is a note:
 *  every staffer proceeds, hardWarning is false, nothing is recorded as an override.
 *
 *  ENFORCING ({enforce:true}, or AI_FINDINGS_ENFORCE=1) — the original governing
 *  rules: a fatal tier is a super-admin-overridable HARD WARNING; a super-admin
 *  ALWAYS proceeds (recorded with a reason); anyone else escalates; NEVER an
 *  un-overridable block.
 *
 * Plus, in both postures: the CARDINAL INVARIANT that a super-admin proceeds for
 * ANY input, the actionForStatus mapping, and fail-OPEN on hostile input.
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

// 2. ENFORCING: fatal + non-super-admin → hard warning, escalate, but NEVER an un-overridable block.
{
  const r = bs.decideBackstop(fatal, { actorRole: 'underwriter', enforce: true });
  assert.strictEqual(r.hardWarning, true);
  assert.strictEqual(r.proceed, false, 'a non-super-admin does not proceed past a confirmed fatal');
  assert.strictEqual(r.needsSuperAdminOverride, true, 'they are asked to escalate');
  assert.strictEqual(r.override.applied, false);
  assert.deepStrictEqual(r.fatals, [{ code: 'x', severity: 'fatal' }]);
  ok('fatal + non-super-admin → hard warning + escalate (never an un-overridable block)');
}

// 3. ENFORCING: fatal + super-admin → ALWAYS proceeds; the override is recorded with a reason.
{
  const r = bs.decideBackstop(fatal, { actorRole: 'super_admin', overrideReason: 'verified with the seller directly', enforce: true });
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
  const noop = bs.decideBackstop(advisory, { actorRole: 'super_admin', override: true, overrideReason: 'x', enforce: true });
  assert.strictEqual(noop.override.applied, false, 'no override is recorded when there is no fatal to override');
  ok('hostile input fails OPEN to a non-blocking advisory; never throws');
}

// ---------------------------------------------------------------------------
// ADVISORY ONLY — the default posture (owner-directed 2026-07-27).
// ---------------------------------------------------------------------------

// 7. THE HEADLINE RULE: a confirmed fatal stops NOBODY. Not a loan officer, not a
//    processor — everybody proceeds, and nothing is a hard warning.
{
  for (const role of ['loan_officer', 'processor', 'underwriter', 'admin', 'super_admin', null, undefined, '']) {
    const r = bs.decideBackstop(fatal, { actorRole: role });
    assert.strictEqual(r.proceed, true, `advisory-only: ${role} must proceed past a confirmed fatal`);
    assert.strictEqual(r.hardWarning, false, `advisory-only: ${role} gets no hard warning`);
    assert.strictEqual(r.needsSuperAdminOverride, false, `advisory-only: ${role} is never told to escalate`);
    assert.strictEqual(r.advisoryOnly, true);
    assert.strictEqual(r.advisoryFatal, true, 'the screen can still say PILOT is unhappy');
  }
  ok('ADVISORY ONLY: a confirmed fatal never blocks any staff member, at any role');
}

// 8. Nothing is "overridden" in advisory mode, so nothing is RECORDED as an override —
//    the exception register must not fill with entries nobody chose to make.
{
  const r = bs.decideBackstop(fatal, { actorRole: 'super_admin', override: true, overrideReason: 'because' });
  assert.strictEqual(r.override.applied, false, 'advisory-only records no override');
  assert.strictEqual(r.override.byRole, null);
  assert.strictEqual(r.override.reason, null);
  ok('ADVISORY ONLY: proceeding is not an override, so none is recorded');
}

// 9. The FINDINGS are still fully reported — advisory means "do not gate", never "hide".
{
  const r = bs.decideBackstop(fatal, { actorRole: 'loan_officer' });
  assert.strictEqual(r.tier, 'fatal', 'the tier is unchanged — PILOT still calls it fatal');
  assert.deepStrictEqual(r.fatals, [{ code: 'x', severity: 'fatal' }]);
  assert.strictEqual(r.reason, 'confirmed fatal');
  ok('ADVISORY ONLY: the tier, the reason and the fatal list are still reported in full');
}

// 10. The env switch re-arms enforcement without a code change, and an explicit
//     opts.enforce still wins over it (so a caller can pin either posture).
{
  const prev = process.env.AI_FINDINGS_ENFORCE;
  try {
    process.env.AI_FINDINGS_ENFORCE = '1';
    const armed = bs.decideBackstop(fatal, { actorRole: 'underwriter' });
    assert.strictEqual(armed.hardWarning, true, 'AI_FINDINGS_ENFORCE=1 restores the hard warning');
    assert.strictEqual(armed.proceed, false);
    assert.strictEqual(armed.advisoryOnly, false);
    const pinned = bs.decideBackstop(fatal, { actorRole: 'underwriter', enforce: false });
    assert.strictEqual(pinned.proceed, true, 'an explicit enforce:false still wins');
    // The cardinal invariant holds in the armed posture too.
    assert.strictEqual(bs.decideBackstop(fatal, { actorRole: 'super_admin' }).proceed, true);
  } finally {
    if (prev === undefined) delete process.env.AI_FINDINGS_ENFORCE;
    else process.env.AI_FINDINGS_ENFORCE = prev;
  }
  ok('AI_FINDINGS_ENFORCE=1 re-arms enforcement; an explicit opts.enforce wins over the env');
}

console.log(`\nissuance-backstop pure — ${passed} checks passed`);

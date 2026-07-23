'use strict';
/**
 * #217 — pure tests for the never-block / two-tier issuance policy. Proves: the
 * gate's "allowed" is CLEAR; a NON-fatal block (manual_pending / stale / missing
 * decision) is an ORDINARY ADVISORY any staff can proceed past; a CONFIRMED-FATAL
 * block is a super-admin-overridable HARD WARNING; an UNGROUNDED/unconfirmed fatal
 * is downgraded to advisory (an AI extraction error can never force a super-admin
 * gate); and the CARDINAL INVARIANT — for ANY input a super-admin can proceed, so
 * the AI never produces an un-overridable block.
 */
const assert = require('assert');
const policy = require('../src/lib/underwriting/issuance-policy');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const gate = (over) => Object.assign({ allowed: false, action: 'ctc', status: 'MANUAL_PENDING', reason: 'x', blockers: [] }, over || {});
const fatal = (over) => Object.assign({ code: 'title_defect', severity: 'fatal', title: 'Confirmed lien' }, over || {});

// 1. allowed → clear, anyone proceeds, no warning.
{
  const r = policy.resolve(gate({ allowed: true, blockers: [] }), { actorRole: 'processor' });
  assert.strictEqual(r.tier, 'clear');
  assert.strictEqual(r.proceed, true);
  assert.strictEqual(r.hardWarning, false);
  ok('an allowed gate is CLEAR — anyone proceeds, no warning');
}

// 2. A non-fatal block (manual_pending, no fatal blocker) → ordinary advisory; any staff proceeds.
{
  const r = policy.resolve(gate({ allowed: false, status: 'MANUAL_PENDING', blockers: [] }), { actorRole: 'processor' });
  assert.strictEqual(r.tier, 'advisory');
  assert.strictEqual(r.proceed, true, 'a manual-pending state does not gate — any staff proceeds');
  assert.strictEqual(r.hardWarning, false);
  assert.strictEqual(r.needsSuperAdminOverride, false);
  ok('a non-fatal block is an ORDINARY advisory any staff proceeds past');
}

// 3. A CONFIRMED-FATAL block → super-admin-overridable HARD WARNING.
{
  const g = gate({ allowed: false, status: 'INELIGIBLE', blockers: [fatal()] });
  const proc = policy.resolve(g, { actorRole: 'processor' });
  assert.strictEqual(proc.tier, 'fatal');
  assert.strictEqual(proc.hardWarning, true);
  assert.strictEqual(proc.proceed, false, 'a processor cannot proceed past a confirmed fatal');
  assert.strictEqual(proc.needsSuperAdminOverride, true, 'they must escalate to a super-admin');
  const sa = policy.resolve(g, { actorRole: 'super_admin' });
  assert.strictEqual(sa.proceed, true, 'a super-admin CAN override a confirmed fatal');
  assert.strictEqual(sa.hardWarning, true, 'the hard warning still shows to the super-admin');
  ok('a confirmed fatal is a hard warning; only a super-admin can override it');
}

// 4. An UNGROUNDED / unconfirmed fatal is downgraded to advisory (never a super-admin gate).
{
  for (const marker of [{ grounded: false }, { unverified: true }, { source: 'grounding' }, { code: 'purchase_price_unconfirmed' }]) {
    const g = gate({ allowed: false, blockers: [fatal(marker)] });
    const r = policy.resolve(g, { actorRole: 'processor' });
    assert.strictEqual(r.tier, 'advisory', `an ungrounded fatal (${JSON.stringify(marker)}) is advisory, not a super-admin gate`);
    assert.strictEqual(r.proceed, true, 'any staff proceeds past an unconfirmed value');
  }
  ok('an ungrounded/unconfirmed fatal is downgraded to an advisory — no super-admin gate');
}

// 5. A mix (one confirmed fatal + one ungrounded fatal + one warning) → fatal tier, only the confirmed one counts.
{
  const g = gate({ allowed: false, blockers: [fatal(), fatal({ grounded: false }), { severity: 'warning' }] });
  const c = policy.classify(g);
  assert.strictEqual(c.tier, 'fatal');
  assert.strictEqual(c.fatals.length, 1, 'only the confirmed fatal is a fatal');
  assert.strictEqual(c.advisories.length, 2, 'the ungrounded fatal + the warning are advisories');
  ok('a mix classifies only the confirmed fatal as fatal; the rest are advisories');
}

// 6. CARDINAL INVARIANT: for a wide range of inputs, a super-admin can ALWAYS proceed.
{
  const cases = [
    gate({ allowed: true }),
    gate({ allowed: false, blockers: [] }),
    gate({ allowed: false, blockers: [fatal()] }),
    gate({ allowed: false, blockers: [fatal(), fatal({ severity: 'fatal' })] }),
    gate({ allowed: false, status: 'INELIGIBLE', blockers: [fatal({ code: 'hard_leverage_cap' })] }),
    null, undefined, 42, 'x', {},
  ];
  for (const c of cases) {
    const r = policy.resolve(c, { actorRole: 'super_admin' });
    assert.strictEqual(r.proceed, true, `a super-admin can always proceed (input ${JSON.stringify(c)})`);
  }
  ok('CARDINAL INVARIANT — a super-admin can always proceed; the AI never un-overridably blocks');
}

// 7. Hostile input never throws; degrades to a non-blocking advisory.
{
  for (const bad of [null, undefined, 42, 'x', [], { blockers: 'nope' }]) {
    assert.doesNotThrow(() => policy.classify(bad));
    const r = policy.resolve(bad, {});
    assert.strictEqual(r.proceed, true, 'bad input fails OPEN to a non-blocking advisory');
  }
  ok('hostile input never throws and fails open (never a hard block)');
}

console.log(`\nissuance-policy pure — ${passed} checks passed`);

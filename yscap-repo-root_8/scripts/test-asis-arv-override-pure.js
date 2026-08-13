'use strict';
/**
 * AS-IS / ARV super-admin override — the PURE pieces (no DB):
 *   · asisArvOverride.isAsIsArvOnly — the request must touch ONLY as-is / ARV.
 *   · fileLock.asIsArvTermSheetOverride — the freeze decision matrix (sibling of
 *     termsNeutralReregister): allow ONLY a super_admin, only when explicitly requested,
 *     REGARDLESS of neutrality (owner-directed 2026-08 "Save ARV, keep the loan" — the loan
 *     is held frozen by apply()'s re-assert, not by refusing a non-neutral save), and NEVER
 *     over a STATUS freeze (unlock is the path there).
 */
const assert = require('assert');
const ov = require('../src/lib/asis-arv-override');
const fileLock = require('../src/lib/file-lock');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eqNull = (v, m) => { assert.strictEqual(v, null, m); n++; };
const notNull = (v, m) => { assert.ok(typeof v === 'string' && v.length > 0, m); n++; };

/* ── isAsIsArvOnly ── */
ok(ov.isAsIsArvOnly({ asIsValue: 300000 }), 'as-is alone is as-is/ARV-only');
ok(ov.isAsIsArvOnly({ arv: 500000 }), 'ARV alone is as-is/ARV-only');
ok(ov.isAsIsArvOnly({ asIsValue: 300000, arv: 500000 }), 'both together is as-is/ARV-only');
ok(ov.isAsIsArvOnly({ asIsValue: 300000, adminOverride: true, overrideReason: 'fix', econVersion: 7 }),
  'the control keys (adminOverride/overrideReason/econVersion) are allowed alongside');
ok(!ov.isAsIsArvOnly({}), 'an empty body is not an as-is/ARV edit');
ok(!ov.isAsIsArvOnly({ adminOverride: true, overrideReason: 'x' }), 'control keys alone (no as-is/ARV) is NOT');
ok(!ov.isAsIsArvOnly({ asIsValue: 300000, purchasePrice: 100000 }), 'any other field (purchasePrice) disqualifies it');
ok(!ov.isAsIsArvOnly({ asIsValue: 300000, loanAmount: 1 }), 'any other field (loanAmount) disqualifies it');
ok(!ov.isAsIsArvOnly({ arv: 500000, program: 'gold' }), 'any other field (program) disqualifies it');

/* ── the freeze-decision matrix ── */
const superA = { kind: 'staff', role: 'super_admin' };
const adminA = { kind: 'staff', role: 'admin' };
const tsFrozen = { status: 'underwriting', ts_sent: true, structural_unlocked_at: null };
const notFrozen = { status: 'underwriting', ts_sent: false, structural_unlocked_at: null };
const ctcFrozen = { status: 'clear_to_close', ts_sent: true, structural_unlocked_at: null };
const ctcUnlocked = { status: 'clear_to_close', ts_sent: true, structural_unlocked_at: new Date('2026-08-01') };

const A = fileLock.asIsArvTermSheetOverride;
eqNull(A(notFrozen, true, { actor: superA, overrideRequested: true }),
  'not frozen at all → nothing to override (null)');
eqNull(A(tsFrozen, true, { actor: superA, overrideRequested: true }),
  'term-sheet frozen + super_admin + requested + neutral → ALLOWED');
// Owner-directed 2026-08 ("Save ARV, keep the loan"): a NON-neutral change is now ALSO
// allowed for a super_admin who requests it — the loan is kept frozen by apply()'s
// re-assert, not by refusing the save. Neutrality (true/false/unknown) no longer gates.
eqNull(A(tsFrozen, false, { actor: superA, overrideRequested: true }),
  'term-sheet frozen + NOT neutral + super_admin + requested → NOW ALLOWED (loan kept frozen by apply)');
eqNull(A(tsFrozen, null, { actor: superA, overrideRequested: true }),
  'term-sheet frozen + neutrality UNKNOWN (computeNeutral threw) + super_admin + requested → ALLOWED');
notNull(A(tsFrozen, true, { actor: superA, overrideRequested: false }),
  'term-sheet frozen but NOT explicitly requested → refused (the override must be asked for)');
notNull(A(tsFrozen, false, { actor: adminA, overrideRequested: true }),
  'term-sheet frozen + requested but a plain admin → refused (super_admin only)');
notNull(A(ctcFrozen, false, { actor: superA, overrideRequested: true }),
  'a STATUS freeze (clear-to-close) is NEVER lifted by this override, even super_admin+requested — unlock is the path');
eqNull(A(ctcUnlocked, false, { actor: superA, overrideRequested: true }),
  'a super-admin-UNLOCKED clear-to-close file → both freezes already lifted, so nothing to override (null)');
eqNull(A(null, false, { actor: superA, overrideRequested: true }),
  'no row → null (parity with the other lock helpers)');

console.log(`\n✓ asis-arv-override pure: ${n} assertions passed`);

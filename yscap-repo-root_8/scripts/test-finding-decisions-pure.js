#!/usr/bin/env node
'use strict';
/**
 * A HUMAN'S DECISION ON A FINDING IS DURABLE — pure tests (owner-reported 2026-07-27:
 * "I click Dismiss / the super-admin says it's OK, and the finding keeps popping up
 * again a minute afterwards").
 *
 * These cover the identity + policy layer with no database:
 *   • the ledger key is the SAME identity finding-claims already uses, so a decision
 *     taken on one desk is recognised on every other one;
 *   • the key is stable across a re-analysis (a fresh row for the same finding keys
 *     the same) and DISTINCT between genuinely different findings — the direction
 *     that matters, because a too-loose key would silently hide real work;
 *   • only SETTLING verbs suppress: "post a condition" / "request a document" must
 *     keep the finding live until the follow-up lands;
 *   • every function fails safe on hostile input and never throws;
 *   • the advisory-only policy switch reads the env at CALL time and defaults to
 *     advisory.
 * The DB half (carry-forward through a re-read, the ai_suggestions re-raise) is
 * covered by scripts/test-finding-decisions-db.js.
 */
const assert = require('assert');
const fdec = require('../src/lib/underwriting/finding-decisions');
const claims = require('../src/lib/underwriting/finding-claims');
const policy = require('../src/lib/underwriting/advisory-policy');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. ONE identity, shared with the desk's own de-duplication.
{
  const f = { code: 'id_expired', field: 'expiration', document_id: 'doc-1', doc_value: '2020-01-01' };
  assert.strictEqual(fdec.keyOf(f), claims.claimOf(f),
    'the ledger must key exactly like finding-claims, or a dismissal on one desk is invisible on another');
  ok('the ledger key IS the finding-claims claim key (one identity, every desk)');
}

// 2. STABLE ACROSS A RE-ANALYSIS. A re-read writes a brand-new row with a new id and
//    a new extraction id — the very thing that used to resurrect dismissed findings.
//    The key must not move.
{
  const before = { id: 'row-A', extraction_id: 'ext-1', code: 'bank_account_not_borrower', field: 'account_holder', document_id: 'doc-9', doc_value: 'ACME LLC' };
  const after = { id: 'row-B', extraction_id: 'ext-2', code: 'bank_account_not_borrower', field: 'account_holder', document_id: 'doc-9', doc_value: 'ACME LLC' };
  assert.strictEqual(fdec.keyOf(before), fdec.keyOf(after),
    'a re-read of the same document must produce the same key, or the dismissal is lost');
  ok('the key survives a re-analysis (new row id, new extraction id, same finding)');
}

// 3. DISTINCT for genuinely different findings — the dangerous direction. A key that
//    is too loose would suppress work nobody decided on.
{
  const base = { code: 'id_expired', field: 'expiration', document_id: 'doc-1', doc_value: '2020-01-01' };
  const otherDoc = { ...base, document_id: 'doc-2' };                 // co-borrower's ID
  const otherValue = { ...base, doc_value: '2019-05-05' };            // a different expiry
  const otherCode = { ...base, code: 'id_name_mismatch' };            // a different problem
  const keys = new Set([base, otherDoc, otherValue, otherCode].map(fdec.keyOf));
  assert.strictEqual(keys.size, 4, 'four different findings must produce four different keys');
  ok('a different document / value / code is a DIFFERENT finding — never collapsed');
}

// 4. The appraisal desk's column is `appraisal_value`; it must key like everyone else.
{
  const appr = { code: 'value_below_purchase', field: 'as_is_value', appraisal_value: '350000' };
  const same = { code: 'value_below_purchase', field: 'as_is_value', docValue: '350000' };
  assert.strictEqual(fdec.keyOf(appr), fdec.keyOf(same),
    'an appraisal finding must key the same as the equivalent document finding');
  ok('appraisal findings key on appraisal_value, matching every other desk');
}

// 5. Nothing stable to key on → no key, so nothing is recorded (never a guess).
{
  for (const bad of [null, undefined, {}, { field: 'x' }, 42, 'nope', []]) {
    assert.doesNotThrow(() => fdec.keyOf(bad));
    assert.strictEqual(fdec.keyOf(bad), null, 'a finding with no code has no identity');
  }
  ok('a finding with no code yields no key — the ledger records nothing rather than guessing');
}

// 6. ONLY SETTLING VERBS SUPPRESS. This is the safety line: "post a condition" and
//    "request a document" deliberately leave the finding OPEN until the follow-up
//    lands, so they must never silence it.
{
  for (const v of ['dismiss', 'clear', 'grant_exception', 'fix_file', 'decline', 'dismissed', 'converted_to_condition', 'noted']) {
    assert.strictEqual(fdec.suppresses(v), true, `${v} settles the finding`);
  }
  for (const v of ['post_condition', 'open_condition', 'request_document', 'request_revision',
    'downgrade_severity', 'upgrade_severity', 'escalate', 'escalated', 'mark_important',
    'marked_important', 'asked_admin', 'open', '', null, undefined, 'something_new']) {
    assert.strictEqual(fdec.suppresses(v), false, `${v} must NOT silence a finding`);
  }
  ok('only settling verbs suppress — a posted condition / requested document keeps the finding live');
}

// 7. filterSuppressed splits, preserves order, and is a no-op on an empty ledger.
{
  const a = { code: 'x', field: 'f', document_id: 'd1', doc_value: '1' };
  const b = { code: 'y', field: 'f', document_id: 'd1', doc_value: '2' };
  const c = { code: 'z', field: 'f', document_id: 'd1', doc_value: '3' };
  const set = new Set([fdec.keyOf(b)]);
  const r = fdec.filterSuppressed(set, [a, b, c]);
  assert.deepStrictEqual(r.kept, [a, c], 'the undecided findings survive, in order');
  assert.deepStrictEqual(r.suppressed, [b], 'the settled one is handed back, not thrown away');
  const none = fdec.filterSuppressed(new Set(), [a, b, c]);
  assert.deepStrictEqual(none.kept, [a, b, c]);
  assert.deepStrictEqual(none.suppressed, []);
  ok('filterSuppressed splits kept/suppressed, preserves order, no-ops on an empty ledger');
}

// 8. FAIL OPEN on hostile input: it may show a finding again, never hide one, never throw.
{
  for (const bad of [null, undefined, 42, 'x', {}, []]) {
    assert.doesNotThrow(() => fdec.isSuppressed(bad, { code: 'a' }));
    assert.strictEqual(fdec.isSuppressed(bad, { code: 'a' }), false);
    assert.doesNotThrow(() => fdec.filterSuppressed(bad, bad));
  }
  assert.deepStrictEqual(fdec.filterSuppressed(null, null).kept, []);
  ok('hostile input fails OPEN (shows the finding) and never throws');
}

// 8b. The severity a decision was made at is part of the rule, not decoration.
{
  const set = new Map([['code:c::f::::', fdec.sevRank('warning')]]);
  const at = (sev) => fdec.isSuppressed(set, { code: 'c', field: 'f', severity: sev });
  assert.strictEqual(at('warning'), true, 'the severity judged stays settled');
  assert.strictEqual(at('info'), true, 'and anything milder');
  assert.strictEqual(at('fatal'), false,
    'a DEALBREAKER must break through a decision made about a warning — that is a false clear');
  assert.strictEqual(at(' FATAL '), false, 'case and whitespace do not smuggle one past');
  assert.strictEqual(at('critical'), true, 'an unrecognised word ranks 0 and does not break through');
  // A legacy row (rank 0, decided before db/336) suppresses regardless — treating it as the
  // lowest rank would resurrect every dismissed fatal already on file.
  const legacy = new Map([['code:c::f::::', 0]]);
  assert.strictEqual(fdec.isSuppressed(legacy, { code: 'c', field: 'f', severity: 'fatal' }), true,
    'a decision taken before severity was recorded still suppresses');
  // A plain Set (any caller not yet migrated) still works and behaves as legacy.
  assert.strictEqual(fdec.isSuppressed(new Set(['code:c::f::::']), { code: 'c', field: 'f', severity: 'fatal' }),
    true, 'a Set still works — no caller breaks on the type change');
  ok('a decision on a warning does not silence a later fatal');
}

// 9. record/reopen refuse a bad client instead of throwing into a caller's transaction.
{
  const p = [fdec.record(null, { applicationId: 'a', finding: { code: 'c' }, decision: 'dismiss' }),
    fdec.record({}, {}), fdec.reopen(null, {}), fdec.suppressedKeys(null, 'a'), fdec.decisionsForFile(null, 'a')];
  Promise.all(p).then(([r1, r2, r3, keys, rows]) => {
    assert.strictEqual(r1, false); assert.strictEqual(r2, false); assert.strictEqual(r3, false);
    // `suppressedKeys` returns a MAP (finding_key -> the severity RANK it was decided at,
    // db/336) so `isSuppressed` can refuse to silence something worse than what was judged.
    // A Map has `.has()` and `.size`, so every caller that treats it as a set of keys is
    // unaffected — but the degraded path must return the same type as the happy one.
    assert.ok(keys instanceof Map && keys.size === 0);
    assert.deepStrictEqual(rows, []);
    ok('record/reopen/reads degrade to a safe no-op with no client — never throw at a caller');
    console.log(`\nfinding-decisions pure — ${passed} checks passed`);
  }).catch((e) => { console.error(e); process.exit(1); });
}

// 10. The advisory-only policy switch: default advisory, env re-arms, read at CALL time.
{
  const prev = process.env.AI_FINDINGS_ENFORCE;
  try {
    delete process.env.AI_FINDINGS_ENFORCE;
    assert.strictEqual(policy.advisoryOnly(), true, 'ADVISORY ONLY is the default posture');
    assert.strictEqual(policy.enforcing(), false);
    process.env.AI_FINDINGS_ENFORCE = '1';
    assert.strictEqual(policy.enforcing(), true, 'the env is read at call time, not cached at require time');
    assert.strictEqual(policy.advisoryOnly(), false);
    // Only an exact '1' arms it — a stray value must not silently start blocking loans.
    for (const v of ['0', 'true', 'yes', '', 'on']) {
      process.env.AI_FINDINGS_ENFORCE = v;
      assert.strictEqual(policy.enforcing(), false, `AI_FINDINGS_ENFORCE=${JSON.stringify(v)} must not arm enforcement`);
    }
    // An explicit per-call flag always wins over the env, in both directions.
    process.env.AI_FINDINGS_ENFORCE = '1';
    assert.strictEqual(policy.enforceFor({ enforce: false }), false);
    delete process.env.AI_FINDINGS_ENFORCE;
    assert.strictEqual(policy.enforceFor({ enforce: true }), true);
    assert.strictEqual(policy.enforceFor({ advisoryOnly: false }), true);
    assert.strictEqual(policy.enforceFor({}), false);
    assert.strictEqual(policy.enforceFor(undefined), false);
  } finally {
    if (prev === undefined) delete process.env.AI_FINDINGS_ENFORCE;
    else process.env.AI_FINDINGS_ENFORCE = prev;
  }
  ok('advisory-only by default; only AI_FINDINGS_ENFORCE=1 re-arms; an explicit flag wins');
}

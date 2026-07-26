'use strict';
/**
 * R5.58 — pure tests for continuation-page grouping + auto-orient plan. Proves a
 * multi-page bank statement stays ONE group (pagination + shared account tail),
 * a blank page separates groups, a different document type starts a new group,
 * and sideways/upside-down pages produce an orient plan. Advisory only — it
 * suggests boundaries; it never splits or rotates anything.
 */
const assert = require('assert');
const cg = require('../src/lib/underwriting/continuation-group');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- a 3-page bank statement continues via "Page X of 3" pagination ---
let r = cg.groupPages([
  { text: 'Wells Fargo statement Page 1 of 3 account ****1234' },
  { text: 'transactions continued Page 2 of 3' },
  { text: 'ending balance Page 3 of 3' },
]);
assert.strictEqual(r.groups.length, 1, 'three paginated pages → one group');
assert.deepStrictEqual(r.groups[0].pages, [1, 2, 3]);
assert.strictEqual(r.groups[0].reason, 'pagination');
ok('a 3-page "Page X of 3" statement stays one group');

// --- a blank page separates two documents ---
r = cg.groupPages([
  { text: 'first document has real readable content here', verdict: 'ok' },
  { text: '   ', verdict: 'blank' },
  { text: 'second document begins with its own content', verdict: 'ok' },
]);
assert.strictEqual(r.groups.length, 3, 'doc / separator / doc');
assert.strictEqual(r.groups[1].reason, 'separator');
assert.deepStrictEqual(r.groups[0].pages, [1]);
assert.deepStrictEqual(r.groups[2].pages, [3]);
ok('a blank page is its own separator group and breaks continuation');

// --- shared account tail keeps pages together even without pagination ---
r = cg.groupPages([
  { text: 'Chase checking account ****9981 opening balance' },
  { text: 'more Chase activity for account ****9981 mid-month' },
]);
assert.strictEqual(r.groups.length, 1, 'shared account tail → one group');
assert.strictEqual(r.groups[0].reason, 'shared_account_or_period');
ok('two pages sharing an account tail stay one group');

// --- a different document type starts a new group ---
r = cg.groupPages([
  { text: 'bank statement page one content', documentType: 'bank_statement' },
  { text: 'driver license front side content', documentType: 'photo_id' },
]);
assert.strictEqual(r.groups.length, 2, 'different doc types → two groups');
ok('a change of document type breaks continuation');

// --- sideways + upside-down pages produce an orient plan ---
r = cg.groupPages([
  { text: 'a normal upright page with content', verdict: 'ok', rotation: 0 },
  { text: 'a sideways scan that needs rotating', verdict: 'rotated', rotation: 90 },
  { text: 'an upside down scan that needs flipping', verdict: 'upside_down', rotation: 180 },
]);
assert.strictEqual(r.orientPlan.length, 2, 'two pages need reorientation');
assert.deepStrictEqual(r.orientPlan[0], { pageNumber: 2, from: 90, to: 0 });
assert.deepStrictEqual(r.orientPlan[1], { pageNumber: 3, from: 180, to: 0 });
ok('sideways + upside-down pages produce an orient plan (advisory)');

// --- deterministic: same input → same grouping ---
const input = [
  { text: 'statement Page 1 of 2 acct ****4444' },
  { text: 'statement Page 2 of 2 acct ****4444' },
];
assert.deepStrictEqual(cg.groupPages(input), cg.groupPages(input));
ok('grouping is deterministic (same input → same output)');

// --- internals: pageOf parses and rejects nonsense ---
assert.deepStrictEqual(cg._internals.pageOf('Page 2 of 5'), { n: 2, total: 5 });
assert.strictEqual(cg._internals.pageOf('Page 9 of 3'), null, 'n > total is rejected');
assert.strictEqual(cg._internals.pageOf('no pagination here'), null);
ok('pageOf parses "Page X of Y" and rejects impossible/absent pagination');

console.log(`\nR5.58 continuation-group pure — ${passed} checks passed`);

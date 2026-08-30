'use strict';
/**
 * THE OWNER DESCRIPTOR'S WHOLE TRUTH TABLE — the one shape every shared Condition
 * Center service takes (src/lib/condition-owner.js).
 *
 * WHY THIS SUITE IS WORTH ITS LINES. The module is small, and it is the thing that
 * decides WHICH PRODUCT a condition or a document belongs to. Every statement in
 * the shared upload / review / remove / serve doors is built from `ownerWhere` and
 * `ownerCols`, so a defect here does not produce a wrong page — it produces a
 * Long-Term document filed against an RTL loan, or an RTL document reachable from
 * a Long-Term door, with nothing anywhere going red. The two rules that carry that
 * weight are asserted from every angle below:
 *
 *   • an UNKNOWN scope THROWS and never falls back to a product;
 *   • the descriptor sets EXACTLY ONE owner column and NULLs the rest, so
 *     `chk_one_owner` (db/650) is satisfied by construction rather than by the
 *     caller remembering which columns exist this month.
 *
 * PURE — no database, no config, no network.
 */

const assert = require('assert');
const {
  ownerOf, ownerColumn, ownerWhere, ownerCols, OWNER_SCOPES, OWNER_COLUMN,
} = require('../src/lib/condition-owner');

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok - ${name}`); };

// ── A. The scope set is exactly the two products, and it is frozen ───────────
assert.deepStrictEqual([...OWNER_SCOPES].sort(), ['application', 'lt_loan'],
  'the descriptor must know exactly the two products');
assert.strictEqual(OWNER_COLUMN.application, 'application_id');
assert.strictEqual(OWNER_COLUMN.lt_loan, 'lt_loan_id');
assert.throws(() => { OWNER_COLUMN.sneaky = 'x'; }, /read only|not extensible|Cannot add/i,
  'the column map must be frozen — a scope added at runtime is a scope nobody reviewed');
ok('the scope set is exactly application + lt_loan, and the column map is frozen');

// ── B. ownerOf: the only way to make a descriptor ────────────────────────────
const APP = ownerOf('application', 'a1');
const LT = ownerOf('lt_loan', 'l1');
assert.deepStrictEqual({ ...APP }, { scope: 'application', id: 'a1' });
assert.deepStrictEqual({ ...LT }, { scope: 'lt_loan', id: 'l1' });
assert.throws(() => { APP.scope = 'lt_loan'; }, /read only|Cannot assign/i,
  'a descriptor must be frozen — moving a document between products is not an accident anyone may have');
ok('ownerOf builds a frozen {scope,id} for each product');

// ── C. AN UNKNOWN SCOPE THROWS — the whole reason this module exists ─────────
// Every one of these is a value that could plausibly reach a call site: a typo, a
// legacy scope from the other owner columns, a truthy-but-wrong value, an object.
// None of them may resolve to a product.
for (const bad of [
  'borrower_profile',           // a real checklist_items scope — but not a FILE owner
  'llc',                        // ditto
  'ltloan', 'lt-loan', 'LT_LOAN', 'Application', ' application ',
  '', null, undefined, 0, 1, true, false, {}, [], 'constructor', '__proto__', 'toString',
]) {
  assert.throws(() => ownerOf(bad, 'x'), (e) => e.code === 'UNKNOWN_OWNER_SCOPE',
    `ownerOf must THROW on scope ${JSON.stringify(bad)} — never default to a product`);
  assert.throws(() => ownerColumn({ scope: bad, id: 'x' }), (e) => e.code === 'UNKNOWN_OWNER_SCOPE',
    `ownerColumn must THROW on scope ${JSON.stringify(bad)}`);
  assert.throws(() => ownerWhere({ scope: bad, id: 'x' }), (e) => e.code === 'UNKNOWN_OWNER_SCOPE');
  assert.throws(() => ownerCols({ scope: bad, id: 'x' }), (e) => e.code === 'UNKNOWN_OWNER_SCOPE');
}
// `constructor` / `__proto__` / `toString` are in that list on purpose: a plain
// `OWNER_COLUMN[scope]` lookup answers a FUNCTION for each of them, so a
// prototype-chain hit would have read as a valid column name.
assert.throws(() => ownerWhere(null), (e) => e.code === 'UNKNOWN_OWNER_SCOPE');
assert.throws(() => ownerWhere(undefined), (e) => e.code === 'UNKNOWN_OWNER_SCOPE');
assert.throws(() => ownerCols({}), (e) => e.code === 'UNKNOWN_OWNER_SCOPE');
ok('an unknown scope THROWS on every entry point — including the prototype-chain names');

// ── D. A missing id THROWS — an owner with no id writes BOTH columns NULL ────
for (const bad of [undefined, null, '']) {
  assert.throws(() => ownerOf('application', bad), (e) => e.code === 'OWNER_ID_REQUIRED',
    `an application owner with id ${JSON.stringify(bad)} must be refused`);
  assert.throws(() => ownerOf('lt_loan', bad), (e) => e.code === 'OWNER_ID_REQUIRED');
}
// 0 and false are NOT ids anyone uses here (every owner is a uuid), but they are
// also not "absent" — the guard tests for absence, not for falsiness, so they pass.
assert.strictEqual(ownerOf('application', 0).id, 0, 'a 0 id is present, however odd — it is not "missing"');
ok('a missing id is refused; a present-but-odd id is not treated as missing');

// ── E. ownerWhere: the SQL text, the bound value, and the alias/index guards ──
assert.deepStrictEqual(ownerWhere(APP), { sql: 'application_id = $1', params: ['a1'] });
assert.deepStrictEqual(ownerWhere(LT), { sql: 'lt_loan_id = $1', params: ['l1'] });
assert.deepStrictEqual(ownerWhere(APP, 'd'), { sql: 'd.application_id = $1', params: ['a1'] });
assert.deepStrictEqual(ownerWhere(LT, 'ci', 2), { sql: 'ci.lt_loan_id = $2', params: ['l1'] });
assert.deepStrictEqual(ownerWhere(APP, null, 7), { sql: 'application_id = $7', params: ['a1'] });
assert.deepStrictEqual(ownerWhere(APP, '', 3), { sql: 'application_id = $3', params: ['a1'] },
  'a blank alias means no prefix, not a broken ".column"');
// The VALUE is always BOUND — never interpolated. If a future edit ever inlines it,
// the id would appear in the SQL text and this assertion is what catches it.
assert.ok(!ownerWhere(ownerOf('application', "'; DROP TABLE documents; --")).sql.includes('DROP'),
  'the owner id must never reach the statement text');
ok('ownerWhere emits the column + a placeholder and BINDS the id');

// The alias and the parameter position ARE interpolated, so both are refused
// unless they are what they claim to be — an unusable alias is a programming
// error, and a throw is cheaper than an unexplained 500 far from its cause.
for (const bad of ['a b', 'a-b', '1a', 'a;drop', 'a.b', "a'", 5, {}, true]) {
  assert.throws(() => ownerWhere(APP, bad), /not a plain table alias/,
    `alias ${JSON.stringify(bad)} must be refused`);
}
for (const good of ['a', 'ci', 'd', '_x', 'A1', 'documents']) {
  assert.strictEqual(ownerWhere(APP, good).sql, `${good}.application_id = $1`);
}
for (const bad of [0, -1, 1.5, NaN, '1', null, Infinity, {}]) {
  assert.throws(() => ownerWhere(APP, null, bad), /positive integer/,
    `startIdx ${JSON.stringify(bad)} must be refused`);
}
// `undefined` is the ONE falsy value that is not a refusal — it means "the
// argument was omitted", and the default is $1. `null` is a value somebody
// passed and is refused, which is the distinction worth keeping.
assert.strictEqual(ownerWhere(APP, null, undefined).sql, 'application_id = $1');
ok('ownerWhere refuses a non-identifier alias and a non-positive-integer index');

// ── F. ownerCols: EXACTLY ONE column set, every other NULL ───────────────────
assert.deepStrictEqual(ownerCols(APP), { application_id: 'a1', lt_loan_id: null });
assert.deepStrictEqual(ownerCols(LT), { application_id: null, lt_loan_id: 'l1' });
// The invariant db/650's chk_one_owner enforces, asserted here so the INSERT can
// never be the thing that discovers it: exactly one non-null, and the columns are
// exactly the ones the map declares.
for (const owner of [APP, LT]) {
  const cols = ownerCols(owner);
  assert.deepStrictEqual(Object.keys(cols).sort(), Object.values(OWNER_COLUMN).sort(),
    'ownerCols must emit every owner column, so none is silently left off an INSERT');
  const set = Object.values(cols).filter((v) => v !== null);
  assert.strictEqual(set.length, 1, 'exactly one owner column may carry a value');
  assert.strictEqual(set[0], owner.id);
  assert.strictEqual(cols[ownerColumn(owner)], owner.id, 'the value must sit in THIS scope\'s column');
}
// A fresh object each time — a shared/frozen return would let one caller's mutation
// reach the next INSERT.
const c1 = ownerCols(APP); c1.application_id = 'tampered';
assert.strictEqual(ownerCols(APP).application_id, 'a1', 'ownerCols must return a fresh object');
ok('ownerCols sets exactly one column, NULLs the rest, and returns a fresh object');

// ── G. The two products never collide ───────────────────────────────────────
// Same id, different scope: the statements and the columns must have nothing in
// common — this is what makes an id from the other product reach NOTHING.
const sameIdApp = ownerOf('application', 'shared-id');
const sameIdLt = ownerOf('lt_loan', 'shared-id');
assert.notStrictEqual(ownerWhere(sameIdApp).sql, ownerWhere(sameIdLt).sql);
assert.strictEqual(ownerCols(sameIdApp).lt_loan_id, null);
assert.strictEqual(ownerCols(sameIdLt).application_id, null);
ok('the same id under the two scopes produces disjoint statements and columns');

console.log(`\ntest-condition-owner-pure: ${checks} checks passed`);

'use strict';

/**
 * WHO A CONDITION OR A DOCUMENT BELONGS TO — one descriptor, both products.
 *
 * The Condition Center was multi-owner from day one and the Long-Term loan is
 * now its FOURTH owner scope (db/650: `checklist_items` / `documents` carry
 * `lt_loan_id` beside `application_id`, `chk_one_owner` counts four). The
 * owner's directive is that ONE implementation serve both products — *"if I'm
 * updating something in the logic of the Condition Center … it should update
 * them both places. You need to share the code."* (2026-08-30,
 * docs/longterm/SHARE-THE-CODE-DIRECTIVE.md).
 *
 * A shared service therefore needs ONE answer to three questions, and this is
 * it: which product owns this row, how do I say so in a WHERE clause, and which
 * column do I set on an INSERT. Every one of those was previously written out
 * by hand at each call site as `application_id = $1`, which is exactly the shape
 * that cannot be shared: the second product's copy of a hand-written predicate
 * is the copy that drifts, and a drifted owner predicate is a document from one
 * loan answering for another.
 *
 * PURE — no database, no config, no requires. Every rule here is unit-testable
 * and no caller is surprised by a query it did not write (the same discipline as
 * `lib/file-search.js`, which likewise emits SQL TEXT plus BOUND values).
 *
 * IT FAILS CLOSED, LOUDLY. An unknown scope THROWS; it never falls back to a
 * product. A silent default is how a Long-Term document would land on an RTL
 * file with nothing anywhere going red — the single worst outcome the two-product
 * law exists to prevent (CLAUDE.md → "TWO PRODUCTS, TWO SYSTEMS").
 *
 * A MISSING ID THROWS HERE, AT EVERY ENTRY POINT, AND NOT BECAUSE THE DATABASE
 * WOULD CATCH IT — IT WOULD NOT. An earlier draft of this file said an owner with
 * no id writes both owner columns NULL and `chk_one_owner` refuses it in
 * production. That is true of `checklist_items`, which carries the constraint,
 * and FALSE of `documents`, which does not: db/650 adds `documents.lt_loan_id` as
 * a bare nullable uuid with no owner-count constraint, because those columns were
 * always nullable and denormalized. So `ownerCols({scope:'application'})` with no
 * id would have bound both columns NULL and landed an ORPHAN document row with
 * nothing anywhere going red — the exact outcome the comment promised was
 * impossible. `ownerOf` alone validated the id; `ownerCols` and `ownerWhere` took
 * any object. They no longer do: the id guard sits in `requireOwner`, which every
 * one of them calls. The door is the backstop, because there is no other.
 */

/** The owner column each scope keys on. This map IS the definition of a scope. */
const OWNER_COLUMN = Object.freeze({
  application: 'application_id',
  lt_loan: 'lt_loan_id',
});

/** Every scope, in a stable order — for error wording and for tests to sweep. */
const OWNER_SCOPES = Object.freeze(Object.keys(OWNER_COLUMN));

/** A table alias must be a plain identifier: it is INTERPOLATED, never bound. */
const SAFE_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unknownScope(scope) {
  const e = new Error(
    `unknown condition owner scope ${JSON.stringify(scope)} — expected one of ${OWNER_SCOPES.join(', ')}`);
  e.code = 'UNKNOWN_OWNER_SCOPE';
  return e;
}

/**
 * The descriptor. `ownerOf('lt_loan', id)` is the ONLY way to make one, so a
 * scope nobody defined can never reach a statement.
 *
 * Frozen because it is passed down through several layers of shared service: a
 * caller that mutated `owner.scope` halfway would move a document between
 * products, and that is not a thing any caller should be able to do by accident.
 */
function ownerOf(scope, id) {
  if (!Object.prototype.hasOwnProperty.call(OWNER_COLUMN, scope)) throw unknownScope(scope);
  if (id === undefined || id === null || id === '') {
    const e = new Error(`a ${scope} owner needs an id`);
    e.code = 'OWNER_ID_REQUIRED';
    throw e;
  }
  return Object.freeze({ scope, id });
}

/**
 * The column this owner is stored in — `application_id` or `lt_loan_id`.
 *
 * The membership test is `hasOwnProperty`, NEVER a plain `MAP[scope]` lookup: an
 * object literal inherits from Object.prototype, so a scope of `'constructor'` or
 * `'toString'` answers a FUNCTION — truthy — and would sail past a `if (!col)`
 * guard into a statement built around a column name that is a function. Found by
 * the pure test, which sweeps those names on purpose.
 */
function ownerColumn(owner) {
  const scope = owner && owner.scope;
  if (!Object.prototype.hasOwnProperty.call(OWNER_COLUMN, scope)) throw unknownScope(scope);
  return OWNER_COLUMN[scope];
}

/* Scope AND id, checked together, for the two functions that go on to build real
   SQL. `ownerOf` already refuses a missing id, but nothing forced a caller to come
   through `ownerOf` — an object literal `{scope:'application'}` reached `ownerCols`
   just as well, and pg binds `undefined` as NULL. See the header: no constraint on
   `documents` catches that. Same wording and code as `ownerOf`, so a caller cannot
   tell which door refused it. */
function requireOwner(owner) {
  const col = ownerColumn(owner);
  const id = owner && owner.id;
  if (id === undefined || id === null || id === '') {
    const e = new Error(`a ${owner.scope} owner needs an id`);
    e.code = 'OWNER_ID_REQUIRED';
    throw e;
  }
  return col;
}

/**
 * The owner half of a WHERE clause, plus the value to bind.
 *
 *   ownerWhere(owner, 'd', 3) -> { sql: 'd.application_id = $3', params: [id] }
 *   ownerWhere(owner)         -> { sql: 'application_id = $1',   params: [id] }
 *
 * The VALUE is always BOUND. Only the alias and the parameter POSITION are
 * written into the statement, and both are refused unless they are what they
 * claim to be — an unusable alias or a nonsense position is a programming error,
 * and a throw here is far cheaper than an unexplained 500 far from its cause.
 */
function ownerWhere(owner, alias = null, startIdx = 1) {
  const col = requireOwner(owner);
  if (!Number.isInteger(startIdx) || startIdx < 1) {
    throw new Error(`ownerWhere: startIdx must be a positive integer, got ${JSON.stringify(startIdx)}`);
  }
  let prefix = '';
  if (alias !== null && alias !== undefined && alias !== '') {
    if (typeof alias !== 'string' || !SAFE_ALIAS.test(alias)) {
      throw new Error(`ownerWhere: ${JSON.stringify(alias)} is not a plain table alias`);
    }
    prefix = `${alias}.`;
  }
  return { sql: `${prefix}${col} = $${startIdx}`, params: [owner.id] };
}

/**
 * The owner columns for an INSERT — one set, every other one NULL, so the
 * one-owner rule holds by construction rather than by the caller remembering
 * which columns exist this month.
 *
 * WHICH rule, and enforced WHERE, differs by table and it matters: on
 * `checklist_items` the database backs it (`chk_one_owner`); on `documents` NOTHING
 * does — db/650 adds `lt_loan_id` there as a bare nullable uuid. So for a document
 * this function IS the enforcement, which is why `requireOwner` refuses a missing
 * id here rather than leaving it to a constraint that only exists on the other table.
 */
function ownerCols(owner) {
  const col = requireOwner(owner);
  const out = {};
  for (const c of Object.values(OWNER_COLUMN)) out[c] = (c === col ? owner.id : null);
  return out;
}

module.exports = { ownerOf, ownerColumn, ownerWhere, ownerCols, OWNER_SCOPES, OWNER_COLUMN };

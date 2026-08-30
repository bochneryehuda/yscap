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
 * law exists to prevent (CLAUDE.md → "TWO PRODUCTS, TWO SYSTEMS"). Same for a
 * missing id: an owner with no id would write BOTH owner columns NULL, which
 * `chk_one_owner` refuses at 3am in production rather than here at the door.
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
  const col = ownerColumn(owner);
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
 * The owner columns for an INSERT — one set, every other one NULL, so
 * `chk_one_owner` is satisfied by construction rather than by the caller
 * remembering which columns exist this month.
 */
function ownerCols(owner) {
  const col = ownerColumn(owner);
  const out = {};
  for (const c of Object.values(OWNER_COLUMN)) out[c] = (c === col ? owner.id : null);
  return out;
}

module.exports = { ownerOf, ownerColumn, ownerWhere, ownerCols, OWNER_SCOPES, OWNER_COLUMN };

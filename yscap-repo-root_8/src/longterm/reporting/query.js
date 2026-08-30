'use strict';
/**
 * LONG-TERM — THE REPORT COMPILER.
 *
 * Turns a saved report DEFINITION (a plain object of catalog KEYS) into one bound
 * SQL statement. It is the whole security boundary of the reporting database, and
 * three properties carry it — break any one and an admin-authored report becomes
 * an admin-authored query:
 *
 *   1. NOTHING FROM THE REQUEST IS EVER WRITTEN INTO THE STATEMENT. A column, a
 *      sort and a filter name a catalog KEY; the catalog supplies the expression.
 *      A key the catalog does not carry is REFUSED by name — never silently
 *      dropped, because a report quietly missing the column somebody filtered on
 *      answers a different question than the one they asked.
 *   2. EVERY VALUE IS BOUND. `bind()` is the only way a value reaches the
 *      statement, and it is used for filter values, the row cap AND the tenant's
 *      milestone names.
 *   3. THE OPERATORS ARE A PER-TYPE WHITELIST. An operator a type does not support
 *      is refused, so a text operator can never be applied to a timestamp.
 *
 * THE FILTER GRAMMAR IS DELIBERATELY THE ONE THE SHORT-TERM CONDITION CENTER
 * ALREADY USES — `{combinator, rules:[{field, operator, value} | group]}`, one
 * level of nesting — so the two products' rule builders read the same to a person
 * moving between them. The GRAMMAR is shared; the CATALOG, the compiler and every
 * table here are Long-Term's own.
 *
 * NO SILENT CAPS. A run reports `capped`, the cap it applied and the total it
 * would have returned, so "500 files" is never read as the whole book.
 */

const fields = require('./fields');
const spans = require('./spans');

class ReportError extends Error {
  constructor(msg) { super(msg); this.status = 400; this.expose = true; }
}

/** Which operators each field type accepts. A type/operator pair not here is refused. */
const OPERATORS_BY_TYPE = {
  money: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  duration: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  pct: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  text: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'in', 'not_in', 'is_empty', 'not_empty'],
  enum: ['eq', 'neq', 'in', 'not_in', 'is_empty', 'not_empty'],
  boolean: ['is_true', 'is_false', 'is_empty', 'not_empty'],
  date: ['eq', 'before', 'after', 'between', 'is_empty', 'not_empty'],
  timestamp: ['eq', 'before', 'after', 'between', 'is_empty', 'not_empty'],
};

const NO_VALUE_OPS = ['is_empty', 'not_empty', 'is_true', 'is_false'];
const RANGE_OPS = ['between'];
const LIST_OPS = ['in', 'not_in'];

const OPERATOR_LABEL = {
  eq: 'is', neq: 'is not', gt: 'is more than', gte: 'is at least',
  lt: 'is less than', lte: 'is at most', between: 'is between',
  in: 'is any of', not_in: 'is none of',
  contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with',
  is_empty: 'is blank', not_empty: 'is filled in',
  is_true: 'is yes', is_false: 'is no',
  before: 'is before', after: 'is after',
};

function isGroup(node) {
  return node && typeof node === 'object' && Array.isArray(node.rules);
}

/**
 * Compile a definition into `{ text, params, columns, sort, dir, limit }`.
 *
 * `def` is the saved report: `{ columns[], filter, sort, dir, limit }`.
 * `opts.audience` decides which fields exist at all — `internal` sees the
 * investor, anything else does not, failing closed exactly as `audience.js` does.
 */
function compile(def, opts = {}) {
  const audience = opts.audience === 'internal' ? 'internal' : 'client';
  const milestones = spans.milestoneNames(opts.milestones);
  const available = fields.fieldsFor(audience, opts.milestones);
  const byKey = Object.create(null);
  for (const f of available) byKey[f.key] = f;

  const params = [];
  const bind = (v) => { params.push(v); return `$${params.length}`; };

  // ── the columns ─────────────────────────────────────────────────────────
  const wanted = Array.isArray(def && def.columns) ? def.columns : [];
  const columns = [];
  for (const key of wanted) {
    const f = byKey[String(key)];
    if (!f) throw new ReportError(unknownFieldMessage(key, audience, opts.milestones));
    if (columns.some((c) => c.key === f.key)) continue;   // a column asked for twice is one column
    columns.push(f);
  }
  if (!columns.length) {
    // A report with no columns is a mistake, not a request for an empty table —
    // answer with the identity of the file so a fresh report is never blank.
    for (const k of ['loan_number', 'borrower_name', 'stage', 'loan_amount']) {
      if (byKey[k]) columns.push(byKey[k]);
    }
  }

  // ── the FROM (binds the milestone names) ────────────────────────────────
  const from = fields.fromSql(milestones, bind);

  // ── the WHERE ───────────────────────────────────────────────────────────
  const where = [fields.BASE_SCOPE];
  if (def && def.filter) {
    const compiled = compileGroup(def.filter, byKey, bind, 0);
    if (compiled) where.push(compiled);
  }
  // A caller-supplied scope (the viewer's own book) is a CLAUSE, never a string
  // the caller wrote: it arrives as `{sql, params}` from the route.
  if (opts.scope && opts.scope.sql) {
    where.push(`(${opts.scope.sql.replace(/\$SCOPE(\d+)/g, (_, i) => bind(opts.scope.params[Number(i) - 1]))})`);
  }

  // ── the ORDER BY ────────────────────────────────────────────────────────
  const sortKey = def && def.sort ? String(def.sort) : null;
  const sortField = sortKey ? byKey[sortKey] : null;
  if (sortKey && !sortField) throw new ReportError(unknownFieldMessage(sortKey, audience, opts.milestones));
  const dir = String((def && def.dir) || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // NULLS LAST in both directions: a report sorted by "how long it took" is asking
  // about the files that HAVE a duration, and a page of blanks at the top reads as
  // a broken report.
  const orderBy = sortField
    ? `ORDER BY ${sortField.sql} ${dir} NULLS LAST, l.id`
    : 'ORDER BY l.encompass_last_modified DESC NULLS LAST, l.id';

  // ── the cap ─────────────────────────────────────────────────────────────
  const asked = Number(def && def.limit);
  const limit = Math.min(
    Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : fields.DEFAULT_ROWS,
    fields.MAX_ROWS,
  );

  const select = columns.map((c, i) => `${c.sql} AS "c${i}"`).join(',\n         ');
  const text = `
    SELECT ${select},
           l.id AS "loan_id",
           count(*) OVER () AS "total_rows"
    ${from}
     WHERE ${where.join('\n       AND ')}
     ${orderBy}
     LIMIT ${bind(limit + 1)}`;

  return { text, params, columns, sort: sortField ? sortField.key : null, dir: dir.toLowerCase(), limit };
}

/**
 * A refusal that tells the reader what to do. Naming the nearest legal keys is
 * what turns "unknown field" into something actionable, and saying so when a field
 * exists but is INTERNAL is what stops a client-facing report reading as broken
 * when it is in fact correctly refusing to show the investor.
 */
function unknownFieldMessage(key, audience, milestoneOverrides) {
  const k = String(key);
  const everything = fields.allFields(milestoneOverrides);
  const hidden = everything.find((f) => f.key === k);
  if (hidden && hidden.internalOnly && audience !== 'internal') {
    return `“${hidden.label}” is internal to the team and cannot go in this report.`;
  }
  return `This report asks for a field that does not exist: “${k}”. Pick it again from the field list.`;
}

function compileGroup(node, byKey, bind, depth) {
  if (!isGroup(node)) throw new ReportError('A filter must be a group of rules.');
  if (depth > 1) throw new ReportError('Filters can only be nested one level deep.');
  const joiner = String(node.combinator || 'and').toLowerCase() === 'or' ? ' OR ' : ' AND ';
  const parts = [];
  for (const row of node.rules) {
    if (isGroup(row)) {
      const inner = compileGroup(row, byKey, bind, depth + 1);
      if (inner) parts.push(`(${inner})`);
      continue;
    }
    const sql = compileRow(row, byKey, bind);
    if (sql) parts.push(sql);
  }
  if (!parts.length) return null;
  return parts.join(joiner);
}

function compileRow(row, byKey, bind) {
  if (!row || typeof row !== 'object') throw new ReportError('A filter row is malformed.');
  const f = byKey[String(row.field)];
  if (!f) throw new ReportError(`This report filters on a field that does not exist: “${row.field}”.`);
  const op = String(row.operator || '');
  const allowed = OPERATORS_BY_TYPE[f.type] || [];
  if (!allowed.includes(op)) {
    throw new ReportError(`“${OPERATOR_LABEL[op] || op}” cannot be used on ${f.label}.`);
  }
  const col = f.sql;

  if (op === 'is_empty') return `(${col}) IS NULL`;
  if (op === 'not_empty') return `(${col}) IS NOT NULL`;
  if (op === 'is_true') return `(${col}) IS TRUE`;
  if (op === 'is_false') return `(${col}) IS FALSE`;

  if (RANGE_OPS.includes(op)) {
    const v = Array.isArray(row.value) ? row.value : [];
    if (v.length !== 2) throw new ReportError(`${f.label}: “is between” needs two values.`);
    const [lo, hi] = sortPair(f, v);
    return `(${col}) BETWEEN ${bind(cast(f, lo))} AND ${bind(cast(f, hi))}`;
  }

  if (LIST_OPS.includes(op)) {
    const v = (Array.isArray(row.value) ? row.value : []).filter((x) => x !== null && x !== undefined && x !== '');
    if (!v.length) throw new ReportError(`${f.label}: pick at least one value.`);
    if (v.length > 200) throw new ReportError(`${f.label}: that is too many values to pick (200 at most).`);
    const list = bind(v.map((x) => String(x)));
    return op === 'in' ? `(${col})::text = ANY(${list}::text[])` : `((${col})::text <> ALL(${list}::text[]) OR (${col}) IS NULL)`;
  }

  const val = row.value;
  if (val === null || val === undefined || val === '') {
    throw new ReportError(`${f.label}: “${OPERATOR_LABEL[op] || op}” needs a value.`);
  }

  if (op === 'contains' || op === 'not_contains' || op === 'starts_with') {
    const like = bind(op === 'starts_with' ? `${escapeLike(String(val))}%` : `%${escapeLike(String(val))}%`);
    const expr = `(${col})::text ILIKE ${like}`;
    return op === 'not_contains' ? `(NOT (${expr}) OR (${col}) IS NULL)` : expr;
  }

  const cmp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', before: '<', after: '>' }[op];
  if (!cmp) throw new ReportError(`“${op}” is not an operator this report understands.`);
  const bound = bind(cast(f, val));
  // `<>` on a NULL column answers NULL, which drops the row — so "is not X" has to
  // say out loud that a blank is not X, or a filter reads as losing rows.
  if (op === 'neq') return `((${col}) IS DISTINCT FROM ${bound})`;
  if (f.type === 'text' || f.type === 'enum') return `(${col})::text ${cmp} ${bound}`;
  return `(${col}) ${cmp} ${bound}`;
}

/**
 * A value must FIT THE COLUMN, and the COLUMN decides — the repo's standing rule.
 * A number that will not parse is refused HERE with the field's name on it, rather
 * than reaching Postgres and coming back as a 500 that reads as "PILOT is broken".
 */
function cast(f, v) {
  if (['money', 'number', 'pct', 'duration'].includes(f.type)) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ReportError(`${f.label}: “${v}” is not a number.`);
    return n;
  }
  if (f.type === 'date' || f.type === 'timestamp') {
    const s = String(v);
    if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s)) throw new ReportError(`${f.label}: a date must be written YYYY-MM-DD.`);
    return s;
  }
  if (f.type === 'boolean') return v === true || v === 'true';
  const s = String(v);
  if (s.length > 500) throw new ReportError(`${f.label}: that value is too long.`);
  return s;
}

function sortPair(f, [a, b]) {
  if (['money', 'number', 'pct', 'duration'].includes(f.type)) {
    const [x, y] = [Number(a), Number(b)];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ReportError(`${f.label}: both values must be numbers.`);
    return x <= y ? [a, b] : [b, a];
  }
  return String(a) <= String(b) ? [a, b] : [b, a];
}

/** `%` and `_` are LIKE wildcards — a typed one is a LITERAL, never a match-all. */
function escapeLike(s) {
  return String(s).replace(/([\\%_])/g, '\\$1');
}

/** Plain-language summary of a filter, for the saved-report list and the audit. */
function describeFilter(node, byKey, depth = 0) {
  if (!isGroup(node) || !node.rules.length) return '';
  const joiner = String(node.combinator || 'and').toLowerCase() === 'or' ? ' or ' : ' and ';
  const parts = node.rules.map((row) => {
    if (isGroup(row)) {
      const inner = describeFilter(row, byKey, depth + 1);
      return inner ? `(${inner})` : '';
    }
    const f = byKey[String(row.field)];
    if (!f) return '';
    const op = OPERATOR_LABEL[row.operator] || row.operator;
    if (NO_VALUE_OPS.includes(row.operator)) return `${f.label} ${op}`;
    if (RANGE_OPS.includes(row.operator)) return `${f.label} ${op} ${row.value[0]} and ${row.value[1]}`;
    if (LIST_OPS.includes(row.operator)) return `${f.label} ${op} ${(row.value || []).join(', ')}`;
    return `${f.label} ${op} ${row.value}`;
  }).filter(Boolean);
  return parts.join(joiner);
}

module.exports = {
  ReportError, OPERATORS_BY_TYPE, OPERATOR_LABEL, NO_VALUE_OPS, RANGE_OPS, LIST_OPS,
  compile, describeFilter, escapeLike,
  _internals: { compileRow, compileGroup, cast },
};

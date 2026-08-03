'use strict';

/**
 * Turn a validated filter tree into parameterised SQL.
 *
 * THIS IS THE SECURITY BOUNDARY OF THE WHOLE FEATURE. A dashboard lets a human compose a
 * database query, so the rule is absolute and has no exceptions anywhere in this file:
 *
 *   STRUCTURE comes from the registry (a developer wrote it). VALUES are bound.
 *   Nothing a person types is ever concatenated into SQL — not a field, not an operator,
 *   not a sort, not a limit.
 *
 * Every field key is resolved through `registry.FIELD_BY_KEY` with a hasOwnProperty guard
 * (never a bare `MAP[key]`, which would happily answer for `__proto__` or `constructor`),
 * every operator is checked against the operator table for that field's TYPE, and every
 * value goes through `add()`, which returns a `$N` placeholder. An unknown key is an
 * ERROR, never a silently-false row — a filter that quietly matches nothing is worse than
 * one that refuses, because the zero looks like an answer.
 *
 * NULL SEMANTICS — decided deliberately, and it is the one place this file departs from
 * the conditions engine. POSITIVE operators exclude NULL; NEGATIVE operators INCLUDE it.
 *
 *   "note buyer is Fidelis"     → only the Fidelis files
 *   "note buyer is not Fidelis" → everything else, INCLUDING files with no note buyer yet
 *
 * Raw SQL does the opposite: `lender <> 'fidelis'` is NULL for a file with no lender, so
 * the row silently vanishes and "is" + "is not" do not add up to the total. People check
 * that. A reporting surface whose two halves don't sum to the whole is a surface nobody
 * trusts, and the missing rows are invisible — there is no error, just a smaller number.
 *
 * This is NOT the same question the conditions engine answers. There, fail-closed is right
 * because a missing value must never FIRE a condition on a borrower's live file. Here
 * nothing fires; we are counting, and "not Fidelis" plainly means "not Fidelis".
 *
 * Everything else still fails closed: an unknown field is an error, an unknown operator is
 * an error, and a malformed stored filter refuses rather than quietly matching everything.
 *
 * ONE WHERE CLAUSE SERVES BOTH THE NUMBER AND THE LIST. `buildAggregate` and
 * `buildDrillList` are handed the identical compiled predicate, which is what makes the
 * house rule (#145 — "a figure can never show a number you can't reproduce by clicking
 * into it") true by construction here rather than by discipline.
 */

const registry = require('./registry');
const rules = require('../conditions/rules');

const NO_VALUE_OPS = new Set(['is_empty', 'not_empty', 'is_true', 'is_false']);

/** A parameter allocator. Values only — never SQL. */
function makeParams(seed = []) {
  const values = [...seed];
  return {
    values,
    add(v) { values.push(v); return `$${values.length}`; },
  };
}

/**
 * Escape the LIKE metacharacters in a value the user typed. The value is STILL bound —
 * this only stops `%` in a search box silently meaning "any run of characters", which is
 * a correctness bug (a search for "50%" matching everything), not an injection.
 */
function likeEscape(s) {
  return String(s).replace(/([\\%_])/g, '\\$1');
}

/** The cast a bound value needs so Postgres compares it against the right type. */
function castFor(type, isArray) {
  const base = (type === 'money' || type === 'number' || type === 'percent') ? 'numeric'
    : type === 'date' ? 'date'
      : 'text';
  return isArray ? `${base}[]` : base;
}

/**
 * Compile one {field, operator, value} row.
 * Throws on anything not in the catalogue — callers validate first, so a throw here means
 * a stored filter drifted out of step with the registry and CI should hear about it.
 */
function compileRow(row, p) {
  if (!row || typeof row !== 'object') throw new Error('malformed filter row');
  if (!registry.has(registry.FIELD_BY_KEY, row.field)) {
    throw new Error(`unknown filter field "${row.field}"`);
  }
  const f = registry.FIELD_BY_KEY[row.field];
  const allowed = rules.OPERATORS_BY_TYPE[f.type] || [];
  if (!allowed.includes(row.operator)) {
    throw new Error(`operator "${row.operator}" is not valid for ${f.label}`);
  }

  const e = f.sql;               // written in the registry by a developer; never input
  const op = row.operator;
  const v = row.value;

  if (!NO_VALUE_OPS.has(op)) {
    if (op === 'between') {
      if (!Array.isArray(v) || v.length !== 2) throw new Error(`${f.label}: "between" needs two values`);
    } else if (op === 'in' || op === 'not_in') {
      if (!Array.isArray(v) || !v.length) throw new Error(`${f.label}: pick at least one value`);
    } else if (v === null || v === undefined || v === '') {
      throw new Error(`${f.label}: this comparison needs a value`);
    }
  }

  const cast = (val, arr) => `${p.add(val)}::${castFor(f.type, arr)}`;

  // Every ILIKE carries ESCAPE '\' explicitly. Backslash is already Postgres's default
  // LIKE escape, but saying so means the emitted SQL cannot change meaning if
  // standard_conforming_strings ever differs.
  const like = (pattern) => `${p.add(pattern)}::text ESCAPE '\\'`;

  switch (op) {
    // --- positive: a NULL column does not match ---
    case 'eq':      return `${e} = ${cast(v)}`;
    case 'gt':      return `${e} > ${cast(v)}`;
    case 'gte':     return `${e} >= ${cast(v)}`;
    case 'lt':      return `${e} < ${cast(v)}`;
    case 'lte':     return `${e} <= ${cast(v)}`;
    case 'before':  return `${e} < ${cast(v)}`;
    case 'after':   return `${e} > ${cast(v)}`;
    case 'between': return `${e} BETWEEN ${cast(v[0])} AND ${cast(v[1])}`;
    case 'in':      return `${e} = ANY(${cast(v, true)})`;
    case 'contains':      return `${e}::text ILIKE ${like(`%${likeEscape(v)}%`)}`;
    case 'starts_with':   return `${e}::text ILIKE ${like(`${likeEscape(v)}%`)}`;
    case 'ends_with':     return `${e}::text ILIKE ${like(`%${likeEscape(v)}`)}`;

    // --- negative: a NULL column DOES match, so "is" and "is not" sum to the total ---
    case 'neq':     return `(${e} <> ${cast(v)} OR ${e} IS NULL)`;
    case 'not_in':  return `(NOT (${e} = ANY(${cast(v, true)})) OR ${e} IS NULL)`;
    case 'not_contains':  return `(${e}::text NOT ILIKE ${like(`%${likeEscape(v)}%`)} OR ${e} IS NULL)`;

    // --- presence tests: these ARE the way to ask about NULL ---
    case 'is_empty':      return `(${e} IS NULL OR ${e}::text = '')`;
    case 'not_empty':     return `(${e} IS NOT NULL AND ${e}::text <> '')`;
    // Every boolean field in the registry is a concrete expression (COALESCE'd, or an
    // `IS NOT NULL` test), never a raw nullable column — so IS FALSE is exact here and
    // does not need the conditions engine's "a blank boolean is unknown" carve-out.
    case 'is_true':       return `${e} IS TRUE`;
    case 'is_false':      return `${e} IS FALSE`;
    default:
      throw new Error(`unsupported operator "${op}"`);
  }
}

/**
 * Compile a whole tree. Depth is capped at 2 by the shared validator — a root group plus
 * one nested level — which already expresses `(A or B) and (C or D)`, the shape real
 * questions actually need. Returns null for an empty/absent filter (no extra predicate).
 */
function compileFilter(tree, p, depth = 0) {
  if (!tree || !Array.isArray(tree.rules) || !tree.rules.length) return null;
  if (depth > 1) throw new Error('filter groups can only be nested one level deep');
  const combinator = tree.combinator === 'or' ? 'OR' : 'AND';
  const parts = [];
  for (const node of tree.rules) {
    if (node && Array.isArray(node.rules)) {
      const nested = compileFilter(node, p, depth + 1);
      if (nested) parts.push(nested);
    } else {
      parts.push(compileRow(node, p));
    }
  }
  if (!parts.length) return null;
  return `(${parts.join(` ${combinator} `)})`;
}

/** Validate a filter tree against the DASHBOARD field map (not the conditions one). */
function validateFilter(tree) {
  if (!tree) return [];
  if (!Array.isArray(tree.rules) || !tree.rules.length) return [];
  return rules.validateRule(tree, { fields: registry.fieldMap() });
}

/** Plain-English echo of the filter, for the "how is this worked out" panel. */
function describeFilter(tree) {
  if (!tree || !Array.isArray(tree.rules) || !tree.rules.length) return 'All files';
  try {
    return rules.summarizeRule(tree, { fields: registry.fieldMap() }) || 'All files';
  } catch (_) {
    return 'All files';
  }
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

const PERIOD_KINDS = new Set(['all', 'mtd', 'qtd', 'ytd', 'last_days', 'last_months', 'this_month', 'last_month', 'fixed']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The SQL for a period on a date field, plus the [from,to) window it stands for so a
 * comparison period can be derived from the same shape.
 *
 * All arithmetic is done in SQL, never in JS: `date` columns come back from this driver
 * as 'YYYY-MM-DD' STRINGS (src/db.js sets a type parser for OID 1082), so doing month
 * maths on them in JavaScript is how a report ends up a day out.
 */
function periodSql(dateFieldKey, period, p, { shift = null } = {}) {
  if (!dateFieldKey) return null;
  if (!registry.has(registry.DATE_FIELDS, dateFieldKey)) {
    throw new Error(`unknown date field "${dateFieldKey}"`);
  }
  const col = registry.DATE_FIELDS[dateFieldKey].sql;
  const kind = (period && period.kind) || 'all';
  if (!PERIOD_KINDS.has(kind)) throw new Error(`unknown period "${kind}"`);
  if (kind === 'all') return null;

  // `shift` moves the whole window back for a comparison: 'prior_period' or 'prior_year'.
  const back = shift === 'prior_year' ? " - interval '1 year'" : '';

  const n = Math.max(1, Math.min(3650, Number(period && period.n) || 30));

  switch (kind) {
    case 'mtd': {
      if (shift === 'prior_period') {
        return `${col} >= (date_trunc('month', CURRENT_DATE) - interval '1 month')::date
                AND ${col} < date_trunc('month', CURRENT_DATE)::date`;
      }
      return `${col} >= (date_trunc('month', CURRENT_DATE)${back})::date AND ${col} <= (CURRENT_DATE${back})`;
    }
    case 'this_month':
      return `${col} >= (date_trunc('month', CURRENT_DATE)${back})::date
              AND ${col} < (date_trunc('month', CURRENT_DATE)${back} + interval '1 month')::date`;
    case 'last_month':
      return `${col} >= (date_trunc('month', CURRENT_DATE) - interval '1 month'${back})::date
              AND ${col} < (date_trunc('month', CURRENT_DATE)${back})::date`;
    case 'qtd': {
      if (shift === 'prior_period') {
        return `${col} >= (date_trunc('quarter', CURRENT_DATE) - interval '3 months')::date
                AND ${col} < date_trunc('quarter', CURRENT_DATE)::date`;
      }
      return `${col} >= (date_trunc('quarter', CURRENT_DATE)${back})::date AND ${col} <= (CURRENT_DATE${back})`;
    }
    case 'ytd': {
      if (shift === 'prior_period') {
        return `${col} >= (date_trunc('year', CURRENT_DATE) - interval '1 year')::date
                AND ${col} < date_trunc('year', CURRENT_DATE)::date`;
      }
      return `${col} >= (date_trunc('year', CURRENT_DATE)${back})::date AND ${col} <= (CURRENT_DATE${back})`;
    }
    case 'last_days': {
      const off = shift === 'prior_period' ? `${n * 2}` : `${n}`;
      const end = shift === 'prior_period' ? `(CURRENT_DATE - ${n})` : `(CURRENT_DATE${back})`;
      const start = shift === 'prior_period'
        ? `(CURRENT_DATE - ${off})`
        : `((CURRENT_DATE - ${n})${back})`;
      return `${col} > ${start} AND ${col} <= ${end}`;
    }
    case 'last_months': {
      const months = shift === 'prior_period' ? `${n * 2}` : `${n}`;
      const startExpr = shift === 'prior_period'
        ? `(date_trunc('month', CURRENT_DATE) - interval '${months} months')`
        : `(date_trunc('month', CURRENT_DATE) - interval '${months} months'${back})`;
      const endExpr = shift === 'prior_period'
        ? `(date_trunc('month', CURRENT_DATE) - interval '${n} months')`
        : `(date_trunc('month', CURRENT_DATE) + interval '1 month'${back})`;
      return `${col} >= ${startExpr}::date AND ${col} < ${endExpr}::date`;
    }
    case 'fixed': {
      const from = period && period.from;
      const to = period && period.to;
      if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
        throw new Error('a fixed period needs a from and to date (YYYY-MM-DD)');
      }
      if (shift === 'prior_year') {
        return `${col} >= (${p.add(from)}::date - interval '1 year')::date
                AND ${col} <= (${p.add(to)}::date - interval '1 year')::date`;
      }
      if (shift === 'prior_period') {
        // Slide the window back by exactly its own length, so a 90-day window compares
        // to the 90 days before it rather than to a calendar guess.
        const f = p.add(from), t = p.add(to);
        return `${col} >= (${f}::date - (${t}::date - ${f}::date + 1))
                AND ${col} < ${f}::date`;
      }
      return `${col} >= ${p.add(from)}::date AND ${col} <= ${p.add(to)}::date`;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Query assembly
// ---------------------------------------------------------------------------

/**
 * The WHERE every dashboard query carries, in this order and never any other:
 *   1. soft-delete guard        (always)
 *   2. the viewer's file scope  (always, and it can only narrow)
 *   3. the card's period
 *   4. the card's filter
 */
function buildWhere(card, scope, p, { shift = null } = {}) {
  const where = [registry.BASE_WHERE];
  if (scope && scope.sql) where.push(scope.sql);
  // A card row uses the COLUMN names (date_field), an unsaved preview may use either.
  // Accepting one spelling and silently ignoring the other is how a date range vanishes
  // from a query while the card still looks right on screen — so read both, explicitly.
  const dateField = card.date_field || card.dateField || null;
  const per = periodSql(dateField, card.period, p, { shift });
  if (per) where.push(`(${per})`);
  const f = compileFilter(card.filter, p);
  if (f) where.push(f);
  return where.join(' AND ');
}

/**
 * A ratio measure compiles to numerator and denominator over the SAME rows in ONE pass,
 * using FILTER for the numerator.
 *
 * This is the shape that makes pull-through honest, and getting it wrong is the classic
 * lending-dashboard error. Pull-through is a COHORT question — "of the files that came in
 * during this period, how many eventually funded" — so both halves must be timed on the
 * APPLICATION date and the numerator must be a filter on those same rows. Compute it the
 * obvious way instead (funded in the period ÷ applications in the period) and you are
 * dividing two different populations by two different clocks; group it by the funded date
 * and the denominator loses every file that never funded, so the answer is ~100% forever.
 *
 * A ratio is also never the average of its parts: the year's pull-through is the year's
 * funded over the year's applications, NOT the mean of twelve monthly rates.
 * NULLIF on the denominator means a period with no applications reports "no data" rather
 * than a division error or a fabricated 0%.
 */
function ratioSelects(m, p) {
  const num = compileFilter(m.numerator, p);
  if (!num) throw new Error(`ratio measure "${m.label}" has no numerator filter`);
  const den = m.denominator ? compileFilter(m.denominator, p) : null;
  const nSql = `COUNT(*) FILTER (WHERE ${num})::numeric`;
  const dSql = den ? `COUNT(*) FILTER (WHERE ${den})::numeric` : `COUNT(*)::numeric`;
  return [
    `(${nSql} / NULLIF(${dSql},0))${m.asPercent ? ' * 100' : ''} AS value`,
    `${nSql} AS numerator`,
    `${dSql} AS denominator`,
  ];
}

/**
 * How a card is broken up — a time grain on its date field, or a catalogue dimension.
 *
 * ONE DEFINITION, because the COUNT and the drill-through both need it and #145 says a
 * clickable figure has exactly one definition shared by the number and the list. Written
 * twice, the bar could say 9 and the list show 40 without either side looking wrong.
 * Returns null when the card is a single number.
 */
function groupingFor(card) {
  if (card.grain) {
    if (!registry.has(registry.TIME_GRAINS, card.grain)) throw new Error(`unknown time grain "${card.grain}"`);
    if (!card.date_field || !registry.has(registry.DATE_FIELDS, card.date_field)) {
      throw new Error('a time breakdown needs a date field');
    }
    const g = registry.TIME_GRAINS[card.grain];
    const col = registry.DATE_FIELDS[card.date_field].sql;
    // ::timestamp, NOT ::timestamptz. Every date field in the registry resolves to a
    // calendar DATE, which has no instant and no zone. Casting it to timestamptz would
    // attach the SERVER's zone (UTC on Render) and then truncating could shift a file
    // dated the 31st into the following month — a month-end total that is quietly wrong
    // and moves if the server's timezone ever changes. `g.trunc` is interpolated, and is
    // safe for the one reason interpolation is ever safe here: it came from an exact key
    // lookup into TIME_GRAINS, so the user's bytes were a KEY, never content.
    return {
      expr: `date_trunc('${g.trunc}', ${col}::timestamp)`,
      label: `to_char(date_trunc('${g.trunc}', ${col}::timestamp), '${g.fmt}')`,
    };
  }
  if (card.group_by) {
    if (!registry.has(registry.DIMENSIONS, card.group_by)) throw new Error(`unknown breakdown "${card.group_by}"`);
    const sql = registry.DIMENSIONS[card.group_by].sql;
    return { expr: sql, label: sql };
  }
  return null;
}

/**
 * A single number (optionally broken down by a dimension or a time grain).
 *
 * `shift` moves the card's whole window back — 'prior_period' or 'prior_year' — so the same
 * card, same filter and same scope can be asked "and what was it last year?". It is the ONLY
 * difference between the two runs, which is what makes the comparison honest.
 */
function buildAggregate(card, scope, { seed = [], shift = null } = {}) {
  const p = makeParams(seed);
  if (!registry.has(registry.MEASURES, card.metric_key)) {
    throw new Error(`unknown measure "${card.metric_key}"`);
  }
  const m = registry.MEASURES[card.metric_key];
  const where = buildWhere(card, scope, p, { shift });

  const selects = m.kind === 'ratio' ? ratioSelects(m, p) : [`${m.sql} AS value`];
  if (m.coverage) selects.push(`${m.coverage} AS covered`);
  selects.push('COUNT(*)::bigint AS rows_matched');

  const grouping = groupingFor(card);
  const groupExpr = grouping ? grouping.expr : null;
  const groupLabel = grouping ? grouping.label : null;

  if (!groupExpr) {
    return {
      text: `SELECT ${selects.join(', ')} ${registry.FROM_SQL} WHERE ${where}`,
      values: p.values,
      grouped: false,
    };
  }

  // A grouped card is bounded. Deliberately generous (a year of months, 51 states) but
  // never unbounded — an accidental group-by on a free-text column must not stream
  // 40,000 rows into a browser.
  const limit = Math.max(1, Math.min(200, Number(card.limit) || 60));
  const orderBy = card.grain ? 'bucket ASC' : 'value DESC NULLS LAST';
  return {
    text: `SELECT ${groupLabel} AS bucket_label, ${groupExpr} AS bucket, ${selects.join(', ')}
             ${registry.FROM_SQL}
            WHERE ${where}
            GROUP BY 1, 2
            HAVING ${groupExpr} IS NOT NULL
            ORDER BY ${orderBy}
            LIMIT ${limit}`,
    values: p.values,
    grouped: true,
  };
}

/**
 * The drill-through. Handed the SAME card and the SAME scope, so it compiles the SAME
 * predicate — which is the whole point: the list is the number, enumerated.
 *
 * "The same predicate" is more than the shared buildWhere, and both extras were missing:
 *
 *   A RATIO IS MEASURED OVER ITS DENOMINATOR, so the list is that cohort. Without this,
 *   a pull-through card reading "60% (3 of 5)" listed all NINE matched files — four of
 *   which are in neither half of the fraction — under the words "exactly the ones this
 *   number counted". The numerator is deliberately NOT applied: the rate's population is
 *   the denominator, and listing only the 3 that funded would answer a different question
 *   than the one the card asks.
 *
 *   A CLICKED BUCKET IS PART OF THE QUESTION. Clicking August on a by-month trend must
 *   list August, not the whole period. The bucket is matched on the grouping's LABEL —
 *   the exact text the card displayed and handed back — so the client never has to know
 *   how a bucket is computed, and a timestamp never has to survive a round trip through
 *   JSON and back into a comparison. It is BOUND, never interpolated. An unknown label
 *   simply matches nothing, which is the honest answer for a bucket that is not there.
 */
function buildDrillList(card, scope, { limit = 200, offset = 0, seed = [], bucket = null } = {}) {
  const p = makeParams(seed);
  const clauses = [buildWhere(card, scope, p)];

  const m = registry.has(registry.MEASURES, card.metric_key) ? registry.MEASURES[card.metric_key] : null;
  if (m && m.kind === 'ratio' && m.denominator) {
    const den = compileFilter(m.denominator, p);
    if (den) clauses.push(den);
  }

  if (bucket != null && String(bucket).length) {
    const grouping = groupingFor(card);
    if (grouping) clauses.push(`(${grouping.label})::text = ${p.add(String(bucket))}`);
  }

  const where = clauses.join(' AND ');
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  const off = Math.max(0, Math.min(1e6, Math.floor(Number(offset) || 0)));
  return {
    text: `SELECT a.id, a.ys_loan_number, a.status, a.internal_status, a.loan_amount,
                  a.property_address, a.program, a.loan_type, a.actual_closing,
                  a.expected_closing, a.maturity_date, a.created_at, a.updated_at,
                  NULLIF(lo.full_name,'') AS loan_officer,
                  NULLIF(b.full_name,'')  AS borrower
             ${registry.FROM_SQL}
            WHERE ${where}
            ORDER BY a.updated_at DESC, a.id DESC
            LIMIT ${lim} OFFSET ${off}`,
    values: p.values,
  };
}

module.exports = {
  makeParams, compileRow, compileFilter, validateFilter, describeFilter,
  periodSql, buildWhere, groupingFor, buildAggregate, buildDrillList, likeEscape, castFor,
  PERIOD_KINDS,
};

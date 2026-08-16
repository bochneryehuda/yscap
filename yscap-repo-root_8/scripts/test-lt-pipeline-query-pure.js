#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM — the pipeline query, pure (no DB).
 *
 * Two things here have already cost this codebase live incidents, and both are
 * about SQL COMPOSITION rather than about pipelines:
 *
 *   1. **The placeholder index.** RTL hit a live Postgres 42P18 by hard-coding `$1`
 *      in a scope fragment: the moment a sees-all caller dropped the clause, the
 *      parameter became unreferenced and every query failed. So the arithmetic is
 *      asserted directly — every `$n` the SQL mentions must exist in the parameter
 *      array, and the array must carry nothing the SQL never mentions.
 *   2. **The scope is composed, not re-derived.** A pipeline that scoped differently
 *      from `mayOpenLoan` would mean a file you can see and cannot open — or one you
 *      can open from a link and never see listed.
 *
 * Mutations proven to fail this file: hard-coding $1 in the scope fragment; letting
 * a sees-all viewer keep the scope parameter; an unvalidated sort column; a limit
 * with no ceiling; an INNER join to the borrower record.
 */

const pipeline = require('../src/longterm/pipeline');
const access = require('../src/longterm/access');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

/** Every $n the SQL mentions, as numbers. */
const placeholders = (sql) => [...new Set((sql.match(/\$(\d+)/g) || []).map((s) => Number(s.slice(1))))].sort((a, b) => a - b);

/**
 * THE INVARIANT, asserted the same way for every shape of query: the SQL's
 * placeholders are exactly 1..params.length, with nothing missing and nothing spare.
 * A gap is a bind error; a spare is 42P18.
 */
function bindsCleanly(q, label) {
  const used = placeholders(`${q.sql} ${q.countSql}`);
  const expected = q.params.map((_, i) => i + 1);
  const ok = JSON.stringify(used) === JSON.stringify(expected);
  check(ok, `${label}: the SQL binds $1..$${q.params.length} exactly — no gap, no unreferenced parameter`);
  return ok;
}

const OFFICER = access.accessFor({ id: 's1', role: 'loan_officer' });
const ADMIN = access.accessFor({ id: 's2', role: 'admin' });
const CLOSER = access.accessFor({ id: 's3', role: 'closer' });

// ── The scope ───────────────────────────────────────────────────────────────
console.log('scope — who sees which files');

const own = pipeline.buildPipelineQuery(OFFICER, 's1');
check(own.sql.includes('lt_loan_contacts'),
  'an officer\'s pipeline is narrowed through the contact map');
check(own.sql.includes('override_staff_id'),
  '…and honours a PILOT-side reassignment as well as the Encompass assignment');
bindsCleanly(own, 'officer');

const all = pipeline.buildPipelineQuery(ADMIN, 's2');
check(!all.sql.includes('lt_loan_contacts c\n'),
  'an admin gets NO scope clause at all');
check(all.params.length === 0,
  'THE 42P18 CASE: a sees-all viewer leaves NO unreferenced parameter behind');
bindsCleanly(all, 'admin');

const closer = pipeline.buildPipelineQuery(CLOSER, 's3');
check(closer.params.length === 0,
  'a closer sees the whole book — including files not yet assigned, which is the owner\'s rule');

// The fragment must be composed from access.js, not rewritten here.
const direct = access.pipelineScopeSql(OFFICER, 's1', 1);
check(own.sql.includes(direct.where.trim().split('\n')[0].trim()),
  'the scope SQL comes from access.js — the pipeline does not write its own');

// ── Filters, and the placeholder arithmetic under them ──────────────────────
console.log('\nfilters — appended, never ($n IS NULL OR ...)');

const filtered = pipeline.buildPipelineQuery(OFFICER, 's1', {
  stage: 'underwriting', folder: 'Pipeline', search: 'smith', officerStaffId: 's9',
});
bindsCleanly(filtered, 'officer + four filters');
check(filtered.params.includes('underwriting') && filtered.params.includes('Pipeline'),
  'each filter contributes its own parameter');
check(filtered.params.some((v) => String(v).includes('smith')),
  'the search term is a parameter, never interpolated');
check(!/IS NULL OR/i.test(filtered.sql),
  'a filter that was not asked for is ABSENT from the SQL — never a ($n IS NULL OR col = $n) planner trap');

const none = pipeline.buildPipelineQuery(ADMIN, 's2', {});
check(!none.sql.includes('stage_key ='), 'an unfiltered query mentions no filter at all');
bindsCleanly(none, 'admin, no filters');

// A sees-all viewer with filters: the filters must start at $1, because the scope
// contributed nothing. This is the exact arithmetic that produced 42P18.
const adminFiltered = pipeline.buildPipelineQuery(ADMIN, 's2', { stage: 'closing' });
check(adminFiltered.params.length === 1 && adminFiltered.sql.includes('$1'),
  'with no scope clause the first FILTER takes $1 — the counter follows the SQL, not the caller');
bindsCleanly(adminFiltered, 'admin + filter');

check(pipeline.buildPipelineQuery(ADMIN, 's2', { unassigned: true }).sql.includes('NOT EXISTS'),
  'the "nobody is on it yet" filter is a NOT EXISTS over the contact map');

// ── Sorting is an allowlist ─────────────────────────────────────────────────
console.log('\nsorting — an allowlist, because an identifier has no placeholder');

const bogus = pipeline.buildPipelineQuery(ADMIN, 's2', { sort: 'l.id; DROP TABLE lt_loans--' });
check(bogus.sort === pipeline.DEFAULT_SORT && !bogus.sql.includes('DROP TABLE'),
  'an unknown sort falls back to the default — a sort column is interpolated, so only a name we chose is safe');
check(pipeline.buildPipelineQuery(ADMIN, 's2', { sort: 'loan_amount', dir: 'asc' }).sql.includes('ASC'),
  'a known sort and direction are honoured');
check(pipeline.buildPipelineQuery(ADMIN, 's2', { dir: "'; DROP" }).sql.includes('DESC'),
  'anything that is not "asc" is DESC — the direction is never interpolated from input');
check(pipeline.buildPipelineQuery(ADMIN, 's2').sql.includes('NULLS LAST'),
  'a never-synced loan does not head the list just because its stamp is empty');

// ── Paging is bounded ───────────────────────────────────────────────────────
console.log('\npaging');

check(pipeline.buildPipelineQuery(ADMIN, 's2', { limit: 100000 }).limit === pipeline.MAX_LIMIT,
  'the page size has a ceiling — a caller may ask for a smaller page, never an unbounded one');
check(pipeline.buildPipelineQuery(ADMIN, 's2', { limit: 0 }).limit >= 1
   && pipeline.buildPipelineQuery(ADMIN, 's2', { limit: -5 }).limit >= 1,
  'a zero or negative page size still returns rows rather than an empty screen');
check(pipeline.buildPipelineQuery(ADMIN, 's2', { offset: -10 }).offset === 0,
  'a negative offset is clamped, not passed to Postgres');
check(pipeline.buildPipelineQuery(ADMIN, 's2', { limit: 'abc' }).limit === pipeline.DEFAULT_LIMIT,
  'junk falls back to the default page size');

// ── The count describes the same rows as the page ───────────────────────────
console.log('\nthe count and the page agree');

const q = pipeline.buildPipelineQuery(OFFICER, 's1', { stage: 'closing', search: 'x' });
check(q.countSql.includes('count(*)') && !q.countSql.includes('LIMIT'),
  'the count is unpaged…');
// Compared with whitespace squashed: the two are built from the same `whereSql`
// string but land in differently-indented templates, and a formatting difference is
// not a behavioural one. What must hold is that the CONDITIONS are identical.
// The MAIN where, located after the FROM — the first `WHERE` in the statement
// belongs to the contacts sub-select in the SELECT list, so `indexOf('WHERE')`
// grabs the wrong clause.
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const mainWhereAt = q.sql.indexOf('WHERE', q.sql.indexOf('LEFT JOIN borrowers'));
const wherePart = squash(q.sql.slice(mainWhereAt, q.sql.indexOf('ORDER BY')));
check(squash(q.countSql).includes(wherePart),
  '…and carries the IDENTICAL WHERE, so the total can never describe a different set than the page');
check(q.countSql.includes('LEFT JOIN borrowers'),
  'both sides LEFT JOIN the borrower record — an inner join would silently shrink somebody\'s whole book');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

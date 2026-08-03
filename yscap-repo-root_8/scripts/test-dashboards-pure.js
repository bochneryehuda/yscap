/**
 * Dashboards — the filter compiler and the catalogue, with no database.
 *
 * This is the injection suite. The whole feature rests on one invariant, so it is asserted
 * directly rather than inferred: NOTHING a person types ever becomes SQL. Every field,
 * operator, breakdown, grain and sort comes from a code-owned catalogue by exact key
 * lookup, and every value comes back as a `$n` placeholder with its own bound parameter.
 *
 * Also pinned here: the catalogue cannot drift out of step with itself (a measure or a
 * default card naming a field that no longer exists), because a stored card that silently
 * matches nothing is indistinguishable from a real zero.
 *
 * Run: node scripts/test-dashboards-pure.js
 */
'use strict';

const REPO = __dirname + '/..';
const registry = require(REPO + '/src/lib/dashboards/registry');
const compile = require(REPO + '/src/lib/dashboards/compile');
const store = require(REPO + '/src/lib/dashboards/store');
const seed = require(REPO + '/src/lib/dashboards/seed');
const rules = require(REPO + '/src/lib/conditions/rules');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
const throws = (fn, m) => { try { fn(); fail++; console.log('  ✗ FAIL', m, '(it did NOT refuse)'); } catch (_) { pass++; console.log('  ✓', m); } };

const NO_SCOPE = { sql: '', params: [] };
const card = (over) => ({ metric_key: 'file_count', ...over });

console.log('\n1. nothing a person types becomes SQL');
{
  // The classic attempt, through every door a spec has.
  const evil = "'; DROP TABLE applications; --";

  throws(() => compile.buildAggregate(card({ metric_key: evil }), NO_SCOPE), 'a measure name is looked up, never interpolated');
  throws(() => compile.buildAggregate(card({ group_by: evil }), NO_SCOPE), 'a breakdown is looked up, never interpolated');
  throws(() => compile.buildAggregate(card({ grain: evil, date_field: 'created_at' }), NO_SCOPE), 'a time grain is looked up, never interpolated');
  throws(() => compile.buildAggregate(card({ date_field: evil, period: { kind: 'ytd' } }), NO_SCOPE), 'a date field is looked up, never interpolated');
  throws(() => compile.buildAggregate(card({
    filter: { combinator: 'and', rules: [{ field: evil, operator: 'eq', value: 1 }] },
  }), NO_SCOPE), 'an unknown filter field is refused');
  throws(() => compile.buildAggregate(card({
    filter: { combinator: 'and', rules: [{ field: 'status', operator: evil, value: 1 }] },
  }), NO_SCOPE), 'an unknown operator is refused');

  // A prototype key must not resolve to a function.
  for (const k of ['__proto__', 'constructor', 'prototype', 'toString']) {
    throws(() => compile.buildAggregate(card({
      filter: { combinator: 'and', rules: [{ field: k, operator: 'eq', value: 'x' }] },
    }), NO_SCOPE), `"${k}" is not a field (hasOwnProperty, not a bare lookup)`);
  }

  // A VALUE containing SQL is fine — it is bound, so it is just text.
  const q = compile.buildAggregate(card({
    filter: { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: evil }] },
  }), NO_SCOPE);
  ok(!q.text.includes('DROP TABLE'), 'a value containing SQL never appears in the query text');
  ok(q.values.includes(evil), '…it appears as a bound parameter instead');
  ok(/\$\d+::text/.test(q.text), '…with an explicit type cast on the placeholder');
}

console.log('\n2. the operator table is the conditions engine’s, not a second one');
{
  for (const f of registry.FILTER_FIELDS) {
    if (!rules.OPERATORS_BY_TYPE[f.type]) { ok(false, `field ${f.key} has an unknown type "${f.type}"`); break; }
  }
  ok(registry.FILTER_FIELDS.every((f) => rules.OPERATORS_BY_TYPE[f.type]),
    `all ${registry.FILTER_FIELDS.length} filter fields use a type the shared rule engine knows`);
  ok(registry.FILTER_FIELDS.every((f) => typeof f.sql === 'string' && f.sql.length),
    'every field carries developer-written SQL');
  const dupes = registry.FILTER_FIELDS.map((f) => f.key).filter((k, i, a) => a.indexOf(k) !== i);
  ok(dupes.length === 0, `no duplicate field keys${dupes.length ? ' (' + dupes.join(', ') + ')' : ''}`);
}

console.log('\n3. null semantics — "is" and "is not" cover everything between them');
{
  const p = compile.makeParams();
  const pos = compile.compileRow({ field: 'note_buyer', operator: 'eq', value: 'x' }, p);
  const neg = compile.compileRow({ field: 'note_buyer', operator: 'neq', value: 'x' }, p);
  ok(!/IS NULL/.test(pos), 'a positive comparison does not match a blank');
  ok(/IS NULL/.test(neg), 'a negative comparison DOES match a blank, so the two halves sum to the whole');
  const notIn = compile.compileRow({ field: 'status', operator: 'not_in', value: ['funded'] }, p);
  ok(/IS NULL/.test(notIn), '…the same for "is none of"');
  const notC = compile.compileRow({ field: 'city', operator: 'not_contains', value: 'x' }, p);
  ok(/IS NULL/.test(notC), '…and for "does not contain"');
}

console.log('\n4. LIKE wildcards a person types are text, not wildcards');
{
  ok(compile.likeEscape('100%') === '100\\%', 'a percent sign is escaped');
  ok(compile.likeEscape('a_b') === 'a\\_b', 'an underscore is escaped');
  ok(compile.likeEscape('c:\\x') === 'c:\\\\x', 'a backslash is escaped');
  const p = compile.makeParams();
  const sql = compile.compileRow({ field: 'city', operator: 'contains', value: '50%' }, p);
  ok(/ESCAPE/.test(sql), "the ESCAPE clause is stated explicitly, so the meaning can't shift");
  ok(p.values[0] === '%50\\%%', 'and the pattern is bound, with the literal percent escaped inside it');
}

console.log('\n5. the scope and the soft-delete guard are never optional');
{
  const q = compile.buildAggregate(card({}), { sql: '(a.loan_officer_id=$1)', params: ['who'] }, { seed: ['who'] });
  ok(q.text.includes('a.deleted_at IS NULL'), 'a deleted file can never inflate a figure');
  ok(q.text.includes('a.loan_officer_id=$1'), "the viewer's scope is in the WHERE");
  ok(q.values[0] === 'who', 'and their id is bound, not written into the SQL');

  // The clause is only emitted when it is bound: an unreferenced parameter is a hard
  // Postgres bind failure (42P18), not a harmless extra.
  const wide = compile.buildAggregate(card({}), NO_SCOPE);
  ok(!/\$1/.test(wide.text) && wide.values.length === 0,
    'a see-everything viewer binds nothing, so there is no unreferenced placeholder');
}

console.log('\n6. the number and the list are one predicate (#145)');
{
  const c = card({
    filter: { combinator: 'and', rules: [{ field: 'status', operator: 'eq', value: 'funded' }] },
    date_field: 'actual_closing', period: { kind: 'ytd' },
  });
  const scope = { sql: '(a.loan_officer_id=$1)', params: ['me'] };
  const agg = compile.buildAggregate(c, scope, { seed: scope.params });
  const list = compile.buildDrillList(c, scope, { seed: scope.params });
  const whereOf = (s) => s.text.split('WHERE ')[1].split(/GROUP BY|ORDER BY/)[0].trim();
  ok(whereOf(agg) === whereOf(list), 'the card and its drill-through compile the identical WHERE');
  ok(JSON.stringify(agg.values) === JSON.stringify(list.values), '…bound with the identical values');
}

console.log('\n7. a date range actually reaches the query');
{
  // This one is here because it did NOT, once: buildWhere read `dateField` while a stored
  // card carries `date_field`, so the period was silently dropped and the card still
  // looked right on screen.
  const q = compile.buildAggregate(card({ date_field: 'actual_closing', period: { kind: 'ytd' } }), NO_SCOPE);
  ok(/date_trunc\('year', CURRENT_DATE\)/.test(q.text), 'a year-to-date period is in the WHERE');
  const q2 = compile.buildAggregate(card({ date_field: 'actual_closing', period: { kind: 'last_months', n: 12 } }), NO_SCOPE);
  ok(/interval '12 months'/.test(q2.text), 'a rolling 12-month period is in the WHERE');
  const q3 = compile.buildAggregate(card({ date_field: 'actual_closing', period: { kind: 'all' } }), NO_SCOPE);
  ok(!/CURRENT_DATE/.test(q3.text), 'and "all time" adds no date predicate at all');
  throws(() => compile.buildAggregate(card({ date_field: 'actual_closing', period: { kind: 'fixed', from: 'nope', to: 'x' } }), NO_SCOPE),
    'a fixed period with a junk date is refused');
}

console.log('\n8. time grouping never picks up a timezone');
{
  const q = compile.buildAggregate(card({ date_field: 'actual_closing', grain: 'month' }), NO_SCOPE);
  ok(/::timestamp\)/.test(q.text) && !/::timestamptz/.test(q.text),
    'a calendar date is grouped as a plain timestamp — a zone would shift month-end into the next month');
}

console.log('\n9. grouped queries are bounded');
{
  const q = compile.buildAggregate(card({ group_by: 'city' }), NO_SCOPE);
  ok(/LIMIT \d+/.test(q.text), 'a breakdown always carries a LIMIT');
  // The query asks for ONE more bucket than it will draw, purely so the answer can tell
  // "exactly the cap" from "more than the cap" and say so on the card. What is CAPPED is
  // what a person sees, and that stays 200 however large a number is asked for.
  const huge = compile.buildAggregate(card({ group_by: 'city', limit: 99999 }), NO_SCOPE);
  ok(huge.limit === 200, 'and the cap cannot be raised past 200 by asking');
  ok(/LIMIT 201\b/.test(huge.text), '…while one extra row is fetched, so truncation is detectable');
  const list = compile.buildDrillList(card({}), NO_SCOPE, { limit: 999999 });
  ok(/LIMIT 1000\b/.test(list.text), 'a drill-through list is capped at 1000');
}

console.log('\n10. nesting is capped, and the shape people need still fits');
{
  const two = { combinator: 'and', rules: [
    { combinator: 'or', rules: [{ field: 'state', operator: 'eq', value: 'NJ' }] },
    { combinator: 'or', rules: [{ field: 'status', operator: 'eq', value: 'funded' }] }] };
  ok(compile.validateFilter(two).length === 0, '(A or B) and (C or D) is allowed — the shape real questions need');
  const three = { combinator: 'and', rules: [{ combinator: 'or', rules: [
    { combinator: 'and', rules: [{ field: 'state', operator: 'eq', value: 'NJ' }] }] }] };
  ok(compile.validateFilter(three).length > 0, 'a third level is refused');
}

console.log('\n11. the catalogue does not contradict itself');
{
  for (const [k, m] of Object.entries(registry.MEASURES)) {
    if (m.kind !== 'ratio') continue;
    const probs = [...compile.validateFilter(m.numerator), ...compile.validateFilter(m.denominator || null)];
    ok(probs.length === 0, `the ratio "${m.label}" is built from fields that exist${probs.length ? ': ' + probs.join('; ') : ''}`);
  }
  ok(Object.values(registry.MEASURES).every((m) => m.kind === 'ratio' || typeof m.sql === 'string'),
    'every non-ratio measure has an aggregate expression');
  ok(Object.values(registry.DIMENSIONS).every((d) => typeof d.sql === 'string'),
    'every breakdown has developer-written SQL');
  ok(Object.values(registry.DATE_FIELDS).every((d) => typeof d.sql === 'string'),
    'every date field has developer-written SQL');
}

console.log('\n12. every card we ship is one the validator accepts');
{
  const all = [...seed.ADMIN_CARDS, ...seed.OFFICER_CARDS, ...seed.PROCESSOR_CARDS];
  let bad = 0;
  for (const c of all) {
    const probs = store.validateCard(c);
    if (probs.length) { bad++; console.log('    ', c.title, '→', probs.join('; ')); }
  }
  ok(bad === 0, `all ${all.length} shipped default cards validate against the live catalogue`);
  // The research is firm that an executive screen stops working past ~5 headline numbers.
  for (const [name, set] of [['admin', seed.ADMIN_CARDS], ['officer', seed.OFFICER_CARDS], ['processor', seed.PROCESSOR_CARDS]]) {
    const heroes = set.filter((c) => c.band === 'hero').length;
    ok(heroes <= 4, `the ${name} dashboard leads with ${heroes} headline cards (never more than 4)`);
  }
}

console.log('\n13. a card the catalogue no longer supports is refused, not silently emptied');
{
  ok(store.validateCard({ title: 'x', metric_key: 'gone_away' }).length > 0, 'an unknown measure is caught at save time');
  ok(store.validateCard({ title: 'x', metric_key: 'file_count', group_by: 'gone' }).length > 0, 'as is an unknown breakdown');
  ok(store.validateCard({ title: 'x', metric_key: 'file_count', grain: 'month' }).length > 0,
    'a trend with no date to group on is caught');
  ok(store.validateCard({ title: 'x', metric_key: 'file_count',
    filter: { combinator: 'and', rules: [{ field: 'nope', operator: 'eq', value: 1 }] } }).length > 0,
  'as is a filter naming a field that no longer exists');
  ok(store.validateCard({ title: 'ok', metric_key: 'file_count' }).length === 0, 'and a good card passes');
}

console.log('\n14. the editor never shows a "how many" the card is not using');
{
  // THE CROSS-LAYER CONTRACT, pinned because this exact drift shipped twice. The editor
  // decides what to put in the "How many?" box; the server's compile.periodN decides what
  // the query actually does. They are two files, two languages' worth of defaults, and
  // nothing but this check stops them disagreeing — the first version seeded the box with
  // the NEW-CARD default (12) while the server defaulted an absent value to 30, so the box
  // described a window the card was not running and an untouched Save wrote that in.
  //
  // Read straight out of the shipped component so the test cannot pass against a copy of
  // the rule that the editor no longer uses.
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../app-v2/src/components/DashboardCardEditor.jsx', 'utf8');
  const nOkSrc = (src.match(/const nOk = ([\s\S]*?);\n/) || [])[1];
  const effSrc = (src.match(/const effectiveN = ([\s\S]*?);\n/) || [])[1];
  ok(!!nOkSrc && !!effSrc, 'the editor still defines both nOk and effectiveN');
  /* eslint-disable no-eval */
  const nOk = eval(nOkSrc);
  const effectiveN = eval(effSrc);
  const shown = (n) => (nOk(n) ? Number(n) : effectiveN(n));

  const cases = [undefined, null, '', 0, false, [], ' ', NaN, 1.5, -5, 5000, 3651, 12, '12', 3650, [5], '0012'];
  const off = cases.filter((n) => shown(n) !== compile.periodN({ n }));
  ok(off.length === 0,
    `the box shows exactly what the query uses, for every stored value (${off.length ? JSON.stringify(off) : 'all 17 agree'})`);
  ok(shown(undefined) === 30 && compile.periodN({}) === 30,
    'a card with no "how many" reads 30 on both sides — not the new-card default');
  ok(shown(1.5) === 1, 'and a stored 1.5 reads as the 1 day it really runs');

  // …AND THAT THE EDITOR STILL CALLS THEM. The checks above prove the two definitions
  // agree with the server; they say nothing about the lines that use them, so reverting
  // either call site reproduces the original defect with this section still green. Both
  // regressions were real, so both sites are pinned.
  ok(/n:\s*effectiveN\(d\.period\.n\)/.test(src),
    'the card being OPENED is seeded from what it runs, not from the new-card default');
  ok(/NEEDS_N\.includes\(kind\)\s*&&\s*!nOk\(period\.n\)/.test(src),
    'and the period dropdown re-seeds on that same shared rule');
}

console.log(`\ndashboards-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

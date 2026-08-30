'use strict';
/**
 * LT test — THE REPORTING DATABASE.
 *
 * WHY THIS EXISTS. The owner asked for a reporting centre (2026-08-30): *"a full
 * reporting center where I can see for every file how long it took between which
 * and which step and who the processor was in that file, and then reporting per
 * processor … so I can start scoring how many files each processor has and her
 * efficiency."*
 *
 * Two classes of promise are made by that build, and neither has a runtime error
 * to catch it going wrong:
 *
 *   1. THE COMPILER IS THE SECURITY BOUNDARY. A saved report is authored by a
 *      person and stored as jsonb; if a key, a sort or an operator could reach the
 *      statement as text, an admin-authored REPORT becomes an admin-authored
 *      QUERY. Nothing errors when that guard is loosened — the report simply
 *      starts working on inputs it should have refused.
 *
 *   2. A DURATION PILOT DID NOT WITNESS MUST NEVER BE A NUMBER. The whole database
 *      exists because `lt_loan_milestones` is a MIRROR of Encompass and cannot say
 *      when a step FINISHED. A guard that answered 0 instead of "unknown" would
 *      publish a baseline wearing a real number's clothes, under a person's name,
 *      and every figure downstream would be quietly wrong.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. Anything that needs a real Postgres — that the
 * generated SQL runs, that the LATERAL join does not multiply a loan row, that the
 * percentile is right. Those are facts about a database and belong in a DB suite.
 * This guards the rules that decide what that SQL is allowed to be.
 *
 * PURE. No database, no network, no browser.
 */

const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/**
 * The comments in these files EXPLAIN the rules and therefore necessarily quote
 * the shapes being forbidden — a guard that read them would fail on its own
 * explanation and then get "fixed" by deleting the explanation.
 */
const code = (p) => R(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const spans = require('../src/longterm/reporting/spans');
const fields = require('../src/longterm/reporting/fields');
const query = require('../src/longterm/reporting/query');
const scorecard = require('../src/longterm/reporting/scorecard');

// ═══════════════════════════════════════════════════════════════════════════
// A. THE SPANS — the owner's two, plus context, and never a fabricated number
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nA. the spans the owner asked to be scored on');

const scored = spans.scorecardSpans();
check(scored.length === 2, `exactly two spans are SCORED against a person (${scored.length})`);
check(scored.some((s) => s.key === 'loan_setup' && s.from === 'loPrep' && s.to === 'submittal'),
  'loan setup runs LO Prep -> Submittal — the owner\'s "from the assign processor … till the submittal is done"');
check(scored.some((s) => s.key === 'processing' && s.from === 'submittal' && s.to === 'clearToClose'),
  'processing runs Submittal -> Clear To Close — the owner\'s "that\'s the processor\'s job"');

// The context spans exist so a reader can see where the rest of the time went;
// they must NEVER be scored against a person, because nobody on our side owns
// underwriting turn time or the wait between clear-to-close and funding.
const contextKeys = spans.allSpans().filter((s) => !s.scorecard).map((s) => s.key);
check(contextKeys.length >= 2, `there are context spans as well (${contextKeys.join(', ')})`);
check(spans.allSpans().every((s) => (s.ownerMilestone ? s.scorecard : !s.scorecard)),
  'a span is scored if and only if it names an owning milestone — one rule, never a second flag');

console.log('\nA2. a duration is measured, or it is REFUSED by name — never a zero');

// The rows here are real `lt_loan_milestones` shapes — the same column names the
// ladder sync writes — so this measures what production actually hands it, not a
// convenient object invented for the test.
const T = (iso, baseline = false) => ({ done: true, observed_done_at: iso, observed_is_baseline: baseline });
const measured = spans.measureSpan(T('2026-01-01T09:00:00Z'), T('2026-01-13T09:00:00Z'));
check(measured.ok === true && measured.days === 12, `a real span measures in days (${measured.days})`);

for (const [name, from, to, reason] of [
  ['no step at all', null, T('2026-01-13T09:00:00Z'), 'no_step'],
  ['the step has not been reached', T('2026-01-01T09:00:00Z'), { done: false }, 'not_reached'],
  ['the START was a baseline', T('2026-01-01T09:00:00Z', true), T('2026-01-13T09:00:00Z'), 'baseline_start'],
  ['the END was a baseline', T('2026-01-01T09:00:00Z'), T('2026-01-13T09:00:00Z', true), 'baseline_end'],
  ['the end is before the start', T('2026-01-13T09:00:00Z'), T('2026-01-01T09:00:00Z'), 'backwards'],
]) {
  const r = spans.measureSpan(from, to);
  check(r.ok === false && r.days === null && r.hours === null && r.reason === reason,
    `${name} -> unknown, reason "${r.reason}", and NOT a number (${JSON.stringify(r.days)})`);
  check(typeof r.why === 'string' && r.why.length > 20,
    `  ...and it says WHY in a sentence a person can act on, not a code`);
}

// EVERY REASON IS A DIFFERENT PIECE OF WORK for a different person, so no two of
// them may collapse into one message: "the file has not got there yet" is the
// pipeline working, and "we were already past it" is a gap nothing can close.
const sentences = Object.values(spans.REASON);
check(new Set(sentences).size === sentences.length,
  `all ${sentences.length} refusal sentences are distinct — none silently reads as another`);

// THE ONE THAT MATTERS MOST. A file already past both ends when PILOT first read
// it looks, on the mirror alone, exactly like a file that took no time at all.
const bothBaseline = spans.measureSpan(T('2026-01-01T09:00:00Z', true), T('2026-01-01T09:00:00Z', true));
check(bothBaseline.days === null && bothBaseline.reason === 'baseline_start',
  'a file PILOT was already past reports UNKNOWN, never "same day" — the whole reason db/642 exists');

console.log('\nA3. who owned the step: the completion SNAPSHOT beats the mirror');
const snap = spans.spanOwner({ done_associate_id: 'a', done_associate_name: 'Chaya', associate_name: 'Somebody Else' });
check(snap.name === 'Chaya' && snap.source === 'snapshot',
  'the person recorded at COMPLETION wins over whoever holds the step today');
const current = spans.spanOwner({ associate_id: 'b', associate_name: 'Somebody Else' });
check(current.name === 'Somebody Else' && current.source === 'current',
  'with no snapshot it falls back to the current holder AND says so, so nobody reads it as a record');
check(spans.spanOwner(null).name === null, 'and an unowned step names nobody rather than guessing');

// ═══════════════════════════════════════════════════════════════════════════
// B. THE CATALOG — the investor never reaches a client, and the ladder is derived
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nB. the field catalog');

const internal = fields.fieldsFor('internal');
const client = fields.fieldsFor('client');
check(internal.length > client.length, `internal sees more than a client does (${internal.length} vs ${client.length})`);
check(internal.some((f) => f.key === 'investor_name'), 'internal staff may report on the investor');
check(!client.some((f) => f.key === 'investor_name'),
  'a client audience cannot — CLAUDE.md rule 10, on every surface');
// FAIL CLOSED. Anything that is not exactly the word `internal` is a client.
for (const a of [undefined, null, '', 'INTERNAL', 'staff', 'admin', true, 1]) {
  check(!fields.fieldsFor(a).some((f) => f.internalOnly),
    `audience ${JSON.stringify(a)} is treated as a client — it fails CLOSED`);
}
check(fields.allFields().filter((f) => f.internalOnly).every((f) => f.group === 'Investor'),
  'every internal-only field is an investor field — nothing else is silently hidden from a client report');

console.log('\nB2. the milestone and span columns are GENERATED, never a second list');
const ladder = fields.ladderFields();
for (const s of spans.scorecardSpans()) {
  check(ladder.some((f) => f.key === `span_${s.key}_days`), `span "${s.key}" has a duration column`);
  check(ladder.some((f) => f.key === `span_${s.key}_owner`), `span "${s.key}" has a "who" column`);
}
// A renamed milestone must move the COLUMN LABEL with it, or the report and the
// pipeline would call one step two things.
const renamed = fields.ladderFields({ submittal: 'Sent to Underwriting' });
check(renamed.some((f) => f.label.startsWith('Sent to Underwriting')),
  'renaming a milestone in settings renames its columns — the label is not hard-coded');

// ═══════════════════════════════════════════════════════════════════════════
// C. THE COMPILER — the whole security boundary
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nC. nothing the caller types reaches the statement');

const refuses = (def, opts, what) => {
  try {
    query.compile(def, { audience: 'internal', ...(opts || {}) });
    failures += 1;
    console.error(`  FAIL ${what} — it COMPILED, which means the guard is gone`);
    return null;
  } catch (e) {
    const ok = e instanceof query.ReportError;
    check(ok, `${what} — refused (${ok ? String(e.message).slice(0, 90) : `WRONG ERROR TYPE: ${e.message}`})`);
    return e;
  }
};

refuses({ columns: ['l.id; DROP TABLE lt_loans'] }, null, 'a column that is raw SQL rather than a catalog key');
refuses({ columns: ['loan_number'], sort: 'l.id; DROP TABLE lt_loans' }, null, 'a SORT that is raw SQL');
refuses({ columns: ['no_such_field'] }, null, 'a column that simply does not exist');
refuses({ columns: ['loan_number'], filter: { combinator: 'and', rules: [{ field: 'nope', operator: 'eq', value: 1 }] } },
  null, 'a FILTER naming a field that does not exist');
refuses({ columns: ['investor_name'] }, { audience: 'client' }, 'the INVESTOR asked for by a client report');
refuses({ columns: ['loan_number'], filter: { combinator: 'and', rules: [{ field: 'loan_amount', operator: 'contains', value: 'x' }] } },
  null, 'a TEXT operator applied to a money column');
refuses({ columns: ['loan_number'], filter: { combinator: 'and', rules: [{ field: 'loan_amount', operator: 'gt', value: 'not a number' }] } },
  null, 'a value that cannot be cast to the column\'s type');

// The refusal has to be ACTIONABLE. "unknown field" sends nobody anywhere; naming
// the field, and saying when it exists but is internal, is what makes it fixable.
const clientRefusal = (() => {
  try { query.compile({ columns: ['investor_name'] }, { audience: 'client' }); return ''; }
  catch (e) { return e.message; }
})();
check(/internal/i.test(clientRefusal),
  'and a client asking for an internal field is TOLD it is internal, not told it does not exist');

console.log('\nC2. every value that does reach the statement is BOUND');
const compiled = query.compile({
  columns: ['loan_number', 'borrower_name', 'loan_amount'],
  filter: {
    combinator: 'and',
    rules: [
      { field: 'loan_amount', operator: 'gt', value: 250000 },
      { field: 'borrower_name', operator: 'contains', value: "O'Brien; DROP TABLE lt_loans--" },
      { field: 'property_state', operator: 'in', value: ['NY', 'NJ'] },
    ],
  },
  sort: 'loan_amount',
  dir: 'asc',
  limit: 25,
}, { audience: 'internal' });

check(!/DROP TABLE/i.test(compiled.text),
  'a filter value carrying SQL never appears in the statement text');
check(compiled.params.some((p) => String(p).includes('O\'Brien')),
  'it is carried as a bound PARAMETER instead');
check(/ORDER BY .* ASC NULLS LAST/.test(compiled.text),
  'the sort direction is a whitelisted word, and blanks sort LAST in both directions');
check(compiled.limit === 25 && compiled.params.includes(26),
  'the cap is bound and asks for one MORE row than the limit, so "capped" can be MEASURED');
check(/count\(\*\) OVER \(\)/.test(compiled.text),
  'and the total the filters match travels with the page, so a cap can never read as "that is all there is"');

console.log('\nC3. the tenant\'s milestone names are bound, never interpolated');
const withMs = query.compile({ columns: ['span_processing_days'] }, {
  audience: 'internal',
  milestones: { submittal: "Sub'mittal", clearToClose: 'CTC' },
});
check(!/Sub'mittal/.test(withMs.text) && withMs.params.includes("Sub'mittal"),
  'a milestone name with an apostrophe is a PARAMETER — a tenant\'s own wording can never break the query');

console.log('\nC4. a report with no columns answers with the file, never a blank table');
const bare = query.compile({}, { audience: 'internal' });
check(bare.columns.length > 0 && bare.columns.some((c) => c.key === 'loan_number'),
  `an empty definition falls back to the file's own identity (${bare.columns.map((c) => c.key).join(', ')})`);

console.log('\nC5. the row cap has a ceiling the caller cannot raise');
const huge = query.compile({ columns: ['loan_number'], limit: 999999 }, { audience: 'internal' });
check(huge.limit === fields.MAX_ROWS, `a caller asking for 999999 rows gets ${fields.MAX_ROWS}`);
const zero = query.compile({ columns: ['loan_number'], limit: 0 }, { audience: 'internal' });
check(zero.limit === fields.DEFAULT_ROWS, 'and a nonsense cap falls back to the default rather than returning nothing');

console.log('\nC6. a LIKE wildcard somebody types is a literal, not a match-all');
check(query.escapeLike('100%') === '100\\%' && query.escapeLike('YSCAP_') === 'YSCAP\\_',
  'a typed % or _ is escaped — otherwise a "contains" search silently becomes every file');

// ═══════════════════════════════════════════════════════════════════════════
// D. THE SCORECARD — weighted by measured work, and never a confident empty list
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nD. the desk average is weighted by MEASURED spans');
const rolled = scorecard._internals.rollUp([
  { files: 40, measured: 38, avgDays: 12 },
  { files: 2, measured: 2, avgDays: 60 },
]);
check(rolled.files === 42 && rolled.measured === 40 && rolled.unknown === 2,
  `the counts add up (${rolled.files} files, ${rolled.measured} measured, ${rolled.unknown} unknown)`);
check(Math.abs(rolled.avgDays - 14.4) < 0.01,
  `the average is 14.4, not the 36 a mean-of-means would give (${rolled.avgDays})`);
const noWork = scorecard._internals.rollUp([{ files: 3, measured: 0, avgDays: null }]);
check(noWork.avgDays === null,
  'with nothing measured the average is UNKNOWN, never 0 — a zero would read as instant work');

const sc = code('src/longterm/reporting/scorecard.js');
check(/degraded\s*=/.test(sc) && /degraded,/.test(sc),
  'a failed read is reported as DEGRADED rather than as an empty list — "nobody did any work" is the confident wrong answer');
check(/caveat:/.test(sc),
  'and every scorecard carries the baseline caveat in words, so the figures are never read without it');

// ═══════════════════════════════════════════════════════════════════════════
// E. THE ROUTES — scope is appended, the scorecard needs the whole book
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nE. the HTTP layer');
const routes = code('src/longterm/routes/reports.js');

check(/audience: 'internal'/.test(routes) && !/audience: 'client'/.test(routes),
  'every route behind the staff mount reads as INTERNAL — stated once, in one place');
check(/scope: scopeClause\(viewer, staffId\(req\)\)/.test(routes),
  'the RUN appends the viewer\'s own book to the report');
check(/access\.pipelineScopeSql/.test(routes),
  'and it is built from the pipeline\'s OWN scope rule, never a second copy of who-sees-what');
check(/\$SCOPE\$\{i\}/.test(routes) || /\$SCOPE/.test(routes),
  'the scope is re-keyed to the compiler\'s own placeholder so the compiler binds it');
check(/if \(!viewer\.seesAll\)/.test(routes) && /scorecard/.test(routes),
  'the SCORECARD is refused to somebody scoped to their own pipeline');
check(/query\.compile\(def, \{ audience: 'internal'/.test(routes),
  'a report is COMPILED before it is saved, so nobody finds out it is broken while showing it to somebody');
check(/loadScopedLoan/.test(routes),
  'the per-file timeline goes through the same loader every other per-file route uses');
check(/instanceof query\.ReportError/.test(routes),
  'a refusal reaches the reader as its own sentence, never as a 500');
check(!/req\.body[\s\S]{0,400}db\.query\(`[\s\S]*?\$\{/.test(routes),
  'nothing from the request body is interpolated into a statement here');

// The saved-report doors must not let somebody rewrite or delete a report that is
// not theirs. Ownership is enforced IN THE STATEMENT (a WHERE that matches no row)
// rather than by a check somebody can forget to write.
check((routes.match(/owner_staff_id = \$\d+ OR \(\$\d+ = true AND visibility = 'shared'\)/g) || []).length === 2,
  'both the UPDATE and the DELETE carry the ownership test in their own WHERE');

// ═══════════════════════════════════════════════════════════════════════════
// F. THE SCREEN — it exists, it is reachable, and it never prints a false zero
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nF. the reporting centre is on somebody\'s screen');
const screen = code('app-v2/src/longterm/LtReports.jsx');
const app = code('app-v2/src/App.jsx');
const layout = code('app-v2/src/components/StaffLayout.jsx');

check(/<Route path="\/internal\/lt\/reports"/.test(app), 'the screen has a route');
check(/to="\/internal\/lt\/reports"/.test(layout), 'and a nav entry on the long-term side — a back end nobody can reach is not a feature');
check(/ltApi\.reportFields\(\)/.test(screen),
  'the column picker is drawn from the SERVER\'s catalog, so it can never offer a column the compiler refuses');
check(!/const FIELDS = \[/.test(screen) && !/investor_name/.test(screen),
  'and the browser keeps no second copy of the field list');
check(/result\.capped/.test(screen),
  'a capped page says so on screen');
check(/function days\(/.test(screen) && /return '—'/.test(screen),
  'an unknown duration is written as a dash, never as 0');
check(!/var\(--ink/.test(screen),
  'no --ink token is used as a text colour — in this palette those are LIGHT and render white on white');

// ═══════════════════════════════════════════════════════════════════════════
// G. SEPARATION — this whole build is Long-Term's own
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nG. nothing here crosses into the short-term product');
// The REPO-WIDE question — a raw read of an RTL table, a cross-product foreign
// key, an import either way — belongs to `scripts/check-product-separation.js`,
// which runs at the head of `npm test` and scans every file rather than the five
// this suite happens to know about. Re-implementing it here would be a second,
// worse copy of a gate that already bites. What IS worth pinning here is the one
// thing that suite cannot know: that these particular modules were built as
// Long-Term's own and did not quietly grow a require into RTL.
for (const f of [
  'src/longterm/reporting/spans.js',
  'src/longterm/reporting/fields.js',
  'src/longterm/reporting/query.js',
  'src/longterm/reporting/scorecard.js',
  'src/longterm/routes/reports.js',
]) {
  const src = code(f);
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const crossing = requires.filter((r) => /^\.\.\/\.\.\//.test(r) && !/^\.\.\/\.\.\/db$/.test(r));
  check(crossing.length === 0,
    `${f} requires nothing outside src/longterm${crossing.length ? ` (found ${crossing.join(', ')})` : ''}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll good.');
process.exit(failures ? 1 : 0);

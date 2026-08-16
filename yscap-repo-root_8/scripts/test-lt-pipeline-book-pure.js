'use strict';
/**
 * LT test — the live book and the closed book.
 *
 * The two properties this suite exists for, and both are about NOT hiding files:
 *
 *   1. WITH NO FOLDER NAMED, NOTHING CHANGES. The query is byte-identical to the one
 *      that ran before the split existed, every book selects the same rows, and the
 *      control row is not drawn. A tenant that has not configured this must not be
 *      able to tell the feature shipped.
 *
 *   2. AN UNLISTED FOLDER IS ALWAYS LIVE. Folder names are the tenant's own and the
 *      endpoint that lists them answers 403, so a guess would silently empty part of
 *      somebody's pipeline. Only an exactly-named folder is ever treated as finished.
 *
 * PURE — no database.
 */

const bookMod = require('../src/longterm/pipeline-book');
const pipeline = require('../src/longterm/pipeline');
const views = require('../src/longterm/views');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const VIEWER = { seesAll: true, scope: 'all' };
const CLOSED = ['Adverse', 'Trash'];

// ── Reading the setting ─────────────────────────────────────────────────────
console.log('what the tenant said is over');

check(bookMod.inactiveFolders({}).length === 0,
  'a tenant that has configured nothing has NO finished folders — the safe state, and the shipped default');

// Read here as well as in the database suite, deliberately. This is the one rule that
// would ship BROKEN to every tenant at once, and the suite that catches it must not be
// the one that skips itself when no database is in reach.
const declared = require('../src/longterm/settings/encompass-settings')
  .SETTINGS.find((s) => s.key === 'pipeline.inactiveFolders');
check(!!declared && Array.isArray(declared.default) && declared.default.length === 0,
  'THE ONE THAT MATTERS: the setting ships with an EMPTY list — a guessed folder name in the default would hide '
  + 'live loans on every tenant that installed it, on the first boot, with nobody having asked for it');
check(bookMod.inactiveFolders({ 'pipeline.inactiveFolders': 'Adverse' }).length === 0,
  'THE ONE THAT MATTERS: a value that is not a list reads as EMPTY, never as an error and never as a guess — '
  + 'an administrator who mistypes the setting must not be answered by a pipeline that hides files');
check(bookMod.inactiveFolders({ 'pipeline.inactiveFolders': null }).length === 0,
  'and so does a missing one');

const cleaned = bookMod.inactiveFolders({
  'pipeline.inactiveFolders': ['  Adverse  ', 'ADVERSE', 'Loan  Withdrawn', '', '   ', null, 'Trash'],
});
check(cleaned.join('|') === 'adverse|loan withdrawn|trash',
  'names are matched case-insensitively, spacing is collapsed, duplicates collapse, and blanks are dropped');
check(!cleaned.includes(''),
  'THE ONE THAT MATTERS: a blank entry never survives — an empty name would match the loans that carry NO '
  + 'folder, which are the newest files and the ones somebody is most likely looking for');

// ── The book names ──────────────────────────────────────────────────────────
console.log('\nwhich book was asked for');

check(bookMod.normalizeBook(undefined) === 'live' && bookMod.normalizeBook('') === 'live',
  'no answer means the LIVE book — what a desk works out of');
check(bookMod.normalizeBook('CLOSED') === 'closed' && bookMod.normalizeBook(' all ') === 'all',
  'casing and spacing are tolerated');
check(bookMod.normalizeBook('archive') === 'live' && bookMod.normalizeBook({}) === 'live',
  'a name nobody declared falls back to the live book rather than to an empty screen');

// ── Inert until configured ──────────────────────────────────────────────────
console.log('\nwith no folder named, every book is the same book');

const base = pipeline.buildPipelineQuery(VIEWER, null, {});
for (const b of ['live', 'closed', 'all', undefined]) {
  const q = pipeline.buildPipelineQuery(VIEWER, null, { book: b }, { inactiveFolders: [] });
  check(q.sql === base.sql && JSON.stringify(q.params) === JSON.stringify(base.params),
    `book=${b === undefined ? '(unset)' : b} produces the SAME statement and the SAME parameters as before the split existed`);
}
check(pipeline.buildPipelineQuery(VIEWER, null, { book: 'closed' }).sql === base.sql,
  'and a caller that passes no tenant config at all is unaffected too');
check(bookMod.bookSplitApplies([]) === false && bookMod.bookSplitApplies(undefined) === false,
  'so the screen is told there is no control to draw — three chips selecting identical rows is not a control');

// ── Configured: the split turns on ──────────────────────────────────────────
console.log('\nonce a folder is named, the books differ');

const live = pipeline.buildPipelineQuery(VIEWER, null, { book: 'live' }, { inactiveFolders: CLOSED });
const closed = pipeline.buildPipelineQuery(VIEWER, null, { book: 'closed' }, { inactiveFolders: CLOSED });
const both = pipeline.buildPipelineQuery(VIEWER, null, { book: 'all' }, { inactiveFolders: CLOSED });

check(live.sql !== base.sql && closed.sql !== base.sql,
  'the live and closed books each add a clause');
check(both.sql === base.sql,
  'THE ONE THAT MATTERS: "both" adds NOTHING — it is the whole table, so it must be the same statement '
  + 'the unsplit pipeline ran, not a clause that happens to select everything');
check(/NOT \(/.test(live.sql) && !/NOT \(/.test(closed.sql),
  'the live book is literally the NEGATION of the closed one, so no loan can fall into neither');
const folderParam = live.params.find((x) => Array.isArray(x));
check(!!folderParam,
  'the folder list travels as a bound PARAMETER — a tenant\'s typed folder name never reaches the query text');
check(folderParam && folderParam.join('|') === 'adverse|trash',
  'THE ONE THAT MATTERS: the list is NORMALIZED where the clause is built, not trusted from the caller — the SQL '
  + 'lower-cases only its own side, so a raw "Adverse" would match nothing and the closed book would read empty '
  + 'while the live book quietly became the whole table');
check(pipeline.buildFacetQueries(VIEWER, null, { book: 'live' }, { inactiveFolders: ['  ADVERSE  '] })
  .bookParams.find((x) => Array.isArray(x)).join('|') === 'adverse',
'…and the COUNT query normalizes it too, or the chip would read 0 finished on a tenant with plenty');
check(/COALESCE\(l\.loan_folder, ''\)/.test(live.sql),
  'THE ONE THAT MATTERS: the folder is COALESCEd before it is compared — a loan with NO folder must land in a '
  + 'book rather than being NULL-compared out of both, and the fail-toward-showing rule puts it in LIVE');
check(live.sql.includes(`regexp_replace(COALESCE(l.loan_folder, ''), '\\s+', ' ', 'g')`),
  'THE ONE THAT MATTERS: the SQL collapses the spacing INSIDE a folder name, exactly as folderKey does — btrim '
  + 'alone tidies only the ends, so "  loan   WITHDRAWN " would never equal the "Loan Withdrawn" somebody typed '
  + 'and a finished file would sit in a live book with nothing saying why');
check(/lower\(btrim\(regexp_replace\(/.test(live.sql),
  '…collapsing BEFORE trimming, so a leading run of spaces is taken too');

// A loan with no folder can never match a configured name, which is what makes the
// COALESCE above land it in `live` rather than in `closed`.
check(!bookMod.inactiveFolders({ 'pipeline.inactiveFolders': ['Adverse', ''] }).includes(''),
  'and nothing in the list can ever equal that empty string');

// ── The placeholder discipline ──────────────────────────────────────────────
console.log('\nthe placeholders still line up');

// Postgres 42P18: a hard-coded `$1` becomes an unreferenced parameter the moment a
// clause is dropped. Every fragment here is built from a running index, so the count
// of distinct placeholders must equal the count of parameters, in every combination.
for (const [label, q] of [
  ['live, no other filter', live],
  ['closed + stage + search', pipeline.buildPipelineQuery(VIEWER, 'a1b2', { book: 'closed', stage: 'underwriting', search: 'smith', mine: true }, { inactiveFolders: CLOSED })],
  ['scoped viewer, live', pipeline.buildPipelineQuery({ seesAll: false, scope: 'own' }, 'a1b2', { book: 'live' }, { inactiveFolders: CLOSED })],
]) {
  const used = new Set((q.sql.match(/\$\d+/g) || []).map((s) => Number(s.slice(1))));
  const max = used.size ? Math.max(...used) : 0;
  check(max === q.params.length && used.size === q.params.length,
    `${label}: ${q.params.length} parameter(s), placeholders $1..$${max}, none unreferenced`);
}

// ── The facet counts ────────────────────────────────────────────────────────
console.log('\nthe chip counts say what clicking would show');

const fOff = pipeline.buildFacetQueries(VIEWER, null, { book: 'closed' }, { inactiveFolders: [] });
check(fOff.bookSql === null,
  'no folder named → NO book count query at all; a "0 finished" chip would be a claim nobody measured');

const fOn = pipeline.buildFacetQueries(VIEWER, null, { book: 'closed' }, { inactiveFolders: CLOSED });
check(!!fOn.bookSql, 'a configured tenant gets one');
// The real property: the book filter is LIFTED for its own counts, so asking for the
// closed book still counts the live one. If it were applied, `live_n` would be 0.
const scopeFrag = fOn.bookSql.slice(fOn.bookSql.indexOf('FROM'));
// Asked of the module rather than retyped: a hand-copied fragment stops matching the
// day the expression changes, and an assertion that can no longer match is one that
// can no longer fail.
//
// And it tests for the CLOSED expression, not the live one. Testing only for the `NOT (`
// form is the trap: this facet is built with "Finished" selected, so a filter that was
// wrongly APPLIED would appear here WITHOUT the negation — the check would sail past the
// exact bug it is named after. Proven: applying the filter to its own facet leaves this
// assertion green and only the database suite red.
const closedFrag = bookMod.closedFolderSql('l', '$1').slice(0, 40);
check(!scopeFrag.includes(closedFrag),
  'THE ONE THAT MATTERS: the book filter is LIFTED from its own WHERE — with "Finished" selected, a "Live" chip '
  + 'counted under the closed filter would read zero and the way back would be the chip claiming there is nothing there');
check(closedFrag.length === 40 && live.sql.includes(closedFrag),
  '…and that fragment is the real one, so the check above could actually have failed');
check(/ = ANY\(\$\d+::text\[\]\)/.test(live.sql),
  'the loan\'s folder is tested for MEMBERSHIP of the finished list — an inverted operator would put every '
  + 'unlisted folder in the finished book, which is the whole thing this module exists to prevent');
check(/count\(\*\) FILTER \(WHERE NOT \(/.test(fOn.bookSql) && /count\(\*\) FILTER \(WHERE lower/.test(fOn.bookSql),
  '…and both books are counted in one pass over the same rows, so they cannot describe different populations');

// The stage counts must still narrow BY the book — a stage chip is a question about
// the book you are looking at, not about the whole table.
const fStage = pipeline.buildFacetQueries(VIEWER, null, { book: 'closed' }, { inactiveFolders: CLOSED });
check(/loan_folder/.test(fStage.stagesSql),
  'the STAGE counts still carry the book filter — a stage chip describes the book you are in, not the whole table');
check(/loan_folder/.test(fStage.scopeSql),
  '…and so do the scope counts');

// ── A filter the tenant makes meaningless ───────────────────────────────────
console.log('\na closed book nobody has defined is said out loud');

const stranded = bookMod.ignoredBookFilter('closed', []);
check(stranded && stranded.key === 'book',
  'THE ONE THAT MATTERS: asking for the closed book on a tenant with no finished folders is REPORTED — a SHARED '
  + 'saved view could otherwise hand a desk an empty pipeline with no control row to clear it with');
check(/administrator|Settings/i.test(stranded.why),
  '…and the words say who can fix it');
check(bookMod.ignoredBookFilter('closed', ['adverse']) === null,
  'a configured tenant is not nagged');
check(bookMod.ignoredBookFilter('all', []) === null && bookMod.ignoredBookFilter('live', []) === null,
  '"both" and "live" need no notice — with nothing configured they genuinely show the book that was asked for');

// ── The saved view ──────────────────────────────────────────────────────────
console.log('\na saved view may carry a book, and only a real one');

check(views.sanitizeFilters({ book: 'closed' }).filters.book === 'closed',
  'a view can be saved on the closed book');
check(views.sanitizeFilters({ book: 'live' }).filters.book === undefined,
  'THE ONE THAT MATTERS: the DEFAULT is not stored — a view saved today must not pin a desk to the live book '
  + 'if that default ever moves');
check(views.sanitizeFilters({ book: 'archive' }).dropped.includes('book'),
  'a name nobody declared is dropped and NAMED, not stored for a query that would ignore it');

// The declared filter set and what the query reads must not drift — a key a view can
// store that the pipeline does not honour is a view that quietly shows the wrong book.
const pipeSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/longterm/pipeline.js'), 'utf8');
check(/filters\.book/.test(pipeSrc),
  'and the query really reads it');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

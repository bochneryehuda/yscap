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
const WITHDRAWN = ['Withdrawn files'];
const EXCLUDED = ['Training'];
/** The tenant config in the shape the pipeline now takes it. */
const CFG = { closed: CLOSED, withdrawn: WITHDRAWN, excluded: EXCLUDED };

// ── Reading the setting ─────────────────────────────────────────────────────
console.log('what the tenant said is over');

check(bookMod.inactiveFolders({}).length === 0,
  'a tenant that has configured nothing has NO finished folders — the safe state, and the shipped default');

// Read here as well as in the database suite, deliberately. This is the one rule that
// would ship BROKEN to every tenant at once, and the suite that catches it must not be
// the one that skips itself when no database is in reach.
const declared = require('../src/longterm/settings/encompass-settings')
  .SETTINGS.find((s) => s.key === 'pipeline.inactiveFolders');
// CHANGED 2026-08-23, and the reason is the whole point. This used to assert the
// default was EMPTY, because which folder means "over" was a business rule nobody
// here could guess. The owner answered it (§11 q13), so it is no longer a guess and
// the default now carries the answer.
//
// WHAT THAT TEST WAS REALLY PROTECTING is asserted directly below instead, which is
// strictly stronger: a proxy ("the list is empty") is replaced by the property it
// stood for ("a tenant whose folders are not these sees every file live"). A named
// default is only safe BECAUSE an unmatched folder falls through to live, and that
// is now proven rather than arranged.
check(!!declared && Array.isArray(declared.default) && declared.default.length > 0,
  'the closed-folder list ships with the owner\'s 2026-08-23 answer, not a guess and not a blank');
{
  const foreign = pipeline.buildPipelineQuery(VIEWER, null, { book: 'live' },
    { books: { closed: declared.default, withdrawn: [], excluded: [] } });
  const foreignClosed = pipeline.buildPipelineQuery(VIEWER, null, { book: 'closed' },
    { books: { closed: declared.default, withdrawn: [], excluded: [] } });
  // The live clause is a NEGATION of a list this tenant has no folder in, so it is
  // true for every row: a buyer who installs this and whose folders are named
  // something else sees their whole book, exactly as before the default was filled.
  check(/NOT \(/.test(foreign.sql) && !/NOT \(/.test(foreignClosed.sql),
    'THE ONE THAT MATTERS: a shipped default can only ever SUBTRACT from the closed book — the live book is a '
    + 'negation, so a tenant whose folders are not these names keeps every file live, which is why naming '
    + 'them in the default is safe at all');
}
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
  const q = pipeline.buildPipelineQuery(VIEWER, null, { book: b }, { books: { closed: [], withdrawn: [], excluded: [] } });
  check(q.sql === base.sql && JSON.stringify(q.params) === JSON.stringify(base.params),
    `book=${b === undefined ? '(unset)' : b} produces the SAME statement and the SAME parameters as before the split existed`);
}
check(pipeline.buildPipelineQuery(VIEWER, null, { book: 'closed' }).sql === base.sql,
  'and a caller that passes no tenant config at all is unaffected too');
check(bookMod.bookSplitApplies([]) === false && bookMod.bookSplitApplies(undefined) === false,
  'so the screen is told there is no control to draw — three chips selecting identical rows is not a control');

// ── Configured: the split turns on ──────────────────────────────────────────
console.log('\nonce a folder is named, the books differ');

const live = pipeline.buildPipelineQuery(VIEWER, null, { book: 'live' }, { books: CFG });
const closed = pipeline.buildPipelineQuery(VIEWER, null, { book: 'closed' }, { books: CFG });
const withdrawn = pipeline.buildPipelineQuery(VIEWER, null, { book: 'withdrawn' }, { books: CFG });
const both = pipeline.buildPipelineQuery(VIEWER, null, { book: 'all' }, { books: CFG });

check(live.sql !== base.sql && closed.sql !== base.sql && withdrawn.sql !== base.sql,
  'the live, closed and withdrawn books each add a clause');
{
  // NOT compared as SQL TEXT, and that is the point: both books ask the same question
  // ("is the folder in this list") so the STATEMENT is identical by construction and
  // only the bound list differs. Comparing the strings would have passed for the wrong
  // reason on the day the two books were accidentally given the same list.
  const listOf = (q) => (q.params.find((x) => Array.isArray(x)) || []).join('|');
  check(listOf(closed) !== listOf(withdrawn),
    'THE ONE THAT MATTERS: closed and withdrawn are bound to DIFFERENT folder lists — a deal that completed '
    + 'and a deal that died are separate facts, and the owner ruled out mixing them (2026-08-23)');
  check(listOf(closed) === 'adverse|trash' && listOf(withdrawn) === 'withdrawn files',
    'and each is bound to its OWN list, not to the other\'s');
}
// CHANGED 2026-08-23. "All" used to be the whole table full stop. It is now the three
// BOOKS together — and a hidden folder is not a book, it is hidden, so "all" subtracts
// exactly the excluded list and nothing else. With no folder hidden the old property
// holds exactly as before, which is asserted first because it is the one that says the
// feature is still inert on an unconfigured tenant.
{
  const allNoHidden = pipeline.buildPipelineQuery(VIEWER, null, { book: 'all' },
    { books: { closed: CLOSED, withdrawn: WITHDRAWN, excluded: [] } });
  check(allNoHidden.sql === base.sql,
    'THE ONE THAT MATTERS: with nothing hidden, "all" adds NOTHING — it is the whole table, so it must be the '
    + 'same statement the unsplit pipeline ran, not a clause that happens to select everything');
  check(both.sql !== base.sql && (both.sql.match(/NOT \(/g) || []).length === 1,
    'and once a folder IS hidden, "all" subtracts exactly that one list and nothing else — a training file is '
    + 'not a deal in any state, so counting it into the total would inflate a number somebody reports');
}
// THE PARTITION, now four-way rather than two. Every loan is in exactly one of
// {live, closed, withdrawn, excluded} — asserted by construction here and against
// real rows in the database suite. `live` is the negation of ALL THREE named lists,
// which is what makes "in none of them" mean live rather than mean nothing.
check(/NOT \(/.test(live.sql) && !/NOT \(/.test(closed.sql) && !/NOT \(/.test(withdrawn.sql),
  'the live book is the NEGATION of every named list, so a loan in no list falls into live and never into '
  + 'nothing');
check((live.sql.match(/NOT \(/g) || []).length === 3,
  'THE ONE THAT MATTERS: live negates all THREE lists — closed, withdrawn AND excluded. Negating only the '
  + 'closed one is how a withdrawn file reappears in somebody\'s active pipeline');
{
  // Precedence, proven rather than documented: a folder an administrator has typed
  // into BOTH lists is withdrawn, because that is the more specific claim.
  const both2 = bookMod.bookFolders({
    'pipeline.inactiveFolders': ['Overlap'], 'pipeline.withdrawnFolders': ['Overlap'],
  });
  check(both2.withdrawn.includes('overlap') && !both2.closed.includes('overlap'),
    'THE ONE THAT MATTERS: a folder on both lists is WITHDRAWN and not closed, so a typo cannot make a file\'s '
    + 'book depend on which branch the SQL reaches first');
  // And the hidden list LOSES to both, because it is the only one that makes a file
  // vanish from every screen.
  const clash = bookMod.bookFolders({
    'pipeline.inactiveFolders': ['Gone'], 'pipeline.excludedFolders': ['Gone'],
  });
  check(clash.closed.includes('gone') && !clash.excluded.includes('gone'),
    'THE ONE THAT MATTERS: a folder that is both closed and hidden stays VISIBLE in the closed book — given '
    + 'contradictory configuration the safe reading is the one that still shows the file somewhere');
}
const folderParam = live.params.find((x) => Array.isArray(x));
check(!!folderParam,
  'the folder list travels as a bound PARAMETER — a tenant\'s typed folder name never reaches the query text');
check(folderParam && folderParam.join('|') === 'adverse|trash',
  'THE ONE THAT MATTERS: the list is NORMALIZED where the clause is built, not trusted from the caller — the SQL '
  + 'lower-cases only its own side, so a raw "Adverse" would match nothing and the closed book would read empty '
  + 'while the live book quietly became the whole table');
check(pipeline.buildFacetQueries(VIEWER, null, { book: 'live' },
  { books: { closed: ['  ADVERSE  '], withdrawn: [], excluded: [] } })
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
  ['closed + stage + search', pipeline.buildPipelineQuery(VIEWER, 'a1b2', { book: 'closed', stage: 'underwriting', search: 'smith', mine: true }, { books: CFG })],
  ['scoped viewer, live', pipeline.buildPipelineQuery({ seesAll: false, scope: 'own' }, 'a1b2', { book: 'live' }, { books: CFG })],
]) {
  const used = new Set((q.sql.match(/\$\d+/g) || []).map((s) => Number(s.slice(1))));
  const max = used.size ? Math.max(...used) : 0;
  check(max === q.params.length && used.size === q.params.length,
    `${label}: ${q.params.length} parameter(s), placeholders $1..$${max}, none unreferenced`);
}

// ── The facet counts ────────────────────────────────────────────────────────
console.log('\nthe chip counts say what clicking would show');

const fOff = pipeline.buildFacetQueries(VIEWER, null, { book: 'closed' }, { books: { closed: [], withdrawn: [], excluded: [] } });
check(fOff.bookSql === null,
  'no folder named → NO book count query at all; a "0 finished" chip would be a claim nobody measured');

const fOn = pipeline.buildFacetQueries(VIEWER, null, { book: 'closed' }, { books: CFG });
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
const closedFrag = bookMod.folderInSql('l', '$1').slice(0, 40);
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
const fStage = pipeline.buildFacetQueries(VIEWER, null, { book: 'closed' }, { books: CFG });
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

'use strict';
/**
 * LT test — saved pipeline views, the pure half.
 *
 * A saved view is a named set of FILTERS. The property worth a suite is what it is
 * NOT: it carries no scope, so it can only ever narrow. That is proven in the DB
 * suite against a real query; here what is pinned is the sanitiser, because every
 * filter in a stored view was once a request body and is read back as though it were
 * one.
 */

const views = require('../src/longterm/views');
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

console.log('a view carries only filters this build honours');

const { filters, dropped } = views.sanitizeFilters({
  stage: 'underwriting', folder: 'Pipeline', search: '  Weiss ',
  unassigned: 'true', sort: 'lock_expiration', dir: 'ASC',
  officerStaffId: '3f1c1b2e-1111-4222-8333-444455556666',
  // Everything below is not a filter this build knows.
  scope: 'all', staffId: 'someone-else', seesAll: true, limit: 9999,
});
check(filters.stage === 'underwriting' && filters.folder === 'Pipeline', 'the declared filters survive');
check(filters.search === 'Weiss', 'a search phrase is trimmed');
check(filters.unassigned === true && filters.dir === 'asc', 'a boolean and a direction are normalised');
check(filters.officerStaffId === '3f1c1b2e-1111-4222-8333-444455556666', 'an officer id is kept only in the shape of an id');
check(!('scope' in filters) && !('staffId' in filters) && !('seesAll' in filters) && !('limit' in filters),
  'THE ONE THAT MATTERS: a key that is not a declared FILTER is dropped — a view may not carry a scope, a person, or a page size');
check(dropped.includes('scope') && dropped.includes('seesAll'),
  '…and the dropped keys are NAMED, because a view silently missing half its filters shows a different book from the one on its label');

check(views.sanitizeFilters({ officerStaffId: "' OR 1=1 --" }).filters.officerStaffId === undefined,
  'an officer id that is not a uuid is refused rather than stored');
check(views.sanitizeFilters({ search: 'x'.repeat(500) }).filters.search === undefined,
  'a 500-character "search" is a mistake or an attempt, and is not stored either way');
check(views.sanitizeFilters(null).filters && Object.keys(views.sanitizeFilters(null).filters).length === 0,
  'a missing filter object is an empty one, never a throw');
check(Object.keys(views.sanitizeFilters(['stage']).filters).length === 0,
  'and an array is not an object of filters');

console.log('\nthe filter list matches the query that honours it');

// A key here the pipeline does not read is a promise the screen cannot keep, so the
// two lists are compared rather than trusted to stay in step by memory.
const pipelineSrc = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/pipeline.js'), 'utf8');
const unread = Object.keys(views.FILTER_KEYS).filter((k) => !new RegExp(`filters\\.${k}\\b`).test(pipelineSrc));
check(unread.length === 0,
  `every filter a view may save is one the pipeline query actually reads${unread.length ? ` — ${unread.join(', ')} is not` : ''}`);

console.log('\na name a person will recognise');

check(views.sanitizeName('  My   book  ') === 'My book', 'a name is trimmed and its spacing collapsed');
check(views.sanitizeName('') === null && views.sanitizeName(null) === null && views.sanitizeName('   ') === null,
  'a blank name is refused rather than saved as an unclickable row');
check(views.sanitizeName('x'.repeat(200)).length === 80, 'a very long name is cut to something a list can show');

console.log('\nit holds no scope of its own');

// Comments are stripped first: this module's header EXPLAINS that it holds no scope,
// so a guard that read comments would fail on the very sentence that documents the
// rule — and would then be "fixed" by deleting the explanation.
const src = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/views.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
check(!/pipelineScopeSql|seesAll|SCOPE_ALL/.test(src),
  'the module never mentions scope: who may see a loan is decided in the pipeline query from the signed-in person, every time');
const writes = [...src.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?!SET\b)([a-zA-Z_][\w.]*)/gi)].map((m) => m[1]);
check(writes.length > 0 && writes.every((t) => /^lt_/.test(t)),
  `and every table it writes is an lt_ one (${[...new Set(writes)].join(', ')})`);

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

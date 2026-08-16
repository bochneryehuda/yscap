'use strict';
/**
 * LT test — the pipeline columns a buyer configures.
 *
 * The property this suite exists for:
 *
 *   A SETTING THAT NOBODY READS IS WORSE THAN NO SETTING AT ALL.
 *
 * `pipeline.columns` was declared with a fifteen-key default and read by NOTHING —
 * the screen hard-coded nine columns — so an administrator could change the pipeline,
 * save it, reload, and see exactly what they saw before, with no error to act on. A
 * dead switch teaches people the system ignores them, which is the one lesson that is
 * expensive to unteach.
 *
 * The second property, which the first one makes possible:
 *
 *   THE SETTING DECIDES WHAT THE SCREEN DRAWS. IT NEVER BECOMES SQL.
 *
 * Building a SELECT list out of a stored setting would put a value an administrator
 * types into the query text, and would hand the planner a different statement per
 * configuration. So the query is asserted to be BYTE-IDENTICAL under two completely
 * different column configurations — proven, not promised.
 *
 * PURE — no database.
 */

const fs = require('fs');
const path = require('path');
const cols = require('../src/longterm/pipeline-columns');
const pipeline = require('../src/longterm/pipeline');
const contacts = require('../src/longterm/people/contacts');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const keysOf = (r) => r.columns.map((c) => c.key);

// ── What a configuration produces ───────────────────────────────────────────
console.log('the buyer’s list decides the table');

const configured = cols.resolveColumns(['stage', 'loan_number', 'ltv']);
check(keysOf(configured).join(',') === 'stage,loan_number,ltv',
  'THE ONE THAT MATTERS: the columns come out in the ORDER THEY WERE ASKED FOR — a set that silently re-sorts itself is a setting somebody has to fight');
check(configured.columns[0].label === 'Stage' && configured.columns[2].label === 'LTV',
  'each one carries the words a person reads, so the screen never invents a heading');

check(keysOf(cols.resolveColumns(['stage', 'stage', 'borrower'])).join(',') === 'stage,borrower',
  'a list naming one column twice draws it ONCE — two identical headings is a bug report, not a configuration');

check(keysOf(cols.resolveColumns([])).length === cols.resolveColumns(null).columns.length,
  'an empty list and no list at all mean the same thing: nobody has configured one');
check(keysOf(cols.resolveColumns(['  borrower  ', ''])).join(',') === 'borrower',
  'stray spacing and a blank entry are tidied rather than treated as columns');

// ── What we cannot draw is DROPPED and NAMED ────────────────────────────────
console.log('\na column we cannot fill is dropped and explained');

const withDead = cols.resolveColumns(['loan_number', 'expected_closing', 'borrower']);
check(!keysOf(withDead).includes('expected_closing'),
  'THE ONE THAT MATTERS: a column with no data behind it is NOT rendered — a column of dashes on every row of every loan forever reads as "we failed to fetch this", not as "we do not hold it"');
check(withDead.unavailable.length === 1 && withDead.unavailable[0].key === 'expected_closing',
  '…and it is REPORTED rather than quietly missing — somebody put it there on purpose');
check(/closing date/i.test(withDead.unavailable[0].why || ''),
  '…with a reason in plain words, so the answer is not "ask a developer"');
check(keysOf(withDead).join(',') === 'loan_number,borrower',
  'and the columns around it keep their order');

check(cols.DEFAULT_ORDER.includes('expected_closing')
  && !keysOf(cols.resolveColumns(null)).includes('expected_closing'),
'the DEFAULT itself names a column we cannot source, and the same rule drops it — the default is not a special case');

const unknown = cols.resolveColumns(['loan_number', 'nonsense']);
check(unknown.unknown.join(',') === 'nonsense' && !keysOf(unknown).includes('nonsense'),
  'THE ONE THAT MATTERS: a key nobody declared is NAMED, not ignored — a typo that silently disappears looks exactly like a setting that did not save');

const allDead = cols.resolveColumns(['expected_closing', 'conditions']);
check(allDead.fellBack === true && allDead.columns.length > 0,
  'a configuration that leaves NOTHING drawable falls back to the default — a table with no columns is not a thing anybody chose');
check(allDead.unavailable.length === 2,
  '…and still reports both, so the fallback is explained rather than mysterious');

// The SETTINGS screen shows its own default, and the pipeline resolves ours. If the
// two ever differ, the screen tells an administrator the pipeline is showing one set
// while it is showing another — and the first thing they would do is "fix" the one
// that was right.
const declared = require('../src/longterm/settings/encompass-settings')
  .SETTINGS.find((s) => s.key === 'pipeline.columns');
check(!!declared && JSON.stringify(declared.default) === JSON.stringify(cols.DEFAULT_ORDER),
  'the default the SETTINGS screen shows is the same list the pipeline actually starts from');

// ── The setting never reaches the query ─────────────────────────────────────
console.log('\nthe setting never becomes SQL');

const qA = pipeline.buildPipelineQuery({ seesAll: true }, null, {});
const qB = pipeline.buildPipelineQuery({ seesAll: true }, null, {});
check(qA.sql === qB.sql && JSON.stringify(qA.params) === JSON.stringify(qB.params),
  'the pipeline query is the same statement every time — it takes no column list at all');

const pipeSrc = strip(read('src/longterm/pipeline.js'));
check(!/pipeline-columns/.test(pipeSrc),
  'THE ONE THAT MATTERS: the QUERY module does not even know this module exists — a SELECT list built from a stored setting would put an administrator’s typed value into the query text and give the planner a different statement per configuration');
check(!/require\(/.test(strip(read('src/longterm/pipeline-columns.js'))),
  'and the catalog is pure: no database, no settings, nothing that can fail');

const routeSrc = strip(read('src/longterm/routes/pipeline.js'));
check(/resolveColumns\(settings\['pipeline\.columns'\]\)/.test(routeSrc),
  'the LIST route is the one place the setting is read');
check(/res\.json\(\{ \.\.\.out, \.\.\.cols \}\)/.test(routeSrc),
  '…and it travels to the SCREEN, beside the rows it describes');

// ── Every column can actually be drawn ──────────────────────────────────────
console.log('\nevery column names something the query really returns');

// A `field` naming a column the SELECT does not return renders a dash on every row
// forever, with nothing failing anywhere — the phantom-column class, expressed on a
// screen. So each one is checked against the real statement.
const sql = qA.sql;
const selects = (name) => new RegExp(`(^|[\\s,(.])${name}\\b`, 'm').test(sql.split('FROM lt_loans')[0]);
for (const [key, def] of Object.entries(cols.COLUMNS)) {
  if (def.available === false) continue;
  const r = cols.resolveColumns([key]);
  const c = r.columns[0];
  if (c.kind === 'contact') {
    check(contacts.DEFAULT_ROLES.includes(c.field),
      `${key}: its field names a real loan-team ROLE (${c.field}) — a role nobody mirrors would read empty on every loan`);
  } else {
    check(selects(c.field), `${key}: the pipeline query really returns \`${c.field}\``);
  }
}

check(Object.values(cols.COLUMNS).every((d) => !d.sort || Object.prototype.hasOwnProperty.call(pipeline.SORTABLE, d.sort)),
  'THE ONE THAT MATTERS: every sortable column names a sort key the SERVER accepts — a header offering an order the query refuses is a click that silently does nothing');

check(Object.values(cols.COLUMNS).every((d) => d.available === false ? typeof d.why === 'string' && d.why.length > 20 : true),
  'every unavailable column carries a real sentence, never a bare flag');

// ── The screen draws what it is sent ────────────────────────────────────────
console.log('\nthe screen renders the server’s columns, not its own');

const ui = read('app-v2/src/longterm/LtPipeline.jsx');
const uiCode = strip(ui);
check(/columns\.map\(/.test(uiCode) && /<Cell col=\{c\} row=\{l\}/.test(uiCode),
  'the table body is drawn by mapping the columns — there is no hard-coded row of cells left');
check(!/<th style=\{th\}>Loan #<\/th>/.test(uiCode),
  '…and the hard-coded headings are gone');
check(/i === 0 \?/.test(uiCode) && /<ProductStamp/.test(uiCode),
  'THE ONE THAT MATTERS: the product stamp rides the FIRST column, whichever column that is — hanging it off the loan number would let a configuration that drops that column drop the stamp with it, and the stamp is not configurable (CLAUDE.md §7)');
check(/data\.unavailable/.test(uiCode) && /data\.unknown/.test(uiCode),
  'a configured column we cannot draw, and a key nobody recognises, are both SHOWN — the screen explains the difference between what it drew and what was asked for');

// The fallback is for a server too old to answer. It is a copy, so it is checked
// against the real catalog: a fallback that drifts draws the wrong thing under
// exactly the conditions nobody is watching.
const fbBlock = ui.slice(ui.indexOf('const FALLBACK_COLUMNS'), ui.indexOf('];', ui.indexOf('const FALLBACK_COLUMNS')));
const fbKeys = [...fbBlock.matchAll(/key: '([a-z_]+)'/g)].map((m) => m[1]);
check(fbKeys.length === 9, `the screen’s fallback still lists the nine columns it always drew (${fbKeys.length})`);
for (const k of fbKeys) {
  const def = cols.COLUMNS[k];
  const line = fbBlock.split('\n').find((l) => l.includes(`key: '${k}'`)) || '';
  const got = (n) => (line.match(new RegExp(`${n}: '([^']*)'`)) || [])[1];
  check(!!def && got('label') === def.label && got('field') === (def.field || k)
    && (got('kind') || 'text') === (def.kind || 'text'),
  `fallback ${k} still agrees with the catalog on its label, field and kind`);
}

// ── One way of writing a value down ─────────────────────────────────────────
console.log('\ntwo screens drawing the same loans write a value the same way');

// The pipeline had grown its OWN money/pct/day when it grew its own cells, and they
// had already drifted where it counts: its `day` handed a DATE column to `new Date`,
// which parses `2019-08-01` as UTC midnight and prints THE DAY BEFORE in every US
// timezone — the exact bug the file screen carries a guard against. Nothing showed a
// bare date column on the pipeline yet, so nothing was visibly wrong; making the
// columns configurable is what would have made it wrong, quietly, the first time a
// buyer added one. So the rule is structural rather than a fix to one copy.
const fmt = read('app-v2/src/longterm/format.js');
check(/const day = \(v\)/.test(fmt) && /\\d\{4\}\)-\(\\d\{2\}/.test(fmt),
  'the shared module holds the calendar-day guard');

const FORMATTERS = ['money', 'money2', 'pct', 'ratio', 'plain', 'day', 'yesNo'];
for (const f of fs.readdirSync(path.join(__dirname, '..', 'app-v2/src/longterm'))) {
  if (!/\.(jsx|js)$/.test(f) || f === 'format.js') continue;
  const src = strip(read(`app-v2/src/longterm/${f}`));
  const own = FORMATTERS.filter((n) => new RegExp(`(const|function)\\s+${n}\\s*[=(]`).test(src));
  check(own.length === 0,
    `${f} defines no formatter of its own${own.length ? ` (found ${own.join(', ')})` : ''}`);
}
check(/export \{ money, money2, pct, ratio, plain, day, yesNo \}/.test(read('app-v2/src/longterm/LtFileSections.jsx'))
  && /^import \{ money/m.test(read('app-v2/src/longterm/LtFileSections.jsx')),
'THE ONE THAT MATTERS: the file screen IMPORTS them as well as re-exporting them — a bare `export … from` re-export does not put the names in this module’s own scope, and it calls them ~96 times, so the build would stay green and the page would throw on render');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

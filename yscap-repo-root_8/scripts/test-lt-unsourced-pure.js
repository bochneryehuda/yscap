'use strict';
/**
 * LT test — EVERY COLUMN OF THE 1003 MIRROR IS EITHER FILLED OR EXPLAINED.
 *
 * The failure this exists to stop has now happened five times on this side, and
 * every one of them was found by somebody going looking rather than by anything
 * failing: a table three screens read and nothing wrote, twenty-seven loan columns
 * with no writer, an eFolder mirror with no reader, the owner's census reading a
 * dead column. The shape is always the same and it is silent — the screen shows a
 * dash, the dash reads as an ANSWER ("not in a flood zone", "no rent"), and no
 * test anywhere is unhappy.
 *
 * So: a column of the 1003 mirror must be WRITTEN by the mapper, or LISTED in
 * `application/unsourced.js` with a measured reason and something that would
 * unblock it. Neither one, and this build goes red — which is the only way a blank
 * on a screen can be made to mean something somebody decided.
 *
 * It reads the schema, the mapper and the sync as TEXT, so it needs no database
 * and cannot be satisfied by a stub.
 */

const fs = require('fs');
const path = require('path');

const unsourced = require('../src/longterm/application/unsourced');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/**
 * The tables this rule covers: the 1003 mirror, which is what
 * `application/mapper.js` + `application/sync.js` own end to end.
 *
 * `lt_loans` is deliberately NOT here — it is filled by three different syncs and
 * carries PILOT's own bookkeeping columns beside Encompass's facts, so "every
 * column or a reason" is the wrong shape for it. The 1003 tables are pure mirror:
 * every column in them is a thing Encompass either says or does not.
 */
const MIRROR_TABLES = [
  'lt_borrower_pairs', 'lt_parties', 'lt_properties', 'lt_residences',
  'lt_employments', 'lt_other_incomes', 'lt_assets', 'lt_liabilities',
  'lt_reo_properties', 'lt_declarations',
];

/** Columns every table has because it is a table, not because Encompass said so. */
const STRUCTURAL = new Set([
  'id', 'created_at', 'updated_at', 'party_id', 'pair_id', 'loan_id',
  'encompass_id', 'borrower_id',
]);

/** `{ table -> [column] }` off the hand-written schema — the same file the drift
 *  check compares against the real database, so this cannot describe a table that
 *  does not exist. */
function columnsByTable(prisma) {
  const out = {};
  const re = /^model (\w+) \{([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(prisma))) {
    const body = m[2];
    const table = (body.match(/@@map\("([^"]+)"\)/) || [])[1] || m[1];
    const cols = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
      const f = t.match(/^(\w+)\s+(\w+)/);
      if (!f) continue;
      // A relation field is not a column. Enums ARE, and they are spelled like
      // relations, so they are told apart by the schema's own enum list.
      const [, field, type] = f;
      const scalar = ['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Decimal', 'Json', 'BigInt', 'Bytes'];
      const isEnum = new RegExp(`^enum ${type} \\{`, 'm').test(prisma);
      if (!scalar.includes(type) && !isEnum) continue;
      const mapped = (t.match(/@map\("([^"]+)"\)/) || [])[1];
      cols.push(mapped || field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
    }
    out[table] = cols;
  }
  return out;
}

const prisma = read('src/longterm/prisma/schema.prisma');
const tables = columnsByTable(prisma);
const writerSrc = read('src/longterm/application/mapper.js') + read('src/longterm/application/sync.js');

console.log('every column of the 1003 mirror is filled, or says why not');

// The parser has to actually work, or this whole test passes by finding nothing.
check(MIRROR_TABLES.every((t) => Array.isArray(tables[t]) && tables[t].length > 3),
  'the schema parser found all ten mirror tables with their columns — a parser that quietly found nothing would make every check below pass');
check((tables.lt_properties || []).includes('gross_monthly_rent')
  && (tables.lt_liabilities || []).includes('reo_property_id'),
  '…including the columns this change is about, so the list is the real one');

const unexplained = [];
const explained = [];
for (const table of MIRROR_TABLES) {
  for (const col of tables[table] || []) {
    if (STRUCTURAL.has(col)) continue;
    // A column is FILLED if the writer names it. Both halves are read: the mapper
    // names Encompass's paths and the sync names our columns.
    if (new RegExp(`\\b${col}\\b`).test(writerSrc)) continue;
    const entry = unsourced.unsourced(table, col);
    if (entry) explained.push(`${table}.${col}`);
    else unexplained.push(`${table}.${col}`);
  }
}

check(unexplained.length === 0,
  `THE ONE THAT MATTERS: no column of the 1003 mirror is silently empty${unexplained.length ? ` — unwritten and unexplained: ${unexplained.join(', ')}` : ''}`);
check(explained.length > 0,
  `…and the ones that cannot be filled are named rather than assumed (${explained.length}: ${explained.join(', ')})`);

// A stale entry is its own lie: it says a column is knowingly empty when the
// column has been filled since, or does not exist at all.
console.log('\nthe list describes the schema we actually have');

const stale = [];
const filledAnyway = [];
for (const key of Object.keys(unsourced.UNSOURCED)) {
  const [table, col] = key.split('.');
  if (!tables[table] || !tables[table].includes(col)) { stale.push(key); continue; }
  if (new RegExp(`\\b${col}\\b`).test(writerSrc)) filledAnyway.push(key);
}
check(stale.length === 0,
  `every entry names a column that exists${stale.length ? ` — these do not: ${stale.join(', ')}` : ''}`);
check(filledAnyway.length === 0,
  `…and none of them is actually being written${filledAnyway.length ? ` — these are: ${filledAnyway.join(', ')}` : ''}`);

// ── The ARM terms, which the file screen draws the moment a loan is adjustable ──
//
// `lt_loans` is outside the every-column rule above for the reason given at the top
// of this file, but these eight are held to it anyway: the screen renders a row per
// ARM term as soon as `lt_amortization_type` is 'adjustable', so an unwritten and
// unlisted one is eight dashes under "Adjustable-rate terms" — a reader's answer to
// "what are the caps on this loan", given by nobody. Their writer is the loan sync,
// not the 1003 mapper, so it is read here rather than folded into `writerSrc` (a
// column name that appears in both would otherwise read as filled in the wrong one).
console.log('\nthe adjustable-rate terms are filled or explained');

const loanWriterSrc = read('src/longterm/sync/loans.js');
const armCols = (tables.lt_loans || []).filter((c) => /^arm_/.test(c));
check(armCols.length >= 8,
  `the schema really carries the ARM columns (${armCols.length}) — a parser that found none would make the next check pass by finding nothing`);

const armGap = armCols.filter((c) => !new RegExp(`\\b${c}\\b`).test(loanWriterSrc) && !unsourced.unsourced('lt_loans', c));
check(armGap.length === 0,
  `no ARM term is silently empty${armGap.length ? ` — unwritten and unexplained: ${armGap.join(', ')}` : ''}`);

console.log('\nevery reason is a reason, not a shrug');

for (const [key, entry] of Object.entries(unsourced.UNSOURCED)) {
  if (!entry.show || entry.show.length < 20) { failures += 1; console.error(`  FAIL ${key}: nothing for a screen to say`); }
  if (!entry.why || entry.why.length < 80) { failures += 1; console.error(`  FAIL ${key}: no measured reason`); }
  if (!entry.unblock || entry.unblock.length < 20) { failures += 1; console.error(`  FAIL ${key}: nothing that would unblock it`); }
  if (!Object.values(unsourced.KINDS).includes(entry.kind)) { failures += 1; console.error(`  FAIL ${key}: unknown kind ${entry.kind}`); }
}
check(true,
  'each entry says what a SCREEN shows, what was MEASURED, what would unblock it, and which of the three kinds it is — "Encompass does not have it", "the owner has not decided" and "it is ours to judge" are different sentences, and the difference is what the next person needs');

// The reasons cite the census rather than an opinion.
const src = read('src/longterm/application/unsourced.js');
check(/field-dictionary\.json/.test(src) && /772 live loans|3,783/.test(src),
  'and the reasons are anchored to the 3,783-field census of 772 live loans, so "Encompass does not have it" is a measurement rather than a memory');

// ── The screen has to SAY it ───────────────────────────────────────────────
console.log('\nand a screen never shows a knowingly-empty field as a dash');

const fileSrc = read('src/longterm/file.js');
check(/unsourced/.test(fileSrc) && /notSourcedFor/.test(fileSrc),
  'the file screen\'s data is built with the list attached — a dash beside "In a flood zone" reads as "no", which is an answer nobody gave');

const ui = read('app-v2/src/longterm/LtFileSections.jsx');
check(/\{notSourced && blank \?/.test(ui),
  '…and the screen DRAWS that reason in place of the value, so the reader learns "PILOT never reads this" instead of inferring "there is nothing there"');
check(/const blank = value == null \|\| value === '' \|\| value === '—';/.test(ui),
  '…only where the value is actually empty, so the sentence gives way the moment a real figure arrives');
for (const field of ['in_flood_zone', 'flood_zone', 'actual_monthly_rent']) {
  check(new RegExp(`ns\\.${field}\\b`).test(ui),
    `…and "${field.replace(/_/g, ' ')}" is one of the fields that carries its reason to the screen`);
}

// The ARM block is the case where the reason has to be said ONCE rather than
// per row: eight identical sentences is as unreadable as eight dashes, and the
// dashes are worse than unreadable because each one is an answer.
check(/notSourcedFor\('lt_loans'\)/.test(fileSrc) && /notHeld:/.test(fileSrc),
  'the ARM block carries both the reason and whether we hold ANY of the eight terms, so the screen can say it once');
check(/function ArmTerms/.test(ui) && /arm\.notHeld/.test(ui),
  '…and the screen says it once when we hold none — eight dashes under "Adjustable-rate terms" would each read as a term this loan does not have');
for (const field of ['arm_index_name', 'arm_margin_pct', 'arm_lifetime_cap_pct']) {
  check(new RegExp(`ns\\.${field}\\b`).test(ui),
    `…and "${field.replace(/_/g, ' ')}" still carries its own reason on its own row, so the block gives way term by term the day a writer lands`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

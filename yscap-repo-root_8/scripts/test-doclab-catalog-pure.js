#!/usr/bin/env node
'use strict';
/**
 * DOCLAB CATALOG + SCOPE GATE — pure. No database, no network.
 *
 * The important half of this file is section A: it re-reads the committed reference
 * CSVs and re-derives what `src/doclab/catalog.js` claims, so the code and the
 * documents PLL gave us can never drift apart. When PLL ships a new dictionary you
 * replace the CSV, run this, and it tells you exactly what moved — which is the
 * whole reason the reference data is committed rather than summarised.
 *
 * Everything else guards a decision that would be expensive to get wrong on a
 * recorded document: the RTL scope gate, the status vocabulary, and the rule that
 * a note buyer's name can never reach a loan document.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const catalog = require('../src/doclab/catalog');
const scope = require('../src/doclab/scope');
const fieldMap = require('../src/doclab/field-map');

const REF = path.join(__dirname, '..', 'docs', 'doclab', 'reference');
let pass = 0;
function ok(what) { pass++; console.log('  ✓', what); }

/** A CSV reader that handles quoted fields — the descriptions contain commas. */
function readCsv(file) {
  const text = fs.readFileSync(path.join(REF, file), 'utf8');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

console.log('\nA. the catalog still matches the reference data PLL gave us');
{
  const rows = readCsv('json-key-matrix.csv');
  const hdr = rows[0];
  const byHeader = {};
  for (const t of catalog.RTL_TEMPLATES) {
    const i = hdr.indexOf(t.header);
    assert.notStrictEqual(i, -1, `the matrix has no column named "${t.header}" — RTL_TEMPLATES is out of step with the CSV`);
    byHeader[t.code] = i;
  }
  ok(`all ${catalog.RTL_TEMPLATES.length} RTL template columns exist in json-key-matrix.csv`);

  // Re-derive the matrix straight from the CSV and diff it against the catalog.
  const derived = {};
  for (const r of rows.slice(1)) {
    const key = (r[0] || '').trim();
    if (!key) continue;
    const cols = catalog.RTL_TEMPLATES
      .filter((t) => (r[byHeader[t.code]] || '').trim() === '✓')
      .map((t) => t.code);
    // A key appearing twice (the CSV repeats late_charge_percentage) is a union.
    derived[key] = derived[key] ? Array.from(new Set(derived[key].concat(cols))) : cols;
  }
  const derivedRtl = Object.keys(derived).filter((k) => derived[k].length).sort();
  const catalogRtl = Object.keys(catalog.MATRIX).sort();
  assert.deepStrictEqual(catalogRtl, derivedRtl,
    'catalog.MATRIX does not match json-key-matrix.csv — replace one or the other, never edit only one side');
  for (const k of catalogRtl) {
    const a = Array.from(catalog.MATRIX[k]).sort();
    const b = Array.from(derived[k]).sort();
    assert.deepStrictEqual(a, b, `the template columns for "${k}" differ between the catalog and the CSV`);
  }
  ok(`all ${catalogRtl.length} RTL matrix rows match the CSV exactly`);

  const derivedDscrOnly = Object.keys(derived).filter((k) => !derived[k].length).sort();
  assert.deepStrictEqual(Array.from(catalog.DSCR_ONLY_KEYS).sort(), derivedDscrOnly,
    'DSCR_ONLY_KEYS does not match the CSV');
  ok(`${derivedDscrOnly.length} DSCR-only keys match the CSV`);

  const dd = readCsv('data-dictionary-full.csv');
  const ddKeys = new Set(dd.slice(1).map((r) => (r[0] || '').trim()).filter(Boolean));
  const missing = Object.keys(catalog.VARIABLES).filter((k) => !ddKeys.has(k));
  assert.deepStrictEqual(missing, [], `catalog.VARIABLES has keys the dictionary CSV does not: ${missing.join(', ')}`);
  ok(`all ${Object.keys(catalog.VARIABLES).length} dictionary entries come from data-dictionary-full.csv`);

  const names = readCsv('loan-product-names.csv').slice(1).map((r) => (r[0] || '').trim()).filter(Boolean);
  for (const n of names) {
    assert.ok(catalog.categoryOf(n), `loan category "${n}" is in the reference CSV but not in LOAN_CATEGORIES`);
  }
  ok(`all ${names.length} published loan products are classified in LOAN_CATEGORIES`);
}

console.log('\nB. the status vocabulary');
{
  assert.strictEqual(catalog.statusOf('Completed'), 'completed');
  assert.strictEqual(catalog.statusOf('completed'), 'completed');
  assert.strictEqual(catalog.statusOf(80), 'completed');
  assert.strictEqual(catalog.statusOf('80'), 'completed');
  assert.strictEqual(catalog.statusOf('MoreInfo'), 'moreInfo');
  assert.strictEqual(catalog.statusOf(''), null);
  assert.strictEqual(catalog.statusOf('nonsense'), null);
  ok('a status is recognised by name, by label casing and by code');

  // `error` is recoverable by re-submitting, so a poller must keep watching it. If
  // this ever flips to terminal, a stuck request stops being noticed.
  assert.strictEqual(catalog.isTerminal('error'), false, 'error must NOT be terminal — it is recoverable');
  assert.strictEqual(catalog.isTerminal('approved'), false, 'approved is mid-flight, not finished');
  assert.strictEqual(catalog.isTerminal('wordGenerated'), false, 'the PDF does not exist yet at wordGenerated');
  assert.strictEqual(catalog.isTerminal('completed'), true);
  assert.strictEqual(catalog.isTerminal('rejected'), true);
  assert.strictEqual(catalog.isTerminal('nonsense'), false, 'an unknown status must keep being watched');
  ok('only completed and rejected are terminal; an unknown status keeps being watched');

  assert.strictEqual(catalog.isComplete('approved'), false,
    'approved must never read as complete — the documents do not exist yet');
  ok('approved is not mistaken for complete');
}

console.log('\nC. the RTL scope gate');
{
  for (const c of ['12 Month', '12 Month with Holdback', 'NY Building Loan', 'Commercial',
    'Commercial with Holdback', 'CEMA RTL', 'Ground Up Construction']) {
    assert.strictEqual(scope.isDscrCategory(c), false, `${c} must be in scope`);
    assert.doesNotThrow(() => scope.assertInScope({ loanCategory: c, prepaymentOptionCode: 'RTL-No' }));
  }
  ok('every RTL category passes');

  for (const c of ['DSCR SFR', 'DSCR Portfolio', 'CEMA DSCR', 'Commercial DSCR SFR',
    'DSCR - 30 Year Single Family Rental', 'DSCR SFR 1 to 4']) {
    assert.strictEqual(scope.isDscrCategory(c), true, `${c} must be refused`);
    assert.throws(() => scope.assertInScope({ loanCategory: c }), /out of|outside the RTL build/i);
  }
  ok('every DSCR category is refused, by published name and by alternate name');

  // The point of the token test: a category PLL adds tomorrow. Their names are
  // mid-rename, so an unrecognised DSCR name is the expected case.
  assert.strictEqual(scope.isDscrCategory('DSCR Something We Have Never Seen'), true);
  assert.throws(() => scope.assertInScope({ loanCategory: 'DSCR 40 Year Rental' }));
  ok('an unrecognised category containing DSCR is still refused');

  // ...but the token test must not be a substring test.
  assert.strictEqual(scope.isDscrCategory('Bridge'), false);
  assert.strictEqual(scope.isDscrCategory('DSCRAMBLER Loan'), false,
    'DSCR must be matched as a word, not as a substring');
  ok('a word merely containing those letters is not refused');

  assert.throws(() => scope.assertInScope({ loanCategory: '12 Month', prepaymentOptionCode: 'DSCR-3/2/1' }),
    /prepayment/i);
  assert.throws(() => scope.assertInScope({ loanCategory: '12 Month', prepaymentOptionCode: 'DSCR-5' }));
  assert.strictEqual(scope.isDscrPrepaymentCode('DSCR-99/99'), true, 'a rung PLL adds later is still DSCR');
  ok('a DSCR prepayment code is refused even on an RTL category');

  assert.throws(() => scope.assertInScope({ loanCategory: '12 Month', prepaymentOptionCode: 'PPPTest' }),
    /test/i);
  ok("DocLab's own test prepayment value can never reach a document");

  // Fails closed: with nothing to judge we may not say "in scope".
  assert.throws(() => scope.assertInScope({ loanCategory: '' }), /cannot tell|no loan category/i);
  assert.throws(() => scope.assertInScope({}));
  ok('a blank loan category is refused rather than assumed to be fine');

  // An unknown NON-DSCR category is a warning, not a refusal — PLL may well have
  // added it, and refusing would make every new product a code change.
  const r = scope.check({ loanCategory: 'Some New RTL Product', prepaymentOptionCode: 'RTL-No' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.problems.some((p) => p.code === 'category_unknown' && p.warning));
  ok('an unknown non-DSCR category warns but does not block');
}

console.log('\nD. the prepayment answer for an RTL file');
{
  let a = scope.rtlPrepaymentCode(null);
  assert.strictEqual(a.code, 'RTL-No');
  assert.strictEqual(a.confirmed, false, 'with no state list we have not confirmed anything');

  a = scope.rtlPrepaymentCode([{ optionCode: 'RTL-No' }, { optionCode: 'RTL-Yes' }]);
  assert.strictEqual(a.code, 'RTL-No');
  assert.strictEqual(a.confirmed, true);

  // A state that does not offer it: we do NOT substitute something plausible.
  a = scope.rtlPrepaymentCode([{ optionCode: 'DSCR-3/2/1' }]);
  assert.strictEqual(a.code, null, 'never pick a prepayment clause on a lender’s behalf');
  assert.match(a.reason, /somebody has to choose/i);
  ok('RTL-No is sent, confirmed against the state list, and never substituted');
}

console.log('\nE. the field map covers everything the matrix demands');
{
  for (const cat of scope.RTL_CATEGORIES) {
    const g = fieldMap.gapsForCategory(cat);
    assert.deepStrictEqual(g.unmapped, [],
      `${cat}: the matrix asks for ${g.unmapped.join(', ')} and field-map.js has never heard of it`);
  }
  ok('no RTL template asks for a variable the field map cannot account for');

  // Ground Up Construction has NO matrix column. Reporting "nothing missing" there
  // would be the most dangerous thing this could say.
  const gu = fieldMap.gapsForCategory('Ground Up Construction');
  assert.strictEqual(gu.matrixKnown, false);
  assert.strictEqual(gu.total, 0);
  ok('Ground Up Construction is reported as unknown, never as complete');

  const known = fieldMap.gapsForCategory('12 Month with Holdback');
  assert.strictEqual(known.matrixKnown, true);
  assert.ok(known.ready.length > 20, 'most of a bridge-rehab package should already be mapped');
  assert.ok(known.blocked.length > 0, 'and the gaps must be reported, not hidden');
  for (const b of known.blocked) {
    assert.ok(b.note && b.note.length > 10, `${b.key} is blocked but says nothing about why`);
  }
  ok('a known template reports both what is ready and, with a reason, what is not');
}

console.log('\nF. the note buyer can never reach a loan document');
{
  // applications.lender is the CAPITAL PARTNER (Fidelis, Blue Lake, EMCAP). A loan
  // document is borrower-facing, and this repo's standing rule is that name never
  // appears on one. The map is the only place a source is named, so this is where
  // the rule can be enforced structurally.
  const offenders = fieldMap.FIELDS.filter((f) =>
    f.source && /\bapplications\.lender\b/.test(String(f.source)));
  assert.deepStrictEqual(offenders.map((f) => f.key), [],
    'a DocLab field is sourced from applications.lender — that is the note buyer, not the lender on the note');
  ok('no DocLab field is fed from applications.lender');

  // And the trap is written down where the next person will read it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'doclab', 'field-map.js'), 'utf8');
  assert.ok(/NEVER FEED ANY DocLab FIELD|MUST NEVER FEED/i.test(src),
    'the note-buyer warning has been removed from field-map.js');
  ok('the warning is still in the file for the next person');
}

console.log(`\nAll ${pass} DocLab catalog checks passed.\n`);

#!/usr/bin/env node
'use strict';
/**
 * THE BOARDING MAP AND FCI'S FIELD LIST MUST COVER EACH OTHER EXACTLY.
 *
 * Two files describe boarding from opposite ends. FCI owns the field list, extracted from their
 * published collection by scripts/fci-boarding-fields.js. We own the decisions, in
 * src/fci/boarding-map.js. The failure this test exists to catch is the quiet one: FCI ships v9,
 * adds a field, and our map does not mention it — nothing errors, no test fails, and the first live
 * boarding silently omits something. Or the reverse: a mapping row names a field FCI removed, and
 * the payload builder sends a key the server rejects for reasons nobody can see.
 *
 * So: every FCI field has exactly one row, every row names a real FCI field, and every ASK points
 * at a question that exists. No credential, no database, no network — it reads two files.
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { buildInventory, BLOCKS } = require(path.join(ROOT, 'scripts', 'fci-boarding-fields.js'));
const { BOARDING_MAP, QUESTIONS, KINDS } = require(path.join(ROOT, 'src', 'fci', 'boarding-map.js'));

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  process.stdout.write(`  ok   ${label}\n`);
};

const key = (r) => `${r.block}.${r.field || r.name}`;

const inventory = buildInventory().rows;

// A test that finds nothing passes for the wrong reason. Both sides have to be non-trivially
// populated before any comparison between them means anything.
ok('FCI\'s published boarding structure really was found and parsed', () => {
  assert.ok(inventory.length > 100,
    `only ${inventory.length} fields extracted from the snapshot — the parser found almost nothing, `
    + 'which would make every check below pass by comparing two near-empty sets');
  for (const b of ['loan', 'setBorrower', 'setLenders', 'setProperties', 'setFundings']) {
    assert.ok(inventory.some((r) => r.block === b), `no fields parsed for the ${b} block`);
  }
});

ok('the mapping is populated and every row is well-formed', () => {
  assert.ok(BOARDING_MAP.length > 100, `only ${BOARDING_MAP.length} mapping rows`);
  for (const r of BOARDING_MAP) {
    assert.ok(BLOCKS.includes(r.block), `row ${key(r)} names an unknown block "${r.block}"`);
    assert.ok(r.field && typeof r.field === 'string', `a row in ${r.block} has no field name`);
    assert.ok(KINDS.includes(r.kind), `row ${key(r)} has kind "${r.kind}", which is not one of ${KINDS.join('/')}`);
  }
});

ok('EVERY FCI BOARDING FIELD HAS A MAPPING ROW — a field FCI adds cannot go unmapped', () => {
  const mapped = new Set(BOARDING_MAP.map(key));
  const missing = inventory.map(key).filter((k) => !mapped.has(k));
  assert.deepStrictEqual(missing, [],
    `${missing.length} FCI boarding field(s) have no row in src/fci/boarding-map.js: ${missing.join(', ')}\n`
    + '  Add a row for each — including a deliberate OMIT, which is an answer. Silence is not.');
});

ok('EVERY MAPPING ROW NAMES A REAL FCI FIELD — a row cannot invent one', () => {
  const real = new Set(inventory.map(key));
  const phantom = BOARDING_MAP.map(key).filter((k) => !real.has(k));
  assert.deepStrictEqual(phantom, [],
    `${phantom.length} mapping row(s) name a field that is not in FCI's published boarding structure: `
    + `${phantom.join(', ')}`);
});

ok('no field is mapped twice', () => {
  const seen = new Map();
  const dupes = [];
  for (const r of BOARDING_MAP) {
    const k = key(r);
    if (seen.has(k)) dupes.push(k);
    seen.set(k, true);
  }
  assert.deepStrictEqual(dupes, [], `mapped more than once: ${dupes.join(', ')}`);
});

ok('a sourced row actually names its source, and a CONSTANT actually carries a value', () => {
  for (const r of BOARDING_MAP) {
    if (r.kind === 'PILOT' || r.kind === 'OWNER' || r.kind === 'DOCUMENT' || r.kind === 'CONSTANT') {
      assert.ok(r.source && String(r.source).trim(),
        `${key(r)} is ${r.kind} but names no source — "${r.kind}" without a source is a shrug, not a mapping`);
    }
    if (r.kind === 'OMIT' || r.kind === 'ASK') {
      assert.ok(r.note && String(r.note).trim(),
        `${key(r)} is ${r.kind} with no note — not sending a field is a decision and has to say why`);
    }
  }
});

ok('every ASK cites a question that exists, and every question is cited', () => {
  const ids = new Set(QUESTIONS.map((q) => q.id));
  const cited = new Set();
  for (const r of BOARDING_MAP) {
    // Case-insensitive on purpose: a citation reads "…is question D2." mid-sentence and "Question B1."
    // at the start of one, and a matcher that only saw the capitalised form would report a live
    // citation as an orphaned question — a false alarm that trains people to ignore this check.
    const found = String(r.note || '').match(/question ([A-D]\d+)/gi) || [];
    for (const m of found) {
      const id = m.replace(/question /i, '');
      assert.ok(ids.has(id), `${key(r)} cites "Question ${id}", which is not in QUESTIONS`);
      cited.add(id);
    }
    if (r.kind === 'ASK') {
      assert.ok(found.length,
        `${key(r)} is ASK but cites no question — an open field the owner cannot find the question for `
        + 'is an open field that never gets answered');
    }
  }
  const orphans = QUESTIONS.map((q) => q.id).filter((id) => !cited.has(id));
  assert.deepStrictEqual(orphans, [],
    `question(s) ${orphans.join(', ')} are asked but no field cites them — either a field lost its `
    + 'citation or the question is stale');
});

ok('every question says who can answer it and what it blocks', () => {
  for (const q of QUESTIONS) {
    assert.ok(q.who && q.ask && q.blocks, `question ${q.id} is missing who / ask / blocks`);
    assert.ok(q.ask.length > 40, `question ${q.id} is too terse to answer without context`);
  }
});

ok('the three balance fields move together — none may be settled while B1 is open', () => {
  // originalBalance, principalBalance, startingBalance and setFundings.funds are ONE decision wearing
  // four names. If a later edit resolves some of them and leaves the others ASK, the payload would
  // carry a mix of a settled reading and an unsettled one, which is worse than being wholly blocked.
  const balance = ['loan.originalBalance', 'loan.principalBalance', 'loan.startingBalance', 'setFundings.funds'];
  const rows = BOARDING_MAP.filter((r) => balance.includes(key(r)));
  assert.strictEqual(rows.length, balance.length, 'a balance field went missing from the map');
  const kinds = new Set(rows.map((r) => r.kind));
  assert.strictEqual(kinds.size, 1,
    'the balance fields disagree about whether the question is settled: '
    + rows.map((r) => `${key(r)}=${r.kind}`).join(', '));
});

ok('a borrower SSN never becomes an FCI TIN', () => {
  // The entity's EIN is the TIN that boards. borrowers.ssn_* is a person's SSN, it lives behind an
  // audited view_ssn gate, and a mapping that quietly pointed setBorrower.tin at it would move PII
  // out of PILOT with nothing in the diff saying so.
  const tin = BOARDING_MAP.find((r) => key(r) === 'setBorrower.tin');
  assert.ok(tin, 'setBorrower.tin is not mapped at all');
  assert.ok(!/ssn/i.test(String(tin.source)),
    `setBorrower.tin is sourced from "${tin.source}" — a borrower SSN must never be sent to FCI as a TIN`);
  assert.ok(/ein/i.test(String(tin.source)), 'setBorrower.tin should be sourced from the entity EIN');
});

ok('exactly one spelling of the reinstatement approval can ship', () => {
  // FCI's saved request and their own documentation disagree on this field's name. Both are in the
  // inventory because both are published; the map must keep exactly one of them open rather than
  // sending both keys and letting the server decide.
  const a = BOARDING_MAP.find((r) => key(r) === 'loan.approvalReinstatement');
  const b = BOARDING_MAP.find((r) => key(r) === 'loan.approvaleReinstatement');
  assert.ok(a && b, 'both spellings should appear in the map so the choice stays visible');
  assert.notStrictEqual(a.kind === 'ASK', b.kind === 'ASK',
    'exactly one of the two reinstatement spellings must be ASK — sending both, or settling both, '
    + 'means we stopped noticing that FCI contradicts itself here');
});

ok('the map covers every block FCI publishes, in full', () => {
  for (const b of BLOCKS) {
    const fciCount = inventory.filter((r) => r.block === b).length;
    if (!fciCount) continue;
    const mapCount = BOARDING_MAP.filter((r) => r.block === b).length;
    assert.strictEqual(mapCount, fciCount,
      `block ${b}: FCI publishes ${fciCount} fields, the map has ${mapCount}`);
  }
});

process.stdout.write(`\n✓ fci boarding map: ${checks} checks passed `
  + `(${inventory.length} FCI fields, ${BOARDING_MAP.length} mapping rows, ${QUESTIONS.length} open questions)\n`);

#!/usr/bin/env node
/* DocLab ↔ PILOT end-to-end audit — a DIAGNOSTIC, not a test.
 *
 *   node scripts/doclab-audit.js
 *
 * Everything printed here is COMPUTED from the three files Private Lender Law
 * published (saved under docs/doclab/reference/) and from our own source. It
 * asserts nothing from memory. Re-run it whenever PLL publishes a new
 * dictionary or whenever src/doclab/field-map.js changes, and the answer moves
 * with the data instead of with a doc somebody forgot to update.
 *
 * Sections:
 *   A.  Does our system know about every key DocLab publishes?
 *   B.  Have we DECIDED what each dictionary variable is fed from?
 *   C.  Per RTL template: how many of its variables can we actually supply?
 *   C2. The same picture grouped the way DocLab's own spreadsheet groups it.
 *   D.  What is blocking the rest, and WHO can unblock each one?
 *   E.  The repeating blocks — what the payload builder ACTUALLY emits.
 *
 * ── FOUR WAYS THIS AUDIT HAS ALREADY BEEN WRONG. Do not rebuild any of them. ──
 *
 * 1. COMPARING AGAINST field-map.FIELDS ALONE over-counts badly. Our catalogue
 *    ALSO models fee templates, array item keys, nested signatories and matrix
 *    pseudo-keys, and the spreadsheet carries SECTION HEADERS ("Borrower
 *    Information", "Loan Terms", …) that are not variables at all. Miss any of
 *    those and a healthy integration reports 40 missing fields.
 *
 * 2. TREATING A NON-BLANK MATRIX CELL AS A CLAIM. The matrix uses exactly three
 *    cell values — "✓", "—" and blank — so "not blank and not 'no'" reads every
 *    EM DASH as a claim and reports that every template needs every variable.
 *    That turned 51 variables into 81. Test for the tick.
 *
 * 3. TRUSTING WHAT THE CATALOGUE DECLARES. A repeating block can declare a key
 *    the builder never writes; it then prints BLANK on a recorded instrument
 *    and nothing anywhere complains. Section E RUNS the builder instead.
 *
 * 4. A HEADING IS IDENTIFIED BY THE HEADINGS LIST, NOT BY AN EMPTY DESCRIPTION.
 *    Three heading rows in the exported dictionary carry a stray "3.1.0" in the
 *    Description column, so a no-description test silently folds Lender
 *    Information, Loan Terms and Property Details into the section above them.
 *
 * SCOPE: DSCR and prepayment penalty are NOT part of the RTL build (owner
 * direction). DSCR template columns are counted separately and never mixed into
 * the RTL readiness figures.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REF = path.join(ROOT, 'docs/doclab/reference');

/* ---- a small CSV reader that respects quoted fields ---------------------- */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}
function readCsv(f) {
  const rows = parseCsv(fs.readFileSync(path.join(REF, f), 'utf8'));
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

const full = readCsv('data-dictionary-full.csv');
const global_ = readCsv('data-dictionary-global.csv');
const matrix = readCsv('json-key-matrix.csv');
const products = readCsv('loan-product-names.csv');

const fieldMap = require(path.join(ROOT, 'src/doclab/field-map.js'));
const catalog = require(path.join(ROOT, 'src/doclab/catalog.js'));
const { buildPayload } = require(path.join(ROOT, 'src/doclab/payload.js'));

/* Build our own Map — field-map exports BY_KEY as a plain OBJECT, and a plain
   object has no .has(), so borrowing it silently changes the shape. */
const ourByKey = new Map(fieldMap.FIELDS.map((f) => [f.key, f]));

/* Trap 4: a heading is a member of THIS list. */
const HEADERS = new Set([
  'Borrower Information', 'Collateral Property Details', 'Document Formatting',
  'Dynamic Fees', 'Guarator Information', 'Legal & Financial Terms',
  'Lender Information', 'Loan Terms', 'Property Details', 'Third Parties',
  'The items below are template names that can be included in the loan packages.',
]);

/* The dictionary lists the ten FEE TEMPLATE NAMES ("Legal Fee", "Exit Fee",
 * "Standard Fee", …) in the same column as the variables. They are not
 * variables and are deliberately NOT in the field map — a fee is a row in an
 * array, modelled in catalog.SINGLE_FEE_TEMPLATES / MULTIPLE_FEE_TEMPLATES. */
const FEE_TEMPLATE_NAMES = new Set([
  ...(catalog.SINGLE_FEE_TEMPLATES || []).map((t) => t.template),
  ...(catalog.MULTIPLE_FEE_TEMPLATES || []).map((t) => t.template),
]);

/* The matrix's shorthand for "this template accepts the fee arrays". Not merge
 * fields, so they have no field-map entry by design. */
const PSEUDO = new Set(catalog.MATRIX_PSEUDO_KEYS || []);

const matrixCols = Object.keys(matrix[0] || {}).filter((k) => !['jsonKey', 'Description', 'Version'].includes(k));
const isDscrCol = (c) => /dscr/i.test(c);
const rtlCols = matrixCols.filter((c) => !isDscrCol(c));
const dscrCols = matrixCols.filter(isDscrCol);

const CLAIMED = '✓'; // trap 2
const usedBy = (row, cols) => cols.filter((c) => String(row[c] || '').trim() === CLAIMED);

const line = (ch = '=') => console.log(ch.repeat(78));

/* ─────────────────────────────────────────────────────────────────────────
 * THE EMISSION PROBE (trap 3), computed FIRST because every readiness figure
 * below depends on it. Run the real payload builder against a fixture that
 * supplies every declared key, and record what actually comes out. A nested
 * key is recorded under the DICTIONARY's spelling — "signatory_name
 * (borrower)" — so the two vocabularies line up.
 * ───────────────────────────────────────────────────────────────────────── */
const FIXTURE = {
  loanAmount: 487500,
  program: 'standard',
  loanType: 'Fix & Flip',
  entityName: 'Acme Holdings LLC',
  entityState: 'NJ',
  borrowerName: 'Jane Doe',
  borrowerTitle: 'Managing Member',
  borrowerAddress: { line1: '1 Main St', city: 'Newark', state: 'NJ', zip: '07102' },
  entityMembers: [{ name: 'Jane Doe', title: 'Managing Member' }],
  guarantors: [{
    name: 'Acme Guarantor Corp',
    title: 'Guarantor',
    address: { line1: '2 Oak St', city: 'Newark', state: 'NJ', zip: '07102' },
    signatories: [{ name: 'John Roe', title: 'President' }],
  }],
  propertyAddress: { line1: '12 Elm St', city: 'Newark', state: 'NJ', zip: '07103', county: 'Essex' },
};
/* Prepayment penalty is not part of the RTL build and its two keys carry no
   field-map entry, so the per-key scope test cannot see them. Named here. */
const OUT_OF_SCOPE_BLOCKS = new Set(['pre_payment_penalty']);
const singular = (block) => block.replace(/s$/, '');

const emitted = new Set();     // dictionary-spelling keys the builder writes
const blockReport = [];        // for section E
let probeError = '';
{
  let vars = {};
  try { vars = ((buildPayload(FIXTURE, {}, {}) || {}).payload || {}).variables || {}; }
  catch (e) { probeError = e.message; }

  const outOfScope = (k) => { const f = ourByKey.get(k); return !!(f && f.status === 'out_of_scope'); };

  for (const [name, spec] of Object.entries(catalog.ARRAY_VARIABLES || {})) {
    if (spec.isObject) continue;                       // the fee object has its own tables
    if (OUT_OF_SCOPE_BLOCKS.has(name)) { blockReport.push({ name, skipped: 'not part of the RTL build' }); continue; }
    const rows = Array.isArray(vars[name]) ? vars[name] : [];
    const first = rows[0] || {};
    const declared = (spec.itemKeys || []).filter((k) => !outOfScope(k));
    const wrote = declared.filter((k) => first[k] !== undefined && first[k] !== '');
    for (const k of wrote) emitted.add(k);

    const nests = [];
    for (const [nest, keys] of Object.entries(spec.nested || {})) {
      const nrows = Array.isArray(first[nest]) ? first[nest] : [];
      const nfirst = nrows[0] || {};
      const nwrote = keys.filter((k) => nfirst[k] !== undefined && nfirst[k] !== '');
      for (const k of nwrote) emitted.add(`${k} (${singular(name)})`);
      nests.push({ nest, keys, wrote: nwrote, absent: !nrows.length });
    }
    blockReport.push({ name, declared, wrote, dropped: declared.filter((k) => !wrote.includes(k)), nests });
  }
}

/* THE ONE READINESS TEST, used by every section below.
 * A variable is SUPPLIED when the field map says we fill it, or when the
 * builder was observed writing it, or when it is a matrix pseudo-key (the fee
 * arrays, which the fee system builds). Anything else is a gap. */
const fieldReady = (f) => (fieldMap.isReady ? fieldMap.isReady(f) : ['mapped', 'derived'].includes(f.status));
const isSupplied = (k) => {
  if (PSEUDO.has(k)) return true;
  if (emitted.has(k)) return true;
  const f = ourByKey.get(k);
  return !!(f && fieldReady(f));
};
const isOutOfScope = (k) => {
  const f = ourByKey.get(k);
  return !!(f && f.status === 'out_of_scope');
};

/* ======================================================================= A */
line();
console.log('A. DOES OUR SYSTEM KNOW ABOUT EVERY KEY DOCLAB PUBLISHES?');
line();

/* Everything OUR side models, from EVERY structure — not just the field map. */
const known = new Set();
for (const f of fieldMap.FIELDS) known.add(f.key);
for (const k of PSEUDO) known.add(k);
for (const k of Object.keys(catalog.DYNAMIC_FEE_KEYS || {})) known.add(k);
for (const k of FEE_TEMPLATE_NAMES) known.add(k);
for (const [name, spec] of Object.entries(catalog.ARRAY_VARIABLES || {})) {
  known.add(name);
  for (const k of (spec.itemKeys || [])) known.add(k);
  for (const arr of Object.values(spec.nested || {})) for (const k of arr) known.add(k);
}
const V = catalog.VARIABLES;
if (Array.isArray(V)) for (const k of V) known.add(typeof k === 'string' ? k : (k && k.key));
else if (V && typeof V === 'object') for (const k of Object.keys(V)) known.add(k);

const allKeys = new Map(); // key -> {desc, version, rtl, dscr}
const note = (k, d, v) => {
  if (!k) return;
  const e = allKeys.get(k) || { desc: '', version: '', rtl: 0, dscr: 0 };
  if (d && !e.desc) e.desc = d;
  if (v && !e.version) e.version = v;
  allKeys.set(k, e);
};
for (const r of full) note(r.json_key, r.Description, r.Version);
for (const r of global_) note(r.json_key, r.Description, r.Version);
for (const r of matrix) {
  note(r.jsonKey, r.Description, r.Version);
  const e = allKeys.get(r.jsonKey);
  if (e) { e.rtl = usedBy(r, rtlCols).length; e.dscr = usedBy(r, dscrCols).length; }
}

/* A nested key is published as "signatory_name (borrower)" and modelled as
   "signatory_name". Strip the qualifier before asking whether we know it. */
const bare = (k) => k.replace(/\s*\((borrower|guarantor)\)\s*$/i, '');
const realKeys = [...allKeys.keys()].filter((k) => !HEADERS.has(k));
const gap = realKeys.filter((k) => !known.has(k) && !known.has(bare(k))).sort();

console.log(`dictionary (full):       ${full.length} rows`);
console.log(`dictionary (global):     ${global_.length} rows`);
console.log(`template matrix:         ${matrix.length} variables x ${matrixCols.length} templates`);
console.log(`  RTL template columns:   ${rtlCols.length}`);
console.log(`  DSCR template columns:  ${dscrCols.length}  (out of scope by owner direction)`);
console.log(`loan products published: ${products.length}`);
console.log('');
console.log(`published keys (section headers removed): ${realKeys.length}`);
console.log(`section headers excluded:                 ${[...allKeys.keys()].length - realKeys.length}`);
console.log(`recognised by PILOT:                      ${realKeys.length - gap.length}`);
console.log(`GENUINELY UNMAPPED:                       ${gap.length}`);
for (const k of gap) {
  const e = allKeys.get(k);
  console.log(`   - ${k}  (v${e.version || '?'}  RTL:${e.rtl} DSCR:${e.dscr})  ${(e.desc || '(no description published)').slice(0, 70)}`);
}

/* ======================================================================= B */
console.log('');
line();
console.log('B. HAVE WE DECIDED WHAT EACH DICTIONARY VARIABLE IS FED FROM?');
line();
console.log('A key can be RECOGNISED (section A) and still have no decision recorded');
console.log('about where its value comes from. That decision lives in field-map.js.');
console.log('');

const dictKeys = new Set();
const addDictKey = (k) => { if (k && !HEADERS.has(k) && !FEE_TEMPLATE_NAMES.has(k)) dictKeys.add(k); };
for (const r of full) addDictKey(r.json_key);
for (const r of global_) addDictKey(r.json_key);

const undecided = [...dictKeys].filter((k) => !ourByKey.has(k)).sort();
const byStatus = {};
for (const f of fieldMap.FIELDS) (byStatus[f.status] = byStatus[f.status] || []).push(f);

console.log(`published dictionary variables:   ${dictKeys.size}`);
console.log(`field map records a decision for: ${dictKeys.size - undecided.length}`);
console.log(`NO DECISION RECORDED:             ${undecided.length}`);
console.log('');
console.log('field-map decisions by status:');
for (const s of Object.keys(byStatus).sort()) {
  const tag = ['mapped', 'derived'].includes(s) ? 'we fill it' : '';
  console.log(`  ${s.padEnd(14)} ${String(byStatus[s].length).padStart(3)}  ${tag}`);
}
if (undecided.length) {
  console.log('');
  console.log('  variables with no decision recorded:');
  for (const k of undecided) {
    const e = allKeys.get(k) || {};
    const builder = emitted.has(k) ? '  (but the builder DOES emit it)' : '';
    console.log(`   - ${k}  (v${e.version || '?'}  RTL:${e.rtl || 0} DSCR:${e.dscr || 0})${builder}`);
  }
}

/* catalog.VARIABLES is our own inventory of the merge fields. Anything missing
 * from it is still safe today — the field map is what the payload builder reads
 * — but the two lists disagreeing is how a variable ends up decided in one
 * place and invisible in the other. */
const catVars = new Set(Object.keys(catalog.VARIABLES || {}));
const missingFromCatalogue = [...dictKeys].filter((k) => !catVars.has(k) && !emitted.has(k) && !PSEUDO.has(k)).sort();
console.log('');
console.log(`catalog.VARIABLES carries ${catVars.size} of the ${dictKeys.size} published variables.`);
if (missingFromCatalogue.length) {
  console.log(`  ${missingFromCatalogue.length} published variables are NOT in our catalogue's own list:`);
  for (const k of missingFromCatalogue) {
    const f = ourByKey.get(k);
    console.log(`   - ${k}${f ? `  (the field map DOES decide it: ${f.status})` : '  (and no field-map decision either)'}`);
  }
}

/* ======================================================================= C */
console.log('');
line();
console.log('C. PER RTL TEMPLATE — HOW MANY VARIABLES CAN WE SUPPLY TODAY?');
line();
console.log('Reported PER TEMPLATE COLUMN, not per product family. A loan is drafted on');
console.log('exactly ONE template — one security instrument — so the number that means');
console.log('anything is "what does THIS document need". Unioning the DOT / DTSD / MTG');
console.log('variants of a product would overstate what any single document asks for.');
console.log('');

const blockerTally = new Map(); // key -> {status, note, templates:Set}
console.log('  template                          needs  ready  blocked  (out of scope)');
for (const col of rtlCols) {
  const vars = matrix.filter((r) => usedBy(r, [col]).length > 0)
    .map((r) => r.jsonKey).filter((k) => k && !HEADERS.has(k));
  let ready = 0, oos = 0;
  const blocked = [];
  for (const k of vars) {
    if (isSupplied(k)) { ready++; continue; }
    if (isOutOfScope(k)) { oos++; continue; }
    blocked.push(k);
    const f = ourByKey.get(k);
    const e = blockerTally.get(k) || { status: f ? f.status : 'no_decision', note: f ? f.note : '', templates: new Set() };
    e.templates.add(col);
    blockerTally.set(k, e);
  }
  console.log(`  ${col.padEnd(34)}${String(vars.length - oos).padStart(4)}${String(ready).padStart(7)}${String(blocked.length).padStart(9)}${String(oos).padStart(10)}`);
}

/* A published product with NO matrix column cannot be assessed at all. */
console.log('');
const colBases = rtlCols.map((c) => c.toLowerCase().replace(/\s*-?\s*(dot|dtsd|dstd|mtg)\s*$/i, '').trim());
for (const p of products) {
  const name = String(p['Template Name'] || '').trim();
  if (!name || /dscr/i.test(name)) continue;
  const n = name.toLowerCase();
  if (!colBases.some((c) => c === n || c.includes(n) || n.includes(c))) {
    console.log(`  *** "${name}" is a published loan product with NO column in the variable matrix.`);
    console.log('        We know the product exists and cannot know what it asks for.');
  }
}

/* ====================================================================== C2 */
console.log('');
line();
console.log('C2. THE SAME PICTURE GROUPED THE WAY DOCLAB GROUPS IT');
line();
let section = '(ungrouped)';
const sections = new Map();
for (const r of full) {
  const k = r.json_key;
  if (!k) continue;
  if (HEADERS.has(k)) { section = k; continue; }   // trap 4
  if (FEE_TEMPLATE_NAMES.has(k)) continue;
  if (!sections.has(section)) sections.set(section, []);
  sections.get(section).push(k);
}
console.log('  section                          fields  ready  blocked  (out of scope)');
for (const [name, keys] of sections) {
  let ready = 0, oos = 0;
  const blocked = [];
  for (const k of keys) {
    if (isSupplied(k)) { ready++; continue; }
    if (isOutOfScope(k)) { oos++; continue; }
    blocked.push(k);
  }
  console.log(`  ${name.padEnd(32)}${String(keys.length - oos).padStart(5)}${String(ready).padStart(7)}${String(blocked.length).padStart(9)}${String(oos).padStart(10)}`);
  if (blocked.length) console.log(`       not ready: ${blocked.join(', ')}`);
}

/* ======================================================================= D */
console.log('');
line();
console.log('D. WHAT IS BLOCKING THE REST, AND WHO CAN UNBLOCK EACH ONE?');
line();

const OWNER = {
  needs_config: 'SETTINGS — our own lender/servicer details, entered once',
  needs_rule: 'A DECISION — somebody has to choose the policy',
  needs_source: 'DATA — the value has to be captured on the file',
  no_decision: 'UNDECIDED — no entry in the field map yet',
};
const groups = new Map();
for (const [k, e] of blockerTally) {
  const g = OWNER[e.status] || e.status;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push({ key: k, ...e });
}
console.log(`distinct blockers across all ${rtlCols.length} RTL templates: ${blockerTally.size}`);
console.log('');
for (const [g, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${g}  (${list.length})`);
  for (const b of list.sort((a, b2) => a.key.localeCompare(b2.key))) {
    console.log(`   - ${b.key}   [${b.templates.size} of ${rtlCols.length} templates]`);
    if (b.note) console.log(`       ${String(b.note).replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  console.log('');
}

/* ======================================================================= E */
line();
console.log('E. THE REPEATING BLOCKS — WHAT THE BUILDER ACTUALLY EMITS');
line();
console.log('The catalogue DECLARES which keys each repeating block carries. That is a');
console.log('promise, not a proof, so this runs the real payload builder on a fixture');
console.log('supplying every declared value and reports what comes out. A key that is');
console.log('declared and never written prints BLANK on a recorded instrument and');
console.log('nothing anywhere complains.');
console.log('');
if (probeError) console.log(`  the builder threw: ${probeError}`);
for (const b of blockReport) {
  if (b.skipped) { console.log(`  ${b.name}  (${b.skipped} — skipped by owner direction)`); continue; }
  console.log(`  ${b.name}`);
  console.log(`     item keys declared ${b.declared.length}, emitted ${b.wrote.length}`);
  if (b.dropped.length) console.log(`     *** NOT EMITTED: ${b.dropped.join(', ')}`);
  for (const n of b.nests) {
    if (n.absent) { console.log(`     *** NESTED "${n.nest}" NOT EMITTED AT ALL (declares ${n.keys.join(', ')})`); continue; }
    const missing = n.keys.filter((k) => !n.wrote.includes(k));
    console.log(`     nested "${n.nest}": ${n.wrote.length}/${n.keys.length} emitted${missing.length ? `  *** NOT EMITTED: ${missing.join(', ')}` : ''}`);
  }
}
console.log('');
console.log('The fixture supplies every value, so nothing above is a missing input —');
console.log('a "NOT EMITTED" line is the builder not writing a value it was handed.');

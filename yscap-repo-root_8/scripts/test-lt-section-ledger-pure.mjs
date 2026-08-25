// LONG-TERM — THE SECTION BODIES ARE A LEDGER, AND THEY ARE GROUPED (#58,
// owner-directed 2026-08-25: *"set it up nicer, better to the eye, more user-friendly
// ... more like a structure, more like an order, like a rich LOS, not just flowing
// away everything"*, and *"on the RTL side ... try to copy the same idea so it should
// look familiar"*).
//
// WHAT CHANGED. The facts used to stack the label on TOP of the value in a plain
// two-column grid, so a fourteen-fact section read as twenty-eight lines of
// alternating small and large text with no shape — the "flowing away". They are laid
// out as a ledger now: label left, value RIGHT, a hairline between rows so the eye can
// run down a column of figures. And the long sections are broken into NAMED CLUSTERS,
// which is the "order" half — one run of fourteen makes somebody read all fourteen to
// answer any one question.
//
// WHAT MUST NOT BE LOST IN A TIDY-UP, and is pinned here for that reason: the third
// answer beside a value and a dash ("Encompass does not record this"), which is what
// stops a blank reading as "not in a flood zone"; and every colour staying an explicit
// dark, since in this palette every `--ink*` token is a LIGHT paper colour.
//
// LONG-TERM'S OWN CLASSES, deliberately. RTL's `.snap-*` components are RTL's; the two
// products do not share code, and what was asked for is the same IDEA so a person
// moving between the screens recognises the shape.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '../app-v2');
const requireApp = createRequire(path.join(appDir, 'package.json'));

let esbuild;
try { esbuild = requireApp('esbuild'); requireApp('react-dom/server'); } catch {
  console.log('app-v2/node_modules is not installed here — this needs the front-end toolchain. Skipped (run `cd app-v2 && npm install` to enable).');
  process.exit(0);
}

let checks = 0;
const ok = (c, w) => { if (!c) { console.error('FAIL:', w); process.exit(1); } console.log('  ok  ', w); checks++; };

const ui = readFileSync(path.join(appDir, 'src/longterm/LtFileSections.jsx'), 'utf8');
const css = readFileSync(path.join(appDir, 'src/styles.css'), 'utf8');

async function render(js) {
  const out = await esbuild.build({
    stdin: {
      contents: `import React from 'react'; import { renderToString } from 'react-dom/server';
        import LtFileSection, { Facts } from ${JSON.stringify('./src/longterm/LtFileSections.jsx')};
        globalThis.__HTML__ = renderToString(${js});`,
      resolveDir: appDir, loader: 'jsx',
    },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /\.\/api\.js$/ }, (a) => ({ path: a.path, namespace: 's' }));
      b.onLoad({ filter: /.*/, namespace: 's' }, () => ({ contents: 'export const ltApi = {};', loader: 'js' }));
    } }],
  });
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(requireApp, { exports: {} }, {});
  return globalThis.__HTML__;
}

// ── 1. A flat list is a ledger ───────────────────────────────────────────────
console.log('a fact is a ledger row');

const flat = await render(`React.createElement(Facts, { rows: [['Loan amount', '$600,000'], ['Note rate', '7.125%']] })`);
ok(flat.includes('ltf-row') && flat.includes('ltf-rk') && flat.includes('ltf-rv'),
  'THE ONE THAT MATTERS: the label and the value are two cells of one row, not a label stacked on top of a value');
ok(flat.includes('$600,000') && flat.includes('7.125%'), 'the values are drawn');
ok(!flat.includes('<dt') && !flat.includes('<dd'),
  '…and the old stacked definition list is gone, not merely restyled');

// ── 2. Named clusters turn a list into a structure ───────────────────────────
console.log('');
console.log('a long section is broken into named parts');

const grouped = await render(`React.createElement(Facts, { columns: 3, rows: [
  { group: 'The money', rows: [['Loan amount', '$600,000']] },
  { group: 'Paying it off early', rows: [['Prepayment penalty', '60 months']] },
] })`);
ok(grouped.includes('ltf-clusters') && grouped.includes('ltf-cluster-h'),
  'a grouped list draws its clusters, each with its own heading');
ok(grouped.includes('The money') && grouped.includes('Paying it off early'), 'and both headings are drawn');
ok((grouped.match(/ltf-cluster-h/g) || []).length === 2, 'exactly one heading per group — never a heading over nothing');

// A MIXED ARRAY IS NOT A SHAPE. Drawing a bare row beside a titled cluster leaves
// that row belonging to nothing, so a mixed array is read as the flat list it mostly
// is — never half of each.
const mixed = await render(`React.createElement(Facts, { rows: [
  ['Loose fact', 'x'],
  { group: 'A group', rows: [['Inside', 'y']] },
] })`);
ok(!mixed.includes('ltf-clusters') && mixed.includes('Loose fact') && mixed.includes('Inside'),
  'a MIXED array falls back to one flat ledger and loses no fact — a bare row beside a titled cluster would belong to nothing');

// ── 3. The third answer survives the tidy-up ────────────────────────────────
console.log('');
console.log('“Encompass does not record this” is still its own answer');

const note = await render(`React.createElement(Facts, { rows: [['In a flood zone', '—', 'Encompass records no flood determination.']] })`);
ok(note.includes('Encompass records no flood determination.'),
  'THE ONE THAT MUST NOT BE LOST: a field that can never fill says WHY, instead of a dash — a dash beside "In a flood zone" reads as "No", and "No" is an answer somebody prices a loan on');
ok(note.includes('ltf-rv-note'), '…and it is drawn as a sentence rather than as a value');
const realValue = await render(`React.createElement(Facts, { rows: [['In a flood zone', 'Yes', 'Encompass records no flood determination.']] })`);
ok(realValue.includes('Yes') && !realValue.includes('Encompass records no flood determination.'),
  '…and the moment a real value arrives the sentence gives way to it');

// ── 4. The sections the owner named are grouped ─────────────────────────────
console.log('');
console.log('the sections the owner named have a shape');

for (const [fn, groups] of [
  ['function Summary', ['Parties', 'Property', 'The loan']],
  ['function Property', ['The property', 'What it is worth', 'Flood']],
  ['function Terms', ['The money', 'What kind of loan', 'Paying it off early']],
]) {
  const i = ui.indexOf(fn);
  const body = ui.slice(i, ui.indexOf('\nfunction ', i + 1));
  ok(i > 0 && body.length > 200, `${fn} is readable`);
  for (const g of groups) {
    ok(body.includes(`group: '${g}'`), `  …and carries the “${g}” cluster`);
  }
}

// ── 5. The rules a redesign is most likely to quietly break ─────────────────
console.log('');
console.log('the standing rules still hold');

ok(!/color:\s*['"`]?var\(--ink/.test(ui),
  'no --ink* token is used as a text colour — every one of them is a LIGHT paper colour in this palette');
ok(!/\.ltf-(row|rk|rv|cluster|clusters|cluster-h)\b[^{]*\{[^}]*var\(--ink/.test(css),
  '…and the ledger styles state their own darks rather than reaching for one');
ok(/\.ltf-rk\{[^}]*flex:none/.test(css),
  'THE LABEL NEVER SHRINKS — with both sides shrinkable, flexbox squeezes them proportionally and a label wraps to three words per line beside a value with room to spare');
ok(/\.ltf-rv\{[^}]*min-width:0/.test(css),
  '…and the VALUE absorbs the squeeze, so a long one wraps instead of pushing the row wider than its column');
ok(/\.ltf-rv\{[^}]*font-variant-numeric:tabular-nums/.test(css),
  'figures are on tabular numerals, which is what lets the eye run down a column of money');
ok(/@media\(max-width:640px\)\{[\s\S]{0,400}\.ltf-clusters\{grid-template-columns:1fr/.test(css),
  'on a phone the clusters stack rather than squeezing three columns into 390px');
// AND THE ONE CONTRADICTION THE SCREENSHOT SHOWED. With no coverage from the server
// the summary printed "Every section that applies to this loan has something on it."
// directly above "No sections apply to this loan." — the summary line and the table
// each answering from a different half of the same absence. They are mutually
// exclusive now, and the empty case says PILOT has not worked it out rather than
// making a claim about the loan.
const empty = await render(`React.createElement(LtFileSection, {
  sectionKey: 'summary',
  file: { terms: {}, property: {}, income: {}, borrowers: { parties: [] }, coverage: {} },
  sections: [{ key: 'summary', label: 'Loan summary', available: true }],
  lock: null, contacts: [], history: [],
})`);
ok(!(empty.includes('Every section that applies') && empty.includes('No sections apply')),
  'THE ONE THE SCREENSHOT CAUGHT: the coverage block never prints two sentences that contradict each other');
ok(empty.includes('has not worked out which sections'),
  '…it says PILOT has not worked it out, which is a statement about US rather than about the loan');

ok(!/snap-row|snap-cluster|snap-rk|snap-rv/.test(ui),
  'THE PRODUCT LINE HOLDS: long-term draws its own classes and never reaches for RTL’s components — the owner asked for the same idea, not for one product to be wired into the other');

console.log(`\nAll ${checks} checks passed.`);

'use strict';
/**
 * LONG-TERM — THE RULE CENTER'S PICKERS: MORE THAN ONE VALUE, AND A LIST TO PICK FROM.
 *
 * ── THE TWO REPORTS (owner, 2026-09-04, in one message) ────────────────────
 *
 *   *"When you want to select a few things, the system doesn't let you select
 *   more than one. When it comes up with a list of stuff you need to select a
 *   few, it doesn't work."*
 *
 *   *"On the rule condition by the field, you should have a search to be able to
 *   search and just populate that field that you are looking for."* … *"I want
 *   to put a rule to block a certain investor or to block a certain white label
 *   name, not populate the value. We can only type. We need to have the same
 *   kind of dropdown, select, and search."*
 *
 * ── NOTHING WAS BROKEN IN THE DATA. THE CONTROLS WERE. ─────────────────────
 *
 * The value box for an "is any of" test was a native `<select multiple>`, which
 * requires a Ctrl or Cmd click: a plain click on a second option DESELECTS the
 * first. The field box was a `<select>` with optgroups over ~60 fields, which is
 * a scroll rather than a search. And the four fields that name an investor are
 * TEXT in the registry with no options at all, so they fell back to free typing.
 *
 * ── WHAT THIS SUITE PROVES, AND WHAT IT CANNOT ─────────────────────────────
 *
 * ⛔ THE RULES ARE EXTRACTED AND RUN, NOT READ. A source check can tell you the
 * word "checkbox" appears; it cannot tell a working tick-box list from one whose
 * toggle replaces the picked set instead of adding to it — which IS the defect.
 * So the shipped functions are lifted out of the `.jsx` (which this CommonJS
 * suite cannot require) and executed.
 *
 * ⛔ AND THE ONE THING ONLY A BROWSER CAN SEE is stated rather than implied:
 * whether a real click on a second option keeps the first. That is
 * `scripts/render-lt-rule-pickers.mjs`, which drives the shipped bundle.
 *
 * PURE: no browser, no database, no build.
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const raw = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { stripComments } = require(path.join(ROOT, 'scripts/lib/strip-comments'));

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else {
    const line = `${name}${extra ? ` — ${extra}` : ''}`;
    failures.push(line); console.log(`  FAIL ${line}`);
  }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
  `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SCREEN = 'app-v2/src/longterm/LtPricingRules.jsx';
const SRC = raw(SCREEN);
const CODE = stripComments(SRC);

/** Lift a top-level function out of the shipped screen and make it callable. */
function lift(name, deps = '') {
  const at = SRC.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const open = SRC.indexOf('{', SRC.indexOf(')', at));
  let depth = 0;
  let i = open;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  const body = SRC.slice(at, i + 1);
  try { return new Function(`${deps}\n${body}\nreturn ${name};`)(); } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nA. THE CONTROL THAT COULD NOT DO WHAT IT PROMISED IS GONE');
// ═══════════════════════════════════════════════════════════════════════════
ok('A1  no native multi-select is left in the builder',
  !/<select\s+[^>]*\bmultiple\b/.test(CODE) && !/\n\s*multiple\n/.test(CODE),
  'a `<select multiple>` needs a Ctrl-click, which is the whole reported defect');
ok('A2  the "is any of" box is a tick-box list', /<OptionChecklist\s/.test(CODE));
ok('A3  …with a search over it, because a list of fifty states is not a list you scroll',
  /data-tickbox-search/.test(CODE));
ok('A4  …and it says how many are picked, so a filtered view can never hide what the rule holds',
  /data-tickbox-count/.test(CODE));
ok('A5  the field box is searchable rather than a sixty-item dropdown',
  /<SearchPick\s/.test(CODE) && /data-field-search/.test(CODE));
ok('A6  …and the plain `<select>` over the field groups is gone',
  !/<optgroup/.test(CODE),
  'the group headings survive inside the new picker; the optgroup element does not');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nB. THE SEARCH RULE, RUN');
// ═══════════════════════════════════════════════════════════════════════════
const matches = lift('matches');
ok('B1  the shared search rule was found in the shipped screen', !!matches);
if (matches) {
  eq('B2  an empty search matches everything', matches('', 'Property state'), true);
  eq('B3  …and so does whitespace', matches('   ', 'Property state'), true);
  eq('B4  it folds case', matches('STATE', 'Property state'), true);
  eq('B5  it matches part of a word, which is how somebody searches',
    matches('stat', 'Property state'), true);
  eq('B6  IT READS THE KEY AS WELL AS THE LABEL — somebody who knows the column name types that',
    matches('white_label', 'White-label name', 'white_label'), true);
  eq('B7  and a miss is a miss', matches('zzz', 'Property state', 'state'), false);
  eq('B8  a null part never throws and never matches', matches('x', null, undefined), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nC. A SECOND PICK ADDS — THE DEFECT ITSELF');
// ═══════════════════════════════════════════════════════════════════════════
/* The tick-box `toggle` is lifted out of the component and run against a
   captured `onChange`. This is the arithmetic half of the reported bug; whether
   a real mouse click behaves this way is the render harness's job. */
/* ⛔ THE WHOLE DERIVATION IS LIFTED, NOT JUST THE TOGGLE. `toggle` calls
   `order`, which is built from `custom` and `all` — lifting one line of a block
   that reads three produces a ReferenceError, which is a CRASH rather than a
   failure and looks exactly like proof until you read the output. */
const CHECKLIST = (() => {
  const a = SRC.indexOf('const custom = picked.filter(');
  const b = SRC.indexOf('const allShown =');
  return a >= 0 && b > a ? SRC.slice(a, b) : null;
})();
/* The block also builds `shown`, which calls the screen's own `matches` — so the
   REAL search rule is put in the sandbox beside it rather than a stand-in, and
   the two can never diverge inside this test. */
const MATCHES_SRC = (() => {
  const a = SRC.indexOf('function matches(');
  if (a < 0) return '';
  let d = 0;
  let i = SRC.indexOf('{', a);
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') d++;
    else if (SRC[i] === '}' && --d === 0) break;
  }
  return SRC.slice(a, i + 1);
})();
const runToggle = (opts, picked, v) => {
  let out = null;
  const fn = new Function('opts', 'picked', 'onChange', 'setTyped', 'typed', 'q', `
    ${MATCHES_SRC}
    const set = new Set(picked);
    ${CHECKLIST || 'const toggle = () => {};'}
    return toggle;
  `)(opts, picked, (next) => { out = next; }, () => {}, '', '');
  fn(v);
  return out;
};
{
  ok('C1  the tick-box list\'s whole value derivation was found', !!CHECKLIST);
  const opts = [{ v: 'NJ', label: 'New Jersey' }, { v: 'NY', label: 'New York' }, { v: 'PA', label: 'Pennsylvania' }];
  const run = (picked, v) => runToggle(opts, picked, v);
  eq('C2  picking one records one', run([], 'NJ'), ['NJ']);
  eq('C3  ⛔ PICKING A SECOND KEEPS THE FIRST — a plain click on the old control deselected it',
    run(['NJ'], 'NY'), ['NJ', 'NY']);
  eq('C4  …and a third keeps both', run(['NJ', 'NY'], 'PA'), ['NJ', 'NY', 'PA']);
  eq('C5  picking a picked one takes it back off', run(['NJ', 'NY'], 'NJ'), ['NY']);
  eq('C6  THE STORED ORDER IS THE OPTION LIST’S, never click order — so two rules naming the same states read alike',
    run(['PA', 'NJ'], 'NY'), ['NJ', 'NY', 'PA']);
  eq('C7  …and the value stays an ARRAY of option values, so the stored rule, the validator and the overlay are untouched',
    Array.isArray(run([], 'NJ')), true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nC2. A NAME THAT IS NOT ON THE LIST IS STILL PICKED, AND STILL KEPT');
// ═══════════════════════════════════════════════════════════════════════════
/* On a TEXT field the list is a ROSTER — a shortcut — so a rule may name an
   investor nobody has quoted yet. The tick-box list rebuilt its answer from the
   OPTIONS, which silently DROPPED such a name the next time anybody ticked
   anything: a rule quietly changing meaning while somebody edits it. */
{
  ok('C8  a value not on the list is kept in the derivation', !!CHECKLIST && /const custom = picked\.filter/.test(CHECKLIST));
  const opts = [{ v: 'NJ', label: 'New Jersey' }, { v: 'NY', label: 'New York' }];
  const run = (picked, v) => runToggle(opts, picked, v);
  eq('C9  ⛔ TICKING ANOTHER STATE DOES NOT DROP A NAME SOMEBODY TYPED',
    run(['Brand New Capital', 'NJ'], 'NY'), ['Brand New Capital', 'NJ', 'NY']);
  eq('C10 …and the typed one can still be taken off deliberately',
    run(['Brand New Capital', 'NJ'], 'Brand New Capital'), ['NJ']);
  ok('C11 the box for it is offered on a TEXT field only — on an enum the list IS the set of answers',
    /allowCustom=\{field\.type === 'text'\}/.test(CODE) && /allowCustom &&/.test(CODE));
  ok('C12 …and a typed value is marked as one, so nobody hunts for it on the roster',
    /typed in/.test(SRC));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nC3. THE VALUE FOLLOWS THE TEST');
// ═══════════════════════════════════════════════════════════════════════════
/* A list test holds an ARRAY and a plain one holds a value. Carrying one shape
   into the other is not cosmetic: moving from "is any of" to "is" used to keep
   the array, so the single-value box rendered `NJ,NY` as its text, matched
   nothing in its own list, and the rule that saved said something nobody wrote. */
{
  const vfo = lift('valueForOperator');
  ok('C13 the reshape rule was found', !!vfo);
  if (vfo) {
    const cat = { noValueOperators: ['is_empty'], rangeOperators: ['between'], listOperators: ['in', 'not_in'] };
    eq('C14 a test that takes no value holds none', vfo(cat, 'is_empty', 'NJ'), undefined);
    eq('C15 a list test keeps an array it is given', vfo(cat, 'in', ['NJ', 'NY']), ['NJ', 'NY']);
    eq('C16 …and lifts a single value into one, rather than starting blank', vfo(cat, 'in', 'NJ'), ['NJ']);
    eq('C17 …a blank becomes an empty list, never [""]', vfo(cat, 'in', ''), []);
    eq('C18 ⛔ A PLAIN TEST NEVER INHERITS AN ARRAY — it collapses to the nearest thing that was meant',
      vfo(cat, 'eq', ['NJ', 'NY']), 'NJ');
    eq('C19 …and an empty list becomes a blank, not "undefined"', vfo(cat, 'eq', []), '');
    eq('C20 a range test holds two boxes', vfo(cat, 'between', 'x'), ['', '']);
    eq('C21 …and keeps a pair it already had', vfo(cat, 'between', ['1', '2']), ['1', '2']);
    eq('C22 an ordinary value is carried across unchanged', vfo(cat, 'eq', 'NJ'), 'NJ');
  }
  ok('C23 …and BOTH places the test can change go through it — the field picker and the test picker',
    (CODE.match(/valueForOperator\(cat, /g) || []).length >= 2);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nD. THE ROSTER IS PUBLISHED, NOT COPIED');
// ═══════════════════════════════════════════════════════════════════════════
{
  const routeSrc = stripComments(raw('src/longterm/routes/pricing-rules.js'));
  ok('D1  the catalogue publishes which fields offer a list',
    /optionsByField: inv\.options/.test(routeSrc));
  ok('D2  …and whether the roster could be read at all',
    /optionsProblem: inv\.problem/.test(routeSrc));
  ok('D3  it comes off the ONE roster the settings screen reads',
    /investorSettings\.roster\(/.test(routeSrc) && /investorConfig\.customRaw\(\)/.test(routeSrc));

  /* ⛔ AND IT IS NOT IN THE FIELD REGISTRY. That module is PURE — the overlay,
     the validator and the door all read one grammar out of it — and the roster
     is DB-backed and per-tenant, so putting it there would make the registry
     impure or freeze one tenant's investors into the code. */
  const fieldsSrc = stripComments(raw('src/longterm/pricing/rules/fields.js'));
  ok('D4  the field registry stays pure — it requires no database and no settings store',
    !/require\('\.\.\/investor-config'\)|require\('\.\.\/investor-settings'\)|settingsStore/.test(fieldsSrc));
  ok('D5  …and the four investor fields are still TEXT, so a name nobody has seen is still writable',
    /key: 'investor', label: 'Investor', type: 'text'/.test(fieldsSrc)
    && /key: 'white_label', label: 'White-label name', type: 'text'/.test(fieldsSrc));

  const merge = lift('withRosterOptions');
  ok('D6  the browser’s merge was found', !!merge);
  if (merge) {
    const cat = { groups: [{ group: 'The quote', fields: [{ key: 'investor', type: 'text' }, { key: 'price', type: 'number' }] }] };
    const merged = merge({ ...cat, optionsByField: { investor: [{ v: 'Verus', label: 'Verus' }] } });
    eq('D7  a published list lands on its field',
      merged.groups[0].fields[0].options, [{ v: 'Verus', label: 'Verus' }]);
    eq('D8  …and touches no other field', 'options' in merged.groups[0].fields[1], false);
    eq('D9  ⛔ AN UNREADABLE ROSTER LEAVES THE FIELD EXACTLY AS IT WAS — a plain text box',
      'options' in merge({ ...cat, optionsByField: {} }).groups[0].fields[0], false);
    eq('D10 …and an EMPTY list is not a list either, because on screen it reads "we have no investors"',
      'options' in merge({ ...cat, optionsByField: { investor: [] } }).groups[0].fields[0], false);
    eq('D11 a catalogue with no map at all is returned untouched',
      merge(cat) === cat, true);
  }
  ok('D12 and the screen SAYS SO when the roster could not be read, where the picker would have been',
    /cat\.optionsProblem &&/.test(CODE) && /The investor list could not be read/.test(SRC));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nE. A LIST IS A SHORTCUT ON A TEXT FIELD, AND THE SET OF ANSWERS ON AN ENUM');
// ═══════════════════════════════════════════════════════════════════════════
ok('E1  a TEXT field with a list gets the combo — pick one OR type your own',
  /field\.type === 'text'[\s\S]{0,120}<ValueCombo/.test(CODE));
ok('E2  …which is an input, so a name the roster has never seen is still typeable',
  /data-value-combo/.test(CODE) && /<input style=\{input\} value=\{value \?\? ''\}/.test(CODE));
ok('E3  …and it says so, rather than looking like a closed list',
  /Not on the list\? Type it/.test(SRC));
ok('E4  an ENUM keeps its dropdown, where an invented value would be refused on save anyway',
  /<option value="">Pick one…<\/option>/.test(CODE));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nF. DARK TEXT ON WHITE');
// ═══════════════════════════════════════════════════════════════════════════
/* `--ink*` is a LIGHT paper colour in this palette — the names lie — so one used
   as a text colour renders white on white. The rule is "not in this file at
   all", because a mutation putting the token in a constant walks past a check
   that only reads `color:` lines. */
{
  const hits = [...CODE.matchAll(/var\(\s*--ink/g)];
  ok('F1  the builder uses no --ink* token at all', hits.length === 0, `${hits.length} found`);
  ok('F2  …and the pickers paint their own surfaces explicitly',
    /background: '#FFFFFF'/.test(CODE) && /color: INK/.test(CODE));
}

const total = pass + failures.length;
console.log(`\n${failures.length ? 'FAILED' : 'ALL PASSED'} (${pass} passed, ${failures.length} failed of ${total})`);
if (failures.length) { for (const f of failures) console.log(`  · ${f}`); }
process.exit(failures.length ? 1 : 0);

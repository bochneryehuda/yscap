'use strict';
// =============================================================================
// EVERY FIELD TYPE THE SERVER DECLARES HAS A BRANCH ON THE LONG-TERM SCREEN
// =============================================================================
//
// THE DEFECT THIS EXISTS FOR, found 2026-08-31 while walking the owner's own
// list. `src/lib/conditions/answers.js` — the SHARED plan every governed
// condition is answered through — has always described the REO/mortgages
// "say which property this mortgage is secured by" field as
//
//     { key: 'address', label: 'Property address', type: 'address' }
//
// and `LtConditionAnswer.jsx` had a branch for `choice` and nothing else, so
// `address` fell through to a plain `<input>`. Nothing errored, nothing logged,
// and the screen looked finished — it just quietly did not do the thing the
// sharing directive asks for by name in item 8: *"The address lookup (the
// existing autocomplete) inside LT conditions."* The box had been built
// (`AddressField.jsx`) and wired to the term sheet only.
//
// THE CLASS is a renderer that ends in an `else` — a server that names a type
// the screen does not know about degrades to "near enough" instead of saying
// so. The only way to catch it is to DERIVE the list of types from the source
// of truth and require every one to be accounted for, which is what this does.
// A `type: 'date'` added to a plan next year fails this test until somebody
// decides what a date should look like, rather than shipping as a text box.
//
// PURE. No database, no network, no DOM. In `npm test`.
// =============================================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { stripComments } = require('./lib/strip-comments');
const { WAYS } = require('../src/lib/conditions/answers');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

const SCREEN = path.join(__dirname, '..', 'app-v2', 'src', 'longterm', 'LtConditionAnswer.jsx');
// COMMENTS ARE STRIPPED FIRST. This file's own explanation necessarily names
// the types it is checking for, and so does the screen's — a guard that read
// comments would pass on the strength of prose and then be "fixed" by deleting
// the prose. Only the code counts.
const screen = stripComments(fs.readFileSync(SCREEN, 'utf8'));

// A PLAIN TEXT BOX IS THE RIGHT ANSWER FOR THESE, and that is a decision rather
// than an omission — `money` additionally gets a decimal keypad and a 0.00
// placeholder, which the renderer does off the same type. Anything NOT on this
// list must be branched explicitly.
const PLAIN_INPUT_IS_RIGHT = new Set(['text', 'money']);

// ---------------------------------------------------------------------------
// A. Every declared type is accounted for
// ---------------------------------------------------------------------------
const declared = new Set();
for (const plan of Object.values(WAYS)) {
  for (const way of (plan.ways || [])) {
    for (const f of (way.fields || []).concat(way.conditionalFields || [])) {
      if (f && f.type) declared.add(String(f.type));
    }
  }
}

ok(declared.size > 0, 'the shared plans declare at least one field type — otherwise this proves nothing');
ok(declared.has('address'),
  'the plans still declare an address field — the defect this guards was that nothing rendered it');

for (const type of [...declared].sort()) {
  if (PLAIN_INPUT_IS_RIGHT.has(type)) {
    ok(true, `"${type}" is deliberately a plain text box`);
    continue;
  }
  ok(screen.includes(`field.type === '${type}'`),
    `the long-term answer screen has an explicit branch for "${type}" — a server-declared type `
    + 'must never fall through to a plain input by accident. If a plain box really is right for '
    + 'it, say so by adding it to PLAIN_INPUT_IS_RIGHT rather than leaving it to the else.');
}

// ---------------------------------------------------------------------------
// B. The address branch is the LOOK-UP, not just any branch
// ---------------------------------------------------------------------------
//
// Branching on the type is necessary and not sufficient: a branch that rendered
// another plain input would satisfy section A and still not be the autocomplete
// the owner asked for. So the component itself is named.
ok(/import\s+AddressField\s+from\s+'\.\/AddressField\.jsx'/.test(screen),
  'the screen imports the long-term address box');
ok(/field\.type === 'address' \?[\s\S]{0,900}?<AddressField/.test(screen),
  'and the address branch renders <AddressField> — the look-up, not a second plain box');

// It must be given the value and a way to report a change, or it is decoration.
const addrBlock = (screen.match(/field\.type === 'address' \?[\s\S]{0,900}?\/>/) || [''])[0];
ok(/value=/.test(addrBlock), 'the address box is given the answer already recorded');
ok(/onChange=\{onChange\}/.test(addrBlock),
  'and reports a change straight back — AddressField emits the one-line string this '
  + 'renderer already stores, so nothing downstream had to change');

// ---------------------------------------------------------------------------
// C. It is a convenience, never a gate
// ---------------------------------------------------------------------------
//
// The whole reason this could be wired without touching the server is that the
// look-up degrades to an ordinary text box on any provider failure. If that
// ever stopped being true, a rural parcel or a bad minute at the vendor would
// stop somebody answering a condition — so it is pinned here too.
const BOX = path.join(__dirname, '..', 'app-v2', 'src', 'longterm', 'AddressField.jsx');
const box = stripComments(fs.readFileSync(BOX, 'utf8'));
ok(/<input/.test(box), 'the address box is an ordinary input underneath');
ok(/catch/.test(box), 'and swallows a provider failure rather than surfacing it as an error');

console.log(`test-lt-condition-field-types-pure: ${n} checks passed `
  + `(${declared.size} declared field type(s): ${[...declared].sort().join(', ')})`);

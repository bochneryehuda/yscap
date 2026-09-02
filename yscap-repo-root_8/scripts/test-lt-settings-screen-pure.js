'use strict';
/**
 * LT test — the settings SCREEN carries no list of settings.
 *
 * The whole design of that screen rests on one property: it is drawn from the
 * server's own description, so adding a setting server-side makes it appear with no
 * front-end change. The moment somebody hard-codes a key — to give one field a nicer
 * editor, to hide one they think is dangerous — there are two lists of "what can be
 * configured", and the day they disagree the front end is the half people trust.
 *
 * A property like that is invisible in a screenshot and cannot be caught by a
 * renderer test: a screen with fifty-five settings drawn generically and one drawn by
 * name looks exactly like a screen with fifty-six. So it is asserted against the
 * SOURCE, against the real declaration list, and it fails the build.
 *
 * Pure — no database, no browser.
 */

const fs = require('fs');
const path = require('path');
const decl = require('../src/longterm/settings/encompass-settings');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// A guard that reads its own explanatory comments would fail on the very code that
// explains it, and would then be "fixed" by deleting the explanation.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

console.log('the long-term settings screen');

const screen = read('app-v2/src/longterm/LtSettings.jsx');
const code = stripComments(screen);
const keys = Object.keys(decl.defaults());

check(keys.length >= 56, `there are ${keys.length} declared settings to keep out of the screen`);

const named = keys.filter((k) => code.includes(`'${k}'`) || code.includes(`"${k}"`) || code.includes(`\`${k}\``));
check(named.length === 0,
  `not one declared setting key is named in the screen${named.length ? ` — found ${named.join(', ')}` : ''}`);

// The editors are chosen from the declaration's TYPE. Every type a declaration
// actually uses must be handled — a type nobody thought about falls through to the
// read-only JSON view, which is honest but means a whole group silently becomes
// uneditable the day it is introduced.
const types = [...new Set(keys.map((k) => (decl.definition(k) || {}).type).filter(Boolean))];
const handled = types.filter((t) => code.includes(`'${t}'`));
check(handled.length === types.length,
  `every declared type is decided on by name (${handled.length}/${types.length}: ${types.join(', ')})`);

// `map` is the one that is deliberately read-only, and it must STAY deliberate: a
// generic editor over the milestone→stage map would let one mistyped brace destroy
// the ladder every screen on this side reads.
check(!/case 'map'|=== 'map'/.test(code) || /return null/.test(code),
  'a map is not given a generic editor');

/* THE COMBINED ENGINE'S OWN SETTINGS SCREEN IS HELD TO THE SAME RULE.
   It is not the generic screen — it draws per-investor rows and, since
   2026-09-02, the form that ADDS an investor — so it could reach for a settings
   key directly. It must not: every one of those settings has a door of its own
   that validates what is sent (the investors-added-by-hand map is refused whole
   if a name would collide or a client-safe name would be blanked out by the
   investor-name block), and a screen writing the key straight into the store
   would walk past all of it. */
{
  const combined = stripComments(read('app-v2/src/longterm/LtCombinedSettings.jsx'));
  const namedThere = keys.filter((k) => combined.includes(`'${k}'`) || combined.includes(`"${k}"`) || combined.includes(`\`${k}\``));
  check(namedThere.length === 0,
    `the combined engine's settings screen names no declared setting key either${namedThere.length ? ` — found ${namedThere.join(', ')}` : ''}`);
  check(/ltApi\.combinedSaveCustomInvestors\(/.test(combined) && !/saveSettings\(/.test(combined),
    '…and the investors it adds go through their own door, which is where they are checked');
}

console.log('\nthe screen talks only to Long-Term');

const api = read('app-v2/src/longterm/api.js');
const paths = [...api.matchAll(/lt\('([^']+)'\)/g)].map((m) => m[1]);
check(paths.length > 0 && paths.every((p) => p.startsWith('/')),
  `every path is relative to the /api/lt root (${paths.length})`);
check(!/from '\.\.\/lib\//.test(screen) && !/from '\.\.\/components\//.test(screen),
  'the screen imports no RTL module — Long-Term starts at zero, and the gate agrees');

console.log('\nthe "Yours" box can actually be edited');

// OWNER-REPORTED 2026-08-23: "the one where I can set my own is all preset. I can't fix
// anything over there." The personal section's editor branched only on 'enum' and
// 'boolean', so a NUMBER — which is what all three personal compensation figures are —
// fell through to a read-only display. The only personal setting before them was an
// enum, so the gap had never been visible. These pins are what stop it coming back.
check(/editorFor\(s\) === 'number' \|\| editorFor\(s\) === 'string'/.test(code)
  && /MineValueEditor/.test(code),
  'a personal NUMBER (the comp figures) gets a real editor — never the read-only fallback');
check(/draft\.trim\(\) === ''/.test(code),
  "an EMPTY personal box saves nothing — Number('') is 0, and a blank saved as a zero comp is the silent-zero trap");
check(/saveMine/.test(code) && /ltApi\.saveMySettings/.test(code),
  'the personal editor saves through the /mine door, where the floor and the bounds refuse in plain words');

console.log('\nthe words for an option live with the setting');

const product = decl.definition('ui.defaultProduct');
check(product && product.optionLabels && product.optionLabels.rtl && product.optionLabels.long_term,
  'the one setting an ordinary person sees carries its own English, so the screen never invents wording');
check(Object.keys(product.optionLabels).every((k) => product.options.includes(k)),
  '…and every label names an option that actually exists');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

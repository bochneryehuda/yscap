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

console.log('\nthe screen talks only to Long-Term');

const api = read('app-v2/src/longterm/api.js');
const paths = [...api.matchAll(/lt\('([^']+)'\)/g)].map((m) => m[1]);
check(paths.length > 0 && paths.every((p) => p.startsWith('/')),
  `every path is relative to the /api/lt root (${paths.length})`);
check(!/from '\.\.\/lib\//.test(screen) && !/from '\.\.\/components\//.test(screen),
  'the screen imports no RTL module — Long-Term starts at zero, and the gate agrees');

console.log('\nthe words for an option live with the setting');

const product = decl.definition('ui.defaultProduct');
check(product && product.optionLabels && product.optionLabels.rtl && product.optionLabels.long_term,
  'the one setting an ordinary person sees carries its own English, so the screen never invents wording');
check(Object.keys(product.optionLabels).every((k) => product.options.includes(k)),
  '…and every label names an option that actually exists');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

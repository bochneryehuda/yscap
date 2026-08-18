'use strict';
/**
 * LT test — EVERY SETTING IS EITHER READ BY SOMETHING OR HONEST ABOUT NOT BEING.
 *
 * The settings registry makes a promise to a buyer: *"nothing about how WE do
 * things may be hard-coded — every tenant-specific choice is a setting."* Forty of
 * its declarations were written ahead of the code that would read them, so the
 * settings screen offered forty knobs that changed NOTHING and said so nowhere.
 *
 * A silent knob is worse than a missing one, because it is believed: somebody
 * renames an eFolder status, saves, sees no error, and assumes the system now
 * knows. So the rule is the same one the 1003 mirror got: WIRED, or DECLARED
 * UNWIRED WITH A REASON — and this build fails on anything else, in BOTH
 * directions (a stale `notWired` on a setting somebody has since wired is its own
 * lie, and the one most likely to be left behind).
 *
 * "Read by something" is COMPUTED, never a hand-kept list: the key is searched for
 * across the whole long-term build. A list of readers would go stale the first
 * time somebody wired one, which is exactly the failure this exists to catch.
 */

const fs = require('fs');
const path = require('path');

const decl = require('../src/longterm/settings/encompass-settings');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const ROOT = path.join(__dirname, '..');

/** Every .js/.jsx file of the long-term build, minus the registry itself. */
function ltSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(js|jsx|mjs)$/.test(e.name)) continue;
      out.push(full);
    }
  };
  walk(path.join(ROOT, 'src', 'longterm'));
  walk(path.join(ROOT, 'app-v2', 'src', 'longterm'));
  return out.filter((f) => !f.endsWith(path.join('settings', 'encompass-settings.js')));
}

const SOURCES = ltSources().map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));

// A parser that finds nothing would make every check below pass on anything.
check(SOURCES.length > 40, `the long-term build was found and read (${SOURCES.length} files)`);

const all = decl.SETTINGS;
check(Array.isArray(all) && all.length > 50,
  `every setting was read off the registry (${all.length})`);

console.log('\nevery setting is read by something, or says it is not');

const silent = [];
const stale = [];
const wired = [];
for (const s of all) {
  // A source merely MENTIONING the key is enough: the point is whether anything
  // consults it, and a mention that does nothing would be its own bug.
  const readers = SOURCES.filter((f) => f.text.includes(`'${s.key}'`) || f.text.includes(`"${s.key}"`));
  if (readers.length) {
    wired.push(s.key);
    if (s.notWired) stale.push(`${s.key} (read by ${readers[0].file})`);
  } else if (!s.notWired) {
    silent.push(s.key);
  }
}

check(silent.length === 0,
  `THE ONE THAT MATTERS: no setting changes nothing in silence${silent.length ? ` — ${silent.length} do: ${silent.join(', ')}` : ''}`);
check(stale.length === 0,
  `…and none still claims to be unwired after somebody wired it${stale.length ? ` — ${stale.join('; ')}` : ''}`);
check(wired.length > 15,
  `and the ones that ARE live are genuinely live (${wired.length} of ${all.length}) — a check that found none wired would pass this file trivially`);

console.log('\nevery "not in use yet" is a reason, not a shrug');

for (const s of all.filter((x) => x.notWired)) {
  if (typeof s.notWired !== 'string' || s.notWired.length < 60) {
    failures += 1;
    console.error(`  FAIL ${s.key}: "not in use yet" with nothing after it`);
  }
  if (!/not in use yet/i.test(s.notWired)) {
    failures += 1;
    console.error(`  FAIL ${s.key}: does not SAY it is not in use, in words a person reads`);
  }
}
check(true,
  'each one states plainly that it is not in use and why — "the field is pinned to what we measured", "the rule is settled in code", "that part is not built", "the connection lives with the credentials" are four different answers, and the difference decides whether a buyer waits or asks');

// ── The screen has to SAY it ───────────────────────────────────────────────
console.log('\nand the settings screen never shows a live-looking knob that is not');

const store = fs.readFileSync(path.join(ROOT, 'src/longterm/settings/store.js'), 'utf8');
check(/\.\.\.s,/.test(store),
  'the server describes each setting by spreading its whole declaration, so `notWired` reaches the screen with no route change — a screen fed a hand-picked field list would have needed one, and would silently drop the next field somebody adds');

const ui = fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtSettings.jsx'), 'utf8');
check(/notWired/.test(ui),
  'THE ONE THAT MATTERS: the screen reads it — a knob that changes nothing must not look like one that does');
check(/const editable = !notWired &&/.test(ui),
  '…and the control itself is not editable, so nobody types a value that goes nowhere and believes it took');
check(/Nothing reads this yet/.test(ui),
  '…while the value is still SHOWN — it is what a buyer would be changing once it is wired, so hiding it would answer a different question than the one they asked');

// ── The one that was WIRED rather than excused ─────────────────────────────
console.log('\nthe eFolder vocabulary is the tenant\'s, not ours');

const readSrc = fs.readFileSync(path.join(ROOT, 'src/longterm/conditions/read.js'), 'utf8');
check(/efolder\.receivedStatuses/.test(readSrc),
  'the words that mean "we have it" come from the SETTING — they are eFolder statuses, which are tenant configuration, and a list written into our code puts a document that HAS arrived onto a chase list the day a buyer renames one');
check(/doneStatusesFrom/.test(readSrc) && /DONE_STATUSES/.test(readSrc),
  '…falling back to the four words measured across 20,569 live documents when nobody has configured any, so a settings outage never reports the whole book as outstanding');

const condRoute = fs.readFileSync(path.join(ROOT, 'src/longterm/routes/conditions.js'), 'utf8');
const pipeRoute = fs.readFileSync(path.join(ROOT, 'src/longterm/routes/pipeline.js'), 'utf8');
check(/centerForLoan\(loan\.id, \{ audience: 'internal', settings \}\)/.test(condRoute)
  && /documentsForLoan\(loan\.id, \{ audience: 'internal', settings \}\)/.test(condRoute),
  'and the file screen hands the reader the settings it already loaded');
check(/outstandingForLoans\([\s\S]{0,90}\{ settings \}\)/.test(pipeRoute),
  '…as does the pipeline\'s own count, so the list and the file can never disagree about which words mean done');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

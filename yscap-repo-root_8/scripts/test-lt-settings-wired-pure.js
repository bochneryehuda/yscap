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

/* ⛔ A RETIRED SETTING IS NOT AN UNWIRED ONE, AND THE TENSE IS THE WHOLE POINT.
   The four original reasons all say "not in use YET" — declared ahead of the code
   that will read them, so a buyer who changes one is waiting for a release. A
   RETIRED setting was read, the reader is gone, and no release is coming: telling
   that buyer "yet" is a promise nobody intends to keep. So the two are held to
   DIFFERENT sentences, and neither may borrow the other's — a genuinely unbuilt
   setting must not describe itself as retired to look settled, and a retired one
   must not say "yet" to look temporary.

   ⛔ AND A RETIRED REASON MUST NAME WHAT RUNS INSTEAD. That is the entire reason
   the row is kept rather than deleted: a buyer who stored a value is owed an
   answer to "then what governs this now?", and a row that only says "retired"
   sends them hunting for a setting that no longer exists — the silent
   disappearance keeping the row was meant to avoid. This is the one assertion
   here that STRENGTHENS the rule rather than widening it. */
for (const s of all.filter((x) => x.notWired)) {
  if (typeof s.notWired !== 'string' || s.notWired.length < 60) {
    failures += 1;
    console.error(`  FAIL ${s.key}: "not in use yet" with nothing after it`);
  }
  if (s.retired) {
    if (!/no longer in use/i.test(s.notWired)) {
      failures += 1;
      console.error(`  FAIL ${s.key}: retired, but does not SAY it is no longer in use — "not in use yet" promises a wiring that is never coming`);
    }
    if (!/\binstead\b|\bnow runs on\b|\bthat is the one to change\b/i.test(s.notWired)) {
      failures += 1;
      console.error(`  FAIL ${s.key}: retired without naming what governs this now — the reason the row is kept at all`);
    }
  } else if (!/not in use yet/i.test(s.notWired)) {
    failures += 1;
    console.error(`  FAIL ${s.key}: does not SAY it is not in use, in words a person reads`);
  }
}
check(true,
  'each one states plainly that it is not in use and why — "the field is pinned to what we measured", "the rule is settled in code", "that part is not built", "the connection lives with the credentials" and "retired, here is what runs instead" are five different answers, and the difference decides whether a buyer waits, asks, or changes something else');

// A `retired` flag with no reason behind it would read on the screen as an
// ordinary unwired knob and lose the one sentence that makes the row worth keeping.
check(all.filter((x) => x.retired).every((x) => x.notWired),
  '…and a setting marked retired always carries the reason, so the screen can never show it as a knob that merely has not been wired yet');

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
check(/setting\.retired \? 'Retired/.test(ui),
  '…and a RETIRED knob says so rather than "yet" — a buyer told "yet" about a setting nothing will ever read again waits for a release that is not coming');
/* The screen states the lead sentence in TWO places — the chip and the callout's
   bold opener — and each strips it from the body so it is not said twice. Both
   have to key on the same flag: the callout was the one that read "Not in use
   yet. No longer in use…", contradicting itself in its own first line, and no
   grep for the chip would have found it. */
check(/setting\.retired \? 'No longer in use\.' : 'Not in use yet\.'/.test(ui),
  '…and the callout\'s own lead sentence agrees with it, so the reason never opens by contradicting itself');
check(/\(Not in use yet\|No longer in use\)/.test(ui),
  '…and both openers are stripped from the body beneath, so neither wording is printed twice');

// ── The one that was WIRED rather than excused ─────────────────────────────
console.log('\nthe eFolder vocabulary is the tenant\'s, not ours');

const readSrc = fs.readFileSync(path.join(ROOT, 'src/longterm/conditions/read.js'), 'utf8');
check(/efolder\.receivedStatuses/.test(readSrc),
  'the words that mean "we have it" come from the SETTING — they are eFolder statuses, which are tenant configuration, and a list written into our code puts a document that HAS arrived onto a chase list the day a buyer renames one');
check(/doneStatusesFrom/.test(readSrc) && /DONE_STATUSES/.test(readSrc),
  '…falling back to the four words measured across 20,569 live documents when nobody has configured any, so a settings outage never reports the whole book as outstanding');

const condRoute = fs.readFileSync(path.join(ROOT, 'src/longterm/routes/conditions.js'), 'utf8');
const pipeRoute = fs.readFileSync(path.join(ROOT, 'src/longterm/routes/pipeline.js'), 'utf8');
// NOTE ON WHAT THIS PROVES, AND WHAT IT DOES NOT. The two checks below match the
// SOURCE TEXT of a call. That is enough to catch somebody quietly dropping the
// settings argument, and it is the reason they are here — but it is not evidence
// the line runs. It could not have been: `settings` was a free variable in that
// handler for the whole life of the file, so the call this regex was happily
// matching threw a ReferenceError on every request and answered 500. The doors
// themselves are now driven by test-lt-conditions-doors-db.js, with the feature
// switched ON, which is the only thing that could have noticed.
check(/centerForLoan\(loan\.id, \{ audience: 'internal', settings \}\)/.test(condRoute)
  && /documentsForLoan\(loan\.id, \{ audience: 'internal', settings \}\)/.test(condRoute),
  'and the file screen hands the reader the settings it already loaded');
check(/outstandingForLoans\([\s\S]{0,90}\{ settings \}\)/.test(pipeRoute),
  '…as does the pipeline\'s own count, so the list and the file can never disagree about which words mean done');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

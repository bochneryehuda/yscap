'use strict';
/**
 * EVERY REFUSAL ON BOTH APPRAISAL DESKS SAYS SOMETHING A PERSON CAN ACT ON.
 *
 * Two independent failures made this a rule rather than a habit, and the ninth audit
 * found that the commit which claimed to have swept for it had written no sweep:
 *
 *   • A refusal carrying only `error` reaches the screen as the CODE. `api.js` sets
 *     `e.message` to `data.error` when there is no `message`, and both panels fall back
 *     to it — so a failed order showed the owner the literal word `order_failed`, and a
 *     switched-off connection showed the word `disabled`.
 *   • A refusal carrying the EXCEPTION'S text shows the owner "AMC CreateAppraisal ->
 *     502", "fetch failed", or a Postgres code. That is written for us. The detail
 *     belongs in the log, which is where it goes.
 *
 * So this reads the SOURCE of both desks and asserts the two properties over every
 * refusal in it. A source sweep is the right shape here: these branches fire on a
 * vendor outage, a rotated credential, a switched-off gate — states a unit test cannot
 * conjure at every one of ~40 sites, and the failure is a missing key, which is exactly
 * what reading the source can see.
 *
 * PURE: reads files, runs nothing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL: ' + m); } };

const ROOT = path.join(__dirname, '..');
const FILES = [
  'src/amc/order-service.js', 'src/amc/documents.js', 'src/amc/comments.js',
  'src/amc/revisions.js', 'src/amc/rov.js', 'src/amc/session.js',
  'src/class/order-service.js', 'src/class/messages.js', 'src/class/callbacks.js',
  'src/routes/amc.js', 'src/routes/class.js',
].filter((f) => fs.existsSync(path.join(ROOT, f)));

ok(FILES.length >= 9, 'both desks are actually being read (a shrunken list would pass vacuously)');

// ---------------------------------------------------------------------------
// (1) A REFUSAL CARRIES PLAIN WORDS, NOT ONLY A CODE.
// ---------------------------------------------------------------------------
// `{ ok: false, error: 'x' }` and `res.status(4xx|5xx).json({ error: 'x' })` must carry
// a `message` within the same object literal. The scan walks braces from the `{` so a
// multi-line literal is read whole rather than line by line.
function objectAt(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(openIdx, i + 1); }
  }
  return src.slice(openIdx);
}

const missingWords = [];
const rawText = [];
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  // ---- service-shaped refusals: { ok: false, error: … }
  const re = /\{\s*(?:\/\/[^\n]*\n\s*)*ok:\s*false\s*,/g;
  let m;
  while ((m = re.exec(src))) {
    const obj = objectAt(src, m.index);
    if (!/\berror\s*:/.test(obj)) continue;         // not a refusal, just a false flag
    if (!/\bmessage\s*:/.test(obj)) missingWords.push(`${rel}:${lineOf(m.index)}`);
  }

  // ---- route-shaped refusals: res.status(4xx|5xx).json({ … })
  const re2 = /res\s*\.\s*status\(\s*(\d{3})\s*\)\s*\.\s*json\(\s*\{/g;
  while ((m = re2.exec(src))) {
    const code = Number(m[1]);
    if (code < 400) continue;
    const obj = objectAt(src, src.indexOf('{', m.index + m[0].length - 1));
    // 403/404 are their own complete answer — "forbidden" / "not found" is already the
    // whole story and a sentence would add nothing. Everything else must speak.
    if (code === 403 || code === 404) continue;
    if (/\bmessage\s*:/.test(obj)) continue;
    // A refusal that relays an object built elsewhere (`.json(out)`) is that object's
    // responsibility, and the service sweep above covers it.
    if (/^\{\s*\}$/.test(obj.replace(/\s+/g, ' ').trim())) continue;
    missingWords.push(`${rel}:${lineOf(m.index)}`);
  }

  // ---- (2) and none of them pastes the exception's own text into `message`.
  const re3 = /message\s*:\s*([^,\n}]+)/g;
  while ((m = re3.exec(src))) {
    const val = m[1];
    if (/String\(\s*e(?:rr)?\b/.test(val) || /\be(?:rr)?\.message\b/.test(val)
        || /\be\.stack\b/.test(val) || /\be\.body\b/.test(val)) {
      rawText.push(`${rel}:${lineOf(m.index)} — ${val.trim()}`);
    }
  }
}

if (missingWords.length) console.error('  no plain words: ' + missingWords.join(', '));
ok(missingWords.length === 0, 'every refusal on both desks carries a plain sentence, not only a code');

if (rawText.length) console.error('  raw exception text: ' + rawText.join('\n    '));
ok(rawText.length === 0, 'and none of them shows the exception’s own text to the person at the desk');

// ---------------------------------------------------------------------------
// (3) THE SENTENCES ARE ORDINARY ENGLISH.
// ---------------------------------------------------------------------------
// The owner is not a developer. A message that names an HTTP status, an endpoint, an
// env var or a snake_case code is not a sentence — it is the log leaking again.
const JARGON = /\b(?:HTTP|[45]\d\d\b|endpoint|payload|null|undefined|NaN|stack trace|ECONN\w*|ETIMEDOUT|[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/;
const shouty = [];
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const re = /message:\s*'([^']{4,})'/g;
  let m;
  while ((m = re.exec(src))) {
    if (JARGON.test(m[1])) shouty.push(`${rel} — ${m[1].slice(0, 70)}`);
  }
}
if (shouty.length) console.error('  jargon: ' + shouty.join('\n    '));
ok(shouty.length === 0, 'and every one of them reads as ordinary English');

// A guard on the guard: the scan must be able to SEE a bad refusal, or it proves
// nothing. Feed it the two shapes this file exists to catch.
{
  const bad = "return { ok: false, error: 'nope' };";
  const idx = bad.indexOf('{');
  ok(!/\bmessage\s*:/.test(objectAt(bad, idx)), 'the scan recognises a refusal with no plain words');
  ok(/String\(\s*e\b/.test("message: String(e.message || e)"),
     'and recognises the exception’s own text being pasted in');
}

console.log(`\n[test-appraisal-refusals-speak-pure] ${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'an appraisal refusal does not speak plainly');

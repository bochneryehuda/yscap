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
  // The shared wording itself. It was NOT on this list, so the one module whose entire
  // job is what a person reads was the one module nothing checked.
  'src/lib/appraisal-messages.js',
].filter((f) => fs.existsSync(path.join(ROOT, f)));

ok(FILES.length >= 10, 'both desks are actually being read (a shrunken list would pass vacuously)');

// ---------------------------------------------------------------------------
// (1) A REFUSAL CARRIES PLAIN WORDS, NOT ONLY A CODE.
// ---------------------------------------------------------------------------
// `{ ok: false, error: 'x' }` and `res.status(4xx|5xx).json({ error: 'x' })` must carry
// a `message` within the same object literal. The scan walks braces from the `{` so a
// multi-line literal is read whole rather than line by line.
// The walker must SKIP strings, template literals and comments. Counting braces inside
// them means one `{` in a message string runs the slice to end-of-file — and a slice
// that long contains a `message:` somewhere, so every site after it passes silently.
// A scan that fails open is worse than no scan.
function objectAt(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) break; i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(openIdx, i + 1); }
  }
  return null;   // unbalanced — report nothing rather than a runaway slice
}

// WHAT COUNTS AS "the exception's own text". `String(e)`, `e.message`, `e.stack`,
// `e.body` — the transport's words, written for us.
//
// `err.description` is DELIBERATELY NOT on this list and must not be: that is the
// APPRAISAL COMPANY's own refusal ("Loan number already exists"), which tells the person
// exactly what to do, and `nackMessage` exists to frame and bound it. So the test is
// `String(` followed by the exception ITSELF — closed, combined with `&&`/`||`, or
// reduced to one of its transport fields — never `String(err.<anything>)`, which was the
// first cut and flagged all three of the shared wording helpers.
const RAW_EXPR = /String\(\s*\(?\s*e(?:rr)?\s*(?:\)|&&|\|\||\.(?:message|stack|body)\b)/;
const RAW_FIELD = /\be(?:rr)?\.(?:message|stack|body)\b/;
const looksRaw = (expr) => RAW_EXPR.test(expr) || RAW_FIELD.test(expr);

const missingWords = [];
const rawText = [];
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  // ---- service-shaped refusals: { ok: false, error: … }
  // `ok: false` ANYWHERE in the literal, not only as its first key — `{ error:'x',
  // ok:false }` and `{ ok: false }` with no trailing comma both used to be invisible.
  const re = /\bok:\s*false\b/g;
  let m;
  while ((m = re.exec(src))) {
    // Walk back to the `{` that opens the literal this key sits in, and keep walking
    // until one of them actually CONTAINS the key — a nested literal opens later.
    let open = src.lastIndexOf('{', m.index);
    let obj = null;
    while (open > 0) {
      const cand = objectAt(src, open);
      if (cand && open + cand.length > m.index) { obj = cand; break; }
      open = src.lastIndexOf('{', open - 1);
    }
    if (!obj) continue;
    // ONLY A LITERAL THAT IS RETURNED IS AN ANSWER TO SOMEBODY. `journal(db, {…, ok:
    // false, error: <raw> })` writes an AUDIT ROW — that one is written for us, the raw
    // text belongs in it, and demanding a plain sentence there would be demanding the
    // opposite of the rule. So the object must sit directly after `return`.
    if (!/\breturn\s*$/.test(src.slice(Math.max(0, open - 12), open))) continue;
    if (!/\berror\s*:/.test(obj)) continue;         // not a refusal, just a false flag
    if (!/\bmessage\s*:/.test(obj)) missingWords.push(`${rel}:${lineOf(m.index)}`);
  }

  // ---- route-shaped refusals: res.status(4xx|5xx).json({ … })
  // ANY status expression, not only a literal — `res.status(vendorFailStatus(out))`
  // is exactly the shape used for the vendor refusals, and it was never scanned.
  const re2 = /res\s*\.\s*status\(\s*([^)]*)\s*\)\s*\.\s*json\(\s*\{/g;
  while ((m = re2.exec(src))) {
    // A computed status is assumed to be a refusal (that is what those helpers are
    // for); a literal under 400 is a success and is not one.
    const lit = /^\d{3}$/.test(m[1].trim()) ? Number(m[1].trim()) : null;
    const code = lit == null ? 500 : lit;
    if (code < 400) continue;
    const obj = objectAt(src, m.index + m[0].length - 1);
    if (!obj) continue;
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
    if (looksRaw(val)) rawText.push(`${rel}:${lineOf(m.index)} — ${val.trim()}`);
  }

  // ---- (2b) …AND NEITHER DOES A SENTENCE THAT IS RETURNED DIRECTLY.
  // `session.signInMessage` builds the desk's wording and RETURNS it as a string — no
  // `message:` key anywhere — so every check above walked straight past it while it
  // ended with `' (' + raw.slice(0, 160) + ')'`, putting "AMC DoLogin failed: HTTP 502"
  // on the appraisal desk. A wording helper is exactly where this is most likely to
  // hide, because it is the one place holding the exception ON PURPOSE.
  //
  // The exception arrives under a local name (`const raw = String(e.message || '')`),
  // so the assignment is traced first — only the simple one-line form, which is the
  // shape these helpers use, and the limit is stated rather than pretended away.
  const tainted = new Set();
  const re4 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;
  while ((m = re4.exec(src))) {
    const val = m[2];
    if (looksRaw(val)) tainted.add(m[1]);
  }
  // …then every `return` whose expression BUILDS a sentence (it contains a quoted
  // string) and also mentions one of those names, or the exception itself.
  const re5 = /\breturn\s+([^;]*);/g;
  while ((m = re5.exec(src))) {
    const expr = m[1];
    if (!/['"`]/.test(expr)) continue;                 // not a sentence being built
    const names = [...tainted].filter((nm) => new RegExp(`\\b${nm}\\b`).test(expr));
    const direct = looksRaw(expr);
    if (names.length || direct) {
      rawText.push(`${rel}:${lineOf(m.index)} — returned sentence built from `
        + (names.length ? names.join(', ') : 'the exception') );
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
// nothing. Feed it every shape this file exists to catch — and, just as important, the
// shapes it must NOT catch, because a check that flags the vendor's own refusal would
// be pushing the wording back towards saying nothing.
{
  const bad = "return { ok: false, error: 'nope' };";
  const idx = bad.indexOf('{');
  ok(!/\bmessage\s*:/.test(objectAt(bad, idx)), 'the scan recognises a refusal with no plain words');
  ok(looksRaw('message: String(e.message || e)'),
     'and recognises the exception’s own text being pasted in');
  ok(looksRaw("const raw = String((e && e.message) || '')"),
     'including where it is parked in a local first');
  ok(looksRaw('String(e)') && looksRaw('String(err)') && looksRaw('e.stack') && looksRaw('err.body'),
     'in each of the forms the transport hands it over in');
  // THE OTHER DIRECTION. `err.description` is the appraisal company's own words and is
  // meant to be shown; `e.code` is a machine code that a helper legitimately branches
  // on. Flagging either would make this check argue against the rule it enforces.
  ok(!looksRaw('String(err.description).trim()'), 'and never mistakes the vendor’s own refusal for it');
  ok(!looksRaw('e && e.code ? String(e.code) : \'\''), 'nor the code a helper branches on');
}

console.log(`\n[test-appraisal-refusals-speak-pure] ${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'an appraisal refusal does not speak plainly');

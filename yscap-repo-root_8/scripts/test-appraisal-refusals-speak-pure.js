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

// COMMENTS ARE NOT CODE, and this file is written in a codebase that quotes the code it
// removed. `src/amc/session.js` already carries the literal `' (' + raw.slice(0,160) +
// ')'` in a comment explaining why it is gone; add the word `return` anywhere near it
// and the scan below would fail on CORRECT source — and the natural "fix" for that is to
// weaken the scan, which is how a guard stops guarding. `objectAt` has skipped comments
// since it was written; the taint scan must too.
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      out += '\n'; i = nl; continue;                    // keep the line count honest
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) break;
      out += src.slice(i, end + 2).replace(/[^\n]/g, ' ');
      i = end + 1; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += c;
      for (i++; i < src.length; i++) {
        out += src[i];
        if (src[i] === '\\') { i++; out += src[i]; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    out += c;
  }
  return out;
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
  // so the assignment is traced first — declarations, plain assignments, `+=` and
  // destructures.
  //
  // WHAT IT STILL CANNOT SEE, said plainly rather than pretended away: taint carried
  // through a FUNCTION CALL — `function detailOf(e){ return String(e.message); }` and
  // then `return 'Could not sign in (' + detailOf(e) + ')'`. Following that needs real
  // dataflow, which a regex sweep is the wrong tool for. That hole is covered instead by
  // the RUNTIME check at the end of this file, which calls the actual wording helpers
  // with actual exceptions and reads what comes out — the only check that does not care
  // how the sentence was assembled.
  const code = stripComments(src);
  // `stripComments` preserves every newline, so a line number in the stripped copy is
  // the same line number in the file — but the INDEX is not, so it must be measured
  // against the copy the match came from.
  const lineOfCode = (idx) => code.slice(0, idx).split('\n').length;

  // ---- (2d) …AND THE ONE EXEMPTED COLUMN NEVER LEAVES THE SERVER.
  // `process_error` is allowed to hold the exception's own text because it is an
  // internal record. That is only true while nothing SELECTs it into an answer, and it
  // was not true: the orders route shipped it to the browser in `events`. So the
  // exemption is paid for here rather than trusted.
  if (/\bprocess_error\b/.test(code) && /\bres\s*\.\s*json\b/.test(code)) {
    const selects = code.match(/SELECT[\s\S]{0,400}?FROM/g) || [];
    for (const sel of selects) {
      if (/\bprocess_error\b/.test(sel) && !/process_error\s+IS\s+(?:NOT\s+)?NULL/i.test(sel)) {
        rawText.push(`${rel} — process_error is selected into a response`);
      }
    }
  }

  // ---- (2c) …AND NEITHER DOES A COLUMN.
  // The two checks above walk `return` statements, so a DATABASE WRITE of the
  // exception's own text was invisible to them — and a stored column is the WORST place
  // for it, because it is permanent and one render away from a screen. Four such writes
  // were found and fixed by hand across three audits, and a fifth
  // (`class_callback_events.process_error`, selected straight into an API response) was
  // still there afterwards, in a file this sweep was already reading and passing.
  //
  // So the test is turned around: a raw expression is a DEFECT unless it sits somewhere
  // raw text belongs. Those places are named — the journal, the log, a rethrow — and the
  // list is short on purpose. Anything else, including a place nobody has thought of
  // yet, is reported.
  const ALLOWED = /\b(?:journal|console\.(?:warn|error|log|info)|throw|logger|debug)\b/;
  const RAW_ANY = /String\(\s*\(?\s*e(?:rr)?\s*(?:\)|&&|\|\||\.(?:message|stack|body)\b)|\be(?:rr)?\.(?:message|stack|body)\b/g;
  while ((m = RAW_ANY.exec(code))) {
    // The statement this sits in: back to the previous `;`, bounded so a long function
    // body cannot reach an unrelated `journal(` and excuse this one.
    //
    // A `{` is NOT a boundary, and using one was wrong: `console.warn(\`… ${row.id} …\`,
    // String(e.message))` opens a brace inside its own template literal, so the scan
    // started INSIDE the string and never saw the `console.warn` it was looking for —
    // reporting a log line, which is the one place raw text belongs.
    const from = Math.max(code.lastIndexOf(';', m.index), m.index - 400, 0);
    const stmt = code.slice(from, Math.min(code.length, m.index + 200));
    if (ALLOWED.test(stmt)) continue;
    // `class_callback_events.process_error` is the ONE column that deliberately keeps
    // the exception's own text, and it earns that the same way `journal` does: it is a
    // record of a delivery WE could not interpret, there is no journal for callbacks,
    // and triaging a dead-lettered one needs the real words. What made it a defect was
    // that the orders route SELECTed it straight into an API response — so the guarantee
    // is not "this column is fine", it is "this column never leaves the server", and
    // that is asserted separately below rather than assumed here.
    if (/process_error/.test(stmt)) continue;
    // A wording helper reading the exception in order to CLASSIFY it is the point of
    // this module — what matters is where the result goes, which (2)/(2b) judge.
    if (/\b(?:code|status|retryable|description)\b/.test(stmt) && !/\.query\(/.test(stmt)) continue;
    rawText.push(`${rel}:${lineOfCode(m.index)} — the exception's own text outside the log/journal`);
  }

  const tainted = new Set();
  // A DECLARATION (`const raw = …`), a PLAIN ASSIGNMENT (`s = …`, `s += …`) and a
  // DESTRUCTURE (`const { message } = e`) all park the exception under a local name, and
  // only the first was traced — so two one-line refactors of the same defect walked past.
  const re4 = /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*\+?=\s*([^;\n]*)/g;
  while ((m = re4.exec(code))) {
    if (looksRaw(m[2])) tainted.add(m[1]);
  }
  const re4b = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*\(?\s*e(?:rr)?\b/g;
  while ((m = re4b.exec(code))) {
    for (const part of m[1].split(',')) {
      const nm = part.split(':').pop().trim().replace(/^\.\.\./, '');
      if (/^(?:message|stack|body)$/.test(part.split(':')[0].trim()) && nm) tainted.add(nm);
    }
  }
  // …then every `return` whose expression BUILDS a sentence (it contains a quoted
  // string) and also mentions one of those names, or the exception itself.
  const re5 = /\breturn\s+([^;]*);/g;
  while ((m = re5.exec(code))) {
    const expr = m[1];
    // A bare `return s;` where `s` was BUILT into a sentence elsewhere carries no quote
    // of its own, so the "is a sentence being built here" test walks past it — and
    // `let s = 'Could not sign in'; s += ' (' + e.message + ')'; return s;` is one
    // refactor away from the defect this exists to catch.
    const bare = expr.trim();
    if (!/['"`]/.test(expr) && !(/^[A-Za-z_$][\w$]*$/.test(bare) && tainted.has(bare))) continue;
    const names = [...tainted].filter((nm) => new RegExp(`\\b${nm}\\b`).test(expr));
    const direct = looksRaw(expr);
    if (names.length || direct) {
      rawText.push(`${rel}:${lineOfCode(m.index)} — returned sentence built from `
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

// ---------------------------------------------------------------------------
// (4) AND THE WORDING HELPERS ARE ACTUALLY RUN.
// ---------------------------------------------------------------------------
// Everything above reads source, which can only ever catch the shapes it knows. This
// calls the two helpers that decide what a person is told, hands them the exceptions
// the transports really throw, and reads the sentences. It does not care how they were
// assembled — which is exactly the gap a source scan leaves.
{
  const msgs = require(path.join(ROOT, 'src/lib/appraisal-messages'));
  const session = require(path.join(ROOT, 'src/amc/session'));
  const mk = (o) => Object.assign(new Error(o.m || 'x'), o);
  // Every failure shape the two transports throw, taken from their own throw sites.
  const THROWN = [
    mk({ m: 'Class addNote refused: Loan number already exists', status: 200, retryable: false, body: { success: false } }),
    mk({ m: 'Class order failed: HTTP 400', status: 400, retryable: false }),
    mk({ m: 'Class order failed: HTTP 502', status: 502, retryable: true }),
    mk({ m: 'Class token failed: HTTP 401', status: 401, retryable: false }),
    mk({ m: 'Class notes failed after 3 attempts' }),
    mk({ m: 'class: the UAD version of this order is unknown, so it cannot be read', code: 'class_version_unknown' }),
    mk({ m: 'CLASS_OUTBOUND_DISABLED: refusing POST /orders — writes are gated off', code: 'CLASS_OUTBOUND_DISABLED' }),
    mk({ m: 'AMC_DISABLED', code: 'AMC_DISABLED' }),
    mk({ m: 'AMC_OUTBOUND_DISABLED', code: 'AMC_OUTBOUND_DISABLED' }),
    mk({ m: 'AMC_CLIENT_ID / AMC_CLIENT_SECRET are not set', code: 'AMC_NOT_CONFIGURED' }),
    mk({ m: 'AMC_LOGIN_ACCOUNT / AMC_LOGIN_PASSWORD / AMC_SUBDOMAIN are not all set', code: 'AMC_NOT_CONFIGURED' }),
    mk({ m: 'AMC DoLogin failed: Invalid credentials', code: 'AMC_LOGIN_REJECTED', description: 'Invalid credentials' }),
    mk({ m: 'AMC GetToken returned no accessToken' }),
    mk({ m: 'connect ECONNREFUSED 10.0.0.4:443' }),
    mk({ m: 'fetch failed' }),
    mk({ m: 'The operation was aborted.' }),
    mk({ m: 'Unexpected token < in JSON at position 0' }),
    mk({ m: 'terminating connection due to administrator command' }),
  ];
  // A sentence must not carry any of the thrown text, nor any of the jargon the third
  // check bans. The VENDOR's own `description` is the one thing that may travel, and
  // only the login-rejected case carries one.
  const leaked = [];
  const badEnglish = [];
  const say = (where, out, e) => {
    const t = String(out);
    // No fragment of the exception's own message, taken four words at a time — enough
    // to catch a paste, short enough not to trip on an ordinary word.
    // FOUR WORDS AT A TIME catches a paste without tripping on an ordinary word — but it
    // never runs at all on a message SHORTER than four words, and "fetch failed",
    // "socket hang up" and "Connection terminated unexpectedly" are exactly that. Those
    // are matched whole. `code` and `body` are checked too: both are the transport's own
    // and both were pasted into a screen at some point in this integration's history.
    const sources = [String(e.message || ''), String(e.code || ''),
      e.body == null ? '' : JSON.stringify(e.body)];
    for (const raw of sources) {
      if (!raw) continue;
      const words = raw.split(/\s+/);
      if (words.length < 4) {
        if (raw.length > 5 && t.includes(raw)) { leaked.push(`${where}: ${t}`); return; }
        continue;
      }
      for (let i = 0; i + 3 < words.length; i++) {
        const frag = words.slice(i, i + 4).join(' ');
        if (frag.length > 8 && t.includes(frag)) { leaked.push(`${where}: ${t}`); return; }
      }
    }
    if (JARGON.test(t)) badEnglish.push(`${where}: ${t}`);
  };
  for (const e of THROWN) {
    say('storedFailNote', msgs.storedFailNote(e), e);
    say('sendFailMessage', msgs.sendFailMessage(e, 'The order'), e);
    say('signInMessage', session.signInMessage(e), e);
    say('signInMessage+draft', session.signInMessage(e, { savedDraft: true }), e);
  }
  if (leaked.length) console.error('  leaked exception text: ' + leaked.join('\n    '));
  ok(leaked.length === 0, 'no wording helper hands back any part of the exception it was given');
  if (badEnglish.length) console.error('  jargon at runtime: ' + badEnglish.join('\n    '));
  ok(badEnglish.length === 0, 'and every sentence they build reads as ordinary English');

  // WHICH SENTENCE COMES OUT IS THE WHOLE POINT, and nothing was asserting it. Three
  // separate mutations that gutted the routing — deleting the refusal branch, the
  // credential branch and the switched-off branch — each passed the entire suite,
  // because a leak scan only ever asks what a sentence does NOT contain. The states are
  // pinned by name, keyed on the thing a person would do next.
  const STATE = (t) => (/switched off/.test(t) ? 'switch'
    : /not set up yet/.test(t) ? 'unconfigured'
      : /on our side stopped this/.test(t) ? 'never-left'
        : /did not accept our login/.test(t) ? 'credential'
          : /would not accept it/.test(t) ? 'refused'
            : /could not be reached/.test(t) ? 'unreachable' : 'UNKNOWN');
  const EXPECT = [
    ['refused',      mk({ m: 'Class addNote refused: Loan number already exists', status: 200, retryable: false })],
    ['refused',      mk({ m: 'Class order failed: HTTP 400', status: 400, retryable: false })],
    ['refused',      mk({ m: 'AMC postdocuments -> 403', status: 403, retryable: false })],
    ['unreachable',  mk({ m: 'Class order failed: HTTP 502', status: 502, retryable: true })],
    ['credential',   mk({ m: 'Class token failed: HTTP 401', status: 401, retryable: false })],
    ['credential',   mk({ m: 'AMC DoLogin failed', code: 'AMC_LOGIN_REJECTED', description: 'Invalid credentials' })],
    ['switch',       mk({ m: 'x', code: 'CLASS_OUTBOUND_DISABLED' })],
    ['switch',       mk({ m: 'x', code: 'AMC_DISABLED' })],
    ['unconfigured', mk({ m: 'x', code: 'AMC_NOT_CONFIGURED' })],
    ['unconfigured', mk({ m: 'x', code: 'CLASS_NOT_CONFIGURED' })],
    ['never-left',   mk({ m: 'class: the UAD version of this order is unknown', code: 'class_version_unknown' })],
    ['unreachable',  mk({ m: 'fetch failed' })],
    ['unreachable',  mk({ m: 'connect ECONNREFUSED 10.0.0.4:443' })],
    ['unreachable',  mk({ m: 'boom' })],
  ];
  const wrongState = [];
  for (const [want, e] of EXPECT) {
    const got = STATE(msgs.storedFailNote(e));
    if (got !== want) wrongState.push(`${e.code || e.status || e.message}: expected ${want}, got ${got}`);
  }
  if (wrongState.length) console.error('  wrong state: ' + wrongState.join('\n    '));
  ok(wrongState.length === 0, 'a stored note names the state the reader has to act on');
  // A 403 is the vendor answering about what we SENT, not about our login — the status
  // on both desks is the business call's, never the token call's.
  ok(STATE(msgs.storedFailNote(mk({ m: 'x', status: 403, retryable: false }))) === 'refused',
     'and a 403 is their refusal, not a credential problem');

  // THE VENDOR'S OWN REFUSAL DOES TRAVEL, and it must not run into our next sentence.
  const rejected = mk({ m: 'AMC DoLogin failed: Invalid credentials', code: 'AMC_LOGIN_REJECTED', description: 'Invalid credentials' });
  const said = session.signInMessage(rejected);
  ok(said.includes('Invalid credentials'), 'the appraisal company’s own reason is still shown');
  ok(!/Invalid credentials [A-Z]/.test(said), 'and their words are closed off before ours begin');

  // A helper must never answer with nothing — an empty note on a row reads as success.
  // EVERY exception, not the first — a `break` here left four of the five branches
  // unexercised, and blanking the fallback to '' passed the whole suite. An empty note
  // renders as no note at all, which reads as delivered.
  let empty = 0;
  for (const e of THROWN) if (String(msgs.storedFailNote(e)).trim().length < 12) empty++;
  ok(empty === 0, 'every stored note is a real sentence, on every branch');
}

console.log(`\n[test-appraisal-refusals-speak-pure] ${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'an appraisal refusal does not speak plainly');

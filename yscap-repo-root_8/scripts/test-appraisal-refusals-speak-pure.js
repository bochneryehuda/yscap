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
// BOTH DESKS MEANS BOTH DESKS. A hand-written list claimed "both desks are actually
// being read" and then asserted its own LENGTH — a count that was satisfied while
// src/amc/sync.js, src/amc/client.js, src/amc/preflight.js, src/amc/lookups.js,
// src/class/client.js and src/class/poller.js were never opened, two of them holding raw
// exception text in returned structures. A count is not coverage; the set is.
const listJs = (rel) => {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => rel + '/' + f).sort();
};
const FILES = [
  ...listJs('src/amc'),
  ...listJs('src/class'),
  'src/routes/amc.js', 'src/routes/class.js',
  // The shared wording itself. It was NOT on the old list, so the one module whose whole
  // job is what a person reads was the one module nothing checked.
  'src/lib/appraisal-messages.js',
].filter((f) => fs.existsSync(path.join(ROOT, f)));

// Named modules that must be in the set, so a refactor moving one out of these folders
// fails here rather than silently dropping out of every check in this file.
for (const must of ['src/amc/sync.js', 'src/amc/session.js', 'src/amc/documents.js',
  'src/amc/order-service.js', 'src/class/messages.js', 'src/class/callbacks.js',
  'src/routes/class.js', 'src/lib/appraisal-messages.js']) {
  ok(FILES.includes(must), must + ' is read by this sweep');
}

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
// Is a `/` here the start of a REGEX, or a division/comment? It is a regex only when
// what precedes it cannot end an expression.
function inRegexPosition(sofar) {
  const t = sofar.replace(/\s+$/, '');
  if (!t) return true;
  const last = t[t.length - 1];
  if (/[)\]}\w$'"`]/.test(last)) return false;   // a value ended — this is division
  return true;
}

function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    // A REGEX LITERAL IS NOT A COMMENT. `/^https?:\/\//` ends in `\` `/` `/`, which read
    // as the start of a line comment and threw away the rest of the line — or, with no
    // trailing newline, the rest of the FILE. Every check downstream then scanned a
    // truncated copy and passed. A `/` that follows a value cannot start a regex, so the
    // previous non-space character decides which it is.
    if (c === '/' && src[i + 1] === '/' && !inRegexPosition(out)) {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      out += '\n'; i = nl; continue;                    // keep the line count honest
    }
    if (c === '/' && inRegexPosition(out)) {             // a regex literal — copied whole
      out += c;
      for (i++; i < src.length; i++) {
        out += src[i];
        if (src[i] === '\\') { i++; out += src[i]; continue; }
        if (src[i] === '[') { for (i++; i < src.length && src[i] !== ']'; i++) { out += src[i]; if (src[i] === '\\') { i++; out += src[i]; } } out += src[i]; continue; }
        if (src[i] === '/') break;
        if (src[i] === '\n') break;                      // not a regex after all
      }
      continue;
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

  // ---- (2c) …AND NEITHER DOES ANYTHING THE RAW TEXT IS HANDED TO.
  // The checks above walk `return` statements, so a DATABASE WRITE of the exception's
  // own text was invisible to them — and a stored column is the worst place for it,
  // being permanent and one render from a screen. Five such writes were found by hand
  // across three audits.
  //
  // WHAT THIS ASKS IS WHERE THE TEXT GOES, not whether it is touched. A wording helper
  // reading `e.message` to CLASSIFY it is the entire point of these modules, and
  // `err.body = body` is the transport building its own error. What is never acceptable
  // is handing those words to a SINK — a column, a response, a structure that is
  // returned. The first cut asked the opposite question and needed four exemptions,
  // every one of which turned out fail-open: `throw` excused a store-then-rethrow, a
  // fixed forward window swallowed the NEXT statement's console.warn, naming
  // `process_error` excused a raw value bound to a different column, and naming
  // `status` excused `res.status(502).json({ detail: String(e.message) })` — the literal
  // defect this file exists to prevent. Naming the sinks is narrower AND stricter.
  // The list is deliberately generous — a sink nobody thought of is the whole failure
  // mode here. `Object.assign` and `JSON.stringify` were both used to smuggle raw text
  // past the first version of this check.
  const SINK_BASE = /\.query\(|\.json\(|\.send\(|\.push\(|\bres\s*\.|sendMail|notify\w*\(|Object\.assign\(|JSON\.stringify\(/;
  // …AND A LOCAL HELPER THAT WRITES IS A SINK TOO. Moving the `db.query` one function
  // along — `function store(id, t) { return db.query(…, [id, t]); }` and then
  // `store(id, String(e.message))` — hid the same defect behind one indirection. So a
  // function in this file whose own body reaches a sink makes CALLS to it sinks. One
  // level deep, which is what these modules actually do; a deeper chain is beyond a
  // regex sweep, and the runtime check at the end of this file is what covers that.
  const writers = new Set();
  const FN_RE = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\())/g;
  let fm;
  while ((fm = FN_RE.exec(code))) {
    const nm = fm[1] || fm[2];
    if (!nm) continue;
    if (SINK_BASE.test(code.slice(fm.index, fm.index + 600))) writers.add(nm);
  }
  const SINK = writers.size
    ? new RegExp(SINK_BASE.source + '|\\b(?:' + [...writers].join('|') + ')\\s*\\(')
    : SINK_BASE;
  // THE EXCEPTION IS WHATEVER THE `catch` CALLED IT. Hard-coding `e|err` let
  // `catch (netErr)` — which src/class/client.js already uses — escape every check here,
  // and so did `ex`, `error` and `e2`. Taking the names from the file's own `catch`
  // bindings also stops an arrow parameter that happens to be called `e` (`.map((e) =>
  // String(e).trim())`, over EMAIL ADDRESSES) from reading as an exception.
  const caught = new Set();
  const CATCH_RE = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let cm;
  while ((cm = CATCH_RE.exec(code))) caught.add(cm[1]);
  if (caught.size) {
    const names = [...caught].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const RAW_ANY = new RegExp(
      'String\\(\\s*\\(?\\s*(?:' + names + ')\\s*(?:\\)|&&|\\|\\||\\.(?:message|stack|body)\\b)'
      + '|\\b(?:' + names + ')\\.(?:message|stack|body)\\b', 'g');
    while ((m = RAW_ANY.exec(code))) {
      // The statement, bounded at BOTH ends. A fixed forward window swallowed the next
      // statement, and store-then-log is how both desks are written.
      const from = Math.max(code.lastIndexOf(';', m.index), m.index - 400, 0);
      const semi = code.indexOf(';', m.index);
      const to = semi === -1 ? Math.min(code.length, m.index + 200)
        : Math.min(semi + 1, m.index + 400);
      const stmt = code.slice(from, to);
      if (!SINK.test(stmt)) continue;                       // read, not handed on
      if (/\b(?:console\.(?:warn|error|log|info)|journal|logger)\b/.test(stmt)) continue;
      // THE PREFLIGHT SCREEN IS THE ONE PLACE THE VENDOR'S OWN BODY IS THE ANSWER: its
      // whole purpose is telling an egress proxy's plain-text refusal from a rejected
      // credential, which look identical without it, and it is an admin diagnostic, not
      // a desk. Narrow on purpose — the `raw:` key, in that file only.
      // …and the same two carve-outs (2b) makes, for the same reason: the `raw:` key,
      // and `classify()` itself, which reads the body BECAUSE that is the diagnosis.
      // Scoped to that function, never to the whole file.
      if (rel === 'src/amc/preflight.js') {
        if (/\braw\s*:/.test(stmt)) continue;
        const fnAt = code.lastIndexOf('function classify', m.index);
        const nextFn = fnAt === -1 ? -1 : code.indexOf('\nfunction ', fnAt + 1);
        if (fnAt !== -1 && (nextFn === -1 || m.index < nextFn)) continue;
      }
      // …and the ONE column that deliberately keeps the raw words, for the same reason:
      // `class_callback_events.process_error` records a delivery WE could not interpret,
      // there is no journal for callbacks, and triaging a dead-lettered one needs the
      // real text. The exemption is for the value BOUND TO that column, never for any
      // statement that merely mentions it — `SET process_error=$2, public_note=$3` with
      // the raw text in `$3` must still be reported. And the guarantee is not "this
      // column is fine", it is "this column never leaves the server", which (2d) asserts.
      // …and the exemption is for THIS OCCURRENCE, not for every raw expression in a
      // statement that happens to bind one of them to that column. Binding the SAME
      // expression to `$2` AND to a public `$3` was waved through by the looser form —
      // the very case the paragraph above promises is still reported.
      if (/process_error\s*=\s*\$2\b/.test(stmt)) {
        const argsAt = stmt.lastIndexOf('[');
        if (argsAt !== -1) {
          const parts = stmt.slice(argsAt + 1).split(',');
          // Where does `$2`'s argument sit, in offsets within `stmt`?
          let at = argsAt + 1;
          const spans = parts.map((piece) => { const from = at; at += piece.length + 1; return [from, at - 1]; });
          const here = m.index - from;   // the match, relative to the statement slice
          if (spans[1] && here >= spans[1][0] && here < spans[1][1]) continue;
        }
      }
      rawText.push(rel + ':' + lineOfCode(m.index) + " — the exception's own text handed to a sink");
    }
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
    // `src/amc/preflight.js` `classify()` is the API-health screen's whole purpose: it
    // turns a transport failure into a diagnosis for an ADMIN, and telling an egress
    // proxy's plain-text refusal from a rejected credential needs the body. It is never
    // a desk. SCOPED TO THAT FUNCTION, not to the file — exempting the whole file let a
    // desk-facing wording helper live there untouched, exempt purely by address.
    if (rel === 'src/amc/preflight.js') {
      const fnAt = code.lastIndexOf('function classify', m.index);
      const nextFn = fnAt === -1 ? -1 : code.indexOf('\nfunction ', fnAt + 1);
      if (fnAt !== -1 && (nextFn === -1 || m.index < nextFn)) continue;
    }
    const bare = expr.trim();
    const bareTainted = /^[A-Za-z_$][\w$]*$/.test(bare) && tainted.has(bare);
    if (!/['"`]/.test(expr) && !bareTainted) continue;
    // `return s;` where `s` was BUILT elsewhere carries no quote and no `+` of its own,
    // so the "concatenated in" test below cannot see it. It is already known tainted.
    if (bareTainted) {
      rawText.push(`${rel}:${lineOfCode(m.index)} — returned sentence built from ${bare}`);
      continue;
    }
    // BUILT INTO the sentence, OR HANDED OVER AS A FIELD. A helper that TESTS the
    // exception's text to choose a branch (`return msg ? 'Could not be reached.' : '…'`)
    // leaks nothing. But requiring CONCATENATION was fail-open on the shape both desks
    // actually use: `return { ok:false, message:'The order could not be sent.', detail:
    // raw }` puts the exception's own words on a returned object under a key check (2)
    // never looks at — and `AmcAppraisalPanel` renders `skipped[].detail` on screen. So a
    // tainted name assigned to ANY property, or passed as an argument, counts too.
    const names = [...tainted].filter((nm) => new RegExp(
      `\\+\\s*${nm}\\b`                          // concatenated in
      + `|\\b${nm}\\s*(?:\\.[\\w$]+\\s*\\([^)]*\\)\\s*)?\\+`  // …or concatenating
      + `|\\$\\{[^}]*\\b${nm}\\b`                 // interpolated
      + `|[\\w$]+\\s*:\\s*${nm}\\s*[,}]`          // handed over as a property value
      + `|[(,]\\s*${nm}\\s*[,)]`                  // …or as an argument
    ).test(expr));
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
  // SINGLE-QUOTED **AND** TEMPLATE messages. Reading only `'…'` left the shape these
  // routes already use — `` message: `… ${status} …` `` — never scanned at all.
  for (const re of [/message:\s*'([^']{4,})'/g, /message:\s*`([^`]{4,})`/g,
    /message:\s*"([^"]{4,})"/g]) {
    let m;
    while ((m = re.exec(src))) {
      if (JARGON.test(m[1])) shouty.push(`${rel} — ${m[1].slice(0, 70)}`);
    }
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

  // THE VERB MATCHES WHAT WAS ASKED FOR — the rule this file's own subject module states
  // in its header, and the one nothing was checking. A status poll and a document read
  // SEND NOTHING, so "Not sent" on the row a person reads later is a plain untruth;
  // reverting the `reading` option, or applying it always, both passed the whole suite.
  {
    const nack = { description: 'Order not found' };
    const read = msgs.storedNackNote(nack, 'a status check on the order', { reading: true });
    const sent = msgs.storedNackNote(nack, 'the order');
    ok(/^Could not be read —/.test(read), 'a read that was refused does not claim anything was sent');
    ok(/^Not sent —/.test(sent), 'and a send that was refused says so');
    ok(read !== sent, 'the two are not the same sentence');
    ok(read.includes('Order not found') && sent.includes('Order not found'),
       'and both still carry the appraisal company’s own reason');
    ok(/refusal/.test(msgs.storedNackNote({}, 'the order')),
       'a refusal with no reason given still reads as a refusal');
    // The VERB on the live message too — the same rule, the other helper.
    const e = Object.assign(new Error('x'), { code: 'AMC_DISABLED' });
    ok(/could not be fetched/.test(msgs.sendFailMessage(e, 'The replies', { reading: true })),
       'a button that only reads never reports that nothing was sent');
    ok(/could not be sent/.test(msgs.sendFailMessage(e, 'The order')),
       'and a button that sends says sent');
  }
  // EVERY STORED SENTENCE OPENS THE WAY THE PANELS EXPECT. `ClassAppraisalPanel` tells
  // our wording from a legacy raw exception by its opening; a helper that grows a new
  // one without the panel knowing has its sentence thrown away and replaced.
  {
    const OPENINGS = /^(?:TEST MODE —|Not sent —|Could not be read —|Sent —)/;
    const samples = [
      msgs.storedFailNote(Object.assign(new Error('x'), { code: 'AMC_DISABLED' })),
      msgs.storedFailNote(new Error('fetch failed')),
      msgs.storedNackNote({ description: 'd' }, 'the order'),
      msgs.storedNackNote({ description: 'd' }, 'a read', { reading: true }),
      msgs.SENT_NOT_RECORDED,
      msgs.TEST_MODE_PREFIX + 'written here.',
    ];
    const stray = samples.filter((t) => !OPENINGS.test(t));
    if (stray.length) console.error('  unknown opening: ' + stray.join('\n    '));
    ok(stray.length === 0, 'every stored sentence opens with one the panels recognise');
  }

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

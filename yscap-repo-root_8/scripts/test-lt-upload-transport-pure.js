'use strict';
/**
 * test-lt-upload-transport-pure — the LONG-TERM Condition Center's upload
 * transport, guarded at the SOURCE, because no database test can see it.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `test-lt-condition-docs-doors-db` section F proves the SERVER takes a document
 * bigger than any JSON body can carry. That is half the feature. The other half
 * is whether the SCREEN posts to that door — and a server-side suite cannot tell
 * the difference between a screen that streams a 26 MB appraisal and one that
 * still base64s it into a JSON body and is refused at 25 MB, because it never
 * runs the screen. That gap is exactly how the short-term side shipped this same
 * fix on ONE of three screens (see `test-upload-limits-pure` section 6, whose
 * guard "named ONE screen, so it read as 'the client streams the file' while
 * being true of a third of them"). This is the long-term row of that table.
 *
 * NAMED `test-lt-…` DELIBERATELY. The separation gate reads a suite's FILENAME
 * as its product identity (`isLtTest`), and this one names long-term files. It
 * is also why the assertions live here rather than as a fourth row in the
 * short-term suite: an RTL-named test reaching into `app-v2/src/longterm/**`
 * would be the crossing the gate exists to catch.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 *
 *  1. THE SCREEN hands the File over and never base64s the document first.
 *  2. THE CLIENT posts to the `…/binary` sibling, sends the raw file as the
 *     body, and puts the metadata in `x-upload-meta` as base64 of UTF-8 — not
 *     `btoa` of a DOM string, which throws above U+00FF, so a filename with an
 *     accent or a Hebrew letter would fail the upload before it started.
 *  3. THE ROUTER registers BOTH doors against ONE handler. Two handlers is two
 *     places the scope check, the visibility rule and the condition lookup can
 *     drift, and the one that drifts is the one that shows the wrong document.
 *  4. NOTHING RE-INLINES A CEILING. The number lives in `config`, read through
 *     `upload-stream`; a literal `25` here is how the two doors start
 *     disagreeing with the server about what they will accept.
 *
 * Pure: reads source text, needs no database and no network.
 * Run: node scripts/test-lt-upload-transport-pure.js
 */

const fs = require('fs');
const path = require('path');
/* THE SHARED STRIPPER, and using it here is not tidiness — it is the difference
   between this guard reading the file and reading a hole where the file was.
   The obvious two-line idiom (`replace(/\/\*[\s\S]*?\*\//g,'')` then the line
   comments) removes BLOCK comments FIRST, so it cannot tell that a `/*` it
   found is inside a LINE comment. `app-v2/src/longterm/api.js` — one of the
   three files this suite reads — opens with `// Every call goes to /api/lt/*`,
   and that stray `/*` makes the naive idiom swallow everything down to the next
   genuine `*` `/`: measured, 86 of its 156 live lines, its own `export const
   ltApi = {` among them. THE DIRECTION THAT MATTERS is that a "must not appear"
   assertion PASSES over a file the stripper ate — a guard reporting a clean bill
   of health on a file it never read, invisible in a green build. */
const { stripComments } = require('./lib/strip-comments.js');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/* COMMENTS STRIPPED BEFORE EVERY "must not appear" ASSERTION. The change that
   removed the base64 reader necessarily NAMES it in the note explaining why, and
   a guard that read comments would fail on its own explanation and then get
   "fixed" by deleting the explanation. */
const noComments = (src) => stripComments(src);

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

console.log('1. the screen hands over the File, and never base64s the document first');
{
  const src = read('app-v2/src/longterm/LtFileConditions.jsx');
  const bare = noComments(src);
  ok(/ltApi\.conditionDocUpload\(loanId, conditionId, \{\s*\n\s*file,/.test(src),
    'the long-term conditions screen hands `conditionDocUpload` the File itself');
  ok(!/dataBase64/.test(bare),
    'the screen has no base64 upload path left at all');
  /* THE READER IS GONE, not merely unused. A `readAsBase64` still sitting there
     is the next person's obvious tool when they add a second upload control. */
  ok(!/readAsBase64/.test(bare),
    'the base64 reader it used to call is removed, not left lying about');
  ok(/say\(conditionId, e\.message/.test(src),
    'a refusal is recorded against the condition it was for, not at the top of the page');
}

console.log('\n2. the client posts to the streamed door, in the short-term side’s own shape');
{
  /* COMMENTS STRIPPED FIRST, and this is not a formality — it was a REAL
     tautology caught by mutation. The note above `conditionDocUpload` explains
     what the streamed door is and therefore SPELLS `…/documents/binary`; the
     first cut of this assertion matched that sentence, so pointing the actual
     call back at the JSON door left the guard green. A guard that reads comments
     is guarding the prose. */
  const api = noComments(read('app-v2/src/longterm/api.js'));
  /* And scoped to the DEFINITION, not to a window after the name: the entry is
     asserted on its own text so a neighbouring route's path can never satisfy
     it — the same discipline the fee roster applies to its three spreadsheet
     columns, and for the same reason. */
  const upEntry = (api.match(/conditionDocUpload:[\s\S]*?\n\s{2}\w+:/) || [''])[0];
  ok(/\/documents\/binary`/.test(upEntry),
    'conditionDocUpload targets the `…/documents/binary` sibling');
  ok(upEntry.length > 40 && upEntry.length < 700,
    '…and that assertion really is reading conditionDocUpload’s own definition');

  const http = read('app-v2/src/longterm/http.js');
  const bare = noComments(http);
  ok(/const \{ file, \.\.\.meta \} = body \|\| \{\};/.test(http),
    'ltUpload takes the File out of the body and sends the rest as metadata');
  ok(/xhr\.setRequestHeader\('Content-Type', 'application\/octet-stream'\)/.test(http),
    'the body is the document itself — application/octet-stream');
  ok(!/JSON\.stringify\(meta\)/.test(bare) && !/setRequestHeader\('Content-Type', 'application\/json'\)/.test(bare),
    'nothing JSON-encodes the upload body any more');
  ok(/setRequestHeader\('x-upload-meta'/.test(http),
    'the metadata rides in `x-upload-meta`, which is what `metaFromHeaders` reads');
  /* base64 OF UTF-8, NOT `btoa` OF A DOM STRING. `btoa` throws on any character
     above U+00FF, so a filename carrying an accent or a Hebrew letter would fail
     the upload before a single byte left the browser. */
  ok(/new TextEncoder\(\)\.encode\(json\)/.test(http) && /String\.fromCharCode/.test(http),
    'the header is base64 of UTF-8 bytes, so a non-Latin filename cannot break it');
  ok(/xhr\.upload/.test(http),
    'XMLHttpRequest is kept — `fetch` cannot report how much of a body has been sent, so nothing could draw a percentage');
  /* THE PROGRESS BAR MEASURES THE FILE. Sizing it on a JSON string was right when
     the body WAS a JSON string; leaving that in place would show a percentage of
     the wrong number on every upload. */
  ok(/Number\.isFinite\(file\.size\)/.test(http),
    'the progress bar is sized on the File’s own bytes');
}

console.log('\n3. ONE handler behind BOTH doors');
{
  const src = read('src/longterm/routes/condition-center.js');
  ok(/const uploadConditionDoc = async \(req, res\)/.test(src),
    'the upload handler is named once');
  const json = /router\.post\('\/loans\/:loanId\/conditions\/:conditionId\/documents', uploadConditionDoc\)/.test(src);
  const bin = /router\.post\('\/loans\/:loanId\/conditions\/:conditionId\/documents\/binary',[\s\S]{0,120}?binaryIntake, uploadConditionDoc\)/.test(src);
  ok(json, 'the JSON door is registered against it');
  ok(bin, 'the streamed door is registered against the SAME handler, behind `binaryIntake`');
  /* A COPIED HANDLER IS THE FAILURE THIS GUARDS. Not a style point: an upload
     handler resolves the loan, scopes its target into the STATEMENT, and decides
     the document's visibility. A second copy of one of those is a second answer
     to all three.

     THIS USED TO COUNT TO ONE, AND THAT WAS THE RULE STATED TOO NARROWLY — it
     went red the moment a genuinely DIFFERENT upload arrived (a document filed
     onto the borrower's company rather than onto this loan's condition), which
     duplicates none of those three answers because its target is not a
     condition at all. A guard that fails on correct work gets "fixed" by
     loosening it, so it asserts the actual property instead: every upload in
     this router is a NAMED handler shared by both its doors, and the number of
     calls to the shared upload service equals the number of those handlers — so
     no handler files twice, and no door carries an inline copy of one.

     Counting `scopedCondition` callers would still be wrong: nine routes
     legitimately scope a condition and only one of them files a document. */
  const handlers = [...src.matchAll(/const (upload[A-Za-z0-9_]*) = async \(req, res\)/g)]
    .map((m) => m[1]);
  ok(handlers.length >= 1, `every upload is a NAMED handler (found ${handlers.join(', ') || 'none'})`);

  /* AND THE COUNT WAS STILL A PROXY — this is the SECOND time it has gone red on
     correct work, for the same reason its own note above describes.

     Two entity doors (a named slot, and the generic one) now share ONE filer,
     `fileEntityDocument`, because filing an entity document applies the verified
     lock, scopes the company and syncs BOTH products' conditions — three answers
     that must not exist twice. So there are three handlers and two call sites, and
     an equality reads that as a missing one when it is the opposite: it is one
     copy fewer than the rule was written expecting.

     So it asserts what the note actually says, in three parts a duplicate cannot
     satisfy: every handler REACHES the shared upload service (directly, or through
     one shared filer that calls it); no handler reaches it more than once; and the
     number of call sites never EXCEEDS the number of handlers, so a door that
     grows its own inline copy still fails. Sharing a filer is allowed; carrying a
     second copy of one is not. */
  const SERVICE = /condUpload\.uploadConditionDocument\(/g;

  /* WHICH FUNCTION EACH CALL SITE SITS IN. Every top-level declaration in this
     router is found, then a call site is attributed to the nearest one above it.
     Counting call sites against a ceiling is not enough on its own: a stray
     second filer that nobody calls slips under any ceiling the handlers set, and
     it is a second copy of the filing rule sitting in the file waiting to be
     wired up. Attribution answers the question directly — WHO files. */
  const decls = [...src.matchAll(/\n(?:const ([A-Za-z0-9_]+) = async \(|(?:async )?function ([A-Za-z0-9_]+)\()/g)]
    .map((m) => ({ name: m[1] || m[2], at: m.index }))
    .sort((a, b) => a.at - b.at);
  const enclosing = (at) => {
    let name = '(top level)';
    for (const d of decls) { if (d.at < at) name = d.name; else break; }
    return name;
  };
  const bodyOf = (name) => {
    const i = decls.findIndex((d) => d.name === name);
    if (i < 0) return '';
    return src.slice(decls[i].at, i + 1 < decls.length ? decls[i + 1].at : src.length);
  };

  const sites = [...src.matchAll(SERVICE)].map((m) => enclosing(m.index));
  const filesIn = {};
  for (const n of sites) filesIn[n] = (filesIn[n] || 0) + 1;

  /* A function may file at most ONCE — two calls in one function is the same
     rule answered twice. */
  const twice = Object.entries(filesIn).filter(([, n]) => n > 1).map(([n]) => n);
  ok(twice.length === 0,
    `no function files a document twice${twice.length ? ` — ${twice.join(', ')}` : ` (${Object.keys(filesIn).join(', ') || 'none'})`}`);

  /* AND NOTHING FILES THAT NOBODY REACHES. Every filing function is either a
     named upload handler, or a shared filer a handler actually calls. */
  const isHandler = (n) => handlers.includes(n);
  const reachedByHandler = (n) => handlers.some((h) => h !== n && new RegExp(`\\b${n}\\(`).test(bodyOf(h)));
  const stray = Object.keys(filesIn).filter((n) => !isHandler(n) && !reachedByHandler(n));
  ok(stray.length === 0,
    `every place that files a document is a door or a filer a door calls — no second copy waiting to be wired up${stray.length ? ` — STRAY: ${stray.join(', ')}` : ''}`);

  /* AND EVERY DOOR FILES — itself, or through exactly one shared filer. */
  for (const h of handlers) {
    const body = bodyOf(h);
    const direct = filesIn[h] || 0;
    const via = Object.keys(filesIn).filter((n) => n !== h)
      .flatMap((n) => (body.match(new RegExp(`\\b${n}\\(`, 'g')) || []).map(() => n));
    ok(direct + via.length === 1,
      `${h} files exactly once — itself or through one shared filer, never twice and never not at all `
      + `(direct: ${direct}, via: ${via.join(', ') || 'none'})`);
  }

  /* EVERY UPLOAD HAS BOTH DOORS, AND BOTH RUN THE SAME HANDLER. This is what the
     count was really protecting: a streamed door wired to its own handler would
     drift from the JSON one exactly where it matters least visibly. */
  for (const h of handlers) {
    const plain = new RegExp(`router\\.post\\('[^']*/documents',\\s*${h}\\)`).test(src);
    const streamed = new RegExp(
      `router\\.post\\('[^']*/documents/binary',[\\s\\S]{0,160}?binaryIntake,\\s*${h}\\)`).test(src);
    ok(plain && streamed,
      `${h} is registered on BOTH doors — the JSON one and the streamed one behind binaryIntake`);
  }
}

console.log('\n4. no ceiling is re-inlined anywhere in the long-term upload path');
{
  const files = [
    'src/longterm/routes/condition-center.js',
    'app-v2/src/longterm/http.js',
    'app-v2/src/longterm/api.js',
  ];
  for (const f of files) {
    const bare = noComments(read(f));
    /* A literal megabyte arithmetic (`* 1024 * 1024`) or a bare 25/1024 next to
       the word limit is how a door starts disagreeing with the server about what
       it will accept — and the door always loses that argument silently. */
    ok(!/\b(maxBytes|MAX_BYTES|sizeLimit)\b\s*=/.test(bare),
      `${f} declares no upload ceiling of its own`);
    ok(!/1024 \* 1024/.test(bare),
      `${f} does no megabyte arithmetic of its own`);
  }
  /* AND THE SERVER'S OWN ANSWER IS STILL TWO DIFFERENT NUMBERS. The whole reason
     the streamed door exists is that the JSON parser's ceiling must never be tied
     to the document ceiling — `config.js` says so in as many words. */
  const us = require('../src/lib/upload-stream');
  ok(us.maxUploadBytes() > us.jsonUploadBytes(),
    'the document ceiling is genuinely larger than the JSON one — or the streamed door buys nothing');
  ok(typeof us.binaryIntake === 'function' && typeof us.takeUpload === 'function',
    'the shared transport exports both halves the two doors need');
}

console.log(`\ntest-lt-upload-transport-pure: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

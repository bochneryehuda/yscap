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

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/* COMMENTS STRIPPED BEFORE EVERY "must not appear" ASSERTION. The change that
   removed the base64 reader necessarily NAMES it in the note explaining why, and
   a guard that read comments would fail on its own explanation and then get
   "fixed" by deleting the explanation. */
const noComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

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
  /* A SECOND HANDLER IS THE FAILURE THIS GUARDS. Not a style point: the handler
     resolves the loan, scopes the condition into the STATEMENT, and decides the
     document's visibility from the condition's audience. A second copy is a
     second answer to all three — so the property asserted is that exactly ONE
     place in this router calls the shared upload service. Counting
     `scopedCondition` callers would be wrong: nine routes legitimately scope a
     condition, and only one of them files a document. */
  const uploads = (src.match(/condUpload\.uploadConditionDocument\(/g) || []).length;
  ok(uploads === 1,
    `exactly one place files a document — no second handler beside it (found ${uploads})`);
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

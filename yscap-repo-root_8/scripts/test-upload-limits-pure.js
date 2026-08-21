'use strict';
/**
 * test-upload-limits-pure — the two ceilings, the wording, and the rule that keeps a
 * bigger upload limit from becoming an out-of-memory kill of the whole site.
 *
 * Owner-reported 2026-08-21: a 23.3 MB executed contract would not upload, the refusal
 * appeared at the top of the page rather than beside the condition, and *"we need to
 * increase the limit of megabytes that we can upload to unlimit it … The sky is the
 * limit."*
 *
 * WHAT MUST STAY TRUE, and why each one is here rather than assumed:
 *  1. The DOCUMENT ceiling and the JSON-BODY ceiling are different numbers answering
 *     different questions. Tying the second to the first is exactly how "unlimited
 *     uploads" turns into a 512 MB instance being killed — measured, not guessed:
 *     a base64 upload peaks at about five times the file.
 *  2. No door derives its cap from the document ceiling any more.
 *  3. The express body limit follows the JSON ceiling.
 *  4. A refusal names the file, its size and the real limit.
 *  5. `readUploadBytes` applies its limit on BOTH doors, so a JSON upload and a streamed
 *     one behave identically.
 *
 * Pure — no database, no network.
 */

const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  ✘ ' + m); } };

const cfg = require(REPO + '/src/config');
const U = require(REPO + '/src/lib/upload-stream');

console.log('1. the two ceilings are two different questions');
ok(cfg.maxUploadMb >= 100, `the document ceiling is generous (${cfg.maxUploadMb} MB)`);
ok(cfg.maxJsonUploadMb <= 50, `the JSON-body ceiling stays small (${cfg.maxJsonUploadMb} MB)`);
ok(cfg.maxUploadMb !== cfg.maxJsonUploadMb, 'they are not the same number');
ok(U.maxUploadBytes() === cfg.maxUploadMb * 1024 * 1024, 'maxUploadBytes reports the document ceiling');
ok(U.jsonUploadBytes() === cfg.maxJsonUploadMb * 1024 * 1024, 'jsonUploadBytes reports the JSON ceiling');
ok(U.maxUploadBytes() > U.jsonUploadBytes(), 'a document may be far larger than any JSON body');

console.log('2. no door derives its cap from the document ceiling');
/* THE WHOLE POINT OF THE SPLIT. A door that still multiplies out `maxUploadMb` would
   accept a body express cannot parse — or, worse, one it CAN, at five times the file. */
for (const f of ['src/routes/staff.js', 'src/routes/borrower.js', 'src/routes/tpo.js',
  'src/routes/sitewire.js', 'src/routes/appraisal.js', 'src/lib/chat-attach.js', 'src/lib/credit/store.js']) {
  const s = read(f);
  ok(!/cfg\.maxUploadMb\s*\*\s*1024/.test(s), `${f} does not size a base64 body from the document ceiling`);
}
ok(/JSON_LIMIT_MB = Math\.max\(25, Math\.ceil\(cfg\.maxJsonUploadMb/.test(read('src/server.js')),
  'the express body limit follows the JSON ceiling, never the document ceiling');

console.log('3. a refusal says exactly what is wrong');
const msg = U.tooLargeMessage('Fully_Executed_Contract.pdf', 23.3 * U.MB, 20 * U.MB);
ok(/Fully_Executed_Contract\.pdf/.test(msg), 'it names the file');
ok(/23/.test(msg), 'it says how big the file is');
ok(/20 MB/.test(msg), 'it says what the limit actually is');
ok(!/^upload failed/i.test(msg) && msg.length > 40, 'it is a sentence somebody can act on, not "upload failed"');
const anon = U.tooLargeMessage(null, 5 * U.MB, 1 * U.MB);
ok(/That file/.test(anon), 'with no filename it still reads as English');

console.log('4. metadata rides in a header, and junk never throws');
const hdr = (o) => ({ headers: { 'x-upload-meta': Buffer.from(JSON.stringify(o)).toString('base64') } });
ok(U.metaFromHeaders(hdr({ filename: 'a.pdf', checklistItemId: 'abc' })).checklistItemId === 'abc', 'it round-trips');
ok(U.metaFromHeaders({ headers: {} }).filename === undefined, 'no header → no metadata, not a throw');
ok(JSON.stringify(U.metaFromHeaders({ headers: { 'x-upload-meta': 'not base64 at all !!' } })) === '{}',
  'unreadable metadata reads as none');
ok(JSON.stringify(U.metaFromHeaders(hdr(['a', 'b']))) === '{}', 'an ARRAY is not metadata — a route must never index into one');
/* A filename with an accent or a quotation mark must survive: a raw header value is
   latin-1 on the wire, which is why the metadata is base64 JSON rather than plain. */
ok(U.metaFromHeaders(hdr({ filename: 'Contrat_signé "final".pdf' })).filename === 'Contrat_signé "final".pdf',
  'a non-Latin / quoted filename survives the header');

console.log('5. readUploadBytes applies its limit on BOTH doors');
(async () => {
  const small = Buffer.alloc(10, 1);
  ok((await U.readUploadBytes({ buf: small, bytes: 10 }, 100)) === small, 'a JSON upload under the limit returns its bytes');
  ok((await U.readUploadBytes({ buf: small, bytes: 10 })) === small, 'no limit → the bytes');
  /* THE ONE THAT WOULD DRIFT: shortcutting to the in-memory buffer without consulting the
     limit makes the JSON door attach a 20 MB file to an email that the streaming door
     correctly declines to. */
  ok((await U.readUploadBytes({ buf: small, bytes: 10 }, 5)) === null,
    'a JSON upload OVER the limit is refused too — the doors must behave identically');
  ok((await U.readUploadBytes(null, 5)) === null, 'nothing in hand → null, never a throw');
  ok((await U.readUploadBytes({ ref: 'nope/does-not-exist', bytes: 3 }, 100)) === null,
    'an unreadable stored file answers null rather than failing the upload');

  console.log('6. the client streams the file and reports where the upload happened');
  const apiJs = read('app-v2/src/lib/api.js');
  ok(/uploadBinary\(/.test(apiJs), 'the client has a streaming upload');
  ok(/documents\/binary/.test(apiJs), 'it posts to the binary door');
  ok(/b\.file\s*\?\s*\n?\s*uploadBinary/.test(apiJs.replace(/\s+/g, ' ').replace(/ /g, ' ')) || /b && b\.file/.test(apiJs),
    'a caller handing over a File takes the streaming door');
  ok(/const size = b\.file \? b\.file\.size/.test(apiJs),
    'the in-flight signature keys on the file size — a streamed upload has no base64 length, and two different files must not coalesce');
  const staff = read('app-v2/src/screens/StaffApplication.jsx');
  ok(/file: files\[i\]/.test(staff), 'the staff upload hands over the File itself');
  ok(!/dataBase64: await fileToBase64\(files\[i\]\)/.test(staff), 'it no longer reads the whole file into memory first');
  ok(/setUploadNote\(\{ itemId: tgt\.itemId, tone: 'err'/.test(staff),
    'a refusal is recorded against the condition it was for');
  ok(/uploadNote && uploadNote\.itemId === it\.id/.test(staff), 'the condition renders its OWN note');
  ok(/\{uploadNoteEl\}/.test(staff), 'and renders it — collapsed and open');
  ok((staff.match(/\{uploadNoteEl\}/g) || []).length >= 2,
    'both the collapsed row and the open one show it (an upload can be dropped on either)');

  console.log(`\ntest-upload-limits-pure: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();

/* ATTACHING A DOCUMENT TO A REPLY YOU TYPE — the reader, and the wiring, with no network.
 *
 * Owner-directed 2026-08-21: *"on any reply to any Gmail section that we currently have, if
 * it's The insurance order / The title order / The draw section / The general email inbox — we
 * need to be able to attach documents over there manually and also drag and drop into the box
 * of the email."*
 *
 * What this pins:
 *   A. the reader's truth table — what rides, and what is refused, and why;
 *   B. THE BYTES DECIDE THE TYPE. A file claiming to be a PDF and containing a web page is
 *      stored XSS aimed at whoever opens it — and an attachment from this door is opened by an
 *      outside company whose mail client we do not control;
 *   C. the filename is sanitized and collisions are told apart, so two `scan.pdf` do not
 *      arrive as one name twice;
 *   D. the budget is the LIVE provider's real ceiling, reused rather than restated, and
 *      NOTHING is ever silently dropped;
 *   E. the wiring — all four reply branches carry them, the compose box is the drop target,
 *      and every surface the owner named goes through the ONE composer.
 *
 * Pure — no database, no network.
 * Run: node scripts/test-email-compose-attach-pure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

const C = require('../src/lib/email/compose-attachments');
const prep = require('../src/lib/closing-prep');

// A Buffer stays a Buffer: `Buffer.from(buf.toString('latin1'))` re-encodes as UTF-8 and
// corrupts every byte above 0x7F — which is every magic byte worth sniffing.
const b64 = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(s)).toString('base64');
const up = (filename, contentType, body) => ({ filename, contentType, dataBase64: b64(body) });
const PDF = '%PDF-1.4\nreal document bytes';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64)]);

// ---------------------------------------------------------------- A. the truth table
eq('A1 nothing attached is not an error', C.readComposeAttachments(null),
  { attachments: [], skipped: [], totalBytes: 0, count: 0 });
eq('A2 …and neither is an empty list', C.readComposeAttachments([]).count, 0);

{
  const r = C.readComposeAttachments([up('contract.pdf', 'application/pdf', PDF)]);
  eq('A3 an ordinary document rides', r.count, 1);
  eq('A4 …in the shape BOTH providers already take', Object.keys(r.attachments[0]).sort(),
    ['content', 'contentType', 'filename']);
  eq('A5 …with its bytes intact', Buffer.from(r.attachments[0].content, 'base64').toString(), PDF);
  eq('A6 …and nothing held back', r.skipped.length, 0);
}
eq('A7 bytes that are not really base64 are refused, never silently garbled',
  C.readComposeAttachments([{ filename: 'x.pdf', contentType: 'application/pdf', dataBase64: '!!! not base64 !!!' }]).skipped[0].code,
  'unreadable');
eq('A8 an empty file is refused — a zero-byte "document" is always a bug',
  C.readComposeAttachments([up('x.pdf', 'application/pdf', '')]).skipped[0].code, 'unreadable');
{
  const many = Array.from({ length: C.MAX_FILES + 3 }, (_, i) => up(`f${i}.pdf`, 'application/pdf', PDF));
  const r = C.readComposeAttachments(many);
  eq('A9 more than one email can carry is capped', r.count, C.MAX_FILES);
  eq('A10 …and the rest are NAMED, not dropped in silence', r.skipped.length, 3);
  eq('A11 …with a reason a person can act on', r.skipped[0].code, 'too_many');
}

// ---------------------------------------------------------------- B. the bytes decide
{
  const r = C.readComposeAttachments([up('invoice.pdf', 'application/pdf', '<!doctype html><script>x()</script>')]);
  eq('B1 a web page wearing a PDF’s name is REFUSED', r.count, 0);
  eq('B2 …by code', r.skipped[0].code, 'unsafe_type');
}
{
  // SVG carries NO magic bytes — it is XML text — so the sniffer cannot see it and the
  // claimed type is the only signal. Both paths are checked.
  eq('B3 an SVG is refused by its bytes',
    C.readComposeAttachments([up('logo.png', 'image/png', '<svg xmlns="http://www.w3.org/2000/svg"/>')]).skipped[0].code, 'unsafe_type');
  eq('B4 …and by its claimed type',
    C.readComposeAttachments([up('logo.dat', 'image/svg+xml', 'not really svg but claimed')]).skipped[0].code, 'unsafe_type');
  eq('B5 …and a plain text/html claim too',
    C.readComposeAttachments([up('page.dat', 'text/html', 'plain words')]).skipped[0].code, 'unsafe_type');
}
{
  const r = C.readComposeAttachments([up('photo.pdf', 'application/pdf', PNG)]);
  eq('B6 the SNIFFED type wins over the claimed one', r.attachments[0].contentType, 'image/png');
}
{
  const r = C.readComposeAttachments([up('notes.txt', 'text/plain', 'just some words')]);
  eq('B7 something the sniffer cannot place falls back to the claimed type', r.attachments[0].contentType, 'text/plain');
}

// ---------------------------------------------------------------- C. the filename
{
  const r = C.readComposeAttachments([
    up('../../etc/passwd.pdf', 'application/pdf', PDF),
    up('scan.pdf', 'application/pdf', PDF),
    up('scan.pdf', 'application/pdf', `${PDF} two`),
  ]);
  ok('C1 path separators are stripped — an attachment name is not a path',
    !r.attachments[0].filename.includes('/'));
  eq('C2 two files with the same name are told apart',
    [r.attachments[1].filename, r.attachments[2].filename], ['scan.pdf', 'scan (2).pdf']);
}
{
  // A NUL in a filename is refused by Postgres in text at all, and this name also reaches a
  // mail header. The request-boundary middleware strips it from the parsed body first; this
  // is the second layer, and it is the one that holds for any other caller.
  const NUL = String.fromCharCode(0);
  const r = C.readComposeAttachments([up(`bad${NUL}name.pdf`, 'application/pdf', PDF)]);
  ok('C3 a NUL byte never survives into a filename', !r.attachments[0].filename.includes(NUL));
}

// ---------------------------------------------------------------- D. the budget
ok('D1 the ceiling is the LIVE provider’s own, reused rather than restated',
  typeof prep.attachBudget === 'function' && (() => {
    const b = prep.attachBudget();
    return b && (Number.isFinite(b.raw) || Number.isFinite(b.encoded));
  })());
{
  const big = up('big.pdf', 'application/pdf', `%PDF-1.4\n${'x'.repeat(4096)}`);
  const r = C.readComposeAttachments([big], { budget: { raw: 1024, encoded: Infinity } });
  eq('D2 a file that does not fit is refused', r.count, 0);
  eq('D3 …and named, with the real ceiling in words', r.skipped[0].code, 'too_big');
  ok('D4 …in plain language, not a byte count', /email can carry about/.test(r.skipped[0].why));
}
{
  // The ENCODED ceiling binds independently — it is the number a receiving mail server
  // measures, and measuring only raw bytes is how a package that "fit" got rejected after we
  // had said it was sent.
  const f = up('m.pdf', 'application/pdf', `%PDF-1.4\n${'x'.repeat(3000)}`);
  const r = C.readComposeAttachments([f], { budget: { raw: Infinity, encoded: 1024 } });
  eq('D5 the on-the-wire ceiling binds on its own', r.count, 0);
}
ok('D6 the "not attached" sentence names every one of them', (() => {
  const note = C.skippedNote([{ filename: 'a.pdf', why: 'too big' }, { filename: 'b.html', why: 'a web page' }]);
  return note.includes('a.pdf') && note.includes('b.html');
})());
eq('D7 …and there is no sentence when everything rode', C.skippedNote([]), null);

// ---------------------------------------------------------------- E. the wiring
const staffSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
ok('E1 the reply route reads the uploads through the ONE reader',
  /readComposeAttachments\(req\.body && req\.body\.attachments\)/.test(staffSrc));
// All four branches — the closing chain, the two vendor orders, and the plain file reply
// (which also serves the draw section). One of them missing is the whole feature missing on
// that screen, and nothing would error.
ok('E2 the closing chain carries them', /msgType: 'closing_followup', attachments: attach,/.test(staffSrc));
ok('E3 the title / insurance order carries them', /type: `\$\{kind\}_followup`, thread, attachments: attach,/.test(staffSrc));
ok('E4 the plain file reply (and the draw section) carries them',
  /cc: drawCc\.length \? drawCc : undefined,\s*\n\s*\.\.\.\(attach\.length \? \{ attachments: attach \} : \{\}\),/.test(staffSrc));
ok('E5 every branch tells the caller what could NOT be attached',
  (staffSrc.match(/attachSkipped/g) || []).length >= 5);

const ordersSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'orders.js'), 'utf8');
ok('E6 sendOrderMail takes them…', /async function sendOrderMail\(\{[^}]*attachments \}\)/.test(ordersSrc));
ok('E7 …and only when there are any, so PLACING an order is byte-identical to before',
  /\.\.\.\(Array\.isArray\(attachments\) && attachments\.length \? \{ attachments \} : \{\}\)/.test(ordersSrc));

const ecSrc = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'components', 'EmailCenter.jsx'), 'utf8');
ok('E8 the WHOLE compose box is the drop target — "into the box of the email"',
  /<DropZone className="ec-reply"/.test(ecSrc));
ok('E9 …and there is a manual Attach control too', /type="file" multiple/.test(ecSrc));
ok('E10 the attachments ride on the send', /attachments: atts\.map\(/.test(ecSrc));
ok('E11 …and only the three keys the server’s contract names',
  /attachments: atts\.map\(\(a\) => \(\{ filename: a\.filename, contentType: a\.contentType, dataBase64: a\.dataBase64 \}\)\)/.test(ecSrc));
ok('E12 what the server held back is shown, never swallowed', /r\.attachSkipped/.test(ecSrc));

// ONE composer serves every surface the owner named, so this could not be half-done.
for (const [file, scope] of [
  ['components/OrdersPanel.jsx', 'scope={kind}'],          // the title AND insurance orders
  ['components/DrawsPanel.jsx', 'scope="draw"'],           // the draw section
  ['components/ClosingEmailChain.jsx', 'scope="closing"'],
  ['screens/StaffEmails.jsx', 'mode="global"'],            // the general email inbox
]) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', file), 'utf8');
  ok(`E13 ${file} uses the shared EmailCenter (${scope})`,
    /import EmailCenter from/.test(src) && src.includes(scope));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

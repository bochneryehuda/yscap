/**
 * ITEM 17 (owner-directed 2026-08-12): when a loan officer / prospect clicks "Email me this term
 * sheet" on the Term Sheet Generator, the visitor's confirmation email must now carry the generated
 * PDF — before this they got a plain "we received it" note and no term sheet.
 *
 * Two guarantees, both PURE (no DB, no network — the provider is stubbed):
 *   (1) catalog.deliver forwards opts.attachments to the email provider (and omits it otherwise, so
 *       every other caller is byte-identical).
 *   (2) the leadReceived template, given hasTermSheet, says the term sheet is attached and that it is
 *       an INITIAL sheet.
 */
process.env.EMAIL_PROVIDER = 'none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-lead-attach';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

// The provider is a shared module object; catalog.js holds the SAME reference (const provider =
// require('./index')), so patching .sendMail here is what catalog calls.
const provider = require(__dirname + '/../src/lib/email');
let captured = null;
provider.sendMail = async (payload) => { captured = payload; return { ok: true, id: 'test' }; };
const catalog = require(__dirname + '/../src/lib/email/catalog');

async function main() {
  // (1) template wording WITH a term sheet
  const b = catalog.leadReceived({ firstName: 'Sam', toolLabel: 'Term sheet request', hasTermSheet: true });
  const blob = String(b.html + ' ' + b.text + ' ' + b.subject).toLowerCase();
  ok(/attached/.test(blob), 'the confirmation says the term sheet is attached');
  ok(/initial term sheet/.test(blob), 'the confirmation states it is an INITIAL term sheet (subject to underwriting)');

  // (1b) template wording WITHOUT a term sheet — the plain "received" copy, no "attached PDF" claim
  const b0 = catalog.leadReceived({ firstName: 'Sam', toolLabel: 'Term sheet request' });
  ok(!/attached to this email as a pdf/i.test(String(b0.html + b0.text)),
    'without a term sheet, the email never claims a PDF is attached');

  // (2) deliver FORWARDS attachments to the provider
  const pdf = { filename: 'term-sheet.pdf', contentType: 'application/pdf', content: 'JVBERi0xLjQK' };
  captured = null;
  const r = await catalog.send('leadReceived', 'borrower@example.com',
    { hasTermSheet: true, toolLabel: 'Term sheet request' }, { attachments: [pdf] });
  ok(r && r.ok, 'send resolves ok');
  ok(captured && Array.isArray(captured.attachments) && captured.attachments.length === 1,
    'deliver forwards opts.attachments to the provider');
  ok(captured && captured.attachments[0].filename === 'term-sheet.pdf'
    && captured.attachments[0].contentType === 'application/pdf',
    'the forwarded attachment is the term-sheet PDF');

  // (2b) with NO attachments the provider payload carries none — byte-identical to before
  captured = null;
  await catalog.send('leadReceived', 'borrower@example.com', { toolLabel: 'Contact request' }, {});
  ok(captured && captured.attachments === undefined,
    'with no attachments passed, the provider payload carries none (unchanged for every other caller)');

  console.log(`\nlead-termsheet-attach-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();

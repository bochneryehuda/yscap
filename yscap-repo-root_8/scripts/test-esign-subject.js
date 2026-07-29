/**
 * Pure test for the DocuSign envelope SUBJECT-line address (owner-directed 2026-07-22:
 * the term-sheet invitation subject was "Your loan documents are ready to sign — Loan #NNN"
 * with NO property — impossible to tell which property when signing several a day).
 * Root cause: subjectAddress() only read oneLine/formatted_address/line1/… — a file whose
 * whole address sits under a single `address` (or `formatted`) key produced an EMPTY
 * string, so the suffix collapsed to just the loan number. No DB needed.
 *   node scripts/test-esign-subject.js
 */
const R = require('path').resolve(__dirname, '..');
const { subjectAddress, subjectSuffix, composeSubject, fitAddress, PACKAGES } = require(R + '/src/lib/esign/orchestrate');
const docusign = require(R + '/src/lib/integrations/docusign');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// --- subjectAddress across every property_address shape the loaders can hand it ---
eq(subjectAddress(null), '', 'null app -> empty');
eq(subjectAddress({}), '', 'no address keys -> empty');
eq(subjectAddress({ addr_oneline: '12 Oak St, Newark, NJ 07104' }), '12 Oak St, Newark, NJ 07104', 'oneLine wins');
eq(subjectAddress({ addr_formatted: '12 Oak St, Newark, NJ 07104' }), '12 Oak St, Newark, NJ 07104', 'formatted_address used');
eq(subjectAddress({ addr_formatted2: '12 Oak St, Newark, NJ 07104' }), '12 Oak St, Newark, NJ 07104', 'ClickUp `formatted` key used');
eq(subjectAddress({ addr_scalar: '12 Oak St, Newark, NJ 07104' }), '12 Oak St, Newark, NJ 07104', 'scalar-string address used');
eq(subjectAddress({ addr_line1: '12 Oak St', addr_city: 'Newark', addr_state: 'NJ', addr_zip: '07104' }),
   '12 Oak St, Newark, NJ 07104', 'discrete parts compose');
eq(subjectAddress({ addr_line1: '12 Oak St', addr_unit: 'Apt 3', addr_city: 'Newark', addr_state: 'NJ', addr_zip: '07104' }),
   '12 Oak St Apt 3, Newark, NJ 07104', 'unit included');
// THE BUG CASE: the whole address under a single `address` key -> was empty, now returned.
eq(subjectAddress({ addr_address: '12 Oak St, Newark, NJ 07104' }), '12 Oak St, Newark, NJ 07104',
   '`address` one-liner (the reported bug) is no longer dropped');
// `address` holding just the street + separate city/state/zip -> composes.
eq(subjectAddress({ addr_address: '12 Oak St', addr_city: 'Newark', addr_state: 'NJ', addr_zip: '07104' }),
   '12 Oak St, Newark, NJ 07104', '`address` street + discrete city/state/zip compose');
// oneLine still wins over an `address` fallback.
eq(subjectAddress({ addr_oneline: '99 First Ave, NY, NY 10001', addr_address: '12 Oak St' }),
   '99 First Ave, NY, NY 10001', 'oneLine beats address fallback');

// --- subjectSuffix ---
eq(subjectSuffix('YSCAP258134746', ''), ' — Loan #YSCAP258134746', 'no address -> loan-only suffix (old behavior)');
eq(subjectSuffix('YSCAP258134746', '12 Oak St, Newark, NJ 07104'),
   ' — Loan #YSCAP258134746 · 12 Oak St, Newark, NJ 07104', 'loan + address suffix');
eq(subjectSuffix('', '12 Oak St'), ' — 12 Oak St', 'address-only suffix (no loan)');
eq(subjectSuffix('', ''), '', 'nothing -> empty suffix');

// --- the actual term-sheet package subject the borrower sees ---
const app = { ys_loan_number: 'YSCAP258134746', addr_address: '12 Oak St, Newark, NJ 07104' };
const subj = PACKAGES.term_sheet_package.subject(app.ys_loan_number, subjectAddress(app));
eq(subj, 'Your loan documents are ready to sign — Loan #YSCAP258134746 · 12 Oak St, Newark, NJ 07104',
   'term-sheet subject now carries the property');
ok(subj.includes('12 Oak St'), 'term-sheet subject includes the property address');

// ---------------------------------------------------------------------------
// DocuSign's 100-character emailSubject limit (owner-reported 2026-07-27).
// Over the limit DocuSign REJECTS the whole create with a 400 — nothing is sent.
// ---------------------------------------------------------------------------
const MAX = docusign.EMAIL_SUBJECT_MAX;
eq(MAX, 100, 'DocuSign emailSubject limit is 100 characters');

// THE REPORTED CASE: Pinches Lichtman / 129 Carlisle St — an entirely ordinary address
// that composed to 102 characters and failed every send for that file.
const reported = PACKAGES.term_sheet_package.subject('YSCAP258134736', '129 Carlisle St, Wilkes-Barre, PA 18702');
ok(reported.length <= MAX, `reported case fits (${reported.length} chars): ${reported}`);
ok(reported.includes('YSCAP258134736'), 'reported case keeps the loan number whole');
ok(reported.includes('129 Carlisle St'), 'reported case keeps the street');
ok(reported.includes('Wilkes-Barre'), 'reported case keeps the city (only the zip/state give)');
ok(!reported.includes('…'), 'reported case degrades cleanly — no mid-word ellipsis needed');

// Every package × a battery of real-shaped addresses must ALWAYS fit, and must always
// keep the loan number (what the admin counter-signer identifies the request by).
const ADDRESSES = [
  '', '12 Oak St, Newark, NJ 07104',
  '129 Carlisle St, Wilkes-Barre, PA 18702',
  '1234 Northwest Extension Boulevard Apt 12B, Croton-on-Hudson, NY 10520',
  '5701 15th Ave Apt 4D, Brooklyn, NY 11219',
  'A'.repeat(300),                                    // absurd single-token address
  'Some Extremely Long Street Name Without Any Commas At All Whatsoever Forever',
];
for (const key of Object.keys(PACKAGES)) {
  for (const addr of ADDRESSES) {
    const s = PACKAGES[key].subject('YSCAP258134736', addr);
    ok(s.length <= MAX, `${key} fits for ${JSON.stringify(addr.slice(0, 40))} (got ${s.length})`);
    ok(s.includes('Loan #YSCAP258134736'), `${key} keeps the loan number for ${JSON.stringify(addr.slice(0, 40))}`);
    ok(!/\s+$/.test(s), `${key} has no trailing whitespace for ${JSON.stringify(addr.slice(0, 40))}`);
  }
  // A file with no loan number yet still fits.
  const noLoan = PACKAGES[key].subject('', 'A'.repeat(300));
  ok(noLoan.length <= MAX, `${key} fits with no loan number (got ${noLoan.length})`);
}

// fitAddress drops the least-identifying end first, never mid-word while a whole part fits.
eq(fitAddress('129 Carlisle St, Wilkes-Barre, PA 18702', 39), '129 Carlisle St, Wilkes-Barre, PA 18702', 'exact fit is untouched');
eq(fitAddress('129 Carlisle St, Wilkes-Barre, PA 18702', 38), '129 Carlisle St, Wilkes-Barre, PA', 'zip drops first');
eq(fitAddress('129 Carlisle St, Wilkes-Barre, PA 18702', 32), '129 Carlisle St, Wilkes-Barre', 'state drops next');
eq(fitAddress('129 Carlisle St, Wilkes-Barre, PA 18702', 20), '129 Carlisle St', 'city drops next');
eq(fitAddress('129 Carlisle St, Wilkes-Barre, PA 18702', 10), '129 Carli…', 'street clipped only as the last resort');
eq(fitAddress('12 Oak St, Newark, NJ 07104-1234', 30), '12 Oak St, Newark, NJ', 'ZIP+4 recognized');
eq(fitAddress('', 50), '', 'empty address stays empty');
eq(fitAddress('12 Oak St', 0), '', 'no budget -> empty');
eq(fitAddress(null, 50), '', 'null address stays empty');

// composeSubject leaves a fitting subject byte-identical (no behavior change for short ones).
eq(composeSubject('Heter Iska ready to sign', 'YSCAP1', '12 Oak St'),
   `Heter Iska ready to sign${subjectSuffix('YSCAP1', '12 Oak St')}`, 'short subject unchanged');

// The chokepoint backstop: buildEnvelopeDefinition can never emit an over-long subject,
// even if a future caller hand-builds one.
const def = docusign.buildEnvelopeDefinition({
  documents: [{ base64: 'x', name: 'D', documentId: '1' }],
  signers: [{ recipientId: '1', name: 'A B', email: 'a@b.com' }],
  subject: 'Z'.repeat(500),
});
ok(def.emailSubject.length <= MAX, `chokepoint caps a 500-char subject (got ${def.emailSubject.length})`);
ok(def.emailSubject.endsWith('…'), 'chokepoint marks the clip with an ellipsis');
eq(docusign.capEmailSubject('short'), 'short', 'capEmailSubject leaves a short subject alone');
eq(docusign.capEmailSubject(null), '', 'capEmailSubject handles null');
eq(docusign.capEmailSubject('x'.repeat(100)).length, 100, 'exactly 100 is not clipped');
eq(docusign.capEmailSubject('x'.repeat(101)).length, 100, '101 clips to 100');
// A blank/whitespace-only subject takes the default, never an empty emailSubject.
for (const blank of [undefined, null, '', '   ']) {
  const d = docusign.buildEnvelopeDefinition({
    documents: [{ base64: 'x', name: 'D', documentId: '1' }],
    signers: [{ recipientId: '1', name: 'A B', email: 'a@b.com' }],
    subject: blank,
  });
  eq(d.emailSubject, 'Please sign your documents', `blank subject ${JSON.stringify(blank)} -> default`);
}
// A surrogate pair must never be split in half by the clip.
const astral = 'y'.repeat(98) + '\u{1F600}\u{1F600}';   // 98 + 2×2 UTF-16 units = 102
const capped = docusign.capEmailSubject(astral);
ok(capped.length <= MAX, 'astral subject fits');
ok(!/[\uD800-\uDBFF]$/.test(capped.slice(0, -1)), 'no orphaned high surrogate before the ellipsis');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

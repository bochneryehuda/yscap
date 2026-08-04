#!/usr/bin/env node
'use strict';
/**
 * THE SNIFF THAT DECIDES WHETHER A FILE IS AN APPRAISAL — its whole truth table.
 *
 * `xml-catch.looksLikeAppraisalXml` runs on EVERY document uploaded anywhere in PILOT,
 * so it is wrong in two directions and both cost something real:
 *
 *   A MISS throws away a full grid of comparable sales we have already paid for, and
 *   says nothing to anybody. That is the expensive direction, and it is why the sniff
 *   scans the whole file rather than give up when its head is inconclusive.
 *
 *   A FALSE POSITIVE hands a rent roll to the appraisal parser, which records a
 *   refusal in the import ledger. Cheap, but it is noise in the one list an operator
 *   reads to answer "did our reports come in?", so an ordinary XML must be ignored in
 *   SILENCE — no ledger row at all.
 *
 * The sniff itself is PURE, so all of this is testable with no database.
 *
 * Run: node scripts/test-research-xml-catch-pure.js
 */
const path = require('path');
const C = require(path.join(__dirname, '..', 'src', 'lib', 'research', 'xml-catch'));
const { _internals: EX } = require(path.join(__dirname, '..', 'src', 'lib', 'appraisal', 'extract'));

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };
const look = (xml, meta) => C.looksLikeAppraisalXml(xml, meta || { filename: 'x.xml' });

// ── the real thing ──────────────────────────────────────────────────────────
const MISMO26 = `<?xml version="1.0" encoding="UTF-8"?>
<VALUATION_RESPONSE MISMOVersionID="2.6">
 <REPORT AppraisalFormType="FNM1004">
  <PROPERTY>
   <SALES_COMPARISON>
    <COMPARABLE_SALE PropertySequenceIdentifier="1" SalesPriceAmount="412000">
     <LOCATION PropertyStreetAddress="12 Elm St" PropertyCity="Newark" PropertyState="NJ" PropertyPostalCode="07103"/>
    </COMPARABLE_SALE>
   </SALES_COMPARISON>
  </PROPERTY>
 </REPORT>
</VALUATION_RESPONSE>`;

ok(look(MISMO26).maybe, 'a MISMO 2.6 appraisal is recognised');
ok(/VALUATION_RESPONSE/i.test(look(MISMO26).why),
  `  …and the reason names the evidence, not a guess ("${look(MISMO26).why}")`);

// The three markers are INDEPENDENT — each has to stand on its own, because a real
// report can be missing any one of them (a vendor namespace, a stripped root, a grid
// that sits past the sniff window).
ok(look(`<REPORT AppraisalFormType="FNM1025"><PROPERTY/></REPORT>`).maybe,
  'an appraisal form type alone is enough (nothing else in a lending system carries it)');
ok(look(`<foo><SALES_COMPARISON><COMPARABLE_SALE/></SALES_COMPARISON></foo>`).maybe,
  'a comparable sales grid alone is enough');
ok(look(`<x:VALUATION_RESPONSE xmlns:x="urn:v"><x:REPORT/></x:VALUATION_RESPONSE>`).maybe,
  'a vendor NAMESPACE prefix does not hide the root (the parser tolerates it, so this must too)');
ok(look(MISMO26.toUpperCase().replace('VALUATION_RESPONSE', 'valuation_response')).maybe,
  'and the markers are case-insensitive');

// ── the things that must be ignored, in silence ─────────────────────────────
// An Encompass iLAD export is MISMO, is XML, is on real loan files, and is NOT an
// appraisal. `detectMismo` was written to draw exactly this line (three real corpus
// files) — this asserts the catch inherits it rather than inventing a second opinion.
const ILAD = `<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.4"
  xmlns:ilad="http://www.datamodelextension.org/Schema/ILAD">
  <DEAL_SETS><DEAL_SET><DEALS><DEAL><LOANS><LOAN/></LOANS></DEAL></DEALS></DEAL_SET></DEAL_SETS></MESSAGE>`;
ok(!look(ILAD).maybe, 'a loan-application (iLAD) export is NOT an appraisal — ignored in silence');
ok(!/appraisal/i.test(String(look(ILAD).why).replace('no appraisal', '')),
  `  …and says why in plain words ("${look(ILAD).why}")`);
ok(EX.detectMismo(ILAD).hasGrid === false,
  '  …and the reason is the parser\'s OWN test, reused rather than restated');

ok(!look(`<rentRoll><unit no="1" rent="2400"/></rentRoll>`).maybe,
  'an ordinary XML file is ignored');
ok(!look(`{"comparable_sale": 1}`, { filename: 'notes.json', contentType: 'application/json' }).maybe,
  'a JSON file is ignored even when its TEXT contains a marker word');
ok(!look(Buffer.from('%PDF-1.7\n1 0 obj', 'utf8'), { filename: 'appraisal.pdf', contentType: 'application/pdf' }).maybe,
  'the appraisal PDF itself is ignored — it is not the data file');
ok(!look('', { filename: 'empty.xml' }).maybe, 'an empty file is ignored');
ok(/empty/i.test(look('', { filename: 'empty.xml' }).why), '  …and says so');

// A PDF that HAPPENS to contain the marker text still is not an XML container. This is
// the guard that keeps the container test from being decorative.
ok(!look(Buffer.from('%PDF-1.7 ... AppraisalFormType=FNM1004 ...', 'utf8'),
  { filename: 'report.pdf', contentType: 'application/pdf' }).maybe,
  'and a PDF whose TEXT contains a marker is still not an XML file');

// ── how the file announces itself ───────────────────────────────────────────
ok(look(MISMO26, { filename: 'data', contentType: 'application/xml' }).maybe,
  'a file with no .xml extension is read on its content type');
ok(look(MISMO26, { filename: 'data', contentType: 'application/mismo+xml' }).maybe,
  '  …including the "+xml" media-type suffix');
ok(look(MISMO26, { filename: null, contentType: null }).maybe,
  '  …and with NEITHER, the bytes themselves are enough');

// ── a format we cannot read yet is HELD, not lost ───────────────────────────
// A UAD 3.6 report is a real appraisal PILOT's parser refuses. Recording it (the
// import ledger keeps the parser's own reason) is what makes "how many are we holding
// that we cannot read?" answerable — the day a 3.6 reader ships they are all here.
const UAD36 = `<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6">
 <DEAL><COLLATERALS><COLLATERAL><PROPERTIES><PROPERTY>
  <SALES_COMPARISON><COMPARABLE_SALE/></SALES_COMPARISON>
 </PROPERTY></PROPERTIES></COLLATERAL></COLLATERALS></DEAL></MESSAGE>`;
ok(look(UAD36).maybe, 'a UAD 3.6 report IS recognised as an appraisal — held, not silently dropped');

// ── the head window, and the fallback that stops it being a trap ────────────
// The sniff reads 2 MB and decides. A MISMO 2.6 file can never hide from that — its
// root element IS the marker. But a file whose only evidence sits past the window
// must not be dropped, so an inconclusive head triggers a full scan. Proven by
// building a file whose grid is deliberately beyond it.
const FILLER = '<PAD>' + 'x'.repeat(C._internals.SNIFF_BYTES + 4096) + '</PAD>';
const LATE_GRID = `<?xml version="1.0"?><wrapper>${FILLER}<SALES_COMPARISON><COMPARABLE_SALE/></SALES_COMPARISON></wrapper>`;
ok(Buffer.byteLength(LATE_GRID) > C._internals.SNIFF_BYTES, '  (fixture really is bigger than the sniff window)');
ok(look(LATE_GRID).maybe,
  'evidence PAST the sniff window is still found — an inconclusive head reads the whole file');

// And the fallback does not turn into "say yes eventually": a big file with no
// evidence anywhere is still ignored.
ok(!look(`<?xml version="1.0"?><wrapper>${FILLER}</wrapper>`).maybe,
  '  …but a big file with no appraisal in it is still ignored');

// ── the container test, isolated ────────────────────────────────────────────
const isXml = C._internals.looksLikeXmlContainer;
ok(isXml({ filename: 'a.XML', contentType: null, head: '' }), 'the extension test is case-insensitive');
ok(isXml({ filename: null, contentType: 'text/xml; charset=utf-8', head: '' }), 'a charset parameter does not hide the type');
ok(!isXml({ filename: 'a.xmlx', contentType: null, head: '' }), '".xmlx" is not ".xml"');
ok(!isXml({ filename: null, contentType: 'application/xmlish', head: '' }), '"application/xmlish" is not xml');
ok(isXml({ filename: null, contentType: null, head: '﻿<?xml version="1.0"?>' }), 'a byte-order mark does not hide the declaration');
ok(!isXml({ filename: null, contentType: null, head: 'plain text, no tags' }), 'plain text is not XML');

// ── the ceiling ─────────────────────────────────────────────────────────────
ok(C.MAX_XML_BYTES === 80 * 1024 * 1024,
  'the size ceiling matches the parser\'s own — the catch never accepts what the import would refuse');

// ── the shape the doors depend on ───────────────────────────────────────────
ok(typeof C.fireCatch === 'function' && C.fireCatch.length <= 1, 'fireCatch takes one options object');
ok(C.fireCatch({}) === undefined, 'fireCatch returns nothing — it is fire-and-forget by construction');
ok(C.fireCatchById(null) === undefined, 'fireCatchById on a null id is a no-op, not a throw');

// EVERY DOOR MUST PASS THE BYTES, NOT A PROMISE OF THEM. A guard on the wiring: the
// three upload doors call `fireCatch` with a `bytes` key, and the slot route calls
// `fireCatchById`. A future edit that drops the bytes would silently stop filing
// every report, with no error anywhere.
const fs = require('fs');
const SRC = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
for (const [file, needle, what] of [
  ['routes/staff.js', /xml-catch'\)\.fireCatch\(\{\s*\n\s*bytes: buf,/, 'the staff upload door passes the uploaded bytes'],
  // THE DOORS AN AUDIT FOUND UNCOVERED. The first is the one the report most often
  // arrives through: the vendor replies to the order with the PDF and the MISMO XML.
  ['lib/order-inbox.js', /xml-catch'\)\.fireCatch\(/, 'a vendor emailing the report back on an order feeds the warehouse'],
  ['lib/chat-attach.js', /xml-catch'\)\.fireCatch\(/, 'an XML dropped in the file chat feeds the warehouse'],
  ['lib/closing-inbox.js', /xml-catch'\)\.fireCatch\(/, 'an XML forwarded on the closing chain feeds the warehouse'],
  // AND THE ONE PLACE IT MUST *NOT* FIRE: a SUCCESSFUL desk import already feeds the
  // warehouse, richer, and firing both on the same bytes files the report twice.
  ['routes/staff.js', /if \(!\(apprImport && apprImport\.ok\)\) \{/, 'the catch stands down when the desk import just succeeded'],
  ['routes/borrower.js', /xml-catch'\)\.fireCatch\(\{\s*\n\s*bytes: buf,/, 'the borrower upload door passes the uploaded bytes'],
  ['routes/staff.js', /fireCatchById\(doc\.id,/, 'the slot route catches the document it just re-slotted'],
  ['routes/appraisal.js', /rescueGrid\(\); return res\.status\(422\)/, 'a refused appraisal import still files its grid'],
  ['routes/appraisal.js', /catch \(e\) \{ rescueGrid\(\); throw e; \}/, '  …and so does one that throws'],
  ['server.js', /xml-sweep'\)\.sweepOnBoot/, 'the back-book sweep runs at boot'],
]) ok(needle.test(SRC(file)), what);

// THE BORROWER DOOR MUST NEVER PASS AN UPLOADER ID. `research_imports.uploaded_by`
// references `staff_users`, and the actor on that door is a borrower — passing it
// would raise a foreign-key violation inside the import and lose the whole report
// over a bookkeeping column.
ok(/untrusted: true,\s*\n\s*why: 'a loan file \(borrower upload\)'/.test(SRC('routes/borrower.js')),
  'the borrower door marks its provenance untrusted — its report files, but may not rewrite the appraiser roster');
ok(/uploadedByStaffId: null,/.test(SRC('routes/borrower.js'))
  && /why: 'a loan file \(borrower upload\)'/.test(SRC('routes/borrower.js')),
  'the borrower door passes uploadedByStaffId: null — a borrower id can never reach a staff foreign key');

console.log(fails ? `\ntest-research-xml-catch-pure: ${fails} FAILED` : '\ntest-research-xml-catch-pure: all passed');
process.exit(fails ? 1 : 0);

'use strict';
/**
 * "THIS IS FOR BUSINESS-PURPOSE LENDING ONLY." — ON EVERY EXPORT.
 *
 * Owner-directed 2026-09-01, in their own words: *"every single one of your
 * exports should say at the bottom, 'This is for business-purpose lending
 * only.'"*
 *
 * ⛔ IT IS NOT A DECORATION. It is the sentence the loan's whole regulatory
 * position rests on: an RTL or a long-term DSCR loan is secured by
 * non-owner-occupied investment property and made for business purposes, which
 * is what keeps it outside the consumer-mortgage rules (TILA / RESPA). A
 * document that reaches a borrower and does not say so is the one that reads as
 * a consumer loan offer.
 *
 * ⛔ THE COMPLETENESS HALF IS DERIVED, WHICH IS THE WHOLE POINT. A hand-kept
 * list of exports is a list that goes stale the day somebody adds the next one —
 * and the failure is SILENT, because nothing anywhere says an export was
 * missed. So this walks the tree for every module that actually produces a
 * document (jsPDF, pdf-lib, or the spreadsheet writer) and requires each one to
 * be classified: STAMPED, or EXCLUDED **with a stated reason**. Add an export
 * and the build fails until somebody decides which it is.
 *
 * ⛔ AND A SOURCE GUARD IS ONLY HALF A PROOF. That a file contains the sentence
 * does not prove it reaches the paper — the wrap, the fit ladder and the
 * footer's own line budget all sit between. The RENDER guards are what prove
 * that, page by page, and they live where the rendering does:
 * `scripts/test-lt-termsheet-render.mjs` (long-term) and
 * `scripts/render-fee-audit.js` (RTL term sheet, five real exports).
 */
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const rel0 = (dir, name) => `${dir}/${name}`;
const check = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok   ${msg}`); } else { fails.push(msg); console.log(`  FAIL ${msg}`); } };

const ROOT = path.join(__dirname, '..');
const SENTENCE = 'This is for business-purpose lending only.';

/** Every module that carries the stamp, and the token that proves it. */
const STAMPED = {
  'web/v2/tools/termsheet.js': SENTENCE,
  'web/v2/tools/rehab-budget.js': SENTENCE,
  'web/v2/tools/track-record.js': SENTENCE,
  'src/lib/track-record-export.js': SENTENCE,
  'src/sitewire/draw-report.js': SENTENCE,
  'src/lib/contractor/gc-pdf.js': SENTENCE,
};

/**
 * Deliberately NOT stamped. Every entry states WHY, because "nothing calls this"
 * must always be either a failure or a recorded decision, never an accident.
 */
const EXCLUDED = {
  'src/lib/esign/iska-pdf.js':
    'a legal instrument the borrower SIGNS. Adding a sentence to an executed document is a legal '
    + 'decision, not a formatting one — raised with the owner rather than taken.',
  'src/lib/esign/noo-affidavit-pdf.js':
    'the non-owner-occupancy affidavit IS the business-purpose certification. It states the fact at '
    + 'length and under signature; a one-line restatement adds nothing and edits a signed form.',
  'src/lib/esign/application-pdf.js':
    'the signed application carries the business-purpose disclosure as its own executed section.',
  'src/lib/esign/disclosure-pdf.js':
    'a disclosure set whose wording is a legal decision — same reason as the Iska.',
  'src/lib/esign/draw-request-pdf.js':
    'a wire-instruction form the borrower signs, not a pricing document — same legal reason.',
  'src/lib/tapes/xlsx-template.js':
    "MACHINE-READ. The investor data tapes are built from the investors' OWN workbook templates and "
    + 'parsed by their intake; an extra line is a change to their file format, not to a document a '
    + 'person reads.',
  'src/lib/tpr-export.js':
    'a ZIP of other documents. It renders no page of its own — each document inside carries its own '
    + 'footer.',
  'src/lib/track-record/export-doc.js':
    'a saved copy of the track record built from the same rows as track-record-export.js, which is '
    + 'stamped.',
  'src/sitewire/draw-packet.js':
    'an internal accounting workbook for the draw desk — figures for our own ledger, never sent to a '
    + 'borrower as loan terms.',
  'src/lib/reporting.js': 'internal operational reporting spreadsheets.',
  'src/routes/admin-exceptions.js': 'the internal policy-exception register.',
  'src/routes/sitewire.js': 'route wiring around the draw exports, which carry their own footers.',
  'src/routes/staff.js': 'route wiring around exports that carry their own footers.',
  'src/sitewire/investor-delivery-send.js': 'attaches documents that carry their own footers.',
  'src/sitewire/sow-line-edit.js':
    'an internal worksheet the draw desk edits line items in — working figures for our own use, never '
    + 'a document sent to a borrower or an investor as terms.',
  'src/trinity/order.js': 'the budget sent to the inspection vendor, on their own schema.',
  'src/trustpoint/report.js': "a vendor's own inspection paperwork, reproduced.",
  'src/lib/xlsx.js': 'the spreadsheet WRITER — a library, not an export.',
  'src/lib/esign/docgen.js': 'dispatches to the builders above.',
  'src/lib/esign/orchestrate.js': 'assembles envelopes from documents that carry their own footers.',
  'src/lib/esign/templates/iska/build-assets.js':
    'a build-time step that prepares template assets. It renders no document at run time and nothing '
    + 'it produces is ever sent to anybody.',
};

/** Reads a document but produces none — a library, never an export. */
const READERS = [
  'src/lib/ai/weak-page-reread.js', 'src/lib/attachments/compress.js', 'src/lib/heic.js',
  'src/lib/image-exif.js', 'src/lib/image-fit.js', 'src/lib/single-flight.js',
  'src/lib/underwriting/authenticity.js', 'src/lib/underwriting/pdf-slice.js',
  'src/routes/underwriting.js', 'src/server.js', 'src/sitewire/media-archive.js',
  'src/lib/track-record/records-stamp.js',
];

console.log('every stamped export says it, in the owner\'s own words');
for (const [rel, token] of Object.entries(STAMPED)) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  check(src.includes(token), `${rel} carries the stamp (${JSON.stringify(token.slice(0, 44))})`);
}

console.log('\nand the sentence is the owner\'s, not a paraphrase');
{
  const ts = fs.readFileSync(path.join(ROOT, 'web/v2/tools/termsheet.js'), 'utf8');
  check(new RegExp(`var BUSINESS_PURPOSE = "${SENTENCE.replace(/[.]/g, '\\.')}"`).test(ts),
    'and the RTL constant is the same sentence, character for character');
}

console.log('\nevery module that PRODUCES a document is classified — the list cannot go stale');
{
  /* Walk the tree rather than trusting a list: the failure this catches is an
     export added next year that nobody stamped, which is silent by nature. */
  const PRODUCES = /require\(['"](jspdf|pdf-lib)|from ['"](jspdf|pdf-lib)|new jsPDF|PDFDocument\.create|require\(['"][^'"]*lib\/xlsx['"]\)/;
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'vendor') continue;
      /* ⛔ LONG-TERM IS OUT OF THIS SWEEP, AND THAT IS THE PRODUCT-SEPARATION RULE
         RATHER THAN AN OMISSION. LT tests live only in `scripts/test-lt-*`, so an
         RTL guard must not become the thing that decides whether an LT export is
         compliant — the two would then fail each other's builds. Long-Term guards
         its own: `test-lt-termsheet-pure.js` asserts the stamp on all three sheet
         kinds and on the override that could take it away, and
         `test-lt-termsheet-render.mjs` asserts it on the paper, page by page. */
      if (rel0(dir, e.name) === 'src/longterm') continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(rel); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (PRODUCES.test(src)) found.push(rel);
    }
  };
  walk('src'); walk('web/v2/tools');

  check(found.length >= 20, `${found.length} document-producing modules found — a handful would prove nothing`);
  const unclassified = found.filter((f) => !STAMPED[f] && !EXCLUDED[f] && !READERS.includes(f));
  check(unclassified.length === 0,
    `every one of them is stamped, excluded with a reason, or a reader — unclassified: ${unclassified.join(', ') || 'none'}`);
  const noReason = Object.entries(EXCLUDED).filter(([, why]) => !why || why.length < 30).map(([f]) => f);
  check(noReason.length === 0,
    `and every exclusion states WHY, at length — bare: ${noReason.join(', ') || 'none'}`);
  const stale = [...Object.keys(STAMPED), ...Object.keys(EXCLUDED), ...READERS]
    .filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check(stale.length === 0, `and no entry names a file that no longer exists (${stale.join(', ') || 'none'})`);
}

console.log(`\n${fails.length ? `${fails.length} FAILED` : 'ALL PASSED'} (${pass} checks)`);
process.exit(fails.length ? 1 : 0);

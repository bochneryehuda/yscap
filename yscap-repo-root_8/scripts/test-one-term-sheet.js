'use strict';
/**
 * test-one-term-sheet.js — THERE IS ONE TERM SHEET, AND IT IS THE STUDIO'S SIX-PAGER
 * (owner-directed 2026-08-14). Pure: source + module inspection, no DB, no network.
 *
 * WHY THIS TEST EXISTS. On 2026-08-06 a fix to the DocuSign SEND PATH (a real dead
 * end — the sender refused any sheet not stamped FINAL, and the remedy it named
 * could not produce one) was implemented by BUILDING the term sheet on our server.
 * That required a new renderer, and the new renderer drew a DIFFERENT, three-page
 * document. Nothing failed: it generated, the DocuSign anchors landed, envelopes
 * sent, borrowers signed. It went out on real files for eight days and was caught
 * only when a human put two signed PDFs side by side.
 *
 * So the thing worth guarding is not a behaviour — it is the SHAPE of the system:
 * exactly one producer of term-sheet PDFs (the Term Sheet Studio, in the browser),
 * and no server-side path that can quietly become a second one. Every assertion
 * below was verified to FAIL against the 2026-08-06 tree.
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ok  ' + msg); } else { fail++; console.error('  FAIL ' + msg); } }
function read(rel) { return fs.readFileSync(path.join(R, rel), 'utf8'); }

console.log('\nONE TERM SHEET — the studio six-pager is the only one\n');

/* ---- 1. no server-side term-sheet renderer exists ------------------------- */

ok(!fs.existsSync(path.join(R, 'src/lib/esign/term-sheet-pdf.js')),
  'src/lib/esign/term-sheet-pdf.js does not exist (the short renderer stays deleted)');

/* A renderer could come back under any name, so look for what one must contain
   rather than for a filename: a module under src/ that drives the PDF engine AND
   names a term sheet IN CODE. Comments are stripped first — application-pdf.js and
   disclosure-pdf.js legitimately DISCUSS the term sheet in their headers while
   drawing something else, and a guard that reads comments would fire on them (and
   would also fire on the very comments that explain why this guard exists). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const suspects = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.js')) continue;
    const code = stripComments(fs.readFileSync(p, 'utf8'));
    const drawsPdf = /new\s+jsPDF\s*\(|getJsPDF\s*\(\s*\)/.test(code);
    // a function/identifier that IS a term-sheet builder, or the document's own
    // printed title sitting in a string literal
    const isTermSheet = /\bbuild\w*TermSheet\b/i.test(code) || /['"`][^'"`]*Term Sheet[^'"`]*['"`]/.test(code);
    if (drawsPdf && isTermSheet) suspects.push(path.relative(R, p));
  }
})(path.join(R, 'src'));
ok(suspects.length === 0,
  'no module under src/ builds a term-sheet PDF' + (suspects.length ? ' — found: ' + suspects.join(', ') : ''));

/* ---- 2. the sender ATTACHES the stored sheet, it does not generate one ----- */

const orch = read('src/lib/esign/orchestrate.js');
const tsSpec = orch.split('\n').find((l) => /kind: 'term_sheet'/.test(l)) || '';
ok(/freshnessCheck:\s*true/.test(tsSpec),
  "the term_sheet package doc keeps freshnessCheck (it is a STORED document, so it can be stale)");
ok(!/generate:\s*true/.test(tsSpec),
  "the term_sheet package doc is NOT generate:true — the studio draws it, the sender attaches it");

ok(!/buildTermSheetView/.test(orch),
  'orchestrate no longer assembles a term-sheet render view (buildTermSheetView is gone)');
ok(!/termsheet:/.test(orch),
  'loadDocGenData no longer emits a `termsheet` view for a renderer to draw');

const docgen = read('src/lib/esign/docgen.js');
const buildersLine = docgen.split('\n').find((l) => /^const BUILDERS =/.test(l)) || '';
ok(buildersLine && !/term_sheet\s*:/.test(buildersLine),
  'docgen BUILDERS has no term_sheet entry (adding one re-creates the second document)');
ok(!/require\(['"]\.\/term-sheet-pdf['"]\)/.test(docgen),
  'docgen does not require a term-sheet renderer');

/* ---- 3. the send still refuses an INITIAL sheet, and names the way out ----- */

ok(/d\.kind === 'term_sheet' && doc\.term_sheet_final !== true/.test(orch),
  'the sender still refuses a stored sheet not recorded FINAL (the wrong document never goes out)');
ok(/ts_final_override_by/.test(orch),
  'the super-admin override past that refusal is still there (never a dead end)');

const stamp = read('src/lib/esign/term-sheet-stamp.js');
const msg = (stamp.match(/const REGENERATE_MESSAGE =([\s\S]*?);/) || [])[1] || '';
ok(/Finalize & send/.test(msg),
  'the refusal points at the "Finalize & send" button — the remedy that CAN produce a FINAL sheet');
ok(!/re-register the product/.test(msg),
  'the refusal no longer says "re-register the product" (the wording that produced the loop)');

/* ---- 4. the panel can offer to finalize again ------------------------------ */

const tracking = read('src/lib/esign/tracking.js');
const blockFn = (tracking.match(/async function termSheetStampBlock[\s\S]*?\n}/) || [''])[0];
ok(/term_sheet_final/.test(blockFn),
  'termSheetStampBlock reads the real stamp off the stored document');
ok(/canFinalize = !!stamp\.final && (?:!final|block)/.test(blockFn),
  'termSheetStampBlock computes canFinalize (hard-coding false silently disables the finalize buttons)');
ok(!/final: true, block: false, message: null, canFinalize: false/.test(blockFn),
  'termSheetStampBlock does not report a hard-coded "always final, never blocked"');

/* ---- 5. Products & Pricing stamps FINAL when the file is ready ------------- */

const panel = read('app-v2/src/components/ProductStudioPanel.jsx');
ok(/const stampFinal = !!\(resp && resp\.termSheetFinal\)/.test(panel),
  'the register path stamps FINAL when the server says the file is ready to issue');
ok(/setProvenance\(stampFinal \? 'file_final' : 'file'\)/.test(panel),
  'ONE generator, two stamps — file_final vs file, nothing else differs');
ok(/setProvenance\('file_final'\)/.test(panel),
  'finalizeTermSheet still re-stamps the same studio sheet as FINAL');

/* ---- 6. the borrower's terms email attaches the stored sheet --------------- */

const terms = read('src/lib/terms-notify.js');
ok(!/buildTermSheet/.test(terms),
  'the borrower terms email does not RENDER a term sheet (it leaked the short one from 2026-08-12)');
ok(/doc_kind = 'term_sheet'/.test(terms),
  'the borrower terms email attaches the STORED studio sheet');
ok(/d\.created_at >= pr\.created_at/.test(terms),
  "it attaches only THIS registration's sheet — never the pre-change one the studio has not replaced yet");

/* ---- 7. the studio still draws all six pages ------------------------------- */

const studio = read('web/v2/tools/termsheet.js');
for (const [needle, what] of [
  ['Disclosures & conditions', 'the disclosures page'],
  ['Acceptance & signatures', 'the signature page'],
  ['Your pricing at every leverage level', 'the pricing ladder page'],
  ['Inputs & Loan Derivation', 'the inputs & derivation page'],
  ['How your loan amount is built', 'the loan-build explainer'],
  ['Estimated cash to close', 'the cash-to-close card'],
]) ok(studio.includes(needle), `the studio still draws ${what}`);

for (const anchor of ['/ts_b1_sig/', '/ts_b1_dt/', '/ts_b2_sig/', '/ts_lo_sig/', '/ts_admin_sig/']) {
  ok(studio.includes(anchor), `the studio still seeds the DocuSign anchor ${anchor}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

/* THE XML APPRAISAL PREVIEW'S CLOSE BUTTON "DIDN'T WORK" — because the tab was frozen
 * (owner-reported 2026-08-26: "When I preview the XML appraisal the close button doesn't
 * work, I have to exit the loan"). A MISMO appraisal XML embeds the whole report PDF as
 * base64 — one unbroken multi-megabyte line — and the upload doors store the browser's
 * 'text/xml' verbatim, so DocPreview's generic text branch `blob.text()`ed the WHOLE
 * 7–30 MB file and laid it out with break-word: the main thread locked, and Close, Esc
 * and the backdrop (all correctly wired) simply never ran.
 *
 * A pure source guard over the fix, at its ONE chokepoint (DocPreview is opened from
 * ~16 call sites, and the fix in the viewer covers every caller AND every already-stored
 * text/xml row — previous and future files):
 *   1. XML is recognised EXPLICITLY (type or .xml/.mismo name) and routed into the
 *      capped branch;
 *   2. the text branch reads AT MOST the cap (blob.slice), never the whole blob;
 *   3. a truncated view says so honestly (the no-silent-caps rule);
 *   4. Close stays wired;
 *   5. the SECONDARY finding from the same report: AppraisalPanel's full-report overlay
 *      sits BELOW the app dialog layer (.cv-modal-back z 200) — at its old z 1000 a
 *      confirm raised from inside the report rendered invisibly underneath it, which
 *      also presented as "nothing responds, I must leave the loan".
 * Run: node scripts/test-doc-preview-cap-pure.js
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

const dpRaw = read('app-v2/src/components/DocPreview.jsx');
const dp = strip(dpRaw);

// 1. XML recognised explicitly, before/into the capped branch.
ok(/const isXml = !isHtml && \(type\.includes\('xml'\) \|\| \/\\\.\(xml\|mismo\)\$\/\.test\(name\)\)/.test(dp),
  '1 XML is recognised by TYPE and by NAME (.xml/.mismo) — never left to the generic text test');
ok(/else if \(isXml \|\| isText\)/.test(dp),
  '1b …and routed into the SAME capped branch as text');

// 2. The branch reads at most the cap.
const branch = dp.slice(dp.indexOf('else if (isXml || isText)'), dp.indexOf("if (!alive) { if (urlRef.current)"));
ok(/const CAP = 256 \* 1024/.test(branch) && /blob\.slice\(0, CAP\)/.test(branch),
  '2 the read is CAPPED at 256 KB via blob.slice');
ok(!/await blob\.text\(\)/.test(branch),
  '2b the branch never blob.text()s the whole file (that is the freeze)');
ok(/truncated = blob\.size > CAP \? blob\.size : 0/.test(branch),
  '2c what was cut is MEASURED, so the note can state the real size');

// 3. The truncation is said out loud (no silent caps).
ok(/Showing the first 256 KB/.test(dpRaw) && /download it to read the rest/i.test(dpRaw),
  '3 a truncated view says so and points at the download');

// 4. Close stays wired.
ok(/onClick=\{onClose\}>Close/.test(dp), '4 the Close button still calls onClose');

// 5. The full-report overlay sits below the dialog layer.
const ap = strip(read('app-v2/src/components/AppraisalPanel.jsx'));
const overlayAt = ap.indexOf("className=\"appr-print-root\"");
const overlay = ap.slice(overlayAt, overlayAt + 600);
ok(overlayAt > -1 && /zIndex: 190/.test(overlay) && !/zIndex: 1000/.test(overlay),
  '5 the appr-print-root overlay is z 190 — above the preview/overview, BELOW every .cv-modal-back dialog (z 200)');

console.log(`\ndoc-preview-cap: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

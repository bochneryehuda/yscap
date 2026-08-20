'use strict';
/* SharePoint document-mirror failure → loan-officer email copy (owner-directed 2026-07-21).
 * A failed document mirror must email the file's LO with DOCUMENT-specific, plain-language copy —
 * never the generic file-link copy ("create the file / link it to an existing one"), which lists the
 * wrong actions. Pure (NO DB, NO network). Run: node scripts/test-sharepoint-doc-lo-email.js */
const assert = require('assert');
const sr = require('../src/lib/sync-review');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// helper is exported + pure
assert.strictEqual(typeof sr.sharepointDocEmail, 'function', 'sharepointDocEmail exported');

// names the borrower + the specific document detail, says it is about SAVING to SharePoint
let c = sr.sharepointDocEmail({ borrowerName: 'Jane Smith', portalValue: 'appraisal.pdf — stuck 9h: 503 error' });
assert.ok(/Jane Smith/.test(c.title) && /Jane Smith/.test(c.body), 'names the borrower');
assert.ok(/SharePoint/i.test(c.title) && /team drive/i.test(c.body), 'says it is about the SharePoint team drive');
assert.ok(/appraisal\.pdf/.test(c.body), 'includes the specific document detail (portal_value)');
ok('names the borrower + the specific document, framed as a SharePoint save problem');

// tells the LO the RIGHT next steps — retry / re-check filing / re-upload — NOT create/link a file
assert.ok(/retry/i.test(c.body) && /re-check|re-upload|upload it again/i.test(c.body), 'offers the correct next steps');
assert.ok(!/create the file/i.test(c.body) && !/link it to an existing/i.test(c.body), 'does NOT show the misleading file-link actions');
ok('offers the correct document actions, not the generic file-link actions');

// degrades cleanly with no borrower name / no detail
c = sr.sharepointDocEmail({});
assert.ok(c.title && c.body && !/ for undefined/.test(c.title) && !/undefined/.test(c.body), 'no borrower → clean copy, no "undefined"');
assert.ok(/SharePoint/i.test(c.title), 'still a SharePoint-save title with no inputs');
ok('degrades cleanly when the borrower name / detail are missing');

// TELLS THE TRUTH ABOUT WHETHER PILOT IS STILL RETRYING (owner-reported 2026-08-20).
// The four verdicts the integrity audit writes leave sharepoint_backed_up_at SET, and
// every selector that feeds the mirror requires it NULL — so for those PILOT is NOT
// retrying, and saying it is decides whether the officer opens the screen today.
c = sr.sharepointDocEmail({ borrowerName: 'ASHER SALAMON',
  portalValue: 'Assignment.pdf \u2014 its mirror copy is no longer in SharePoint',
  rawValue: JSON.stringify({ docId: 'x', kind: 'item-missing' }) });
assert.ok(!/keeps retrying on its own/i.test(c.body), 'an item-missing card does NOT claim PILOT keeps retrying');
assert.ok(/will NOT put it back on its own/i.test(c.body), 'it says plainly that PILOT has stopped');
assert.ok(/not in the drive/i.test(c.body), 'it says the document is not in the drive until they act');
assert.ok(/retry/i.test(c.body), 'it still names the retry action');
for (const kind of ['local-missing', 'source-suspect', 'malware-flagged']) {
  const k = sr.sharepointDocEmail({ portalValue: 'x', rawValue: JSON.stringify({ kind }) });
  assert.ok(!/keeps retrying on its own/i.test(k.body), `${kind} does not claim PILOT keeps retrying`);
}
// An upload failure genuinely IS retried — that copy must not change.
c = sr.sharepointDocEmail({ borrowerName: 'Jane', portalValue: 'appraisal.pdf \u2014 stuck 9h: 503',
  rawValue: JSON.stringify({ docId: 'x', errorClass: 'transient', error: '503' }) });
assert.ok(/keeps retrying on its own/i.test(c.body), 'an upload-failure card still says PILOT keeps retrying');
// Unreadable / absent raw_value falls back to the retrying copy (never a false "stopped").
for (const raw of [undefined, null, '', 'not json', '{}', JSON.stringify({ docId: 'x' })]) {
  const f = sr.sharepointDocEmail({ portalValue: 'x', rawValue: raw });
  assert.ok(/keeps retrying on its own/i.test(f.body), `raw_value ${JSON.stringify(raw)} falls back to the retrying copy`);
}
ok('says truthfully whether PILOT is still retrying, per verdict, and falls back safely');

// the field_key list guard: sharepoint_doc is no longer in the generic fileLevel set (it has its own copy)
const srcFile = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/sync-review.js'), 'utf8');
const fileLevelLine = srcFile.split('\n').find((l) => l.includes('const fileLevel = ['));
assert.ok(fileLevelLine && !/'sharepoint_doc'/.test(fileLevelLine), 'sharepoint_doc removed from the generic fileLevel copy list');
assert.ok(/isSharepointDoc\s*=\s*row\.field_key === 'sharepoint_doc'/.test(srcFile), 'isSharepointDoc branch present');
ok('sharepoint_doc routes to its own copy, not the generic file-level copy');

console.log(`\nAll ${n} SharePoint doc LO-email checks passed.`);

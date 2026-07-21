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

// the field_key list guard: sharepoint_doc is no longer in the generic fileLevel set (it has its own copy)
const srcFile = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/sync-review.js'), 'utf8');
const fileLevelLine = srcFile.split('\n').find((l) => l.includes('const fileLevel = ['));
assert.ok(fileLevelLine && !/'sharepoint_doc'/.test(fileLevelLine), 'sharepoint_doc removed from the generic fileLevel copy list');
assert.ok(/isSharepointDoc\s*=\s*row\.field_key === 'sharepoint_doc'/.test(srcFile), 'isSharepointDoc branch present');
ok('sharepoint_doc routes to its own copy, not the generic file-level copy');

console.log(`\nAll ${n} SharePoint doc LO-email checks passed.`);

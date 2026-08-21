#!/usr/bin/env node
'use strict';
/* THE SOW EXCEL IMPORT'S GUARDS + DRAG-AND-DROP (owner-directed 2026-08-18).
 *
 * The tool is a browser IIFE, so these are SOURCE guards (the repo's accepted
 * pattern where a DOM is out of reach — cf. test-app-dialog-pure §C2): they pin
 * the STRUCTURE that makes the wrong-sheet class impossible, so a refactor that
 * quietly re-orders the mutation before the validation, drops the file-identity
 * override, or unwires the drop target fails the build.
 *
 *   1. importFile(file) exists and importXlsx delegates to it (drag-and-drop
 *      and the button share ONE flow).
 *   2. VALIDATE BEFORE MUTATE: the taxonomy check and the loan-file identity
 *      override both appear BEFORE the `S=Object.assign(blank(),stt)` state
 *      replacement in the import path.
 *   3. THE LOAN FILE'S IDENTITY WINS: the URL-seeded address/target overwrite
 *      the sheet's before the state lands.
 *   4. The drop target is wired (dragover preventDefault — without it the
 *      browser NAVIGATES to the dropped file) and the halo class exists in the
 *      stylesheet.
 *   5. An edited asset carries a MOVED cache-buster (these assets are cached
 *      hard, so a stale ?v= serves the old file). Derived from the asset's own
 *      content hash, never a pinned literal that fails on the next correct bump.
 */
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const js = fs.readFileSync(path.join(__dirname, '../web/v2/tools/rehab-budget.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../web/v2/tools/rehab-budget.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../web/v2/tools/rehab-budget.css'), 'utf8');

// 1. one flow
ok('importFile exists', /async function importFile\(file\)/.test(js));
ok('the input wrapper delegates to it', /function importXlsx\(input\)\{[^}]*return importFile\(file\)/.test(js));
ok('importFile is exported on RB', /return \{ share, exportXlsx, importXlsx, importFile,/.test(js));

// 2 + 3. order: decode → validate/identity → mutate. Found by position in the
// importFile body (everything before the next function declaration).
const body = js.slice(js.indexOf('async function importFile'), js.indexOf('async function importXlsx'));
const mutateAt = body.indexOf('S=Object.assign(blank(),stt)');
const validateAt = body.indexOf('dropped.push(k)');
const identityAt = body.indexOf('stt.address=fileAddr');
const targetAt = body.indexOf('stt.target=String(Math.round(fileTarget))');
ok('the import body mutates state exactly once', mutateAt > 0 && body.indexOf('S=Object.assign(blank(),stt)', mutateAt + 1) === -1);
ok('taxonomy validation runs BEFORE the state replacement', validateAt > 0 && validateAt < mutateAt);
ok('the loan file’s address wins BEFORE the state replacement', identityAt > 0 && identityAt < mutateAt);
ok('the loan file’s budget wins BEFORE the state replacement', targetAt > 0 && targetAt < mutateAt);
ok('a disagreement is SAID, never silent', /own values were KEPT/.test(body));
ok('dropped line items are counted, never silent', /could not be matched to the current work list/.test(body));
ok('the success flash names address + budget + line-item count', /line item/.test(body) && /budget \$/.test(body));

// 4. drag-and-drop — the page delegates now, and the delegation is what can break HERE.
ok('the import input is marked for the shared drop module',
  /<input id="rb-import"[^>]*\bdata-ys-drop\b/.test(html));
ok('…and the page loads that module', /<script src="drop-import\.js\?v=/.test(html));
ok('…and a dropped file still runs the SAME import flow, because the module feeds this input',
  /<input id="rb-import"[^>]*onchange="RB\.importXlsx\(this\)"/.test(html));
ok('this page keeps its OWN halo wording rather than the module’s generic one',
  /data-ys-drop-class="rb-dropping"/.test(html));
ok('the halo class exists in the stylesheet', /body\.rb-dropping/.test(css));
// The rule LEFT this file on 2026-08-21. A private copy growing back is how the four tools
// drift apart again, which is the whole reason it was shared.
ok('the page keeps no private copy of the drop handling',
  !/function wireDrop\(/.test(js) && !/\.dataTransfer\b/.test(js));

// 5. cache busters
// These assets are cached HARD, so an edit that does not bump the ?v= serves the
// STALE file to every browser that has been here before -- the tool looks unfixed.
// Pinning the literal buster ("?v=dnd1") could not express that rule: it says "the
// buster is exactly this", which is FALSE the moment somebody legitimately edits the
// tool, so it failed on the CORRECT action and passed on the wrong one (edit the JS,
// leave the buster, and the old assertion was perfectly happy).
// So the requirement is derived from the asset's OWN CONTENT: change the file and its
// hash stops matching, which is the one moment the buster has to move. Bump the ?v=
// in rehab-budget.html and paste the new sha printed below.
const crypto = require('crypto');
const sha16 = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
const ASSETS = [
  { file: 'rehab-budget.js', body: js, sha: 'd573e52ce7c4afa1', v: 'flow2-shareddrop' },
  { file: 'rehab-budget.css', body: css, sha: 'af87860acdbf456c', v: 'dnd2' },
];
for (const a of ASSETS) {
  const seen = sha16(a.body);
  ok(`${a.file} is unchanged, or its cache-buster moved with it`
    + (seen === a.sha ? '' : ` — it changed (sha ${seen}); bump ?v= in rehab-budget.html and update this line`),
    seen === a.sha);
  const m = new RegExp(a.file.replace('.', '\\.') + '\\?v=([A-Za-z0-9_-]+)').exec(html);
  ok(`${a.file} is loaded with a cache-buster`, !!m);
  if (m) ok(`${a.file}'s cache-buster is the one this test was pinned against`, m[1] === a.v);
}

console.log(`test-sow-import-guards-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

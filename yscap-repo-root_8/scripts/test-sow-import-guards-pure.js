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
 *   5. The HTML cache-busters were bumped (these assets are cached hard).
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

// 4. drag-and-drop
ok('dragover prevents the browser navigating to the file', /\["dragenter","dragover"\]\.forEach\(ev=>document\.addEventListener\(ev,function\(e\)\{\s*e\.preventDefault\(\)/.test(js));
ok('the drop handler feeds the SAME import flow', /document\.addEventListener\("drop",function\(e\)\{[\s\S]{0,220}importFile\(f\)/.test(js));
ok('an Outlook virtual file is read through items[].getAsFile', /it\.getAsFile&&it\.getAsFile\(\)/.test(js));
ok('wireDrop runs at init', /function init\(\)\{[^}]*wireDrop\(\)/.test(js));
ok('the halo class exists in the stylesheet', /body\.rb-dropping/.test(css));

// 5. cache busters
ok('rehab-budget.js cache-buster bumped', /rehab-budget\.js\?v=dnd1/.test(html));
ok('rehab-budget.css cache-buster bumped', /rehab-budget\.css\?v=dnd1/.test(html));

console.log(`test-sow-import-guards-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

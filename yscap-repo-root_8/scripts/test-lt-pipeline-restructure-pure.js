'use strict';
/**
 * THE PIPELINE'S RESTRUCTURE, owner-directed 2026-08-23, held in place:
 *
 *   "It should always default to active files. Into your own files. And this
 *    should be like the main thing."  ·  "I can select All and then I can
 *    select ... which loan officer."  ·  "on every column [a] separate search
 *    bar ... the officer should be like a select."
 *
 * And the bug that started it: "I'm clicking on Active, where it says 133 files
 * are active. I'm not seeing even close to that number." The server sent a
 * 50-row page and the screen drew no pager — so the fetch now asks for the whole
 * book and the cap is big enough to hold it, and BOTH halves of that are pinned
 * here, because either one quietly reverting brings the bug back looking exactly
 * like a working screen.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ui = strip(read('app-v2/src/longterm/LtPipeline.jsx'));
const server = strip(read('src/longterm/pipeline.js'));
const route = strip(read('src/longterm/routes/pipeline.js'));

console.log('your own files are the default, not a choice somebody has to make');
check(/useState\('mine'\)/.test(ui),
  'the whose-state starts at "mine" — the owner\'s "this should be like the main thing"');
check(/My files/.test(ui), 'and the control says so in words (the "My files" option)');
check(!/label="Everyone.s files"/.test(ui),
  'the old Everyone’s-first arrangement is gone');

console.log('\nthe officer pick is a SELECT, fed by the server, admins only');
check(/data\.officers/.test(ui) && /<select/.test(ui), 'the screen draws a select from data.officers');
check(/officer: officerId/.test(ui), 'and sends the pick as the officer filter');
check(/viewerAccess\.seesAll\s*\?/.test(server) && /Promise\.resolve\(null\)/.test(server),
  'the server builds the officer list ONLY for a viewer who sees the whole book — a scoped officer gets no roster of colleagues');
check(/effectiveStaffSql\('c'\)/.test(server) && /role = 'loan_officer'/.test(server),
  'and builds it from the effective-person expression, so a reassigned file lists under who actually holds it');

console.log('\nthe whole book arrives, and the cap is honest');
check(/limit: 1000/.test(ui), 'the screen asks for the whole book (limit 1000)');
check(/const MAX_LIMIT = 1000;/.test(server), 'and the server cap holds it — 200 would silently re-cut it');
check(/limit: req\.query\.limit/.test(route), 'the route passes the ask through');
check(/data\.total > data\.loans\.length/.test(ui),
  'and a book that ever outgrows the fetch is SAID on screen, not silently cut');

console.log('\none search per column');
check(/aria-label=\{`Search \$\{c\.label\}`\}/.test(ui), 'a search box is drawn per column, labelled by the column');
check(/cellSearchText/.test(ui), 'filtering matches WHAT THE CELL SHOWS (one shared definition)');
check(/\$\{money\(raw\)\} \$\{String\(raw\)\}/.test(ui),
  'a typed amount matches the formatted text AND the raw digits — either habit finds the row');
check(/c\.kind === 'contact'/.test(ui) && /All<\/option>/.test(ui),
  'a contact column offers the people on the rows as a select, not a text box');
check(/shownLoans\.map\(/.test(ui), 'the body draws the FILTERED rows');
check(/Clear searches/.test(ui), 'and one button clears every column search at once');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

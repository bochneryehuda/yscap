'use strict';
/**
 * LT test — THE FILE SCREEN READS LIKE AN LOS.
 *
 * WHY THIS EXISTS. The owner asked for one thing in particular about this screen
 * (2026-08-24): *"this should be like you click on it, and next it comes up with
 * the details, like an LOS works"* — and, in the same breath, that ClickUp
 * syncing be brought DOWN rather than sitting at the top of the file.
 *
 * That is a LAYOUT promise, and a layout promise has no runtime error to catch it.
 * A green Vite build proves the file parses; it proves nothing about whether the
 * sections still open in place, whether ClickUp is still at the bottom, or whether
 * a section the server greyed still answers with its reason. Every one of those
 * can be undone by a tidy-up that looks harmless, silently, forever.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. Geometry — clipping, overlap, sideways scroll
 * on a phone — cannot be judged from source and is checked by rendering the real
 * component against the real built stylesheet in a browser. This suite guards the
 * STRUCTURE that browser check assumes.
 *
 * PURE. Reads source. No database, no network, no browser.
 */

const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/** The comments here EXPLAIN these rules and necessarily quote the shapes being
 *  forbidden, so a guard that read them would fail on its own explanation — and
 *  then get "fixed" by deleting the explanation. */
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const ui = code('app-v2/src/longterm/LtLoan.jsx');
const server = code('src/longterm/workspace.js');

// ── 1. Every section is on the page at once, in the server's order ───────────
console.log('the whole file is on one page, each section opening in place');

check(/sections\.map\(\(s2\) => \(\s*<LtSection/.test(ui),
  'the screen draws EVERY section the server named, as its own openable section');
check(!/active === '/.test(ui) && !/setActive\(/.test(ui),
  'and no longer swaps ONE room at a time — the old tab switcher is gone, not merely hidden');
check(!/sections\s*\.\s*(sort|reverse|filter)\(/.test(ui) && !/\[\.\.\.sections\]\s*\.\s*sort/.test(ui),
  'the ORDER is the server\'s own, never re-sorted here — which is what puts ClickUp syncing at the bottom');

// The server is the one that decides the order, so the claim above is only worth
// anything if ClickUp really is last THERE. Derived from the server's own list,
// never a second copy of it.
const sectionsBlock = (server.match(/const SECTIONS = \[([\s\S]*?)\n\];/) || [])[1] || '';
const serverKeys = [...sectionsBlock.matchAll(/key: '([a-z_]+)'/g)].map((m) => m[1]);
check(serverKeys.length >= 12, `the server's section list is readable (${serverKeys.length} sections)`);
check(serverKeys[serverKeys.length - 1] === 'clickup',
  `ClickUp syncing is the LAST section the server names (${serverKeys[serverKeys.length - 1]}) — the owner asked for it brought DOWN`);
check(serverKeys[0] === 'summary', `the loan summary leads (${serverKeys[0]})`);

// ── 2. A shut section costs nothing ──────────────────────────────────────────
console.log('a shut section renders nothing at all');

const shell = (ui.match(/function LtSection\(\{[\s\S]*?\n\}\n/) || [])[0] || '';
check(shell.length > 200, 'the section shell is readable');
check(/\{open \? \(\s*<div id=\{`\$\{id\}-body`\}/.test(shell),
  'the body is rendered ONLY while the section is open — the ClickUp panel and the Condition Center each load themselves, so mounting all of them would fire a burst of requests for panels nobody asked to see');
check(/aria-expanded=\{open\}/.test(shell), 'the header says whether it is open');
check(/aria-controls=\{open \? `\$\{id\}-body` : undefined\}/.test(shell),
  'and only points at the body while the body exists');

// ── 3. A section that does not apply still answers ───────────────────────────
console.log('a section that does not apply answers, rather than doing nothing');

check(/Not on this file/.test(shell),
  'a section the server greyed says so on its face, before anybody clicks it');
check(/if \(!s\.available\) \{[\s\S]{0,200}\{s\.why\}/.test(ui),
  'and opening it shows the SERVER\'s own reason — never a blank body, and never the section drawn anyway');
check(!/disabled/.test(shell),
  'the header is never disabled — a control that does nothing when pressed teaches people the screen is broken');

// ── 4. The index opens; it never shuts ───────────────────────────────────────
console.log('the index on the left opens a section and brings it into view');

check(/onClick=\{\(\) => jumpToSection\(s2\.key\)\}/.test(ui),
  'the index calls the JUMP, not the toggle');
const jump = (ui.match(/const jumpToSection = useCallback\(\(key\) => \{[\s\S]*?\}, \[\]\);/) || [])[0] || '';
check(jump.length > 80, 'the jump is readable');
check(/prev\.has\(key\) \? prev : new Set\(prev\)\.add\(key\)/.test(jump),
  'and it can only ever OPEN — somebody reaching for a section wants to read it, so a second click must never shut the thing they just asked for');
check(/scrollIntoView/.test(jump), 'it scrolls the section into view');
check(!/\.delete\(/.test(jump), 'nothing in the jump removes a section from the open set');

// ── 5. Every section has a line saying what is in it ─────────────────────────
console.log('every section the server can name has a line saying what is inside');

const blurbBlock = (ui.match(/const SECTION_BLURB = \{([\s\S]*?)\n\};/) || [])[1] || '';
const blurbKeys = new Set([...blurbBlock.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]));
const missing = serverKeys.filter((k) => !blurbKeys.has(k));
check(missing.length === 0,
  `every one of the server's sections has its own line${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
const stray = [...blurbKeys].filter((k) => !serverKeys.includes(k));
check(stray.length === 0,
  `and there is no line for a section that does not exist${stray.length ? ` — stray: ${stray.join(', ')}` : ''}`);

// ── 6. The ledger keeps its industry name, and the loan number is said once ──
console.log('the ledger and the loan number');

check(/File Details/.test(ui), 'the ledger is called File Details (owner-directed: an industry name)');
check((ui.match(/Loan number/g) || []).length === 1,
  'the loan number is labelled in exactly ONE place — the owner reported it reading twice at the top');

// ── 7. Dark on paper, always ─────────────────────────────────────────────────
console.log('nothing on this screen is white text on a white card');

check(!/color:\s*['"]?var\(--ink/.test(ui),
  'no --ink* token is used as a text colour — in this palette every one of them is a LIGHT paper colour, so it renders white on white');

console.log(failures ? `\n${failures} FAILED` : '\nlt file screen (pure): all checks passed');
process.exit(failures ? 1 : 0);

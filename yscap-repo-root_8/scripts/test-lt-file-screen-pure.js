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
// THE SYNCING SECTIONS SIT AT THE BOTTOM, below everything about the loan itself
// — the owner asked for ClickUp syncing brought DOWN, and the rule was never about
// that one section: it is that plumbing goes under content. So this pins the
// PROPERTY rather than one section's index, which is what let the Encompass
// syncing section (#52) land beside it without either loosening the guard or
// having to be squeezed in above the plumbing it belongs with.
const SYNCING = ['clickup', 'encompass'];
const tail = serverKeys.slice(-SYNCING.length);
check(SYNCING.every((k) => tail.includes(k)),
  `the syncing sections are the LAST ones the server names (${tail.join(', ')}) — the owner asked for them brought DOWN`);
check(!serverKeys.slice(0, serverKeys.length - SYNCING.length).some((k) => SYNCING.includes(k)),
  '…and none of them appears anywhere above the loan’s own sections');
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

// ── 5b. The plate's opening: the big gold name, and the facts on top ────────
console.log('the milestone the file has attained is the page\'s heading, in gold');

const css = read('app-v2/src/styles.css');
check(/<h1 className="lt-utter">/.test(ui),
  'the milestone name IS the page heading — not a line inside a card under a second heading');
check(/<LtLayout>/.test(ui),
  'and the layout renders no <h1> of its own on this screen, so the milestone is never said twice');
check(/\.lt-utter \.lt-now\{[^}]*color:#8A6A22/.test(css),
  'the attained name is GOLD (owner: "the whole big gold name of the Milestone") — the READABLE gold #8A6A22 rather than the brand #AE8746, which measures 2.98:1 on this paper and fails even the large-text contrast bar. The owner asked for gold, not for a hex');
check(/\.lt-utter \.lt-now\{[^}]*font-size:clamp\(/.test(css),
  'and it is sized to the viewport, so it is big on a desk and still fits a phone');
// THE NEGATIVE IS GONE, AND THIS GUARD IS NOW THE OPPOSITE OF WHAT IT WAS
// (owner-reported 2026-08-25: *"Why does it say 'Not submitted'? ... Just say the
// finishing status that is now, which is 'Submitted'."*). It used to pin the raw
// Encompass name being drawn beside the finished wording whenever the two differ —
// which is nearly every step, by design, so the first word at the top of nearly
// every file was NOT. The raw names still live in the Milestones section, under
// Encompass's own spellings and dates, which is where somebody comparing the two
// systems is looking.
check(!/lt-was/.test(ui) && !/lt-law/.test(ui),
  'THE PLATE SAYS THE STATUS ONCE — no "not <raw> —" prefix, and no law line under it');
check(!/\.lt-utter \.lt-was\{/.test(css),
  '…and the styling that drew it is retired too, so it cannot come back by accident');

console.log('the facts strip sits on top of the file, and carries the loan number');
check(/<div className="lt-facts">/.test(ui), 'the strip is drawn');
check(/\.lt-facts\{[^}]*border-top:[^}]*border-bottom:/.test(css),
  'ruled top and bottom, the way the plate rules it');
check(/\['Loan number', plain\(rail && rail\.loanNumber\), true/.test(ui),
  'the loan number is the strip\'s first cell, in gold — the identity somebody quotes on the phone');
check(/\.lt-fact:first-child \.v\{white-space:nowrap/.test(css),
  'and it can never break across two lines');
check(/\.lt-fact\{[^}]*flex:0 1 auto/.test(css),
  'the cells do not stretch — eight facts do not divide evenly into a row, and a grow factor turns the two that wrap onto a second line into absurdly wide boxes');

// ── 5c. Which column each region sits in ────────────────────────────────────
console.log('the file\'s own details on the left, the picker on the right');

const iRail = ui.indexOf('<Rail rail={rail} />');
const iSecs = ui.indexOf('className="lt-sections"');
const iNav = ui.indexOf('className="card lt-rooms"');
check(iRail > 0 && iSecs > 0 && iNav > 0, 'all three regions are on the page');
// THE DOM ORDER IS DELIBERATELY NOT THE VISUAL ORDER, and both are pinned.
//
// On screen it is the jump menu, the file, then its details (owner-directed
// 2026-08-25: *"the file details should go on the right side and the file, the long
// summary, the milestones, the borrowers, the properties should go on the left side.
// The same setup that we currently have on the RTL site."* — RTL is a menu on the
// left with the sections beside it). That is done with `order` rather than by moving
// the JSX, because menu → file → details is ALSO the right reading order for a
// keyboard and a screen reader, and moving a sticky rail through a grid is a good way
// to break it. So the source order below is not stale — it is the accessible one.
check(iRail < iSecs && iSecs < iNav,
  'the source order is unchanged, which is what a keyboard and a screen reader follow');
check(/gridTemplateColumns: '196px minmax\(0,1fr\) 300px'/.test(ui),
  'THE COLUMNS: a narrow track for the menu, the file, then a wide one for the details — the two swapped widths with their contents, since a menu of section names does not need 300px and sixteen rows of figures cannot live in 186');
check(/\.lt-workspace > \.lt-rooms\{order:1\}/.test(css)
  && /\.lt-workspace > \.lt-sections\{order:2\}/.test(css)
  && /\.lt-workspace > \.lt-ledger\{order:3\}/.test(css),
  'THE ONE THAT MATTERS: `order` puts the menu first, the file second and the DETAILS LAST — which is what actually moves the details to the right-hand side');
check(/@media\(max-width:900px\)\{\s*\.lt-rooms\{order:1\}/.test(css),
  'stacked on a phone the jump menu still comes FIRST — a sixteen-row table of figures between the menu and the content would be a long scroll to reach the work');

// THE SUBJECT ADDRESS ON ONE LINE (owner-directed 2026-08-25: "Subject property
// address: make sure it goes on one line"). It used to be capped at 320px with
// `overflow-wrap:anywhere`, so an ordinary address broke over two or three lines and
// could split mid-word. Three things make one line work and all three are needed:
// nowrap, an ellipsis for the overflow, and `min-width:0` — without the last of
// those a flex item refuses to shrink below its content, `text-overflow` never fires,
// and the cell simply pushes the row wider instead.
check(/\.lt-fact\.wide\{[^}]*min-width:0/.test(css),
  'the subject cell may shrink below its content, which is what lets it be trimmed at all');
check(/\.lt-fact\.wide \.v\{[^}]*white-space:nowrap/.test(css),
  'THE ONE THE OWNER ASKED FOR: the subject address does not wrap');
check(/\.lt-fact\.wide \.v\{[^}]*text-overflow:ellipsis/.test(css),
  '…and an address too long for the row is trimmed rather than cut off mid-air');
check(/title=\{wide \? String\(v\) : undefined\}/.test(ui),
  '…and the full text stays reachable as a tooltip, so nothing is lost to the trim');

// THE PURPOSE IN WORDS, on BOTH places this screen shows one (owner-reported: it
// "should be nicely displayed, not with these lines"). `plain` prints the stored
// code verbatim; `purpose` is the shared formatter, so a screen that still used
// `plain` here would quietly go on showing `rate_term_refinance`.
check(!/\['Purpose', plain\(/.test(ui),
  'no purpose is drawn with the raw-value formatter');
check((ui.match(/\['Purpose', purpose\(/g) || []).length === 2,
  'both the details rail and the header strip write the purpose in words');

// EXACTLY ONE SECTION IS HIGHLIGHTED IN THE MENU (owner-directed 2026-08-25: *"I
// don't like the way every section that you click and you go to the next section,
// that section gets highlighted ... only that section that you click up should be the
// highlighted section."*).
//
// It used to highlight every OPEN section, and a jump never closes one, so three
// clicks left three names lit with nothing saying which you were reading. WHAT IS
// OPEN is still worth knowing, which is why the dot and the highlight are now two
// different facts rather than one being dropped.
check(/const \[focusSec, setFocusSec\] = useState\(/.test(ui),
  'the menu tracks the one section you asked for');
check(/const here = open && s2\.key === focusSec;/.test(ui),
  'THE ONE THAT MATTERS: the highlight is the FOCUSED section, not every open one — and only while it is still open, so closing what you were reading cannot leave its name lit');
check(/background: here \? /.test(ui) && /fontWeight: here \? /.test(ui),
  '…and it is the highlight (the background and the weight) that follows it');
check(/background: open \? GOLD/.test(ui),
  '…while the dot still says which sections are OPEN, which the owner never asked to lose');
check(/setFocusSec\(key\);/.test(ui),
  'clicking a name in the menu moves the highlight to it');

// THE MILESTONE PLATE'S END LABELS HAVE ROOM TO HANG OVER THEIR OWN COLUMN
// (owner-reported 2026-08-25: opening the file on a phone "was messed up ... hovering
// on top of the other one").
//
// MEASURED at an iPhone-12 width in a real browser, not reasoned about: a stop label
// is 128px wide and centred on a column that is 104px once the spine hits its minimum
// width, so it overhangs 12px each side. At column 0 that put "Started" at x = -12 —
// outside the scroll box and unreachable at any scroll position — and the last
// label's right edge 12px past the scrollable width. Both ends now reserve the
// overhang, and `minWidth` grows by the same amount so every column keeps the width
// the two-line label spacing was measured for.
//
// The two must move together: padding without the extra width would squeeze every
// column and re-break the labels the padding was added to protect.
check(/const LABEL_OVERHANG = \d+;/.test(ui),
  'the label overhang is named once rather than typed into two places');
check(/paddingLeft: LABEL_OVERHANG, paddingRight: LABEL_OVERHANG/.test(ui),
  'THE ONE THAT MATTERS: the spine reserves that overhang at BOTH ends, so the first stop label is not cut off');
check(/minWidth: Math\.max\(360, n \* 104\) \+ 2 \* LABEL_OVERHANG/.test(ui),
  '…and the spine grows by the same amount, so the padding cannot squeeze the columns it was added to protect');

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

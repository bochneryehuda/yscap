'use strict';
/**
 * THE "STILL PRICING" DIM RULE ACTUALLY SELECTS SOMETHING.
 *
 * The owner chose, in their own words, to show the gap honestly while the
 * server prices a deal — the figures grey out rather than keep displaying the
 * previous deal's numbers, because a stale number that looks current is worse
 * than a brief flicker.
 *
 * That choice shipped as dead CSS. The rule named `.res-val` and
 * `.prog-card .big`; neither class exists anywhere on the page, so the rule
 * matched zero elements. Nothing failed, nothing warned — a CSS selector that
 * matches nothing is silent by construction, which is exactly why it needs a
 * test and not a careful reading.
 *
 * So: parse the rule out of the shipped HTML and assert every selector in it
 * hits a real element. Pure — no browser, no DB, no network.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'web/v2/tools/term-sheet.html');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const html = fs.readFileSync(PAGE, 'utf8');

// ---------------------------------------------------------------------------
// 1. The rule is present at all
// ---------------------------------------------------------------------------
const PENDING_ATTR = 'data-ts-pending';
ok(html.includes(`:root[${PENDING_ATTR}="1"]`), 'the page carries a pending-state style rule');

// Pull every selector that is gated on the pending attribute.
const selectors = [];
for (const m of html.matchAll(new RegExp(`:root\\[${PENDING_ATTR}="1"\\]\\s*([^,{]+)`, 'g'))) {
  const sel = m[1].trim();
  if (sel) selectors.push(sel);
}
ok(selectors.length > 0, `found ${selectors.length} pending-gated selector(s)`);

// ---------------------------------------------------------------------------
// 2. Every selector matches a real element
// ---------------------------------------------------------------------------
// The page is static HTML plus a script that fills existing nodes, so the
// classes are in the markup. Match on the class tokens rather than running a
// full CSS engine: a class that never appears in any class="" attribute cannot
// possibly be selected, which is the failure being guarded.
const classAttrs = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
const present = new Set();
for (const a of classAttrs) for (const c of a.split(/\s+/)) if (c) present.add(c);

// Classes the SCRIPT adds at runtime are legitimate too — look for them being
// set from js, so a dynamically-added hook is not reported as a typo.
const js = fs.readFileSync(path.join(ROOT, 'web/v2/tools/termsheet.js'), 'utf8');

for (const sel of selectors) {
  const classes = [...sel.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
  ok(classes.length > 0, `selector "${sel}" names at least one class`);
  for (const c of classes) {
    const inMarkup = present.has(c);
    const inScript = new RegExp(`["'\`][^"'\`]*\\b${c}\\b`).test(js);
    ok(
      inMarkup || inScript,
      `"${sel}" -> .${c} exists on the page${inMarkup ? '' : inScript ? ' (added by termsheet.js)' : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. It covers BOTH places a figure is printed
// ---------------------------------------------------------------------------
// A rule that dims only the program cards, or only the detail panel, leaves
// half the sheet reading as settled while it is not.
const joined = selectors.join(' | ');
ok(/\.ts-line\b/.test(joined) || /\.v\b/.test(joined), 'the detail rows are covered');
ok(/\.pcard-/.test(joined), 'the program cards are covered');

// ---------------------------------------------------------------------------
// 4. The seam is the only thing that turns it on, and it is off by default
// ---------------------------------------------------------------------------
const seam = fs.readFileSync(path.join(ROOT, 'web/v2/tools/engine-source.js'), 'utf8');
ok(seam.includes(`'${PENDING_ATTR}'`) || seam.includes(`"${PENDING_ATTR}"`), 'the seam sets the pending attribute');
ok(/if\s*\(\s*mode\(\)\s*!==\s*'server'\s*\)\s*return/.test(seam), 'the seam installs nothing unless it is asked to');
ok(!/YS_ENGINE_SOURCE\s*=\s*['"]server['"]/.test(html), 'the page does not switch the seam on by itself');

console.log(`\n${failures ? 'FAILED' : 'All'} term-sheet pending-CSS checks ${failures ? `— ${failures} failure(s)` : 'passed'}`);
process.exit(failures ? 1 : 0);

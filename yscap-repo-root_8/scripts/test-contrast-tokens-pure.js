#!/usr/bin/env node
/* =====================================================================
   EVERY COLOUR WE SET TEXT IN MUST BE READABLE ON THE SURFACE IT SITS ON
   ---------------------------------------------------------------------
   The portal and the tools are WHITE-FIRST, and the palette was designed
   on a DARK canvas — so several brand colours that were perfectly legible
   as ivory-on-ink became low-contrast ink-on-paper when the canvas turned
   white. Measured on the real rendered screens: the PILOT gold read at
   2.9:1 as an eyebrow label, white-on-gold buttons at 3.3:1, and the
   secondary greys at 3.5:1 — all below the 4.5:1 that ordinary text needs
   to be readable on a normal screen at a normal distance.

   That is not a judgement call that can be re-litigated per component, so
   it lives here as arithmetic: this test reads the ACTUAL token values out
   of the stylesheets and computes the WCAG contrast ratio of every colour
   we set TEXT in against every surface that text is painted on.

   THE PAIRS ARE DECLARED, NOT INFERRED. A stylesheet cannot tell you which
   token is a text colour and which is a hairline — `--gold` is legitimately
   both (a 2px rule at 2.9:1 is fine; a 12px label is not). So each entry
   below names a token, the surfaces it is used as TEXT on, and the size it
   is used at. Add a token to the palette and add its line here, or the
   guard silently stops covering it.

   PURE: no DB, no browser, no network.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---- WCAG 2.1 relative luminance + contrast ------------------------------
const parseHex = (h) => {
  const s = String(h).trim().replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const luminance = (rgb) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const [r, g, b] = rgb.map(f);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const l1 = luminance(parseHex(a)), l2 = luminance(parseHex(b));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

// A token's value as the browser would resolve it, read from a declaration
// block. `block` is a slice of CSS; the LAST definition wins, exactly as the
// cascade resolves it within one block.
const tokenIn = (css, name) => {
  let value = null;
  const re = new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`, 'g');
  for (const m of css.matchAll(re)) value = m[1];
  return value;
};

// ---- the two palettes ----------------------------------------------------
const portalCss = fs.readFileSync(path.join(ROOT, 'app-v2/src/styles.css'), 'utf8');
// The portal's palette is the first :root block.
const portalRoot = portalCss.slice(portalCss.indexOf(':root{'), portalCss.indexOf('*{box-sizing'));

const suiteCss = fs.readFileSync(path.join(ROOT, 'web/v2/suite.css'), 'utf8');
// The tools are forced to the LIGHT theme inside the portal (and stamp
// data-theme="light" themselves), so THAT block is the one that renders.
const lightStart = suiteCss.indexOf(':root[data-theme="light"]{');
const suiteLight = lightStart >= 0 ? suiteCss.slice(lightStart, lightStart + 1400) : '';

// AA for normal text; 3:1 is only allowed for text that is genuinely large
// (>=24px, or >=18.66px bold) and for non-text UI edges.
const AA = 4.5;

/* Each row: [palette, token, [surfaces], why it is text]. A surface is a
   literal so a token whose own value moves cannot silently drag the
   expectation with it. */
const PAPER = '#F6F3EC', WHITE = '#FFFFFF', SOFT = '#F4F1EA', TOOL_PAPER = '#F4F0E7';

const CASES = [
  // --- portal (app-v2) ---
  ['portal', portalRoot, 'gold-ink', [PAPER, WHITE, SOFT], 'gold labels, eyebrows and figures on light'],
  ['portal', portalRoot, 'text', [PAPER, WHITE, SOFT], 'body text'],
  ['portal', portalRoot, 'text-muted', [PAPER, WHITE, SOFT], 'secondary text'],
  ['portal', portalRoot, 'text-soft', [PAPER, WHITE, SOFT], 'tertiary text'],
  ['portal', portalRoot, 'teal-br', [PAPER, WHITE, SOFT], 'links'],
  ['portal', portalRoot, 'danger', [PAPER, WHITE, SOFT], 'error text'],
  ['portal', portalRoot, 'success', [PAPER, WHITE, SOFT], 'success text'],
  ['portal', portalRoot, 'warning', [PAPER, WHITE, SOFT], 'warning text'],
  // --- investor suite + tools (web/v2) ---
  ['tools', suiteLight, 'gold-ink', [TOOL_PAPER, WHITE], 'tool eyebrows, rank labels and totals'],
  ['tools', suiteLight, 'muted', [TOOL_PAPER, WHITE], 'secondary text'],
  ['tools', suiteLight, 'muted-2', [TOOL_PAPER, WHITE], 'field labels and units'],
  ['tools', suiteLight, 'good', [TOOL_PAPER, WHITE], 'qualifying / pass text'],
  ['tools', suiteLight, 'warn', [TOOL_PAPER, WHITE], 'warning text'],
  ['tools', suiteLight, 'bad', [TOOL_PAPER, WHITE], 'failing text'],
];

console.log('--- text colours vs the surfaces they are painted on (AA 4.5:1) ---');
for (const [palette, block, token, surfaces, why] of CASES) {
  const value = tokenIn(block, token);
  if (!value) { ok(false, `${palette}: --${token} is defined (${why})`); continue; }
  for (const surface of surfaces) {
    const r = contrast(value, surface);
    ok(r >= AA, `${palette}: --${token} ${value} on ${surface} = ${r.toFixed(2)}:1 (${why})`);
  }
}

/* White text on a filled brand button is the same question with the colours
   the other way round — a gold button with white text was the single worst
   offender on the real screens at 3.31:1. */
console.log('\n--- white text on filled brand buttons ---');
for (const [palette, block, token] of [['portal', portalRoot, 'gold-ink'], ['tools', suiteLight, 'gold-ink']]) {
  const value = tokenIn(block, token);
  if (!value) { ok(false, `${palette}: --${token} is defined`); continue; }
  const r = contrast('#FFFFFF', value);
  ok(r >= AA, `${palette}: white on --${token} ${value} = ${r.toFixed(2)}:1`);
}

/* The DARK surfaces the brand gold is still used on must stay readable too —
   the fix for light backgrounds must not be applied where it would make
   things WORSE. `--gold` stays the brand gold precisely for these. */
console.log('\n--- brand gold on the dark canvases it is still used on ---');
{
  const gold = tokenIn(portalRoot, 'gold');
  ok(!!gold, 'portal: --gold is still defined (the brand gold, for dark surfaces and rules)');
  if (gold) ok(contrast(gold, '#141B22') >= 3, `portal: --gold ${gold} on ink #141B22 = ${contrast(gold, '#141B22').toFixed(2)}:1`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

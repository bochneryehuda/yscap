#!/usr/bin/env node
/**
 * The Long-Term Condition Center's own UI guards.
 *
 * These are SOURCE guards on `app-v2/src/longterm/**`. They exist because the
 * defects they pin are invisible to a build: an over-clipped popup, a control
 * offered on a file it does not belong to, and a form field wired to the wrong
 * writer all compile perfectly and are only wrong on screen.
 *
 * Every "must not appear" assertion runs against the COMMENT-STRIPPED source —
 * the code that removes a trap necessarily NAMES it in a comment, and a guard
 * that read comments would fail on its own explanation and then get "fixed" by
 * deleting the explanation (the lesson `test-staff-view-pure.js` records).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Strip /* *\/ and // comments so a guard never reads its own explanation. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(detail ? `${name} — ${detail}` : name);
}

// ── A. The "More ▾" menu may never be clipped ───────────────────────────────
// Owner-reported 2026-08-31: "When you click on the More button and the
// conditions, it pops up all the things below, and it gets cut off."
// ROOT CAUSE: the condition card wrapped the row AND its expanded body in
// `overflow:hidden`, and `.cond-more-menu` is a `position:absolute` popup drawn
// INSIDE that body — so the card's own edge cut the options off. Measured in a
// real browser against the built stylesheet: the menu ran 333px past the card
// and `elementFromPoint` on the last option hit the page, not the option.
{
  const src = stripComments(read('app-v2/src/longterm/LtFileConditions.jsx'));

  ok('LtFileConditions renders the shared More menu',
    /ConditionActions/.test(src));

  // No inline overflow clip anywhere in the file. A clip on ANY ancestor of the
  // popup reproduces the bug, and every container in this file is one.
  const clips = src.match(/overflow[^,;}\n]*['"]hidden['"]/g) || [];
  ok('no inline overflow:hidden survives in the condition card',
    clips.length === 0,
    `found ${clips.length}: ${clips.join(' | ')}`);

  // And the class-based escape hatch must not be used here either.
  ok('the condition card does not opt into the flush (clipping) card class',
    !/lt-card-flush/.test(src));
}

// ── B. The stylesheet's own popup contract ──────────────────────────────────
// The menu is positioned relative to its `<details>`, so it can only ever be
// clipped by an ancestor — which is why the guard above is on the ancestor and
// not on the menu.
{
  const css = read('app-v2/src/styles.css');
  ok('.cond-more is the positioning context', /\.cond-more\{[^}]*position:relative/.test(css));
  ok('.cond-more-menu is an absolutely-positioned popup',
    /\.cond-more-menu\{[^}]*position:absolute/.test(css));
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED:`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${pass} checks passed`);

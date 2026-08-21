'use strict';
/**
 * THE BORROWER'S DRAW CENTRE — the two rules that, if broken, HIDE the borrower's own action
 * (owner-directed 2026-08-21: a view-only draw centre "with borrower actions that they have to do",
 * "nicely laid out": every draw, the amount, pictures, what was approved, what was not approved,
 * inspector notes).
 *
 * MOST OF THAT SCREEN ALREADY EXISTED and was deliberately left alone (the owner: "if there's
 * anything else they have already, leave it"). What this pins is the three things that changed, and
 * each is a real failure rather than a matter of taste:
 *
 *   1. A DRAW AWAITING THE BORROWER IS NEVER COLLAPSED. Settled draws now open collapsed so a build
 *      six draws deep is readable — and if that rule ever inverted, the one card carrying the Accept
 *      and Dispute buttons would be the one folded shut, and their money would sit still because the
 *      page hid the button. That is strictly worse than the long page it replaced.
 *   2. THE "WAITING FOR YOU" CALLOUT COUNTS ONLY WHAT IS ACTUALLY WAITING. A banner that fires on a
 *      settled draw teaches the reader to ignore banners, and this one is the only prompt they get.
 *   3. EVERY COLOUR IS AN EXPLICIT DARK. `--ink*` is a LIGHT paper colour in this palette (the
 *      names are legacy and they LIE), so using one for text renders white-on-white — the exact
 *      bug that made a whole staff card invisible on 2026-07-26.
 *
 * SOURCE-SHAPE, deliberately: these are decisions taken inline in a React component, and extracting
 * them into exported helpers purely to make them testable would be a worse component. Comments are
 * stripped before every "must not appear" assertion, so an explanation of the rule can never be
 * mistaken for a violation of it.
 *
 * Run: node scripts/test-borrower-draw-center-pure.js
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const raw = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
// Strip block comments AND line comments, so a comment that NAMES a forbidden token (explaining why
// it is forbidden) is never counted as a use of it.
const code = (rel) => raw(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const cssCode = (rel) => raw(rel).replace(/\/\*[\s\S]*?\*\//g, '');

const JSX = 'app-v2/src/components/BorrowerDraws.jsx';
const CSS = 'app-v2/src/styles.css';
const src = code(JSX);

// ---- 1. A draw awaiting the borrower is NEVER collapsed ---------------------
{
  ok('1a "settled" is defined as anything that is NOT awaiting the borrower',
    /const settled = finding\.status !== 'delivered'/.test(src));
  ok('1b …and the card opens by default for exactly the not-settled case, so the Accept and Dispute buttons can never start hidden',
    /const \[open, setOpen\] = useState\(!settled\)/.test(src));
  ok('1c the collapse control is offered ONLY on a settled draw',
    /\{settled && \([\s\S]{0,400}setOpen\(\(v\) => !v\)/.test(src));
  // The actions must live inside the part that `open` governs — otherwise "collapsed" would still
  // show a bare pair of buttons with no results above them to judge.
  ok('1d the detail (results table + actions) is what folds away', /\{!open \? \([\s\S]{0,900}\) : \(<>/.test(src));
}

// ---- 2. The callout counts only what is actually waiting --------------------
{
  ok('2a the awaiting set is exactly the deliveries still owed an answer',
    /const awaiting = findings\.filter\(\(f\) => f\.status === 'delivered'\)/.test(src));
  ok('2b …and the banner renders only when there IS something waiting',
    /\{awaiting\.length > 0 && \(/.test(src));
  ok('2c …says one or many correctly, so it never reads "1 draws"',
    /awaiting\.length === 1[\s\S]{0,200}One draw is waiting/.test(src));
  ok('2d …and jumps to the card it is talking about, which must therefore carry that id',
    /dd-finding-\$\{awaiting\[0\]\.id\}/.test(src) && /id=\{`dd-finding-\$\{finding\.id\}`\}/.test(src));
}

// ---- 3. Which draw this is --------------------------------------------------
{
  ok('3a the card names the draw number', /Draw #\$\{num\} — inspection results/.test(src));
  ok('3b …taken from the rollup, the same source the table above and the PDF are built from',
    /const num = money && money\.number != null \? money\.number : null/.test(src));
  ok('3c …and NEVER invents one: with no number it falls back to the plain title',
    /num == null \? 'Draw inspection results'/.test(src));
}

// ---- 4. Every colour is an explicit dark ------------------------------------
{
  const css = cssCode(CSS);
  const block = (css.match(/\.dd-callout[\s\S]*?\.lnk:focus-visible\{[^}]*\}/) || [''])[0];
  ok('4a the new draw-centre styles are present', block.length > 200);
  // --ink / --ink-1 / --ink-2 / --ink-3 are LIGHT paper colours in this palette. A `color:` taking
  // one renders text white-on-white.
  ok('4b no --ink* token is used as a text colour anywhere in them',
    !/color\s*:\s*var\(\s*--ink/.test(block));
  ok('4c the callout paints its own background, so it never borrows the page\'s',
    /\.dd-callout\{[^}]*background:/.test(block));
  ok('4d …and the text colours are explicit darks', /color:#141B22/.test(block) && /color:#3A4550/.test(block));
  // Colour alone is not an affordance (WCAG 1.4.1) — the inline link is underlined too.
  ok('4e the inline link is underlined, not colour-only', /\.lnk\{[^}]*text-decoration:underline/.test(block));
  ok('4f …and has a visible keyboard focus state', /\.lnk:focus-visible\{[^}]*outline:/.test(block));
  // On a phone a sentence and a button fighting for one line is how a target becomes a sliver.
  ok('4g on a phone the callout button spans rather than being squeezed',
    /@media\(max-width:720px\)\{\.dd-callout\{[^}]*\}\.dd-callout \.btn\{width:100%\}/.test(block));
}

// ---- 5. Nothing the borrower already had was taken away ---------------------
//
// The owner: "if there's anything else they have already, leave it, unless it's something risky."
// These are the pieces that were on the screen before this change and must still be.
{
  for (const [what, re] of [
    ['the per-line inspector note', /inspector_comments/],
    ['the per-line photos', /<MediaStrip/],
    ['what was approved and what was not', /not_approved_cents/],
    ['accepting the results', /\/accept`/],
    ['disputing a line with evidence', /\/dispute`, \{ lines \}/],
    ['the whole-project PDF', /ProjectReportButton/],
    ['requesting the next draw', /EligibilityCard/],
    ['attaching a document to a draw in flight', /AttachToDraw/],
    ['what they actually receive', /net_release_cents/],
  ]) ok(`5 still there: ${what}`, re.test(src));
}

console.log(fail ? `test-borrower-draw-center-pure: ${pass} passed, ${fail} FAILED` : `test-borrower-draw-center-pure: all ${pass} checks passed.`);
process.exit(fail ? 1 : 0);

// LONG-TERM PRICING ENGINE — the results board on a phone (owner-reported 2026-08-30,
// from an iPhone: *"The CSS on a mobile is terribly set up for the results. Terribly
// messed up."*).
//
// TWO DEFECTS, ONE SCREEN, and they are different in kind:
//
//   1. LAYOUT. The board is a flexbox table whose columns need ~696px of content width.
//      The HEADER row does not wrap, so at 390px "Cost / credit" was clipped mid-word and
//      "Monthly P&I" was off the screen; the DATA row DOES wrap, so its figures landed on
//      their own line — under headings that had scrolled away, and in a different order
//      from the ones that had not. Every column label pointed at the wrong number, which
//      on a pricing board is worse than ugly: $2,248.31 sat under "Cost / credit" while
//      being the monthly payment.
//
//   2. CONTENT. Four of the five rows on the owner's screen spent two to four lines
//      printing the SAME programme name twice, because the vendor's `program` and
//      `product` are frequently the same string.
//
// Runs with no bundler and no browser: priceBuild.js is plain ESM, and the layout half is
// asserted against the SOURCE of the screen and the stylesheet. A render test cannot run on
// the build server (no app-v2 install), and the layout rules must be guarded where CI can
// see them.

import { readFileSync } from 'node:fs';
import { programLine, productSaysMore } from '../app-v2/src/longterm/priceBuild.js';

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};
const eq = (a, b, label) => ok(Object.is(a, b), `${label} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);

const SCREEN = readFileSync(new URL('../app-v2/src/longterm/LtPricer.jsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../app-v2/src/styles.css', import.meta.url), 'utf8');
/* Comments are stripped before every "must not appear" assertion: the code that removed the
   duplicated programme line necessarily QUOTES the old shape while explaining itself, and a
   guard that read its own explanation would fail on the fix and then be "fixed" by deleting
   the reasoning. */
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SCREEN_BARE = bare(SCREEN);
const CSS_BARE = bare(CSS);

/* WHERE A CSS RULE SITS IS COUNTED, NOT PATTERN-MATCHED. A regex that strips `@media{…}`
   has to guess where the block ends, and a nested rule's own closing brace ends the match
   early — so a rule moved OUT of the media query still read as "inside" and the guard that
   exists to catch exactly that survived the mutation. Walking the braces gives the real
   depth: a selector at depth 0 is unconditional, at depth 1 it is inside an at-rule. */
function braceDepths(css) {
  const out = []; let depth = 0;
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (c === '{') { out.push(depth); depth += 1; } else if (c === '}') { depth -= 1; out.push(depth); } else out.push(depth);
  }
  return out;
}
const DEPTH = braceDepths(CSS_BARE);
/** Every place a selector for `sel` appears, with the brace depth it sits at. */
function occurrences(sel) {
  const hits = []; let i = CSS_BARE.indexOf(sel);
  while (i !== -1) { hits.push({ at: i, depth: DEPTH[i] }); i = CSS_BARE.indexOf(sel, i + 1); }
  return hits;
}
/** The body of every `@media(max-width:<px>)` block, brace-accurate. */
function mediaBlocks(px) {
  const head = `@media(max-width:${px}px){`;
  const out = []; let i = CSS_BARE.indexOf(head);
  while (i !== -1) {
    let d = 0, j = i + head.length - 1;
    for (; j < CSS_BARE.length; j += 1) {
      if (CSS_BARE[j] === '{') d += 1;
      else if (CSS_BARE[j] === '}') { d -= 1; if (d === 0) break; }
    }
    out.push(CSS_BARE.slice(i, j + 1));
    i = CSS_BARE.indexOf(head, j);
  }
  return out;
}

console.log('\nA. the programme, said once — the owner\'s own four rows');
eq(programLine({ program: '30yr Fixed - DSCR Plus', product: '30yr Fixed - DSCR Plus' }),
  '30yr Fixed - DSCR Plus', 'A1 an identical product is not printed a second time');
eq(programLine({
  program: '30 YR FIXED PREMIUM CORR INVESTOR ADVANTAGE - 5 YR PPP',
  product: '30 YR FIXED PREMIUM CORR INVESTOR ADVANTAGE - 5 YR PPP',
}), '30 YR FIXED PREMIUM CORR INVESTOR ADVANTAGE - 5 YR PPP',
'A2 …including the long one that was costing four lines of a phone screen');
eq(programLine({ program: 'NonQM DSCR FIXED 30', product: '30' }), 'NonQM DSCR FIXED 30',
  'A3 a product already sitting inside the programme adds nothing');
eq(programLine({ program: 'Non-QM DSCR 30Yr Fixed', product: '30Yr Fixed' }), 'Non-QM DSCR 30Yr Fixed',
  'A4 …and the same when it is the tail of the name');

console.log('\nB. nothing a reader could not already read is dropped');
eq(programLine({ program: '30yr Fixed - DSCR Plus', product: 'ARM' }), '30yr Fixed - DSCR Plus · ARM',
  'B1 a product that genuinely says something new is still printed');
eq(programLine({ program: 'DSCR Fixed', product: '5/6 ARM' }), 'DSCR Fixed · 5/6 ARM',
  'B2 …and a partly-new product counts as new');
/* THE TRAP. "30" is not inside "300" — judging on raw substrings would swallow a real
   difference, which is the one way a rule like this loses information rather than noise. */
ok(productSaysMore('NonQM DSCR FIXED 300', '30'),
  'B3 a product is judged on WHOLE TOKENS — "30" is not part of "300"');
ok(!productSaysMore('NonQM DSCR FIXED 30', '30'), 'B3a …while a real whole-token repeat is');
ok(productSaysMore('Investor 30 Year Fixed', 'Investor 30 Year'.replace('30', '31')),
  'B4 …and a token that merely looks similar still says something');
eq(programLine({ program: '', product: '30yr Fixed' }), '30yr Fixed',
  'B5 with no programme name the product is all there is, so it is printed');
eq(programLine({ program: '', product: '' }), '—', 'B6 nothing at all reads as an em dash, never "undefined"');
eq(programLine(null), '—', 'B7 …and a missing quote does not throw');
eq(programLine({ program: '30yr Fixed - DSCR Plus', product: '' }), '30yr Fixed - DSCR Plus',
  'B8 an absent product is simply absent');
eq(programLine({ program: '  30yr Fixed  ', product: '30YR   FIXED' }), '  30yr Fixed  ',
  'B9 casing and spacing are not a difference');

console.log('\nC. ONE definition — every board reads it');
/* A second copy of the programme rule is how one board prints a name twice while another
   prints it once, on the same quote. */
eq((SCREEN_BARE.match(/programLine\(/g) || []).length, 3,
  'C1 all three boards (lender line, the lender\'s other programmes, ineligible) call programLine');
ok(!/\$\{[^}]*\.product\}/.test(SCREEN_BARE) && !/\.product \? `/.test(SCREEN_BARE),
  'C2 …and none of them re-inlines the product concatenation it replaced');
ok(/export function programLine/.test(readFileSync(
  new URL('../app-v2/src/longterm/priceBuild.js', import.meta.url), 'utf8')),
'C3 the rule lives in priceBuild, beside the other programme-label rules');

console.log('\nD. the price column names its lens ONCE');
/* The heading says which comp position the figures are drawn through; on a phone that heading
   is hidden and the SAME words ride on the cell (`data-k`). Two copies could disagree about
   which position is on screen, which is exactly what the heading exists to prevent. */
ok(/const priceKey = comp/.test(SCREEN_BARE), 'D1 the lens label is computed once, as priceKey');
ok(/textAlign: 'right' \}\}>\{priceKey\}<\/span>/.test(SCREEN_BARE),
  'D2 …the column heading reads that one definition');
eq((SCREEN_BARE.match(/priceKey=\{priceKey\}/g) || []).length, 2,
  'D3 …and both priced boards hand it to the cells');
ok(/data-k=\{priceKey \|\| 'Price'\}/.test(SCREEN_BARE),
  'D4 …with a plain "Price" fallback for the board that has no lens');

console.log('\nE. every figure on the phone carries its own label');
for (const k of ['Points', 'Cost / credit', 'Monthly P&I']) {
  ok(SCREEN_BARE.includes(`data-k="${k}"`), `E1 the ${k} cell names itself`);
}
eq((SCREEN_BARE.match(/data-k="Monthly P&I"/g) || []).length, 2,
  'E2 …on the lender line AND on that lender\'s other programmes');
eq((SCREEN_BARE.match(/className="ltq-row"/g) || []).length, 3,
  'E3 all three quote rows are cards on a phone');
eq((SCREEN_BARE.match(/className="ltq-head"/g) || []).length, 2,
  'E4 …and both column headers are marked so they can be hidden');
eq((SCREEN_BARE.match(/className="ltq-name"/g) || []).length, 3,
  'E5 …every row names its investor cell');
eq((SCREEN_BARE.match(/className="ltq-act"/g) || []).length, 3,
  'E6 …and its Details cell');

console.log('\nF. the stylesheet actually restructures the board');
/* THE BREAKPOINT IS READ OUT OF THE STYLESHEET, never retyped here — a guard that carries
   its own copy of the number proves only that the test agrees with itself. */
const BP = Number((CSS_BARE.match(/@media\(max-width:(\d+)px\)\{[^@]*?\.ltq-head\{display:none/) || [])[1] || 0);
const BLOCK = mediaBlocks(BP).join('\n');
ok(BP > 0 && BLOCK.length > 0, `F1 there is a phone block, at ${BP}px`);
ok(/\.ltq-head\{display:none/.test(BLOCK),
  'F2 the column headings are hidden — they cannot line up with anything, so they may not stay');
ok(/\.ltq-row\{[\s\S]*?display:grid/.test(BLOCK), 'F3 the row becomes a grid instead of a wrapping flex row');
ok(/content:attr\(data-k\)/.test(BLOCK),
  'F4 …and each figure prints the label the heading used to carry');
ok(/\.ltq-act\{[\s\S]*?grid-column:1 \/ -1/.test(BLOCK), 'F5 Details gets its own full-width line');
ok(/\.ltq-gap\{flex:0 0 100%/.test(BLOCK),
  'F6 …and "best price" is kept on the same line as the figure it labels');
/* The comparison sheet's anchor is a bare text button (`padding:0`) — 12px tall, which is
   about a quarter of what a thumb reliably lands on, and it is the one choice that sheet is
   really asking for. Phone-only, so the desktop strip is untouched. */
ok(/\.ltq-tap\{[\s\S]*?min-height:3[89]px/.test(BLOCK),
  'F7 the comparison anchor is a real tap target on a phone');
ok(readFileSync(new URL('../app-v2/src/longterm/TermSheetPanel.jsx', import.meta.url), 'utf8')
  .includes('className="ltq-tap"'), 'F7a …and the control actually carries the class');

console.log('\nG. the breakpoint is MEASURED, not chosen');
/* If a column is narrowed later, the table fits sooner and this breakpoint would be firing
   the card layout on a screen that could have held the real table. Derive the requirement
   from the screen's own flex bases rather than trusting the number in the comment. */
const HEAD = SCREEN_BARE.slice(SCREEN_BARE.indexOf('className="ltq-head"'));
const bases = (HEAD.slice(0, 1200).match(/flex: '(?:0 0|2 1) (\d+)px'/g) || [])
  .map((m) => Number(m.match(/(\d+)px/)[1]));
/* Counted, not pinned at six: the PITI column is CONDITIONAL, so the header carries six or seven
   depending on whether the carrying costs were entered. What must hold is that the breakpoint
   covers the WIDEST the table can get — every column the header can draw. */
ok(bases.length >= 6, `G1 every header column is measurable (${bases.length} found)`);
const GAPS = 5 * 10;          // five 10px gaps between six columns
const CARD_PAD = 28;          // the card's own 14px each side
const need = bases.reduce((a, b) => a + b, 0) + GAPS + CARD_PAD;
ok(need > 390, `G2 the table genuinely cannot fit a phone (needs ${need}px)`);
ok(BP >= need, `G3 …and the stylesheet's own breakpoint (${BP}px) is at or above what the table needs (${need}px)`);
ok(need > 640, 'G4 …so a smaller stock breakpoint would have left the table clipped');

console.log('\nH. the phone rules cannot reach the desktop board');
/* Everything here is `!important`, which is how an inline style is overridden — so it MUST
   all live inside the media query, or it would rewrite the desktop table too. */
const ltqRules = occurrences('.ltq-');
ok(ltqRules.length > 0, 'H1 the phone rules are present at all');
ok(ltqRules.every((h) => h.depth >= 1),
  `H1a …and every one of them sits inside an at-rule (${ltqRules.filter((h) => h.depth === 0).length} unconditional)`);
ok(!/color:\s*var\(--ink/.test(BLOCK),
  'H2 no --ink token is used as a text colour (they are LIGHT paper colours in this palette)');
ok(/color:#4B585C/.test(BLOCK), 'H3 …the cell labels are an explicit dark on the white canvas');

console.log(bad === 0 ? '\nOFFLINE: all passed' : `\nOFFLINE: ${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

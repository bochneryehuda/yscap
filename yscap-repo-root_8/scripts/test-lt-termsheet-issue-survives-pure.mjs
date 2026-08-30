// LONG-TERM TERM SHEETS — the issued sheet outlives the cart that made it.
//
// OWNER-REPORTED 2026-08-30: *"the actual Add to Comparison works, but when you add a few things
// and then you export, it doesn't work. It doesn't download anything, and it disappears.
// Everything."*
//
// REPRODUCED AGAINST A REAL SERVER AND A REAL DATABASE BEFORE ANYTHING WAS CHANGED, and every
// server step was sound: the add returned 200, the issue returned 200 with a real ID (TS-M1VWTK),
// the PDF came back as 58,632 bytes of valid `%PDF-`, and replay-by-ID found the sheet. Nothing
// was lost — the sheets are all in the database. What failed was the SCREEN.
//
// THE MECHANISM, and it is a class worth naming: ISSUING EMPTIES THE CART. The server clears it,
// correctly, because the sheet has been made. But the board mounted the comparison strip only
// while the cart HAD something in it —
//
//     {ts.enabled && ts.count > 0 && <ComparisonStrip …/>}
//
// — and the strip is where the "Term sheet issued / TS-XXXXXX / Download the PDF" card lives. So
// the success card was destroyed in the same tick it was created: the officer pressed the button,
// the sheet was written, and the ID and the download button vanished along with the options they
// had collected. Exactly "it doesn't download anything, and it disappears. Everything."
//
// THE RULE THIS PINS: a result may not be rendered inside the thing whose emptiness unmounts it.
// The issued sheet is therefore held in `useTermSheetCart`, ABOVE the cart, and the board keeps the
// strip up while there is a result to read.
//
// Source-asserted rather than rendered, because no unit test of the strip can see its PARENT's
// mount condition — and the parent's mount condition IS the defect. A render suite would have
// mounted the strip directly and passed throughout.

import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};

const PANEL = readFileSync(new URL('../app-v2/src/longterm/TermSheetPanel.jsx', import.meta.url), 'utf8');
const BOARD = readFileSync(new URL('../app-v2/src/longterm/LtPricer.jsx', import.meta.url), 'utf8');
/* Comments are stripped first: the code that fixed this necessarily QUOTES the broken condition
   while explaining itself, and a guard reading its own explanation would fail on the fix. */
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const P = bare(PANEL);
const B = bare(BOARD);

console.log('\nA. the result is held ABOVE the cart it empties');
ok(/export function useTermSheetCart\(\)[\s\S]{0,900}?const \[issued, setIssued\] = useState\(null\)/.test(P),
  'A1 the cart hook holds the issued sheet');
ok(/return \{ \.\.\.state, reload, count: state\.members\.length, issued, setIssued \}/.test(P),
  'A2 …and hands it out, so the board can keep the strip up');

console.log('\nB. the board keeps the strip while there is a result to read');
const mount = (B.match(/\{ts\.enabled &&[^\n]*\(\s*\n?\s*<ComparisonStrip/) || [])[0] || '';
ok(mount.length > 0, 'B1 the board still mounts the strip conditionally');
ok(/ts\.count > 0 \|\| ts\.issued/.test(mount),
  'B2 …and an EMPTY cart no longer unmounts a sheet that was just issued');
ok(/<ComparisonStrip[\s\S]{0,200}?onIssued=\{ts\.setIssued\}/.test(B),
  'B3 …because the strip tells it — the hook existed and was never wired, which is the whole bug');

console.log('\nC. and the strip can still be dismissed');
/* Without this the strip stays mounted for ever on an empty cart: the parent keeps it up while
   `issued` is set, and only the child knows the person pressed Start another. */
ok(/onClick=\{\(\) => \{ setIssued\(null\); if \(onIssued\) onIssued\(null\); \}\}/.test(P),
  'C1 "Start another" clears the result UPSTREAM as well as locally');

console.log('\nD. the card that had been vanishing');
const card = (P.match(/if \(issued\) \{[\s\S]*?^  \}/m) || [])[0] || '';
ok(card.length > 0, 'D1 the issued card is still rendered');
ok(/\{issued\.code\}/.test(card), 'D2 …it shows the ID the officer has to keep');
ok(/termSheetPdf\(issued\.code\)/.test(card), 'D3 …and downloads THAT sheet, by its own ID');

console.log('\nE. the guard cannot be satisfied by the broken shape');
/* The literal condition that shipped the defect. Asserting its ABSENCE is what makes a revert
   fail rather than quietly passing because some other `ts.issued` appears elsewhere in the file. */
ok(!/\{ts\.enabled && ts\.count > 0 && \(\s*\n?\s*<ComparisonStrip/.test(B),
  'E1 the cart-only mount condition is gone');

console.log(bad === 0 ? '\nOFFLINE: all passed' : `\nOFFLINE: ${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

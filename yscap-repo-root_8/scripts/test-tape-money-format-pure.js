'use strict';
/**
 * THE TAPE'S MONEY COLUMNS SHOW WHOLE DOLLARS ON PURPOSE (owner-directed 2026-08-25).
 *
 * THIS SUITE PINS A DECISION, NOT A CORRECTNESS PROPERTY. It exists because the
 * decision is genuinely counter-intuitive next to its own neighbour, and the last
 * A-to-Z rounding sweep found this, set it aside, and then lost it.
 *
 * THE HISTORY. The owner reported (2026-08-24) that a 10.25 rate exported as 10.3 and
 * asked for an A-to-Z sweep of the data tape: *"if you find a bug, let's fix the bug."*
 * The RATE half was a real defect and was fixed — `xlsx-template.FMT.RATE` ('0.00#%')
 * overrides the template's own percent style at the fill chokepoint, so a note rate
 * reads on the tape exactly as it reads on the term sheet. The sweep ALSO found that
 * Fidelis and EMCAP display MONEY as `$#,##0`: a $285,250.55 purchase price prints as
 * "$285,251". Same shape as the rate bug, so the obvious move is to give money the same
 * override.
 *
 * WHY THAT MOVE IS WRONG HERE, and the distinction is the whole point: the rate style
 * was OURS to choose, and the money style is the INVESTOR'S. `$#,##0` comes out of
 * Fidelis's and EMCAP's own template workbooks, which their intake reads. Asked
 * directly on 2026-08-25 with the trade laid out, the owner chose to LEAVE BOTH ALONE
 * — those two investors keep receiving exactly the file shape their templates specify.
 * Blue Lake is untouched either way: it inherits its sample row's styles (`inheritStyles`),
 * so whatever cents behaviour its own template has is what it gets.
 *
 * NOTHING IS LOST IN THE FILE. The cell VALUE keeps its cents — the tape builders do no
 * money rounding, so a formula in the investor's own workbook still computes on
 * 285250.55. It is the display that is whole-dollar.
 *
 * THE ONE PLACE THAT REALLY ROUNDS is `index.roundDollars`, and it is deliberately
 * NOT a cell value: it pre-fills the seasoned-loan confirmation a human then reads and
 * confirms, so the figure a staffer accepts can sit up to 50c from the computed one.
 * That was put to the owner in the same breath and left as-is. Section C keeps it
 * confined to that one caller, so it can never quietly spread onto an exported value.
 *
 * SO: if you are here because a fresh rounding sweep flagged the money columns again —
 * it is not an oversight, it was decided. Reopening it needs the owner's own words,
 * because it changes what two investors receive.
 *
 * Pure: reads source only. No database, no network.
 */

const fs = require('fs');
const path = require('path');

let n = 0, failed = 0;
const ok = (cond, label) => { n++; if (cond) return; failed++; console.error('  ✘ ' + label); };
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/* Comments are stripped before every "must not appear" assertion: this file's own
   subject is a format code, and the modules necessarily QUOTE those codes while
   explaining them — a guard that read comments would fail on the explanation and then
   get "fixed" by deleting it. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ── A. the shared format overrides cover RATE and RATIO — and deliberately no money ──
{
  const tpl = stripComments(src('src/lib/tapes/xlsx-template.js'));
  const m = /const FMT = \{([^}]*)\}/.exec(tpl);
  ok(!!m, 'A1 xlsx-template still declares the shared FMT overrides');
  const body = m ? m[1] : '';
  ok(/RATE:\s*'0\.00#%'/.test(body), 'A2 the RATE override is intact (the fix the owner asked for)');
  ok(/RATIO:\s*'0\.00%'/.test(body), 'A3 the RATIO override is intact');
  /* The decision: no money entry. A `MONEY`/`CURRENCY` key here would push cents onto
     Fidelis and EMCAP, changing what those two investors receive. */
  ok(!/\b(MONEY|CURRENCY|DOLLARS?|CENTS)\s*:/i.test(body),
    'A4 FMT carries NO money override — the investors’ own whole-dollar style stands '
    + '(owner-directed 2026-08-25; reopening changes what Fidelis and EMCAP receive)');
}

// ── B. the two tapes still point their money columns at the template's own style ──
{
  const fid = stripComments(src('src/lib/tapes/fidelis.js'));
  ok(/CURRENCY:\s*57\b/.test(fid),
    'B1 Fidelis money columns use the template’s own style 57 ($#,##0)');
  const em = stripComments(src('src/lib/tapes/emcap.js'));
  for (const [k, v] of [['CUR2', 2], ['CUR4', 4], ['CUR5', 5]]) {
    ok(new RegExp(`${k}:\\s*${v}\\b`).test(em),
      `B2 EMCAP ${k} still points at the template’s own whole-dollar style ${v}`);
  }
  /* Neither tape may start hand-formatting money — that is the same change as A4, made
     one level down where it would be easier to miss. */
  for (const [name, s] of [['fidelis', fid], ['emcap', em]]) {
    ok(!/fmt:\s*['"`]\$?#,##0\.00/.test(s),
      `B3 ${name} sets no per-cell cents format on a money column`);
  }
}

// ── C. the one real rounding stays confined to the confirmation pre-fill ──
{
  const idx = src('src/lib/tapes/index.js');
  ok(/function roundDollars\(/.test(idx), 'C1 roundDollars still exists');
  const code = stripComments(idx);
  const callers = (code.match(/roundDollars\(/g) || []).length - 1; // minus the declaration
  ok(callers > 0, 'C2 roundDollars is actually used (a dead helper would prove nothing)');
  /* Every call must sit inside seasonedConfirmation — the pre-fill a human reads and
     confirms. If it ever reaches a cell builder, an exported figure starts losing its
     cents for real, which is a different decision from the display one above. */
  const fn = /function seasonedConfirmation\(([\s\S]*?)\n\}/.exec(code);
  ok(!!fn, 'C3 seasonedConfirmation is still where the pre-fill is built');
  const inside = fn ? (fn[0].match(/roundDollars\(/g) || []).length : 0;
  ok(inside === callers,
    `C4 every roundDollars call is inside the seasoned-loan confirmation pre-fill `
    + `(${inside}/${callers}) — it must never round a value that is written to a cell`);
}

console.log(`${failed ? '✗' : '✓'} test-tape-money-format-pure: ${n - failed}/${n} checks passed`);
process.exit(failed ? 1 : 0);

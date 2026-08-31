#!/usr/bin/env node
'use strict';
/**
 * AHL — the board, the LLPAs and the refusals, read off the real pages (pure, offline).
 *
 * WHAT THIS GUARDS. AHL answers in HTML, and the two ways HTML parsing fails are
 * both SILENT — it does not throw, it returns something shorter:
 *
 *   1. THE UNESCAPED OPERATORS. AHL's eligible-program adjustment table emits raw
 *      `<` and `>` (`… HCLTV is <=70, And DSCR is >= 1.25`). A strict reader
 *      treats `<=70, And DSCR is >` as a tag and EATS the LTV band and the DSCR
 *      threshold — the two numbers that make the line worth reading.
 *   2. THE NESTED BLOCK BOUNDARY. The per-program blocks nest a `<div>` inside a
 *      `<div>`, so stopping at the first `</div>` truncates and running to the
 *      last one swallows the rest of the page. An early cut of this parser did
 *      the latter and attached 90 KB of script to a program's NAME.
 *
 * So the assertions below are on exact strings containing both operators and on
 * the program names being names. And the arithmetic is checked against AHL's own
 * published price rather than against a number of ours: `basePrice + Σ
 * adjustments = the price AHL printed`, to the thousandth.
 *
 * PROVEN TO FAIL: remove `repairOperators` and OPS-1/OPS-2 go red; bound the
 * blocks at the first `</div>` and NAME-1 goes red; bound them at the document
 * end and NAME-2 goes red; append instead of de-duplicating in `mergeLegs` and
 * MERGE-2 goes red; count declined programs as offers and FAILS-2 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const parse = require('../src/longterm/ahl/parse');
const captured = require('../src/longterm/ahl/capture/legs.json');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass += 1; console.log(`  ok   ${msg}`); } else { fail += 1; console.log(`  FAIL ${msg}`); } }
const CAP = path.join(__dirname, '..', 'src', 'longterm', 'ahl', 'capture');
const boardFor = (key) => parse.parse(fs.readFileSync(path.join(CAP, captured.legs[key].file), 'utf8'), captured.legs[key].leg);

(async () => {
  console.log('\nAHL — the board read off the real pages\n');

  const io40 = boardFor('t40-io-l30');
  const fix30 = boardFor('t30-fix-l30');

  // ── The unescaped operators: the silent one ──────────────────────────────
  {
    const p = io40.programs.find((x) => x.rungCount > 0);
    const dscrLine = (p.adjustments || []).find((a) => /DSCR/.test(a.description || ''));
    ok(dscrLine && /<=\s?70/.test(dscrLine.description) && />=\s?1\.25/.test(dscrLine.description),
      `OPS-1 the adjustment text keeps BOTH raw operators AHL emits unescaped — "${dscrLine ? dscrLine.description.slice(30, 92) : 'MISSING'}"`);
    const ltvLine = (p.adjustments || []).find((a) => /Prepayment Term/.test(a.description || ''));
    ok(ltvLine && /LTV is <=\s?70/.test(ltvLine.description),
      'OPS-2 and the LTV band survives on the prepayment line too, where a strict parser eats it');
    // The correctly-escaped half of the page must still read correctly.
    const declined = io40.programs.find((x) => (x.ineligibleReasons || []).some((r) => /1\.0M/.test(r.rule)));
    ok(declined && declined.ineligibleReasons.some((r) => /<= \$1\.0M/.test(r.rule)),
      'OPS-3 the ESCAPED half of the same page (`&lt;= $1.0M`) still reads correctly — one repair, both halves');
  }

  // ── The block boundary ──────────────────────────────────────────────────
  {
    const names = io40.programs.map((p) => p.program || '');
    ok(names.every((n) => n.length > 0 && n.length < 80),
      `NAME-1 every program name is a NAME (longest ${Math.max(...names.map((n) => n.length))} chars), not a truncation and not 90 KB of script`);
    ok(names.every((n) => !/function|\$\(|var /.test(n)),
      'NAME-2 no program name has swallowed the page\'s JavaScript — the blocks are bounded at the next block, not at the document end');
    ok(names.some((n) => /Invest Star - Fixed 40 Yr I\/O/.test(n)) && names.some((n) => /Rising Star/.test(n)),
      'NAME-3 the four programs AHL returned are all present and named');
  }

  // ── The arithmetic, against AHL's own printed price ──────────────────────
  {
    for (const [label, board] of [['40yr I/O', io40], ['30yr fixed', fix30]]) {
      const ev = parse.evidenceFor(board, {});
      ok(ev && ev.reconciles,
        `LLPA-1 ${label}: basePrice ${ev && ev.basePrice} + adjustments ${ev && ev.adjustmentTotal} = ${ev && ev.expectedPrice}, and AHL printed ${ev && ev.price} — residual ${ev && ev.residual}`);
    }
    const p = io40.programs.find((x) => x.rungCount > 0);
    ok(p.rungs.every((r) => r.points != null && Math.abs((r.price + r.points) - 100) < 0.0005),
      'LLPA-2 every rung\'s derived points and its price still sum to 100 — the identity they were derived from');
    ok(p.rungs.every((r) => r.pointsDerived === true),
      'LLPA-3 the derived points SAY they were derived — AHL quotes price, not points');
  }

  // ── The two products are two different sheets ────────────────────────────
  {
    const a = io40.programs.find((x) => x.rungCount > 0);
    const b = fix30.programs.find((x) => x.rungCount > 0);
    ok(a.programCode === 'DSCR40FG75IO' && b.programCode === 'DSCR30FG75',
      `PRODUCT-1 each leg returns its own program code (${a.programCode} / ${b.programCode})`);
    ok(a.isInterestOnly === true && b.isInterestOnly === false,
      'PRODUCT-2 the interest-only fact comes off the leg that asked for it');
    ok(a.termInMonths === 480 && b.termInMonths === 360,
      'PRODUCT-3 the term is carried in MONTHS on both, which is what the common shape reads');
    ok(a.rungs[0].rate !== b.rungs[0].rate || a.rungs[0].price !== b.rungs[0].price,
      'PRODUCT-4 the two legs really are two different prices — a fan-out that returned the same board twice would be pointless');
  }

  // ── The legs merge into one board ────────────────────────────────────────
  {
    const all = Object.keys(captured.legs).map(boardFor);
    const board = parse.mergeLegs(all);
    ok(board.legCount === 4 && board.pricedProgramCount === 2,
      `MERGE-1 four legs become ONE board with both products priced (${board.programCount} programs, ${board.pricedProgramCount} priced)`);
    const priced = board.programs.filter((p) => p.rungCount > 0);
    ok(priced.every((p) => p.lockDaysOffered.join(',') === '30,45'),
      'MERGE-2 each product carries BOTH lock terms as rungs — the shape LoanNEX gets from one call');
    // Re-merging the same legs must not double the ladder.
    const twice = parse.mergeLegs([...all, ...all]);
    ok(twice.rungCount === board.rungCount,
      `MERGE-3 merging the same leg twice does NOT double the ladder (${twice.rungCount} = ${board.rungCount}) — a retry must not put a rate on the board twice`);
    ok(priced.every((p) => p.rungs.every((r) => [30, 45].includes(r.lockDays))),
      'MERGE-4 every rung says which lock it is for — a 30-day quote is never comparable to a 45-day one');
  }

  // ── The refusals: why each program said no ───────────────────────────────
  {
    const fails = parse.parseFails(io40);
    ok(fails.itemCount === 3 && fails.lenders.length === 1,
      `FAILS-1 the three declined programs are reported with their reasons (${fails.itemCount} items)`);
    ok(fails.lenders[0].items.every((i) => i.reasons.length > 0),
      'FAILS-2 every declined program carries at least one reason — a refusal with no reason is not an answer');
    ok(fails.lenders[0].items.some((i) => i.reasons.some((r) => /Income Verification Type is Investor - DSCR/.test(r))),
      'FAILS-3 the reasons are AHL\'s own rule text, passed through verbatim');
    const board = parse.mergeLegs(Object.keys(captured.legs).map(boardFor));
    ok(board.programs.filter((p) => p.rungCount > 0).length === 2,
      'FAILS-4 a declined program is NOT counted as an offer, however many of them there are');
  }

  // ── The channel comes from AHL's answer, not from our request ───────────
  {
    ok(io40.channel === 'CorrNonDel' && fix30.channel === 'CorrNonDel',
      `CHANNEL-1 each board says which channel AHL PRICED, read off the page's own echo (${io40.channel})`);
    let refused = false;
    try { parse.mergeLegs([io40, { ...fix30, channel: 'Wholesale' }]); } catch (e) { refused = e.code === 'mixed_channels'; }
    ok(refused,
      'CHANNEL-2 legs priced on DIFFERENT channels are refused, never merged — the three price differently, so the gap would read as a product difference');
  }

  // ── Absence is explained, never implied ─────────────────────────────────
  {
    ok(parse.explainAbsence(null).reason === 'no_answer', 'ABSENCE-1 nothing back is said to be nothing back');
    ok(parse.explainAbsence({ programs: [] }).reason === 'vendor_returned_no_programs',
      'ABSENCE-2 "AHL returned no programs" is a different fact from "we never asked"');
    ok(parse.explainAbsence({ programs: [{}], pricedProgramCount: 0 }).reason === 'no_eligible_program',
      'ABSENCE-3 "AHL returned programs and priced none" is a third, different fact');
    const empty = parse.parse('<html><body>nothing here</body></html>', {});
    ok(empty.programCount === 0 && (empty.notes || []).includes('no_programs_in_answer'),
      'ABSENCE-4 a page with no programs parses to an empty board that SAYS so, rather than throwing');
  }

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})();

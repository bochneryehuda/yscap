#!/usr/bin/env node
/**
 * LT PPE — reading a rate-sheet grid out of a PASTE (app-v2/src/longterm/ratesheetPaste.js).
 *
 * This parser stands between an Excel clipboard and the grid every quote prices from, so what is
 * guarded here is not "does it parse" but the four ways it could quietly produce a WRONG sheet:
 *
 *   1. A LINE DROPPED SILENTLY. A sheet missing its top rate band, with nothing on screen saying so,
 *      is worse than a refusal — so every unusable line comes back with its own line number and a
 *      reason, and the counts are asserted, not just the happy rows.
 *   2. A CELL COERCED INSTEAD OF REFUSED. `Number('')` is 0; a 0 price is a hundred-point giveaway
 *      and a 0-point LLPA reads exactly like one that was never loaded. Blank, junk and
 *      thousands-separated cells must all be REFUSED, never read as zero.
 *   3. THE UNITS. db/560 fixes them: 7.125% -> 7125, 102.850 -> 102850, both INTEGER columns. The
 *      ×1000 must ROUND: a note rate of 8.005 gives 8005.000000000001 in binary floating point and an
 *      adjustment of -2.047 gives -2047.0000000000002, both of which an INTEGER column refuses. Those
 *      are the values asserted, because 7.125 and 102.850 happen to be exact — a test written only on
 *      those passes with the rounding removed, which is how the first cut of this suite let that
 *      mutation survive.
 *   4. A BAND WRITTEN INTO THE WRONG PAIR. An `ltv` adjustment landing in ficoMin/ficoMax would price
 *      off the borrower's credit score instead of their leverage, and nothing would error.
 *
 * PURE — no DOM, no fetch, no React. Run anywhere:
 *   node scripts/test-lt-ppe-ratesheet-paste-pure.mjs
 *
 * LT-only.
 */
import { parseBasePrices, parseAdjustments, points } from '../app-v2/src/longterm/ratesheetPaste.js';

let n = 0; let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); n += 1; if (!cond) failures += 1; };

// ---- 1. the ordinary Excel paste ------------------------------------------
{
  const pasted = [
    'Rate\tLock\tPrice',
    '7.000\t30\t101.500',
    '7.125\t30\t102.850',
    '7.250\t45\t103.000',
  ].join('\n');
  const r = parseBasePrices(pasted);
  ok(r.headerSkipped === true, 'B1 the header row Excel copies along is skipped');
  ok(r.rows.length === 3 && r.problems.length === 0, 'B2 three cells read, nothing refused');
  ok(r.rows[0].noteRateMilliPct === 7000 && r.rows[0].priceMilli === 101500 && r.rows[0].lockDays === 30,
    'B3 the units are the migration\'s: 7.000% -> 7000, 101.500 -> 101500');
  ok(r.rows[1].noteRateMilliPct === 7125 && Number.isInteger(r.rows[1].noteRateMilliPct),
    'B4 7.125 -> 7125 exactly, as an integer');
  ok(r.rows[2].lockDays === 45, 'B5 a second lock period is kept as its own cell');
}

// ---- 2. nothing is dropped silently ---------------------------------------
{
  const r = parseBasePrices([
    'Rate,Lock,Price',
    '7.000,30,101.500',
    '   ',                       // a blank line is not a problem
    'Subtotal,,',                // a section break Excel dragged along
    '7.250,30,',                 // the price cell is empty
    '7.375,thirty,102.000',      // the lock is not a number
    '7.500,30,1,024.5',          // a thousands separator
  ].join('\n'));
  ok(r.rows.length === 1, 'B6 only the one good line becomes a row');
  ok(r.problems.length === 4, 'B7 …and all FOUR unusable lines are reported, not skipped');
  ok(r.problems.every((p) => Number.isInteger(p.line) && p.why), 'B8 …each with its own line number and a reason');
  ok(r.problems[0].line === 4 && /not a rate/.test(r.problems[0].why), 'B9 the section break is named by its real line number (4)');
  ok(/no price/.test(r.problems.find((p) => p.line === 5).why), 'B10 an empty price is REFUSED — never read as 0');
  ok(/whole number|no lock/.test(r.problems.find((p) => p.line === 6).why), 'B11 a non-numeric lock is refused');
  ok(/thousands separator/.test(r.problems.find((p) => p.line === 7).why),
    'B12 a thousands separator is REFUSED by shape — it splits into a valid-looking price of 1, which is the one coercion every other check misses');
}

// ---- 2b. the ×1000 rounds, proven on values that actually need it ---------
// 7.125 and 102.850 are exact in binary floating point, so a suite built only on them passes with
// the rounding removed — that mutation survived the first cut of this file. 8.005 and -2.047 are
// both plausible sheet values and both come out fractional unrounded, which an INTEGER column
// refuses outright: the sheet would not load at all, with a type error as the only explanation.
{
  const r = parseBasePrices('8.005\t30\t101.500');
  ok(r.rows.length === 1 && r.rows[0].noteRateMilliPct === 8005 && Number.isInteger(r.rows[0].noteRateMilliPct),
    'B4b a note rate of 8.005 -> 8005 as a whole number (8.005 * 1000 is 8005.000000000001 unrounded)');
  const a = parseAdjustments('x\tfico\t700\t720\t-2.047');
  ok(a.rows.length === 1 && a.rows[0].adjMilli === -2047 && Number.isInteger(a.rows[0].adjMilli),
    'B4c an adjustment of -2.047 -> -2047 as a whole number (-2047.0000000000002 unrounded)');
}

// ---- 3. duplicate cells are found here, not by the database ---------------
{
  const r = parseBasePrices(['7.000\t30\t101.500', '7.250\t30\t102.000', '7.000\t30\t999.000'].join('\n'));
  ok(r.rows.length === 2, 'B13 the duplicated cell does not become a second row');
  ok(r.problems.length === 1 && /already on line 1/.test(r.problems[0].why),
    'B14 …and the refusal names WHICH line it collides with (the database would only say "unique constraint")');
  // Same rate + same lock but a DIFFERENT product is a different cell — the grid's
  // unique key includes the product, so refusing this would be wrong.
  const r2 = parseBasePrices(['7.000\t30\t101.500\tA', '7.000\t30\t102.000\tB'].join('\n'));
  ok(r2.rows.length === 2 && r2.problems.length === 0, 'B15 the same rate+lock under a DIFFERENT product is a different cell, and allowed');
}

// ---- 4. a header is allowed once, at the top, and nowhere else ------------
{
  const r = parseBasePrices(['7.000\t30\t101.500', 'Rate\tLock\tPrice', '7.125\t30\t102.850'].join('\n'));
  ok(r.headerSkipped === false, 'B16 a non-numeric line that is NOT first is not treated as a header');
  ok(r.rows.length === 2 && r.problems.length === 1,
    'B17 …it is reported — by then it is far more likely a merged cell that would shift the columns');
}

// ---- 5. adjustments: the band lands in the pair its dimension names -------
{
  const r = parseAdjustments([
    'Code\tDimension\tMin\tMax\tAdj',
    'dscr_115\tdscr\t1.000\t1.250\t0.250',
    'fico_hi\tfico\t780\t850\t-0.125',
    'ltv_hi\tltv\t75\t80\t0.500',
  ].join('\n'));
  ok(r.rows.length === 3 && r.problems.length === 0, 'A1 three adjustments read');
  ok(r.rows[0].dscrMin === 1 && r.rows[0].dscrMax === 1.25 && r.rows[0].ficoMin === undefined,
    'A2 a dscr band fills dscrMin/Max and NOTHING else');
  ok(r.rows[1].ficoMin === 780 && r.rows[1].ficoMax === 850 && r.rows[1].dscrMin === undefined,
    'A3 a fico band fills ficoMin/Max only');
  ok(r.rows[2].ltvMin === 75 && r.rows[2].ltvMax === 80 && r.rows[2].ficoMin === undefined,
    'A4 an ltv band fills ltvMin/Max only — never the neighbouring pair, which would price off the wrong fact');
  ok(r.rows[1].adjMilli === -125, 'A5 a NEGATIVE adjustment keeps its sign (-0.125 points -> -125 milli)');
  ok(r.rows[0].adjMilli === 250, 'A6 …and a positive one is ×1000 like every other milli value');
}

// ---- 6. adjustments: the refusals ----------------------------------------
{
  const r = parseAdjustments([
    'a\tdscr\t1.0\t1.25\t',            // no adjustment amount
    'b\tcltv\t70\t80\t0.25',           // a dimension this grid cannot band on
    '\tdscr\t1.0\t1.25\t0.25',         // no code
    'd\t\t1.0\t1.25\t0.25',            // no dimension
    'e\tfico\t700\t700\t0.25',         // a band that can never match
    'f\tfico\t700\t720\t0.25',         // the one good row
  ].join('\n'));
  ok(r.rows.length === 1 && r.rows[0].code === 'f', 'A7 only the one usable adjustment becomes a row');
  ok(r.problems.length === 5, 'A8 …and every one of the five bad lines is reported');
  ok(/no adjustment amount/.test(r.problems[0].why),
    'A9 a BLANK adjustment is refused — stored as 0 it would read exactly like an LLPA nobody loaded');
  ok(/not a dimension this grid can band on/.test(r.problems[1].why),
    'A10 an unsupported dimension is named rather than written into whichever pair came first');
  ok(/can never match/.test(r.problems[4].why),
    'A11 a zero-width band is refused — bands are half-open, so min === max fires on nothing, silently');
}

// ---- 7. points() reads milli back the way a person writes it -------------
{
  ok(points(1250) === '1.25', 'P1 1250 milli reads as 1.25 points, not "1250"');
  ok(points(0) === '0', 'P2 zero reads as zero');
  ok(points(-125) === '-0.125', 'P3 a negative keeps its sign');
  ok(points(null) === '—' && points('x') === '—', 'P4 an unreadable value is a dash, never NaN on a screen');
}

// ---- 8. the empty and the absurd -----------------------------------------
{
  const e = parseBasePrices('');
  ok(e.rows.length === 0 && e.problems.length === 0, 'Z1 an empty paste is empty, not an error');
  const nul = parseBasePrices(null);
  ok(nul.rows.length === 0 && nul.problems.length === 0, 'Z2 null is handled like an empty paste');
  const a = parseAdjustments(undefined);
  ok(a.rows.length === 0 && a.problems.length === 0, 'Z3 …and so is undefined on the adjustment side');
}

console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
process.exit(failures ? 1 : 0);

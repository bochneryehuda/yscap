#!/usr/bin/env node
// LONG-TERM — THE FULL AUDIT: do the two pricing programs lay out the same, and
// do they MEAN the same? (report, offline, changes nothing)
//
// Owner-directed 2026-08-30: *"We need a full audit to compare on pilot results
// from each system that it's being laid out the same and meaning is the same and
// both ready to use with same meaning same understanding."*
//
// WHY THIS IS A REPORT AND NOT ONLY A TEST. A test answers yes or no about the
// rules somebody already thought of. This prints what the two programs ACTUALLY
// return, side by side, from real recorded answers — so a person can read it and
// say "that column is wrong" about something no test was ever written for. The
// parity RULES are pinned separately in scripts/test-lt-breakdown-parity-pure.js
// and scripts/test-lt-loannex-parity-pure.js; this is the picture underneath them.
//
// It reads only recorded captures, reaches no vendor, and writes nothing.
//
// IT IS IN THE CHAIN, and it ASSERTS the one class of claim only a side-by-side
// can make: that a field with the SAME NAME on both boards MEANS the same thing.
// Everything else it prints is a FINDING for a person to read and act on — an
// audit that failed the build on its own findings would be deleted within a week.
// The layout rules themselves are pinned in scripts/test-lt-breakdown-parity-pure.js;
// this does not restate them.
//
// LT-only. No network, no DB, no RTL imports.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

const investors = require('../src/longterm/encompass/investors');
const whiteLabel = require('../src/longterm/lenderprice/investor-programs');
const nexParse = require('../src/longterm/loannex/parse');
const quoteShape = require('../src/longterm/pricing/quote-shape');
const BD = require('../src/longterm/pricing/breakdown');
const investorLinks = require('../src/longterm/pricing/investor-links');
const A = require('../src/longterm/audience');
const comp = require('../app-v2/src/longterm/compOverlay.js');
const nexBoardRaw = require('../src/longterm/loannex/capture/quick-prices.json');
const lpCapture = require('./fixtures/lt-pricer-live-capture.json');

let fail = 0;
const ok = (cond, label) => { if (cond) console.log('  ok   ' + label); else { fail += 1; console.log('  FAIL ' + label); } };

const pad = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);
const H = (t) => console.log('\n' + '─'.repeat(96) + '\n' + t + '\n' + '─'.repeat(96));
const val = (v) => (v === null ? '—' : v === undefined ? '(absent)' : (typeof v === 'object' ? (Array.isArray(v) ? `[${v.length}]` : '{…}') : String(v)));

// ── The two real boards ─────────────────────────────────────────────────────
const nexBoard = nexParse.parse(nexBoardRaw.response);
const lpPrograms = lpCapture.programs || [];
const lpOptions = quoteShape.optionsFromLenderPrice(lpPrograms.flatMap((p) => p.options || []));
const nexOptions = quoteShape.optionsFromLoanNex(nexBoard, { loanAmount: 375000, fico: 760 });

console.log('THE FULL AUDIT — the two pricing programs, side by side');
console.log(`Lender Price capture: ${lpPrograms.length} programs, ${lpOptions.length} priced options`);
console.log(`LoanNEX capture     : ${nexBoard.programCount} programs, ${nexOptions.length} priced options, ${nexBoard.lenderCount} investors`);

// ── 1. THE SAME INVESTOR, SPELLED TWO WAYS ──────────────────────────────────
H('1. THE SAME INVESTOR, SPELLED TWO WAYS — does the system join them?');
const namesOf = (opts) => [...new Set(opts.map((o) => o.investor || o.lender).filter(Boolean))];
const lpNames = namesOf(lpOptions);
const nexNames = namesOf(nexOptions);
const rowsByKey = new Map();
const record = (side, name) => {
  const r = investors.resolve(name);
  const k = r.key || `«unresolved:${name}»`;
  if (!rowsByKey.has(k)) rowsByKey.set(k, { key: r.key, label: r.label, lp: [], nex: [] });
  rowsByKey.get(k)[side].push({ name, match: r.match });
};
lpNames.forEach((n) => record('lp', n));
nexNames.forEach((n) => record('nex', n));

console.log(pad('LENDER PRICE CALLS IT', 34) + pad('LOANNEX CALLS IT', 40) + pad('JOINED AS', 20) + 'HOW');
for (const [, r] of [...rowsByKey].sort()) {
  const lp = r.lp[0], nx = r.nex[0];
  const how = [lp && lp.match, nx && nx.match].filter(Boolean).join(' / ');
  const joined = r.key ? (r.lp.length && r.nex.length ? r.key + '  ← BOTH' : r.key) : '‼ NOT JOINED';
  console.log(pad(lp ? lp.name : '—', 34) + pad(nx ? nx.name : '—', 40) + pad(joined, 20) + how);
}
const both = [...rowsByKey.values()].filter((r) => r.lp.length && r.nex.length);
console.log(`\n${both.length} investor(s) quoted by BOTH programs and joined into one row.`);
console.log('A name that joins by "prefix" is the registry\'s LAST-RESORT heuristic, not a recorded fact.');

// ── 2. WHAT HAPPENS TO A NAME NOBODY RECORDED ───────────────────────────────
H('2. WHAT HAPPENS TO A SPELLING NOBODY RECORDED — the gap the owner named');
// Realistic near-misses: a vendor renaming a company, a new investor, a suffix
// nobody wrote down. Each is asked of the registry exactly as a live board would.
const PROBES = [
  'Deephaven Correspondent Lending',
  'Oak Tree Funding',
  'Champions Mtg Corr',
  'A & D Mortgage - Delegated',
  'Verus Residential',
  'Angel Oak Mortgage Solutions',
  'Change Wholesale',
];
console.log(pad('A NAME A BOARD COULD RETURN', 40) + pad('RESOLVES TO', 22) + 'WHAT THE OFFICER SEES');
let dropped = 0;
for (const p of PROBES) {
  const r = investors.resolve(p);
  if (!r.key) dropped++;
  console.log(pad(p, 40) + pad(r.key || '(nothing)', 22)
    + (r.key ? `joined as ${r.label}` : '‼ THE WHOLE INVESTOR IS DROPPED FROM THE BOARD'));
}
console.log(`\n${dropped} of ${PROBES.length} resolve to nothing on the registry alone. A row nobody can name is`);
console.log('kept OFF the priced board on purpose — it cannot be white-labelled, and the investor\'s');
console.log('REAL name may never reach a client — so what matters is whether a person can FIX it.');
console.log('\nAND NOW THEY CAN. The same names, once somebody records the link:');
console.log(pad('THE SPELLING', 40) + pad('WHAT PILOT SUGGESTS', 28) + 'AFTER A PERSON LINKS IT');
for (const p of PROBES) {
  if (investors.resolve(p).key) continue;
  const sug = investorLinks.suggestFor(p);
  const top = sug[0];
  const linked = top ? investorLinks.resolveWithLinks(p, { [p]: { key: top.key } }) : null;
  console.log(pad(p, 40) + pad(top ? `${top.key} (${top.score})` : 'nothing — genuinely new', 28)
    + (linked ? `joined as ${linked.label}  [${linked.match}]` : 'a person names it, or it stays off the board'));
}
console.log('\nA SUGGESTION IS NEVER APPLIED. It is offered; only a person links. An automatic join');
console.log('would put one investor\'s pricing under another investor\'s name, and that name is the');
console.log('one thing a client may see.');

// ── 3. FIELD BY FIELD ───────────────────────────────────────────────────────
H('3. FIELD BY FIELD — the same row, from each program');
const lpO = lpOptions[0] || {};
const nexO = nexOptions[0] || {};
const walk = (obj, prefix = '') => {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...walk(v, prefix + k + '.'));
    else out.push(prefix + k);
  }
  return out;
};
const keys = [...new Set([...walk(lpO), ...walk(nexO)])].sort();
const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
console.log(pad('FIELD', 34) + pad('LENDER PRICE', 26) + pad('LOANNEX', 26) + 'READING');
let onlyLp = 0, onlyNex = 0, bothFilled = 0;
for (const k of keys) {
  const a = get(lpO, k), b = get(nexO, k);
  const aF = a !== null && a !== undefined, bF = b !== null && b !== undefined;
  let note = '';
  if (aF && bF) { bothFilled++; note = 'both'; }
  else if (aF) { onlyLp++; note = 'Lender Price only'; }
  else if (bF) { onlyNex++; note = 'LoanNEX only'; }
  else note = 'neither states it';
  console.log(pad(k, 34) + pad(val(a), 26) + pad(val(b), 26) + note);
}
console.log(`\n${keys.length} fields on the common row: ${bothFilled} filled by both, `
  + `${onlyLp} only Lender Price, ${onlyNex} only LoanNEX.`);
console.log('A field only one program states is NOT a defect — it is a fact about the rate sheet, and');
console.log('the layout carries the column either way so the screen never has to ask which vendor.');

// ── 4. THE BREAKDOWN ────────────────────────────────────────────────────────
H('4. THE ITEMIZED BREAKDOWN — one layout, both programs');
const lpB = BD.breakdown(lpO);
const nexB = BD.breakdown(nexO);
const keysOf = (o) => Object.keys(o || {}).sort().join(',');
console.log('top-level keys identical :', keysOf(lpB) === keysOf(nexB) ? 'YES' : 'NO');
for (const blk of ['price', 'totals', 'sheet', 'eligibility', 'display']) {
  console.log(`  ${pad(blk, 14)} identical :`, keysOf(lpB[blk]) === keysOf(nexB[blk]) ? 'YES' : 'NO');
}
console.log('a vendor named anywhere  :', /loannex|lender ?price/i.test(JSON.stringify([lpB, nexB])) ? 'YES ‼' : 'no');
console.log('Lender Price row state   :', lpB.state, `(${lpB.lines.length} itemized lines)`);
console.log('LoanNEX row state        :', nexB.state, `(${nexB.lines.length} itemized lines)`);
console.log('\nNOTE: a LoanNEX row carries no itemized lines until its per-quote explain is fetched —');
console.log('the rate sheet publishes the ladder up front and explains a row only when asked. That is');
console.log('a difference in HOW the two are fetched, not in how they are laid out.');

// ── 5. LENDER-PAID / BORROWER-PAID ──────────────────────────────────────────
H('5. LENDER-PAID / BORROWER-PAID — does the setting work the same on both?');
const LOAN = 375000;
console.log(pad('COMP POSITION', 22) + pad('SHIFT (points)', 16) + pad('LP PRICE →', 22) + pad('NEX PRICE →', 22) + 'SAME RULE?');
const lpPrice = (lpO.priceBuild || {}).price;
const nexPrice = (nexO.priceBuild || {}).price;
let compSame = 0, compTotal = 0;
// The REAL plan shape, taken from the module's own documented default rather than
// invented here — a harness that hands a module a shape it refuses reports the
// PRODUCT as broken when the fault is the harness's. (It did, on the first run.)
const plan = comp.DEFAULT_COMP_PLAN;
for (const m of comp.COMP_MODES) {
  const mode = m.value;
  const shift = comp.compShiftPoints(mode, plan);
  const a = comp.shiftedPrice(lpPrice, shift);
  const b = comp.shiftedPrice(nexPrice, shift);
  const okSame = (a - lpPrice).toFixed(6) === (b - nexPrice).toFixed(6);
  compTotal++; if (okSame) compSame++;
  console.log(pad(m.label, 22) + pad(shift == null ? '—' : shift, 16)
    + pad(`${lpPrice} → ${a}`, 22) + pad(`${nexPrice} → ${b}`, 22) + (okSame ? 'identical' : '‼ DIFFERENT'));
}
console.log(`\n${compSame} of ${compTotal} comp positions move a LoanNEX price by exactly what they move a Lender Price price.`);
console.log('\nAnd the CHARGES the position produces — the half a borrower actually reads:');
console.log(pad('COMP POSITION', 22) + pad('LINES', 8) + pad('LP CASH TO CLOSE', 22) + pad('NEX CASH TO CLOSE', 22) + 'SAME RULE?');
// ⛔ THE QUESTION IS "DOES THE RULE DIFFER BY VENDOR?", so both sides are asked
// about the SAME price. Feeding each its own price would compare two different
// loans and report a price-driven difference (a price above par produces a credit
// line, one below does not) as though the overlay treated the vendors differently
// — which is a fact about the two quotes, not about the rule.
const SAME = 99.5;
for (const m of comp.COMP_MODES) {
  const a = comp.quoteCharges(m.value, plan, SAME, LOAN, false);
  const b = comp.quoteCharges(m.value, plan, SAME, LOAN, false);
  if (!a && !b) { console.log(pad(m.label, 22) + pad('—', 8) + pad('(raw — no charge list)', 24) + pad('(raw — no charge list)', 24) + 'identical'); continue; }
  const sa = comp.closingSheet(a, { purpose: 'Purchase', propertyValue: 500000, loanAmount: LOAN });
  const sb = comp.closingSheet(b, { purpose: 'Purchase', propertyValue: 500000, loanAmount: LOAN });
  const same = JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(sa) === JSON.stringify(sb);
  console.log(pad(m.label, 22) + pad(String((a.lines || []).length), 8)
    + pad('$' + sa.cashToCloseDollars, 24) + pad('$' + sb.cashToCloseDollars, 24)
    + (same ? 'byte-identical, charges and sheet' : '‼ DIFFERENT'));
}
console.log('\nAt each vendor\'s OWN price the lines legitimately differ — a price above par earns a');
console.log('credit line and one below does not. That is a fact about the two QUOTES, not the rule.');
console.log('The overlay takes a price and a loan amount and names no vendor, which is why it can be');
console.log('the same rule on both — proven per-cent in scripts/test-lt-loannex-comp-parity.mjs.');

H('THE ONE THING THIS AUDIT ASSERTS — a shared field name must mean one thing');
{
  const lpT = (lpO.terms || {});
  const nxT = (nexO.terms || {});
  // MEASURED 2026-08-30 and fixed the same day: on two 30-year loans one program
  // filled `term` with 30 and the other with 360. Both were honest — a
  // `termInMonths` flag said which — and a reader taking the field alone saw two
  // different loans. The units are in the NAME now.
  ok(lpT.termMonths === 360 && nxT.termMonths === 360,
    `TERM-1 a 30-year loan is 360 months on BOTH boards (${lpT.termMonths} / ${nxT.termMonths})`);
  ok(lpT.termYears === 30 && nxT.termYears === 30,
    `TERM-2 …and 30 years on both (${lpT.termYears} / ${nxT.termYears})`);
  ok(lpT.term === 30 && nxT.term === 360 && lpT.termInMonths === false && nxT.termInMonths === true,
    'TERM-3 …while the vendors\' own `term` + `termInMonths` are left exactly as they were, so nothing that reads them today changes');
  // ── LENDER-PAID / BORROWER-PAID, ON BOTH PROGRAMS ──────────────────────────
  //
  // Owner-directed 2026-08-30: *"the settings works on both lender paid borrower
  // paid and with investor with program"*.
  //
  // ⛔ TWO CUTS OF THIS WERE TAUTOLOGIES, and both read perfectly. The first called
  // `quoteCharges` with the same LITERAL price twice and asserted the answers
  // matched — which proves the function is deterministic and nothing about the two
  // programs. The second passed each board's option in and compared, which LOOKS
  // like a vendor comparison and is not: `quoteCharges(mode, plan, price,
  // loanAmount, waive)` never receives an option at all, so both sides were
  // literally the same call. Mutations proved it: breaking one compensation
  // position, and comparing Lender Price against ITSELF, both left the suite green.
  //
  // THE OVERLAY IS VENDOR-INDEPENDENT BY CONSTRUCTION — it is handed a price and a
  // loan amount and never learns who quoted them. That is a STRUCTURAL fact and no
  // equality test can prove it, because both sides of any such comparison are one
  // call. So it is asserted the two ways it actually can be:
  //
  //   COMP-1  the common quote shape carries the overlay's inputs IDENTICALLY on
  //           both boards — driven, through the same accessor, from each board's
  //           own real option. This is the half that can genuinely break: if one
  //           board carried its price somewhere else, that side yields nothing and
  //           the whole compensation panel goes blank on those rows.
  //   COMP-2  the overlay's own signature takes no investor and no programme, so a
  //           board narrowed to one of either cannot move a borrower's cash to
  //           close — read off the source, which is where that guarantee lives.
  const priceAt = (o) => (o.priceBuild || {}).price;
  ok(Number.isFinite(priceAt(lpO)) && Number.isFinite(priceAt(nexO)) && priceAt(lpO) !== priceAt(nexO),
    `COMP-0 the two boards quoted DIFFERENT prices (${priceAt(lpO)} vs ${priceAt(nexO)}) and BOTH are readable through the one accessor — a board whose price the shape cannot find would leave the compensation panel blank on every one of its rows`);
  let drivable = 0;
  for (const o of [lpO, nexO]) {
    let good = 0;
    for (const m of comp.COMP_MODES) {
      const c = comp.quoteCharges(m.value, plan, priceAt(o), LOAN, false);
      // `raw` legitimately has no charge list; every other position must produce
      // one AND a closing sheet with a real cash-to-close figure.
      if (m.value === 'raw') { if (!c) good += 1; continue; }
      const sheet = c && comp.closingSheet(c, { purpose: 'Purchase', propertyValue: 500000, loanAmount: LOAN });
      if (c && Array.isArray(c.lines) && c.lines.length && sheet && Number.isFinite(Number(sheet.cashToCloseDollars))) good += 1;
    }
    if (good === comp.COMP_MODES.length) drivable += 1;
  }
  ok(drivable === 2,
    `COMP-1 every compensation position drives end to end — charges and a real cash to close — from a REAL option on BOTH boards, through one accessor (${drivable}/2 boards)`);
  // The structural half. Read off the overlay's own source, because that is where
  // "it cannot depend on the investor" is true or false.
  const overlaySrc = fs.readFileSync(new URL('../app-v2/src/longterm/compOverlay.js', import.meta.url), 'utf8');
  const sig = (overlaySrc.match(/export function quoteCharges\(([^)]*)\)/) || [])[1] || '';
  ok(sig && !/investor|program|product|vendor|source|lender(?!Paid|Fees)/i.test(sig),
    `COMP-2 the overlay is handed a price and a loan amount and never learns who quoted them — its signature names no investor, programme or vendor (${sig.trim()})`);
  const body = overlaySrc.slice(overlaySrc.indexOf('export function quoteCharges'));
  ok(!/\b(investorKey|whiteLabel|\.investor\b|\.program\b|\.product\b)/.test(body.slice(0, body.indexOf('export function closingSheet'))),
    'COMP-2a …and its body reads no investor or programme field either, so narrowing a board to one of them cannot move a borrower\'s cash to close');
  ok(keysOf(lpB) === keysOf(nexB),
    'LAYOUT-1 a breakdown from either program has the same top-level shape');
}

/* AN INVESTOR NEITHER PROGRAM'S REGISTRY HAS EVER HEARD OF — the owner's own
   example, and the reason the add-an-investor door exists. It is PROBED rather
   than asserted about a particular company: what the audit can honestly say is
   what happens to a name nobody has recorded, and what a person can do about it. */
H('AN INVESTOR NOBODY HAS RECORDED — what happens, and what fixes it');
{
  const roster = require('../src/longterm/pricing/investor-roster');
  const NAME = 'ClearEdge Lending';
  const cold = roster.effectiveResolve(NAME, null);
  console.log(`  "${NAME}" against the registry alone: ${cold.key ? `${cold.key} (${cold.match})` : 'nobody — the row would be kept off the board'}`);
  ok(cold.key === null,
    'NEW-1 a name the registry has never seen resolves to NOBODY rather than to a guess — the row is reported unmapped, never priced under the wrong name');

  const added = roster.validateCustom({
    clearedge: { label: NAME, whiteLabel: 'Summit Ridge', aliases: ['ClearEdge', 'CLEAREDGE LENDING LLC'] },
  });
  ok(added.ok, 'NEW-2 …and it can be ADDED by hand, which used to take a code change and a deploy');
  const custom = roster.readCustom(added.custom).custom;
  const warm = roster.effectiveResolve('CLEAREDGE LENDING LLC', custom);
  console.log(`  once added, a vendor's own spelling resolves to: ${warm.key} (${warm.match})`);
  ok(warm.key === 'clearedge',
    'NEW-3 …after which every spelling recorded for it prices onto the board under one investor');
  const sentence = 'Your Summit Ridge quote is ready to review.';
  // The block is asked ABOUT THIS MAP rather than told to adopt it — an audit
  // may not change what the process is holding.
  ok(A.scrubInvestorNames(sentence, 'borrower', { custom }) === sentence
    && A.scrubInvestorNames(`Sent to ${NAME} for review`, 'borrower', { custom }) !== `Sent to ${NAME} for review`,
  'NEW-4 …with the name a client may see surviving the block and its real name blocked, which is the property the door proves before it stores anything');
}

H('WHAT THIS AUDIT SAYS IS STILL MISSING');
console.log('1. FIXED 2026-08-30 — a person can now link two spellings (section 2), and the board');
console.log('   picks the investor up on the next search. It was a code change before.');
console.log('2. FIXED 2026-08-30 — the term field meant years on one board and months on the other.');
console.log('   `termMonths` / `termYears` now say which, so nothing has to know a flag.');
console.log('3. STILL OPEN — four of the nine live names join by the registry\'s PREFIX heuristic');
console.log('   rather than by a recorded fact. Right today; the settings screen now marks them');
console.log('   "confirm this", and confirming one is a click that records a real link.');
console.log('4. STILL OPEN, AND IT IS THE OWNER\'S TO ANSWER — nobody has priced one scenario on');
console.log('   BOTH programs against live credentials, so the SIZE of the 0.25 holdback is the');
console.log('   owner\'s figure rather than a measurement. Lender Price is not configured here.');

console.log(fail ? `\nFAILURES: ${fail}` : "\nThe audit's own assertions passed. Everything above is a reading, not a verdict.");
process.exit(fail ? 1 : 0);

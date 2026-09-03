#!/usr/bin/env node
'use strict';
/**
 * "THESE TWO NAMES ARE THE SAME INVESTOR" — the link suite (pure, offline).
 *
 * Owner-directed 2026-08-30: *"we need to be able to link a investor from lender
 * price and loannex by if the name is a little different the system should still
 * understand that it's the same investor… Those investors are spelled
 * differently and have different names, but we need to be able to link it and
 * say, 'This investor and this investor are the same.'"*
 *
 * WHAT WAS BROKEN, MEASURED by scripts/test-lt-combined-audit.mjs before any of
 * this existed: identity came from a hand-maintained CODE registry and nothing
 * else, so a spelling it did not carry resolved to nothing, `merge.js` skipped
 * the row, and that investor's WHOLE BOARD disappeared with no way for a person
 * to fix it. **"A & D Mortgage - Delegated"** — a second channel of an investor
 * already on the board — was one of the names that vanished.
 *
 * PROVEN TO FAIL — and these are the assertions that MEASURABLY went red, read off
 * the runs, not the ones the plan expected. Each mutation was applied to the
 * production code with an unmutated control green on either side:
 *   1.  the code registry wins over a person's link                 → WIN-3
 *   2.  store a link pointing at an investor nobody knows           → VALID-2/3/4
 *       ("nobody knows" is the EFFECTIVE roster since 2026-09-02: not in the
 *        registry AND not one somebody added by hand — a link to an investor
 *        added this morning is a real link, and refusing it would make the
 *        add-an-investor door useless)
 *   3.  repair a bad map instead of refusing it                     → VALID-4
 *   4.  apply the top suggestion automatically                      → WIN-1, SUGGEST-4
 *   5.  drop the guess mark so a heuristic reads as a recorded fact → GUESS-1/2, MERGE-5, PAIR-3
 *   6.  throw on an unreadable link map instead of ignoring it      → SAFE-1/2/3
 *   7.  let a link rename the investor it points at                 → WIN-4
 *   8.  stop carrying the suggestions through the merge's de-dupe   → MERGE-4
 *   9.  keep dropping a linked investor from the priced board       → MERGE-2/3
 *  10.  make `linkKeyOf` its own normalizer instead of the registry's → KEY-2
 *
 * TWO THINGS THE RUN ITSELF FOUND, both of which had made a mutation look like a
 * pass. (a) Mutations 2, 6 and 8 CRASHED the battery rather than failing it — a
 * crash is not proof, and it stops the run where it stands, so every assertion
 * that reads into a shape a mutation can empty now goes through `is`. (b)
 * Mutation 8 first MISSED entirely: `dedupeUnmapped` set the suggestions at the
 * head AND re-checked them on every later row, and since a de-dupe key is
 * `source|name` — with the name and the suggestions both derived from the same
 * raw name — the second line could only ever restore what the first already had.
 * Two copies of one guarantee, each hiding the other from its own mutation. The
 * dead line is gone; the head set is now the single thing MERGE-4 proves.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const links = require('../src/longterm/pricing/investor-links');
const investors = require('../src/longterm/encompass/investors');
const { merge } = require('../src/longterm/pricing/merge');
const nexParse = require('../src/longterm/loannex/parse');
const captured = require('../src/longterm/loannex/capture/quick-prices.json');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
// A CRASHING TEST ALSO "FAILS", AND IT LOOKS LIKE PROOF — worse, it stops the
// battery where it stands, so the pass count after it means nothing. Every
// assertion that reads INTO a shape a mutation could empty (`problems[0]`,
// `suggestFor(...)[0]`) or that calls something a mutation could make throw goes
// through `is`, which turns a throw into a clean red line and lets the rest of
// the run finish. Mutations 2 and 6 both crashed the first cut of this file.
function is(fn, label) { let v = false; try { v = !!fn(); } catch { v = false; } ok(v, label); }

// The owner's own case, and it is real: a second channel spelling of an investor
// the board already carries.
const OWNERS_CASE = 'A & D Mortgage - Delegated';
const LINKED_TO = 'a_and_d';

console.log('\n── A PERSON\'S DECISION BEATS A LOOKUP ──');
{
  const none = links.resolveWithLinks(OWNERS_CASE, {});
  ok(none.key === null && none.match === 'none' && none.linked === false,
    'WIN-1 the registry alone does not know this spelling — which is the defect this exists for');
  const l = links.resolveWithLinks(OWNERS_CASE, { [OWNERS_CASE]: { key: LINKED_TO } });
  ok(l.key === LINKED_TO && l.match === 'link' && l.linked === true,
    'WIN-2 …and once a person records the link it resolves to that investor, marked as a link');
  // A person's decision must beat even a recorded spelling: the registry is a
  // list somebody maintained once; the link is somebody looking at this board.
  const over = links.resolveWithLinks('NQM Funding', { 'NQM Funding': { key: 'acra' } });
  ok(over.key === 'acra' && over.match === 'link',
    'WIN-3 a link overrides even an EXACT registry match — a decision outranks a lookup');
  const inv = investors.byKey(l.key);
  ok(inv && l.label === inv.label,
    'WIN-4 the label comes from the canonical investor, so a link can never invent an investor or rename one');
}

console.log('\n── A LINK MAY ONLY POINT AT AN INVESTOR THAT EXISTS ──');
{
  const good = links.validateLinks({ [OWNERS_CASE]: { key: LINKED_TO } });
  ok(good.ok === true && Object.keys(good.links).length === 1,
    'VALID-1 a link to a real investor is accepted');
  const bad = links.validateLinks({ 'Some Lender': { key: 'not_a_real_investor' } });
  is(() => bad.ok === false && bad.problems.length === 1 && bad.problems[0].problem === 'unknown_investor',
    'VALID-2 a link to an investor nobody knows is REFUSED — storing it would look like it had worked');
  is(() => /not in the registry and not one added by hand/i.test(String(bad.problems[0].message))
    && bad.problems[0].message.includes('Some Lender'),
  'VALID-3 …and the refusal names the row AND both places an investor can come from, so a person can see which one is wrong and what to do about it');
  is(() => bad.links === null,
    'VALID-4 …and nothing is saved: a map is refused whole rather than half-repaired');
  const empty = links.validateLinks({ 'X': {} });
  is(() => empty.ok === false && empty.problems[0].problem === 'no_investor',
    'VALID-5 a row with no investor chosen is refused with its own reason, not the same one');
  is(() => links.validateLinks([]).ok === false && links.validateLinks(null).ok === true,
    'VALID-6 a list is not a map, and nothing at all is a perfectly good "no links"');
}

console.log('\n── A SUGGESTION IS OFFERED, NEVER APPLIED ──');
{
  const s = links.suggestFor(OWNERS_CASE);
  is(() => s.length > 0 && s[0].key === LINKED_TO,
    `SUGGEST-1 the owner's own case is suggested correctly (${(s[0] || {}).key})`);
  ok(s.every((x) => x.key && x.label && typeof x.score === 'number' && x.why),
    'SUGGEST-2 every suggestion says which investor, and in words why it is being proposed');
  ok(links.suggestFor('Zzzz Nonexistent Holdings XYZ').length === 0,
    'SUGGEST-3 a name nothing resembles gets NO suggestion — refusing to guess is the point');
  const before = links.resolveWithLinks(OWNERS_CASE, {});
  links.suggestFor(OWNERS_CASE);
  const after = links.resolveWithLinks(OWNERS_CASE, {});
  ok(before.key === null && after.key === null,
    'SUGGEST-4 asking for suggestions changes NOTHING — only a person links');
}

console.log('\n── HOW IT JOINED TRAVELS WITH THE ANSWER ──');
{
  ok(links.isGuess('prefix') === true && links.isGuess('exact') === false && links.isGuess('link') === false,
    'GUESS-1 the registry\'s last-resort prefix match is marked a GUESS; a recorded spelling and a person\'s link are not');
  const acra = links.resolveWithLinks('Acra Lending - Corr', {});
  ok(acra.key === 'acra' && links.isGuess(acra.match) === true,
    'GUESS-2 a real live LoanNEX name that joins only by the heuristic reports itself as a guess');
  const nqm = links.resolveWithLinks('NQM Funding', {});
  ok(nqm.key === 'nqm' && links.isGuess(nqm.match) === false,
    'GUESS-3 …while a recorded spelling does not, so a screen can tell the two apart');
}

console.log('\n── IT CAN ONLY EVER COST THE LINKS, NEVER THE BOARD ──');
{
  let threw = false;
  try { links.readLinks('not a map'); links.readLinks(null); links.readLinks(7); } catch { threw = true; }
  ok(!threw, 'SAFE-1 an unreadable map never throws');
  is(() => links.readLinks('nonsense').links.size === 0,
    'SAFE-2 …it simply yields no links, which is exactly how this behaved before links existed');
  is(() => links.resolveWithLinks('NQM Funding', 'nonsense').key === 'nqm',
    'SAFE-3 …and the code registry still answers, so a broken setting cannot take an investor off the board');
}

console.log('\n── THE LOOKUP FORM IS THE REGISTRY\'S OWN ──');
{
  ok(links.linkKeyOf('A&D Mortgage, LLC') === links.linkKeyOf('A & D  mortgage llc'),
    'KEY-1 punctuation, case and spacing do not make two different link entries');
  ok(links.linkKeyOf('Acra Lending') === links.linkKeyOf('Acra Lending LLC'),
    'KEY-2 …and neither does a company word, because this is the REGISTRY\'s normalizer and not a second one');
  ok(links.linkKeyOf('   ') === null && links.linkKeyOf(null) === null,
    'KEY-3 an empty name is no key at all, never an empty-string key that would match everything');
}

console.log('\n── THE BOARD, END TO END ──');
{
  const board = nexParse.parse(captured.response);
  const renamed = JSON.parse(JSON.stringify(board));
  for (const p of renamed.programs) {
    if (/^AD Mortgage/.test(String(p.lender))) { p.lender = OWNERS_CASE; p.investor = OWNERS_CASE; }
  }
  const before = merge({ loannex: renamed });
  const after = merge({ loannex: renamed }, { links: { [OWNERS_CASE]: { key: LINKED_TO } } });
  is(() =>before.unmapped.length === 1 && before.unmapped[0].name === OWNERS_CASE,
    'MERGE-1 without a link the investor is off the board and reported by name');
  ok(after.investors.length === before.investors.length + 1 && after.unmapped.length === 0,
    `MERGE-2 with the link the investor is ON the board (${before.investors.length} → ${after.investors.length}) and nothing is left unmapped`);
  const row = after.investors.find((i) => i.key === LINKED_TO);
  ok(row && row.joinedByLink === true,
    'MERGE-3 …and the row says it was joined by a person, not by a lookup');
  is(() =>Array.isArray(before.unmapped[0].suggestions) && before.unmapped[0].suggestions[0].key === LINKED_TO,
    'MERGE-4 the report carries what a person needs to ACT on it — the suggestion survives the de-duplication');
  const guessed = merge({ loannex: board }).investors.filter((i) => i.joinedByGuess).map((i) => i.key);
  ok(guessed.length >= 3 && guessed.includes('acra'),
    `MERGE-5 the board names the investors joined only by the heuristic, so they can be confirmed (${guessed.length})`);
  ok(merge({ loannex: board }).investors.every((i) => i.joinedByLink === false),
    'MERGE-6 …and with no links recorded, nothing claims to have been linked by anybody');
}

console.log('\n── THE SIDE BY SIDE THE OWNER ASKED FOR ──');
{
  const p = links.pairing({
    lenderprice: ['AD Mortgage LLC', 'Onity Mortgage Corp'],
    loannex: ['A & D Mortgage - Delegated', 'Onity Mortgage Corporation, f/k/a PHH Mortgage Corporation'],
  }, { [OWNERS_CASE]: { key: LINKED_TO } });
  const ad = p.rows.find((r) => r.key === LINKED_TO);
  is(() =>ad && ad.inBoth === true && ad.names.lenderprice[0].name === 'AD Mortgage LLC'
     && ad.names.loannex[0].name === OWNERS_CASE,
    'PAIR-1 one row shows what EACH program calls the investor, side by side');
  is(() =>ad && ad.names.loannex[0].linked === true && ad.names.lenderprice[0].linked === false,
    'PAIR-2 …and says which side a person had to link by hand');
  const phh = p.rows.find((r) => r.key === 'phh');
  ok(phh && phh.inBoth === true && phh.needsConfirming === true,
    'PAIR-3 a row joined by the heuristic is flagged for confirming rather than shown as settled');
  ok(p.rows.every((r) => typeof r.inBoth === 'boolean'),
    'PAIR-4 every row says whether BOTH programs quoted it — which is what makes "take it from this one" a real choice');
  const un = links.pairing({ loannex: ['Totally Unknown Lender Co'] }, {});
  is(() =>un.unlinked.length === 1 && un.unlinked[0].source === 'loannex',
    'PAIR-5 a spelling nobody has linked gets its own row — that row is the whole point');
  is(() =>Array.isArray(un.unlinked[0].suggestions),
    'PAIR-6 …with suggestions attached, so linking it is a click rather than a hunt');
}

console.log(fail ? `\nFAILURES: ${fail} (${pass} passed, ${fail} failed)` : `\nOFFLINE: all passed (${pass} passed, 0 failed)`);
process.exit(fail ? 1 : 0);

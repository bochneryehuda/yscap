#!/usr/bin/env node
/**
 * WHICH ORDERS BELONG TO THIS FILE.
 *
 * Owner-directed 2026-08-31: the flood, New York settlement agent and condo
 * orders are greyed on a file they do not apply to — *"Be visible that doesn't
 * belong for this file"* — rather than hidden.
 *
 * ── WHAT THIS SUITE USED TO BE, AND WHY IT IS NOT THAT ANY MORE ─────────────
 *
 * It was a DRIFT CHECK: `orders/applies.js` carried its own copy of two rules the
 * Condition Centre owns (`is_condo`, `is_new_york`), and this ran both over the
 * same values so a disagreement failed the build. It passed for as long as it
 * existed — and the A-to-Z audit found the desk greying the wrong cards anyway,
 * because the copy had NO ENTRY AT ALL for the payoff order or the verification
 * of rent. **A mirror test proves two copies AGREE; it can prove nothing about a
 * rule one of them has never heard of.** Both orders therefore showed as
 * belonging on every file, including the purchases and the owner-occupied files
 * whose conditions the engine never attaches.
 *
 * So the copy is GONE. The fact now comes from the engine — an order belongs on
 * this file when the CONDITION IT ANSWERS is on this file — and what this suite
 * pins is that there is no second rule left to drift, plus every behavioural
 * property the old one guarded: three-valued, an unknown is never a no, only the
 * flood fact is settable, and no card is ever hidden.
 *
 * PURE. The proof that a REAL file's greying matches the conditions the engine
 * really attached is in `test-lt-order-audit-db.js`, which no pure test can do.
 */
const applies = require('../src/longterm/orders/applies.js');
const kinds = require('../src/longterm/orders/kinds.js');
const library = require('../src/longterm/conditions-center/library.js');

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fails.push(detail ? `${name} — ${detail}` : name);
};

/** A file carrying exactly these conditions. */
const file = (...codes) => ({ conditionCodes: codes });

// ── A. THE FACT IS THE ENGINE'S, AND THERE IS NO SECOND COPY ────────────────
{
  const src = require('fs').readFileSync(`${__dirname}/../src/longterm/orders/applies.js`, 'utf8')
    // The comment explaining the removal necessarily NAMES the rules it removed,
    // so a guard that read comments would fail on its own explanation and then
    // get "fixed" by deleting the explanation.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* THE PRECISE CLAIM: no gate READS a fact off the file any more. The WORDING
     still names a condominium and a flood zone — it has to, it is the sentence a
     person reads — so a blunt search for those words would fail on the copy that
     is doing its job. What must not survive is a `read`, and any touch of the
     four facts the old table tested. */
  ok('no gate carries a reader of its own',
    Object.values(applies.GATES).every((g) => typeof g.read !== 'function'));
  for (const fact of ['propertyType', 'propertyState', 'inFloodZone', 'loanPurpose']) {
    ok(`the module never reads d.${fact}`, !new RegExp(`\\bd\\.${fact}\\b|\\bdata\\.${fact}\\b`).test(src));
  }
  ok('it reads the conditions on the file instead', /conditionCodes/.test(src));

  // Every gated kind must name a condition the library actually ships, or the
  // lookup can only ever answer "not for this file" — on every file, forever.
  const codes = new Set(library.library().map((c) => c.code));
  for (const k of Object.keys(applies.GATES)) {
    const def = kinds.orderKind(k);
    ok(`${k} names a condition`, !!(def && def.condition), 'no condition on the order kind');
    ok(`${k}'s condition is one the library ships`, codes.has(def && def.condition),
      `${def && def.condition} is in no library entry`);
  }
}

// ── B. THREE-VALUED, and the third value is the point ───────────────────────
{
  ok('a flood file applies',
    applies.appliesTo('flood_insurance', file('lt_order_flood_insurance')).applies === true);
  ok('a non-flood file does not',
    applies.appliesTo('flood_insurance', file('lt_order_title')).applies === false);
  ok('an UNREADABLE conditions list is not a no — hiding an order somebody needs costs a closing',
    applies.appliesTo('flood_insurance', { conditionCodes: null }).applies === null);
  ok('nor is a file object nobody passed', applies.appliesTo('flood_insurance', null).applies === null);
  ok('and it says so in plain words', /not.*said yet|Nobody has said/i.test(
    applies.appliesTo('flood_insurance', { conditionCodes: null }).why || ''));
  ok('a refusal explains itself',
    (applies.appliesTo('condo_questionnaire', file()).why || '').length > 10);
  ok('an EMPTY list is a real answer, not an unknown — a file with no conditions has no condo order',
    applies.appliesTo('condo_questionnaire', file()).applies === false);
}

// ── C. THE FIVE GATED KINDS, AND THE TWO THE AUDIT FOUND MISSING ────────────
{
  const gated = new Set(Object.keys(applies.GATES));
  ok('the payoff order is gated — it was not, and showed on every purchase',
    gated.has('payoff'));
  ok('the verification of rent is gated — it was not, and showed on every owner-occupied file',
    gated.has('vor'));
  ok('the three the owner named by hand are still gated',
    ['condo_questionnaire', 'flood_insurance', 'ny_settlement_agent'].every((k) => gated.has(k)));

  ok('a purchase is not asked to pay off a loan it does not have',
    applies.appliesTo('payoff', file('lt_order_title')).applies === false);
  ok('and a refinance is', applies.appliesTo('payoff', file('lt_payoff_ordered')).applies === true);
  ok('an owner-occupier is not asked for a landlord',
    applies.appliesTo('vor', file('lt_housing_history')).applies === false);
  ok('and a renter is', applies.appliesTo('vor', file('lt_vor_sent')).applies === true);

  // Most orders are not about a kind of file at all, and a gate nobody intended
  // is a card that silently greys itself.
  for (const k of kinds.ORDER_KIND_KEYS) {
    if (gated.has(k)) continue;
    ok(`${k} applies to every file`, applies.appliesTo(k, file()).applies === true);
  }
  ok('an unknown order kind applies rather than vanishing',
    applies.appliesTo('no_such_order', file()).applies === true);
}

// ── D. ONLY THE FLOOD FACT IS SETTABLE FROM THE DESK ────────────────────────
// The state, the property type, the loan purpose and whether the borrower rents
// are read from Encompass; correcting them in PILOT would put the two systems at
// odds on a fact the investor's own file is the authority on.
{
  ok('the flood question can be answered from the desk',
    applies.appliesTo('flood_insurance', file()).settable === true);
  for (const k of ['ny_settlement_agent', 'condo_questionnaire', 'payoff', 'vor']) {
    ok(`${k} is not settable from here`, applies.appliesTo(k, file()).settable === false);
  }
  ok('every gated kind names the fact a person would have to change',
    Object.keys(applies.GATES).every((k) => !!applies.appliesTo(k, file()).fact));
}

// ── E. A GREYED CARD IS A REFUSED ONE ───────────────────────────────────────
// The audit found `canOrder` TRUE on a card the desk had greyed, so `place` sent
// a verification of rent on a file with no landlord. The greying was cosmetic:
// the screen hid the button and the door took it anyway.
{
  const data = require('../src/longterm/orders/data.js');
  const ready = {
    conditionCodes: ['lt_order_title'],
    enabled: null, hasLoanNumber: true, propertyLine: '1 A St', borrowerName: 'A B',
    unreadable: [],
    vendors: { vor: { id: 'x', email: 'l@x.test' }, title: { id: 'y', email: 't@x.test' } },
  };
  const blocked = data.blockers('vor', ready);
  ok('an order that does not belong is a BLOCKER, not just a grey card',
    blocked.includes('not_for_file'), blocked.join(','));
  ok('and the refusal is the SAME sentence the card shows',
    data.blockerText('not_for_file', 'vor', ready) === applies.appliesTo('vor', ready).why);
  ok('an order that does belong is not blocked by this',
    !data.blockers('title', ready).includes('not_for_file'));
  ok('and an UNREADABLE conditions list never blocks — only a proven no does',
    !data.blockers('vor', { ...ready, conditionCodes: null }).includes('not_for_file'));
  ok('with nothing to ask, the wording falls back rather than pretending to know',
    /not for this kind of file/i.test(data.blockerText('not_for_file')));
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED:`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${pass} checks passed`);

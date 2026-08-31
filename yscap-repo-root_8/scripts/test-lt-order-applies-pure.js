#!/usr/bin/env node
/**
 * WHICH ORDERS BELONG TO THIS FILE.
 *
 * Owner-directed 2026-08-31: the flood, New York settlement agent and condo
 * orders are greyed on a file they do not apply to — *"Be visible that doesn't
 * belong for this file"* — rather than hidden.
 *
 * THE POINT OF THIS SUITE IS THE DRIFT CHECK. `orders/applies.js` restates two
 * rules the Condition Centre already owns (`is_condo`, `is_new_york`), because
 * the order desk cannot import the rule registry — it reads a whole loan context
 * the desk has no use for. Two copies of one rule is exactly the shape this repo
 * warns about, so the two are RUN OVER THE SAME VALUES here and any disagreement
 * fails the build. A desk that greys a card the conditions list still requires is
 * the failure this prevents.
 */
const applies = require('../src/longterm/orders/applies.js');
const registry = require('../src/longterm/conditions-center/field-registry.js');
const kinds = require('../src/longterm/orders/kinds.js');

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fails.push(detail ? `${name} — ${detail}` : name);
};

/** The registry reader for one field key, run over a synthetic context. */
function registryRead(key, property) {
  const map = registry.fieldMap();
  const f = map[key] || (Array.isArray(map) ? map.find((x) => x.key === key) : null);
  if (!f || typeof f.read !== 'function') return undefined;
  return f.read({ property });
}

// ── A. THE TWO SHARED RULES AGREE, VALUE FOR VALUE ──────────────────────────
{
  const states = ['NY', 'ny', 'New York', 'new york', ' NY ', 'NJ', 'PA', 'NYC', '', null, undefined];
  for (const state of states) {
    const mine = applies.appliesTo('ny_settlement_agent', { propertyState: state }).applies;
    const theirs = registryRead('is_new_york', { state });
    ok(`New York agrees on ${JSON.stringify(state)}`, mine === theirs,
      `orders said ${mine}, the condition centre said ${theirs}`);
  }

  const types = ['Condominium', 'condo', 'CONDO', 'Site Condo', 'SFR', 'Multi 2-4', 'PUD', '', null, undefined];
  for (const t of types) {
    const mine = applies.appliesTo('condo_questionnaire', { propertyType: t }).applies;
    const theirs = registryRead('is_condo', { gse_property_type: t });
    ok(`condo agrees on ${JSON.stringify(t)}`, mine === theirs,
      `orders said ${mine}, the condition centre said ${theirs}`);
  }
}

// ── B. THREE-VALUED, and the third value is the point ───────────────────────
{
  ok('a flood file applies', applies.appliesTo('flood_insurance', { inFloodZone: true }).applies === true);
  ok('a non-flood file does not', applies.appliesTo('flood_insurance', { inFloodZone: false }).applies === false);
  ok('an UNANSWERED flood question is not a no',
    applies.appliesTo('flood_insurance', {}).applies === null,
    'an unknown must never grey the order — hiding one somebody needs costs a closing');
  ok('and it says so in plain words', /not.*said yet|Nobody has said/i.test(
    applies.appliesTo('flood_insurance', {}).why || ''));
  ok('a refusal explains itself', (applies.appliesTo('condo_questionnaire', { propertyType: 'SFR' }).why || '').length > 10);
}

// ── C. EVERY OTHER ORDER APPLIES TO EVERY FILE ──────────────────────────────
// Most orders are not about a kind of property at all, and a gate nobody
// intended is a card that silently greys itself.
{
  const gated = new Set(Object.keys(applies.GATES));
  for (const k of kinds.ORDER_KIND_KEYS) {
    if (gated.has(k)) continue;
    ok(`${k} applies to every file`, applies.appliesTo(k, {}).applies === true);
  }
  ok('exactly the three the owner named are gated',
    [...gated].sort().join(',') === 'condo_questionnaire,flood_insurance,ny_settlement_agent',
    [...gated].join(','));
  ok('an unknown order kind applies rather than vanishing',
    applies.appliesTo('no_such_order', {}).applies === true);
}

// ── D. ONLY THE FLOOD FACT IS SETTABLE FROM THE DESK ────────────────────────
// The state and the property type are read from Encompass; correcting them in
// PILOT would put the two systems at odds on a fact the investor's own file is
// the authority on.
{
  ok('the flood question can be answered from the desk',
    applies.appliesTo('flood_insurance', {}).settable === true);
  ok('the state cannot', applies.appliesTo('ny_settlement_agent', {}).settable === false);
  ok('the property type cannot', applies.appliesTo('condo_questionnaire', {}).settable === false);
}

// ── E. A THROWING READER IS AN UNKNOWN, NEVER A NO ──────────────────────────
{
  const weird = { get propertyState() { throw new Error('unreadable'); } };
  ok('an unreadable fact answers "we cannot tell"',
    applies.appliesTo('ny_settlement_agent', weird).applies === null);
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED:`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${pass} checks passed`);

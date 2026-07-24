'use strict';
/**
 * PURE test — the budget-agreement gate's message shows the numbers EXACTLY as
 * it compares them (owner-reported 2026-07-24: the sign-off gate refused with
 * "Budgets do not match" while every figure it printed read "$120,000" — the
 * real gap was cents, hidden because the message rounded to whole dollars while
 * the comparison ran to the cent).
 *
 * Locks the contract of rehab-budget.js:
 *   · budgetSignoffCheck — the sign-off gate (staff.js) comparison + message:
 *     cent-precision display, names exactly WHICH pair disagrees and BY HOW
 *     MUCH, comma/"$"-tolerant parsing (same toNum as the submit gate), no
 *     false fire on float noise, null when everything agrees.
 *   · checkSowBudget's messages (via moneyExact/gapPhrase) — same precision rule.
 *
 *   node scripts/test-budget-mismatch-message-pure.js
 */
const R = require('path').resolve(__dirname, '..');
const RB = require(R + '/src/lib/rehab-budget');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const payload = (total, target) => ({ total, state: target != null ? { target } : {} });

// ---- moneyExact / gapPhrase: the display primitives ----
ok(RB.moneyExact(120000) === '$120,000.00', 'moneyExact always shows cents');
ok(RB.moneyExact(119999.99) === '$119,999.99', 'moneyExact keeps a cent-level value visible');
ok(RB.moneyExact(120000.004) === '$120,000.00', 'moneyExact rounds sub-cent noise exactly like the comparison');
ok(RB.gapPhrase(119999.99, 120000) === '$0.01 lower', 'gapPhrase names a one-cent shortfall');
ok(RB.gapPhrase(120025, 120000) === '$25.00 higher', 'gapPhrase names a dollar-level excess');

// ---- all agree → null (no refusal) ----
ok(RB.budgetSignoffCheck(payload(120000, 120000), 120000, { rehabBudget: 120000 }) === null, 'all four equal → sign-off allowed');
ok(RB.budgetSignoffCheck(payload(120000), 120000, { rehabBudget: 120000 }) === null, 'no first-page target set → the other three agreeing is enough');
ok(RB.budgetSignoffCheck(payload(120000, 120000), 120000, null) === null, 'no registered budget in inputs → remaining pair rules apply');

// ---- float noise must NEVER refuse (compare at cents, like eqCents) ----
ok(RB.budgetSignoffCheck(payload(120000.0000001, 120000), 120000, { rehabBudget: 119999.999999 }) === null, 'sub-cent float noise never fires the gate');

// ---- THE REPORTED CLASS: a cents-level gap must be VISIBLE and NAMED ----
let msg = RB.budgetSignoffCheck(payload(119999.99, 120000), 120000, { rehabBudget: 120000 });
ok(!!msg, 'a one-cent SOW shortfall refuses sign-off (the rule is to-the-cent)');
ok(msg.includes('$119,999.99') && msg.includes('$120,000.00'), 'the message shows BOTH values at cent precision — never two identical rounded figures');
ok(msg.includes('$0.01 lower'), 'the message names the exact gap');
ok(msg.includes('Scope of Work line-item total'), 'the message names WHICH number is off');
ok(!/\$120,000[^.,]/.test(msg + ' '), 'no dollar-rounded "$120,000" (without cents) appears anywhere in the message');

// ---- each pair is named individually ----
msg = RB.budgetSignoffCheck(payload(120000, 120000), 120000, { rehabBudget: 121000 });
ok(msg.includes('registered product budget $121,000.00') && msg.includes('$1,000.00 lower'), 'a registered-product disagreement is named with its gap');
ok(msg.includes('re-register the product'), 'the fix instruction still tells them how to resolve it');
msg = RB.budgetSignoffCheck(payload(120000, 119000), 120000, { rehabBudget: 120000 });
ok(msg.includes('first-page construction budget $119,000.00') && msg.includes('$1,000.00 lower'), 'a first-page disagreement is named with its gap');

// ---- parser unification: comma/"$"-formatted stored values never false-fire ----
ok(RB.budgetSignoffCheck(payload('120,000.00', '$120,000'), 120000, { rehabBudget: '120,000' }) === null, 'comma/"$" formatted payload + registration values parse (toNum) — no false fire');
msg = RB.budgetSignoffCheck(payload('119,999.99'), 120000, { rehabBudget: 120000 });
ok(!!msg && msg.includes('$0.01 lower'), 'formatted values still compare at cents when genuinely different');

// ---- not-submitted still refuses plainly ----
ok(/not been submitted/.test(RB.budgetSignoffCheck({}, 120000, null) || ''), 'a missing SOW total refuses with the plain not-submitted message');

// ---- checkSowBudget's submit-gate wording uses the same precision rule ----
// (pure shim: fake client resolving the required budget from a registration row)
const fakeClient = (rehabBudget) => ({
  async query(sql) {
    if (/FROM product_registrations/.test(sql)) return { rows: [{ inputs: { rehabBudget }, stale: false }] };
    return { rows: [{ rehab_budget: rehabBudget }] };
  },
});
(async () => {
  const r = await RB.checkSowBudget('app-x', payload(119999.99, 120000), fakeClient(120000));
  ok(r.ok === false, 'submit gate: one-cent shortfall refuses');
  ok(r.message.includes('$119,999.99') && r.message.includes('$120,000.00'), 'submit gate message shows cent-precision values');
  ok(r.message.includes('$0.01 lower'), 'submit gate message names the exact gap');
  const r2 = await RB.checkSowBudget('app-x', payload(120000, 120000), fakeClient(120000));
  ok(r2.ok === true, 'submit gate: equal budgets pass');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

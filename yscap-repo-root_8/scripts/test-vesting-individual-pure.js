'use strict';
/**
 * VESTING IN AN INDIVIDUAL'S NAME (owner-directed 2026-08-02) — the two rules,
 * proven with no database.
 *
 *   #25  Marking a file individual is allowed from any door with NOTHING
 *        attached; the non-owner-occupied affidavit becomes its own rule-driven
 *        condition rather than a hidden prerequisite of the act.
 *   #26  GOLD REFUSES a registration on individual vesting, with the message
 *        that you must switch to an LLC — authorized by the owner in their own
 *        words.
 *
 * THE PROPERTY THIS FILE EXISTS TO GUARD: the Gold refusal must live OUTSIDE the
 * frozen engines. `gold-standard.js` already carries the identical rule and it
 * has always been dark, because nothing populates `input.vesting`. Feeding that
 * input would be a change to a frozen engine's behaviour on live files, which
 * needs its own written authorization — the owner authorized the REFUSAL, not a
 * rewrite of the engine. So this test asserts the engines are untouched as
 * firmly as it asserts the refusal works.
 */
const path = require('path');
const fs = require('fs');
const V = require('../src/lib/vesting-program-rule');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

console.log('\nA. what counts as vesting in an individual\'s name');

ok(V.vestsInIndividual({ personal_name_purchase: true, llc_id: null }) === true,
  'the flag set with no entity IS individual vesting');
ok(V.vestsInIndividual({ personal_name_purchase: false, llc_id: null }) === false,
  'the flag off is not');
ok(V.vestsInIndividual({}) === false, 'a file that has never been marked is not');
// A LINKED ENTITY ALWAYS WINS — the same precedence the conditions engine and the
// vesting route already use. A stale flag next to a real LLC must never refuse a
// Gold registration that is perfectly legitimate.
ok(V.vestsInIndividual({ personal_name_purchase: true, llc_id: 'some-uuid' }) === false,
  'an LLC on the file WINS over a stale individual flag');
ok(V.vestsInIndividual(null) === false, 'a missing row is not individual — never refuse on nothing');
ok(V.vestsInIndividual({ personal_name_purchase: 'yes' }) === false,
  'only a real true counts — a truthy string is not a decision');

console.log('\nB. GOLD refuses; nothing else does');

const individual = { personal_name_purchase: true, llc_id: null };
const entity = { personal_name_purchase: false, llc_id: 'uuid' };

for (const g of ['gold', 'Gold', 'GOLD', 'Gold Standard', 'gold_standard']) {
  ok(!!V.registrationRefusal(individual, g), `Gold spelled "${g}" refuses individual vesting`);
}
ok(/switch/i.test(V.registrationRefusal(individual, 'gold') || ''),
  'the refusal tells them to switch to an LLC — the owner\'s own instruction');
ok(/LLC name/i.test(V.registrationRefusal(individual, 'gold') || ''),
  '…and to enter the LLC name');
ok(/does not allow/i.test(V.registrationRefusal(individual, 'gold') || ''),
  '…and says why, in the owner\'s words');

// SCOPE IS DELIBERATELY NARROW. The owner named Gold. Refusing more than was
// asked would block deals that are fine today.
for (const p of ['standard', 'Standard', 'silver', 'Silver', 'manual', 'Manual', 'bridge', '']) {
  ok(V.registrationRefusal(individual, p) === null,
    `"${p || '(no program)'}" is NOT refused — only Gold was named`);
}
ok(V.registrationRefusal(entity, 'gold') === null,
  'Gold on an ENTITY registers normally, which is the ordinary case');
ok(V.registrationRefusal(null, 'gold') === null,
  'no file row → no refusal (never refuse a deal on a value we could not read)');
ok(V.registrationRefusal(individual, null) === null, 'no program → nothing to refuse');

console.log('\nC. the refusal is PURE and can never throw into a registration');

for (const [what, a, p] of [
  ['junk app', 42, 'gold'], ['junk program', individual, {}],
  ['both junk', undefined, undefined], ['array app', [], 'gold'],
]) {
  let threw = false, r;
  try { r = V.registrationRefusal(a, p); } catch (_) { threw = true; }
  ok(!threw, `${what} → no throw`);
  ok(r === null || typeof r === 'string', `${what} → a reason or nothing, never junk`);
}
{
  // Pure means pure: no db, no network, nothing that can fail at import time.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'vesting-program-rule.js'), 'utf8');
  ok(!/require\(/.test(src), 'the module requires NOTHING — it cannot fail at load');
}

console.log('\nD. THE FROZEN ENGINES ARE UNTOUCHED — the whole point of putting it here');

{
  const roots = ['web/tools', 'web/v2/tools', 'web/portal/engines', 'web/v2/portal/engines',
    'app/public/engines', 'app-v2/public/engines'];
  let checked = 0;
  for (const r of roots) {
    const f = path.join(__dirname, '..', r, 'gold-standard.js');
    if (!fs.existsSync(f)) continue;
    checked++;
    const src = fs.readFileSync(f, 'utf8');
    // The dark branch must still be exactly as dark as it was: present, and still
    // reading an input nothing populates. If somebody "helpfully" starts feeding
    // `vesting`, the engine's behaviour changes on live files — the thing that
    // needs its own written authorization.
    ok(/input\.vesting \|\| input\.borrowerType \|\| input\.borrowerEntity/.test(src),
      `${r}/gold-standard.js still carries its own dormant rule, unedited`);
  }
  ok(checked >= 1, `at least one copy of the frozen engine was actually checked (${checked})`);
}
{
  // And the refusal must not have been wired INTO the engine input anywhere.
  const pricing = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'pricing.js'), 'utf8');
  ok(!/\bvesting\s*:/.test(pricing),
    'src/lib/pricing.js does not start feeding a `vesting` input to the engines');
}

console.log('\nE. every register door asks, and asks the same way');

{
  const staff = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
  const borrower = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'borrower.js'), 'utf8');
  const inStaff = (staff.match(/registrationRefusal\(/g) || []).length;
  const inBorrower = (borrower.match(/registrationRefusal\(/g) || []).length;
  // Three doors register a product: the staff register, the staff accept-counter,
  // and the borrower register. Guarding two of three leaves a way around it.
  ok(inStaff === 2, `both staff register doors ask (found ${inStaff})`);
  ok(inBorrower === 1, `the borrower register door asks (found ${inBorrower})`);
  ok(/field: 'vesting'/.test(staff) && /field: 'vesting'/.test(borrower),
    'each refusal names the field, so the screen can point at it');
}

console.log('\nF. the affidavit is a CONDITION now, not a prerequisite of marking individual');

{
  const staff = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
  // BOTH copies had to go: the route's own 400, and the SECOND demand hidden in
  // signOffGate's LLC branch. Leaving either would mean one affidavit asked for
  // twice, and the LLC condition unclosable on a file with no entity at all.
  ok(!/Upload the non-owner-occupied affidavit \(PDF\) to sign this off/.test(staff),
    'neither copy of the "upload the affidavit first" refusal survives');
  ok(/if \(pn && pn\.personal_name_purchase\) return null;/.test(staff),
    'the LLC sign-off gate stands down on a personal-name file — there is no entity to verify');
  const route = staff.slice(staff.indexOf("vesting/personal-name"));
  const body = route.slice(0, 8000);
  ok(/personal_name_purchase=true/.test(body), 'marking the file individual still works');
  ok(/waived_at=now\(\), is_required=false/.test(body),
    'with no affidavit the LLC condition is WAIVED as not-applicable, never signed off as met');
  ok(/signed_off_at=now\(\)/.test(body),
    '…and is still properly signed off when the affidavit IS in hand');
  ok(/evaluateApplication/.test(body),
    'the engine runs immediately, so the affidavit condition appears at once');
}
{
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '408_vesting_individual_affidavit.sql'), 'utf8');
  ok(/cond_noo_affidavit_individual/.test(sql), 'the affidavit condition is seeded');
  ok(/vesting_is_individual/.test(sql) && /is_true/.test(sql),
    '…rule-driven, so linking an LLC later retracts it on its own');
  ok(/'both'/.test(sql), '…visible to the borrower who signs it AND the team who chases it');
  ok(/prior_to_docs/.test(sql),
    '…and it holds CLEAR TO CLOSE, which is the protection the old refusal gave');
  ok(/personal_name_purchase = true/.test(sql),
    'previous files already marked individual get it too');
}
{
  const reg = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'conditions', 'field-registry.js'), 'utf8');
  const eng = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'conditions', 'engine.js'), 'utf8');
  ok(/vesting_is_individual/.test(reg), 'the rule field is registered');
  ok(/vesting_is_individual: !!\(/.test(eng),
    'the engine supplies it with `!!` — a blank actual would make is_false wrongly false');
  ok(/personal_name_purchase && !a\.llc_id/.test(eng),
    '…and an LLC on the file wins, exactly as everywhere else');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  vesting-individual: the choice is free, the affidavit is a condition, and Gold refuses — outside the frozen engines');
process.exit(fail ? 1 : 0);

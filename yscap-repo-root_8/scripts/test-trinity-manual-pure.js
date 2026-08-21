/* TRINITY MANUAL — ordering a physical inspection by hand on ANY file, and ordering the RIGHT
 * product (owner-directed 2026-08-21, item 25).
 *
 * The owner: *"At any time, even though a process is not set up for autopilot on Trinity (for
 * example, something that belongs to Bluelake before it's sold or something that is set up for
 * virtual but, one time, he doesn't have access and he wants to order a physical), we should have a
 * full section set up … it should be able to be manually placed on any file … Also, you need to make
 * sure that the product that you ordered is the correct product. I want to make sure to get the list
 * of products."*
 *
 * What this pins:
 *   A. THE ROUTING RULE DOES NOT MOVE. `isTrinityFile` — which is what decides everything automatic —
 *      answers exactly as it did, so a virtual file's inspections stay Sitewire's and a Blue Lake
 *      file's stay TrustPoint's;
 *   B. the deliberate human act beside it: refused unless asked for, refused without a real reason,
 *      and refused outright on a file we could not READ (a fault, not a business state);
 *   C. what the coordinator is asked to acknowledge — the second-inspector hazard, in plain words;
 *   D. the product catalogue is read from TRINITY's own list, and an unreadable list is reported as
 *      unread rather than as "they sell nothing";
 *   E. the wiring — the automatic doors never overrule anything, the section is on every file, and
 *      the screen and the server read ONE rule.
 *
 * Pure — no database, no network.
 * Run: node scripts/test-trinity-manual-pure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const E = require('../src/trinity/eligibility');
const C = require('../src/trinity/catalog');

const TRINITY = { platform: 'sitewire', method: 'traditional', resolved: true };
const VIRTUAL = { platform: 'sitewire', method: 'mobile', resolved: true };
const BLUELAKE = { platform: 'trustpoint', method: 'traditional', resolved: true };
const EXTERNAL = { platform: 'external', method: 'traditional', resolved: true };
const UNREAD = { platform: null, method: null, resolved: false };
const GOOD_REASON = 'the virtual inspector cannot get access';

// ---------------------------------------------------------------- A. the rule does not move
ok('A1 a physical, PILOT-administered file is still Trinity\'s', E.isTrinityFile(TRINITY) === true);
ok('A2 a virtual file is still Sitewire\'s', E.isTrinityFile(VIRTUAL) === false);
ok('A3 a Blue Lake file is still TrustPoint\'s', E.isTrinityFile(BLUELAKE) === false);
ok('A4 a partner-run file is still theirs', E.isTrinityFile(EXTERNAL) === false);
ok('A5 a file we could not read is still refused', E.isTrinityFile(UNREAD) === false);

// ---------------------------------------------------------------- B. the deliberate act
{
  const p = E.planManualOrder(TRINITY, {});
  ok('B1 on a Trinity file nothing is being overruled', p.ok === true && p.override === false);
  ok('B2 …and there is nothing to warn about', p.warning === null);
  ok('B3 …and no reason is demanded', p.needsReason === false && p.reason === null);
}
for (const [label, ctx] of [['virtual', VIRTUAL], ['Blue Lake', BLUELAKE], ['partner-run', EXTERNAL]]) {
  const plain = E.planManualOrder(ctx, {});
  ok(`B4 ${label}: not ordered by simply pressing the button`, plain.ok === false);
  ok(`B5 ${label}: …and the refusal says a human MAY overrule it`, plain.mayOverride === true);
  ok(`B6 ${label}: …and says what the file is`, !!plain.blockedReason);

  const noWhy = E.planManualOrder(ctx, { override: true });
  ok(`B7 ${label}: asking without a reason is refused`, noWhy.ok === false && noWhy.needsReason === true);
  const shortWhy = E.planManualOrder(ctx, { override: true, overrideReason: 'x' });
  ok(`B8 ${label}: a reason too short to mean anything is not a reason`, shortWhy.ok === false && shortWhy.needsReason === true);

  const good = E.planManualOrder(ctx, { override: true, overrideReason: GOOD_REASON });
  ok(`B9 ${label}: with a real reason it goes ahead`, good.ok === true && good.override === true);
  eq(`B10 ${label}: …carrying the reason the file will record`, good.reason, GOOD_REASON);
}
{
  const p = E.planManualOrder(UNREAD, { override: true, overrideReason: GOOD_REASON });
  ok('B11 a file whose setup could not be READ is refused even with a reason', p.ok === false);
  ok('B12 …because that is a fault, not a decision — and it says to try again',
    /could not be read/.test(String(p.blockedReason || '')));
  ok('B13 …and it is never offered as overrulable', p.mayOverride === false);
}
{
  const long = 'x'.repeat(900);
  const p = E.planManualOrder(VIRTUAL, { override: true, overrideReason: long });
  ok('B14 an essay is capped before it reaches the column', p.ok && p.reason.length <= 500);
  const trimmed = E.planManualOrder(VIRTUAL, { override: true, overrideReason: `   ${GOOD_REASON}   ` });
  eq('B15 …and stray spacing is trimmed', trimmed.reason, GOOD_REASON);
  ok('B16 the string "true" counts as asking (a form field is text)',
    E.planManualOrder(VIRTUAL, { override: 'true', overrideReason: GOOD_REASON }).ok === true);
  ok('B17 …but anything else does not', E.planManualOrder(VIRTUAL, { override: 'maybe', overrideReason: GOOD_REASON }).ok === false);
}

// ---------------------------------------------------------------- C. what they acknowledge
ok('C1 a virtual file warns that Sitewire is ALREADY inspecting it',
  /VIRTUAL/.test(E.overrideWarning(VIRTUAL)) && /physical inspector as well/.test(E.overrideWarning(VIRTUAL)));
ok('C2 a Blue Lake file names the note buyer\'s own inspections',
  /Blue Lake/.test(E.overrideWarning(BLUELAKE)) && /as well/.test(E.overrideWarning(BLUELAKE)));
ok('C3 a partner-run file says their process will not know about it',
  /partner/.test(E.overrideWarning(EXTERNAL)));
ok('C4 every warning says Trinity charges for it',
  [VIRTUAL, BLUELAKE, EXTERNAL].every((c) => /charges for it/.test(E.overrideWarning(c))));
ok('C5 a Trinity file has nothing to acknowledge', E.overrideWarning(TRINITY) === null);

// ---------------------------------------------------------------- D. the product
{
  // The shape Trinity actually returns: categories carrying forms.
  const payload = { categories: [
    { name: 'Draw Inspection', forms: [
      { id: 19, name: 'Blank General Purpose Line Item Draw' },
      { id: 26, name: 'Percent Complete Draw' }] },
    { name: 'Site Inspections', forms: [
      { id: 775, name: 'Clear Lot Inspection' },
      { id: 912, name: 'SFR Drone Inspection' }] },
  ] };
  const flat = C.flattenForms(payload);
  eq('D1 every product in their tree is found', flat.map((f) => f.id).sort((a, b) => a - b), [19, 26, 775, 912]);
  eq('D2 …carrying the family it sits in', flat.find((f) => f.id === 912).category, 'Site Inspections');
  ok('D3 a product is only an id AND a name together — a category is not a product',
    !flat.some((f) => f.name === 'Draw Inspection'));

  const good = C.productCheck(payload, 19);
  ok('D4 the product we order is confirmed against THEIR list', good.enabled === true && good.read === true);
  ok('D5 …by its real name', /Blank General Purpose Line Item Draw/.test(good.message));
  ok('D6 …and says WHY it is that one', /line by line/.test(good.message));

  const missing = C.productCheck(payload, 1079);
  ok('D7 a product NOT on the account is called out, not assumed', missing.enabled === false);
  ok('D8 …and what the account does offer is listed', /19 Blank General Purpose/.test(missing.message));

  const unread = C.productCheck(null, 19);
  ok('D9 an unreadable list says so', unread.read === false && unread.enabled === null);
  ok('D10 …and is NEVER stated as "they sell nothing"', /NOT a statement/.test(unread.message));

  ok('D11 the product the owner named is REPORTED where it exists, never silently substituted',
    good.droneProducts.length === 1 && good.droneProducts[0].id === 912);
  ok('D12 …and it is not what we order (a drone inspection is not a draw)', good.formId === 19);
  eq('D13 a list with no such product reports none', C.productCheck({ forms: [{ id: 19, name: 'Line Item Draw' }] }, 19).droneProducts, []);
  ok('D14 junk never throws', (() => {
    for (const v of [undefined, null, 0, '', 'x', [], {}, { forms: 'no' }]) C.productCheck(v, 19);
    return true;
  })());
}

// ---------------------------------------------------------------- E. the wiring
{
  const intake = read('src/trinity/intake.js');
  ok('E1 the hand-placed door reads the ONE rule', /eligibility\.planManualOrder\(ctx, \{ override, overrideReason \}\)/.test(intake));
  ok('E2 …and records the reason on the file before the order goes out',
    /manual_override_reason = \$2, manual_override_by = \$3, manual_override_at = now\(\)/.test(intake));
  ok('E3 …only when it really was an override', /if \(plan\.override\) \{/.test(intake));
  // The three automatic doors must never overrule anything — that is what keeps the 2026-08-14
  // direction ("don't mess up sitewire for virtuals, don't touch trustpoint") intact.
  ok('E4 the automatic Sitewire door still asks the plain rule',
    /function maybeOrderFromSitewire[\s\S]{0,900}?eligibility\.isTrinityFile/.test(intake));
  ok('E5 …and no automatic caller passes an override',
    !/maybeOrderFromSitewire[\s\S]{0,900}?override:\s*true/.test(intake));
  ok('E6 the desk is told whether a human may overrule this file', /mayOverride: plan\.mayOverride && !eligible/.test(intake));
  ok('E7 …and what they would be acknowledging', /overrideWarning: plan\.warning/.test(intake));

  const route = read('src/routes/trinity.js');
  ok('E8 the door is gated on managing draws', /can\(req, 'manage_draws'\)/.test(route));
  ok('E9 …passes the ask and the reason through, never widening anything itself',
    /override: b\.override === true \|\| b\.override === 'true'/.test(route) && /overrideReason: b\.overrideReason/.test(route));
  ok('E10 …and the file\'s audit trail records the act', /'trinity_manual_override_order'/.test(route));
  ok('E11 the product list is read live from Trinity, cached, and never invented',
    /router\.get\('\/products'/.test(route) && /client\.forms\(\)/.test(route));
  ok('E12 …through the ONE catalogue reader, shared with the health page',
    (route.match(/catalog\.productCheck\(/g) || []).length >= 2);

  const ui = read('app-v2/src/components/DrawsPanel.jsx');
  ok('E13 the section is named the way the owner named it', /Trinity Manual — physical inspections/.test(ui));
  ok('E14 …and no longer disappears on a file that is not Trinity\'s',
    !/if \(!orders\.length && !\(orderable\.eligible && canOrder\.length\)\) return null;/.test(ui));
  ok('E15 the override is offered only where the server says it may be',
    /orderable\.eligible \|\| orderable\.mayOverride/.test(ui));
  ok('E16 …the warning shown is the SERVER\'s wording, never a second copy',
    /orderable\.overrideWarning/.test(ui) && !/physical inspector as well/.test(ui));
  ok('E17 …the button is dead until a real reason is typed', /why\.trim\(\)\.length < 8/.test(ui));
  ok('E18 …and the reason rides with the order', /body\.override = true; body\.overrideReason = why\.trim\(\);/.test(ui));
  ok('E19 the product we order is shown to the person pressing the button',
    /\/api\/trinity\/products/.test(ui) && /products\.message/.test(ui));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

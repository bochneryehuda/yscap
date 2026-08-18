#!/usr/bin/env node
'use strict';
/* GROUND-UP CONSTRUCTION IS INSPECTED ON SITE (owner-directed 2026-08-18: "any kind of Ground Up
 * construction project should be defaulted to physical inspection … it should not allow you to set
 * it up as virtual … This is for all other note buyers and investors other than Bluelake — Bluelake
 * follows their own process directly with TrustPoint, and we don't touch that process").
 *
 * Two halves:
 *   A. the PURE rule (src/sitewire/inspection-policy.js) — the whole truth table, including the two
 *      stand-down cases that keep the rule from over-reaching: a non-Sitewire platform (Blue Lake /
 *      external are not ours to police) and resolved:false (a file whose routing could not be read
 *      must never be re-methoded on a guess).
 *   B. SOURCE guards over every consumer (the accepted pattern where the surface is a route/orchestrator
 *      whose IO a pure test can't run — cf. test-trinity-eligibility-pure §F): all FOUR enforcement
 *      sites consult the ONE module, plus the display mirrors, so a refactor that drops one silently
 *      re-arms the virtual path there.
 */
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const P = require('../src/sitewire/inspection-policy');
const T = require('../src/sitewire/transforms');

// ---- A. the rule itself -------------------------------------------------------------------------
ok('A1 ground-up + sitewire requires traditional',
  P.requiredMethodFor({ constructionType: 'ground_up', platform: 'sitewire', resolved: true }) === 'traditional');
ok('A2 a rehab file is not touched',
  P.requiredMethodFor({ constructionType: 'rehabilitation_or_remodel', platform: 'sitewire', resolved: true }) === null);
ok('A3 Blue Lake (trustpoint) is NEVER ours to police',
  P.requiredMethodFor({ constructionType: 'ground_up', platform: 'trustpoint', resolved: true }) === null);
ok('A4 a handled-externally partner is never ours either',
  P.requiredMethodFor({ constructionType: 'ground_up', platform: 'external', resolved: true }) === null);
ok('A5 an unresolvable routing stands DOWN (never re-method on a guess)',
  P.requiredMethodFor({ constructionType: 'ground_up', platform: 'sitewire', resolved: false }) === null);
ok('A6 trinity platform is not sitewire — the policy does not fire there',
  P.requiredMethodFor({ constructionType: 'ground_up', platform: 'trinity', resolved: true }) === null);
ok('A7 empty context is safe', P.requiredMethodFor(null) === null && P.requiredMethodFor({}) === null);

ok('A8 choosing mobile on a ground-up sitewire file is forbidden',
  P.groundUpVirtualForbidden({ constructionType: 'ground_up', platform: 'sitewire', resolved: true }, 'mobile') === true);
ok('A9 traditional is always fine',
  P.groundUpVirtualForbidden({ constructionType: 'ground_up', platform: 'sitewire', resolved: true }, 'traditional') === false);
ok('A10 mobile on a rehab file is fine',
  P.groundUpVirtualForbidden({ constructionType: 'rehabilitation_or_remodel', platform: 'sitewire', resolved: true }, 'mobile') === false);
ok('A11 mobile on a Blue Lake ground-up is not ours to refuse',
  P.groundUpVirtualForbidden({ constructionType: 'ground_up', platform: 'trustpoint', resolved: true }, 'mobile') === false);
ok('A12 a blank/unknown method is not "mobile"',
  P.groundUpVirtualForbidden({ constructionType: 'ground_up', platform: 'sitewire', resolved: true }, null) === false
  && P.groundUpVirtualForbidden({ constructionType: 'ground_up', platform: 'sitewire', resolved: true }, '') === false);
ok('A13 the refusal wording names the rule in plain language',
  /ground-up/i.test(P.reasonPhysicalRequired()) && /ON SITE|physical/i.test(P.reasonPhysicalRequired())
  && /Trinity/.test(P.reasonPhysicalRequired()));

// The construction type comes from the draw side's OWN reader — the policy composes with it,
// so the classifier and the rule can never disagree about what "ground-up" means.
ok('A14 transforms.constructionType feeds the rule: a ground-up loan type classifies ground_up',
  P.groundUpVirtualForbidden({
    constructionType: T.constructionType('Ground Up Construction', null, 'standard') || 'rehabilitation_or_remodel',
    platform: 'sitewire', resolved: true,
  }, 'mobile') === true);
ok('A15 …and a fix & flip with light rehab does not',
  P.groundUpVirtualForbidden({
    constructionType: T.constructionType('Fix & Flip', 'Light Rehab', 'standard') || 'rehabilitation_or_remodel',
    platform: 'sitewire', resolved: true,
  }, 'mobile') === false);

// ---- B. source guards — every consumer reads the ONE module -------------------------------------
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const routes = read('src/routes/sitewire.js');
const orch = read('src/sitewire/orchestrator.js');
const recon = read('src/sitewire/reconcile.js');
const rulesJsx = read('app-v2/src/screens/StaffDrawRules.jsx');
const drawsJsx = read('app-v2/src/components/DrawsPanel.jsx');

// 1. the Start-draw door refuses a 'mobile' choice on a ground-up file, 422, with the shared wording
ok('B1 start-draw consults the policy on a mobile choice',
  /chosen === 'mobile'[\s\S]{0,400}groundUpVirtualForbidden/.test(routes));
ok('B2 start-draw answers 422 with the ONE wording',
  /groundUpVirtualForbidden[\s\S]{0,200}status\(422\)\.json\(\{ error: policy\.reasonPhysicalRequired\(\) \}\)/.test(routes));

// 2. the live-property controls door — the same refusal AFTER the property is pushed
ok('B3 updatePropertyControls refuses mobile on a ground-up file',
  /method_forbidden_ground_up/.test(orch)
  && /if \(m === 'mobile'\) \{[\s\S]{0,500}groundUpVirtualForbidden[\s\S]{0,300}method_forbidden_ground_up/.test(orch));
ok('B4 the route maps that refusal to the plain-language reason',
  /method_forbidden_ground_up.*reasonPhysicalRequired/.test(routes));

// 3. the birth push FORCES traditional (journaled) or PARKS a genuine physical-forbidden conflict
ok('B5 pushFile forces a resolved mobile to traditional on a ground-up file',
  /groundUpVirtualForbidden[\s\S]{0,600}resolveInspection\(Object\.assign\(\{\}, existingLink \|\| \{\}, \{ inspection_method: 'traditional' \}\), rule\)/.test(orch));
ok('B6 the forcing is journaled as ground_up_policy',
  /source: 'ground_up_policy'/.test(orch));
ok('B7 a partner rule forbidding physical PARKS instead of silently overriding',
  /sitewire_groundup_requires_physical/.test(orch) && /parked: 'groundup_physical'/.test(orch));

// 4. the reconcile drift check — a ground-up property found VIRTUAL in Sitewire = review + warning email
ok('B8 reconcile raises the drift review',
  /sitewire_groundup_virtual_drift/.test(recon));
ok('B9 …with a real EMAIL to the file team (never inAppOnly)',
  /sitewire_groundup_virtual_drift[\s\S]{0,1600}notifyAppStaff[\s\S]{0,900}inAppOnly: false/.test(recon));
ok('B10 the email states the rule in the owner\'s words',
  /not allowed to be done on virtual draws/.test(recon) && /Trinity process/.test(recon));
ok('B11 one warning per drift episode — the OPEN review row is the already-told-them record',
  /status='open' AND reason LIKE 'sitewire_groundup_virtual_drift%'/.test(recon));
ok('B12 the drift check stands down when the routing is unresolved',
  /fileCtx\.resolved && policy\.groundUpVirtualForbidden/.test(recon));

// display mirrors — never a switch the server will refuse
ok('B13 the Start-draw preview mirrors the forcing + reports ground_up_physical_only',
  /ground_up_physical_only: groundUpPhysicalOnly/.test(routes)
  && /can_switch: insp\.allowVirtual && insp\.allowPhysical && !groundUpPhysicalOnly/.test(routes));
ok('B14 the live-property read mirrors it too',
  /ground_up_physical_only: groundUpOnly/.test(routes)
  && /can_switch: insp\.allowVirtual && insp\.allowPhysical && !groundUpOnly/.test(routes));
ok('B15 the admin Draw Rules screen states the rule beside the allow checkboxes',
  /Ground-up projects are always inspected on site/.test(rulesJsx));
ok('B16 the desk explains WHY the switch is absent on a ground-up file',
  /ground_up_physical_only/.test(drawsJsx) && /always inspected on site/i.test(drawsJsx));

// the module itself stays PURE — a require() in it would let IO leak into the four call sites' rule
const policySrc = read('src/sitewire/inspection-policy.js');
ok('B17 the policy module is pure (no requires, no IO)',
  !/require\(/.test(policySrc) && !/db\.|fetch\(|query\(/.test(policySrc));

console.log(`test-inspection-policy-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// LONG-TERM — the compensation PLAN resolution + the settings doors (owner-directed 2026-08-23).
//
// PURE: comp-plan.js takes plain objects, the declarations module has no database, and the
// route checks here are source-level — so CI runs all of it with nothing installed.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const cp = require('../src/longterm/comp-plan.js');
const decl = require('../src/longterm/settings/encompass-settings.js');
const access = require('../src/longterm/access.js');
const settingsRoute = require('../src/longterm/routes/settings.js');
const { DEFAULT_COMP_PLAN } = await import('../app-v2/src/longterm/compOverlay.js');

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};

const D = decl.defaults();

console.log('\nA. the resolution chain: yours → company → standard');
{
  const base = { defaults: D, company: {}, user: {}, userStored: new Set() };
  const r = cp.resolveCompPlan(base);
  ok(r.plan.lenderPaid === 2 && r.source.lenderPaid === 'standard', 'A1 nothing set → the declared 2.0, marked standard');
  ok(r.plan.applicationFee === 1595 && r.plan.commitmentFee === 500, 'A2 the declared fees ($1,595 / $500)');

  const r2 = cp.resolveCompPlan({ ...base, company: { 'comp.lenderPaid': 2.5 } });
  ok(r2.plan.lenderPaid === 2.5 && r2.source.lenderPaid === 'company', 'A3 the company value wins over the standard');

  const r3 = cp.resolveCompPlan({
    ...base,
    company: { 'comp.lenderPaid': 2.5 },
    user: { 'comp.lenderPaid': 2.25 },
    userStored: new Set(['comp.lenderPaid']),
  });
  ok(r3.plan.lenderPaid === 2.25 && r3.source.lenderPaid === 'yours', 'A4 the person’s own row wins over the company');

  // THE routes/me.js LESSON: a value in the user scope with NO row behind it is our pre-fill,
  // not a choice — reading it would skip the company's figure.
  const r4 = cp.resolveCompPlan({
    ...base,
    company: { 'comp.lenderPaid': 2.5 },
    user: { 'comp.lenderPaid': 2 },       // the declared default, layered by load(), no row
    userStored: new Set(),                 // ← they never chose
  });
  ok(r4.plan.lenderPaid === 2.5 && r4.source.lenderPaid === 'company',
    'A5 a user-scope value with NO stored row states nothing — the company figure governs');

  const r5 = cp.resolveCompPlan({
    ...base,
    user: { 'comp.applicationFee': 5 },
    userStored: new Set(['comp.applicationFee']),
  });
  ok(r5.plan.applicationFee === 1595 && r5.source.applicationFee === 'standard',
    'A6 the fees are COMPANY-ONLY — a personal fee row is never read');

  const r6 = cp.resolveCompPlan({ ...base, company: { 'comp.ysp': 'garbage' } });
  ok(r6.plan.ysp === 0 && r6.source.ysp === 'standard',
    'A7 an unreadable company value falls DOWN the chain, never through it');

  const r7 = cp.resolveCompPlan({
    ...base,
    company: { 'comp.borrowerPaid': -3 },
    user: { 'comp.borrowerPaid': 'x' },
    userStored: new Set(['comp.borrowerPaid']),
  });
  ok(r7.plan.borrowerPaid === 2 && r7.source.borrowerPaid === 'standard',
    'A8 bad at every level still lands on the declared figure');

  const r8 = cp.resolveCompPlan({ defaults: {}, company: {}, user: {}, userStored: new Set() });
  ok(r8.plan.lenderPaid === null && r8.source.lenderPaid === 'missing',
    'A9 even the declared default unreadable → null, marked missing…');
  const { normalizePlan } = await import('../app-v2/src/longterm/compOverlay.js');
  ok(normalizePlan(r8.plan) === null,
    'A10 …and the screen’s normalizer refuses that WHOLE plan — the board falls to raw, never to 0');
}

console.log('\nB. the bounds at the door');
ok(cp.validateCompValue('comp.lenderPaid', 2.25).ok, 'B1 2.25 points is fine');
ok(cp.validateCompValue('comp.lenderPaid', '2.25').ok, 'B2 a numeric string is fine — forms send strings');
ok(!cp.validateCompValue('comp.lenderPaid', 25).ok, 'B3 25 points of comp is refused');
ok(!cp.validateCompValue('comp.ysp', -0.5).ok, 'B4 a negative YSP is refused');
ok(!cp.validateCompValue('comp.applicationFee', 50000).ok, 'B5 a $50,000 application fee is refused');
ok(cp.validateCompValue('comp.applicationFee', 0).ok, 'B6 a zero fee is a real choice and allowed');
ok(!cp.validateCompValue('comp.borrowerPaid', 'abc').ok, 'B7 junk is refused with its name');
ok(String(cp.validateCompValue('comp.borrowerPaid', 9).message || '').includes('comp.borrowerPaid'),
  'B8 the refusal NAMES the key');
ok(cp.validateCompValue('unrelated.key', 'anything').ok, 'B9 a non-comp key is not this module’s business');

console.log('\nC. the two key sets are exactly what the owner described');
ok(JSON.stringify([...cp.PERSONAL_COMP_KEYS].sort())
  === JSON.stringify(['comp.borrowerPaid', 'comp.lenderPaid', 'comp.ysp']),
  'C1 a person may set their own three POINTS figures — never the fees');
ok(JSON.stringify(Object.keys(cp.COMP_BOUNDS).sort())
  === JSON.stringify(['comp.applicationFee', 'comp.borrowerPaid', 'comp.commitmentFee', 'comp.lenderPaid', 'comp.ysp']),
  'C2 all five figures carry bounds');
for (const k of Object.keys(cp.COMP_BOUNDS)) {
  ok(decl.definition(k) !== null, `C3 ${k} is a DECLARED setting — the store will accept it`);
}
ok([...settingsRoute.PERSONAL_KEYS].filter((k) => k.startsWith('comp.')).length === 3
  && settingsRoute.PERSONAL_KEYS.has('comp.lenderPaid')
  && settingsRoute.PERSONAL_KEYS.has('comp.borrowerPaid')
  && settingsRoute.PERSONAL_KEYS.has('comp.ysp')
  && !settingsRoute.PERSONAL_KEYS.has('comp.applicationFee'),
  'C4 the personal settings door offers the three and NOT the fees');
ok(settingsRoute.SUPERADMIN_KEYS.size === 5
  && [...settingsRoute.SUPERADMIN_KEYS].every((k) => k in cp.COMP_BOUNDS),
  'C5 every comp key needs the super admin at the company door');

console.log('\nD. who counts as the super admin');
{
  const superAdmin = access.accessFor({ id: 1, role: 'super_admin' }, {});
  const admin = access.accessFor({ id: 2, role: 'admin' }, {});
  ok(superAdmin.ltRole === 'super_admin', 'D1 a super_admin resolves as super_admin');
  ok(admin.ltRole === 'admin' && admin.ltRole !== 'super_admin',
    'D2 an ordinary admin does NOT — the gate refuses them by role');
}

console.log('\nE. the route sources carry the gates (they cannot be unit-run without a DB)');
{
  const routeSrc = readFileSync(path.join(ROOT, 'src/longterm/routes/settings.js'), 'utf8');
  ok(/superKeys\.length[\s\S]{0,400}ltRole !== 'super_admin'[\s\S]{0,200}status\(403\)/.test(routeSrc),
    'E1 the company PATCH refuses a non-super-admin on a comp key with a 403');
  ok(/RESET IS STILL A CHANGE/.test(routeSrc) && routeSrc.split("!== 'super_admin'").length >= 3,
    'E2 the reset door takes the same gate — putting a default back changes tomorrow’s quotes');
  ok(/compBoundsProblem\(patch\)/.test(routeSrc)
    && routeSrc.split('compBoundsProblem(patch)').length >= 3,
    'E3 the bounds are checked at BOTH doors — company and personal');
  const pricerSrc = readFileSync(path.join(ROOT, 'src/longterm/routes/dscr-pricer.js'), 'utf8');
  ok(/router\.get\('\/comp-plan'/.test(pricerSrc) && /resolveCompPlan\(/.test(pricerSrc),
    'E4 the pricer serves GET /comp-plan through the one resolver');
  ok(/lt_dscr_comp_plan_error/.test(pricerSrc),
    'E5 a failed plan read answers an ERROR — the screen falls to raw, never a guessed plan');
}

console.log('\nF. the screen’s documented default plan mirrors the declared settings');
for (const [name, key] of Object.entries(cp.COMP_KEYS)) {
  ok(Object.is(Number(D[key]), Number(DEFAULT_COMP_PLAN[name])),
    `F1 ${key} declared ${D[key]} === the screen’s documented ${DEFAULT_COMP_PLAN[name]}`);
}

if (bad) { console.error(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall passed');

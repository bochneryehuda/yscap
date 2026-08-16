'use strict';
/**
 * test-trinity-eligibility-pure — the one rule that decides whether Trinity gets an
 * inspection, and the three pipelines it must never touch.
 *
 * PURE: no database, no network. This guards the defect that made the whole
 * Sitewire-submitted door dead code — `intake.maybeOrderFromSitewire` asked for
 * `platform === 'trinity'`, a value `routing.platformOf` cannot produce — so the rule is
 * now asserted against the EXACT shape `routing.resolveFilePlatform` returns, and against
 * the exact values `routing.PLATFORMS` allows.
 */

const assert = require('assert');
const e = require('../src/trinity/eligibility');
const routing = require('../src/sitewire/routing');

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ---------------------------------------------------------------------------
// A. the rule is stated against values routing can ACTUALLY produce
// ---------------------------------------------------------------------------
// This is the assertion that would have caught the original defect. If somebody ever
// adds a 'trinity' platform to the routing chokepoint, this fails loudly and the rule
// gets revisited deliberately rather than by accident.
assert.deepStrictEqual(routing.PLATFORMS, ['sitewire', 'trustpoint', 'external'],
  'the routing chokepoint still answers exactly these three platforms');
n++;
ok(!routing.PLATFORMS.includes('trinity'),
  "A1 'trinity' is NOT a draw platform — it is a decision made FROM the platform + method");
for (const rule of [null, {}, { draw_platform: 'sitewire' }, { draw_platform: 'trustpoint' }, { draw_platform: 'external' }, { handled_externally: true }]) {
  ok(routing.platformOf(rule) !== 'trinity', 'A2 platformOf can never answer "trinity"');
}

// ---------------------------------------------------------------------------
// B. the one case that MUST order
// ---------------------------------------------------------------------------
const PHYSICAL = { platform: 'sitewire', method: 'traditional', resolved: true };
ok(e.isTrinityFile(PHYSICAL), 'B1 a PHYSICAL, non-Blue-Lake file is Trinity’s');
eq(e.reasonNotTrinity(PHYSICAL), null, 'B2 and has no refusal reason');

// ---------------------------------------------------------------------------
// C. the pipelines that must never be touched
// ---------------------------------------------------------------------------
// Owner-directed 2026-08-14: "Don't mess up sitewire integration for any virtuals.
// Don't touch that. Don't touch the trust point integration that we already have for
// Bluelake." These four are that instruction, executable.
ok(!e.isTrinityFile({ ...PHYSICAL, method: 'mobile' }), 'C1 a Sitewire VIRTUAL file is refused — the autopilot stays Sitewire’s');
ok(!e.isTrinityFile({ ...PHYSICAL, platform: 'trustpoint' }), 'C2 a Blue Lake / TrustPoint file is refused');
ok(!e.isTrinityFile({ ...PHYSICAL, platform: 'external' }), 'C3 a partner-run file is refused');
ok(/virtual/i.test(e.reasonNotTrinity({ ...PHYSICAL, method: 'mobile' })), 'C4 the virtual refusal says so in plain words');
ok(/Blue Lake/i.test(e.reasonNotTrinity({ ...PHYSICAL, platform: 'trustpoint' })), 'C5 the Blue Lake refusal names Blue Lake');

// ---------------------------------------------------------------------------
// D. it FAILS CLOSED — ordering spends money and sends a person to an address
// ---------------------------------------------------------------------------
ok(!e.isTrinityFile(null), 'D1 nothing supplied is refused');
ok(!e.isTrinityFile(undefined), 'D2 undefined is refused');
ok(!e.isTrinityFile({}), 'D3 an empty context is refused');
ok(!e.isTrinityFile({ ...PHYSICAL, method: null }), 'D4 an unknown inspection method is refused');
ok(!e.isTrinityFile({ ...PHYSICAL, method: '' }), 'D5 a blank inspection method is refused');
// The important one: resolveFilePlatform returns the SAFE DEFAULT {platform:'sitewire'}
// when it could not look at all, and says so with resolved:false. That must not read as
// a genuine Sitewire physical file.
ok(!e.isTrinityFile({ ...PHYSICAL, resolved: false }), 'D6 an UNRESOLVED file is refused even though it looks eligible');
ok(/could not be resolved/i.test(e.reasonNotTrinity({ ...PHYSICAL, resolved: false })), 'D7 and says the routing could not be read');
// `resolved` is only a refusal when EXPLICITLY false — a caller that already awaited the
// routing may legitimately omit it.
ok(e.isTrinityFile({ platform: 'sitewire', method: 'traditional' }), 'D8 an omitted `resolved` is not treated as a failure');
ok(!e.isTrinityFile({ platform: 'nonsense', method: 'traditional', resolved: true }), 'D9 an unknown platform is refused, never assumed');

// ---------------------------------------------------------------------------
// E. the portal label is a DIFFERENT question and keeps its old answer
// ---------------------------------------------------------------------------
eq(e.portalPlatformFor({ platform: 'trustpoint' }), 'trustpoint', 'E1 a Blue Lake request is labelled trustpoint');
eq(e.portalPlatformFor({ platform: 'sitewire' }), 'trinity', 'E2 every other physical request is labelled trinity');
eq(e.portalPlatformFor({ platform: 'external' }), 'trinity', 'E3 unchanged from the original composer behaviour');
eq(e.portalPlatformFor(null), 'trinity', 'E4 and is total');

// ---------------------------------------------------------------------------
// F. THE CALL SITE — a correct rule fed the wrong context is still a dead door
// ---------------------------------------------------------------------------
// The original defect was fixed in the RULE on 2026-08-14, and the door stayed dead
// anyway: `reconcile.js` passed only `platform`, so `method` arrived undefined, rule 1
// read "not physical", and every draw ever submitted through Sitewire was refused — in
// silence, because the call is fire-and-forget and its refusal is a return value nobody
// reads. That is not something the rule's own unit tests can see, so it is asserted on
// the SOURCE of the caller. If the hook is ever rewritten, this fails and the three
// questions the rule asks have to be answered deliberately.
const fs = require('fs');
const path = require('path');
const reconcileSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'sitewire', 'reconcile.js'), 'utf8');
const hook = reconcileSrc.slice(reconcileSrc.indexOf('maybeOrderFromSitewire'));
const hookCall = hook.slice(0, hook.indexOf('}'));
ok(/platform:\s*ctx\.platform/.test(hookCall), 'F1 the reconcile hook passes the resolved PLATFORM');
ok(/method:\s*ctx\.method/.test(hookCall), 'F2 …and the resolved inspection METHOD — without it the rule can only ever answer no');
ok(/resolved:\s*ctx\.resolved/.test(hookCall), 'F3 …and whether the routing was resolved at all, so it can fail closed');
// The fallback context a caller that supplied nothing gets must itself be a refusal.
ok(/fileCtx \|\| \{[^}]*resolved:\s*false/.test(reconcileSrc),
  'F4 the no-context fallback is marked unresolved, so an omission can never order an inspection');
// And the rule the caller feeds must agree: exactly this shape is what orders.
ok(e.isTrinityFile({ platform: 'sitewire', method: 'traditional', resolved: true }),
  'F5 the shape the fixed call site produces on a physical file DOES order');
ok(!e.isTrinityFile({ platform: 'sitewire', method: undefined, resolved: undefined }),
  'F6 the shape the BROKEN call site produced does NOT — this is the bug, pinned');

console.log(`test-trinity-eligibility-pure: ${n} assertions passed`);

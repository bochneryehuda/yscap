/* THE DRAW CENTER'S INTAKE SURFACES ARE LEFT-RAIL SECTIONS, NOT A STACK ON TOP
 * (owner-directed 2026-08-26: "Trinity Manual Physical Inspections … should be made a
 * section on the left side — Trinity orders"; the portal draw requests and the
 * composed/administered draw requests likewise came off the top).
 *
 * A pure source guard — no DB, no browser — because a green Vite build proves nothing
 * about STRUCTURE: the cards would render fine wherever they sit. What must stay true:
 *   1. on the LINKED desk no intake card renders above the section rail any more;
 *   2. each card lives inside its own rail section (Trinity always — the 2026-08-21
 *      rule that the Trinity card is on EVERY file — the other two presence-gated);
 *   3. the rail lists 'Trinity orders' unconditionally and the other two only when
 *      the card itself reported it applies (present.portal / present.tp);
 *   4. CardSection keeps an absent card MOUNTED (display:none) — Section's `hidden`
 *      unmounts children, and an unmounted card can never fetch, so presence would
 *      deadlock and the section could never appear.
 * Run: node scripts/test-draw-center-sections-pure.js
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/components/DrawsPanel.jsx'), 'utf8');
// Structure is asserted on the COMMENT-STRIPPED source — the change necessarily
// explains itself in comments that NAME the old shape.
const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
const count = (hay, re) => (hay.match(re) || []).length;

// The linked desk = everything from the <FileSections opening to its close.
const fsStart = code.indexOf('<FileSections sections={drawSections}>');
const fsEnd = code.indexOf('</FileSections>');
ok(fsStart > -1 && fsEnd > fsStart, '0 the section rail is still there');
const rail = code.slice(fsStart, fsEnd);
// The linked branch's PRE-RAIL region: from the branch split `) : (` nearest before
// <FileSections up to <FileSections — where the three cards used to sit "massive on top".
const branchAt = code.lastIndexOf(') : (', fsStart);
const preRail = code.slice(branchAt, fsStart);

ok(!/TrinityInspectionCard|PortalDrawsCard|TrustpointPanel/.test(preRail),
  '1 NO intake card renders above the rail on the linked desk any more');

ok(/<Section id="dsec-trinity" title="Trinity orders"[\s\S]{0,200}?<TrinityInspectionCard appId=\{appId\} \/>/.test(rail),
  '2a Trinity orders is its OWN section — and an unconditional one (on every file, 2026-08-21)');
ok(/<CardSection id="dsec-portal-requests"[^>]*present=\{present\.portal\}>[\s\S]{0,200}?<PortalDrawsCard appId=\{appId\} onPresence=\{onPortalPresence\} \/>/.test(rail),
  '2b Portal draw requests is a presence-gated section, the card reporting its own presence');
ok(/<CardSection id="dsec-trustpoint"[^>]*present=\{present\.tp\}>[\s\S]{0,200}?<TrustpointPanel appId=\{appId\} onPresence=\{onTpPresence\} \/>/.test(rail),
  '2c TrustPoint administered draws likewise');

// The rail's own list: Trinity always, the other two only when really there.
ok(/\{ id: 'dsec-trinity', label: 'Trinity orders', group: 'Draw' \},/.test(code),
  "3a the rail lists 'Trinity orders' unconditionally");
ok(/\.\.\.\(present\.portal === true \? \[\{ id: 'dsec-portal-requests'/.test(code)
  && /\.\.\.\(present\.tp === true \? \[\{ id: 'dsec-trustpoint'/.test(code),
  '3b …and the other two only when the card reported presence (=== true, never truthy-null)');

// CardSection keeps an absent card mounted — the presence deadlock guard.
const cs = code.slice(code.indexOf('function CardSection'), code.indexOf('export default function DrawsPanel'));
ok(/present !== true/.test(cs) && /display: 'none'/.test(cs) && /\{children\}/.test(cs) && /defaultOpen=\{false\}/.test(cs),
  '4 CardSection keeps the card MOUNTED while absent (display:none), and opens collapsed when present');

// Each card renders exactly TWICE — the pre-link setup screen (bottom of it) + its
// rail section. A third occurrence means somebody put a copy back on top.
for (const name of ['TrinityInspectionCard appId', 'PortalDrawsCard appId', 'TrustpointPanel appId']) {
  ok(count(code, new RegExp('<' + name.split(' ')[0] + ' appId=\\{appId\\}', 'g')) === 2,
    `5 ${name.split(' ')[0]} renders exactly twice (setup screen + its section)`);
}

// Both cards feed presence through a REF so the fetch effect never re-runs on a parent
// re-render (an inline callback in `load`'s deps would re-fetch in a loop).
ok(count(code, /presRef\.current = onPresence/g) === 2,
  '6 both presence reporters go through a ref, never a load() dependency');

console.log(`\ndraw-center-sections: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

'use strict';
/**
 * LONG-TERM — one stray comma in Encompass must not cost a file its address
 * (owner-reported 2026-08-25, YSCAP258134860, 159 Fillmore St, New Haven CT).
 *
 * THE REPORT: "the subject property address was not carried over to ClickUp ...
 * I need to enter it manually. It was not carried over directly from Encompass."
 *
 * WHAT IT WAS. Encompass held the street as `159 Fillmore St,, 06513` — somebody
 * typed the ZIP onto the street line. PILOT mirrored that faithfully, which is
 * correct; Encompass is the source of truth and nothing here edits it. But the
 * single line built from it did not geocode, `geoFor` returned null, the field's
 * `src` returned null, and the address was NOT WRITTEN — with no error, no review
 * row, and nothing anywhere recording that it had been dropped. Measured live,
 * with a clean control either side: the messy form returns null; `159 Fillmore
 * St` resolves instantly. The address was never the problem. The single attempt
 * was.
 *
 * WHY THIS SUITE IS PURE. `geoFor` reaches a geocoding provider, so it cannot be
 * asserted on in CI without making the test a network monitor. The FIX, though,
 * is entirely in which lines we are willing to try — and that is pure, total, and
 * exactly what a regression would break. So the ladder is tested here, and the
 * live end of it was measured by hand before shipping (recorded in the commit).
 *
 * THE INVARIANT THAT MATTERS MOST is not "the messy case works" — it is that
 * candidate 1 is ALWAYS the line built today. That is what makes this change
 * incapable of breaking an address that already worked: every existing success
 * resolves on the first attempt exactly as before, and the ladder can only ever
 * add outcomes where there were none.
 */

const push = require('../src/longterm/clickup/push');
const { geoCandidates } = push._internals;

let pass = 0;
const fails = [];
function ok(cond, what) {
  if (cond) { pass++; console.log(`  ok   ${what}`); return; }
  fails.push(what);
  console.error(`  ✗ ${what}`);
}
const eq = (got, want, what) => ok(got === want,
  got === want ? what : `${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

// The line the code has always built, spelled out here independently so a change
// to it has to be deliberate rather than absorbed.
const todaysLine = (p) => [p.street, p.city, [p.state, p.zip].filter(Boolean).join(' ')]
  .map((x) => String(x || '').trim()).filter(Boolean).join(', ');

console.log('\nA. THE REPORTED FILE — 159 Fillmore St,, 06513');
{
  const parts = { street: '159 Fillmore St,, 06513', city: 'New Haven', state: 'CT', zip: '06513' };
  const c = geoCandidates(parts);
  eq(c[0], todaysLine(parts), 'candidate 1 is EXACTLY the line built today — an address that works is untouched');
  ok(c.includes('159 Fillmore St, New Haven, CT 06513'),
    'and the ladder reaches the form that actually resolves (measured live: this one geocodes, the raw one does not)');
  ok(c.every((l) => /^159 Fillmore St/.test(l)), 'every candidate is the SAME address — the house number and street never change');
  ok(c.every((l) => /New Haven/.test(l) && /CT/.test(l) && /06513/.test(l)),
    'and city, state and ZIP come from the mirror on every one — nothing is invented');
}

console.log('\nB. an address that already works is not disturbed');
{
  const parts = { street: '159 Fillmore St', city: 'New Haven', state: 'CT', zip: '06513' };
  const c = geoCandidates(parts);
  eq(c[0], '159 Fillmore St, New Haven, CT 06513', 'the clean line is candidate 1');
  eq(c.length, 1, 'and there is nothing else to try — a clean address makes exactly one request, as before');
}

console.log('\nC. only the STREET is tidied — never the parts we hold separately');
{
  // A ZIP that appears in the street is dropped ONLY because we already hold it
  // in its own column. A house number that happens to look like a ZIP must not be.
  const c = geoCandidates({ street: '06513 Fillmore St', city: 'New Haven', state: 'CT', zip: '06513' });
  ok(c.every((l) => /^06513 Fillmore St/.test(l)),
    'a five-digit HOUSE NUMBER matching the ZIP is never stripped — only a trailing repeat is');

  const d = geoCandidates({ street: '159 Fillmore St', city: '', state: 'CT', zip: '06513' });
  eq(d[0], '159 Fillmore St, CT 06513', 'a missing city is simply absent — no empty comma is manufactured');

  const e = geoCandidates({ street: '159 Fillmore St, Apt 2', city: 'New Haven', state: 'CT', zip: '06513' });
  eq(e[0], '159 Fillmore St, Apt 2, New Haven, CT 06513', 'a unit is kept on the first try');
  ok(e.some((l) => l.startsWith('159 Fillmore St, New Haven')),
    'and dropping to the building is only ever the LAST resort, after the full address failed');
}

console.log('\nD. the degenerate inputs');
{
  eq(geoCandidates({ street: '', city: 'New Haven', state: 'CT', zip: '06513' }).length, 0,
    'no street means no candidates — PILOT does not geocode a bare city');
  eq(geoCandidates({}).length, 0, 'an empty bag is empty, not a crash');
  eq(geoCandidates().length, 0, 'and no argument at all is empty too');
  const dup = geoCandidates({ street: '159 Fillmore St,', city: 'New Haven', state: 'CT', zip: '06513' });
  eq(dup.length, 2, 'a trailing comma collapses to one extra form, not four copies of the same line');
  ok(new Set(dup).size === dup.length, 'and no candidate is ever requested twice');
}

console.log('\nE. messier real shapes still reduce to the right address');
{
  const c = geoCandidates({ street: '12 Main St ,,  ', city: 'Newark', state: 'NJ', zip: '07102' });
  ok(c.some((l) => l === '12 Main St, Newark, NJ 07102'), 'stray commas and doubled spaces reduce to the clean line');
  const d = geoCandidates({ street: '9 Oak Ave, 07102-1234', city: 'Newark', state: 'NJ', zip: '07102' });
  ok(d.some((l) => l === '9 Oak Ave, Newark, NJ 07102'), 'a ZIP+4 typed onto the street is recognised as the ZIP we already hold');
}

if (fails.length) {
  console.error(`\n${fails.length} failed:`);
  for (const f of fails) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`\nall good — ${pass} checks`);

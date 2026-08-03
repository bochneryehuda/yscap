/**
 * A GEOCODER ANSWERS A DIFFERENT HOUSE RATHER THAN SAY IT CANNOT FIND YOURS.
 *
 * Verified live against the Census geocoder: asking for "26 S 10th St,
 * Piscataway, NJ 08854" returns "26 10TH ST, PISCATAWAY, NJ, 08854" — the
 * directional dropped, `precision: 'address'`, and the IDENTICAL coordinate it
 * returns for "26 10th St", which is a different street. Google normalises the
 * same address to a Plainfield ZIP: a rooftop-precise match on a house ~130 m
 * away, across a municipal line where the numbering runs on.
 *
 * Every provider in `research/geocode.js` already RETURNED its matched string.
 * Nothing read it, so the coordinates were adopted regardless — and a confident
 * wrong pin is worse than no pin, because every distance measured from it is
 * wrong without looking wrong.
 *
 * `address.geocodeRewriteIsSafe` was written after exactly that incident. This
 * pins that the research sweep now consults it. Pure — providers are stubbed, no
 * network, no database.
 *
 * Run: node scripts/test-research-geocode-guard-pure.js
 */
const G = require('../src/lib/research/geocode');
const ADDR = require('../src/lib/address');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const SUBJECT = { street: '26 S 10th St', city: 'Piscataway', state: 'NJ', zip: '08854' };
const stub = (matched, extra = {}) => async () => Object.assign(
  { lat: 40.55, lng: -74.46, source: 'census', precision: 'address', matched }, extra);

(async () => {
  // ── the guard itself, on the real strings from the incident ────────────────
  for (const [ours, theirs, why, safe] of [
    ['26 S 10th St, Piscataway, NJ 08854', '26 10TH ST, PISCATAWAY, NJ, 08854', 'the directional dropped — a different street', false],
    ['1727 S 2nd St, Piscataway, NJ 08854', '1727 S 2nd St, Plainfield, NJ 07063', 'a rooftop match on a house across the municipal line', false],
    ['12 Oak St, Newark, NJ 07103', '14 Oak St, Newark, NJ 07103', 'the house number moved', false],
    ['26 South 10th Street, Brooklyn, NY 11249', '26 S 10th St, Brooklyn, NY 11249', 'the SAME address, merely restyled', true],
    ['26 S 10th St, Brooklyn, NY', '26 S 10th St, Brooklyn, NY 11249', 'a ZIP we never had, filled in', true],
  ]) {
    ok(ADDR.geocodeRewriteIsSafe(ours, theirs) === safe,
      `${safe ? 'accepted' : 'refused'}: ${why}`);
  }

  // ── and the sweep actually consults it ─────────────────────────────────────
  const wrong = await G.geocodeProperty(SUBJECT, { providers: [stub('26 10TH ST, PISCATAWAY, NJ, 08854')] });
  ok(wrong.ok === false, 'a match that changed the street is NOT placed');
  ok(wrong.rejected === true, 'and it is marked as a rejection, not as "nothing found"');
  ok(/different property/.test(wrong.why || ''),
    'with a reason that says the service offered a different property');
  ok(/26 10TH ST/.test(wrong.why || ''),
    'and quotes what it offered, so a human can see the near-miss');

  const right = await G.geocodeProperty(SUBJECT, { providers: [stub('26 S 10TH ST, PISCATAWAY, NJ, 08854')] });
  ok(right.ok === true && right.lat === 40.55, 'the same address restyled IS placed');

  // A SECOND PROVIDER STILL GETS ITS TURN. Refusing one service's near-miss must
  // not skip the next one — that would trade a wrong pin for a missing pin.
  const second = await G.geocodeProperty(SUBJECT, {
    providers: [stub('26 10TH ST, PISCATAWAY, NJ, 08854'),
      stub('26 S 10TH ST, PISCATAWAY, NJ, 08854', { source: 'osm' })],
  });
  ok(second.ok === true && second.source === 'osm',
    'a refused first answer falls through to the next service rather than giving up');

  // A provider that returns no matched string at all is trusted as before — the
  // guard can only judge what it is shown, and refusing on absence would place
  // nothing at all.
  const silent = await G.geocodeProperty(SUBJECT, { providers: [stub(null)] });
  ok(silent.ok === true, 'a service that states no matched address is not refused for staying silent');

  // Nothing at all is still "nothing found", not a rejection.
  const none = await G.geocodeProperty(SUBJECT, { providers: [async () => null] });
  ok(none.ok === false && !none.rejected, 'no answer at all is reported as no answer, not as a wrong property');

  console.log(failures ? `\ntest-research-geocode-guard-pure: ${failures} FAILED`
    : '\ntest-research-geocode-guard-pure: all passed');
  process.exit(failures ? 1 : 0);
})();

'use strict';
/**
 * Address FORMATTING — the mailing one-line PILOT shows and ClickUp stores.
 *
 *   node scripts/test-address-format.js                    (pure)
 *   DATABASE_URL=postgres://… node scripts/test-address-format.js   (+ the repair)
 *
 * Owner-reported 2026-07-26: subject/home addresses turned into the raw
 * OpenStreetMap display name instead of the ClickUp form. Proves:
 *   1. The owner's two exact examples compact to the exact ClickUp strings.
 *   2. An address ALREADY in mailing form is returned byte-for-byte unchanged
 *      (no re-shortening, no blanking) — the pass is safe to run on everything.
 *   3. A record whose components the long form poisoned (city = "Kings County",
 *      a street carrying commas) is repaired, and a clean record reports "no
 *      change" so nothing is rewritten needlessly.
 *   4. The ClickUp INBOUND parser compacts a long value sitting in the location
 *      field instead of storing the county as the city.
 *   5. Street abbreviation never mangles a street that has no name of its own
 *      ("26 West Street" stays "26 West St") or an unknown suffix.
 *   6. DB: the repair pass rewrites previous files and is idempotent.
 */
const R = require('path').resolve(__dirname, '..');
const ADDR = require(R + '/src/lib/address');
const mapper = require(R + '/src/clickup/mapper');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m}\n     expected: ${JSON.stringify(b)}\n     actual:   ${JSON.stringify(a)}`);

// ── 1. the owner's two examples ────────────────────────────────────────────
const LONG_BK = '26, South 10th Street, Williamsburg, Brooklyn, Kings County, New York, 11249, United States';
const LONG_NJ = '103, Newport Avenue, South Lakewood, Lakewood Township, Ocean County, New Jersey, 08701, United States';
eq(ADDR.compactFormattedAddress(LONG_BK), '26 S 10th St, Brooklyn, NY 11249', 'Brooklyn long form -> the mailing one-line');
eq(ADDR.compactFormattedAddress(LONG_NJ), '103 Newport Ave, Lakewood, NJ 08701', 'Lakewood long form -> the mailing one-line');
ok(ADDR.looksLikeProviderLongForm(LONG_BK) && ADDR.looksLikeProviderLongForm(LONG_NJ), 'both are detected as provider long forms');

// ── 2. an address already in mailing form is untouched ─────────────────────
for (const good of [
  '26 S 10th St, Brooklyn, NY 11249',
  '103 Newport Ave, Lakewood, NJ 08701',
  '117 Brook Ave, Passaic, NJ 07055',
  '12 Churchill Lane, Monsey, NY 10952',
]) {
  eq(ADDR.compactFormattedAddress(good), good, 'mailing form untouched: ' + good);
  ok(!ADDR.looksLikeProviderLongForm(good), 'not flagged as a long form: ' + good);
}
eq(ADDR.compactFormattedAddress(''), '', 'empty stays empty');
eq(ADDR.compactFormattedAddress(null), '', 'null -> empty string, never a crash');

// ── 3. repairing a stored record ───────────────────────────────────────────
const poisoned = {
  line1: '26, South 10th Street, Williamsburg, Brooklyn', city: 'Kings County',
  state: 'New York', zip: '11249', formatted_address: LONG_BK, oneLine: LONG_BK,
  lat: 40.714, lng: -73.963,
};
const fixed = ADDR.canonicalizeAddressValue(poisoned);
ok(!!fixed, 'a poisoned record is repaired');
eq(fixed.formatted_address, '26 S 10th St, Brooklyn, NY 11249', 'formatted_address is the mailing one-line — no country');
eq(fixed.oneLine, '26 S 10th St, Brooklyn, NY 11249', 'oneLine is the same address without the country');
eq(fixed.city, 'Brooklyn', 'the county stored as the city is corrected to the borough');
eq(fixed.state, 'NY', 'the spelled-out state is 2-lettered');
ok(!String(fixed.line1).includes(','), 'the street no longer carries the neighbourhood/borough');
eq(fixed.lat, 40.714, 'coordinates are preserved');

ok(ADDR.canonicalizeAddressValue({
  line1: '26 S 10th St', city: 'Brooklyn', state: 'NY', zip: '11249',
  formatted_address: '26 S 10th St, Brooklyn, NY 11249', oneLine: '26 S 10th St, Brooklyn, NY 11249',
}) === null, 'a clean record reports NO change (nothing is rewritten needlessly)');
ok(ADDR.canonicalizeAddressValue(null) === null && ADDR.canonicalizeAddressValue({}) === null,
  'empty / missing address is a no-op');
eq(ADDR.canonicalizeAddressValue(LONG_NJ), '103 Newport Ave, Lakewood, NJ 08701',
  'a legacy bare-STRING address is repaired too');

// re-running the repair on the repaired value must be a no-op (idempotent)
ok(ADDR.canonicalizeAddressValue(fixed) === null, 'the repair is idempotent');

// ── 4. the ClickUp inbound parser ──────────────────────────────────────────
const inbound = mapper.normalizeClickupLocation({ location: { lat: 40.714, lng: -73.963 }, formatted_address: LONG_BK });
eq(inbound.formatted_address, '26 S 10th St, Brooklyn, NY 11249', 'inbound ClickUp location is compacted');
eq(inbound.city, 'Brooklyn', 'inbound city is the borough, NOT "Kings County"');
eq(inbound.state, 'NY', 'inbound state is 2-lettered');
eq(inbound.zip, '11249', 'inbound zip survives');
const inboundGood = mapper.normalizeClickupLocation({ location: { lat: 1, lng: 2 }, formatted_address: '117 Brook Ave, Passaic, NJ 07055, USA' });
eq(inboundGood.formatted_address, '117 Brook Ave, Passaic, NJ 07055, USA', 'a ClickUp value already in mailing form is imported unchanged');

// ── 5. street / city normalization edges ───────────────────────────────────
eq(ADDR.abbreviateStreet('26 South 10th Street'), '26 S 10th St', 'directional + suffix abbreviated');
eq(ADDR.abbreviateStreet('26 West Street'), '26 West St', 'a street NAMED West keeps its name');
eq(ADDR.abbreviateStreet('117 Brook Ave NW'), '117 Brook Ave NW', 'a trailing directional is kept');
eq(ADDR.abbreviateStreet('12 Churchill Lane'), '12 Churchill Ln', 'Lane -> Ln');
eq(ADDR.abbreviateStreet('5 Grand Concourse'), '5 Grand Concourse', 'an unknown suffix is left exactly as written');
eq(ADDR.abbreviateStreet(''), '', 'empty street stays empty');
eq(ADDR.normalizeCityName('Lakewood Township'), 'Lakewood', 'Township is dropped from the mailing city');
eq(ADDR.normalizeCityName('Village of Spring Valley'), 'Spring Valley', '"Village of" is dropped');
eq(ADDR.normalizeCityName('Brooklyn'), 'Brooklyn', 'an ordinary city is untouched');
eq(ADDR.normalizeCityName('Township'), 'Township', 'a city we would blank is kept as written');
// NYC borough rule (shared with the autocomplete route)
eq(ADDR.preferBorough('New York', 'Brooklyn'), 'Brooklyn', 'a borough beats the "New York" municipality');
eq(ADDR.preferBorough('New York', 'Manhattan'), 'New York', 'Manhattan really does mail as New York');
eq(ADDR.preferBorough('Lakewood', 'South Lakewood'), 'Lakewood', 'no ordinary city is affected');
// the OSM component mapping the geocoder + autocomplete share
const comp = ADDR.osmComponentsToAddress({
  house_number: '26', road: 'South 10th Street', suburb: 'Williamsburg', borough: 'Brooklyn',
  city: 'New York', county: 'Kings County', state: 'New York', postcode: '11249', country_code: 'us',
});
eq(ADDR.canonicalOneLine(comp), '26 S 10th St, Brooklyn, NY 11249',
  'OSM components -> the mailing one-line (this is what the geocoder now stores)');
eq(ADDR.canonicalOneLine(comp, { country: true }), '26 S 10th St, Brooklyn, NY 11249',
  'the country is NEVER appended, even when a caller asks (owner-directed 2026-07-26 evening)');

(async () => {
  // ── 6. DB: previous files are repaired ───────────────────────────────────
  if (process.env.DATABASE_URL) {
    const db = require(R + '/src/db');
    const heal = require(R + '/src/lib/address-heal');
    try {
      const b = (await db.query(
        `INSERT INTO borrowers(first_name,last_name,email,current_address)
         VALUES('Addr','Heal',$1,$2::jsonb) RETURNING id`,
        ['addrheal' + Math.random() + '@e.com', JSON.stringify(poisoned)])).rows[0].id;
      const a = (await db.query(
        `INSERT INTO applications(borrower_id, property_address) VALUES($1,$2::jsonb) RETURNING id`,
        [b, JSON.stringify({
          line1: '103, Newport Avenue, South Lakewood', city: 'Ocean County', state: 'New Jersey',
          zip: '08701', formatted_address: LONG_NJ, oneLine: LONG_NJ, lat: 40.09, lng: -74.21,
        })])).rows[0].id;

      const r1 = await heal.healProviderLongAddressesOnce({ limit: 500 });
      ok(r1.fixed >= 2, 'the repair pass rewrote the seeded rows (' + JSON.stringify(r1.byColumn) + ')');

      const app = (await db.query(`SELECT property_address AS x FROM applications WHERE id=$1`, [a])).rows[0].x;
      eq(app.formatted_address, '103 Newport Ave, Lakewood, NJ 08701', 'the file address is the mailing one-line');
      eq(app.city, 'Lakewood', 'the county stored as the city is corrected');
      eq(Number(app.lat), 40.09, 'coordinates survive the repair');
      const bor = (await db.query(`SELECT current_address AS x FROM borrowers WHERE id=$1`, [b])).rows[0].x;
      eq(bor.formatted_address, '26 S 10th St, Brooklyn, NY 11249', 'the home address is the mailing one-line');

      const r2 = await heal.healProviderLongAddressesOnce({ limit: 500 });
      const again = (r2.byColumn['applications.property_address'] || 0) + (r2.byColumn['borrowers.current_address'] || 0);
      ok(again === 0, 'a second pass rewrites nothing (idempotent) — got ' + again);

      // ── 7. the SQL twin of the state comparison (db/326) ─────────────────
      // The repair rewrites a spelled-out state to its code; the reopen trigger
      // must read that as the SAME state, or every repaired file would demand a
      // pointless re-register.
      for (const s of ['New York', 'NY', 'ny', ' new  york ', 'New Jersey', 'NJ', 'Puerto Rico', 'PR',
        'District of Columbia', 'DC', 'Ontario', 'XX', '', null]) {
        const sql = (await db.query(`SELECT pilot_state_norm($1) AS k`, [s])).rows[0].k;
        const js = ADDR.stateCompareKey(s);
        eq(js, sql, `pilot_state_norm vs stateCompareKey agree on ${JSON.stringify(s)}`);
      }
      // and the trigger itself: re-spelling the state is not a re-price.
      // Re-apply db/326 first so the assertion is order-independent — another
      // DB test in the suite re-applies db/322 (the PREVIOUS body of the same
      // trigger function) mid-run. On boot the migrations apply in number order,
      // so 326 is always the live body in production.
      await db.query(require('fs').readFileSync(R + '/db/326_state_semantic_compare.sql', 'utf8'));
      await db.query(
        `INSERT INTO product_registrations(application_id, program, status, total_loan, inputs, quote, is_current)
         VALUES($1,'standard','ELIGIBLE',500000,'{}','{}',true)`, [a]);
      await db.query(`UPDATE applications SET property_address = jsonb_set(property_address,'{state}','"New Jersey"') WHERE id=$1`, [a]);
      await db.query(`UPDATE product_registrations SET stale=false, stale_reason=NULL WHERE application_id=$1`, [a]);
      await db.query(`UPDATE applications SET property_address = jsonb_set(property_address,'{state}','"NJ"') WHERE id=$1`, [a]);
      let st = (await db.query(`SELECT stale FROM product_registrations WHERE application_id=$1`, [a])).rows[0];
      ok(st && st.stale === false, '"New Jersey" -> "NJ" does NOT flag the registration stale');
      await db.query(`UPDATE applications SET property_address = jsonb_set(property_address,'{state}','"NY"') WHERE id=$1`, [a]);
      st = (await db.query(`SELECT stale FROM product_registrations WHERE application_id=$1`, [a])).rows[0];
      ok(st && st.stale === true, 'a REAL state change (NJ -> NY) still flags it stale');

      await db.query(`DELETE FROM product_registrations WHERE application_id=$1`, [a]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [a]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [b]);
    } catch (e) {
      fail++; console.log('  FAIL: DB repair test threw:', e.message);
    }
    try { await db.pool.end(); } catch (_) {}
  } else {
    console.log('  ~~ SKIP address repair DB test (no DATABASE_URL)');
  }

  console.log(`address formatting: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

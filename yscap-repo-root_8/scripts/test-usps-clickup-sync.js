'use strict';
/**
 * USPS ↔ ClickUp address sync — send the GOOGLE form, keep the USPS one surviving
 * (owner-directed 2026-08-11: "when we import USPS ... just update them with the
 * Google address ... The USPS-verified address should always survive ... understand
 * that it's the same address").
 *
 *   node scripts/test-usps-clickup-sync.js                         (pure)
 *   DATABASE_URL=postgres://… node scripts/test-usps-clickup-sync.js  (+ the stamp trigger)
 *
 * The two halves are meaningless apart and are proven together:
 *   A. OUTBOUND — orchestrator.withCoords({preferProvider}) sends ClickUp the Google
 *      spelling of a USPS-verified address (so its Google-backed location picker can
 *      match it), but ONLY the same property: a same-city ZIP difference is adopted,
 *      the Piscataway/Plainfield different-building trap is refused, and WITHOUT
 *      preferProvider (the borrower-home path) the USPS text is kept.
 *   B. DECISION — ingest.inboundAddressDecision is the ONE inbound rule: the Google
 *      echo of the same building keeps ours; a genuinely different place overwrites.
 *   C. INBOUND (DB) — on a USPS-imported file the same-city-ZIP-diff echo does NOT
 *      wipe the verification stamp (usps_imported_at, which title/insurance/closing
 *      gate on), a genuinely different place DOES (re-verify), and the db/415 trigger
 *      alone would wipe the same-city echo too — so the inbound guard is the sole
 *      protection for it (Scenario C baseline).
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const R = require('path').resolve(__dirname, '..');
const ADDR = require(R + '/src/lib/address');
const ingest = require(R + '/src/clickup/ingest');
const orchestrator = require(R + '/src/clickup/orchestrator');
const addressCanon = require(R + '/src/lib/address-canon');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ── A. OUTBOUND — withCoords prefers Google only for the same property ─────────
// Stub the geocoder so no key/network is needed; `withCoords` reads g.geocode(line)
// off the shared address-canon module object, so a property mutation is visible.
let stubHit = null;
addressCanon.geocode = async () => stubHit;

const uspsAddr = () => ({
  line1: '1727 S 2nd St', city: 'Piscataway', state: 'NJ', zip: '08854',
  oneLine: '1727 S 2nd St, Piscataway, NJ 08854',
});
const zipOf = (s) => (String(s || '').match(/\b(\d{5})\b/) || [])[1] || '';

(async () => {
  // 1. USPS-verified subject + same-city ZIP diff + preferProvider → adopt Google's ZIP.
  stubHit = { lat: 40.55, lng: -74.42, formatted: '1727 S 2nd St, Piscataway, NJ 07063', place_id: 'g1', precision: 'rooftop' };
  let out = await orchestrator.withCoords(uspsAddr(), { preferProvider: true });
  ok(zipOf(out.formatted_address) === '07063',
    `preferProvider adopts Google's same-city form (got ZIP ${zipOf(out.formatted_address)}, want 07063)`);
  ok(out.lat != null && out.lng != null, 'the Google coordinates are attached either way');

  // 2. SAME geocode, but NO preferProvider (the borrower-home path) → keep the USPS ZIP.
  out = await orchestrator.withCoords(uspsAddr(), { preferProvider: false });
  ok(zipOf(out.formatted_address) === '08854',
    `without preferProvider the USPS ZIP is kept (got ${zipOf(out.formatted_address)}, want 08854)`);
  // and with no opts at all (the current_address call site) — identical.
  out = await orchestrator.withCoords(uspsAddr());
  ok(zipOf(out.formatted_address) === '08854', 'no opts = keep USPS (the borrower-home call site)');

  // 3. preferProvider but Google drifted ACROSS a city line (the trap) → keep USPS.
  stubHit = { lat: 40.61, lng: -74.41, formatted: '1727 S 2nd St, Plainfield, NJ 07063', place_id: 'g2', precision: 'rooftop' };
  out = await orchestrator.withCoords(uspsAddr(), { preferProvider: true });
  ok(zipOf(out.formatted_address) === '08854' && /Piscataway/i.test(out.formatted_address),
    'a different-city geocode is REFUSED even with preferProvider (Piscataway/Plainfield trap blocked)');

  // 4. an unresolvable address is returned unchanged (never a bad/clearing write).
  stubHit = null;
  const untouched = uspsAddr();
  out = await orchestrator.withCoords(untouched, { preferProvider: true });
  ok(out === untouched, 'an unresolvable address is returned unchanged');

  // ── B. DECISION — the ONE inbound rule ──────────────────────────────────────
  const decide = (o, t, usps) => ingest.inboundAddressDecision({ oursText: o, theirsText: t, uspsImported: usps });
  ok(decide('1727 S 2nd St, Piscataway, NJ 08854', '1727 S 2nd St, Piscataway, NJ 07063', true) === 'same_property',
    'USPS file + same-city ZIP diff → same_property (keep USPS)');
  ok(decide('1727 S 2nd St, Piscataway, NJ 08854', '1727 S 2nd St, Piscataway, NJ 07063', false) === 'overwrite',
    'NON-USPS file + same-city ZIP diff → overwrite (sameProperty is USPS-gated only)');
  ok(decide('5701 15th Ave, Brooklyn, NY 11219', '5701 15th Ave, Brooklyn, NY 11219, USA', true) === 'same_address',
    'an exact re-spelling is same_address (caught before the USPS branch)');
  ok(decide('1727 S 2nd St, Piscataway, NJ 08854', '1727 S 2nd St, Plainfield, NJ 07063', true) === 'overwrite',
    'USPS file + different-city jump → overwrite (re-verify the new property)');
  ok(decide('312 Main St, Newark, NJ 07102', '', true) === 'no_house',
    'inbound with no house number → no_house (keep ours, re-push)');
  ok(decide('755 Bedford Ave, Brooklyn, NY 11206', '702 Bedford Ave, Brooklyn, NY 11206', true) === 'overwrite',
    'a genuinely different house on a USPS file → overwrite');
  // never throws on hostile input
  for (const v of [null, undefined, {}, 0]) {
    let threw = false;
    try { decide(v, v, true); } catch (_) { threw = true; }
    ok(!threw, 'inboundAddressDecision never throws: ' + JSON.stringify(v));
  }

  // ── C. INBOUND (DB) — the stamp survives the echo, not the different place ────
  if (process.env.DATABASE_URL) {
    const db = require(R + '/src/db');
    const _addrOf = (v) => (v && (v.formatted_address || v.oneLine)) || null;
    let bId;
    try {
      bId = (await db.query(
        `INSERT INTO borrowers(first_name,last_name,email) VALUES('Usps','Sync',$1) RETURNING id`,
        ['uspssync' + Math.random() + '@e.com'])).rows[0].id;

      // A file whose subject property is a USPS-imported, human-adopted address.
      const mkUspsApp = async () => {
        const addr = uspsAddr();
        return (await db.query(
          `INSERT INTO applications
             (borrower_id, status, property_address, usps_address, usps_match, usps_dpv, usps_verified_at, usps_imported_at)
           VALUES ($1,'processing',$2::jsonb,$2::jsonb,'verified','{}'::jsonb, now(), now()) RETURNING id`,
          [bId, JSON.stringify(addr)])).rows[0].id;
      };
      const stampLive = async (id) => !!(await db.query(
        `SELECT usps_imported_at FROM applications WHERE id=$1`, [id])).rows[0].usps_imported_at;
      const zipStored = async (id) => zipOf(JSON.stringify(
        (await db.query(`SELECT property_address FROM applications WHERE id=$1`, [id])).rows[0].property_address));

      // Apply the EXACT inbound decision + COALESCE the ingest uses.
      const runInbound = async (id, inboundAddr) => {
        const oursText = _addrOf((await db.query(`SELECT property_address FROM applications WHERE id=$1`, [id])).rows[0].property_address);
        const uspsImported = !!(await db.query(`SELECT usps_imported_at FROM applications WHERE id=$1`, [id])).rows[0].usps_imported_at;
        const d = ingest.inboundAddressDecision({ oursText, theirsText: _addrOf(inboundAddr), uspsImported });
        const val = (d === 'same_address' || d === 'same_property' || d === 'no_house') ? null : inboundAddr;
        await db.query(
          `UPDATE applications SET property_address = COALESCE($2::jsonb, property_address) WHERE id=$1`,
          [id, val == null ? null : JSON.stringify(val)]);
        return d;
      };

      // Scenario A — the Google echo (same city, ZIP 07063): stamp SURVIVES.
      const appA = await mkUspsApp();
      const dA = await runInbound(appA, { line1: '1727 S 2nd St', city: 'Piscataway', state: 'NJ', zip: '07063', oneLine: '1727 S 2nd St, Piscataway, NJ 07063' });
      ok(dA === 'same_property', 'A: the guard decides same_property for the Google echo');
      ok(await stampLive(appA) === true, 'A: the USPS verification stamp SURVIVES the round-trip');
      ok(await zipStored(appA) === '08854', 'A: property_address is unchanged (still the USPS 08854 form)');

      // Scenario B — a genuinely different place (different city): stamp WIPED, re-verify.
      const appB = await mkUspsApp();
      const dB = await runInbound(appB, { line1: '1727 S 2nd St', city: 'Plainfield', state: 'NJ', zip: '07063', oneLine: '1727 S 2nd St, Plainfield, NJ 07063' });
      ok(dB === 'overwrite', 'B: a different-city inbound decides overwrite');
      ok(await stampLive(appB) === false, 'B: the stamp is WIPED — the new property must be re-verified');
      ok(await zipStored(appB) === '07063', 'B: property_address was overwritten (a real property change flows in)');

      // Scenario C — BASELINE: write the same-city echo DIRECTLY (bypass the guard).
      // The db/415 trigger is ZIP-strict (pilot_address_same_place ignores the city),
      // so it wipes the stamp — proving the INBOUND GUARD is the sole protector of
      // the same-city ZIP-diff case (without it, Scenario A would have wiped too).
      const appC = await mkUspsApp();
      await db.query(
        `UPDATE applications SET property_address = $2::jsonb WHERE id=$1`,
        [appC, JSON.stringify({ line1: '1727 S 2nd St', city: 'Piscataway', state: 'NJ', zip: '07063', oneLine: '1727 S 2nd St, Piscataway, NJ 07063' })]);
      ok(await stampLive(appC) === false,
        'C: writing the same-city echo DIRECTLY wipes the stamp — the guard is what protects Scenario A');

      await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [bId]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [bId]);
    } catch (e) {
      fail++; console.log('  FAIL: DB stamp test threw:', e.message);
      try { if (bId) { await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [bId]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bId]); } } catch (_) {}
    }
    try { await db.pool.end(); } catch (_) {}
  } else {
    console.log('  ~~ SKIP USPS stamp DB test (no DATABASE_URL)');
  }

  console.log(`usps↔clickup sync: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

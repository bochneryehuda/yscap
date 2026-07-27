'use strict';
/**
 * SAME-ADDRESS COMPARISON — "is this the same place?", not "is this the same
 * string?" (owner-reported 2026-07-26 evening).
 *
 *   node scripts/test-address-same.js                        (pure)
 *   DATABASE_URL=postgres://… node scripts/test-address-same.js  (+ the queue closer)
 *
 * The fixtures below are the REAL sync-review queue the owner sent — every
 * "Borrower home address / Encompass → PILOT" row, verbatim. Proves:
 *   1. Every pair that is the same home compares EQUAL (a trailing ", USA", a
 *      unit keyword, an abbreviation, an ordinal, the municipality vs the
 *      mailing city) — those rows must never have been queued.
 *   2. Every pair that is genuinely different stays DIFFERENT — a different
 *      house number, street, ZIP or unit is a real question for a human, and
 *      several of these are worth fixing (a transposed ZIP, 641 vs 635).
 *   3. The negative battery: nothing collapses two real addresses.
 *   4. The producer (Encompass enrichment) and the ClickUp no-op suppression
 *      both use it, and neither can render "[object Object]".
 *   5. DB: the boot pass closes the equivalent rows already in the queue and
 *      leaves the real ones open.
 */
const R = require('path').resolve(__dirname, '..');
const ADDR = require(R + '/src/lib/address');
const mapper = require(R + '/src/clickup/mapper');
const F = require(R + '/src/clickup/fields');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ── 1. the owner's queue: rows that were never a disagreement ──────────────
// [ Encompass value, PILOT value ]
const SAME_PAIRS = [
  ['312 Cedarhurst Ave, Cedarhurst, NY 11516', '312 Cedarhurst Ave, Hempstead, NY 11516, USA'],
  ['5701 15 Ave 4D, Brooklyn, NY 11219', '5701 15th Ave Apt 4d, Brooklyn, NY 11219, USA'],
  ['1341 40th St #, Brooklyn, NY 11218', '1341 40th St #3, Brooklyn, NY 11218, USA'],
  ['814 Bedford Ave 5B, Brooklyn, NY 11205', '814 Bedford Ave Apartment 5b, Brooklyn, NY 11205, USA'],
  ['142 clymer street 2, brooklyn, NY 11211', '142 Clymer St, Brooklyn, NY 11211, USA'],
  ['199 Hewes St. 4, Brooklyn, NY 11211', '199 Hewes St, Brooklyn, NY 11211, USA'],
  ['100 whisper vlg, lakewood, NJ 08701', '100 Whisper Vlg Wy, Lakewood, NJ 08701, USA'],
  ['282 Rodney St 2, Brooklyn, NY 11211', '282 Rodney St APT 2, Brooklyn, NY 11211, USA'],
  ['4716 14th avenue E6, Brrooklyn, NY 11219', '4716 14th Ave e6, Brooklyn, NY 11219, USA'],
  ['27 Ridge Avenue 207, Spring Valley, NY 10977', '27 Ridge Ave Unit 207, Spring Valley, NY 10977, USA'],
  ['14 Park ST, Spring Valley, NY 10977', '14 Park St Unit 112, Spring Valley, NY 10977, USA'],
  ['21 Homestead Lane Unit 2, Monsey, NY 10952', '21 Homestead Ln #2, Monsey, NY 10952, USA'],
  ['4611 12th Avenue Apt 3L 3L, Brooklyn, NY 11219', '4611 12th Ave, Brooklyn, NY 11219, USA'],
  ['1563 61th St. 4, Brooklyn, NY 11219', '1563 61st St, Brooklyn, NY 11219, USA'],
  ['4 Basswood dr., Lakewood, NJ 08701', '4 Basswood Dr l, Lakewood, NJ 08701, USA'],
  ['446 Marcy Ave 3A, Brooklyn, NY 11206', '446 Marcy Ave APT 3A, Brooklyn, NY 11206, USA'],
  ['53 Lenox Dr, Lakewood, Lakewood, NJ 08701', '53 Lenox Dr, Lakewood, NJ 08701, USA'],
  ['360 Island Ave, Woodmere, NY 11598', '360 Island Ave, Hempstead, NY 11598, USA'],
  ['8 Rovna ct 312, Monroe, NY 10950', '8 Rovna Ct, Monroe, NY 10950, USA'],
  ['22 Jefferson ave, Spring Valley, NY 10977', 'Right side, Back door, 22 Jefferson Ave, Spring Valley, NY 10977, USA'],
  ['74 Ross st 1h, Brooklyn, NY 11249', 'Bedford Gardens, 74 Ross St #1h, Brooklyn, NY 11249, USA'],
  ['175 Hooper St, 1, Brooklyn, NY 11211', '175 Hooper St, Brooklyn, NY 11211, USA'],
  ['744 Bedford Ave, Brooklyn, NY 11205', '744 Bedford Ave #507, Brooklyn, NY 11205, USA'],
  ['15 Ostereh Blvd, Spring Valley, NY 10977', '15 Ostereh Blvd, Ramapo, NY 10977, USA'],
  ['1935 49th Rd 705, Brooklyn, NY 11204', '1935 49th Rd Apartment 705, Brooklyn, NY 11204, USA'],
  ['7 Andover Rd, Jackson, NJ 08527', '7 Andover Rd, Jackson Township, NJ 08527, USA'],
  ['82-84 middleton st Apartment 4a, brooklyn, NY 11206', '82-84 Middleton St #4a, Brooklyn, NY 11206, USA'],
  ['12 Elaine Pl 111, Monsey, NY 10952', '12 Elaine Pl Unit 111, Monsey, NY 10952, USA'],
  ['7 Jefferson Ave, spring valley, NY 10977', '7 Jefferson Ave, Ramapo, NY 10977, USA'],
  ['932 Chestnut Ridge Rd, spring valley, NY 10977', '932 Chestnut Ridge Rd, Ramapo, NY 10977, USA'],
  ['585 Marcy Avenue, apt 6c, Brooklyn, NY 11206', '585 Marcy Ave #6c, Brooklyn, NY 11206, USA'],
  ['1567 61st Street, 2r, Brooklyn, NY 11219', '1567 61st St Apartment 2r, Brooklyn, NY 11219, USA'],
  ['218-222 Skillman St Condo 8 B, Brooklyn, NY 11205', '218 Skillman St #8b, Brooklyn, NY 11205, USA'],
  ['1220 43rd St Apt, Brooklyn, NY 11219', '1220 43rd St d4, Brooklyn, NY 11219, USA'],
  ['1644 58th St Apt, Brooklyn, NY 11204', '1644 58th St, Brooklyn, NY 11204, USA'],
  ['18 Hammond St Unit, Monsey, NY 10952', '18 Hammond St Unit 201, Monsey, NY 10952, USA'],
  ['1350 54th Street, Brooklyn, NY 11219', '1350 54th St #2d, Brooklyn, NY 11219, USA'],
  ['27 Tuscany Terrace, Lakewood, NJ 08701', '27-29 Tuscany Terrace, Lakewood, NJ 08701, USA'],
  ['26 Calvert Drive Apartment 214, Kaser, NY 10952', '26 Calvert Dr Unit 214, Kaser, NY 10952, USA'],
  ['61 Mezritch Rd 113, Spring Valley, NY 10977', '61 Mezritch Rd, Spring Valley, NY 10977, USA'],
  ['234 Walworth St 1r, Brooklyn, NY 11205', '234 Walworth St, Brooklyn, NY 11205, USA'],
  ['92 Stockton St. 8B, Brooklyn, NY 11206', '92 Stockton St Apartment 8b, Brooklyn, NY 11206, USA'],
  ['1722 45th St, Brooklyn, NY 11204', '1722 45th St #1, Brooklyn, NY 11204, USA'],
  ['134 Stockton Street 5A, Brooklyn, NY 11206', '134 Stockton St, Brooklyn, NY 11206, USA'],
  ['1369 59th Street Floor 3, Brooklyn, NY 11219', '1369 59th St, Brooklyn, NY 11219, USA'],
  ['70 Throop Avenue 1, Brooklyn, NY 11206', '70 Throop Ave, Brooklyn, NY 11206, USA'],
];
for (const [enc, pilot] of SAME_PAIRS) {
  ok(ADDR.sameAddress(enc, pilot), `same home, never a review:\n     ENC: ${enc}\n     PIL: ${pilot}`);
  ok(ADDR.sameAddress(pilot, enc), 'the comparison is symmetric: ' + enc);
}

// ── 2. the rows in that SAME queue that ARE a real difference ──────────────
const REAL_DIFFERENCES = [
  ['755 Bedford Ave #1, Brooklyn, NY 11206', '702 Bedford Ave #1, Brooklyn, NY 11206, USA', 'different house number'],
  ['11 davos place, lakewood, NJ 08071', '11 Davos Pl, Lakewood, NJ 08701, USA', 'transposed ZIP'],
  ['27 Karlsburg Rd Apartment 302, Monroe, NY 10350', '27 Karlsburg Rd Unit 302, Monroe, NY 10950, USA', 'different ZIP'],
  ['1 Karlsburg Rd #301, Monroe, NY 10952', '1 Karlsburg Rd, Monroe, NY 10950, USA', 'different ZIP'],
  ['34 Baila Dr, Lakewood, NJ 08701', '5 14th St, Lakewood, NJ 08701, USA', 'a different address entirely'],
  ['3 Sansberry Lane, Spring Valley, NY 10977', '35 Ostilla Ave, New Square, NY 10977, USA', 'a different address entirely'],
  ['641 Dahill Rd, Brooklyn, NY 11218', '635 Dahill Rd, Brooklyn, NY 11218, USA', 'different house number'],
  ['570 Wythe Ave Apartment 1A, Brooklyn, NY 11249', '570 Wythe Ave #1, Brooklyn, NY 11249, USA', 'different unit'],
];
for (const [enc, pilot, why] of REAL_DIFFERENCES) {
  ok(!ADDR.sameAddress(enc, pilot), `stays a review (${why}):\n     ENC: ${enc}\n     PIL: ${pilot}`);
}

// ── 3. the negative battery — nothing collapses two real addresses ─────────
const NEVER_SAME = [
  ['12 Oak St, Monsey, NY 10952', '14 Oak St, Monsey, NY 10952', 'house number'],
  ['12 Oak St, Monsey, NY 10952', '12 Elm St, Monsey, NY 10952', 'street name'],
  ['12 Oak St, Monsey, NY 10952', '12 Oak St, Monsey, NY 10977', 'ZIP'],
  ['12 Oak St Apt 3, Monsey, NY 10952', '12 Oak St Apt 5, Monsey, NY 10952', 'unit'],
  ['12 Oak St, Monsey, NY', '12 Oak St, Lakewood, NJ', 'state (and city, no ZIP either side)'],
  ['12 Oak Street, Monsey, NY 10952', '12 Oak Street Extension, Monsey, NY 10952', 'Extension is its own street'],
  ['100 Main St, Newark, NJ 07102', '100 Main St, Newark, DE 07102', 'state'],
  ['12 Oak St, Monsey, NY 10952', '', 'one side blank'],
  ['', '', 'both blank'],
  ['Monsey, NY 10952', 'Monsey, NY 10952', 'no house number on either side — unreadable, never "same"'],
];
for (const [a, b, why] of NEVER_SAME) ok(!ADDR.sameAddress(a, b), `never collapsed (${why}): "${a}" vs "${b}"`);

// hostile input never throws
for (const v of [null, undefined, 0, {}, [], { line1: {} }, 'x', '...,,,']) {
  let threw = false;
  try { ADDR.sameAddress(v, '12 Oak St, Monsey, NY 10952'); ADDR.parseAddressParts(v); ADDR.addressCompareKey(v); } catch (_) { threw = true; }
  ok(!threw, 'hostile input never throws: ' + JSON.stringify(v));
}

// ── 3b. the DIRECTIONAL rule (owner-reported 2026-07-27) ──────────────────
// "Property address | 1727 2nd St Piscataway NJ 08854 | 1727 S 2ND ST
// PISCATAWAY NJ 08854 | Doesn't match" — one home. The Encompass side is the
// USPS-standardized spelling; ours simply omits the "S". A directional only ONE
// side wrote is the same address with less detail (the call the unit rule
// already makes); two DIFFERENT directionals stay two real streets.
const DIR_SAME = [
  ['1727 2nd St Piscataway NJ 08854', '1727 S 2ND ST PISCATAWAY NJ 08854', "the owner's row, verbatim (no commas)"],
  ['1727 2nd St, Piscataway, NJ 08854', '1727 S 2ND ST, PISCATAWAY, NJ 08854', 'same row, comma form'],
  ['12 Oak St, Monsey, NY 10952', '12 N Oak St, Monsey, NY 10952', 'leading directional on one side'],
  ['12 Oak St NW, Monsey, NY 10952', '12 Oak St, Monsey, NY 10952', 'trailing directional on one side'],
  ['12 S Oak St, Monsey, NY 10952', '12 Oak St S, Monsey, NY 10952', 'same directional, written at either end'],
  ['1727 S 2nd St, Piscataway, NJ 08854', '1727 SOUTH 2ND STREET, PISCATAWAY, NJ 08854', 'abbreviated vs spelled out'],
  ['12 North Ave, Monsey, NY 10952', '12 N Ave, Monsey, NY 10952', 'a street NAMED North is still abbreviated, not erased'],
];
for (const [a, b, why] of DIR_SAME) ok(ADDR.sameAddress(a, b), `same home (${why}): "${a}" vs "${b}"`);

const DIR_DIFFERENT = [
  ['12 W 42nd St, New York, NY 10036', '12 E 42nd St, New York, NY 10036', 'W vs E — two real streets'],
  ['12 N Oak St, Monsey, NY 10952', '12 S Oak St, Monsey, NY 10952', 'N vs S'],
  ['12 Oak St NW, Washington, DC 20001', '12 Oak St NE, Washington, DC 20001', 'NW vs NE'],
  ['12 North Ave, Monsey, NY 10952', '12 South Ave, Monsey, NY 10952', 'the street name IS the direction — never reduced to nothing'],
  ['12 West End Ave, New York, NY 10023', '12 East End Ave, New York, NY 10023', 'West End vs East End'],
  ['1727 S 2nd St, Piscataway, NJ 08854', '1727 S 3rd St, Piscataway, NJ 08854', 'directional matches, street does not'],
  ['1727 2nd St, Piscataway, NJ 08854', '1729 S 2nd St, Piscataway, NJ 08854', 'one-sided directional never excuses a different house number'],
  ['1727 2nd St, Piscataway, NJ 08854', '1727 S 2nd St, Piscataway, NJ 08855', 'one-sided directional never excuses a different ZIP'],
];
for (const [a, b, why] of DIR_DIFFERENT) ok(!ADDR.sameAddress(a, b), `stays a review (${why}): "${a}" vs "${b}"`);

// The grouping key must be BYTE-IDENTICAL to before this rule existed — it is
// used to dedupe/group addresses, where "S 2nd St" and "2nd St" are separate
// buckets on purpose. Only sameAddress() learned the new tolerance.
for (const [addr, key, why] of [
  ['1727 S 2nd St, Piscataway, NJ 08854', '1727|south2|08854', 'the directional is still IN the grouping key'],
  ['1727 2nd St, Piscataway, NJ 08854', '1727|2|08854', 'no directional — unchanged'],
  ['100 Whisper Vlg Wy, Lakewood, NJ 08701', '100|whispervlg|08701', 'optional street type still dropped'],
  ['10 Oak St NW, Washington, DC 20001', '10|oak|20001', 'trailing token handling unchanged'],
]) ok(ADDR.addressCompareKey(addr) === key, `addressCompareKey unchanged (${why}): "${addr}" -> ${ADDR.addressCompareKey(addr)}`);

// ── 4. it is wired where the rows come from ───────────────────────────────
const enrich = require(R + '/src/encompass/enrich');
ok(/sameAddress/.test(require('fs').readFileSync(R + '/src/encompass/enrich.js', 'utf8')),
  'the Encompass enrichment decides agreement with sameAddress');
ok(/sameAddress/.test(require('fs').readFileSync(R + '/src/lib/sync-review-recheck.js', 'utf8')),
  'the sync-review re-check decides agreement with sameAddress');
ok(/sameAddress/.test(require('fs').readFileSync(R + '/src/encompass/reconcile.js', 'utf8')),
  'the Encompass comparison panel decides agreement with sameAddress');

// …and END-TO-END through the panel itself: the owner's exact row must come back
// 'match'. This is the surface that reported "Doesn't match" — the letters-only
// key it used before could never see past the missing "S".
{
  const reconcile = require(R + '/src/encompass/reconcile');
  const compareIdentity = reconcile._internals.compareIdentity;
  const loanFor = (street, city, state, zip) => ({
    applications: [{ borrower: { firstName: 'Test', lastName: 'Borrower' } }],
    property: { streetAddress: street, city, state, postalCode: zip },
  });
  const row = (addr) => ({ b_first_name: 'Test', b_last_name: 'Borrower', property_address: addr });
  const addrRow = (ourAddr, loan) => compareIdentity(row(ourAddr), loan).find((f) => f.key === 'id_property_address');

  const owner = addrRow({ oneLine: '1727 2nd St, Piscataway, NJ 08854' },
    loanFor('1727 S 2ND ST', 'PISCATAWAY', 'NJ', '08854'));
  ok(owner && owner.status === 'match',
    `the owner's property-address row now MATCHES (got ${owner && owner.status})`);

  const realDiff = addrRow({ oneLine: '1729 2nd St, Piscataway, NJ 08854' },
    loanFor('1727 S 2ND ST', 'PISCATAWAY', 'NJ', '08854'));
  ok(realDiff && realDiff.status === 'mismatch',
    `a different house number still MISMATCHES (got ${realDiff && realDiff.status})`);

  const oppositeDir = addrRow({ oneLine: '1727 N 2nd St, Piscataway, NJ 08854' },
    loanFor('1727 S 2ND ST', 'PISCATAWAY', 'NJ', '08854'));
  ok(oppositeDir && oppositeDir.status === 'mismatch',
    `N vs S still MISMATCHES (got ${oppositeDir && oppositeDir.status})`);

  const missing = addrRow(null, loanFor('1727 S 2ND ST', 'PISCATAWAY', 'NJ', '08854'));
  ok(missing && missing.status === 'incomparable',
    `a blank side is still "no data to compare", never a false match (got ${missing && missing.status})`);

  // A stored staff RESOLUTION is held by comparing the NORMALIZED values
  // (`snap(cmp.oursNorm) === snap(r.ours_snapshot)`), and `normName` turns a
  // comma into a space — so switching `_addrStr` from a space-join to the
  // canonical comma one-line leaves every existing resolution snapshot intact.
  // If this ever drifts, previously-accepted address findings would all re-open.
  const spaceJoined = addrRow({ oneLine: '1727 S 2ND ST PISCATAWAY NJ 08854' },
    loanFor('1727 S 2ND ST', 'PISCATAWAY', 'NJ', '08854'));
  const commaJoined = addrRow({ oneLine: '1727 S 2ND ST, PISCATAWAY, NJ 08854' },
    loanFor('1727 S 2ND ST', 'PISCATAWAY', 'NJ', '08854'));
  ok(spaceJoined.theirsNorm === commaJoined.theirsNorm && spaceJoined.oursNorm === commaJoined.oursNorm,
    'the normalized key is identical either way — stored resolutions are not invalidated');
}
// the ClickUp no-op suppression: PILOT stops at the ZIP, ClickUp appends ", USA"
// (ClickUp's stored value carries no coordinates here — the formatted-address
// fallback path, which is where the ", USA" difference used to bite.)
const eqLoc = mapper.fieldValueEquivalent(
  F.SHARED.borrowerAddress,
  { formatted_address: '26 S 10th St, Brooklyn, NY 11249, USA' },
  { location: { lat: 40.714, lng: -73.963 }, formatted_address: '26 S 10th St, Brooklyn, NY 11249' },
  {});
ok(eqLoc === true, 'a ClickUp address with ", USA" is EQUAL to ours without it (no write churn, no PII review)');
const eqLocDiff = mapper.fieldValueEquivalent(
  F.SHARED.borrowerAddress,
  { formatted_address: '26 S 10th St, Brooklyn, NY 11249, USA' },
  { location: { lat: 40.714, lng: -73.963 }, formatted_address: '30 S 10th St, Brooklyn, NY 11249' },
  {});
ok(eqLocDiff === false, 'a genuinely different address is still a write');

// "[object Object]" can never be shown as an address again
{
  const built = enrich._internals && enrich._internals.partyAddress
    ? enrich._internals.partyAddress({ residences: [{ residencyType: 'Current', addressStreetLine1: { nested: 'object' }, addressCity: 'Jackson', addressState: 'NJ' }] })
    : null;
  const text = JSON.stringify(built || '');
  ok(!/\[object Object\]/.test(text), 'a nested object in an address slot never renders as "[object Object]"');
}

(async () => {
  // ── 5. DB: the already-queued rows ──────────────────────────────────────
  if (process.env.DATABASE_URL) {
    const db = require(R + '/src/db');
    const closer = require(R + '/src/lib/address-review-close');
    try {
      const b = (await db.query(
        `INSERT INTO borrowers(first_name,last_name,email) VALUES('Addr','Same',$1) RETURNING id`,
        ['addrsame' + Math.random() + '@e.com'])).rows[0].id;
      const mkRow = async (enc, pilot, tag) => (await db.query(
        `INSERT INTO sync_review_queue
           (borrower_id, task_id, direction, field_key, current_value, proposed_value, reason, clickup_value, portal_value, source)
         VALUES ($1,$2,'inbound','current_address',$3,$4,'encompass_address_differs: test',$4,$3,'encompass') RETURNING id`,
        [b, 'encompass:test-' + tag + '-' + Math.random(), pilot, enc])).rows[0].id;

      const equivalent = await mkRow('5701 15 Ave 4D, Brooklyn, NY 11219', '5701 15th Ave Apt 4d, Brooklyn, NY 11219, USA', 'same');
      const real = await mkRow('641 Dahill Rd, Brooklyn, NY 11218', '635 Dahill Rd, Brooklyn, NY 11218, USA', 'diff');

      const r = await closer.closeEquivalentAddressReviewsOnce({ limit: 500 });
      ok(r.closed >= 1, 'the closer retired at least the equivalent row (closed ' + r.closed + ')');
      const st = async (id) => (await db.query(`SELECT status FROM sync_review_queue WHERE id=$1`, [id])).rows[0].status;
      ok(await st(equivalent) === 'resolved', 'the same-address row is closed');
      ok(await st(real) === 'open', 'the genuinely different row STAYS OPEN for a human');

      const again = await closer.closeEquivalentAddressReviewsOnce({ limit: 500 });
      ok(!again.closed, 'a second pass closes nothing (idempotent)');

      await db.query(`DELETE FROM sync_review_queue WHERE borrower_id=$1`, [b]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [b]);
    } catch (e) {
      fail++; console.log('  FAIL: DB closer test threw:', e.message);
    }
    try { await db.pool.end(); } catch (_) {}
  } else {
    console.log('  ~~ SKIP address review-close DB test (no DATABASE_URL)');
  }

  console.log(`same-address comparison: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

'use strict';
/**
 * TRACK-RECORD ADDRESS SHAPE — the "(no address)" bug on public-records imports.
 *
 * Owner-reported: a track-record line "brought on from the public records" showed
 * "(no address)" and raised "Property address is required." ROOT CAUSE: elementix
 * shapes.js flattens a deed's addresses[{addressFull}] to a one-line STRING, and
 * the importer stored that string verbatim — but every reader (the tool bridge
 * propFromRow reads .street||.line1||.oneLine; the to-do addressOf reads .oneLine)
 * expects the canonical { line1, city, state, zip, oneLine } object, and a JS
 * string has none of those keys.
 *
 * PURE — the shared coercion + the to-do reader's string tolerance + a source
 * guard on the static tool bridge. DB — the boot heal reshapes the rows the
 * importer already wrote and leaves a canonical row untouched. (The importer's own
 * end-to-end object storage is asserted in test-track-record-importer-db.js §3.)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

// ─────────────────────────── PURE ───────────────────────────
console.log('\nPURE 1. parseToAddressObject coerces a one-line string to the canonical object');
{
  const ADDR = require('../src/lib/address');
  const p = ADDR.parseToAddressObject('26 S 10th St, Brooklyn, NY 11249');
  ok(p && typeof p === 'object', 'a string becomes an object');
  ok(p.line1 === '26 S 10th St' && p.city === 'Brooklyn' && p.state === 'NY' && p.zip === '11249',
    'and it is parsed into line1/city/state/zip');
  ok(p.oneLine === '26 S 10th St, Brooklyn, NY 11249',
    'the verbatim vendor one-line is kept as .oneLine (authoritative for display)');

  // A partial string still preserves oneLine, so display never depends on the parse.
  const partial = ADDR.parseToAddressObject('100 Broadway');
  ok(partial && partial.oneLine === '100 Broadway' && partial.line1 === '100 Broadway',
    'a partial one-line keeps .oneLine even when city/state cannot be parsed');

  // An object is passed through unchanged (the tool/ClickUp/Encompass writers).
  const obj = { line1: '5 Main St', city: 'Lakewood', oneLine: '5 Main St, Lakewood, NJ' };
  ok(ADDR.parseToAddressObject(obj) === obj, 'an object is returned unchanged');

  // Blank / null / array → null (never a bogus empty-string object).
  ok(ADDR.parseToAddressObject('') === null && ADDR.parseToAddressObject(null) === null
    && ADDR.parseToAddressObject('   ') === null && ADDR.parseToAddressObject(['a']) === null,
    'blank / null / whitespace / array → null');
}

console.log('\nPURE 2. the to-do addressOf reads a bare string (belt for un-healed rows)');
{
  // Every reader (loan-file to-do + profile lens) maps a line's address through
  // addressOf — a bare string must read as the address, never "A past project".
  const { addressOf } = require('../src/lib/track-record-todo');
  ok(addressOf('62 Highland St, Lakewood, NJ 08701') === '62 Highland St, Lakewood, NJ 08701',
    'a bare string reads as the address');
  ok(addressOf({ oneLine: '5 Main St, Lakewood, NJ' }) === '5 Main St, Lakewood, NJ',
    'the canonical object still reads via .oneLine');
  ok(addressOf('   ') === 'A past project' && addressOf(null) === 'A past project',
    'a blank / null falls back to the placeholder');
}

console.log('\nPURE 3. the static tool bridge propFromRow tolerates a bare string');
{
  const src = fs.readFileSync(path.join(__dirname, '../web/v2/tools/track-record-portal.js'), 'utf8');
  const fn = src.slice(src.indexOf('function propFromRow'), src.indexOf('function payloadFromProp'));
  ok(/typeof a === "string"/.test(fn) && /a = \{ oneLine: a \}/.test(fn),
    'propFromRow coerces a string to { oneLine } so it lands in the address box');
  ok(/a\.street \|\| a\.line1 \|\| a\.oneLine/.test(fn),
    'and then reads .street||.line1||.oneLine, which a { oneLine } row satisfies');
}

// ─────────────────────────── DB ───────────────────────────
if (!process.env.DATABASE_URL) {
  console.log('\nSKIP DB (no DATABASE_URL)');
  process.exit(fail ? 1 : 0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const ADDR = require('../src/lib/address');
const TRK = require('../src/lib/track-record-key');
const SHAPE = require('../src/lib/track-record-address-shape');
const tag = `trshape_${process.pid}`;

(async () => {
  await ensureSchema();
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Shape','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;

  console.log('\nDB 1. the heal reshapes a legacy STRING row into the canonical object');
  const bare = '62 Highland St, Lakewood, NJ 08701';
  const key0 = TRK.trackRecordKey(bare) || '';
  const strId = (await db.query(
    `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, entered_by_kind, origin)
     VALUES ($1, $2::jsonb, $3, 'flip', 'staff', 'public_records') RETURNING id`,
    [borrowerId, JSON.stringify(bare), key0])).rows[0].id;

  // Precondition: it really is stored as a JSON string (the bug's shape).
  ok((await db.query(`SELECT jsonb_typeof(property_address) AS t FROM track_records WHERE id=$1`, [strId]))
    .rows[0].t === 'string', 'precondition: the row is a bare JSON string (reproduces the bug)');

  const res = await SHAPE.healTrackRecordAddressShapeOnce();
  ok(res.fixed >= 1, `the heal reports it fixed at least one row (fixed ${res.fixed})`);

  const healed = (await db.query(
    `SELECT property_address AS pa, address_key AS k, jsonb_typeof(property_address) AS t
       FROM track_records WHERE id=$1`, [strId])).rows[0];
  ok(healed.t === 'object', 'the row is now a jsonb OBJECT');
  ok(healed.pa && healed.pa.oneLine === bare, 'the verbatim address is preserved as .oneLine');
  ok(healed.pa && healed.pa.line1 === '62 Highland St' && healed.pa.city === 'Lakewood'
    && healed.pa.state === 'NJ' && healed.pa.zip === '08701', 'and it is parsed into parts');
  ok(healed.k === key0, 'address_key is unchanged (same text → same key), left in step with the address');

  // The read the tool bridge performs now succeeds (never "(no address)").
  const bridgeStreet = healed.pa && (healed.pa.street || healed.pa.line1 || healed.pa.oneLine);
  ok(bridgeStreet === '62 Highland St', 'the tool bridge reads a real street off the healed row');

  console.log('\nDB 2. a canonical OBJECT row is left untouched (idempotent, self-draining)');
  const obj = { line1: '118 Oak Ave', city: 'Lakewood', state: 'NJ', zip: '08701', oneLine: '118 Oak Ave, Lakewood, NJ 08701' };
  const objId = (await db.query(
    `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, entered_by_kind)
     VALUES ($1, $2::jsonb, $3, 'flip', 'borrower') RETURNING id`,
    [borrowerId, JSON.stringify(obj), TRK.trackRecordKey(obj) || ''])).rows[0].id;
  const before = (await db.query(`SELECT property_address AS pa FROM track_records WHERE id=$1`, [objId])).rows[0].pa;
  const res2 = await SHAPE.healTrackRecordAddressShapeOnce();
  ok(res2.fixed === 0, 'a second pass with no string rows fixes nothing (self-draining)');
  const after = (await db.query(`SELECT property_address AS pa FROM track_records WHERE id=$1`, [objId])).rows[0].pa;
  ok(JSON.stringify(before) === JSON.stringify(after), 'the object row is byte-for-byte unchanged');

  console.log('\nDB 3. the heal NEVER un-verifies a reviewed line (db/516 shape-repair guard)');
  // A public-records line the importer wrote as a bare string, that a reviewer then
  // VERIFIED, is the normal steady state. db/485 forces a line back to pending on any
  // material change and lists property_address as material — but a string->object reshape
  // is a repair with identical address text, not a restatement, so it must NOT un-verify.
  const bare2 = '208 Verified Ln, Lakewood, NJ 08701';
  const vId = (await db.query(
    `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, entered_by_kind, origin)
     VALUES ($1, $2::jsonb, $3, 'flip', 'staff', 'public_records') RETURNING id`,
    [borrowerId, JSON.stringify(bare2), TRK.trackRecordKey(bare2) || ''])).rows[0].id;
  // A verification touches ONLY the verification columns, so the guard leaves it alone.
  await db.query(
    `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now() WHERE id=$1`, [vId]);
  const pre = (await db.query(
    `SELECT is_verified, verification_status FROM track_records WHERE id=$1`, [vId])).rows[0];
  ok(pre.is_verified === true && pre.verification_status === 'verified',
    'precondition: the bare-string line is VERIFIED (a reviewer clicked Verify)');

  const res3 = await SHAPE.healTrackRecordAddressShapeOnce();
  ok(res3.fixed >= 1, 'the heal reshaped the bare-string row');
  const post = (await db.query(
    `SELECT is_verified, verification_status, jsonb_typeof(property_address) AS t
       FROM track_records WHERE id=$1`, [vId])).rows[0];
  ok(post.t === 'object', 'the address is now an object');
  ok(post.is_verified === true && post.verification_status === 'verified',
    'and the human verification SURVIVED the reshape — a shape repair is not a restatement (db/516)');

  await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);

  console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/**
 * THE USPS ADDRESS STAMP MUST SURVIVE A RE-SPELLING OF THE SAME ADDRESS.
 *
 *   node scripts/test-usps-address-stability-db.js          (pure only, no DB)
 *   DATABASE_URL=postgres://… node scripts/test-usps-address-stability-db.js
 *
 * Owner-reported 2026-08-02: "USPS verification is not updating — had to do it
 * twice, once before the title order and once before insurance … even when we
 * import our USPS address verification it bounces back. You can import it no
 * matter how many times you want, it bounces back and reverses."
 *
 * REPRODUCED, then fixed in three places:
 *   · db/415 — the reopen trigger compares the address by MEANING, so a different
 *     SPELLING (or merely a different object shape) of the same place no longer
 *     wipes the stamp and reopens the condition.
 *   · src/clickup/ingest.js — the inbound pull declines to write an address that
 *     is the same place as the one we hold, so ClickUp's Google spelling stops
 *     overwriting the USPS one on every reconcile in the first place.
 *   · src/lib/usps-stamp-heal.js — the previous files whose stamps it already wiped.
 *
 * Every assertion below fails on the code as it stood before that work.
 */
const R = require('path').resolve(__dirname, '..');
const ADDR = require(R + '/src/lib/address');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

/* ─────────── 1. PURE — the two spellings really are the same place ──────────
   The JS predicate is the go-forward guard's whole decision, so pin the exact
   shapes the two systems produce. */
const USPS_ONE = '21 Governor St, Providence, RI 02906-1234';
const GOOGLE_ONE = '21 Governor St, Providence, RI 02906, USA';
ok(ADDR.sameAddress(USPS_ONE, GOOGLE_ONE),
  'the USPS form and the Google form of one address are the same place');
ok(ADDR.sameAddress('26 South 10th Street, Brooklyn, NY 11249', '26 S 10th St, Brooklyn, NY 11249'),
  'a spelled-out street and its abbreviation are the same place');
ok(!ADDR.sameAddress('1727 S 2nd St, Piscataway, NJ 08854', '1725 S 2nd St, Piscataway, NJ 08854'),
  'a different house number is NOT the same place — a real edit still flows in');
ok(!ADDR.sameAddress('1727 S 2nd St, Piscataway, NJ 08854', '1727 S 2nd St, Plainfield, NJ 07063'),
  'the same street number across a municipal line is a different property');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('  ~~ SKIP the DB half (no DATABASE_URL)');
    console.log(fail ? `\n${fail} FAILURE(S)` : `\nAll ${pass} USPS address-stability checks passed.`);
    process.exit(fail ? 1 : 0);
  }
  const db = require(R + '/src/db');
  const mapper = require(R + '/src/clickup/mapper');
  const heal = require(R + '/src/lib/usps-stamp-heal');
  const uspsVerify = require(R + '/src/lib/usps-verify');

  /* ───── 2. THE SQL KEY NEVER OVER-MATCHES what the JS calls the same place ─────
     db/415's trigger runs in SQL, so it needs its own reading of "same place".
     Under-matching only costs a re-verification; over-matching would leave a USPS
     stamp standing on a DIFFERENT property, so that direction is asserted here. */
  const PAIRS = [
    // [a, b, sameInJs]
    [{ line1: '21 Governor St', state: 'RI', zip: '02906-1234' }, { line1: '21 Governor Street', state: 'RI', zip: '02906' }, true],
    [{ line1: '26 South 10th Street', state: 'NY', zip: '11249' }, { line1: '26 S 10th St', state: 'NY', zip: '11249' }, true],
    [{ line1: '5701 15 Ave', unit: '4D', state: 'NY', zip: '11219' }, { line1: '5701 15th Ave Apt 4d', state: 'NY', zip: '11219' }, true],
    [{ line1: '100 Whisper Vlg', state: 'NJ', zip: '07456' }, { line1: '100 Whisper Vlg Way', state: 'NJ', zip: '07456' }, true],
    [{ line1: '12 Main St', state: 'NY', zip: '11219' }, { line1: '14 Main St', state: 'NY', zip: '11219' }, false],
    [{ line1: '12 Main St', state: 'NY', zip: '11219' }, { line1: '12 Maple St', state: 'NY', zip: '11219' }, false],
    [{ line1: '1727 S 2nd St', state: 'NJ', zip: '08854' }, { line1: '1727 S 2nd St', state: 'NJ', zip: '07063' }, false],
    [{ line1: '5 S Main St', state: 'NY', zip: '11219' }, { line1: '5 Main St', state: 'NY', zip: '11219' }, false],
    [{ line1: '12 Main St', unit: 'Apt 4B', state: 'NY', zip: '11219' }, { line1: '12 Main St', unit: 'Apt 5B', state: 'NY', zip: '11219' }, false],
    [{ city: 'Brooklyn', state: 'NY' }, { city: 'Brooklyn', state: 'NY' }, false],
    // A KNOWN, DELIBERATE DIVERGENCE, kept here so it stays visible: the JS parser
    // reads the abbreviated "12 Oak St Ext" as "12 Oak St" with unit "Ext" and so
    // calls the two the same place; the SQL key does not. Both answers are SAFE for
    // this trigger — SQL's "different" only costs a re-verification — and the JS
    // reading is load-bearing elsewhere (the SharePoint matcher, the review closer),
    // so it is not changed under an unrelated fix.
    [{ line1: '12 Oak St', state: 'NJ', zip: '07456' }, { line1: '12 Oak St Extension', state: 'NJ', zip: '07456' }, true, { sqlDiffers: true }],
  ];
  let overMatched = 0, agreed = 0, expected = 0;
  for (const [a, b, sameInJs, opt] of PAIRS) {
    const withLine = (x) => ({ ...x, oneLine: ADDR.canonicalOneLine({ ...x, city: x.city || 'Anytown' }) });
    const js = ADDR.sameAddress(withLine(a), withLine(b));
    const sql = (await db.query('SELECT pilot_address_same_place($1::jsonb,$2::jsonb) AS same',
      [JSON.stringify(a), JSON.stringify(b)])).rows[0].same;
    if (js !== sameInJs) { fail++; console.log('FAIL', `the JS predicate changed on ${a.line1 || '(no street)'} vs ${b.line1 || '(no street)'}`); }
    if (sql && !js) overMatched++;                      // the ONE direction that would be unsafe
    if (!(opt && opt.sqlDiffers)) { expected++; if (sql === js) agreed++; }
  }
  ok(overMatched === 0, 'the SQL key NEVER calls two addresses the same place that the JS does not');
  ok(agreed === expected, `the SQL key matches the JS on every sample it is meant to (${agreed}/${expected})`);

  /* ───────────── 3. THE TRIGGER — the reported bounce, end to end ───────────── */
  const b = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Usps','Stability',$1) RETURNING id`,
    [`usps-stability-${Date.now()}@example.com`])).rows[0];
  const t = (await db.query(`SELECT id FROM checklist_templates WHERE code='usps_address_verification'`)).rows[0];
  const USPS_ADDRESS = {
    line1: '21 Governor St', unit: '', city: 'Providence', state: 'RI',
    zip: '02906-1234', zip5: '02906', zip4: '1234', street: '21 Governor St',
    oneLine: USPS_ONE, formatted_address: USPS_ONE, source: 'usps',
  };

  async function newFile() {
    const a = (await db.query(
      `INSERT INTO applications (borrower_id, status, property_address) VALUES ($1,'underwriting',$2::jsonb) RETURNING id`,
      [b.id, JSON.stringify({ line1: '21 Governor St', city: 'Providence', state: 'RI', zip: '02906', oneLine: '21 Governor St, Providence, RI 02906' })])).rows[0];
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, label, audience, item_kind, application_id, is_required, status, created_by_kind)
       VALUES ($1,'application','USPS Address Verification','staff','condition',$2,true,'outstanding','system')`, [t.id, a.id]);
    return a.id;
  }
  // Exactly what POST /usps-verification/import does.
  async function importStamp(appId) {
    await db.query(`UPDATE applications SET usps_address=$2::jsonb, usps_match='verified', usps_verified_at=now() WHERE id=$1`,
      [appId, JSON.stringify(USPS_ADDRESS)]);
    await db.query(`UPDATE applications SET property_address=usps_address, usps_imported_at=now() WHERE id=$1`, [appId]);
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now() WHERE application_id=$1 AND template_id=$2`, [appId, t.id]);
  }
  const state = async (appId) => ({
    app: (await db.query(`SELECT usps_imported_at, usps_match, property_address FROM applications WHERE id=$1`, [appId])).rows[0],
    cond: (await db.query(`SELECT status FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appId, t.id])).rows[0],
  });

  const appA = await newFile();
  await importStamp(appA);
  {
    const s = await state(appA);
    ok(!!s.app.usps_imported_at && s.cond.status === 'satisfied', 'importing the USPS address stamps the file and clears the condition');
  }
  // The next ClickUp reconcile: the card holds Google's spelling of the SAME place.
  const pulled = mapper.normalizeClickupLocation({ formatted_address: GOOGLE_ONE, location: { lat: 41.8268, lng: -71.3948 } });
  await db.query(`UPDATE applications SET property_address=COALESCE($2::jsonb, property_address) WHERE id=$1`,
    [appA, JSON.stringify(pulled)]);
  {
    const s = await state(appA);
    ok(!!s.app.usps_imported_at && s.app.usps_match === 'verified' && s.cond.status === 'satisfied',
      'THE REPORTED BUG: a ClickUp pull of the same address in Google’s spelling no longer reverses the verification');
  }
  // The same address in a DIFFERENT OBJECT SHAPE (no zip5/zip4/source keys) — this
  // alone used to wipe the stamp, because the trigger compared the whole jsonb.
  await db.query(`UPDATE applications SET property_address=$2::jsonb WHERE id=$1`,
    [appA, JSON.stringify({ line1: '21 Governor St', city: 'Providence', state: 'RI', zip: '02906-1234', oneLine: USPS_ONE })]);
  ok(!!(await state(appA)).app.usps_imported_at,
    'the identical address in a different object shape does not reverse it either');
  // A REAL change still does, exactly as db/379 intended.
  await db.query(`UPDATE applications SET property_address=$2::jsonb WHERE id=$1`,
    [appA, JSON.stringify({ line1: '23 Governor St', city: 'Providence', state: 'RI', zip: '02906', oneLine: '23 Governor St, Providence, RI 02906' })]);
  {
    const s = await state(appA);
    ok(!s.app.usps_imported_at && !s.app.usps_match && s.cond.status === 'outstanding',
      'a genuinely DIFFERENT property still clears the stamp and reopens the condition');
  }

  /* ─── 4. THE INBOUND GUARD — the pull declines to write a re-spelling at all ─── */
  {
    const ours = { line1: '21 Governor St', city: 'Providence', state: 'RI', zip: '02906-1234', oneLine: USPS_ONE };
    const theirs = mapper.normalizeClickupLocation({ formatted_address: GOOGLE_ONE, location: { lat: 41.8268, lng: -71.3948 } });
    const src = require('fs').readFileSync(R + '/src/clickup/ingest.js', 'utf8');
    ok(/ADDR\.sameAddress\(oursText,\s*theirsText\)/.test(src) && /cols\.property_address = null;\s*\/\/ COALESCE keeps our/.test(src),
      'the inbound pull compares the subject address by MEANING and keeps ours when it is the same place');
    ok(ADDR.sameAddress(ADDR.addressTextOf(ours), ADDR.addressTextOf(theirs)),
      'and on this exact pair that guard fires, so the card’s spelling never reaches the file');
  }

  /* ───────── 5. PREVIOUS FILES — the stamps the bug already wiped ───────────── */
  const appB = await newFile();
  await importStamp(appB);
  // A human's own import audit row is what proves the decision was already made.
  await db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ('staff', NULL, 'usps_verified_address_imported', 'application', $1, '{"status":"verified"}'::jsonb)`, [appB]);
  // Now force the OLD damage: wipe the stamp and put the card's spelling back.
  await db.query(
    `UPDATE applications SET usps_address=NULL, usps_match=NULL, usps_dpv=NULL,
            usps_verified_at=NULL, usps_imported_at=NULL, property_address=$2::jsonb WHERE id=$1`,
    [appB, JSON.stringify(pulled)]);
  await db.query(`UPDATE checklist_items SET status='outstanding', signed_off_at=NULL WHERE application_id=$1 AND template_id=$2`, [appB, t.id]);

  // With NOTHING in the USPS lookup cache the repair must decline — it may never
  // invent a verification, and it must never call USPS.
  const hash = uspsVerify.hashInput(uspsVerify.normInput({ line1: '21 Governor St', city: 'Providence', state: 'RI', zip: '02906' }));
  await db.query(`DELETE FROM usps_address_verifications WHERE address_hash=$1`, [hash]);
  {
    const r = await heal.restoreBouncedUspsStampsOnce({ limit: 10 });
    ok(r.restored === 0 && r.skipped.not_cached >= 1,
      'with no cached USPS answer the repair declines — it never invents a verification');
  }
  // With the answer we already paid for in the cache, the human's decision is restored.
  await db.query(
    `INSERT INTO usps_address_verifications (address_hash, input, standardized, dpv, status, verified_at)
     VALUES ($1,$2::jsonb,$3::jsonb,NULL,'verified',now())
     ON CONFLICT (address_hash) DO UPDATE SET standardized=EXCLUDED.standardized, status='verified', verified_at=now()`,
    [hash, JSON.stringify({ line1: '21 Governor St', city: 'Providence', state: 'RI', zip: '02906' }), JSON.stringify(USPS_ADDRESS)]);
  {
    const r = await heal.restoreBouncedUspsStampsOnce({ limit: 10 });
    const s = await state(appB);
    ok(r.restored >= 1 && !!s.app.usps_imported_at && s.cond.status === 'satisfied',
      'PREVIOUS FILES: a stamp the bug wiped is put back from the file’s own audit trail plus the cached USPS answer');
    ok(s.app.property_address.oneLine === USPS_ONE,
      'and the working address goes back to the USPS spelling the human adopted');
    const audited = (await db.query(
      `SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='usps_stamp_restored'`, [appB])).rowCount;
    ok(audited === 1, 'every restore is on the file’s own record');
  }
  {
    const again = await heal.restoreBouncedUspsStampsOnce({ limit: 10 });
    ok(again.restored === 0, 'the repair is idempotent — a restored file stops matching, so it drains');
  }
  // A file whose property genuinely CHANGED is left for a human, never re-stamped
  // with a verification that was about somewhere else.
  const appC = await newFile();
  await importStamp(appC);
  await db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ('staff', NULL, 'usps_verified_address_imported', 'application', $1, '{"status":"verified"}'::jsonb)`, [appC]);
  await db.query(
    `UPDATE applications SET usps_address=NULL, usps_match=NULL, usps_verified_at=NULL, usps_imported_at=NULL,
            property_address=$2::jsonb WHERE id=$1`,
    [appC, JSON.stringify({ line1: '900 Elmwood Ave', city: 'Providence', state: 'RI', zip: '02907', oneLine: '900 Elmwood Ave, Providence, RI 02907' })]);
  {
    const r = await heal.restoreBouncedUspsStampsOnce({ limit: 10 });
    const s = await state(appC);
    ok(!s.app.usps_imported_at && r.restored === 0,
      'a file whose property really changed is left for a human — a stamp is never moved onto a different place');
  }

  await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [b.id]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [b.id]);
  console.log(fail ? `\n${fail} FAILURE(S)` : `\nAll ${pass} USPS address-stability checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

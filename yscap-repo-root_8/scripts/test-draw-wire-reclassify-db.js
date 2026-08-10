#!/usr/bin/env node
'use strict';
/**
 * DRAW WIRE — RE-CLASSIFICATION + the profile entity slot (owner-reported 2026-08-10:
 * "the entity name is the same, but it still shows 'New Entity' … the LLC name should
 * automatically be linked to the profile LLC section — either link it to an existing LLC
 * that is there already or create a new entity slot").
 *
 * THE CLASS UNDER TEST: `name_kind` is stored ONCE at capture, so the db/478 known-entity
 * rule fix — and any later profile change — never reached already-captured wires. The 69
 * Bassett wire (captured 08/05, fix shipped 08/06) kept its fatal 'new_entity' verdict and
 * its operating-agreement condition forever. Real Postgres, transaction + ROLLBACK.
 *
 *   A. the owner's exact case — a stale 'new_entity' row whose entity IS on the profile
 *      re-classifies to known_entity; the auto OA condition is retracted; audit row written.
 *   B. an AUTOFILLED condition (PILOT's own system copy of the profile OA) still retracts —
 *      the copy is retired (superseded), never left floating.
 *   C. a HUMAN's work stands — a human-uploaded document keeps the condition standing
 *      while the verdict still corrects itself.
 *   D. a still-new entity gets its PROFILE SLOT (adopted-stamped, document slots) — and the
 *      adopted stamp keeps it from clearing its own fatal.
 *   E. an ADOPTED entity whose operating agreement is ACCEPTED on its profile slot CLEARS
 *      (the stated intent of the db/400 hold: "whose operating agreement is NOT yet on file").
 *   F. a third-party PERSON's name never becomes a profile "entity".
 *   G. the boot backfill fixes the stale back book, and reclassify is SILENT (no emails).
 *
 * Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-wire-reclassify-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const storage = require('../src/lib/storage');
const drawWire = require('../src/lib/esign/draw-wire');
const drawOa = require('../src/lib/esign/draw-oa');
const llcLib = require('../src/lib/llc');
const borrowerRoutes = require('../src/routes/borrower');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

const madeRefs = [];
async function seedDoc(client, { appId = null, borrowerId, checklistItemId = null, llcId = null, filename, bytes, review = 'accepted', sourceType = 'system', sourceDocumentId = null, uploadedBy = 'staff' }) {
  const saved = await storage.save(Buffer.from(bytes), { filename });
  madeRefs.push(saved.ref);
  const d = (await client.query(
    `INSERT INTO documents (application_id, borrower_id, checklist_item_id, llc_id, filename, content_type,
                            size_bytes, storage_provider, storage_ref, uploaded_by_kind, review_status, is_current, visibility, source_type, source_document_id)
     VALUES ($1,$2,$3,$4,$5,'application/pdf',$6,$7,$8,$9,$10,true,'borrower',$11,$12) RETURNING id`,
    [appId, borrowerId, checklistItemId, llcId, filename, Buffer.from(bytes).length, saved.provider, saved.ref, uploadedBy, review, sourceType, sourceDocumentId])).rows[0];
  return d.id;
}
const drawOaItem = (client, appId) => client.query(
  `SELECT id, status FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`, [appId, drawOa.OA_MARKER(appId)]).then((r) => r.rows[0] || null);
const oaSlotItem = (client, llcId) => client.query(
  `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.llc_id=$1 AND t.code='rtl_llc_opagmt' LIMIT 1`, [llcId]).then((r) => r.rows[0] && r.rows[0].id);
const wireRow = (client, appId) => client.query(
  `SELECT name_kind, name_matches, operating_agreement_item_id FROM draw_wire_instructions WHERE application_id=$1`, [appId]).then((r) => r.rows[0] || null);

// A file whose wire was captured UNDER THE OLD RULE: stored 'new_entity' + the fatal condition.
async function staleWire(client, borrowerId, accountName) {
  const app = (await client.query(
    `INSERT INTO applications (borrower_id, status, program) VALUES ($1,'funded','Fix & Flip w/ Construction') RETURNING id`, [borrowerId])).rows[0].id;
  const itemId = await drawWire.raiseOperatingAgreementCondition(client, app, accountName);
  await client.query(
    `INSERT INTO draw_wire_instructions (application_id, account_name, name_kind, name_matches, operating_agreement_item_id, captured_at)
     VALUES ($1,$2,'new_entity',false,$3,now())`, [app, accountName, itemId]);
  return { app, itemId };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'reclass+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const bor = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Yeshia','Wagshal',$1) RETURNING id`, [uniq])).rows[0].id;

    // ================================================ A. the owner's exact case (69 Bassett)
    // The entity lives on the borrower's LIBRARY (never the linked a.llc_id) — an ordinary,
    // un-adopted library row, exactly the shape db/478 was written for. The wire predates the fix.
    await llcLib.findOrCreateLlc(bor, { llcName: '69 Bassett LLC' }, client);
    const A = await staleWire(client, bor, '69 Bassett LLC');
    ok(!!(await drawOaItem(client, A.app)), 'A0 the stale fatal condition is on the file');
    const beforeNotifs = (await client.query(`SELECT count(*)::int c FROM notifications`)).rows[0].c;

    const rA = await drawWire.reclassifyWire(client, A.app);
    eq(rA.reclassified, true, 'A1 the stale verdict is re-classified');
    eq(rA.kind, 'known_entity', 'A2 the borrower\'s own entity is a KNOWN entity, not a new one');
    const wA = await wireRow(client, A.app);
    eq(wA.name_kind, 'known_entity', 'A3 the stored row now carries the live verdict');
    eq(wA.name_matches, true, 'A4 and it matches — no operating agreement needed');
    eq(await drawOaItem(client, A.app), null, 'A5 the auto operating-agreement condition is retracted');
    eq(wA.operating_agreement_item_id, null, 'A6 the pointer is cleared with it');
    const audit = (await client.query(
      `SELECT 1 FROM audit_log WHERE action='draw_wire_reclassified' AND entity_id=$1`, [A.app])).rows;
    ok(audit.length === 1, 'A7 the change is audited');
    const afterNotifs = (await client.query(`SELECT count(*)::int c FROM notifications`)).rows[0].c;
    eq(afterNotifs, beforeNotifs, 'A8 re-classification is SILENT — no notification rows');
    // Idempotent — a second pass changes nothing further.
    eq((await drawWire.reclassifyWire(client, A.app)).reclassified, false, 'A9 a second pass is a no-op');

    // ================================================ B. an AUTOFILLED condition still retracts
    const beta = (await llcLib.findOrCreateLlc(bor, { llcName: 'Beta Holdings LLC' }, client)).id;
    await borrowerRoutes.generateLlcChecklist(beta, client);
    const betaSlot = await oaSlotItem(client, beta);
    const betaOa = await seedDoc(client, { borrowerId: bor, checklistItemId: betaSlot, llcId: beta, filename: 'Beta-OA.pdf', bytes: 'BETA-OA', review: 'accepted', sourceType: 'staff_upload' });
    const B = await staleWire(client, bor, 'Beta Holdings LLC');
    // PILOT's own head start: the profile OA is copied onto the condition (system copy, pending).
    const fill = await drawOa.autofillFromProfile(client, B.app, null);
    eq(fill.filled, true, 'B0 the profile agreement autofilled onto the condition');
    const itemB = await drawOaItem(client, B.app);
    eq(itemB.status, 'received', 'B1 which bumped the condition to received — the old retract could never touch it');

    const rB = await drawWire.reclassifyWire(client, B.app);
    eq(rB.kind, 'known_entity', 'B2 the entity is known');
    eq(await drawOaItem(client, B.app), null, 'B3 the autofilled condition is retracted anyway — the copy was PILOT\'s own, not a human\'s');
    const retired = (await client.query(
      `SELECT review_status, is_current FROM documents WHERE source_document_id=$1`, [betaOa])).rows[0];
    ok(retired && retired.is_current === false && retired.review_status === 'superseded',
      'B4 PILOT\'s copy is retired (superseded), never left floating as a pending document');

    // ================================================ C. a HUMAN's work stands
    const gamma = (await llcLib.findOrCreateLlc(bor, { llcName: 'Gamma Ventures LLC' }, client)).id;
    void gamma;
    const C = await staleWire(client, bor, 'Gamma Ventures LLC');
    await seedDoc(client, { appId: C.app, borrowerId: bor, checklistItemId: C.itemId, filename: 'Gamma-OA.pdf', bytes: 'GAMMA-OA', review: 'pending', sourceType: 'borrower_upload', uploadedBy: 'borrower' });
    const rC = await drawWire.reclassifyWire(client, C.app);
    eq(rC.kind, 'known_entity', 'C1 the verdict still corrects itself');
    const itemC = await drawOaItem(client, C.app);
    ok(!!itemC, 'C2 but the condition a human worked (their upload) is NEVER deleted');
    const wC = await wireRow(client, C.app);
    eq(String(wC.operating_agreement_item_id), String(itemC.id), 'C3 and the pointer keeps naming it');

    // ================================================ D. a still-new entity gets its PROFILE SLOT
    const D = await staleWire(client, bor, 'Delta Construction LLC');
    const rD = await drawWire.reclassifyWire(client, D.app);
    eq(rD.kind, 'new_entity', 'D1 an entity on nobody\'s profile stays a fatal new entity');
    ok(rD.profile && rD.profile.created === true, 'D2 and its profile entity slot is created (owner-directed 2026-08-10)');
    const deltaRow = (await client.query(
      `SELECT id, adopted_source, adopted_from_application_id, is_verified FROM llcs WHERE borrower_id=$1 AND llc_name='Delta Construction LLC'`, [bor])).rows[0];
    ok(!!deltaRow, 'D3 the entity is on the borrower\'s profile');
    eq(deltaRow.adopted_source, 'draw_wire_form', 'D4 stamped as adopted from the wire form (db/400 — unvetted until documented)');
    eq(String(deltaRow.adopted_from_application_id), String(D.app), 'D5 with the file it came from');
    ok(!!(await oaSlotItem(client, deltaRow.id)), 'D6 its document slots exist (the operating-agreement slot included)');
    ok(!!(await drawOaItem(client, D.app)), 'D7 the fatal condition STAYS — creating the slot never clears the fatal it exists to resolve');
    const rD2 = await drawWire.reclassifyWire(client, D.app);
    eq(rD2.kind, 'new_entity', 'D8 …and the adopted, undocumented entity does not clear the wire on the next pass either');
    eq((await client.query(
      `SELECT count(*)::int c FROM llcs WHERE borrower_id=$1 AND llc_name='Delta Construction LLC'`, [bor])).rows[0].c, 1,
      'D9 a second pass reuses the entity — never a duplicate');

    // ================================================ E. adopted + ACCEPTED OA on the slot clears
    await borrowerRoutes.generateLlcChecklist(deltaRow.id, client);
    const deltaSlot = await oaSlotItem(client, deltaRow.id);
    await seedDoc(client, { borrowerId: bor, checklistItemId: deltaSlot, llcId: deltaRow.id, filename: 'Delta-OA.pdf', bytes: 'DELTA-OA', review: 'accepted', sourceType: 'staff_upload' });
    const rE = await drawWire.reclassifyWire(client, D.app);
    eq(rE.kind, 'known_entity', 'E1 once its operating agreement is ACCEPTED on the profile slot, the adopted entity clears (the db/400 hold\'s stated intent)');
    eq(await drawOaItem(client, D.app), null, 'E2 and the fatal condition retracts');

    // Control: adopted + only a PENDING (undecided) OA does NOT clear.
    const F0 = await staleWire(client, bor, 'Echo Estates LLC');
    const rF0 = await drawWire.reclassifyWire(client, F0.app);
    eq(rF0.kind, 'new_entity', 'E3 (setup) Echo starts new');
    const echoRow = (await client.query(`SELECT id FROM llcs WHERE borrower_id=$1 AND llc_name='Echo Estates LLC'`, [bor])).rows[0];
    const echoSlot = await oaSlotItem(client, echoRow.id);
    await seedDoc(client, { borrowerId: bor, checklistItemId: echoSlot, llcId: echoRow.id, filename: 'Echo-OA.pdf', bytes: 'ECHO-OA', review: 'pending', sourceType: 'staff_upload' });
    eq((await drawWire.reclassifyWire(client, F0.app)).kind, 'new_entity', 'E4 a merely-PENDING agreement clears nothing — accepted only');

    // ================================================ F. a person's name never becomes an "entity"
    const F = await staleWire(client, bor, 'John Stranger');
    const rF = await drawWire.reclassifyWire(client, F.app);
    eq(rF.kind, 'new_entity', 'F1 a third-party personal name stays a fatal');
    ok(!rF.profile || rF.profile.linked !== true, 'F2 and no profile entity is created for it');
    eq((await client.query(
      `SELECT count(*)::int c FROM llcs WHERE borrower_id=$1 AND llc_name ILIKE '%stranger%'`, [bor])).rows[0].c, 0,
      'F3 the library carries no "John Stranger" entity');

    // ================================================ G. the boot backfill fixes the back book
    const G = await staleWire(client, bor, '69 Bassett, L.L.C.');   // punctuation variant still matches
    const bf = await drawWire.backfillWireReclassifyOnce({ db: client, limit: 50 });
    ok(bf.scanned >= 1, 'G1 the backfill scans the stored new-entity rows');
    const wG = await wireRow(client, G.app);
    eq(wG.name_kind, 'known_entity', 'G2 the stale back-book row is fixed at boot');
    eq(await drawOaItem(client, G.app), null, 'G3 and its condition retracted');

    await client.query('ROLLBACK');
    console.log(`test-draw-wire-reclassify-db: all ${n} checks passed.`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('FATAL', e);
    process.exitCode = 1;
  } finally {
    // The DB rolls back; the storage objects do not — clean them up.
    for (const ref of madeRefs) { try { await storage.remove(ref); } catch (_) {} }
    client.release();
    await pool.end();
  }
})();

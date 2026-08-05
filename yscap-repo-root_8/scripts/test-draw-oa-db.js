#!/usr/bin/env node
'use strict';
/**
 * DRAW WIRE — OPERATING-AGREEMENT SLOT + LLC-PROFILE LINK, end to end (Task 5, owner-directed
 * 2026-08-05). Real Postgres, runs in a transaction and ROLLS BACK.
 *
 * The owner's flow, proven step by step:
 *   1. AUTOFILL — the wire names an entity the borrower already has on his profile with an operating
 *      agreement on file, so that agreement is pulled onto the draw operating-agreement condition.
 *   2. ON ACCEPT (new entity) — accepting the agreement OPENS the entity on the profile and saves
 *      the agreement into the entity's own operating-agreement slot.
 *   3. ON ACCEPT (existing entity) — a matching profile entity is REUSED, never duplicated.
 *   4. INVESTOR ATTACH — the accepted agreement is the one that rides the investor email.
 *
 * Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-oa-db (no DATABASE_URL)'); process.exit(0); }
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
async function seedDoc(client, { appId, borrowerId, checklistItemId = null, llcId = null, filename, bytes, review = 'accepted', docKind = null }) {
  const saved = await storage.save(Buffer.from(bytes), { filename });
  madeRefs.push(saved.ref);
  const d = (await client.query(
    `INSERT INTO documents (application_id, borrower_id, checklist_item_id, llc_id, filename, content_type,
                            size_bytes, storage_provider, storage_ref, uploaded_by_kind, review_status, is_current, doc_kind, visibility, source_type)
     VALUES ($1,$2,$3,$4,$5,'application/pdf',$6,$7,$8,'staff',$9,true,$10,'borrower','system') RETURNING id`,
    [appId, borrowerId, checklistItemId, llcId, filename, Buffer.from(bytes).length, saved.provider, saved.ref, review, docKind])).rows[0];
  return d.id;
}
const drawOaItem = (client, appId) => client.query(
  `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`, [appId, drawOa.OA_MARKER(appId)]).then((r) => r.rows[0] && r.rows[0].id);
const oaSlotItem = (client, llcId) => client.query(
  `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.llc_id=$1 AND t.code='rtl_llc_opagmt' LIMIT 1`, [llcId]).then((r) => r.rows[0] && r.rows[0].id);
const docsOn = (client, itemId) => client.query(
  `SELECT id, review_status FROM documents WHERE checklist_item_id=$1 AND is_current`, [itemId]).then((r) => r.rows);

async function setupFile(client, borrowerId, accountName) {
  const app = (await client.query(
    `INSERT INTO applications (borrower_id, status, program) VALUES ($1,'funded','Fix & Flip w/ Construction') RETURNING id`, [borrowerId])).rows[0].id;
  await drawWire.raiseOperatingAgreementCondition(client, app, accountName);
  await client.query(
    `INSERT INTO draw_wire_instructions (application_id, account_name, name_kind, name_matches, captured_at)
     VALUES ($1,$2,'new_entity',false,now())`, [app, accountName]);
  return app;
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'drawoa+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const bor = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Jane','Owner',$1) RETURNING id`, [uniq])).rows[0].id;
    const staff = (await client.query(
      `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Draw Coordinator','draw_coordinator') RETURNING id`, ['staff+' + uniq])).rows[0].id;

    // ============================================================ A. AUTOFILL from the profile
    // The borrower already has "Beta Holdings LLC" with an ACCEPTED operating agreement.
    const beta = (await llcLib.findOrCreateLlc(bor, { llcName: 'Beta Holdings LLC' }, client)).id;
    await borrowerRoutes.generateLlcChecklist(beta, client);
    const betaSlot = await oaSlotItem(client, beta);
    ok(!!betaSlot, 'A0 the profile entity has an operating-agreement slot');
    await seedDoc(client, { borrowerId: bor, checklistItemId: betaSlot, llcId: beta, filename: 'Beta-OA.pdf', bytes: 'BETA-OPERATING-AGREEMENT', review: 'accepted' });

    // A draw whose wire names that same entity (full legal description — must still match).
    const appA = await setupFile(client, bor, 'Beta Holdings LLC, A New York Limited Liability Company');
    const itemA = await drawOaItem(client, appA);
    ok(!!itemA, 'A1 the draw operating-agreement condition exists');
    eq((await docsOn(client, itemA)).length, 0, 'A2 it starts empty');

    const fill = await drawOa.autofillFromProfile(client, appA, staff);
    eq(fill.filled, true, 'A3 the profile agreement is pulled onto the condition');
    eq(fill.fromLlcId, String(beta), 'A4 it came from the borrower\'s matching entity');
    const afterFill = await docsOn(client, itemA);
    eq(afterFill.length, 1, 'A5 the condition now carries the agreement');

    // Idempotent — a second autofill does not stack a duplicate.
    const fill2 = await drawOa.autofillFromProfile(client, appA, staff);
    eq(fill2.filled, false, 'A6 a second autofill does nothing');
    eq((await docsOn(client, itemA)).length, 1, 'A7 still exactly one document');

    // No matching entity → nothing pulled (never guessed onto the condition).
    const appNone = await setupFile(client, bor, 'Zeta Unknown LLC');
    eq((await drawOa.autofillFromProfile(client, appNone, staff)).filled, false, 'A8 an unknown entity pulls nothing');
    eq((await drawOa.autofillFromProfile(client, appNone, staff)).reason, 'no_matching_profile_entity', 'A9 and says why');

    // ============================================================ B. ON ACCEPT — a brand-new entity
    const appB = await setupFile(client, bor, 'Gamma Ventures LLC, A Delaware Limited Liability Company');
    const itemB = await drawOaItem(client, appB);
    const oaB = await seedDoc(client, { appId: appB, borrowerId: bor, checklistItemId: itemB, filename: 'Gamma-OA.pdf', bytes: 'GAMMA-OPERATING-AGREEMENT', review: 'accepted', docKind: null });

    const before = (await client.query(`SELECT count(*)::int n FROM llcs WHERE borrower_id=$1 AND lower(llc_name) LIKE 'gamma%'`, [bor])).rows[0].n;
    eq(before, 0, 'B0 the borrower has no Gamma entity yet');

    const adopt = await drawOa.onAccepted(client, { itemId: itemB, documentId: oaB, actorId: staff });
    eq(adopt.adopted, true, 'B1 accepting the agreement adopts the entity');
    eq(adopt.created, true, 'B2 a new entity was created');
    eq(adopt.savedToSlot, true, 'B3 the agreement was saved into the entity\'s own slot');

    const gamma = (await client.query(
      `SELECT id, llc_name, borrower_id, adopted_source, adopted_from_application_id FROM llcs WHERE id=$1`, [adopt.llcId])).rows[0];
    eq(gamma.llc_name, 'Gamma Ventures LLC', 'B4 created under the CLEAN name, not the full legal description');
    eq(gamma.borrower_id, bor, 'B5 it hangs off the borrower\'s profile');
    eq(gamma.adopted_source, 'draw_wire_form', 'B6 stamped as adopted from the wire form');
    eq(gamma.adopted_from_application_id, appB, 'B7 recording which file it came from');

    // the many-to-many ownership link exists too
    const linked = (await client.query(`SELECT 1 FROM llc_borrowers WHERE llc_id=$1 AND borrower_id=$2`, [gamma.id, bor])).rows[0];
    ok(!!linked, 'B8 the borrower is linked as an owner');

    // the agreement is on the entity's operating-agreement slot, with its OWN bytes (not shared)
    const gammaSlot = await oaSlotItem(client, gamma.id);
    const slotDocs = await docsOn(client, gammaSlot);
    eq(slotDocs.length, 1, 'B9 the entity\'s operating-agreement slot now holds the agreement');
    const slotDocId = slotDocs[0].id;
    const srcRef = (await client.query(`SELECT storage_ref FROM documents WHERE id=$1`, [oaB])).rows[0].storage_ref;
    const slotRef = (await client.query(`SELECT storage_ref, source_document_id FROM documents WHERE id=$1`, [slotDocId])).rows[0];
    ok(slotRef.storage_ref !== srcRef, 'B10 the slot copy has its OWN storage object (bytes copied, not shared)');
    eq(slotRef.source_document_id, oaB, 'B11 the copy records its lineage back to the draw-condition document');

    // idempotent — accepting again adopts nothing new and never duplicates the slot document
    const adopt2 = await drawOa.onAccepted(client, { itemId: itemB, documentId: oaB, actorId: staff });
    eq(adopt2.created, false, 'B12 a second accept does not create a second entity');
    eq((await docsOn(client, gammaSlot)).length, 1, 'B13 the slot still holds exactly one agreement');

    // ============================================================ C. ON ACCEPT — an EXISTING entity is reused
    const appC = await setupFile(client, bor, 'Beta Holdings, L.L.C.');   // matches the profile Beta (punctuation variant)
    const itemC = await drawOaItem(client, appC);
    const oaC = await seedDoc(client, { appId: appC, borrowerId: bor, checklistItemId: itemC, filename: 'Beta-OA-2.pdf', bytes: 'BETA-OA-AGAIN', review: 'accepted' });
    const adoptC = await drawOa.onAccepted(client, { itemId: itemC, documentId: oaC, actorId: staff });
    eq(adoptC.adopted, true, 'C1 accepting adopts');
    eq(adoptC.created, false, 'C2 the existing Beta entity is REUSED, never duplicated');
    eq(adoptC.llcId, String(beta), 'C3 it links the very entity already on the profile');
    const betaCount = (await client.query(`SELECT count(*)::int n FROM llcs WHERE borrower_id=$1 AND lower(btrim(llc_name))='beta holdings llc'`, [bor])).rows[0].n;
    eq(betaCount, 1, 'C4 there is still only one Beta Holdings LLC on the profile');

    // ============================================================ D. INVESTOR ATTACH — only the accepted agreement
    const oaForInv = await drawOa.acceptedOaForInvestor(client, appB);
    ok(!!oaForInv && oaForInv.id === oaB, 'D1 the accepted agreement is the one offered to the investor email');
    // a condition whose agreement is NOT accepted offers nothing
    await client.query(`UPDATE documents SET review_status='pending' WHERE id=$1`, [oaB]);
    eq(await drawOa.acceptedOaForInvestor(client, appB), null, 'D2 an unaccepted agreement is never offered to the investor');
    await client.query(`UPDATE documents SET review_status='accepted' WHERE id=$1`, [oaB]);
    // a file with no draw OA condition offers nothing
    const appPlain = (await client.query(`INSERT INTO applications (borrower_id, status) VALUES ($1,'funded') RETURNING id`, [bor])).rows[0].id;
    eq(await drawOa.acceptedOaForInvestor(client, appPlain), null, 'D3 a file with no wire OA condition offers nothing');

    // ============================================================ E. guards
    eq((await drawOa.onAccepted(client, { itemId: itemB, documentId: oaB, actorId: staff })).adopted, true, 'E1 onAccepted is safe to re-run');
    // a non-draw-OA checklist item is not adopted
    const someItem = (await client.query(`SELECT id FROM checklist_items WHERE application_id=$1 AND field_key <> $2 LIMIT 1`, [appB, drawOa.OA_MARKER(appB)])).rows[0];
    if (someItem) eq((await drawOa.onAccepted(client, { itemId: someItem.id, documentId: oaB, actorId: staff })).reason, 'not_the_draw_oa_condition', 'E2 a non-OA condition is never adopted');

    await client.query('ROLLBACK');
    console.log(`test-draw-oa-db: all ${n} checks passed.`);
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

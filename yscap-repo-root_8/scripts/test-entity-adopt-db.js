#!/usr/bin/env node
'use strict';
/**
 * DB test for the ENTITY-ADOPTION flow (owner-directed 2026-08-02) against a REAL Postgres.
 *
 * The scenario is the owner's, exactly: a bank statement in the assets condition is held by
 * "Beta Holdings LLC", an entity the borrower has no documents for — and the operating agreement
 * for that same entity was uploaded alongside the statements, which is what usually happens. One
 * click must:
 *   1. put "Beta Holdings LLC" on the borrower's profile with its own document slots,
 *   2. carry that operating agreement onto the entity's OPERATING AGREEMENT slot — with its OWN
 *      bytes, so purging the loan file can never take the profile's copy with it,
 *   3. post the entity-documents condition on the file,
 *   4. settle the finding, recording what was done,
 *   5. and NOT let the entity's balance count toward liquidity until that proof was there.
 * Pressing the button twice must change nothing.
 *
 * Runs in a transaction and ROLLS BACK. Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-entity-adopt-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const ea = require('../src/lib/underwriting/entity-adopt');
const fileView = require('../src/lib/underwriting/file-view');
const { assessBankLiquidity } = require('../src/lib/underwriting/bank-liquidity');
const storage = require('../src/lib/storage');

const ENTITY = 'Beta Holdings LLC';

async function seedDoc(client, { appId, borrowerId, filename, bytes }) {
  const saved = await storage.save(Buffer.from(bytes), { filename });
  const d = (await client.query(
    `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                            storage_provider, storage_ref, uploaded_by_kind)
     VALUES ($1,$2,$3,'application/pdf',$4,$5,$6,'borrower') RETURNING id`,
    [appId, borrowerId, filename, Buffer.from(bytes).length, saved.provider, saved.ref])).rows[0];
  return { id: d.id, ref: saved.ref };
}
async function seedExtraction(client, { appId, borrowerId, documentId, docType, fields }) {
  await client.query(
    `INSERT INTO document_extractions (document_id, application_id, borrower_id, doc_type, fields, status)
     VALUES ($1,$2,$3,$4,$5::jsonb,'analyzed')`,
    [documentId, appId, borrowerId, docType, JSON.stringify(fields)]);
}
const slotDocs = async (client, llcId, code) => (await client.query(
  `SELECT d.id, d.storage_ref, d.sha256, d.source_document_id, d.visibility, d.review_status, ci.status AS item_status
     FROM checklist_items ci
     JOIN checklist_templates t ON t.id = ci.template_id
     LEFT JOIN documents d ON d.checklist_item_id = ci.id AND d.is_current
    WHERE ci.llc_id=$1 AND t.code=$2`, [llcId, code])).rows.filter((r) => r.id);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const madeRefs = [];   // storage objects to clean up (the DB rolls back; the disk does not)
  try {
    await client.query('BEGIN');
    const uniq = 'adopt+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('John','Smith',$1) RETURNING id`, [uniq])).rows[0];
    const app = (await client.query(
      `INSERT INTO applications (borrower_id, program) VALUES ($1,'Fix & Flip w/ Construction') RETURNING id`, [b.id])).rows[0];
    const staff = (await client.query(
      `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Test Underwriter','underwriter') RETURNING id`,
      ['staff+' + uniq])).rows[0];

    // The assets condition carries BOTH: the bank statement AND the entity's operating agreement.
    const stmt = await seedDoc(client, { appId: app.id, borrowerId: b.id, filename: 'statement.pdf', bytes: 'STATEMENT-BYTES' });
    const oa = await seedDoc(client, { appId: app.id, borrowerId: b.id, filename: 'Operating Agreement.pdf', bytes: 'OPERATING-AGREEMENT-BYTES' });
    madeRefs.push(stmt.ref, oa.ref);
    await seedExtraction(client, { appId: app.id, borrowerId: b.id, documentId: stmt.id, docType: 'bank_statement',
      fields: { accountHolderName: ENTITY, holderIsBusiness: true, closingBalance: 250000, bankName: 'Chase' } });
    await seedExtraction(client, { appId: app.id, borrowerId: b.id, documentId: oa.id, docType: 'operating_agreement',
      fields: { entityLegalName: 'Beta Holdings, L.L.C.', managingMember: 'John Smith', signed: true } });

    // ---- 0. BEFORE: the entity is a stranger; its money does not count. --------------------
    let ctx = await fileView.loadContext(client, app.id);
    assert.ok(!ctx.entityNames.includes(ENTITY), 'the entity is not on the profile yet');
    assert.ok(ctx.entityDocNames.some((n) => /Beta Holdings/i.test(n)),
      'but PILOT already SEES the operating agreement on the file — the finding points at it');
    const exts = (await client.query(
      `SELECT document_id, doc_type, fields, created_at FROM document_extractions
        WHERE application_id=$1 AND doc_type='bank_statement' AND is_current`, [app.id])).rows;
    assert.strictEqual(assessBankLiquidity(ctx, exts, {}).qualifyingTotal, 0, 'a stranger entity’s balance never counted');

    // ---- 1. THE CLICK ---------------------------------------------------------------------
    const res = await ea.adoptEntityToProfile(client, {
      appId: app.id, entityName: ENTITY, actorId: staff.id, postCondition: true });
    assert.strictEqual(res.created, true, 'the entity was created on the profile');
    assert.strictEqual(res.entityName, ENTITY);

    const llc = (await client.query(
      `SELECT id, llc_name, borrower_id, adopted_at, adopted_from_application_id, adopted_source, is_verified
         FROM llcs WHERE id=$1`, [res.llcId])).rows[0];
    assert.strictEqual(llc.borrower_id, b.id, 'it hangs off the borrower’s profile — his record, for good');
    assert.ok(llc.adopted_at, 'and it is stamped as PILOT-adopted, which is what holds its funds back');
    assert.strictEqual(llc.adopted_from_application_id, app.id);
    assert.strictEqual(llc.adopted_source, 'bank_statement_finding');
    assert.strictEqual(llc.is_verified, false, 'adopting never verifies an entity');

    // Its three document slots exist (formation / EIN / operating agreement).
    const slots = (await client.query(
      `SELECT t.code FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.llc_id=$1 ORDER BY t.sort_order`, [res.llcId])).rows.map((r) => r.code);
    for (const code of ['rtl_llc_formation', 'rtl_llc_ein', 'rtl_llc_opagmt']) {
      assert.ok(slots.includes(code), `the entity got its ${code} slot`);
    }

    // ---- 2. THE OPERATING AGREEMENT LANDED ON THE ENTITY, WITH ITS OWN BYTES --------------
    assert.strictEqual(res.carried.length, 1, 'exactly the operating agreement was carried');
    assert.strictEqual(res.carried[0].docType, 'operating_agreement');
    const onSlot = await slotDocs(client, res.llcId, 'rtl_llc_opagmt');
    assert.strictEqual(onSlot.length, 1, 'the OA slot holds one document');
    madeRefs.push(onSlot[0].storage_ref);
    assert.strictEqual(onSlot[0].source_document_id, oa.id, 'it records which file document it came from');
    assert.notStrictEqual(onSlot[0].storage_ref, oa.ref,
      'THE BYTES ARE ITS OWN — purging the loan file deletes the file copy’s bytes, and a shared ref would take the profile’s copy with it');
    const copied = await storage.read(onSlot[0].storage_ref);
    assert.strictEqual(copied.toString(), 'OPERATING-AGREEMENT-BYTES', 'and they are the same document, byte for byte');
    assert.strictEqual(onSlot[0].visibility, 'borrower', 'it is visible in the entity section (getSlots requires this)');
    assert.strictEqual(onSlot[0].review_status, 'pending', 'NOT auto-accepted — a human still confirms who controls the entity');
    assert.strictEqual(onSlot[0].item_status, 'received', 'the slot reads as “document in, awaiting review”');
    // The file's own copy is untouched — the assets condition keeps its record.
    const srcStill = (await client.query(`SELECT id, is_current, checklist_item_id FROM documents WHERE id=$1`, [oa.id])).rows[0];
    assert.strictEqual(srcStill.is_current, true, 'the loan file’s copy is COPIED, never moved away');

    // ---- 3. THE CONDITION ------------------------------------------------------------------
    assert.ok(res.conditionId, 'the entity-documents condition was posted');
    assert.strictEqual(res.conditionExisted, false);
    const cond = (await client.query(
      `SELECT ci.status, ci.notes, ci.audience, t.code FROM checklist_items ci
         JOIN checklist_templates t ON t.id=ci.template_id WHERE ci.id=$1`, [res.conditionId])).rows[0];
    assert.strictEqual(cond.code, ea.ENTITY_DOCS_TEMPLATE_CODE);
    assert.strictEqual(cond.status, 'outstanding', 'a brand-new ask, not the red “we sent this back” bucket');
    assert.match(cond.notes, /Beta Holdings LLC/, 'the note names the entity it is about');

    // ---- 4. THE MONEY STILL DOES NOT COUNT UNTIL THE PROOF IS ACCEPTED --------------------
    // The entity is on the profile now, so the naive read is "its balance counts". It must not:
    // the adoption stamp keeps it excluded until an entity document is actually on the entity.
    // Here one IS (we just carried it), so it releases — and that is the correct, documented state.
    ctx = await fileView.loadContext(client, app.id);
    assert.ok(ctx.entityNames.includes(ENTITY), 'the entity is on the profile now');
    assert.deepStrictEqual(ctx.entityDocsPendingNames, [],
      'with its operating agreement on file the hold releases itself — no second click needed');
    assert.strictEqual(assessBankLiquidity(ctx, exts, {}).qualifyingTotal, 250000,
      'and the documented entity’s balance now counts');

    // The other half of the guard: an entity adopted with NOTHING behind it stays excluded.
    const bare = await ea.adoptEntityToProfile(client, {
      appId: app.id, entityName: 'Gamma Ventures LLC', actorId: staff.id, postCondition: false });
    assert.strictEqual(bare.carried.length, 0, 'no documents for it on the file');
    const ctx2 = await fileView.loadContext(client, app.id);
    assert.deepStrictEqual(ctx2.entityDocsPendingNames, ['Gamma Ventures LLC'],
      'an entity with no ownership proof is held out of the liquidity total');
    const bareStmt = [{ doc_type: 'bank_statement', document_id: 'x',
      fields: { accountHolderName: 'Gamma Ventures LLC', holderIsBusiness: true, closingBalance: 900000 } }];
    const bareRes = assessBankLiquidity(ctx2, bareStmt, {});
    assert.strictEqual(bareRes.qualifyingTotal, 0, 'ONE CLICK MUST NOT CREATE $900,000 OF PROVABLE LIQUIDITY');
    assert.strictEqual(bareRes.excludedTotal, 900000, 'it shows in the excluded column, which explains itself');

    // ---- 5. PRESSING THE BUTTON TWICE CHANGES NOTHING -------------------------------------
    const again = await ea.adoptEntityToProfile(client, {
      appId: app.id, entityName: ENTITY, actorId: staff.id, postCondition: true });
    assert.strictEqual(again.llcId, res.llcId, 'the same entity is REUSED, never duplicated');
    assert.strictEqual(again.created, false);
    assert.strictEqual(again.carried.length, 0, 'nothing is carried a second time');
    assert.ok((again.skipped || []).some((s) => s.reason === 'already_on_this_slot'),
      'and it says why — the agreement is already on the slot');
    assert.strictEqual(again.conditionExisted, true, 'the condition is not stacked twice');
    assert.strictEqual((await slotDocs(client, res.llcId, 'rtl_llc_opagmt')).length, 1, 'still exactly one document on the slot');
    assert.strictEqual((await client.query(
      `SELECT count(*)::int n FROM llcs WHERE borrower_id=$1 AND lower(llc_name)=lower($2)`,
      [b.id, ENTITY])).rows[0].n, 1, 'still exactly one entity of that name');
    // A second click reaches the same conclusion about the finding as the first.
    assert.strictEqual(ea.ownershipProofLanded(again), true, 'the proof is still on the profile');

    // ---- 6. A NAME THE BORROWER ALREADY HAS IS ADOPTED, NOT STAMPED -----------------------
    // An entity a human already put on the profile is theirs; stamping it would wrongly freeze its
    // funds. findOrCreateLlc reuses it and the stamp is left alone.
    const human = (await client.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'Human Typed LLC') RETURNING id`, [b.id])).rows[0];
    const reuse = await ea.adoptEntityToProfile(client, {
      appId: app.id, entityName: 'Human Typed LLC', actorId: staff.id, postCondition: false });
    assert.strictEqual(reuse.llcId, String(human.id), 'the borrower’s own entity is reused');
    assert.strictEqual(reuse.created, false);
    assert.strictEqual((await client.query(`SELECT adopted_at FROM llcs WHERE id=$1`, [human.id])).rows[0].adopted_at, null,
      'a human’s own entity is NEVER stamped as adopted — its funds must not be held back');

    // ---- 7. THE ARC THE OWNER DESCRIBED, END TO END ---------------------------------------
    // Before the click the statement raises "different entity — verify the ownership documents
    // already on file"; after it, the SAME statement raises the milder "entity is on file but not
    // verified yet", which is the nudge to finish the LLC section. The finding does not vanish and
    // is not replaced by silence: the file keeps asking until the entity is actually established.
    const { computeBankFindings } = require('../src/lib/underwriting/bank-statement-checks');
    const stmtFields = { accountHolderName: ENTITY, holderIsBusiness: true, closingBalance: 250000 };
    const ctxFresh = await fileView.loadContext(client, app.id);
    const after = computeBankFindings(stmtFields, fileView.subjectFor('bank_statement', ctxFresh));
    assert.ok(!after.some((f) => f.code === 'bank_account_other_entity'),
      'the “different entity” finding stops firing once the entity is on the borrower’s record');
    const nudge = after.find((f) => f.code === 'bank_business_entity_unverified');
    assert.ok(nudge, 'and is replaced by “on file but not verified yet” — finish the LLC section');
    assert.strictEqual(nudge.severity, 'warning');
    assert.strictEqual(nudge.blocksCtc, false, 'still advisory — adopting an entity never blocks a file');

    // A STORED finding row (what production actually has — document_findings keeps the holder in
    // doc_value, not an entityName column) still offers the button.
    const storedShape = { code: 'bank_account_other_entity', doc_value: ENTITY, severity: 'warning' };
    assert.strictEqual(ea.adoptTargetOf(storedShape).entityName, ENTITY,
      'the button is derived from what a stored finding really carries');

    // ---- 8. A VERIFIED ENTITY IS LEFT ALONE ------------------------------------------------
    // Its documents are the basis of a sign-off somebody made — the portal already refuses an
    // upload into a verified entity's slots, and this path must not become the way around that.
    await client.query(`UPDATE llcs SET is_verified=true WHERE id=$1`, [res.llcId]);
    await client.query(`DELETE FROM documents WHERE llc_id=$1`, [res.llcId]);   // slot emptied on purpose
    const onVerified = await ea.adoptEntityToProfile(client, {
      appId: app.id, entityName: ENTITY, actorId: staff.id, postCondition: false });
    assert.strictEqual(onVerified.carried.length, 0, 'nothing is written into a verified entity');
    assert.ok(onVerified.skipped.some((s) => s.reason === 'entity_already_verified'), 'and it says exactly why');
    assert.strictEqual((await slotDocs(client, res.llcId, 'rtl_llc_opagmt')).length, 0, 'the slot really was left untouched');
    await client.query(`UPDATE llcs SET is_verified=false WHERE id=$1`, [res.llcId]);

    // ---- 9. REFUSALS ----------------------------------------------------------------------
    await assert.rejects(() => ea.adoptEntityToProfile(client, { appId: app.id, entityName: '   ', actorId: staff.id }),
      /entity name is empty/, 'a nameless entity is refused, never created');
    await assert.rejects(() => ea.adoptEntityToProfile(client, { entityName: ENTITY, actorId: staff.id }),
      /appId required/);

    await client.query('ROLLBACK');
    console.log('OK test-entity-adopt-db');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAIL test-entity-adopt-db:', e && e.message);
    process.exitCode = 1;
  } finally {
    for (const ref of madeRefs) { try { await storage.remove(ref); } catch (_) { /* best-effort */ } }
    client.release();
    await pool.end();
  }
})();

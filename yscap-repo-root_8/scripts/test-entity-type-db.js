#!/usr/bin/env node
'use strict';
/**
 * THE ENTITY TYPE, against a REAL Postgres (owner-directed 2026-08-09).
 *
 * A pure test cannot prove any of this: every claim here is about a column, a
 * CHECK constraint, a migration that re-runs on every boot, or a guard that
 * decides whether one row may overwrite another.
 *
 * The owner's own rules, in their order:
 *   A. "everything created till now should automatically be default LLC" — and it
 *      is recorded as ASSUMED, not chosen, because "we assumed" and "a person
 *      said so" are different facts and only one is safe to print on a mortgage.
 *   B. "only going forward this change to go in effect" — a door that states a
 *      type records it; a door that says nothing files an assumption.
 *   C. "re-label the operating agreement slot for bylaws and stock certificate,
 *      and this change needs to be everywhere else — SharePoint syncing, TPR
 *      export and everywhere else": the wording rides the ITEM, which is what
 *      both of those read, and it SURVIVES A BOOT (db/033 copies the shared
 *      template's wording back down on every deploy).
 *   D. "each owner's title … a drop-down … only for the staff side to fill out":
 *      staff may set it, the borrower's door ignores it, and a borrower's own
 *      edit must not wipe what the closer typed.
 *   E. the closing-desk nudge: which owners still have no title.
 *
 * Runs in a transaction and ROLLS BACK. Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-entity-type-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const { Pool } = require('pg');
const ET = require('../src/lib/entity-type');

let pass = 0;
const ok = (what) => { pass++; console.log('  ✓', what); };

async function seedBorrower(c, email) {
  return (await c.query(
    `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Test','Owner',$1) RETURNING id`,
    [email])).rows[0].id;
}

/** Build an entity's three document slots the way generateLlcChecklist does. */
async function seedSlots(c, llcId) {
  await c.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
        phase, hint, borrower_hint, sort_order, created_by_kind, llc_id)
     SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
            COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
            COALESCE(t.sort_order,100), 'system', $1
       FROM checklist_templates t
      WHERE t.scope = 'llc' AND t.is_active = true
        AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.llc_id = $1 AND ci.template_id = t.id)`,
    [llcId]);
}
const slotOf = async (c, llcId, code) => (await c.query(
  `SELECT ci.label, ci.borrower_label, ci.hint, ci.borrower_hint
     FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
    WHERE ci.llc_id = $1 AND t.code = $2`, [llcId, code])).rows[0];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  await c.query('BEGIN');
  // Every helper below is handed this connection, so nothing escapes the rollback.
  const llcLib = require('../src/lib/llc');

  try {
    /* ───────────── A. the back book ───────────── */
    console.log('\nA. everything created till now is an LLC — and says it was assumed');
    const bor = await seedBorrower(c, `entity-type-${Date.now()}@test.local`);
    const back = (await c.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'Back Book Holdings LLC') RETURNING id, entity_type, entity_type_confirmed`,
      [bor])).rows[0];
    assert.strictEqual(back.entity_type, 'llc');
    assert.strictEqual(back.entity_type_confirmed, false,
      'a row nobody chose a type for must NOT read as confirmed');
    ok('an entity created with no type stated is an LLC, recorded as not confirmed');

    // The column refuses anything outside the four types, so an unknown value can
    // never be stored and silently behave as something.
    let refused = false;
    await c.query('SAVEPOINT s1');
    try { await c.query(`UPDATE llcs SET entity_type='sole proprietorship' WHERE id=$1`, [back.id]); }
    catch (e) { refused = e.code === '23514'; }
    await c.query('ROLLBACK TO SAVEPOINT s1');
    assert.ok(refused, 'the CHECK must refuse a type outside the four');
    ok('a type outside the four is refused by the database, not stored');

    /* ───────────── B. going forward ───────────── */
    console.log('\nB. a door that states a type records it — one that does not, does not');
    const madeCorp = await llcLib.findOrCreateLlc(bor, { llcName: 'Stated Corp Inc', entityType: 'Corporation (Inc / S-Corp)' }, c);
    const corpRow = (await c.query(`SELECT entity_type, entity_type_confirmed, entity_type_set_at FROM llcs WHERE id=$1`, [madeCorp.id])).rows[0];
    assert.strictEqual(corpRow.entity_type, 'corporation');
    assert.strictEqual(corpRow.entity_type_confirmed, true);
    assert.ok(corpRow.entity_type_set_at, 'a chosen type records WHEN it was chosen');
    ok('a stated type is filed as chosen, with the moment it was chosen');

    // A typo must read as an unanswered question, never as an LLC somebody vouched for.
    const madeJunk = await llcLib.findOrCreateLlc(bor, { llcName: 'Typo Holdings', entityType: 'sole propietorship' }, c);
    const junkRow = (await c.query(`SELECT entity_type, entity_type_confirmed FROM llcs WHERE id=$1`, [madeJunk.id])).rows[0];
    assert.strictEqual(junkRow.entity_type, 'llc');
    assert.strictEqual(junkRow.entity_type_confirmed, false, 'a typo must not be filed as a confirmed choice');
    ok('an unreadable type is filed as an assumption, never as a choice');

    // A BLANK is the same — and it is the case the pure test caught: normalizeKey
    // falls back to 'llc' on a blank, so a naive check reads an empty form box as
    // somebody choosing LLC.
    const madeBlank = await llcLib.findOrCreateLlc(bor, { llcName: 'Blank Holdings LLC', entityType: '' }, c);
    assert.strictEqual((await c.query(`SELECT entity_type_confirmed FROM llcs WHERE id=$1`, [madeBlank.id])).rows[0].entity_type_confirmed,
      false, 'an empty box must never read as a choice');
    ok('an empty answer is filed as an assumption, not as somebody choosing LLC');

    /* ───────────── the three guards on confirming later ───────────── */
    console.log('\nB2. a type stated later records only where it is safe to');
    const r1 = await llcLib.confirmEntityType(back.id, 'trust', { client: c });
    assert.strictEqual(r1.changed, true);
    assert.strictEqual((await c.query(`SELECT entity_type FROM llcs WHERE id=$1`, [back.id])).rows[0].entity_type, 'trust');
    ok('an entity nobody had confirmed takes the type a person states');

    const r2 = await llcLib.confirmEntityType(back.id, 'corporation', { client: c });
    assert.strictEqual(r2.changed, false, 'a type somebody already chose must not be overwritten by another door');
    assert.strictEqual((await c.query(`SELECT entity_type FROM llcs WHERE id=$1`, [back.id])).rows[0].entity_type, 'trust');
    ok('a confirmed type is never re-typed by a later door');

    const verified = (await c.query(
      `INSERT INTO llcs (borrower_id, llc_name, is_verified) VALUES ($1,'Verified Holdings LLC', true) RETURNING id`,
      [bor])).rows[0];
    const r3 = await llcLib.confirmEntityType(verified.id, 'corporation', { client: c });
    assert.strictEqual(r3.changed, false, 'a VERIFIED entity is settled by evidence — a dropdown must not relabel it');
    ok('a verified entity is never relabelled by a re-typed name on some other file');

    assert.strictEqual((await llcLib.confirmEntityType(madeBlank.id, 'not a type', { client: c })).changed, false);
    ok('an unreadable type states nothing at all');

    /* ───────────── C. the document slots ───────────── */
    console.log('\nC. the slots ask for the document that actually exists');
    await seedSlots(c, madeCorp.id);
    await llcLib.applyEntitySlotWording(madeCorp.id, c);
    const corpSlot = await slotOf(c, madeCorp.id, 'rtl_llc_opagmt');
    assert.strictEqual(corpSlot.label, 'Bylaws and stock certificate');
    assert.strictEqual(corpSlot.borrower_label, 'Bylaws and stock certificate');
    assert.ok(/stock certificate/i.test(corpSlot.borrower_hint || ''));
    ok("a corporation's governing-document slot asks for bylaws and a stock certificate");

    const corpForm = await slotOf(c, madeCorp.id, 'rtl_llc_formation');
    assert.strictEqual(corpForm.label, 'Articles of Incorporation (formation state)');
    ok('and its formation slot asks for articles of incorporation, not organization');

    const llcEntity = await llcLib.findOrCreateLlc(bor, { llcName: 'Plain Holdings LLC', entityType: 'llc' }, c);
    await seedSlots(c, llcEntity.id);
    await llcLib.applyEntitySlotWording(llcEntity.id, c);
    assert.strictEqual((await slotOf(c, llcEntity.id, 'rtl_llc_opagmt')).label, 'Operating Agreement');
    ok('an LLC still asks for its operating agreement');

    /* THE ONE THAT WOULD HAVE BROKEN ON THE NEXT DEPLOY. db/033 copies the shared
       template's borrower wording down onto every item made from these templates,
       on EVERY boot — right for an LLC, wrong for a corporation. Reproduced here
       exactly, then healed the way boot does. */
    await c.query(
      `UPDATE checklist_items ci
          SET borrower_label = t.borrower_label, borrower_hint = t.borrower_hint
         FROM checklist_templates t
        WHERE t.id = ci.template_id AND t.code IN ('rtl_llc_formation','rtl_llc_ein','rtl_llc_opagmt')
          AND ci.llc_id = $1`, [madeCorp.id]);
    assert.strictEqual((await slotOf(c, madeCorp.id, 'rtl_llc_opagmt')).borrower_label, 'Operating agreement',
      'the reproduction did not actually clobber the row — the rest of this check would prove nothing');
    const healed = await llcLib.applyEntitySlotWording(madeCorp.id, c);
    assert.ok(healed.updated > 0, 'the heal must actually fix the clobbered row');
    assert.strictEqual((await slotOf(c, madeCorp.id, 'rtl_llc_opagmt')).borrower_label, 'Bylaws and stock certificate');
    ok("db/033's every-boot copy-down is undone — a corporation is not re-asked for an operating agreement each deploy");

    // And a second pass changes nothing, so the boot sweep is not an updated_at churn.
    assert.strictEqual((await llcLib.applyEntitySlotWording(madeCorp.id, c)).updated, 0);
    ok('a settled entity is a no-op — the boot sweep does not churn rows');

    // A label a HUMAN edited is not ours to overwrite.
    await c.query(
      `UPDATE checklist_items ci SET label = 'Bylaws — signed copy only, please'
         FROM checklist_templates t
        WHERE t.id = ci.template_id AND t.code = 'rtl_llc_opagmt' AND ci.llc_id = $1`, [madeCorp.id]);
    await llcLib.applyEntitySlotWording(madeCorp.id, c);
    assert.strictEqual((await slotOf(c, madeCorp.id, 'rtl_llc_opagmt')).label, 'Bylaws — signed copy only, please');
    ok('a wording somebody typed by hand survives every pass');

    /* ───────────── D. the owners ───────────── */
    console.log('\nD. who signs, and as what');
    const parsedStaff = llcLib.parseMembers(
      [{ fullName: 'Sam Shareholder', ownershipPct: 40, memberTitle: 'President', shares: 400, certificateNumber: 'C-3' }],
      60, { allowOwnerDetails: true, entityType: 'corporation' });
    assert.ok(!parsedStaff.error, parsedStaff.error);
    await llcLib.replaceMembers(madeCorp.id, parsedStaff.members, { borrowerId: bor, client: c });
    let mem = (await c.query(`SELECT full_name, member_title, shares, certificate_number FROM llc_members WHERE llc_id=$1`, [madeCorp.id])).rows[0];
    assert.strictEqual(mem.member_title, 'President');
    assert.strictEqual(mem.shares, 400);
    assert.strictEqual(mem.certificate_number, 'C-3');
    ok('staff can record a title, a share count and the certificate that is pledged');

    // A title on no list may never reach a signature block.
    const badTitle = llcLib.parseMembers(
      [{ fullName: 'Sam Shareholder', ownershipPct: 40, memberTitle: 'Chief Vibes Officer' }],
      60, { allowOwnerDetails: true, entityType: 'corporation' });
    assert.ok(badTitle.error && /not one of the titles/.test(badTitle.error));
    ok('a made-up title is refused with a message naming the ones that work');

    // A share count is a COUNT: zero, negative and fractional are all refused,
    // both by the parser and by the column's own CHECK.
    for (const bad of [0, -1, 2.5]) {
      const p = llcLib.parseMembers([{ fullName: 'X', ownershipPct: 10, shares: bad }], 90,
        { allowOwnerDetails: true, entityType: 'corporation' });
      assert.ok(p.error, `a share count of ${bad} must be refused`);
    }
    let dbRefused = false;
    await c.query('SAVEPOINT s2');
    try { await c.query(`UPDATE llc_members SET shares = 0 WHERE llc_id=$1`, [madeCorp.id]); }
    catch (e) { dbRefused = e.code === '23514'; }
    await c.query('ROLLBACK TO SAVEPOINT s2');
    assert.ok(dbRefused, 'the column must refuse a zero share count too');
    ok('zero, negative and fractional share counts are refused at both layers');

    /* THE BORROWER'S EDIT MUST NOT WIPE THE CLOSER'S WORK. replaceMembers deletes
       and re-inserts the whole list, and the borrower's door never sends these
       three keys — so without carrying them over, a borrower fixing a typo in
       their own email silently blanks a value that prints under a signature. */
    const parsedBorrower = llcLib.parseMembers(
      [{ fullName: 'Sam Shareholder', ownershipPct: 40, email: 'sam@example.com',
        memberTitle: 'Managing Member', shares: 999, certificateNumber: 'HACK' }],
      60);   // no allowOwnerDetails — this is the borrower's door
    assert.ok(!parsedBorrower.error, parsedBorrower.error);
    assert.strictEqual(parsedBorrower.members[0].memberTitle, undefined,
      "the borrower's door must IGNORE these keys, not refuse them — they cannot see the boxes");
    await llcLib.replaceMembers(madeCorp.id, parsedBorrower.members, { borrowerId: bor, client: c });
    mem = (await c.query(`SELECT member_title, shares, certificate_number, email FROM llc_members WHERE llc_id=$1`, [madeCorp.id])).rows[0];
    assert.strictEqual(mem.email, 'sam@example.com', "the borrower's own edit still saved");
    assert.strictEqual(mem.member_title, 'President', 'the title the closer set must survive');
    assert.strictEqual(mem.shares, 400);
    assert.strictEqual(mem.certificate_number, 'C-3');
    ok("a borrower's edit saves their own change and never wipes the closer's title, shares or certificate");

    // Staff CLEARING one is a real answer, and must go through.
    const cleared = llcLib.parseMembers(
      [{ fullName: 'Sam Shareholder', ownershipPct: 40, memberTitle: '', shares: null, certificateNumber: '' }],
      60, { allowOwnerDetails: true, entityType: 'corporation' });
    await llcLib.replaceMembers(madeCorp.id, cleared.members, { borrowerId: bor, client: c });
    mem = (await c.query(`SELECT member_title, shares, certificate_number FROM llc_members WHERE llc_id=$1`, [madeCorp.id])).rows[0];
    assert.strictEqual(mem.member_title, null);
    assert.strictEqual(mem.shares, null);
    assert.strictEqual(mem.certificate_number, null);
    ok('a staffer deliberately clearing a title clears it — a blank they typed is an answer');

    /* ───────────── E. the closing-desk nudge ───────────── */
    console.log('\nE. the closing desk is told who still has no title');
    await c.query(`INSERT INTO llc_borrowers (llc_id, borrower_id, ownership_pct) VALUES ($1,$2,60)`, [madeCorp.id, bor]);
    let missing = await llcLib.ownersMissingTitles(madeCorp.id, c);
    assert.ok(missing.includes('Sam Shareholder'), 'the member with no title must be named');
    assert.ok(missing.includes('Test Owner'), 'the BORROWER-owner is an owner too — both tables are read');
    ok('both owner tables are read: a loan document lists every owner, whoever they are to us');

    await c.query(`UPDATE llc_members SET member_title='President' WHERE llc_id=$1`, [madeCorp.id]);
    await c.query(`UPDATE llc_borrowers SET member_title='Secretary' WHERE llc_id=$1`, [madeCorp.id]);
    missing = await llcLib.ownersMissingTitles(madeCorp.id, c);
    assert.deepStrictEqual(missing, [], 'once every owner has a title the nudge goes quiet');
    ok('the nudge clears itself the moment the titles are filled');

    // A COMPANY owner holds no title — it signs through its own people, on its
    // own row — so it must never be nagged for one.
    const holdco = await llcLib.findOrCreateLlc(bor, { llcName: 'Holdco Group LLC' }, c);
    await c.query(
      `INSERT INTO llc_members (llc_id, full_name, ownership_pct, member_kind, owner_llc_id)
       VALUES ($1,'Holdco Group LLC',10,'entity',$2)`, [madeCorp.id, holdco.id]);
    missing = await llcLib.ownersMissingTitles(madeCorp.id, c);
    assert.deepStrictEqual(missing, [], 'a company owner must not be asked for a title');
    ok('a holding company is never asked for a title it cannot have');

    /* ───────────── F. the condition wording ───────────── */
    console.log('\nF. the condition lists say entity, not LLC');
    /* db/510 IS RUN HERE, INSIDE THE TRANSACTION, rather than trusting whatever
       state the database happens to be in. Three earlier migrations (db/012,
       db/033, db/057) re-assert this condition's old "LLC" wording on every
       boot and db/510 is what re-asserts the new wording over them — so what
       must be proven is that 507 CONVERGES from any of those, not that some
       other suite happened to leave the row tidy. Re-running it also proves it
       is idempotent, and the rollback leaves nothing behind. */
    const sqlPath = require('path').join(__dirname, '..', 'db', '510_entity_condition_wording.sql');
    const sql507 = require('fs').readFileSync(sqlPath, 'utf8');
    // Start from the worst case: the wording db/057 writes on every boot.
    await c.query(
      `UPDATE checklist_templates
          SET label = 'LLC (vesting entity) — verify entity, ownership & the three documents',
              borrower_label = 'Your LLC (vesting entity)'
        WHERE code = 'rtl_p1_llc'`);
    await c.query(sql507);
    await c.query(sql507);   // idempotent — a second boot changes nothing
    const tpl = (await c.query(
      `SELECT label, borrower_label, hint, borrower_hint FROM checklist_templates WHERE code='rtl_p1_llc'`)).rows[0];
    assert.ok(tpl, 'the vesting-entity condition template must exist');
    assert.ok(!/\bLLC\b/.test(tpl.label), `the staff label still says LLC: ${tpl.label}`);
    assert.ok(!/\bLLC\b/.test(tpl.borrower_label), `the borrower label still says LLC: ${tpl.borrower_label}`);
    assert.ok(!/\bLLC\b/.test(tpl.borrower_hint || ''), 'the borrower hint still says LLC');
    ok('the vesting-entity condition no longer calls every entity an LLC');

    // The slot TEMPLATES are what a brand-new entity inherits before anything
    // knows its type, so they must be type-neutral too.
    for (const row of (await c.query(
      `SELECT code, label FROM checklist_templates WHERE code LIKE 'rtl_llc_%'`)).rows) {
      assert.ok(!/^LLC /.test(row.label), `${row.code} template still leads with "LLC ": ${row.label}`);
    }
    ok('the entity-document templates are type-neutral, so a fresh slot never inherits a lie');

    /* ───────────── G. the dead end a trust used to hit ───────────── */
    console.log('\nG. a real trust can actually be verified');
    const trust = await llcLib.findOrCreateLlc(bor, {
      llcName: 'The Bochner Family Trust', entityType: 'trust', entitySubtype: 'revocable',
      formationDate: '2019-03-03',
    }, c);
    const tRow = (await c.query(`SELECT entity_type, entity_subtype FROM llcs WHERE id=$1`, [trust.id])).rows[0];
    assert.strictEqual(tRow.entity_type, 'trust');
    assert.strictEqual(tRow.entity_subtype, 'revocable');
    ok('a trust records which kind it is');

    // The database refuses a kind that belongs to another type — a value stored
    // against the wrong type would silently relax the wrong requirement.
    let crossRefused = false;
    await c.query('SAVEPOINT s3');
    try { await c.query(`UPDATE llcs SET entity_subtype='general' WHERE id=$1`, [trust.id]); }
    catch (e) { crossRefused = e.code === '23514'; }
    await c.query('ROLLBACK TO SAVEPOINT s3');
    assert.ok(crossRefused, "a partnership's kind must not be storable on a trust");
    let llcRefused = false;
    await c.query('SAVEPOINT s4');
    try { await c.query(`UPDATE llcs SET entity_subtype='revocable' WHERE id=$1`, [madeBlank.id]); }
    catch (e) { llcRefused = e.code === '23514'; }
    await c.query('ROLLBACK TO SAVEPOINT s4');
    assert.ok(llcRefused, 'an LLC has no kind, so it must not be able to carry one');
    ok('the database refuses a kind on a type that does not have one');

    /* THE WHOLE POINT. A revocable living trust uses the grantor's own Social
       Security number and is filed with no state. Before the sub-kind existed,
       `missingForVerification` demanded an EIN and a formation state from every
       entity — so this trust could NEVER be verified, the vesting-entity
       condition could never clear, and the file could never reach clear to
       close, with nobody able to fix it because the documents do not exist. */
    await seedSlots(c, trust.id);
    await llcLib.applyEntitySlotWording(trust.id, c);
    await c.query(`UPDATE llcs SET ownership_pct = 100 WHERE id=$1`, [trust.id]);
    let tBundle = await llcLib.getLlcBundle(trust.id, c);
    let tMissing = llcLib.missingForVerification(tBundle, tBundle.members, tBundle.slots);
    assert.ok(!tMissing.some((m) => /ein/i.test(m)), `a revocable trust must not be asked for an EIN — got ${JSON.stringify(tMissing)}`);
    assert.ok(!tMissing.some((m) => /state/i.test(m)), `a trust must not be asked for a formation state — got ${JSON.stringify(tMissing)}`);
    ok('a revocable trust is no longer asked for an EIN or a state filing it does not have');

    // The date IS still required — it is part of the trust's legal name.
    await c.query(`UPDATE llcs SET formation_date = NULL WHERE id=$1`, [trust.id]);
    tBundle = await llcLib.getLlcBundle(trust.id, c);
    tMissing = llcLib.missingForVerification(tBundle, tBundle.members, tBundle.slots);
    assert.ok(tMissing.some((m) => /trust date/i.test(m)),
      `the trust date must still be required, and named as a TRUST date — got ${JSON.stringify(tMissing)}`);
    await c.query(`UPDATE llcs SET formation_date = '2019-03-03' WHERE id=$1`, [trust.id]);
    ok('the trust date is still required, and the message calls it a trust date');

    // An LLC is untouched — nothing was relaxed for the types that do file.
    await c.query(`UPDATE llcs SET ownership_pct = 100 WHERE id=$1`, [madeBlank.id]);
    await seedSlots(c, madeBlank.id);
    const llcBundle = await llcLib.getLlcBundle(madeBlank.id, c);
    const llcMissing = llcLib.missingForVerification(llcBundle, llcBundle.members, llcBundle.slots);
    assert.ok(llcMissing.some((m) => /EIN/.test(m)), 'an LLC must still be asked for its EIN');
    assert.ok(llcMissing.some((m) => /formation state/i.test(m)), 'an LLC must still be asked for its formation state');
    ok('an LLC still has to produce all three — the relaxation is only for the kinds that cannot');

    /* ───────────── H. the state-filing slot stops gating ───────────── */
    console.log('\nH. the slot stops asking for a filing that does not exist');
    const gp = await llcLib.findOrCreateLlc(bor, {
      llcName: 'Bochner & Sons', entityType: 'partnership', entitySubtype: 'general',
      ein: '12-3456789', formationDate: '2020-01-15',
    }, c);
    await seedSlots(c, gp.id);
    await llcLib.applyEntitySlotWording(gp.id, c);
    await c.query(`UPDATE llcs SET ownership_pct = 100 WHERE id=$1`, [gp.id]);
    const gpSlot = await slotOf(c, gp.id, 'rtl_llc_formation');
    assert.ok(/if the partnership has one/i.test(gpSlot.label),
      `a general partnership must not be asked for a certificate it never had — got "${gpSlot.label}"`);
    const gpReq = (await c.query(
      `SELECT ci.is_required FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.llc_id=$1 AND t.code='rtl_llc_formation'`, [gp.id])).rows[0];
    assert.strictEqual(gpReq.is_required, false, 'and the slot must stop gating verification');
    ok('a general partnership is told there may be no filing, and the slot stops gating');

    let gpBundle = await llcLib.getLlcBundle(gp.id, c);
    let gpMissing = llcLib.missingForVerification(gpBundle, gpBundle.members, gpBundle.slots);
    assert.ok(!gpMissing.some((m) => /not uploaded/i.test(m) && /registration/i.test(m)),
      `the state-filing slot must not block — got ${JSON.stringify(gpMissing)}`);
    assert.ok(!gpMissing.some((m) => /requirements not generated/i.test(m)),
      `making one slot optional must not read as "the slots were never built" — got ${JSON.stringify(gpMissing)}`);
    ok('and "document requirements not generated" does not fire on a deliberately optional slot');

    // CORRECTING the kind restores the requirement — the pass runs both ways.
    await c.query(`UPDATE llcs SET entity_subtype='limited' WHERE id=$1`, [gp.id]);
    await llcLib.applyEntitySlotWording(gp.id, c);
    const lpSlot = await slotOf(c, gp.id, 'rtl_llc_formation');
    assert.ok(/Certificate of Limited Partnership/i.test(lpSlot.label), `got "${lpSlot.label}"`);
    const lpReq = (await c.query(
      `SELECT ci.is_required FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.llc_id=$1 AND t.code='rtl_llc_formation'`, [gp.id])).rows[0];
    assert.strictEqual(lpReq.is_required, true, 'an LP does file with the state, so the requirement comes back');
    gpBundle = await llcLib.getLlcBundle(gp.id, c);
    gpMissing = llcLib.missingForVerification(gpBundle, gpBundle.members, gpBundle.slots);
    assert.ok(gpMissing.some((m) => /formation state/i.test(m)), 'and its state is required again');
    ok('correcting general → limited restores both the wording and the requirement');

    // A slot somebody has already worked is never overridden.
    await c.query(`UPDATE llcs SET entity_subtype='general' WHERE id=$1`, [gp.id]);
    await c.query(
      `UPDATE checklist_items ci SET status='received'
         FROM checklist_templates t
        WHERE t.id = ci.template_id AND t.code='rtl_llc_formation' AND ci.llc_id=$1`, [gp.id]);
    await llcLib.applyEntitySlotWording(gp.id, c);
    const worked = (await c.query(
      `SELECT ci.is_required FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.llc_id=$1 AND t.code='rtl_llc_formation'`, [gp.id])).rows[0];
    assert.strictEqual(worked.is_required, true,
      'a slot a human has already worked keeps its requirement — we do not overrule them');
    ok('a slot somebody has already worked is left exactly as they left it');

    /* ───────────── I. the kind on the file's own screens ───────────── */
    console.log('\nI. the kind reaches the screens that need it');
    const desc = require('../src/lib/entity-type').describe(
      (await c.query(`SELECT * FROM llcs WHERE id=$1`, [trust.id])).rows[0]);
    assert.strictEqual(desc.hasSubtypes, true);
    assert.strictEqual(desc.subtype, 'revocable');
    assert.strictEqual(desc.dateLabel, 'Trust date');
    assert.strictEqual(desc.requirements.ein, false);
    const bundleKind = (await llcLib.getLlcBundle(trust.id, c)).entity;
    assert.strictEqual(bundleKind.subtypeLabel, 'Revocable (living) trust');
    ok('the bundle every screen reads carries the kind, its label and what it must produce');

    console.log(`\nAll ${pass} entity-type database checks passed.\n`);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });

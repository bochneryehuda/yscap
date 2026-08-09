'use strict';
/**
 * Draw Request & Wire Instructions via DocuSign — the wire CAPTURE + fatal name rule.
 *
 * (1) Pure name classification (borrower / subject LLC / new entity, with the safety
 *     bias that a name carrying a company word is an entity). (2) DocuSign textTab emit
 *     + read-back roundtrip. (3) DB: captureWireFromEnvelope stores the wire (account #
 *     encrypted), and raises the FATAL operating-agreement condition for a NEW entity /
 *     retracts it when the name matches the borrower or subject LLC. DB-gated skip.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-request-wire (no DATABASE_URL)'); process.exit(0); }
const db = require('../src/db');
const ds = require('../src/lib/integrations/docusign');
const drawWire = require('../src/lib/esign/draw-wire');
const cryptoLib = require('../src/lib/crypto');
const { wireTextTabs, WIRE_KEYS } = require('../src/lib/esign/wire-tabs');

let P = 0, F = 0;
function ok(c, m) { c ? (P++, console.log('  ok -', m)) : (F++, console.log('  FAIL -', m)); }

// A mock DocuSign whose getEnvelope returns a completed envelope with typed wire tabs.
function mockDocusign(wireValues) {
  return {
    parseRecipients: ds.parseRecipients,
    getEnvelope: async () => ({
      status: 'completed',
      recipients: { signers: [{
        recipientId: '1', name: 'Signer', email: 's@e.com', status: 'completed', signedDateTime: '2026-07-20T12:00:00Z',
        tabs: { textTabs: WIRE_KEYS.map((k) => ({ tabLabel: k, value: wireValues[k] != null ? String(wireValues[k]) : '' })) },
      }] },
    }),
  };
}

(async () => {
  const ids = [];
  try {
    // ---- (1) pure classification ----
    ok(drawWire.classifyAccountName('Jane Q Borrower', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'borrower_personal', 'personal name → borrower_personal');
    ok(drawWire.classifyAccountName('Maple Ridge, L.L.C.', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'subject_llc', 'subject LLC (suffix-tolerant) → subject_llc');
    ok(drawWire.classifyAccountName('Jane Borrower Homes LLC', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'new_entity', 'name + company word → new_entity (fatal)');
    ok(drawWire.classifyAccountName('Sunrise Capital LLC', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'new_entity', 'unrelated LLC → new_entity');
    ok(drawWire.classifyAccountName('', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'unknown', 'blank → unknown');
    // C1 regression: a DIFFERENT legal form sharing the base is NOT the subject LLC (fatal).
    ok(drawWire.classifyAccountName('Maple Ridge Trust', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'new_entity', 'C1: "Maple Ridge Trust" vs "Maple Ridge LLC" → new_entity (different legal form)');
    ok(drawWire.classifyAccountName('Maple Ridge Inc', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'new_entity', 'C1: "Maple Ridge Inc" vs "Maple Ridge LLC" → new_entity');
    ok(drawWire.classifyAccountName('Riverside Company', { borrowerName: 'Jane Borrower', llcName: 'Riverside LLC' }).kind === 'new_entity', 'C1: "Riverside Company" vs "Riverside LLC" → new_entity');
    // still tolerant: the SAME form, and a dropped form, both clear as the subject LLC.
    ok(drawWire.classifyAccountName('Maple Ridge', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'subject_llc', 'dropped legal form ("Maple Ridge" vs "Maple Ridge LLC") still clears as subject_llc');
    ok(drawWire.classifyAccountName('Maple Ridge L.L.C.', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'subject_llc', 'same form, punctuation variant → subject_llc');
    // OWNER-REPORTED false new-entity (2026-08-05) — the account matches the subject LLC
    // but was flagged because the STORED name carried its full legal DESCRIPTION, or
    // omitted the legal form, or led with "The".
    ok(drawWire.classifyAccountName('MW Trading LLC', { borrowerName: 'Jane Borrower', llcName: 'MW Trading LLC, A New York Limited Liability Company' }).kind === 'subject_llc',
      'stored name with full legal description still matches the account → subject_llc');
    ok(drawWire.classifyAccountName('Maple Ridge LLC', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge' }).kind === 'subject_llc',
      'account HAS the form, stored LLC name omitted it → subject_llc (the omission goes both ways)');
    ok(drawWire.classifyAccountName('The Maple Ridge LLC', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'subject_llc',
      'a leading "The" does not make it a new entity → subject_llc');
    ok(drawWire.classifyAccountName('  Maple Ridge LLC  ', { borrowerName: 'Jane Borrower', llcName: 'Maple Ridge LLC' }).kind === 'subject_llc',
      'leading/trailing spaces do not make it a new entity → subject_llc');
    // The safety case is UNCHANGED: a stored name with no form vs a DIFFERENT-form account
    // is still tolerant (base match), but two DIFFERENT non-empty forms never clear.
    ok(drawWire.classifyAccountName('Riverside Trust', { borrowerName: 'Jane Borrower', llcName: 'Riverside Inc' }).kind === 'new_entity',
      'two different non-empty legal forms are still a new entity (Trust vs Inc)');

    // OWNER-REPORTED false new-entity (2026-08-06, "69 Bassett LLC"): the wire went to the
    // file's OWN vesting entity, which was on the borrower's library but was NOT the linked
    // a.llc_id, so the llc_id-only check flagged a fatal "new entity". A known entity of the
    // borrower now clears as 'known_entity'.
    ok(drawWire.classifyAccountName('69 Bassett LLC', { borrowerName: 'Pat Owner', llcName: null, knownEntities: ['69 Bassett LLC', 'Some Other Holdings LLC'] }).kind === 'known_entity',
      '69 Bassett LLC matches a KNOWN entity of the borrower (not the linked llc_id) → known_entity, not fatal');
    ok(drawWire.classifyAccountName('69 Bassett', { borrowerName: 'Pat Owner', llcName: null, knownEntities: ['69 Bassett LLC'] }).kind === 'known_entity',
      'the dropped-legal-form tolerance also applies to a known library entity');
    ok(drawWire.classifyAccountName('Unrelated Escrow LLC', { borrowerName: 'Pat Owner', llcName: '69 Bassett LLC', knownEntities: ['69 Bassett LLC'] }).kind === 'new_entity',
      'a name matching NOTHING on the borrower (not vesting, not a known entity) still escalates fatal — the safety net holds');
    ok(drawWire.classifyAccountName('69 Bassett LLC', { borrowerName: 'Pat Owner', llcName: '69 Bassett LLC', knownEntities: ['69 Bassett LLC'] }).kind === 'subject_llc',
      'the LINKED vesting entity still takes precedence and reads subject_llc, not known_entity');
    // A co-borrower may wire in their OWN personal name (borrowerNames list).
    ok(drawWire.classifyAccountName('Chris Cosigner', { borrowerName: 'Pat Owner', borrowerNames: ['Chris Cosigner'], llcName: null }).kind === 'borrower_personal',
      'the co-borrower typing their own name clears as borrower_personal');
    // Back-compat: the old 2-arg shape is byte-identical (no knownEntities, no borrowerNames).
    ok(drawWire.classifyAccountName('Anonymous LLC', { borrowerName: 'Pat Owner', llcName: 'Maple Ridge LLC' }).kind === 'new_entity',
      'with no knownEntities supplied, an unrelated LLC is still a new_entity (back-compat)');

    // ---- (1b) displayEntityName — a CLEAN name for creating the LLC on the profile (Task 5) ----
    ok(drawWire.displayEntityName('MW Trading LLC, A New York Limited Liability Company') === 'MW Trading LLC',
      'displayEntityName strips the full legal description');
    ok(drawWire.displayEntityName('Maple Ridge LLC') === 'Maple Ridge LLC', 'a clean LLC name is unchanged');
    ok(drawWire.displayEntityName('Riverside Holdings') === 'Riverside Holdings', 'a name with no legal form is returned as-is');
    ok(drawWire.displayEntityName('  Beta Holdings LLC  ') === 'Beta Holdings LLC', 'surrounding whitespace is trimmed');
    ok(drawWire.displayEntityName('') === '', 'a blank name stays blank');

    // ---- (2) textTab emit + read-back ----
    const def = ds.buildEnvelopeDefinition({
      documents: [{ base64: 'AAAA', name: 'DR', documentId: 1 }],
      signers: [{ recipientId: '1', name: 'Jane', email: 'j@e.com', routingOrder: 1,
        tabsByDoc: { 1: { sign: ['/dr_b1_sig/'], date: ['/dr_b1_dt/'], text: wireTextTabs() } } }],
      subject: 'DR',
    });
    ok(def.recipients.signers[0].tabs.textTabs.length === 6, 'six textTabs emitted');
    ok(def.recipients.signers[0].tabs.textTabs.every((t) => t.required != null && t.tabLabel), 'every textTab has a tabLabel');

    // ---- (3) DB capture + conditions ----
    const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Jane','Borrower',$1) RETURNING id`, [`jane${Date.now()}@e.com`])).rows[0];
    const l = (await db.query(`INSERT INTO llcs (borrower_id,llc_name) VALUES ($1,'Maple Ridge Holdings LLC') RETURNING id`, [b.id])).rows[0];
    const a = (await db.query(
      `INSERT INTO applications (borrower_id,llc_id,status,property_address,ys_loan_number)
       VALUES ($1,$2,'funded','{"oneLine":"123 Main St"}',$3) RETURNING id`,
      [b.id, l.id, `YSCAP-${Date.now() % 1000000}`])).rows[0];
    ids.push(a.id);
    const env = (await db.query(
      `INSERT INTO esign_envelopes (application_id,purpose,status,envelope_id) VALUES ($1,'draw_request','completed',$2) RETURNING id`,
      [a.id, `env-${Date.now()}`])).rows[0];

    // --- case A: NEW ENTITY → fatal OA condition raised ---
    const wireNew = { account_name: 'Sunrise Capital LLC', bank_name: 'Big Bank', account_number: '123456789', routing_number: '021000021', bank_address: '1 Bank Rd', account_address: '2 Holder Ave' };
    const rA = await drawWire.captureWireFromEnvelope(db, mockDocusign(wireNew), { id: env.id, application_id: a.id, envelope_id: 'env-x' });
    ok(rA && rA.name_kind === 'new_entity', 'capture: new entity classified');
    const wrow = (await db.query(`SELECT * FROM draw_wire_instructions WHERE application_id=$1`, [a.id])).rows[0];
    ok(wrow && wrow.account_name === 'Sunrise Capital LLC', 'wire row stored with account name');
    ok(wrow && wrow.account_number_enc && cryptoLib.decryptSSN(wrow.account_number_enc) === '123456789', 'account number encrypted + decrypts');
    ok(wrow && wrow.account_last4 === '6789', 'account last4 stored');
    ok(wrow && wrow.routing_number === '021000021', 'routing stored in clear');
    ok(wrow && JSON.stringify(wrow.raw).indexOf('123456789') === -1, 'raw jsonb REDACTS the full account number');
    const oa = (await db.query(`SELECT * FROM checklist_items WHERE application_id=$1 AND field_key=$2`, [a.id, `draw:wire_oa:${a.id}`])).rows[0];
    ok(!!oa && oa.status === 'outstanding' && oa.is_gate === true, 'fatal OA condition raised (gate, outstanding)');
    ok(wrow.operating_agreement_item_id === oa.id, 'wire row links to the OA condition');

    // --- case B: re-capture same envelope (idempotent) ---
    await drawWire.captureWireFromEnvelope(db, mockDocusign(wireNew), { id: env.id, application_id: a.id, envelope_id: 'env-x' });
    const nWire = (await db.query(`SELECT count(*)::int c FROM draw_wire_instructions WHERE application_id=$1`, [a.id])).rows[0].c;
    const nOa = (await db.query(`SELECT count(*)::int c FROM checklist_items WHERE application_id=$1 AND field_key=$2`, [a.id, `draw:wire_oa:${a.id}`])).rows[0].c;
    ok(nWire === 1 && nOa === 1, 'idempotent: no duplicate wire row or OA condition on re-capture');

    // --- case C: corrected to the SUBJECT LLC → OA retracted (waived) ---
    const wireLlc = { ...wireNew, account_name: 'Maple Ridge Holdings, LLC' };
    const rC = await drawWire.captureWireFromEnvelope(db, mockDocusign(wireLlc), { id: env.id, application_id: a.id, envelope_id: 'env-x' });
    ok(rC && rC.name_kind === 'subject_llc', 'capture: corrected to subject LLC');
    const oa2 = (await db.query(`SELECT status FROM checklist_items WHERE application_id=$1 AND field_key=$2`, [a.id, `draw:wire_oa:${a.id}`])).rows[0];
    ok(!oa2, 'OA condition auto-retracted (deleted, untouched) when name matches subject LLC');
    const wrow2 = (await db.query(`SELECT name_kind, operating_agreement_item_id FROM draw_wire_instructions WHERE application_id=$1`, [a.id])).rows[0];
    ok(wrow2.name_kind === 'subject_llc' && wrow2.operating_agreement_item_id === null, 'wire row updated to subject_llc, OA link cleared');

    // --- case D: the 69 Bassett scenario — the vesting entity is on the borrower's LIBRARY
    //     but a.llc_id is NULL, so it is NOT the linked subject LLC. A wire to it must clear
    //     as a KNOWN entity, NOT raise a fatal "new entity" (owner-directed 2026-08-06). ---
    const b2 = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Pat','Owner',$1) RETURNING id`, [`pat${Date.now()}@e.com`])).rows[0];
    // A library entity for the borrower that is NEVER linked as a.llc_id.
    await db.query(`INSERT INTO llcs (borrower_id,llc_name) VALUES ($1,'69 Bassett LLC')`, [b2.id]);
    const a2 = (await db.query(
      `INSERT INTO applications (borrower_id,llc_id,status,property_address,ys_loan_number)
       VALUES ($1,NULL,'funded','{"oneLine":"69 Bassett St, New Haven, CT 06511"}',$2) RETURNING id`,
      [b2.id, `YSCAP-${(Date.now() + 1) % 1000000}`])).rows[0];
    ids.push(a2.id);
    const env2 = (await db.query(
      `INSERT INTO esign_envelopes (application_id,purpose,status,envelope_id) VALUES ($1,'draw_request','completed',$2) RETURNING id`,
      [a2.id, `env2-${Date.now()}`])).rows[0];
    const wireKnown = { account_name: '69 Bassett LLC', bank_name: 'Community Bank', account_number: '55550000', routing_number: '021000021', bank_address: '9 Main', account_address: '69 Bassett St' };
    const rD = await drawWire.captureWireFromEnvelope(db, mockDocusign(wireKnown), { id: env2.id, application_id: a2.id, envelope_id: 'env2-x' });
    ok(rD && rD.name_kind === 'known_entity', 'capture: the file\'s own library entity (not linked as a.llc_id) → known_entity');
    ok(rD && rD.name_matches === true, '…and name_matches is true (no operating agreement collected)');
    const oaD = (await db.query(`SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2`, [a2.id, `draw:wire_oa:${a2.id}`])).rows[0];
    ok(!oaD, 'no fatal operating-agreement condition was raised for a known entity of the borrower');
    const wrowD = (await db.query(`SELECT name_kind FROM draw_wire_instructions WHERE application_id=$1`, [a2.id])).rows[0];
    ok(wrowD && wrowD.name_kind === 'known_entity', 'the wire row stores the known_entity classification');

    // --- case E: an ADOPTED-but-UNVERIFIED entity (entity-adopt, db/400, OA not yet on file)
    //     must NOT clear a draw wire — it still escalates so the operating agreement is collected
    //     before money goes out. A VERIFIED adopted entity clears. (Pre-merge audit item 5.) ---
    const b3 = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Sam','Adopter',$1) RETURNING id`, [`sam${Date.now()}@e.com`])).rows[0];
    const a3 = (await db.query(
      `INSERT INTO applications (borrower_id,llc_id,status,property_address,ys_loan_number)
       VALUES ($1,NULL,'funded','{"oneLine":"7 Adopt Ave"}',$2) RETURNING id`,
      [b3.id, `YSCAP-${(Date.now() + 2) % 1000000}`])).rows[0];
    ids.push(a3.id);
    // Adopted onto the profile because assets came from it, but no OA on file yet → is_verified=false.
    await db.query(`INSERT INTO llcs (borrower_id,llc_name,adopted_from_application_id,is_verified) VALUES ($1,'Adopted Pending LLC',$2,false)`, [b3.id, a3.id]);
    // A different adopted entity whose OA HAS been accepted → is_verified=true.
    await db.query(`INSERT INTO llcs (borrower_id,llc_name,adopted_from_application_id,is_verified) VALUES ($1,'Verified Adopted LLC',$2,true)`, [b3.id, a3.id]);
    const env3 = (await db.query(
      `INSERT INTO esign_envelopes (application_id,purpose,status,envelope_id) VALUES ($1,'draw_request','completed',$2) RETURNING id`,
      [a3.id, `env3-${Date.now()}`])).rows[0];
    // Wire to the adopted-PENDING entity → still a fatal new entity (OA must be collected).
    const rE1 = await drawWire.captureWireFromEnvelope(db, mockDocusign({ ...wireKnown, account_name: 'Adopted Pending LLC' }), { id: env3.id, application_id: a3.id, envelope_id: 'env3-x' });
    ok(rE1 && rE1.name_kind === 'new_entity', 'an ADOPTED-but-unverified entity does NOT clear — still new_entity (collect the OA first)');
    const oaE = (await db.query(`SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2`, [a3.id, `draw:wire_oa:${a3.id}`])).rows[0];
    ok(!!oaE, '…and the fatal operating-agreement condition is raised for the adopted-pending entity');
    // Re-capture to the VERIFIED adopted entity → clears as known_entity, OA retracted.
    const rE2 = await drawWire.captureWireFromEnvelope(db, mockDocusign({ ...wireKnown, account_name: 'Verified Adopted LLC' }), { id: env3.id, application_id: a3.id, envelope_id: 'env3-x' });
    ok(rE2 && rE2.name_kind === 'known_entity', 'a VERIFIED adopted entity clears as known_entity');
    const oaE2 = (await db.query(`SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2`, [a3.id, `draw:wire_oa:${a3.id}`])).rows[0];
    ok(!oaE2, '…and its OA condition is retracted');

    // --- ensureDrawRequestCondition is idempotent ---
    const c1 = await drawWire.ensureDrawRequestCondition(db, a.id);
    const c2 = await drawWire.ensureDrawRequestCondition(db, a.id);
    ok(c1 && c1 === c2, 'ensureDrawRequestCondition idempotent (same item id)');

    console.log(`\n${P} passed, ${F} failed`);
  } catch (e) { console.error('THREW', e && e.message, e && e.stack); F++; }
  finally {
    try {
      for (const id of ids) {
        await db.query(`DELETE FROM draw_wire_instructions WHERE application_id=$1`, [id]);
        await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [id]);
        await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [id]);
        const bb = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [id])).rows[0];
        await db.query(`DELETE FROM applications WHERE id=$1`, [id]);
        if (bb) { await db.query(`DELETE FROM llcs WHERE borrower_id=$1`, [bb.borrower_id]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bb.borrower_id]); }
      }
    } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    if (F) process.exit(1);
  }
})();

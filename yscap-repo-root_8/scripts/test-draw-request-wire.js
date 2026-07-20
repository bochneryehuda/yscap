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

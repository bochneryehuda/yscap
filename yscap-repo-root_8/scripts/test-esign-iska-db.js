'use strict';
/**
 * HETER ISKA — the auto-feed bug fix + the manual-upload super_admin gate (owner-reported
 * 2026-08), end to end against a real Postgres.
 *
 * ROOT CAUSE: a completed Heter Iska DocuSign package "wasn't fed directly into the iska
 * condition". The executed doc is bound to rtl_cond_iska only through the SEND-TIME snapshot
 * esign_envelope_docs.checklist_item_id; when the condition was absent/stale at send time that
 * snapshot was NULL and handleCompletion attached the doc only `if (d.checklist_item_id)`.
 *
 * THE FIX has three layers, all proven here:
 *   1. ensureIskaCondition — find-or-create rtl_cond_iska (orchestrate.js), used by the
 *      send-time ensure so a fresh binding is never null.
 *   2. handleCompletion re-resolves a NULL binding by TEMPLATE CODE (webhook.js) and
 *      ensure-creates rtl_cond_iska if genuinely absent — healing an in-flight completion.
 *   3. backfillIskaFeedOnce — one-shot boot heal for ALREADY-completed back-book envelopes
 *      whose executed doc was stored but never bound.
 *
 * And the sign-off provenance gate: a MANUALLY-uploaded Iska (not the DocuSign-fed
 * heter_iska_signed) can be signed off ONLY by a super_admin; a DocuSign-fed one by anyone.
 *
 * DB-gated: skips cleanly when DATABASE_URL is unset.
 */
if (!process.env.DATABASE_URL) { console.log('test-esign-iska-db: SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const orchestrate = require('../src/lib/esign/orchestrate');
const webhook = require('../src/lib/esign/webhook');
const iskaHeal = require('../src/lib/esign/iska-feed-heal');
const { signOffGate } = require('../src/routes/staff');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `iska-${process.pid}-${Date.now()}`;

// In-memory storage stub (handleCompletion → storeSignedDocument → storage.save).
function fakeStorage() {
  const store = new Map(); let i = 0;
  return {
    async save(buf) { const ref = `${uniq}-ref-${++i}`; store.set(ref, Buffer.from(buf)); return { ref, provider: 'local', bytes: buf.length }; },
    async read(ref) { if (!store.has(ref)) throw new Error(`no bytes for ${ref}`); return store.get(ref); },
  };
}
const fakeDocusign = {
  async getDocument(_env, id) { return Buffer.from(`iska-signed-${id}`); },
  async getCertificate() { return Buffer.from('cert'); },
};

const mkApp = async () => {
  const b = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Is','Ka',$1) RETURNING id`,
    [`${uniq}-${Math.random().toString(36).slice(2, 8)}@example.test`])).rows[0].id;
  return (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, property_address, status, loan_type, program, term)
     VALUES ($1,$2,$3,'underwriting','Purchase','Gold Standard','12 Months') RETURNING id`,
    [b, `YSI${String(Math.random()).slice(-9)}`,
     JSON.stringify({ oneLine: '1 Iska Way, Lakewood, NJ 08701', state: 'NJ', zip: '08701' })])).rows[0].id;
};
const iskaItem = async (appId) => (await db.query(
  `SELECT ci.id, ci.status FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code='rtl_cond_iska' ORDER BY ci.created_at DESC LIMIT 1`, [appId])).rows[0] || null;

// Insert a completed-esign shape: an esign_envelopes row + one esign_envelope_docs row.
const mkEnvelopeDoc = async (appId, { checklistItemId = null, completedDocumentId = null, envId } = {}) => {
  const env = (await db.query(
    `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required, product_version, envelope_id)
     VALUES ($1,'heter_iska','sent',false,0,$2) RETURNING id, envelope_id, application_id, purpose`,
    [appId, envId || `${uniq}-ENV-${Math.random().toString(36).slice(2, 8)}`])).rows[0];
  const ed = (await db.query(
    `INSERT INTO esign_envelope_docs (envelope_row_id, document_id, doc_kind, checklist_item_id, completed_document_id)
     VALUES ($1,1,'heter_iska_signed',$2,$3) RETURNING id`,
    [env.id, checklistItemId, completedDocumentId])).rows[0];
  return { env, edId: ed.id };
};

(async () => {
  // The template must exist + be active for any of this to work.
  const tpl = (await db.query(`SELECT id, is_active FROM checklist_templates WHERE code='rtl_cond_iska'`)).rows[0];
  assert(tpl && tpl.is_active, 'rtl_cond_iska template exists and is active');
  if (!tpl || !tpl.is_active) { process.exit(failures ? 1 : 0); }

  /* ───────── 1. ensureIskaCondition — find-or-create + idempotent ───────── */
  {
    const appId = await mkApp();
    assert(!(await iskaItem(appId)), 'a bare file has no rtl_cond_iska item yet (test isolation)');
    const id1 = await orchestrate.ensureIskaCondition(db, appId, null);
    const created = await iskaItem(appId);
    assert(created && created.id === id1, 'ensureIskaCondition created the rtl_cond_iska item');
    const shape = (await db.query(`SELECT item_kind, status FROM checklist_items WHERE id=$1`, [id1])).rows[0];
    assert(shape.item_kind === 'document', 'the created item is a document condition');
    assert(shape.status === 'outstanding', 'the created item is born outstanding');
    const id2 = await orchestrate.ensureIskaCondition(db, appId, null);
    assert(id2 === id1, 'ensureIskaCondition is idempotent — a second call returns the same id, no duplicate');
    const cnt = (await db.query(
      `SELECT count(*)::int c FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_cond_iska'`, [appId])).rows[0].c;
    assert(cnt === 1, 'exactly one rtl_cond_iska item on the file after two ensures');
  }

  /* ───────── 2. handleCompletion re-resolves a NULL binding by code ─────────
     The condition EXISTS but the send-time binding captured null (the pre-fix bug). */
  {
    const appId = await mkApp();
    const item = await orchestrate.ensureIskaCondition(db, appId, null);  // condition present
    const { env, edId } = await mkEnvelopeDoc(appId, { checklistItemId: null });  // ...but binding NULL
    await webhook.handleCompletion(db, fakeDocusign, fakeStorage(), env);
    const ed = (await db.query(`SELECT checklist_item_id, completed_document_id FROM esign_envelope_docs WHERE id=$1`, [edId])).rows[0];
    assert(String(ed.checklist_item_id) === String(item), 'completion re-resolved the null binding to rtl_cond_iska by code');
    assert(ed.completed_document_id, 'the executed Iska was stored (completed_document_id set)');
    const doc = (await db.query(
      `SELECT checklist_item_id, doc_kind, source_type, review_status FROM documents WHERE id=$1`, [ed.completed_document_id])).rows[0];
    assert(String(doc.checklist_item_id) === String(item), 'the stored executed doc is attached to rtl_cond_iska');
    assert(doc.doc_kind === 'heter_iska_signed' && doc.source_type === 'system', 'the executed doc is the DocuSign-fed heter_iska_signed');
    const st = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [item])).rows[0].status;
    assert(st === 'received', 'the rtl_cond_iska condition was fed → status received');
  }

  /* ───────── 3. handleCompletion ensure-CREATES the condition when absent ───────── */
  {
    const appId = await mkApp();
    assert(!(await iskaItem(appId)), 'file starts with no rtl_cond_iska item');
    const { env } = await mkEnvelopeDoc(appId, { checklistItemId: null });
    await webhook.handleCompletion(db, fakeDocusign, fakeStorage(), env);
    const item = await iskaItem(appId);
    assert(item && item.status === 'received',
      'a completed Iska on a file MISSING the condition creates it and feeds it (received)');
  }

  /* ───────── 4. backfillIskaFeedOnce — heal an ALREADY-completed back-book envelope ─────────
     completed_document_id set + checklist_item_id NULL + a stored, unbound executed doc. */
  {
    const appId = await mkApp();
    const item = await orchestrate.ensureIskaCondition(db, appId, null);
    const storedDoc = (await db.query(
      `INSERT INTO documents (application_id, filename, content_type, size_bytes, storage_provider, storage_ref,
                              uploaded_by_kind, doc_kind, source_type, visibility, is_current, review_status)
       VALUES ($1,$2,'application/pdf',9,'local',$3,'staff','heter_iska_signed','system','borrower',true,'accepted')
       RETURNING id`, [appId, `heter_iska_${uniq}.pdf`, `${uniq}-stored`])).rows[0].id;
    const { edId } = await mkEnvelopeDoc(appId, { checklistItemId: null, completedDocumentId: storedDoc });
    const r = await iskaHeal.backfillIskaFeedOnce(500);
    assert(r && r.fed >= 1, `heal reports at least one fed condition (fed=${r && r.fed})`);
    const doc = (await db.query(`SELECT checklist_item_id FROM documents WHERE id=$1`, [storedDoc])).rows[0];
    assert(String(doc.checklist_item_id) === String(item), 'heal attached the stored executed doc to rtl_cond_iska');
    const ed = (await db.query(`SELECT checklist_item_id FROM esign_envelope_docs WHERE id=$1`, [edId])).rows[0];
    assert(String(ed.checklist_item_id) === String(item), 'heal recorded the envelope-doc binding');
    const st = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [item])).rows[0].status;
    assert(st === 'received', 'heal marked the condition received');
    // Idempotent: a second pass finds nothing left to feed for this row.
    const before = (await db.query(
      `SELECT count(*)::int c FROM esign_envelope_docs WHERE id=$1 AND checklist_item_id IS NULL`, [edId])).rows[0].c;
    assert(before === 0, 'the healed envelope-doc row left the checklist_item_id IS NULL set (self-draining)');
  }

  /* ───────── 5. signOffGate — the manual-upload super_admin provenance gate ───────── */
  const proc = { id: null, kind: 'staff', role: 'processor' };
  const superA = { id: null, kind: 'staff', role: 'super_admin' };
  // 5a — a DocuSign-fed executed Iska: ANY signer may sign off.
  {
    const appId = await mkApp();
    const item = await orchestrate.ensureIskaCondition(db, appId, null);
    await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, filename, content_type, size_bytes, storage_provider,
                              storage_ref, uploaded_by_kind, doc_kind, source_type, visibility, is_current, review_status)
       VALUES ($1,$2,$3,'application/pdf',9,'local',$4,'staff','heter_iska_signed','system','borrower',true,'accepted')`,
      [appId, item, `heter_iska_ds_${uniq}.pdf`, `${uniq}-ds`]);
    assert((await signOffGate(item, proc)) === null, 'DocuSign-fed Iska → a processor CAN sign off');
    assert((await signOffGate(item, superA)) === null, 'DocuSign-fed Iska → a super_admin CAN sign off');
  }
  // 5b — a MANUALLY-uploaded Iska (doc_kind NULL, not source_type system): super_admin only.
  {
    const appId = await mkApp();
    const item = await orchestrate.ensureIskaCondition(db, appId, null);
    await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, filename, content_type, size_bytes, storage_provider,
                              storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, source_type, visibility, is_current, review_status)
       VALUES ($1,$2,$3,'application/pdf',9,'local',$4,'staff',NULL,NULL,'staff_upload','borrower',true,'accepted')`,
      [appId, item, `HeterIska_signed_by_hand_${uniq}.pdf`, `${uniq}-manual`]);
    const g = await signOffGate(item, proc);
    assert(typeof g === 'string' && /super admin/i.test(g), 'manual Iska → a processor is REFUSED with a super-admin message');
    assert((await signOffGate(item, superA)) === null, 'manual Iska → a super_admin CAN sign off');
  }
  // 5c — no accepted document: refuse (fail safe).
  {
    const appId = await mkApp();
    const item = await orchestrate.ensureIskaCondition(db, appId, null);
    const g = await signOffGate(item, superA);
    assert(typeof g === 'string' && /upload the executed heter iska/i.test(g),
      'no accepted document → even a super_admin is refused (nothing to stand on)');
  }
  // 5d — a DocuSign-fed copy present alongside a manual one: any signer may proceed.
  {
    const appId = await mkApp();
    const item = await orchestrate.ensureIskaCondition(db, appId, null);
    await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, filename, content_type, size_bytes, storage_provider, storage_ref, uploaded_by_kind, doc_kind, source_type, visibility, is_current, review_status)
       VALUES ($1,$2,$3,'application/pdf',9,'local',$4,'staff','heter_iska_signed','system','borrower',true,'accepted')`,
      [appId, item, `iska_ds_${uniq}.pdf`, `${uniq}-ds2`]);
    await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, filename, content_type, size_bytes, storage_provider, storage_ref, uploaded_by_kind, doc_kind, source_type, visibility, is_current, review_status)
       VALUES ($1,$2,$3,'application/pdf',9,'local',$4,'staff',NULL,'staff_upload','borrower',true,'accepted')`,
      [appId, item, `iska_manual_${uniq}.pdf`, `${uniq}-man2`]);
    assert((await signOffGate(item, proc)) === null, 'a genuine DocuSign-fed copy present → any signer may proceed even with a manual copy alongside');
  }

  if (failures) { console.error(`\ntest-esign-iska-db: ${failures} FAILURE(S).`); process.exit(1); }
  console.log('\nAll Heter Iska feed + gate checks passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

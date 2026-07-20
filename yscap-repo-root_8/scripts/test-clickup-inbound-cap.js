/**
 * Inbound ClickUp sync can never COMPLETE a required condition.
 *
 * Owner-directed 2026-07-20 ("major fatal", root-cause-everywhere): a required
 * condition must never be marked complete without its portal data. signOffGate
 * closed the manual door (PATCH /checklist/:id). This test guards the SECOND,
 * independent door — the inbound ClickUp checklist sync (ingest.applyChecklist-
 * Statuses) — which writes checklist_items.status directly, bypassing the gate.
 * A ClickUp "satisfied" dropdown must land at 'received' on the portal (evidence
 * received), never 'satisfied', so a human still signs off through the gate.
 *
 * Boots nothing — calls the exported applyChecklistStatuses against a real DB.
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-clickup-inbound-cap (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const ingest = require('../src/clickup/ingest');
const F = require('../src/clickup/fields');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// The Insurance condition is a required, ClickUp-mapped document condition. Its
// "satisfied" dropdown option is the value a staffer/automation would set in
// ClickUp to mark insurance done.
const INS = F.CHECKLIST.insurance;

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Cap','Test',$1) RETURNING id`,
      [`cap-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, status) VALUES ($1,'processing') RETURNING id`, [borrowerId])).rows[0].id;

    // The file's Insurance condition sits at 'outstanding' with zero documents,
    // mapped to its ClickUp field so the inbound sync will find it.
    const tpl = (await db.query(`SELECT id, label FROM checklist_templates WHERE code='rtl_cond_insurance'`)).rows[0];
    const itemId = (await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required, clickup_field_id)
       VALUES ($1,'application',$2,$3,'outstanding','document',true,$4) RETURNING id`,
      [tpl.id, appId, tpl.label, INS.fieldId])).rows[0].id;

    // A ClickUp task whose Insurance dropdown is set to its "satisfied" option.
    // (applyChecklistStatuses accepts the option UUID directly as the field value.)
    const task = { id: 'tsk_' + sfx, custom_fields: [{ id: INS.fieldId, type: 'drop_down', value: INS.options.satisfied }] };

    await ingest.applyChecklistStatuses(appId, task);

    const after = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [itemId])).rows[0];
    assert(after.status === 'received', `inbound ClickUp "satisfied" lands at 'received', not 'satisfied' (got '${after.status}')`);
    assert(after.status !== 'satisfied', 'the required condition is NOT completed by the sync');
    assert(after.signed_off_at == null, 'no sign-off stamped — a human must still sign off through the gate');

    // A subsequent inbound "satisfied" must NOT advance it past 'received'
    // (idempotent cap — only the gate can complete it).
    await ingest.applyChecklistStatuses(appId, task);
    const again = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [itemId])).rows[0];
    assert(again.status === 'received', 'a second inbound "satisfied" is still capped at received');

    // A lower inbound status still applies normally (evidence flow intact):
    // reset to outstanding, send "received", expect received.
    await db.query(`UPDATE checklist_items SET status='outstanding' WHERE id=$1`, [itemId]);
    const recvTask = { id: 'tsk2_' + sfx, custom_fields: [{ id: INS.fieldId, type: 'drop_down', value: INS.options.received }] };
    await ingest.applyChecklistStatuses(appId, recvTask);
    const recv = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [itemId])).rows[0];
    assert(recv.status === 'received', 'a genuine inbound "received" still applies (evidence flow unbroken)');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL inbound-cap assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();

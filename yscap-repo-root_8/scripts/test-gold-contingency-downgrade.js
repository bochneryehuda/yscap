/**
 * Gold 5% SOW-contingency reopen is CLEARED on a Gold→Standard downgrade
 * (src/lib/rehab-budget.js enforceGoldSowContingency).
 *
 * Registering Gold with a SOW that lacks the 5% contingency reopens the
 * rehab-budget condition to 'issue', clears the sign-off, and stamps a FATAL
 * [auto] Gold note. Previously the non-Gold branch was a no-op, so re-registering
 * the file as Standard left it stuck at 'issue' showing a Gold-only requirement
 * that no longer applies. This asserts a subsequent non-Gold register clears that
 * stale Gold state — without touching a human's own note.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-gold-contingency-downgrade (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const RB = require('../src/lib/rehab-budget');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

async function reg(appId, program) {
  await db.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1`, [appId]);
  await db.query(
    `INSERT INTO product_registrations (application_id, program, inputs, quote, is_current)
     VALUES ($1,$2,'{}'::jsonb,'{}'::jsonb,true)`, [appId, program]);
}
async function item(appId) {
  return (await db.query(`SELECT status, signed_off_at, notes FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0];
}

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Gold','Test',$1) RETURNING id`,
      [`gold-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(`INSERT INTO applications (borrower_id, status) VALUES ($1,'processing') RETURNING id`, [borrowerId])).rows[0].id;

    // A rehab-budget condition, already signed off, whose SOW lacks the 5%
    // contingency. Seeded at 'received' (the db/069 SOW guard rejects a directly
    // seeded 'satisfied' with no matching budget); signed_off_at is set so the
    // Gold reopen's clearing of it is observable.
    const tpl = (await db.query(`SELECT id, label FROM checklist_templates WHERE tool_key='rehab_budget' LIMIT 1`)).rows[0];
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, tool_key, tool_payload, is_required, signed_off_at)
       VALUES ($1,'application',$2,$3,'received','task','rehab_budget',$4::jsonb,true, now())`,
      [tpl.id, appId, tpl.label, JSON.stringify({ subtotal: 100000, contingency: 0 })]);

    // Register Gold → the contingency rule reopens the condition.
    await reg(appId, 'Gold Standard');
    await RB.enforceGoldSowContingency(appId);
    let it = await item(appId);
    assert(it.status === 'issue', 'Gold register reopens the rehab-budget condition to issue');
    assert(it.signed_off_at == null, 'Gold reopen clears the sign-off');
    assert(/contingency/i.test(it.notes || ''), 'Gold reopen stamps the [auto] contingency note');

    // Downgrade to Standard → the stale Gold reopen is cleared.
    await reg(appId, 'Standard');
    const r = await RB.enforceGoldSowContingency(appId);
    it = await item(appId);
    assert(r.cleared === true, 'the downgrade reports it cleared the stale Gold state');
    assert(it.status === 'received', 'the condition is rolled back from issue to received');
    assert(it.notes == null, 'the Gold-only [auto] note is removed on the Standard file');

    // A HUMAN note must NOT be cleared by a non-Gold register.
    await db.query(`UPDATE checklist_items SET status='issue', notes='Underwriter: budget looks light' WHERE application_id=$1 AND tool_key='rehab_budget'`, [appId]);
    await RB.enforceGoldSowContingency(appId);
    it = await item(appId);
    assert(it.notes === 'Underwriter: budget looks light', 'a human note is left untouched');
    assert(it.status === 'issue', "a human's issue is not silently un-reopened");

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL gold-contingency-downgrade assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();

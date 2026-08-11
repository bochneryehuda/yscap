/**
 * The non-owner-occupied affidavit condition is INTERNAL (db/520, owner-directed
 * 2026-08-11). On an individual-vesting file it is part of the ONE DocuSign
 * term-sheet package — the borrower signs the certification when we send the
 * package, so it must NEVER show on the borrower portal or leak into the
 * "what's still needed" outstanding-items email. It stays visible to staff (with
 * the "DocuSign — auto-clears" stamp) because the staff surfaces have no audience
 * filter.
 *
 * This pins the ROOT of the bug: the template's audience is 'staff' (so new files
 * inherit it), every existing per-file item is flipped (previous AND future), and
 * reminders.outstandingItems — the body of the borrower email — no longer carries
 * it, while an ordinary borrower item still does.
 *
 * Needs a database. Skips cleanly without DATABASE_URL. In `npm test`.
 */
'use strict';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP noo-affidavit-internal DB (no DATABASE_URL)'); return; }
  const db = require('../src/db');
  const reminders = require('../src/lib/reminders');
  const CODE = 'cond_noo_affidavit_individual';

  // 1) The template ends up internal after migrations, with the DocuSign-package hint.
  const tpl = (await db.query(
    `SELECT id, audience, hint FROM checklist_templates WHERE code=$1`, [CODE])).rows[0];
  ok(!!tpl, 'the affidavit template exists');
  ok(tpl && tpl.audience === 'staff', "the affidavit TEMPLATE is audience='staff' (borrower never sees new ones)");
  ok(tpl && /DocuSign term-sheet package/i.test(tpl.hint || ''),
    'the staff hint states it is part of the DocuSign term-sheet package');

  // A fixture file with an affidavit item and one ordinary borrower item.
  const bId = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email)
     VALUES ('Test','Affidavit', 'noo-affidavit-test-' || gen_random_uuid() || '@example.com') RETURNING id`)).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, status) VALUES ($1,'underwriting') RETURNING id`, [bId])).rows[0].id;
  try {
    // 2) A per-file affidavit item that predates the fix (audience='both').
    await db.query(
      `INSERT INTO checklist_items (application_id, template_id, scope, label, borrower_label, audience, item_kind, status)
       VALUES ($1,$2,'application','Non-owner-occupied affidavit (individual vesting)',
               'Non-owner-occupied affidavit','both','document','outstanding')`, [appId, tpl.id]);
    // A control: an ordinary borrower-facing item that MUST still appear on the email.
    await db.query(
      `INSERT INTO checklist_items (application_id, scope, label, borrower_label, audience, item_kind, status)
       VALUES ($1,'application','Bank statements','Provide your bank statements','both','document','outstanding')`, [appId]);

    // Before re-applying the migration, the stale 'both' affidavit item WOULD leak.
    let items = await reminders.outstandingItems(appId);
    ok(items.some((t) => /affidavit/i.test(t)),
      'BEFORE the backfill: a stale audience=both affidavit item leaks into the outstanding email (the bug)');

    // 3) Re-apply db/520 (the previous-AND-future backfill) — idempotent.
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '520_noo_affidavit_internal.sql'), 'utf8');
    await db.query(sql);

    const row = (await db.query(
      `SELECT audience FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appId, tpl.id])).rows[0];
    ok(row && row.audience === 'staff', 'the EXISTING per-file affidavit item is flipped to staff (previous AND future)');

    // 4) The outstanding-items email (and portal list, same filter) no longer carries it.
    items = await reminders.outstandingItems(appId);
    ok(!items.some((t) => /affidavit/i.test(t)),
      'AFTER the fix: the affidavit is GONE from the borrower outstanding-items email');
    ok(items.some((t) => /bank statements/i.test(t)),
      'a genuine borrower item (bank statements) still appears — only the affidavit was removed');
  } finally {
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [appId]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  if (db.pool && db.pool.end) await db.pool.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

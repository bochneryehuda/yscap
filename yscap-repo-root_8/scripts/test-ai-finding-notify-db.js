'use strict';
/*
 * ai-finding-notify — DB tests (real Postgres). Proves the owner's report end to end
 * (2026-08-06, the loan_amount / silver "fatal AI finding" notifications lingering "on a
 * lot of files"):
 *   A. retireForSuggestions marks the notification read (never deletes) and is scoped.
 *   B. ai-narrative.retractOpen retires the notification of every finding it self-heals.
 *   C. ai-suggestions.decide retires on a SETTLING decision, NOT on escalate.
 *   D. the backfill sweep retires the two stale phrasings + settled-finding notifications,
 *      and leaves a genuine open fatal + a genuinely-missing loan_amount alone.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-ai-finding-notify-db (no DATABASE_URL)'); process.exit(0); }

const crypto = require('crypto');
const db = require('../src/db');
const notif = require('../src/lib/underwriting/ai-finding-notify');
const aiNarr = require('../src/lib/underwriting/ai-narrative');
const aiSug = require('../src/lib/underwriting/ai-suggestions');

const rnd = crypto.randomBytes(5).toString('hex');

// Insert an ai_fatal_finding notification the way _notifyFatalNew would, for a suggestion id.
async function insertFatalNotif(staffId, appId, sugId, bodyText) {
  const link = sugId ? `/internal/app/${appId}?finding=${sugId}` : `/internal/app/${appId}`;
  const r = await db.query(
    `INSERT INTO notifications(recipient_kind,staff_id,type,title,body,application_id,link,email_status)
     VALUES('staff',$1,'ai_fatal_finding','New fatal AI finding',$2,$3,$4,'sent') RETURNING id`,
    [staffId, bodyText, appId, link]);
  return r.rows[0].id;
}
async function insertSuggestion(appId, { source = 'narrative_coherence', severity = 'fatal', status = 'open', title = 'x' } = {}) {
  const r = await db.query(
    `INSERT INTO ai_suggestions(application_id,source,kind,title,severity,status)
     VALUES($1,$2,'finding',$3,$4,$5) RETURNING id`,
    [appId, source, title, severity, status]);
  return r.rows[0].id;
}
const isRead = async (id) => !!(await db.query(`SELECT read_at FROM notifications WHERE id=$1`, [id])).rows[0].read_at;

(async () => {
  const bor = (await db.query(
    `INSERT INTO borrowers(first_name,last_name,email) VALUES('Fin','Notify',$1) RETURNING id`, [`fn${rnd}@example.com`])).rows[0].id;
  const staff = (await db.query(
    `INSERT INTO staff_users(full_name,email,role,is_active) VALUES('Rev Iewer',$1,'loan_officer',true) RETURNING id`, [`rev${rnd}@yscapgroup.com`])).rows[0].id;
  // A file WITH a loan amount, and one with NONE (a genuinely-missing loan_amount).
  const appWith = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,property_address,rehab_budget,loan_amount)
     VALUES($1,'underwriting',$2,'{"oneLine":"1 A St"}',50000,360500) RETURNING id`, [bor, 'AN' + rnd.slice(0, 6)])).rows[0].id;
  const appNo = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,property_address,rehab_budget,loan_amount)
     VALUES($1,'underwriting',$2,'{"oneLine":"2 B St"}',50000,NULL) RETURNING id`, [bor, 'BN' + rnd.slice(0, 6)])).rows[0].id;

  // ============================================================ A. direct retire, scoped
  {
    const sug = await insertSuggestion(appWith);
    const n = await insertFatalNotif(staff, appWith, sug, 'AI detected a fatal issue on this file: "something".');
    // A control on a DIFFERENT app that must not be touched.
    const other = await insertFatalNotif(staff, appNo, await insertSuggestion(appNo), 'AI detected a fatal issue: "unrelated".');
    const cnt = await notif.retireForSuggestions(db, appWith, [sug]);
    ok('A1 retire returns 1', cnt === 1);
    ok('A2 the notification is now read', await isRead(n));
    ok('A3 a different app is untouched', !(await isRead(other)));
    // Idempotent — a second call retires nothing more.
    ok('A4 second call retires 0 (already read)', (await notif.retireForSuggestions(db, appWith, [sug])) === 0);
  }

  // ============================================================ B. retractOpen self-heal
  {
    // The real retractOpen dismisses every OPEN narrative_coherence row on the file and
    // (the wiring under test) retires each dismissed finding's fatal notification.
    const sug = await insertSuggestion(appWith, { title: 'silver not valid' });
    const n = await insertFatalNotif(staff, appWith, sug, 'AI detected a fatal issue on this file: "silver not valid".');
    await aiNarr._internals.retractOpen(db, appWith, 'the loan file changed — re-read');
    const st = (await db.query(`SELECT status FROM ai_suggestions WHERE id=$1`, [sug])).rows[0].status;
    ok('B1 the narrative finding was dismissed', st === 'dismissed');
    ok('B2 its fatal notification was retired', await isRead(n));
  }

  // ============================================================ C. decide: settle vs escalate
  {
    const sugD = await insertSuggestion(appWith, { source: 'cure_analysis' });
    const nD = await insertFatalNotif(staff, appWith, sugD, 'AI detected a fatal issue on this file: "cure thing".');
    await aiSug.decide(db, sugD, { action: 'dismiss', staffId: staff, reason: 'not real' });
    ok('C1 a DISMISS retires the notification', await isRead(nD));

    const sugE = await insertSuggestion(appWith, { source: 'cure_analysis' });
    const nE = await insertFatalNotif(staff, appWith, sugE, 'AI detected a fatal issue on this file: "still real".');
    await aiSug.decide(db, sugE, { action: 'escalate', staffId: staff });
    ok('C2 an ESCALATE keeps the notification (still needs handling)', !(await isRead(nE)));
  }

  // ============================================================ D. backfill sweep
  {
    // Stale silver (valid program flagged invalid) — retire.
    const nSilver = await insertFatalNotif(staff, appWith, await insertSuggestion(appWith),
      'AI detected a fatal issue on this file: "The file is registered as a ‘silver’ program even though the authoritative program list only defines standard, gold, manual, or none.". Open the AI Findings panel.');
    // Stale loan_amount on a file that HAS a loan amount — retire.
    const nLoanWith = await insertFatalNotif(staff, appWith, await insertSuggestion(appWith),
      'AI detected a fatal issue on this file: "The file is marked as missing the required loan_amount even though it also lists a total financed loan amount of $360,500.". Open the AI Findings panel.');
    // Same phrasing but on a file with NO loan_amount — a GENUINE missing; must NOT retire.
    const nLoanNo = await insertFatalNotif(staff, appNo, await insertSuggestion(appNo),
      'AI detected a fatal issue on this file: "The file is marked as missing the required loan_amount and no value is present.". Open the AI Findings panel.');
    // A genuinely open, unrelated fatal — must NOT retire.
    const nReal = await insertFatalNotif(staff, appWith, await insertSuggestion(appWith),
      'AI detected a fatal issue on this file: "The seller on the contract never held title.". Open the AI Findings panel.');
    // A settled-finding notification (arm 2): the linked suggestion is dismissed → retire.
    const sugSettled = await insertSuggestion(appWith, { status: 'dismissed' });
    const nSettled = await insertFatalNotif(staff, appWith, sugSettled, 'AI detected a fatal issue on this file: "was handled".');
    // A linked suggestion that is ESCALATED → arm 2 must NOT retire.
    const sugEsc = await insertSuggestion(appWith, { status: 'escalated' });
    const nEsc = await insertFatalNotif(staff, appWith, sugEsc, 'AI detected a fatal issue on this file: "loud one".');

    const r = await notif.retireStaleFatalNotificationsOnce(db);
    ok('D1 the stale silver notification is retired', await isRead(nSilver));
    ok('D2 the stale loan_amount (file HAS one) is retired', await isRead(nLoanWith));
    ok('D3 a genuinely-missing loan_amount is LEFT ALONE', !(await isRead(nLoanNo)));
    ok('D4 an unrelated open fatal is LEFT ALONE', !(await isRead(nReal)));
    ok('D5 a settled finding’s notification is retired (arm 2)', await isRead(nSettled));
    ok('D6 an escalated finding’s notification is LEFT ALONE', !(await isRead(nEsc)));
    ok('D7 the sweep reports what it did', r.retiredStale >= 2 && r.retiredSettled >= 1);
  }

  // ============================================================ cleanup
  await db.query(`DELETE FROM notifications WHERE application_id = ANY($1)`, [[appWith, appNo]]);
  await db.query(`DELETE FROM ai_suggestions WHERE application_id = ANY($1)`, [[appWith, appNo]]);
  await db.query(`DELETE FROM applications WHERE id = ANY($1)`, [[appWith, appNo]]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [staff]);

  console.log(`test-ai-finding-notify-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

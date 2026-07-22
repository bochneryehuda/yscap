'use strict';
/**
 * Sync-review RE-CHECK ("look again") — owner-directed 2026-07-22.
 *
 * PURE part (always runs): valuesAgree + the field canonicalizers prove which
 * two-sided values count as "now agreeing" (case-insensitive email, last-10
 * phone, normalized name/address, digits-only SSN, calendar-day dates) and,
 * critically, that a one-sided blank is NEVER treated as agreement.
 *
 * DB part (runs only with DATABASE_URL): recheckReview re-reads BOTH systems
 * live (ClickUp stubbed) and CLOSES a row only when the data proves it resolved
 * — a DOB the reviewer already made match, and an email fixed to a case-variant
 * — while a still-different DOB / email stays OPEN and is stamped last_checked_at.
 *
 *   node scripts/test-sync-review-recheck.js
 *   DATABASE_URL=postgres://… node scripts/test-sync-review-recheck.js
 */
const R = require('path').resolve(__dirname, '..');
const R2 = require(R + '/src/lib/sync-review-recheck');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ---------- PURE: valuesAgree + canonicalizers ----------
(function pure() {
  // email — case/whitespace-insensitive
  ok(R2.valuesAgree('email', 'Shloimy6125@Gmail.com', ' shloimy6125@gmail.com ') === true, 'email: case/space differences agree');
  ok(R2.valuesAgree('email', 'a@x.com', 'b@y.com') === false, 'email: genuinely different do not agree');
  ok(R2.valuesAgree('email', '', 'a@x.com') === false, 'email: one-sided blank never agrees');
  // phone — last 10 digits
  ok(R2.valuesAgree('cell_phone', '+1 (347) 907-0483', '347-9070483') === true, 'phone: same last-10 agree');
  ok(R2.valuesAgree('cell_phone', '3479070483', '2120001111') === false, 'phone: different numbers do not agree');
  ok(R2.valuesAgree('cell_phone', '', '3479070483') === false, 'phone: blank never agrees');
  // name — normalized
  ok(R2.valuesAgree('first_name', 'Yakov  Klein', 'yakov klein') === true, 'name: spacing/case agree');
  ok(R2.valuesAgree('first_name', 'Yakov Klein', 'Yakov Klain') === false, 'name: different spelling differs');
  // address — object OR string, normalized
  ok(R2.valuesAgree('current_address', { formatted_address: '12 Churchill Lane, Lakewood, NJ' }, '12 churchill lane lakewood nj') === true, 'address: object vs string, normalized, agree');
  ok(R2.valuesAgree('current_address', '12 Churchill Lane', '99 Oak Street') === false, 'address: different streets differ');
  // ssn — digits only, must be full 9
  ok(R2.valuesAgree('ssn', '123-45-4776', '123454776') === true, 'ssn: dashed vs bare 9-digit agree');
  ok(R2.valuesAgree('ssn', '123-45-4776', '999-99-9999') === false, 'ssn: different numbers differ');
  ok(R2.valuesAgree('ssn', '4776', '123454776') === false, 'ssn: partial never agrees');
  // dates — calendar day
  ok(R2.valuesAgree('expected_closing', '2026-08-01', '2026-08-01') === true, 'date: same day agrees');
  ok(R2.valuesAgree('expected_closing', '2026-08-01', '2026-08-02') === false, 'date: different day differs');
  ok(R2.valuesAgree('acquisition_date', '', '2026-08-01') === false, 'date: blank never agrees');
  // unknown / non-value field → never auto-agrees here
  ok(R2.valuesAgree('status', 'x', 'x') === false, 'status: not a re-checkable value field (false)');
  ok(R2.valuesAgree('file_link', null, null) === false, 'file_link: not a value field (false)');
})();

(async function dbtests() {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP recheck DB lifecycle (no DATABASE_URL)'); return; }
  const db = require(R + '/src/db');
  const T = require(R + '/src/clickup/transforms');
  const F = require(R + '/src/clickup/fields');
  const rnd = () => 'rck' + Math.random() + '@e.com';
  // applications.clickup_pipeline_task_id is UNIQUE — make every task id unique
  // per run so the suite is safely re-runnable against the same database.
  const RUN = 'rck' + Math.random().toString(36).slice(2, 10);
  const tk = (s) => `tk_${RUN}_${s}`;

  // Stub ClickUp: getTask returns whatever custom_fields we prime per task id.
  const taskStore = {};
  const clickup = { getTask: async (id) => ({ id, custom_fields: taskStore[id] || [] }) };
  const setTaskField = (taskId, fieldId, value) => { taskStore[taskId] = [{ id: fieldId, value }]; };

  async function openRow({ appId, borrowerId, taskId, fieldKey, clickupValue, portalValue }) {
    const r = await db.query(
      `INSERT INTO sync_review_queue (application_id, borrower_id, task_id, direction, field_key, reason, clickup_value, portal_value)
       VALUES ($1,$2,$3,'inbound',$4,'test_recheck',$5,$6) RETURNING id`,
      [appId || null, borrowerId || null, taskId || null, fieldKey, clickupValue || null, portalValue || null]);
    return r.rows[0].id;
  }
  const rowById = async (id) => (await db.query(`SELECT * FROM sync_review_queue WHERE id=$1`, [id])).rows[0];

  // ---- DOB: reviewer already made both sides match → recheck CLOSES it.
  const b1 = (await db.query("INSERT INTO borrowers(first_name,last_name,email,date_of_birth,origin) VALUES('A','One',$1,'1985-04-12','self') RETURNING id", [rnd()])).rows[0].id;
  const t1 = tk('a');
  const app1 = (await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id) VALUES($1,$2) RETURNING id', [b1, t1])).rows[0].id;
  setTaskField(t1, F.SHARED.borrowerDOB, T.dateOnlyToClickUpEpoch('1985-04-12'));   // ClickUp now matches the portal
  const id1 = await openRow({ appId: app1, borrowerId: b1, taskId: t1, fieldKey: 'date_of_birth', clickupValue: '1979-01-01', portalValue: '1985-04-12' });
  const out1 = await R2.recheckReview(await rowById(id1), { clickup });
  ok(out1.outcome === 'closed' && out1.reason === 'agree', 'DOB now matching → recheck closes it (agree)');
  ok((await rowById(id1)).status === 'resolved', 'DOB: the row is marked resolved');
  ok((await rowById(id1)).auto_resolved === true, 'DOB: closed as an auto-resolution, not a human dismiss');
  ok((await rowById(id1)).last_checked_at != null && (await rowById(id1)).check_count === 1, 'DOB: last_checked_at + check_count stamped');

  // ---- DOB: two different plausible adult DOBs, human-origin portal → stays OPEN.
  const b2 = (await db.query("INSERT INTO borrowers(first_name,last_name,email,date_of_birth,origin) VALUES('B','Two',$1,'1990-06-06','self') RETURNING id", [rnd()])).rows[0].id;
  const t2 = tk('b2');
  const app2 = (await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id) VALUES($1,$2) RETURNING id', [b2, t2])).rows[0].id;
  setTaskField(t2, F.SHARED.borrowerDOB, T.dateOnlyToClickUpEpoch('1988-03-03'));   // ClickUp differs, both plausible
  const id2 = await openRow({ appId: app2, borrowerId: b2, taskId: t2, fieldKey: 'date_of_birth', clickupValue: '1988-03-03', portalValue: '1990-06-06' });
  const out2 = await R2.recheckReview(await rowById(id2), { clickup });
  ok(out2.outcome === 'still_open', 'DOB still differing (human portal) → stays open');
  ok((await rowById(id2)).status === 'open', 'DOB: the differing row is left open');
  ok((await rowById(id2)).last_checked_at != null && (await rowById(id2)).check_count === 1, 'DOB: a still-open re-check still stamps last_checked_at');

  // ---- Email: fixed to a case-variant → recheck CLOSES it.
  const email = `Yosef.Klein.${RUN}@gmail.com`;   // mixed-case; unique per run
  const b3 = (await db.query("INSERT INTO borrowers(first_name,last_name,email,origin) VALUES('C','Three',$1,'self') RETURNING id", [email.toLowerCase()])).rows[0].id;
  const t3 = tk('b3');
  const app3 = (await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id) VALUES($1,$2) RETURNING id', [b3, t3])).rows[0].id;
  setTaskField(t3, F.SHARED.borrowerEmail, email);   // ClickUp holds the same email, different case
  const id3 = await openRow({ appId: app3, borrowerId: b3, taskId: t3, fieldKey: 'email', clickupValue: email, portalValue: email.toLowerCase() });
  const out3 = await R2.recheckReview(await rowById(id3), { clickup });
  ok(out3.outcome === 'closed', 'email now matching (case-only) → recheck closes it');
  ok((await rowById(id3)).status === 'resolved', 'email: the row is resolved');

  // ---- Email: genuinely different → stays OPEN.
  const portal4 = `portal4.${RUN}@x.com`, clickup4 = `clickup4.${RUN}@y.com`;   // both unique per run
  const b4 = (await db.query("INSERT INTO borrowers(first_name,last_name,email,origin) VALUES('D','Four',$1,'self') RETURNING id", [portal4])).rows[0].id;
  const t4 = tk('b4');
  const app4 = (await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id) VALUES($1,$2) RETURNING id', [b4, t4])).rows[0].id;
  setTaskField(t4, F.SHARED.borrowerEmail, clickup4);
  const id4 = await openRow({ appId: app4, borrowerId: b4, taskId: t4, fieldKey: 'email', clickupValue: clickup4, portalValue: portal4 });
  const out4 = await R2.recheckReview(await rowById(id4), { clickup });
  ok(out4.outcome === 'still_open', 'email still different → stays open');

  // ---- File-level row (file_link): not a value field → unsupported, but stamped.
  const id5 = await openRow({ appId: app4, borrowerId: b4, taskId: t4, fieldKey: 'file_link', clickupValue: null, portalValue: null });
  const out5 = await R2.recheckReview(await rowById(id5), { clickup });
  ok(out5.outcome === 'unsupported', 'file_link → unsupported (clears itself on natural recovery)');
  ok((await rowById(id5)).last_checked_at != null, 'file_link: still stamped as checked');

  // ---- Application DATE field: the ClickUp side is a raw EPOCH — the re-check
  // must normalize it to a day before comparing (regression guard: a date
  // re-check could never close if the epoch wasn't converted).
  const b7 = (await db.query("INSERT INTO borrowers(first_name,last_name,email,origin) VALUES('G','Seven',$1,'self') RETURNING id", [rnd()])).rows[0].id;
  const t7 = tk('b7');
  const app7 = (await db.query("INSERT INTO applications(borrower_id,clickup_pipeline_task_id,expected_closing) VALUES($1,$2,'2026-09-01') RETURNING id", [b7, t7])).rows[0].id;
  setTaskField(t7, F.PIPELINE.expectedClosing, T.dateOnlyToClickUpEpoch('2026-09-01'));   // same day, stored as epoch
  const id7 = await openRow({ appId: app7, borrowerId: b7, taskId: t7, fieldKey: 'expected_closing', clickupValue: '2026-08-01', portalValue: '2026-09-01' });
  const out7 = await R2.recheckReview(await rowById(id7), { clickup });
  ok(out7.outcome === 'closed', 'date field: ClickUp epoch that equals the portal day → recheck closes it');
  ok((await rowById(id7)).status === 'resolved', 'date field: the row is resolved');
  // and a genuinely different closing date stays open
  const t7b = tk('b7b');
  const app7b = (await db.query("INSERT INTO applications(borrower_id,clickup_pipeline_task_id,expected_closing) VALUES($1,$2,'2026-09-01') RETURNING id", [b7, t7b])).rows[0].id;
  setTaskField(t7b, F.PIPELINE.expectedClosing, T.dateOnlyToClickUpEpoch('2026-12-15'));
  const id7b = await openRow({ appId: app7b, borrowerId: b7, taskId: t7b, fieldKey: 'expected_closing', clickupValue: '2026-12-15', portalValue: '2026-09-01' });
  const out7b = await R2.recheckReview(await rowById(id7b), { clickup });
  ok(out7b.outcome === 'still_open', 'date field: genuinely different closing dates stay open');

  // ---- BLAST-RADIUS GUARD: two files for ONE borrower, both with an open email
  // review. Fixing one file must NOT close the still-differing row on the OTHER
  // file (a value field genuinely differs per file — the close is file-scoped).
  const shared = `shared6.${RUN}@x.com`;
  const b6 = (await db.query("INSERT INTO borrowers(first_name,last_name,email,origin) VALUES('F','Six',$1,'self') RETURNING id", [shared])).rows[0].id;
  const t6a = tk('b6a'), t6b = tk('b6b');
  const app6a = (await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id) VALUES($1,$2) RETURNING id', [b6, t6a])).rows[0].id;
  const app6b = (await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id) VALUES($1,$2) RETURNING id', [b6, t6b])).rows[0].id;
  setTaskField(t6a, F.SHARED.borrowerEmail, `Shared6.${RUN}@X.com`);   // file A: case-variant match → resolved
  setTaskField(t6b, F.SHARED.borrowerEmail, `stale6.${RUN}@y.com`);    // file B: genuinely different → still open
  const id6a = await openRow({ appId: app6a, borrowerId: b6, taskId: t6a, fieldKey: 'email', clickupValue: `Shared6.${RUN}@X.com`, portalValue: shared });
  const id6b = await openRow({ appId: app6b, borrowerId: b6, taskId: t6b, fieldKey: 'email', clickupValue: `stale6.${RUN}@y.com`, portalValue: shared });
  const out6a = await R2.recheckReview(await rowById(id6a), { clickup });
  ok(out6a.outcome === 'closed', 'blast-radius: re-checking file A (now matching) closes A');
  ok((await rowById(id6a)).status === 'resolved', 'blast-radius: file A row is resolved');
  ok((await rowById(id6b)).status === 'open', 'blast-radius: the still-differing row on file B is NOT over-closed');

  // ---- YS LOAN-NUMBER duplicate finding (the RTL -> duplicate -> DSCR class).
  // Before this fix Re-check returned 'unsupported' for a ys_loan_number finding
  // ("can't auto-clear it here") and the descope path never closed it, so the card
  // was stuck forever (Libby Baum / 1600 Mildred Ave, 2026-07-22).
  const ingest = require(R + '/src/clickup/ingest');

  // Case A — the finding is on a file that was DESCOPED (flipped to DSCR, soft-
  // deleted). Re-check closes it: nothing on a removed file can clash.
  const bLn = (await db.query("INSERT INTO borrowers(first_name,last_name,email,origin) VALUES('Libby','Baum',$1,'self') RETURNING id", [rnd()])).rows[0].id;
  const tGone = tk('lnGone');
  const appGone = (await db.query(
    "INSERT INTO applications(borrower_id,clickup_pipeline_task_id,deleted_at,sync_state) VALUES($1,$2,now(),'descoped') RETURNING id",
    [bLn, tGone])).rows[0].id;
  const numGone = `YSCAP${RUN}A`;
  const idGone = await openRow({ appId: appGone, borrowerId: bLn, taskId: tGone, fieldKey: 'ys_loan_number', clickupValue: numGone, portalValue: null });
  const outGone = await R2.recheckReview(await rowById(idGone), { clickup });
  ok(outGone.outcome === 'closed' && outGone.reason === 'file_removed', 'loan#: finding on a descoped (removed) file → recheck closes it (file_removed)');
  ok((await rowById(idGone)).status === 'resolved', 'loan#: descoped-file finding is marked resolved');

  // Case B — the number is no longer used on ANY other live file or ClickUp task
  // (the duplicate was cleared). Re-check closes it (no_longer_duplicated).
  const numFree = `YSCAP${RUN}B`;
  const tFree = tk('lnFree');
  const appFree = (await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id) VALUES($1,$2) RETURNING id', [bLn, tFree])).rows[0].id;
  setTaskField(tFree, F.PIPELINE.ysLoanNumber, null);   // this file's own task no longer carries it either
  const idFree = await openRow({ appId: appFree, borrowerId: bLn, taskId: tFree, fieldKey: 'ys_loan_number', clickupValue: numFree, portalValue: null });
  const outFree = await R2.recheckReview(await rowById(idFree), { clickup });
  ok(outFree.outcome === 'closed' && outFree.reason === 'no_longer_duplicated', 'loan#: number free everywhere → recheck closes it (no_longer_duplicated)');

  // Case C — the number is STILL owned by another LIVE file. Re-check keeps it open
  // (never a blind close — the clash is real until a human or the source clears it).
  const numOwned = `YSCAP${RUN}C`;
  const tOwner = tk('lnOwner'), tCopy = tk('lnCopy');
  await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id,ys_loan_number) VALUES($1,$2,$3)', [bLn, tOwner, numOwned]);   // the rightful owner holds it
  const appCopy = (await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id) VALUES($1,$2) RETURNING id', [bLn, tCopy])).rows[0].id;
  const idCopy = await openRow({ appId: appCopy, borrowerId: bLn, taskId: tCopy, fieldKey: 'ys_loan_number', clickupValue: numOwned, portalValue: null });
  const outCopy = await R2.recheckReview(await rowById(idCopy), { clickup });
  ok(outCopy.outcome === 'still_open' && outCopy.reason === 'still_duplicated', 'loan#: number still owned by another live file → stays open (still_duplicated)');
  ok((await rowById(idCopy)).status === 'open', 'loan#: the still-clashing row is left open');

  // Case D — STALE clickup_task_index cache: universe-2 still shows a data-only task
  // carrying the number, but a LIVE re-read of that task shows it was cleared. The
  // re-check must confirm live and close (a stale cache never keeps a finding open).
  const numStale = `YSCAP${RUN}D`;
  const tStaleOther = tk('lnStaleOther');   // a data-only DSCR task, no PILOT file
  await db.query(
    `INSERT INTO clickup_task_index (task_id, kind, snapshot, task_name)
     VALUES ($1,'data_only',$2,'stale dscr') ON CONFLICT (task_id) DO UPDATE SET snapshot=EXCLUDED.snapshot`,
    [tStaleOther, JSON.stringify({ app: { ys_loan_number: numStale } })]);
  setTaskField(tStaleOther, F.PIPELINE.ysLoanNumber, null);   // LIVE ClickUp: the number was cleared
  const tStaleFile = tk('lnStaleFile');
  const appStale = (await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id) VALUES($1,$2) RETURNING id', [bLn, tStaleFile])).rows[0].id;
  const idStale = await openRow({ appId: appStale, borrowerId: bLn, taskId: tStaleFile, fieldKey: 'ys_loan_number', clickupValue: numStale, portalValue: null });
  const outStale = await R2.recheckReview(await rowById(idStale), { clickup });
  ok(outStale.outcome === 'closed' && outStale.reason === 'no_longer_duplicated', 'loan#: stale cache but live task cleared → recheck confirms live and closes');
  // and if the cached task STILL carries it live, the row stays open
  const numStale2 = `YSCAP${RUN}E`;
  const tStaleOther2 = tk('lnStaleOther2');
  await db.query(
    `INSERT INTO clickup_task_index (task_id, kind, snapshot, task_name)
     VALUES ($1,'data_only',$2,'live dscr') ON CONFLICT (task_id) DO UPDATE SET snapshot=EXCLUDED.snapshot`,
    [tStaleOther2, JSON.stringify({ app: { ys_loan_number: numStale2 } })]);
  setTaskField(tStaleOther2, F.PIPELINE.ysLoanNumber, numStale2);   // LIVE ClickUp: still carries it
  const tStaleFile2 = tk('lnStaleFile2');
  const appStale2 = (await db.query('INSERT INTO applications(borrower_id,clickup_pipeline_task_id) VALUES($1,$2) RETURNING id', [bLn, tStaleFile2])).rows[0].id;
  const idStale2 = await openRow({ appId: appStale2, borrowerId: bLn, taskId: tStaleFile2, fieldKey: 'ys_loan_number', clickupValue: numStale2, portalValue: null });
  const outStale2 = await R2.recheckReview(await rowById(idStale2), { clickup });
  ok(outStale2.outcome === 'still_open', 'loan#: cache AND live task both still carry it → stays open');

  // ---- descopeFlipped() closes a descoped file's open FILE-LEVEL findings (Fix 2:
  // the RTL->DSCR flip now auto-heals the finding, no Re-check click needed).
  const tDesc = tk('descope');
  const appDesc = (await db.query(
    "INSERT INTO applications(borrower_id,clickup_pipeline_task_id,program,sync_state) VALUES($1,$2,'Fix & Flip w/ Construction','linked') RETURNING id",
    [bLn, tDesc])).rows[0].id;
  const idDescLoan = await openRow({ appId: appDesc, borrowerId: bLn, taskId: tDesc, fieldKey: 'ys_loan_number', clickupValue: `YSCAP${RUN}F`, portalValue: null });
  const idDescLink = await openRow({ appId: appDesc, borrowerId: bLn, taskId: tDesc, fieldKey: 'file_link', clickupValue: 'x', portalValue: null });
  const descRes = await ingest.descopeFlipped(tDesc);
  ok(descRes && String(descRes.id) === String(appDesc), 'descope: the flipped file was soft-deleted');
  ok((await rowById(idDescLoan)).status === 'resolved', 'descope: the copied-loan-number finding auto-closes');
  ok((await rowById(idDescLink)).status === 'resolved', 'descope: the file_link finding auto-closes');

  // clean up the test rows
  await db.query(`DELETE FROM clickup_task_index WHERE task_id = ANY($1)`, [[tStaleOther, tStaleOther2]]).catch(() => {});
  await db.query(`DELETE FROM sync_review_queue WHERE reason='test_recheck'`);
  await db.pool.end();
})().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(2); });

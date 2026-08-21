/* THE FUNDED DATE READS ITSELF OFF ENCOMPASS — against a REAL database.
 *
 * Owner-reported 2026-08-21: *"right now you need to enter a funded date in PILOT, and PILOT
 * does not automatically recognize from Encompass the funded date. We need to make sure that
 * whenever it is set up on an automatic basis, whatever the setup is, no matter how long it is,
 * we check any file that gets the funded date in Encompass filled, which I believe is
 * cx.fundeddate — it should automatically fill in the funded date for that file in PILOT and
 * should automatically change the status for that file, but it should still not be reconciled,
 * because reconciled will also require making sure ClickUp matches as well."*
 *
 * A pure test cannot prove any of this: every column this touches is real, and the whole point
 * of the feature is what lands ON the row. So this drives the REAL module against a REAL
 * Postgres and reads the row back afterwards.
 *
 * What it proves:
 *   1. the owner's own case, end to end — a processing file whose Encompass loan carries a
 *      funded date comes back with the date filled in and the status on Funded;
 *   2. IT DOES NOT RECONCILE — `closing_workflow` is byte-for-byte what it was, on a file that
 *      HAS a closing workflow, which is the only way that assertion can bite;
 *   3. FILL-ONLY — a date the closer typed survives;
 *   4. the refusals — declined, withdrawn, soft-deleted, no date;
 *   5. it is IDEMPOTENT — the second pull over the same loan writes nothing and says so;
 *   6. the move is real HISTORY, and the audit row says what happened;
 *   7. THE BORROWER IS NOT EMAILED and the watermark is untouched, so the borrower is still told
 *      at the moment ClickUp catches up — proven by running the shared inbound door afterwards;
 *   8. the back-book walk reaches a file nobody will pull again soon, resumes on its cursor, and
 *      stops when it is finished.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-encompass-funded-db.js
 */
'use strict';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

if (!process.env.DATABASE_URL) { console.log('SKIP test-encompass-funded-db (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const F = require('../src/lib/encompass-funded');

const day = (v) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
// The two shapes the tenant actually produces — the CX.FUNDEDDATE custom field is the real one,
// the closingDocument path is the JSON fallback. Both are exercised.
const loanWithCustomField = (d) => ({ customFields: [{ fieldName: 'CX.FUNDEDDATE', value: d }] });
const loanWithJsonPath = (d) => ({ closingDocument: { fundingDate: d } });

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let seq = 0;
  const mail = (t) => `encfund-${t}-${sfx}@test.local`;
  try {
    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email) VALUES('Enc','Funded',$1) RETURNING id`,
      [mail('bo')])).rows[0].id;

    const mkFile = async (over = {}) => {
      const r = (await db.query(
        `INSERT INTO applications(borrower_id,status,ys_loan_number,property_address,encompass_extra,funded_date)
         VALUES($1,$2,$3,'{"oneLine":"9 Funded Way","city":"Lakewood","state":"NJ","zip":"08701"}',$4::jsonb,$5)
         RETURNING id`,
        [bor, over.status || 'processing', `EF${sfx.slice(-6)}${String(++seq).padStart(3, '0')}`,
          over.extra === undefined ? null : JSON.stringify(over.extra),
          over.fundedDate || null])).rows[0];
      if (over.deleted) await db.query(`UPDATE applications SET deleted_at=now() WHERE id=$1`, [r.id]);
      return r.id;
    };
    const readFile = async (id) => (await db.query(
      `SELECT status, funded_date, status_notified_external, deleted_at FROM applications WHERE id=$1`, [id])).rows[0];

    // -------------------------------------------------- 1. the owner's own case, end to end
    {
      const f = await mkFile();
      const before = await readFile(f);
      eq('1a before: no funded date, not Funded', [day(before.funded_date), before.status], [null, 'processing']);

      const res = await F.syncFundedDate(db, f, loanWithCustomField('07/31/2026'));
      eq('1b the sync reports what it did', [res.fundedDate, res.filled, res.statusMoved], ['2026-07-31', true, true]);

      const after = await readFile(f);
      eq('1c the funded date is now on the file', day(after.funded_date), '2026-07-31');
      eq('1d …and the file is Funded', after.status, 'funded');
    }

    // The JSON fallback path has to work too — the tenant populates one or the other per loan.
    {
      const f = await mkFile();
      await F.syncFundedDate(db, f, loanWithJsonPath('2026-08-04T00:00:00Z'));
      const after = await readFile(f);
      eq('1e the closingDocument fallback lands the same way',
        [day(after.funded_date), after.status], ['2026-08-04', 'funded']);
    }

    // -------------------------------------------------- 2. IT DOES NOT RECONCILE
    // The owner's carve-out. Asserted on a file that HAS a closing workflow — on a file with
    // none, "closing_workflow is unchanged" is trivially true and proves nothing.
    {
      const f = await mkFile();
      await db.query(
        `INSERT INTO closing_workflow (application_id, stage) VALUES ($1,'wire_sent')
         ON CONFLICT (application_id) DO UPDATE SET stage='wire_sent'`, [f]);
      const cwBefore = (await db.query(
        `SELECT stage, fully_reconciled_at, reconciled_ok FROM closing_workflow WHERE application_id=$1`, [f])).rows[0];
      eq('2a CONTROL: the file really does have a closing workflow to disturb', cwBefore.stage, 'wire_sent');

      await F.syncFundedDate(db, f, loanWithCustomField('07/31/2026'));

      const cwAfter = (await db.query(
        `SELECT stage, fully_reconciled_at, reconciled_ok FROM closing_workflow WHERE application_id=$1`, [f])).rows[0];
      eq('2b the closing stage did not move', cwAfter.stage, 'wire_sent');
      eq('2c the file was NOT marked fully reconciled', cwAfter.fully_reconciled_at, null);
      eq('2d …nor reconciled_ok', cwAfter.reconciled_ok, null);
      eq('2e …and the funded date DID land, so this is not a no-op passing by accident',
        day((await readFile(f)).funded_date), '2026-07-31');
    }

    // -------------------------------------------------- 3. FILL-ONLY
    {
      const f = await mkFile({ fundedDate: '2026-01-05' });
      const res = await F.syncFundedDate(db, f, loanWithCustomField('07/31/2026'));
      const after = await readFile(f);
      eq('3a a date the closer typed is NOT replaced', day(after.funded_date), '2026-01-05');
      eq('3b …and the sync says it did not fill', res.filled, false);
      eq('3c …but the status still moved — the loan did fund', after.status, 'funded');
    }

    // -------------------------------------------------- 4. the refusals
    for (const st of ['declined', 'withdrawn']) {
      const f = await mkFile({ status: st });
      const res = await F.syncFundedDate(db, f, loanWithCustomField('07/31/2026'));
      const after = await readFile(f);
      eq(`4a a ${st} file is refused`, res.skipped, 'terminal_negative');
      eq(`4b …and NOTHING is written to it`, [day(after.funded_date), after.status], [null, st]);
    }
    {
      const f = await mkFile({ deleted: true });
      eq('4c a soft-deleted file is skipped',
        (await F.syncFundedDate(db, f, loanWithCustomField('07/31/2026'))).skipped, 'deleted');
      eq('4d …and nothing was written', day((await readFile(f)).funded_date), null);
    }
    {
      const f = await mkFile({ extra: { closingDocument: {} } });
      eq('4e an Encompass loan with no funded date does nothing',
        (await F.syncFundedDate(db, f, { closingDocument: {} })).skipped, 'no_funded_date');
      eq('4f …and the file is untouched', [day((await readFile(f)).funded_date), (await readFile(f)).status], [null, 'processing']);
    }

    // -------------------------------------------------- 5. idempotent
    {
      const f = await mkFile();
      await F.syncFundedDate(db, f, loanWithCustomField('07/31/2026'));
      const again = await F.syncFundedDate(db, f, loanWithCustomField('07/31/2026'));
      eq('5a a second pull over the same loan writes nothing', again.skipped, 'already_current');
      const rows = (await db.query(
        `SELECT count(*)::int n FROM audit_log
          WHERE entity_id=$1 AND action='encompass_funded_date_synced'`, [f])).rows[0].n;
      eq('5b …and there is exactly ONE audit row, not one per pull', rows, 1);
    }

    // -------------------------------------------------- 6. history + the audit record
    {
      const f = await mkFile({ status: 'underwriting' });
      await F.syncFundedDate(db, f, loanWithCustomField('07/31/2026'));
      const h = (await db.query(
        `SELECT from_status, to_status, source FROM application_status_history
          WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [f])).rows[0];
      eq('6a the move is recorded as real stage history',
        [h.from_status, h.to_status, h.source], ['underwriting', 'funded', 'system']);
      const a = (await db.query(
        `SELECT detail FROM audit_log WHERE entity_id=$1 AND action='encompass_funded_date_synced'`, [f])).rows[0];
      eq('6b the audit row says which date, and what it did',
        [a.detail.fundedDate, a.detail.filledDate, a.detail.statusFrom, a.detail.statusTo],
        ['2026-07-31', true, 'underwriting', 'funded']);
      eq('6c …and states on the record that it did NOT reconcile', a.detail.reconciled, false);
    }

    // -------------------------------------------------- 7. the borrower is told LATER, not now
    // Moving `status_notified_external` here would make the "your loan is funded" email silent
    // forever after, because the ClickUp echo that sends it reads as already-announced. Proven
    // by running the shared inbound door afterwards and watching it still fire.
    {
      const f = await mkFile();
      // A file the sync has seen before — its watermark is set, so the go-forward baseline is
      // already past and the next real change WOULD notify.
      await db.query(`UPDATE applications SET status_notified_external='processing' WHERE id=$1`, [f]);

      let borrowerEmails = 0;
      const notify = require('../src/lib/notify');
      const realBorrowers = notify.notifyAppBorrowers;
      notify.notifyAppBorrowers = async () => { borrowerEmails += 1; return []; };
      const realStaff = notify.notifyAppStaff;
      let staffTold = 0;
      notify.notifyAppStaff = async () => { staffTold += 1; return []; };
      try {
        await F.syncFundedDate(db, f, loanWithCustomField('07/31/2026'));
        eq('7a the borrower is NOT emailed by this door', borrowerEmails, 0);
        eq('7b …but the team IS told — nobody in PILOT made this move', staffTold, 1);
        eq('7c the watermark is left exactly where it was',
          (await readFile(f)).status_notified_external, 'processing');

        // …so when ClickUp catches up, the borrower is told at the right moment.
        await require('../src/lib/status-notify').notifyInboundStatusChange(f, 'funded');
        eq('7d the borrower IS told once ClickUp agrees — the announcement was not swallowed',
          borrowerEmails, 1);
        eq('7e …and the watermark advances then', (await readFile(f)).status_notified_external, 'funded');
      } finally {
        notify.notifyAppBorrowers = realBorrowers;
        notify.notifyAppStaff = realStaff;
      }
    }

    // -------------------------------------------------- 8. the back book
    // The per-file pull is a round-robin that takes ONE file every 15 minutes, so a file's turn
    // comes round once every (files ÷ ~96) days. Every file pulled before this shipped is sitting
    // on a stored loan JSON that already carries the date. This walks it, with no Encompass call.
    {
      await db.query(`DELETE FROM sync_runtime_state WHERE key=$1`, [F.STATE_KEY]);
      const stale = await mkFile({ extra: loanWithCustomField('06/15/2026') });
      const quiet = await mkFile({ extra: { closingDocument: {} } });

      let scanned = 0, filled = 0, done = false;
      // Walk in small steps so the RESUME is exercised, not just the happy path.
      for (let i = 0; i < 60 && !done; i++) {
        const r = await F.backfillStoredFundedDatesOnce({ dbc: db, limit: 3 });
        scanned += r.scanned; filled += r.filled; done = r.done;
        if (r.skipped) { ok(`8x the walk did not error (${r.skipped})`, false); break; }
      }
      ok('8a the walk finishes', done);
      ok('8b …having scanned real files', scanned > 0);
      eq('8c the back-book file got its date with no Encompass call', day((await readFile(stale)).funded_date), '2026-06-15');
      eq('8d …and its status', (await readFile(stale)).status, 'funded');
      eq('8e a file whose Encompass loan has no funded date is untouched',
        [day((await readFile(quiet)).funded_date), (await readFile(quiet)).status], [null, 'processing']);
      ok('8f it filled at least the one file we planted', filled >= 1);

      const again = await F.backfillStoredFundedDatesOnce({ dbc: db, limit: 3 });
      eq('8g a finished walk does not start over — it is a ONE-SHOT, not a timer', again.skipped, 'already_done');

      const st = (await db.query(`SELECT value FROM sync_runtime_state WHERE key=$1`, [F.STATE_KEY])).rows[0].value;
      ok('8h …and the marker records when it finished', !!st.finishedAt);

      // The off-switch is real.
      await db.query(`DELETE FROM sync_runtime_state WHERE key=$1`, [F.STATE_KEY]);
      process.env.ENCOMPASS_FUNDED_BACKFILL_DISABLED = '1';
      eq('8i the off-switch stops it dead',
        (await F.backfillStoredFundedDatesOnce({ dbc: db, limit: 3 })).skipped, 'disabled');
      delete process.env.ENCOMPASS_FUNDED_BACKFILL_DISABLED;
    }
  } finally {
    await db.query(`DELETE FROM sync_runtime_state WHERE key=$1`, [F.STATE_KEY]).catch(() => {});
    await db.query(
      `DELETE FROM applications WHERE ys_loan_number LIKE $1`, [`EF${sfx.slice(-6)}%`]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [`encfund-%-${sfx}@test.local`]).catch(() => {});
    console.log(`${pass} passed, ${fail} failed`);
    await db.pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();

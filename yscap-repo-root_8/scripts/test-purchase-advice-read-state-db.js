/* THE FALSE PURCHASE-ADVICE CHASE — what the last read of that field actually did (db/608),
 * against a REAL database. Owner-reported 2026-08-21.
 *
 * THE REPORT. File YSCAP258134650 received "No purchase advice 64 days after funding" — and the
 * loan HAS a purchase advice date. *"There are a lot of files that receive an email that are
 * missing a PA date, but most of the files already have it. We need to dive into this and check
 * out what the system is doing wrong."*
 *
 * WHAT IT WAS DOING WRONG. The chase fired on `applications.purchase_advice_date IS NULL`, a
 * column only ever written when a per-file Encompass pull actually reads the field back. Three
 * ordinary things leave it NULL on a loan that plainly has an advice date, and the chase could not
 * tell any of them from "Encompass says none":
 *   · the file has not come round on the pull rota yet (ONE file every 15 minutes, round-robin by
 *     staleness across the whole book — days to weeks per file on a real book);
 *   · PILOT holds no Encompass loan guid for the file, so no field was ever read;
 *   · the read ran and Encompass did not return that id — which is what `client.readFields` does
 *     with an id the tenant does not permit: it splits the batch on the 400 and merges what
 *     SUCCEEDED, so a bad id goes MISSING rather than raising.
 *
 * WHAT THIS SUITE PROVES, and every section is here because a pure test structurally cannot reach
 * it — the columns, the queries and the sweep all sit inside catch blocks, which is the repo's #1
 * bug class (a phantom column reports a confident, wrong "nothing to do" forever):
 *
 *   A. db/608's three columns and their CHECK are real, and the read is recorded on every path.
 *   B. THE OWNER'S FILE. A funded file nobody has asked about is NOT chased any more — and the
 *      SAME file, once Encompass has actually answered empty, IS.
 *   C. The sweep re-reads the funded book one field at a time and stamps what it found, including
 *      the honest `no_loan_link` for a file with no Encompass loan.
 *   D. Silence cannot hide a broken field: the not-judged pile is reported on its own.
 *   E. The diagnosis answers the owner's "give me the field that you have" from the TENANT'S OWN
 *      cached field list, not from our notes about it.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-purchase-advice-read-state-db.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-purchase-advice-read-state-db (no DATABASE_URL)');
  process.exit(0);
}

const crypto = require('crypto');
const db = require('../src/db');
const RP = require('../src/sitewire/release-party');
const DIAG = require('../src/lib/purchase-advice-diagnosis');
const DIG = require('../src/lib/notification-digests');

// The field id this deployment reads. Every fixture stamps and asserts against THIS rather than a
// hard-coded 2370, so the suite still means what it says on a deployment that overrode it.
const FIELD_ID = String(require('../src/lib/integrations/encompass-field-map').PA_DATE_FIELD_ID || '');

(async () => {
  const mk = async (o = {}) => {
    const email = 'pars' + crypto.randomBytes(6).toString('hex') + '@example.com';
    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email) VALUES('Read','State',$1) RETURNING id`, [email])).rows[0].id;
    const app = (await db.query(
      `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address,loan_amount,funded_date,encompass_loan_guid)
       VALUES($1,$2,$3,$4,'{"oneLine":"30 Ellsworth Ave","city":"New Haven","state":"CT","zip":"06511"}',410400,$5,$6)
       RETURNING id`,
      [bor, o.status || 'funded', 'PARS' + crypto.randomBytes(4).toString('hex'),
        o.lender || 'EMCAP Financial',
        o.fundedDaysAgo == null ? null : new Date(Date.now() - o.fundedDaysAgo * 86400000).toISOString().slice(0, 10),
        o.guid === undefined ? 'guid-' + crypto.randomBytes(8).toString('hex') : o.guid])).rows[0].id;
    // Not table funded, so the chase's own file-level checks all pass and the ONLY thing under
    // test is the read state.
    await db.query(
      `INSERT INTO closing_workflow(application_id, warehouse, table_funded) VALUES($1,'Stride Bank',false)
       ON CONFLICT (application_id) DO UPDATE SET warehouse='Stride Bank', table_funded=false`, [app]);
    return app;
  };
  const readRow = async (app) => (await db.query(
    `SELECT purchase_advice_date, purchase_advice_read_at, purchase_advice_read_state, purchase_advice_field_id
       FROM applications WHERE id=$1`, [app])).rows[0];
  const wasChased = async (app) => !!(await db.query(
    `SELECT 1 FROM audit_log WHERE action='purchase_advice_missing' AND entity_id=$1 LIMIT 1`, [app])).rows[0];

  // ======================================================================
  // A. THE COLUMNS ARE REAL, and every read path records what it did
  // ======================================================================
  {
    const app = await mk({ fundedDaysAgo: 64 });
    eq('A1 a fresh funded file has never been asked', (await readRow(app)).purchase_advice_read_at, null);

    // Encompass answered with the field, carrying a date.
    await RP.syncPurchaseAdviceDate(db, app, { [FIELD_ID]: '2026-07-31' });
    let r = await readRow(app);
    eq('A2 a date came back — the verdict is "value"', r.purchase_advice_read_state, 'value');
    ok('A3 …the read is timestamped', !!r.purchase_advice_read_at);
    eq('A4 …the field id it came from is recorded on the file', r.purchase_advice_field_id, FIELD_ID);
    eq('A5 …and the date landed on the loan', String(r.purchase_advice_date).slice(0, 10), '2026-07-31');

    // Encompass answered with the field, and it is empty. A PRESENT-BUT-EMPTY key is a real answer
    // about the loan, and it is the only state the chase may fire on.
    const app2 = await mk({ fundedDaysAgo: 64 });
    await RP.syncPurchaseAdviceDate(db, app2, { [FIELD_ID]: '' });
    eq('A6 the field came back empty — the verdict is "blank"', (await readRow(app2)).purchase_advice_read_state, 'blank');

    // THE READ RAN AND THAT ID WAS NOT IN THE ANSWER. This is what `client.readFields` produces for
    // an id the tenant does not permit — it splits its batch on the 400 and merges what SUCCEEDED,
    // so a bad id is MISSING from the map rather than raising. Conflating it with "empty" is what
    // would let one unpermitted field chase the entire funded book.
    const app3 = await mk({ fundedDaysAgo: 64 });
    await RP.syncPurchaseAdviceDate(db, app3, { 364: 'some other field' });
    const r3 = await readRow(app3);
    eq('A7 the id was not in the answer — the verdict is "not_returned", NOT "blank"', r3.purchase_advice_read_state, 'not_returned');
    eq('A8 …and no date is invented on the loan', r3.purchase_advice_date, null);

    // THE READ ITSELF FAILED (an outage, an auth problem). Deliberately NOT stamped: that is
    // transient, and stamping it would drain the file out of the sweep and let one bad minute
    // stand as an answer about the loan.
    const app4 = await mk({ fundedDaysAgo: 64 });
    await RP.syncPurchaseAdviceDate(db, app4, null);
    eq('A9 a failed read stamps NOTHING, so the file stays in the sweep', (await readRow(app4)).purchase_advice_read_at, null);

    // The CHECK constraint is real — a state nobody defined can never reach the column.
    let threw = null;
    try {
      await db.query(`UPDATE applications SET purchase_advice_read_state='probably' WHERE id=$1`, [app]);
    } catch (e) { threw = e; }
    ok('A10 the database refuses a state that is not one of the five', !!threw);
  }

  // ======================================================================
  // B. THE OWNER'S FILE — never asked is not an answer
  // ======================================================================
  {
    // A funded file 64 days old, not table funded, buyer that genuinely has to be sold — the exact
    // shape the owner's email went out on — that PILOT has simply never asked Encompass about.
    const app = await mk({ fundedDaysAgo: 64, lender: 'CorrFirst' });
    await DIG.purchaseAdviceMissingOnce();
    ok('B1 a funded file PILOT has never asked about is NOT chased', !(await wasChased(app)));

    // Now Encompass actually answers, and it answers EMPTY. The same file, same age, same buyer —
    // the ONLY thing that changed is that we have a real answer about this loan.
    await RP.syncPurchaseAdviceDate(db, app, { [FIELD_ID]: '' });
    await DIG.purchaseAdviceMissingOnce();
    ok('B2 …and once Encompass has answered empty, it IS chased', await wasChased(app));

    // The other two not-answers must be as silent as "never asked", for the same reason.
    const noLoan = await mk({ fundedDaysAgo: 64, lender: 'CorrFirst', guid: null });
    await RP.stampPaRead(db, noLoan, RP.PA_READ.NO_LOAN_LINK, FIELD_ID);
    const notReturned = await mk({ fundedDaysAgo: 64, lender: 'CorrFirst' });
    await RP.syncPurchaseAdviceDate(db, notReturned, { 364: 'x' });
    await DIG.purchaseAdviceMissingOnce();
    ok('B3 a file with no Encompass loan linked is not chased — we had nothing to ask', !(await wasChased(noLoan)));
    ok('B4 a file whose field was not in the answer is not chased — we cannot judge it', !(await wasChased(notReturned)));

    // And the email itself no longer states the buyer as fact — the owner's file named CorrFirst
    // on a deal they know as EMCAP, which makes the whole message read as nonsense.
    const note = (await db.query(
      `SELECT body FROM notifications WHERE application_id=$1 AND type='purchase_advice_missing' LIMIT 1`, [app])).rows[0];
    ok('B5 the chase quotes the buyer as what the FILE RECORDS, never as fact',
      note && /records the buyer as/i.test(String(note.body)));
    ok('B6 …and tells the reader what to do if the loan does have a date in Encompass',
      note && /reading the wrong field/i.test(String(note.body)));
  }

  // ======================================================================
  // C. THE SWEEP — "refresh your entire system and make sure it's looking at the correct field"
  // ======================================================================
  {
    // A stub Encompass client: the whole path is provable with no network and no credentials,
    // which is the same injectable-client discipline `refreshSoldSignal` already uses.
    const asked = [];
    const stub = {
      configured: () => true,
      readFields: async (guid, ids) => { asked.push({ guid, ids }); return { [FIELD_ID]: '2026-08-01' }; },
    };
    const withDate = await mk({ fundedDaysAgo: 5 });
    const noLoan = await mk({ fundedDaysAgo: 5, guid: null });

    const out = await RP.sweepPurchaseAdviceOnce(db, { limit: 200, gapMs: 0, client: stub });
    ok('C1 the sweep runs against the real schema and looks at files', out && out.looked > 0);
    eq('C2 …reading exactly ONE field by number, never the whole loan',
      asked.length ? asked[0].ids : null, [FIELD_ID]);
    ok('C3 …and never a pipeline search: every call carries a cached loan guid',
      asked.every((a) => !!a.guid));

    const r = await readRow(withDate);
    eq('C4 a file the sweep reached now carries a stated verdict', r.purchase_advice_read_state, 'value');
    eq('C5 …and the date it read', String(r.purchase_advice_date).slice(0, 10), '2026-08-01');

    const r2 = await readRow(noLoan);
    eq('C6 a file with no Encompass loan is stamped honestly, not left to be re-asked forever',
      r2.purchase_advice_read_state, 'no_loan_link');
    ok('C7 …and it is counted as such rather than folded into the answers', out.noLoanLink > 0);

    // IT DRAINS. Least-recently-asked first, so a bounded pass always resumes where it stopped and
    // the same file is never re-read while another has never been asked at all.
    const before = (await db.query(
      `SELECT count(*)::int n FROM applications WHERE deleted_at IS NULL AND status='funded' AND purchase_advice_read_at IS NULL`)).rows[0].n;
    await RP.sweepPurchaseAdviceOnce(db, { limit: 200, gapMs: 0, client: stub });
    const after = (await db.query(
      `SELECT count(*)::int n FROM applications WHERE deleted_at IS NULL AND status='funded' AND purchase_advice_read_at IS NULL`)).rows[0].n;
    ok('C8 the sweep drains the never-asked pile rather than circling', after <= before);

    // A FAILING READ MUST NOT STAMP. One bad minute cannot be allowed to drain a real file out of
    // the sweep carrying a verdict nobody read.
    const boom = await mk({ fundedDaysAgo: 5 });
    const angry = { configured: () => true, readFields: async () => { throw new Error('encompass is down'); } };
    const out2 = await RP.sweepPurchaseAdviceOnce(db, { limit: 200, gapMs: 0, client: angry });
    ok('C9 a sweep whose reads all fail never throws', !!out2);
    eq('C10 …and leaves the file unstamped, so the next pass tries again',
      (await readRow(boom)).purchase_advice_read_at, null);
    ok('C11 …and says so in its summary rather than reporting a silent success', out2.readFailed > 0);

    // DISCOVERY IS NOT AN ANNOUNCEMENT. The sweep asks about files PILOT has never asked about, so
    // on a first read a purchase advice dated months ago lands as "changed" — and firing the
    // post-purchase hand-off would email the desk "this loan has been sold" about every such file
    // at once on the first deploy, and drag every ClickUp card forward with it. The date still
    // lands (that is the fix); the file is COUNTED as discovered instead.
    {
      const fresh = await mk({ fundedDaysAgo: 120 });
      const before = (await db.query(
        `SELECT count(*)::int n FROM notifications WHERE application_id=$1`, [fresh])).rows[0].n;
      const o = await RP.sweepPurchaseAdviceOnce(db, { limit: 200, gapMs: 0, client: stub });
      const r3 = await readRow(fresh);
      eq('C13 the date still lands on a file the sweep is meeting for the first time',
        String(r3.purchase_advice_date).slice(0, 10), '2026-08-01');
      eq('C14 …so every reader treats it as sold from that moment', (await RP.releaseStateFor(db, fresh)).sold, 'sold');
      const after = (await db.query(
        `SELECT count(*)::int n FROM notifications WHERE application_id=$1`, [fresh])).rows[0].n;
      eq('C15 …and NOBODY is emailed about a sale PILOT has only just noticed', after, before);
      ok('C16 …but it is counted and reported, never silently swallowed', o.discovered > 0);
      eq('C17 …and the file is not left permanently unannounceable', (await db.query(
        `SELECT purchase_advice_notified_at FROM applications WHERE id=$1`, [fresh])).rows[0].purchase_advice_notified_at, null);

      // A DATE THAT ARRIVES ON A FILE WE ARE ALREADY WATCHING IS STILL NEWS — the suppression is
      // about the first read, not about the sweep, so it can never go quiet permanently.
      const moved = { configured: () => true, readFields: async () => ({ [FIELD_ID]: '2026-08-09' }) };
      await db.query(`UPDATE applications SET purchase_advice_date=NULL WHERE id=$1`, [fresh]);
      await RP.sweepPurchaseAdviceOnce(db, { limit: 400, gapMs: 0, client: moved });
      const after2 = (await db.query(
        `SELECT count(*)::int n FROM notifications WHERE application_id=$1`, [fresh])).rows[0].n;
      ok('C18 …a LATER read of the same file announces exactly as it always did', after2 > after);
    }

    // It never touches a file that is not funded — a purchase advice belongs to a closed loan.
    const open = await mk({ fundedDaysAgo: null, status: 'underwriting' });
    await RP.sweepPurchaseAdviceOnce(db, { limit: 200, gapMs: 0, client: stub });
    eq('C12 an unfunded file is never asked about', (await readRow(open)).purchase_advice_read_at, null);
  }

  // ======================================================================
  // D. SILENCE CANNOT HIDE A BROKEN FIELD
  // ======================================================================
  //
  // The chase is now quiet on every file PILOT cannot judge — which is right, and which is exactly
  // how a broken field id would come to look like a clean book. So the not-judged pile is reported
  // as its own thing, to super admins, in its own words.
  {
    await db.query(`DELETE FROM audit_log WHERE action='purchase_advice_unreadable'`);
    const stuck = await mk({ fundedDaysAgo: 90, lender: 'CorrFirst' });
    await RP.syncPurchaseAdviceDate(db, stuck, { 364: 'x' });   // not_returned
    const sent = await DIG.purchaseAdviceUnreadableOnce();
    ok('D1 the not-judged pile is reported', sent >= 0);
    const stamp = (await db.query(
      `SELECT detail FROM audit_log WHERE action='purchase_advice_unreadable' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    ok('D2 …with a stamp recording what it counted', !!stamp);
    ok('D3 …including the file whose field came back missing', stamp && Number(stamp.detail.notReturned) > 0);
    ok('D4 …and the field id it was asking for', stamp && String(stamp.detail.fieldId || '') === FIELD_ID);

    const note = (await db.query(
      `SELECT title, body FROM notifications WHERE type='purchase_advice_missing' AND application_id IS NULL
        ORDER BY created_at DESC LIMIT 1`)).rows[0];
    ok('D5 the alert says PILOT cannot TELL, never that the loans are unsold',
      note && /cannot tell/i.test(note.title) && /not saying they are unsold/i.test(String(note.body)));
    ok('D6 …and states which field it is reading', note && new RegExp(`field ${FIELD_ID}`).test(String(note.body)));

    const again = await DIG.purchaseAdviceUnreadableOnce();
    eq('D7 …and it is self-gating, so nobody is told twice in a week', again, 0);
  }

  // ======================================================================
  // E. "GIVE ME THE FIELD THAT YOU HAVE" — from the tenant's OWN field list
  // ======================================================================
  {
    const d = await DIAG.diagnose(db);
    eq('E1 the diagnosis names the field id PILOT actually asks for', d.field.fieldId, FIELD_ID || null);
    ok('E2 …and says where that id came from', !!d.field.configuredBy);
    ok('E3 …and counts what the last read did across the funded book', d.reads && d.reads.funded > 0);
    ok('E4 …and answers in plain language', typeof d.summary === 'string' && d.summary.length > 20);

    // The tenant's own cached field list is what answers "is that the right field?" — a number we
    // restated from our own configuration proves nothing, since it is the number that produced the
    // wrong answer in the first place.
    await db.query(
      `INSERT INTO encompass_field_catalog(kind,key,label,raw)
       VALUES('standardField',$1,'Purchase Advice Date','{"description":"Purchase Advice Date"}'::jsonb)
       ON CONFLICT (kind,key) DO UPDATE SET label=EXCLUDED.label, raw=EXCLUDED.raw`,
      [FIELD_ID || '2370']);
    const d2 = await DIAG.fieldDiagnosis(db);
    eq('E5 with the tenant\'s field list pulled, the id we read is recognised', d2.known, true);
    eq('E6 …and reported under the tenant\'s OWN label for it', d2.knownLabel, 'Purchase Advice Date');
    ok('E7 …and it is listed among the fields whose name mentions a purchase advice',
      (d2.candidates || []).some((c) => String(c.key) === (FIELD_ID || '2370')));

    // An id the tenant's list does NOT carry is the interesting state — it is exactly how
    // `client.readFields` ends up dropping it from the answer.
    await db.query(`DELETE FROM encompass_field_catalog WHERE kind='standardField' AND key=$1`, [FIELD_ID || '2370']);
    await db.query(
      `INSERT INTO encompass_field_catalog(kind,key,label,raw)
       VALUES('customField','CX.PURCHASEADVICE','Purchase advice date','{}'::jsonb)
       ON CONFLICT (kind,key) DO UPDATE SET label=EXCLUDED.label`);
    const d3 = await DIAG.fieldDiagnosis(db);
    eq('E8 an id the tenant does not have is reported as not known', d3.known, false);
    const line = DIAG.summarize(d3, { not_returned: 3, never_asked: 0, value: 0, blank: 0, no_loan_link: 0 });
    ok('E9 …and the plain-language answer names what the tenant DOES have instead',
      /does not contain it/.test(line) && /CX\.PURCHASEADVICE/.test(line));
    await db.query(`DELETE FROM encompass_field_catalog WHERE kind='customField' AND key='CX.PURCHASEADVICE'`);
  }

  console.log(fail ? `test-purchase-advice-read-state-db: ${pass} passed, ${fail} FAILED` : `test-purchase-advice-read-state-db: all ${pass} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-purchase-advice-read-state-db threw:', e); process.exit(1); });

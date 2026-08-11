/* TABLE FUNDING AND THE MISSING PURCHASE ADVICE — against a REAL database
 * (owner-directed 2026-08-09).
 *
 * The pure suite (scripts/test-funding-channel-pure.js) proves the RULES. This one proves the
 * WIRING, and every section here exists because a pure test structurally cannot reach it:
 *
 *   A. THE COLUMNS ARE REAL. Both new queries — the reconcile SELECT's `LEFT JOIN closing_workflow
 *      … cw.table_funded`, and the chase sweep's join onto `purchasing_advice.advice_date` plus its
 *      two jsonb reads of the Encompass channel — sit inside catch blocks. A phantom column there
 *      is the repo's #1 bug class: the query throws, the catch swallows it, and the feature reports
 *      a confident, wrong "nothing to do" forever. Only a real database can say the names exist.
 *   B. The sold status, read off real rows, once the closer picks the Table Funding warehouse.
 *   C. The chase FIRES on a direct loan 30 days past funding…
 *   D. …and is SILENT on every file it must never nag: table funded (either signal), an advice
 *      already recorded (in either of the two places one can be recorded), and too soon.
 *   E. It is self-gating, so nobody is told twice in a week.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-purchase-advice-chase-db.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-purchase-advice-chase-db (no DATABASE_URL)');
  process.exit(0);
}

const crypto = require('crypto');
const db = require('../src/db');
const RP = require('../src/sitewire/release-party');
const RECON = require('../src/encompass/reconcile');
const DIG = require('../src/lib/notification-digests');

(async () => {
  const mkFile = async (opts) => {
    const o = opts || {};
    const email = 'pa' + crypto.randomBytes(6).toString('hex') + '@example.com';
    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email) VALUES('Purchase','Advice',$1) RETURNING id`, [email])).rows[0].id;
    const loan = 'PA' + crypto.randomBytes(4).toString('hex');
    const app = (await db.query(
      `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address,loan_amount,funded_date,purchase_advice_date,encompass_extra)
       VALUES($1,$2,$3,$4,'{"oneLine":"14 Held St","city":"Scranton","state":"PA","zip":"18505"}',400000,$5,$6,$7)
       RETURNING id`,
      [bor, o.status || 'funded', loan, o.lender || 'Blue Lake Capital',
        o.fundedDaysAgo == null ? null : new Date(Date.now() - o.fundedDaysAgo * 86400000).toISOString().slice(0, 10),
        o.paDate || null,
        o.channel ? JSON.stringify({ _fieldValues: { 'CX.TABLEFUNDER': o.channel } }) : null])).rows[0].id;
    if (o.warehouse !== undefined) {
      await db.query(
        `INSERT INTO closing_workflow(application_id, warehouse, table_funded)
         VALUES($1,$2,$3) ON CONFLICT (application_id) DO UPDATE SET warehouse=$2, table_funded=$3`,
        [app, o.warehouse, o.warehouse === 'Table Funding']);
    }
    if (o.adviceRecorded) {
      await db.query(
        `INSERT INTO purchasing_advice(application_id, advice_date) VALUES($1,$2)
         ON CONFLICT (application_id) DO UPDATE SET advice_date=$2`, [app, o.adviceRecorded]);
    }
    return app;
  };

  // Did the sweep tell anyone about THIS file? Read off the sweep's own self-gate stamp rather than
  // its return count, so one run can be checked per file — and so a file it skipped is provably
  // skipped rather than merely absent from a total.
  const wasChased = async (app) => !!(await db.query(
    `SELECT 1 FROM audit_log WHERE action='purchase_advice_missing' AND entity_id=$1 LIMIT 1`, [app])).rows[0];

  // ======================================================================
  // A. THE COLUMNS ARE REAL — the phantom-column-in-a-swallowing-catch class
  // ======================================================================
  {
    const app = await mkFile({ warehouse: 'Stride Bank', fundedDaysAgo: 40 });

    // The reconcile SELECT. computeFindings swallows nothing, but its query is long and the join is
    // new; if `cw.table_funded` did not exist this would throw right here.
    const f = await RECON.computeFindings(app, db);
    ok('A1 the reconcile SELECT runs with the closing_workflow join', f && f.found === true);
    ok('A2 …and answers for a file with no Encompass copy without inventing a channel row',
      !(f.fields || []).some((x) => x.key === 'funding_channel_rule'));

    // buildOurValues emits the channel from the closer's warehouse pick.
    const ours = RECON.buildOurValues({ table_funded: false }, null, null);
    eq('A3 a chosen non-table-funding warehouse states "Direct RTL"', ours.funding_channel, 'Direct RTL');
    eq('A4 …the Table Funding line states so', RECON.buildOurValues({ table_funded: true }, null, null).funding_channel, 'Table Funding');
    eq('A5 …and a file that has not reached the closing desk states NOTHING (so the row reads "Doesn\'t apply")',
      RECON.buildOurValues({}, null, null).funding_channel, undefined);

    // The sweep's own query — the purchasing_advice join and both jsonb channel reads.
    let threw = null;
    try { await DIG.purchaseAdviceMissingOnce(); } catch (e) { threw = e; }
    ok('A6 the chase sweep runs against the real schema', !threw);
  }

  // ======================================================================
  // B. THE SOLD STATUS, off real rows
  // ======================================================================
  {
    const tf = await mkFile({ warehouse: 'Table Funding', fundedDaysAgo: 90 });
    const s = await RP.releaseStateFor(db, tf);
    eq('B1 a table-funded file reads SOLD with no purchase advice date at all', s.sold, 'sold');
    eq('B2 …and says WHY', s.soldVia, 'table_funding');
    eq('B3 …so no investor-delivery warning is raised', s.warning, null);

    const direct = await mkFile({ warehouse: 'Stride Bank', fundedDaysAgo: 90 });
    const s2 = await RP.releaseStateFor(db, direct);
    ok('B4 a direct file with no purchase advice does NOT read as sold', s2.sold !== 'sold');
    ok('B5 …and does raise the warning', !!s2.warning);
    ok('B6 …which offers carrying on, per the owner\'s revised default', /go ahead/i.test(s2.warning.body));

    // Encompass's own answer is enough on its own, even with no closing_workflow row.
    const enc = await mkFile({ channel: 'Table Funding', fundedDaysAgo: 90 });
    eq('B7 Encompass saying table funding is enough on its own', (await RP.releaseStateFor(db, enc)).sold, 'sold');
  }

  // ======================================================================
  // C. THE CHASE FIRES on the file the owner described
  // ======================================================================
  {
    const app = await mkFile({ warehouse: 'Stride Bank', fundedDaysAgo: 45, lender: 'Blue Lake Capital' });
    await DIG.purchaseAdviceMissingOnce();
    ok('C1 a direct loan 45 days past funding with no purchase advice is chased', await wasChased(app));

    const row = (await db.query(
      `SELECT detail FROM audit_log WHERE action='purchase_advice_missing' AND entity_id=$1 LIMIT 1`, [app])).rows[0];
    ok('C2 …and the stamp records how old it is', row && Number(row.detail && row.detail.days) >= 45);

    // Somebody was actually told. The closer is optional on a file, so the super-admin fan-out is
    // what must always happen — assert the notification rows exist rather than trusting a count.
    const notes = (await db.query(
      `SELECT count(*)::int n FROM notifications WHERE application_id=$1 AND type='purchase_advice_missing'`, [app])).rows[0];
    ok('C3 …and a notification was actually written', notes && notes.n > 0);
  }

  // ======================================================================
  // D. AND IS SILENT on every file it must never nag
  // ======================================================================
  {
    const cases = [
      ['D1 table funded (our warehouse) — no purchase advice is ever coming',
        { warehouse: 'Table Funding', fundedDaysAgo: 60 }],
      ['D2 table funded (Encompass says so) even with no warehouse picked',
        { channel: 'Table Funding', fundedDaysAgo: 60 }],
      ['D3 table funded (Encompass, as a Y/N flag)',
        { channel: 'Y', fundedDaysAgo: 60 }],
      ['D4 the purchase advice date is already on the file',
        { warehouse: 'Stride Bank', fundedDaysAgo: 60, paDate: '2026-06-01' }],
      ['D5 …or a human recorded it on the purchasing desk',
        { warehouse: 'Stride Bank', fundedDaysAgo: 60, adviceRecorded: '2026-06-01' }],
      ['D6 funded only a week ago — too soon to chase',
        { warehouse: 'Stride Bank', fundedDaysAgo: 7 }],
      ['D7 never funded at all',
        { warehouse: 'Stride Bank', fundedDaysAgo: null }],
      ['D8 not a funded file yet',
        { warehouse: 'Stride Bank', fundedDaysAgo: 60, status: 'clear_to_close' }],
      // THE BUYER'S OWN ANSWER (owner-directed 2026-08-09: "all the other RCN, [Roc], and Temple
      // View are also table funded, so we don't need a reminder"). These three are silent EVEN ON
      // a file our closing desk did not mark table funded — the exclusion is about the buyer, not
      // about the file, which is exactly why the file-level check above cannot express it.
      ['D9 RCN — table funded as a matter of course, so never chased',
        { warehouse: 'Stride Bank', fundedDaysAgo: 60, lender: 'RCN Capital' }],
      ['D10 Roc Capital (the owner\'s "Rack") — likewise',
        { warehouse: 'Stride Bank', fundedDaysAgo: 60, lender: 'Roc Capital' }],
      ['D11 Temple View — likewise',
        { warehouse: 'Stride Bank', fundedDaysAgo: 60, lender: 'Temple View Capital' }],
    ];
    const made = [];
    for (const [, opts] of cases) made.push(await mkFile(opts));
    await DIG.purchaseAdviceMissingOnce();
    for (let i = 0; i < cases.length; i++) ok(cases[i][0], !(await wasChased(made[i])));
  }

  // ======================================================================
  // D2. …AND STILL FIRES for the buyers whose loans really do have to be sold
  // ======================================================================
  //
  // The owner: "blue lake emcap corrfirst — only stuff that needs to be sold to get this reminder.
  // Fidelis is on a case-by-case basis." So Fidelis is NOT excluded by buyer: a Fidelis file that
  // was not table funded genuinely has to be sold, and its table-funded files are already silenced
  // by the file-level check (proven in D1). An unrecognised buyer is chased too — going silent on
  // a note buyer nobody has classified yet would be a gap that appears the day one is added.
  {
    const cases = [
      ['D12 Blue Lake — a loan that really has to be sold', 'Blue Lake Capital'],
      ['D13 EMCAP — likewise', 'EMCAP Financial'],
      ['D14 CorrFirst — likewise', 'CorrFirst'],
      ['D15 Fidelis NOT table funded — the owner\'s case-by-case, so still chased', 'Fidelis Investors LLC'],
      ['D16 a buyer nobody has classified yet is chased, never silently skipped', 'Some New Buyer LLC'],
    ];
    const made = [];
    for (const [, lender] of cases) made.push(await mkFile({ warehouse: 'Stride Bank', fundedDaysAgo: 60, lender }));
    await DIG.purchaseAdviceMissingOnce();
    for (let i = 0; i < cases.length; i++) ok(cases[i][0], await wasChased(made[i]));
  }

  // ======================================================================
  // E. SELF-GATING — nobody is told twice in a week
  // ======================================================================
  {
    const app = await mkFile({ warehouse: 'Stride Bank', fundedDaysAgo: 200 });
    await DIG.purchaseAdviceMissingOnce();
    ok('E1 chased once', await wasChased(app));
    const before = (await db.query(
      `SELECT count(*)::int n FROM audit_log WHERE action='purchase_advice_missing' AND entity_id=$1`, [app])).rows[0].n;
    await DIG.purchaseAdviceMissingOnce();
    await DIG.purchaseAdviceMissingOnce();
    const after = (await db.query(
      `SELECT count(*)::int n FROM audit_log WHERE action='purchase_advice_missing' AND entity_id=$1`, [app])).rows[0].n;
    eq('E2 …and two more sweeps in the same week say nothing further', after, before);
  }

  // ======================================================================
  // F. THE BUYER'S RULE ON THE ENCOMPASS PANEL — it blocks, and the existing
  //    super-admin field exception is a real way past it
  // ======================================================================
  //
  // The rule row is BLOCK-gated, so it holds a term sheet. The claim made in the code and in
  // CLAUDE.md is that nobody is ever STUCK, because it inherits the same super-admin exception
  // every other row on that panel has. That is only true if the exception machinery — which looks
  // a field up by key in the computed set — can actually find a row that is not in the registry.
  // Asserting it here is what turns that from a claim into a fact.
  {
    const app = await mkFile({ lender: 'Blue Lake Capital', channel: 'Table Funding', fundedDaysAgo: 10 });
    const f = await RECON.computeFindings(app, db);
    const row = (f.fields || []).find((x) => x.key === 'funding_channel_rule');
    ok('F1 a Blue Lake file whose Encompass channel says table funding raises the rule row', !!row);
    eq('F2 …as a mismatch', row && row.status, 'mismatch');
    eq('F3 …that is open', row && row.open, true);
    ok('F4 …and it counts against the sync, so the term sheet is held', f.summary && f.summary.clear === false);
    ok('F5 …naming itself in what is not passing', (f.summary.notPassingKeys || []).includes('funding_channel_rule'));

    const staff = (await db.query(
      `INSERT INTO staff_users(email, full_name, role, is_active)
       VALUES($1,'PA Super','super_admin',true) RETURNING id`,
      ['pa' + crypto.randomBytes(5).toString('hex') + '@example.com'])).rows[0].id;

    const req = await RECON.requestException(app, 'funding_channel_rule', staff, 'the channel is being corrected in Encompass', db);
    ok('F6 an exception can be REQUESTED on the rule row (the machinery finds a non-registry field)', req && req.ok === true);

    const dec = await RECON.decideException(app, 'funding_channel_rule', staff, 'grant', 'approved while Encompass is fixed', db);
    ok('F7 …and granted', dec && dec.ok === true);

    const after = await RECON.computeFindings(app, db);
    const row2 = (after.fields || []).find((x) => x.key === 'funding_channel_rule');
    eq('F8 the row is now excepted', row2 && row2.excepted === true, true);
    ok('F9 …and no longer counted as not-passing, so nobody is stuck',
      !(after.summary.notPassingKeys || []).includes('funding_channel_rule'));

    // A CORRECT file raises nothing at all, so the block only ever exists on a genuine violation.
    const good = await mkFile({ lender: 'Blue Lake Capital', channel: 'Direct RTL / w TPR', fundedDaysAgo: 10 });
    const gf = await RECON.computeFindings(good, db);
    ok('F10 a Blue Lake file on a direct channel raises no rule row at all',
      !(gf.fields || []).some((x) => x.key === 'funding_channel_rule'));
    const fid = await mkFile({ lender: 'Fidelis Investors LLC', channel: 'Table Funding', fundedDaysAgo: 10 });
    ok('F11 …and neither does a table-funded Fidelis file, which is exactly what it should be',
      !((await RECON.computeFindings(fid, db)).fields || []).some((x) => x.key === 'funding_channel_rule'));
  }

  // ======================================================================
  // G. THE INVESTOR-DELIVERY PREVIEW — the exact moment the owner named
  // ======================================================================
  //
  // "It should give you a warning that it doesn't have a PA date if you're sure you want to do
  // investor delivery." The load-bearing half is that it is a WARNING: `can_send` must be decided
  // by the blockers alone, so the warning can never quietly become a refusal. A table-funded loan
  // gets no warning at all — otherwise every Fidelis delivery would carry a nag about a date that
  // is never coming.
  {
    const SEND = require('../src/sitewire/investor-delivery-send');
    const mkDraw = async (app) => {
      const base = 990000 + crypto.randomBytes(2).readUInt16BE(0) * 10;
      await db.query(
        `INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at)
         VALUES($1,$2,'created','live',now())`, [app, base + 2]);
      await db.query(
        `INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at,accepted_at)
         VALUES($1,$2,'accepted',5000000,3345000,now(),now())`, [app, base]);
      return base;
    };

    const direct = await mkFile({ warehouse: 'Stride Bank', fundedDaysAgo: 20, lender: 'Blue Lake Capital' });
    const d1 = await mkDraw(direct);
    const p1 = await SEND.deliveryPreview(direct, d1);
    ok('G1 a direct file with no purchase advice warns on the delivery preview', !!p1.sold_warning);
    ok('G2 …with the wording that offers going ahead', /go ahead/i.test(p1.sold_warning.body));
    ok('G3 the warning is not among the blockers', !p1.blockers.some((b) => /purchase advice|sold/i.test(String(b))));
    // THE REAL PROOF that the warning costs nothing: give the SAME file a purchase advice date —
    // which is the only thing that changes — and the blockers must be byte-identical. Comparing
    // `can_send` against `blockers.length === 0` would have been a tautology: promoting the warning
    // to a blocker keeps that relationship true and the assertion would never have bitten.
    await db.query(`UPDATE applications SET purchase_advice_date='2026-07-01' WHERE id=$1`, [direct]);
    const p1b = await SEND.deliveryPreview(direct, d1);
    eq('G4 …proven: adding the purchase advice date changes the blockers not at all',
      p1b.blockers, p1.blockers);
    eq('G5 …and can_send is unmoved by it', p1b.can_send, p1.can_send);
    eq('G6 …only the warning goes away', p1b.sold_warning, null);
    await db.query(`UPDATE applications SET purchase_advice_date=NULL WHERE id=$1`, [direct]);

    const tf = await mkFile({ warehouse: 'Table Funding', fundedDaysAgo: 20, lender: 'Fidelis Investors LLC' });
    const d2 = await mkDraw(tf);
    const p2 = await SEND.deliveryPreview(tf, d2);
    eq('G7 a table-funded file gets NO warning at all — it was sold at the closing table', p2.sold_warning, null);
    eq('G8 …and says so', p2.sold_via, 'table_funding');

    // CLEAN UP THE DRAW FIXTURES. An accepted-but-undelivered draw is exactly what the coordinator
    // sweeps chase, so leaving these behind makes THIS suite look like real outstanding work to
    // every other suite sharing the test database — which is precisely how it broke
    // test-draw-coordinator-reminders-db. Only the draw rows are removed: the applications are
    // needed by nothing else and are harmless, while these actively feed another sweep.
    for (const a of [direct, tf]) {
      await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [a]);
      await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [a]);
    }
  }

  console.log(fail ? `test-purchase-advice-chase-db: ${pass} passed, ${fail} FAILED` : `test-purchase-advice-chase-db: all ${pass} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-purchase-advice-chase-db threw:', e); process.exit(1); });

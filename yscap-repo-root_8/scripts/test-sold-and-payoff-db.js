'use strict';
/**
 * test-sold-and-payoff-db — the SOLD stage, the CRITICAL DATES section, and the PAYOFF-DEMAND
 * lock on the draw centre.
 *
 * Owner-directed 2026-08-21, three connected asks:
 *   · *"the status Loan Sold: only for loans that are not table funded … that status should
 *     automatically change when the PA date is filled. You can backfill this on the table."*
 *   · *"a critical date section, which should have: the application date … the CTC date · the
 *     funded date · the purchase advice date"*
 *   · *"'Pay Off Demand Requested' … whenever a borrower requests a payoff letter, then the draw
 *     center needs to be locked up"*, on BOTH the never-set-up and the already-set-up file.
 *
 * Real Postgres, real HTTP for the doors that matter. Sitewire is stubbed — what is proven here
 * is that PILOT refuses on its own, which is the half that must hold with the connection off.
 *
 * Skips cleanly when DATABASE_URL is unset.
 */

if (!process.env.DATABASE_URL) { console.log('test-sold-and-payoff-db: SKIPPED (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const REPO = path.join(__dirname, '..');
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const SOLD = require(REPO + '/src/lib/sold-status');
const CD = require(REPO + '/src/lib/critical-dates');
const PD = require(REPO + '/src/lib/payoff-demand');
const uuid = () => crypto.randomUUID();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  ✘ ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

function call(server, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch (_) { return b; } })() : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // ------------------------------------------------------------ 1. the rule, with no database
  console.log('1. who gets the Sold stage — the rule on its own');
  const sold = (row, s) => SOLD.decideSold(row, s);
  eq(sold({ status: 'funded', purchase_advice_date: '2026-07-31' }, { via: 'purchase_advice', paDate: '2026-07-31' }).mark,
    '2026-07-31', 'a funded loan with a purchase advice date is Sold, on the advice date');
  /* THE OWNER'S EXCLUSION, and the reason it cannot be keyed on "is it sold": a table-funded loan
     IS sold — at the closing table — so `soldStatus` answers sold for it. The stage is keyed on HOW. */
  eq(sold({ status: 'funded', purchase_advice_date: null }, { via: 'table_funding' }).skipped,
    'table_funded', 'a TABLE-FUNDED loan never gets the stage');
  eq(sold({ status: 'funded', purchase_advice_date: '2026-07-31' }, { via: 'table_funding', paDate: '2026-07-31' }).skipped,
    'table_funded', '…even if it somehow carries an advice date');
  eq(sold({ status: 'underwriting', purchase_advice_date: '2026-07-31' }, { via: 'purchase_advice', paDate: '2026-07-31' }).skipped,
    'not_funded', 'a live pipeline file is never marked Sold');
  eq(sold({ status: 'funded', sold_at: '2026-07-31', purchase_advice_date: null }, { via: null }).clear,
    true, 'the stage CLEARS when its evidence goes — a corrected-away advice date must not leave "Sold" standing');
  eq(sold({ status: 'funded', sold_at: '2026-07-31', purchase_advice_date: '2026-07-31' }, { via: 'purchase_advice', paDate: '2026-07-31' }).skipped,
    'unchanged', 're-reading the same date writes nothing');
  eq(sold({ status: 'funded', purchase_advice_date: '2026-07-31' }, { via: 'our_purchase_advice', paDate: '2026-07-31' }).source,
    'desk', 'our own desk’s record is a real source and is recorded as one');
  eq(SOLD.displayStatus({ status: 'funded', sold_at: '2026-07-31' }), 'sold', 'the file DISPLAYS as sold');
  eq(SOLD.displayStatus({ status: 'funded' }), 'funded', '…and a funded file that is not sold is untouched');
  eq(SOLD.displayStatus({ status: 'underwriting', sold_at: '2026-07-31' }), 'underwriting',
    'the display never overrides a status that is not funded — a stage is not a status');

  /* THE MIGRATIONS FIRST, and awaited. Booting the server kicks them off asynchronously, so a
     suite that starts writing straight away races db/611 into existence — which is exactly how a
     brand-new column reads as "does not exist" on the very run that is supposed to prove it. */
  await require(REPO + '/src/migrate-boot').ensureSchema();

  const app = require(REPO + '/src/server.js');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const B = uuid(), APP = uuid(), APP2 = uuid(), LO = uuid(), COORD = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'Sold Officer','loan_officer','x',true), ($3,$4,'Draw Coordinator','draw_coordinator','x',true)`,
    [LO, `so_${LO.slice(0, 8)}@x.test`, COORD, `sc_${COORD.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email,cell_phone) VALUES ($1,'Grace','Hopper',$2,'7325550122')`,
      [B, `gh_${B.slice(0, 8)}@x.test`]);
    for (const [id, pa] of [[APP, '2026-07-31'], [APP2, null]]) {
      await db.query(
        `INSERT INTO applications (id,borrower_id,loan_officer_id,status,funded_date,purchase_advice_date,submitted_at,property_address)
         VALUES ($1,$2,$3,'funded','2026-05-20',$4::date, now() - interval '90 days', $5::jsonb)`,
        [id, B, LO, pa, JSON.stringify({ street: '3 Sold St', city: 'Lakewood', state: 'NJ', zip: '08701' })]);
    }
    await db.query(`INSERT INTO application_status_history (application_id,from_status,to_status,source) VALUES ($1,'approved','clear_to_close','portal')`, [APP]);

    // ------------------------------------------------------------------- 2. the backfill
    console.log('2. the back book is stamped, silently');
    /* THE WHOLE BOOK, not a page of it. A bounded pass ordered by advice date can leave THIS
       file behind other suites' fixtures — which made the aggregate count a flake that passed on
       the second run. The assertion that matters is about OUR row, below; the count is only
       reported. */
    const bf = await SOLD.backfillSoldOnce(db, { limit: 2000 });
    ok(bf.looked >= 1, `the backfill looked at the funded book (looked ${bf.looked}, marked ${bf.marked})`);
    const row = (await db.query(`SELECT sold_at, sold_source FROM applications WHERE id=$1`, [APP])).rows[0];
    eq(String(row.sold_at).slice(0, 10), '2026-07-31', 'the sold date IS the purchase advice date');
    eq(row.sold_source, 'encompass_pa', 'and it records where it came from');
    const row2 = (await db.query(`SELECT sold_at FROM applications WHERE id=$1`, [APP2])).rows[0];
    eq(row2.sold_at, null, 'a funded file with NO advice date is left alone');
    /* IDEMPOTENT: the second pass must find nothing, or every boot re-stamps the whole book. */
    const bf2 = await SOLD.backfillSoldOnce(db, { limit: 2000 });
    eq(bf2.marked, 0, 'a second pass marks nothing — it is self-draining');

    // -------------------------------------------------------------- 3. the critical dates
    console.log('3. the critical dates section');
    const cd = await CD.criticalDates(db, APP);
    const byKey = Object.fromEntries(cd.dates.map((d) => [d.key, d]));
    for (const k of ['application', 'clear_to_close', 'funded', 'purchase_advice', 'sold', 'payoff_demand']) {
      ok(!!byKey[k], `it carries the ${k} date`);
    }
    eq(byKey.funded.date, '2026-05-20', 'the funded date is the one on the file');
    eq(byKey.purchase_advice.date, '2026-07-31', 'the purchase advice date is there');
    eq(byKey.sold.date, '2026-07-31', 'the sold date is there');
    ok(!!byKey.clear_to_close.date, 'the clear-to-close date comes from the file’s own status history');
    ok(/submitted/i.test(byKey.application.source || ''), 'the application date says it is the borrower’s submission');
    /* A MISSING DATE SAYS WHY — the whole reason the read-state work exists. */
    const cd2 = await CD.criticalDates(db, APP2);
    const pa2 = cd2.dates.find((d) => d.key === 'purchase_advice');
    eq(pa2.date, null, 'a file with no advice date shows none');
    ok(/has not asked|came back empty|no Encompass loan|not configured/i.test(pa2.note || ''),
      'and says WHY, rather than leaving a blank somebody has to interpret');

    // ------------------------------------------------------------- 4. the payoff-demand lock
    console.log('4. a payoff demand locks the draw centre');
    const before = await PD.payoffDemandBlock(db, APP2);
    eq(before.blocked, false, 'a file with no demand is not blocked');
    const rec = await PD.recordPayoffDemand(db, APP2, { staffId: COORD, note: 'Borrower asked 2026-08-21' });
    ok(rec.ok, 'the demand is recorded');
    const after = await PD.payoffDemandBlock(db, APP2);
    eq(after.blocked, true, 'and the file is blocked');
    ok(/PAYOFF DEMAND/.test(after.message), 'the refusal says so, loudly');
    ok(/no new draws can be set up, requested or released/i.test(after.message),
      'and says exactly what is blocked');
    /* FILL-ONLY: the date is what the payoff figure was quoted against, so a second click must
       never move it. */
    const at1 = (await db.query(`SELECT payoff_demand_requested_at FROM applications WHERE id=$1`, [APP2])).rows[0].payoff_demand_requested_at;
    await PD.recordPayoffDemand(db, APP2, { staffId: LO, note: 'again' });
    const at2 = (await db.query(`SELECT payoff_demand_requested_at, payoff_demand_note FROM applications WHERE id=$1`, [APP2])).rows[0];
    eq(String(at2.payoff_demand_requested_at), String(at1), 'a second click never moves the original date');
    eq(at2.payoff_demand_note, 'Borrower asked 2026-08-21', 'nor rewrites the original note');

    console.log('5. every draw door refuses, over real HTTP');
    const tokLO = C.signJwt({ sub: LO, kind: 'staff', role: 'loan_officer', tv: 0 });
    const tokCoord = C.signJwt({ sub: COORD, kind: 'staff', role: 'draw_coordinator', tv: 0 });
    const start = await call(server, 'POST', `/api/sitewire/files/${APP2}/start-draw`, {}, tokCoord);
    eq(start.status, 409, 'the coordinator’s Start-draw door refuses');
    eq(start.body && start.body.code, 'payoff_demand', 'and names the reason machine-readably');
    ok(/PAYOFF DEMAND/.test((start.body && start.body.error) || ''), 'with the loud sentence');
    const rel = await call(server, 'POST', '/api/sitewire/disbursements',
      { application_id: APP2, sitewire_draw_id: 1, approved_cents: 100, fee_cents: 0 }, tokCoord);
    eq(rel.status, 409, 'recording a RELEASE is refused too — a draw already in flight must not pay out');
    /* THE FILE WITH NO DEMAND IS UNTOUCHED — the block must be about the demand, not about draws. */
    const relOk = await call(server, 'POST', '/api/sitewire/disbursements',
      { application_id: APP, sitewire_draw_id: 1, approved_cents: 100, fee_cents: 0 }, tokCoord);
    ok(relOk.status !== 409 || !/PAYOFF/.test(String((relOk.body && relOk.body.error) || '')),
      'a file with no payoff demand is not blocked by this rule');

    console.log('6. the doors, and lifting it');
    const httpRec = await call(server, 'POST', `/api/staff/applications/${APP}/payoff-demand`, { note: 'via the screen' }, tokCoord);
    eq(httpRec.status, 200, 'a coordinator can record one from the file screen');
    const lo = await call(server, 'POST', `/api/staff/applications/${APP2}/payoff-demand`, { clear: true }, tokLO);
    eq(lo.status, 403, 'a loan officer without manage_draws cannot lift it');
    const cleared = await PD.clearPayoffDemand(db, APP2, { staffId: COORD });
    ok(cleared.ok, 'a coordinator can lift it');
    eq((await PD.payoffDemandBlock(db, APP2)).blocked, false, 'and the draw centre is open again');
    const dates = await CD.criticalDates(db, APP);
    ok(!!dates.dates.find((d) => d.key === 'payoff_demand').date, 'the demand shows in the critical dates with its date');

    console.log('7. …and the DRAW COORDINATOR sees it before reaching for the button');
    /* THE GAP THIS CLOSES, found by auditing the batch back against the owner's words: *"In the
       Draw Coordinator section AND ALSO in the Critical Date section … it should come out big
       that there was a Pay Off Demand on this one"*. The hold was enforced at every door from
       the day it was built and shown on NEITHER screen — so a coordinator learnt about it by
       pressing Start and being refused, which is the worst moment to find out. The refusal
       above is unchanged; what is asserted here is that the same fact reaches the draw view. */
    const view = await call(server, 'GET', `/api/sitewire/files/${APP}/rollup`, null, tokCoord);
    eq(view.status, 200, 'the draw view loads');
    ok(view.body && view.body.payoff_demand && view.body.payoff_demand.at,
      'and carries the payoff demand, so the panel can lead with it');
    const pd = (view.body && view.body.payoff_demand) || {};
    eq(pd.note, 'via the screen', 'with the note somebody typed');
    ok(/PAYOFF DEMAND/.test(String(pd.message || '')),
      'and the same loud sentence the doors refuse with — one fact, one wording');
    /* A FILE WITH NO DEMAND SAYS NOTHING. A banner that renders on every file is a banner
       nobody reads. */
    const clean = await call(server, 'GET', `/api/sitewire/files/${APP2}/rollup`, null, tokCoord);
    eq(clean.status, 200, 'a file with no demand loads too');
    ok(!(clean.body && clean.body.payoff_demand), '…and carries no payoff banner at all');
  } finally {
    await db.query(`DELETE FROM application_status_history WHERE application_id = ANY($1::uuid[])`, [[APP, APP2]]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[APP, APP2]]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    server.close();
  }
  console.log(`\ntest-sold-and-payoff-db: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

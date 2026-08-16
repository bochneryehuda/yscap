/* THE POST-PURCHASE HAND-OFF — the gate on finishing a purchase, and the email that starts it
 * (owner-directed 2026-08-13). Against a REAL database and the REAL route.
 *
 * The owner: *"the purchase advice date you enter manually in PILOT needs to match the purchase
 * advice date in Encompass … and Encompass needs to have a purchase advice date filled in in order
 * for you to be able to mark purchase completed. And when the system realizes that Encompass has a
 * purchase advice date filled out, it should email the post-purchase people … but once one of the
 * two is done, the draw coordinator should be able to continue as usual — it's sold, fine. PILOT
 * should still have outstanding tasks for the post-purchaser to take care of."*
 *
 * What this proves:
 *   1. the gate — no Encompass date, no PILOT date, two different dates, and the matching case;
 *   2. the two dates are compared as CALENDAR DAYS, so a stored timestamp and a typed US date agree;
 *   3. the super-admin way through, which exists so a wrong date in read-only Encompass can never
 *      trap a file forever — and which is refused without a reason;
 *   4. the announcement: once only, skipped on an already-complete purchase, and it leaves the work
 *      on the desk as an outstanding task rather than only in an inbox;
 *   5. it fires from the SHARED landing point, so it does not matter which of the three reads
 *      noticed the date;
 *   6. THE TWO SIDES DO NOT BLOCK EACH OTHER — the draw desk reads the loan as sold immediately,
 *      while the purchase stays outstanding until somebody finishes it here.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-post-purchase-db.js
 */
'use strict';
const http = require('http');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

if (!process.env.DATABASE_URL) { console.log('SKIP test-post-purchase-db (no DATABASE_URL)'); process.exit(0); }

const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const PP = require('../src/lib/post-purchase');
const RP = require('../src/sitewire/release-party');
const app = require('../src/server');

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  // ---------------------------------------------------------------- 1. the gate, pure
  eq('1a nothing at all → Encompass first', PP.adviceGate({}).code, 'no_encompass_advice');
  eq('1b Encompass only → record it here', PP.adviceGate({ encompassDate: '2026-07-31' }).code, 'no_pilot_advice');
  eq('1c two different days → refused', PP.adviceGate({ encompassDate: '2026-07-31', pilotDate: '2026-07-30' }).code, 'advice_dates_differ');
  eq('1d the same day → allowed', PP.adviceGate({ encompassDate: '2026-07-31', pilotDate: '2026-07-31' }).ok, true);
  // Compared as calendar days, through the same parser the sold signal uses — so the shape a date
  // happens to be stored in can never fail a file that is actually correct.
  eq('1e a US-typed date and an ISO one are the same day',
    PP.adviceGate({ encompassDate: '07/31/2026', pilotDate: '2026-07-31' }).ok, true);
  eq('1f …and so is a full timestamp', PP.adviceGate({ encompassDate: '2026-07-31T00:00:00Z', pilotDate: '2026-07-31' }).ok, true);
  const differ = PP.adviceGate({ encompassDate: '2026-07-31', pilotDate: '2026-07-30' });
  ok('1g the refusal names BOTH dates, so the person can see which is wrong',
    /07\/30\/2026/.test(differ.message) && /07\/31\/2026/.test(differ.message));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let bad = 0;
  const mail = (t) => `pp-${t}-${sfx}@test.local`;
  try {
    const admin = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Purchase Admin','super_admin',true,false,'x',0) RETURNING id`, [mail('admin')])).rows[0].id;
    const plain = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Plain Processor','processor',true,false,'x',0) RETURNING id`, [mail('plain')])).rows[0].id;
    const post = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Post Purchaser','loan_coordinator',true,false,'x',0) RETURNING id`, [mail('post')])).rows[0].id;
    const token = C.signJwt({ sub: admin, kind: 'staff', role: 'super_admin', tv: 0 });
    const plainToken = C.signJwt({ sub: plain, kind: 'staff', role: 'processor', tv: 0 });
    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email) VALUES('Post','Purchase',$1) RETURNING id`, [mail('bo')])).rows[0].id;

    // Unique BY CONSTRUCTION, not by luck. This used to end in
    // `Math.floor(Math.random() * 1000)`, and `sfx` is fixed for the whole run — so
    // the only thing separating one file's ys_loan_number from the next was a draw
    // from a thousand values. Six files a run is a ~1.5% chance of a duplicate-key
    // crash every time CI runs, which is exactly what it did. A counter cannot
    // collide with itself.
    let fileSeq = 0;
    const mkFile = async () => {
      fileSeq += 1;
      const id = (await db.query(
        `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address)
         VALUES($1,'funded',$2,'CorrFirst','{"oneLine":"14 Held St","city":"Lakewood","state":"NJ","zip":"08701"}') RETURNING id`,
        [bor, `PP${sfx.slice(-6)}${fileSeq}`])).rows[0].id;
      await db.query(`INSERT INTO purchasing_workflow (application_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
      return id;
    };
    const statusOf = async (id) => (await db.query(`SELECT status FROM purchasing_workflow WHERE application_id=$1`, [id])).rows[0].status;
    const setComplete = (id, tok, body) => call(server, 'POST', `/api/staff/applications/${id}/purchasing/status`, tok || token, { status: 'complete', ...(body || {}) });

    // ---------------------------------------------------------------- 2. the gate, through the route
    {
      const f = await mkFile();
      const noEnc = await setComplete(f);
      eq('2a with no Encompass date the purchase cannot be completed', noEnc.status, 422);
      eq('2b …and it says which fact is missing', noEnc.body.code, 'no_encompass_advice');
      eq('2c …and the file is still outstanding', await statusOf(f), 'outstanding');

      await db.query(`UPDATE applications SET purchase_advice_date='2026-07-31' WHERE id=$1`, [f]);
      const noOurs = await setComplete(f);
      eq('2d with no date recorded HERE it still cannot', [noOurs.status, noOurs.body.code], [422, 'no_pilot_advice']);

      await db.query(
        `INSERT INTO purchasing_advice (application_id, advice_date) VALUES ($1,'2026-07-30')
         ON CONFLICT (application_id) DO UPDATE SET advice_date=EXCLUDED.advice_date`, [f]);
      const mismatch = await setComplete(f);
      eq('2e two different dates are refused', [mismatch.status, mismatch.body.code], [422, 'advice_dates_differ']);
      ok('2f …naming both, in plain words', /07\/30\/2026/.test(mismatch.body.error) && /07\/31\/2026/.test(mismatch.body.error));

      await db.query(`UPDATE purchasing_advice SET advice_date='2026-07-31' WHERE application_id=$1`, [f]);
      const good = await setComplete(f);
      eq('2g matching dates complete the purchase', good.status, 200);
      eq('2h …and the desk shows it', await statusOf(f), 'complete');

      // Going BACK to outstanding is never gated — that is how a mistake is corrected.
      const back = await call(server, 'POST', `/api/staff/applications/${f}/purchasing/status`, token, { status: 'outstanding' });
      eq('2i moving back to outstanding is always allowed', [back.status, await statusOf(f)], [200, 'outstanding']);
    }

    // ---------------------------------------------------------------- 3. the way through, for a super admin
    {
      const f = await mkFile();
      await db.query(`UPDATE applications SET purchase_advice_date='2026-07-31' WHERE id=$1`, [f]);
      await db.query(
        `INSERT INTO purchasing_advice (application_id, advice_date) VALUES ($1,'2026-07-30')
         ON CONFLICT (application_id) DO UPDATE SET advice_date=EXCLUDED.advice_date`, [f]);
      eq('3a an override with no reason is refused', (await setComplete(f, token, { override: true })).status, 400);
      eq('3b …and a non-super-admin cannot override at all',
        (await setComplete(f, plainToken, { override: true, override_reason: 'Encompass has the wrong day' })).status, 403);
      eq('3c …the file is still outstanding after both', await statusOf(f), 'outstanding');
      const forced = await setComplete(f, token, { override: true, override_reason: 'Encompass has the wrong day; investor confirmed 7/30' });
      eq('3d a super admin with a reason can finish it', forced.status, 200);
      eq('3e …and it is recorded', await statusOf(f), 'complete');
      const audited = (await db.query(
        `SELECT 1 FROM audit_log WHERE action='purchasing_complete_override' AND entity_id=$1::uuid LIMIT 1`, [f])).rowCount;
      ok('3f …with an audit row naming the override', audited === 1);
    }

    // ---------------------------------------------------------------- 4. the announcement
    {
      await db.query(`INSERT INTO post_purchase_notify (staff_id) VALUES ($1) ON CONFLICT DO NOTHING`, [post]);
      const f = await mkFile();
      const first = await PP.announceSold(f, '2026-07-31');
      eq('4a the post-purchase team is told', first.announced, true);
      ok('4b …the people on the list, by email', (first.to || []).includes(mail('post')));
      eq('4c …and the work is left on the desk as an outstanding task', first.task, true);
      const task = (await db.query(
        `SELECT label FROM purchasing_tasks WHERE application_id=$1 AND done_at IS NULL`, [f])).rows[0];
      ok('4d …worded as the thing to actually do', task && /upload the purchase advice/i.test(task.label));
      ok('4e …and it says so in the message', /mark the purchase complete/i.test(PP.TASK_LABEL));

      eq('4f a second look never emails again', (await PP.announceSold(f, '2026-07-31')).reason, 'already_announced');
      eq('4g …and leaves exactly one task', (await db.query(
        `SELECT count(*)::int c FROM purchasing_tasks WHERE application_id=$1`, [f])).rows[0].c, 1);

      // A file whose purchase is already finished is not chased.
      const done = await mkFile();
      await db.query(`UPDATE purchasing_workflow SET status='complete' WHERE application_id=$1`, [done]);
      eq('4h an already-finished purchase is left alone', (await PP.announceSold(done, '2026-07-31')).reason, 'purchase_already_complete');
      eq('4i …and a cleared date announces nothing', (await PP.announceSold(await mkFile(), null)).reason, 'no_date');
    }

    // ---------------------------------------------------------------- 5. it fires from the shared landing point
    {
      const f = await mkFile();
      // This is what EVERY read path calls — the poll, the desk's own refresh and the manual button.
      const fieldId = require('../src/lib/integrations/encompass-field-map').PA_DATE_FIELD_ID;
      const out = await RP.syncPurchaseAdviceDate(db, f, { [String(fieldId)]: '07/31/2026' });
      eq('5a the date lands', [out.paDate, out.changed], ['2026-07-31', true]);
      const stamped = (await db.query(`SELECT purchase_advice_notified_at FROM applications WHERE id=$1`, [f])).rows[0];
      ok('5b …and the hand-off went out with it, whichever read noticed', !!stamped.purchase_advice_notified_at);
      ok('5c …leaving the task behind', (await db.query(
        `SELECT count(*)::int c FROM purchasing_tasks WHERE application_id=$1`, [f])).rows[0].c === 1);

      // ---- 6. THE TWO SIDES DO NOT BLOCK EACH OTHER ----
      const rel = await RP.releaseStateFor(db, f);
      eq('6a the draw desk reads the loan as sold immediately', rel.sold, 'sold');
      eq('6b …while the purchase is still outstanding here', await statusOf(f), 'outstanding');
    }

    // ---------------------------------------------------------------- 7. who is told is editable
    {
      const list = await call(server, 'GET', `/api/staff/purchasing/notify-list`, token);
      eq('7a the list can be read', list.status, 200);
      ok('7b …and shows who is on it', (list.body.people || []).some((p) => p.id === post));
      eq('7c an admin can add somebody',
        (await call(server, 'POST', `/api/staff/purchasing/notify-list`, token, { staff_id: plain })).status, 200);
      const after = await call(server, 'GET', `/api/staff/purchasing/notify-list`, token);
      ok('7d …and they appear', (after.body.people || []).some((p) => p.id === plain));
      eq('7e …and can be removed again',
        (await call(server, 'POST', `/api/staff/purchasing/notify-list`, token, { staff_id: plain, remove: true })).status, 200);
      eq('7f a non-admin cannot change who hears about a sale',
        (await call(server, 'POST', `/api/staff/purchasing/notify-list`, plainToken, { staff_id: plain })).status, 403);
    }

    bad = fail;
  } finally {
    await db.query(`DELETE FROM applications WHERE ys_loan_number LIKE $1`, [`PP${sfx.slice(-6)}%`]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`pp-%-${sfx}@test.local`]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email=$1`, [mail('bo')]).catch(() => {});
    server.close();
  }
  console.log(`test-post-purchase-db: ${pass} passed, ${fail} failed.`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

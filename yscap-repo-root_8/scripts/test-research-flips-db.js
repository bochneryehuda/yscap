/**
 * PROPERTIES BOUGHT AND RESOLD — against a real database and the real route.
 *
 * `properties` carries only the LATEST sale, so until now the purchase a flip
 * started from was invisible to every search. `property_sales` has held both all
 * along: an appraiser records each comparable's PRIOR sale on the grid and the
 * ingest files it as its own transaction. Measured on the real 152-report
 * corpus: 50 buy→sell pairs inside two years across 48 properties, with 14
 * nominal transfers passed over.
 *
 * What this pins:
 *   1. A PAIR IS TWO CLOSED SALES. A listing's asking price is stored in the same
 *      table so it can be shown as an asking price, and pairing one would invent
 *      a profit nobody made.
 *   2. CONSECUTIVE ONLY. Three sales are two deals, not three — a buy and a sell
 *      two transactions apart is not one deal and would double the spread.
 *   3. A DOLLAR IS NOT A PURCHASE PRICE. The corpus holds ten $1 transfers and
 *      three $10 ones; the first run of this returned "bought $10, sold $565,000,
 *      spread 5,649,900%". They are set aside and COUNTED, never silently
 *      dropped, and never included — a ridiculous number in a column of real ones
 *      gets believed.
 *   4. NOTHING IS ASSERTED ABOUT RENOVATION from the spread. `resold_as_renovated`
 *      comes only from the appraiser having put the resale on an after-repair
 *      grid; a big number is not evidence that anyone did any work.
 *   5. THE WINDOW IS THE HOLD, not recency, and both are separately askable.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

if (!process.env.DATABASE_URL) { console.log('SKIP test-research-flips-db (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const FLIPS = require('../src/lib/research/flips');
const app = require('../src/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const tag = `fl${process.pid}${Math.floor(Math.random() * 1e5)}`;
const TOWN = `Fliptown${tag}`;

function call(server, path, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ method: 'GET', path, port: server.address().port, host: '127.0.0.1',
      headers: token ? { authorization: `Bearer ${token}` } : {} },
    (res) => { let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { raw: b }; }
        resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject); r.end();
  });
}

async function prop(street) {
  return (await db.query(
    `INSERT INTO properties (address_key, display_address, street, city, state, zip,
       property_type, units, gla, beds, year_built)
     VALUES ($1,$2,$3,$4,'NJ','07005','SFR (1 unit)',1,1500,3,1960) RETURNING id`,
    [`nj|${TOWN.toLowerCase()}|${street.toLowerCase()}|${tag}`, `${street} ${tag}`, street, TOWN])).rows[0].id;
}
async function sale(pid, date, price, opts = {}) {
  await db.query(
    `INSERT INTO property_sales (property_id, sale_date, sale_price, sale_status, sale_type, source)
     VALUES ($1,$2,$3,$4,$5,'test')`,
    [pid, date, price, opts.status || null, opts.type || null]);
}

(async () => {
  let server;
  try {
    // 1 — an ordinary flip: bought, held seven months, resold higher.
    const flip = await prop('1 Flip Way');
    await sale(flip, '2025-06-01', 300000);
    await sale(flip, '2026-01-05', 455000);
    // 2 — the SAME shape but the resale is only an ASKING price.
    const listed = await prop('2 Flip Way');
    await sale(listed, '2025-06-01', 300000);
    await sale(listed, '2026-01-05', 500000, { status: 'active' });
    // 3 — THREE sales: two deals, not three.
    const twice = await prop('3 Flip Way');
    await sale(twice, '2024-09-01', 200000);
    await sale(twice, '2025-04-01', 280000);
    await sale(twice, '2025-12-01', 360000);
    // 4 — a nominal transfer followed by a real sale. Not a purchase.
    const deed = await prop('4 Flip Way');
    await sale(deed, '2025-08-01', 1);
    await sale(deed, '2026-02-01', 410000);
    // 5 — held far too long to be one deal.
    const held = await prop('5 Flip Way');
    await sale(held, '2019-01-01', 150000);
    await sale(held, '2026-01-01', 500000);
    // 6 — a loss. Still a completed exit, and still evidence.
    const loss = await prop('6 Flip Way');
    await sale(loss, '2025-09-01', 400000);
    await sale(loss, '2026-01-01', 380000);
    // 7 — an REO purchase resold at market: exactly what this exists to surface.
    const reo = await prop('7 Flip Way');
    await sale(reo, '2025-07-01', 180000, { type: 'REOSale' });
    await sale(reo, '2026-01-15', 340000);

    const d = await FLIPS.findFlips(db, { city: TOWN, state: 'NJ', months: 24, limit: 50 });
    const has = (id) => d.rows.some((r) => r.property_id === id);
    const row = (id) => d.rows.find((r) => r.property_id === id) || {};

    ok(has(flip), 'a property bought and resold inside the window is found');
    ok(Number(row(flip).spread) === 155000 && Number(row(flip).spread_pct) === 51.7,
      'with the spread in dollars and in per cent');
    // 2025-06-01 → 2026-01-05 is 218 days; 218 / 30.4375 is 7.16 months.
    ok(row(flip).held_days === 218 && row(flip).held_months === 7.2,
      'and how long it was held, which is the number a bridge lender is actually asking about');

    ok(!has(listed), 'a resale that is only an ASKING price is not a sale and makes no pair');
    ok(!has(held), 'a property held seven years is not one deal');

    ok(!has(deed), 'a nominal $1 transfer is NOT treated as a purchase');
    ok(d.setAside === 1 && /nominal/.test(d.setAsideNote || ''),
      'it is set aside and COUNTED, with the reason said in words — never silently dropped');

    ok(has(loss) && Number(row(loss).spread) === -20000,
      'a flip that LOST money is still a completed exit and is still shown');

    ok(has(reo) && row(reo).bought_arms_length === false && row(reo).sold_arms_length === null,
      'an REO purchase is surfaced and flagged, and an unstated sale type reads as unknown, not as arm\'s length');

    const pairs = d.rows.filter((r) => r.property_id === twice);
    ok(pairs.length === 2, `three sales make TWO deals, not three (got ${pairs.length})`);
    ok(pairs.every((p) => Number(p.spread) === 80000),
      'and neither of them spans both transactions — a 160k spread would be one deal that never happened');

    // THE TWO WINDOWS ARE DIFFERENT QUESTIONS.
    const shortHold = await FLIPS.findFlips(db, { city: TOWN, state: 'NJ', months: 6, limit: 50 });
    ok(!shortHold.rows.some((r) => r.property_id === flip),
      'a six-month HOLD window excludes a seven-month flip');
    const stale = await FLIPS.findFlips(db, { city: TOWN, state: 'NJ', months: 24, soldWithinMonths: 1, limit: 50 });
    ok(stale.rows.length === 0,
      'and "sold in the last month" is a separate question from how long it was held');

    const big = await FLIPS.findFlips(db, { city: TOWN, state: 'NJ', months: 24, minSpreadPct: 50, limit: 50 });
    ok(big.rows.some((r) => r.property_id === flip) && !big.rows.some((r) => r.property_id === loss),
      'a minimum spread filters on the per cent, not on the dollars');

    ok(d.rows.every((r) => r.resold_as_renovated === false),
      'NOTHING claims a renovation — none of these was put on an after-repair grid, whatever the spread says');
    ok(/not proof that anyone renovated/.test(d.caveat || ''),
      'and the caveat travels with the answer rather than living in one screen');

    // A NOMINAL TRANSFER IN THE MIDDLE MUST NOT ERASE THE FLIP EITHER SIDE OF IT.
    // A rehabber deeding the property into an LLC mid-project is the exact case
    // NOMINAL_PRICE documents, and setting the pair aside AFTERWARDS split one
    // genuine exit into two nominal pairs and discarded both — the $200,000 →
    // $450,000 exit vanished and the note claimed two non-purchases had gone.
    const midDeed = await prop('8 Flip Way');
    await sale(midDeed, '2025-04-01', 200000);
    await sale(midDeed, '2025-07-01', 1);
    await sale(midDeed, '2025-12-01', 450000);
    const withDeed = await FLIPS.findFlips(db, { city: TOWN, state: 'NJ', months: 24, limit: 50 });
    const deedPairs = withDeed.rows.filter((r) => r.property_id === midDeed);
    ok(deedPairs.length === 1 && Number(deedPairs[0].spread) === 250000,
      'a nominal transfer between the purchase and the exit is passed over, not treated as either end');
    ok(withDeed.setAside >= 2,
      'and the transfers it passed over are still counted and explained');

    // TWO SALES ON THE SAME DAY ARE ONE RESALE, NOT TWO. The corpus already holds
    // a pair recorded on one date at two prices.
    const sameDay = await prop('9 Flip Way');
    await sale(sameDay, '2025-01-10', 200000);
    await sale(sameDay, '2025-09-01', 465000);
    await sale(sameDay, '2025-09-01', 468000);
    const sd = await FLIPS.findFlips(db, { city: TOWN, state: 'NJ', months: 24, limit: 50 });
    ok(sd.rows.filter((r) => r.property_id === sameDay).length === 1,
      'one purchase with two same-day resales is ONE deal, not the same purchase counted twice');

    // A PRICELESS ROW IN THE MIDDLE IS NOT A SALE AND MUST NOT BLOCK ONE.
    const blank = await prop('10 Flip Way');
    await sale(blank, '2025-03-01', 250000);
    await db.query(`INSERT INTO property_sales (property_id, sale_date, sale_price, source)
                    VALUES ($1,'2025-06-01',NULL,'test')`, [blank]);
    await sale(blank, '2025-11-01', 400000);
    const bl = await FLIPS.findFlips(db, { city: TOWN, state: 'NJ', months: 24, limit: 50 });
    ok(bl.rows.some((r) => r.property_id === blank),
      'a row with no price is not a sale, so it cannot break the pair around it');

    // ---- THE ROUTE ----
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Flip Finder','loan_officer',true,false,'x',0) RETURNING id`,
      [`s${tag}@t.test`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'loan_officer', tv: 0 });
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));

    const res = await call(server, `/api/research/flips?city=${encodeURIComponent(TOWN)}&state=NJ&months=24`, token);
    ok(res.status === 200 && (res.body.rows || []).some((r) => r.property_id === flip),
      'the route answers for any staff member — the warehouse is not per-file scoped');
    ok(res.body.setAside >= 1 && res.body.caveat,
      'and carries the set-aside count and the caveat, so a screen cannot present it without them');
    const anon = await call(server, `/api/research/flips?city=${encodeURIComponent(TOWN)}&state=NJ`, null);
    ok(anon.status === 401 || anon.status === 403, 'and it is staff-only');

    // A GARBAGE FILTER MUST NOT BECOME A WILD ANSWER.
    // AN UNREADABLE NUMBER IS NOT A FILTER, and asserting only "200 and an array"
    // is what let this through: `K.num('xyz')` answers null, `Number(null)` is 0,
    // and the filter "spread >= 0%" quietly deleted every loss-making flip. On
    // the real corpus 50 rows became 44 and all six losses vanished.
    const junk = await call(server, `/api/research/flips?city=${encodeURIComponent(TOWN)}&state=NJ&months=abc&min_spread_pct=xyz&limit=0`, token);
    ok(junk.status === 200 && Array.isArray(junk.body.rows),
      'unreadable numbers fall back to the defaults rather than throwing');
    ok((junk.body.rows || []).some((r) => r.property_id === loss),
      '…and an unreadable minimum spread does NOT silently delete the loss-making flips');
  } catch (e) {
    console.log('FAIL threw: ' + (e && e.stack || e));
    fail++;
  } finally {
    if (server) server.close();
    try {
      await db.query(`DELETE FROM property_sales WHERE property_id IN (SELECT id FROM properties WHERE address_key LIKE $1)`, [`%|${tag}`]);
      await db.query(`DELETE FROM properties WHERE address_key LIKE $1`, [`%|${tag}`]);
      await db.query(`DELETE FROM staff_users WHERE email = $1`, [`s${tag}@t.test`]);
    } catch (_) { /* best-effort */ }
    await db.pool.end().catch(() => {});
  }
  console.log(`test-research-flips-db: ${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();

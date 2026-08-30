'use strict';
/**
 * LONG-TERM — THE MARGIN HOLDBACK IS A SETTING, END TO END.
 *
 * Owner-directed 2026-08-30: *"there should always be in the settings the
 * possibility to move up the margin hold back, remove the margin hold back, or
 * move it down."*
 *
 * The pure rules live in `test-lt-loannex-parity-pure.js` (section 10). What
 * needs a real database and a real HTTP door is the part no pure test can see:
 * that a value SAVED on the settings screen is the value the BOARD is priced
 * on. A resolver that is perfect and a route that never reads it would pass
 * every unit test and quote the wrong price on every loan.
 *
 * ⛔ AND THE ASYMMETRY THAT MATTERS: every other setting in this engine may fail
 * toward doing nothing. This one may not — doing nothing here hands the borrower
 * 0.25 of better execution nobody decided to give them — so a refused value must
 * keep the standing 0.25 rather than fall to zero, and that is asserted from
 * both ends: the door refuses it, and a value that somehow reached the store is
 * still priced at 0.25.
 *
 * LT-only. No vendor call: the board is built here and put through the same
 * `applyToBoard` the route uses, with the setting read back over real HTTP.
 */
const http = require('http');

// ⛔ THE VENDOR CLIENTS ARE STUBBED BEFORE ANYTHING REQUIRES THEM, so the REAL
// `priceBoth` can be driven end to end with no network. This is the only way to
// assert the thing that actually matters — that the route READS the setting —
// and the first version of this suite could not: it called `applyToBoard`
// itself with the saved value, which proves the resolver and says nothing about
// whether any route ever passes it. A mutation that made the route ignore the
// setting entirely sailed straight through. Stub first, then require.
const nexClient = require('../src/longterm/loannex/client');
const lpClient = require('../src/longterm/lenderprice/client');
const VENDOR_PRICE = 101.5;
nexClient.price = async () => ({
  board: { source: 'loannex', programs: [{ lender: 'NQM Funding', investor: 'NQM Funding', program: 'P', product: '30 Yr Fixed', rungs: [{ rate: 7, price: VENDOR_PRICE, points: -1.5, lockDays: 30 }] }] },
});
lpClient.price = async () => ({ source: 'lenderprice', programs: [] });

const db = require('../src/db');
const crypto = require('../src/lib/crypto');
const vendorMargin = require('../src/longterm/pricing/vendor-margin');
const settingsStore = require('../src/longterm/settings/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

(async () => {
  if (!process.env.DATABASE_URL) { console.log('SKIP (no DATABASE_URL)'); process.exit(0); }
  const app = require('../src/server');
  const stamp = `lt-hb-${Date.now()}`;
  let staffId = null, server = null;

  try {
    const { rows } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1, 'LT Holdback Admin', 'super_admin', true)
       RETURNING id, token_version`, [`${stamp}@example.test`],
    );
    staffId = rows[0].id;
    const token = crypto.signJwt({ sub: String(staffId), kind: 'staff', role: 'super_admin', tv: rows[0].token_version, sid: 'hb' });

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let json = null; try { json = await res.json(); } catch (_) { json = null; }
      return { status: res.status, body: json };
    };
    const DOOR = '/api/lt/dscr/combined/margin-holdback';

    // The board every assertion below is priced on — one rung, one clean price,
    // so a moved number is unmistakable rather than lost in a fixture.
    const board = () => ({ source: 'loannex', programs: [{ program: 'P', rungs: [{ rate: 7, price: 101.5, points: -1.5 }] }] });
    // ⛔ THROUGH THE REAL ROUTE, not through `applyToBoard` directly. `priceBoth`
    // is the function the HTTP price door calls; driving it is what proves the
    // saved setting travels from the store, through the read, into the board an
    // officer is shown. Reveal is on so the per-vendor split comes back and the
    // LoanNEX rung can be found without guessing.
    const priceBoth = require('../src/longterm/routes/combined-pricer')._internals.priceBoth;
    const SCENARIO = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '08201', fico: 760, dscr: 1.3 };
    const pricedAt = async () => {
      const out = await priceBoth(SCENARIO, { revealSource: true });
      const inv = (out.merged.investors || [])[0];
      const rung = inv && inv.programs && inv.programs[0] && inv.programs[0].rungs && inv.programs[0].rungs[0];
      // The holdback's record rides in the per-source provenance block, so it is
      // read from there rather than from the top of the board — and reading it
      // through `sources` is itself the assertion that it survived the merge.
      const prov = (out.merged.sources && out.merged.sources.loannex) || {};
      return {
        price: rung ? rung.price : null,
        held: prov.marginHoldback,
        origin: prov.marginHoldbackOrigin,
        note: prov.marginHoldbackNote,
        problem: prov.marginHoldbackProblem,
      };
    };

    console.log('\n== A. NOTHING SAVED — the owner\'s standing number ==');
    let r = await call('GET', DOOR);
    ok(r.status === 200 && r.body.points === 0.25 && r.body.origin === 'default',
      `A1 with nothing saved the holdback is the standing 0.25 and says so (${r.body && r.body.points}/${r.body && r.body.origin})`);
    ok(r.body.prefill === 0.25 && r.body.max === 10,
      'A2 …and the door states the pre-fill and the ceiling, so a screen never has to remember either');
    let p = await pricedAt();
    ok(p.price === 101.25 && p.held === 0.25,
      `A3 …and a 101.5 vendor price is boarded at 101.25 (got ${p.price})`);

    console.log('\n== B. MOVE IT UP ==');
    r = await call('PUT', DOOR, { points: 0.5 });
    ok(r.status === 200 && r.body.points === 0.5 && r.body.origin === 'setting', 'B1 the door accepts 0.5 and records it as somebody\'s own setting');
    p = await pricedAt();
    ok(p.price === 101 && p.held === 0.5 && p.origin === 'setting',
      `B2 …and the BOARD is priced on it — 101.5 becomes 101 (got ${p.price}). This is the assertion a pure test cannot make.`);

    console.log('\n== C. MOVE IT DOWN ==');
    r = await call('PUT', DOOR, { points: 0.125 });
    ok(r.status === 200 && r.body.points === 0.125, 'C1 the door accepts a smaller holdback');
    p = await pricedAt();
    ok(p.price === 101.375 && p.held === 0.125, `C2 …and the board follows it down (got ${p.price})`);

    console.log('\n== D. REMOVE IT — and it must not look like an outage ==');
    r = await call('PUT', DOOR, { points: 0 });
    ok(r.status === 200 && r.body.points === 0 && r.body.origin === 'setting',
      'D1 zero is accepted as a DECISION, not read as "nothing saved"');
    p = await pricedAt();
    ok(p.price === 101.5 && p.held === 0 && p.origin === 'setting',
      `D2 …the vendor's own price is boarded untouched (got ${p.price}), and the board still carries the stamp`);
    const removed = vendorMargin.applyToBoard(board(), 'loannex', { saved: 0 });
    ok(removed.marginHoldback === 0 && /deliberately set to zero/.test(removed.marginHoldbackNote || ''),
      'D3 …and the board SAYS it was removed on purpose — "the owner turned it off" must never be indistinguishable from "the settings failed to load"');

    console.log('\n== E. BACK TO THE STANDING NUMBER ==');
    r = await call('PUT', DOOR, { points: null });
    ok(r.status === 200 && r.body.points === 0.25 && r.body.origin === 'default',
      'E1 saving null returns the row to the standing 0.25 and stores nothing of our own');
    p = await pricedAt();
    ok(p.price === 101.25, `E2 …and the board is back on 0.25 (got ${p.price})`);

    console.log('\n== F. A REFUSED VALUE IS REFUSED, AND NEVER FALLS TO ZERO ==');
    for (const [label, v, code] of [['text', 'abc', 'not_a_number'], ['negative', -1, 'negative'], ['a slipped decimal', 25, 'too_large']]) {
      r = await call('PUT', DOOR, { points: v });
      ok(r.status === 422 && r.body.error === code,
        `F1 ${label} is refused at the door with its own reason (${r.status} ${r.body && r.body.error})`);
    }
    p = await pricedAt();
    ok(p.price === 101.25 && p.held === 0.25,
      `F2 …and after three refusals the board is STILL held back at 0.25 (got ${p.price}) — a refused save never becomes a removal`);

    // The other half of the asymmetry: a bad value that somehow reached the
    // store (an older build, a hand edit) must still price at 0.25.
    await settingsStore.save({ 'pricing.combinedMarginHoldback': 'nonsense' }, { scope: 'company', staffId });
    p = await pricedAt();
    ok(p.price === 101.25 && p.held === 0.25 && p.origin === 'default',
      `F3 …and an unreadable value already IN the store keeps the standing 0.25 rather than quietly removing it (got ${p.price})`);
    // Read off what the ROUTE returned, not off a fresh `applyToBoard` call — a
    // refusal that is computed and then dropped at the merge is a refusal
    // nobody can see, which is exactly the defect this found.
    ok(p.problem && p.problem.error === 'not_a_number',
      `F4 …and the refusal travels all the way out ON THE PRICED BOARD, so it is answerable from the quote rather than from a log nobody reads (${p.problem ? p.problem.error : 'DROPPED'})`);
    ok(typeof p.note === 'string' && /0\.25/.test(p.note),
      'F4b …alongside the note saying what was actually held back, which is what lets a moved price say who moved it');
    await settingsStore.save({ 'pricing.combinedMarginHoldback': null }, { scope: 'company', staffId });

    console.log('\n== F5. A SETTINGS STORE THAT WILL NOT ANSWER ==');
    // ⛔ THE ASYMMETRY, EXERCISED. Every other reader in this engine falls back
    // to "do nothing" when the store is unreachable. This one may not: doing
    // nothing here quietly stops holding the 0.25 back and hands every borrower
    // better execution nobody decided to give them. A store that THROWS must
    // still price at 0.25 — and that branch is unreachable while the database is
    // healthy, so it is reached the only way it can be.
    {
      const realGet = settingsStore.get;
      settingsStore.get = async (key, scope) => {
        if (key === 'pricing.combinedMarginHoldback') throw new Error('settings store unreachable');
        return realGet.call(settingsStore, key, scope);
      };
      try {
        const outage = await pricedAt();
        ok(outage.price === 101.25 && outage.held === 0.25,
          `F5 with the settings store refusing to answer, the board is STILL held back at 0.25 (got ${outage.price}) — an outage may never become a giveaway`);
      } finally {
        settingsStore.get = realGet;
      }
      const back = await pricedAt();
      ok(back.price === 101.25, 'F5b …and the stub is off again, so nothing after this is measuring an outage');
    }

    console.log('\n== G. LENDER PRICE IS NOT CONFIGURABLE, AND THAT IS A FACT ABOUT ITS FEED ==');
    const lp = vendorMargin.applyToBoard({ source: 'lenderprice', programs: [{ program: 'A', rungs: [{ rate: 7, price: 100.5, points: -0.5 }] }] }, 'lenderprice', { saved: 0.5 });
    ok(lp.marginHoldback === undefined && lp.programs[0].rungs[0].price === 100.5,
      'G1 a saved holdback cannot reach Lender Price — its feed already carries ours, so a second one would take it twice');

    console.log(`\n${fail === 0 ? 'all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (staffId) {
      await db.query('DELETE FROM staff_users WHERE id = $1', [staffId]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
'use strict';
/**
 * LT PPE — `POST /ppe/quote` WITH A PROGRAM: the shadow comparison, over real HTTP, against a real
 * Postgres.
 *
 * THE DEFECT THIS EXISTS FOR, MEASURED. `quoteRoute` is invoked by exactly one suite
 * (`test-lt-ppe-route.js`) and both of its calls send NO `rateSheetVersionId`, so both take the
 * no-program early return. V8 line coverage of `src/longterm/routes/ppe.js` across the whole
 * `test-lt-*` family showed **lines 477–533 — the entire `facade.priceWithShadow` call — executed by
 * nothing**. That block is where this surface's one governing model lives:
 *
 *     Lender Price is the answer. Our engine may only ever ADD a `shadow` block to it, and a shadow
 *     failure may never change, delay or break the business answer.
 *
 * So the promise in the file's own header was guarded by tests of the branch that skips it. Everything
 * wired inside that call was unexecuted with it: the `lpDetail` capture reader (§2.8, whose absence
 * once made every quote record a phantom Lender Price decline), the four tolerances read from settings,
 * the stored LP scope, and `recordFinding` — the only path by which a live quote appends to the
 * findings ledger.
 *
 * WHAT IS PROVEN HERE, each of it about the ROUTE rather than the engine:
 *   1. with a program, the shadow RUNS — `shadow` is a block and `shadowSkipped` is gone;
 *   2. Lender Price's own answer comes back UNTOUCHED beside it;
 *   3. a disagreement is reported AND lands in `lt_ppe_finding` — the durable record;
 *   4. agreement records NOTHING (a ledger that fills up on agreement is a ledger nobody reads);
 *   5. OUR engine throwing still returns Lender Price's answer, 200, with the failure named;
 *   6. LENDER PRICE throwing is the business failure and surfaces in `wrap`'s shape, never as a
 *      half-answer that reads like a quote;
 *   7. the LP SCOPE round-trips through its own two routes — never invoked by any suite before this —
 *      and is what the comparison is scoped by.
 *
 * WHAT IS STUBBED: only `src/longterm/lenderprice/client.js`, the paid vendor over the network.
 * The route, the façade, the parity comparison, the finding store and Postgres are all real.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-quote-shadow-db.js
 *
 * LT-only. Writes only `lt_ppe_*` rows (plus the one shared-identity `staff_users` row it signs in
 * with) and removes every one of them at the end.
 */

if (!process.env.DATABASE_URL) {
  console.log('  --  skipped (no DATABASE_URL) — set DATABASE_URL to run it; the shadow path writes to the findings ledger');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lt-ppe-quote-shadow-secret';

const path = require('path');

let failures = 0;
let n = 0;
const ok = (cond, label) => { n += 1; console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures += 1; };

// ---------------------------------------------------------------------------
// The vendor stub. `price()` returns the RAW envelope the real client returns
// ({ ok, raw, request, searchKey }); the route's own `lpDetail` turns it into the
// three parsed shapes, so the envelope-vs-parsed distinction (§2.8) is exercised.
// ---------------------------------------------------------------------------
const LP_PATH = require.resolve(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'));
const lp = {
  calls: [],
  throwWith: null,
  rungs: [{ rate: 7.125, price: 90.000 }],
  price: async (sc) => {
    lp.calls.push(sc);
    if (lp.throwWith) throw new Error(lp.throwWith);
    return { ok: true, raw: { STUB: 'raw' }, request: { stub: true }, searchKey: 'stub-key' };
  },
  parse: () => ({ programs: [{ program: 'DSCR 30 Yr Fixed', product: 'Fixed', rungs: lp.rungs }] }),
  parseFull: () => ({ programs: [] }),
  hasDisqualifyData: () => false,
  parseDisqualified: () => ({ ready: false, lenders: [] }),
  pollDisqualifiedByKey: async () => ({ ready: false }),
};
require.cache[LP_PATH] = { id: LP_PATH, filename: LP_PATH, loaded: true, exports: lp };

const db = require('../src/db');
const ltDb = require('../src/longterm/db');
const auth = require('../src/auth');
const store = require('../src/longterm/ppe/store');
const quoteMod = require('../src/longterm/ppe/quote');

const SCOPE = 'company';
const SCENARIO = { fico: 800, ltv: 70000, dscr: 1100, loan_amount: 400000, lock_days: 30 };

/** The ledger is written FIRE-AND-FORGET, so the row can land just after the response. */
async function waitForFinding(investor, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const r = await ltDb.query('SELECT * FROM lt_ppe_finding WHERE scope = $1 AND investor = $2', [SCOPE, investor]);
    if (r.rows.length) return r.rows;
    await new Promise((res) => setTimeout(res, 50));
  }
  return [];
}

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = `qs${process.pid}${Date.now().toString().slice(-6)}`;
  const INV_DIFF = `${stamp}-diff`;
  const INV_AGREE = `${stamp}-agree`;
  const INV_ENGINE = `${stamp}-engine`;
  const made = { staff: [], investor: null, program: null };

  const call = async (method, p, token, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* an empty body is a legitimate answer */ }
    return { status: res.status, json };
  };

  try {
    const { rows: staff } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1, 'Quote Shadow Admin', 'admin', true) RETURNING id`,
      [`${stamp}.admin@example.test`],
    );
    made.staff = staff.map((r) => r.id);
    const tok = await auth.mintStaffSession(staff[0].id);

    // ── the sheet a quote can actually price ────────────────────────────────
    const investor = await store.createInvestor(ltDb, SCOPE, { code: `QS${stamp}`.slice(0, 20), name: `Quote Shadow ${stamp}` });
    made.investor = investor.id;
    const program = await store.createProgram(ltDb, SCOPE, { investorId: investor.id, code: `QSP${stamp}`.slice(0, 40), name: 'DSCR 30yr' });
    made.program = program.id;
    const version = await store.createRateSheetVersion(ltDb, SCOPE, { programId: program.id, versionNo: 1, channel: 'correspondent' });
    await store.replaceBasePrices(ltDb, SCOPE, version.id, [{ noteRateMilliPct: 7125, lockDays: 30, priceMilli: 102850 }]);
    ok(!!version.id, 'a real rate-sheet version with a real base grid exists to price against');

    // ── 1) with a program the shadow RUNS, and disagreement is recorded ─────
    console.log('\n1) the shadow branch — the block no test had ever executed');
    lp.rungs = [{ rate: 7.125, price: 90.000 }]; // far outside any tolerance, on purpose
    const diff = await call('POST', '/api/lt/ppe/quote', tok,
      { scenario: SCENARIO, investor: INV_DIFF, rateSheetVersionId: version.id });

    ok(diff.status === 200, `A1 a quote with a program answers 200 (${diff.status}: ${JSON.stringify(diff.json).slice(0, 200)})`);
    ok(diff.json && diff.json.mode === 'shadow' && diff.json.authoritative === 'lp',
      'A2 …in shadow mode, with Lender Price authoritative');
    ok(diff.json && diff.json.shadow && typeof diff.json.shadow === 'object',
      'A3 …and the shadow block is PRESENT — the comparison ran (the no-program branch returns null here)');
    ok(diff.json && diff.json.shadowSkipped === undefined,
      'A4 …with no `shadowSkipped` reason, because nothing was skipped');
    ok(diff.json && diff.json.answer && diff.json.answer.searchKey === 'stub-key' && diff.json.answer.ok === true,
      'A5 LENDER PRICE\'S OWN ANSWER comes back untouched beside the shadow — the business answer is theirs');

    // Read through a local default from here on. A missing `shadow` block is a REAL failure mode (it is
    // what A3 exists to catch), and reaching into it unguarded would end the run in a TypeError — a
    // stack trace that also "fails" while saying nothing about which promise broke.
    const sh = (diff.json && diff.json.shadow) || {};
    ok(sh.agreed === false, `A6 a price 12 points away is reported as a DISAGREEMENT (${JSON.stringify(sh.agreed)})`);

    const priceFinding = (sh.findings || []).find((f) => f.kind === 'price_mismatch');
    ok(!!priceFinding, `A7 …typed as a price_mismatch (${(sh.findings || []).map((f) => f.kind).join(', ') || 'none'})`);
    ok(priceFinding && Number.isFinite(priceFinding.ourPriceMilli) && priceFinding.theirPriceMilli === 90000,
      `A8 …naming both sides' prices (ours ${priceFinding && priceFinding.ourPriceMilli}, theirs ${priceFinding && priceFinding.theirPriceMilli})`);
    ok(sh.deep && typeof sh.deep.ran === 'boolean' && (sh.deep.ran === true || typeof sh.deep.why === 'string'),
      'A9 the deep axes either RAN or say in words why they abstained — never a silent absence');

    const rows = await waitForFinding(INV_DIFF);
    ok(rows.length >= 1, `A10 the disagreement reached the findings LEDGER (${rows.length} row(s)) — a quote's whole durable output`);
    ok(rows.some((r) => r.kind === 'price_mismatch' && r.status === 'open'),
      'A11 …as an OPEN price_mismatch, which is what the review queue reads');
    ok(rows.every((r) => r.scope === SCOPE), 'A12 …written under the route\'s own scope');

    // ── 2) agreement records NOTHING ───────────────────────────────────────
    console.log('\n2) agreement is silent — a ledger that fills up on agreement is one nobody reads');
    // Our own priced rung, DISCOVERED from the finding above rather than hard-coded: the subject here
    // is the route's plumbing (does agreement report as agreement, and does it stay out of the
    // ledger), and pinning the engine's arithmetic — which has a hundred suites of its own — would
    // make this fail for a reason that is not its own.
    ok(priceFinding && Number.isFinite(priceFinding.ourPriceMilli),
      'B0 our own price was read back off the finding, so the agreement case below is built from it');
    lp.rungs = [{ rate: 7.125, price: (priceFinding ? priceFinding.ourPriceMilli : 0) / 1000 }];
    const agree = await call('POST', '/api/lt/ppe/quote', tok,
      { scenario: SCENARIO, investor: INV_AGREE, rateSheetVersionId: version.id });
    ok(agree.status === 200 && agree.json.shadow && agree.json.shadow.agreed === true,
      `B1 Lender Price quoting OUR price is reported as agreement (${agree.json && agree.json.shadow && JSON.stringify(agree.json.shadow.findings)})`);
    await new Promise((r) => setTimeout(r, 300)); // give a would-be write time to land
    const agreeRows = await ltDb.query('SELECT count(*)::int AS c FROM lt_ppe_finding WHERE scope = $1 AND investor = $2', [SCOPE, INV_AGREE]);
    ok(agreeRows.rows[0].c === 0, `B2 …and NOTHING was written to the ledger (${agreeRows.rows[0].c} rows)`);

    // ── 3) a shadow failure never breaks the business answer ───────────────
    console.log('\n3) the guarantee the whole surface is built on');
    {
      const realQuote = quoteMod.quoteProgram;
      quoteMod.quoteProgram = () => { throw new Error('our engine fell over (test)'); };
      let res;
      try {
        res = await call('POST', '/api/lt/ppe/quote', tok,
          { scenario: SCENARIO, investor: INV_ENGINE, rateSheetVersionId: version.id });
      } finally {
        quoteMod.quoteProgram = realQuote;
      }
      ok(res.status === 200, `C1 OUR engine throwing still answers 200 (${res.status}) — a shadow failure may never break the quote`);
      ok(res.json && res.json.answer && res.json.answer.searchKey === 'stub-key',
        'C2 …and the caller still gets Lender Price\'s answer, which is the business answer');
      ok(res.json && res.json.shadow && res.json.shadow.agreed === false
        && (res.json.shadow.findings || []).some((f) => f.kind === 'engine_error'),
        'C3 …with the failure named as an engine_error rather than quietly reported as agreement');
      const engineRows = await waitForFinding(INV_ENGINE, 20);
      ok(engineRows.some((r) => r.kind === 'engine_error'), 'C4 …and recorded, so a broken engine is visible in the ledger');
    }

    // ── 4) LENDER PRICE failing IS the business failure ────────────────────
    {
      lp.throwWith = 'Lender Price is down (test)';
      let res;
      try {
        res = await call('POST', '/api/lt/ppe/quote', tok,
          { scenario: SCENARIO, investor: `${stamp}-lpdown`, rateSheetVersionId: version.id });
      } finally {
        lp.throwWith = null;
      }
      ok(res.status === 500 && res.json && res.json.ok === false && res.json.error === 'lt_ppe_quote_error',
        `C5 LENDER PRICE failing surfaces as wrap()'s 500 shape (${res.status} ${JSON.stringify(res.json)}) — never a half-answer that reads like a quote`);
      ok(!/Lender Price is down \(test\)/.test(JSON.stringify(res.json || {})),
        'C6 …with the upstream\'s own words kept on the server');
    }

    // ── 5) the LP scope round-trips through its own two routes ─────────────
    console.log('\n4) the Lender Price scope — two routes no suite had ever invoked');
    {
      const before = await call('GET', `/api/lt/ppe/programs/${made.program}/lp-scope`, tok);
      ok(before.status === 200 && before.json.lpScope === null && typeof before.json.note === 'string',
        'D1 an unscoped program reads as unscoped AND says what that costs the comparison');

      const bad = await call('POST', `/api/lt/ppe/programs/${made.program}/lp-scope`, tok, {});
      ok(bad.status === 400, `D2 a write with no \`scope\` key is refused rather than read as "clear it" (${bad.status})`);

      const set = await call('POST', `/api/lt/ppe/programs/${made.program}/lp-scope`, tok,
        { scope: { programLike: 'DSCR.* 30 Yr Fixed' } });
      ok(set.status === 200 && set.json.lpScope && set.json.lpScope.programLike === 'DSCR.* 30 Yr Fixed',
        `D3 an admin states which Lender Price programs the comparison is about (${set.status})`);

      const after = await call('GET', `/api/lt/ppe/programs/${made.program}/lp-scope`, tok);
      ok(after.status === 200 && after.json.lpScope && after.json.lpScope.programLike === 'DSCR.* 30 Yr Fixed',
        'D4 …and it is durable — read back from the database through the read route');
      ok(after.json.setBy === made.staff[0], 'D5 …recorded against the person who set it');

      // AND IT REACHES THE COMPARISON. The scope is read by `loadProgram` and handed to the façade as
      // `lpFilter`; a scope that matched nothing would leave the ladder with no rungs to compare.
      //
      // THE PATTERN ABOVE HAS TO MATCH THE STUB'S OWN PROGRAM NAME, and that is the whole point of
      // this assertion rather than a fixture detail. `lp-normalize` once carried its own matcher that
      // IGNORED `programLike` entirely, so every program matched and a scope proved nothing; once that
      // was fixed (§2 canary leg), a pattern that does not match its program correctly compares against
      // NOTHING — which reads as "Lender Price found this ineligible", not as a price disagreement.
      // `DSCR.* 30 Yr Fixed` matches `DSCR 30 Yr Fixed`; `DSCR .* 30 Yr Fixed` does not.
      lp.rungs = [{ rate: 7.125, price: 90.000 }];
      const scoped = await call('POST', '/api/lt/ppe/quote', tok,
        { scenario: SCENARIO, investor: `${stamp}-scoped`, rateSheetVersionId: version.id });
      ok(scoped.status === 200 && scoped.json.shadow && scoped.json.shadow.agreed === false
        && (scoped.json.shadow.findings || []).some((f) => f.kind === 'price_mismatch'),
        'D6 a quote against the SCOPED program still compares against the matching Lender Price program');
    }

    // ── 6) POST /breakdown with a program ──────────────────────────────────
    console.log('\n5) POST /breakdown — a handler no suite had invoked at all');
    {
      const none = await call('POST', '/api/lt/ppe/breakdown', tok, { scenario: SCENARIO });
      ok(none.status === 422 && /rate-sheet version/.test((none.json && none.json.error) || ''),
        `E1 with no rate sheet it REFUSES with the reason — there is nothing to break down (${none.status})`);

      const view = await call('POST', '/api/lt/ppe/breakdown', tok,
        { scenario: SCENARIO, investor: INV_AGREE, rateSheetVersionId: version.id });
      ok(view.status === 200 && view.json && view.json.breakdown && typeof view.json.breakdown === 'object',
        `E2 with one, it answers a breakdown built from the priced sheet (${view.status})`);
      ok(view.json.disqualifyPending === false,
        'E3 …and says plainly whether Lender Price\'s decline tree was still being computed');
      const afterBreakdown = await ltDb.query('SELECT count(*)::int AS c FROM lt_ppe_finding WHERE scope = $1 AND investor = $2', [SCOPE, INV_AGREE]);
      ok(afterBreakdown.rows[0].c === 0,
        'E4 …and it wrote NOTHING to the findings ledger — a breakdown is a READ (its header says so, and nothing had ever checked)');
    }
  } finally {
    for (const inv of [`${stamp}-diff`, `${stamp}-agree`, `${stamp}-engine`, `${stamp}-lpdown`, `${stamp}-scoped`]) {
      try { await ltDb.query('DELETE FROM lt_ppe_finding WHERE scope = $1 AND investor = $2', [SCOPE, inv]); } catch (_) {}
      try { await ltDb.query('DELETE FROM lt_ppe_shadow_run WHERE scope = $1 AND investor = $2', [SCOPE, inv]); } catch (_) {}
    }
    if (made.program) { try { await ltDb.query('DELETE FROM lt_ppe_program WHERE scope = $1 AND id = $2', [SCOPE, made.program]); } catch (_) {} }
    if (made.investor) {
      try { await ltDb.query('DELETE FROM lt_ppe_investor_alias WHERE scope = $1 AND investor_id = $2', [SCOPE, made.investor]); } catch (_) {}
      try { await ltDb.query('DELETE FROM lt_ppe_investor WHERE scope = $1 AND id = $2', [SCOPE, made.investor]); } catch (_) {}
    }
    try { await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [made.staff]); } catch (_) {}
    server.close();
    try { await ltDb.pool.end(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
  }

  console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });

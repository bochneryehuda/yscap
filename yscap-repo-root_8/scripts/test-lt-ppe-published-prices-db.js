#!/usr/bin/env node
'use strict';
/**
 * LT PPE — PUBLISHING A SHEET MAKES IT THE ONE THAT PRICES, and a price limit cannot move unrecorded.
 *
 * TWO MEASURED DEFECTS, PROVEN CLOSED HERE.
 *
 * (A) `store.currentRateSheetVersion` — the "which published version is in effect" predicate — had
 *     NO CALLER anywhere in `src/`. `loadProgram` required an explicit version id, and the only human
 *     path to one was a free-text UUID box on the pricing screen. So a person priced a loan by pasting
 *     a UUID, and the publish gate, the ≥200-scenario agreement run and the supersede of the previous
 *     version all decided a status column that no pricing path ever read. "Published" meant nothing
 *     operationally.
 *
 * (B) `PUT /rate-sheets/:id/price-limit` existed, `ltApi.ppeSetPriceLimit` existed, and
 *     `check-lt-http-reachability.js` reported it as the ONE client entry no screen calls. The five
 *     values that bound every quote the sheet answers could only be set with curl — and the write was
 *     an upsert with nothing behind it, so a floor that moved from 98.000 to 95.000 was afterwards
 *     indistinguishable from a sheet that had always said 95.000.
 *
 * WHAT IS ASSERTED, and every one of it is READ BACK FROM THE SERVER rather than taken from the
 * write's own 200 — a route that answers ok and stores nothing is this repo's most common defect:
 *
 *   · a quote/breakdown naming a PROGRAM prices from the version that program PUBLISHED;
 *   · publishing a SECOND version moves what prices, with no client change;
 *   · a program with nothing published is a NAMED refusal (`no_published_rate_sheet`) and NEVER a
 *     silent fall-back to a draft or to a superseded sheet — the failure this must not create;
 *   · TWO published versions in effect REFUSE with `ambiguous_published_rate_sheet` and list the
 *     candidates, rather than inventing a tie-break nobody decided;
 *   · the EXPLICIT version id still works, still wins over a program, and still reaches a DRAFT (the
 *     way a specific version is compared) — this ADDED a way and removed none;
 *   · a price-limit change with no reason is refused and writes NOTHING;
 *   · a reasoned change writes the limit AND its audit row in one transaction, with the before, the
 *     after, and WHICH of the five moved;
 *   · the sheet read carries that history, so the console shows what is in force before anyone moves it.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-published-prices-db.js
 *
 * LT-only. No RTL imports. No Lender Price call (the quote path is exercised through `loadProgram`
 * and the resolver, which are the halves this change touches).
 */
const fs = require('fs');
const path = require('path');

let failures = 0; let n = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); n += 1; if (!cond) failures += 1; }

function stubRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}
const call = async (fn, req) => { const res = stubRes(); await fn(req, res); return res; };
const REQ = (over = {}) => Object.assign(
  { params: {}, body: {}, query: {}, actor: { id: null, email: 'limits@ys' } }, over);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('(LT PPE published-prices round-trip skipped — set DATABASE_URL to run it.)');
    process.exit(0);
  }

  const R = require('../src/longterm/routes/ppe');
  const H = R.handlers;
  const I = R._internals;
  const store = require('../src/longterm/ppe/store');
  const db = require('../src/longterm/db');
  const SCOPE = I.SCOPE;

  const stamp = `P${process.pid}${Date.now() % 100000}`;
  const INV_CODE = `ZZ${stamp}`.slice(0, 20);
  const PRG_CODE = `ZZP${stamp}`.slice(0, 20);
  const PRG2_CODE = `ZZQ${stamp}`.slice(0, 20);

  const cleanup = async () => {
    await db.query('DELETE FROM lt_ppe_program WHERE scope = $1 AND code = ANY($2)', [SCOPE, [PRG_CODE, PRG2_CODE]]).catch(() => {});
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1 AND code = $2', [SCOPE, INV_CODE]).catch(() => {});
  };

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql',
      '576_lt_ppe_ratesheet_agreement_gate.sql', '580_lt_ppe_price_limit_audit.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    // ---- fixtures: one investor, two programs, three versions ------------------------------------
    let res = await call(H.createInvestorRoute, REQ({ body: { code: INV_CODE, name: `Investor ${stamp}` } }));
    const investorId = res.body.investor.id;
    res = await call(H.createProgramRoute, REQ({ body: { investorId, code: PRG_CODE, name: `Program ${stamp}` } }));
    const programId = res.body.program.id;
    res = await call(H.createProgramRoute, REQ({ body: { investorId, code: PRG2_CODE, name: `Program2 ${stamp}` } }));
    const emptyProgramId = res.body.program.id;

    // A version whose grid prices at a value we can RECOGNISE, so "which sheet priced this" is
    // answered by the NUMBER rather than by trusting the id the route echoed back.
    const buildVersion = async (priceMilli) => {
      const r = await call(H.createRateSheetRoute, REQ({ params: { id: programId }, body: {} }));
      const id = r.body.version.id;
      await call(H.setBasePricesRoute, REQ({
        params: { id },
        body: { rows: [{ noteRateMilliPct: 7000, lockDays: 30, priceMilli }] },
      }));
      return id;
    };

    const vA = await buildVersion(101000);   // the first published sheet
    const vB = await buildVersion(102500);   // the one that replaces it
    const vDraft = await buildVersion(99000); // never published

    console.log('\nA. nothing is published — a NAMED state, never a fall-back\n');

    {
      const picked = await I.resolveRateSheetVersion(SCOPE, { programId });
      ok(picked.versionId === null && picked.reason === 'no_published_rate_sheet',
        'A1 with nothing published the resolver names the state rather than answering with a version');
      ok(/nothing is published/i.test(picked.message || ''),
        'A2 …in words a person can act on');
      // THE SHARP ONE. Three versions EXIST on this program and every one of them is a draft. A
      // fall-back to "the newest" or "the only one" would price a real loan off a sheet nobody
      // published — the exact failure this must not create.
      ok(picked.versionId !== vA && picked.versionId !== vB && picked.versionId !== vDraft,
        'A3 THE ONE THAT MATTERS: it falls back to NO draft, though three exist on this program');

      const r = await call(H.breakdownRoute, REQ({ body: { programId, scenario: { fico: 720 } } }));
      ok(r.statusCode === 422 && r.body.reason === 'no_published_rate_sheet',
        'A4 …and a breakdown against that program is REFUSED with that same reason');
      ok(/nothing is published/i.test(r.body.error || ''),
        'A5 …the refusal naming the state, not a generic "needs a rate-sheet version"');
    }

    console.log('\nB. publishing makes a sheet the one that prices — with no client change\n');

    await store.publishRateSheetVersionUnchecked(db, SCOPE, vA);

    {
      const picked = await I.resolveRateSheetVersion(SCOPE, { programId });
      ok(picked.versionId === vA && picked.reason === null && picked.resolvedFrom === 'published',
        'B1 the PUBLISHED version is what the resolver answers with');

      const r = await call(H.breakdownRoute, REQ({ body: { programId, scenario: { fico: 720 }, rate: 7 } }));
      ok(r.statusCode === 200 && r.body.rateSheet && r.body.rateSheet.versionId === vA,
        'B2 a breakdown naming only the PROGRAM prices, and says which version it used');
      ok(r.body.rateSheet.resolvedFrom === 'published',
        'B3 …and says HOW it was chosen, so a published price is distinguishable from a typed one');
      // Priced from the RIGHT sheet, proven by the number rather than by the echoed id.
      ok(r.body.breakdown && r.body.breakdown.base_price === 101000,
        'B4 …and the base price is version A\'s own grid value');
    }

    console.log('\nC. publishing a SECOND version moves what prices — the whole point of publishing\n');

    await store.publishRateSheetVersionUnchecked(db, SCOPE, vB);

    {
      const picked = await I.resolveRateSheetVersion(SCOPE, { programId });
      ok(picked.versionId === vB, 'C1 the newly published version is now the one in effect');

      const r = await call(H.breakdownRoute, REQ({ body: { programId, scenario: { fico: 720 }, rate: 7 } }));
      ok(r.body.rateSheet.versionId === vB, 'C2 …and the same request now prices from it');
      ok(r.body.breakdown.base_price === 102500,
        'C3 THE PROOF: the price MOVED to version B\'s grid — nothing about the request changed');

      // Read from the SERVER, not from the publish's own answer.
      const rowA = (await db.query('SELECT status, effective_to FROM lt_ppe_rate_sheet_version WHERE id = $1', [vA])).rows[0];
      ok(rowA.status === 'superseded' && rowA.effective_to != null,
        'C4 …and version A was superseded and closed, so exactly one is in effect');
    }

    console.log('\nD. the EXPLICIT version id still works, and still wins — this ADDED a way\n');

    {
      const r = await call(H.breakdownRoute, REQ({
        body: { rateSheetVersionId: vA, programId, scenario: { fico: 720 }, rate: 7 },
      }));
      ok(r.body.rateSheet.versionId === vA && r.body.rateSheet.resolvedFrom === 'explicit_version',
        'D1 a named version WINS over the program named beside it');
      ok(r.body.breakdown.base_price === 101000,
        'D2 …and it really priced from that version — the SUPERSEDED one, which is how two are compared');

      const d = await call(H.breakdownRoute, REQ({ body: { rateSheetVersionId: vDraft, scenario: { fico: 720 }, rate: 7 } }));
      ok(d.statusCode === 200 && d.body.breakdown.base_price === 99000,
        'D3 …and a DRAFT can still be priced explicitly, which is how a sheet is checked before publish');

      const none = await call(H.breakdownRoute, REQ({ body: { scenario: { fico: 720 } } }));
      ok(none.statusCode === 422 && none.body.reason === 'no_program_requested',
        'D4 asking for neither is UNCHANGED — still the same reason it always was');
    }

    console.log('\nE. two published versions is an OPEN QUESTION — refused, never a tie-break\n');

    {
      // A second published row on the SAME program, on a different channel. The publish path
      // supersedes only within one channel, so this is reachable without touching the table by hand.
      await db.query(
        `UPDATE lt_ppe_rate_sheet_version
            SET status = 'published', channel = 'wholesale', effective_from = now(), effective_to = NULL
          WHERE id = $1`, [vDraft]);

      const picked = await I.resolveRateSheetVersion(SCOPE, { programId });
      ok(picked.versionId === null && picked.reason === 'ambiguous_published_rate_sheet',
        'E1 two versions in effect REFUSES rather than picking one');
      ok(picked.candidates.length === 2,
        'E2 …and lists BOTH, so a person can name the one they mean');
      ok(/not decided/i.test(picked.message || ''),
        'E3 …saying plainly that WHICH ONE PRICES is not decided — never "we used the newest"');

      const r = await call(H.breakdownRoute, REQ({ body: { programId, scenario: { fico: 720 }, rate: 7 } }));
      ok(r.statusCode === 422 && r.body.reason === 'ambiguous_published_rate_sheet',
        'E4 …and a breakdown against that program is refused, not priced off a coin toss');

      // NAMING THE CHANNEL resolves it, which is what makes the refusal actionable rather than a wall.
      const byChannel = await I.resolveRateSheetVersion(SCOPE, { programId, channel: 'wholesale' });
      ok(byChannel.versionId === vDraft && byChannel.reason === null,
        'E5 naming the channel resolves the ambiguity — the refusal is a question, not a dead end');

      await db.query(`UPDATE lt_ppe_rate_sheet_version SET status = 'draft', channel = 'correspondent', effective_from = NULL WHERE id = $1`, [vDraft]);
    }

    console.log('\nF. the read behind the chooser answers the same three states, in the same words\n');

    {
      let r = await call(H.currentRateSheetRoute, REQ({ params: { id: programId } }));
      ok(r.statusCode === 200 && r.body.published && r.body.published.id === vB,
        'F1 the chooser read names the version in effect');
      ok(r.body.program && r.body.program.code === PRG_CODE,
        'F2 …and the program it is about, so a screen need not hold a second copy of that');

      r = await call(H.currentRateSheetRoute, REQ({ params: { id: emptyProgramId } }));
      ok(r.statusCode === 200 && r.body.published === null && r.body.reason === 'no_published_rate_sheet',
        'F3 a program with nothing published says so — the same reason the pricing path gives');
      ok(/nothing is published/i.test(r.body.message || ''),
        'F4 …in the same words, so the screen and the quote can never describe it differently');

      r = await call(H.currentRateSheetRoute, REQ({ params: { id: '00000000-0000-4000-8000-000000000000' } }));
      ok(r.statusCode === 404, 'F5 an unknown program is a 404, never an empty "nothing published"');
      r = await call(H.currentRateSheetRoute, REQ({ params: { id: 'not-a-uuid' } }));
      ok(r.statusCode === 400, 'F6 …and junk is refused before any lookup');
    }

    console.log('\nG. a price limit is a MONEY RULE — it cannot move unrecorded\n');

    {
      // A fresh draft to work the limits on (the published ones are draft-only refused, which is F's
      // own assertion below).
      let r = await call(H.createRateSheetRoute, REQ({ params: { id: programId }, body: {} }));
      const vLim = r.body.version.id;

      r = await call(H.setPriceLimitRoute, REQ({
        params: { id: vLim }, body: { minPriceMilli: 98000, roundingMode: 'none', roundingIncrementMilli: 0 },
      }));
      ok(r.statusCode === 400 && r.body.field === 'reason',
        'G1 a change with no reason is REFUSED — the record IS the authorization');
      let stored = (await db.query('SELECT COUNT(*)::int AS n FROM lt_ppe_price_limit WHERE version_id = $1', [vLim])).rows[0];
      ok(stored.n === 0, 'G2 …and the refused change wrote NOTHING (read back from the server)');
      let audit = (await db.query('SELECT COUNT(*)::int AS n FROM lt_ppe_price_limit_audit WHERE version_id = $1', [vLim])).rows[0];
      ok(audit.n === 0, 'G3 …and recorded nothing either');

      r = await call(H.setPriceLimitRoute, REQ({
        params: { id: vLim },
        body: { minPriceMilli: 98000, roundingMode: 'none', roundingIncrementMilli: 0, reason: 'investor floor on the term sheet' },
      }));
      ok(r.statusCode === 200, 'G4 a reasoned change is accepted');

      // RE-READ FROM THE SERVER. The write's own 200 is not evidence.
      const sheet = await call(H.getRateSheetRoute, REQ({ params: { id: vLim } }));
      ok(sheet.body.priceLimit && Number(sheet.body.priceLimit.min_price_milli) === 98000,
        'G5 …and the floor really is stored (re-read through the sheet route)');
      ok(Array.isArray(sheet.body.priceLimitHistory) && sheet.body.priceLimitHistory.length === 1,
        'G6 …with exactly ONE recorded change beside it');

      // Read DEFENSIVELY. A missing record must FAIL each of these on its own terms — a thrown
      // TypeError also "fails", and it would hide every assertion after it (the exact false
      // confidence the standing rule warns about: a crashing test looks like proof).
      const h0 = sheet.body.priceLimitHistory[0] || null;
      ok(!!h0 && h0.before === null,
        'G7 the FIRST change records "there was no limit row" — a real fact, different from a null floor');
      ok(!!h0 && h0.after && h0.after.minPriceMilli === 98000, 'G8 …and what it became');
      ok(!!h0 && h0.reason === 'investor floor on the term sheet', 'G9 …in the author\'s own words');
      ok(!!h0 && h0.changedBy === 'limits@ys', 'G10 …with the person\'s name on it');

      // THE MOVE THIS WHOLE TABLE EXISTS FOR: an upsert overwrites the previous floor IN PLACE, so
      // without the record a 95.000 sheet is indistinguishable from one that always said 95.000.
      r = await call(H.setPriceLimitRoute, REQ({
        params: { id: vLim },
        body: { minPriceMilli: 95000, roundingMode: 'none', roundingIncrementMilli: 0, reason: 'renegotiated with the investor on the call' },
      }));
      ok(r.statusCode === 200, 'G11 the floor is moved');

      const after = await call(H.getRateSheetRoute, REQ({ params: { id: vLim } }));
      ok(Number(after.body.priceLimit.min_price_milli) === 95000, 'G12 …the sheet now prices at the new floor');
      const hist = after.body.priceLimitHistory || [];
      ok(hist.length === 2, 'G13 …and the history is APPEND-ONLY — the first change was not rewritten');
      ok(!!hist[0] && hist[0].before && hist[0].before.minPriceMilli === 98000 && hist[0].after.minPriceMilli === 95000,
        'G14 THE ONE THAT MATTERS: the record carries BOTH sides — 98.000 became 95.000');
      ok(!!hist[0] && Array.isArray(hist[0].changedFields) && hist[0].changedFields.join(',') === 'minPriceMilli',
        'G15 …and names WHICH of the five moved, so nobody diffs two JSON blobs to find out');
      ok(!!hist[1] && hist[1].before === null, 'G16 …and the earlier record is untouched');

      // A save that changes nothing is still recorded, and says so.
      r = await call(H.setPriceLimitRoute, REQ({
        params: { id: vLim },
        body: { minPriceMilli: 95000, roundingMode: 'none', roundingIncrementMilli: 0, reason: 'confirming after the reprice' },
      }));
      const again = await call(H.getRateSheetRoute, REQ({ params: { id: vLim } }));
      const hLast = (again.body.priceLimitHistory || [])[0] || null;
      ok(!!hLast && Array.isArray(hLast.changedFields) && hLast.changedFields.length === 0,
        'G17 a save that moved nothing records an EMPTY change list — visible, never invisible');

      // DRAFT-ONLY is unchanged: a published sheet's money rules cannot be rewritten underneath the
      // quotes pricing from them.
      r = await call(H.setPriceLimitRoute, REQ({
        params: { id: vB }, body: { minPriceMilli: 90000, reason: 'trying to move a live floor' },
      }));
      ok(r.statusCode === 409, 'G18 a PUBLISHED sheet\'s price limits cannot be changed');
      const liveAudit = (await db.query('SELECT COUNT(*)::int AS n FROM lt_ppe_price_limit_audit WHERE version_id = $1', [vB])).rows[0];
      ok(liveAudit.n === 0, 'G19 …and the refusal wrote nothing on the way to being refused');
    }

    console.log('\nH. the predicate that had no caller now has one, and they agree\n');

    {
      // The resolver takes its answer FROM `currentRateSheetVersion` rather than from the row it
      // counted, so "which published version is in effect" keeps ONE definition. Asserted by asking
      // both and comparing.
      const predicate = await store.currentRateSheetVersion(db, SCOPE, programId, 'correspondent');
      const picked = await I.resolveRateSheetVersion(SCOPE, { programId });
      ok(predicate && picked.versionId === predicate.id,
        'H1 the pricing resolver and the in-effect predicate answer the SAME version');
    }

    await cleanup();
  } catch (e) {
    console.error('\nFAILED WITH AN ERROR:', e && e.stack ? e.stack : e);
    failures += 1;
    await cleanup().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
  process.exit(failures ? 1 : 0);
})();

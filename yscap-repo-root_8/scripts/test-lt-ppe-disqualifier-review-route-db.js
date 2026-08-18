#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the three DOORS of the disqualifier review queue, against a REAL Postgres.
 *
 * WHAT THESE DOORS ARE FOR. The owner's instruction was not a rule but a procedure: "look on the
 * eligibility rule in Lender Price, go into the disqualifier, and look for the actual disqualifier.
 * You then look at the rate to see if you can find where he's taking this disqualifier. You need a
 * human to review these findings for every single scenario." `disqualifier-review.js` does the three
 * steps and `disqualifier-review-store.js` keeps the answers; each has its own suite. What is proven
 * HERE is only what those two cannot see — the route's promises, every one of which is a way the queue
 * could go quiet while looking healthy:
 *
 *   A. IT REFUSES BEFORE IT SPENDS, and each refusal leaves the queue untouched. This door prices a
 *      whole battery at a paid vendor; a run that could not compare anything would produce an EMPTY
 *      queue, and an empty queue is indistinguishable from a clean one. That is the exact failure the
 *      review module fails closed on, and its caller must not reintroduce it.
 *   B. A REAL RUN LANDS REAL QUESTIONS — the whole battery is read, the questions are stored, and a
 *      SECOND run refreshes rather than duplicating them.
 *   C. THE QUEUE DOOR shows the work AND the vocabulary a person answers with, and is scoped to the
 *      program asked for.
 *   D. THE DECIDE DOOR takes WHO from the session and never from the body, refuses an answer outside
 *      the list, and records what a person concluded — without publishing anything.
 *   E. A SCENARIO WHOSE REFUSAL LIST NEVER ARRIVED IS NOT COUNTED AS READ. Retiring a question on the
 *      strength of a feed that never came back would read a vendor outage as "the disagreement went
 *      away" — the single most dangerous thing this queue could do.
 *
 * The Lender Price client is stubbed through require.cache BEFORE the route loads (there is no
 * upstream here, and there must never be one in a test); the database is real.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-disqualifier-review-route-db.js
 *
 * LT-only. No RTL imports beyond the shared identity zone (`src/db` for staff_users — one login for
 * both sides), which is what the rule-draft suite already uses.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-ppe-disqualifier-review-route-db (no DATABASE_URL)');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

function stubRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}
// A handler that THROWS is a defect to REPORT, not to die on — `wrap()` turns a throw into a 500 in
// production, so the stub does the same. Without it one bad path kills the run and every assertion
// after it silently never executes, which reads exactly like a passing suite that stopped early.
const call = async (fn, req) => {
  const res = stubRes();
  try { await fn(req, res); } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e), threw: true });
  }
  return res;
};
const REQ = (over = {}) => Object.assign({ params: {}, body: {}, query: {}, actor: { id: null } }, over);

(async () => {
  // ---- the Lender Price stub, installed before the route is required -------------------------
  //
  // IT MIMICS THE REAL CLIENT'S CONTRACT, NOT THE CONSUMER'S: `priceDisqualified` answers
  // `{ ok, disqualified }` and the payload is turned into `{ ready, lenders }` by `parseDisqualified`.
  // A stub that returned the parsed shape directly would pass a route that skipped that conversion —
  // which against a real upstream reads every scenario as "no refusal list" and empties the queue.
  const LP = require.resolve(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'));
  const lpStub = {
    calls: 0, disqCalls: 0, isConfigured: true,
    // What Lender Price refuses this scenario for. Default: nothing at all.
    refusal: () => null,
    configured() { return lpStub.isConfigured; },
    async price() { lpStub.calls += 1; return { ok: true, raw: {} }; },
    parseFull() { return { programs: [] }; },
    async priceDisqualified(sc) { lpStub.disqCalls += 1; return { ok: true, disqualified: { _r: lpStub.refusal(sc) } }; },
    parseDisqualified(raw) {
      const r = raw && raw._r;
      if (r === 'not_ready') return { ready: false, lenders: [] };
      if (!r) return { ready: true, lenders: [] };
      return {
        ready: true,
        lenders: [{ lender: 'Deephaven', investor: 'Deephaven', items: [{ program: 'DSCR 30 Year Fixed', reasons: [r] }] }],
      };
    },
  };
  require.cache[LP] = { id: LP, filename: LP, loaded: true, exports: lpStub };

  const route = require('../src/longterm/routes/ppe');
  const H = route.handlers;
  const I = route._internals;
  const store = require('../src/longterm/ppe/store');
  const reviewStore = require('../src/longterm/ppe/disqualifier-review-store');
  const agreementScenarios = require('../src/longterm/ppe/agreement-scenarios');
  const ltDb = require('../src/longterm/db');
  const idDb = require('../src/db');

  const SCOPE = I.SCOPE;
  const stamp = `D${process.pid}${Date.now() % 100000}`;
  const INV_CODE = `ZZ${stamp}`.slice(0, 20);
  const OTHER_SCOPE = `other_${stamp}`;
  const email = `dq.${stamp}@ys.test`;

  let staffId = null;
  const cleanup = async () => {
    for (const s of [SCOPE, OTHER_SCOPE]) {
      await ltDb.query('DELETE FROM lt_ppe_investor WHERE scope = $1 AND code LIKE $2', [s, `${INV_CODE}%`]).catch(() => {});
    }
    await idDb.query('DELETE FROM staff_users WHERE email = $1', [email]).catch(() => {});
  };

  const buildSheet = async (label, scope = SCOPE) => {
    const inv = await store.createInvestor(ltDb, scope, { code: `${INV_CODE}${label}`.slice(0, 20), name: `Review ${label}` });
    const prg = await store.createProgram(ltDb, scope, { investorId: inv.id, code: `P${label}${stamp}`.slice(0, 20), name: `DSCR ${label}` });
    await ltDb.query('UPDATE lt_ppe_program SET lp_investor = $2, lp_program_like = $3 WHERE id = $1',
      [prg.id, 'Deephaven', 'DSCR']);
    const ver = await store.createRateSheetVersion(ltDb, scope, { programId: prg.id, versionNo: 1, channel: 'correspondent' });
    await store.replaceBasePrices(ltDb, scope, ver.id, [
      { noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 },
      { noteRateMilliPct: 71250, lockDays: 30, priceMilli: 102850 },
    ]);
    return { investorId: inv.id, programId: prg.id, versionId: ver.id };
  };

  const queueRows = (programId, status = 'open') =>
    reviewStore.listQueue(ltDb, SCOPE, { programId, status, limit: 500 });

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql',
      '576_lt_ppe_ratesheet_agreement_gate.sql', '581_lt_ppe_disqualifier_review_queue.sql']) {
      await ltDb.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    const made = await idDb.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1, 'Review Admin', 'admin', true) RETURNING id`,
      [email]);
    staffId = made.rows[0].id;

    const BUILT = agreementScenarios.buildAgreementScenarios().count;
    const sheet = await buildSheet('A');

    // =========================================================================
    console.log('\nA. refused before a single scenario is read\n');
    // =========================================================================

    lpStub.disqCalls = 0;
    let res = await call(H.runDisqualifierReviewRoute, REQ({ params: { id: '00000000-0000-0000-0000-000000000000' } }));
    ok(res.statusCode === 404, 'A1 an unknown rate-sheet version is a 404');
    ok(lpStub.disqCalls === 0, 'A1b …and nothing was asked of Lender Price');

    const other = await buildSheet('O', OTHER_SCOPE);
    lpStub.disqCalls = 0;
    res = await call(H.runDisqualifierReviewRoute, REQ({ params: { id: other.versionId } }));
    ok(res.statusCode === 404, 'A2 another tenant\'s rate sheet cannot be run through this door');
    ok(lpStub.disqCalls === 0, 'A2b …and nothing was spent on it');

    const bare = await store.createRateSheetVersion(ltDb, SCOPE, { programId: sheet.programId, versionNo: 2, channel: 'correspondent' });
    lpStub.disqCalls = 0;
    res = await call(H.runDisqualifierReviewRoute, REQ({ params: { id: bare.id } }));
    ok(res.statusCode === 422 && res.body.reason === 'program_has_no_base_grid',
      'A3 a sheet with no grid is refused, naming why');
    ok(lpStub.disqCalls === 0, 'A3b …before reading anything');

    const unscoped = await buildSheet('U');
    await ltDb.query('UPDATE lt_ppe_program SET lp_investor = NULL, lp_program_like = NULL WHERE id = $1', [unscoped.programId]);
    lpStub.disqCalls = 0;
    res = await call(H.runDisqualifierReviewRoute, REQ({ params: { id: unscoped.versionId } }));
    ok(res.statusCode === 422 && res.body.reason === 'no_lp_scope',
      'A4 an UNSCOPED program is refused — the refusals would be read off the wrong programs');
    ok(/lp-scope/.test(res.body.remedy || ''), 'A4b …and the refusal names how to fix it');
    ok(lpStub.disqCalls === 0, 'A4c …before spending anything');

    lpStub.isConfigured = false;
    lpStub.disqCalls = 0;
    res = await call(H.runDisqualifierReviewRoute, REQ({ params: { id: sheet.versionId } }));
    ok(res.statusCode === 503 && res.body.reason === 'upstream_not_configured',
      'A5 an unconfigured upstream is refused UP FRONT');
    ok((await queueRows(sheet.programId)).length === 0,
      'A5b THE ONE THAT MATTERS: not one refusal left a queue behind — an empty queue must never be a run that could not read');
    lpStub.isConfigured = true;

    // =========================================================================
    console.log('\nB. a real run lays out the questions\n');
    // =========================================================================

    // Lender Price refuses every scenario over DSCR. Our sheet is a bare grid with no pricing rule at
    // all, so it neither refuses nor charges for it — the owner's own case.
    lpStub.refusal = () => ({ rule: 'DSCR below 1.10', adjType: 'DscrRateAdjustment' });
    lpStub.disqCalls = 0;
    res = await call(H.runDisqualifierReviewRoute, REQ({ params: { id: sheet.versionId } }));
    ok(res.statusCode === 200 && res.body.ok === true, 'B1 the run completes');
    ok(res.body.scenarios === BUILT && lpStub.disqCalls === BUILT,
      `B2 the WHOLE battery was read (${res.body.scenarios} of ${BUILT}), and the number reported is the number run`);
    ok(res.body.wrote.inserted > 0, `B3 questions were actually stored (${res.body.wrote.inserted})`);
    ok(res.body.notReady === 0 && res.body.errors === 0, 'B4 …with nothing unread and nothing errored');

    const q1 = await queueRows(sheet.programId);
    ok(q1.length === res.body.wrote.inserted, 'B5 the queue holds exactly what the run said it wrote');
    ok(q1.every((r) => r.classification === 'silent' && r.dimension === 'dscr'),
      'B6 THE ONE THAT MATTERS: the question is "they refuse it and our sheet says nothing about the DSCR"');
    ok(q1.every((r) => /Should we refuse this, price it, or deliberately allow it/.test(r.question || '')),
      'B7 …laid out as the actual question a person answers, not a code');

    const before = q1.length;
    res = await call(H.runDisqualifierReviewRoute, REQ({ params: { id: sheet.versionId } }));
    ok(res.body.wrote.inserted === 0 && res.body.wrote.refreshed === before,
      'B8 a second run REFRESHES the same questions — it never asks them twice');
    ok((await queueRows(sheet.programId)).length === before, 'B9 …and the queue does not grow');

    // =========================================================================
    console.log('\nC. the queue door\n');
    // =========================================================================

    res = await call(H.disqualifierReviewQueueRoute, REQ({ query: { programId: sheet.programId } }));
    ok(res.statusCode === 200 && res.body.items.length === Math.min(before, res.body.limit),
      'C1 the queue reads back through the door, one page at a time');
    // NO SILENT CAPS: a page of 100 out of 299 must say so, or a reviewer reads a third of the queue
    // as the whole of it.
    ok(res.body.notShown === before - res.body.items.length && res.body.notShown > 0,
      `C1b …and it COUNTS what is not on the page (${res.body.notShown})`);
    ok(res.body.summary.needsHuman === before, 'C2 …and says how much work is waiting');
    ok(Array.isArray(res.body.decisions) && res.body.decisions.length === reviewStore.DECISIONS.length
      && res.body.decisions.every((d) => d.means && d.means.length > 10),
      'C3 …and publishes the answers a person may give, IN WORDS — a screen must never invent them');
    ok(res.body.summary.byDimension.dscr === before, 'C4 …grouped by what it is about, so one rule can settle many');

    res = await call(H.disqualifierReviewQueueRoute, REQ({ query: { programId: sheet.programId, limit: '500' } }));
    ok(res.body.items.length === before && res.body.notShown === 0, 'C4b …and asking for more pages returns them');
    ok(res.body.limitClamped === false, 'C4c …with nothing clamped at a limit the door allows');

    // Asking for MORE than the door allows is answered, not silently turned into the default — the
    // same rule as the page count above, and the reason a caller can tell 500 from 100.
    res = await call(H.disqualifierReviewQueueRoute, REQ({ query: { programId: sheet.programId, limit: '5000' } }));
    ok(res.body.limit === 500, `C4d a limit past the ceiling is clamped to the ceiling, not to the default (${res.body.limit})`);
    ok(res.body.limitClamped === true, 'C4e …and the answer says it was clamped');

    res = await call(H.disqualifierReviewQueueRoute, REQ({ query: { programId: unscoped.programId } }));
    ok(res.body.items.length === 0, 'C5 a different program\'s queue is its own');

    // =========================================================================
    console.log('\nD. answering one\n');
    // =========================================================================

    const target = q1[0];
    res = await call(H.decideDisqualifierReviewRoute, REQ({
      params: { id: target.id }, actor: { id: staffId }, body: { decision: 'obviously', note: 'x' },
    }));
    ok(res.statusCode === 400 && res.body.code === 'unknown_decision',
      'D1 an answer outside the list is refused');

    res = await call(H.decideDisqualifierReviewRoute, REQ({
      params: { id: target.id }, actor: { id: null }, body: { decision: 'refuse', decidedBy: 'Somebody Else' },
    }));
    ok(res.statusCode === 409 && res.body.code === 'decider_unknown',
      'D2 THE ONE THAT MATTERS: with nobody signed in it refuses — and a name in the BODY does not stand in');

    res = await call(H.decideDisqualifierReviewRoute, REQ({
      params: { id: target.id }, actor: { id: staffId },
      body: { decision: 'refuse', note: 'we do not want this loan either', decidedBy: 'Somebody Else' },
    }));
    ok(res.statusCode === 200 && res.body.ok === true, 'D3 a real answer is recorded');
    ok(res.body.item.decidedBy === 'Review Admin',
      'D4 …under the name of the person SIGNED IN, never the one in the body');
    ok(res.body.item.status === 'decided' && res.body.item.decision === 'refuse', 'D5 …and the question is settled');
    ok(/changes no price and publishes no rule/.test(res.body.note || ''),
      'D6 …and the answer says plainly that it published nothing');

    ok((await queueRows(sheet.programId)).length === before - 1,
      'D7 …so it is out of the open queue, which is what a reviewer opens');

    res = await call(H.decideDisqualifierReviewRoute, REQ({
      params: { id: '00000000-0000-0000-0000-000000000000' }, actor: { id: staffId }, body: { decision: 'refuse' },
    }));
    ok(res.statusCode === 404, 'D8 a question that is not there is a 404');

    // =========================================================================
    console.log('\nE. a refusal list that never arrived is not a clean sheet\n');
    // =========================================================================

    lpStub.refusal = () => 'not_ready';
    res = await call(H.runDisqualifierReviewRoute, REQ({ params: { id: sheet.versionId } }));
    ok(res.statusCode === 200 && res.body.notReady === BUILT,
      'E1 every scenario is reported as unread rather than as clean');
    ok(res.body.wrote.inserted === 0 && res.body.wrote.refreshed === 0, 'E2 …nothing was written');
    ok(res.body.staled === 0,
      'E3 THE ONE THAT MATTERS: nothing was retired — a vendor outage must never read as "the disagreement went away"');
    ok((await queueRows(sheet.programId)).length === before - 1, 'E4 …and the queue is exactly as it was');
    ok(res.body.notReadySample.length > 0 && /never arrived/.test(res.body.notReadySample[0].reason || ''),
      'E5 …and the run says WHY it read nothing, in words');

    // And when they genuinely stop refusing it, the question IS retired — not deleted.
    lpStub.refusal = () => null;
    res = await call(H.runDisqualifierReviewRoute, REQ({ params: { id: sheet.versionId } }));
    ok(res.body.staled === before - 1, 'E6 a refusal that genuinely stops coming back is retired');
    ok((await queueRows(sheet.programId, 'stale')).length === before - 1, 'E7 …as STALE, not deleted');
    ok((await queueRows(sheet.programId, 'decided')).length === 1,
      'E8 …and the DECIDED one is left alone: a settled answer is not obsolete because the question stopped coming up');
  } finally {
    await cleanup();
    await ltDb.pool.end().catch(() => {});
    await idDb.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

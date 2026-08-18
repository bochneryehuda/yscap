'use strict';
/**
 * LT PPE — the RULE surfaces, over REAL HTTP against a real Postgres.
 *
 * WHAT WAS WRONG, MEASURED BEFORE THIS SUITE EXISTED. Five live routes had no screen
 * (`GET /ppe/rules`, `GET /ppe/rules/coverage`, `POST /ppe/suggestions/mine`,
 * `GET /ppe/rate-sheets/:id/diff`, `GET /ppe/programs/:id/lp-scope`), and the whole rule-AUTHORING
 * service — `rule-authoring.js`, `rule-authoring-store.js` (db/577), and the two libraries under them
 * — had NO HTTP door at all. The service's own suites are green and prove the DECISIONS; nothing
 * proved a person could reach any of it.
 *
 * SO THIS SUITE GOES THROUGH THE FRONT DOOR AND NOWHERE ELSE. `app.listen(0)` and `fetch` with a real
 * signed-in session, because the two things that were missing are exactly the two a direct handler
 * call cannot show: that the route is MOUNTED at the path the client asks for, and that the ADMIN GATE
 * in front of it is really there. Every route is asked twice — once as an administrator, once as an
 * ordinary loan officer — and the officer's 403 is asserted every time.
 *
 * ⛔ A WRITE'S OWN 200 IS NOT EVIDENCE. Every draft assertion re-reads from the SERVER after the
 * write, through a different route, and asserts on what comes back. A response echoing what was sent
 * proves the request was accepted and nothing about what is stored — this workstream has already been
 * bitten by exactly that (a program's Lender Price scope re-read from its own write).
 *
 * ⛔ AND IT PROVES THE PUBLISH DOOR IS SUPER-ADMIN ONLY. Publishing a draft changes what a real loan is
 * priced at. Who may do that was an open owner question (§2.51) until 2026-08-18 — *"all in the super
 * admin"* — so the door exists now and section E proves the ANSWER rather than the old absence: an
 * ADMIN is refused and `lt_ppe_rule` still holds nothing, a SUPER ADMIN succeeds and the rule is
 * genuinely in the table, the publisher recorded is the super admin's own name taken from the session,
 * and a second publish of the same draft is refused rather than quietly doing it twice.
 *
 * THREE STAFF, NOT TWO, AND THAT IS THE POINT. A gate that only ever sees one authorised role proves
 * nothing about who it turns away, so every publish assertion is made twice — once as the role that
 * may not, once as the role that may.
 *
 * ⛔ `POST /ppe/suggestions/mine` IS NEVER ACTUALLY RUN HERE. With a search key it polls Lender Price,
 * which is a live vendor call that costs money. Its GATE and its refusal-without-a-key are proven; its
 * mining is not, and pretending otherwise by sending a fake key would spend a vendor round trip to
 * assert nothing.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-rule-drafts-db.js
 *
 * LT-only. No RTL imports beyond the shared identity zone this repo's other LT HTTP suites use
 * (`src/db` for staff_users + `src/auth` to mint a session — the login is one login for both sides).
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-ppe-rule-drafts-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lt-rule-drafts-test-secret';

const fs = require('fs');
const path = require('path');

const db = require('../src/db');
const ltDb = require('../src/longterm/db');
const auth = require('../src/auth');

let failures = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

/**
 * A SECTION THAT THROWS IS A FAILURE TO REPORT, NOT A RUN TO END. A crashing suite exits non-zero,
 * which looks exactly like a test that caught something — while everything after the throw silently
 * never ran. Each section names its own failure and the rest still execute.
 */
async function section(name, fn) {
  console.log(`\n${name}\n`);
  try { await fn(); } catch (e) {
    ok(false, `${name} — THREW instead of answering: ${(e && e.message) || e}`);
  }
}

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, p, token, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };

  const store = require('../src/longterm/ppe/store');
  const SCOPE = require('../src/longterm/routes/ppe')._internals.SCOPE;

  const stamp = `RD${process.pid}${Date.now() % 100000}`;
  const INV_CODE = `ZZ${stamp}`.slice(0, 20);
  const CODE = `llpa_${stamp}`.toLowerCase().slice(0, 60);
  // A SECOND code for the publish section. Section D discards the first draft, and a discarded draft
  // can never be published — so proving the door needs a draft of its own, on its own cell.
  const CODE2 = `llpb_${stamp}`.toLowerCase().slice(0, 60);
  const emails = [`${stamp}.admin@example.test`, `${stamp}.lo@example.test`, `${stamp}.super@example.test`];

  let investorId = null;
  let programId = null;

  const cleanup = async () => {
    await ltDb.query('DELETE FROM lt_ppe_rule_draft WHERE scope = $1 AND code LIKE $2', [SCOPE, `%${stamp}%`]).catch(() => {});
    await ltDb.query('DELETE FROM lt_ppe_rule WHERE scope = $1 AND code LIKE $2', [SCOPE, `%${stamp}%`]).catch(() => {});
    if (programId) await ltDb.query('DELETE FROM lt_ppe_program WHERE id = $1', [programId]).catch(() => {});
    if (investorId) await ltDb.query('DELETE FROM lt_ppe_investor WHERE id = $1', [investorId]).catch(() => {});
    await db.query('DELETE FROM staff_users WHERE email = ANY($1::text[])', [emails]).catch(() => {});
  };

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql',
      '571_lt_ppe_rule_and_suggestion_store.sql', '577_lt_ppe_rule_draft_authoring_not_publishing.sql']) {
      await ltDb.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    const { rows: made } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Rule Admin', 'admin', true), ($2, 'Rule Officer', 'loan_officer', true),
                   ($3, 'Rule Super', 'super_admin', true)
         RETURNING id, email, role`, emails);
    const admin = made.find((r) => r.role === 'admin');
    const officer = made.find((r) => r.role === 'loan_officer');
    const superAdmin = made.find((r) => r.role === 'super_admin');
    const adminTok = await auth.mintStaffSession(admin.id);
    const loTok = await auth.mintStaffSession(officer.id);
    const superTok = await auth.mintStaffSession(superAdmin.id);

    const inv = await store.createInvestor(ltDb, SCOPE, { code: INV_CODE, name: `Rule board ${stamp}` });
    investorId = inv.id;
    const prg = await store.createProgram(ltDb, SCOPE, {
      investorId, code: `P${stamp}`.slice(0, 20), name: 'DSCR rule board',
    });
    programId = prg.id;

    // =====================================================================
    // A. the five routes that were built and unreachable
    // =====================================================================
    await section('A. the routes that had no screen are reachable, and gated as they claim', async () => {
      const rules = await call('GET', '/api/lt/ppe/rules', adminTok);
      ok(rules.status === 200 && Array.isArray(rules.json.rules),
        'A1 GET /ppe/rules answers the stored rule set over HTTP');

      const cov = await call('GET', '/api/lt/ppe/rules/coverage', adminTok);
      ok(cov.status === 200 && Array.isArray(cov.json.overlaps) && Array.isArray(cov.json.gaps)
        && cov.json.analyzed && typeof cov.json.analyzed.pricingRules === 'number',
      'A2 GET /ppe/rules/coverage answers overlaps, holes AND how many rules it could read');
      const covLo = await call('GET', '/api/lt/ppe/rules/coverage', loTok);
      ok(covLo.status === 403, 'A3 …and a loan officer is refused it');

      const scope = await call('GET', `/api/lt/ppe/programs/${programId}/lp-scope`, adminTok);
      ok(scope.status === 200 && scope.json.programId === programId,
        'A4 GET /ppe/programs/:id/lp-scope reads the STORED scope, not a write\'s own echo');
      ok(scope.json.lpScope === null && /abstain/i.test(scope.json.note || ''),
        'A5 …and an unscoped program SAYS its comparison abstains rather than leaving an empty object');
      const scopeLo = await call('GET', `/api/lt/ppe/programs/${programId}/lp-scope`, loTok);
      ok(scopeLo.status === 403, 'A6 …refused to a loan officer');

      // Written through the store, then read back through the ROUTE — the whole point of A4.
      await store.setProgramLpScope(ltDb, SCOPE, programId, { programLike: `Rule Board ${stamp}` }, admin.id);
      const again = await call('GET', `/api/lt/ppe/programs/${programId}/lp-scope`, adminTok);
      ok(again.status === 200 && again.json.lpScope
        && again.json.lpScope.programLike === `Rule Board ${stamp}`,
      'A7 …and it reports a scope somebody ELSE wrote, which is what a re-read from the write cannot do');

      // The miner: gate and refusal only. Running it costs a live Lender Price call.
      const mineLo = await call('POST', '/api/lt/ppe/suggestions/mine', loTok, { searchKey: 'x' });
      ok(mineLo.status === 403, 'A8 POST /ppe/suggestions/mine is refused to a loan officer');
      const mineNothing = await call('POST', '/api/lt/ppe/suggestions/mine', adminTok, {});
      ok(mineNothing.status === 400 && /searchKey/.test(JSON.stringify(mineNothing.json)),
        'A9 …and with nothing to mine it refuses and NAMES what it needs, without calling the vendor');
    });

    // =====================================================================
    // B. the rate-sheet version diff, over HTTP, on two real versions
    // =====================================================================
    await section('B. what changed between two versions of a sheet', async () => {
      const v1 = await store.createRateSheetVersion(ltDb, SCOPE, { programId, versionNo: 1 });
      await store.replaceBasePrices(ltDb, SCOPE, v1.id, [
        { noteRateMilliPct: 7000, lockDays: 30, product: 'DSCR30', priceMilli: 100000 },
        { noteRateMilliPct: 7250, lockDays: 30, product: 'DSCR30', priceMilli: 100500 },
      ]);
      const v2 = await store.createRateSheetVersion(ltDb, SCOPE, { programId, versionNo: 2 });
      await store.replaceBasePrices(ltDb, SCOPE, v2.id, [
        { noteRateMilliPct: 7000, lockDays: 30, product: 'DSCR30', priceMilli: 100250 },
        { noteRateMilliPct: 7250, lockDays: 30, product: 'DSCR30', priceMilli: 100500 },
      ]);

      const first = await call('GET', `/api/lt/ppe/rate-sheets/${v1.id}/diff`, adminTok);
      ok(first.status === 200 && first.json.against === null && /first version/i.test(first.json.note || ''),
        'B1 a FIRST version is reported as having nothing to compare against — never as "no changes"');

      const d = await call('GET', `/api/lt/ppe/rate-sheets/${v2.id}/diff`, adminTok);
      // Pinned to the version's own ID, not merely to "a version numbered 1": every program has one,
      // so a comparison that wandered onto another program's sheet would satisfy the number.
      ok(d.status === 200 && d.json.against && d.json.against.id === v1.id && d.json.against.versionNo === 1,
        'B2 the default comparison is the previous version OF THIS PROGRAM');
      ok(Array.isArray(d.json.changed) && d.json.changed.length === 1,
        'B3 …and it finds the one cell that actually moved');
      ok(d.json.unchanged === 1,
        'B4 …and counts the one that did not, so a clean diff is distinguishable from an empty read');
      ok(Array.isArray(d.json.ordinary) && Array.isArray(d.json.needsReading),
        'B5 …split into ordinary refreshes and changes that need reading (§7.4)');

      const dLo = await call('GET', `/api/lt/ppe/rate-sheets/${v2.id}/diff`, loTok);
      ok(dLo.status === 403, 'B6 …and a loan officer is refused the diff');
    });

    // =====================================================================
    // C. the DRAFT doors — every one over HTTP, every one gated
    // =====================================================================
    let draftId = null;
    const intent = {
      op: 'add_llpa',
      code: CODE,
      adjMilli: 250,
      dimension: 'fico',
      reason: 'FICO 640–659',
      when: { fact: 'fico', op: 'between', value: [640, 660] },
    };

    await section('C. a draft round trip, re-read from the server every time', async () => {
      const listLo = await call('GET', '/api/lt/ppe/rule-drafts', loTok);
      ok(listLo.status === 403, 'C1 GET /ppe/rule-drafts is refused to a loan officer');

      const empty = await call('GET', '/api/lt/ppe/rule-drafts', adminTok);
      ok(empty.status === 200 && Array.isArray(empty.json.drafts),
        'C2 …and an administrator gets the list');
      ok(empty.json.catalog && Array.isArray(empty.json.catalog.dimensions)
        && empty.json.catalog.dimensions.some((x) => x.name === 'fico' && x.label === 'FICO score'),
      'C3 …with the authoring catalog on it, so a screen\'s pickers come from rule-builder rather than a typed list');
      ok(empty.json.catalog.pppStructures && empty.json.catalog.pppStructures.length > 0,
        'C4 …including the prepayment-penalty structures, from the library');
      ok(empty.json.live === false && /prices nothing/i.test(empty.json.liveNote || ''),
        'C5 …and the list SAYS a draft is not in force rather than leaving the screen to remember');

      const saveLo = await call('POST', '/api/lt/ppe/rule-drafts', loTok, { intent, investorId, programId });
      ok(saveLo.status === 403, 'C6 POST /ppe/rule-drafts is refused to a loan officer');

      const bad = await call('POST', '/api/lt/ppe/rule-drafts', adminTok, { investorId, programId });
      ok(bad.status === 400 && Array.isArray(bad.json.operations) && bad.json.operations.includes('add_llpa'),
        'C7 a body with no intent is refused, and the refusal LISTS what this editor can do');

      const nonsense = await call('POST', '/api/lt/ppe/rule-drafts', adminTok,
        {
          // A rule whose own conditions contradict each other. It would store cleanly and price
          // nobody — a dead rule with no error anywhere, which is exactly what the service refuses.
          intent: {
            op: 'add_llpa', code: CODE, adjMilli: 250,
            when: { all: [{ fact: 'fico', op: 'gte', value: 700 }, { fact: 'fico', op: 'lt', value: 600 }] },
          },
          investorId,
          programId,
        });
      ok(nonsense.status === 422 && Array.isArray(nonsense.json.refusals)
        && nonsense.json.refusals.some((r) => r.code === 'never_fires'),
      'C8 a rule that could never fire comes back as a REFUSAL a screen can render, not a 500 and not a stored dead rule');
      ok(typeof nonsense.json.refusals[0].message === 'string' && nonsense.json.refusals[0].message.length > 20,
        'C9 …written for somebody who does not know what a predicate is');

      const saved = await call('POST', '/api/lt/ppe/rule-drafts', adminTok,
        { intent, investorId, programId, note: 'from the rule board' });
      ok(saved.status === 201 && saved.json.draft && saved.json.draft.id, 'C10 a valid rule is saved as a draft');
      ok(saved.json.live === false, 'C11 …and the write itself says it is not live');
      draftId = saved.json.draft && saved.json.draft.id;

      // THE RE-READ. Everything above came out of the write's own answer; this is the server's.
      const listed = await call('GET', '/api/lt/ppe/rule-drafts', adminTok);
      const mine = (listed.json.drafts || []).find((x) => x.id === draftId);
      ok(!!mine, 'C12 THE RE-READ: the draft is in the list the server builds from the table, not from the write');
      ok(mine && mine.code === CODE && mine.kind === 'pricing' && mine.status === 'draft',
        'C13 …with the code, kind and status the table holds');
      ok(mine && mine.createdBy === admin.id,
        'C14 …recorded against the person who was signed in, taken from the session and not from the body');

      const one = await call('GET', `/api/lt/ppe/rule-drafts/${draftId}`, adminTok);
      ok(one.status === 200 && one.json.draft && one.json.draft.code === CODE,
        'C15 GET /ppe/rule-drafts/:id reads that one back');
      ok(one.json.draft.rule && one.json.draft.rule.adjustment
        && one.json.draft.rule.adjustment.adjMilli === 250,
      'C16 …and the canonical rule survives the round trip through Postgres byte for byte');
      const oneLo = await call('GET', `/api/lt/ppe/rule-drafts/${draftId}`, loTok);
      ok(oneLo.status === 403, 'C17 …refused to a loan officer');
      const missing = await call('GET', '/api/lt/ppe/rule-drafts/999999999', adminTok);
      ok(missing.status === 404, 'C18 …and a draft that is not there is a 404, not an empty 200');

      const rendered = await call('GET', `/api/lt/ppe/rule-drafts/${draftId}/render`, adminTok);
      ok(rendered.status === 200 && rendered.json.render && /FICO/.test(rendered.json.render.headline),
        'C19 GET /ppe/rule-drafts/:id/render says in words what the rule does');
      ok(rendered.json.render.cell === 'fico [640, 660)',
        'C20 …and names the cell it covers, half-open as the engine reads it');
      ok(rendered.json.render.live === false && /draft/i.test(rendered.json.render.liveNote || ''),
        'C21 …and the render itself carries "this is a draft"');
      ok(rendered.json.publishable === true
        && rendered.json.publishRoute === 'POST /api/lt/ppe/rule-drafts/:id/publish'
        && rendered.json.publishAuthority === 'super_admin' && /super admin/i.test(rendered.json.publishNote || ''),
      'C22 THE ONE THAT MATTERS: "publishable" is answered AND the payload names the door and who may use it');
      const rendLo = await call('GET', `/api/lt/ppe/rule-drafts/${draftId}/render`, loTok);
      ok(rendLo.status === 403, 'C23 …refused to a loan officer');

      const dup = await call('POST', '/api/lt/ppe/rule-drafts', adminTok, { intent, investorId, programId });
      ok(dup.status === 409 && (dup.json.refusals || []).some((r) => r.code === 'draft_exists'),
        'C24 a second person drafting the same rule is refused at the database, as a 409 and not a 422');
    });

    // =====================================================================
    // D. discarding — and the fact that nothing here published anything
    // =====================================================================
    await section('D. discarding a draft', async () => {
      const delLo = await call('DELETE', `/api/lt/ppe/rule-drafts/${draftId}`, loTok);
      ok(delLo.status === 403, 'D1 DELETE /ppe/rule-drafts/:id is refused to a loan officer');

      const gone = await call('DELETE', `/api/lt/ppe/rule-drafts/${draftId}?note=changed+my+mind`, adminTok);
      ok(gone.status === 200 && gone.json.ok, 'D2 an administrator can discard it');

      const after = await call('GET', `/api/lt/ppe/rule-drafts/${draftId}`, adminTok);
      ok(after.status === 200 && after.json.draft.status === 'discarded',
        'D3 THE RE-READ: the server says discarded — the row is kept, nothing is deleted');
      ok(after.json.draft.note === 'changed my mind',
        'D4 …with the reason it was dropped, which is worth as much as the draft was');

      const twice = await call('DELETE', `/api/lt/ppe/rule-drafts/${draftId}`, adminTok);
      ok(twice.status === 409 && /already been published or discarded/i.test(twice.json.error || ''),
        'D5 discarding it again is refused rather than answering a cheerful 200');

      const open = await call('GET', '/api/lt/ppe/rule-drafts', adminTok);
      ok(!(open.json.drafts || []).some((x) => x.id === draftId),
        'D6 …and it is out of the OPEN list, which defaults to drafts alone');
      const all = await call('GET', '/api/lt/ppe/rule-drafts?status=all', adminTok);
      ok((all.json.drafts || []).some((x) => x.id === draftId),
        'D7 …but still there under ?status=all, because history is the point of not deleting it');
      const nonsense = await call('GET', '/api/lt/ppe/rule-drafts?status=whatever', adminTok);
      ok(nonsense.status === 400, 'D8 a status this table cannot hold is refused rather than silently ignored');
      const badId = await call('GET', '/api/lt/ppe/rule-drafts?investorId=not-a-uuid', adminTok);
      ok(badId.status === 400,
        'D9 an unreadable investor id is REFUSED, never coerced to null — null means "the house drafts", a different question');

      // A DISCARDED DRAFT PUBLISHED NOTHING. Section E proves what publishing DOES; this proves that
      // walking a draft all the way to the bin never touched the live table on the way.
      const live = await ltDb.query('SELECT id FROM lt_ppe_rule WHERE scope = $1 AND code = $2', [SCOPE, CODE]);
      ok(live.rows.length === 0,
        'D10 THE ONE THAT MATTERS: after a whole draft round trip ending in a discard, lt_ppe_rule holds NOTHING under that code');

      const gonePub = await call('POST', `/api/lt/ppe/rule-drafts/${draftId}/publish`, superTok, {});
      ok(gonePub.status === 409 && /discarded/i.test(JSON.stringify(gonePub.json)),
        'D11 …and a discarded draft cannot be published even by a super admin — the refusal SAYS it was discarded');
      const stillNothing = await ltDb.query('SELECT id FROM lt_ppe_rule WHERE scope = $1 AND code = $2', [SCOPE, CODE]);
      ok(stillNothing.rows.length === 0, 'D12 …and that refusal wrote nothing');
    });

    // =====================================================================
    // E. THE PUBLISH DOOR — the owner's answer, over real HTTP
    // =====================================================================
    //
    // ⛔ EVERY ASSERTION HERE IS MADE TWICE, once as the role that may not publish and once as the role
    // that may. A gate tested only by the person it lets through is not tested.
    await section('E. publishing a rule is a super admin\'s act, and only a super admin\'s', async () => {
      const intent2 = {
        op: 'add_llpa',
        code: CODE2,
        adjMilli: 375,
        dimension: 'fico',
        reason: 'FICO 660–679',
        when: { fact: 'fico', op: 'between', value: [660, 680] },
      };
      const saved = await call('POST', '/api/lt/ppe/rule-drafts', adminTok, { intent: intent2, investorId, programId });
      ok(saved.status === 201 && saved.json.draft && saved.json.draft.id, 'E1 an administrator can still AUTHOR the draft');
      const pubId = saved.json.draft && saved.json.draft.id;

      const byLo = await call('POST', `/api/lt/ppe/rule-drafts/${pubId}/publish`, loTok, {});
      ok(byLo.status === 403, 'E2 a loan officer cannot publish it');

      const byAdmin = await call('POST', `/api/lt/ppe/rule-drafts/${pubId}/publish`, adminTok, {});
      ok(byAdmin.status === 403 && /super admin/i.test(byAdmin.json.error || ''),
        'E3 THE ONE THAT MATTERS: an ADMINISTRATOR cannot publish it either, and is told why');
      const afterAdmin = await ltDb.query('SELECT id FROM lt_ppe_rule WHERE scope = $1 AND code = $2', [SCOPE, CODE2]);
      ok(afterAdmin.rows.length === 0,
        'E4 …and the refusal wrote NOTHING — the live rule table still holds nothing under that code');

      const byNobody = await call('POST', `/api/lt/ppe/rule-drafts/${pubId}/publish`, null, {});
      ok(byNobody.status === 401 || byNobody.status === 403, 'E5 …and a caller with no session is refused as well');

      const bySuper = await call('POST', `/api/lt/ppe/rule-drafts/${pubId}/publish`, superTok, {});
      ok(bySuper.status === 200 && bySuper.json.ok === true, 'E6 a SUPER ADMIN publishes it');
      ok(bySuper.json.live === true && /in force/i.test(bySuper.json.liveNote || ''),
        'E7 …and the answer SAYS the rule is in force rather than leaving the screen to infer it from a missing flag');
      ok(Number.isFinite(Number(bySuper.json.ruleId)),
        'E8 …and it names the live rule it created, so a screen can link straight to it');

      // THE RE-READ, straight from the table the ENGINE reads. Everything above came out of the
      // write's own answer; this is the only thing that proves the rule is actually pricing.
      const liveRow = await ltDb.query(
        'SELECT id, code, kind, active, adjustment, created_by FROM lt_ppe_rule WHERE scope = $1 AND code = $2', [SCOPE, CODE2]);
      ok(liveRow.rows.length === 1, 'E9 THE RE-READ: lt_ppe_rule now genuinely holds exactly one row under that code');
      ok(liveRow.rows[0] && liveRow.rows[0].active === true && liveRow.rows[0].kind === 'pricing',
        'E10 …live and of the kind that prices');
      ok(liveRow.rows[0] && String(liveRow.rows[0].id) === String(bySuper.json.ruleId),
        'E11 …and it is the very rule the answer named');
      ok(liveRow.rows[0] && liveRow.rows[0].created_by === 'Rule Super',
        'E12 …recorded against the SUPER ADMIN who was signed in, taken from the session and never from the body');

      const draftAfter = await call('GET', `/api/lt/ppe/rule-drafts/${pubId}`, adminTok);
      ok(draftAfter.status === 200 && draftAfter.json.draft && draftAfter.json.draft.status === 'published',
        'E13 the draft itself reads as published');
      ok(draftAfter.json.draft && draftAfter.json.draft.publishedBy === 'Rule Super'
        && String(draftAfter.json.draft.publishedRuleId) === String(bySuper.json.ruleId),
      'E14 …naming who published it and which live rule it became');

      const twice = await call('POST', `/api/lt/ppe/rule-drafts/${pubId}/publish`, superTok, {});
      ok(twice.status === 409 && /already published/i.test(JSON.stringify(twice.json)),
        'E15 publishing the same draft again is REFUSED rather than quietly doing it twice');
      const stillOne = await ltDb.query('SELECT id FROM lt_ppe_rule WHERE scope = $1 AND code = $2', [SCOPE, CODE2]);
      ok(stillOne.rows.length === 1, 'E16 …and there is still exactly one live rule, not two');

      // A published rule joins the set the pricing path reads. Asked through the ROUTE, not the store,
      // because the whole point of the door is that what a person can reach and what prices a loan are
      // the same set.
      const rules = await call('GET', '/api/lt/ppe/rules', adminTok);
      ok(rules.status === 200 && (rules.json.rules || []).some((r) => r.code === CODE2),
        'E17 THE ONE THAT MATTERS MOST: the published rule is in the live rule set the engine prices from');
    });

  } catch (e) {
    failures += 1;
    console.error('  FAIL unexpected error:', (e && e.stack) || e);
  } finally {
    await cleanup();
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${failures ? `${failures} FAILED of ${checks}` : `all ${checks} passed`}`);
  process.exit(failures ? 1 : 0);
})();

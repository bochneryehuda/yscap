#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the OPERATOR doors, over real HTTP against a real Postgres: the ones a person presses that
 * change the ledger, the rule set or the cadence.
 *
 * THE DEFECT THIS EXISTS FOR, MEASURED. A probe that wrapped the router's own layers and ran the whole
 * `test-lt-*` family recorded, for each of these doors, either NO invocation at all or only its
 * argument-validation refusal. V8 line coverage of `src/longterm/routes/ppe.js` named the unexecuted
 * blocks exactly:
 *
 *   · `resolveBattery`'s MATRIX branch (636–655) — including the 422 that refuses a battery rather
 *     than thinning it, whose whole reason for existing is that an agreement rate measured over
 *     scenarios nobody chose feeds the promote gate;
 *   · `decideFindingRoute`'s SUCCESS path (441) — every one of its five covered calls was a refusal,
 *     so "a human settles a finding" had never once happened in a test;
 *   · `acceptSuggestionRoute`'s body (1173–1188): the investor auto-scoping, the 404, and the 409 that
 *     refuses to GUESS a rule Lender Price's wording could not be mapped to;
 *   · `dismissSuggestionRoute`'s success and 409 (1219–1220);
 *   · `mineSuggestionsRoute`'s searchKey branch and its 202 (1235–1240);
 *   · `ruleCoverageRoute`, `parityCellsRoute` and `deleteScheduleRoute` — three handlers invoked by
 *     NOTHING, at all.
 *
 * These are not edge cases. They are the accept, the settle, the battery and the cadence — the four
 * things this engine is operated with.
 *
 * WHAT IS STUBBED: only `src/longterm/lenderprice/client.js`, the paid vendor over the network.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-operator-doors-db.js
 *
 * LT-only. Writes only `lt_ppe_*` rows (plus the one shared-identity `staff_users` row it signs in
 * with) and removes every one of them at the end.
 */

if (!process.env.DATABASE_URL) {
  console.log('  --  skipped (no DATABASE_URL) — set DATABASE_URL to run it; every door here writes to a real table');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lt-ppe-operator-doors-secret';

const path = require('path');

let failures = 0;
let n = 0;
const ok = (cond, label) => { n += 1; console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures += 1; };

const LP_PATH = require.resolve(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'));
const lp = {
  calls: [],
  polls: [],
  pollResult: { ready: false },
  price: async (sc) => { lp.calls.push(sc); return { ok: true, raw: { STUB: 'raw' }, request: {}, searchKey: 'stub-key' }; },
  parse: () => ({ programs: [{ program: 'DSCR 30 Yr Fixed', product: 'Fixed', rungs: [{ rate: 7.125, price: 90.0 }] }] }),
  parseFull: () => ({ programs: [] }),
  hasDisqualifyData: () => false,
  parseDisqualified: () => ({ ready: false, lenders: [] }),
  pollDisqualifiedByKey: async (k) => { lp.polls.push(k); return lp.pollResult; },
};
require.cache[LP_PATH] = { id: LP_PATH, filename: LP_PATH, loaded: true, exports: lp };

const db = require('../src/db');
const ltDb = require('../src/longterm/db');
const auth = require('../src/auth');
const store = require('../src/longterm/ppe/store');
const findingStore = require('../src/longterm/ppe/finding-store');

const SCOPE = 'company';

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = `op${process.pid}${Date.now().toString().slice(-6)}`;
  const made = { staff: [], investor: null, program: null, suggestions: [], rules: [], investors: [] };

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

  /** Insert one suggestion exactly as `rule-store.saveSuggestions` writes one. */
  const addSuggestion = async ({ label, code, predicate, needsHuman = false, reason }) => {
    const r = await ltDb.query(
      `INSERT INTO lt_ppe_rule_suggestion
         (scope, investor_label, dedupe_key, code, kind, source, predicate, decline_reason, needs_human, programs, occurrences)
       VALUES ($1,$2,$3,$4,'eligibility','overlay',$5::jsonb,$6,$7,'[]'::jsonb,1) RETURNING id`,
      [SCOPE, label, `${code}|${reason}`, code, predicate == null ? null : JSON.stringify(predicate), reason, needsHuman]);
    made.suggestions.push(r.rows[0].id);
    return r.rows[0].id;
  };

  try {
    const { rows: staff } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1, 'PPE Operator', 'admin', true) RETURNING id`,
      [`${stamp}.admin@example.test`],
    );
    made.staff = staff.map((r) => r.id);
    const tok = await auth.mintStaffSession(staff[0].id);

    const investorName = `Operator Doors ${stamp}`;
    const investor = await store.createInvestor(ltDb, SCOPE, { code: `OD${stamp}`.slice(0, 20), name: investorName });
    made.investor = investor.id;
    made.investors.push(investor.id);
    const program = await store.createProgram(ltDb, SCOPE, { investorId: investor.id, code: `ODP${stamp}`.slice(0, 40), name: 'DSCR 30yr' });
    made.program = program.id;
    const version = await store.createRateSheetVersion(ltDb, SCOPE, { programId: program.id, versionNo: 1, channel: 'correspondent' });
    await store.replaceBasePrices(ltDb, SCOPE, version.id, [{ noteRateMilliPct: 7125, lockDays: 30, priceMilli: 102850 }]);
    // THE CANARY REFUSES AN UNSCOPED SHEET, once, before it pays for a single vendor call (§2 canary
    // leg). Without a Lender Price scope our one ladder would be compared against EVERY program
    // Lender Price returns, which is not a comparison — so this seed states which board it is about,
    // exactly as a real sheet must before anybody can run a battery on it.
    await store.setProgramLpScope(ltDb, SCOPE, program.id, { programLike: 'DSCR.* 30 Yr Fixed' }, staff[0].id);

    // ── 1) the canary's MATRIX battery ─────────────────────────────────────
    console.log('\n1) POST /canary with a matrix — the branch that refuses rather than thins');
    {
      lp.calls = [];
      const tooBig = await call('POST', '/api/lt/ppe/canary', tok, {
        investor: `${stamp}-big`,
        rateSheetVersionId: version.id,
        // 10 × 10 × 10 = 1000, twice the cap: buildMatrix would STRIDE it down to 500 and report the
        // truncation, and this endpoint refuses that outright.
        matrix: {
          fico: [660, 680, 700, 720, 740, 760, 780, 800, 820, 840],
          ltv: [50000, 55000, 60000, 65000, 70000, 72500, 75000, 77500, 80000, 85000],
          dscr: [1000, 1050, 1100, 1150, 1200, 1250, 1300, 1350, 1400, 1500],
        },
      });
      ok(tooBig.status === 422, `A1 a matrix over the cap is REFUSED 422, not silently thinned (${tooBig.status})`);
      ok(tooBig.json && tooBig.json.reason === 'battery_truncated' && tooBig.json.limit === 500 && tooBig.json.asked === 1000,
        `A2 …naming the limit and what was asked (${JSON.stringify(tooBig.json && { r: tooBig.json.reason, l: tooBig.json.limit, a: tooBig.json.asked })})`);
      ok(/scenarios nobody chose/.test((tooBig.json && tooBig.json.error) || ''),
        'A3 …and saying WHY: an agreement rate over a thinned battery is measured on scenarios nobody chose');
      ok(lp.calls.length === 0, `A4 …and NOT ONE scenario was priced against the upstream first (${lp.calls.length})`);

      const empty = await call('POST', '/api/lt/ppe/canary', tok, {
        investor: `${stamp}-empty`, rateSheetVersionId: version.id, matrix: { fico: [] },
      });
      ok(empty.status === 400 && empty.json && empty.json.reason === 'empty_battery',
        `A5 a matrix with an empty axis produces nothing to price and says so (${empty.status} ${empty.json && empty.json.reason})`);
      ok(lp.calls.length === 0, 'A6 …still nothing priced');

      const run = await call('POST', '/api/lt/ppe/canary', tok, {
        investor: `${stamp}-run`, rateSheetVersionId: version.id,
        matrix: { fico: [700, 780], dscr: [1100, 1250] },
      });
      ok(run.status === 200, `A7 a matrix INSIDE the cap runs (${run.status}: ${JSON.stringify(run.json).slice(0, 160)})`);
      ok(run.json && run.json.scenarios === 4, `A8 …over the 2×2 the matrix expands to (${run.json && run.json.scenarios})`);
      ok(lp.calls.length === 4, `A9 …pricing each of them against Lender Price exactly once (${lp.calls.length})`);
      // EVERY SCENARIO IS ACCOUNTED FOR, and the rate is only ever reported over what could actually
      // be compared. Written as the INVARIANT rather than as an expected number on purpose: it holds
      // whatever the two engines say, so it can never have to be rewritten to keep a suite green —
      // and it is exactly the promise ("nothing is reported as measured that was not measured") that a
      // fabricated 1.0 would break.
      const s = run.json.summary || {};
      ok(s.scenarios === 4 && (s.agreed + s.disagreed + s.incomparable) === 4,
        `A10 every scenario is accounted for — agreed ${s.agreed}, disagreed ${s.disagreed}, incomparable ${s.incomparable} of ${s.scenarios}`);
      const comparable = s.agreed + s.disagreed;
      ok(run.json.agreementRate === (comparable ? s.agreed / comparable : null),
        `A10b …and the agreement rate is measured over the COMPARABLE ones only, or null when there were none (${run.json.agreementRate})`);
      ok(run.json.runPersisted === true && run.json.runPersistError === null,
        'A11 …and the run record reached the series the scoreboard reads');

      // AN OBSERVATION, RECORDED RATHER THAN GUESSED AT. On this run every scenario came back
      // INCOMPARABLE: `runBattery` wires `theirs: (sc) => lp.price(sc)`, and `lp.price` returns the RAW
      // envelope ({ ok, raw, request, searchKey }) — the very distinction `/quote` fixed for itself by
      // wiring `lpDetail` (§2.8, and the comment there says an envelope read as a parsed result made
      // "Lender Price read as INELIGIBLE"). `shadow.runOne` hands whatever `theirs` returned straight
      // to `parity.compareScenario`, which cannot read an envelope. Whether the canary is MEANT to
      // parse it is not derivable from the code — both legs are wired deliberately and neither says —
      // so it is written down in docs/longterm/LT-PPE-DOORS-UNTESTED.md as a question for the owner,
      // not asserted as a rule here. What IS asserted is the invariant above, which holds either way.
      if (s.incomparable === s.scenarios) {
        console.log('  note  every scenario in this battery was INCOMPARABLE — see the open question in docs/longterm/LT-PPE-DOORS-UNTESTED.md');
      }

      const board = await call('GET', `/api/lt/ppe/scoreboard?investor=${encodeURIComponent(`${stamp}-run`)}&program=${encodeURIComponent(version.id)}`, tok);
      ok(board.status === 200 && board.json.runs === 1,
        `B1 the scoreboard reads that very run back — the canary's write key and the scoreboard's read key are one definition (runs=${board.json && board.json.runs})`);
      ok(board.json.measured === (board.json.scoreboard.canaryAgreementRate != null),
        `B2 …and "measured" means exactly "an agreement rate was recorded" — never a rate that was not (${board.json.measured} / ${board.json.scoreboard.canaryAgreementRate})`);
    }

    // ── 2) settling a finding — the success path ───────────────────────────
    console.log('\n2) POST /findings/:key/decide — a human settles one');
    {
      const key = `${stamp}-finding`;
      await findingStore.persistRun(SCOPE, [{
        key,
        investor: `${stamp}-settle`,
        program: 'P',
        scenario: 'fico=700',
        scenarioFacts: { fico: 700 },
        kind: 'price_mismatch',
        diff: { kind: 'price_mismatch', ourPriceMilli: 102625, theirPriceMilli: 90000 },
        ourPayload: null,
        theirPayload: null,
        status: 'open',
        firstSeenMs: Date.now(),
        lastSeenMs: Date.now(),
        recurrence: 1,
        regressed: false,
      }], { db: ltDb, nowMs: Date.now() });

      const decided = await call('POST', `/api/lt/ppe/findings/${encodeURIComponent(key)}/decide`, tok,
        { status: 'fixed', reason: 'repriced the sheet against their grid' });
      ok(decided.status === 200, `C1 an admin settles a real finding (${decided.status}: ${JSON.stringify(decided.json).slice(0, 160)})`);
      ok(decided.json && decided.json.finding && decided.json.finding.status === 'fixed',
        'C2 …and the answer carries the SETTLED record back, not just an ok');
      const row = (await ltDb.query('SELECT * FROM lt_ppe_finding WHERE scope = $1 AND finding_key = $2', [SCOPE, key])).rows[0];
      ok(row && row.status === 'fixed', 'C3 …durably (the row, not the response, is the record)');
      ok(row && /repriced the sheet/.test(row.decision_reason || ''),
        'C4 …carrying the REASON, which is the only lasting record of why a finding nobody re-opens was closed');
      ok(row && row.decided_by === made.staff[0], 'C5 …attributed to the person who decided it, never to nobody');
    }

    // ── 3) accepting and dismissing a suggestion ───────────────────────────
    console.log('\n3) the rule loop — accept, refuse to guess, dismiss');
    {
      const missing = await call('POST', '/api/lt/ppe/suggestions/999999999/accept', tok, {});
      ok(missing.status === 404, `D1 accepting a suggestion that does not exist is a 404 (${missing.status})`);

      const humanId = await addSuggestion({
        label: investorName, code: `needs_human_${stamp}`, predicate: null, needsHuman: true,
        reason: 'Something Lender Price said that we could not map',
      });
      const human = await call('POST', `/api/lt/ppe/suggestions/${humanId}/accept`, tok, {});
      ok(human.status === 409 && human.json && human.json.error === 'needs_human_mapping',
        `D2 an unmappable decline reason is REFUSED 409 rather than turned into a guessed rule (${human.status} ${human.json && human.json.error})`);
      ok(/never guessed/.test((human.json && human.json.message) || ''),
        'D3 …and the refusal says a human must map it first');

      const goodId = await addSuggestion({
        label: investorName, code: `min_fico_${stamp}`.slice(0, 60),
        predicate: { fact: 'fico', op: 'lt', value: 660 },
        reason: 'FICO - below 660',
      });
      const accepted = await call('POST', `/api/lt/ppe/suggestions/${goodId}/accept`, tok, { note: 'matches their sheet' });
      ok(accepted.status === 200 && accepted.json && accepted.json.ruleId,
        `D4 a mappable one is accepted and writes a rule (${accepted.status}: ${JSON.stringify(accepted.json).slice(0, 140)})`);
      made.rules.push(accepted.json.ruleId);
      ok(accepted.json.investorId === made.investor,
        `D5 …SCOPED to the suggestion's own investor, resolved from its verbatim label through the alias table (${accepted.json.investorId} vs ${made.investor})`);
      const rule = (await ltDb.query('SELECT * FROM lt_ppe_rule WHERE id = $1', [accepted.json.ruleId])).rows[0];
      ok(rule && rule.investor_id === made.investor && rule.origin === 'suggested',
        'D6 …and the stored rule carries that investor and says where it came from');
      ok(rule && rule.lp_decline_reason === 'FICO - below 660',
        'D7 …carrying Lender Price\'s own wording verbatim, so the rule can be read back to their sheet');

      const again = await call('POST', `/api/lt/ppe/suggestions/${goodId}/accept`, tok, {});
      ok(again.status === 409, `D8 accepting the same suggestion twice is refused (${again.status}) — a decision is not repeatable`);

      const dropId = await addSuggestion({
        label: investorName, code: `drop_${stamp}`.slice(0, 60),
        predicate: { fact: 'ltv', op: 'gt', value: 80000 }, reason: 'LTV - above 80',
      });
      const dismissed = await call('POST', `/api/lt/ppe/suggestions/${dropId}/dismiss`, tok, { note: 'we already price this band' });
      ok(dismissed.status === 200 && dismissed.json && dismissed.json.ok === true, `D9 an open suggestion can be dismissed (${dismissed.status})`);
      const dropRow = (await ltDb.query('SELECT status, decision_note FROM lt_ppe_rule_suggestion WHERE id = $1', [dropId])).rows[0];
      ok(dropRow && dropRow.status === 'dismissed' && /already price this band/.test(dropRow.decision_note || ''),
        'D10 …recorded as dismissed WITH the note, kept for the record rather than deleted');
      const dismissAgain = await call('POST', `/api/lt/ppe/suggestions/${dropId}/dismiss`, tok, {});
      ok(dismissAgain.status === 409, `D11 …and dismissing it again is refused (${dismissAgain.status})`);

      const listed = await call('GET', `/api/lt/ppe/suggestions?status=all&investor=${encodeURIComponent(investorName)}`, tok);
      ok(listed.status === 200 && listed.json.total === 3,
        `D12 all three suggestions are listed back for this investor (${listed.json && listed.json.total})`);
    }

    // ── 4) mining while Lender Price is still computing ────────────────────
    console.log('\n4) POST /suggestions/mine — Lender Price computes disqualifications asynchronously');
    {
      lp.polls = [];
      lp.pollResult = { ready: false };
      const pending = await call('POST', '/api/lt/ppe/suggestions/mine', tok, { searchKey: 'sk-not-ready' });
      ok(pending.status === 202 && pending.json && pending.json.status === 'computing',
        `E1 a searchKey whose result is not ready answers 202 "computing", never an empty success (${pending.status} ${pending.json && pending.json.status})`);
      ok(lp.polls.length === 1 && lp.polls[0] === 'sk-not-ready',
        'E2 …after actually polling the upstream for that key');
      const before = (await ltDb.query('SELECT count(*)::int AS c FROM lt_ppe_rule_suggestion WHERE scope = $1 AND investor_label = $2', [SCOPE, investorName])).rows[0].c;
      ok(before === 3, `E3 …and nothing was mined into the suggestion table from a result that never arrived (${before})`);
    }

    // ── 5) three handlers nothing had ever invoked ─────────────────────────
    console.log('\n5) the three doors no suite had reached at all');
    {
      const cov = await call('GET', `/api/lt/ppe/rules/coverage?investorId=${made.investor}`, tok);
      ok(cov.status === 200 && cov.json && cov.json.ok === true && cov.json.investorId === made.investor,
        `F1 GET /rules/coverage answers for the set a program actually evaluates (${cov.status})`);

      const cells = await call('GET', `/api/lt/ppe/parity-cells?investor=${encodeURIComponent(`${stamp}-nobody`)}`, tok);
      ok(cells.status === 200 && cells.json && cells.json.measurements === 0 && typeof cells.json.note === 'string',
        `F2 GET /parity-cells reads an empty window as EMPTY and says so in words, never as a zero score (${cells.status})`);
      ok(cells.json.windowDays === 30, 'F3 …over its default window');

      const gone = await call('DELETE', `/api/lt/ppe/canary/schedules/${encodeURIComponent(`${stamp}-none`)}`, tok);
      ok(gone.status === 200 && gone.json && gone.json.removed === false,
        `F4 DELETE /canary/schedules/:investor on a cadence nobody saved removes nothing and SAYS so (${gone.status} removed=${gone.json && gone.json.removed})`);

      const saved = await call('POST', '/api/lt/ppe/canary/schedules', tok, {
        investor: `${stamp}-sched`, rateSheetVersionId: version.id, intervalMs: 24 * 60 * 60 * 1000,
        enabled: true, scenarios: [{ fico: 760, ltv: 70000, dscr: 1100, loan_amount: 400000, lock_days: 30 }],
      });
      ok(saved.status === 200, `F5 a cadence can be saved (${saved.status}: ${JSON.stringify(saved.json).slice(0, 140)})`);
      const removed = await call('DELETE', `/api/lt/ppe/canary/schedules/${encodeURIComponent(`${stamp}-sched`)}`, tok);
      ok(removed.status === 200 && removed.json.removed === true, `F6 …and removed again, saying it took one out (${removed.json && removed.json.removed})`);
      const left = (await ltDb.query('SELECT count(*)::int AS c FROM lt_ppe_canary_schedule WHERE scope = $1 AND investor = $2', [SCOPE, `${stamp}-sched`])).rows[0].c;
      ok(left === 0, 'F7 …and the row is really gone from the table');
    }
  } finally {
    for (const inv of [`${stamp}-big`, `${stamp}-empty`, `${stamp}-run`, `${stamp}-settle`, `${stamp}-sched`, `${stamp}-none`]) {
      try { await ltDb.query('DELETE FROM lt_ppe_finding WHERE scope = $1 AND investor = $2', [SCOPE, inv]); } catch (_) {}
      try { await ltDb.query('DELETE FROM lt_ppe_shadow_run WHERE scope = $1 AND investor = $2', [SCOPE, inv]); } catch (_) {}
      try { await ltDb.query('DELETE FROM lt_ppe_parity_cell WHERE scope = $1 AND investor = $2', [SCOPE, inv]); } catch (_) {}
      try { await ltDb.query('DELETE FROM lt_ppe_canary_schedule WHERE scope = $1 AND investor = $2', [SCOPE, inv]); } catch (_) {}
    }
    if (made.suggestions.length) { try { await ltDb.query('DELETE FROM lt_ppe_rule_suggestion WHERE id = ANY($1::bigint[])', [made.suggestions]); } catch (_) {} }
    // `lt_ppe_rule.id` is a BIGINT, and the cast has to say so. It said `::uuid[]` once: the cast threw,
    // the `catch` swallowed it, and the accepted rule was left behind in the shared `company` scope —
    // where, as a HOUSE rule (investor_id NULL), it reaches EVERY program and broke three unrelated
    // suites on the next full run. A cleanup that cannot fail loudly has to be right.
    if (made.rules.length) { try { await ltDb.query('DELETE FROM lt_ppe_rule WHERE id = ANY($1::bigint[])', [made.rules]); } catch (e) { console.log(`  !!  rule cleanup failed: ${e.message}`); } }
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

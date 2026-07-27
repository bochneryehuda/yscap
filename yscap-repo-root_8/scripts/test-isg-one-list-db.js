'use strict';
/*
 * The 4th note-buyer guideline surface, against a REAL database.
 *
 * WHY THIS EXISTS. The pure suite proves the merge algebra, but two things it can never
 * touch are exactly where this repo has been bitten before:
 *
 *   1. `loadRunGuidelineFindings` names seven columns across two tables inside a swallowing
 *      try/catch. Every one of them is UNVERIFIED until something executes the query — the
 *      same class as `b.full_name` (#248) and `is_current`/`created_at` on `appraisals`,
 *      both of which sat dark for weeks behind a catch that returned an empty result.
 *   2. #816's durable decision ledger is a real table. The pure test asserts the KEY logic;
 *      this asserts that a decision written through `record()` actually comes back out of
 *      `suppressedKeys()` under BOTH key forms — which is what stops a dismissal the owner
 *      already made from silently coming undone the moment a producer declares a fact.
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Runs in a
 * transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-isg-one-list-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const uw = require('../src/routes/underwriting');
const aiSug = require('../src/lib/underwriting/ai-suggestions');
const deskFindings = require('../src/lib/underwriting/investor-guidelines/desk-findings');
const fdec = require('../src/lib/underwriting/finding-decisions');
const { claimOf } = require('../src/lib/underwriting/finding-claims');
const investorReview = require('../src/lib/underwriting/investor-guideline-review');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed += 1; };

console.log('ISG one list (DB)');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const email = 'isgone+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('Isg','One',$1,'1984-02-02') RETURNING id`, [email])).rows[0];
    const app = (await client.query(
      `INSERT INTO applications (borrower_id, property_address, lender)
         VALUES ($1, '{"state":"NY","city":"Brooklyn"}'::jsonb, 'Blue Lake') RETURNING id`,
      [b.id])).rows[0];

    // A `db`-shaped shim so the route helper runs on THIS transaction and rolls back with it.
    const db = { query: (t, p) => client.query(t, p) };

    // ── 1. the query executes at all ────────────────────────────────────────
    // A phantom column would throw, the catch would swallow it, and this would be [] —
    // indistinguishable from "no run yet". So the no-run case is asserted FIRST, then a
    // real run is inserted and the SAME call must return rows. Only the pair proves the
    // query ran: an always-throwing query passes step one and fails step two.
    assert.deepStrictEqual(await uw._loadRunGuidelineFindings(db, app.id), [],
      'a file with no run has no run findings');
    ok('no run on the file → no findings (and no throw)');

    const run = (await client.query(
      `INSERT INTO underwriting_runs (application_id, trigger, status)
         VALUES ($1,'manual_run','ELIGIBLE') RETURNING id`, [app.id])).rows[0];
    const addFinding = (runId, f) => client.query(
      `INSERT INTO underwriting_run_findings
         (run_id, code, severity, category, title, explanation, governing_rule, expected_value, actual_value, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [runId, f.code, f.severity, f.category, f.title, f.explanation || null,
       f.governing_rule || null, f.expected_value || null, f.actual_value || null, f.source || null]);

    await addFinding(run.id, {
      code: 'isg_rural_property', severity: 'fatal', category: investorReview.CATEGORY,
      title: 'Rural property', explanation: 'Every note buyer escalates a rural property.',
      governing_rule: 'all buyers', actual_value: 'Rural',
    });
    await addFinding(run.id, {
      code: 'isg_bl_ny_loan', severity: 'fatal', category: investorReview.CATEGORY,
      title: 'New York loan', explanation: 'Blue Lake escalates a New York loan.',
    });
    // A finding from a DIFFERENT desk in the same run must NOT be folded in — it already
    // has its own home, and folding it would double-report it.
    await addFinding(run.id, {
      code: 'structure_ltc_over_cap', severity: 'warning', category: 'structure', title: 'LTC over cap',
    });

    const rows = await uw._loadRunGuidelineFindings(db, app.id);
    assert.strictEqual(rows.length, 2,
      `every column the query names must exist — got ${rows.length} of 2 (an empty result here means the query threw and the catch ate it)`);
    ok('the run-findings query really executes — every column exists');

    assert.ok(rows.every((r) => r.category === investorReview.CATEGORY),
      'only note-buyer guideline findings are folded in');
    ok('a finding from another desk in the same run is left alone');

    // ── 2. the fold produces the shape the desk and the ledger both expect ──
    const rural = rows.find((r) => r.code === 'isg_rural_property');
    assert.strictEqual(rural.factKey, 'isg_signal:appraisal_rural',
      'the run must declare the FACT so it merges with the desk rows about the same signal');
    assert.strictEqual(rural.severity, 'fatal');
    assert.strictEqual(rural.blocksCtc, false, 'ADVISORY — a guideline finding never gates clear-to-close');
    assert.strictEqual(rural.id, undefined, 'no stored row ⇒ fileFatalCount cannot see it');
    ok('the rural finding carries its fact key, its severity, and the advisory guarantees');

    // The whitelist, proven: an `info` run finding must stay `info`, not be promoted to a
    // warning chip. No rule emits `info` today, so this guard is forward-looking — and the
    // post-merge audit found it was the one claim the suite could not catch.
    await addFinding(run.id, {
      code: 'isg_info_probe', severity: 'info', category: investorReview.CATEGORY, title: 'Note' });
    const withInfo = await uw._loadRunGuidelineFindings(db, app.id);
    const probe = withInfo.find((r) => r.code === 'isg_info_probe');
    assert.strictEqual(probe && probe.severity, 'info',
      'an info run finding must not be promoted to a warning');
    assert.strictEqual(withInfo.find((r) => r.code === 'isg_rural_property').severity, 'fatal');
    await client.query(`DELETE FROM underwriting_run_findings WHERE code = 'isg_info_probe'`);

    const ny = rows.find((r) => r.code === 'isg_bl_ny_loan');
    assert.strictEqual(ny.factKey, undefined,
      'a rule with no shared signal declares no fact — it must never merge with an unrelated one');
    ok('a rule with no shared signal is left unkeyed');

    // ── 3. `isgOnly` keeps these OUT of the clear-to-close summary ──────────
    // This predicate is what stops the advisory desk disagreeing with the real CTC gate.
    // It was keyed on the wrong field in the first cut and folded findings escaped into
    // summary.fatal — where the gate can't see them, so the two disagreed silently.
    assert.ok(rows.every((r) => uw._isgOnly(r)), 'every folded run finding is guideline-only');
    assert.ok(!uw._isgOnly({ code: 'bank_account_not_borrower', severity: 'fatal' }),
      'a real dealbreaker must NOT be classified as guideline-only');
    ok('isgOnly keeps guideline findings out of the summary and lets real findings through');

    // ── 4. a superseded run does not speak ──────────────────────────────────
    await client.query(`UPDATE underwriting_runs SET superseded_at = now() WHERE id = $1`, [run.id]);
    assert.deepStrictEqual(await uw._loadRunGuidelineFindings(db, app.id), [],
      'only the CURRENT run governs');
    ok('a superseded run contributes nothing');

    // ── 5. THE LEDGER KEYS PER PRODUCER, at that producer's own code ───────
    // Two things, deliberately separated. The DISPLAY merges on the declared fact — three
    // producers noticing one thing is one card. A DECISION does NOT: a fact key carries
    // neither severity nor note buyer, so sharing one across producers meant
    //   · a dismissal made while an item was a WARNING silenced the same rule after the
    //     deal converted and it became a DEALBREAKER (desk-sync promises the opposite);
    //   · "the transfer letter arrived" settled Blue Lake's transferred-appraisal DECLINE,
    //     which no letter can fix — the same signal means opposite things per buyer;
    //   · a dismissal became a one-way door that re-open could not undo.
    // So the ledger ignores factKey — which is also exactly how every row already on file
    // was written, so nothing a human decided before this shipped stops working.
    const before = { code: 'isg_appraisal_review_3345', field: 'rural' };
    const today = Object.assign({}, before, { factKey: 'isg_signal:appraisal_rural' });
    assert.strictEqual(fdec.keyOf(today), fdec.keyOf(before),
      'declaring a fact must not change the key a decision was recorded under');

    await fdec.record(client, {
      applicationId: app.id, finding: before, origin: 'ai_suggestion',
      decision: 'dismissed', note: 'not a concern on this file',
    });
    const written = (await client.query(
      `SELECT finding_key FROM finding_decisions WHERE application_id=$1 ORDER BY 1`, [app.id])).rows
      .map((r) => r.finding_key);
    assert.deepStrictEqual(written, ['code:isg_appraisal_review_3345::rural::::'],
      'recorded under the FINDING decided, never the shared fact');

    let keys = await fdec.suppressedKeys(client, app.id);
    assert.ok(fdec.isSuppressed(keys, today),
      'a decision made before the producer declared a fact must keep suppressing');
    assert.ok(!fdec.isSuppressed(keys, { code: 'isg_rural_property', severity: 'fatal', factKey: 'isg_signal:appraisal_rural' }),
      "the run's DEALBREAKER about the same fact must NOT be settled by a decision on a warning");
    assert.ok(!fdec.isSuppressed(keys, { code: 'isg_bl_transferred_appraisal', factKey: 'isg_signal:appraisal_rural' }),
      'nor another buyer\'s rule, which may mean the opposite thing');
    ok('a decision settles the finding it was made about — and only that one');

    await fdec.reopen(client, { applicationId: app.id, finding: today, by: null });
    keys = await fdec.suppressedKeys(client, app.id);
    assert.ok(!fdec.isSuppressed(keys, today), 'a re-opened finding comes back');
    assert.ok(!fdec.isSuppressed(keys, before), 'under either shape');
    ok('a dismissal is never a one-way door');


    // ── 6. THE REAL DISMISS DOOR, not a hand-built shape ───────────────────
    // THE BLIND SPOT THAT LET THE FIRST FIX SHIP BROKEN. Everything above builds the
    // finding shape by hand and calls `record()` directly. Production does neither: a
    // staffer clicks Dismiss, which goes through `ai-suggestions.decide()`, which rebuilds
    // the shape from the STORED row. That rebuild was gated on a non-null `evidence.code`
    // — and every desk row with a `concern_field` (the only rows that HAVE a fact to
    // declare) has a null template code, structurally: `desk.js` routes any row WITH a
    // template code to the `document` disposition, and only the other dispositions carry a
    // concern field. So the ledger was never written for exactly the findings the fact key
    // exists for, and every assertion above passed anyway.
    //
    // This drives the REAL rural spec rows through the REAL producer and the REAL decide
    // door, and asserts on what actually lands in the database.
    const { deskToSuggestions } = require('../src/lib/underwriting/investor-guidelines/desk-sync');
    const { deskToFindings } = deskFindings;
    const app2 = (await client.query(
      `INSERT INTO applications (borrower_id, property_address, lender)
         VALUES ($1, '{"state":"NY"}'::jsonb, 'Blue Lake') RETURNING id`, [b.id])).rows[0];
    const deskFixture = {
      noteBuyer: { name: 'Blue Lake' }, verdicts: [{ cond_no: 1 }],
      unhappy: [
        { cond_no: 123, flag: 'appraisal_review', severity: 'warning', name: 'RURAL PROPERTY INELIGIBLE',
          domain: 'property', concern_field: 'appraisal_rural', pilot_template_code: null },
        { cond_no: 3345, flag: 'appraisal_review', severity: 'warning', name: 'RURAL PROPERTY VERIFICATION',
          domain: 'rural', concern_field: 'appraisal_rural', pilot_template_code: null },
      ],
    };
    const payloads = deskToSuggestions(deskFixture);
    assert.strictEqual(payloads.length, 2, 'the real desk must emit both rural rows');
    assert.ok(payloads.every((p) => !p.evidence.code),
      'fixture must reproduce the real shape: a concern-carrying row has NO template code');
    const sugIds = [];
    for (const p of payloads) sugIds.push((await aiSug.record(client, { ...p, applicationId: app2.id })).id);
    assert.strictEqual(sugIds.filter(Boolean).length, 2);
    ok('the real desk rows persist — and really do carry no template code');

    // The merged card carries ONE inherited handle. Dismissing it records the decision
    // under THAT finding's own code — not the shared fact (see section 5 for why).
    await aiSug.decide(client, sugIds[0], { action: 'dismiss', reason: 'not a concern', staffId: null });
    const doorKeys = (await client.query(
      `SELECT finding_key FROM finding_decisions WHERE application_id=$1 ORDER BY 1`, [app2.id])).rows
      .map((r) => r.finding_key);
    assert.deepStrictEqual(doorKeys, ['code:isg_appraisal_review_123::property::::'],
      `the REAL door must write the finding's own key — got ${JSON.stringify(doorKeys)}`);
    const set2 = await fdec.suppressedKeys(client, app2.id);
    assert.ok(fdec.isSuppressed(set2, deskToFindings(deskFixture)[0]),
      'the finding the human actually dismissed is settled');
    assert.ok(!fdec.isSuppressed(set2, { code: 'isg_rural_property', severity: 'fatal', factKey: 'isg_signal:appraisal_rural' }),
      "the run's dealbreaker is NOT settled by a decision made on a warning");
    ok('a Dismiss through the REAL door records the finding it was made about');

    // …and the AI panel keys its mirror rows on the same CLAIM the Open-findings list
    // deduped on, so a sibling whose card merged away is recognised as already shown
    // rather than rendering a second card for the same fact.
    const listed = await aiSug.listForFile(app2.id, { includeDismissed: true }, client);
    assert.ok(listed.length >= 2, 'both mirrors are on file');
    assert.ok(listed.every((r) => r.claim_key === 'claim:isg_signal:appraisal_rural'),
      `every rural mirror must carry the shown claim key — got ${JSON.stringify(listed.map((r) => r.claim_key))}`);
    ok('the AI panel keys its mirror rows on the same claim, so it hides the duplicate');

    // ── 9. THE FOLD FILTER keeps a run finding that MERGED with a desk row ──
    // A desk finding carries no handle either until its ai_suggestions mirror exists, and
    // that sync runs after the response. Dropping a handle-less survivor unconditionally
    // would swallow the DESK's finding on the view where the two first meet.
    const foldFilter = uw._foldFilter;
    const runOnly = { source: investorReview.SOURCE, code: 'isg_bl_ny_loan', severity: 'fatal' };
    const merged = { source: investorReview.SOURCE, code: 'isg_rural_property', severity: 'fatal',
      mergedFrom: ['isg_appraisal_review_3345'] };
    // Two handle-less RUN rules merging into each other is NOT a reason to list one: neither
    // has buttons and neither would have been here without the fold.
    const runPair = { source: investorReview.SOURCE, code: 'isg_bl_transferred_appraisal',
      severity: 'fatal', mergedFrom: ['isg_transferred_appraisal_letter'] };
    const actionable = { source: investorReview.SOURCE, code: 'isg_rural_property', suggestionId: 'sug-1' };
    assert.strictEqual(foldFilter(runOnly), false,
      'a run finding that merged with nothing has no buttons — it stays in the run cockpit');
    assert.strictEqual(foldFilter(merged), true,
      'one that merged with a desk row must stay: the desk finding was going to show anyway');
    assert.strictEqual(foldFilter(runPair), false,
      'but two handle-less RUN rules merging into each other must NOT produce a button-less card');
    assert.strictEqual(foldFilter(actionable), true, 'and one that inherited a handle is fully actionable');
    assert.strictEqual(foldFilter({ code: 'bank_account_not_borrower' }), true,
      'nothing outside the run fold is ever filtered');
    // The desk-partner test asks the RUN's rule table, so a new desk flag can never make a
    // merged finding vanish. Every real desk code shape must read as "not from the run".
    for (const deskCode of ['isg_gap_rtl_cond_title', 'isg_conflict_44', 'isg_concern_3333',
      'isg_info_missing_1009', 'isg_appraisal_review_3345', 'isg_newflag_9999']) {
      assert.strictEqual(investorReview.isRuleCode(deskCode), false, `${deskCode} is not a run rule`);
      assert.strictEqual(foldFilter({ source: investorReview.SOURCE, code: 'isg_rural_property',
        mergedFrom: [deskCode] }), true, `${deskCode} must count as a desk partner`);
    }
    assert.strictEqual(investorReview.isRuleCode('isg_rural_property'), true,
      'and a real run code still reads as the run\'s own');
    ok('the fold filter holds back only a row that exists purely because of the fold');

    // ── 10. A SHARED CONDITION TEMPLATE MUST NOT MERGE TWO DIFFERENT FACTS ──
    // `evidence.code` on a desk row is the PILOT CONDITION TEMPLATE the guideline maps to
    // — a different namespace from the finding's own code, and SHARED. Blue Lake cond 44
    // carries BOTH a `concern_field` and `pilot_template_code:'rtl_cond_fraud'` (desk.js's
    // explicit-disposition branch runs before the template-code branch, so a row can have
    // both). Keying off it made dismissing the non-arm's-length CONCERN suppress the
    // unrelated BACKGROUND-CHECK / OFAC coverage gap — a finding nobody decided about,
    // refused a row by record() yet still rendered, with no buttons.
    const app5 = (await client.query(
      `INSERT INTO applications (borrower_id, property_address, lender)
         VALUES ($1, '{}'::jsonb, 'Blue Lake') RETURNING id`, [b.id])).rows[0];
    const sharedTemplate = deskToSuggestions({
      noteBuyer: { name: 'Blue Lake' }, verdicts: [{ cond_no: 1 }],
      unhappy: [
        { cond_no: 44, flag: 'concern', severity: 'warning', name: 'NON ARMS LENGTH',
          domain: 'non_arms_length', concern_field: 'non_arms_length_concern',
          pilot_template_code: 'rtl_cond_fraud' },
        { cond_no: 2005, flag: 'coverage_gap', severity: 'warning', name: 'BACKGROUND REPORT',
          domain: 'background', pilot_template_code: 'rtl_cond_fraud' },
      ],
    });
    assert.strictEqual(sharedTemplate.length, 2);
    // THE INVARIANT, asserted directly: the shape the ledger keys on must use the SAME code
    // the finding producer emits — not the template both rows happen to share.
    const findingsFor = deskToFindings({
      noteBuyer: { name: 'Blue Lake' }, verdicts: [{ cond_no: 1 }],
      unhappy: [
        { cond_no: 44, flag: 'concern', severity: 'warning', name: 'NON ARMS LENGTH',
          domain: 'non_arms_length', concern_field: 'non_arms_length_concern',
          pilot_template_code: 'rtl_cond_fraud' },
        { cond_no: 2005, flag: 'coverage_gap', severity: 'warning', name: 'BACKGROUND REPORT',
          domain: 'background', pilot_template_code: 'rtl_cond_fraud' },
      ],
    });
    for (let i = 0; i < 2; i += 1) {
      const shaped = aiSug._internals.claimShapeOf({
        ...sharedTemplate[i], source: 'investor_guideline_desk',
        dedupe_key: sharedTemplate[i].dedupeKey, proposed_action: sharedTemplate[i].proposedAction,
      });
      assert.strictEqual(shaped.code, findingsFor[i].code,
        `the row's key code must equal the FINDING's code (${findingsFor[i].code}), not the shared template`);
    }
    assert.notStrictEqual(
      aiSug._internals.claimShapeOf({ ...sharedTemplate[0], source: 'investor_guideline_desk', dedupe_key: sharedTemplate[0].dedupeKey }).code,
      aiSug._internals.claimShapeOf({ ...sharedTemplate[1], source: 'investor_guideline_desk', dedupe_key: sharedTemplate[1].dedupeKey }).code,
      'two rows sharing a condition template must NOT collapse onto one key');
    ok('a shared PILOT condition template never becomes a shared finding key');

    const stIds = [];
    for (const p of sharedTemplate) stIds.push((await aiSug.record(client, { ...p, applicationId: app5.id })).id);
    await aiSug.decide(client, stIds[0], { action: 'dismiss', reason: 'verified', staffId: null });
    const gapKeys = await fdec.suppressedKeys(client, app5.id);
    assert.ok(!fdec.isSuppressed(gapKeys, findingsFor[1]),
      'dismissing the non-arms-length CONCERN must not settle the background-check coverage gap');
    const reGap = await aiSug.record(client, { ...sharedTemplate[1], applicationId: app5.id });
    assert.ok(!reGap.settled,
      'and the gap must still be able to raise a row — refusing it leaves a card with no buttons');
    ok('dismissing one guideline never silently settles another that shares its template');

    // ── 12. A DECISION ON A WARNING DOES NOT SILENCE A LATER FATAL ─────────
    // THE FALSE CLEAR THE POST-MERGE AUDIT CAUGHT. `desk-sync` has a guard whose entire
    // purpose is this rule, and it works — but `record()`'s ledger consult ran first and
    // suppressed the row anyway, because the ledger never recorded the severity a human
    // judged. It was latent until a concern-carrying row (structurally NULL evidence.code)
    // started reaching the ledger at all. Live scenario: a Blue Lake light-rehab file whose
    // feasibility notice was dismissed as a warning converts to ground-up, the desk
    // correctly re-raises it as a DEALBREAKER — and nothing is written. No card, no email,
    // and the sync's own telemetry reports it as raised.
    const app6 = (await client.query(
      `INSERT INTO applications (borrower_id, property_address, lender)
         VALUES ($1, '{}'::jsonb, 'Blue Lake') RETURNING id`, [b.id])).rows[0];
    // Build the judged finding from the REAL payload shape, so the key the ledger writes is
    // the key the live finding is read under — a hand-built fixture that differs by one field
    // would pass while production missed.
    const feasPayload = {
      applicationId: app6.id, source: 'investor_guideline_desk', kind: 'finding',
      title: 'Construction feasibility report', body: 'x', severity: 'warning',
      evidence: { code: null, cond_no: 2193, flag: 'concern', domain: 'construction_feasibility',
        concern_field: 'construction_feasibility' },
      dedupeKey: 'isg-concern:2193',
    };
    const mild = Object.assign(
      aiSug._internals.claimShapeOf({
        evidence: feasPayload.evidence, source: feasPayload.source, dedupe_key: feasPayload.dedupeKey }),
      { severity: 'warning' });
    await fdec.record(client, {
      applicationId: app6.id, finding: mild, origin: 'ai_suggestion', decision: 'dismissed',
      severity: 'warning',
    });
    const sevSet = await fdec.suppressedKeys(client, app6.id);
    assert.ok(fdec.isSuppressed(sevSet, mild), 'the warning the human judged stays settled');
    assert.ok(!fdec.isSuppressed(sevSet, Object.assign({}, mild, { severity: 'fatal' })),
      'the SAME rule at FATAL must break through — silencing a dealbreaker with a judgement '
      + 'made about something milder is a false clear');
    assert.ok(fdec.isSuppressed(sevSet, Object.assign({}, mild, { severity: 'info' })),
      'and something MILDER than what was judged stays settled');
    ok('a decision on a warning does not silence the same rule at fatal');

    // …and it holds through the REAL door: the desk re-raising at fatal must write a row.
    const asWarning = await aiSug.record(client, feasPayload);
    assert.ok(asWarning.settled, 'the dismissed warning is still refused a row');
    const asFatal = await aiSug.record(client,
      Object.assign({}, feasPayload, { severity: 'fatal', important: true }));
    assert.ok(!asFatal.settled && asFatal.id,
      'but the dealbreaker gets its row — this is the one that reaches the team');
    ok('the dealbreaker really is written through the real record() door');

    // A decision taken BEFORE db/336 carries no severity and must keep suppressing, or the
    // deploy would resurrect every dismissed fatal already on file.
    await client.query(
      `UPDATE finding_decisions SET severity = NULL WHERE application_id = $1`, [app6.id]);
    const legacy = await fdec.suppressedKeys(client, app6.id);
    assert.ok(fdec.isSuppressed(legacy, Object.assign({}, mild, { severity: 'fatal' })),
      'a pre-db/336 decision suppresses regardless — no mass resurrection on deploy');
    ok('decisions taken before this shipped are untouched');

    // ── 13. EVERY LEDGER WRITER RECORDS THE SEVERITY, AND EVERY READER USES IT ──
    // THE GAP THE PRE-MERGE AUDIT FOUND. An omitted severity writes NULL, and NULL means
    // "suppress regardless" — the pre-fix behaviour, with no error, no log and no test
    // signal. So each writer is asserted by reading the column BACK out of the database,
    // and each reader by the shape it actually hands `isSuppressed`.
    const app7 = (await client.query(
      `INSERT INTO applications (borrower_id, property_address) VALUES ($1,'{}'::jsonb) RETURNING id`,
      [b.id])).rows[0];
    const storedSev = async (appId) => (await client.query(
      `SELECT severity FROM finding_decisions WHERE application_id=$1 ORDER BY decided_at DESC LIMIT 1`,
      [appId])).rows[0].severity;
    // ...and a per-CODE variant. Several writers are exercised on the same file within the same
    // transaction, so `now()` is IDENTICAL for all of them and "the latest decision" is a
    // coin toss. Keying on the code each writer wrote is the only stable read.
    const storedSevFor = async (appId, code) => {
      const r = await client.query(
        `SELECT severity FROM finding_decisions WHERE application_id=$1 AND code=$2`, [appId, code]);
      assert.strictEqual(r.rowCount, 1, `exactly one ledger row for ${code}`);
      return r.rows[0].severity;
    };

    // writer: ai-suggestions.decide()
    const sug = await aiSug.record(client, {
      applicationId: app7.id, source: 'investor_guideline_desk', kind: 'finding', severity: 'warning',
      title: 'w', body: 'x', evidence: { code: null, cond_no: 77, flag: 'concern', domain: 'd' },
      dedupeKey: 'isg-concern:77',
    });
    await aiSug.decide(client, sug.id, { action: 'dismiss', reason: 'x', staffId: null });
    assert.strictEqual(await storedSev(app7.id), 'warning',
      'the AI-card door must record the severity the human was looking at');

    const store = require('../src/lib/underwriting/store');
    // writer: store.resolveFinding — the highest-traffic writer of the five (the desk, the
    // per-finding resolve route AND the escalation queue's live branch all go through it).
    // Asserted by reading the column BACK OUT, because an omitted severity writes NULL and
    // NULL suppresses regardless: a silent false clear with no error and no log.
    const docRowW = (await client.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, storage_provider)
       VALUES ($1,$2,'writer.pdf','application/pdf','local') RETURNING id`, [app7.id, b.id])).rows[0];
    const dfRow = (await client.query(
      `INSERT INTO document_findings (application_id, borrower_id, document_id, source, code, severity, field, doc_value, title, status)
       VALUES ($1,$2,$3,'appraisal','writer_probe','fatal','as_is_value','1','t','open') RETURNING id`,
      [app7.id, b.id, docRowW.id])).rows[0];
    await store.resolveFinding(client, {
      findingId: dfRow.id, action: 'dismiss', note: 'not applicable on this file', by: null,
    });
    assert.strictEqual(await storedSevFor(app7.id, 'writer_probe'), 'fatal',
      'store.resolveFinding records the severity the human was looking at');

    // writer: the appraisal re-import door (`routes/appraisal.js`). It hands `record()` a row
    // read with `SELECT *`; naming severity explicitly is what stops a future column list from
    // silently writing NULL. Exercised with a REAL appraisal_findings row so the column has to
    // exist and has to survive the round trip.
    const apprRow = (await client.query(
      `INSERT INTO appraisals (application_id, superseded) VALUES ($1,false) RETURNING id`,
      [app7.id])).rows[0];
    const afRow = (await client.query(
      `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, field, appraisal_value, title, status)
       VALUES ($1,$2,'appraisal','appraisal_writer_probe','fatal','arv','2','t','open') RETURNING *`,
      [apprRow.id, app7.id])).rows[0];
    const apprRoute = require('../src/routes/appraisal');
    const apprPayload = apprRoute._ledgerRecordFor({
      appId: app7.id, fnd: afRow, action: 'dismiss', note: null, by: null,
    });
    // Asserted on the PAYLOAD, not only on what lands in the table: `record()` also falls back
    // to `finding.severity`, so a payload that omits it still writes the right value today and
    // the round-trip alone cannot tell the two apart. Naming it here is the belt to that
    // fallback's braces — and this is the assertion that fails if someone removes it.
    assert.strictEqual(apprPayload.severity, 'fatal',
      'the appraisal decision payload names the severity explicitly, not via record()\'s fallback');
    assert.strictEqual(apprRoute._ledgerRecordFor({ appId: app7.id, fnd: {}, action: 'dismiss' }).severity, null,
      'and a row with no severity yields NULL — legacy behaviour, never a guess');
    await fdec.record(client, apprPayload);
    assert.strictEqual(await storedSevFor(app7.id, 'appraisal_writer_probe'), 'fatal',
      'the appraisal resolve door records it too');

    // writer: the escalation doors. TWO halves, because one assertion cannot cover both:
    //   (a) the SHAPE prefers the finding's own severity over the escalation snapshot...
    assert.strictEqual(
      uw._escalationFindingShape({ code: 'c', severity: 'warning', finding_severity: 'fatal' }).severity,
      'fatal', 'the escalation door records the finding row severity, not the snapshot copy');
    assert.strictEqual(uw._escalationFindingShape({ code: 'c', severity: 'warning' }).severity, 'warning',
      'falling back to the snapshot when the finding is derived and has no live row');
    //   ...(b) and the QUERY behind it really yields that alias. The hand-built fixture above
    //   passes no matter what the SELECT returns — which is exactly the class of bug this round
    //   found (`finding_severity` was an alias that existed only in another module's SELECT, so
    //   reading it here was a no-op). This calls the ROUTE'S OWN loader against real rows, so
    //   narrowing that query back fails here.
    const escRow = (await client.query(
      `INSERT INTO finding_escalations (application_id, finding_id, code, severity, status)
       VALUES ($1,$2,'writer_probe','warning','open') RETURNING id`,
      [app7.id, dfRow.id])).rows[0];
    const joined = await uw._loadEscalationRow(escRow.id, client);
    assert.strictEqual(joined.finding_severity, 'fatal',
      'the escalation JOIN really yields the finding row severity (not undefined)');
    assert.strictEqual(uw._escalationFindingShape(joined).severity, 'fatal',
      'and the shape built from a REAL row carries it');

    // readers: the two carry-forward shapes must carry severity, or a decision taken at
    // warning silently makes the re-read's DEALBREAKER born dismissed.
    //
    // ASSERTED BY BEHAVIOUR, NOT BY PATTERN-MATCHING THE SOURCE (re-audit 2026-07-27). These
    // two were regexes over the reader files, which pass for a reader that is never CALLED,
    // and break on a harmless reformat. Both now run the real code against the real ledger.
    const readerKey = { code: 'reader_severity_probe', field: 'as_is_value', docValue: '400000' };
    const docRow = (await client.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, storage_provider)
       VALUES ($1,$2,'probe.pdf','application/pdf','local') RETURNING id`, [app7.id, b.id])).rows[0];
    // Two decisions, because the two readers legitimately key differently: a document finding
    // is scoped to its DOCUMENT (so a re-read of the same file keeps the same key even though
    // the extraction id is new), while an appraisal finding carries neither.
    await fdec.record(client, {
      applicationId: app7.id,
      finding: Object.assign({ severity: 'warning', document_id: docRow.id }, readerKey),
      origin: 'document_finding', action: 'dismiss', severity: 'warning', staffId: null,
    });
    await fdec.record(client, {
      applicationId: app7.id, finding: Object.assign({ severity: 'warning' }, readerKey),
      origin: 'appraisal_finding', action: 'dismiss', severity: 'warning', staffId: null,
    });
    const readerLedger = await fdec.suppressedKeys(client, app7.id);

    // reader 1 — store.saveAnalysis, exercised through the real INSERT. A re-read of the same
    // finding at the SAME severity is born dismissed (the dismissal sticks); the same finding
    // arriving as a DEALBREAKER is born OPEN and reaches the team.
    const bornStatus = async (severity) => {
      const saved = await store.saveAnalysis(client, {
        documentId: docRow.id, applicationId: app7.id, borrowerId: b.id, docType: 'appraisal',
        extraction: { fields: {}, status: 'analyzed' }, suppressNotify: true,
        findings: [{ code: readerKey.code, field: readerKey.field, docValue: readerKey.docValue,
          severity, title: 't', source: 'appraisal' }],
      });
      const id = (saved && saved.findingIds && saved.findingIds[0]) || null;
      assert.ok(id, 'saveAnalysis wrote the finding row the assertion is about');
      return (await client.query(
        `SELECT status, resolution FROM document_findings WHERE id=$1`, [id])).rows[0];
    };
    const sameSev = await bornStatus('warning');
    assert.strictEqual(sameSev.status, 'dismissed',
      'the re-read of a dismissed warning is born dismissed — the decision survives the re-read');
    assert.strictEqual(sameSev.resolution, 'carried_forward', 'and is labelled as carried forward');
    const worseSev = await bornStatus('fatal');
    assert.strictEqual(worseSev.status, 'open',
      'but the SAME finding arriving as a dealbreaker is born OPEN — a warning dismissal is not a false clear');

    // reader 2 — the appraisal re-import, through its own carry-forward function against the
    // same real ledger. (`test-appraisal-import.js` is skipped in CI, so without this the
    // appraisal carry-forward had no behavioural coverage at all.)
    const apprImport = require('../src/lib/appraisal/import');
    const apprFinding = (severity) => ({ code: readerKey.code, field: readerKey.field, severity,
      appraisalValue: 400000 });
    assert.strictEqual(apprImport._internals.carryForward(readerLedger, apprFinding('warning')), true,
      'the appraisal re-import carries a dismissed warning forward');
    assert.strictEqual(apprImport._internals.carryForward(readerLedger, apprFinding('fatal')), false,
      'but never carries it forward onto a dealbreaker');
    assert.strictEqual(apprImport._internals.carryForward(new Map(), apprFinding('warning')), false,
      'an empty ledger carries nothing forward — it fails OPEN');
    ok('every ledger writer records the judged severity, and both readers really honour it');

    // ── 13b. THE SEVENTH DOOR — the AI-panel mirror close ──────────────────────────────
    // `closeMirroredSuggestions` closed EVERY ai_suggestions row sharing the finding's code,
    // regardless of severity. Dismissing a WARNING on the Document Review desk therefore also
    // closed a FATAL mirror of the same code — and that row, now stamped decided_by_staff_id,
    // went on to suppress re-raises through `record()`'s settled-row dedupe. One warning
    // judgement, a silenced dealbreaker, two surfaces away.
    const app8 = (await client.query(
      `INSERT INTO applications (borrower_id, property_address) VALUES ($1,'{}'::jsonb) RETURNING id`,
      [b.id])).rows[0];
    const mkMirror = async (severity) => (await client.query(
      `INSERT INTO ai_suggestions (application_id, source, kind, severity, title, body, status, evidence)
       VALUES ($1,'cross_document','finding',$2,'t','x','open', '{"code":"mirror_probe"}'::jsonb)
       RETURNING id`, [app8.id, severity])).rows[0];
    const mildMirror = await mkMirror('warning');
    const fatalMirror = await mkMirror('fatal');
    const docRow8 = (await client.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, storage_provider)
       VALUES ($1,$2,'m.pdf','application/pdf','local') RETURNING id`, [app8.id, b.id])).rows[0];
    const df8 = (await client.query(
      `INSERT INTO document_findings (application_id, borrower_id, document_id, source, code, severity, title, status)
       VALUES ($1,$2,$3,'cross_document','mirror_probe','warning','t','open') RETURNING id`,
      [app8.id, b.id, docRow8.id])).rows[0];
    await store.resolveFinding(client, {
      findingId: df8.id, action: 'dismiss', note: 'not a concern here', by: null,
    });
    const mirrorStatus = async (id) => (await client.query(
      `SELECT status FROM ai_suggestions WHERE id=$1`, [id])).rows[0].status;
    assert.strictEqual(await mirrorStatus(mildMirror.id), 'dismissed',
      'the mirror at the SAME severity is closed with the finding — that is the point of it');
    assert.strictEqual(await mirrorStatus(fatalMirror.id), 'open',
      'but a DEALBREAKER mirror survives a warning-level dismissal');
    ok('a warning dismissal does not close a dealbreaker on the AI panel');

    // ── 13c. THE SIXTH DOOR — the file view's own settled-mirror filter ─────────────────
    // The file view drops a note-buyer desk finding whenever its ai_suggestions mirror is in
    // any non-open status. That undid all the other doors: the ledger correctly refuses to
    // suppress a fatal, and this filter threw it away anyway. Exercised through the exported
    // predicate so the comparison itself is pinned.
    const settledMirror = { status: 'dismissed', severity: 'warning' };
    assert.strictEqual(uw._isgSettledHides(settledMirror, { severity: 'warning' }), true,
      'the same rule at the same severity stays hidden — the dismissal sticks');
    assert.strictEqual(uw._isgSettledHides(settledMirror, { severity: 'fatal' }), false,
      'but the same rule as a DEALBREAKER is shown again');
    assert.strictEqual(uw._isgSettledHides({ status: 'dismissed', severity: null }, { severity: 'fatal' }), true,
      'a mirror whose own severity is unreadable keeps suppressing — never a mass resurrection');
    assert.strictEqual(uw._isgSettledHides({ status: 'open', severity: 'warning' }, { severity: 'warning' }), false,
      'an OPEN mirror hides nothing — the card is live');
    ok('the file view hides a settled guideline finding only while it is no worse than what was decided');

    // …and the readers really behave: a warning dismissed does not carry forward a fatal.
    const carryKey = { code: 'appraisal_value_variance', field: 'as_is_value', docValue: '450000' };
    await fdec.record(client, {
      applicationId: app7.id, finding: carryKey, origin: 'appraisal_finding',
      decision: 'dismissed', severity: 'warning',
    });
    const carrySet = await fdec.suppressedKeys(client, app7.id);
    assert.ok(fdec.isSuppressed(carrySet, Object.assign({ severity: 'warning' }, carryKey)),
      'the same variance at the judged severity still carries forward as settled');
    assert.ok(!fdec.isSuppressed(carrySet, Object.assign({ severity: 'fatal' }, carryKey)),
      're-priced to a FATAL variance, the re-import must NOT be born dismissed');
    ok('a re-read or re-import cannot carry a warning decision forward onto a dealbreaker');

    await client.query('ROLLBACK');
    console.log(`\n${passed} checks passed.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();

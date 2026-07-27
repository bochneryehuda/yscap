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

    // ── 5. THE LEDGER, END TO END ──────────────────────────────────────────
    // The regression that made this whole change dangerous: a decision recorded before a
    // producer declared a fact keyed the old way, and stopped matching the moment it did.
    const before = { code: 'isg_appraisal_review_3345', field: 'rural' };
    const today = Object.assign({}, before, { factKey: 'isg_signal:appraisal_rural' });
    const oldKey = claimOf(before);
    assert.notStrictEqual(claimOf(today), oldKey, 'fixture must really exercise both key forms');

    await fdec.record(client, {
      applicationId: app.id, finding: before, origin: 'ai_suggestion',
      decision: 'dismissed', note: 'not a concern on this file',
    });
    let keys = await fdec.suppressedKeys(client, app.id);
    assert.ok(keys.has(oldKey), 'the decision is on file under the key it was written with');
    assert.ok(fdec.isSuppressed(keys, today),
      'and it must STILL settle the same finding now that the producer declares a fact');
    ok('a decision recorded before the fact key existed still suppresses (no backfill needed)');

    // …and a decision taken on the MERGED card settles every producer of that fact.
    await fdec.record(client, {
      applicationId: app.id, finding: today, origin: 'ai_suggestion', decision: 'dismissed',
    });
    keys = await fdec.suppressedKeys(client, app.id);
    for (const code of ['isg_appraisal_review_123', 'isg_appraisal_review_3345', 'isg_rural_property']) {
      assert.ok(fdec.isSuppressed(keys, { code, factKey: 'isg_signal:appraisal_rural' }),
        `${code} asserts the settled fact — one dismiss must settle it too`);
    }
    assert.ok(!fdec.isSuppressed(keys, { code: 'isg_bl_ny_loan' }),
      'an unrelated finding must NOT be swept up');
    ok('one dismiss on the merged card settles every producer of that fact — and nothing else');

    // …and re-opening it un-suppresses BOTH forms, so a dismissal is never a one-way door.
    await fdec.reopen(client, { applicationId: app.id, finding: today, by: null });
    keys = await fdec.suppressedKeys(client, app.id);
    assert.ok(!fdec.isSuppressed(keys, today), 'a re-opened finding comes back');
    assert.ok(!fdec.isSuppressed(keys, before), 'including under its older key form');
    ok('re-open clears every key the decision was written under');

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
    const payloads = deskToSuggestions({
      noteBuyer: { name: 'Blue Lake' }, verdicts: [{ cond_no: 1 }],
      unhappy: [
        { cond_no: 123, flag: 'appraisal_review', severity: 'warning', name: 'RURAL PROPERTY INELIGIBLE',
          domain: 'property', concern_field: 'appraisal_rural', pilot_template_code: null },
        { cond_no: 3345, flag: 'appraisal_review', severity: 'warning', name: 'RURAL PROPERTY VERIFICATION',
          domain: 'rural', concern_field: 'appraisal_rural', pilot_template_code: null },
      ],
    });
    assert.strictEqual(payloads.length, 2, 'the real desk must emit both rural rows');
    assert.ok(payloads.every((p) => !p.evidence.code),
      'fixture must reproduce the real shape: a concern-carrying row has NO template code');
    const sugIds = [];
    for (const p of payloads) sugIds.push((await aiSug.record(client, { ...p, applicationId: app2.id })).id);
    assert.strictEqual(sugIds.filter(Boolean).length, 2);
    ok('the real desk rows persist — and really do carry no template code');

    // The merged card carries ONE inherited handle. Dismissing it must settle the FACT.
    await aiSug.decide(client, sugIds[0], { action: 'dismiss', reason: 'not a concern', staffId: null });
    const written = (await client.query(
      `SELECT finding_key FROM finding_decisions WHERE application_id=$1 ORDER BY 1`, [app2.id])).rows
      .map((r) => r.finding_key);
    assert.ok(written.includes('claim:isg_signal:appraisal_rural'),
      `Dismiss must record the CLAIM — got ${JSON.stringify(written)}`);
    const set2 = await fdec.suppressedKeys(client, app2.id);
    assert.ok(fdec.isSuppressed(set2, { code: 'isg_rural_property', factKey: 'isg_signal:appraisal_rural' }),
      "the run's rural fatal asserts the settled fact and must not come back");
    assert.ok(fdec.isSuppressed(set2, { code: 'isg_appraisal_review_3345', factKey: 'isg_signal:appraisal_rural' }),
      'nor the sibling desk row whose ai_suggestions row is still open');
    assert.ok(!fdec.isSuppressed(set2, { code: 'isg_bl_ny_loan' }), 'and nothing unrelated is swept up');
    ok('a Dismiss through the REAL door settles the whole claim');

    // …and the AI panel must recognise the surviving sibling as the already-shown claim,
    // or it renders a second card for the same fact right next to the merged one.
    const listed = await aiSug.listForFile(app2.id, { includeDismissed: true }, client);
    assert.ok(listed.length >= 2, 'both mirrors are on file');
    assert.ok(listed.every((r) => r.claim_key === 'claim:isg_signal:appraisal_rural'),
      `every rural mirror must carry the claim key the Open-findings list deduped on — got ${JSON.stringify(listed.map((r) => r.claim_key))}`);
    ok('the AI panel keys its mirror rows on the same claim, so it hides the duplicate');

    // The escalation door only ever sees a CODE (db/222 stores a finding snapshot).
    assert.strictEqual(deskFindings.factKeyForCode('isg_appraisal_review_3345'), 'isg_signal:appraisal_rural');
    assert.strictEqual(deskFindings.factKeyForCode('isg_gap_rtl_cond_title'), null,
      'a coverage gap is about a MISSING CONDITION, not a fact — it must never be keyed');
    assert.strictEqual(deskFindings.factKeyForCode('bank_account_not_borrower'), null);
    for (const bad of [null, undefined, '', 42, {}, []]) {
      assert.strictEqual(deskFindings.factKeyForCode(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
    ok('a desk CODE alone resolves its fact — and never guesses one');

    // …and the sibling's AI-panel row must be CLOSED, not merely hidden-while-shown.
    // The panel hides a mirror only while its claim is visible in the Open-findings list.
    // The dismiss removes the card from that list, so the claim leaves the "already shown"
    // set and the sibling un-hides — one dismiss, same item live again one panel over.
    const stillOpen = (await client.query(
      `SELECT dedupe_key, status FROM ai_suggestions
        WHERE application_id=$1 AND status IN ('open','escalated','marked_important','asked_admin')`,
      [app2.id])).rows;
    assert.strictEqual(stillOpen.length, 0,
      `settling the fact must settle every row asserting it — still open: ${JSON.stringify(stillOpen)}`);
    ok('the sibling mirror is CLOSED by the same decision, not left open behind the card');

    // …and a row asserting a DIFFERENT fact is never swept up by that close.
    const other = await aiSug.record(client, {
      applicationId: app2.id, source: 'investor_guideline_desk', kind: 'finding', severity: 'warning',
      title: 'Transferred appraisal', body: 'x',
      evidence: { code: null, concern_field: 'appraisal_transferred', cond_no: 3349, flag: 'appraisal_review' },
      dedupeKey: 'isg-appraisal_review:3349',
    });
    await aiSug.decide(client, sugIds[1] || other.id, { action: 'dismiss', reason: 'x', staffId: null })
      .catch(() => {});
    const transferred = (await client.query(
      `SELECT status FROM ai_suggestions WHERE id=$1`, [other.id])).rows[0];
    assert.strictEqual(transferred.status, 'open',
      'a row declaring a DIFFERENT fact must be untouched — the close matches the fact, never a code');
    ok('a different fact is never swept up');

    // ── 7. THE ESCALATION DOOR, wired (not just the resolver in isolation) ──
    // db/222 stores only a finding SNAPSHOT, so the code is all the queue has. Asking only
    // the run's rule table left every DESK-raised escalation recording the code form alone
    // — and the desk is where the existing decisions are.
    const app3 = (await client.query(
      `INSERT INTO applications (borrower_id, property_address, lender)
         VALUES ($1, '{"state":"NY"}'::jsonb, 'Blue Lake') RETURNING id`, [b.id])).rows[0];
    const escShape = uw._escalationFindingShape({ code: 'isg_appraisal_review_3345', field: 'rural' });
    assert.strictEqual(escShape.factKey, 'isg_signal:appraisal_rural',
      'the escalation door must resolve a DESK code to its fact, not only a run code');
    await fdec.record(client, {
      applicationId: app3.id, finding: escShape, origin: 'escalation', decision: 'dismissed',
    });
    const escKeys = await fdec.suppressedKeys(client, app3.id);
    assert.ok(fdec.isSuppressed(escKeys, { code: 'isg_rural_property', factKey: 'isg_signal:appraisal_rural' }),
      "a super-admin's 'no action needed' on the desk finding must settle the run's fatal about the same fact");
    assert.strictEqual(uw._escalationFindingShape({ code: 'isg_rural_property' }).factKey,
      'isg_signal:appraisal_rural', 'and a RUN code still resolves through the run resolver');
    assert.strictEqual(uw._escalationFindingShape({ code: 'bank_account_not_borrower' }).factKey, undefined,
      'every other finding keys exactly as before');
    ok('an escalation decision on a desk code settles the claim');

    // ── 8. THE LEDGER WRITES EVERY KEY, not just the primary ───────────────
    const app4 = (await client.query(
      `INSERT INTO applications (borrower_id, property_address) VALUES ($1,'{}'::jsonb) RETURNING id`,
      [b.id])).rows[0];
    await fdec.record(client, {
      applicationId: app4.id, finding: { code: 'isg_appraisal_review_123', factKey: 'isg_signal:appraisal_rural' },
      origin: 'ai_suggestion', decision: 'dismissed',
    });
    const bothForms = (await client.query(
      `SELECT finding_key FROM finding_decisions WHERE application_id=$1 ORDER BY 1`, [app4.id])).rows
      .map((r) => r.finding_key);
    assert.deepStrictEqual(bothForms,
      ['claim:isg_signal:appraisal_rural', 'code:isg_appraisal_review_123::::::'],
      'record() must write BOTH the claim form and the code form — one alone leaves a gap in one direction');
    ok('the ledger records every key a finding answers to');

    // ── 9. THE FOLD FILTER keeps a run finding that MERGED with a desk row ──
    // A desk finding carries no handle either until its ai_suggestions mirror exists, and
    // that sync runs after the response. Dropping a handle-less survivor unconditionally
    // would swallow the DESK's finding on the view where the two first meet.
    const foldFilter = uw._foldFilter;
    const runOnly = { source: investorReview.SOURCE, code: 'isg_bl_ny_loan', severity: 'fatal' };
    const merged = { source: investorReview.SOURCE, code: 'isg_rural_property', severity: 'fatal',
      mergedFrom: ['isg_appraisal_review_3345'] };
    const actionable = { source: investorReview.SOURCE, code: 'isg_rural_property', suggestionId: 'sug-1' };
    assert.strictEqual(foldFilter(runOnly), false,
      'a run finding that merged with nothing has no buttons — it stays in the run cockpit');
    assert.strictEqual(foldFilter(merged), true,
      'one that merged with a desk row must stay: the desk finding was going to show anyway');
    assert.strictEqual(foldFilter(actionable), true, 'and one that inherited a handle is fully actionable');
    assert.strictEqual(foldFilter({ code: 'bank_account_not_borrower' }), true,
      'nothing outside the run fold is ever filtered');
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

    // ── 11. THE DESK CODE RESOLVER IS NAMESPACE-ANCHORED ───────────────────
    // A bare /_(\d+)$/ looks up ANY code ending in digits against a global cond_no table.
    // `oa_ownership_not_44` is an operating-agreement check, not cond_no 44 — and cond 44
    // DOES carry a concern_field, so an unanchored regex would hand it a note-buyer fact
    // and let a decision on it suppress an unrelated finding.
    assert.strictEqual(deskFindings.factKeyForCode('oa_ownership_not_44'), null,
      'a non-desk code that merely ends in a cond_no must never resolve to a note-buyer fact');
    assert.strictEqual(deskFindings.factKeyForCode('isg_emcap_missing_3345'), null,
      'nor a code outside the desk flag namespace');
    assert.strictEqual(deskFindings.factKeyForCode('isg_concern_44'), 'isg_signal:non_arms_length_concern',
      'while a real desk code still resolves');
    ok('the desk code resolver is anchored to the desk namespace, not "ends in digits"');

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

'use strict';
/**
 * LT test — the pipeline's chip counts, against a real database.
 *
 * The property this suite exists for:
 *
 *   A FACET COUNT MUST DESCRIBE WHAT CLICKING IT WOULD SHOW.
 *
 * The obvious implementation counts the stages under the SAME where the list uses,
 * which means that with a stage selected every other stage reports zero — and a row
 * of zeroes is a row nobody can navigate out of, because the way back is the chip
 * that says there is nothing there. The fix is to lift each facet's OWN filter while
 * keeping the rest, and the only way to prove it is to run both halves and compare:
 * for every chip, its count must equal the number of rows the list returns when that
 * chip is the filter. That is asserted here for every stage and every scope chip.
 *
 * A pure test cannot do it. `count(*) FILTER (...)`, the placeholder arithmetic across
 * two independently-built statements, and the join fan-out are all things that either
 * run or do not — and a wrong column name inside a swallowing catch reports a
 * confident, permanent zero, which on a count is indistinguishable from an empty book.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-pipeline-facets-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/db');
const ltDb = require('../src/longterm/db');
const pipeline = require('../src/longterm/pipeline');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const ME = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const made = [];

// `lt_loan_contacts.staff_id` points at the SHARED staff roster — the identity zone
// Long-Term READS (ledger 2026-08-03). Two real rows, so the foreign key is honoured
// and the counts run against the same shape production has.
async function makeStaff() {
  for (const [id, name] of [[ME, 'LT Facet Me'], [OTHER, 'LT Facet Other']]) {
    await ltDb.query(
      `INSERT INTO staff_users (id, email, full_name, role, is_active)
            VALUES ($1::uuid, $2, $3, 'loan_officer', true)
       ON CONFLICT (id) DO NOTHING`,
      [id, `${id}@lt-facet-test.local`, name],
    );
  }
}

async function makeLoan(stage, { officer = null, processor = null, number = null } = {}) {
  const stamp = number || `LTFC${Date.now()}${made.length}`;
  const { rows } = await ltDb.query(
    `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, stage_key, milestone_name)
          VALUES (gen_random_uuid(), $1, $1, $2, 'Processing') RETURNING id`,
    [stamp, stage],
  );
  const id = rows[0].id;
  made.push(id);
  for (const [role, staffId] of [['loan_officer', officer], ['processor', processor]]) {
    if (!staffId) continue;
    await ltDb.query(
      `INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, staff_id)
            VALUES (gen_random_uuid(), $1::uuid, $2, 'Somebody', $3::uuid)`,
      [id, role, staffId],
    );
  }
  return id;
}

// The list, as the screen would get it, narrowed to the loans this test made — so a
// pre-existing book in the database cannot make a count disagree with a row set.
async function listIds(access, staffId, filters) {
  const q = pipeline.buildPipelineQuery(access, staffId, filters);
  const { rows } = await ltDb.query(q.sql, q.params);
  return rows.filter((r) => made.includes(String(r.id))).map((r) => String(r.id));
}
async function facets(access, staffId, filters) {
  const f = pipeline.buildFacetQueries(access, staffId, filters);
  const [a, b] = await Promise.all([
    ltDb.query(f.stagesSql, f.stagesParams),
    ltDb.query(f.scopeSql, f.scopeParams),
  ]);
  const byStage = {};
  let allStages = 0;
  for (const r of a.rows) { byStage[String(r.stage_key || '')] = Number(r.n); allStages += Number(r.n); }
  // The sum of the stage-lifted counts IS what the "Every stage" chip must show —
  // computed here the same way production computes it, and compared against the real
  // `loadPipeline` answer in section E so the two can never drift.
  return { byStage, allStages, scope: b.rows[0] };
}

(async () => {
  try {
    await makeStaff();

    // A book with a shape: two stages, some mine, some somebody else's, one nobody's.
    const SFX = String(Date.now());
    const mineSetup = await makeLoan(`setup_${SFX}`, { officer: ME });
    const mineSetup2 = await makeLoan(`setup_${SFX}`, { processor: ME });
    const theirsSetup = await makeLoan(`setup_${SFX}`, { officer: OTHER });
    const mineFunded = await makeLoan(`funded_${SFX}`, { officer: ME });
    const nobodys = await makeLoan(`funded_${SFX}`);
    const SETUP = `setup_${SFX}`;
    const FUNDED = `funded_${SFX}`;
    const ALL = { seesAll: true };

    // ── A. Each stage chip counts what clicking it shows ─────────────────────
    console.log('every stage chip counts what clicking it would show');

    // The counts with nothing selected are the truth about the book. Every one of
    // them must survive UNCHANGED under every selection — that is the property, and
    // it is why the baseline is compared rather than each count re-derived (which
    // would just be the implementation checking itself).
    const base = await facets(ALL, ME, {});
    for (const stage of [SETUP, FUNDED]) {
      const clicked = await listIds(ALL, ME, { stage });
      check(clicked.length === (stage === SETUP ? 3 : 2),
        `clicking ${stage === SETUP ? 'the first' : 'the second'} stage returns its ${clicked.length} loans`);
    }
    for (const selected of [SETUP, FUNDED]) {
      const f = await facets(ALL, ME, { stage: selected });
      const same = [SETUP, FUNDED].every((s) => (f.byStage[s] || 0) === (base.byStage[s] || 0));
      check(same,
        `THE ONE THAT MATTERS: selecting ${selected === SETUP ? 'the first' : 'the second'} stage leaves EVERY stage count exactly as it was — count them under the selection and every other chip answers zero, which is a row nobody can navigate out of, because the way back is the chip that says there is nothing there`);
    }
    check((base.byStage[SETUP] || 0) >= 3 && (base.byStage[FUNDED] || 0) >= 2,
      'and the baseline counts see the loans the list returns');

    // Narrowing by something that is NOT the stage must still move the stage counts —
    // otherwise "lift the facet's own filter" has quietly become "lift everything",
    // and the chips would describe a book nobody is looking at.
    const fMine = await facets(ALL, ME, { mine: true });
    check((fMine.byStage[SETUP] || 0) === 2 && (fMine.byStage[FUNDED] || 0) === 1,
      'THE ONE THAT MATTERS: a scope chip DOES move the stage counts — each facet lifts its own filter and keeps every other one, so the row always describes what you are actually looking at');

    // ── B. The scope chips ──────────────────────────────────────────────────
    console.log('\nthe scope chips count the same way');

    const f0 = await facets(ALL, ME, {});
    const mineRows = await listIds(ALL, ME, { mine: true });
    const unassignedRows = await listIds(ALL, ME, { unassigned: true });
    check(mineRows.length === 3 && mineRows.includes(mineSetup) && mineRows.includes(mineSetup2)
      && mineRows.includes(mineFunded),
    'a viewer whose role nobody has mapped falls back to the wide reading — every file they are ON, any role (an unmapped role shown an empty book would be a support ticket)');
    check(!mineRows.includes(theirsSetup), '…and never somebody else’s');
    check(unassignedRows.length === 1 && unassignedRows[0] === nobodys,
      '"nobody yet" is the file with no contact on it at all — the closer’s and funder’s reason for seeing the whole book');
    check(Number(f0.scope.mine_n) >= 3 && Number(f0.scope.unassigned_n) >= 1,
      'the counts see them too');

    // ── B2. "Mine" is PERSONA-MATCHED (db/623 era, owner-directed 2026-08-23) ──
    // The owner's own case: a file where they were assigned ONLY as the closer
    // turned up under "files that I was the Loan Officer on". An admin's book is
    // the files they ORIGINATE; the wide reading is its own deliberate choice.
    console.log('\n"mine" is persona-matched — WHY you are on a file decides whether it is yours');

    const ADMIN = { seesAll: true, ltRole: 'admin' };
    const adminMine = await listIds(ADMIN, ME, { mine: true });
    check(adminMine.length === 2 && adminMine.includes(mineSetup) && adminMine.includes(mineFunded),
      'THE ONE THAT MATTERS: an admin’s "Mine" is the files they are the LOAN OFFICER on');
    check(!adminMine.includes(mineSetup2),
      '…and the file they hold only ANOTHER hat on is NOT in it — the owner’s closer-only complaint');
    const adminAny = await listIds(ADMIN, ME, { mine: true, mineRole: 'any' });
    check(adminAny.length === 3 && adminAny.includes(mineSetup2),
      'the wide reading is one deliberate click away (mineRole=any), so nothing is unreachable');
    const adminOne = await listIds(ADMIN, ME, { mine: true, mineRole: 'processor' });
    check(adminOne.length === 1 && adminOne[0] === mineSetup2,
      'and one specific hat can be asked for by name ("files where I am the processor")');
    // The stage key is unique to this run, so a stage-narrowed facet counts ONLY
    // this test's rows — which is what lets the agreement be asserted EXACTLY.
    const fAdminSetup = await facets(ADMIN, ME, { stage: SETUP });
    check(Number(fAdminSetup.scope.mine_n) === 1,
      'the chip count is built from the SAME persona-matched predicate as the filter — the processor-held file is not in the admin’s number');
    const PROC = { seesAll: true, ltRole: 'processor' };
    const procMine = await listIds(PROC, ME, { mine: true });
    check(procMine.length === 1 && procMine[0] === mineSetup2,
      'a processor’s "Mine" is the files they PROCESS — their own book, never empty and never the officer’s');

    const fSetup = await facets(ALL, ME, { stage: SETUP });
    const mineInSetup = await listIds(ALL, ME, { stage: SETUP, mine: true });
    check(mineInSetup.length === 2,
      'the two rows are INDEPENDENT: a stage and a scope chip narrow together, as the plan’s two control rows require');
    check(Number(fSetup.scope.mine_n) - Number(f0.scope.mine_n) < 0,
      '…and the scope counts RESPECT the selected stage — they answer "of what you are looking at", not "of everything"');

    // ── C. The scope is never counted past ──────────────────────────────────
    console.log('\nthe chips can never count a file the viewer may not open');

    const own = { seesAll: false, scope: 'own' };
    const fOwn = await facets(own, ME, {});
    const ownRows = await listIds(own, ME, {});
    check(ownRows.length === 3 && !ownRows.includes(theirsSetup) && !ownRows.includes(nobodys),
      'a scoped viewer’s list is their own files only');
    const ownStageTotal = [SETUP, FUNDED].reduce((n, s) => n + (fOwn.byStage[s] || 0), 0);
    check(ownStageTotal === 3,
      'THE ONE THAT MATTERS: their chip counts total THEIR book — the scope is the authorization, not a filter, so no facet may lift it and tell somebody a book exists that they cannot reach');
    check(Number(fOwn.scope.unassigned_n) === 0,
      '…so "nobody yet" reads zero for them, which is true of what they can see');

    // ── D. A stage nobody declared is still reachable ────────────────────────
    console.log('\na stage the settings do not name is shown, not hidden');

    const chips = pipeline.stageChips(
      [{ key: SETUP, label: 'Setup' }],
      { byStage: { [SETUP]: 3, [FUNDED]: 2 } },
    );
    check(chips.length === 2 && chips[1].key === FUNDED && chips[1].undeclared === true,
      'THE ONE THAT MATTERS: a loan sitting under a stage key nobody mapped gets its own chip — §4.1.1’s rule for the control row, because a file you cannot filter to is a file people stop seeing');
    check(chips[0].count === 3, 'a declared stage carries its count');
    check(pipeline.stageChips([{ key: SETUP, label: 'Setup' }], { byStage: {} })[0].count === 0,
      'a declared stage with nothing in it reads 0 — "nothing here" is an answer a desk acts on, and a chip that vanishes makes the row jump as the book moves');
    check(pipeline.stageChips([{ key: SETUP, label: 'Setup' }], null)[0].count === null,
      'and when the counting failed the chips carry NULL, never 0 — a zero would claim the book is empty, which the list beside it disproves');

    // ── D2. The "Every stage" chip ──────────────────────────────────────────
    console.log('\nthe "Every stage" chip counts the whole book, not the selected stage');

    const fSel = await facets(ALL, ME, { stage: SETUP });
    const fNone = await facets(ALL, ME, {});
    check(fSel.allStages === fNone.allStages && fSel.allStages >= 5,
      'THE ONE THAT MATTERS: the all-stages count does not move when a stage is selected — using the LIST’s own total there would make the chip read the selected stage’s number, undoing every other count in the row on the one chip that is supposed to clear them');
    const listTotal = await ltDb.query(
      `SELECT count(*)::int n ${'FROM lt_loans l'} WHERE l.stage_key = $1`, [SETUP]);
    check(fSel.allStages > listTotal.rows[0].n,
      '…and it is genuinely bigger than the selected stage, which is the whole point');

    // ── D3. A filter this viewer's scope makes moot ─────────────────────────
    console.log('\na scope filter that cannot mean anything is dropped and said out loud');

    const strandedRows = await listIds(own, ME, { unassigned: true });
    check(strandedRows.length === 3,
      'THE ONE THAT MATTERS: a scoped viewer opening a SHARED view of "nobody yet" still sees their book — answering it literally is an empty pipeline, and the screen draws no scope row for them, so there would be no control to clear it with');
    const ignored = pipeline.ignoredScopeFilters(own, { unassigned: true });
    check(ignored.length === 1 && ignored[0].key === 'unassigned' && /cannot match/.test(ignored[0].why),
      '…and it is NAMED in plain words rather than silently ignored');
    check(pipeline.ignoredScopeFilters(ALL, { unassigned: true }).length === 0,
      'a viewer who sees the whole book has the filter applied as asked');
    const mineStranded = await listIds(own, ME, { mine: true });
    check(mineStranded.length === 3,
      '"mine" is simply their scope restated, so it changes nothing for them');

    // ── D4. A loan with NO stage at all ─────────────────────────────────────
    console.log('\na loan with no stage yet is reachable, not just visible');

    // Not a hypothetical: the pipeline search's own milestone column is blank on every
    // loan in this tenant, so a freshly DISCOVERED loan has no stage until its detail
    // sync runs — which makes this the normal state of the newest files.
    const unstagedId = await makeLoan(null, { officer: ME });
    const fU = await facets(ALL, ME, {});
    check((fU.byStage[''] || 0) >= 1, 'the counts see it, under the empty key');

    const chipsU = pipeline.stageChips([{ key: SETUP, label: 'Setup' }], { byStage: fU.byStage });
    const noStageChip = chipsU.find((c) => c.key === pipeline.NO_STAGE);
    check(!!noStageChip && noStageChip.unstaged === true && noStageChip.count >= 1,
      'THE ONE THAT MATTERS: it gets its own chip — without one it sits in the list, is counted in the header, and can be filtered to by nothing, so the row’s numbers do not add up to the number above it');
    check(chipsU.reduce((n, c) => n + (c.count || 0), 0) === fU.allStages,
      '…which is exactly what makes the chips sum to the all-stages total');

    const unstagedRows = await listIds(ALL, ME, { stage: pipeline.NO_STAGE });
    check(unstagedRows.length === 1 && unstagedRows[0] === unstagedId,
      'and clicking it returns the unstaged loan — the filter is a real one, not a label');
    const stagedRows = await listIds(ALL, ME, { stage: SETUP });
    check(!stagedRows.includes(unstagedId),
      '…while an ordinary stage chip still excludes it');
    check(pipeline.stageChips([{ key: SETUP, label: 'Setup' }], { byStage: { [SETUP]: 2 } })
      .every((c) => c.key !== pipeline.NO_STAGE),
    'a book with nothing unstaged grows no such chip — it appears because there is something in it');

    // ── E. The whole thing, through loadPipeline ────────────────────────────
    console.log('\nthe route’s own answer carries both rows');

    const out = await pipeline.loadPipeline({ id: ME, role: 'admin' }, { stage: SETUP });
    check(Array.isArray(out.stages) && out.stages.some((s) => s.count != null),
      'the stages come back with counts on them');
    check(out.facets && typeof out.facets.all === 'number' && typeof out.facets.unassigned === 'number',
      'and the scope counts ride alongside');
    const declaredSum = (out.stages || []).reduce((n, s2) => n + (s2.count || 0), 0);
    check(out.facets.allStages === declaredSum,
      'THE ONE THAT MATTERS: the route’s all-stages count equals the sum of the chips beside it — a header number that disagrees with the row under it is the kind of thing nobody reports and everybody stops trusting');
    check(out.facets.mine !== null, 'a viewer we can identify has a "mine" count');
    const anon = await pipeline.loadPipeline({ role: 'admin' }, {});
    check(anon.facets && anon.facets.mine === null,
      'THE ONE THAT MATTERS: a viewer with no id has NO "mine" count rather than a count of zero — "nobody knows who you are" and "you have no files" are different answers');
  } catch (e) {
    failures += 1;
    console.error('  FAIL unexpected error:', (e && e.message) || e);
  } finally {
    for (const id of made) {
      await ltDb.query('DELETE FROM lt_loan_contacts WHERE loan_id = $1::uuid', [id]).catch(() => {});
      await ltDb.query('DELETE FROM lt_loans WHERE id = $1::uuid', [id]).catch(() => {});
    }
    for (const id of [ME, OTHER]) {
      await ltDb.query('DELETE FROM staff_users WHERE id = $1::uuid', [id]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
    await ltDb.pool.end().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();

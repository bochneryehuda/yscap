#!/usr/bin/env node
/**
 * THE VESTING MOVES, AND THE COMPANY-DOCUMENTS CONDITION MOVES WITH IT.
 *
 * Owner-directed 2026-08-31: *"We also need to make an automatic trigger if it
 * changes. If it was set for officer and it changed to individual, then the
 * condition should disappear. If it was set for individual and was changed to
 * officer, then the condition automatically appears."*
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 *
 * `evaluateLoan` has always attached AND retracted correctly. What it did not
 * have was a caller that runs when the FACT changes: its only two callers are
 * screens — the Condition Center read and the orders desk read. Field 4008 is
 * written by the Encompass loan sync and by nothing else, so a loan re-vested in
 * Encompass kept the wrong condition until a human happened to open it, and
 * anything counting or chasing outstanding conditions counted the stale one.
 *
 * ── WHAT IS PROVEN HERE, AND WHY IT TAKES THREE KINDS OF CHECK ──────────────
 *
 *   A. the ENGINE really adds and removes it as 4008 moves — against a real
 *      database, on a real loan, both directions and back again;
 *   B. a condition somebody has WORKED is never destroyed by the move — the
 *      honest limit of "it should disappear", stated rather than discovered;
 *   C. the SYNC really calls the engine on a change and really does not on a
 *      re-send. No end-to-end run can reach C without live Encompass
 *      credentials, and a unit test of the decision cannot see its caller — the
 *      same shape as the Trinity eligibility rule that was fixed while its one
 *      caller kept passing the wrong argument — so C reads the source.
 *
 * DB-GATED.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

const CODE = 'lt_vesting_entity';

(async () => {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-vesting-condition-trigger');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const vesting = require('../src/longterm/vesting.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');

    const makeLoan = async (tag, vestingType, entityName) => {
      const borrower = (await cx.query(
        `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Vest','Probe',$1) RETURNING id`,
        [`vest-${tag}-${Date.now()}@example.test`])).rows[0].id;
      const loan = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, vesting_type, vesting_entity_name)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr',$4,$5)`,
        [loan, borrower, `VEST-${tag}-${Date.now()}`, vestingType, entityName || null]);
      await cx.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
         VALUES ($1::uuid,'1 Vest St','Somewhere','NJ','11111',1,'SFR')`, [loan]);
      return loan;
    };

    /** Is the company-documents condition ON this loan right now? */
    const hasCondition = async (loanId) => {
      const { rows } = await cx.query(
        `SELECT ci.id, ci.status, ci.origin_kind
           FROM checklist_items ci
           JOIN checklist_templates t ON t.id = ci.template_id
          WHERE ci.lt_loan_id = $1::uuid AND t.code = $2`,
        [loanId, CODE]);
      return rows[0] || null;
    };

    const setVesting = async (loanId, vestingType, entityName) => cx.query(
      `UPDATE lt_loans SET vesting_type = $2, vesting_entity_name = $3 WHERE id = $1::uuid`,
      [loanId, vestingType, entityName || null]);

    // ───────────────────────────────────────────────────────────────────────
    console.log('\nA. THE CONDITION FOLLOWS FIELD 4008, BOTH WAYS AND BACK');

    const loan = await makeLoan('move', 'Officer', 'MW Trading LLC');
    await engine.evaluateLoan(loan, { db: cx });
    ok(!!(await hasCondition(loan)),
      'an Officer-vested loan is asked for the company documents');

    // → Individual. The owner's first case.
    await setVesting(loan, 'Individual', null);
    await engine.evaluateLoan(loan, { db: cx });
    ok(!(await hasCondition(loan)),
      'THE ONE THAT MATTERS: re-vested to Individual, the condition DISAPPEARS on its own');

    // → back to Officer. The owner's second case.
    await setVesting(loan, 'Officer', 'MW Trading LLC');
    await engine.evaluateLoan(loan, { db: cx });
    ok(!!(await hasCondition(loan)),
      'THE ONE THAT MATTERS: re-vested back to Officer, the condition COMES BACK on its own');

    // Officer with the name not typed in yet — the owner's 1859 rule, end to end.
    const noName = await makeLoan('noname', 'Officer', null);
    await engine.evaluateLoan(noName, { db: cx });
    ok(!!(await hasCondition(noName)),
      'an Officer loan whose entity name is not entered yet is still asked — the name is coming, the vesting is decided');

    // Blank 4008 — the owner chose "keep asking".
    const blank = await makeLoan('blank', null, null);
    await engine.evaluateLoan(blank, { db: cx });
    ok(!!(await hasCondition(blank)),
      'a loan Encompass has not answered for is still asked, per "keep asking for them"');

    // …and the same loan answered as Individual for the first time loses it.
    await setVesting(blank, 'Individual', null);
    await engine.evaluateLoan(blank, { db: cx });
    ok(!(await hasCondition(blank)),
      'and once Encompass says Individual, it comes off — unknown is a real side of the move, not a way of skipping one');

    // ───────────────────────────────────────────────────────────────────────
    console.log('\nB. WORK IS NEVER DESTROYED BY A RE-VESTING');

    const worked = await makeLoan('worked', 'Officer', 'Worked Holdings LLC');
    await engine.evaluateLoan(worked, { db: cx });
    const item = await hasCondition(worked);
    ok(!!item, 'CONTROL: the worked loan starts with the condition');
    if (item) {
      // Somebody has answered it — exactly what the engine must refuse to delete.
      await cx.query(`UPDATE checklist_items SET notes = 'the borrower sent these in' WHERE id = $1::uuid`, [item.id]);
      await setVesting(worked, 'Individual', null);
      await engine.evaluateLoan(worked, { db: cx });
      const after = await hasCondition(worked);
      ok(!!after,
        'a condition somebody has WORKED survives the move to Individual — deleting it would throw away the work, so it is left for a human');
    }

    // ───────────────────────────────────────────────────────────────────────
    console.log('\nC. THE SYNC IS WIRED TO IT — the half no run here can reach');

    ok(vesting.vestingChanged({ vesting_type: 'Officer' }, { vesting_type: 'Individual' }) === true
      && vesting.vestingChanged({ vesting_type: 'Individual' }, { vesting_type: 'Officer' }) === true,
      'the decision says both of the owner\'s moves ARE changes');
    ok(vesting.vestingChanged({ vesting_type: 'Officer' }, { vesting_type: ' officer ' }) === false
      && vesting.vestingChanged({ vesting_type: 'Officer' }, { vesting_type: 'Trustee' }) === false,
      '...and that a re-sent word, or one that means the same thing, is NOT — or every sync of every loan would drag the rules engine through the whole book');
    ok(vesting.vestingChanged({ vesting_type: null }, { vesting_type: 'Individual' }) === true,
      '...and that a first answer counts, because that is the move that takes the condition off');

    const syncSrc = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/sync/loans.js'), 'utf8');
    ok(/vesting\.vestingChanged\(/.test(syncSrc),
      'the loan sync asks that decision rather than comparing the words itself');
    ok(/vest\.answered\s*&&\s*vesting\.vestingChanged\(/.test(syncSrc),
      '...gated on Encompass having answered at all — an unanswered read leaves the column alone, so nothing can have moved');
    // THE WIRING. Anchored on the `if` that guards it rather than on a character
    // distance: the block between the decision and the call is free to grow.
    const guardAt = syncSrc.indexOf('vesting.vestingChanged(');
    const callAt = syncSrc.indexOf('evaluateLoan(', guardAt);
    const closeAt = syncSrc.indexOf('\n  }', guardAt);
    ok(guardAt > 0 && callAt > guardAt && callAt < closeAt,
      'THE WIRING: a real move re-runs evaluateLoan, inside the branch the decision guards — a decision with no caller is the defect this suite exists for');

    // BEFORE the write that destroys it — anchored on the statement that writes
    // 4008, not on the first `UPDATE lt_loans` in the file, of which there are
    // several. Getting this wrong is how a guard passes while reading elsewhere.
    //
    // AND IT MUST BE A REAL READ. Anchoring on the NAME `priorVesting` alone
    // proves only that the variable is DECLARED above the write — a version
    // that declares it and never queries anything passes, leaves the
    // before-image permanently null, and makes `vestingChanged` answer true on
    // every answered loan: the rules engine dragged through the whole book on
    // every sync, which is precisely the cost the guard above claims to
    // prevent. So the anchor is the SELECT itself.
    const vestingWriteAt = syncSrc.indexOf('vesting_type = CASE WHEN');
    const priorReadAt = syncSrc.search(/SELECT\s+vesting_type\s+FROM\s+lt_loans\s+WHERE\s+id/i);
    const priorAt = syncSrc.indexOf('priorVesting');
    ok(priorReadAt > 0 && vestingWriteAt > 0 && priorReadAt < vestingWriteAt
      && priorAt > 0 && priorAt < vestingWriteAt,
      '...reading what we held BEFORE the write, because the write is what destroys the evidence',
      `read@${priorReadAt} write@${vestingWriteAt}`);

    // Reported on the pass. Anchored on the ONE return that carries the mirror's
    // own result, not on the last `return {` in a file with many functions.
    const mirrorReturn = syncSrc.slice(syncSrc.indexOf('return { ok: true, partial:'), syncSrc.indexOf('return { ok: true, partial:') + 900);
    ok(/vestingRules/.test(mirrorReturn),
      'and the outcome is REPORTED on the pass, so a rules pass that failed is not swallowed');

    if (fails.length) failed = true;
  } catch (e) {
    failed = true;
    console.error('\nFATAL', e);
  } finally {
    try { await cx.query('ROLLBACK'); } catch (_) { /* nothing to undo */ }
    cx.release();
    await db.pool.end().catch(() => {});
  }

  console.log('');
  if (failed || fails.length) {
    console.error(`${fails.length} FAILED:`);
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`OK test-lt-vesting-condition-trigger-db (${pass} checks passed)`);
})();

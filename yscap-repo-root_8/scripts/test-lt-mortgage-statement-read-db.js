#!/usr/bin/env node
'use strict';
/**
 * LT — THE MORTGAGE STATEMENT READS ITSELF, AND THE FCI WAY ANSWERS THE SERVICER.
 *
 * Owner-directed 2026-08-31, two halves of one item:
 *
 *   *"Servicer of the loan being paid off — this is now a separate condition. We
 *   don't need this to be a separate condition. We need the file to understand by
 *   themself on the condition of mortgage statement for subject property. So if
 *   you're putting in that it's FCI then the servicer automatically selects it to
 *   be FCI and our processor needs to go into FCI and look for the FCI loan
 *   number and put it in and outstanding balance. If you select this directly
 *   from the credit report then you automatically pull the servicer information
 *   and the outstanding balance and the loan number from credit report, and if
 *   you type information manually then you have it manually."*
 *
 *   *"Bring in the logic that we have on the document review section… to be able
 *   to read the mortgage statement and read who is the servicer name, who is the
 *   loan number, and what's the outstanding principal balance, and should
 *   automatically fill."*
 *
 * ── WHY A DATABASE TEST, WHEN A PURE ONE ALREADY COVERS THE READING ──────────
 *
 * `scripts/test-lt-mortgage-statement-read-pure.js` proves the SCANNER and the
 * two grounding gates, and it is where the reading rules belong. It cannot see
 * three things, and each one is a row rather than a rule:
 *
 *   1. THAT THE WRITE DOOR RECORDS THE SERVICER AT ALL. `answers.withFixed` is
 *      what puts `FCI Lender Services` onto the answer, and it is called from
 *      ONE line in `write.js`. Deleting that line was MUTATION-PROVEN to leave
 *      both pure suites completely green — the FCI way would ask for the two
 *      numbers, take them, and store an answer naming no servicer, silently,
 *      for ever. That is the gap this file exists to close.
 *   2. THAT THE PRE-FILL TOUCHES ONLY THIS CONDITION, AND NEVER A PERSON'S
 *      ANSWER. Both are decided against stored rows.
 *   3. THAT THE NEW WORDING REACHED FILES THAT ALREADY EXIST. The hint is
 *      COPIED onto each condition at creation, so the library alone would leave
 *      every live file promising a waiver that no longer exists.
 *
 * ── PROVEN TO FAIL ──────────────────────────────────────────────────────────
 *
 * Six mutations of the production code, each with a green control either side:
 * dropping `withFixed` from the write door, so the FCI way records no servicer
 * (1 fail — THE ONE THAT SURVIVED BOTH PURE SUITES, which is why this file
 * exists); letting the pre-fill overwrite an answer a person chose (2); letting
 * it fill a condition that is not the mortgage statement (2); dropping the
 * document id it read from (2); dropping the AI's must-be-printed gate, so an
 * invented servicer reaches a real condition (2); and editing the library
 * wording without db/664, so what a NEW tenant is told and what every existing
 * file says drift apart (3).
 *
 * DB-GATED.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', '664_the_fci_way_asks_for_the_two_numbers.sql');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

(async () => {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-mortgage-statement-read');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const write = require('../src/longterm/conditions-center/write.js');
  const answers = require('../src/lib/conditions/answers.js');
  const reader = require('../src/longterm/mortgage-statement-read.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');

    // ── A refinance file, built the way the screen builds one ────────────────
    const stamp = Date.now();
    const borrower = (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('State','Ment',$1) RETURNING id`,
      [`stmt-${stamp}@example.test`])).rows[0].id;
    const makeLoan = async (tag) => {
      const id = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr','cash_out_refinance'::lt_loan_purpose)`,
        [id, borrower, `MS-${tag}-${stamp}`]);
      await cx.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
         VALUES ($1::uuid,'9 Payoff Rd','Anytown','NJ','07001',1,'SFR')`, [id]);
      await engine.evaluateLoan(id, { db: cx });
      return id;
    };
    const conditionOn = async (loanId, code) => (await cx.query(
      `SELECT ci.id, ci.hint, ci.tool_payload AS answer
         FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.lt_loan_id = $1::uuid AND t.code = $2`, [loanId, code])).rows[0];
    const answerOf = async (id) => (await cx.query(
      `SELECT tool_payload AS answer FROM checklist_items WHERE id = $1::uuid`, [id])).rows[0].answer;

    const loan = await makeLoan('a');
    const stmtCond = await conditionOn(loan, 'lt_subject_mortgage_statement');

    // ── A. THE CONDITION IS ON A REFINANCE AT ALL ───────────────────────────
    console.log('\nA. THE MORTGAGE STATEMENT IS ASKED FOR ON A REFINANCE');
    ok(!!stmtCond, 'a refinance file carries the mortgage statement condition');

    // ── B. THE FCI WAY ANSWERS THE SERVICER, THROUGH THE REAL DOOR ──────────
    console.log('\nB. CHOOSING FCI RECORDS THE SERVICER — THE ONE THING IT ALREADY SAYS');
    {
      const r = await write.recordAnswer(loan, stmtCond.id, {
        way: 'fci_serviced',
        values: { loan_number: 'FCI-88213', outstanding_balance: 412500 },
      }, null, cx);
      ok(r.ok === true, 'the FCI way is accepted with the two numbers', r.error || '');
      const a = await answerOf(stmtCond.id);
      ok(a && a.values && a.values.servicer === answers.FCI_SERVICER,
        'and the STORED answer names FCI as the servicer — nobody typed it',
        JSON.stringify(a && a.values));
      ok(a && a.values && String(a.values.loan_number) === 'FCI-88213',
        '…alongside the FCI loan number a person did key in');
      ok(a && a.values && Number(a.values.outstanding_balance) === 412500,
        '…and the balance they looked up in FCI');
    }
    {
      // A servicer a PERSON typed is never overwritten by the way's own answer.
      const other = await makeLoan('b');
      const c = await conditionOn(other, 'lt_subject_mortgage_statement');
      const r = await write.recordAnswer(other, c.id, {
        way: 'typed',
        values: { servicer: 'Shellpoint Mortgage Servicing', loan_number: '77-4412', outstanding_balance: 250000 },
      }, null, cx);
      ok(r.ok === true, 'a typed answer still records', r.error || '');
      const a = await answerOf(c.id);
      ok(a.values.servicer === 'Shellpoint Mortgage Servicing',
        '…and a servicer a person typed is left exactly as they typed it');
    }

    // ── C. THE PRE-FILL FILLS ONLY THIS CONDITION ───────────────────────────
    console.log('\nC. THE READER FILLS THE MORTGAGE STATEMENT AND NOTHING ELSE');
    /* A LABELLED statement — the shape our own scanner can read with no AI at
       all, and the one every assertion below that is not about the AI uses. */
    const PAGE = [
      'FCI LENDER SERVICES, INC.',
      'MORTGAGE STATEMENT',
      'Statement Date: 08/01/2026',
      'Serviced by: FCI Lender Services, Inc.',
      'Loan Number: 0091883421',
      'Payment Due Date: 09/01/2026',
      'Outstanding Principal Balance: $318,442.19',
      'Escrow Balance: $2,204.10',
      'Principal & Interest: $1,884.02',
      'Amount Due: $2,410.55',
    ].join('\n');
    /* THE SAME STATEMENT WITH THE SERVICER ONLY ON THE LETTERHEAD — which is how
       a great many of them are printed. Our scanner will not guess that the top
       line of a document is the company; that is exactly the job the AI locator
       does, and section G proves it is still held to the document. */
    const LETTERHEAD = PAGE.split('\n').filter((l) => !/^Serviced by:/.test(l)).join('\n');
    const deps = (text, ai) => ({
      db: cx,
      storage: { read: async () => Buffer.from('bytes') },
      ocr: { configured: () => true, read: async () => ({ ok: true, text }) },
      ai: ai || { available: () => false },
    });
    const fresh = await makeLoan('c');
    const freshStmt = await conditionOn(fresh, 'lt_subject_mortgage_statement');
    const otherCond = await conditionOn(fresh, 'lt_housing_history');
    {
      const r = await reader.fillFromUpload(
        { loanId: fresh, conditionId: otherCond.id, code: 'lt_housing_history', documentId: 'doc-x', storageRef: 'ref' },
        deps(PAGE));
      ok(r.filled === false && r.why === 'not_that_condition',
        'a document on another condition is never read as a mortgage statement', r.why);
      const untouched = await answerOf(otherCond.id);
      ok(untouched == null || JSON.stringify(untouched) === '{}',
        '…and that condition is left with no answer at all', JSON.stringify(untouched));
    }
    let filledDocId = null;
    {
      filledDocId = crypto.randomUUID();
      const r = await reader.fillFromUpload(
        { loanId: fresh, conditionId: freshStmt.id, code: reader.CODE, documentId: filledDocId, storageRef: 'ref' },
        deps(PAGE));
      ok(r.filled === true, 'a statement uploaded onto the condition fills it in', r.detail || r.why || '');
      const a = await answerOf(freshStmt.id);
      ok(a.values && /FCI LENDER SERVICES/i.test(String(a.values.servicer || '')),
        '…with the servicer printed on the statement', String(a.values && a.values.servicer));
      ok(a.values && String(a.values.loan_number) === '0091883421',
        '…the loan number', String(a.values && a.values.loan_number));
      ok(a.values && Number(a.values.outstanding_balance) === 318442.19,
        '…and the OUTSTANDING PRINCIPAL balance, not the escrow, the payment or the amount due',
        String(a.values && a.values.outstanding_balance));

      // ── D. IT SAYS WHICH DOCUMENT IT READ ───────────────────────────────
      console.log('\nD. WHAT IT FILLED SAYS WHERE IT CAME FROM');
      ok(String(a.sourceDocumentId) === String(filledDocId),
        'the stored answer records the document it was read from', String(a.sourceDocumentId));
      ok(answers.filledFromStatement(a, filledDocId) === true,
        '…and is recognised as our own fill of THAT document');
      ok(answers.filledFromStatement(a, crypto.randomUUID()) === false,
        '…and not of another one');
      ok(/mortgage statement/i.test(String(answers.sourceNote(a) || '')),
        'and it says so in words wherever the answer is read', String(answers.sourceNote(a)));
    }

    // ── E. A PERSON'S ANSWER STANDS; ITS OWN FILL IS REPLACED ───────────────
    console.log('\nE. IT NEVER OVERWRITES A PERSON, AND IT DOES CORRECT ITSELF');
    {
      const CORRECTED = PAGE.replace('318,442.19', '311,002.00');
      const r = await reader.fillFromUpload(
        { loanId: fresh, conditionId: freshStmt.id, code: reader.CODE, documentId: crypto.randomUUID(), storageRef: 'ref' },
        deps(CORRECTED));
      ok(r.filled === true, 'a re-uploaded statement replaces the fill PILOT itself made', r.why || '');
      ok(Number((await answerOf(freshStmt.id)).values.outstanding_balance) === 311002,
        '…so a corrected statement corrects the figure');
    }
    {
      const typed = await makeLoan('d');
      const c = await conditionOn(typed, 'lt_subject_mortgage_statement');
      await write.recordAnswer(typed, c.id, {
        way: 'typed',
        values: { servicer: 'Rushmore Loan Management', loan_number: 'RM-5', outstanding_balance: 199000 },
      }, null, cx);
      const before = JSON.stringify(await answerOf(c.id));
      const r = await reader.fillFromUpload(
        { loanId: typed, conditionId: c.id, code: reader.CODE, documentId: crypto.randomUUID(), storageRef: 'ref' },
        deps(PAGE));
      ok(r.filled === false && r.why === 'already_answered',
        'an answer a person chose is never quietly replaced by a reading', r.why);
      ok(JSON.stringify(await answerOf(c.id)) === before,
        '…and their answer is left byte for byte as they left it');
    }

    // ── F. THE WORDING STOPPED PROMISING A WAIVER, ON EVERY FILE ────────────
    console.log('\nF. THE CONDITION NO LONGER PROMISES A WAIVER THAT ASKS FOR NOTHING');
    {
      const seeded = (await cx.query(
        `SELECT hint FROM checklist_templates WHERE code = 'lt_subject_mortgage_statement'`)).rows[0].hint;
      const authored = (typeof lib.library === 'function' ? lib.library() : lib.library)
        .find((x) => x && x.code === 'lt_subject_mortgage_statement').hint;
      /* BOTH DIRECTIONS. The library reaches a NEW tenant and db/664 reaches every
         existing one, so a change to either alone is drift — and the one that
         drifts is the one somebody reads. */
      ok(seeded === authored,
        'the seeded template says exactly what the library says',
        seeded === authored ? '' : `seeded=${JSON.stringify(seeded).slice(0, 90)}`);
      ok(!/waiver/i.test(seeded) && !/already hold everything/i.test(seeded),
        '…and no longer offers the FCI way as a waiver');
      ok(/FCI loan number/i.test(seeded) && /outstanding balance/i.test(seeded),
        '…it says the two numbers are still needed');
      ok(/PILOT reads/i.test(seeded),
        '…and that uploading the statement fills them in');
      const onFile = (await conditionOn(loan, 'lt_subject_mortgage_statement')).hint;
      ok(onFile === authored,
        'and a condition created today carries the same words',
        onFile === authored ? '' : String(onFile).slice(0, 90));
    }
    {
      /* THE BACK BOOK, PROPERLY. A condition created today inherits the healed
         TEMPLATE, so it proves nothing about the files that already exist —
         their hint was COPIED at creation and only db/664 can reach it. Stage
         the pre-migration shape and replay the migration, which is what every
         boot does. */
      const OLD_HINT = 'A current statement on the loan being paid off. Three ways to satisfy it: the '
        + 'statement itself; the payoff figures typed in — outstanding balance, servicer AND loan '
        + 'number, all three, none of them optional; or a waiver where the loan being refinanced is '
        + 'one of our own short-term loans serviced by FCI, where we already hold everything a '
        + 'statement would say.';
      const stale = await makeLoan('f');
      const staleCond = await conditionOn(stale, 'lt_subject_mortgage_statement');
      const HAND_EDITED = 'Ask Malky — she keeps the FCI numbers.';
      const edited = await makeLoan('f2');
      const editedCond = await conditionOn(edited, 'lt_subject_mortgage_statement');
      await cx.query(`UPDATE checklist_items SET hint = $2 WHERE id = $1::uuid`, [staleCond.id, OLD_HINT]);
      await cx.query(`UPDATE checklist_items SET hint = $2 WHERE id = $1::uuid`, [editedCond.id, HAND_EDITED]);
      /* The guard text is not typed here twice: if db/664 does not carry this
         exact string, the row below is not healed and the assertion says so. */
      await cx.query(fs.readFileSync(MIGRATION, 'utf8'));
      const authored = (typeof lib.library === 'function' ? lib.library() : lib.library)
        .find((x) => x && x.code === 'lt_subject_mortgage_statement').hint;
      const healed = (await cx.query(
        `SELECT hint FROM checklist_items WHERE id = $1::uuid`, [staleCond.id])).rows[0].hint;
      ok(healed === authored,
        'a file that already promised a waiver is re-worded on the next boot',
        healed === authored ? '' : String(healed).slice(0, 90));
      const kept = (await cx.query(
        `SELECT hint FROM checklist_items WHERE id = $1::uuid`, [editedCond.id])).rows[0].hint;
      ok(kept === HAND_EDITED,
        '…while a note somebody re-worded by hand is left exactly as they wrote it', kept);
      const before = healed;
      await cx.query(fs.readFileSync(MIGRATION, 'utf8'));
      await cx.query(fs.readFileSync(MIGRATION, 'utf8'));
      ok((await cx.query(`SELECT hint FROM checklist_items WHERE id = $1::uuid`,
        [staleCond.id])).rows[0].hint === before,
        '…and two more replays change nothing — every boot runs it again');
    }


    // ── G. THE LETTERHEAD CASE — refused without the AI, grounded with it ────
    console.log('\nG. A SERVICER PRINTED ONLY ON THE LETTERHEAD');
    {
      const g1 = await makeLoan('g1');
      const c1 = await conditionOn(g1, 'lt_subject_mortgage_statement');
      const r1 = await reader.fillFromUpload(
        { loanId: g1, conditionId: c1.id, code: reader.CODE, documentId: crypto.randomUUID(), storageRef: 'ref' },
        deps(LETTERHEAD));
      /* NEVER A GUESS. Our scanner will not decide that the first line of a
         document is the company, so with no AI configured it fills NOTHING and
         says which of the three it could not read — the person types it, which
         is a great deal better than a wrong servicer on a payoff. */
      ok(r1.filled === false && r1.why === 'unreadable',
        'with no AI configured it refuses rather than reading the top line as the servicer', r1.why);
      ok(/servicer/i.test(String(r1.detail || '')),
        '…and it names the servicer as the thing it could not read', String(r1.detail));
      const a1 = await answerOf(c1.id);
      ok(a1 == null || !a1.values,
        '…and nothing at all is written to the condition', JSON.stringify(a1));

      const g2 = await makeLoan('g2');
      const c2 = await conditionOn(g2, 'lt_subject_mortgage_statement');
      const pointer = {
        available: () => true,
        extract: async () => ({ ok: true, data: { servicer: 'FCI Lender Services, Inc.' } }),
      };
      const r2 = await reader.fillFromUpload(
        { loanId: g2, conditionId: c2.id, code: reader.CODE, documentId: crypto.randomUUID(), storageRef: 'ref' },
        deps(LETTERHEAD, pointer));
      ok(r2.filled === true,
        'an AI that POINTS at a name printed on the statement completes the reading', r2.detail || r2.why || '');
      ok(r2.usedAi === true, '…and the answer records that PILOT read the document');
      const a2 = await answerOf(c2.id);
      ok(a2 && /FCI Lender Services/i.test(String(a2.values.servicer || '')),
        '…with the servicer it pointed at');
      ok(a2 && Number(a2.values.outstanding_balance) === 318442.19,
        '…while the two NUMBERS still come from our own scanner, not from the AI');

      const g3 = await makeLoan('g3');
      const c3 = await conditionOn(g3, 'lt_subject_mortgage_statement');
      const inventor = {
        available: () => true,
        extract: async () => ({ ok: true, data: { servicer: 'Nationstar Mortgage LLC' } }),
      };
      const r3 = await reader.fillFromUpload(
        { loanId: g3, conditionId: c3.id, code: reader.CODE, documentId: crypto.randomUUID(), storageRef: 'ref' },
        deps(LETTERHEAD, inventor));
      /* THE WHOLE GROUNDING RULE, AT THE DOOR: a name that is NOT printed on the
         statement cannot become the servicer, however confidently it is offered.
         Nothing is filled, so nobody is handed a payoff addressed to the wrong
         company. */
      ok(r3.filled === false,
        'a servicer the AI invented never reaches the condition', r3.why || '');
      const a3 = await answerOf(c3.id);
      ok(a3 == null || !a3.values,
        '…and the invented name is nowhere in the file', JSON.stringify(a3));
    }

    await cx.query('ROLLBACK');
  } catch (e) {
    failed = true;
    console.error('\nCRASHED:', (e && e.stack) || e);
    try { await cx.query('ROLLBACK'); } catch (_) {}
  } finally {
    cx.release();
    await db.pool.end();
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  process.exit(failed || fails.length ? 1 : 0);
})();

#!/usr/bin/env node
/**
 * TWO CONDITIONS, ONE CLICK — the subject-property mortgage, end to end.
 *
 * Owner-directed 2026-08-31: *"If you click that button then it links to subject
 * property and then the mortgage for subject property condition … The condition
 * that pops up that you need a mortgage statement for subject property should
 * automatically be selected to fill in the information manually … It should
 * satisfy two things at once, one line item of the REO … and it satisfies the
 * condition for the mortgage statement for subject property."*
 *
 * REAL POSTGRES, because everything that can go wrong here is invisible to a
 * unit test: whether the loan's PURPOSE is really read off the row, whether the
 * fill really lands on the OTHER condition, whether it survives the sign-off
 * gate, and whether it can be undone without taking a person's own answer with
 * it. `answers.js` is proven pure in `test-lt-reo-subject-property-pure.js`;
 * this suite is about the wiring, which no pure test can see.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

(async () => {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-reo-subject-cross-fill');
  const crypto = require('crypto');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const write = require('../src/longterm/conditions-center/write.js');
  const workspace = require('../src/longterm/conditions-center/workspace.js');

  await ensureSchema();
  await lib.ensureSeeded(db);            // TAKES THE CLIENT, never { db }

  const tag = `reosub${Date.now()}`;

  /** A whole Long-Term file with one mortgage on its credit report. */
  const makeFile = async (purpose) => {
    const borrower = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Reo','Probe',$1) RETURNING id`,
      [`${tag}.${purpose}@example.test`])).rows[0].id;
    const loan = crypto.randomUUID();
    await db.query(
      `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose)
       VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr',$4::lt_loan_purpose)`,
      [loan, borrower, `REOSUB-${tag}-${purpose}`, purpose]);
    await db.query(
      `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
       VALUES ($1::uuid,'9 Subject Ln','Newark','NJ','07101',1,'SFR')`, [loan]);

    const pair = (await db.query(
      `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES ($1::uuid,$2::uuid,1) RETURNING id`,
      [crypto.randomUUID(), loan])).rows[0].id;
    const party = (await db.query(
      `INSERT INTO lt_parties (id, pair_id, role, party_type, first_name, last_name)
       VALUES ($1::uuid,$2::uuid,'borrower','individual','Reo','Probe') RETURNING id`,
      [crypto.randomUUID(), pair])).rows[0].id;

    const liab = async (creditor, last4, balance, type) => (await db.query(
      `INSERT INTO lt_liabilities (id, party_id, section, liability_type, creditor_name, account_last4, unpaid_balance)
       VALUES ($1::uuid,$2::uuid,'debts',$3,$4,$5,$6) RETURNING id`,
      [crypto.randomUUID(), party, type, creditor, last4, balance])).rows[0].id;

    const subjectLoan = await liab('Wells Fargo Home Mortgage', '4776', 312500.55, 'Mortgage');
    const otherLoan = await liab('Chase Mortgage', '1120', 180000, 'Mortgage');

    await engine.evaluateLoan(loan, { db });
    const cond = async (code) => (await db.query(
      `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.lt_loan_id = $1::uuid AND t.code = $2`, [loan, code])).rows[0];
    return {
      loan,
      reo: await cond('lt_reo_liabilities'),
      subject: await cond('lt_subject_mortgage_statement'),
      keys: { subjectLoan: `liab:${subjectLoan}`, otherLoan: `liab:${otherLoan}` },
    };
  };

  const payloadOf = async (id) => (await db.query(
    'SELECT tool_payload, notes FROM checklist_items WHERE id=$1::uuid', [id])).rows[0];

  try {
    console.log('\nA. A REFINANCE FILE CARRIES BOTH CONDITIONS');
    const refi = await makeFile('cash_out_refinance');
    check(!!refi.reo, 'the mortgages-on-the-credit-report condition is on the file');
    check(!!refi.subject, 'and the subject-property mortgage statement condition is too');
    if (!refi.reo || !refi.subject) throw new Error('fixture did not produce both conditions');

    console.log('\nB. THE OPTION IS OFFERED HERE AND NOT ON A PURCHASE');
    const wsRefi = await workspace.forCondition(refi.loan, refi.reo.id, { db });
    check(wsRefi && wsRefi.shape === 'per_line', 'the REO condition opens as a per-line workspace');
    check(wsRefi.ways.some((w) => w.key === 'subject_property'),
      'and offers "this is the mortgage on the subject property"');
    check(wsRefi.lines.length === 2, `both mortgages are listed (${wsRefi.lines.length})`);

    const purchase = await makeFile('purchase');
    const wsBuy = await workspace.forCondition(purchase.loan, purchase.reo.id, { db });
    check(!wsBuy.ways.some((w) => w.key === 'subject_property'),
      'a PURCHASE is not offered it — there is no loan being refinanced');
    check(!purchase.subject,
      'and the subject-property statement condition is not on a purchase at all (the engine never attached one)');

    console.log('\nC. THE DOOR REFUSES IT ON A PURCHASE — the screen is not the guard');
    const posted = await write.recordAnswer(purchase.loan, purchase.reo.id, {
      mortgages: [{ key: purchase.keys.subjectLoan, label: 'Wells' }],
      lines: { [purchase.keys.subjectLoan]: { way: 'subject_property' } },
    }, null, db);
    check(posted.ok === false && posted.status === 422,
      `posted from a stale tab, it is refused (${posted.status})`);
    check(/refinance/i.test(posted.error || ''), `and says why ("${posted.error}")`);
    const untouched = await payloadOf(purchase.reo.id);
    check(!untouched.tool_payload || !untouched.tool_payload.lines,
      'and nothing was written on the refusal');

    console.log('\nD. ONE CLICK FILLS THE OTHER CONDITION IN');
    const before = await payloadOf(refi.subject.id);
    check(!before.tool_payload || !before.tool_payload.way,
      'the statement condition starts with no answer');

    const saved = await write.recordAnswer(refi.loan, refi.reo.id, {
      mortgages: [
        { key: refi.keys.subjectLoan, label: 'Wells Fargo Home Mortgage ····4776' },
        { key: refi.keys.otherLoan, label: 'Chase Mortgage ····1120' },
      ],
      lines: {
        [refi.keys.subjectLoan]: { way: 'subject_property' },
        [refi.keys.otherLoan]: { way: 'primary' },
      },
    }, null, db);
    check(saved.ok === true, `the REO answer records (${saved.ok ? 'ok' : saved.error})`);
    check(saved.subjectMortgage && saved.subjectMortgage.filled === true,
      'and it reports that the statement condition was filled in');
    check(typeof (saved.subjectMortgage || {}).note === 'string',
      'in words, so the person is told a SECOND condition just moved');

    const after = await payloadOf(refi.subject.id);
    const a = after.tool_payload || {};
    check(a.way === 'typed', 'the statement condition is on the TYPED way — auto-selected, as asked');
    check(a.values.servicer === 'Wells Fargo Home Mortgage', 'the servicer came off the credit report');
    check(Number(a.values.outstanding_balance) === 312500.55,
      `the outstanding balance came across to the cent (${a.values.outstanding_balance})`);
    check(a.values.loan_number === '4776', 'and the loan number is what the report carries');
    check(a.loanNumberIsLastFour === true && a.source === 'credit_report',
      'MARKED as coming from the credit report, and as last-four-digits only');
    check(/credit report/i.test(after.notes || '') && /LAST FOUR/i.test(after.notes || ''),
      'and the condition itself carries the mark in its notes — the one place it is read a year later');

    console.log('\nE. IT REALLY SATISFIES BOTH — the gate says so');
    const reoGate = write.signOffProblem(
      ...(await (async () => {
        const f = await write.loadCondition(refi.loan, refi.reo.id, db);
        return [f.condition, f.files, { readFailed: f.readFailed, entity: f.entity }];
      })()),
    );
    check(reoGate.ok === true, `the REO condition signs off (${reoGate.ok ? 'ok' : reoGate.why})`);
    const subjGate = await (async () => {
      const f = await write.loadCondition(refi.loan, refi.subject.id, db);
      return write.signOffProblem(f.condition, f.files, { readFailed: f.readFailed, entity: f.entity });
    })();
    check(subjGate.ok === true,
      `and so does the statement condition, with no document at all (${subjGate.ok ? 'ok' : subjGate.why})`);

    console.log('\nF. TWO LINES CANNOT BOTH BE THE SUBJECT PROPERTY');
    const both = await write.recordAnswer(refi.loan, refi.reo.id, {
      lines: {
        [refi.keys.subjectLoan]: { way: 'subject_property' },
        [refi.keys.otherLoan]: { way: 'subject_property' },
      },
    }, null, db);
    check(both.ok === false && both.status === 422, `refused (${both.status})`);
    check(/one mortgage/i.test(both.error || ''), `and says why ("${both.error}")`);
    const stillOne = await payloadOf(refi.reo.id);
    check(stillOne.tool_payload.lines[refi.keys.otherLoan].way === 'primary',
      'the earlier answer was not disturbed by the refusal');

    console.log('\nG. UN-MARKING IT TAKES THE FILL BACK OUT');
    const undone = await write.recordAnswer(refi.loan, refi.reo.id, {
      lines: { [refi.keys.subjectLoan]: { way: 'primary' } },
    }, null, db);
    check(undone.ok === true, 'the line can be answered a different way');
    check(undone.subjectMortgage && undone.subjectMortgage.cleared === true,
      'and the figures filled in from it are retracted — an answer sourced from a line nobody claims any more');
    const gone = await payloadOf(refi.subject.id);
    check(!gone.tool_payload || !gone.tool_payload.way, 'the statement condition is empty again');

    console.log('\nH. A PERSON\'S OWN ANSWER IS NEVER OVERWRITTEN');
    await db.query(
      `UPDATE checklist_items SET tool_payload = $2::jsonb WHERE id = $1::uuid`,
      [refi.subject.id, JSON.stringify({
        way: 'typed',
        values: { servicer: 'Typed By A Human', outstanding_balance: 1, loan_number: '999888777' },
      })]);
    const clash = await write.recordAnswer(refi.loan, refi.reo.id, {
      lines: { [refi.keys.subjectLoan]: { way: 'subject_property' } },
    }, null, db);
    check(clash.ok === true, 'the REO answer still records');
    check(clash.subjectMortgage && !clash.subjectMortgage.filled && /already has an answer/i.test(clash.subjectMortgage.why || ''),
      `and the statement condition is LEFT ALONE, and says so ("${(clash.subjectMortgage || {}).why}")`);
    const human = await payloadOf(refi.subject.id);
    check(human.tool_payload.values.loan_number === '999888777',
      'the full loan number somebody typed survives — four digits off a credit report never replaces it');

    console.log('\nI. A CREDIT REPORT SHORT OF A FIGURE FILLS IN NOTHING');
    await db.query(`UPDATE checklist_items SET tool_payload = '{}'::jsonb WHERE id = $1::uuid`, [refi.subject.id]);
    await db.query(
      `UPDATE lt_liabilities SET unpaid_balance = NULL WHERE id = $1::uuid`,
      [refi.keys.subjectLoan.replace('liab:', '')]);
    const thin = await write.recordAnswer(refi.loan, refi.reo.id, {
      lines: { [refi.keys.subjectLoan]: { way: 'subject_property' } },
    }, null, db);
    check(thin.ok === true, 'the REO line still records — the person answered it truthfully');
    check(!thin.subjectMortgage.filled && /outstanding balance/i.test(thin.subjectMortgage.why || ''),
      `and the statement condition is not half-filled, and says which figure was missing ("${(thin.subjectMortgage || {}).why}")`);
    const empty = await payloadOf(refi.subject.id);
    check(!empty.tool_payload || !empty.tool_payload.way,
      'nothing was written — a partial answer reads as a complete one to whoever keys it in');
  } finally {
    await db.query(`DELETE FROM lt_loans WHERE loan_number LIKE $1`, [`REOSUB-${tag}%`]).catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll good.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

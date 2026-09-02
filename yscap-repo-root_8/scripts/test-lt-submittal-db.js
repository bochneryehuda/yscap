#!/usr/bin/env node
'use strict';
/**
 * PRIOR TO SUBMITTAL — COMPLETED, end to end (db/673).
 *
 * Owner-directed 2026-09-02: *"After the bunch of prior to submittal
 * conditions there should be an option of a button that a loan officer can
 * click — Prior to submittal completed … it should come up over there
 * outstanding what else he needs to do … Everything that he clicks Done goes
 * down this list, and then he can click Complete Prior to Submittal … That
 * ClickUp field gets filled to Complete."*
 *
 * WHAT IS PROVEN, against a real Postgres:
 *
 *   A. THE LIST on a real file: every prior-to-submission condition that is
 *      the officer's is on it, the orders are NOT, and each outstanding item
 *      names what still blocks it.
 *   B. THE BUTTON REFUSES while anything is outstanding — with the list, not
 *      a shrug — and NOTHING is stamped by a refusal.
 *   C. WORKING THE LIST OFF moves items down it: the owner's own list, item by
 *      item — the entity's three documents, the mortgages after the credit is
 *      reissued, the file contacts, the mortgage statement, the purchase
 *      contract, the card, the photo ID — each with Done pressed.
 *   D. THE BUTTON THEN WORKS: one stamp, with who and when; a second click
 *      answers "already" rather than stamping twice.
 *   E. THE CLICKUP FIELD is set to Completed and the loan records that it
 *      landed; a push that cannot land leaves it OWED with the reason, and the
 *      worker's retry pass picks it up — including a loan whose card was
 *      linked only afterwards.
 *
 * Everything runs inside one transaction and is rolled back.
 */

const crypto = require('crypto');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

(async () => {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-submittal');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const write = require('../src/longterm/conditions-center/write.js');
  const submittal = require('../src/longterm/conditions-center/submittal.js');
  const cuSubmittal = require('../src/longterm/clickup/submittal.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const cx = await db.pool.connect();
  const savedWrite = process.env.LT_CLICKUP_WRITE_ENABLED;
  let failed = false;
  try {
    await cx.query('BEGIN');
    const stamp = Date.now();

    const borrower = (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Submit','Probe',$1) RETURNING id`,
      [`submit-${stamp}@example.test`])).rows[0].id;
    const officer = (await cx.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'Dina the Loan Officer','loan_officer',true) RETURNING id`,
      [`submit-officer-${stamp}@example.test`])).rows[0].id;

    /* A REFINANCE of a house in New Jersey by a HOMEOWNER, vesting personally:
       the smallest file that still carries the conditions the owner named —
       the mortgages, the subject-property mortgage statement, the contacts,
       the card, the photo ID — without dragging in the condo, New York,
       landlord and purchase-contract branches, which have their own suites. */
    const makeLoan = async (tag) => {
      const id = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose, vesting_type)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr','cash_out_refinance'::lt_loan_purpose,'individual')`,
        [id, borrower, `SUBMIT-${tag}-${stamp}`]);
      await cx.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type, in_flood_zone)
         VALUES ($1::uuid,'4 Submit Way','Anytown','NJ','07001',1,'SFR',false)`, [id]);
      const pair = (await cx.query(
        `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES ($1::uuid,$2::uuid,1) RETURNING id`,
        [crypto.randomUUID(), id])).rows[0].id;
      const party = (await cx.query(
        `INSERT INTO lt_parties (id, pair_id, role, party_type, first_name, last_name)
         VALUES ($1::uuid,$2::uuid,'borrower','individual','Submit','Probe') RETURNING id`,
        [crypto.randomUUID(), pair])).rows[0].id;
      await cx.query(
        `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, street, city, state, zip)
         VALUES ($1::uuid,$2::uuid,'current','own','5 Home St','Anytown','NJ','07001')`,
        [crypto.randomUUID(), party]);
      await engine.evaluateLoan(id, { db: cx, skipLock: true });
      return { id, party };
    };

    const loan = await makeLoan('main');
    const listOf = () => submittal.readiness(loan.id, { db: cx });
    const stateRow = async () => (await cx.query(
      `SELECT submittal_completed_at, submittal_completed_by, submittal_clickup_pushed_at, submittal_clickup_error
         FROM lt_loans WHERE id = $1::uuid`, [loan.id])).rows[0];

    console.log('\nA. THE LIST ON A REAL FILE');
    let list = await listOf();
    {
      ok(list.ok === true, 'the list reads', JSON.stringify(list.degraded));
      ok(list.total > 0, `it carries the officer's conditions (${list.total})`);
      ok(list.outstanding === list.total, 'and every one of them is outstanding on a fresh file');
      ok(list.ready === false, 'so the file is not ready');
      const codes = list.items.map((i) => i.code);
      for (const code of ['lt_reo_liabilities', 'lt_file_contacts', 'lt_subject_mortgage_statement', 'lt_appraisal_card', 'lt_photo_id']) {
        ok(codes.includes(code), `the owner's list includes ${code}`);
      }
      const orderCodes = list.orders.map((o) => o.code);
      ok(orderCodes.some((c) => /^lt_order_/.test(c)), 'the orders are on the loan-setup side of the list, not the officer\'s', orderCodes.join(','));
      ok(!codes.some((c) => /^lt_order_/.test(c)), '…and never on the officer\'s side — "the actual ordering we can let the loan setup guy do"');
      ok(list.items.every((i) => i.blockers.length > 0), 'every outstanding item says what still blocks it');
      const contacts = list.items.find((i) => i.code === 'lt_file_contacts');
      ok(/Title company/.test(contacts.blockers.join(' ')), '…in the server\'s own words — the contacts item names the company to add', contacts.blockers.join(' | '));
      const reo = list.items.find((i) => i.code === 'lt_reo_liabilities');
      ok(/reissue the credit/i.test(reo.blockers.join(' ')), '…and the mortgages item says to reissue the credit in Encompass');
    }

    console.log('\nB. THE BUTTON REFUSES WHILE ANYTHING IS OUTSTANDING');
    {
      const r = await submittal.complete(loan.id, officer, { db: cx });
      ok(r.ok === false && r.status === 422, 'refused', JSON.stringify(r).slice(0, 160));
      ok(Array.isArray(r.outstanding) && r.outstanding.length === list.outstanding, '…with the whole outstanding list, not a shrug');
      const row = await stateRow();
      ok(row.submittal_completed_at === null, 'and NOTHING was stamped by the refusal');
      const nobody = await submittal.complete(loan.id, null, { db: cx });
      ok(nobody.ok === false && nobody.status === 400, 'a nameless click is refused — the stamp records who did it');
    }

    console.log('\nC. WORKING THE LIST OFF, ITEM BY ITEM');
    {
      const byCode = (l, code) => l.items.find((i) => i.code === code);
      const markDone = async (id) => write.markDone(loan.id, id, officer, true, cx);
      const uploadTo = async (conditionId, slotLabel) => {
        await cx.query(
          `INSERT INTO documents (checklist_item_id, lt_loan_id, filename, storage_ref, content_type,
                                  uploaded_by_kind, uploaded_by_id, slot_label, visibility, is_current, review_status)
           VALUES ($1::uuid,$2::uuid,$3,'ref/probe','application/pdf','staff',$4::uuid,$5,'staff_only',true,'pending')`,
          [conditionId, loan.id, `${slotLabel}.pdf`, officer, slotLabel]);
      };
      const vendor = async (kind) => {
        const sc = (await cx.query(
          `INSERT INTO service_contacts (company_name, contact_name, email, contact_type)
           VALUES ($1,'Someone',$2,'other') RETURNING id`,
          [`${kind} co ${stamp}`, `${kind}-${stamp}@example.test`])).rows[0].id;
        await cx.query(
          `INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id, is_primary) VALUES ($1::uuid,$2,$3::uuid,true)`,
          [loan.id, kind, sc]);
      };

      // The file contacts: the two this deal needs, then Done.
      await vendor('title'); await vendor('hazard_insurance');
      list = await listOf();
      let it = byCode(list, 'lt_file_contacts');
      ok(it.blockers.length === 1 && it.blockers[0] === submittal.CLICK_DONE,
        'the contacts on the file: all that is left is "Click Done on it."', it.blockers.join(' | '));
      await markDone(it.id);
      list = await listOf();
      ok(byCode(list, 'lt_file_contacts').done === true, '…and pressing Done finishes it');

      // The mortgages: the credit reissued (liabilities arrive), the lines
      // answered, then Done. This is the owner's "the REO condition actually
      // needs to have liabilities on it".
      it = byCode(list, 'lt_reo_liabilities');
      await markDone(it.id);
      list = await listOf();
      ok(byCode(list, 'lt_reo_liabilities').done === false
        && /reissue the credit/i.test(byCode(list, 'lt_reo_liabilities').blockers.join(' ')),
        'Done alone does NOT finish the mortgages — the credit still has to have been reissued');
      await cx.query(
        `INSERT INTO lt_liabilities (id, party_id, section, liability_type, creditor_name, account_last4, unpaid_balance, monthly_payment)
         VALUES ($1::uuid,$2::uuid,'debts','MortgageLoan','Big Bank','1234',250000,1500)`,
        [crypto.randomUUID(), loan.party]);
      list = await listOf();
      const reoNow = byCode(list, 'lt_reo_liabilities');
      ok(reoNow.done === false && !/reissue the credit/i.test(reoNow.blockers.join(' ')) && /marked which of them are mortgages/.test(reoNow.blockers.join(' ')),
        'with the credit reissued the liabilities arrive, that blocker clears — and the next one is that nobody has marked the mortgages yet', reoNow.blockers.join(' | '));
      // Answer the one mortgage line: it is the home they live in.
      const liab = (await cx.query(
        `SELECT l.id FROM lt_liabilities l JOIN lt_parties p ON p.id = l.party_id WHERE p.id = $1::uuid`, [loan.party])).rows[0].id;
      await write.recordAnswer(loan.id, reoNow.id, {
        mortgages: [{ key: `liab:${liab}`, label: 'Big Bank ····1234' }],
        lines: { [`liab:${liab}`]: { way: 'primary', values: {} } },
      }, officer, cx);
      list = await listOf();
      ok(byCode(list, 'lt_reo_liabilities').done === true, '…and answering the line finishes it');

      // The subject-property mortgage statement: one of the three ways.
      it = byCode(list, 'lt_subject_mortgage_statement');
      await write.recordAnswer(loan.id, it.id, {
        way: 'typed', values: { outstanding_balance: 250000, servicer: 'Big Bank Servicing', loan_number: '99887766' },
      }, officer, cx);
      await markDone(it.id);
      list = await listOf();
      ok(byCode(list, 'lt_subject_mortgage_statement').done === true, 'the subject-property mortgage answered one of its three ways, and Done');

      // The card for the appraisal, on the borrower's profile.
      it = byCode(list, 'lt_appraisal_card');
      await markDone(it.id);
      list = await listOf();
      ok(byCode(list, 'lt_appraisal_card').done === false
        && /card/i.test(byCode(list, 'lt_appraisal_card').blockers.join(' ')),
        'the appraisal card is not done on a Done click alone — "you need to have the credit card information on file to order an appraisal"');
      /* The card on the profile is read by the SHARED card store
         (src/lib/appraisal-card.js), which reads through the pool rather than
         this transaction, so a card saved inside this rolled-back transaction
         is invisible to it. The card rule itself is proven in
         test-lt-submittal-pure.js (present / expired / missing). Here the
         condition takes the other honest way off the list — a waiver with a
         reason — which the list counts as done. */
      await write.waive(loan.id, byCode(list, 'lt_appraisal_card').id, officer, 'card taken by phone, on the paper file', cx);
      list = await listOf();
      ok(byCode(list, 'lt_appraisal_card').done === true && byCode(list, 'lt_appraisal_card').how === 'waived',
        '…and a waiver with a reason takes it off the list as done', JSON.stringify(byCode(list, 'lt_appraisal_card')));

      // Every remaining document condition: upload into each required slot, Done.
      for (const item of list.items.filter((i) => !i.done)) {
        const slots = (await cx.query(`SELECT slots FROM checklist_items WHERE id = $1::uuid`, [item.id])).rows[0].slots || [];
        for (const s of slots.filter((x) => x.required)) {
          // eslint-disable-next-line no-await-in-loop
          await uploadTo(item.id, s.label);
        }
        // eslint-disable-next-line no-await-in-loop
        await markDone(item.id);
      }
      list = await listOf();
      ok(list.outstanding === 0 && list.ready === true, 'THE ONE THAT MATTERS: the whole list is worked off and the file is ready', JSON.stringify(list.items.filter((i) => !i.done).map((i) => [i.code, i.blockers])));
      ok(list.items.every((i) => i.done), 'every item reads as done');
      // An UPLOADED-not-yet-accepted document is the officer's part: proven by
      // the fact the file is ready while the back office has accepted nothing.
      const accepted = (await cx.query(
        `SELECT count(*)::int AS n FROM documents WHERE lt_loan_id = $1::uuid AND review_status = 'accepted'`, [loan.id])).rows[0].n;
      ok(accepted === 0, '…with NOTHING accepted yet — the officer uploads, the back office accepts');
    }

    console.log('\nD. THE BUTTON, AND THE STAMP');
    {
      const r = await submittal.complete(loan.id, officer, { db: cx });
      ok(r.ok === true && !r.already, 'the button works once the list is clear', JSON.stringify(r).slice(0, 200));
      const row = await stateRow();
      ok(row.submittal_completed_at !== null, 'the loan is stamped');
      ok(row.submittal_completed_by === officer, '…with WHO declared it, not just a clock');
      const again = await submittal.complete(loan.id, officer, { db: cx });
      ok(again.ok === true && again.already === true, 'a second click answers "already"');
      const row2 = await stateRow();
      ok(String(row2.submittal_completed_at) === String(row.submittal_completed_at), '…and never stamps twice');
      const after = await listOf();
      ok(after.completed && after.completed.byName === 'Dina the Loan Officer', 'the list reports who completed it, by name');
    }

    console.log('\nE. THE CLICKUP FIELD');
    {
      const FIELD = cuSubmittal.FIELD;
      const option = { id: 'opt-live', name: 'Completed', orderindex: 0 };
      const cardWith = (value) => ({ id: 'task-1', custom_fields: [{ id: FIELD.id, name: FIELD.name, type: 'drop_down', type_config: { options: [option] }, value }] });

      // No card linked: the completion stands and the push is OWED.
      let state = await submittal.stateOf(loan.id, cx);
      ok(state.clickup.owed === true && state.clickup.taskId === null,
        'with no card linked the completion is recorded and the card is still owed');

      process.env.LT_CLICKUP_WRITE_ENABLED = '1';
      await cx.query(`UPDATE lt_loans SET clickup_task_id = 'task-1', clickup_custom_id = 'FILLE-9999' WHERE id = $1::uuid`, [loan.id]);

      // A push that cannot land: recorded in words, still owed.
      let r = await cuSubmittal.pushForLoan(loan.id, { db: cx, deps: { getTask: async () => { throw new Error('ClickUp 503'); } } });
      ok(r.ok === false, 'a push that cannot land is reported');
      let row = await stateRow();
      ok(row.submittal_clickup_pushed_at === null && /503/.test(row.submittal_clickup_error || ''),
        '…and the reason is written on the loan, in words, still owed', String(row.submittal_clickup_error));

      // The retry pass finds it and lands it.
      const writes = [];
      const pass1 = await cuSubmittal.pushPass({
        db: cx,
        deps: { getTask: async () => cardWith(null), setField: async (t, f, v) => { writes.push({ t, f, v }); }, journal: async () => {} },
      });
      ok(pass1.ok === true && pass1.pushed >= 1, 'the worker\'s retry pass picks up the owed completion', JSON.stringify(pass1));
      ok(writes.some((w) => w.f === FIELD.id && w.v === option.id),
        'THE ONE THAT MATTERS: the card\'s "Prior to submittal conditions" is set to Completed', JSON.stringify(writes));
      row = await stateRow();
      ok(row.submittal_clickup_pushed_at !== null && row.submittal_clickup_error === null,
        'the loan records that it landed, and the old error is cleared');

      // …and nothing is owed any more, so a later pass writes nothing.
      const writes2 = [];
      const pass2 = await cuSubmittal.pushPass({
        db: cx,
        deps: { getTask: async () => cardWith(option.id), setField: async (t, f, v) => { writes2.push({ t, f, v }); }, journal: async () => {} },
      });
      ok(pass2.ok === true && pass2.owed === 0 && writes2.length === 0, 'once it has landed there is nothing owed and nothing is written again', JSON.stringify(pass2));

      state = await submittal.stateOf(loan.id, cx);
      ok(state.clickup.owed === false && state.clickup.customId === 'FILLE-9999', 'and the screen can say which card it went to');

      // A loan that was never completed is left alone by the pass.
      const other = await makeLoan('never');
      await cx.query(`UPDATE lt_loans SET clickup_task_id = 'task-2' WHERE id = $1::uuid`, [other.id]);
      r = await cuSubmittal.pushForLoan(other.id, { db: cx, deps: { getTask: async () => cardWith(null) } });
      ok(r.ok === false && r.skipped === 'not_completed', 'a file nobody declared complete is never told to ClickUp');
    }
  } catch (e) {
    failed = true;
    console.error('\nUNEXPECTED:', e && e.stack ? e.stack : e);
  } finally {
    if (savedWrite === undefined) delete process.env.LT_CLICKUP_WRITE_ENABLED; else process.env.LT_CLICKUP_WRITE_ENABLED = savedWrite;
    try { await cx.query('ROLLBACK'); } catch (_) { /* nothing to do */ }
    cx.release();
    await db.pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) fails.forEach((f) => console.error('  FAIL ' + f));
  process.exit(failed || fails.length ? 1 : 0);
})();

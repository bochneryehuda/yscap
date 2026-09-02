#!/usr/bin/env node
'use strict';
/**
 * PRIOR TO SUBMITTAL — WHAT THE A-TO-Z WALK FOUND (2026-09-02), fixed and proven.
 *
 * An audit walked the officer's list on a real file and found the OFFICER'S OWN
 * ACTIONS not counting: the three entity documents filed on the company's
 * profile slots (the door the screen actually uses) read as missing; the ID
 * already on the borrower's profile read as missing; an upload with no slot
 * name never filled its slot; the per-line "upload a statement" way on the
 * mortgages condition had no writer at all; and a later upload silently wiped
 * the Done stamp. The adversarial review of the same branch found the
 * documents-read failure signing off the contacts condition with nothing on
 * the file, a loan that does not exist answered as an outage, and the rules
 * engine pinning two pool connections per pass.
 *
 * Every section below is one of those, reproduced against a real Postgres and
 * the real HTTP door where the defect lived there. Rows are created through the
 * pool (the HTTP door reads the pool) and deleted at the end.
 */

if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-submittal-audit-db (no DATABASE_URL)'); process.exit(0); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
process.env.STORAGE_DIR = process.env.STORAGE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-sub-audit-'));

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

(async () => {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-submittal-audit');
  const { ensureSchema } = require('../src/migrate-boot.js');
  await ensureSchema();
  const db = require('../src/db.js');
  const C = require('../src/lib/crypto');
  const lib = require('../src/longterm/conditions-center/library.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const write = require('../src/longterm/conditions-center/write.js');
  const submittal = require('../src/longterm/conditions-center/submittal.js');
  const entityProfile = require('../src/longterm/conditions-center/entity-profile.js');
  const app = require('../src/server');
  await lib.ensureSeeded(db);

  const uniq = `ltsa-${process.pid}-${Date.now()}`;
  const loans = [];
  let borrower = null;
  let staff = null;
  let server = null;
  let failed = false;
  try {
    staff = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'Submittal Audit Admin','super_admin',true) RETURNING id, token_version`,
      [`${uniq}@example.test`])).rows[0];
    const token = C.signJwt({ sub: String(staff.id), kind: 'staff', role: 'super_admin', tv: staff.token_version, sid: uniq });
    borrower = String((await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Audit','Probe',$1) RETURNING id`,
      [`${uniq}-b@example.test`])).rows[0].id);

    const makeLoan = async (tag, opts = {}) => {
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose, vesting_type, vesting_entity_name, borrower_name)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr',$4::lt_loan_purpose,$5,$6,'Audit Probe')`,
        [id, borrower, `${uniq}-${tag}`, opts.purpose || 'cash_out_refinance', opts.vestingType || 'individual', opts.entityName || null]);
      await db.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type, in_flood_zone)
         VALUES ($1::uuid,'4 Audit Way','Anytown','NJ','07001',1,'SFR',false)`, [id]);
      const pair = (await db.query(
        `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES ($1::uuid,$2::uuid,1) RETURNING id`,
        [crypto.randomUUID(), id])).rows[0].id;
      const party = (await db.query(
        `INSERT INTO lt_parties (id, pair_id, role, party_type, first_name, last_name)
         VALUES ($1::uuid,$2::uuid,'borrower','individual','Audit','Probe') RETURNING id`,
        [crypto.randomUUID(), pair])).rows[0].id;
      await db.query(
        `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, street, city, state, zip)
         VALUES ($1::uuid,$2::uuid,'current','own','5 Home St','Anytown','NJ','07001')`,
        [crypto.randomUUID(), party]);
      if (opts.evaluate !== false) await engine.evaluateLoan(id, { db });
      loans.push(id);
      return { id, party };
    };
    const itemOf = async (loanId, code) => (await db.query(
      `SELECT ci.id, ci.reviewed_at, ci.reviewed_by, ci.signed_off_at, ci.status, ci.slots
         FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.lt_loan_id = $1::uuid AND t.code = $2`, [loanId, code])).rows[0];
    const readiness = (loanId) => submittal.readiness(loanId, { db });
    const itemIn = (list, code) => list.items.find((i) => i.code === code);

    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const call = (method, p, body) => new Promise((resolve) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: '127.0.0.1', port, method, path: p,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      }, (res) => {
        let raw = ''; res.on('data', (d) => { raw += d; });
        res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (_) { /* not json */ } resolve({ status: res.statusCode, json, raw }); });
      });
      req.on('error', () => resolve({ status: 0, json: null, raw: '' }));
      if (payload) req.write(payload); req.end();
    });
    const cc = (loanId) => `/api/lt/condition-center/loans/${loanId}`;

    console.log('\nA. A DOCUMENTS-READ FAILURE NO LONGER SIGNS OFF THE CONTACTS CONDITION');
    {
      const cond = { id: 'x', code: 'lt_file_contacts', kind: 'form', status: 'outstanding', slots: [], is_required: true, answer: {}, config: { contactTypes: ['title'] } };
      const missing = { missing: [{ key: 'title', label: 'Title company' }], unreadable: false };
      const r = write.signOffProblem(cond, [], { readFailed: true, contacts: missing });
      ok(r.ok === false && /Title company/.test(r.why), 'with the documents unreadable, the contacts gate STILL refuses — it reads the vendors, not the documents', JSON.stringify(r));
      const r2 = write.signOffProblem(cond, [], { readFailed: true, contacts: { missing: [], unreadable: false } });
      ok(r2.ok === true && !!r2.checkSkipped, 'and with the contacts on the file the read failure is reported as a skipped document check', JSON.stringify(r2));
      const r3 = write.signOffProblem({ ...cond, code: 'lt_reo_liabilities' }, [], { readFailed: true, liabilities: { count: 0, unreadable: false } });
      ok(r3.ok === false && /reissue the credit/i.test(r3.why), 'the credit gate stands too', JSON.stringify(r3));
      const r4 = write.signOffProblem({ ...cond, code: 'lt_appraisal_card' }, [], { readFailed: true, card: { available: false, unreadable: false } });
      ok(r4.ok === false && /card/i.test(r4.why), 'and the card gate', JSON.stringify(r4));
    }

    console.log('\nB. THE ID ON THE BORROWER’S PROFILE COUNTS');
    const loanB = await makeLoan('photo');
    {
      const before = await readiness(loanB.id);
      ok(/Still waiting on: Photo ID/.test(itemIn(before, 'lt_photo_id').blockers.join(' ')), 'a fresh file waits on the photo ID');
      const doc = String((await db.query(
        `INSERT INTO documents (borrower_id, filename, content_type, size_bytes, storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, review_status, is_current)
         VALUES ($1::uuid,'licence.pdf','application/pdf',3,'local','ref/probe','staff',$2::uuid,'pending',true) RETURNING id`,
        [borrower, staff.id])).rows[0].id);
      await db.query(`UPDATE borrowers SET photo_id_document_id = $2::uuid WHERE id = $1::uuid`, [borrower, doc]);
      let list = await readiness(loanB.id);
      let it = itemIn(list, 'lt_photo_id');
      ok(it.blockers.length === 1 && it.blockers[0] === submittal.CLICK_DONE, 'with an ID on the profile (still pending) the officer’s only step is Done', it.blockers.join(' | '));
      await write.markDone(loanB.id, it.id, staff.id, true, db);
      list = await readiness(loanB.id);
      ok(itemIn(list, 'lt_photo_id').done === true, '…and Done finishes it, with nothing uploaded onto this loan');
      const back = await write.satisfy(loanB.id, it.id, staff.id, db);
      ok(back.ok === false && /Still waiting on: Photo ID/.test(back.error || ''), 'the BACK OFFICE still cannot sign it off while that ID is only pending', JSON.stringify(back));
      await db.query(`UPDATE documents SET review_status = 'rejected' WHERE id = $1::uuid`, [doc]);
      list = await readiness(loanB.id);
      ok(/Still waiting on: Photo ID/.test(itemIn(list, 'lt_photo_id').blockers.join(' ')) && !itemIn(list, 'lt_photo_id').done,
        'a REJECTED profile ID counts for nobody — the item goes back to waiting, Done or not', itemIn(list, 'lt_photo_id').blockers.join(' | '));
      await db.query(`UPDATE documents SET review_status = 'accepted' WHERE id = $1::uuid`, [doc]);
      const back2 = await write.satisfy(loanB.id, it.id, staff.id, db);
      ok(back2.ok === true, '…and the back office CAN sign it off once the profile’s ID is accepted', JSON.stringify(back2));
      await db.query(`UPDATE borrowers SET photo_id_document_id = NULL WHERE id = $1::uuid`, [borrower]);
    }

    console.log('\nC. THE COMPANY’S DOCUMENTS ON THE PROFILE COUNT FOR THE OFFICER');
    const loanC = await makeLoan('entity', { vestingType: 'Officer', entityName: `${uniq} Holdings LLC` });
    {
      const put = await entityProfile.putOnProfile(loanC.id, { db, actorId: staff.id });
      ok(put.ok === true && !!put.llcId, 'the company goes on the profile', JSON.stringify(put));
      await entityProfile.afterPutOnProfile(put.llcId);
      const slots = (await db.query(
        `SELECT ci.id, t.code FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id AND t.scope = 'llc'
          WHERE ci.llc_id = $1::uuid`, [put.llcId])).rows;
      const want = { rtl_llc_formation: 'articles.pdf', rtl_llc_opagmt: 'operating-agreement.pdf', rtl_llc_ein: 'ein.pdf' };
      const docIds = {};
      for (const [code, filename] of Object.entries(want)) {
        const s = slots.find((x) => x.code === code);
        ok(!!s, `the profile carries the ${code} slot`);
        // eslint-disable-next-line no-await-in-loop
        docIds[code] = String((await db.query(
          `INSERT INTO documents (llc_id, checklist_item_id, filename, content_type, size_bytes, storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, review_status, is_current)
           VALUES ($1::uuid,$2::uuid,$3,'application/pdf',3,'local','ref/probe','staff',$4::uuid,'pending',true) RETURNING id`,
          [put.llcId, s.id, filename, staff.id])).rows[0].id);
      }
      let list = await readiness(loanC.id);
      let it = itemIn(list, 'lt_vesting_entity');
      ok(!!it, 'the entity condition is on the list');
      ok(it.blockers.length === 1 && it.blockers[0] === submittal.CLICK_DONE,
        'THE ONE THAT MATTERS: the three documents on the COMPANY’S slots (pending) leave the officer only Done', it.blockers.join(' | '));
      await write.markDone(loanC.id, it.id, staff.id, true, db);
      list = await readiness(loanC.id);
      ok(itemIn(list, 'lt_vesting_entity').done === true, '…and Done finishes it');
      const back = await write.satisfy(loanC.id, it.id, staff.id, db);
      ok(back.ok === false, 'the BACK OFFICE still cannot sign it off — the company is not verified and nothing is on the condition itself', JSON.stringify(back));
      await db.query(`UPDATE documents SET review_status = 'rejected' WHERE id = $1::uuid`, [docIds.rtl_llc_ein]);
      list = await readiness(loanC.id);
      ok(/EIN letter/.test(itemIn(list, 'lt_vesting_entity').blockers.join(' ')) && !itemIn(list, 'lt_vesting_entity').done,
        'a rejected EIN letter on the profile puts the item back, naming that slot', itemIn(list, 'lt_vesting_entity').blockers.join(' | '));
    }

    console.log('\nD. AN UPLOAD NAMES ITS SLOT, AND NEVER WIPES THE OFFICER’S DONE');
    const loanD = await makeLoan('upload', { purpose: 'purchase' });
    {
      const it = await itemOf(loanD.id, 'lt_purchase_contract');
      ok(!!it, 'the purchase file carries the executed-contract condition');
      await write.markDone(loanD.id, it.id, staff.id, true, db);
      await db.query(`UPDATE checklist_items SET signed_off_at = now(), signed_off_by = $2::uuid WHERE id = $1::uuid`, [it.id, staff.id]);
      const up = await call('POST', `${cc(loanD.id)}/conditions/${it.id}/documents`, {
        filename: 'contract.pdf', contentType: 'application/pdf', slot: 'Executed contract',
        dataBase64: Buffer.from('%PDF-1.4 contract ' + uniq).toString('base64'),
      });
      ok(up.status === 201, `the upload door files the document (got ${up.status} ${up.raw.slice(0, 120)})`);
      const doc = (await db.query(`SELECT slot_label FROM documents WHERE id = $1::uuid`, [up.json && up.json.documentId])).rows[0];
      ok(doc && doc.slot_label === 'Executed contract', 'filed under the slot the screen named', JSON.stringify(doc));
      const after = await itemOf(loanD.id, 'lt_purchase_contract');
      ok(after.reviewed_at !== null && String(after.reviewed_by) === String(staff.id), 'THE ONE THAT MATTERS: the officer’s Done stamp survives their own upload');
      ok(after.signed_off_at === null, '…while the back office’s SIGN-OFF is still dropped — a new document is re-reviewed');
      const list = await readiness(loanD.id);
      ok(itemIn(list, 'lt_purchase_contract').done === true, 'so the item reads done: uploaded into its slot, and Done', JSON.stringify(itemIn(list, 'lt_purchase_contract')));
    }

    console.log('\nE. THE MORTGAGE LINE’S OWN SLOT CAN BE WRITTEN');
    const loanE = await makeLoan('liab');
    {
      const liab = crypto.randomUUID();
      await db.query(
        `INSERT INTO lt_liabilities (id, party_id, section, liability_type, creditor_name, account_last4, unpaid_balance, monthly_payment)
         VALUES ($1::uuid,$2::uuid,'debts','MortgageLoan','Big Bank','1234',250000,1500)`, [liab, loanE.party]);
      const it = await itemOf(loanE.id, 'lt_reo_liabilities');
      const up = await call('POST', `${cc(loanE.id)}/conditions/${it.id}/documents`, {
        filename: 'statement.pdf', contentType: 'application/pdf',
        dataBase64: Buffer.from('%PDF-1.4 statement ' + uniq).toString('base64'),
      });
      ok(up.status === 201, `a statement lands on the mortgages condition (got ${up.status})`);
      const docId = up.json.documentId;
      const bad = await call('PUT', `/api/lt/condition-center/documents/${docId}/slot`, { slot: `liab:${crypto.randomUUID()}` });
      ok(bad.status === 400 && /not on this file/i.test((bad.json && bad.json.error) || ''), 'a line that is not on this file’s credit report is refused', JSON.stringify(bad.json));
      const good = await call('PUT', `/api/lt/condition-center/documents/${docId}/slot`, { slot: `liab:${liab}` });
      ok(good.status === 200 && good.json.slot === `liab:${liab}`, 'a real mortgage line takes the document', JSON.stringify(good.json));
      await write.recordAnswer(loanE.id, it.id, {
        mortgages: [{ key: `liab:${liab}`, label: 'Big Bank ····1234' }],
        lines: { [`liab:${liab}`]: { way: 'statement', values: {} } },
      }, staff.id, db);
      let list = await readiness(loanE.id);
      await write.markDone(loanE.id, it.id, staff.id, true, db);
      list = await readiness(loanE.id);
      ok(itemIn(list, 'lt_reo_liabilities').done === true, 'the "upload a statement" way is now satisfiable through the doors', JSON.stringify(itemIn(list, 'lt_reo_liabilities')));
      await db.query(`UPDATE documents SET review_status = 'accepted' WHERE id = $1::uuid`, [docId]);
      const back = await write.satisfy(loanE.id, it.id, staff.id, db);
      ok(back.ok === true, '…and the back office signs it off once the statement is accepted', JSON.stringify(back));
    }

    console.log('\nF. A LOAN THAT DOES NOT EXIST IS A 404, AND UN-RUN RULES SAY SO');
    {
      const r = await submittal.complete(crypto.randomUUID(), staff.id, { db });
      ok(r.ok === false && r.status === 404, 'completing a loan that does not exist answers 404, not an outage', JSON.stringify(r));
      const g = await call('GET', `${cc(crypto.randomUUID())}/submittal`);
      ok(g.status === 404, `the readiness door answers 404 too (got ${g.status})`);
      const fresh = await makeLoan('unrun', { evaluate: false });
      const c = await submittal.complete(fresh.id, staff.id, { db });
      ok(c.ok === false && c.status === 422 && /rules have not run/i.test(c.error), 'a file whose rules have not run is told that, not "0 items outstanding: ."', JSON.stringify(c).slice(0, 200));
    }

    console.log('\nG. THE RULES PASS RUNS ON ONE CONNECTION');
    {
      const loanG = await makeLoan('pool', { evaluate: false });
      let poolQueries = 0;
      const guarded = {
        getClient: () => db.pool.connect(),
        query: async () => { poolQueries += 1; throw new Error('the pass reached for the pool while holding the lock'); },
      };
      const r = await engine.evaluateLoan(loanG.id, { db: guarded });
      ok(r.locked === true, 'the lock was taken', JSON.stringify({ locked: r.locked }));
      ok(r.ok === true && r.clean === true && r.added.length > 0 && poolQueries === 0,
        'THE ONE THAT MATTERS: every statement of the pass went through the lock’s connection — the pool was never asked', JSON.stringify({ ok: r.ok, clean: r.clean, degraded: r.degraded, added: r.added.length, poolQueries }));
      const stamped = (await db.query(`SELECT conditions_evaluated_at FROM lt_loans WHERE id = $1::uuid`, [loanG.id])).rows[0];
      ok(stamped && stamped.conditions_evaluated_at !== null, '…and the stamp landed');
    }

    console.log('\nH. A RULE CHANGING ITS MIND NEVER DELETES THE OFFICER’S DONE');
    {
      const loanH = await makeLoan('done-kept', { purpose: 'purchase' });
      const it = await itemOf(loanH.id, 'lt_purchase_contract');
      ok(!!it, 'a purchase file carries the executed-contract condition');
      await write.markDone(loanH.id, it.id, staff.id, true, db);
      // The deal turns out to be a refinance, so the rule no longer wants it.
      await db.query(`UPDATE lt_loans SET loan_purpose = 'cash_out_refinance'::lt_loan_purpose WHERE id = $1::uuid`, [loanH.id]);
      const r = await engine.evaluateLoan(loanH.id, { db });
      ok(r.ok === true, 'the rules run again', JSON.stringify({ ok: r.ok, degraded: r.degraded }));
      const still = await itemOf(loanH.id, 'lt_purchase_contract');
      ok(!!still && still.reviewed_at !== null,
        'THE ONE THAT MATTERS: the condition the officer pressed Done on is KEPT — work somebody did is never destroyed by a rule changing its mind');
      ok(!r.removed.some((x) => x.code === 'lt_purchase_contract'), '…and the pass does not claim to have removed it', JSON.stringify(r.removed));

      // THE CONTROL, or the assertion above proves only that the rule flipped:
      // the SAME condition with no Done on it does leave, so the retraction
      // itself still works and it is the stamp that is doing the keeping.
      const loanH2 = await makeLoan('done-absent', { purpose: 'purchase' });
      ok(!!(await itemOf(loanH2.id, 'lt_purchase_contract')), 'a second purchase file carries it too');
      await db.query(`UPDATE lt_loans SET loan_purpose = 'cash_out_refinance'::lt_loan_purpose WHERE id = $1::uuid`, [loanH2.id]);
      await engine.evaluateLoan(loanH2.id, { db });
      ok(!(await itemOf(loanH2.id, 'lt_purchase_contract')), '…and with nothing done on it, it leaves — so it is the Done stamp doing the keeping');

      /* HONEST NOTE, MEASURED. The read-side test and the identical one inside
         the DELETE are each a COMPLETE guard — the engine's own header records
         this — so removing either ALONE changes no outcome here and only
         removing BOTH turns this section red. That was proven by mutation
         rather than assumed. The one that must never go is the DELETE's, which
         is what closes the window between the read and the write; the pure
         suite additionally guards that all three retraction statements carry
         it, including the retired-template sweep, which no file on a shared
         database can exercise without deactivating a live template. */
    }

    console.log('\nI. THE CLICKUP RETRY BACKS OFF, AND NEVER RETIRES A LOAN (db/678)');
    {
      const cu = require('../src/longterm/clickup/submittal.js');
      const saved = process.env.LT_CLICKUP_WRITE_ENABLED;
      process.env.LT_CLICKUP_WRITE_ENABLED = '1';
      try {
        const loanI = await makeLoan('backoff');
        await db.query(
          `UPDATE lt_loans SET submittal_completed_at = now(), submittal_completed_by = $2::uuid,
                  clickup_task_id = 'task-backoff' WHERE id = $1::uuid`, [loanI.id, staff.id]);
        const triedAt = async () => (await db.query(
          `SELECT submittal_clickup_tried_at AS t, submittal_clickup_error AS e FROM lt_loans WHERE id = $1::uuid`,
          [loanI.id])).rows[0];
        ok((await triedAt()).t === null, 'a loan nobody has tried carries no attempt stamp');

        const broken = { getTask: async () => { throw new Error('ClickUp 503'); } };
        const p1 = await cu.pushPass({ db, deps: broken, limit: 50 });
        ok(p1.owed >= 1 && p1.failed >= 1, 'the pass picks it up and reports the failure', JSON.stringify(p1));
        const after = await triedAt();
        ok(after.t !== null && /503/.test(after.e || ''), 'THE ONE THAT MATTERS: a failed attempt is STAMPED, so the next pass can back off', JSON.stringify(after));

        let asked = 0;
        const p2 = await cu.pushPass({ db, limit: 50, deps: { getTask: async () => { asked += 1; throw new Error('ClickUp 503'); } } });
        ok(!p2.owed || asked === 0, 'the very next pass does not ask ClickUp about it again', JSON.stringify({ owed: p2.owed, asked }));

        // …and it is BACKED OFF, never retired: with the window elapsed it is
        // tried again, so a card somebody fixes tomorrow still gets its push.
        /* THE DEFAULT WINDOW IS FINITE, and that is the half that says "backed
           off" rather than "retired": back-date the attempt past the default and
           run the pass with NO override, the way the worker runs it. */
        await db.query(
          `UPDATE lt_loans SET submittal_clickup_tried_at = now() - interval '31 minutes' WHERE id = $1::uuid`,
          [loanI.id]);
        const option = { id: 'opt-live', name: 'Completed', orderindex: 0 };
        const writes = [];
        const p3 = await cu.pushPass({
          db, limit: 50,
          deps: {
            getTask: async () => ({ id: 'task-backoff', custom_fields: [{ id: cu.FIELD.id, name: cu.FIELD.name, type: 'drop_down', type_config: { options: [option] }, value: null }] }),
            setField: async (t, f, v) => { writes.push({ t, f, v }); },
            journal: async () => {},
          },
        });
        ok(p3.pushed >= 1 && writes.some((w) => w.v === option.id),
          'once the window has elapsed it is tried again and lands — backed off, never retired', JSON.stringify({ p3, writes }));
        const done = await triedAt();
        ok(done.e === null, '…and the old error is cleared', JSON.stringify(done));
      } finally {
        if (saved === undefined) delete process.env.LT_CLICKUP_WRITE_ENABLED;
        else process.env.LT_CLICKUP_WRITE_ENABLED = saved;
      }
    }

  } catch (e) {
    failed = true;
    console.error('\nUNEXPECTED:', e && e.stack ? e.stack : e);
  } finally {
    if (server) server.close();
    try {
      for (const id of loans) {
        // eslint-disable-next-line no-await-in-loop
        await db.query(`DELETE FROM documents WHERE lt_loan_id = $1::uuid`, [id]);
        // eslint-disable-next-line no-await-in-loop
        await db.query(`DELETE FROM lt_loans WHERE id = $1::uuid`, [id]);
      }
      if (borrower) {
        await db.query(`UPDATE borrowers SET photo_id_document_id = NULL WHERE id = $1::uuid`, [borrower]);
        await db.query(`DELETE FROM documents WHERE borrower_id = $1::uuid OR llc_id IN (SELECT id FROM llcs WHERE borrower_id = $1::uuid)`, [borrower]);
        await db.query(`DELETE FROM checklist_items WHERE llc_id IN (SELECT id FROM llcs WHERE borrower_id = $1::uuid)`, [borrower]);
        await db.query(`DELETE FROM llcs WHERE borrower_id = $1::uuid`, [borrower]);
        await db.query(`DELETE FROM borrowers WHERE id = $1::uuid`, [borrower]);
      }
      if (staff) await db.query(`DELETE FROM staff_users WHERE id = $1::uuid`, [staff.id]);
    } catch (e) { console.error('cleanup:', (e && e.message) || e); }
    await db.pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) fails.forEach((f) => console.error('  FAIL ' + f));
  process.exit(failed || fails.length ? 1 : 0);
})();

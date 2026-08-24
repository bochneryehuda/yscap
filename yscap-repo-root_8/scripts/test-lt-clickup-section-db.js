'use strict';
/**
 * LONG-TERM — the ClickUp SYNCING section of every LT file (#36): the
 * /api/lt/clickup router, end to end over real HTTP against a real Postgres,
 * with the wire (ClickUp) and Encompass stubbed in require.cache exactly the
 * way the writer suite stubs them — the REAL push/mapper/guards run.
 *
 * What this proves:
 *   A. (source) the router is mounted at the LT seam and the workspace menu
 *      carries the always-available 'clickup' section
 *   B. GET returns the whole section — link state, switches, the human-readable
 *      field PLAN with the SSN MASKED (never a readable Social in the payload),
 *      journal + review rows — and ?compare=1 lays the live card beside ours
 *   C. the push doors: full push, per-field push, unknown field refused, and a
 *      switched-off writer answered with a plain reason (409, never a silent 200)
 *   D. the manual LINK door: verify-then-link (source='manual', confirmed,
 *      link-logged), a short-term card refused, a claimed card refused, and a
 *      loan-number MISMATCH held for an explicit confirm
 *   E. Create New Task mints the card through createForLoan's own guards
 *   F. the review doors: approve re-pushes EXACTLY the one field (the shield
 *      steps aside for it alone) and resolves the row; reject keeps the card
 *      and records who decided; a review from another loan 404s (pinned)
 *   G. access: a scoped officer NOT on the loan gets 404; ON the loan they can
 *      read + push but the link door stays admin-only (403)
 *
 * Mutation-proven (each reverted → red):
 *   1. the approve door pushing the FULL card instead of only:[key] → F fails
 *      (the differing borrower name would be rewritten / blocked rows change)
 *   2. the link door skipping the short-term refusal → D fails
 *   3. the plan returning the raw SSN → B fails
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };

async function main() {
  console.log('A. mounted at the seam, on the menu');
  const idxSrc = fs.readFileSync(path.resolve(__dirname, '../src/longterm/index.js'), 'utf8');
  ok(/router\.use\('\/clickup', require\('\.\/routes\/clickup'\)\)/.test(idxSrc),
    'src/longterm/index.js mounts /api/lt/clickup');
  const workspace = require('../src/longterm/workspace');
  const menu = workspace.sectionMenu({}, {});
  const cuSection = menu.find((s) => s.key === 'clickup');
  ok(cuSection, "the workspace menu carries the 'clickup' section");
  eq(cuSection.available, true, '…ALWAYS available — the unlinked file is where Create/Link live');

  if (!process.env.DATABASE_URL) {
    console.log(`\nNo DATABASE_URL — source half passed (${checks} checks); DB half skipped.`);
    return;
  }

  // ── the stubs, before anything loads push.js ───────────────────────────────
  process.env.LT_CLICKUP_WRITE_ENABLED = '1';
  delete process.env.LT_CLICKUP_WRITE_DRYRUN;
  const writerPath = path.resolve(__dirname, '../src/longterm/clickup/writer-client.js');
  const canonPath = path.resolve(__dirname, '../src/lib/address-canon.js');
  const encPath = path.resolve(__dirname, '../src/longterm/encompass/client.js');
  const realWriter = require(writerPath);
  const wire = { setField: [], createTask: [] };
  let createSeq = 0;
  const PROGRAM_OPTS = [
    { id: 'opt-ff', name: 'Fix & Flip With Construction', orderindex: 0 },
    { id: 'opt-gu', name: 'Ground-Up', orderindex: 1 },
    { id: 'opt-dscr', name: 'Non-QM - DSCR Ratio', orderindex: 2 },
  ];
  let cards = {};
  const writerStub = {
    configured: () => true,
    teamId: () => '9011888435',
    getTask: async (taskId) => {
      const t = cards[String(taskId)];
      if (!t) { const e = new Error(`ClickUp GET /task/${taskId} -> 404`); e.status = 404; throw e; }
      return t;
    },
    setField: async (taskId, fieldId, value) => {
      realWriter.guardNoFieldClearing(fieldId, value);
      wire.setField.push({ taskId, fieldId, value });
      return {};
    },
    createTask: async (listId, payload) => {
      wire.createTask.push({ listId, payload });
      const id = `cunew${++createSeq}`;
      return { id, url: `https://app.clickup.com/t/${id}`, custom_id: 'FILLE-7777' };
    },
    getFolderLists: async () => ({ lists: [{ id: 'list-77', name: 'Loan Pipeline' }] }),
    getList: async () => ({ statuses: [] }),
    updateTask: async (taskId, payload) => { realWriter.guardTaskUpdatePayload(payload); return {}; },
    getTeams: async () => ({ teams: [] }),
    getListFields: async () => ({ fields: [] }),
    guardNoFieldClearing: realWriter.guardNoFieldClearing,
  };
  require.cache[writerPath] = { id: writerPath, filename: writerPath, loaded: true, exports: writerStub };
  require.cache[canonPath] = { id: canonPath, filename: canonPath, loaded: true, exports: {
    geocode: async (t) => ({ lat: 41.09, lng: -75.26, formatted: t }),
  } };
  const exLive = { 65: '123456789', 'CX.TABLEFUNDER': 'Non Delegated Correspondent', 1402: '05/14/1985' };
  require.cache[encPath] = { id: encPath, filename: encPath, loaded: true, exports: {
    configured: () => true,
    fieldReaderSplit: async () => ({ ...exLive }),
    fieldReader: async () => ({ ...exLive }),
  } };
  for (const m of ['../src/longterm/clickup/push.js', '../src/longterm/clickup/registry.js', '../src/longterm/routes/clickup.js']) {
    delete require.cache[path.resolve(__dirname, m)];
  }

  const mapper = require('../src/longterm/clickup/mapper');
  const CU = mapper.CU;
  const route = require('../src/longterm/routes/clickup');
  const push = require('../src/longterm/clickup/push');
  const db = require('../src/longterm/db');
  push._internals._resetBreaker();

  // A card: only the fields a test names, program carrying its live options.
  const card = (fields = {}, extra = {}) => ({
    id: extra.id || 'cutask1',
    status: { status: 'workflow' },
    list: { id: 'list-77' },
    subtasks: extra.subtasks || [],
    url: `https://app.clickup.com/t/${extra.id || 'cutask1'}`,
    custom_fields: [
      { id: CU.program, value: fields.program != null ? fields.program : null, type_config: { options: PROGRAM_OPTS } },
      { id: CU.ysLoanNumber, value: fields.ysLoanNumber != null ? fields.ysLoanNumber : null, type_config: {} },
      { id: CU.borrowerName, value: fields.borrowerName != null ? fields.borrowerName : null, type_config: {} },
      { id: CU.borrowerSSN, value: fields.borrowerSSN != null ? fields.borrowerSSN : null, type_config: {} },
    ],
  });

  // ── the app: the LT mount with a switchable actor ──────────────────────────
  const express = require('express');
  const app = express();
  app.use(express.json());
  let actor = { id: null, role: 'super_admin', email: 'admin@test' };
  app.use((req, res, next) => { req.actor = actor; next(); });
  app.use('/api/lt/clickup', route);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/lt/clickup`;
  const call = (method, p, body) => fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

  // ── fixtures ───────────────────────────────────────────────────────────────
  const { rows: adminRow } = await db.query('SELECT gen_random_uuid() AS id');
  actor.id = adminRow[0].id;
  const mkLoan = async (num, name, { taskId = null, officerEmail = 'yehuda@yscapgroup.com' } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_name, loan_amount, loan_purpose,
                             program_name, encompass_synced_at, created_at,
                             clickup_task_id, clickup_link_confidence, clickup_linked_at)
       VALUES (gen_random_uuid(), 'test-cusec-' || gen_random_uuid(), $1, $2, 250000, 'purchase',
               'Investor DSCR 30 YEAR FRM', now(), '2026-08-20',
               $3, CASE WHEN $3::text IS NULL THEN NULL ELSE 'confirmed' END,
               CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`, [num, name, taskId]);
    const id = rows[0].id;
    await db.query(`INSERT INTO lt_properties (loan_id, street, city, state, zip) VALUES ($1::uuid, '5 Section St', 'Cresco', 'PA', '18326')`, [id]);
    await db.query(`INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, encompass_email)
                    VALUES (gen_random_uuid(), $1::uuid, 'loan_officer', 'Yehuda Bochner', $2)`, [id, officerEmail]);
    return id;
  };
  const linked = await mkLoan('TESTCU1', 'Sarah Sectiontest', { taskId: 'cutask1' });
  const unlinked = await mkLoan('TESTCU2', 'Uri Unlinked');
  const mism = await mkLoan('TESTCU3', 'Mendy Mismatch');

  try {
    console.log('B. the section GET');
    cards = { cutask1: card({ program: 2 }) };
    let r = await call('GET', `/loans/${linked}`);
    eq(r.status, 200, 'the section answers for a linked loan');
    eq(r.json.link.taskId, 'cutask1', '…with the link state');
    eq(r.json.switches.writeEnabled, true, '…the switch state');
    ok(Array.isArray(r.json.plan.fields) && r.json.plan.fields.length > 30, `…and the whole field plan (${r.json.plan.fields.length} fields)`);
    const planText = JSON.stringify(r.json.plan);
    ok(!planText.includes('123456789') && !planText.includes('123-45-6789'),
      'a readable Social NEVER appears in the plan…');
    const ssnRow = r.json.plan.fields.find((f) => f.key === 'ssn');
    eq(ssnRow && ssnRow.value, '✱✱✱-✱✱-6789', '…the SSN row is MASKED to its last four');
    const nameRow = r.json.plan.fields.find((f) => f.key === 'borrower_name');
    eq(nameRow && nameRow.value, 'Sarah Sectiontest', 'a plain field shows its value in words');
    ok(r.json.plan.liveFieldsRead >= 2, 'the section says how many live Encompass fields were read');
    eq(r.json.canAdmin, true, 'an admin viewer is told the admin buttons apply');

    r = await call('GET', `/loans/${linked}?compare=1`);
    eq(r.status, 200, 'the compare read answers');
    ok(Array.isArray(r.json.compare.fields), '…with per-field ours-vs-card rows');
    const cmpName = r.json.compare.fields.find((f) => f.key === 'borrower_name');
    eq(cmpName && cmpName.card, null, 'an empty card field reads as empty');
    eq(cmpName && cmpName.ours, 'Sarah Sectiontest', '…beside our value');
    eq(r.json.compare.status.current, 'workflow', 'the card status is read');
    eq(r.json.compare.cardProgram, 'Non-QM - DSCR Ratio', 'the card program label resolves from its own options');

    console.log('C. the push doors');
    wire.setField.length = 0;
    r = await call('POST', `/loans/${linked}/push`);
    eq(r.status, 200, 'a full push answers 200');
    ok(wire.setField.length >= 5, `…and wrote real fields (${wire.setField.length})`);
    push._internals._resetBreaker();
    wire.setField.length = 0;
    r = await call('POST', `/loans/${linked}/push-field`, { key: 'ys_loan_number' });
    eq(r.status, 200, 'a per-field push answers 200');
    ok(wire.setField.every((w) => w.fieldId === CU.ysLoanNumber), '…and touched ONLY that field');
    r = await call('POST', `/loans/${linked}/push-field`, { key: 'not_a_field' });
    eq(r.status, 400, 'an unknown field is refused with 400');
    delete process.env.LT_CLICKUP_WRITE_ENABLED;
    r = await call('POST', `/loans/${linked}/push`);
    eq(r.status, 409, 'with the writer OFF the push answers 409…');
    ok(/switched off/i.test(r.json.error), '…saying the switch is off in plain words');
    process.env.LT_CLICKUP_WRITE_ENABLED = '1';

    console.log('D. the manual link door');
    cards.freshcard = card({}, { id: 'freshcard' });
    cards.shortcard = card({ program: 0 }, { id: 'shortcard' });
    cards.mismcard = card({ ysLoanNumber: 'YSCAP999' }, { id: 'mismcard' });
    r = await call('POST', `/loans/${unlinked}/link`, { taskId: 'shortcard' });
    eq(r.status, 409, 'a SHORT-TERM card is refused…');
    ok(/short-term/i.test(r.json.error), '…and says so');
    r = await call('POST', `/loans/${unlinked}/link`, { taskId: 'cutask1' });
    eq(r.status, 409, 'a card already linked to another loan is refused…');
    ok(/TESTCU1/.test(r.json.error), '…NAMING the loan that holds it');
    r = await call('POST', `/loans/${unlinked}/link`, { taskId: 'nosuchcard' });
    eq(r.status, 404, 'a card that does not exist answers 404');
    r = await call('POST', `/loans/${unlinked}/link`, { taskId: 'freshcard' });
    eq(r.status, 200, 'a clean link lands');
    let { rows: lrow } = await db.query('SELECT clickup_task_id, clickup_link_source, clickup_link_confidence FROM lt_loans WHERE id = $1::uuid', [unlinked]);
    eq(lrow[0].clickup_task_id, 'freshcard', '…the loan row holds the card');
    eq(lrow[0].clickup_link_source, 'manual', "…source 'manual'");
    eq(lrow[0].clickup_link_confidence, 'confirmed', '…confidence confirmed');
    const { rows: llog } = await db.query(
      `SELECT source, action FROM lt_clickup_link_log WHERE lt_loan_id = $1::uuid ORDER BY created_at DESC LIMIT 1`, [unlinked]);
    eq(llog[0] && llog[0].source, 'manual', '…and the link log records the hand link');
    r = await call('POST', `/loans/${mism}/link`, { taskId: 'mismcard' });
    eq(r.status, 409, 'a loan-number MISMATCH is held…');
    eq(r.json.needsConfirm, true, '…asking for an explicit confirm');
    r = await call('POST', `/loans/${mism}/link`, { taskId: 'mismcard', confirm: true });
    eq(r.status, 200, '…and the confirmed link lands');

    console.log('E. Create New Task');
    const created = await mkLoan('TESTCU4', 'Chana Createme');
    wire.createTask.length = 0;
    push._internals._resetBreaker();
    r = await call('POST', `/loans/${created}/create`);
    eq(r.status, 200, 'the create door mints the card');
    eq(wire.createTask.length, 1, '…exactly one create on the wire');
    ({ rows: lrow } = await db.query('SELECT clickup_task_id, clickup_link_source FROM lt_loans WHERE id = $1::uuid', [created]));
    ok(lrow[0].clickup_task_id, '…and the loan is linked to it');
    eq(lrow[0].clickup_link_source, 'created', "…source 'created'");
    r = await call('POST', `/loans/${created}/create`);
    eq(r.status, 409, 'a second create refuses — the loan already has a card');

    console.log('F. the review doors');
    // The exact rows the shield writes: a parent-card SSN block ('ssn') and a
    // subtask co-name block ('co_name').
    cards.cutask1 = card({ program: 2, borrowerSSN: '999-99-9999' });
    const { rows: rv1 } = await db.query(
      `INSERT INTO lt_clickup_review_queue (lt_loan_id, task_id, direction, field_key, current_value, proposed_value, reason)
       VALUES ($1::uuid, 'cutask1', 'outbound', 'ssn', '✱✱✱-✱✱-9999', '✱✱✱-✱✱-6789', 'pii_overwrite_blocked')
       RETURNING id`, [linked]);
    r = await call('GET', `/loans/${linked}`);
    eq(r.json.reviews.open.length >= 1, true, 'the section lists the open review');
    wire.setField.length = 0;
    push._internals._resetBreaker();
    r = await call('POST', `/loans/${linked}/reviews/${rv1[0].id}/approve`);
    eq(r.status, 200, 'approving the SSN review answers 200');
    ok(wire.setField.some((w) => w.taskId === 'cutask1' && w.fieldId === CU.borrowerSSN && w.value === '123-45-6789'),
      '…the shield stepped aside and the approved Social landed (dashed)');
    ok(!wire.setField.some((w) => w.fieldId !== CU.borrowerSSN),
      '…and NOTHING ELSE was written — the approval is scoped to exactly its field');
    let { rows: rvRow } = await db.query('SELECT status, resolved_by FROM lt_clickup_review_queue WHERE id = $1', [rv1[0].id]);
    eq(rvRow[0].status, 'resolved', '…and the row is resolved');
    eq(String(rvRow[0].resolved_by), String(actor.id), '…recording WHO approved');
    r = await call('POST', `/loans/${linked}/reviews/${rv1[0].id}/approve`);
    eq(r.status, 409, 'a decided review cannot be decided twice');

    const { rows: rv2 } = await db.query(
      `INSERT INTO lt_clickup_review_queue (lt_loan_id, task_id, direction, field_key, current_value, proposed_value, reason)
       VALUES ($1::uuid, 'cutask1', 'outbound', 'borrower_name', 'Old Name', 'Sarah Sectiontest', 'pii_overwrite_blocked')
       RETURNING id`, [linked]);
    wire.setField.length = 0;
    r = await call('POST', `/loans/${linked}/reviews/${rv2[0].id}/reject`);
    eq(r.status, 200, 'rejecting answers 200');
    eq(wire.setField.length, 0, '…and writes NOTHING — the card keeps what it holds');
    ({ rows: rvRow } = await db.query('SELECT status FROM lt_clickup_review_queue WHERE id = $1', [rv2[0].id]));
    eq(rvRow[0].status, 'rejected', '…the row is rejected');

    // A review pinned to ANOTHER loan 404s even for an admin (IDOR pin).
    const { rows: rv3 } = await db.query(
      `INSERT INTO lt_clickup_review_queue (lt_loan_id, task_id, direction, field_key, proposed_value, reason)
       VALUES ($1::uuid, 'freshcard', 'outbound', 'ssn', 'x', 'pii_overwrite_blocked') RETURNING id`, [unlinked]);
    r = await call('POST', `/loans/${linked}/reviews/${rv3[0].id}/approve`);
    eq(r.status, 404, "another loan's review 404s through this loan's URL");

    // The SUBTASK review: approve writes the one field on the SUBTASK.
    const { rows: pair } = await db.query(
      `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES (gen_random_uuid(), $1::uuid, 1) RETURNING id`, [linked]);
    await db.query(`INSERT INTO lt_parties (id, pair_id, role, first_name, last_name)
                    VALUES (gen_random_uuid(), $1::uuid, 'borrower', 'Sarah', 'Sectiontest')`, [pair[0].id]);
    await db.query(`INSERT INTO lt_parties (id, pair_id, role, first_name, last_name, email)
                    VALUES (gen_random_uuid(), $1::uuid, 'coborrower', 'Rivky', 'Sectiontest', 'rivky@example.com')`, [pair[0].id]);
    cards.cutask1 = card({ program: 2 }, { subtasks: [{ id: 'cusub1', name: 'Rivky Sectiontest' }] });
    cards.cusub1 = card({ borrowerName: 'Wrong Co Name' }, { id: 'cusub1' });
    const { rows: rv4 } = await db.query(
      `INSERT INTO lt_clickup_review_queue (lt_loan_id, task_id, direction, field_key, current_value, proposed_value, reason)
       VALUES ($1::uuid, 'cusub1', 'outbound', 'co_name', 'Wrong Co Name', 'Rivky Sectiontest', 'pii_overwrite_blocked')
       RETURNING id`, [linked]);
    wire.setField.length = 0;
    push._internals._resetBreaker();
    r = await call('POST', `/loans/${linked}/reviews/${rv4[0].id}/approve`);
    eq(r.status, 200, 'approving a SUBTASK review answers 200');
    ok(wire.setField.some((w) => w.taskId === 'cusub1' && w.fieldId === CU.borrowerName),
      '…the approved co-name landed on the SUBTASK');
    ok(!wire.setField.some((w) => w.taskId === 'cutask1'), '…and the parent card was untouched');

    console.log('G. access');
    const { rows: loRow } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ('lo-cusec@test.local', 'Test Officer', 'loan_officer', true)
       ON CONFLICT (email) DO UPDATE SET is_active = true RETURNING id`);
    actor = { id: loRow[0].id, role: 'loan_officer', email: 'lo-cusec@test.local' };
    r = await call('GET', `/loans/${linked}`);
    eq(r.status, 404, 'an officer NOT on the loan gets 404 (never "not yours")');
    await db.query(`INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, staff_id)
                    VALUES (gen_random_uuid(), $1::uuid, 'processor', 'Test Officer', $2::uuid)`, [linked, actor.id]);
    r = await call('GET', `/loans/${linked}`);
    eq(r.status, 200, '…ON the loan, the section opens');
    eq(r.json.canAdmin, false, '…and says the admin buttons do not apply to them');
    push._internals._resetBreaker();
    r = await call('POST', `/loans/${linked}/push-field`, { key: 'ys_loan_number' });
    eq(r.status, 200, '…they can push a field on their own file');
    r = await call('POST', `/loans/${linked}/link`, { taskId: 'freshcard' });
    eq(r.status, 403, '…but the LINK door is admin-only');
    r = await call('POST', `/loans/${linked}/create`);
    eq(r.status, 403, '…and so is Create New Task');
  } finally {
    server.close();
    await db.query(`DELETE FROM lt_clickup_review_queue WHERE task_id IN ('cutask1','cusub1','freshcard')`).catch(() => {});
    await db.query(`DELETE FROM lt_clickup_write_log WHERE task_id IN ('cutask1','cusub1','freshcard','mismcard') OR task_id LIKE 'cunew%'`).catch(() => {});
    await db.query(`DELETE FROM lt_loans WHERE loan_number LIKE 'TESTCU%'`).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email = 'lo-cusec@test.local'`).catch(() => {});
  }

  console.log(`\nAll ${checks} checks passed.`);
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e && (e.stack || e.message)); process.exit(1); });

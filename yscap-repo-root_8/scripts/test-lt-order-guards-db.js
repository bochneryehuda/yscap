#!/usr/bin/env node
'use strict';
/**
 * LT — THE ORDERS DESK'S GUARDS, against a REAL Postgres, the REAL condition
 * engine and the REAL HTTP door, with the mailer stubbed and INSPECTED.
 *
 * The 2026-09-02 audit of the orders desk found six defects that no pure test
 * could see, because each one is a fact about the database, the engine or the
 * route rather than about a function:
 *
 *   S8  `lt_file_orders.condition_id` still carried a foreign key to the RETIRED
 *       `lt_file_conditions`, while the route accepts the REAL `checklist_items`
 *       id from the screen — so "Order it" from a condition card was a 500.
 *   N4  A returned document moved the ORDER to 'documents_in' and left the
 *       documents CONDITION 'outstanding' — a commitment sitting on a condition
 *       that still read as if nobody had sent one.
 *   S7  `place` re-sent a full order over a `documents_in` order without
 *       `force`; only 'ordered' was guarded.
 *   S5  A slot that does not apply on the file (New York's title package has no
 *       CD / wiring instructions) still received the document — filed into a
 *       slot the screen never renders.
 *   S4  On a New York file nobody was asked for the E&O and there was no slot
 *       for it; title's wiring-instructions slot stayed required.
 *   S4b THE CORRECTION. db/677's first cut ALSO gave the settlement agent a
 *       required CPL slot, from a draft that said the CPL "moved" off the title
 *       order. The owner corrected that on 2026-09-02 — *"In NY, there is no
 *       CPL"* — so db/680 takes it back off. Both files replay on every boot in
 *       filename order, so what must be proven is that they CONVERGE, from
 *       whichever state a database happens to be in, and that a row somebody
 *       has edited keeps their edit while still losing the CPL.
 *   S9  The desk's "does this order belong on this file" read a conditions list
 *       nothing on that route refreshed — a property that became a condominium
 *       still greyed the condo questionnaire.
 *
 * PROVEN TO FAIL, each with a green control either side: the FK re-added on the
 * test database (S8 red); the `markConditionAsked` call removed from the inbox
 * (N4 red); the guard reverted to `status === 'ordered'` (S7 red); the
 * applicable-slot filter removed (S5 red); the db/677 template rows reverted
 * (S4 red); `evaluateIfStale` removed from the route (S9 red); db/680's two
 * statements neutered (S4b red on every starting state); the `sender` dropped
 * from either renderer (S10 red on that renderer alone, which is the point of
 * asserting both).
 *
 * Run: DATABASE_URL=... node scripts/test-lt-order-guards-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-order-guards-db (no DATABASE_URL)'); process.exit(0); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
process.env.STORAGE_DIR = process.env.STORAGE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-order-guards-'));

const db = require('../src/db');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `ltgrd-${process.pid}-${Date.now()}`;

const email = require('../src/lib/email');
const sent = [];
email.sendMail = async (payload) => { sent.push(payload); return { id: `stub-${sent.length}`, ok: true }; };
const inboundMail = require('../src/lib/inbound-mail');
let inlineAttachments = [];
inboundMail.retrieveAttachmentsSafe = async () => {
  const out = inlineAttachments.slice();
  out.droppedByCap = 0; out.droppedByError = 0;
  return out;
};

(async () => {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-order-guards');
  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();
  const lib = require('../src/longterm/conditions-center/library');
  await lib.ensureSeeded(db);
  const engine = require('../src/longterm/conditions-center/engine');
  const read = require('../src/longterm/conditions-center/read');
  const desk = require('../src/longterm/orders/desk');
  const inbox = require('../src/longterm/orders/inbox');
  const auth = require('../src/auth');

  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, token, body) => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };

  /* ───────────────────────────────── seed ────────────────────────────────── */
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active)
     VALUES ($1,'LT Guards Admin','admin',true) RETURNING id`, [`${uniq}@example.test`])).rows[0];
  const staffId = String(staff.id);
  const token = await auth.mintStaffSession(staff.id);
  const borrowerId = String((await db.query(
    `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1,'Guards',$2) RETURNING id`,
    [uniq, `${uniq}-b@example.test`])).rows[0].id);

  const mkLoan = async (n, state) => {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO lt_loans (id, loan_number, borrower_name, borrower_id, term_months, program_name, loan_amount, loan_folder, loan_officer_id)
       VALUES ($1::uuid,$2,'Bo Rrower',$3::uuid,360,'Investor DSCR 30 YEAR FRM',500000,'Pipeline',$4::uuid)`,
      [id, `${uniq}-${n}`, borrowerId, staffId]);
    await db.query(
      `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
       VALUES ($1::uuid,'12 Test Street','Anytown',$2,'10001',1,'SFR')`, [id, state]);
    const r = await engine.evaluateLoan(id, { db });
    if (r && r.degraded) console.log('  (engine degraded:', r.degraded, ')');
    return id;
  };
  const nj = await mkLoan('nj', 'NJ');
  const ny = await mkLoan('ny', 'NY');

  const vendorEmail = `${uniq}-title@vendor.test`;
  const contactId = String((await db.query(
    `INSERT INTO service_contacts (company_name, contact_name, email, contact_type)
     VALUES ($1,'A Closer',$2,'title') RETURNING id`, [`${uniq} Title Co`, vendorEmail])).rows[0].id);
  for (const l of [nj, ny]) {
    await db.query(`INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id, is_primary) VALUES ($1::uuid,'title',$2::uuid,true)`, [l, contactId]);
  }

  const condOf = async (loanId, code) => (await db.query(
    `SELECT ci.id, ci.status FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.lt_loan_id = $1::uuid AND t.code = $2`, [loanId, code])).rows[0] || null;
  const orderRow = async (loanId, kind = 'title') => (await db.query(
    `SELECT id, status, reply_to, condition_id FROM lt_file_orders WHERE loan_id=$1::uuid AND kind=$2`, [loanId, kind])).rows[0] || null;
  const reply = async (loanId, files, tag) => {
    const row = await orderRow(loanId);
    const refs = inbox.ordersFromEvent({ to: [row.reply_to] });
    inlineAttachments = files.map((filename, i) => ({
      filename, contentType: 'application/pdf', content: Buffer.from(`%PDF-1.4 ${tag} ${filename} ${i}`).toString('base64'),
    }));
    return inbox.handleOne(refs[0], { data: { email_id: `${uniq}-${tag}` } }, {
      id: `${uniq}-${tag}`, from: vendorEmail, to: [row.reply_to], subject: 'Re: title order', text: 'Attached.',
      attachments: inlineAttachments.map((a) => ({ filename: a.filename, contentType: a.contentType })),
    });
  };
  const filedOn = async (loanId) => (await db.query(
    `SELECT filename, slot_label FROM documents WHERE lt_loan_id=$1::uuid ORDER BY created_at`, [loanId])).rows;

  try {
    /* ═════════ S8. THE REAL CONDITION ID IS ACCEPTED ═════════════════════ */
    console.log('\nS8. "Order it" from a condition card — the real checklist id on the order row');
    {
      const fk = (await db.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'lt_file_orders'::regclass AND contype = 'f' AND conname = 'lt_file_orders_condition_fk'`)).rows;
      assert(fk.length === 0, `db/675: the key to the retired lt_file_conditions is gone (${JSON.stringify(fk)})`);
      const orderCond = await condOf(nj, 'lt_order_title');
      assert(!!orderCond, 'FIXTURE: the engine put lt_order_title on the New Jersey file');
      const before = sent.length;
      const r = await desk.place(nj, 'title', { staffId, conditionId: orderCond.id });
      assert(r && r.ok === true, `THE ONE THAT MATTERS: placing with the REAL checklist_items id succeeds (got ${JSON.stringify(r).slice(0, 160)})`);
      assert(sent.length === before + 1, '…and one letter went');
      const row = await orderRow(nj);
      assert(row && String(row.condition_id) === String(orderCond.id), '…and the order row records that condition id');
      assert((await condOf(nj, 'lt_order_title')).status === 'received', '…and the order condition moved to asked-for');
    }

    /* ═════════ N4. THE DOCUMENTS CONDITION MOVES OFF OUTSTANDING ═════════ */
    console.log('\nN4. A returned document moves the documents condition to received');
    {
      const docsCond = await condOf(nj, 'lt_title_docs');
      assert(docsCond && docsCond.status === 'outstanding', `CONTROL: lt_title_docs starts outstanding (${docsCond && docsCond.status})`);
      const r = await reply(nj, ['Title Commitment.pdf'], 'nj-1');
      assert(r && Number(r.filed) === 1, `the vendor's document is filed (${JSON.stringify(r).slice(0, 120)})`);
      assert((await orderRow(nj)).status === 'documents_in', 'the order row reads documents_in');
      const after = await condOf(nj, 'lt_title_docs');
      assert(after && after.status === 'received', `THE ONE THAT MATTERS: the documents condition moved to received (${after && after.status})`);
    }

    /* ═════════ S7. NO SECOND FULL ORDER OVER documents_in ════════════════ */
    console.log('\nS7. A full order is not re-sent over a documents_in order without force');
    {
      const before = sent.length;
      const again = await desk.place(nj, 'title', { staffId });
      assert(again && again.ok === false && again.status === 409, `THE ONE THAT MATTERS: refused with 409 (got ${JSON.stringify(again).slice(0, 160)})`);
      assert(/already come back|already been ordered/i.test((again && again.error) || ''), '…in words that say the documents are already in');
      assert(sent.length === before, '…and nothing reached the mailer');
      assert((await orderRow(nj)).status === 'documents_in', '…and the row still reads documents_in');
      const forced = await desk.place(nj, 'title', { staffId, force: true });
      assert(forced && forced.ok === true && sent.length === before + 1, 'a DELIBERATE re-send still goes');
      // and a stood-down order takes a fresh one without ceremony
      await desk.cancel(nj, 'title', { staffId, reason: 'staged for the test' });
      const fresh = await desk.place(nj, 'title', { staffId });
      assert(fresh && fresh.ok === true, 'a cancelled order takes a fresh order without force');
    }

    /* ═════════ S4 + S5. NEW YORK: the slots, and a document that does not apply ═ */
    console.log('\nS4. New York: the settlement agent carries the E&O and NO CPL; title is not asked for the wire');
    {
      const tpl = async (code) => (await db.query(`SELECT slots FROM checklist_templates WHERE code=$1 AND scope='lt_loan'`, [code])).rows[0].slots;
      const nySlots = await tpl('lt_ny_settlement_docs');
      const has = (slots, k) => slots.find((s) => s.key === k);
      /* THERE IS NO CPL IN NEW YORK (owner, 2026-09-02). db/677 added the slot on
         the strength of a draft that said it moved off the title order; db/680
         removes it. Asserted against the LIVE database rather than the library,
         because the two migrations replay in filename order on every boot and
         what has to be true is that they CONVERGE — db/677 re-adding it and
         db/680 taking it off leaves no CPL by the time anybody reads the row. */
      assert(!has(nySlots, 'cpl') && !has(nySlots, 'engagement'),
        'the settlement-agent TEMPLATE in the database carries neither a cpl nor an engagement slot');
      assert(has(nySlots, 'eo') && has(nySlots, 'eo').required, '…and a required eo slot');
      const titleSlots = await tpl('lt_title_docs');
      assert(has(titleSlots, 'wire_instructions') && has(titleSlots, 'wire_instructions').notWhenField === 'is_new_york',
        'the title TEMPLATE marks wire_instructions notWhenField is_new_york');

      const flat = async (loanId) => {
        const out = await read.forLoan(loanId, { db, audience: 'internal' });
        const all = []; for (const b of out.buckets) for (const c of b.conditions) all.push(c);
        return new Map(all.map((c) => [c.code, c]));
      };
      const nyRead = await flat(ny);
      const njRead = await flat(nj);
      const keys = (c) => (c ? c.slots.map((s) => s.key) : null);
      assert(nyRead.has('lt_ny_settlement_docs'), 'FIXTURE: the engine put the settlement-agent documents on the New York file');
      const nySa = keys(nyRead.get('lt_ny_settlement_docs')) || [];
      assert(JSON.stringify(nySa.slice().sort()) === JSON.stringify(['eo', 'settlement_statement', 'wire_instructions']),
        `THE ONE THAT MATTERS: the New York file's settlement-agent condition shows exactly the three asked for (${nySa.join(',')})`);
      const nyTitle = keys(nyRead.get('lt_title_docs')) || [];
      assert(!nyTitle.includes('wire_instructions') && !nyTitle.includes('cpl') && !nyTitle.includes('prelim_settlement'),
        `…and its title condition shows neither the wire, the CPL nor the preliminary statement (${nyTitle.join(',')})`);
      const njTitle = keys(njRead.get('lt_title_docs')) || [];
      assert(njTitle.includes('wire_instructions') && njTitle.includes('cpl'), `CONTROL: New Jersey's title condition still asks for both (${njTitle.join(',')})`);
    }

    /* ═════════ S4b. db/677 AND db/680 CONVERGE, WHATEVER STATE WE START IN ═══ */
    console.log('\nS4b. The New York settlement agent is asked for three things — the three migrations converge and stay converged');
    {
      /* Replayed IN FILENAME ORDER, which is how migrate-boot runs them, inside
         a transaction that is rolled back — this asserts about the SQL, not
         about the row the rest of the suite is using. A one-off `UPDATE` in a
         test would prove the end state and say nothing about the replay, and
         the replay is the whole risk: db/677 runs FIRST on every single boot. */
      const fs = require('fs');
      const path = require('path');
      const sqlOf = (n) => fs.readFileSync(path.join(__dirname, '..', 'db',
        fs.readdirSync(path.join(__dirname, '..', 'db')).find((f) => f.startsWith(`${n}_`))), 'utf8');
      const d677 = sqlOf('677');
      const d680 = sqlOf('680');
      const d681 = sqlOf('681');

      const EO = { key: 'eo', label: 'Settlement agent E&O insurance', required: true };
      const WIRE = { key: 'wire_instructions', label: 'Wire instructions', required: true };
      const ENGAGE = { key: 'engagement', label: 'Engagement letter', required: true };
      const CPL = { key: 'cpl', label: 'Closing protection letter', required: true };
      const STMT_OLD = { key: 'settlement_statement', label: 'Settlement statement', required: true };

      const PRE = [ENGAGE, WIRE, STMT_OLD];                     // before db/677
      const WITH_CPL = [ENGAGE, WIRE, CPL, EO, STMT_OLD];       // what db/677 wrote
      const NO_CPL = [ENGAGE, WIRE, EO, STMT_OLD];              // after db/680, before db/681
      const CORRECT = [WIRE, EO, { ...STMT_OLD, label: 'Preliminary settlement statement' }];
      /* A row somebody has EDITED: a re-labelled WIRE slot (one the owner
         confirmed, so it survives) and a slot they added. It must keep BOTH and
         still lose the CPL and the engagement letter — the owner's rules are
         about every row, and clobbering somebody's edit to enforce them would be
         its own defect. Deliberately NOT keyed on `engagement` any more: that
         slot is now removed by db/681, so using it as the "kept edit" example
         would assert the opposite of the rule. */
      const EDITED = [{ ...WIRE, label: 'Their wiring instructions' },
        ENGAGE, CPL, EO,
        { key: 'local_form', label: 'County transfer form', required: false }];

      const keysAfterReplay = async (start, times) => {
        const c = await db.pool.connect();
        try {
          await c.query('BEGIN');
          await c.query(`UPDATE checklist_templates SET slots=$1::jsonb WHERE code='lt_ny_settlement_docs' AND scope='lt_loan'`,
            [JSON.stringify(start)]);
          for (let i = 0; i < times; i += 1) { await c.query(d677); await c.query(d680); await c.query(d681); }
          const r = await c.query(`SELECT slots FROM checklist_templates WHERE code='lt_ny_settlement_docs' AND scope='lt_loan'`);
          return r.rows[0].slots;
        } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
      };

      for (const [name, start] of [['its pre-db/677 shape', PRE], ['the CPL db/677 added', WITH_CPL],
        ['the mid-correction shape', NO_CPL], ['already corrected', CORRECT]]) {
        const after = await keysAfterReplay(start, 1);
        const ks = after.map((x) => x.key).sort();
        /* Asserted as the WHOLE SET, not as "no CPL": the owner answered this
           item by item, so what must be true is that the row ends up as exactly
           those three — a leftover fourth slot is the failure that actually
           happened here (the engagement letter, carried forward unexamined). */
        assert(JSON.stringify(ks) === JSON.stringify(['eo', 'settlement_statement', 'wire_instructions']),
          `starting from ${name}, one boot leaves exactly the three the owner asked for (${ks.join(',')})`);
        assert((after.find((x) => x.key === 'settlement_statement') || {}).label === 'Preliminary settlement statement',
          '…and the statement is called what the letter asks for');
      }
      /* A SECOND boot must change nothing — the failure this catches is a
         migration that is not idempotent, which breaks every future deploy
         quietly, because migrate-boot logs the throw and carries on. */
      const once = await keysAfterReplay(WITH_CPL, 1);
      const twice = await keysAfterReplay(WITH_CPL, 3);
      assert(JSON.stringify(once) === JSON.stringify(twice), 'three boots leave exactly what one boot left');

      const edited = await keysAfterReplay(EDITED, 1);
      const ek = edited.map((x) => x.key);
      assert(!ek.includes('cpl') && !ek.includes('engagement'),
        `a hand-edited row loses the CPL and the engagement letter too (${ek.join(',')})`);
      assert(ek.includes('local_form'), '…and keeps the slot somebody added');
      assert((edited.find((x) => x.key === 'wire_instructions') || {}).label === 'Their wiring instructions',
        '…and keeps their own wording on a slot the owner confirmed');
    }

    console.log('\nS5. A document that names a slot the FILE does not have is filed with no slot');
    {
      const r = await desk.place(ny, 'title', { staffId });
      assert(r && r.ok === true, 'FIXTURE: the New York title order is placed');
      const handled = await reply(ny, ['CD.pdf', 'Wiring instructions.pdf', 'Title Commitment.pdf'], 'ny-1');
      assert(handled && Number(handled.filed) === 3, `all three documents are filed (${JSON.stringify(handled).slice(0, 140)})`);
      const docs = await filedOn(ny);
      const slot = (name) => { const d = docs.find((x) => x.filename === name); return d ? d.slot_label : '(not filed)'; };
      assert(slot('Title Commitment.pdf') === 'commitment', `the commitment still lands in its slot (${slot('Title Commitment.pdf')})`);
      assert(slot('CD.pdf') === null, `THE ONE THAT MATTERS: "CD.pdf" on a New York title order is filed with NO slot (${slot('CD.pdf')})`);
      assert(slot('Wiring instructions.pdf') === null, `…and so are the wiring instructions New York title was never asked for (${slot('Wiring instructions.pdf')})`);
      // The control: the same document on a New Jersey file DOES take the slot.
      await desk.cancel(nj, 'title', { staffId, reason: 'staged for the test' });
      await desk.place(nj, 'title', { staffId });
      const njHandled = await reply(nj, ['CD.pdf'], 'nj-2');
      assert(njHandled && Number(njHandled.filed) === 1, 'CONTROL: the New Jersey reply files');
      const njDocs = await filedOn(nj);
      const cd = njDocs.find((x) => x.filename === 'CD.pdf');
      assert(cd && cd.slot_label === 'prelim_settlement', `CONTROL: "CD.pdf" on a New Jersey title order takes prelim_settlement (${cd && cd.slot_label})`);
    }

    /* ═════════ S9. THE DESK RUNS THE RULES BEFORE IT IS READ ═════════════ */
    /* ═════════ S10. THE LETTER IS SIGNED BY WHOEVER PRESSED SEND ════════════ */
    console.log('\nS10. The order is signed by the person who sent it, not the file\'s officer');
    {
      const dataMod = require('../src/longterm/orders/data');
      const letterMod = require('../src/longterm/orders/letter');
      /* A SECOND staffer, who is NOT this file's loan officer — the fixture's
         officer IS `staffId`, so signing as the sender and signing as the officer
         would be indistinguishable without one. That is the whole reason this
         section seeds its own person rather than reusing the admin. */
      const sender = (await db.query(
        `INSERT INTO staff_users (email, full_name, role, title, is_active)
         VALUES ($1,'Sending Processor','processor','Loan Processor',true) RETURNING id`,
        [`${uniq}-sender@example.test`])).rows[0];
      const senderId = String(sender.id);

      const d = await dataMod.getOrderData(nj);
      assert(d && d.officer && d.officer.name === 'LT Guards Admin', 'FIXTURE: the file\'s officer is somebody else');
      const card = await dataMod.loadStaffCard(senderId);
      assert(card && card.name === 'Sending Processor' && card.title === 'Loan Processor',
        'the sender\'s own card reads back, title and all');

      /* BOTH RENDERERS. A title order is drawn by the SHORT-TERM desk's shared
         builder and everything else by this product's own; they are two code
         paths, so a `sender` wired into one and not the other would leave half
         the orders still signed by the officer — and title is the commonest
         order there is. */
      const genericSigned = letterMod.buildLetter('payoff', d, { sender: card });
      assert(/Sending Processor, Loan Processor/.test(genericSigned.html),
        'GENERIC LETTER: signed by the sender, with their real title');
      assert(!/LT Guards Admin/.test(genericSigned.html), '…and the file\'s officer is not on it');

      const genericFallback = letterMod.buildLetter('payoff', d, {});
      assert(/LT Guards Admin/.test(genericFallback.html),
        'CONTROL: with no sender — an automatic send, a worker retry — it falls back to the file\'s officer');

      const titleSigned = letterMod.buildLetter('title', d, { sender: card });
      assert(/Sending Processor, Loan Processor/.test(titleSigned.html),
        'TITLE LETTER (the shared short-term builder): signed by the sender too');
      assert(!/LT Guards Admin/.test(titleSigned.html), '…and not by the officer');
      const titleFallback = letterMod.buildLetter('title', d, {});
      assert(/LT Guards Admin/.test(titleFallback.html), 'CONTROL: and it falls back the same way');

      /* AND ON THE WIRE, through the real door with the real mailer stubbed —
         a builder that signs correctly proves nothing if the door never passes
         the actor down to it. */
      await desk.cancel(nj, 'title', { staffId, reason: 'staged for the signature test' });
      const before = sent.length;
      const placed = await desk.place(nj, 'title', { staffId: senderId });
      assert(placed && placed.ok === true, 'the order goes out');
      assert(sent.length === before + 1, '…and exactly one email reached the mailer');
      const wire = sent[sent.length - 1];
      assert(/Sending Processor/.test(wire.html), 'THE ONE THAT MATTERS: the email that actually went out is signed by the sender');
      assert(!/LT Guards Admin/.test(wire.html), '…and does not carry the officer\'s name or direct line');

      /* A departed or unknown staffer is not a signature: the letter falls back
         rather than going out signed by nobody. */
      assert((await dataMod.loadStaffCard(crypto.randomUUID())) === null, 'an unknown staff id resolves to nobody');
      await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1::uuid`, [senderId]);
      assert((await dataMod.loadStaffCard(senderId)) === null, '…and so does one who has left');
    }

    console.log('\nS9. The property becomes a condominium — the desk says the condo questionnaire applies');
    {
      const first = await call('GET', `/api/lt/orders/loans/${nj}`, token);
      assert(first.status === 200 && Array.isArray(first.json && first.json.orders), `the desk reads over HTTP (${first.status})`);
      const condoBefore = (first.json.orders || []).find((o) => o.kind === 'condo_questionnaire');
      assert(condoBefore && condoBefore.appliesToFile === false, `CONTROL: on a single-family file the condo questionnaire does not apply (${condoBefore && condoBefore.appliesToFile})`);
      assert(first.json.rules && typeof first.json.rules.evaluated === 'boolean', 'the desk reports whether the rules ran');

      // The mirror moves — exactly what the Encompass sync writes when a property changes.
      await db.query(`UPDATE lt_properties SET gse_property_type = 'Condominium', updated_at = now() WHERE loan_id = $1::uuid`, [nj]);
      await db.query(`UPDATE lt_loans SET encompass_synced_at = now() WHERE id = $1::uuid`, [nj]);

      const second = await call('GET', `/api/lt/orders/loans/${nj}`, token);
      const condoAfter = (second.json.orders || []).find((o) => o.kind === 'condo_questionnaire');
      assert(second.json.rules && second.json.rules.evaluated === true, `the desk ran the rules because the file was due (${JSON.stringify(second.json.rules)})`);
      assert(condoAfter && condoAfter.appliesToFile === true, `THE ONE THAT MATTERS: the condo questionnaire now applies (${condoAfter && condoAfter.appliesToFile})`);
      assert(!!(await condOf(nj, 'lt_condo_questionnaire_ordered')), '…because the engine attached its condition');
      const vendors = await call('GET', `/api/lt/orders/loans/${nj}/vendors`, token);
      assert(vendors.status === 200 && vendors.json && 'rules' in vendors.json, 'the contacts read runs the same door');
    }
  } finally {
    server.close();
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

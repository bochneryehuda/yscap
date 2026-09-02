#!/usr/bin/env node
'use strict';
/**
 * LT — THE A-TO-Z WALK OF THE WHOLE CONDITION CENTER, ON ONE REAL FILE.
 *
 * Owner-directed 2026-08-31, the last item of a ten-item batch:
 *
 *   *"And do another A to Z order to make sure the entire section actually works
 *   and it's like we intended."*
 *
 * ── WHY THIS EXISTS WHEN EVERY ITEM ALREADY HAS ITS OWN SUITE ───────────────
 *
 * Each of the ten changes is proven on its own, and that is the right place for
 * its rules. NONE of those suites can see whether the ten COMPOSE: they each
 * build the file their own rule needs, so a change that is correct in isolation
 * and wrong beside its neighbour passes all of them. Every defect the first
 * A-to-Z audit found (`test-lt-order-audit-db.js`) was of exactly that shape — a
 * disagreement between two modules that were each right alone.
 *
 * So this walks ONE file the way a person works it, in order, and asks at each
 * step whether what is on the screen is what the owner asked for:
 *
 *   A. the section a refinance for a RENTING borrower in a flood zone opens with
 *   B. …and what a file with NO flood answer is not asked for  (the control)
 *   C. the file contacts desk: who is asked for, and who is greyed until the
 *      file says they apply
 *   D. the housing history following how the borrower lives
 *   E. the rent form confirmed before the order may go out
 *   F. the landlord remembered against the HOME, not the person
 *   G. the mortgage statement reading itself, and the FCI way answering the
 *      servicer
 *   H. what comes back from an order landing in a slot that exists
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * It is not a second copy of the ten suites' assertions. Where a rule is fully
 * pinned elsewhere this asserts only that it HOLDS ON THIS FILE, beside the other
 * nine — the composition, which is the thing nothing else can see.
 *
 * ── WHAT THE AUDIT ITSELF TURNED UP ────────────────────────────────────────
 *
 * Two things, and both are the reason to walk a file rather than re-read ten
 * suites:
 *
 *   1. A FAIL-OPEN ON THE CONTACTS DESK. `read.fileContactTypes` takes the
 *      database CLIENT; handed `{ db: client }` — the shape every sibling module
 *      takes — `liveFieldValues` swallowed the error and answered a full list on
 *      which every conditional contact read "not established on this file yet".
 *      The landlord, the HOA, the flood agent and the New York settlement agent
 *      all quietly greyed on a file where they apply, with nothing anywhere
 *      saying so. The module's own comment warned about it and this fixture
 *      walked straight in, which is how live the trap was; it now REFUSES a
 *      client with no `.query`, because a caller's mistake is not a degraded
 *      read. A real read failure still degrades exactly as before.
 *   2. A COVERAGE GAP IN THIS SUITE, found by its own mutation battery: section C
 *      asserted the landlord, the HOA and the New York agent and NOT the flood
 *      agent — the one contact the batch's flood item is about — so making it
 *      unconditional again passed. Sections B and C now assert it from both
 *      sides.
 *
 * ── PROVEN TO FAIL ──────────────────────────────────────────────────────────
 *
 * Eight mutations of the production code, each with a green control either side:
 * the attorney becoming a pre-submittal contact again (1 fail — it reaches the
 * SEEDED template through no migration, so it is caught by the library-versus-
 * seeded comparison rather than by the list itself); the flood agent offered on
 * every file again (2); the landlord greyed on a file whose borrower rents (1);
 * the rent form no longer needing to be confirmed before the order (2); the rent
 * order filing its answer into another condition (1); the desk answering a
 * greyed-out list instead of refusing a caller's mistake (1); and the landlord
 * memory keyed on the person rather than the home, so somebody who moved is
 * offered their old landlord (1); and the pre-fill overwriting a landlord
 * somebody had already put on the file (1).
 *
 * ROLLS BACK. Everything runs in one transaction that is rolled back, so a local
 * database does not accumulate files (the sibling order audit commits, and 200
 * accumulated loans is what pushes an unrelated suite's fixtures off the
 * pipeline's first page).
 *
 * DB-GATED.
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
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-condition-center-a-to-z');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const read = require('../src/longterm/conditions-center/read.js');
  const write = require('../src/longterm/conditions-center/write.js');
  const answers = require('../src/lib/conditions/answers.js');
  const kinds = require('../src/longterm/orders/kinds.js');
  const orderData = require('../src/longterm/orders/data.js');
  const vorDesk = require('../src/longterm/vor/desk.js');
  const landlord = require('../src/longterm/landlord-memory.js');
  const reader = require('../src/longterm/mortgage-statement-read.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');
    const stamp = Date.now();

    /* ── THE FILE, built the way the sync builds one ────────────────────────
       A cash-out refinance, a borrower who RENTS where they live, on a property
       Encompass says is in a flood zone. That one file is deliberately the
       intersection of every rule in the batch: it is the only shape on which all
       ten can be seen at once. */
    const borrower = (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Avi','Walkthrough',$1) RETURNING id`,
      [`atoz-${stamp}@example.test`])).rows[0].id;

    const makeLoan = async (tag, { rents = true, flood = true, zone = 'AE', street = '9 Rented Rd' } = {}) => {
      const id = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose, borrower_name)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr','cash_out_refinance'::lt_loan_purpose,'Avi Walkthrough')`,
        [id, borrower, `AZ-${tag}-${stamp}`]);
      await cx.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type,
                                    in_flood_zone, flood_zone, flood_zone_source)
         VALUES ($1::uuid,'4 Subject Way','Anytown','NJ','07001',1,'SFR',$2,$3,$4)`,
        [id, flood === null ? null : flood, flood === null ? null : zone, flood === null ? null : 'encompass']);
      const pair = (await cx.query(
        `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES ($1::uuid,$2::uuid,1) RETURNING id`,
        [crypto.randomUUID(), id])).rows[0].id;
      const party = (await cx.query(
        `INSERT INTO lt_parties (id, pair_id, role, party_type, first_name, last_name, borrower_id)
         VALUES ($1::uuid,$2::uuid,'borrower','individual','Avi','Walkthrough',$3::uuid) RETURNING id`,
        [crypto.randomUUID(), pair, borrower])).rows[0].id;
      if (rents) {
        await cx.query(
          `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, street, city, state, zip)
           VALUES ($1::uuid,$2::uuid,'current','rent',$3,'Anytown','NJ','07001')`,
          [crypto.randomUUID(), party, street]);
      }
      await engine.evaluateLoan(id, { db: cx });
      return id;
    };

    /* READ IT THE WAY THE SCREEN DOES. Reading `checklist_items` directly shows
       every slot on every file and would prove nothing about the branching —
       `forLoan` is what applies each slot's `whenField` against the file's own
       live facts, so it is the only honest source for these assertions. */
    const sectionOf = async (loanId) => {
      const out = await read.forLoan(loanId, { db: cx, audience: 'internal' });
      const conditions = (out.buckets || []).flatMap((b) => (b.conditions || []));
      return { out, conditions, byCode: new Map(conditions.map((c) => [c.code, c])) };
    };

    const loan = await makeLoan('main');

    // ── A. WHAT THE FILE OPENS WITH ─────────────────────────────────────────
    console.log('\nA. THE SECTION A REFINANCE OPENS WITH');
    const A = await sectionOf(loan);
    {
      ok(A.byCode.has('lt_file_contacts'),
        'the pre-submittal contacts condition is there');
      const ct = (A.byCode.get('lt_file_contacts') || {}).contactTypes || [];
      const keys = ct.map((t) => t.key).sort();
      /* ITEM 1, on the live file: *"Our attorney, Realtor, Buyer's Attorney —
         those open slots should be only in the file context and not… a condition
         before submittal. The only stuff that should be a condition before
         submittal is the title company and the hazard insurance agent."* */
      /* …and, since 2026-09-02 (db/674), the three that follow the deal — the
         landlord, the HOA and the settlement agent — each on the same
         condition, each greyed by its own fact on a file that does not need it. */
      ok(JSON.stringify(keys) === JSON.stringify(['hazard_insurance', 'hoa', 'landlord', 'ny_settlement_agent', 'title']),
        'and it asks for the title company and the hazard insurance agent on every file, plus the landlord, the HOA and the settlement agent when the deal calls for them',
        keys.join(','));
      const byKey = Object.fromEntries(ct.map((t) => [t.key, t]));
      ok(byKey.title.applies === true && byKey.hazard_insurance.applies === true,
        '…the two apply to this file outright');
      ok(['landlord', 'hoa', 'ny_settlement_agent'].every((k) => byKey[k]
        && [true, false, null].includes(byKey[k].applies)
        && (byKey[k].applies === true || typeof byKey[k].whyNot === 'string')),
        '…and each of the three is answered from the file\'s own facts — on, off with a reason, or "cannot tell yet" with a reason — never assumed on',
        JSON.stringify(['landlord', 'hoa', 'ny_settlement_agent'].map((k) => [k, byKey[k] && byKey[k].applies])));
      for (const gone of ['our_attorney', 'realtor', 'buyers_attorney']) {
        ok(!keys.includes(gone), `…the ${gone} is not a condition before submittal`);
      }
      /* AND THE AUTHORED LIST IS THE LIVE ONE. Everything above reads the SEEDED
         template, which is what a live file actually shows — and `library.seed`
         is `ON CONFLICT (code) DO NOTHING`, so a change made in the library alone
         reaches a NEW database and no existing one. Without this line the two
         could drift indefinitely and every assertion above would still pass,
         while a new tenant got a different pre-submittal list from every tenant
         that already exists. */
      const authored = lib.FILE_CONTACT_TYPES.filter((t) => t.preSubmission).map((t) => t.key).sort();
      ok(JSON.stringify(authored) === JSON.stringify(keys),
        '…and the library and the seeded condition ask for the SAME two — neither can move alone',
        `library=${authored.join(',')} seeded=${keys.join(',')}`);

      /* ITEMS 5 AND 6: two conditions were RETIRED, and a retired condition that
         still lands on a new file is the whole failure. */
      ok(!A.byCode.has('lt_landlord_contact'),
        'the standalone landlord condition is gone from a new file');
      const payoffServicer = A.conditions.find((c) => /servicer/i.test(c.code || ''));
      ok(!payoffServicer,
        'and so is the separate "servicer of the loan being paid off"',
        payoffServicer && payoffServicer.code);

      // ITEM 2, the positive half: Encompass said flood zone, so the agent is asked for.
      ok(A.byCode.has('lt_order_flood_insurance'),
        'a file Encompass puts in a flood zone IS asked for the flood insurance order');

      // The rest of the batch's conditions are all on the one file together.
      for (const code of ['lt_subject_mortgage_statement', 'lt_housing_history',
        'lt_payoff_received', 'lt_vor_sent', 'lt_payoff_ordered']) {
        ok(A.byCode.has(code), `${code} is on the file`);
      }
    }

    // ── B. THE CONTROL: no flood answer, no flood agent ─────────────────────
    console.log('\nB. AND A FILE NOBODY HAS ANSWERED THE FLOOD QUESTION ON');
    {
      const dry = await makeLoan('dry', { flood: null });
      const B = await sectionOf(dry);
      /* ITEM 2's real point. Before this batch the flood agent was asked for on
         EVERY file; the fix is worth nothing if it now asks on none, so both
         directions are walked. */
      ok(!B.byCode.has('lt_order_flood_insurance'),
        'is not asked for a flood insurance order at all');
      ok(B.byCode.has('lt_file_contacts'),
        '…while everything that applies to every file is still there');
      /* AND THE DESK AGREES WITH THE CONDITION. The order card and the contact
         row are two different modules answering one question, and item 2 is
         worth nothing if they disagree — a greyed contact beside a live order is
         how somebody ends up unable to address a card the file is asking for. */
      const bTypes = await read.fileContactTypes(dry, cx);
      const bFlood = (bTypes || []).find((t) => t.key === 'flood_insurance') || {};
      ok(bFlood.applies !== true,
        '…and the flood insurance agent is not offered on the desk either',
        String(bFlood.applies));
      ok(bFlood.applies === null,
        '…it reads as NOT ESTABLISHED rather than a confident no, because nobody has answered',
        String(bFlood.applies));
    }

    // ── C. THE FILE CONTACTS DESK ───────────────────────────────────────────
    console.log('\nC. THE FILE CONTACTS DESK SHOWS WHO APPLIES, AND GREYS THE REST');
    {
      /* IT TAKES THE CLIENT ITSELF, not `{ db: client }` — `liveFieldValues`
         swallows the resulting error and answers a context whose every field is
         null, which reads as a confident "nothing applies to this file". The
         module's own comment warns about it and this fixture walked straight in,
         which is how live the trap is. */
      const types = await read.fileContactTypes(loan, cx);
      ok(Array.isArray(types) && types.length > 0,
        'the desk lists the contacts a file can carry', String(types && types.length));
      const by = new Map((types || []).map((t) => [t.key, t]));
      /* `applies` is THREE-VALUED on purpose — true, false, or null for "the file
         has not said yet" — so it is read as itself rather than squeezed into a
         boolean, which is how "we cannot tell" quietly becomes "no". */
      const applies = (k) => (by.get(k) || {}).applies;
      /* ITEM 3: *"there should be the same logic that we have by New York
         settlement agents: it's grayed out. We should also have the HOA contact…
         the landlord contact information if the person is renting his primary
         residence, and if not, it should also be grayed out."* The NY agent is
         the SHAPE this was asked to copy, so it is asserted beside them — a file
         in New Jersey greys it, and this file's renting borrower does not grey
         the landlord. */
      ok(by.has('landlord'), 'the landlord is a contact on the desk');
      ok(by.has('hoa'), 'and so is the HOA');
      ok(by.has('ny_settlement_agent'), 'beside the New York settlement agent it copies');
      ok(applies('landlord') === true,
        'the landlord applies on a file whose borrower RENTS — not greyed');
      ok(applies('ny_settlement_agent') === false,
        '…while the New York settlement agent is greyed on a New Jersey file');
      ok(applies('hoa') === false,
        '…and the HOA is greyed on a file that is not a condo');
      ok(applies('flood_insurance') === true,
        'the flood insurance agent applies on a file Encompass puts in a flood zone');
      ok(applies('title') === true && applies('hazard_insurance') === true,
        'and the two that apply to every file always apply');

      /* AND THE TRAP THIS FIXTURE FELL INTO IS CLOSED. Handing the desk an
         options object instead of the client used to answer a full list on which
         every conditional contact read "not established yet" — the landlord, the
         HOA, the flood agent and the New York settlement agent all greyed on a
         file where they apply, with nothing anywhere saying so. It refuses now,
         because a caller's mistake is not a degraded read. */
      let refused = null;
      try { await read.fileContactTypes(loan, { db: cx }); } catch (e) { refused = e; }
      ok(!!refused,
        'and handing it an options object instead of the client is REFUSED, never answered with a greyed-out desk');
    }

    // ── D. THE HOUSING HISTORY FOLLOWS HOW THEY LIVE ────────────────────────
    console.log('\nD. THE HOUSING HISTORY FOLLOWS HOW THE BORROWER LIVES');
    {
      const hh = A.byCode.get('lt_housing_history');
      const slots = (hh && hh.slots) || [];
      const keys = slots.map((s) => s.key);
      // ITEM 8: one branch per basis, and only the branch this file is on.
      ok(keys.includes('vor'), 'a renting borrower is asked for the rent verification');
      ok(!keys.includes('vom_primary') && !keys.includes('rent_free_letter'),
        '…and NOT for a mortgage verification or a rent-free letter, which cannot exist on this file',
        keys.join(','));
      const vorSlot = slots.find((s) => s.key === 'vor') || {};
      ok(/verification of rent order/i.test(String(vorSlot.hint || '')),
        '…and the slot says the rent order fills it in');
      ok(/upload/i.test(String(vorSlot.hint || '')),
        '…while still promising it can be uploaded by hand');
    }

    // ── E. THE RENT FORM IS CONFIRMED BEFORE THE ORDER GOES OUT ─────────────
    console.log('\nE. THE RENT FORM IS CONFIRMED BEFORE THE ORDER MAY GO OUT');
    {
      const contact = (await cx.query(
        `INSERT INTO service_contacts (contact_type, company_name, contact_name, email, phone)
         VALUES ('landlord','Anytown Property Mgmt','Lee Landlord',$1,'555-0100') RETURNING id`,
        [`landlord-${stamp}@example.test`])).rows[0].id;
      /* THE CARD IS ADDRESSED BY VENDOR KIND, and the rent order's is `landlord`
         — its own `vendorKind`, read off the registry rather than typed here, so a
         fixture can never address a different card than the order does. */
      await cx.query(
        `INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id)
         VALUES ($1::uuid,$3,$2::uuid) ON CONFLICT DO NOTHING`,
        [loan, contact, kinds.orderKind('vor').vendorKind]);

      const form = await vorDesk.loadForm(loan, cx);
      ok(!!form, 'the rent form opens on the file');
      /* FILL IT FROM THE FIELD DEFINITIONS, and only OUR OWN half — answering for
         the landlord is the one thing a rent verification may never do, and
         `cleanOurData` drops a landlord key at the door anyway. `missing` is the
         same function the send gate asks, so the fixture cannot fill a set the
         gate does not recognise. */
      const vorFields = require('../src/longterm/vor/fields.js');
      const filled = { ...(form.data || {}) };
      for (const f of vorFields.ourFields()) {
        if (!filled[f.key]) filled[f.key] = (Number(f.lines) > 1) ? 'Line one\nLine two' : 'Filled in';
      }
      await vorDesk.saveForm(loan, filled, null, cx);
      const stillMissing = vorFields.missing((await vorDesk.loadForm(loan, cx)).data);
      ok(!stillMissing || stillMissing.length === 0,
        'every one of our own answers is filled in', JSON.stringify(stillMissing));

      const before = await orderData.getOrderData(loan, cx);
      const blocked = orderData.blockers('vor', before);
      // ITEM 10: *"the form fill-out… needs to be confirmed before you can order."*
      ok(blocked.includes('form_not_confirmed'),
        'a filled but UNCONFIRMED form still blocks the order', blocked.join(','));

      const conf = await vorDesk.confirmForm(loan, null, cx);
      ok(conf && conf.ok === true, 'confirming it is accepted', conf && conf.message);
      const after = orderData.blockers('vor', await orderData.getOrderData(loan, cx));
      ok(!after.includes('form_not_confirmed'),
        '…and the order stops being held for it', after.join(','));

      /* AND THE CONFIRMATION IS ABOUT THESE WORDS. Editing the form after
         confirming must un-confirm it, or the thing that went out is not the
         thing anybody agreed to. */
      const first = vorFields.ourFields()[0];
      ok(!!first, 'the form has our own fields to edit', String(first && first.key));
      const edited = { ...filled, [first.key]: 'Something else entirely' };
      await vorDesk.saveForm(loan, edited, null, cx);
      const reblocked = orderData.blockers('vor', await orderData.getOrderData(loan, cx));
      ok(reblocked.includes('form_not_confirmed'),
        'and an edit after that puts the confirmation back to unconfirmed');
    }

    // ── F. THE LANDLORD IS REMEMBERED AGAINST THE HOME ──────────────────────
    console.log('\nF. THE LANDLORD IS REMEMBERED AGAINST THE HOME, NOT THE PERSON');
    {
      const remembered = await landlord.rememberForLoan(loan, { db: cx });
      ok(remembered && Number(remembered.remembered) >= 1,
        'the landlord on this file is remembered', JSON.stringify(remembered));

      const same = await makeLoan('same', { street: '9 Rented Rd' });
      const s1 = await landlord.suggestForLoan(same, { db: cx });
      // ITEM 4: the same person at the SAME address gets their landlord back…
      ok(s1 && s1.contactId, 'a later loan at the SAME home is offered that landlord', JSON.stringify(s1));

      const moved = await makeLoan('moved', { street: '77 New Place Ave' });
      const s2 = await landlord.suggestForLoan(moved, { db: cx });
      /* …and a person who MOVED is offered nothing, which is the whole rule:
         *"if his primary address has been updated in Encompass, then you should
         not automatically populate his landlord because probably the landlord
         changed."* */
      ok(s2 && !s2.contactId,
        '…and a loan after they MOVED is offered nobody', JSON.stringify(s2));

      /* AND THE MEMORY REACHES THE ORDER, which is the other half of item 4:
         *"you need to tie the landlord information… directly to the verification
         of rent order."* A suggestion nobody acts on is a fact in a table; what
         the owner asked for is the rent order finding its landlord already
         there. Read back off `lt_loan_vendors` under the order's OWN vendor
         kind, so this cannot pass against a row the order would not look at. */
      const applied = await landlord.applyForLoan(same, { db: cx });
      ok(applied && applied.applied === true,
        'the remembered landlord is put on the later file', JSON.stringify(applied));
      const onOrder = (await cx.query(
        `SELECT service_contact_id FROM lt_loan_vendors WHERE loan_id = $1::uuid AND kind = $2`,
        [same, kinds.orderKind('vor').vendorKind])).rows;
      ok(onOrder.length === 1 && String(onOrder[0].service_contact_id) === String(s1.contactId),
        '…as the card the verification of rent order is addressed to',
        JSON.stringify(onOrder));

      /* A LANDLORD SOMEBODY ALREADY PUT ON THE FILE IS NEVER REPLACED — this is
         a pre-fill, and a second pass must leave a person's own answer alone. */
      const again = await landlord.applyForLoan(same, { db: cx });
      ok(again && again.applied === false && again.why === 'already_on_file',
        '…and a second pass leaves what is already on the file alone', JSON.stringify(again));

      const movedApply = await landlord.applyForLoan(moved, { db: cx });
      ok(movedApply && movedApply.applied === false,
        '…while the file for the home they moved to is given nobody', JSON.stringify(movedApply));
    }

    // ── G. THE MORTGAGE STATEMENT, ON THIS SAME FILE ────────────────────────
    console.log('\nG. THE MORTGAGE STATEMENT READS ITSELF, AND FCI ANSWERS THE SERVICER');
    {
      const stmt = A.byCode.get('lt_subject_mortgage_statement');
      const PAGE = [
        'FCI LENDER SERVICES, INC.', 'MORTGAGE STATEMENT',
        'Serviced by: FCI Lender Services, Inc.',
        'Loan Number: 0091883421',
        'Outstanding Principal Balance: $318,442.19',
        'Escrow Balance: $2,204.10', 'Amount Due: $2,410.55',
      ].join('\n');
      const r = await reader.fillFromUpload(
        { loanId: loan, conditionId: stmt.id, code: reader.CODE,
          documentId: crypto.randomUUID(), storageRef: 'ref' },
        {
          db: cx,
          storage: { read: async () => Buffer.from('bytes') },
          ocr: { configured: () => true, read: async () => ({ ok: true, text: PAGE }) },
          ai: { available: () => false },
        });
      ok(r.filled === true, 'an uploaded statement fills the condition in', r.detail || r.why || '');
      const a = (await cx.query('SELECT tool_payload AS a FROM checklist_items WHERE id=$1::uuid',
        [stmt.id])).rows[0].a;
      ok(a && Number(a.values.outstanding_balance) === 318442.19,
        '…with the outstanding principal balance, not the escrow or the amount due');
      ok(/mortgage statement/i.test(String(answers.sourceNote(a) || '')),
        '…and it says where the figures came from');

      // The FCI way, on the same condition: it answers the servicer itself.
      const w = await write.recordAnswer(loan, stmt.id, {
        way: 'fci_serviced', values: { loan_number: 'FCI-4471', outstanding_balance: 388000 },
      }, null, cx);
      ok(w.ok === true, 'and choosing FCI instead is accepted with its two numbers', w.error || '');
      const b = (await cx.query('SELECT tool_payload AS a FROM checklist_items WHERE id=$1::uuid',
        [stmt.id])).rows[0].a;
      ok(b.values.servicer === answers.FCI_SERVICER,
        '…with the servicer answered by the choice itself');
    }

    // ── H. WHAT COMES BACK LANDS SOMEWHERE ──────────────────────────────────
    console.log('\nH. WHAT COMES BACK FROM AN ORDER LANDS IN A SLOT THAT EXISTS');
    {
      /* ITEMS 8 AND 9, as one question: an order names the condition its answer
         files into AND the slot it lands in — and that slot has to be ON that
         condition on THIS file, which is the half no registry test can see. */
      const pairs = [
        ['vor', 'lt_housing_history', 'Verification of Rent - completed.pdf'],
        ['payoff', 'lt_payoff_received', 'Payoff Demand 2026-09-30.pdf'],
      ];
      for (const [kind, code, filename] of pairs) {
        const def = kinds.orderKind(kind);
        ok(def && def.docCondition === code, `the ${kind} order files into ${code}`);
        const slot = kinds.slotForFilename(kind, filename);
        ok(!!slot, `…and a returned "${filename}" is given a slot`, String(slot));
        const cond = (await sectionOf(loan)).byCode.get(code);
        const has = ((cond && cond.slots) || []).some((s) => s.key === slot);
        ok(has, `…which really is a slot on ${code} on this file`,
          ((cond && cond.slots) || []).map((s) => s.key).join(','));
      }
      const payoff = (await sectionOf(loan)).byCode.get('lt_payoff_received');
      ok(/payoff order/i.test(String((payoff && payoff.hint) || '')),
        'and payoff received says the payoff order feeds it');
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

#!/usr/bin/env node
/**
 * THE A-TO-Z ORDER AUDIT — every order, on a real file, from the contact form to
 * the message on the wire.
 *
 * Owner-directed 2026-08-31: *"Make sure each and every FileContacts should be
 * linked to the correct order … Do a lot of A to Z order to make sure everything
 * is linked to the correct place"*, and the report behind it: *"I know all the
 * orders are automatically a problem because the FileContacts is one dummy, and
 * the orders are not linked to the correct FileContacts, so you can't even send
 * it out."*
 *
 * ── WHY IT HAS TO BE THIS, AND NOT A UNIT TEST ──────────────────────────────
 *
 * Every one of the five defects this audit found is invisible to a unit test of
 * any single module, because each is a DISAGREEMENT BETWEEN TWO MODULES that are
 * each correct on their own:
 *
 *   1. NOTHING PROMPTED FOR THE PAYOFF CONTACT. Six of the seven orders had a
 *      condition that collects their contact; the payoff had none, so on every
 *      refinance the order sat saying "add them on the file contacts" and the
 *      condition never asked. The registry was right and the library was right.
 *   2. A RETURNED PAYOFF STATEMENT FILED IN NO SLOT while its condition carried a
 *      REQUIRED `payoff` slot — so the document arrived and the condition still
 *      read as missing it.
 *   3. THE RETURNED VOR LIKEWISE, and a bare `verification` pattern would have
 *      swallowed a verification of MORTGAGE into the rent slot.
 *   4. THE PAYOFF AND VOR CARDS APPLIED TO EVERY FILE — `orders/applies.js` kept
 *      its own table of which orders belong on which file and simply had no entry
 *      for either, so a purchase showed a payoff order and an owner-occupier a
 *      landlord one.
 *   5. A GREYED CARD COULD STILL BE SENT. `canOrder` was true on a card the desk
 *      had greyed, and `place` cheerfully mailed a verification of rent to a
 *      landlord who does not exist.
 *
 * So this suite builds two real files — one that every order applies to, one that
 * almost none do — and walks them the way a person does.
 *
 * NOTHING LEAVES THE BUILDING: `lib/email` is stubbed and the send is asserted ON
 * THE WIRE PAYLOAD. A passing send against the `none` provider proves nothing
 * about who was addressed, which is this repo's standing rule for outbound mail.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

(async () => {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-order-audit');
  const crypto = require('crypto');

  // Stub the mailer BEFORE anything requires it, and keep every payload.
  const sent = [];
  const mailPath = require.resolve('../src/lib/email/index.js');
  const realMail = require(mailPath);
  require.cache[mailPath].exports = {
    ...realMail,
    sendMail: async (m) => { sent.push(m); return { ok: true, id: 'stub', provider: 'stub' }; },
  };

  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const deskMod = require('../src/longterm/orders/desk.js');
  const kinds = require('../src/longterm/orders/kinds.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const tag = `ordaudit${Date.now()}`;

  /** A whole long-term file, with a named borrower so nothing is blocked for want of one. */
  const makeFile = async (name, { purpose, state, propertyType, flood, rents }) => {
    const borrower = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Audit',$1,$2) RETURNING id`,
      [name, `${tag}.${name}@example.test`])).rows[0].id;
    const loan = crypto.randomUUID();
    await db.query(
      `INSERT INTO lt_loans (id,borrower_id,loan_number,program_name,loan_purpose,borrower_name)
       VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr',$4::lt_loan_purpose,'Avi Auditor')`,
      [loan, borrower, `ORD-${tag}-${name}`, purpose]);
    await db.query(
      `INSERT INTO lt_properties (loan_id,street,city,state,zip,unit_count,gse_property_type,in_flood_zone)
       VALUES ($1::uuid,'1 Audit St','Anytown',$2,'10001',1,$3,$4)`,
      [loan, state, propertyType, flood]);
    const pair = (await db.query(
      `INSERT INTO lt_borrower_pairs (id,loan_id,pair_number) VALUES ($1::uuid,$2::uuid,1) RETURNING id`,
      [crypto.randomUUID(), loan])).rows[0].id;
    const party = (await db.query(
      `INSERT INTO lt_parties (id,pair_id,role,party_type,first_name,last_name)
       VALUES ($1::uuid,$2::uuid,'borrower','individual','Avi','Auditor') RETURNING id`,
      [crypto.randomUUID(), pair])).rows[0].id;
    if (rents) {
      await db.query(
        `INSERT INTO lt_residences (id,party_id,residency_type,residency_basis,street,city,state,zip)
         VALUES ($1::uuid,$2::uuid,'current','rent','9 Rented Rd','Anytown',$3,'10001')`,
        [crypto.randomUUID(), party, state]);
    }
    await engine.evaluateLoan(loan, { db });
    return loan;
  };

  const codesOn = async (loan) => (await db.query(
    `SELECT t.code FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.lt_loan_id = $1::uuid`, [loan])).rows.map((r) => r.code);

  try {
    console.log('\nA. EVERY ORDER\'S CONTACT IS ASKED FOR ON A CONDITION');
    /* THE DEFECT THAT STARTED THIS. Six of seven orders were prompted for; the
       payoff was not, so its order could never be addressed from the place a
       person is actually working. This is the whole-registry version of that
       question, so a NEW order kind cannot ship without one either. */
    const collected = new Map();
    for (const c of lib.library()) {
      for (const ct of ((c.config || {}).contactTypes) || []) collected.set(ct.key, c.code);
    }
    for (const k of kinds.ORDER_KIND_KEYS) {
      const vk = kinds.vendorKindFor(k);
      check(collected.has(vk),
        `the ${k} order's ${vk} contact is collected on a condition (${collected.get(vk) || 'NOTHING COLLECTS IT'})`);
    }

    console.log('\nB. EVERY REQUIRED SLOT HAS SOMETHING THAT FILES INTO IT');
    /* A required slot nothing can auto-file into leaves a condition reading as
       missing the document that is sitting on it. That was the payoff. */
    for (const k of kinds.ORDER_KIND_KEYS) {
      const def = kinds.orderKind(k);
      const doc = lib.library().find((c) => c.code === def.docCondition);
      if (!doc) { check(false, `${k} names a document condition that exists`); continue; }
      const targets = new Set((def.slotMap || []).map((p) => p[1]).filter(Boolean));
      for (const s of (doc.slots || [])) {
        if (!s.required) continue;
        check(targets.has(s.key), `${k}: a returned document can reach the required "${s.key}" slot`);
      }
    }
    // And the ordering that keeps a look-alike out of the wrong slot.
    check(kinds.slotForFilename('vor', 'Verification of Mortgage.pdf') === 'vom_primary',
      'a verification of MORTGAGE does not land in the rent slot — a document in the wrong slot reads as satisfied');
    check(kinds.slotForFilename('vor', 'Verification of Rent signed.pdf') === 'vor',
      'while the rent verification does');
    check(kinds.slotForFilename('payoff', 'Payoff Demand.pdf') === 'payoff',
      'and a payoff statement reaches the one slot its condition has');

    console.log('\nC. A FILE EVERY ORDER APPLIES TO — the contacts resolve and it sends');
    const wide = await makeFile('wide', {
      purpose: 'cash_out_refinance', state: 'NY', propertyType: 'Condominium', flood: true, rents: true,
    });
    const wideCodes = await codesOn(wide);
    check(wideCodes.includes('lt_payoff_contact'),
      'the refinance is asked who services the loan being paid off');

    // Enter one contact per order, through the vendor link the contact form writes.
    for (const k of kinds.ORDER_KIND_KEYS) {
      const vk = kinds.vendorKindFor(k);
      const dir = kinds.directoryTypeFor(vk);
      const sc = (await db.query(
        `INSERT INTO service_contacts (company_name,contact_name,email,emails,contact_type,custom_type)
         VALUES ($1,'A Person',$2,ARRAY[$2]::text[],$3,$4) RETURNING id`,
        [`${vk} Co ${tag}`, `${vk}.${tag}@vendor.test`, dir.contactType, dir.customType])).rows[0].id;
      await db.query(
        `INSERT INTO lt_loan_vendors (loan_id,kind,service_contact_id,is_primary) VALUES ($1::uuid,$2,$3::uuid,true)`,
        [wide, vk, sc]);
    }

    const deskWide = await deskMod.desk(wide, db);
    for (const o of deskWide.orders) {
      check(o.appliesToFile === true, `${o.kind} applies to this file`);
      check(o.to.length === 1 && o.to[0] === `${o.vendorKind}.${tag}@vendor.test`,
        `${o.kind} is addressed to its OWN contact, not another order's (${o.to.join(',') || 'nobody'})`);
      check(o.canOrder === true, `${o.kind} is ready to send (${o.blockerText.join(' | ')})`);
    }

    for (const o of deskWide.orders) {
      const before = sent.length;
      const r = await deskMod.place(wide, o.kind, { db, actor: { name: 'Auditor', email: 'auditor@yscapgroup.com' } });
      check(r && r.ok === true, `${o.kind} sends (${r && r.ok ? 'ok' : (r && (r.error || r.reason))})`);
      const mail = sent[sent.length - 1];
      check(sent.length === before + 1, `${o.kind} put exactly one message on the wire`);
      check(mail && Array.isArray(mail.to) && mail.to[0] === `${o.vendorKind}.${tag}@vendor.test`,
        `${o.kind} really went TO its contact (${mail ? JSON.stringify(mail.to) : 'nothing'})`);
      check(!!(mail && /ORD-/.test(mail.subject || '')) && /Avi Auditor/.test((mail && mail.subject) || ''),
        `${o.kind}'s subject names the loan and the borrower — "${mail && mail.subject}"`);
      check(!!(mail && mail.replyTo), `${o.kind} carries a reply address, so what comes back files itself`);
    }
    const condoMail = sent.find((m) => /Condominium Questionnaire/i.test(m.subject || ''));
    check(!!(condoMail && (condoMail.attachments || []).length === 1),
      'the condo order carries its blank questionnaire — the one order with a form to fill in');

    console.log('\nD. A FILE ALMOST NONE OF THEM APPLY TO — greyed, WITH A REASON, AND REFUSED');
    const narrow = await makeFile('narrow', {
      purpose: 'purchase', state: 'NJ', propertyType: 'SFR', flood: false, rents: false,
    });
    for (const k of ['payoff', 'vor', 'condo_questionnaire', 'flood_insurance', 'ny_settlement_agent']) {
      const vk = kinds.vendorKindFor(k);
      const dir = kinds.directoryTypeFor(vk);
      const sc = (await db.query(
        `INSERT INTO service_contacts (company_name,contact_name,email,emails,contact_type,custom_type)
         VALUES ($1,'A Person',$2,ARRAY[$2]::text[],$3,$4) RETURNING id`,
        [`n ${vk} ${tag}`, `n.${vk}.${tag}@vendor.test`, dir.contactType, dir.customType])).rows[0].id;
      await db.query(
        `INSERT INTO lt_loan_vendors (loan_id,kind,service_contact_id,is_primary) VALUES ($1::uuid,$2,$3::uuid,true)`,
        [narrow, vk, sc]);
    }
    const deskNarrow = await deskMod.desk(narrow, db);
    const narrowCodes = await codesOn(narrow);
    for (const o of deskNarrow.orders) {
      const belongs = narrowCodes.includes(o.condition);
      check(o.appliesToFile === belongs,
        `${o.kind}: the desk says ${o.appliesToFile} and the engine ${belongs ? 'put its condition on the file' : 'did not'} — one answer, not two`);
      if (!belongs) {
        check(typeof o.notForThisFile === 'string' && o.notForThisFile.length > 15,
          `${o.kind} says WHY it does not belong — "${o.notForThisFile}"`);
        check(o.canOrder === false, `${o.kind} cannot be ordered — the greying is not cosmetic`);
      }
    }
    // Nothing is ever HIDDEN: a desk that drops cards reads as one that broke.
    check(deskNarrow.orders.length === kinds.ORDER_KIND_KEYS.length,
      `all ${kinds.ORDER_KIND_KEYS.length} cards are still on the desk`);

    const beforeRefusal = sent.length;
    const refused = await deskMod.place(narrow, 'vor', { db, actor: { name: 'Auditor' } });
    check(refused.ok === false && refused.status === 422,
      `the door refuses it too, not only the screen (${refused.status})`);
    check(/not renting/i.test(refused.error || ''),
      `and gives the file's own reason — "${refused.error}"`);
    check(sent.length === beforeRefusal, 'and NOTHING went out to a landlord who does not exist');
  } finally {
    await db.query(`DELETE FROM lt_loans WHERE loan_number LIKE $1`, [`ORD-${tag}%`]).catch(() => {});
    await db.query(`DELETE FROM service_contacts WHERE company_name LIKE $1`, [`%${tag}`]).catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll good.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

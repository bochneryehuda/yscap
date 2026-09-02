#!/usr/bin/env node
'use strict';
/**
 * THE PRE-SUBMITTAL FILE-CONTACTS CONDITION FOLLOWS THE DEAL (db/674).
 *
 * Owner-directed 2026-09-02: *"prior to submittal, we only have hazard
 * insurance and title insurance. This file is actually his primary, and we
 * don't have the slot over there for landlord contact information … if he's a
 * renter, it should also populate landlord contact … If it's a condo,
 * populate the condo. If it's a New York file, populate the settlement agent."*
 *
 * WHAT IS PROVEN, against a real Postgres:
 *
 *   A. THE MIGRATION reaches a database that already holds db/667's two-row
 *      config: the row is put back to the two, db/674 is run, and the row now
 *      carries the five — with the migration's JSON and the library's seed
 *      compared as VALUES. A replay does nothing; a hand-edited row is left alone.
 *   B. ON A LIVE FILE the three rows answer from the file's own facts: a
 *      homeowner's New Jersey house asks for exactly the two; a renter in a
 *      New York condominium is asked for all five. Greyed rows are KEPT with
 *      a reason, never dropped.
 *   C. THE GATE: the condition cannot be signed off while a required,
 *      applicable contact is missing — and can once the vendor rows are on
 *      the file. A greyed row never blocks. (Before this, `satisfy` signed
 *      the contacts condition off with nothing on the file.)
 *   D. THE STAND-ALONE HOA CONDITION is retired: inactive on disk, gone from
 *      the library, and an untouched instance comes off a file on the next
 *      rules pass while a worked one stays.
 *
 * Everything runs inside one transaction and is rolled back.
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

const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'db', '674_the_pre_submittal_contacts_follow_the_deal.sql'), 'utf8');

(async () => {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-contacts-follow-the-deal');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const read = require('../src/longterm/conditions-center/read.js');
  const write = require('../src/longterm/conditions-center/write.js');
  const vocab = require('../src/longterm/conditions-center/vocabulary.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');
    const stamp = Date.now();

    console.log('\nA. THE MIGRATION REACHES A DATABASE THAT ALREADY HOLDS THE TWO');
    {
      // Put the row back to exactly what db/667 shipped, so the statement has
      // something to do — then run the real file, never a copy.
      await cx.query(
        `UPDATE checklist_templates
            SET config = jsonb_set(config, '{contactTypes}',
                  '[{"key":"title","label":"Title company","required":true},
                    {"key":"hazard_insurance","label":"Hazard insurance agent","required":true}]'::jsonb)
          WHERE code = 'lt_file_contacts' AND scope = 'lt_loan'`);
      const before = (await cx.query(
        `SELECT config->'contactTypes' AS ct FROM checklist_templates WHERE code = 'lt_file_contacts' AND scope = 'lt_loan'`)).rows[0];
      ok(before && before.ct.length === 2, 'the row holds the two db/667 shipped');

      await cx.query(MIGRATION);
      const after = (await cx.query(
        `SELECT config->'contactTypes' AS ct FROM checklist_templates WHERE code = 'lt_file_contacts' AND scope = 'lt_loan'`)).rows[0];
      const keys = (after.ct || []).map((t) => t.key).sort();
      ok(JSON.stringify(keys) === JSON.stringify(['hazard_insurance', 'hoa', 'landlord', 'ny_settlement_agent', 'title']),
        'THE ONE THAT MATTERS: after db/674 the row carries the five', keys.join(','));
      const canon = (rows) => JSON.stringify(rows.map((r) => ({ key: r.key, label: r.label, required: !!r.required, whenField: r.whenField || null }))
        .sort((a, b) => a.key.localeCompare(b.key)));
      const seeded = lib.library().find((c) => c.code === 'lt_file_contacts').config.contactTypes;
      ok(canon(after.ct) === canon(seeded), 'and they are the library\'s own rows, value for value — the seed and the migration cannot drift');

      await cx.query(MIGRATION);
      const again = (await cx.query(
        `SELECT config->'contactTypes' AS ct FROM checklist_templates WHERE code = 'lt_file_contacts' AND scope = 'lt_loan'`)).rows[0];
      ok(canon(again.ct) === canon(after.ct), 'a replay changes nothing');

      // A hand-edited row survives: something a buyer typed matches neither guard.
      await cx.query(
        `UPDATE checklist_templates
            SET config = jsonb_set(config, '{contactTypes}', '[{"key":"title","label":"Title co.","required":true}]'::jsonb)
          WHERE code = 'lt_file_contacts' AND scope = 'lt_loan'`);
      await cx.query(MIGRATION);
      const edited = (await cx.query(
        `SELECT config->'contactTypes' AS ct FROM checklist_templates WHERE code = 'lt_file_contacts' AND scope = 'lt_loan'`)).rows[0];
      ok(edited.ct.length === 1 && edited.ct[0].label === 'Title co.', 'a hand-edited row is left exactly as the person left it');
      // …and back to the real thing for the rest of the suite.
      await cx.query(
        `UPDATE checklist_templates SET config = jsonb_set(config, '{contactTypes}', $1::jsonb)
          WHERE code = 'lt_file_contacts' AND scope = 'lt_loan'`, [JSON.stringify(seeded)]);
    }

    const borrower = (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Deal','Probe',$1) RETURNING id`,
      [`deal-${stamp}@example.test`])).rows[0].id;
    const officer = (await cx.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'Dina the Loan Officer','loan_officer',true) RETURNING id`,
      [`deal-officer-${stamp}@example.test`])).rows[0].id;

    /** A loan with a property, a borrower pair and a residence, so every rule field is READ. */
    const makeLoan = async (tag, { state, propertyType, basis }) => {
      const id = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr','purchase'::lt_loan_purpose)`,
        [id, borrower, `DEAL-${tag}-${stamp}`]);
      await cx.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
         VALUES ($1::uuid,'1 Deal Way','Anytown',$2,'10001',1,$3)`, [id, state, propertyType]);
      const pair = (await cx.query(
        `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES ($1::uuid,$2::uuid,1) RETURNING id`, [crypto.randomUUID(), id])).rows[0].id;
      const party = (await cx.query(
        `INSERT INTO lt_parties (id, pair_id, role, party_type, first_name, last_name) VALUES ($1::uuid,$2::uuid,'borrower','individual','Deal','Probe') RETURNING id`,
        [crypto.randomUUID(), pair])).rows[0].id;
      await cx.query(
        `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, street, city, state, zip)
         VALUES ($1::uuid,$2::uuid,'current',$3,'2 Home St','Anytown',$4,'10001')`, [crypto.randomUUID(), party, basis, state]);
      await engine.evaluateLoan(id, { db: cx, skipLock: true });
      return id;
    };
    const contactsCondition = async (loanId) => {
      const out = await read.forLoan(loanId, { audience: 'internal', db: cx });
      return out.buckets.flatMap((b) => b.conditions).find((c) => c.code === 'lt_file_contacts');
    };
    const rowsOf = (c) => Object.fromEntries((c.contactTypes || []).map((t) => [t.key, t]));

    console.log('\nB. ON A LIVE FILE THE THREE ROWS ANSWER FROM THE FILE\'S OWN FACTS');
    const nj = await makeLoan('nj', { state: 'NJ', propertyType: 'SFR', basis: 'own' });
    const ny = await makeLoan('ny', { state: 'NY', propertyType: 'Condominium', basis: 'rent' });
    {
      const c = await contactsCondition(nj);
      ok(!!c, 'the contacts condition is on the New Jersey file');
      const r = rowsOf(c);
      ok(Object.keys(r).length === 5, 'all five rows are on the condition — a greyed row is KEPT, never dropped', Object.keys(r).join(','));
      ok(r.title.applies === true && r.hazard_insurance.applies === true, 'the two apply outright');
      ok(r.landlord.applies === false && /rents/i.test(r.landlord.whyNot || ''), 'a homeowner is not asked for a landlord — with the reason', String(r.landlord.whyNot));
      ok(r.hoa.applies === false && /condominium/i.test(r.hoa.whyNot || ''), 'a house has no HOA row — with the reason', String(r.hoa.whyNot));
      ok(r.ny_settlement_agent.applies === false && /new york/i.test(r.ny_settlement_agent.whyNot || ''), 'New Jersey has no settlement agent — with the reason');
    }
    {
      const c = await contactsCondition(ny);
      const r = rowsOf(c);
      ok(r.landlord.applies === true && r.hoa.applies === true && r.ny_settlement_agent.applies === true,
        'a renter in a New York condominium is asked for the landlord, the HOA and the settlement agent', JSON.stringify([r.landlord.applies, r.hoa.applies, r.ny_settlement_agent.applies]));
      ok(['landlord', 'hoa', 'ny_settlement_agent'].every((k) => r[k].required === true), '…and each is required when it applies');
    }

    console.log('\nC. THE GATE: NOT SIGNED OFF UNTIL THE CONTACTS ARE ON THE FILE');
    const vendor = async (loanId, kind) => {
      const sc = (await cx.query(
        `INSERT INTO service_contacts (company_name, contact_name, email, contact_type) VALUES ($1,'Someone',$2,'other') RETURNING id`,
        [`${kind} co ${stamp}`, `${kind}-${loanId.slice(0, 8)}@example.test`])).rows[0].id;
      await cx.query(
        `INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id, is_primary) VALUES ($1::uuid,$2,$3::uuid,true)`,
        [loanId, kind, sc]);
    };
    {
      const c = await contactsCondition(nj);
      const refused = await write.satisfy(nj, c.id, officer, cx);
      ok(refused.ok === false && refused.status === 422, 'with nothing on the file the sign-off is REFUSED (it used to go through)', JSON.stringify(refused));
      ok(/Title company/.test(refused.error || '') && /Hazard insurance agent/.test(refused.error || ''),
        '…naming the two that are missing', String(refused.error));
      ok(!/Landlord|HOA|Settlement/.test(refused.error || ''), '…and not the three that do not apply to this file — a greyed row never blocks');

      const missing = await read.missingContacts(nj, c, cx);
      ok(missing.missing.map((m) => m.key).sort().join(',') === 'hazard_insurance,title',
        'the shared reader says the same two — one definition for the gate, the list and the screen');

      await vendor(nj, 'title');
      const still = await write.satisfy(nj, c.id, officer, cx);
      ok(still.ok === false && /Hazard insurance agent/.test(still.error || '') && !/Title company/.test(still.error || ''),
        'one on the file: the refusal names only the other');
      await vendor(nj, 'hazard_insurance');
      const done = await write.satisfy(nj, c.id, officer, cx);
      ok(done.ok === true && done.condition.status === 'satisfied', 'both on the file: signed off');
    }
    {
      const c = await contactsCondition(ny);
      await vendor(ny, 'title');
      await vendor(ny, 'hazard_insurance');
      const refused = await write.satisfy(ny, c.id, officer, cx);
      ok(refused.ok === false && /Landlord/.test(refused.error || '') && /HOA management company/.test(refused.error || '') && /Settlement agent/.test(refused.error || ''),
        'on the New York condo rental the three that apply block the sign-off until they are on the file', String(refused.error));
      await vendor(ny, 'landlord'); await vendor(ny, 'hoa'); await vendor(ny, 'ny_settlement_agent');
      const done = await write.satisfy(ny, c.id, officer, cx);
      ok(done.ok === true, 'and with all five on the file it is signed off');
    }

    console.log('\nD. THE STAND-ALONE HOA CONDITION IS RETIRED');
    {
      ok(!lib.library().some((t) => t.code === 'lt_hoa_contact'), 'it is out of the library a new database would be seeded from');
      // Stage the row as every database that ever had it holds it, active, then
      // put an untouched instance and a worked instance on two condo files.
      const { item_kind, tool_key } = vocab.kindToShared('form');
      await cx.query(
        `INSERT INTO checklist_templates
           (code, scope, label, audience, item_kind, tool_key, category, auto_apply, is_required, slots, config, is_active, origin, rule_logic)
         VALUES ('lt_hoa_contact','lt_loan','HOA management company',$1,$2,$3,$4,'rules',true,'[]'::jsonb,
                 '{"contactTypes":[{"key":"hoa","label":"HOA management company","required":true}]}'::jsonb,true,'system',
                 '{"combinator":"and","rules":[{"field":"is_condo","operator":"is_true"}]}'::jsonb)
         ON CONFLICT (code) DO UPDATE SET is_active = true, config = EXCLUDED.config`,
        [vocab.audienceToShared('both'), item_kind, tool_key, vocab.categoryOf('prior_to_submission')]);
      const condoA = await makeLoan('condo-a', { state: 'NJ', propertyType: 'Condominium', basis: 'own' });
      const condoB = await makeLoan('condo-b', { state: 'NJ', propertyType: 'Condominium', basis: 'own' });
      const hoaOn = async (loanId) => (await cx.query(
        `SELECT ci.id, ci.status FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
          WHERE ci.lt_loan_id = $1::uuid AND t.code = 'lt_hoa_contact'`, [loanId])).rows[0] || null;
      ok(!!(await hoaOn(condoA)) && !!(await hoaOn(condoB)), 'while the template is active, both condo files carry the stand-alone condition');
      const worked = await hoaOn(condoB);
      await cx.query(`UPDATE checklist_items SET notes = 'called them 9/2' WHERE id = $1::uuid`, [worked.id]);

      await cx.query(MIGRATION.slice(MIGRATION.indexOf('-- ── 3.')));
      const t = (await cx.query(
        `SELECT is_active, config->>'enabled' AS enabled, config->>'disabledReason' AS why
           FROM checklist_templates WHERE code = 'lt_hoa_contact'`)).rows[0];
      ok(t.is_active === false && t.enabled === 'false' && /Retired/.test(t.why || ''), 'db/674 §3 retires it in the library\'s own words — inactive, switched off, and told why');

      await engine.evaluateLoan(condoA, { db: cx, skipLock: true });
      await engine.evaluateLoan(condoB, { db: cx, skipLock: true });
      ok((await hoaOn(condoA)) === null, 'the UNTOUCHED instance comes off its file on the next rules pass');
      ok(!!(await hoaOn(condoB)), 'the WORKED instance (a note on it) stays — work somebody did is never destroyed by a rule changing its mind');
      const hoaRow = rowsOf(await contactsCondition(condoA)).hoa;
      ok(hoaRow && hoaRow.applies === true && hoaRow.required === true, 'and the condo file still asks for the HOA — on the file-contacts condition');
    }
  } catch (e) {
    failed = true;
    console.error('\nUNEXPECTED:', e && e.stack ? e.stack : e);
  } finally {
    try { await cx.query('ROLLBACK'); } catch (_) { /* nothing to do */ }
    cx.release();
    await db.pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) fails.forEach((f) => console.error('  FAIL ' + f));
  process.exit(failed || fails.length ? 1 : 0);
})();

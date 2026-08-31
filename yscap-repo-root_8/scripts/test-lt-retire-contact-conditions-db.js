#!/usr/bin/env node
'use strict';
/**
 * LT — THE LANDLORD AND THE PAYOFF SERVICER STOP BEING CONDITIONS, AND NOBODY'S
 * WORK GOES WITH THEM.
 *
 * Owner-directed 2026-08-31: *"You can technically remove that condition. Landlord
 * contact details: you can just add landlord contact information directly to the
 * file contact condition and the FileContacts section."* and *"Servicer of the
 * loan being paid off — this is now a separate condition. We don't need this to be
 * a separate condition."* Asked what should happen to the ones already on live
 * files, the owner chose: **take them off, but keep any work already done** — and
 * leave a condition somebody has notes or documents on alone for a human.
 *
 * ── WHY THIS IS A DATABASE TEST ─────────────────────────────────────────────
 *
 * Every claim here is about what happens to rows that already exist. Removing two
 * entries from the library is invisible on a live database (`library.seed` is
 * `ON CONFLICT DO NOTHING`), the retraction is a DELETE with its whole test inside
 * the statement, and the carry-across is a jsonb merge — none of the three can be
 * read off the source with any confidence, and all three destroy data if wrong.
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

const RETIRED = ['lt_landlord_contact', 'lt_payoff_contact'];

(async () => {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-retire-contact-conditions');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const read = require('../src/longterm/conditions-center/read.js');
  // The SHARED vocabulary, so a re-attached row uses the same words the engine
  // writes rather than a guess this test would have to keep in step.
  const vocab = require('../src/longterm/conditions-center/vocabulary.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const cx = await db.pool.connect();
  let failed = false;

  /** Run one part of db/660 against this transaction — the real file, never a copy. */
  const MIGRATION = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'db', '660_retire_the_landlord_and_payoff_servicer_conditions.sql'), 'utf8');
  const runMigrationPart = async (from, to) => {
    const a = from === null ? 0 : MIGRATION.indexOf(from);
    const b = to === null ? MIGRATION.length : MIGRATION.indexOf(to);
    if (a < 0 || b < 0) throw new Error(`db/660 no longer contains ${from || ''}..${to || ''}`);
    await cx.query(MIGRATION.slice(a, b));
  };

  try {
    await cx.query('BEGIN');

    // ── A. THE LIBRARY AND THE TEMPLATES ────────────────────────────────────
    console.log('\nA. THE TWO ARE OUT OF THE LIBRARY AND RETIRED ON DISK');
    {
      const codes = lib.library().map((c) => c.code);
      for (const code of RETIRED) {
        ok(!codes.includes(code), `${code} is out of the library a new database would be seeded from`);
      }
      // RUN THE MIGRATION'S OWN STATEMENTS, on rows put back the way they were.
      // Reading the live table alone proves only that db/660 ran on THIS database
      // at some point — it cannot tell a working statement from one that has been
      // deleted since, because the guard makes it a no-op the second time. So the
      // rows are un-retired inside this transaction and the statement is re-run.
      await cx.query(
        `UPDATE checklist_templates
            SET is_active = true, config = COALESCE(config,'{}'::jsonb) - 'enabled' - 'disabledReason'
          WHERE code = ANY($1)`, [RETIRED]);
      ok((await cx.query(
        `SELECT count(*)::int AS n FROM checklist_templates WHERE code = ANY($1) AND is_active`, [RETIRED]
      )).rows[0].n === 2, 'both rows put back the way they were before today, so the statement has something to do');
      await runMigrationPart('-- ── 2.', null);
      const { rows } = await cx.query(
        `SELECT code, is_active, config->>'enabled' AS enabled, config->>'disabledReason' AS why
           FROM checklist_templates WHERE code = ANY($1)`, [RETIRED]);
      ok(rows.length === 2, 'both rows are still THERE — retired, never deleted, so every file that carries one keeps its history', String(rows.length));
      for (const r of rows) {
        ok(r.is_active === false, `${r.code} is inactive, so the engine never attaches it again`);
        ok(r.enabled === 'false', `…and the library screen reads it as switched off`);
        ok(/Retired/i.test(r.why || '') && !/switch/i.test((r.why || '').replace(/switched off/i, '')),
          `…and a reader is told it is RETIRED rather than pointed at a switch`, String(r.why).slice(0, 90));
      }
    }

    // ── A loan the two conditions would both have applied to ────────────────
    const stamp = Date.now();
    const borrower = (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Rent','Probe',$1) RETURNING id`,
      [`retire-${stamp}@example.test`])).rows[0].id;

    const makeLoan = async (tag) => {
      const id = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr','cash_out_refinance'::lt_loan_purpose)`,
        [id, borrower, `RET-${tag}-${stamp}`]);
      await cx.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
         VALUES ($1::uuid,'1 Rented Rd','Anytown','NJ','07001',1,'SFR')`, [id]);
      const pair = (await cx.query(
        `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES ($1::uuid,$2::uuid,1) RETURNING id`,
        [crypto.randomUUID(), id])).rows[0].id;
      const party = (await cx.query(
        `INSERT INTO lt_parties (id, pair_id, role, party_type, first_name, last_name)
         VALUES ($1::uuid,$2::uuid,'borrower','individual','Rent','Probe') RETURNING id`,
        [crypto.randomUUID(), pair])).rows[0].id;
      // Renting, so the landlord condition WOULD have applied; a refinance, so the
      // payoff one would have too. Both halves matter or the test proves nothing.
      await cx.query(
        `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, street, city, state, zip)
         VALUES ($1::uuid,$2::uuid,'current','rent','9 Rented Rd','Anytown','NJ','07001')`,
        [crypto.randomUUID(), party]);
      return id;
    };
    const templateId = async (code) => (await cx.query(
      `SELECT id FROM checklist_templates WHERE code = $1`, [code])).rows[0].id;
    const codesOn = async (loanId) => (await cx.query(
      `SELECT t.code FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.lt_loan_id = $1::uuid`, [loanId])).rows.map((r) => r.code);
    /** Put a retired condition back on a file, the way it was before today. */
    const reAttach = async (loanId, code, extra = {}) => {
      const id = crypto.randomUUID();
      await cx.query(
        // The engine's OWN insert shape, so a re-attached row is indistinguishable
        // from one it created — which is the whole point: what is under test is
        // what happens to a row exactly like the ones on live files today.
        `INSERT INTO checklist_items (id, scope, lt_loan_id, template_id, category, label,
                                      audience, item_kind, status, origin_kind, is_required,
                                      notes, tool_payload)
         VALUES ($1::uuid,'lt_loan',$2::uuid,$3::uuid,$4,'x',
                 $5,$6,'outstanding','auto',true,$7,$8::jsonb)`,
        [id, loanId, await templateId(code),
          vocab.categoryOf('prior_to_submission'),
          vocab.audienceToShared('both'),
          vocab.kindToShared('form').item_kind,
          extra.notes || null,
          extra.payload ? JSON.stringify(extra.payload) : null]);
      return id;
    };

    // ── B. A NEW FILE NEVER GETS THEM ───────────────────────────────────────
    console.log('\nB. A FILE EVALUATED TODAY NEVER GETS EITHER');
    const fresh = await makeLoan('fresh');
    await engine.evaluateLoan(fresh, { db: cx });
    {
      const codes = await codesOn(fresh);
      for (const code of RETIRED) ok(!codes.includes(code), `${code} is not attached to a renting refinance`);
      // THE CONTROL, and it is what makes the two above mean anything: a file this
      // evaluation reached at all.
      ok(codes.includes('lt_vor_sent'),
        'the same file DID get the verification of rent — the evaluation ran, it just no longer adds these two', codes.join(', '));
      ok(codes.includes('lt_payoff_ordered'),
        '…and the payoff ORDER, which is the step that was ever actually required');
    }

    // ── C. AN UNTOUCHED ONE LEAVES ──────────────────────────────────────────
    console.log('\nC. AN UNTOUCHED ONE COMES OFF THE FILES THAT HAVE IT');
    const plain = await makeLoan('plain');
    await engine.evaluateLoan(plain, { db: cx });
    for (const code of RETIRED) await reAttach(plain, code);
    ok((await codesOn(plain)).filter((c) => RETIRED.includes(c)).length === 2,
      'both are on the file, exactly as a live file carries them today');
    await engine.evaluateLoan(plain, { db: cx });
    {
      const codes = await codesOn(plain);
      for (const code of RETIRED) ok(!codes.includes(code), `${code} is retracted on the next evaluation`);
    }

    // ── D. WORK IS NEVER DESTROYED ──────────────────────────────────────────
    console.log('\nD. THE OWNER\'S OTHER HALF: ANY WORK ALREADY DONE STAYS');
    {
      // A NOTE.
      const noted = await makeLoan('noted');
      await engine.evaluateLoan(noted, { db: cx });
      await reAttach(noted, 'lt_landlord_contact', { notes: 'Spoke to the management company on Tuesday.' });
      await engine.evaluateLoan(noted, { db: cx });
      ok((await codesOn(noted)).includes('lt_landlord_contact'),
        'a condition somebody wrote a note on is LEFT ALONE, for a human');

      // A DOCUMENT.
      const docd = await makeLoan('docd');
      await engine.evaluateLoan(docd, { db: cx });
      const item = await reAttach(docd, 'lt_payoff_contact');
      await cx.query(
        `INSERT INTO documents (id, checklist_item_id, filename, content_type, storage_ref, uploaded_by_kind)
         VALUES ($1::uuid,$2::uuid,'servicer-letter.pdf','application/pdf','x/y','staff')`,
        [crypto.randomUUID(), item]);
      await engine.evaluateLoan(docd, { db: cx });
      ok((await codesOn(docd)).includes('lt_payoff_contact'),
        'a condition with a document on it is left alone too — retracting it would strand the document');

      // A TYPED ANSWER. This is the one the engine could NOT see before today: a
      // stored answer leaves the status `outstanding` and writes no note, so the
      // rent somebody typed was deleted with the row, silently.
      const typed = await makeLoan('typed');
      await engine.evaluateLoan(typed, { db: cx });
      await reAttach(typed, 'lt_landlord_contact', { payload: { monthly_rent: 2450, rented_since: '2023-06-01' } });
      await engine.evaluateLoan(typed, { db: cx });
      ok((await codesOn(typed)).includes('lt_landlord_contact'),
        'THE ONE THAT MATTERS: a condition somebody TYPED AN ANSWER on is left alone — a stored answer is work, exactly as a note is');
    }

    // ── E. THE TENANCY FACTS ARE CARRIED, NEVER CLOBBERED ───────────────────
    console.log('\nE. THE RENT AND THE TENANCY DATE MOVE TO THE FORM THAT USES THEM');
    {
      const vorTemplate = await templateId('lt_vor_sent');
      const runCarry = () => runMigrationPart('UPDATE checklist_items vor', '-- ── 2.');

      const carried = await makeLoan('carry');
      await engine.evaluateLoan(carried, { db: cx });
      await reAttach(carried, 'lt_landlord_contact', { payload: { monthly_rent: 2450, rented_since: '2023-06-01' } });
      await runCarry();
      {
        const { rows } = await cx.query(
          `SELECT tool_payload FROM checklist_items WHERE lt_loan_id = $1::uuid AND template_id = $2::uuid`,
          [carried, vorTemplate]);
        const p = (rows[0] || {}).tool_payload || {};
        ok(String(p.monthly_rent) === '2450' && p.rented_since === '2023-06-01',
          'the rent and the date land on the verification of rent, which is what the form is built from', JSON.stringify(p));
      }
      // A REPLAY WRITES NOTHING — every migration runs on every boot.
      await runCarry();
      {
        const { rows } = await cx.query(
          `SELECT tool_payload FROM checklist_items WHERE lt_loan_id = $1::uuid AND template_id = $2::uuid`,
          [carried, vorTemplate]);
        ok(String((rows[0].tool_payload || {}).monthly_rent) === '2450',
          '…and a second boot changes nothing');
      }

      // A NEWER ANSWER ON THE FORM IS NEVER OVERWRITTEN BY AN OLDER ONE.
      const kept = await makeLoan('kept');
      await engine.evaluateLoan(kept, { db: cx });
      await cx.query(
        `UPDATE checklist_items SET tool_payload = '{"monthly_rent": 3100}'::jsonb
          WHERE lt_loan_id = $1::uuid AND template_id = $2::uuid`, [kept, vorTemplate]);
      await reAttach(kept, 'lt_landlord_contact', { payload: { monthly_rent: 2450, rented_since: '2023-06-01' } });
      await runCarry();
      {
        const { rows } = await cx.query(
          `SELECT tool_payload FROM checklist_items WHERE lt_loan_id = $1::uuid AND template_id = $2::uuid`,
          [kept, vorTemplate]);
        const p = rows[0].tool_payload || {};
        ok(String(p.monthly_rent) === '3100',
          'a rent already typed on the form WINS — the newer answer is never replaced by the one being retired', JSON.stringify(p));
        ok(p.rented_since === '2023-06-01',
          '…while the key it did NOT hold is still carried, key by key rather than all-or-nothing');
      }
    }

    // ── F. THE CONTACTS STILL HAVE A HOME ───────────────────────────────────
    console.log('\nF. BOTH CONTACTS ARE STILL ASKED FOR, WHERE A CONTACT BELONGS');
    {
      const rows = await read.fileContactTypes(fresh, cx);
      const by = Object.fromEntries((rows || []).map((r) => [r.key, r]));
      ok(by.landlord && by.landlord.applies === true,
        'the landlord row is offered on the File contacts desk — the borrower rents');
      ok(by.payoff && by.payoff.applies === true,
        'and the servicer being paid off is offered — it is a refinance');
      ok(lib.library().find((c) => c.code === 'lt_vor_sent').config.fields
        .join(',') === 'monthly_rent,rented_since',
        'and the verification of rent now collects the two tenancy facts itself');
    }

    // ── D2. THE SAME RULE ON A CONDITION THAT IS STILL IN THE LIBRARY ───────
    console.log('\nD2. A LIVE RULE CHANGING ITS MIND CANNOT DELETE A TYPED ANSWER EITHER');
    {
      // Section D proves it for a RETIRED template, which the sweep decides. This
      // is the OTHER path — the ordinary loop, where a rule that used to apply
      // stops applying — and it needs its own case or half the rule is untested.
      // The verification of rent is the natural one: it applies while the borrower
      // rents, and it is exactly where the rent is now typed.
      const vorTpl2 = await templateId('lt_vor_sent');
      const stopsRenting = async (loanId) => cx.query(
        `UPDATE lt_residences r SET residency_basis = 'own'
           FROM lt_parties p, lt_borrower_pairs bp
          WHERE bp.id = p.pair_id AND r.party_id = p.id
            AND bp.loan_id = $1::uuid AND r.residency_type = 'current'`,
        [loanId]);

      // THE CONTROL FIRST, or "it survived" proves nothing: with no answer on it,
      // the same condition on the same kind of file really is retracted.
      const bare = await makeLoan('bare');
      await engine.evaluateLoan(bare, { db: cx });
      ok((await codesOn(bare)).includes('lt_vor_sent'), 'the verification of rent is on a renting file');
      await stopsRenting(bare);
      await engine.evaluateLoan(bare, { db: cx });
      ok(!(await codesOn(bare)).includes('lt_vor_sent'),
        'and once the borrower owns their home instead, an untouched one is retracted');

      const answered = await makeLoan('answered');
      await engine.evaluateLoan(answered, { db: cx });
      await cx.query(
        `UPDATE checklist_items SET tool_payload = '{"monthly_rent": 2450}'::jsonb
          WHERE lt_loan_id = $1::uuid AND template_id = $2::uuid`, [answered, vorTpl2]);
      await stopsRenting(answered);
      await engine.evaluateLoan(answered, { db: cx });
      ok((await codesOn(answered)).includes('lt_vor_sent'),
        "THE ONE THAT MATTERS: with a rent typed on it, the same condition is LEFT ALONE — a rule changing its mind never destroys somebody's typing");
    }


    // ── G. THE SWEEP'S OWN SAFETY ───────────────────────────────────────────
    console.log('\nG. THE RETIRED SWEEP TOUCHES NOTHING ELSE');
    {
      // The new statement deletes untouched rows whose TEMPLATE IS INACTIVE. Two
      // neighbouring sets look similar and must never be swept, and neither is
      // reachable through the ordinary loop, so only this proves it: a condition
      // somebody TYPED BY HAND carries no template at all, and a template with
      // `auto_apply = 'manual'` is perfectly ACTIVE and simply not rule-driven.
      // Scoping on "not in the library" rather than on `is_active = false` would
      // delete both — which is why the two are different tests, not one.
      const safe = await makeLoan('safe');
      await engine.evaluateLoan(safe, { db: cx });

      const handTyped = crypto.randomUUID();
      await cx.query(
        `INSERT INTO checklist_items (id, scope, lt_loan_id, category, label, audience,
                                      item_kind, status, origin_kind, is_required)
         VALUES ($1::uuid,'lt_loan',$2::uuid,$3,'Something a processor asked for',
                 $4,$5,'outstanding','auto',false)`,
        [handTyped, safe, vocab.categoryOf('prior_to_submission'),
          vocab.audienceToShared('both'), vocab.kindToShared('form').item_kind]);

      // A manual-apply template on this same loan: active, not in the rule-driven
      // library, and its instance is untouched — the exact shape a careless sweep
      // would take.
      const manualTpl = crypto.randomUUID();
      await cx.query(
        `INSERT INTO checklist_templates (id, code, scope, label, audience, item_kind,
                                          category, auto_apply, is_required, is_active)
         VALUES ($1::uuid,$2,'lt_loan','A manual one',$3,$4,$5,'manual',false,true)`,
        [manualTpl, `lt_manual_probe_${stamp}`, vocab.audienceToShared('internal'),
          vocab.kindToShared('form').item_kind, vocab.categoryOf('prior_to_submission')]);
      const manualItem = crypto.randomUUID();
      await cx.query(
        `INSERT INTO checklist_items (id, scope, lt_loan_id, template_id, category, label,
                                      audience, item_kind, status, origin_kind, is_required)
         VALUES ($1::uuid,'lt_loan',$2::uuid,$3::uuid,$4,'A manual one',$5,$6,'outstanding','auto',false)`,
        [manualItem, safe, manualTpl, vocab.categoryOf('prior_to_submission'),
          vocab.audienceToShared('internal'), vocab.kindToShared('form').item_kind]);

      await engine.evaluateLoan(safe, { db: cx });
      const alive = async (id) => (await cx.query(
        `SELECT 1 FROM checklist_items WHERE id = $1::uuid`, [id])).rows.length === 1;
      ok(await alive(handTyped),
        'a condition somebody typed by hand — no template at all — is untouched by the retired sweep');
      ok(await alive(manualItem),
        'a condition from an ACTIVE manual-apply template is untouched too — "not in the rule-driven library" is not "retired"');

      // AND THE CONTROL, or the two above would pass on a sweep that does nothing.
      const retiredItem = await reAttach(safe, 'lt_landlord_contact');
      await engine.evaluateLoan(safe, { db: cx });
      ok(!(await alive(retiredItem)),
        '…while a retired one on the very same file IS removed — the sweep is running, it is just narrow');
    }

    await cx.query('ROLLBACK');
  } catch (e) {
    failed = true;
    console.error('  ✗ threw: ' + ((e && e.stack) || e));
    try { await cx.query('ROLLBACK'); } catch (_) { /* already gone */ }
  } finally {
    cx.release();
    await db.pool.end();
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (failed || fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
})();

'use strict';
/**
 * LT test — THE FOUR CORRECTIONS, AGAINST A REAL POSTGRES.
 *
 * The pure suite proves the RULES. This one proves the two things no pure test
 * can see: that db/647 reaches the files already on disk, and that replaying it
 * on every boot — which `migrate-boot` does — changes nothing the second time.
 *
 * WHY THE BACK-DATE IS THE RISKY HALF. `library.js` seeds with
 * `ON CONFLICT (code) DO NOTHING`, so a template already in the database is never
 * updated by it, and `lt_file_conditions` copies the template's bucket, slots and
 * config AT CREATION. A library change therefore reaches a live database through
 * the migration or not at all — and the migration is the only place a mistake
 * lands on files somebody is working.
 *
 * SKIPS without DATABASE_URL rather than failing, like every other DB suite here.
 */

const path = require('path');
const fs = require('fs');

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-condition-answers-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/db');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const MIGRATION = path.join(__dirname, '..', 'db',
  '647_lt_cash_out_letter_is_prior_to_clear_to_close_and_the_entity.sql');

async function replayMigration() {
  await db.query(fs.readFileSync(MIGRATION, 'utf8'));
}

async function main() {
  const library = require('../src/longterm/conditions-center/library.js');
  await library.ensureSeeded(db);
  await replayMigration();

  // ── A. The templates ──────────────────────────────────────────────────────
  console.log('the library in the database');

  // THE LIBRARY MOVED HOUSE (db/653): it seeds into the ONE Condition Center as
  // `checklist_templates` rows with scope='lt_loan'. Read back through the SAME
  // translation the seed wrote through, so this section goes on asserting the
  // owner's four corrections in the owner's own words.
  const vocab = require('../src/longterm/conditions-center/vocabulary.js');
  const t = async (code) => {
    const r = (await db.query(
      `SELECT category, item_kind, tool_key, slots, config
         FROM checklist_templates WHERE code = $1 AND scope = 'lt_loan'`, [code])).rows[0];
    return r && { bucket_key: vocab.bucketOf(r.category), kind: vocab.kindFromShared(r), slots: r.slots, config: r.config || {} };
  };

  const cash = await t('lt_cash_out_letter');
  check(cash && cash.bucket_key === 'prior_to_ctc',
    'the cash-out letter template is prior to clear to close');

  const ent = await t('lt_vesting_entity');
  const gs = (ent.slots || []).find((s) => s.key === 'good_standing');
  check(!!gs, 'the vesting entity template asks for a certificate of good standing');
  check(gs && gs.required === false, 'and it is optional');
  check(ent.config.prefillFromEntity === true, 'and it opens from the borrower’s profile');

  for (const code of ['lt_reo_liabilities', 'lt_subject_mortgage_statement']) {
    const row = await t(code);
    check(row.config.answeredBy === 'answers', `${code} points at the one definition`);
    check(!row.config.answers && !row.config.typedFields && !row.config.waiver,
      `${code} carries no second copy of the ways`);
  }
  check((await t('lt_reo_liabilities')).kind === 'document',
    'the mortgages condition is filed as a document — the safe fallback if the answers module ever stops governing it');

  // ── B. THE BACK BOOK — a file created before any of this ──────────────────
  console.log('the files that already exist');

  const loanId = (await db.query(
    `INSERT INTO lt_loans (id, loan_number) VALUES (gen_random_uuid(), 'TEST-647-' || substr(md5(random()::text),1,8)) RETURNING id`)).rows[0].id;

  // Stage the PRE-migration shape on three rows: untouched, worked, and one
  // carrying a document — exactly the three the migration has to tell apart.
  const stage = async (code, extra = {}) => (await db.query(
    `INSERT INTO lt_file_conditions
       (loan_id, code, bucket_key, label, audience, kind, slots, config, status, satisfied_at)
     VALUES ($1::uuid, $2, 'prior_to_submission', $3, 'both', $4, $5::jsonb, $6::jsonb, $7, $8)
     RETURNING id`,
    [loanId, code, `staged ${code}`, extra.kind || 'document',
      JSON.stringify(extra.slots || []), JSON.stringify(extra.config || {}),
      extra.status || 'outstanding', extra.satisfiedAt || null])).rows[0].id;

  const untouched = await stage('lt_cash_out_letter');
  const worked = await stage('lt_cash_out_letter', { status: 'satisfied', satisfiedAt: new Date().toISOString() });
  const staleEntity = await stage('lt_vesting_entity', {
    slots: [{ key: 'formation', label: 'Articles of formation', required: true }],
    config: {},
  });
  const staleReo = await stage('lt_reo_liabilities', {
    kind: 'form',
    config: { answers: ['upload_statement', 'linked_to_primary', 'typed_address'], classify: 'propose_only' },
  });

  await replayMigration();

  const f = async (id) => (await db.query(
    `SELECT bucket_key, kind, slots, config, status FROM lt_file_conditions WHERE id = $1::uuid`, [id])).rows[0];

  check((await f(untouched)).bucket_key === 'prior_to_ctc',
    'an untouched cash-out letter on an existing file MOVES to prior to clear to close');
  check((await f(worked)).bucket_key === 'prior_to_submission',
    'while one somebody already signed off STAYS where it was — moving it would make a closed file’s history read as though the work happened at a different step');

  const healedEntity = await f(staleEntity);
  check((healedEntity.slots || []).some((s) => s.key === 'good_standing'),
    'an existing vesting entity gains the good-standing slot');
  check((healedEntity.slots || []).some((s) => s.key === 'formation'),
    'and keeps the slots it already had — appended, never replaced');
  check(healedEntity.config.prefillFromEntity === true, 'and starts reading the profile');

  const healedReo = await f(staleReo);
  check(healedReo.config.answeredBy === 'answers', 'an existing mortgages condition points at the one definition');
  check(!healedReo.config.answers, 'and its second copy of the ways is removed');
  check(healedReo.config.classify === 'propose_only', 'while the rest of its config is left alone');
  check(healedReo.kind === 'document', 'and it stops calling itself a form');

  // ── C. IT CONVERGES — migrate-boot replays every file on every boot ───────
  console.log('and the second boot changes nothing');

  const before = JSON.stringify([await f(untouched), await f(worked), await f(staleEntity), await f(staleReo)]);
  await replayMigration();
  await replayMigration();
  const after = JSON.stringify([await f(untouched), await f(worked), await f(staleEntity), await f(staleReo)]);
  check(before === after, 'two more replays leave every row byte for byte as it was');
  check(((await f(staleEntity)).slots || []).filter((s) => s.key === 'good_standing').length === 1,
    'and the good-standing slot is added ONCE, not once per deploy');

  // ── D. The gate, on a real row ────────────────────────────────────────────
  console.log('the sign-off gate on a real condition');

  const write = require('../src/longterm/conditions-center/write.js');

  // THE WRITE DOOR MOVED WITH THE LIBRARY (db/653) — a Long-Term condition is a
  // `checklist_item` owned by `lt_loan_id`. `stage()` above deliberately still
  // writes `lt_file_conditions`, because sections B and C are about db/647
  // reaching the rows PRODUCTION already holds there and that migration still
  // replays on every boot. These sections are about the LIVE door, so they stage
  // where the door now looks.
  const stageItem = async (code, extra = {}) => {
    const tpl = (await db.query(
      `SELECT id FROM checklist_templates WHERE code = $1 AND scope = 'lt_loan'`, [code])).rows[0];
    return (await db.query(
      `INSERT INTO checklist_items
         (scope, lt_loan_id, template_id, label, audience, item_kind, tool_key,
          is_required, slots, status, field_key)
       VALUES ('lt_loan', $1::uuid, $2::uuid, $3, 'both', $4, $5, true, $6::jsonb, 'outstanding', $7)
       RETURNING id`,
      [loanId, tpl && tpl.id, `staged ${code}`,
        extra.itemKind || 'document', extra.toolKey || null,
        JSON.stringify(extra.slots || []), extra.fieldKey || null])).rows[0].id;
  };

  const subject = await stageItem('lt_subject_mortgage_statement', {
    slots: [{ key: 'statement', label: 'Mortgage statement', required: false }],
  });
  let out = await write.satisfy(loanId, subject, null, db);
  check(out.ok === false && /Choose how to answer/.test(out.error || out.why || ''),
    'it refuses until a way is chosen');

  out = await write.recordAnswer(loanId, subject, { way: 'typed', values: { outstanding_balance: 412000, servicer: 'FCI' } }, null, db);
  check(out.ok === false && /Loan number/.test(out.error || ''),
    'the door refuses a partial typed answer, naming the missing figure');

  out = await write.recordAnswer(loanId, subject, {
    way: 'typed', values: { outstanding_balance: 412000, servicer: 'FCI Lender Services', loan_number: 'YS-9931' },
  }, null, db);
  check(out.ok === true, 'and accepts all three');

  out = await write.satisfy(loanId, subject, null, db);
  check(out.ok === true, 'after which the condition signs off with no document at all');

  // A SECOND instance of the same template on the same loan — allowed only
  // because it carries its own `field_key`, which is exactly what db/653's
  // partial unique index is written to permit (and what it refuses without).
  const fci = await stageItem('lt_subject_mortgage_statement', {
    slots: [{ key: 'statement', label: 'Mortgage statement', required: false }],
    fieldKey: 'second-instance',
  });
  /* THE FCI WAY IS NO LONGER A WAIVER — owner-directed 2026-08-31: *"if you're
     putting in that it's FCI then the servicer automatically selects it to be
     FCI and our processor needs to go into FCI and look for the FCI loan number
     and put it in and outstanding balance."* So choosing it alone no longer
     signs anything off; it answers the SERVICER and still asks for the two
     numbers. Re-pointed at that rule, not loosened — the assertion below is
     stricter than the one it replaces, because it now checks what the way
     answers by itself as well as what it still demands. */
  out = await write.recordAnswer(loanId, fci, { way: 'fci_serviced' }, null, db);
  check(out.ok === false && /(loan number|balance)/i.test(out.error || ''),
    'the FCI way alone is refused, naming the numbers our processor looks up in FCI',
    out.error || '');
  out = await write.recordAnswer(loanId, fci, {
    way: 'fci_serviced', values: { loan_number: 'FCI-4471', outstanding_balance: 388000 },
  }, null, db);
  check(out.ok === true, 'and is accepted once they are keyed in', out.error || '');
  const fciAnswer = (await db.query(
    'SELECT tool_payload AS a FROM checklist_items WHERE id = $1::uuid', [fci])).rows[0].a;
  check(fciAnswer && fciAnswer.values && fciAnswer.values.servicer === 'FCI Lender Services',
    'while the SERVICER answers itself — the one thing choosing FCI already says');
  out = await write.satisfy(loanId, fci, null, db);
  check(out.ok === true, 'after which it signs off with no attachment and no form');

  // ── E. The workspace a screen opens ──────────────────────────────────────
  console.log('what the screen is handed');

  const workspace = require('../src/longterm/conditions-center/workspace.js');
  const reoItem = await stageItem('lt_reo_liabilities');
  const ws = await workspace.forCondition(loanId, reoItem, { db });
  check(ws && ws.shape === 'per_line', 'the mortgages condition opens as a list of lines');
  check(ws.ways.map((w) => w.key).join('/') === 'statement/primary/address',
    'offering the three ways');
  check(Array.isArray(ws.lines), 'with the liabilities read from the credit report');
  const plainItem = await stageItem('lt_cash_out_letter');
  const plain = await workspace.forCondition(loanId, plainItem, { db });
  check(plain === null, 'and an ordinary condition has no workspace, which is a normal answer rather than an error');

  // ── F. THE SETTINGS DOOR, whose SQL is built from what was sent ──────────
  // `PATCH /library/:code` assembles `SET ${sets.join(', ')}` from the fields in
  // the body, so it is not a statement until it is assembled and cannot be
  // prepared from source. `test-lt-sql-prepared-db.js` therefore requires it to
  // be EXECUTED somewhere in this job — the same reasoning as every other
  // interpolated statement in the long-term tree. Driven here through the real
  // handler, because a GET smoke test cannot reach a write door.
  console.log('the settings door that builds its own SET clause');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = { id: null, kind: 'staff', role: 'super_admin', perms: {} }; next(); });
  app.use('/cc', require('../src/longterm/routes/condition-center.js'));

  const patch = (code, body) => new Promise((resolve) => {
    const http = require('http');
    const server = app.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, method: 'PATCH',
        path: `/cc/library/${encodeURIComponent(code)}`,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (r) => {
        let raw = ''; r.on('data', (d) => { raw += d; });
        r.on('end', () => { server.close(); let b = null; try { b = JSON.parse(raw); } catch (_) {} resolve({ status: r.statusCode, body: b }); });
      });
      req.on('error', () => { server.close(); resolve({ status: 0, body: null }); });
      req.end(payload);
    });
  });

  const hintOf = async () => (await db.query(
    `SELECT hint FROM checklist_templates WHERE code = 'lt_cash_out_letter' AND scope = 'lt_loan'`)).rows[0].hint;
  const hintBefore = await hintOf();
  const edited = await patch('lt_cash_out_letter', { hint: 'A settings edit, made by the test.' });
  check(edited.status === 200, `the assembled UPDATE really runs (got ${edited.status})`);
  check((await hintOf()) === 'A settings edit, made by the test.', 'and the wording it was handed is what the row now holds');

  // THE TWO SETTINGS WITH NO SHARED COLUMN take the config path instead, and
  // merging rather than replacing is what stops switching a condition off from
  // wiping the rest of its settings — which on this template is the whole
  // answers-module wiring section A above just asserted.
  const cfgOf = async () => (await db.query(
    `SELECT config FROM checklist_templates WHERE code = 'lt_reo_liabilities' AND scope = 'lt_loan'`)).rows[0].config || {};
  const cfgBefore = await cfgOf();
  const off = await patch('lt_reo_liabilities', { enabled: false, disabledReason: 'held back by the test' });
  check(off.status === 200, `switching a condition off is a settings edit like any other (got ${off.status})`);
  const cfgAfter = await cfgOf();
  check(cfgAfter.enabled === false && cfgAfter.disabledReason === 'held back by the test',
    'the switch and its reason are recorded');
  check(cfgAfter.answeredBy === cfgBefore.answeredBy && cfgAfter.classify === cfgBefore.classify,
    'and the rest of the condition’s settings survive it — merged, never replaced');
  await db.query(
    `UPDATE checklist_templates SET config = $2::jsonb WHERE code = $1 AND scope = 'lt_loan'`,
    ['lt_reo_liabilities', JSON.stringify(cfgBefore)]);
  await db.query(
    `UPDATE checklist_templates SET hint = $2 WHERE code = $1 AND scope = 'lt_loan'`,
    ['lt_cash_out_letter', hintBefore]);

  const nothing = await patch('lt_cash_out_letter', {});
  check(nothing.status === 400, 'a body with nothing in it is refused rather than assembling an empty SET');
  const missing = await patch('no_such_condition', { hint: 'x' });
  check(missing.status === 404, 'and a code nobody has is a 404, not a silent no-op');

  await db.query(`DELETE FROM lt_file_conditions WHERE loan_id = $1::uuid`, [loanId]);
  await db.query(`DELETE FROM lt_loans WHERE id = $1::uuid`, [loanId]);
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} FAILED` : '\nlt condition answers (db): all checks passed');
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => { console.error('CRASHED:', (e && e.stack) || e); process.exit(1); });

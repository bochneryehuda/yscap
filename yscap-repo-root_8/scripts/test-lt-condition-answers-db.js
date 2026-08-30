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

  const t = async (code) => (await db.query(
    `SELECT bucket_key, kind, slots, config FROM lt_condition_templates WHERE code = $1`, [code])).rows[0];

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

  const subject = await stage('lt_subject_mortgage_statement', {
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

  const fci = await stage('lt_subject_mortgage_statement', {
    slots: [{ key: 'statement', label: 'Mortgage statement', required: false }],
  });
  await write.recordAnswer(loanId, fci, { way: 'fci_serviced' }, null, db);
  out = await write.satisfy(loanId, fci, null, db);
  check(out.ok === true, 'and the FCI selection alone signs one off — no attachment, no form');

  // ── E. The workspace a screen opens ──────────────────────────────────────
  console.log('what the screen is handed');

  const workspace = require('../src/longterm/conditions-center/workspace.js');
  const ws = await workspace.forCondition(loanId, staleReo, { db });
  check(ws && ws.shape === 'per_line', 'the mortgages condition opens as a list of lines');
  check(ws.ways.map((w) => w.key).join('/') === 'statement/primary/address',
    'offering the three ways');
  check(Array.isArray(ws.lines), 'with the liabilities read from the credit report');
  const plain = await workspace.forCondition(loanId, untouched, { db });
  check(plain === null, 'and an ordinary condition has no workspace, which is a normal answer rather than an error');

  await db.query(`DELETE FROM lt_file_conditions WHERE loan_id = $1::uuid`, [loanId]);
  await db.query(`DELETE FROM lt_loans WHERE id = $1::uuid`, [loanId]);
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} FAILED` : '\nlt condition answers (db): all checks passed');
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => { console.error('CRASHED:', (e && e.stack) || e); process.exit(1); });

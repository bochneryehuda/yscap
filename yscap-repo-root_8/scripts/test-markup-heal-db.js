'use strict';
/**
 * db/598 — RELEASING A FILE FROM A FROZEN COPY OF AN OLD COMPANY MARKUP.
 * Real Postgres, the REAL migration, run through the REAL boot replay.
 *
 * WHY THIS SUITE HAS TO BE A DB ONE. `migrate-boot` replays every file in `db/`
 * on EVERY boot and, when a statement throws, it LOGS THE FAILURE AND CONTINUES.
 * So a migration with a bad column name, a bad CTE or a bad `RETURNING` does not
 * fail the build — it silently never runs, forever, and the bug it was written
 * to fix stays live while everything reports green. Nothing but running it
 * against a real database can catch that, which is exactly why the first thing
 * asserted here is that the file APPLIED AT ALL.
 *
 * WHAT db/598 IS FOR (owner-reported 2026-08-20): the Term Sheet Studio used to
 * paint the company default of the day into the admin markup box, which the
 * register path then stored as a PER-FILE override — so files are carrying a
 * frozen copy of an old company markup, price at it forever, and read as a
 * DISCOUNT (and therefore an exception) on every re-register. The migration
 * clears exactly the ones that are provably a copy of that day's default, and
 * only where the file's economics are still open.
 *
 * THE FIVE THINGS IT MUST GET RIGHT, each a fixture below:
 *   1. an open file frozen at the default of its registration day  → CLEARED
 *   2. a markup somebody genuinely typed                            → KEPT
 *   3. a file with a LIVE Term Sheet package out for signature      → KEPT
 *   4. a funded / clear-to-close file                               → KEPT
 *   5. a file registered before the Pricing Center existed          → judged
 *      against the seeded system literals, not against nothing
 * …plus: the Gold top-tier markup is never touched (the studio never seeded it,
 * so a value there was typed on purpose), every release is audited (the value is
 * gone from the row afterwards, so that line is the only record it was there),
 * and a SECOND boot changes nothing.
 *
 * DB-gated: skips cleanly with no database, like every other suite in the chain.
 */
const assert = require('assert');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { skipUnlessDb } = require('./lib/db-gate');
const { ensureSchema } = require('../src/migrate-boot');

const MIG = '598';
const suffix = `mkheal${Date.now().toString(36)}`;

async function mkBorrower(i) {
  const r = await db.query(
    `INSERT INTO borrowers (first_name, last_name, email)
     VALUES ($1,$2,$3) RETURNING id`,
    ['Heal', `Case${i}`, `heal.${suffix}.${i}@example.test`]);
  return r.rows[0].id;
}

/** One fixture file: markups frozen on it, a registration stamped at `regAt`. */
async function mkFile(i, { status, std, gold, silver, goldT1, regAt, tsEnvelope }) {
  const borrowerId = await mkBorrower(i);
  const a = await db.query(
    `INSERT INTO applications (borrower_id, status, purchase_price, as_is_value, arv, rehab_budget,
                               file_markup_std_pct, file_markup_gold_pct, file_markup_silver_pct, file_markup_gold_t1_pct)
     VALUES ($1,$2,300000,300000,520000,100000,$3,$4,$5,$6) RETURNING id`,
    [borrowerId, status, std, gold, silver, goldT1 == null ? null : goldT1]);
  const appId = a.rows[0].id;
  if (regAt) {
    await db.query(
      `INSERT INTO product_registrations (application_id, program, status, is_current, created_at, inputs, quote)
       VALUES ($1,'standard','ELIGIBLE',true,$2,'{}'::jsonb,'{}'::jsonb)`, [appId, regAt]);
  }
  if (tsEnvelope) {
    await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status)
       VALUES ($1,'term_sheet_package',$2)`, [appId, tsEnvelope]);
  }
  return appId;
}

const markups = async (appId) => (await db.query(
  `SELECT file_markup_std_pct AS std, file_markup_gold_pct AS gold,
          file_markup_silver_pct AS silver, file_markup_gold_t1_pct AS t1
     FROM applications WHERE id=$1`, [appId])).rows[0];
const num = (v) => (v == null ? null : Number(v));

(async () => {
  await skipUnlessDb('test-markup-heal-db');
  // Build the database first. `migrate-boot` replays EVERY file on EVERY boot,
  // so db/598 runs here too — against nothing, since the fixtures below do not
  // exist yet. The run that matters is the SECOND ensureSchema(), which is what
  // a real deploy does to a database that already holds these files.
  await ensureSchema();

  // ── the company's markup history: 0.4 until a moment ago, 0.5 now ──────────
  // Written directly rather than through the admin route so the timeline is
  // exact; the append-only shape (one current row) is the table's own contract.
  const OLD_AT = '2026-01-10T00:00:00Z';
  const NEW_AT = '2026-08-19T00:00:00Z';
  await db.query(`UPDATE company_pricing_settings SET is_current=false WHERE is_current`);
  await db.query(
    `INSERT INTO company_pricing_settings (markup_std_pct, markup_gold_pct, markup_silver_pct,
       orig_std_pct, orig_gold_pct, lender_fee, credit_fee, appraisal_fee, title_fee, note, is_current, created_at)
     VALUES (0.4, 0.5, 0.4, 1.25, 1.25, 2195, 150, 800, NULL, $1, false, $2)`,
    [`test ${suffix} — the old company markup`, OLD_AT]);
  await db.query(
    `INSERT INTO company_pricing_settings (markup_std_pct, markup_gold_pct, markup_silver_pct,
       orig_std_pct, orig_gold_pct, lender_fee, credit_fee, appraisal_fee, title_fee, note, is_current, created_at)
     VALUES (0.5, 0.5, 0.5, 1.25, 1.25, 2195, 150, 800, NULL, $1, true, $2)`,
    [`test ${suffix} — the owner's change to 0.5`, NEW_AT]);

  const REG_UNDER_OLD = '2026-03-01T00:00:00Z';   // registered while the default was 0.4
  const REG_BEFORE_HISTORY = '2025-06-01T00:00:00Z'; // older than every settings row

  const F = {};
  // 1 — the reported case: registered under the 0.4 default, still open.
  F.frozen = await mkFile(1, { status: 'underwriting', std: 0.4, gold: 0.5, silver: 0.4, regAt: REG_UNDER_OLD });
  // 2 — a deliberate discount somebody typed. 0.2 was never a company default.
  F.typed = await mkFile(2, { status: 'underwriting', std: 0.2, gold: null, silver: null, regAt: REG_UNDER_OLD });
  // 3 — a live Term Sheet package out for signature: the terms are on paper.
  F.tsSent = await mkFile(3, { status: 'underwriting', std: 0.4, gold: null, silver: null, regAt: REG_UNDER_OLD, tsEnvelope: 'sent' });
  // 3b — a VOIDED package is terminal and frees the file (the esign in-flight model).
  F.tsVoid = await mkFile(9, { status: 'underwriting', std: 0.4, gold: null, silver: null, regAt: REG_UNDER_OLD, tsEnvelope: 'voided' });
  // 4 — status-frozen files.
  F.funded = await mkFile(4, { status: 'funded', std: 0.4, gold: null, silver: null, regAt: REG_UNDER_OLD });
  F.ctc = await mkFile(5, { status: 'clear_to_close', std: 0.4, gold: null, silver: null, regAt: REG_UNDER_OLD });
  // 5 — registered before the Pricing Admin Center existed: judged against the
  //     seeded system literals (0.5), which is what the studio's own CO carried.
  F.preHistory = await mkFile(6, { status: 'underwriting', std: 0.5, gold: null, silver: null, regAt: REG_BEFORE_HISTORY });
  // 6 — never registered at all: judged against TODAY's default.
  F.noReg = await mkFile(7, { status: 'file_intake', std: 0.5, gold: null, silver: null, regAt: null });
  // 7 — the Gold top-tier markup, which the studio never seeded.
  F.goldT1 = await mkFile(8, { status: 'underwriting', std: 0.4, gold: null, silver: null, goldT1: 0.5, regAt: REG_UNDER_OLD });

  // ── run the REAL migration, exactly as the next deploy would ──────────────
  await ensureSchema();

  const applied = await db.query(`SELECT 1 FROM schema_migrations WHERE filename LIKE $1`, [`${MIG}\\_%`]);
  ok(applied.rows.length === 1,
    `A1 db/${MIG} APPLIED — it is recorded as run, so it did not throw and get silently skipped by the boot replay (the failure mode this suite exists for)`);

  const after = {};
  for (const k of Object.keys(F)) after[k] = await markups(F[k]);

  console.log('\nB. what it released');
  ok(num(after.frozen.std) === null && num(after.frozen.silver) === null,
    'B1 the reported case is released — the Standard and Silver markups that only restated the 0.4 default of its registration day are gone, so the file now follows the live 0.5');
  ok(num(after.frozen.gold) === null,
    'B2 the Gold markup on the same file is released too — 0.5 was the Gold default that day, so it was equally a copy');

  console.log('\nC. what it left alone');
  ok(num(after.typed.std) === 0.2,
    'C1 a markup somebody genuinely typed is untouched — 0.2 was never a company default, so it is a real exception and stays');
  ok(num(after.tsSent.std) === 0.4,
    'C2 a file with a LIVE Term Sheet package out for signature keeps its markup — those terms are on paper and re-pricing them is what the freeze exists to prevent');
  ok(num(after.tsVoid.std) === null,
    'C3 …but a VOIDED package is terminal and frees the file, matching the esign in-flight model the rest of the freeze uses');
  ok(num(after.funded.std) === 0.4 && num(after.ctc.std) === 0.4,
    'C4 funded and clear-to-close files keep theirs — settled terms are never re-priced by a migration');
  ok(num(after.goldT1.t1) === 0.5,
    'C5 the Gold TOP-TIER markup is never touched — the studio never seeded that box, so a value there was typed on purpose');
  ok(num(after.goldT1.std) === null,
    'C6 …while the same file\'s seeded Standard markup is still released (the two are judged separately)');

  console.log('\nD. the timeline is a fact, not a guess');
  ok(num(after.preHistory.std) === null,
    'D1 a registration older than every settings row is judged against the seeded system literals (0.5) — the numbers the studio carried before the Pricing Center existed');
  ok(num(after.noReg.std) === null,
    'D2 a file that was never registered is judged against today\'s default');

  console.log('\nE. the record');
  const audits = await db.query(
    `SELECT entity_id, detail FROM audit_log
      WHERE action='file_markup_seeded_default_cleared' AND entity_id = ANY($1::uuid[])`,
    [[F.frozen, F.typed, F.tsSent, F.funded, F.goldT1]]);
  const forFrozen = audits.rows.find((r) => r.entity_id === F.frozen);
  // Of the five ids asked about, exactly two were released (the reported case and
  // the seeded Standard markup on the gold-top-tier file); the other three were
  // deliberately left alone and must therefore have NO audit row at all.
  ok(audits.rows.length === 2 && !!forFrozen,
    `E1 every release is audited and nothing else is — a row for each of the 2 files it touched among these five, and none for the 3 it left alone (got ${audits.rows.length})`);
  ok(forFrozen && forFrozen.detail && forFrozen.detail.standard
    && Number(forFrozen.detail.standard.was) === 0.4
    && Number(forFrozen.detail.standard.company_default_then) === 0.4,
    'E2 and the audit line records the value that was removed AND the company default it matched — the row no longer holds either, so this is the only lasting record');
  ok(forFrozen && forFrozen.detail && !Object.prototype.hasOwnProperty.call(forFrozen.detail, 'gold_t1'),
    'E3 it never claims to have touched something it did not');

  console.log('\nF. a second boot');
  const beforeSecond = await db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE action='file_markup_seeded_default_cleared'`);
  /* Give a released file a REAL override afterwards and make sure the replay does
     not eat it. This has to be done the way the SYSTEM does it — the sticky is
     only ever written by the register path, which also mints a fresh current
     registration — because the rule judges a markup against the default in force
     at the REGISTRATION's moment, not against today's. Writing 0.4 onto the row
     while leaving its March registration in place would put it right back into
     "this is a copy of that day's 0.4 default", and the migration would be
     correct to release it again. (That asymmetry is the rule working: typing
     back the default of the day you registered is not an override, whenever you
     do it.) */
  await db.query(`UPDATE product_registrations SET created_at=now() WHERE application_id=$1 AND is_current`, [F.frozen]);
  await db.query(`UPDATE applications SET file_markup_std_pct=0.4 WHERE id=$1`, [F.frozen]);
  await ensureSchema();
  const afterSecond = await db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE action='file_markup_seeded_default_cleared'`);
  ok(afterSecond.rows[0].n === beforeSecond.rows[0].n,
    'F1 replaying the migration releases nothing further — it is idempotent, and it compares against a historical fact so it cannot change its answer on a later run');
  ok(num((await markups(F.frozen)).std) === 0.4,
    'F2 and a markup a human entered on a FRESH registration survives the replay — 0.4 is a real deviation from today\'s 0.5 default, so it is somebody\'s decision now, not a leftover copy');

  // The mirror image, and it is the rule rather than a gap: re-registering at
  // exactly today's default is "typed the default back", which the approval
  // detector has always treated as not-a-change — so it is released too, and the
  // file simply follows the company default from then on.
  await db.query(`UPDATE applications SET file_markup_std_pct=0.5 WHERE id=$1`, [F.frozen]);
  await ensureSchema();
  ok(num((await markups(F.frozen)).std) === null,
    'F4 …while re-registering at exactly today\'s default is released again — restating the default is not an override, whichever day it is restated on');
  ok(num((await markups(F.typed)).std) === 0.2 && num((await markups(F.tsSent)).std) === 0.4,
    'F3 everything it left alone the first time is still left alone');

  // Clean up this suite's own rows so a shared database is not littered.
  await db.query(`DELETE FROM company_pricing_settings WHERE note LIKE $1`, [`test ${suffix}%`]);
  await db.query(`UPDATE company_pricing_settings SET is_current=true
                   WHERE id = (SELECT id FROM company_pricing_settings ORDER BY created_at DESC LIMIT 1)`);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

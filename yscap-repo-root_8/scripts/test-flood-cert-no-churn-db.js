'use strict';
/**
 * DB test for db/376 — the flood-certificate (rtl_cond_flood) identity must be
 * STABLE across deploys (owner-reported 2026-07-30: the flood cert lost its
 * history / read brand-new after every deploy).
 *
 * Before db/376, most files' flood cert was delete-and-recreated on every boot
 * (db/207 §A2 / db/335 §2 / db/337 §1 delete an untouched note-less cert, then
 * db/374 §2 re-inserts a fresh row), so its id + created_at reset each deploy —
 * nulling the FKs that point at it and resetting its condition-aging clock. db/376
 * stamps a marker note on every untouched cert (the pattern db/281 established), so
 * those boot DELETEs skip it and the row is preserved.
 *
 * This proves, for Standard / Silver / Fidelis / Blue Lake / flood-zone files:
 *   • after one stabilizing boot, a FURTHER ensureSchema() leaves the flood cert's
 *     id AND created_at UNCHANGED (no churn) — the core guarantee;
 *   • is_required stays TRUE (db/374 owns "required on every file"); the Fidelis
 *     in-boot is_required flip nets back to true and never changes the id;
 *   • the marker note survives db/374 §3 (which strips only the db/335/337 markers);
 *   • a HUMAN-touched cert (own note / signed off) is never overwritten by db/376
 *     and is likewise stable.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-flood-cert-no-churn-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-flood-cert-no-churn-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// The EXACT note db/376 stamps, and db/281's note (Blue Lake / CorrFirst keep
// theirs — db/376 never overwrites an existing note). Asserting the exact string
// (not just "non-empty") catches a note-ACCUMULATION regression: if db/374 §3's
// strip ever broke, a Fidelis cert's note would grow "MARKER\n\nOptional…" instead
// of staying MARKER. Keep these in lock-step with db/376 / db/281.
const MARKER = '[auto] Flood determination certificate — a standing internal condition kept on every file, whatever the capital provider. This note keeps the condition from being rebuilt on each deploy so its history stays intact; it does not change what is required.';
const BL_NOTE = '[auto] A flood determination certificate is required on this file (capital-partner requirement). Auto-added by the Condition Center; an underwriter can waive it if the deal no longer needs it.';

let seq = 0;
async function seedFile(lender, floodZone) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Flood','Case',$1) RETURNING id`,
    [`flood_${process.pid}_${Date.now()}_${seq++}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, status, lender, property_address)
     VALUES ($1,'underwriting',$2,$3) RETURNING id`,
    [bor.id, lender, JSON.stringify({ line: '1 Dry St', city: 'Town', state: 'TX' })])).rows[0];
  // A checklist item so db/374 §2's EXISTS predicate is satisfied.
  await db.query(
    `INSERT INTO checklist_items (template_id, scope, label, borrower_label, audience,
        item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind,
            COALESCE(t.role_scope,'processor'), t.phase, true, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code='rtl_p1_gov_id'`, [app.id]);
  // Attach a note-less flood cert directly (mirrors db/177 / the engine).
  await db.query(
    `INSERT INTO checklist_items (template_id, scope, label, borrower_label, audience,
        item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind,
            COALESCE(t.role_scope,'processor'), t.phase, true, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code='rtl_cond_flood'
        AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id=$1 AND ci.template_id=t.id)`,
    [app.id]);
  if (floodZone) {
    await db.query(
      `INSERT INTO appraisals (application_id, superseded, fema_flood_sfha) VALUES ($1,false,true)`, [app.id]);
  }
  return { borId: bor.id, appId: app.id };
}

async function floodRow(appId) {
  return (await db.query(
    `SELECT ci.id, ci.created_at, ci.is_required, ci.notes
       FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_cond_flood'`, [appId])).rows;
}

async function cleanup(f) {
  await db.query('DELETE FROM documents WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM appraisals WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM checklist_items WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM applications WHERE id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [f.borId]).catch(() => {});
}

// One flood cert row; assert exactly one exists and return it.
async function one(appId, label) {
  const r = await floodRow(appId);
  ok(r.length === 1, `${label}: exactly one flood cert on the file (got ${r.length})`);
  return r[0];
}

// Seed a note-less flood cert, make it "touched" one way (apply), then boot: db/376
// must SKIP it (note stays empty) and it must not churn (id unchanged).
async function touchedSkipCase(label, apply) {
  const f = await seedFile(null, false);
  const seed = (await floodRow(f.appId))[0];
  ok(seed && (seed.notes === null || String(seed.notes).trim() === ''),
    `${label}: starts note-less`);
  await apply(f.appId);
  await ensureSchema();
  const a = await one(f.appId, `${label}`);
  ok(a && (a.notes === null || String(a.notes).trim() === ''),
    `${label}: db/376 left it note-less (the untouched-guard excludes a touched item)`);
  ok(a && seed && String(a.id) === String(seed.id),
    `${label}: id unchanged (a touched cert was never in the boot DELETEs' scope, so it never churned)`);
  await cleanup(f);
}

async function stabilityCase(label, lender, floodZone, expectedNote) {
  const f = await seedFile(lender, floodZone);
  // Boot to stabilization: this stamps the marker note (and does the one final,
  // documented, untouched-item swap).
  await ensureSchema();
  const stable = await one(f.appId, `${label} (stabilized)`);
  ok(stable && stable.notes === expectedNote,
    `${label}: the exact [auto] marker note is present after stabilization (no accumulation)`);
  ok(stable && stable.is_required === true, `${label}: is_required stays TRUE (required on every file)`);

  // A FURTHER boot must not churn the identity.
  await ensureSchema();
  const after = await one(f.appId, `${label} (next boot)`);
  ok(after && stable && String(after.id) === String(stable.id),
    `${label}: flood cert id UNCHANGED across the next deploy (${stable && stable.id})`);
  ok(after && stable && new Date(after.created_at).getTime() === new Date(stable.created_at).getTime(),
    `${label}: flood cert created_at UNCHANGED across the next deploy`);
  ok(after && after.is_required === true, `${label}: is_required still TRUE after the next deploy`);
  ok(after && after.notes === expectedNote,
    `${label}: the marker note is byte-identical after db/374 §3 (survived, never grew)`);

  // And a third boot, to prove idempotent stability (not a one-off).
  await ensureSchema();
  const third = await one(f.appId, `${label} (third boot)`);
  ok(third && stable && String(third.id) === String(stable.id),
    `${label}: flood cert id STILL unchanged after a third deploy`);

  await cleanup(f);
}

(async () => {
  await ensureSchema();

  // The churning populations (each was delete-and-recreated every boot before db/376):
  await stabilityCase('Standard / no note buyer', null, false, MARKER);
  await stabilityCase('Silver-ish note buyer (EMCAP)', 'EMCAP', false, MARKER);
  await stabilityCase('Fidelis (waiver reversed)', 'Fidelis Investors LLC', false, MARKER);
  // Already protected by db/281's OWN note — db/376 skips it (never overwrites a note):
  await stabilityCase('Blue Lake', 'Blue Lake', false, BL_NOTE);
  // Never churned (in scope for db/207) — prove the note does not disturb it:
  await stabilityCase('Flood zone (SFHA)', null, true, MARKER);

  // db/376 must stamp ONLY untouched, note-less certs. A cert made "touched" any of
  // the other ways the boot DELETEs recognize (a sign-off, a waiver, a tool payload,
  // an attached document) is NOT db/376's to write on — and, being touched, it never
  // churned to begin with. This proves each non-notes guard is load-bearing: drop one
  // and db/376 would stamp (and, worse, imply the item is fresh).
  await touchedSkipCase('signed-off cert', async (appId) => {
    await db.query(
      `UPDATE checklist_items ci SET signed_off_at=now(), status='satisfied'
         FROM checklist_templates t
        WHERE ci.template_id=t.id AND t.code='rtl_cond_flood' AND ci.application_id=$1`, [appId]);
  });
  await touchedSkipCase('waived cert', async (appId) => {
    // A waive sets waived_at + status='satisfied' (staff.js). Leave signed_off_at
    // NULL so the waived_at guard is the SOLE thing keeping db/376 off it — i.e. this
    // isolates that guard (mirrors db/337 §1, which treats waived_at as "touched").
    await db.query(
      `UPDATE checklist_items ci SET waived_at=now(), status='satisfied'
         FROM checklist_templates t
        WHERE ci.template_id=t.id AND t.code='rtl_cond_flood' AND ci.application_id=$1`, [appId]);
  });
  await touchedSkipCase('tool_payload cert', async (appId) => {
    await db.query(
      `UPDATE checklist_items ci SET tool_payload='{}'::jsonb
         FROM checklist_templates t
        WHERE ci.template_id=t.id AND t.code='rtl_cond_flood' AND ci.application_id=$1`, [appId]);
  });
  await touchedSkipCase('document-attached cert', async (appId) => {
    await db.query(
      `INSERT INTO documents (filename, application_id, checklist_item_id)
       SELECT 'flood-determination.pdf', $1, ci.id
         FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE t.code='rtl_cond_flood' AND ci.application_id=$1`, [appId]);
  });

  // A HUMAN-touched flood cert (own note) must NOT be overwritten by db/376, and
  // is stable (a touched item was never in the boot DELETEs' scope).
  {
    const f = await seedFile(null, false);
    const HUMAN = 'Ordered the FEMA determination on 2026-07-15 — awaiting the certificate.';
    await db.query(
      `UPDATE checklist_items ci SET notes=$2, reviewed_at=now()
         FROM checklist_templates t
        WHERE ci.template_id=t.id AND t.code='rtl_cond_flood' AND ci.application_id=$1`,
      [f.appId, HUMAN]);
    const b = await one(f.appId, 'human-touched (before boot)');
    await ensureSchema();
    const a = await one(f.appId, 'human-touched (after boot)');
    ok(a && a.notes === HUMAN, 'human-touched: db/376 did NOT overwrite the human note');
    ok(a && b && String(a.id) === String(b.id), 'human-touched: flood cert id unchanged (never churned)');
    await cleanup(f);
  }

  console.log(failures
    ? `\n${failures} FAILURE(S)`
    : '\nOK  flood-cert identity is stable across deploys (no churn), note preserved, human notes untouched — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

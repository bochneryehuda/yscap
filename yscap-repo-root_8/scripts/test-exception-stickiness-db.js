/**
 * EXCEPTION STICKINESS — the DB reader (owner-directed 2026-08-05).
 *
 * The pure truth table lives in test-exception-stickiness-pure.js. This proves the one
 * part it cannot: latestApprovedGrant() reads the newest APPROVED escalation off a real
 * `manual_program_escalations` row (jsonb round-trip, status filter, newest-wins), and
 * that its output composes with exceptionCoveredByGrant() end to end — so a re-register
 * of already-approved terms is recognised as covered.
 *
 * DB-gated: skips cleanly when DATABASE_URL is unset (the plain CI `test` job has no
 * Postgres; the `test-db` job runs it for real).
 * Run: DATABASE_URL=postgres://… node scripts/test-exception-stickiness-db.js
 */
'use strict';

if (!process.env.DATABASE_URL) { console.log('SKIP test-exception-stickiness-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-exc-stick';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const mp = require(REPO + '/src/lib/manual-program');
const uuid = () => crypto.randomUUID();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

async function insertEsc(appId, { status, overrides, summary, decidedAgoHours }) {
  await db.query(
    `INSERT INTO manual_program_escalations
       (application_id, status, overrides, summary, decided_at, created_at)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,
             CASE WHEN $2='approved' THEN now() - ($5 || ' hours')::interval ELSE NULL END,
             now() - ($5 || ' hours')::interval)`,
    [appId, status, JSON.stringify(overrides || {}), JSON.stringify(summary || {}), String(decidedAgoHours)]);
}

async function main() {
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const B = uuid(), APP = uuid();
  try {
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Exc','Stick',$2)`,
      [B, `exc_${B.slice(0, 8)}@x.test`]);
    await db.query(
      `INSERT INTO applications (id,borrower_id,property_address,purchase_price,as_is_value,arv,rehab_budget,term)
       VALUES ($1,$2,$3,300000,300000,450000,50000,'12')`,
      [APP, B, JSON.stringify({ line1: '5 Exc Rd', city: 'Lakewood', state: 'NJ', zip: '08701' })]);

    // No approved escalation yet.
    ok((await mp.latestApprovedGrant(APP)) === null, 'no approved escalation → latestApprovedGrant is null');

    // A PENDING one is NOT a grant.
    await insertEsc(APP, { status: 'pending', overrides: { ovrLTCPct: 90 },
      summary: { program: 'manual', totalLoan: 300000 }, decidedAgoHours: 3 });
    ok((await mp.latestApprovedGrant(APP)) === null, 'a PENDING escalation is not read as an approved grant');

    // An APPROVED manual-program grant at 90% LTC / $300k.
    await insertEsc(APP, { status: 'approved', overrides: { ovrLTCPct: 90 },
      summary: { program: 'manual', totalLoan: 300000, manualReasons: [] }, decidedAgoHours: 2 });
    let g = await mp.latestApprovedGrant(APP);
    ok(g && g.program === 'manual' && Number(g.loanAmount) === 300000 && g.overrides.ovrLTCPct === 90,
      'latestApprovedGrant reads the approved grant back (program, loan amount, overrides)');

    // It composes with the pure coverage: same LTC, lower loan → covered; loan up → not.
    ok(mp.exceptionCoveredByGrant({ program: 'manual', status: 'ELIGIBLE',
      overrideChanges: [{ key: 'ovrLTC', label: 'Manual loan-to-cost', unit: 'frac', value: 0.9 }],
      loanAmount: 280000 }, g).covered === true,
      'a re-register at the same 90% LTC (fraction form), smaller loan → covered by the real grant');
    ok(mp.exceptionCoveredByGrant({ program: 'manual', status: 'ELIGIBLE',
      overrideChanges: [{ key: 'ovrLTC', label: 'Manual loan-to-cost', unit: 'frac', value: 0.9 }],
      loanAmount: 360000 }, g).covered === false,
      'a re-register with the loan amount UP → not covered');

    // A NEWER approved grant (different LTC) wins.
    await insertEsc(APP, { status: 'approved', overrides: { ovrLTCPct: 85 },
      summary: { program: 'manual', totalLoan: 300000, manualReasons: [] }, decidedAgoHours: 1 });
    g = await mp.latestApprovedGrant(APP);
    ok(g && g.overrides.ovrLTCPct === 85, 'the NEWEST approved grant is the one used');
    ok(mp.exceptionCoveredByGrant({ program: 'manual',
      overrideChanges: [{ key: 'ovrLTC', label: 'Manual loan-to-cost', unit: 'frac', value: 0.9 }],
      loanAmount: 300000 }, g).covered === false,
      'the old 90% LTC is no longer covered once 85% is the standing grant');
  } catch (e) {
    fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e);
  } finally {
    try {
      await db.query(`DELETE FROM manual_program_escalations WHERE application_id=$1`, [APP]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [APP]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]);
    } catch (e) { console.log('  (cleanup warn)', e.message); }
  }
  console.log(`\nexception-stickiness-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();

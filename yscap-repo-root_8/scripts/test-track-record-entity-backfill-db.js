'use strict';
/**
 * THE BACK-BOOK ENTITY BACKFILL.
 *
 * The owner's ruling, asked directly and answered in one word: an existing
 * verified line must **"Stay verified."** Section 2 is that ruling, and it is
 * the only reason db/501's exemption exists.
 *
 * The other half is that the exemption must be as small as it looks. Section 3
 * proves the guard is still fully armed for everything else — including for a
 * DIFFERENT entity being written INSIDE the pass, with the flag set.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP entity backfill (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const B = require('../src/lib/track-record-entity-backfill');
const tag = `trkbf_${process.pid}`;

const row = async (id) => (await db.query(
  'SELECT llc_id, is_verified, verification_status, entity_name FROM track_records WHERE id=$1', [id])).rows[0];

(async () => {
  await ensureSchema();

  // THIS PASS IS NOT WIRED INTO BOOT, on purpose. Assert that, because a boot
  // sweep writing to the whole loan book is exactly the shape being avoided.
  const boot = require('fs').readFileSync(require('path').join(__dirname, '../src/server.js'), 'utf8');
  ok(!/track-record-entity-backfill/.test(boot),
    'the backfill is NOT run at boot — it writes to the loan book and is a deliberate, invoked pass');

  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'BF Tester','underwriter') RETURNING id`,
    [`${tag}_staff@example.com`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('BF','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;

  const mkLlc = async (name) => (await db.query(
    `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`, [borrowerId, name])).rows[0].id;
  const mkLine = async (entityName, n, verified) => {
    const id = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, sale_date, entity_name)
       VALUES ($1,$2::jsonb,'flip', CURRENT_DATE - 60, $3) RETURNING id`,
      [borrowerId, JSON.stringify({ line1: `${n} Backfill Ave`, city: 'Lakewood', state: 'NJ', zip: '08701' }), entityName])).rows[0].id;
    if (verified) {
      await db.query(
        `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now(), verified_by=$2
          WHERE id=$1`, [id, staffId]);
    }
    return id;
  };

  const A = await mkLlc('Backfill Holdings LLC');

  // ═══════════════════════════════════ 1. It links what it can
  console.log('\n1. A name that already has a home gets linked');
  {
    await B.resetCursor();
    const exact = await mkLine('Backfill Holdings LLC', 1, false);
    const respelled = await mkLine('Backfill Holdings, L.L.C.', 2, false);
    const different = await mkLine('Backfill Holdings LLC II', 3, false);   // a DIFFERENT company
    const junk = await mkLine('N/A', 4, false);
    const nomatch = await mkLine('Somebody Else Entirely LLC', 5, false);

    const r = await B.backfillAll({});
    ok(r.ok, 'the pass ran');
    ok(String((await row(exact)).llc_id) === String(A), 'an exact name is linked to the entity it names');
    ok(String((await row(respelled)).llc_id) === String(A),
      'and a re-spelling of the same company links to the SAME entity');
    ok((await row(different)).llc_id === null,
      '"… LLC II" is a DIFFERENT company and is NOT linked — the loose matcher would have linked it');
    ok((await row(junk)).llc_id === null, 'junk is left alone');
    ok((await row(nomatch)).llc_id === null,
      'a name with no matching entity is left alone by default — this pass LINKS, it does not mint companies unattended');
    ok(r.junk >= 1 && r.unmatched >= 2, `and it reports what it skipped (junk ${r.junk}, unmatched ${r.unmatched})`);

    // Idempotent.
    await B.resetCursor();
    const again = await B.backfillAll({});
    ok(again.linked === 0, 're-running links nothing further — it is idempotent');
  }

  // ═════════════════════ 2. THE OWNER'S RULING: "Stay verified."
  console.log('\n2. An existing VERIFIED line keeps its verification');
  {
    await B.resetCursor();
    const v = await mkLine('Backfill Holdings LLC', 6, true);
    const before = await row(v);
    ok(before.is_verified === true && before.llc_id === null,
      'the fixture is a verified line whose entity is only free text — the real back-book shape');

    const r = await B.backfillAll({});
    const after = await row(v);
    ok(String(after.llc_id) === String(A), 'the pass linked it to its entity');
    ok(after.is_verified === true && after.verification_status === 'verified',
      'AND IT IS STILL VERIFIED — the owner\'s ruling, and the whole reason db/501 exists');
    ok(r.verifiedPreserved >= 1, `…and the pass reports how many verified lines it preserved (${r.verifiedPreserved})`);

    const audit = (await db.query(
      `SELECT detail FROM audit_log WHERE action='track_record_entity_backfilled' AND entity_id=$1`, [v])).rows[0];
    ok(!!audit, 'every automatic link is audited');
    ok(audit.detail.matchedName === 'Backfill Holdings LLC' && String(audit.detail.llcId) === String(A),
      '…recording the name it matched and the entity it chose, so the link is attributable');
    ok(audit.detail.wasVerified === true, '…and that this one was verified when it was touched');
  }

  // ══════════ 3. THE HOLE IS AS SMALL AS IT LOOKS — the guard is still armed
  console.log('\n3. Everything else still un-verifies, inside the pass and out');
  {
    const v = await mkLine('Backfill Holdings LLC', 7, true);
    await db.query(`UPDATE track_records SET sale_price=999999 WHERE id=$1`, [v]);
    ok((await row(v)).is_verified === false,
      'an ordinary material edit still un-verifies — the guard is not weakened for normal traffic');

    // With the flag ON, in one transaction: a FILL is exempt, a RE-POINT is not.
    const B2 = await mkLlc('Backfill Holdings B LLC');
    const f1 = await mkLine('Backfill Holdings LLC', 8, true);
    const c = await db.getClient();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL pilot.track_record_entity_backfill = 'on'`);
      await c.query(`UPDATE track_records SET llc_id=$2 WHERE id=$1`, [f1, A]);
      const mid = (await c.query('SELECT is_verified FROM track_records WHERE id=$1', [f1])).rows[0];
      ok(mid.is_verified === true, 'inside the pass, a NULL->value FILL keeps the verification');
      await c.query(`UPDATE track_records SET llc_id=$2 WHERE id=$1`, [f1, B2]);
      const after = (await c.query('SELECT is_verified FROM track_records WHERE id=$1', [f1])).rows[0];
      ok(after.is_verified === false,
        'but RE-POINTING to a different entity STILL un-verifies, even with the flag on — the exemption is a fill, not a licence');
      await c.query('ROLLBACK');
    } finally { try { c.release(); } catch (_) { /* gone */ } }

    // And the flag cannot leak out of its transaction.
    const leaked = (await db.query(
      `SELECT COALESCE(current_setting('pilot.track_record_entity_backfill', true),'') AS v`)).rows[0].v;
    ok(leaked !== 'on',
      'the GUC is SET LOCAL, so it is gone outside that transaction — it cannot be left switched on');

    const f2 = await mkLine('Backfill Holdings LLC', 9, true);
    await db.query(`UPDATE track_records SET llc_id=$2 WHERE id=$1`, [f2, A]);
    ok((await row(f2)).is_verified === false,
      'and the SAME fill from ordinary traffic, with no flag, un-verifies exactly as it always did');

    /* STRIP COMMENTS FIRST. The module's own header explains why it does NOT use
       ALTER TABLE ... DISABLE TRIGGER, so a naive source grep matches the
       explanation and fails on correct code — and would equally have PASSED if
       the header had been reworded while a real statement was added. */
    const bfSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../src/lib/track-record-entity-backfill.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/DISABLE\s+TRIGGER/i.test(bfSrc),
      'the pass contains NO table-wide DISABLE TRIGGER statement — that would drop the guard for every connection');
    ok(/SET LOCAL pilot\.track_record_entity_backfill/.test(bfSrc),
      '…it uses a SET LOCAL GUC instead, which is scoped to one transaction on one connection');
  }

  await db.query('DELETE FROM audit_log WHERE action=$1 AND entity_id IN (SELECT id FROM track_records WHERE borrower_id=$2)',
    ['track_record_entity_backfilled', borrowerId]).catch(() => {});
  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llc_borrowers WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llcs WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});
  await B.resetCursor();

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  the back-book pass links the name to the entity, and the book stays verified');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

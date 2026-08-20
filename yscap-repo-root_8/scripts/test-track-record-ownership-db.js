'use strict';
/**
 * CHECK A CARRIES — the owner's own sentence, made testable.
 *
 * "If he has ten properties in the track record, it should automatically
 * understand, 'Okay, this is on this LLC' … If we verify ownership of these two
 * LLCs, then all the ownership of all the properties is verified."
 * (owner-directed 2026-08-09)
 *
 * Section 4 is that sentence literally: ten properties, two entities, two
 * Check A's — and every line picks its ownership evidence up on its own.
 *
 * The properties that matter most here are the ones about NOT over-claiming:
 *   · nothing carried may ever become a HUMAN verdict (section 2)
 *   · "we have not looked" and "the evidence says the opposite" stay different
 *     answers with different messages (sections 1 and 3)
 *   · a company that held the property BEFORE the borrower joined it is a
 *     contradiction, not a pass (section 3)
 *   · revoking the entity revokes the carry, but never erases a person's own
 *     decision (section 5)
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const O = require('../src/lib/track-record-ownership');

// ═══════════════════════════════════ 1. The verdict table, pure
console.log('\n1. The four outcomes stay four outcomes');
{
  const A = { verified: true };
  ok(O.ownershipVerdict({ checkA: { verified: false } }) === null,
    'Check A NOT done leaves the pillar untouched — "the entity is not verified" is a fact about the ENTITY, not about ten properties');

  const proved = O.ownershipVerdict({ checkA: A, checkB: { proved: true, confidence: 'certain' } });
  ok(proved.auto_verdict === 'proved' && proved.auto_source === 'entity', 'both checks holding is proved');
  ok(proved.auto_grade === 'strong',
    'graded STRONG, never superior — superior is for evidence we read off the instrument ourselves');

  const nod = O.ownershipVerdict({ checkA: A, checkB: null });
  ok(nod.auto_verdict === 'no_data', 'Check A holding with Check B unproven is no_data, NOT a failure');
  ok(/have not yet confirmed that this entity is the one that held this property/.test(nod.message),
    '…and the message names WHICH check is missing, so the reviewer knows to go look at the deed');
  ok(!/not verified/.test(nod.message), '…and does not blame the entity, which IS verified');

  // The two messages must be tellable apart — that is the entire point.
  ok(proved.message !== nod.message, 'a proved pillar and an unproven one never read the same');
}

// ═══════════════════════ 2. Nothing here may satisfy a pillar
console.log('\n2. The machine observes; a person decides');
{
  const all = [
    O.ownershipVerdict({ checkA: { verified: true }, checkB: { proved: true } }),
    O.ownershipVerdict({ checkA: { verified: true }, checkB: null }),
    O.ownershipVerdict({ checkA: { verified: true }, hold: { from: '2020-01-01', to: '2020-06-01' }, member: { from: '2023-01-01' } }),
  ].filter(Boolean);
  ok(all.length === 3, 'three verdicts produced');
  ok(all.every((v) => !('human_verdict' in v)),
    'NOT ONE of them carries a human_verdict — the sign-off gate reads that column and nothing automatic may write it');
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/track-record-ownership.js'), 'utf8');
  /* THE SUBJECT IS THE SET CLAUSE, NOT THE STATEMENT. `SET[^;]*human_verdict`
     also fired on a WHERE that READS the column further down the same statement
     — and reading it is the safety property, not a violation: the revoke and the
     boot heal both refuse to touch a pillar a human confirmed. So each SET list
     is cut out at its own WHERE and only that is searched. */
  const setClauses = src.split(/\bSET\b/).slice(1).map((chunk) => chunk.split(/\bWHERE\b/)[0]);
  ok(setClauses.length > 0, '(the guard found SET clauses to search — it is not vacuous)');
  ok(!/human_verdict\s*=\s*\$/.test(src) && !setClauses.some((c) => /human_verdict/.test(c)),
    'and the module contains no SQL that writes human_verdict at all');
}

// ═══════════════════ 3. The membership window — unknown is not a contradiction
console.log('\n3. A company that held it before the borrower joined');
{
  ok(O.withinMembership({ from: '2021-01-01', to: '2021-09-01' }, { from: null, to: null }).ok === true,
    'NO membership dates is not a contradiction — most entities have none, and reading it as one would flag the whole back book');
  ok(O.withinMembership({ from: null, to: null }, { from: '2020-01-01', to: null }).ok === true,
    'and no HOLDING dates is not a contradiction either');

  const before = O.withinMembership({ from: '2019-01-01', to: '2019-08-01' }, { from: '2023-01-01', to: null });
  ok(before.ok === false && before.why === 'sold_before_they_joined',
    'sold in 2019 by an entity the borrower joined in 2023 — provably not their ownership');

  const after = O.withinMembership({ from: '2024-05-01', to: '2024-12-01' }, { from: '2018-01-01', to: '2022-01-01' });
  ok(after.ok === false && after.why === 'bought_after_they_left',
    'and bought after they left is the same failure from the other end');

  ok(O.withinMembership({ from: '2023-06-01', to: '2024-02-01' }, { from: '2022-01-01', to: '2025-01-01' }).ok === true,
    'a holding period inside the window is fine');

  const v = O.ownershipVerdict({
    checkA: { verified: true }, checkB: { proved: true },
    hold: { from: '2019-01-01', to: '2019-08-01' }, member: { from: '2023-01-01' },
  });
  ok(v.auto_verdict === 'contradicted',
    'and the window BEATS a proved Check B — the deed can be right and still not be the borrower’s ownership');
  ok(/before the borrower joined/.test(v.message), '…with a message a person can act on');
}

// ────────────────────────────────────────────────────────────── DB
if (!process.env.DATABASE_URL) {
  console.log('\nSKIP the database section (no DATABASE_URL)');
  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  ownership carry (pure assertions only)');
  process.exit(fail ? 1 : 0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const tag = `trkown_${process.pid}`;

(async () => {
  await ensureSchema();
  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Own Tester','underwriter') RETURNING id`,
    [`${tag}_staff@example.com`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Own','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;

  const mkLlc = async (name) => {
    const id = (await db.query(`INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`,
      [borrowerId, name])).rows[0].id;
    await db.query(`INSERT INTO llc_borrowers (llc_id, borrower_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [id, borrowerId]);
    return id;
  };
  const mkLine = async (llcId, n) => (await db.query(
    `INSERT INTO track_records (borrower_id, llc_id, property_address, deal_type, purchase_date, sale_date)
     VALUES ($1,$2,$3::jsonb,'flip','2023-02-01','2024-05-01') RETURNING id`,
    [borrowerId, llcId, JSON.stringify({ line1: `${n} Carry St`, city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;
  const checkA = (llcId, on) => db.query(
    `UPDATE llc_borrowers SET ownership_verified=$3, ownership_verified_at=CASE WHEN $3 THEN now() ELSE NULL END,
            ownership_verified_by=CASE WHEN $3 THEN $4::uuid ELSE NULL END
      WHERE llc_id=$1 AND borrower_id=$2`, [llcId, borrowerId, on, staffId]);
  const pillar = async (trId) => (await db.query(
    `SELECT auto_verdict, auto_grade, satisfied_by_llc_id, human_verdict
       FROM track_record_pillars WHERE track_record_id=$1 AND pillar='ownership'`, [trId])).rows[0];

  // ═══════ 4. THE OWNER'S SENTENCE: ten properties, two entities, two Check A's
  console.log("\n4. Ten properties on two entities — verifying the two carries to all ten");
  {
    const A = await mkLlc('Carry Holdings A LLC');
    const B = await mkLlc('Carry Holdings B LLC');
    const linesA = []; const linesB = [];
    for (let i = 1; i <= 6; i += 1) linesA.push(await mkLine(A, i));
    for (let i = 7; i <= 10; i += 1) linesB.push(await mkLine(B, i));

    const before = await pillar(linesA[0]);
    ok(before.auto_verdict === null, 'every line starts with an unanswered ownership pillar');

    await checkA(A, true);
    const r1 = await O.syncEntityToTrackRecords(A, { checkB: () => ({ proved: true, confidence: 'certain' }) });
    ok(r1.ok && r1.carried === 6, `ONE Check A carried to all 6 of that entity's properties (carried ${r1.carried})`);

    const p = await pillar(linesA[0]);
    ok(p.auto_verdict === 'proved' && p.auto_grade === 'strong', '…as a machine-PROVED pillar');
    ok(String(p.satisfied_by_llc_id) === String(A), '…stamped with WHICH entity carried it');
    ok(p.human_verdict === null, '…and still awaiting a human — one click, not a fresh investigation');

    const untouched = await pillar(linesB[0]);
    ok(untouched.auto_verdict === null, "the other entity's properties are untouched — Check A is per entity");

    await checkA(B, true);
    const r2 = await O.syncEntityToTrackRecords(B, { checkB: () => ({ proved: true }) });
    ok(r2.carried === 4, `and the second Check A carries the remaining 4 (carried ${r2.carried})`);

    const all = (await db.query(
      `SELECT count(*)::int AS n FROM track_record_pillars p JOIN track_records t ON t.id=p.track_record_id
        WHERE t.borrower_id=$1 AND p.pillar='ownership' AND p.auto_verdict='proved'`, [borrowerId])).rows[0].n;
    ok(all === 10, `TWO Check A's, TEN properties with ownership evidence (got ${all}) — the owner's sentence, literally`);

    // Without Check B, the same carry says so plainly rather than passing.
    const C = await mkLlc('Carry Holdings C LLC');
    const cLine = await mkLine(C, 11);
    await checkA(C, true);
    const r3 = await O.syncEntityToTrackRecords(C, {});           // no checkB supplied
    ok(r3.noData === 1 && r3.carried === 0, 'with no Check B evidence the carry records no_data, not proved');
    const cp = await pillar(cLine);
    ok(cp.auto_verdict === 'no_data' && cp.human_verdict === null, '…on the line itself');

    // ═══════ 5. Revoking the entity revokes the carry — but not a human's decision
    console.log('\n5. Revoking Check A');
    {
      // A human confirms one of them first.
      await db.query(
        `UPDATE track_record_pillars SET human_verdict='confirmed', human_by=$2, human_at=now()
          WHERE track_record_id=$1 AND pillar='ownership'`, [linesA[0], staffId]);

      await checkA(A, false);
      const rev = await O.syncEntityToTrackRecords(A, {});
      ok(rev.cleared === 5, `revoking cleared the 5 machine-carried pillars (cleared ${rev.cleared})`);
      ok(rev.humanConfirmed.length === 1,
        'and REPORTED the one a human had confirmed instead of clearing it — a person’s decision is never silently erased');

      const stillThere = await pillar(linesA[0]);
      ok(stillThere.human_verdict === 'confirmed', '…that pillar still carries the human verdict');
      const wiped = await pillar(linesA[1]);
      ok(wiped.auto_verdict === null && wiped.satisfied_by_llc_id === null, '…while a machine-carried one is cleared');
    }

    // ═══════ 6. It never touches the DEAL's own verification
    console.log('\n6. Entity ownership is not deal verification');
    {
      const D = await mkLlc('Carry Holdings D LLC');
      const dLine = await mkLine(D, 12);
      await db.query(
        `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now(), verified_by=$2
          WHERE id=$1`, [dLine, staffId]);
      await checkA(D, true);
      await O.syncEntityToTrackRecords(D, { checkB: () => ({ proved: true }) });
      const row = (await db.query('SELECT is_verified FROM track_records WHERE id=$1', [dLine])).rows[0];
      ok(row.is_verified === true,
        'carrying ownership onto a verified line does not disturb its deal verification');

      await checkA(D, false);
      await O.syncEntityToTrackRecords(D, {});
      const row2 = (await db.query('SELECT is_verified FROM track_records WHERE id=$1', [dLine])).rows[0];
      ok(row2.is_verified === true,
        'and revoking the entity does not un-verify the DEAL either — they are different questions');
    }

    ok((await O.syncEntityToTrackRecords(null, {})).ok === true, 'a missing entity id is a no-op, not a throw');
  }

  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llc_borrowers WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llcs WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  the carry: verify the entity once, and every property it held inherits the evidence');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

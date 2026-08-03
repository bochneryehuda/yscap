'use strict';
/**
 * THE TRACK RECORD REVIEWS ITSELF, AND THE EXPERIENCE CONDITION WAITS FOR IT
 * (owner-directed 2026-08-02).
 *
 * The owner's rule, in their words: "we should NOT send it to the regular manual
 * review queue. We should have findings ON the track record of stuff that was
 * not done correctly … you should not be able to clear and sign off on the
 * experience condition till you clear those findings. If you find our SUBJECT
 * PROPERTY on the track record that should be a finding to be cleared … give a
 * few options over there what to do."
 *
 * Needs a real database: every assertion here is about rows, the partial-unique
 * index that stops a finding being raised twice, and the decision surviving a
 * re-run.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-track-record-findings-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const TRF = require('../src/lib/track-record-findings');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };
const tag = `trkfind_${process.pid}`;

const openFor = async (b) => (await db.query(
  `SELECT * FROM track_record_findings WHERE borrower_id=$1 AND status='open' ORDER BY created_at`, [b])).rows;

async function borrower(name) {
  return (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'Findings',$2) RETURNING id`,
    [name, `${tag}_${name}@example.com`])).rows[0].id;
}
async function line(borrowerId, oneLine, extra = {}) {
  const cols = { property_address: JSON.stringify({ oneLine }), origin: 'clickup_backfill', is_verified: false, ...extra };
  const names = Object.keys(cols), vals = Object.values(cols);
  return (await db.query(
    `INSERT INTO track_records (borrower_id, ${names.join(',')})
     VALUES ($1, ${names.map((_, i) => '$' + (i + 2)).join(',')}) RETURNING id`,
    [borrowerId, ...vals])).rows[0].id;
}

(async () => {
  await ensureSchema();
  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active)
     VALUES ($1,'Findings Reviewer','admin',true)
     ON CONFLICT (email) DO UPDATE SET is_active=true RETURNING id`, [`${tag}@example.com`])).rows[0].id;

  console.log('\nA. the detectors are PURE and never fabricate');
  const D = TRF._internals;
  ok(D.duplicateFindings([]).length === 0, 'no rows → nothing found');
  ok(D.duplicateFindings([{ id: '1', property_address: 'PO Box 9' }, { id: '2', property_address: 'PO Box 9' }]).length === 0,
    'an address nothing can read is never called a duplicate');
  ok(D.subjectPropertyFindings([{ id: '1', property_address: '5 Main St, Lakewood, NJ 08701' }], null, 'app1').length === 0,
    'no subject property on the file → nothing raised');
  ok(D.subjectPropertyFindings([{ id: '1', property_address: '5 Main St, Lakewood, NJ 08701' }],
    '5 Main St, Lakewood, NJ 08701', null).length === 0,
    'no file id → nothing raised (a subject-property finding is meaningless without the deal)');
  {
    // A PAIR is confirmed directly — the transitive trap that bit the merge pass
    // cannot reach the findings, because each pair is tested on its own.
    const three = [
      { id: 'bare', property_address: '5 Main St, Lakewood, NJ 08701' },
      { id: 'u1', property_address: '5 Main St Apt 1, Lakewood, NJ 08701' },
      { id: 'u2', property_address: '5 Main St Apt 2, Lakewood, NJ 08701' },
    ];
    const f = D.duplicateFindings(three);
    const pairs = f.map((x) => [x.trackRecordId, x.otherId].sort().join('|')).sort();
    ok(!pairs.includes('u1|u2'),
      'Apt 1 and Apt 2 are NEVER offered as a pair — only pairs the address check itself confirmed');
    ok(pairs.length === 2, 'the bare row is paired with each unit, and that is all');
  }
  ok(D.pairKey('a', 'b') === D.pairKey('b', 'a'),
    'a pair has ONE identity whichever way round it is seen — so a dismissal cannot be bypassed');

  console.log('\nB. a duplicate becomes a finding on the track record');
  const b1 = await borrower('Dup');
  const keepId = await line(b1, '26 South 10th Street, Brooklyn, NY 11249, USA', { purchase_price: 400000 });
  const dupId = await line(b1, '26 S 10th St, Brooklyn, NY 11249', { origin: 'encompass' });
  const s1 = await TRF.syncForBorrower(b1);
  ok(s1.ok && s1.raised === 1, 'the duplicate raised exactly one finding');
  const f1 = await openFor(b1);
  ok(f1.length === 1 && f1[0].code === 'duplicate_line', '…of the right kind');
  ok(f1[0].track_record_id === keepId && f1[0].other_id === dupId,
    '…naming the richer line as the one to keep');
  ok(/26 S(outh)? 10th/.test(f1[0].detail || ''), '…and quoting both addresses so a person can judge');
  ok((TRF.actionsFor('duplicate_line') || []).join(',') === 'merge,keep_both,dismiss',
    'it offers a few options, dismiss always among them');

  await TRF.syncForBorrower(b1);
  ok((await openFor(b1)).length === 1, 'running the detector again does not raise a second copy');

  console.log('\nC. nothing merges without a person, and the options work');
  ok((await db.query(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1`, [b1])).rows[0].n === 2,
    'both lines are still on the record — detection changed nothing');
  let refused = false;
  try { await TRF.resolveFinding({ findingId: f1[0].id, action: 'merge', actorId: null }); }
  catch (_) { refused = true; }
  ok(refused, 'a decision with nobody attached is refused');
  let badAction = false;
  try { await TRF.resolveFinding({ findingId: f1[0].id, action: 'remove_line', actorId: staffId }); }
  catch (_) { badAction = true; }
  ok(badAction, 'an option this finding does not offer is refused');

  await TRF.resolveFinding({ findingId: f1[0].id, action: 'merge', actorId: staffId });
  ok((await db.query(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1`, [b1])).rows[0].n === 1,
    'once a person picks “merge”, the two lines become one');
  ok((await openFor(b1)).length === 0, '…and the finding is settled');

  console.log('\nD. “they are two different properties” sticks forever');
  const b2 = await borrower('Units');
  await line(b2, '80 Bedford Ave, Brooklyn, NY 11249');
  await line(b2, '80 Bedford Ave Apt 5B, Brooklyn, NY 11249');
  await TRF.syncForBorrower(b2);
  const f2 = await openFor(b2);
  ok(f2.length === 1, 'the bare line and the unit are raised as a possible duplicate');
  await TRF.resolveFinding({ findingId: f2[0].id, action: 'keep_both', actorId: staffId });
  ok((await db.query(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1`, [b2])).rows[0].n === 2,
    '“keep both” removes nothing');
  await TRF.syncForBorrower(b2);
  await TRF.syncForBorrower(b2);
  ok((await openFor(b2)).length === 0,
    'and it is NEVER asked again — a decided finding stays decided across re-runs');

  console.log('\nE. the file’s own subject property on the record');
  const b3 = await borrower('Subject');
  const subj = { oneLine: '12 Churchill Lane, Lakewood, NJ 08701' };
  const app3 = (await db.query(
    `INSERT INTO applications (borrower_id, property_address, status)
     VALUES ($1,$2::jsonb,'underwriting') RETURNING id`, [b3, JSON.stringify(subj)])).rows[0].id;
  const subjLine = await line(b3, '12 Churchill Ln, Lakewood, NJ 08701, USA');
  await line(b3, '99 Elm St, Monsey, NY 10952');            // an unrelated real deal
  const s3 = await TRF.syncForFile(app3);
  ok(s3.ok && s3.raised === 1, 'the file’s own property is raised, and only it');
  const f3 = await openFor(b3);
  ok(f3[0].code === 'subject_property_on_record', '…as its own kind of finding');
  ok(f3[0].track_record_id === subjLine, '…pointing at the offending line');
  ok(f3[0].application_id === app3, '…and tied to the deal it is about');
  ok((TRF.actionsFor('subject_property_on_record') || []).join(',') === 'remove_line,not_our_property,dismiss',
    'with its own options — take it off, or say the borrower really did own it before');

  console.log('\nF. the experience condition is held until they are settled');
  const blocked = await TRF.experienceBlockReason(app3);
  ok(!!blocked && /track record/i.test(blocked), 'the gate refuses while a finding is open');
  ok(/Track record section/i.test(blocked), '…and says where to go');

  await TRF.resolveFinding({ findingId: f3[0].id, action: 'remove_line', actorId: staffId, appId: app3 });
  ok((await db.query(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1`, [b3])).rows[0].n === 1,
    '“take this line off” removes it');
  ok((await db.query(
    `SELECT count(*)::int n FROM track_records WHERE id=$1`, [subjLine])).rows[0].n === 0,
    '…the right one');
  ok((await TRF.experienceBlockReason(app3)) === null,
    'with nothing left to review, the experience condition is free to be signed off');

  console.log('\nG. an approved removal still refuses to destroy VERIFIED evidence');
  const b4 = await borrower('Verified');
  const app4 = (await db.query(
    `INSERT INTO applications (borrower_id, property_address, status)
     VALUES ($1,$2::jsonb,'underwriting') RETURNING id`, [b4, JSON.stringify(subj)])).rows[0].id;
  await line(b4, '12 Churchill Ln, Lakewood, NJ 08701', { is_verified: true });
  await TRF.syncForFile(app4);
  const f4 = await openFor(b4);
  let refusedVerified = false;
  try { await TRF.resolveFinding({ findingId: f4[0].id, action: 'remove_line', actorId: staffId, appId: app4 }); }
  catch (_) { refusedVerified = true; }
  ok(refusedVerified, 'even with a person behind it, verified evidence is not deleted from a finding');
  ok((await db.query(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1`, [b4])).rows[0].n === 1,
    '…and the line is still there');

  console.log('\nH. a finding whose problem went away closes itself');
  const b5 = await borrower('SelfClose');
  const l1 = await line(b5, '7 Oak Ave, Monsey, NY 10952');
  await line(b5, '7 Oak Avenue, Monsey, NY 10952, USA');
  await TRF.syncForBorrower(b5);
  ok((await openFor(b5)).length === 1, 'a duplicate is raised');
  await db.query(`DELETE FROM track_records WHERE id=$1`, [l1]);   // somebody fixed it elsewhere
  await TRF.syncForBorrower(b5);
  ok((await openFor(b5)).length === 0,
    'once the duplicate is gone the finding closes itself — it can never strand the experience condition');

  for (const b of [b1, b2, b3, b4, b5]) {
    await db.query('DELETE FROM track_record_findings WHERE borrower_id=$1', [b]).catch(() => {});
    await db.query('DELETE FROM applications WHERE borrower_id=$1', [b]).catch(() => {});
    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [b]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [b]).catch(() => {});
  }
  await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  track-record-findings: the desk finds it, a person decides it, and the experience condition waits');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

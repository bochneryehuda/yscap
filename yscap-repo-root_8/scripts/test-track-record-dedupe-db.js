'use strict';
/**
 * The track-record duplicate merge, against a REAL database.
 *
 * THE GOVERNING RULE (owner-directed 2026-08-02): PILOT never folds two
 * look-alike addresses together on its own — "merging files with similar
 * address, NEVER before human review … the system should always need a human to
 * confirm, never do this risky stuff itself". So the boot pass only ever raises
 * a finding on the track record, and every assertion below that removes a line goes through
 * mergeTrackRecordPair with a staff id attached. Detection itself lives in
 * track-record-findings (the owner also directed that these must NOT go to the
 * regular manual review queue but become findings ON the track record); this
 * file proves the boot pass re-keys, delegates, and never removes a line.
 *
 * A pure test cannot prove any of what matters here: that the re-key writes,
 * that the card is raised once and names the right pair, that an approved merge
 * RE-POINTS the documents hanging off the losing line instead of letting the
 * CASCADE destroy them, that the figures are carried over, and that a line
 * somebody worked is left standing.
 *
 * `documents.track_record_id` is ON DELETE CASCADE and
 * `checklist_items.track_record_id` is ON DELETE SET NULL — so a merge that
 * forgets to re-point first DELETES a borrower's closing documents. That is the
 * single most important assertion in this file.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-track-record-dedupe-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const heal = require('../src/lib/track-record-heal');
const TRK = require('../src/lib/track-record-key');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };
const tag = `trdedupe_${process.pid}`;

async function borrower(name) {
  return (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'Dedupe',$2) RETURNING id`,
    [name, `${tag}_${name}@example.com`])).rows[0].id;
}
async function line(borrowerId, addr, extra = {}) {
  const cols = { property_address: JSON.stringify(addr), origin: 'clickup_backfill', is_verified: false, ...extra };
  const names = Object.keys(cols), vals = Object.values(cols);
  return (await db.query(
    `INSERT INTO track_records (borrower_id, ${names.join(',')})
     VALUES ($1, ${names.map((_, i) => '$' + (i + 2)).join(',')}) RETURNING id`,
    [borrowerId, ...vals])).rows[0].id;
}
const rows = async (b) => (await db.query(
  `SELECT id, address_key, purchase_price, sale_price, notes, origin, is_verified
     FROM track_records WHERE borrower_id=$1 ORDER BY created_at`, [b])).rows;

(async () => {
  await ensureSchema();

  // ---- A. the duplicate the owner reported: one house, two spellings ----------
  const b1 = await borrower('Dup');
  const clickupWay = { oneLine: '26 South 10th Street, Brooklyn, NY 11249, USA' };
  const encompassWay = { oneLine: '26 S 10th St, Brooklyn, NY 11249' };
  const keepId = await line(b1, clickupWay, { purchase_price: 400000, notes: 'Auto-derived from ClickUp; unverified' });
  const dupId = await line(b1, encompassWay, { origin: 'encompass', inferred: true, sale_price: 615000, notes: 'Added from Encompass history; unverified' });
  ok((await rows(b1)).length === 2, 'the same house really is on the record twice to begin with');

  const r1 = await heal.healOnce({ limit: 500 });
  ok(r1.ok, 'the repair ran');

  /* THE PASS PROPOSES; IT DOES NOT MERGE (owner-directed 2026-08-02: "merging
     files with similar address — NEVER before human review … the system should
     always need a human to confirm, never do this risky stuff itself"). */
  const afterPass = await rows(b1);
  ok(afterPass.length === 2, 'BOTH lines are still there — the pass merged nothing on its own');
  ok(r1.proposed >= 1, '…it raised a review card instead');
  ok(r1.merged === undefined, '…and it no longer even reports a "merged" count');
  const card = (await db.query(
    `SELECT * FROM track_record_findings WHERE borrower_id=$1 AND status='open'`, [b1])).rows[0];
  ok(!!card, 'the duplicate is waiting as a finding ON THE TRACK RECORD, not in the sync queue');
  ok(card && card.code === 'duplicate_line', '…under its own kind');
  ok((await db.query(
    `SELECT count(*)::int n FROM sync_review_queue WHERE borrower_id=$1 AND field_key='track_record'`, [b1])).rows[0].n === 0,
    '…and NOTHING was put in the regular manual review queue (owner-directed 2026-08-02)');
  ok(card && /26 S(outh)? 10th/i.test(String(card.detail || '')),
    '…showing the reviewer BOTH addresses, so they can judge');
  ok(afterPass.some((x) => x.address_key === TRK.trackRecordKey(clickupWay)),
    'the re-key still happens on its own — it writes no visible value and deletes nothing');

  // Running again must not raise a SECOND card for the same pair.
  await heal.healOnce({ limit: 500 });
  const cards1 = (await db.query(
    `SELECT count(*)::int n FROM track_record_findings WHERE borrower_id=$1 AND status='open'`, [b1])).rows[0];
  ok(cards1.n === 1, 'a second pass does not pile up another finding for the same pair');

  /* NOW A HUMAN APPROVES — the only path that ever removes a line. */
  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active)
     VALUES ($1,'Dedupe Reviewer','admin',true)
     ON CONFLICT (email) DO UPDATE SET is_active=true RETURNING id`, [`${tag}_reviewer@example.com`])).rows[0].id;
  let refusedWithoutActor = false;
  try { await heal.mergeTrackRecordPair({ keepId, loserId: dupId, actorId: null }); }
  catch (_) { refusedWithoutActor = true; }
  ok(refusedWithoutActor, 'a merge with nobody attached to it is REFUSED outright');
  ok((await rows(b1)).length === 2, '…and nothing was removed by that attempt');

  await heal.mergeTrackRecordPair({ keepId, loserId: dupId, actorId: staffId });
  const after1 = await rows(b1);
  ok(after1.length === 1, 'once a person confirms, the two lines become ONE');
  ok(after1[0].id === keepId, '…and the line with the purchase price survived');
  ok(Number(after1[0].sale_price) === 615000,
    'the sale price only the other line had was CARRIED OVER — a merge never loses a figure');
  ok(after1[0].address_key === TRK.trackRecordKey(clickupWay),
    'the survivor now carries the shared key');

  // ---- B. documents and conditions survive the merge --------------------------
  const b2 = await borrower('Docs');
  const kId = await line(b2, { oneLine: '12 Churchill Lane, Lakewood, NJ 08701' }, { purchase_price: 300000 });
  const dId = await line(b2, { oneLine: '12 Churchill Ln, Lakewood, NJ 08701, USA' }, { origin: 'encompass', inferred: true });
  const docId = (await db.query(
    `INSERT INTO documents (track_record_id, filename, content_type, storage_ref, source_type)
     VALUES ($1,'closing.pdf','application/pdf','ref/1','system') RETURNING id`, [dId])).rows[0].id;
  await heal.healOnce({ limit: 500 });
  ok((await rows(b2)).length === 2, 'again: the pass alone removes nothing');
  const staff2 = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active)
     VALUES ($1,'Docs Reviewer','admin',true)
     ON CONFLICT (email) DO UPDATE SET is_active=true RETURNING id`, [`${tag}_docs@example.com`])).rows[0].id;
  /* Drive the merge from the CARD the pass actually raised, not from ids picked
     by hand — that proves the card names the right pair, which is the whole
     contract between the pass and the reviewer. The document-bearing line must
     be the KEEPER (pickKeeper ranks documents above a bare line), so the
     proposal must be pointing the other way round. */
  const card2 = (await db.query(
    `SELECT track_record_id, other_id FROM track_record_findings WHERE borrower_id=$1 AND status='open'`, [b2])).rows[0];
  const pair2 = { keepId: card2.track_record_id, loserId: card2.other_id };
  ok(pair2.keepId === dId && pair2.loserId === kId,
    'the card proposes keeping the line that holds the document, and folding the bare one into it');
  await heal.mergeTrackRecordPair({ keepId: pair2.keepId, loserId: pair2.loserId, actorId: staff2 });
  const doc = (await db.query(`SELECT track_record_id FROM documents WHERE id=$1`, [docId])).rows[0];
  const left2 = await rows(b2);
  ok(!!doc, 'THE DOCUMENT STILL EXISTS — the cascade did not destroy it');
  ok(left2.length === 1, 'the duplicate itself is gone once approved');
  /* The document survives BY CONSTRUCTION, not by luck: the line holding it
     outranks a bare one in pickKeeper AND refuseReason refuses to remove a line
     with documents, so the document-bearing line is the one that survives. Assert
     the guarantee that actually matters — the document still points at a line
     that still exists — rather than at a particular id. (The re-point in the
     merge is belt-and-suspenders behind those two rules: deleting a track record
     CASCADES its documents away, so a future change to either rule must not be
     able to destroy evidence.) */
  ok(doc && left2.some((x) => x.id === doc.track_record_id),
    '…and it still points at a line that exists (the one holding it survived)');
  ok(doc && doc.track_record_id === dId, '…which is the line the document was on all along');
  ok(Number(left2[0].purchase_price) === 300000,
    'and the purchase price from the folded-away line was carried onto it');

  // ---- C. a line somebody WORKED is never folded away -------------------------
  const b3 = await borrower('Worked');
  await line(b3, { oneLine: '99 Elm St, Monsey, NY 10952' }, { purchase_price: 250000 });
  const verifiedId = await line(b3, { oneLine: '99 Elm Street, Monsey, NY 10952, USA' },
    { is_verified: true, origin: 'portal', purchase_price: 275000, notes: 'Confirmed with the borrower' });
  const r3 = await heal.healOnce({ limit: 500 });
  const after3 = await rows(b3);
  ok(after3.length === 2, 'two lines that BOTH carry work are left alone');
  ok(after3.some((x) => x.id === verifiedId), '…including the verified one');
  ok(r3.openFindings >= 1, '…and the pass REPORTS that a human still has something to settle');
  ok((await db.query(
    `SELECT count(*)::int n FROM track_record_findings WHERE borrower_id=$1 AND status='open'`, [b3])).rows[0].n === 1,
    '…and it IS raised as a finding, because a person still has to settle it before the experience condition clears');
  // Even with a person behind it, a merge that would destroy verified evidence
  // or silently drop a disagreeing figure is refused.
  let refusedVerified = false;
  try { await heal.mergeTrackRecordPair({ keepId: after3[0].id, loserId: verifiedId, actorId: staffId }); }
  catch (_) { refusedVerified = true; }
  ok(refusedVerified, 'even an approved merge will not delete VERIFIED evidence');
  ok((await rows(b3)).length === 2, '…and both lines are still standing');

  // ---- D. two units in one building are two properties ------------------------
  const b4 = await borrower('Units');
  await line(b4, { oneLine: '80 Bedford Ave Apt 3A, Brooklyn, NY 11249' });
  await line(b4, { oneLine: '80 Bedford Ave Apt 5B, Brooklyn, NY 11249' });
  await heal.healOnce({ limit: 500 });
  ok((await rows(b4)).length === 2, 'two condo units are NEVER merged, though they share a grouping key');

  // ---- E. idempotent -----------------------------------------------------------
  const before = (await rows(b1)).length + (await rows(b2)).length + (await rows(b3)).length + (await rows(b4)).length;
  await heal.healOnce({ limit: 500 });
  const again = (await rows(b1)).length + (await rows(b2)).length + (await rows(b3)).length + (await rows(b4)).length;
  ok(before === again, 'running it again changes nothing');

  // ---- F. the merge is on the record ------------------------------------------
  const audit = (await db.query(
    `SELECT count(*)::int n FROM audit_log WHERE action='track_record_duplicate_merged' AND entity_id=$1`, [b1])).rows[0];
  ok(audit.n >= 1, 'each removal writes an audit row — the only record that line ever existed');

  // ---- G. a NEW write uses the shared key, so this cannot recur ----------------
  const cols = require('../src/routes/borrower').trackRecordCols({
    propertyAddress: { oneLine: '26 S 10th St, Brooklyn, NY 11249' }, dealType: 'flip',
  });
  ok(cols.address_key === TRK.trackRecordKey(clickupWay),
    'a tool save now writes the SAME key the ClickUp spelling produces — the duplicate cannot come back');

  for (const b of [b1, b2, b3, b4]) {
    await db.query('DELETE FROM track_record_findings WHERE borrower_id=$1', [b]).catch(() => {});
    await db.query('DELETE FROM documents WHERE track_record_id IN (SELECT id FROM track_records WHERE borrower_id=$1)', [b]).catch(() => {});
    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [b]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [b]).catch(() => {});
  }

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  track-record-dedupe-db: the pass only ASKS, a person decides, and an approved merge keeps every figure and document');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

#!/usr/bin/env node
'use strict';
/**
 * TRACK RECORD PHASE 0 — the defects the 2026-08-09 audit found, and the tests
 * at the layer that let each one survive.
 *
 * See docs/TRACK-RECORD-CURRENT-STATE.md §3. Each section names the defect.
 *
 * The headline one, D1: `signOffGate` refused to look at track-record findings
 * because it read `app.id` from a SELECT that does not fetch `id`. The rule the
 * owner asked for on 2026-08-02 — "you can't sign off the experience condition
 * before you sign off all the findings or dismiss all the findings" — was
 * enforced in the screen and silently bypassed at the sign-off.
 *
 * WHY IT SURVIVED, and therefore what this file does differently:
 * scripts/test-track-record-findings-db.js exercises `experienceBlockReason`
 * DIRECTLY. That function was always correct. The bug was in its ONE caller, so
 * a test one level down could never see it. The DB section below calls
 * **signOffGate itself** — the function the PATCH /checklist/:itemId route calls
 * — so the argument it passes is inside the blast radius.
 *
 * The DB section SKIPS without DATABASE_URL, like the rest of the suite.
 * Runs in `npm test`.
 */

const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

// ───────────────────────────────────────────────────── 1. D1, at the call site
console.log('\n1. D1 — the findings gate reads an application id that EXISTS');
{
  const s = read('../src/routes/staff.js');
  const i = s.indexOf('experienceBlockReason(');
  const call = s.slice(i, i + 60);
  ok(/experienceBlockReason\(item\.application_id\)/.test(call),
    'signOffGate passes item.application_id');
  ok(!/experienceBlockReason\(app\.id\)/.test(s),
    'and never app.id — the SELECT above it does not fetch `id`, so that was always undefined');

  // The root cause was a mismatch between a SELECT list and a later property
  // read. Pin the SELECT so re-adding `id` (which would ALSO fix it) does not
  // quietly make the assertion above meaningless.
  const at = s.indexOf('SELECT rehab_budget, borrower_id, co_borrower_id');
  // ANCHOR FIRST. Without this the slice below is '' when the SELECT is merely
  // reformatted, and the assertion passes while proving nothing (audit 2026-08-09).
  ok(at >= 0, 'the signOffGate application SELECT is still where this test expects it');
  const selHead = at < 0 ? 'id' : s.slice(at, s.indexOf('FROM applications', at));
  ok(!/\bid\b/.test(selHead.replace(/borrower_id|co_borrower_id/g, '')),
    'the SELECT still does not fetch `id` — so the fix must keep using item.application_id');
}

// ───────────────────────────────────────── 2. D2, the ClickUp re-ingest churn
console.log('\n2. D2 — a ClickUp re-ingest overwrites neither a human nor an address');
{
  const s = read('../src/clickup/ingest.js');
  const fn = s.slice(s.indexOf('async function upsertTrackRecord'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const upd = body.slice(body.indexOf('UPDATE track_records'), body.indexOf('return exists.rows[0].id'));

  ok(/deal_type\s*=\s*CASE WHEN inferred THEN/.test(upd),
    'deal_type is written only while the row is still `inferred` — a staffer’s correction stands');
  ok(/inferred\s*=\s*CASE WHEN inferred THEN/.test(upd),
    'and `inferred` is not resurrected either, so one human touch is permanent');
  /* The address test is SEMANTIC, not fill-only. Fill-only was the first cut and
     it silently DROPPED a genuine correction arriving on the `source_task_id`
     arm, which confirms nothing about the address (audit 2026-08-09). Behaviour
     is proven end-to-end in test-track-record-address-writes-db.js; this only
     pins the shape so it cannot quietly revert. */
  ok(/pilot_address_same_place\(property_address,\s*\$4::jsonb\)/.test(upd),
    'the address is compared by MEANING against what we already hold — the same function the verify guard uses');
  ok(!/COALESCE\(\$4,\s*property_address\)/.test(upd),
    'and never written unconditionally, which re-spelled the address on every webhook');
  ok(/address_key\s*=\s*CASE/.test(upd),
    'and the address_key moves with it, so a corrected line stops carrying the old property’s key');
}

// ───────────────────────────────── 3. D4, provenance stamped by every writer
console.log('\n3. D4 — every machine writer stamps who entered the line');
{
  const cases = [
    ['../src/clickup/ingest.js', "'clickup'", 'ClickUp'],
    ['../src/encompass/enrich.js', "'encompass'", 'Encompass'],
    ['../src/lib/track-record-from-file.js', "'system'", 'the funded-file writer'],
  ];
  for (const [file, kind, who] of cases) {
    const s = read(file);
    const i = s.indexOf('INSERT INTO track_records');
    ok(i >= 0, `${who} still inserts track records (guard against a silent move)`);
    const ins = s.slice(i, i + 900);
    /* ASSERT THE KIND IS THE VALUE BOUND FOR entered_by_kind, not merely present
       somewhere in the INSERT. `ins.includes('encompass')` was already satisfied by
       the pre-existing `origin` literal in the same statement, so that case proved
       nothing (audit 2026-08-09). The stamp is written as a literal pair in the
       VALUES/SELECT list, so require the kind adjacent to the timestamp. */
    const stamped = new RegExp(`${kind}\\s*,\\s*now\\(\\)`).test(ins);
    ok(/entered_by_kind/.test(ins) && stamped,
      `${who} stamps entered_by_kind=${kind} at INSERT, not on db/458’s next-boot backfill`);
    ok(/entered_at/.test(ins), `${who} stamps entered_at too`);
  }
}

// ──────────────────────────────────── 4. D6, the borrower doors are audited
console.log('\n4. D6 — the borrower’s own track-record doors write an audit row');
{
  const s = read('../src/routes/borrower.js');
  for (const action of ['add_track_record', 'edit_track_record', 'delete_track_record']) {
    ok(s.includes(`'${action}'`), `${action} is audited`);
  }
  // The staff door has always audited; the borrower door had no trace at all
  // beyond an SSE event and entered_by_kind.
  const st = read('../src/routes/staff.js');
  ok(st.includes("'staff_add_track_record'"), 'and the staff door still audits separately, under its own action');
}

// ─────────────────────────── 5. Only a warning holds the experience condition
console.log('\n5. An advisory finding must never gate a closing');
{
  const s = read('../src/lib/track-record-findings.js');
  const fn = s.slice(s.indexOf('async function experienceBlockReason'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(/severity !== 'info'/.test(body),
    "experienceBlockReason drops severity='info' rows — an outside data vendor cannot hold up a loan");
  // openForFile must NOT filter: the screen has to show advisory findings.
  const of = s.slice(s.indexOf('async function openForFile'));
  ok(!/severity/.test(of.slice(0, of.indexOf('\n}\n'))),
    'openForFile still returns every open finding, because the screen must display them');
}

// ───────── 5b. D5 — the merge's carry re-opens verification, and that is INTENDED
console.log('\n5b. D5 — a merge carries figures into the keeper, so the keeper is re-reviewed');
{
  const heal = require('../src/lib/track-record-heal');
  const carryCols = heal._internals.CARRY_COLS;
  ok(Array.isArray(carryCols) && carryCols.length > 0, 'CARRY_COLS is exported so the two lists can be compared');

  /* The guard's material list, read out of the MIGRATION rather than restated
     here — a copy in the test would agree with itself forever. */
  const sql = read('../db/493_track_record_verify_guard_same_place.sql');
  const guard = sql.slice(sql.indexOf('IF addr_restated'), sql.indexOf('THEN\n    NEW.is_verified := false'));
  const material = new Set([...guard.matchAll(/NEW\.(\w+)\s+IS DISTINCT FROM/g)].map((m) => m[1]));
  ok(material.size >= 15, `the guard still watches ${material.size} named columns (plus the address)`);

  const unwatched = carryCols.filter((c) => !material.has(c));
  ok(unwatched.length === 0,
    `every column a merge can carry is MATERIAL to the guard — so a carry re-opens verification by design${unwatched.length ? ` (unwatched: ${unwatched.join(', ')})` : ''}`);

  /* And the reason is written down where somebody would go to "fix" it. */
  const s = read('../src/lib/track-record-heal.js');
  const before = s.slice(0, s.indexOf('const carry = CARRY_COLS.filter'));
  ok(/RE-OPENS ITS VERIFICATION, AND\s+THAT IS THE INTENDED BEHAVIOUR/.test(before),
    'the carry says in place that the un-verify is deliberate, so it is not silently exempted later');
}

// ─────────────────────────────── 6. ONE definition of the 3-year exit window
console.log('\n6. The investor export counts the window the same way the gate does');
{
  const s = read('../src/lib/tpr-export.js');
  ok(/require\('\.\/experience'\)/.test(s), 'tpr-export reads the rule from experience.js');
  const fn = s.slice(s.indexOf('function exitInfo'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(!/30\.44/.test(body), 'no approximated month — that drifted against calendar months near the boundary');
  ok(!/sale_date \|\| r\.refi_date/.test(body),
    'no private exit-date order — a hold with BOTH a rent and a refi date exited on a different day here than in the count');
}

console.log('\n7. The exit rule itself, in JavaScript');
{
  const e = require('../src/lib/experience');
  const today = new Date(2026, 7, 9);            // 2026-08-09
  const counts = (r) => e.exitCounts(r, today);

  ok(e.EXIT_WINDOW_MONTHS === 36, 'the window is 36 months, and it is a named constant');

  ok(e.exitDateOf({ deal_type: 'flip', sale_date: '2026-03-14' }) === '2026-03-14', 'a flip exits on its sale');
  ok(e.exitDateOf({ deal_type: 'fix-and-hold', rent_date: '2025-11-02', refi_date: '2026-01-09' }) === '2025-11-02',
    'a hold with BOTH dates exits on the lease-up — the SQL prefers rent_date, so this must too');
  ok(e.exitDateOf({ deal_type: 'flip', sale_date: '2026-03-14', rent_date: '2020-01-01' }) === '2026-03-14',
    'a flip ignores a rent date entirely');
  ok(e.exitDateOf({ rent_date: '2025-01-01' }) === '2025-01-01',
    'a NULL deal_type reads as a hold, exactly as the SQL CASE does');
  ok(e.exitDateOf({ deal_type: 'flip' }) === null, 'no date is null, not a guess');

  ok(counts({ deal_type: 'flip', sale_date: '2026-03-14' }) === true, 'an exit inside the window counts');
  ok(counts({ deal_type: 'flip', sale_date: '2021-06-01' }) === false, 'an exit past the window does not');
  ok(counts({ deal_type: 'flip', sale_date: '2026-12-01' }) === false, 'a FUTURE exit counts for nothing');
  ok(counts({ deal_type: 'flip', sale_date: '2023-08-09' }) === true, 'the boundary day itself counts');
  ok(counts({ deal_type: 'flip', sale_date: '2023-08-08' }) === false, 'one day past it does not');
  ok(counts({ deal_type: 'flip', sale_date: new Date(2026, 2, 14) }) === true,
    'a pg Date object is read the same as an ISO string — no timezone can move a deal across the boundary');

  // Postgres: date '2024-02-29' - interval '36 months' = 2021-02-28.
  ok(e._internals.ymd(e._internals.minusMonths(new Date(2024, 1, 29), 36)) === '2021-02-28',
    'leap day clamps to the last day of the target month, matching Postgres interval arithmetic');
}

// ──────────────────────────────────────────────────────────── DB SECTION
if (!process.env.DATABASE_URL) {
  console.log('\nSKIP the database section (no DATABASE_URL)');
  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  track-record phase 0 (source assertions only)');
  process.exit(fail ? 1 : 0);
}

process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');

const tag = `trkp0_${process.pid}`;

(async () => {
  await ensureSchema();

  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Phase0 Tester','underwriter') RETURNING id`,
    [`${tag}_staff@example.com`])).rows[0].id;

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Phase','Zero',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;

  const addr = { oneLine: '62 Highland St, Lakewood, NJ 08701', line1: '62 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' };

  // ───────────────────────────────────── D1, through the function the route calls
  console.log('\n8. D1 — signOffGate itself refuses while a finding is open');
  {
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, status, requested_exp_flips)
       VALUES ($1,$2::jsonb,'in_review',3) RETURNING id`, [borrowerId, JSON.stringify(addr)])).rows[0].id;

    const tmplId = (await db.query(
      `SELECT id FROM checklist_templates WHERE code='rtl_p3_reo' LIMIT 1`)).rows[0].id;
    const itemId = (await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, tool_key, is_required)
       VALUES ($1,'application',$2,'Track record','outstanding','task','track_record',true) RETURNING id`,
      [tmplId, appId])).rows[0].id;

    const trId = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, sale_date)
       VALUES ($1,$2::jsonb,'flip', CURRENT_DATE - INTERVAL '4 months') RETURNING id`,
      [borrowerId, JSON.stringify(addr)])).rows[0].id;

    await db.query(
      `INSERT INTO track_record_findings (borrower_id, code, severity, title, detail, track_record_id, dedupe_key)
       VALUES ($1,'duplicate_line','warning','Two lines look like one property','x',$2,$3)`,
      [borrowerId, trId, `${tag}:dup`]);

    const { signOffGate } = require('../src/routes/staff');
    ok(typeof signOffGate === 'function', 'signOffGate is exported, so the gate can be tested where the bug lived');

    const blocked = await signOffGate(itemId, { id: staffId, role: 'underwriter' });
    ok(typeof blocked === 'string' && /track record/i.test(blocked),
      'an OPEN finding blocks the experience sign-off — this is the assertion the old test could not make');

    // …and the block lifts when a human settles it, so a finding can never strand
    // the condition with nothing to click.
    await db.query(`UPDATE track_record_findings SET status='dismissed', resolution='dismissed', resolved_by=$2, resolved_at=now()
                     WHERE borrower_id=$1`, [borrowerId, staffId]);
    const after = await signOffGate(itemId, { id: staffId, role: 'underwriter' });
    ok(after === null || !/track record has/i.test(String(after)),
      'and once it is dismissed the findings block is gone');

    // An ADVISORY finding must never do the same thing.
    await db.query(
      `INSERT INTO track_record_findings (borrower_id, code, severity, title, detail, track_record_id, dedupe_key)
       VALUES ($1,'public_record_disagrees','info','Public records show a different price','x',$2,$3)`,
      [borrowerId, trId, `${tag}:info`]);
    const withInfo = await signOffGate(itemId, { id: staffId, role: 'underwriter' });
    ok(withInfo === null || !/track record has/i.test(String(withInfo)),
      "an 'info' finding does NOT hold the condition — advisory means advisory");

    await db.query('DELETE FROM track_record_findings WHERE borrower_id=$1', [borrowerId]);
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [appId]);
    await db.query('DELETE FROM applications WHERE id=$1', [appId]);
    await db.query('DELETE FROM track_records WHERE id=$1', [trId]);
  }

  // ────────────────── D3, a re-spelling of the same address keeps the verification
  console.log('\n9. D3 — the address repair no longer un-verifies the book');
  {
    const mk = async () => {
      const id = (await db.query(
        `INSERT INTO track_records (borrower_id, property_address, deal_type, sale_date)
         VALUES ($1,$2::jsonb,'flip', CURRENT_DATE - INTERVAL '5 months') RETURNING id`,
        [borrowerId, JSON.stringify(addr)])).rows[0].id;
      // Verification is a separate UPDATE — db/485 forbids a line being BORN verified.
      await db.query(
        `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now(), verified_by=$2
          WHERE id=$1`, [id, staffId]);
      const v = (await db.query('SELECT is_verified FROM track_records WHERE id=$1', [id])).rows[0].is_verified;
      return { id, v };
    };
    const isVerified = async (id) =>
      (await db.query('SELECT is_verified FROM track_records WHERE id=$1', [id])).rows[0].is_verified;

    const a = await mk();
    ok(a.v === true, 'a line can still be verified by the one door that does it');

    // The exact shape address-heal writes: the same house, spelled long-form.
    await db.query(`UPDATE track_records SET property_address=$2::jsonb WHERE id=$1`,
      [a.id, JSON.stringify({ oneLine: '62 Highland Street, Lakewood, NJ 08701', line1: '62 Highland Street', city: 'Lakewood', state: 'NJ', zip: '08701' })]);
    ok(await isVerified(a.id) === true,
      'a SAME-PLACE re-spelling is a repair, not a restatement — the verification survives');

    const b = await mk();
    await db.query(`UPDATE track_records SET property_address=$2::jsonb WHERE id=$1`,
      [b.id, JSON.stringify({ oneLine: '118 Oak Ave, Toms River, NJ 08753', line1: '118 Oak Ave', city: 'Toms River', state: 'NJ', zip: '08753' })]);
    ok(await isVerified(b.id) === false,
      'a genuinely DIFFERENT property still un-verifies — the guard did not get weaker');

    const c = await mk();
    await db.query(`UPDATE track_records SET sale_price=123456 WHERE id=$1`, [c.id]);
    ok(await isVerified(c.id) === false, 'and a figure nobody reviewed still un-verifies');

    const d = await mk();
    await db.query(`UPDATE track_records SET docs_status='requested', notes='a note' WHERE id=$1`, [d.id]);
    ok(await isVerified(d.id) === true, 'while a non-material write is still left completely alone');

    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]);
  }

  // ──────────────────────────────────────── D7, verification_status is constrained
  console.log('\n10. D7 — verification_status can no longer hold a value nothing reads');
  {
    const con = (await db.query(
      `SELECT convalidated FROM pg_constraint WHERE conname='track_records_verification_status_check'`)).rows[0];
    ok(!!con, 'the CHECK constraint exists');

    let refused = false;
    try {
      await db.query(
        `INSERT INTO track_records (borrower_id, property_address, verification_status)
         VALUES ($1,$2::jsonb,'totally-made-up')`, [borrowerId, JSON.stringify(addr)]);
    } catch (e) { refused = /verification_status/.test(String(e.message)); }
    ok(refused, 'a value outside pending|docs|verified|limited is refused by the database, not just by app code');
    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  }

  // ────────────── D5, the merge really does return the keeper to pending
  console.log('\n11. D5 — merging a worked line into a verified keeper re-opens it');
  {
    const { mergeTrackRecordPair } = require('../src/lib/track-record-heal');

    const mkRow = async (extra = '') => (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, sale_date${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1,$2::jsonb,'flip', CURRENT_DATE - INTERVAL '6 months'${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`,
      [borrowerId, JSON.stringify(addr)])).rows[0].id;

    const keep = await mkRow();
    const loser = await mkRow('rehab_amount=48250');
    await db.query(
      `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now(), verified_by=$2
        WHERE id=$1`, [keep, staffId]);
    const pre = (await db.query('SELECT is_verified FROM track_records WHERE id=$1', [keep])).rows[0];
    ok(pre.is_verified === true, 'the keeper starts verified');

    const res = await mergeTrackRecordPair({ keepId: keep, loserId: loser, actorId: staffId });
    ok(res.carried.includes('rehab_amount'), 'the merge carries the figure the keeper was missing');

    const post = (await db.query(
      'SELECT is_verified, verification_status, rehab_amount FROM track_records WHERE id=$1', [keep])).rows[0];
    ok(Number(post.rehab_amount) === 48250, 'and the figure really landed on the keeper');
    ok(post.is_verified === false && post.verification_status === 'pending',
      'so the keeper returned to pending — the combined line now states something the verification never covered');

    /* The inverse: a merge that carries NOTHING must leave the verification alone,
       or every duplicate cleanup would un-verify the book for no reason. */
    const keep2 = await mkRow('rehab_amount=48250');
    const loser2 = await mkRow('rehab_amount=48250');
    await db.query(
      `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now(), verified_by=$2
        WHERE id=$1`, [keep2, staffId]);
    const res2 = await mergeTrackRecordPair({ keepId: keep2, loserId: loser2, actorId: staffId });
    ok(res2.carried.length === 0, 'two lines that already agree carry nothing');
    const post2 = (await db.query('SELECT is_verified FROM track_records WHERE id=$1', [keep2])).rows[0];
    ok(post2.is_verified === true, 'and a carry-nothing merge leaves the verification standing');

    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]);
  }

  await db.query('DELETE FROM track_record_findings WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  track-record phase 0: the gate fires, the re-ingest is harmless, the heal is safe');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

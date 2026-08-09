'use strict';
/**
 * THE VERIFY BUTTON — real Postgres, with the vendor stubbed.
 *
 * The three that matter:
 *   §2  A run writes the MACHINE's columns and NEVER a person's. Re-reading the
 *       county is not a reason to un-answer a question a human already answered,
 *       and db/494 keeps two sets of columns precisely so it cannot happen.
 *   §3  A run can never verify a line. Every check can come back proved and the
 *       project still does not count until a person confirms and verifies.
 *   §5  A FAILED lookup is filed as a failure, never as "nothing here". That
 *       exact confusion marked real properties permanently unresolvable once
 *       already (address_canon_cache, twice).
 *
 * Plus §6: the owner's money cap, enforced in the database so it survives a
 * deploy and spans every instance.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP track-record research (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

/* Stub the vendor BEFORE anything loads it. Nothing in this file reaches a real
   endpoint even if every switch were on. */
const clientPath = require.resolve('../src/elementix/client.js');
const realClient = require('../src/elementix/client');
const calls = [];
let reply = () => ({ ok: false, reason: 'disabled', detail: 'switched off' });
require.cache[clientPath].exports = {
  ...realClient,
  callTool: async (name, args, opts) => { calls.push({ name, args, opts }); return reply(name, args); },
};

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const VR = require('../src/lib/track-record/verify-run');
const tag = `trres_${process.pid}`;

const ADDR = { line1: '77 Research Rd', city: 'Lakewood', state: 'NJ', zip: '08701' };
const ONE_LINE = '77 Research Rd, Lakewood, NJ, 08701';

/* THE VENDOR'S REAL ENVELOPES AND FIELD NAMES.
 *
 * `match_entity` answers `{status, match:{…}}` — a SINGULAR OBJECT, never a
 * `results` array — and the name is `originalName`, never `name`. A deed row
 * carries `addresses[{addressFull}]`, `recordingDate` and `totalConsideration`.
 * This fixture previously used the invented `{results:[{address, recordedDate}]}`
 * shape, so the whole suite passed against a vendor that does not exist while
 * the real reader saw nothing at all. Captured shapes:
 * scripts/fixtures/elementix-shapes.json. */
const deedRow = (grantors, grantees, date, amount, docId) => ({
  id: docId, countyDocumentId: docId, dataSource: 'elementix',
  addresses: [{ id: `a_${docId}`, addressFull: ONE_LINE }],
  grantors, grantees, recordingDate: date, totalConsideration: amount,
  isGrantee: grantees.some((g) => /Research Holdings/i.test(g)),
  isGrantor: grantors.some((g) => /Research Holdings/i.test(g)),
});
const foundReply = (name) => {
  if (name === 'match_entity') {
    return { ok: true, data: { status: 'exact', match: {
      id: '11111111-2222-3333-4444-555555555555',
      originalName: 'RESEARCH HOLDINGS LLC', normalizedName: 'RESEARCH HOLDINGS LLC', state: 'NJ',
    } } };
  }
  if (name === 'get_entity_deeds') {
    return { ok: true, data: { data: [
      deedRow(['Somebody Else'], ['Research Holdings LLC'], '2024-02-08', 410000, 'D-ACQ'),
      deedRow(['Research Holdings LLC'], ['Marcus Reed'], '2025-06-20', 612000, 'D-SALE'),
    ] } };
  }
  return { ok: true, data: { data: [] } };
};

(async () => {
  await ensureSchema();

  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Research Tester','underwriter') RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Res','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;
  const llcId = (await db.query(
    `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'Research Holdings LLC') RETURNING id`, [borrowerId])).rows[0].id;
  await db.query(`INSERT INTO llc_borrowers (llc_id, borrower_id, ownership_verified) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [llcId, borrowerId]);
  const trId = (await db.query(
    `INSERT INTO track_records (borrower_id, llc_id, property_address, deal_type, purchase_date, sale_date)
     VALUES ($1,$2,$3::jsonb,'flip','2024-02-01','2025-06-15') RETURNING id`,
    [borrowerId, llcId, JSON.stringify(ADDR)])).rows[0].id;

  const pillars = async () => (await db.query(
    `SELECT pillar, auto_verdict, auto_source, auto_grade, auto_evidence, auto_checked_at, human_verdict, human_by
       FROM track_record_pillars WHERE track_record_id=$1 ORDER BY pillar`, [trId])).rows;
  const cacheRow = async () => (await db.query(
    `SELECT status, cacheable, api_calls FROM elementix_lookup_cache WHERE query_key LIKE $1`, [`trv1:${trId}:%`])).rows[0];

  console.log('\n1. A run reads the records and files what they say');
  {
    reply = foundReply;
    calls.length = 0;
    const out = await VR.runVerify(trId, { staffId, force: true });
    ok(out.ok === true && out.cached === false, 'the run answers');
    ok(out.calls > 0, `…having actually called the service (${out.calls})`);
    ok(!calls.some((c) => c.name === 'submit_contact_enrichment'),
      '…and NEVER the paid enrichment — a verification run must not be able to spend a credit');
    ok(!calls.some((c) => c.name === 'list_people'), '…nor the 145,873-character listing');

    const p = await pillars();
    const own = p.find((x) => x.pillar === 'ownership');
    ok(own.auto_verdict === 'proved', 'the deed naming the company as buyer proves ownership');
    ok(own.auto_source === 'elementix' && own.auto_grade === 'strong', '…recorded with its source and evidence grade');
    ok(own.auto_evidence && String(own.auto_evidence.why || '').length > 0, '…and something a reviewer can read');
    ok(p.find((x) => x.pillar === 'exit').auto_verdict === 'proved', 'the deed out to a stranger proves the exit');
    ok(p.every((x) => x.auto_checked_at), 'and every check records WHEN it was read');
  }

  console.log('\n2. It writes the machine\'s columns and never a person\'s');
  {
    // A person answers one check, the opposite way.
    const pid = (await db.query(
      `SELECT id FROM track_record_pillars WHERE track_record_id=$1 AND pillar='exit'`, [trId])).rows[0].id;
    await db.query(
      `UPDATE track_record_pillars SET human_verdict='rejected', human_by=$2, human_at=now() WHERE id=$1`, [pid, staffId]);

    reply = foundReply;
    const out = await VR.runVerify(trId, { staffId, force: true });
    const p = await pillars();
    const exit = p.find((x) => x.pillar === 'exit');
    ok(exit.human_verdict === 'rejected' && String(exit.human_by) === String(staffId),
      'the person\'s answer SURVIVES a re-run — re-reading the county is not a reason to un-answer them');
    ok(exit.auto_verdict === 'proved', '…while the machine\'s reading is refreshed alongside it');
    ok(out.pillars.some((x) => x.pillar === 'exit' && x.disagreesWithHuman === true),
      'and the run REPORTS the disagreement, because that is the thing a reviewer should look at');

    await db.query(`UPDATE track_record_pillars SET human_verdict=NULL, human_by=NULL, human_at=NULL WHERE id=$1`, [pid]);

    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/track-record/verify-run.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /* ASSIGNMENT, not comparison. `human_verdict\s*=` also matches
       `human_verdict === 'confirmed'`, which is a READ — and the module reads
       that column deliberately, to report a disagreement. The negative
       lookahead is what makes this guard mean "nothing WRITES a human column". */
    const writesHuman = /human_(verdict|by|at|note)\s*=(?!=)/.test(src);
    ok(!writesHuman, 'and the module contains NO statement that writes a human column at all');
    ok(/human_verdict\s*===/.test(src),
      '…while it does READ one, to report when the records now disagree with a person');
  }

  console.log('\n3. A run can never verify a line');
  {
    reply = foundReply;
    await VR.runVerify(trId, { staffId, force: true });
    const t = (await db.query('SELECT is_verified, verification_status FROM track_records WHERE id=$1', [trId])).rows[0];
    ok(t.is_verified === false,
      'every check proved, and the project is STILL not verified — a person confirms and verifies, not a lookup');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/track-record/verify-run.js'), 'utf8');
    ok(!/is_verified\s*=/.test(src), 'and the module cannot set that column — the statement does not exist');
  }

  console.log('\n4. A second run answers from the cache without spending anything');
  {
    reply = foundReply;
    calls.length = 0;
    const out = await VR.runVerify(trId, { staffId });
    ok(out.cached === true, 'the second run is answered from the cache');
    ok(calls.length === 0, '…with NOTHING sent to the vendor');
    ok((await cacheRow()).status === 'found', 'and the cached answer is filed as a real find');
  }

  console.log('\n5. A FAILED lookup is filed as a failure, never as "nothing here"');
  {
    const other = (await db.query(
      `INSERT INTO track_records (borrower_id, llc_id, property_address, deal_type, purchase_date, sale_date)
       VALUES ($1,$2,$3::jsonb,'flip','2024-02-01','2025-06-15') RETURNING id`,
      [borrowerId, llcId, JSON.stringify({ ...ADDR, line1: '78 Research Rd' })])).rows[0].id;

    reply = () => ({ ok: false, reason: 'disabled', detail: 'switched off' });
    const out = await VR.runVerify(other, { staffId, force: true });
    ok(out.searched === false, 'a run that could not reach the service reports that NOTHING was searched');
    ok(out.errors.length > 0, '…naming what failed');

    const row = (await db.query(
      `SELECT status, cacheable FROM elementix_lookup_cache WHERE query_key LIKE $1`, [`trv1:${other}:%`])).rows[0];
    ok(row.status === 'error', 'it is cached as an ERROR');
    ok(row.cacheable === false,
      '…which db/498\'s GENERATED column turns into "not knowledge" — so an outage can never be read later as "there is nothing here"');

    const p = (await db.query(
      `SELECT pillar, auto_verdict FROM track_record_pillars WHERE track_record_id=$1`, [other])).rows;
    ok(p.filter((x) => x.pillar !== 'recency').every((x) => x.auto_verdict === 'no_data'),
      'and the checks say "no data", never a contradiction — a failed lookup is not evidence against a borrower');

    // The next run tries again rather than reading the failure as an answer.
    reply = foundReply;
    calls.length = 0;
    const again = await VR.runVerify(other, { staffId });
    ok(again.cached === false && calls.length > 0, 'the NEXT run tries again rather than trusting the failure');

    await db.query('DELETE FROM elementix_lookup_cache WHERE query_key LIKE $1', [`trv1:${other}:%`]).catch(() => {});
    await db.query('DELETE FROM track_records WHERE id=$1', [other]).catch(() => {});
  }

  console.log('\n6. THE MONEY CAP — the owner\'s 1,000 a month, counted in the database');
  {
    const C = realClient;   // the REAL client, not the stub
    const before = await C.paidThisMonth();
    ok(before.ok === true && typeof before.n === 'number', 'the month\'s spend is readable');

    const noActor = await C.callTool('submit_contact_enrichment', {}, {});
    ok(noActor.reason === 'paid_tool_refused', 'a paid call with no actor is refused');
    const oldWay = await C.callTool('submit_contact_enrichment', {}, { allowPaid: true });
    ok(oldWay.reason === 'paid_tool_refused',
      'and the OLD boolean `allowPaid` no longer works — a boolean cannot say who asked or about whom');
    const halfActor = await C.callTool('submit_contact_enrichment', {}, { paidActor: { staffId, personId: 'p1' } });
    ok(halfActor.reason === 'paid_tool_refused', 'nor an actor with no stated reason');

    // Fill the month.
    const cap = 1000;
    await db.query(
      `INSERT INTO elementix_calls (tool, paid, staff_id, subject_id, reason)
       SELECT 'submit_contact_enrichment', true, $1::uuid, 'x', 'filling the cap' FROM generate_series(1,$2)`,
      [staffId, cap]);
    const capped = await C.callTool('submit_contact_enrichment', {},
      { paidActor: { staffId, personId: 'p1', reason: 'the borrower asked us to call them' } });
    ok(capped.reason === 'paid_cap_reached',
      'with the month used up, a paid call is refused even WITH a full actor — the cap is the owner\'s, not a suggestion');
    ok(/resets next month/.test(capped.detail), '…and says when it comes back');

    await db.query(`DELETE FROM elementix_calls WHERE staff_id=$1`, [staffId]);
    const after = await C.paidThisMonth();
    ok(after.n === before.n, 'and the count is a real read of the ledger, not a number held in memory');
  }

  console.log('\n7. Every lookup is attributable');
  {
    const clientSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/elementix/client.js'), 'utf8');
    const lookupSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/elementix/lookups.js'), 'utf8');
    const n = (await db.query(
      `SELECT count(*)::int AS n FROM elementix_calls WHERE staff_id=$1 AND NOT paid`, [staffId])).rows[0].n;
    ok(n === 0, 'the stub bypasses the ledger, so this counts only what the real client wrote');
    /* The hourly guard reads the SAME ledger, so it spans every instance and
       survives a deploy — unlike the in-memory bucket it now backs up. */
    ok(/overBudgetShared/.test(clientSrc) && /interval '1 hour'/.test(clientSrc),
      'and the hourly allowance is read from that ledger, not from a counter in one process');
    ok(/fails open/i.test(clientSrc),
      '…failing OPEN, deliberately — an unreadable ledger must not take lookups down, while the MONEY cap fails closed');
    /* ONE WRITER. The client is the only module that talks to Elementix, so it
       is the only one that records — two writers would double-count the number
       the hourly guard reads, and it would then throttle at half the allowance. */
    ok(/INSERT INTO elementix_calls/.test(clientSrc) && /staff_id/.test(clientSrc),
      'the client records WHO asked on every call — Elementix sees one company account, so without it nobody can answer "who used the allowance?"');
    ok(!/INSERT INTO elementix_calls/.test(lookupSrc),
      '…and it is the ONLY writer — the research module deliberately does not record a second time');
  }

  await db.query('DELETE FROM elementix_lookup_cache WHERE query_key LIKE $1', [`trv1:${trId}:%`]).catch(() => {});
  await db.query('DELETE FROM elementix_calls WHERE staff_id=$1', [staffId]).catch(() => {});
  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llc_borrowers WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llcs WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  the records are read on a click, filed as the machine\'s answer only, and no credit can be spent');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

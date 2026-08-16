'use strict';
/**
 * Trinity → SITEWIRE write-back, and the Sitewire-door delivery — REAL Postgres, with
 * Sitewire's API stubbed.
 *
 * WHAT IS BEING PROVEN, and why it needs a database.
 *
 * The physical program has TWO doors. A PORTAL draw request carries its own decision
 * record. A draw the borrower submitted IN SITEWIRE does not — the draw lives in
 * Sitewire — so a Trinity order placed against one produced a completed inspection whose
 * figures had nowhere to go and a Deliver button that refused. The fix writes the
 * inspector's per-line figures onto the Sitewire draw's own request rows and then hands
 * off to the EXISTING delivery machinery, so the borrower's accept/dispute experience is
 * byte-for-byte what it already is (owner-directed 2026-08-16: *"we still need to follow
 * the workflow of getting borrower approval … Follow everything like it was in the
 * beginning."*).
 *
 * Every claim below is about MONEY landing on a row, a crosswalk resolving, or a guard
 * refusing — none of which a pure test can see, and all of which sit behind a
 * best-effort catch in production, where a phantom column would report a confident
 * success forever. Sitewire itself is stubbed: there is no Sitewire sandbox in this
 * repo, so what is proven here is OUR behaviour — which field is written, that it is
 * capped, that it is written once per RESULT rather than once per poll, that a failure
 * parks instead of half-writing, and that NOTHING approves or releases a draw.
 *
 * Skips cleanly when DATABASE_URL is unset.
 */

if (!process.env.DATABASE_URL) { console.log('test-trinity-writeback-db: SKIPPED (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');

// ---- stub Sitewire BEFORE writeback.js requires it -------------------------------
// writeback.js requires these lazily, so stubbing the module objects here is enough.
const swClient = require('../src/sitewire/client');
const orchestrator = require('../src/sitewire/orchestrator');
const switches = require('../src/lib/integrations/switches');

const calls = { patches: [], journals: [], parks: [], circuit: 0 };
let remoteApproved = new Map();      // requestId -> what Sitewire says it holds
let nextPatchThrows = null;
let getDrawThrows = null;

swClient.updateRequest = async (id, body) => {
  calls.patches.push({ id: Number(id), body });
  if (nextPatchThrows) { const e = nextPatchThrows; nextPatchThrows = null; throw e; }
  remoteApproved.set(Number(id), Number(body.approved_cents));
  return { id: Number(id) };
};
swClient.getDraw = async (id) => {
  if (getDrawThrows) { const e = getDrawThrows; getDrawThrows = null; throw e; }
  return {
    id: Number(id),
    requests: [...remoteApproved.entries()].map(([rid, cents]) => ({ id: rid, approved_cents: cents })),
  };
};
orchestrator.circuitCheck = async () => { calls.circuit++; };
orchestrator.journal = async (e) => { calls.journals.push(e); };
orchestrator.park = async (p) => { calls.parks.push(p); };

// Both switches ON — the write path is what is under test. The OFF cases are asserted
// explicitly below by flipping this stub, which is also how a real deploy behaves
// (the gate reads the switch at call time, never at require time).
let sitewireOn = true;
let outboundOn = true;
switches.on = (key) => (key === 'SITEWIRE_ENABLED' ? sitewireOn : key === 'SITEWIRE_OUTBOUND_ENABLED' ? outboundOn : false);

const writeback = require('../src/trinity/writeback');

let n = 0, failed = 0;
const ok = (cond, label) => { n++; if (cond) return; failed++; console.error('  ✘ ' + label); };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

(async () => {
  // ---- fixture -------------------------------------------------------------------
  const email = `trinwb-${Date.now()}@example.com`;
  const b = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Grace','Hopper',$1) RETURNING id`, [email])).rows[0];
  const a = (await db.query(
    `INSERT INTO applications (borrower_id, status, property_address, property_type, units, loan_amount, loan_type, rehab_budget)
     VALUES ($1,'funded',$2::jsonb,'SFR',1,350000,'Purchase',140000) RETURNING id`,
    [b.id, JSON.stringify({ oneLine: '9 Elm St, Lakewood, NJ' })])).rows[0];
  // A SECOND file, so "the draw belongs to this file" is proven against a real other
  // file rather than a made-up id — writing money onto another file's draw is the worst
  // thing this module could do.
  const a2 = (await db.query(
    `INSERT INTO applications (borrower_id, status, property_address, property_type, units, loan_amount, loan_type)
     VALUES ($1,'funded',$2::jsonb,'SFR',1,200000,'Purchase') RETURNING id`,
    [b.id, JSON.stringify({ oneLine: '11 Elm St, Lakewood, NJ' })])).rows[0];

  const base = 700000 + Math.floor(Math.random() * 200000);
  const prop = base;
  const drawId = base + 1;
  const JID_ROOF = base + 11;
  const JID_KITCHEN = base + 12;
  const JID_ORPHAN = base + 13;          // a line Trinity reports that is not on this draw
  const REQ_ROOF = base + 21;
  const REQ_KITCHEN = base + 22;

  await db.query(
    `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, status)
     VALUES ($1,$2,$3,1,'pending')`, [a.id, drawId, prop]);
  await db.query(
    `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, requested_cents)
     VALUES ($1,$2,$3,$4)`, [drawId, REQ_ROOF, JID_ROOF, 1000000]);
  await db.query(
    `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, requested_cents)
     VALUES ($1,$2,$3,$4)`, [drawId, REQ_KITCHEN, JID_KITCHEN, 1500000]);

  const rec = (await db.query(
    `INSERT INTO trinity_inspection_orders (application_id, sitewire_draw_id, customer_key, status, results_read_at)
     VALUES ($1,$2,$3,'report_received',now()) RETURNING *`, [a.id, drawId, `swd-${drawId}`])).rows[0];

  const RESULTS = [
    { sitewire_job_item_id: JID_ROOF, approved_cents: 800000, name: 'Roof' },
    { sitewire_job_item_id: JID_KITCHEN, approved_cents: 1500000, name: 'Kitchen' },
  ];
  const reload = async () => (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0];

  // ---- A. the write itself --------------------------------------------------------
  const first = await writeback.pushApprovalsToSitewire(a.id, rec, RESULTS);
  ok(first.ok, 'A1 the write-back runs');
  eq(first.written, 2, 'A2 both lines are written');
  eq(calls.patches.length, 2, 'A3 exactly one PATCH per line');

  // THE FIELD IS THE WHOLE DECISION. `pending_approved_cents` looks right and is a
  // CREATE-time field; the borrower's findings are built by reconcile.fetchDrawFindings,
  // which reads `approved_cents` and treats a null as "the inspector has not answered
  // this line" (the tri-state doctrine, db/518). Writing the pending field would hand
  // the borrower an accept page saying the inspector had answered nothing.
  ok(calls.patches.every((p) => Object.prototype.hasOwnProperty.call(p.body, 'approved_cents')),
    'A4 the figures are written to approved_cents — the field the borrower’s findings are built from');
  ok(calls.patches.every((p) => !('pending_approved_cents' in p.body)),
    'A5 and never to pending_approved_cents, which would read as "the inspector answered nothing"');
  const roofPatch = calls.patches.find((p) => p.id === REQ_ROOF);
  eq(roofPatch.body.approved_cents, 800000, 'A6 the roof carries the inspector’s own figure');
  eq(calls.journals.length, 2, 'A7 every write is journaled');
  eq(calls.circuit, 2, 'A8 and every write is counted against the volume circuit breaker');
  eq(first.verified && first.verified.disagreed, 0, 'A9 the draw is re-read and the figures agree');
  ok((await reload()).writeback_at, 'A10 the file records that the figures landed');

  // ---- B. once per RESULT, not once per poll --------------------------------------
  // The poller re-reads a completed order on every tick. Without the fingerprint this
  // would journal a Sitewire write a minute, forever.
  const patchesBefore = calls.patches.length;
  const again = await writeback.pushApprovalsToSitewire(a.id, await reload(), RESULTS);
  eq(again.skipped, 'already_written', 'B1 an unchanged result is not written again');
  eq(calls.patches.length, patchesBefore, 'B2 and no second PATCH is sent');

  // A REVISION genuinely differs, so it IS written again — an inspector correcting a
  // report must reach the borrower.
  const revised = [{ ...RESULTS[0], approved_cents: 900000 }, RESULTS[1]];
  const rev = await writeback.pushApprovalsToSitewire(a.id, await reload(), revised);
  ok(rev.ok, 'B3 a REVISED result is written');
  eq(calls.patches.filter((p) => p.id === REQ_ROOF).length, 2, 'B4 the corrected line is re-sent');
  eq(remoteApproved.get(REQ_ROOF), 900000, 'B5 and Sitewire ends up holding the corrected figure');

  // ---- C. never more than the borrower asked for ----------------------------------
  // Over-approving is a deliberate human act in Sitewire and must never be something an
  // adapter does on its own.
  const over = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_ROOF, approved_cents: 99999999, name: 'Roof' }]);
  ok(over.ok, 'C1 an over-large figure does not fail the write');
  eq(remoteApproved.get(REQ_ROOF), 1000000, 'C2 it is CAPPED at what the borrower requested on that line');
  const negative = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_ROOF, approved_cents: -5000, name: 'Roof' }]);
  ok(negative.ok, 'C3 a negative figure does not fail the write');
  eq(remoteApproved.get(REQ_ROOF), 0, 'C4 and floors at zero rather than crediting money back');

  // ---- D. a line that is not on this draw is not ours to write ---------------------
  const orphan = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_ORPHAN, approved_cents: 500000, name: 'Deck' },
     { sitewire_job_item_id: JID_KITCHEN, approved_cents: 1200000, name: 'Kitchen' }]);
  eq(orphan.written, 1, 'D1 only the line that exists on this draw is written');
  ok((orphan.skipped || []).some((s) => s.reason === 'not_on_this_draw'), 'D2 and the other is reported, never silently dropped');
  // Trinity's own lines (nothing of ours to tie them to) are reported too.
  const trinOwn = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: null, approved_cents: 100, name: 'Trinity’s own line' },
     { sitewire_job_item_id: JID_KITCHEN, approved_cents: 1300000, name: 'Kitchen' }]);
  ok((trinOwn.skipped || []).some((s) => s.reason === 'trinity_own_line'), 'D3 a line with no crosswalk is reported as Trinity’s own');

  // ---- E. the guards that refuse outright -----------------------------------------
  eq((await writeback.pushApprovalsToSitewire(a.id, { ...rec, sitewire_draw_id: null }, RESULTS)).skipped,
    'not_a_sitewire_draw', 'E1 an order with no Sitewire draw is refused (the portal door owns that one)');
  eq((await writeback.pushApprovalsToSitewire(a.id, await reload(), [])).skipped,
    'no_results', 'E2 nothing to write is a no-op, never an empty write');
  // THE WORST CASE: a Trinity order naming ANOTHER file's draw. Writing money onto it
  // would be far worse than refusing.
  eq((await writeback.pushApprovalsToSitewire(a2.id, await reload(), RESULTS)).skipped,
    'draw_not_on_file', 'E3 a draw that does not belong to this file is refused');
  // Both switches must be on.
  sitewireOn = false;
  eq((await writeback.pushApprovalsToSitewire(a.id, await reload(), RESULTS)).skipped,
    'sitewire_off', 'E4 with Sitewire off, nothing is written');
  sitewireOn = true;
  outboundOn = false;
  // WRITES OFF is a full stand-down, not a quiet dry run: with the write gate off and no
  // dry-run mode asked for, nothing is built and nothing is claimed — the same two-switch
  // shape every other guarded Sitewire write uses.
  eq((await writeback.pushApprovalsToSitewire(a.id, await reload(), RESULTS)).skipped,
    'sitewire_writes_off', 'E5 with the write gate off, nothing is written');
  // DRY RUN is the deliberate third state: build the write, send nothing.
  const cfg = require('../src/config');
  const realDry = cfg.sitewireDryrun;
  cfg.sitewireDryrun = true;
  const dry = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_KITCHEN, approved_cents: 1400000, name: 'Kitchen' }]);
  ok(dry.dryrun, 'E6 dry-run mode reports itself as a dry run');
  eq(dry.written, 1, 'E7 and still reports what it WOULD have written');
  ok(!calls.patches.some((p) => p.body.approved_cents === 1400000), 'E8 while sending nothing to Sitewire');
  cfg.sitewireDryrun = realDry;
  outboundOn = true;

  // ---- F. a failure PARKS, it never half-writes silently ---------------------------
  const parksBefore = calls.parks.length;
  nextPatchThrows = Object.assign(new Error('sitewire 500'), { retryable: true });
  const failedRun = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_ROOF, approved_cents: 700000, name: 'Roof' },
     { sitewire_job_item_id: JID_KITCHEN, approved_cents: 900000, name: 'Kitchen' }]);
  ok(failedRun.error, 'F1 a failed write reports an error rather than a partial success');
  eq(calls.parks.length, parksBefore + 1, 'F2 and parks it for a human');
  ok(/by hand|retry/i.test(calls.parks[calls.parks.length - 1].reason), 'F3 with a plain-language instruction');
  // The fingerprint must NOT be stamped, or the next poll would skip the retry.
  const afterFail = await reload();
  ok(afterFail.writeback_fingerprint !== `${JID_ROOF}:700000|${JID_KITCHEN}:900000`.split('|').sort().join('|'),
    'F4 a failed run does not stamp the fingerprint, so the next poll re-drives it');

  // A verification we could not PERFORM is not a success either.
  getDrawThrows = new Error('sitewire unreachable');
  const unread = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_KITCHEN, approved_cents: 1100000, name: 'Kitchen' }]);
  eq(unread.verified, 'unreadable', 'F5 a draw we could not re-read is reported as unverified');
  eq(unread.restamp, false, 'F6 and is deliberately left to the next poll rather than claimed as done');

  // A draw that accepts the write but reads back DIFFERENT figures is a park, not a pass.
  const parks2 = calls.parks.length;
  const realGetDraw = swClient.getDraw;
  swClient.getDraw = async (id) => ({ id: Number(id), requests: [{ id: REQ_KITCHEN, approved_cents: 1 }] });
  const disagreed = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_KITCHEN, approved_cents: 1234500, name: 'Kitchen' }]);
  ok(disagreed.error, 'F7 figures that read back different are an error');
  eq(calls.parks.length, parks2 + 1, 'F8 and are parked before anybody approves them');
  swClient.getDraw = realGetDraw;

  // ---- G. THE AUTOPILOT IS STILL OFF ----------------------------------------------
  // This module records what the inspector found and stops. Money moves when a person
  // decides it does — there is no approval and no release anywhere on this path.
  const drawRow = (await db.query(
    `SELECT status FROM sitewire_draws WHERE sitewire_draw_id=$1`, [drawId])).rows[0];
  eq(drawRow.status, 'pending', 'G1 the DRAW is never approved or transitioned by the write-back');
  const src = require('fs').readFileSync(require.resolve('../src/trinity/writeback'), 'utf8');
  ok(!/drawTransition|deliverFindings|release/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
    'G2 and the module contains no transition, delivery or release call at all');
  const findings = (await db.query(
    `SELECT count(*)::int AS c FROM draw_findings WHERE application_id=$1`, [a.id])).rows[0];
  eq(findings.c, 0, 'G3 nothing has been delivered to the borrower');
  const notes = (await db.query(
    `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1`, [a.id])).rows[0];
  eq(notes.c, 0, 'G4 and the borrower has not been notified of anything');

  // ---- H2. "NOT AN ERROR" IS NOT THE SAME AS "IT LANDED" ---------------------------
  //
  // This is the failure mode that does not announce itself, and the reason the deliver
  // route tests for a POSITIVE outcome rather than for the absence of `.error`. Several
  // results are not errors and yet mean the figures are NOT on the draw. Delivering on
  // one of them would build the borrower's findings from a draw still holding NULL
  // approvals — which `fetchDrawFindings` reads as "the inspector has not answered this
  // line", so a finished inspection would be presented to the borrower as an unanswered
  // one. The route's rule is `(ok && !dryrun && written > 0) || skipped ===
  // 'already_written'`; these assert every result it must refuse fails that test.
  const notLanded = (r) => !((r.ok && !r.dryrun && (r.written || 0) > 0) || r.skipped === 'already_written');

  // THE CASE `ok` ALONE WOULD HAVE LET THROUGH. Every line names a job item that is not
  // on this draw, so the run succeeds, reports each line under `skipped`, and writes
  // NOTHING — a perfectly successful result with nothing on the draw. `written > 0` is
  // the only thing that tells the two apart, and this assertion is what found it.
  const noTies = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_ORPHAN, approved_cents: 500000, name: 'Deck' }]);
  ok(noTies.ok, 'H2a a run whose lines are all off this draw still SUCCEEDS…');
  eq(noTies.written, 0, 'H2b …having written nothing');
  ok(notLanded(noTies), 'H2c so it must NOT read as a landed write-back');
  // And a run with no crosswalk at all refuses before it starts.
  const noCrosswalk = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: null, approved_cents: 500000, name: 'Trinity’s own line' }]);
  eq(noCrosswalk.skipped, 'no_lines_tied_to_this_file', 'H2d nothing tied to OUR budget at all is refused up front');
  ok(notLanded(noCrosswalk), 'H2e and does not read as landed either');

  sitewireOn = false;
  ok(notLanded(await writeback.pushApprovalsToSitewire(a.id, await reload(), RESULTS)),
    'H2f Sitewire switched off does not read as a landed write-back');
  sitewireOn = true;

  const cfg2 = require('../src/config');
  const realDry2 = cfg2.sitewireDryrun;
  outboundOn = false; cfg2.sitewireDryrun = true;
  const dryRun2 = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_KITCHEN, approved_cents: 1050000, name: 'Kitchen' }]);
  ok(dryRun2.ok, 'H2g a dry run reports ok…');
  ok(notLanded(dryRun2), 'H2h …but must NOT read as landed — it deliberately sent nothing');
  cfg2.sitewireDryrun = realDry2; outboundOn = true;

  ok(notLanded(await writeback.pushApprovalsToSitewire(a2.id, await reload(), RESULTS)),
    'H2i another file’s draw does not read as landed');
  // The two that MAY proceed.
  const landedNow = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_KITCHEN, approved_cents: 1450000, name: 'Kitchen' }]);
  ok(!notLanded(landedNow), 'H2j a real write reads as landed');
  const alreadyThere = await writeback.pushApprovalsToSitewire(a.id, await reload(),
    [{ sitewire_job_item_id: JID_KITCHEN, approved_cents: 1450000, name: 'Kitchen' }]);
  eq(alreadyThere.skipped, 'already_written', 'H2k an unchanged re-run reports already_written');
  ok(!notLanded(alreadyThere), 'H2l which DOES read as landed — the figures are on the draw');
  // The route must actually apply this rule, not just have it available.
  const routeSrc = require('fs').readFileSync(require.resolve('../src/routes/trinity'), 'utf8');
  ok(/already_written/.test(routeSrc) && /wb\.ok\s*&&\s*!wb\.dryrun\s*&&\s*\(wb\.written\s*\|\|\s*0\)\s*>\s*0/.test(routeSrc),
    'H2m and the deliver route gates on that positive test, never on the absence of an error');

  // ---- H. the timeline records when the figures landed -----------------------------
  // Trinity has no history endpoint (db/555), so this is the only record of the
  // sequence — and "when did the inspector's figures reach the draw?" is the question a
  // coordinator asks the moment a number looks wrong.
  const ev = (await db.query(
    `SELECT count(*)::int AS c FROM trinity_order_events
      WHERE trinity_inspection_order_id=$1 AND kind='writeback'`, [rec.id])).rows[0];
  ok(ev.c >= 1, 'H1 a write-back is recorded on the progress timeline');

  // ---- cleanup ---------------------------------------------------------------------
  await db.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [drawId]);
  await db.query(`DELETE FROM sitewire_draws WHERE sitewire_draw_id=$1`, [drawId]);
  await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[a.id, a2.id]]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [b.id]);

  if (failed) { console.error(`test-trinity-writeback-db: ${failed} FAILED of ${n}`); process.exit(1); }
  console.log(`test-trinity-writeback-db: ${n} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('test-trinity-writeback-db CRASHED:', e); process.exit(1); });

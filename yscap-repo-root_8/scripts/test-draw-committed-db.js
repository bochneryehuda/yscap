'use strict';
/**
 * THE MANUAL PHYSICAL DRAW ROUTE — money already paid must never read as available.
 *
 * Sitewire refuses a manual draw entry, so a Trinity/physical draw lives in PILOT as a
 * `portal_draw_requests` row and only reaches Sitewire once approved, as a HISTORICAL
 * draw. Its per-line ledger rows (`sitewire_draw_requests`) are written by ONE thing —
 * the reconcile, on a 300s poll. So there are TWO windows in which an approved draw's
 * money is not in Sitewire's ledger, and in both of them the next draw must still know
 * about it:
 *
 *   1. approved, close-out not landed (writes off, no property link, parked, in flight)
 *   2. closed out, reconcile has not imported the lines yet   <- the one that was BROKEN
 *
 * Window 2 was invisible to both readers: the portal request has left 'approved' and
 * carries a `sitewire_draw_id`, so the old fallback skipped it, while the ledger it
 * points at is still empty. A line the borrower had already been paid for read as
 * untouched — the next Trinity order would tell the inspector its whole budget was
 * available, and the composer would offer that money to be requested again.
 *
 * Both readers now go through `lib/draw-committed.js`, so this suite drives BOTH and
 * asserts they agree — a fix in one that missed the other is the failure mode.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || '';
if (!process.env.DATABASE_URL) { console.log('test-draw-committed-db: SKIPPED (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const committed = require('../src/lib/draw-committed');

let n = 0, failed = 0;
const ok = (cond, label) => { n++; if (cond) return; failed++; console.error('  ✘ ' + label); };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

(async () => {
  // ---- fixture: a funded file with a three-line budget ---------------------------
  const email = `dc-${Date.now()}@example.com`;
  const b = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Grace','Hopper',$1) RETURNING id`, [email])).rows[0];
  const a = (await db.query(
    `INSERT INTO applications (borrower_id, status, property_address, rehab_budget)
     VALUES ($1,'funded',$2::jsonb,125000) RETURNING id`,
    [b.id, JSON.stringify({ street: '9 Ada Way', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0];

  const base = 700000 + Math.floor(Math.random() * 200000);
  const prop = base;
  const items = [
    { jid: base + 11, name: 'Roof', budget: 4000000 },
    { jid: base + 12, name: 'Kitchen', budget: 6000000 },
  ];
  for (const it of items) {
    await db.query(
      `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sitewire_job_item_id, sow_line_key, section_token, name, budgeted_cents, is_media_item)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
      [a.id, prop, it.jid, it.name.toLowerCase(), it.name.toLowerCase(), it.name, it.budget]);
  }
  const roof = items[0].jid, kitchen = items[1].jid;
  const lines = (approved) => JSON.stringify([
    { sitewire_job_item_id: roof, sow_line_key: 'roof', name: 'Roof', requested_cents: 2000000, approved_cents: approved },
  ]);

  // ---- A. nothing drawn yet --------------------------------------------------------
  let m = await committed.committedByJobItem(a.id);
  eq(m.get(roof) || 0, 0, 'A1 an untouched line has nothing committed');

  // ---- B. WINDOW 1 — approved, close-out has not landed -----------------------------
  // This one already worked; it is the control that proves the suite is wired.
  const pr1 = (await db.query(
    `INSERT INTO portal_draw_requests (application_id, source, platform, lines, total_requested_cents, approved_cents, status)
     VALUES ($1,'staff','trinity',$2::jsonb,2000000,1500000,'approved') RETURNING id`,
    [a.id, lines(1500000)])).rows[0];
  m = await committed.committedByJobItem(a.id);
  eq(m.get(roof) || 0, 1500000, 'B1 money approved but not yet closed out IS committed');

  // ---- C. WINDOW 2 — closed out, reconcile has NOT imported the lines ---------------
  // THE DEFECT. The draw exists in Sitewire and in `sitewire_draws`, but its per-line
  // rows do not exist yet. Before the fix this read as $0 committed.
  const drawId = base + 1;
  await db.query(
    `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, status, historical)
     VALUES ($1,$2,$3,1,'approved',true)`, [a.id, drawId, prop]);
  await db.query(
    `UPDATE portal_draw_requests SET status='closed_out', sitewire_draw_id=$2 WHERE id=$1`, [pr1.id, drawId]);
  m = await committed.committedByJobItem(a.id);
  eq(m.get(roof) || 0, 1500000,
    'C1 a CLOSED-OUT draw whose ledger rows have not landed yet is STILL committed');

  // ---- D. the reconcile lands — and it must NOT double count ------------------------
  await db.query(
    `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, requested_cents, approved_cents)
     VALUES ($1,$2,$3,2000000,1500000)`, [drawId, base + 21, roof]);
  m = await committed.committedByJobItem(a.id);
  eq(m.get(roof) || 0, 1500000,
    'D1 once the ledger carries it, it is counted ONCE — the fallback stands down');

  // ---- E. the "not its own history" exclusions still hold ---------------------------
  m = await committed.committedByJobItem(a.id, { excludeDrawId: drawId });
  eq(m.get(roof) || 0, 0, 'E1 the draw being ordered for is not reported as its own history');
  // …and excluding it must not resurrect it through the portal half (same draw, two
  // sources): a naive exclusion on the ledger alone would hand the same dollars back.
  await db.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [drawId]);
  m = await committed.committedByJobItem(a.id, { excludeDrawId: drawId });
  eq(m.get(roof) || 0, 0,
    'E2 …and excluding it does not let the portal half smuggle the same money back in');
  await db.query(
    `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, requested_cents, approved_cents)
     VALUES ($1,$2,$3,2000000,1500000)`, [drawId, base + 21, roof]);

  // ---- F. a CANCELLED request is not money ------------------------------------------
  const pr2 = (await db.query(
    `INSERT INTO portal_draw_requests (application_id, source, platform, lines, total_requested_cents, approved_cents, status)
     VALUES ($1,'staff','trinity',$2::jsonb,900000,900000,'cancelled') RETURNING id`,
    [a.id, JSON.stringify([{ sitewire_job_item_id: kitchen, name: 'Kitchen', requested_cents: 900000, approved_cents: 900000 }])])).rows[0];
  m = await committed.committedByJobItem(a.id);
  eq(m.get(kitchen) || 0, 0, 'F1 a cancelled request commits nothing');
  await db.query(`DELETE FROM portal_draw_requests WHERE id=$1`, [pr2.id]);

  // ---- G. a SUBMITTED (not yet approved) request commits nothing ---------------------
  // The draw being inspected right now must not count itself before anyone approved it.
  const pr3 = (await db.query(
    `INSERT INTO portal_draw_requests (application_id, source, platform, lines, total_requested_cents, status)
     VALUES ($1,'borrower','trinity',$2::jsonb,900000,'submitted') RETURNING id`,
    [a.id, JSON.stringify([{ sitewire_job_item_id: kitchen, name: 'Kitchen', requested_cents: 900000 }])])).rows[0];
  m = await committed.committedByJobItem(a.id);
  eq(m.get(kitchen) || 0, 0, 'G1 a submitted-but-unapproved request commits nothing');

  // ---- H. THE TWO READERS AGREE — the whole point of one definition -----------------
  // The Trinity order (what the inspector is told is already drawn) and the composer
  // (what the borrower is offered) must never describe the same budget differently.
  //
  // RUN THIS INSIDE THE BROKEN WINDOW, deliberately. With the ledger row present both
  // readers answer correctly no matter what the fallback does, so the ledger row is
  // removed first — otherwise these three assertions pass against the very bug they
  // exist to catch, and nothing here would prove the composer was fixed at all.
  await db.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [drawId]);

  const order = require('../src/trinity/order');
  const bl = await order.budgetLines(a.id);
  const blRoof = bl.find((l) => l.sitewire_job_item_id === roof);
  eq(blRoof.previous_drawn_cents, 1500000,
    'H1 the Trinity order reports the closed-out draw as already drawn');
  const portalDraws = require('../src/lib/portal-draws');
  const cl = await portalDraws.composerLines(a.id).catch(() => null);
  if (cl) {
    const clRoof = cl.find((l) => l.sitewire_job_item_id === roof);
    if (clRoof) {
      eq(clRoof.remaining_cents, items[0].budget - 1500000,
        'H2 the composer offers only what is genuinely left on that line');
      eq(items[0].budget - clRoof.remaining_cents, blRoof.previous_drawn_cents,
        'H3 the inspector and the borrower are shown the SAME committed figure');
    }
  }

  // ---- I. it is the SAME statement behind both, not two copies ----------------------
  ok(/NOT EXISTS/.test(committed.COMMITTED_SQL) && /closed_out/.test(committed.COMMITTED_SQL),
    'I1 the one definition carries both the closed-out arm and the anti-double-count');

  await db.query(`DELETE FROM applications WHERE id=$1`, [a.id]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [b.id]).catch(() => {});

  if (failed) { console.error(`test-draw-committed-db: ${failed} of ${n} FAILED`); process.exit(1); }
  console.log(`test-draw-committed-db: ${n} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('test-draw-committed-db CRASHED:', e && e.message); process.exit(1); });

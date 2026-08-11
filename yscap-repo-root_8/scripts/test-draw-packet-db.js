/* THE DRAW DESK'S NUMBERS, END TO END, AGAINST A REAL DATABASE (owner-reported 2026-08-03, file
 * YSCAP258134591 / 195-197 Parrish St draw #1). The pure suite
 * (scripts/test-draw-approval-ladder.js) proves the rules; this one proves the WIRING — the SQL, the
 * fee resolution and the Excel packet — because every one of these bugs lived in a query or a join
 * that no pure test could reach:
 *
 *   1. the inspection-count HEAL — the draw-level Sitewire payload never carries the inspections
 *      array, so the mirror stored 0 on every poll and four fully-photographed roof lines were
 *      flagged "no inspection photos attached". The heal raises the count from the delivered
 *      findings + the archived media, and can never lower a real one.
 *   2. loadRollup — an inspector-approved draw is COMMITTED, so the budget stops reporting the whole
 *      amount as still available; the draw prints the INSPECTOR-approved figure, not Sitewire's
 *      final-approval field; our draw fee is projected from the file's own rule before any release
 *      is recorded, and the project's fee income is tracked separately.
 *   3. the Excel packet — the TOTAL row's "approved" and every line's "still available".
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-draw-packet-db.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-draw-packet-db (no DATABASE_URL)');
  process.exit(0);
}

const crypto = require('crypto');
const db = require('../src/db');
const rollupMod = require('../src/sitewire/rollup');
const EV = require('../src/sitewire/inspection-evidence');
const { buildDrawPacket } = require('../src/sitewire/draw-packet');

// find a row in the packet by its first cell
const rowOf = (rows, label) => rows.find((r) => String(r[0] || '').toLowerCase() === String(label).toLowerCase());

(async () => {
  // ---- the reported file: a $220,000 budget, one $25,000 Roof line exploded across 4 units, one
  //      draw the inspector approved in full while Sitewire still reports it as `pending`. ----
  const email = 'dp' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Draw','Packet',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'DP' + crypto.randomBytes(3).toString('hex');
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address)
     VALUES($1,'funded',$2,'Fidelis','{"oneLine":"195-197 Parrish St","city":"Wilkes-Barre","state":"PA","zip":"18702"}') RETURNING id`, [bor, loan])).rows[0].id;

  const BASE = 810000 + crypto.randomBytes(2).readUInt16BE(0) * 10;
  const DRAW = BASE, BUDGET = BASE + 1, PROP = BASE + 2;
  const JI = (u) => BASE + 100 + u;      // job item per unit
  const REQ = (u) => BASE + 200 + u;     // draw request per unit
  const OTHER_JI = BASE + 300;

  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at,inspection_method) VALUES($1,$2,'created','live',now(),'mobile')`, [app, PROP]);
  await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES($1,$2,1,'pending',2500000,0)`, [app, DRAW]);
  // the $25,000 Roof line, one job item per unit — plus $195,000 of budget this draw never touches
  for (const u of [1, 2, 3, 4]) {
    await db.query(
      `INSERT INTO sitewire_job_item_links(application_id,sitewire_budget_id,sow_line_key,section_token,unit_index,sitewire_job_item_id,name,budgeted_cents,state)
       VALUES($1,$2,'cat:roof',$3,$4,$5,$6,625000,'live')`, [app, BUDGET, 'u' + u, u, JI(u), `Unit ${u} - Roof`]);
    await db.query(
      `INSERT INTO sitewire_draw_requests(sitewire_draw_id,sitewire_request_id,sitewire_job_item_id,job_item_name,requested_cents,approved_cents,inspection_count)
       VALUES($1,$2,$3,$4,625000,625000,0)`, [DRAW, REQ(u), JI(u), `Unit ${u} - Roof`]);
  }
  await db.query(
    `INSERT INTO sitewire_job_item_links(application_id,sitewire_budget_id,sow_line_key,section_token,sitewire_job_item_id,name,budgeted_cents,state)
     VALUES($1,$2,'cat:rest','all',$3,'Everything else',19500000,'live')`, [app, BUDGET, OTHER_JI]);

  // the delivered findings: five photos per roof line (this is what the inspector actually filed)
  const fid = (await db.query(
    `INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at)
     VALUES($1,$2,'delivered',2500000,2500000,now()) RETURNING id`, [app, DRAW])).rows[0].id;
  for (const u of [1, 2, 3, 4]) {
    await db.query(
      `INSERT INTO draw_finding_lines(finding_id,sitewire_request_id,sitewire_job_item_id,sow_line_key,unit_index,name,requested_cents,approved_cents,not_approved_cents,inspector_comments,photo_count,video_count)
       VALUES($1,$2,$3,'cat:roof',$4,$5,625000,625000,0,'JV - Torch down roof installation complete.',5,0)`,
      [fid, REQ(u), JI(u), u, `Unit ${u} - Roof`]);
  }

  // ======================================================================
  // 1. THE INSPECTION-COUNT HEAL
  // ======================================================================
  {
    const before = (await db.query(`SELECT inspection_count FROM sitewire_draw_requests WHERE sitewire_request_id=$1`, [REQ(1)])).rows[0];
    eq('1a the mirror really does store 0 — this is the bug, reproduced', Number(before.inspection_count), 0);
    await db.query(EV.HEAL_SQL, [app, DRAW]);
    const after = (await db.query(`SELECT sitewire_request_id, inspection_count FROM sitewire_draw_requests WHERE sitewire_draw_id=$1 ORDER BY sitewire_request_id`, [DRAW])).rows;
    eq('1b the heal raises every roof line to its real photo count', after.map((r) => Number(r.inspection_count)), [5, 5, 5, 5]);
    // a count Sitewire DID send must never be lowered by the heal
    await db.query(`UPDATE sitewire_draw_requests SET inspection_count=12 WHERE sitewire_request_id=$1`, [REQ(1)]);
    await db.query(EV.HEAL_SQL, [app, DRAW]);
    const kept = (await db.query(`SELECT inspection_count FROM sitewire_draw_requests WHERE sitewire_request_id=$1`, [REQ(1)])).rows[0];
    eq('1c a higher real count is never lowered by the heal', Number(kept.inspection_count), 12);
    await db.query(`UPDATE sitewire_draw_requests SET inspection_count=5 WHERE sitewire_request_id=$1`, [REQ(1)]);
    // it is idempotent
    const n1 = (await db.query(EV.HEAL_SQL, [app, DRAW])).rowCount;
    eq('1d re-running the heal changes nothing', n1, 0);
    // and it never reaches another file's rows
    const other = (await db.query(`SELECT count(*)::int c FROM sitewire_draw_requests r JOIN sitewire_draws d ON d.sitewire_draw_id=r.sitewire_draw_id WHERE d.application_id <> $1 AND r.inspection_count > 0 AND r.sitewire_draw_id=$2`, [app, DRAW])).rows[0];
    eq('1e the heal is scoped to this file', other.c, 0);
  }

  // ======================================================================
  // 2. loadRollup — committed money, the inspector's approval, and our fee
  // ======================================================================
  const rollup = await rollupMod.loadRollup(db, app);
  {
    const roof = rollup.lines.find((l) => l.sow_line_key === 'cat:roof');
    eq('2a the roof line is budgeted $25,000', Number(roof.budgeted), 2500000);
    eq('2b nothing is released yet', Number(roof.drawn), 0);
    eq('2c the inspector-approved draw is COMMITTED against the line', Number(roof.committed), 2500000);
    eq('2d so the line has $0 still available (it used to report the whole $25,000)', Number(roof.available), 0);
    eq('2e the project reports $195,000 available, not the full $220,000', Number(rollup.project.available), 19500000);
    eq('2f `remaining` keeps its released-only meaning for the risk engine', Number(rollup.project.remaining), 22000000);

    const d = rollup.draws.find((x) => x.sitewire_draw_id === DRAW);
    eq('2g the draw prints the INSPECTOR-approved $25,000, not Sitewire\'s $0', Number(d.approved_cents), 2500000);
    eq('2h final approval is still $0 — we have not pressed it', Number(d.final_approved_cents), 0);
    eq('2i the stage says so in words', d.approval_stage, 'borrower_review');
    ok('2j our draw fee is projected before any release is recorded', Number(d.fee_cents) > 0 && d.fee_projected === true);
    eq('2k the net release is the approval less the fee', Number(d.net_release_cents), 2500000 - Number(d.fee_cents));
    ok('2l the netting is explained in words', /draw processing fee/.test(d.net_explanation || ''));

    ok('2m our fees on this project are tracked separately', rollup.fees && Number(rollup.fees.total_cents) > 0);
    eq('2n nothing is CHARGED yet (no release recorded)', Number(rollup.fees.charged_cents), 0);
    eq('2o …it is all still expected', Number(rollup.fees.projected_cents), Number(rollup.fees.total_cents));
  }

  // ======================================================================
  // 3. THE EXCEL PACKET
  // ======================================================================
  {
    const rows = await buildDrawPacket(app, DRAW);
    const roof = rows.find((r) => String(r[0]).toLowerCase().includes('roof'));
    ok('3a the roof line appears on the schedule of values', !!roof);
    eq('3b …with this draw\'s $25,000 requested', roof[3], 25000);
    eq('3c …and $25,000 approved', roof[4], 25000);
    eq('3d …and $0 still available (it used to say $25,000)', roof[5], 0);
    eq('3e …at 100% used (it used to say 0%)', roof[6], 100);

    const total = rowOf(rows, 'TOTAL');
    eq('3f the TOTAL row approves $25,000 — it used to read $0 under a column of real approvals', total[4], 25000);
    eq('3g the TOTAL row shows $195,000 still available', total[5], 195000);

    eq('3h the packet spells out what the borrower actually requested', rowOf(rows, 'Requested by the borrower')[1], 25000);
    eq('3i …what the inspector approved', rowOf(rows, 'Approved by the inspector')[1], 25000);
    eq('3j …that we have not finally approved it yet', rowOf(rows, 'Final approved by us')[1], 'not yet');
    const feeRow = rows.find((r) => String(r[0]).toLowerCase().startsWith('less: draw processing fee'));
    ok('3k …the fee it nets out, as a negative', feeRow && feeRow[1] < 0);
    const net = rowOf(rows, 'NET RELEASE to the borrower');
    eq('3l …and the net that actually wires', net[1], 25000 + feeRow[1]);
    ok('3m the packet explains that an un-finalised draw still counts against the budget',
      rows.some((r) => /goes straight back to available/i.test(String(r[0] || ''))));
    ok('3n our fee income on the project is its own section', rows.some((r) => String(r[0]) === 'OUR FEES ON THIS PROJECT'));
    ok('3o the inspection findings still list every line with its photo count',
      rows.filter((r) => /^Unit \d - Roof$/.test(String(r[0] || ''))).length === 4);
    const unit1 = rows.find((r) => String(r[0]) === 'Unit 1 - Roof');
    eq('3p …and the photo count is the real one', unit1[4], 5);
  }

  // ======================================================================
  // 4. once we finally approve AND record the release, the story changes
  // ======================================================================
  {
    await db.query(`UPDATE sitewire_draws SET status='approved', total_approved_cents=2500000 WHERE sitewire_draw_id=$1`, [DRAW]);
    await db.query(
      `INSERT INTO draw_disbursements(application_id,sitewire_draw_id,approved_cents,fee_cents,fee_kind,retainage_held_cents,net_release_cents,funded_status,kind,release_date)
       VALUES($1,$2,2500000,29900,'virtual',0,2470100,'released','draw',CURRENT_DATE)`, [app, DRAW]);
    const r2 = await rollupMod.loadRollup(db, app);
    const d = r2.draws.find((x) => x.sitewire_draw_id === DRAW);
    eq('4a final approval is now a real number', Number(d.final_approved_cents), 2500000);
    eq('4b the recorded net release wins over the projection', Number(d.net_release_cents), 2470100);
    ok('4c the fee is no longer a projection', d.fee_projected === false);
    eq('4d the stage is released', d.approval_stage, 'released');
    const roof = r2.lines.find((l) => l.sow_line_key === 'cat:roof');
    eq('4e the money is now RELEASED, not merely committed', Number(roof.drawn), 2500000);
    eq('4f available is unchanged at $0 — never double-counted', Number(roof.available), 0);
    eq('4g our fee is now CHARGED, not expected', Number(r2.fees.charged_cents), 29900);
    eq('4h …and nothing is left expected', Number(r2.fees.projected_cents), 0);
  }

  // ======================================================================
  // 5. THE PACKET IS FILED AS A DOCUMENT so it mirrors into the per-draw
  //    SharePoint folder ("Draws/Draw N") alongside the inspection reports.
  // ======================================================================
  {
    const { storeDrawPacketDoc } = require('../src/sitewire/draw-packet');
    const backup = require('../src/lib/sharepoint-backup');
    const docId = await storeDrawPacketDoc(app, DRAW);
    ok('5a storeDrawPacketDoc files a document', !!docId);
    const doc = (await db.query(
      `SELECT filename, doc_kind, source_type, visibility, is_current, review_status
         FROM documents WHERE id=$1`, [docId])).rows[0];
    ok('5b it is a system-generated, staff-only, current, born-accepted draw_packet',
      doc && doc.doc_kind === 'draw_packet' && doc.source_type === 'system'
        && doc.visibility === 'staff_only' && doc.is_current === true && doc.review_status === 'accepted');
    ok('5c the filename names the draw so it can be routed', /^pilot-draw-1-packet-.*\.xlsx$/.test(doc.filename));
    eq('5d it categorizes to the Draw 1 folder (the per-draw anchor)',
      backup.categoryFor({ doc_kind: doc.doc_kind, filename: doc.filename }), 'Draws/Draw 1');
    // idempotent: same data -> same filename -> same row, no duplicate current packet
    const again = await storeDrawPacketDoc(app, DRAW);
    eq('5e re-filing the same packet returns the same document (idempotent)', again, docId);
    const currentCount = (await db.query(
      `SELECT count(*)::int c FROM documents WHERE application_id=$1 AND doc_kind='draw_packet' AND is_current=true`, [app])).rows[0].c;
    eq('5f there is exactly ONE current packet for the draw', currentCount, 1);
    // 5g the unique index (db/479) is the REAL backstop that makes the 23505 catch
    //    reachable: two concurrent boot backfills across Render instances both pass
    //    the existing-filename SELECT, but the second INSERT is refused — so a draw
    //    can never end up with two current packets.
    let dupBlocked = false;
    try {
      await db.query(
        `INSERT INTO documents (application_id, filename, content_type, size_bytes, storage_provider, storage_ref,
            uploaded_by_kind, doc_kind, source_type, visibility, is_current, review_status)
         VALUES ($1,$2,'x',1,'local','x/y','staff','draw_packet','system','staff_only',true,'accepted')`,
        [app, doc.filename]);
    } catch (e) { dupBlocked = !!(e && e.code === '23505'); }
    ok('5g a duplicate draw_packet (same application+filename) is refused by the unique index', dupBlocked);
  }

  // ======================================================================
  // 6. THE LIST COLUMN — inspector_approved_cents is findings-aware
  //    The staff draws dashboard, the borrower list and the TPO list all read a
  //    per-draw "Approved" column. It must equal the report/email headline
  //    (approval.inspectorApproved): mirror -> delivered findings -> total.
  //    Before the fix it summed the request mirror ONLY, so a fully-inspected
  //    draw whose mirror had not caught up read $0 while the report read the
  //    inspector's figure (owner-reported 2026-08-10, 109 Chapel St).
  // ======================================================================
  {
    const bsd = require('../src/sitewire/borrower-safe-draws');
    const D2 = BASE + 400, R2 = BASE + 401;   // mirror-lag: inspector answered in findings, mirror still NULL
    const D3 = BASE + 500, R3 = BASE + 501;   // legacy findings-0: an answered $0 (matches the headline)
    // D2 — the inspector approved $7,700 in the findings; the request mirror is still NULL
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES($1,$2,2,'pending_capital_partner',825000,0)`, [app, D2]);
    await db.query(`INSERT INTO sitewire_draw_requests(sitewire_draw_id,sitewire_request_id,sitewire_job_item_id,job_item_name,requested_cents,approved_cents) VALUES($1,$2,$3,'Roof',825000,NULL)`, [D2, R2, JI(1)]);
    const f2 = (await db.query(`INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at) VALUES($1,$2,'delivered',825000,770000,now()) RETURNING id`, [app, D2])).rows[0].id;
    await db.query(`INSERT INTO draw_finding_lines(finding_id,sitewire_request_id,sitewire_job_item_id,sow_line_key,name,requested_cents,approved_cents,not_approved_cents,photo_count,video_count) VALUES($1,$2,$3,'cat:roof','Roof',825000,770000,55000,3,0)`, [f2, R2, JI(1)]);
    // D3 — the inspector answered $0 (a legacy findings-0 sitting on a NULL mirror)
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES($1,$2,3,'pending_capital_partner',300000,0)`, [app, D3]);
    await db.query(`INSERT INTO sitewire_draw_requests(sitewire_draw_id,sitewire_request_id,sitewire_job_item_id,job_item_name,requested_cents,approved_cents) VALUES($1,$2,$3,'Paint',300000,NULL)`, [D3, R3, OTHER_JI]);
    const f3 = (await db.query(`INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at) VALUES($1,$2,'delivered',300000,0,now()) RETURNING id`, [app, D3])).rows[0].id;
    await db.query(`INSERT INTO draw_finding_lines(finding_id,sitewire_request_id,sitewire_job_item_id,sow_line_key,name,requested_cents,approved_cents,not_approved_cents,photo_count,video_count) VALUES($1,$2,$3,'cat:rest','Paint',300000,0,0,1,0)`, [f3, R3, OTHER_JI]);

    const list = await bsd.loadDrawList(db, app);
    const byId = (id) => list.find((x) => Number(x.sitewire_draw_id) === id);
    eq('6a a mirror-lag draw reads the inspector\'s findings figure, not $0', Number(byId(D2).inspector_approved_cents), 770000);
    eq('6b a legacy findings-0 reads $0 (an answered denial, matching the headline)', Number(byId(D3).inspector_approved_cents), 0);
    eq('6c a draw carrying a real request mirror still uses the mirror sum', Number(byId(DRAW).inspector_approved_cents), 2500000);
    // and the list column agrees with the rollup / drawMoney per-draw approved figure
    const roll2 = await rollupMod.loadRollup(db, app);
    const rd2 = roll2.draws.find((x) => x.sitewire_draw_id === D2);
    eq('6d the list column equals the rollup/drawMoney per-draw approved figure', Number(byId(D2).inspector_approved_cents), Number(rd2.approved_cents));
    // 6e a RETIRED finding line is excluded from BOTH the list column and the rollup (same as
    //    loadRollup's `retired_at IS NULL`), so the two never diverge on a soft-retired line.
    await db.query(`UPDATE draw_finding_lines SET retired_at=now() WHERE finding_id=$1`, [f2]);
    const listR = await bsd.loadDrawList(db, app);
    const rollR = await rollupMod.loadRollup(db, app);
    const rd2R = rollR.draws.find((x) => x.sitewire_draw_id === D2);
    eq('6e a retired finding line drops out of the list column (mirror still NULL -> falls to total $0)',
      Number(listR.find((x) => Number(x.sitewire_draw_id) === D2).inspector_approved_cents), 0);
    eq('6e2 …and the list column still equals the rollup after retirement', Number(rd2R.approved_cents), 0);
  }

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} draw-packet / rollup / heal assertions ${fail === 0 ? 'passed' : ''}`);
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', e); process.exit(1); });

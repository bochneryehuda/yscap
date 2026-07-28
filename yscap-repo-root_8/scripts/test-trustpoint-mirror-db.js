/* TrustPoint mirror + discovery (phase 2, DB-gated; the TrustPoint client is STUBBED —
 * no network). Covers: webhook inbox dedupe + drain → mirror row + reactions (staff
 * notice, borrower single-voice milestone), go-forward baseline silence, discovery
 * sweep auto-link (tier 1) + milestone crosswalk, unlinked-event parking, and
 * borrower-safety (the borrower email never names TrustPoint / the note buyer).
 * Run: DATABASE_URL=... node scripts/test-trustpoint-mirror-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-trustpoint-mirror-db (no DATABASE_URL)'); process.exit(0); }

const crypto = require('crypto');
const db = require('../src/db');
const client = require('../src/trustpoint/client');
const mirror = require('../src/trustpoint/mirror');
const discovery = require('../src/trustpoint/discovery');
const borrowerSafe = require('../src/lib/borrower-safe');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const tag = crypto.randomBytes(4).toString('hex');

// ---- client stubs (no network, switch forced on) ----
client.available = () => true;
client.enabled = () => true;
const stub = {
  projects: [], projectDetail: {}, draws: {}, drawDetail: {}, milestones: {}, serviceOrders: [],
};
client.listProjects = async () => stub.projects;
client.getProject = async (pk) => stub.projectDetail[pk] || { id: pk };
client.listProjectDraws = async (pk) => stub.draws[pk] || [];
client.getDraw = async (pk, dpk) => stub.drawDetail[`${pk}:${dpk}`] || null;
client.getDrawReport = async () => null;   // report archive path exercised as no_report
client.listMilestones = async (pk) => stub.milestones[pk] || [];
client.listServiceOrders = async () => stub.serviceOrders;
// The draw-comment mirror now runs on EVERY pass of a live draw (it used to fire only at
// approval, which meant a draw stuck in review — the one whose messages matter — was never
// synced). Stub the generic call so this suite exercises the mirror, not the conversation.
client.call = async () => ({ results: [] });

async function seedFile() {
  const email = 'tm' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('T','M',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'TM' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const lo = (await db.query(
    `INSERT INTO staff_users(email, full_name, role, is_active) VALUES ($1,'TM Officer','loan_officer',true) RETURNING id`,
    ['tmlo' + crypto.randomBytes(5).toString('hex') + '@example.com'])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,rehab_budget,property_address,loan_officer_id)
     VALUES($1,'funded',$2,'Blue Lake',100000,'{"oneLine":"44 Cedar Street, Testville, NY 10001","zip":"10001"}'::jsonb,$3) RETURNING id`,
    [bor, loan, lo])).rows[0].id;
  return { app, bor, loan, email, lo };
}
const cleanup = async (app, bor, lo) => {
  await db.query(`DELETE FROM trustpoint_project_links WHERE application_id=$1 OR (application_id IS NULL AND tp_project_id LIKE '%' || $2)`, [app, tag]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  if (lo) { await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [lo]).catch(() => {}); await db.query(`DELETE FROM staff_users WHERE id=$1`, [lo]); }
};
const notesFor = async (app, kind) => (await db.query(
  `SELECT * FROM notifications WHERE application_id=$1 AND recipient_kind=$2 ORDER BY created_at`, [app, kind])).rows;

(async () => {
  // trustpoint rule so candidateFiles() sees Blue Lake files (unique per test run is fine — upsert)
  await db.query(
    `INSERT INTO sitewire_inspection_rules (partner_label, inspection_method, fee_cents_virtual, fee_cents_physical, allow_virtual, allow_physical, draw_platform)
     VALUES ('Blue Lake','traditional',29900,25000,false,true,'trustpoint')
     ON CONFLICT (regexp_replace(lower(COALESCE(partner_label,'')), '[^a-z0-9]+', '', 'g'), COALESCE(program,''))
     DO UPDATE SET draw_platform='trustpoint', inspection_method='traditional'`);

  // ============ 1. discovery sweep: tier-1 auto-link + milestone crosswalk ============
  {
    const { app, bor, loan, lo } = await seedFile();
    const tpId = `tp-proj-${tag}`;
    stub.projects = [{ id: tpId, name: `${loan} — 44 Cedar` }];
    stub.projectDetail[tpId] = { id: tpId, name: `${loan} — 44 Cedar`, status: 'ACTIVE',
      loan: { external_id: loan, budget_commitment: 1000.0 },
      address: { address: '44 Cedar Street, Testville, NY 10001', zip_code: '10001' }, companies: [] };
    // the file's Sitewire per-line ledger (crosswalk target)
    await db.query(
      `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sitewire_job_item_id, sow_line_key, section_token, name, budgeted_cents, is_media_item)
       VALUES ($1,1,9101,'k1','kitchen','Unit 1 - Kitchen',60000,false), ($1,1,9102,'k2','roof','Unit 1 - Roof',40000,false)`, [app]);
    stub.milestones[tpId] = [
      { id: 'm1', name: 'Unit 1 - Kitchen', original_estimate_amount: 600.0 },
      { id: 'm2', name: 'Roof Redo', original_estimate_amount: 400.0 },   // renamed → unique-amount fallback
    ];
    const r = await discovery.sweep();
    ok('sweep discovered + auto-linked', r.autoLinked === 1);
    const link = (await db.query(`SELECT * FROM trustpoint_project_links WHERE tp_project_id=$1`, [tpId])).rows[0];
    ok('link row bound by loan_number', link && link.application_id === app && link.matched_by === 'loan_number');
    const ml = (await db.query(`SELECT * FROM trustpoint_milestone_links WHERE application_id=$1 ORDER BY tp_milestone_id`, [app])).rows;
    ok('milestone crosswalk built (name + amount-fallback)', ml.length === 2 && Number(ml[0].sitewire_job_item_id) === 9101 && Number(ml[1].sitewire_job_item_id) === 9102);
    ok('staff linked notice (in-app)', (await notesFor(app, 'staff')).some((n) => /linked/i.test(n.title)));
    await cleanup(app, bor, lo);
    stub.projects = [];
  }

  // ============ 2. webhook inbox: dedupe + drain → mirror + reactions ============
  {
    const { app, bor, loan, lo } = await seedFile();
    const tpId = `tp-proj2-${tag}`, drawId = `tp-draw-${tag}`;
    await discovery.linkProject(tpId, app, { matchedBy: 'manual', baselineHydrate: false });
    stub.drawDetail[`${tpId}:${drawId}`] = {
      id: drawId, number: 1, status: 'IN_REVIEW', type: 'DRAW_REQUEST',
      requested_amount: 800.0, approved_amount: null, submitted_at: new Date().toISOString(),
    };
    const payload = { project_id: tpId, draw_id: drawId, loan_id: loan, amount_requested: '800.00' };
    const hash = crypto.createHash('sha256').update('DRAW_REQUEST_SUBMITTED|' + JSON.stringify(payload)).digest('hex');
    const ins = `INSERT INTO trustpoint_webhook_events (event, tp_project_id, tp_draw_id, loan_id, payload, payload_hash)
                 VALUES ('DRAW_REQUEST_SUBMITTED',$1,$2,$3,$4::jsonb,$5) ON CONFLICT (event, payload_hash) DO NOTHING`;
    await db.query(ins, [tpId, drawId, loan, JSON.stringify(payload), hash]);
    await db.query(ins, [tpId, drawId, loan, JSON.stringify(payload), hash]);   // retry delivery
    const inbox = (await db.query(`SELECT count(*)::int c FROM trustpoint_webhook_events WHERE tp_draw_id=$1`, [drawId])).rows[0].c;
    ok('inbox dedupes retried deliveries', inbox === 1);

    const d1 = await mirror.drainInbox();
    ok('drain processed the event', d1.ok >= 1);
    const row = (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [drawId])).rows[0];
    ok('mirror row upserted (cents from dollars)', row && row.application_id === app && Number(row.requested_cents) === 80000 && row.status === 'IN_REVIEW');
    ok('watermark claimed', row.status_synced === 'IN_REVIEW');
    ok('staff in-review notice written', (await notesFor(app, 'staff')).some((n) => /in review/i.test(n.title)));
    ok('no borrower email on submit-mirror', (await notesFor(app, 'borrower')).length === 0);

    // ---- approval flows through: staff + borrower single-voice, scrubbed ----
    stub.drawDetail[`${tpId}:${drawId}`] = {
      id: drawId, number: 1, status: 'APPROVED', type: 'DRAW_REQUEST',
      requested_amount: 800.0, approved_amount: 750.0, amount_to_disburse: 747.5,
      approved_at: new Date().toISOString(),
      retainage_release_requested: false, contingency_total: 50.0,
    };
    const p2 = { project_id: tpId, draw_id: drawId, loan_id: loan, amount_approved: '750.00', amount_to_disburse: '747.50' };
    await db.query(ins.replace('DRAW_REQUEST_SUBMITTED', 'DRAW_REQUEST_FINALIZED'),
      [tpId, drawId, loan, JSON.stringify(p2), crypto.createHash('sha256').update('DRAW_REQUEST_FINALIZED|' + JSON.stringify(p2)).digest('hex')]);
    await mirror.drainInbox();
    const row2 = (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [drawId])).rows[0];
    ok('approved amounts mirrored', Number(row2.approved_cents) === 75000 && Number(row2.to_disburse_cents) === 74750 && row2.status_synced === 'APPROVED');
    const bNotes = await notesFor(app, 'borrower');
    ok('borrower approval milestone sent (single voice)', bNotes.length === 1 && /approved/i.test(bNotes[0].title));
    ok('borrower copy names no platform/partner', !borrowerSafe.hasPartnerName(bNotes[0].body) && !/trustpoint/i.test(bNotes[0].body));
    ok('audit trail written', Number((await db.query(
      `SELECT count(*)::int c FROM trustpoint_pull_field_change WHERE tp_draw_id=$1 AND reacted`, [drawId])).rows[0].c) >= 2);

    // re-drain: watermark blocks double-notification
    await db.query(ins.replace('DRAW_REQUEST_SUBMITTED', 'DRAW_REQUEST_FINALIZED'),
      [tpId, drawId, loan, JSON.stringify({ ...p2, echo: 1 }), crypto.createHash('sha256').update('x' + Math.random()).digest('hex')]);
    await mirror.drainInbox();
    ok('no duplicate borrower email on echo', (await notesFor(app, 'borrower')).length === 1);
    await cleanup(app, bor, lo);
  }

  // ============ 3. unlinked-project event parks for the desk ============
  {
    const tpId = `tp-unknown-${tag}`;
    const r = await mirror.processEvent({ event: 'DRAW_REQUEST_SUBMITTED', tp_project_id: tpId, payload: { project_id: tpId, draw_id: 'd9', loan_id: 'LN-X' } });
    ok('unlinked event skipped + noted', r.skipped === 'unlinked_project');
    const row = (await db.query(`SELECT * FROM trustpoint_project_links WHERE tp_project_id=$1`, [tpId])).rows[0];
    ok('unknown project seeded on the desk', row && row.application_id === null && row.loan_external_id === 'LN-X');
    await db.query(`DELETE FROM trustpoint_project_links WHERE tp_project_id=$1`, [tpId]);
  }

  // ============ 4. baseline hydrate stays silent (go-forward) ============
  {
    const { app, bor, lo } = await seedFile();
    const tpId = `tp-proj4-${tag}`, drawId = `tp-draw4-${tag}`;
    stub.draws[tpId] = [{ id: drawId, number: 1, status: 'APPROVED' }];
    stub.drawDetail[`${tpId}:${drawId}`] = { id: drawId, number: 1, status: 'APPROVED', requested_amount: 100.0, approved_amount: 100.0 };
    await discovery.linkProject(tpId, app, { matchedBy: 'manual', baselineHydrate: true });
    ok('baseline mirrored the historical draw', (await db.query(`SELECT count(*)::int c FROM trustpoint_draws WHERE application_id=$1`, [app])).rows[0].c === 1);
    ok('baseline sent NO borrower email', (await notesFor(app, 'borrower')).length === 0);
    ok('baseline audited as baseline', (await db.query(
      `SELECT count(*)::int c FROM trustpoint_pull_field_change WHERE tp_draw_id=$1 AND field='baseline'`, [drawId])).rows[0].c === 1);
    await cleanup(app, bor, lo);
  }

  // ============ 5. THE DEPLOY ITSELF MUST NOT RE-ANNOUNCE FINISHED INSPECTIONS ============
  // db/363. The `status_synced` watermark on trustpoint_service_orders existed since db/297 but
  // was read and never written, so every row in a live database carries NULL. Without the
  // baseline, the very deploy that fixes the duplicate inspection notices would win the claim on
  // the entire back book and announce every historic inspection at once. The one-shot design is
  // what makes it safe: a completion that lands moments before a restart must still announce.
  {
    const { app, bor, lo } = await seedFile();
    const soDone = `tp-so5a-${tag}`, soLive = `tp-so5b-${tag}`;
    await db.query(
      `INSERT INTO trustpoint_service_orders (tp_service_order_id, application_id, tp_project_id, service_type, status, status_synced)
       VALUES ($1,$3,'tp-proj5','INSPECTION','COMPLETED',NULL), ($2,$3,'tp-proj5','INSPECTION','ORDERED',NULL)`,
      [soDone, soLive, app]);
    // Replay the CUTOVER. db/363 is one-shot, so on any database that has already booted once
    // the marker is set and the statement is correctly a no-op — clearing it is what lets this
    // test reproduce the single deploy that matters. (Dropping this line makes the test pass on
    // a virgin database and fail on every run after, which is how the one-shot proved itself.)
    await db.query(`DELETE FROM sync_runtime_state WHERE key='trustpoint_service_order_baseline'`);

    await require('../src/migrate-boot').ensureSchema();   // the deploy

    const wm = async (id) => (await db.query(
      `SELECT status_synced FROM trustpoint_service_orders WHERE tp_service_order_id=$1`, [id])).rows[0].status_synced;
    ok('a finished inspection is baselined by the deploy', await wm(soDone) === 'COMPLETED');
    ok('an inspection still running is untouched', await wm(soLive) === null);

    // …and the backlog is stamped ONCE. A version that re-ran on every boot would swallow a real
    // announcement: an inspection completing seconds before a restart is COMPLETED but unclaimed.
    await db.query(`UPDATE trustpoint_service_orders SET status='COMPLETED' WHERE tp_service_order_id=$1`, [soLive]);
    await require('../src/migrate-boot').ensureSchema();   // a restart before the poll claims it
    ok('a fresh completion survives a restart and can still announce', await wm(soLive) === null);

    await db.query(`DELETE FROM trustpoint_service_orders WHERE tp_service_order_id = ANY($1)`, [[soDone, soLive]]);
    await cleanup(app, bor, lo);
  }

  // ============ 6. AN ARCHIVE THAT NEVER LANDED IS RETRIED — but not forever ============
  // archiveDrawEverything fires once, on the APPROVED transition, and TrustPoint's document
  // links expire in about a day: one blip at that moment lost the inspection report and its
  // photographs permanently. The retry reads "incomplete" from the DATA (no archived document)
  // so nothing has to be migrated, and it is bounded by the draw's own age so it can never
  // loop on an old draw forever.
  {
    const { app, bor, lo } = await seedFile();
    const docs = require('../src/trustpoint/documents');
    // DISTINCT NUMBERS, not distinct ids: storeDocument names the file after the draw NUMBER
    // (`trustpoint-draw-2-…`), so three draws sharing a number would share their paperwork.
    const mk = async (id, number, approvedAt) => db.query(
      `INSERT INTO trustpoint_draws (tp_draw_id, application_id, tp_project_id, number, status, approved_at, tp_created_at)
       VALUES ($1,$2,'tp-proj6',$3,'APPROVED',$4,$4)`, [id, app, number, approvedAt]);

    const fresh = `tp-draw6a-${tag}`, old = `tp-draw6b-${tag}`, done = `tp-draw6c-${tag}`;
    await mk(fresh, 1, new Date().toISOString());
    await mk(old, 2, new Date(Date.now() - 9 * 86400000).toISOString());
    await mk(done, 3, new Date().toISOString());

    await db.query(`DELETE FROM sync_runtime_state WHERE key LIKE 'tp_archive_retry:%'`);

    // a recent APPROVED draw with nothing archived → really attempts the pull
    const a = await docs.archiveDrawIfIncomplete(fresh);
    ok('a recent draw with nothing archived is retried', a && a.ok === true);
    // …but the 5-minute poll must not re-list it 860 times across the window
    ok('a second pass minutes later backs off',
      (await docs.archiveDrawIfIncomplete(fresh)).skipped === 'backoff');
    // …and the back-off releases on its own an hour later
    await db.query(
      `UPDATE sync_runtime_state SET updated_at = now() - interval '2 hours' WHERE key=$1`,
      [`tp_archive_retry:${fresh}`]);
    ok('the back-off releases after an hour', (await docs.archiveDrawIfIncomplete(fresh)).ok === true);

    // a draw that has not been approved has no paperwork to pull — never retried
    const early = `tp-draw6d-${tag}`;
    await db.query(
      `INSERT INTO trustpoint_draws (tp_draw_id, application_id, tp_project_id, number, status, tp_created_at)
       VALUES ($1,$2,'tp-proj6',4,'IN_REVIEW',now())`, [early, app]);
    ok('a draw still in review is never retried',
      (await docs.archiveDrawIfIncomplete(early)).skipped === 'not_ready');
    await db.query(`DELETE FROM trustpoint_draws WHERE tp_draw_id=$1`, [early]);

    // …a draw whose paperwork already landed → never re-pulled
    await db.query(
      `INSERT INTO documents (application_id, filename, doc_kind, storage_provider, storage_ref,
                              content_type, size_bytes, visibility, source_type, is_current)
       VALUES ($1, 'trustpoint-draw-3-inspection-result-document-2026-07-27-abc.pdf',
               'draw_inspection_report','local','ref/x','application/pdf',10,'staff_only','system',true)`,
      [app]);
    ok('a draw that already has its paperwork is left alone',
      (await docs.archiveDrawIfIncomplete(done)).skipped === 'archived');
    // …and that document belongs to draw 3 ONLY — the anchored match must not leak to its
    // neighbours, which is exactly what the old id-prefix predicate did.
    ok('one draw\'s paperwork is not credited to another',
      (await docs.documentsFor(app, fresh, 1)).length === 0);
    ok('the archived document IS found for its own draw',
      (await docs.documentsFor(app, done, 3)).length === 1);

    // …and a draw old enough that the links are dead stops being retried at all
    ok('an old draw stops being retried (the links are gone)',
      (await docs.archiveDrawIfIncomplete(old)).skipped === 'too_old');

    await db.query(`DELETE FROM sync_runtime_state WHERE key LIKE 'tp_archive_retry:%'`);
    await db.query(`DELETE FROM documents WHERE application_id=$1`, [app]);
    await db.query(`DELETE FROM trustpoint_draws WHERE tp_draw_id = ANY($1)`, [[fresh, old, done]]);
    await cleanup(app, bor, lo);
  }

  console.log(`test-trustpoint-mirror-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-trustpoint-mirror-db crashed:', e); process.exit(1); });

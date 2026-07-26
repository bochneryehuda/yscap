'use strict';
/**
 * The DRAW email center folds in the DocuSign draw-request form lifecycle + Sitewire's OWN activity
 * events (which Sitewire exposes as events, never the emails it sends). This verifies
 * assembleDrawEventRows builds correctly-shaped, correctly-labeled rows from both sources. DB-gated.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-email-history (no DATABASE_URL)'); process.exit(0); }
const db = require('../src/db');
const { assembleDrawEventRows } = require('../src/routes/staff');
let P = 0, F = 0;
const R = Math.floor(Math.random() * 900000) + 100000;
const DRAW = 6600000 + R;
function ok(c, m) { c ? (P++, console.log('  ok -', m)) : (F++, console.log('  FAIL -', m)); }

(async () => {
  let appId, borrowerId, envId;
  try {
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Moe','Spitzer',$1) RETURNING id`, [`moe${R}@e.com`])).rows[0].id;
    appId = (await db.query(`INSERT INTO applications (borrower_id,status,property_address) VALUES ($1,'funded','{"oneLine":"109 Chapel St"}') RETURNING id`, [borrowerId])).rows[0].id;

    // (1) Sitewire draw with its OWN activity events (the array Sitewire returns).
    await db.query(
      `INSERT INTO sitewire_draws (application_id,sitewire_draw_id,sitewire_property_id,number,status,events)
       VALUES ($1,$2,777,2,'approved',$3::jsonb)`,
      [appId, DRAW, JSON.stringify([
        { event: 'submit', actor_role: 'borrower_owner', occurred_at: '2026-07-10T14:00:00Z' },
        { event: 'inspector_assigned', actor_role: 'sitewire_inspector', occurred_at: '2026-07-12T09:00:00Z' },
        { event: 'inspector_approve', actor_role: 'sitewire_inspector', occurred_at: '2026-07-14T16:00:00Z' },
      ])]);

    // (2) DocuSign draw-request envelope + a borrower recipient.
    envId = (await db.query(
      `INSERT INTO esign_envelopes (application_id,purpose,status,sent_at,completed_at)
       VALUES ($1,'draw_request','completed','2026-07-15T10:00:00Z','2026-07-16T11:00:00Z') RETURNING id`, [appId])).rows[0].id;
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id,role,routing_order,recipient_id_ds,borrower_id,name,email,status)
       VALUES ($1,'borrower',1,'1',$2,'Moe Spitzer',$3,'completed')`, [envId, borrowerId, `moe${R}@e.com`]);

    const rows = await assembleDrawEventRows(appId);

    // Sitewire events
    const sw = rows.filter((r) => r.source === 'sitewire');
    ok(sw.length === 3, 'all 3 Sitewire activity events are surfaced');
    ok(sw.every((r) => r.kind === 'event' && r.from_name === 'Sitewire'), 'Sitewire rows are events labeled "Sitewire"');
    ok(sw.some((r) => /inspection was completed/i.test(r.subject)), 'the inspector-approve event reads "inspection was completed"');
    ok(sw.some((r) => /an inspector was assigned/i.test(r.subject)), 'the inspector-assigned event is labeled');
    ok(sw.every((r) => r.has_body === false && r.body && /Sitewire/.test(r.body)), 'Sitewire rows carry an inline body, never fetch an email');

    // DocuSign lifecycle
    const ds = rows.filter((r) => r.source === 'docusign');
    ok(ds.some((r) => /sent for signature/i.test(r.subject)), 'DocuSign "sent for signature" row present');
    ok(ds.some((r) => /signed the draw request/i.test(r.subject)), 'DocuSign "signed" row present');
    ok(ds.every((r) => r.from_name === 'DocuSign' && r.kind === 'event'), 'DocuSign rows are events labeled "DocuSign"');
    ok(ds.some((r) => r.recipient_name === 'Moe Spitzer'), 'DocuSign rows name the borrower recipient');

    // Shape: every row has a usable occurred_at + unique id + thread_key
    ok(rows.every((r) => r.occurred_at && r.id && r.thread_key === r.id), 'every row has occurred_at + a unique id/thread_key');
    ok(new Set(rows.map((r) => r.id)).size === rows.length, 'row ids are unique (no collisions)');

    console.log(`\n${P} passed, ${F} failed`);
  } catch (e) { console.error('THREW', e && e.message, e && e.stack); F++; }
  finally {
    try {
      if (appId) {
        for (const t of ['esign_recipients']) await db.query(`DELETE FROM ${t} WHERE envelope_row_id=$1`, [envId]).catch(() => {});
        for (const t of ['esign_envelopes', 'sitewire_draws']) await db.query(`DELETE FROM ${t} WHERE application_id=$1`, [appId]);
        await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      }
      if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
    } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    if (F) process.exit(1);
  }
})();

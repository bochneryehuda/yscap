'use strict';
/**
 * Bidirectional Phase 3 — a PILOT-side edit to a managed file's re-pushable property fields (or the
 * borrower's email) ENQUEUES a guarded Sitewire re-push (op='push_file'). Unmanaged files never
 * enqueue; a non-triggering field never enqueues; repeated edits COALESCE. DB-gated skip.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sitewire-repush-on-edit (no DATABASE_URL)'); process.exit(0); }
const db = require('../src/db');
let P = 0, F = 0;
const R = Math.floor(Math.random() * 900000) + 100000;
function ok(c, m) { c ? (P++, console.log('  ok -', m)) : (F++, console.log('  FAIL -', m)); }
async function queued(appId) { return (await db.query(`SELECT count(*)::int c FROM sync_queue WHERE entity_type='application' AND entity_id=$1 AND target='sitewire' AND op='push_file' AND status='queued'`, [appId])).rows[0].c; }

(async () => {
  const ids = [];
  try {
    // MANAGED file
    const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Re','Push',$1) RETURNING id`, [`rp${R}@e.com`])).rows[0];
    const a = (await db.query(`INSERT INTO applications (borrower_id,status,property_address,units,property_type) VALUES ($1,'funded','{"oneLine":"1 A St"}',2,'sfr') RETURNING id`, [b.id])).rows[0]; ids.push(a.id);
    await db.query(`INSERT INTO sitewire_property_links (application_id,sitewire_property_id,matched_by,pushed_at) VALUES ($1,$2,'created',now())`, [a.id, 9000000 + R]);
    // UNMANAGED file
    const b2 = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('No','Link',$1) RETURNING id`, [`nl${R}@e.com`])).rows[0];
    const a2 = (await db.query(`INSERT INTO applications (borrower_id,status,property_address) VALUES ($1,'funded','{"oneLine":"2 B St"}') RETURNING id`, [b2.id])).rows[0]; ids.push(a2.id);

    ok((await queued(a.id)) === 0, 'no push queued initially');

    // address change on the MANAGED file → enqueue
    await db.query(`UPDATE applications SET property_address='{"oneLine":"1 A St, Apt 5"}' WHERE id=$1`, [a.id]);
    ok((await queued(a.id)) === 1, 'address edit on managed file → push queued');

    // a second re-pushable change COALESCES (still 1)
    await db.query(`UPDATE applications SET units=3 WHERE id=$1`, [a.id]);
    ok((await queued(a.id)) === 1, 'second edit coalesces (still one queued push)');

    // drain it, then a new edit enqueues again
    await db.query(`UPDATE sync_queue SET status='done' WHERE entity_type='application' AND entity_id=$1 AND op='push_file'`, [a.id]);
    await db.query(`UPDATE applications SET property_type='condo' WHERE id=$1`, [a.id]);
    ok((await queued(a.id)) === 1, 'after drain, a new edit enqueues a fresh push');

    // a NON-triggering field change does NOT enqueue
    await db.query(`UPDATE sync_queue SET status='done' WHERE entity_type='application' AND entity_id=$1 AND op='push_file'`, [a.id]);
    await db.query(`UPDATE applications SET status='funded', updated_at=now() WHERE id=$1`, [a.id]);
    ok((await queued(a.id)) === 0, 'a non-property field change does not enqueue');

    // borrower email change → enqueue for the managed file
    await db.query(`UPDATE borrowers SET email=$2 WHERE id=$1`, [b.id, `rp${R}b@e.com`]);
    ok((await queued(a.id)) === 1, 'borrower email change → push queued (re-assign)');

    // UNMANAGED file: an address change enqueues NOTHING
    await db.query(`UPDATE applications SET property_address='{"oneLine":"2 B St, Unit 9"}' WHERE id=$1`, [a2.id]);
    ok((await queued(a2.id)) === 0, 'unmanaged file: property edit does NOT enqueue');

    console.log(`\n${P} passed, ${F} failed`);
  } catch (e) { console.error('THREW', e && e.message, e && e.stack); F++; }
  finally {
    try { for (const id of ids) { await db.query(`DELETE FROM sync_queue WHERE entity_id=$1`, [id]); await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [id]); const bb = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [id])).rows[0]; await db.query(`DELETE FROM applications WHERE id=$1`, [id]); if (bb) await db.query(`DELETE FROM borrowers WHERE id=$1`, [bb.borrower_id]); } } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    if (F) process.exit(1);
  }
})();

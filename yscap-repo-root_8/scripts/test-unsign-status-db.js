'use strict';
/**
 * UNDOING A SIGN-OFF PUTS THE CONDITION BACK ON THE LIST (owner-reported
 * 2026-08-28: "If you undo the sign-off on a certain condition and then you sort
 * by conditions that are still outstanding, the sign-off is not coming back up.
 * Once it was signed off once, the filtering option doesn't understand that it
 * was pulled back … This is very important.").
 *
 * ROOT CAUSE: sign-off forces status='satisfied'; the undo branch cleared only
 * the STAMPS (signed_off_at etc.) and left the status — so every filter that
 * asks "is this still open?" (awaiting / in-review / not-signed-off, staff and
 * borrower alike) read the pulled-back condition as done forever, and it still
 * showed under "Signed off".
 *
 * THE FIX, pinned here over the REAL PATCH route: undoing a sign-off restores
 * the status FROM REALITY —
 *   · a current document (or submitted tool answer) on the item → 'received'
 *     (it is back with the team awaiting the re-decision);
 *   · nothing behind it → 'outstanding';
 *   · a row somebody already moved to 'issue' keeps 'issue' (the guard).
 * Un-waive keeps its existing 'outstanding' reset; "undo done" (reviewed=false)
 * keeps the status untouched, exactly as before.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-unsign-status-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

const db = require('../src/db');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `uns-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const superAdmin = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Super Sam','super_admin',true) RETURNING id`,
    [`${uniq}-sa@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Un','Sign',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, status, property_address, loan_type)
     VALUES ($1,'underwriting','{"oneLine":"5 Undo Way"}','Purchase') RETURNING id`, [borrower])).rows[0].id;
  const mkItem = async (label, extra = '') => (await db.query(
    `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,is_required,status${extra ? ',' + extra : ''})
     VALUES ('application',$1,$2,$2,'borrower','document',true,'outstanding'${extra ? `,${extra === 'tool_payload' ? `'{"v":1}'::jsonb` : 'now()'}` : ''}) RETURNING id`,
    [appId, label])).rows[0].id;

  const jwt = signJwt({ sub: superAdmin, kind: 'staff', role: 'super_admin', tv: 0, sid: 'test' });
  const patch = async (itemId, body) => {
    const r = await fetch(`${base}/api/staff/checklist/${itemId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
    return { status: r.status, body: j };
  };
  const stateOf = async (id) => (await db.query(
    `SELECT status, signed_off_at, waived_at, reviewed_at FROM checklist_items WHERE id=$1`, [id])).rows[0];

  // The signOffGate refuses an unfulfilled condition even for a super-admin —
  // the RECORDED way through is the explicit admin override, which is also the
  // realistic path to the exact bug (sign something off, realize, pull it back).
  const signOff = (id) => patch(id, { signedOff: true, adminOverride: true, overrideReason: 'test: recorded override' });

  // ── 1. no documents: satisfied → (undo) → OUTSTANDING ─────────────────────
  {
    const item = await mkItem('Bare condition');
    const so = await signOff(item);
    ok(so.status === 200, 'sign-off (with the recorded override) lands');
    ok((await stateOf(item)).status === 'satisfied', 'sign-off forces satisfied');
    const un = await patch(item, { signedOff: false });
    ok(un.status === 200, 'the undo lands');
    const st = await stateOf(item);
    ok(st.signed_off_at === null, 'the stamp is cleared');
    ok(st.status === 'outstanding', 'THE FIX: with nothing behind it, the condition is OUTSTANDING again — back on every open filter');
  }

  // ── 2. a current document on file: satisfied → (undo) → RECEIVED ──────────
  {
    const item = await mkItem('Documented condition');
    await db.query(
      `INSERT INTO documents (checklist_item_id, application_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, review_status, is_current)
       VALUES ($1,$2,$3,'doc.pdf','application/pdf',10,'db','x','borrower',$3,'accepted',true)`,
      [item, appId, borrower]);
    await signOff(item);
    await patch(item, { signedOff: false });
    const st = await stateOf(item);
    ok(st.status === 'received', 'with its document still on file, the pulled-back condition reads RECEIVED (awaiting the re-decision)');
    ok(st.signed_off_at === null, '…with the stamp cleared');
  }

  // ── 3. a submitted tool answer counts the same way ────────────────────────
  {
    const item = await mkItem('Answered tool condition');
    await db.query(`UPDATE checklist_items SET tool_payload='{"value":42}'::jsonb WHERE id=$1`, [item]);
    await signOff(item);
    await patch(item, { signedOff: false });
    ok((await stateOf(item)).status === 'received', 'a submitted tool answer also restores to RECEIVED');
  }

  // ── 4. the guard: an 'issue' row with a stray stamp keeps 'issue' ─────────
  {
    const item = await mkItem('Pushed-back condition');
    await db.query(`UPDATE checklist_items SET status='issue', signed_off_at=now() WHERE id=$1`, [item]);
    await patch(item, { signedOff: false });
    ok((await stateOf(item)).status === 'issue', 'a row already pushed back to ISSUE keeps issue — the recompute never clobbers a decided state');
  }

  // ── 5. un-waive keeps its existing reset ──────────────────────────────────
  {
    const item = await mkItem('Waived condition');
    await db.query(`UPDATE checklist_items SET is_required=false WHERE id=$1`, [item]);
    const wv = await patch(item, { waived: true });
    ok(wv.status === 200 && (await stateOf(item)).status === 'satisfied', 'waive clears the optional condition');
    await patch(item, { waived: false });
    const st = await stateOf(item);
    ok(st.status === 'outstanding' && st.waived_at === null, 'un-waive puts it back to outstanding, exactly as before');
  }

  // ── 6. "undo done" keeps the status untouched (the reviewed stamp only) ───
  {
    const item = await mkItem('Done condition');
    await db.query(`UPDATE checklist_items SET status='received' WHERE id=$1`, [item]);
    await patch(item, { reviewed: true });
    ok(!!(await stateOf(item)).reviewed_at, 'Done stamps reviewed_at');
    await patch(item, { reviewed: false });
    const st = await stateOf(item);
    ok(st.reviewed_at === null && st.status === 'received', 'Undo done clears the stamp and leaves the status where it was');
  }

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll un-sign-off status checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });

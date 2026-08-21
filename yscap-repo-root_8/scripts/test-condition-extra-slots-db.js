#!/usr/bin/env node
'use strict';
/* EXTRA NAMED DOCUMENT SLOTS ON A CONDITION (db/578, owner-directed 2026-08-18:
 * "you got one document and you wanna request another document within that
 * condition … there should be a button for the staff members to open up another
 * slot in a condition and type the name of that slot"), against a real database
 * and the real HTTP routes:
 *
 *   A. the ATOMIC add: six simultaneous requests for one label open exactly ONE
 *      slot; a duplicate over HTTP answers 409; validation refuses junk.
 *   B. a new ask REOPENS a signed-off condition, with the [auto] note saying why;
 *      an external ask on an outstanding condition reads 'requested'.
 *   C. the SIGN-OFF GATE: the condition cannot be signed off while the requested
 *      document is missing (named in the refusal), still cannot while it is only
 *      PENDING (db/424 — nothing un-accepted satisfies), and signs off once the
 *      document under that label is ACCEPTED.
 *   D. the BORROWER sees exactly the external unfilled asks as still_needed —
 *      scrubbed (a capital-partner name in a slot label never reaches them),
 *      internal asks invisible, the raw extra_slots column never shipped, and
 *      the ask leaves the list the moment they upload (in review, not a nag).
 *   E. remove: a FILLED slot refuses (the document is a record); an unfilled one
 *      removes cleanly.
 *   F. the staff checklist GET merges the extras into row.slots (extra:true,
 *      'extra:'-prefixed key) so the whole per-slot UI inherits them.
 *   G. the TPR export ships the accepted slot document under the SAME category
 *      as the condition's other documents — one condition, one folder.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-condition-extra-slots-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const XS = require('../src/lib/conditions/extra-slots');
const app = require('../src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  let superId, borId, appId;
  try {
    superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Slot Super','super_admin',true,false,'x',0) RETURNING id`, [`xslot-super-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Extra','Slots',$1) RETURNING id`, [`xslot-bo-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [borId]);
    const bTok = C.signJwt({ sub: borId, kind: 'borrower', tv: 0 });
    appId = (await db.query(
      `INSERT INTO applications (borrower_id,loan_officer_id,status,loan_type,property_address)
       VALUES ($1,$2,'underwriting','Purchase','{"oneLine":"7 Slot Street"}') RETURNING id`, [borId, superId])).rows[0].id;
    const mkItem = async (label, audience) => (await db.query(
      `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,is_required,created_by_kind,created_by_id)
       VALUES ('application',$1,$2,$2,$3,'document',true,'staff',$4) RETURNING id`, [appId, label, audience, superId])).rows[0].id;
    const itemId = await mkItem('Entity documents', 'both');
    const addDoc = async (item, slot, status, filename) => (await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, borrower_id, filename, content_type,
                              size_bytes, storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id,
                              slot_label, review_status, reviewed_at)
       VALUES ($1,$2,$3,$4,'application/pdf',10,'local',$5,'borrower',$3,$6,$7,
               CASE WHEN $7='accepted' THEN now() ELSE NULL END) RETURNING id`,
      [appId, item, borId, filename, `xslot/${crypto.randomBytes(6).toString('hex')}`, slot, status])).rows[0].id;

    // ---- A. the atomic add ----------------------------------------------------------------
    const six = await Promise.all(Array.from({ length: 6 }, () =>
      XS.addSlot(appId, itemId, { label: 'Updated operating agreement', audience: 'external', actorId: superId, actorName: 'Slot Super' })));
    ok('A1 six simultaneous requests open exactly ONE slot',
      six.filter((r) => r.added).length === 1 && six.filter((r) => !r.added && r.reason === 'duplicate').length === 5);
    const stored = XS.normalize((await db.query(`SELECT extra_slots FROM checklist_items WHERE id=$1`, [itemId])).rows[0].extra_slots);
    ok('A2 the item carries exactly one slot after the race', stored.length === 1 && stored[0].label === 'Updated operating agreement' && stored[0].audience === 'external');
    const dup = await call(server, 'POST', `/api/staff/applications/${appId}/checklist/${itemId}/extra-slots`, tok, { label: 'updated operating agreement', audience: 'external' });
    ok('A3 a duplicate label (case-insensitive) answers 409 over HTTP', dup.status === 409);
    const bad1 = await call(server, 'POST', `/api/staff/applications/${appId}/checklist/${itemId}/extra-slots`, tok, { label: '', audience: 'external' });
    ok('A4 a nameless request is refused', bad1.status === 400);
    const bad2 = await call(server, 'POST', `/api/staff/applications/${appId}/checklist/${itemId}/extra-slots`, tok, { label: 'October bank statement', audience: 'everyone' });
    ok('A5 an unknown audience is refused', bad2.status === 400);
    const wrongItem = await call(server, 'POST', `/api/staff/applications/${appId}/checklist/${crypto.randomUUID()}/extra-slots`, tok, { label: 'X doc', audience: 'internal' });
    ok('A6 a wrong item id answers 404', wrongItem.status === 404);

    // The external ask on an OUTSTANDING condition reads 'requested'.
    const st1 = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [itemId])).rows[0];
    ok('B1 an external ask moves an outstanding condition to requested', st1.status === 'requested');

    // ---- B. reopen of a signed-off condition ----------------------------------------------
    // The condition carries EVERY completion stamp — sign-off, review, and a
    // db/344 override — so the reopen is proven to clear them ALL (audit
    // 078cb1a #2: a reopened condition is not "reviewed" and not "cleared by
    // override"; a later ordinary sign-off must never inherit a stale reason).
    const signedItem = await mkItem('Insurance package', 'both');
    await db.query(
      `UPDATE checklist_items
          SET status='satisfied', signed_off_by=$2, signed_off_at=now(),
              reviewed_by=$2, reviewed_at=now(),
              override_by=$2, override_at=now(), override_reason='test override', override_blocked_reason='was missing X'
        WHERE id=$1`, [signedItem, superId]);
    const re = await call(server, 'POST', `/api/staff/applications/${appId}/checklist/${signedItem}/extra-slots`, tok, { label: 'Wind rider', audience: 'external' });
    // The route's external-ask notification is awaited before it answers, so the
    // borrower's in-app row exists by now (through the notifyAppBorrowers
    // chokepoint — audit 078cb1a #3).
    const notif = (await db.query(
      `SELECT 1 FROM notifications WHERE borrower_id=$1 AND type='doc_requested' AND body LIKE '%Wind rider%' LIMIT 1`, [borId])).rows[0];
    ok('B2 the borrower is told about the external ask', !!notif);
    const reRow = (await db.query(`SELECT status, signed_off_at, waived_at, reviewed_at, override_at, override_reason, override_blocked_reason, notes FROM checklist_items WHERE id=$1`, [signedItem])).rows[0];
    ok('B3 a new ask REOPENS a signed-off condition', re.status === 201 && re.body.reopened === true
      && reRow.status === 'requested' && reRow.signed_off_at === null);
    ok('B3b the review AND override stamps clear with the reopen',
      reRow.reviewed_at === null && reRow.override_at === null && reRow.override_reason === null && reRow.override_blocked_reason === null);
    ok('B4 the [auto] note says exactly why', /\[auto\] Reopened — a new document was requested/.test(reRow.notes || '') && /Wind rider/.test(reRow.notes || ''));

    // ---- B5-B8. THE INTERNAL SLOT — a slot for a document WE have (owner-directed
    // 2026-08-21: "If you have a document that you want to put in a separate slot, I
    // don't use that request button … I just open a new document slot in this
    // condition"). The whole point is that it asks the BORROWER for nothing, so the
    // two things that must NOT happen are asserted against the external ask above as
    // a live control: that one DID move the status (B1) and DID notify (B2).
    const selfItem = await mkItem('Wire instructions', 'both');
    const notifBefore = Number((await db.query(
      `SELECT count(*) c FROM notifications WHERE borrower_id=$1`, [borId])).rows[0].c);
    const selfAdd = await call(server, 'POST', `/api/staff/applications/${appId}/checklist/${selfItem}/extra-slots`, tok,
      { label: 'Signed change order', audience: 'internal' });
    const selfRow = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [selfItem])).rows[0];
    ok('B5 an internal slot opens on a borrower-facing condition', selfAdd.status === 201 && selfAdd.body.slot.audience === 'internal');
    ok('B6 …and does NOT turn the condition into a request (B1 proves an external ask does)',
      selfRow.status === 'outstanding');
    const notifAfter = Number((await db.query(
      `SELECT count(*) c FROM notifications WHERE borrower_id=$1`, [borId])).rows[0].c);
    ok('B7 …and the borrower is told NOTHING (B2 proves an external ask tells them)',
      notifAfter === notifBefore);
    // A signed-off condition still reopens: our own team now owes a document on it,
    // and the sign-off predates that. This is about the SLOT, not about the audience.
    const selfSigned = await mkItem('Payoff package', 'staff');
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_by=$2, signed_off_at=now() WHERE id=$1`, [selfSigned, superId]);
    const selfRe = await call(server, 'POST', `/api/staff/applications/${appId}/checklist/${selfSigned}/extra-slots`, tok,
      { label: 'Recorded mortgage', audience: 'internal' });
    const selfReRow = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [selfSigned])).rows[0];
    ok('B8 an internal slot on a signed-off condition reopens it too',
      selfRe.status === 201 && selfRe.body.reopened === true && selfReRow.signed_off_at === null);

    // ---- C. the sign-off gate --------------------------------------------------------------
    let so = await call(server, 'PATCH', `/api/staff/checklist/${itemId}`, tok, { signedOff: true });
    ok('C1 sign-off refuses while the requested document is missing, naming it',
      so.status === 422 && /Updated operating agreement/.test((so.body && so.body.error) || ''));
    const pendingDoc = await addDoc(itemId, 'Updated operating agreement', 'pending', 'oa-v2.pdf');
    so = await call(server, 'PATCH', `/api/staff/checklist/${itemId}`, tok, { signedOff: true });
    ok('C2 a PENDING document still refuses (nothing un-accepted satisfies — db/424)', so.status === 422);
    await db.query(`UPDATE documents SET review_status='accepted', reviewed_at=now() WHERE id=$1`, [pendingDoc]);
    so = await call(server, 'PATCH', `/api/staff/checklist/${itemId}`, tok, { signedOff: true });
    ok('C3 an ACCEPTED document under the slot label signs off', so.status === 200);
    await db.query(`UPDATE checklist_items SET status='requested', signed_off_by=NULL, signed_off_at=NULL WHERE id=$1`, [itemId]);

    // The " (2)" duplicate suffix on a slot_label still counts as the slot's document.
    await db.query(`UPDATE documents SET slot_label='Updated operating agreement (2)' WHERE id=$1`, [pendingDoc]);
    so = await call(server, 'PATCH', `/api/staff/checklist/${itemId}`, tok, { signedOff: true });
    ok('C4 a duplicate-suffixed slot_label still fills the slot', so.status === 200);
    await db.query(`UPDATE checklist_items SET status='requested', signed_off_by=NULL, signed_off_at=NULL WHERE id=$1`, [itemId]);
    await db.query(`UPDATE documents SET slot_label='Updated operating agreement' WHERE id=$1`, [pendingDoc]);

    // ---- D. the borrower's still-needed view ----------------------------------------------
    // An internal ask, and an external one whose label names a capital partner.
    await XS.addSlot(appId, itemId, { label: 'Internal memo on vesting', audience: 'internal', actorId: superId });
    await XS.addSlot(appId, itemId, { label: 'BlueLake payoff statement', audience: 'external', actorId: superId });
    let bl = await call(server, 'GET', `/api/borrower/applications/${appId}/checklist`, bTok);
    const bItem = (bl.body || []).find((it) => String(it.id) === String(itemId));
    ok('D1 the borrower checklist answers for the condition', bl.status === 200 && !!bItem);
    const needed = (bItem && bItem.still_needed) || [];
    ok('D2 exactly the external UNFILLED asks surface (the filled OA does not, the internal never)',
      needed.length === 1 && !needed.some((s) => /operating agreement/i.test(s)) && !needed.some((s) => /internal memo/i.test(s)));
    ok('D3 a capital-partner name in a slot label is scrubbed before the borrower sees it',
      needed.length === 1 && !/bluelake|blue lake/i.test(needed[0]) && /payoff statement/i.test(needed[0]));
    ok('D4 the raw extra_slots column never ships to the borrower',
      bItem && !('extra_slots' in bItem));
    await addDoc(itemId, 'BlueLake payoff statement', 'pending', 'payoff.pdf');
    bl = await call(server, 'GET', `/api/borrower/applications/${appId}/checklist`, bTok);
    const bItem2 = (bl.body || []).find((it) => String(it.id) === String(itemId));
    ok('D5 uploading clears the still-needed ask (in review, not a nag)',
      ((bItem2 && bItem2.still_needed) || []).length === 0);

    // ---- E. remove -------------------------------------------------------------------------
    const slots = XS.normalize((await db.query(`SELECT extra_slots FROM checklist_items WHERE id=$1`, [itemId])).rows[0].extra_slots);
    const filledKey = slots.find((s) => s.label === 'Updated operating agreement').key;
    const internalKey = slots.find((s) => s.label === 'Internal memo on vesting').key;
    const rm1 = await call(server, 'DELETE', `/api/staff/applications/${appId}/checklist/${itemId}/extra-slots/${encodeURIComponent(filledKey)}`, tok);
    ok('E1 a FILLED slot refuses removal (the document is a record)', rm1.status === 409);
    const rm2 = await call(server, 'DELETE', `/api/staff/applications/${appId}/checklist/${itemId}/extra-slots/${encodeURIComponent(internalKey)}`, tok);
    ok('E2 an unfilled slot removes cleanly', rm2.status === 200);
    const afterRm = XS.normalize((await db.query(`SELECT extra_slots FROM checklist_items WHERE id=$1`, [itemId])).rows[0].extra_slots);
    ok('E3 only the removed slot is gone', afterRm.length === 2 && !afterRm.some((s) => s.key === internalKey));
    const rm3 = await call(server, 'DELETE', `/api/staff/applications/${appId}/checklist/${itemId}/extra-slots/nope`, tok);
    ok('E4 an unknown key answers 404', rm3.status === 404);

    // ---- F. the staff checklist GET merges extras into row.slots ---------------------------
    const sl = await call(server, 'GET', `/api/staff/applications/${appId}/checklist`, tok);
    const sItem = (sl.body || []).find((it) => String(it.id) === String(itemId));
    const merged = (sItem && sItem.slots) || [];
    ok('F1 the staff row carries the extras as slots (extra:true, extra:-prefixed key)',
      merged.filter((s) => s.extra === true).length === 2
      && merged.every((s) => !s.extra || String(s.key).startsWith('extra:'))
      && merged.some((s) => s.extra && s.label === 'Updated operating agreement' && s.audience === 'external' && s.added_by_name === 'Slot Super'));
    ok('F2 the raw extra_slots column rides for the manage UI', Array.isArray(sItem && sItem.extra_slots) && sItem.extra_slots.length === 2);

    // ---- H. the slot-assignment route accepts an EXTRA slot's label ------------------------
    // (audit 078cb1a #1 — the "Also in this condition" picker offers the ad-hoc
    // label, so the assignment route must accept it; before the fix this was a
    // guaranteed dead-end 400 on the exact workflow the feature exists for.)
    const looseDoc = await addDoc(itemId, null, 'pending', 'unfiled.pdf');
    const assign = await call(server, 'POST', `/api/staff/applications/${appId}/documents/${looseDoc}/slot`, tok, { slot: 'Updated operating agreement' });
    const assigned = (await db.query(`SELECT slot_label FROM documents WHERE id=$1`, [looseDoc])).rows[0];
    ok('H1 an unfiled document can be filed into an extra slot', assign.status === 200 && assigned.slot_label === 'Updated operating agreement');
    const badAssign = await call(server, 'POST', `/api/staff/applications/${appId}/documents/${looseDoc}/slot`, tok, { slot: 'Not a slot anywhere' });
    ok('H2 a label that is neither a template slot nor an extra slot still refuses', badAssign.status === 400);
    await db.query(`UPDATE documents SET slot_label=NULL WHERE id=$1`, [looseDoc]);
    // H3 (audit #8): an extra ask duplicating a TEMPLATE slot's label is refused —
    // two identical slot rows filled by one document is a rendering lie.
    const tplItem = (await db.query(
      `INSERT INTO checklist_items (scope,application_id,template_id,label,audience,item_kind,is_required,created_by_kind)
       SELECT 'application',$1,t.id,t.label,'both','document',true,'system'
         FROM checklist_templates t WHERE t.slots IS NOT NULL AND jsonb_array_length(t.slots) > 0 LIMIT 1
       RETURNING id, (SELECT slots FROM checklist_templates t2 WHERE t2.id=template_id) AS slots`, [appId])).rows[0];
    if (tplItem) {
      const tplSlotLabel = tplItem.slots[0].label;
      const dupTpl = await call(server, 'POST', `/api/staff/applications/${appId}/checklist/${tplItem.id}/extra-slots`, tok, { label: tplSlotLabel, audience: 'internal' });
      ok('H3 an extra ask duplicating a template slot label is refused', dupTpl.status === 409 && /already has/.test((dupTpl.body && dupTpl.body.error) || ''));
    } else {
      ok('H3 an extra ask duplicating a template slot label is refused (no slotted template found)', false);
    }

    // ---- G. the TPR export ships the slot document with the condition -----------------------
    const otherDoc = await addDoc(itemId, null, 'accepted', 'articles.pdf');
    const tpr = require('../src/lib/tpr-export');
    const tprDocs = await tpr.selectTprDocuments(appId);
    const slotRow = tprDocs.find((d) => String(d.id) === String(pendingDoc));
    const otherRow = tprDocs.find((d) => String(d.id) === String(otherDoc));
    ok('G1 the accepted slot document ships in the TPR package', !!slotRow);
    ok('G2 it files in the SAME category folder as the condition\'s other documents',
      !!slotRow && !!otherRow && tpr.categoryFor(slotRow) === tpr.categoryFor(otherRow));
  } finally {
    try {
      if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-condition-extra-slots-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

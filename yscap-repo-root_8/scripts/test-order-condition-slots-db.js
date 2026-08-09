/**
 * ORDER RETURNS REACH THEIR CONDITION — real Postgres, real HTTP.
 * Skips cleanly with no DATABASE_URL.
 *
 * The owner's report (2026-08-03): "we just got back insurance documents and it
 * was not automatically attached to the insurance condition." The documents WERE
 * attached — order-inbox has always set `checklist_item_id`. Two things made them
 * invisible on the condition, and only a real database can prove either fix:
 *
 *   1. THE SLOT VOCABULARY. The Orders desk kept its OWN classification labels
 *      ('Binder'); the insurance condition declares its slots as "Insurance
 *      binder" / "Insurance invoice" and the file screen matches a document to a
 *      slot by an EXACT label compare. So a classified document rendered nowhere.
 *      Now the desk's slots are DERIVED from that template row — asserted here
 *      against the LIVE template, not a copy of it.
 *   2. THE MISSING CONDITION. A file outside `generateChecklist`'s RTL path and
 *      outside db/051's back-fill window has no insurance condition at all, so
 *      the return was saved with no condition to sit in.
 *
 * Plus the previous-and-future half (db/420) and the two write doors.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-order-condition-slots-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const orderInbox = require('../src/lib/order-inbox');
const orderSlots = require('../src/lib/order-slots');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `ocs-${process.pid}-${Date.now()}`;
// A minimal but real PDF, so it passes the signature-image filter and the
// magic-byte sniff exactly as a vendor's binder would.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const b64 = PDF.toString('base64');

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /* ───────────────────────────────── seed ─────────────────────────────────── */
  const mkStaff = async (role, name, email) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
    [email, name, role])).rows[0].id;
  const officer = await mkStaff('loan_officer', 'Ophelia Officer', `${uniq}-lo@example.test`);
  const outsider = await mkStaff('loan_officer', 'Otto Other', `${uniq}-other@example.test`);
  // Only a "completer" role may mark a condition satisfied, so the sign-off gate
  // check below is made as a processor rather than the loan officer.
  const processor = await mkStaff('processor', 'Percy Processor', `${uniq}-proc@example.test`);
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;

  const mkApp = async () => {
    const id = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type)
       VALUES ($1,$2,$3,$4,'underwriting','Purchase') RETURNING id`,
      [borrower, officer, `YS${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 90 + 10)}`,
       JSON.stringify({ oneLine: '5 Slot St, Brooklyn, NY 11211', street: '5 Slot St', city: 'Brooklyn', state: 'NY', zip: '11211' })])).rows[0].id;
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer')
                    ON CONFLICT DO NOTHING`, [id, officer]);
    await db.query(`UPDATE applications SET processor_id=$2 WHERE id=$1`, [id, processor]);
    return id;
  };

  const tokenFor = (id, role) => signJwt({ sub: id, kind: 'staff', role, tv: 0, sid: 'test' });
  const jwtLo = tokenFor(officer, 'loan_officer');
  const jwtOut = tokenFor(outsider, 'loan_officer');
  const jwtProc = tokenFor(processor, 'processor');
  const call = async (method, p, body, jwt = jwtLo) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
    return { status: r.status, body: j };
  };
  const itemIdFor = async (appId, code) => (await db.query(
    `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code=$2 ORDER BY ci.created_at ASC LIMIT 1`, [appId, code])).rows[0];

  /* ── 1. the slots the desk offers ARE the condition template's own slots ──── */
  {
    const live = (await db.query(`SELECT slots FROM checklist_templates WHERE code='rtl_cond_insurance'`)).rows[0];
    const templateLabels = (live && Array.isArray(live.slots) ? live.slots : []).map((s) => s.label);
    const derived = await orderSlots.slotsFor(db, 'insurance');
    assert(templateLabels.length > 0, 'the insurance condition really declares named slots in the database');
    assert(JSON.stringify(derived.conditionSlots) === JSON.stringify(templateLabels),
      'the Orders desk offers EXACTLY the condition template\'s slot labels — read live, never a copy');
    assert(derived.all.slice(0, templateLabels.length).join('|') === templateLabels.join('|'),
      'the condition slots are offered first');
    const title = await orderSlots.slotsFor(db, 'title');
    assert(title.conditionSlots.length === 0,
      'the title condition declares no named slots, so a title return needs no classification to show');
  }

  /* ── 2. a return files onto the condition, CREATING it when the file lacks one ── */
  let appA;
  {
    appA = await mkApp();
    const before = await itemIdFor(appA, 'rtl_cond_insurance');
    assert(!before, 'the fresh file starts with NO insurance condition (the case that stranded the documents)');

    const r = await orderInbox.saveReturnedDocs({
      applicationId: appA, orderType: 'insurance',
      attachments: [{ filename: 'binder.pdf', contentType: 'application/pdf', content: b64 }],
      fromEmail: 'agent@shield.test',
    });
    assert(r.saved === 1, 'the returned document is filed');
    const cond = await itemIdFor(appA, 'rtl_cond_insurance');
    assert(!!cond, 'the insurance condition is CREATED so the document has somewhere to live');
    const doc = (await db.query(
      `SELECT checklist_item_id, slot_label, doc_kind FROM documents WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [appA])).rows[0];
    assert(doc.checklist_item_id === cond.id, 'the document is attached to that condition');
    assert(doc.slot_label === null, 'it arrives UNASSIGNED — a human says whether it is the binder or the invoice');
    assert(doc.doc_kind === 'insurance_order_return', 'it is tagged as an insurance order return');

    // A redelivery must not create a second condition.
    await orderInbox.saveReturnedDocs({
      applicationId: appA, orderType: 'insurance',
      attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: b64 }],
      fromEmail: 'agent@shield.test',
    });
    const n = (await db.query(
      `SELECT count(*)::int AS c FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_cond_insurance'`, [appA])).rows[0].c;
    assert(n === 1, 'a second return does NOT create a second insurance condition');
  }

  /* ── 3. the Orders desk payload points at the condition and its slots ─────── */
  {
    const r = await call('GET', `/api/staff/applications/${appA}/orders`);
    assert(r.status === 200, 'the Orders desk loads');
    const ins = r.body.orders.insurance;
    const cond = await itemIdFor(appA, 'rtl_cond_insurance');
    assert(ins.condition && ins.condition.itemId === cond.id,
      'the desk names the condition the documents file into, by id');
    assert((ins.conditionSlots || []).length > 0 && ins.slots[0] === ins.conditionSlots[0],
      'the desk reports which of its slots are REAL slots on the condition');
    assert((ins.returnedDocs || []).length === 2, 'both returned documents are listed');
    assert(ins.returnedDocs.every((d) => 'content_type' in d),
      'each returned document carries its content type, so it can be previewed in place');
  }

  /* ── 4. classifying stores the CONDITION's own label, legacy input and all ── */
  {
    const docs = (await db.query(
      `SELECT id, filename FROM documents WHERE application_id=$1 AND doc_kind='insurance_order_return' ORDER BY created_at ASC`,
      [appA])).rows;
    const conditionSlots = (await orderSlots.slotsFor(db, 'insurance')).conditionSlots;
    const binderLabel = conditionSlots.find((s) => s.toLowerCase().includes('binder'));

    // The label the OLD desk wrote. It must land in the condition's binder slot,
    // stored with the condition's spelling — this is the whole bug.
    const c1 = await call('POST', `/api/staff/applications/${appA}/orders/insurance/documents/${docs[0].id}/classify`, { slot: 'Binder' });
    assert(c1.status === 200 && c1.body.slot === binderLabel,
      `a legacy "Binder" is stored as the condition's own label (${binderLabel})`);
    const stored = (await db.query(`SELECT slot_label FROM documents WHERE id=$1`, [docs[0].id])).rows[0].slot_label;
    assert(stored === binderLabel, 'and that is what is really in the database');

    const bad = await call('POST', `/api/staff/applications/${appA}/orders/insurance/documents/${docs[1].id}/classify`, { slot: 'Whatever' });
    assert(bad.status === 400 && bad.body.code === 'bad_slot', 'an unknown label is refused, never stored as free text');

    const clear = await call('POST', `/api/staff/applications/${appA}/orders/insurance/documents/${docs[0].id}/classify`, { slot: '' });
    assert(clear.status === 200 && clear.body.slot === null, 'and it can be put back to unassigned');
  }

  /* ── 5. the same act, done FROM the condition ─────────────────────────────── */
  {
    const doc = (await db.query(
      `SELECT id FROM documents WHERE application_id=$1 AND doc_kind='insurance_order_return' ORDER BY created_at ASC LIMIT 1`,
      [appA])).rows[0];
    const conditionSlots = (await orderSlots.slotsFor(db, 'insurance')).conditionSlots;
    const invoiceLabel = conditionSlots.find((s) => s.toLowerCase().includes('invoice'));

    const r = await call('POST', `/api/staff/applications/${appA}/documents/${doc.id}/slot`, { slot: invoiceLabel });
    assert(r.status === 200 && r.body.slot === invoiceLabel, 'a document can be filed into a slot from the condition itself');
    const back = await call('POST', `/api/staff/applications/${appA}/documents/${doc.id}/slot`, { slot: '' });
    assert(back.status === 200 && back.body.slot === null, 'and taken back out of the slot');
    const bad = await call('POST', `/api/staff/applications/${appA}/documents/${doc.id}/slot`, { slot: 'Nonsense' });
    assert(bad.status === 400 && bad.body.code === 'bad_slot', 'an unknown slot is refused here too');
    assert((await call('POST', `/api/staff/applications/${appA}/documents/${doc.id}/slot`, { slot: invoiceLabel }, jwtOut)).status === 403,
      'a staffer who is not on the file gets 403');

    // A document on NO condition has no slot to go in, and says so.
    const loose = (await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, review_status)
       VALUES ($1,$2,'loose.pdf','application/pdf',10,'local','x/y','staff','pending') RETURNING id`,
      [appA, borrower])).rows[0].id;
    const l = await call('POST', `/api/staff/applications/${appA}/documents/${loose}/slot`, { slot: invoiceLabel });
    assert(l.status === 400 && l.body.code === 'no_condition', 'a document on no condition is refused with a reason');
  }

  /* ── 6. the sign-off gate still recognises the derived labels ─────────────── */
  {
    // The gate matches by lower-case SUBSTRING, so "Insurance binder" and
    // "Insurance invoice" must satisfy it — otherwise the rename would have
    // stopped a complete insurance condition from ever clearing.
    const cond = await itemIdFor(appA, 'rtl_cond_insurance');
    const slots = (await orderSlots.slotsFor(db, 'insurance')).conditionSlots;
    const docs = (await db.query(
      `SELECT id FROM documents WHERE checklist_item_id=$1 ORDER BY created_at ASC`, [cond.id])).rows;
    await db.query(`UPDATE documents SET slot_label=$2 WHERE id=$1`, [docs[0].id, slots.find((s) => /binder/i.test(s))]);
    await db.query(`UPDATE documents SET slot_label=$2 WHERE id=$1`, [docs[1].id, slots.find((s) => /invoice/i.test(s))]);

    // LABELLING A SLOT IS NOT REVIEWING WHAT IS IN IT (owner-directed
    // 2026-08-03). An order return arrives from the vendor by email and is
    // filed 'pending', exactly like any other document somebody sends us — and
    // this is the very condition the owner reported: a previous carrier's
    // never-accepted binder filled the "binder" slot, so the gate passed and the
    // whole set shipped to the investor and to the closing attorney. So the
    // labels alone must NOT clear it…
    const early = await call('PATCH', `/api/staff/checklist/${cond.id}`, { status: 'satisfied' }, jwtProc);
    assert(early.status === 422 && /waiting for a decision/i.test((early.body || {}).error || ''),
      'the labelled-but-unaccepted returns do NOT clear the condition');

    // …and once a human has actually accepted both, it clears normally.
    for (const d of docs.slice(0, 2)) {
      await call('POST', `/api/staff/documents/${d.id}/review`, { action: 'accept' }, jwtProc);
    }
    const r = await call('PATCH', `/api/staff/checklist/${cond.id}`, { status: 'satisfied' }, jwtProc);
    assert(r.status === 200, `with both derived labels ACCEPTED the insurance condition can be completed (${r.status} ${JSON.stringify(r.body)})`);
    const st = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [cond.id])).rows[0].status;
    assert(st === 'satisfied', 'and it really is satisfied');
  }

  /* ── 7. PREVIOUS FILES: db/420 heals what shipped before the fix ──────────── */
  {
    const appB = await mkApp();
    // Exactly the two damaged shapes: a return with the legacy label, and a return
    // stranded with no condition at all.
    const legacy = (await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, doc_kind, slot_label, review_status)
       VALUES ($1,$2,'old-binder.pdf','application/pdf',10,'local','x/1','staff','insurance_order_return','Binder','pending')
       RETURNING id`, [appB, borrower])).rows[0].id;
    const orphanTitle = (await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, doc_kind, review_status)
       VALUES ($1,$2,'commitment.pdf','application/pdf',10,'local','x/2','staff','title_order_return','pending')
       RETURNING id`, [appB, borrower])).rows[0].id;
    assert(!(await itemIdFor(appB, 'rtl_cond_title')), 'the previous file has no title condition either');

    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '420_order_returns_reach_their_condition.sql'), 'utf8');
    await db.query(sql);

    const slots = (await orderSlots.slotsFor(db, 'insurance')).conditionSlots;
    const healed = (await db.query(`SELECT slot_label, checklist_item_id FROM documents WHERE id=$1`, [legacy])).rows[0];
    assert(healed.slot_label === slots.find((s) => /binder/i.test(s)),
      'a document classified under the old label is renamed to the slot it always belonged in');
    const insCond = await itemIdFor(appB, 'rtl_cond_insurance');
    assert(!!insCond && healed.checklist_item_id === insCond.id,
      'and the stranded insurance return is attached to its condition');
    const titleCond = await itemIdFor(appB, 'rtl_cond_title');
    const t = (await db.query(`SELECT checklist_item_id FROM documents WHERE id=$1`, [orphanTitle])).rows[0];
    assert(!!titleCond && t.checklist_item_id === titleCond.id, 'the stranded title return is attached to its condition');

    // Idempotent: a second boot must change nothing and add nothing.
    await db.query(sql);
    const again = (await db.query(`SELECT slot_label, checklist_item_id FROM documents WHERE id=$1`, [legacy])).rows[0];
    assert(again.slot_label === healed.slot_label && again.checklist_item_id === healed.checklist_item_id,
      're-running the repair on the next boot changes nothing');
    const dupes = (await db.query(
      `SELECT count(*)::int AS c FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code IN ('rtl_cond_insurance','rtl_cond_title')`, [appB])).rows[0].c;
    assert(dupes === 2, 'and it creates no duplicate conditions');
  }

  /* ── 8. the repair never sprinkles conditions on unrelated files ──────────── */
  {
    const appC = await mkApp();
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '420_order_returns_reach_their_condition.sql'), 'utf8');
    await db.query(sql);
    const n = (await db.query(
      `SELECT count(*)::int AS c FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code IN ('rtl_cond_insurance','rtl_cond_title')`, [appC])).rows[0].c;
    assert(n === 0, 'a file that never ordered anything gets no title/insurance condition from the repair');
  }

  server.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

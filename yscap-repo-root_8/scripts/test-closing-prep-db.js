/**
 * ATTORNEY CLOSING PREP + the CLOSING EMAIL CHAIN — end-to-end, real Postgres,
 * real HTTP. Skips cleanly with no DATABASE_URL.
 *
 * A pure test cannot prove any of this: every claim below is about a real column, a
 * real route, or a real row.
 *   · the closing-prep order sends, with the right people and the right documents
 *   · it opens ONE chain per file, with a unique address
 *   · the two db/005 conditions this replaces are recorded as done
 *   · a double-click cannot send twice; a deliberate re-send can
 *   · the three automatic updates ride the SAME chain, exactly once each, and
 *     threading headers really go out on the wire
 *   · a NEW inbound chain (the attorney's own subject) files onto the file, its
 *     documents land in the CLOSING CORRESPONDENCE package attached to no condition,
 *     and it joins the ONE closing thread
 *   · the closing correspondence never reaches an investor TPR package
 *   · a file with no chain is silent
 *   · the per-file scope + the 403 hold
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-closing-prep-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';
process.env.ATTORNEY_GROUP_EMAIL = process.env.ATTORNEY_GROUP_EMAIL || 'teamag@privatelenderlaw.com';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

const db = require('../src/db');
const storage = require('../src/lib/storage');
const closingThread = require('../src/lib/closing-thread');
const closingPrep = require('../src/lib/closing-prep');
const closingInbox = require('../src/lib/closing-inbox');
const emailLog = require('../src/lib/email-log');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `cp-${process.pid}-${Date.now()}`;

// Capture what the provider was actually handed, so the wire payload can be asserted.
const noop = require('../src/lib/email/noop');
const realNoop = noop.sendMail;
const sends = [];
noop.sendMail = async (opts) => { sends.push(opts); return { ok: true, id: `stub-${sends.length}` }; };

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
  const processor = await mkStaff('processor', 'Percy Processor', `${uniq}-proc@example.test`);
  const closer = await mkStaff('closer', 'Malky Closer', `${uniq}-closer@example.test`);
  const outsider = await mkStaff('loan_officer', 'Otto Other', `${uniq}-other@example.test`);

  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const coBorrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Coco','Rrower',$1) RETURNING id`,
    [`${uniq}-co@example.test`])).rows[0].id;
  const llc = (await db.query(
    `INSERT INTO llcs (borrower_id, llc_name, formation_state) VALUES ($1,'12 Churchill Holdings LLC','NJ') RETURNING id`,
    [borrower])).rows[0].id;

  const appId = (await db.query(
    `INSERT INTO applications
       (borrower_id, co_borrower_id, llc_id, loan_officer_id, processor_id, closer_id,
        ys_loan_number, property_address, status, loan_type, program, term, property_type, units,
        purchase_price, is_assignment, underlying_contract_price, assignment_fee,
        as_is_value, arv, rehab_budget, expected_closing)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'underwriting','Purchase','Gold Standard','12 Months','Multi 2-4',3,
             120000,true,100000,20000,130000,200000,60000,'2026-08-14') RETURNING id`,
    [borrower, coBorrower, llc, officer, processor, closer,
     `YSCAP${String(process.pid).slice(-6)}`,
     JSON.stringify({ oneLine: '12 Churchill Lane, Lakewood, NJ 08701', street: '12 Churchill Lane', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;
  for (const [sid, role] of [[officer, 'loan_officer'], [processor, 'processor']]) {
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,$3)
                    ON CONFLICT DO NOTHING`, [appId, sid, role]);
  }

  const tokenFor = (id, role) => signJwt({ sub: id, kind: 'staff', role, tv: 0, sid: 'test' });
  const jwtLo = tokenFor(officer, 'loan_officer');
  const jwtOut = tokenFor(outsider, 'loan_officer');
  const call = async (method, path, body, jwt = jwtLo) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };

  // Contacts: title + realtor + settlement agent + attorney (shared) AND insurance
  // (which must never appear anywhere).
  const mkContact = async (type, company, email) => {
    const sc = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email, phone)
       VALUES ($1,$2,$3,$4,$5,'212-555-0100') RETURNING id`,
      [borrower, type, company, `${company} Person`, email])).rows[0].id;
    await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
                    VALUES ($1,$2,$3) ON CONFLICT (application_id, service_contact_id) DO NOTHING`, [appId, sc, type]);
    return sc;
  };
  await mkContact('title_company', 'Acme Title', `${uniq}-title@acme.test`);
  await mkContact('realtor', 'Best Realty', `${uniq}-realtor@best.test`);
  await mkContact('settlement_agent', 'Settle Co', `${uniq}-settle@settle.test`);
  await mkContact('attorney', 'Law LLP', `${uniq}-abe@law.test`);
  await mkContact('insurance_agent', 'Shield Insurance', `${uniq}-ins@shield.test`);
  await mkContact('flood_insurance', 'Flood Co', `${uniq}-flood@flood.test`);

  /* ───────── 1. blockers BEFORE the file is registered / has a term sheet ──── */
  {
    const r = await call('GET', `/api/staff/applications/${appId}/closing-prep`);
    assert(r.status === 200, 'GET closing-prep answers for an assigned officer');
    const blk = r.body.order.blockers;
    assert(blk.includes('not_registered'), 'an UNREGISTERED file is blocked from ordering closing prep');
    assert(blk.includes('term_sheet'), 'a file with no term sheet is blocked');
    assert(!blk.includes('attorney'), 'the attorney group inbox alone satisfies "somewhere to send it"');
    assert(r.body.chain === null, 'no closing chain exists before the order is sent');
    const place = await call('POST', `/api/staff/applications/${appId}/closing-prep/place`, {});
    assert(place.status === 400 && place.body.code === 'not_registered',
      'sending is REFUSED on an unregistered file, with a reason the sender can act on');
  }
  assert((await call('GET', `/api/staff/applications/${appId}/closing-prep`, null, jwtOut)).status === 403,
    'a staffer who is not on the file gets 403');

  /* ─────────────── 2. make the file real: registration + documents ────────── */
  await db.query(
    `INSERT INTO product_registrations (application_id, program, product_label, status, note_rate, total_loan, inputs, quote, is_current)
     VALUES ($1,'gold','Gold Standard','ELIGIBLE',0.1199,187500,'{}'::jsonb,'{}'::jsonb,true)`, [appId]);

  // Real condition items + real stored bytes, so the package and the attachments are real.
  const itemFor = async (code) => {
    const t = (await db.query(`SELECT id, label, audience, item_kind, scope FROM checklist_templates WHERE code=$1`, [code])).rows[0];
    if (!t) return null;
    const ex = (await db.query(`SELECT id FROM checklist_items WHERE application_id=$1 AND template_id=$2 LIMIT 1`, [appId, t.id])).rows[0];
    if (ex) return ex.id;
    return (await db.query(
      `INSERT INTO checklist_items (application_id, template_id, label, audience, item_kind, scope, status)
       VALUES ($1,$2,$3,$4,$5,$6,'outstanding') RETURNING id`,
      [appId, t.id, t.label, t.audience || 'staff', t.item_kind || 'document', t.scope || 'application'])).rows[0].id;
  };
  const addDoc = async ({ code, filename, docKind = null, slot = null, llcId = null, onBorrower = false, bytes = 4096 }) => {
    const itemId = code ? await itemFor(code) : null;
    const { ref, provider } = await storage.save(Buffer.alloc(bytes, 7), { filename });
    return (await db.query(
      `INSERT INTO documents (application_id, borrower_id, llc_id, checklist_item_id, filename, content_type,
                              size_bytes, storage_provider, storage_ref, uploaded_by_kind, doc_kind, slot_label,
                              review_status, is_current)
       VALUES ($1,$2,$3,$4,$5,'application/pdf',$6,$7,$8,'staff',$9,$10,'accepted',true) RETURNING id`,
      [onBorrower ? null : appId, borrower, llcId, itemId, filename, bytes, provider, ref, docKind, slot])).rows[0].id;
  };

  await addDoc({ code: null, filename: 'Term Sheet.pdf', docKind: 'term_sheet' });
  await addDoc({ code: 'rtl_p1_contract', filename: 'Purchase Contract.pdf' });
  await addDoc({ code: 'rtl_p1_contract', filename: 'Contract Addendum.pdf' });
  await addDoc({ code: 'rtl_p5_assign', filename: 'Assignment of Contract.pdf' });
  await addDoc({ code: 'rtl_llc_ein', filename: 'EIN Letter.pdf', llcId: llc, onBorrower: true });
  await addDoc({ code: 'rtl_llc_opagmt', filename: 'Operating Agreement.pdf', llcId: llc, onBorrower: true });
  await addDoc({ code: 'rtl_cond_insurance', filename: 'Insurance Binder.pdf', slot: 'Insurance binder' });
  await addDoc({ code: 'rtl_cond_insurance', filename: 'Insurance Invoice.pdf', slot: 'Insurance invoice' });
  await addDoc({ code: null, filename: 'Drivers License.pdf', docKind: 'photo_id', onBorrower: true });
  // …and the one document that must NEVER go out.
  await addDoc({ code: null, filename: 'Heter Iska signed.pdf', docKind: 'heter_iska_signed' });

  // The two conditions this order replaces must exist so the nudge can be observed.
  const attyItem = await itemFor('rtl_p5_atty');
  const titleInfoItem = await itemFor('rtl_p5_titleinfo');

  {
    const pkg = await closingPrep.gatherPackage(appId);
    assert(pkg.counts.term_sheet === 1, 'the term sheet is in the package');
    assert(pkg.counts.contract === 2, 'the contract AND everything else on that condition are in the package');
    assert(pkg.counts.assignment === 1, 'the assignment is in the package');
    assert(pkg.counts.llc === 2, "the vesting entity's documents are in the package");
    assert(pkg.counts.insurance === 2, 'the insurance binder AND invoice are in the package');
    assert(pkg.counts.photo_id === 1, "the borrower's driver's licence is in the package");
    assert(!pkg.ordered.some((d) => /iska/i.test(d.filename)),
      'THE HETER ISKA IS NOT IN THE PACKAGE — it never leaves the building');
    const ins = closingPrep.insuranceSlots(pkg.groups.insurance);
    assert(ins.binder && ins.invoice, 'the binder and invoice are recognised by their real stored slot labels');
    assert(pkg.missing.length === 0, 'nothing the owner named is missing on this file');
  }

  /* ─────────────────────────── 3. send the request ─────────────────────────── */
  let chainAddress = null;
  {
    sends.length = 0;
    const r = await call('POST', `/api/staff/applications/${appId}/closing-prep/place`,
      { extraEmails: `${uniq}-extra@x.test`, note: 'Seller counsel is on the contract.' });
    assert(r.status === 200, 'the closing-prep request sends');
    assert(sends.length === 1, 'exactly ONE email went out');
    const s = sends[0];
    assert(s.to.includes('teamag@privatelenderlaw.com'), 'To: the attorney group inbox');
    assert(s.to.includes(`${uniq}-abe@law.test`), "To: the file's attorney contact");
    assert(s.cc.includes(`${uniq}-lo@example.test`), 'Cc: the loan officer');
    assert(s.cc.includes(`${uniq}-proc@example.test`), 'Cc: the processor');
    assert(s.cc.includes(`${uniq}-closer@example.test`), 'Cc: OUR CLOSER');
    assert(s.cc.includes(`${uniq}-extra@x.test`), 'Cc: the extra address the sender typed');
    const all = [].concat(s.to, s.cc).join(' ');
    assert(!all.includes(`${uniq}-title@acme.test`), 'the title company is NOT copied (they get their own chain from the attorney)');
    assert(!all.includes(`${uniq}-ins@shield.test`) && !all.includes(`${uniq}-flood@flood.test`),
      'NEITHER insurance contact is copied');
    assert(!all.includes(`${uniq}-bo@example.test`), 'the borrower is not on a lender-to-counsel email');
    assert(/Ophelia Officer/.test(String(s.from || '')),
      'the From carries the PORTAL USER’s name — it does not read as a no-reply robot');
    assert(String(s.replyTo || '').startsWith('closing+'), 'Reply-To is this closing’s own address');
    assert(s.headers && s.headers['Message-ID'], 'a Message-ID is set, so later messages can reference it');
    assert(!s.headers['In-Reply-To'], 'the first message on the chain references nothing');
    assert(s.attachments && s.attachments.length === 9,
      `all nine documents are attached (got ${s.attachments && s.attachments.length})`);
    assert(!s.attachments.some((a) => /iska/i.test(a.filename)), 'and the Heter Iska is not among them');
    assert(s.html.includes(`${uniq}-title@acme.test`), 'the title company’s details ARE in the body');
    assert(s.html.includes(`${uniq}-settle@settle.test`), 'the settlement agent’s details are in the body');
    assert(s.html.includes(`${uniq}-realtor@best.test`), 'the realtor’s details are in the body');
    assert(!s.html.includes(`${uniq}-ins@shield.test`) && !s.html.includes(`${uniq}-flood@flood.test`),
      'NEITHER insurance contact appears in the body');
    assert(s.html.includes('Seller counsel is on the contract.'), 'the sender’s note is in the email');
    assert(r.body.address && r.body.address.startsWith('closing+'), 'the response hands back the unique closing address');
    chainAddress = r.body.address;
    assert((r.body.skipped || []).length === 0, 'nothing was skipped on a normal-sized package');
  }
  {
    const t = await closingThread.threadFor(appId);
    assert(!!t, 'a closing chain now exists for the file');
    assert(/^[0-9a-f]{20}$/.test(t.token), 'it has a random 20-hex token');
    assert(t.thread_key === closingThread.threadKeyOf(appId, t.token), 'its stored thread key is the canonical one');
    assert(!!t.root_message_id && t.root_message_id === t.last_message_id,
      'the first message became both the chain root and its current tip');
    assert(t.outbound_count === 1, 'the chain counted one outbound message');

    const em = (await db.query(
      `SELECT thread_key, msg_type, direction, jsonb_array_length(attachments) AS natt
         FROM email_messages WHERE application_id=$1 AND msg_type='closing_order'`, [appId])).rows[0];
    assert(!!em, 'the request is in the Email Center');
    assert(em.thread_key === t.thread_key, 'and is PINNED to the chain’s stored thread key, not a subject-derived one');
    assert(Number(em.natt) === 9, 'the Email Center records what was attached');

    const msg = (await db.query(
      `SELECT event_kind, dedupe_key, message_id, status FROM closing_thread_messages
        WHERE thread_id=$1 AND event_kind='order'`, [t.id])).rows;
    assert(msg.length === 1 && msg[0].dedupe_key === 'order' && msg[0].status === 'sent',
      'the chain records the order message with its dedupe key');

    const fo = (await db.query(`SELECT status, send_count FROM file_orders WHERE application_id=$1 AND order_type='attorney'`, [appId])).rows[0];
    assert(fo && fo.status === 'ordered' && fo.send_count === 1, 'the Orders desk row is created as ordered');

    const conds = (await db.query(
      `SELECT t.code, ci.status FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.id = ANY($1::uuid[])`, [[attyItem, titleInfoItem].filter(Boolean)])).rows;
    assert(conds.length && conds.every((c) => c.status === 'received'),
      'BOTH db/005 conditions this replaces are recorded as done — rtl_p5_atty and rtl_p5_titleinfo');
  }

  /* ──────── 4. a double-click cannot send twice; a re-send can ────────────── */
  {
    sends.length = 0;
    const again = await call('POST', `/api/staff/applications/${appId}/closing-prep/place`, {});
    assert(again.status === 409 && again.body.code === 'already_ordered',
      'a second send is refused — the attorney and the whole Cc chain are not blasted twice');
    assert(sends.length === 0, 'and nothing went out');
    const forced = await call('POST', `/api/staff/applications/${appId}/closing-prep/place`, { force: true });
    assert(forced.status === 200 && sends.length === 1, 'a DELIBERATE re-send is allowed');
    assert(sends[0].headers['In-Reply-To'], 'the re-send threads onto the existing chain');
    const fo = (await db.query(`SELECT send_count FROM file_orders WHERE application_id=$1 AND order_type='attorney'`, [appId])).rows[0];
    assert(fo.send_count === 2, 'the re-send is counted');
  }

  /* ───── 5. the three automatic updates ride the SAME chain, exactly once ─── */
  const chainMsgCount = async (kind) => Number((await db.query(
    `SELECT count(*) c FROM closing_thread_messages m JOIN closing_threads t ON t.id=m.thread_id
      WHERE t.application_id=$1 AND m.event_kind=$2 AND m.status='sent'`, [appId, kind])).rows[0].c);
  {
    sends.length = 0;
    const a = await closingPrep.announce({ applicationId: appId, eventKind: 'executed_term_sheet', dedupeKey: 'executed_term_sheet:env-1' });
    const b = await closingPrep.announce({ applicationId: appId, eventKind: 'executed_term_sheet', dedupeKey: 'executed_term_sheet:env-1' });
    assert(a.ok && !a.skipped, 'the executed term sheet goes out on the chain');
    assert(b.ok && b.skipped && b.reason === 'already_sent', 'a redelivered webhook cannot send it twice');
    assert(await chainMsgCount('executed_term_sheet') === 1, 'exactly one executed-term-sheet message exists');
    assert(sends.length === 1, 'and exactly one email went out');
    assert(sends[0].headers['In-Reply-To'] && sends[0].headers.References,
      'it references the chain — it does not open a new one');
    assert(/^Re: /.test(sends[0].subject), 'and reuses the chain subject, so every mail client threads it');
  }
  {
    sends.length = 0;
    // The file's date is 2026-08-14 and the ORDER email already stated it, so
    // announcing that date must send NOTHING — no matter how many doors fire it.
    const a = await closingPrep.announce({ applicationId: appId, eventKind: 'closing_date', dedupeKey: 'closing_date:2026-08-14', extra: { date: '2026-08-14' } });
    const b = await closingPrep.announce({ applicationId: appId, eventKind: 'closing_date', dedupeKey: 'closing_date:2026-08-14', extra: { date: '2026-08-14' } });
    assert(a.ok && a.skipped && b.ok && b.skipped,
      'the date the ORDER already stated is never re-announced (however many doors fire it)');
    assert(sends.length === 0, 'and no email goes out for it');
    // A genuinely NEW date is real news.
    await closingPrep.announce({ applicationId: appId, eventKind: 'closing_date', dedupeKey: 'closing_date:2026-08-21', extra: { date: '2026-08-21' } });
    await closingPrep.announce({ applicationId: appId, eventKind: 'closing_date', dedupeKey: 'closing_date:2026-08-21', extra: { date: '2026-08-21' } });
    assert(await chainMsgCount('closing_date') === 1, 'a genuinely NEW closing date is announced — exactly once');
    assert(sends.length === 1, 'one email for the one new date');
    assert(/August 21, 2026/.test(sends[0].html), 'and it names the new date');
  }
  {
    sends.length = 0;
    await closingPrep.announce({ applicationId: appId, eventKind: 'clear_to_close', dedupeKey: 'clear_to_close' });
    await closingPrep.announce({ applicationId: appId, eventKind: 'clear_to_close', dedupeKey: 'clear_to_close' });
    assert(await chainMsgCount('clear_to_close') === 1, 'clear-to-close is announced exactly once per file');
    assert(sends.length === 1 && /CLEAR TO CLOSE/.test(sends[0].html), 'and says so plainly');
  }

  /* ── 5b. AUDITED: a transient send failure must NOT kill the event forever ── */
  {
    // The dedupe key is the "already sent" proof. Before the fix a failed row kept
    // it, so one two-second provider blip meant the closing attorney was NEVER told
    // the term sheet was executed — by any door, and the backstop could not help.
    const realNoopSend = noop.sendMail;
    noop.sendMail = async () => { throw new Error('provider down'); };
    const failed = await closingPrep.announce({
      applicationId: appId, eventKind: 'executed_term_sheet', dedupeKey: 'executed_term_sheet:env-blip',
    });
    noop.sendMail = realNoopSend;
    assert(!failed.ok && failed.reason === 'send_failed', 'a provider failure is reported, not swallowed');
    const row = (await db.query(
      `SELECT status, error, dedupe_key FROM closing_thread_messages
        WHERE thread_id=(SELECT id FROM closing_threads WHERE application_id=$1)
          AND event_kind='executed_term_sheet' AND status='error'`, [appId])).rows[0];
    assert(!!row && row.error, 'the failed attempt is KEPT for the audit trail, with its reason');
    assert(row.dedupe_key === null,
      'but its claim on the event is RELEASED, so the update is not lost forever');
    sends.length = 0;
    const retried = await closingPrep.announce({
      applicationId: appId, eventKind: 'executed_term_sheet', dedupeKey: 'executed_term_sheet:env-blip',
    });
    assert(retried.ok && !retried.skipped && sends.length === 1,
      'the very next attempt actually sends it');
    const third = await closingPrep.announce({
      applicationId: appId, eventKind: 'executed_term_sheet', dedupeKey: 'executed_term_sheet:env-blip',
    });
    assert(third.ok && third.skipped, 'and once it HAS sent, it still cannot send twice');
  }

  /* ── 5c. AUDITED: the order claims what it already told them ─────────────── */
  {
    // The order email prints the expected closing date in its deal block, so the
    // backstop must not follow it minutes later with "the closing date is NOW …".
    const carried = (await db.query(
      `SELECT event_kind, dedupe_key, status FROM closing_thread_messages
        WHERE thread_id=(SELECT id FROM closing_threads WHERE application_id=$1)
          AND status='carried' ORDER BY event_kind`, [appId])).rows;
    assert(carried.some((r) => r.event_kind === 'closing_date' && r.dedupe_key === 'closing_date:2026-08-14'),
      'placing the order claims the closing date it already stated');
    sends.length = 0;
    const swept = await require('../src/lib/notification-digests').closingChainCatchupOnce();
    const phantom = sends.filter((x) => /expected closing date is now/i.test(String(x.html || '')));
    assert(phantom.length === 0,
      'so the backstop sends NO phantom "there is a new closing date" for a date the order carried');
    assert(typeof swept === 'number', 'the backstop sweep completes and reports');
  }

  /* ─── 6. a file with NO closing chain is silent (nobody was ever engaged) ── */
  {
    const otherApp = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status)
       VALUES ($1,$2,$3,$4,'processing') RETURNING id`,
      [borrower, officer, `YSNOCHAIN${String(process.pid).slice(-4)}`, JSON.stringify({ oneLine: '9 Nowhere St' })])).rows[0].id;
    sends.length = 0;
    const r = await closingPrep.announce({ applicationId: otherApp, eventKind: 'clear_to_close', dedupeKey: 'clear_to_close' });
    assert(r.ok && r.skipped && r.reason === 'no_closing_chain',
      'a file whose closing prep was never ordered is silently skipped');
    assert(sends.length === 0, 'and no email is sent to an attorney who was never engaged');
    await db.query(`DELETE FROM applications WHERE id=$1`, [otherApp]);
  }

  /* ─── 7. THE POINT OF THE FEATURE: the attorney's OWN new chain comes back ── */
  const thread = await closingThread.threadFor(appId);
  {
    const token = thread.token;
    const ref = await closingThread.resolveByToken(token);
    assert(ref && ref.applicationId === appId, 'the unique address resolves back to this file');
    assert((await closingThread.resolveByToken('deadbeefdeadbeefdead')) === null, 'an unknown token resolves to nothing');

    // The attorney opens a BRAND-NEW chain with their own subject, and merely CCs us.
    const inboundId = (await db.query(
      `INSERT INTO inbound_file_emails (resend_email_id, recipients, status)
       VALUES ($1,$2,'received') RETURNING id`,
      [`${uniq}-in-1`, JSON.stringify([`${uniq}-title@acme.test`, closingThread.addressFor(thread)])])).rows[0].id;
    await emailLog.captureInbound({
      inboundId, applicationId: appId,
      from: `${uniq}-abe@law.test`,
      subject: '12 Churchill Lane closing — docs for review',      // NOT our subject
      text: 'All, attached is the draft settlement statement.',
      threadKey: thread.thread_key,
      msgType: 'closing_message',
      toEmails: [`${uniq}-title@acme.test`, closingThread.addressFor(thread)],
      attachments: [{ filename: 'Draft Settlement Statement.pdf', size: 2048 }],
    });
    const row = (await db.query(
      `SELECT thread_key, msg_type, direction, jsonb_array_length(attachments) AS natt,
              jsonb_array_length(to_emails) AS nto
         FROM email_messages WHERE inbound_id=$1`, [inboundId])).rows[0];
    assert(!!row, 'the attorney’s email is captured on the file');
    assert(row.thread_key === thread.thread_key,
      'AND IT JOINS THE SAME CLOSING THREAD despite a completely different subject');
    assert(row.msg_type === 'closing_message' && row.direction === 'inbound', 'tagged as a closing-chain message');
    assert(Number(row.natt) === 1, 'the documents it carried are recorded (inbound attachments used to be invisible)');
    assert(Number(row.nto) >= 1, 'who else was on their chain is recorded');
  }
  {
    // …and its documents file into the CLOSING CORRESPONDENCE package.
    const res = await closingInbox.saveChainDocs({
      applicationId: appId,
      attachments: [
        { filename: 'Draft Settlement Statement.pdf', contentType: 'application/pdf', content: Buffer.alloc(3000, 3).toString('base64') },
        { filename: 'Title Commitment.pdf', contentType: 'application/pdf', content: Buffer.alloc(2500, 4).toString('base64') },
      ],
      fromEmail: `${uniq}-abe@law.test`, subject: '12 Churchill Lane closing — docs for review',
    });
    assert(res.saved === 2, 'both documents from the attorney’s chain are saved');
    const docs = (await db.query(
      `SELECT filename, doc_kind, checklist_item_id, visibility, source_type, sha256
         FROM documents WHERE application_id=$1 AND doc_kind='closing_correspondence' ORDER BY filename`, [appId])).rows;
    assert(docs.length === 2, 'they are on the file as closing correspondence');
    assert(docs.every((d) => d.checklist_item_id === null),
      'ATTACHED TO NO CONDITION — a separate document package, exactly as the owner asked');
    assert(docs.every((d) => d.visibility === 'staff_only'), 'and staff-only, not pushed at the borrower');
    assert(docs.every((d) => d.sha256), 'each carries a sha256 so the SharePoint integrity audit can verify it');

    // Retry-safe: the same delivery again must not double-file.
    const again = await closingInbox.saveChainDocs({
      applicationId: appId,
      attachments: [{ filename: 'Draft Settlement Statement.pdf', contentType: 'application/pdf', content: Buffer.alloc(3000, 3).toString('base64') }],
      fromEmail: `${uniq}-abe@law.test`,
    });
    assert(again.saved === 1, 'a redelivery reports the document as handled');
    const n = Number((await db.query(
      `SELECT count(*) c FROM documents WHERE application_id=$1 AND doc_kind='closing_correspondence' AND filename='Draft Settlement Statement.pdf'`,
      [appId])).rows[0].c);
    assert(n === 1, 'and does NOT file a second copy');

    // SharePoint files it in its own Closing folder.
    const sp = require('../src/lib/sharepoint-backup');
    assert(sp.categoryFor({ doc_kind: 'closing_correspondence' }) === 'Closing/Correspondence',
      'SharePoint mirrors it into Closing/Correspondence, separate from the closing package');

    // …and it must never reach an investor package.
    const tprDocs = await require('../src/lib/tpr-export').selectTprDocuments(appId);
    assert(!tprDocs.some((d) => d.doc_kind === 'closing_correspondence'),
      'closing correspondence is NEVER in the investor TPR package');
    assert(!tprDocs.some((d) => /iska/i.test(d.filename || '')), 'and neither is the Heter Iska (unchanged)');
  }
  {
    await closingThread.noteInbound(thread.id, { docs: 2 });
    const t = await closingThread.threadFor(appId);
    assert(t.inbound_count >= 1 && t.docs_count >= 2, 'the chain counts what came back');
  }

  /* ──────────────── 8. the file shows the whole conversation ──────────────── */
  {
    const r = await call('GET', `/api/staff/applications/${appId}/emails?scope=closing`);
    assert(r.status === 200, 'the closing-scoped inbox answers');
    const types = (r.body.messages || r.body || []).map((m) => m.type || m.msg_type);
    const dirs = (r.body.messages || r.body || []).map((m) => m.direction);
    assert(types.some((t) => t === 'closing_order'), 'it contains the request we sent');
    assert(types.some((t) => t === 'closing_message'), 'and the attorney’s own email');
    assert(dirs.includes('inbound') && dirs.includes('outbound'), 'both directions are in one conversation');
  }
  {
    const r = await call('GET', `/api/staff/applications/${appId}/closing-prep`);
    assert(r.status === 200 && r.body.chain, 'the card now shows the chain');
    assert(r.body.chain.address === chainAddress, 'with the same unique address');
    assert((r.body.chain.messages || []).length >= 5, 'and the history of what the system sent on it');
    assert((r.body.chain.documents || []).length === 2, 'and the closing correspondence saved from it');
    assert(r.body.order.status === 'ordered', 'the order reads as requested');
    assert(r.body.file.isAssignment === true, 'the card knows this is an assignment');
    const dealLabels = (r.body.deal || []).map((d) => d.label);
    assert(dealLabels.includes('Underlying contract price') && dealLabels.includes('Assignment fee')
      && dealLabels.includes('Total purchase price'), 'the deal block carries the full assignment picture');
  }

  /* ─────────────────────────── 9. follow-up + cancel ─────────────────────── */
  {
    sends.length = 0;
    const r = await call('POST', `/api/staff/applications/${appId}/closing-prep/followup`, { message: 'Any update on the docs?' });
    assert(r.status === 200 && sends.length === 1, 'a human follow-up sends');
    assert(sends[0].to.includes('teamag@privatelenderlaw.com'), 'to the same people the chain already reached');
    assert(sends[0].headers['In-Reply-To'], 'on the same chain');
    assert(sends[0].html.includes('Any update on the docs?'), 'carrying the typed message');
  }
  {
    // A reply typed in the closing inbox goes to the ATTORNEY, not the borrower.
    sends.length = 0;
    const r = await call('POST', `/api/staff/applications/${appId}/emails/reply`,
      { body: 'Confirming the wire details.', scope: 'closing' });
    assert(r.status === 200 && sends.length === 1, 'a reply in the closing inbox sends');
    assert(sends[0].to.includes('teamag@privatelenderlaw.com'), 'to the attorney');
    assert(!sends[0].to.includes(`${uniq}-bo@example.test`) && !(sends[0].cc || []).includes(`${uniq}-bo@example.test`),
      'and NEVER to the borrower — a lender-to-counsel chain stays lender-to-counsel');
  }
  {
    // AUDITED: with no chain this branch used to FALL THROUGH to the default fan-out,
    // which includes the borrower — the exact outcome it exists to prevent.
    const bare = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status)
       VALUES ($1,$2,$3,$4,'processing') RETURNING id`,
      [borrower, officer, `YSNOCHAIN2${String(process.pid).slice(-4)}`, JSON.stringify({ oneLine: '9 Nowhere St' })])).rows[0].id;
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer')
                    ON CONFLICT DO NOTHING`, [bare, officer]);
    sends.length = 0;
    const r = await call('POST', `/api/staff/applications/${bare}/emails/reply`,
      { body: 'hello', scope: 'closing' });
    assert(r.status === 400 && r.body.code === 'not_ordered',
      'a closing-scoped reply on a file with NO chain is REFUSED, not redirected');
    assert(sends.length === 0, 'and the borrower is not emailed');
    await db.query(`DELETE FROM applications WHERE id=$1`, [bare]);
  }
  {
    // AUDITED: the exclusion keyed only on the DIRECTORY row's type, which a vendor
    // edit or a merge can change. The per-file link records what it really is.
    const ins = (await db.query(
      `SELECT sc.id FROM application_service_contacts l JOIN service_contacts sc ON sc.id=l.service_contact_id
        WHERE l.application_id=$1 AND l.contact_type='insurance_agent' LIMIT 1`, [appId])).rows[0];
    await db.query(`UPDATE service_contacts SET contact_type='title_company' WHERE id=$1`, [ins.id]);
    const data = await closingPrep.getClosingPrepData(appId);
    const emails = data.contacts.map((c) => c.email);
    assert(!emails.includes(`${uniq}-ins@shield.test`),
      'retyping an insurance contact in the vendor directory does NOT sneak it into the closing email');
    await db.query(`UPDATE service_contacts SET contact_type='insurance_agent' WHERE id=$1`, [ins.id]);
  }
  {
    const c = await call('POST', `/api/staff/applications/${appId}/closing-prep/cancel`, {});
    assert(c.status === 200 && c.body.status === 'cancelled', 'the order can be cancelled');
    const t = await closingThread.threadFor(appId);
    assert(!!t, 'cancelling does NOT destroy the chain — what the attorney already sent stays on the file');
    const re = await call('POST', `/api/staff/applications/${appId}/closing-prep/cancel`, { reopen: true });
    assert(re.status === 200 && re.body.status === 'ordered', 'and can be reopened');
  }

  /* ───────────────── 10. the global orders queue sees it ─────────────────── */
  {
    const r = await call('GET', '/api/staff/orders');
    const row = (r.body || []).find((f) => f.applicationId === appId);
    assert(!!row && !!row.attorney, 'the closing-prep order appears in the global orders queue');
    assert(row.attorney.unassignedDocs === 0,
      'and its chain documents are never counted as "waiting to be classified" (they need no slot)');
    assert(row.attorney.returnedDocs === 2, 'while the documents that came back ARE counted');
  }

  /* ─────────────────────────────── cleanup ───────────────────────────────── */
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
  await db.query(`DELETE FROM llcs WHERE id=$1`, [llc]);
  await db.query(`DELETE FROM inbound_file_emails WHERE resend_email_id LIKE $1`, [`${uniq}%`]);
  await db.query(`DELETE FROM service_contacts WHERE borrower_id=$1`, [borrower]);
  await db.query(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [[borrower, coBorrower]]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[officer, processor, closer, outsider]]);
  noop.sendMail = realNoop;
  server.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll closing-prep DB checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });

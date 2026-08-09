/* INVESTOR DELIVERY, END TO END, AGAINST A REAL DATABASE (owner-directed 2026-08-03).
 *
 * The pure suite (scripts/test-investor-delivery-pure.js) proves the rules. This one proves the
 * WIRING — the contact lookup, the funding-mode resolution across three sources, the blockers as
 * the real tables report them, the attachment gathering, and the fact that the borrower can never
 * end up on an investor email — because every one of those lives in a query the pure test cannot
 * reach.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-investor-delivery-db.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-investor-delivery-db (no DATABASE_URL)');
  process.exit(0);
}

const crypto = require('crypto');
const db = require('../src/db');
const send = require('../src/sitewire/investor-delivery-send');
const ID = require('../src/sitewire/investor-delivery');

(async () => {
  // ---------------------------------------------------------------- fixture
  // The reported file shape: a $25,000 roof draw across four units, note buyer Fidelis.
  const email = 'inv' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(
    `INSERT INTO borrowers(first_name,last_name,email) VALUES('Investor','Delivery',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'INV' + crypto.randomBytes(3).toString('hex');
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address)
     VALUES($1,'funded',$2,'Fidelis Investors LLC','{"oneLine":"195-197 Parrish St","city":"Wilkes-Barre","state":"PA","zip":"18702"}') RETURNING id`,
    [bor, loan])).rows[0].id;

  const BASE = 870000 + crypto.randomBytes(2).readUInt16BE(0) * 10;
  const DRAW = BASE, BUDGET = BASE + 1, PROP = BASE + 2;
  const JI = (u) => BASE + 100 + u;
  const REQ = (u) => BASE + 200 + u;

  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at,inspection_method) VALUES($1,$2,'created','live',now(),'mobile')`, [app, PROP]);
  await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES($1,$2,1,'pending',2500000,0)`, [app, DRAW]);
  for (const u of [1, 2, 3, 4]) {
    await db.query(
      `INSERT INTO sitewire_job_item_links(application_id,sitewire_budget_id,sow_line_key,section_token,unit_index,sitewire_job_item_id,name,budgeted_cents,state)
       VALUES($1,$2,'cat:roof',$3,$4,$5,$6,625000,'live')`, [app, BUDGET, 'u' + u, u, JI(u), `Unit ${u} - Roof`]);
    await db.query(
      `INSERT INTO sitewire_draw_requests(sitewire_draw_id,sitewire_request_id,sitewire_job_item_id,job_item_name,requested_cents,approved_cents,inspection_count)
       VALUES($1,$2,$3,$4,625000,625000,5)`, [DRAW, REQ(u), JI(u), `Unit ${u} - Roof`]);
  }
  const fid = (await db.query(
    `INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at)
     VALUES($1,$2,'delivered',2500000,2500000,now()) RETURNING id`, [app, DRAW])).rows[0].id;

  // The signed WIRE FORM condition + an ACCEPTED signed form on it (Task 4). The delivery gate
  // requires an accepted wire form before an emailed delivery, so the fixture starts with one
  // (section K flips it through the pending / rejected / missing states). Bogus storage_ref: the
  // GATE only reads its review state; the ATTACHMENT read (section G) still reports it correctly.
  const drawWire = require('../src/lib/esign/draw-wire');
  const wireItem = await drawWire.ensureDrawRequestCondition(db, app, null);
  const wireDoc = (await db.query(
    `INSERT INTO documents(application_id,checklist_item_id,filename,doc_kind,storage_ref,review_status,is_current,source_type,visibility)
     VALUES($1,$2,'wire-instructions-signed.pdf','draw_request_signed','nope/nostorage','accepted',true,'system','borrower') RETURNING id`,
    [app, wireItem])).rows[0].id;

  // ================================================================ A. the contact lookup
  // The owner's real ClickUp label is "Fidelis Investors LLC", which the EXACT shared normalizer
  // turns into `fidelisinvestorsllc` — NOT `fidelis`. If the key were taken from that normalizer
  // alone the seeded Fidelis team would never be found on a real file. This is the whole reason
  // investorKeyFor exists.
  eq('A1 the real Fidelis label folds onto the seeded key', send.investorKeyFor('Fidelis Investors LLC'), 'fidelis');
  eq('A2 the short label keys the same way', send.investorKeyFor('Fidelis'), 'fidelis');
  eq('A3 spacing and casing do not matter', send.investorKeyFor('  fidelis   investors  '), 'fidelis');
  eq('A4 a different buyer keeps its own exact key', send.investorKeyFor('Blue Lake'), 'bluelake');
  eq('A5 a blank note buyer has no key', send.investorKeyFor(''), null);
  ok('A6 a look-alike buyer is NOT folded into Fidelis', send.investorKeyFor('Fidelity National') !== 'fidelis');

  const fidelis = await send.contactsForNoteBuyer('Fidelis Investors LLC');
  const fidelisAddrs = fidelis.map((c) => c.email).sort();
  eq('A7 the three seeded Fidelis contacts are found from the real label', fidelisAddrs,
    ['cquintano@fidelis-investors.com', 'drawrequest@fidelis-investors.com', 'jcarara@fidelis-investors.com']);
  eq('A8 a buyer with nothing saved returns an empty list', (await send.contactsForNoteBuyer('Nobody Capital')).length, 0);

  // ================================================================ B. blockers on the real tables
  let p = await send.deliveryPreview(app, DRAW);
  eq('B1 the note buyer is read off the file', p.note_buyer, 'Fidelis Investors LLC');
  eq('B2 the seeded contacts resolve for this file', p.contacts.length, 3);
  ok('B3 a draw the borrower has not answered cannot be sent', p.can_send === false);
  ok('B4 and it says the borrower has not agreed', p.blockers.some((b) => /not agreed/.test(b)));

  await db.query(`UPDATE draw_findings SET status='disputed', disputed_at=now() WHERE id=$1`, [fid]);
  p = await send.deliveryPreview(app, DRAW);
  ok('B5 an open dispute blocks the send', p.can_send === false);
  ok('B6 and it says to decide the disputed lines first', p.blockers.some((b) => /pushed back/.test(b)));

  // ================================================================ C. the borrower's agreement
  await db.query(`UPDATE draw_findings SET status='accepted', accepted_at=now(), accepted_via='staff', accepted_note='approved by phone' WHERE id=$1`, [fid]);
  p = await send.deliveryPreview(app, DRAW);
  eq('C1 a staff-recorded agreement is a real acceptance', p.finding_status, 'accepted');
  eq('C2 and the file records HOW it arrived', p.accepted_via, 'staff');
  ok('C3 an agreed draw with contacts can be sent', p.can_send === true);
  eq('C4 nothing is blocking it', p.blockers.length, 0);

  // the database itself must accept 'staff' as a via (db/454 widened the CHECK)
  let viaOk = true;
  try { await db.query(`UPDATE draw_findings SET accepted_via='staff' WHERE id=$1`, [fid]); } catch (_) { viaOk = false; }
  ok('C5 the database accepts a staff-recorded acceptance', viaOk);
  let viaBad = false;
  try { await db.query(`UPDATE draw_findings SET accepted_via='carrier pigeon' WHERE id=$1`, [fid]); viaBad = true; } catch (_) {}
  ok('C6 and still refuses an unknown one', viaBad === false);
  await db.query(`UPDATE draw_findings SET accepted_via='staff' WHERE id=$1`, [fid]);

  // ================================================================ D. the money agrees with the report
  // The preview must quote the SAME figures the rollup (and therefore the report and the Excel
  // packet) were built from — never re-derived here.
  const rollupMod = require('../src/sitewire/rollup');
  const rl = await rollupMod.loadRollup(db, app);
  const d = (rl.draws || []).find((x) => Number(x.sitewire_draw_id) === Number(DRAW));
  eq('D1 the preview approved figure matches the rollup', p.money.approved_cents, Number(d.approved_cents));
  eq('D2 the borrower net matches the rollup net release', p.money.to_borrower_cents, Number(d.net_release_cents));
  eq('D3 the investor funds the full approved amount', p.money.investor_total_cents, Number(d.approved_cents));
  eq('D4 our side is exactly the approved amount less the borrower net',
    p.money.to_us_cents, Number(d.approved_cents) - Number(d.net_release_cents));
  ok('D5 the file resolved a real draw fee before any release was recorded', p.money.fee_cents > 0);

  // ================================================================ E. the funding mode, three sources
  // The DEFAULT is investor_direct (owner-directed 2026-08-05).
  eq('E1 with nothing set the mode is investor_direct', p.funding_mode, 'investor_direct');
  eq('E2 and it says that came from the default', p.funding_mode_source, 'default');

  await db.query(`UPDATE sitewire_property_links SET investor_funding_mode='investor_direct' WHERE application_id=$1`, [app]);
  p = await send.deliveryPreview(app, DRAW);
  eq('E3 the file default takes effect', p.funding_mode, 'investor_direct');
  eq('E4 and is reported as the file default', p.funding_mode_source, 'file');

  await db.query(`UPDATE draw_findings SET funding_mode='reimbursement' WHERE id=$1`, [fid]);
  p = await send.deliveryPreview(app, DRAW);
  eq('E5 the per-draw choice beats the file default', p.funding_mode, 'reimbursement');
  eq('E6 and is reported as the draw choice', p.funding_mode_source, 'draw');

  let badMode = false;
  try { await db.query(`UPDATE draw_findings SET funding_mode='whatever' WHERE id=$1`, [fid]); badMode = true; } catch (_) {}
  ok('E7 the database refuses an unknown funding mode', badMode === false);

  // ================================================================ F. recipients — the borrower is never on it
  p = await send.deliveryPreview(app, DRAW);
  eq('F1 the three investor contacts are the recipients', p.to.length, 3);
  ok('F2 the shared draw desk is copied', p.cc.includes('draws@yscapgroup.com'));
  ok('F3 THE BORROWER IS NOT A RECIPIENT', !p.to.includes(email.toLowerCase()));
  ok('F4 THE BORROWER IS NOT COPIED', !p.cc.includes(email.toLowerCase()));

  // Now the nastiest real-world case: the borrower's own address saved as an investor contact.
  await db.query(
    `INSERT INTO investor_delivery_contacts(label_norm,label,email,role) VALUES('fidelis','Fidelis',$1,'typo')
     ON CONFLICT (label_norm, lower(email)) DO UPDATE SET active=true`, [email]);
  p = await send.deliveryPreview(app, DRAW);
  ok('F5 a borrower address saved as an investor contact is still never mailed', !p.to.includes(email.toLowerCase()));
  ok('F6 nor copied', !p.cc.includes(email.toLowerCase()));
  eq('F7 the other three contacts still go out', p.to.length, 3);
  await db.query(`DELETE FROM investor_delivery_contacts WHERE label_norm='fidelis' AND lower(email)=lower($1)`, [email]);

  // ================================================================ G. attachments — nothing silently dropped
  // Gathered in INVESTOR_DIRECT mode, where the borrower's signed wire form applies
  // (the investor releases straight to the borrower and needs it) — so a missing one
  // is reported rather than swallowed. The reimbursement mode (no wire form) is
  // covered by I14.
  const g = await send.gatherAttachments(app, DRAW, 'investor_direct');
  const skippedWhat = g.skipped.map((s) => s.what);
  ok('G1 the missing inspector report is reported, not swallowed', skippedWhat.some((w) => /Inspection report/.test(w)));
  ok('G2 the missing signed wire form is reported', skippedWhat.some((w) => /wire instructions/i.test(w)));
  ok('G3 every skip carries a plain reason', g.skipped.every((s) => s.reason && s.reason.length > 5));
  ok('G4 the Excel draw packet is built and attached', g.items.some((i) => /packet/i.test(i.what) && i.filename.endsWith('.xlsx')));
  ok('G5 the packet has real bytes', g.items.filter((i) => /packet/i.test(i.what)).every((i) => i.buf && i.buf.length > 100));
  ok('G6 our own draw report is attached', g.items.some((i) => /PILOT draw report/.test(i.what)));
  ok('G7 nothing lands in both lists', g.items.every((i) => !skippedWhat.includes(i.what)));

  // ================================================================ H. the delivery record
  // Recorded with the mode, the three figures and who it went to, so a delivery is reconcilable.
  const money = ID.investorMoney(p.money, 'reimbursement');
  const rec = (await db.query(
    `INSERT INTO draw_investor_deliveries(application_id,sitewire_draw_id,funding_mode,note_buyer_label,note_buyer_key,
        requested_cents,approved_cents,fee_cents,retainage_held_cents,to_borrower_cents,to_us_cents,investor_total_cents,
        to_emails,cc_emails,attachments,skipped,status)
     VALUES($1,$2,'reimbursement','Fidelis Investors LLC','fidelis',$3,$4,$5,$6,$7,$8,$9,
        '["a@b.com"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'sent') RETURNING id`,
    [app, DRAW, money.requested_cents, money.approved_cents, money.fee_cents, money.retainage_held_cents,
      money.to_borrower_cents, money.to_us_cents, money.investor_total_cents])).rows[0];
  ok('H1 a delivery is recorded', !!rec.id);
  const back = (await db.query(`SELECT * FROM draw_investor_deliveries WHERE id=$1`, [rec.id])).rows[0];
  eq('H2 the three figures reconcile on the record',
    Number(back.to_borrower_cents) + Number(back.to_us_cents), Number(back.investor_total_cents));
  const p2 = await send.deliveryPreview(app, DRAW);
  eq('H3 the delivery shows in the file history', p2.history.length, 1);
  eq('H4 the history names the mode', p2.history[0].funding_mode, 'reimbursement');

  let badStatus = false;
  try { await db.query(`UPDATE draw_investor_deliveries SET status='maybe' WHERE id=$1`, [rec.id]); badStatus = true; } catch (_) {}
  ok('H5 the record refuses an unknown status', badStatus === false);

  // ================================================================ I. the REAL send, end to end
  // This exercises sendInvestorDelivery itself — the wording, the template render, the provider
  // call and the record write. The first cut of this module passed template.render()'s RETURN
  // OBJECT to sendMail as if it were an HTML string; every unit test still passed because none of
  // them ever called the send. This section is the one that catches that class.
  // Capture what is actually handed to the mail provider. Asserting on the RETURN VALUE alone is
  // not enough: the 'none' provider accepts anything, so a malformed body sails through it — which
  // is exactly how the render-object bug survived its first test. These assertions read the wire
  // payload itself.
  const mailer = require('../src/lib/email');
  const realSend = mailer.sendMail;
  const outbox = [];
  mailer.sendMail = async (m) => { outbox.push(m); return { ok: true, id: 'test' }; };

  const sent = await send.sendInvestorDelivery(app, DRAW, { staffId: null, staffName: 'Lisa Katz', mode: 'reimbursement' });
  ok('I1 the send completes and returns a record id', !!sent.id);
  eq('I2 it went out under the mode asked for', sent.funding_mode, 'reimbursement');
  eq('I3 the three investor contacts received it', sent.to.length, 3);
  ok('I4 the draw desk was copied', sent.cc.includes('draws@yscapgroup.com'));
  ok('I5 THE BORROWER WAS NOT ON IT', ![...sent.to, ...sent.cc].includes(email.toLowerCase()));
  ok('I6 documents were attached', sent.attachments.length >= 1);
  ok('I7 whatever could not be attached is reported back', Array.isArray(sent.skipped));
  eq('I8 the money on the record reconciles',
    sent.money.to_borrower_cents + sent.money.to_us_cents, sent.money.investor_total_cents);

  // ---- the wire payload itself ----
  const msg = outbox[0] || {};
  eq('I8a exactly one email was sent', outbox.length, 1);
  eq('I8b the HTML body is a STRING, not an object', typeof msg.html, 'string');
  eq('I8c the plain-text alternative is a string too', typeof msg.text, 'string');
  ok('I8d the HTML is a real rendered document', /<html|<table|<div/i.test(String(msg.html)));
  ok('I8e nothing rendered as [object Object]', !/\[object Object\]/.test(String(msg.html) + String(msg.text)));
  // "Draw 1", not "Draw #1" — the owner's own wording (2026-08-09), and the SAME label every other
  // draw email leads its subject with, so an investor's inbox reads like ours.
  ok('I8f the subject names the draw and the property', /\bDraw 1\b/.test(msg.subject) && /Parrish/.test(msg.subject));
  ok('I8f2 …and never the old "Draw #1" form', !/Draw\s*#/.test(String(msg.subject)));
  ok('I8g it comes from the draw desk', /draws@yscapgroup\.com/.test(String(msg.from)));
  ok('I8h replies go to the draw desk', /draws@yscapgroup\.com/.test(String(msg.replyTo)));
  ok('I8i the borrower is not on the actual message', !JSON.stringify([msg.to, msg.cc, msg.bcc]).toLowerCase().includes(email.toLowerCase()));
  ok('I8j the money is stated in the body', /25,000/.test(String(msg.text)) && /24,701/.test(String(msg.text)));
  ok('I8k the ask is in the body', /reimburse/i.test(String(msg.text)));
  ok('I8l every attachment is base64 content with a filename',
    (msg.attachments || []).every((a) => a.filename && typeof a.content === 'string' && a.content.length > 0));
  ok('I8m the coordinator signs it', /Lisa Katz/.test(String(msg.text)));

  const stored = (await db.query(`SELECT * FROM draw_investor_deliveries WHERE id=$1`, [sent.id])).rows[0];
  eq('I9 the delivery is stored as sent', stored.status, 'sent');
  eq('I10 the stored recipients are the ones that were mailed', stored.to_emails.length, 3);
  eq('I11 the stored note buyer is the file\'s own label', stored.note_buyer_label, 'Fidelis Investors LLC');
  eq('I12 stored under the folded Fidelis key', stored.note_buyer_key, 'fidelis');
  ok('I13 the attachment manifest is stored', Array.isArray(stored.attachments) && stored.attachments.length >= 1);
  // REIMBURSEMENT never attaches (or even attempts) the borrower's signed wire form —
  // we already wired the borrower, the investor is only paying us back (owner-directed
  // 2026-08-05). So the wire form is neither an attachment nor a "couldn't attach" note.
  ok('I14 reimbursement neither attaches nor attempts the borrower wire form',
    !sent.skipped.some((s) => /wire/i.test(JSON.stringify(s)))
    && !(msg.attachments || []).some((a) => /wire/i.test(String(a.filename || ''))));

  // A second send is a second row — the investor genuinely received two emails.
  const again = await send.sendInvestorDelivery(app, DRAW, { staffId: null, staffName: 'Lisa Katz' });
  ok('I14 a re-send is recorded separately, never overwritten', again.id !== sent.id);
  const p3 = await send.deliveryPreview(app, DRAW);
  ok('I15 both deliveries show in the history', p3.history.length >= 2);

  // And it REFUSES when the borrower has not agreed — re-checked at send time, not trusted from
  // the preview the screen fetched earlier.
  await db.query(`UPDATE draw_findings SET status='delivered', accepted_at=NULL, accepted_via=NULL WHERE id=$1`, [fid]);
  let refused = false, refusedMsg = '';
  try { await send.sendInvestorDelivery(app, DRAW, {}); } catch (e) { refused = true; refusedMsg = e.message; }
  ok('I16 a draw the borrower has not agreed to is refused at send time', refused);
  ok('I17 and the refusal says why', /not agreed/.test(refusedMsg));
  eq('I18 a refused delivery sends nothing at all', outbox.length, 2);   // the two successful sends only

  // ================================================================ J. the MANUAL mode (#11)
  // A manual delivery is handled outside PILOT: it RECORDS the delivery (so the reminders stop) and
  // sends NO email. db/474 widened the funding_mode CHECK on all three tables to allow 'manual'.
  await db.query(`UPDATE draw_findings SET status='accepted', accepted_at=now(), accepted_via='portal', funding_mode='manual' WHERE id=$1`, [fid]);
  const outboxBefore = outbox.length;   // 2 (the two successful emailed sends)
  const man = await send.sendInvestorDelivery(app, DRAW, { staffId: null, staffName: 'Lisa Katz', mode: 'manual', note: 'Delivered through the Fidelis portal' });
  ok('J1 the manual delivery is recorded', !!man.id);
  eq('J2 it is recorded as the manual mode', man.funding_mode, 'manual');
  ok('J3 the response marks it manual', man.manual === true);
  eq('J4 NO email was sent (the outbox is unchanged)', outbox.length, outboxBefore);
  eq('J5 no recipients on a manual delivery', [man.to.length, man.cc.length], [0, 0]);
  eq('J6 no attachments on a manual delivery', man.attachments.length, 0);
  const mrow = (await db.query(`SELECT * FROM draw_investor_deliveries WHERE id=$1`, [man.id])).rows[0];
  eq('J7 the widened CHECK accepted the manual funding_mode', mrow.funding_mode, 'manual');
  eq('J8 the manual delivery is stored as sent (recorded)', mrow.status, 'sent');
  eq('J9 the stored recipients are empty', [mrow.to_emails.length, mrow.cc_emails.length], [0, 0]);
  eq('J10 the manual note is stored', mrow.note, 'Delivered through the Fidelis portal');
  eq('J11 the money figures are still recorded',
    Number(mrow.to_borrower_cents) + Number(mrow.to_us_cents), Number(mrow.investor_total_cents));
  eq('J12 the per-draw funding-mode choice accepts manual',
    (await db.query(`SELECT funding_mode FROM draw_findings WHERE id=$1`, [fid])).rows[0].funding_mode, 'manual');
  await db.query(`UPDATE sitewire_property_links SET investor_funding_mode='manual' WHERE application_id=$1 AND matched_by='created'`, [app]);
  eq('J13 the file default accepts manual',
    (await db.query(`SELECT investor_funding_mode FROM sitewire_property_links WHERE application_id=$1 AND matched_by='created'`, [app])).rows[0].investor_funding_mode, 'manual');

  // Reminder gating: withInvestorOnce (7b, "chase the investor") EXCLUDES a draw whose latest
  // delivery is MANUAL; an emailed one past +48h is still due. Two raw rows (no FK on
  // sitewire_draw_id), both older than 48h, exercise the exact latest-per-draw + manual-exclusion
  // predicate the digest query uses.
  await db.query(
    `INSERT INTO draw_investor_deliveries (application_id, sitewire_draw_id, funding_mode, status, sent_at) VALUES
       ($1, 90001, 'manual',        'sent', now() - interval '3 days'),
       ($1, 90002, 'reimbursement', 'sent', now() - interval '3 days')`, [app]);
  const remind = (await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (dd.sitewire_draw_id) dd.sitewire_draw_id, dd.sent_at AS last_send, dd.funding_mode
         FROM draw_investor_deliveries dd
        WHERE dd.status='sent' AND dd.application_id=$1 AND dd.sitewire_draw_id IN (90001, 90002)
        ORDER BY dd.sitewire_draw_id, dd.sent_at DESC)
     SELECT count(*) FILTER (WHERE funding_mode <> 'manual' AND last_send < now() - interval '48 hours')::int AS due,
            count(*) FILTER (WHERE funding_mode = 'manual')::int AS manual_count
       FROM latest`, [app])).rows[0];
  eq('J14 the emailed delivery past +48h IS due for the reminder', remind.due, 1);
  eq('J15 the manual delivery is present but NOT nagged', [remind.manual_count, remind.due], [1, 1]);

  mailer.sendMail = realSend;

  // ================================================================ K. the WIRE FORM gate (Task 4)
  // The signed wire form must be ACCEPTED before an emailed delivery can go out — the investor
  // wires the borrower off it (investor_direct), or we did (reimbursement). We reset to an agreed,
  // investor_direct draw and walk the wire form through every review state.
  await db.query(`UPDATE draw_findings SET status='accepted', accepted_at=now(), accepted_via='portal', funding_mode='investor_direct' WHERE id=$1`, [fid]);
  await db.query(`UPDATE sitewire_property_links SET investor_funding_mode='investor_direct' WHERE application_id=$1 AND matched_by='created'`, [app]);

  // accepted (the fixture state) → the gate is clear
  let pk = await send.deliveryPreview(app, DRAW);
  eq('K1 wireFormStatus reads the accepted form', pk.wire_form, { present: true, accepted: true, rejectedOnly: false });
  ok('K2 an accepted wire form does not block the delivery', !pk.blockers.some((b) => /wire form/.test(b)));

  // pending → blocked, and the wording says to accept the correct version
  await db.query(`UPDATE documents SET review_status='pending' WHERE id=$1`, [wireDoc]);
  pk = await send.deliveryPreview(app, DRAW);
  ok('K3 a pending wire form blocks the send', pk.can_send === false);
  ok('K4 and says to review and accept the correct version', pk.blockers.some((b) => /wire form has not been accepted/.test(b)));

  // rejected only → blocked, says the borrower must re-sign
  await db.query(`UPDATE documents SET review_status='rejected' WHERE id=$1`, [wireDoc]);
  pk = await send.deliveryPreview(app, DRAW);
  ok('K5 a rejected-only wire form blocks the send', pk.blockers.some((b) => /wire form was rejected/.test(b)));
  eq('K6 the wire form status reports rejected-only', pk.wire_form, { present: true, accepted: false, rejectedOnly: true });

  // no wire form at all → blocked, says the borrower must sign
  await db.query(`UPDATE documents SET is_current=false WHERE id=$1`, [wireDoc]);
  pk = await send.deliveryPreview(app, DRAW);
  ok('K7 no wire form present blocks the send', pk.blockers.some((b) => /has not signed the wire/.test(b)));
  eq('K8 the wire form status reports absent', pk.wire_form, { present: false, accepted: false, rejectedOnly: false });

  // the SAME missing wire form does NOT block a MANUAL delivery (handled outside PILOT)
  await db.query(`UPDATE draw_findings SET funding_mode='manual' WHERE id=$1`, [fid]);
  pk = await send.deliveryPreview(app, DRAW);
  ok('K9 a MANUAL delivery is not gated on the wire form', !pk.blockers.some((b) => /wire/.test(b)));
  await db.query(`UPDATE draw_findings SET funding_mode='investor_direct' WHERE id=$1`, [fid]);

  // accept it again → clear, and a real send goes through (proving the gate is the only thing that was holding it)
  await db.query(`UPDATE documents SET is_current=true, review_status='accepted' WHERE id=$1`, [wireDoc]);
  pk = await send.deliveryPreview(app, DRAW);
  ok('K10 re-accepting the wire form clears the gate', pk.wire_form.accepted === true && !pk.blockers.some((b) => /wire/.test(b)));

  // send-time RE-CHECK: flip to pending after the preview and confirm the send itself refuses.
  const outbox2 = [];
  mailer.sendMail = async (m) => { outbox2.push(m); return { ok: true, id: 'test' }; };
  await db.query(`UPDATE documents SET review_status='pending' WHERE id=$1`, [wireDoc]);
  let wireRefused = false, wireMsg = '';
  try { await send.sendInvestorDelivery(app, DRAW, { mode: 'investor_direct' }); } catch (e) { wireRefused = true; wireMsg = e.message; }
  ok('K11 the send itself refuses an unaccepted wire form (re-checked at send time)', wireRefused);
  ok('K12 and says why', /wire form/.test(wireMsg));
  eq('K13 a wire-blocked delivery sends nothing', outbox2.length, 0);
  mailer.sendMail = realSend;

  // ================================================================ L. the wire-recipient OA rides investor_direct only (Task 5)
  // When the wire goes to a NEW entity, its accepted operating agreement is attached to an
  // investor_direct delivery (the investor confirms the entity before wiring it) and NOT to a
  // reimbursement one (we already wired — the investor is only paying us back).
  const storage2 = require('../src/lib/storage');
  await drawWire.raiseOperatingAgreementCondition(db, app, 'New Entity Holdings LLC');
  await db.query(
    `INSERT INTO draw_wire_instructions(application_id,account_name,name_kind,name_matches,captured_at)
     VALUES($1,'New Entity Holdings LLC','new_entity',false,now())
     ON CONFLICT (application_id) DO UPDATE SET account_name=EXCLUDED.account_name`, [app]);
  const oaItem = (await db.query(`SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2`, [app, `draw:wire_oa:${app}`])).rows[0].id;
  const savedOa = await storage2.save(Buffer.from('OPERATING-AGREEMENT-BYTES-FOR-INVESTOR'), { filename: 'oa.pdf' });
  await db.query(
    `INSERT INTO documents(application_id,checklist_item_id,filename,storage_provider,storage_ref,review_status,is_current,source_type,visibility)
     VALUES($1,$2,'operating-agreement.pdf',$3,$4,'accepted',true,'system','borrower')`, [app, oaItem, savedOa.provider, savedOa.ref]);

  const gInv = await send.gatherAttachments(app, DRAW, 'investor_direct');
  ok('L1 the wire-recipient OA rides an investor_direct delivery', gInv.items.some((i) => /Operating agreement/i.test(i.what)));
  const gReim = await send.gatherAttachments(app, DRAW, 'reimbursement');
  ok('L2 the OA is NOT attached on a reimbursement delivery',
    !gReim.items.some((i) => /Operating agreement/i.test(i.what)) && !gReim.skipped.some((s) => /Operating agreement/i.test(s.what)));
  try { await storage2.remove(savedOa.ref); } catch (_) {}

  // ================================================================ cleanup
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  await db.query(`DELETE FROM sitewire_draws WHERE sitewire_draw_id=$1`, [DRAW]);
  await db.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [DRAW]);

  console.log(`test-investor-delivery-db: ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await db.pool.end(); } catch (_) {} process.exit(1); });

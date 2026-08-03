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
  eq('E1 with nothing set the mode is reimbursement', p.funding_mode, 'reimbursement');
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
  const g = await send.gatherAttachments(app, DRAW);
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
  ok('I8f the subject names the draw and the property', /Draw #1/.test(msg.subject) && /Parrish/.test(msg.subject));
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
  mailer.sendMail = realSend;

  // ================================================================ cleanup
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  await db.query(`DELETE FROM sitewire_draws WHERE sitewire_draw_id=$1`, [DRAW]);
  await db.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [DRAW]);

  console.log(`test-investor-delivery-db: ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await db.pool.end(); } catch (_) {} process.exit(1); });

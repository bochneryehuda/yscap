'use strict';
/**
 * THE REPORTED BUG, END TO END, AGAINST A REAL DATABASE AND A REAL MAIL PAYLOAD.
 *
 * On 2026-08-14 an investor delivery went out carrying only its two smallest documents. This drives
 * the real `sendInvestorDelivery` with a real oversized attachment and asserts the three things
 * the owner asked for, in order:
 *
 *   A. IT ARRIVES. The document that used to be dropped is COMPRESSED and attached — the foundation
 *      fix, and the reason the consent gate should almost never be seen in practice.
 *   B. IF IT STILL CANNOT ARRIVE, THE SEND REFUSES and says exactly what and why. Nothing is
 *      ignored blindly; sending short takes an explicit acknowledgement, and that is recorded.
 *   C. A PILOT LINK IS THE WAY THROUGH, and the document then travels as a URL in the email.
 *
 * Every assertion reads the WIRE PAYLOAD handed to the mail provider, not the return value. The
 * repo has already been bitten once by a send that "passed" because the noop provider accepts
 * anything (test-investor-delivery-db section I) — a plan that says a document is attached proves
 * nothing about whether the bytes reached the message.
 *
 * DB-gated: skips cleanly without DATABASE_URL.
 */
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL ${n}`); } };
const eq = (n, got, exp) => ok(`${n} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(exp));

if (!process.env.DATABASE_URL) { console.log('SKIP test-investor-delivery-oversized-db (no DATABASE_URL)'); process.exit(0); }

const crypto = require('crypto');
const jpeg = require('jpeg-js');
const db = require('../src/db');
const DA = require('../src/sitewire/draw-attachments');
const send = require('../src/sitewire/investor-delivery-send');
const mailer = require('../src/lib/email');

/** A big, genuinely photographic JPEG — noise and gradients, so it compresses like a real photo. */
function bigPhoto(w, h) {
  const d = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    d[i * 4] = (x * 3 + ((Math.sin(x * 0.05) * 50) | 0)) & 255;
    d[i * 4 + 1] = (y * 3 + ((Math.cos(y * 0.04) * 50) | 0)) & 255;
    d[i * 4 + 2] = ((x * y) >> 3) & 255;
    d[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data: d, width: w, height: h }, 94).data);
}

(async () => {
  // The smallest budget the delivery allows, so the fixture does not have to build 20 MB of photos.
  process.env.INVESTOR_ATTACH_BUDGET_MB = '1';

  const email = 'ov' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Oversize','Test',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'OV' + crypto.randomBytes(3).toString('hex');
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address,rehab_budget)
     VALUES($1,'funded',$2,'Fidelis Investors LLC','{"oneLine":"392-394 Columbia Ave, Rochester, NY 14611"}',250000) RETURNING id`,
    [bor, loan])).rows[0].id;
  const BASE = 940000 + crypto.randomBytes(2).readUInt16BE(0) * 10;
  const DRAW = BASE;
  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at,investor_funding_mode) VALUES($1,$2,'created','live',now(),'reimbursement')`, [app, BASE + 2]);
  await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES($1,$2,2,'approved',2500000,2500000)`, [app, DRAW]);
  await db.query(
    `INSERT INTO draw_findings(application_id,sitewire_draw_id,status,accepted_at,accepted_via,reply_token)
     VALUES($1,$2,'accepted',now(),'portal',$3)`, [app, DRAW, crypto.randomBytes(16).toString('hex')]);
  await db.query(
    `INSERT INTO investor_delivery_contacts(label_norm,label,email,name,active)
     VALUES('fidelis','Fidelis Investors LLC','cquintano@fidelis-investors.com','C Quintano',true)
     ON CONFLICT (label_norm, lower(email)) DO UPDATE SET active=true`);

  // The signed wire form the money gate requires (its own rule, unrelated to attachments — see
  // test-investor-delivery-db section K, which owns that behaviour).
  await db.query(
    `INSERT INTO documents(application_id,filename,content_type,size_bytes,storage_provider,storage_ref,
        uploaded_by_kind,doc_kind,source_type,visibility,is_current,review_status)
     VALUES($1,'wire-instructions-signed.pdf','application/pdf',9,'local','none/x','staff',
        'draw_request_signed','system','staff_only',true,'accepted')`, [app]);

  // The inspector's own archived report — the document the reported email was missing. It is here
  // so section A can assert that NOTHING is dropped, which is the whole claim being made.
  {
    const storage = require('../src/lib/storage');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3000, 0x20), Buffer.from('\n%%EOF\n')]);
    const s = await storage.save(pdf, { filename: 'inspection.pdf' });
    await db.query(
      `INSERT INTO draw_media(application_id,sitewire_draw_id,kind,source_url,source_key,storage_provider,storage_ref,content_type,bytes)
       VALUES($1,$2,'draw_pdf','https://example.test/insp.pdf',$3,$4,$5,'application/pdf',$6)`,
      [app, DRAW, crypto.randomBytes(16).toString('hex'), s.provider, s.ref, pdf.length]);
  }

  // A real oversized supporting document on the draw — the invoice photo a coordinator files as
  // proof behind an override. Staff upload, so it is born ACCEPTED and is allowed to travel.
  const photo = bigPhoto(2600, 1950);
  const att = await DA.attach(app, { sitewireDrawId: String(DRAW) },
    [{ filename: 'roof-invoice-photo.jpg', dataBase64: photo.toString('base64'), category: 'invoice' }],
    { by: { kind: 'staff', id: null } });
  eq('fixture: the oversized photo is attached to the draw', att.added.length, 1);
  const stored = att.added[0].size_bytes;
  ok(`fixture: it is genuinely bigger than the whole email budget (${Math.round(stored / 1024)} KB vs 1024 KB)`, stored > 1024 * 1024);

  // STUB THE PROVIDER, NOT THE CHOKEPOINT. Replacing `email.sendMail` would skip the very code
  // under test — the chokepoint is where the attachment audit is written and the [email-attach]
  // line is printed, so stubbing it would let a broken audit pass. `provider.sendMail` is looked up
  // at call time, so patching the noop provider leaves the whole real path running and still gives
  // us the wire payload.
  const noop = require('../src/lib/email/noop');
  const realProviderSend = noop.sendMail;
  let outbox = [];
  noop.sendMail = async (m) => { outbox.push(m); return { ok: true, id: 'test' }; };
  void mailer;

  try {
    console.log('\n== A. THE FOUNDATION FIX — the oversized document now ARRIVES ==');
    const sent = await send.sendInvestorDelivery(app, DRAW, {
      staffId: null, staffName: 'Lisa Katz', mode: 'reimbursement',
      // Deliberately NOT acknowledging anything. If compression does its job this is never needed —
      // which is the entire point of "make sure the foundation is correct, and usually it's always
      // going to be attached".
    });
    eq('A1 the send went through with no acknowledgement needed', outbox.length, 1);
    const msg = outbox[0];
    const names = (msg.attachments || []).map((a) => a.filename);
    ok(`A2 the oversized photo is ON THE EMAIL (${names.join(', ')})`, names.some((n) => /roof-invoice-photo/.test(n)));
    ok('A3 it got there by being compressed', sent.plan.compressed_n >= 1 && sent.plan.saved_bytes > 0);
    eq('A4 and nothing at all was dropped', sent.plan.omitted.length, 0);
    const wireBytes = (msg.attachments || []).reduce((n, a) => n + Math.round(String(a.content).length * 0.75), 0);
    ok(`A5 the message really is inside the budget (${Math.round(wireBytes / 1024)} KB)`, wireBytes <= 1024 * 1024);
    const compressed = sent.attachments.find((a) => /roof-invoice-photo/.test(a.filename));
    ok(`A6 the record says what was done to it (level ${compressed.compression && compressed.compression.level}: ${Math.round(compressed.compression.before / 1024)} KB -> ${Math.round(compressed.compression.after / 1024)} KB)`,
      compressed.compression && compressed.compression.after < compressed.compression.before);

    console.log('\n== the audit records it, where every email in the system records it ==');
    const logged = (await db.query(
      `SELECT attach_summary, omitted FROM email_messages
        WHERE application_id=$1 AND msg_type='draw_investor_delivery' ORDER BY occurred_at DESC LIMIT 1`, [app])).rows[0];
    ok('the email_messages row carries the attachment summary', !!(logged && logged.attach_summary));
    ok('naming how many were compressed and how much was saved',
      logged.attach_summary.compressed_n >= 1 && logged.attach_summary.saved_bytes > 0);
    eq('and nothing omitted, so no consent was recorded', logged.omitted, null);

    console.log('\n== B. WHEN IT STILL CANNOT FIT — refuse, explain, and require consent ==');
    // A document the compressor genuinely CANNOT help with: a large PDF whose body is
    // incompressible noise and which carries no embedded images to downsample. (A photo will not
    // do here — the compressor is good enough that even a 4200x3200 one fits, which is the point of
    // section A.) This is the real-world case of a scanned package the engine cannot shrink.
    const stubborn = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      crypto.randomBytes(2 * 1024 * 1024),
      Buffer.from('\n%%EOF\n'),
    ]);
    await DA.attach(app, { sitewireDrawId: String(DRAW) },
      [{ filename: 'scanned-package.pdf', dataBase64: stubborn.toString('base64'), category: 'other' }],
      { by: { kind: 'staff', id: null } });
    outbox = [];
    let gate = null;
    try { await send.sendInvestorDelivery(app, DRAW, { staffName: 'Lisa Katz', mode: 'reimbursement' }); }
    catch (e) { gate = e; }
    ok('B1 the send REFUSES rather than quietly going short', !!gate && gate.status === 409);
    eq('B2 with a code the desk branches on', gate && gate.code, 'attachments_incomplete');
    eq('B3 and it sent nothing', outbox.length, 0);
    const miss = gate.plan.omitted[0];
    ok(`B4 the omission names the document ("${miss.what}")`, !!miss.what);
    ok(`B5 says why, with the real sizes ("${String(miss.reason).slice(0, 80)}…")`, /KB|MB/.test(miss.reason));
    ok('B6 says it was already compressed and still would not fit', miss.code === 'too_large_after_compression' || miss.code === 'too_large');
    eq('B7 and offers the remedy', miss.remedy, 'share_link');
    ok('B8 the double warning rides with the refusal', gate.linkWarnings.length === 2);

    console.log('\n== …and an explicit acknowledgement sends it, on the record ==');
    const short = await send.sendInvestorDelivery(app, DRAW, {
      staffId: null, staffName: 'Lisa Katz', mode: 'reimbursement', acknowledgeOmissions: true,
    });
    eq('B9 it goes when the coordinator says so', outbox.length, 1);
    ok('B10 the delivery row records what did not travel', short.skipped.length >= 1 && short.skipped[0].code);
    const shortLog = (await db.query(
      `SELECT omitted, attach_summary FROM email_messages
        WHERE application_id=$1 AND msg_type='draw_investor_delivery' ORDER BY occurred_at DESC LIMIT 1`, [app])).rows[0];
    ok('B11 the audit log records the omission with its code', shortLog.omitted && shortLog.omitted.length >= 1 && shortLog.omitted[0].code);
    ok('B12 …and WHO knowingly sent it short, and when — "it should not be ignored blindly"',
      shortLog.attach_summary.consent && shortLog.attach_summary.consent.name === 'Lisa Katz' && !!shortLog.attach_summary.consent.at);
    ok('B13 the email itself never apologises to the investor for our plumbing',
      !/not attached|could not be attached|send it separately/i.test(String(outbox[0].html)));

    console.log('\n== C. THE PILOT LINK — the document travels as a URL instead ==');
    outbox = [];
    const linked = await send.sendInvestorDelivery(app, DRAW, {
      staffId: null, staffName: 'Lisa Katz', mode: 'reimbursement',
      shareLinkKeys: gate.plan.omitted.map((m) => m.key),
    });
    eq('C1 no acknowledgement was needed once it travels as a link', outbox.length, 1);
    ok('C2 a link was minted', linked.links.length >= 1 && /\/d\/[0-9a-f]{32}$/.test(linked.links[0].url));
    ok('C3 the link is IN the email body', String(outbox[0].html).includes(linked.links[0].url));
    ok('C4 the email tells the reader why there is a link at all',
      /too large to attach/i.test(String(outbox[0].text || '') + String(outbox[0].html)));
    ok('C5 the link has an expiry', !!linked.links[0].expiresAt);
    const row = (await db.query(`SELECT * FROM document_share_links WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [app])).rows[0];
    eq('C6 it is recorded against the file, so it can be audited and revoked', row.purpose, 'investor_delivery');
    eq('C7 nothing was omitted once it had a link', linked.plan.omitted.length, 0);

    console.log('\n== D. preflight looks without touching anything ==');
    outbox = [];
    const linksBefore = (await db.query(`SELECT count(*)::int n FROM document_share_links WHERE application_id=$1`, [app])).rows[0].n;
    const pre = await send.sendInvestorDelivery(app, DRAW, { mode: 'reimbursement', preflight: true, shareLinkKeys: ['x'] });
    ok('D1 it returns the plan', pre.preflight === true && !!pre.plan);
    eq('D2 it sends nothing', outbox.length, 0);
    eq('D3 and mints no link', (await db.query(`SELECT count(*)::int n FROM document_share_links WHERE application_id=$1`, [app])).rows[0].n, linksBefore);
    const deliveries = (await db.query(`SELECT count(*)::int n FROM draw_investor_deliveries WHERE application_id=$1`, [app])).rows[0].n;
    eq('D4 and records no delivery', deliveries, 3);   // A, B(acknowledged) and C only

    // A PREFLIGHT ON A **MANUAL** DELIVERY MUST ALSO WRITE NOTHING. Found by self-review: the
    // manual branch returns early — it composes no email and gathers no documents — and it sat
    // AHEAD of the preflight guard, so asking "what would be attached?" on a manual delivery fell
    // straight into the INSERT and recorded a delivery nobody sent. There is nothing to plan in
    // that mode, so the honest answer is an empty plan and no row.
    const manPre = await send.sendInvestorDelivery(app, DRAW, { mode: 'manual', preflight: true });
    ok('D5 a manual preflight returns an empty plan', manPre.preflight === true && manPre.plan.manual === true && manPre.plan.attach.length === 0);
    ok('D6 …and needs no consent, since nothing is being carried', manPre.plan.needs_consent === false);
    eq('D7 …and RECORDS NOTHING — the bug this pins',
      (await db.query(`SELECT count(*)::int n FROM draw_investor_deliveries WHERE application_id=$1`, [app])).rows[0].n, 3);
    eq('D8 …and sends nothing', outbox.length, 0);
  } finally {
    noop.sendMail = realProviderSend;
    delete process.env.INVESTOR_ATTACH_BUDGET_MB;
  }

  console.log(`\ntest-investor-delivery-oversized-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL', e); process.exit(1); });

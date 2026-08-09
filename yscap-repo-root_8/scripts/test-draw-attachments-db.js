/* SUPPORTING DOCUMENTS ON A DRAW — against a REAL database (owner-directed 2026-08-09:
 * "when we override something, we should be able to add invoices, receipts, or additional photos,
 * and that should also be delivered to the investor on investor delivery").
 *
 * What this proves, all of which lives in SQL, storage or a categorizer:
 *   1. an upload becomes a real `documents` row bound to the draw — born ACCEPTED for staff (so it
 *      can travel without a second human pressing Accept on their own upload) and PENDING for a
 *      borrower (somebody outside the company; a reviewer decides);
 *   2. the type comes from the BYTES — an HTML page renamed .pdf is refused, and nothing is ever
 *      silently dropped: every refusal comes back with a plain reason;
 *   3. GPS is stripped from an attached photo;
 *   4. a duplicate is refused rather than sending the investor two copies of one invoice;
 *   5. it reaches the investor delivery, the branded report and the Excel packet;
 *   6. it files under "Draws" in SharePoint and is EXCLUDED from the investor TPR package;
 *   7. detaching removes the binding and NEVER the bytes.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-draw-attachments-db.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-draw-attachments-db (no DATABASE_URL)');
  process.exit(0);
}

const crypto = require('crypto');
const db = require('../src/db');
const storage = require('../src/lib/storage');
const DA = require('../src/sitewire/draw-attachments');
const tpr = require('../src/lib/tpr-export');
const { buildDrawPacket } = require('../src/sitewire/draw-packet');

const b64 = (buf) => Buffer.from(buf).toString('base64');
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(400, 0x20), Buffer.from('\n%%EOF\n')]);

// A tiny real JPEG carrying an EXIF GPS block, so the strip is proven on actual bytes rather than
// asserted. APP1/Exif with one GPS IFD entry; the decoder only has to find and drop the segment.
function jpegWithGps() {
  const exifBody = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from('MM\0\x2a\0\0\0\x08', 'latin1'),          // big-endian TIFF header
    Buffer.from('\0\x01', 'latin1'),                        // 1 IFD entry
    Buffer.from('\x88\x25\0\x04\0\0\0\x01\0\0\0\x1a', 'latin1'), // GPSInfo tag (0x8825)
    Buffer.from('\0\0\0\0', 'latin1'),                      // next IFD = 0
    Buffer.from('\0\x01\0\x00\0\x01\0\0\0\x01\x4e\0\0\0\0\0\0\0', 'latin1'), // a GPS IFD
  ]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, ((exifBody.length + 2) >> 8) & 0xff, (exifBody.length + 2) & 0xff]),
    exifBody,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),                              // SOI
    app1,
    Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 0x10),   // a quantization table
    Buffer.from([0xff, 0xd9]),                              // EOI
  ]);
}

(async () => {
  const email = 'at' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Attach','Test',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'AT' + crypto.randomBytes(3).toString('hex');
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address,rehab_budget)
     VALUES($1,'funded',$2,'Fidelis Investors LLC','{"oneLine":"12 Test St"}',100000) RETURNING id`, [bor, loan])).rows[0].id;
  const BASE = 930000 + crypto.randomBytes(2).readUInt16BE(0) * 10;
  const DRAW = BASE;
  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at) VALUES($1,$2,'created','live',now())`, [app, BASE + 2]);
  await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES($1,$2,1,'approved',500000,500000)`, [app, DRAW]);

  const ref = { sitewireDrawId: String(DRAW) };

  // ======================================================================
  // 1. A STAFF UPLOAD BECOMES A REAL DOCUMENT, BOUND TO THE DRAW
  // ======================================================================
  {
    const out = await DA.attach(app, ref, [{ filename: 'roof-invoice.pdf', dataBase64: b64(PDF), category: 'invoice', note: 'Acme Roofing' }],
      { by: { kind: 'staff', id: null }, supports: 'Approved $2,400 over requested on the roof line' });
    eq('1a it is attached', out.added.length, 1);
    eq('1b nothing was refused', out.skipped, []);
    const d = (await db.query(`SELECT * FROM documents WHERE id=$1`, [out.added[0].document_id])).rows[0];
    eq('1c the bytes are an ordinary document on the file', [d.application_id, d.doc_kind], [app, 'draw_support']);
    eq('1d a staff upload is born ACCEPTED, so it can travel without a second click', d.review_status, 'accepted');
    eq('1e …and is staff-only', d.visibility, 'staff_only');
    eq('1f the type came from the bytes', d.content_type, 'application/pdf');
    ok('1g the bytes really are stored', !!(await storage.read(d.storage_ref)));
    const rows = await DA.listFor(app, ref);
    eq('1h the draw lists it', rows.length, 1);
    eq('1i …with what it backs up, so the record explains itself', rows[0].supports, 'Approved $2,400 over requested on the roof line');
  }

  // ======================================================================
  // 2. NOTHING IS SILENTLY DROPPED — and the type comes from the BYTES
  // ======================================================================
  {
    const out = await DA.attach(app, ref, [
      { filename: 'invoice.pdf', dataBase64: b64(Buffer.from('<html><body>not a pdf</body></html>')) },
      { filename: 'empty.pdf', dataBase64: '' },
      { filename: 'notes.txt', dataBase64: b64(Buffer.from('just some text')) },
    ], { by: { kind: 'staff', id: null } });
    eq('2a nothing was attached', out.added.length, 0);
    eq('2b every refusal is reported', out.skipped.length, 3);
    ok('2c an HTML page renamed .pdf is refused on its bytes', /not accepted/.test(out.skipped[0].reason));
    // And a client that LIES about the type is not believed either — the sniff must be the only
    // authority, or an HTML page declared "application/pdf" is stored and served back inline.
    const lied = await DA.attach(app, ref, [{ filename: 'real.pdf', contentType: 'application/pdf', dataBase64: b64(Buffer.from('<html>nope</html>')) }], { by: { kind: 'staff', id: null } });
    eq('2c2 a declared content type never overrides the bytes', lied.added.length, 0);
    ok('2d …and every refusal carries a plain reason', out.skipped.every((s) => s.reason && s.reason.length > 5));
    const none = await DA.attach(app, { }, [{ filename: 'x.pdf', dataBase64: b64(PDF) }], {});
    eq('2e an attachment naming no draw is refused, never stored loose', none.added.length, 0);
  }

  // ======================================================================
  // 3. GPS IS STRIPPED FROM AN ATTACHED PHOTO
  // ======================================================================
  {
    const raw = jpegWithGps();
    ok('3a the fixture really does carry an EXIF block', raw.includes(Buffer.from('Exif\0\0', 'latin1')));
    const out = await DA.attach(app, ref, [{ filename: 'site.jpg', dataBase64: b64(raw), category: 'photo' }], { by: { kind: 'staff', id: null } });
    eq('3b the photo is attached', out.added.length, 1);
    const d = (await db.query(`SELECT storage_ref, content_type FROM documents WHERE id=$1`, [out.added[0].document_id])).rows[0];
    eq('3c it was recognised as a photo from its bytes', d.content_type, 'image/jpeg');
    const stored = await storage.read(d.storage_ref);
    // The scrub is SURGICAL on purpose: the Exif container stays (it carries orientation, which a
    // viewer needs) and the GPS IFD is EMPTIED — the pointer entry is deliberately left in place
    // pointing at an IFD with zero entries, which every reader treats as "no location". So the
    // right assertion is that the GPS data is gone, not that the Exif block is.
    ok('3d the stored copy still has its Exif container', stored.includes(Buffer.from('Exif\0\0', 'latin1')));
    const gpsAt = stored.indexOf(Buffer.from([0x88, 0x25]));
    ok('3e the GPS pointer entry now targets an EMPTY GPS IFD', gpsAt < 0 || stored.readUInt16BE(0x1a + stored.indexOf(Buffer.from('MM\0\x2a', 'latin1'))) === 0);
    ok('3f …and it is still a JPEG', stored[0] === 0xff && stored[1] === 0xd8);
    const raw2 = jpegWithGps();
    ok('3g the fixture PROVES the scrub did something — the raw bytes differ', !stored.equals(raw2));
  }

  // ======================================================================
  // 4. A DUPLICATE IS REFUSED — the investor never gets two copies of one invoice
  // ======================================================================
  {
    const out = await DA.attach(app, ref, [{ filename: 'roof-invoice.pdf', dataBase64: b64(PDF), category: 'invoice' }], { by: { kind: 'staff', id: null } });
    eq('4a the same file again is refused', out.added.length, 0);
    ok('4b …and says why', /already attached/.test(out.skipped[0].reason));
  }

  // ======================================================================
  // 5. A BORROWER'S UPLOAD IS NOT BORN ACCEPTED
  // ======================================================================
  {
    const out = await DA.attach(app, ref, [{ filename: 'borrower-receipt.pdf', dataBase64: b64(Buffer.concat([PDF, Buffer.from('b')])), category: 'receipt' }],
      { by: { kind: 'borrower', id: bor } });
    eq('5a it is attached', out.added.length, 1);
    const d = (await db.query(`SELECT review_status, visibility, uploaded_by_kind FROM documents WHERE id=$1`, [out.added[0].document_id])).rows[0];
    eq('5b …but awaits review — nobody at the company has vouched for it', d.review_status, 'pending');
    eq('5c …and is recorded as the borrower\'s', [d.uploaded_by_kind, d.visibility], ['borrower', 'borrower']);
  }

  // ======================================================================
  // 6. WHERE THEY TRAVEL
  // ======================================================================
  {
    // The investor delivery: accepted documents ride, an un-reviewed one is HELD BACK and NAMED.
    const send = require('../src/sitewire/investor-delivery-send');
    const gather = send.gatherAttachments;
    if (gather) {
      const g = await gather(app, DRAW, 'reimbursement');
      const names = g.items.map((i) => i.what).join(' | ');
      ok('6a the accepted invoice rides to the investor', /Invoice — roof-invoice\.pdf/.test(names));
      ok('6b the accepted photo rides too', /Photo — site\.jpg/.test(names));
      const held = g.skipped.map((s) => `${s.what}:${s.reason}`).join(' | ');
      ok('6c the borrower\'s un-reviewed receipt is held back', /borrower-receipt\.pdf/.test(held));
      ok('6d …and the reason says exactly why', /has not been accepted yet/.test(held));
    } else { ok('6a-6d gatherAttachments is reachable for testing', false); }

    // The Excel packet lists them.
    const packet = await buildDrawPacket(app, DRAW);
    const flat = packet.map((r) => (r || []).join('|')).join('\n');
    ok('6e the packet has a supporting-documents section', /SUPPORTING DOCUMENTS/.test(flat));
    ok('6f …naming the invoice', /roof-invoice\.pdf/.test(flat));
    ok('6g …and saying what it backs up', /Approved \$2,400 over requested/.test(flat));
    ok('6h …and flagging the one still awaiting review', /Awaiting review/.test(flat));

    // The branded report loads them as a section.
    const drawReport = require('../src/sitewire/draw-report');
    const meta = await drawReport.loadReportMeta(app, { sitewireDrawId: DRAW, mode: 'staff' });
    const sec = meta && (meta.sections || [])[0];
    ok('6i the report section carries the attachments', !!(sec && sec.attachments && sec.attachments.length >= 2));
    ok('6j …only the accepted ones', (sec.attachments || []).every((a) => /roof-invoice|site\.jpg/.test(a.filename)));
    ok('6k …with the supporting sentence on the staff copy', (sec.attachments || []).some((a) => a.supports));
    const bmeta = await drawReport.loadReportMeta(app, { sitewireDrawId: DRAW, mode: 'borrower' });
    const bsec = bmeta && (bmeta.sections || [])[0];
    ok('6l the borrower copy never repeats our internal override sentence', (bsec.attachments || []).every((a) => !a.supports));
  }

  // ======================================================================
  // 7. FOLDERS: "Draws" in SharePoint, and OUT of the investor TPR package
  // ======================================================================
  {
    eq('7a a draw document files under Draws', tpr.categoryFor({ doc_kind: 'draw_support' }), 'Draws');
    const picked = await tpr.selectTprDocuments(app);
    const names = (picked || []).map((d) => d.filename).join(' | ');
    ok('7b the invoice is NOT in the investor TPR package', !/roof-invoice\.pdf/.test(names));
    ok('7c …nor the attached photo', !/site\.jpg/.test(names));
  }

  // ======================================================================
  // 8. DETACHING REMOVES THE BINDING, NEVER THE BYTES
  // ======================================================================
  {
    const rows = await DA.listFor(app, ref);
    const target = rows.find((r) => r.filename === 'site.jpg');
    const r = await DA.detach(app, target.id);
    ok('8a it is detached', r.removed);
    const still = (await db.query(`SELECT id, is_current FROM documents WHERE id=$1`, [target.document_id])).rows[0];
    ok('8b the document is still on the file — the bytes are never deleted', !!still && still.is_current);
    eq('8c …and it is off the draw', (await DA.listFor(app, ref)).some((x) => x.filename === 'site.jpg'), false);
  }

  // ---- clean up ----
  await db.query(`DELETE FROM draw_attachments WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM documents WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);

  console.log(fail === 0
    ? `test-draw-attachments-db: all ${pass} checks passed.`
    : `test-draw-attachments-db: ${pass} passed, ${fail} FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('test-draw-attachments-db ERROR', e); process.exit(1); });

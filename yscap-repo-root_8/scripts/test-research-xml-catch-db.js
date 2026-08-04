#!/usr/bin/env node
'use strict';
/**
 * EVERY DOOR, AGAINST A REAL DATABASE AND A REAL SERVER (db/462).
 *
 * The pure test proves the sniff decides correctly. This proves the thing the owner
 * actually asked for: that an appraisal XML arriving by ANY door ends up in the
 * property research warehouse WITH ITS COMPARABLES.
 *
 * It drives the real HTTP routes rather than calling the library, because every one of
 * the four gaps was in the WIRING, not in the warehouse — the import worked fine the
 * whole time; nothing called it. A library-only test would have passed on the broken
 * code, which is the entire reason this file exists.
 *
 * Each section reproduces one of the four ways a report used to be thrown away:
 *   (A) the borrower attaches the data file            — that door had no detection at all
 *   (B) a staffer files it on some OTHER condition     — the auto-import is slot-gated
 *   (C) a document is slotted after the fact           — that route only ran an UPDATE
 *   (D) it is already on a file from before all this   — the back-book sweep
 * plus the rules that keep it safe: no double-filing, silence for a non-appraisal, and
 * a failed READ never draining a real report out of the sweep.
 *
 * Skips without DATABASE_URL. Leaves its warehouse rows behind like its siblings, but
 * DELETES its documents — one of them deliberately has no stored copy, and left in a
 * shared database the SharePoint mirror suite spends minutes retrying it over the
 * network. See the cleanup at the end.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-research-xml-catch-db (no DATABASE_URL)'); process.exit(0); }

/* THE BOOT SWEEP MUST NOT RACE THIS TEST. Requiring `src/server.js` below starts the
   real boot block, which fires a back-book sweep over the whole `documents` table —
   and this file's whole job is to observe what a sweep does to documents it creates.
   With the two running together the boot pass drains the queue first and every
   assertion here reads zero.
   `RESEARCH_XML_SWEEP_FILES` is read at MODULE LOAD to set the default budget, so
   setting it to 0 here (before the require) makes the boot pass a no-op while every
   explicit `sweepOnce(db, { limit: N })` below still runs exactly as it does in
   production. */
process.env.RESEARCH_XML_SWEEP_FILES = '0';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const storage = require('../src/lib/storage');
const catcher = require('../src/lib/research/xml-catch');
const sweep = require('../src/lib/research/xml-sweep');
const app = require('../src/server');

// A REAL report shape — the parser reads this, so the assertions below are about the
// wiring rather than about a fixture the warehouse would have taken anyway. Each call
// varies the subject and the comparables so two sections can never be confused for one
// another, and so the "same bytes twice" rule is testable against genuinely different
// bytes as a control.
//
// EVERY RUN'S REPORTS ARE ITS OWN. The catch is keyed on the sha256 of the bytes and
// deliberately stands down against a report already in the warehouse — so a fixture
// that was byte-identical between runs would make the SECOND run assert against the
// FIRST run's rows and quietly stop testing anything. `NONCE` is in the address, so the
// bytes differ per run and each assertion is about work this run actually did.
const NONCE = `${process.pid}${Math.floor(Math.random() * 1e6)}`;
const report = (n, { comps = 2 } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<VALUATION_RESPONSE MISMOVersionID="2.6">
 <REPORT AppraisalFormType="FNM1004">
  <PROPERTY _StreetAddress="${n} Catcher${NONCE} Way" _City="Trenton" _State="NJ" _PostalCode="08608">
   <_IDENTIFICATION AssessorsParcelIdentifier="P-${NONCE}-${n}"/>
   <SALES_COMPARISON>
    ${Array.from({ length: comps }, (_, i) => `
    <COMPARABLE_SALE PropertySequenceIdentifier="${i + 1}" SalesPriceAmount="${400000 + i * 1000 + n}">
     <LOCATION PropertyStreetAddress="${n}${i + 1} Comparable${NONCE} Ave" PropertyCity="Trenton" PropertyState="NJ" PropertyPostalCode="08608"/>
     <SALES_CONTRACT ContractDate="2026-03-1${i}"/>
    </COMPARABLE_SALE>`).join('')}
   </SALES_COMPARISON>
  </PROPERTY>
  <APPRAISER_LICENSE _Name="Dana Catcher" _CompanyName="Catcher Appraisals" _LicenseIdentifier="RG-${NONCE}-${n}" _LicenseState="NJ"/>
  <SIGNATURE _SignatureDate="2026-04-0${n % 9}" AppraisalEffectiveDate="2026-04-0${n % 9}"/>
 </REPORT>
</VALUATION_RESPONSE>`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

/** Wait for a fire-and-forget catch to land — it runs on setImmediate, off the response. */
async function settled(sha, ms = 12000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await db.query(`SELECT id, status, error FROM research_imports WHERE sha256 = $1`, [sha]);
    if (r.rows[0] && r.rows[0].status !== 'pending') return r.rows[0];
    if (Date.now() > until) return r.rows[0] || null;
    await new Promise((s) => setTimeout(s, 120));
  }
}
const sha = (s) => require('crypto').createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

/** What the warehouse actually GAINED from one import — the owner's question, in SQL. */
async function landed(importId) {
  const r = await db.query(
    `SELECT count(*) FILTER (WHERE role = 'subject')::int AS subjects,
            count(*) FILTER (WHERE role <> 'subject')::int AS comps,
            count(DISTINCT property_id)::int AS properties
       FROM property_observations WHERE import_id = $1`, [importId]);
  return r.rows[0];
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let fails = 0;
  const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };

  const madeImports = [];
  let cleanupAppId = null;
  let apprItemId = null;
  try {
    // THIS TEST SHARES A DATABASE WITH EVERY OTHER ONE, and it deliberately leaves an
    // unreadable document behind (the "one outage never costs a report" case, which is
    // only meaningful if the document stays in the queue). So a document some OTHER
    // run left in the sweep's work queue is not this run's subject: drain the queue
    // first, and every count below is then exactly about the rows created here.
    await db.query(
      `UPDATE documents SET research_xml_checked_at = now()
        WHERE research_xml_checked_at IS NULL
          AND (lower(coalesce(filename,'')) LIKE '%.xml'
               OR lower(coalesce(content_type,'')) LIKE '%xml%')`);

    // ---- the file, its people, and a condition that is NOT the appraisal one -----
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Cat Cher','admin',true,false,'x',0) RETURNING id`,
      [`xc-staff-${sfx}@test.local`])).rows[0].id;
    const staffTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'admin', tv: 0 });

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Cass','Catcher',$1) RETURNING id`,
      [`xc-b-${sfx}@test.local`])).rows[0].id;
    await db.query(
      `INSERT INTO borrower_auth (borrower_id,password_hash,token_version)
       VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [borrowerId]);
    const borrowerTok = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });

    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, program)
       VALUES ($1,$2,'underwriting','Fix & Flip w/ Construction') RETURNING id`, [borrowerId, staffId])).rows[0].id;
    cleanupAppId = appId;

    // A plain borrower-facing condition. NOT rtl_cond_appraisaldocs — that is the
    // whole point of section (B): the old auto-import only ever fired there.
    const itemId = (await db.query(
      `INSERT INTO checklist_items (application_id, scope, label, audience, item_kind, status, is_required)
       VALUES ($1,'application','Any other document','both','document','outstanding',false) RETURNING id`, [appId])).rows[0].id;

    // =====================================================================
    // (A) THE BORROWER ATTACHES THE APPRAISER'S DATA FILE.
    // That door had no appraisal detection whatsoever, so every comparable in the
    // report was filed as bytes and thrown away.
    // =====================================================================
    const A = report(1);
    const rA = await call(server, 'POST', '/api/borrower/documents', borrowerTok, {
      filename: 'appraisal-data.xml', contentType: 'application/xml',
      dataBase64: b64(A), applicationId: appId, checklistItemId: itemId,
    });
    ok(rA.status === 201, `a borrower can still upload (${rA.status})`);
    const impA = await settled(sha(A));
    ok(impA && impA.status === 'ok', `(A) the borrower's XML reached the warehouse (${impA ? impA.status : 'never arrived'}${impA && impA.error ? ': ' + impA.error : ''})`);
    if (impA) {
      madeImports.push(impA.id);
      const g = await landed(impA.id);
      ok(g.subjects === 1, `  …the subject property is in (${g.subjects})`);
      ok(g.comps === 2, `  …AND ALL ITS COMPARABLES CAME WITH IT (${g.comps} of 2) — the owner's whole ask`);
      const src = (await db.query(`SELECT source, uploaded_by FROM research_imports WHERE id=$1`, [impA.id])).rows[0];
      ok(/borrower upload/.test(src.source || ''), `  …and the list says where it came from ("${src.source}")`);
      // research_imports.uploaded_by REFERENCES staff_users. A borrower id here would
      // have raised a foreign-key violation and lost the entire report.
      ok(src.uploaded_by === null, '  …with no uploader recorded — a borrower id can never reach the staff foreign key');
    }

    // AND NOTHING TOUCHED THE LOAN FILE. The catch writes only into the warehouse:
    // no appraisal row, no condition, no finding, no value anywhere near the deal.
    const appraisals = (await db.query(`SELECT count(*)::int n FROM appraisals WHERE application_id=$1`, [appId])).rows[0].n;
    ok(appraisals === 0, '  …and the LOAN FILE gained no appraisal, condition or finding from it');

    // =====================================================================
    // (B) A STAFFER FILES IT ON A CONDITION THAT IS NOT THE APPRAISAL ONE.
    // The existing auto-import is gated on the slot matching /xml/i AND the condition
    // being rtl_cond_appraisaldocs, so this filed bytes only.
    // =====================================================================
    const B = report(2, { comps: 3 });
    const rB = await call(server, 'POST', `/api/staff/applications/${appId}/documents`, staffTok, {
      filename: 'from-the-appraiser.xml', contentType: 'application/xml',
      dataBase64: b64(B), checklistItemId: itemId, slot: 'Something else entirely',
    });
    ok(rB.status === 201 || rB.status === 200, `a staffer can still upload (${rB.status})`);
    const impB = await settled(sha(B));
    ok(impB && impB.status === 'ok', `(B) an XML on ANY condition, in a slot named nothing like "xml", reached the warehouse (${impB ? impB.status : 'never arrived'})`);
    if (impB) {
      madeImports.push(impB.id);
      const g = await landed(impB.id);
      ok(g.comps === 3, `  …with all three comparables (${g.comps})`);
      const src = (await db.query(`SELECT source, uploaded_by FROM research_imports WHERE id=$1`, [impB.id])).rows[0];
      ok(src.uploaded_by === staffId, '  …and a STAFF uploader IS recorded (the id is real, so it is kept)');
    }

    // =====================================================================
    // (C) UPLOAD FIRST, NAME THE SLOT SECOND — the ordinary way people work. That
    // route only ever ran an UPDATE on the label.
    // =====================================================================
    // Give the file the real appraisal condition so the route has named slots to
    // canonicalise against.
    const apprTpl = (await db.query(
      `SELECT id FROM checklist_templates WHERE code='rtl_cond_appraisaldocs' LIMIT 1`)).rows[0];
    if (apprTpl) {
      apprItemId = (await db.query(
        `INSERT INTO checklist_items (application_id, template_id, scope, label, audience, item_kind, status, is_required)
         VALUES ($1,$2,'application','Appraisal documents','staff','document','outstanding',true) RETURNING id`,
        [appId, apprTpl.id])).rows[0].id;
      const apprItem = apprItemId;

      // A document that arrived BEFORE any of this existed: stored, on the condition,
      // in no slot, and already marked as looked-at so the sweep cannot be the thing
      // that saves it. Only the slot route can.
      const Cx = report(3);
      const saved = await storage.save(Buffer.from(Cx, 'utf8'), { filename: 'late-slot.xml' });
      const docC = (await db.query(
        `INSERT INTO documents (application_id, borrower_id, checklist_item_id, filename, content_type,
                                size_bytes, storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id,
                                research_xml_checked_at)
         VALUES ($1,$2,$3,'late-slot.xml','application/xml',$4,$5,$6,'staff',$7, now()) RETURNING id`,
        [appId, borrowerId, apprItem, Buffer.byteLength(Cx), saved.provider, saved.ref, staffId])).rows[0].id;

      ok(!(await settled(sha(Cx), 300)), '(C) a document stored the old way is NOT in the warehouse to begin with');

      const slots = await require('../src/lib/order-slots').slotsForConditionTemplate(db, 'rtl_cond_appraisaldocs');
      const xmlSlot = slots.find((s) => /xml/i.test(String(s))) || slots[0];
      const rC = await call(server, 'POST', `/api/staff/applications/${appId}/documents/${docC}/slot`, staffTok, { slot: xmlSlot });
      ok(rC.status === 200, `  …naming its slot succeeds (${rC.status}${rC.body && rC.body.error ? ': ' + rC.body.error : ''})`);
      const impC = await settled(sha(Cx));
      ok(impC && impC.status === 'ok', `  …AND THAT is what puts it in the warehouse (${impC ? impC.status : 'never arrived'})`);
      if (impC) {
        madeImports.push(impC.id);
        ok((await landed(impC.id)).comps === 2, '  …comparables and all');
      }

      // Re-slotting is idempotent — the catch is keyed on the bytes, so doing it again
      // must not file a second copy of every property.
      const before = (await db.query(`SELECT count(*)::int n FROM research_imports WHERE sha256=$1`, [sha(Cx)])).rows[0].n;
      await call(server, 'POST', `/api/staff/applications/${appId}/documents/${docC}/slot`, staffTok, { slot: xmlSlot });
      await new Promise((s) => setTimeout(s, 1500));
      const after = (await db.query(`SELECT count(*)::int n FROM research_imports WHERE sha256=$1`, [sha(Cx)])).rows[0].n;
      ok(before === 1 && after === 1, `  …and re-slotting the same document files nothing twice (${before} → ${after})`);
    } else {
      ok(false, '(C) SKIPPED — the appraisal-documents template is missing from this database');
    }

    // =====================================================================
    // (D) THE BACK BOOK — reports already on the files from before any of this.
    // =====================================================================
    const D = report(4, { comps: 4 });
    const savedD = await storage.save(Buffer.from(D, 'utf8'), { filename: 'old-appraisal.xml' });
    const docD = (await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, is_current, review_status)
       VALUES ($1,$2,'old-appraisal.xml','application/xml',$3,$4,$5,'borrower',$2,false,'rejected') RETURNING id`,
      [appId, borrowerId, Buffer.byteLength(D), savedD.provider, savedD.ref])).rows[0].id;
    // A PDF alongside it, to prove the sweep does not read every document in storage.
    const savedPdf = await storage.save(Buffer.from('%PDF-1.7 not xml', 'utf8'), { filename: 'scan.pdf' });
    await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind)
       VALUES ($1,$2,'scan.pdf','application/pdf',$3,$4,$5,'borrower')`,
      [appId, borrowerId, 16, savedPdf.provider, savedPdf.ref]);
    // And an XML that is NOT an appraisal, which must be looked at and dismissed.
    const notAppraisal = `<?xml version="1.0"?><rentRoll><unit no="1" rent="2400"/></rentRoll>`;
    const savedRR = await storage.save(Buffer.from(notAppraisal, 'utf8'), { filename: 'rent-roll.xml' });
    const docRR = (await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind)
       VALUES ($1,$2,'rent-roll.xml','application/xml',$3,$4,$5,'borrower') RETURNING id`,
      [appId, borrowerId, Buffer.byteLength(notAppraisal), savedRR.provider, savedRR.ref])).rows[0].id;

    const s1 = await sweep.sweepOnce(db, { limit: 200 });
    ok(s1.ran && s1.looked > 0, `(D) the sweep ran over the back book (looked at ${s1.looked})`);
    const impD = await settled(sha(D), 1000);
    ok(impD && impD.status === 'ok', `  …and a report that only ever existed as a stored document is now in (${impD ? impD.status : 'never arrived'})`);
    if (impD) {
      madeImports.push(impD.id);
      ok((await landed(impD.id)).comps === 4, '  …with every one of its four comparables');
      ok(/already on a file/.test((await db.query(`SELECT source FROM research_imports WHERE id=$1`, [impD.id])).rows[0].source || ''),
        '  …recorded as having come off a file, not as a hand upload');
    }
    // A SUPERSEDED, REJECTED document was deliberately used above: a comparable sale
    // that happened, happened, and whether a reviewer accepted the document as
    // evidence on a loan file is a different question. Nothing leaves the building.
    ok(true, '  …and it counted even though the document was superseded AND rejected — the sale is still real');

    // THE STAMP IS WHAT DRAINS IT.
    const stamped = (await db.query(
      `SELECT research_xml_checked_at IS NOT NULL AS s FROM documents WHERE id=$1`, [docRR])).rows[0].s;
    ok(stamped === true, '  …a NON-appraisal XML is stamped as looked-at, so it is never re-read');
    ok((await db.query(`SELECT count(*)::int n FROM research_imports WHERE sha256=$1`, [sha(notAppraisal)])).rows[0].n === 0,
      '  …and it left NO ledger row at all — an ordinary XML is ignored in silence');
    const s2 = await sweep.sweepOnce(db, { limit: 200 });
    ok(s2.looked === 0, `  …so a second sweep has nothing left to do (${s2.looked}) — it is self-draining`);

    // A FAILED READ IS NOT A VERDICT. One storage outage that stamps a real report
    // drains it out of the sweep permanently, so the read failure must leave the
    // document unstamped and countable.
    const savedGone = await storage.save(Buffer.from(report(5), 'utf8'), { filename: 'vanished.xml' });
    const docGone = (await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind)
       VALUES ($1,$2,'vanished.xml','application/xml',$3,$4,$5,'borrower') RETURNING id`,
      [appId, borrowerId, 999, savedGone.provider, `${savedGone.ref}-does-not-exist`])).rows[0].id;
    const s3 = await sweep.sweepOnce(db, { limit: 200 });
    ok(s3.readFailed === 1, `  …a document whose bytes cannot be read is COUNTED as unread (${s3.readFailed})`);
    ok((await db.query(`SELECT research_xml_checked_at IS NULL AS u FROM documents WHERE id=$1`, [docGone])).rows[0].u === true,
      '  …and left UNSTAMPED, so one storage outage never costs a report');

    /* …AND YET THE SWEEP STILL DRAINS. Not stamping a failed read is right and, on its
       own, STARVES the queue: it is ordered oldest-first, so a handful of permanently
       dead documents at the front consume the entire per-boot budget on every boot,
       forever, and the real reports behind them are never reached. An audit reproduced
       exactly that — three dead documents and a real appraisal at limit 3 filed nothing
       across four boots — and storage's own temp-dir fallback guarantees a supply of
       them, because anything written there is unreadable after the next deploy and
       those are the OLDEST rows. So a read failure buys a few more tries and then
       settles. An outage is one attempt, not three. */
    const deadDoc = async (name) => {
      const sv = await storage.save(Buffer.from(report(9), 'utf8'), { filename: name });
      return (await db.query(
        `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                                storage_provider, storage_ref, uploaded_by_kind, created_at)
         VALUES ($1,$2,$3,'application/xml',999,$4,$5,'borrower', now() - interval '10 years') RETURNING id`,
        [appId, borrowerId, name, sv.provider, `${sv.ref}-gone`])).rows[0].id;
    };
    await deadDoc('dead-a.xml'); await deadDoc('dead-b.xml');
    // A REAL report, newest, so oldest-first puts it BEHIND all three dead ones.
    const LIVE = report(10, { comps: 3 });
    const svLive = await storage.save(Buffer.from(LIVE, 'utf8'), { filename: 'live-behind-the-dead.xml' });
    await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind)
       VALUES ($1,$2,'live-behind-the-dead.xml','application/xml',$3,$4,$5,'borrower')`,
      [appId, borrowerId, Buffer.byteLength(LIVE), svLive.provider, svLive.ref]);

    let gaveUp = 0;
    for (let boot = 0; boot < 4; boot++) {
      const s = await sweep.sweepOnce(db, { limit: 3 });   // budget SMALLER than the dead set
      gaveUp += s.gaveUp || 0;
    }
    ok(gaveUp >= 3, `dead documents are given up on rather than held at the front forever (${gaveUp})`);
    const liveImp = await settled(sha(LIVE), 2000);
    ok(liveImp && liveImp.status === 'ok',
      `  …so the real report queued BEHIND them is reached (${liveImp ? liveImp.status : 'never reached'})`);
    ok((await landed(liveImp.id)).comps === 3, '  …with its comparables');

    // ---- the same report, twice, is filed once --------------------------------
    const before = (await db.query(`SELECT count(*)::int n FROM property_observations WHERE import_id=$1`, [impA ? impA.id : null])).rows[0].n;
    const again = await catcher.catchDocumentXml(db, {
      bytes: Buffer.from(A, 'utf8'), filename: 'appraisal-data.xml', why: 'a second door',
    });
    ok(again.considered && !again.attempted && /already in the database/i.test(again.reason || ''),
      'the same report arriving by a SECOND door is recognised and stood down from');
    ok((await db.query(`SELECT count(*)::int n FROM property_observations WHERE import_id=$1`, [impA ? impA.id : null])).rows[0].n === before,
      '  …and nothing was written twice');

    /* ---- THE DESK IMPORT AND THE CATCH MUST NOT RACE ---------------------------
       On the appraisal condition's XML slot, `runAppraisalImport` feeds the warehouse
       itself (richer — it carries the photographs) while the catch fires on the same
       bytes. Both de-dup guards stand down on a report carrying neither an effective
       date nor a named appraiser — deliberately, because such a report has no
       fingerprint — so an audit measured every property in one landing TWICE, with no
       later pass healing it. The catch is therefore skipped when the desk import
       succeeded, which is exactly what this asserts, on a report with no fingerprint. */
    if (apprItemId) {
      const NOFP = `<?xml version="1.0"?><VALUATION_RESPONSE MISMOVersionID="2.6">
 <REPORT AppraisalFormType="FNM1004">
  <PROPERTY _StreetAddress="88 Race${NONCE} Way" _City="Trenton" _State="NJ" _PostalCode="08608">
   <SALES_COMPARISON>
    <COMPARABLE_SALE PropertySequenceIdentifier="1" SalesPriceAmount="401000">
     <LOCATION PropertyStreetAddress="1 Race${NONCE} Ave" PropertyCity="Trenton" PropertyState="NJ" PropertyPostalCode="08608"/>
    </COMPARABLE_SALE>
   </SALES_COMPARISON>
  </PROPERTY>
 </REPORT></VALUATION_RESPONSE>`;
      const rr = await call(server, 'POST', `/api/staff/applications/${appId}/documents`, staffTok, {
        filename: 'race.xml', contentType: 'application/xml', dataBase64: b64(NOFP),
        checklistItemId: apprItemId, slot: 'Appraisal XML',
      });
      ok(rr.status === 201 || rr.status === 200, `the appraisal-slot upload succeeds (${rr.status})`);
      // Let both the desk's own ingest and any stray catch settle.
      await new Promise((s) => setTimeout(s, 4000));
      const dupes = (await db.query(
        `SELECT p.display_address, count(*)::int AS n
           FROM property_observations o JOIN properties p ON p.id = o.property_id
          WHERE p.display_address ILIKE $1 GROUP BY 1 HAVING count(*) > 1`,
        [`%Race${NONCE}%`])).rows;
      ok(dupes.length === 0,
        `  …and no property carries that report twice (${JSON.stringify(dupes)})`);
      const stray = (await db.query(
        `SELECT count(*)::int n FROM research_imports WHERE sha256 = $1`, [sha(NOFP)])).rows[0].n;
      ok(stray === 0,
        '  …because the catch stands down entirely when the desk import succeeded');
    }

    // ---- the loan file's own copy always wins ---------------------------------
    // `xml-import` stands down when a loan file already carries the same report (it
    // has the photographs). Proven here rather than assumed, because it is what makes
    // firing the catch on every upload safe alongside the appraisal desk.
    const E = report(6);
    const firstE = await catcher.catchDocumentXml(db, { bytes: Buffer.from(E, 'utf8'), filename: 'e.xml', why: 'test' });
    if (firstE.importId) madeImports.push(firstE.importId);
    ok(firstE.filed, 'a fresh report files normally');

    // ---- the ceiling, and the things that are simply not appraisals ------------
    // Checked on the RECORDED size so the bytes are never fetched at all — the point
    // of the ceiling is that a wrong file (a video, a disk image) is refused with a
    // sentence instead of being downloaded and parsed until memory runs out.
    const savedBig = await storage.save(Buffer.from('<VALUATION_RESPONSE/>', 'utf8'), { filename: 'huge.xml' });
    const docBig = (await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind)
       VALUES ($1,$2,'huge.xml','application/xml',$3,$4,$5,'borrower') RETURNING id`,
      [appId, borrowerId, catcher.MAX_XML_BYTES + 1, savedBig.provider, savedBig.ref])).rows[0].id;
    const huge = await catcher.catchDocumentById(db, docBig, { why: 'test' });
    ok(!huge.considered && !huge.readFailed && /larger than/i.test(huge.reason || ''),
      `a file bigger than the parser's own ceiling is refused with a sentence, not read ("${huge.reason}")`);
    /* …AND THE SWEEP ITSELF NEVER FETCHES IT. Asserted by RUNNING the sweep, not by
       re-stating its WHERE clause in the test's own SQL — that earlier version asserted
       arithmetic (`MAX+1 <= MAX` is false) and passed with the size filter deleted from
       the product entirely, which an audit proved by deleting it. The oversized document
       is the only thing left in the queue at this point, so a pass that looks at nothing
       is the real evidence. */
    const sBig = await sweep.sweepOnce(db, { limit: 200 });
    const bigAfter = (await db.query(
      `SELECT research_xml_checked_at IS NULL AS unstamped, coalesce(research_xml_attempts,0) AS tries
         FROM documents WHERE id = $1`, [docBig])).rows[0];
    ok(bigAfter.unstamped === true && Number(bigAfter.tries) === 0,
      `the sweep never fetches a file past the ceiling — it was neither read nor stamped (tries ${bigAfter.tries})`);
    /* AND IT IS NOT COUNTED AS OUTSTANDING WORK EITHER. `remaining` used to omit the
       size filter the work queue has, so an unreachable document inflated "still to look
       at" forever — and because the boot log is gated on `looked`, it was reported once
       as phantom work and then never mentioned again. A silent drop. */
    ok(sBig.remaining === 0,
      `  …and it is not counted as still-to-do, which would never fall to zero (${sBig.remaining})`);
    const junk = await catcher.catchDocumentXml(db, { bytes: Buffer.from('%PDF-1.7'), filename: 'a.pdf', contentType: 'application/pdf', why: 'test' });
    ok(!junk.considered && !junk.attempted, 'a PDF is not considered at all');

    // ---- it never throws, whatever it is handed -------------------------------
    for (const [what, arg] of [
      ['nothing at all', {}],
      ['a null body', { bytes: null, filename: null }],
      ['a number', { bytes: 12345, filename: 'x.xml' }],
      ['an unreachable document id', { }],
    ]) {
      let threw = null;
      try { await catcher.catchDocumentXml(db, arg); } catch (e) { threw = e; }
      ok(!threw, `the catch never throws — handed ${what}${threw ? ' (threw: ' + threw.message + ')' : ''}`);
    }
    let threwById = null;
    try { await catcher.catchDocumentById(db, '00000000-0000-0000-0000-000000000000'); } catch (e) { threwById = e; }
    ok(!threwById, 'and catch-by-id never throws on a document that is not there');

    /* ---- A BORROWER MAY NOT REWRITE THE SHARED APPRAISER ROSTER ----------------
       `appraisers` is cross-file and every staff user reads it. Until this change only
       STAFF could write to it (a desk import or the hand-upload screen); now a borrower
       attaching one document reaches it, and an audit measured a borrower-supplied file
       replacing a real appraiser's company, phone and email for the whole firm. The
       report's PROPERTY facts still land in full — a comparable sale that happened,
       happened, and that is what the warehouse is for. */
    {
      const lic = `RG-TRUST-${NONCE}`;
      const withAppraiser = (co, phone, email) => `<?xml version="1.0"?><VALUATION_RESPONSE MISMOVersionID="2.6">
 <REPORT AppraisalFormType="FNM1004">
  <PROPERTY _StreetAddress="5 Trust${NONCE} ${co.length} Way" _City="Trenton" _State="NJ" _PostalCode="08608">
   <SALES_COMPARISON><COMPARABLE_SALE PropertySequenceIdentifier="1" SalesPriceAmount="405000">
    <LOCATION PropertyStreetAddress="9 Trust${NONCE} ${co.length} Ave" PropertyCity="Trenton" PropertyState="NJ" PropertyPostalCode="08608"/>
   </COMPARABLE_SALE></SALES_COMPARISON></PROPERTY>
  <APPRAISER _Name="Pat Trust" _CompanyName="${co}">
   <APPRAISER_LICENSE _Identifier="${lic}" _State="NJ"/>
   <CONTACT_POINT _Type="Phone" _Value="${phone}"/>
   <CONTACT_POINT _Type="Email" _Value="${email}"/>
  </APPRAISER>
  <SIGNATURE _SignatureDate="2026-04-01" AppraisalEffectiveDate="2026-04-01"/>
 </REPORT></VALUATION_RESPONSE>`;

      const good = withAppraiser('Honest Appraisal LLC', '(973) 555-0000', 'pat@honest.test');
      await catcher.catchDocumentXml(db, { bytes: Buffer.from(good, 'utf8'), filename: 'staff.xml', why: 'test staff' });
      const before = (await db.query(
        `SELECT company FROM appraisers WHERE license_id = $1 ORDER BY updated_at DESC LIMIT 1`, [lic])).rows[0];
      ok(before && /Honest/.test(before.company || ''),
        `a staff-filed report records the appraiser normally (${before && before.company})`);

      // The SAME appraiser licence, a LATER report date, different contact details, via
      // the borrower door's provenance.
      const bad = withAppraiser('Totally Different Co', '(000) 000-0000', 'someone@elsewhere.test')
        .replace('2026-04-01" AppraisalEffectiveDate="2026-04-01', '2026-06-01" AppraisalEffectiveDate="2026-06-01');
      const br = await catcher.catchDocumentXml(db, {
        bytes: Buffer.from(bad, 'utf8'), filename: 'borrower.xml', untrusted: true, why: 'test borrower' });
      ok(br.filed, 'an untrusted report still FILES — its property facts are facts');
      const after = (await db.query(
        `SELECT company FROM appraisers WHERE license_id = $1 ORDER BY updated_at DESC LIMIT 1`, [lic])).rows[0];
      ok(after && /Honest/.test(after.company || ''),
        `  …but it never rewrites the shared appraiser roster (${after && after.company})`);
      ok((await landed(br.importId)).comps === 1,
        '  …while its comparable sale lands in full');
    }

    /* ---- WHERE A REPORT CAME FROM IS HISTORY, NOT A FIELD TO REWRITE -----------
       The first door to file a report is the one that actually brought it in, so a
       later re-file must not restate it. Unguarded, this is a one-word change
       (`COALESCE(...)` → `EXCLUDED.source`) that no other assertion notices. */
    {
      const H = report(11);
      const first = await catcher.catchDocumentXml(db, {
        bytes: Buffer.from(H, 'utf8'), filename: 'hist.xml', why: 'the first door' });
      ok(first.filed, 'a report records the door it came in through');
      // Force a re-file by clearing the ledger's settled status, then catch again.
      await db.query(`UPDATE research_imports SET status='error' WHERE sha256=$1`, [sha(H)]);
      await catcher.catchDocumentXml(db, {
        bytes: Buffer.from(H, 'utf8'), filename: 'hist.xml', why: 'a much later door' });
      const src = (await db.query(`SELECT source FROM research_imports WHERE sha256=$1`, [sha(H)])).rows[0];
      ok(src && src.source === 'the first door',
        `  …and a later re-file never rewrites that history (${src && src.source})`);
    }

    // ---- the off switch -------------------------------------------------------
    process.env.RESEARCH_XML_SWEEP_DISABLED = '1';
    const off = await sweep.sweepOnce(db, { limit: 50 });
    ok(off.ran === false && off.looked === 0, 'RESEARCH_XML_SWEEP_DISABLED=1 stops the sweep dead');
    delete process.env.RESEARCH_XML_SWEEP_DISABLED;

    // ---- and the import list can answer the owner's question ------------------
    const list = await call(server, 'GET', '/api/research/imports?limit=50', staffTok);
    ok(list.status === 200 && Array.isArray(list.body.rows), 'the import list still answers');
    ok((list.body.rows || []).some((r) => /loan file/.test(r.source || '')),
      '  …and shows, in words, that the reports on our loan files came in');
  } catch (e) {
    console.error('HARNESS ERROR', e && e.message, e && e.stack);
    fails++;
  } finally {
    // THIS TEST'S DOCUMENTS ARE CLEANED UP, unlike the rows its siblings leave behind,
    // and for a specific reason: it deliberately creates a document whose stored copy
    // is MISSING (the "one outage never costs a report" case). Left in a shared
    // database, that row is picked up by the SharePoint mirror suite, which then
    // spends minutes on real network retries trying to mirror a file that is not
    // there. The warehouse rows are left — they are the point, and nothing walks them.
    try {
      if (cleanupAppId) {
        await db.query(`DELETE FROM documents WHERE application_id = $1`, [cleanupAppId]);
      }
    } catch (_) { /* best-effort — a leftover row is a nuisance, not a failure */ }
    server.close();
    try { await db.pool.end(); } catch (_) { /* already closed */ }
  }
  console.log(fails ? `\ntest-research-xml-catch-db: ${fails} FAILED` : '\ntest-research-xml-catch-db: all passed');
  process.exit(fails ? 1 : 0);
})();

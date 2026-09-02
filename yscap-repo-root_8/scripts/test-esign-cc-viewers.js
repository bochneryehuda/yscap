'use strict';
/**
 * test-esign-cc-viewers.js — the file's loan officer + processor (+ assistants) are
 * COPIED as viewers on every envelope (task #42, owner-directed 2026-07-20: "add the
 * loan officer and the processor as viewers for every envelope … so they can see
 * everything happens in real life"). DocuSign CC recipients receive the completed,
 * signed copy + Certificate of Completion and can view the envelope; they never sign.
 *
 * Run: DATABASE_URL=... PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres node scripts/test-esign-cc-viewers.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/yscap';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cc';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const ds = require(REPO + '/src/lib/integrations/docusign');
const orchestrate = require(REPO + '/src/lib/esign/orchestrate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

// ---- 1. buildEnvelopeDefinition CC support (no DB) ---------------------------
{
  console.log('\n1. buildEnvelopeDefinition carbon copies');
  const base = { documents: [{ base64: 'x', name: 'D', documentId: 1 }], signers: [{ recipientId: '1', name: 'B', email: 'b@x.com', routingOrder: 1, tabsByDoc: {} }], subject: 's' };
  let d = ds.buildEnvelopeDefinition({ ...base, carbonCopies: [{ recipientId: '2', name: 'LO', email: 'lo@ys.com', routingOrder: 2 }] });
  ok(d.recipients.carbonCopies && d.recipients.carbonCopies.length === 1, 'a valid CC is added to recipients.carbonCopies');
  ok(d.recipients.carbonCopies[0].email === 'lo@ys.com' && d.recipients.carbonCopies[0].recipientId === '2', 'CC carries the email + recipientId');
  ok(!d.recipients.carbonCopies[0].tabs, 'a CC has no signing tabs (viewer only)');
  d = ds.buildEnvelopeDefinition({ ...base, carbonCopies: [{ recipientId: '2', name: 'LO', email: 'not-an-email', routingOrder: 2 }] });
  ok(!d.recipients.carbonCopies, 'an invalid CC email is dropped (never blocks the send)');
  d = ds.buildEnvelopeDefinition(base);
  ok(!d.recipients.carbonCopies, 'no carbonCopies key when there are none');
}

// ---- 2. orchestrate.buildDefinition copies the file's team (DB) --------------
const TAG = 'cc-' + Date.now().toString(36);
async function main() {
  // BOTH CI jobs run the one chain and `test` has no database at all, so this
  // must skip rather than dial one. The probe goes BEFORE ensureSchema on
  // purpose: ensureSchema does not throw when the database is unreachable, it
  // retries for ~75s and then RESOLVES, so a guard after it catches nothing.
  await require(__dirname + '/lib/db-gate').skipUnlessDb('esign-cc-viewers');
  await require(REPO + '/src/migrate-boot').ensureSchema();
  console.log('\n2. orchestrate.buildDefinition copies the loan officer + processor');
  const loId = crypto.randomUUID(), prId = crypto.randomUUID(), bId = crypto.randomUUID();
  const cbId = crypto.randomUUID(), dupAdmin = crypto.randomUUID();
  const laId = crypto.randomUUID();   // the LOAN OFFICER ASSISTANT (db/672), seated in their own slot
  let appId, envRowId;
  try {
    await db.query(`INSERT INTO staff_users (id, email, full_name, role) VALUES ($1,$2,'Dana Officer','loan_officer'),($3,$4,'Perry Processor','processor')`,
      [loId, `lo+${TAG}@ys.com`, prId, `pr+${TAG}@ys.com`]);
    await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Pat','Borrower',$2)`, [bId, `b+${TAG}@example.com`]);
    appId = (await db.query(
      `INSERT INTO applications (ys_loan_number, borrower_id, loan_officer_id, processor_id, property_address, loan_amount)
       VALUES ($1,$2,$3,$4,'{"oneLine":"1 Main St, Town, NY"}',400000) RETURNING id`, [`YSCAP-${TAG}`, bId, loId, prId])).rows[0].id;
    // Ensure both are active assignees (belt-and-suspenders alongside the db/103 trigger).
    await db.query(
      `INSERT INTO application_assignees (application_id, staff_id, role, is_primary)
       VALUES ($1,$2,'loan_officer',true),($1,$3,'processor',true) ON CONFLICT DO NOTHING`, [appId, loId, prId]).catch(() => {});

    // A heter_iska envelope (single generated doc, no counter-signer, no stored PDFs)
    // — enough to exercise buildDefinition's CC computation without seeding documents.
    envRowId = (await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required)
       VALUES ($1,'heter_iska','not_sent',false) RETURNING id`, [appId])).rows[0].id;
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, recipient_id_ds, borrower_id, name, email, embedded, client_user_id, status)
       VALUES ($1,'borrower',1,'1',$2,'Pat Borrower',$3,true,$4,'created')`,
      [envRowId, bId, `b+${TAG}@example.com`, `${envRowId}:borrower`]);

    const row = (await db.query(`SELECT * FROM esign_envelopes WHERE id=$1`, [envRowId])).rows[0];
    const def = await orchestrate.buildDefinition(row, { db });
    const ccEmails = (def.carbonCopies || []).map((c) => c.email).sort();
    ok(ccEmails.length === 2, 'both the loan officer AND the processor are copied');
    ok(ccEmails.includes(`lo+${TAG}@ys.com`) && ccEmails.includes(`pr+${TAG}@ys.com`), 'the CC emails are the file team');
    // recipientIds continue after the signer ("1") and never collide with it.
    const ccIds = (def.carbonCopies || []).map((c) => c.recipientId);
    ok(!ccIds.includes('1') && ccIds.every((id) => Number(id) >= 2), 'CC recipientIds are assigned AFTER the signers');
    ok((def.carbonCopies || []).every((c) => Number(c.routingOrder) >= 1), 'CCs get a routing order (receive the completed copy)');
    // The signer is never also CC'd.
    ok(!ccEmails.includes(`b+${TAG}@example.com`), 'the borrower (a signer) is never copied');

    // Collision: if the loan officer IS the borrower's email, they are NOT copied twice.
    await db.query(`UPDATE staff_users SET email=$2 WHERE id=$1`, [loId, `b+${TAG}@example.com`]);
    const def2 = await orchestrate.buildDefinition(row, { db });
    const cc2 = (def2.carbonCopies || []).map((c) => c.email);
    ok(!cc2.includes(`b+${TAG}@example.com`), 'a staffer whose email equals a signer is not copied (dedup vs signers)');
    ok(cc2.includes(`pr+${TAG}@ys.com`), '…the other team member is still copied');

    // Restore the LO email for the next scenario.
    await db.query(`UPDATE staff_users SET email=$2 WHERE id=$1`, [loId, `lo+${TAG}@ys.com`]);

    // ---- 3. term-sheet worst case: 3 signers (borrower 1 + co 2 + admin 3) ------
    // CCs must start after EVERY signer id (no collision) and the staffer whose
    // email equals the ADMIN counter-signer must be deduped out.
    console.log('\n3. term-sheet package: the LO SIGNS it, CC ids start after every signer, admin-email dedup');
    // buildDefinition uses the SEEDED admin-recipient email (it only re-resolves the
    // borrower/co emails from the file), so a TAG-scoped admin email is faithful and
    // avoids colliding with the DB's real counter-signer staff row.
    const adminEmail = `admin+${TAG}@ys.com`;
    // A staffer whose email == the admin counter-signer (must NOT be double-copied).
    await db.query(`INSERT INTO staff_users (id, email, full_name, role) VALUES ($1,$2,'Owner Admin','admin')`, [dupAdmin, adminEmail]);
    await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Chris','Co',$2)`, [cbId, `co+${TAG}@example.com`]);
    await db.query(`UPDATE applications SET co_borrower_id=$2 WHERE id=$1`, [appId, cbId]);
    await db.query(
      `INSERT INTO application_assignees (application_id, staff_id, role, is_primary)
       VALUES ($1,$2,'processor',false) ON CONFLICT DO NOTHING`, [appId, dupAdmin]).catch(() => {});
    // A stored term sheet (the only stored doc; app + disclosure are generated).
    // term_sheet_final=true because a sheet that prints "INITIAL TERM SHEET —
    // NOT FINAL" is refused by the send (owner-directed 2026-08-02) — this suite
    // is about the CC viewers, so it uses the sheet a ready file really carries.
    const fakeStorage = { async read() { return Buffer.from('%PDF-1.4 term-sheet'); } };
    await db.query(
      `INSERT INTO documents (application_id, filename, storage_provider, storage_ref, doc_kind, is_current, term_sheet_final)
       VALUES ($1,'ts.pdf','local','ref-ts','term_sheet',true,true)`, [appId]);
    const tsRow = (await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required)
       VALUES ($1,'term_sheet_package','not_sent',true) RETURNING *`, [appId])).rows[0];
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, is_countersigner, recipient_id_ds, borrower_id, name, email, embedded, client_user_id, status)
       VALUES ($1,'borrower',1,false,'1',$2,'Pat Borrower',$3,true,$4,'created'),
              ($1,'co_borrower',1,false,'2',$5,'Chris Co',$6,true,$7,'created'),
              ($1,'admin',2,true,'3',NULL,'YS Capital',$8,true,$9,'created')`,
      [tsRow.id, bId, `b+${TAG}@example.com`, `${tsRow.id}:borrower`,
       cbId, `co+${TAG}@example.com`, `${tsRow.id}:co_borrower`, adminEmail, `${tsRow.id}:admin`]);
    const tdef = await orchestrate.buildDefinition(tsRow, { db, storage: fakeStorage });
    const tcc = tdef.carbonCopies || [];
    const tccEmails = tcc.map((c) => c.email);
    // ON THE TERM SHEET THE LOAN OFFICER SIGNS — so they are deliberately NOT a CC
    // on it, and that is not a hole in "copied on every envelope". #1127 made the
    // LO a required SIGNER of this package (`loanOfficerRequired`, and in the tab
    // builder "LO signs the term sheet only"). A DocuSign recipient may not be both
    // a signer and a carbon copy of the same envelope, so buildDefinition's dedup
    // drops them from the CCs — the same rule this suite asserts two lines down and
    // in section 2. The officer still sees every envelope: a CC where they do not
    // sign, a signer here, which is the stronger seat.
    //
    // This block used to assert the pre-#1127 arrangement (LO copied). That
    // expectation and the change that contradicts it landed in the SAME commit
    // (cc78975), and the suite was never registered in the chain, so it was never
    // once seen to fail — it asserted the CC while also asserting, and passing,
    // that a signer is never CC'd.
    const tSignerEmails = (tdef.signers || []).map((s) => s.email);
    const maxSignerId = Math.max(0, ...(tdef.signers || []).map((s) => Number(s.recipientId) || 0));
    ok(tSignerEmails.includes(`lo+${TAG}@ys.com`), 'the loan officer SIGNS the term-sheet envelope');
    ok(!tccEmails.includes(`lo+${TAG}@ys.com`), '…and is therefore not ALSO copied on it (never double-booked)');
    ok(!tccEmails.includes(adminEmail), 'a staffer whose email equals the admin counter-signer is NOT copied (dedup)');
    ok(!tccEmails.includes(`b+${TAG}@example.com`) && !tccEmails.includes(`co+${TAG}@example.com`), 'neither signer is copied');
    ok(tcc.every((c) => Number(c.recipientId) > maxSignerId), 'CC recipientIds start after EVERY signer id — no collision');
    ok(tccEmails.includes(`pr+${TAG}@ys.com`), 'the processor — who does not sign — is still copied');

    // ---- 4. THEY ARE COPIED WHEN IT GOES OUT, NOT AFTER EVERYONE HAS SIGNED ----
    // The owner's actual words are "to be able to see when it's going OUT". DocuSign
    // emails a carbon copy when routing REACHES their order, so the old
    // max(signer routing order) put the processor at order 2 on the term sheet —
    // behind the admin counter-signer — i.e. they heard nothing until the borrower and
    // the loan officer had both already signed.
    console.log('\n4. viewers are copied at SEND time (owner item 23)');
    ok(tcc.length > 0 && tcc.every((c) => Number(c.routingOrder) === 1),
      'every CC sits at routing order 1, so DocuSign mails them as the envelope goes out');
    const maxSignerOrder = Math.max(1, ...(tdef.signers || []).map((s) => Number(s.routingOrder) || 1));
    ok(maxSignerOrder > 1, '…and the term sheet really does have a later signer (so this is not a vacuous check)');

    // ---- 5. THE DRAW COORDINATOR ON THE ORIGINATION PACKAGES -------------------
    // Owner-directed 2026-08-21, REVERSING the draw_request-only scoping of 2026-07-28:
    // "when you're sending out the term sheet package, when you're sending out the ISKA,
    // and when you're sending out the draw form, then the draw coordinator ... should be
    // looped in as viewers".
    console.log('\n5. the draw coordinator is copied on the term sheet (and deliberately NOT the Heter Iska)');
    const coordId = crypto.randomUUID();
    await db.query(`INSERT INTO staff_users (id, email, full_name, role) VALUES ($1,$2,'Cora Coordinator','draw_coordinator')`,
      [coordId, `dc+${TAG}@ys.com`]);
    // The file's OWN coordinator: whoever started its draw process (the durable per-file
    // record `drawCoordinatorsForFile` reads first).
    await db.query(
      `INSERT INTO sitewire_property_links (application_id, matched_by, draw_setup_started_by)
       VALUES ($1,'created',$2)
       ON CONFLICT (application_id) DO UPDATE SET draw_setup_started_by = EXCLUDED.draw_setup_started_by`,
      [appId, coordId]).catch(async () => {
        await db.query(`UPDATE sitewire_property_links SET draw_setup_started_by=$2 WHERE application_id=$1`, [appId, coordId]);
      });

    const tdef2 = await orchestrate.buildDefinition(tsRow, { db, storage: fakeStorage });
    const tcc2 = (tdef2.carbonCopies || []).map((c) => c.email);
    ok(tcc2.includes(`dc+${TAG}@ys.com`), 'the file’s draw coordinator is copied on the TERM SHEET package');
    // The Heter Iska envelope's roster was seeded in section 2, BEFORE section 3 gave the
    // application a co-borrower — and buildDefinition refuses a roster short of the file's
    // signers ("Recipient roster not fully seeded yet"). Seed the co-borrower onto it so the
    // build exercises the CC computation rather than dying on an unrelated guard.
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, recipient_id_ds, borrower_id, name, email, embedded, client_user_id, status)
       VALUES ($1,'co_borrower',1,'2',$2,'Chris Co',$3,true,$4,'created')
       ON CONFLICT DO NOTHING`,
      [envRowId, cbId, `co+${TAG}@example.com`, `${envRowId}:co_borrower`]).catch(() => {});
    /* THE HETER ISKA IS NARROWER (owner-directed 2026-08-26, superseding the
       2026-08-21 coordinator loop-in for THIS package only): "Only the loan
       officer and the processor and the borrower, obviously." So on the ISKA:
       no draw coordinator, and — the reported bug — no ADMIN, even one seated
       as an assignee (admin file-grants store them with aa.role='processor',
       so the filter must judge the STAFF role). dupAdmin (staff role 'admin',
       seated as a processor-assignee in section 3) is the exact fixture. */
    /* …PLUS THE LOAN OFFICER ASSISTANT (owner-directed 2026-09-02, on the new
       role: "add a loan officer assistant to this and also add them to the
       term sheet package as well"). Seated in THEIR OWN slot
       (aa.role='loan_officer_assistant', db/672) — the filter judges the staff
       role, so the slot must not matter. */
    await db.query(`INSERT INTO staff_users (id, email, full_name, role) VALUES ($1,$2,'Ari Assistant','loan_officer_assistant')`,
      [laId, `la+${TAG}@ys.com`]);
    await db.query(
      `INSERT INTO application_assignees (application_id, staff_id, role, is_primary)
       VALUES ($1,$2,'loan_officer_assistant',false) ON CONFLICT DO NOTHING`, [appId, laId]).catch(() => {});
    const idef = await orchestrate.buildDefinition(row, { db });
    const iskaCc = (idef.carbonCopies || []).map((c) => c.email);
    ok(!iskaCc.includes(`dc+${TAG}@ys.com`),
      'the draw coordinator is NOT copied on the HETER ISKA (owner-directed 2026-08-26 — ISKA is LO + processor + borrower only)');
    ok(!iskaCc.includes(adminEmail),
      'an ADMIN seated as an assignee is NOT copied on the HETER ISKA — the "Esther and Yehuda get every signed ISKA" report, fixed');
    ok(iskaCc.includes(`lo+${TAG}@ys.com`) && iskaCc.includes(`pr+${TAG}@ys.com`),
      '…while the loan officer and the processor still are');
    ok(iskaCc.includes(`la+${TAG}@ys.com`),
      '…and so is the LOAN OFFICER ASSISTANT seated on the file (owner-directed 2026-09-02)');

    // THE DESK FALLBACK MUST NOT REACH AN ORIGINATION PACKAGE. A file has no draw
    // project until it FUNDS, so at term-sheet time the file has no coordinator EVERY
    // time — and drawEnvelopeViewers' fallback would put the whole draw desk plus the
    // shared draws@ inbox on every borrower's loan documents. That is not "the draw
    // coordinator"; it is the entire servicing desk.
    const dr = require(REPO + '/src/lib/draw-recipients');
    await db.query(`UPDATE sitewire_property_links SET draw_setup_started_by=NULL WHERE application_id=$1`, [appId]);
    const tdef3 = await orchestrate.buildDefinition(tsRow, { db, storage: fakeStorage });
    const tcc3 = (tdef3.carbonCopies || []).map((c) => c.email);
    ok(!tcc3.includes(dr.DRAW_DESK_INBOX), 'with NO coordinator assigned, the shared draws@ inbox is NOT on the term sheet');
    ok(!tcc3.includes(`dc+${TAG}@ys.com`), '…and neither is the desk-wide coordinator who was never assigned to this file');
    ok(tcc3.includes(`la+${TAG}@ys.com`),
      'the LOAN OFFICER ASSISTANT seated on the file IS copied on the TERM SHEET PACKAGE (owner-directed 2026-09-02 — every active assignee rides along, the assistant among them)');
    ok(tcc3.includes(`pr+${TAG}@ys.com`), '…beside the processor, as before');
    // …while the WIRE FORM keeps its cover, which is the 2026-07-28 rule and is unchanged.
    const deskViewers = (await dr.drawEnvelopeViewers(appId)).map((v) => v.email);
    ok(deskViewers.includes(dr.DRAW_DESK_INBOX), 'the WIRE FORM resolver still falls back to the desk (never uncovered)');
    ok((await dr.drawEnvelopeViewersAssigned(appId)).length === 0, 'the assigned-only resolver answers nobody rather than inventing the desk');

    // ---- 6. THE TEST-MODE GATE SEES THE CARBON COPIES --------------------------
    // A CC is a real DocuSign recipient. The gate's contract is "refuse to mail ANYONE
    // not on the allow-list", and it only ever read inputs.signers — so every viewer on
    // every envelope was mailed from the demo host while the guard reported it safe.
    console.log('\n6. the demo/test-mode gate refuses an off-allowlist VIEWER');
    {
      const sendMod = require(REPO + '/src/lib/esign/send');
      const cfgDs = require(REPO + '/src/config').docusign;
      const prevMode = cfgDs.testMode, prevAllow = cfgDs.testEmailAllowlist;
      // A demo-host stub, so this proves the GATE rather than whichever host the suite ran on.
      const dsStub = { isDemoHost: () => true };
      cfgDs.testMode = true;
      cfgDs.testEmailAllowlist = ['allowed@ys.com'];
      try {
        let threw = null;
        try { sendMod.guardTestEmails(dsStub, [{ email: 'allowed@ys.com' }]); } catch (e) { threw = e; }
        ok(threw === null, 'an allow-listed signer passes the gate (the control)');

        threw = null;
        try {
          sendMod.guardTestEmails(dsStub, [{ email: 'allowed@ys.com' }, { email: `dc+${TAG}@ys.com` }]);
        } catch (e) { threw = e; }
        ok(threw && threw.code === 'DOCUSIGN_TEST_EMAIL_BLOCKED',
          'an off-allowlist VIEWER is refused — a carbon copy is a real DocuSign recipient');
        ok(threw && threw.retryable === false, '…permanently, until the allow-list or go-live flag changes');

        // And the send really does hand its CCs to the gate (a behaviour test cannot see the
        // call site, and the call site is exactly what was wrong).
        const callSites = require('fs').readFileSync(REPO + '/src/lib/esign/send.js', 'utf8')
          .split('\n').filter((l) => l.includes('guardTestEmails(') && !/^\s*(function|\s*\*)/.test(l) && !l.includes('module.exports'));
        ok(callSites.length > 0, 'the gate is actually called on the send path');
        // EVERY call site, not the first — a second send path added later that passes only the
        // signers would re-open exactly the hole this closes.
        ok(callSites.every((l) => l.includes('inputs.carbonCopies')),
          'every call passes the carbon copies through that gate, not just the signers');
      } finally { cfgDs.testMode = prevMode; cfgDs.testEmailAllowlist = prevAllow; }
    }

    // ---- 7. EVERY PACKAGE HAS A NAME IN THE NOTICES --------------------------
    // Two hand-kept copies of a purpose->label map lived in webhook.js and dead-letter.js
    // and had both gone stale: neither knew about `draw_request`, so a draw-form terminal
    // or dead-letter alert called it the generic "e-signature package" — on the one
    // notification whose job is to say WHICH document needs attention.
    console.log('\n7. every package is named in the staff notices');
    {
      const fs = require('fs');
      for (const purpose of Object.keys(orchestrate.PACKAGES)) {
        const lbl = orchestrate.packageLabel(purpose);
        ok(!!lbl && lbl !== 'e-signature package', `the ${purpose} package has a name of its own ("${lbl}")`);
      }
      ok(orchestrate.packageLabel('nope') === 'e-signature package', 'an unknown purpose falls back rather than throwing');
      // …and neither consumer may grow a second copy of that map again.
      for (const f of ['webhook.js', 'dead-letter.js']) {
        ok(!/PURPOSE_LABEL\s*=/.test(fs.readFileSync(`${REPO}/src/lib/esign/${f}`, 'utf8')),
          `${f} reads the shared label, never its own copy`);
      }
    }

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  } finally {
    if (appId) await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [appId]).catch(() => {});
    if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [[bId, cbId]]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE role='draw_coordinator' AND email LIKE $1`, [`dc+${TAG}@%`]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[loId, prId, dupAdmin, laId]]).catch(() => {});
    await db.pool.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

/**
 * DB + HTTP test for the As-Is read → apply → condition flow (owner-directed 2026-07-28).
 *
 * Boots the real Express app and drives the real endpoints against a real Postgres. It proves the
 * things a pure test CANNOT: that the write actually lands on `applications`, that the reprice
 * trigger fires, that the condition materializes with the right wording, that the sign-off gate
 * refuses an empty As-Is, and that a frozen file is genuinely left alone.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-as-is-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const desk = require('../src/lib/appraisal/desk');
const asIsDesk = require('../src/lib/appraisal/as-is-desk');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch (_) { return null; } })() })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// A reader stub: a PDF whose text says what we tell it to. Used to exercise the OCR branch without
// a network call or a real PDF.
const pdfDeps = (text) => ({
  ocrRouter: { configured: () => true, read: async () => ({ ok: true, text, engine: 'azure-docint', pageCount: 12 }) },
  legacyOcr: { ocrSpaceText: async () => ({ ok: false, reason: 'not used' }) },
  analyzer: { available: () => false, extract: async () => ({ ok: false }) },
});

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let adminId, borrowerId;

  // Make a file + an appraisal row. `xmlAsIs` null = the data file was silent (the OCR path).
  const mkFile = async (opts = {}) => {
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, purchase_price, as_is_value, arv, property_address, loan_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'rtl') RETURNING id`,
      [borrowerId, adminId, opts.status || 'processing', opts.purchasePrice, opts.fileAsIs == null ? null : opts.fileAsIs,
       opts.arv == null ? null : opts.arv, JSON.stringify({ line1: '12 Test St', city: 'Lakewood', state: 'NJ' })])).rows[0].id;
    await db.query(
      `INSERT INTO appraisals (application_id, form_type, as_is_value, as_is_confidence, arv_value, arv_confidence, condition_of_appraisal, superseded, imported_at)
       VALUES ($1,'FNM1004',$2,$3,$4,$5,$6,false,now())`,
      [appId, opts.xmlAsIs == null ? null : opts.xmlAsIs, opts.xmlAsIs == null ? 'missing' : 'definite',
       opts.apprArv === undefined ? (opts.arv == null ? null : opts.arv) : opts.apprArv,
       opts.apprArvConfidence || 'definite', opts.basis || 'SubjectToRepairs']);
    return appId;
  };
  const fileArv = async (appId) => {
    const r = (await db.query(`SELECT arv FROM applications WHERE id=$1`, [appId])).rows[0];
    return r.arv == null ? null : Number(r.arv);
  };
  const fileAsIs = async (appId) => {
    const r = (await db.query(`SELECT as_is_value FROM applications WHERE id=$1`, [appId])).rows[0];
    return r.as_is_value == null ? null : Number(r.as_is_value);
  };
  const cond = async (appId) => (await db.query(
    `SELECT ci.id, ci.status, ci.notes, ci.hint, ci.signed_off_at FROM checklist_items ci
       JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code='appraisal_as_is_verify'`, [appId])).rows[0] || null;

  try {
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'As-Is Admin','super_admin',true,false,'x',0) RETURNING id`, [`asis-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('AsIs','Test',$1) RETURNING id`, [`asis-bo-${sfx}@test.local`])).rows[0].id;

    // =====================================================================
    // 1. The owner's headline case — the appraisal reads BELOW the purchase
    //    price, so the file's As-Is comes DOWN and a condition explains it.
    // =====================================================================
    {
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 500000, arv: 620000, xmlAsIs: 430000 });
      // A Products & Pricing condition that has ALREADY been signed off — lowering the As-Is must
      // reopen it through the existing reprice trigger (db/072), or the loan would stay priced off
      // the higher value.
      const priceItem = (await db.query(
        `INSERT INTO checklist_items (scope, application_id, label, status, item_kind, tool_key, signed_off_by, signed_off_at)
         VALUES ('application',$1,'Products & Pricing','satisfied','condition','product_pricing',$2,now()) RETURNING id`,
        [appId, adminId])).rows[0].id;

      const out = await desk.runAsIsRead(appId, {});
      assert(out.ran && out.applied, 'a definite XML As-Is below the purchase price is APPLIED');
      assert((await fileAsIs(appId)) === 430000, 'the file’s As-Is was lowered 500,000 → 430,000');

      const c = await cond(appId);
      assert(!!c, 'the "Confirm the As-Is value" condition was materialized');
      assert(/^\[auto\]/.test(c.notes || ''), 'the note is [auto]-guarded');
      assert(/lowered/i.test(c.notes) && /430,000/.test(c.notes) && /500,000/.test(c.notes), 'the note names both the old and the new value');
      assert(/re-review/i.test(c.notes), 'the note invites a human re-review');

      const a = (await db.query(
        `SELECT as_is_read_value, as_is_read_source, as_is_read_confidence, as_is_applied, as_is_applied_value, as_is_file_value_before
           FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId])).rows[0];
      assert(Number(a.as_is_read_value) === 430000 && a.as_is_read_source === 'xml' && a.as_is_read_confidence === 'definite',
        'the reading is recorded on the appraisal row');
      assert(a.as_is_applied === true && Number(a.as_is_applied_value) === 430000 && Number(a.as_is_file_value_before) === 500000,
        'what PILOT DID with the reading is recorded too');

      const aud = (await db.query(
        `SELECT detail FROM audit_log WHERE action='appraisal_as_is_auto_applied' AND entity_id=$1`, [appId])).rows[0];
      assert(!!aud && Number(aud.detail.to) === 430000 && Number(aud.detail.from) === 500000, 'the write is audited with from → to');

      const pr = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [priceItem])).rows[0];
      assert(pr.status === 'received' && pr.signed_off_at == null,
        'lowering the As-Is REOPENED Products & Pricing — the loan has to be re-priced on the lower value');


      // The internal read-out the officer sees.
      const st = await call(server, 'GET', `/api/appraisal/${appId}/as-is`, token);
      assert(st.status === 200 && st.json.read && Number(st.json.read.value) === 430000 && st.json.read.applied === true,
        'GET /as-is returns what came in and that it was applied');
      assert(Number(st.json.file.asIs) === 430000 && Number(st.json.file.purchasePrice) === 450000, 'GET /as-is returns the file’s own numbers');

      // Idempotent: reading again changes nothing (it is no longer a reduction).
      const again = await desk.runAsIsRead(appId, {});
      assert(!again.applied && again.why === 'same_value', 're-reading the same appraisal does not write again (the file already agrees)');
      assert((await fileAsIs(appId)) === 430000, 'the value is unchanged by a second read');
    }

    // =====================================================================
    // 2. Every refusal path leaves the file ALONE.
    // =====================================================================
    {
      // The owner's correction (2026-07-28): confidence is the whole rule. An appraisal that reads
      // ABOVE the purchase price is still the appraisal — it gets written.
      const appId = await mkFile({ purchasePrice: 400000, fileAsIs: 500000, arv: 620000, xmlAsIs: 460000 });
      const out = await desk.runAsIsRead(appId, {});
      assert(out.applied && (await fileAsIs(appId)) === 460000, 'an As-Is ABOVE the purchase price is written (below-price is no longer a gate)');
    }
    {
      // …and so is one that RAISES the file's value. The reduction-only guard is gone.
      const appId = await mkFile({ purchasePrice: 500000, fileAsIs: 400000, arv: 620000, xmlAsIs: 440000 });
      const priceItem = (await db.query(
        `INSERT INTO checklist_items (scope, application_id, label, status, item_kind, tool_key, signed_off_by, signed_off_at)
         VALUES ('application',$1,'Products & Pricing','satisfied','condition','product_pricing',$2,now()) RETURNING id`,
        [appId, adminId])).rows[0].id;
      const out = await desk.runAsIsRead(appId, {});
      assert(out.applied && (await fileAsIs(appId)) === 440000, 'a HIGHER confident reading IS written now');
      const c = await cond(appId);
      assert(/RAISED/.test(c.notes), 'the condition says plainly that PILOT raised the value');
      const pr = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [priceItem])).rows[0];
      assert(pr.status === 'received' && pr.signed_off_at == null,
        'a RAISE also reopens Products & Pricing — the loan amount cannot move until a human re-registers');
    }
    {
      // The appraisal agrees with the file: nothing written, and NO condition raised. This is the
      // only settled state, and it is what keeps the conditions list quiet on a clean file.
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 430000, arv: 620000, xmlAsIs: 430000 });
      const out = await desk.runAsIsRead(appId, {});
      assert(!out.applied && out.why === 'same_value', 'a reading the file already matches is not rewritten');
      assert((await cond(appId)) === null, 'an agreeing, confident reading raises NO condition — nothing for anyone to do');
    }
    {
      // A funded file is structurally locked for everyone — PILOT included.
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 500000, arv: 620000, xmlAsIs: 430000, status: 'funded' });
      const out = await desk.runAsIsRead(appId, {});
      assert(!out.applied && out.why === 'file_locked', 'a frozen (funded) file is never written to automatically');
      assert((await fileAsIs(appId)) === 500000, 'the frozen file’s value is untouched');
      const c = await cond(appId);
      assert(!!c && /locked/i.test(c.notes), 'the condition explains that the file is locked, so a human can decide');
    }

    // =====================================================================
    // 3. The OCR path — the data file was silent and the value is only in the
    //    report PDF (the owner's "it's just a note on the appraisal report").
    // =====================================================================
    {
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: null, arv: 620000, xmlAsIs: null });
      const text = ['RECONCILIATION', "The 'as is' market value of the subject property is $415,000.",
        'The subject-to-repairs value upon completion is $620,000.'].join('\n');
      const out = await asIsDesk.settleAsIs(appId, {
        pdfBase64: 'x', deps: pdfDeps(text),
        ensureCondition: (id) => desk.ensureAppraisalCondition(id, 'appraisal_as_is_verify'),
      });
      assert(out.applied && out.source === 'pdf_text', 'an As-Is read off the PDF with OCR is applied');
      assert((await fileAsIs(appId)) === 415000, 'the blank As-Is was filled from the PDF read');
      const a = (await db.query(`SELECT as_is_read_engine, as_is_read_quote FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId])).rows[0];
      assert(a.as_is_read_engine === 'azure-docint', 'the OCR engine that read it is recorded');
      assert(/as is/i.test(a.as_is_read_quote || ''), 'the exact wording it was read from is recorded');
      assert(!/620,000/.test(a.as_is_read_quote || ''), 'the after-repair value never appears as the as-is reading');
    }
    {
      // Nothing readable anywhere → NOTHING is written and the condition asks a human.
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: null, arv: 620000, xmlAsIs: null });
      const out = await asIsDesk.settleAsIs(appId, {
        pdfBase64: 'x', deps: pdfDeps('Gross living area 1,850 sq ft. Condition C4. Effective date 05/12/2026.'),
        ensureCondition: (id) => desk.ensureAppraisalCondition(id, 'appraisal_as_is_verify'),
      });
      assert(!out.applied && out.value == null, 'an unreadable As-Is writes nothing — never a guess');
      assert((await fileAsIs(appId)) === null, 'the file’s As-Is stays blank');
      const c = await cond(appId);
      assert(!!c && /could not confidently read/i.test(c.notes), 'the condition says plainly that PILOT could not read it');
      assert(/type it in the box/i.test(c.notes), 'the condition tells the human to enter the value');

      // ---- the sign-off gate: it cannot be cleared with no As-Is on the file ----
      await db.query(`UPDATE checklist_items SET status='received' WHERE id=$1`, [c.id]);
      const blocked = await call(server, 'PATCH', `/api/staff/checklist/${c.id}`, token, { signedOff: true });
      assert(blocked.status === 422 && /Enter the As-Is value/i.test(blocked.body),
        'the condition CANNOT be signed off while the file has no As-Is value (even as super_admin)');

      // ---- the internal field: a human types the value ----
      const bad = await call(server, 'POST', `/api/appraisal/${appId}/as-is`, token, { value: 'abc' });
      assert(bad.status === 400, 'a non-numeric entry is refused');
      const set = await call(server, 'POST', `/api/appraisal/${appId}/as-is`, token, { value: '408,000' });
      assert(set.status === 200 && set.json.value === 408000, 'an officer can type the As-Is (commas and $ tolerated)');
      assert((await fileAsIs(appId)) === 408000, 'the typed value landed on the file');
      const audited = (await db.query(`SELECT 1 FROM audit_log WHERE action='appraisal_as_is_entered' AND entity_id=$1`, [appId])).rows[0];
      assert(!!audited, 'the human entry is audited');

      const okNow = await call(server, 'PATCH', `/api/staff/checklist/${c.id}`, token, { signedOff: true });
      assert(okNow.status === 200, 'once the As-Is is entered the condition can be signed off');
    }

    // =====================================================================
    // 2b. An appraisal that may not even be about THIS property is never
    //     adopted from — the desk already raises a fatal identity finding.
    // =====================================================================
    {
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 500000, arv: 620000, xmlAsIs: 430000 });
      const appraisalId = (await db.query(
        `SELECT id FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId])).rows[0].id;
      await db.query(
        `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, field, title, how_to, blocks_ctc, status)
         VALUES ($1,$2,'appraisal','address_mismatch','fatal','address','Address differs from the file','Check the report',true,'open')`,
        [appraisalId, appId]);
      const out = await desk.runAsIsRead(appId, {});
      assert(!out.applied && out.why === 'appraisal_identity_mismatch',
        'a fatal address mismatch stops the automatic write — we may be holding a report for another property');
      assert((await fileAsIs(appId)) === 500000, 'the file value is untouched while the appraisal identity is in doubt');
      const c = await cond(appId);
      assert(!!c && /does not match the property/i.test(c.notes), 'the condition explains the mismatch so a human sorts it out first');

      // Resolve the mismatch and the same reading goes through.
      await db.query(`UPDATE appraisal_findings SET status='resolved' WHERE application_id=$1 AND code='address_mismatch'`, [appId]);
      const after = await desk.runAsIsRead(appId, {});
      assert(after.applied && (await fileAsIs(appId)) === 430000, 'once the identity finding is resolved the reading is applied');
    }

    // =====================================================================
    // 3b. Undoing a WRONG appraisal must take its As-Is back off the file —
    //     including one PILOT read off the PDF, which lives nowhere else.
    // =====================================================================
    {
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 500000, arv: 620000, xmlAsIs: null });
      await asIsDesk.settleAsIs(appId, {
        pdfBase64: 'x', deps: pdfDeps("The 'as is' market value is $402,000."),
        ensureCondition: (id) => desk.ensureAppraisalCondition(id, 'appraisal_as_is_verify'),
      });
      assert((await fileAsIs(appId)) === 402000, 'the PDF-read As-Is was applied (500,000 → 402,000)');
      const undone = await desk.undoAppraisalImport(appId, {});
      assert(undone.ok, 'the appraisal import was undone');
      assert((await fileAsIs(appId)) === 500000, 'undoing the appraisal put the As-Is back to what the file said before');
      assert((await cond(appId)) === null, 'the As-Is condition is removed with the appraisal it belonged to');
    }
    {
      // ...but a human's later correction is NOT reverted by an undo — it was never PILOT's value.
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 500000, arv: 620000, xmlAsIs: null });
      await asIsDesk.settleAsIs(appId, {
        pdfBase64: 'x', deps: pdfDeps("The 'as is' market value is $402,000."),
        ensureCondition: (id) => desk.ensureAppraisalCondition(id, 'appraisal_as_is_verify'),
      });
      await asIsDesk.setAsIsByHuman(appId, 418000, { actorId: adminId });
      await desk.undoAppraisalImport(appId, {});
      assert((await fileAsIs(appId)) === 418000, 'an undo never reverts a value a human typed afterwards');
    }

    // =====================================================================
    // 4. A human's value WINS over PILOT, and a fresh reduction reopens the
    //    condition so the sign-off can never attest to a stale number.
    // =====================================================================
    {
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 500000, arv: 620000, xmlAsIs: 430000 });
      await desk.runAsIsRead(appId, {});
      const c1 = await cond(appId);
      await call(server, 'PATCH', `/api/staff/checklist/${c1.id}`, token, { signedOff: true });
      assert((await cond(appId)).signed_off_at != null, 'the condition is signed off after the re-review');

      // A corrected appraisal comes in reading lower still.
      await db.query(`UPDATE appraisals SET as_is_value=395000 WHERE application_id=$1 AND superseded=false`, [appId]);
      await db.query(`UPDATE appraisals SET as_is_read_at=NULL WHERE application_id=$1 AND superseded=false`, [appId]);
      const out = await desk.runAsIsRead(appId, {});
      assert(out.applied && (await fileAsIs(appId)) === 395000, 'a further reduction is applied');
      const c2 = await cond(appId);
      assert(c2.signed_off_at == null && c2.status === 'outstanding', 'the condition REOPENS — a stale sign-off can never stand on a changed value');

      // The officer overrules PILOT.
      const set = await call(server, 'POST', `/api/appraisal/${appId}/as-is`, token, { value: 470000 });
      assert(set.status === 200 && (await fileAsIs(appId)) === 470000, 'a human can overwrite PILOT’s value, up or down');
      const st = await call(server, 'GET', `/api/appraisal/${appId}/as-is`, token);
      assert(st.json.confirmed && Number(st.json.confirmed.value) === 470000, 'the human confirmation is recorded and shown');
    }

    // =====================================================================
    // 4b. A HUMAN'S DECISION IS FINAL — the audit's sharpest finding. The
    //     "Read the appraisal again" button sits one control from the box the
    //     officer types in; it must never undo them.
    // =====================================================================
    {
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: null, arv: 620000, xmlAsIs: 312500 });
      await desk.runAsIsRead(appId, {});
      assert((await fileAsIs(appId)) === 312500, 'PILOT filled the blank As-Is');
      // The officer reads the report and types the real number.
      const set = await call(server, 'POST', `/api/appraisal/${appId}/as-is`, token, { value: 470000 });
      assert(set.status === 200 && (await fileAsIs(appId)) === 470000, 'the officer’s value is on the file');
      // …and now clicks "Read the appraisal again".
      const again = await call(server, 'POST', `/api/appraisal/${appId}/as-is/read`, token);
      assert(again.status === 200 && again.json.applied === false && again.json.why === 'human_decided',
        'a re-read REFUSES to overwrite a value a human typed');
      assert((await fileAsIs(appId)) === 470000, 'the officer’s value survives the re-read');
      const c = await cond(appId);
      assert(/by hand/i.test(c.notes) && /left it alone/i.test(c.notes), 'the condition says PILOT left the human’s value alone');
    }
    {
      // The same protection for an underwriter who resolved the asis_mismatch finding with KEEP —
      // they looked at both numbers and decided the file's value stands.
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 500000, arv: 620000, xmlAsIs: 430000 });
      const appraisalId = (await db.query(`SELECT id FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId])).rows[0].id;
      await db.query(
        `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, field, appraisal_value, file_value, title, how_to, blocks_ctc, status, resolution, resolved_at)
         VALUES ($1,$2,'appraisal','asis_mismatch','fatal','as_is_value','430000','500000','As-Is differs','x',true,'resolved','keep',now())`,
        [appraisalId, appId]);
      const out = await desk.runAsIsRead(appId, {});
      assert(!out.applied && out.why === 'human_decided', 'a KEEP resolution of the As-Is finding stops the automatic write');
      assert((await fileAsIs(appId)) === 500000, 'the underwriter’s decision stands');
    }

    // =====================================================================
    // 4c. A FAILED read must not drain the file out of the sweep, and a
    //     second read must not erase the record undo depends on.
    // =====================================================================
    {
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 500000, arv: 620000, xmlAsIs: null });
      const down = {
        ocrRouter: { configured: () => true, read: async () => ({ ok: false, reason: 'service unavailable' }) },
        legacyOcr: { ocrSpaceText: async () => ({ ok: false, reason: 'down too' }) },
        analyzer: { available: () => false, extract: async () => ({ ok: false }) },
      };
      await asIsDesk.settleAsIs(appId, { pdfBase64: 'x', deps: down, ensureCondition: (id) => desk.ensureAppraisalCondition(id, 'appraisal_as_is_verify') });
      const a = (await db.query(`SELECT as_is_read_at FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId])).rows[0];
      assert(a.as_is_read_at == null, 'an OCR OUTAGE does not stamp the file as read — the sweep will retry it');
    }
    {
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: null, arv: 620000, xmlAsIs: null });
      const deps = pdfDeps("RECONCILIATION. The 'as is' market value of the subject property is $402,000 as of the effective date.");
      const ec = (id) => desk.ensureAppraisalCondition(id, 'appraisal_as_is_verify');
      await asIsDesk.settleAsIs(appId, { pdfBase64: 'x', deps, ensureCondition: ec });
      assert((await fileAsIs(appId)) === 402000, 'the PDF read was applied');
      // A SECOND read of the same file now returns same_value — it must not erase the applied stamp.
      await asIsDesk.settleAsIs(appId, { pdfBase64: 'x', deps, ensureCondition: ec });
      const a = (await db.query(
        `SELECT as_is_applied, as_is_applied_value FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId])).rows[0];
      assert(a.as_is_applied === true && Number(a.as_is_applied_value) === 402000,
        'a second read does NOT downgrade the applied stamp');
      await desk.undoAppraisalImport(appId, {});
      assert((await fileAsIs(appId)) === null, 'undo still takes the PDF-read value back off the file after a second read');
    }

    // =====================================================================
    // 4d. THE ARV IS WRITTEN TOO (owner-directed 2026-07-28) — straight from the
    //     data file, no OCR, on the same import.
    // =====================================================================
    {
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 500000, arv: 575000, apprArv: 620000, xmlAsIs: 430000 });
      const priceItem = (await db.query(
        `INSERT INTO checklist_items (scope, application_id, label, status, item_kind, tool_key, signed_off_by, signed_off_at)
         VALUES ('application',$1,'Products & Pricing','satisfied','condition','product_pricing',$2,now()) RETURNING id`,
        [appId, adminId])).rows[0].id;

      const out = await desk.runAsIsRead(appId, {});
      assert(out.arvApplied && (await fileArv(appId)) === 620000, 'the appraisal’s ARV was written onto the file (575,000 → 620,000)');
      assert(out.applied && (await fileAsIs(appId)) === 430000, 'the As-Is was written in the same pass');
      const c = await cond(appId);
      assert(/ARV/.test(c.notes) && /620,000/.test(c.notes), 'the condition reports the ARV change');
      assert(/no OCR was involved/i.test(c.notes), 'the condition says the ARV came straight from the data file');
      const aud = (await db.query(`SELECT detail FROM audit_log WHERE action='appraisal_arv_auto_applied' AND entity_id=$1`, [appId])).rows[0];
      assert(!!aud && Number(aud.detail.to) === 620000, 'the ARV write is audited');
      const pr = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [priceItem])).rows[0];
      assert(pr.status === 'received', 'the ARV write reopened Products & Pricing too');

      // Idempotent.
      const again = await desk.runAsIsRead(appId, {});
      assert(!again.arvApplied && again.arvWhy === 'same_value', 'a second read does not rewrite the same ARV');
    }
    {
      // A NON-definite ARV is never written — there is no OCR fallback for the ARV.
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 430000, arv: 575000, apprArv: 620000, apprArvConfidence: 'missing', xmlAsIs: 430000 });
      const out = await desk.runAsIsRead(appId, {});
      assert(!out.arvApplied && out.arvWhy === 'not_confident', 'a non-definite ARV is left alone');
      assert((await fileArv(appId)) === 575000, 'the file’s ARV is untouched');
    }
    {
      // An underwriter who resolved arv_mismatch with KEEP has decided; a re-read must not undo it.
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 430000, arv: 575000, apprArv: 620000, xmlAsIs: 430000 });
      const appraisalId = (await db.query(`SELECT id FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId])).rows[0].id;
      await db.query(
        `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, field, appraisal_value, file_value, title, how_to, blocks_ctc, status, resolution, resolved_at)
         VALUES ($1,$2,'appraisal','arv_mismatch','fatal','arv','620000','575000','ARV differs','x',true,'resolved','keep',now())`,
        [appraisalId, appId]);
      const out = await desk.runAsIsRead(appId, {});
      assert(!out.arvApplied && out.arvWhy === 'human_decided', 'a KEEP resolution of the ARV finding stops the ARV write');
      assert((await fileArv(appId)) === 575000, 'the underwriter’s ARV stands');
    }
    {
      // Undo takes the written ARV back off the file.
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 430000, arv: 575000, apprArv: 620000, xmlAsIs: 430000 });
      await desk.runAsIsRead(appId, {});
      assert((await fileArv(appId)) === 620000, 'the ARV was written');
      await desk.undoAppraisalImport(appId, {});
      assert((await fileArv(appId)) === 575000, 'undo put the ARV back to what the file said before');
    }

    // =====================================================================
    // 5. Previous files: the boot sweep reads appraisals imported before this
    //    existed, and drains itself.
    // =====================================================================
    {
      const appId = await mkFile({ purchasePrice: 450000, fileAsIs: 500000, arv: 620000, xmlAsIs: 430000 });
      // A pre-existing appraisal has never been read.
      assert((await db.query(`SELECT as_is_read_at FROM appraisals WHERE application_id=$1`, [appId])).rows[0].as_is_read_at == null,
        'the appraisal starts unread');
      const r1 = await desk.backfillAsIsReadsOnce({ freeLimit: 50, pdfLimit: 0 });
      assert(r1.free >= 1, 'the free (XML) tier of the sweep read at least this file');
      assert((await fileAsIs(appId)) === 430000, 'the sweep applied the owner’s rule to a previously-imported appraisal');
      const stamped = (await db.query(`SELECT as_is_read_at FROM appraisals WHERE application_id=$1`, [appId])).rows[0].as_is_read_at;
      assert(stamped != null, 'the sweep stamps the row so it drains out of the queue');
      const before = r1.free;
      const r2 = await desk.backfillAsIsReadsOnce({ freeLimit: 50, pdfLimit: 0 });
      assert(r2.free < before || r2.free === 0, 'the sweep self-terminates — an already-read appraisal is not re-read');
    }

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL As-Is DB assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) { /* cleanup */ }
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) { /* cleanup */ }
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();

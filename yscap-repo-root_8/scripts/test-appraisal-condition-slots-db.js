'use strict';
/**
 * THE RETURNED APPRAISAL LANDS IN THE CONDITION'S OWN SLOTS — for every vendor.
 *
 * The bug this pins (owner-reported 2026-08-16, "the PDF goes where the PDF
 * belongs in the condition, the XML goes in the condition"): AppraisalScope / NAN
 * and Class Valuation filed their returned XML + PDF with `slot_label` NULL, so
 * the appraisal-documents condition — which matches a document to a slot by a
 * lower-case SUBSTRING of that label — saw neither, and `signOffGate` went on
 * refusing the condition with both documents sitting on the file.
 *
 * The proof runs the REAL `signOffGate` out of `routes/staff.js`, not a copy of
 * its slot test: a test that re-typed the gate's query would keep passing if the
 * gate changed. It asserts the refusal FIRST (the state before this fix), then
 * the ingest, then the clearance — so a regression that stops filing the slot
 * shows up as the gate refusing a file whose appraisal is demonstrably back.
 *
 * DB-gated; skips cleanly without DATABASE_URL. Fixtures are committed (the gate
 * reads through the pool, not a caller's transaction) and deleted at the end.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-appraisal-condition-slots-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const db = require(path.join(ROOT, 'src/db'));
const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
const staffRoutes = require(path.join(ROOT, 'src/routes/staff'));
const amcSync = require(path.join(ROOT, 'src/amc/sync'));
const classDocs = require(path.join(ROOT, 'src/class/documents'));
const conditionSlots = require(path.join(ROOT, 'src/lib/appraisal/condition-slots'));

let n = 0, failures = 0;
const ok = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const tag = `${process.pid}${Date.now()}`;

const XML_BYTES = Buffer.from('<?xml version="1.0"?><VALUATION_RESPONSE/>');
const PDF_BYTES = Buffer.from('%PDF-1.4 fake report');

async function seedFile(label) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Slot','Test',$1) RETURNING id`,
    [`slots_${tag}_${label}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, status, ys_loan_number, property_address)
     VALUES ($1,'underwriting',$2,'{"street":"1 St","city":"NYC","state":"NY","zip":"10001"}') RETURNING id`,
    [bor.id, `YSCAP-SLOT-${label}-${tag}`.slice(0, 40)])).rows[0];
  // The appraisal-documents condition, as the checklist generator creates it.
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'processor'),
            t.phase, true, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code='rtl_cond_appraisaldocs' RETURNING id`, [app.id])).rows[0];
  return { borId: bor.id, appId: app.id, itemId: item.id };
}

// The state a real file is in the moment the report comes back: the XML imported,
// so a current appraisal row exists (the gate requires it before it will clear).
async function markImported(appId) {
  await db.query(
    `INSERT INTO appraisals (application_id, superseded, form_type, imported_at)
     VALUES ($1,false,'FNM1004',now())`, [appId]);
}

async function docsOn(itemId) {
  return (await db.query(
    `SELECT filename, slot_label, doc_kind, review_status, checklist_item_id
       FROM documents WHERE checklist_item_id=$1 AND is_current ORDER BY filename`, [itemId])).rows;
}

(async () => {
  await ensureSchema();
  const cleanupApps = [], cleanupBors = [];
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Slot Tester','processor',true) RETURNING id`,
    [`slotstaff_${tag}@example.com`])).rows[0];

  // ===================================================================
  // A. The slot labels are DERIVED from the condition's own template.
  // ===================================================================
  {
    const labels = await conditionSlots.slotLabels(db);
    ok(String(labels.xml).toLowerCase().includes('xml'), 'A1: the derived XML slot label carries the substring the gate tests for');
    ok(String(labels.pdf).toLowerCase().includes('pdf'), 'A2: the derived PDF slot label carries the substring the gate tests for');
    const tmpl = (await db.query(`SELECT slots FROM checklist_templates WHERE code='rtl_cond_appraisaldocs'`)).rows[0];
    const declared = (tmpl && Array.isArray(tmpl.slots) ? tmpl.slots : []).map((s) => s.label);
    ok(declared.includes(labels.xml) && declared.includes(labels.pdf),
      'A3: both labels are the ones the template actually declares (derived, not restated)');
  }

  // ===================================================================
  // B. AppraisalScope / NAN — the report comes back and clears the condition.
  // ===================================================================
  {
    const f = await seedFile('amc');
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);

    // The gate refuses BEFORE anything is filed — the control, so a later PASS
    // cannot be an accident of a gate that clears everything.
    let g = await staffRoutes.signOffGate(f.itemId, { id: staff.id });
    ok(typeof g === 'string' && /XML/i.test(g), 'B1: the condition refuses sign-off with nothing filed (control)');

    // An order placed with NO checklist link at all — the state every live order
    // is in, because neither panel ever sent one. The ingest must still find the
    // condition.
    const order = (await db.query(
      `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, sp_subdomain)
       VALUES ($1,$2,$3,'product_available','integrations.uat') RETURNING *`,
      [f.appId, `YSCAP-SLOT-AMC-${tag}`.slice(0, 40), `SP-SLOT-${tag}`.slice(0, 40)])).rows[0];
    ok(order.checklist_item_id == null, 'B2: the order carries no condition link (the live state this must survive)');

    const deps = {
      authContext: { apiKey: 'K', subdomain: 'integrations.uat' },
      transport: {
        read: async () => ({ message: { deals: [{ embeddedFiles: [
          { documentId: 'X1', documentType: 'Appraisal Document', objectName: 'report.xml', objectURL: 'https://amc/getdoc/X1' },
          { documentId: 'P1', documentType: 'Appraisal PDF', objectName: 'report.pdf', objectURL: 'https://amc/getdoc/P1' },
          { documentId: 'I1', documentType: 'Invoice', objectName: 'invoice.pdf', objectURL: 'https://amc/getdoc/I1' },
        ] }] } }),
        getDocument: async (url) => (url.endsWith('X1')
          ? { bytes: XML_BYTES, contentType: 'application/xml' }
          : { bytes: PDF_BYTES, contentType: 'application/pdf' }),
      },
      importAppraisal: async () => { await markImported(f.appId); return { ok: true }; },
    };
    const ing = await amcSync.ingestDocuments(db, order, deps);
    ok(ing.ok && ing.filed === 3, 'B3: all three returned documents are filed');

    const rows = await docsOn(f.itemId);
    ok(rows.length === 2, 'B4: the data file and the report — and only those two — land ON the condition');
    const xml = rows.find((r) => r.filename === 'report.xml');
    const pdf = rows.find((r) => r.filename === 'report.pdf');
    ok(xml && String(xml.slot_label || '').toLowerCase().includes('xml'), 'B5: the data file lands in the XML slot');
    ok(pdf && String(pdf.slot_label || '').toLowerCase().includes('pdf'), 'B6: the report lands in the PDF slot');
    ok(xml && xml.doc_kind === 'appraisal_xml' && pdf && pdf.doc_kind === 'appraisal_pdf',
      'B7: both carry the importer source kinds, so undoing an import retires them');
    // An extra the AMC returns is on the FILE, not the condition — a condition
    // refuses sign-off while any document on it is un-reviewed, so an appraiser's
    // invoice must never become a clear-to-close blocker.
    const inv = (await db.query(
      `SELECT checklist_item_id, slot_label, review_status FROM documents
        WHERE application_id=$1 AND filename='invoice.pdf'`, [f.appId])).rows[0];
    ok(inv && inv.checklist_item_id == null && inv.slot_label == null,
      'B8: an extra document the AMC returned is filed on the FILE, in no slot, blocking nothing');
    ok(xml.review_status === 'accepted' && pdf.review_status === 'accepted',
      'B9: a SUCCESSFUL import vouches for the two source documents');
    ok(inv.review_status === 'pending', 'B10: the unclassified extra stays pending for a human');

    // THE POINT OF ALL OF IT: the real gate now clears.
    g = await staffRoutes.signOffGate(f.itemId, { id: staff.id });
    ok(g == null, 'B11: the appraisal-documents condition can now be signed off — nothing re-filed by hand');

    // A second poll of the same delivery must not file a second copy into the slot.
    const ing2 = await amcSync.ingestDocuments(db, order, deps);
    ok(ing2.filed === 0, 'B12: re-polling the same delivery files nothing new');
    ok((await docsOn(f.itemId)).length === 2, 'B13: still exactly two documents on the condition');
  }

  // ===================================================================
  // C. A delivery that does NOT import is never vouched for.
  // ===================================================================
  {
    const f = await seedFile('noimp');
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    const order = (await db.query(
      `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, sp_subdomain)
       VALUES ($1,$2,$3,'product_available','integrations.uat') RETURNING *`,
      [f.appId, `YSCAP-SLOT-NOIMP-${tag}`.slice(0, 40), `SP-NOIMP-${tag}`.slice(0, 40)])).rows[0];
    await amcSync.ingestDocuments(db, order, {
      authContext: { apiKey: 'K', subdomain: 'integrations.uat' },
      transport: {
        read: async () => ({ message: { deals: [{ embeddedFiles: [
          { documentId: 'X9', documentType: 'Appraisal Document', objectName: 'broken.xml', objectURL: 'https://amc/getdoc/X9' },
        ] }] } }),
        getDocument: async () => ({ bytes: XML_BYTES, contentType: 'application/xml' }),
      },
      importAppraisal: async () => ({ ok: false, error: 'unreadable' }),
    });
    const rows = await docsOn(f.itemId);
    ok(rows.length === 1 && String(rows[0].slot_label || '').toLowerCase().includes('xml'),
      'C1: an unreadable data file is still filed in its slot, so a human can see what came back');
    ok(rows[0].review_status === 'pending', 'C2: …but nothing vouches for it — it waits for a human');
    const g = await staffRoutes.signOffGate(f.itemId, { id: staff.id });
    ok(typeof g === 'string', 'C3: and the condition still refuses sign-off (no PDF, no valid appraisal)');
  }

  // ===================================================================
  // D. Class Valuation — the same contract, the other vendor.
  // ===================================================================
  {
    const f = await seedFile('class');
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    const order = (await db.query(
      `INSERT INTO class_orders (application_id, class_order_id, reference_number, api_version, uad, order_path, status)
       VALUES ($1,$2,$3,'v1','2.6','/orders','ordered') RETURNING *`,
      [f.appId, `CL-${tag}`.slice(0, 40), `REF-SLOT-${tag}`.slice(0, 40)])).rows[0];
    ok(order.checklist_item_id == null, 'D1: the Class order carries no condition link (the live state)');
    for (const [name, ct] of [['class-report.xml', 'application/xml'], ['class-report.pdf', 'application/pdf']]) {
      await db.query(
        `INSERT INTO class_attachments (class_order_row, application_id, name, content_type, announced_at)
         VALUES ($1,$2,$3,$4, now())`,
        [order.id, f.appId, name, ct]);
    }
    const out = await classDocs.ingestForOrder(db, order, {
      transport: {
        configured: () => ({ enabled: true }),
        attachments: async () => ([
          { name: 'class-report.xml', url: 'https://class/x', contentType: 'application/xml' },
          { name: 'class-report.pdf', url: 'https://class/p', contentType: 'application/pdf' },
        ]),
        fetchUrl: async (u) => (u.endsWith('/x')
          ? { bytes: XML_BYTES, contentType: 'application/xml', filename: 'class-report.xml' }
          : { bytes: PDF_BYTES, contentType: 'application/pdf', filename: 'class-report.pdf' }),
        attachmentBytes: async () => null,
      },
      importAppraisal: async () => { await markImported(f.appId); return { ok: true }; },
    });
    ok(out && out.ok && out.filed === 2, 'D2: Class files both returned documents');
    const rows = await docsOn(f.itemId);
    const xml = rows.find((r) => /\.xml$/.test(r.filename));
    const pdf = rows.find((r) => /\.pdf$/.test(r.filename));
    ok(xml && String(xml.slot_label || '').toLowerCase().includes('xml'), 'D3: the Class data file lands in the XML slot');
    ok(pdf && String(pdf.slot_label || '').toLowerCase().includes('pdf'), 'D4: the Class report lands in the PDF slot');
    const g = await staffRoutes.signOffGate(f.itemId, { id: staff.id });
    ok(g == null, 'D5: the condition clears on a Class return too');
  }

  // ===================================================================
  // E. Two deliveries never display under one identical label.
  // ===================================================================
  {
    const f = await seedFile('twice');
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    const first = await conditionSlots.labelFor(db, f.itemId, 'pdf');
    await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, doc_kind, review_status, slot_label)
       VALUES ($1,$2,'a.pdf','application/pdf',10,'local','x','staff','appraisal_pdf','accepted',$3)`,
      [f.appId, f.itemId, first]);
    const second = await conditionSlots.labelFor(db, f.itemId, 'pdf');
    ok(second !== first, 'E1: a second delivery gets its own label, never a duplicate of the first');
    ok(String(second).toLowerCase().includes('pdf'), 'E2: …and the suffixed label still satisfies the gate');
  }

  // cleanup
  for (const id of cleanupApps) {
    await db.query('DELETE FROM amc_order_documents WHERE order_id IN (SELECT id FROM amc_orders WHERE application_id=$1)', [id]).catch(() => {});
    await db.query('DELETE FROM amc_orders WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM class_attachments WHERE class_order_row IN (SELECT id FROM class_orders WHERE application_id=$1)', [id]).catch(() => {});
    await db.query('DELETE FROM class_orders WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM documents WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM appraisal_findings WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM appraisals WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [id]).catch(() => {});
  }
  for (const id of cleanupBors) await db.query('DELETE FROM borrowers WHERE id=$1', [id]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S) of ${n}` : `\nOK  appraisal-condition-slots-db: ${n} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });

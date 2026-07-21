/* Sitewire DOCUMENT push (owner-directed 2026-07-21 — push the appraisal PDF + Scope of Work Excel + PDF into
 * the Sitewire property Documents tab, because the API has NO upload endpoint). Covers:
 *   • the pure web-client guards (SSRF host allowlist, CSRF scrape, signed-out detection) — no DB, no network
 *   • gather-the-right-slot (appraisal_pdf, rehab_budget_export xlsx, rehab_budget_export pdf) + the xlsx fallback
 *   • pushDocuments end-to-end with a STUBBED web robot: managed gate, docs-disabled gate, read-after-write
 *     VERIFY via the trusted API, sha256 dedup, force re-push, missing-slot skip, unverified-parks
 * DB-gated: the pushDocuments cases need DATABASE_URL with migrations applied; the pure guards always run.
 * The website robot (web-client) + storage + the API read are stubbed — no real network, no real Sitewire.
 * Run: DATABASE_URL=... node scripts/test-sitewire-doc-push.js
 */
process.env.SITEWIRE_DOCS_ENABLED = process.env.SITEWIRE_DOCS_ENABLED || '1';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ===================== PURE web-client guards (no DB / no network) =====================
const web = require('../src/sitewire/web-client');
{
  const A = web._internal.assertUploadUrl;
  // S3 hosts Sitewire itself hands back are allowed…
  ok('ssrf: s3 global allowed', !!A('https://sitewire-images.s3.amazonaws.com/abc'));
  ok('ssrf: s3 regional allowed', !!A('https://s3.us-east-1.amazonaws.com/bucket/key'));
  ok('ssrf: sitewire host allowed', !!A('https://app.sitewire.co/rails/x'));
  // …arbitrary hosts + insecure schemes are refused.
  let threw = false; try { A('https://evil.example.com/x'); } catch { threw = true; } ok('ssrf: foreign host refused', threw);
  threw = false; try { A('http://sitewire-images.s3.amazonaws.com/x'); } catch { threw = true; } ok('ssrf: http refused', threw);
  threw = false; try { A('not a url'); } catch { threw = true; } ok('ssrf: garbage refused', threw);

  const html = '<meta name="csrf-token" content="TOK-123">';
  ok('csrf: scrapes meta token', web._internal.scrapeCsrf(html) === 'TOK-123');
  ok('csrf: null when absent', web._internal.scrapeCsrf('<html></html>') === null);
  ok('signedout: detects sign-in page', web._internal.looksSignedOut('<input name="user[password]"> /users/sign_in') === true);
  ok('signedout: false when logged in', web._internal.looksSignedOut('<a href="/users/sign_out">Log out</a>') === false);

  // cookie jar merge/emit
  const jar = {}; web._internal.mergeSetCookie(jar, { headers: { getSetCookie: () => ['_s=abc; Path=/; HttpOnly', 'x=y; Path=/'], get: () => null } });
  ok('cookies: jar captured', jar._s === 'abc' && jar.x === 'y');
  ok('cookies: header emitted', /(_s=abc)/.test(web._internal.cookieHeader(jar)));
}

if (!process.env.DATABASE_URL) {
  console.log(`web-client guards: ${pass} passed, ${fail} failed`);
  console.log('SKIP test-sitewire-doc-push DB cases (no DATABASE_URL)');
  process.exit(fail ? 1 : 0);
}

// ===================== DB-backed pushDocuments cases =====================
const cfg = require('../src/config');
const db = require('../src/db');
const crypto = require('crypto');
const storage = require('../src/lib/storage');
const orch = require('../src/sitewire/orchestrator');
const sow = require('../src/sitewire/sow-line-edit');
const docPush = require('../src/sitewire/doc-push');

// ---- stub the website robot (never a real network call) ----
let uploadCalls = [], attachCalls = [], sessionErr = null;
web.getSession = async () => (sessionErr ? { error: sessionErr, message: 'stub' } : { jar: {}, csrf: 'TOK' });
web.uploadBlob = async (_s, f) => { uploadCalls.push(f.filename); return { signed_id: 'sig_' + f.filename, checksum: 'c', byte_size: (f.bytes || Buffer.alloc(0)).length }; };
web.attachDocument = async (_s, propId, sig) => { attachCalls.push({ propId, sig }); return { status: 302 }; };
// ---- stub storage read (return deterministic bytes per ref) ----
storage.read = async (ref) => Buffer.from('BYTES:' + ref);
// ---- stub the trusted-API read-after-write (what documents Sitewire reports) ----
let apiDocs = [];
orch.getSitewireDocuments = async () => ({ managed: true, available: true, documents: apiDocs });

const PROP = 900000 + crypto.randomBytes(2).readUInt16BE(0);

async function seed({ created = true, withProperty = true, appraisal = true, xlsx = true, pdf = true } = {}) {
  const email = 'dp' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('D','P',$1) RETURNING id`, [email])).rows[0].id;
  const app = (await db.query(`INSERT INTO applications(borrower_id,status,ys_loan_number) VALUES($1,'funded',$2) RETURNING id`, [bor, 'DP' + crypto.randomBytes(3).toString('hex')])).rows[0].id;
  await db.query(
    `INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at,lifecycle_state)
     VALUES($1,$2,$3,'live',now(),'active')`, [app, withProperty ? PROP : null, created ? 'created' : 'manual']);
  const ins = (kind, filename, ct) => db.query(
    `INSERT INTO documents(application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,is_current,visibility,source_type)
     VALUES($1,$2,$3,$4,10,'local',$5,'staff',NULL,$6,true,'staff_only','staff_upload')`,
    [app, bor, filename, ct, 'ref/' + filename, kind]);
  if (appraisal) await ins('appraisal_pdf', 'appraisal.pdf', 'application/pdf');
  if (xlsx) await ins('rehab_budget_export', 'sow.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  if (pdf) await ins('rehab_budget_export', 'sow.pdf', 'application/pdf');
  return { app, bor };
}
const cleanup = async (app, bor) => { await db.query(`DELETE FROM applications WHERE id=$1`, [app]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]); };
const links = async (app) => (await db.query(`SELECT which,status,sha256 FROM sitewire_document_links WHERE application_id=$1 ORDER BY which`, [app])).rows;
const parkCount = async (app) => (await db.query(`SELECT count(*)::int c FROM sync_review_queue WHERE application_id=$1 AND status='open'`, [app])).rows[0].c;

(async () => {
  cfg.sitewireEnabled = true; cfg.sitewireOutboundEnabled = true; cfg.sitewireDryrun = false; cfg.sitewireDocsEnabled = true;

  // 1) docs disabled → gate
  { cfg.sitewireDocsEnabled = false; const { app, bor } = await seed();
    const r = await docPush.pushDocuments(app, {});
    ok('1 docs-disabled gate', r.error === 'docs_disabled');
    await cleanup(app, bor); cfg.sitewireDocsEnabled = true; }

  // 2) not managed (matched_by != created) → gate
  { const { app, bor } = await seed({ created: false });
    const r = await docPush.pushDocuments(app, {});
    ok('2 not-managed gate', r.error === 'not_managed');
    await cleanup(app, bor); }

  // 3) HAPPY PATH — all 3 upload + attach + VERIFY via the API
  { uploadCalls = []; attachCalls = []; apiDocs = [{ name: 'Appraisal.pdf' }, { name: 'Scope of Work.xlsx' }, { name: 'Scope of Work.pdf' }];
    const { app, bor } = await seed();
    const r = await docPush.pushDocuments(app, { staffId: null });
    ok('3 ok', r.ok && r.anyPushed);
    ok('3 all 3 uploaded', uploadCalls.length === 3 && attachCalls.length === 3);
    const l = await links(app);
    ok('3 three link rows', l.length === 3);
    ok('3 all verified', l.every((x) => x.status === 'verified'));
    ok('3 no park', (await parkCount(app)) === 0);
    // journal wrote 3 document rows
    const j = (await db.query(`SELECT count(*)::int c FROM sitewire_write_log WHERE application_id=$1 AND entity='document'`, [app])).rows[0].c;
    ok('3 journaled 3', j === 3);

    // 4) DEDUP — pushing again without force skips all (identical bytes)
    uploadCalls = [];
    const r2 = await docPush.pushDocuments(app, {});
    ok('4 dedup skips all', uploadCalls.length === 0 && r2.results.every((x) => x.skipped && x.reason === 'already_pushed'));

    // 5) FORCE re-push uploads again
    uploadCalls = [];
    const r3 = await docPush.pushDocuments(app, { force: true });
    ok('5 force re-uploads', uploadCalls.length === 3 && r3.results.every((x) => x.pushed));
    await cleanup(app, bor); }

  // 6) MISSING sow pdf → that slot is skipped, the other two still push
  { uploadCalls = []; apiDocs = [{ name: 'Appraisal.pdf' }, { name: 'Scope of Work.xlsx' }];
    const { app, bor } = await seed({ pdf: false });
    const r = await docPush.pushDocuments(app, {});
    const sowPdf = r.results.find((x) => x.which === 'sow_pdf');
    ok('6 sow_pdf skipped missing', sowPdf && sowPdf.skipped && sowPdf.reason === 'no_sow_pdf');
    ok('6 other two pushed', uploadCalls.length === 2);
    await cleanup(app, bor); }

  // 7) UNVERIFIED — upload succeeds but the API doesn't list it yet → status 'pushed' + a park row opened
  { uploadCalls = []; apiDocs = []; // API shows nothing back
    const { app, bor } = await seed({ xlsx: false, pdf: false }); // just the appraisal, keep it simple
    const r = await docPush.pushDocuments(app, {});
    const l = await links(app);
    ok('7 status pushed (unverified)', l.length === 1 && l[0].status === 'pushed');
    ok('7 park opened', (await parkCount(app)) >= 1);
    ok('7 result verified=false', r.results.find((x) => x.which === 'appraisal_pdf').verified === false);
    await cleanup(app, bor); }

  // 8) web session missing → parks + returns the creds-missing error, no upload attempted
  { uploadCalls = []; sessionErr = 'web_creds_missing'; apiDocs = [];
    const { app, bor } = await seed();
    const r = await docPush.pushDocuments(app, {});
    ok('8 web_creds_missing surfaced', r.error === 'web_creds_missing');
    ok('8 nothing uploaded', uploadCalls.length === 0);
    ok('8 park opened', (await parkCount(app)) >= 1);
    await cleanup(app, bor); sessionErr = null; }

  // 9) DRY-RUN — records intent, sends nothing
  { uploadCalls = []; cfg.sitewireDryrun = true; apiDocs = [];
    const { app, bor } = await seed();
    const r = await docPush.pushDocuments(app, {});
    ok('9 dryrun no upload', uploadCalls.length === 0 && r.results.every((x) => x.dryrun));
    await cleanup(app, bor); cfg.sitewireDryrun = false; }

  // 10) gatherSowExcel FALLBACK — no stored xlsx but a saved SOW state → generated Excel is used
  { const realLoad = sow.loadSow, realBuild = sow.buildSowExcel;
    sow.loadSow = async () => ({ state: { units: 1 }, total: 12345 });
    sow.buildSowExcel = () => Buffer.from('XLSXBYTES');
    const { app, bor } = await seed({ xlsx: false, pdf: false, appraisal: false });
    const g = await docPush._internal.gatherSowExcel(app);
    ok('10 xlsx fallback generated', g && !g.missing && g.generated === true && g.filename === 'Scope of Work.xlsx');
    await cleanup(app, bor); sow.loadSow = realLoad; sow.buildSowExcel = realBuild; }

  // 10b) APPRAISAL from the CONDITION PDF SLOT (doc_kind NULL) — must be found, same as the importer's kind.
  { const tid = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_cond_appraisaldocs' LIMIT 1`)).rows[0].id;
    const { app, bor } = await seed({ appraisal: false, xlsx: false, pdf: false }); // no appraisal_pdf row at all
    const ci = (await db.query(`INSERT INTO checklist_items(application_id,template_id,item_kind,status,scope,label) VALUES($1,$2,'document','received','application','Appraisal documents') RETURNING id`, [app, tid])).rows[0].id;
    // the appraisal PDF on the condition's PDF slot + the appraisal XML on the XML slot (must pick the PDF, never the XML)
    await db.query(`INSERT INTO documents(application_id,borrower_id,checklist_item_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,slot_label,is_current,visibility,source_type)
      VALUES($1,$2,$3,'1053_appraisal.pdf','application/pdf',10,'local','ref/appr-pdf','staff',NULL,NULL,'PDF',true,'staff_only','staff_upload')`, [app, bor, ci]);
    await db.query(`INSERT INTO documents(application_id,borrower_id,checklist_item_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,slot_label,is_current,visibility,source_type)
      VALUES($1,$2,$3,'1053_appraisal.xml','application/xml',10,'local','ref/appr-xml','staff',NULL,NULL,'XML',true,'staff_only','staff_upload')`, [app, bor, ci]);
    const g = await docPush._internal.gatherAppraisalPdf(app);
    ok('10b appraisal found via PDF slot', g && !g.missing && g.filename === 'Appraisal.pdf');
    ok('10b picked the PDF not the XML', g && g.sourceDocId && (await db.query(`SELECT content_type FROM documents WHERE id=$1`, [g.sourceDocId])).rows[0].content_type === 'application/pdf');
    const st = await docPush.status(app);
    ok('10b status shows appraisal available', st.slots.find((s) => s.which === 'appraisal_pdf').available === true);
    await cleanup(app, bor); }

  // 11) status() — metadata-only availability (no bytes read), reflects managed + push state
  { storage.read = async () => { throw new Error('status() must NOT read bytes'); }; // prove no byte read
    const { app, bor } = await seed({ pdf: false }); // appraisal + xlsx available, sow_pdf missing
    const st = await docPush.status(app);
    ok('11 managed true', st.managed === true);
    const byW = Object.fromEntries(st.slots.map((s) => [s.which, s]));
    ok('11 appraisal available', byW.appraisal_pdf.available === true);
    ok('11 xlsx available', byW.sow_xlsx.available === true);
    ok('11 sow_pdf missing', byW.sow_pdf.available === false && byW.sow_pdf.missing === 'no_sow_pdf');
    ok('11 not pushed yet', st.slots.every((s) => !s.pushed));
    await cleanup(app, bor);
    storage.read = async (ref) => Buffer.from('BYTES:' + ref); } // restore

  console.log(`\ntest-sitewire-doc-push: ${pass} passed, ${fail} failed`);
  await db.pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

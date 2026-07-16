/**
 * TPR / file export (#148; layout reworked owner-directed 2026-07-13;
 * EVERYTHING-on-the-file selection owner-directed 2026-07-16).
 * Packages EVERY current document on the file — internal-condition docs
 * (fraud / credit / insurance / title / appraisal), borrower-condition docs,
 * loose attachments, the vesting entity's docs INCLUDING layered owning
 * entities, and borrower-profile docs for borrower + co-borrower — whether or
 * not review has finished (the manifest labels each doc's review status
 * instead of dropping it). Into a property-centric ZIP whose subject folder is
 * organized BY CONDITION NAME, mirroring the SharePoint "YS portal syncing"
 * folder layout:
 *
 *   01_Subject_Property__<address>/
 *      00_REGISTERED_PRODUCT.{json,txt}
 *      01_<Condition label>/ …          one folder per condition, every document
 *      NN_General_Documents/            docs with no condition (except term sheet)
 *   02_Term_Sheet/                      the signed term sheet, pulled out on its own
 *   03_Track_Record/
 *      Track_Record.html                a branded, printable operational track record
 *      Track_Record.xlsx                the same as a real Excel workbook
 *      <prior property address>/        each line item's verification docs, foldered
 *   00_MANIFEST.json / 00_INDEX.txt
 *
 * What stays OUT (each a deliberate, individually-decided exclusion):
 *   - rejected documents and superseded versions (is_current=false) — trash
 *   - chat attachments (conversation exhibits, not file documents)
 *   - items flagged tpr_exclude (owner-directed per-condition exclusions:
 *     ISKA, investor-structure printout — db/051/db/056)
 *   - an EXPIRED Certificate of Good Standing (#83 — behaves like empty)
 *   - system-generated regen artifacts (prior TPR zips, autosaved track-record
 *     printouts) — the export builds its own live versions of those
 * Track-record verification docs are gated at the LINE-ITEM level (a project's
 * documents ride on its is_verified flag — the individual files are 'pending'
 * because verification is per project, not per document).
 *
 * Every generated export is ALSO saved as a document row (doc_kind 'tpr_export',
 * visibility 'internal' so it can never ride into a future buyer package) —
 * which makes the SharePoint mirror pick it up into the file's
 * "YS portal syncing/TPR Exports" folder, with Version-N history on re-export.
 */
const db = require('../db');
const storage = require('./storage');
const { zip } = require('./zip');

// Map a subject-file checklist label to a stacking category folder (WITHIN the
// subject-property folder). The term sheet is handled separately, not here.
function folderFor(label = '') {
  const s = label.toLowerCase();
  if (/assignment/.test(s)) return '05_Purchase_Contract';
  if (/purchase|contract|sales/.test(s)) return '05_Purchase_Contract';
  if (/appraisal|valuation|bpo/.test(s)) return '07_Appraisal_Valuation';
  if (/title/.test(s)) return '08_Title_and_Insurance';
  if (/insurance|hazard|flood/.test(s)) return '08_Title_and_Insurance';
  if (/llc|operating agreement|ein|formation|entity|articles/.test(s)) return '03_Entity_LLC';
  if (/rehab|budget|scope|sow|construction/.test(s)) return '06_Rehab_Budget_SOW';
  if (/bank|statement|liquid|asset|reserve|proof of funds/.test(s)) return '02_Borrower_and_Credit';
  if (/\bid\b|license|passport|photo id|driver/.test(s)) return '02_Borrower_and_Credit';
  if (/credit|fico|bureau/.test(s)) return '02_Borrower_and_Credit';
  if (/reo|experience|track record|prior/.test(s)) return '04_Experience';
  if (/closing|hud|cd|settlement|note|mortgage|deed/.test(s)) return '09_Closing';
  return '01_Application_and_Terms';
}
// A term-sheet document is the one that goes in its own folder.
const isTermSheet = (d) => d.doc_kind === 'term_sheet' || /term\s*sheet/i.test(d.item_label || '') || /term\s*sheet/i.test(d.filename || '');

const sanitize = (s) => String(s || 'document').replace(/[^a-zA-Z0-9._ -]/g, '').replace(/\s+/g, '_').slice(0, 80);
// Folder-name form of an address (spaces/commas kept as separators, trimmed).
// Path separators AND dot-runs are neutralized so a crafted address can never
// produce a `..` traversal segment in a ZIP entry name.
const folderName = (s) => String(s || 'Property')
  .replace(/[\\/:*?"<>|]/g, ' ').replace(/\.{2,}/g, '.').replace(/(^[.\s]+|[.\s]+$)/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, 90) || 'Property';

function addrText(a) {
  if (!a) return '';
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { return a; } }
  return a.oneLine || [a.line1 || a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') || '';
}

const money = (v) => v == null || v === '' ? '' : '$' + Math.round(Number(v)).toLocaleString('en-US');
// node-postgres returns date/timestamptz columns as JS Date objects, so a bare
// String(v).slice(0,10) yields "Sun Jul 12" — format the Date properly.
const dateStr = (v) => {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const DEAL_LABEL = { flip: 'Fix & Flip', 'fix-and-hold': 'Fix & Hold', 'fix_and_hold': 'Fix & Hold', ground_up: 'Ground-Up', 'ground-up': 'Ground-Up', rental: 'Rental', bridge: 'Bridge' };
const dealLabel = (t) => DEAL_LABEL[t] || (t ? String(t).replace(/_/g, ' ') : '—');

// The frozen 3-year exit window (mirrors track-record.js qualifies()): a
// completed exit dated within the last 36 months counts toward experience.
function exitInfo(r) {
  const exit = r.sale_date || r.refi_date || r.rent_date || null;
  if (!exit) return { exit: null, counts: false };
  const d = new Date(exit); if (isNaN(d)) return { exit, counts: false };
  const monthsAgo = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return { exit, counts: monthsAgo >= 0 && monthsAgo <= 36 };
}

// ---------------------------------------------------------------- XLSX writer
const xmlEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function colLetter(n) { let s = ''; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/**
 * Build a real, dependency-free .xlsx workbook (OOXML, STORE-zipped). `rows` is
 * an array of arrays; a cell that is a finite number is written as a numeric
 * cell, everything else as an inline string. Returns a Buffer.
 */
function buildXlsx(rows) {
  const sheetRows = rows.map((cells, ri) => {
    const r = ri + 1;
    const cs = cells.map((val, ci) => {
      const ref = colLetter(ci) + r;
      if (typeof val === 'number' && isFinite(val)) return `<c r="${ref}"><v>${val}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
    }).join('');
    return `<row r="${r}">${cs}</row>`;
  }).join('');

  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '</Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Track Record" sheetId="1" r:id="rId1"/></sheets>'
      + '</workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<sheetData>${sheetRows}</sheetData></worksheet>` },
  ].map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') }));
  return zip(files);
}

// --------------------------------------------------------------- HTML report
function trackRecordHtml({ borrowerName, generatedAt, loanNumber, records }) {
  const verified = records.filter((r) => r.is_verified).length;
  const counting = records.filter((r) => exitInfo(r).counts).length;
  const totalPurchase = records.reduce((n, r) => n + (Number(r.purchase_price) || 0), 0);
  const totalRehab = records.reduce((n, r) => n + (Number(r.rehab_amount) || 0), 0);
  const rowsHtml = records.map((r) => {
    const { exit, counts } = exitInfo(r);
    return `<tr>
      <td>${xmlEsc(addrText(r.property_address) || '—')}</td>
      <td>${xmlEsc(dealLabel(r.deal_type))}</td>
      <td class="num">${xmlEsc(money(r.purchase_price))}</td>
      <td class="num">${xmlEsc(money(r.rehab_amount))}</td>
      <td class="num">${xmlEsc(money(r.sale_price || r.refi_amount || r.current_value))}</td>
      <td>${xmlEsc(dateStr(r.purchase_date))}</td>
      <td>${xmlEsc(dateStr(exit))}</td>
      <td>${r.is_verified ? '<span class="badge ok">Verified</span>' : '<span class="badge">Unverified</span>'}</td>
      <td>${counts ? 'Yes' : 'No'}</td>
    </tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Track Record — ${xmlEsc(borrowerName)}</title>
<style>
  :root{color-scheme:light}
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;background:#fff;margin:0;padding:32px}
  h1{margin:0 0 2px;font-size:22px}
  .sub{color:#555;font-size:13px;margin-bottom:18px}
  .stats{display:flex;gap:24px;flex-wrap:wrap;margin:0 0 20px;padding:14px 16px;background:#f6f7f9;border:1px solid #e5e7eb;border-radius:10px}
  .stat b{display:block;font-size:19px}
  .stat span{color:#666;font-size:12px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border:1px solid #e5e7eb;padding:7px 9px;text-align:left;vertical-align:top}
  th{background:#0b2a4a;color:#fff;font-weight:600;font-size:12px}
  td.num,th.num{text-align:right;white-space:nowrap}
  tr:nth-child(even) td{background:#fafbfc}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#eee;color:#555;font-size:11px}
  .badge.ok{background:#e7f6ec;color:#1a7f3c}
  .foot{margin-top:16px;color:#888;font-size:11px}
</style></head><body>
  <h1>Operating Track Record</h1>
  <div class="sub">${xmlEsc(borrowerName)}${loanNumber ? ' · Loan ' + xmlEsc(loanNumber) : ''} · Generated ${xmlEsc(String(generatedAt).slice(0, 10))} · YS Capital Group</div>
  <div class="stats">
    <div class="stat"><b>${records.length}</b><span>Projects</span></div>
    <div class="stat"><b>${verified}</b><span>Verified</span></div>
    <div class="stat"><b>${counting}</b><span>Count toward experience (3-yr exit)</span></div>
    <div class="stat"><b>${xmlEsc(money(totalPurchase))}</b><span>Total acquisition</span></div>
    <div class="stat"><b>${xmlEsc(money(totalRehab))}</b><span>Total rehab</span></div>
  </div>
  <table><thead><tr>
    <th>Property</th><th>Deal type</th><th class="num">Purchase</th><th class="num">Rehab</th>
    <th class="num">Sale / Refi / Value</th><th>Purchased</th><th>Exited</th><th>Status</th><th>Counts</th>
  </tr></thead><tbody>
  ${rowsHtml || '<tr><td colspan="9" style="text-align:center;color:#888">No track-record projects on file.</td></tr>'}
  </tbody></table>
  <div class="foot">Verification is performed per project by YS Capital Group underwriting. "Counts toward experience" reflects a completed exit dated within the last 36 months.</div>
</body></html>`;
}

/* ---------------- shared TPR document selection (the ONE chokepoint) --------
   Owner-directed 2026-07-16 ("every single document needs to be part of the
   TPR export"): the package includes every CURRENT document connected to the
   file, across every source — the application's own docs (any condition,
   internal or borrower, plus loose attachments), the vesting entity's docs
   including LAYERED owning entities (db/094), and borrower-profile docs
   (photo ID etc.) for borrower + co-borrower. Review no longer gates
   inclusion — a pending doc ships and is LABELED pending in the manifest.
   Both the ZIP builder and the staff preview endpoint MUST draw from these
   helpers so the panel's promised count can never disagree with the package. */
const TPR_DOC_SELECT = `
  WITH RECURSIVE ctx AS (
    SELECT borrower_id, co_borrower_id, llc_id FROM applications WHERE id=$1
  ), entity_tree AS (
    SELECT llc_id AS id FROM ctx WHERE llc_id IS NOT NULL
    UNION
    SELECT m.owner_llc_id FROM llc_members m JOIN entity_tree e ON m.llc_id = e.id
     WHERE m.owner_llc_id IS NOT NULL
  )
  SELECT d.id, d.filename, d.storage_ref, d.reviewed_at, d.created_at, d.doc_kind,
         COALESCE(d.review_status,'pending') AS review_status,
         ci.label AS item_label, s.full_name AS reviewed_by_name
    FROM documents d
    LEFT JOIN checklist_items ci ON ci.id=d.checklist_item_id
    LEFT JOIN staff_users s ON s.id=d.reviewed_by
   WHERE (d.application_id=$1
          OR (d.application_id IS NULL AND d.llc_id IN (SELECT id FROM entity_tree))
          OR (d.application_id IS NULL AND d.llc_id IS NULL AND d.track_record_id IS NULL
              AND d.lead_id IS NULL
              AND d.borrower_id IN (SELECT borrower_id FROM ctx
                                    UNION SELECT co_borrower_id FROM ctx WHERE co_borrower_id IS NOT NULL)))
     AND d.is_current=true
     AND COALESCE(d.review_status,'pending') <> 'rejected'
     AND COALESCE(d.source_type,'') <> 'chat_attachment'
     AND (ci.tpr_exclude IS NOT TRUE)
     -- system-regenerated artifacts (a prior TPR zip, autosaved track-record
     -- printouts) are not source documents — and re-packing a previous export
     -- inside the next one must never happen.
     AND COALESCE(d.doc_kind,'') NOT IN ('track_record_html','tpr_export')
     AND COALESCE(d.doc_kind,'') NOT LIKE '%\\_export'
     -- #83: an EXPIRED Certificate of Good Standing behaves like empty
     -- everywhere, so it must not ship as if it were a live document.
     AND NOT (d.created_at < now() - interval '30 days'
              AND ci.template_id IN (SELECT id FROM checklist_templates
                                      WHERE code='rtl_llc_goodstanding' AND scope='llc'))
   ORDER BY ci.sort_order NULLS LAST, d.created_at`;
async function selectTprDocuments(appId) {
  return (await db.query(TPR_DOC_SELECT, [appId])).rows;
}

// Document conditions that would ship EMPTY: not satisfied/signed off and no
// current, non-rejected document at all (inclusion no longer waits on accept).
async function selectTprMissing(appId) {
  return (await db.query(
    `SELECT COALESCE(label,'(document)') AS label FROM checklist_items ci
      WHERE application_id=$1 AND item_kind='document' AND status <> 'satisfied'
        AND signed_off_at IS NULL AND (tpr_exclude IS NOT TRUE)
        AND NOT EXISTS (SELECT 1 FROM documents d
                         WHERE d.checklist_item_id=ci.id AND d.is_current
                           AND COALESCE(d.review_status,'pending') <> 'rejected')
      ORDER BY sort_order`, [appId])).rows.map(r => r.label);
}

// Track-record verification docs for a set of line items (current, non-chat,
// non-rejected — staff-internal docs ship too, per the everything directive).
async function selectTrackRecordDocs(trIds) {
  if (!trIds || !trIds.length) return [];
  return (await db.query(
    `SELECT id, track_record_id, filename, storage_ref, created_at
       FROM documents
      WHERE track_record_id = ANY($1::uuid[]) AND is_current=true
        AND COALESCE(source_type,'') <> 'chat_attachment'
        AND COALESCE(review_status,'pending') <> 'rejected'
      ORDER BY created_at`, [trIds])).rows;
}

async function buildTprExport(appId) {
  const app = (await db.query(
    `SELECT a.ys_loan_number, a.program, a.loan_type, a.property_address, a.borrower_id, a.co_borrower_id,
            b.first_name, b.last_name
       FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId])).rows[0];
  if (!app) throw new Error('application not found');

  const registration = (await db.query(
    `SELECT program, product_label, status, note_rate, total_loan, target_ltc, quote, created_at
       FROM product_registrations
      WHERE application_id=$1 AND is_current
      ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0] || null;
  // S4-04: the registered quote embeds our internal margin/cost build-up
  // (`adminPricing`: markup, spread, fee breakdown). Strip it before it can ride
  // into the note-buyer package — the buyer sees the loan terms, never our margin.
  if (registration && registration.quote && typeof registration.quote === 'object') {
    const { adminPricing, ...rest } = registration.quote;
    registration.quote = rest;
  }

  // EVERYTHING on the file (owner-directed 2026-07-16) — see the shared
  // selection above for the full inclusion/exclusion contract.
  const docs = await selectTprDocuments(appId);

  // Document conditions that would ship empty — the pre-flight list.
  const missing = await selectTprMissing(appId);

  // The borrower's (and co-borrower's) operational track record.
  const borrowerIds = [app.borrower_id, app.co_borrower_id].filter(Boolean);
  const records = (await db.query(
    `SELECT id, borrower_id, property_address, deal_type, purchase_price, sale_price, rehab_amount,
            purchase_date, sale_date, rent_amount, rent_date, refi_amount, refi_date, current_value,
            is_verified, verified_at, notes
       FROM track_records
      WHERE borrower_id = ANY($1::uuid[])
      ORDER BY COALESCE(sale_date, refi_date, rent_date, purchase_date) DESC NULLS LAST, created_at DESC`,
    [borrowerIds])).rows;

  // Per-line-item verification documents (current, non-chat). Verification is at
  // the project level, so these ride on the line item's is_verified flag.
  const trDocs = await selectTrackRecordDocs(records.map(r => r.id));
  const docsByTr = {};
  for (const d of trDocs) (docsByTr[d.track_record_id] = docsByTr[d.track_record_id] || []).push(d);

  const files = [];
  const manifestDocs = [];
  const unavailable = [];
  const counters = {};

  const subjectAddr = addrText(app.property_address) || 'Property';
  const SUBJECT = `01_Subject_Property__${folderName(subjectAddr)}`;
  const TERMSHEET = '02_Term_Sheet';
  const TRACK = '03_Track_Record';

  // 1) Subject-file documents → subject-property folder, ONE FOLDER PER
  //    CONDITION (exact condition names — the same layout as the SharePoint
  //    "YS portal syncing" mirror), with the term sheet pulled out on its own.
  //    Folder numbers follow first appearance (docs arrive ordered by the
  //    condition's sort_order), so the package reads in checklist order.
  const conditionFolders = {};   // condition label -> numbered folder name
  let conditionSeq = 0;
  const conditionFolderFor = (label) => {
    const key = folderName(label || 'General Documents');
    if (!conditionFolders[key]) {
      conditionSeq += 1;
      conditionFolders[key] = `${String(conditionSeq).padStart(2, '0')}_${key}`;
    }
    return conditionFolders[key];
  };
  for (const d of docs) {
    let bytes;
    try { bytes = await storage.read(d.storage_ref); }
    catch (_) { unavailable.push({ source: d.filename, requirement: d.item_label || null }); continue; }
    const top = isTermSheet(d) ? TERMSHEET : `${SUBJECT}/${conditionFolderFor(d.item_label)}`;
    counters[top] = (counters[top] || 0) + 1;
    const nn = String(counters[top]).padStart(2, '0');
    const ext = (d.filename.match(/\.[a-zA-Z0-9]{1,6}$/) || [''])[0] || '';
    const base = sanitize(d.filename.replace(/\.[^.]+$/, '') || d.item_label || 'document');
    const name = `${top}/${nn}_${base}${ext}`;
    files.push({ name, data: bytes });
    // Inclusion no longer waits on review — label the status instead, so the
    // reader can tell an accepted document from one still pending review.
    manifestDocs.push({
      file: name, source: d.filename, requirement: d.item_label || null,
      review: d.review_status,
      accepted_by: d.review_status === 'accepted' ? (d.reviewed_by_name || null) : null,
      accepted_at: d.review_status === 'accepted' ? (d.reviewed_at || d.created_at) : null,
    });
  }

  // 2) Track record → HTML + Excel + per-property verification-doc subfolders.
  const borrowerName = `${app.first_name || ''} ${app.last_name || ''}`.trim();
  const generatedAt = new Date().toISOString();
  files.push({ name: `${TRACK}/Track_Record.html`, data: Buffer.from(trackRecordHtml({ borrowerName, generatedAt, loanNumber: app.ys_loan_number, records }), 'utf8') });

  const xlsxHeader = ['Property', 'Deal type', 'Purchase', 'Rehab', 'Sale / Refi / Value', 'Purchased', 'Exited', 'Verified', 'Counts toward experience'];
  const xlsxRows = [xlsxHeader];
  for (const r of records) {
    const { exit, counts } = exitInfo(r);
    xlsxRows.push([
      addrText(r.property_address) || '', dealLabel(r.deal_type),
      r.purchase_price != null ? Number(r.purchase_price) : '',
      r.rehab_amount != null ? Number(r.rehab_amount) : '',
      (r.sale_price || r.refi_amount || r.current_value) != null ? Number(r.sale_price || r.refi_amount || r.current_value) : '',
      dateStr(r.purchase_date), dateStr(exit),
      r.is_verified ? 'Verified' : 'Unverified', counts ? 'Yes' : 'No',
    ]);
  }
  files.push({ name: `${TRACK}/Track_Record.xlsx`, data: buildXlsx(xlsxRows) });

  // Per-line-item verification docs, foldered by that property's address.
  const trFolderCounts = {};
  const trManifest = [];
  for (const r of records) {
    const rdocs = docsByTr[r.id] || [];
    const label = addrText(r.property_address) || `Project ${String(r.id).slice(0, 8)}`;
    let folder = folderName(label);
    // Disambiguate two projects that normalize to the same folder name.
    if (trFolderCounts[folder]) folder = `${folder} (${trFolderCounts[folder] + 1})`;
    trFolderCounts[folderName(label)] = (trFolderCounts[folderName(label)] || 0) + 1;
    let docCount = 0;
    for (const d of rdocs) {
      let bytes;
      try { bytes = await storage.read(d.storage_ref); }
      catch (_) { unavailable.push({ source: d.filename, requirement: `track record — ${label}` }); continue; }
      docCount += 1;
      const nn = String(docCount).padStart(2, '0');
      const ext = (d.filename.match(/\.[a-zA-Z0-9]{1,6}$/) || [''])[0] || '';
      const base = sanitize(d.filename.replace(/\.[^.]+$/, ''));
      const name = `${TRACK}/${folder}/${nn}_${base}${ext}`;
      files.push({ name, data: bytes });
      manifestDocs.push({ file: name, source: d.filename, requirement: `track record — ${label}`, accepted_by: null, accepted_at: d.created_at });
    }
    trManifest.push({ property: label, deal_type: r.deal_type || null, verified: !!r.is_verified, documents: docCount });
  }

  const propLabel = subjectAddr;
  const manifest = {
    generated_at: generatedAt,
    lender: 'YS Capital Group',
    loan_number: app.ys_loan_number || null,
    borrower: borrowerName,
    property: propLabel,
    program: app.program || null,
    loan_type: app.loan_type || null,
    registered_terms: registration ? {
      program: registration.program,
      product_label: registration.product_label,
      status: registration.status,
      note_rate: registration.note_rate,
      total_loan: registration.total_loan,
      target_ltc: registration.target_ltc,
      quote: registration.quote,
      registered_at: registration.created_at,
    } : null,
    included_documents: manifestDocs,
    included_count: manifestDocs.length,
    track_record: { projects: records.length, verified: records.filter(r => r.is_verified).length, line_items: trManifest },
    unavailable_documents: unavailable,
    open_conditions_without_documents: missing,
  };
  if (registration) {
    files.push({
      name: `${SUBJECT}/00_REGISTERED_PRODUCT.json`,
      data: Buffer.from(JSON.stringify(manifest.registered_terms, null, 2), 'utf8'),
    });
    const q = registration.quote || {};
    const s = q.sizing || {};
    const pct = (v, d = 2) => v == null ? 'n/a' : (Number(v) * 100).toFixed(d) + '%';
    const m = (v) => v == null ? 'n/a' : '$' + Math.round(Number(v)).toLocaleString('en-US');
    files.push({
      name: `${SUBJECT}/00_REGISTERED_PRODUCT.txt`,
      data: Buffer.from([
        'YS CAPITAL GROUP - REGISTERED PRODUCT TERMS',
        `Product: ${[q.programLabel, q.productLabel].filter(Boolean).join(' - ') || registration.program}`,
        `Status: ${registration.status || 'n/a'}`,
        `Loan amount: ${m(s.totalLoan || registration.total_loan)}`,
        `Note rate: ${pct(q.noteRate || registration.note_rate)}`,
        `Initial advance: ${m(s.initialAdvance)}`,
        `Rehab holdback: ${m(s.rehabHoldback)}`,
        `Financed interest reserve: ${m(s.financedReserve)}`,
        `LTC: ${pct(s.ltcPct, 1)}`,
        `Initial/as-is LTV: ${pct(s.acqLtvPct, 1)}`,
        `Loan-to-ARV: ${pct(s.arvPct, 1)}`,
        `Closing costs due: ${m(q.closingCosts && q.closingCosts.dueAtClosing)}`,
        `Cash to close: ${m(q.cashToClose)}`,
        `Liquidity required: ${m(q.liquidityRequired || q.liquidity)}`,
        `Reserve basis: ${q.reserveBasis || 'n/a'}`,
        `Registered at: ${registration.created_at || 'n/a'}`,
      ].join('\n'), 'utf8'),
    });
  }
  files.push({ name: '00_MANIFEST.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

  // Human-readable index.
  const lines = [
    `YS CAPITAL GROUP — TPR FILE PACKAGE (every current document on the file)`,
    `Loan: ${app.ys_loan_number || '(pending)'}   Borrower: ${borrowerName}   Property: ${propLabel}`,
    `Generated: ${generatedAt}`, '',
    `PACKAGE LAYOUT:`,
    `  ${SUBJECT}/         subject property — one folder per condition, in checklist order`,
    `  ${TERMSHEET}/                       signed term sheet`,
    `  ${TRACK}/                    operating track record (HTML + Excel) + per-property verification docs`,
    '',
    `INCLUDED DOCUMENTS (${manifestDocs.length}):`,
    ...manifestDocs.map(m => `  - ${m.file}${m.accepted_by ? `  (accepted by ${m.accepted_by})` : (m.review && m.review !== 'accepted' ? `  (${m.review} review)` : '')}`),
    '', `TRACK RECORD: ${records.length} project(s), ${manifest.track_record.verified} verified.`,
    '', `OPEN CONDITIONS WITH NO DOCUMENT YET (${missing.length}):`,
    ...(missing.length ? missing.map(m => `  - ${m}`) : ['  (none)']),
  ];
  if (unavailable.length) {
    lines.push('', `UNREADABLE / SKIPPED (${unavailable.length}):`, ...unavailable.map(u => `  - ${u.source} (${u.requirement || 'file'})`));
  }
  files.push({ name: '00_INDEX.txt', data: Buffer.from(lines.join('\n'), 'utf8') });

  const filename = `TPR_${sanitize(app.ys_loan_number || app.last_name || 'file')}_${generatedAt.slice(0, 10)}.zip`;
  return { zip: zip(files), filename, includedCount: manifestDocs.length, missing };
}

/**
 * Persist a generated export as a document on the file (owner-directed
 * 2026-07-13) so the SharePoint mirror files it into
 * "YS portal syncing/TPR Exports" — with Version-N history on re-export.
 * visibility 'internal' structurally excludes it from every future buyer
 * package; superseding the previous export drives the mirror's versioning.
 * Best-effort: a failure here never blocks the download.
 */
async function saveTprExportDocument(appId, zipBuf, filename, actorId) {
  const app = (await db.query('SELECT borrower_id FROM applications WHERE id=$1', [appId])).rows[0];
  if (!app) return null;
  const { ref, provider } = await storage.save(zipBuf, { filename });
  const r = await db.query(
    `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id,
                            doc_kind, source_type, visibility)
     VALUES ($1,$2,$3,'application/zip',$4,$5,$6,'staff',$7,'tpr_export','system','internal') RETURNING id`,
    [appId, app.borrower_id, filename, zipBuf.length, provider, ref, actorId || null]);
  await db.query(
    `UPDATE documents SET is_current=false,
        review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
      WHERE application_id=$1 AND doc_kind='tpr_export' AND id<>$2 AND is_current=true`,
    [appId, r.rows[0].id]);
  try { require('./sharepoint-backup').kick(); } catch (_) { /* mirror is best-effort */ }
  return r.rows[0].id;
}

module.exports = {
  buildTprExport, saveTprExportDocument, folderFor, buildXlsx,
  // the shared selection chokepoint — the preview endpoint MUST use these so
  // its promised counts can never disagree with the built package
  selectTprDocuments, selectTprMissing, selectTrackRecordDocs,
};

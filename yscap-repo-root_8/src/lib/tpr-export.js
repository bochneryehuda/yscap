/**
 * TPR / file export (#148; layout REWORKED owner-directed 2026-07-21).
 *
 * Packages EVERY current document on the file into ONE property-named folder
 * whose subfolders are the fixed, cleanly-named document CATEGORIES the owner
 * keeps on the SharePoint file (no "01_"/"02_" number prefixes, no three
 * top-level Subject/Term-Sheet/Track-Record folders any more):
 *
 *   <Subject Property Address>/
 *      Application/            signed application + business-purpose disclosure
 *      Appraisal/              appraisal report (PDF/XML) + photos + appraisal docs
 *      Background Check/       background report (fraud condition, background slot)
 *      Bank Statements/        bank statements / assets / voided check
 *      Contract & Assignment/  purchase contract + assignment
 *      Credit Report/          credit report
 *      Criminal Check/         criminal report (fraud condition, criminal slot)
 *      EMD/                    earnest money deposit proof (its OWN folder —
 *                              never inside Contract & Assignment; owner-directed
 *                              2026-07-31)
 *      Flood Cert/             flood certificate
 *      ID/                     photo ID + Social Security card
 *      Insurance/              insurance binder + invoice + insurance replies
 *      LLC/                    every entity document (incl. layered owning LLCs)
 *      REO/                    Track Record.xlsx + Track Record.pdf  +  one folder per prior property
 *      Scope of Work/          the SOW tool's branded Excel + PDF (NOT the HTML) + plans & permits
 *      Term Sheet/             uploaded + signed term sheet (+ registered terms)
 *      TITLE/                  title documents + title replies
 *      Other Documents/        anything that didn't match a category (flagged)
 *
 * (No _Manifest.json / _Package Index.txt — owner-directed 2026-07-30: the ZIP is
 * just the clean document folders, no technical index/manifest files.)
 *
 * HARD FREEZE (owner-directed): the Heter Iska — unsigned AND signed — is NEVER
 * in the TPR export. Guarded THREE independent ways in the selection: the
 * rtl_cond_iska condition is tpr_exclude=true; the doc_kinds heter_iska /
 * heter_iska_signed are denied; and a word-boundary "iska"/"heter" match on the
 * condition label AND the filename is denied. DocuSign completion certificates
 * (esign_certificate) are also excluded — one of them belongs to the Iska
 * envelope and would reveal it. See docs/DOCUSIGN-DOCUMENT-BUILD-SPEC Addendum A.9.
 *
 * What else stays OUT (each a deliberate, individually-decided exclusion):
 *   - documents NOBODY HAS ACCEPTED YET (owner-directed 2026-08-03) — a document
 *     sitting on a condition unreviewed is not part of the file's document set,
 *     is not ready to ship, and may not go to an investor. See
 *     lib/document-acceptance.js. Held-back documents are REPORTED, never
 *     silently dropped: `heldBack` on the build, `pending` on the preview.
 *   - rejected documents and superseded versions (is_current=false) — trash
 *   - chat attachments (conversation exhibits, not file documents)
 *   - items flagged tpr_exclude (owner-directed per-condition exclusions:
 *     ISKA, investor-structure printout, settlement statement, draw request /
 *     wire forms — db/051/db/056/db/215/db/206)
 *   - an EXPIRED Certificate of Good Standing (#83 — behaves like empty)
 *   - system-generated regen artifacts (prior TPR zips, autosaved track-record
 *     printouts, PILOT draw-inspection reports) — the export builds its own.
 * Track-record verification docs are gated at the LINE-ITEM level (they ride on
 * the project's is_verified flag) and land under REO/<prior property>.
 *
 * CORRUPTION DEFENCE (owner-directed 2026-07-21 "the PDF should not be
 * corrupted"): three layers. (1) the ZIP writer sets the UTF-8 name flag and
 * always stores real Buffers with a correct CRC, so good bytes are never
 * mangled by the packaging; (2) every source document is INTEGRITY-VERIFIED as
 * it is packed — the bytes read from storage are checked against the recorded
 * sha256 / size_bytes, and a PDF is sniffed for its "%PDF" magic — and any
 * mismatch is recorded in _Manifest.json / _Package Index.txt so staff can
 * re-request that one file (the doc still ships, flagged, so nothing is
 * silently dropped); (3) a file that cannot be read at all is listed as
 * unavailable rather than shipped as an empty/half file.
 *
 * Every generated export is ALSO saved as a document row (doc_kind 'tpr_export',
 * visibility 'internal' so it can never ride into a future buyer package) —
 * which makes the SharePoint mirror pick it up into the file's TPR Exports
 * folder, with Version-N history on re-export.
 */
const crypto = require('crypto');
const db = require('../db');
const storage = require('./storage');
const { zip } = require('./zip');

// ------------------------------------------------------- category folder names
// The fixed set of clean folder names (owner-directed 2026-07-21). Every
// document lands in EXACTLY ONE of these — by clean name, no number prefixes.
const C = {
  APPLICATION: 'Application',
  APPRAISAL: 'Appraisal',
  BACKGROUND: 'Background Check',
  BANK: 'Bank Statements',
  CONTRACT: 'Contract & Assignment',
  CREDIT: 'Credit Report',
  CRIMINAL: 'Criminal Check',
  EMD: 'EMD',
  FLOOD: 'Flood Cert',
  ID: 'ID',
  INSURANCE: 'Insurance',
  LLC: 'LLC',
  REO: 'REO',
  SOW: 'Scope of Work',
  TERMSHEET: 'Term Sheet',
  TITLE: 'TITLE',
  DRAWS: 'Draws',
  OTHER: 'Other Documents',
};

// Exact checklist-template code → category. The most reliable signal for a
// condition-attached document (the code is stable; labels get relabeled).
const CODE_CATEGORY = {
  // ID (photo ID + Social Security card)
  // (a Social Security card / SSA-89 is an identity document, same as the photo ID)
  gov_id: C.ID, rtl_p1_id: C.ID, rtl_p1_ssn: C.ID, cond_ssn_verify_corrfirst: C.ID,
  // Contract & Assignment (purchase contract, assignment letter)
  purchase_contract: C.CONTRACT, rtl_p1_contract: C.CONTRACT, rtl_p5_assign: C.CONTRACT,
  // EMD proof (the CorrFirst earnest-money condition) — its OWN folder, never
  // filed inside Contract & Assignment (owner-directed 2026-07-31).
  cond_emd_corrfirst: C.EMD,
  // The non-owner-occupied affidavit files with the ENTITY documents: on an
  // individual-vested file it is what stands in for the entity file (db/417).
  cond_noo_affidavit_individual: C.LLC,
  // LLC / vesting entity documents
  llc_docs: C.LLC, operating_agmt: C.LLC, rtl_p1_llc: C.LLC,
  rtl_llc_formation: C.LLC, rtl_llc_ein: C.LLC, rtl_llc_opagmt: C.LLC, rtl_llc_goodstanding: C.LLC,
  // Credit report
  rtl_cond_credit: C.CREDIT, rtl_p3_credit: C.CREDIT,
  // Insurance (binder + invoice)
  insurance_binder: C.INSURANCE, rtl_cond_insurance: C.INSURANCE,
  // Title
  title_commitment: C.TITLE, rtl_cond_title: C.TITLE,
  // Refinance payoff (db/464) — the borrower's current mortgage / payoff
  // statement (external) and the ordered/verified payoff (internal) file with
  // Title: they clear the existing lien on the property.
  cond_payoff_external: C.TITLE, cond_payoff_internal: C.TITLE,
  // Flood
  rtl_cond_flood: C.FLOOD,
  // Bank statements / assets
  bank_statements: C.BANK, rtl_p3_assets: C.BANK, voided_check: C.BANK,
  // Appraisal
  rtl_cond_appraisaldocs: C.APPRAISAL,
  // Application (signed application + business-purpose disclosure)
  rtl_cond_signed_app: C.APPLICATION, rtl_cond_disclosures: C.APPLICATION,
  // Term sheet
  rtl_cond_signedts: C.TERMSHEET,
  // REO / experience
  rtl_p3_reo: C.REO,
  // Scope of Work / rehab budget / plans & permits
  scope_of_work: C.SOW, rtl_p3_sow1: C.SOW, rtl_p1_budget: C.SOW, rtl_p1_plans: C.SOW,
  // (rtl_cond_fraud is handled specially below — it holds BOTH background and
  //  criminal reports, split by the document's slot.)
};

// Keyword fallback on a document's label + filename when neither the doc_kind
// nor the exact template code identified it. Ordered so the most specific
// categories win. Returns null → the document is "Other Documents".
function keywordCategory(text) {
  const s = ' ' + String(text || '').toLowerCase() + ' ';
  if (/criminal/.test(s)) return C.CRIMINAL;
  if (/background/.test(s)) return C.BACKGROUND;
  if (/credit|fico|bureau|xactus/.test(s)) return C.CREDIT;
  if (/flood/.test(s)) return C.FLOOD;
  // Title BEFORE insurance: "title insurance" / "title policy" is a TITLE doc,
  // not an Insurance one — the insurance branch would otherwise swallow it.
  if (/\btitle\b|commitment/.test(s)) return C.TITLE;
  if (/insurance|hazard|\bbinder\b/.test(s)) return C.INSURANCE;
  if (/appraisal|valuation|\bbpo\b/.test(s)) return C.APPRAISAL;
  if (/scope of work|\bsow\b|rehab budget|construction budget|\bplans\b|permit/.test(s)) return C.SOW;
  if (/earnest|\bemd\b|escrow deposit/.test(s)) return C.EMD;
  if (/assignment|purchase (contract|agreement|and sale)|sales? contract|contract of sale|executed contract|\bpsa\b/.test(s)) return C.CONTRACT;
  if (/bank statement|statement|voided check|proof of funds|liquid|reserve|\basset/.test(s)) return C.BANK;
  if (/operating agreement|certificate of formation|articles of organization|ein|good standing|\bllc\b|entity/.test(s)) return C.LLC;
  if (/social security|\bss card\b|\bssn\b|photo id|government|driver|passport|license|\bid\b/.test(s)) return C.ID;
  if (/term sheet/.test(s)) return C.TERMSHEET;
  if (/disclosure|signed application|loan application|\bapplication\b/.test(s)) return C.APPLICATION;
  if (/\breo\b|experience|track record/.test(s)) return C.REO;
  return null;
}

// The category folder a subject-file document belongs in. Signal order:
// generated/system doc_kind → entity scope → the fraud slot split → the exact
// condition code → keyword fallback → Other Documents (never dropped).
function categoryFor(d) {
  const kind = String(d.doc_kind || '').toLowerCase();
  const code = String(d.template_code || '').toLowerCase();

  // 1) doc_kind — generated / uploaded system documents.
  if (kind === 'photo_id') return C.ID;
  if (kind === 'term_sheet' || kind === 'term_sheet_signed') return C.TERMSHEET;
  if (kind === 'application_signed') return C.APPLICATION;
  if (kind === 'bp_disclosure_signed') return C.APPLICATION;
  if (kind.indexOf('appraisal_') === 0) return C.APPRAISAL;   // appraisal_pdf/xml/photo
  if (kind === 'title_order_return') return C.TITLE;
  if (kind === 'insurance_order_return') return C.INSURANCE;
  // Construction-draw artifacts get their OWN folder in the SharePoint mirror (which shares this
  // categorizer) instead of landing in "Other Documents" among the loan's origination paperwork —
  // a draw's invoices, receipts and reports are a different chapter of the file's life. They are
  // DELIBERATELY NOT in the investor TPR package: TPR_DOC_SELECT excludes draw_inspection_report /
  // draw_packet by doc_kind, and draw_support joins them there, so this only ever decides a folder.
  if (kind === 'draw_support' || kind === 'draw_inspection_report' || kind === 'draw_packet') return C.DRAWS;

  // 2) Entity (vesting LLC + layered owning LLCs) — any doc carrying an llc_id.
  if (d.llc_id) return C.LLC;

  // 3) The fraud/background condition holds BOTH reports — split by the slot.
  if (code === 'rtl_cond_fraud') {
    const s = `${d.slot_label || ''} ${d.item_label || ''} ${d.filename || ''}`.toLowerCase();
    return /criminal/.test(s) ? C.CRIMINAL : C.BACKGROUND;
  }

  // 4) Exact condition code.
  if (CODE_CATEGORY[code]) return CODE_CATEGORY[code];

  // 5) Keyword fallback, else Other Documents.
  return keywordCategory(`${d.item_label || ''} ${d.filename || ''}`) || C.OTHER;
}

// ------------------------------------------------------------------- name safety
// Folder-name form of an address / project label. Path separators AND dot-runs
// are neutralized so a crafted value can never produce a `..` traversal segment.
const folderName = (s) => String(s || 'Property')
  .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\.{2,}/g, '.').replace(/(^[.\s]+|[.\s]+$)/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, 90) || 'Property';

// Clean, human-readable file name: keep spaces + the extension, strip only the
// path-dangerous / control characters and any `..` run, never leading dots.
const cleanFileName = (s) => {
  const base = String(s || 'document')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/, '').replace(/\s+/g, ' ').trim();
  return base.slice(0, 120) || 'document';
};

// De-duplicate a file name WITHIN one folder ("Deed.pdf" → "Deed (2).pdf"),
// so two documents that share a name never collide (or overwrite) in the ZIP.
function uniqueIn(usedByDir, dir, name) {
  const set = usedByDir[dir] || (usedByDir[dir] = new Set());
  if (!set.has(name.toLowerCase())) { set.add(name.toLowerCase()); return name; }
  const m = name.match(/^(.*?)(\.[a-zA-Z0-9]{1,8})?$/);
  const stem = m && m[1] ? m[1] : name;
  const ext = m && m[2] ? m[2] : '';
  let i = 2;
  while (set.has(`${stem} (${i})${ext}`.toLowerCase())) i += 1;
  const out = `${stem} (${i})${ext}`;
  set.add(out.toLowerCase());
  return out;
}

const sanitize = (s) => String(s || 'file').replace(/[^a-zA-Z0-9._ -]/g, '').replace(/\s+/g, '_').slice(0, 80);

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

/* The frozen 3-year exit window — ONE definition, in src/lib/experience.js,
   the module the sign-off gate and every experience count already read.
   This used to be a private fourth re-derivation (`sale_date || refi_date ||
   rent_date`, no deal_type branch, a 30.44-day month), so the investor package's
   "Recent (3yr)" column could disagree with the counts the file was underwritten
   on. Do not re-implement it here again. */
const { exitDateOf, exitCounts } = require('./experience');
function exitInfo(r) {
  return { exit: exitDateOf(r), counts: exitCounts(r) };
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
function buildXlsx(rows, sheetName = 'Track Record') {
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
      + `<sheets><sheet name="${xmlEsc(String(sheetName).slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>`
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

/* ---------------- shared TPR document selection (the ONE chokepoint) --------
   The package includes every CURRENT, ACCEPTED document connected to the file,
   across every source — the application's own docs (any condition, internal or
   borrower, plus loose attachments), the vesting entity's docs including
   LAYERED owning entities (db/094), and borrower-profile docs (photo ID etc.)
   for borrower + co-borrower. Both the ZIP builder and the staff preview
   endpoint MUST draw from these helpers so the panel's promised count can never
   disagree with the package.

   REVIEW GATES INCLUSION AGAIN (owner-directed 2026-08-03 — this REVERSES the
   2026-07-16 "a pending doc ships and is LABELED pending in the manifest"
   decision). Two things made that decision unsafe. First, the label lived in
   _Manifest.json, which was dropped on 2026-07-30 as a "garbage" technical file
   — so from that day the pending document shipped with nothing saying so.
   Second, and the reason it was reported: an insurance condition carried
   documents from a PREVIOUS policy that were never accepted, insurance was then
   ordered and the return accepted, and the investor package + the email to the
   closing attorney went out carrying BOTH. The owner's rule is now literal —
   "documents that are not accepted yet are not part of the documents in the
   folder, they are not part of ready-to-ship, they cannot be used to send the
   closing prep and cannot be used for TPR export". `document-acceptance` is the
   one definition; nothing is silently dropped, because `selectTprPending` below
   reports exactly what was held back and every surface prints it.

   Also returns template_code / slot_label / llc_id and the integrity columns
   (sha256 / size_bytes / content_type) so the builder can both CATEGORIZE the
   document and VERIFY its bytes are not corrupt. */
const docAccept = require('./document-acceptance');
// ONE query body, TWO review tests. `selectTprDocuments` asks for the accepted
// set (what ships) and `selectTprPending` asks the SAME question of the pending
// set (what was held back and why the counts differ) — written once so the two
// answers can never describe different corpora. Every other filter, the entity
// walk and all three Heter-Iska guards are shared by construction.
const TPR_DOC_SELECT_FOR = (reviewTest) => `
  WITH RECURSIVE ctx AS (
    SELECT borrower_id, co_borrower_id, llc_id FROM applications WHERE id=$1
  ), entity_tree AS (
    SELECT llc_id AS id FROM ctx WHERE llc_id IS NOT NULL
    UNION
    SELECT m.owner_llc_id FROM llc_members m JOIN entity_tree e ON m.llc_id = e.id
     WHERE m.owner_llc_id IS NOT NULL
  )
  SELECT d.id, d.filename, d.storage_ref, d.reviewed_at, d.created_at, d.doc_kind,
         d.slot_label, d.llc_id, d.sha256, d.size_bytes, d.content_type,
         COALESCE(d.review_status,'pending') AS review_status,
         ci.label AS item_label, ct.code AS template_code, s.full_name AS reviewed_by_name
    FROM documents d
    LEFT JOIN checklist_items ci ON ci.id=d.checklist_item_id
    LEFT JOIN checklist_templates ct ON ct.id=ci.template_id
    LEFT JOIN staff_users s ON s.id=d.reviewed_by
   WHERE (d.application_id=$1
          OR (d.application_id IS NULL AND d.llc_id IN (SELECT id FROM entity_tree))
          OR (d.application_id IS NULL AND d.llc_id IS NULL AND d.track_record_id IS NULL
              AND d.lead_id IS NULL
              AND d.borrower_id IN (SELECT borrower_id FROM ctx
                                    UNION SELECT co_borrower_id FROM ctx WHERE co_borrower_id IS NOT NULL)))
     AND d.is_current=true
     AND ${reviewTest}
     AND COALESCE(d.source_type,'') <> 'chat_attachment'
     AND (ci.tpr_exclude IS NOT TRUE)
     -- system-regenerated artifacts (a prior TPR zip, autosaved track-record
     -- printouts, the PILOT-branded draw inspection reports) are not source
     -- documents — and re-packing a regenerable export inside the next one must
     -- never happen. Keep this list in step with sharepoint-backup.isRegenKind.
     AND COALESCE(d.doc_kind,'') NOT IN ('track_record_html','tpr_export','draw_inspection_report','draw_packet','draw_support','appraisal_photo')
     AND COALESCE(d.doc_kind,'') NOT LIKE '%\\_export'
     -- Closing-chain CORRESPONDENCE (whatever the attorney's chain mailed us) is a
     -- running record, not a source document, and much of it is drafts and internal
     -- back-and-forth. It has its own package on the file and its own SharePoint
     -- folder; the real closing documents reach the investor through the closer's
     -- own conditions after a human has reviewed them. Never in an investor package.
     AND COALESCE(d.doc_kind,'') <> 'closing_correspondence'
     -- HARD FREEZE (owner-directed): the Heter Iska — unsigned AND signed — is
     -- NEVER in the TPR export (kept only in-system + on DocuSign). THREE guards:
     --   (a) rtl_cond_iska.tpr_exclude=true (the condition exclusion above),
     --   (b) the doc_kinds heter_iska / heter_iska_signed are denied here,
     --   (c) a word-boundary "iska"/"heter" match on the condition label AND on
     --       the filename is denied — so a loosely-attached copy can't slip in.
     -- DocuSign completion certificates are excluded too: one belongs to the
     -- Iska envelope and would reveal it. See docs/DOCUSIGN…-SPEC Addendum A.9.
     AND COALESCE(d.doc_kind,'') NOT IN ('heter_iska','heter_iska_signed','esign_certificate')
     -- The name test is NOT a plain word-boundary match (audited leak, 2026-07-28):
     -- a word boundary needs a non-word character on BOTH sides, so a smashed
     -- filename -- HeterIska_Signed.pdf, HETERISKA.PDF -- matched nothing and a
     -- HARD-FROZEN document shipped in the investor package. Two branches now:
     -- heter...iska adjacent in any casing with or without a separator (nothing else
     -- in a loan file spells that, so it needs no boundary), and a STANDALONE
     -- iska/heter where the boundary IS kept on purpose so a "Siska Ave" or an
     -- "Iskander" is never silently dropped. Keep in step with
     -- closing-prep.FROZEN_NAME_RE.
     -- slot_label is the THIRD field and is not optional: a document uploaded into
     -- an entity's own library has no doc_kind, no condition and no template code,
     -- so the slot the uploader typed is its only identity. A signed Heter Iska
     -- scanned as scan_0042.pdf under the slot "Heter Iska" cleared every other
     -- guard here and shipped in the investor package.
     AND COALESCE(ci.label,'') !~* 'heter[[:space:]_.-]*iska|(^|[^a-z0-9])(iska|heter)([^a-z0-9]|$)'
     AND COALESCE(d.filename,'') !~* 'heter[[:space:]_.-]*iska|(^|[^a-z0-9])(iska|heter)([^a-z0-9]|$)'
     AND COALESCE(d.slot_label,'') !~* 'heter[[:space:]_.-]*iska|(^|[^a-z0-9])(iska|heter)([^a-z0-9]|$)'
     -- #83: an EXPIRED Certificate of Good Standing behaves like empty
     -- everywhere, so it must not ship as if it were a live document. Guard the
     -- template_id IS NOT NULL first: a loose/profile/entity doc has NULL
     -- template_id, and NULL IN (...) evaluates to NULL, which would drop EVERY
     -- such doc older than 30 days (this change is supposed to ship them).
     AND NOT (d.created_at < now() - interval '30 days'
              AND ci.template_id IS NOT NULL
              AND ci.template_id IN (SELECT id FROM checklist_templates
                                      WHERE code='rtl_llc_goodstanding' AND scope='llc'))
   ORDER BY ci.sort_order NULLS LAST, d.created_at`;
// What SHIPS. Kept as a named constant too, because several tests and the
// closing-prep module reason about the selection contract by name.
const TPR_DOC_SELECT = TPR_DOC_SELECT_FOR(docAccept.ACCEPTED_SQL('d'));
// What was HELD BACK — the same corpus, still awaiting a human's decision. This
// is the "no silent drops" half of the rule: every surface that reports an
// included count also reports this one, so "why is the insurance binder not in
// the package?" is answered on the screen instead of discovered by the investor.
const TPR_DOC_PENDING_SELECT = TPR_DOC_SELECT_FOR(docAccept.AWAITING_SQL('d'));

async function selectTprDocuments(appId) {
  return (await db.query(TPR_DOC_SELECT, [appId])).rows;
}
async function selectTprPending(appId) {
  return (await db.query(TPR_DOC_PENDING_SELECT, [appId])).rows;
}

// Document conditions that would ship EMPTY: not satisfied/signed off and no
// current ACCEPTED document at all. A condition whose only document is still
// waiting for a decision genuinely WOULD ship empty now, so it belongs on this
// list — reading it as covered was the same mistake as shipping the document.
async function selectTprMissing(appId) {
  return (await db.query(
    `SELECT COALESCE(label,'(document)') AS label FROM checklist_items ci
      WHERE application_id=$1 AND item_kind='document' AND status <> 'satisfied'
        AND signed_off_at IS NULL AND (tpr_exclude IS NOT TRUE)
        AND NOT EXISTS (SELECT 1 FROM documents d
                         WHERE d.checklist_item_id=ci.id AND d.is_current
                           AND ${docAccept.ACCEPTED_SQL('d')})
      ORDER BY sort_order`, [appId])).rows.map(r => r.label);
}

// Scope-of-Work tool exports: the branded PDF + Excel the SOW / rehab-budget tool
// generates on submit, stored as doc_kind 'rehab_budget_export' on the SOW
// condition (alongside the HTML snapshot). Pulled DIRECTLY here — the shared
// TPR_DOC_SELECT deliberately drops every '*_export' kind, so without this the
// Scope of Work folder never received the tool's own PDF/Excel. Only the CURRENT,
// ACCEPTED set (a re-submit supersedes the prior one). The tool's own exports are
// PILOT's own output and are born accepted at their insert (borrower.js /
// staff.js tool-submit, sitewire/sow-line-edit.js) — so this filter never empties
// the Scope of Work folder; it only keeps a rejected or hand-superseded export
// out. The caller drops the HTML (owner-directed 2026-07-30).
async function selectSowExports(appId) {
  return (await db.query(
    `SELECT d.id, d.filename, d.storage_ref, d.sha256, d.size_bytes, d.content_type, d.created_at
       FROM documents d
      WHERE d.application_id=$1 AND d.doc_kind='rehab_budget_export' AND d.is_current=true
        AND ${docAccept.ACCEPTED_SQL('d')}
        AND COALESCE(d.source_type,'') <> 'chat_attachment'
      ORDER BY d.created_at`, [appId])).rows;
}

// The HTML snapshot a tool ships alongside its PDF/Excel — identified by extension
// or content-type — is left OUT of the TPR export (owner-directed 2026-07-30).
const isHtmlExport = (d) => /\.html?$/i.test(d.filename || '')
  || String(d.content_type || '').toLowerCase().includes('html');

// Track-record verification docs for a set of line items (current, non-chat,
// ACCEPTED — staff-internal docs ship too, per the everything directive). Same
// rule as the file's own documents: a prior-project deed nobody has reviewed is
// not evidence the investor should be handed. `selectTrackRecordPending` is the
// held-back half, reported beside it.
async function selectTrackRecordDocs(trIds) {
  if (!trIds || !trIds.length) return [];
  return (await db.query(
    `SELECT id, track_record_id, filename, storage_ref, sha256, size_bytes, content_type, created_at
       FROM documents
      WHERE track_record_id = ANY($1::uuid[]) AND is_current=true
        AND COALESCE(source_type,'') <> 'chat_attachment'
        AND ${docAccept.ACCEPTED_SQL('')}
      ORDER BY created_at`, [trIds])).rows;
}
async function selectTrackRecordPending(trIds) {
  if (!trIds || !trIds.length) return [];
  return (await db.query(
    `SELECT id, track_record_id, filename, created_at
       FROM documents
      WHERE track_record_id = ANY($1::uuid[]) AND is_current=true
        AND COALESCE(source_type,'') <> 'chat_attachment'
        AND ${docAccept.AWAITING_SQL('')}
      ORDER BY created_at`, [trIds])).rows;
}

// ------------------------------------------------------------- integrity check
// Verify the bytes we are about to pack are not corrupt. Returns null when
// everything checks out, or a short reason string when something is off. The
// document still ships (nothing is silently dropped) — the reason is recorded
// in the manifest so staff can re-request that one file.
function integrityIssue(row, bytes) {
  if (!bytes || bytes.length === 0) return 'empty file (0 bytes)';
  if (row.size_bytes != null && Number(row.size_bytes) > 0 && Number(row.size_bytes) !== bytes.length) {
    return `size mismatch (recorded ${row.size_bytes}, packed ${bytes.length})`;
  }
  if (row.sha256) {
    const got = crypto.createHash('sha256').update(bytes).digest('hex');
    if (got !== row.sha256) return 'content hash mismatch (bytes changed since upload)';
  }
  // A file that claims to be a PDF must actually start with the %PDF magic —
  // this catches an HTML error page or a base64-garbled upload saved as .pdf.
  const looksPdf = /\.pdf$/i.test(row.filename || '') || String(row.content_type || '').includes('pdf');
  if (looksPdf && bytes.slice(0, 5).toString('latin1') !== '%PDF-') return 'not a valid PDF (missing %PDF header)';
  return null;
}

async function buildTprExport(appId) {
  const app = (await db.query(
    `SELECT a.ys_loan_number, a.program, a.loan_type, a.property_address,
            a.usps_address, a.usps_match, a.usps_verified_at, a.usps_imported_at,
            a.borrower_id, a.co_borrower_id,
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

  // EVERY ACCEPTED document on the file — see the shared selection above for the
  // full inclusion/exclusion contract (incl. the Heter Iska hard freeze).
  const docs = await selectTprDocuments(appId);

  // What was HELD BACK for review. Reported on the download response and on the
  // preview so the count difference is never a mystery — a package quietly one
  // document short is the failure this whole change exists to prevent.
  const heldBack = (await selectTprPending(appId))
    .map((d) => ({ id: d.id, filename: d.filename, requirement: d.item_label || null }));

  // Document conditions that would ship empty — the pre-flight list.
  const missing = await selectTprMissing(appId);

  // The borrower's (and co-borrower's) operational track record.
  const borrowerIds = [app.borrower_id, app.co_borrower_id].filter(Boolean);
  const records = (await db.query(
    // A REJECTED line (the team decided it is not the borrower's, a duplicate, or
    // wrong) is not part of their track record and never ships to the investor
    // (owner-directed 2026-08-10, #40; db/519). Every other status still ships,
    // each with its own review-status stamp.
    `SELECT id, borrower_id, property_address, deal_type, purchase_price, sale_price, rehab_amount,
            purchase_date, sale_date, rent_amount, rent_date, refi_amount, refi_date, current_value,
            is_verified, verified_at, verification_status, entered_by_kind, notes
       FROM track_records
      WHERE borrower_id = ANY($1::uuid[])
        AND COALESCE(verification_status, '') <> 'rejected'
      ORDER BY COALESCE(sale_date, refi_date, rent_date, purchase_date) DESC NULLS LAST, created_at DESC`,
    [borrowerIds])).rows;

  // Per-line-item verification documents (current, non-chat).
  const trDocs = await selectTrackRecordDocs(records.map(r => r.id));
  const docsByTr = {};
  for (const d of trDocs) (docsByTr[d.track_record_id] = docsByTr[d.track_record_id] || []).push(d);

  const files = [];
  const manifestDocs = [];
  const unavailable = [];
  const integrityWarnings = [];
  const usedByDir = {};   // folderPath -> Set(lowercased names) — collision guard

  // The TPR package is financing output, so its root/property label prefers the
  // separately stamped USPS form when USPS confirmed the address.
  const subjectAddress = require('./usps-verify').preferredFinancingAddress(app);
  const subjectAddr = addrText(subjectAddress) || 'Property';
  const ROOT = folderName(subjectAddr);   // the ONE top folder, named for the property

  // 1) Subject-file documents → ROOT/<Category>/<clean filename>.
  for (const d of docs) {
    let bytes;
    try { bytes = await storage.read(d.storage_ref); }
    catch (_) { unavailable.push({ source: d.filename, requirement: d.item_label || null }); continue; }
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes || '');

    const category = categoryFor(d);
    const dir = `${ROOT}/${category}`;
    const name = uniqueIn(usedByDir, dir, cleanFileName(d.filename));
    const path = `${dir}/${name}`;
    files.push({ name: path, data: bytes });

    const issue = integrityIssue(d, bytes);
    if (issue) integrityWarnings.push({ file: path, source: d.filename, issue });

    manifestDocs.push({
      file: path, source: d.filename, category, requirement: d.item_label || null,
      review: d.review_status,
      accepted_by: d.review_status === 'accepted' ? (d.reviewed_by_name || null) : null,
      accepted_at: d.review_status === 'accepted' ? (d.reviewed_at || d.created_at) : null,
      integrity: issue ? 'CHECK' : 'ok',
    });
  }

  // 1b) Scope of Work → the branded PDF + Excel the SOW tool produced. The tool
  //     stores three formats (HTML + Excel + PDF) as '*_export' docs, which the
  //     shared selection drops; here we ADD the Excel + PDF into the Scope of Work
  //     folder and deliberately skip the HTML (owner-directed 2026-07-30).
  const sowExports = await selectSowExports(appId);
  for (const d of sowExports) {
    if (isHtmlExport(d)) continue;
    let bytes;
    try { bytes = await storage.read(d.storage_ref); }
    catch (_) { unavailable.push({ source: d.filename, requirement: C.SOW }); continue; }
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes || '');
    const dir = `${ROOT}/${C.SOW}`;
    const name = uniqueIn(usedByDir, dir, cleanFileName(d.filename));
    const path = `${dir}/${name}`;
    files.push({ name: path, data: bytes });
    const issue = integrityIssue(d, bytes);
    if (issue) integrityWarnings.push({ file: path, source: d.filename, issue });
    manifestDocs.push({
      file: path, source: d.filename, category: C.SOW, requirement: 'Scope of Work export',
      review: 'n/a', accepted_by: null, accepted_at: d.created_at, integrity: issue ? 'CHECK' : 'ok',
    });
  }

  // 2) REO → the branded Track Record workbook + PDF report first, then one folder
  //    per prior property with that project's verification documents.
  const borrowerName = require('./person-name').displayName(app);
  const generatedAt = new Date().toISOString();
  const REO = `${ROOT}/${C.REO}`;

  // Split the projects into Fix & Flip (exit = sale) and Fix & Hold / Rental
  // (exit = lease-up / refinance), the same two-section shape the Track Record
  // TOOL shows — so the packaged Excel + PDF read like our own tracker, not a
  // flat grid. A row with no deal_type is bucketed by the data it carries.
  const num = (v) => (v == null || v === '') ? null : Number(v);
  const monthsBetween = (a, b) => {
    if (!a || !b) return '';
    const d1 = new Date(a), d2 = new Date(b);
    if (isNaN(d1) || isNaN(d2)) return '';
    const m = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
    return m >= 0 ? m : '';
  };
  const isHoldType = (r) => {
    const t = String(r.deal_type || '').toLowerCase();
    if (/rent|hold/.test(t)) return true;
    if (t) return false;   // flip / bridge / ground-up all exit by sale
    return !!(r.rent_amount || r.rent_date || r.refi_amount || r.refi_date);   // infer from data
  };
  const flipCols = [
    { header: 'Property', key: 'property', w: 3, align: 'left' },
    { header: 'Deal type', key: 'dealType', w: 1.3 },
    { header: 'Purchase price', key: 'purchase', w: 1.3, money: true, align: 'right', sum: true },
    { header: 'Purchase date', key: 'purchaseDate', w: 1.1, align: 'center' },
    { header: 'Rehab budget', key: 'rehab', w: 1.2, money: true, align: 'right', sum: true },
    { header: 'Sale price', key: 'sale', w: 1.3, money: true, align: 'right', sum: true },
    { header: 'Sale date', key: 'saleDate', w: 1.1, align: 'center' },
    { header: 'Hold (mo)', key: 'holdMo', w: 0.8, align: 'center' },
    { header: 'Gross profit', key: 'profit', w: 1.2, money: true, align: 'right', sum: true },
    { header: 'Review status', key: 'status', w: 1.5, align: 'center' },
    { header: 'Docs', key: 'docs', w: 0.7, align: 'center' },
    { header: 'Recent (3yr)', key: 'counts', w: 0.9, align: 'center' },
  ];
  const holdCols = [
    { header: 'Property', key: 'property', w: 3, align: 'left' },
    { header: 'Deal type', key: 'dealType', w: 1.3 },
    { header: 'Purchase price', key: 'purchase', w: 1.3, money: true, align: 'right', sum: true },
    { header: 'Purchase date', key: 'purchaseDate', w: 1.1, align: 'center' },
    { header: 'Rehab budget', key: 'rehab', w: 1.2, money: true, align: 'right', sum: true },
    { header: 'Monthly rent', key: 'rent', w: 1.2, money: true, align: 'right', sum: true },
    { header: 'Rented date', key: 'rentDate', w: 1.1, align: 'center' },
    { header: 'Refi amount', key: 'refi', w: 1.2, money: true, align: 'right', sum: true },
    { header: 'Refi date', key: 'refiDate', w: 1.0, align: 'center' },
    { header: 'Current value', key: 'currentValue', w: 1.3, money: true, align: 'right', sum: true },
    { header: 'Review status', key: 'status', w: 1.5, align: 'center' },
    { header: 'Docs', key: 'docs', w: 0.7, align: 'center' },
    { header: 'Recent (3yr)', key: 'counts', w: 0.9, align: 'center' },
  ];
  const trExport = require('./track-record-export');
  const flipRows = [], holdRows = [];
  for (const r of records) {
    const { exit, counts } = exitInfo(r);
    // The REVIEW STATUS + whether documentation is attached (owner-directed
    // 2026-08-05): the export must say clearly which deals are verified, which
    // have documentation, which are pending review, and which have documentation
    // but are not yet verified — never "everything is verified".
    const hasDocs = (docsByTr[r.id] || []).length > 0;
    const statusKey = trExport.trackRecordReviewStatus({ is_verified: r.is_verified, entered_by_kind: r.entered_by_kind, hasDocs });
    const base = {
      property: addrText(r.property_address) || '', dealType: dealLabel(r.deal_type),
      purchase: num(r.purchase_price), rehab: num(r.rehab_amount),
      purchaseDate: dateStr(r.purchase_date),
      status: trExport.REVIEW_STATUS[statusKey].label,
      docs: hasDocs ? 'Attached' : '—',
      counts: counts ? 'Yes' : (exit ? 'No' : ''),
      __verified: !!r.is_verified, __status: statusKey, __hasDocs: hasDocs,
    };
    if (isHoldType(r)) {
      holdRows.push({ ...base, rent: num(r.rent_amount), rentDate: dateStr(r.rent_date),
        refi: num(r.refi_amount), refiDate: dateStr(r.refi_date), currentValue: num(r.current_value) });
    } else {
      const sale = num(r.sale_price);
      flipRows.push({ ...base, sale, saleDate: dateStr(r.sale_date),
        holdMo: monthsBetween(r.purchase_date, r.sale_date),
        profit: sale != null ? sale - (num(r.purchase_price) || 0) - (num(r.rehab_amount) || 0) : null });
    }
  }
  const trSections = [
    { title: 'FIX & FLIP EXPERIENCE   (exit = sale)', columns: flipCols, rows: flipRows },
    { title: 'FIX & HOLD / RENTAL EXPERIENCE   (exit = lease-up / refinance)', columns: holdCols, rows: holdRows },
  ];
  const trMeta = { borrowerName, generatedDate: dateStr(generatedAt) };
  // Nicer, sectioned Excel (reuses the proven style-free writer — no corruption risk).
  files.push({ name: `${REO}/Track Record.xlsx`, data: buildXlsx(trExport.trackRecordAoa(trSections, trMeta), 'Track Record') });
  // Branded PDF report ("the PDF export from our track record section"). Best-effort:
  // a pdf-lib hiccup must never sink the whole package — the Excel + docs still ship.
  try {
    const trPdf = await trExport.buildTrackRecordPdf(trSections, trMeta);
    if (Buffer.isBuffer(trPdf) && trPdf.length) files.push({ name: `${REO}/Track Record.pdf`, data: trPdf });
  } catch (e) { console.warn('[tpr-export] track-record PDF failed:', e && e.message); }

  const trFolderCounts = {};
  const trManifest = [];
  for (const r of records) {
    const rdocs = docsByTr[r.id] || [];
    const label = addrText(r.property_address) || `Project ${String(r.id).slice(0, 8)}`;
    let folder = folderName(label);
    // Disambiguate two projects that normalize to the same folder name.
    if (trFolderCounts[folder]) folder = `${folder} (${trFolderCounts[folder] + 1})`;
    trFolderCounts[folderName(label)] = (trFolderCounts[folderName(label)] || 0) + 1;
    const dir = `${REO}/${folder}`;
    let docCount = 0;
    for (const d of rdocs) {
      let bytes;
      try { bytes = await storage.read(d.storage_ref); }
      catch (_) { unavailable.push({ source: d.filename, requirement: `REO — ${label}` }); continue; }
      if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes || '');
      docCount += 1;
      const name = uniqueIn(usedByDir, dir, cleanFileName(d.filename));
      const path = `${dir}/${name}`;
      files.push({ name: path, data: bytes });
      const issue = integrityIssue(d, bytes);
      if (issue) integrityWarnings.push({ file: path, source: d.filename, issue });
      manifestDocs.push({ file: path, source: d.filename, category: C.REO, requirement: `REO — ${label}`, review: 'n/a', accepted_by: null, accepted_at: d.created_at, integrity: issue ? 'CHECK' : 'ok' });
    }
    trManifest.push({ property: label, deal_type: r.deal_type || null, verified: !!r.is_verified, documents: docCount });
  }

  // 3) Registered loan terms → a plain-text summary inside the Term Sheet folder
  //    (the terms travel with the term sheet). Internal margin already stripped.
  if (registration) {
    const q = registration.quote || {};
    const s = q.sizing || {};
    const pct = (v, d = 2) => v == null ? 'n/a' : (Number(v) * 100).toFixed(d) + '%';
    // Note rate keeps its 3rd decimal (10.625%, not 10.63%) — owner-directed
    // 2026-08-04. LTC/LTV above stay at their existing precision.
    const rateTxt = (v) => v == null ? 'n/a' : require('./rate-format').fmtRatePct(v) + '%';
    const m = (v) => v == null ? 'n/a' : '$' + Math.round(Number(v)).toLocaleString('en-US');
    // Fees / cash-to-close show EXACT cents (owner-directed 2026-07-16 — a $86.76
    // fee must not round); loan/advance/holdback/reserve stay whole-dollar (frozen).
    const m2 = (v) => v == null ? 'n/a' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    files.push({
      name: `${ROOT}/${C.TERMSHEET}/Registered Loan Terms.txt`,
      data: Buffer.from([
        'YS CAPITAL GROUP - REGISTERED PRODUCT TERMS',
        `Product: ${[q.programLabel, q.productLabel].filter(Boolean).join(' - ') || registration.program}`,
        `Status: ${registration.status || 'n/a'}`,
        `Loan amount: ${m(s.totalLoan || registration.total_loan)}`,
        `Note rate: ${rateTxt(q.noteRate || registration.note_rate)}`,
        `Initial advance: ${m(s.initialAdvance)}`,
        `Rehab holdback: ${m(s.rehabHoldback)}`,
        `Financed interest reserve: ${m(s.financedReserve)}`,
        `LTC: ${pct(s.ltcPct, 1)}`,
        `Initial/as-is LTV: ${pct(s.acqLtvPct, 1)}`,
        `Loan-to-ARV: ${pct(s.arvPct, 1)}`,
        `Closing costs due: ${m2(q.closingCosts && q.closingCosts.dueAtClosing)}`,
        `Cash to close: ${m2(q.cashToClose)}`,
        `Liquidity required: ${m2(q.liquidityRequired || q.liquidity)}`,
        `Reserve basis: ${q.reserveBasis || 'n/a'}`,
        `Registered at: ${registration.created_at || 'n/a'}`,
      ].join('\n'), 'utf8'),
    });
  }

  // The machine-readable _Manifest.json and the human _Package Index.txt used to
  // be filed inside ROOT. Owner-directed 2026-07-30: drop them — they read as
  // "garbage" technical files in an otherwise clean package of document folders.
  // The download response + preview still report includedCount + missing from the
  // same tallies (manifestDocs / missing) below; the integrity/unavailable notes
  // are still gathered (cheap, and handy for logging) but no longer written in.

  const filename = `TPR_${sanitize(app.ys_loan_number || app.last_name || 'file')}_${generatedAt.slice(0, 10)}.zip`;
  return { zip: zip(files), filename, includedCount: manifestDocs.length, missing, heldBack };
}

/**
 * Persist a generated export as a document on the file (owner-directed
 * 2026-07-13) so the SharePoint mirror files it into the TPR Exports folder —
 * with Version-N history on re-export. visibility 'internal' structurally
 * excludes it from every future buyer package; superseding the previous export
 * drives the mirror's versioning. Best-effort: a failure never blocks download.
 */
async function saveTprExportDocument(appId, zipBuf, filename, actorId) {
  const app = (await db.query('SELECT borrower_id FROM applications WHERE id=$1', [appId])).rows[0];
  if (!app) return null;
  const { ref, provider } = await storage.save(zipBuf, { filename });
  const r = await db.query(
    `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id,
                            doc_kind, source_type, visibility, review_status, reviewed_at)
     -- BORN ACCEPTED: the export is PILOT's own artifact, so leaving it 'pending'
     -- would put a document nobody can review on the file's "waiting for a
     -- decision" list forever (owner-directed 2026-08-03). It is excluded from
     -- every package by doc_kind regardless.
     VALUES ($1,$2,$3,'application/zip',$4,$5,$6,'staff',$7,'tpr_export','system','internal','accepted',now()) RETURNING id`,
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
  buildTprExport, saveTprExportDocument, buildXlsx,
  // the shared selection chokepoint — the preview endpoint MUST use these so
  // its promised counts can never disagree with the built package
  selectTprDocuments, selectTprMissing, selectTrackRecordDocs, selectSowExports,
  // the held-back half — every surface that reports an included count reports this
  selectTprPending, selectTrackRecordPending,
  // exported for unit tests
  categoryFor, keywordCategory, integrityIssue, cleanFileName, isHtmlExport,
};

/**
 * TPR / clean-file export. Packages ONLY the clean set — accepted + current
 * documents — into a stacked, foldered ZIP with a manifest. Rejected,
 * superseded, and chat-attachment documents are structurally excluded.
 */
const db = require('../db');
const storage = require('./storage');
const { zip } = require('./zip');

// Map a checklist label to a stacking folder.
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
const sanitize = (s) => String(s || 'document').replace(/[^a-zA-Z0-9._ -]/g, '').replace(/\s+/g, '_').slice(0, 80);

async function buildTprExport(appId) {
  const app = (await db.query(
    `SELECT a.ys_loan_number, a.program, a.loan_type, a.property_address, b.first_name, b.last_name
       FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId])).rows[0];
  if (!app) throw new Error('application not found');

  const registration = (await db.query(
    `SELECT program, product_label, status, note_rate, total_loan, target_ltc, quote, created_at
       FROM product_registrations
      WHERE application_id=$1 AND is_current
      ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0] || null;

  // The clean set: accepted + current, never chat attachments. The vesting
  // LLC's accepted documents (formation / EIN / operating agreement, stored on
  // the entity, not the file) belong in the package too.
  const docs = (await db.query(
    `SELECT d.id, d.filename, d.storage_ref, d.reviewed_at, d.created_at,
            ci.label AS item_label, s.full_name AS reviewed_by_name
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id=d.checklist_item_id
       LEFT JOIN staff_users s ON s.id=d.reviewed_by
      WHERE (d.application_id=$1
             OR (d.application_id IS NULL AND d.llc_id IS NOT NULL
                 AND d.llc_id=(SELECT llc_id FROM applications WHERE id=$1)))
        AND d.review_status='accepted' AND d.is_current=true
        AND d.source_type <> 'chat_attachment'
        AND (ci.tpr_exclude IS NOT TRUE)
      ORDER BY ci.sort_order NULLS LAST, d.created_at`, [appId])).rows;

  // Required document items still missing an accepted doc — the pre-flight list.
  const missing = (await db.query(
    `SELECT COALESCE(label,'(document)') AS label FROM checklist_items
      WHERE application_id=$1 AND item_kind='document' AND status <> 'satisfied'
        AND (tpr_exclude IS NOT TRUE)
      ORDER BY sort_order`, [appId])).rows.map(r => r.label);

  const files = [];
  const manifestDocs = [];
  const unavailable = [];
  const counters = {};
  for (const d of docs) {
    let bytes;
    try { bytes = await storage.read(d.storage_ref); }
    catch (_) { unavailable.push({ source: d.filename, requirement: d.item_label || null }); continue; } // record the unreadable blob so the export never misrepresents a clean file as complete
    const folder = folderFor(d.item_label || d.filename);
    counters[folder] = (counters[folder] || 0) + 1;
    const nn = String(counters[folder]).padStart(2, '0');
    const ext = (d.filename.match(/\.[a-zA-Z0-9]{1,6}$/) || [''])[0] || '';
    const base = sanitize(d.item_label || d.filename.replace(/\.[^.]+$/, ''));
    const name = `${folder}/${nn}_${base}${ext}`;
    files.push({ name, data: bytes });
    manifestDocs.push({ file: name, source: d.filename, requirement: d.item_label || null, accepted_by: d.reviewed_by_name || null, accepted_at: d.reviewed_at || d.created_at });
  }

  const propLabel = (app.property_address && (app.property_address.oneLine || app.property_address.line1 || app.property_address.street)) || 'Property';
  const manifest = {
    generated_at: new Date().toISOString(),
    lender: 'YS Capital Group',
    loan_number: app.ys_loan_number || null,
    borrower: `${app.first_name || ''} ${app.last_name || ''}`.trim(),
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
    // Accepted docs whose stored bytes were unreadable (skipped from the ZIP) —
    // surfaced so the clean-file export is never silently misrepresented as complete.
    unavailable_documents: unavailable,
    missing_or_not_yet_accepted: missing,
  };
  if (registration) {
    files.push({
      name: '01_Application_and_Terms/00_REGISTERED_PRODUCT.json',
      data: Buffer.from(JSON.stringify(manifest.registered_terms, null, 2), 'utf8'),
    });
    const q = registration.quote || {};
    const s = q.sizing || {};
    const pct = (v, d = 2) => v == null ? 'n/a' : (Number(v) * 100).toFixed(d) + '%';
    const money = (v) => v == null ? 'n/a' : '$' + Math.round(Number(v)).toLocaleString('en-US');
    files.push({
      name: '01_Application_and_Terms/00_REGISTERED_PRODUCT.txt',
      data: Buffer.from([
        'YS CAPITAL GROUP - REGISTERED PRODUCT TERMS',
        `Product: ${[q.programLabel, q.productLabel].filter(Boolean).join(' - ') || registration.program}`,
        `Status: ${registration.status || 'n/a'}`,
        `Loan amount: ${money(s.totalLoan || registration.total_loan)}`,
        `Note rate: ${pct(q.noteRate || registration.note_rate)}`,
        `Initial advance: ${money(s.initialAdvance)}`,
        `Rehab holdback: ${money(s.rehabHoldback)}`,
        `Financed interest reserve: ${money(s.financedReserve)}`,
        `LTC: ${pct(s.ltcPct, 1)}`,
        `Initial/as-is LTV: ${pct(s.acqLtvPct, 1)}`,
        `Loan-to-ARV: ${pct(s.arvPct, 1)}`,
        `Closing costs due: ${money(q.closingCosts && q.closingCosts.dueAtClosing)}`,
        `Cash to close: ${money(q.cashToClose)}`,
        `Liquidity required: ${money(q.liquidityRequired || q.liquidity)}`,
        `Reserve basis: ${q.reserveBasis || 'n/a'}`,
        `Registered at: ${registration.created_at || 'n/a'}`,
      ].join('\n'), 'utf8'),
    });
  }
  files.push({ name: '00_MANIFEST.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

  // Human-readable index too.
  const lines = [
    `YS CAPITAL GROUP — CLEAN FILE / TPR PACKAGE`,
    `Loan: ${app.ys_loan_number || '(pending)'}   Borrower: ${manifest.borrower}   Property: ${propLabel}`,
    `Generated: ${manifest.generated_at}`, '',
    `INCLUDED (${manifestDocs.length}):`,
    ...manifestDocs.map(m => `  - ${m.file}${m.accepted_by ? `  (accepted by ${m.accepted_by})` : ''}`),
    '', `MISSING / NOT YET ACCEPTED (${missing.length}):`,
    ...(missing.length ? missing.map(m => `  - ${m}`) : ['  (none)']),
  ];
  files.push({ name: '00_INDEX.txt', data: Buffer.from(lines.join('\n'), 'utf8') });

  const filename = `TPR_${sanitize(app.ys_loan_number || app.last_name || 'file')}_${new Date().toISOString().slice(0, 10)}.zip`;
  return { zip: zip(files), filename, includedCount: manifestDocs.length, missing };
}

module.exports = { buildTprExport, folderFor };

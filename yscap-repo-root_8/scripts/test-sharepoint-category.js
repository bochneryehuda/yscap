'use strict';
/**
 * The "Synced by Pilot" SharePoint folder for a condition/loose document now uses
 * the SAME clean category name as the TPR export (owner-directed 2026-07-30) —
 * "Bank Statements", "Contract & Assignment", "Appraisal", … — instead of the long
 * per-condition label ("Assets & bank statements verified — met", "Assignment
 * letter (if the contract is assigned)", …). This pins categoryFor to the clean
 * names AND proves the structural special cases (LLC / REO / Term Sheet / Closing /
 * photo ID / TPR Exports / chat) are untouched. Pure — no DB.
 * Run: node scripts/test-sharepoint-category.js
 */
const backup = require('../src/lib/sharepoint-backup');
const tpr = require('../src/lib/tpr-export');
const cat = backup.categoryFor;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

// ---- ordinary CONDITION documents map to the clean TPR category, NOT the label.
ok(cat({ template_code: 'rtl_p3_assets', item_label: 'Assets & bank statements verified — met' }) === 'Bank Statements',
  'bank-statements condition → "Bank Statements" (not the long label)');
ok(cat({ template_code: 'rtl_p5_assign', item_label: 'Assignment letter (if the contract is assigned)' }) === 'Contract & Assignment',
  'assignment condition → "Contract & Assignment"');
ok(cat({ template_code: 'rtl_p1_contract', item_label: 'Executed purchase contract' }) === 'Contract & Assignment',
  'executed purchase contract → "Contract & Assignment" (merges with assignment)');
ok(cat({ template_code: 'rtl_cond_credit', item_label: 'Credit report' }) === 'Credit Report',
  'credit condition → "Credit Report"');
ok(cat({ template_code: 'rtl_cond_appraisaldocs', item_label: 'Appraisal documents' }) === 'Appraisal',
  'appraisal condition → "Appraisal"');
ok(cat({ template_code: 'rtl_cond_insurance', item_label: 'Insurance (binder + invoice)' }) === 'Insurance',
  'insurance condition → "Insurance"');
ok(cat({ template_code: 'rtl_cond_title', item_label: 'Title documents' }) === 'TITLE',
  'title condition → "TITLE"');
ok(cat({ template_code: 'rtl_cond_fraud', slot_label: 'background', item_label: 'Fraud background report' }) === 'Background Check',
  'fraud/background condition → "Background Check"');
ok(cat({ template_code: 'rtl_cond_fraud', slot_label: 'criminal', item_label: 'Fraud criminal report' }) === 'Criminal Check',
  'fraud/criminal condition → "Criminal Check"');
ok(cat({ template_code: 'rtl_p1_budget', item_label: 'Construction rehab budget received' }) === 'Scope of Work',
  'rehab-budget condition → "Scope of Work"');
ok(cat({ template_code: 'rtl_p1_id', item_label: 'Borrower photo ID (government-issued)' }) === 'ID',
  'ID condition → "ID"');
// a condition with NO known code + no keyword → Other Documents (the TPR default),
// never the raw label.
ok(cat({ item_label: 'Some mystery internal condition XYZ' }) === 'Other Documents',
  'unknown condition → "Other Documents" (never the raw label)');
// the exact tpr categorizer is the source of truth — no drift.
ok(cat({ template_code: 'rtl_p3_assets' }) === tpr.categoryFor({ template_code: 'rtl_p3_assets' }),
  'categoryFor mirrors tpr-export.categoryFor exactly (one source of truth)');

// ---- STRUCTURAL special cases are preserved.
ok(cat({ doc_kind: 'photo_id' }) === 'Photo ID', 'photo_id → "Photo ID" (profile level, preserved)');
ok(cat({ doc_kind: 'term_sheet' }) === 'Term Sheet/Unsigned', 'term sheet → "Term Sheet/Unsigned"');
ok(cat({ doc_kind: 'term_sheet_signed' }) === 'Term Sheet/Signed', 'signed term sheet → "Term Sheet/Signed"');
ok(cat({ doc_kind: 'tpr_export' }) === 'TPR Exports', 'tpr export → "TPR Exports"');
ok(cat({ doc_kind: 'draw_inspection_report' }) === 'Draw Reports', 'draw report → "Draw Reports"');
ok(cat({ doc_kind: 'closing_correspondence' }) === 'Closing/Correspondence', 'closing correspondence → "Closing/Correspondence"');
ok(cat({ doc_kind: 'closing_pkg_signed' }) === 'Closing', 'signed closing package → "Closing"');
ok(cat({ doc_kind: 'track_record_html' }) === 'REO/Track Record Saved Copy', 'track-record HTML → "REO/Track Record Saved Copy"');
ok(cat({ track_record_id: 'abc1234567', tr_address: '9 Prior Rd, Testville, NJ' }) === 'REO/9 Prior Rd, Testville, NJ',
  'track-record doc → "REO/<property>"');
ok(cat({ llc_resolved_id: 'x', llc_name: 'TPR Vesting LLC', template_code: 'rtl_llc_ein' }) === 'TPR Vesting LLC/EIN Letter',
  'LLC doc → "<LLC name>/EIN Letter"');
ok(cat({ source_type: 'chat_attachment' }) === 'Chat Attachments', 'chat attachment → "Chat Attachments"');

// ---- VERSION STREAM: one checklist item that now maps to TWO folders (fraud →
// Background Check / Criminal Check) MUST get two independent version streams,
// or interleaved supersedes would mis-file into Version-N. An ordinary condition
// (one folder) keeps ONE stable stream.
const sk = backup.stateKeyFor;
ok(sk({ checklist_item_id: 'ci1', template_code: 'rtl_cond_fraud', slot_label: 'background' }, 'app:x')
   !== sk({ checklist_item_id: 'ci1', template_code: 'rtl_cond_fraud', slot_label: 'criminal' }, 'app:x'),
  'fraud background vs criminal (same checklist item) → DIFFERENT version streams');
ok(sk({ checklist_item_id: 'ci2', template_code: 'rtl_p3_assets' }, 'app:x')
   === sk({ checklist_item_id: 'ci2', template_code: 'rtl_p3_assets', filename: 'statement-2.pdf' }, 'app:x'),
  'same bank-statement condition (one folder) → ONE stable version stream');
ok(sk({ checklist_item_id: 'ci1', template_code: 'rtl_cond_fraud', slot_label: 'background' }, 'app:x')
   === 'item:ci1:background-check',
  'fraud/background stream key is item id + clean category slug');

// ---- FLOOD CERTIFICATE: the Xactus flood determination PDF must reach the SAME
// "Flood Cert" folder in the mirror that it gets in the TPR package, and must not
// be mistaken for a system-regenerable artifact. The commit that added flood
// ordering claimed both were "verified" with nothing pinning it (pre-merge audit,
// 2026-08-02) — this is that pin.
{
  const floodDoc = { doc_kind: 'flood_determination', template_code: 'rtl_cond_flood',
    slot_label: 'Flood determination', filename: 'Flood determination 2322271.pdf', item_label: 'Flood certificate' };
  ok(cat(floodDoc) === 'Flood Cert', 'flood determination PDF → "Flood Cert" (mirror)');
  ok(require('../src/lib/tpr-export').categoryFor(floodDoc) === 'Flood Cert',
    'flood determination PDF → "Flood Cert" (TPR export) — the same folder, one categorizer');
  // 'flood_determination' must NOT read as a regen artifact: those get the long
  // settle window and can be settled WITHOUT ever uploading.
  ok(backup.isRegenKind('flood_determination') === false, 'flood determination is not a regen kind');
  // Even with no condition attached, the filename keeps it out of "Other Documents".
  ok(cat({ doc_kind: 'flood_determination', filename: 'Flood determination 2322271.pdf' }) === 'Flood Cert',
    'flood cert with no condition still files under "Flood Cert"');
}

console.log(`\nsharepoint-category: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

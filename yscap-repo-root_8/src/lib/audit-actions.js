'use strict';

/**
 * Human-readable descriptions for every audit_log action code, for the
 * system-wide audit log (GET /api/staff/audit-log). The per-file/per-borrower
 * feed uses src/lib/activity.js (AUDIT_RENDER) with richer, context-aware copy;
 * this map is the flat, whole-company view: one short label + a category per
 * action so the log can be grouped and filtered by kind of activity.
 *
 * Unknown / future actions fall back to describeAction() which humanizes the
 * code (`some_new_action` → "Some new action"), so the log never shows a raw
 * snake_case token and never needs a code change to render a new action.
 */

// category → used for the colored pill + the category filter facet.
const ACTIONS = {
  // ---- Access to PII (GLBA sensitive) -------------------------------------
  view_ssn: { label: 'Viewed a Social Security number', cat: 'pii' },
  view_appraisal_card: { label: 'Revealed an appraisal payment card', cat: 'pii' },
  download_document: { label: 'Downloaded a document', cat: 'pii' },
  pii_redacted: { label: 'Redacted PII from a message', cat: 'pii' },

  // ---- Authentication -----------------------------------------------------
  borrower_set_password: { label: 'Borrower set a password', cat: 'auth' },
  borrower_reset_password_email: { label: 'Sent a borrower password-reset email', cat: 'auth' },
  invite_borrower: { label: 'Invited a borrower to the portal', cat: 'auth' },
  update_profile: { label: 'Updated a profile', cat: 'auth' },

  // ---- Files (applications) ----------------------------------------------
  create_application: { label: 'Created a loan file', cat: 'file' },
  submit_application: { label: 'Submitted a loan application', cat: 'file' },
  edit_application: { label: 'Edited a loan file', cat: 'file' },
  complete_fields: { label: 'Completed application fields', cat: 'file' },
  assign_application: { label: 'Assigned the loan officer', cat: 'file' },
  assign_processor: { label: 'Assigned the processor', cat: 'file' },
  set_closing_date: { label: 'Set the closing date', cat: 'file' },
  post_closing_update: { label: 'Posted a post-closing update', cat: 'file' },
  status_change: { label: 'Changed the file status', cat: 'file' },
  internal_status_change: { label: 'Changed the internal status', cat: 'file' },
  archive_application: { label: 'Archived a file', cat: 'file' },
  delete_application: { label: 'Archived a file', cat: 'file' },
  restore_application: { label: 'Restored a file', cat: 'file' },
  purge_application: { label: 'Permanently deleted a file', cat: 'file' },
  set_co_borrower: { label: 'Added a co-borrower', cat: 'file' },
  unlink_co_borrower: { label: 'Removed a co-borrower', cat: 'file' },
  request_draw: { label: 'Requested a construction draw', cat: 'file' },

  // ---- Product & pricing --------------------------------------------------
  register_product: { label: 'Registered / repriced a product', cat: 'pricing' },
  save_appraisal_card: { label: 'Saved the appraisal payment card', cat: 'pricing' },
  save_rehab_budget: { label: 'Saved the rehab budget / scope of work', cat: 'pricing' },
  link_bank: { label: 'Linked a bank statement', cat: 'pricing' },

  // ---- Documents ----------------------------------------------------------
  upload_document: { label: 'Uploaded a document', cat: 'document' },
  upload_photo_id: { label: 'Uploaded a photo ID', cat: 'document' },
  export_tpr: { label: 'Exported the clean file (DPR)', cat: 'document' },
  store_tool_exports: { label: 'Stored tool exports', cat: 'document' },
  staff_tool_submit: { label: 'Saved a tool result', cat: 'document' },

  // ---- Conditions / checklist --------------------------------------------
  add_checklist_item: { label: 'Requested a document', cat: 'condition' },
  add_condition: { label: 'Added a condition', cat: 'condition' },
  add_condition_custom: { label: 'Added a custom condition', cat: 'condition' },
  add_loan_condition: { label: 'Added a loan condition', cat: 'condition' },
  attach_condition: { label: 'Attached a library condition', cat: 'condition' },
  clear_condition: { label: 'Signed off a condition', cat: 'condition' },
  waive_condition: { label: 'Waived a condition', cat: 'condition' },
  push_back_condition: { label: 'Pushed a condition back', cat: 'condition' },
  submit_info_condition: { label: 'Answered an information condition', cat: 'condition' },
  conditions_run_all: { label: 'Re-ran the condition rules', cat: 'condition' },
  nudge_borrower: { label: 'Nudged the borrower on open items', cat: 'condition' },

  // ---- LLC / vesting entity ----------------------------------------------
  create_llc: { label: 'Created a vesting entity', cat: 'llc' },
  update_llc: { label: 'Updated a vesting entity', cat: 'llc' },
  update_llc_members: { label: 'Updated entity members', cat: 'llc' },
  link_llc: { label: 'Linked the vesting entity', cat: 'llc' },
  set_vesting_llc_owners: { label: 'Set the vesting-entity owners', cat: 'llc' },
  verify_llc: { label: 'Verified the vesting entity', cat: 'llc' },
  unverify_llc: { label: 'Un-verified the vesting entity', cat: 'llc' },
  raise_llc_issue: { label: 'Raised an entity issue', cat: 'llc' },

  // ---- Track record -------------------------------------------------------
  staff_add_track_record: { label: 'Added a track-record project', cat: 'track_record' },
  staff_edit_track_record: { label: 'Edited a track-record project', cat: 'track_record' },
  staff_delete_track_record: { label: 'Deleted a track-record project', cat: 'track_record' },
  upload_track_record_doc: { label: 'Uploaded a track-record document', cat: 'track_record' },
  staff_upload_track_record_doc: { label: 'Uploaded a track-record document', cat: 'track_record' },
  verify_track_record: { label: 'Verified a track-record project', cat: 'track_record' },
  unverify_track_record: { label: 'Revoked a track-record verification', cat: 'track_record' },
  raise_track_record_issue: { label: 'Raised a track-record issue', cat: 'track_record' },

  // ---- Borrower CRM -------------------------------------------------------
  update_borrower: { label: 'Updated borrower details', cat: 'borrower' },
  add_borrower_note: { label: 'Added a borrower note', cat: 'borrower' },
  delete_borrower_note: { label: 'Deleted a borrower note', cat: 'borrower' },
  create_reminder: { label: 'Created a reminder / task', cat: 'borrower' },
  update_reminder: { label: 'Updated a reminder / task', cat: 'borrower' },
  delete_reminder: { label: 'Deleted a reminder / task', cat: 'borrower' },

  // ---- Vendors / contacts -------------------------------------------------
  add_vendor: { label: 'Added a vendor', cat: 'vendor' },
  edit_vendor: { label: 'Edited a vendor', cat: 'vendor' },
  delete_vendor: { label: 'Deleted a vendor', cat: 'vendor' },
  save_contact: { label: 'Saved a contact', cat: 'vendor' },
  add_file_contact: { label: 'Added a file contact', cat: 'vendor' },
  remove_file_contact: { label: 'Removed a file contact', cat: 'vendor' },

  // ---- Messaging ----------------------------------------------------------
  post_message: { label: 'Sent a message', cat: 'message' },
  delete_message: { label: 'Deleted a message', cat: 'message' },
  create_conversation: { label: 'Started a conversation', cat: 'message' },
  update_conversation: { label: 'Updated a conversation', cat: 'message' },
  add_conversation_member: { label: 'Added a conversation member', cat: 'message' },
  remove_conversation_member: { label: 'Removed a conversation member', cat: 'message' },
  export_chat: { label: 'Exported a conversation', cat: 'message' },

  // ---- Platform setup (condition center, custom fields, integrations) -----
  condition_def_created: { label: 'Created a condition definition', cat: 'setup' },
  condition_def_updated: { label: 'Updated a condition definition', cat: 'setup' },
  condition_def_deactivated: { label: 'Deactivated a condition definition', cat: 'setup' },
  condition_def_deleted: { label: 'Deleted a condition definition', cat: 'setup' },
  custom_field_created: { label: 'Created a custom field', cat: 'setup' },
  custom_field_updated: { label: 'Updated a custom field', cat: 'setup' },
  custom_field_deactivated: { label: 'Deactivated a custom field', cat: 'setup' },
  custom_field_deleted: { label: 'Deleted a custom field', cat: 'setup' },

  // ---- ClickUp / system sync ---------------------------------------------
  clickup_manual_review_resolve: { label: 'Resolved a ClickUp manual review', cat: 'sync' },
  clickup_reconcile_programs: { label: 'Reconciled ClickUp programs', cat: 'sync' },
  clickup_descope_flip: { label: 'ClickUp de-scoped a file', cat: 'sync' },
  conditions_auto_evaluated: { label: 'Condition rules ran automatically', cat: 'sync' },
};

const CATEGORIES = [
  { key: 'pii', label: 'PII access' },
  { key: 'auth', label: 'Authentication' },
  { key: 'file', label: 'Loan files' },
  { key: 'pricing', label: 'Pricing' },
  { key: 'document', label: 'Documents' },
  { key: 'condition', label: 'Conditions' },
  { key: 'llc', label: 'Vesting entities' },
  { key: 'track_record', label: 'Track record' },
  { key: 'borrower', label: 'Borrower CRM' },
  { key: 'vendor', label: 'Vendors' },
  { key: 'message', label: 'Messaging' },
  { key: 'setup', label: 'Platform setup' },
  { key: 'sync', label: 'ClickUp / system' },
  { key: 'other', label: 'Other' },
];

function titleize(code) {
  const s = String(code || '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Activity';
}

/** { label, cat } for an action code, with a humanized fallback for unknowns. */
function describeAction(code) {
  const hit = ACTIONS[code];
  if (hit) return hit;
  return { label: titleize(code), cat: 'other' };
}

// Every known action code, and the codes grouped by category — so the audit-log
// route can filter by category server-side (correct pagination) instead of
// post-filtering a fetched page. 'other' has no fixed list: it is any code NOT
// in ACTIONS, expressed as "action <> ALL(KNOWN_CODES)".
const KNOWN_CODES = Object.keys(ACTIONS);
const CATEGORY_CODES = {};
for (const [code, meta] of Object.entries(ACTIONS)) {
  (CATEGORY_CODES[meta.cat] = CATEGORY_CODES[meta.cat] || []).push(code);
}

/** Action codes whose human label OR raw code matches a free-text query. */
function codesMatchingText(q) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return [];
  return KNOWN_CODES.filter((c) => c.includes(s) || ACTIONS[c].label.toLowerCase().includes(s));
}

module.exports = { ACTIONS, CATEGORIES, describeAction, KNOWN_CODES, CATEGORY_CODES, codesMatchingText };

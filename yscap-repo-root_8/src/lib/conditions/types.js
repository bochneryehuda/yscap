'use strict';

/**
 * Condition Center type vocabulary — how a user-facing "condition type" maps
 * onto the storage model (checklist item_kind + tool_key), shared by the admin
 * studio and the per-file staff endpoints.
 */

const CONDITION_TYPES = {
  document:           { itemKind: 'document', toolKey: null, label: 'Document upload' },
  info_field:         { itemKind: 'task', toolKey: 'info_field', label: 'Information field' },
  tool:               { itemKind: 'task', toolKey: undefined, label: 'Form / tool' }, // toolKey chosen from TOOLS
  esign:              { itemKind: 'task', toolKey: 'esign', label: 'E-signature' },
  internal_task:      { itemKind: 'task', toolKey: null, label: 'Internal task' },
  internal_condition: { itemKind: 'condition', toolKey: null, label: 'Internal checkpoint' },
};

const TOOLS = [
  { v: 'rehab_budget', label: 'Rehab budget / Scope of work' },
  { v: 'track_record', label: 'Track record / experience' },
  { v: 'title_contact', label: 'Title contact form' },
  { v: 'insurance_contact', label: 'Insurance contact form' },
  { v: 'product_pricing', label: 'Products & pricing (Term Sheet Studio)' },
  { v: 'appraisal_card', label: 'Appraisal payment card' },
];

const CATEGORIES = [
  { v: 'prior_to_approval', label: 'Prior to approval' },
  { v: 'prior_to_docs', label: 'Prior to docs' },
  { v: 'prior_to_closing', label: 'Prior to closing' },
  { v: 'prior_to_funding', label: 'Prior to funding' },
  { v: 'at_closing', label: 'At closing' },
  { v: 'post_closing', label: 'Post closing' },
];

/** Derive the user-facing condition type from a template/item row. */
function conditionTypeOf(row) {
  if (row.tool_key === 'info_field') return 'info_field';
  if (row.tool_key === 'esign') return 'esign';
  if (row.tool_key) return 'tool';
  if (row.item_kind === 'document') return 'document';
  if (row.item_kind === 'condition') return 'internal_condition';
  return 'internal_task';
}

module.exports = { CONDITION_TYPES, TOOLS, CATEGORIES, conditionTypeOf };

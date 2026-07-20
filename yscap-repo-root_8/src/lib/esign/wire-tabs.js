/**
 * esign/wire-tabs.js — the SINGLE source of truth for the borrower-fillable WIRE
 * INSTRUCTION fields on the Draw Request form. Three consumers stay in lock-step
 * from this one list:
 *   1. draw-request-pdf.js draws a labeled line + the invisible `anchor` for each
 *      field (where DocuSign drops the fillable text box).
 *   2. orchestrate.tabsFor turns each into a DocuSign textTab (keyed by `tabLabel`).
 *   3. draw-wire.js reads the typed value back by `tabLabel` on completion.
 *
 * `tabLabel` MUST be unique per envelope and stable (it is the read-back key). We
 * use the field `key` as the tabLabel. Pure data — no requires, so anyone can
 * import it without a cycle.
 */

// Ordered so the PDF renders them top-to-bottom in the wire block.
const WIRE_FIELDS = [
  { key: 'account_name',    label: 'Account Name (beneficiary)',  anchor: '/dr_wire_acctname/', required: true,  sensitive: false },
  { key: 'bank_name',       label: 'Bank Name',                   anchor: '/dr_wire_bankname/', required: true,  sensitive: false },
  { key: 'account_number',  label: 'Account Number',              anchor: '/dr_wire_acctnum/',  required: true,  sensitive: true  },
  { key: 'routing_number',  label: 'Routing / ABA Number',        anchor: '/dr_wire_routing/',  required: true,  sensitive: false },
  { key: 'bank_address',    label: 'Bank Address',                anchor: '/dr_wire_bankaddr/', required: false, sensitive: false },
  { key: 'account_address', label: 'Account Holder Address',      anchor: '/dr_wire_acctaddr/', required: false, sensitive: false },
];

const WIRE_KEYS = WIRE_FIELDS.map((f) => f.key);

/** The DocuSign textTab specs for orchestrate.tabsFor: [{ anchor, tabLabel, required, width }]. */
function wireTextTabs() {
  return WIRE_FIELDS.map((f) => ({ anchor: f.anchor, tabLabel: f.key, required: f.required, width: 260, height: 15 }));
}

module.exports = { WIRE_FIELDS, WIRE_KEYS, wireTextTabs };

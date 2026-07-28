'use strict';

/**
 * Pure tests for the closing workflow decision logic (no DB, no network).
 *   - date-string equality helpers
 *   - the actual cash-to-close money gate (verified >= actual CTC + reserves)
 *   - the 3-system funded-date reconciliation gate
 *   - the closer role / manage_closings capability + closing stage machine
 * Runs in `npm test`.
 */

const assert = require('assert');
const closing = require('../src/lib/closing');
const perms = require('../src/lib/permissions');
const workflow = require('../src/lib/workflow');

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.strictEqual(a, b, m); };

// ── date helpers ────────────────────────────────────────────────────────────
eq(closing.dayStr('2026-07-10'), '2026-07-10', 'dayStr passes a plain date');
eq(closing.dayStr('2026-07-10T00:00:00.000Z'), '2026-07-10', 'dayStr trims a timestamp');
eq(closing.dayStr(null), null, 'dayStr null → null');
eq(closing.dayStr('garbage'), null, 'dayStr non-date → null');
ok(closing.sameDay('2026-07-10', '2026-07-10 00:00:00'), 'sameDay across formats');
ok(!closing.sameDay('2026-07-10', '2026-07-11'), 'sameDay different days');
ok(!closing.sameDay(null, '2026-07-11'), 'sameDay null is never equal');

// ── credit-report quick link: the readable report, never the XML data file ──
ok(closing.isCreditReportDoc({ doc_kind: 'credit_pdf' }), 'the imported credit PDF is a quick-link');
ok(!closing.isCreditReportDoc({ doc_kind: 'credit_xml' }), 'the machine-readable XML is NOT a quick-link');
// The importer files with checklist_item_id NULL when the file has no credit
// condition — doc_kind alone must still identify the report.
ok(closing.isCreditReportDoc({ doc_kind: 'credit_pdf', template_code: null }), 'a credit PDF with no condition still surfaces');
ok(!closing.isCreditReportDoc({ doc_kind: 'credit_xml', template_code: 'rtl_cond_credit' }), 'the XML is excluded even on the credit condition');
ok(closing.isCreditReportDoc({ doc_kind: null, template_code: 'rtl_cond_credit' }), 'a report dropped straight onto the credit condition surfaces');
ok(!closing.isCreditReportDoc({ doc_kind: null, template_code: 'rtl_p3_assets' }), 'a bank statement is not a credit report');
ok(!closing.isCreditReportDoc({ doc_kind: 'term_sheet_signed' }), 'a term sheet is not a credit report');
ok(!closing.isCreditReportDoc(null), 'a missing row is never a credit report');

// ── money gate: verified >= actual CTC + reserves ───────────────────────────
// Covered: exactly enough (with $1 tolerance).
let d = closing.decideCashToClose({ verified: 120000, reserve: 20000, actualCashToClose: 100000, haveCountable: true });
ok(d.ok, 'covered when verified == actual + reserve');
eq(d.required, 120000, 'required = actual + reserve');
eq(d.shortfall, 0, 'no shortfall when covered');

// Short — the FATAL case.
d = closing.decideCashToClose({ verified: 90000, reserve: 20000, actualCashToClose: 100000, haveCountable: true });
ok(!d.ok, 'short when verified < actual + reserve');
eq(d.shortfall, 30000, 'shortfall = required - verified');

// $1 tolerance — a penny short still passes.
d = closing.decideCashToClose({ verified: 119999.5, reserve: 20000, actualCashToClose: 100000, haveCountable: true });
ok(d.ok, '$1 tolerance passes a sub-dollar gap');

// No actual figure yet → not ok (never a false pass).
d = closing.decideCashToClose({ verified: 999999, reserve: 0, actualCashToClose: null, haveCountable: true });
ok(!d.ok, 'no actual cash-to-close → not ok');

// Data gap: money looks like enough but no countable tied account → not ok.
d = closing.decideCashToClose({ verified: 200000, reserve: 0, actualCashToClose: 100000, haveCountable: false });
ok(!d.ok, 'no countable tied account → not ok (data-gap guard)');

// ── reconciliation gate: 3-system funded-date match ─────────────────────────
// All three present and equal → ok.
let r = closing.decideReconcile({ ours: '2026-07-10', clickup: '2026-07-10', encompass: '2026-07-10', encLinked: true });
ok(r.ok, 'reconciles when all three match');
eq(r.encStatus, 'match', 'encompass match');

// ClickUp date missing → blocked.
r = closing.decideReconcile({ ours: '2026-07-10', clickup: null, encompass: '2026-07-10', encLinked: true });
ok(!r.ok, 'blocked when ClickUp date missing');
ok(/ClickUp/.test(r.reason), 'reason names ClickUp');

// PILOT vs ClickUp mismatch → blocked.
r = closing.decideReconcile({ ours: '2026-07-10', clickup: '2026-07-11', encompass: '2026-07-10', encLinked: true });
ok(!r.ok, 'blocked on PILOT vs ClickUp mismatch');

// Encompass leg: linked but empty → ADVISORY, not blocking (field 1401 is
// tenant-dependent; its absence must never permanently stall reconciliation).
r = closing.decideReconcile({ ours: '2026-07-10', clickup: '2026-07-10', encompass: null, encLinked: true });
ok(r.ok && r.encStatus === 'missing', 'linked-but-empty Encompass is advisory, not blocking');
ok(r.advisory && /Encompass/.test(r.advisory), 'linked-but-empty Encompass surfaces an advisory');

// Encompass leg: NOT linked → graceful N/A, PILOT+ClickUp enough.
r = closing.decideReconcile({ ours: '2026-07-10', clickup: '2026-07-10', encompass: null, encLinked: false });
ok(r.ok && r.encStatus === 'na', 'un-linked Encompass is N/A, not blocking');

// Encompass present but disagrees → blocked.
r = closing.decideReconcile({ ours: '2026-07-10', clickup: '2026-07-10', encompass: '2026-07-09', encLinked: true });
ok(!r.ok && r.encStatus === 'mismatch', 'Encompass disagreement blocks');

// ── warehouses ──────────────────────────────────────────────────────────────
for (const w of ['Stride Bank', 'Bank of the Sierra', 'Banc of California', 'Northpointe', 'Fidelis', 'CorrFirst', 'Table Funding'])
  ok(closing.WAREHOUSES.includes(w), `warehouse present: ${w}`);
eq(closing.WAREHOUSES.length, 7, 'exactly the 7 owner-named warehouses');
// TABLE FUNDING is a warehouse line that carries meaning downstream: a loan
// funded on it was sold at closing, so it never enters the purchasing workflow.
// It must BE in the list (the closer picks it like any other line) and the
// constant must match the string exactly, or the fork silently never fires.
eq(closing.TABLE_FUNDING, 'Table Funding', 'the table-funding warehouse is named exactly');
ok(closing.WAREHOUSES.includes(closing.TABLE_FUNDING), 'and it is a pickable warehouse line');

// ── role + capability ───────────────────────────────────────────────────────
ok(perms.CAPABILITIES.some((c) => c.key === 'manage_closings'), 'manage_closings capability exists');
ok(perms.effectivePermissions('closer', null).has('manage_closings'), 'closer holds manage_closings');
ok(perms.effectivePermissions('admin', null).has('manage_closings'), 'admin holds manage_closings');
ok(perms.effectivePermissions('super_admin', null).has('manage_closings'), 'super_admin holds manage_closings');
ok(!perms.effectivePermissions('loan_officer', null).has('manage_closings'), 'loan_officer does NOT hold manage_closings');

// ── closing stage machine ───────────────────────────────────────────────────
ok(workflow.CLOSING_STAGES.includes('in_purchasing'), 'in_purchasing stage added');
eq(workflow.CLOSING_STAGES[workflow.CLOSING_STAGES.length - 1], 'in_purchasing', 'in_purchasing is last (post-reconcile)');

console.log(`test-closing-pure: ${n} assertions passed`);

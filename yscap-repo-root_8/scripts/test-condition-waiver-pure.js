/**
 * PURE test — the "request a waiver of a condition" exception type
 * (owner-directed 2026-08-04).
 *
 *   node scripts/test-condition-waiver-pure.js
 *
 * "Any user should be able to request from the admin or super admin an exception to
 *  waive any condition. And after the exception is being approved, that condition
 *  should be marked as waived."
 *
 * This pins the type registry + reason codes + the exports (the pure contract) and
 * SOURCE-asserts the request/decide wiring (the migration widening, the request
 * route, and the decide handler that actually marks the condition waived), so a
 * regression that drops any half of the round-trip is caught without a database.
 */
const assert = require('assert');
const fs = require('fs');
const R = require('path').resolve(__dirname, '..');
const LE = require(R + '/src/lib/loan-exceptions');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ---- the type registry -----------------------------------------------------
ok(LE.isExceptionType('condition_waiver'), 'condition_waiver is a registered exception type');
const cfg = LE.typeConfig('condition_waiver');
ok(cfg && cfg.label === 'Condition waiver', 'it has a human label');
ok(cfg.subject === 'file', 'it is file-scoped (it names a target condition, not a subject borrower)');
ok(cfg.recordOnly === false, 'it is a REAL request → decision, not a record-only born-approved type');
ok(cfg.expirable === false, 'it is NOT expirable — a waived condition is a one-time human decision, never clock-driven');
ok(typeof cfg.slaHours === 'number' && cfg.slaHours > 0, 'it carries a review SLA');

// ---- reason codes ----------------------------------------------------------
ok(LE.CONDITION_WAIVER_REASONS && typeof LE.CONDITION_WAIVER_REASONS === 'object',
  'CONDITION_WAIVER_REASONS is exported');
ok(Object.prototype.hasOwnProperty.call(LE.CONDITION_WAIVER_REASONS, 'other'),
  'the reasons include a catch-all "other"');
ok(LE.reasonCodesFor('condition_waiver') === LE.CONDITION_WAIVER_REASONS,
  'the registry points the type at its own reason codes');
// An unknown reason code falls back to "other" at insert (isReasonCodeFor is the gate).
ok(LE.isReasonCodeFor('condition_waiver', 'not_applicable') === true, 'a real reason code is accepted');
ok(LE.isReasonCodeFor('condition_waiver', 'made_up_nonsense') === false, 'a bogus reason code is rejected (→ falls back to other)');

// ---- exports (the request path) --------------------------------------------
ok(typeof LE.requestConditionWaiver === 'function', 'requestConditionWaiver is exported');

// ---- SOURCE: the migration widens the CHECK + adds the target column -------
{
  const sql = fs.readFileSync(R + '/db/468_condition_waiver_exception.sql', 'utf8');
  ok(/target_checklist_item_id uuid/.test(sql) && /REFERENCES checklist_items\(id\) ON DELETE SET NULL/.test(sql),
    'db/468 adds target_checklist_item_id → checklist_items, ON DELETE SET NULL (a deleted condition never drops the audit row)');
  ok(/'condition_waiver'/.test(sql) && /loan_exceptions_exception_type_check/.test(sql),
    'db/468 widens the exception_type CHECK to include condition_waiver');
  ok(/uq_loan_exc_open_condition_waiver/.test(sql) && /exception_type <> 'condition_waiver'/.test(sql),
    'a file may carry SEVERAL open condition waivers (one per condition) — excluded from the one-per-type rule, with its own one-per-condition rule');
}

// ---- SOURCE: requestException stores the target + supersedes per-condition --
{
  const src = fs.readFileSync(R + '/src/lib/loan-exceptions.js', 'utf8');
  ok(/target_checklist_item_id\)/.test(src),
    'requestException INSERT carries target_checklist_item_id');
  ok(/type === 'condition_waiver' && opts\.targetChecklistItemId/.test(src),
    'a second condition’s waiver request supersedes only the SAME condition’s prior request, not the whole file');
}

// ---- SOURCE: the request route (any staff, file-scoped) --------------------
{
  const src = fs.readFileSync(R + '/src/routes/staff.js', 'utf8');
  ok(/conditions\/:itemId\/request-waiver/.test(src),
    'the per-condition request route exists (POST .../conditions/:itemId/request-waiver)');
  ok(/requestConditionWaiver\(client, \{/.test(src),
    'the route files the request through requestConditionWaiver');
  ok(/That condition is already cleared/.test(src),
    'the route refuses to request a waiver of an already-cleared condition');
}

// ---- SOURCE: the decide handler marks the condition waived on APPROVE -------
{
  const src = fs.readFileSync(R + '/src/routes/admin-exceptions.js', 'utf8');
  ok(/isConditionWaiver = exc\.exception_type === 'condition_waiver'/.test(src),
    'the decide handler recognizes condition_waiver');
  ok(/isConditionWaiver && decision === 'approved' && exc\.target_checklist_item_id/.test(src),
    'APPROVE marks the target condition — and only on approve, only when it names one');
  ok(/status='satisfied', signed_off_by=\$2/.test(src) && /waived_by=\$2, waived_at=now\(\)/.test(src),
    'it writes the waived stamps (status satisfied + waived_by/at), the same shape a checklist waive writes');
  ok(/WHERE id=\$1 AND application_id=\$3/.test(src),
    'the waive is scoped to THIS exception’s file — a mis-pointed row can never reach another file’s condition');
  ok(/condition_waiver_decided/.test(src),
    'the decision notifies the file team (never falling through to the esign-worded branch)');
  ok(/e\.code === '23514'/.test(src),
    'a DB guard refusing the waive is a legible 422, not an opaque 500');
}

// ---- SOURCE: the SOW budget guard steps aside for a deliberate waive/override
{
  const sql = fs.readFileSync(R + '/db/469_sow_guard_waive_override_aware.sql', 'utf8');
  ok(/NEW\.waived_by IS NOT NULL OR NEW\.override_by IS NOT NULL/.test(sql),
    'db/469: a waive/override stamp lets the write past the SOW budget guard (so "waive any condition" works on the budget condition too)');
  ok(/an ordinary sign-off has NEITHER/i.test(sql),
    'db/469: an ordinary SIGN-OFF still has NEITHER stamp, so the balance check still fully applies to it');
  // The bypass must sit AFTER the is_budget gate and BEFORE the balance RAISEs.
  const bypassIdx = sql.indexOf('NEW.waived_by IS NOT NULL OR NEW.override_by IS NOT NULL');
  const raiseIdx = sql.indexOf('must match to the cent');
  ok(bypassIdx > 0 && raiseIdx > bypassIdx, 'db/469: the bypass precedes the to-the-cent balance checks');
}

console.log(`condition-waiver: ${pass} checks passed`);

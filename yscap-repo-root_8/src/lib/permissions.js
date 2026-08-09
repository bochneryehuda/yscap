'use strict';

/**
 * Staff roles + capability-based permissions.
 *
 * A staffer's effective permissions = their role's defaults, with per-user
 * overrides from staff_users.permissions jsonb ({ capability: true|false }).
 * super_admin implicitly has every capability. Gates check capabilities
 * (can(actor, cap)) rather than hard-coded role lists, so an admin can grant a
 * loan coordinator "see all files" or a software-setup persona "manage the
 * Condition Center" without a code change.
 */

// Ordered high → low for display; not a strict hierarchy (permissions are the
// real authority — super_admin is the only implicit all-powerful role).
const ROLES = [
  { key: 'super_admin', label: 'Super Admin' },
  { key: 'admin', label: 'Admin' },
  { key: 'underwriter', label: 'Underwriter' },
  { key: 'loan_officer', label: 'Loan Officer' },
  { key: 'loan_coordinator', label: 'Loan Coordinator' },
  { key: 'draw_coordinator', label: 'Draw Coordinator' },
  { key: 'processor', label: 'Loan Processor' },
  // The Closer persona (owner-directed 2026-07-21): runs the closing sub-workflow
  // (estimated date → ready for docs → wire sent → fully closed → reconciled).
  // A file reaches them through the Workflow's "Submit for Closing".
  { key: 'closer', label: 'Closer' },
  { key: 'software_setup', label: 'Software Setup' },
];
const ROLE_KEYS = ROLES.map((r) => r.key);
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));

const CAPABILITIES = [
  { key: 'see_all_files', label: 'See every loan file', hint: 'Otherwise only files they are assigned to as officer/processor/coordinator.' },
  // Two-tier condition workflow: a loan officer marks a condition REVIEWED (a
  // lighter "I looked at it" stamp), while a processor / underwriter is the one
  // who SIGNS OFF (completes) the condition. Separate capabilities so the two
  // actions are tied to the right people.
  { key: 'review_conditions', label: 'Mark conditions reviewed', hint: 'Loan officers stamp a condition "reviewed"; it does NOT complete/sign it off.' },
  { key: 'sign_off_conditions', label: 'Review & sign off conditions', hint: 'Processors / underwriters accept documents and complete (sign off) checklist items.' },
  // Pulling / importing a borrower credit report (Xactus). Separated from
  // sign_off_conditions so a LOAN OFFICER can pull credit at point of sale
  // WITHOUT gaining the processor's power to sign off conditions. The processor
  // still signs off the credit condition; the LO just imports + marks it done.
  { key: 'pull_credit', label: 'Pull / import credit reports', hint: 'Import (pull or upload) a borrower credit report. Loan officers have this; processors / underwriters / admins do too.' },
  // Switching a file's vesting to INDIVIDUAL (personal name) — which waives the
  // LLC/entity condition and populates the Non-Owner-Occupied certification.
  // Owner-directed 2026-08-04: loan officers get this too, not only processors/
  // admins. A dedicated capability so it does NOT grant the broader
  // sign_off_conditions power.
  { key: 'waive_vesting_llc', label: 'Switch vesting to individual (waive the entity)', hint: 'Mark a file as closing in the borrower\'s personal name — waives the vesting-entity condition and adds the Non-Owner-Occupied certification. Loan officers, processors, closers, underwriters and admins hold it.' },
  { key: 'manage_conditions', label: 'Manage the Condition Center', hint: 'Author the global condition library and rule engine.' },
  { key: 'manage_pricing', label: 'Manage company pricing', hint: 'Set company-wide markup, origination and fee defaults for all not-yet-registered files.' },
  { key: 'manage_draws', label: 'Manage construction draws', hint: 'Review draw requests, set approved amounts, approve/amend/reopen draws, and record releases (the Sitewire draw desk).' },
  { key: 'manage_closings', label: 'Manage closings', hint: 'Run the closing workspace: warehouse + collateral tracking, the actual cash-to-close check, HUD/ALTA, checklists, TPR / investor-delivery sign-off, and reconcile (the closer desk).' },
  // The Purchasing desk (owner-directed 2026-07-26): every file that moved to
  // purchasing after investor delivery (a table-funded loan is sold at closing and
  // never lands here). Admins + closers hold it today; an admin can grant it to a
  // dedicated post-closer per-person from the Team screen.
  { key: 'manage_purchasing', label: 'Manage purchasing', hint: 'Run the purchasing desk: files outstanding in purchasing after investor delivery, with per-file notes and tasks.' },
  { key: 'waive_conditions', label: 'Waive conditions', hint: 'Waive a condition with a reason instead of clearing it.' },
  { key: 'delete_files', label: 'Delete / restore files', hint: 'Soft-delete a loan file and restore it.' },
  { key: 'manage_vendors', label: 'Manage the vendor directory', hint: 'Title & insurance vendor list.' },
  // Capital-provider data tapes (owner-directed 2026-07-26). Only processors,
  // underwriters and admins may reach the tape-export tools by default; a loan
  // officer does NOT get it unless an admin grants it to that individual here on
  // the Team screen. (super_admin has every capability implicitly.)
  { key: 'export_data_tapes', label: 'Export capital-provider data tapes', hint: 'Download a loan\'s data tape for its capital provider (Fidelis / Blue Lake / EMCAP …). Off for loan officers unless granted per-person.' },
  { key: 'manage_team', label: 'Manage the team', hint: 'Add staff, set roles, set passwords.' },
  { key: 'platform_setup', label: 'Platform setup', hint: 'Integrations, email config, and other software setup.' },
  { key: 'view_audit_log', label: 'View the system audit log', hint: 'The company-wide trail of every action across every file and borrower.' },
];
const CAP_KEYS = CAPABILITIES.map((c) => c.key);

// Role defaults. super_admin is handled implicitly (all). admin gets everything
// too by default but is still a distinct, revocable role.
const ROLE_DEFAULTS = {
  super_admin: CAP_KEYS.slice(),
  admin: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'pull_credit', 'waive_vesting_llc', 'manage_conditions', 'manage_pricing', 'manage_draws', 'manage_closings', 'manage_purchasing', 'waive_conditions', 'delete_files', 'manage_vendors', 'export_data_tapes', 'manage_team', 'platform_setup', 'view_audit_log'],
  // Underwriters run per-file conditions + sign-off + waive; the GLOBAL studio
  // (manage_conditions) is admin/software-setup by default but an admin can
  // grant it to a specific underwriter from the Team screen. They also export
  // capital-provider data tapes (owner-directed 2026-07-26) and pull credit.
  underwriter: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'pull_credit', 'waive_vesting_llc', 'waive_conditions', 'export_data_tapes'],
  loan_coordinator: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'pull_credit', 'waive_vesting_llc'],
  // The Draw Coordinator persona (default holder Lisa Katz): runs the Sitewire draw
  // desk across all files. Admin-overridable per the coordinator rules.
  draw_coordinator: ['see_all_files', 'manage_draws', 'review_conditions'],
  // Processors sign off conditions, manage draws, export data tapes
  // (owner-directed 2026-07-26), and pull credit. They ALSO hold waive_conditions
  // (owner-directed 2026-07-26): a processor handling a finding must be able to finish
  // it — including clearing a clear-to-close-blocking dealbreaker with a recorded reason
  // — instead of being forced to escalate it to a super-admin. The decision is still
  // fully attributed (who/why/when on the finding + the audit log), and an admin can
  // revoke it for a specific person from the Team screen.
  processor: ['review_conditions', 'sign_off_conditions', 'pull_credit', 'manage_draws', 'export_data_tapes', 'waive_conditions', 'waive_vesting_llc'],
  // Loan officers can REVIEW conditions (the lighter stamp) but NOT sign them off.
  // They CAN pull_credit (owner-directed 2026-07-23): the LO pulls credit at point of
  // sale, then marks the credit condition Done (the reviewed stamp) — the processor
  // still signs it off. This does NOT grant sign_off_conditions.
  // They do NOT manage draws by default (owner-directed 2026-07-20): pushing a file to Sitewire, deleting/
  // re-pushing it, approving draws and recording releases require the manage_draws capability, which is held
  // by the Draw Coordinator / Processor / Admin / Super Admin — never a loan officer unless an admin
  // explicitly grants it per-person from the Team screen. (super_admin has every capability implicitly.)
  loan_officer: ['review_conditions', 'pull_credit', 'waive_vesting_llc'],
  // Closers see the whole pipeline (they need the closing queue across files) and
  // can review + sign off closing conditions on the files handed to them, plus run
  // the closing desk (manage_closings) and pull credit. An admin can widen/narrow
  // per-person from the Team screen.
  closer: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'pull_credit', 'manage_closings', 'manage_purchasing', 'waive_vesting_llc'],
  software_setup: ['manage_conditions', 'platform_setup'],
};

function defaultsFor(role) {
  return new Set(ROLE_DEFAULTS[role] || []);
}

/**
 * Resolve a staffer's effective capability set.
 * @param {string} role
 * @param {object|null} overrides  staff_users.permissions jsonb ({cap: bool})
 * @returns {Set<string>}
 */
function effectivePermissions(role, overrides) {
  if (role === 'super_admin') return new Set(CAP_KEYS);
  const set = defaultsFor(role);
  if (overrides && typeof overrides === 'object') {
    for (const cap of CAP_KEYS) {
      if (cap in overrides) {
        if (overrides[cap]) set.add(cap); else set.delete(cap);
      }
    }
  }
  return set;
}

/** Does this actor (req.actor, carrying .perms Set + .role) have the capability? */
function can(actor, cap) {
  if (!actor || actor.kind !== 'staff') return false;
  if (actor.role === 'super_admin') return true;
  if (actor.perms instanceof Set) return actor.perms.has(cap);
  // Fallback if perms weren't resolved onto the actor.
  return defaultsFor(actor.role).has(cap);
}

/** Normalize a permissions payload from the client to a clean {cap:bool} object (only known caps). */
function sanitizeOverrides(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const cap of CAP_KEYS) if (cap in input) out[cap] = !!input[cap];
  return Object.keys(out).length ? out : null;
}

// #64: a file's ACTIVE assignees are the primary LO/processor PLUS any
// full-access ASSISTANTS in application_assignees. This reusable SQL fragment
// lets every access gate (staff.js scoping helper, chat modules) recognize an
// assistant from ONE definition — `${alias}.id` must be selectable, and `p` is
// the acting staff-id param placeholder (e.g. '$1').
const assigneeExistsSql = (alias, p) =>
  `EXISTS (SELECT 1 FROM application_assignees aa` +
  ` WHERE aa.application_id=${alias}.id AND aa.staff_id=${p} AND aa.removed_at IS NULL)`;

// THE definition of "which files may this staffer see". It lived as a const inside
// src/routes/staff.js and was byte-copied here (unchanged) when the Dashboards build
// needed it too — a lib may not require a route, and re-inlining the five-way predicate
// is exactly how a scope silently loses a branch (CLAUDE.md: never hand-roll
// `loan_officer_id=$1`, it drops delegation, assistants and open hand-offs).
// staff.js now delegates to this, so there is still ONE definition, and
// scripts/test-dashboards-db.js pins the two to the same string.
//
// A staffer reaches a file when ANY of these is true:
//   1. they are the primary loan officer,           2. they are the primary processor,
//   3. the file's officer is on their delegation list (staff_users.visible_officer_ids),
//   4. they are an active assignee (primary or full-access assistant, db/103),
//   5. a workflow hand-off was routed to them and is still open/in-progress (db/212).
//
// `${alias}.id` must be selectable, and `p` is the acting staff-id param PLACEHOLDER —
// a function, not a fixed string, because a see_all_files caller drops this clause
// entirely and a hardcoded `$1` would leave an unreferenced parameter, which Postgres
// rejects outright (42P18).
const visibleOfficersSql = (alias, p) =>
  `(${alias}.loan_officer_id=${p} OR ${alias}.processor_id=${p}` +
  ` OR ${alias}.loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=${p})` +
  ` OR ${assigneeExistsSql(alias, p)}` +
  ` OR EXISTS (SELECT 1 FROM workflow_items wi` +
  ` WHERE wi.application_id=${alias}.id AND wi.to_staff_id=${p} AND wi.status IN ('open','in_progress')))`;

module.exports = {
  ROLES, ROLE_KEYS, ROLE_LABEL, CAPABILITIES, CAP_KEYS, ROLE_DEFAULTS,
  defaultsFor, effectivePermissions, can, sanitizeOverrides, assigneeExistsSql,
  visibleOfficersSql,
};

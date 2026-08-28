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
  // VIEW-ONLY draw access for loan officers (owner-directed 2026-08-12). A loan
  // officer gets their own draw section + read-only access to the draw section on
  // their files — draws, findings, inspection photos, the Sitewire/Trinity PDFs,
  // notes — and may APPROVE or DISPUTE a finding on the borrower's behalf, but can
  // run NONE of the draw desk (no start/approve/deliver/release/reallocate). It is
  // a DISTINCT capability so it never grants the broader manage_draws power; the
  // read routes accept `manage_draws OR view_draws`, so a coordinator/processor is
  // unaffected. File scope is still enforced per-route (canSeeFile / fileScope).
  { key: 'view_draws', label: 'View construction draws (read-only)', hint: 'See the draw section on your files — draws, findings, inspection photos and reports — and approve or dispute a finding on the borrower\'s behalf. Does NOT grant manage_draws (the draw desk). Loan officers hold it.' },
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
  // Sending the official term sheet (and any other package) out on DocuSign is a
  // LENDER-ONLY action (owner-locked TPO decision): every internal staff role
  // holds it, so internal behavior is unchanged, but an external broker (kind
  // 'tpo') can NEVER hold it — `can()` returns false for any non-staff actor —
  // so a TPO can never send the signable package. A broker uploads and requests;
  // we send. Do NOT grant this to a TPO role.
  { key: 'send_term_sheet', label: 'Send documents for signature (DocuSign)', hint: 'Send the official term sheet and other DocuSign packages. Lender-only — never granted to an external broker.' },
  { key: 'manage_team', label: 'Manage the team', hint: 'Add staff, set roles, set passwords.' },
  { key: 'platform_setup', label: 'Platform setup', hint: 'Integrations, email config, and other software setup.' },
  { key: 'view_audit_log', label: 'View the system audit log', hint: 'The company-wide trail of every action across every file and borrower.' },
];
const CAP_KEYS = CAPABILITIES.map((c) => c.key);

// Role defaults. super_admin is handled implicitly (all). admin gets everything
// too by default but is still a distinct, revocable role.
const ROLE_DEFAULTS = {
  super_admin: CAP_KEYS.slice(),
  admin: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'pull_credit', 'waive_vesting_llc', 'manage_conditions', 'manage_pricing', 'manage_draws', 'manage_closings', 'manage_purchasing', 'waive_conditions', 'delete_files', 'manage_vendors', 'export_data_tapes', 'send_term_sheet', 'manage_team', 'platform_setup', 'view_audit_log'],
  // Underwriters run per-file conditions + sign-off + waive; the GLOBAL studio
  // (manage_conditions) is admin/software-setup by default but an admin can
  // grant it to a specific underwriter from the Team screen. They also export
  // capital-provider data tapes (owner-directed 2026-07-26) and pull credit.
  underwriter: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'pull_credit', 'waive_vesting_llc', 'waive_conditions', 'export_data_tapes', 'send_term_sheet'],
  loan_coordinator: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'pull_credit', 'waive_vesting_llc', 'send_term_sheet'],
  // The Draw Coordinator persona (default holder Lisa Katz): runs the Sitewire draw
  // desk across all files. Admin-overridable per the coordinator rules.
  draw_coordinator: ['see_all_files', 'manage_draws', 'review_conditions', 'send_term_sheet'],
  // Processors sign off conditions, manage draws, export data tapes
  // (owner-directed 2026-07-26), and pull credit. They ALSO hold waive_conditions
  // (owner-directed 2026-07-26): a processor handling a finding must be able to finish
  // it — including clearing a clear-to-close-blocking dealbreaker with a recorded reason
  // — instead of being forced to escalate it to a super-admin. The decision is still
  // fully attributed (who/why/when on the finding + the audit log), and an admin can
  // revoke it for a specific person from the Team screen.
  // AND they see the WHOLE pipeline (owner-directed 2026-08-26: "anyone with the
  // back office persona should technically have access to the entire pipeline,
  // not only the files that they are assigned … all the files and all the
  // borrower profiles … the same way admins have"). Their assigned-files
  // WORKFLOW is untouched — the personal queue, my-tasks and the ?mine=1
  // pipeline lens are id-keyed, not visibility-keyed. Revocable per person from
  // the Team screen like every capability.
  processor: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'pull_credit', 'manage_draws', 'export_data_tapes', 'waive_conditions', 'waive_vesting_llc', 'send_term_sheet'],
  // Loan officers can REVIEW conditions (the lighter stamp) but NOT sign them off.
  // They CAN pull_credit (owner-directed 2026-07-23): the LO pulls credit at point of
  // sale, then marks the credit condition Done (the reviewed stamp) — the processor
  // still signs it off. This does NOT grant sign_off_conditions.
  // They do NOT manage draws by default (owner-directed 2026-07-20): pushing a file to Sitewire, deleting/
  // re-pushing it, approving draws and recording releases require the manage_draws capability, which is held
  // by the Draw Coordinator / Processor / Admin / Super Admin — never a loan officer unless an admin
  // explicitly grants it per-person from the Team screen. (super_admin has every capability implicitly.)
  // view_draws (owner-directed 2026-08-12): a read-only draw section + approve/dispute
  // a finding on the borrower's behalf. Still NOT manage_draws (no draw desk).
  loan_officer: ['review_conditions', 'pull_credit', 'waive_vesting_llc', 'send_term_sheet', 'view_draws'],
  // Closers see the whole pipeline (they need the closing queue across files) and
  // can review + sign off closing conditions on the files handed to them, plus run
  // the closing desk (manage_closings) and pull credit. An admin can widen/narrow
  // per-person from the Team screen.
  closer: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'pull_credit', 'manage_closings', 'manage_purchasing', 'waive_vesting_llc', 'send_term_sheet'],
  software_setup: ['manage_conditions', 'platform_setup', 'send_term_sheet'],
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
//   5. a workflow hand-off was routed to them — WHETHER OR NOT IT IS STILL OPEN.
//
// BRANCH 5 IS NOT LIMITED TO AN OPEN HAND-OFF (owner-directed 2026-08-25, asked
// directly: "once they worked it, they keep it"). It used to read
// `status IN ('open','in_progress')`, so the moment a processor RETURNED the file
// — which is how they finish their step — they became a stranger to it: the file
// screen answered `forbidden`, and the term sheet's own "See what doesn't match"
// button led them straight into that refusal. `workflow_items` is a record that
// this person was given this file to work, and returning it does not un-work it;
// they are still the person to ask about what they did. `removed_at IS NULL`
// stays — and a CANCELLED hand-off is excluded too, because cancelling one means
// the person was never given the work: "once they worked it" does not describe
// them. Withdrawing or cancelling the hand-off is how the access is withdrawn.
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
  ` WHERE wi.application_id=${alias}.id AND wi.to_staff_id=${p}` +
  ` AND wi.status <> 'cancelled' AND wi.removed_at IS NULL))`;

// Which BORROWERS an internal staffer may see. MOVED HERE from routes/staff.js so
// a second door can ask the question without re-inlining it — the standing rule
// is "never re-inline a borrower scope", and a scope that can only be reached by
// requiring a 19,000-line route module gets re-inlined eventually. staff.js's
// VISIBLE_BORROWER_SQL is now an alias of this, exactly as VISIBLE_OFFICERS_SQL
// is an alias of visibleOfficersSql, so there is still one definition.
//
// A borrower belongs to EVERY officer they have done business with, not just one
// (owner-directed 2026-07-26): `borrower_officers` (db/327) is the many-to-many
// the ClickUp sync records from EVERY card in EVERY status, `primary_officer_id`
// stays the single CRM owner, both are honored, plus the visible_officer_ids
// delegation, plus any file the staffer can already see.
// Requires the borrowers alias to expose id + primary_officer_id.
const visibleBorrowerSql = (alias, p) =>
  `(${alias}.primary_officer_id=${p}` +
  ` OR ${alias}.primary_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=${p})` +
  ` OR EXISTS (SELECT 1 FROM borrower_officers bo WHERE bo.borrower_id=${alias}.id` +
  ` AND (bo.staff_id=${p} OR bo.staff_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=${p})))` +
  ` OR EXISTS (SELECT 1 FROM applications a2` +
  ` WHERE (a2.borrower_id=${alias}.id OR a2.co_borrower_id=${alias}.id) AND a2.deleted_at IS NULL` +
  ` AND ${visibleOfficersSql('a2', p)}))`;

// Which LEADS a non-privileged officer may touch: their own, or one nobody has
// been given yet. The horizontal scope only — a `see_all_files` caller drops the
// clause entirely, the same shape as visibleOfficersSql. Written down once here
// because it now has three callers (the leads desk's PATCH, its notes, and the
// Elementix CRM's person link), and three copies of an ownership rule is how one
// of them quietly stops matching the other two.
const visibleLeadSql = (alias, p) => `(${alias}.officer_id=${p} OR ${alias}.officer_id IS NULL)`;

// ============================================================================
// TPO PORTAL (owner-directed 2026-08-04; db/472 + db/473; design
// docs/TPO-PORTAL-BLUEPRINT.md). A TPO user is an EXTERNAL staff_users row
// (`is_external=true`, `tpo_firm_id` set, role tpo_officer / tpo_processor) whose
// SESSION carries `kind='tpo'`. They are deliberately NOT in the ROLES array
// above — that array drives the INTERNAL roster + the internal-invite
// ASSIGNABLE_ROLES set, and an external role must never be assignable to an
// internal staffer. `can()` returns false for a tpo actor (kind !== 'staff'),
// so a tpo session can never satisfy a staff capability gate.
// ============================================================================

// The two external roles, for display only (a firm-side roster in the TPO
// portal). Kept OUT of ROLES/ROLE_KEYS on purpose (see the note above).
const TPO_ROLES = [
  { key: 'tpo_officer', label: 'Loan Officer (Broker)' },
  { key: 'tpo_processor', label: 'Processor' },
];
const TPO_ROLE_KEYS = TPO_ROLES.map((r) => r.key);
const TPO_ROLE_LABEL = Object.fromEntries(TPO_ROLES.map((r) => [r.key, r.label]));

/** Is this actor a TPO (external brokerage) user? */
function isTpoActor(actor) {
  return !!(actor && actor.kind === 'tpo');
}

// THE definition of "which files a TPO user may see" — their own firm's TPO
// files, and ONLY those. Every /api/tpo file/borrower query routes through this
// so firm isolation lives in ONE place (the same discipline as
// visibleOfficersSql). `p` is the acting external-staff-id placeholder; it is
// ALWAYS referenced (a TPO actor is always firm-bounded — there is no
// see_all_files escape for an external user). The `is_external=true` guard means
// only a genuine external row ever resolves a firm — an internal id resolves
// NULL, and `tpo_firm_id = NULL` matches nothing, so a stray internal caller is
// scoped to zero files rather than to everything.
const tpoFirmScopeSql = (alias, p) =>
  `(${alias}.is_tpo = true AND ${alias}.tpo_firm_id = ` +
  `(SELECT tpo_firm_id FROM staff_users WHERE id=${p} AND is_external=true))`;

// Which BORROWERS a TPO firm may see: anyone who is the borrower or co-borrower
// on one of the firm's TPO files. `alias` is the borrowers alias; `p` the
// acting external-staff-id placeholder.
const tpoBorrowerScopeSql = (alias, p) =>
  `EXISTS (SELECT 1 FROM applications a2 WHERE a2.deleted_at IS NULL` +
  ` AND (a2.borrower_id=${alias}.id OR a2.co_borrower_id=${alias}.id)` +
  ` AND ${tpoFirmScopeSql('a2', p)})`;

module.exports = {
  ROLES, ROLE_KEYS, ROLE_LABEL, CAPABILITIES, CAP_KEYS, ROLE_DEFAULTS,
  defaultsFor, effectivePermissions, can, sanitizeOverrides, assigneeExistsSql,
  visibleOfficersSql, visibleBorrowerSql, visibleLeadSql,
  // TPO portal
  TPO_ROLES, TPO_ROLE_KEYS, TPO_ROLE_LABEL, isTpoActor,
  tpoFirmScopeSql, tpoBorrowerScopeSql,
};

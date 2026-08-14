'use strict';
/**
 * LONG-TERM — who sees which files.
 *
 * Owner-directed 2026-08-14:
 *
 *   "Staff members, processors, officers, closers, and funders: the closer and
 *    funder should have access to the entire pipeline, even if they're not
 *    assigned yet. Processors should only have access to their own pipeline.
 *    Admin should have access to the entire pipeline. loan officers are only to
 *    their own pipeline."
 *
 * The closer and the funder deliberately get everything BEFORE assignment, because
 * a closing or a wire is picked up off the queue rather than handed over — they
 * have to see the file to take it.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT RTL's `permissions.js`.
 *
 *   1. SEPARATION. LT may not import RTL code; the ledger authorises identity, not
 *      the permission engine. This is a brand-new build, as the charter requires.
 *
 *   2. `staff_users.role` HAS NO `funder` VALUE. Its CHECK lists super_admin,
 *      admin, underwriter, loan_officer, loan_coordinator, draw_coordinator,
 *      processor, closer, software_setup, tpo_officer, tpo_processor. Adding one
 *      would be changing an RTL table to make LT work, which rule 5 forbids. So a
 *      person whose long-term job is not described by their RTL role gets a
 *      long-term role OVERRIDE, which lives in settings — not on staff_users.
 *
 *   3. SELLABLE-LOS RULE. A buyer's org chart is not ours. The role -> scope map is
 *      a SETTING pre-filled with the owner's answer, so changing it is a settings
 *      edit rather than a migration.
 *
 * FAIL-CLOSED. A role with no entry resolves to `own`, never to `all`. An unmapped
 * role must not silently inherit the whole book. `own` on a person with no confirmed
 * Encompass link yields an EMPTY pipeline rather than everything — which is why the
 * people map (phase 1) ships before the pipeline (phase 3).
 *
 * PURE. No database and no network: every function is handed what it needs, so the
 * whole policy is unit-testable without a Postgres.
 */

const SCOPE_ALL = 'all';
const SCOPE_OWN = 'own';

/**
 * OUR default map, pre-filled with the owner's answer. A buyer changes this in
 * settings (`access.roleScopes`), never in code.
 *
 * `underwriter` is NOT in the owner's list and is an ASSUMPTION, flagged in the
 * plan (§11): an underwriter reviews across the book rather than a personal queue,
 * and already holds see_all_files on the RTL side, so giving them the whole
 * long-term pipeline is consistent and is not a new exposure. It is the one entry
 * here awaiting confirmation.
 */
const DEFAULT_ROLE_SCOPES = {
  super_admin:   SCOPE_ALL,
  admin:         SCOPE_ALL,
  closer:        SCOPE_ALL,
  funder:        SCOPE_ALL,
  underwriter:   SCOPE_ALL,   // assumption — see above
  loan_officer:  SCOPE_OWN,
  processor:     SCOPE_OWN,
};

/**
 * Long-term role names this system understands. Deliberately a superset of
 * staff_users.role: `funder` and `post_closer` exist in the Encompass milestone
 * catalog (roles 8 and 9) and describe real long-term jobs that the RTL role
 * column has no word for.
 */
const LT_ROLES = [
  'super_admin', 'admin', 'underwriter', 'loan_officer', 'processor',
  'closer', 'funder', 'post_closer', 'loan_coordinator',
];

/**
 * The long-term role for a staff member.
 *
 * The override wins: it is how somebody whose RTL role is (say) `loan_coordinator`
 * is recognised as the long-term FUNDER without touching an RTL table. An override
 * naming a role we do not understand is IGNORED rather than obeyed — a typo in
 * settings must not hand somebody a scope, and falling back to their real role is
 * the safe reading.
 */
function longTermRoleFor(staff, settings = {}) {
  const overrides = settings['access.roleOverrides'] || {};
  const id = staff && staff.id != null ? String(staff.id) : '';
  const override = id ? overrides[id] : null;
  if (override && LT_ROLES.includes(String(override))) return String(override);
  const role = staff && staff.role ? String(staff.role) : '';
  return role;
}

/**
 * `all` or `own`, for a resolved long-term role. Fails closed to `own`.
 */
function scopeForRole(ltRole, settings = {}) {
  const configured = settings['access.roleScopes'];
  const map = (configured && typeof configured === 'object') ? configured : DEFAULT_ROLE_SCOPES;
  const v = map[String(ltRole)];
  return v === SCOPE_ALL ? SCOPE_ALL : SCOPE_OWN;
}

/**
 * The whole decision for one staff member: `{ltRole, scope, seesAll}`.
 */
function accessFor(staff, settings = {}) {
  const ltRole = longTermRoleFor(staff, settings);
  const scope = scopeForRole(ltRole, settings);
  return { ltRole, scope, seesAll: scope === SCOPE_ALL };
}

/**
 * The SQL fragment that narrows a pipeline query to what this person may see,
 * plus the parameters it needs.
 *
 * Returns `{where, params}` where `where` is either empty (sees everything) or a
 * predicate to AND onto the caller's WHERE.
 *
 * `own` resolves through lt_loan_contacts, and it deliberately honours BOTH sides
 * of the two-source assignment model: the Encompass-resolved `staff_id` AND a
 * PILOT-side `override_staff_id`. A file somebody was given locally is theirs even
 * though Encompass still names the previous officer — that is the entire point of
 * allowing an override.
 *
 * The fragment is a FUNCTION of its placeholder index, never a hard-coded `$1`.
 * (RTL learned this the hard way: a hard-coded placeholder becomes an unreferenced
 * parameter the moment a sees-all caller drops the clause, and Postgres answers
 * 42P18.)
 */
function pipelineScopeSql(access, staffId, firstParamIndex = 1) {
  if (!access || access.seesAll) return { where: '', params: [] };
  const p = `$${firstParamIndex}`;
  return {
    where: `EXISTS (
      SELECT 1 FROM lt_loan_contacts c
       WHERE c.loan_id = l.id
         AND (c.staff_id = ${p}::uuid OR c.override_staff_id = ${p}::uuid)
    )`,
    params: [staffId],
  };
}

/**
 * May this person open THIS loan? Same rule as the pipeline, expressed for a single
 * file so a direct link cannot reach further than the list does.
 */
function mayOpenLoan(access, staffId, contacts = []) {
  if (!access) return false;
  if (access.seesAll) return true;
  const me = String(staffId || '');
  if (!me) return false;
  return (contacts || []).some((c) => (
    String(c.staff_id || c.staffId || '') === me
    || String(c.override_staff_id || c.overrideStaffId || '') === me
  ));
}

/**
 * A plain-language reason, for a screen that has to explain an empty pipeline.
 * "You have no long-term files" and "nobody has linked your Encompass account yet"
 * look identical to a user and need completely different actions.
 */
function emptyPipelineReason(access, { hasConfirmedLink } = {}) {
  if (!access || access.seesAll) return null;
  if (hasConfirmedLink === false) {
    return 'Your PILOT account is not linked to an Encompass user yet, so no long-term files can be matched to you. An administrator can link it on the Long-Term → People screen.';
  }
  return null;
}

module.exports = {
  SCOPE_ALL,
  SCOPE_OWN,
  LT_ROLES,
  DEFAULT_ROLE_SCOPES,
  longTermRoleFor,
  scopeForRole,
  accessFor,
  pipelineScopeSql,
  mayOpenLoan,
  emptyPipelineReason,
};

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
 * `own` resolves through lt_loan_contacts, honouring both sides of the two-source
 * assignment model — the Encompass-resolved `staff_id` and the PILOT-side
 * `override_staff_id` — the way `onFileSql` describes below.
 *
 * The fragment is a FUNCTION of its placeholder index, never a hard-coded `$1`.
 * (RTL learned this the hard way: a hard-coded placeholder becomes an unreferenced
 * parameter the moment a sees-all caller drops the clause, and Postgres answers
 * 42P18.)
 */
function pipelineScopeSql(access, staffId, firstParamIndex = 1) {
  if (!access || access.seesAll) return { where: '', params: [] };
  return { where: onFileSql(`$${firstParamIndex}`), params: [staffId] };
}

/**
 * A REASSIGNMENT MOVES THE FILE WITHIN ITS ROLE SLOT, AND EVERY SLOT IS INDEPENDENT
 * (owner-directed 2026-08-17): *"if you reassign the Loan Coordinator, then it should
 * be moved … If there are a few options in Encompass for a few Loan Coordinators and
 * you select one of them for one Coordinator and one of them for another Coordinator,
 * then both of them should have it. If you reassign Processor, it should also move
 * over. If you're just adding another Processor for another stage, then it should
 * keep both."*
 *
 * Both halves fall out of ONE expression — `COALESCE(override_staff_id, staff_id)`
 * per ROW, inside an EXISTS over every row:
 *
 *   · WITHIN a slot the override REPLACES Encompass's answer, so reassigning the
 *     coordinator genuinely moves the file and the person Encompass names stops
 *     seeing it through that slot. An override that merely ADDED somebody could
 *     never take a file away from anybody — an officer who left the company would
 *     keep every file they were ever named on.
 *   · ACROSS slots nothing is taken away, because each row is judged on its own. A
 *     second coordinator, or a processor added for another stage, is a DIFFERENT row
 *     (`UNIQUE (loan_id, role)`), so both people hold the file through their own slot
 *     and neither reassignment touches the other.
 *
 * This is also what removes a real drift. Every other reading of "whose file is
 * this" — `pipeline.officerIsSql`, `UNASSIGNED_SQL`, the row's own `staffId`,
 * `describeContact.effectiveStaffId` — was already this exact COALESCE; the access
 * scope was the one outlier, so a reassigned file used to leave the previous
 * officer's officer-filter while staying in their own pipeline. One question, one
 * predicate.
 *
 * NOTHING MOVES ON A FILE THAT HAS NO OVERRIDE. With `override_staff_id` NULL the
 * expression IS `staff_id`, so this is byte-identical to the rule it replaces on
 * every loan nobody has reassigned — asserted, not assumed.
 *
 * "Is this person ON this file?" is exported because it has to mean ONE thing.
 * `pipelineScopeSql` uses it to decide what a scoped viewer may see at all, the
 * pipeline's "Mine" chip uses it to count what an unscoped viewer is personally on,
 * and `mayOpenLoan` is its twin for a single file. Written three times, they would
 * drift, and the drift shows up as a processor whose own book is empty because
 * somebody defined "mine" as "the loan officer is me".
 *
 * Takes the placeholder rather than an index, so the caller owns its own parameter
 * arithmetic — a hard-coded `$1` becomes an unreferenced parameter the moment a
 * sees-all caller drops the clause, and Postgres answers 42P18.
 */
/**
 * THE EFFECTIVE PERSON IN ONE CONTACT ROW — the expression everything above is
 * built out of, written ONCE.
 *
 * It was correct in five places and typed out in all five: here, both of the
 * pipeline's predicates, the row's own `staffId`, and `describeContact`. Five
 * copies of a rule agreeing today is not the same as one rule — the drift this
 * whole comment describes is what five copies look like a year later, and the
 * one that went wrong was the one nobody thought of as a copy. So the SQL half
 * is this function and the JS half is `effectiveStaffIdOf` below, and a sixth
 * reader (the owner's census, which used to read a dead column on `lt_loans`)
 * asks here rather than typing a sixth.
 *
 * Takes the row ALIAS because each caller joins the table under its own name.
 */
function effectiveStaffSql(alias) {
  return `COALESCE(${alias}.override_staff_id, ${alias}.staff_id)`;
}

function onFileSql(ph) {
  return `EXISTS (
      SELECT 1 FROM lt_loan_contacts c
       WHERE c.loan_id = l.id
         AND ${effectiveStaffSql('c')} = ${ph}::uuid
    )`;
}

/**
 * WHY somebody is on a file decides whether it is THEIRS (owner-directed
 * 2026-08-23: *"your system needs to understand, for each and every person, why
 * they are looped into the file"* — a file where the owner was assigned "only to
 * the Closer and Funder milestone" turned up in their LOAN-OFFICER pipeline).
 *
 * `onFileSql` answers a different question — MAY they open it — and deliberately
 * matches every role: being the closer on a file is real access (the 2026-08-14
 * ruling stands untouched). This map answers "which files are MINE": the contact
 * roles that match the person's own FUNCTION. An admin's book is the files they
 * ORIGINATE (they wear the loan-officer hat when they carry files — the owner's
 * own search was "files that I was the Loan Officer on"); a processor's is the
 * files they process or set up; a closer's "mine" is their closing queue.
 *
 * SELLABLE-LOS RULE: a buyer's org chart is not ours, so the map is a SETTING
 * (`access.mineRoles`) pre-filled with this default. A role with NO entry
 * anywhere answers null — which callers read as "any role", the pre-2026-08-24
 * behaviour, because an unmapped role silently shown an EMPTY book is a support
 * ticket while a broad book is merely unfiltered.
 */
const DEFAULT_MINE_ROLES = {
  loan_officer: ['loan_officer'],
  loan_coordinator: ['loan_officer'],   // this tenant's own name for the LO slot
  processor: ['processor', 'file_setup'],
  underwriter: ['underwriter'],
  closer: ['closer'],
  funder: ['funder'],
  post_closer: ['post_closer'],
  admin: ['loan_officer'],
  super_admin: ['loan_officer'],
};

function rolesForMine(ltRole, settings = {}) {
  const configured = settings['access.mineRoles'];
  const map = (configured && typeof configured === 'object') ? configured : DEFAULT_MINE_ROLES;
  const v = map[String(ltRole || '')];
  if (Array.isArray(v) && v.length) return v.map(String);
  // A configured map that omits the role still falls back to OUR default for it —
  // a buyer narrowing one role must not silently widen every other.
  const d = DEFAULT_MINE_ROLES[String(ltRole || '')];
  return Array.isArray(d) && d.length ? d.slice() : null;
}

/**
 * "Is this file MINE, in one of THESE roles?" — the persona-matched twin of
 * `onFileSql`, taking a second placeholder for the role list. Same effective-person
 * expression, so an override moves a file between people identically in both.
 */
function mineRolesSql(mePh, rolesPh) {
  return `EXISTS (
      SELECT 1 FROM lt_loan_contacts c
       WHERE c.loan_id = l.id
         AND c.role = ANY(${rolesPh}::text[])
         AND ${effectiveStaffSql('c')} = ${mePh}::uuid
    )`;
}

/** The JS twin of `onFileSql`, for a caller holding rows rather than a query. It
 *  MUST read the same way — a single file that opens for somebody the list would
 *  never show them is the whole class this pair exists to prevent. */
function effectiveStaffIdOf(c) {
  const override = String((c && (c.override_staff_id || c.overrideStaffId)) || '');
  const encompass = String((c && (c.staff_id || c.staffId)) || '');
  return override || encompass;
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
  // The SAME rule `onFileSql` runs, expressed for rows in hand: the EFFECTIVE person
  // per contact, so a file a reassignment moved away can no longer be opened by a
  // direct link after it has left the list.
  return (contacts || []).some((c) => effectiveStaffIdOf(c) === me);
}

/**
 * The roles allowed to ADMINISTER the long-term side — today, to confirm who an
 * Encompass login belongs to. Deliberately narrower than "sees the whole pipeline":
 * a closer and a funder see every file (the owner's rule) and have no business
 * deciding whose book is whose.
 *
 * Settings-driven (`access.adminRoles`) like every other org-chart assumption here.
 * Fails CLOSED: an unreadable or non-list setting falls back to OUR default rather
 * than to "everybody".
 *
 * `super_admin` IS A FLOOR AND IS ADDED BACK WHATEVER THE SETTING SAYS. This one is
 * load-bearing, not tidiness: `access.adminRoles` decides who may edit the settings,
 * so it can edit itself out of reach. An administrator who saved `['loan_officer']`
 * — a typo, or a buyer configuring their own org chart — would lock EVERY person in
 * the company out of the settings screen, including the person who has to undo it,
 * and the only remedy left would be a hand-written row in the database. A gate whose
 * own remedy nobody at the company can perform is a dead end, so the top authority
 * always keeps the key.
 */
const DEFAULT_ADMIN_ROLES = ['super_admin', 'admin'];
const ADMIN_FLOOR_ROLE = 'super_admin';

function adminRoles(settings = {}) {
  const v = settings['access.adminRoles'];
  const configured = Array.isArray(v) && v.length ? v.map(String) : DEFAULT_ADMIN_ROLES;
  return configured.includes(ADMIN_FLOOR_ROLE) ? configured : [ADMIN_FLOOR_ROLE, ...configured];
}

/**
 * May this person confirm, reject or change a people-map link?
 *
 * Reads the person's REAL role, not the long-term override: an override exists so
 * somebody can be recognised as the long-term funder without touching an RTL table,
 * and letting one grant ADMIN rights would turn a settings typo into a privilege
 * escalation. Administering is an identity-zone decision, so it stays on the
 * identity-zone role.
 */
function mayManagePeople(staff, settings = {}) {
  const role = staff && staff.role ? String(staff.role) : '';
  if (!role) return false;
  return adminRoles(settings).includes(role);
}

/**
 * May this person reassign a file locally — set or clear a contact override?
 *
 * DELEGATES to `mayManagePeople` rather than restating its rule, because the two
 * decisions are the same decision wearing two hats: confirming a link says "this
 * login is that person" and moves every one of their files at once; an override
 * says "this ONE file is that person's" and moves one. A buyer who narrows
 * `access.adminRoles` means both, and two copies of the rule would eventually
 * disagree about which.
 *
 * IT IS AN ADMIN GATE AND NOT A CONVENIENCE. An override is not a label: the
 * pipeline scope matches `override_staff_id` (see `onFileSql`), so SETTING one
 * GRANTS a person access to a file they could not otherwise open, and CLEARING one
 * TAKES that access away. A scoped officer able to set their own would be able to
 * read any file in the book by naming themselves on it.
 *
 * And, for the same reason `mayManagePeople` does it, this reads the person's REAL
 * role and never the long-term role override — a settings typo must not be a route
 * to granting yourself files.
 */
function mayReassignLoan(staff, settings = {}) {
  return mayManagePeople(staff, settings);
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
  DEFAULT_ADMIN_ROLES,
  DEFAULT_MINE_ROLES,
  ADMIN_FLOOR_ROLE,
  adminRoles,
  mayManagePeople,
  mayReassignLoan,
  longTermRoleFor,
  scopeForRole,
  accessFor,
  pipelineScopeSql,
  onFileSql,
  rolesForMine,
  mineRolesSql,
  effectiveStaffSql,
  effectiveStaffIdOf,
  mayOpenLoan,
  emptyPipelineReason,
};

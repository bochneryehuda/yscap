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
  { key: 'processor', label: 'Loan Processor' },
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
  { key: 'manage_conditions', label: 'Manage the Condition Center', hint: 'Author the global condition library and rule engine.' },
  { key: 'waive_conditions', label: 'Waive conditions', hint: 'Waive a condition with a reason instead of clearing it.' },
  { key: 'delete_files', label: 'Delete / restore files', hint: 'Soft-delete a loan file and restore it.' },
  { key: 'manage_vendors', label: 'Manage the vendor directory', hint: 'Title & insurance vendor list.' },
  { key: 'manage_team', label: 'Manage the team', hint: 'Add staff, set roles, set passwords.' },
  { key: 'platform_setup', label: 'Platform setup', hint: 'Integrations, email config, and other software setup.' },
  { key: 'view_audit_log', label: 'View the system audit log', hint: 'The company-wide trail of every action across every file and borrower.' },
];
const CAP_KEYS = CAPABILITIES.map((c) => c.key);

// Role defaults. super_admin is handled implicitly (all). admin gets everything
// too by default but is still a distinct, revocable role.
const ROLE_DEFAULTS = {
  super_admin: CAP_KEYS.slice(),
  admin: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'manage_conditions', 'waive_conditions', 'delete_files', 'manage_vendors', 'manage_team', 'platform_setup', 'view_audit_log'],
  // Underwriters run per-file conditions + sign-off + waive; the GLOBAL studio
  // (manage_conditions) is admin/software-setup by default but an admin can
  // grant it to a specific underwriter from the Team screen.
  underwriter: ['see_all_files', 'review_conditions', 'sign_off_conditions', 'waive_conditions'],
  loan_coordinator: ['see_all_files', 'review_conditions', 'sign_off_conditions'],
  processor: ['review_conditions', 'sign_off_conditions'],
  // Loan officers can REVIEW conditions (the lighter stamp) but NOT sign them off.
  loan_officer: ['review_conditions'],
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

module.exports = {
  ROLES, ROLE_KEYS, ROLE_LABEL, CAPABILITIES, CAP_KEYS, ROLE_DEFAULTS,
  defaultsFor, effectivePermissions, can, sanitizeOverrides,
};

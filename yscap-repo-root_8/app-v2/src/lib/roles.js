/**
 * THE INTERNAL STAFF ROLES — the front end's ONE copy.
 *
 * The server's registry is `src/lib/permissions.js` (ROLES): key, label, and
 * — for a role that behaves as another — its `persona`. The portal cannot
 * import a CommonJS server module, so this is its MIRROR, and the mirror is
 * pinned to the original by `scripts/test-loan-officer-assistant-pure.mjs`:
 * the same keys in the same order, the same labels, the same personas, or the
 * build fails. Before this file the role labels were typed out in FIVE places
 * (the sidebar, the audit log, the workflow screen, the borrower-view banner,
 * the Team screen's fallback) and had already drifted ("Processor" in two of
 * them, "Loan Processor" in the others). A new role now lands in one line here.
 *
 * WHAT A PERSONA IS. `persona` names the role whose SCREENS AND BEHAVIOUR a
 * role inherits: which conditions view opens by default, whose "Done" step it
 * is, which nav entries show. It says nothing about what the person may DO —
 * capabilities come from the server (`can()` on the auth context) and are
 * never inferred here. Every place that used to ask `role === 'loan_officer'`
 * to decide how the app should behave asks `isLoanOfficerPersona(role)`
 * instead, so "behaves as a loan officer" is declared once, in the registry,
 * and not re-listed at each call site.
 *
 * PURE — no React, no api, no DOM — so the pinning test can import it from
 * node without a browser.
 */

export const INTERNAL_ROLES = Object.freeze([
  { key: 'super_admin', label: 'Super Admin' },
  { key: 'admin', label: 'Admin' },
  { key: 'underwriter', label: 'Underwriter' },
  { key: 'loan_officer', label: 'Loan Officer' },
  // Owner-directed 2026-09-02 (short-term side): a back-office role with the
  // loan officer's own permissions and screens — never a processor's.
  { key: 'loan_officer_assistant', label: 'Loan Officer Assistant', persona: 'loan_officer' },
  { key: 'loan_coordinator', label: 'Loan Coordinator' },
  { key: 'draw_coordinator', label: 'Draw Coordinator' },
  { key: 'processor', label: 'Loan Processor' },
  { key: 'closer', label: 'Closer' },
  { key: 'software_setup', label: 'Software Setup' },
]);

/** key → label, for every internal role. */
export const ROLE_LABEL = Object.freeze(Object.fromEntries(INTERNAL_ROLES.map((r) => [r.key, r.label])));

/** key → persona (a role with no `persona` is its own). */
const ROLE_PERSONA = Object.fromEntries(INTERNAL_ROLES.map((r) => [r.key, r.persona || r.key]));

/**
 * The persona a role behaves as. Unknown, external and missing roles answer
 * themselves unchanged, so `personaOf(x) === 'loan_officer'` is exactly "a loan
 * officer, or a role registered to behave as one" — never true of a stray value.
 */
export function personaOf(role) {
  const key = role == null ? '' : String(role);
  return ROLE_PERSONA[key] || key;
}

/** Does this role behave as the loan officer? (The officer's Done step, review view, buttons.) */
export const isLoanOfficerPersona = (role) => personaOf(role) === 'loan_officer';

/**
 * "Back to my … view" — how the borrower-view banner names the way back, in
 * the staffer's own terms (owner-directed). One entry per internal role; the
 * pinning test asserts the list is complete so a new role can never fall to
 * the bare "console" fallback unnoticed.
 */
export const ROLE_VIEW_NAME = Object.freeze({
  super_admin: 'admin view', admin: 'admin view', underwriter: 'underwriter view',
  loan_officer: 'loan officer view', loan_officer_assistant: 'loan officer assistant view',
  loan_coordinator: 'coordinator view', draw_coordinator: 'draw desk',
  processor: 'processor view', closer: 'closer view', software_setup: 'setup console',
});

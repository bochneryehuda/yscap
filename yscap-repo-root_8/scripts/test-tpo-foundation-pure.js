'use strict';
/**
 * TPO PORTAL foundation — pure tests for the permission / scoping helpers
 * (db/467 + db/468; no database needed). Guards the invariants that keep an
 * external brokerage user boxed into their own firm and out of internal gates.
 */
const assert = require('assert');
const perms = require('../src/lib/permissions');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

// --- external roles are NOT internal roles -------------------------------
ok(!perms.ROLE_KEYS.includes('tpo_officer'),
  'tpo_officer must NOT be in the internal ROLE_KEYS (it would become internally assignable)');
ok(!perms.ROLE_KEYS.includes('tpo_processor'),
  'tpo_processor must NOT be in the internal ROLE_KEYS');
ok(perms.TPO_ROLE_KEYS.includes('tpo_officer') && perms.TPO_ROLE_KEYS.includes('tpo_processor'),
  'both external roles live in TPO_ROLE_KEYS');
ok(perms.TPO_ROLE_LABEL.tpo_officer && perms.TPO_ROLE_LABEL.tpo_processor,
  'external roles have display labels');

// --- isTpoActor ----------------------------------------------------------
ok(perms.isTpoActor({ kind: 'tpo' }) === true, 'isTpoActor true for kind tpo');
ok(perms.isTpoActor({ kind: 'staff' }) === false, 'isTpoActor false for staff');
ok(perms.isTpoActor({ kind: 'borrower' }) === false, 'isTpoActor false for borrower');
ok(perms.isTpoActor(null) === false, 'isTpoActor false for null');

// --- can() never grants a staff capability to a tpo actor ----------------
ok(perms.can({ kind: 'tpo', role: 'tpo_officer', perms: new Set(['see_all_files']) }, 'see_all_files') === false,
  'a tpo actor can NEVER satisfy a staff capability gate, even with the cap forged onto perms');
ok(perms.can({ kind: 'staff', role: 'super_admin' }, 'see_all_files') === true,
  'sanity: a super_admin staff actor still satisfies a staff gate');

// --- the term-sheet-send lock is LENDER-ONLY -----------------------------
ok(perms.CAP_KEYS.includes('send_term_sheet'), 'send_term_sheet is a real capability');
for (const role of ['admin', 'underwriter', 'loan_coordinator', 'draw_coordinator', 'processor', 'loan_officer', 'closer', 'software_setup']) {
  ok(perms.effectivePermissions(role, null).has('send_term_sheet'),
    `every internal role holds send_term_sheet (${role}) — internal send behavior is unchanged`);
}
ok(perms.effectivePermissions('super_admin', null).has('send_term_sheet'), 'super_admin holds send_term_sheet');
ok(perms.can({ kind: 'tpo', role: 'tpo_officer', perms: new Set(['send_term_sheet']) }, 'send_term_sheet') === false,
  'a TPO can NEVER hold send_term_sheet, even with it forged onto perms — the term sheet is lender-only');

// --- tpoFirmScopeSql: firm-bounded, references the placeholder ------------
const fs = perms.tpoFirmScopeSql('a', '$1');
ok(fs.includes('$1'), 'firm scope references the acting-id placeholder (never an unreferenced param)');
ok(fs.includes('a.is_tpo = true'), 'firm scope requires a TPO file');
ok(fs.includes('a.tpo_firm_id ='), 'firm scope matches the actor\'s firm');
ok(fs.includes('is_external=true'), 'only a genuine external row resolves a firm (internal id -> NULL -> no rows)');

// --- tpoBorrowerScopeSql: reuses the firm scope --------------------------
const bs = perms.tpoBorrowerScopeSql('b', '$1');
ok(bs.includes('b.id') && bs.includes('borrower_id') && bs.includes('co_borrower_id'),
  'borrower scope reaches a borrower via a firm file, as borrower OR co-borrower');
ok(bs.includes('is_tpo = true'), 'borrower scope is still firm/TPO-bounded (reuses tpoFirmScopeSql)');

console.log(`test-tpo-foundation-pure: ${n} assertions passed`);

/* THE LOAN OFFICER ASSISTANT — pure proofs (no database, no network, no browser).
 *
 * Owner-directed 2026-09-02, short-term side: *"a new role, which is Loan Officer
 * Assistant, a back-office role, but you should have the same personas and the
 * same permissions as a loan officer, not the permissions of a processor. You
 * should not be able to be added as a processor on the file. You should be able
 * to be added as a Loan Officer Assistant on a file."*
 *
 * WHAT IS PROVED HERE, AND WHY EACH HALF IS ITS OWN SECTION.
 *
 *   A. The role is REGISTERED once (src/lib/permissions.js) with its persona.
 *   B. Its permissions are the loan officer's — the SAME array, not a copy that
 *      matches today. "Same permissions" is asserted as set equality AND as
 *      identity, so the two cannot drift apart without this failing.
 *   C. The front end's mirror (app-v2/src/lib/roles.js) IS the registry: same
 *      keys in the same order, same labels, same personas, a view name for
 *      every role. The portal cannot import a CommonJS server module, so the
 *      mirror exists; this is what keeps it honest.
 *   D. The persona REACHES the screens: the assistant gets the officer's Done
 *      step, the officer's default conditions view, the officer's buttons —
 *      compared against the loan officer's OWN answers, not against a
 *      hand-typed expectation, so a change to the officer's behaviour carries
 *      the assistant with it by construction.
 *   E. The hand-kept role maps are GONE — five screens read the registry, and
 *      no persona decision is spelled as `role === 'loan_officer'` any more.
 *   F. The DATABASE knows the role: db/672's two CHECK lists are parsed out of
 *      the SQL and compared to the registry, so the database's copy of the role
 *      list and the code's copy are pinned to each other.
 *   G. Every door that creates a file seats a creating assistant on it.
 *
 * The real-database half — an assistant refused in the processor slot, seated
 * in their own, opening the file and nothing else — is
 * scripts/test-loan-officer-assistant-db.js.
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  INTERNAL_ROLES, ROLE_LABEL, ROLE_VIEW_NAME, personaOf as fePersonaOf, isLoanOfficerPersona,
} from '../app-v2/src/lib/roles.js';
import {
  roleDone, conditionFilterLabel, conditionFilterHint, matchConditionFilter,
} from '../app-v2/src/lib/condition-filter.js';
import { canComplete, canDeleteDoc, nextStep, docNextStep } from '../app-v2/src/lib/condition-actions.js';

const require = createRequire(import.meta.url);
const perms = require('../src/lib/permissions');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ');

let failures = 0;
const ok = (cond, what, detail) => {
  if (cond) { console.log(`  PASS ${what}`); return; }
  failures++;
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const LOA = 'loan_officer_assistant';
const LO = 'loan_officer';

// ── A. THE REGISTRY ─────────────────────────────────────────────────────────
console.log('\nA. THE ROLE IS REGISTERED ONCE, WITH ITS PERSONA');
{
  const entry = perms.ROLES.find((r) => r.key === LOA);
  ok(!!entry, 'loan_officer_assistant is in ROLES');
  ok(entry && entry.label === 'Loan Officer Assistant', 'its label is "Loan Officer Assistant"', entry && entry.label);
  ok(entry && entry.persona === LO, 'its persona is the loan officer', entry && entry.persona);
  ok(perms.ROLE_KEYS.indexOf(LOA) === perms.ROLE_KEYS.indexOf(LO) + 1,
    'it sits directly after the loan officer in display order');
  ok(perms.ROLE_LABEL[LOA] === 'Loan Officer Assistant', 'ROLE_LABEL carries it');
  ok(!perms.TPO_ROLE_KEYS.includes(LOA), 'it is an INTERNAL role, not an external (TPO) one');
  ok(same(perms.TPO_ROLE_KEYS, ['tpo_officer', 'tpo_processor']), 'the external role set is untouched');

  ok(perms.personaOf(LOA) === LO, 'personaOf(loan_officer_assistant) is loan_officer');
  for (const r of perms.ROLE_KEYS.filter((k) => k !== LOA)) {
    ok(perms.personaOf(r) === r, `${r} is its own persona`);
  }
  for (const stray of [null, undefined, '', 'LOAN_OFFICER', 'tpo_officer', 'funder', 42]) {
    const v = perms.personaOf(stray);
    ok(v === (stray == null ? '' : String(stray)), `an unregistered value (${JSON.stringify(stray)}) answers itself, never a persona`, v);
  }
  ok(perms.ROLE_PERSONA[LOA] === LO && perms.ROLE_PERSONA[LO] === LO, 'ROLE_PERSONA is exported and agrees');
}

// ── B. THE PERMISSIONS ARE THE LOAN OFFICER'S ───────────────────────────────
console.log('\nB. THE PERMISSIONS ARE THE LOAN OFFICER\'S — THE SAME ARRAY, NOT A COPY');
{
  const lo = [...perms.effectivePermissions(LO, null)].sort();
  const la = [...perms.effectivePermissions(LOA, null)].sort();
  ok(same(lo, la), 'THE ONE THAT MATTERS: the effective capability set is identical to the loan officer\'s', `LO=${lo} LOA=${la}`);
  ok(perms.ROLE_DEFAULTS[LOA] === perms.ROLE_DEFAULTS[LO],
    'ROLE_DEFAULTS.loan_officer_assistant IS ROLE_DEFAULTS.loan_officer (same reference — they cannot drift)');
  for (const cap of ['review_conditions', 'pull_credit', 'waive_vesting_llc', 'send_term_sheet', 'view_draws']) {
    ok(perms.defaultsFor(LOA).has(cap), `holds ${cap} (the officer's)`);
  }
  for (const cap of ['see_all_files', 'sign_off_conditions', 'manage_draws', 'manage_closings', 'manage_purchasing',
    'export_data_tapes', 'waive_conditions', 'manage_conditions', 'manage_pricing', 'delete_files', 'manage_team',
    'platform_setup', 'view_audit_log']) {
    ok(!perms.defaultsFor(LOA).has(cap), `does NOT hold ${cap} (a processor's / admin's)`);
  }
  // The processor's set is deliberately DIFFERENT — "not the permissions of a processor".
  const proc = [...perms.effectivePermissions('processor', null)].sort();
  ok(!same(proc, la), 'the set is NOT the processor\'s');
  ok(proc.includes('sign_off_conditions') && !la.includes('sign_off_conditions'),
    'in particular: a processor signs off conditions, an assistant does not');

  // Still per-person adjustable from the Team screen, like every role.
  ok(perms.effectivePermissions(LOA, { see_all_files: true }).has('see_all_files'), 'an admin can grant one person more');
  ok(!perms.effectivePermissions(LOA, { pull_credit: false }).has('pull_credit'), '…or revoke one capability from one person');
  ok(perms.can({ kind: 'staff', role: LOA, perms: perms.effectivePermissions(LOA, null) }, 'review_conditions'),
    'can() answers from the resolved set');
  ok(!perms.can({ kind: 'staff', role: LOA, perms: perms.effectivePermissions(LOA, null) }, 'sign_off_conditions'),
    '…and refuses what the officer cannot do');

  // The "sees every file" roster is DERIVED from the defaults (lib/chat.js); the assistant is not in it.
  const seesAll = perms.ROLE_KEYS.filter((r) => perms.defaultsFor(r).has('see_all_files'));
  ok(!seesAll.includes(LOA), 'the assistant is not a see-every-file role — like the officer, they see the files they are on');
  ok(seesAll.includes('processor'), 'sanity: the processor (back-office persona, 2026-08-26) still is');
}

// ── C. THE FRONT-END MIRROR IS THE REGISTRY ─────────────────────────────────
console.log('\nC. THE PORTAL\'S ROLE LIST IS THE SERVER\'S, KEY FOR KEY');
{
  ok(same(INTERNAL_ROLES.map((r) => r.key), perms.ROLE_KEYS), 'same keys, same order', `${INTERNAL_ROLES.map((r) => r.key)} vs ${perms.ROLE_KEYS}`);
  ok(same(INTERNAL_ROLES.map((r) => r.label), perms.ROLES.map((r) => r.label)), 'same labels');
  ok(same(INTERNAL_ROLES.map((r) => r.persona || r.key), perms.ROLES.map((r) => r.persona || r.key)), 'same personas');
  ok(same(ROLE_LABEL, perms.ROLE_LABEL), 'ROLE_LABEL maps agree');
  for (const k of [...perms.ROLE_KEYS, 'tpo_officer', null, undefined, '', 'nobody']) {
    ok(fePersonaOf(k) === perms.personaOf(k), `personaOf agrees on ${JSON.stringify(k)}`);
  }
  ok(isLoanOfficerPersona(LOA) && isLoanOfficerPersona(LO), 'isLoanOfficerPersona is true for the officer and the assistant');
  for (const r of perms.ROLE_KEYS.filter((k) => k !== LO && k !== LOA)) {
    ok(!isLoanOfficerPersona(r), `…and false for ${r}`);
  }
  const missingView = perms.ROLE_KEYS.filter((k) => !ROLE_VIEW_NAME[k]);
  ok(missingView.length === 0, 'every internal role names its "back to my … view"', missingView.join(','));
  const extraView = Object.keys(ROLE_VIEW_NAME).filter((k) => !perms.ROLE_KEYS.includes(k));
  ok(extraView.length === 0, '…and there is no view name for a role that does not exist', extraView.join(','));
  ok(ROLE_VIEW_NAME[LOA] === 'loan officer assistant view', 'the assistant\'s way back is named in their own terms');
  ok(Object.isFrozen(INTERNAL_ROLES) && Object.isFrozen(ROLE_LABEL), 'the mirror is frozen — a screen cannot edit it');
}

// ── D. THE PERSONA REACHES THE SCREENS ──────────────────────────────────────
console.log('\nD. THE ASSISTANT GETS THE OFFICER\'S STEPS, VIEW AND BUTTONS — BY THE OFFICER\'S OWN ANSWERS');
{
  const reviewed = { status: 'received', reviewed_at: '2026-09-02' };
  const untouched = { status: 'received' };
  ok(roleDone(reviewed, LOA) === roleDone(reviewed, LO) && roleDone(reviewed, LOA) === true,
    'the officer\'s Done stamp takes the row off the ASSISTANT\'s list too');
  ok(roleDone(untouched, LOA) === false, 'an unstamped condition is still on their plate');
  ok(roleDone(reviewed, 'processor') === false, '…while the back office still has to sign it off');
  ok(matchConditionFilter(reviewed, 'mine', LOA) === matchConditionFilter(reviewed, 'mine', LO),
    'the default "mine" view answers exactly as it does for the officer');
  ok(conditionFilterLabel('mine', LOA) === 'Needs my review', 'the picker asks the assistant about their REVIEW, not a sign-off');
  ok(conditionFilterLabel('mine', LOA) === conditionFilterLabel('mine', LO), '…the officer\'s own wording');
  ok(conditionFilterHint(LOA) === conditionFilterHint(LO), 'same tooltip as the officer');
  ok(conditionFilterHint(LOA) !== conditionFilterHint('processor'), '…which is not the back office\'s');

  ok(canComplete(LOA) === false, 'the assistant may NOT complete a condition (accept / sign off / waive)');
  ok(canDeleteDoc(LOA) === true, 'the assistant may delete a wrong document on their file, as the officer may (2026-07-31)');
  const open = { id: 'c1', status: 'received' };
  for (const item of [open, { ...open, reviewed_at: 'x' }, { ...open, signed_off_at: 'x' }, { ...open, waived_at: 'x' }]) {
    ok(same(nextStep(item, { role: LOA, docs: [] }), nextStep(item, { role: LO, docs: [] })),
      `the next-step ladder answers the assistant exactly as it answers the officer (${Object.keys(item).slice(-1)})`);
  }
  ok(nextStep(open, { role: LOA, docs: [] }).key === 'done', 'their forward step is the officer\'s Done');
  ok(/loan-officer step/.test(nextStep(open, { role: LOA, docs: [] }).title), '…described as the loan-officer step');
  ok(same(docNextStep({ review_status: 'pending' }, { role: LOA }), docNextStep({ review_status: 'pending' }, { role: LO })),
    'a document row offers the assistant what it offers the officer (Reject; Accept stays the processor\'s)');
}

// ── E. NO SECOND COPY ───────────────────────────────────────────────────────
console.log('\nE. THE HAND-KEPT ROLE MAPS ARE GONE AND NO PERSONA DECISION IS SPELLED AS A RAW ROLE');
{
  const readers = [
    ['app-v2/src/components/StaffLayout.jsx', 'the sidebar'],
    ['app-v2/src/screens/StaffAuditLog.jsx', 'the audit log'],
    ['app-v2/src/screens/StaffWorkflow.jsx', 'the workflow screen'],
    ['app-v2/src/components/BorrowerViewBanner.jsx', 'the borrower-view banner'],
    ['app-v2/src/screens/StaffTeam.jsx', 'the Team screen'],
  ];
  for (const [path, what] of readers) {
    const bare = stripComments(read(path));
    ok(/from\s+['"][^'"]*lib\/roles\.js['"]/.test(bare), `${what} imports the role registry`);
    ok(!/super_admin:\s*'Super Admin'/.test(bare), `${what} no longer types out its own role labels`);
    ok(!/key:\s*'loan_officer',\s*label:/.test(bare), `${what} no longer types out its own role list`);
  }
  for (const [path, what] of [
    ['app-v2/src/lib/condition-filter.js', 'the conditions filter'],
    ['app-v2/src/lib/condition-actions.js', 'the action ladder'],
    ['app-v2/src/screens/StaffApplication.jsx', 'the file screen'],
    ['app-v2/src/components/StaffLayout.jsx', 'the sidebar'],
  ]) {
    const bare = stripComments(read(path));
    ok(!/role\s*===\s*'loan_officer'/.test(bare), `${what} asks the persona, never \`role === 'loan_officer'\``);
    ok(/isLoanOfficerPersona\(/.test(bare), `${what} calls isLoanOfficerPersona`);
  }
  // The server side: the document-delete gate and the dashboard home ask the persona too.
  const staff = stripComments(read('src/routes/staff.js'));
  ok(/personaOf\(req\.actor\.role\)\s*===\s*'loan_officer'/.test(staff), 'the document-delete gate asks the persona');
  // The staff router's front door admits EVERY registered internal role, from the
  // registry — the hand-kept copy it replaced refused a fully seated assistant
  // with `forbidden` before any file scope was consulted.
  ok(/router\.use\(requireAuth, requireRole\(\.\.\.ROLE_KEYS\)\);/.test(staff), 'the staff router admits every internal role from the registry, not a typed list');
  ok(!/requireRole\('admin', 'loan_officer'/.test(staff), '…and the typed list is gone');
  ok(/personaOf\(actor\.role\)/.test(stripComments(read('src/lib/dashboards/store.js'))), 'the dashboard home resolves by persona');
  ok(/require\('\.\.\/src\/lib\/permissions'\)\.ROLE_KEYS/.test(read('db/create-admin.js')), 'the bootstrap script reads the registry, not its own list');
}

// ── F. THE DATABASE KNOWS THE ROLE ──────────────────────────────────────────
console.log('\nF. THE DATABASE\'S ROLE LISTS ARE THE REGISTRY\'S');
{
  const file = 'db/672_loan_officer_assistant_role.sql';
  ok(existsSync(join(ROOT, file)), `${file} exists`);
  const sql = read(file);
  const inList = (constraint) => {
    const m = new RegExp(`CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(\\s*role\\s+IN\\s*\\(([\\s\\S]*?)\\)\\s*\\)`, 'i').exec(sql);
    return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null;
  };
  const staffList = inList('staff_users_role_check');
  ok(!!staffList, 'db/672 re-asserts staff_users_role_check');
  const wanted = [...perms.ROLE_KEYS, ...perms.TPO_ROLE_KEYS].sort();
  ok(staffList && same([...staffList].sort(), wanted),
    'THE ONE THAT MATTERS: the staff role CHECK is exactly the registry (internal + external), nothing more, nothing less',
    staffList && `db=${[...staffList].sort()} code=${wanted}`);
  ok(staffList && new Set(staffList).size === staffList.length, 'no value is listed twice');

  const slotList = inList('application_assignees_role_check');
  ok(!!slotList, 'db/672 re-asserts application_assignees_role_check');
  ok(slotList && slotList.includes(LOA), 'the file has a loan_officer_assistant slot');
  for (const prior of ['loan_officer', 'processor', 'closer', 'draw_coordinator', 'account_executive', 'account_manager']) {
    ok(slotList && slotList.includes(prior), `…and every earlier slot (${prior}) is still named — a narrower re-assert would roll the boot back`);
  }
  // The route's slot list (staff.js ASSIGNEE_ROLES) must be a subset of the database's.
  const m = /const ASSIGNEE_ROLES = \[([^\]]*)\]/.exec(read('src/routes/staff.js'));
  const routeSlots = m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
  ok(routeSlots.includes(LOA), 'the assignee route offers the loan_officer_assistant slot');
  const notInDb = routeSlots.filter((r) => !(slotList || []).includes(r));
  ok(notInDb.length === 0, 'every slot the route offers, the database accepts', notInDb.join(','));
  const labels = /const ASSIGNEE_ROLE_LABEL = \{([\s\S]*?)\};/.exec(read('src/routes/staff.js'));
  ok(labels && /loan_officer_assistant:\s*'a loan officer assistant'/.test(labels[1]), 'the "you were added as …" notice names the slot');

  // The processor slot is guarded by the staff role, and the assistant maps to its OWN grant bucket.
  const bare = stripComments(read('src/routes/staff.js'));
  ok(/if \(role !== 'loan_officer' && s\.rows\[0\]\.role !== role\)/.test(bare),
    'the assignee route refuses a staffer whose role is not the slot\'s role (this is what keeps an assistant out of the processor slot)');
  ok(/role='processor'`, \[processorId\]/.test(bare) || /AND role='processor'`/.test(bare),
    'the processor pointer only ever accepts role=processor');
  const admin = stripComments(read('src/routes/admin.js'));
  ok(/staffRole === 'loan_officer_assistant' \? 'loan_officer_assistant'/.test(admin),
    'an admin file-grant seats an assistant in their own slot, never the processor bucket');
}

// ── G. EVERY CREATE DOOR SEATS THE CREATING ASSISTANT ───────────────────────
console.log('\nG. A FILE AN ASSISTANT OPENS STAYS REACHABLE TO THEM');
{
  const bare = stripComments(read('src/routes/staff.js'));
  ok(/async function keepCreatorOnFile\(req, appId\)/.test(bare), 'one helper seats the creating assistant');
  const calls = (bare.match(/await keepCreatorOnFile\(req, /g) || []).length;
  ok(calls === 3, 'called from the three create doors — new file, MISMO import, lead convert', `calls=${calls}`);
  ok(/role !== 'loan_officer_assistant'\) return false/.test(bare), 'it is a no-op for every other role (officers become the officer of record; the back office sees the pipeline)');
  ok(/WHERE NOT EXISTS \(SELECT 1 FROM application_assignees/.test(bare), 'idempotent — an active row wins over a second insert');
  // An assistant is never made the officer of record by a create door.
  ok(/\['loan_officer', 'admin', 'super_admin'\]\.includes\(req\.actor\.role\)/.test(bare),
    'the new-file door still auto-assigns only loan_officer / admin / super_admin as the officer of record');
}

// ── H. THE SUITES ARE IN THE DEPLOY GATE ────────────────────────────────────
console.log('\nH. BOTH SUITES RUN');
{
  const test = JSON.parse(read('package.json')).scripts.test;
  ok(test.includes('node scripts/test-loan-officer-assistant-pure.mjs'), 'this suite is in npm test');
  ok(test.includes('node scripts/test-loan-officer-assistant-db.js'), 'the database suite is in npm test');
}

// ── I. THE OWNER'S FOLLOW-UP DECISIONS (2026-09-02) ─────────────────────────
console.log('\nI. THE WEEKLY OFFICER EMAIL, THE HETER ISKA AND THE TERM SHEET PACKAGE INCLUDE THE ASSISTANT');
{
  // "also give them the weekly officer pipeline email": the audience is DERIVED — every role
  // whose persona is the loan officer — and the book is read from both officer-persona slots.
  const digest = stripComments(read('src/lib/notification-digests.js'));
  ok(/const OFFICER_PERSONA_ROLES = perms\.ROLE_KEYS\.filter\(\(r\) => perms\.personaOf\(r\) === 'loan_officer'\);/.test(digest),
    'the weekly officer email\'s audience is derived from the registry (every loan-officer persona), not typed');
  ok(/const OFFICER_BOOK_SLOTS = \['loan_officer', 'loan_officer_assistant'\];/.test(digest),
    'an officer-persona\'s book is read from the officer slot AND the assistant slot');
  ok(/role = ANY\(\$1::text\[\]\)/.test(digest) && /aa\.role = ANY\(\$3::text\[\]\)/.test(digest),
    'both lists are bound as parameters (no second typed copy inside the SQL)');
  ok(!/role = 'loan_officer'\s*\n\s*AND COALESCE\(notifications_enabled/.test(digest),
    'the old single-role audience is gone');
  const audience = perms.ROLE_KEYS.filter((r) => perms.personaOf(r) === 'loan_officer');
  ok(same(audience, [LO, LOA]), 'today that audience is exactly loan_officer + loan_officer_assistant', audience.join(','));

  // "add a loan officer assistant to this [the Heter Iska viewer list]": judged by the staff role.
  const esign = stripComments(read('src/lib/esign/orchestrate.js'));
  ok(/iskaOnly \? `AND su\.role IN \('loan_officer','loan_officer_assistant','processor'\)` : ''/.test(esign),
    'the Heter Iska viewer list is loan officer + loan officer assistant + processor');
  // "…and also add them to the term sheet package as well": the term sheet copies every
  // active assignee (no role filter when the purpose is not the ISKA), so an assistant seated
  // on the file is a viewer there by construction — pinned over a real envelope in
  // scripts/test-esign-cc-viewers.js.
  const cc = read('scripts/test-esign-cc-viewers.js');
  ok(/tcc3\.includes\(`la\+\$\{TAG\}@ys\.com`\)/.test(cc), 'the viewer suite asserts the assistant is copied on the term sheet package');
  ok(/iskaCc\.includes\(`la\+\$\{TAG\}@ys\.com`\)/.test(cc), '…and on the Heter Iska');

  // The whole-team notification fan-out scopes each ASSIGNEE SLOT to "their part" (lib/notify.js
  // STAFF_ROLE_CATEGORIES) and its own suite (test-notify-role-scope-db) fails the build when a
  // slot the assignees door accepts has no explicit entry — CI caught exactly that on the first
  // push. The assistant's slot sees the WHOLE file, as the officer's does: same persona.
  const notifySrc = stripComments(read('src/lib/notify.js'));
  const map = /const STAFF_ROLE_CATEGORIES = \{([\s\S]*?)\};/.exec(notifySrc);
  ok(!!map && /loan_officer_assistant:\s*'\*'/.test(map[1]),
    'the notification visibility map gives the assistant slot the whole file (\'*\'), like the officer\'s');
  ok(!!map && /loan_officer:\s*'\*'/.test(map[1]), '…which is what the officer\'s slot has');
}

console.log(`\n${failures ? `${failures} FAILED` : 'ok — test-loan-officer-assistant-pure'}`);
process.exit(failures ? 1 : 0);

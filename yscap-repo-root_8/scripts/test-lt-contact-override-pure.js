'use strict';
/**
 * LT test — reassigning a long-term file locally. THE POLICY, with no database.
 *
 * The DB suite proves the write. This proves the two decisions that must be right
 * before a write is ever reached, and both are security properties rather than
 * conveniences:
 *
 *   · **WHO may reassign.** The pipeline scope matches `override_staff_id`, so
 *     setting an override GRANTS somebody access to a file and clearing one TAKES it
 *     away. If a scoped officer could set their own, they could read any file in the
 *     book by naming themselves on it. The nastiest version is the one asserted at
 *     length below: the long-term ROLE OVERRIDE is a settings value, so if the gate
 *     read it, a settings typo would become a route to granting yourself files.
 *   · **WHAT a request must carry.** An override is stamped "who, when and why" by
 *     design — the why is what the next person reads when the file does not match
 *     Encompass — so setting one demands a reason and clearing one does not.
 *
 * Everything here is a pure function. No Postgres, no Encompass, no HTTP.
 */

const path = require('path');
const fs = require('fs');

const access = require('../src/longterm/access');
const contacts = require('../src/longterm/people/contacts');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const staffOf = (role, id = 'staff-1') => ({ id, role });

// ── Who may reassign ────────────────────────────────────────────────────────
console.log('who may reassign a file');

check(access.mayReassignLoan(staffOf('super_admin')) === true,
  'a super admin may reassign');
check(access.mayReassignLoan(staffOf('admin')) === true,
  'an administrator may reassign');
check(access.mayReassignLoan(staffOf('loan_officer')) === false,
  'a loan officer may NOT — an override grants file access, so setting your own would be reading the book by naming yourself on it');
check(access.mayReassignLoan(staffOf('processor')) === false,
  'a processor may not');

// The owner's own rule is that a closer and a funder see EVERY file. Seeing the
// whole book is not the same authority as deciding whose book it is.
check(access.mayReassignLoan(staffOf('closer')) === false,
  'a CLOSER sees every file and still may not reassign one — seeing all is not administering');
check(access.mayReassignLoan(staffOf('funder')) === false,
  'nor a funder, for the same reason');
check(access.mayReassignLoan(staffOf('underwriter')) === false,
  'nor an underwriter');

check(access.mayReassignLoan(null) === false, 'nobody at all may not');
check(access.mayReassignLoan({}) === false, 'an actor with no role may not');
check(access.mayReassignLoan(staffOf('')) === false, 'an empty role may not');

// ── It is settings-driven, and the floor holds ──────────────────────────────
console.log('\nthe roles are configurable, and the top authority keeps the key');

check(access.mayReassignLoan(staffOf('loan_coordinator'), { 'access.adminRoles': ['admin', 'loan_coordinator'] }) === true,
  'a buyer who names another role in access.adminRoles gives it the authority');
check(access.mayReassignLoan(staffOf('admin'), { 'access.adminRoles': ['loan_officer'] }) === false,
  '…and a buyer who removes admin removes it');
check(access.mayReassignLoan(staffOf('super_admin'), { 'access.adminRoles': ['loan_officer'] }) === true,
  'a super admin may reassign WHATEVER the setting says — the same floor that stops the settings screen locking itself away');
check(access.mayReassignLoan(staffOf('admin'), { 'access.adminRoles': 'not-a-list' }) === true,
  'a junk setting falls back to our default rather than to nobody — and never to everybody');
check(access.mayReassignLoan(staffOf('loan_officer'), { 'access.adminRoles': 'not-a-list' }) === false,
  '…which still refuses an officer');

// ── The privilege-escalation guard ──────────────────────────────────────────
console.log('\na long-term role override can never grant this');

// `access.roleOverrides` exists so somebody whose RTL role is loan_coordinator can be
// recognised as the long-term FUNDER without touching an RTL table. It is a SETTINGS
// value. If this gate read it, an administrator's typo — or anybody who could edit
// that one setting — would be handing out the right to grant yourself any file in
// the book. It must read the person's REAL role and nothing else.
const escalation = {
  'access.roleOverrides': { 'staff-1': 'admin', 'staff-2': 'super_admin' },
};
check(access.mayReassignLoan(staffOf('loan_officer', 'staff-1'), escalation) === false,
  'an officer whose long-term role override says "admin" still may NOT reassign');
check(access.mayReassignLoan(staffOf('loan_officer', 'staff-2'), escalation) === false,
  '…nor one whose override says "super_admin"');
check(access.longTermRoleFor(staffOf('loan_officer', 'staff-1'), escalation) === 'admin',
  '…even though the override genuinely IS in force for the long-term role itself, which is what makes this a real hole and not a hypothetical one');

// And the one definition rule: this must DELEGATE to the people-map gate, not
// restate it, or the two drift and a buyer's narrowing means different things.
check(access.mayReassignLoan(staffOf('loan_coordinator'), { 'access.adminRoles': ['loan_coordinator'] })
  === access.mayManagePeople(staffOf('loan_coordinator'), { 'access.adminRoles': ['loan_coordinator'] }),
  'it answers exactly what mayManagePeople answers — one rule wearing two hats, not two rules');

// ── What a request must carry ───────────────────────────────────────────────
console.log('\nwhat a reassignment has to say');

const ok = (req) => contacts.reassignProblem(req) === null;
const why = (req) => {
  const p = contacts.reassignProblem(req);
  return p ? p.plain : null;
};

check(ok({ role: 'loan_officer', staffId: 'a', reason: 'Sarah took this over in March' }),
  'naming a person with a reason is accepted');

check(!ok({ role: '', staffId: 'a', reason: 'because' }), 'a request naming no role is refused');
check(!ok({ staffId: 'a', reason: 'because' }), '…including one that omits it entirely');
check(/which role/i.test(why({ role: '', staffId: 'a', reason: 'because' }) || ''),
  '…and says which thing was missing, rather than answering a bare 400');
check(contacts.reassignProblem({ role: '', staffId: 'a' }).status === 400,
  'a malformed request is a 400, not a 500');

check(!ok({ role: 'loan_officer', staffId: 'a' }),
  'naming a person with NO reason is refused — an override is stamped with its why, and an unexplained one is the silent divergence the rule exists to prevent');
check(!ok({ role: 'loan_officer', staffId: 'a', reason: '   ' }),
  '…and a few spaces is not a reason');
check(!ok({ role: 'loan_officer', staffId: 'a', reason: 'ok' }),
  '…nor is a couple of characters');
check(/why/i.test(why({ role: 'loan_officer', staffId: 'a' }) || ''),
  '…and the refusal asks for the one thing it wants, in plain words');
check(!/\b(400|null|uuid|column)\b/i.test(why({ role: 'loan_officer', staffId: 'a' }) || ''),
  '…in language for a person, not a developer');

// ── Clearing is a different request ─────────────────────────────────────────
console.log('\nundoing a reassignment asks for nothing');

check(ok({ role: 'loan_officer', staffId: null }),
  'clearing needs no person and no reason — it is how "actually, Encompass was right" is said');
check(ok({ role: 'loan_officer', staffId: '' }), '…an empty person reads as a clear, never as missing');
check(ok({ role: 'loan_officer' }), '…as does omitting it');
check(ok({ role: 'loan_officer', staffId: '   ' }), '…and whitespace is not somebody');
check(ok({ role: 'loan_officer', staffId: null, reason: '' }),
  'demanding an explanation to undo a mistake is how a wrong override survives, so none is asked for');

// ── Source guards ───────────────────────────────────────────────────────────
console.log('\nwhat this code may not do');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/**
 * COMMENTS ARE STRIPPED BEFORE ANY "must not appear" ASSERTION, and that is not a
 * detail. Code that deliberately does NOT do something necessarily NAMES the thing
 * it does not do, in a comment, so the next person knows the omission was a decision
 * — this file's own `reassign` explains in as many words why it writes no
 * `audit_log` row. A guard that read comments would fail on the very explanation it
 * exists to protect, and the obvious way to "fix" it would be to delete the
 * explanation. So the guards read the code.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

const contactsSrc = stripComments(read('src/longterm/people/contacts.js'));
const routeSrc = stripComments(read('src/longterm/routes/pipeline.js'));

// Encompass is one-way, and this is the feature most likely to be "improved" into a
// write-back, because reassigning a file is exactly the moment somebody thinks the
// system of record should be corrected too.
const reassignBody = contactsSrc.slice(contactsSrc.indexOf('async function reassign('));
check(!/lazy\.client|encompassClient|fieldWriter|\.post\(/.test(reassignBody),
  'reassigning never calls Encompass — the override is a PILOT-side routing decision, never a correction to the system of record');
check(!/audit_log/.test(contactsSrc),
  'nothing here writes audit_log — that is an RTL table, and the override columns are this feature\'s own record');

// The write must be gated, and the gate must be the real one.
check(/router\.post\([^)]*contacts\/:role\/override/.test(routeSrc),
  'the reassignment has an HTTP door');
const routeBody = routeSrc.slice(routeSrc.indexOf("router.post('/:loanId/contacts/:role/override'"));
check(/mayReassignLoan/.test(routeBody) && /403/.test(routeBody),
  '…and it refuses anybody the gate does not admit, on the write itself rather than only on the screen');
check(routeBody.indexOf('mayReassignLoan') < routeBody.indexOf('contacts.reassign'),
  '…checked BEFORE anything is written, not after');

// The sync must never undo a local decision.
const upsert = contactsSrc.slice(contactsSrc.indexOf('async function writeContacts'), contactsSrc.indexOf('async function confirmedLinkMap'));
check(!/override_staff_id|override_by|override_at|override_reason/.test(upsert),
  'the sync\'s upsert names no override column, so refreshing what Encompass says can never undo a reassignment');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

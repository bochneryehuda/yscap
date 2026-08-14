#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM — the people map, pure (no DB, no Encompass).
 *
 * The owner chose "auto-match by email, admin confirms", so the thing worth testing
 * is not that the matcher matches — it is that it REFUSES. A missed match costs an
 * admin one click; a wrong match hands somebody another officer's whole book, on a
 * screen that will never mention it.
 *
 * So every finding the live probe made about this tenant's roster is a case here:
 * the shared placeholder 10 users carry, the inconsistent casing, the two real
 * people on one mailbox family, and the fullName field that is too dirty to key on.
 *
 * Mutations proven to fail this file: matching on the placeholder address; letting
 * a two-candidate address pick the first; re-proposing a rejected link; proposing a
 * staff member who is already confirmed elsewhere; keying on fullName; letting a
 * long-term role override grant admin rights.
 */

const match = require('../src/longterm/people/match');
const roster = require('../src/longterm/people/roster');
const contacts = require('../src/longterm/people/contacts');
const access = require('../src/longterm/access');
const decl = require('../src/longterm/settings/encompass-settings');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const sug = (out, loginId) => out.suggestions.find((s) => s.loginId === loginId) || null;
const un = (out, loginId) => out.unmatched.find((u) => u.loginId === loginId) || null;

// ── The match, and every refusal ────────────────────────────────────────────
console.log('match — propose, and refuse when unsure');

// `full_name` is ONE column on staff_users (it is the BORROWERS table that splits a
// person into first/middle/last), so the fixtures carry the real shape. One row
// deliberately uses first/last to pin `staffName`'s tolerance for a mapped object.
const STAFF = [
  { id: 'u-sweiss', email: 'sweiss@yscapgroup.com', is_active: true, full_name: 'Shea Weiss', role: 'loan_officer' },
  { id: 'u-malky', email: 'malky@yscapgroup.com', is_active: true, full_name: 'Malky Katz', role: 'closer' },
  { id: 'u-ezra', email: 'ezra@yscapgroup.com', is_active: true, full_name: 'Ezra Klein', role: 'processor' },
  { id: 'u-pinny', email: 'ezra@yscapgroup.com', is_active: true, full_name: 'Pinny Grunberger', role: 'processor' },
  { id: 'u-gone', email: 'gone@yscapgroup.com', is_active: false, first_name: 'Departed', last_name: 'Person', role: 'processor' },
];

const ENC = [
  { login_id: 'sweiss', email: 'SWeiss@yscapgroup.com', full_name: 'Shea  Weiss ', is_active: true },
  { login_id: 'mkatz', email: 'malky@yscapgroup.com', full_name: 'Malky  Katz', is_active: true },
  { login_id: 'ezra', email: 'ezra@yscapgroup.com', full_name: 'Ezra Klein', is_active: true },
  { login_id: 'officer', email: 'change.me@email.com', full_name: 'Z-Test Officer', is_active: true },
  { login_id: 'closer', email: 'change.me@email.com', full_name: 'Z-Test Closer', is_active: true },
  { login_id: 'nobody', email: '', full_name: 'No Address', is_active: true },
  { login_id: 'stranger', email: 'someone@elsewhere.com', full_name: 'Not In PILOT', is_active: true },
  { login_id: 'oldhand', email: 'gone@yscapgroup.com', full_name: 'Departed Person', is_active: false },
];

const out = match.matchRoster(ENC, STAFF);

check(sug(out, 'sweiss') && sug(out, 'sweiss').staffId === 'u-sweiss',
  'a clean email match is proposed — and survives the tenant\'s inconsistent casing');
check(sug(out, 'mkatz') && sug(out, 'mkatz').staffId === 'u-malky',
  'the login id and the email need not resemble each other ("mkatz" -> malky@)');

// THE ONE THAT MATTERS MOST: ten users share this address on the live tenant.
check(!sug(out, 'officer') && !sug(out, 'closer'),
  'the shared placeholder address proposes NOBODY — ten users carry it on this tenant');
check(un(out, 'officer').reason === match.NO_MATCH.PLACEHOLDER
   && un(out, 'closer').reason === match.NO_MATCH.PLACEHOLDER,
  '…and each says WHY, in words an admin can act on');

check(!sug(out, 'ezra') && un(out, 'ezra').reason === match.NO_MATCH.AMBIGUOUS_STAFF,
  'two PILOT people on one address proposes NEITHER — the live tenant really has this pair');
check(!sug(out, 'nobody') && un(out, 'nobody').reason === match.NO_MATCH.NO_EMAIL,
  'an Encompass user with no address is left for a human, not guessed at by name');
check(!sug(out, 'stranger') && un(out, 'stranger').reason === match.NO_MATCH.NOT_FOUND,
  'an address no PILOT person uses is simply unmatched');
check(!sug(out, 'oldhand') && un(out, 'oldhand').reason === match.NO_MATCH.STAFF_INACTIVE,
  'a deactivated PILOT person is never proposed');

check(out.suggestions.length + out.unmatched.length === ENC.length,
  'every Encompass user lands in exactly one of the two lists — the screen can account for the whole roster');

// Two Encompass logins on one real address: neither may be proposed, because we
// cannot tell which of them the PILOT person is.
const TWO_ENC = [
  { login_id: 'a1', email: 'shared@yscapgroup.com', full_name: 'One', is_active: true },
  { login_id: 'a2', email: 'shared@yscapgroup.com', full_name: 'Two', is_active: true },
];
const twoOut = match.matchRoster(TWO_ENC, [{ id: 'u-1', email: 'shared@yscapgroup.com', is_active: true }]);
check(twoOut.suggestions.length === 0
   && un(twoOut, 'a1').reason === match.NO_MATCH.AMBIGUOUS_ENCOMPASS,
  'two ENCOMPASS logins on one address proposes neither');

// A decision a human made is never re-litigated.
const decided = match.matchRoster(ENC, STAFF, {
  existing: [
    { encompass_login_id: 'sweiss', staff_id: 'u-sweiss', status: 'confirmed' },
    { encompass_login_id: 'mkatz', staff_id: null, status: 'rejected' },
  ],
});
check(!sug(decided, 'sweiss') && un(decided, 'sweiss').decided === 'confirmed',
  'a CONFIRMED link is left alone by the next sync');
check(!sug(decided, 'mkatz') && un(decided, 'mkatz').decided === 'rejected',
  'a REJECTED link is never proposed again — a suggestion that keeps coming back is noise');

// One person, one login.
const taken = match.matchRoster(
  [{ login_id: 'sweiss2', email: 'sweiss@yscapgroup.com', full_name: 'Shea Weiss', is_active: true }],
  STAFF,
  { existing: [{ encompass_login_id: 'sweiss', staff_id: 'u-sweiss', status: 'confirmed' }] },
);
check(taken.suggestions.length === 0 && un(taken, 'sweiss2').reason === match.NO_MATCH.STAFF_TAKEN,
  'a person already confirmed elsewhere is not proposed again — a proposal nobody can accept is a dead end');

// A suggestion is still only ever a suggestion.
check(out.suggestions.every((s) => s.method === 'email'),
  'every proposal records HOW it was made, so a screen can say "matched by email"');

// The placeholder list is a SETTING, because the next lender's placeholder differs.
check(match.isPlaceholderEmail('nobody@example.test', { 'contacts.placeholderEmails': ['nobody@example.test'] }),
  'the placeholder list is settings-driven');
check(!match.isPlaceholderEmail('change.me@email.com', { 'contacts.placeholderEmails': ['other@x.com'] }),
  '…and a lender who replaces it is not stuck with ours');

// ── The name is a hint, never a key ─────────────────────────────────────────
console.log('\nnames — shown, never keyed on');

check(match.nameLooksLike('Malky  Katz ', 'malky katz'),
  'the name hint survives the double and trailing spaces Encompass really sends');
check(match.nameLooksLike('KAMARA PATRICK', 'Patrick Kamara'),
  '…and a reversed name, because vendors send those too');
const nameOnly = match.matchRoster(
  [{ login_id: 'x1', email: 'x@nowhere.test', full_name: 'Malky Katz', is_active: true }],
  STAFF,
);
check(nameOnly.suggestions.length === 0,
  'a PERFECT name match with no email match proposes NOTHING — the probe found stale names pointing at the wrong human');
check(sug(out, 'mkatz').nameAgrees === true,
  'the name agreement rides along on a proposal as a hint for the admin');

// ── The roster reader ───────────────────────────────────────────────────────
console.log('\nroster — reading Encompass\'s own shape');

const row = roster.toRosterRow({
  id: 'sweiss', fullName: 'Shea  Weiss ', email: 'SWeiss@YSCapGroup.com',
  personas: [{ entityId: '7', entityName: 'Loan Coordinator' }, { entityName: 'Loan Processor' }],
  userIndicators: ['Enabled', 'TopLevelUser'],
});
check(row.login_id === 'sweiss', 'the login id is the join key, taken from Encompass\'s `id`');
check(row.full_name === 'Shea Weiss', 'the double and trailing spaces are squashed on the way in');
check(row.email === 'sweiss@yscapgroup.com', 'the email is normalised once, at the door');
check(row.personas.join(',') === 'Loan Coordinator,Loan Processor', 'personas are read as names');
check(row.is_active === true, '`Enabled` reads as an active login');
check(roster.toRosterRow({ id: 'x', userIndicators: ['TopLevelUser'] }).is_active === false,
  'a real indicator list WITHOUT `Enabled` reads as a disabled login — that is the actual signal');
check(roster.toRosterRow({ id: 'x' }).is_active === true
   && roster.toRosterRow({ id: 'x', userIndicators: [] }).is_active === true,
  'a payload with no indicators — absent OR empty — reads as ACTIVE: a field we cannot read must never deactivate the company');
check(roster.toRosterRow({ fullName: 'No Id' }) === null,
  'a user with no login id is dropped, not stored under an empty key');

check(roster.USERS_PATH === '/encompass/v1/company/users',
  'the roster is read from the v1 path the probe proved works (v3 answers 403)');

// ── Who may change the map ──────────────────────────────────────────────────
console.log('\naccess — who may confirm a link');

check(access.mayManagePeople({ id: 's1', role: 'admin' }) === true
   && access.mayManagePeople({ id: 's1', role: 'super_admin' }) === true,
  'an admin and a super-admin may confirm who somebody is');
check(access.mayManagePeople({ id: 's1', role: 'closer' }) === false
   && access.mayManagePeople({ id: 's1', role: 'funder' }) === false,
  'a closer and a funder see every file but may NOT decide whose book is whose');
check(access.mayManagePeople({ id: 's1', role: 'loan_officer' }) === false
   && access.mayManagePeople({ id: 's1', role: '' }) === false
   && access.mayManagePeople(null) === false,
  'everybody else — and a blank or missing role — is refused');
check(access.mayManagePeople({ id: 's1', role: 'processor' },
  { 'access.roleOverrides': { s1: 'admin' } }) === false,
  'a long-term role OVERRIDE cannot grant admin rights — a settings typo is not a privilege escalation');
check(access.mayManagePeople({ id: 's1', role: 'processor' },
  { 'access.adminRoles': ['processor'] }) === true,
  'the admin-role list is settings-driven, so a buyer\'s org chart is not ours');
check(access.mayManagePeople({ id: 's1', role: 'admin' }, { 'access.adminRoles': 'nonsense' }) === true,
  'an unreadable setting falls back to OUR default rather than to nobody or everybody');

// ── Settings declarations ───────────────────────────────────────────────────
console.log('\nsettings — the new key is declared');

check(decl.definition('access.adminRoles') !== null, '"access.adminRoles" is declared');
check(JSON.stringify(decl.defaults()['access.adminRoles']) === JSON.stringify(access.DEFAULT_ADMIN_ROLES),
  'the declared admin-role list matches access.js exactly');
check(decl.defaults()['conditions.enabled'] === false,
  'the Condition Center is OFF — set aside by the owner on 2026-08-14, and a setting rather than a comment');

// ── The loan team ───────────────────────────────────────────────────────────
console.log('\ncontacts — who is on this loan');

const ids = contacts.fieldIdsFor();
check(ids.includes('LoanTeamMember.UserId.Loan Coordinator'),
  "the loan-officer slot is read as the tenant's REAL role name, \"Loan Coordinator\"");
check(!ids.some((i) => i.startsWith('LoanTeamMember.Id.')),
  'it is UserId, never Id — `LoanTeamMember.Id.<role>` is an invalid field id');
check(new Set(ids).size === ids.length,
  'the field-id list is DEDUPLICATED — a duplicate answers 400 and loses the WHOLE batch');
check(ids.length === contacts.DEFAULT_ROLES.length * contacts.PARTS.length,
  'four parts are read for every tracked role');

// Two of our roles pointed at one Encompass role is a plausible settings state, and
// would otherwise post a duplicate id and lose every role on the loan.
const collided = contacts.fieldIdsFor({
  'contacts.roles': ['closer', 'funder'],
  'contacts.encompassRoleNames': { closer: 'Closer', funder: 'Closer' },
});
check(new Set(collided).size === collided.length && collided.length === 4,
  'two roles sharing one Encompass name still produce a unique id list');

// A role with no Encompass name cannot be read, and an id built from `undefined`
// would reject the batch for every other role too.
const missingName = contacts.fieldIdsFor({
  'contacts.roles': ['closer', 'wizard'],
  'contacts.encompassRoleNames': { closer: 'Closer' },
});
check(missingName.length === 4 && !missingName.some((i) => i.includes('undefined')),
  'a role with no Encompass name is DROPPED, never asked for as `undefined`');

// The real payload shape, from the live probe.
const VALUES = {
  'LoanTeamMember.Name.Loan Coordinator': 'Solomon Weiss',
  'LoanTeamMember.UserId.Loan Coordinator': 'sweiss',
  'LoanTeamMember.Email.Loan Coordinator': 'Sol@yscapgroup.com',
  'LoanTeamMember.Phone.Loan Coordinator': '718-635-0277',
  'LoanTeamMember.Name.Closer': 'Malky  Katz',
  'LoanTeamMember.UserId.Closer': 'mkatz',
  'LoanTeamMember.Name.Underwriter': '',
  'LoanTeamMember.UserId.Underwriter': '',
};
const team = contacts.contactsFromFields(VALUES);
const byRole = (r) => team.find((c) => c.role === r) || null;

check(byRole('loan_officer') && byRole('loan_officer').loginId === 'sweiss',
  'the loan officer is read off the Loan Coordinator slot');
check(byRole('loan_officer').email === 'sol@yscapgroup.com',
  'the email is normalised once, at the door');
check(byRole('closer') && byRole('closer').name === 'Malky Katz',
  "the tenant's double spaces are squashed on the way in");
check(!byRole('underwriter'),
  'a slot Encompass leaves EMPTY is omitted, never stored as an empty contact that reads as assigned');
check(!byRole('processor'),
  'a role the payload does not mention at all is omitted too');

// Attribution: only a CONFIRMED link decides whose file this is.
const attributed = contacts.attribute(team, new Map([['sweiss', 'u-sweiss']]));
check(attributed.find((c) => c.role === 'loan_officer').staffId === 'u-sweiss',
  'a CONFIRMED link attributes the file to that PILOT person');
check(attributed.find((c) => c.role === 'closer').staffId === null,
  'an unlinked login attributes to NOBODY — a suggestion may never decide whose pipeline a file lands in');
check(attributed.find((c) => c.role === 'closer').name === 'Malky Katz',
  '…and still displays by name, so the file is never blank about who is on it');

// What the screen says.
const shown = contacts.describeContact(
  { role: 'loan_officer', encompass_name: 'Solomon Weiss', encompass_login_id: 'sweiss', staff_id: 'u-1' },
  { staffName: 'Solomon Weiss', labels: { loan_officer: 'Loan officer' } },
);
check(shown.effectiveStaffId === 'u-1' && shown.overridden === false && shown.note === null,
  'an ordinary contact reads plainly');

const overridden = contacts.describeContact(
  { role: 'loan_officer', encompass_name: 'Solomon Weiss', encompass_login_id: 'sweiss', staff_id: 'u-1', override_staff_id: 'u-2' },
  { staffName: 'Solomon Weiss', overrideName: 'Someone Else' },
);
check(overridden.effectiveStaffId === 'u-2' && overridden.overridden === true,
  'a local override decides who the file actually belongs to');
check(/nothing was written back/i.test(overridden.note),
  '…and the screen SAYS the file disagrees with Encompass on purpose — Encompass is one-way');

const unlinkedShown = contacts.describeContact(
  { role: 'closer', encompass_name: 'Malky Katz', encompass_login_id: 'mkatz', staff_id: null },
);
check(/not linked to a PILOT person yet/i.test(unlinkedShown.note),
  'an unlinked contact explains why the file is in nobody\'s pipeline');

// ── The product switch ──────────────────────────────────────────────────────
console.log('\nthe product switch');

check(decl.definition('ui.defaultProduct') !== null, '"ui.defaultProduct" is declared');
check(decl.defaults()['ui.defaultProduct'] === 'rtl',
  'the default side is RTL — Long-Term is a side build that is not live, so nobody is moved to it by a deploy');
const productDecl = decl.definition('ui.defaultProduct');
check(Array.isArray(productDecl.options) && productDecl.options.join(',') === 'rtl,long_term',
  'the two sides are an enum, so a typo can never park somebody on a side that does not exist');

// The store rule the per-user scope depends on. A value equal to the declared
// default is normally DELETED (the company scope must hold only real deviations);
// `keepDefault` is what makes a person's explicit choice survive.
const store = require('../src/longterm/settings/store');
check(store.validate({ 'ui.defaultProduct': 'long_term' }).ok,
  'the switch value passes validation');
check(!store.validate({ 'ui.defaultSide': 'long_term' }).ok,
  'a misspelled key is REFUSED — the declaration list is the whitelist');
check(store.save.length >= 1 && /keepDefault/.test(store.save.toString()),
  'the store honours keepDefault, which is what stops a per-user choice being deleted for matching the default');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

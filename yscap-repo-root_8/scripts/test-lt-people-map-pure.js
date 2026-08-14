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

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

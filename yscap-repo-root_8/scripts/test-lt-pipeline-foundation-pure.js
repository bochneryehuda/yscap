#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM — the pipeline foundation, pure (no DB, no network).
 *
 * Covers the three decisions the owner made on 2026-08-14 and the traps the live
 * probe found, because each one is a place where a wrong answer is SILENT:
 *
 *   · stages   — the three layers. The borrower's label must come from the
 *                milestone, never from our stage, and an unmapped milestone must
 *                be SHOWN rather than lost.
 *   · access   — closer and funder see everything, officer and processor their
 *                own, and anything unmapped fails CLOSED to "own".
 *   · settings — the new keys are declared (an undeclared key is refused by the
 *                store, so a missing declaration silently disables a feature) and
 *                the Encompass role names carry the tenant's real spellings.
 *
 * Mutations proven to fail this file: flipping the unmapped-milestone fallback to
 * `null`; defaulting an unknown role to `all`; honouring a bogus role override;
 * hard-coding `$1` in the scope SQL; deriving the borrower's label from our stage.
 */

const stages = require('../src/longterm/stages');
const access = require('../src/longterm/access');
const decl = require('../src/longterm/settings/encompass-settings');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

// ── Stages ──────────────────────────────────────────────────────────────────
console.log('stages — the three layers');

check(stages.stageForMilestone('Waiting for Docs').key === 'conditions_out',
  'Waiting for Docs maps to Conditions Out');
check(stages.stageForMilestone('Clear To Close').key === 'clear_to_close',
  'Clear To Close maps to its own stage');
check(stages.stageForMilestone('Funding').key === 'funded',
  'Funding maps to Funded');
check(stages.stageForMilestone('Investor Delivery').key === 'post_closing'
   && stages.stageForMilestone('Completion').key === 'post_closing',
  'the five post-funding milestones collapse into Post-Closing');

// Every one of the tenant's 19 milestones must map. An unmapped one is not a
// crash, it is a loan quietly sitting in "Other" forever.
const NINETEEN = [
  'Started', 'LO Prep', 'Loan Setup', 'Submittal', 'Cond. Approval', 'Processing',
  'Waiting for Docs', 'Resubmittal', 'Clear To Close', 'Schedule Closing',
  'Ready for Docs', 'Docs Out', 'Wire Order', 'Funding', 'Investor Delivery',
  'Purchasing Conditions', 'Final Docs', 'Closed', 'Completion',
];
const unmapped = NINETEEN.filter((m) => !stages.stageForMilestone(m).mapped);
check(unmapped.length === 0,
  `all 19 tenant milestones map to a stage${unmapped.length ? ` (unmapped: ${unmapped.join(', ')})` : ''}`);

// THE ONE THAT MATTERS MOST: an unknown milestone is shown, never dropped.
const novel = stages.stageForMilestone('Some Milestone Encompass Added Tomorrow');
check(novel && novel.key === 'other' && novel.mapped === false,
  'an UNMAPPED milestone falls into a visible "Other" bucket, flagged as unmapped');
check(novel.label && String(novel.label).length > 0,
  'the unmapped bucket has a label, so it can be rendered');

// Normalisation — Encompass names carry stray whitespace and inconsistent casing.
check(stages.stageForMilestone('  clear to close  ').key === 'clear_to_close',
  'milestone lookup survives casing and stray whitespace');
check(stages.stageForMilestone(null).mapped === false
   && stages.stageForMilestone(undefined).mapped === false
   && stages.stageForMilestone('').mapped === false,
  'a null/undefined/empty milestone is unmapped rather than throwing');

// Layer 3 — the borrower's wording comes from the MILESTONE, never from our stage.
check(stages.consumerStatusOf({ consumer_status: 'Final Approval' }) === 'Final Approval',
  "the borrower's label reads the milestone's own consumer_status (snake_case)");
check(stages.consumerStatusOf({ consumerStatus: 'Funded' }) === 'Funded',
  "…and camelCase, because it is read from both a DB row and a mapped object");
check(stages.consumerStatusOf({ consumer_status: '   ' }) === null
   && stages.consumerStatusOf(null) === null
   && stages.consumerStatusOf({}) === null,
  'with nothing to read it returns null — a borrower is never shown an invented status');
check(!Object.prototype.hasOwnProperty.call(stages.stageForMilestone('Funding'), 'consumerStatus'),
  'our stage object carries NO consumer wording — the two layers cannot be confused');

// The map must only ever name stages that exist.
const stageKeys = new Set(stages.DEFAULT_STAGES.map((s) => s.key));
const danglingTargets = Object.entries(stages.DEFAULT_MAP)
  .filter(([, k]) => !stageKeys.has(k)).map(([m, k]) => `${m}->${k}`);
check(danglingTargets.length === 0,
  `every milestone maps to a stage that exists${danglingTargets.length ? ` (dangling: ${danglingTargets.join(', ')})` : ''}`);

// A map pointing at a stage the stage list does not carry is a misconfiguration,
// not a reason to lose the loan.
const bad = stages.stageForMilestone('Funding', { map: { Funding: 'no_such_stage' } });
check(bad.key === 'other' && bad.mapped === false,
  'a map naming a non-existent stage degrades to "Other" instead of returning nothing');

// ── Access ──────────────────────────────────────────────────────────────────
console.log('\naccess — who sees which files');

const scopeOf = (role, settings) => access.accessFor({ id: 's1', role }, settings).scope;

check(scopeOf('admin') === 'all' && scopeOf('super_admin') === 'all',
  'admin and super-admin see the entire pipeline');
check(scopeOf('closer') === 'all',
  'the CLOSER sees the entire pipeline — including files not yet assigned');
check(scopeOf('funder') === 'all',
  'the FUNDER sees the entire pipeline — including files not yet assigned');
check(scopeOf('loan_officer') === 'own',
  'a loan officer sees only their own files');
check(scopeOf('processor') === 'own',
  'a processor sees only their own files');

// FAIL CLOSED. This is the assertion that matters: an unmapped role must never
// inherit the whole book.
check(scopeOf('draw_coordinator') === 'own'
   && scopeOf('software_setup') === 'own'
   && scopeOf('') === 'own'
   && scopeOf(undefined) === 'own',
  'an unmapped, blank or missing role fails CLOSED to "own", never to "all"');

// The funder case the whole override mechanism exists for: staff_users.role has
// no `funder` value, so a funder is recognised without touching an RTL table.
check(access.accessFor({ id: 's1', role: 'loan_coordinator' },
  { 'access.roleOverrides': { s1: 'funder' } }).scope === 'all',
  'a long-term role OVERRIDE recognises a funder whose PILOT role has no such word');
check(access.accessFor({ id: 's1', role: 'processor' },
  { 'access.roleOverrides': { s1: 'wizard' } }).scope === 'own',
  'an override naming an unknown role is IGNORED — a settings typo cannot grant scope');
check(access.accessFor({ id: 's1', role: 'processor' },
  { 'access.roleOverrides': { someoneElse: 'admin' } }).scope === 'own',
  "another person's override does not apply to this person");

// The map is a setting, so a buyer can change it.
check(access.accessFor({ id: 's1', role: 'processor' },
  { 'access.roleScopes': { processor: 'all' } }).scope === 'all',
  'the role→scope map is settings-driven, so a buyer changes it without a migration');
check(access.accessFor({ id: 's1', role: 'closer' },
  { 'access.roleScopes': { closer: 'own' } }).scope === 'own',
  '…in both directions');

// The scope SQL must be a FUNCTION of its placeholder index. RTL hit a live
// Postgres 42P18 from hard-coding $1 and then dropping the clause for see-all.
const sql3 = access.pipelineScopeSql({ seesAll: false }, 'uuid-here', 3);
check(sql3.where.includes('$3') && !sql3.where.includes('$1'),
  'the scope SQL honours the caller\'s placeholder index (no hard-coded $1)');
check(sql3.params.length === 1,
  'the scope SQL binds exactly one parameter');
check(sql3.where.includes('override_staff_id'),
  'the scope honours a PILOT-side override as well as the Encompass assignment');
const sqlAll = access.pipelineScopeSql({ seesAll: true }, 'uuid-here', 1);
check(sqlAll.where === '' && sqlAll.params.length === 0,
  'a sees-all caller gets NO clause and NO unreferenced parameter');

check(access.mayOpenLoan({ seesAll: false }, 'me', [{ staff_id: 'me' }]) === true,
  'a direct link opens for the assigned person');
check(access.mayOpenLoan({ seesAll: false }, 'me', [{ override_staff_id: 'me' }]) === true,
  '…and for the locally-overridden person');
check(access.mayOpenLoan({ seesAll: false }, 'me', [{ staff_id: 'other' }]) === false,
  'a direct link does NOT open for a stranger — the file reaches no further than the list');
check(access.mayOpenLoan({ seesAll: true }, 'anyone', []) === true,
  'a sees-all viewer opens a file with no contacts on it at all');
check(access.mayOpenLoan({ seesAll: false }, null, [{ staff_id: null }]) === false,
  'a null viewer never matches a null assignment');

// ── Settings declarations ───────────────────────────────────────────────────
console.log('\nsettings — the new keys are declared');

// The store REFUSES an undeclared key, so a missing declaration here silently
// disables the feature that reads it.
for (const key of ['stages.order', 'stages.map', 'access.roleScopes', 'access.roleOverrides',
  'contacts.roles', 'contacts.encompassRoleNames', 'contacts.roleLabels',
  'contacts.placeholderEmails', 'pipeline.columns']) {
  check(decl.definition(key) !== null, `"${key}" is declared`);
}

const d = decl.defaults();

// THE TENANT'S REAL ROLE NAMES. This instance has no role called "Loan Officer".
check(d['contacts.encompassRoleNames'].loan_officer === 'Loan Coordinator',
  'the loan-officer slot is mapped to the tenant\'s REAL role name, "Loan Coordinator"');
check(d['contacts.placeholderEmails'].includes('change.me@email.com'),
  'the placeholder address 10 of 46 users share is listed as un-matchable');

// The declared defaults must agree with the pure module's, or the two drift and
// the screen shows one thing while the pipeline groups by another.
check(JSON.stringify(d['stages.map']) === JSON.stringify(stages.DEFAULT_MAP),
  'the declared stage map matches stages.js exactly');
check(JSON.stringify(d['stages.order']) === JSON.stringify(stages.DEFAULT_STAGES),
  'the declared stage list matches stages.js exactly');
check(JSON.stringify(d['access.roleScopes']) === JSON.stringify(access.DEFAULT_ROLE_SCOPES),
  'the declared role→scope map matches access.js exactly');

// Every role we track must have both an Encompass name and a screen label, or a
// contact silently reads as blank.
const roles = d['contacts.roles'];
const missingEnc = roles.filter((r) => !d['contacts.encompassRoleNames'][r]);
const missingLbl = roles.filter((r) => !d['contacts.roleLabels'][r]);
check(missingEnc.length === 0, `every tracked role has an Encompass name${missingEnc.length ? ` (missing: ${missingEnc.join(', ')})` : ''}`);
check(missingLbl.length === 0, `every tracked role has a screen label${missingLbl.length ? ` (missing: ${missingLbl.join(', ')})` : ''}`);

// Every role in the scope map must be a role this system understands.
const unknownScoped = Object.keys(d['access.roleScopes']).filter((r) => !access.LT_ROLES.includes(r));
check(unknownScoped.length === 0,
  `every role in the scope map is a known long-term role${unknownScoped.length ? ` (unknown: ${unknownScoped.join(', ')})` : ''}`);

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);

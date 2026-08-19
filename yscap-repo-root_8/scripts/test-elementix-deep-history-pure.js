'use strict';
/**
 * scripts/test-elementix-deep-history-pure.js — the deep import's own rules,
 * no database, no vendor.
 *
 * The structural guards live here because they are properties of the SOURCE:
 *   · the FCRA line — the deep import may never read contact detail: no
 *     `elementix_contacts`, no paid tool, no overview section (it carries a
 *     mailing address) anywhere in the module;
 *   · the depth parity — the deep pull pages exactly the way the profile
 *     builder does (250 a page, 4 pages), stated in two files on purpose and
 *     pinned together here so they cannot drift apart silently;
 *   · the role rule — a company lands on a borrower's profile only when the
 *     records STATE the person's role in it;
 *   · the person-keyed flag — a deed granted to their company is recognised on
 *     the person-id pull even when the vendor's person-flag is an explicit
 *     false, while the ENTITY branch keeps its byte-identical old behavior
 *     (the York, PA rule).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (msg) => { n += 1; console.log(`  ✓ ${msg}`); };
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---------------------------------------------------------------------------
console.log('\n1. The FCRA line, from the source');
// ---------------------------------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, '../src/lib/elementix/deep-history.js'), 'utf8');
const code = stripComments(src);
assert.ok(!code.includes('elementix_contacts'),
  'deep-history never reads the contact table — contact detail may not appear in an underwriting path');
assert.ok(!code.includes('submit_contact_enrichment'),
  'deep-history never names the paid tool');
assert.ok(!/'overview'/.test(code) && !/"overview"/.test(code),
  'deep-history never reads the overview section (it carries a mailing address)');
assert.ok(!code.includes('crm-tools') && !code.includes('get_contact_info'),
  'the live pull goes through lookups.js — the plane that structurally cannot reach a contact');
ok('no contact table, no paid tool, no overview, no CRM-plane door — asserted on the source');

const lookups = require('../src/lib/elementix/lookups');
assert.ok(lookups.TOOLS.has('get_person_entities'), 'the person roster tool is on the underwriting allowlist');
assert.ok(lookups.FORBIDDEN.includes('submit_contact_enrichment'), 'the paid tool stays forbidden there');
assert.ok(!lookups.TOOLS.has('submit_contact_enrichment'), 'and is not in the closed set');
ok('lookups gained the (free) roster tool and nothing else moved');

// ---------------------------------------------------------------------------
console.log('\n2. The depth is the profile builder\'s own');
// ---------------------------------------------------------------------------
const deep = require('../src/lib/elementix/deep-history');
/* profile.js requires the database at load, so a PURE test reads its constants
   off the SOURCE — the same numbers, none of the machinery. */
const profSrc = fs.readFileSync(path.join(__dirname, '../src/lib/elementix/profile.js'), 'utf8');
const profConst = (name) => {
  const m = profSrc.match(new RegExp(`const ${name} = (\\d+)`));
  assert.ok(m, `profile.js states ${name}`);
  return Number(m[1]);
};
assert.strictEqual(deep._internals.PAGE_SIZE, profConst('PAGE_SIZE'),
  'the deep pull pages at the profile builder\'s page size');
assert.strictEqual(deep._internals.MAX_PAGES, profConst('MAX_PAGES'),
  'and to the profile builder\'s page depth');
assert.strictEqual(deep._internals.CALL_BUDGET, profConst('CALL_BUDGET'),
  'and under the same call budget');
ok(`${deep._internals.PAGE_SIZE} a page × ${deep._internals.MAX_PAGES} pages, budget ${deep._internals.CALL_BUDGET} — pinned to profile.js`);

// ---------------------------------------------------------------------------
console.log('\n3. A company needs a STATED role to land on the profile');
// ---------------------------------------------------------------------------
const { statedRole, dedupeEntities } = deep._internals;
assert.strictEqual(statedRole({ isPrincipal: true }), 'principal');
assert.strictEqual(statedRole({ sosOfficer: true }), 'sos_officer');
assert.strictEqual(statedRole({ elementixSigner: true }), 'signer');
assert.strictEqual(statedRole({ name: 'NO ROLE LLC' }), null, 'no flag → no role');
assert.strictEqual(statedRole({ isPrincipal: false, sosOfficer: false, elementixSigner: false }), null,
  'explicit false is not a role');
assert.strictEqual(statedRole(null), null);
ok('principal / SOS officer / signer count; absence and explicit false do not');

const dd = dedupeEntities([
  { id: 'e1', name: 'A LLC' }, { id: 'e1', name: 'A LLC' },
  { name: 'B LLC', state: 'NJ' }, { name: 'B LLC', state: 'NJ' },
  { name: 'B LLC', state: 'PA' },
]);
assert.strictEqual(dd.length, 3, 'same id, and same name+state, fold to one; another state stays');
ok('the family merge cannot double a company');

// ---------------------------------------------------------------------------
console.log('\n4. The person-keyed flag — and the entity branch untouched');
// ---------------------------------------------------------------------------
const importer = require('../src/lib/track-record/importer');
const deed = (extra) => ({
  kind: 'deed', id: 'd1', documentId: 'd1', countyDocumentId: 'd1',
  date: '2024-01-01', amount: 100000,
  addresses: ['1 Test St, Newark, NJ 07102'], mls: null,
  grantors: ['SOMEBODY'], grantees: ['MW TRADING LLC'],
  isGrantee: false, isGrantor: false,
  ...extra,
});
const names = ['MOSES WEIL', 'MW TRADING LLC'];

// ENTITY branch (no flag): the vendor's explicit false is final — byte-identical
// to the pre-change behavior.
const entityBranch = importer.candidatesFrom({ deeds: [deed()], mortgages: [] }, names);
assert.strictEqual(entityBranch.candidates.length, 0, 'entity branch: an explicit vendor false stays final');
assert.ok(entityBranch.skips.some((s) => s.reason === 'not_our_party'));
ok('the ENTITY branch is byte-identical — the York, PA rule stands');

// PERSON-KEYED pull: the vendor's flag answered a different question ("is the
// PERSON the grantee"), so the profile's own companies are consulted too.
const personKeyed = importer.candidatesFrom({ deeds: [deed()], mortgages: [], personKeyed: true }, names);
assert.strictEqual(personKeyed.candidates.length, 1, 'person-keyed: their company\'s deed is recognised');
assert.strictEqual(personKeyed.candidates[0].entity_name, 'MW TRADING LLC');
ok('the person-keyed pull recognises a company-held deed through the profile');

// A STRANGER's deed is still nothing, flag or no flag.
const stranger = importer.candidatesFrom(
  { deeds: [deed({ grantees: ['TOTALLY OTHER LLC'] })], mortgages: [], personKeyed: true }, names);
assert.strictEqual(stranger.candidates.length, 0, 'a stranger\'s deed is never staged');
ok('a stranger\'s deed stays a stranger\'s — the flag widens nothing else');

// The WHY printed for a no-dates candidate says what the records actually
// show (second audit 2026-08-19): a transfer-only property names the
// transfer, and a genuinely empty one never claims "a purchase but no sale".
const whyTransfer = importer.dealTypeFromRecords({ raw: { relatedPartyTransfer: true } });
assert.strictEqual(whyTransfer.dealType, null);
assert.ok(/transfer between the borrower and their own company/i.test(whyTransfer.why),
  'a transfer-only candidate\'s why names the transfer');
const whyEmpty = importer.dealTypeFromRecords({});
assert.strictEqual(whyEmpty.dealType, null);
assert.ok(/no purchase or sale dates/i.test(whyEmpty.why), 'an empty candidate\'s why claims nothing');
assert.ok(/purchase but no sale/.test(importer.dealTypeFromRecords({ purchase_date: '2024-01-01' }).why),
  'a real purchase-only candidate still reads as before');
ok('the no-deal-type WHY describes the records, never a purchase they don\'t show');

// ---------------------------------------------------------------------------
console.log('\n5. The auto-import options are internal-only, and honest');
// ---------------------------------------------------------------------------
const staffSrc = stripComments(fs.readFileSync(path.join(__dirname, '../src/routes/staff.js'), 'utf8'));
assert.ok(!staffSrc.includes('allowUnstatedDealType'),
  'the HTTP decide route never passes allowUnstatedDealType — a screen cannot reach it');
ok('a human door can never import a line with no deal type — only the auto path may, with its note');

const summary = deep.summarizeImport({ found: 3, staged: 2, imported: 1, merged: 1, leftForReview: 0, entitiesAdded: 2, entitiesMatched: 0, skips: [{}] });
assert.deepStrictEqual(summary, { found: 3, staged: 2, imported: 1, merged: 1, leftForReview: 0, entitiesAdded: 2, entitiesMatched: 0, skipped: 1 });
assert.deepStrictEqual(deep.summarizeImport(null), { nothing: true });
assert.deepStrictEqual(deep.summarizeImport({ nothing: true }), { nothing: true });
ok('the route/log summary shape is stable');

// The wiring the DB suite cannot see from module level: the build + link routes
// actually call the import, and the sync loop carries the backfill pass.
const crmRouteSrc = stripComments(fs.readFileSync(path.join(__dirname, '../src/routes/elementix-crm.js'), 'utf8'));
assert.ok(crmRouteSrc.includes('importAfterBuild'), 'the profile build route lands the history on linked borrowers');
assert.ok(crmRouteSrc.includes('importFromCache'), 'linking a borrower lands the cached history right away');
const syncSrc = stripComments(fs.readFileSync(path.join(__dirname, '../src/sync/elementix-crm-sync.js'), 'utf8'));
assert.ok(syncSrc.includes('backfillOnce'), 'the sync loop carries the back-book sweep');
assert.ok(syncSrc.includes('ELEMENTIX_HISTORY_IMPORT_ENABLED'), 'behind its own call-time switch');
ok('build, link and the sweep are wired — asserted on the source');

/* THE BUILD ROUTE'S RESPONSE IS SCOPED (pre-merge audit 2026-08-19): every
   per-borrower import entry it echoes must have passed the same borrower scope
   the record routes use — an officer must never receive another officer's
   borrower id plus that borrower's import activity because they can see the
   PERSON through their own lead. The fold-into-aggregate branch must exist. */
{
  const at = crmRouteSrc.indexOf('importAfterBuild');
  const after = crmRouteSrc.slice(at, at + 2500);
  assert.ok(/recordScope\(req, 'borrower'/.test(after),
    'the build route scopes each echoed borrower through recordScope');
  assert.ok(/others/.test(after), 'and folds invisible borrowers into an anonymous aggregate');
}
ok('the build route never echoes a borrower the actor may not see');

/* THE SWEEP'S KILL SWITCH IS A REAL SWITCH — in the API Health catalog, so a
   human can flip it at runtime (pre-merge audit 2026-08-19: it read the flag
   but was absent from switches.js, so no UI or API could ever set it). */
{
  const switches = require('../src/lib/integrations/switches');
  const all = switches.SWITCHES || switches.ALL || switches.list || null;
  const has = (Array.isArray(all) ? all : []).some((s) => s && s.key === 'ELEMENTIX_HISTORY_IMPORT_ENABLED')
    || (switches.BY_KEY && (switches.BY_KEY.has ? switches.BY_KEY.has('ELEMENTIX_HISTORY_IMPORT_ENABLED') : !!switches.BY_KEY.ELEMENTIX_HISTORY_IMPORT_ENABLED));
  assert.ok(has, 'ELEMENTIX_HISTORY_IMPORT_ENABLED is in the runtime switch catalog');
}
ok('the history-import kill switch is flippable at runtime, like every other switch');

console.log(`\ntest-elementix-deep-history-pure: all ${n} checks passed`);

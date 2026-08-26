'use strict';
/**
 * GATE — EVERY CATALOG ROW THE TENANT SENDS MUST ACTUALLY KEY TO SOMETHING.
 *
 * WHY THIS EXISTS. `refreshFieldCatalog` keys each row with a chain of guesses at
 * what the vendor calls its own id — `r.canonicalName || r.fieldName || r.id` and
 * five more like it. A chain that resolves to `undefined` does NOT throw. It hits
 * `if (!key) continue`, the row is dropped, the loop finishes, and the summary
 * reports the kind with no error and a count of zero. Six catalogs can report
 * "refreshed cleanly" and have stored nothing whatsoever.
 *
 * That is not hypothetical, and it is why this file exists rather than a comment.
 * The tenant's picklist payload keys its rows `fieldID` — capital D. The enum chain
 * asks for `fieldId`. Those are different strings, so the correct-looking fix that
 * merely re-pointed the enum URL at the address that answers 200 would have stored
 * EXACTLY ZERO enums and reported success. It was caught here, before it shipped.
 *
 * THE FIXTURES ARE MEASURED, NOT IMAGINED. Every one below is the real key set the
 * live tenant returned to `GET /api/lt/_diag/book/catalog-probe` on 2026-08-25, or
 * the payload recorded in `docs/longterm/ENCOMPASS-LIVE-API-PROBE.md` §10.1. A
 * fixture somebody invents to make a test pass would defeat the whole point, so each
 * carries the shape it was taken from.
 *
 * PURE. No database, no network, no credentials.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused/unused';

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const reader = require('../src/encompass/reader');
const KINDS = new Map(reader.CATALOG_KINDS.map((k) => [k.kind, k]));

/**
 * One real row per catalog, carrying the key names the tenant actually sends.
 * `expectKey` is what the chain must resolve to — named explicitly so that a chain
 * silently reordered to resolve on a DIFFERENT field still fails here.
 */
const MEASURED = [
  {
    kind: 'customField',
    from: 'GET /encompass/v3/settings/loan/customFields — 200, 857 rows',
    row: { id: 'CUST01FV', description: 'DSCR', format: 'DECIMAL_3', maxLength: 12, type: 'Decimal', isCalculatedField: false, calculation: null, contractPath: null },
    expectKey: 'CUST01FV',
  },
  {
    kind: 'standardField',
    from: 'GET /encompass/v3/schemas/loan/standardFields — 200, 10,000 rows in one call',
    row: { id: '4002', description: 'Subject Property Street Address', format: 'STRING', readOnly: false, fieldLock: false, nullable: true, category: 'Loan', dataType: 'String' },
    expectKey: '4002',
  },
  {
    kind: 'milestone',
    from: 'GET /encompass/v3/settings/milestones — 200',
    row: { id: '1', name: 'LO Prep', tpoStatus: null, consumerStatus: null, milestoneColor: null, isArchived: false },
    expectKey: 'LO Prep',
  },
  {
    kind: 'folder',
    from: 'GET /encompass/v1/loanFolders — 200, all 22 folders',
    row: { name: 'My Pipeline', activityRules: null, folderType: 'Normal', isExternalOrganization: false, loanGuid: null },
    expectKey: 'My Pipeline',
  },
  {
    kind: 'loanTemplate',
    from: 'client.listLoanTemplates, normalised from /v3/settings/templates/loanTemplateSet/folders',
    row: { path: 'Public:\\Companywide\\DSCR 30 YEAR FRM', name: 'DSCR 30 YEAR FRM', description: 'DSCR 30 YEAR FRM', entityType: 'LoanTemplateSet' },
    expectKey: 'Public:\\Companywide\\DSCR 30 YEAR FRM',
  },
  {
    kind: 'enum',
    from: 'client.listFieldEnums, normalised from /encompass/v1/loanPipeline/fieldDefinitions',
    row: { fieldId: '4189', description: 'Co-Borr Sex No Co Applicant', requireValueFromList: true, options: [{ value: 'Y', text: 'No co-applicant' }, { value: 'N', text: 'No' }] },
    expectKey: '4189',
  },
];

console.log('every measured row keys to something\n');

for (const m of MEASURED) {
  const spec = KINDS.get(m.kind);
  check(!!spec, `${m.kind}: the catalog spec still exists (a rename must fail loudly, not stop checking)`);
  if (!spec) continue;
  const key = spec.keyFn(m.row);
  check(!!key, `${m.kind}: a real row keys to something rather than undefined  [${m.from}]`);
  check(key === m.expectKey, `${m.kind}: it keys to "${m.expectKey}" — got ${JSON.stringify(key)}`);
  const label = spec.labelFn(m.row);
  check(!!label, `${m.kind}: it also produces a human label (${JSON.stringify(label)})`);
}

// ── THE BUG THAT WAS NEARLY SHIPPED, PINNED ─────────────────────────────────
console.log('\nthe raw picklist payload, which keys with a CAPITAL D');

const RAW_PIPELINE_ROW = {
  borrowerPair: 1,
  isLoanDataField: true,
  category: 'Database',
  fieldID: '4189',
  fieldDefinition: {
    fieldID: '4189',
    description: 'Co-Borr Sex No Co Applicant',
    format: 102,
    fieldOptions: { requireValueFromList: true, options: [{ value: 'Y', text: 'No co-applicant' }, { value: 'N', text: 'No' }] },
  },
  name: 'Co-Borr Race No Co Applicant',
  description: 'Co-Borr Race No Co Applicant',
};

const enumSpec = KINDS.get('enum');
check(enumSpec && !enumSpec.keyFn(RAW_PIPELINE_ROW),
  'the RAW payload row does NOT key — proving the client must normalise it, and that handing this straight to the reader would silently store zero enums');
check(RAW_PIPELINE_ROW.fieldDefinition.fieldOptions.options.length === 2,
  'and that the options sit three levels down, at fieldDefinition.fieldOptions.options, where `raw.options` would never find them');

console.log('\nthe raw loan-template payload, whose key names match nothing');

const RAW_TEMPLATE_ROW = {
  entityType: 'LoanTemplateSet',
  entityName: 'DSCR 30 YEAR FRM',
  entityPath: 'Public:\\Companywide\\DSCR 30 YEAR FRM',
  hasSubFolders: false,
};
const tplSpec = KINDS.get('loanTemplate');
check(tplSpec && !tplSpec.keyFn(RAW_TEMPLATE_ROW),
  'the RAW template row does NOT key — its names are entityPath/entityName while the chain asks for path/name/id, so unnormalised the catalog would hold zero templates');

// ── THE DEAD ADDRESSES MUST NOT COME BACK ───────────────────────────────────
console.log('\nthe five addresses that answered 403 stay gone');

const fs = require('fs');
const path = require('path');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'src/encompass/client.js'), 'utf8');
// Comments name the dead paths on purpose — struck through, so a reader who
// remembers one finds out it is dead. Only live CODE counts here.
const CODE = CLIENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

const DEAD = [
  ['standard fields', '/encompass/v3/settings/loan/standardFields'],
  ['milestones', '/encompass/v3/settings/loan/milestones'],
  ['picklists', '/encompass/v3/settings/loan/enums'],
  ['folders', '/encompass/v3/settings/loan/folders'],
  ['loan templates', '/encompass/v3/settings/loan/loanTemplates'],
];
for (const [what, dead] of DEAD) {
  check(!CODE.includes(dead), `${what}: the 403 address is not called any more (${dead})`);
}

const LIVE = [
  ['standard fields', '/encompass/v3/schemas/loan/standardFields'],
  ['milestones', '/encompass/v3/settings/milestones'],
  ['picklists', '/encompass/v1/loanPipeline/fieldDefinitions'],
  ['folders', '/encompass/v1/loanFolders'],
  ['custom fields', '/encompass/v3/settings/loan/customFields'],
  ['loan templates', '/encompass/v3/settings/templates/loanTemplateSet/folders'],
];
for (const [what, live] of LIVE) {
  check(CODE.includes(live), `${what}: the measured address IS called (${live})`);
}

// The picklist list must be lifted out by NAME, not by a heuristic.
check(/pipelineLoanReportFieldDefs/.test(CODE),
  'the picklist rows are lifted from pipelineLoanReportFieldDefs by name, not by guessing which key holds the longest array');
check(/r\.fieldID/.test(CODE),
  'the picklist row id is read as fieldID, with the capital D the tenant actually sends');

// ── THE TWO REWRITTEN READERS, RUN RATHER THAN READ ─────────────────────────
// Everything above this line is a source guard, and a source guard cannot tell a
// function that works from one that merely contains the right words. These two
// stub the transport and run the REAL client functions against the REAL payload
// shapes the tenant returns.
(async () => {
  const enc = require('../src/lib/integrations/encompass');
  const realGet = enc.apiGet;

  // ---- the picklists: 3,159 rows in, only the 790 with options out ----------
  console.log('\nthe picklist reader, run against the payload shape §10.1 recorded');
  enc.apiGet = async (path_) => {
    if (path_ === '/encompass/v1/loanPipeline/fieldDefinitions') {
      return { pipelineLoanReportFieldDefs: [
        RAW_PIPELINE_ROW,
        // 2,369 of the 3,159 carry NO option list. Storing those as empty enums
        // would be a catalog that answers "this field has a dropdown" for two
        // thirds of the loan file.
        { fieldID: '2', description: 'Trans Details Total Loan Amt', fieldDefinition: { fieldID: '2', format: 203 } },
        // Options present, `requireValueFromList` absent. Still a picklist: a field
        // offering choices is one whatever the flag says, and dropping these to
        // honour a boolean would lose the thing this call exists for.
        { fieldID: '1811', description: 'Occupancy', fieldDefinition: { fieldID: '1811', fieldOptions: { options: [{ value: 'P', text: 'Primary' }] } } },
        { /* junk */ }, null,
      ] };
    }
    return realGet(path_);
  };
  const client = require('../src/encompass/client');
  const enums = await client.listFieldEnums();
  check(enums.length === 2, `only the rows that carry options come back (got ${enums.length} of 5)`);
  check(enums.every((r) => r.fieldId && r.options && r.options.length),
    'every returned row has both an id and its options');
  check(enums.every((r) => enumSpec.keyFn(r) && enumSpec.labelFn(r)),
    'and the reader can key AND label every one of them — the end-to-end proof');
  check(!enums.some((r) => r.fieldId === '2'),
    'a field with no dropdown is NOT stored as an empty enum');
  check(enums.some((r) => r.fieldId === '1811' && r.requireValueFromList === false),
    'a field offering choices is kept even when requireValueFromList is absent');

  // ---- the standard fields: the whole catalog, and the loop must terminate ---
  console.log('\nthe standard-field pager, run against a full-size catalog');
  const TOTAL = 23704;   // the real size, from the field-dictionary provenance
  const calls = [];
  enc.apiGet = async (path_) => {
    calls.push(path_);
    const u = new URL(`http://x${path_}`);
    const start = Number(u.searchParams.get('start'));
    const limit = Number(u.searchParams.get('limit'));
    const n = Math.max(0, Math.min(limit, TOTAL - start));
    return Array.from({ length: n }, (_, i) => ({ id: String(start + i), description: `f${start + i}`, format: 'STRING' }));
  };
  const fields = await client.listStandardFields();
  check(fields.length === TOTAL, `the WHOLE catalog comes back — ${fields.length} of ${TOTAL}`);
  check(new Set(fields.map((r) => r.id)).size === TOTAL, 'with no duplicated rows across the page boundaries');
  check(calls.length === 3, `in 3 calls rather than fifty (got ${calls.length})`);
  check(calls.every((c) => c.includes('limit=10000')), 'each asking for the measured 10,000-row page');
  // The reverted first attempt capped at 5,000 — 21% of this catalog, silently.
  check(fields.length > 20000, 'and it is NOT silently capped part-way, which is what the first attempt did');

  // ---- the loan templates: a TREE, and every folder must be opened ---------
  console.log('\nthe loan-template walker, run against the tree measured on 2026-08-25');
  // Transcribed from the live walk, including the folder whose `hasSubFolders` is
  // FALSE. The walk's first run gated recursion on that flag and reported a
  // complete tree having never looked inside it — a folder with no child folders
  // can still hold templates, and this fixture is what keeps that fix honest.
  const TREE = {
    public: { contents: [{ entityType: 'TemplateFolder', entityName: 'Companywide', entityPath: 'Public:\\Companywide\\', hasSubFolders: true }] },
    personal: { contents: [{ entityType: 'LoanTemplateSet', entityName: 'Example Purchase Loan Template', entityPath: 'Personal:\\Example Purchase Loan Template' }] },
    'Public:\\Companywide\\': { contents: [
      { entityType: 'TemplateFolder', entityName: 'DO NOT USE', entityPath: 'Public:\\Companywide\\DO NOT USE\\', hasSubFolders: false },
      { entityType: 'LoanTemplateSet', entityName: 'DSCR 30 YEAR FRM', entityPath: 'Public:\\Companywide\\DSCR 30 YEAR FRM' },
      { entityType: 'LoanTemplateSet', entityName: 'Fix & Flip', entityPath: 'Public:\\Companywide\\Fix & Flip' },
    ] },
    'Public:\\Companywide\\DO NOT USE\\': { contents: [
      { entityType: 'LoanTemplateSet', entityName: 'Retired DSCR', entityPath: 'Public:\\Companywide\\DO NOT USE\\Retired DSCR' },
    ] },
  };
  enc.apiGet = async (path_) => {
    const key = new URL(`http://x${path_}`).searchParams.get('path');
    if (!(key in TREE)) throw new Error(`Encompass 404: no such folder ${key}`);
    return TREE[key];
  };
  const templates = await client.listLoanTemplates();
  check(templates.length === 4, `every leaf comes back — ${templates.length} of 4`);
  check(templates.every((r) => tplSpec.keyFn(r) && tplSpec.labelFn(r)),
    'and every one of them keys AND labels through the real catalog writer');
  check(!templates.some((r) => String(r.entityType).toLowerCase().includes('folder')),
    'folders are followed, not stored — a folder is not a template');
  check(templates.some((r) => r.path.includes('DO NOT USE')),
    'a folder with hasSubFolders:false is STILL opened — that flag means no child folders, not no templates');

  enc.apiGet = realGet;

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL — the run-it-for-real section threw:', e && e.message); process.exit(1); });

#!/usr/bin/env node
'use strict';
/**
 * EVERY TOKEN WE SEND, CHECKED AGAINST THE VENDOR'S OWN PUBLISHED LIST.
 *
 * WHY THIS EXISTS. Our enum tables were reverse-engineered out of the vendor's browser bundle and
 * out of captured requests. That proved the names EXIST; it never proved they are spelled the way
 * the pricing API expects, and it can never notice the vendor ADDING a value. Both failures are
 * silent:
 *
 *   · A token the vendor does not publish is NOT refused. Measured live (§37.14): a deliberately
 *     made-up reserves token answered HTTP 200 and priced 371 options / 10 programs where the real
 *     token priced 394 / 11 — a whole lender program gone, no error, no warning, a wrong price.
 *   · A token the vendor publishes and we lack is a requirement a caller simply cannot state. That
 *     is how 9- and 36-month reserves were missing for months.
 *
 * WHAT IT IS. Lender Price publishes the authoritative list itself, at
 *   GET /rest/v1/lp-ppe-integration/company/config/{companyId}   Accept: application/json-no-enum
 * — about 1.4 MB, inside which `quickPricer.customConfigs[].pricingConfig.customConfig` is a
 * STRINGIFIED JSON UI model whose enum-carrying nodes each have a `path` and a `values` array of
 * {code,label} pairs. This walks that model, unions the values per path across every pricer, and
 * compares it to what our code actually puts on the wire.
 *
 * THREE TRAPS, EACH OF WHICH PRODUCED A CONFIDENT WRONG ANSWER BEFORE IT WAS CAUGHT. Do not
 * "simplify" any of them away:
 *   1. The token is `.code`. Reading `.value`/`.name` returns undefined for every entry and the
 *      run reports the vendor publishing NOTHING — which reads as "the registry is empty", not as
 *      "the reader is wrong".
 *   2. Compare the VALUES of an alias map, never its KEYS. `{ "Fixed 5%": "Fixed5" }` means a
 *      caller may TYPE "Fixed 5%" and we SEND "Fixed5". Comparing keys reports every deliberate
 *      convenience alias as a mismatch — it did, for 8 of 9 families at once.
 *   3. A non-string value is a deliberate sentinel, not a token. `PREPAY_STRUCTURE_NULL` is a
 *      Symbol meaning "explicitly no prepay"; it never reaches the wire as text and must not be
 *      reported as an unpublished token.
 *
 * READ-ONLY. It logs in, GETs one config document, and prints. It never prices, never writes, and
 * never prints a token, a password, a secret or an access token.
 *
 * RUN IT:
 *   LP_USERNAME=… LP_PASSWORD=… LP_CLIENT_SECRET=… node docs/longterm/ppe-research/token-registry-check.js
 * Exit status is 0 when nothing we emit is unpublished, 1 when something is — so it can be wired
 * to a scheduled check later. A family the registry does not publish is reported as UNCHECKABLE
 * and is deliberately NOT a failure: "we could not verify this" and "this is wrong" are different
 * answers and must never be collapsed.
 *
 * LT-only: reads src/longterm/** and nothing else. No DB, no RTL import.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
const reg = require(path.join(ROOT, 'src/longterm/lenderprice/field-registry.js'));
const sm = require(path.join(ROOT, 'src/longterm/lenderprice/search-model.js'));

const AUTH = 'https://auth.digitallending.com';
const API = 'https://api.digitallending.com';
const ORIGIN = 'https://yscapgroup.digitallending.com';
const CLIENT_ID = 'acme2';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';
const L = (s) => console.log(s);

// ---- what WE put on the wire ------------------------------------------------
// Each entry answers ONE question: "which exact strings can this family send?" Never "which
// strings will we accept from a caller" — that is a superset and comparing it is trap 2 above.
const strings = (xs) => [...new Set(xs.filter((v) => typeof v === 'string' && v !== ''))];
const emittedBy = (m) => strings(Object.values(m || {}));            // an alias map: the VALUES ship
const membersOf = (s) => strings([...(s || [])]);                    // a Set: the members ship

const FAMILIES = [
  { name: 'reserves',          path: 'GLOBAL_RESERVES',           emit: () => emittedBy(sm._internals.RESERVES_TOKENS) },
  { name: 'income doc type',   path: 'IncomeDocType',             emit: () => emittedBy(reg.INCOME_DOC_TYPES) },
  { name: 'prepay structure',  path: 'PrePayment_Plan_Type',      emit: () => emittedBy(reg.PREPAY_STRUCTURES) },
  { name: 'borrower type',     path: 'GLOBAL_BorrowerType',       emit: () => membersOf(reg.BORROWER_TYPES) },
  { name: 'citizenship',       path: 'Citizenship',               emit: () => membersOf(reg._tokens.CITIZENSHIP) },
  { name: 'tradelines',        path: 'Tradelines',                emit: () => membersOf(reg._tokens.TRADELINES) },
  { name: 'bankruptcy chapter',path: 'BankruptcyChapter',         emit: () => membersOf(reg._tokens.BK_CHAPTER) },
  { name: 'bankruptcy status', path: 'BankruptcyStatus',          emit: () => membersOf(reg._tokens.BK_STATUS) },
  { name: 'bankruptcy season', path: 'BankruptcySeasoning',       emit: () => membersOf(reg._tokens.BK_SEASONING) },
  { name: 'foreclosure',       path: 'Global_FORECLOSURES',       emit: () => membersOf(reg._tokens.FORECLOSURE) },
  { name: 'short sale',        path: 'Global_SHORTSALES',         emit: () => membersOf(reg._tokens.SHORTSALE) },
  { name: 'deed in lieu',      path: 'Global_DEEDINLIEU',         emit: () => membersOf(reg._tokens.DEEDINLIEU) },
  { name: 'forbearance',       path: 'GLOBAL_Forbearances',       emit: () => membersOf(reg._tokens.FORBEARANCE) },
  { name: 'charge-off',        path: 'GLOBAL_MortgageChargeOff',  emit: () => membersOf(reg._tokens.CHARGEOFF) },
  // An alias map since §37.15 — "4+" is a spelling a caller may use, "4" is what ships.
  { name: 'late counts',       path: 'MORT30LATESLAST12M',        emit: () => emittedBy(reg._tokens.LATE_COUNT) },
  { name: 'compensation type', path: 'criteria.compensationType', emit: () => emittedBy(reg._tokens.COMP_TYPE) },
  { name: 'property type',     path: 'property.propertyType',     emit: () => strings(Object.values(reg.PROPERTY_TYPES || {}).map((p) => (p && p.propertyType) || p)) },
  { name: 'attachment type',   path: 'property.attachmentType',   emit: () => strings(sm._internals.ATTACHMENT_TYPES || []) },
  { name: 'loan purpose',      path: 'criteria.loanPurpose',      emit: () => emittedBy(sm._internals.PURPOSE_ALIASES) },
  { name: 'loan type',         path: 'loanTypeCriteria',          emit: () => ['Fixed'] },
  { name: 'mortgage type',     path: 'criteria.mortgageTypes',    emit: () => ['Conventional'] },
  { name: 'lien priority',     path: 'criteria.lienPriorityType', emit: () => ['FirstLien'] },
  { name: 'property use',      path: 'criteria.propertyUse',      emit: () => ['Investment'] },
  { name: 'lock days',         path: 'dayLocksCriteria',          emit: () => strings((sm._internals.ALLOWED_LOCKS || []).map(String)) },
  { name: 'state',             path: 'property.address.state',    emit: () => strings(Object.keys(sm._internals.STATE_FIPS || {})) },
];

// ---- PASS 2: sweep a REAL request, so no field escapes because nobody mapped it ----
// The FAMILIES table above is HAND-MAINTAINED, which is the exact shape that goes stale silently:
// it checks the whole TABLE of what each family COULD send, but only for the families somebody
// remembered to add. Measured when this was written, a real request emitted EIGHT dynamic fields
// that table did not cover at all (AddlOccupancyType, PrepayTerm, GLOBAL_Section184,
// GLOBAL_NativeAmerican, Global_DSCR_Asset_Depletion, GLOBAL_Cross_Collateralization_Product,
// GLOBAL_DECLININGMARKET, GLOBAL_GIFTFUNDPERCENT) plus a dozen criteria paths — so a "24 families,
// all ok" result was a pass over a subset.
//
// So this second pass DERIVES its field list from what `buildSearch` actually produces. The two
// passes answer different questions and both are needed: the table can see a value no scenario
// happened to emit, and the sweep can see a FIELD nobody mapped.
//
// The registry's `path` IS the request path — a dotted path addresses the nested request object
// (`criteria.loanPurpose`) and a bare name is a `dynamicPropertiesMap` key (`GLOBAL_RESERVES`).
// That is not assumed: every dotted path this sweep collects is looked up in the registry by that
// exact string, and the ones that resolve are what prove the convention holds.
const SCENARIOS = [
  { label: 'purchase, minimum facts',
    sc: { purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, state: 'NJ', countyFps: '34039', fico: 760 } },
  { label: 'purchase, every optional field the builder accepts',
    sc: { purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, state: 'NJ', countyFps: '34039', fico: 760,
      reservesMonths: 12, propertyType: 'SingleFamily', borrowerType: 'LLC', citizenship: 'US Citizen',
      incomeDocType: 'DSCR', prepayStructure: 'Standard', prepayMonths: 60, io: true, escrowWaive: true,
      rentalTerm: 'Long Term', attachmentType: 'Detached', tradelines: 'Limited',
      compensationType: 'BorrowerCompPlan', crossCollateral: true, dscrAssetDepletion: true,
      firstTimeInvestor: true, livingRentFree: true, lateInLast12Months: true,
      // BOTH late windows. Exercising only `last12` left MORT*LASTLAST24M out of the sweep, and the
      // discovery list then claimed we never send them — a false claim about our own request.
      mortgageLates: { last12: { 30: '1', 60: '2', 90: '3', 120: '4+' },
                       months13To24: { 30: '1', 60: '2', 90: '3', 120: '4' } } } },
  { label: 'cash-out refinance',
    sc: { purpose: 'CashoutRefinance', value: 6e5, loan: 3.5e5, dscr: 1.4, state: 'FL', countyFps: '12086',
      fico: 700, cashoutAmount: 5e4, reservesMonths: 'none', borrowerType: 'Individual' } },
];

// A field whose value is a free NUMBER, an id, or a Jackson type discriminator is not an enum and
// must not be reported as an unpublished token. Everything else is swept.
const NOT_AN_ENUM = /(^|\.)(@class|country|county|censustract|city|countyName|street|streetCont|zip|zipExt|name)$/;

// A BOOLEAN AND A NUMBER ARE SWEPT TOO, COMPARED AS `String(v)` — and that is the whole reason
// this pass sees anything interesting. The registry publishes `criteria.interestOnly` as the
// strings "true" | "false", but the REAL frontend capture sends a JSON boolean `true` there
// (verified in anchors req-01 and req-07), and we match it. So the registry's values describe the
// UI's option list while the WIRE TYPE is whatever the frontend sends. Collecting only strings
// made every one of those fields invisible to this sweep — the exact class where a type mismatch
// would hide — and made the discovery list claim we never send them.
// Parity with the captured frontend, not the registry, decides the TYPE; the registry decides the
// VALUE. Where those two could disagree, the capture wins and this pass must not "fix" it.
const scalar = (v) => (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number');

function sweepRequest(model) {
  const found = [];               // { path, value }
  for (const [k, v] of Object.entries(model.dynamicPropertiesMap || {})) {
    const val = v && typeof v === 'object' ? v.value : v;
    if (scalar(val) && String(val) !== '') found.push({ path: k, value: String(val) });
  }
  (function walk(node, prefix) {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (NOT_AN_ENUM.test(p)) continue;
      if (scalar(v) && String(v) !== '') found.push({ path: p, value: String(v) });
      // An array is a multi-select (criteria.mortgageTypes) — every member is a token.
      else if (Array.isArray(v) && v.length && v.every(scalar)) {
        for (const x of v) found.push({ path: p, value: String(x) });
      } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
    }
  })({ criteria: model.criteria, property: model.property, brokerCriteria: model.brokerCriteria,
       accessCriteria: model.accessCriteria, loanTypeCriteria: model.loanTypeCriteria }, '');
  return found;
}

// ---- the vendor's own list --------------------------------------------------
function publishedEnums(cfg) {
  const byPath = new Map();
  for (const c of (cfg.quickPricer && cfg.quickPricer.customConfigs) || []) {
    let model = null;
    try { model = JSON.parse(c.pricingConfig.customConfig); } catch { continue; }
    (function walk(n) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.path && Array.isArray(n.values) && n.values.length) {
        const set = byPath.get(n.path) || new Set();
        for (const v of n.values) {
          // `.code` is the token. `.label` is what the pricer SHOWS a human — see trap 1.
          const code = v && typeof v === 'object' ? v.code : v;
          if (code != null && String(code) !== '') set.add(String(code));
        }
        byPath.set(n.path, set);
      }
      Object.values(n).forEach(walk);
    })(model);
  }
  return byPath;
}

async function login() {
  const basic = 'Basic ' + Buffer.from(`${CLIENT_ID}:${process.env.LP_CLIENT_SECRET}`, 'utf8').toString('base64');
  const r = await fetch(`${AUTH}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json',
      'User-Agent': UA, Origin: ORIGIN, Referer: ORIGIN + '/', Authorization: basic,
    },
    body: new URLSearchParams({
      grant_type: 'password', username: process.env.LP_USERNAME,
      password: process.env.LP_PASSWORD, client_id: CLIENT_ID,
    }).toString(),
  });
  const s = await r.json().catch(() => ({}));
  if (!s.access_token) throw new Error(`login failed (HTTP ${r.status})`);
  return s;   // the access token is USED here and never printed anywhere.
}

(async () => {
  for (const k of ['LP_USERNAME', 'LP_PASSWORD', 'LP_CLIENT_SECRET']) {
    if (!process.env[k]) { L(`${k} is not set — this check reads the live registry and cannot run without it.`); process.exit(2); }
  }
  const s = await login();
  const r = await fetch(`${API}/rest/v1/lp-ppe-integration/company/config/${s.companyId}`, {
    headers: {
      Accept: 'application/json-no-enum', 'Content-Type': 'application/json-no-enum',
      Authorization: `Bearer ${s.access_token}`, Origin: ORIGIN, Referer: ORIGIN + '/', 'User-Agent': UA,
    },
  });
  const text = await r.text();
  if (r.status !== 200) { L(`the registry answered HTTP ${r.status} — nothing checked`); process.exit(2); }
  const vendor = publishedEnums(JSON.parse(text));
  L(`vendor registry read: ${(text.length / 1024).toFixed(0)} KB, ${vendor.size} enum fields published\n`);

  // `--snapshot` refreshes the committed copy that the OFFLINE guard
  // (scripts/test-lt-lp-vendor-tokens-pure.js) checks our tables against on every `npm test`. This
  // check needs live credentials, so without a snapshot nothing stops an invented token being added
  // tomorrow by someone who never runs it. Refreshing it is a DELIBERATE act with a diff to read —
  // never automatic, because a silently-updated snapshot would rubber-stamp a vendor change we have
  // not looked at.
  if (process.argv.includes('--snapshot')) {
    const out = {
      _comment: 'GENERATED — do not hand-edit. Refresh with: node docs/longterm/ppe-research/token-registry-check.js --snapshot',
      _source: 'GET /rest/v1/lp-ppe-integration/company/config/{companyId}, Accept: application/json-no-enum',
      _readAt: new Date().toISOString().slice(0, 10),
      _fields: vendor.size,
      values: Object.fromEntries([...vendor.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, [...v]])),
    };
    const file = path.join(__dirname, 'vendor-token-registry.json');
    require('fs').writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    L(`snapshot written: ${path.relative(ROOT, file)} (${vendor.size} fields)\n`);
  }

  let wrong = 0, checked = 0, uncheckable = 0;
  const gaps = [];
  for (const f of FAMILIES) {
    const theirs = vendor.get(f.path);
    let ours = [];
    try { ours = f.emit(); } catch (e) { L(`? ${f.name.padEnd(20)} could not be read from our code: ${e.message}`); continue; }
    if (!theirs) {
      uncheckable++;
      L(`? ${f.name.padEnd(20)} ours ${String(ours.length).padStart(3)}  the registry does not publish "${f.path}" — NOT checked`);
      continue;
    }
    checked++;
    const unpublished = ours.filter((v) => !theirs.has(v));
    const missing = [...theirs].filter((v) => !ours.includes(v));
    if (unpublished.length) wrong++;
    if (missing.length) gaps.push({ f, missing });
    L(`${unpublished.length ? '✗' : '✓'} ${f.name.padEnd(20)} ours ${String(ours.length).padStart(3)}  vendor ${String(theirs.size).padStart(3)}  ${unpublished.length ? 'MISMATCH' : 'ok'}`);
    if (unpublished.length) L(`     WE SEND, THE VENDOR DOES NOT PUBLISH: ${unpublished.join(' | ')}`);
  }

  if (gaps.length) {
    L('\nthe vendor offers values we cannot send (a caller cannot ask for these):');
    for (const g of gaps) L(`  ${g.f.name.padEnd(20)} ${g.missing.join(' | ').slice(0, 160)}`);
  }

  L(`\n${checked} token families checked against the vendor registry; ${wrong} carry a value the vendor does not publish.`);
  if (uncheckable) L(`${uncheckable} could not be checked (the registry publishes no list for them) — reported, never counted as passing.`);

  // ---- PASS 2 -----------------------------------------------------------------
  L('\n--- sweeping real built requests, field by field ---');
  const swept = new Map();          // path -> Set(values we were seen to emit)
  for (const { label, sc } of SCENARIOS) {
    let model;
    try { model = sm.buildSearch(sc); } catch (e) { L(`  ! "${label}" could not be built: ${e.message}`); continue; }
    for (const { path: p, value } of sweepRequest(model)) {
      const set = swept.get(p) || new Set();
      set.add(value);
      swept.set(p, set);
    }
  }

  let sweptBad = 0, sweptOk = 0;
  const unpublishedPaths = [];
  for (const [p, values] of [...swept.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const theirs = vendor.get(p);
    if (!theirs) { unpublishedPaths.push({ path: p, values: [...values] }); continue; }
    const bad = [...values].filter((v) => !theirs.has(v));
    if (bad.length) {
      sweptBad++;
      L(`✗ ${p.padEnd(40)} WE SEND: ${bad.join(' | ')}`);
      L(`     the vendor publishes: ${[...theirs].join(' | ').slice(0, 150)}`);
    } else sweptOk++;
  }
  L(`\n${sweptOk + sweptBad} emitted fields resolved against the registry; ${sweptBad} carry a value it does not publish.`);
  if (unpublishedPaths.length) {
    // NOT a failure. But the list is only useful if the genuinely interesting rows are not buried
    // under the loan amount and the FICO, so it is split by a DERIVED test — "is every value we
    // sent a number?" — rather than by a hand-kept list of numeric field names, which would be the
    // same stale-list problem this whole pass exists to remove. A free number has no enum by
    // definition; a WORD with no published list is the row worth a human's attention.
    const numericOnly = unpublishedPaths.filter((u) => u.values.every((v) => v !== '' && !Number.isNaN(Number(v))));
    const wordy = unpublishedPaths.filter((u) => !numericOnly.includes(u));
    if (wordy.length) {
      L(`\n${wordy.length} emitted fields carry a WORD the registry publishes no list for — UNCHECKED, not passed:`);
      for (const u of wordy) L(`  ${u.path.padEnd(40)} ${u.values.join(' | ')}`);
    }
    L(`\n${numericOnly.length} more are free numbers (a number has no enum) — not checkable and not a concern.`);
  }

  // Fields the vendor publishes that no request of ours ever touches. Not a defect — this is the
  // DISCOVERY list, and it is what answers a "the field name was never captured" deferral.
  const never = [...vendor.keys()].filter((p) => !swept.has(p) && !FAMILIES.some((f) => f.path === p)).sort();
  if (never.length) {
    L(`\n${never.length} fields the vendor publishes that we never send (the discovery list):`);
    for (const p of never) L(`  ${p.padEnd(40)} ${[...vendor.get(p)].join(' | ').slice(0, 110)}`);
  }

  process.exit(wrong || sweptBad ? 1 : 0);
})().catch((e) => { L('THREW: ' + (e && e.message ? e.message : String(e))); process.exit(2); });

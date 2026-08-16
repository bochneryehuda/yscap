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
  process.exit(wrong ? 1 : 0);
})().catch((e) => { L('THREW: ' + (e && e.message ? e.message : String(e))); process.exit(2); });

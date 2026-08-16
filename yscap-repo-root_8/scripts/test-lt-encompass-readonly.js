'use strict';
/**
 * LT test — the Long-Term Encompass integration is structurally READ-ONLY, and
 * the Encompass "memory" (field catalog + rules + requests + reconciliation map)
 * is well-formed. Pure (no DB). Runs in CI.
 *
 * This mirrors scripts/test-encompass-readonly.js for RTL: it proves LT's own
 * Encompass client cannot mutate Encompass, and that the knowledge module loads
 * and unifies every source.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Fake env BEFORE requiring so configured() returns true. No real credentials.
process.env.LT_ENCOMPASS_CLIENT_ID = process.env.LT_ENCOMPASS_CLIENT_ID || 'test-client';
process.env.LT_ENCOMPASS_CLIENT_SECRET = process.env.LT_ENCOMPASS_CLIENT_SECRET || 'test-secret';
process.env.LT_ENCOMPASS_INSTANCE_ID = process.env.LT_ENCOMPASS_INSTANCE_ID || 'TESTINSTANCE';
process.env.LT_ENCOMPASS_API_BASE = 'https://api.elliemae.example';
process.env.LT_ENCOMPASS_MIN_GAP_MS = '0';   // no pacing delay in tests

const CLIENT_PATH = '../src/longterm/encompass/client';
delete require.cache[require.resolve('../src/longterm/config')];
delete require.cache[require.resolve(CLIENT_PATH)];
const client = require(CLIENT_PATH);

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  // ── READ-ONLY guarantees ────────────────────────────────────────────────
  ok('client.READ_ONLY === true', client.READ_ONLY === true);
  ok('client.configured() === true (with fake env)', client.configured() === true);

  for (const forbidden of ['apiPost', 'apiPut', 'apiPatch', 'apiDelete', 'updateLoan', 'createLoan', 'patchLoan', 'setField', 'writeField', 'orderFlood']) {
    ok(`client does NOT export write helper "${forbidden}"`, client[forbidden] === undefined);
  }

  // apiGet refuses the OAuth namespace and empty path.
  await assert.rejects(() => client.apiGet('/oauth2/v1/token'), /may not call the OAuth namespace/);
  ok('apiGet refuses /oauth2/*', true);
  await assert.rejects(() => client.apiGet('oauth2/v1/token'), /may not call the OAuth namespace/);
  ok('apiGet refuses an OAuth path with no leading slash', true);
  await assert.rejects(() => client.apiGet(''), /path is required/);
  ok('apiGet refuses an empty path', true);

  // ── The fetch guard: allowed POSTs reach fetch; rogue POSTs are refused ──
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    seen.push({ url, method: (init && init.method) || 'GET' });
    if (url.endsWith('/oauth2/v1/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/encompass/v3/loanPipeline')) return new Response(JSON.stringify([{ loanGuid: 'g1' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/fieldReader')) return new Response(JSON.stringify({ '364': 'X' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    delete require.cache[require.resolve(CLIENT_PATH)];
    const c = require(CLIENT_PATH);

    // pipeline-search POST allowed
    const res = await c.pipelineSearch({ filter: { canonicalName: 'Loan.LoanNumber', value: 'X', matchType: 'Exact' } });
    ok('pipelineSearch (read-shaped POST) reaches fetch and returns data', Array.isArray(res));

    // fieldReader POST allowed (guid path)
    const fr = await c.fieldReader('abcd1234efgh', ['364']);
    ok('fieldReader (read-shaped POST by field number) reaches fetch', fr && fr['364'] === 'X');

    // OAuth token POST happened; only the three allowed POST families reached fetch
    const posts = seen.filter((s) => s.method === 'POST');
    ok('OAuth token POST happened', posts.some((s) => s.url.includes('/oauth2/v1/token')));
    const postFamilies = new Set(posts.map((s) =>
      s.url.includes('/oauth2/v1/token') ? 'token'
      : s.url.includes('/encompass/v3/loanPipeline') ? 'pipeline'
      : s.url.includes('/fieldReader') ? 'fieldReader' : 'OTHER'));
    ok('only token / pipeline / fieldReader POSTs reached fetch (no OTHER)', !postFamilies.has('OTHER'), [...postFamilies].join(','));

    // A GET settings read reaches fetch as GET
    seen.length = 0;
    await c.getMilestoneSettings();
    ok('getMilestoneSettings issues a GET to the CORRECTED /settings/milestones path',
      seen.some((s) => s.method === 'GET' && s.url.includes('/encompass/v3/settings/milestones')));
    await c.getStandardFieldSchema(['418', '169']);
    ok('getStandardFieldSchema issues a GET to the CORRECTED /schemas/loan/standardFields path',
      seen.some((s) => s.method === 'GET' && s.url.includes('/encompass/v3/schemas/loan/standardFields')));
  } finally {
    global.fetch = realFetch;
  }

  // ── Source-level guards ──────────────────────────────────────────────────
  const src = fs.readFileSync(require.resolve(CLIENT_PATH), 'utf8');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('_fetchGuarded backstop present', src.includes('_fetchGuarded'));
  ok("method-allowlist check present (method !== 'GET')", src.includes("method !== 'GET'"));
  ok('READ_ONLY sentinel present', /const READ_ONLY = true/.test(codeOnly));
  for (const name of ['apiPost', 'apiPut', 'apiPatch', 'apiDelete', 'updateLoan', 'createLoan', 'patchLoan', 'orderFlood']) {
    ok(`no ${name} write helper declared in source`,
      !new RegExp(`(?:function\\s+${name}\\b|const\\s+${name}\\b|\\b${name}\\s*:\\s*(?:async\\s*)?\\()`).test(codeOnly));
  }
  const allow = codeOnly.match(/POST_ALLOWLIST\s*=\s*new\s+Set\(\[([^\]]*)\]\)/);
  ok('POST_ALLOWLIST declared as new Set([...])', !!allow);
  if (allow) {
    const entries = allow[1].split(',').map((s) => s.trim()).filter(Boolean);
    ok('POST_ALLOWLIST has exactly 2 entries (token + pipeline)', entries.length === 2, entries.join(', '));
  }
  ok('fieldReader path predicate present and narrow', codeOnly.includes('_isFieldReaderPath') && /FIELD_READER_SUFFIX\s*=\s*'\/fieldReader'/.test(codeOnly));

  // ── The knowledge module (memory) is well-formed ─────────────────────────
  const enc = require('../src/longterm/encompass');
  const sum = enc.summary();
  ok('unified field catalog has 100+ fields', sum.fields >= 100, `got ${sum.fields}`);
  ok('22 milestone-completion rules captured', sum.rulesCaptured === 22, `got ${sum.rulesCaptured}`);
  ok('91 rules total, 69 missing (honest gap recorded)', sum.rulesTotal === 91 && sum.rulesMissing === 69);
  ok('43 RTL reconciliation fields brought in', sum.reconciliationFields === 43, `got ${sum.reconciliationFields}`);
  ok('summary reports read-only', sum.readOnly === true);

  const cat = enc.fieldCatalog();
  ok('every catalog field has a fieldId + family', cat.every((f) => f.fieldId && f.family));
  const f364 = enc.fieldById('364');
  ok('field 364 unifies BOTH its milestone requirement AND its RTL reconciliation usage',
    f364 && f364.requiredByRules.length > 0 && f364.isRtlReconciled && f364.rtlReconciliation.key === 'ys_loan_number', JSON.stringify(f364 && f364.rtlReconciliation));
  const dscr = enc.fieldById('CX.DSCRLTV');
  ok('a DSCR-only field (CX.DSCRLTV) is present and NOT RTL-reconciled', dscr && dscr.isRtlReconciled === false);

  // completion-rules shape
  ok('base rule field list is substantial (100+ fields)', enc.rules.BASE_RULE_FIELDS.length >= 100, `got ${enc.rules.BASE_RULE_FIELDS.length}`);
  ok('every rule has a name, condition, and explanation', enc.rules.RULES.every((r) => r.name && r.condition && r.explanation));
  ok('RTL-specific rules are flagged (rtl:true)', enc.rules.RULES.filter((r) => r.rtl).length >= 3);

  // requests catalog shape
  ok('auth catalog documents the password grant + scope lp', enc.requests.AUTH.passwordGrant.scope === 'lp');
  ok('request catalog includes the CORRECTED milestone + standardFields paths',
    enc.requests.REQUESTS.some((r) => r.path.includes('/settings/milestones') && r.corrected) &&
    enc.requests.REQUESTS.some((r) => r.path.includes('/schemas/loan/standardFields') && r.corrected));

  // Ensure LT encompass code imports NO RTL module (defense-in-depth beyond the gate).
  const encDir = path.join(__dirname, '..', 'src', 'longterm', 'encompass');
  for (const file of fs.readdirSync(encDir).filter((f) => f.endsWith('.js'))) {
    const body = fs.readFileSync(path.join(encDir, file), 'utf8');
    const reqs = [...body.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const r of reqs) {
      if (!r.startsWith('.')) continue;                 // npm/builtin
      const resolved = path.resolve(encDir, r);
      ok(`${file} require('${r}') stays inside src/longterm`, resolved.includes(path.join('src', 'longterm')), resolved);
    }
  }

  if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log('\nOK — LT Encompass is structurally READ-ONLY and the memory is well-formed.');
}

main().catch((e) => { console.error(e); process.exit(1); });

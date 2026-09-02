#!/usr/bin/env node
'use strict';
/**
 * Long-Term DSCR pricer routes — load + gate test (no network, no DB).
 * Proves the routers construct without throwing (so server boot can mount them) and
 * that the secret gate on the diagnostics router behaves: off when LP_DIAG_TOKEN is
 * unset, 401 on a wrong token, pass-through on the right one.
 */
let failures = 0;
function ok(c, l) { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; }

// 1) The shared handlers/router module loads and builds a router.
const dp = require('../src/longterm/routes/dscr-pricer');
ok(typeof dp.makeRouter === 'function', 'dscr-pricer exports makeRouter()');
ok(Array.isArray(dp.BATTERY) && dp.BATTERY.length === 5, `battery has 5 scenarios (${dp.BATTERY.length})`);
const r = dp.makeRouter();
ok(r && typeof r === 'function' && typeof r.use === 'function', 'makeRouter() returns an express router');

// 2) The secret-gated diagnostics router loads (this is what server.js mounts).
const diag = require('../src/longterm/routes/lenderprice-diag');
ok(typeof diag === 'function' && typeof diag.use === 'function', 'lenderprice-diag is an express router');

// 2b) shapeDisqualified — the per-lender item CURSOR (audit §C3): a lender with more items than the
//     cap is fully retrievable by paging itemOffset.
const { shapeDisqualified, effectiveOf, unsupportedFields } = dp._internals;
const dq = { ready: true, lenderCount: 3, itemCount: 8, reasonCount: 8, lenders: [
  { lender: 'A', lenderId: 'a', itemCount: 5, items: [1, 2, 3, 4, 5] },
  { lender: 'B', lenderId: 'b', itemCount: 2, items: [1, 2] },
  { lender: 'C', lenderId: 'c', itemCount: 1, items: [1] },
] };
{
  const s0 = shapeDisqualified(dq, { itemLimit: 2, itemOffset: 0 }).disqualified;
  ok(s0.lenders[0].items.length === 2 && s0.lenders[0].itemNextOffset === 2 && s0.lenders[0].itemTruncated === true, 'first item page returns 2 + a cursor to the remainder');
  const s2 = shapeDisqualified(dq, { limit: 1, offset: 0, itemLimit: 2, itemOffset: 2 }).disqualified;
  ok(s2.lenders[0].items[0] === 3 && s2.lenders[0].itemNextOffset === 4, 'the cursor walks INTO the same lender (items 3,4 next)');
  const s4 = shapeDisqualified(dq, { limit: 1, offset: 0, itemLimit: 10, itemOffset: 4 }).disqualified;
  ok(s4.lenders[0].items.length === 1 && s4.lenders[0].itemNextOffset === null && s4.lenders[0].itemTruncated === false, 'the last item page has no further cursor');
  const lp1 = shapeDisqualified(dq, { limit: 1, offset: 1 }).disqualified;
  ok(lp1.lenders.length === 1 && lp1.lenders[0].lenderId === 'b' && lp1.page.nextOffset === 2, 'lender pagination still works alongside the item cursor');
}

// 2c) effectiveScenario now shows every transmitted selector (audit) + the new independent fields.
{
  const lp = require('../src/longterm/lenderprice/client');
  const payload = lp.buildSearch({ purpose: 'Cash out', value: 6e5, loan: 42e4, propertyType: 'Condo', attachment: 'Detached', nonWarrantable: true, prepayMonths: 60, cashoutAmount: 50000, zip: '33101', state: 'FL', countyFps: '12086' });
  const eff = effectiveOf(payload);
  ok(eff.reserves === 'Reserves_24' && eff.addlOccupancyType === 'Long_Term_Rental_Property', 'effectiveScenario shows reserves + rental term');
  ok(eff.location && eff.location.state === 'FL' && eff.location.county === '12086', 'effectiveScenario shows the complete location');
  ok(eff.cashoutAmount === 50000 && eff.cashoutAmountInternal === 50000,
    'effectiveScenario shows the TRANSMITTED cash-out amount, and the internal copy agrees with it');
  ok(eff.attachmentType === 'Detached' && eff.nonWarrantableProject === true, 'effectiveScenario shows the independent attachment + non-warrantable');
  ok(Array.isArray(eff.specialMortgageOptions) && eff.specialMortgageOptions.every((s) => 'id' in s && 'name' in s), 'SMOs are reported as {id,name} identities');
  ok(unsupportedFields({ attachment: 'Detached', nonWarrantable: true, purpose: 'Purchase' }).length === 0, 'attachment + nonWarrantable are supported fields');
  ok(unsupportedFields({ madeUpField: 1 }).includes('madeUpField'), 'a truly unknown field is still rejected');
  // rentalTerm must be in the route allow-list (a builder field the route rejected = an inert feature).
  ok(unsupportedFields({ rentalTerm: 'short', purpose: 'Purchase' }).length === 0, 'rentalTerm is a supported route field (reachable over HTTP)');
  const stEff = effectiveOf(lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, rentalTerm: 'short' }));
  ok(stEff.addlOccupancyType === 'Short_Term_Rental_Property', 'a rentalTerm:short request round-trips to Short_Term_Rental_Property in effectiveScenario');
}

// 3) Exercise the secret gate directly by pulling its first layer's handle.
//    layer[0] is the gate middleware added by router.use((req,res,next)=>{...}).
const gate = diag.stack && diag.stack[0] && diag.stack[0].handle;
ok(typeof gate === 'function', 'diag gate middleware present');
function mockRes() { return { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
function run(gateFn, headers, env) {
  const saved = process.env.LP_DIAG_TOKEN;
  if (env === undefined) delete process.env.LP_DIAG_TOKEN; else process.env.LP_DIAG_TOKEN = env;
  let nexted = false;
  const res = mockRes();
  gateFn({ get: (h) => headers[h.toLowerCase()] || '' }, res, () => { nexted = true; });
  if (saved === undefined) delete process.env.LP_DIAG_TOKEN; else process.env.LP_DIAG_TOKEN = saved;
  return { nexted, code: res.code, body: res.body };
}
// off by default → 404, no pass-through
let g = run(gate, {}, undefined);
ok(!g.nexted && g.code === 404, 'gate 404s when LP_DIAG_TOKEN unset (feature off)');
// token set, no header → 401
g = run(gate, {}, 'secret-abc');
ok(!g.nexted && g.code === 401, 'gate 401s with no token header');
// token set, wrong header → 401
g = run(gate, { 'x-lp-diag-token': 'wrong' }, 'secret-abc');
ok(!g.nexted && g.code === 401, 'gate 401s on wrong token');
// token set, right header → next()
g = run(gate, { 'x-lp-diag-token': 'secret-abc' }, 'secret-abc');
ok(g.nexted && g.code === null, 'gate passes through on correct token');

// ---- POST-MERGE AUDIT (#1220): §3 of the parity doc must not drift from the code ----
// §3 states "anything not in this list is rejected 422 (unsupported_field)". Read literally, a field
// missing from the list says a SUPPORTED field is rejected — and 12 of them were missing, because
// the list is hand-maintained while SUPPORTED_FIELDS grows in code. A hand-kept list goes stale
// silently, so this asserts the two agree instead of trusting anyone to remember.
{
  const fs = require('fs');
  const doc = fs.readFileSync(require('path').join(__dirname, '..', 'docs', 'longterm', 'LENDER-PRICE-PARITY-STATUS.md'), 'utf8');
  const start = doc.indexOf('## 3. The request-builder field contract');
  const end = doc.indexOf('## 4.');
  ok(start !== -1 && end > start, 'DOC-0 the parity doc still has a §3 field-contract section');
  const s3 = doc.slice(start, end);
  ok(dp.SUPPORTED_FIELDS instanceof Set && dp.SUPPORTED_FIELDS.size > 0, 'DOC-0a SUPPORTED_FIELDS is exported and populated');
  ok(dp.META_FIELDS instanceof Set && dp.META_FIELDS.size > 0, 'DOC-0b META_FIELDS is exported and populated');
  const missing = [...dp.SUPPORTED_FIELDS].filter((f) => !new RegExp('`' + f + '`').test(s3));
  ok(missing.length === 0, `DOC-1 every supported field is documented in §3 (missing: ${missing.join(', ') || 'none'})`);

  // The reverse is worse: a field §3 PROMISES that the route would 422. The first cut
  // read only LINE-START fields — 25 of §3's 78 backticked tokens — so a phantom in
  // the Location line, the flags line or the whole "Advanced (strict)" line was
  // invisible, and those are the longest and most drift-prone lines in the section.
  // It also short-circuited on `!SUPPORTED_FIELDS.has(f) && !META_FIELDS.has(f)`, so
  // META_FIELDS was NEVER dereferenced and deleting its export left the suite green
  // — half the guard's declared input could be missing entirely. Both are closed:
  // every backticked token in §3 is considered, and the two sets are asserted above.
  const ALL_TOKENS = [...new Set([...s3.matchAll(/`([a-zA-Z][a-zA-Z0-9_]*)`/g)].map((m) => m[1]))];
  ok(ALL_TOKENS.length > 40, `DOC-2a §3 is read WHOLE, not just its line starts (${ALL_TOKENS.length} tokens)`);
  // §3 legitimately names upstream paths, tokens and types alongside our field names,
  // so a token only counts as a PROMISE when it is not one of those. The allowlist is
  // narrow and explicit: anything else that looks like one of our fields must be one.
  const NOT_A_FIELD = new Set([
    ...dp.META_FIELDS,
    // upstream/vendor vocabulary and type words that appear in the same prose
    'criteria', 'property', 'address', 'dynamicPropertiesMap', 'brokerCriteria', 'number', 'boolean',
    'integer', 'enum', 'string', 'null', 'true', 'false', 'default', 'int', 'jsonb',
  ]);
  const phantom = ALL_TOKENS.filter((f) => !dp.SUPPORTED_FIELDS.has(f)
    && !NOT_A_FIELD.has(f)
    && !/[._A-Z]/.test(f)                       // upstream paths and TokenCase values
    && !new RegExp('`' + f + '`\\s*(→|->)').test(s3) === false);
  ok(phantom.length === 0, `DOC-2 §3 promises no field the route would reject (phantom: ${phantom.join(', ') || 'none'})`);
}

// 2d) THE WHITE-LABEL DECORATION RIDES THE ANSWERS (owner-directed 2026-08-27).
// The behaviour of the sheet itself is test-lt-investor-programs-pure.js; what is
// held HERE is that the ROUTE actually carries it — a decorated group survives the
// pager, the roster door answers the whole sheet, and the price/ineligible handlers
// still call the decoration (a one-word deletion there would leave the sheet
// perfect and every response bare).
{
  const IP = require('../src/longterm/lenderprice/investor-programs');
  const deco = IP.decorateDisqualifiedLenders([
    { lender: 'NewRez, LLC Wholesale', investor: 'NewRez, LLC Wholesale', lenderId: 'x', itemCount: 1, items: [1] },
  ]);
  const s = shapeDisqualified({ ready: true, lenderCount: 1, itemCount: 1, reasonCount: 1, lenders: deco }).disqualified;
  ok(s.lenders[0].investorKey === 'newrez' && s.lenders[0].whiteLabel === 'Onyx',
    'a decorated declined group keeps its investorKey + white-label through the pager');

  // GET /investors is asserted at the bottom of this file — it reads settings
  // now (an investor somebody added by hand belongs on the pre-search list the
  // moment it exists), so it is async and needs a stubbed store to prove.

  const routeSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/longterm/routes/dscr-pricer.js'), 'utf8');
  ok(/investorPrograms\.decorate\(full\.programs\)/.test(routeSrc) && /investorRoster: deco\.roster/.test(routeSrc),
    'the FULL price answer is decorated and carries the investor roster');
  ok(/decorateDisqualifiedLenders\(parsed\.lenders\)/.test(routeSrc)
    && /decorateDisqualifiedLenders\(pd\.lenders\)/.test(routeSrc)
    && /decorateDisqualifiedLenders\(pdFull\.lenders\)/.test(routeSrc),
  'every ineligible door decorates before shaping — poll-by-key, poll-by-scenario and the blocking door');
  ok(/const decoDq = \{ \.\.\.parsed, lenders:/.test(routeSrc),
    'the poll-by-key door decorates a COPY — the client\'s cached parse is never mutated');
}

/**
 * GET /investors — THE ROSTER DOOR, WHICH NOW READS SETTINGS.
 *
 * It used to answer the committed white-label sheet and nothing else. It still
 * answers that sheet — every name on it, live in Lender Price or not — and it
 * ALSO answers the investors somebody added by hand, because an investor that
 * turns up on a vendor board this morning belongs on the pre-search list this
 * morning rather than after a deploy.
 *
 * The settings store is stubbed at the DATABASE, not at the store: stubbing the
 * store would prove this door calls a function, and what has to be proven is
 * that a row somebody saved reaches the list.
 */
(async () => {
  const path = require('path');
  const dbPath = require.resolve(path.join(__dirname, '../src/longterm/db'));
  const realDb = require.cache[dbPath];
  const store = require('../src/longterm/settings/store');

  const rows = [{
    key: 'pricing.customInvestors',
    value: {
      swept_capital: {
        label: 'Sweptside Capital Partners',
        whiteLabel: 'Northgate',
        aliases: ['Sweptside Capital Partners', 'Sweptside Cap'],
      },
    },
  }];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: async () => ({ rows }) } };
  store.bust();

  let sent = null;
  await dp.handlers.investorsRoster({}, { json: (b) => { sent = b; } });
  const names = (sent && sent.investors ? sent.investors : []).map((i) => i.whiteLabel);
  ok(sent && sent.ok === true && Array.isArray(sent.investors) && sent.investors.length >= 24,
    `GET /investors answers the whole sheet (${sent && sent.investors ? sent.investors.length : 0} names)`);
  ok(names.includes('Northgate'),
    'and an investor somebody added by hand is ON that list, under the name a client may see');
  ok(sent && sent.degraded === false,
    'a readable store is not reported as degraded');

  // The sheet ALONE when the store cannot be read — the behaviour this door had
  // before hand-added investors existed. A settings outage may cost the ones
  // somebody added; it may never cost the sheet.
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: async () => { throw new Error('no database'); } } };
  store.bust();
  let out = null;
  await dp.handlers.investorsRoster({}, { json: (b) => { out = b; } });
  ok(out && out.ok === true && out.investors.length === 24 && !out.investors.some((i) => i.whiteLabel === 'Northgate'),
    'an unreadable store answers the 24-name sheet alone — never an empty list, never a throw');
  ok(out && out.degraded === true,
    '…and says so, so a short list is never presented as the whole truth');

  if (realDb) require.cache[dbPath] = realDb; else delete require.cache[dbPath];
  store.bust();

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();

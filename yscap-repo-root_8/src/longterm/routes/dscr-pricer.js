'use strict';
/**
 * LONG-TERM DSCR PRICER — HTTP routes (Lender Price backend).
 *
 * Two mounts share these handlers:
 *   • the staff-gated LT router (src/longterm/index.js → /api/lt/dscr/*), and
 *   • a secret-gated diagnostics router (src/longterm/routes/lenderprice-diag.js →
 *     /api/lt/_diag/lenderprice/*) that is OFF unless LP_DIAG_TOKEN is set.
 *
 * Read-only: prices via Lender Price and never books/locks/registers. All Lender Price
 * calls happen server-side (the trusted company origin); the client lives in
 * src/longterm/lenderprice/client.js. LT-only — imports no RTL code.
 */
const express = require('express');
const lp = require('../lenderprice/client');
const { REGISTRY_FIELDS } = require('../lenderprice/field-registry');
const { REGISTRY_WARNINGS, validateScenario } = require('../lenderprice/search-model');

// A small, fixed verification battery spanning states / property types / FICO / DSCR / prepay.
const BATTERY = [
  { name: 'SFR purchase 75% 760 DSCR1.25 NJ 5yr', purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.25, propertyType: 'SingleFamily', zip: '07036', state: 'NJ', county: 'Union', countyFps: '34039', prepayMonths: 60 },
  { name: 'SFR cash-out 70% 720 DSCR1.10 FL 3yr', purpose: 'CashOut', value: 600000, loan: 420000, fico: 720, dscr: 1.10, propertyType: 'SingleFamily', zip: '33101', state: 'FL', county: 'Miami-Dade', countyFps: '12086', prepayMonths: 36 },
  { name: '2-4 unit purchase 75% 740 DSCR1.30 NY 5yr', purpose: 'Purchase', value: 900000, loan: 675000, fico: 740, dscr: 1.30, propertyType: 'Unit2_4', zip: '11211', state: 'NY', county: 'Kings', countyFps: '36047', prepayMonths: 60 },
  { name: 'Warr condo r/t refi 65% 780 DSCR1.40 TX none', purpose: 'RateTerm', value: 450000, loan: 292500, fico: 780, dscr: 1.40, propertyType: 'CondoWarr', zip: '75201', state: 'TX', county: 'Dallas', countyFps: '48113', prepayMonths: 0 },
  { name: 'SFR purchase I/O 80% 700 DSCR1.05 GA 2yr', purpose: 'Purchase', value: 350000, loan: 280000, fico: 700, dscr: 1.05, propertyType: 'SingleFamily', zip: '30301', state: 'GA', county: 'Fulton', countyFps: '13121', prepayMonths: 24, io: true },
];

function trimPrograms(parsed, limit = 60) {
  return {
    meta: { programCount: parsed.programCount, lenderCount: parsed.lenderCount, rungCount: parsed.rungCount, disqualifiedCount: parsed.disqualifiedCount },
    programs: parsed.programs.slice(0, limit).map((p) => ({
      lender: p.lender, investor: p.investor || null, lenderId: p.lenderId || null,
      program: p.program, product: p.product || null,
      minRate: p.minRate, minPoints: p.minPoints, maxPrice: p.maxPrice, rungCount: p.rungCount,
    })),
  };
}

// The scenario fields the builder ACTUALLY honors. Anything else a caller sends must be REJECTED,
// never silently ignored — otherwise the caller gets plausible pricing for a DIFFERENT scenario
// (the "silent substitution" data-integrity bug). Grow this set (and the builder) together as
// fields are implemented; a not-yet-implemented field is rejected with 422 unsupported_field.
const SUPPORTED_FIELDS = new Set([
  'purpose', 'value', 'appraisedValue', 'asIsValue', 'loan', 'ltv', 'fico', 'dscr',
  'propertyType', 'units', 'zip', 'state', 'county', 'countyFps', 'city', 'countyName',
  'borrowerType', 'prepayMonths', 'io', 'escrowWaive', 'fthb', 'date',
  'term', 'termYears', 'lockDays', 'cashoutAmount',
  // Registry-backed advanced fields (borrower criteria + adverse-credit dynamics). Each maps to an
  // exact upstream path/token; an invalid VALUE for one is rejected as invalid_field_value (below).
  ...REGISTRY_FIELDS,
]);
// Request-envelope keys the ROUTE consumes (not pricing inputs) — always allowed.
const META_FIELDS = new Set(['scenario', 'debug', 'full', 'raw', 'poll', 'disqualify', 'maxWaitMs', 'pollMs', 'companyId']);
function unsupportedFields(sc) {
  return Object.keys(sc || {}).filter((k) => !SUPPORTED_FIELDS.has(k) && !META_FIELDS.has(k));
}
// The EFFECTIVE scenario actually sent upstream — so a caller can see requested-vs-effective and
// catch any silent default. Read straight off the built searchRaw payload.
function effectiveOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const c = payload.criteria || {};
  const p = payload.property || {};
  const dp = payload.dynamicPropertiesMap || {};
  const dyn = (k) => (dp[k] && typeof dp[k] === 'object' ? dp[k].value : dp[k]);
  return {
    loanPurpose: c.loanPurpose, purchasePrice: c.purchasePrice, appraisedValue: c.appraisedValue,
    loanAmount: c.loanAmount, ltv: c.ltv, fico: c.fico, dscr: c.dscr,
    loanYear: c.loanYear, termsCriteria: payload.termsCriteria, termsInMonths: payload.termsInMonths,
    dayLocks: payload.brokerCriteria && payload.brokerCriteria.dayLocks, dayLocksCriteria: payload.dayLocksCriteria,
    loanType: c.loanType, loanTypeCriteria: payload.loanTypeCriteria,
    propertyUse: c.propertyUse, propertyType: p.propertyType, numberOfUnit: p.numberOfUnit, attachmentType: p.attachmentType,
    interestOnly: c.interestOnly, escrowWaiver: c.escrowWaiver, firstTimeHomeBuyer: c.firstTimeHomeBuyer,
    compensationType: c.compensationType, incomeDocType: dyn('IncomeDocType'), borrowerType: dyn('GLOBAL_BorrowerType'),
    prepayTerm: dyn('PrepayTerm'), specialMortgageOptions: Array.isArray(c.specialMortgageOptions) ? c.specialMortgageOptions.map((s) => s && s.name).filter(Boolean) : undefined,
    // Registry-backed advanced fields ACTUALLY sent upstream — so a caller can confirm a supported
    // advanced field was applied (not silently dropped). Only present when non-default.
    nonWarrantableProject: c.nonWarrantableProject,
    selfEmployed: c.selfEmployed, monthlyIncome: c.monthlyIncome, monthlyDebt: c.monthlyDebt,
    clientDti: c.clientDti, numberOfBorrower: c.numberOfBorrower, ownProperties: c.ownProperties,
    lenderFeeWaiver: c.lenderFeeWaiver, rural: c.rural,
    citizenship: dyn('Citizenship'), tradelines: dyn('Tradelines'),
    mixedUse: dyn('GLOBAL_MixedUse'), noMortgageHistory: dyn('GLOBAL_NoMortgageHistory'),
    bankruptcyChapter: dyn('BankruptcyChapter'), bankruptcyStatus: dyn('BankruptcyStatus'), bankruptcySeasoning: dyn('BankruptcySeasoning'),
    foreclosure: dyn('Global_FORECLOSURES'), shortSale: dyn('Global_SHORTSALES'), deedInLieu: dyn('Global_DEEDINLIEU'),
    chargeOff: dyn('GLOBAL_MortgageLoanChargeOffs'), forbearance: dyn('GLOBAL_Forbearances'),
  };
}
// 422 the caller if a SUPPORTED registry field carried an invalid enum value — the builder collects
// these as warnings and does NOT apply the bad value, so returning pricing would again be a silent
// substitution (accepted field, ignored value). Reads the JSON-invisible Symbol channel off the
// built payload. Returns true if it responded. (Belongs AFTER the upstream call: warnings live on
// the built request.)
function rejectInvalidValues(request, res) {
  const w = request && request[REGISTRY_WARNINGS];
  if (Array.isArray(w) && w.length) {
    res.status(422).json({ ok: false, error: 'invalid_field_value', warnings: w,
      message: `One or more fields carried a value the pricing engine does not recognize; the value would be silently dropped, so the request is rejected rather than mis-priced: ${w.map((x) => x.field).join(', ')}.` });
    return true;
  }
  return false;
}

// §26.5 — build + validate the scenario LOCALLY and 422 a bad request BEFORE any upstream call, so a
// deterministic validation error (§26.3 incomplete/conflicting location, §26.4 unknown loan purpose,
// invalid registry enum value) makes ZERO searchRaw requests. Returns true if it responded.
function rejectInvalidRequest(sc, res) {
  const v = validateScenario(sc);
  if (!v.ok) {
    const body = { ok: false, error: v.error, message: v.message };
    if (v.field) body.field = v.field;
    if (v.warnings) body.warnings = v.warnings;
    res.status(v.status || 422).json(body);
    return true;
  }
  return false;
}

// Cash-out amount ("cash in hand") transparency — so it's never SILENTLY handled. The vendor UI field
// has no valid dynamic-property code today (the frontend drops the value), so by default we store it
// and do NOT transmit it (matching the frontend). Once LP_CASHOUT_AMOUNT_FIELD is set to the confirmed
// vendor code, it is transmitted. Returns null when no cash-out amount was supplied.
function cashoutNote(sc) {
  if (!sc || sc.cashoutAmount == null || sc.cashoutAmount === '') return null;
  const field = process.env.LP_CASHOUT_AMOUNT_FIELD;
  return {
    value: sc.cashoutAmount,
    transmitted: !!field,
    note: field
      ? `Transmitted to Lender Price as dynamicPropertiesMap.${field}.`
      : 'Accepted and stored, but NOT transmitted to Lender Price — the vendor has not assigned this UI field a dynamic-property code yet (the frontend does not send it either, so pricing is unaffected). Set LP_CASHOUT_AMOUNT_FIELD once the vendor confirms the code.',
  };
}

// 422 the caller if they sent a field the builder does not implement (never silently ignore it).
function rejectUnsupported(sc, res) {
  const bad = unsupportedFields(sc);
  if (bad.length) {
    res.status(422).json({ ok: false, error: 'unsupported_field', fields: bad,
      message: `These fields are not implemented yet and would be silently ignored, so the request is rejected rather than mis-priced: ${bad.join(', ')}. (Supported: ${Array.from(SUPPORTED_FIELDS).join(', ')}.)` });
    return true;
  }
  return false;
}

// GET /health — module up + deployed build id, AND authenticated pricing readiness (not just
// config). By default it proves a login succeeds and the live pricing-config endpoints answer
// (live-vs-fallback provenance). ?config=1 skips the login for a pure config probe; ?price=1 also
// runs a real minimal searchRaw (proves a stale-session 500 is gone) end-to-end.
async function health(req, res) {
  // Expose the deployed source commit so production can be reproduced/audited from the exact code.
  // Render sets RENDER_GIT_COMMIT / RENDER_GIT_BRANCH on every deploy.
  const build = {
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    branch: process.env.RENDER_GIT_BRANCH || null,
    service: process.env.RENDER_SERVICE_NAME || null,
    deployedAt: process.env.RENDER_DEPLOY_FINISHED_AT || null,
  };
  const base = { ok: true, product: 'long-term', feature: 'dscr-pricer', configured: lp.configured(), build };
  // A pure config probe (no login) — the old behavior, kept for a cheap liveness check.
  if (req.query && (req.query.config === '1' || req.query.config === 'true')) return res.json(base);
  const deep = !!(req.query && (req.query.price === '1' || req.query.price === 'true'));
  const readiness = await lp.pricingReadiness({ price: deep });
  res.json({ ...base, ...readiness });
}

// GET /login-check — actually attempt a login and report ok/failure (no pricing). Confirms the
// origin-gated login works from the server.
async function loginCheck(req, res) {
  const s = await lp.getSession({ force: true });
  if (!s.ok) return res.status(502).json({ ok: false, error: s.error, http: s.http || null, message: s.message });
  res.json({ ok: true, companyId: s.companyId, userId: s.userId, expiresAt: new Date(s.expiresAt).toISOString(), profile: s.profile });
}

// Shared error body for a failed pricing call — surfaces the stable-error diagnostics the audit
// requires: both upstream statuses (firstHttp/retryHttp) and the live-vs-fallback provenance.
function priceErrorBody(r) {
  const out = { ok: false, error: r.error, http: r.http || null, message: r.message, upstream: r.upstream || r.body || null };
  if (r.firstHttp != null) out.firstHttp = r.firstHttp;
  if (r.retryHttp != null) out.retryHttp = r.retryHttp;
  if (r.provenance) out.provenance = r.provenance;
  return out;
}

// POST /price — body is a scenario (or { scenario }). Returns the parsed program summary.
async function price(req, res) {
  const sc = (req.body && req.body.scenario) ? req.body.scenario : (req.body || {});
  if (rejectUnsupported(sc, res)) return; // never silently ignore an unimplemented field
  if (rejectInvalidRequest(sc, res)) return; // §26.5 — 422 a bad request BEFORE any upstream call
  const r = await lp.price(sc);
  if (!r.ok) return res.status((r.http && r.http >= 500) ? 502 : 400).json(priceErrorBody(r));
  if (rejectInvalidValues(r.request, res)) return; // a supported field carried an unrecognized value
  const effective = effectiveOf(r.request); // requested-vs-effective transparency
  // full:true → the COMPLETE capture (every option's price build, itemized LLPAs, margin/holdback,
  // comp, fees, ratios, monthly payment). Add raw:true to also attach each option's untouched leaf.
  // A price is ALSO the disqualify kickoff — hand back the stable searchKey so the caller polls the
  // separate status route (GET /disqualifications/:searchKey) instead of ever restarting the search.
  if (req.body && req.body.full) {
    const full = lp.parseFull(r.raw, { raw: !!req.body.raw });
    const out = { ok: true, ...full, effectiveScenario: effective, cashoutAmount: cashoutNote(sc), request: r.request, searchKey: r.searchKey, disqualifyStatus: 'computing', provenance: r.provenance || null, recovered: !!r.recovered };
    if (req.body.debug) out.rawSummary = lp.summarizeRaw(r.raw);
    return res.json(out);
  }
  const parsed = lp.parse(r.raw);
  const out = { ok: true, ...trimPrograms(parsed), effectiveScenario: effective, cashoutAmount: cashoutNote(sc), request: r.request, searchKey: r.searchKey, disqualifyStatus: 'computing', provenance: r.provenance || null, recovered: !!r.recovered };
  // Secret-gated diagnostics (the whole router is behind the diag token / staff login): when the
  // caller asks, include a structural summary of the raw response so we can see whether Lender
  // Price returned programs the parser missed, or truly zero — and any disqualify reasons.
  if (req.body && req.body.debug) out.rawSummary = lp.summarizeRaw(r.raw);
  res.json(out);
}

// §27.2 — shape a PARSED disqualified result into a paginated per-lender/reason summary that NEVER
// silently drops data: the response carries the true totals, the returned counts, an explicit
// `truncated` flag, and a `nextOffset` cursor so a caller can page through the whole set. `d` is a
// lp.parseDisqualified(...) result (all lenders/items, untruncated). Caps are configurable.
const LENDER_PAGE_MAX = Number(process.env.LP_DISQUALIFY_LENDER_PAGE_MAX || 500);
const ITEM_PAGE_MAX = Number(process.env.LP_DISQUALIFY_ITEM_PAGE_MAX || 200);
function clampInt(v, min, max, dflt) { const n = Math.floor(Number(v)); return isFinite(n) ? Math.min(Math.max(n, min), max) : dflt; }
function shapeDisqualified(d, opts = {}) {
  const limit = clampInt(opts.limit, 1, LENDER_PAGE_MAX, LENDER_PAGE_MAX);
  const offset = clampInt(opts.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const itemLimit = clampInt(opts.itemLimit, 1, ITEM_PAGE_MAX, ITEM_PAGE_MAX);
  const all = Array.isArray(d.lenders) ? d.lenders : [];
  const page = all.slice(offset, offset + limit);
  let returnedItemCount = 0;
  const lenders = page.map((g) => {
    const items = (g.items || []).slice(0, itemLimit);
    returnedItemCount += items.length;
    return { lender: g.lender, investor: g.investor || null, lenderId: g.lenderId || null,
      itemCount: g.itemCount, itemTruncated: (g.items || []).length > items.length, items };
  });
  const nextOffset = offset + page.length < all.length ? offset + page.length : null;
  const out = {
    ready: d.ready !== undefined ? d.ready : true,
    lenderCount: d.lenderCount, itemCount: d.itemCount, reasonCount: d.reasonCount,
    returnedLenderCount: lenders.length, returnedItemCount,
    truncated: nextOffset != null || lenders.some((l) => l.itemTruncated),
    page: { limit, offset, itemLimit, nextOffset },
    lenders,
  };
  return opts.debug ? { disqualified: out, rawSummary: opts.rawSummary || null } : { disqualified: out };
}
// Read pagination controls from a request (query on GET, body on POST).
function pageOptsOf(req) {
  const q = req.query || {}; const b = req.body || {};
  return { limit: b.limit != null ? b.limit : q.limit, offset: b.offset != null ? b.offset : q.offset, itemLimit: b.itemLimit != null ? b.itemLimit : q.itemLimit };
}

// GET /disqualifications/:searchKey  (also POST with { searchKey }) — the POLL-ONLY status route.
// A prior POST /price kicked off the async ineligible computation and returned the searchKey; this
// polls the SAME computation (the stored kickoff body, only cachedDisqualified flipped) exactly
// ONCE. It never rebuilds or restarts the search. 200 = ready, 202 = still computing (poll again),
// 409 = unknown/expired searchKey (re-run /price).
async function disqualifications(req, res) {
  const body = req.body || {};
  const searchKey = (req.params && req.params.searchKey) || body.searchKey;
  if (!searchKey) return res.status(400).json({ ok: false, error: 'missing_search_key', message: 'Provide the searchKey returned by POST /price.' });
  const pr = await lp.pollDisqualifiedByKey(searchKey);
  if (pr.unknown) return res.status(409).json({ ok: false, error: 'unknown_search_key', searchKey,
    message: 'No kickoff found for this searchKey (it may have expired). Re-run POST /price to start the ineligible calculation, then poll the searchKey it returns.' });
  if (!pr.ok) { const code = (pr.http && pr.http >= 500) ? 502 : 400; return res.status(code).json({ ok: false, error: pr.error, http: pr.http || null, message: pr.message, upstream: pr.upstream || pr.body || null }); }
  if (!pr.ready) { res.set('Retry-After', '2'); return res.status(202).json({ ok: true, ready: false, searchKey, retryAfterMs: 2000, message: 'Ineligible results still computing — poll again shortly.' }); }
  const parsed = pr.parsed || lp.parseDisqualified(pr.raw);
  return res.json({ ok: true, ready: true, searchKey, cached: !!pr.cached, ...shapeDisqualified(parsed, { debug: body.debug, rawSummary: pr.rawSummary, ...pageOptsOf(req) }) });
}

// POST /disqualify — body is a scenario (or { scenario }). Returns the QUALIFIED summary plus the
// DISQUALIFIED reasons per lender. Lender Price computes disqualifies ASYNCHRONOUSLY (a few minutes),
// so this kicks the computation off and polls the cached result within a bounded window; if it isn't
// ready in time it returns ready:false with the qualified data — call again and the cached result
// (built from the identical body) comes back quickly. Optional body: { maxWaitMs, pollMs, debug }.
async function disqualify(req, res) {
  const body = req.body || {};
  const sc = body.scenario ? body.scenario : body;
  if (rejectUnsupported(sc, res)) return;
  if (rejectInvalidRequest(sc, res)) return; // §26.5 — 422 a bad request BEFORE any upstream call
  // POLL-ONLY mode ({poll:true}): a prior /price already kicked off the async computation. This
  // just polls the cached result (no re-kickoff, no blocking loop) → 200 when ready, 202 while
  // still computing. This is the recommended flow (kick off on /price, then poll here every ~2s).
  if (body.poll) {
    const pr = await lp.pollDisqualified(sc);
    if (!pr.ok) {
      const code = (pr.http && pr.http >= 500) ? 502 : 400;
      return res.status(code).json({ ok: false, error: pr.error, http: pr.http || null, message: pr.message, upstream: pr.upstream || pr.body || null });
    }
    if (rejectInvalidValues(pr.request, res)) return;
    if (!pr.ready) return res.status(202).json({ ok: true, ready: false, retryAfterMs: 2000, message: 'Disqualify reasons still computing — poll again shortly.' });
    const shaped = shapeDisqualified(lp.parseDisqualified(pr.raw), { debug: body.debug, rawSummary: body.debug ? lp.summarizeRaw(pr.raw) : null, ...pageOptsOf(req) });
    return res.json({ ok: true, ready: true, ...shaped });
  }
  const opts = {};
  if (body.maxWaitMs != null) opts.maxWaitMs = Math.min(Number(body.maxWaitMs) || 0, 100000);
  if (body.pollMs != null) opts.pollMs = Math.max(Number(body.pollMs) || 0, 1000);
  const r = await lp.priceDisqualified(sc, opts);
  if (!r.ok) return res.status((r.http && r.http >= 500) ? 502 : 400).json(priceErrorBody(r));
  if (rejectInvalidValues(r.request, res)) return;
  const qualified = trimPrograms(lp.parse(r.qualified));
  const shaped = shapeDisqualified(lp.parseDisqualified(r.disqualified), { debug: body.debug, rawSummary: body.debug ? lp.summarizeRaw(r.disqualified) : null, ...pageOptsOf(req) });
  const out = { ok: true, ready: r.ready, polls: r.polls, message: r.message || null, qualified, ...shaped };
  res.json(out);
}

// POST /selftest — run the fixed battery; returns one row per scenario. Paced, gentle on the login.
async function selftest(req, res) {
  const results = [];
  for (const sc of BATTERY) {
    const r = await lp.price(sc);
    if (!r.ok) { results.push({ name: sc.name, ...priceErrorBody(r) }); continue; }
    const p = lp.parse(r.raw);
    const best = p.programs.reduce((m, x) => (x.minRate != null && (m == null || x.minRate < m) ? x.minRate : m), null);
    results.push({ name: sc.name, ok: true, programCount: p.programCount, lenderCount: p.lenderCount, rungCount: p.rungCount, bestRate: best });
    await new Promise((rs) => setTimeout(rs, 800));
  }
  res.json({ ok: results.every((x) => x.ok), count: results.length, results });
}

// A router with the endpoints wired. Auth is applied by the mount (staff at /api/lt, or the
// secret gate at /api/lt/_diag/lenderprice).
function makeRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  router.get('/health', (req, res) => health(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_health_error' })));
  router.get('/login-check', (req, res) => loginCheck(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_login_error' })));
  router.post('/price', (req, res) => price(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_price_error' })));
  // Poll-only ineligible status by searchKey (kicked off by POST /price) — never restarts the search.
  router.get('/disqualifications/:searchKey', (req, res) => disqualifications(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_disqualifications_error' })));
  router.post('/disqualifications', (req, res) => disqualifications(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_disqualifications_error' })));
  router.post('/disqualify', (req, res) => disqualify(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_disqualify_error' })));
  router.post('/selftest', (req, res) => selftest(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_selftest_error' })));
  return router;
}

module.exports = { makeRouter, handlers: { health, loginCheck, price, disqualify, disqualifications, selftest }, BATTERY };

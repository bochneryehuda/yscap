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
  'term', 'termYears', 'lockDays',
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

// GET /health — is the module up and are Lender Price credentials configured (no login attempted).
async function health(req, res) {
  res.json({ ok: true, product: 'long-term', feature: 'dscr-pricer', configured: lp.configured() });
}

// GET /login-check — actually attempt a login and report ok/failure (no pricing). Confirms the
// origin-gated login works from the server.
async function loginCheck(req, res) {
  const s = await lp.getSession({ force: true });
  if (!s.ok) return res.status(502).json({ ok: false, error: s.error, http: s.http || null, message: s.message });
  res.json({ ok: true, companyId: s.companyId, userId: s.userId, expiresAt: new Date(s.expiresAt).toISOString(), profile: s.profile });
}

// POST /price — body is a scenario (or { scenario }). Returns the parsed program summary.
async function price(req, res) {
  const sc = (req.body && req.body.scenario) ? req.body.scenario : (req.body || {});
  if (rejectUnsupported(sc, res)) return; // never silently ignore an unimplemented field
  const r = await lp.price(sc);
  if (!r.ok) {
    const code = (r.http && r.http >= 500) ? 502 : 400;
    return res.status(code).json({ ok: false, error: r.error, http: r.http || null, message: r.message, upstream: r.upstream || r.body || null });
  }
  const effective = effectiveOf(r.request); // requested-vs-effective transparency
  // full:true → the COMPLETE capture (every option's price build, itemized LLPAs, margin/holdback,
  // comp, fees, ratios, monthly payment). Add raw:true to also attach each option's untouched leaf.
  if (req.body && req.body.full) {
    const full = lp.parseFull(r.raw, { raw: !!req.body.raw });
    const out = { ok: true, ...full, effectiveScenario: effective, request: r.request };
    if (req.body.debug) out.rawSummary = lp.summarizeRaw(r.raw);
    return res.json(out);
  }
  const parsed = lp.parse(r.raw);
  const out = { ok: true, ...trimPrograms(parsed), effectiveScenario: effective, request: r.request };
  // Secret-gated diagnostics (the whole router is behind the diag token / staff login): when the
  // caller asks, include a structural summary of the raw response so we can see whether Lender
  // Price returned programs the parser missed, or truly zero — and any disqualify reasons.
  if (req.body && req.body.debug) out.rawSummary = lp.summarizeRaw(r.raw);
  res.json(out);
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
  // POLL-ONLY mode ({poll:true}): a prior /price already kicked off the async computation. This
  // just polls the cached result (no re-kickoff, no blocking loop) → 200 when ready, 202 while
  // still computing. This is the recommended flow (kick off on /price, then poll here every ~2s).
  if (body.poll) {
    const pr = await lp.pollDisqualified(sc);
    if (!pr.ok) {
      const code = (pr.http && pr.http >= 500) ? 502 : 400;
      return res.status(code).json({ ok: false, error: pr.error, http: pr.http || null, message: pr.message, upstream: pr.upstream || pr.body || null });
    }
    if (!pr.ready) return res.status(202).json({ ok: true, ready: false, retryAfterMs: 2000, message: 'Disqualify reasons still computing — poll again shortly.' });
    const d = lp.parseDisqualified(pr.raw);
    const outp = {
      ok: true, ready: true,
      disqualified: { ready: true, lenderCount: d.lenderCount, itemCount: d.itemCount, reasonCount: d.reasonCount,
        lenders: d.lenders.slice(0, 80).map((g) => ({ lender: g.lender, investor: g.investor || null, lenderId: g.lenderId || null, itemCount: g.itemCount, items: g.items.slice(0, 40) })) },
    };
    if (body.debug) outp.rawSummary = lp.summarizeRaw(pr.raw);
    return res.json(outp);
  }
  const opts = {};
  if (body.maxWaitMs != null) opts.maxWaitMs = Math.min(Number(body.maxWaitMs) || 0, 100000);
  if (body.pollMs != null) opts.pollMs = Math.max(Number(body.pollMs) || 0, 1000);
  const r = await lp.priceDisqualified(sc, opts);
  if (!r.ok) {
    const code = (r.http && r.http >= 500) ? 502 : 400;
    return res.status(code).json({ ok: false, error: r.error, http: r.http || null, message: r.message, upstream: r.upstream || r.body || null });
  }
  const qualified = trimPrograms(lp.parse(r.qualified));
  const disq = lp.parseDisqualified(r.disqualified);
  const out = {
    ok: true,
    ready: r.ready,
    polls: r.polls,
    message: r.message || null,
    qualified,
    disqualified: {
      ready: disq.ready,
      lenderCount: disq.lenderCount,
      itemCount: disq.itemCount,
      reasonCount: disq.reasonCount,
      lenders: disq.lenders.slice(0, 80).map((g) => ({
        lender: g.lender,
        investor: g.investor || null,
        lenderId: g.lenderId || null,
        itemCount: g.itemCount,
        items: g.items.slice(0, 40),
      })),
    },
  };
  if (body.debug) out.rawSummary = lp.summarizeRaw(r.disqualified);
  res.json(out);
}

// POST /selftest — run the fixed battery; returns one row per scenario. Paced, gentle on the login.
async function selftest(req, res) {
  const results = [];
  for (const sc of BATTERY) {
    const r = await lp.price(sc);
    if (!r.ok) { results.push({ name: sc.name, ok: false, error: r.error, http: r.http || null, message: r.message, upstream: r.upstream || r.body || null }); continue; }
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
  router.post('/disqualify', (req, res) => disqualify(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_disqualify_error' })));
  router.post('/selftest', (req, res) => selftest(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_selftest_error' })));
  return router;
}

module.exports = { makeRouter, handlers: { health, loginCheck, price, disqualify, selftest }, BATTERY };

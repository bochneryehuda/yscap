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
// The white-label sheet + investor identity for every answer (owner-directed
// 2026-08-27). Decoration only: it annotates what Lender Price returned and
// never filters, narrows or re-orders anything — the display overlay lives on
// the screen, and the search always asks for everything.
const investorPrograms = require('../lenderprice/investor-programs');
const nearTier = require('../pricing/near-tier');
const ineligibility = require('../pricing/ineligibility');
const generalBoard = require('../pricing/general-board');
const searchRecord = require('../pricing/search-record');
/* THE SECOND RATE SHEET. Required here so the bracket loop can hand both clients to
   `generalBoard`; it is never called unless an investor is routed to it, and a portal
   with no credentials simply refuses, which leaves the board Lender Price's alone —
   exactly what this screen did before. */
const nex = require('../loannex/client');
const { REGISTRY_FIELDS } = require('../lenderprice/field-registry');
const zipCounty = require('../lenderprice/zip-county');
const settingsStore = require('../settings/store');
const { resolveCompPlan } = require('../comp-plan');
const bracketRun = require('../pricing/bracket-run');
const { REGISTRY_WARNINGS, CASHOUT_INTERNAL, validateScenario, _internals: modelInternals } = require('../lenderprice/search-model');

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
      // The canonical investor identity + white-label (2026-08-27) — null when
      // the caller did not run the answer through investorPrograms.decorate.
      investorKey: p.investorKey != null ? p.investorKey : null,
      whiteLabel: p.whiteLabel != null ? p.whiteLabel : null,
      consumerLabel: p.consumerLabel != null ? p.consumerLabel : null,
      program: p.program, product: p.product || null,
      // §38 — the sheet this program priced from. Two channels of one lender can share a program
      // NAME with different ladders (measured: ResiCentral non-del vs wholesale), so a summary
      // that names the program without its sheet is ambiguous about which ladder it describes.
      rateSheetName: p.rateSheetName || null,
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
  'propertyType', 'units', 'attachment', 'attachmentType', 'nonWarrantable', 'zip', 'state', 'county', 'countyFps', 'city', 'countyName',
  'borrowerType', 'prepayMonths', 'io', 'escrowWaive', 'fthb', 'date', 'rentalTerm', 'reservesMonths',
  'term', 'termYears', 'lockDays', 'cashoutAmount',
  // §33.2/§33.3 — the two menu fields the builder used to hard-code (IncomeDocType always "DSCR",
  // PrePayment_Plan_Type always "Standard"). Both carry the CONFIRMED live token sets; an
  // unrecognized value is 422'd (invalid_income_doc_type / invalid_prepay_structure), never
  // defaulted. prepayStructure is independent of prepayMonths.
  'incomeDocType', 'prepayStructure',
  // §31.5 — subordinate (closed-end second) amount + broker comp percent. The comp percent is
  // entered as the POSITIVE number a human sees; the vendor's negative wire form is produced by one
  // named conversion in the builder. HELOC/HELOAN subtype selectors stay unsupported (uncaptured).
  'subordinateLoanAmount', 'compPercent',
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
  const a = p.address || {};
  return {
    loanPurpose: c.loanPurpose, purchasePrice: c.purchasePrice, appraisedValue: c.appraisedValue,
    // The cash-out amount as actually TRANSMITTED (numeric criteria.cashoutAmount). The internal copy
    // is kept beside it deliberately: the two are written from the same value, so a caller comparing
    // them proves the amount reached the wire rather than only the diagnostics. They can never tell
    // two different stories without one of them being a bug.
    cashoutAmount: c.cashoutAmount,
    cashoutAmountInternal: payload[CASHOUT_INTERNAL] != null ? payload[CASHOUT_INTERNAL] : undefined,
    loanAmount: c.loanAmount, ltv: c.ltv, fico: c.fico, dscr: c.dscr,
    // §31.5 — the subordinate lien actually transmitted, and the broker comp plan in the vendor's own
    // NEGATIVE wire form (a visible 2.5% reads here as -2.5), so a caller can confirm the sign
    // conversion was applied rather than guessing at it.
    subordinateLoanAmount: c.subordinateLoanAmount,
    compPlan: payload.brokerCriteria && payload.brokerCriteria.compPlan,
    // §32.3 — the derived DSCR band token actually transmitted (dynamicPropertiesMap.DSCRRATIO), so a
    // caller can confirm the reviewed threshold table was applied to the entered DSCR.
    dscrRatio: dyn('DSCRRATIO'),
    loanYear: c.loanYear, termsCriteria: payload.termsCriteria, termsInMonths: payload.termsInMonths,
    dayLocks: payload.brokerCriteria && payload.brokerCriteria.dayLocks, dayLocksCriteria: payload.dayLocksCriteria,
    loanType: c.loanType, loanTypeCriteria: payload.loanTypeCriteria,
    propertyUse: c.propertyUse, propertyType: p.propertyType, numberOfUnit: p.numberOfUnit, attachmentType: p.attachmentType,
    // Complete location actually transmitted (audit — effectiveScenario was incomplete).
    location: { zip: a.zip, state: a.state, city: a.city, county: a.county, censustract: a.censustract, countyName: a.countyName },
    interestOnly: c.interestOnly, escrowWaiver: c.escrowWaiver, firstTimeHomeBuyer: c.firstTimeHomeBuyer,
    // Reserves / rental-term / prepay-structure selectors (audit — must appear in effectiveScenario).
    reserves: dyn('GLOBAL_RESERVES'), addlOccupancyType: dyn('AddlOccupancyType'),
    prepayPlanType: dyn('PrePayment_Plan_Type'),
    compensationType: c.compensationType, incomeDocType: dyn('IncomeDocType'), borrowerType: dyn('GLOBAL_BorrowerType'),
    // Every special-mortgage-option IDENTITY (id + name), not just the names, so a caller can verify
    // the exact program-selecting options that were transmitted (audit).
    prepayTerm: dyn('PrepayTerm'),
    specialMortgageOptions: Array.isArray(c.specialMortgageOptions) ? c.specialMortgageOptions.map((s) => (s && (s.name || s.id)) ? { id: s.id || null, name: s.name || null } : null).filter(Boolean) : undefined,
    // Registry-backed advanced fields ACTUALLY sent upstream — so a caller can confirm a supported
    // advanced field was applied (not silently dropped). Only present when non-default.
    nonWarrantableProject: c.nonWarrantableProject,
    selfEmployed: c.selfEmployed, monthlyIncome: c.monthlyIncome, monthlyDebt: c.monthlyDebt,
    clientDti: c.clientDti, numberOfBorrower: c.numberOfBorrower, ownProperties: c.ownProperties,
    lenderFeeWaiver: c.lenderFeeWaiver, rural: c.rural,
    citizenship: dyn('Citizenship'), tradelines: dyn('Tradelines'),
    mixedUse: dyn('GLOBAL_MixedUse'), noMortgageHistory: dyn('GLOBAL_NoMortgageHistory'),
    crossCollateral: dyn('GLOBAL_Cross_Collateralization_Product'), firstTimeInvestor: dyn('FirstTimeInvestor'), livingRentFree: dyn('Global_Living_Rent_Free'),
    // §31.3/§31.7 — the two true-only flags. Echoed like every sibling above so a caller can confirm
    // they were applied; asset depletion carries the vendor's "Yes" (not "true"), which is precisely
    // the distinction worth being able to SEE on the wire.
    dscrAssetDepletion: dyn('Global_DSCR_Asset_Depletion'), lateInLast12Months: dyn('Lateinlast12months'),
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
// Returns `null` when the request is fine — and, crucially, the ENRICHED scenario to price from.
// validateScenario fills a caller's location from its ZIP (state / county / county FIPS), so the
// caller MUST go on to price the returned scenario: pricing the original would validate one request
// and send a different, county-less one upstream.
function rejectInvalidRequest(sc, res) {
  const v = validateScenario(sc);
  if (!v.ok) {
    const body = { ok: false, error: v.error, message: v.message };
    if (v.field) body.field = v.field;
    if (v.warnings) body.warnings = v.warnings;
    res.status(v.status || 422).json(body);
    return { rejected: true };
  }
  // ⛔ `dscrClamped` RIDES THROUGH HERE OR IT NEVER REACHES ANYBODY. The validator
  // reports a typed over-ceiling ratio it priced at the ceiling instead; dropping it
  // at this hop would leave every door reading `undefined` and the officer told
  // nothing — the number changed behind them, which is the one thing the clamp was
  // not allowed to do.
  /* ⛔ AND SO DOES THE STATIC REQUEST BUILD. `wantFrom` mirrors the body Lender Price was
     actually sent to narrow the LoanNEX board on interest-only and the rate lock; the WIRE
     body wins, and this is the fallback for a search where Lender Price never answered.
     Dropping it here left the board with nothing to fall back to. */
  return { rejected: false, scenario: v.scenario || sc, countyEnrichment: v.countyEnrichment || null, dscrClamped: v.dscrClamped || null, request: v.request || null };
}

// Cash-out amount ("cash in hand") transparency — so it is never SILENTLY handled either way. It is
// now TRANSMITTED as numeric `criteria.cashoutAmount` (see search-model.js for why that captured key
// may be sent while the frontend's `dynamicPropertiesMap.undefined` bug never could). The note exists
// because "we sent it" and "we kept it back" must be distinguishable by a caller reading the response
// rather than by reading our source. Returns null when no cash-out amount was supplied; must agree
// with effectiveScenario.cashoutAmount in the same response.
function cashoutNote(sc) {
  if (!sc || sc.cashoutAmount == null || sc.cashoutAmount === '') return null;
  return {
    value: sc.cashoutAmount,
    transmitted: true,
    field: 'criteria.cashoutAmount',
    note: 'Transmitted as numeric criteria.cashoutAmount — the captured vendor field. PILOT no longer withholds it; the earlier fail-closed behaviour existed because the only evidence then was the frontend dynamicPropertiesMap.undefined bug, which is not a field name.',
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

// GET /login-check — actually attempt a PASSWORD login and report ok/failure (no pricing). Confirms
// the origin-gated login works from the server, with the credentials Render actually holds.
//
// IT MUST CALL `login()`, NOT `getSession()`. This read used to be `getSession({ force: true })`,
// which was exactly right while a renewal could only ever BE a password login. Once the refresh
// grant landed, `force` still skips the freshness check but the renewal ladder then picks the
// REFRESH grant — so on a long-running instance holding a warm session this endpoint would renew
// happily and answer `200 {ok:true}` while `LP_USERNAME`/`LP_PASSWORD` were wrong, expired or locked
// at the vendor. That is precisely the state it exists to detect, and the README tells an operator to
// curl it to verify credentials after setting them, so a green answer would have been believed.
// Caught by the pre-merge audit of the renewal change and reproduced: with the password grant
// answering 401 and the refresh grant answering 200, the old line returned ok with a fresh token.
//
// Nothing is CACHED from this check on purpose: `login()` does not touch the warm session, so a
// diagnostic can never install a session as a side effect, and a failing check leaves whatever was
// working still working.
async function loginCheck(req, res) {
  const s = await lp.login();
  if (!s.ok) return res.status(502).json({ ok: false, error: s.error, http: s.http || null, message: s.message });
  res.json({ ok: true, grant: 'password', companyId: s.companyId, userId: s.userId, expiresAt: new Date(s.expiresAt).toISOString(), profile: s.profile });
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

// §36.11 — the REQUESTED scenario, echoed back exactly as the caller sent it (minus the request
// envelope keys, which are not pricing inputs). Paired with `derivedScenario` and `effectiveScenario`
// this is what lets a caller prove a short request was expanded into the intended full DSCR profile
// rather than inheriting a stale search: requested says what they asked for, derived says what the
// server worked out from it, effective says what actually went upstream.
function requestedOf(sc) {
  const out = {};
  for (const k of Object.keys(sc || {})) if (!META_FIELDS.has(k)) out[k] = sc[k];
  return out;
}
// §35.2/§36.2 — what the amount triangle DERIVED, and from what. Reports only the figures the server
// worked out itself, so a caller can see e.g. that a value of 533333.33 came from their loan + LTV
// and was never something they supplied.
function derivedOf(sc) {
  const t = modelInternals && modelInternals.deriveAmounts ? modelInternals.deriveAmounts(sc) : null;
  if (!t) return null;
  return { value: t.value, loan: t.loan, ltv: t.ltv, derived: t.derived, supplied: t.supplied };
}

// POST /price — body is a scenario (or { scenario }). Returns the parsed program summary.
/**
 * POST /price-brackets — THE DSCR-BRACKET-AWARE BOARD (owner-directed 2026-09-01).
 *
 * The ordinary `/price` door asks the vendor ONE question, at one assumed ratio,
 * and every rate it answers with is priced as though the loan achieves that
 * ratio. It does not: the rate decides the payment and the payment is the DSCR's
 * denominator, so an expensive rate can leave a ratio in a band the loan never
 * reaches. That is the owner's own report — a rate offered at 11.125% priced as
 * though the loan were at 1.25 while its true ratio is 0.93 — and the term sheet
 * correctly refuses to issue it.
 *
 * This door asks the question once per DSCR bracket and returns the rates grouped
 * by the bracket each rate's own ratio reaches. `pricing/bracket-run` owns the
 * sequencing and `pricing/bracket-board` owns every rule; this handler only
 * supplies the vendor and shapes the answer.
 *
 * ⛔ IT ADDS NOTHING TO THE SEARCH ITSELF. Each bracket is priced through the
 * SAME `lp.price` + `lp.parse` + `investorPrograms.decorate` the ordinary board
 * runs, with one field different: the ratio. A second pricing path here would be
 * a second answer to what this deal is.
 */
/**
 * THE WHOLE BRACKET BOARD, AS A FUNCTION OF THE REQUEST — the body BOTH doors run.
 *
 * ⛔ TWO TRANSPORTS, ONE PIECE OF WORK (owner-directed 2026-09-04, the progress bar:
 * *"You shouldn't feel like the system forgot about you"*). `POST /price-brackets`
 * answers one JSON object when it is finished; `POST /price-brackets/stream` reports
 * each band as it lands and then the same object. A second handler for the streaming
 * door would be a second answer to what this deal is — the exact defect the header
 * above warns about — so the door decides only how the answer TRAVELS.
 *
 * It returns `{ status, body }` and touches `res` for one thing only: the 4xx refusals
 * that must happen BEFORE anything is streamed (see `startStream` below). Everything
 * else is the caller's to send.
 */
async function bracketBoardFor(req, res, onProgress) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let sc = body.scenario ? body.scenario : body;
  // ⛔ THESE TWO ANSWER `res` THEMSELVES AND THEY RUN BEFORE ANY VENDOR CALL, which is
  // exactly why the streaming door can still send a real HTTP status: nothing has been
  // written when they fire. `handled` tells the caller the response is already gone.
  if (rejectUnsupported(sc, res)) return { handled: true };
  const chk = rejectInvalidRequest(sc, res);
  if (chk.rejected) return { handled: true };
  const requestedScenario = requestedOf(sc);
  sc = chk.scenario;

  /* THE FIGURES A RATIO IS WORKED OUT FROM. They are read from the SCENARIO the
     officer already filled in — the same boxes the pricing engine's own DSCR
     calculator uses — so there is no second form to keep in step and no way for
     the board to bracket by figures the screen is not showing. A caller may
     override them explicitly (`figures`), which is what the saved-scenario re-run
     path needs. */
  const figures = Object.assign({
    rentMonthly: sc.rentMonthly, taxMonthly: sc.taxMonthly, insuranceMonthly: sc.insuranceMonthly,
    hoaMonthly: sc.hoaMonthly, loanAmount: sc.loan != null ? sc.loan : sc.loanAmount,
    termYears: sc.termYears != null ? sc.termYears : sc.term, interestOnly: !!sc.interestOnly,
  }, (body.figures && typeof body.figures === 'object') ? body.figures : {});

  // Filled by whichever band search answers FIRST, which is all these are for:
  // echoing what the vendor understood and where the pricing config came from.
  let firstRequest = null;
  let provenance = null;
  /* ⛔ THE ONE PLACE THE SECOND RATE SHEET ENTERS THIS SCREEN (owner-directed 2026-09-03:
     *"we're just adding a new source for these investors"*). The configuration is read
     ONCE for the whole search — not per band, which would spend a settings round trip on
     every band and could price two bands under two different configurations if somebody
     saved between them. With nobody routed to LoanNEX this costs nothing and no second
     vendor call is made at all. */
  const cfg = await generalBoard.loadConfig({
    routes: body.routes, links: body.links, marginHoldback: body.marginHoldback,
  });
  // The static Lender Price build, as the narrowing's fallback (see `rejectInvalidRequest`).
  cfg.staticRequest = chk.request || null;

  /* WHAT EACH SHEET ACTUALLY PRODUCED, AND WHO THE SECOND SHEET DID NOT CARRY, ACROSS THE
     WHOLE SEARCH. One search asks the sheets once per DSCR band, and an investor that answers
     in one band and not another is still an investor that sheet CARRIES — so the bands are
     unioned and both registers are written ONCE at the end. Writing per band would spend a
     settings round trip per band and, worse, would record a narrow band's silence as evidence
     about the sheet.

     ⛔ THE SAME COLLECTOR THE IMMEDIATE BOARD USES. Both doors search, so both doors are
     evidence; a second copy of these rules here is how one door starts recording a sighting
     the other does not and the settings screen answers differently depending on which door
     the officer happened to trigger. */
  const searchSeen = searchRecord.collector();

  const runSearch = async (dscr) => {
    // A null ratio is the officer's own scenario, untouched — the probe.
    const one = dscr == null ? sc : Object.assign({}, sc, { dscr });
    /* Both sheets, at once, for THIS band. The Lender Price half is passed through
       untouched but for its programme list, so the bracket loop, the board and the
       details panel below read exactly what they read before. */
    const r = await generalBoard.boardForScenario(one, { lp, nex, investorPrograms }, cfg);
    if (!r.ok) return { ok: false, error: r.error || 'lp_price_failed', message: r.message || null, http: r.http || null };
    if (firstRequest == null) { firstRequest = r.request; provenance = r.provenance || null; }
    searchSeen.observe(r);
    /* ⛔ THE FULL PARSE, NOT THE SUMMARY — done inside `boardForScenario`, which returns
       the same `parseFull` answer with only its programme list replaced. A band has to
       render with the SAME code the whole board renders with (the owner: *"Every rate and
       every investor added, but that whole section should be divided in brackets, and it
       should work the same"*), and the details panel is built on `priceBuild` / the
       itemised LLPAs, which only the full parse carries. */
    return {
      ok: true,
      parsed: r.parsed,
      meta: {
        searchKey: r.searchKey,
        sentDscr: dscr,
        pricedAt: r.parsed.pricedAt || null,
        // Investors this search expected from the second sheet and did not get. Carried
        // out for the review record; the board itself says nothing about them.
        missingFromLoanNex: r.missing,
        sources: r.sources,
      },
    };
  };

  const out = await bracketRun.priceByBracket(figures, runSearch, {
    // Passed straight through: the loop reports, this door only forwards. A door that
    // is not streaming hands over nothing and the loop's `say` becomes a no-op.
    onProgress: typeof onProgress === 'function' ? onProgress : undefined,
    rounds: Number.isInteger(body.rounds) ? body.rounds : undefined,
    /* WHERE TO START. A ratio the officer typed wins; with none, `seedRatioFrom`
       works one out from a typical coupon — the owner's *"we don't need a target rate
       anymore… do it in your backend"*. Either way it only picks the FIRST band: the
       frontier finds the rest from what the vendor actually returns, so nothing is
       priced on the seed and a seed a little off costs one extra round, not a wrong
       price. */
    seedDscr: sc.dscr,
    /* AND THE RATES OFF THAT BOARD, when the caller hands them over. They sharpen the
       first round's search ratios (the lowest ratio a band actually reaches, rather
       than the band's floor). Optional by design: the loop works without them. */
    seenQuotes: Array.isArray(body.seenQuotes) ? body.seenQuotes : [],
  });
  /* ⛔ RECORD WHAT THIS SEARCH SAW — ONCE, AFTER IT, AND NEVER AT ITS COST.
     Two registers, both written by the shared collector so the immediate board and the
     bands door can never record the same search differently:

     THE SIGHTINGS — owner-directed 2026-09-03, the side-by-side list shows *"which systems
     that investor is available on"*, and *"If you see a new investor populating in any of
     the systems, just add that to the list."*

     THE MISSES — an investor the settings point at LoanNEX which LoanNEX answered without
     carrying is left OFF the board silently and recorded here instead (owner-directed: the
     miss is left out silently and the super admin is emailed, plus a manual review section
     recording the scenario, which investor was missed, and whether the other sheet had it).
     Silently, because once an investor is switched over the other sheet's copy of its
     pricing is second-hand — showing it would be quoting a sheet we have stopped trusting
     for that investor. A sheet that REFUSED files nothing at all: the board returns an empty
     `missing` for it, so one outage can never file forty reviews.

     Best-effort throughout, and OFF THE RESPONSE PATH: the officer's board is
     already built, and `flush` can reach an outbound email (measured: 161 ms to
     answer without it, 3,183 ms with a three-second provider). `later` runs it
     after the answer has gone and can never reject. */
  searchRecord.later(() => searchSeen.flush({ staffId: (req.actor && req.actor.id) || null, scenario: sc }));

  if (!out.ok) {
    // A refusal here is about the DEAL (not enough figures to bracket by) or the
    // vendor (the first search did not answer). Those need different actions, so
    // they carry different codes and neither is dressed up as the other.
    const status = out.error === 'lt_bracket_figures_incomplete' ? 422 : 502;
    return { status, body: out };
  }
  return {
    status: 200,
    body: Object.assign({ ok: true }, out, {
      requestedScenario,
      derivedScenario: derivedOf(sc),
      countyEnrichment: chk.countyEnrichment,
      dscrClamped: chk.dscrClamped || null,
      effectiveScenario: firstRequest ? effectiveOf(firstRequest) : null,
      provenance,
    }),
  };
}

/** THE PLAIN DOOR — one JSON object, exactly as it has always answered. */
async function priceBrackets(req, res) {
  const out = await bracketBoardFor(req, res, null);
  if (!out || out.handled) return;
  res.status(out.status).json(out.body);
}

/**
 * THE SAME BOARD, REPORTED AS IT IS BUILT — newline-delimited JSON.
 *
 * ⛔ WHY A STREAM AND NOT A PROGRESS TABLE THE SCREEN POLLS. A poll needs somewhere to
 * keep the run's state between two requests, and any such place is either a table
 * written a dozen times per search or a module-level map that answers correctly only
 * while one process serves both requests. The work and the report travel on the ONE
 * connection that is already open for exactly as long as the work lasts, so there is no
 * shared state to keep, nothing to expire, and no second request that can be routed
 * somewhere the first one never reached.
 *
 * ⛔ ONE LINE, ONE JSON OBJECT, AND THE LAST ONE IS ALWAYS THE ANSWER (`t: 'result'`).
 * A reader that understands nothing else can ignore every `t: 'progress'` line and read
 * the last one — which is precisely what the fallback path in the browser does.
 *
 * ⛔ THE STATUS CODE IS SPENT BEFORE THE FIRST BYTE. Once a 200 and the headers have
 * gone there is no way back to a 502, so a refusal AFTER streaming begins travels as a
 * result line carrying its own `ok:false` and `error`. The refusals that can be known
 * up front (`rejectUnsupported`, `rejectInvalidRequest`) run before any of this and
 * still answer with a real status — which is why `bracketBoardFor` does those two
 * first and says `handled`.
 *
 * ⛔ AND IT NEVER LETS A PROXY HOLD THE LINES BACK. `X-Accel-Buffering: no` and
 * `Cache-Control: no-transform` are the two that make an nginx in front of this
 * forward each line rather than collect them into one response at the end — which
 * would leave a progress bar that fills in a single jump once the work is over.
 */
/* `board` is the work, injected with its real default. It is a seam for the TEST and
   nothing else: the transport above — the headers, the framing, which failures can
   still be a status and which have to travel as a line — is the part with the traps in
   it, and it cannot be exercised through a door that needs two live rate sheets. The
   production call passes nothing. */
async function priceBracketsStream(req, res, board = bracketBoardFor) {
  let started = false;
  const send = (obj) => {
    if (res.writableEnded) return;
    try { res.write(`${JSON.stringify(obj)}\n`); } catch (_) { /* the reader left */ }
  };
  const start = () => {
    if (started) return;
    started = true;
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  };
  let out;
  try {
    out = await board(req, res, (event) => { start(); send({ t: 'progress', ...event }); });
  } catch (e) {
    // A throw after the headers have gone cannot be a 500 any more — say so on the wire.
    if (started) {
      send({ t: 'result', ok: false, error: 'lt_dscr_price_brackets_error', message: (e && e.message) || null });
      return res.end();
    }
    throw e;
  }
  // One of the up-front refusals already answered with its own status.
  if (!out || out.handled) return;
  if (!started) {
    // Nothing was ever reported (a refusal before the first band, or a runner with no
    // work to do), so the plain status is still available and is the honest answer.
    return res.status(out.status).json(out.body);
  }
  send({ t: 'result', ...out.body });
  return res.end();
}

async function price(req, res) {
  let sc = (req.body && req.body.scenario) ? req.body.scenario : (req.body || {});
  if (rejectUnsupported(sc, res)) return; // never silently ignore an unimplemented field
  const chk = rejectInvalidRequest(sc, res); // §26.5 — 422 a bad request BEFORE any upstream call
  if (chk.rejected) return;
  // §36.11 — CAPTURE THE CALLER'S OWN SCENARIO BEFORE ENRICHING IT. `requestedScenario` means "what
  // the caller sent"; taking it after the reassignment below made it echo the DERIVED location too,
  // so requested and effective agreed on the location BY CONSTRUCTION and the very comparison the
  // triple exists for was defeated (post-merge audit of #1220).
  const requestedScenario = requestedOf(sc);
  sc = chk.scenario; // price the ZIP-ENRICHED scenario, never the original
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // full:true → the COMPLETE capture (every option's price build, itemized LLPAs, margin/holdback,
  // comp, fees, ratios, monthly payment). A price is ALSO the disqualify kickoff — hand back the
  // stable searchKey so the caller polls GET /disqualifications/:searchKey instead of restarting.
  if (body.full) {
    /* ⛔ THE INITIAL BOARD IS BUILT FROM BOTH RATE SHEETS — the SAME `boardForScenario`
       router the bracket door uses (owner-directed 2026-09-03: *"It should follow the same
       exact path… right away, it searches the initial stuff and then it starts dividing it
       into the bands."*). So LoanNEX appears on the immediate unbanded board exactly as
       Lender Price does, and the bracket door then divides that same board into DSCR bands.

       Nobody routed to LoanNEX → `boardForScenario` makes no second vendor call at all
       (`wantLoanNex`), so a shop that has switched no investor over prices exactly as before,
       at Lender Price speed. A LoanNEX that refuses never costs the board: the router asks the
       sheets with `allSettled` and returns the Lender Price half on its own. The
       initial board CARRIES `sources`/`missing` as truthful data, but the general-engine
       screen does not yet render a no-login banner from them — wiring that banner is the
       owner's call, not a silent side effect of this change. */
    const cfg = await generalBoard.loadConfig({ routes: body.routes, links: body.links, marginHoldback: body.marginHoldback });
    cfg.debug = !!body.debug; cfg.raw = !!body.raw; // dev diagnostics, parity with the summary door
    cfg.staticRequest = chk.request || null; // the narrowing's fallback (see `rejectInvalidRequest`)
    const board = await generalBoard.boardForScenario(sc, { lp, nex, investorPrograms }, cfg);
    if (!board.ok) return res.status((board.http && board.http >= 500) ? 502 : 400).json(priceErrorBody(board));
    if (rejectInvalidValues(board.request, res)) return; // a supported field carried an unrecognized value

    /* ⛔ THIS DOOR IS EVIDENCE TOO (owner-reported 2026-09-03: *"why the side by side doesn't
       work: it's not actually connected"*). It was not: both registers were written only by the
       DSCR-bands door, so a sheet could produce an investor on THIS board all day and the
       settings screen would go on saying it had never been seen there — and an investor LoanNEX
       quietly did not carry was never reported to anybody. This board is the first thing an
       officer sees, and on plenty of searches the only door that runs.

       The SAME collector the bands door uses, so the two doors can never record one search
       differently. Best-effort by construction: it swallows its own failures, and the board has
       already been built by the time it runs — and it runs OFF THE RESPONSE PATH, because on the
       first miss of a day the recording sends an email and this is the door an officer waits on. */
    /* ⛔ AND IT SAYS WHETHER IT IS THE WHOLE SEARCH. On the General Pricing Engine this
       press also fires the band door, which asks the SAME scenario across every band —
       so filing this board's misses here would email the super admin about an investor
       the same press is about to prove the sheet carries, and would count one press as
       two searches. `bandsFollow` is the screen's own honest answer to "am I about to
       run the bands?"; anything else (a saved-scenario re-run, an older bundle, another
       caller) leaves it unset and this door records in full, exactly as before. */
    searchRecord.later(() => searchRecord.recordOne(board, {
      staffId: (req.actor && req.actor.id) || null,
      scenario: sc,
      partOfLargerSearch: searchRecord.partOfLargerSearchFrom(body),
    }));

    const effectiveFull = effectiveOf(board.request); // requested-vs-effective transparency
    const out = {
      ok: true,
      // The FULL parse, its programme list already routed. Its programCount/lenderCount
      // describe the ROUTED board (recomputed in boardForScenario); rungCount and
      // disqualifiedCount stay the Lender Price half only (no board-level consumer reads
      // them on this door — the desk reads per-programme p.rungCount).
      ...board.parsed,
      programs: board.programs,
      investorRoster: board.roster,          // the lens roster, for the routed board
      investorsUnmapped: board.unmapped,     // a lender quoting with no white-label name yet
      /* WHAT THE TWO SHEETS CALLED EACH INVESTOR ON THIS BOARD — the linking screen's input.
         STAFF-ONLY, like the whole of /api/lt (mounted requireAuth + requireStaff in server.js;
         the borrower's own router is a different mount), and the same field the COMBINED board
         has always returned. Without it the general engine's linking panel had no board to work
         from at all — see `general-board.js`. */
      investorPairing: board.investorPairing || null,
      missing: board.missing,                // investors LoanNEX was asked for and did not carry
      sources: board.sources,                // which sheet answered (truthful data; the general-engine
                                             // screen does not render a no-login banner from it yet)
      requestedScenario, derivedScenario: derivedOf(sc),
      countyEnrichment: chk.countyEnrichment, effectiveScenario: effectiveFull,
      cashoutAmount: cashoutNote(sc), dscrClamped: chk.dscrClamped || null,
      request: board.request, searchKey: board.searchKey,
      disqualifyStatus: 'computing', provenance: board.provenance || null, recovered: !!board.recovered,
      /**
       * ⛔ WHY AN INVESTOR IS NOT ON THIS BOARD — computed on every search since the board
       * became two-source, and thrown away until now. `applyRouting` builds all three, the
       * COMBINED engine has returned them since it shipped, and this door dropped them, so
       * two boards built by ONE function answered differently about the same search.
       *
       * `hidden[]` names each removal with its reason and its CLIENT-SAFE name (never the
       * vendor's spelling); `completeness` says vendor-neutrally whether both rate sheets
       * answered, so a short board is never silent; `settings` says how many routes applied
       * and what could not be read.
       */
      hidden: board.hidden || [],
      completeness: board.completeness || null,
      settings: board.settings || null,
      /* The hand-added investors this board was priced against, and what could not be read
         of them — so a shorter roster than somebody configured can say so. */
      customInvestors: board.customInvestors || null,
      /**
       * THE HANDLE FOR "WHY DID EVERY OTHER INVESTOR SAY NO" — both rate sheets.
       *
       * The general engine's own `/disqualify` door is Lender Price only and takes a
       * SCENARIO, so a LoanNEX refusal could never reach the not-eligible list even though
       * this very search already holds the tree id. Named for the MECHANISM, never the
       * vendor — one sheet computes its list asynchronously and is polled, the other answers
       * a whole tree at once — and the PORTAL is deliberately absent: the browser already
       * sent it, so it hands its own copy back rather than being told a hostname.
       */
      ineligibility: {
        pollKey: board.searchKey || null,
        treeId: (board.nx && board.nx.transactionId) || null,
      },
      /**
       * "YOU ARE ALMOST AT A BETTER TIER" — computed from the scenario the sheets were
       * actually asked about plus the grid cells THIS board carries, so it can name the
       * investor's real band rather than the standing steps. Never throws and never gates:
       * a hint beside a board must not be able to cost the board.
       */
      nearTier: nearTier.nearTier({
        value: sc.value,
        loan: sc.loan,
        ltvPct: sc.ltv != null ? (sc.ltv > 1 ? sc.ltv : sc.ltv * 100) : null,
        dscr: sc.dscr,
        lines: board.cells || [],
      }),
    };
    if (board.rawSummary) out.rawSummary = board.rawSummary; // only when body.debug asked for it
    return res.json(out);
  }

  // The SUMMARY door (a saved scenario re-run) stays Lender Price only, unchanged.
  const r = await lp.price(sc);
  if (!r.ok) return res.status((r.http && r.http >= 500) ? 502 : 400).json(priceErrorBody(r));
  if (rejectInvalidValues(r.request, res)) return; // a supported field carried an unrecognized value
  const effective = effectiveOf(r.request); // requested-vs-effective transparency
  const parsed = lp.parse(r.raw);
  const decoSummary = investorPrograms.decorate(parsed.programs);
  const out = { ok: true, ...trimPrograms({ ...parsed, programs: decoSummary.programs }), investorRoster: decoSummary.roster, investorsUnmapped: decoSummary.unmapped, requestedScenario, derivedScenario: derivedOf(sc), countyEnrichment: chk.countyEnrichment, effectiveScenario: effective, cashoutAmount: cashoutNote(sc), dscrClamped: chk.dscrClamped || null, request: r.request, searchKey: r.searchKey, disqualifyStatus: 'computing', provenance: r.provenance || null, recovered: !!r.recovered };
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
  // §C3 — a per-lender item OFFSET so a caller can page THROUGH a single lender's items when that
  // lender has more reasons/programs than itemLimit (previously the remainder was unreachable). Pair
  // it with lender limit=1 + offset=<lenderIndex> to walk one lender's items to the end.
  const itemOffset = clampInt(opts.itemOffset, 0, Number.MAX_SAFE_INTEGER, 0);
  const all = Array.isArray(d.lenders) ? d.lenders : [];
  const page = all.slice(offset, offset + limit);
  let returnedItemCount = 0;
  const lenders = page.map((g) => {
    const allItems = g.items || [];
    const items = allItems.slice(itemOffset, itemOffset + itemLimit);
    returnedItemCount += items.length;
    const consumed = itemOffset + items.length;
    return { lender: g.lender, investor: g.investor || null, lenderId: g.lenderId || null,
      // Canonical identity + white-label (2026-08-27), so the ONE investor filter
      // can drive the ineligible board too. Null when the group was not decorated.
      investorKey: g.investorKey != null ? g.investorKey : null,
      whiteLabel: g.whiteLabel != null ? g.whiteLabel : null,
      itemCount: g.itemCount,
      itemTruncated: consumed < allItems.length,
      itemOffset,
      itemNextOffset: consumed < allItems.length ? consumed : null, // cursor to this lender's remainder
      items };
  });
  const nextOffset = offset + page.length < all.length ? offset + page.length : null;
  const out = {
    ready: d.ready !== undefined ? d.ready : true,
    lenderCount: d.lenderCount, itemCount: d.itemCount, reasonCount: d.reasonCount,
    returnedLenderCount: lenders.length, returnedItemCount,
    truncated: nextOffset != null || lenders.some((l) => l.itemTruncated),
    page: { limit, offset, itemLimit, itemOffset, nextOffset },
    lenders,
  };
  return opts.debug ? { disqualified: out, rawSummary: opts.rawSummary || null } : { disqualified: out };
}
// Read pagination controls from a request (query on GET, body on POST).
function pageOptsOf(req) {
  const q = req.query || {}; const b = req.body || {};
  const pick = (k) => (b[k] != null ? b[k] : q[k]);
  return { limit: pick('limit'), offset: pick('offset'), itemLimit: pick('itemLimit'), itemOffset: pick('itemOffset') };
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
  // A COPY, never a mutation — pr.parsed can be the client's cached object, and
  // decorating it in place would grow annotations on a cache nobody asked to change.
  const decoDq = { ...parsed, lenders: investorPrograms.decorateDisqualifiedLenders(parsed.lenders) };
  return res.json({ ok: true, ready: true, searchKey, cached: !!pr.cached, ...shapeDisqualified(decoDq, { debug: body.debug, rawSummary: pr.rawSummary, ...pageOptsOf(req) }) });
}

// POST /disqualify — body is a scenario (or { scenario }). Returns the QUALIFIED summary plus the
// DISQUALIFIED reasons per lender. Lender Price computes disqualifies ASYNCHRONOUSLY (a few minutes),
// so this kicks the computation off and polls the cached result within a bounded window; if it isn't
// ready in time it returns ready:false with the qualified data — call again and the cached result
// (built from the identical body) comes back quickly. Optional body: { maxWaitMs, pollMs, debug }.
async function disqualify(req, res) {
  const body = req.body || {};
  let sc = body.scenario ? body.scenario : body;
  if (rejectUnsupported(sc, res)) return;
  const chk = rejectInvalidRequest(sc, res); // §26.5 — 422 a bad request BEFORE any upstream call
  if (chk.rejected) return;
  sc = chk.scenario; // price the ZIP-ENRICHED scenario, never the original
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
    const pd = lp.parseDisqualified(pr.raw);
    const shaped = shapeDisqualified({ ...pd, lenders: investorPrograms.decorateDisqualifiedLenders(pd.lenders) }, { debug: body.debug, rawSummary: body.debug ? lp.summarizeRaw(pr.raw) : null, ...pageOptsOf(req) });
    return res.json({ ok: true, ready: true, ...shaped });
  }
  const opts = {};
  if (body.maxWaitMs != null) opts.maxWaitMs = Math.min(Number(body.maxWaitMs) || 0, 100000);
  if (body.pollMs != null) opts.pollMs = Math.max(Number(body.pollMs) || 0, 1000);
  const r = await lp.priceDisqualified(sc, opts);
  if (!r.ok) return res.status((r.http && r.http >= 500) ? 502 : 400).json(priceErrorBody(r));
  if (rejectInvalidValues(r.request, res)) return;
  const qualified = trimPrograms(lp.parse(r.qualified));
  const pdFull = lp.parseDisqualified(r.disqualified);
  const shaped = shapeDisqualified({ ...pdFull, lenders: investorPrograms.decorateDisqualifiedLenders(pdFull.lenders) }, { debug: body.debug, rawSummary: body.debug ? lp.summarizeRaw(r.disqualified) : null, ...pageOptsOf(req) });
  const out = { ok: true, ready: r.ready, polls: r.polls, message: r.message || null, qualified, ...shaped };
  res.json(out);
}

/**
 * WHY EVERY OTHER INVESTOR SAID NO — BOTH RATE SHEETS, ONE LIST (owner's rule for this
 * engine: "it should sound like one system").
 *
 * ⛔ THE DEFECT THIS CLOSES. This engine's only ineligibility door is `POST /disqualify`,
 * which takes a SCENARIO and asks LENDER PRICE alone — so on a board where an investor is
 * routed to LoanNEX, that sheet's refusals could never reach the not-eligible list, even
 * though the price answer already held the tree id and simply dropped it. An officer read
 * a list that was silently half a list.
 *
 * ⛔ AND IT IS THE COMBINED ENGINE'S OWN BEHAVIOUR, not a second copy of it. The joining
 * rule, what `ready` means, and what happens when one half fails all live in
 * `pricing/ineligibility.js`; both doors call it, so the two screens cannot disagree about
 * one refusal.
 *
 * The old scenario-based door is UNTOUCHED — it re-prices and is the saved-scenario flow.
 */
/**
 * POST /ineligible — WHY EACH INVESTOR SAID NO, ACROSS BOTH RATE SHEETS.
 *
 * The JOIN is `pricing/ineligibility.collect`, the one definition both engines call, so the two
 * boards can never explain one refusal two ways. What is this door's own is the SHAPING:
 *
 * ⛔ THIS BOARD'S LIST HAS ALWAYS BEEN BOUNDED, AND IT STAYS BOUNDED. `GET /disqualifications`
 * runs every answer through `shapeDisqualified`, which caps lenders at LENDER_PAGE_MAX and each
 * lender's reasons at ITEM_PAGE_MAX and reports `truncated` + a cursor rather than trimming in
 * silence. Handing the joined result back raw would have quietly removed that ceiling from the
 * general board on the very change that makes the list LONGER — two sheets' refusals instead of
 * one. The combined door does not shape because it never did; a bound is a property of the DOOR,
 * not of the join, which is why it lives here and not in the shared module.
 */
async function ineligible(req, res) {
  const b = req.body || {};
  if (!b.pollKey && !b.treeId) return res.status(400).json(ineligibility.NO_HANDLE);
  const joined = await ineligibility.collect(
    { pollKey: b.pollKey, treeId: b.treeId, portal: b.portal, reveal: b.revealSource === true },
    { lp, nex, programs: investorPrograms },
  );
  const { disqualified, ...rest } = joined;
  return res.json({
    ...rest,
    ...shapeDisqualified(
      { ...disqualified, ready: joined.ready },
      { debug: b.debug, ...pageOptsOf(req) },
    ),
  });
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

// ---- ZIP -> state / county / county FIPS -------------------------------------
// WHAT IT IS FOR: the vendor's own screen fills the state and county in from a five-digit ZIP
// before it searches, and the owner asked for the same here. It is a LOOKUP, not a price — it costs
// no vendor call and touches no session, so it is safe to fire as somebody types.
//
// IT NEVER GUESSES. A ZIP the table does not carry (a PO-box-only ZIP has no ZCTA) answers 404 with
// a plain reason, so the screen says "we do not know this ZIP" instead of showing a county nobody
// resolved. And a ZIP that genuinely SPANS more than one county — 28% of them do — answers with the
// dominant one AND `split: true`, so the screen can say the county was inferred and let a human
// override it. Hiding that would put a confident county on a quote that nobody chose.
function zipLookup(req, res) {
  const raw = String((req.params && req.params.zip) || '').trim();
  if (!/^\d{5}$/.test(raw)) {
    return res.status(400).json({ ok: false, error: 'invalid_zip', message: 'A ZIP code is five digits.' });
  }
  // ⛔ AN UNEXPECTED THROW HERE MUST NOT LEAVE THE SCREEN WITH "something went wrong at our end".
  // The lookup is a pure read of a committed table and every one of the 33,791 ZIPs in it was swept
  // through this function without one throwing — but an unhandled throw in an Express handler ends
  // as a bare 500 with no reason attached, and a bare 500 on this field is indistinguishable to the
  // person in front of it from the connector being down. Catching it turns "we cannot tell you why"
  // into a sentence that names the field and tells them what they can do instead, which is what the
  // state/county boxes on the screen are for. It NEVER guesses a county: an unreadable table
  // answers as unreadable.
  let hit = null;
  try {
    hit = zipCounty.lookupZip(raw);
  } catch (e) {
    return res.status(500).json({
      ok: false, error: 'zip_lookup_failed',
      message: `We could not read the ZIP table just now. Type the state and county for ${raw} instead.`,
    });
  }
  if (!hit) {
    return res.status(404).json({ ok: false, error: 'unknown_zip',
      message: `We do not have a county on file for ZIP ${raw}. Type the state and county instead.` });
  }
  return res.json({ ok: true, zip: hit.zip, state: hit.state, county: hit.countyName, countyFps: hit.countyFps, split: !!hit.split });
}

// GET /comp-plan — the COMPENSATION PLAN the signed-in person prices with (owner-directed
// 2026-08-23). The pricing engine's three-way switch (borrower-paid / raw / lender-paid) is a
// DISPLAY overlay: Lender Price is always searched borrower-paid and nothing about the search
// changes — this endpoint only says which figures the overlay applies. Resolution per figure:
// the person's own settings row → the company's value → the declared default (comp-plan.js).
// The two lender fees are company-only. A caller with no session (the diagnostics mount) gets
// the company plan — there is nobody to resolve a personal figure for.
async function compPlanHandler(req, res) {
  const staffId = req.actor && req.actor.id != null ? String(req.actor.id) : null;
  const [company, user] = await Promise.all([
    settingsStore.load(),
    staffId
      ? settingsStore.load(`user:${staffId}`)
      : Promise.resolve({ settings: {}, stored: new Set(), degraded: false }),
  ]);
  const { plan, source } = resolveCompPlan({
    defaults: settingsStore.defaults(),
    company: company.settings,
    user: user.settings,
    userStored: user.stored,
  });
  res.json({ ok: true, plan, source, degraded: !!(company.degraded || user.degraded) });
}

// GET /investors — the SETTINGS-AWARE pre-search picker (owner-directed 2026-09-03,
// the explicit owner call the note below always said this change would need). The
// tick-boxes offered BEFORE a search now match what a search actually shows: every
// investor that is ON and named — a LoanNEX-switched investor INCLUDED, a turned-off
// one EXCLUDED — derived from the SAME settings the board routes on (`pickerRoster`),
// so the picker and the board can never disagree.
//
// WHY THE OLD "IT STAYS LENDER-PRICE-ONLY" NOTE NO LONGER HOLDS. It rested on one
// fact that is no longer true: *"This engine asks Lender Price and nobody else, so a
// LoanNEX-only investor offered here produces an EMPTY BOARD."* Since 2026-09-03 the
// general engine asks LoanNEX too (the immediate board is built from both sheets), so
// a LoanNEX-switched investor offered here now genuinely populates — and a turned-off
// investor offered here was the real defect: ticking it dropped the board to empty and
// the strip blamed the VENDOR ("nothing populated for X") for a deliberate turn-off.
// The board already white-labels investors from these same settings, so the second old
// worry — "a second change to what this screen calls an investor" — is now the whole
// point: the picker names investors exactly as the board does. The combined engine
// keeps its own separate `/dscr/combined/investors` door, untouched.
//
// Fails SAFE: an unreadable config falls back to the Lender Price sheet rather than an
// empty picker. `test-lt-dscr-routes.js` asserts the on/named/switched/off contract.
async function investorsRoster(req, res) {
  try {
    const cfg = await generalBoard.loadConfig({});
    res.json({ ok: true, investors: generalBoard.pickerRoster(cfg) });
  } catch (e) {
    console.error('[lt-dscr] investors roster failed, falling back to Lender Price sheet:', (e && e.message) || e);
    res.json({ ok: true, investors: investorPrograms.fullRoster() });
  }
}

// A router with the endpoints wired. Auth is applied by the mount (staff at /api/lt, or the
// secret gate at /api/lt/_diag/lenderprice).
function makeRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  router.get('/zip/:zip', zipLookup);
  router.get('/investors', (req, res) => investorsRoster(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_investors_error' })));
  router.get('/comp-plan', (req, res) => compPlanHandler(req, res).catch((e) => {
    console.error('[lt-dscr] comp-plan failed:', (e && e.message) || e);
    // ⛔ NO PLAN IS THE ANSWER, never a guessed one — the screen falls back to raw pricing
    // with a notice, which is the fail-safe the whole overlay is built around.
    res.status(500).json({ ok: false, error: 'lt_dscr_comp_plan_error' });
  }));
  router.get('/health', (req, res) => health(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_health_error' })));
  router.get('/login-check', (req, res) => loginCheck(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_login_error' })));
  router.post('/price-brackets', (req, res) => priceBrackets(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_price_brackets_error' })));
  /* THE SAME BOARD, REPORTED AS IT IS BUILT. Registered BEFORE nothing and AFTER the
     plain door only for readability — Express matches on the full path, so the two
     cannot shadow one another. */
  router.post('/price-brackets/stream', (req, res) => priceBracketsStream(req, res).catch((e) => {
    // Only reachable while the headers are still ours; the handler itself converts a
    // late throw into a result line.
    if (res.headersSent) { try { res.end(); } catch (_) { /* already gone */ } return; }
    res.status(500).json({ ok: false, error: 'lt_dscr_price_brackets_error' });
  }));
  router.post('/price', (req, res) => price(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_price_error' })));
  /**
   * WHY IS THIS PRICE THIS PRICE — the SAME door the Combined Pricing Engine mounts.
   *
   * ⛔ IT IS A MOUNT, NOT A SECOND DOOR (owner-directed 2026-09-03: *"LoanNEX was perfect,
   * including pulling up the itemization LLPA. I told you to copy it from here and bring in
   * how it works"*). The itemised breakdown was built and tested against the live rate sheet
   * on that engine and existed nowhere else, so a LoanNEX row on THIS board could show a
   * price and never say what was in it. `routes/explain-door.js` is the one definition;
   * there is no route body here at all, deliberately, so the two engines can never itemise
   * one quote two ways.
   *
   * ⛔ `reveal: false` — ONE SYSTEM, by the owner's own rule. The combined engine is
   * super-admin only and lets an admin ask which rate sheet a row came from; this board
   * never names a vendor, so the reveal cannot be asked for here whatever a caller sends.
   * A Lender Price row still answers instantly with `alreadyExplained` — its itemization
   * arrived with the search — so this costs an ordinary board nothing.
   */
  require('./explain-door').attach(router, { reveal: false });
  // Poll-only ineligible status by searchKey (kicked off by POST /price) — never restarts the search.
  router.get('/disqualifications/:searchKey', (req, res) => disqualifications(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_disqualifications_error' })));
  router.post('/disqualifications', (req, res) => disqualifications(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_disqualifications_error' })));
  router.post('/disqualify', (req, res) => disqualify(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_disqualify_error' })));
  /* THE HANDLE-BASED DOOR — both rate sheets, off the `ineligibility` handles the price
     answer returns. Its own path so the scenario-based door above keeps working unchanged. */
  router.post('/ineligible', (req, res) => ineligible(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_ineligible_error' })));
  router.post('/selftest', (req, res) => selftest(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_selftest_error' })));
  return router;
}

module.exports = { makeRouter, handlers: { health, loginCheck, price, priceBrackets, disqualify, disqualifications, ineligible, selftest, zipLookup, investorsRoster }, BATTERY, SUPPORTED_FIELDS, META_FIELDS,
  _internals: { shapeDisqualified, effectiveOf, cashoutNote, pageOptsOf, unsupportedFields, requestedOf, derivedOf, priceBracketsStream } };

'use strict';

// =============================================================================
// LT PRODUCT & PRICING ENGINE — the HTTP surface.  /api/lt/ppe/*
// =============================================================================
//
// Everything under `src/longterm/ppe/` was built, tested (27 suites) and
// UNREACHABLE: there was no route. This is that route. Design + rationale:
// `docs/longterm/PPE-MEGA-PLAN.md`; the module map is `src/longterm/ppe/README.md`.
//
// THE ONE MODEL THIS SURFACE MUST NOT BREAK (§1.2, §9): **Lender Price is the
// source of truth — for now, in every scenario.** Our engine runs BESIDE it in
// shadow; LP's answer is what the business sees; every disagreement becomes a
// finding we fix. So `POST /quote` returns LP's answer and our engine can only
// ever ADD a `shadow` block to it. A shadow failure may never change, delay or
// break the business answer — that guarantee lives inside `facade.priceWithShadow`,
// and this route exists to not undo it.
//
// WHAT IS DELIBERATELY NOT HERE, and why
//   · **No promote-to-live control.** Promotion is a human decision gated on the
//     scoreboard (§11). The gate and the append-only ledger are pure modules
//     (`cutover.js`, `cutover-ledger.js`) with NO table behind them yet — the
//     history they replay is not persisted anywhere. A promote button whose
//     decision cannot be durably recorded is worse than no button, so the
//     lifecycle stays out until it has a home. `GET /investors` says so rather
//     than implying every investor is in `draft`.
//   · **No rate-sheet write path.** Ingestion has an auto-apply-vs-review
//     classifier (§7.4); giving it an HTTP door before that review queue has a
//     screen would let a bad sheet reprice a book with nobody looking.
//
// AUTH: staff authentication is applied at the mount seam in `src/server.js`,
// like every other LT router. Reads are open to any staff member — an engineer has
// to be able to see why a scenario disagreed. The ADMIN gate is on the two
// deliberate operator actions: settling a finding, and running a canary battery.
//
// `POST /quote` is deliberately NOT admin-gated, and it is worth being precise
// about why, because it DOES have side effects: it calls the live Lender Price
// upstream, and a disagreement appends to the findings ledger. An earlier version
// of this header claimed "everything that WRITES is admin-gated", which was simply
// false. It is left open because pricing a scenario is the ordinary thing a staff
// member does with a pricing engine, and its write is an OBSERVATION — the ledger
// records that the two engines disagreed, which is true whoever asked. What an
// ordinary user must not do is SETTLE that observation or launch a 500-scenario
// battery at the upstream, and those are the two gated routes.

const express = require('express');
const router = express.Router();

const db = require('../db');
const access = require('../access');
const settingsStore = require('../settings/store');

const ppeSettings = require('../ppe/settings');
const store = require('../ppe/store');
const facade = require('../ppe/facade');
const lpScopeLib = require('../ppe/lp-scope');
const parityMatrix = require('../ppe/parity-matrix');
const parityCellStore = require('../ppe/parity-cell-store');
const quote = require('../ppe/quote');
const canary = require('../ppe/canary');
const finding = require('../ppe/finding');
const findingStore = require('../ppe/finding-store');
const reviewQueue = require('../ppe/review-queue');
const cutover = require('../ppe/cutover');
const runStore = require('../ppe/run-store');
const canarySchedule = require('../ppe/canary-schedule');
const scheduleStore = require('../ppe/schedule-store');
const scenarioMatrix = require('../ppe/scenario-matrix');
const ratesheet = require('../ppe/ratesheet');
const ruleStore = require('../ppe/rule-store');
const agreementStore = require('../ppe/agreement-store');
const ratesheetAgreement = require('../ppe/ratesheet-agreement');
const agreementScenarios = require('../ppe/agreement-scenarios');
const lpAgreementLegs = require('../ppe/lp-agreement-legs');
const suggestionMiner = require('../ppe/suggestion-miner');
const pricingBreakdown = require('../ppe/pricing-breakdown');
const lpNormalizeFull = require('../ppe/lp-normalize-full');

const SCOPE = 'company';

// A canary prices a whole matrix against a live upstream. The cap is a REFUSAL,
// not a silent truncation: a quietly-shortened battery reports an agreement rate
// over scenarios nobody chose, which reads as a cleaner result than it is.
const MAX_CANARY_SCENARIOS = 500;

// The vocabulary is the LEDGER's (`finding.js`), never this route's. A status
// invented here would be written into the ledger and quietly break
// `finding.reconcile`'s "never re-open a settled finding" rule.
//
// SETTLING statuses only. The first cut also accepted the OPEN ones, which let this
// endpoint move a SETTLED finding back to open — and `findingStore.decideFinding`
// overwrites `decision_reason` unconditionally, so the re-open DESTROYED the note
// this very route calls "the only lasting record of why". The endpoint's own refusal
// message says a settled finding is never re-opened; it must not be the thing that
// re-opens one. Re-opening legitimately happens ONE way: the finding reproduces, and
// `finding.reconcile` marks it `regressed` on its own.
const DECIDABLE = [...finding.SETTLED_STATUSES];
const NOT_DECIDABLE = [...finding.OPEN_STATUSES];

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------

/**
 * Admin gate. Mirrors `routes/settings.js` exactly, including its failure
 * posture: a gate that cannot be CHECKED is not a gate that has been PASSED, so
 * an unreadable settings row answers 503 rather than falling open.
 */
async function requirePpeAdmin(req, res, next) {
  try {
    const { settings } = await settingsStore.load();
    if (!access.mayManagePeople(req.actor, settings)) {
      return res.status(403).json({ error: 'Only an administrator can change the pricing engine.' });
    }
    return next();
  } catch (e) {
    console.error('[lt-ppe] admin gate failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'Could not check your permissions just now. Try again in a moment.' });
  }
}

const wrap = (fn, code) => (req, res) => fn(req, res).catch((e) => {
  console.error(`[lt-ppe] ${code}:`, (e && e.message) || e);
  if (!res.headersSent) res.status(500).json({ ok: false, error: code });
});

// ---------------------------------------------------------------------------
// input readers — they REFUSE rather than coerce
// ---------------------------------------------------------------------------

// The scope is fixed to the company today (multi-tenancy is §1.4, not yet a
// routing concern). Read through ONE helper so the day a tenant id arrives there
// is one place to change, not eleven call sites.
function readScope(_req) { return SCOPE; }

// The run series is keyed on (scope, investor, program) and `run-store` stores those as
// LABELS. Both the write and the read must produce the SAME label or the canary would
// persist into one series and the scoreboard would read an empty one — a silent
// "nothing measured" that looks exactly like "no canary has run". Passing the program
// OBJECT would stringify to "[object Object]", which is a series key too, just a
// useless one. So: one helper, used by both.
function programLabel(program) { return (program && (program.code || program.name)) || ''; }

/** An error's own words, bounded — never an object stringified into a response. */
function msgOf(e) { return String((e && e.message) || e).slice(0, 200); }

/** A UUID string, else null — for the lt_ppe_investor/program ids (UUID PKs, db/558). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOf(v) { const s = v == null ? '' : String(v).trim(); return UUID_RE.test(s) ? s : null; }

/** A positive integer within [1, max], else null. Never NaN, never a coerced string. */
function intIn(v, max) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

/**
 * Load a program (a priced rate-sheet version) if one was asked for.
 * Returns { program, reason } — `reason` is why there is no program, and it is
 * REPORTED rather than swallowed: without a program our engine cannot run, so
 * the caller must be told the shadow was skipped instead of reading a missing
 * `shadow` block as "the two engines agreed".
 */
async function loadProgram(scope, versionId) {
  if (!versionId) return { program: null, reason: 'no_program_requested' };
  try {
    // TWO STEPS, and they are not interchangeable. `store.loadRateSheet` returns
    // the stored SHEET (raw `lt_ppe_base_price` / `_adjustment` / `_price_limit`
    // rows); `ratesheet.rateSheetToProgram` is the pure mapper that turns it into
    // the PROGRAM shape (`baseGrid` + `rules` + `priceLimit`) the engine prices
    // from. Handing the sheet straight to `quote.quoteProgram` throws
    // `quote:program_has_no_base_grid` — which the facade would then record as an
    // engine_error finding on every single quote.
    const sheet = await store.loadRateSheet(db, versionId);
    if (!sheet || !Array.isArray(sheet.basePrices)) return { program: null, reason: 'program_not_found' };
    const program = ratesheet.rateSheetToProgram(sheet, {
      code: (sheet.version && sheet.version.id) || versionId,
      name: (sheet.version && sheet.version.label) || null,
    });
    if (!program || !Array.isArray(program.baseGrid) || !program.baseGrid.length) {
      return { program: null, reason: 'program_has_no_base_grid' };
    }
    // WHICH Lender Price programs a comparison against this sheet is about (db/574). It rides on the
    // owning PROGRAM row, not the sheet version, because it is a statement about the investor's
    // product family and survives every reprice of the sheet. NULL is the norm until a human states
    // it, and null means "not scoped" — the comparison then abstains and says so, never compares our
    // one ladder against a merge of Lender Price's seventeen.
    return { program, lpScope: lpScopeLib.scopeFromRow(sheet.program), reason: null };
  } catch (e) {
    return { program: null, reason: `program_load_failed: ${String((e && e.message) || e).slice(0, 120)}` };
  }
}

// `settings.resolveAll` (and therefore `store.resolveSettings`) returns
// **{ values, sources }** — the resolved map PLUS where each value came from —
// and the keys inside it are NAMESPACED (`pricing.correspondent_margin_milli`,
// `validation.price_tolerance_milli`). The first cut of this route wrapped that
// object a SECOND time and then read flat, un-namespaced keys off the wrapper, so
// every setting resolved to `undefined`. Nothing errored: the engine fell back to
// its coded defaults, which meant a **margin of 0 instead of the configured 250
// milli** — our shadow engine priced every scenario a quarter point off Lender
// Price and manufactured a systematic price disagreement on every single quote,
// filling the findings ledger with our own misconfiguration. That is the exact
// outcome this route's no-program rule exists to prevent, arriving by another
// door. Unwrap ONCE here so every caller gets the flat map, and read the
// namespaced keys through the constants below.
const K = {
  priceTolerance: 'validation.price_tolerance_milli',
  rateTolerance: 'validation.rate_tolerance_milli',
  marginTolerance: 'validation.margin_tolerance_milli',
  basePriceTolerance: 'validation.base_price_tolerance_milli',
};

async function resolveSettingsSafe(scope) {
  try {
    const resolved = await store.resolveSettings(db, scope);
    return { values: (resolved && resolved.values) || {}, sources: (resolved && resolved.sources) || {}, source: 'db+defaults' };
  } catch (_) {
    // store.resolveSettings already degrades to coded defaults on a read failure;
    // if it threw anyway, use the coded defaults and SAY they are a fallback
    // rather than presenting them as the tenant's configuration.
    const coded = ppeSettings.resolveAll({});
    return { values: coded.values || {}, sources: coded.sources || {}, source: 'defaults-fallback' };
  }
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
//
// Answers 200 with `configured:false` when nothing is set up yet: "no investors
// configured" is a true and useful answer, and a 5xx there would read as "the
// pricing engine is broken".

async function health(req, res) {
  const scope = readScope(req);
  const out = {
    ok: true,
    product: 'long-term',
    surface: 'ppe',
    authoritative: 'lp',
    note: 'Lender Price is authoritative; our engine runs in shadow beside it.',
  };
  try {
    const investors = await store.listInvestors(db, scope);
    out.investors = investors.length;
    out.activeInvestors = investors.filter((i) => i.active !== false).length;
    out.configured = investors.length > 0;
  } catch (e) {
    // The ENGINE's readiness is not the DATABASE's readiness. Say which failed
    // rather than reporting a confident `configured:false`.
    out.configured = null;
    out.dbError = String((e && e.message) || e).slice(0, 200);
  }
  return res.json(out);
}

// ---------------------------------------------------------------------------
// GET /settings — the typed registry AND the resolved values
// ---------------------------------------------------------------------------
//
// The registry ships WITH the values so a screen can be drawn from the server's
// own description (the `routes/settings.js` discipline): adding a setting
// server-side makes it appear with no front-end change, so there is never a
// second copy of "what is configurable" to drift.

async function getSettings(req, res) {
  const scope = readScope(req);
  const { values, sources, source } = await resolveSettingsSafe(scope);
  // `values` is the FLAT map keyed exactly as `allDefinitions()[].key`, so a screen
  // can do `values[def.key]`. It was previously the {values,sources} wrapper, which
  // made every one of those lookups undefined — defeating the whole "the screen is
  // drawn from the server's own description" point.
  return res.json({ ok: true, scope, source, definitions: ppeSettings.allDefinitions(), values, sources });
}

// ---------------------------------------------------------------------------
// GET /investors
// ---------------------------------------------------------------------------

async function listInvestorsRoute(req, res) {
  const scope = readScope(req);
  const investors = await store.listInvestors(db, scope);
  return res.json({
    ok: true,
    scope,
    investors: investors.map((i) => ({ id: i.id, code: i.code, name: i.name, active: i.active !== false, createdAt: i.created_at || null })),
    // Honest about what is NOT modelled yet: `lt_ppe_investor` has no mode column
    // and the cutover ledger has no table, so there is no per-investor lifecycle
    // to report. Every investor is in shadow because §1.2 says everything is.
    lifecycle: {
      mode: 'shadow',
      perInvestor: false,
      note: 'Per-investor promotion is not persisted yet — the cutover ledger has no table. Every investor is in shadow; Lender Price is authoritative.',
      modes: Object.values(cutover.MODES),
    },
  });
}

// ---------------------------------------------------------------------------
// GET /findings — the prioritized review queue
// ---------------------------------------------------------------------------
//
// `review-queue.buildQueue` owns severity and ordering; this route only fetches,
// converts and hands over. A second ordering here would be a second definition of
// "what to work on first" and the two would drift.

async function listFindingsRoute(req, res) {
  const scope = readScope(req);
  const investor = req.query.investor ? String(req.query.investor) : null;
  const status = req.query.status ? String(req.query.status) : null;
  const limit = intIn(req.query.limit, 500) || 100;

  if (status && !DECIDABLE.includes(status)) {
    return res.status(400).json({ error: `Unknown status. Use one of: ${DECIDABLE.join(', ')}.`, allowed: DECIDABLE });
  }

  // The INVESTOR narrowing is a SQL predicate now, not a JS filter over the whole
  // scope. The page slice below is still JS and deliberately so: `buildQueue` ranks
  // by severity, which only exists in JS, so a SQL LIMIT would drop rows BEFORE
  // anything knew how important they were and the "top 100" would silently be the
  // 100 most RECENT wearing the label of the 100 most important.
  const rows = await findingStore.listFindings(scope, { ...(status ? { status } : {}), ...(investor ? { investor } : {}) }, db);
  // The store returns raw table rows; every pure consumer speaks RECORDS.
  const records = rows.map(findingStore.rowToRecord);

  const queue = reviewQueue.buildQueue(records, { nowMs: Date.now() });
  const all = queue.items || [];
  const items = all.slice(0, limit);
  return res.json({
    ok: true,
    scope,
    investor,
    status,
    total: all.length,
    returned: items.length,
    // No silent caps: say when there is more behind the limit.
    truncated: all.length > items.length,
    summary: queue.summary || null,
    items,
  });
}

// ---------------------------------------------------------------------------
// POST /findings/:key/decide — a human settles one finding (admin)
// ---------------------------------------------------------------------------

async function decideFindingRoute(req, res) {
  const scope = readScope(req);
  const key = String(req.params.key || '').trim();
  if (!key) return res.status(400).json({ error: 'Which finding? The finding key is missing.' });

  const b = req.body || {};
  const status = String(b.status || '').trim();
  if (NOT_DECIDABLE.includes(status)) {
    return res.status(400).json({
      error: `"${status}" is where a finding STARTS, not a decision. A finding re-opens only by reproducing — settle it with one of: ${DECIDABLE.join(', ')}.`,
      allowed: DECIDABLE,
    });
  }
  if (!DECIDABLE.includes(status)) {
    return res.status(400).json({ error: `A decision must be one of: ${DECIDABLE.join(', ')}.`, allowed: DECIDABLE });
  }
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < 8) {
    // A SETTLED finding is never re-opened, so the reason it was settled is the
    // only lasting record of why. An empty note makes that record useless.
    return res.status(400).json({ error: 'Add a short reason (at least 8 characters) — a settled finding is never re-opened, so this note is the record of why.' });
  }

  // `.id` is the WHOLE actor identity — authenticate() builds req.actor as
  // { id, kind, role, sid } and has never put a staff-id field beside it, so
  // the fallback that used to sit here could only ever read undefined. That
  // dead read is the 2026-07-23 (#208) silent-attribution bug, and its whole
  // cost is that it LOOKS like a safety net: a reader sees two sources and
  // assumes one covers the other, while a decision taken through the arm that
  // was supposed to be covered is recorded against nobody.
  //
  // scripts/test-attribution-dedupe-pure.js source-scans src/ for that dead
  // read, and it scans the RAW TEXT — comments included — so do not spell the
  // pattern out here, even to explain it. Naming it in prose fails the build
  // just as loudly as writing the code, which is how this comment got worded
  // the long way round.
  const decidedBy = (req.actor && req.actor.id) || null;
  const changed = await findingStore.decideFinding(scope, key, { status, reason, decidedBy }, db);
  if (!changed) return res.status(404).json({ error: 'No such finding on this scope.' });

  const row = await findingStore.getFinding(scope, key, db);
  return res.json({ ok: true, finding: row ? findingStore.rowToRecord(row) : null });
}

// ---------------------------------------------------------------------------
// POST /quote — price one scenario. LP answers; we shadow.
// ---------------------------------------------------------------------------

async function quoteRoute(req, res) {
  const scope = readScope(req);
  const b = req.body || {};
  const scenario = b.scenario;
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return res.status(400).json({ error: 'Send a `scenario` object describing the deal.' });
  }
  const investor = b.investor ? String(b.investor) : null;

  const { values: settings } = await resolveSettingsSafe(scope);
  const { program, lpScope, reason: noProgram } = await loadProgram(scope, b.rateSheetVersionId);
  const lp = require('../lenderprice/client');
  const nowMs = Date.now();

  // WITHOUT A PROGRAM WE DO NOT PRETEND TO SHADOW. `quote.quoteProgram` throws
  // with no program, which the facade would faithfully record as an
  // `engine_error` finding on EVERY quote — filling the ledger with a
  // configuration fact rather than a disagreement, and burying the real
  // findings. LP is authoritative, so a missing program costs the SHADOW, not
  // the quote: answer LP and say plainly why nothing was compared.
  if (!program) {
    const answer = await lp.price(scenario);
    return res.json({
      ok: true, scope, mode: 'shadow', authoritative: 'lp', answer,
      shadow: null, shadowSkipped: noProgram,
    });
  }

  const result = await facade.priceWithShadow(
    { scenario, investor, program },
    {
      mode: () => 'shadow', // §1.2 — for now, in every scenario
      priceLp: (sc) => lp.price(sc),
      ourQuote: (sc) => quote.quoteProgram({ scenario: sc, program, settings }),
      // THE CAPTURE, READ PROPERLY — §2.8. `lp.price()` returns the RAW envelope
      // ({ ok, raw, request, searchKey }), NOT the parse() shape, and the façade had
      // been normalizing that envelope as if it were one: no `.programs`, so ZERO
      // matched programs, so Lender Price read as INELIGIBLE and every single quote
      // recorded a phantom eligibility finding. This turns the one envelope into the
      // three parsed shapes — the ladder for the price comparison, the full parse and
      // the disqualify tree for the six categorized axes (margin, itemized LLPAs,
      // decline reasons) that the shallow ladder structurally cannot see.
      //
      // The disqualify tree is computed ASYNCHRONOUSLY by Lender Price, so an ordinary
      // price call usually returns before it is ready; `hasDisqualifyData` asks rather
      // than assuming, and the façade reports `disqualifyReady` so a half-tested
      // eligibility axis is never mistaken for "Lender Price declined nothing".
      lpDetail: (answer) => {
        const raw = answer && answer.raw;
        if (!raw) return null;
        return {
          parsed: lp.parse(raw),
          full: lp.parseFull(raw),
          disqualified: lp.hasDisqualifyData(raw) ? lp.parseDisqualified(raw) : { ready: false, lenders: [] },
        };
      },
      recordFinding: (records) => findingStore.persistRun(scope, records, { db, nowMs }),
      nowMs,
    },
    {
      priceToleranceMilli: settings[K.priceTolerance],
      rateToleranceMilli: settings[K.rateTolerance],
      marginToleranceMilli: settings[K.marginTolerance],
      basePriceToleranceMilli: settings[K.basePriceTolerance],
      settings,
      // WHICH Lender Price programs this comparison is about — the sheet's OWN stored scope
      // (db/574), and the ONLY source of it. Lender Price answers one request with EVERY
      // program it sells (17 on the live Deephaven capture, across several investors and
      // product lines) while our engine prices ONE, so the scope has to be STATED: our
      // `program` is a rate-sheet version of our authoring, not Lender Price's program
      // name, and inferring one from it would be a guess about somebody else's product
      // catalogue. Unscoped, the façade abstains with that reason rather than comparing our
      // one ladder against a merge of seventeen.
      //
      // DELIBERATELY NOT READ FROM THE REQUEST BODY. A caller-supplied scope would be a
      // SECOND source for one fact, free to disagree with the stored statement and to point
      // a comparison at a program nobody chose — and `programLike` is compiled with
      // `new RegExp(...)` while this route is not admin-gated, so honouring one over HTTP
      // would let any caller hand the server a pattern to compile and run. The scope is set
      // once, by an admin, through POST /programs/:id/lp-scope.
      lpFilter: lpScope,
    },
  );

  return res.json({ ok: true, scope, ...result });
}

// ---------------------------------------------------------------------------
// POST /breakdown — the LP-style pricing-transparency view for one scenario
// ---------------------------------------------------------------------------
//
// The "mother interface" (owner-directed 2026-08-17): base price at the top, every
// itemized LLPA/adjustment with its running effect, and the final price — "same way
// everything is visible in Lender Price."
//
// This route only ASSEMBLES a view over an already-priced scenario; it invents no
// number. It prices the scenario against our engine's reconstruction (`quote.quoteProgram`
// → the §5.4 record, which maps 1:1 onto LP's priceBuild) and hands that to the PURE
// read-model `pricing-breakdown.buildPricingBreakdown`. A rate-sheet version is required —
// unlike /quote (where LP answers even with no program) there is nothing to break down
// without a priced sheet, so it REFUSES with the reason rather than returning an empty view.
//
// Lender Price's own side is OPTIONAL context, best-effort: pass a parsed `disqualified`
// (or a `searchKey` we poll) for LP's decline panel, and `lpRaw` to build the breakdown
// from LP's own sheet instead of our reconstruction (`source:'lp'`). None of it is needed
// for the core view, and a failure to fetch it never fails the breakdown.
//
// A READ: like /quote it is open to any staff member and it does NOT write to the findings
// ledger (buildPricingBreakdown is pure and nothing here calls recordFinding).

async function breakdownRoute(req, res) {
  const scope = readScope(req);
  const b = req.body || {};
  const scenario = b.scenario;
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return res.status(400).json({ error: 'Send a `scenario` object describing the deal.' });
  }
  const investor = b.investor ? String(b.investor) : null;
  const rate = b.rate == null || b.rate === '' ? null : Number(b.rate);
  if (rate != null && !Number.isFinite(rate)) {
    return res.status(400).json({ error: '`rate` must be a number (the coupon to feature), or omitted.' });
  }
  const source = b.source === 'lp' || b.source === 'ours' ? b.source : null;

  const { values: settings } = await resolveSettingsSafe(scope);
  const { program, reason: noProgram } = await loadProgram(scope, b.rateSheetVersionId);
  if (!program) {
    // Nothing to break down without a priced sheet. Say why, don't return an empty view.
    return res.status(422).json({ error: 'A breakdown needs a rate-sheet version to price against.', reason: noProgram });
  }

  let quoteResult;
  try {
    quoteResult = quote.quoteProgram({ scenario, program, settings });
  } catch (e) {
    return res.status(422).json({ error: 'That scenario could not be priced.', detail: String((e && e.message) || e).slice(0, 160) });
  }

  const lp = require('../lenderprice/client');

  // Optional: Lender Price's OWN parsed sheet, for a source:'lp' breakdown. Best-effort.
  let lpFull = null;
  if (b.lpRaw != null) {
    try { lpFull = lpNormalizeFull.normalizeLpFull(lp.parseFull(b.lpRaw), { investor }); } catch (_) { lpFull = null; }
  }

  // Optional: Lender Price's OWN disqualifications, for the decline panel. Best-effort.
  let lpDisqualified = null;
  let disqualifyPending = false;
  if (b.disqualified && typeof b.disqualified === 'object') {
    try { lpDisqualified = lpNormalizeFull.normalizeLpDisqualified(b.disqualified, { investor }); } catch (_) { lpDisqualified = null; }
  } else if (b.searchKey) {
    try {
      const pr = await lp.pollDisqualifiedByKey(String(b.searchKey));
      if (pr && (pr.ready || pr.raw || pr.parsed)) {
        const parsed = pr.parsed || lp.parseDisqualified(pr.raw);
        lpDisqualified = lpNormalizeFull.normalizeLpDisqualified(parsed, { investor });
      } else {
        disqualifyPending = true; // LP is still computing; the breakdown still returns
      }
    } catch (_) { lpDisqualified = null; }
  }

  const breakdown = pricingBreakdown.buildPricingBreakdown({
    quote: quoteResult, lpFull, lpDisqualified, rate, source,
  });

  return res.json({ ok: true, scope, investor, disqualifyPending, breakdown });
}

// ---------------------------------------------------------------------------
// resolveBattery — WHICH scenarios a canary prices, and the refusals around it
// ---------------------------------------------------------------------------
//
// Shared by the button and by a saved schedule, for the reason the size rules exist at all: a battery
// that is silently thinned reports an agreement rate measured over scenarios nobody chose, and that
// number feeds the promote gate. A second copy of these refusals is how one caller ends up thinning
// what the other refuses — so a schedule and a person hit exactly the same wall.
//
// Returns { scenarios } or { refused: { status, body } }. It never prices anything and never throws.

function resolveBattery(source) {
  const src = source || {};
  let scenarios;
  if (Array.isArray(src.scenarios)) {
    scenarios = src.scenarios;
  } else if (src.matrix && typeof src.matrix === 'object') {
    try {
      // buildMatrix returns { scenarios, fullSize, truncated, stride } — NOT an array. Taking it
      // whole made `Array.isArray(scenarios)` false below, so EVERY matrix-shaped canary answered
      // 400 "that produced no scenarios to price" and the endpoint's own size refusal was
      // unreachable from this branch. Found by the re-audit; it matters more now that a saved
      // schedule can carry a matrix.
      const expanded = scenarioMatrix.buildMatrix(src.matrix);
      scenarios = expanded.scenarios;
      // A STRIDED-DOWN battery is never priced silently: an agreement rate measured over scenarios
      // nobody chose reads cleaner than it is, and this endpoint already refuses rather than
      // truncates when a caller sends too many outright.
      if (expanded.truncated) {
        return { refused: { status: 422, body: {
          error: `That matrix expands to ${expanded.fullSize} scenarios; this endpoint prices at most ${MAX_CANARY_SCENARIOS} in one run. Narrow it — it is refused rather than thinned, because an agreement rate over a thinned battery is measured on scenarios nobody chose.`,
          limit: MAX_CANARY_SCENARIOS, asked: expanded.fullSize, reason: 'battery_truncated',
        } } };
      }
    } catch (e) {
      return { refused: { status: 400, body: { error: `That matrix could not be expanded: ${String((e && e.message) || e).slice(0, 160)}`, reason: 'bad_matrix' } } };
    }
  } else {
    return { refused: { status: 400, body: { error: 'Send either `scenarios` (an array) or `matrix` (axes to expand).', reason: 'no_battery' } } };
  }
  if (!Array.isArray(scenarios) || !scenarios.length) {
    return { refused: { status: 400, body: { error: 'That produced no scenarios to price.', reason: 'empty_battery' } } };
  }
  if (scenarios.length > MAX_CANARY_SCENARIOS) {
    return { refused: { status: 422, body: {
      error: `That is ${scenarios.length} scenarios; this endpoint prices at most ${MAX_CANARY_SCENARIOS} in one run. Narrow the matrix.`,
      limit: MAX_CANARY_SCENARIOS, asked: scenarios.length, reason: 'battery_too_large',
    } } };
  }
  return { scenarios };
}

// ---------------------------------------------------------------------------
// POST /canary — price a battery beside LP and record what disagreed (admin)
// ---------------------------------------------------------------------------
//
// The loop the plan describes, in one call: runCanary → persist the records.
// It MEASURES; it never DECIDES (no promotion happens here) and it repairs
// nothing.

async function canaryRoute(req, res) {
  const scope = readScope(req);
  const b = req.body || {};
  const investor = b.investor ? String(b.investor) : null;

  const battery = resolveBattery(b);
  if (battery.refused) return res.status(battery.refused.status).json(battery.refused.body);
  const scenarios = battery.scenarios;

  const out = await runBattery(scope, scenarios, {
    investor, rateSheetVersionId: b.rateSheetVersionId, concurrency: b.concurrency,
  });
  if (out.refused) return res.status(out.refused.status).json(out.refused.body);
  return res.json(out.result);
}

// ---------------------------------------------------------------------------
// runBattery — the canary EXECUTION, shared by the button and the schedule
// ---------------------------------------------------------------------------
//
// Extracted out of `canaryRoute` the moment the SCHEDULE became reachable, and the extraction IS the
// point: a canary somebody fires by hand and one a cadence fires overnight must produce the same
// measurement, into the same three durable records, or the run series would mean one thing on the days
// a person pressed the button and another thing the rest of the week — and the go-live gate reads that
// series. A second copy of this is the ordinary way that happens, so there is one.
//
// It RETURNS a refusal rather than writing a response, because its second caller is not an HTTP
// request: the route turns `refused` into a status, and the tick records it against the schedule that
// asked. Everything else — the program load, the tolerances, the three best-effort persists and their
// separately-reported failures — is the code that was already here, moved whole.

async function runBattery(scope, scenarios, opts = {}) {
  const investor = opts.investor || null;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const { program, reason: noProgram } = await loadProgram(scope, opts.rateSheetVersionId);
  if (!program) {
    // Same reasoning as /quote, and it matters more here: a canary with no
    // program would price N scenarios against a live upstream and record N
    // engine_error findings that say nothing about agreement.
    return { refused: { status: 422, body: { error: 'A canary needs a rate-sheet version to price against.', reason: noProgram } } };
  }

  const { values: settings } = await resolveSettingsSafe(scope);
  const lp = require('../lenderprice/client');

  // TWO ADJACENT CONTRACTS, AND THEY ARE NOT THE SAME ONE. The /quote route above
  // drives `facade.priceWithShadow`, whose injected engines are named
  // `priceLp` / `ourQuote`; the canary drives `shadow.runShadow` (through
  // canary.runCanary), whose engines are named `ours` / `theirs`. Passing the
  // facade's names here does not mis-price anything — `runShadow` refuses outright
  // ("requires engines.ours and engines.theirs"), so EVERY canary call 500s and the
  // endpoint is simply dead. It read as correct because both objects are two
  // scenario-taking functions sitting three lines apart. `theirs` is Lender Price,
  // which is authoritative; `ours` is the engine on trial.
  const run = await canary.runCanary(
    scenarios,
    {
      ours: (sc) => quote.quoteProgram({ scenario: sc, program, settings }),
      theirs: (sc) => lp.price(sc),
    },
    {
      investor,
      program,
      nowMs,
      priceToleranceMilli: settings[K.priceTolerance],
      rateToleranceMilli: settings[K.rateTolerance],
      concurrency: intIn(opts.concurrency, 8) || 4,
    },
  );

  // Persisting is best-effort AND SAID SO: a measurement we could not store is
  // still worth showing, but the caller must never believe it reached the ledger
  // when it did not. TWO durable records, and they answer different questions —
  // the FINDINGS ledger is "what disagreed", the RUN series is "how well the two
  // engines agreed on this date". The scoreboard's clean-day streak and agreement
  // trend are computed from the run series, so without it the go-live gate can
  // never pass however long the engine behaves: an unmeasured investor is not an
  // eligible one, which is correct, but it would never STOP being unmeasured.
  let persisted = null;
  let persistError = null;
  try {
    persisted = await findingStore.persistRun(scope, run.records, { db, nowMs });
  } catch (e) {
    persistError = String((e && e.message) || e).slice(0, 200);
  }

  let runPersisted = null;
  let runPersistError = null;
  try {
    runPersisted = await runStore.persistRun(scope, run.runRecord, {
      db, investor, program: programLabel(program),
    });
  } catch (e) {
    runPersistError = String((e && e.message) || e).slice(0, 200);
  }

  // THE THIRD durable record, and it answers a question the other two cannot. The findings ledger is
  // "what disagreed"; the run series is "how well the engines agreed on this date"; this is "how well
  // they agreed IN THIS BAND on this date", which is what turns a one-off bad afternoon into a
  // three-week regression somebody can see. Best-effort and reported separately — the three stores
  // fail independently, and "the run landed but the cells did not" is its own problem.
  let cellsPersisted = null;
  let cellPersistError = null;
  try {
    cellsPersisted = await parityCellStore.persistCells(scope, run.matrix, {
      db, investor, program: programLabel(program), dayMs: run.dayMs,
    });
  } catch (e) {
    cellPersistError = String((e && e.message) || e).slice(0, 200);
  }

  return { ok: true, result: {
    ok: true,
    scope,
    investor,
    scenarios: scenarios.length,
    agreementRate: run.agreementRate,
    summary: run.summary,
    report: run.report,
    // WHERE it disagreed, sliced on the SHEET'S OWN band edges (P9). A single agreement rate says we
    // disagree and never where, so one bad FICO band and a sheet that is wrong everywhere read the
    // same. The raw per-scenario results are deliberately NOT returned — up to 500 of them is a
    // payload nobody reads; the matrix is the answer, and it carries its own arithmetic
    // (`reconciles`) so a reader can check that no scenario was lost in the slicing.
    matrix: run.matrix,
    worstCells: run.matrix ? parityMatrix.worstCells(run.matrix, 10) : null,
    findings: run.findingKeys.length,
    persisted: !persistError,
    persistError,
    persistedSummary: persisted ? persisted.summary : null,
    // Reported separately: the two stores fail independently, and "the findings
    // landed but the run did not" is a different problem from the reverse.
    runPersisted: runPersistError ? false : !!(runPersisted && runPersisted.persisted),
    runPersistError,
    runPersistReason: runPersisted && !runPersisted.persisted ? runPersisted.reason : null,
    cellsPersisted: cellPersistError ? false : !!(cellsPersisted && cellsPersisted.persisted),
    cellPersistError,
    cellsWritten: cellsPersisted ? cellsPersisted.rows : null,
    // A capped batch is SAID, never silently short: a series missing its tail reads as a clean stretch.
    cellsTruncated: cellsPersisted ? cellsPersisted.truncated : null,
    } };
}

// ---------------------------------------------------------------------------
// The canary SCHEDULE — saving a cadence, and the tick that honours it
// ---------------------------------------------------------------------------
//
// `canary-schedule.js` (the decision) and `schedule-store.js` (db/570) were built, tested and
// UNREACHABLE: nothing created a schedule and nothing ticked one. So the only thing that ever fed the
// findings ledger, the run series and the per-band trend was a person POSTing /canary by hand — which
// nobody does. The scoreboard's clean-day STREAK and agreement TREND read that series, and a streak
// nobody feeds does not read as "unmeasured": it reads as a low score. An investor could sit
// permanently short of promotion for want of a cron rather than for want of agreement.
//
// THE TICK IS PULLED, NOT PUSHED — deliberately, and it is the safest shape available today. There is
// no timer in this process: something outside asks, and a run happens only if a saved, enabled
// schedule is genuinely due. A timer inside the web process would be the first background loop in the
// Long-Term product AND would call a paid vendor on its own schedule, which is a decision belonging to
// the owner, not to a refactor. Until that is asked for, the tick is an admin action a scheduler can
// call, and every refusal it makes is reported rather than swallowed.

async function listSchedulesRoute(req, res) {
  const scope = readScope(req);
  const rows = await scheduleStore.listSchedules(scope, { db });
  // A saved schedule is not a running one: `enabled` defaults to false and the decision module refuses
  // several shapes outright. So each row is reported WITH what the runner would decide about it, from
  // the same function the tick uses — a list saying "saved" beside a schedule that can never fire is
  // exactly how a measurement gap hides.
  const schedules = rows.map((sch) => {
    const v = canarySchedule.validateSchedule(sch);
    return {
      investor: sch.investor,
      enabled: sch.enabled,
      intervalMs: sch.intervalMs,
      rateSheetVersionId: sch.rateSheetVersionId,
      note: sch.note,
      updatedBy: sch.updatedBy,
      updatedAt: sch.updatedAt,
      batteryKind: sch.matrix ? 'matrix' : 'scenarios',
      runnable: !!v.ok && sch.enabled === true,
      // The module's own wording, never a paraphrase: it names WHICH rule stops it.
      reason: v.ok ? (sch.enabled === true ? null : 'disabled') : v.reason,
      message: v.ok ? (sch.enabled === true ? null : 'This canary schedule is saved but paused.') : v.message,
    };
  });
  const runnable = schedules.filter((x) => x.runnable).length;
  return res.json({
    ok: true,
    scope,
    schedules,
    runnable,
    // Said plainly: with nothing runnable, the agreement series only grows on the days a person presses
    // the button, and every gate that reads it stays unmeasured.
    note: runnable ? null : 'No canary schedule can run, so the agreement series only grows when somebody fires one by hand — and the go-live gate reads that series.',
  });
}

async function saveScheduleRoute(req, res) {
  const scope = readScope(req);
  const b = req.body || {};
  const who = (req.actor && (req.actor.email || req.actor.id)) || null;
  if (!who) return res.status(400).json({ error: 'A vendor loop records who armed it, and this request carries nobody.' });
  const out = await scheduleStore.saveSchedule(scope, {
    investor: b.investor == null ? null : String(b.investor),
    enabled: b.enabled === true,
    intervalMs: b.intervalMs,
    intervalMinutes: b.intervalMinutes,
    scenarios: b.scenarios,
    matrix: b.matrix,
    rateSheetVersionId: b.rateSheetVersionId || null,
    concurrency: b.concurrency,
    note: b.note,
  }, { db, by: String(who), nowMs: Date.now() });
  // The store returns the DECISION module's own reason and wording, so the person saving hears exactly
  // what the runner would have said — silently accepting an unrunnable schedule and discovering at 3am
  // that it has never fired is the failure this guards.
  if (!out.ok) return res.status(400).json({ error: out.message, reason: out.reason });
  return res.json({ ok: true, scope, schedule: out.schedule });
}

async function deleteScheduleRoute(req, res) {
  const scope = readScope(req);
  const investor = req.params.investor === '-' ? null : String(req.params.investor || '');
  const out = await scheduleStore.deleteSchedule(scope, investor, { db });
  return res.json({ ok: true, scope, removed: out.removed });
}

/**
 * POST /canary/tick — run the schedules that are genuinely due.
 *
 * FAILS TOWARD NOT RUNNING, at every step, because the two failures are not symmetric: a canary that
 * does not fire is a gap somebody can see on the scoreboard, while one that fires when it should not is
 * N live vendor calls per tick, forever. So an unreadable last-run stamp, an unresolvable program, an
 * unexpandable battery and a paused schedule all HOLD — each with the reason attached to that schedule,
 * never swallowed and never turned into a silent success.
 */
async function canaryTickRoute(req, res) {
  const scope = readScope(req);
  const b = req.body || {};
  const nowMs = Date.now();
  // ONE per tick by default. Each run is a whole battery against a live upstream, so the cap is about
  // the vendor, not about speed — and whatever it holds back is REPORTED, because a tick that quietly
  // skipped half its schedules looks exactly like a tick with nothing to do.
  const maxPerTick = intIn(b.maxPerTick, 5) || 1;

  const rows = await scheduleStore.listSchedules(scope, { db });

  // The last-run stamp is read from the RUN SERIES, never from a private column on the schedule
  // (db/570 says why: a second stamp is a second answer, and the one that drifts is the one the gate
  // reads). It also means a canary an admin fired BY HAND counts toward the cadence, which is right.
  const entries = [];
  for (const sch of rows) {
    const entry = { investor: sch.investor, schedule: sch, lastRunMs: null, program: null, programError: null };
    try {
      const loaded = await loadProgram(scope, sch.rateSheetVersionId);
      entry.program = loaded.program || null;
      if (!loaded.program) entry.programError = loaded.reason || 'no_program';
    } catch (e) {
      entry.programError = msgOf(e);
    }
    if (entry.program) {
      try {
        const runs = await runStore.listRuns(scope, { db, investor: sch.investor, program: programLabel(entry.program) });
        // The freshest run wins, and an EMPTY series is left as null — "never measured", which the
        // decision module reads as most-overdue. A 0 here would read as 1970 and be just as due, but
        // it would also make a read failure indistinguishable from a fresh schedule.
        entry.lastRunMs = runs.length ? runs[runs.length - 1].dayMs : null;
      } catch (e) {
        // An unreadable series must NOT read as "never run" — that is the one error that would make a
        // schedule fire on every tick forever. Held, with the reason.
        entry.seriesError = msgOf(e);
      }
    }
    entries.push(entry);
  }

  // A schedule whose program or series could not be read is never offered to the decision module: it
  // would answer "due" on a cadence it cannot honour.
  const blocked = entries.filter((e) => e.programError || e.seriesError);
  const askable = entries.filter((e) => !e.programError && !e.seriesError);
  const { run: due, skipped, held } = canarySchedule.selectDue(askable, { nowMs, maxPerTick });

  const ran = [];
  for (const item of due) {
    const battery = resolveBattery(item.decision.battery && item.decision.battery.kind === 'matrix'
      ? { matrix: item.decision.battery.matrix }
      : { scenarios: item.decision.battery && item.decision.battery.scenarios });
    if (battery.refused) {
      ran.push({ investor: item.investor, ok: false, reason: battery.refused.body.reason || 'battery_refused', message: battery.refused.body.error });
      continue;
    }
    try {
      const out = await runBattery(scope, battery.scenarios, {
        investor: item.investor,
        rateSheetVersionId: item.schedule.rateSheetVersionId,
        concurrency: item.schedule.concurrency,
        nowMs,
      });
      if (out.refused) {
        ran.push({ investor: item.investor, ok: false, reason: 'refused', message: out.refused.body.error });
      } else {
        const r = out.result;
        ran.push({
          investor: item.investor, ok: true, scenarios: r.scenarios, agreementRate: r.agreementRate,
          findings: r.findings, runPersisted: r.runPersisted, cellsPersisted: r.cellsPersisted,
        });
      }
    } catch (e) {
      // One schedule's failure never stops the next: a vendor timeout on Deephaven must not silently
      // cancel every other investor's measurement for the night.
      ran.push({ investor: item.investor, ok: false, reason: 'threw', message: msgOf(e) });
    }
  }

  return res.json({
    ok: true,
    scope,
    schedules: rows.length,
    ran,
    // EVERY schedule that did not run says why — the module's own reason, the program that would not
    // resolve, or the series that would not read. A tick reporting only what it ran is a tick that
    // reads as healthy while measuring nothing.
    held: [
      ...blocked.map((e) => ({ investor: e.investor, reason: e.programError ? 'no_program' : 'series_unreadable', message: e.programError || e.seriesError })),
      ...held.map((h) => ({ investor: h.investor, reason: h.decision.reason, message: h.decision.message, dueAt: h.decision.dueAt })),
    ],
    // A cap that hid work is SAID, never left to be inferred from a short list.
    overCap: skipped,
    maxPerTick,
  });
}

// ---------------------------------------------------------------------------
// GET /parity-cells — how a slice of the book has behaved over TIME
// ---------------------------------------------------------------------------
//
// The matrix on a canary response is one run. This is the same measurement across runs, which is the
// question a cutover decision actually turns on: has this band been off for three weeks, or was that
// one bad afternoon? It RANKS and never thresholds — what counts as clean enough is the owner's
// decision and lives in the cutover gate.

async function parityCellsRoute(req, res) {
  const scope = readScope(req);
  const q = req.query || {};
  const investor = q.investor ? String(q.investor) : null;
  const program = q.program ? String(q.program) : null;
  const days = intIn(q.days, 400) || 30;
  const sinceMs = Date.now() - (days * 24 * 60 * 60 * 1000);

  const cells = await parityCellStore.listCells(scope, {
    db,
    investor,
    program,
    dimension: q.dimension ? String(q.dimension) : null,
    cellKey: q.cellKey ? String(q.cellKey) : null,
    sinceMs,
  });

  // WHICH series hold anything at all, regardless of the filter above. `listCells` matches
  // (scope, investor, program) exactly, so asking for a key nobody wrote returns an empty list —
  // indistinguishable, on a screen, from "the engines have never been measured". Returning the real
  // series list means a reader can offer what exists instead of guessing a key and reporting silence.
  const series = await parityCellStore.listSeries(scope, { db, sinceMs });

  // ONE cell asked for by name gets its own history; otherwise the cells that have disagreed on the
  // most days, which is the list worth a human's morning.
  const single = q.dimension && q.cellKey;
  return res.json({
    ok: true,
    scope,
    investor,
    program,
    windowDays: days,
    measurements: cells.length,
    series,
    // A capped list is SAID: a reader that cannot see a series reports it as unmeasured.
    seriesTruncated: series.length >= parityCellStore.MAX_SERIES,
    // Said plainly, because an empty series and a series of clean days look identical on a chart:
    // this table starts at the first canary run after db/575, and nothing before it can be recovered.
    note: cells.length ? null : 'No per-band measurements in this window yet — the series starts at the first canary run after this was built, and earlier runs recorded only a daily total.',
    history: single ? parityCellStore.cellHistory(cells, { windowDays: days }) : null,
    persistentlyWorst: single ? null : parityCellStore.persistentlyWorst(cells, { windowDays: days, limit: intIn(q.limit, 50) || 10 }),
  });
}

// ---------------------------------------------------------------------------
// GET /scoreboard — the go-live picture for one investor
// ---------------------------------------------------------------------------

async function scoreboardRoute(req, res) {
  const scope = readScope(req);
  const investor = req.query.investor ? String(req.query.investor) : null;
  if (!investor) return res.status(400).json({ error: 'Which investor? Pass ?investor=<code>.' });

  const program = req.query.program ? String(req.query.program) : '';
  const rows = await findingStore.listFindings(scope, { investor }, db);
  const records = rows.map(findingStore.rowToRecord);
  const nowMs = Date.now();

  // The canary's run history IS persisted now, so the agreement rate and the
  // clean-day streak are read from it rather than left unmeasured. `assembleScoreboard`
  // loads the series and DELEGATES to `scoreboard.assemble`, which in turn delegates the
  // eligibility verdict to `cutover.eligibleForLive` — one definition of "eligible",
  // reached through the same path a screen and a cron would take.
  let assembled = null;
  let seriesError = null;
  try {
    assembled = await runStore.assembleScoreboard(scope, {
      db, investor, program, findings: records, nowMs,
    });
  } catch (e) {
    seriesError = String((e && e.message) || e).slice(0, 200);
  }

  if (assembled) {
    // `scoreboard.assemble` returns { scoreboard, eligible, series, trend,
    // latestAgreementRate, dropped }. `eligible` is already cutover's own verdict —
    // re-deriving it here would be a second definition of "eligible".
    return res.json({
      ok: true,
      scope,
      investor,
      program: program || null,
      scoreboard: assembled.scoreboard,
      gate: assembled.eligible,
      trend: assembled.trend || null,
      // `series` is the DAY series, not the run list — a day can hold several runs, so
      // reporting its length as "runs" would under-count every day the canary ran twice.
      // Both numbers are stated, each named for what it actually counts.
      days: Array.isArray(assembled.series) ? assembled.series.length : 0,
      runs: Array.isArray(assembled.series)
        ? assembled.series.reduce((n, d) => n + (Number.isFinite(d.runCount) ? d.runCount : 0), 0)
        : 0,
      // Whether anything has actually been MEASURED, said plainly: a null agreement
      // rate is "no canary has run", which is not the same as a bad score and must
      // never be rendered as 0%.
      measured: assembled.scoreboard.canaryAgreementRate != null,
      // No silent caps: assemble reports how many stored runs it could not place in
      // time. Reported as the NUMBER, so a real zero reads as "nothing was dropped"
      // rather than collapsing into the same null a failed read would produce.
      dropped: Number.isFinite(assembled.dropped) ? assembled.dropped : null,
    });
  }

  // The run series could not be read. FALL BACK to the findings-only picture and SAY
  // the agreement rate is unread rather than unmeasured — a missing rate reads as
  // "not proven", which is the safe verdict either way, but the two are different
  // facts and only one of them is anybody's fault.
  const board = cutover.buildScoreboard({ findings: records, nowMs });
  return res.json({
    ok: true, scope, investor, program: program || null,
    scoreboard: board,
    gate: cutover.eligibleForLive(board),
    measured: false,
    seriesError,
    note: 'The canary run history could not be read, so the agreement rate is unknown and the gate cannot pass. That is a read failure, not a measurement.',
  });
}

// ---------------------------------------------------------------------------
// Rule SUGGESTIONS + rules — the per-investor rule loop (P5/P6/P7)
// ---------------------------------------------------------------------------
//
// The review engine mines Lender Price's declines into per-investor rule
// SUGGESTIONS (disqualify-analysis). A human accepts one, which writes an
// lt_ppe_rule that then feeds our engine — so our engine declines exactly what
// Lender Price declined. NOTHING is auto-applied: accept/dismiss are the two
// deliberate operator actions, so both are admin-gated, exactly like deciding a
// finding. Listing is open to any staff member (you have to see a proposal
// before you can judge it).

async function listSuggestionsRoute(req, res) {
  const scope = readScope(req);
  const status = req.query.status ? String(req.query.status) : 'open';
  const investorLabel = req.query.investor ? String(req.query.investor) : null;
  const rows = await ruleStore.listSuggestions(db, scope, { status, ...(investorLabel ? { investorLabel } : {}) });
  return res.json({ ok: true, scope, status, total: rows.length, suggestions: rows });
}

async function acceptSuggestionRoute(req, res) {
  const scope = readScope(req);
  const id = intIn(req.params.id, Number.MAX_SAFE_INTEGER);
  if (!id) return res.status(400).json({ error: 'Which suggestion? A positive numeric id is required.' });
  const b = req.body || {};
  const note = typeof b.note === 'string' ? b.note.trim() : null;
  const decidedBy = (req.actor && req.actor.id) || null;

  // Scope the accepted rule to the suggestion's investor automatically (resolved
  // from its verbatim label via the alias table), unless the caller names one
  // explicitly. A house rule (investor_id null) is the safe fallback when the
  // label does not resolve — the rule still applies, just to every program.
  let investorId = b.investorId != null ? uuidOf(b.investorId) : null;
  const programId = b.programId != null ? uuidOf(b.programId) : null;
  if (investorId == null) {
    const sug = await ruleStore.getSuggestion(db, scope, id);
    if (sug && sug.investor_label) {
      const inv = await store.findInvestorByName(db, scope, sug.investor_label);
      if (inv) investorId = inv.id;
    }
  }

  const out = await ruleStore.acceptSuggestion(db, scope, id, { decidedBy, investorId, programId, note });
  if (!out.ok) {
    // A needs-human suggestion is a 409 (it exists, it just can't be accepted as-is);
    // a missing one is 404; a non-open one is 409.
    const code = out.error === 'not_found' ? 404 : 409;
    return res.status(code).json({ error: out.error, message: out.error === 'needs_human_mapping'
      ? 'Lender Price’s reason could not be mapped to a rule automatically. A human must map it first (never guessed).'
      : `This suggestion cannot be accepted (${out.error}).` });
  }
  // The coverage report rides on the accept response, ADVISORY. It never gates the accept (the rule is
  // already written by the time it is computed) — it is what tells the person who just pressed Accept
  // whether the rule they added now charges the same scenario as one already in the set.
  return res.json({ ok: true, scope, ruleId: out.ruleId, investorId, programId, coverage: out.coverage || null });
}

/**
 * The rule set's own coverage, read-only — overlapping PRICING rules (a double charge) and holes
 * between banded rules, for the set a program actually evaluates.
 *
 * ADVISORY: it reports, it never refuses a rule, and it is not a gate on anything. `?investorId=` /
 * `?programId=` name the set; omitting both reads the house rules alone, which is a real question
 * ("what do our own rules do on their own?") rather than an accident.
 */
async function ruleCoverageRoute(req, res) {
  const scope = readScope(req);
  const investorId = req.query.investorId != null ? uuidOf(req.query.investorId) : null;
  const programId = req.query.programId != null ? uuidOf(req.query.programId) : null;
  const report = await ruleStore.coverageForProgram(db, scope, investorId, programId);
  return res.json({ ok: true, scope, investorId, programId, ...report });
}

async function dismissSuggestionRoute(req, res) {
  const scope = readScope(req);
  const id = intIn(req.params.id, Number.MAX_SAFE_INTEGER);
  if (!id) return res.status(400).json({ error: 'Which suggestion? A positive numeric id is required.' });
  const b = req.body || {};
  const note = typeof b.note === 'string' ? b.note.trim() : null;
  const decidedBy = (req.actor && req.actor.id) || null;
  const out = await ruleStore.dismissSuggestion(db, scope, id, { decidedBy, note });
  if (!out.ok) return res.status(409).json({ error: out.error, message: 'Only an open suggestion can be dismissed.' });
  return res.json({ ok: true, scope });
}

// POST /suggestions/mine — mine per-investor rule suggestions from a disqualifying scenario (admin).
// Lender Price computes disqualifications asynchronously; the caller supplies either a `searchKey` from
// a prior disqualify kickoff (we poll + parse it) or an already-parsed `disqualified` result. Mining is
// best-effort and writes only PROPOSALS — a human accepts. Admin-gated: it hits the upstream and writes.
async function mineSuggestionsRoute(req, res) {
  const scope = readScope(req);
  const b = req.body || {};
  let parsed = null;

  if (b.disqualified && typeof b.disqualified === 'object') {
    parsed = b.disqualified; // an already-parsed parseDisqualified result
  } else if (b.searchKey) {
    const lp = require('../lenderprice/client');
    const pr = await lp.pollDisqualifiedByKey(String(b.searchKey));
    if (!pr || (!pr.ready && !pr.raw && !pr.parsed)) {
      return res.status(202).json({ ok: true, scope, status: 'computing', message: 'Lender Price is still computing the disqualifications; poll again shortly.' });
    }
    parsed = pr.parsed || lp.parseDisqualified(pr.raw);
  } else {
    return res.status(400).json({ error: 'Send a `searchKey` (from a disqualify kickoff) or a parsed `disqualified` result.' });
  }

  const out = await suggestionMiner.mineFromParsed(db, scope, parsed);
  if (!out.ok) return res.status(502).json({ ok: false, error: 'mine_failed', message: out.error });
  return res.json({ ok: true, scope, ...out });
}

async function listRulesRoute(req, res) {
  const scope = readScope(req);
  const opts = {};
  // investor_id / program_id are UUIDs (db/558); a non-UUID query param is ignored rather than
  // cast-erroring the query into a 500.
  if (req.query.investorId) opts.investorId = uuidOf(req.query.investorId);
  if (req.query.programId) opts.programId = uuidOf(req.query.programId);
  if (req.query.kind) opts.kind = String(req.query.kind);
  const rows = await ruleStore.listRules(db, scope, opts);
  return res.json({ ok: true, scope, total: rows.length, rules: rows });
}

// ---------------------------------------------------------------------------
// The program's LENDER PRICE SCOPE — which of their programs we compare against
// ---------------------------------------------------------------------------
//
// ADMIN-GATED, and that is not merely tidiness. `programLike` is compiled with
// `new RegExp(...)`, so this is the one door in the system that accepts a pattern
// the server will run; and a scope points every future comparison on this program
// at one Lender Price program out of seventeen, so a wrong one compares
// confidently against the wrong thing rather than failing. `lp-scope.validateScope`
// bounds and grammar-checks it before a character reaches the database.

// ---------------------------------------------------------------------------
// GET /programs — every program, and whether it is scoped to Lender Price yet
// ---------------------------------------------------------------------------
//
// The scope WRITER has existed since db/574 and nothing could reach it: `GET /investors` lists
// investors, and the write door needs a program's UUID, which no read surface published. So the
// answer to "which of our rate sheets are being compared against Lender Price at all?" was
// unavailable, and the honest answer today is "none of them" — an unscoped program's comparison
// ABSTAINS, which on a findings screen is indistinguishable from two engines that agree.
//
// READ-OPEN, WRITE-ADMIN, deliberately. The write is `requirePpeAdmin` (a scope decides which of
// Lender Price's programs our sheet is measured against — a wrong one produces confident agreement
// with the wrong thing). The read is not, because the thing worth seeing here is the ABSENCE of a
// scope, and hiding that from a non-admin leaves them reading an empty findings list as good news.

async function listProgramsRoute(req, res) {
  const scope = readScope(req);
  const rows = await store.listAllPrograms(db, scope);
  const programs = rows.map((row) => {
    const saved = lpScopeLib.scopeFromRow(row);
    return {
      id: row.id,
      code: row.code || null,
      name: row.name || null,
      investorId: row.investor_id || null,
      investorCode: row.investor_code || null,
      investorName: row.investor_name || null,
      lpScope: saved,
      describe: lpScopeLib.describeScope(saved),
      setAt: row.lp_scope_set_at || null,
      setBy: row.lp_scope_set_by || null,
    };
  });
  const unscoped = programs.filter((p) => !p.lpScope).length;
  return res.json({
    ok: true,
    scope,
    programs,
    unscoped,
    // Counted and SAID. A program with no scope does not compare against everything — it compares
    // against nothing, on purpose, and that is why its findings list is empty.
    note: unscoped
      ? `${unscoped} of ${programs.length} program${programs.length === 1 ? '' : 's'} ${unscoped === 1 ? 'has' : 'have'} no Lender Price scope, so ${unscoped === 1 ? 'its' : 'their'} shadow comparison abstains.`
      : null,
  });
}

async function getProgramLpScopeRoute(req, res) {
  const scope = readScope(req);
  const programId = uuidOf(req.params.id);
  if (!programId) return res.status(400).json({ error: 'That is not a program id.' });
  const r = await db.query('SELECT * FROM lt_ppe_program WHERE scope = $1 AND id = $2', [scope, programId]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: 'No such program.' });
  const saved = lpScopeLib.scopeFromRow(row);
  return res.json({
    ok: true, scope, programId, lpScope: saved, describe: lpScopeLib.describeScope(saved),
    setAt: row.lp_scope_set_at || null, setBy: row.lp_scope_set_by || null,
    // Said out loud rather than left as an empty object, because an unscoped program does not
    // silently compare against everything — it compares against NOTHING, on purpose, and somebody
    // looking at this screen needs to know that is why their findings list is empty.
    note: saved ? null : 'This program has no Lender Price scope, so its shadow comparison abstains: Lender Price answers with every program it sells and ours prices one, and comparing the two would be meaningless.',
  });
}

async function setProgramLpScopeRoute(req, res) {
  const scope = readScope(req);
  const programId = uuidOf(req.params.id);
  if (!programId) return res.status(400).json({ error: 'That is not a program id.' });
  const b = req.body || {};

  // A body with no `scope` key at all is REFUSED rather than read as "clear it". Clearing a scope
  // silently turns every future comparison on this program into an abstention, which looks exactly
  // like the feature being switched off — so it has to be asked for, explicitly, as `scope: null`.
  if (!Object.prototype.hasOwnProperty.call(b, 'scope')) {
    return res.status(400).json({ error: 'Send a `scope` object naming which Lender Price programs to compare against — or `scope: null` to clear it.' });
  }
  const v = lpScopeLib.validateScope(b.scope);
  if (!v.ok) return res.status(400).json({ error: v.error, field: v.field || null });

  const row = await store.setProgramLpScope(db, scope, programId, v.scope, (req.actor && req.actor.id) || null);
  if (!row) return res.status(404).json({ error: 'No such program.' });
  const saved = lpScopeLib.scopeFromRow(row);

  // THE SILENT FAILURE THIS ANSWERS: a pattern with one character wrong matches nothing, the
  // comparison abstains politely forever, and it is indistinguishable from a feature nobody turned
  // on. Paste the program names from a capture as `lpProgramNames` and the response says which ones
  // this scope actually selects — a guess becomes an answer, at the moment the scope is written.
  const preview = Array.isArray(b.lpProgramNames) ? lpScopeLib.previewScope(saved, b.lpProgramNames) : null;
  return res.json({
    ok: true, scope, programId, lpScope: saved, describe: lpScopeLib.describeScope(saved),
    cleared: !saved, preview,
  });
}

// ---------------------------------------------------------------------------
// Onboarding + the rate-sheet console (§2.11 "no admin screen consumes the built
// createInvestor/createProgram/rate-sheet writers yet")
//
// THE DEFECT THIS CLOSES is the one this workstream keeps finding: complete, tested machinery with
// no caller. Every rate-sheet writer in `ppe/store.js` — createInvestor, createProgram,
// createRateSheetVersion, replaceBasePrices, replaceAdjustments, setPriceLimit,
// publishRateSheetVersion — had ZERO callers anywhere in `src/`. So an investor could not be
// onboarded through the product at all, no sheet could be loaded, and the ≥200-scenario agreement
// gate added at the publish guarded a door that did not exist.
//
// FOUR RULES RUN THROUGH ALL OF IT:
//
//   1. OWNERSHIP IS CHECKED BEFORE ANYTHING IS TOUCHED. A version id arrives off an HTTP request, and
//      `loadRateSheet` is unscoped while the write helpers rewrite a whole grid — so every one of
//      these routes resolves the version through `store.rateSheetVersionInScope` FIRST and answers a
//      plain 404 otherwise. Another tenant's sheet must not be readable, let alone rewritable.
//   2. ONLY A DRAFT IS EDITABLE. The store's own design is append-only and effective-dated ("a
//      version's grid is set once"), so rewriting a PUBLISHED version in place would change what
//      every live quote prices from, with no new version, no new effective date, and no fresh
//      agreement run — silently. A published sheet is superseded by a NEW version, never edited.
//   3. NOBODY TYPES AN AGREEMENT RESULT. There is deliberately no route that records a passing
//      agreement run from a request body: a hand-typed "agreed on 240 scenarios" would satisfy the
//      gate without a single scenario being compared, which is precisely the state the gate exists to
//      make impossible. A run comes from the harness. The human path is the OVERRIDE, which is
//      honest about being one and records who and why.
//   4. A REFUSAL IS THE ANSWER, AND IT NAMES THE WAY FORWARD. The publish refusal carries the gate's
//      own reason and message plus the override shape, because a gate whose remedy the reader cannot
//      work out is the dead end this file has already recorded twice.
// ---------------------------------------------------------------------------

/** Bound on a single write, so one request cannot post an unbounded grid. */
const MAX_SHEET_ROWS = 5000;

/** A hard ceiling on one agreement run. Each scenario is a live, paid Lender Price call. */
const MAX_AGREEMENT_SCENARIOS = 500;

/** A finite number, else null — never NaN, never a coerced string into a numeric column. */
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
/** A required finite number; returns { ok, value } so the caller can name the field it refused. */
function reqNum(v) { const n = numOrNull(v); return n == null ? { ok: false } : { ok: true, value: n }; }

/** A non-empty trimmed string within a length bound, else null. */
function textOrNull(v, max = 200) {
  const s = v == null ? '' : String(v).trim();
  return s && s.length <= max ? s : null;
}

/**
 * Resolve a :versionId param to a version row IN THIS SCOPE, or answer and return null.
 * `opts.draftOnly` additionally refuses a version that is no longer a draft (rule 2 above).
 */
async function resolveVersion(req, res, opts = {}) {
  const scope = readScope(req);
  const versionId = uuidOf(req.params.id);
  if (!versionId) { res.status(400).json({ error: 'That is not a rate-sheet version id.' }); return null; }
  const row = await store.rateSheetVersionInScope(db, scope, versionId);
  if (!row) { res.status(404).json({ error: 'No such rate-sheet version.' }); return null; }
  if (opts.draftOnly && row.status !== 'draft') {
    res.status(409).json({
      error: `This rate sheet is ${row.status}, so its grid can no longer be edited.`,
      status: row.status,
      // The way forward, said out loud — otherwise this reads as the feature being broken.
      remedy: 'Create a NEW version for this program and build the grid there. A published sheet is what live quotes price from, so it is superseded by a new version rather than rewritten underneath them.',
    });
    return null;
  }
  return { scope, versionId, row };
}

async function createInvestorRoute(req, res) {
  const scope = readScope(req);
  const b = req.body || {};
  const code = textOrNull(b.code, 60);
  const name = textOrNull(b.name, 200);
  if (!code) return res.status(400).json({ error: 'Give the investor a short code (for example DHVN).', field: 'code' });
  if (!name) return res.status(400).json({ error: 'Give the investor its full name.', field: 'name' });

  // `store.createInvestor` is deliberately IDEMPOTENT — it UPSERTs on (scope, code) so an ingestion
  // pass can re-run safely, and that contract is not changed here. But a HUMAN typing a code that
  // already exists is not re-running an ingestion: they believe they are creating a new investor, and
  // the upsert would quietly RENAME the existing one instead. So the console door refuses the
  // collision and leaves the idempotency intact for programmatic callers.
  //
  // Check-then-act, so two people submitting the same code at the same instant could both pass this
  // check. The outcome is benign BECAUSE the store upserts — one row, the later name wins, nothing
  // corrupted — which is exactly why this is a pre-check and not a unique-violation catch.
  const clash = await db.query('SELECT id, name FROM lt_ppe_investor WHERE scope = $1 AND code = $2', [scope, code]);
  if (clash.rows.length) {
    return res.status(409).json({
      error: `An investor with the code ${code} already exists (${clash.rows[0].name}).`,
      field: 'code',
      investorId: clash.rows[0].id,
    });
  }
  const inv = await store.createInvestor(db, scope, { code, name, createdBy: (req.actor && req.actor.id) || null });
  return res.status(201).json({ ok: true, scope, investor: { id: inv.id, code: inv.code, name: inv.name } });
}

async function createProgramRoute(req, res) {
  const scope = readScope(req);
  const b = req.body || {};
  const code = textOrNull(b.code, 60);
  const name = textOrNull(b.name, 200);
  const investorId = uuidOf(b.investorId);
  if (!investorId) return res.status(400).json({ error: 'Say which investor this program belongs to.', field: 'investorId' });
  if (!code) return res.status(400).json({ error: 'Give the program a short code (for example DSCR30).', field: 'code' });
  if (!name) return res.status(400).json({ error: 'Give the program its full name.', field: 'name' });

  // The investor is checked IN SCOPE — a program must never be hung off another tenant's investor.
  const inv = await db.query('SELECT id FROM lt_ppe_investor WHERE id = $1 AND scope = $2', [investorId, scope]);
  if (!inv.rows.length) return res.status(404).json({ error: 'No such investor.', field: 'investorId' });

  // Same reasoning as createInvestorRoute: the store UPSERTs so ingestion can re-run, and the human
  // door refuses the collision so nobody renames an existing program by accident. NOTE the key is
  // (scope, investor_id, code) — the SAME code under a DIFFERENT investor is a different program and
  // must still be allowed, so this check is scoped to the investor too.
  const clash = await db.query(
    'SELECT id, name FROM lt_ppe_program WHERE scope = $1 AND investor_id = $2 AND code = $3',
    [scope, investorId, code]);
  if (clash.rows.length) {
    return res.status(409).json({
      error: `This investor already has a program with the code ${code} (${clash.rows[0].name}).`,
      field: 'code',
      programId: clash.rows[0].id,
    });
  }
  const program = await store.createProgram(db, scope, {
    investorId, code, name,
    channel: textOrNull(b.channel, 60) || undefined,
    createdBy: (req.actor && req.actor.id) || null,
  });
  return res.status(201).json({
    ok: true, scope,
    program: { id: program.id, code: program.code, name: program.name, channel: program.channel, status: program.status },
    // Said at creation rather than discovered later on an empty findings list.
    note: 'This program has no Lender Price scope yet, so its shadow comparison abstains until one is set.',
  });
}

async function createRateSheetRoute(req, res) {
  const scope = readScope(req);
  const programId = uuidOf(req.params.id);
  if (!programId) return res.status(400).json({ error: 'That is not a program id.' });
  const p = await db.query('SELECT * FROM lt_ppe_program WHERE id = $1 AND scope = $2', [programId, scope]);
  const program = p.rows[0];
  if (!program) return res.status(404).json({ error: 'No such program.' });

  const b = req.body || {};
  const channel = textOrNull(b.channel, 60) || program.channel || undefined;

  // The version number is DERIVED, not asked for. Two people onboarding the same program would
  // otherwise both type "1" and the second would collide on a unique key with nothing explaining it.
  const seq = await db.query(
    'SELECT COALESCE(MAX(version_no), 0)::int AS n FROM lt_ppe_rate_sheet_version WHERE scope = $1 AND program_id = $2',
    [scope, programId]);
  const versionNo = seq.rows[0].n + 1;

  const version = await store.createRateSheetVersion(db, scope, {
    programId, versionNo, channel,
    sourceFormat: textOrNull(b.sourceFormat, 40),
    createdBy: (req.actor && req.actor.id) || null,
  });
  return res.status(201).json({
    ok: true, scope, programId,
    version: { id: version.id, versionNo: version.version_no, channel: version.channel, status: version.status },
    note: 'A draft. Load its grid, its LLPAs and its price limits, then publish it — publishing asks the Lender Price agreement gate first.',
  });
}

async function getRateSheetRoute(req, res) {
  const found = await resolveVersion(req, res);
  if (!found) return undefined;
  const sheet = await store.loadRateSheet(db, found.versionId);
  const gate = await agreementStore.gateStatus(found.scope, found.versionId, { db });
  return res.json({
    ok: true,
    scope: found.scope,
    version: {
      id: found.row.id, versionNo: found.row.version_no, channel: found.row.channel,
      status: found.row.status, programId: found.row.program_id,
      effectiveFrom: found.row.effective_from || null, effectiveTo: found.row.effective_to || null,
    },
    basePrices: (sheet && sheet.basePrices) || [],
    adjustments: (sheet && sheet.adjustments) || [],
    priceLimit: (sheet && sheet.priceLimit) || null,
    editable: found.row.status === 'draft',
    // The gate's verdict travels WITH the sheet, so a console can say why Publish is refused before
    // anyone presses it rather than after.
    agreement: { proven: gate.proven, reason: gate.reason, message: gate.message },
  });
}

async function setBasePricesRoute(req, res) {
  const found = await resolveVersion(req, res, { draftOnly: true });
  if (!found) return undefined;
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'Send a `rows` array of base prices.' });
  if (rows.length > MAX_SHEET_ROWS) return res.status(400).json({ error: `That is more than ${MAX_SHEET_ROWS} rows in one write.` });

  // EVERY row is checked BEFORE ANY is written — a half-written grid prices real loans. Same rule the
  // completeness panels follow: nothing is filed until everything is acceptable.
  const clean = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {};
    const rate = reqNum(r.noteRateMilliPct);
    const lock = reqNum(r.lockDays);
    const price = reqNum(r.priceMilli);
    if (!rate.ok) return res.status(400).json({ error: `Row ${i + 1} has no note rate.`, row: i + 1, field: 'noteRateMilliPct' });
    if (!lock.ok) return res.status(400).json({ error: `Row ${i + 1} has no lock period.`, row: i + 1, field: 'lockDays' });
    if (!price.ok) return res.status(400).json({ error: `Row ${i + 1} has no price.`, row: i + 1, field: 'priceMilli' });
    clean.push({
      noteRateMilliPct: Math.round(rate.value), lockDays: Math.round(lock.value),
      priceMilli: Math.round(price.value), product: textOrNull(r.product, 60) || '',
    });
  }
  const written = await store.replaceBasePrices(db, found.scope, found.versionId, clean);
  return res.json({ ok: true, scope: found.scope, versionId: found.versionId, rows: written });
}

async function setAdjustmentsRoute(req, res) {
  const found = await resolveVersion(req, res, { draftOnly: true });
  if (!found) return undefined;
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'Send a `rows` array of adjustments.' });
  if (rows.length > MAX_SHEET_ROWS) return res.status(400).json({ error: `That is more than ${MAX_SHEET_ROWS} rows in one write.` });

  const clean = [];
  for (let i = 0; i < rows.length; i += 1) {
    const a = rows[i] || {};
    const dimension = textOrNull(a.dimension, 60);
    const adj = reqNum(a.adjMilli);
    if (!dimension) return res.status(400).json({ error: `Row ${i + 1} does not say which dimension it adjusts on.`, row: i + 1, field: 'dimension' });
    // A blank adjustment is REFUSED rather than stored as 0: an LLPA that silently prices at zero is
    // indistinguishable from one that was never loaded, and it is the sheet a quote prices from.
    if (!adj.ok) return res.status(400).json({ error: `Row ${i + 1} has no adjustment amount.`, row: i + 1, field: 'adjMilli' });
    clean.push({
      dimension,
      ficoMin: numOrNull(a.ficoMin), ficoMax: numOrNull(a.ficoMax),
      ltvMin: numOrNull(a.ltvMin), ltvMax: numOrNull(a.ltvMax),
      dscrMin: numOrNull(a.dscrMin), dscrMax: numOrNull(a.dscrMax),
      predicate: (a.predicate && typeof a.predicate === 'object') ? a.predicate : null,
      adjMilli: Math.round(adj.value),
      adjustmentTarget: textOrNull(a.adjustmentTarget, 40) || 'price',
      unit: textOrNull(a.unit, 40) || 'points',
      cumulative: a.cumulative !== false,
      priority: Math.round(numOrNull(a.priority) || 0),
      reason: textOrNull(a.reason, 200),
      code: textOrNull(a.code, 80),
      meta: (a.meta && typeof a.meta === 'object') ? a.meta : {},
    });
  }
  const written = await store.replaceAdjustments(db, found.scope, found.versionId, clean);
  return res.json({ ok: true, scope: found.scope, versionId: found.versionId, rows: written });
}

async function setPriceLimitRoute(req, res) {
  const found = await resolveVersion(req, res, { draftOnly: true });
  if (!found) return undefined;
  const b = req.body || {};
  const row = await store.setPriceLimit(db, found.scope, found.versionId, {
    minPriceMilli: numOrNull(b.minPriceMilli) == null ? null : Math.round(numOrNull(b.minPriceMilli)),
    roundingIncrementMilli: numOrNull(b.roundingIncrementMilli) == null ? undefined : Math.round(numOrNull(b.roundingIncrementMilli)),
    roundingMode: textOrNull(b.roundingMode, 40) || undefined,
    capTiers: Array.isArray(b.capTiers) ? b.capTiers : [],
    onExceed: textOrNull(b.onExceed, 40) || undefined,
  });
  return res.json({ ok: true, scope: found.scope, versionId: found.versionId, priceLimit: row });
}

async function agreementRoute(req, res) {
  const found = await resolveVersion(req, res);
  if (!found) return undefined;
  const gate = await agreementStore.gateStatus(found.scope, found.versionId, { db });
  const history = await agreementStore.listForVersion(found.scope, found.versionId, { db });
  return res.json({
    ok: true, scope: found.scope, versionId: found.versionId,
    proven: gate.proven, reason: gate.reason, message: gate.message,
    minComparableScenarios: agreementStore.MIN_COMPARABLE_SCENARIOS,
    history,
    // Said plainly, because the obvious next question on a refusal is "so how do I record one?".
    note: 'An agreement run is recorded by the Lender Price agreement harness, never typed in here — a hand-entered result would satisfy this gate without a single scenario being compared.',
  });
}

/**
 * RUN the ≥200-scenario Lender Price agreement harness against this sheet, and RECORD the verdict.
 *
 * THE MISSING HALF OF THE GATE. `ratesheet-agreement.js` has always MEASURED the owner's hard rule,
 * and db/576 gave the verdict somewhere to live — but nothing ever called the harness, so no run
 * could be recorded and the publish gate could only ever be passed by the recorded override. This is
 * what makes the gate satisfiable the honest way: a sheet becomes publishable because it was
 * MEASURED and agreed, never because somebody said it did. That is also why there is no route that
 * takes a result in a request body, and why this one takes none.
 *
 * IT IS PULLED, NOT PUSHED — no timer, same as the canary tick. This prices the whole battery against
 * a paid vendor, so a background loop firing it on its own schedule is the owner's decision, not a
 * refactor's.
 *
 * IT REFUSES BEFORE IT SPENDS. A run with no resolvable program, or with the upstream not configured,
 * would price N scenarios into N error verdicts that say nothing about agreement and cost real money
 * — the same reasoning `runBattery` already applies to a canary with no program.
 *
 * A FAILING RUN IS RECORDED TOO, and that is deliberate: it moves the gate from "nobody has measured
 * this" to "this disagrees", which are different answers that send a reader to different places.
 */
async function runAgreementRoute(req, res) {
  const found = await resolveVersion(req, res);
  if (!found) return undefined;

  const { program, lpScope, reason: noProgram } = await loadProgram(found.scope, found.versionId);
  if (!program) {
    return res.status(422).json({
      error: 'This rate sheet cannot be priced yet, so there is nothing to measure against Lender Price.',
      reason: noProgram,
    });
  }
  // THE COMPARISON MUST BE SCOPED, and an unscoped run is refused rather than run — the same rule the
  // shadow façade already applies, and it matters more here. Lender Price answers a scenario with its
  // WHOLE catalogue (an investor's seventeen product lines) while our sheet prices ONE; with no filter
  // the harness would reconcile our single ladder against a merge of all of them, and whatever verdict
  // came back — agree or disagree — would be about the wrong question. A recorded PASS from an
  // unscoped run is the worst outcome available: it opens the publish gate on a measurement that
  // measured something nobody asked for.
  if (!lpScope) {
    return res.status(422).json({
      error: 'This program has no Lender Price scope, so a run could not tell which of their programs to compare against.',
      reason: 'no_lp_scope',
      remedy: 'Set the scope first with POST /api/lt/ppe/programs/:id/lp-scope, then run the harness.',
    });
  }

  const lpClient = require('../lenderprice/client');
  if (typeof lpClient.configured === 'function' && !lpClient.configured()) {
    // Refused BEFORE the battery runs. Every scenario would come back an error verdict, the summary
    // would read "0 comparable", and the gate would record a measurement that measured nothing.
    return res.status(503).json({
      error: 'Lender Price is not configured, so this sheet cannot be measured against it yet.',
      reason: 'upstream_not_configured',
    });
  }

  const { values: settings } = await resolveSettingsSafe(found.scope);
  // `buildAgreementScenarios` returns **{ scenarios, count, byGroup }**, NOT an array. The first cut
  // read `.length` off that object: undefined, so nothing was ever capped and the OBJECT itself was
  // handed to the harness — which reads a non-array as an EMPTY list. The run then measured zero
  // scenarios, summarized them as a clean nothing, and recorded a verdict against a sheet it had never
  // compared. That is the exact shape this route exists to prevent, so an empty battery is a refusal
  // rather than a run: there is no honest verdict to record when there is nothing to measure.
  const built = agreementScenarios.buildAgreementScenarios();
  const all = Array.isArray(built && built.scenarios) ? built.scenarios : [];
  if (!all.length) {
    return res.status(500).json({
      error: 'The agreement battery came back empty, so there is nothing to measure and nothing will be recorded.',
      reason: 'empty_battery',
    });
  }
  const capped = all.length > MAX_AGREEMENT_SCENARIOS;
  const battery = capped ? all.slice(0, MAX_AGREEMENT_SCENARIOS) : all;

  let run;
  try {
    run = await ratesheetAgreement.runRatesheetAgreement(
      battery,
      // BOTH LEGS COME FROM `lp-agreement-legs`, and hand-rolling either one is how this route quietly
      // measured nothing. The canonical battery is a list of LENDER PRICE scenarios (value/loan/fico/
      // dscr/purpose/state/zip), NOT engine facts — our engine reads `ltv`/`loan_amount`/`dscr` in
      // MILLI and a normalized purpose, so handing it the raw LP object leaves nearly every rule
      // predicate reading an unknown fact and produces a confident, meaningless verdict. And
      // `client.price` answers `{ ok, raw }`, not the `{ full, disqualified }` the harness consumes:
      // passing it straight through means `legs.full` is undefined, every scenario is INCOMPARABLE,
      // and a live run reports "Lender Price gave no usable answer" on a perfectly healthy upstream.
      // `buildOursLeg({ factsFromLp: true })` and `buildLpLeg` are the ONE definition of each side —
      // the same pair the live agreement script uses, so the route and the script cannot drift.
      {
        ours: lpAgreementLegs.buildOursLeg(program, settings, { factsFromLp: true }),
        lp: lpAgreementLegs.buildLpLeg(lpClient, { withDisqualify: true }),
      },
      {
        // The stored scope, never a body value — same reasoning as the shadow route: a caller-supplied
        // filter is a second source for one fact, and `programLike` is compiled with `new RegExp`.
        filter: lpScope,
        priceToleranceMilli: settings[K.priceTolerance],
        rateToleranceMilli: settings[K.rateTolerance],
        concurrency: intIn(req.body && req.body.concurrency, 8) || 4,
      },
    );
  } catch (e) {
    return res.status(502).json({ error: `The agreement run could not finish: ${msgOf(e)}`, reason: 'run_failed' });
  }

  // THE RECORD IS THE POINT, so a failure to store it is reported as a failure — not as a run that
  // "worked". A caller told the sheet agreed, whose verdict never reached the ledger, would press
  // Publish and be refused with `never_measured` and no idea why.
  const rec = await agreementStore.recordRun(found.scope, {
    db,
    versionId: found.versionId,
    summary: run.summary,
    recordedBy: (req.actor && (req.actor.email || req.actor.id)) || null,
    nowMs: Date.now(),
  });
  // No silent caps: if the battery was trimmed the caller is told, because a run over fewer scenarios
  // than intended is a weaker claim than the one they asked for.
  const measured = {
    scope: found.scope,
    versionId: found.versionId,
    scenarios: battery.length,
    truncated: capped ? all.length - battery.length : 0,
    summary: run.summary,
  };

  if (!rec.ok) {
    // A FAILED RECORD IS A FAILED RUN, answered as one. The measurement still rides along — the
    // battery has already been priced against a paid vendor and throwing the answer away to make a
    // point would be worse — but the caller is never told "ok" about a verdict that did not land.
    // Silently returning 200 here is precisely how somebody presses Publish, is refused with
    // `never_measured`, and has no way to know the run they just watched succeed was never stored.
    return res.status(500).json({
      ok: false,
      error: 'The agreement run finished but its verdict could not be recorded, so this sheet is still unmeasured as far as the publish gate is concerned.',
      reason: 'not_recorded',
      recorded: false,
      recordError: rec.message || rec.reason || null,
      ...measured,
    });
  }

  const gate = await agreementStore.gateStatus(found.scope, found.versionId, { db });

  return res.json({
    ok: true,
    ...measured,
    recorded: true,
    recordError: null,
    gate: { proven: gate.proven, reason: gate.reason, message: gate.message },
  });
}

async function publishRateSheetRoute(req, res) {
  const found = await resolveVersion(req, res);
  if (!found) return undefined;
  const b = req.body || {};
  const out = await store.publishRateSheetVersion(db, found.scope, found.versionId, {
    override: b.override === true,
    overrideBy: (req.actor && (req.actor.email || req.actor.id)) || null,
    overrideReason: textOrNull(b.overrideReason, 500),
    nowMs: Date.now(),
  });
  if (out && out.refused) {
    return res.status(409).json({
      ok: false,
      error: out.refused.message,
      reason: out.refused.reason,
      gate: out.refused.gate || null,
      // Rule 4: the refusal names the two ways forward, so this can never read as a dead end.
      remedy: {
        measure: 'Run the Lender Price agreement harness against this sheet — that records a run and, if it agrees, the gate opens on its own.',
        override: 'Or publish it anyway by sending { "override": true, "overrideReason": "<why>" }. That is recorded against this version with your name on it, and it never counts as proof the sheet agrees.',
      },
    });
  }
  return res.json({
    ok: true, scope: found.scope, versionId: found.versionId,
    version: { id: out.id, versionNo: out.version_no, status: out.status, effectiveFrom: out.effective_from || null },
  });
}

// ---------------------------------------------------------------------------

router.get('/health', wrap(health, 'lt_ppe_health_error'));
router.get('/settings', wrap(getSettings, 'lt_ppe_settings_error'));
router.get('/investors', wrap(listInvestorsRoute, 'lt_ppe_investors_error'));
router.get('/findings', wrap(listFindingsRoute, 'lt_ppe_findings_error'));
router.get('/scoreboard', wrap(scoreboardRoute, 'lt_ppe_scoreboard_error'));
router.get('/suggestions', wrap(listSuggestionsRoute, 'lt_ppe_suggestions_error'));
router.get('/rules', wrap(listRulesRoute, 'lt_ppe_rules_error'));
router.get('/parity-cells', wrap(parityCellsRoute, 'lt_ppe_parity_cells_error'));
router.get('/programs', wrap(listProgramsRoute, 'lt_ppe_programs_error'));
router.get('/canary/schedules', wrap(listSchedulesRoute, 'lt_ppe_schedules_error'));
router.post('/quote', wrap(quoteRoute, 'lt_ppe_quote_error'));
router.post('/breakdown', wrap(breakdownRoute, 'lt_ppe_breakdown_error'));

router.post('/findings/:key/decide', requirePpeAdmin, wrap(decideFindingRoute, 'lt_ppe_decide_error'));
router.post('/canary', requirePpeAdmin, wrap(canaryRoute, 'lt_ppe_canary_error'));
router.post('/canary/schedules', requirePpeAdmin, wrap(saveScheduleRoute, 'lt_ppe_schedule_save_error'));
router.delete('/canary/schedules/:investor', requirePpeAdmin, wrap(deleteScheduleRoute, 'lt_ppe_schedule_delete_error'));
router.post('/canary/tick', requirePpeAdmin, wrap(canaryTickRoute, 'lt_ppe_canary_tick_error'));
router.get('/rules/coverage', requirePpeAdmin, wrap(ruleCoverageRoute, 'lt_ppe_rule_coverage_error'));
router.post('/suggestions/:id/accept', requirePpeAdmin, wrap(acceptSuggestionRoute, 'lt_ppe_accept_error'));
router.post('/suggestions/:id/dismiss', requirePpeAdmin, wrap(dismissSuggestionRoute, 'lt_ppe_dismiss_error'));
router.post('/suggestions/mine', requirePpeAdmin, wrap(mineSuggestionsRoute, 'lt_ppe_mine_error'));
router.get('/programs/:id/lp-scope', requirePpeAdmin, wrap(getProgramLpScopeRoute, 'lt_ppe_lp_scope_read_error'));
router.post('/programs/:id/lp-scope', requirePpeAdmin, wrap(setProgramLpScopeRoute, 'lt_ppe_lp_scope_write_error'));

// Onboarding + the rate-sheet console. ALL admin-gated: these writers decide what every quote on this
// program prices from. There is deliberately NO route that records an agreement RUN — see rule 3 above.
router.post('/investors', requirePpeAdmin, wrap(createInvestorRoute, 'lt_ppe_investor_create_error'));
router.post('/programs', requirePpeAdmin, wrap(createProgramRoute, 'lt_ppe_program_create_error'));
router.post('/programs/:id/rate-sheets', requirePpeAdmin, wrap(createRateSheetRoute, 'lt_ppe_ratesheet_create_error'));
router.get('/rate-sheets/:id', requirePpeAdmin, wrap(getRateSheetRoute, 'lt_ppe_ratesheet_read_error'));
router.put('/rate-sheets/:id/base-prices', requirePpeAdmin, wrap(setBasePricesRoute, 'lt_ppe_base_prices_error'));
router.put('/rate-sheets/:id/adjustments', requirePpeAdmin, wrap(setAdjustmentsRoute, 'lt_ppe_adjustments_error'));
router.put('/rate-sheets/:id/price-limit', requirePpeAdmin, wrap(setPriceLimitRoute, 'lt_ppe_price_limit_error'));
router.get('/rate-sheets/:id/agreement', requirePpeAdmin, wrap(agreementRoute, 'lt_ppe_agreement_read_error'));
router.post('/rate-sheets/:id/agreement/run', requirePpeAdmin, wrap(runAgreementRoute, 'lt_ppe_agreement_run_error'));
router.post('/rate-sheets/:id/publish', requirePpeAdmin, wrap(publishRateSheetRoute, 'lt_ppe_publish_error'));

module.exports = router;
module.exports.handlers = {
  health, getSettings, listInvestorsRoute, listFindingsRoute, decideFindingRoute, quoteRoute, breakdownRoute, canaryRoute, scoreboardRoute,
  listSuggestionsRoute, acceptSuggestionRoute, dismissSuggestionRoute, listRulesRoute, mineSuggestionsRoute,
  ruleCoverageRoute, getProgramLpScopeRoute, setProgramLpScopeRoute, parityCellsRoute, listProgramsRoute,
  listSchedulesRoute, saveScheduleRoute, deleteScheduleRoute, canaryTickRoute,
  createInvestorRoute, createProgramRoute, createRateSheetRoute, getRateSheetRoute,
  setBasePricesRoute, setAdjustmentsRoute, setPriceLimitRoute, agreementRoute, runAgreementRoute,
  publishRateSheetRoute,
};
module.exports._internals = {
  requirePpeAdmin, intIn, readScope, loadProgram, resolveSettingsSafe,
  MAX_CANARY_SCENARIOS, SCOPE, DECIDABLE, NOT_DECIDABLE, K, programLabel, resolveBattery, runBattery, msgOf,
  resolveVersion, numOrNull, textOrNull, MAX_SHEET_ROWS, MAX_AGREEMENT_SCENARIOS,
};

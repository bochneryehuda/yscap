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
const scenarioMatrix = require('../ppe/scenario-matrix');
const ratesheet = require('../ppe/ratesheet');
const ruleStore = require('../ppe/rule-store');
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

  let scenarios;
  if (Array.isArray(b.scenarios)) {
    scenarios = b.scenarios;
  } else if (b.matrix && typeof b.matrix === 'object') {
    try {
      // buildMatrix returns { scenarios, fullSize, truncated, stride } — NOT an array. Taking it
      // whole made `Array.isArray(scenarios)` false below, so EVERY matrix-shaped canary answered
      // 400 "that produced no scenarios to price" and the endpoint's own size refusal was
      // unreachable from this branch. Found by the re-audit; it matters more now that a saved
      // schedule can carry a matrix.
      const expanded = scenarioMatrix.buildMatrix(b.matrix);
      scenarios = expanded.scenarios;
      // A STRIDED-DOWN battery is never priced silently: an agreement rate measured over scenarios
      // nobody chose reads cleaner than it is, and this endpoint already refuses rather than
      // truncates when a caller sends too many outright.
      if (expanded.truncated) {
        return res.status(422).json({
          error: `That matrix expands to ${expanded.fullSize} scenarios; this endpoint prices at most ${MAX_CANARY_SCENARIOS} in one run. Narrow it — it is refused rather than thinned, because an agreement rate over a thinned battery is measured on scenarios nobody chose.`,
          limit: MAX_CANARY_SCENARIOS, asked: expanded.fullSize,
        });
      }
    } catch (e) {
      return res.status(400).json({ error: `That matrix could not be expanded: ${String((e && e.message) || e).slice(0, 160)}` });
    }
  } else {
    return res.status(400).json({ error: 'Send either `scenarios` (an array) or `matrix` (axes to expand).' });
  }
  if (!Array.isArray(scenarios) || !scenarios.length) {
    return res.status(400).json({ error: 'That produced no scenarios to price.' });
  }
  if (scenarios.length > MAX_CANARY_SCENARIOS) {
    return res.status(422).json({
      error: `That is ${scenarios.length} scenarios; this endpoint prices at most ${MAX_CANARY_SCENARIOS} in one run. Narrow the matrix.`,
      limit: MAX_CANARY_SCENARIOS,
      asked: scenarios.length,
    });
  }

  const { program, reason: noProgram } = await loadProgram(scope, b.rateSheetVersionId);
  if (!program) {
    // Same reasoning as /quote, and it matters more here: a canary with no
    // program would price N scenarios against a live upstream and record N
    // engine_error findings that say nothing about agreement.
    return res.status(422).json({ error: 'A canary needs a rate-sheet version to price against.', reason: noProgram });
  }

  const { values: settings } = await resolveSettingsSafe(scope);
  const lp = require('../lenderprice/client');
  const nowMs = Date.now();

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
      concurrency: intIn(b.concurrency, 8) || 4,
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

  return res.json({
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

router.get('/health', wrap(health, 'lt_ppe_health_error'));
router.get('/settings', wrap(getSettings, 'lt_ppe_settings_error'));
router.get('/investors', wrap(listInvestorsRoute, 'lt_ppe_investors_error'));
router.get('/findings', wrap(listFindingsRoute, 'lt_ppe_findings_error'));
router.get('/scoreboard', wrap(scoreboardRoute, 'lt_ppe_scoreboard_error'));
router.get('/suggestions', wrap(listSuggestionsRoute, 'lt_ppe_suggestions_error'));
router.get('/rules', wrap(listRulesRoute, 'lt_ppe_rules_error'));
router.get('/parity-cells', wrap(parityCellsRoute, 'lt_ppe_parity_cells_error'));
router.post('/quote', wrap(quoteRoute, 'lt_ppe_quote_error'));
router.post('/breakdown', wrap(breakdownRoute, 'lt_ppe_breakdown_error'));

router.post('/findings/:key/decide', requirePpeAdmin, wrap(decideFindingRoute, 'lt_ppe_decide_error'));
router.post('/canary', requirePpeAdmin, wrap(canaryRoute, 'lt_ppe_canary_error'));
router.get('/rules/coverage', requirePpeAdmin, wrap(ruleCoverageRoute, 'lt_ppe_rule_coverage_error'));
router.post('/suggestions/:id/accept', requirePpeAdmin, wrap(acceptSuggestionRoute, 'lt_ppe_accept_error'));
router.post('/suggestions/:id/dismiss', requirePpeAdmin, wrap(dismissSuggestionRoute, 'lt_ppe_dismiss_error'));
router.post('/suggestions/mine', requirePpeAdmin, wrap(mineSuggestionsRoute, 'lt_ppe_mine_error'));
router.get('/programs/:id/lp-scope', requirePpeAdmin, wrap(getProgramLpScopeRoute, 'lt_ppe_lp_scope_read_error'));
router.post('/programs/:id/lp-scope', requirePpeAdmin, wrap(setProgramLpScopeRoute, 'lt_ppe_lp_scope_write_error'));

module.exports = router;
module.exports.handlers = {
  health, getSettings, listInvestorsRoute, listFindingsRoute, decideFindingRoute, quoteRoute, breakdownRoute, canaryRoute, scoreboardRoute,
  listSuggestionsRoute, acceptSuggestionRoute, dismissSuggestionRoute, listRulesRoute, mineSuggestionsRoute,
  ruleCoverageRoute, getProgramLpScopeRoute, setProgramLpScopeRoute, parityCellsRoute,
};
module.exports._internals = {
  requirePpeAdmin, intIn, readScope, loadProgram, resolveSettingsSafe,
  MAX_CANARY_SCENARIOS, SCOPE, DECIDABLE, NOT_DECIDABLE, K, programLabel,
};

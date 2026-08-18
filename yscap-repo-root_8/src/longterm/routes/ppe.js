'use strict';

// =============================================================================
// LT PRODUCT & PRICING ENGINE — the HTTP surface.  /api/lt/ppe/*
// =============================================================================
//
// Everything under `src/longterm/ppe/` was built, tested and UNREACHABLE: there
// was no route. This is that route. Design + rationale:
// `docs/longterm/PPE-MEGA-PLAN.md`; the module map is `src/longterm/ppe/README.md`.
// (This line used to quote a suite COUNT — "27 suites". It was true the day it was
// written and stale within the month; the family is globbed by
// `scripts/test-lt-ppe-all.js`, so the count lives in the runner's own output and
// is never restated here. `scripts/test-lt-ppe-claim-drift.js` fails the build if a
// hard-coded suite count comes back.)
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
//     scoreboard (§11), and it is STILL not exposed here — there is no promote,
//     no rollback and no per-investor mode on this router.
//     WHAT CHANGED, AND THE REASON THIS BULLET NOW GIVES A DIFFERENT ONE: this
//     bullet used to say the gate and the ledger were pure modules with no table
//     behind them and no home for the history they replay. That stopped being
//     true when db/566 (`lt_ppe_cutover_ledger`) and `ppe/cutover-store.js`
//     landed. The ledger HAS a durable, append-only home; `appendDecision` writes
//     a decision and `verifyHistory` replays the whole sequence. So the old
//     reason — a promote button whose decision could not be durably recorded
//     being worse than no button — no longer applies and must not be repeated as
//     if it did. What is missing is the DECISION, not the record: who may
//     promote, and whether a "live" investor keeps an LP spot-check canary, are
//     owner calls (the REQUIREMENTS-LEDGER carries them as BLK5 / P10). Until
//     those are answered the route exposes no lifecycle at all, and
//     `GET /investors` says so rather than implying every investor is in `draft`.
//   · **No route that records an agreement run FROM A REQUEST BODY.** That
//     qualifier is the whole rule (see rule 3 in the rate-sheet console section
//     below) and it must never be shortened to "no route records an agreement
//     run": `POST /rate-sheets/:id/agreement/run` exists and DOES record one —
//     the verdict of a battery it priced itself against Lender Price. The banned
//     thing is a hand-typed result, which would open the publish gate without a
//     single scenario being compared.
//
// AUTH: staff authentication is applied at the mount seam in `src/server.js`,
// like every other LT router. Reads are open to any staff member — an engineer has
// to be able to see why a scenario disagreed. **Every write on this router is
// ADMIN-gated except the two pricing doors** (`POST /quote` and `POST /breakdown`,
// explained immediately below): settling a finding, running a canary battery,
// arming/removing a canary schedule, ticking the scheduler, mining and deciding
// rule suggestions, setting a program's Lender Price scope, creating an
// investor/program/rate sheet, every rate-sheet grid write, running the agreement
// harness, and publishing. A handful of admin-only READS sit behind the same gate
// (the sheet read-back, its coverage and diff, the rule-coverage report, a
// program's LP scope) because they expose what a program prices from.
// THIS PARAGRAPH USED TO NAME A COUNT — it said the admin gate was on the two
// deliberate operator actions and that those were the only gated routes. That was
// true when there were two, and a count in prose is a hand-kept list, so no number
// is restated here. The RULE is stated instead, and
// `scripts/test-lt-ppe-claim-drift.js` fails the build if any route other than the
// two named pricing doors is registered without the gate.
//
// `POST /quote` is deliberately NOT admin-gated, and it is worth being precise
// about why, because it DOES have side effects: it calls the live Lender Price
// upstream, and a disagreement appends to the findings ledger. An earlier version
// of this header claimed "everything that WRITES is admin-gated", which was simply
// false. It is left open because pricing a scenario is the ordinary thing a staff
// member does with a pricing engine, and its write is an OBSERVATION — the ledger
// records that the two engines disagreed, which is true whoever asked. What an
// ordinary user must not do is SETTLE that observation, launch a 500-scenario
// battery at the upstream, or change what a program prices from — and every one of
// those is behind the admin gate.

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
const priceLimitLib = require('../ppe/price-limit');
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
// The rule-AUTHORING service and its draft store. Four modules with no HTTP door at all until now —
// see the RULE DRAFTS section below, including why `publishDraft` still has none.
const ruleAuthoring = require('../ppe/rule-authoring');
const ruleDraftStore = require('../ppe/rule-authoring-store');
const agreementStore = require('../ppe/agreement-store');
const ratesheetAgreement = require('../ppe/ratesheet-agreement');
const agreementScenarios = require('../ppe/agreement-scenarios');
const lpAgreementLegs = require('../ppe/lp-agreement-legs');
const programRegistry = require('../ppe/program-registry');
const agreementScenarioGenerator = require('../ppe/agreement-scenario-generator');
const ratesheetCells = require('../ppe/ratesheet-cells');
const ratesheetDiff = require('../ppe/ratesheet-diff');
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

    // THE ACCEPTED OVERLAY RULES, which until now reached NOTHING that prices.
    //
    // MEASURED, on a real database: a stored, accepted "decline under FICO 660" is returned by
    // `rule-store.rulesForProgram`, is ABSENT from the program built here, and a FICO-600 loan prices
    // `eligible:true` with no declines at all. Everything the suggestion-accept flow produces — and
    // everything the rule-authoring service publishes — was decorative: written to `lt_ppe_rule`,
    // listed by `GET /rules`, analysed by `GET /rules/coverage`, and evaluated by nobody. The blast
    // radius is every consumer of this function: the quote, the breakdown, the canary, the scheduled
    // canary, the coverage read, AND the agreement run — so OUR leg of a gate whose whole subject is
    // "we agree with Lender Price on every eligibility AND ineligibility" was pricing with zero
    // eligibility rules, and a PASS was a pass on a sheet that could not decline anything.
    //
    // `rulesForProgram` already returns the `rules.js` shape and already scopes the set correctly —
    // house rules (investor NULL) plus this investor's plus this program's, effective-dated — so this
    // is the missing CALL, not a second definition of the rule set.
    //
    // ORDER IS SAFE BY THE ENGINE'S OWN CONTRACT: `evaluateRules` sorts by `priority` then input
    // order, stably. Appending therefore leaves the sheet's own rules first at equal priority, which
    // is the right default — the sheet is the base and an overlay rides on top — and a rule that
    // means to come earlier says so with its priority.
    let storedRules = [];
    try {
      storedRules = await ruleStore.rulesForProgram(
        db, scope,
        (sheet.program && sheet.program.investor_id) || null,
        (sheet.program && sheet.program.id) || null,
      );
    } catch (e) {
      // FAILS CLOSED, and this is the whole point rather than defensive decoration. Swallowing the
      // error would price the loan with no eligibility rules and call it eligible — which is exactly
      // the defect being fixed, reintroduced as a "graceful degradation". A program whose rule set
      // cannot be read is not a program that has no rules.
      return { program: null, reason: `rules_unreadable: ${String((e && e.message) || e).slice(0, 120)}` };
    }
    if (storedRules.length) program.rules = (program.rules || []).concat(storedRules);

    // THE SHEET'S OWN MAX-PRICE RULE, attached HERE because this is the one door that turns a
    // stored sheet into a priced program — and because the ceiling on some sheets depends on a
    // SCENARIO fact, which no stored tier list can hold.
    //
    // MEASURED, on a real database: the Deephaven DSCR sheet states "max price is the LOWER of the
    // loan-amount tier and the prepay-term ceiling", and only the loan-amount half ever reached a
    // priced quote — `deephaven-dscr-prepay-maxprice.programWithPriceLimit`, the function that
    // combines the two, had NO production caller at all. On a $1,000,000 loan with a 3-year prepay
    // that put four coupons out at 104750 against a sheet whose own rule caps them at 103750: a FULL
    // POINT, with nothing in the answer saying a ceiling had been skipped.
    //
    // `price-limit.scenarioRuleFor` is the registry; the function it returns is that sheet's OWN, so
    // there is no second definition of any ceiling here. A sheet with no such rule attaches nothing
    // and is priced on its stored tiers — correct, and REPORTED (`priceLimitRule`) rather than left
    // to read as "the whole rule was applied".
    const investorName = (sheet.investor && (sheet.investor.name || sheet.investor.code)) || null;
    const scenarioRule = priceLimitLib.scenarioRuleFor(investorName);
    if (scenarioRule) {
      program.scenarioPriceLimit = scenarioRule.resolve;
      program.priceLimitSheet = scenarioRule.sheet;
    } else {
      program.priceLimitRuleReason = investorName ? 'no_scenario_rule_registered' : 'investor_unknown';
    }

    // WHICH Lender Price programs a comparison against this sheet is about (db/574). It rides on the
    // owning PROGRAM row, not the sheet version, because it is a statement about the investor's
    // product family and survives every reprice of the sheet. NULL is the norm until a human states
    // it, and null means "not scoped" — the comparison then abstains and says so, never compares our
    // one ladder against a merge of Lender Price's seventeen.
    return {
      program,
      lpScope: lpScopeLib.scopeFromRow(sheet.program),
      // The investor's NAME, which is the only key into `program-registry`. Carried here so the
      // agreement run can ask that investor's own prepayment layer; every other caller ignores it.
      investorName,
      // WHICH max-price rule governs a quote off this sheet — reported so a caller never has to
      // assume. `sheet_tiers_only` is a real and often correct answer; it is not silence.
      priceLimitRule: scenarioRule
        ? { rule: priceLimitLib.RULE.SCENARIO, sheet: scenarioRule.sheet }
        : { rule: priceLimitLib.RULE.SHEET_TIERS_ONLY, sheet: null, reason: program.priceLimitRuleReason },
      // HOW MANY accepted rules are in force, so a caller can say so rather than leave a reader to
      // assume. Zero is a real answer and a different one from "we could not read them", which is a
      // refusal above.
      storedRuleCount: storedRules.length,
      reason: null,
    };
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
    // Honest about what is NOT modelled HERE, and precise about why — the earlier
    // wording ("the cutover ledger has no table") stopped being true when db/566 +
    // `ppe/cutover-store.js` landed, and it was shipped in this response body, so a
    // screen was repeating it to a human. The truth: `lt_ppe_investor` has no mode
    // column and this router reads no lifecycle, so there is no per-investor mode to
    // report; the ledger itself IS durable. Every investor is in shadow because §1.2
    // says everything is.
    lifecycle: {
      mode: 'shadow',
      perInvestor: false,
      note: 'This engine reports no per-investor lifecycle: every investor is in shadow and Lender Price is authoritative. The cutover decision ledger is durable (lt_ppe_cutover_ledger, db/566) — what is missing is a promote/rollback control, which waits on who may promote and whether a live investor keeps a Lender Price spot-check.',
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

  // THE SHEET'S CEILING IS PART OF THE ANSWER, NOT A DETAIL BURIED IN THE SHADOW BLOCK.
  // Our engine states, per scenario, whether the rate sheet's own max-price rule governed this
  // quote — and, when it could not, what it fell closed onto and why. That must never be
  // something the caller has to go and ask for: a ceiling that was skipped and a ceiling that
  // was honoured look identical in the number alone. `priceLimitNotice` is the ONE wording, and
  // it is null exactly when the sheet's own rule governed and there is nothing to say.
  const capRes = (result && result.shadow && result.shadow.priceLimit) || null;
  const priceLimitNote = quote.priceLimitNotice(capRes);

  return res.json({
    ok: true, scope, ...result,
    priceLimit: capRes,
    ...(priceLimitNote ? { priceLimitNote } : {}),
  });
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
  const { program, lpScope, reason: noProgram } = await loadProgram(scope, opts.rateSheetVersionId);
  if (!program) {
    // Same reasoning as /quote, and it matters more here: a canary with no
    // program would price N scenarios against a live upstream and record N
    // engine_error findings that say nothing about agreement.
    return { refused: { status: 422, body: { error: 'A canary needs a rate-sheet version to price against.', reason: noProgram } } };
  }

  // AND IT NEEDS TO KNOW WHICH LENDER PRICE PROGRAMS IT IS ABOUT, for exactly the reason the /quote
  // facade abstains without one (`lp-scope.js`): Lender Price answers one request with EVERY program
  // it sells — 17 on the live Deephaven capture, across several investors and product lines — while
  // this sheet prices ONE. Merging all of them into a single ladder does not weaken the comparison, it
  // empties it: every coupon Lender Price offers on an unrelated product reads as one "we do not
  // price", which looks like a defect in our engine and is really a statement about an unscoped query.
  //
  // REFUSED HERE, ONCE, BEFORE ANYTHING IS PRICED — not per scenario. The scope is a property of the
  // sheet, so an unscoped battery would produce the SAME configuration complaint 299 times, bury the
  // real findings under it and bill a live upstream for the privilege. That is the same reasoning as
  // the no-program refusal directly above. The scope is STATED by a human on the program row (db/574);
  // nothing here infers one from our own program code, which would be a guess about somebody else's
  // product catalogue and is worse than no scope at all.
  if (!lpScope) {
    return { refused: { status: 422, body: {
      error: 'This rate sheet does not say which Lender Price programs to compare against, so a canary '
        + 'would compare our one ladder against every program Lender Price returned. Set the program\'s '
        + 'Lender Price scope (its program name, or a family pattern such as "DSCR .* 30 Yr Fixed") and run it again.',
      reason: 'no_lp_scope',
    } } };
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
  //
  // AND THAT TRAP HAD A SECOND FLOOR, WHICH IS WHAT `buildCanaryLpLeg` CLOSES. `theirs` was
  // `(sc) => lp.price(sc)` — the RAW VENDOR ENVELOPE (`{ ok, raw, request, searchKey, provenance }`),
  // not a ladder: no `eligible` flag, no rungs. `parity.isComparable` therefore read Lender Price as
  // having produced no result and every scenario came back `incomparable`. Measured on the canonical
  // 299-scenario battery before the fix: 299 incomparable, 0 comparable, agreementRate NULL — and the
  // run was still persisted into the series the go-live gate reads, and this endpoint still answered
  // 200. A green canary that compared nothing. The three-step chain (price -> parse -> normalize to the
  // scoped ladder) lives in `lp-agreement-legs` beside the agreement harness's own LP leg, so neither
  // is hand-wired here and there is no second definition of "a comparable Lender Price answer".
  const run = await canary.runCanary(
    scenarios,
    {
      ours: (sc) => quote.quoteProgram({ scenario: sc, program, settings }),
      theirs: lpAgreementLegs.buildCanaryLpLeg(lp, { scope: lpScope }),
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

  // FAIL CLOSED: A RUN THAT COMPARED NOTHING MAY NOT REPORT SUCCESS, AND MAY NOT ENTER THE SERIES THE
  // GO-LIVE GATE READS. `canary.verdictOf` is the one definition of "did this battery actually compare
  // anything" — `comparable`, less the scenarios where an engine threw. Before this, an
  // all-incomparable run answered 200 with `agreementRate: null` and wrote a NULL-rate row into
  // `lt_ppe_shadow_run`, plus a matrix of nothing into the parity cells: durable records that measured
  // nothing, sitting in the two series the clean-day streak and the per-band trend are computed from.
  // `cutover.eligibleForLive` independently refuses a null rate and any incomparable count, so the
  // PROMOTE gate was never going to pass on it; what was wrong is that the run reported like a run, the
  // response said `ok`, and the schedule tick counted it as having measured that investor that night.
  //
  // THE FINDINGS ARE STILL PERSISTED ABOVE, DELIBERATELY: an `incomparable` / `engine_error` record is
  // the diagnosis of WHY nothing could be compared, and discarding it would leave nothing to work from.
  // What is refused is the CLAIM that a measurement happened.
  if (!run.verdict.proven) {
    return { refused: { status: 422, body: {
      ok: false,
      scope,
      investor,
      proven: false,
      error: run.verdict.reason,
      reason: 'canary_compared_nothing',
      scenarios: scenarios.length,
      agreementRate: null,
      summary: run.summary,
      verdict: run.verdict,
      report: run.report,
      lpScope: lpScopeLib.describeScope(lpScope),
      findings: run.findingKeys.length,
      // The findings ledger DID take the diagnosis; the run series and the parity cells deliberately
      // did not — a measurement of nothing is not a measurement.
      persisted: !persistError,
      persistError,
      persistedSummary: persisted ? persisted.summary : null,
      runPersisted: false,
      runPersistReason: 'refused_nothing_compared',
      cellsPersisted: false,
    } } };
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
    // Stated beside the rate: a caller reading only `agreementRate` cannot tell a measured 100% from a
    // measured nothing, and this endpoint used to answer the second one exactly like the first.
    proven: true,
    verdict: run.verdict,
    // WHICH Lender Price board this was compared against, named rather than implied.
    lpScope: lpScopeLib.describeScope(lpScope),
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
 * runCanaryTick — the tick itself, as a FUNCTION. ONE definition, two callers.
 *
 * It was extracted out of the route handler the moment a second caller existed (the in-process driver,
 * `src/longterm/ppe/canary-driver.js`), and the extraction is the point: a tick an operator fires by
 * hand and a tick a cadence fires at 3am must select, refuse and report IDENTICALLY, or the agreement
 * series would mean one thing on the days a person pressed the button and another thing the rest of the
 * week — and the go-live gate reads that series. A second copy of this loop is the ordinary way that
 * happens, so there is one. The route below is now three lines of HTTP.
 *
 * FAILS TOWARD NOT RUNNING, at every step, because the two failures are not symmetric: a canary that
 * does not fire is a gap somebody can see on the scoreboard, while one that fires when it should not is
 * N live vendor calls per tick, forever. So an unreadable last-run stamp, an unresolvable program, an
 * unexpandable battery and a paused schedule all HOLD — each with the reason attached to that schedule,
 * never swallowed and never turned into a silent success.
 *
 * Returns the payload the route answers with; it never writes a response and never throws for a reason
 * a schedule owns (a schedule's own failure is reported against that schedule).
 */
async function runCanaryTick(scope, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  // ONE per tick by default. Each run is a whole battery against a live upstream, so the cap is about
  // the vendor, not about speed — and whatever it holds back is REPORTED, because a tick that quietly
  // skipped half its schedules looks exactly like a tick with nothing to do.
  const maxPerTick = intIn(opts.maxPerTick, 5) || 1;

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

  return {
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
  };
}

/** POST /canary/tick — the tick above, over HTTP. The rule lives in `runCanaryTick`, never here. */
async function canaryTickRoute(req, res) {
  const b = req.body || {};
  return res.json(await runCanaryTick(readScope(req), { nowMs: Date.now(), maxPerTick: b.maxPerTick }));
}

/**
 * GET /canary/driver — is anything actually driving the tick, and what did it last do?
 *
 * The question this answers is the one the defect was: a schedule can be saved, enabled and perfectly
 * valid while NOTHING calls the tick, and every screen that reads the run series shows that as a low
 * score rather than as "nobody is asking". So this states, plainly and in one read: whether the
 * in-process driver is switched on at all, when it last tried, what it did, why it did not, and — when
 * two instances raced — which one was turned away.
 */
async function canaryDriverRoute(req, res) {
  const canaryDriver = require('../ppe/canary-driver');
  return res.json(await canaryDriver.describe(readScope(req), { db }));
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
// RULE DRAFTS — the READ + DRAFT doors of the rule-authoring service.
// ---------------------------------------------------------------------------
//
// MEASURED BEFORE THIS EXISTED: `ppe/rule-authoring.js` (642 lines) and
// `ppe/rule-authoring-store.js` (276 lines, db/577) had NO HTTP door of any kind, and the two
// libraries under them — `rule-builder.js` and `ppp-structures.js` — were reached from the
// authoring service and from the layer compilers, so the authoring half of them was reachable by
// nothing. A caller that is not itself called is not a caller.
//
// ⛔ THE PUBLISH DOOR IS DELIBERATELY NOT HERE, AND ITS ABSENCE IS THE POINT.
// `rule-authoring-store.publishDraft` writes into `lt_ppe_rule`, which is the set
// `rule-store.rulesForProgram` hands to the engine — so publishing CHANGES A PRICED NUMBER. Who is
// allowed to do that is an owner decision that has not been made: the question is recorded as §2.51
// in docs/longterm/LENDER-PRICE-PARITY-STATUS.md and is NOT answered here. Gating it behind
// `requirePpeAdmin` because that is the gate on the neighbouring routes would BE the answer, chosen
// by convenience, and would put a rule in front of real loans on that basis. So `publishDraft` stays
// unreachable over HTTP until somebody with the authority to decide says which authority it takes.
//
// EVERYTHING BELOW IS STRUCTURALLY INCAPABLE OF MOVING A PRICE. Drafts live in `lt_ppe_rule_draft`
// (db/577) and nothing in the pricing path reads that table — not "careful not to", incapable. Each
// response says so in its own payload (`live: false`) rather than leaving the screen to remember it.
//
// ADMIN-GATED, like the rest of this console's write surface. That is a gate on WRITING A DRAFT, not
// on publishing one, and the two must not be confused: see §2.51.

/** The statuses db/577's CHECK allows, plus the 'all' the store understands. */
const DRAFT_STATUSES = ['draft', 'published', 'discarded'];

/** A bigint identity id (db/577), else null. */
function draftIdOf(v) { return intIn(v, Number.MAX_SAFE_INTEGER); }

/**
 * A UUID query/body field that is OPTIONAL but, when supplied, must parse.
 *
 * Returns { ok:true, value } or { ok:false }. Coercing an unreadable id to null would be worse than
 * a refusal here: `listDrafts` reads `investorId: null` as "the HOUSE drafts", so a typo'd id would
 * quietly answer a different question and the list would look empty for the wrong reason.
 */
function optionalUuid(v) {
  if (v === undefined || v === null || v === '') return { ok: true, value: undefined };
  const id = uuidOf(v);
  return id ? { ok: true, value: id } : { ok: false };
}

/** The sentence every draft door says out loud, so a screen cannot forget to. */
const DRAFT_NOT_LIVE = 'A draft prices nothing and declines nobody. It is not part of any rule set an engine evaluates, and there is no route on this server that publishes one.';

// GET /rule-drafts — the drafts, plus the catalog a screen builds its pickers from.
//
// The catalog rides WITH the list rather than on a door of its own. That is not tidiness: a separate
// `/rule-drafts/catalog` would share its shape with `/rule-drafts/:id`, and a call to either could
// resolve to the other — the ambiguity `check-lt-http-reachability` refuses, and rightly.
async function listRuleDraftsRoute(req, res) {
  const scope = readScope(req);
  const opts = {};

  const status = textOrNull(req.query.status, 20);
  if (status) {
    if (status !== 'all' && !DRAFT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `A draft is ${DRAFT_STATUSES.join(', ')} — or "all". "${status}" is none of those.`, field: 'status' });
    }
    opts.status = status;
  }
  const inv = optionalUuid(req.query.investorId);
  if (!inv.ok) return res.status(400).json({ error: 'That is not an investor id.', field: 'investorId' });
  if (inv.value !== undefined) opts.investorId = inv.value;
  const prg = optionalUuid(req.query.programId);
  if (!prg.ok) return res.status(400).json({ error: 'That is not a program id.', field: 'programId' });
  if (prg.value !== undefined) opts.programId = prg.value;

  const drafts = await ruleDraftStore.listDrafts(db, scope, opts);
  return res.json({
    ok: true, scope, total: drafts.length, drafts,
    // Derived from `rule-builder.DIMENSIONS` and the prepayment library, never restated here — a
    // screen built from it cannot offer a dimension the builder would refuse.
    catalog: ruleAuthoring.catalog(),
    live: false,
    liveNote: DRAFT_NOT_LIVE,
  });
}

// GET /rule-drafts/:id — one draft, exactly as it was stored.
async function getRuleDraftRoute(req, res) {
  const scope = readScope(req);
  const id = draftIdOf(req.params.id);
  if (!id) return res.status(400).json({ error: 'That is not a draft id.' });
  const draft = await ruleDraftStore.getDraft(db, scope, id);
  if (!draft) return res.status(404).json({ error: 'No such draft.' });
  return res.json({ ok: true, scope, draft, live: false, liveNote: DRAFT_NOT_LIVE });
}

// GET /rule-drafts/:id/render — the draft in words, WITH its findings re-computed against the rule
// set as it stands now.
//
// The findings are never stored (see `renderDraft`): a stored warning is a statement about a rule set
// that has since moved. `publishable` here means "nothing in the current set refuses it" and NOT
// "there is a button" — there is no publish route, which the payload says rather than implies.
async function renderRuleDraftRoute(req, res) {
  const scope = readScope(req);
  const id = draftIdOf(req.params.id);
  if (!id) return res.status(400).json({ error: 'That is not a draft id.' });
  const out = await ruleDraftStore.renderDraft(db, scope, id);
  if (!out) return res.status(404).json({ error: 'No such draft.' });
  return res.json({
    ok: true, scope, ...out,
    live: false,
    liveNote: DRAFT_NOT_LIVE,
    // Said in the payload because `publishable: true` is the one field on this response somebody
    // could read as "so press publish".
    publishRoute: null,
    publishNote: 'Whether this draft would be refused by the rules already in force is what `publishable` answers. It is not an offer: publishing a pricing rule has no door on this server, because who may do it has not been decided (§2.51).',
  });
}

// POST /rule-drafts — author a rule and SAVE IT AS A DRAFT.
//
// The whole authoring vocabulary is `rule-authoring.applyIntent`'s, one entry per `rule-builder`
// operation. A refusal comes back as a REFUSAL (a list a screen can render), never as a stack trace —
// that is the service's contract and this door keeps it.
async function createRuleDraftRoute(req, res) {
  const scope = readScope(req);
  const b = req.body || {};
  const intent = b.intent;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    return res.status(400).json({
      error: 'Send an `intent` saying what to author — for example { "op": "add_llpa", ... }.',
      field: 'intent',
      // The vocabulary comes from the service, so this can never list an operation it cannot do.
      operations: ruleAuthoring.INTENT_OPS,
    });
  }
  const inv = optionalUuid(b.investorId);
  if (!inv.ok) return res.status(400).json({ error: 'That is not an investor id.', field: 'investorId' });
  const prg = optionalUuid(b.programId);
  if (!prg.ok) return res.status(400).json({ error: 'That is not a program id.', field: 'programId' });

  const out = await ruleDraftStore.saveDraft(db, scope, intent, {
    investorId: inv.value === undefined ? null : inv.value,
    programId: prg.value === undefined ? null : prg.value,
    rule: b.rule && typeof b.rule === 'object' && !Array.isArray(b.rule) ? b.rule : undefined,
    basedOnRuleId: draftIdOf(b.basedOnRuleId),
    // Passed through only when the caller SET it: `saveDraft` defaults it to the edited rule's own
    // code, and sending `undefined` as a value would defeat that default.
    ...(b.replacingCode === undefined ? {} : { replacingCode: textOrNull(b.replacingCode, 120) }),
    note: textOrNull(b.note, 500),
    createdBy: (req.actor && req.actor.id) || null,
  });

  if (!out.ok) {
    // 409 for the one refusal that is about somebody ELSE's state (a draft already open on this
    // code); 422 for the ones about what was sent. A single status for both would leave the screen
    // unable to tell "fix your rule" from "go and look at the draft that already exists".
    const taken = (out.refusals || []).some((r) => r && r.code === 'draft_exists');
    return res.status(taken ? 409 : 422).json({
      ok: false,
      error: (out.refusals && out.refusals[0] && out.refusals[0].message) || 'That rule was refused.',
      refusals: out.refusals || [],
      warnings: out.warnings || [],
    });
  }
  return res.status(201).json({
    ok: true, scope, draft: out.draft, render: out.render, warnings: out.warnings || [],
    live: false, liveNote: DRAFT_NOT_LIVE,
  });
}

// DELETE /rule-drafts/:id — discard a draft. Nothing is deleted; the row is marked discarded and
// kept, because "somebody drafted this and decided against it" is worth as much as the draft was.
async function discardRuleDraftRoute(req, res) {
  const scope = readScope(req);
  const id = draftIdOf(req.params.id);
  if (!id) return res.status(400).json({ error: 'That is not a draft id.' });
  const out = await ruleDraftStore.discardDraft(db, scope, id, { note: textOrNull(req.query.note, 500) });
  if (!out.ok) {
    return res.status(409).json({
      ok: false,
      error: (out.refusals && out.refusals[0] && out.refusals[0].message) || 'That draft could not be discarded.',
      refusals: out.refusals || [],
    });
  }
  return res.json({ ok: true, scope, draft: out.draft, live: false, liveNote: DRAFT_NOT_LIVE });
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
 * WHAT CHANGED between two versions of this sheet? — the pre-publish read.
 *
 * A new version is loaded by pasting a vendor's grid over the previous one, and the question anybody
 * asks before publishing it is which cells actually moved. `ratesheet-diff.js` answers exactly that —
 * a keyed set-difference with a per-cell delta, plus §7.4's split of ordinary numeric refreshes from
 * RULE changes — and it had nothing to hand it: nothing turned a stored sheet into the flat map it
 * consumes. `ratesheet-cells.sheetToCells` is that missing half, and this is the door.
 *
 * IT DECIDES NOTHING AND WRITES NOTHING. The §7.4 classification is reported for what it tells a
 * reader — "these are small numeric moves, these are rule changes" — and no cell is applied, published
 * or auto-accepted here. Auto-apply belongs to the ingest path, which does not exist yet; a route that
 * quietly applied a "safe" change to a live sheet would be a very different thing from a diff.
 *
 * THE DEFAULT COMPARISON IS THE PREVIOUS VERSION OF THE SAME PROGRAM, because that is the question
 * being asked; any other version in the same scope can be named explicitly. A version from another
 * tenant is a 404 like everywhere else on this router.
 */
async function rateSheetDiffRoute(req, res) {
  const found = await resolveVersion(req, res);
  if (!found) return undefined;

  let againstId = uuidOf(req.query.against);
  if (req.query.against && !againstId) {
    return res.status(400).json({ error: 'That is not a rate-sheet version id.', field: 'against' });
  }
  if (!againstId) {
    // The previous version OF THIS PROGRAM — the sheet this one replaces.
    const prev = await db.query(
      `SELECT id FROM lt_ppe_rate_sheet_version
        WHERE scope = $1 AND program_id = $2 AND version_no < $3
        ORDER BY version_no DESC LIMIT 1`,
      [found.scope, found.row.program_id, found.row.version_no],
    );
    againstId = prev.rows.length ? prev.rows[0].id : null;
    if (!againstId) {
      return res.status(200).json({
        ok: true,
        scope: found.scope,
        versionId: found.versionId,
        against: null,
        // A first version is not an empty diff — everything on it is new, and saying "no changes"
        // about a sheet nobody has seen before would be the most misleading answer available.
        note: 'This is the first version of this rate sheet, so there is nothing to compare it against. Name another version with ?against= to compare across programs.',
      });
    }
  }
  if (againstId === found.versionId) {
    return res.status(400).json({ error: 'A version cannot be compared against itself.', field: 'against' });
  }
  const againstRow = await store.rateSheetVersionInScope(db, found.scope, againstId);
  if (!againstRow) return res.status(404).json({ error: 'No such rate-sheet version to compare against.', field: 'against' });

  const [thisSheet, thatSheet] = await Promise.all([
    store.loadRateSheet(db, found.versionId),
    store.loadRateSheet(db, againstId),
  ]);
  const now = ratesheetCells.sheetToCells(thisSheet || {});
  const before = ratesheetCells.sheetToCells(thatSheet || {});

  const diff = ratesheetDiff.diffRulesets(before.cells, now.cells);
  const classified = ratesheetDiff.classifyDiff(diff, {
    maxDeltaMilli: intIn(req.query.maxDeltaMilli, 100000),
    maxCellsChanged: intIn(req.query.maxCellsChanged, 100000),
  });

  return res.json({
    ok: true,
    scope: found.scope,
    versionId: found.versionId,
    version: { id: found.versionId, versionNo: found.row.version_no, status: found.row.status },
    against: { id: againstId, versionNo: againstRow.version_no, status: againstRow.status },
    counts: { now: now.counts, before: before.counts },
    changed: diff.changed,
    added: diff.added,
    removed: diff.removed,
    unchanged: diff.unchanged,
    // §7.4's own split, reported for what it TELLS a reader. Nothing here applies anything.
    ordinary: classified.autoApply,
    needsReading: classified.review,
    bulkEscalated: classified.bulkEscalated,
    // Two rows addressing one cell is a loading mistake that would otherwise be invisible in every
    // diff from here on, because the map can only hold one of them.
    duplicates: { now: now.duplicates, before: before.duplicates },
    note: 'This is a comparison, not an action: no cell is applied, published or accepted here. "Needs reading" is the §7.4 split — a rule change or a large move — not a refusal.',
  });
}

/**
 * WHAT ON THIS SHEET CAN NOTHING EVER REACH? — the offline dead-cell guard.
 *
 * A rate sheet is loaded by a human from a vendor's PDF or spreadsheet, cell by cell, and a cell
 * nobody can hit is invisible in every other way: the sheet publishes, quotes price, and the LLPA
 * simply never applies. `agreement-scenario-generator` already answers this — it DERIVES a battery
 * from the sheet's own compiled rules, synthesizes a facts bag per rule and then PROVES the synthesis
 * by running the real `rules.js` evaluator, reporting the ones it could not satisfy WITH a reason.
 * Nothing called it.
 *
 * TWO THINGS MAKE THIS WORTH A ROUTE RATHER THAN A SCRIPT. It is the check to run BEFORE the paid
 * agreement battery — measuring a sheet against Lender Price is expensive, and a sheet with a
 * contradictory cell (`fico_min 900, fico_max 800` — a transposed pair) should be fixed first. And it
 * costs NOTHING: no vendor call, no writes, no ledger row, so it can be run on every save.
 *
 * IT DOES NOT TRUST THE GENERATOR'S OWN VERDICT. "Reachable" here means the sheet was actually
 * PRICED at that scenario and the rule's own trace entry shows it CONTRIBUTED — an adjustment, a
 * decline, or a bound. A rule the generator says is satisfiable and the engine then does not match is
 * reported as its own disagreement rather than quietly counted as covered: the generator and the
 * pricer reading one predicate differently is exactly the kind of thing this is for.
 */
const MAX_COVERAGE_SCENARIOS = 400;

async function rateSheetCoverageRoute(req, res) {
  const found = await resolveVersion(req, res);
  if (!found) return undefined;

  const { program, reason: noProgram } = await loadProgram(found.scope, found.versionId);
  if (!program) {
    return res.status(422).json({
      error: 'This rate sheet cannot be priced yet, so there are no cells to check.',
      reason: noProgram,
    });
  }
  if (!Array.isArray(program.rules) || !program.rules.length) {
    return res.json({
      ok: true, scope: found.scope, versionId: found.versionId,
      rules: { total: 0, reachable: 0, unreachable: [], disagreed: [] },
      scenarios: { generated: 0, priced: 0, eligible: 0, ineligible: 0, errors: [], errorCount: 0 },
      truncated: 0,
      // A grid with no LLPAs and no ineligibility rows is a legitimate sheet, not an empty result.
      note: 'This sheet carries a base grid and no adjustment or ineligibility rules, so there is nothing whose reachability could be in question.',
    });
  }

  const { values: settings } = await resolveSettingsSafe(found.scope);
  const built = agreementScenarioGenerator.buildProgramAgreementScenarios({
    program,
    opts: { maxScenarios: MAX_COVERAGE_SCENARIOS },
  });
  const scenarios = Array.isArray(built && built.scenarios) ? built.scenarios : [];

  // Price every generated scenario. A scenario our OWN engine cannot price is a sheet defect in its
  // own right (the `nearest_eighth` rounding-mode trap was exactly this shape), so the failures are
  // reported rather than swallowed — bounded, with the full count beside the sample.
  const quotes = new Array(scenarios.length);
  const errors = [];
  let eligible = 0; let ineligible = 0; let priced = 0;
  for (let i = 0; i < scenarios.length; i += 1) {
    try {
      const q = quote.quoteProgram({ scenario: scenarios[i], program, settings });
      quotes[i] = q;
      priced += 1;
      if (q.eligible) eligible += 1; else ineligible += 1;
    } catch (e) {
      quotes[i] = null;
      errors.push({ scenario: scenarios[i]._label || `#${i}`, error: msgOf(e) });
    }
  }

  const unreachable = [];
  const disagreed = [];
  let reachable = 0;
  for (const r of (built.coverage && built.coverage.rules) || []) {
    if (!r.targeted || r.scenarioIndex == null) {
      unreachable.push({ code: r.code, kind: r.kind, dimension: r.dimension, reason: r.reason || 'no_scenario_targets_it' });
      continue;
    }
    const q = quotes[r.scenarioIndex];
    if (!q) {
      disagreed.push({ code: r.code, kind: r.kind, reason: 'its scenario could not be priced' });
      continue;
    }
    const t = (q.trace || []).find((x) => x.code === r.code);
    if (t && t.matched && t.contribution) { reachable += 1; continue; }
    disagreed.push({
      code: r.code,
      kind: r.kind,
      // Stated as a disagreement between two readings of one predicate, never as "unreachable" — the
      // fix is different, and so is who has to look at it.
      reason: t ? 'the generator satisfied this rule but the pricer did not apply it' : 'the rule is not in the priced trace at all',
    });
  }

  return res.json({
    ok: true,
    scope: found.scope,
    versionId: found.versionId,
    status: found.row.status,
    rules: { total: (built.coverage && built.coverage.total) || 0, reachable, unreachable, disagreed },
    scenarios: {
      generated: scenarios.length,
      priced,
      eligible,
      ineligible,
      errorCount: errors.length,
      errors: errors.slice(0, 20),
    },
    // No silent caps, here as everywhere: a truncated battery covers fewer cells than the sheet has.
    truncated: built.meta && built.meta.truncated ? true : false,
    budget: MAX_COVERAGE_SCENARIOS,
    note: unreachable.length
      ? 'Each unreachable cell is a cell no loan can ever land in — usually a transposed band (a minimum above its maximum) or a rule another rule already excludes.'
      : 'Every encoded cell on this sheet was reached by a generated scenario and applied by the pricer.',
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

  const { program, lpScope, investorName, reason: noProgram } = await loadProgram(found.scope, found.versionId);
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
  // Which investor's prepayment layer applies, resolved ONCE and reported either way. A run that
  // silently did not ask is the failure this whole workstream keeps finding, so the response says
  // whether the layer was asked and, when it was not, why — a green gate must never be able to hide
  // "we did not look".
  const pppDesc = investorName ? programRegistry.programFor(investorName) : null;
  const pppLayer = pppDesc
    ? { asked: true, investor: investorName }
    : {
      asked: false,
      investor: investorName || null,
      reason: investorName ? 'no_registered_program' : 'investor_unknown',
      note: investorName
        ? `No investor program is registered for “${investorName}”, so its prepayment-penalty rules were not part of this measurement.`
        : 'This sheet\'s investor could not be read, so no prepayment-penalty rules were part of this measurement.',
    };

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
        // THE PREPAYMENT LAYER IS ASKED, and leaving it out is what made this gate structurally blind.
        // The harness prices a SHEET; a state's prepayment-penalty law lives in the INVESTOR's own
        // Layer 3 (`deephaven-ppp-matrix`), and the sheet carries no borrower-type rule at all — so
        // without the descriptor the battery's own scenario flagged INELIGIBLE for "NJ Individual PPP
        // prohibited" comes back PRICED and the run reports agreement on a loan the investor will not
        // buy. The capability landed with the leg; this is the caller it never had.
        //
        // OPT-IN BY CONSTRUCTION: `programFor` answers null for an investor with no registered program,
        // and the leg with no descriptor is byte-for-byte what it was — so this can only ever ADD the
        // layer where one exists, never change an investor nobody has encoded.
        //
        // AND THE POLICY FOR AN UNANSWERABLE STATE IS DECLARED, because the leg refuses to guess one
        // (defect A8.1, 2026-08-18). `'flag'` is right for THIS caller specifically: the agreement run
        // MEASURES our engine against Lender Price, and declining a scenario here would change what is
        // being measured — the scenario would report as ineligible on our side and the divergence
        // report would blame the sheet for a question about state law. Flagged, the scenario is still
        // priced, still compared, and the "we could not tell" rides on the quote where a report can
        // see it. WHAT THE QUOTING PATH SHOULD DO — refuse, or quote and flag for a human — is the OPEN
        // OWNER QUESTION (docs/longterm/LENDER-PRICE-PARITY-STATUS.md §2.54) and is NOT settled by this
        // line; a measurement harness choosing to keep measuring is not an answer to it.
        ours: lpAgreementLegs.buildOursLeg(program, settings, { factsFromLp: true, pppDescriptor: pppDesc, onUnresolvedPpp: 'flag' }),
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
    // WHETHER THE PREPAYMENT LAYER WAS ASKED, on every answer including the failed ones. A gate that
    // reports agreement while a whole layer of the investor's own rules went unasked is exactly the
    // silent-green failure this engine keeps producing, and a caller cannot tell from a verdict alone.
    pppLayer,
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
router.get('/canary/driver', requirePpeAdmin, wrap(canaryDriverRoute, 'lt_ppe_canary_driver_error'));
router.get('/rules/coverage', requirePpeAdmin, wrap(ruleCoverageRoute, 'lt_ppe_rule_coverage_error'));
router.post('/suggestions/:id/accept', requirePpeAdmin, wrap(acceptSuggestionRoute, 'lt_ppe_accept_error'));
router.post('/suggestions/:id/dismiss', requirePpeAdmin, wrap(dismissSuggestionRoute, 'lt_ppe_dismiss_error'));
router.post('/suggestions/mine', requirePpeAdmin, wrap(mineSuggestionsRoute, 'lt_ppe_mine_error'));
router.get('/programs/:id/lp-scope', requirePpeAdmin, wrap(getProgramLpScopeRoute, 'lt_ppe_lp_scope_read_error'));

// The rule-authoring service's READ + DRAFT doors. There is NO publish door here, on purpose —
// `publishDraft` changes a priced number and the authority for that is an open owner question
// (§2.51). Order matters: `/rule-drafts/:id/render` is declared before `/rule-drafts/:id` would
// swallow it — Express matches in declaration order and both are three-and-four segment paths, so
// they are written longest-first to keep that obvious rather than accidental.
router.get('/rule-drafts', requirePpeAdmin, wrap(listRuleDraftsRoute, 'lt_ppe_rule_drafts_error'));
router.post('/rule-drafts', requirePpeAdmin, wrap(createRuleDraftRoute, 'lt_ppe_rule_draft_save_error'));
router.get('/rule-drafts/:id/render', requirePpeAdmin, wrap(renderRuleDraftRoute, 'lt_ppe_rule_draft_render_error'));
router.get('/rule-drafts/:id', requirePpeAdmin, wrap(getRuleDraftRoute, 'lt_ppe_rule_draft_read_error'));
router.delete('/rule-drafts/:id', requirePpeAdmin, wrap(discardRuleDraftRoute, 'lt_ppe_rule_draft_discard_error'));
router.post('/programs/:id/lp-scope', requirePpeAdmin, wrap(setProgramLpScopeRoute, 'lt_ppe_lp_scope_write_error'));

// Onboarding + the rate-sheet console. ALL admin-gated: these writers decide what every quote on this
// program prices from. Rule 3 above, stated with the qualifier that makes it true: there is deliberately
// no route that records an agreement run FROM A REQUEST BODY. `POST /rate-sheets/:id/agreement/run`
// DOES record one — the verdict of a battery it priced itself against Lender Price, which is the only
// honest way through the publish gate. This line used to state the rule WITHOUT that qualifier, four
// lines above the very registration that contradicts it.
router.post('/investors', requirePpeAdmin, wrap(createInvestorRoute, 'lt_ppe_investor_create_error'));
router.post('/programs', requirePpeAdmin, wrap(createProgramRoute, 'lt_ppe_program_create_error'));
router.post('/programs/:id/rate-sheets', requirePpeAdmin, wrap(createRateSheetRoute, 'lt_ppe_ratesheet_create_error'));
router.get('/rate-sheets/:id', requirePpeAdmin, wrap(getRateSheetRoute, 'lt_ppe_ratesheet_read_error'));
router.put('/rate-sheets/:id/base-prices', requirePpeAdmin, wrap(setBasePricesRoute, 'lt_ppe_base_prices_error'));
router.put('/rate-sheets/:id/adjustments', requirePpeAdmin, wrap(setAdjustmentsRoute, 'lt_ppe_adjustments_error'));
router.put('/rate-sheets/:id/price-limit', requirePpeAdmin, wrap(setPriceLimitRoute, 'lt_ppe_price_limit_error'));
router.get('/rate-sheets/:id/coverage', requirePpeAdmin, wrap(rateSheetCoverageRoute, 'lt_ppe_ratesheet_coverage_error'));
router.get('/rate-sheets/:id/diff', requirePpeAdmin, wrap(rateSheetDiffRoute, 'lt_ppe_ratesheet_diff_error'));
router.get('/rate-sheets/:id/agreement', requirePpeAdmin, wrap(agreementRoute, 'lt_ppe_agreement_read_error'));
router.post('/rate-sheets/:id/agreement/run', requirePpeAdmin, wrap(runAgreementRoute, 'lt_ppe_agreement_run_error'));
router.post('/rate-sheets/:id/publish', requirePpeAdmin, wrap(publishRateSheetRoute, 'lt_ppe_publish_error'));

module.exports = router;
// The tick, as a function — the in-process driver's ONE way in. Exported here (and not moved into
// `src/longterm/ppe/`) because everything the tick composes — the program load, the tolerances, the
// battery refusals, the three persists — already lives in this file behind `runBattery`, and moving it
// would be a second copy of that wiring for the driver to drift from.
module.exports.runCanaryTick = runCanaryTick;
module.exports.handlers = {
  health, getSettings, listInvestorsRoute, listFindingsRoute, decideFindingRoute, quoteRoute, breakdownRoute, canaryRoute, scoreboardRoute,
  listSuggestionsRoute, acceptSuggestionRoute, dismissSuggestionRoute, listRulesRoute, mineSuggestionsRoute,
  ruleCoverageRoute, getProgramLpScopeRoute, setProgramLpScopeRoute, parityCellsRoute, listProgramsRoute,
  listRuleDraftsRoute, getRuleDraftRoute, renderRuleDraftRoute, createRuleDraftRoute, discardRuleDraftRoute,
  listSchedulesRoute, saveScheduleRoute, deleteScheduleRoute, canaryTickRoute, canaryDriverRoute,
  createInvestorRoute, createProgramRoute, createRateSheetRoute, getRateSheetRoute,
  setBasePricesRoute, setAdjustmentsRoute, setPriceLimitRoute, rateSheetCoverageRoute, rateSheetDiffRoute, agreementRoute, runAgreementRoute,
  publishRateSheetRoute,
};
module.exports._internals = {
  requirePpeAdmin, intIn, readScope, loadProgram, resolveSettingsSafe,
  MAX_CANARY_SCENARIOS, SCOPE, DECIDABLE, NOT_DECIDABLE, K, programLabel, resolveBattery, runBattery, msgOf,
  resolveVersion, numOrNull, textOrNull, MAX_SHEET_ROWS, MAX_AGREEMENT_SCENARIOS, MAX_COVERAGE_SCENARIOS,
  DRAFT_STATUSES, DRAFT_NOT_LIVE, draftIdOf, optionalUuid,
};

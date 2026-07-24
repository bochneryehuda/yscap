'use strict';
/**
 * R6.14 — Whole-loan underwriting RUN orchestrator.
 *
 * ONE run ties every desk together into a single immutable, reproducible
 * decision: it builds the canonical whole-loan context (R6.3), reads the frozen
 * program verdict (R6.5), independently recomputes the structure ledger (R6.6),
 * gathers findings from every desk into one deduped registry (R6.9), and resolves
 * the final status + term-sheet/CTC/funding gates (decision.js). It then freezes
 * the whole thing to the immutable underwriting-run tables (db/266) so funding can
 * be blocked when the run that approved it is stale.
 *
 * HARD RULE: a run NEVER mutates a pricing or document value. It reads, verifies,
 * records, and decides. The frozen engine stays the authority for every number.
 *
 * Two layers so the composition logic is testable without a DB:
 *   • assembleRun(inputs)     PURE — compose context + program + structure +
 *                             findings into the run record + final decision.
 *   • runWholeLoan(id, db)    load the context, adapt the program, compute the
 *                             ledger, call assembleRun, and persist immutably.
 */

const crypto = require('crypto');
const wholeLoanContext = require('./whole-loan-context');
const programAdapter = require('./program-adapter');
const structureUnderwriter = require('./structure-underwriter');
const assignmentAnalysis = require('./assignment-analysis');
const investorGuidelineReview = require('./investor-guideline-review');
const decision = require('./decision');
const runManifest = require('./run-manifest');

// The context fields that are PRICING inputs — a registration↔application
// disagreement on any of these means the file drifted off the priced structure
// (STALE), not merely a data conflict. Keyed to whole-loan-context CONTEXT_FIELDS
// (snake_case), so it composes with the context's own discrepancy detection —
// which already compares the registration's stored inputs against the current
// application values correctly (regardless of the engine snapshot's key casing).
const PRICED_CONTEXT_FIELDS = Object.freeze(new Set([
  'loan_amount', 'purchase_price', 'effective_purchase_price', 'as_is_value', 'arv',
  'rehab_budget', 'program', 'loan_type', 'property_type', 'units', 'is_assignment',
  'assignment_fee', 'underlying_contract_price', 'fico',
]));

// Structure-breach severity → finding shape. A hard ineligibility is fatal and
// blocks everything; a manual-review / approvable-exception breach blocks
// issuance (needs approval) but is a warning, not fatal.
const BREACH_FINDING = {
  hard_ineligible: { severity: 'fatal', blocks_term_sheet: true, blocks_ctc: true, blocks_funding: true },
  manual_review: { severity: 'warning', blocks_term_sheet: true, blocks_ctc: false, blocks_funding: false },
  approvable_exception: { severity: 'warning', blocks_term_sheet: true, blocks_ctc: false, blocks_funding: false },
};

// Map the registered quote's caps to the structure underwriter's cap shape.
// Fix 2026-07-23 (#209): real persisted quotes (pricing.quoteProgram) carry the
// caps at quote.guidelines.caps — a top-level quote.caps only exists in test
// fixtures. Reading only quote.caps left every cap null, every ledger row
// 'incomplete', and NO structure breach could ever fire.
function capsFromQuote(quote) {
  const c = (quote && (quote.caps || (quote.guidelines && quote.guidelines.caps))) || {};
  const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    maxAcquisitionLtv: n(c.maxAcqLtv),
    maxAsIsLtv: n(c.maxAsIsLtv),
    maxLtc: n(c.maxLtc),
    maxArvLtv: n(c.maxArvLtv),
    // Non-waivable policy: FICO/max-loan gates are hard, leverage caps are
    // manual-review by default (matches classifyBreach's default).
    capPolicy: {},
  };
}

// The structure inputs for the ledger come from the GOVERNING context values +
// the program's sized structure — never re-derived.
function structureFromContext(ctx, programDecision) {
  const v = (ctx && ctx.values) || {};
  const sz = (programDecision && programDecision.sizing) || {};
  const num = (x) => (x === '' || x == null || !Number.isFinite(Number(x)) ? null : Number(x));
  const recognized = num(v.effective_purchase_price) != null ? num(v.effective_purchase_price) : num(v.purchase_price);
  return {
    totalLoan: num(sz.totalLoan) != null ? num(sz.totalLoan) : num(v.loan_amount),
    initialAdvance: num(sz.initialAdvance),
    rehabHoldback: num(sz.rehabHoldback),
    recognizedPurchasePrice: recognized,
    asIsValue: num(v.as_is_value),
    arv: num(v.arv),
    rehabBudget: num(v.rehab_budget),
    // Fix 2026-07-23 (#209): the frozen engine's cost basis includes the
    // financed reserve (reserve-in-cost). Without it the ledger re-derived
    // LTC = loan/(purchase+rehab) and a correctly-sized reserve-financed loan
    // at exactly the cap would false-breach. computeRatios honors costBasis.
    costBasis: num(sz.costBasis),
  };
}

/**
 * assembleRun(inputs) → the composed run record (PURE).
 *   inputs: {
 *     context,          // R6.3 whole-loan context
 *     registration,     // raw current registration row (or null)
 *     programDecision,  // R6.5 adapted program decision (or null)
 *     staleChanged,     // [{key,from,to}] priced-input drift (stale-detector)
 *     manualApproved,   // is a MANUAL exception recorded as approved?
 *     extraFindings,    // findings from other desks (appraisal/document/system/liquidity)
 *     trigger,          // the event that spawned this run
 *   }
 * Returns { status, termSheetEligible, ctcEligible, fundingEligible, calculations,
 *   findings, decision, sourceVersions, sourceHash }.
 */
function assembleRun(inputs) {
  const i = inputs || {};
  const ctx = i.context || {};
  const reg = i.registration || null;
  const pd = i.programDecision || null;

  // --- independent structure ledger (R6.6) ---
  const structure = structureFromContext(ctx, pd);
  const caps = capsFromQuote(reg && reg.quote);
  const calculations = structureUnderwriter.ledger(structure, caps);

  // --- gather findings from every desk into one list (R6.9 consolidates) ---
  const findings = [];

  // Structure cap breaches.
  for (const row of calculations) {
    const map = BREACH_FINDING[row.severity];
    if (!map) continue; // pass / incomplete → no finding
    findings.push({
      code: `structure_${row.metric}_over_cap`,
      subject: row.metric,
      severity: map.severity,
      category: 'structure',
      title: `${row.metric.replace(/_/g, ' ')} over program cap`,
      explanation: `${row.formula} = ${row.result}, cap ${row.cap} (${row.severity}).`,
      source: 'structure',
      governing_rule: `${row.metric} ≤ ${row.cap}`,
      expected_value: row.cap,
      actual_value: row.result,
      blocks_term_sheet: map.blocks_term_sheet,
      blocks_ctc: map.blocks_ctc,
      blocks_funding: map.blocks_funding,
    });
  }

  // The frozen engine's MANUAL / INELIGIBLE reasons become findings so they
  // appear in the one registry (the decision also gates on engineStatus). A
  // MANUAL reason ALWAYS blocks issuing a term sheet — a manual-review scenario
  // must go to a super-admin for review before any term sheet can issue
  // (owner-directed 2026-07-22).
  if (pd) {
    for (const msg of (pd.manualReasons || [])) {
      findings.push({ code: 'program_manual_reason', subject: msg, severity: 'warning', category: 'program', title: 'Program manual-review reason', explanation: msg, source: 'pricing_engine', blocks_term_sheet: true });
    }
    for (const msg of (pd.blockingReasons || [])) {
      findings.push({ code: 'program_ineligible_reason', subject: msg, severity: 'fatal', category: 'program', title: 'Program ineligible reason', explanation: msg, source: 'pricing_engine', blocks_term_sheet: true, blocks_ctc: true, blocks_funding: true });
    }
  }

  // Priced-input drift (stale) becomes a finding too (belt-and-suspenders with
  // the STALE status).
  for (const ch of (i.staleChanged || [])) {
    findings.push({
      code: 'registration_input_drift', subject: ch.key, severity: 'warning', category: 'staleness',
      title: `${ch.key} changed since pricing`, explanation: `${ch.key}: ${ch.from} → ${ch.to}`,
      source: 'application', governing_rule: 'registration inputs must match current file', blocks_term_sheet: true,
    });
  }

  // #196 — independent ASSIGNMENT-fee re-derivation. On an assignment purchase,
  // re-derive the financeable fee / recognized price the SAME way the frozen
  // engine does (15% of the seller's original price; Gold's $75k ceiling) and
  // flag a basis mismatch vs the registered figure. ADVISORY: it verifies the
  // frozen math and surfaces a discrepancy for a human — it never changes a number
  // and never blocks (the engine already applied the cap; the excess-to-close is a
  // note, and a registered-fee mismatch is a data-integrity warning, not a gate).
  if (ctx.values && ctx.values.is_assignment) {
    const regAsg = (reg && reg.quote && reg.quote.assignment) || null;
    const av = assignmentAnalysis.analyze({
      sellerPrice: ctx.values.underlying_contract_price,
      actualFee: ctx.values.assignment_fee,
      program: ctx.values.program,
      registeredFinanceableFee: regAsg ? regAsg.financeableFee : undefined,
    });
    for (const f of (av.findings || [])) {
      findings.push({
        code: f.code, subject: 'assignment_fee', severity: f.severity, category: 'assignment',
        title: f.title, explanation: f.explanation, source: 'assignment_analysis',
        governing_rule: '15% of the seller’s original contract price (Gold: lesser of $75,000 or 15%)',
        expected_value: av.financeableFee != null ? `$${Number(av.financeableFee).toLocaleString('en-US')}` : null,
        blocks_term_sheet: false, blocks_ctc: false, blocks_funding: false,
      });
    }
  }

  // Findings from the other desks (appraisal R6.8 / document R6.9 / system R6.10-12 / liquidity).
  for (const f of (i.extraFindings || [])) findings.push(f);

  // INVESTOR-SPECIFIC GUIDELINE REVIEW — folded INTO this ONE run (owner-directed 2026-07-24):
  // the note-buyer guideline checks run AS PART OF the whole-loan document-review run, not a
  // separate AI pass. Deterministic rules read the data the run already gathered (canonical
  // values here, plus appraisal / credit / experience signals the caller passes via
  // `i.investorInputs`). The findings land in the SAME registry, categorized
  // `investor_guideline`, so everything talks together — one place, one cost. It NEVER
  // fabricates (a missing signal → no finding) and is advisory (a fatal is a super-admin-
  // overridable HARD WARNING via the run's issuance backstop, never a hard block).
  const v = ctx.values || {};
  const investorBag = Object.assign({
    note_buyer: v.note_buyer,
    property_state: v.property_state,
    is_assignment: v.is_assignment,
    loan_amount: v.loan_amount,
    rehab_budget: v.rehab_budget,
    as_is_value: v.as_is_value,
    arv: v.arv,
    purchase_price: v.purchase_price,
    fico_file: v.fico,
  }, i.investorInputs || {});
  for (const f of investorGuidelineReview.review(investorBag)) findings.push(f);

  // #214 — per-run REVIEW MANIFEST (orchestration proof). Record which required
  // components contributed; if any is missing, the run raises an ORDINARY ADVISORY
  // (never a super-admin gate, never a block — never-block rule #217). The advisory
  // flows into the same deduped registry so the human sees the run was incomplete.
  const manifestSignals = runManifest.signalsFromRun(i, calculations);
  const manifest = runManifest.buildManifest(manifestSignals);
  for (const f of runManifest.manifestFindings(manifest)) findings.push(f);

  // --- final decision (decision.js composes uw-status + finding registry) ---
  const staleChanged = i.staleChanged || [];
  const d = decision.decide({
    engineStatus: pd ? pd.engineStatus : null,
    manualApproved: !!i.manualApproved,
    missingRequired: !ctx.ready,
    staleRegistration: (reg && !!reg.stale) || staleChanged.length > 0,
    discrepancies: ctx.discrepancies || [],
    findings,
    staleRun: false, // a fresh run is never stale
  });

  const sourceVersions = buildSourceVersions(ctx, reg, i.trigger);
  const sourceHash = hashSourceVersions(sourceVersions, ctx.sourceHash);

  return {
    status: d.status,
    termSheetEligible: d.termSheetEligible,
    ctcEligible: d.ctcEligible,
    fundingEligible: d.fundingEligible,
    calculations,
    findings: d.registry,           // the DEDUPED registry
    blockingFindings: d.blockingFindings,
    decision: d,
    programKey: reg ? (reg.program || null) : (pd ? pd.program : null),
    sourceVersions,
    sourceHash,
    reasons: d.reasons,
    manifest,
  };
}

// The frozen source-version bundle — proves which state of the world was run.
function buildSourceVersions(ctx, reg, trigger) {
  return {
    trigger: trigger || 'manual_run',
    applicationId: ctx.applicationId || null,
    contextHash: ctx.sourceHash || null,
    registrationId: reg ? reg.id : null,
    registrationCreatedAt: reg && reg.created_at ? String(reg.created_at) : null,
    registrationStale: reg ? !!reg.stale : null,
    ready: !!ctx.ready,
    discrepancyFields: (ctx.discrepancies || []).map((d) => d.field).sort(),
  };
}

function hashSourceVersions(sv, contextHash) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ sv, contextHash: contextHash || null }))
    .digest('hex');
}

/**
 * runWholeLoan(applicationId, db, opts?) → { runId, ...assembled } | null.
 * Builds the context, adapts the program, computes priced-input drift, composes
 * the run, and PERSISTS it immutably (superseding the prior current run). All
 * reads; the only writes are to the immutable underwriting-run tables.
 */
async function runWholeLoan(applicationId, db, opts) {
  if (!applicationId) return null;
  const o = opts || {};

  const context = await wholeLoanContext.buildWholeLoanContext(applicationId, db, { liquidity: o.liquidity });
  if (!context) return null;

  // Load the raw current registration (the context only carries a summary).
  const r = await db.query(
    `SELECT id, program, product_label, status, note_rate, total_loan, target_ltc,
            inputs, quote, is_manual, stale, stale_reason, created_at
       FROM product_registrations
      WHERE application_id = $1 AND is_current = true
      ORDER BY created_at DESC LIMIT 1`, [applicationId]);
  const registration = r.rows[0] || null;

  const programDecision = registration
    ? programAdapter.fromRegistration(registration, { manualApproved: o.manualApproved, missingRequired: !context.ready })
    : null;

  // Priced-input drift: the whole-loan context already resolves each field with
  // a source-priority discrepancy when the REGISTRATION's priced value disagrees
  // with the current APPLICATION value. A disagreement on a PRICING input means
  // the structure was priced on since-changed inputs (STALE). Derive the drift
  // from those discrepancies — this reuses the context's correct, casing-agnostic
  // comparison instead of re-comparing the engine's camelCase input snapshot.
  const staleChanged = registration ? pricedDrift(context) : [];

  // #193 — wire independent VERIFICATION into the decision loop. A material AVM-
  // vs-appraisal disagreement (and, later, other independent sources) becomes a
  // NON-blocking finding in the one run registry so the underwriter sees it on the
  // decision record — advisory, a human decides. Best-effort: never breaks or
  // blocks a run; zero impact on files with no AVM observations.
  let verificationFindings = [];
  let verificationAttested = false;
  try {
    verificationFindings = await require('./verification-findings').gatherVerificationFindings(applicationId, db);
    verificationAttested = true; // the sweep RAN (zero findings ≠ didn't run)
  } catch (_) { verificationFindings = []; verificationAttested = false; }

  // #232 — feed the note-buyer review the signals the canonical context can't hold,
  // read straight from the file's own data. NEVER fabricates (a signal it can't prove
  // is omitted → its rule stays silent); never throws. An explicit caller value wins.
  const gathered = await gatherInvestorInputs(applicationId, db);

  const assembled = assembleRun({
    context,
    registration,
    programDecision,
    staleChanged,
    manualApproved: o.manualApproved,
    extraFindings: [...(o.extraFindings || []), ...verificationFindings],
    // Investor-guideline signals the note-buyer review can't read from the canonical context
    // (imported credit FICO, appraisal transferred/rural/comps, verified vs claimed experience,
    // flood zone). Gathered from the file's data (gatherInvestorInputs), overridden by anything
    // the caller/desks pass explicitly; anything still absent stays null → silent.
    investorInputs: Object.assign({}, gathered, o.investorInputs || {}),
    verificationAttested,
    trigger: o.trigger || 'manual_run',
  });

  if (o.persist === false) return { runId: null, context, ...assembled };

  // Dedup (opt-in via skipIfUnchanged): if a CURRENT (non-superseded) run already
  // captured this exact source hash, nothing underwriting-relevant changed since
  // it ran → return that run instead of churning a fresh immutable row. This lets
  // the auto-trigger fire on every file view / issuance check cheaply (it still
  // builds the context to compute the hash, but only WRITES a new run when a real
  // input moved). On any lookup error it falls through to a normal persist.
  if (o.skipIfUnchanged && assembled.sourceHash) {
    try {
      const prev = await db.query(
        `SELECT id FROM underwriting_runs
          WHERE application_id = $1 AND superseded_at IS NULL AND source_hash = $2
          ORDER BY created_at DESC LIMIT 1`, [applicationId, assembled.sourceHash]);
      if (prev.rows[0]) return { runId: prev.rows[0].id, context, unchanged: true, ...assembled };
    } catch (_) { /* fall through to a normal persist */ }
  }

  const runId = await persistRun(db, applicationId, context, assembled, o.createdBy || null);
  // #200 — feed the calibration loop: record this run's would-be decision as the
  // open CANDIDATE shadow for the file. Best-effort — a calibration write must
  // never break a run (the reliability report is advisory / observe-only).
  try {
    await require('./shadow-capture').recordRunShadow(db, { applicationId, run: { ...assembled, runId } });
  } catch (_) { /* additive, never blocks */ }
  return { runId, context, ...assembled };
}

/**
 * maybeRunWholeLoan(applicationId, db, trigger) — the ADVISORY auto-trigger.
 *
 * The single guarded entry point every live surface uses to keep a file's
 * whole-loan run fresh (file view, issuance check, material event). It is
 * deduped (skipIfUnchanged → no new row when nothing material moved), fully
 * best-effort (NEVER throws — a failed run must never break a page load or a
 * status change), and kill-switchable without a deploy (WHOLE_LOAN_RUN_DISABLED=1).
 *
 * Returns the run result (fresh or the unchanged current run), or null when the
 * trigger is disabled / the file has no context / anything errored. Because the
 * run only READS + records to the immutable run tables and every gate built on it
 * is advisory + super-admin-overridable + fails OPEN, calling this can never block
 * or mutate anything the frozen engine owns.
 */
async function maybeRunWholeLoan(applicationId, db, trigger) {
  if (!applicationId) return null;
  if (process.env.WHOLE_LOAN_RUN_DISABLED === '1') return null;
  try {
    return await runWholeLoan(applicationId, db, { trigger: trigger || 'auto', skipIfUnchanged: true });
  } catch (_) { return null; }
}

/**
 * gatherInvestorInputs(applicationId, db) — #232, the per-condition data-source wiring.
 *
 * The investor-guideline review (`investor-guideline-review.js`) reads signals the
 * canonical whole-loan context can't hold. This reads them straight from the file's
 * own data and returns a flat bag `assembleRun` merges into `investorInputs`.
 *
 * DISCIPLINE: NEVER fabricate — a signal it can't PROVE is simply omitted, so its
 * rule stays silent (its `when` returns null on a missing field). Every read is its
 * own try/catch and the whole thing NEVER throws (a failed read just omits that one
 * signal). Each key here lights up a specific rule; the rest are the go-forward:
 *   • fico_credit        → isg_fico_mismatch (priced FICO must equal the credit report)
 *   • appraisal_present  → gates isg_price_value_over_requirement (purchase vs as-is,
 *                          only once the appraisal is in)
 * Go-forward (need their own careful, never-false-fire wiring): appraisal
 * transferred/rural/comps/mid-construction, claimed-vs-verified experience,
 * has_stale_exit, in_flood_zone, ground-up/cash-out/conversion.
 */
async function gatherInvestorInputs(applicationId, db) {
  const out = {};
  if (!applicationId || !db || typeof db.query !== 'function') return out;

  // Imported credit-report FICO — the LATEST completed pull that actually carries a
  // middle score. A file with no credit report → no fico_credit → the mismatch rule
  // stays silent (never invents a score, never false-flags).
  try {
    const c = await db.query(
      `SELECT middle_score FROM credit_reports
        WHERE application_id = $1 AND status = 'completed' AND middle_score IS NOT NULL
        ORDER BY pulled_at DESC LIMIT 1`, [applicationId]);
    if (c.rows[0] && c.rows[0].middle_score != null) out.fico_credit = Number(c.rows[0].middle_score);
  } catch (_) { /* no credit_reports table / query error → omit fico_credit */ }

  // Is a current appraisal on file? Only TRUE unblocks the price-vs-value rule (which
  // then compares the already-in-context purchase_price vs as_is_value). Absent → the
  // rule stays silent (the review must never judge value before the appraisal is in).
  try {
    const a = await db.query(
      `SELECT 1 FROM appraisals WHERE application_id = $1 AND superseded = false LIMIT 1`, [applicationId]);
    if (a.rows[0]) out.appraisal_present = true;
  } catch (_) { /* appraisals table optional in some envs → omit */ }

  // Flood zone — from the CURRENT appraisal's FEMA cross-check / stated zone. The
  // isg_flood_zone_needs_insurance rule is FATAL and fires ONLY on in_flood_zone === true,
  // so the discipline here is absolute: set true ONLY when the file PROVES a Special Flood
  // Hazard Area. This mirrors PILOT's own already-blessed flood definition (db/207): the
  // FEMA SFHA flag, a FEMA zone A*/V*, or the appraiser's stated zone A*/V*. A concrete
  // not-in-SFHA determination (checked-and-false, or a stated non-A/V zone like "X") → false
  // (harmless — the rule stays silent). No appraisal / not-yet-checked (all NULL) → OMITTED,
  // never guessed either way, so the FATAL rule can't false-fire on an unknown.
  try {
    const f = await db.query(
      `SELECT fema_flood_sfha, fema_flood_zone, flood_zone
         FROM appraisals WHERE application_id = $1 AND superseded = false
         ORDER BY imported_at DESC LIMIT 1`, [applicationId]);
    const r = f.rows[0];
    if (r) {
      const inZone = (z) => /^[AV]/.test(String(z == null ? '' : z).trim().toUpperCase());
      const stated = (z) => String(z == null ? '' : z).trim() !== '';
      if (r.fema_flood_sfha === true || inZone(r.fema_flood_zone) || inZone(r.flood_zone)) {
        out.in_flood_zone = true;               // proven in a Special Flood Hazard Area
      } else if (r.fema_flood_sfha === false || stated(r.fema_flood_zone) || stated(r.flood_zone)) {
        out.in_flood_zone = false;              // a real determination: checked / a stated non-A/V zone
      }
      // else: all NULL → not checked → leave OMITTED (unknown, never fabricated)
    }
  } catch (_) { /* fema_flood_* columns optional in some envs → omit in_flood_zone */ }

  // Claimed vs verified experience — feeds the FATAL isg_experience_claimed_over_verified
  // (fires only when claimed_exp > verified_exp, both present). NEVER-FALSE-FIRE discipline:
  //   • claimed_exp = the file's CLAIM of record = requested_exp_flips+holds+ground (the frozen
  //     experience math; `reo` is a legacy counter NOT part of it — src/lib/experience.js
  //     requestedFromApp). We only emit the pair when there IS a claim (sum > 0); no claim → the
  //     rule is moot, so both are OMITTED (never a fabricated 0).
  //   • verified_exp = experience.countBorrowersExperience(fileBorrowerIds, {verifiedOnly:true}).total
  //     — the co-borrower-summed count of VERIFIED track-record deals in the frozen 3-year exit
  //     window (REUSES the frozen RECENT_EXIT_SQL — never re-derived). A real success returning 0
  //     (claimed but nothing verified yet) DOES fire, which is exactly the note-buyer rule
  //     ("claimed experience must be verified before clearing"). Any query error → OMITTED → silent.
  try {
    const exp = require('../experience');
    const ar = await db.query(
      `SELECT borrower_id, co_borrower_id, requested_exp_flips, requested_exp_holds, requested_exp_ground
         FROM applications WHERE id = $1`, [applicationId]);
    const app = ar.rows[0];
    if (app) {
      const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
      const claim = int(app.requested_exp_flips) + int(app.requested_exp_holds) + int(app.requested_exp_ground);
      if (claim > 0) {
        const ids = exp.fileBorrowerIds(app);
        const verified = await exp.countBorrowersExperience(ids, db, { verifiedOnly: true });
        out.claimed_exp = claim;
        out.verified_exp = int(verified && verified.total);

        // has_stale_exit — feeds the WARNING isg_experience_stale_exit ("only exits within the
        // last 3 years count"). Gated on claim>0 (a file that doesn't rely on experience should
        // never be nagged about an old exit). We REUSE the frozen exit-date definition
        // (experience.EXIT_DATE_SQL — flip=sale, hold=lease/refi) and just invert its window: a
        // stale exit is a track-record deal whose exit date IS KNOWN and is OLDER than 36 months.
        // true = a stale exit exists; false = we checked and none is stale; OMITTED only on error
        // (never fabricated). A deal with no exit date is NOT stale (it just hasn't exited).
        try {
          const stale = await db.query(
            `SELECT 1 /* isg_stale_exit */ FROM track_records
               WHERE borrower_id = ANY($1::uuid[])
                 AND (${exp.EXIT_DATE_SQL}) IS NOT NULL
                 AND (${exp.EXIT_DATE_SQL}) < (CURRENT_DATE - INTERVAL '36 months')
               LIMIT 1`, [ids]);
          out.has_stale_exit = !!stale.rows[0];
        } catch (_) { /* stale-exit read error → omit has_stale_exit (rule stays silent) */ }
      }
      // claim === 0 → nothing claimed → OMIT all three (rule stays silent, never a fabricated 0)
    }
  } catch (_) { /* app row / track_records read error → omit claimed_exp+verified_exp */ }

  return out;
}

// Priced-input drift, derived from the context's source-priority discrepancies:
// a disagreement on a PRICING field (registration governing vs application) →
// { key, from: registration value, to: application value }. Casing-agnostic
// because the context did the comparison (regInputs camelCase vs app columns).
function pricedDrift(context) {
  const discrepancies = (context && context.discrepancies) || [];
  const out = [];
  for (const d of discrepancies) {
    if (!PRICED_CONTEXT_FIELDS.has(d.field)) continue;
    const conflict = (d.conflicts && d.conflicts[0]) || {};
    out.push({ key: d.field, from: d.governing ? d.governing.value : null, to: conflict.value != null ? conflict.value : null });
  }
  return out;
}

// Persist the run immutably: supersede the prior current run, insert the run +
// snapshot + calculations + findings + decision, all in one transaction.
async function persistRun(db, applicationId, context, assembled, createdBy) {
  // A dedicated client when a pool is available (so BEGIN/COMMIT span ONE
  // connection); otherwise a single-connection db handle (its .query is one
  // connection). Either way the whole write is wrapped in a transaction, so the
  // supersede-UPDATE + INSERT are atomic and the partial-unique current-run index
  // can never be violated by a concurrent run or left with no current run.
  const client = db.pool ? await db.pool.connect() : null;
  const q = client ? (text, params) => client.query(text, params) : (text, params) => db.query(text, params);
  try {
    await q('BEGIN');
    await q(`UPDATE underwriting_runs SET superseded_at = now() WHERE application_id = $1 AND superseded_at IS NULL`, [applicationId]);
    const runRes = await q(
      `INSERT INTO underwriting_runs
         (application_id, trigger, source_hash, source_versions, program_key, status,
          term_sheet_eligible, ctc_eligible, funding_eligible, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [applicationId, assembled.sourceVersions.trigger, assembled.sourceHash,
       JSON.stringify(assembled.sourceVersions), assembled.programKey, assembled.status,
       assembled.termSheetEligible, assembled.ctcEligible, assembled.fundingEligible, createdBy]);
    const runId = runRes.rows[0].id;

    await q(`INSERT INTO underwriting_run_snapshots (run_id, context) VALUES ($1,$2)`,
      [runId, JSON.stringify(context)]);

    for (const c of assembled.calculations) {
      await q(
        `INSERT INTO underwriting_run_calculations
           (run_id, metric, formula, numerator, denominator, result, cap, passed, binding, sources)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [runId, c.metric, c.formula, c.numerator, c.denominator, c.result, c.cap, c.passed, !!c.binding, JSON.stringify({ severity: c.severity })]);
    }
    for (const f of assembled.findings) {
      await q(
        `INSERT INTO underwriting_run_findings
           (run_id, code, severity, category, title, explanation, governing_rule,
            expected_value, actual_value, source, source_version,
            blocks_term_sheet, blocks_ctc, blocks_funding, permitted_actions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [runId, f.code, f.severity, f.category || null, f.title || f.code, f.explanation || null,
         f.governing_rule || null, str(f.expected_value), str(f.actual_value),
         (f.sources && f.sources[0]) || f.source || null, f.source_version || null,
         !!f.blocks_term_sheet, !!f.blocks_ctc, !!f.blocks_funding, JSON.stringify(f.permitted_actions || [])]);
    }
    await q(
      `INSERT INTO underwriting_run_decisions (run_id, status, decision_reasons)
       VALUES ($1,$2,$3)`,
      [runId, assembled.status, JSON.stringify(assembled.reasons || [])]);

    await q('COMMIT');
    return runId;
  } catch (e) {
    try { await q('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    if (client) client.release();
  }
}

function str(v) { return v == null ? null : String(v); }

module.exports = { assembleRun, runWholeLoan, maybeRunWholeLoan, gatherInvestorInputs, _internals: { capsFromQuote, structureFromContext, pricedDrift } };

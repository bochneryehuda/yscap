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
const decision = require('./decision');

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
  try {
    verificationFindings = await require('./verification-findings').gatherVerificationFindings(applicationId, db);
  } catch (_) { verificationFindings = []; }

  const assembled = assembleRun({
    context,
    registration,
    programDecision,
    staleChanged,
    manualApproved: o.manualApproved,
    extraFindings: [...(o.extraFindings || []), ...verificationFindings],
    trigger: o.trigger || 'manual_run',
  });

  if (o.persist === false) return { runId: null, context, ...assembled };
  const runId = await persistRun(db, applicationId, context, assembled, o.createdBy || null);
  return { runId, context, ...assembled };
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

module.exports = { assembleRun, runWholeLoan, _internals: { capsFromQuote, structureFromContext, pricedDrift } };

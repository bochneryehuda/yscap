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
const staleDetector = require('./stale-detector');
const decision = require('./decision');

// Structure-breach severity → finding shape. A hard ineligibility is fatal and
// blocks everything; a manual-review / approvable-exception breach blocks
// issuance (needs approval) but is a warning, not fatal.
const BREACH_FINDING = {
  hard_ineligible: { severity: 'fatal', blocks_term_sheet: true, blocks_ctc: true, blocks_funding: true },
  manual_review: { severity: 'warning', blocks_term_sheet: true, blocks_ctc: false, blocks_funding: false },
  approvable_exception: { severity: 'warning', blocks_term_sheet: true, blocks_ctc: false, blocks_funding: false },
};

// Map the registered quote's caps to the structure underwriter's cap shape.
function capsFromQuote(quote) {
  const c = (quote && quote.caps) || {};
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
  // appear in the one registry (the decision also gates on engineStatus).
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

  // Priced-input drift: compare the file's CURRENT priced inputs to the
  // registration's stored input snapshot.
  let staleChanged = [];
  if (registration && registration.inputs) {
    const cur = currentPricedInputs(context);
    staleChanged = staleDetector.detectStale(cur, registration.inputs).changed;
  }

  const assembled = assembleRun({
    context,
    registration,
    programDecision,
    staleChanged,
    manualApproved: o.manualApproved,
    extraFindings: o.extraFindings || [],
    trigger: o.trigger || 'manual_run',
  });

  if (o.persist === false) return { runId: null, context, ...assembled };
  const runId = await persistRun(db, applicationId, context, assembled, o.createdBy || null);
  return { runId, context, ...assembled };
}

// The file's CURRENT priced inputs (governing values), keyed to the stale
// detector's PRICING_INPUT_KEYS camelCase snapshot form used by the engine.
function currentPricedInputs(context) {
  const v = (context && context.values) || {};
  return {
    loan_amount: v.loan_amount, purchase_price: v.purchase_price, as_is_value: v.as_is_value,
    arv: v.arv, rehab_budget: v.rehab_budget, program: v.program, loan_type: v.loan_type,
    property_type: v.property_type, units: v.units, is_assignment: v.is_assignment,
    underlying_contract_price: v.underlying_contract_price, assignment_fee: v.assignment_fee,
    fico: v.fico,
  };
}

// Persist the run immutably: supersede the prior current run, insert the run +
// snapshot + calculations + findings + decision, all in one transaction.
async function persistRun(db, applicationId, context, assembled, createdBy) {
  const client = db.pool ? await db.pool.connect() : null;
  const q = client ? (text, params) => client.query(text, params) : (text, params) => db.query(text, params);
  try {
    if (client) await q('BEGIN');
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

    if (client) await q('COMMIT');
    return runId;
  } catch (e) {
    if (client) { try { await q('ROLLBACK'); } catch (_) { /* ignore */ } }
    throw e;
  } finally {
    if (client) client.release();
  }
}

function str(v) { return v == null ? null : String(v); }

module.exports = { assembleRun, runWholeLoan, _internals: { capsFromQuote, structureFromContext, currentPricedInputs } };

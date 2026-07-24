'use strict';
/**
 * R6.3 — The canonical Whole-Loan Underwriting Context (read-only builder).
 *
 * This is the ONE place the platform assembles every material loan-structure
 * fact from every desk (registration, the frozen pricing engine's stored io,
 * the application, the appraisal, documents, and the read-only system mirrors)
 * into a single provenance-tagged, source-resolved view of the deal. Every
 * downstream decision (status classification, structure verification, the final
 * decision that gates export/CTC/funding) reads from THIS — never from a raw
 * table directly — so a conclusion can always name its source and version, and
 * a source disagreement can never be silently resolved.
 *
 * HARD RULE: this layer is READ-ONLY and NON-AUTHORITATIVE over numbers. It
 * consumes the frozen engine's output (the registration snapshot). It never
 * re-prices, never invents a program number, never overwrites a source. A
 * missing fact stays a wrapped null (NOT_READY), never a fabricated 0/false.
 *
 * Two layers, so the logic is testable without a database:
 *   • assembleContext(sources)   — PURE. Given already-loaded raw rows, produces
 *                                  the resolved, provenance-wrapped context +
 *                                  the discrepancy list + a reproducible hash.
 *   • buildWholeLoanContext(id,db) — thin async loader that reads the rows and
 *                                  calls assembleContext.
 */

const crypto = require('crypto');
const prov = require('./provenance');
const sourcePriority = require('./source-priority');

// The structure facts the whole-loan context governs. `required` fields, when
// absent from EVERY source, make the context NOT_READY (never assume a value).
const CONTEXT_FIELDS = Object.freeze([
  { key: 'program', required: true },
  { key: 'loan_type', required: false },
  { key: 'property_type', required: false },
  { key: 'units', required: false },
  { key: 'purchase_price', required: false },
  { key: 'effective_purchase_price', required: false },
  { key: 'as_is_value', required: false },
  { key: 'arv', required: false },
  { key: 'rehab_budget', required: false },
  { key: 'loan_amount', required: true },
  { key: 'note_rate', required: false },
  { key: 'fico', required: false },
  { key: 'is_assignment', required: false },
  { key: 'assignment_fee', required: false },
  { key: 'underlying_contract_price', required: false },
  { key: 'borrower_name', required: false },
  { key: 'entity_name', required: false },
  { key: 'property_state', required: false },
  { key: 'note_buyer', required: false },   // the capital partner (applications.lender) — STAFF-ONLY, drives the investor-guideline review
]);
const REQUIRED_KEYS = Object.freeze(CONTEXT_FIELDS.filter((f) => f.required).map((f) => f.key));

// A number or null — never coerce a missing value to 0. '' / null / undefined
// all mean absent; a non-finite parse means absent.
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function bool(v) {
  if (v === null || v === undefined) return null;
  return !!v;
}
// Safely read a nested key from a parsed jsonb blob (inputs/quote).
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/**
 * Build the per-field candidate map from the raw source rows. Each candidate is
 * a provenance-wrapped fact carrying its source, id, version, and confidence.
 * The source-priority resolver then picks the governing value per field and
 * emits a discrepancy wherever two present sources disagree.
 */
function candidatesFor(sources) {
  const app = sources.application || {};
  const reg = sources.registration || null;
  const appr = sources.appraisal || null;
  const regInputs = (reg && (reg.inputs || {})) || {};
  const regQuote = (reg && (reg.quote || {})) || {};
  const regId = reg && reg.id ? reg.id : null;
  const regVer = reg && reg.created_at ? String(reg.created_at) : null;
  const apprId = appr && appr.id ? appr.id : null;
  const apprVer = appr && appr.created_at ? String(appr.created_at) : null;

  const map = {};
  const add = (field, cand) => {
    if (!cand) return;
    if (!map[field]) map[field] = [];
    map[field].push(cand);
  };
  // Only push a candidate when the value is actually present (a wrapped null
  // adds no information and would never be selected anyway).
  const regFact = (value, extra) => (value === null || value === undefined ? null
    : prov.fact({ value, source: 'registration', sourceId: regId, sourceVersion: regVer, confidence: 'definite', governing: true, ...(extra || {}) }));
  const engFact = (value) => (value === null || value === undefined ? null
    : prov.fact({ value, source: 'pricing_engine', sourceId: regId, sourceVersion: regVer, confidence: 'definite' }));
  const appFact = (value, conf) => (value === null || value === undefined ? null
    : prov.fact({ value, source: 'application', sourceId: app.id || null, sourceVersion: app.updated_at ? String(app.updated_at) : null, confidence: conf || 'high' }));
  const apprFact = (value) => (value === null || value === undefined ? null
    : prov.fact({ value, source: 'appraisal', sourceId: apprId, sourceVersion: apprVer, confidence: 'high' }));

  // program — registration is authoritative; the application's product hint is a
  // lower-authority candidate (a disagreement here means the file drifted off
  // its registered program).
  add('program', regFact(str(reg && reg.program)));
  add('program', appFact(str(app.registered_program || app.program), 'medium'));

  // The frozen engine's stored INPUTS are what the structure was priced on. The
  // application holds the CURRENT transaction facts. Both are candidates so a
  // drift (staleness) surfaces as a discrepancy rather than being hidden.
  add('loan_type', engFact(str(pick(regInputs, 'loanType', 'loan_type'))));
  add('loan_type', appFact(str(app.loan_type)));

  add('property_type', engFact(str(pick(regInputs, 'propertyType', 'property_type'))));
  add('property_type', appFact(str(app.property_type)));

  add('units', engFact(num(pick(regInputs, 'units'))));
  add('units', appFact(num(app.units)));

  add('purchase_price', engFact(num(pick(regInputs, 'purchasePrice', 'purchase_price'))));
  add('purchase_price', appFact(num(app.purchase_price)));

  add('effective_purchase_price',
    engFact(num(pick(regQuote.assignment || {}, 'recognizedPrice') ?? pick(regInputs, 'effectivePurchasePrice'))));

  add('as_is_value', engFact(num(pick(regInputs, 'asIsValue', 'as_is_value'))));
  add('as_is_value', appFact(num(app.as_is_value)));
  add('as_is_value', apprFact(num(appr && (appr.as_is_value ?? appr.appraised_value))));

  add('arv', engFact(num(pick(regInputs, 'arv'))));
  add('arv', appFact(num(app.arv)));
  add('arv', apprFact(num(appr && appr.arv_value)));

  add('rehab_budget', engFact(num(pick(regInputs, 'rehabBudget', 'rehab_budget'))));
  add('rehab_budget', appFact(num(app.rehab_budget)));

  // loan_amount + note_rate come from the registration ONLY — the frozen engine
  // sized these; there is no independent "application" loan amount to compete.
  add('loan_amount', regFact(num(reg && reg.total_loan)));
  add('note_rate', regFact(num(reg && reg.note_rate)));

  add('fico', engFact(num(pick(regInputs, 'fico'))));
  add('fico', appFact(num(app.fico)));

  add('is_assignment', engFact(bool(pick(regInputs, 'isAssignment', 'is_assignment'))));
  add('is_assignment', appFact(bool(app.is_assignment)));
  add('assignment_fee', engFact(num(pick(regInputs, 'assignmentFee', 'assignment_fee'))));
  add('assignment_fee', appFact(num(app.assignment_fee)));
  add('underlying_contract_price', engFact(num(pick(regInputs, 'underlyingContractPrice', 'underlying_contract_price'))));
  add('underlying_contract_price', appFact(num(app.underlying_contract_price)));

  add('borrower_name', appFact(str(app.borrower_name)));
  add('entity_name', appFact(str(app.entity_name || app.vesting_entity)));
  add('property_state', appFact(str(app.property_state)));
  add('note_buyer', appFact(str(app.lender)));   // capital partner; drives the investor-guideline review (staff-only)

  return map;
}

/**
 * assembleContext(sources) → the canonical whole-loan context (PURE).
 *
 * sources = {
 *   application, registration, appraisal,   // raw rows (jsonb already parsed)
 *   liquidity: { required, verified },       // optional precomputed liquidity
 *   asOf,                                     // optional ISO string stamp (never Date.now here)
 * }
 *
 * Returns {
 *   applicationId, asOf,
 *   fields: { key: { value, governingSource, confidence, sourceId, sourceVersion } },
 *   values: { key: value },                   // convenience flat map
 *   discrepancies: [ {field, governing, conflicts} ],
 *   missingRequired: [ key ],                 // required facts absent from every source
 *   registration: { present, id, status, isManual, stale, staleReason },
 *   liquidity: { required, verified, shortfall } | null,
 *   sourceHash,                               // stable hash of the governing values (reproducibility)
 *   ready,                                    // false when a required fact is missing
 * }
 */
function assembleContext(sources) {
  const s = sources || {};
  const byField = candidatesFor(s);
  const { values: resolved, discrepancies } = sourcePriority.resolveAll(byField);

  const fields = {};
  const flat = {};
  const missingRequired = [];
  for (const f of CONTEXT_FIELDS) {
    const r = resolved[f.key] || { value: null, governingSource: null, chosen: null };
    const chosen = r.chosen || null;
    fields[f.key] = {
      value: r.value === undefined ? null : r.value,
      governingSource: r.governingSource || null,
      confidence: chosen ? chosen.confidence : 'unknown',
      sourceId: chosen ? chosen.sourceId : null,
      sourceVersion: chosen ? chosen.sourceVersion : null,
    };
    flat[f.key] = fields[f.key].value;
    if (f.required && (fields[f.key].value === null || fields[f.key].value === undefined)) {
      missingRequired.push(f.key);
    }
  }

  const reg = s.registration || null;
  const registration = {
    present: !!reg,
    id: reg ? reg.id : null,
    status: reg ? (reg.status || null) : null,
    isManual: reg ? !!reg.is_manual : false,
    stale: reg ? !!reg.stale : false,
    staleReason: reg ? (reg.stale_reason || null) : null,
    registeredAt: reg ? (reg.created_at ? String(reg.created_at) : null) : null,
  };

  // Liquidity, when supplied: shortfall = required − verified (never negative-hidden).
  let liquidity = null;
  if (s.liquidity && (s.liquidity.required != null || s.liquidity.verified != null)) {
    const req = num(s.liquidity.required);
    const ver = num(s.liquidity.verified);
    liquidity = {
      required: req,
      verified: ver,
      shortfall: (req != null && ver != null) ? Math.max(0, +(req - ver).toFixed(2)) : null,
    };
  }

  // A reproducible hash of the GOVERNING values (+ registration identity + the
  // set of discrepancy fields) — two runs over the same sources hash identically,
  // so a run can be proven to reflect a specific state of the world.
  const hashInput = JSON.stringify({
    v: flat,
    reg: { id: registration.id, status: registration.status, stale: registration.stale, isManual: registration.isManual },
    disc: discrepancies.map((d) => d.field).sort(),
    liq: liquidity,
  });
  const sourceHash = crypto.createHash('sha256').update(hashInput).digest('hex');

  return {
    applicationId: s.application ? s.application.id : null,
    asOf: s.asOf || null,
    fields,
    values: flat,
    discrepancies,
    missingRequired,
    registration,
    liquidity,
    sourceHash,
    ready: missingRequired.length === 0,
  };
}

/**
 * buildWholeLoanContext(applicationId, db, opts?) → assembled context.
 * Thin READ-ONLY loader: pulls the application (+ highest borrower FICO), the
 * current registration, the current appraisal, and (best-effort) the liquidity
 * snapshot, then delegates to the pure assembler. No writes, no AI.
 */
async function buildWholeLoanContext(applicationId, db, opts) {
  if (!applicationId) return null;
  const o = opts || {};
  const a = await db.query(
    `SELECT a.*,
            NULLIF(GREATEST(COALESCE(b.fico,0), COALESCE(cb.fico,0)), 0) AS fico,
            b.full_name AS borrower_name,
            -- Fix 2026-07-23 (#209): registered_program is a JOIN alias everywhere
            -- in this codebase, never an applications column. Without it the
            -- assembler fell back to a.program (STRATEGY text like "Fix & Flip
            -- w/ Construction"), compared it to reg.program ('standard'/'gold'),
            -- and flagged a false program discrepancy → STALE on essentially
            -- every registered file.
            (SELECT pr.program FROM product_registrations pr
              WHERE pr.application_id = a.id AND pr.is_current = true
              ORDER BY pr.created_at DESC LIMIT 1) AS registered_program
       FROM applications a
       JOIN borrowers b  ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
      WHERE a.id = $1`, [applicationId]);
  const application = a.rows[0];
  if (!application) return null;

  const r = await db.query(
    `SELECT id, program, product_label, status, note_rate, total_loan, target_ltc,
            inputs, quote, is_manual, stale, stale_reason, created_at
       FROM product_registrations
      WHERE application_id = $1 AND is_current = true
      ORDER BY created_at DESC LIMIT 1`, [applicationId]);
  const registration = r.rows[0] || null;

  let appraisal = null;
  try {
    const ap = await db.query(
      `SELECT id, as_is_value, arv_value, appraised_value, created_at
         FROM appraisals
        WHERE application_id = $1 AND is_current = true
        ORDER BY created_at DESC LIMIT 1`, [applicationId]);
    appraisal = ap.rows[0] || null;
  } catch (_e) { appraisal = null; } // appraisals table optional in some envs

  return assembleContext({
    application,
    registration,
    appraisal,
    liquidity: o.liquidity || null,
    asOf: o.asOf || null,
  });
}

module.exports = {
  buildWholeLoanContext,
  assembleContext,
  candidatesFor,
  CONTEXT_FIELDS,
  REQUIRED_KEYS,
  _internals: { num, str, bool, pick },
};

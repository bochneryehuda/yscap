'use strict';
/**
 * Investor-guideline DESK (ISG-3 / Investor-Specific Soft Guidelines; owner-directed
 * 2026-07-23). The vetting engine for the THIRD underwriting layer: for a file's NOTE
 * BUYER, it works out which note-buyer condition guidelines apply, then judges each one
 * against the file — is the required evidence on file (via the mapped PILOT condition),
 * is it still outstanding, or does a value CONFLICT with the note buyer's guideline
 * (e.g. a seller concession over the buyer's cap) — and lists the applicable conditions
 * with no PILOT equivalent yet as SUGGESTIONS to post.
 *
 * ADVISORY ONLY. It never blocks a loan, never posts a condition itself (a human Converts
 * a suggestion via the existing AI-suggestion flow), never clears a condition, and touches
 * NO frozen number. It READS: the note_buyer_conditions library (ISG-2), the file's rule
 * context (conditions/engine.loadRuleContext — same one the guideline layer uses), the
 * file's checklist items (mapped by PILOT template code), and the digital-twin canonical
 * facts. Reuses those brains — no re-extraction, no redundant AI.
 *
 * The pure core (assess*, check*) has no DB/I-O and NEVER THROWS on hostile input; the DB
 * layer (loadDeskContext / runInvestorGuidelineDesk) is best-effort and returns a valid
 * empty result rather than throwing.
 */

const spec = require('./corrfirst-fnf-spec');

// Per-condition verdict.
const VERDICT = Object.freeze({
  SATISFIED: 'satisfied',       // the mapped PILOT condition is satisfied / signed off
  OUTSTANDING: 'outstanding',   // applies, but evidence not yet on file
  CONFLICTS: 'conflicts',       // a value on file contradicts the note buyer's guideline
  DEFERRED: 'deferred',         // applies but held for closing/attorney / post-closing
  NOT_APPLICABLE: 'not_applicable',
});

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function lc(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

// ---------------------------------------------------------------------------
// Numeric checks — evaluate a note-buyer's exact limits against KNOWN file signals.
// A check only ever fires a CONFLICT on a known value; a missing value → 'to_verify'
// (advisory), NEVER a fabricated conflict. Each returns { status, detail }.
//   status: 'ok' | 'conflict' | 'to_verify'
// `signals` is assembled by the DB layer from ctx + twin facts + app fields.
// ---------------------------------------------------------------------------
function fmtMoney(n) { return `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`; }

// seller concession cap: 6% of sale price (3% for 5+ unit / mixed-use). cond 3035.
function checkSellerConcession(signals) {
  const pct = num(signals.seller_concession_pct);
  const units = num(signals.units);
  const cap = (units != null && units >= 5) ? 3 : 6;
  if (pct == null) return { status: 'to_verify', detail: `Confirm the seller concession does not exceed ${cap}% of the sale price.` };
  if (pct > cap + 1e-9) return { status: 'conflict', detail: `Seller concession is ${pct}% — over the ${cap}% cap.` };
  return { status: 'ok', detail: `Seller concession ${pct}% is within the ${cap}% cap.` };
}

// construction contingency cap: 10% of total budget. cond 2193.
function checkContingency(signals) {
  const pct = num(signals.sow_contingency_pct);
  if (pct == null) return { status: 'to_verify', detail: 'Confirm the SOW contingency does not exceed 10% of the total budget.' };
  if (pct > 10 + 1e-9) return { status: 'conflict', detail: `Contingency is ${pct}% — over the 10% maximum.` };
  return { status: 'ok', detail: `Contingency ${pct}% is within the 10% maximum.` };
}

// hazard liability coverage tiers by loan amount. cond 2186 (CorrFirst limits).
function checkLiabilityTier(signals) {
  const loan = num(signals.loan_amount);
  const cover = num(signals.liability_coverage);
  if (loan == null) return { status: 'to_verify', detail: 'Confirm liability coverage meets the tier for the loan amount.' };
  const required = loan <= 500000 ? 300000 : (loan <= 1000000 ? 500000 : 1000000);
  if (cover == null) return { status: 'to_verify', detail: `Requires at least ${fmtMoney(required)} liability coverage for a ${fmtMoney(loan)} loan.` };
  if (cover + 1e-9 < required) return { status: 'conflict', detail: `Liability coverage is ${fmtMoney(cover)} — below the ${fmtMoney(required)} required for a ${fmtMoney(loan)} loan.` };
  return { status: 'ok', detail: `Liability coverage ${fmtMoney(cover)} meets the ${fmtMoney(required)} tier.` };
}

// subject value vs Zillow median caps (125/200/300% by unit count). cond 2798.
function checkMedianValue(signals) {
  const units = num(signals.units) || 1;
  const median = num(signals.zillow_median);
  const value = num(signals.arv) != null ? num(signals.arv) : num(signals.as_is_value);
  const capPct = units >= 3 ? 300 : (units === 2 ? 200 : 125);
  if (median == null || value == null) return { status: 'to_verify', detail: `Confirm the As-Is/ARV does not exceed ${capPct}% of the Zillow median (unless exempt).` };
  const ratio = Math.round((value / median) * 1000) / 10;
  if (ratio > capPct + 1e-9) return { status: 'conflict', detail: `Value is ${ratio}% of the Zillow median — over the ${capPct}% cap (check the exemptions).` };
  return { status: 'ok', detail: `Value is ${ratio}% of the Zillow median, within the ${capPct}% cap.` };
}

// A check evaluator per condition number, when a note-buyer-specific numeric limit exists.
const CHECK_EVALUATORS = {
  3035: checkSellerConcession,
  2193: checkContingency,
  2186: checkLiabilityTier,
  2798: checkMedianValue,
};

/**
 * assessCondition(cond, ctx) → verdict object (PURE, never throws).
 *   ctx = { existingByCode: Map<code,{status,signed_off}>, signals, noteBuyerKey }
 * The verdict is driven by the mapped PILOT condition's status; note-buyer numeric limits
 * add `checks` and can escalate the verdict to CONFLICTS on a known bad value.
 */
function assessCondition(cond, ctx) {
  try {
    const c = cond && typeof cond === 'object' ? cond : {};
    const o = ctx && typeof ctx === 'object' ? ctx : {};
    const existingByCode = o.existingByCode instanceof Map ? o.existingByCode : new Map();
    const signals = o.signals && typeof o.signals === 'object' ? o.signals : {};

    // deferred/held conditions are surfaced but never posted/evaluated now.
    if (c.lifecycle && c.lifecycle !== 'active_now') {
      return base(c, VERDICT.DEFERRED, `Held for the ${labelLifecycle(c.lifecycle)} stage.`, []);
    }

    // note-buyer numeric checks (advisory verifications; a known bad value → conflict).
    const evaluator = CHECK_EVALUATORS[c.cond_no];
    const checks = (Array.isArray(c.checks) ? c.checks : []).map((k) => {
      const r = evaluator ? evaluator(signals) : null;
      return { text: k.text, note_buyer_specific: !!k.note_buyer_specific, status: (r && r.status) || 'to_verify', detail: r ? r.detail : null };
    });
    const conflicting = checks.filter((k) => k.status === 'conflict');

    // evidence status from the mapped PILOT condition (if any).
    const item = c.pilot_template_code ? existingByCode.get(c.pilot_template_code) : null;
    const satisfied = item && (lc(item.status) === 'satisfied' || item.signed_off);

    let verdict; let reason;
    if (conflicting.length) {
      verdict = VERDICT.CONFLICTS;
      reason = conflicting.map((k) => k.detail).filter(Boolean).join(' ');
    } else if (satisfied) {
      verdict = VERDICT.SATISFIED;
      reason = c.pilot_template_code ? `Cleared on the file (${c.pilot_template_code}).` : 'Cleared on the file.';
    } else if (item) {
      verdict = VERDICT.OUTSTANDING;
      reason = `In progress on the file (${c.pilot_template_code}); ${statusPhrase(item.status)}.`;
    } else {
      verdict = VERDICT.OUTSTANDING;
      reason = c.match_quality === 'new'
        ? 'No matching condition on the file yet — suggest posting it.'
        : `Maps to ${c.pilot_template_code || 'a PILOT condition'}, not yet on the file.`;
    }
    // "suggest posting" applies only to an OUTSTANDING, unmapped (new) condition — a
    // conflicting or satisfied condition is surfaced under its own signal, not as a post.
    const suggestPost = verdict === VERDICT.OUTSTANDING && !item && c.match_quality === 'new';
    return base(c, verdict, reason, checks, { pilotOnFile: !!item, suggestPost });
  } catch (_e) {
    return base(cond || {}, VERDICT.OUTSTANDING, 'Could not assess (defaulted to outstanding).', []);
  }
}

function base(c, verdict, reason, checks, extra) {
  return {
    cond_no: c.cond_no, name: c.name, domain: c.domain, scope: c.scope,
    lifecycle: c.lifecycle, clears_by: c.clears_by, required_evidence: c.required_evidence,
    pilot_template_code: c.pilot_template_code || null, match_quality: c.match_quality || null,
    verdict, reason, checks: Array.isArray(checks) ? checks : [],
    ...(extra || {}),
  };
}
function labelLifecycle(l) {
  return l === 'hold_attorney_closing' ? 'closing / attorney'
    : l === 'defer_post_closing' ? 'post-closing'
    : l === 'closing_phase' ? 'closing' : l;
}
function statusPhrase(s) {
  const m = { outstanding: 'not provided yet', requested: 'requested', received: 'received, under review', issue: 'flagged with an issue', satisfied: 'satisfied' };
  return m[lc(s)] || 'in progress';
}

/**
 * assess({ conditions, existingByCode, signals, noteBuyerKey, noteBuyerName }) → full desk
 * result (PURE, never throws). `conditions` are the ALREADY trigger-filtered applicable rows
 * (active + deferred); the DB layer evaluates triggers via the shared evaluator.
 */
function assess(input) {
  const i = input && typeof input === 'object' ? input : {};
  const conditions = Array.isArray(i.conditions) ? i.conditions : [];
  const ctx = { existingByCode: i.existingByCode, signals: i.signals || {}, noteBuyerKey: i.noteBuyerKey };
  const verdicts = conditions.map((c) => assessCondition(c, ctx));

  const active = verdicts.filter((v) => v.verdict !== VERDICT.DEFERRED);
  const summary = {
    applicable: active.length,
    satisfied: active.filter((v) => v.verdict === VERDICT.SATISFIED).length,
    outstanding: active.filter((v) => v.verdict === VERDICT.OUTSTANDING).length,
    conflicts: active.filter((v) => v.verdict === VERDICT.CONFLICTS).length,
    deferred: verdicts.filter((v) => v.verdict === VERDICT.DEFERRED).length,
    toPost: active.filter((v) => v.suggestPost).length,
  };
  return {
    noteBuyer: { key: i.noteBuyerKey || null, name: i.noteBuyerName || null },
    product: spec.PRODUCT,
    verdicts,
    conflicts: active.filter((v) => v.verdict === VERDICT.CONFLICTS),
    suggestedToPost: active.filter((v) => v.suggestPost),
    deferred: verdicts.filter((v) => v.verdict === VERDICT.DEFERRED),
    summary,
    // a plain one-line read for the owner.
    headline: summary.conflicts > 0
      ? `${summary.conflicts} item(s) conflict with the note buyer's guideline; ${summary.outstanding} still outstanding.`
      : summary.applicable === 0
        ? 'No investor guideline conditions apply to this file yet.'
        : `${summary.satisfied} of ${summary.applicable} met; ${summary.outstanding} outstanding${summary.toPost ? `, ${summary.toPost} to post` : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// DB layer (best-effort; lazy-requires DB + the rule engine so the pure core loads
// and unit-tests with no Postgres).
// ---------------------------------------------------------------------------

/**
 * runInvestorGuidelineDesk(appId, db?) → the desk result for a file, or a valid empty
 * result. Best-effort; never throws out. STAFF surface (keeps note-buyer names).
 */
async function runInvestorGuidelineDesk(appId, client) {
  const empty = { noteBuyer: { key: null, name: null }, product: spec.PRODUCT, verdicts: [], conflicts: [], suggestedToPost: [], deferred: [], summary: { applicable: 0, satisfied: 0, outstanding: 0, conflicts: 0, deferred: 0, toPost: 0 }, headline: 'No investor guideline conditions apply to this file yet.', empty: true };
  let engine; let evaluator; let twin; let db;
  try {
    engine = require('../../conditions/engine');
    evaluator = require('../guideline-evaluator');
    twin = require('../twin');
    db = client || require('../../../db');
  } catch (_e) { return empty; }

  let ctx; let app;
  try {
    const loaded = await engine.loadRuleContext(appId);
    if (!loaded) return empty;
    ctx = loaded.ctx; app = loaded.app;
  } catch (_e) { return empty; }

  const noteBuyerKey = lc(ctx.note_buyer);

  // 1. load the applicable note-buyer conditions from the active version(s).
  let rows = [];
  try {
    const r = await db.query(
      `SELECT nbc.* FROM note_buyer_conditions nbc
         JOIN guideline_versions gv ON gv.id = nbc.guideline_version_id AND gv.approval_status = 'active'
        WHERE nbc.active = true AND nbc.product = $1
          AND ( nbc.scope = 'all_note_buyers'
             OR (nbc.scope IN ('note_buyer','all_but_note_buyer_limits')
                 AND EXISTS (SELECT 1 FROM investors i WHERE i.id = nbc.investor_id AND i.label_norm = $2)) )
        ORDER BY nbc.cond_no`,
      [spec.PRODUCT, noteBuyerKey]);
    rows = r.rows || [];
  } catch (_e) { rows = []; }
  if (!rows.length) return { ...empty, noteBuyer: { key: noteBuyerKey || null, name: app && app.lender ? String(app.lender) : null } };

  // 2. trigger-filter: a condition applies unless its trigger is a KNOWN non-match.
  const applicable = rows.filter((row) => {
    const trig = row.trigger;
    if (!trig || (typeof trig === 'object' && Object.keys(trig).length === 0)) return true; // always
    try { const ev = evaluator.evaluate(trig, ctx); return ev.matched !== false; } catch (_e) { return true; }
  });

  // 3. existing checklist items mapped by their PILOT template CODE.
  const existingByCode = new Map();
  try {
    const codes = applicable.map((r) => r.pilot_template_code).filter(Boolean);
    if (codes.length) {
      const q = await db.query(
        `SELECT ct.code, ci.status, (ci.signed_off_at IS NOT NULL) AS signed_off
           FROM checklist_items ci JOIN checklist_templates ct ON ct.id = ci.template_id
          WHERE ci.application_id = $1 AND ct.code = ANY($2::text[])`,
        [appId, codes]);
      for (const row of q.rows) {
        // keep the "most cleared" instance if a code appears more than once.
        const prev = existingByCode.get(row.code);
        if (!prev || row.signed_off || lc(row.status) === 'satisfied') existingByCode.set(row.code, { status: row.status, signed_off: row.signed_off });
      }
    }
  } catch (_e) { /* items unavailable — treat as none on file */ }

  // 4. signals for the numeric checks: ctx + app fields + twin facts (best-effort).
  const signals = {
    loan_amount: num(ctx.loan_amount),
    units: num(ctx.units) != null ? num(ctx.units) : num(app && app.units),
    as_is_value: num(app && app.as_is_value),
    arv: num(app && app.arv),
    property_state: ctx.property_state,
  };
  try {
    const facts = await twin.factsForFile(appId, db);
    for (const f of facts || []) {
      const k = String(f.fact_key || '');
      const v = f.value_normalized != null ? f.value_normalized : (f.value_json && f.value_json.value);
      if (/seller.?concession/i.test(k)) signals.seller_concession_pct = num(v);
      else if (/contingency/i.test(k)) signals.sow_contingency_pct = num(v);
      else if (/liability/i.test(k)) signals.liability_coverage = num(v);
      else if (/zillow|median/i.test(k)) signals.zillow_median = num(v);
    }
  } catch (_e) { /* twin unavailable — numeric checks stay to_verify */ }

  return assess({
    conditions: applicable, existingByCode, signals,
    noteBuyerKey, noteBuyerName: app && app.lender ? String(app.lender) : null,
  });
}

module.exports = {
  VERDICT, assess, assessCondition,
  checkSellerConcession, checkContingency, checkLiabilityTier, checkMedianValue, CHECK_EVALUATORS,
  runInvestorGuidelineDesk,
  _internals: { num, lc, statusPhrase, labelLifecycle },
};

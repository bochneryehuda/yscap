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
const rules = require('../../conditions/rules'); // pure rule_logic evaluator (same one the condition engine uses)

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

// A check never throws on hostile input — a non-object signals bag reads as empty.
function sig(signals) { return signals && typeof signals === 'object' ? signals : {}; }

// seller concession cap: 6% of sale price (3% for 5+ unit / mixed-use). cond 3035.
function checkSellerConcession(signals) {
  const s = sig(signals);
  const pct = num(s.seller_concession_pct);
  const units = num(s.units);
  const cap = (units != null && units >= 5) ? 3 : 6;
  if (pct == null) return { status: 'to_verify', detail: `Confirm the seller concession does not exceed ${cap}% of the sale price.` };
  if (pct > cap + 1e-9) return { status: 'conflict', detail: `Seller concession is ${pct}% — over the ${cap}% cap.` };
  return { status: 'ok', detail: `Seller concession ${pct}% is within the ${cap}% cap.` };
}

// construction contingency cap: 10% of total budget. cond 2193.
function checkContingency(signals) {
  const pct = num(sig(signals).sow_contingency_pct);
  if (pct == null) return { status: 'to_verify', detail: 'Confirm the SOW contingency does not exceed 10% of the total budget.' };
  if (pct > 10 + 1e-9) return { status: 'conflict', detail: `Contingency is ${pct}% — over the 10% maximum.` };
  return { status: 'ok', detail: `Contingency ${pct}% is within the 10% maximum.` };
}

// hazard liability coverage tiers by loan amount. cond 2186 (CorrFirst limits).
function checkLiabilityTier(signals) {
  const s = sig(signals);
  const loan = num(s.loan_amount);
  const cover = num(s.liability_coverage);
  if (loan == null) return { status: 'to_verify', detail: 'Confirm liability coverage meets the tier for the loan amount.' };
  const required = loan <= 500000 ? 300000 : (loan <= 1000000 ? 500000 : 1000000);
  if (cover == null) return { status: 'to_verify', detail: `Requires at least ${fmtMoney(required)} liability coverage for a ${fmtMoney(loan)} loan.` };
  if (cover + 1e-9 < required) return { status: 'conflict', detail: `Liability coverage is ${fmtMoney(cover)} — below the ${fmtMoney(required)} required for a ${fmtMoney(loan)} loan.` };
  return { status: 'ok', detail: `Liability coverage ${fmtMoney(cover)} meets the ${fmtMoney(required)} tier.` };
}

// subject value vs Zillow median caps (125/200/300% by unit count). cond 2798.
function checkMedianValue(signals) {
  const s = sig(signals);
  const units = num(s.units) || 1;
  const median = num(s.zillow_median);
  const value = num(s.arv) != null ? num(s.arv) : num(s.as_is_value);
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

// The field keys a trigger references (recursive over rule_logic groups). PURE.
function triggerFields(trig) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.rules)) node.rules.forEach(walk);
    else if (node.field) out.push(String(node.field));
  };
  walk(trig);
  return out;
}

/**
 * triggerApplies(trigger, ctx, fieldMap) → boolean (PURE, never throws). Uses the SAME
 * rule_logic evaluator as the condition engine (conditions/rules.evaluateRule). FAIL-OPEN:
 * an empty trigger always applies, and a trigger whose field we cannot confirm (absent from
 * the context) INCLUDES the condition — an advisory soft-guideline desk must never silently
 * DROP a requirement, only skip one it can confidently rule out (a known non-match on a
 * present field, e.g. property_type is a known value that is not 'condo').
 */
function triggerApplies(trigger, ctx, fieldMap) {
  try {
    const t = trigger && typeof trigger === 'object' && !Array.isArray(trigger) ? trigger : {};
    if (!Array.isArray(t.rules) || t.rules.length === 0) return true; // {} = always applies
    const c = ctx || {};
    const refs = triggerFields(t);
    // fail-open: any referenced field missing/blank in the context → cannot confirm → include.
    if (refs.some((k) => c[k] === undefined || c[k] === null || c[k] === '')) return true;
    return rules.evaluateRule(t, c, fieldMap || undefined) === true;
  } catch (_e) { return true; }
}

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
    // A condition's evaluator produces ONE result for the file's actual tier — it must run
    // ONCE, not once per spec check (the tiered note-buyer-specific spec rows are alternative
    // wordings of the SAME numeric rule, so stamping the evaluator's detail onto every one
    // printed the same line N times). So: when an evaluator exists, emit a SINGLE numeric line
    // (the file's applicable tier) plus any genuinely descriptive (non-numeric) checks; when
    // there is no evaluator, keep the spec checks as-is (each with its own text, to_verify).
    const evaluator = CHECK_EVALUATORS[c.cond_no];
    const specChecks = Array.isArray(c.checks) ? c.checks : [];
    let checks;
    if (evaluator) {
      const r = evaluator(signals) || null;
      const nbs = specChecks.filter((k) => k && k.note_buyer_specific);
      const descriptive = specChecks.filter((k) => k && !k.note_buyer_specific);
      const numericLine = {
        text: (r && r.detail) || (nbs[0] && nbs[0].text) || 'Note-buyer numeric verification',
        note_buyer_specific: true,
        status: (r && r.status) || 'to_verify',
        detail: r ? r.detail : null,
      };
      checks = [numericLine, ...descriptive.map((k) => ({ text: k.text, note_buyer_specific: false, status: 'to_verify', detail: null }))];
    } else {
      checks = specChecks.map((k) => ({ text: k.text, note_buyer_specific: !!k.note_buyer_specific, status: 'to_verify', detail: null }));
    }
    const conflicting = checks.filter((k) => k.status === 'conflict');

    // evidence status from the mapped PILOT condition (if any).
    const item = c.pilot_template_code ? existingByCode.get(c.pilot_template_code) : null;
    const satisfied = item && (lc(item.status) === 'satisfied' || item.signed_off);

    let verdict; let reason;
    if (conflicting.length) {
      verdict = VERDICT.CONFLICTS;
      // several checks on one condition share the same evaluator → dedupe the cited reason.
      reason = [...new Set(conflicting.map((k) => k.detail).filter(Boolean))].join(' ');
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
 * dedupePreferSpecific(rows) → rows (PURE, never throws). The ONLY duplication this removes is a
 * GENERIC-vs-SPECIFIC pair: when the file's own note buyer has its OWN condition (scope
 * 'note_buyer' / 'all_but_note_buyer_limits') for a given PILOT template code, the shared generic
 * `all_note_buyers` condition(s) for that SAME code are dropped (the buyer's own requirement
 * supersedes the shared one). Everything else is kept AS-IS — critically, TWO note-buyer-specific
 * conditions that share a template code are DISTINCT requirements (the guideline→PILOT crosswalk
 * is many-to-one: e.g. 6 different title requirements all clear through rtl_cond_title) and must
 * both survive. Rows with no template code are always kept. Order is preserved.
 */
function dedupePreferSpecific(rows) {
  try {
    const list = Array.isArray(rows) ? rows : [];
    // codes that a note-buyer-SPECIFIC row owns → their generic counterparts are superseded.
    const specificCodes = new Set();
    for (const row of list) {
      const r = row && typeof row === 'object' ? row : null;
      if (!r || !r.pilot_template_code) continue;
      if (r.scope && r.scope !== 'all_note_buyers') specificCodes.add(String(r.pilot_template_code));
    }
    const out = [];
    for (const row of list) {
      const r = row && typeof row === 'object' ? row : null;
      if (!r) continue;
      const code = r.pilot_template_code ? String(r.pilot_template_code) : null;
      // drop ONLY a generic row whose code is covered by a buyer-specific row.
      if (code && r.scope === 'all_note_buyers' && specificCodes.has(code)) continue;
      out.push(r);
    }
    return out;
  } catch (_e) { return Array.isArray(rows) ? rows : []; }
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

  // The OVERLAY view (owner-directed 2026-07-23): the investor-guideline layer is a backend AI
  // that only speaks up when the note buyer would NOT be happy with the file as-is. It is NOT a
  // list to post. Two things make the investor unhappy:
  //   1. CONFLICT — a value on the file contradicts the note buyer's guideline (a satisfied doc
  //      that doesn't meet the rule, or a field over the buyer's limit). Always fatal.
  //   2. COVERAGE GAP — the note buyer REQUIRES this, but there is NO condition posted for it on
  //      the file (deleted / never populated). An OPEN condition is fine (it will be checked when
  //      its document arrives) — a gap is when nothing exists at all. Feasibility / construction
  //      requirements missing on a ground-up or heavy-rehab loan are FATAL ("pop up something
  //      big"); other missing required conditions are a warning to post them.
  const isGap = (v) => v.verdict === VERDICT.OUTSTANDING && !v.pilotOnFile;
  const gapSeverity = (v) => (v.domain === 'construction_feasibility' ? 'fatal' : 'warning');
  const unhappy = [];
  for (const v of active) {
    if (v.verdict === VERDICT.CONFLICTS) unhappy.push(Object.assign({}, v, { flag: 'conflict', severity: 'fatal' }));
    else if (isGap(v)) unhappy.push(Object.assign({}, v, { flag: 'coverage_gap', severity: gapSeverity(v) }));
  }
  const happy = unhappy.length === 0;

  const summary = {
    applicable: active.length,
    satisfied: active.filter((v) => v.verdict === VERDICT.SATISFIED).length,
    outstanding: active.filter((v) => v.verdict === VERDICT.OUTSTANDING).length,
    conflicts: active.filter((v) => v.verdict === VERDICT.CONFLICTS).length,
    deferred: verdicts.filter((v) => v.verdict === VERDICT.DEFERRED).length,
    toPost: active.filter((v) => v.suggestPost).length,
    // overlay tallies
    unhappy: unhappy.length,
    coverageGaps: unhappy.filter((u) => u.flag === 'coverage_gap').length,
    fatal: unhappy.filter((u) => u.severity === 'fatal').length,
  };
  return {
    noteBuyer: { key: i.noteBuyerKey || null, name: i.noteBuyerName || null },
    product: spec.PRODUCT,
    happy,
    unhappy,
    verdicts,
    conflicts: active.filter((v) => v.verdict === VERDICT.CONFLICTS),
    suggestedToPost: active.filter((v) => v.suggestPost),
    deferred: verdicts.filter((v) => v.verdict === VERDICT.DEFERRED),
    summary,
    // a plain one-line read — leads with whether the investor is happy with the file as-is.
    headline: summary.applicable === 0
      ? 'No investor guideline conditions apply to this file yet.'
      : happy
        ? `The note buyer is satisfied with the file as it stands (${summary.satisfied} of ${summary.applicable} met; ${summary.outstanding} still coming in).`
        : `The note buyer is NOT satisfied with the file as-is: ${summary.unhappy} item(s) need attention${summary.fatal ? ` (${summary.fatal} urgent)` : ''}.`,
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
  let engine; let registry; let twin; let db;
  try {
    engine = require('../../conditions/engine');
    registry = require('../../conditions/field-registry');
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

  // 1. load the applicable note-buyer conditions from the active version(s). Product-AGNOSTIC:
  // a file's note buyer may own more than one product spec (CorrFirst F&F, Blue Lake RTL, …),
  // so we load by note-buyer applicability, NOT a single hard-coded product. A row applies when
  // it is scoped to all note buyers, OR it is note-buyer-scoped and this IS that note buyer.
  let rows = [];
  try {
    const r = await db.query(
      `SELECT nbc.* FROM note_buyer_conditions nbc
         JOIN guideline_versions gv ON gv.id = nbc.guideline_version_id AND gv.approval_status = 'active'
        WHERE nbc.active = true
          AND ( nbc.scope = 'all_note_buyers'
             OR (nbc.scope IN ('note_buyer','all_but_note_buyer_limits')
                 AND EXISTS (SELECT 1 FROM investors i WHERE i.id = nbc.investor_id AND i.label_norm = $1)) )
        ORDER BY nbc.cond_no`,
      [noteBuyerKey]);
    rows = r.rows || [];
  } catch (_e) { rows = []; }
  if (!rows.length) return { ...empty, noteBuyer: { key: noteBuyerKey || null, name: app && app.lender ? String(app.lender) : null } };

  // 1b. dedup — the file's OWN note buyer's specific condition supersedes a generic
  // all-note-buyers condition covering the same PILOT template (e.g. Blue Lake's
  // credit/OFAC/title/appraisal versions win over the shared generic ones), so the desk
  // never shows two rows for the same requirement.
  rows = dedupePreferSpecific(rows);

  // 2. trigger-filter (fail-open): a condition applies unless its trigger is a KNOWN
  // non-match on a field we can confirm. Uses the condition engine's own rule_logic
  // evaluator with the real field map.
  let fieldMap = null;
  try { fieldMap = await registry.fieldMap(db); } catch (_e) { fieldMap = registry.BY_KEY; }
  const applicable = rows.filter((row) => triggerApplies(row.trigger, ctx, fieldMap));

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

  // SOW-contingency % bridge (2026-07-24): a note buyer's contingency-CAP guideline
  // (e.g. Blue Lake cond 2193) checks a MAX contingency %, but no twin fact carries
  // it — so the numeric check fell back to "to verify" on every file. The amount is
  // already on the file: the saved Scope-of-Work payload (checklist_items.tool_payload
  // for the rehab-budget tool). Compute the pct directly = contingency / construction
  // subtotal × 100. Best-effort; only sets the signal when a real subtotal is present,
  // and never overrides a twin fact if one exists. On any error the check stays advisory.
  if (signals.sow_contingency_pct == null) {
    try {
      const rb = require('../../rehab-budget');
      const sowRow = await db.query(
        `SELECT tool_payload FROM checklist_items
          WHERE application_id=$1 AND tool_key='rehab_budget' AND tool_payload IS NOT NULL
          ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [appId]);
      const payload = sowRow.rows[0] && sowRow.rows[0].tool_payload;
      const pct = payload ? rb.sowContingencyPct(payload) : null;
      if (pct != null) signals.sow_contingency_pct = pct;
    } catch (_e) { /* SOW unreadable — contingency check stays to_verify */ }
  }

  return assess({
    conditions: applicable, existingByCode, signals,
    noteBuyerKey, noteBuyerName: app && app.lender ? String(app.lender) : null,
  });
}

module.exports = {
  VERDICT, assess, assessCondition,
  checkSellerConcession, checkContingency, checkLiabilityTier, checkMedianValue, CHECK_EVALUATORS,
  triggerApplies, triggerFields, dedupePreferSpecific,
  runInvestorGuidelineDesk,
  _internals: { num, lc, statusPhrase, labelLifecycle },
};

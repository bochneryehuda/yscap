'use strict';

// Scope-of-Work / rehab-budget integrity (#75, belt-and-suspenders 2026-07-10).
//
// The Scope of Work DETAILS the file's rehab budget — it must never silently
// CHANGE it. The authoritative number is the registered product's budget (once a
// product is registered) or, before that, the application's rehab_budget. The
// SOW always SAVES (as a draft, never refused); the exact-match rule is purely a
// CONDITION gate — the rehab-budget condition may only be cleared / signed off
// when the numbers agree to the cent.
//
// TWO numbers on the SOW must both equal that authoritative budget for the
// condition to clear (owner-directed 2026-07-10):
//   · the FIRST-PAGE construction budget  — `state.target`, prefilled from the
//     application ("the exact total you start at originally")
//   · the LAST-PAGE line-item grand total — `total` (subtotal + contingency + GC)
// Checking each against the required budget also transitively forces the
// first-page number and the line-item total to equal each other.

const db = require('../db');

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const eqCents = (a, b) => Math.round((Number(a) || 0) * 100) === Math.round((Number(b) || 0) * 100);

// Money formatted EXACTLY as the gates compare it — to the cent. A mismatch
// message must never round away the very difference it is complaining about
// (owner-reported 2026-07-24: the gate refused while all four budgets displayed
// "$120,000" — the real gap was cents, hidden by the dollar-rounded `money()`).
// Every budget-mismatch message below uses THIS, never `money()`.
const moneyExact = (n) => {
  const cents = Math.round((Number(n) || 0) * 100) || 0;   // `|| 0` also kills "-0.00" for sub-cent negatives
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Plain-language size+direction of the gap between two amounts, at cent
// precision: gapPhrase(119999.99, 120000) → "$0.01 lower". Never returns an
// empty gap for values the gates consider unequal (both use the same cent
// rounding), so the message always names a visible difference.
function gapPhrase(value, versus) {
  const diff = Math.round((Number(value) || 0) * 100) - Math.round((Number(versus) || 0) * 100);
  const abs = moneyExact(Math.abs(diff) / 100);
  return diff < 0 ? `${abs} lower` : `${abs} higher`;
}

// Parse a possibly-formatted money value ("75,000", "$75000.50", 75000) → number
// or null when there's nothing usable.
function toNum(v) {
  if (v == null) return null;
  const raw = String(v).trim();
  // Preserve the SIGN (fix 2026-07-23): stripping '-' let a NEGATIVE
  // contingency (or a sign-flipped total) satisfy the SOW gates — this JS
  // layer is the primary gate (signOffGate rejects before any DB write; the
  // db/069/192 trigger also sign-strips, so it is belt-and-suspenders only).
  // Correctness tightening only — no threshold or budget number changes.
  // '$-5,000' counts as negative too (the minus may sit after the currency
  // symbol), and accounting parens '(5,000)' stay negative.
  const neg = /^\(.*\)$/.test(raw) || /^[^0-9]*-/.test(raw);
  const s = raw.replace(/[^0-9.]/g, '');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// The first-page construction budget carried on a saved SOW payload
// (`payload.state.target`), or null when the SOW hasn't set one.
function firstPageBudget(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const st = payload.state && typeof payload.state === 'object' ? payload.state : null;
  return st ? toNum(st.target) : null;
}

// The authoritative required rehab budget for a file, or null if none set yet.
async function requiredRehabBudget(appId, client = db) {
  const reg = (await client.query(
    `SELECT inputs, stale FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0];
  // A STALE registration was priced off a budget the file no longer carries (the
  // db/096 trigger flags it the moment rehab_budget changes). Ignore it and fall
  // back to the current file budget, so the SOW gate demands the NEW budget and its
  // [auto] note names the right number — not the superseded registered one (#30).
  if (reg && !reg.stale && reg.inputs && reg.inputs.rehabBudget != null && Number(reg.inputs.rehabBudget) > 0) {
    return Number(reg.inputs.rehabBudget);
  }
  const a = (await client.query(`SELECT rehab_budget FROM applications WHERE id=$1`, [appId])).rows[0];
  return a && a.rehab_budget != null && Number(a.rehab_budget) > 0 ? Number(a.rehab_budget) : null;
}

// Gate a Scope-of-Work submit. The second argument may be either the bare
// line-item total (legacy callers) OR the full saved payload (preferred — lets
// us ALSO validate the first-page construction budget). Returns:
//   { ok: true,  seed: true }   → no required budget yet; the SOW may set it
//   { ok: true,  seed: false }  → total (and first-page budget, if set) match
//   { ok: false, required, total, target, message } → mismatch; condition stays open
async function checkSowBudget(appId, totalOrPayload, client = db) {
  const isPayload = totalOrPayload && typeof totalOrPayload === 'object';
  const total = isPayload ? toNum(totalOrPayload.total) : toNum(totalOrPayload);
  const target = isPayload ? firstPageBudget(totalOrPayload) : null;

  const required = await requiredRehabBudget(appId, client);
  if (required == null) return { ok: true, seed: true, required: null, total, target };

  const totalOk = total != null && eqCents(total, required);
  // The first-page construction budget is optional in the tool; only gate on it
  // when the SOW actually carries a positive number there. When present it must
  // match EXACTLY (owner-directed — "the exact total you start at originally").
  const targetSet = target != null && target > 0;
  const targetOk = !targetSet || eqCents(target, required);

  if (!totalOk || !targetOk) {
    // Cent-exact values + the exact gap, so a cents-level difference is VISIBLE
    // in the message instead of four identical dollar-rounded figures.
    let message;
    if (!totalOk && targetSet && !targetOk) {
      message = `The Scope of Work does not match the file's required rehab budget ${moneyExact(required)}. `
        + `Your first-page construction budget is ${moneyExact(target)} (${gapPhrase(target, required)} than required) `
        + `and the line items total ${moneyExact(total)} (${gapPhrase(total, required)} than required) — `
        + `both must equal ${moneyExact(required)} EXACTLY, to the cent, before this condition can clear. `
        + `The Scope of Work cannot change the loan's budget.`;
    } else if (!totalOk) {
      message = `The Scope of Work line-item total ${moneyExact(total)} is ${gapPhrase(total, required)} than the file's required rehab budget ${moneyExact(required)}. `
        + `They must match EXACTLY, to the cent — adjust the line items to total ${moneyExact(required)}. `
        + `The Scope of Work cannot change the loan's budget.`;
    } else {
      message = `The first-page construction budget ${moneyExact(target)} is ${gapPhrase(target, required)} than the file's required rehab budget ${moneyExact(required)}. `
        + `It must equal ${moneyExact(required)} EXACTLY, to the cent — the number you start at must match the loan's budget before this condition can clear.`;
    }
    return { ok: false, required, total, target, message };
  }
  return { ok: true, seed: false, required, total, target };
}

/**
 * The SIGN-OFF gate's budget agreement check (owner rule: first-page
 * construction budget, Scope of Work line-item total, file budget and
 * registered product budget must ALL agree to the cent before the rehab-budget
 * condition can be signed off). Centralized here (pure — no DB) so the
 * comparison, the PARSER and the message can never drift apart again:
 *   · every value is parsed with toNum (comma/"$"-tolerant — the sign-off gate
 *     used a raw Number() while the submit gate used toNum, so a formatted
 *     stored total could false-fire one gate and not the other);
 *   · the message prints every value AT CENT PRECISION and names exactly which
 *     number disagrees and by how much (owner-reported 2026-07-24: a cents-level
 *     gap displayed four identical "$120,000" figures with a mismatch error).
 * Returns null when everything agrees (or nothing is comparable yet), else the
 * plain-language refusal message.
 */
function budgetSignoffCheck(toolPayload, appRehabBudget, regInputs) {
  const sowTotal = toolPayload && toolPayload.total != null ? toNum(toolPayload.total) : null;
  if (sowTotal == null) return 'The Scope of Work / rehab budget has not been submitted yet.';
  const appParsed = toNum(appRehabBudget);
  const appBudget = appParsed != null ? appParsed : 0;
  const regBudget = regInputs && regInputs.rehabBudget != null ? toNum(regInputs.rehabBudget) : null;
  const fpTarget = firstPageBudget(toolPayload);
  const fpSet = fpTarget != null && fpTarget > 0;

  // Name each disagreeing pair explicitly, with the exact gap.
  const problems = [];
  if (!eqCents(sowTotal, appBudget)) problems.push(`the Scope of Work line-item total ${moneyExact(sowTotal)} is ${gapPhrase(sowTotal, appBudget)} than the file budget ${moneyExact(appBudget)}`);
  if (regBudget != null && !eqCents(appBudget, regBudget)) problems.push(`the file budget ${moneyExact(appBudget)} is ${gapPhrase(appBudget, regBudget)} than the registered product budget ${moneyExact(regBudget)}`);
  if (fpSet && !eqCents(fpTarget, appBudget)) problems.push(`the first-page construction budget ${moneyExact(fpTarget)} is ${gapPhrase(fpTarget, appBudget)} than the file budget ${moneyExact(appBudget)}`);
  if (!problems.length) return null;

  return `Budgets do not match to the cent — ${problems.join('; ')}. `
    + `Right now: first-page construction budget ${fpSet ? moneyExact(fpTarget) : '—'} · Scope of Work line-item total ${moneyExact(sowTotal)} · file budget ${moneyExact(appBudget)}${regBudget != null ? ` · registered product budget ${moneyExact(regBudget)}` : ''}. `
    + `They must ALL agree to the cent before sign-off: adjust the Scope of Work (start total + line items) or re-register the product so the numbers match.`;
}

/**
 * The durable [auto] note every SOW save stamps on the rehab-budget condition
 * (staff SOW tool, generic staff tool-submit, borrower submit — all three used
 * to hand-build this note with the whole-DOLLAR money() helper, so a cents-level
 * mismatch stamped a note showing identical figures on the condition card even
 * after the live refusal message was made cent-precise; audit finding 1 on the
 * 2026-07-24 cent-blind message fix). Built from the SAME cent-precise submit
 * message, so the note can never round away the gap it reports.
 *   mismatchMessage — checkSowBudget's message when it refused, else null/undefined
 *   contingencyOk   — checkSowContingency/checkGoldSow ok flag
 *   totalRaw        — the payload's line-item total (toNum-parsed here)
 */
function sowAutoNote(mismatchMessage, contingencyOk, totalRaw) {
  if (mismatchMessage) return '[auto] ' + mismatchMessage;
  if (!contingencyOk) return '[auto] ' + SOW_CONTINGENCY_MSG;
  return `[auto] Scope of Work totals ${moneyExact(toNum(totalRaw))} and matches the file's rehab budget — ready to clear.`;
}

// ---------------------------------------------------------------------------
// 5% Scope-of-Work contingency (owner-directed 2026-07-12; extended 2026-07-20)
//
// A file must carry a contingency of at least 5% of the construction (line-item)
// subtotal on its Scope of Work whenever EITHER:
//   · it is registered under the Gold Standard Program, OR
//   · its note buyer / capital partner is Blue Lake (applications.lender)
//     — owner-directed 2026-07-20: "if the note buyer is Blue Lake, the Scope of
//       Work construction budget condition should not clear till there's a 5%
//       contingency on the budget."
// The contingency lives WITHIN the frozen rehab budget (grand = subtotal +
// contingency + GC fee), so it never changes the budget — it's a composition
// requirement, enforced as a CONDITION gate exactly like the exact-match rule:
// the SOW always saves as a draft, but the rehab-budget condition can't be
// signed off (and is reopened when the requirement turns on) until the 5% is
// present.

const SOW_CONTINGENCY_PCT = 5;
const GOLD_CONTINGENCY_PCT = SOW_CONTINGENCY_PCT; // back-compat alias

// Borrower-SAFE, program/partner-AGNOSTIC wording. A note buyer name must NEVER
// reach a borrower (this notice can surface on the borrower SOW save), so it
// never says "Gold" or "Blue Lake" — just that the loan requires the 5%.
const SOW_CONTINGENCY_MSG =
  'This loan requires at least a 5% contingency on the construction Scope of Work budget. '
  + 'Add a contingency of 5% or more (the builder auto-fills 5%) before this condition can be signed off. '
  + 'Your work is saved — reopen the Scope of Work any time to add it.';
// Back-compat: every existing caller of GOLD_CONTINGENCY_MSG now emits the
// generic, borrower-safe text (same constant used to STAMP and to CLEAR the
// [auto] note, so the note round-trips).
const GOLD_CONTINGENCY_MSG = SOW_CONTINGENCY_MSG;

// The exact legacy Gold [auto] note text (stamped by the old code / db/070),
// kept ONLY so enforceSowContingency can still recognize and CLEAR a pre-existing
// reopen on downgrade even though the live message text changed.
const LEGACY_GOLD_NOTE =
  '[auto] The Gold Standard Program requires at least a 5% contingency on the construction Scope of Work budget. '
  + 'Add a contingency of 5% or more (the builder auto-fills 5% for Gold files) before this condition can be signed off. '
  + 'Your work is saved — reopen the Scope of Work any time to add it.';

// Does this file require the 5% SOW contingency? True when it is registered Gold
// OR its note buyer is Blue Lake. Returns { required, reason, reasons, program,
// lender } — `reason` is the first matching trigger for callers that want one.
async function sowContingencyRequired(appId, client = db) {
  const { normNoteBuyer } = require('./conditions/field-registry');
  let program = null, lender = null;
  try {
    const pr = (await client.query(
      `SELECT program FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0];
    program = pr ? pr.program : null;
  } catch (_) { /* no registration */ }
  try {
    const a = (await client.query(`SELECT lender FROM applications WHERE id=$1`, [appId])).rows[0];
    lender = a ? a.lender : null;
  } catch (_) { /* file gone */ }
  const isGold = /gold/i.test(String(program || ''));
  const isBlueLake = normNoteBuyer(lender) === 'bluelake';
  const reasons = [];
  if (isGold) reasons.push('gold');
  if (isBlueLake) reasons.push('bluelake');
  return { required: isGold || isBlueLake, reason: reasons[0] || null, reasons, program, lender };
}

// Extract the construction subtotal and contingency amount from a saved SOW
// payload. The tool submits both amounts directly; older payloads are derived
// from state.cont (pct mode only — an amount-mode legacy payload is unknowable
// without the frozen line-item engine, so it reads as null and fails closed).
function sowContingency(payload) {
  if (!payload || typeof payload !== 'object') return { subtotal: null, contingency: null };
  let subtotal = payload.subtotal != null ? toNum(payload.subtotal) : null;
  let contingency = payload.contingency != null ? toNum(payload.contingency) : null;
  const st = payload.state && typeof payload.state === 'object' ? payload.state : null;
  const cont = st && st.cont && typeof st.cont === 'object' ? st.cont : null;
  if (contingency == null && cont && cont.mode === 'pct' && subtotal != null) {
    contingency = subtotal * (toNum(cont.value) || 0) / 100;
  }
  return { subtotal, contingency, cont };
}

// PURE — the SOW contingency as a PERCENT of the construction subtotal (one
// decimal), or null when it can't be computed (no/zero subtotal, or an
// unknowable amount-mode legacy payload). Used by the investor-guideline overlay
// to evaluate a note buyer's contingency-CAP guideline (which checks a MAX %)
// against the file's actual SOW instead of falling back to "to verify". Never throws.
function sowContingencyPct(payload) {
  try {
    const { subtotal, contingency } = sowContingency(payload);
    if (subtotal == null || !(subtotal > 0) || contingency == null) return null;
    return Math.round((contingency / subtotal) * 1000) / 10;
  } catch (_e) { return null; }
}

// True when the SOW carries a >= 5% contingency. A pct-mode contingency of >= 5
// is 5%-of-subtotal by definition; otherwise compare the amounts (½-dollar
// tolerance for float noise). Unknowable composition → false (fail closed).
function goldContingencyOk(payload) {
  const info = sowContingency(payload);
  // Real dollar amounts are AUTHORITATIVE: when a construction subtotal is present,
  // the contingency (explicit, or pct-mode × subtotal — both resolved by
  // sowContingency) must actually be >= 5% of it. Never accept a self-declared
  // "pct mode 5%" flag the numbers don't back up — a crafted payload could claim
  // pct-mode 5 with $0 real contingency and slip past (audit #57, 2026-07-17).
  if (info.subtotal != null && info.subtotal > 0) {
    return info.contingency != null && info.contingency + 0.5 >= (GOLD_CONTINGENCY_PCT / 100) * info.subtotal;
  }
  // Only a legacy pct-only payload with NO usable subtotal falls back to the claim.
  if (info.cont && info.cont.mode === 'pct' && (toNum(info.cont.value) || 0) + 1e-9 >= GOLD_CONTINGENCY_PCT) return true;
  return false;
}

// Requirement-aware SOW check: when the file requires the 5% contingency (Gold
// OR Blue Lake note buyer) the SOW must carry it. Returns { ok, required,
// reason, program, message }. A file with no requirement always passes here.
async function checkSowContingency(appId, payload, client = db) {
  const req = await sowContingencyRequired(appId, client);
  if (!req.required) return { ok: true, required: false, reason: null, program: req.program };
  if (goldContingencyOk(payload)) return { ok: true, required: true, reason: req.reason, program: req.program };
  return { ok: false, required: true, reason: req.reason, program: req.program, message: SOW_CONTINGENCY_MSG };
}
// Back-compat name (used by the SOW save endpoints + register paths).
const checkGoldSow = checkSowContingency;

// Called after the file's requirement inputs change (a product (re)register, a
// note-buyer change, a ClickUp pull). When the file REQUIRES the 5% contingency
// (Gold OR Blue Lake note buyer) and its saved SOW lacks it, REOPEN the
// rehab-budget condition — clearing any prior sign-off — and stamp a FATAL
// [auto] note. When the file NO LONGER requires it (downgrade / note buyer
// changed away), clear the stale [auto] reopen this function stamped so the
// condition isn't stuck showing a requirement that no longer applies. A human's
// own note is never touched. Idempotent.
async function enforceSowContingency(appId, client = db) {
  try {
    const req = await sowContingencyRequired(appId, client);
    if (!req.required) {
      // No requirement anymore: roll our [auto] reopen back (issue→received) and
      // clear the note. Match BOTH the current generic note AND the legacy Gold
      // note text so a pre-existing Gold reopen is cleared too. Only OUR [auto]
      // notes are matched — a human's note is never cleared here.
      const cleared = await client.query(
        `UPDATE checklist_items
            SET status = CASE WHEN status='issue' THEN 'received' ELSE status END,
                notes = NULL, updated_at = now()
          WHERE application_id=$1 AND tool_key='rehab_budget'
            AND notes = ANY($2::text[])
          RETURNING id`, [appId, ['[auto] ' + SOW_CONTINGENCY_MSG, LEGACY_GOLD_NOTE]]);
      return { changed: cleared.rowCount > 0, cleared: cleared.rowCount > 0, required: false, program: req.program };
    }
    const it = (await client.query(
      `SELECT id, status, tool_payload, signed_off_at FROM checklist_items
        WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0];
    if (!it) return { changed: false, required: true, reason: req.reason, program: req.program };
    if (goldContingencyOk(it.tool_payload)) return { changed: false, required: true, reason: req.reason, program: req.program, ok: true };
    const note = '[auto] ' + SOW_CONTINGENCY_MSG;
    await client.query(
      `UPDATE checklist_items
          SET status='issue', signed_off_at=NULL, signed_off_by=NULL,
              reviewed_at=NULL, reviewed_by=NULL,
              notes=CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END,
              updated_at=now()
        WHERE id=$1`, [it.id, note]);
    return { changed: true, reopened: true, required: true, reason: req.reason, program: req.program };
  } catch (e) {
    console.error('[rehab-budget] enforceSowContingency failed', appId, e && e.message);
    return { changed: false, error: e && e.message };
  }
}
// Back-compat name (used by the register paths + the gold-contingency test).
const enforceGoldSowContingency = enforceSowContingency;

module.exports = {
  requiredRehabBudget, checkSowBudget, firstPageBudget, money, eqCents, toNum,
  moneyExact, gapPhrase, budgetSignoffCheck, sowAutoNote,
  sowContingency, sowContingencyPct, goldContingencyOk,
  sowContingencyRequired, checkSowContingency, enforceSowContingency,
  checkGoldSow, enforceGoldSowContingency,
  SOW_CONTINGENCY_PCT, SOW_CONTINGENCY_MSG,
  GOLD_CONTINGENCY_PCT, GOLD_CONTINGENCY_MSG,
};

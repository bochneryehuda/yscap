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

// Parse a possibly-formatted money value ("75,000", "$75000.50", 75000) → number
// or null when there's nothing usable.
function toNum(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
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
    let message;
    if (!totalOk && targetSet && !targetOk) {
      message = `The Scope of Work does not match the file's required rehab budget ${money(required)}. `
        + `Your first-page construction budget is ${money(target)} and the line items total ${money(total)} — `
        + `both must equal ${money(required)} EXACTLY before this condition can clear. `
        + `The Scope of Work cannot change the loan's budget.`;
    } else if (!totalOk) {
      message = `The Scope of Work line-item total ${money(total)} does not match the file's required rehab budget ${money(required)}. `
        + `They must match EXACTLY — adjust the line items to total ${money(required)}. `
        + `The Scope of Work cannot change the loan's budget.`;
    } else {
      message = `The first-page construction budget ${money(target)} does not match the file's required rehab budget ${money(required)}. `
        + `It must equal ${money(required)} EXACTLY — the number you start at must match the loan's budget before this condition can clear.`;
    }
    return { ok: false, required, total, target, message };
  }
  return { ok: true, seed: false, required, total, target };
}

// ---------------------------------------------------------------------------
// Gold Standard Program — 5% Scope-of-Work contingency (owner-directed 2026-07-12)
//
// A file registered under the Gold Standard Program must carry a contingency of
// at least 5% of the construction (line-item) subtotal on its Scope of Work. The
// contingency lives WITHIN the frozen rehab budget (grand = subtotal +
// contingency + GC fee), so it never changes the budget — it's a composition
// requirement, enforced as a CONDITION gate exactly like the exact-match rule:
// the SOW always saves as a draft, but the rehab-budget condition can't be
// signed off (and is reopened on Gold registration) until the 5% is present.

const GOLD_CONTINGENCY_PCT = 5;
const GOLD_CONTINGENCY_MSG =
  'The Gold Standard Program requires at least a 5% contingency on the construction Scope of Work budget. '
  + 'Add a contingency of 5% or more (the builder auto-fills 5% for Gold files) before this condition can be signed off. '
  + 'Your work is saved — reopen the Scope of Work any time to add it.';

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

// Program-aware SOW check: on a Gold file the SOW must carry the 5% contingency.
// Returns { ok, program, message }. Non-Gold files always pass here.
async function checkGoldSow(appId, payload, client = db) {
  let program = null;
  try {
    const r = await client.query(
      `SELECT program FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    program = r.rows[0] ? r.rows[0].program : null;
  } catch (_) {}
  if (!/gold/i.test(String(program || ''))) return { ok: true, program };
  if (goldContingencyOk(payload)) return { ok: true, program };
  return { ok: false, program, message: GOLD_CONTINGENCY_MSG };
}

// Called after a product is (re)registered. When the file is Gold and its saved
// SOW lacks the 5% contingency, REOPEN the rehab-budget condition — clearing any
// prior sign-off — and stamp a FATAL [auto] note. This is what makes "even if the
// condition was already signed off, registering Gold reopens it" work. Non-Gold
// registration never disturbs the condition here. Idempotent.
async function enforceGoldSowContingency(appId, client = db) {
  try {
    const pr = (await client.query(
      `SELECT program FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0];
    if (!pr || !/gold/i.test(String(pr.program || ''))) {
      // Non-Gold (including a Gold→Standard downgrade): the 5% contingency rule no
      // longer applies, so clear any stale Gold reopen this function stamped —
      // otherwise the rehab-budget condition stays stuck at 'issue' showing a
      // Gold-only requirement on a Standard file. Only rows whose note is EXACTLY
      // the Gold [auto] note are touched (a human's note is never overwritten by
      // the reopen, so it's never cleared here); the reopen's status is rolled
      // back to 'received' so an underwriter can sign off normally.
      const goldNote = '[auto] ' + GOLD_CONTINGENCY_MSG;
      const cleared = await client.query(
        `UPDATE checklist_items
            SET status = CASE WHEN status='issue' THEN 'received' ELSE status END,
                notes = NULL, updated_at = now()
          WHERE application_id=$1 AND tool_key='rehab_budget' AND notes = $2
          RETURNING id`, [appId, goldNote]);
      return { changed: cleared.rowCount > 0, cleared: cleared.rowCount > 0, program: pr && pr.program };
    }
    const it = (await client.query(
      `SELECT id, status, tool_payload, signed_off_at FROM checklist_items
        WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0];
    if (!it) return { changed: false, program: pr.program };
    if (goldContingencyOk(it.tool_payload)) return { changed: false, program: pr.program, ok: true };
    const note = '[auto] ' + GOLD_CONTINGENCY_MSG;
    await client.query(
      `UPDATE checklist_items
          SET status='issue', signed_off_at=NULL, signed_off_by=NULL,
              reviewed_at=NULL, reviewed_by=NULL,
              notes=CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END,
              updated_at=now()
        WHERE id=$1`, [it.id, note]);
    return { changed: true, reopened: true, program: pr.program };
  } catch (e) {
    console.error('[rehab-budget] enforceGoldSowContingency failed', appId, e && e.message);
    return { changed: false, error: e && e.message };
  }
}

module.exports = {
  requiredRehabBudget, checkSowBudget, firstPageBudget, money, eqCents, toNum,
  sowContingency, goldContingencyOk, checkGoldSow, enforceGoldSowContingency,
  GOLD_CONTINGENCY_PCT, GOLD_CONTINGENCY_MSG,
};

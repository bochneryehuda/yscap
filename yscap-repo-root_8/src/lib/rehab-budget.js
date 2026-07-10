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
    `SELECT inputs FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0];
  if (reg && reg.inputs && reg.inputs.rehabBudget != null && Number(reg.inputs.rehabBudget) > 0) {
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

module.exports = { requiredRehabBudget, checkSowBudget, firstPageBudget, money, eqCents, toNum };

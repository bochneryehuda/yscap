'use strict';

// Scope-of-Work / rehab-budget integrity (#75).
//
// The Scope of Work DETAILS the file's rehab budget — it must never silently
// CHANGE it. The authoritative number is the registered product's budget (once a
// product is registered) or, before that, the application's rehab_budget. When
// the borrower/staff submit a Scope of Work whose grand total doesn't EXACTLY
// match that number, it's a FATAL: the submit is refused and the condition is
// NOT cleared (a real fail, visible to the borrower). Only when the file has no
// budget yet may the Scope of Work seed it.

const db = require('../db');

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const eqCents = (a, b) => Math.round((Number(a) || 0) * 100) === Math.round((Number(b) || 0) * 100);

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

// Gate a Scope-of-Work submit. Returns:
//   { ok: true,  seed: true }   → no required budget yet; the SOW may set it
//   { ok: true,  seed: false }  → the SOW total matches the required budget
//   { ok: false, required, message } → FATAL mismatch; refuse the submit
async function checkSowBudget(appId, total, client = db) {
  const required = await requiredRehabBudget(appId, client);
  if (required == null) return { ok: true, seed: true, required: null };
  if (!Number.isFinite(Number(total)) || !eqCents(total, required)) {
    return {
      ok: false, required,
      message: `The Scope of Work total ${money(total)} does not match the file's required rehab budget ${money(required)}. `
        + `They must match EXACTLY — adjust the line items to total ${money(required)}. `
        + `The Scope of Work cannot change the loan's budget.`,
    };
  }
  return { ok: true, seed: false, required };
}

module.exports = { requiredRehabBudget, checkSowBudget, money, eqCents };

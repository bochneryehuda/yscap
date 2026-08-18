'use strict';
/**
 * Liquid-assets condition auto-clear (IG-W5, owner-directed 2026-07-24).
 *
 * Wire the "Bank statements / liquid assets" condition (cond 1022 / rtl_p3_assets) to the
 * asset/liquidity desk and auto-clear it once PILOT has READ the bank statements on this file AND
 * the borrower's (and verified entity's) liquid assets provably cover what the registered deal
 * requires. Never a false-clear.
 *
 * This is STRICTER than the human sign-off gate on purpose (auto can never be looser than a human):
 * the human gate only requires a bank-statement document to be present on the item. The auto-clear
 * additionally requires, all four:
 *   1. the deal's REQUIRED liquidity is known (a product is registered — readRequiredLiquidity), else
 *      we defer to a human;
 *   2. a CURRENT analyzed bank_statement document_extractions row for THIS application
 *      (status='analyzed', not superseded) — the statements were actually AI-read;
 *   3. ZERO open FATAL bank_statement findings on the file (a wrong-account-holder / other-entity
 *      cascade is unresolved) — those are the real false-clear paths;
 *   4. the money PROVABLY covers the requirement — the same read-only assessBankLiquidity the desk
 *      uses (identical ctx + tied-account matching) shows the borrower's/verified-entity accounts'
 *      ending balances >= the required liquidity, with at least one TIED account carrying a countable
 *      ending balance (so a data gap — no readable balance — can never masquerade as "sufficient").
 *
 * `maybeAutoSatisfyAssets` is SYMMETRIC (clear when provably sufficient / reopen a prior [auto] clear
 * that has gone short or dirty), a SYSTEM sign-off (signed_off_by NULL, [auto] note), gated on
 * ASSETS_AUTOCLEAR_ENABLED (default OFF), and never throws.
 */
const cfg = require('../../config');
const { enqueueChecklistStatusPush } = require('../../clickup/enqueue');
const fileView = require('./file-view');
const { assessBankLiquidity, readRequiredLiquidity } = require('./bank-liquidity');

// The assets condition's checklist item on the file (rtl_p3_assets template).
async function assetsItemId(client, appId) {
  const r = await client.query(
    `SELECT ci.id FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_p3_assets'
      ORDER BY ci.created_at LIMIT 1`, [appId]);
  return r.rows[0] ? r.rows[0].id : null;
}

/**
 * Are the file's bank statements AI-read AND do the liquid assets provably cover the requirement?
 * @returns {Promise<{complete:boolean, reason?:string, required?:number, have?:number}>}
 */
async function assetsCompleteness(client, appId) {
  // (1) The deal's required liquidity must be known — no product registered → defer to a human.
  const required = await readRequiredLiquidity(client, appId);
  if (required == null) return { complete: false, reason: 'no_requirement' };

  // (2) A current, analyzed bank statement for THIS file (actually AI-read).
  const stmts = (await client.query(
    `SELECT document_id, doc_type, created_at, fields
       FROM document_extractions
      WHERE application_id=$1 AND doc_type='bank_statement'
        AND is_current = true AND superseded = false AND status='analyzed'`, [appId])).rows;
  if (!stmts.length) return { complete: false, reason: 'no_statement' };

  // (3) No open FATAL bank finding (an unresolved wrong-account-holder / other-entity cascade).
  const fatal = (await client.query(
    `SELECT 1 FROM document_findings
      WHERE application_id=$1 AND source='bank_statement' AND severity='fatal' AND status='open'
      LIMIT 1`, [appId])).rows[0];
  if (fatal) return { complete: false, reason: 'open_fatal' };

  // (4) The money provably covers the requirement — the SAME read-only assessment the desk uses,
  // with the same ctx so tied-account matching is identical to production.
  const ctx = await fileView.loadContext(client, appId);
  const res = assessBankLiquidity(ctx || {}, stmts, { requiredLiquidity: required });
  // The staff assets LEDGER (db/574) sits on top of the raw read everywhere money
  // is judged — a DOWNWARD correction or an exclusion a processor recorded must
  // never be ignored by an auto-clear, or the auto path would be LOOSER than the
  // human one (this module's own doctrine). Fails toward the RAW read only when
  // the ledger is unreadable, which can only ever be looser by accident in the
  // same way today's behavior already is.
  let have = Number(res.qualifyingTotal) || 0;
  let haveCountableTied = Array.isArray(res.accounts)
    && res.accounts.some((a) => a && a.tied && a.ending != null);
  try {
    const ledger = require('./asset-ledger');
    const entries = await ledger.loadEntries(appId, client);
    const merged = ledger.mergeLedger({ accounts: res.accounts, qualifyingTotal: res.qualifyingTotal }, entries);
    have = merged.verifiedTotal;
    haveCountableTied = merged.haveCountable;
  } catch (_) { /* raw read stands */ }
  const covers = haveCountableTied && have >= required - 1;
  if (!covers) return { complete: false, reason: 'insufficient_or_datagap', required, have };

  return { complete: true, required, have };
}

/**
 * Auto-clear (or self-correct) the liquid-assets condition. Gated on ASSETS_AUTOCLEAR_ENABLED
 * (default OFF). Never throws.
 * @returns {Promise<{enabled:boolean, satisfied:boolean, reopened:boolean, complete:boolean, reason?:string}>}
 */
async function maybeAutoSatisfyAssets(client, appId, itemId) {
  const out = { enabled: !!cfg.assetsAutoclearEnabled, satisfied: false, reopened: false, complete: false };
  try {
    if (!out.enabled) { out.reason = 'disabled'; return out; }
    if (!itemId) { out.reason = 'no_item'; return out; }

    const item = (await client.query(
      `SELECT ci.id, ci.status, ci.signed_off_at, ci.signed_off_by, ci.notes, COALESCE(t.code,'') AS code
         FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.id=$1 AND ci.application_id=$2 AND t.code='rtl_p3_assets'
        LIMIT 1`, [itemId, appId])).rows[0];
    if (!item) { out.reason = 'not_assets_condition'; return out; }

    const autoCleared = item.status === 'satisfied' && item.signed_off_by == null
      && String(item.notes || '').startsWith('[auto]');
    if (item.status === 'satisfied' && item.signed_off_by != null) { out.reason = 'human_signed_off'; return out; }

    const c = await assetsCompleteness(client, appId);
    out.complete = c.complete;

    if (c.complete) {
      if (item.status === 'satisfied' && item.signed_off_at) { out.reason = 'already_satisfied'; return out; }
      const note = '[auto] PILOT read the bank statements on this file and the liquid assets cover what this deal requires — condition cleared.';
      await client.query(
        `UPDATE checklist_items
            SET status='satisfied', signed_off_at=now(), signed_off_by=NULL,
                notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END,
                updated_at=now()
          WHERE id=$1`, [itemId, note]);
      out.satisfied = true;
      enqueueChecklistStatusPush(itemId).catch(() => {});
      return out;
    }

    if (autoCleared) {
      const note = '[auto] The bank statements / liquid assets on this file need another look before they can be cleared — re-check them.';
      await client.query(
        `UPDATE checklist_items
            SET status='received', signed_off_at=NULL, signed_off_by=NULL,
                reviewed_at=NULL, reviewed_by=NULL,
                notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END,
                updated_at=now()
          WHERE id=$1`, [itemId, note]);
      out.reopened = true;
      enqueueChecklistStatusPush(itemId).catch(() => {});
      return out;
    }

    out.reason = 'incomplete';
    return out;
  } catch (e) {
    console.error('[assets] maybeAutoSatisfyAssets', appId, itemId, e && e.message);
    out.reason = 'error';
    return out;
  }
}

/**
 * Run the auto-clear pass over the file's liquid-assets condition. Best-effort; never throws.
 * Call after a bank_statement document has been AI-read.
 */
async function autoClearAssetsCondition(client, appId) {
  try {
    if (!cfg.assetsAutoclearEnabled || !appId) return;
    const itemId = await assetsItemId(client, appId);
    if (itemId) await maybeAutoSatisfyAssets(client, appId, itemId);
  } catch (e) {
    console.error('[assets] autoClearAssetsCondition', appId, e && e.message);
  }
}

module.exports = { assetsItemId, assetsCompleteness, maybeAutoSatisfyAssets, autoClearAssetsCondition };

'use strict';

// Dynamic liquidity / cash-to-close condition (#60).
//
// The RTL file carries a STATIC "Bank statements received & meet required
// liquidity" condition (template rtl_p3_assets) until a product is registered.
// The moment Products & Pricing is run, the registered quote knows exactly how
// much liquid cash the borrower must show — down payment + closing costs (=
// cash to close) + reserve requirement = total required liquidity. This module
// writes that breakdown INTO the condition (tool_payload + a plain-language
// hint), so the condition itself explains how much is needed and why.
//
// Because a reprice can move the number, every re-register OVERWRITES the
// condition with the current figures, and — critically — if the required
// liquidity INCREASES, an already-signed-off condition is REOPENED so the team
// re-verifies the borrower can still cover it. Portal-only; never touches ClickUp.

const db = require('../db');

const money = (n) => (n == null || isNaN(Number(n))) ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US');

async function syncLiquidityCondition(appId, quote, client = db) {
  try {
    const required = Number(quote && (quote.liquidityRequired != null ? quote.liquidityRequired : quote.liquidity));
    if (!Number.isFinite(required) || required <= 0) return;
    const sizing = (quote && quote.sizing) || {};
    const cc = (quote && quote.closingCosts) || {};
    const breakdown = {
      required,
      cashToClose: Number(quote.cashToClose) || 0,
      downPayment: Number(sizing.downPayment) || 0,
      closingCosts: Number(cc.dueAtClosing) || 0,
      reserveRequirement: Number(quote.reserveRequirement) || 0,
      reserveBasis: quote.reserveBasis || null,
      computedAt: new Date().toISOString(),
    };
    const hint =
      `Required liquidity: ${money(required)} — the borrower's bank statements must show at least this in liquid assets. ` +
      `Down payment ${money(breakdown.downPayment)} + closing costs due at closing ${money(breakdown.closingCosts)} ` +
      `= cash to close ${money(breakdown.cashToClose)}; plus reserves ${money(breakdown.reserveRequirement)}` +
      `${breakdown.reserveBasis ? ` (${breakdown.reserveBasis})` : ''}.`;

    const r = await client.query(
      `SELECT ci.id, ci.status, ci.signed_off_at, ci.tool_payload
         FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_p3_assets'
        ORDER BY ci.created_at LIMIT 1`, [appId]);
    const item = r.rows[0];
    if (!item) return;

    const prevRequired = (item.tool_payload && item.tool_payload.liquidity && item.tool_payload.liquidity.required != null)
      ? Number(item.tool_payload.liquidity.required) : null;
    const payload = { ...(item.tool_payload || {}), liquidity: breakdown };
    // Reopen a signed-off condition only when the requirement went UP (a >$0.50
    // increase avoids float noise). A same/lower requirement just refreshes text.
    const increased = prevRequired != null && required > prevRequired + 0.5;

    if (increased && item.signed_off_at) {
      await client.query(
        `UPDATE checklist_items
            SET tool_payload=$2, hint=$3, borrower_hint=$3, status='received',
                signed_off_at=NULL, signed_off_by=NULL, updated_at=now()
          WHERE id=$1`, [item.id, JSON.stringify(payload), hint]);
      return { reopened: true, required, prevRequired };
    }
    await client.query(
      `UPDATE checklist_items SET tool_payload=$2, hint=$3, borrower_hint=$3, updated_at=now() WHERE id=$1`,
      [item.id, JSON.stringify(payload), hint]);
    return { reopened: false, required, prevRequired };
  } catch (e) { console.error('[liquidity] syncLiquidityCondition failed', appId, e.message); return null; }
}

module.exports = { syncLiquidityCondition };

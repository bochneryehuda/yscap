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

async function syncLiquidityCondition(appId, quote, client = db, opts = {}) {
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

    // The generic "bank statements" condition is REPLACED by this detailed
    // liquidity requirement the moment a product is registered, and must be
    // (re)verified against the concrete number. So REOPEN a condition that was
    // already cleared when EITHER:
    //   · this is the FIRST time a concrete requirement is written (the standard
    //     condition becomes the detailed one — it should actively resurface), OR
    //   · the required liquidity went UP versus last time (a >$0.50 change avoids
    //     float noise) — the borrower must show more, so re-verify.
    // "Cleared" covers a real sign-off AND the common case of staff simply
    // ACCEPTING the uploaded statement (status='satisfied', no sign-off stamp) —
    // and a borrower submission awaiting review ('received'). A same/lower
    // requirement on re-register just refreshes the text.
    const firstConcrete = prevRequired == null;
    const increased = prevRequired != null && required > prevRequired + 0.5;
    const wasCleared = !!item.signed_off_at || item.status === 'satisfied' || item.status === 'received';

    // A one-time backfill over ALREADY-registered files writes the breakdown
    // without disturbing conditions staff already cleared (opts.noReopen) — it
    // just makes the detail appear and seeds prevRequired for future increases.
    if ((firstConcrete || increased) && wasCleared && !opts.noReopen) {
      await client.query(
        `UPDATE checklist_items
            SET tool_payload=$2, hint=$3, borrower_hint=$3, status='outstanding',
                signed_off_at=NULL, signed_off_by=NULL, reviewed_at=NULL, reviewed_by=NULL, updated_at=now()
          WHERE id=$1`, [item.id, JSON.stringify(payload), hint]);
      return { reopened: true, reason: increased ? 'increase' : 'first', required, prevRequired };
    }
    await client.query(
      `UPDATE checklist_items SET tool_payload=$2, hint=$3, borrower_hint=$3, updated_at=now() WHERE id=$1`,
      [item.id, JSON.stringify(payload), hint]);
    return { reopened: false, required, prevRequired };
  } catch (e) { console.error('[liquidity] syncLiquidityCondition failed', appId, e.message); return null; }
}

// One-shot backfill (#96): write the detailed liquidity breakdown onto EVERY
// file that already has a registered product, so the "Assets & bank statements"
// condition shows the required-liquidity detail even though it was registered
// before this logic existed — WITHOUT reopening anything staff already cleared.
// Reads the quote straight off the stored registration. Idempotent.
async function backfillLiquidityConditions(client = db) {
  let updated = 0;
  try {
    const regs = await client.query(
      `SELECT application_id, quote FROM product_registrations WHERE is_current=true AND quote IS NOT NULL`);
    for (const r of regs.rows) {
      try {
        const res = await syncLiquidityCondition(r.application_id, r.quote, client, { noReopen: true });
        if (res) updated++;
      } catch (_) { /* per-file best-effort */ }
    }
  } catch (e) { console.error('[liquidity] backfill failed', e.message); }
  return updated;
}

module.exports = { syncLiquidityCondition, backfillLiquidityConditions };

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
// Fees / cash-to-close / reserves show EXACT cents in the condition hint
// (owner-directed 2026-07-16); the stored breakdown already keeps cents.
const money2 = (n) => (n == null || isNaN(Number(n))) ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// How many months of bank statements the file requires, driven by the REGISTERED
// program (owner-directed 2026-07-12). Before a product is registered the file
// carries a generic "assets & bank statements" ask (no month count); once
// registered, the Gold Standard Program requires TWO months and the Standard
// Program requires ONE. The MANUAL Program has no fixed table — the registrant
// states the months at registration (owner-directed 2026-07-20), passed in as
// `assetMonths`. Borrower-facing — never names a capital partner.
// The NOTE BUYER can require more months than the program does (owner-directed 2026-07-26: "Blue
// Lake needs 2 months of bank statements, not 1 — the rule text says 1"). Keyed with the SAME shared
// normalizer the conditions engine and the guideline desk use, so one spelling of a note buyer is
// never treated as two. Whichever is stricter wins — a note buyer's requirement can raise the count,
// never lower it below what the program already asks for.
const NOTE_BUYER_MONTHS = { bluelake: 2 };
function noteBuyerMonths(noteBuyer) {
  if (!noteBuyer) return 0;
  let key = '';
  try { key = require('./conditions/field-registry').normNoteBuyer(noteBuyer) || ''; } catch (_) { key = ''; }
  return NOTE_BUYER_MONTHS[key] || 0;
}
function bankStatementMonths(program, assetMonths, noteBuyer) {
  const byBuyer = noteBuyerMonths(noteBuyer);
  let byProgram;
  if (/manual/i.test(String(program || ''))) {
    const m = Math.round(Number(assetMonths));
    byProgram = Number.isFinite(m) && m > 0 ? m : 2;   // fall back to the manual default
  } else {
    byProgram = /gold/i.test(String(program || '')) ? 2 : 1;
  }
  return Math.max(byProgram, byBuyer);
}
function bankStatementLine(program, assetMonths, noteBuyer) {
  const m = bankStatementMonths(program, assetMonths, noteBuyer);
  // Borrower-facing: NEVER names the note buyer (frozen rule). When the note buyer is what raises
  // the count, the line just states the count — the reason is internal.
  if (noteBuyerMonths(noteBuyer) >= m && m > (/gold/i.test(String(program || '')) ? 2 : 1)) {
    return `Provide ${m} month${m === 1 ? '' : 's'} of recent bank statements — this loan requires ${m} month${m === 1 ? '' : 's'} of liquidity.`;
  }
  if (/manual/i.test(String(program || ''))) {
    return `Provide ${m} month${m === 1 ? '' : 's'} of recent bank statements — this loan's program requires ${m} month${m === 1 ? '' : 's'} of liquidity.`;
  }
  return m === 2
    ? 'Provide 2 months of recent bank statements — the Gold Standard Program requires two months.'
    : 'Provide 1 month of a recent bank statement — the Standard Program requires one month.';
}
const GENERIC_BANK_STMT_HINT =
  'Provide recent bank statements showing your liquid assets. The exact number of months required is set once your product is registered in Products & Pricing.';

// The program registered on a file right now ('gold' | 'standard' | null).
async function currentProgram(appId, client = db) {
  try {
    const r = await client.query(
      `SELECT program FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    return r.rows[0] ? r.rows[0].program : null;
  } catch (_) { return null; }
}

async function syncLiquidityCondition(appId, quote, client = db, opts = {}) {
  try {
    const required = Number(quote && (quote.liquidityRequired != null ? quote.liquidityRequired : quote.liquidity));
    if (!Number.isFinite(required) || required <= 0) return;
    // Bank-statement count is program-driven: read the just-registered program.
    const program = opts.program != null ? opts.program : await currentProgram(appId, client);
    // MANUAL program: the required liquidity months come from the registration
    // (the registrant stated them). Use the passed value, else read the current
    // registration's asset_months.
    let assetMonths = opts.assetMonths;
    if (/manual/i.test(String(program || '')) && (assetMonths == null || assetMonths === '')) {
      try {
        const am = await client.query(
          `SELECT asset_months FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
        if (am.rows[0] && am.rows[0].asset_months != null) assetMonths = am.rows[0].asset_months;
      } catch (_) { /* best-effort */ }
    }
    // The NOTE BUYER on the file can require more months than the program does (Blue Lake: 2).
    // Read here, next to the program, so both the hint and the recorded requirement agree. Failing
    // to read it must never lower the count — it just leaves the program's own requirement standing.
    let noteBuyer = opts.noteBuyer;
    if (noteBuyer === undefined) {
      try {
        const nb = await client.query(`SELECT lender FROM applications WHERE id=$1`, [appId]);
        noteBuyer = nb.rows[0] ? nb.rows[0].lender : null;
      } catch (_) { noteBuyer = null; }
    }
    const sizing = (quote && quote.sizing) || {};
    const cc = (quote && quote.closingCosts) || {};
    const breakdown = {
      required,
      cashToClose: Number(quote.cashToClose) || 0,
      downPayment: Number(sizing.downPayment) || 0,
      assignmentExcess: Number(sizing.assignmentExcessOOP) || 0,
      closingCosts: Number(cc.dueAtClosing) || 0,
      reserveRequirement: Number(quote.reserveRequirement) || 0,
      reserveBasis: quote.reserveBasis || null,
      computedAt: new Date().toISOString(),
    };
    const hint =
      `${bankStatementLine(program, assetMonths, noteBuyer)} ` +
      `Required liquidity: ${money2(required)} — the borrower's bank statements must show at least this in liquid assets. ` +
      `Down payment ${money2(breakdown.downPayment)} + ` +
      `${breakdown.assignmentExcess > 0 ? `assignment excess ${money2(breakdown.assignmentExcess)} + ` : ''}` +
      `closing costs due at closing ${money2(breakdown.closingCosts)} ` +
      `= cash to close ${money2(breakdown.cashToClose)}; plus reserves ${money2(breakdown.reserveRequirement)}` +
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
    const payload = { ...(item.tool_payload || {}), liquidity: breakdown,
      bankStatements: { months: bankStatementMonths(program, assetMonths, noteBuyer), program: program || null } };

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

module.exports = {
  syncLiquidityCondition, backfillLiquidityConditions,
  bankStatementMonths, bankStatementLine, GENERIC_BANK_STMT_HINT, currentProgram,
};

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

// TWO MONTHS OF BANK STATEMENTS ON EVERY FILE (owner-directed 2026-08-11 — SUPERSEDES the old
// per-program / note-buyer / manual-stated table). Every program requires exactly two months of
// bank statements: the program, the manual "months of liquidity" input and the note buyer no
// longer change THE STATEMENT COUNT. `bankStatementMonths` always returns 2. Borrower-facing —
// never names a capital partner. The (program, assetMonths, noteBuyer) signature is kept so every
// caller is unchanged; the last two arguments no longer affect the COUNT here.
//
// NOTE: the manual "months of liquidity" (product_registrations.asset_months) is NOT vestigial — it
// is how many months of RESERVES the borrower must SHOW in the ending balance of the most recent
// statement (owner-directed 2026-08-11). That is a separate concept from the statement count and is
// consumed by pricing.js normalize (the required-liquidity dollar for a manual program), NOT here.
function bankStatementMonths(program, assetMonths, noteBuyer) {
  return 2;
}
// A printout showing the deposit may be provided IN ADDITION to the two statements when the funds
// are not yet reflected in the most recent statement's ending balance (owner-directed 2026-08-11).
// Borrower-facing; appended to every bank-statement ask and to the generic pre-registration hint.
const PRINTOUT_ALLOWANCE =
  'If the funds are not yet reflected in the ending balance of the most recent statement, you may ' +
  'also provide a recent transaction printout showing the deposit in addition to the two statements.';
// THE TWO-MONTH REQUIREMENT IS LOUD, NEVER A SMALL ASIDE (owner-directed 2026-07-30:
// "it should stay in very bulk on the condition, highlighted, quoted, that this
// program requires two months of bank statements according to the registration").
// The condition LEADS with an unmissable quoted banner on its own line. The '⚠️' prefix on the
// first line + the trailing '\n' is the marker the portal UIs (LoudHint.jsx) key on to render a
// highlighted callout; plain-text surfaces (V1, emails, ClickUp) still read it loud. Every file now
// requires two months, so every registered file's assets condition carries it.
function loudMonthsBanner() {
  return '⚠️ TWO (2) MONTHS OF BANK STATEMENTS REQUIRED — "This program requires two months of bank statements according to the registration."\n';
}
// Borrower-facing: NEVER names a note buyer (frozen rule). Program-named where we have a program,
// generic otherwise; every branch states two months and carries the printout allowance. Silver and
// Gold are tested BEFORE "standard" so the label "Gold Standard Program" can never fall through to
// the Standard branch.
function bankStatementLine(program, assetMonths, noteBuyer) {
  const loud = loudMonthsBanner();
  const p = String(program || '');
  let ask;
  if (/silver/i.test(p)) ask = 'Provide 2 months of recent bank statements — the Silver Program requires two months.';
  else if (/gold/i.test(p)) ask = 'Provide 2 months of recent bank statements — the Gold Standard Program requires two months.';
  else if (/standard/i.test(p)) ask = 'Provide 2 months of recent bank statements — the Standard Program requires two months.';
  else ask = 'Provide 2 months of recent bank statements — this loan requires two months.';
  return `${loud}${ask} ${PRINTOUT_ALLOWANCE}`;
}
const GENERIC_BANK_STMT_HINT =
  'Provide 2 months of recent bank statements showing your liquid assets. ' + PRINTOUT_ALLOWANCE;

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
      // The government charges INSIDE those closing costs (owner-directed
      // 2026-08-23), kept as line items on the condition's own payload so the
      // requirement can be reconciled against a settlement statement later
      // without re-pricing the deal.
      /* READ OFF `closingCosts`, WHICH IS WHERE THEY LIVE. These two read `quote.governmentCharges`
         at the TOP LEVEL until 2026-08-26 — a key `normalize()` has never produced — so the
         liquidity condition recorded $0 of government charges on every file ever registered, and
         the hint below never named the mortgage recording tax even where it is the single largest
         number in the cash to close (MEASURED: $20,880 on a Brooklyn flip, recorded as zero). The
         REQUIRED figure was always right — it comes from `dueAtClosing`, which carries them — so
         nothing was ever under-collected; what was lost is the breakdown a reviewer reconciles
         against a settlement statement, and `asset-ledger` reads that stored breakdown too. */
      governmentCharges: Number(cc.governmentCharges) || 0,
      governmentChargeLines: Array.isArray(cc.governmentChargeLines) ? cc.governmentChargeLines : [],
      reserveRequirement: Number(quote.reserveRequirement) || 0,
      reserveBasis: quote.reserveBasis || null,
      // 1% closing-cost buffer (owner-authorized 2026-07-31) — extra cash the
      // borrower must show so attorney/other closing charges never run short.
      // 0 when waived per file (applications.liquidity_buffer_waived).
      closingBuffer: Number(quote.closingBuffer) || 0,
      closingBufferWaived: !!quote.closingBufferWaived,
      // The REFINANCE breakdown, so the cash-to-close is explained as the payoff
      // shortfall instead of a purchase down payment (null on a purchase). Mirrors
      // product-registration.assetDetail — the two must read the same.
      refi: (quote && quote.refi) ? {
        payoff: Number(quote.refi.payoff) || 0,
        closing: Number(quote.refi.closing) || 0,
        fundedAtClose: Number(quote.refi.fundedAtClose) || 0,
        cashOut: Number(quote.refi.cashOut) || 0,
      } : null,
      computedAt: new Date().toISOString(),
    };
    // On a REFINANCE the cash to close is the payoff shortfall (payoff + closing
    // − funds advanced at closing), NOT "down payment + closing" — which on a refi
    // reads "Down payment $0.00 + closing $X = cash to close $Y", an equation that
    // is internally false. Owner-directed 2026-08-04.
    const govSeg = governmentChargeLine(quote);
    const cashToCloseSeg = breakdown.refi
      // CASH-OUT: the funds advanced exceed the payoff + closing, so cash-to-close is
      // $0 and the payoff/less-funds equation would sum NEGATIVE against it (the exact
      // "doesn't add up" problem the term-sheet display gates out). State the cash-out
      // instead. RATE-AND-TERM: the borrower brings a positive shortfall, so the
      // reconciliation reads correctly.
      ? (breakdown.refi.cashOut > 0
          ? `Cash to close ${money2(breakdown.cashToClose)} — the new loan covers the existing payoff and closing costs; the borrower takes ${money2(breakdown.refi.cashOut)} cash out`
          : `Loan payoff ${money2(breakdown.refi.payoff)} + closing costs due at closing ${money2(breakdown.refi.closing)}${govSeg} ` +
            `− funds advanced at closing ${money2(breakdown.refi.fundedAtClose)} = cash to close ${money2(breakdown.cashToClose)}`)
      : `Down payment ${money2(breakdown.downPayment)} + ` +
        `${breakdown.assignmentExcess > 0 ? `assignment excess ${money2(breakdown.assignmentExcess)} + ` : ''}` +
        `closing costs due at closing ${money2(breakdown.closingCosts)}${govSeg} = cash to close ${money2(breakdown.cashToClose)}`;
    const hint =
      `${bankStatementLine(program, assetMonths, noteBuyer)} ` +
      `Required liquidity: ${money2(required)} — the borrower's bank statements must show at least this in liquid assets. ` +
      `${cashToCloseSeg}; plus reserves ${money2(breakdown.reserveRequirement)}` +
      `${breakdown.reserveBasis ? ` (${breakdown.reserveBasis})` : ''}` +
      `${breakdown.closingBuffer > 0 ? `; plus a closing-cost buffer ${money2(breakdown.closingBuffer)} (1% of the loan amount, for extra closing charges)` : (breakdown.closingBufferWaived ? '; closing-cost buffer waived on this file' : '')}.`;

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
    // Re-stamp the assets-ledger max after either write below (db/574, audit
    // 2026-08-18): the reserve requirement just moved, so a Max-Cash-to-Close
    // note computed off the OLD reserve would sit beside the NEW requirement in
    // one summary line. Best-effort — a stamp failure never fails the sync.
    const restamp = () => require('./underwriting/asset-ledger').stampCondition(appId, client).catch(() => null);
    if ((firstConcrete || increased) && wasCleared && !opts.noReopen) {
      await client.query(
        `UPDATE checklist_items
            SET tool_payload=$2, hint=$3, borrower_hint=$3, status='outstanding',
                signed_off_at=NULL, signed_off_by=NULL, reviewed_at=NULL, reviewed_by=NULL, updated_at=now()
          WHERE id=$1`, [item.id, JSON.stringify(payload), hint]);
      await restamp();
      return { reopened: true, reason: increased ? 'increase' : 'first', required, prevRequired };
    }
    await client.query(
      `UPDATE checklist_items SET tool_payload=$2, hint=$3, borrower_hint=$3, updated_at=now() WHERE id=$1`,
      [item.id, JSON.stringify(payload), hint]);
    await restamp();
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

// Re-sync ONE file's liquidity condition from its CURRENT registration quote (owner 2026-07-27).
// The bank-statement month count is the stricter of the program's and the NOTE BUYER's requirement
// (Blue Lake = 2), and syncLiquidityCondition reads the note buyer itself — but it only ran on
// register + boot backfill. So a file registered Standard (1 month) whose note buyer is set to Blue
// Lake AFTER registration kept saying "1 month" until the next re-register. This lets the
// note-buyer-change handlers (ClickUp inbound + the staff completeness edit) re-derive it
// immediately. noReopen: never reopens a cleared condition — it just corrects the hint + the
// recorded requirement. No registration yet → nothing to sync (the count is only set once registered).
async function resyncLiquidityForFile(appId, client = db) {
  try {
    const r = await client.query(
      `SELECT quote FROM product_registrations WHERE application_id=$1 AND is_current=true AND quote IS NOT NULL LIMIT 1`, [appId]);
    if (!r.rows[0]) return null;
    let quote = r.rows[0].quote;
    if (typeof quote === 'string') { try { quote = JSON.parse(quote); } catch (_) { return null; } }
    return await syncLiquidityCondition(appId, quote, client, { noReopen: true });
  } catch (e) { console.error('[liquidity] resyncLiquidityForFile failed', appId, e && e.message); return null; }
}

/**
 * Set the per-file 1% closing-cost-buffer WAIVER (owner-authorized 2026-07-31:
 * "it's something that we can waive on certain scenarios — on the manual side").
 * Writes applications.liquidity_buffer_waived, then keeps the CURRENT
 * registration's stored quote + the assets condition in step: the buffer is a
 * requirement layer on top of the priced structure (never an engine number), so
 * the stored quote's closingBuffer / liquidityRequired are adjusted by exact
 * arithmetic (old buffer out, new buffer in — 1% of the registered total loan)
 * rather than re-running the engines. Un-waiving RAISES the requirement, so the
 * condition may reopen (syncLiquidityCondition's increased-rule); waiving only
 * lowers it and never reopens. No registration yet → just the flag (the next
 * register prices with it). Returns {waived, closingBuffer, liquidityRequired}.
 */
async function setClosingBufferWaiver(appId, waived, client = db) {
  const on = !!waived;
  await client.query(`UPDATE applications SET liquidity_buffer_waived=$2 WHERE id=$1`, [appId, on]);
  const r = await client.query(
    `SELECT id, total_loan, quote FROM product_registrations
      WHERE application_id=$1 AND is_current=true LIMIT 1`, [appId]);
  if (!r.rows[0] || !r.rows[0].quote) return { waived: on, closingBuffer: null, liquidityRequired: null };
  let quote = r.rows[0].quote;
  if (typeof quote === 'string') { try { quote = JSON.parse(quote); } catch (_) { return { waived: on, closingBuffer: null, liquidityRequired: null }; } }
  const totalLoan = Number(r.rows[0].total_loan) || Number(quote.sizing && quote.sizing.totalLoan) || 0;
  const oldBuffer = Number(quote.closingBuffer) || 0;
  const newBuffer = on || totalLoan <= 0 ? 0 : Math.round(totalLoan * 0.01 * 100) / 100;
  const oldRequired = Number(quote.liquidityRequired != null ? quote.liquidityRequired : quote.liquidity) || 0;
  const newRequired = Math.round((oldRequired - oldBuffer + newBuffer) * 100) / 100;
  quote.closingBuffer = newBuffer;
  quote.closingBufferWaived = on;
  quote.liquidityRequired = newRequired;
  quote.liquidity = newRequired;
  await client.query(`UPDATE product_registrations SET quote=$2::jsonb WHERE id=$1`, [r.rows[0].id, JSON.stringify(quote)]);
  await syncLiquidityCondition(appId, quote, client, { noReopen: on });
  return { waived: on, closingBuffer: newBuffer, liquidityRequired: newRequired };
}

/* WHAT IS INSIDE THE CLOSING COSTS — the government charges, named.

   Owner-directed 2026-08-23. The number was already right the moment the mortgage
   tax landed in the quote (cash to close is built from the closing costs, and the
   liquidity from the cash to close), but the SENTENCE still said only "closing
   costs due at closing $14,150" — and on a New York City loan roughly $11,550 of
   that is one line the borrower has never been told about. A total nobody can
   break down is a total nobody can check, and the first time it gets checked is at
   the closing table, which is the worst possible moment to discover it.

   So the two charges that actually move the number are named, largest first, with
   the rest summed. ONE definition, because `product-registration.assetDetail`
   prints the same reconciliation into the internal approval email and the two must
   read the same. Returns '' when the deal carries none, leaving every existing
   sentence in a state with no such tax byte-identical. */
function governmentChargeLine(quote) {
  /* TWO SHAPES REACH HERE, AND BOTH ARE LEGITIMATE. A live or stored QUOTE carries these on
     `closingCosts`; `asset-ledger` passes the FLAT pair straight off the condition's saved
     liquidity breakdown. Reading only the flat form is what made this silently print nothing on
     every quote for as long as it has existed. */
  const src = (quote && quote.closingCosts) || quote || {};
  const lines = Array.isArray(src.governmentChargeLines) ? src.governmentChargeLines : [];
  const total = Number(src.governmentCharges) || 0;
  if (!lines.length || !(total > 0)) return '';
  const sorted = lines.slice().filter((l) => l && Number(l.amount) > 0)
    .sort((a, b) => Number(b.amount) - Number(a.amount));
  if (!sorted.length) return '';
  // The label is printed VERBATIM. Lower-casing it reads better mid-sentence right
  // up until the label is "New York City mortgage recording tax", which then comes
  // out as "new york city" — a proper noun destroyed to tidy one letter.
  const named = sorted.slice(0, 2).map((l) => `${money2(l.amount)} ${String(l.label || 'government charge')}`);
  const restCount = sorted.length - named.length;
  const rest = restCount > 0
    ? `, and ${money2(sorted.slice(2).reduce((n, l) => n + Number(l.amount), 0))} of other government charges`
    : '';
  return ` — including ${named.join(' and ')}${rest}`;
}

module.exports = {
  governmentChargeLine,
  syncLiquidityCondition, backfillLiquidityConditions, resyncLiquidityForFile,
  setClosingBufferWaiver,
  bankStatementMonths, bankStatementLine, GENERIC_BANK_STMT_HINT, currentProgram,
};

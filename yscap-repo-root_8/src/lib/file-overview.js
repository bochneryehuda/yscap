'use strict';
/**
 * THE FILE-OVERVIEW SLIDE-OVER — one deal, one glance, every surface
 * (owner-directed 2026-08-18: a left-side overview on every file screen —
 * staff, borrower AND broker — showing "the borrower names, the entity, the
 * address, purchase price, underlying + assignment fee, total loan, holdbacks,
 * initial loan, origination points, rate, the liquidity breakdown, verified
 * funds, transaction type").
 *
 * ONE builder serves all three surfaces, keyed on AUDIENCE — the same
 * single-definition discipline as borrower-safe-view.js (the appraisal) and
 * borrower-safe-draws.js (the draws), because three hand-rolled payloads is how
 * an internal figure leaks to an outside broker. `internal` gets everything the
 * owner listed PLUS the investor line (owner-directed 2026-08-26: "add another
 * line for the name of the investor that this note is being sold to" — an RTL
 * STAFF surface may name the note buyer); `borrower` (the borrower portal AND
 * the TPO broker) gets the same deal facts through the borrower-safe scrub and
 * NEVER the investor — the row is emitted only when the audience is internal,
 * so the one audience flag is the boundary.
 *
 * Every row whose value is unknown is OMITTED — the panel never prints a
 * guessed $0 (the repo's standing missing-vs-zero discipline).
 */
const db = require('../db');
const payoffLib = require('./payoff');
const { scrubText } = require('./borrower-safe');

const money = (n) => {
  // NULL/'' is UNKNOWN → null (the row is omitted) — never "$0". Number(null)
  // is 0, which is exactly how a refinance's doctrine-NULL purchase price was
  // printing as "$0" (audit 9a05513 #3). A genuine zero still prints.
  if (n == null || n === '') return null;
  const x = Number(n);
  return Number.isFinite(x) ? `$${Math.round(x).toLocaleString('en-US')}` : null;
};
/* THE FEE / CASH / LIQUIDITY MONEY SHOWS ITS CENTS — money() above is for the
   figures that are whole dollars BY RULE (the loan and its three pieces, floored
   by the frozen 2026-07-09 rounding rule) and for the deal's headline values.
   A FEE is not one of those: origination is round2(totalLoan * origPct), so
   1.50% of $367,500 is $5,512.50 and rounding it printed $5,513 — half a dollar
   the borrower is not being charged, on the panel an officer quotes from
   (owner-reported 2026-08-24, file YSCAP258134663).

   This is not a new convention, it is the one this repo already settled: the
   Term Sheet Studio panel carries "Fees / cash-to-close / liquidity show EXACT
   cents (owner-directed 2026-07-16)" and renders every one of these through its
   own money2, and liquidity.js does the same for the assets condition. The
   overview was the one surface that did not, so it disagreed with the studio,
   the term sheet PDF and the Excel export about the same fee. Same 2-decimal
   shape as those, deliberately, so the four now agree byte for byte. */
const money2 = (n) => {
  if (n == null || n === '') return null;
  const x = Number(n);
  return Number.isFinite(x)
    ? `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;
};
const pctOf = (frac) => {
  // Ratios here are engine FRACTIONS (pricing.normalize) — no percent-form
  // tolerance knee: a ratio past 150% is an ordinary ground-up figure and must
  // print as itself, never silently divided by 100 (the audit 98b8fac class).
  const x = Number(frac);
  if (!Number.isFinite(x) || x <= 0) return null;
  return `${Math.round(x * 100 * 100) / 100}%`;
};

function addrOf(pa) {
  if (!pa || typeof pa !== 'object') return null;
  return String(pa.oneLine || pa.raw
    || [pa.line1, pa.city, [pa.state, pa.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    || '').trim() || null;
}

/**
 * Build the slide-over payload. audience: 'internal' | 'borrower' ('borrower'
 * also serves the TPO broker — same boundary as every other shared scrub).
 * Never throws; an unreadable file returns null.
 */
async function buildFileOverview(appId, { audience = 'internal' } = {}, client = db) {
  const external = audience !== 'internal';
  const safe = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    return external ? scrubText(s) : s;
  };
  let a;
  try {
    a = (await client.query(
      `SELECT a.id, a.status, a.ys_loan_number, a.property_address, a.loan_type, a.rehab_type,
              a.purchase_price, a.underlying_contract_price, a.assignment_fee, a.is_assignment,
              a.as_is_value, a.arv, a.rehab_budget, a.payoff_amount, a.property_free_and_clear,
              a.lender,
              NULLIF(b1.full_name,'') AS borrower_name,
              NULLIF(b2.full_name,'') AS co_borrower_name,
              l.llc_name,
              pr.quote, pr.program, pr.product_label
         FROM applications a
         LEFT JOIN borrowers b1 ON b1.id = a.borrower_id
         LEFT JOIN borrowers b2 ON b2.id = a.co_borrower_id
         LEFT JOIN llcs l ON l.id = a.llc_id
         LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current
        WHERE a.id = $1 AND a.deleted_at IS NULL LIMIT 1`, [appId])).rows[0];
  } catch (_) { return null; }
  if (!a) return null;

  const quote = a.quote || null;
  const s = (quote && quote.sizing) || {};
  const kind = payoffLib.refiKind(a.loan_type);
  const kindLabel = payoffLib.KIND_LABEL ? payoffLib.KIND_LABEL[kind] : null;
  // Sizes on the as-is value = a refinance (deal-basis, one definition): no
  // purchase-price row at all (db/399 — a refinance carries none), and the
  // payoff row shows for EVERY refinance, unknown subtype included.
  const isRefi = require('./deal-basis').sizesOnAsIsValue(a.loan_type);

  const sections = [];
  const section = (title, rows) => {
    const kept = rows.filter((r) => r && r.value != null && r.value !== '');
    if (kept.length) sections.push({ title, rows: kept });
  };

  section('Who', [
    { label: 'Borrower', value: safe(a.borrower_name) },
    { label: 'Co-borrower', value: safe(a.co_borrower_name) },
    { label: 'Vesting entity', value: safe(a.llc_name) },
  ]);

  section('Property & transaction', [
    { label: 'Address', value: safe(addrOf(a.property_address)) },
    { label: 'Transaction type', value: [safe(a.loan_type), kindLabel && kindLabel !== a.loan_type ? kindLabel : null].filter(Boolean).join(' · ') || null },
    { label: 'Rehab type', value: safe(a.rehab_type) },
    // A refinance never shows a purchase price (db/399 doctrine) — its
    // headline figure is the as-is value below.
    ...(!isRefi ? [{ label: 'Purchase price', value: money(a.purchase_price) }] : []),
    // On an ASSIGNMENT the price splits into what the seller gets and the
    // wholesaler's fee — the owner named both.
    ...(a.is_assignment && !isRefi ? [
      { label: 'Underlying contract price', value: money(a.underlying_contract_price) },
      { label: 'Assignment fee', value: money(a.assignment_fee) },
    ] : []),
    { label: 'As-is value', value: money(a.as_is_value) },
    { label: 'After-repair value (ARV)', value: money(a.arv) },
    { label: 'Construction budget', value: money(a.rehab_budget) },
    ...(isRefi ? [
      { label: 'Payoff', value: a.property_free_and_clear ? 'Free & clear — no payoff' : money(a.payoff_amount) },
    ] : []),
  ]);

  // Origination: percent + dollars together when both are known. quote.origPct
  // is a FRACTION (pricing.normalize divides by 100), so it renders through the
  // same fraction→percent formatter the rate uses (audit 9a05513 #2).
  const RF = require('./rate-format');
  const origPct = quote && quote.origPct != null ? Number(quote.origPct) : null;
  const origDollars = quote && quote.origination != null ? Number(quote.origination) : null;
  /* WHEN THE PROGRAM MINIMUM BOUND, THE STATED RATE IS NOT THE RATE CHARGED (owner-directed
     2026-09-04, db/695) — and this row prints the two side by side, so without the qualifier it
     reads as a contradiction: "1.25% · $2,500.00" on a $60,000 loan, where 1.25% is $750. The
     percentage shown becomes the EFFECTIVE one and the row says why, from the quote's own explain
     block rather than from a second decision here. A loan the floor never reaches is byte-identical
     (the block is absent), which is every loan at or above the crossover. */
  const origMin = quote && quote.closingCosts && quote.closingCosts.originationMinimum;
  const shownPct = origMin && origMin.effectivePct != null ? Number(origMin.effectivePct) : origPct;
  const origination = (shownPct || origDollars)
    ? [shownPct ? `${RF.fmtRatePct(shownPct)}%` : null, origDollars ? money2(origDollars) : null]
        .filter(Boolean).join(' · ') + (origMin ? ' · program minimum applied' : '')
    : null;

  /* THE PROGRAM ROW LEADS WITH THE PROGRAM'S NAME (owner-directed 2026-08-26:
     "add next to the program details … the name of the program, Silver
     Standard"). The stored quote carries the canonical label
     (quote.programLabel — pricing.PROGRAM_LABEL's long form, e.g. "Silver
     Program"); a registration whose quote predates that key falls back to the
     same table by key, and only then to the raw key, so a Silver file never
     reads literally "silver" again. The product label (often null) stays as a
     secondary part. */
  const programName = (quote && quote.programLabel)
    || (a.program && (require('./pricing').PROGRAM_LABEL || {})[a.program])
    || a.program || null;
  const programRow = [safe(programName), a.product_label && a.product_label !== programName ? safe(a.product_label) : null]
    .filter(Boolean).join(' · ') || null;

  section('The loan', [
    { label: 'Program', value: programRow },
    /* The INVESTOR the note is being sold to (applications.lender — the note
       buyer). INTERNAL ONLY: an RTL staff surface may name a note buyer; the
       borrower and TPO doors both pass audience:'borrower' and never get the
       row (the standing never-expose-a-note-buyer rule). */
    ...(!external ? [{ label: 'Investor', value: safe(a.lender) }] : []),
    { label: 'Total loan', value: money(s.totalLoan), strong: true },
    { label: 'Initial loan (advance)', value: money(s.initialAdvance) },
    { label: 'Construction holdback', value: money(s.rehabHoldback) },
    { label: 'Interest reserve (financed)', value: money(s.financedReserve) },
    { label: 'Origination points', value: origination },
    // quote.noteRate is a FRACTION (0.10625) — the ONE rate formatter renders it
    // "10.625" (audit 9a05513 #1: a raw print showed "0.104%").
    { label: 'Interest rate', value: quote && quote.noteRate != null && Number.isFinite(Number(quote.noteRate)) ? `${RF.fmtRatePct(quote.noteRate)}%` : null },
    { label: 'Initial LTV', value: pctOf(s.acqLtvPct) },
    { label: 'ARV LTV', value: pctOf(s.arvPct) },
  ]);

  // The liquidity picture — the registered requirement + the verified-assets
  // ledger, straight from computeAssetLedger (the ONE definition the assets
  // condition + Max Cash to Close read). Best-effort: an unreadable ledger
  // simply drops the section, never breaks the panel.
  try {
    const ledger = await require('./underwriting/asset-ledger').computeAssetLedger(appId, client);
    if (ledger) {
      const oop = Number(s.oopRehab) > 0 ? Number(s.oopRehab) : null;
      section('Liquidity', [
        { label: 'Cash to close (estimate)', value: ledger.estimateCashToClose != null ? money2(ledger.estimateCashToClose) : null },
        { label: 'Reserves to show', value: ledger.reserveRequirement != null ? money2(ledger.reserveRequirement) : null },
        { label: 'Closing-cost buffer (1%)', value: Number(ledger.closingBuffer) > 0 && !ledger.closingBufferWaived ? money2(ledger.closingBuffer) : null },
        { label: 'Out-of-pocket rehab', value: oop != null ? money2(oop) : null },
        { label: 'Total liquidity required', value: ledger.requiredLiquidity != null ? money2(ledger.requiredLiquidity) : null, strong: true },
        { label: 'Verified funds', value: ledger.haveCountable ? money2(ledger.verifiedTotal) : null, strong: true },
        { label: 'Max cash to close (verified)', value: ledger.maxCashToClose != null ? money2(ledger.maxCashToClose) : null },
      ]);
    }
  } catch (_) { /* no liquidity section */ }

  return {
    header: {
      loanNumber: a.ys_loan_number || null,
      address: safe(addrOf(a.property_address)),
      status: a.status || null,
      /* The loan's basics ride in the HEADER too (owner-directed 2026-08-26:
         "at the top part … please also add … the loan amount and whether it's
         a purchase, refinance, or cash-out. Even if it's listed in the bottom,
         don't remove it from the sections below"). Both are borrower-safe deal
         facts, so no audience gate; both are omitted when unknown (an
         unregistered file has no loan amount to claim). money() — whole
         dollars, the frozen loan-figure rounding rule. */
      loanAmount: money(s.totalLoan),
      /* A blank loan_type states nothing: refiKind's deliberate purchase FALLBACK
         (right for the payoff section's "does a payoff apply") must not become a
         confident "Purchase" chip here — the header's own contract is "omitted
         when unknown". Only a file that actually carries a purpose gets one. */
      purpose: safe(a.loan_type) ? (kindLabel || safe(a.loan_type)) : null,
    },
    sections,
  };
}

module.exports = { buildFileOverview };

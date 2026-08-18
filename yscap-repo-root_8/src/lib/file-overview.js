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
 * owner listed; `borrower` (the borrower portal AND the TPO broker) gets the
 * same deal facts through the borrower-safe scrub, and NEVER the note buyer —
 * which is also why the note buyer is simply not in this payload at all: the
 * owner's list does not name it, and leaving it out entirely beats gating it.
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
  const origination = (origPct || origDollars)
    ? [origPct ? `${RF.fmtRatePct(origPct)}%` : null, origDollars ? money(origDollars) : null].filter(Boolean).join(' · ')
    : null;

  section('The loan', [
    { label: 'Program', value: safe(a.product_label || a.program) },
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
        { label: 'Cash to close (estimate)', value: ledger.estimateCashToClose != null ? money(ledger.estimateCashToClose) : null },
        { label: 'Reserves to show', value: ledger.reserveRequirement != null ? money(ledger.reserveRequirement) : null },
        { label: 'Closing-cost buffer (1%)', value: Number(ledger.closingBuffer) > 0 && !ledger.closingBufferWaived ? money(ledger.closingBuffer) : null },
        { label: 'Out-of-pocket rehab', value: oop != null ? money(oop) : null },
        { label: 'Total liquidity required', value: ledger.requiredLiquidity != null ? money(ledger.requiredLiquidity) : null, strong: true },
        { label: 'Verified funds', value: ledger.haveCountable ? money(ledger.verifiedTotal) : null, strong: true },
        { label: 'Max cash to close (verified)', value: ledger.maxCashToClose != null ? money(ledger.maxCashToClose) : null },
      ]);
    }
  } catch (_) { /* no liquidity section */ }

  return {
    header: {
      loanNumber: a.ys_loan_number || null,
      address: safe(addrOf(a.property_address)),
      status: a.status || null,
    },
    sections,
  };
}

module.exports = { buildFileOverview };

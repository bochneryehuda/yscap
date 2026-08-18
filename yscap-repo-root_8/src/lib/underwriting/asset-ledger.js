// ---------------------------------------------------------------------------
// THE VERIFIED-ASSETS LEDGER + MAX CASH TO CLOSE (owner-directed 2026-08-18).
//
// The bank-statement reader (bank-liquidity.js) answers "what do the documents
// prove?" and is deliberately read-only. This module is the STAFF-EDITABLE
// layer on top of it: a processor / back-office / admin can correct the amount
// PILOT read for an account, include an account the reader excluded (or the
// reverse), and add an account the reader never saw — the URLA-style assets
// table the owner asked for. The merge happens at READ time, so deleting a
// ledger row always returns an account to exactly what the documents say;
// nothing here ever rewrites a document_extractions row or the assessment.
//
// MAX CASH TO CLOSE is the one number the desk asks before a closing:
//
//   max cash to close = verified assets − reserve requirement − closing buffer
//
// It is deliberately the ALGEBRAIC INVERSE of closing.decideCashToClose's own
// test (verified >= actual + reserve + buffer), so the two can never disagree:
// an actual cash-to-close at or under this number passes the money gate, one
// over it fails. The buffer term is 0 when the file's 1% buffer is waived
// (the stored breakdown already carries 0 there). With no countable verified
// money the answer is NULL — never a confident $0.
//
// The number is stamped onto the assets condition (rtl_p3_assets) two ways:
// tool_payload.assetLedger (durable, machine-readable — its own key, NEVER
// inside tool_payload.liquidity, which liquidity.js REPLACES wholesale on
// every re-register) and an [auto]-guarded line in the condition's notes so a
// human reading the condition sees it. A note somebody typed is never touched.
// ---------------------------------------------------------------------------
'use strict';

const db = require('../../db');

const MAX_AMOUNT = 999999999999.99; // numeric(14,2) ceiling — refuse, never truncate

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function money(n) {
  const v = Number(n) || 0;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The stable identity of a system-read account. Built from what the assets
// table displays (bank + masked number + holder), lowercased with spacing
// collapsed, so the key survives a re-read of the same statements. A changed
// holder spelling mints a new key — the stale override then simply stops
// matching (it renders as "no longer on file" and can be deleted), which is
// safer than fuzzy-matching an override onto the wrong account.
function accountKeyOf(acct) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return ['a', norm(acct && acct.bankName), norm(acct && acct.accountNumber), norm(acct && acct.holder)]
    .join('|');
}

// PURE. Merge the read-only assessment accounts with the staff ledger rows.
//   assessment: { accounts: [...], qualifyingTotal } (bank-liquidity shape)
//   entries:    asset_ledger_entries rows
// Returns { rows, verifiedTotal, readTotal, adjusted, haveCountable }.
// Rules: an override's amount wins over the read balance when it is a number;
// its include flag wins over the tied verdict when it is a boolean; a manual
// row counts when include !== false and it has an amount. Amounts that are
// NULL contribute nothing (never a guessed 0 IN the total, though the row
// still shows).
function mergeLedger(assessment, entries) {
  const accounts = (assessment && Array.isArray(assessment.accounts)) ? assessment.accounts : [];
  const list = Array.isArray(entries) ? entries : [];
  const overrides = new Map();
  for (const e of list) {
    if (e && e.kind === 'override' && e.account_key) overrides.set(String(e.account_key), e);
  }
  const rows = [];
  let verifiedTotal = 0;
  let adjusted = false;
  const usedOverrides = new Set();
  for (const a of accounts) {
    const key = accountKeyOf(a);
    /* AN OVERRIDE CORRECTS EXACTLY ONE ACCOUNT (audit 2026-08-18). Two read
       accounts CAN share a key (same holder + bank, both with no readable
       number) — applying one override to both would silently DOUBLE the
       corrected money into the verified total that feeds the closing money
       gate. First account with the key gets the correction; any later
       collision keeps its own document read, untouched. */
    const ov = usedOverrides.has(key) ? null : (overrides.get(key) || null);
    if (ov) usedOverrides.add(key);
    const readAmount = a.ending != null && Number.isFinite(Number(a.ending)) ? Number(a.ending) : null;
    const ovAmount = ov && ov.amount != null && Number.isFinite(Number(ov.amount)) ? Number(ov.amount) : null;
    const amount = ovAmount != null ? ovAmount : readAmount;
    const systemIncluded = !!a.tied && readAmount != null;
    const included = ov && typeof ov.include === 'boolean' ? ov.include : systemIncluded;
    if (ov && (ovAmount != null || typeof ov.include === 'boolean')) adjusted = true;
    if (included && amount != null) verifiedTotal += amount;
    rows.push({
      source: 'read', key,
      holder: a.holder || null, bankName: a.bankName || null, accountNumber: a.accountNumber || null,
      holderIsBusiness: a.holderIsBusiness === true,
      statementCount: a.statementCount || null, countedPeriod: a.countedPeriod || null,
      document_id: a.document_id || null,
      readAmount, amount, included, systemIncluded, tied: !!a.tied,
      override: ov ? { id: ov.id, amount: ovAmount, include: typeof ov.include === 'boolean' ? ov.include : null, note: ov.note || null } : null,
    });
  }
  for (const e of list) {
    if (!e) continue;
    if (e.kind === 'manual') {
      const amount = e.amount != null && Number.isFinite(Number(e.amount)) ? Number(e.amount) : null;
      const included = e.include !== false;
      adjusted = true;
      if (included && amount != null) verifiedTotal += amount;
      rows.push({
        source: 'manual', key: null, id: e.id,
        holder: e.holder || null, bankName: e.institution || null, accountNumber: e.account_number || null,
        readAmount: null, amount, included, systemIncluded: false, tied: true,
        note: e.note || null,
      });
    } else if (e.kind === 'override' && e.account_key && !usedOverrides.has(String(e.account_key))) {
      // An override whose account is no longer in the read set — surfaced so it
      // can be cleaned up, and NEVER counted (the money it described is gone).
      rows.push({
        source: 'stale_override', key: String(e.account_key), id: e.id,
        holder: e.holder || null, bankName: e.institution || null, accountNumber: e.account_number || null,
        readAmount: null, amount: e.amount != null ? Number(e.amount) : null,
        included: false, systemIncluded: false, tied: false, note: e.note || null,
      });
    }
  }
  const haveCountable = rows.some((r) => r.included && r.amount != null);
  return {
    rows,
    verifiedTotal: round2(verifiedTotal),
    readTotal: round2(Number(assessment && assessment.qualifyingTotal) || 0),
    adjusted,
    haveCountable,
  };
}

// PURE. The one formula (see the header). null when nothing countable is
// verified — a blank is honest, a $0 would read as "this borrower can close
// on nothing", which is a claim, not an absence. ALSO null when the verified
// assets cannot even cover the reserves + buffer (audit 2026-08-18): a $0
// "max" there would be a number the money gate itself refuses (decideCashToClose
// fails a $0 actual when verified < reserve + buffer), and the two surfaces
// must never disagree — the shortOfReserves flag carries the real story.
function maxCashToCloseOf({ verifiedTotal, reserveRequirement, closingBuffer, haveCountable }) {
  if (!haveCountable) return null;
  const v = Number(verifiedTotal) || 0;
  const r = Number(reserveRequirement) || 0;
  const b = Number(closingBuffer) || 0;
  const max = v - r - b;
  return max < 0 ? null : round2(max);
}

// PURE. True when there ARE countable verified assets but they fall short of
// the reserves + buffer alone — the case where no cash-to-close can pass.
function shortOfReservesOf({ verifiedTotal, reserveRequirement, closingBuffer, haveCountable }) {
  if (!haveCountable) return false;
  return ((Number(verifiedTotal) || 0) - (Number(reserveRequirement) || 0) - (Number(closingBuffer) || 0)) < 0;
}

async function loadEntries(appId, client) {
  const c = client || db;
  const r = await c.query(
    `SELECT * FROM asset_ledger_entries WHERE application_id=$1 ORDER BY created_at, id`, [appId]);
  return r.rows;
}

// The whole picture for one file: read the frozen breakdown, run the read-only
// assessment, merge the ledger, compute the max. Never throws — an unreadable
// piece degrades to nulls with a stated reason.
async function computeAssetLedger(appId, client) {
  const c = client || db;
  const closing = require('../closing'); // lazy — closing requires this module back
  let liq = null;
  try { liq = await closing.readLiquidityBreakdown(appId, c); } catch (_) { liq = null; }
  let read = { verified: 0, excludedTotal: 0, accounts: [] };
  try {
    read = await closing.readVerifiedLiquidity(appId, c, liq && liq.required != null ? Number(liq.required) : null);
  } catch (_) { /* keep the empty shape */ }
  let entries = [];
  try { entries = await loadEntries(appId, c); } catch (_) { entries = []; }
  const merged = mergeLedger({ accounts: read.accounts, qualifyingTotal: read.verified }, entries);
  const reserve = liq && liq.reserveRequirement != null ? Number(liq.reserveRequirement) : null;
  const closingBuffer = liq && liq.closingBuffer != null ? Number(liq.closingBuffer) : 0;
  const maxCashToClose = reserve == null ? null : maxCashToCloseOf({
    verifiedTotal: merged.verifiedTotal, reserveRequirement: reserve, closingBuffer,
    haveCountable: merged.haveCountable,
  });
  const shortOfReserves = reserve == null ? false : shortOfReservesOf({
    verifiedTotal: merged.verifiedTotal, reserveRequirement: reserve, closingBuffer,
    haveCountable: merged.haveCountable,
  });
  return {
    shortOfReserves,
    rows: merged.rows,
    verifiedTotal: merged.verifiedTotal,
    readTotal: merged.readTotal,
    adjusted: merged.adjusted,
    haveCountable: merged.haveCountable,
    excludedTotal: Number(read.excludedTotal) || 0,
    reserveRequirement: reserve,
    reserveBasis: liq ? liq.reserveBasis || null : null,
    closingBuffer,
    closingBufferWaived: !!(liq && liq.closingBufferWaived),
    requiredLiquidity: liq && liq.required != null ? Number(liq.required) : null,
    estimateCashToClose: liq && liq.cashToClose != null ? Number(liq.cashToClose) : null,
    maxCashToClose,
    registered: !!liq,
  };
}

// Stamp the assets condition with the current max — a durable machine-readable
// copy under tool_payload.assetLedger (its OWN key: liquidity.js replaces the
// whole `liquidity` object on every re-register, so anything written inside it
// would be silently lost on the next registration) plus an [auto]-guarded note
// for humans. A note somebody typed is never overwritten. Best-effort — this
// can never fail a save.
async function stampCondition(appId, client) {
  const c = client || db;
  try {
    const led = await computeAssetLedger(appId, c);
    if (led.maxCashToClose == null) {
      /* THE MAX WENT AWAY (audit 2026-08-18) — the stamp and OUR note must go
         with it, or the condition keeps advertising a figure that no longer
         exists. Only our own note is cleared; a human's note is never touched. */
      await c.query(
        `UPDATE checklist_items ci
            SET tool_payload = (COALESCE(ci.tool_payload,'{}'::jsonb) - 'assetLedger'),
                notes = CASE WHEN ci.notes LIKE '[auto] Max cash to close%' THEN NULL ELSE ci.notes END,
                updated_at = now()
           FROM checklist_templates t
          WHERE t.id = ci.template_id AND ci.application_id = $1 AND t.code = 'rtl_p3_assets'
            AND (ci.tool_payload ? 'assetLedger' OR ci.notes LIKE '[auto] Max cash to close%')`,
        [appId]);
      return led;
    }
    const stamp = {
      maxCashToClose: led.maxCashToClose,
      verifiedTotal: led.verifiedTotal,
      reserveRequirement: led.reserveRequirement,
      closingBuffer: led.closingBuffer,
      adjusted: led.adjusted,
      computedAt: new Date().toISOString(),
    };
    const bufBit = led.closingBuffer > 0 ? ` − ${money(led.closingBuffer)} closing-cost buffer` : '';
    const note = `[auto] Max cash to close: ${money(led.maxCashToClose)} `
      + `(${money(led.verifiedTotal)} verified assets − ${money(led.reserveRequirement)} reserve requirement${bufBit}). `
      + `Recomputed as assets are verified or edited on the assets ledger.`;
    await c.query(
      `UPDATE checklist_items ci
          SET tool_payload = jsonb_set(COALESCE(ci.tool_payload,'{}'::jsonb), '{assetLedger}', $2::jsonb, true),
              notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%' THEN $3 ELSE ci.notes END,
              updated_at = now()
         FROM checklist_templates t
        WHERE t.id = ci.template_id AND ci.application_id = $1 AND t.code = 'rtl_p3_assets'`,
      [appId, JSON.stringify(stamp), note]);
    return led;
  } catch (_) { return null; }
}

// Validation for the write routes. Returns a plain-English problem or null.
function entryProblem(body) {
  const b = body || {};
  if (b.kind !== 'override' && b.kind !== 'manual') return 'kind must be "override" or "manual"';
  if (b.kind === 'override' && !String(b.accountKey || '').trim()) return 'an override must name the account it corrects';
  // REFUSED, never truncated (audit 2026-08-18): a silently-shortened key would
  // store a correction that never matches its account again — a 200 that didn't save.
  if (b.kind === 'override' && String(b.accountKey || '').length > 400) return 'the account identity is too long to store — this account cannot be corrected by key; add it as a manual row instead';
  if (b.amount != null && String(b.amount).trim() !== '') {
    const n = Number(b.amount);
    if (!Number.isFinite(n) || n < 0) return 'the amount must be a positive number';
    if (n > MAX_AMOUNT) return `the amount is too large to store (over ${money(MAX_AMOUNT)})`;
  }
  if (b.kind === 'manual') {
    const hasName = String(b.holder || '').trim() || String(b.institution || '').trim();
    if (!hasName) return 'a manually added account needs a holder or an institution name';
  }
  const cap = (v, n) => String(v == null ? '' : v).length <= n;
  if (!cap(b.institution, 160)) return 'the institution name is too long (160 characters max)';
  if (!cap(b.holder, 160)) return 'the account holder name is too long (160 characters max)';
  if (!cap(b.accountNumber, 60)) return 'the account number is too long (60 characters max)';
  if (!cap(b.note, 600)) return 'the note is too long (600 characters max)';
  return null;
}

module.exports = {
  accountKeyOf, mergeLedger, maxCashToCloseOf, shortOfReservesOf,
  loadEntries, computeAssetLedger, stampCondition, entryProblem,
  _internals: { round2, money, MAX_AMOUNT },
};

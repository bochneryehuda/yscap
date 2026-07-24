'use strict';
/**
 * File-level BANK LIQUIDITY aggregation — the "do the accounts on file actually cover the cash
 * this deal needs?" view. The owner's rule: "calculate ALL the bank statement assets… should be
 * enough money to cover our liquidity requirement based on the product that was registered."
 *
 * This is a COMPOSITION VIEW over every current bank_statement extraction, deliberately
 * NON-DUPLICATIVE of the per-statement checks (bank-statement-checks.js), which already own:
 *   · account ownership   (bank_account_other_entity / bank_account_not_borrower — the FATAL that
 *                          requires an operating agreement when a statement is under an unverified
 *                          LLC — i.e. the owner's "suggest LLC documentation" rule), and
 *   · balance-math tampering + large-deposit sourcing.
 * So this module raises only the two things NOBODY else does:
 *   1. bank_no_ending_balance — a readable statement with no ending balance to count (the owner:
 *      "we need to make sure that we have an ending balance").
 *   2. bank_liquidity_short   — the SUM of the borrower's / verified-entity accounts' ending
 *      balances is less than the file's required liquidity (down payment + closing costs +
 *      reserves), read off the registered product's assets condition.
 *
 * Only accounts tied to the borrower or a KNOWN borrower entity (the vesting LLC or an LLC the
 * borrower is on record for) count toward liquid assets — money in an unverified entity is excluded
 * from the total (and already carries the per-statement fatal). Several statements for the SAME
 * account (two months of one account) are collapsed to ONE representative so months don't
 * double-count; the per-account breakdown is returned so the desk sees exactly what was counted.
 *
 * Pure: no AI, no DB. The required-liquidity dollar comes from readRequiredLiquidity() (the impure
 * edge) and is passed in via opts.requiredLiquidity.
 */
const { num } = require('./compare');
const { borrowerName } = require('./file-view');
const { _internals: { holderMatchesFile } } = require('./bank-statement-checks');

const money = (n) => (num(n) == null ? '—' : `$${Math.round(num(n)).toLocaleString('en-US')}`);

// Masked account number for the assets table (owner-directed 2026-07-24: the breakdown was
// "missing accounts number"). Last 4 digits only — never the full number. null when none was read.
function maskAcct(f) {
  const digits = String((f && f.accountNumber) || '').replace(/\D/g, '');
  return digits ? `••${digits.slice(-4)}` : null;
}

// The best comparable DATE for a statement — used to keep only the MOST RECENT statement per
// account (owner-directed 2026-07-24: "need most recent statement by date not old one"). Prefers
// the end of `statementPeriod`; falls back to a single statement-date field if the period is
// unparseable. Returns null when nothing parses (then the upload date / input order decides).
function statementDateOf(f) {
  const fromPeriod = periodEndOf(f && f.statementPeriod);
  if (fromPeriod != null) return fromPeriod;
  for (const k of ['statementDate', 'periodEnd', 'asOfDate', 'statement_end_date', 'endDate', 'statement_date']) {
    const t = Date.parse(String((f && f[k]) || '').trim());
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// A stable identity for an account so two months of the SAME account collapse to one. The account
// NUMBER is the identity — and NOTHING ELSE when it's present: the same account's extracted bank
// name drifts month-to-month ("Chase" vs "JPMorgan Chase Bank NA"), so folding the bank string into
// the key would SPLIT one real account into two and DOUBLE-COUNT its balance (inflating liquidity —
// the dangerous direction). Keying on the number alone means a rare last-4 collision between two
// different accounts collapses them instead — which UNDER-counts (a false shortfall a human clears),
// the safe direction. Only when no usable number was read do we fall back to bank+holder.
// R5.59 — the END of a statement's period, as a comparable timestamp, so that
// when several months of ONE account are on file we count the LATEST month's
// ending balance (the owner: "make sure you have the last statement and
// calculate based on the last ending balance"). The schema stores a free-text
// `statementPeriod` ("January 1 - January 31, 2026", "01/01/26 - 01/31/26",
// "2026-01-01 to 2026-01-31"), so we take the LAST parseable date token in the
// string as the period end. Returns null when nothing parses (then we fall back
// to input order — the most recently analyzed month, the prior behavior).
function periodEndOf(statementPeriod) {
  const s = String(statementPeriod || '').trim();
  if (!s) return null;
  // Collect candidate date substrings: ISO (2026-01-31), US (01/31/2026 or
  // 1/31/26), and "Month DD, YYYY". Take the maximum parseable one.
  const cands = [];
  const iso = s.match(/\d{4}-\d{1,2}-\d{1,2}/g); if (iso) cands.push(...iso);
  const us = s.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g); if (us) cands.push(...us);
  const named = s.match(/[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4}/g); if (named) cands.push(...named);
  let best = null;
  for (const c of cands) {
    const t = Date.parse(c);
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best;
}

function accountKey(s) {
  const acct = String(s.accountNumber || '').replace(/\D/g, '');
  // Key on the LAST 4 digits — that's how account numbers are stored (masked to last-4), so a month
  // that carries the full number ("...123456789") and a month that carries only "6789" collapse to
  // the SAME account instead of splitting and double-counting (the dangerous inflate direction). The
  // cost is that two genuinely different accounts sharing a last-4 collapse — which UNDER-counts
  // (one rep, one balance; a human clears the resulting false shortfall), the safe direction.
  if (acct.length >= 4) return `#${acct.slice(-4)}`;
  if (acct.length >= 1) return `#${acct}`; // 1-3 digits: use as-is (garbage/over-masked; rare)
  const bank = String(s.bankName || '').trim().toLowerCase();
  const holder = String(s.accountHolderName || '').trim().toLowerCase();
  return `~${bank}|${holder}`; // number-less: best effort (leans to under-count, never inflate)
}

/**
 * @param {{borrower?, vestingName?, entityNames?}} ctx  the file view (same shape loadContext returns)
 * @param {Array<{doc_type,document_id,fields}>} extractions  current file extractions
 * @param {{requiredLiquidity?:number|null}} opts
 */
function assessBankLiquidity(ctx = {}, extractions = [], opts = {}) {
  const subject = {
    borrower_name: borrowerName(ctx.borrower) || (ctx.borrower_name || null),
    entity_names: [ctx.vestingName, ...(ctx.entityNames || [])].filter(Boolean),
  };
  const requiredLiquidity = num(opts.requiredLiquidity);

  const statements = (extractions || [])
    .filter((e) => (e.doc_type || e.docType) === 'bank_statement')
    .map((e, ix) => ({ document_id: e.document_id || null, created_at: e.created_at || e.createdAt || null, ix, f: e.fields || {} }));

  // Collapse statements of the SAME account to ONE representative — the MOST RECENT statement
  // (R5.59 + owner-directed 2026-07-24: "need most recent statement by date not old one... not
  // duplicating both same account's statements"). Each statement gets a comparable rank
  // [statementDate, uploadDate, inputIndex]; per account we keep the MAX rank. So the latest
  // statement's ending balance is the ONE we count — never two months of one account summed
  // (the dangerous inflate), and never an OLDER month when a newer one is on file. When no date
  // parses at all, the most-recently-uploaded (then last-analyzed) statement wins.
  const rankOf = (st) => {
    const date = statementDateOf(st.f);
    const up = Date.parse(String(st.created_at || ''));
    return [date != null ? date : -Infinity, Number.isFinite(up) ? up : -Infinity, st.ix];
  };
  const rankGt = (a, b) => (a[0] > b[0]) || (a[0] === b[0] && a[1] > b[1]) || (a[0] === b[0] && a[1] === b[1] && a[2] > b[2]);
  const byAccount = new Map();
  for (const st of statements) {
    const f = st.f;
    if (f.readable === false || !f.accountHolderName) continue; // an unreadable statement is bank_unreadable's job
    const key = accountKey(f);
    const rank = rankOf(st);
    const prev = byAccount.get(key);
    if (!prev) { byAccount.set(key, { rep: st, repEnd: rank[0] === -Infinity ? null : rank[0], rank, count: 1 }); continue; }
    const better = rankGt(rank, prev.rank);
    byAccount.set(key, {
      rep: better ? st : prev.rep,
      repEnd: better ? (rank[0] === -Infinity ? null : rank[0]) : prev.repEnd,
      rank: better ? rank : prev.rank,
      count: prev.count + 1,
    });
  }

  const accounts = [];
  let qualifyingTotal = 0;      // ending balances of tied accounts (the borrower's real liquid assets)
  let excludedTotal = 0;        // ending balances sitting in accounts NOT tied to the borrower/entity
  const missingEnding = [];     // readable accounts with no ending balance to count
  for (const { rep, count } of byAccount.values()) {
    const f = rep.f;
    const holder = f.accountHolderName;
    const tied = holderMatchesFile(holder, subject);
    const ending = num(f.closingBalance);
    accounts.push({
      holder, bankName: f.bankName || null, tied, ending,
      accountNumber: maskAcct(f),   // #244 (owner: the assets table was "missing accounts number") — last-4 only
      holderIsBusiness: f.holderIsBusiness === true, statementCount: count,
      // R5.59 — the month actually counted for this account (the latest of `count` months).
      countedPeriod: f.statementPeriod || null,
      document_id: rep.document_id,
    });
    if (ending == null) { missingEnding.push(holder); continue; }
    if (tied) qualifyingTotal += ending; else excludedTotal += ending;
  }

  const findings = [];

  // 1. Ending balance required — a readable statement we can't pull an ending balance from can't
  // count toward assets. One roll-up warning listing the accounts (never a fatal — it's a data gap).
  if (missingEnding.length) {
    const list = missingEnding.map((h) => `"${h}"`).join(', ');
    findings.push({
      source: 'bank_statement', code: 'bank_no_ending_balance', severity: 'warning', status: 'open',
      field: 'balances', docValue: `${missingEnding.length} account(s): ${list}`, fileValue: null, blocksCtc: false,
      title: 'A bank statement has no ending balance to count',
      howTo: `No ending (closing) balance could be read for ${list}. The ending balance is what proves current liquid assets — confirm it by hand or request a complete statement, or these funds can't be counted toward the liquidity requirement.`,
      actions: ['request_revision', 'open_condition', 'acknowledge', 'dismiss'], opensCondition: 'underwriting_review_cleared',
    });
  }

  // 2. Liquidity sufficiency — only when a concrete requirement is on file (a product is registered)
  // AND at least one TIED account's ending balance is countable. Gating on a tied countable balance
  // (not any balance) means an untied entity account with a readable balance while every borrower
  // account is missing its ending balance can't masquerade as a real "$0 on file" shortfall — that's
  // the bank_no_ending_balance data gap, not a shortfall. A $1 tolerance absorbs rounding.
  const haveCountable = accounts.some((acct) => acct.tied && acct.ending != null);
  let shortfall = null;
  if (requiredLiquidity != null && requiredLiquidity > 0 && haveCountable && qualifyingTotal < requiredLiquidity - 1) {
    shortfall = requiredLiquidity - qualifyingTotal;
    const excludedNote = excludedTotal > 0
      ? ` A further ${money(excludedTotal)} sits in account(s) not tied to the borrower or a known entity — that money is NOT counted here (see the account-ownership findings; it counts only once the borrower's control of that entity is documented).`
      : '';
    // R5.61 — show the exact per-account math the total came from: one line per
    // TIED account, the latest month's ending balance, never two months of the
    // same account summed. Makes the shortfall fully auditable.
    const tiedLines = accounts
      .filter((a) => a.tied && a.ending != null)
      .map((a) => `  · ${a.holder}${a.bankName ? ` (${a.bankName})` : ''}: ${money(a.ending)}${a.statementCount > 1 ? ` — latest of ${a.statementCount} months on file${a.countedPeriod ? `, ${a.countedPeriod}` : ''}` : ''}`)
      .join('\n');
    const mathNote = tiedLines
      ? ` Counted (latest statement per account, no month counted twice):\n${tiedLines}\n  = ${money(qualifyingTotal)} total.`
      : '';
    findings.push({
      source: 'bank_statement', code: 'bank_liquidity_short', severity: 'warning', status: 'open',
      field: 'liquidity', docValue: `${money(qualifyingTotal)} on file`, fileValue: `${money(requiredLiquidity)} required`, blocksCtc: false,
      title: 'Bank statements on file are short of the required liquidity',
      howTo: `The borrower's (and verified entity) accounts on file show ${money(qualifyingTotal)} in ending balances, but this deal requires ${money(requiredLiquidity)} in liquid assets (down payment + closing costs + reserves) — short by ${money(shortfall)}.${mathNote}${excludedNote} Collect additional statements, or confirm reserves, before clearing the assets condition.`,
      actions: ['request_document', 'open_condition', 'acknowledge', 'dismiss'], opensCondition: 'underwriting_review_cleared',
    });
  }

  return {
    findings,
    accounts,
    qualifyingTotal,
    excludedTotal,
    requiredLiquidity: requiredLiquidity != null ? requiredLiquidity : null,
    shortfall,
    statementsCount: statements.length,
    accountsCount: accounts.length,
  };
}

// Impure edge: read the required liquidity the register wrote onto the assets condition
// (checklist_items.tool_payload.liquidity.required — see src/lib/liquidity.js). Returns null when
// no product is registered / no requirement has been computed yet. Never throws.
async function readRequiredLiquidity(client, appId) {
  try {
    const conn = client || require('../../db'); // lazy — keep the pure path free of the db module
    const r = await conn.query(
      `SELECT ci.tool_payload
         FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_p3_assets'
        ORDER BY ci.created_at LIMIT 1`, [appId]);
    const liq = r.rows[0] && r.rows[0].tool_payload && r.rows[0].tool_payload.liquidity;
    const v = liq && liq.required != null ? Number(liq.required) : null;
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch (_) { return null; }
}

module.exports = { assessBankLiquidity, readRequiredLiquidity, _internals: { accountKey, periodEndOf } };

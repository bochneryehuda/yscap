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

// A stable identity for an account so two months of the SAME account collapse to one. Bank + the
// masked account number is the strongest signal; when the number is absent we fall back to
// bank+holder (still collapses "two statements of Chase / John Doe" but keeps distinct banks apart).
function accountKey(s) {
  const bank = String(s.bankName || '').trim().toLowerCase();
  const acct = String(s.accountNumber || '').replace(/\D/g, '');
  if (acct) return `${bank}|${acct}`;
  const holder = String(s.accountHolderName || '').trim().toLowerCase();
  return `${bank}|~${holder}`; // ~ marks a holder-based (number-less) key so it can't collide with a real number
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
    .map((e) => ({ document_id: e.document_id || null, f: e.fields || {} }));

  // Collapse statements of the same account to one representative (last in input order — the
  // extractions arrive in created_at order, so the most recently analyzed month wins), summing
  // NOTHING yet; we just pick the row that will represent each distinct account.
  const byAccount = new Map();
  for (const st of statements) {
    const f = st.f;
    if (f.readable === false || !f.accountHolderName) continue; // an unreadable statement is bank_unreadable's job
    const key = accountKey(f);
    const prev = byAccount.get(key);
    byAccount.set(key, { rep: st, count: (prev ? prev.count : 0) + 1 });
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
      holderIsBusiness: f.holderIsBusiness === true, statementCount: count,
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
  // AND at least one account's ending balance is countable. A $1 tolerance absorbs rounding.
  const haveCountable = accounts.some((acct) => acct.ending != null);
  let shortfall = null;
  if (requiredLiquidity != null && requiredLiquidity > 0 && haveCountable && qualifyingTotal < requiredLiquidity - 1) {
    shortfall = requiredLiquidity - qualifyingTotal;
    const excludedNote = excludedTotal > 0
      ? ` A further ${money(excludedTotal)} sits in account(s) not tied to the borrower or a known entity — that money is NOT counted here (see the account-ownership findings; it counts only once the borrower's control of that entity is documented).`
      : '';
    findings.push({
      source: 'bank_statement', code: 'bank_liquidity_short', severity: 'warning', status: 'open',
      field: 'liquidity', docValue: `${money(qualifyingTotal)} on file`, fileValue: `${money(requiredLiquidity)} required`, blocksCtc: false,
      title: 'Bank statements on file are short of the required liquidity',
      howTo: `The borrower's (and verified entity) accounts on file show ${money(qualifyingTotal)} in ending balances, but this deal requires ${money(requiredLiquidity)} in liquid assets (down payment + closing costs + reserves) — short by ${money(shortfall)}.${excludedNote} Collect additional statements, or confirm reserves, before clearing the assets condition.`,
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

module.exports = { assessBankLiquidity, readRequiredLiquidity, _internals: { accountKey } };

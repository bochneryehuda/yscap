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

// ---- Folding a NUMBER-LESS statement back into the numbered account it belongs to ----
//
// THE OWNER'S DOUBLE-COUNT (2026-07-26, live file): the assets table listed
//   MOSES WEIL / Vanderbilt ••0120   $88,454
//   MOSES WEIL / Vanderbilt          $89,474   ← same account, the account number just wasn't read
// and summed BOTH. Their words: *"You're counting the same assets twice, which is a major major
// major major issue."* The per-account collapse above was working exactly as designed — these were
// two different KEYS, because one statement's number came through and the other's did not. So the
// account number being unreadable on ONE month silently inflated the borrower's liquidity by a
// whole month's balance. Inflating liquidity is the one direction this must never fail in: it can
// clear a shortfall that is real.
//
// So a number-less statement is no longer assumed to be its own account. If exactly one NUMBERED
// account on the file has the same bank and the same holder, it is the same account and folds in.
// Ambiguity is resolved DOWNWARD, never upward: if two numbered accounts match, the balance is
// already represented by one of them and adding it again could only inflate — so it is not counted,
// and the breakdown says so.

// Bank names drift month to month ("Chase" / "JPMorgan Chase Bank, N.A." / "Chase Bank"), so compare
// on a stripped stem and accept a prefix match. Legal-form noise is removed rather than matched on,
// because it is exactly the part that drifts.
const BANK_NOISE = /\b(bank|banking|na|n a|national association|trust|company|co|corp|corporation|inc|incorporated|fsb|federal|savings|credit union|cu|financial|services|group|usa|us)\b/g;
function bankStem(s) {
  const raw = String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = raw.replace(BANK_NOISE, ' ').replace(/\s+/g, ' ').trim();
  // "US Bank", "Trust Bank", "Credit Union" are made ENTIRELY of words the noise list removes, so
  // stripping leaves nothing and every comparison bailed out — two statements from the same US Bank
  // account never folded and the owner's double-count came straight back (audit 2026-07-26). A name
  // that is entirely generic is still a name: compare it as itself rather than as nothing.
  return stripped || raw;
}
function sameBank(a, b) {
  const x = bankStem(a), y = bankStem(b);
  if (!x || !y) return false;              // a missing bank name proves nothing — never fold on it
  if (x === y) return true;
  // Compare WHOLE WORDS, not substrings. "Chase" is the same bank as "JPMorgan Chase Bank, N.A."
  // because {chase} is contained in {jpmorgan, chase} — but "Citi" is NOT "Citizens", which a
  // prefix or substring test would happily merge into one account. The shorter name's words must
  // all appear in the longer one.
  const xs = new Set(x.split(' ').filter(Boolean));
  const ys = new Set(y.split(' ').filter(Boolean));
  if (!xs.size || !ys.size) return false;
  const [small, big] = xs.size <= ys.size ? [xs, ys] : [ys, xs];
  for (const w of small) if (!big.has(w)) return false;
  return true;
}
/**
 * TWO BALANCES FOR ONE PERIOD PROVE TWO ACCOUNTS (audit 2026-07-26).
 *
 * The riskiest over-fold needs no name fuzziness at all: one holder, one bank, a CHECKING and a
 * SAVINGS, and only the savings' account number unreadable. Bank and holder match, so the fold
 * would drop a real balance — and then state in the owner's assets table that it was "the same
 * account", which is a false statement about their money.
 *
 * One account cannot end the same statement period at two different balances. So when the periods
 * are the same and the balances differ, these are demonstrably different accounts. That is a fact
 * off the two documents, not a heuristic — and it is the only thing here that can distinguish them.
 * Anything less certain (different periods, a missing period, equal balances) is left to fold, which
 * errs toward under-counting.
 */
function differentAccountsSamePeriod(a, b) {
  const pa = periodEndOf(a.rep.f.statementPeriod), pb = periodEndOf(b.rep.f.statementPeriod);
  if (pa == null || pb == null || pa !== pb) return false;   // can't compare periods → no proof
  const ba = num(a.rep.f.closingBalance), bb = num(b.rep.f.closingBalance);
  if (ba == null || bb == null) return false;                // can't compare balances → no proof
  return Math.abs(ba - bb) > 0.005;                          // same month, different money → two accounts
}

function holderStem(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function sameHolder(a, b) {
  const x = holderStem(a), y = holderStem(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // "MOSES WEIL" vs "WEIL MOSES" vs "MOSES A WEIL" — the same person, printed differently. Compare
  // as an unordered word set with containment, so a middle initial or a surname-first bank format
  // does not split one account into two.
  const xs = new Set(x.split(' ').filter((w) => w.length > 1));
  const ys = new Set(y.split(' ').filter((w) => w.length > 1));
  if (!xs.size || !ys.size) return false;
  const [small, big] = xs.size <= ys.size ? [xs, ys] : [ys, xs];
  for (const w of small) if (!big.has(w)) return false;
  return true;
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

  // FOLD number-less statements into the numbered account they belong to (see sameBank/sameHolder
  // above — the owner's Vanderbilt double-count). Done AFTER grouping so it works on whole accounts
  // rather than statement-by-statement, and so the fold can see every numbered account on the file.
  // The numbered account KEYS, not the group objects — a fold replaces the group at a key, and a
  // second number-less statement folding into the same account must see the UPDATED group, not the
  // one that existed before the first fold. Holding the objects meant the second fold compared its
  // date against a stale rank and could keep an OLDER month than the file actually holds, which is
  // precisely the frozen "count the most recent statement, not the old one" rule.
  const numberedKeys = [];
  for (const key of byAccount.keys()) if (key.startsWith('#')) numberedKeys.push(key);
  const notCountedTwice = [];   // number-less groups that were folded away, for the breakdown
  for (const [key, g] of [...byAccount]) {
    if (!key.startsWith('~')) continue;
    const f = g.rep.f;
    const matches = numberedKeys
      .map((k) => ({ key: k, g: byAccount.get(k) }))
      .filter(({ g: ng }) => ng
        && sameBank(ng.rep.f.bankName, f.bankName)
        && sameHolder(ng.rep.f.accountHolderName, f.accountHolderName)
        // TWO BALANCES FOR ONE PERIOD PROVE TWO ACCOUNTS. One account cannot end the same statement
        // period at two different numbers — so when the periods match and the balances don't, these
        // are a checking and a savings at the same bank under the same name, not one account read
        // twice. Folding them would DROP a real balance and then assert, in the owner's own assets
        // table, that it was "the same account" — a false statement about their money. This needs no
        // guesswork: it is the one thing the two statements can definitively tell us.
        && !differentAccountsSamePeriod(ng, g));
    if (!matches.length) continue;                       // a genuinely separate un-numbered account
    byAccount.delete(key);
    const holder = f.accountHolderName || '(unnamed)';
    const entry = { holder, bankName: f.bankName || null, ending: num(f.closingBalance),
      matchedAccounts: matches.map(({ g: ng }) => maskAcct(ng.rep.f)).filter(Boolean),
      ambiguous: matches.length > 1, becameRepresentative: false };
    notCountedTwice.push(entry);
    if (matches.length > 1) continue;                    // ambiguous → resolve DOWNWARD, count nothing
    // Exactly one numbered account matches: this IS that account, so its statement joins the group
    // and competes normally to be the counted (latest) month.
    const target = matches[0].g;
    const better = rankGt(g.rank, target.rank);
    // When the folded statement is the LATER month it becomes the one counted — so its balance did
    // not "go uncounted", the two statements simply merged. Saying "not counted again" about the
    // very number shown in the total would read as an error.
    entry.becameRepresentative = better;
    byAccount.set(matches[0].key, {
      rep: better ? g.rep : target.rep,
      repEnd: better ? g.repEnd : target.repEnd,
      rank: better ? g.rank : target.rank,
      count: target.count + g.count,
      // THE ACCOUNT NUMBER BELONGS TO THE ACCOUNT, NOT TO A MONTH. If the number-less statement wins
      // as the latest month, the group's representative has no number — and the assets table would
      // stop showing ••0120 even though it is right there on the other statement. That silently
      // undoes the owner's own "the assets table was missing account numbers" fix, on their exact
      // headline case. Carry it from whichever statement in the group actually has one.
      acctFrom: target.acctFrom || (maskAcct(target.rep.f) ? target.rep.f : null) || (maskAcct(f) ? f : null),
    });
  }

  const accounts = [];
  let qualifyingTotal = 0;      // ending balances of tied accounts (the borrower's real liquid assets)
  let excludedTotal = 0;        // ending balances sitting in accounts NOT tied to the borrower/entity
  const missingEnding = [];     // readable accounts with no ending balance to count
  for (const { rep, count, acctFrom } of byAccount.values()) {
    const f = rep.f;
    const holder = f.accountHolderName;
    const tied = holderMatchesFile(holder, subject);
    const ending = num(f.closingBalance);
    accounts.push({
      holder, bankName: f.bankName || null, tied, ending,
      // #244 (owner: the assets table was "missing accounts number") — last-4 only. Read from the
      // group's carried source when the counted month's own statement has no number on it, so a
      // fold can never make an account number disappear from the table.
      accountNumber: maskAcct(f) || maskAcct(acctFrom),
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
    // Say OUT LOUD when a statement was recognized as an account already on the table. The owner has
    // to be able to follow the arithmetic — a balance that silently vanishes from the list is just as
    // confusing as one counted twice, and this is the exact spot they were reading when they found
    // the Vanderbilt double-count.
    const foldedLines = (notCountedTwice || [])
      .filter((n) => !n.becameRepresentative)
      .map((n) => `  · ${n.holder}${n.bankName ? ` (${n.bankName})` : ''}: ${money(n.ending)} — ${n.ambiguous
        ? `could not be matched to one account (${n.matchedAccounts.join(' / ') || 'several'}), so it was NOT added`
        : `read as the same account as ${n.matchedAccounts.join(', ') || 'one above'} — its own number was not legible, so it is not added again. If this is a separate account, add it by hand.`}`)
      .join('\n');
    const mathNote = tiedLines
      ? ` Counted (latest statement per account, no month counted twice):\n${tiedLines}\n  = ${money(qualifyingTotal)} total.`
        + (foldedLines ? `\n Not counted again:\n${foldedLines}` : '')
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
    // Statements whose account number was unreadable and that were recognized as an account already
    // on the table. Surfaced so the breakdown can SAY a balance was deliberately not added again,
    // rather than a number quietly disappearing — the owner has to be able to see the arithmetic.
    notCountedTwice,
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

module.exports = { assessBankLiquidity, readRequiredLiquidity, _internals: { accountKey, periodEndOf, sameBank, sameHolder, bankStem } };

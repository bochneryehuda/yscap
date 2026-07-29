'use strict';
/**
 * Bank-statement findings — the assets / proof-of-funds review the owner described.
 * Two owner-critical rules, both grounded in the fraud research:
 *
 *  1) ACCOUNT OWNERSHIP. The account holder must be the borrower, or an entity the
 *     borrower controls. If the statement is under a DIFFERENT LLC/entity than the
 *     borrower (and it's not a known borrower entity), we do NOT accept it as the
 *     borrower's funds — we raise a FATAL finding requiring an OPERATING AGREEMENT
 *     that proves the borrower controls that entity (the beneficial-ownership
 *     "control prong"). This is exactly the rule: "if the bank statement is under
 *     another LLC, deflect that he's not the owner and require an operating agreement."
 *     Two ADVISORY refinements the owner added (2026-07-24), both warning-only:
 *       · BUSINESS ACCOUNT, ENTITY NOT VERIFIED. If the holder IS a known borrower
 *         entity but that entity's LLC section isn't complete/verified on the file,
 *         suggest finishing the LLC section (formation + operating agreement + EIN)
 *         so the account's funds count — "if that business is not verified… suggest
 *         to open a condition to set up a whole LLC section."
 *       · SHARED / JOINT ACCOUNT. If the borrower is on the account but it has
 *         OTHER named owners (partners), suggest an ACCESS LETTER confirming the
 *         borrower can access/use the funds — "if it's partners, if it's two people,
 *         suggest a condition for an access letter."
 *
 *  2) BALANCE MATH. Re-derive closing = opening + deposits − withdrawals. A statement
 *     whose printed balances don't reconcile is a classic tampering signal (the
 *     lowest-false-positive fraud check there is).
 *
 * Pure. `statement` = fields for the BANK_STATEMENT schema. `subject` = the loan-file
 * view the caller builds:
 *   { borrower_name, entity_names: [ ...names of LLCs the borrower is on file for... ] }
 */
const { namesMatchLoose, entityMatch, num, withinMoney } = require('./compare');

function finding(f) {
  return Object.assign(
    { source: 'bank_statement', severity: 'fatal', status: 'open', blocksCtc: f.severity !== 'warning' && f.severity !== 'info' },
    f,
  );
}
const money = (n) => (num(n) == null ? null : `$${num(n).toLocaleString('en-US')}`);

// Does the statement's holder match the borrower or any of the borrower's entities?
function holderMatchesFile(holder, subject) {
  const s = subject || {};
  if (s.borrower_name && (namesMatchLoose(holder, s.borrower_name) === true)) return true;
  for (const e of (s.entity_names || [])) {
    if (entityMatch(holder, e) === true) return true;
  }
  return false;
}

// Does a holder look like a business/entity (LLC/Inc/Corp/…)? Used to route the ownership
// finding between the "different entity → operating agreement" cascade and the personal cases.
const ENTITY_WORDS = /\b(llc|l\.l\.c|inc|corp|lp|llp|ltd|company|co|trust|holdings?|partners?|partnership|associates|assoc|group|capital|properties|property|realty|management|mgmt|investments?|enterprises?|ventures?)\b/i;
function looksEntityName(holder, holderIsBusiness) {
  return holderIsBusiness === true || ENTITY_WORDS.test(String(holder || ''));
}

// Split a PERSONAL account-holder string into its individual owners when it names more than one
// person joined by "and" / "&" / "or" / "/". Never split a business name (an LLC name legitimately
// contains "and"/"&"). Returns [] when there is no conjunction (a single holder). Comma is NOT a
// split token — "Smith, John" is last-name-first, not two people.
function splitPersonalHolders(holder) {
  const s = String(holder || '').trim();
  if (!s) return [];
  const parts = s.split(/\s+(?:and|&|or)\s+|\s*\/\s*/i).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [];
}

// Every distinct owner named on the account: the primary holder (split into individuals if it is a
// personal joint string) plus any explicit additionalHolders the extractor listed. Business holders
// stay whole. Deduped case-insensitively so "John Smith / John Smith" collapses.
function accountOwners(statement) {
  const primary = statement && statement.accountHolderName;
  const isBiz = looksEntityName(primary, statement && statement.holderIsBusiness);
  const fromPrimary = isBiz ? [primary] : (splitPersonalHolders(primary).length ? splitPersonalHolders(primary) : [primary]);
  const extra = Array.isArray(statement && statement.additionalHolders)
    ? statement.additionalHolders.filter((x) => x && String(x).trim())
    : [];
  const seen = new Set();
  const owners = [];
  for (const o of [...fromPrimary, ...extra]) {
    const k = String(o || '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    owners.push(String(o).trim());
  }
  return owners;
}

// Is the matched entity holder one PILOT has VERIFIED (LLC section complete)? Only meaningful when
// the holder already matches a known borrower entity; distinguishes "known & verified" (funds count,
// no flag) from "named but unverified" (funds count, but finish the LLC section — advisory).
function entityHolderIsVerified(holder, subject) {
  for (const e of ((subject && subject.verified_entity_names) || [])) {
    if (entityMatch(holder, e) === true) return true;
  }
  return false;
}

// Has PILOT already READ an entity document (operating agreement / articles / EIN) for this holder
// on the file? (owner 2026-07-27: "a lot of times the operating agreement is uploaded WITH the bank
// statements — look for it before raising fraud".) When true, the different-entity finding points
// at the proof already on file to VERIFY, instead of demanding a fresh upload.
function entityDocOnFile(holder, subject) {
  for (const e of ((subject && subject.entity_docs_on_file) || [])) {
    if (entityMatch(holder, e) === true) return true;
  }
  return false;
}

function computeBankFindings(statement, subject, opts = {}) {
  const out = [];
  if (!statement) return out;

  if (statement.readable === false || !statement.accountHolderName) {
    out.push(finding({ code: 'bank_unreadable', severity: 'warning', field: 'document',
      title: 'The bank statement could not be read with confidence',
      howTo: 'Review the statement by hand and confirm the account holder and balances. Request a clearer copy if needed.',
      actions: ['open_condition', 'request_revision', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
    return out;
  }

  // ---- 1. Account ownership ----
  const holder = statement.accountHolderName;
  const owners = accountOwners(statement);              // every named owner (joint split + additionalHolders)
  const borrowerIsAnOwner = owners.some((o) => holderMatchesFile(o, subject)) || holderMatchesFile(holder, subject);
  const isBusinessHolder = looksEntityName(holder, statement.holderIsBusiness);
  if (!borrowerIsAnOwner) {
    const looksEntity = isBusinessHolder;
    if (looksEntity) {
      // A bank statement under a DIFFERENT entity is NOT fraud — it is an OWNERSHIP that hasn't been
      // VERIFIED yet (owner 2026-07-27: "this is not major fraud… you need to verify the ownership
      // instead of raising crazy fraud"). So this is an ADVISORY (warning, never a CTC-blocking
      // fatal); the funds already do not count toward liquidity until the entity is established (the
      // liquidity engine excludes a non-matching holder independently), so nothing over-lends by
      // making it non-blocking. Two shapes, depending on whether the proof is already on the file:
      const docOnFile = entityDocOnFile(holder, subject);
      if (docOnFile) {
        // The operating agreement / entity documents for this holder were ALREADY uploaded (often
        // alongside the statements). Point the underwriter AT that proof to verify + add the entity,
        // rather than demand a document that is sitting right there.
        out.push(finding({ code: 'bank_account_other_entity', severity: 'warning', field: 'account_holder',
          docValue: holder, fileValue: (subject && subject.borrower_name) || null,
          title: 'Bank funds are under a different entity — verify the ownership documents already on file',
          howTo: `The statement is under "${holder}". Entity documents for "${holder}" (operating agreement / articles / EIN) appear to ALREADY be on this file — open them, confirm they show the borrower as managing member or ≥25% owner, then add "${holder}" to the file as a borrower-owned entity so its balances count. This is an ownership check, not fraud; the funds simply don't count until "${holder}" is established as the borrower's.`,
          actions: ['open_condition', 'custom', 'acknowledge', 'dismiss'], opensCondition: 'underwriting_review_cleared',
          requiresDocument: 'operating_agreement', entityName: holder, docsOnFile: true }));
      } else {
        // No entity document for this holder on the file yet → suggest posting a condition to collect
        // the ownership proof (still advisory — the funds just don't count until it's on file).
        out.push(finding({ code: 'bank_account_other_entity', severity: 'warning', field: 'account_holder',
          docValue: holder, fileValue: (subject && subject.borrower_name) || null,
          title: 'Bank funds are under a different entity — verify the borrower owns it',
          howTo: `The statement is under "${holder}", which is not the borrower or a known borrower entity — so its balances don't count as the borrower's funds YET. This is an ownership check, not fraud: post a condition to collect the documents that prove the borrower controls "${holder}" — the OPERATING AGREEMENT (borrower as managing member or ≥25% owner), the ARTICLES OF ORGANIZATION (formation), and the EIN letter — then add "${holder}" to the file as a borrower-owned entity so the funds count.`,
          actions: ['request_document', 'open_condition', 'custom', 'dismiss'], opensCondition: 'underwriting_review_cleared',
          requiresDocument: 'operating_agreement', entityName: holder }));
      }
    } else {
      // A personal account in someone else's name → not the borrower's funds.
      out.push(finding({ code: 'bank_account_not_borrower', severity: 'fatal', field: 'account_holder',
        docValue: holder, fileValue: (subject && subject.borrower_name) || null,
        title: 'Bank account is in a different name than the borrower',
        howTo: `The account holder "${holder}" does not match the borrower. Confirm whose funds these are — a third-party account is a source-of-funds flag and does not count as the borrower's assets without documentation.`,
        actions: ['request_document', 'open_condition', 'custom', 'dismiss', 'decline'] }));
    }
  } else {
    // The borrower IS an owner of this account — the funds are theirs to count. Two ADVISORY
    // refinements the owner asked for (2026-07-24), both warning-only (never block; the funds
    // already count) — they nudge the underwriter to firm up the paperwork:

    // 1a. BUSINESS ACCOUNT under a KNOWN but UNVERIFIED entity → finish the LLC section. The account
    // matches one of the borrower's entities, so it counts, but that entity's LLC section isn't
    // complete/verified on the file. Suggest opening the LLC-section condition (operating agreement +
    // formation + EIN) so the entity — and its funds — are fully established.
    // Never fabricate: only assert "unverified" when the caller ACTUALLY supplies verification status
    // (verified_entity_names present as an array — the file-view loader always does, even if empty).
    // When the caller can't tell (property absent), stay silent rather than flag every business account.
    const knowsVerification = Array.isArray(subject && subject.verified_entity_names);
    if (isBusinessHolder && knowsVerification && !entityHolderIsVerified(holder, subject)) {
      out.push(finding({ code: 'bank_business_entity_unverified', severity: 'warning', field: 'account_holder',
        docValue: holder, fileValue: (subject && subject.borrower_name) || null,
        title: 'Business bank account — the entity is on file but not yet verified',
        howTo: `The account is held by "${holder}", a business tied to the borrower — so the funds count — but that entity is not VERIFIED on the file yet (its LLC section isn't complete). Open a condition to set up / complete the LLC section for "${holder}": the OPERATING AGREEMENT (borrower as managing member or ≥25% owner), the ARTICLES OF ORGANIZATION (formation), and the EIN letter. Once "${holder}" is verified, its bank funds are fully established as the borrower's assets.`,
        actions: ['request_document', 'open_condition', 'custom', 'acknowledge', 'dismiss'], opensCondition: 'underwriting_review_cleared',
        requiresDocument: 'operating_agreement', entityName: holder }));
    } else if (!isBusinessHolder && owners.length > 1) {
      // 1b. SHARED / JOINT personal account (partners) → access letter. The borrower is one of two or
      // more owners, so they may not solely control the full balance. Suggest an access letter from
      // the co-owner(s) confirming the borrower may use these funds for the transaction.
      const others = owners.filter((o) => !(subject && subject.borrower_name && namesMatchLoose(o, subject.borrower_name) === true));
      const otherList = others.length ? others.map((o) => `"${o}"`).join(', ') : 'another party';
      out.push(finding({ code: 'bank_account_shared', severity: 'warning', field: 'account_holder',
        docValue: owners.map((o) => `"${o}"`).join(', '), fileValue: (subject && subject.borrower_name) || null,
        title: 'Joint bank account — request an access letter from the co-owner',
        howTo: `This account is held jointly — the borrower shares it with ${otherList}. The borrower may not solely control the full balance. Open a condition for an ACCESS LETTER: a signed statement from ${otherList} confirming the borrower has full access to and use of these funds for this transaction. Without it, only the borrower's provable share can be relied on toward the liquidity requirement.`,
        actions: ['request_document', 'open_condition', 'custom', 'acknowledge', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
    }
  }

  // ---- 2. Balance math (tampering signal) ----
  const open = num(statement.openingBalance), close = num(statement.closingBalance);
  const dep = num(statement.totalDeposits), wd = num(statement.totalWithdrawals);
  if (open != null && close != null && dep != null && wd != null) {
    const expected = open + dep - wd;
    // tolerance: $1 or 0.5% of the closing balance, whichever is larger (rounding noise)
    const tol = Math.max(1, Math.abs(close) * 0.005);
    if (Math.abs(close - expected) > tol) {
      out.push(finding({ code: 'bank_math_inconsistent', severity: 'warning', field: 'balances',
        docValue: `${money(close)} vs ${money(open)} + ${money(dep)} − ${money(wd)} = ${money(expected)}`, fileValue: null,
        title: 'Bank statement balances do not reconcile',
        howTo: `Closing ${money(close)} should equal opening ${money(open)} plus deposits ${money(dep)} minus withdrawals ${money(wd)} (= ${money(expected)}). A statement that doesn't add up can indicate alteration — review the source document carefully.`,
        actions: ['request_revision', 'open_condition', 'acknowledge', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
    }
  }

  // ---- 2b. Missing-page detection (owner-directed 2026-07-22, R3.11) ----
  // The statement usually says "Page X of Y" on each page. If X<Y for the LAST readable
  // page, pages are missing (a common straw-funds concealer — the missing pages hold the
  // transactions that would expose the source). We accept THREE signal shapes from the
  // extractor: (a) statement.declaredPageCount (Y from "Page X of Y"), (b) statement.pageNumbers
  // (an array like [1,2,4,5,6] with a gap), or (c) statement.pageCount (the actual OCR'd page count)
  // combined with declaredPageCount. Only fires when we can prove missing pages.
  const declaredTotal = num(statement.declaredPageCount);
  const actualCount = num(statement.pageCount);
  // map FIRST (fix 2026-07-23): string page numbers from AI/JSON ('1','2')
  // silently disarmed the missing-page detector. Audit fix (same day): a bare
  // Number() turns null/'' entries into 0 (Number(null)===0), which would
  // survive the isFinite filter as a phantom "page 0" and fabricate a FATAL
  // missing-page finding — null/blank entries must drop out, not become 0.
  const pageNum = (x) => (x == null || String(x).trim() === '' ? NaN : Number(x));
  const nums = Array.isArray(statement.pageNumbers) ? statement.pageNumbers.map(pageNum).filter(Number.isFinite).sort((a, b) => a - b) : null;
  let missing = null;
  if (nums && nums.length && declaredTotal != null) {
    const expected = Array.from({ length: declaredTotal }, (_, i) => i + 1);
    const gaps = expected.filter((p) => !nums.includes(p));
    if (gaps.length) missing = { gaps, total: declaredTotal, have: nums };
  } else if (nums && nums.length > 1) {
    // Gap inside the numbered set (e.g. [1,2,4,5]) even without declared total.
    const min = nums[0], max = nums[nums.length - 1];
    const gaps = [];
    for (let p = min; p <= max; p += 1) if (!nums.includes(p)) gaps.push(p);
    if (gaps.length) missing = { gaps, total: max, have: nums };
  } else if (declaredTotal != null && actualCount != null && actualCount < declaredTotal) {
    missing = { gaps: null, total: declaredTotal, have: actualCount };
  }
  if (missing) {
    const label = missing.gaps
      ? `missing page(s) ${missing.gaps.join(', ')} of ${missing.total}`
      : `${missing.have} of ${missing.total} pages present`;
    out.push(finding({ code: 'bank_missing_page', severity: 'fatal', field: 'pages',
      docValue: label, fileValue: null,
      title: 'Bank statement is missing pages',
      howTo: `The statement is incomplete — ${label}. A missing page can hide a large transfer, a co-holder disclosure, or reversed activity. Request the FULL statement (every page, front and back) before this counts as proof of funds.`,
      actions: ['request_revision', 'open_condition', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }

  // ---- 3. Large deposit sourcing (Fannie B3-4.2-02) ----
  // A single deposit that dominates the period's inflows needs to be SOURCED — an unsourced large
  // deposit can't count toward funds and is a straw-buyer / gifted-funds signal. We don't have the
  // borrower's income here, so we approximate "large" as a single deposit that is the majority
  // (>50%) of total deposits AND a material amount. Warning-only; requires documentation.
  const largest = num(statement.largestDeposit);
  if (largest != null && dep != null && dep > 0 && largest > 5000 && largest > dep * 0.5) {
    const pctShown = Math.min(100, Math.round((largest / dep) * 100));  // clamp odd >100% on inconsistent data
    out.push(finding({ code: 'bank_large_deposit', severity: 'warning', field: 'deposits',
      docValue: `${money(largest)} of ${money(dep)} total deposits (${pctShown}%)`, fileValue: null,
      title: 'A single large deposit needs to be sourced',
      howTo: `One deposit of ${money(largest)} is most of the period's deposits (${money(dep)}). Source it (payroll, sale of an asset, transfer from another owned account) — an unsourced large deposit can't be counted toward the borrower's funds and can signal gifted or third-party money.`,
      actions: ['request_document', 'open_condition', 'acknowledge', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }

  return out;
}

function summarize(findings) {
  const open = (findings || []).filter((f) => f.status === 'open');
  return {
    fatal: open.filter((f) => f.severity === 'fatal').length,
    warning: open.filter((f) => f.severity === 'warning').length,
    info: open.filter((f) => f.severity === 'info').length,
    blocksCtc: open.some((f) => f.severity === 'fatal' && f.blocksCtc),
  };
}

module.exports = { computeBankFindings, summarize, _internals: { holderMatchesFile, accountOwners, splitPersonalHolders, looksEntityName, entityHolderIsVerified } };

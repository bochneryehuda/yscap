'use strict';
/**
 * ASSIGNMENT / WHOLESALE CHAIN — read a purchase CONTRACT one way and an ASSIGNMENT another way
 * (owner-directed 2026-08-02).
 *
 * The owner's report: "the system needs to understand that when it reviews the price on the contract
 * it needs to find the ORIGINAL SELLER — the one listed on the title report and on the appraisal as
 * the seller of record / owner of public records. The underlying purchase price from our file needs
 * to match THAT contract and THAT seller's name. Then the BUYER of that contract needs to be the
 * SELLER on the next flip contract / the assignment of contract, and the price over there — either
 * the flip fee or the final purchase price, because they write one or the other — needs to match the
 * flip fee or the final purchase price on our file. Right now it doesn't understand it has to look at
 * a contract one way and an assignment a different way. There are a lot of bodies — a seller, a
 * flipper and an end buyer — and everything needs to be tied up: the dollar amounts and the chain."
 *
 * So a wholesale deal is TWO LEGS of paper and THREE BODIES:
 *
 *   ORIGINAL SELLER ──(leg 1: the seller's purchase contract, price = the UNDERLYING price)──▶ FLIPPER
 *   FLIPPER ──(leg 2: the assignment / flip contract, amount = the FLIP FEE **or** the FINAL price)──▶ END BUYER
 *
 * and the money must close: underlying price + flip fee = final purchase price, on the DOCUMENTS and
 * on the loan file, and the two must agree with each other.
 *
 * WHAT THIS MODULE OWNS (nothing else in the stack does any of it):
 *   1. LEG CLASSIFICATION — which purchase contract is the seller's underlying contract and which is
 *      the downstream flip contract. Everything else (chain-of-title, seller-chain) reads only the
 *      FIRST contract on the file and cannot tell the two apart, which is why a flip contract's
 *      seller (the flipper) was being compared against the original seller as if it were the same
 *      party — the guaranteed-nonsense mismatch behind the all-red "Seller" row.
 *   2. THE SELLER-ROLE MAP the tie-out needs, so each document's "Seller" is compared to the party
 *      whose role that document actually speaks to.
 *   3. THE MONEY CHAIN across both legs and the loan file, in the two shapes the paper comes in
 *      (a stated flip fee, or a stated final price) — the owner's "either one" rule.
 *
 * NON-DUPLICATIVE by construction. Deliberately NOT re-raised here:
 *   · owner of record ↔ contract seller, assignor ↔ prior holder, final buyer ↔ vesting entity →
 *     `chain-of-title.js` (cot_*).  · contract-in-personal-name → `seller-chain.js`.
 *   · a STATED contract/assignment fee or underlying price vs the file → `purchase-contract-checks.js`
 *     and the tie-out's own `assignment_fee` / `underlying_price` facts. This module only speaks up
 *     about the amounts NOBODY compares today (a leg's own price, and a flip amount that has to be
 *     DERIVED because the paper stated the other number).
 *
 * ADVISORY ONLY, like every other chain module: every finding is `warning`/`info` with
 * `blocksCtc:false`. NEVER FABRICATES — a party or an amount we cannot read is left null and the
 * check is skipped; a role is only assigned on positive proof from another document, never guessed.
 *
 * PURE — no DB, no AI, never throws.
 */
const { num, withinMoney } = require('./compare');
const { borrowerName, feeIsTotal } = require('./facts');
const { _internals: { sameParty, partyInList } } = require('./seller-chain');

const TOL = 1;                       // dollars — same tolerance the rest of the tie-out uses
const money = (n) => (num(n) == null ? '—' : `$${num(n).toLocaleString('en-US')}`);
const list = (a) => (a && a.length ? a.join(', ') : '—');

function toList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
}

/**
 * Normalize the caller's sources to one shape, KEEPING the index so the id we key the role map on is
 * byte-identical to the one buildTieout assigns its columns (`s.id || `${docType}_${i}``). The two
 * must agree or the tie-out would look up a role that isn't there.
 */
function normalizeSources(exts) {
  const out = [];
  (exts || []).forEach((x, ix) => {
    if (!x) return;
    const docType = x.doc_type || x.docType || null;
    if (!docType) return;
    out.push({
      id: x.id || `${docType}_${ix}`,
      documentId: x.documentId != null ? x.documentId : (x.document_id != null ? x.document_id : null),
      docType,
      label: x.label || null,
      fields: x.fields || {},
    });
  });
  return out;
}
const ofType = (srcs, docType) => srcs.filter((s) => s.docType === docType);

// Collapse names that are the same party (LLC vs L.L.C., re-spacing) to one entry, first spelling wins.
function dedupeParties(names) {
  const out = [];
  for (const n of names) {
    if (!n) continue;
    if (out.some((k) => sameParty(k, n) === true)) continue;
    out.push(n);
  }
  return out;
}

/**
 * Build the assignment chain.
 * @param {object} ctx  { app, borrower, vestingName }  (the file-view context the tie-out uses)
 * @param {Array}  exts sources — [{ id?, doc_type|docType, fields }]
 */
function buildAssignmentChain(fileCtx, exts) {
  // An explicit null must behave like an absent argument — a default parameter would not catch it,
  // and every caller here is a best-effort path that must never throw.
  const ctx = fileCtx || {};
  const app = ctx.app || {};
  const vesting = ctx.vestingName || null;
  const person = borrowerName(ctx.borrower) || null;

  const srcs = normalizeSources(exts);
  const contracts = ofType(srcs, 'purchase_contract');
  const assignments = ofType(srcs, 'assignment');
  const titles = ofType(srcs, 'title');
  const appraisals = ofType(srcs, 'appraisal');
  const settlements = ofType(srcs, 'settlement');

  const fileSaysAssignment = !!app.is_assignment;
  // A document can also PROVE the deal is a wholesale even before the file is marked one.
  const docsSayAssignment = assignments.length > 0 || contracts.some((c) => c.fields.isAssignment === true);
  const isAssignment = fileSaysAssignment || docsSayAssignment;

  // ── 1. THE ORIGINAL SELLER — the public record is the authority ────────────────────────────────
  // The title report's vested owner(s) and the appraisal's owner of record / seller of public
  // records: the owner's own list of where the original seller is stated.
  const ownerOfRecord = dedupeParties([
    ...titles.flatMap((t) => toList(t.fields.vestedOwners)),
    ...appraisals.flatMap((a) => toList(a.fields.ownerOfRecord || a.fields.owner_of_record || a.fields.sellerNames || a.fields.sellerName)),
  ]);
  // The public record does not always speak with one voice — two title reports can name different
  // vested owners. That disagreement is the TIE-OUT's finding (it owns the seller mismatch), but the
  // chain must not then draw itself as "intact" beside a red Seller row: it would be claiming the
  // original seller is settled when the documents are still arguing about who it is.
  const ownerOfRecordDisputed = ownerOfRecord.some((a, i) =>
    ownerOfRecord.some((b, j) => j > i && sameParty(a, b) === false));

  // Is this name our side of the deal (the borrower or the vesting entity)? Such a party can never
  // be the flipper — otherwise a straight assignment where WE are the contract buyer would read as
  // its own middleman.
  const isEndSide = (n) => (!!vesting && sameParty(n, vesting) === true) || (!!person && sameParty(n, person) === true);

  // ── 2. THE FLIPPER — only ever assigned on PROOF from a document ───────────────────────────────
  //  (a) an assignment names its assignor outright — the strongest evidence there is;
  //  (b) the BUYER on a contract whose SELLER is the owner of record is, by definition, the party in
  //      the middle. When there is no title/appraisal to establish the record owner, the file's own
  //      captured seller price identifies the same contract.
  const flipperRaw = [];
  for (const a of assignments) flipperRaw.push(...toList(a.fields.assignorName));
  const fileUnder = num(app.underlying_contract_price);
  for (const c of contracts) {
    const sellers = toList(c.fields.sellerNames);
    if (!sellers.length) continue;
    const sellerIsRecordOwner = ownerOfRecord.length ? partyInList(sellers[0], ownerOfRecord) === true : null;
    const priceIsUnderlying = fileUnder != null ? withinMoney(c.fields.purchasePrice, fileUnder, TOL) === true : false;
    if (sellerIsRecordOwner === true || (sellerIsRecordOwner === null && priceIsUnderlying)) {
      flipperRaw.push(...toList(c.fields.buyerName));
    }
  }
  const flipperNames = dedupeParties(flipperRaw.filter((n) => !isEndSide(n)));

  // ── 3. THE SELLER ROLE OF EACH DOCUMENT ───────────────────────────────────────────────────────
  // A document's "seller" is read as the FLIPPER only when it positively matches a proven middle
  // party AND is not itself the owner of record. Anything else stays the original seller — so an
  // unreadable or unproven chain behaves exactly as it did before this module existed.
  const sellerRoleBySource = Object.create(null);
  const roleForSeller = (sellerName) => {
    if (!sellerName) return 'origin';
    const isOrigin = ownerOfRecord.length ? partyInList(sellerName, ownerOfRecord) === true : false;
    const isFlipper = flipperNames.length ? partyInList(sellerName, flipperNames) === true : false;
    return (isFlipper && !isOrigin) ? 'flipper' : 'origin';
  };
  for (const c of contracts) sellerRoleBySource[c.id] = roleForSeller(toList(c.fields.sellerNames)[0]);
  // A settlement statement on a double close conveys FROM the flipper; on a direct deed it conveys
  // from the original seller. Same proof rule decides.
  for (const s of settlements) sellerRoleBySource[s.id] = roleForSeller(toList(s.fields.sellerName)[0]);
  // The ASSIGNMENT document's `sellerName` is the UNDERLYING seller by schema definition (the party
  // the assignor is buying from), and title / the appraisal always state the owner of record.
  for (const a of assignments) sellerRoleBySource[a.id] = 'origin';
  for (const t of titles) sellerRoleBySource[t.id] = 'origin';
  for (const a of appraisals) sellerRoleBySource[a.id] = 'origin';

  // ── 4. THE TWO LEGS ───────────────────────────────────────────────────────────────────────────
  const flipContracts = contracts.filter((c) => sellerRoleBySource[c.id] === 'flipper');
  const underlyingContracts = contracts.filter((c) => sellerRoleBySource[c.id] !== 'flipper');
  // A contract that carries its OWN wholesale terms (an assignment addendum on the same paper)
  // states the TOTAL in `purchasePrice` and the seller's price in `underlyingPrice` — so its
  // `purchasePrice` must never be read as the underlying price.
  const carriesOwnAssignment = (c) => c.fields.isAssignment === true
    || num(c.fields.underlyingPrice) != null || num(c.fields.assignmentFee) != null;

  // WHO THE ORIGINAL SELLER IS, is a question the PUBLIC RECORD answers — the title report's vested
  // owner, the appraisal's owner of record, and the assignment's own statement of the party being
  // bought from. A contract seller joins that answer only when it MATCHES one of them: a contract
  // naming somebody else is a discrepancy to surface, never a second right answer to be measured
  // against (which would quietly excuse the very stranger this module exists to catch). With no
  // public record on file at all, the contracts are the only thing there is to go on.
  const recordAnchors = dedupeParties([
    ...ownerOfRecord,
    ...assignments.flatMap((a) => toList(a.fields.sellerName)),
  ]);
  const contractSellers = underlyingContracts.flatMap((c) => toList(c.fields.sellerNames));
  const originalSellerNames = recordAnchors.length
    ? dedupeParties([...recordAnchors, ...contractSellers.filter((n) => partyInList(n, recordAnchors) === true)])
    : dedupeParties(contractSellers);
  const endBuyerNames = dedupeParties([
    ...assignments.flatMap((a) => toList(a.fields.assigneeName)),
    ...flipContracts.flatMap((c) => toList(c.fields.buyerName)),
  ]);

  // ── 5. THE MONEY, on the documents ────────────────────────────────────────────────────────────
  // `from` records WHERE each number came from, because that decides whether another check already
  // owns the comparison (a stated field) or whether nobody does (a leg's own price).
  let docUnder = null, docUnderFrom = null, docUnderKind = null;
  for (const a of assignments) {
    const v = num(a.fields.originalPurchasePrice);
    if (v != null) { docUnder = v; docUnderFrom = 'the assignment of contract'; docUnderKind = 'assignment_field'; break; }
  }
  if (docUnder == null) {
    for (const c of contracts) {
      const v = num(c.fields.underlyingPrice);
      if (v != null) { docUnder = v; docUnderFrom = 'the purchase contract'; docUnderKind = 'contract_field'; break; }
    }
  }
  if (docUnder == null) {
    for (const c of underlyingContracts) {
      if (carriesOwnAssignment(c)) continue;
      const v = num(c.fields.purchasePrice);
      if (v != null) { docUnder = v; docUnderFrom = "the seller's purchase contract"; docUnderKind = 'leg_price'; break; }
    }
  }

  let docTotal = null, docTotalFrom = null;
  for (const a of assignments) {
    const v = num(a.fields.totalPriceToAssignee);
    if (v != null) { docTotal = v; docTotalFrom = 'the assignment of contract'; break; }
  }
  if (docTotal == null) {
    for (const c of flipContracts.concat(contracts.filter(carriesOwnAssignment))) {
      const v = num(c.fields.purchasePrice);
      if (v != null) { docTotal = v; docTotalFrom = 'the flip contract'; break; }
    }
  }

  let docFee = null, docFeeFrom = null;
  for (const a of assignments) {
    const v = num(a.fields.assignmentFee);
    // The extractor sometimes drops a PRICE into the fee field — the same quarantine facts.js applies.
    if (v != null && !feeIsTotal(v, a.fields.totalPriceToAssignee, a.fields.originalPurchasePrice)
        && !feeIsTotal(v, docTotal, docUnder)) { docFee = v; docFeeFrom = 'the assignment of contract'; break; }
  }
  if (docFee == null) {
    for (const c of contracts) {
      const v = num(c.fields.assignmentFee);
      if (v != null && !feeIsTotal(v, c.fields.purchasePrice, c.fields.underlyingPrice)
          && !feeIsTotal(v, docTotal, docUnder)) { docFee = v; docFeeFrom = 'the purchase contract'; break; }
    }
  }

  // ── 6. The money, on the loan file ────────────────────────────────────────────────────────────
  const fileFee = num(app.assignment_fee);
  const fileTotal = num(app.purchase_price);

  // THE FLIP AMOUNT — the one number that makes the owner's "either one" rule checkable. The paper
  // states either the fee or the final price; whichever it states, the amount the end buyer pays ON
  // TOP of the seller's price is the same thing, so resolve both sides to it and compare.
  const round2 = (n) => Math.round(n * 100) / 100;
  const docFlip = docFee != null ? docFee
    : (docTotal != null && docUnder != null ? round2(docTotal - docUnder) : null);
  const fileFlip = fileFee != null ? fileFee
    : (fileTotal != null && fileUnder != null ? round2(fileTotal - fileUnder) : null);
  const docFlipDerived = docFee == null && docFlip != null;

  const agrees = (a, b) => (a == null || b == null ? null : Math.abs(a - b) <= TOL);

  const findings = [];
  const mk = (o) => Object.assign({
    source: 'assignment_chain', status: 'open', blocksCtc: false,
    actions: ['post_condition', 'request_document', 'fix_file', 'dismiss'],
    opensCondition: 'underwriting_review_cleared',
  }, o);

  if (isAssignment) {
    // ── F1. Leg 1: the seller's own contract price vs the seller price on our file ──────────────
    // ONLY when the number came from the underlying contract's OWN price line. A stated
    // `underlyingPrice` field (contract) or `originalPurchasePrice` (assignment) is already compared
    // by purchase-contract-checks / the tie-out's underlying_price fact — never duplicate those.
    if (docUnderKind === 'leg_price' && agrees(docUnder, fileUnder) === false) {
      findings.push(mk({
        code: 'asg_underlying_price_mismatch', severity: 'warning', field: 'underlying_contract_price',
        docValue: money(docUnder), fileValue: money(fileUnder),
        title: "The seller's contract price doesn't match the seller's price on the file",
        howTo: `The contract with the original seller (${list(originalSellerNames)}) is for ${money(docUnder)}, but the file records the seller's original price as ${money(fileUnder)}. On a wholesale deal that price is the basis for the whole structure — the 15% financeable-fee cap is taken off it — so it has to match the seller's contract exactly. Confirm which figure is right and correct the file or get the right contract.`,
      }));
    }

    // ── F2. Leg 2: the flip amount, whichever way the paper states it ───────────────────────────
    // The straight "stated fee vs file fee" compare belongs to purchase-contract-checks and the
    // tie-out's assignment_fee fact. What nobody checks is the DERIVED case — the paper states the
    // final price and leaves the fee implied, or the file leaves the fee blank and implies it from
    // the price jump. That's the half of the owner's "either one" rule that was falling through.
    // ONE BROKEN NUMBER IS ONE FINDING. When the final price agrees on both sides and the only
    // figure out of step is the seller's price, the flip fee is off purely as a consequence — F1
    // (or the underlying_price fact) already says the whole thing, so saying it twice is noise.
    const feeComparedElsewhere = docFee != null && fileFee != null;
    const underlyingDisagrees = agrees(docUnder, fileUnder) === false;
    const finalAgrees = agrees(docTotal, fileTotal) === true;
    if (!feeComparedElsewhere && !(underlyingDisagrees && finalAgrees) && agrees(docFlip, fileFlip) === false) {
      const docSide = docFlipDerived
        ? `${docTotalFrom || 'the flip paper'} shows a final price of ${money(docTotal)} against a seller price of ${money(docUnder)}, which makes the flip fee ${money(docFlip)}`
        : `${docFeeFrom || 'the flip paper'} states a flip fee of ${money(docFlip)}`;
      const fileSide = fileFee != null
        ? `the file records a ${money(fileFee)} assignment fee`
        : `the file's ${money(fileTotal)} purchase price over a ${money(fileUnder)} seller price makes the fee ${money(fileFlip)}`;
      findings.push(mk({
        code: 'asg_flip_amount_unreconciled', severity: 'warning', field: 'assignment_fee',
        docValue: money(docFlip), fileValue: money(fileFlip),
        title: "The flip amount on the paperwork doesn't match the file",
        howTo: `${cap(docSide)}, but ${fileSide}. The seller's price plus the flip fee has to equal the final purchase price on the file, on the documents and on our side. Reconcile the seller price, the flip fee and the final price so all three agree.`,
      }));
    }

    // ── F3. The flip amount is nowhere on the paperwork ─────────────────────────────────────────
    if ((assignments.length || flipContracts.length) && docFee == null && docTotal == null) {
      findings.push(mk({
        code: 'asg_flip_amount_unstated', severity: 'info', field: 'assignment_fee',
        docValue: null, fileValue: fileFee != null ? money(fileFee) : (fileFlip != null ? money(fileFlip) : null),
        title: 'The assignment paperwork does not state the flip amount',
        howTo: `The assignment on file names the parties but states neither a flip fee nor a final price to the new buyer, so there is nothing to check the file's ${fileFee != null ? `${money(fileFee)} assignment fee` : 'assignment economics'} against. Ask for the fully-executed assignment (or the flip contract) showing the fee or the final purchase price.`,
        actions: ['request_document', 'post_condition', 'dismiss'],
      }));
    }

    // ── F4. No assignment paperwork at all ──────────────────────────────────────────────────────
    if (fileSaysAssignment && !assignments.length && !flipContracts.length
        && !contracts.some(carriesOwnAssignment)) {
      findings.push(mk({
        code: 'asg_missing_assignment_paper', severity: 'warning', field: 'is_assignment',
        docValue: null, fileValue: fileFee != null ? money(fileFee) : 'assignment',
        title: 'The file is a wholesale deal but there is no assignment of contract on file',
        howTo: `The file is marked as an assignment${fileFee != null ? ` with a ${money(fileFee)} fee` : ''}, but no assignment of contract (or flip contract naming the wholesaler as seller) has been read. Without it the chain from the original seller through the wholesaler to ${vesting || 'the borrowing entity'} cannot be confirmed. Request the signed assignment.`,
        actions: ['request_document', 'post_condition', 'dismiss'],
      }));
    }

    // ── F5. No underlying contract behind the assignment ────────────────────────────────────────
    if (assignments.length && !contracts.length) {
      findings.push(mk({
        code: 'asg_missing_underlying_contract', severity: 'info', field: 'seller',
        docValue: list(originalSellerNames) === '—' ? null : list(originalSellerNames), fileValue: money(fileUnder),
        title: "The seller's original contract is not on file",
        howTo: `There is an assignment of contract on file but not the underlying purchase contract it assigns, so the original seller and the ${money(fileUnder)} seller price can't be confirmed against the contract they came from. Request the seller's fully-executed purchase contract.`,
        actions: ['request_document', 'post_condition', 'dismiss'],
      }));
    }

    // ── F6. The flip contract's seller must be the buyer on the seller's contract ────────────────
    // The owner's rule literally: "the buyer of that contract needs to be the seller on the next flip
    // contract". Only fires on a DOWNSTREAM contract — one selling to our side — whose seller is
    // neither a proven middle party nor the original seller. (The ASSIGNMENT document's assignor is
    // chain-of-title's `cot_assignor_never_held_title`; this is the two-contract shape it can't see,
    // because it only ever reads the first contract on the file.)
    const upstreamBuyers = dedupeParties(underlyingContracts.flatMap((c) => toList(c.fields.buyerName)));
    for (const c of contracts) {
      const buyers = toList(c.fields.buyerName);
      const sellers = toList(c.fields.sellerNames);
      if (!buyers.length || !sellers.length) continue;
      if (!buyers.some(isEndSide)) continue;                       // not the contract that sells to us
      if (!upstreamBuyers.length && !flipperNames.length) continue; // nothing proven to compare against
      const knownMiddle = dedupeParties([...upstreamBuyers, ...flipperNames].filter((n) => !isEndSide(n)));
      if (!knownMiddle.length) continue;
      const isMiddle = partyInList(sellers[0], knownMiddle);
      const isOrigin = originalSellerNames.length ? partyInList(sellers[0], originalSellerNames) : null;
      if (isMiddle === false && isOrigin !== true) {
        findings.push(mk({
          code: 'asg_flip_seller_not_flipper', severity: 'warning', field: 'seller',
          docValue: list(sellers), fileValue: list(knownMiddle),
          title: 'The contract selling to us is not signed by the party who holds the deal',
          howTo: `The contract that sells to ${vesting || 'the borrowing entity'} names ${list(sellers)} as the seller, but the party who bought from the original seller — and therefore the only one who can sell or assign the deal on — is ${list(knownMiddle)}. The buyer on the seller's contract has to be the seller on the flip contract. Confirm the missing link (another assignment) or treat it as a wholesale-chain red flag.`,
        }));
        break; // one is enough — the chain is either connected or it isn't
      }
    }
  }

  // ── 7. The view: the two legs and the three bodies, for the desk ──────────────────────────────
  const docsOn = (arr) => arr.map((d) => ({ id: d.id, documentId: d.documentId, label: d.label, docType: d.docType }));
  const legs = isAssignment ? [
    {
      key: 'underlying', label: "The seller's contract",
      fromRole: 'Original seller', from: originalSellerNames,
      toRole: 'Flipper (wholesaler)', to: flipperNames,
      amountLabel: "Seller's price", amount: docUnder, fileAmount: fileUnder,
      agrees: agrees(docUnder, fileUnder), documents: docsOn(underlyingContracts),
    },
    {
      key: 'flip', label: 'The assignment / flip contract',
      fromRole: 'Flipper (wholesaler)', from: flipperNames,
      toRole: 'End buyer (our borrower)', to: endBuyerNames.length ? endBuyerNames : (vesting ? [vesting] : []),
      amountLabel: 'Flip fee', amount: docFlip, fileAmount: fileFlip,
      agrees: agrees(docFlip, fileFlip), documents: docsOn(flipContracts.concat(assignments)),
    },
  ] : [];

  // Does the chain end where the loan vests? The FINDING for a chain that doesn't is chain-of-title's
  // and seller-chain's — this only decides whether the card may call itself intact.
  const reachesVesting = (vesting && endBuyerNames.length)
    ? endBuyerNames.some((n) => sameParty(n, vesting) === true) : null;
  const status = !isAssignment ? 'not_assignment'
    : (findings.some((f) => f.severity === 'warning') ? 'broken'
      : ((originalSellerNames.length && flipperNames.length && endBuyerNames.length
          && !ownerOfRecordDisputed && reachesVesting === true
          && agrees(docFlip, fileFlip) === true) ? 'intact' : 'incomplete'));

  return {
    isAssignment, fileSaysAssignment, docsSayAssignment, status, reachesVesting,
    parties: {
      originalSeller: originalSellerNames,
      flipper: flipperNames,
      endBuyer: endBuyerNames,
      vestingEntity: vesting || null,
      ownerOfRecord,
      ownerOfRecordDisputed,
    },
    legs,
    money: {
      file: { underlying: fileUnder, fee: fileFee, total: fileTotal, flip: fileFlip },
      documents: { underlying: docUnder, underlyingFrom: docUnderFrom, fee: docFee, feeFrom: docFeeFrom,
        total: docTotal, totalFrom: docTotalFrom, flip: docFlip, flipDerived: docFlipDerived },
      underlyingAgrees: agrees(docUnder, fileUnder),
      flipAgrees: agrees(docFlip, fileFlip),
      totalAgrees: agrees(docTotal, fileTotal),
    },
    // For the tie-out: which seller each document is talking about.
    sellerRoleBySource,
    originalSellerNames,
    flipperNames,
    findings,
  };
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

module.exports = { buildAssignmentChain, _internals: { normalizeSources, dedupeParties } };

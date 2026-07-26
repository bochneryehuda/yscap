'use strict';
/**
 * CHAIN OF TITLE / OWNERSHIP TRACE — the multi-hop reconciliation the owner asked for:
 * follow the property's ownership across every document and confirm the names line up at each hop:
 *
 *   owner of record (public records / title)  →  seller on the purchase contract
 *      →  buyer on the contract (the first assignor)  →  assignee₁  →  assignee₂ …  →  vesting entity
 *
 * Every seller/assignor/assignee/buyer name must reconcile DOWN the chain. A broken link — the
 * contract seller isn't the record owner, an assignment hops through a party who never held title,
 * or the final buyer isn't the vesting entity — is an ADVISORY finding (warning/info, NEVER a block).
 *
 * Relationship to the neighbours (NO duplication):
 *   · `seller-chain.js` (buildSellerChain) draws the ordered node/edge VIEW and owns the
 *     personal-name→LLC suggestion. It reads only the FIRST assignment and ignores the assignment
 *     doc's own assignor/seller. This module reuses its matching primitives (sameParty / partyInList /
 *     isEntityName) but adds what it can't express: the ORDERED, MULTI-HOP, per-adjacent-pair
 *     reconciliation (assignor N must be the party who held it after hop N-1).
 *   · The tie-out (`facts.js`) owns the FATAL `seller_name` / entity mismatch across the whole
 *     seller/buyer buckets. This module does NOT re-raise those fatals — its findings are advisory
 *     topology notes, and the personal-name case is deferred to seller-chain (de-duped in the route).
 *
 * Pure: no DB, no AI. `(ctx, exts)` is the same shape buildSellerChain takes.
 */
const { borrowerName } = require('./file-view');
const { _internals: { sameParty, partyInList, isEntityName } } = require('./seller-chain');

function fieldsFor(exts, docType) {
  return (exts || []).filter((x) => (x.doc_type || x.docType) === docType).map((x) => x.fields || {});
}
function firstFields(exts, docType) {
  const a = fieldsFor(exts, docType);
  return a.length ? a[0] : null;
}
function toList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
}
// Sort assignments oldest → newest by assignmentDate (unparseable/absent dates keep input order,
// after the dated ones) so a multi-hop chain reads assignor→assignee in the real transfer order.
function orderedAssignments(exts) {
  const list = fieldsFor(exts, 'assignment').map((f, ix) => ({ f, ix, t: Date.parse(String((f && f.assignmentDate) || '')) }));
  return list
    .sort((a, b) => {
      const at = Number.isFinite(a.t), bt = Number.isFinite(b.t);
      if (at && bt) return a.t - b.t || a.ix - b.ix;
      if (at) return -1;
      if (bt) return 1;
      return a.ix - b.ix;
    })
    .map((x) => x.f);
}

const mk = (o) => Object.assign({ source: 'chain_of_title', status: 'open', blocksCtc: false }, o);

/**
 * @param {object} ctx  { borrower, vestingName, app }
 * @param {Array}  exts current extractions [{doc_type, fields}]
 * @returns {{ hops, ownershipPath, finalBuyer, reachesVesting, status, findings }}
 */
function buildChainOfTitle(ctx = {}, exts = []) {
  const vesting = ctx.vestingName || null;
  const person = borrowerName(ctx.borrower) || null;

  const title = firstFields(exts, 'title');
  const contract = firstFields(exts, 'purchase_contract');
  const appraisal = firstFields(exts, 'appraisal');
  const assignments = orderedAssignments(exts);

  // ── Parties read off the documents ────────────────────────────────────────
  const ownerOfRecord = [
    ...toList(title && title.vestedOwners),
    ...toList(appraisal && (appraisal.sellerNames || appraisal.ownerOfRecord || appraisal.sellerName)),
  ];
  const contractSeller = toList(contract && contract.sellerNames);
  const contractBuyer = toList(contract && contract.buyerName);

  // ── Build the ORDERED ownership path (present links only kept for display) ─
  const path = [];
  const addNode = (role, names, source) => { const arr = toList(names); path.push({ role, names: arr, name: arr[0] || null, present: arr.length > 0, source }); };
  addNode('Owner of record', ownerOfRecord, title ? 'Title report' : (appraisal ? 'Appraisal' : null));
  addNode('Seller on contract', contractSeller, contract ? 'Purchase contract' : null);
  addNode('Buyer on contract', contractBuyer, contract ? 'Purchase contract' : null);
  assignments.forEach((a, i) => {
    // Each assignment carries its OWN parties: assignor (should be the prior holder) → assignee.
    addNode(`Assignor (assignment ${i + 1})`, toList(a.assignorName), 'Assignment');
    addNode(`Assignee (assignment ${i + 1})`, toList(a.assigneeName), 'Assignment');
  });
  addNode('Vesting entity (our borrower)', vesting ? [vesting] : [], 'Loan file');

  // The party at the END of the purchase chain (last assignee, else the contract buyer).
  const lastAssignee = assignments.length ? toList(assignments[assignments.length - 1].assigneeName) : [];
  const finalBuyer = (lastAssignee[0] || contractBuyer[0]) || null;

  const findings = [];
  const verdictOf = (r) => (r === true ? 'ok' : r === false ? 'break' : 'unknown');

  // THE MARK MUST LAND ON THE STEP IT DESCRIBES (owner-reported 2026-07-26).
  //
  // On their file the chain read Michael Moran → Michael Moran → Moshe Weil, which is CONSISTENT,
  // and the real break is the next step (a person buying, an LLC vesting). The ✗ was drawn between
  // the seller and the buyer instead. Root cause: the display walks the path and pairs each node
  // with `hops[i-1]`, but hops were pushed ad hoc — the SALE itself (seller → buyer) was never one
  // of them, and a node with no name is dropped from the path while its hop stayed in the list. Any
  // gap shifted every later mark one step to the left, so the marks described the wrong steps and
  // the last step had no mark at all.
  //
  // So the link is recorded AGAINST THE NODE IT ARRIVES AT, and the hop list is built at the end by
  // walking the nodes actually shown. One hop per adjacent visible pair, by construction — the two
  // can no longer drift apart.
  const linkInto = {};
  const hop = (from, to, kind, verdict) => { linkInto[to.role] = { kind, verdict }; };

  // ── 1. Owner of record  ↔  seller on contract (SAME PARTY expected) ───────
  if (ownerOfRecord.length && contractSeller.length) {
    const r = partyInList(contractSeller[0], ownerOfRecord); // is the contract seller one of the owners of record?
    hop({ role: 'Owner of record', name: ownerOfRecord[0] }, { role: 'Seller on contract', name: contractSeller[0] }, 'same_party', verdictOf(r));
    if (r === false) {
      findings.push(mk({
        code: 'cot_seller_not_owner_of_record', severity: 'warning', field: 'seller',
        docValue: contractSeller.join(', '), fileValue: ownerOfRecord.join(', '),
        title: 'The seller on the contract is not the owner of record',
        howTo: `The purchase contract's seller (${contractSeller.join(', ')}) does not match the property's owner of record from title/public records (${ownerOfRecord.join(', ')}). Confirm the seller actually holds title — a seller who never owned the property is a classic chain-of-title / wholesale-fraud red flag. (The seller-name mismatch fatal is raised separately by the tie-out.)`,
        actions: ['post_condition', 'request_document', 'dismiss'], opensCondition: 'underwriting_review_cleared',
      }));
    }
  } else {
    hop({ role: 'Owner of record', name: ownerOfRecord[0] || null }, { role: 'Seller on contract', name: contractSeller[0] || null }, 'same_party', 'unknown');
  }

  // ── 1b. The SALE itself: seller → buyer is a TRANSFER, not a name match ───
  // This step was missing entirely. It is the one link in the chain that is SUPPOSED to change
  // hands, and leaving it out is what shifted every later mark onto the wrong step.
  hop({ role: 'Seller on contract', name: contractSeller[0] || null },
    { role: 'Buyer on contract', name: contractBuyer[0] || null },
    'transfer', contractBuyer.length ? 'ok' : 'unknown');

  // ── 2. Each assignment: assignor must be the party who held it after the previous hop ──
  // priorHolder starts as the contract buyer (the first assignor should be the contract buyer).
  let priorHolder = contractBuyer.slice();
  let priorRole = 'Buyer on contract';
  assignments.forEach((a, i) => {
    const assignor = toList(a.assignorName);
    const assignee = toList(a.assigneeName);
    const assignSeller = toList(a.sellerName);
    const n = i + 1;

    // 2a. This assignment's SELLER (if it names one) should match the upstream seller / owner.
    const upstreamSeller = contractSeller.length ? contractSeller : ownerOfRecord;
    if (assignSeller.length && upstreamSeller.length) {
      const rs = partyInList(assignSeller[0], upstreamSeller);
      if (rs === false) {
        findings.push(mk({
          code: 'cot_assignment_seller_mismatch', severity: 'warning', field: 'seller',
          docValue: assignSeller.join(', '), fileValue: upstreamSeller.join(', '),
          title: `Assignment ${n} names a different underlying seller`,
          howTo: `Assignment ${n} shows the underlying seller as ${assignSeller.join(', ')}, but the contract/record seller is ${upstreamSeller.join(', ')}. Confirm the assignment is for THIS purchase — a different seller means the wholesaler may be assigning a contract on a property they never had under contract.`,
          actions: ['post_condition', 'request_document', 'dismiss'], opensCondition: 'underwriting_review_cleared',
        }));
      }
    }

    // 2b. The ASSIGNOR must be the party who held the deal after the prior hop.
    if (assignor.length && priorHolder.length) {
      const r = partyInList(assignor[0], priorHolder);
      hop({ role: priorRole, name: priorHolder[0] }, { role: `Assignor (assignment ${n})`, name: assignor[0] }, 'same_party', verdictOf(r));
      if (r === false) {
        findings.push(mk({
          code: 'cot_assignor_never_held_title', severity: 'warning', field: 'assignor',
          docValue: assignor.join(', '), fileValue: priorHolder.join(', '),
          title: `Assignment ${n} is signed by a party that never held the contract`,
          howTo: `Assignment ${n} is assigned BY ${assignor.join(', ')}, but the party who held the deal up to this point is ${priorHolder.join(', ')}. An assignment can only be made by the current contract holder — a hop through a party who never held title breaks the ownership chain. Confirm the missing link (an earlier assignment) or treat it as a wholesale-fraud flag.`,
          actions: ['post_condition', 'request_document', 'dismiss'], opensCondition: 'underwriting_review_cleared',
        }));
      }
    } else {
      hop({ role: priorRole, name: priorHolder[0] || null }, { role: `Assignor (assignment ${n})`, name: assignor[0] || null }, 'same_party', 'unknown');
    }

    // 2c. assignor → assignee is a genuine TRANSFER (never a match check).
    hop({ role: `Assignor (assignment ${n})`, name: assignor[0] || null }, { role: `Assignee (assignment ${n})`, name: assignee[0] || null }, 'transfer', assignee.length ? 'ok' : 'unknown');

    // The assignee becomes the holder for the next hop.
    if (assignee.length) { priorHolder = assignee; priorRole = `Assignee (assignment ${n})`; }
  });

  // ── 3. Final holder  ↔  vesting entity (SAME PARTY expected) ──────────────
  let reachesVesting = null;
  if (vesting && finalBuyer) {
    const r = sameParty(finalBuyer, vesting);
    reachesVesting = r === true ? true : (r === false ? false : null);
    hop({ role: priorRole, name: finalBuyer }, { role: 'Vesting entity (our borrower)', name: vesting }, 'same_party', verdictOf(r));
    const isPersonal = person ? sameParty(finalBuyer, person) === true : false;
    // The personal-name case is seller-chain's `contract_in_personal_name` — don't duplicate it.
    if (r === false && !isPersonal) {
      findings.push(mk({
        code: 'cot_final_buyer_not_vesting', severity: 'warning', field: 'vesting',
        docValue: finalBuyer, fileValue: vesting,
        title: 'The end of the purchase chain is not the vesting entity',
        howTo: `The purchase chain ends at ${finalBuyer}, but the loan vests into ${vesting}. Confirm how the property reaches ${vesting} — a final assignment or a vesting amendment is needed so the borrowing entity is the one taking title.`,
        actions: ['post_condition', 'request_document', 'dismiss'], opensCondition: 'underwriting_review_cleared',
      }));
    }
  } else if (vesting || finalBuyer) {
    hop({ role: priorRole, name: finalBuyer || null }, { role: 'Vesting entity (our borrower)', name: vesting || null }, 'same_party', 'unknown');
  }

  // ── 3b. The displayed chain: one hop per adjacent VISIBLE node, in order ──
  const shownNodes = path.filter((n) => n.present);
  const hops = hopsAlongPath(shownNodes, linkInto);

  // ── 4. Uncomparable hop → advisory INFO (never guess a break) ─────────────
  // Only when there is a real chain to speak of (a contract or an assignment on file) and at least
  // one same-party hop couldn't be confirmed — so a bare file with no docs stays silent.
  const hasChain = !!contract || assignments.length > 0;
  // Judged on every comparison ATTEMPTED, not only the ones that ended up on screen. A step whose
  // node has no name is dropped from the display, but the fact that we could not check it is exactly
  // what this notice is for — reading the trimmed display list would silence it.
  const links = Object.keys(linkInto).map((k) => linkInto[k]);
  const unknownSameParty = links.some((h) => h.kind === 'same_party' && h.verdict === 'unknown');
  if (hasChain && unknownSameParty && !findings.some((f) => f.severity === 'warning')) {
    findings.push(mk({
      code: 'cot_unverified_hop', severity: 'info', field: 'chain',
      docValue: finalBuyer || null, fileValue: vesting || null,
      title: 'The ownership chain could not be confirmed end-to-end',
      howTo: 'One or more links in the ownership chain (owner of record → seller → assignor → assignee → vesting entity) is missing a name, so the chain can\'t be fully confirmed. Collect the missing document (title report, purchase contract, or assignment) to complete the trace.',
      actions: ['post_condition', 'request_document', 'dismiss'], opensCondition: 'underwriting_review_cleared',
    }));
  }

  const anyBreak = links.some((h) => h.verdict === 'break');
  const anyUnknown = unknownSameParty;
  const status = anyBreak ? 'broken' : (reachesVesting === true && !anyUnknown ? 'intact' : 'incomplete');

  const ownershipPath = shownNodes.map((n) => ({ role: n.role, name: n.name, source: n.source }));
  return { hops, ownershipPath, finalBuyer, reachesVesting, status, findings };
}

// Build the displayed hops from the nodes ACTUALLY SHOWN — one per adjacent pair, in order. This is
// what keeps each mark on the step it describes: the reader pairs node[i] with hops[i-1], so the two
// lists have to be the same length and the same shape, and deriving one from the other is the only
// way to guarantee that as documents come and go from a file.
function hopsAlongPath(nodes, linkInto) {
  const out = [];
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1], node = nodes[i];
    const link = linkInto[node.role] || null;
    out.push({
      from: { role: prev.role, name: prev.name },
      to: { role: node.role, name: node.name },
      // No recorded link means the step in between could not be checked — say so rather than
      // borrowing the verdict of a different step.
      kind: link ? link.kind : 'same_party',
      verdict: link ? link.verdict : 'unknown',
    });
  }
  return out;
}

module.exports = { buildChainOfTitle, _internals: { orderedAssignments } };

'use strict';
/**
 * ONE finding per real-world ISSUE (owner-reported 2026-07-26, reviewing a live file).
 *
 * THE PROBLEM. The file view concatenates findings from ~11 desks (per-document, cross-document,
 * tie-out, entity chain, seller chain, chain of title, bank liquidity, metrics, staleness,
 * reasonability, experience) and de-duplicated exactly ONE hard-coded code. Several desks correctly
 * and independently notice the SAME fact and each names it differently, so the desk showed the same
 * issue over and over. The owner counted the contract-buyer/vesting mismatch **six times** on one
 * file and the borrowing-entity OFAC gap three times: *"congratulations for the sixth time posting
 * the same condition… go to the root cause and merge every section."*
 *
 * WHY THE EXISTING DEDUPE MISSED IT. `finding-registry.keyOf` keys on `code + subject`. Six desks
 * raising one fact under six different codes never collide, so nothing merged. Worse, each near-miss
 * was patched by hand (the chain-of-title vs seller-chain suppression was a bespoke if-statement) —
 * a spot fix per pair, which does not scale and leaves every new pair to be discovered in production.
 *
 * THE FIX. Dedupe on the CLAIM — what the finding actually asserts about the file — not on the code
 * that happened to raise it. Codes that assert the same thing belong to one family and collapse to a
 * single finding; the survivor is the most informative one, and every code that agreed is recorded
 * on `mergedFrom` so nothing is silently lost and an auditor can still see which desks concurred.
 *
 * Adding a desk that re-notices an existing fact = adding its code to a family here. That is the
 * chokepoint; do NOT add another bespoke suppression at a call site.
 *
 * Pure: no DB, no AI, never throws.
 */

/**
 * Codes that assert the SAME real-world issue. Grouped by claim, with the reason recorded so a
 * later reader can tell a genuine family from a lazy merge.
 */
const CLAIM_FAMILIES = [
  {
    claim: 'vesting_entity_vs_contract_buyer',
    // All of these say ONE thing: the entity the loan vests into is not the party on the purchase /
    // assignment / title documents. The tie-out, the purchase chain, the entity chain, the chain of
    // title, the seller chain and the contract check each reach that from their own direction — it is
    // still one fact, one fix (a final assignment or a contract amendment before closing). The owner
    // saw this FIVE times on one file (2026-07-27, 76 THOMPSON ST LLC): a tie-out fatal, two
    // entity-chain edge cards, a contract-buyer card and a seller-chain "personal name" card. They
    // now merge to one.
    codes: [
      'contract_buyer_mismatch',
      'cot_final_buyer_not_vesting',
      'chain_vesting_not_reached',
      'chain_vesting_vs_contract_buyer',    // entity-chain edge: vesting entity ≠ contract buyer
      'chain_vesting_vs_title_party',       // entity-chain edge: vesting entity ≠ the party on the title
      'tieout_entity_name',                 // the tie-out "Vesting entity doesn't match the file" fatal
      // `contract_in_personal_name` IS included now (was excluded 2026-07-26). It was held out because
      // it carries the actionable remedy — `opensCondition: 'assignment_to_vesting_entity'` and the
      // "post the final-assignment-to-LLC condition" button — and merging it into the fatal tie-out
      // survivor took that button off the desk. dedupeByClaim now CARRIES a merged member's specific
      // remedy (its opensCondition + howTo) onto the survivor, so the one surviving card is the fatal
      // AND offers the final-assignment condition. With that trap closed, this is one issue, one card.
      'contract_in_personal_name',
    ],
  },
  {
    claim: 'borrowing_entity_not_screened',
    // The background/OFAC desk and the entity desk both report "the LLC itself was never screened".
    codes: ['background_entity_not_screened', 'entity_not_screened'],
  },
  {
    claim: 'fraud_alerts_open',
    // The duplication the owner saw came from TWO REPORTS on the file, not two alert batches within
    // one — the background desk emits exactly one aggregated `background_fraud_alerts` per report.
    // So this family only ever merges a persisted finding with a DERIVED restatement of it; the
    // never-merge-two-persisted rule below keeps the borrower's report and the co-borrower's report
    // as two separate items of work, which is what they are.
    codes: ['background_fraud_alerts'],
  },
  {
    claim: 'assignment_fee_over_cap',
    // Pre-existing behaviour, kept: the fee-over-cap shows on BOTH the purchase contract and the
    // assignment. This replaces the old hard-coded DEDUP_ONCE set.
    codes: ['assignment_fee_over_cap'],
    // FILE-LEVEL: this is ONE economic truth about the deal — the financeable fee is over the 15%
    // cap — that simply happens to be legible on two documents. It is not two problems and there is
    // not one fix per document, so it merges even though both rows are persisted.
    //
    // That override is safe HERE and the reasoning does not generalize: both producers raise it as a
    // non-blocking warning, so no dealbreaker can hide behind the survivor and the clear-to-close
    // count cannot disagree with the desk (the two dangers the never-merge-two-persisted rule
    // exists for). A family may only set this when every producer of it is non-blocking.
    fileLevel: true,
  },
  {
    claim: 'title_insured_below_loan',
    // The lender's title policy insures LESS than the loan amount — ONE economic truth about the
    // deal that is legible on more than one title document (a title commitment AND a title policy,
    // or two extractions of the title), which the owner saw posted twice. Same rationale + same
    // safety condition as assignment_fee_over_cap: `title_policy_amount_low` is warning-only, so no
    // dealbreaker can hide behind the merged survivor.
    codes: ['title_policy_amount_low'],
    fileLevel: true,
  },
];

const CLAIM_OF_CODE = new Map();
const FILE_LEVEL_CLAIMS = new Set();
for (const fam of CLAIM_FAMILIES) {
  for (const c of fam.codes) CLAIM_OF_CODE.set(c, fam.claim);
  if (fam.fileLevel) FILE_LEVEL_CLAIMS.add(`claim:${fam.claim}`);
}

// The properties that make a card ACTIONABLE. A merged survivor inherits any it lacks from the
// rows folded into it — see the note in dedupeByClaim. `id` is what makes a finding resolvable;
// `suggestionId` drives the AI-suggestion menu; `isgKey` is how the AI panel recognises its own
// mirror. `opensCondition` is deliberately NOT here — #814's specificRemedyOf owns it with a
// finer rule (it also replaces a GENERIC condition, not just an absent one).
const HANDLE_KEYS = ['id', 'suggestionId', 'isgKey'];
const SEV_RANK = { fatal: 3, warning: 2, info: 1 };
function sevRank(s) { return SEV_RANK[String(s || '').toLowerCase()] || 0; }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/**
 * The dedupe identity of a finding.
 *
 * A code in a family keys on the CLAIM ALONE — deliberately NOT claim+subject, because the whole
 * point is that the desks disagree about the subject: one says the subject is the vesting entity,
 * another the contract buyer, a third the final holder in the chain. They are describing one fact
 * from different ends, so including the subject would keep them apart and defeat the merge.
 *
 * Everything else keys on the code PLUS WHICH DOCUMENT IT CAME FROM, so the same check firing on two
 * different documents stays two findings.
 *
 * AUDIT FIX 2026-07-26 — the first version of this keyed on `code::subject||field`, which was wrong
 * in production and dangerous. A stored finding (`document_findings`, db/200) has NO `subject`
 * column, and `field` is a per-code CONSTANT (`bank_account_not_borrower` is always
 * `account_holder`; `id_expired` is always `expiration`). So the fallback collapsed to the bare code
 * and merged findings that had nothing to do with each other except their type:
 *   - two bank statements, each held by a DIFFERENT non-borrower → two FATALs → one shown
 *   - borrower and co-borrower government IDs both expired → one shown
 *   - borrower's and co-borrower's fraud reports → one shown
 * Hiding the second one is a false clear, which is the one direction this system must never fail in.
 * The document identity is what makes them distinct, so it belongs in the key.
 */
function docKey(f) {
  // The distinguishing datum LAST, because several derived desks emit N findings from one loop —
  // one per LLC member, one per assignment hop — all under the same code and the same constant
  // `field`, and none of them carries a document id (audit 2026-07-26). Keyed on code+field alone
  // they collapsed to one: a three-member LLC where none of the beneficial owners has ID on file
  // showed ONE missing owner, and a two-hop wholesale chain where BOTH assignments were signed by a
  // party that never held the contract showed one hop. Those are exactly the facts the checks
  // exist to surface, and they are derived, so the never-merge-two-persisted rule cannot catch
  // them. What tells them apart is `docValue` ("ADAM STERN (34%)"), so that belongs in the key —
  // and an identical docValue is a genuine re-emit, which still collapses.
  return norm(f.document_id || f.documentId || f.extraction_id || f.extractionId || f.subject || '')
    + '::' + norm(f.docValue || f.doc_value || '');
}
function claimOf(f) {
  if (!f || !f.code) return null;
  // A PRODUCER-DECLARED claim beats the static code table. The note-buyer stack has three
  // independent producers — the guideline desk (one row per note-buyer spec), the whole-loan run's
  // rule table, and any future one — that read the SAME underlying signal and each name their
  // finding differently: `isg_rural_property` (run) vs `isg_appraisal_review_3345` (CorrFirst's
  // rural row) vs `isg_appraisal_review_123` (Blue Lake's). Keyed on their codes, they can never
  // collide, so one rural file said "rural" three times — twice as a note, once as a dealbreaker.
  //
  // Listing those codes here would work today and rot tomorrow: the desk's codes are derived from
  // cond_no, so a spec edit or a new note buyer silently re-splits the claim. Instead each producer
  // declares WHICH FACT it is asserting (`factKey`, e.g. the signal name `appraisal_rural`), and
  // that is the merge key. A new rule reading the same signal merges automatically, with no list to
  // maintain. Nothing else sets factKey, so every other finding keys exactly as before.
  // NAMED `factKey`, NOT `claimKey` (pre-merge audit 2026-07-27). `claimKey` was ALREADY TAKEN:
  // routes/underwriting.js `decorate()` stamps `claimKey = claimOf(f)` onto every finding for the
  // AI panel, and decorated findings go straight into `openRaw` — so reading `claimKey` here made
  // claimOf re-read its OWN output and emit `claim:claim:…`. That silently un-grouped every
  // CLAIM_FAMILY (the contract-buyer / entity-screening / fee-over-cap merges) AND broke #816's
  // finding_decisions ledger, whose writes key on a RAW shape: a granted exception stopped
  // suppressing and the finding came back on the next view. A producer declares the FACT; the
  // route stamps the resulting CLAIM. Two different things, two different names.
  if (f.factKey) return `claim:${norm(f.factKey)}`;
  const fam = CLAIM_OF_CODE.get(norm(f.code));
  if (fam) return `claim:${fam}`;
  return `code:${norm(f.code)}::${norm(f.field || '')}::${docKey(f)}`;
}

/**
 * Is this a PERSISTED finding — a real `document_findings` row with its own id?
 *
 * It matters because a persisted finding is individually resolvable in the desk and is counted
 * individually by the clear-to-close gate (`file-review.fileFatalCount` reads the stored fatals
 * straight from the database, undeduped). Hide one behind another and the two disagree forever: the
 * gate says "resolve 2 open dealbreakers", the desk shows 1, and the hidden row has no card and no
 * id to resolve — the file can never be cleared from the screen. Derived findings (recomputed live
 * by the chain / tie-out / liquidity desks, no id) have no such row and fold in freely.
 */
function isPersisted(f) { return !!(f && f.id); }

/** Would hiding this finding hide a dealbreaker? Fatal severity or an explicit CTC block. */
function isBlocking(f) {
  if (!f) return false;
  if (sevRank(f.severity) === 3) return true;
  return !!(f.blocks_ctc != null ? f.blocks_ctc : f.blocksCtc);
}

// Which of two findings for the same claim should SURVIVE as the one shown.
// Most severe wins; then the one that explains itself best (the owner's complaint was thin
// reasoning, so prefer the richer text); then the one carrying evidence to open.
// A generic "an underwriter looked and cleared it" condition target that most desks default to.
// When findings merge, a member that carries a SPECIFIC condition (e.g. the seller chain's
// final-assignment-to-vesting-entity remedy) must hand it to the survivor, so collapsing to one
// card never strips the actionable button — the exact trap that kept contract_in_personal_name out
// of the vesting family before (owner-reported 2026-07-27).
const GENERIC_OPENS_CONDITION = new Set(['underwriting_review_cleared']);
function specificRemedyOf(f) {
  const oc = f && f.opensCondition;
  if (!oc || GENERIC_OPENS_CONDITION.has(String(oc))) return null;
  return { opensCondition: String(oc), howTo: (f && f.howTo) || null };
}

function isBetter(candidate, current) {
  // A PERSISTED finding always outranks a derived restatement of it, whatever the severity. It is
  // the one with an id, so it is the one the underwriter can actually act on and the one the
  // clear-to-close gate is counting; swapping it out for a prettier derived copy would leave the
  // stored row live but unreachable from the screen.
  const cp = isPersisted(candidate) ? 1 : 0, rp = isPersisted(current) ? 1 : 0;
  if (cp !== rp) return cp > rp;
  const cs = sevRank(candidate.severity), rs = sevRank(current.severity);
  if (cs !== rs) return cs > rs;
  const ce = String(candidate.explanation || candidate.detail || candidate.message || '').length;
  const re = String(current.explanation || current.detail || current.message || '').length;
  if (ce !== re) return ce > re;
  const cev = (candidate.document_id || candidate.documentId) ? 1 : 0;
  const rev = (current.document_id || current.documentId) ? 1 : 0;
  return cev > rev;
}

/**
 * dedupeByClaim(findings) → one finding per claim, order preserved by first appearance.
 *
 * The survivor gains `mergedFrom` — every OTHER code that raised the same claim — so the desk can
 * say "the chain of title and the contract check both flagged this" instead of printing it twice,
 * and nothing an auditor needs is discarded.
 *
 * Never throws; a null/code-less finding passes through untouched.
 */
function pickHandles(f) {
  let out = null;
  for (const k of HANDLE_KEYS) {
    if (f && f[k] != null) { out = out || {}; out[k] = f[k]; }
  }
  return out;
}

function dedupeByClaim(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const order = [];
  const byClaim = new Map();
  const passthrough = [];

  for (const f of list) {
    const key = claimOf(f);
    if (!key) { passthrough.push({ f, at: order.length }); order.push(null); continue; }
    const prev = byClaim.get(key);
    if (!prev) {
      byClaim.set(key, { rep: f, codes: new Set([norm(f.code)]), persisted: isPersisted(f) ? 1 : 0,
        remedy: specificRemedyOf(f), handles: pickHandles(f), at: order.length });
      order.push(key);
      continue;
    }
    // TWO PERSISTED ROWS ARE NEVER MERGED (audit 2026-07-26). Each is separately resolvable and
    // separately counted by the clear-to-close gate, so folding one into the other would hide a real
    // dealbreaker and leave the file un-clearable (see isPersisted above). They are two pieces of
    // work — a co-borrower's expired ID is not the borrower's — so both stay on the desk.
    // The fileLevel exemption is ENFORCED here, not just described above (audit 2026-07-26). The
    // rule "only for families whose every producer is non-blocking" was a sentence in a comment, and
    // the two dangers it guards against — a hidden dealbreaker, and a clear-to-close count that
    // disagrees with the desk — are exactly what two earlier rounds of this audit were about. If
    // anyone later marks a family fileLevel that has a blocking producer, or raises
    // assignment_fee_over_cap to fatal (its 15% cap is an owner-frozen rule), the code refuses
    // rather than silently stranding the file.
    const mergeableFileLevel = FILE_LEVEL_CLAIMS.has(key) && !isBlocking(f) && !isBlocking(prev.rep);
    if (prev.persisted && isPersisted(f) && !mergeableFileLevel) {
      passthrough.push({ f, at: order.length });
      order.push(null);
      continue;
    }
    prev.codes.add(norm(f.code));
    // Record every handle seen for this claim BEFORE choosing a winner, so the survivor can inherit
    // one it does not carry itself. First writer wins per key — a real id is never overwritten.
    const h = pickHandles(f);
    if (h) prev.handles = prev.handles ? Object.assign({}, h, prev.handles) : h;
    if (isBetter(f, prev.rep)) prev.rep = f;
    if (isPersisted(f)) prev.persisted = 1;
    if (!prev.remedy) prev.remedy = specificRemedyOf(f);   // first specific remedy among the members wins
  }

  const out = [];
  const emitted = new Set();
  let pi = 0;
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    if (key == null) {
      const p = passthrough[pi++];
      if (p) out.push(p.f);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    const g = byClaim.get(key);
    const others = [...g.codes].filter((c) => c !== norm(g.rep.code));
    // TWO SEPARATE THINGS ARE CARRIED ONTO THE SURVIVOR, and they do not overlap.
    //
    // (1) THE ACTIONABLE HANDLES (pre-merge audit 2026-07-27). Winning on severity is not enough:
    // the card only renders buttons when it has an `id` (resolvable) or a `suggestionId` (the
    // AI-suggestion menu). A note-buyer fatal computed live from the whole-loan run has NEITHER, so
    // when it beat the desk's warning the merged card became un-actionable — and once a staffer
    // dismissed the desk row, the fatal stood alone with nothing to click, on every future view.
    //
    // (2) THE SPECIFIC REMEDY (#814). `opensCondition`/`howTo` deliberately are NOT handles: that
    // rule is finer — it replaces a survivor's GENERIC condition, not merely an absent one, so the
    // one surviving vesting card keeps its fatal severity AND the "post the final-assignment
    // condition" button. Leaving opensCondition out of HANDLE_KEYS is what keeps the two from
    // fighting over the same property; each owns its own concern.
    let rep = g.rep;
    if (g.handles) {
      const add = {};
      for (const k of HANDLE_KEYS) if (rep[k] == null && g.handles[k] != null) add[k] = g.handles[k];
      if (Object.keys(add).length) rep = { ...rep, ...add };
    }
    const patch = {};
    if (others.length) patch.mergedFrom = others;
    if (g.remedy && (!rep.opensCondition || GENERIC_OPENS_CONDITION.has(String(rep.opensCondition)))) {
      patch.opensCondition = g.remedy.opensCondition;
      if (g.remedy.howTo) patch.howTo = g.remedy.howTo;
    }
    out.push(Object.keys(patch).length ? { ...rep, ...patch } : rep);
  }
  return out;
}

module.exports = { dedupeByClaim, claimOf, CLAIM_FAMILIES, _internals: { isBetter, sevRank } };

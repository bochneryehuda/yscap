'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — RS-3: the PAGE DISPOSITION stage.
 *
 * THE DEFECT THIS CLOSES. Every stage before this one reasons about a document as a single thing:
 * one route, one read, one classification verdict. Real uploads are not like that — a borrower sends
 * one PDF holding a purchase contract, an assignment, two bank statements and a scanned separator
 * sheet. The read covers all of it, the classifier reports what it found, and then NOTHING says what
 * happened to page 7. It is not assigned to anything, nobody excluded it, and nobody was asked about
 * it. It simply is not mentioned — which reads, on every surface, exactly like a page that was fine.
 * The architecture is explicit about this being the wrong shape: "no extraction starts until every
 * page is assigned, intentionally excluded, or placed in manual review" (Layer 1, Intake & Packet
 * Control), and the vendor-setup doc lists page-by-page accounting as one of the things honestly not
 * done yet.
 *
 * WHAT "DISPOSITIONED" MEANS. Exactly one of three, for every physical page the read saw:
 *
 *   assigned       — the page belongs to a classified segment. We know what it is part of.
 *   excluded       — the page is deliberately not part of any document: it is BLANK. A separator
 *                    sheet or a trailing empty page is a real thing in a scanned packet, and calling
 *                    it out as excluded is different from never mentioning it.
 *   manual_review  — a human has to decide. This is the fallback for EVERYTHING we cannot place, and
 *                    it is what makes the accounting total: an unplaceable page is never dropped, it
 *                    is escalated. It covers a page no segment claims and that we cannot prove is
 *                    blank, a page TWO segments both claim (a disputed boundary — the classifier
 *                    contradicting itself is the strongest possible signal a human should look), and
 *                    a page whose only claim comes in below the confidence floor.
 *
 * Because manual_review absorbs every uncertain case, the accounting ALWAYS totals when there is a
 * page list at all. That is deliberate and it is the point: this stage cannot "fail to disposition",
 * it can only tell you honestly how many pages a person still has to look at. It is therefore NOT a
 * gate that blocks extraction — a gate that can never fire is theatre. What it is, is the record
 * that makes a silently-dropped page impossible: the page count is stated, every page number is
 * written down with its disposition and the reason, and the stage status says plainly whether a
 * human is owed work.
 *
 * NEVER-FABRICATE (the governing discipline):
 *   - No page list from the read        → NOT_APPLICABLE. Zero pages accounted for out of zero is
 *                                         not "all pages accounted for"; claiming a clean packet
 *                                         because we never saw one is the exact dishonesty this
 *                                         module exists to prevent.
 *   - Classification did not run        → NOT_APPLICABLE, naming the reason. Without a classifier
 *                                         verdict there is no basis to ASSIGN anything, and marking
 *                                         a whole packet 'manual_review' because a switch is off
 *                                         would bury the real manual-review pages in noise.
 *   - A page we cannot prove is blank   → manual_review, never excluded. Blank is a POSITIVE finding
 *                                         (we read the page and it held no text). Absence of text in
 *                                         our hands is not absence of text on the page — an image-only
 *                                         scan reads as empty text and is very much not blank.
 *   - A segment citing a page that does not exist → recorded as an out-of-range claim and forced to
 *                                         manual_review. A classifier disagreeing with the page count
 *                                         is a real inconsistency, not something to quietly clamp.
 *
 * PURE + never-throws. Computes from the read + classification outputs only. Writes nothing, decides
 * nothing about the loan, touches no frozen number and no borrower surface. ADVISORY, like every
 * other V2 stage: a page in manual_review is a fact on the shadow surface, never an action on a file.
 */

/** The three dispositions. Exactly one applies to each page; there is no fourth, and no "unknown". */
const DISPOSITION = Object.freeze({
  ASSIGNED: 'assigned',
  EXCLUDED: 'excluded',
  MANUAL_REVIEW: 'manual_review',
});

/**
 * The stage statuses this module can produce. Same hard rule as every other V2 stage: these are not
 * free text — `document_pipeline_stages` has a CHECK constraint (db/307) and the write is wrapped in
 * a swallow-everything catch, so a status outside the constraint is silently never written and the
 * stage looks like it never ran. Every value here is in that constraint.
 */
const OUTCOME = Object.freeze({
  COMPLETED: 'completed',            // every page placed; nobody is owed work
  MANUAL_REQUIRED: 'manual_required', // every page accounted for, but a human has pages to look at
  NOT_APPLICABLE: 'not_applicable',  // there was no basis to disposition anything
});

/** Reason codes, so the surface can explain a page without parsing prose. */
const REASON = Object.freeze({
  IN_SEGMENT: 'in_segment',
  BLANK: 'blank_page',
  UNCLAIMED: 'no_segment_claims_this_page',
  DISPUTED: 'claimed_by_more_than_one_segment',
  LOW_CONFIDENCE: 'segment_confidence_below_floor',
});

// A claim this weak is not an assignment. Deliberately low: the job here is to catch the classifier
// hedging, not to second-guess an ordinary confident read. A page below it goes to a human, which is
// always safe — the cost of an unnecessary look is a look.
const DEFAULT_MIN_CONFIDENCE = 0.35;

function int(v) { return Number.isFinite(v) ? Math.trunc(v) : null; }
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }

/**
 * PURE — how many physical pages did the read actually see, and which of them are provably blank?
 *
 * Returns { pageCount, blank:Set<int> }. `blank` only ever contains a page whose text we HELD and
 * which was empty; a page with no text property at all is absent from the set (unknown, not blank).
 */
function readPages(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const numbers = [];
  const blank = new Set();
  // TWO PHYSICAL PAGES THAT RESOLVE TO ONE NUMBER (audit 2026-07-27). The number set was deduped
  // and its size taken as the page count, so a collision made a page the read returned vanish —
  // no row, no mention — while the detail line said "every one of the 1 page(s) was accounted for".
  // A packet certified with a page silently dropped is the exact thing this module exists to make
  // impossible, so a collision is now REPORTED and forces the packet to a person.
  //
  // It is not exotic: any read where some pages carry `pageNumber` and some do not collides the
  // `idx + 1` fallback onto a real number, and a fractional number truncates onto its neighbour.
  const collisions = [];
  const seenNums = new Set();
  list.forEach((p, idx) => {
    // Page numbers come from the ADAPTER when it supplies one, so a sliced or re-ordered read still
    // lines up with the classifier's page references. `!= null` rather than a truthiness check:
    // page 0 from a 0-indexed adapter is a real page number, and `||` would alias it onto page 1 —
    // silently merging two pages into one and letting the second overwrite the first's disposition.
    const raw = p && (p.pageNumber != null ? p.pageNumber : p.page);
    const n = Number.isFinite(raw) ? Math.trunc(raw) : (idx + 1);
    if (seenNums.has(n)) collisions.push(n); else seenNums.add(n);
    numbers.push(n);
    if (isProvablyBlank(p)) blank.add(n);
  });
  return { numbers, blank, collisions };
}

/**
 * PURE — is this page PROVABLY blank, as opposed to merely unread?
 *
 * AUDIT 2026-07-26/27, twice, and the second correction matters more than the first.
 *
 * ROUND ONE: the module treated `text === ''` as proof of blankness, reasoning that an unread page
 * would arrive with no `text` property at all. Sound reasoning, false premise — `docint.js` and
 * `docai-mistral.js` both BUILD `text` by joining the page's lines and emit `''` when there are
 * none. Every image-only scan, signature page and page the vendor declined to OCR would have been
 * EXCLUDED from the packet while the stage reported "every page was placed": a real page dropped
 * out of the accounting under an affirmative all-clear, caused by the module written to prevent it.
 *
 * ROUND TWO: the fix then required an empty `lines`/`words` ARRAY as corroboration — "the adapter
 * looked and found nothing", which is a different statement from "there is no text property". That
 * was still wrong, in the harmless direction: all three adapters put line/word data under
 * `p.layout`, never at the top level, and Mistral emits none at all. So the corroboration could
 * never be satisfied and `excluded` was unreachable — the guarantee held, but by accident.
 *
 * THE ACTUAL SITUATION, stated plainly rather than papered over: **no adapter currently emits a
 * signal that distinguishes a blank page from an image-only one.** Azure reports `wordCount: 0` and
 * an empty `layout.lines` for BOTH. Reading `p.layout.lines` — the obvious "fix" — would therefore
 * reintroduce round one's defect exactly, which is why it is deliberately NOT done here.
 *
 * So `excluded` is reachable only from an EXPLICIT blank determination (`blank`/`isBlank`) made by
 * something that genuinely looked — an upstream page-quality pass, which is where that judgement
 * belongs. Until one is wired, a scanned separator sheet is `manual_review`, and that is the honest
 * answer: we cannot prove it is empty, so a person decides. The cost is a glance at a blank page;
 * the alternative cost is a real page vanishing from a loan file. Do not "restore" the empty-array
 * heuristic without an adapter signal that can actually tell the two apart.
 */
function isProvablyBlank(p) {
  if (!p || typeof p !== 'object') return false;
  // An EXPLICIT determination from something that actually looked at the page. Today that means an
  // upstream page-quality pass; no OCR adapter sets it. See the note above for why that is correct
  // rather than a gap to paper over.
  return p.blank === true || p.isBlank === true;
}

/**
 * PURE — disposition EVERY page of a read.
 *
 * @param {object} args
 *   pages          — the read's page array (adapter-normalized: [{pageNumber?, text?}, …])
 *   pageCount      — optional explicit page count; defaults to pages.length
 *   segments       — normalized classifier segments [{docType, rawLabel, confidence, pages:[…]}]
 *   classified     — did the classification stage actually produce a verdict? When false there is no
 *                    basis to assign, and the honest answer is not-applicable (see NEVER-FABRICATE).
 *   minConfidence  — the assignment confidence floor (default 0.35)
 *
 * @returns {{status, pageCount, pages:Array, counts, accountedFor, manualPages, outOfRange, detail}}
 */
function dispositionPages(argsIn = {}) {
  // `= {}` only defaults `undefined`. An explicit null is a real call shape (a caller passing a
  // variable that turned out empty), and this module's contract is that it never throws.
  const args = (argsIn && typeof argsIn === 'object') ? argsIn : {};
  const { numbers, blank, collisions } = readPages(args.pages);
  // The pages the read ACTUALLY returned, in order, deduped. `args.pageCount` may no longer override
  // this (audit 2026-07-26): an over-stated count invented pages that were never read and recorded
  // them ASSIGNED with a real confidence, and an under-stated one left pages the read DID return
  // undispositioned while the identity still reported success — a skipped page under a clean
  // verdict, which is the one outcome this module exists to make impossible. The count is what we
  // saw, full stop.
  const pageNums = [...new Set(numbers)].sort((a, b) => a - b);
  const pageCount = pageNums.length;
  const classified = args.classified !== false;
  const floor = num(args.minConfidence) != null ? num(args.minConfidence) : DEFAULT_MIN_CONFIDENCE;
  const segments = Array.isArray(args.segments) ? args.segments : [];

  // No pages at all — nothing was seen, so nothing can be accounted for. Say that, rather than
  // reporting a vacuously complete packet.
  if (!pageCount) {
    return {
      status: OUTCOME.NOT_APPLICABLE,
      pageCount: 0, pages: [], counts: { assigned: 0, excluded: 0, manual_review: 0 },
      accountedFor: false, manualPages: [], outOfRange: [],
      detail: { note: 'the read reported no pages, so there was nothing to account for' },
    };
  }

  // The classifier never gave a verdict (switched off, not configured, or it failed). Without one,
  // no page can be ASSIGNED to anything. Marking the entire packet 'manual_review' would be
  // technically total and practically useless — it would drown the pages that genuinely need a human.
  if (!classified) {
    return {
      status: OUTCOME.NOT_APPLICABLE,
      pageCount, pages: [], counts: { assigned: 0, excluded: 0, manual_review: 0 },
      accountedFor: false, manualPages: [], outOfRange: [],
      detail: {
        note: 'the document was not classified, so its pages could not be assigned to anything',
        pageCount,
      },
    };
  }

  // Build page -> claims. A page claimed by two segments is a DISPUTED BOUNDARY, which is why the
  // claims are collected rather than last-one-wins: overwriting would erase the disagreement, and
  // the disagreement is the most valuable thing on the page.
  const claims = new Map();      // page number -> [{ type, confidence }]
  const outOfRange = [];
  const pageSet = new Set(pageNums);
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const type = seg.docType || seg.rawLabel || null;
    const conf = num(seg.confidence);
    // DEDUPE WITHIN the segment. One segment listing a page twice is a sloppy list, not two
    // documents disagreeing — and reporting it as a disputed boundary tells a person to go and
    // adjudicate between a segment and itself.
    const segPages = [...new Set(Array.isArray(seg.pages) ? seg.pages : [])];
    for (const raw of segPages) {
      const n = int(raw);
      // A claim the read cannot match is RECORDED, never quietly dropped — in EITHER direction.
      // The first version recorded only `n > pageCount` and `continue`d on anything below 1 or
      // unusable, so a 0-indexed classifier claiming [0,1,2] on a 3-page read reported an empty
      // outOfRange and blamed the last page on "nobody claimed it". A numbering disagreement is a
      // real inconsistency and the whole point is that it reaches a person.
      if (n == null) { outOfRange.push({ page: null, type, claimed: String(raw).slice(0, 20) }); continue; }
      if (!pageSet.has(n)) { outOfRange.push({ page: n, type }); continue; }
      if (!claims.has(n)) claims.set(n, []);
      claims.get(n).push({ type, confidence: conf });
    }
  }

  const out = [];
  for (const n of pageNums) {
    const cs = claims.get(n) || [];
    if (cs.length > 1) {
      // Two segments both say this page is theirs. The classifier is contradicting itself about
      // where one document ends and the next begins — precisely the "disputed boundary → human
      // packet review" case the architecture calls for.
      out.push({
        page: n, disposition: DISPOSITION.MANUAL_REVIEW, reason: REASON.DISPUTED,
        assignedType: null, confidence: null,
        claimedBy: cs.map((c) => c.type).filter(Boolean).slice(0, 5),
      });
      continue;
    }
    if (cs.length === 1) {
      const c = cs[0];
      // A claim below the floor is a hedge, not an assignment. `null` confidence is NOT below the
      // floor — a classifier that reports no confidence has not expressed doubt, and treating its
      // silence as doubt would send every page of an otherwise fine read to a human.
      if (c.confidence != null && c.confidence < floor) {
        out.push({
          page: n, disposition: DISPOSITION.MANUAL_REVIEW, reason: REASON.LOW_CONFIDENCE,
          assignedType: c.type || null, confidence: c.confidence,
        });
      } else {
        // A blank page INSIDE a claimed segment stays assigned: a blank page in the middle of a bank
        // statement is part of that statement, and excluding it would silently shorten the document.
        out.push({
          page: n, disposition: DISPOSITION.ASSIGNED, reason: REASON.IN_SEGMENT,
          assignedType: c.type || null, confidence: c.confidence,
        });
      }
      continue;
    }
    // Nothing claims this page.
    if (blank.has(n)) {
      out.push({ page: n, disposition: DISPOSITION.EXCLUDED, reason: REASON.BLANK, assignedType: null, confidence: null });
    } else {
      out.push({ page: n, disposition: DISPOSITION.MANUAL_REVIEW, reason: REASON.UNCLAIMED, assignedType: null, confidence: null });
    }
  }

  const counts = { assigned: 0, excluded: 0, manual_review: 0 };
  for (const p of out) counts[p.disposition] += 1;
  const manualPages = out.filter((p) => p.disposition === DISPOSITION.MANUAL_REVIEW).map((p) => p.page);
  // The accounting identity. It holds by construction — every branch above assigns exactly one
  // disposition — and it is asserted anyway, because "by construction" is what every silently-broken
  // invariant was before it broke.
  const accountedFor = (counts.assigned + counts.excluded + counts.manual_review) === pageCount;

  // An out-of-range claim means the classifier and the read disagree about how many pages exist.
  // That is never silently clamped: it forces the packet to a human even if every real page placed.
  const needsHuman = manualPages.length > 0 || outOfRange.length > 0 || !accountedFor
    || collisions.length > 0;

  return {
    status: needsHuman ? OUTCOME.MANUAL_REQUIRED : OUTCOME.COMPLETED,
    pageCount,
    pages: out,
    counts,
    accountedFor,
    manualPages,
    outOfRange,
    collisions,
    detail: {
      note: needsHuman
        ? `every one of the ${pageCount} page(s) was accounted for; ${manualPages.length} need a person to place them`
        : `every one of the ${pageCount} page(s) was placed`,
      pageCount,
      assigned: counts.assigned,
      excluded: counts.excluded,
      manualReview: counts.manual_review,
      // Bounded so a 900-page packet cannot bloat the stage row.
      manualPages: manualPages.slice(0, 50),
      outOfRange: outOfRange.slice(0, 20),
      // Stated on the record: the read returned MORE pages than there are distinct page numbers, so
      // this accounting covers fewer pages than were read. Never silent.
      collidingPageNumbers: collisions.slice(0, 20),
      readPageCount: (Array.isArray(args.pages) ? args.pages.length : 0),
      accountedFor,
    },
  };
}

module.exports = {
  DISPOSITION,
  OUTCOME,
  REASON,
  DEFAULT_MIN_CONFIDENCE,
  dispositionPages,
  _internals: { readPages },
};

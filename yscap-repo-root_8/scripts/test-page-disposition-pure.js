'use strict';
/**
 * RS-3 — the page-disposition module, PURE (no DB, no vendor, no network).
 *
 * The property under test is one sentence: EVERY page the read saw gets exactly one disposition, and
 * anything we cannot place goes to a person rather than going quiet. Most of these cases are about
 * the ways a page can silently disappear — a segment that claims a page twice, a segment citing a
 * page that does not exist, a page with no text we can prove is blank — because a page that vanishes
 * looks identical, on every surface, to a page that was fine.
 *
 *   node scripts/test-page-disposition-pure.js
 */
const R = require('path').resolve(__dirname, '..');
const pd = require(R + '/src/pipeline/page-disposition');
const { DISPOSITION, OUTCOME, REASON } = pd;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

/** Every case must satisfy the accounting identity, so it is asserted once, centrally. */
function assertTotals(res, m) {
  if (res.status === OUTCOME.NOT_APPLICABLE) { ok(res.pages.length === 0, `${m}: not-applicable records no page rows`); return; }
  const sum = res.counts.assigned + res.counts.excluded + res.counts.manual_review;
  eq(sum, res.pageCount, `${m}: assigned+excluded+manual === pageCount`);
  eq(res.pages.length, res.pageCount, `${m}: one row per page`);
  ok(res.accountedFor === true, `${m}: reports accountedFor`);
  const seen = new Set(res.pages.map((p) => p.page));
  eq(seen.size, res.pageCount, `${m}: no page number appears twice`);
  ok(res.pages.every((p) => Object.values(DISPOSITION).includes(p.disposition)), `${m}: every disposition is one of the three`);
}

// Page fixtures in the REAL adapter shape. `docint.js` / `docai-mistral.js` both build `text` by
// joining the page's lines and emit '' when there are none, so a page they could not read is
// text:'' — NOT text:undefined. A fixture that omits `text` therefore tests a shape no adapter can
// produce, which is how the first version of this module came to treat every image-only page as
// blank while its tests said otherwise.
const page = (n, text) => ({ pageNumber: n, text: text === undefined ? '' : text, lines: [{ }] });
/** A page an upstream page-quality pass EXPLICITLY determined to be blank. That flag is the only
    thing that can produce `excluded` — see isProvablyBlank for why no OCR adapter can supply it:
    Azure reports an empty lines array for a blank page AND for an image-only one, so an
    empty-array heuristic would silently exclude real pages. */
const blankPage = (n) => ({ pageNumber: n, text: '', blank: true });
/** A page the adapter could not read: empty text, and NO determination either way. Unknown, and an
    unknown page goes to a person — it is never assumed blank. This is the shape both production
    adapters emit for an image-only scan. */
const unreadPage = (n) => ({ pageNumber: n, text: '', lines: [] });

// ── 1. the ordinary case: one segment covers the whole document ──────────────────────────────
{
  const res = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b'), page(3, 'c')],
    segments: [{ docType: 'bank_statement', confidence: 0.9, pages: [1, 2, 3] }],
  });
  eq(res.status, OUTCOME.COMPLETED, 'whole document classified: completed');
  eq(res.counts.assigned, 3, 'all three pages assigned');
  eq(res.manualPages.length, 0, 'nobody is owed work');
  eq(res.pages[0].assignedType, 'bank_statement', 'the assigned type is recorded on the page');
  assertTotals(res, 'single segment');
}

// ── 2. a real PACKET: two documents plus a blank separator sheet ─────────────────────────────
{
  const res = pd.dispositionPages({
    pages: [page(1, 'contract'), page(2, 'contract'), blankPage(3), page(4, 'statement')],
    segments: [
      { docType: 'purchase_contract', confidence: 0.88, pages: [1, 2] },
      { docType: 'bank_statement', confidence: 0.8, pages: [4] },
    ],
  });
  eq(res.counts.assigned, 3, 'three pages belong to a document');
  eq(res.counts.excluded, 1, 'the blank separator is excluded, not ignored');
  eq(res.pages[2].reason, REASON.BLANK, 'the separator says WHY it was excluded');
  eq(res.status, OUTCOME.COMPLETED, 'a packet with a blank separator needs nobody');
  assertTotals(res, 'packet with separator');
}

// ── 3. THE DEFECT: a page nobody claims, that we cannot prove is blank ───────────────────────
// This is the page-7 case. It must reach a person; it must never be quietly excluded or omitted.
{
  const res = pd.dispositionPages({
    pages: [page(1, 'x'), page(2, 'y'), page(3, 'this page holds text but no segment claims it')],
    segments: [{ docType: 'purchase_contract', confidence: 0.9, pages: [1, 2] }],
  });
  eq(res.status, OUTCOME.MANUAL_REQUIRED, 'an unclaimed page makes the packet need a person');
  eq(res.counts.manual_review, 1, 'exactly one page needs review');
  eq(res.pages[2].disposition, DISPOSITION.MANUAL_REVIEW, 'the unclaimed page goes to a human');
  eq(res.pages[2].reason, REASON.UNCLAIMED, 'and says why');
  ok(res.manualPages.includes(3), 'the page NUMBER is reported, so someone can go look at it');
  assertTotals(res, 'unclaimed page');
}

// ── 4. NEVER-FABRICATE: no text reported is silence, not blankness ───────────────────────────
// An image-only scan reads as no text. Calling it blank would drop a real page out of the packet.
{
  const res = pd.dispositionPages({
    pages: [page(1, 'x'), unreadPage(2)],
    segments: [{ docType: 'purchase_contract', confidence: 0.9, pages: [1] }],
  });
  eq(res.pages[1].disposition, DISPOSITION.MANUAL_REVIEW,
    'a page the adapter could NOT read (empty text, no lines report) is NOT assumed blank — this is the shape both real adapters emit for an image-only scan');
  eq(res.counts.excluded, 0, 'nothing was excluded on an assumption');
  assertTotals(res, 'no text reported');
}

// ── 5. a DISPUTED BOUNDARY: two segments both claim the same page ────────────────────────────
{
  const res = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b'), page(3, 'c')],
    segments: [
      { docType: 'purchase_contract', confidence: 0.9, pages: [1, 2] },
      { docType: 'assignment', confidence: 0.85, pages: [2, 3] },
    ],
  });
  eq(res.pages[1].disposition, DISPOSITION.MANUAL_REVIEW, 'the contested page goes to a human');
  eq(res.pages[1].reason, REASON.DISPUTED, 'recorded as a disputed boundary');
  ok(Array.isArray(res.pages[1].claimedBy) && res.pages[1].claimedBy.length === 2,
    'BOTH claimants are kept — the disagreement is the valuable part, so it is never overwritten');
  eq(res.status, OUTCOME.MANUAL_REQUIRED, 'the packet needs a person');
  assertTotals(res, 'disputed boundary');
}

// ── 6. a hedged claim is not an assignment ───────────────────────────────────────────────────
{
  const res = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b')],
    segments: [
      { docType: 'purchase_contract', confidence: 0.95, pages: [1] },
      { docType: 'unknown_form', confidence: 0.05, pages: [2] },
    ],
  });
  eq(res.pages[1].disposition, DISPOSITION.MANUAL_REVIEW, 'a claim below the floor is a hedge, not a placement');
  eq(res.pages[1].reason, REASON.LOW_CONFIDENCE, 'and says so');
  eq(res.pages[1].assignedType, 'unknown_form', 'the weak guess is still recorded, for the human');
  assertTotals(res, 'low confidence');
}

// ── 6b. …but SILENCE about confidence is not doubt ───────────────────────────────────────────
// A classifier that reports no confidence has not expressed uncertainty. Treating null as 0 would
// send every page of an otherwise clean read to a person.
{
  const res = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b')],
    segments: [{ docType: 'purchase_contract', pages: [1, 2] }],
  });
  eq(res.counts.assigned, 2, 'a segment with no confidence number still assigns');
  eq(res.status, OUTCOME.COMPLETED, 'and needs nobody');
  assertTotals(res, 'null confidence');
}

// ── 7. a segment citing a page that does not exist ───────────────────────────────────────────
// The classifier and the read disagree about how many pages there are. Never silently clamped.
{
  const res = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b')],
    segments: [{ docType: 'purchase_contract', confidence: 0.9, pages: [1, 2, 9] }],
  });
  eq(res.counts.assigned, 2, 'the two real pages are still assigned');
  eq(res.outOfRange.length, 1, 'the impossible page is REPORTED, not dropped');
  eq(res.outOfRange[0].page, 9, 'and named');
  eq(res.status, OUTCOME.MANUAL_REQUIRED, 'a page-count disagreement forces a human look');
  assertTotals(res, 'out of range claim');
}

// ── 8. a blank page INSIDE a claimed segment stays part of the document ──────────────────────
// Excluding it would silently shorten a bank statement by a page.
{
  const res = pd.dispositionPages({
    pages: [page(1, 'a'), blankPage(2), page(3, 'c')],
    segments: [{ docType: 'bank_statement', confidence: 0.9, pages: [1, 2, 3] }],
  });
  eq(res.counts.assigned, 3, 'the blank interior page stays with its document');
  eq(res.counts.excluded, 0, 'nothing was carved out of a claimed document');
  assertTotals(res, 'blank inside a segment');
}

// ── 9. NEVER-FABRICATE: no pages seen is not a clean packet ──────────────────────────────────
{
  const res = pd.dispositionPages({ pages: [], segments: [] });
  eq(res.status, OUTCOME.NOT_APPLICABLE, 'zero pages is not-applicable, never "all accounted for"');
  ok(res.accountedFor === false, 'and explicitly does NOT claim the packet was accounted for');
  assertTotals(res, 'no pages');
}

// ── 10. NEVER-FABRICATE: no classification means no basis to assign ──────────────────────────
// Marking a whole packet manual_review because a switch is off would bury the pages that genuinely
// need a person under every page that does not.
{
  const res = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b')],
    segments: [],
    classified: false,
  });
  eq(res.status, OUTCOME.NOT_APPLICABLE, 'unclassified: not-applicable');
  eq(res.counts.manual_review, 0, 'the packet is NOT dumped on a person wholesale');
  eq(res.pageCount, 2, 'the page count is still stated honestly');
  ok(/not classified/i.test(res.detail.note), 'and the reason names the classifier');
}

// ── 10b. classified but the classifier placed NOTHING ────────────────────────────────────────
// Different from 10: the classifier DID run and came back empty. Every page is genuinely unplaced,
// so every page is genuinely a person's problem — and none of them is silently excluded.
{
  const res = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b')],
    segments: [],
    classified: true,
  });
  eq(res.status, OUTCOME.MANUAL_REQUIRED, 'ran and placed nothing: every page needs a person');
  eq(res.counts.manual_review, 2, 'both pages');
  assertTotals(res, 'classified but empty');
}

// ── 11. every status this module emits must be one the stage table ACCEPTS ───────────────────
// The dark-code class, one level down: document_pipeline_stages has a CHECK constraint and the
// writer swallows errors, so a status outside it is never written and the stage looks like it never
// ran. This is the guard that keeps the two in step.
{
  const CONSTRAINT = ['pending', 'running', 'completed', 'not_applicable', 'manual_required', 'failed_retryable', 'failed_terminal'];
  const emitted = Object.values(OUTCOME);
  emitted.forEach((s) => ok(CONSTRAINT.includes(s), `stage status '${s}' is in the db/307 CHECK constraint`));
  // …and the per-page dispositions against db/330's own constraint.
  const PAGE_CONSTRAINT = ['assigned', 'excluded', 'manual_review'];
  Object.values(DISPOSITION).forEach((d) => ok(PAGE_CONSTRAINT.includes(d), `page disposition '${d}' is in the db/330 CHECK constraint`));
}

// ── 12. never throws, on any shape ───────────────────────────────────────────────────────────
{
  const junk = [undefined, null, {}, { pages: null, segments: null }, { pages: 'nope', segments: 'nope' },
    { pages: [null, undefined, 3], segments: [null, 'x', { pages: 'no' }] },
    { pages: [page(1, 'a')], segments: [{ docType: 'x', pages: [0, -4, 1.5, NaN, Infinity] }] }];
  let threw = false;
  for (const j of junk) { try { pd.dispositionPages(j); } catch (_e) { threw = true; } }
  ok(!threw, 'dispositionPages never throws, whatever it is handed');
  // The fractional/zero/negative page numbers above must not have produced a phantom assignment.
  const res = pd.dispositionPages({ pages: [page(1, 'a')], segments: [{ docType: 'x', pages: [0, -4, NaN] }] });
  eq(res.counts.assigned, 0, 'a segment citing only impossible page numbers assigns nothing');
  eq(res.counts.manual_review, 1, 'so the real page goes to a person');
}

// ── 13. AUDIT REGRESSIONS (2026-07-26) — the ways a page vanished before ─────────────────────
{
  // (a) THE BIG ONE. Both production adapters emit text:'' for a page they could not read, so
  // inferring "blank" from empty text excluded every image-only page from the packet AND reported
  // "every page was placed". Blank now needs positive evidence.
  const imageOnly = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b'), { pageNumber: 3, text: '', lines: [{}] }, page(4, 'd')],
    segments: [{ docType: 'purchase_contract', confidence: 0.9, pages: [1, 2, 4] }],
  });
  eq(imageOnly.counts.excluded, 0, 'an unreadable page is NEVER excluded as blank');
  eq(imageOnly.status, OUTCOME.MANUAL_REQUIRED, 'it makes the packet need a person');
  ok(imageOnly.manualPages.includes(3), 'and names the page');

  // (b) the read is a SLICE — the adapter numbers its pages 5,6,7 and the classifier agrees.
  const sliced = pd.dispositionPages({
    pages: [page(5, 'a'), page(6, 'b'), page(7, 'c')],
    segments: [{ docType: 'bank_statement', confidence: 0.9, pages: [5, 6, 7] }],
  });
  eq(sliced.counts.assigned, 3, 'a sliced read lines up with the classifier instead of being renumbered 1..3');
  eq(sliced.outOfRange.length, 0, 'and the classifier is not falsely reported as disagreeing');
  ok(sliced.pages.map((p) => p.page).join() === '5,6,7', 'the real page numbers are what gets recorded');

  // (c) a 0-indexed classifier. The disagreement must be VISIBLE, not swallowed.
  const zeroIdx = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b'), page(3, 'c')],
    segments: [{ docType: 'x', confidence: 0.9, pages: [0, 1, 2] }],
  });
  ok(zeroIdx.outOfRange.some((o) => o.page === 0), 'a claim BELOW the page range is recorded, not silently dropped');
  eq(zeroIdx.status, OUTCOME.MANUAL_REQUIRED, 'and forces a human look');

  // (d) page 0 from a 0-indexed ADAPTER is a real page, not an alias of page 1.
  const zeroPage = pd.dispositionPages({
    pages: [{ pageNumber: 0, text: 'real content', lines: [{}] }, blankPage(1)],
    segments: [{ docType: 'x', confidence: 0.9, pages: [0] }],
  });
  eq(zeroPage.pageCount, 2, 'page 0 and page 1 are two pages, never merged into one');
  eq(zeroPage.pages[0].disposition, DISPOSITION.ASSIGNED, 'and page 0 keeps its own disposition');

  // (e) ONE segment listing a page twice is a sloppy list, not two documents disagreeing.
  const dupInSeg = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b')],
    segments: [{ docType: 'bank_statement', confidence: 0.9, pages: [1, 2, 2] }],
  });
  eq(dupInSeg.counts.assigned, 2, 'a repeated page within one segment is deduped');
  eq(dupInSeg.status, OUTCOME.COMPLETED, 'and is NOT reported as a disputed boundary against itself');

  // (f) an explicit pageCount may not override what the read actually returned — in either
  // direction. Over-stating invented assigned pages; under-stating left real pages undispositioned
  // while still reporting success.
  const over = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b')], pageCount: 6,
    segments: [{ docType: 'x', confidence: 0.9, pages: [1, 2, 3, 4, 5, 6] }],
  });
  eq(over.pageCount, 2, 'an over-stated pageCount cannot invent pages the read never returned');
  const under = pd.dispositionPages({
    pages: [page(1, 'a'), page(2, 'b'), page(3, 'c'), page(4, 'd'), page(5, 'e')], pageCount: 2,
    segments: [],
  });
  eq(under.pageCount, 5, 'an under-stated pageCount cannot hide pages the read DID return');
  assertTotals(under, 'under-stated pageCount');
}

console.log(`test-page-disposition-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

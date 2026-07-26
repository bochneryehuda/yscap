'use strict';
/**
 * RS-2 — the CLASSIFICATION stage's decision logic (src/pipeline/classify-document.js).
 * PURE: no database, no network, no vendor.
 *
 * The property under test is NEVER-FABRICATE. Each of the four states a classifier run can be in
 * has exactly one honest outcome, and none of them is the placeholder the stage used to record on
 * every document ("pending — classifier stage not yet wired"):
 *
 *   no classifier configured  → not_applicable  (nothing is coming; nothing is broken)
 *   ran, produced segments    → completed
 *   ran, placed nothing       → failed, NOT retryable (same bytes, same model, same answer)
 *   errored / threw           → failed_retryable (a transport blip deserves another attempt)
 *
 * And the family comparison is 'unknown' whenever either side is missing — a document filed with no
 * declared family cannot disagree with anything.
 */
const assert = require('assert');
const C = require(require('path').resolve(__dirname, '../src/pipeline/classify-document'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async function main() {
  /* ---- summarizeClassification: the four outcomes ---- */
  {
    const r = C.summarizeClassification({ available: false, ok: false, reason: 'not trained', segments: [] }, { expectedFamily: 'bank_statement' });
    ok(r.status === 'not_applicable', 'no classifier → not_applicable');
    ok(r.artifact === null, 'no classifier → no artifact is invented');
    ok(/not classified/i.test(r.detail.note), 'the note says plainly that the document was not classified');
  }
  {
    const r = C.summarizeClassification({ available: true, ok: false, reason: 'socket hang up', segments: [] }, {});
    ok(r.status === 'failed_retryable', 'a vendor error → failed_retryable');
    ok(r.detail.reason === 'socket hang up', 'the vendor reason is carried through for the operator');
  }
  {
    const r = C.summarizeClassification({ available: true, ok: true, segments: [] }, { expectedFamily: 'insurance' });
    ok(r.status === 'failed', 'ran but placed nothing → failed');
    ok(r.status !== 'failed_retryable', 'and NOT retryable — a paid re-call reaches the same answer');
    ok(r.artifact && r.artifact.segmentCount === 0 && r.artifact.familyMatch === 'unknown',
      'the empty result is still RECORDED, as unknown rather than as agreement');
  }
  {
    const r = C.summarizeClassification({
      available: true, ok: true,
      segments: [{ docType: 'bank_statement', rawLabel: 'bankStatement', confidence: 0.94, pages: [1, 2] }],
    }, { expectedFamily: 'bank_statement' });
    ok(r.status === 'completed', 'segments → completed');
    ok(r.artifact.familyMatch === 'match' && r.artifact.detectedFamily === 'bank_statement', 'agreement is recorded as a match');
    ok(r.artifact.pageCount === 2, 'the page map is recorded');
  }

  /* ---- the finding this stage exists to produce ---- */
  {
    const r = C.summarizeClassification({
      available: true, ok: true,
      segments: [{ docType: 'purchase_contract', confidence: 0.9, pages: [1, 2, 3] }],
    }, { expectedFamily: 'bank_statement' });
    ok(r.status === 'completed', 'a mismatch still COMPLETES — the stage did its job');
    ok(r.artifact.familyMatch === 'mismatch', 'filed as one thing, reads as another → mismatch');
    ok(/different type/i.test(r.detail.note), 'the note says what is actually wrong, in plain words');
  }

  /* ---- never-fabricate: a missing side is 'unknown', never a silent match ---- */
  {
    const noExpected = C.summarizeClassification({
      available: true, ok: true, segments: [{ docType: 'insurance', confidence: 0.8, pages: [1] }],
    }, {});
    ok(noExpected.artifact.familyMatch === 'unknown', 'no declared family → unknown, never a match');
    ok(C._internals.familyVerdict('bank_statement', null) === 'unknown', 'no detected type → unknown');
    ok(C._internals.familyVerdict(null, null) === 'unknown', 'neither side → unknown');
    ok(C._internals.familyVerdict('  Bank_Statement ', 'bank_statement') === 'match', 'comparison ignores case + surrounding space');
    ok(C._internals.familyVerdict('bank_statement', 'purchase_contract') === 'mismatch', 'two real different types → mismatch');
  }

  /* ---- dominant segment: PAGE COVERAGE leads, confidence breaks the tie ---- */
  {
    const d = C._internals.dominantSegment([
      { docType: 'rider', confidence: 0.99, pages: [7] },
      { docType: 'purchase_contract', confidence: 0.71, pages: [1, 2, 3, 4, 5, 6] },
    ]);
    ok(d.docType === 'purchase_contract',
      'the type covering most pages wins over a single high-confidence page (that is a rider, not the document)');
    const t = C._internals.dominantSegment([
      { docType: 'a', confidence: 0.5, pages: [1] }, { docType: 'b', confidence: 0.9, pages: [2] },
    ]);
    ok(t.docType === 'b', 'equal coverage → higher confidence wins');
    ok(C._internals.dominantSegment([]) === null && C._internals.dominantSegment(null) === null, 'nothing to choose → null');
  }

  /* ---- no PII, ever, in the artifact ---- */
  {
    const r = C.summarizeClassification({
      available: true, ok: true,
      segments: [{ docType: 'bank_statement', rawLabel: 'bankStatement', confidence: 0.9, pages: [2, 1, 2] }],
    }, { expectedFamily: 'bank_statement' });
    const json = JSON.stringify(r.artifact);
    ok(!/text|content|value|holder|account/i.test(json), 'the artifact carries type + pages only — no text, no field values');
    ok(r.artifact.segments[0].pages.join() === '1,2', 'page numbers are de-duplicated and sorted');
  }

  /* ---- classifyDocument: never throws, and never calls a classifier it should not ---- */
  {
    const none = await C.classifyDocument({ classifier: null, request: { buffer: Buffer.from('x') } });
    ok(none.available === false && none.ok === false, 'a null classifier is "not available", not an error');

    const unconfigured = await C.classifyDocument({
      classifier: { classifierConfigured: () => false, classify: async () => { throw new Error('must not be called'); } },
      request: { buffer: Buffer.from('x') },
    });
    ok(unconfigured.available === false, 'an untrained classifier is not called at all');

    const noBytes = await C.classifyDocument({
      classifier: { classifierConfigured: () => true, classify: async () => { throw new Error('must not be called'); } },
      request: {},
    });
    ok(noBytes.available === true && noBytes.ok === false && /bytes/i.test(noBytes.reason),
      'a configured classifier with no bytes is a real gap (retryable), not a silent pass');

    const threw = await C.classifyDocument({
      classifier: { classifierConfigured: () => true, classify: async () => { throw new Error('boom'); } },
      request: { buffer: Buffer.from('x') },
    });
    ok(threw.available === true && threw.ok === false && threw.reason === 'boom', 'a throwing classifier is caught and reported');

    const badConfigured = await C.classifyDocument({
      classifier: { classifierConfigured: () => { throw new Error('cfg blew up'); }, classify: async () => ({ ok: true, segments: [] }) },
      request: { buffer: Buffer.from('x') },
    });
    ok(badConfigured.available === false, 'even a throwing configured() check degrades to not-available, never an exception');

    const good = await C.classifyDocument({
      classifier: { classifierConfigured: () => true, classify: async () => ({ ok: true, segments: [{ docType: 'insurance', pages: [1], confidence: 0.8 }] }) },
      request: { base64: 'eA==' },
    });
    ok(good.ok === true && good.segments.length === 1, 'a good run returns its segments');
  }

  /* ---- shape-tolerance: garbage in never throws ---- */
  {
    for (const bad of [null, undefined, {}, { available: true, ok: true, segments: 'nope' }, { available: true, ok: true, segments: [null, {}, 5] }]) {
      const r = C.summarizeClassification(bad, {});
      ok(!!r && typeof r.status === 'string', `a malformed result (${JSON.stringify(bad)}) still yields a status, never a throw`);
    }
  }

  console.log(`test-classify-document-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

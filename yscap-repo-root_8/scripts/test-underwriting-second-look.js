'use strict';
/**
 * Backup / second-look OCR (owner-directed 2026-07-21). When the first read of a text-schema
 * document comes back low-confidence (model flags `readable:false`) and we have real IMAGE bytes we
 * did NOT already send, engine.analyzeDocument re-runs the extract WITH the image (a vision re-read)
 * and keeps the better result. Pure — injected reader/analyzer stubs, no DB/network/keys.
 */
const assert = require('assert');
const { analyzeDocument } = require('../src/lib/underwriting/engine');

const reader = (result) => ({ read: async () => result });
// A call-sequenced analyzer: returns results[i] on the i-th call (clamped), recording each call's args.
function seqAnalyzer(results) {
  const calls = [];
  return { extract: async (args) => { calls.push(args); return results[Math.min(calls.length - 1, results.length - 1)]; }, calls };
}

const OCR = { ok: true, text: 'blurry insurance binder ...', pageCount: 1 };
const unreadable = { ok: true, data: { readable: false } };
const goodInsurance = {
  ok: true,
  data: { readable: true, namedInsured: 'Acme Holdings LLC', mortgageeClausePresent: true,
    mortgageeClause: 'YS Capital ISAOA/ATIMA, PO Box 1, NY', dwellingCoverage: 500000,
    policyEffective: '2026-01-01', policyExpiration: '2027-01-01' },
};

async function main() {
  // 1. First read UNREADABLE + we have IMAGE bytes on a text-schema doc (insurance, image falsy) →
  //    a SECOND-LOOK fires WITH the image, the better read wins, and it's marked secondLook.
  {
    const an = seqAnalyzer([unreadable, goodInsurance]);
    const res = await analyzeDocument(
      { docType: 'insurance', base64: 'aW1n', mimeType: 'image/jpeg', subject: { loan_amount: 400000 }, today: '2026-07-21' },
      { reader: reader(OCR), analyzer: an });
    assert.strictEqual(res.ok, true, 'analyze succeeds');
    assert.strictEqual(res.extraction.secondLook, true, 'the second-look fired and won');
    assert.strictEqual(res.extraction.confidence, 'analyzed', 'confidence recovered from unreadable → analyzed');
    assert.strictEqual(res.extraction.fields.namedInsured, 'Acme Holdings LLC', 'the retry (better) data is what we kept');
    assert.strictEqual(an.calls.length, 2, 'exactly two extract calls (first text, then vision)');
    assert.strictEqual(an.calls[0].imageBase64, undefined, 'first read is OCR-text only');
    assert.strictEqual(an.calls[1].imageBase64, 'aW1n', 'second read sends the image');
  }

  // 2. First read is FINE → no second look, analyzer called once.
  {
    const an = seqAnalyzer([goodInsurance]);
    const res = await analyzeDocument(
      { docType: 'insurance', base64: 'aW1n', mimeType: 'image/jpeg', subject: {}, today: '2026-07-21' },
      { reader: reader(OCR), analyzer: an });
    assert.strictEqual(res.extraction.secondLook, false, 'a good first read never triggers a second look');
    assert.strictEqual(an.calls.length, 1, 'only one extract call');
  }

  // 3. First read unreadable BUT the document is a PDF (no image bytes to re-send) → no second look
  //    (the analyzer can only attach image/*; a PDF cannot be sent as an image).
  {
    const an = seqAnalyzer([unreadable, goodInsurance]);
    const res = await analyzeDocument(
      { docType: 'insurance', base64: 'JVBERi0=', mimeType: 'application/pdf', subject: {}, today: '2026-07-21' },
      { reader: reader(OCR), analyzer: an });
    assert.strictEqual(res.extraction.secondLook, false, 'a PDF has no image bytes → no vision retry');
    assert.strictEqual(an.calls.length, 1, 'only one extract call for a PDF');
    assert.strictEqual(res.extraction.confidence, 'unreadable', 'the honest unreadable read stands');
  }

  // 4. First read unreadable, image present, but the SECOND read is ALSO unreadable → keep the first
  //    (never replace a bad read with an equally bad one), secondLook stays false.
  {
    const an = seqAnalyzer([unreadable, { ok: true, data: { readable: false } }]);
    const res = await analyzeDocument(
      { docType: 'insurance', base64: 'aW1n', mimeType: 'image/jpeg', subject: {}, today: '2026-07-21' },
      { reader: reader(OCR), analyzer: an });
    assert.strictEqual(res.extraction.secondLook, false, 'a no-better retry does not flip secondLook');
    assert.strictEqual(an.calls.length, 2, 'the retry was attempted');
    assert.strictEqual(res.extraction.confidence, 'unreadable', 'the original unreadable result is kept');
  }

  // 5. government_id already sends the image on the FIRST pass (entry.image=true) → no second look
  //    (there is nothing new to try).
  {
    const an = seqAnalyzer([unreadable, goodInsurance]);
    const res = await analyzeDocument(
      { docType: 'government_id', base64: 'aW1n', mimeType: 'image/jpeg', subject: {}, today: '2026-07-21' },
      { reader: reader(OCR), analyzer: an });
    assert.strictEqual(res.extraction.secondLook, false, 'an image-first doc has no separate second look');
    assert.strictEqual(an.calls[0].imageBase64, 'aW1n', 'the image was already sent on the first pass');
    assert.strictEqual(an.calls.length, 1, 'only one extract call');
  }

  console.log('PASS test-underwriting-second-look');
}
main().catch((e) => { console.error('FAIL test-underwriting-second-look:', e.message); process.exit(1); });

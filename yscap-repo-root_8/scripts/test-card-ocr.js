'use strict';
/**
 * Credit-card OCR — the appraisal "scan a photo of the card" reader.
 *
 * Verifies the pure parsing/validation logic AND the reader routing: the
 * best-in-class vision model (Azure OpenAI) is the PRIMARY reader, the hosted
 * OCR is only a fallback, and a Luhn-invalid number is never handed back.
 * No network / no DB — the analyzer and global fetch are stubbed.
 */
const assert = require('assert');
const Module = require('module');

const VISA = '4242424242424242';            // Luhn-valid
const BAD_LUHN = '4242424242424241';        // one digit off — must be rejected

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓', name); passed++; }

// Reload card-ocr with a stubbed analyzer + optional global.fetch so we can
// assert which reader runs, with no network call.
function loadWithAnalyzer(analyzerStub) {
  const analyzerPath = require.resolve('../src/lib/ai/azure-openai');
  const cardPath = require.resolve('../src/lib/integrations/card-ocr');
  delete require.cache[analyzerPath];
  delete require.cache[cardPath];
  const realLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && /card-ocr\.js$/.test(parent.filename) && /azure-openai$/.test(request)) return analyzerStub;
    return realLoad.apply(this, arguments);
  };
  try {
    return require('../src/lib/integrations/card-ocr');
  } finally {
    Module._load = realLoad;
    delete require.cache[cardPath];
    delete require.cache[analyzerPath];
  }
}

async function main() {
  // --- pure logic --------------------------------------------------------
  const m = require('../src/lib/integrations/card-ocr');

  ok('luhnOk accepts a valid PAN', m.luhnOk(VISA) === true);
  ok('luhnOk rejects a one-digit-off PAN', m.luhnOk(BAD_LUHN) === false);
  ok('luhnOk rejects too-short', m.luhnOk('4242') === false);

  assert.deepStrictEqual(
    m.normalizeCard({ number: '4242 4242 4242 4242', expMonth: '8', expYear: '28' }),
    { number: VISA, expMonth: '8', expYear: '2028' });
  ok('normalizeCard cleans spaces, pads 2-digit year', true);

  assert.deepStrictEqual(m.normalizeCard({ number: BAD_LUHN, expMonth: '8', expYear: '2028' }),
    { expMonth: '8', expYear: '2028' });
  ok('normalizeCard DROPS a Luhn-invalid number (never a wrong PAN)', true);

  assert.deepStrictEqual(m.normalizeCard({ number: VISA, expMonth: '13', expYear: '0028' }),
    { number: VISA });
  ok('normalizeCard drops an out-of-range month + implausible year', true);

  assert.deepStrictEqual(m.normalizeCard({ number: null, expMonth: null, expYear: null }), {});
  ok('normalizeCard handles all-null (unreadable photo) → {}', true);

  assert.deepStrictEqual(
    m.parseCard('VISA  4242 4242 4242 4242   GOOD THRU 08/28   JANE DOE'),
    { number: VISA, expMonth: '8', expYear: '2028' });
  ok('parseCard pulls PAN + expiry out of OCR text', true);

  // --- reader routing (stub analyzer + fetch) ----------------------------
  const savedFetch = global.fetch;
  try {
    // 1) Vision configured + reads the card → vision wins, OCR.space not called.
    {
      let ocrCalled = false;
      const analyzerStub = {
        available: () => true,
        extract: async (a) => {
          assert.ok(a.imageBase64 && /^image\//.test(a.imageMime), 'vision gets the image');
          assert.ok(a.schema && !('cvc' in (a.schema.properties || {})), 'schema never asks for the CVC');
          return { ok: true, data: { number: VISA, expMonth: '8', expYear: '2028', readable: true } };
        },
      };
      global.fetch = async () => { ocrCalled = true; return { ok: true, json: async () => ({}) }; };
      const c = loadWithAnalyzer(analyzerStub);
      const r = await c.scanCard({ dataBase64: 'AAAA', contentType: 'image/jpeg', appId: 'app-1' });
      assert.deepStrictEqual(r, { number: VISA, expMonth: '8', expYear: '2028' });
      assert.strictEqual(ocrCalled, false, 'OCR.space fallback NOT called when vision succeeds');
      ok('vision model is the PRIMARY reader (no fallback when it succeeds)', true);
    }

    // 2) Vision configured but reads nothing → falls back to hosted OCR.
    {
      let ocrCalled = false;
      const analyzerStub = {
        available: () => true,
        extract: async () => ({ ok: true, data: { number: null, expMonth: null, expYear: null, readable: false } }),
      };
      global.fetch = async () => {
        ocrCalled = true;
        return { ok: true, json: async () => ({ ParsedResults: [{ ParsedText: '4242 4242 4242 4242  08/28' }] }) };
      };
      const c = loadWithAnalyzer(analyzerStub);
      const r = await c.scanCard({ dataBase64: 'AAAA', contentType: 'image/jpeg' });
      assert.strictEqual(ocrCalled, true, 'fallback OCR runs when vision reads nothing');
      assert.strictEqual(r.number, VISA);
      ok('falls back to hosted OCR when the vision model reads nothing usable', true);
    }

    // 3) Vision NOT configured → hosted OCR is the reader.
    {
      let ocrCalled = false;
      const analyzerStub = { available: () => false, extract: async () => { throw new Error('should not be called'); } };
      global.fetch = async () => {
        ocrCalled = true;
        return { ok: true, json: async () => ({ ParsedResults: [{ ParsedText: '4242 4242 4242 4242  VALID THRU 08/28' }] }) };
      };
      const c = loadWithAnalyzer(analyzerStub);
      const r = await c.scanCard({ dataBase64: 'AAAA', contentType: 'image/jpeg' });
      assert.strictEqual(ocrCalled, true, 'hosted OCR runs when vision is off');
      assert.strictEqual(r.number, VISA);
      ok('hosted OCR is the reader when the vision model is not configured', true);
    }

    // 4) Vision says readable:false → its (possibly wrong) number is NOT trusted;
    //    falls back, and never prefills the untrusted number.
    {
      const analyzerStub = {
        available: () => true,
        // A Luhn-VALID but low-confidence number the model itself flags as untrustworthy.
        extract: async () => ({ ok: true, data: { number: VISA, expMonth: '8', expYear: '2028', readable: false } }),
      };
      global.fetch = async () => ({ ok: true, json: async () => ({ ParsedResults: [{ ParsedText: '' }] }) });
      const c = loadWithAnalyzer(analyzerStub);
      const r = await c.scanCard({ dataBase64: 'AAAA', contentType: 'image/jpeg' });
      assert.ok(!r.number, 'a readable:false read is never prefilled');
      ok('honors readable:false — an untrusted read is discarded, never prefilled', true);
    }

    // 5) Vision THROWS → falls back to hosted OCR.
    {
      let ocrCalled = false;
      const analyzerStub = { available: () => true, extract: async () => { throw new Error('boom'); } };
      global.fetch = async () => {
        ocrCalled = true;
        return { ok: true, json: async () => ({ ParsedResults: [{ ParsedText: '4242 4242 4242 4242  08/28' }] }) };
      };
      const c = loadWithAnalyzer(analyzerStub);
      const r = await c.scanCard({ dataBase64: 'AAAA', contentType: 'image/jpeg' });
      assert.strictEqual(ocrCalled, true, 'fallback runs when vision throws');
      assert.strictEqual(r.number, VISA);
      ok('falls back to hosted OCR when the vision model throws', true);
    }

    // 6) Vision reads nothing + fallback throws → returns {} (route shows friendly msg via empty).
    {
      const analyzerStub = { available: () => true, extract: async () => ({ ok: true, data: { number: null, expMonth: null, expYear: null, readable: false } }) };
      global.fetch = async () => { throw new Error('network down'); };
      const c = loadWithAnalyzer(analyzerStub);
      const r = await c.scanCard({ dataBase64: 'AAAA', contentType: 'image/jpeg' });
      assert.deepStrictEqual(r, {}, 'vision-empty + fallback-throws → {}');
      ok('returns {} when vision reads nothing and the fallback can’t run', true);
    }

    // 7) Vision throws AND fallback throws → scanCard throws (route → friendly 502).
    {
      const analyzerStub = { available: () => true, extract: async () => { throw new Error('vision boom'); } };
      global.fetch = async () => { throw new Error('ocr boom'); };
      const c = loadWithAnalyzer(analyzerStub);
      let threw = false;
      try { await c.scanCard({ dataBase64: 'AAAA', contentType: 'image/jpeg' }); }
      catch (_) { threw = true; }
      assert.strictEqual(threw, true, 'both readers failing → scanCard throws');
      ok('throws only when NO reader could run (route turns it into the friendly 502)', true);
    }
  } finally {
    global.fetch = savedFetch;
  }

  console.log(`\ncard-ocr: ${passed} checks passed`);
}

main().catch((e) => { console.error('card-ocr test FAILED:', e && e.message); process.exit(1); });

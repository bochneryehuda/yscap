/** Credit-card OCR — reads a photo of the appraisal payment card into a
 *  number + expiry the borrower confirms before saving.
 *
 *  PRIMARY reader (owner-directed 2026-07-27): the SAME best-in-class vision
 *  model the whole underwriting engine uses to read IDs and documents —
 *  Azure OpenAI GPT-5 (src/lib/ai/azure-openai.js). It reads the card image
 *  directly (GPT reads images natively) and returns the card number + expiry as
 *  structured fields. This replaces the old cheap hosted OCR (OCR.space), which
 *  now only runs as a FALLBACK when the vision model is not configured or can't
 *  read the photo — so the feature still works out of the box, but the real
 *  reader in production is the modern vision model.
 *
 *  Privacy: the image is sent to the reader for text extraction and is NEVER
 *  persisted by us. We only return the card number + expiry, we NEVER read or
 *  return the CVC/security code, and card data is never logged.
 *
 *  Env:
 *    AZURE_OPENAI_* — the vision reader (see src/lib/ai/azure-openai.js). When
 *      set (as in production) it is the primary reader.
 *    OCR_SPACE_API_KEY — the fallback hosted OCR. Get a free key at
 *      https://ocr.space/ocrapi; unset falls back to OCR.space's public
 *      "helloworld" demo key (heavily rate-limited) so the fallback still works.
 */
const cfg = require('../../config');
const analyzer = require('./../ai/azure-openai');

function luhnOk(s) {
  s = String(s || '').replace(/\D/g, '');
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0, dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Turn whatever the reader gave us (vision fields OR raw OCR text) into a clean,
// VALIDATED result. A card number is only kept when it is 13–19 digits AND passes
// the Luhn checksum — a misread digit fails Luhn, so we hand back a blank number
// rather than a wrong one (the borrower would re-key it anyway). The CVC is never
// touched. @returns {{ number?:string, expMonth?:string, expYear?:string }}
function normalizeCard({ number, expMonth, expYear } = {}) {
  const out = {};
  const digits = String(number || '').replace(/\D/g, '');
  if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) out.number = digits;
  const m = parseInt(expMonth, 10);
  if (m >= 1 && m <= 12) out.expMonth = String(m);
  let y = String(expYear == null ? '' : expYear).replace(/\D/g, '');
  if (y.length === 2) y = '20' + y;
  if (/^20\d{2}$/.test(y)) out.expYear = y;   // card expiry years are always 20xx
  return out;
}

// Pull a Luhn-valid 13–19 digit PAN and an MM/YY(YY) expiry out of raw OCR text
// (the OCR.space fallback path — the vision model returns fields directly).
function parseCard(text) {
  const s = String(text || '');
  const out = {};
  const cands = s.replace(/[^\d ]/g, ' ').match(/(?:\d[ ]?){13,19}/g) || [];
  for (const c of cands) {
    const d = c.replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhnOk(d)) { out.number = d; break; }
  }
  const exp = s.match(/\b(0[1-9]|1[0-2])\s*[/\-]\s*(\d{2,4})\b/);
  if (exp) {
    out.expMonth = String(parseInt(exp[1], 10));
    out.expYear = exp[2].length === 2 ? '20' + exp[2] : exp[2];
  }
  return out;
}

// The strict JSON shape the vision model returns (Azure structured outputs:
// additionalProperties:false, every property in `required`, nullable via
// ["string","null"], no min/max/length). CVC is deliberately NOT requested.
const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    number:   { type: ['string', 'null'] },   // the full card number, digits only
    expMonth: { type: ['string', 'null'] },    // "1".."12"
    expYear:  { type: ['string', 'null'] },    // 4-digit year, e.g. "2028"
    readable: { type: 'boolean' },             // false if the photo is too poor to trust
  },
  required: ['number', 'expMonth', 'expYear', 'readable'],
};

const CARD_INSTRUCTIONS =
  'You are reading a photo of a payment card (a credit or debit card) so a person ' +
  'can confirm the details. Read ONLY the primary account number (the long 13–19 ' +
  'digit number printed or embossed on the front) and the expiration date. Return ' +
  'the card number as digits only, with no spaces. Return expMonth as a number 1–12 ' +
  'and expYear as a 4-digit year. Use null for any field you cannot read with ' +
  'confidence — do NOT guess. Do NOT return the CVC / security code / signature-panel ' +
  'digits. Set "readable" to false if the image is too blurry, cropped, or dark to trust.';

// PRIMARY reader: Azure OpenAI GPT-5 vision reads the card image directly.
// @returns normalized { number?, expMonth?, expYear? } (possibly empty).
async function scanWithVision({ dataBase64, imageMime, appId }) {
  const res = await analyzer.extract({
    system: 'You are a precise reader of payment-card images. You never guess and you never return a security code.',
    instructions: CARD_INSTRUCTIONS,
    schema: CARD_SCHEMA,
    imageBase64: dataBase64,
    imageMime,
    traceMeta: { name: 'card-ocr', opName: 'scan_card', appId, tags: ['card-ocr'] },
  });
  if (!res.ok || !res.data) return {};
  // The model told us the photo is too blurry/cropped/dark to trust — don't prefill
  // a low-confidence read (even a Luhn-valid number could be a misread). Treat it as
  // "read nothing" so the fallback reader gets a try and the borrower keys it by hand.
  if (res.data.readable === false) return {};
  return normalizeCard(res.data);   // { number?, expMonth?, expYear? } — never logged
}

// FALLBACK reader: hosted OCR.space (also the path when the vision model is off).
async function scanWithOcrSpace({ dataBase64, imageMime }) {
  const key = cfg.ocrSpaceApiKey || 'helloworld';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  let r;
  try {
    const form = new URLSearchParams();
    form.set('base64Image', `data:${imageMime};base64,${dataBase64}`);
    form.set('OCREngine', '2');     // engine 2 handles card-style fonts better
    form.set('scale', 'true');
    form.set('isTable', 'false');
    r = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: ac.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'OCR request timed out' : `OCR request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.IsErroredOnProcessing) {
    const msg = j.ErrorMessage ? [].concat(j.ErrorMessage).join('; ') : `HTTP ${r.status}`;
    throw new Error(`OCR failed: ${msg}`);
  }
  const text = (j.ParsedResults || []).map((p) => p.ParsedText || '').join('\n');
  return parseCard(text);   // { number?, expMonth?, expYear? } — never logged
}

/**
 * Read a card photo into { number?, expMonth?, expYear? } for the borrower to
 * confirm. Tries the best-in-class vision model first; falls back to the hosted
 * OCR when the vision model is unavailable or reads nothing usable. Throws only
 * when NO reader could run at all (so the route can show the "enter it below"
 * message); a reader that simply couldn't read the photo returns {} (empty).
 */
async function scanCard({ dataBase64, contentType, appId } = {}) {
  if (!dataBase64) throw new Error('no image');
  const imageMime = /^image\//.test(contentType || '') ? contentType : 'image/jpeg';

  // 1) Best-in-class: the vision model (used everywhere else in the app).
  if (analyzer.available()) {
    let visionErr = null;
    try {
      const out = await scanWithVision({ dataBase64, imageMime, appId });
      if (out && (out.number || out.expMonth || out.expYear)) return out;
      // Vision ran but read nothing usable — try the fallback reader before giving up.
    } catch (e) {
      visionErr = e;   // vision itself errored — fall through to the fallback reader
    }
    // 2) Fallback reader as a backstop. If it also can't run, surface the ORIGINAL
    //    problem (the vision error when there was one) so the route can respond.
    try {
      return await scanWithOcrSpace({ dataBase64, imageMime });
    } catch (e) {
      if (visionErr) throw visionErr;
      return {};   // vision ran fine but read nothing; fallback couldn't run → empty
    }
  }

  // Vision not configured → the hosted OCR is the reader.
  return scanWithOcrSpace({ dataBase64, imageMime });
}

module.exports = { scanCard, parseCard, normalizeCard, luhnOk };

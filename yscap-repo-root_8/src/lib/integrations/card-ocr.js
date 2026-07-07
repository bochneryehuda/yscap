/** Credit-card OCR via a hosted OCR API (OCR.space by default).
 *
 *  Owner-directed (2026-07-07): the appraisal-card "scan a photo" flow uses a
 *  HOSTED OCR API rather than on-device OCR. The image is sent to the provider
 *  for text extraction and is NEVER persisted by us; we only parse the returned
 *  text for the card number + expiry, and card data is never logged.
 *
 *  Env: OCR_SPACE_API_KEY — get a free key at https://ocr.space/ocrapi. If unset
 *  we fall back to OCR.space's public "helloworld" demo key (heavily rate-limited
 *  and size-capped) so the feature works out of the box for testing; set a real
 *  key for production.
 */
const cfg = require('../../config');

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

// Pull a Luhn-valid 13–19 digit PAN and an MM/YY(YY) expiry out of raw OCR text.
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

async function scanCard({ dataBase64, contentType }) {
  if (!dataBase64) throw new Error('no image');
  const key = cfg.ocrSpaceApiKey || 'helloworld';
  const ct = /^image\//.test(contentType || '') ? contentType : 'image/jpeg';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  let r;
  try {
    const form = new URLSearchParams();
    form.set('base64Image', `data:${ct};base64,${dataBase64}`);
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

module.exports = { scanCard, parseCard, luhnOk };

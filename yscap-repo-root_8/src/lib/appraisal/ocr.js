'use strict';
/**
 * ADVISORY-ONLY OCR of an appraisal PDF, to help an officer VERIFY a missing As-Is value.
 *
 * The owner's rule is absolute: never GUESS a value onto the loan file. When the XML does
 * not carry a DEFINITE As-Is value we open the internal "Verify As-Is value" condition for
 * an officer. This module is the "we also tried OCR" step the owner asked for: it reads the
 * actual PDF with the same hosted OCR.space service the appraisal-card scan uses, looks for
 * an "As-Is" dollar amount, and returns a CANDIDATE the officer confirms by hand. It is
 * attached to that condition as a note — it is NEVER written to applications, and the result
 * always states plainly that OCR was attempted (so the officer knows what was tried).
 *
 * Fully best-effort: no key, timeout, oversized PDF, service error, or no confident match
 * all return a structured result the caller can note. It NEVER throws and NEVER blocks the
 * import from succeeding.
 *
 * Env: OCR_SPACE_API_KEY (falls back to the rate-limited public demo key for testing).
 */
const cfg = require('../../config');

// OCR.space's free-tier PDF ceiling is ~1 MB; the public demo key is even smaller. Appraisal
// PDFs are routinely 5–30 MB, so most will be too large — in that case we advise the officer
// to read the value off the report rather than pretend we scanned it.
const MAX_OCR_PDF_BYTES = 1024 * 1024;

/**
 * Find "As-Is" dollar amounts in OCR'd appraisal text. 1004/1025 narrative phrasings put the
 * as-is opinion near the words "as is" / "as-is" (e.g. "'as is' market value", "as is value").
 * We EXCLUDE the as-repaired / as-completed / subject-to / after-repair language so we can
 * never surface the ARV or a hypothetical-condition number by mistake.
 * @returns {Array<{amount:number, snippet:string}>}
 */
function findAsIs(text) {
  const s = String(text || '').replace(/ /g, ' ');
  const lines = s.split(/[\n\r]+/);
  // A dollar amount MUST carry a currency signal — a `$` OR thousands grouping (how appraisal
  // dollars are virtually always written, e.g. "$430,000" / "430,000"). A bare run of digits
  // is NOT treated as money, so a zip (90210), APN (12345678), phone or reference number on an
  // "as is" line can never be misread as a value.
  const money = /\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s?\d{4,8}(?:\.\d{2})?|\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g;
  const hits = [];
  for (const raw of lines) {
    const ln = raw.trim();
    const tok = ln.match(/as[\s-]*is/i);
    if (!tok) continue;
    const asIdx = tok.index, tokEnd = asIdx + tok[0].length;
    // Drop lines that clearly speak to the AS-REPAIRED / prospective / hypothetical value so we
    // never surface the ARV.
    if (/as[\s-]*repaired|as[\s-]*complete|subject[\s-]*to|after[\s-]*repair|upon\s+completion|hypothetical|prospective/i.test(ln)) continue;
    // When several amounts share the line, prefer the one that FOLLOWS the "as is" token — the
    // near-universal phrasing is "as is value is $X". An amount that sits BEFORE the token (an
    // ARV printed to its left, e.g. "the renovated figure is $575,000; the as is value is
    // $430,000") is heavily penalised, so $430,000 wins — never the ARV.
    let best = null, bestDist = Infinity;
    let prevEnd = 0;   // end of the previous money token on this line (0 = line start)
    for (const m of ln.matchAll(money)) {
      const mi = m.index, mEnd = mi + m[0].length;
      // The ARV-synonym window is the segment SINCE THE PREVIOUS AMOUNT — not a fixed char count.
      // A fixed window is wrong both ways: too short and a long phrasing ("stabilized market value
      // of $575,000") leaks the ARV; too wide and a synonym labelling an EARLIER amount bleeds onto
      // this one ("after renovation $575,000, presently $430,000" would wrongly drop the As-Is
      // $430,000). Bounding to the current amount's own segment fixes both.
      const pre = ln.slice(prevEnd, mi);
      prevEnd = mEnd;   // advance for every money token, qualifying or not
      const n = Number(String(m[0]).replace(/[$,\s]/g, ''));
      if (!(n >= 10000 && n < 100000000)) continue;
      // Skip an amount labelled by an after-repair synonym in its segment — e.g. "stabilized value
      // $575,000", "renovated figure is $575,000", "as-improved $575,000". ARV synonyms outside the
      // whole-line drop-list; the amount after them is the after-repair value, never the As-Is.
      // Precise synonyms only: `renovated`/`after renovation` (NOT bare `renovat`, so "as is value
      // BEFORE renovation is $X" stays As-Is), and `as[\s-]*improv` (NOT bare "improv", so "value
      // of the improvements is $X" stays As-Is).
      if (/renovated|stabiliz|as[\s-]*complet|as[\s-]*improv|after\s+renovation|\barv\b/i.test(pre)) continue;
      const dist = mi >= tokEnd ? (mi - tokEnd) : (asIdx - mEnd) + 1000;
      if (dist < bestDist) { bestDist = dist; best = { amount: n, snippet: ln.slice(0, 180) }; }
    }
    if (best) hits.push(best);
  }
  return hits;
}

/**
 * Attempt an advisory As-Is read of the appraisal PDF.
 * @param {{ pdfBase64?: string, byteLength?: number }} args
 * @returns {Promise<{attempted:boolean, candidate?:number, confidence?:string, snippet?:string, allAmounts?:number[], reason?:string}>}
 */
async function ocrAsIsCandidate({ pdfBase64, byteLength } = {}) {
  if (!pdfBase64) return { attempted: false, reason: 'no appraisal PDF was available to read' };
  const size = byteLength || Math.floor((String(pdfBase64).length * 3) / 4);
  if (size > MAX_OCR_PDF_BYTES) {
    return { attempted: false, reason: 'the appraisal PDF is too large for the OCR service — please read the As-Is off the report' };
  }

  const key = cfg.ocrSpaceApiKey || 'helloworld';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  let r, j;
  try {
    const form = new URLSearchParams();
    form.set('base64Image', `data:application/pdf;base64,${pdfBase64}`);
    form.set('filetype', 'PDF');
    form.set('OCREngine', '1');   // engine 1 handles document text/pages better than the card engine
    form.set('scale', 'true');
    r = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: ac.signal,
    });
    // Read the body INSIDE the abort window — the 10s timer aborts the streamed response too, so a
    // slow/large body can't hang past the timeout (clearing the timer before this left it uncovered).
    j = await r.json().catch(() => ({}));
  } catch (e) {
    return { attempted: true, reason: e.name === 'AbortError' ? 'the OCR service timed out' : `the OCR service could not be reached (${e.message})` };
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok || j.IsErroredOnProcessing) {
    const msg = j.ErrorMessage ? [].concat(j.ErrorMessage).join('; ') : `HTTP ${r.status}`;
    return { attempted: true, reason: `the OCR service reported an error (${msg})` };
  }

  const text = (j.ParsedResults || []).map((p) => p.ParsedText || '').join('\n');
  const hits = findAsIs(text);
  if (!hits.length) return { attempted: true, reason: 'no confident As-Is value could be read from the PDF' };

  const distinct = [...new Set(hits.map((h) => h.amount))];
  return {
    attempted: true,
    candidate: hits[0].amount,
    confidence: distinct.length === 1 ? 'single-match' : 'multiple-candidates',
    snippet: hits[0].snippet,
    allAmounts: distinct.slice(0, 5),
  };
}

/**
 * Render a short, officer-facing note for the "Verify As-Is value" condition. Always leads
 * with the fact that OCR was attempted, per the owner's instruction, and always makes clear
 * the value is NOT applied to the file. Plain language (this note is read by staff, not devs).
 */
function buildOcrNote(adv) {
  // The `[auto]` prefix marks this as system-written so a re-import never clobbers a note an
  // officer typed by hand (the note-write guards on notes IS NULL OR notes LIKE '[auto]%').
  const stamp = '[auto] PILOT tried to read the As-Is value from the appraisal PDF with OCR.';
  if (!adv || (!adv.attempted && !adv.reason)) return `${stamp} It could not be run. Please enter the As-Is value from the report — it is never filled in automatically.`;
  if (adv.candidate != null) {
    const amt = '$' + Number(adv.candidate).toLocaleString('en-US');
    const more = adv.allAmounts && adv.allAmounts.length > 1
      ? ` Other amounts also appeared near "as is" text (${adv.allAmounts.map((n) => '$' + Number(n).toLocaleString('en-US')).join(', ')}), so treat this as a hint only.`
      : '';
    return `${stamp} A possible value of ${amt} was found near "as is" wording${adv.snippet ? ` (read: "${adv.snippet.replace(/\s+/g, ' ').trim()}")` : ''}.${more} This is only a suggestion from OCR — it has NOT been applied to the file. Please confirm the correct As-Is value from the report and enter it yourself.`;
  }
  return `${stamp} ${adv.reason ? adv.reason.charAt(0).toUpperCase() + adv.reason.slice(1) : 'No confident value was found'}. Please enter the As-Is value from the report — it is never filled in automatically.`;
}

module.exports = { ocrAsIsCandidate, findAsIs, buildOcrNote, MAX_OCR_PDF_BYTES };

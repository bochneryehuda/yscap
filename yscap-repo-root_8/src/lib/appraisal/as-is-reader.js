'use strict';
/**
 * THE As-Is READER — the ONE place that answers "what does this appraisal say the As-Is value is?"
 * (owner-directed 2026-07-28).
 *
 * The owner's flow, in their words: *"a lot of times you can find as is value as well on top of the
 * ARV value in the XML so that should be perfect — but if you can't find it in XML … use the
 * strongest OCR and AI to find the as is value; a lot of times it's a note on the appraisal report,
 * it's not even part of the data."*  So the read is a SOURCE LADDER, cheapest-and-most-certain first:
 *
 *   1. XML  — the MISMO data file. When the extractor already resolved a DEFINITE As-Is
 *             (`_CONDITION_OF_APPRAISAL=AsIs` with no hypothetical-completion language → the
 *             structured `PropertyAppraisedValueAmount` IS the As-Is; or an As-Is figure mined out of
 *             the narrative attributes) we are done. Nothing beats the data file, and it costs $0.
 *             Which XMLs carry it and which never do is documented in
 *             docs/appraisal-xml/as-is-value-sources.md.
 *   2. PDF, read by the STRONGEST OCR available (ai/ocr-router: Azure Document Intelligence →
 *      Google Document AI → Mistral, with the legacy OCR.space reader as the last resort) and then
 *      searched deterministically — literally the owner's "click Control F on the PDF and look for
 *      the As is value".
 *   3. AI, as a LOCATOR over that same OCR text — it must hand back a VERBATIM quote, which the
 *      deterministic scanner then re-reads. The AI can point at a line our line-by-line scan missed
 *      (an OCR page break between the label and the amount); it can never invent a number, because
 *      a value is only accepted when the scanner independently reads the same amount out of the
 *      quote the AI returned, and the quote must actually exist in the OCR text.
 *
 * NEVER GUESSES. Every candidate is sanity-bounded, ARV-checked (an "As-Is" above the ARV means we
 * grabbed the wrong number), and only a value we can call CONFIDENT is ever eligible to touch the
 * loan file. Anything less is reported as a candidate for a human, exactly as before.
 *
 * PURE ORCHESTRATION: no database, no config reads at module scope, every IO dependency injected
 * (defaults wired to the real modules) so the whole ladder unit-tests with stubs and no network.
 * Never throws — every failure mode returns a structured, explainable result.
 */

// ---------------------------------------------------------------------------
// Money / plausibility primitives
// ---------------------------------------------------------------------------

// A real US residential appraisal value. Below this a "value" is a fee, a rent, or a page number;
// above it we are reading a portfolio total, not a house.
const MIN_VALUE = 10000;
const MAX_VALUE = 100000000;

// A dollar amount MUST carry a currency signal — a `$` OR thousands grouping (how appraisal dollars
// are virtually always written). A bare run of digits is NOT money, so a zip (90210), an APN, a
// phone or a reference number sitting on an "as is" line can never be misread as a value.
const MONEY_SRC = '\\$\\s?\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?|\\$\\s?\\d{4,8}(?:\\.\\d{2})?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?';
const MONEY_G = new RegExp(MONEY_SRC, 'g');
// A separate NON-global twin for `.test()`. A global regex carries `lastIndex` across calls, so
// testing with MONEY_G would leave it mid-string and make the NEXT scan silently skip text.
const MONEY_TEST = new RegExp(MONEY_SRC);

// Whole-line language that means the sentence is about the AFTER-REPAIR value, not the As-Is.
const ARV_LINE = /as[\s-]*repaired|as[\s-]*complete|subject[\s-]*to|after[\s-]*repair|upon\s+completion|hypothetical|prospective/i;
// After-repair synonyms that LABEL the amount that follows them, inside a line that also says "as is".
const ARV_LABEL = /renovated|stabiliz|as[\s-]*complet|as[\s-]*improv|after\s+renovation|\barv\b/i;
// A dollar amount can sit beside the words "as is" without being the APPRAISER'S OPINION OF THE
// SUBJECT'S VALUE: a comparable's sale price ("Comparable 3 sold as is for $430,000"), an asking
// price, a tax assessment, a rent, an insurance replacement cost. Reading one of those as the As-Is
// would put a stranger's number on the loan, so the whole line is dropped.
// `\blist(ed|ing)\b` (not bare "list") so "the list of repairs" is untouched. A reconciliation
// sentence that happens to mention a listing is dropped too — that is the SAFE direction: the value
// becomes a candidate a human confirms, instead of an asking price written onto the loan.
//
// `site improvement` earns its place the hard way: **`"As-is" Value of Site Improvements` is a
// PRE-PRINTED line on Fannie Mae Forms 1004 / 1025 / 1073 / 2055.** It is on essentially every
// appraisal that fills the cost approach, it is labelled "Value", it is a plausible five-figure
// amount below the ARV, and on a plain 1004 it is frequently the ONLY as-is-labelled money line in
// the entire report — because the real opinion of value is written "my opinion of the market value
// … is $430,000", with no "as is" on the line at all. Without this exclusion a $15,000 driveway
// becomes the property's As-Is. The neighbouring cost-approach terms go with it.
const NOT_OPINION = /comparable|\bcomp\s*[#\d]|\blist(ed|ing)\b|assess|rent\b|insur|replacement\s+cost|site\s*improvement|depreciat|cost[-\s]*new|reproduction|\b(land|site)\s+value/i;
// A RATE is not a value. A Form 1025 (2–4 unit) prints per-unit / per-room / per-bedroom figures
// (`SalesPricePerUnitAmount` and friends), and "As-is value per unit: $150,000" on a 4-family is
// PLAUSIBLE, is BELOW the ARV, and is not a ten-fold slip — so every other guard passes it, and a
// quarter of the property's value would be written onto the loan. Dropped whole.
const PER_UNIT_RATE = /\bper\s+(unit|room|bed(room)?s?|sq(uare)?\s*f(oo)?t|sf|s\.f\.)\b|\/\s*(unit|sf|sq\s*ft)\b/i;
// A LABELLED hit must read as a statement of VALUE, not as incidental "as is" prose. This is what
// separates "the 'as is' market value is $430,000" from "…inspected as is; the rehab budget is
// $85,000". Terser phrasings ("as-is: $430,000") still surface — as a weak candidate that needs the
// AI or a human to confirm, which is the safe failure direction.
const VALUE_WORD = /value|opinion|apprais|market|worth|estimat|indicat/i;
// The MISMO `_CONDITION_OF_APPRAISAL/@_Type` values that say, explicitly, what the appraisal's one
// headline value MEANS. Anything else (blank, or a spelling the parser does not know) leaves the
// basis INFERRED — see the guard in step 1 of readAsIs.
const EXPLICIT_BASIS = /^(AsIs|SubjectToRepairs|SubjectToCompletion|SubjectToInspection)$/i;

function toAmount(tok) {
  const n = Number(String(tok).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// A money token immediately preceded by a minus or an opening bracket is a NEGATIVE (an adjustment,
// a depreciation line) — never a property value. MONEY_SRC carries no sign, so `-$312,500` would
// otherwise read as a positive 312,500.
function signedNegative(line, idx) { return /[-(]\s?$/.test(String(line).slice(Math.max(0, idx - 2), idx)); }

function plausible(n) { return n != null && n >= MIN_VALUE && n <= MAX_VALUE; }

/**
 * The classic OCR digit slip: `$430,000` read as `$43,000` (a dropped zero) or `$4,300,000` (a
 * doubled one). It is invisible to every other check — the number is plausible, it is below the ARV,
 * it sits on a properly labelled line — and it is exactly the kind of mistake that must never be
 * written onto a loan on its own. A candidate that lands within 1% of ANY number we already trust
 * (the ARV, the purchase price, the file's own As-Is) after being multiplied or divided by 10 or 100
 * is treated as a misread and can never be CONFIDENT. It is still reported, so a human decides.
 */
function scaleSlip(v, refs = []) {
  for (const raw of refs) {
    const r = Number(raw);
    if (!Number.isFinite(r) || r <= 0) continue;
    if (Math.abs(v - r) <= r * 0.01) continue;            // it simply agrees — not a slip
    for (const f of [10, 100, 0.1, 0.01]) {
      if (Math.abs(v * f - r) <= r * 0.01) return true;
    }
  }
  return false;
}

/**
 * Scan ONE line of text for an As-Is amount.
 * Returns { amount, strength, snippet } or null.
 *
 *   strength 'labeled' — the amount FOLLOWS the "as is" token ("As-Is Value: $312,500",
 *                        "the as is value is $430,000"). This is the near-universal phrasing and the
 *                        only strength strong enough to stand on its own.
 *   strength 'near'    — the amount sits BEFORE the token on the same line. Real, but weaker: an ARV
 *                        printed to the left of the words "as is" reads the same way, so a 'near'
 *                        hit alone is never treated as confident.
 */
function scanLine(raw) {
  const ln = String(raw || '').replace(/ /g, ' ').trim();
  if (!ln) return null;
  const tok = /as[\s-]*is/i.exec(ln);
  if (!tok) return null;
  // "as is" must be a real word start — otherwise it false-matches inside "basis" / "gas is" and
  // could mine a fabricated value (the same guard extract.js applies to the XML narrative sweep).
  if (tok.index > 0 && /[a-z]/i.test(ln[tok.index - 1])) return null;
  if (ARV_LINE.test(ln)) return null;              // the whole line speaks to the after-repair value
  if (NOT_OPINION.test(ln)) return null;           // a comp / asking price / assessment / rent — not our subject's value
  if (PER_UNIT_RATE.test(ln)) return null;         // a per-unit / per-sq-ft RATE, not the property's value
  const asIdx = tok.index, tokEnd = asIdx + tok[0].length;

  let best = null, bestDist = Infinity;
  let prevEnd = 0;                                  // end of the previous money token on this line
  for (const m of ln.matchAll(MONEY_G)) {
    const mi = m.index, mEnd = mi + m[0].length;
    // The ARV-synonym window is the segment SINCE THE PREVIOUS AMOUNT — bounded to this amount's own
    // segment so a synonym labelling an EARLIER amount can't bleed onto this one.
    const pre = ln.slice(prevEnd, mi);
    prevEnd = mEnd;
    const n = toAmount(m[0]);
    if (!plausible(n)) continue;
    if (signedNegative(ln, mi)) continue;
    if (ARV_LABEL.test(pre)) continue;              // this amount is labelled as the after-repair value
    // Prefer the amount that FOLLOWS the token, and heavily penalise one that precedes it.
    const follows = mi >= tokEnd;
    const dist = follows ? (mi - tokEnd) : (asIdx - mEnd) + 1000;
    if (dist < bestDist) {
      bestDist = dist;
      // A FOLLOWING amount counts as 'labeled' only while it is still in the SAME CLAUSE as the "as
      // is" wording: no sentence break between them, and not the far end of a paragraph. Both halves
      // matter. Too tight and the ordinary phrasing "the 'as is' market value of the subject property
      // is $430,000" (41 characters of filler) is demoted to a weak hit and a perfectly readable
      // appraisal needs a human; too loose and a number in the NEXT sentence gets labelled as the
      // as-is. A sentence boundary is the honest line, because that is where the subject changes.
      const gap = follows ? ln.slice(tokEnd, mi) : '';
      const sameClause = follows && gap.length <= 80 && !/[.;!?]\s/.test(gap);
      // …and it must read as a statement of VALUE. `ln.slice(0, mi)` (not just the gap) so the word
      // counts wherever it sits in the clause — "As-Is Value: $X" puts it BEFORE the token.
      const saysValue = VALUE_WORD.test(ln.slice(0, mi));
      best = { amount: n, strength: sameClause && saysValue ? 'labeled' : 'near', snippet: ln.slice(0, 220) };
    }
  }
  return best;
}

/**
 * Ctrl-F the whole document. Two passes:
 *   A. line by line (what a person pressing Ctrl-F sees);
 *   B. every ADJACENT LINE PAIR joined — an OCR page/column break routinely lands between the label
 *      and the amount ("As-Is Value:" / "$312,500"), which a line-only scan can never see. Only a
 *      'labeled' hit whose amount comes from the SECOND line is taken from pass B (anything else is
 *      already covered by pass A, and a joined pair would otherwise double-count).
 *
 * @returns {{hits:Array<{amount:number,strength:string,snippet:string,line:number}>, labeled:number[], near:number[]}}
 */
function scanAsIs(text) {
  const lines = String(text || '').replace(/ /g, ' ').split(/[\n\r]+/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const h = scanLine(lines[i]);
    if (h) hits.push({ ...h, line: i });
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = String(lines[i] || '').trim(), b = String(lines[i + 1] || '').trim();
    if (!a || !b) continue;
    // Only worth joining when the label is on the first line and the amount is not.
    if (!/as[\s-]*is/i.test(a)) continue;
    if (MONEY_TEST.test(a)) continue;
    // A STACKED LABEL BLOCK is not a wrap. Layout OCR of a two-column value box routinely emits all
    // the labels and then all the amounts:
    //     As Repaired Value / As Is Value / $450,000 / $312,500
    // Joining blindly pairs "As Is Value" with the ARV's $450,000 — the one outcome this whole
    // feature exists to prevent, and the ARV ceiling only catches it when the ARV is known (it is
    // NULL on every straight purchase and on any file whose ARV extraction failed). When the
    // PREVIOUS line is a rival as-is/after-repair label carrying no money, which amount belongs to
    // which label is genuinely unknowable from the text — so we do not guess. A section HEADING
    // ("OPINION OF VALUE") is not a rival label and still allows the wrap.
    const prev = i > 0 ? String(lines[i - 1] || '').trim() : '';
    if (prev && !MONEY_TEST.test(prev) && (ARV_LINE.test(prev) || /as[\s-]*is/i.test(prev))) continue;
    const joined = `${a} ${b}`;
    const h = scanLine(joined);
    if (h && h.strength === 'labeled') hits.push({ ...h, strength: 'labeled', snippet: joined.slice(0, 220), line: i, wrapped: true });
  }
  const uniq = (s) => [...new Set(hits.filter((h) => h.strength === s).map((h) => h.amount))];
  return { hits, labeled: uniq('labeled'), near: uniq('near') };
}

// ---------------------------------------------------------------------------
// The AI locator (step 3)
// ---------------------------------------------------------------------------

const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    value: { type: ['number', 'null'] },
    quote: { type: ['string', 'null'] },
    reason: { type: 'string' },
  },
  required: ['found', 'value', 'quote', 'reason'],
};

const AI_SYSTEM = 'You locate ONE number in an appraisal report: the appraiser\'s opinion of the '
  + 'AS-IS market value of the subject property in its CURRENT condition. Never guess. If the report '
  + 'only states an after-repair / as-completed / subject-to value, answer found=false.';

const AI_INSTRUCTION = `Below is the OCR text of a residential appraisal report.

Find the AS-IS value — the appraiser's opinion of value of the property in its CURRENT, present
condition. It is often written as "as is", "as-is value", "'as is' market value", and on renovation
reports it frequently appears only as a sentence or a note in the addendum/reconciliation rather
than in a labelled box.

Do NOT return the after-repair value (also written as: as repaired, ARV, as completed, subject to
completion, subject to repairs, upon completion, hypothetical condition) — that is a different
number and returning it would be a serious error.

Return the amount as a plain number (no $ or commas) and, in "quote", the EXACT text you read it
from, copied VERBATIM from the text below (one or two lines, including both the wording and the
amount). If you cannot find an as-is value, return found=false with value=null and quote=null.`;

// Normalize for a substring check that survives OCR whitespace/line-break noise.
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// The analyzer truncates its input HEAD-FIRST. On a 40-page appraisal that is exactly backwards:
// the As-Is, when it is not in a labelled box, is a sentence in the RECONCILIATION or the ADDENDUM —
// at the END of the report (the owner's "a lot of times it's just a note on the appraisal report").
// Sending the first N characters would drop the very pages we need.
//
// So send WINDOWS instead of a prefix: ±1,500 characters around every mention of "as is",
// "reconcil", "addend", "opinion of value" or "market value", merged where they overlap, in document
// order, separated by an ellipsis so the model can see the cuts. Better recall AND fewer tokens.
// A document that already fits is passed through untouched.
const AI_ANCHORS = /as[\s-]*is|reconcil|addend|opinion\s+of\s+value|market\s+value/gi;
const AI_WINDOW = 1500;

function aiExcerpt(text, maxChars = 120000) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  const spans = [];
  AI_ANCHORS.lastIndex = 0;
  let m;
  while ((m = AI_ANCHORS.exec(s)) !== null) {
    const from = Math.max(0, m.index - AI_WINDOW);
    const to = Math.min(s.length, m.index + m[0].length + AI_WINDOW);
    const last = spans[spans.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);   // merge overlapping windows
    else spans.push([from, to]);
    if (spans.length > 400) break;                                   // pathological input guard
  }
  AI_ANCHORS.lastIndex = 0;
  // No anchor anywhere: the report almost certainly does not state an As-Is at all. Send the TAIL,
  // not the head — the addendum is where a stray note would be.
  if (!spans.length) return s.slice(-maxChars);
  let out = '', used = 0;
  for (const [a, b] of spans) {
    const piece = s.slice(a, b);
    if (used + piece.length > maxChars) break;
    out += (out ? '\n…\n' : '') + piece;
    used += piece.length;
  }
  return out || s.slice(-maxChars);
}

/**
 * Ask the analyzer to LOCATE the As-Is, then VERIFY its answer against the OCR text.
 * A value survives only when (a) the quote really appears in the OCR text, and (b) our own
 * deterministic scanner reads the SAME amount out of that quote. So the AI can point us at a line we
 * missed, but it can never introduce a number the text does not label as the As-Is.
 * Never throws.
 */
async function aiLocate(text, deps = {}) {
  const analyzer = deps.analyzer;
  if (!analyzer || typeof analyzer.available !== 'function' || !analyzer.available()) {
    return { ok: false, reason: 'the AI reader is not configured' };
  }
  let r;
  try {
    r = await analyzer.extract({
      system: AI_SYSTEM,
      instructions: AI_INSTRUCTION,
      schema: AI_SCHEMA,
      ocrText: aiExcerpt(text),
      ocrCharLimit: 120000,
      maxTokens: 900,
      traceMeta: { opName: 'appraisal-as-is-locate' },
    });
  } catch (e) { return { ok: false, reason: `the AI reader failed (${e && e.message})` }; }
  if (!r || !r.ok || !r.data) return { ok: false, reason: (r && r.reason) || 'the AI reader returned nothing' };
  const d = r.data;
  if (!d.found || d.value == null) return { ok: true, found: false, reason: d.reason || 'the AI reader found no as-is value' };

  const value = Number(d.value);
  if (!plausible(value)) return { ok: true, found: false, reason: 'the AI reader returned an implausible amount' };

  const quote = String(d.quote || '');
  const hay = squash(text), needle = squash(quote);
  // GROUNDING GATE 1 — the quote must genuinely be in the document we read.
  if (!needle || needle.length < 8 || !hay.includes(needle)) {
    return { ok: true, found: false, grounded: false, value, quote, reason: 'the AI reader\'s quote could not be found in the report text' };
  }
  // GROUNDING GATE 2 — our own scanner must read the same As-Is amount out of that quote, AS A
  // LABELLED as-is. A `near` hit is deliberately NOT enough: "The subject sold as is on 05/2019 for
  // $215,000" is a real sentence, genuinely in the document, that the AI will happily hand back —
  // and it is the PRIOR SALE PRICE, not today's value. `near` means "an amount sits beside the words
  // as-is", which is exactly what that sentence is.
  //
  // The re-scan runs over a WINDOW OF THE DOCUMENT around the quote, never the quote alone. The
  // scanner's stacked-label guard looks at the line BEFORE a wrapped label — and that line does not
  // exist inside a two-line quote, so scanning the quote by itself hands the AI a way around the one
  // guard built for exactly this shape ("As Repaired Value / As Is Value / $450,000 / $312,500", the
  // ARV pairing with the As-Is label). Widening the scan to the surrounding text restores it.
  const at = hay.indexOf(needle);
  const ratio = hay.length ? text.length / hay.length : 1;      // squashed → original offsets
  const from = Math.max(0, Math.floor(at * ratio) - 400);
  const to = Math.min(text.length, Math.ceil((at + needle.length) * ratio) + 400);
  const scan = scanAsIs(text.slice(from, to));
  const confirmed = scan.labeled.includes(value);
  if (!confirmed) {
    return { ok: true, found: false, grounded: false, value, quote, reason: 'the AI reader\'s quote does not read as an as-is value' };
  }
  return { ok: true, found: true, grounded: true, value, quote, labeled: scan.labeled.includes(value), reason: d.reason || null };
}

// ---------------------------------------------------------------------------
// Reading the PDF text with the strongest reader available
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:boolean, text?:string, engine?:string, pageCount?:number, reason?:string}>}
 */
async function readPdfText({ pdfBuffer, pdfBase64 }, deps = {}) {
  const router = deps.ocrRouter;
  const legacy = deps.legacyOcr;
  const attempts = [];

  if (router && typeof router.configured === 'function' && router.configured()) {
    try {
      const r = await router.read({ buffer: pdfBuffer || undefined, base64: pdfBuffer ? undefined : pdfBase64, mimeType: 'application/pdf' });
      if (r && r.ok && String(r.text || '').trim()) {
        return { ok: true, text: String(r.text), engine: r.engine || 'ocr-router', pageCount: r.pageCount || null, attempts };
      }
      attempts.push({ engine: (r && r.engine) || 'ocr-router', ok: false, reason: (r && r.reason) || 'the reader returned no text' });
    } catch (e) { attempts.push({ engine: 'ocr-router', ok: false, reason: e && e.message }); }
  } else {
    attempts.push({ engine: 'ocr-router', ok: false, reason: 'not configured' });
  }

  // Last resort: the small-PDF hosted reader that predates the router. Real appraisal PDFs are
  // usually far over its ~1 MB ceiling, so this rarely fires — but on a small report it still works
  // and costs nothing extra.
  if (legacy && typeof legacy.ocrSpaceText === 'function' && pdfBase64) {
    try {
      const r = await legacy.ocrSpaceText(pdfBase64);
      if (r && r.ok && String(r.text || '').trim()) return { ok: true, text: String(r.text), engine: 'ocr-space', pageCount: null, attempts };
      attempts.push({ engine: 'ocr-space', ok: false, reason: (r && r.reason) || 'no text' });
    } catch (e) { attempts.push({ engine: 'ocr-space', ok: false, reason: e && e.message }); }
  }

  const why = attempts.map((a) => `${a.engine}: ${a.reason}`).join('; ');
  return { ok: false, reason: why || 'no document reader is available', attempts };
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * Resolve the As-Is value for one appraisal.
 *
 * @param {object} args
 *   xmlAsIs, xmlAsIsConfidence  what extract() already resolved from the MISMO data file
 *   pdfBuffer | pdfBase64       the appraisal report PDF (optional — no PDF just means no step 2/3)
 *   arv                         the appraisal's ARV, when known (sanity ceiling)
 *   fileArv, rehabBudget        the file's own after-repair value and construction budget — what
 *                               decides whether this is a RENOVATION deal, and therefore whether an
 *                               ARV must exist ABOVE the candidate (see aboveArvOk)
 *   fileAsIs, purchasePrice     the file's own numbers — used for SANITY ONLY (the digit-slip check),
 *                               never to decide what the appraisal says
 * @param {{ocrRouter?, legacyOcr?, analyzer?}} deps  injectable; defaults are the real modules
 * @returns {Promise<{found:boolean, value:number|null, source:string|null, confidence:string|null,
 *                    confident:boolean, quote:string|null, engine:string|null, candidates:number[],
 *                    reason:string|null, steps:Array}>}
 */
async function readAsIs(args = {}, deps = {}) {
  const d = {
    ocrRouter: deps.ocrRouter !== undefined ? deps.ocrRouter : require('../ai/ocr-router'),
    legacyOcr: deps.legacyOcr !== undefined ? deps.legacyOcr : require('./ocr'),
    analyzer: deps.analyzer !== undefined ? deps.analyzer : require('../ai/azure-openai'),
  };
  const out = {
    found: false, value: null, source: null, confidence: null, confident: false,
    quote: null, engine: null, candidates: [], reason: null, steps: [],
    // TRUE only when the READ ITSELF failed and a later attempt could genuinely do better. "The
    // report has no As-Is" is a settled answer, not a retry.
    retryable: false,
  };
  const arv = Number.isFinite(Number(args.arv)) && Number(args.arv) > 0 ? Number(args.arv) : null;

  // ---- THE ARV MUST SIT ABOVE IT (owner-directed 2026-07-28) -----------------
  // *"Never use the ARV value for the as is value … if you can't find another ARV value that is
  //  higher than the value you think the as is value is, then probably your value that you found IS
  //  the ARV."*
  //
  // On a RENOVATION deal there are two values and the after-repair one is always the larger. So a
  // candidate As-Is is only believable when we can point at an ARV strictly above it. If we cannot
  // find one anywhere — not on the appraisal, not on the file — then the number in our hand is very
  // likely the ARV itself wearing the wrong label, and it must never be written. It is still
  // REPORTED, so a human decides.
  //
  // "Renovation deal" is read from the same signals the rest of the appraisal desk uses: the MISMO
  // basis enum extract.js already resolved (`SubjectTo*` means the headline value is after-repair),
  // an ARV on the appraisal, an ARV on the file, or a construction budget. A STRAIGHT as-is purchase
  // has no ARV by definition, and the rule correctly does not apply to it.
  const bestArv = arv != null ? arv
    : (Number(args.fileArv) > 0 ? Number(args.fileArv) : null);
  // The file's OWN ARV may SATISFY the rule but must never CREATE it. Letting it trigger the test is
  // circular — the same number both raises the requirement and is the only thing that can meet it —
  // so a file carrying a stale, low, or as-is-equal ARV on a deal with no renovation at all would
  // block a perfectly good read forever. Only real renovation evidence starts the test: the MISMO
  // basis enum, an ARV on the APPRAISAL, or a construction budget.
  const isReno = /^SubjectTo/i.test(String(args.xmlBasis || '').trim())
    || arv != null
    || Number(args.rehabBudget) > 0;
  const aboveArvOk = (n) => !isReno || (bestArv != null && bestArv > n);
  const NO_ARV_ABOVE = 'no after-repair value above it could be found on this renovation file, so this may be the ARV itself rather than the as-is value';

  // ---- 1. the XML data file ------------------------------------------------
  const xmlVal = Number(args.xmlAsIs);
  if (args.xmlAsIs != null && Number.isFinite(xmlVal) && args.xmlAsIsConfidence === 'definite' && plausible(xmlVal)) {
    // ONE case has to be held back, and it is the most dangerous number in the whole feature: the
    // appraisal's HEADLINE value adopted as the As-Is by INFERENCE. A MISMO appraisal has a single
    // "opinion of value" box; what it MEANS is set by `_CONDITION_OF_APPRAISAL/@_Type` (AsIs vs
    // SubjectToRepairs/Completion/Inspection). When that enum is missing or unrecognised, extract.js
    // falls back to inferring the basis from narrative language — and on a renovation appraisal whose
    // wording it does not recognise, the AFTER-REPAIR value is what would land here marked `definite`.
    // Writing an ARV into the As-Is would overstate the collateral by the whole rehab, and now that a
    // confident reading is written in EITHER direction, nothing downstream would catch it.
    // So: the headline number (`as_is_value === appraised_value`) is trusted only on an EXPLICIT
    // basis enum. A value MINED FROM THE NARRATIVE is untouched by this — a sentence that literally
    // says "the as is value is $430,000" needs no enum to be believed.
    const structural = args.appraisedValue != null && Number.isFinite(Number(args.appraisedValue))
      && Math.abs(xmlVal - Number(args.appraisedValue)) < 0.005;
    const explicitBasis = EXPLICIT_BASIS.test(String(args.xmlBasis || '').trim());
    if (structural && !explicitBasis) {
      out.steps.push({ step: 'xml', ok: false, value: xmlVal, reason: 'the appraisal does not state whether its headline value is as-is or after-repair' });
      return {
        ...out, found: true, value: xmlVal, source: 'xml', confidence: 'low', confident: false, candidates: [xmlVal],
        reason: 'the appraisal data file does not say whether its value is "as is" or "after repair", so PILOT will not use it on its own',
      };
    }
    // …and the same number must have an ARV ABOVE it on a renovation file, or it is probably the ARV.
    if (!aboveArvOk(xmlVal)) {
      out.steps.push({ step: 'xml', ok: false, value: xmlVal, reason: 'no ARV above it' });
      return {
        ...out, found: true, value: xmlVal, source: 'xml', confidence: 'low', confident: false,
        candidates: [xmlVal], reason: NO_ARV_ABOVE,
      };
    }
    out.steps.push({ step: 'xml', ok: true, value: xmlVal });
    return { ...out, found: true, value: xmlVal, source: 'xml', confidence: 'definite', confident: true, candidates: [xmlVal] };
  }
  out.steps.push({ step: 'xml', ok: false, reason: 'the appraisal data file does not state a definite as-is value' });

  // ---- 2. the PDF, read by the strongest OCR we have ------------------------
  if (!args.pdfBuffer && !args.pdfBase64) {
    out.reason = 'the appraisal data file does not state an as-is value and no appraisal PDF was available to read';
    out.steps.push({ step: 'pdf', ok: false, reason: 'no PDF' });
    return out;
  }
  const read = await readPdfText(args, d);
  if (!read.ok) {
    // RETRYABLE: the reader was unreachable / errored. The caller must NOT stamp this file as read,
    // or an OCR outage would drain it out of the "previous AND future" sweep permanently — the same
    // discipline the comp-split backfill documents ("a TRANSIENT storage hiccup self-heals").
    out.reason = `the appraisal PDF could not be read (${read.reason})`;
    out.retryable = true;
    out.steps.push({ step: 'pdf', ok: false, reason: read.reason });
    return out;
  }
  out.engine = read.engine;
  out.steps.push({ step: 'pdf', ok: true, engine: read.engine, pageCount: read.pageCount || null, chars: read.text.length });

  // ABSTAIN when the read itself failed. "The reader came back with 40 characters of noise" and "the
  // report genuinely does not state an As-Is" are completely different messages to an officer: one
  // means re-scan the PDF, the other means type the value in. Same discipline as
  // src/lib/underwriting/grounding.js ("a near-empty read is illegible, not proof of absence"), and
  // calibrated the same way as ocr-router's own `primaryLooksEmpty` — a MEANINGFULLY LARGE document
  // that produced almost no text clearly failed OCR, while a genuinely tiny one may just be short.
  const chars = read.text.replace(/\s+/g, '').length;
  const bytes = args.pdfBuffer ? args.pdfBuffer.length
    : (args.pdfBase64 ? Math.floor((String(args.pdfBase64).length * 3) / 4) : null);
  // 24 is grounding.js's own "too little text to judge" floor — reused so the two readers agree
  // on what counts as illegible. The byte-relative rule below it is what does the real work in
  // production, where any genuine appraisal read is thousands of characters.
  if (chars < 24 || (bytes != null && bytes >= 250 * 1024 && chars < 500)) {
    out.reason = 'the appraisal PDF did not read properly (almost no text came back) — it may be a poor scan, so it needs re-scanning or reading by hand';
    out.retryable = true;   // a different engine, or the same one on a better day, may do better
    out.steps.push({ step: 'ctrl_f', ok: false, reason: 'illegible', chars, bytes });
    return out;
  }

  const scan = scanAsIs(read.text);
  // Sanity-filter EVERY candidate before it can influence the verdict.
  //  • The ARV CEILING — an "As-Is" at or above the after-repair value is the ARV misread. On a
  //    CONDO (Form 1073) there is normally no ARV at all, which would silently disarm the single
  //    most effective guard here, so fall back to the appraisal's own headline value.
  //  • The APPROACH DECOYS — a subject-to appraisal also prints a cost-approach value, an
  //    income-approach value and a site (land) value. Every one is a plausible dollar amount on a
  //    page that says "as is", and the income approach can even sit BELOW the ARV, so the ceiling
  //    misses it. A candidate that IS one of those figures is the wrong number, not the As-Is.
  //    Only applied on an after-repair basis: on a straight as-is report the As-Is legitimately
  //    EQUALS the sales-comparison and appraised value, and vetoing there would break every
  //    as-is-basis and condo file.
  const ceiling = arv != null ? arv
    : (Number(args.appraisedValue) > 0 ? Number(args.appraisedValue) : null);
  const arvBasis = arv != null || /^SubjectTo/i.test(String(args.xmlBasis || '').trim());
  const decoys = arvBasis
    ? [args.valueCostApproach, args.valueIncomeApproach, args.siteValue, args.valueSalesApproach, args.appraisedValue]
      .map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const isDecoy = (n) => decoys.some((d) => Math.abs(n - d) <= d * 0.005);
  //  • A FLOOR relative to what the file already knows. A cost-approach line item, a fee, an
  //    allowance — any of these can be a plausible five-figure amount on an "as is" line. No
  //    residential property's as-is value is under 15% of its after-repair value, its purchase price
  //    or the value already on the file. 15% is deliberately loose: a gut rehab legitimately values
  //    at 25–40% of ARV, and this must never veto a real one. With no reference at all there is
  //    nothing to measure against, so the floor simply does not apply.
  const refs = [ceiling, args.purchasePrice, args.fileAsIs].map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const floor = refs.length ? Math.max(...refs) * 0.15 : 0;
  const ok = (n) => plausible(n) && n >= floor && (ceiling == null || n < ceiling) && !isDecoy(n);
  const labeled = scan.labeled.filter(ok);
  const near = scan.near.filter(ok);
  out.candidates = [...new Set([...labeled, ...near])].sort((a, b) => a - b);
  out.steps.push({ step: 'ctrl_f', ok: true, labeled, near, dropped: [...scan.labeled, ...scan.near].filter((n) => !ok(n)) });

  // A candidate that is 10× or 100× off a number we already trust is a misread, not a valuation.
  // It stays a CANDIDATE (a human may confirm it is real) but can never be written automatically.
  const slipRefs = [arv, args.fileAsIs, args.purchasePrice];
  const slipped = (n) => scaleSlip(n, slipRefs);
  const demote = (v, base) => {
    if (slipped(v)) {
      return { ...base, confidence: 'low', confident: false,
        reason: 'the amount looks like a misread of a number already on the file (out by a factor of ten), so it needs a human' };
    }
    // The owner's rule, applied to the PDF path too: on a renovation file an As-Is must have an ARV
    // above it. Without one, the amount we are holding is probably the after-repair value.
    if (!aboveArvOk(v)) return { ...base, confidence: 'low', confident: false, reason: NO_ARV_ABOVE };
    return base;
  };

  const snippetFor = (amount) => {
    const h = scan.hits.find((x) => x.amount === amount);
    return h ? h.snippet : null;
  };

  // ---- 3. the AI locator, over the SAME text -------------------------------
  // Worth asking whenever the deterministic pass did not land a single unambiguous labelled hit —
  // that is exactly the "it's only a note in the addendum" / "the label and the amount got split
  // across a page break" case the owner described. It is also cheap insurance when the scan is
  // clean, so we skip it there to keep the spend down.
  let ai = null;
  const deterministicClean = labeled.length === 1 && near.every((n) => n === labeled[0]);
  if (!deterministicClean && args.useAi !== false) {
    ai = await aiLocate(read.text, d);
    out.steps.push({ step: 'ai', ok: !!(ai && ai.ok), found: !!(ai && ai.found), value: (ai && ai.value) || null, reason: (ai && ai.reason) || null });
    if (ai && ai.found && !ok(ai.value)) {
      out.steps.push({ step: 'ai_sanity', ok: false, reason: 'the AI reader\'s amount is above the after-repair value, is one of the appraisal\'s other figures, or is out of range' });
      ai = { ...ai, found: false, reason: 'the amount is above the after-repair value, is one of the appraisal\'s other figures, or is out of range' };
    }
  }

  // ---- verdict -------------------------------------------------------------
  if (deterministicClean) {
    return demote(labeled[0], { ...out, found: true, value: labeled[0], source: 'pdf_text', confidence: 'high', confident: true, quote: snippetFor(labeled[0]) });
  }
  if (ai && ai.found) {
    // Corroboration means a LABELLED deterministic hit. A `near`-only agreement is two weak signals
    // pointing at the same weak thing (see gate 2 above) — it stays a candidate for a human.
    const corroborated = labeled.includes(ai.value);
    // The AI's own quote re-read as a LABELLED as-is by our scanner is itself corroboration — that is
    // the page-break case, where the whole-document line scan could never have seen it.
    const selfLabeled = !!ai.labeled;
    if (corroborated || selfLabeled) {
      return demote(ai.value, {
        ...out, found: true, value: ai.value, source: corroborated ? 'pdf_text' : 'pdf_ai',
        confidence: 'high', confident: true, quote: ai.quote || snippetFor(ai.value),
      });
    }
    return {
      ...out, found: true, value: ai.value, source: 'pdf_ai', confidence: 'low', confident: false,
      quote: ai.quote, candidates: [...new Set([...out.candidates, ai.value])].sort((a, b) => a - b),
      reason: 'the AI reader suggested an as-is value but nothing else in the report confirmed it',
    };
  }
  if (labeled.length === 1) {
    // One labelled hit, with a DIFFERENT loose amount also sitting near "as is" wording somewhere in
    // the report. Report it — but a human decides, because two numbers are in play.
    return {
      ...out, found: true, value: labeled[0], source: 'pdf_text', confidence: 'low', confident: false,
      quote: snippetFor(labeled[0]),
      reason: 'more than one amount appears near "as is" wording in the report, so the reading is not certain',
    };
  }
  if (labeled.length > 1) {
    return {
      ...out, found: true, value: labeled[0], source: 'pdf_text', confidence: 'low', confident: false,
      quote: snippetFor(labeled[0]),
      reason: 'the report states more than one "as is" amount, so the reading is not certain',
    };
  }
  if (near.length === 1) {
    return {
      ...out, found: true, value: near[0], source: 'pdf_text', confidence: 'low', confident: false,
      quote: snippetFor(near[0]),
      reason: 'an amount appears beside "as is" wording but the report does not label it as the as-is value',
    };
  }
  if (near.length > 1) {
    return {
      ...out, found: true, value: near[0], source: 'pdf_text', confidence: 'low', confident: false,
      quote: snippetFor(near[0]),
      reason: 'several amounts appear beside "as is" wording, so the reading is not certain',
    };
  }
  out.reason = 'no as-is value could be read from the appraisal report';
  return out;
}

// ---------------------------------------------------------------------------
// The owner's rule — may this reading be written onto the loan file?
// ---------------------------------------------------------------------------

/**
 * PURE. Decides whether a reading may be applied to `applications.as_is_value`.
 *
 * THE RULE IS CONFIDENCE, AND ONLY CONFIDENCE (owner-directed 2026-07-28, correcting the first cut):
 * *"As long as you're confident you can write it no matter what it was — I just made a mistake when
 * I said that only if it's a reduction. As long as you're confident you should write it as this
 * value, and if you're not confident you should always ask in the condition for the loan officer to
 * look on the appraisal and enter it."*
 *
 * So a confident reading is written whether it LOWERS or RAISES the file's As-Is, and whether or not
 * it lands below the purchase price. That is the right rule: the appraisal is the authority on what
 * the property is worth today, and this is exactly the "replace" action a human was already doing by
 * hand on the `asis_mismatch` finding. Below-the-purchase-price is still REPORTED (`belowPrice`) —
 * it is what the condition's wording and the existing `asis_below_price` finding turn on — but it is
 * no longer a gate on the write.
 *
 * What still stops a write is only ever about whether the number can be TRUSTED, or whether anyone
 * is allowed to write at all — never about which direction it moves:
 *   • CONFIDENCE — a `definite` data-file value, or a PDF read our own scanner and the AI agree on.
 *     Anything less is reported to a human and never written. `readAsIs` additionally refuses a value
 *     at or above the ARV, and one that looks like a ten-fold digit slip of a number already on file.
 *   • THE FILE MUST NOT BE FROZEN — a term-sheet-sent / clear-to-close / funded file has its
 *     economics locked for everyone (src/lib/file-lock.js). PILOT does not get a private door
 *     through that; on a frozen file the reading is recorded and the condition explains it so a
 *     human decides.
 *   • IT MUST BE A REAL CHANGE — rewriting the value the file already shows would churn the reprice
 *     trigger for nothing.
 *
 * Because ANY change to `as_is_value` reopens Products & Pricing (db/071/072), a RAISE can never
 * quietly increase a loan: it forces a human to re-register the product on the new number.
 *
 * @returns {{apply:boolean, value:number|null, kind:'reduced'|'raised'|'filled'|'none',
 *            why:string, belowPrice:boolean|null}}
 */
function decideAsIsApply({ read, fileAsIs, purchasePrice, lockReason = null, autoEnabled = true } = {}) {
  const pp = Number(purchasePrice);
  const priced = Number.isFinite(pp) && pp > 0;
  const none = (why, belowPrice = null) => ({ apply: false, value: null, kind: 'none', why, belowPrice });
  if (!read || !read.found || read.value == null) return none('no_value');
  if (!autoEnabled) return none('auto_off');
  if (!read.confident) return none('not_confident');

  const v = Number(read.value);
  if (!plausible(v)) return none('implausible');
  const belowPrice = priced ? v < pp : null;

  const cur = fileAsIs == null || fileAsIs === '' ? null : Number(fileAsIs);
  const has = cur != null && Number.isFinite(cur);
  // Already agrees — nothing to write. Compared with a cent tolerance because the column is
  // numeric(14,2) while the reading is a plain JS number.
  if (has && Math.abs(cur - v) < 0.005) return none('same_value', belowPrice);

  if (lockReason) return none('file_locked', belowPrice);

  return { apply: true, value: v, kind: !has ? 'filled' : (v < cur ? 'reduced' : 'raised'), why: 'ok', belowPrice };
}

/**
 * PURE. The ARV's own write rule (owner-directed 2026-07-28): *"once the appraisal is being imported
 * we also want you to add that the ARV value should be rewritten in our file according to the
 * appraisal — we already have logic and XML of the appraisal finding that reads the ARV value that
 * I'm much more highly confident about, and we don't even need OCR for it."*
 *
 * The ARV is the EASY one, and that is exactly why it is treated differently from the As-Is: a MISMO
 * appraisal has one structured `PropertyAppraisedValueAmount`, and on a subject-to (renovation)
 * report that figure IS the after-repair value. `extract.js` already resolves it and marks it
 * `definite` — it was recovered from all 33 files in the research corpus. So there is no ladder, no
 * OCR and no AI here: a `definite` XML ARV is written, anything else is left alone.
 *
 * The same three things stop it as stop the As-Is, and none of them is about direction: the file must
 * not be frozen, a human must not have already settled the number, and it must be a real change.
 * A write reopens Products & Pricing, so the loan is re-sized by a person, never by this.
 *
 * @returns {{apply:boolean, value:number|null, kind:'raised'|'lowered'|'filled'|'none', why:string}}
 */
function decideArvApply({ arv, arvConfidence, arvBasis, appraisedValue, fileArv, asIs, lockReason = null, autoEnabled = true } = {}) {
  const none = (why) => ({ apply: false, value: null, kind: 'none', why });
  const v = Number(arv);
  if (arv == null || !Number.isFinite(v)) return none('no_value');
  if (arvConfidence !== 'definite') return none('not_confident');
  // `arvConfidence === 'definite'` is NOT the same as "this is the appraisal's headline value".
  // extract.js marks a `definite` ARV in TWO places: the structured `PropertyAppraisedValueAmount`
  // on a subject-to report (what the owner meant by *"we don't even need OCR for it"*), and — on an
  // AS-IS-basis report — a number MINED OUT OF PROSE with no ceiling and no cross-check. That second
  // branch will happily hand back a borrower's quoted estimate ("the borrower reports an as
  // completed value of $700,000"), a neighbouring project's figure, or a comp's as-repaired price,
  // and writing one of those would RAISE the file's ARV — the cap the loan is sized against.
  // So the write is restricted to the case the owner actually described: the appraisal's own
  // headline number, on a report whose MISMO basis enum says that number is the after-repair value.
  // A prose ARV is still parsed, still shown, and still raises the `arv_mismatch` finding for a
  // human — it just never writes itself onto the loan.
  const structural = appraisedValue != null && Number.isFinite(Number(appraisedValue))
    && Math.abs(v - Number(appraisedValue)) < 0.005;
  if (!/^SubjectTo/i.test(String(arvBasis || '').trim()) || !structural) return none('not_the_headline_value');
  if (!autoEnabled) return none('auto_off');
  if (!plausible(v)) return none('implausible');
  // An ARV at or below the As-Is is the two values swapped, or one of them misread. Never written.
  const a = Number(asIs);
  if (Number.isFinite(a) && a > 0 && v <= a) return none('not_above_as_is');

  const cur = fileArv == null || fileArv === '' ? null : Number(fileArv);
  const has = cur != null && Number.isFinite(cur);
  if (has && Math.abs(cur - v) < 0.005) return none('same_value');
  if (lockReason) return none('file_locked');

  return { apply: true, value: v, kind: !has ? 'filled' : (v > cur ? 'raised' : 'lowered'), why: 'ok' };
}

// ---------------------------------------------------------------------------
// The wording an officer reads on the condition
// ---------------------------------------------------------------------------

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : '$' + Number(n).toLocaleString('en-US'));

const SOURCE_WORDS = {
  xml: 'the appraisal data file (XML)',
  pdf_text: 'the appraisal report PDF (read with OCR)',
  pdf_ai: 'the appraisal report PDF (read with OCR, located by AI)',
};

/**
 * PURE. The `[auto]` note that goes on the "Verify As-Is value" condition. Plain language — this is
 * read by staff, not developers — and it always says (a) what PILOT did, (b) what the numbers are,
 * and (c) that a human can re-review and overwrite it.
 */
function buildAsIsNote({ read, decision, fileAsIsBefore, purchasePrice, arvDecision, fileArvBefore } = {}) {
  // `[auto]` marks the note as system-written so a re-read never clobbers a note an officer typed
  // (every write guards on `notes IS NULL OR notes LIKE '[auto]%'`).
  const P = '[auto] ';
  const r = read || {}, dec = decision || {};
  const where = SOURCE_WORDS[r.source] || 'the appraisal';
  const quote = r.quote ? ` It was read from: “${String(r.quote).replace(/\s+/g, ' ').trim().slice(0, 220)}”.` : '';

  // The ARV rides on the SAME condition — it is the same question ("do the appraisal's values match
  // the file?") and one condition beats two. Appended to whatever the As-Is half says.
  const ARV_WHY = {
    not_the_headline_value: 'it is not the appraisal\'s own headline figure (it was read out of the report\'s wording), so PILOT will not use it on its own',
    not_above_as_is: 'it is not above the As-Is value, so the two figures would be the wrong way round',
    not_confident: 'the appraisal data file does not state it definitely',
    same_value: 'the file already shows it',
    file_locked: 'this file\'s figures are locked',
    human_decided: 'someone has already decided it by hand',
    appraisal_identity_mismatch: 'this appraisal does not match the property on the file',
    auto_off: 'the automatic update is switched off',
    value_changed_underneath: 'it changed on the file while PILOT was reading',
    as_is_changed_underneath: 'the As-Is changed on the file while PILOT was reading, so the two could not be compared safely',
    write_failed: 'the update did not go through',
    implausible: 'the amount does not look like a property value',
  };
  const arvLine = (() => {
    const a = arvDecision || {};
    // A REFUSED ARV has to be said out loud too — the panel shows it, and a printed or emailed
    // condition would otherwise hide that the appraisal and the file disagree on the ARV.
    if (!a.apply) {
      if (!a.why || a.why === 'no_value' || a.why === 'same_value') return '';
      const w = ARV_WHY[a.why];
      return w ? ` PILOT did not change the ARV (after-repair value): ${w}.` : '';
    }
    const verb = a.kind === 'raised' ? 'raised' : (a.kind === 'lowered' ? 'lowered' : 'set');
    return ` PILOT also ${verb} the ARV (after-repair value) on this file`
      + (fileArvBefore != null ? ` from ${money(fileArvBefore)}` : '')
      + ` to ${money(a.value)}, straight from the appraisal data file — that figure is the appraisal's own headline value, so no OCR was involved.`;
  })();

  if (dec.apply) {
    const lead = {
      reduced: `PILOT LOWERED the As-Is value on this file from ${money(fileAsIsBefore)} to ${money(dec.value)}.`,
      raised: `PILOT RAISED the As-Is value on this file from ${money(fileAsIsBefore)} to ${money(dec.value)}.`,
      filled: `PILOT set the As-Is value on this file to ${money(dec.value)}.`,
    }[dec.kind] || `PILOT set the As-Is value on this file to ${money(dec.value)}.`;
    // Below the purchase price is the one that needs saying out loud — the borrower would be paying
    // over the as-is collateral value, and there is a fatal finding on the desk about it.
    const price = dec.belowPrice === true
      ? ` That is BELOW the purchase price of ${money(purchasePrice)} — the borrower would be paying more than the property is worth as it stands today, so check the appraisal finding about it.`
      : (purchasePrice != null ? ` The purchase price on the file is ${money(purchasePrice)}.` : '');
    return `${P}${lead} It read that value from ${where}.${quote}${price}`
      + ' The loan has to be re-priced on the new value, so the Products & Pricing condition has reopened — nothing about the loan amount changes until someone re-registers the product.'
      + arvLine
      + ' Please re-review this against the appraisal report: if PILOT read it wrong, type the correct As-Is value in the box on this condition and it will replace what PILOT entered.'
      + ' Sign this condition off once you have confirmed the As-Is value is right.';
  }

  if (r.found && r.value != null) {
    const why = {
      same_value: 'that is exactly what the file already shows, so nothing needed changing',
      file_locked: 'this file\'s figures are locked (the term sheet has gone out, or the file is clear-to-close / funded), so nothing was changed automatically',
      appraisal_identity_mismatch: 'this appraisal does not match the property on the file (address, unit count or property type), so nothing was taken from it — sort that out first',
      human_decided: 'someone has already decided this file\'s As-Is value by hand, so PILOT left it alone — a person\'s decision about this number is final',
      not_confident: 'PILOT is NOT confident enough in that reading to use it, so nothing on the file was changed',
      auto_off: 'the automatic As-Is update is switched off, so nothing on the file was changed',
      implausible: 'the amount does not look like a property value, so nothing was changed',
      value_changed_underneath: 'the As-Is value on the file changed while PILOT was reading, so it did not overwrite it',
      no_value: 'nothing on the file was changed',
    }[dec.why] || 'nothing on the file was changed';
    const extra = r.reason ? ` (${r.reason})` : '';
    return `${P}PILOT read a possible As-Is value of ${money(r.value)} from ${where}${extra}, but ${why}.${quote}`
      + arvLine
      + ' Please confirm the As-Is value against the appraisal report and, if it needs changing, type it in the box on this condition.';
  }

  return `${P}PILOT could not confidently read the As-Is value — it checked the appraisal data file and then read the appraisal report PDF with OCR${r.engine ? ` (${r.engine})` : ''} and AI.`
    + `${r.reason ? ` ${r.reason.charAt(0).toUpperCase()}${r.reason.slice(1)}.` : ''}`
    + ' Nothing has been filled in automatically — a value is never guessed.'
    + arvLine
    + ' Please open the appraisal report, read the As-Is value, and type it in the box on this condition to clear this condition.';
}

/** PURE. The per-instance hint (the one-line "what is this condition about") for each state. */
function buildAsIsHint(decision) {
  const d = decision || {};
  if (d.apply) {
    const verb = d.kind === 'reduced' ? 'lowered' : (d.kind === 'raised' ? 'raised' : 'set');
    return `PILOT ${verb} this file's As-Is value from what it read on the appraisal. Re-review it against the report — you can overwrite it here — then sign off.`;
  }
  if (d.why === 'file_locked') {
    return 'PILOT read an As-Is value off the appraisal but this file\'s figures are locked, so it changed nothing. Check the reading and decide.';
  }
  if (d.why === 'appraisal_identity_mismatch') {
    return 'This appraisal does not match the property on the file, so PILOT took nothing from it. Sort out the mismatch, then confirm the As-Is value here.';
  }
  if (d.why === 'human_decided') {
    return 'The As-Is value on this file was decided by hand, so PILOT left it alone. Check what it read against the report, then sign off.';
  }
  return 'PILOT could not confidently read the As-Is value from the appraisal. Read it off the report and enter it here to clear this condition.';
}

module.exports = {
  readAsIs, decideAsIsApply, decideArvApply, buildAsIsNote, buildAsIsHint,
  scanAsIs, scanLine, aiLocate, readPdfText,
  MIN_VALUE, MAX_VALUE,
};
